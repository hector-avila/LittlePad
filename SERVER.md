# Share files — real-time file sharing

LittlePad can share a file between two or more running instances in real
time: everyone with it open sees everyone else's edits as they happen. This
document covers the whole feature — how it works, how to run the relay
server it depends on, and how to expose that server through a reverse
proxy (including at a custom URL path, so it can share a domain with other
services instead of needing its own subdomain).

## How it works, in short

- **You run the relay yourself.** `relay-server/` builds to a single
  binary, `littlepad-relay-server`, with no dependencies beyond the network
  — no database, nothing written to disk. Every LittlePad instance that
  should be able to share files with each other points at the same relay
  server address in ⚙ Settings → Share.
- **The relay never sees file content or passwords.** It only relays
  already-encrypted bytes between instances, plus the minimal metadata
  needed to list shares (a filename, and whether a share is read-only).
  Everything else — the document text, the password you set when sharing a
  file — is encrypted on your machine before it's sent, and only decrypted
  on the machine that receives it.
- **Two secrets, two jobs.** The **Share API key** (set once in Settings)
  is a shared secret every instance in your group must have identically —
  it's how the relay tells your instances apart from anyone else's on the
  same server ("tenants"), and it never proves useful on its own. The
  **document password** you choose each time you share a file is what
  actually unlocks that file's content for anyone joining it. Both feed
  into the encryption key together (Argon2id → AES-256-GCM), so knowing
  only one of the two gets you nothing.
- **A share is ephemeral.** Nothing about who's sharing what survives the
  relay process restarting, or every participant disconnecting — there's
  no database to run, back up, or clean up.

## Running the relay server

Build it from source (see [BUILDING.md](BUILDING.md)) or download the
binary attached to a [Release](../../releases) — Linux x86_64 and arm64
builds are published there; Windows/macOS users building it themselves get
one too via `scripts/build-windows.bat` / `scripts/build-macos.sh`.

```bash
littlepad-relay-server [--host 0.0.0.0] [--port 7878] [--base-path /some/path]
```

| Flag          | Default   | Meaning                                                             |
| ------------- | --------- | -------------------------------------------------------------------- |
| `--host`      | `0.0.0.0` | Address to listen on.                                                 |
| `--port`      | `7878`    | Port to listen on.                                                    |
| `--base-path` | *(none)*  | Mount the relay under a URL path instead of the root — see below.     |
| `--log-file`  | *(none)*  | Append logs to this file instead of stdout — see "Logs" below.        |

That's the entire configuration surface — there's no config file, no
environment variables to set, nothing to persist.

## Logs

Every connect/disconnect is logged with the instance's IP address (from
`X-Forwarded-For`/`X-Real-IP` if the relay is behind a reverse proxy — see
below — otherwise the raw TCP peer address; either way it's for
troubleshooting only, never used for access control). Content and passwords
are never logged, obviously — the relay never has them to begin with.

By default logs go to stdout. Pass `--log-file /path/to/file` to append
them to a file instead (created if missing) — `install` below asks for this
and wires it up for you.

## Running it as a system service

So the relay survives a reboot without anyone needing to start it by hand:

```bash
sudo littlepad-relay-server install    # Linux (systemd) or macOS (launchd)
```

Asks a few questions interactively — host, port, base path, which system
user to actually run the process as (defaults to whoever you `sudo` as; the
*installer* needs root, the service itself doesn't run as root), and where
to write its log file — shows a summary, and only writes/registers anything
once you confirm. Once installed, it also prints the matching NGINX/Apache
reverse-proxy config for what you just set up (see the section below) —
copy it in if you're putting this behind a proxy.

```bash
sudo littlepad-relay-server uninstall  # stops it and removes what install added
```

Prints the same reverse-proxy config first, as a reminder of what to remove
from your NGINX/Apache config — then stops and removes the service. The log
file itself is left in place either way; delete it yourself if you don't
need it.

Both need root (`sudo`) since they write into `/etc/systemd/system/` (Linux)
or `/Library/LaunchDaemons/` (macOS) and register with the system's service
manager — always system-wide, not a per-user service. If you'd rather manage
this yourself (a different init system, a container, etc.), just run the
plain binary directly per the section above, or write your own unit file
using `littlepad-relay-server install`'s output as a starting point.

Not supported yet on Windows — run it directly there (e.g. via Task
Scheduler) for now.

## Custom paths (no subdomain needed)

By default the relay answers WebSocket connections at `/ws`. Pass
`--base-path` to mount it somewhere else instead, e.g.:

```bash
littlepad-relay-server --base-path /share
```

now answers at `/share/ws`. This is what lets you publish it as
`https://my.domain/share` (or any other path you like) on a domain that
also hosts other things, instead of needing a dedicated
`share.my.domain`. `--base-path` accepts the path with or without a
leading/trailing slash (`share`, `/share`, `/share/` all normalize the
same way); nested paths work too (`--base-path /new/path` →
`/new/path/ws`).

LittlePad's own Settings → Share has a matching **Path** field — set it to
the same value (`/share`, `/new/path`, …) so the app connects to the right
place. Leave both the server's `--base-path` and the app's Path field
empty for the original `/ws`-at-the-root behavior.

## Configuring LittlePad (Settings → Share)

Two fields:

| Field       | Value                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Server URL  | the relay's address, e.g. `wss://my.domain/share` or `ws://192.168.1.10:7878` — a missing scheme defaults to secure (`wss://`); any path is kept as typed, matching the relay's `--base-path` (see above) |
| API key     | the shared tenant secret — identical on every instance in your group     |

A bare `host:port` or `host/path` (no scheme) is accepted too and treated
as `wss://` — use `ws://`/`http://` explicitly for a plain, unencrypted
connection (fine on a trusted local network; not recommended over the
internet).

Every instance that should be able to see and open each other's shared
files needs the same Server URL and API key.

## Deploying behind a reverse proxy (recommended)

Running the relay directly on an open port works for a local network, but
anything reachable over the internet should sit behind a reverse proxy
terminating TLS — a plain `ws://` connection leaks the API key (sent as the
`Sec-WebSocket-Protocol` handshake header) to anyone on the network path.
Both examples below serve the relay at `https://my.domain/new/path`,
demonstrating the custom-path support from the previous section; drop the
path segment everywhere (proxy config and LittlePad's Path field alike) if
you'd rather serve it at the domain root.

Start the relay itself listening only on localhost, matching the path:

```bash
littlepad-relay-server --host 127.0.0.1 --port 7878 --base-path /new/path
```

### NGINX

```nginx
server {
    listen 443 ssl http2;
    server_name my.domain;

    ssl_certificate     /etc/letsencrypt/live/my.domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/my.domain/privkey.pem;

    location /new/path/ {
        proxy_pass http://127.0.0.1:7878/new/path/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        # WebSocket connections are long-lived — don't let nginx time them out.
        proxy_read_timeout 3600s;
    }
}
```

### Apache

Requires `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, and `mod_ssl`
(`a2enmod proxy proxy_http proxy_wstunnel ssl` on Debian/Ubuntu). Apache
auto-detects the WebSocket upgrade from the `ws://` target scheme — no
extra rewrite rules needed:

```apache
<VirtualHost *:443>
    ServerName my.domain

    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/my.domain/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/my.domain/privkey.pem

    ProxyPreserveHost On
    ProxyPass        /new/path/ ws://127.0.0.1:7878/new/path/
    ProxyPassReverse /new/path/ ws://127.0.0.1:7878/new/path/
</VirtualHost>
```

With either of the above, every instance's Settings → Share → Server URL
would be `wss://my.domain/new/path`.

## Sharing a file, from the app's side

- The status bar of any open tab has a **Share** button: click it, set a
  password, and choose whether other people can edit it or only view it.
- Other instances connected to the same relay with the same API key get a
  notification offering to open it — entering the password decrypts it
  locally; a wrong password just fails to decrypt (there's no separate
  server-side check to get wrong).
- A shared file opens as an in-memory tab, the same as any unsaved one. If
  a participant explicitly saves it to a real path ("Save as"), that
  instance keeps that file in two-way sync with the shared session from
  then on.
- Settings → Share also lists every file currently shared on the server —
  yours and everyone else's — with an "Open…" action for the others' and a
  "Stop sharing" action for your own.
- Word wrap and text type (the status bar's Wrap toggle and language
  dropdown) are synced in real time across everyone viewing a shared file —
  only the person who shared it can change either; the status bar controls
  are disabled for everyone else, whether or not they can edit the content.
