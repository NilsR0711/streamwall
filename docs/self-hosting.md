# Self-hosting `streamwall-control-server`

This walks through putting `streamwall-control-server` behind your own
domain with TLS, so you can control the wall from a phone or any other
device — not just the machine the desktop app runs on.

This covers the control server only. The composited wall video itself is
always rendered locally by the Electron app on the machine running it;
remote _viewing_ of that output is a separate, unrelated feature (not
covered here).

## Prerequisites

- A domain (or subdomain) with an A/AAAA record pointing at the host you're
  deploying to.
- Ports **80** and **443** reachable from the internet on that host — Caddy
  needs port 80 for the ACME HTTP-01 challenge, and port 443 to serve TLS.
- [Docker](https://docs.docker.com/get-docker/) and the Docker Compose
  plugin (`docker compose version`).

## Quick start

```sh
git clone https://github.com/NilsR0711/streamwall.git
cd streamwall/deploy
cp .env.example .env
# edit .env: set STREAMWALL_DOMAIN, STREAMWALL_ACME_EMAIL, and
# STREAMWALL_CONTROL_URL to match your domain (see comments in the file)
docker compose up -d --build
```

This builds [`packages/streamwall-control-server/Dockerfile`](../packages/streamwall-control-server/Dockerfile)
and starts two containers, wired together by
[`deploy/docker-compose.yml`](../deploy/docker-compose.yml):

- **`control-server`** — the Fastify backend, not published to the host
  directly (only reachable from `caddy`, over the compose-internal network).
- **`caddy`** — a [Caddy](https://caddyserver.com/) reverse proxy on ports
  80/443 that automatically requests and renews a Let's Encrypt certificate
  for `STREAMWALL_DOMAIN` and forwards traffic to `control-server`. Caddy was
  chosen over nginx/Traefik for this specifically because it needs no manual
  ACME/cert configuration — see [`deploy/Caddyfile`](../deploy/Caddyfile).

Auth-token storage (`storage.json`) lives on the `control-server-data` named
volume, so it survives container restarts/rebuilds; back that volume up like
you would any other persistent data.

## First run

Watch the logs for the two links the server prints once, on its very first
start:

```sh
docker compose logs control-server
```

```
🔌 Streamwall uplink (shown once — save it now): wss://wall.example.com/streamwall/<id>/ws?token=<secret>
🔑 Admin invite: https://wall.example.com/invite/<id>#token=<secret>
```

Both are bearer credentials — treat them like passwords. If you lose the
uplink link, or the admin invite is exposed, they're currently rotated by
clearing the corresponding entry from `storage.json` and restarting the
server (see the comment above `logBootstrap` in
[`packages/streamwall-control-server/src/index.ts`](../packages/streamwall-control-server/src/index.ts)
for the exact key); there's no in-app rotate action yet.

## Connecting the desktop app (uplink)

On the machine running the Electron app, put the uplink link in your config
file (see `example.config.toml`):

```toml
[control]
endpoint = "wss://wall.example.com/streamwall/<id>/ws?token=<secret>"
```

or pass it as `--control.endpoint=...` on the command line. The endpoint
**must** use `wss://` — Streamwall refuses to connect over `ws://` to
anything other than a loopback host, so this only works once TLS (via Caddy,
here) is actually in front of the server.

## Connecting a web control client (e.g. from a phone)

Open `https://wall.example.com/invite/<id>#token=<secret>` (the admin invite
link) in a browser on any device. From there, an admin can generate invite
links for the **operator** and **monitor** roles for other people to sign in
with — see
[`packages/streamwall-control-server/README.md`](../packages/streamwall-control-server/README.md#roles)
for what each role can do.

## Configuration reference

[`deploy/.env.example`](../deploy/.env.example) documents the variables this
compose stack needs (domain, ACME email, public URL, port). For the full set
of environment variables the server itself understands — including storage
location and rate-limit tuning — see
[`packages/streamwall-control-server/README.md`](../packages/streamwall-control-server/README.md#configuration).

One default in that file is important to get right behind Caddy:
`STREAMWALL_CONTROL_URL` should be a bare `https://your-domain` with **no
port**, and `STREAMWALL_CONTROL_PORT` must then be set explicitly (the
compose file already does this). The server does not fill in port 443 when
`STREAMWALL_CONTROL_URL` omits one, so an explicit `STREAMWALL_CONTROL_PORT`
is required — the `.env.example` comments explain why.

## Operational security notes

- **TLS is mandatory**, not optional: the desktop app enforces `wss://` for
  any non-loopback endpoint, and the compose stack only exposes the server
  through Caddy's TLS listener. There is no supported way to run this
  self-hosting stack without TLS in front of it.
- **Keep the admin invite link private.** Anyone with it gets full admin
  access, including the ability to mint further invites.
- **Rate limits are already enforced** by the server itself (per-IP HTTP
  limits, a stricter limit on the auth route, and per-connection WebSocket
  message caps — see the server README for the exact numbers and how to tune
  them).
- **Known limitation:** the server does not currently parse
  `X-Forwarded-For`, so behind this (or any) reverse proxy, its per-IP rate
  limiting sees every client as the proxy's own IP rather than each visitor's
  real address. In practice this means the rate limits apply collectively
  across all your operators/monitors rather than individually — it does not
  disable rate limiting, but it is coarser than running the server exposed
  directly. Tracked as a follow-up; tighten `STREAMWALL_RATE_LIMIT_MAX` /
  `STREAMWALL_WS_MSG_RATE` accordingly if you expect many concurrent users
  behind the proxy.

## Updating

```sh
cd streamwall
git pull
cd deploy
docker compose up -d --build
```

The `control-server-data` volume (and its `storage.json` inside) is
untouched by rebuilds.

## Troubleshooting

- **Caddy never gets a certificate / logs show ACME errors** — confirm
  `STREAMWALL_DOMAIN` in `.env` matches a DNS record that already resolves to
  this host, and that ports 80 and 443 are actually reachable from the
  internet (not blocked by a firewall or cloud security group). Check
  `docker compose logs caddy`.
- **Desktop app refuses to connect** — the endpoint must be `wss://`, not
  `ws://`; see [Connecting the desktop app](#connecting-the-desktop-app-uplink)
  above.
- **Caddy returns a 502** — confirm `STREAMWALL_CONTROL_PORT` in `.env`
  matches the port Caddy proxies to in `deploy/Caddyfile`
  (`reverse_proxy control-server:<port>`, default `3000` on both sides), and
  check `docker compose logs control-server` for a startup error.
