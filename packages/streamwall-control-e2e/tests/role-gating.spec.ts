import { expect, test } from './harness.ts'

/**
 * Coverage for role gating (issue #343): `roleCan` is unit-tested in
 * isolation elsewhere, but these drive a real invite of each restricted role
 * through a real browser and assert the actual rendered grid respects it —
 * not just that the pure function returns the right boolean.
 */

test('a monitor invite renders the grid and layout controls disabled', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink('monitor'))

  const grid = page.getByTestId('grid')
  await expect(grid).toBeVisible()

  // `mutate-state-doc` is not a monitor action (see streamwall-shared's
  // `roleCan`): every grid-cell input must render disabled, and typing into
  // one must not change its value.
  const cells = page.getByTestId('grid-cell')
  await expect(cells).toHaveCount(harness.cols * harness.rows)
  for (let idx = 0; idx < harness.cols * harness.rows; idx++) {
    await expect(cells.nth(idx)).toBeDisabled()
  }

  // `set-grid-size` is likewise not a monitor action: the preset buttons and
  // the raw Columns/Rows inputs must be disabled too.
  await expect(page.getByRole('button', { name: '2×2' })).toBeDisabled()
  await expect(page.getByLabel('Columns')).toBeDisabled()
  await expect(page.getByLabel('Rows')).toBeDisabled()

  // `create-invite` is admin-only: the Access panel must not render at all
  // for a monitor.
  await expect(page.getByRole('heading', { name: 'Access' })).toHaveCount(0)
})

test('an operator invite can resize the grid and edit cells like an admin', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink('operator'))

  const grid = page.getByTestId('grid')
  await expect(grid).toBeVisible()

  // `mutate-state-doc` and `set-grid-size` are both operator actions: the
  // grid and layout controls must be fully interactive.
  const cells = page.getByTestId('grid-cell')
  await expect(cells.first()).toBeEnabled()
  await expect(page.getByRole('button', { name: '2×2' })).toBeEnabled()

  const targetIdx = 4
  const [streamId] = harness.streamIds
  await grid.hover()
  await cells.nth(targetIdx).fill(streamId)
  await cells.nth(targetIdx).blur()
  await harness.waitForViewAssignment(targetIdx, streamId)
  await expect(cells.nth(targetIdx)).toHaveValue(streamId)

  // `create-invite` is admin-only: an operator must not see the Access panel.
  await expect(page.getByRole('heading', { name: 'Access' })).toHaveCount(0)
})
