mod commands;
mod onboarding;
mod session;
mod share_crypto;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Files requested on the command line when the app itself was launched
/// (as opposed to a later `open-files` event from a second launch attempt,
/// see the single-instance plugin below). Consumed once by the frontend
/// via `commands::get_launch_files`.
pub struct LaunchFiles(pub Mutex<Vec<String>>);

#[derive(Clone, serde::Serialize)]
struct OpenFilesPayload {
    paths: Vec<String>,
}

/// Keeps only path-like arguments (skips flags such as `--foo`) and resolves
/// relative ones against `cwd`, so a file opened from a different working
/// directory than the already-running instance still points at the right file.
fn resolve_arg_paths(args: &[String], cwd: &Path) -> Vec<String> {
    args.iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = Path::new(a);
            if p.is_absolute() {
                a.clone()
            } else {
                cwd.join(a).to_string_lossy().into_owned()
            }
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: detects an already-running instance and
        // forwards this launch's CLI args to it instead of starting a second one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = resolve_arg_paths(&argv[1..], Path::new(&cwd));
            if !paths.is_empty() {
                let _ = app.emit("open-files", OpenFilesPayload { paths });
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let paths = resolve_arg_paths(&args[1..], &cwd);
            app.manage(LaunchFiles(Mutex::new(paths)));

            // The main window starts hidden (see tauri.conf.json) so its
            // saved position/size/maximized state can be applied before it
            // ever becomes visible — no visible jump on startup.
            if let Some(window) = app.get_webview_window("main") {
                session::restore_window_state(app.handle(), &window);
                let _ = window.show();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_session,
            commands::save_session_tab,
            commands::delete_session_tab,
            commands::save_session_index,
            commands::get_file_mtime,
            commands::open_file,
            commands::save_file,
            commands::get_data_dir,
            commands::set_data_dir,
            commands::get_launch_files,
            commands::check_first_run,
            commands::setup_shortcuts,
            commands::remove_shortcuts,
            commands::delete_app_data,
            commands::save_window_state,
            commands::list_system_fonts,
            commands::platform_info,
            commands::register_file_association,
            commands::unregister_file_association,
            commands::remove_all_file_associations,
            commands::share_generate_salt,
            commands::share_derive_key,
            commands::share_encrypt,
            commands::share_decrypt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
