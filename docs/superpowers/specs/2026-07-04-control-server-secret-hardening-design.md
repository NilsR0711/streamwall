# Design: Control-Server Secret Hardening (Issue #4)

**Status:** approved
**Issue:** [#4](https://github.com/NilsR0711/streamwall-modernization/issues/4) — _Security: stop persisting/logging secrets in clear; move WS tokens out of the URL query string_
**Severity:** medium · **Labels:** control-server, security

## Problem

Three related weaknesses in `streamwall-control-server` expose long-lived,
admin-capable secrets:

1. **Plaintext uplink secret at rest.** `StoredData.streamwallToken` persists the
   Streamwall uplink token's plaintext `secret` to `storage.json`
   (`storage.ts`), while every other token stores only a scrypt hash
   (`auth.ts`). Anyone with read access to `storage.json` recovers the
   admin-role uplink secret.
2. **Secrets printed on every startup.** `initialInviteCodes` prints the uplink
   endpoint (with secret) and a freshly minted admin invite (with secret) to
   stdout on **every** boot (`index.ts`). Captured logs leak both.
3. **Secrets in the URL query string.** The uplink WebSocket authenticates via
   `/streamwall/:id/ws?token=<secret>` and invites via
   `/invite/:id?token=<secret>` (`roles.ts` `inviteLink`, `index.ts`). Query
   strings land in access logs, browser history, and the `Referer` header.

The browser control client (`/client/ws`) already authenticates via an
`httpOnly` session cookie and needs no change.

## Approach & Decisions

| Area             | Decision                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invite transport | **URL fragment + same-origin POST exchange.** Fragments never reach the server, so the secret stays out of access logs and `Referer`.                                                                              |
| Uplink config    | **`Authorization: Bearer <tokenId>:<secret>` header, backward compatible.** A legacy `control.endpoint` that still embeds `?token=` is parsed, its token moved to the header, and a deprecation warning is logged. |
| Admin invite     | **Hash-only, print-once.** Minted + logged only when no admin can currently get in; `STREAMWALL_CONTROL_NEW_ADMIN_INVITE=1` forces a fresh invite for recovery.                                                    |
| Test harness     | **`node:test` + `tsx`.** Zero new runtime/dev dependencies, fitting a security PR.                                                                                                                                 |

## Components

### 1. Storage — hash-only reference (P1)

`StoredData.streamwallToken` becomes `{ tokenId: string } | null`. The scrypt
hash already lives in `auth.tokens`, so the reference alone is enough to know a
token exists. A migration on load strips any legacy `secret` field and rewrites
`storage.json`, purging existing plaintext secrets from disk.

### 2. Uplink WebSocket via Authorization header (P3-uplink)

- **Server:** route `/streamwall/ws` (no `:id`). Reads
  `Authorization: Bearer <tokenId>:<secret>`, splits on the first `:`, validates
  via `auth.validateToken` requiring `kind === 'streamwall'`. The legacy
  query-string route is removed, eliminating the server-side logging vector.
- **Streamwall app:** `control.endpoint` carries no token; new `control.token`
  holds `<tokenId>:<secret>`. The header is injected through a `ws.WebSocket`
  subclass passed to `ReconnectingWebSocket`. A pure helper
  `resolveControlCredentials({ endpoint, token })` normalizes config and handles
  the legacy `?token=` form (extract → header → warn). This helper is unit
  tested.

### 3. Invite via fragment + POST exchange (P3-invite)

- `inviteLink` returns `…/invite/<id>#<secret>`.
- `GET /invite/:id` serves a minimal self-contained HTML page (inline script
  behind a per-request CSP nonce, `Referrer-Policy: no-referrer`). The script
  reads `location.hash`, `fetch`-POSTs `{ secret }` to `/invite/:id`, then
  `location.replace('/')`. `<noscript>` explains JS is required (the control UI
  is JS-only anyway). **No secret ever reaches the server via the URL.**
- `POST /invite/:id` requires a same-origin `Origin` header, validates the
  secret (`kind === 'invite'`), sets the session cookie exactly as before,
  deletes the invite, and returns `204`. Bad/again-consumed → `403`.

### 4. Startup logging (P1 log side / P2)

`initialInviteCodes`:

- Uplink: minted + its endpoint/token printed **once** at creation. Restarts
  print the endpoint without a secret (the plaintext no longer exists).
- Admin invite: created + logged only when there is **no admin session and no
  open admin invite**. `STREAMWALL_CONTROL_NEW_ADMIN_INVITE=1` deletes existing
  admin invites and mints/prints a fresh one for lockout recovery. Restarts
  otherwise print nothing secret.

### 5. Testability refactor (enabling, minimal)

- Export `initApp` and `initialInviteCodes`; guard the module-level
  `runServer(...)` behind an `import.meta`/`process.argv[1]` main check so
  importing for tests does not start a server.
- `loadStorage(dbPath?)` and `initApp({ …, db? })` accept overrides so tests run
  against a temp-file database.

## Test Strategy (TDD)

- **Unit:** `auth.getStoredData()` never contains a plaintext secret; storage
  migration removes a legacy `secret`; `inviteLink` emits the fragment form;
  `resolveControlCredentials` maps new + legacy config to a header credential.
- **Integration (`app.inject`):** `GET /invite/:id` returns HTML with no secret
  and `Referrer-Policy: no-referrer`; `POST /invite/:id` sets the cookie and
  `204`, a consumed invite → `403`, a cross-origin POST → rejected.
- **Integration (real `ws` client, `listen({ port: 0 })`):** uplink accepts a
  valid `Authorization` header and rejects a missing/invalid one.

## Risks & Breaking Changes

- **Uplink config format changes.** Mitigated by backward-compatible parsing of
  the legacy `?token=` endpoint plus a deprecation warning.
- **Invite acceptance now requires JavaScript.** Acceptable: the control UI is a
  JS SPA. `<noscript>` communicates the requirement.
- **Admin invite no longer regenerates each boot.** Intentional; recovery via
  `STREAMWALL_CONTROL_NEW_ADMIN_INVITE=1`.
- **`storage.json` migration is one-way** (drops the plaintext secret). The
  uplink token keeps working (validated by hash); only re-display of the secret
  is lost, which is the goal.
