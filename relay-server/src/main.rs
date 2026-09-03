//! LittlePad share relay: a stateless WebSocket relay for real-time file
//! sharing between LittlePad instances.
//!
//! It never sees document content or passwords in the clear (those are
//! encrypted client-side — see `src-tauri/src/share_crypto.rs`) and never
//! writes anything to disk: every instance is grouped into a "tenant" by the
//! API key it sends via the `Sec-WebSocket-Protocol` handshake header (see
//! `ws::extract_api_key`), and all state lives in memory only for as long as
//! at least one instance in that tenant is connected.

mod protocol;
mod service;
mod state;
mod ws;

use std::net::{IpAddr, SocketAddr};

use axum::Router;
use axum::routing::get;
use clap::{Parser, Subcommand};

/// LittlePad share relay server.
#[derive(Parser, Debug)]
#[command(name = "littlepad-relay-server", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    run: RunArgs,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Install as a system service (systemd on Linux, launchd on macOS) —
    /// asks for host/port/etc. interactively. Always system-wide, so this
    /// needs root (Linux: run with sudo; macOS: sudo too).
    Install,
    /// Stop and remove a service previously set up with `install`.
    Uninstall,
}

#[derive(clap::Args, Debug, Clone)]
pub struct RunArgs {
    /// Address to listen on.
    #[arg(long, default_value = "0.0.0.0")]
    pub host: IpAddr,

    /// Port to listen on.
    #[arg(long, default_value_t = 7878)]
    pub port: u16,

    /// Optional base path to mount the relay under, e.g. "/share" to serve
    /// it at ".../share/ws" instead of "/ws" — lets it share a domain/port
    /// with other services behind a reverse proxy, at a path of your choice,
    /// instead of needing a dedicated subdomain. A leading "/" is added if
    /// missing; a trailing one is trimmed. See SERVER.md.
    #[arg(long, default_value = "")]
    pub base_path: String,

    /// Write logs to this file instead of stdout (appending). Meant for
    /// running as a service (see `install`, which asks for this and sets
    /// it up); a plain interactive run has stdout to watch, so this is
    /// left empty by default.
    #[arg(long, default_value = "")]
    pub log_file: String,
}

/// Normalizes `raw` into either "" (no base path) or a
/// "/leading/no-trailing-slash" form.
pub fn normalize_base_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Install) => {
            if let Err(e) = service::install() {
                eprintln!("Install failed: {e}");
                std::process::exit(1);
            }
        }
        Some(Command::Uninstall) => {
            if let Err(e) = service::uninstall() {
                eprintln!("Uninstall failed: {e}");
                std::process::exit(1);
            }
        }
        None => run_server(cli.run).await,
    }
}

async fn run_server(args: RunArgs) {
    let env_filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "littlepad_relay_server=info".into())
    };
    if args.log_file.is_empty() {
        tracing_subscriber::fmt().with_env_filter(env_filter()).init();
    } else {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&args.log_file)
            .unwrap_or_else(|e| panic!("could not open log file {}: {e}", args.log_file));
        // with_ansi(false): a plain log file, not a terminal — no color codes.
        tracing_subscriber::fmt()
            .with_env_filter(env_filter())
            .with_writer(std::sync::Mutex::new(file))
            .with_ansi(false)
            .init();
    }

    let state = state::new_state();

    let base_path = normalize_base_path(&args.base_path);
    let ws_path = format!("{base_path}/ws");
    let app = Router::new()
        .route(&ws_path, get(ws::ws_handler))
        .with_state(state);

    let addr = SocketAddr::new(args.host, args.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    tracing::info!(%addr, path = %ws_path, "relay listening");

    // with_connect_info: lets ws::ws_handler take a ConnectInfo<SocketAddr>
    // extractor, so it can log who's connecting.
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("relay server stopped unexpectedly");
}

#[cfg(test)]
mod tests {
    use super::normalize_base_path;

    #[test]
    fn empty_stays_empty() {
        assert_eq!(normalize_base_path(""), "");
        assert_eq!(normalize_base_path("   "), "");
        assert_eq!(normalize_base_path("/"), "");
    }

    #[test]
    fn adds_leading_slash() {
        assert_eq!(normalize_base_path("share"), "/share");
    }

    #[test]
    fn trims_trailing_slash() {
        assert_eq!(normalize_base_path("/share/"), "/share");
        assert_eq!(normalize_base_path("share///"), "/share");
    }

    #[test]
    fn keeps_nested_paths() {
        assert_eq!(normalize_base_path("/new/path"), "/new/path");
        assert_eq!(normalize_base_path("new/path/"), "/new/path");
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(normalize_base_path("  /share  "), "/share");
    }
}
