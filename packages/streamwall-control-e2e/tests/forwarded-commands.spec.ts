import { expect, test } from './harness.ts'

/**
 * Coverage for a `ControlCommand` driven from the UI actually reaching the
 * Streamwall peer as the server-forwarded JSON message it expects (issue
 * #343): the grid-size preset buttons are a convenient trigger because,
 * unlike blur/listen controls, they don't require a running view.
 */

test('clicking a grid-size preset forwards a set-grid-size command to the Streamwall peer', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink())
  await expect(page.getByTestId('grid')).toBeVisible()

  const commandPromise = harness.waitForCommand('set-grid-size')
  await page.getByRole('button', { name: '2×2' }).click()

  const command = await commandPromise
  expect(command).toMatchObject({ type: 'set-grid-size', cols: 2, rows: 2 })
})

test('typing a custom column count forwards the committed dimensions', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink())
  await expect(page.getByTestId('grid')).toBeVisible()

  const commandPromise = harness.waitForCommand('set-grid-size')
  const columnsInput = page.getByLabel('Columns')
  await columnsInput.fill('4')
  await columnsInput.blur()

  const command = await commandPromise
  expect(command).toMatchObject({
    type: 'set-grid-size',
    cols: 4,
    rows: harness.rows,
  })
})
