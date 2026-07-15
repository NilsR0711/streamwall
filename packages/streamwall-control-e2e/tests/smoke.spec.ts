import { expect, test } from './harness.ts'

/**
 * End-to-end smoke coverage for the control client against a real control
 * server + fake Streamwall uplink, driven in a real browser (issue #55). These
 * exercise the cookie/invite flow, the unauthorized path, the Yjs grid-edit
 * round-trip, and real-layout regressions (issue #225/#239) that no
 * happy-dom/jsdom unit test can catch.
 */

test('an admin invite link signs in and renders the grid from injected state', async ({
  page,
  harness,
}) => {
  // Navigating the invite link runs the exchange page, which POSTs the token,
  // receives the session cookie, and redirects to the app.
  await page.goto(await harness.createInviteLink())

  const grid = page.getByTestId('grid')
  await expect(grid).toBeVisible()
  await expect(page.getByTestId('grid-cell')).toHaveCount(
    harness.cols * harness.rows,
  )
  // Header status flips to "connected" only once the client's socket is up and
  // the injected state has arrived.
  await expect(page.getByTestId('header-connection-status')).toContainText(
    'connected',
  )
})

test('an unauthenticated visitor is rejected with an unauthorized banner', async ({
  page,
  harness,
}) => {
  // No invite, no session cookie: the static app still loads, but its client
  // socket is refused and the disconnect banner explains why.
  await page.goto(`${harness.baseURL}/`)

  await expect(page.getByTestId('connection-status-banner')).toContainText(
    'Session invalid',
  )
  // Without any state push the grid never renders.
  await expect(page.getByTestId('grid')).toHaveCount(0)
})

test('a grid-cell edit reaches the Streamwall peer as a shared-doc update', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink())

  const cells = page.getByTestId('grid-cell')
  await expect(cells).toHaveCount(harness.cols * harness.rows)

  const targetIdx = 4 // center cell of the 3×3 grid
  const [streamId] = harness.streamIds

  await page.getByTestId('grid').hover()
  await cells.nth(targetIdx).fill(streamId)
  await cells.nth(targetIdx).blur()

  // The edit must travel: browser → Yjs doc → control server → uplink peer.
  await harness.waitForViewAssignment(targetIdx, streamId)
  // …and the browser reflects the committed assignment.
  await expect(cells.nth(targetIdx)).toHaveValue(streamId)
})

test('the layout never overflows horizontally across viewport widths', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink())
  await expect(page.getByTestId('grid')).toBeVisible()

  // Real-browser layout measurement — the only way to catch min-content /
  // margin overflow regressions (issue #225/#239) that unit tests miss.
  for (const width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    expect(
      scrollWidth,
      `horizontal overflow at ${width}px viewport`,
    ).toBeLessThanOrEqual(innerWidth)
  }
})
