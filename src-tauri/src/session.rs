//! Session persistence with atomic writes.
//!
//! Anti-corruption strategy (power loss / kill -9):
//!   1. write to `<file>.tmp`
//!   2. fsync the file
//!   3. atomic rename to `<file>` (ext4/NTFS guarantee atomicity)
//!   4. fsync the directory (unix only)
//!
//! On-disk layout ($HOME/.littlepad/session/, unless the user overrides it):
//!   session.json      -> index: tab order, active tab
//!   tab-<id>.txt      -> each tab's content
//!   tab-<id>.meta     -> tab metadata (JSON)

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabMeta {
    pub id: String,
    pub title: String,
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
    pub language: String,
    #[serde(rename = "languageManual")]
    pub language_manual: bool,
    pub dirty: bool,
    pub cursor: usize,
    /// Set only for a tab that joined someone else's share (real-time file
    /// sharing — see services/shareClient.ts) — never for the share's own
    /// owner (services/session.ts's toMeta() omits it for that case), so on
    /// restart an owner's tab always comes back as a plain local tab, while
    /// a peer's offers to reconnect (password only) instead. `#[serde(default)]`
    /// so older session files without these fields still load fine.
    #[serde(rename = "shareId", default)]
    pub share_id: Option<String>,
    #[serde(rename = "shareReadOnly", default)]
    pub share_read_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionIndex {
    /// Tab IDs in display order
    #[serde(rename = "tabOrder")]
    pub tab_order: Vec<String>,
    #[serde(rename = "activeTabId")]
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTab {
    pub meta: TabMeta,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub index: Option<SessionIndex>,
    pub tabs: Vec<SessionTab>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DataLocation {
    #[serde(rename = "dataDir")]
    data_dir: String,
}

/// Window position/size (of its last non-maximized bounds — see
/// `commands::save_window_state`) plus whether it was maximized when the
/// app was closed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Default data directory: `$HOME/.littlepad`, fixed and independent of
/// Tauri's identifier (unlike `app_data_dir()`).
fn default_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    Ok(home.join(".littlepad"))
}

/// Fixed path (never moves) of the file that points to the data directory
/// the user chose, if they changed it from the default. Always lives inside
/// `default_data_root`, never in the chosen destination, so it can be found
/// regardless of where the override points.
fn override_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = default_data_root(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("data-location.json"))
}

fn read_override(app: &tauri::AppHandle) -> Option<PathBuf> {
    let f = override_file(app).ok()?;
    let bytes = fs::read(f).ok()?;
    let loc: DataLocation = serde_json::from_slice(&bytes).ok()?;
    Some(PathBuf::from(loc.data_dir))
}

/// Root data directory: whatever the user chose (Settings) if set,
/// otherwise `$HOME/.littlepad` by default.
pub fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = read_override(app) {
        return Ok(custom);
    }
    default_data_root(app)
}

/// Changes the root data directory. If there was a session at the previous
/// location, it is COPIED (the source is never deleted) to the new one to
/// avoid any risk of data loss; the change takes effect on the next restart.
pub fn set_data_root(app: &tauri::AppHandle, new_dir: &str) -> Result<(), String> {
    let new_path = PathBuf::from(new_dir);
    if new_dir.trim().is_empty() {
        return Err("empty path".into());
    }
    fs::create_dir_all(&new_path).map_err(|e| format!("could not create the directory: {e}"))?;

    // Verify it's writable before accepting the change.
    let probe = new_path.join(".littlepad-write-test");
    fs::write(&probe, b"ok").map_err(|e| format!("directory is not writable: {e}"))?;
    let _ = fs::remove_file(&probe);

    if let Ok(old_dir) = data_root(app) {
        let old_session = old_dir.join("session");
        if old_session.is_dir() && old_session != new_path.join("session") {
            let new_session = new_path.join("session");
            fs::create_dir_all(&new_session).map_err(|e| format!("mkdir new session: {e}"))?;
            if let Ok(entries) = fs::read_dir(&old_session) {
                for entry in entries.flatten() {
                    if entry.path().is_file() {
                        let _ = fs::copy(entry.path(), new_session.join(entry.file_name()));
                    }
                }
            }
        }
    }

    let json = serde_json::to_vec(&DataLocation {
        data_dir: new_dir.to_string(),
    })
    .map_err(|e| e.to_string())?;
    atomic_write(&override_file(app)?, &json)
}

/// Deletes everything this app has ever written to disk: the live session
/// data (wherever it currently lives, default or user-relocated via
/// Settings) and the default data directory (which always holds the
/// data-location override and first-run marker, regardless of where
/// storage was relocated to — see `override_file`). Used by the Settings
/// "uninstall" action.
pub fn delete_all_data(app: &tauri::AppHandle) -> Result<(), String> {
    let current = data_root(app)?;
    let default_dir = default_data_root(app)?;

    let session = current.join("session");
    if session.is_dir() {
        fs::remove_dir_all(&session).map_err(|e| format!("could not delete session data: {e}"))?;
    }

    if default_dir.is_dir() {
        // Exclusively owned by this app (data-location.json, .onboarded,
        // and the default session/ if storage was never relocated) — safe
        // to remove entirely, unlike a user-chosen custom directory below.
        fs::remove_dir_all(&default_dir)
            .map_err(|e| format!("could not delete {}: {e}", default_dir.display()))?;
    }

    if current != default_dir {
        // A custom directory may hold files unrelated to this app: only
        // remove it if it's now empty, never force-delete its contents.
        let _ = fs::remove_dir(&current);
    }

    Ok(())
}

pub fn session_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("session");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir session: {e}"))?;
    Ok(dir)
}

fn window_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("window-state.json"))
}

pub fn load_window_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let path = window_state_path(app).ok()?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn save_window_state(app: &tauri::AppHandle, state: WindowState) -> Result<(), String> {
    let dir = data_root(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let json = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    atomic_write(&window_state_path(app)?, &json)
}

/// Applies the last saved window position/size/maximized state, if any, to
/// `window` — called from `setup()` before the (initially hidden) window is
/// shown, so there's no visible jump. If the saved position doesn't fall
/// within any currently-connected monitor (e.g. a second monitor was
/// unplugged since the last run), the position/size are left at their
/// `tauri.conf.json` defaults — only `maximized` still applies.
pub fn restore_window_state(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Some(state) = load_window_state(app) else {
        return;
    };

    let fits_a_monitor = window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|m| {
                let pos = m.position();
                let size = m.size();
                state.x + 50 >= pos.x
                    && state.y + 50 >= pos.y
                    && state.x < pos.x + size.width as i32
                    && state.y < pos.y + size.height as i32
            })
        })
        .unwrap_or(false);

    if fits_a_monitor {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: state.x,
            y: state.y,
        }));
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: state.width,
            height: state.height,
        }));
    }

    if state.maximized {
        let _ = window.maximize();
    }
}

/// Atomic write: tmp + fsync + rename + fsync(dir).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(
        path.extension()
            .map(|e| format!("{}.tmp", e.to_string_lossy()))
            .unwrap_or_else(|| "tmp".into()),
    );

    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
    }

    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;

    // fsync the directory so the rename survives a power loss (unix)
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(d) = fs::File::open(parent) {
            let _ = d.sync_all();
        }
    }

    Ok(())
}

pub fn tab_content_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("tab-{id}.txt"))
}

pub fn tab_meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("tab-{id}.meta"))
}

/// Validates that the id is a safe uuid-like string (prevents path traversal).
pub fn validate_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        Ok(())
    } else {
        Err(format!("invalid tab id: {id}"))
    }
}

pub fn load_all(dir: &Path) -> Result<SessionData, String> {
    let index: Option<SessionIndex> = fs::read(dir.join("session.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());

    let mut tabs = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(id) = name
            .strip_prefix("tab-")
            .and_then(|s| s.strip_suffix(".meta"))
        {
            let meta: TabMeta = match fs::read(entry.path())
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
            {
                Some(m) => m,
                None => continue, // corrupt/incomplete meta: skip it
            };
            let content = fs::read(tab_content_path(dir, id))
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            tabs.push(SessionTab { meta, content });
        }
    }

    // Sort by the index (unknown tabs go last)
    if let Some(idx) = &index {
        let pos = |id: &str| {
            idx.tab_order
                .iter()
                .position(|x| x == id)
                .unwrap_or(usize::MAX)
        };
        tabs.sort_by_key(|t| pos(&t.meta.id));
    }

    Ok(SessionData { index, tabs })
}
