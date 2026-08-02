fn main() {
    // tauri-build doesn't watch the icon files themselves (only
    // tauri.conf.json), so regenerating icons/* via `tauri icon` wouldn't
    // otherwise cause this build script to rerun.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=../app-icon.svg");

    // Rerunning this script alone still isn't enough: the runtime window
    // icon (`default_window_icon`, used on every platform — it's what
    // shows up as the taskbar/window icon on Linux, not just packaging) is
    // baked in by the `tauri::generate_context!()` macro in src/lib.rs,
    // which reads the icon bytes with a plain `fs::read` rather than
    // `include_bytes!`. Rustc has no dependency-tracking on that read, so
    // even with the rerun-if-changed above, lib.rs's compiled output would
    // silently keep embedding whatever icon was baked in the first time it
    // was ever compiled — in `cargo build`, `cargo build --release`, and
    // `tauri dev` alike. Emitting a hash of the icon bytes as an env var
    // forces Cargo to invalidate (and thus recompile) every target in this
    // package whenever that hash changes, which is exactly when the icon
    // bytes actually changed.
    println!("cargo:rustc-env=LITTLEPAD_ICON_HASH={}", icon_fingerprint());

    tauri_build::build()
}

fn icon_fingerprint() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for name in [
        "icons/icon.ico",
        "icons/icon.icns",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        if let Ok(bytes) = std::fs::read(name) {
            bytes.hash(&mut hasher);
        }
    }
    format!("{:x}", hasher.finish())
}
