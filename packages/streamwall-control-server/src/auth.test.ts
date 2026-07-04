import baseX from 'base-x'
import assert from 'node:assert/strict'
import { scrypt as scryptCb } from 'node:crypto'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { type AuthToken, Auth, rand62 } from './auth.ts'

const scrypt = promisify(scryptCb)

// Independent re-implementation of the *legacy* stored-hash format (base62 of a
// 24-byte scrypt digest computed with Node's default cost parameters, using the
// shared salt). Used to assert backward compatibility with tokens that were
// persisted before per-token salts existed.
const base62 = baseX(
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
)
async function legacyStoredHash(secret: string, salt: string): Promise<string> {
  return base62.encode((await scrypt(secret, salt, 24)) as Buffer)
}

test('validateToken accepts the correct id and secret', async () => {
  const auth = new Auth()
  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role: 'operator',
    name: 'alice',
  })

  const info = await auth.validateToken(tokenId, secret)

  assert.deepEqual(info, {
    tokenId,
    kind: 'session',
    role: 'operator',
    name: 'alice',
  })
})

test('validateToken rejects a wrong secret with null', async () => {
  const auth = new Auth()
  const { tokenId } = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'bob',
  })

  const info = await auth.validateToken(tokenId, 'not-the-secret')

  assert.equal(info, null)
})

test('validateToken returns null for an unknown token id', async () => {
  const auth = new Auth()

  const info = await auth.validateToken('does-not-exist', 'whatever')

  assert.equal(info, null)
})

test('validateToken returns null (never throws) when the stored hash length differs from the computed hash', async () => {
  // A hand-crafted stored record whose base62 hash decodes to a single byte,
  // while a freshly computed scrypt digest is always 24 bytes. Comparing the
  // variable-length base62 *strings* (the previous behaviour) fed unequal-length
  // buffers to timingSafeEqual, which throws RangeError instead of failing
  // closed. This must now return null without throwing.
  const auth = new Auth()
  const tokenId = 'crafted0'
  auth.tokensById.set(tokenId, {
    tokenId,
    tokenHash: 'z',
    salt: rand62(24),
    kind: 'session',
    role: 'admin',
    name: 'crafted',
  })

  const info = await auth.validateToken(tokenId, 'any-secret-whatsoever')

  assert.equal(info, null)
})

test('createToken assigns each token a unique per-token salt distinct from the shared salt', async () => {
  const auth = new Auth({ salt: 'SHARED-GLOBAL-SALT' })

  const a = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'a',
  })
  const b = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'b',
  })

  const tokenA = auth.tokensById.get(a.tokenId)
  const tokenB = auth.tokensById.get(b.tokenId)

  assert.ok(tokenA?.salt, 'token A should carry a per-token salt')
  assert.ok(tokenB?.salt, 'token B should carry a per-token salt')
  assert.notEqual(tokenA.salt, 'SHARED-GLOBAL-SALT')
  assert.notEqual(tokenA.salt, tokenB.salt)
})

test('getStoredData persists each token together with its per-token salt', async () => {
  const auth = new Auth()
  const { tokenId } = await auth.createToken({
    kind: 'invite',
    role: 'operator',
    name: 'carol',
  })

  const stored = auth.getStoredData()
  const token = stored.tokens.find((t) => t.tokenId === tokenId)

  assert.ok(token?.salt, 'stored token should carry its per-token salt')
})

test('a token survives a storage round-trip and still validates', async () => {
  const auth1 = new Auth()
  const { tokenId, secret } = await auth1.createToken({
    kind: 'session',
    role: 'admin',
    name: 'dave',
  })

  // Reload from persisted data into a fresh instance (fresh shared salt).
  const auth2 = new Auth(auth1.getStoredData())
  const info = await auth2.validateToken(tokenId, secret)

  assert.deepEqual(info, {
    tokenId,
    kind: 'session',
    role: 'admin',
    name: 'dave',
  })
})

test('validateToken accepts a legacy token hashed with the shared salt and no per-token salt', async () => {
  const sharedSalt = rand62(24)
  const secret = rand62(24)
  const legacyToken: AuthToken = {
    tokenId: 'legacy00',
    tokenHash: await legacyStoredHash(secret, sharedSalt),
    kind: 'session',
    role: 'admin',
    name: 'legacy',
  }
  const auth = new Auth({ salt: sharedSalt, tokens: [legacyToken] })

  const info = await auth.validateToken('legacy00', secret)

  assert.deepEqual(info, {
    tokenId: 'legacy00',
    kind: 'session',
    role: 'admin',
    name: 'legacy',
  })
})

test('validateToken rejects a token revoked while its hash is being computed', async () => {
  const auth = new Auth()
  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'race',
  })

  // Kick off validation, then revoke the token before the (async) scrypt hash
  // resolves. validateToken reads the token record before awaiting the hash;
  // without a post-hash freshness check it would authenticate the already
  // revoked secret against its stale snapshot.
  const pending = auth.validateToken(tokenId, secret)
  auth.deleteToken(tokenId)

  const info = await pending

  assert.equal(info, null)
})
