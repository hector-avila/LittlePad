//! In-memory relay state. Nothing here ever touches disk, and nothing
//! survives the process — that's the whole point: the server is a pure
//! relay, not a store.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::{Mutex, mpsc};

use crate::protocol::{Message, ShareInfo};

/// One connected instance: an id the server assigns for the lifetime of the
/// connection, and a channel to push messages to its writer task.
pub struct Peer {
    pub sender: mpsc::UnboundedSender<Message>,
}

/// One share as tracked by the server: metadata, who created it (so it can
/// be dropped when that connection goes away), and who currently holds it
/// open (so `ShareInfo.connected` can be reported accurately — see
/// `JoinAck` in protocol.rs for why membership is tracked explicitly
/// instead of inferred from `Join`).
pub struct Share {
    pub filename: String,
    pub read_only: bool,
    pub owner_client_id: String,
    pub participants: HashSet<String>,
}

impl Share {
    pub fn info(&self, share_id: &str) -> ShareInfo {
        ShareInfo {
            share_id: share_id.to_string(),
            filename: self.filename.clone(),
            read_only: self.read_only,
            connected: self.participants.len() as u32,
        }
    }
}

/// All instances and shares for one API key. Tenants isolate instances from
/// each other: two instances with different API keys never see each other's
/// peers or shares, even on the same server process.
#[derive(Default)]
pub struct Tenant {
    pub peers: HashMap<String, Peer>,
    pub shares: HashMap<String, Share>,
}

/// The whole server's state: one `Tenant` per distinct API key seen so far.
/// Keyed by the raw API key string — it's a shared secret the operator
/// distributes out of band, not a credential the server validates against
/// anything, so there's nothing to hash it against and no benefit to hashing
/// it here (it never leaves this in-memory map, is never logged, and is
/// gone when the process exits).
pub type SharedState = Arc<Mutex<HashMap<String, Tenant>>>;

pub fn new_state() -> SharedState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Sends `msg` to every peer in the tenant except `except_client_id`, if given.
pub fn broadcast(tenant: &Tenant, msg: &Message, except_client_id: Option<&str>) {
    for (client_id, peer) in &tenant.peers {
        if Some(client_id.as_str()) == except_client_id {
            continue;
        }
        // A send error means that peer's socket is already closing; its own
        // disconnect cleanup will remove it shortly. Nothing to do here.
        let _ = peer.sender.send(msg.clone());
    }
}
