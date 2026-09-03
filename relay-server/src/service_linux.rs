//! systemd (system-wide) install/uninstall — see service.rs.

use std::net::IpAddr;
use std::path::Path;

use super::{run, service_args};

const UNIT_PATH: &str = "/etc/systemd/system/littlepad-relay-server.service";
const UNIT_NAME: &str = "littlepad-relay-server";

pub fn check_writable() -> Result<(), String> {
    super::check_dir_writable(Path::new("/etc/systemd/system"))
}

/// The unit file's exact contents — split out from `install()` so it can be
/// unit-tested without touching the filesystem or needing root.
fn unit_file_contents(exe: &Path, host: IpAddr, port: u16, base_path: &str, log_file: &str, user: &str) -> String {
    let args = service_args(exe, host, port, base_path, log_file);
    // systemd's ExecStart= splits on whitespace itself; quoting each token
    // defends against a path/value that happens to contain a space.
    let exec_start = args
        .iter()
        .map(|a| format!("\"{a}\""))
        .collect::<Vec<_>>()
        .join(" ");

    format!(
        "[Unit]\n\
         Description=LittlePad share relay\n\
         After=network.target\n\
         \n\
         [Service]\n\
         ExecStart={exec_start}\n\
         Restart=on-failure\n\
         User={user}\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n"
    )
}

pub fn install(exe: &Path, host: IpAddr, port: u16, base_path: &str, log_file: &str, user: &str) -> Result<(), String> {
    let unit = unit_file_contents(exe, host, port, base_path, log_file, user);
    std::fs::write(UNIT_PATH, unit).map_err(write_error)?;
    run(&["systemctl", "daemon-reload"])?;
    run(&["systemctl", "enable", "--now", UNIT_NAME])?;

    println!("Installed and started as a systemd service.");
    println!("  Status:  systemctl status {UNIT_NAME}");
    println!("  Logs:    journalctl -u {UNIT_NAME} -f");
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    // Best-effort: fine if it was never installed, or already stopped.
    let _ = run(&["systemctl", "disable", "--now", UNIT_NAME]);
    if Path::new(UNIT_PATH).exists() {
        std::fs::remove_file(UNIT_PATH).map_err(write_error)?;
    }
    run(&["systemctl", "daemon-reload"])?;
    println!("Uninstalled.");
    Ok(())
}

/// Reads back the argument list from a currently-installed unit file (if
/// any), for `uninstall`'s reverse-proxy-removal reminder — best-effort,
/// `None` if nothing's installed or the file's unreadable.
pub fn read_installed_args() -> Option<Vec<String>> {
    let contents = std::fs::read_to_string(UNIT_PATH).ok()?;
    let line = contents.lines().find(|l| l.trim_start().starts_with("ExecStart="))?;
    let value = line.trim_start().strip_prefix("ExecStart=")?;
    Some(split_quoted(value))
}

/// Splits `"tok1" "tok2" "tok3"` — exactly what `unit_file_contents` writes
/// — back into tokens.
fn split_quoted(s: &str) -> Vec<String> {
    s.split('"')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1) // odd indices are inside a pair of quotes
        .map(|(_, tok)| tok.to_string())
        .collect()
}

fn write_error(e: std::io::Error) -> String {
    format!("Could not write {UNIT_PATH}: {e} — try running this again with sudo.")
}

#[cfg(test)]
mod tests {
    use super::{split_quoted, unit_file_contents};
    use std::path::Path;

    #[test]
    fn renders_expected_unit_file() {
        let unit = unit_file_contents(
            Path::new("/usr/local/bin/littlepad-relay-server"),
            "0.0.0.0".parse().unwrap(),
            7878,
            "",
            "",
            "littlepad",
        );
        assert_eq!(
            unit,
            "[Unit]\n\
             Description=LittlePad share relay\n\
             After=network.target\n\
             \n\
             [Service]\n\
             ExecStart=\"/usr/local/bin/littlepad-relay-server\" \"--host\" \"0.0.0.0\" \"--port\" \"7878\"\n\
             Restart=on-failure\n\
             User=littlepad\n\
             \n\
             [Install]\n\
             WantedBy=multi-user.target\n"
        );
    }

    #[test]
    fn includes_base_path_and_log_file_when_set() {
        let unit = unit_file_contents(
            Path::new("/usr/local/bin/littlepad-relay-server"),
            "127.0.0.1".parse().unwrap(),
            9000,
            "/share",
            "/var/log/littlepad-relay-server.log",
            "root",
        );
        assert!(unit.contains(
            "ExecStart=\"/usr/local/bin/littlepad-relay-server\" \"--host\" \"127.0.0.1\" \"--port\" \"9000\" \
             \"--base-path\" \"/share\" \"--log-file\" \"/var/log/littlepad-relay-server.log\"\n"
        ));
        assert!(unit.contains("User=root\n"));
    }

    #[test]
    fn split_quoted_roundtrips_through_unit_file_contents() {
        let unit = unit_file_contents(
            Path::new("/usr/local/bin/littlepad-relay-server"),
            "127.0.0.1".parse().unwrap(),
            9000,
            "/share",
            "/var/log/littlepad-relay-server.log",
            "root",
        );
        let exec_start_line = unit.lines().find(|l| l.starts_with("ExecStart=")).unwrap();
        let value = exec_start_line.strip_prefix("ExecStart=").unwrap();
        assert_eq!(
            split_quoted(value),
            vec![
                "/usr/local/bin/littlepad-relay-server",
                "--host",
                "127.0.0.1",
                "--port",
                "9000",
                "--base-path",
                "/share",
                "--log-file",
                "/var/log/littlepad-relay-server.log",
            ]
        );
    }
}
