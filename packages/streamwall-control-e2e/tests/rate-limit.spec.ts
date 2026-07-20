import { expect, test } from '@playwright/test'
import { startHarness } from './harness.ts'

/**
 * End-to-end coverage for issue #391: the control server's per-connection
 * inbound WebSocket message budget (`rateLimiter.ts`'s `TokenBucket`) closes
 * the socket with a "rate limit exceeded" error once a client exceeds it.
 * This must surface as the operator-visible rate-limited banner
 * (`ConnectionStatusBanner`) rather than a silent drop, and the client must
 * then reconnect and resync cleanly, same as any other transport blip
 * (issue #37/#283).
 *
 * This test starts its own harness (rather than using the shared `harness`
 * fixture from `./harness.ts`) so it can set a near-zero message budget via
 * environment variables *before* the server boots — the config is only read
 * once, lazily, inside `initApp`. The budget applies per-connection, so the
 * fake uplink (which sends its own seed state + doc snapshot on connect, see
 * `startHarness`) gets an independent bucket from the browser client under
 * test — capacity 2 covers the uplink's two startup sends with room to
 * spare, while still being small enough for the test to trip deliberately.
 */

test('a client that exceeds the inbound message budget sees the rate-limited banner, then resyncs', async ({
  page,
}) => {
  process.env.STREAMWALL_WS_MSG_BURST = '2'
  // Refills so slowly it may as well not refill during the test.
  process.env.STREAMWALL_WS_MSG_RATE = '0.01'
  const harness = await startHarness()
  try {
    await page.goto(await harness.createInviteLink())

    const grid = page.getByTestId('grid')
    await expect(grid).toBeVisible()
    await expect(page.getByTestId('header-connection-status')).toContainText(
      'connected',
    )

    const cells = page.getByTestId('grid-cell')
    const [firstStreamId, secondStreamId, thirdStreamId] = harness.streamIds
    await grid.hover()

    // The browser client's own bucket starts fresh at capacity 2: these two
    // edits consume it exactly, both succeeding.
    await cells.nth(0).fill(firstStreamId)
    await cells.nth(0).blur()
    await harness.waitForViewAssignment(0, firstStreamId)

    await cells.nth(1).fill(secondStreamId)
    await cells.nth(1).blur()
    await harness.waitForViewAssignment(1, secondStreamId)

    // A third edit, made immediately after, exceeds the now-empty budget:
    // the server closes the socket instead of applying it, after sending
    // the rate-limit error the client maps to a reason.
    await cells.nth(2).fill(thirdStreamId)
    await cells.nth(2).blur()

    await expect(page.getByTestId('connection-status-banner')).toContainText(
      'Too many messages sent',
    )
    await expect(page.getByTestId('header-connection-status')).toContainText(
      'connecting...',
    )

    // The reconnect gets a brand-new per-connection budget and a full
    // resync: the banner clears, and both earlier (successfully applied)
    // assignments survive the blip exactly like a plain network drop would.
    await expect(page.getByTestId('connection-status-banner')).toHaveCount(0)
    await expect(page.getByTestId('header-connection-status')).toContainText(
      'connected',
    )
    await expect(cells.nth(0)).toHaveValue(firstStreamId)
    await expect(cells.nth(1)).toHaveValue(secondStreamId)
  } finally {
    delete process.env.STREAMWALL_WS_MSG_BURST
    delete process.env.STREAMWALL_WS_MSG_RATE
    await harness.close()
  }
})
