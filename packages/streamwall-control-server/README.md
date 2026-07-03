# streamwall-control-server

Backend for multiplayer Streamwall. It multiplexes the Streamwall app and web
control clients over WebSockets and serves the built control client.

## Running

```
npm -w streamwall-control-server start
```

## Configuration

All configuration is provided via environment variables.

### Server

| Variable                      | Default                 | Description                                               |
| ----------------------------- | ----------------------- | --------------------------------------------------------- |
| `STREAMWALL_CONTROL_URL`      | `http://localhost:3000` | Public base URL; its scheme selects http/https behaviour. |
| `STREAMWALL_CONTROL_HOSTNAME` | host from base URL      | Interface to bind.                                        |
| `STREAMWALL_CONTROL_PORT`     | port from base URL      | Port to bind.                                             |
| `STREAMWALL_CONTROL_STATIC`   | bundled client `dist`   | Directory of static client assets to serve.               |
| `DB_PATH`                     | `storage.json`          | lowdb storage file.                                       |

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
