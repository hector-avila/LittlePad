//! First-run onboarding: offer to create a desktop shortcut and add the
//! app to the user's PATH. Best-effort and non-destructive: every write is
//! additive (append to PATH, create a new file/symlink), nothing existing
//! is ever deleted or overwritten without being recreated identically.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::Path;
use std::path::PathBuf;
use tauri::Manager;

fn exe_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("could not determine the executable path: {e}"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn add_to_local_bin(exe: &Path) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let bin_dir = PathBuf::from(home).join(".local").join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("could not create ~/.local/bin: {e}"))?;
    let link = bin_dir.join("littlepad");
    let _ = std::fs::remove_file(&link); // drop a stale symlink before recreating it
    std::os::unix::fs::symlink(exe, &link)
        .map_err(|e| format!("could not create the ~/.local/bin symlink: {e}"))?;
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn remove_from_local_bin() -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let link = PathBuf::from(home).join(".local").join("bin").join("littlepad");
    let _ = std::fs::remove_file(&link);
    Ok(())
}

/// Embedded at compile time (see the Linux `ICON_PNG` doc comment for the
/// same rationale). Written out at setup time so both shortcuts can set an
/// explicit `IconLocation`, independent of whatever the compiled .exe's own
/// PE resource icon looks like — that one is handled separately by
/// `LITTLEPAD_ICON_HASH` in `build.rs`, but pointing the shortcuts at a
/// known-good `.ico` file directly means their icon can't go stale even if
/// something about that other mechanism ever misbehaves.
#[cfg(target_os = "windows")]
static ICON_ICO: &[u8] = include_bytes!("../icons/icon.ico");

#[cfg(target_os = "windows")]
fn win_icon_dir() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .ok()?;
    Some(PathBuf::from(base).join("LittlePad"))
}

/// Windows Explorer/the taskbar cache icons **per file path**, and that
/// cache is notoriously sticky and inconsistent about noticing a file's
/// content changed — a fixed `icon.ico` path that gets overwritten with
/// different bytes across app updates can keep showing a stale (or
/// default-Tauri) icon indefinitely, seemingly at random. Naming the file
/// after a hash of its own bytes means a changed icon is a *brand-new*
/// path Explorer has never cached anything for, sidestepping the problem
/// entirely instead of fighting the cache.
#[cfg(target_os = "windows")]
fn icon_hash() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    ICON_ICO.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[cfg(target_os = "windows")]
fn install_win_icon() -> Option<PathBuf> {
    let dir = win_icon_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("icon-{}.ico", icon_hash()));
    std::fs::write(&path, ICON_ICO).ok()?;

    // Best-effort: remove icon files left behind by earlier versions of the
    // app so they don't pile up (harmless either way — Explorer's cache
    // being keyed by path means an orphaned old file can't affect the
    // fresh one above).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("icon-") && name.ends_with(".ico") && entry.path() != path {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    Some(path)
}

/// Per-user Start Menu folder: shortcuts placed here are what actually
/// shows up in the Start Menu's app list and search — a Desktop shortcut
/// alone does not.
#[cfg(target_os = "windows")]
fn start_menu_dir() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(|a| {
        PathBuf::from(a)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
    })
}

#[cfg(target_os = "windows")]
pub fn setup(app: &tauri::AppHandle) -> Result<String, String> {
    use winreg::enums::*;
    use winreg::types::ToRegValue;
    use winreg::RegKey;

    let exe = exe_path()?;
    let exe_str = exe.to_string_lossy().to_string();
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent directory".to_string())?;
    let dir_str = dir.to_string_lossy().to_string();
    let escape = |s: &str| s.replace('\'', "''");

    // 1. Shortcuts (.lnk): one on the Desktop, one in the Start Menu (so
    //    LittlePad actually shows up in Windows' program list/search — a
    //    Desktop-only shortcut does not), via PowerShell + the
    //    WScript.Shell COM object (no extra native dependency needed).
    let icon_path = install_win_icon();
    let mut lnk_targets = Vec::new();
    if let Ok(desktop) = app.path().desktop_dir() {
        let _ = std::fs::create_dir_all(&desktop);
        lnk_targets.push(desktop.join("LittlePad.lnk"));
    }
    if let Some(start_menu) = start_menu_dir() {
        let _ = std::fs::create_dir_all(&start_menu);
        lnk_targets.push(start_menu.join("LittlePad.lnk"));
    }

    let mut script = String::new();
    for (i, lnk_path) in lnk_targets.iter().enumerate() {
        script.push_str(&format!(
            "$s{i}=(New-Object -COM WScript.Shell).CreateShortcut('{}'); \
             $s{i}.TargetPath='{}'; $s{i}.WorkingDirectory='{}'; ",
            escape(&lnk_path.to_string_lossy()),
            escape(&exe_str),
            escape(&dir_str),
        ));
        if let Some(icon) = &icon_path {
            script.push_str(&format!(
                "$s{i}.IconLocation='{},0'; ",
                escape(&icon.to_string_lossy())
            ));
        }
        script.push_str(&format!("$s{i}.Save(); "));
    }

    let mut shortcut_warning = None;
    if !lnk_targets.is_empty() {
        match std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
        {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                shortcut_warning = Some(format!(
                    "shortcut creation reported an error: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))
            }
            Err(e) => shortcut_warning = Some(format!("could not run PowerShell: {e}")),
        }
    }

    // 2. Add the executable's directory to the user PATH (HKCU\Environment),
    //    preserving whether the existing value is REG_SZ or REG_EXPAND_SZ.
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_ALL_ACCESS)
        .map_err(|e| format!("could not open the Environment registry key: {e}"))?;

    let current: String = env.get_value("Path").unwrap_or_default();
    let vtype = env
        .get_raw_value("Path")
        .map(|v| v.vtype)
        .unwrap_or(REG_EXPAND_SZ);

    let already_present = current
        .split(';')
        .any(|p| p.trim().eq_ignore_ascii_case(&dir_str));

    if !already_present {
        let new_value = if current.trim().is_empty() {
            dir_str.clone()
        } else if current.trim_end().ends_with(';') {
            format!("{current}{dir_str}")
        } else {
            format!("{current};{dir_str}")
        };
        let mut reg_value = new_value.to_reg_value();
        reg_value.vtype = vtype;
        env.set_raw_value("Path", &reg_value)
            .map_err(|e| format!("could not update PATH: {e}"))?;
    }

    Ok(match shortcut_warning {
        None => "Shortcut created on the Desktop and in the Start Menu, and \
                  added to your PATH. Open a new terminal for the PATH \
                  change to take effect there."
            .into(),
        Some(w) => format!(
            "Added to your PATH (open a new terminal for it to take effect), \
             but the {w}."
        ),
    })
}

/// Undoes `setup`: removes the Desktop shortcut and the executable's
/// directory from the user PATH. Best-effort — a missing shortcut or an
/// already-absent PATH entry is not an error.
#[cfg(target_os = "windows")]
pub fn remove(app: &tauri::AppHandle) -> Result<String, String> {
    use winreg::enums::*;
    use winreg::types::ToRegValue;
    use winreg::RegKey;

    let exe = exe_path()?;
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent directory".to_string())?;
    let dir_str = dir.to_string_lossy().to_string();

    if let Ok(desktop) = app.path().desktop_dir() {
        let _ = std::fs::remove_file(desktop.join("LittlePad.lnk"));
    }
    if let Some(start_menu) = start_menu_dir() {
        let _ = std::fs::remove_file(start_menu.join("LittlePad.lnk"));
    }
    if let Some(icon_dir) = win_icon_dir() {
        // Named icon-<hash>.ico (see install_win_icon): the hash this
        // binary would compute may not match what wrote the file if it was
        // written by an older/newer version, so remove by pattern rather
        // than recomputing a single expected name.
        if let Ok(entries) = std::fs::read_dir(&icon_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("icon-") && name.ends_with(".ico") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let _ = std::fs::remove_dir(&icon_dir); // only succeeds if now empty
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_ALL_ACCESS)
        .map_err(|e| format!("could not open the Environment registry key: {e}"))?;

    let current: String = env.get_value("Path").unwrap_or_default();
    let vtype = env
        .get_raw_value("Path")
        .map(|v| v.vtype)
        .unwrap_or(REG_EXPAND_SZ);

    let filtered = current
        .split(';')
        .filter(|p| !p.trim().is_empty() && !p.trim().eq_ignore_ascii_case(&dir_str))
        .collect::<Vec<_>>()
        .join(";");

    if filtered != current {
        let mut reg_value = filtered.to_reg_value();
        reg_value.vtype = vtype;
        env.set_raw_value("Path", &reg_value)
            .map_err(|e| format!("could not update PATH: {e}"))?;
    }

    Ok("Desktop and Start Menu shortcuts, the icon file, and the PATH entry \
        were removed."
        .into())
}

/// Embedded at compile time (see the `LITTLEPAD_ICON_HASH` trick in
/// `build.rs` for why this always reflects the current `app-icon.svg`):
/// written out to a stable path at setup time so the `.desktop` files can
/// point `Icon=` at an absolute file, which every desktop environment loads
/// directly with no icon-theme cache/name-lookup step to get wrong.
#[cfg(target_os = "linux")]
static ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

#[cfg(target_os = "linux")]
fn xdg_data_home(home: &str) -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(home).join(".local/share"))
}

/// Writes the embedded icon to `<xdg-data-home>/littlepad/icon.png` and
/// returns its path, for use in a `.desktop` file's `Icon=` key.
#[cfg(target_os = "linux")]
fn install_icon(home: &str) -> Option<PathBuf> {
    let dir = xdg_data_home(home).join("littlepad");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("icon.png");
    std::fs::write(&path, ICON_PNG).ok()?;
    Some(path)
}

#[cfg(target_os = "linux")]
pub fn setup(app: &tauri::AppHandle) -> Result<String, String> {
    let exe = exe_path()?;
    let exe_str = exe.to_string_lossy().to_string();
    let home = std::env::var("HOME").ok();
    let icon_path = home.as_deref().and_then(install_icon);
    let icon_line = icon_path
        .as_ref()
        .map(|p| format!("Icon={}\n", p.to_string_lossy()))
        .unwrap_or_default();

    let desktop_entry = format!(
        "[Desktop Entry]\nType=Application\nName=LittlePad\nExec=\"{exe_str}\" %F\n{icon_line}Terminal=false\nCategories=Utility;TextEditor;\n"
    );

    let make_executable = |path: &Path| {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(path, perms);
        }
    };

    // Application-menu entry.
    if let Some(home) = &home {
        let apps_dir = xdg_data_home(home).join("applications");
        if std::fs::create_dir_all(&apps_dir).is_ok() {
            let entry = apps_dir.join("littlepad.desktop");
            if std::fs::write(&entry, &desktop_entry).is_ok() {
                make_executable(&entry);
            }
        }
    }

    // Best-effort literal Desktop icon too.
    if let Ok(desktop_dir) = app.path().desktop_dir() {
        if std::fs::create_dir_all(&desktop_dir).is_ok() {
            let shortcut = desktop_dir.join("LittlePad.desktop");
            if std::fs::write(&shortcut, &desktop_entry).is_ok() {
                make_executable(&shortcut);
            }
        }
    }

    add_to_local_bin(&exe)?;

    Ok("Shortcut created and LittlePad linked into ~/.local/bin. Depending on \
        your desktop environment you may need to right-click the Desktop icon \
        and choose \"Allow Launching\" once. Open a new terminal for the PATH \
        change to take effect (~/.local/bin is usually already in PATH by default)."
        .into())
}

/// Undoes `setup`: removes the application-menu entry, the Desktop icon,
/// and the `~/.local/bin` symlink. Best-effort — nothing here was ever
/// added to PATH directly (that dir is usually already in the user's PATH
/// by default), so there is no registry/rc-file entry to undo.
#[cfg(target_os = "linux")]
pub fn remove(app: &tauri::AppHandle) -> Result<String, String> {
    if let Ok(home) = std::env::var("HOME") {
        let apps_dir = xdg_data_home(&home).join("applications");
        let _ = std::fs::remove_file(apps_dir.join("littlepad.desktop"));

        let icon_dir = xdg_data_home(&home).join("littlepad");
        let _ = std::fs::remove_file(icon_dir.join("icon.png"));
        let _ = std::fs::remove_dir(&icon_dir); // only succeeds if now empty
    }
    if let Ok(desktop_dir) = app.path().desktop_dir() {
        let _ = std::fs::remove_file(desktop_dir.join("LittlePad.desktop"));
    }
    remove_from_local_bin()?;
    Ok("Application-menu entry, Desktop icon, icon file, and ~/.local/bin link removed.".into())
}

#[cfg(target_os = "macos")]
pub fn setup(app: &tauri::AppHandle) -> Result<String, String> {
    let exe = exe_path()?;

    if let Ok(desktop_dir) = app.path().desktop_dir() {
        let _ = std::fs::create_dir_all(&desktop_dir);
        let link = desktop_dir.join("LittlePad");
        let _ = std::fs::remove_file(&link);
        let _ = std::os::unix::fs::symlink(&exe, &link);
    }

    add_to_local_bin(&exe)?;

    Ok("A shortcut (symlink) was added to the Desktop and to ~/.local/bin. \
        Since this build is a plain executable and not a signed .app bundle, \
        double-clicking the Desktop shortcut may not open a window the way a \
        regular Mac app would — running it from Terminal is more reliable. \
        Make sure ~/.local/bin is in your PATH (add it to ~/.zshrc or \
        ~/.bash_profile if needed) and open a new terminal."
        .into())
}

/// Undoes `setup`: removes the Desktop symlink and the `~/.local/bin`
/// symlink. Best-effort — this project never edits shell rc files, so
/// there is nothing to undo there (see the PATH note in `setup`).
#[cfg(target_os = "macos")]
pub fn remove(app: &tauri::AppHandle) -> Result<String, String> {
    if let Ok(desktop_dir) = app.path().desktop_dir() {
        let _ = std::fs::remove_file(desktop_dir.join("LittlePad"));
    }
    remove_from_local_bin()?;
    Ok("Desktop shortcut and ~/.local/bin link removed.".into())
}
