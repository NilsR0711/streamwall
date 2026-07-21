import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { runInviteExchange } from './exchange.js'

/**
 * Builds the injected browser dependencies for `runInviteExchange`, recording
 * every side effect so tests can assert on them without a real DOM.
 */
function harness({
  hash = '',
  pathname = '/invite/tok123',
  fetchImpl,
}: {
  hash?: string
  pathname?: string
  fetchImpl?: (url: string, init: unknown) => Promise<{ ok: boolean }>
} = {}) {
  const calls = {
    replaceState: [] as Array<[unknown, string, string]>,
    replaced: [] as string[],
    status: [] as string[],
    fetch: [] as Array<{ url: string; init: unknown }>,
  }
  const location = {
    hash,
    pathname,
    replace(url: string) {
      calls.replaced.push(url)
    },
  }
  const history = {
    replaceState(state: unknown, unused: string, url: string) {
      calls.replaceState.push([state, unused, url])
    },
  }
  const fetch = (url: string, init: unknown) => {
    calls.fetch.push({ url, init })
    return (fetchImpl ?? (async () => ({ ok: true })))(url, init)
  }
  const setStatus = (text: string) => {
    calls.status.push(text)
  }
  return { calls, deps: { location, history, fetch, setStatus } }
}

describe('runInviteExchange fragment parsing', () => {
  test('scrubs the token from the address bar before anything else', async () => {
    const { calls, deps } = harness({
      hash: '#token=secret-abc',
      pathname: '/invite/tok123',
    })

    await runInviteExchange(deps)

    assert.deepEqual(calls.replaceState[0], [null, '', '/invite/tok123'])
  })

  test('extracts the token from among other fragment params', async () => {
    const { calls, deps } = harness({
      hash: '#foo=1&token=secret-xyz&bar=2',
    })

    await runInviteExchange(deps)

    assert.equal(calls.fetch.length, 1)
    assert.deepEqual(
      JSON.parse(String((calls.fetch[0].init as { body: string }).body)),
      {
        token: 'secret-xyz',
      },
    )
  })

  test('reports and skips the request when the fragment carries no token', async () => {
    const { calls, deps } = harness({ hash: '#nope=1' })

    await runInviteExchange(deps)

    assert.deepEqual(calls.status, ['This invite link is missing its token.'])
    assert.equal(calls.fetch.length, 0, 'no redemption request without a token')
    // The address bar is still scrubbed even on the no-token path.
    assert.equal(calls.replaceState.length, 1)
  })
})

describe('runInviteExchange redemption paths', () => {
  test('POSTs the token to the invite path and navigates home on success', async () => {
    const { calls, deps } = harness({
      hash: '#token=good',
      pathname: '/invite/tok123',
      fetchImpl: async () => ({ ok: true }),
    })

    await runInviteExchange(deps)

    assert.equal(calls.fetch[0].url, '/invite/tok123')
    const init = calls.fetch[0].init as {
      method: string
      headers: Record<string, string>
      body: string
    }
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(init.body), { token: 'good' })
    assert.deepEqual(calls.replaced, ['/'], 'navigates to the app on success')
    assert.deepEqual(calls.status, [], 'no error surfaced on success')
  })

  test('surfaces an invalid/expired message when the server rejects', async () => {
    const { calls, deps } = harness({
      hash: '#token=stale',
      fetchImpl: async () => ({ ok: false }),
    })

    await runInviteExchange(deps)

    assert.deepEqual(calls.status, ['This invite is invalid or has expired.'])
    assert.deepEqual(
      calls.replaced,
      [],
      'does not navigate on a rejected invite',
    )
  })

  test('surfaces a connectivity message when the request itself fails', async () => {
    const { calls, deps } = harness({
      hash: '#token=whatever',
      fetchImpl: async () => {
        throw new Error('network down')
      },
    })

    await runInviteExchange(deps)

    assert.deepEqual(calls.status, [
      'Could not reach the server. Please try again.',
    ])
    assert.deepEqual(calls.replaced, [])
  })
})
