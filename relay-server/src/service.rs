//! `install`/`uninstall` subcommands: register the relay as a system
//! service (systemd on Linux, launchd on macOS) so it survives a reboot
//! without anyone needing to start it by hand. Always installs system-wide
//! (needs root — the platform modules surface a clear "run with sudo"
//! error rather than checking permissions up front, keeping this dependency-
//! free), but the service itself runs as an ordinary user, not root — a
//! relay has no reason to run privileged, only *installing* it does.

use std::env;
use std::io::{self, Write};
use std::net::IpAddr;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::Path;
use std::process::Command;
use std::str::FromStr;

use crate::normalize_base_path;

#[cfg(target_os = "linux")]
#[path = "service_linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "service_macos.rs"]
mod platform;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[path = "service_unsupported.rs"]
mod platform;

const DEFAULT_LOG_FILE: &str = "/var/log/littlepad-relay-server.log";

pub fn install() -> Result<(), String> {
    platform::check_writable()?;

    println!("Installing the LittlePad share relay as a system service.");
    println!("(Ctrl+C to cancel at any point.)\n");

    let host: IpAddr = prompt_parsed("Host", "0.0.0.0");
    let port: u16 = prompt_parsed("Port", "7878");
    let base_path = normalize_base_path(&prompt("Base path (optional, e.g. /share)", ""));
    let user = prompt("Run the service as user", &default_user());
    let log_file = prompt("Log file path", DEFAULT_LOG_FILE);

    let exe = env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("Could not locate this executable: {e}"))?;

    println!("\nAbout to install:");
    println!("  Binary: {}", exe.display());
    println!("  Host:   {host}");
    println!("  Port:   {port}");
    if !base_path.is_empty() {
        println!("  Path:   {base_path}");
    }
    println!("  User:   {user}");
    println!("  Log:    {log_file}");
    if !prompt("Proceed?", "y").eq_ignore_ascii_case("y") {
        println!("Canceled — nothing was changed.");
        return Ok(());
    }
    println!();

    ensure_log_file(&log_file, &user)?;
    platform::install(&exe, host, port, &base_path, &log_file, &user)?;

    println!();
    print_reverse_proxy_snippet(
        port,
        &base_path,
        "If this will be reachable over the internet, put it behind a reverse proxy \
         with TLS (recommended — see SERVER.md). Here's the config to add — replace \
         `your.domain` and the certificate paths with your own:",
    );
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    platform::check_writable()?;

    if let Some(parsed) = platform::read_installed_args().and_then(|tokens| parse_service_args(&tokens)) {
        println!();
        print_reverse_proxy_snippet(
            parsed.port,
            &parsed.base_path,
            "If you added a reverse proxy config for this service, remove the \
             matching block now:",
        );
        if !parsed.log_file.is_empty() {
            println!(
                "(The log file at {} was left in place — delete it yourself if you don't need it.)\n",
                parsed.log_file
            );
        }
    }

    platform::uninstall()
}

/// Prompts with `label [default]: `, returning `default` verbatim on an
/// empty answer (just pressing Enter).
fn prompt(label: &str, default: &str) -> String {
    print!("{label} [{default}]: ");
    let _ = io::stdout().flush();
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    let trimmed = line.trim();
    if trimmed.is_empty() { default.to_string() } else { trimmed.to_string() }
}

/// Like `prompt`, but keeps asking until the answer parses as `T`.
fn prompt_parsed<T: FromStr>(label: &str, default: &str) -> T {
    loop {
        let value = prompt(label, default);
        match value.parse() {
            Ok(v) => return v,
            Err(_) => println!("  Not a valid value — try again."),
        }
    }
}

/// The user to run the service as, when the person installing it doesn't
/// pick one — the user who ran `sudo`, if any, otherwise whoever's logged
/// in right now (best-effort either way; the prompt always lets them
/// override it).
fn default_user() -> String {
    env::var("SUDO_USER")
        .or_else(|_| env::var("USER"))
        .unwrap_or_else(|_| "root".to_string())
}

/// Creates the log file if it doesn't exist yet, and hands it to `user` —
/// the service runs as that (non-root) user, but most log directories
/// (`/var/log`) only let root create new files in them, so this has to
/// happen now, while `install` still has root.
fn ensure_log_file(path: &str, user: &str) -> Result<(), String> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Could not create log file {path}: {e}"))?;
    run(&["chown", user, path])
}

/// Builds the `ExecStart`/`ProgramArguments`-style argument list every
/// platform module needs: the resolved binary path plus whatever of
/// `--host`/`--port`/`--base-path`/`--log-file` the run needs, shared here
/// so the two platform modules don't have to agree on this separately.
/// Only Linux/macOS call this (see `mod platform` above) — cfg-gated the
/// same way so it isn't flagged as dead code everywhere else (Windows).
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn service_args(
    exe: &Path,
    host: IpAddr,
    port: u16,
    base_path: &str,
    log_file: &str,
) -> Vec<String> {
    let mut args = vec![
        exe.display().to_string(),
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    if !base_path.is_empty() {
        args.push("--base-path".to_string());
        args.push(base_path.to_string());
    }
    if !log_file.is_empty() {
        args.push("--log-file".to_string());
        args.push(log_file.to_string());
    }
    args
}

/// What `parse_service_args` recovers from a previously-installed service's
/// argument list — everything `uninstall` needs to show a precise reminder.
struct ParsedServiceArgs {
    port: u16,
    base_path: String,
    log_file: String,
}

/// The inverse of `service_args`: pulls `--port`/`--base-path`/`--log-file`
/// back out of a flat argument list (order-independent, so it doesn't need
/// to assume `service_args`' exact layout). `None` only if `--port` is
/// missing or unparseable, which shouldn't happen for a file this tool
/// wrote itself.
fn parse_service_args(tokens: &[String]) -> Option<ParsedServiceArgs> {
    let mut port = None;
    let mut base_path = String::new();
    let mut log_file = String::new();
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i].as_str() {
            "--port" if i + 1 < tokens.len() => {
                port = tokens[i + 1].parse().ok();
                i += 2;
            }
            "--base-path" if i + 1 < tokens.len() => {
                base_path = tokens[i + 1].clone();
                i += 2;
            }
            "--log-file" if i + 1 < tokens.len() => {
                log_file = tokens[i + 1].clone();
                i += 2;
            }
            _ => i += 1,
        }
    }
    Some(ParsedServiceArgs { port: port?, base_path, log_file })
}

/// Prints the NGINX/Apache reverse-proxy config matching `port`/`base_path`
/// (always proxying to 127.0.0.1 — see SERVER.md's own guidance to bind the
/// relay there when it sits behind a proxy), under `heading`. Used both
/// right after `install` (what to add) and by `uninstall` (what to remove).
fn print_reverse_proxy_snippet(port: u16, base_path: &str, heading: &str) {
    let location = if base_path.is_empty() { "/".to_string() } else { format!("{base_path}/") };
    let http_target = format!("http://127.0.0.1:{port}{base_path}/");
    let ws_target = format!("ws://127.0.0.1:{port}{base_path}/");

    println!("{heading}\n");
    println!("NGINX (inside your `server {{}}` block):");
    println!("    location {location} {{");
    println!("        proxy_pass {http_target};");
    println!("        proxy_http_version 1.1;");
    println!("        proxy_set_header Upgrade $http_upgrade;");
    println!("        proxy_set_header Connection \"upgrade\";");
    println!("        proxy_set_header Host $host;");
    println!("        proxy_read_timeout 3600s;");
    println!("    }}");
    println!();
    println!("Apache (needs mod_proxy, mod_proxy_http, mod_proxy_wstunnel):");
    println!("    ProxyPass        {location} {ws_target}");
    println!("    ProxyPassReverse {location} {ws_target}");
    println!();
    println!("See SERVER.md's \"Deploying behind a reverse proxy\" section for the full");
    println!("server block, including TLS certificate setup.");
}

/// Checked before asking any interactive questions, so a permission problem
/// fails fast instead of after the user's answered every prompt: tries to
/// create (and immediately remove) a throwaway file in `dir`. No `libc`/
/// `nix` dependency needed just to ask "am I root" — attempting the actual
/// operation is simpler and just as reliable. Only Linux/macOS call this
/// (see `mod platform` above) — cfg-gated the same way so it isn't flagged
/// as dead code everywhere else (Windows).
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn check_dir_writable(dir: &Path) -> Result<(), String> {
    let marker = dir.join(".littlepad-relay-server-write-test");
    match std::fs::write(&marker, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&marker);
            Ok(())
        }
        Err(e) => Err(format!(
            "Can't write to {}: {e} — this needs root, try running it again with sudo.",
            dir.display()
        )),
    }
}

/// Runs `argv[0] argv[1..]`, surfacing a failure (non-zero exit or the
/// command not existing at all) as a plain error string.
pub(crate) fn run(argv: &[&str]) -> Result<(), String> {
    let status = Command::new(argv[0])
        .args(&argv[1..])
        .status()
        .map_err(|e| format!("failed to run `{}`: {e}", argv.join(" ")))?;
    if !status.success() {
        return Err(format!("`{}` exited with {status}", argv.join(" ")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_service_args;

    fn tok(s: &[&str]) -> Vec<String> {
        s.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn recovers_all_fields() {
        let args = tok(&[
            "/usr/local/bin/littlepad-relay-server",
            "--host",
            "0.0.0.0",
            "--port",
            "7878",
            "--base-path",
            "/share",
            "--log-file",
            "/var/log/littlepad-relay-server.log",
        ]);
        let parsed = parse_service_args(&args).unwrap();
        assert_eq!(parsed.port, 7878);
        assert_eq!(parsed.base_path, "/share");
        assert_eq!(parsed.log_file, "/var/log/littlepad-relay-server.log");
    }

    #[test]
    fn missing_optional_fields_default_empty() {
        let args = tok(&["/usr/local/bin/littlepad-relay-server", "--host", "0.0.0.0", "--port", "7878"]);
        let parsed = parse_service_args(&args).unwrap();
        assert_eq!(parsed.port, 7878);
        assert_eq!(parsed.base_path, "");
        assert_eq!(parsed.log_file, "");
    }

    #[test]
    fn missing_port_returns_none() {
        let args = tok(&["/usr/local/bin/littlepad-relay-server", "--host", "0.0.0.0"]);
        assert!(parse_service_args(&args).is_none());
    }
}
