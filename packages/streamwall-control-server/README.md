# streamwall-control-server

Backend for multiplayer Streamwall. It multiplexes the Streamwall app and web
control clients over WebSockets and serves the built control client.

## Running

```
npm -w streamwall-control-server start
```

## Roles

Invites and sessions are tied to one of three roles, checked on every command
(see `roleCan` in `streamwall-shared`):

| Role       | Can do                                                             |
| ---------- | ------------------------------------------------------------------ |
| `admin`    | Everything, including creating and deleting invites/tokens.        |
| `operator` | Control the grid and streams (listen, blur, rotate, resize, etc.). |
| `monitor`  | Read-only, except toggling blur/censor on a stream.                |

An admin invite link is printed to the console on every server start (see
below). Once signed in, admins can create invite links for the other roles
from the web control client.

## Configuration

All configuration is provided via environment variables.

### Server

| Variable                      | Default                                     | Description                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STREAMWALL_CONTROL_URL`      | `http://localhost:3000`                     | Public base URL; its scheme selects http/https behaviour.                                                                                                                                                          |
| `STREAMWALL_CONTROL_HOSTNAME` | host from base URL                          | Interface to bind.                                                                                                                                                                                                 |
| `STREAMWALL_CONTROL_PORT`     | port from base URL                          | Port to bind.                                                                                                                                                                                                      |
| `STREAMWALL_CONTROL_STATIC`   | bundled client `dist`                       | Directory of static client assets to serve.                                                                                                                                                                        |
| `DB_PATH`                     | `~/.streamwall-control-server/storage.json` | lowdb storage file (auth tokens). Anchored to the home directory, not the working directory, so it stays put regardless of where the server is started from; missing parent directories are created automatically. |

### Security / abuse protection

Auth-bearing endpoints run an expensive `scrypt` derivation per request, so the
server applies per-IP rate limiting (via `@fastify/rate-limit`), sends hardened
response headers (via `@fastify/helmet`), and caps the inbound message rate of
each WebSocket connection. The limits are tunable:

| Variable                         | Default    | Description                                                      |
| -------------------------------- | ---------- | ---------------------------------------------------------------- |
| `STREAMWALL_RATE_LIMIT_MAX`      | `100`      | Max HTTP requests per IP per window (global).                    |
| `STREAMWALL_AUTH_RATE_LIMIT_MAX` | `10`       | Stricter max for the `/invite/:id` auth route per IP per window. |
| `STREAMWALL_RATE_LIMIT_WINDOW`   | `1 minute` | Rate-limit window (any `@fastify/rate-limit` time value).        |
| `STREAMWALL_WS_MSG_RATE`         | `100`      | Sustained inbound WebSocket messages per second, per connection. |
| `STREAMWALL_WS_MSG_BURST`        | `1000`     | Burst allowance of inbound WebSocket messages, per connection.   |

A WebSocket connection that exceeds its message budget is closed with code
`1008` (policy violation); clients reconnect and resync automatically.

The Content-Security-Policy is kept compatible with the served control client.
`upgrade-insecure-requests` is only emitted when `STREAMWALL_CONTROL_URL` uses
`https`, so the plain-`http` local setup keeps working over `ws://`.

### Telemetry

Crash reporting to [Sentry](https://sentry.io) (via `@sentry/node`) is
opt-in and off by default:

| Variable                    | Default | Description                                       |
| --------------------------- | ------- | ------------------------------------------------- |
| `STREAMWALL_SENTRY_ENABLED` | `false` | Set to `true` to enable crash reporting.          |
| `STREAMWALL_SENTRY_DSN`     | none    | Your Sentry project's DSN. Required when enabled. |

Unlike the Electron app (`packages/streamwall`), which reports to a DSN the
maintainer bundles for their own official builds, this server is meant to be
self-hosted by independent operators. There is no default DSN to ship — set
`STREAMWALL_SENTRY_ENABLED=true` together with your own project's
`STREAMWALL_SENTRY_DSN` to send this server's uncaught exceptions and 5xx
request errors there. If enabled without a DSN, the server logs a warning at
startup and continues running with reporting disabled.

## Deployment

There is no separate compile step: the source targets Node 22's native
TypeScript support (type-only syntax plus explicit `.ts` import specifiers),
so it runs directly from `src/`. To run in production:

```
npm ci
npm -w streamwall-control-client run build
node packages/streamwall-control-server/src/index.ts
```

The first two commands install the workspace and build the static web control
client that this server serves at `/`; the third starts the server itself
(equivalent to `npm run start:server` at the repo root, which chains all
three).

Set at least `STREAMWALL_CONTROL_URL` to the server's public address (its
scheme controls secure-cookie and CSP behaviour — see above) and `DB_PATH` to
a path on persistent storage, e.g. under a mounted volume or a directory
included in your backup strategy. A minimal `systemd` unit:

```ini
[Service]
ExecStart=/usr/bin/node /opt/streamwall/packages/streamwall-control-server/src/index.ts
Environment=STREAMWALL_CONTROL_URL=https://control.example.com
Environment=DB_PATH=/var/lib/streamwall-control-server/storage.json
Restart=on-failure
```

`WorkingDirectory` is deliberately left unset above: the default `DB_PATH`
no longer depends on it (see the configuration table), but an explicit
`DB_PATH` is still recommended in production so the storage location is
obvious and easy to back up.

> [!WARNING]
> Never run the server with `NODE_ENV=test` set. lowdb's Node preset treats
> that value as a signal to use an in-memory adapter instead of the file on
> disk, so auth tokens would silently stop persisting across restarts.
