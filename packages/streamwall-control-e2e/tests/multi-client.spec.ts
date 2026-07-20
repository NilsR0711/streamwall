import { expect, test } from './harness.ts'

/**
 * End-to-end coverage for issue #391: `multiplexing.test.ts` covers the
 * server's fan-out of a shared-doc update to every *other* connected client
 * in isolation, but that says nothing about what two real operator browsers
 * actually see. Each gets its own invite (and so its own session cookie) via
 * a separate browser context, mirroring two people working the same wall at
 * once.
 */

test('concurrent edits from two browser clients on different cells converge on both', async ({
  browser,
  harness,
}) => {
  const context1 = await browser.newContext()
  const context2 = await browser.newContext()
  try {
    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    await page1.goto(await harness.createInviteLink())
    await page2.goto(await harness.createInviteLink())

    const cells1 = page1.getByTestId('grid-cell')
    const cells2 = page2.getByTestId('grid-cell')
    await expect(cells1).toHaveCount(harness.cols * harness.rows)
    await expect(cells2).toHaveCount(harness.cols * harness.rows)

    const [streamIdA, streamIdB] = harness.streamIds
    const idxA = 0
    const idxB = harness.cols * harness.rows - 1 // opposite corner: no overlap

    await page1.getByTestId('grid').hover()
    await page2.getByTestId('grid').hover()

    await Promise.all([
      (async () => {
        await cells1.nth(idxA).fill(streamIdA)
        await cells1.nth(idxA).blur()
      })(),
      (async () => {
        await cells2.nth(idxB).fill(streamIdB)
        await cells2.nth(idxB).blur()
      })(),
    ])

    await Promise.all([
      harness.waitForViewAssignment(idxA, streamIdA),
      harness.waitForViewAssignment(idxB, streamIdB),
    ])

    // Both edits must land on both clients: a naive last-write-wins merge
    // (or a client only reflecting its own edit) would drop one of them.
    await expect(cells1.nth(idxA)).toHaveValue(streamIdA)
    await expect(cells1.nth(idxB)).toHaveValue(streamIdB)
    await expect(cells2.nth(idxA)).toHaveValue(streamIdA)
    await expect(cells2.nth(idxB)).toHaveValue(streamIdB)
  } finally {
    await context1.close()
    await context2.close()
  }
})
