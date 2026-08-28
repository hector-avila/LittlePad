//! IPC commands exposed to the frontend.

use crate::session::{self, SessionData, SessionIndex, TabMeta, WindowState};
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
}

/// Loads the full session on app startup.
#[tauri::command]
pub fn load_session(app: tauri::AppHandle) -> Result<SessionData, String> {
    let dir = session::session_dir(&app)?;
    session::load_all(&dir)
}

/// Autosaves a tab (content + metadata), atomically.
#[tauri::command]
pub fn save_session_tab(
    app: tauri::AppHandle,
    id: String,
    content: String,
    meta: TabMeta,
) -> Result<(), String> {
    session::validate_id(&id)?;
    let dir = session::session_dir(&app)?;
    session::atomic_write(&session::tab_content_path(&dir, &id), content.as_bytes())?;
    let meta_json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    session::atomic_write(&session::tab_meta_path(&dir, &id), &meta_json)
}

/// Removes the session files of a closed tab.
#[tauri::command]
pub fn delete_session_tab(app: tauri::AppHandle, id: String) -> Result<(), String> {
    session::validate_id(&id)?;
    let dir = session::session_dir(&app)?;
    let _ = fs::remove_file(session::tab_content_path(&dir, &id));
    let _ = fs::remove_file(session::tab_meta_path(&dir, &id));
    Ok(())
}

/// Saves the session index (tab order, active tab), atomically.
#[tauri::command]
pub fn save_session_index(app: tauri::AppHandle, index: SessionIndex) -> Result<(), String> {
    let dir = session::session_dir(&app)?;
    let json = serde_json::to_vec(&index).map_err(|e| e.to_string())?;
    session::atomic_write(&dir.join("session.json"), &json)
}

/// The file's last-modified time, in milliseconds since the Unix epoch.
/// Used to detect changes made outside the app (e.g. by another program)
/// while a tab for that file is open — see the frontend's
/// `services/externalChanges.ts`.
#[tauri::command]
pub fn get_file_mtime(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("could not stat {path}: {e}"))?;
    let modified = meta.modified().map_err(|e| e.to_string())?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    Ok(millis)
}

/// Opens a file from the filesystem, detecting its encoding (UTF-8 or Latin-1).
#[tauri::command]
pub fn open_file(path: String) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent {
            content,
            encoding: "utf-8".into(),
        }),
        Err(err) => {
            // Not valid UTF-8: decode as Windows-1252/Latin-1 (common in logs)
            let (content, _, _) = encoding_rs::WINDOWS_1252.decode(err.as_bytes());
            Ok(FileContent {
                content: content.into_owned(),
                encoding: "latin1".into(),
            })
        }
    }
}

/// Saves content to a file on the filesystem (atomic write).
#[tauri::command]
pub fn save_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let bytes: Vec<u8> = match encoding.as_deref() {
        Some("latin1") => encoding_rs::WINDOWS_1252.encode(&content).0.into_owned(),
        _ => content.into_bytes(),
    };
    session::atomic_write(Path::new(&path), &bytes)
}

/// Root directory where the session/autosave data lives (shown on the
/// Settings screen).
#[tauri::command]
pub fn get_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(session::data_root(&app)?.to_string_lossy().to_string())
}

/// Changes the root data directory (see `session::set_data_root`).
#[tauri::command]
pub fn set_data_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    session::set_data_root(&app, &path)
}

/// Files passed as CLI arguments when this instance itself was launched.
/// Consumed exactly once (the list is emptied on read) so the frontend can
/// safely call this on every startup without ever reopening the same files
/// twice.
#[tauri::command]
pub fn get_launch_files(state: tauri::State<crate::LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// True only the very first time the app has ever run (based on a marker
/// file inside the data directory); false every time after.
#[tauri::command]
pub fn check_first_run(app: tauri::AppHandle) -> bool {
    let marker = match session::data_root(&app) {
        Ok(dir) => dir.join(".onboarded"),
        Err(_) => return false,
    };
    if marker.exists() {
        return false;
    }
    if let Some(parent) = marker.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&marker, b"").is_ok()
}

/// Creates a desktop shortcut and adds the executable's directory to the
/// user's PATH. Returns a human-readable summary to show the user.
#[tauri::command]
pub fn setup_shortcuts(app: tauri::AppHandle) -> Result<String, String> {
    crate::onboarding::setup(&app)
}

/// Removes the desktop shortcut and PATH entry created by `setup_shortcuts`.
/// Part of the Settings "uninstall" action.
#[tauri::command]
pub fn remove_shortcuts(app: tauri::AppHandle) -> Result<String, String> {
    crate::onboarding::remove(&app)
}

/// Deletes all data this app has ever written to disk (session/autosave
/// content, the first-run marker, and the data-location override). Part of
/// the Settings "uninstall" action. Irreversible.
#[tauri::command]
pub fn delete_app_data(app: tauri::AppHandle) -> Result<(), String> {
    session::delete_all_data(&app)
}

/// Saves the window's position/size (of its last non-maximized bounds —
/// tracked by the frontend, see App.tsx) and whether it was maximized, so
/// the next launch can restore it. Called right before the window closes.
#[tauri::command]
pub fn save_window_state(app: tauri::AppHandle, state: WindowState) -> Result<(), String> {
    session::save_window_state(&app, state)
}

/// Family names of every font installed on this system (sorted,
/// deduplicated), for the font picker on the Settings screen.
#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    use font_kit::source::SystemSource;
    let mut families = SystemSource::new().all_families().unwrap_or_default();
    families.sort_unstable();
    families.dedup();
    families
}

/// Registers LittlePad as an "Open with" candidate for one file extension
/// the user picked on the Settings screen. Windows and Linux only (see
/// `onboarding::register_file_association`); opt-in, called once per
/// checked extension — never called automatically.
#[tauri::command]
pub fn register_file_association(app: tauri::AppHandle, ext: String) -> Result<(), String> {
    crate::onboarding::register_file_association(&app, &ext)
}

/// Undoes `register_file_association` for one extension.
#[tauri::command]
pub fn unregister_file_association(app: tauri::AppHandle, ext: String) -> Result<(), String> {
    crate::onboarding::unregister_file_association(&app, &ext)
}

/// Removes every extension in `extensions` (the user's current picks) plus
/// the underlying "Open with" registration itself. Used by the Settings
/// "Remove all" action, and (best-effort) from Uninstall.
#[tauri::command]
pub fn remove_all_file_associations(
    app: tauri::AppHandle,
    extensions: Vec<String>,
) -> Result<String, String> {
    crate::onboarding::remove_all_file_associations(&app, &extensions)
}

/// OS name and CPU architecture of this compiled binary — e.g.
/// `("macos", "aarch64")`. Used by the frontend's update checker to pick
/// the matching release asset (see `services/updateCheck.ts`). Resolved
/// natively (not at frontend build time) so cross-compiled builds — the
/// macOS Intel/Apple Silicon matrix legs run on the same runner arch, see
/// .github/workflows/release.yml — still report their real target.
#[tauri::command]
pub fn platform_info() -> (String, String) {
    (std::env::consts::OS.into(), std::env::consts::ARCH.into())
}
