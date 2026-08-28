# Signalling service for p2p-files

`p2p-files.html` sends files straight from one browser to another. Before two
browsers can talk they have to swap a short description of how to reach each
other, and a browser cannot hand that to another browser on its own. This
service is the introduction, and nothing more.

It holds a WebRTC offer in memory under an eight-character code, hands that
offer to whoever quotes the code, takes back an answer, and then forgets the
whole thing. Sessions expire after five minutes. **File contents never pass
through this process.** They go browser to browser over your network.

No dependencies. Node 18 or newer.

## Running it

```sh
node p2p-signal/server.js
```

To try the whole tool from a single process, let it serve the pages too:

```sh
SERVE_DIR=. node p2p-signal/server.js
# then open http://localhost:8787/p2p-files.html
```

## Settings

All optional, all environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind. Leave on loopback when behind a reverse proxy |
| `BASE_PATH` | `/p2p-signal` | Path prefix the endpoints live under |
| `SESSION_TTL_MS` | `300000` | How long an unused code stays valid |
| `POLL_TIMEOUT_MS` | `25000` | How long a waiting request is held open before it returns empty |
| `MAX_SESSIONS` | `1000` | Cap on codes alive at once |
| `MAX_BODY_BYTES` | `65536` | Largest accepted request body |
| `CREATE_LIMIT` | `30` | Codes one address may create per window |
| `CREATE_WINDOW_MS` | `600000` | Length of that window |
| `TRUST_PROXY` | unset | Set to `1` to read the client address from `X-Forwarded-For` |
| `SERVE_DIR` | unset | Serve static files from this directory as well |

If you change `BASE_PATH`, change `SIGNAL_BASE` at the top of the script in
`p2p-files.html` to match.

## Behind nginx

```nginx
location /p2p-signal/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 60s;
}
```

Two details matter. `proxy_buffering off` lets the answer reach the waiting
browser the instant it arrives. `proxy_read_timeout` has to be comfortably
longer than `POLL_TIMEOUT_MS`, because the service deliberately holds a request
open for 25 seconds while it waits.

## As a systemd unit

```ini
[Unit]
Description=p2p-files signalling
After=network.target

[Service]
ExecStart=/usr/bin/node /srv/tools/p2p-signal/server.js
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=1
Restart=on-failure
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Liveness, plus how many codes are currently alive |
| `POST /sessions` | Body `{offer}`. Returns `{code, token, expiresInMs}` |
| `GET /sessions/:code` | Returns `{offer}` once. A second request gets 409 |
| `POST /sessions/:code/answer` | Body `{answer}` |
| `GET /sessions/:code/answer?token=` | Waits for the answer. 204 means ask again |

The `token` is returned only to whoever created the code, and only they can
collect the answer. Codes are drawn from a 32-character alphabet with the
easily confused letters removed, so there are about a trillion of them and they
live for five minutes.

## Tests

```sh
npm install playwright && npx playwright install chromium
node p2p-signal/test-e2e.js
```

This starts the service, drives two real browsers through the whole flow, and
checks the SHA-256 of what arrives against what was sent, in both directions,
including a 40 MB file. It also covers a bad code, a spent code, a code typed
by hand, and an unreachable service.
