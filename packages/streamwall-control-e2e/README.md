# streamwall-control-e2e

Playwright end-to-end smoke tests for the **control client** running against a
real **control server** and a **fake Streamwall uplink** (issue #55).

Unlike the happy-dom/jsdom unit tests in the other packages, these boot the full
stack — Vite-built client → Fastify/WebSocket server → mocked Streamwall peer —
in a real Chromium browser, so they cover things that only manifest with real
networking and real layout:

- the invite-link → session-cookie sign-in flow and grid render from injected state,
- unauthorized access being rejected,
- a grid-cell edit propagating over the wire to the Streamwall peer (Yjs), and
- horizontal-overflow layout regressions (issue #225/#239) that no unit test can catch.

## Running

```sh
# once, to fetch the browser (Linux CI uses `--with-deps`):
npx playwright install chromium

# build the client and run the suite:
npm -w streamwall-control-e2e run test:e2e
```

`test:e2e` builds the control client first (the server serves its `dist/`), then
runs Playwright. Each test spins up its own server + uplink on a fresh port, so
there is no shared global setup or fixed port.

The suite is intentionally kept out of the per-workspace `npm test` matrix (it
has no `test` script) because it needs a browser and only runs on Linux/macOS —
CI runs it in a dedicated job behind `npx playwright install --with-deps chromium`.
