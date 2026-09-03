//! launchd (system-wide, LaunchDaemon) install/uninstall — see service.rs.

use std::net::IpAddr;
use std::path::Path;

use super::{run, service_args};

const PLIST_PATH: &str = "/Library/LaunchDaemons/com.littlepad.relay-server.plist";
const LABEL: &str = "com.littlepad.relay-server";

pub fn check_writable() -> Result<(), String> {
    super::check_dir_writable(Path::new("/Library/LaunchDaemons"))
}

/// The plist's exact contents — split out from `install()` so it can be
/// unit-tested without touching the filesystem or needing root.
fn plist_contents(exe: &Path, host: IpAddr, port: u16, base_path: &str, log_file: &str, user: &str) -> String {
    let args_xml = service_args(exe, host, port, base_path, log_file)
        .iter()
        .map(|a| format!("        <string>{}</string>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20   <key>Label</key>\n\
         \x20   <string>{LABEL}</string>\n\
         \x20   <key>ProgramArguments</key>\n\
         \x20   <array>\n\
         {args_xml}\n\
         \x20   </array>\n\
         \x20   <key>UserName</key>\n\
         \x20   <string>{user}</string>\n\
         \x20   <key>RunAtLoad</key>\n\
         \x20   <true/>\n\
         \x20   <key>KeepAlive</key>\n\
         \x20   <true/>\n\
         </dict>\n\
         </plist>\n"
    )
}

pub fn install(exe: &Path, host: IpAddr, port: u16, base_path: &str, log_file: &str, user: &str) -> Result<(), String> {
    let plist = plist_contents(exe, host, port, base_path, log_file, user);
    std::fs::write(PLIST_PATH, plist).map_err(write_error)?;
    run(&["launchctl", "load", "-w", PLIST_PATH])?;

    println!("Installed and started as a launchd service.");
    println!("  Status:  launchctl list | grep {LABEL}");
    println!("  Logs:    log show --predicate 'process == \"littlepad-relay-server\"' --last 1h");
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    // Best-effort: fine if it was never installed, or already stopped.
    let _ = run(&["launchctl", "unload", "-w", PLIST_PATH]);
    if Path::new(PLIST_PATH).exists() {
        std::fs::remove_file(PLIST_PATH).map_err(write_error)?;
    }
    println!("Uninstalled.");
    Ok(())
}

/// Reads back the argument list from a currently-installed plist (if any),
/// for `uninstall`'s reverse-proxy-removal reminder — best-effort, `None`
/// if nothing's installed or the file's unreadable.
pub fn read_installed_args() -> Option<Vec<String>> {
    let contents = std::fs::read_to_string(PLIST_PATH).ok()?;
    let key_at = contents.find("<key>ProgramArguments</key>")?;
    let array_start = contents[key_at..].find("<array>")? + key_at + "<array>".len();
    let array_end = contents[array_start..].find("</array>")? + array_start;
    let section = &contents[array_start..array_end];

    let mut tokens = Vec::new();
    let mut rest = section;
    while let Some(open) = rest.find("<string>") {
        let after_open = &rest[open + "<string>".len()..];
        let close = after_open.find("</string>")?;
        tokens.push(xml_unescape(&after_open[..close]));
        rest = &after_open[close + "</string>".len()..];
    }
    Some(tokens)
}

fn write_error(e: std::io::Error) -> String {
    format!("Could not write {PLIST_PATH}: {e} — try running this again with sudo.")
}

/// Escapes the handful of characters that matter inside a plist `<string>`
/// element — a host/path a user typed is the only untrusted input here.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The inverse of `xml_escape`, for `read_installed_args`.
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::{plist_contents, xml_unescape};
    use std::path::Path;

    #[test]
    fn renders_expected_program_arguments() {
        let plist = plist_contents(
            Path::new("/usr/local/bin/littlepad-relay-server"),
            "0.0.0.0".parse().unwrap(),
            7878,
            "",
            "",
            "littlepad",
        );
        assert!(plist.contains("<string>/usr/local/bin/littlepad-relay-server</string>"));
        assert!(plist.contains("<string>--host</string>"));
        assert!(plist.contains("<string>0.0.0.0</string>"));
        assert!(plist.contains("<string>--port</string>"));
        assert!(plist.contains("<string>7878</string>"));
        assert!(plist.contains("<string>littlepad</string>"));
        assert!(!plist.contains("--base-path"));
        assert!(!plist.contains("--log-file"));
    }

    #[test]
    fn includes_base_path_and_log_file_when_set() {
        let plist = plist_contents(
            Path::new("/usr/local/bin/littlepad-relay-server"),
            "127.0.0.1".parse().unwrap(),
            9000,
            "/share",
            "/var/log/littlepad-relay-server.log",
            "root",
        );
        assert!(plist.contains("<string>--base-path</string>"));
        assert!(plist.contains("<string>/share</string>"));
        assert!(plist.contains("<string>--log-file</string>"));
        assert!(plist.contains("<string>/var/log/littlepad-relay-server.log</string>"));
    }

    #[test]
    fn escapes_xml_special_characters() {
        let plist = plist_contents(
            Path::new("/usr/local/bin/littlepad-relay-server"),
            "127.0.0.1".parse().unwrap(),
            9000,
            "/a&b<c>",
            "",
            "root",
        );
        assert!(plist.contains("<string>/a&amp;b&lt;c&gt;</string>"));
    }

    #[test]
    fn xml_unescape_is_the_inverse_of_escape() {
        assert_eq!(xml_unescape("/a&amp;b&lt;c&gt;"), "/a&b<c>");
    }
}
