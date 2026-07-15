import type { WebSocketRoute } from '@playwright/test'
import { expect, test } from './harness.ts'

/**
 * End-to-end regression coverage for issue #37/#283: a websocket blip must
 * not blank the grid or drop its last-known cell assignments.
 *
 * `context.setOffline` doesn't sever an already-open WebSocket in Chromium
 * (confirmed empirically: the client stayed "connected" through it), so the
 * blip is instead simulated by routing the client's `/client/ws` connection
 * through `page.routeWebSocket` and closing it on demand — closing one side
 * closes the other by default, giving the page's `ReconnectingWebSocket` a
 * real `close` event to react to, the same as a dropped connection would.
 */

test('a websocket blip keeps the grid mounted with its last-known assignment, then resyncs', async ({
  page,
  harness,
}) => {
  // A plain mutable ref (rather than a reassigned `let`) so the assignment
  // made inside the routing callback is visible without TS narrowing the
  // outer binding back to its initial `null`.
  const socketRef: { current: WebSocketRoute | null } = { current: null }
  await page.routeWebSocket('**/client/ws', (ws) => {
    socketRef.current = ws
    ws.connectToServer()
  })

  await page.goto(await harness.createInviteLink())

  const grid = page.getByTestId('grid')
  await expect(grid).toBeVisible()
  await expect(page.getByTestId('header-connection-status')).toContainText(
    'connected',
  )

  const targetIdx = 4
  const [streamId] = harness.streamIds
  const cells = page.getByTestId('grid-cell')
  await grid.hover()
  await cells.nth(targetIdx).fill(streamId)
  await cells.nth(targetIdx).blur()
  await harness.waitForViewAssignment(targetIdx, streamId)
  await expect(cells.nth(targetIdx)).toHaveValue(streamId)

  await socketRef.current?.close()

  // The grid must stay mounted, dimmed, with its last-known assignment —
  // never unmount or blank to "loading..." (issue #37) — and the explicit
  // reconnect banner must explain why.
  await expect(page.getByTestId('connection-status-banner')).toContainText(
    'reconnecting',
    { ignoreCase: true },
  )
  await expect(grid).toBeVisible()
  await expect(cells.nth(targetIdx)).toHaveValue(streamId)
  await expect(page.getByTestId('header-connection-status')).toContainText(
    'connecting...',
  )

  // Once the transport recovers, the server's full resync on reconnect
  // clears the banner and the grid keeps showing the same assignment
  // throughout — it never flashes empty in between (issue #283).
  await expect(page.getByTestId('connection-status-banner')).toHaveCount(0)
  await expect(page.getByTestId('header-connection-status')).toContainText(
    'connected',
  )
  await expect(cells.nth(targetIdx)).toHaveValue(streamId)
})
