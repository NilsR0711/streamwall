# Self-hosting the control server

Run `streamwall-control-server` on a VPS or home server with **HTTPS**, then point the desktop Streamwall app and browser operators at your domain.

This is **control and state only**. The composited wall video still renders on the machine running the Electron app. Phones and remote browsers can rearrange the grid; they do not receive the wall video stream.

## Prerequisites

- A domain name with **A/AAAA** records pointing at the host
- Ports **80** and **443** open to the host (Let's Encrypt + HTTPS)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- Streamwall desktop app on the machine that displays the wall

## Quick start

```bash
cd deploy
cp .env.example .env
# edit STREAMWALL_DOMAIN and STREAMWALL_CONTROL_URL
docker compose up -d --build
```

Watch control-server logs for the **admin invite** URL (printed on every start):

```bash
docker compose logs -f control
```

Open that invite once in a browser (or copy the path onto your domain) to create an admin session. Keep invite links private.

## What the stack does

| Service   | Role |
|-----------|------|
| `control` | Node control server + static control UI. Listens on container port 3000 only. |
| `caddy`   | Terminates TLS, reverse-proxies to `control`. |

Important env (see `.env.example` and the [control-server README](../packages/streamwall-control-server/README.md)):

| Variable | Why |
|----------|-----|
| `STREAMWALL_CONTROL_URL` | Public `https://…` URL; drives secure cookies and CSP. |
| `STREAMWALL_TRUST_PROXY` | Set `true` in compose so per-IP rate limits use real client IPs behind Caddy. **Do not** enable if the process is exposed directly to the internet. |
| `DB_PATH` | Auth tokens live on the `control-data` volume (`/data/storage.json`). |

## Connect the desktop app (uplink)

1. Start the control stack and obtain an admin session (invite link).
2. In the control UI, create a **Streamwall** (uplink) token if the server printed one, or use the uplink endpoint the server logs at bootstrap.
3. On the wall PC, set the control uplink in config (see root `example.config.toml`):

```toml
[control]
# Use wss:// against your public domain. The exact path and token are printed
# by the control server when the Streamwall uplink credential is created.
endpoint = "wss://wall.example.com/streamwall/<id>/ws"
```

The app injects the uplink secret as an `Authorization` header (not a query string). Prefer `wss://` whenever `STREAMWALL_CONTROL_URL` is `https://`.

4. Restart or reload the desktop app so it connects. Operators can then open `https://wall.example.com` from another device.

## Security notes

- **TLS required** for real deployments — use the Caddy stack (or equivalent).
- Treat **admin invite links** like passwords; anyone with a link can mint a session for that role.
- Rate limits and Helmet headers are already on; with `STREAMWALL_TRUST_PROXY=true`, limits are per client behind Caddy.
- The control server does **not** stream wall video. Compromising control still lets an operator change layout and sources on the wall machine — lock roles accordingly (`admin` / `operator` / `monitor`).

## Local dry-run without TLS

For a quick smoke test on one machine (no domain):

```bash
npm ci
npm -w streamwall-control-client run build
STREAMWALL_CONTROL_URL=http://localhost:3000 \
STREAMWALL_CONTROL_HOSTNAME=127.0.0.1 \
STREAMWALL_CONTROL_PORT=3000 \
npm -w streamwall-control-server start
```

Do not use `STREAMWALL_TRUST_PROXY=true` on a port bound to the public internet without a trusted reverse proxy in front.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Caddy fails ACME | DNS points here; 80/443 free; domain matches `.env` |
| Cookies / login odd | `STREAMWALL_CONTROL_URL` scheme and host match the browser URL |
| All clients share one rate-limit bucket | `STREAMWALL_TRUST_PROXY=true` and only Caddy can reach port 3000 |
| Desktop app won't uplink | `wss://` URL, token, and server logs for refused uplink |
