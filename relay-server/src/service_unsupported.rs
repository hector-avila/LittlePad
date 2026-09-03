//! Fallback for any target that isn't Linux or macOS (Windows, for now) —
//! see service.rs. Not silently ignored: `install`/`uninstall` still exist
//! as subcommands there, they just clearly say this isn't implemented yet
//! instead of doing nothing or panicking.

use std::net::IpAddr;
use std::path::Path;

const MESSAGE: &str = "Installing as a system service isn't supported on this platform yet \
    (only Linux/systemd and macOS/launchd are, so far) — run the relay directly instead, \
    e.g. via Task Scheduler on Windows.";

pub fn check_writable() -> Result<(), String> {
    Err(MESSAGE.to_string())
}

pub fn install(
    _exe: &Path,
    _host: IpAddr,
    _port: u16,
    _base_path: &str,
    _log_file: &str,
    _user: &str,
) -> Result<(), String> {
    Err(MESSAGE.to_string())
}

pub fn uninstall() -> Result<(), String> {
    Err(MESSAGE.to_string())
}

pub fn read_installed_args() -> Option<Vec<String>> {
    None
}
