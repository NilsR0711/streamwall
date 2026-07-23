# streamwall-control-e2e

Playwright end-to-end smoke tests for the **control client** running against a
real **control server** and a **fake Streamwall uplink** (issue #55).

Unlike the happy-dom/jsdom unit tests in the other packages, these boot the full
stack — Vite-built client → Fastify/WebSocket server → mocked Streamwall peer —
in a real Chromium browser, so they cover things that only manifest with real
networking and real layout:

- the invite-link → session-cookie sign-in flow and grid render from injected state,
- unauthorized access being rejected,
- a grid-cell edit propagating over the wire to the Streamwall peer (Yjs),
- horizontal-overflow layout regressions (issue #225/#239) that no unit test can catch, and
- the client connecting via `wss://` from a secure context (issue #617/#639):
  [tests/tls.spec.ts](tests/tls.spec.ts) fronts the server with a
  TLS-terminating proxy ([tests/tlsProxy.ts](tests/tlsProxy.ts), self-signed
  throwaway certificate generated with the system `openssl`) so mixed-content
  bugs — which browsers only enforce on secure pages — fail in CI.

## Running

```sh
# once, to fetch the browser (Linux CI uses `--with-deps`):
npx playwright install chromium

# run the suite (equivalent: `npm run test:e2e` from the repo root):
npm -w streamwall-control-e2e run test:e2e
```

The npm script itself only starts Playwright. The control-client build runs
inside Playwright's `globalSetup` hook ([tests/global-setup.ts](tests/global-setup.ts)),
once per suite run, so the server has real `dist/` assets to serve. Beyond that
build there is no shared state: each test spins up its own server + uplink on a
fresh ephemeral port, so there is no `webServer`, no `baseURL`, and no fixed port.

The suite is intentionally kept out of the per-workspace `npm test` matrix (it
has no `test` script) because it needs a browser and only runs on Linux/macOS —
CI runs it in a dedicated job behind `npx playwright install --with-deps chromium`.
