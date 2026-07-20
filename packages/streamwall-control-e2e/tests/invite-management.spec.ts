import { expect, test } from './harness.ts'

/**
 * Coverage for the Access panel's invite round-trip (issue #343): submitting
 * the create-invite form sends a `create-invite` command, and the server's
 * response must be parsed and rendered — both as the direct "invite link
 * created" callout and as a new line in the persistent Invites list (the
 * latter regression-covers #351: creating a token used to only reach an
 * already-connected client on the next unrelated state push from the
 * Streamwall uplink, not immediately).
 */

test('creating an invite from the Access panel renders the resulting link and list entry', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink())

  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible()

  const createInviteForm = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'create invite' }) })
  await createInviteForm
    .getByPlaceholder('Name', { exact: true })
    .fill('field-crew')
  await createInviteForm.getByRole('combobox').selectOption('operator')
  await createInviteForm.getByRole('button', { name: 'create invite' }).click()

  // The server's direct `create-invite` response is parsed into a real
  // invite link and rendered as the "invite link created" callout.
  await expect(page.getByRole('link', { name: '"field-crew"' })).toBeVisible()

  // ...and the token now shows up live in the persistent Invites list.
  await expect(page.getByText('field-crew: operator')).toBeVisible()
})

/**
 * Coverage for issue #438: the Access panel's "revoke" button (`AuthTokenLine`'s
 * `onDelete`) had no E2E coverage at all. Revokes a freshly created invite -
 * never the browser's own admin session, which the harness names "e2e" and
 * which revoking would immediately close this very socket (a distinct
 * scenario from the one under test here).
 */
test('revoking an invite from the Access panel removes it from the Invites list', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink())

  const createInviteForm = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'create invite' }) })
  await createInviteForm
    .getByPlaceholder('Name', { exact: true })
    .fill('to-revoke')
  await createInviteForm.getByRole('combobox').selectOption('operator')
  await createInviteForm.getByRole('button', { name: 'create invite' }).click()

  await expect(page.getByText('to-revoke: operator')).toBeVisible()

  const inviteRow = page.getByText('to-revoke', { exact: true }).locator('..')
  await inviteRow.getByRole('button', { name: 'revoke' }).click()

  await expect(page.getByText('to-revoke: operator')).not.toBeVisible()
})
