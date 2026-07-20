import { SESSION_COOKIE_NAME } from 'streamwall-control-server'
import { expect, test } from './harness.ts'

/**
 * End-to-end coverage for issue #391: an invite link with an unknown or
 * already-redeemed id/secret must show the invite-exchange page's error
 * copy (`index.ts`'s `INVITE_EXCHANGE_SCRIPT`, driven by the server's plain
 * 403) and must never set the session cookie — this is server behavior
 * already covered by `inviteExchange.test.ts`, but only a real browser
 * proves the client-side exchange script actually surfaces it to the user
 * instead of, say, hanging on "Signing you in…" forever.
 */

test('visiting an invalid invite link shows an error and never grants a session', async ({
  page,
  harness,
}) => {
  await page.goto(
    `${harness.baseURL}/invite/does-not-exist#token=not-a-real-secret`,
  )

  await expect(page.locator('p')).toHaveText(
    'This invite is invalid or has expired.',
  )

  const cookies = await page.context().cookies()
  expect(cookies.some((c) => c.name === SESSION_COOKIE_NAME)).toBe(false)
})
