//! Wire protocol between LittlePad instances and the relay server.
//!
//! Everything travels as one JSON object per WebSocket text frame, tagged by
//! `type`. Authentication happens once, out-of-band from these messages, via
//! the `Sec-WebSocket-Protocol` handshake header (see `ws::extract_api_key`)
//! — not a message here. The server never inspects document content or
//! passwords: `Edit`,
//! `Snapshot`, `Joined` and `Resync` carry only opaque `ciphertext`/`iv`/`salt`
//! fields produced and consumed entirely on the client side (see
//! `src-tauri/src/share_crypto.rs`). `filename` and `read_only` are the only
//! plaintext fields, by design — they're the metadata shown in each
//! instance's "currently shared files" list.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Message {
    /// Server -> client, once, right after a successful auth handshake.
    Welcome { client_id: String },
    /// Server -> client instead of `Welcome` when the `Authorization` header
    /// is missing or empty; the socket is closed right after.
    Error { code: String },

    /// Client -> server: list the shares currently known in this tenant.
    List,
    /// Server -> client: response to `List`, and sent unprompted right after
    /// `Welcome` so a newly-connected instance sees the current state.
    Shares { shares: Vec<ShareInfo> },

    /// Client -> server: announce a new share. `share_id` is a UUID the
    /// client generates itself.
    ShareCreate {
        share_id: String,
        filename: String,
        read_only: bool,
    },
    /// Server -> client: ack to the creator.
    ShareCreated { share_id: String },
    /// Server -> client: broadcast to the rest of the tenant when a share
    /// is newly created.
    ShareAdded { share: ShareInfo },
    /// Server -> client: broadcast to the rest of the tenant whenever a
    /// share's `connected` count changes (see `JoinAck`/`Leave`/disconnect)
    /// — same payload shape as `ShareAdded`, just not a new share.
    ShareUpdated { share: ShareInfo },
    /// Server -> client: broadcast when a share is unshared, or when its
    /// owner disconnects (the server drops it rather than keep serving a
    /// share nobody can produce a snapshot for).
    ShareRemoved { share_id: String },

    /// Client -> server: "I want to open this share but hold no content for
    /// it yet."
    Join { share_id: String },
    /// Server -> client: relayed to the rest of the tenant so one of them
    /// (whoever currently holds the content) answers with a `Snapshot`.
    SnapshotRequest {
        share_id: String,
        for_client_id: String,
    },
    /// Client -> server: the current content, encrypted, addressed to one
    /// joining client. `word_wrap`/`language` travel in the clear, same as
    /// `filename`/`read_only` on `ShareInfo` — cosmetic editor state, not
    /// document content — so a joiner starts out matching the owner's
    /// current choice instead of waiting for a `Properties` update.
    Snapshot {
        share_id: String,
        to_client_id: String,
        seq: u64,
        ciphertext: String,
        iv: String,
        salt: String,
        word_wrap: bool,
        language: String,
    },
    /// Server -> client: the snapshot relayed to the joiner that asked for it.
    Joined {
        share_id: String,
        seq: u64,
        ciphertext: String,
        iv: String,
        salt: String,
        word_wrap: bool,
        language: String,
    },
    /// Client -> server: I successfully decrypted the snapshot from
    /// `Joined` (or a reconnect's, same message) — this is what actually
    /// counts as "connected" for `ShareInfo.connected`, since the server has
    /// no other way to tell a successful join from one with a wrong
    /// password (it never sees enough to check that itself).
    JoinAck { share_id: String },

    /// Bidirectional: an encrypted edit. The server broadcasts it to every
    /// other connection in the tenant; clients ignore it if `share_id`
    /// doesn't match one they hold open.
    Edit {
        share_id: String,
        ciphertext: String,
        iv: String,
    },
    /// Bidirectional pure relay, same shape as `Edit`: the owner's current
    /// word-wrap/language for this share, sent whenever either changes.
    /// Plaintext, like `Snapshot`/`Joined`'s copies of the same fields —
    /// only the owner is meant to send it (enforced client-side, same as
    /// `read_only` for `Edit`; the server has no way to check who "the
    /// owner" is for content it never decrypts).
    Properties {
        share_id: String,
        word_wrap: bool,
        language: String,
    },
    /// Bidirectional: "my local copy of this share is out of sync, send me a
    /// fresh snapshot" — the client-side safety net for last-writer-wins.
    ResyncRequest { share_id: String, seq: u64 },
    /// Bidirectional: a fresh full-content snapshot answering a
    /// `ResyncRequest` (a plain content replace, never a patch, so it can
    /// never itself corrupt a document).
    Resync {
        share_id: String,
        seq: u64,
        ciphertext: String,
        iv: String,
    },

    /// Client -> server: stop sharing a file I own.
    Unshare { share_id: String },
    /// Client -> server: I'm no longer participating in this share (the
    /// connection itself stays open — I may hold other shares). Triggers a
    /// `ShareUpdated` broadcast with the decremented `connected` count,
    /// same as a disconnect while holding this share does.
    Leave { share_id: String },
}

/// Metadata for one shared file — everything the server is allowed to know
/// about it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub share_id: String,
    pub filename: String,
    pub read_only: bool,
    /// How many instances currently hold this share open — the owner
    /// (counted from creation) plus every peer that's sent `JoinAck` and
    /// hasn't left/disconnected since.
    pub connected: u32,
}
