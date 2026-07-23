import { expect, test } from './harness.ts'

/**
 * TLS smoke coverage (issue #639): serves the built control client from a
 * secure context — a TLS-terminating proxy in front of the control server —
 * and proves the shipped bundle actually connects, i.e. that it opens `wss://`
 * sockets. Browsers only block insecure `ws://` from secure contexts, so the
 * plain-http specs in the rest of the suite can never catch the mixed-content
 * bug class fixed in #638 (hardcoded `ws://` scheme, issue #617).
 */

test.use({
  harnessOptions: { tls: true },
  // The proxy's certificate is self-signed and throwaway; the test exercises
  // the secure context, not certificate validation.
  ignoreHTTPSErrors: true,
})

test('served over https, the client connects via wss:// and round-trips a grid edit', async ({
  page,
  harness,
}) => {
  expect(harness.baseURL).toMatch(/^https:\/\//)

  // Record every WebSocket the page opens — subscribed before navigation so
  // the client's initial connection attempt cannot be missed. A blocked
  // mixed-content `ws://` attempt would still show up here.
  const wsUrls: string[] = []
  page.on('websocket', (ws) => wsUrls.push(ws.url()))

  // The invite exchange (POST + session cookie + redirect) now runs entirely
  // over https, including the `Secure` cookie the server issues for it.
  await page.goto(await harness.createInviteLink())

  const grid = page.getByTestId('grid')
  await expect(grid).toBeVisible()
  // "connected" requires an open client socket plus injected state — a client
  // stuck on a blocked `ws://` attempt stays disconnected forever (#617).
  await expect(page.getByTestId('header-connection-status')).toContainText(
    'connected',
  )

  // The client must have derived `wss://` from the page protocol — nothing
  // less survives a secure context.
  expect(wsUrls.length).toBeGreaterThan(0)
  for (const url of wsUrls) {
    expect(url).toMatch(/^wss:\/\//)
  }

  // Full round trip through the TLS terminator: browser edit → wss → control
  // server → fake Streamwall uplink observes the shared-doc update.
  const cells = page.getByTestId('grid-cell')
  await expect(cells).toHaveCount(harness.cols * harness.rows)

  const targetIdx = 4 // center cell of the 3×3 grid
  const [streamId] = harness.streamIds

  await grid.hover()
  await cells.nth(targetIdx).fill(streamId)
  await cells.nth(targetIdx).blur()

  await harness.waitForViewAssignment(targetIdx, streamId)
  await expect(cells.nth(targetIdx)).toHaveValue(streamId)
})
