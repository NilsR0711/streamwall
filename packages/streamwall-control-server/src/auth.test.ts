import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Auth } from './auth.ts'

describe('Auth token storage', () => {
  test('createToken returns a tokenId and secret', async () => {
    const auth = new Auth()
    const { tokenId, secret } = await auth.createToken({
      kind: 'session',
      role: 'admin',
      name: 'Test',
    })
    assert.equal(typeof tokenId, 'string')
    assert.equal(typeof secret, 'string')
    assert.ok(tokenId.length > 0)
    assert.ok(secret.length > 0)
  })

  test('stored data never contains a plaintext secret', async () => {
    const auth = new Auth()
    const { secret } = await auth.createToken({
      kind: 'streamwall',
      role: 'admin',
      name: 'Streamwall',
    })

    const stored = auth.getStoredData()
    const serialized = JSON.stringify(stored)

    // The plaintext secret must not appear anywhere in what we persist.
    assert.ok(
      !serialized.includes(secret),
      'plaintext secret leaked into stored data',
    )
    // Every stored token exposes only a hash, never a secret field.
    for (const token of stored.tokens) {
      assert.ok(token.tokenHash, 'token is missing its hash')
      assert.ok(
        !('secret' in token),
        'token unexpectedly carries a plaintext secret',
      )
    }
  })

  test('validateToken accepts the correct secret and rejects an unknown id', async () => {
    const auth = new Auth()
    const { tokenId, secret } = await auth.createToken({
      kind: 'invite',
      role: 'operator',
      name: 'Op',
    })

    const ok = await auth.validateToken(tokenId, secret)
    assert.ok(ok)
    assert.equal(ok?.role, 'operator')
    assert.equal(ok?.kind, 'invite')

    assert.equal(await auth.validateToken('unknown-id', secret), null)
  })

  test('a token validates after reconstructing Auth from stored (hash-only) data', async () => {
    const auth = new Auth()
    const { tokenId, secret } = await auth.createToken({
      kind: 'streamwall',
      role: 'admin',
      name: 'Streamwall',
    })

    // Simulate a server restart: rebuild Auth purely from the persisted,
    // hash-only representation.
    const restored = new Auth(auth.getStoredData())
    const info = await restored.validateToken(tokenId, secret)
    assert.ok(info, 'hash-only persistence must still authenticate the token')
    assert.equal(info?.kind, 'streamwall')
  })
})
