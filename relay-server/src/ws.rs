//! Per-connection WebSocket handling: auth, message dispatch, and cleanup.

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{info, warn};

use std::collections::HashSet;
use std::net::SocketAddr;

use crate::protocol::Message;
use crate::state::{Peer, Share, SharedState, broadcast};

/// The IP to log for this connection: `X-Forwarded-For`/`X-Real-IP` if
/// present (the relay is commonly run behind an NGINX/Apache reverse proxy
/// — see SERVER.md — in which case `peer_addr` is just the proxy's own
/// address, not the actual client's), otherwise the raw TCP peer address.
/// Trusted at face value either way: this is only ever used for logging,
/// never for access control, so a spoofed header just logs a wrong IP,
/// nothing more.
fn client_ip(headers: &HeaderMap, peer_addr: SocketAddr) -> String {
    let forwarded_for = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let real_ip = headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match forwarded_for.or(real_ip) {
        Some(ip) => ip.to_string(),
        None => peer_addr.ip().to_string(),
    }
}

/// Pulls the API key out of the `Sec-WebSocket-Protocol` handshake header.
///
/// A browser/webview `WebSocket` can't set arbitrary headers (no
/// `Authorization`) — `Sec-WebSocket-Protocol` is the one header value
/// client-side JS *can* set (as the constructor's second argument), so it's
/// used to carry the API key during the handshake instead. The client
/// base64url-encodes it first so any character in the key is a valid token
/// (the header's grammar forbids raw spaces/`/`/`=`/etc.); the server never
/// needs to decode it back — the encoded string is just as good a (stable,
/// deterministic) tenant-partitioning key as the original.
fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)?.to_str().ok()?;
    let key = value.split(',').next()?.trim();
    if key.is_empty() { None } else { Some(key.to_string()) }
}

pub async fn ws_handler(
    mut ws: WebSocketUpgrade,
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    State(state): State<SharedState>,
) -> Response {
    match extract_api_key(&headers) {
        Some(api_key) => {
            // Some WebSocket client implementations (Node's undici among
            // them, and this is the safer assumption for webviews too) fail
            // the connection if the client offered a subprotocol and the
            // server's 101 response doesn't echo one back — even though the
            // spec treats that as optional. Echoing the same value we just
            // read is always valid, since it's already a well-formed header.
            if let Ok(value) = HeaderValue::from_str(&api_key) {
                ws.set_selected_protocol(value);
            }
            let ip = client_ip(&headers, peer_addr);
            ws.on_upgrade(move |socket| handle_socket(socket, state, api_key, ip))
        }
        None => {
            (StatusCode::UNAUTHORIZED, "missing or empty Sec-WebSocket-Protocol header").into_response()
        }
    }
}

async fn handle_socket(socket: WebSocket, state: SharedState, api_key: String, ip: String) {
    let client_id = uuid::Uuid::new_v4().to_string();
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Writer task: serializes every queued Message and forwards it to the
    // socket, so handlers below never touch the sink directly.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&msg) else { continue };
            if ws_sink.send(WsMessage::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    {
        let mut tenants = state.lock().await;
        let tenant = tenants.entry(api_key.clone()).or_default();
        tenant.peers.insert(client_id.clone(), Peer { sender: tx.clone() });
        let shares = tenant.shares.iter().map(|(id, s)| s.info(id)).collect();
        let _ = tx.send(Message::Welcome { client_id: client_id.clone() });
        let _ = tx.send(Message::Shares { shares });
    }
    info!(client_id, ip, "instance connected");

    while let Some(frame) = ws_stream.next().await {
        let frame = match frame {
            Ok(f) => f,
            Err(_) => break,
        };
        let text = match frame {
            WsMessage::Text(t) => t,
            WsMessage::Close(_) => break,
            _ => continue, // binary/ping/pong: this protocol is text-only
        };
        let msg: Message = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                warn!(client_id, error = %e, "dropping unparseable message");
                continue;
            }
        };
        handle_message(&state, &api_key, &client_id, msg).await;
    }

    // Cleanup: drop this connection and anything it owned or participated
    // in. A share with no owner left to answer snapshot requests for it is
    // useless, so it's removed rather than kept dangling; a share this
    // client merely held open just loses them as a participant (see
    // JoinAck/Leave — `ShareInfo.connected` needs updating either way).
    {
        let mut tenants = state.lock().await;
        if let Some(tenant) = tenants.get_mut(&api_key) {
            tenant.peers.remove(&client_id);
            let owned: Vec<String> = tenant
                .shares
                .iter()
                .filter(|(_, s)| s.owner_client_id == client_id)
                .map(|(id, _)| id.clone())
                .collect();
            for share_id in owned {
                tenant.shares.remove(&share_id);
                broadcast(tenant, &Message::ShareRemoved { share_id }, None);
            }
            let participated: Vec<String> = tenant
                .shares
                .iter()
                .filter(|(_, s)| s.participants.contains(&client_id))
                .map(|(id, _)| id.clone())
                .collect();
            for share_id in participated {
                if let Some(share) = tenant.shares.get_mut(&share_id) {
                    share.participants.remove(&client_id);
                    let info = share.info(&share_id);
                    broadcast(tenant, &Message::ShareUpdated { share: info }, None);
                }
            }
            if tenant.peers.is_empty() {
                tenants.remove(&api_key);
            }
        }
    }
    writer.abort();
    info!(client_id, ip, "instance disconnected");
}

async fn handle_message(state: &SharedState, api_key: &str, client_id: &str, msg: Message) {
    let mut tenants = state.lock().await;
    let Some(tenant) = tenants.get_mut(api_key) else { return };

    match msg {
        Message::List => {
            if let Some(peer) = tenant.peers.get(client_id) {
                let shares = tenant.shares.iter().map(|(id, s)| s.info(id)).collect();
                let _ = peer.sender.send(Message::Shares { shares });
            }
        }

        Message::ShareCreate { share_id, filename, read_only } => {
            let share = Share {
                filename,
                read_only,
                owner_client_id: client_id.to_string(),
                // The owner counts as connected from the moment they share
                // it — they already hold the content, no JoinAck needed.
                participants: HashSet::from([client_id.to_string()]),
            };
            let info = share.info(&share_id);
            tenant.shares.insert(share_id.clone(), share);
            if let Some(peer) = tenant.peers.get(client_id) {
                let _ = peer.sender.send(Message::ShareCreated { share_id });
            }
            // Broadcast to the creator too (no exclusion): it's the only
            // way their own share ends up in their own `shares` list, which
            // Settings → Share and the status bar's connected count both
            // read from — ShareCreated above is just an ack, it doesn't
            // populate that list on the client.
            broadcast(tenant, &Message::ShareAdded { share: info }, None);
        }

        Message::Unshare { share_id } => {
            if tenant.shares.get(&share_id).is_some_and(|s| s.owner_client_id == client_id) {
                tenant.shares.remove(&share_id);
                broadcast(tenant, &Message::ShareRemoved { share_id }, Some(client_id));
            }
        }

        Message::Join { share_id } => {
            broadcast(
                tenant,
                &Message::SnapshotRequest { share_id, for_client_id: client_id.to_string() },
                Some(client_id),
            );
        }

        Message::Snapshot { share_id, to_client_id, seq, ciphertext, iv, salt, word_wrap, language } => {
            if let Some(peer) = tenant.peers.get(&to_client_id) {
                let _ = peer
                    .sender
                    .send(Message::Joined { share_id, seq, ciphertext, iv, salt, word_wrap, language });
            }
        }

        Message::JoinAck { share_id } => {
            if let Some(share) = tenant.shares.get_mut(&share_id) {
                share.participants.insert(client_id.to_string());
                let info = share.info(&share_id);
                broadcast(tenant, &Message::ShareUpdated { share: info }, None);
            }
        }

        // Pure relays: the server never needs to understand these, only
        // forward them to the rest of the tenant. Clients filter by
        // `share_id` themselves.
        Message::Edit { .. }
        | Message::ResyncRequest { .. }
        | Message::Resync { .. }
        | Message::Properties { .. } => {
            broadcast(tenant, &msg, Some(client_id));
        }

        Message::Leave { share_id } => {
            if let Some(share) = tenant.shares.get_mut(&share_id) {
                share.participants.remove(client_id);
                let info = share.info(&share_id);
                broadcast(tenant, &Message::ShareUpdated { share: info }, None);
            }
        }

        // Server-originated variants a client should never send; ignore them.
        Message::Welcome { .. }
        | Message::Error { .. }
        | Message::Shares { .. }
        | Message::ShareCreated { .. }
        | Message::ShareAdded { .. }
        | Message::ShareUpdated { .. }
        | Message::ShareRemoved { .. }
        | Message::SnapshotRequest { .. }
        | Message::Joined { .. } => {}
    }
}
