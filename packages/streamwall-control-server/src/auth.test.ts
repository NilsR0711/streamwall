import baseX from 'base-x'
import assert from 'node:assert/strict'
import { scrypt as scryptCb } from 'node:crypto'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { StreamwallRole, StreamwallState } from 'streamwall-shared'
import {
  type AuthToken,
  type ScryptParams,
  Auth,
  DEFAULT_SCRYPT_PARAMS,
  rand62,
  StateWrapper,
  uniqueRand62,
} from './auth.ts'

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

/**
 * Independent re-implementation of the *current* stored-hash format under an
 * explicit work factor, so a spec can assert which parameters a hash was
 * actually derived with.
 */
function storedHash(
  secret: string,
  salt: string,
  params: ScryptParams,
): Promise<string> {
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, 24, params, (err, derivedKey) => {
      if (err) {
        reject(err)
      } else {
        resolve(base62.encode(derivedKey))
      }
    })
  })
}

test('rand62 emits only base62 characters within the expected length bound', () => {
  const len = 24
  // Encoding `len` random bytes in base62 never exceeds this many characters
  // (leading zero bytes only shorten the output), so the bound documents the
  // token-secret width without being flaky.
  const maxLen = Math.ceil((len * Math.log(256)) / Math.log(62)) + 1
  const samples = new Set<string>()

  for (let i = 0; i < 200; i++) {
    const value = rand62(len)
    assert.match(value, /^[0-9A-Za-z]+$/)
    assert.ok(
      value.length >= 1 && value.length <= maxLen,
      `unexpected length ${value.length} (bound ${maxLen})`,
    )
    samples.add(value)
  }

  // 24 random bytes make a repeat within 200 draws effectively impossible.
  assert.equal(samples.size, 200)
})

test('uniqueRand62 regenerates until it finds a value absent from the map', () => {
  const seen: string[] = []
  let remainingCollisions = 2
  // A minimal Map stand-in whose `has` reports the first two candidates as
  // already taken, forcing the regeneration loop to run before it settles.
  const collidingMap = {
    has(value: string) {
      seen.push(value)
      if (remainingCollisions > 0) {
        remainingCollisions--
        return true
      }
      return false
    },
  } as unknown as Map<string, unknown>

  const value = uniqueRand62(8, collidingMap)

  // Two forced collisions → three candidates generated; the last is returned.
  assert.equal(seen.length, 3)
  assert.equal(value, seen[2])
  assert.equal(new Set(seen).size, 3, 'each retry should draw a fresh value')
  assert.match(value, /^[0-9A-Za-z]+$/)
})

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

test('hashes tokens with the production scrypt work factor by default', async () => {
  // Guard against the work factor being lowered silently: the stored hash must
  // still be reproducible with the exact parameters every persisted token was
  // hashed under. Lowering these would both weaken the hash and invalidate
  // every already-persisted session, invite and uplink token on upgrade.
  assert.deepEqual(DEFAULT_SCRYPT_PARAMS, { N: 16384, r: 8, p: 1 })

  const auth = new Auth()
  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'default-params',
  })
  const stored = auth.getStoredData().tokens.find((t) => t.tokenId === tokenId)

  assert.ok(stored?.salt)
  assert.equal(
    stored.tokenHash,
    await storedHash(secret, stored.salt, { N: 16384, r: 8, p: 1 }),
  )
})

test('derives token hashes with injected scrypt parameters', async () => {
  // Tests inject a cheap work factor so a suite that boots a live server per
  // test does not pay four production-cost derivations it never asserts on.
  const scryptParams = { N: 16, r: 8, p: 1 }
  const auth = new Auth(undefined, undefined, { scryptParams })

  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'cheap-params',
  })
  const stored = auth.getStoredData().tokens.find((t) => t.tokenId === tokenId)

  assert.ok(stored?.salt)
  assert.equal(
    stored.tokenHash,
    await storedHash(secret, stored.salt, scryptParams),
  )
  // The same instance validates what it hashed: minting and verifying agree on
  // the injected parameters.
  assert.ok(await auth.validateToken(tokenId, secret))
})

test('validateToken rejects a token hashed under a different work factor', async () => {
  const auth = new Auth(undefined, undefined, {
    scryptParams: { N: 16, r: 8, p: 1 },
  })
  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'mismatch',
  })

  // Reloading the persisted tokens under the production work factor derives a
  // different digest, so the secret no longer matches: the work factor is part
  // of the stored hash and cannot be changed for existing tokens.
  const reloaded = new Auth(auth.getStoredData())

  assert.equal(await reloaded.validateToken(tokenId, secret), null)
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

test('createToken rejects an unknown role and stores nothing', async () => {
  const auth = new Auth()

  await assert.rejects(
    auth.createToken({
      kind: 'session',
      role: 'superuser' as any,
      name: 'mallory',
    }),
    /invalid role/,
  )

  assert.equal(auth.tokensById.size, 0)
})

test('deleteToken revokes a token and is a no-op for unknown ids', async () => {
  const auth = new Auth()
  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role: 'operator',
    name: 'erin',
  })

  // Deleting an unknown id must neither throw nor disturb existing tokens.
  auth.deleteToken('never-existed')
  assert.equal(auth.tokensById.size, 1)

  auth.deleteToken(tokenId)

  assert.equal(await auth.validateToken(tokenId, secret), null)
  assert.equal(auth.getStoredData().tokens.length, 0)
})

test('validateToken returns null (never throws) when the stored hash is not valid base62', async () => {
  // '-' and '!' are outside the base62 alphabet, so decoding the stored hash
  // throws inside validateToken. Malformed persisted data must fail closed
  // (return null) rather than propagate the error to the auth path.
  const auth = new Auth()
  const tokenId = 'malformed'
  auth.tokensById.set(tokenId, {
    tokenId,
    tokenHash: 'not-valid-base62!',
    salt: rand62(24),
    kind: 'session',
    role: 'admin',
    name: 'malformed',
  })

  const info = await auth.validateToken(tokenId, 'any-secret')

  assert.equal(info, null)
})

// A representative, fully-populated state whose `auth` block (the token list)
// is the sensitive payload StateWrapper.view scopes by role.
function makeState(): StreamwallState {
  return {
    identity: { role: 'admin' },
    auth: {
      invites: [
        { tokenId: 'inv1', kind: 'invite', role: 'operator', name: 'invitee' },
      ],
      sessions: [
        { tokenId: 'sess1', kind: 'session', role: 'admin', name: 'owner' },
      ],
    },
    config: {
      cols: 3,
      rows: 3,
      width: 1920,
      height: 1080,
      frameless: false,
      fullscreen: false,
      activeColor: '#ffffff',
      backgroundColor: '#000000',
    },
    streams: [],
    customStreams: [],
    views: [],
    fullscreenViewIdx: null,
    streamdelay: null,
    layoutPresets: [
      { id: 'p1', name: 'My Layout', cols: 2, rows: 2, views: {} },
    ],
    favorites: ['https://example.com/stream'],
    dataSourceHealth: [],
  }
}

test('StateWrapper.view("admin") exposes the auth token list', () => {
  const state = makeState()
  const view = new StateWrapper(state).view('admin')

  assert.ok('auth' in view, 'admin view must carry the auth key')
  assert.deepEqual(view.auth, state.auth)
  assert.equal(view.identity.role, 'admin')
})

// Only admins see the token list. Every other role — including all-powerful
// `local` — gets a view with no `auth` key at all (not merely `undefined`), so
// the secret-bearing invite/session names never reach a non-admin client.
for (const role of [
  'operator',
  'monitor',
  'local',
] satisfies StreamwallRole[]) {
  test(`StateWrapper.view("${role}") omits the auth token list entirely`, () => {
    const view = new StateWrapper(makeState()).view(role)

    assert.ok(!('auth' in view), `${role} view must not have an auth key`)
    assert.equal(view.auth, undefined)
    assert.equal(view.identity.role, role)
  })
}

test('StateWrapper.view re-stamps identity.role without mutating the source', () => {
  const state = makeState()
  const wrapper = new StateWrapper(state)

  const operatorView = wrapper.view('operator')

  assert.equal(operatorView.identity.role, 'operator')
  // The wrapped value is untouched: viewing under one role must not rewrite the
  // identity seen by a subsequent viewer.
  assert.equal(state.identity.role, 'admin')
  assert.equal(wrapper.view('admin').identity.role, 'admin')
})

test('StateWrapper.view passes non-sensitive fields through unchanged', () => {
  const state = makeState()
  const view = new StateWrapper(state).view('monitor')

  assert.equal(view.config, state.config)
  assert.equal(view.streams, state.streams)
  assert.equal(view.customStreams, state.customStreams)
  assert.equal(view.views, state.views)
  assert.equal(view.streamdelay, state.streamdelay)
  assert.equal(view.layoutPresets, state.layoutPresets)
  assert.equal(view.favorites, state.favorites)
})

test('StateWrapper.info returns an unprivileged (monitor) view with no auth', () => {
  const view = new StateWrapper(makeState()).info

  assert.ok(!('auth' in view), 'the info getter must not leak the auth key')
  assert.equal(view.identity.role, 'monitor')
})
