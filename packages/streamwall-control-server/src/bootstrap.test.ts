import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { initApp, initialInviteCodes } from './index.ts'
import type { StorageDB } from './storage.ts'
import {
  failingWriteDb,
  inMemoryDb,
  makeStaticDir,
  TEST_SCRYPT_PARAMS,
} from './testHelpers.ts'

const BASE_URL = 'https://wall.example.com'

/**
 * Boots the control app against a given storage backend and runs the bootstrap
 * step, faithfully wiring the same auth-persistence hook `runServer` relies on.
 * Calling it twice against the same `db` simulates a server restart.
 */
async function boot(db: StorageDB) {
  const { app, auth } = await initApp({
    baseURL: BASE_URL,
    clientStaticPath: makeStaticDir(),
    db,
  })
  after(() => app.close())
  const result = await initialInviteCodes({ db, auth, baseURL: BASE_URL })
  return { app, auth, result }
}

/** Serializes storage the way it lands on disk, to detect leaked plaintext. */
function storageContains(db: StorageDB, needle: string) {
  return JSON.stringify(db.data).includes(needle)
}

describe('initialInviteCodes uplink token', () => {
  test('mints an uplink token and reveals its secret exactly once', async () => {
    const db = inMemoryDb()
    const { result } = await boot(db)

    assert.ok(result.uplinkSecret, 'the secret is surfaced when freshly minted')
    assert.ok(db.data.streamwallToken, 'the uplink token id is persisted')
    assert.equal(
      db.data.streamwallToken.tokenId,
      db.data.auth.tokens.find((t) => t.kind === 'streamwall')?.tokenId,
      'the persisted id matches the hashed auth token',
    )
  })

  test('never persists the plaintext uplink secret to storage', async () => {
    const db = inMemoryDb()
    const { result } = await boot(db)

    assert.ok(result.uplinkSecret)
    assert.equal(
      (db.data.streamwallToken as { secret?: string }).secret,
      undefined,
      'the stored uplink record must not carry a secret field',
    )
    assert.equal(
      storageContains(db, result.uplinkSecret),
      false,
      'the plaintext uplink secret must not appear anywhere in storage',
    )
  })

  test('reuses the existing uplink token without re-revealing the secret', async () => {
    const db = inMemoryDb()
    const { result: first } = await boot(db)
    const firstId = db.data.streamwallToken?.tokenId

    const { result: second } = await boot(db)

    assert.ok(first.uplinkSecret)
    assert.equal(
      second.uplinkSecret,
      null,
      'a restart cannot recover (and must not re-reveal) the secret',
    )
    assert.equal(
      db.data.streamwallToken?.tokenId,
      firstId,
      'the uplink token id is stable across restarts',
    )
    const streamwallTokens = db.data.auth.tokens.filter(
      (t) => t.kind === 'streamwall',
    )
    assert.equal(
      streamwallTokens.length,
      1,
      'restarting must not mint a second uplink token',
    )
  })

  test('strips a legacy plaintext secret from storage on startup', async () => {
    const db = inMemoryDb()
    const { result: first } = await boot(db)
    const tokenId = db.data.streamwallToken!.tokenId

    // Recreate the pre-fix on-disk shape: the hashed auth token is untouched,
    // but the uplink record still carries the plaintext secret it used to hold.
    const legacyPlaintext = 'legacy-plaintext-secret'
    db.data.streamwallToken = {
      tokenId,
      secret: legacyPlaintext,
    } as StorageDB['data']['streamwallToken']

    const { result: second } = await boot(db)

    assert.ok(first.uplinkSecret)
    assert.equal(
      second.uplinkSecret,
      null,
      'a legacy secret is not re-revealed',
    )
    assert.equal(
      (db.data.streamwallToken as { secret?: string }).secret,
      undefined,
      'the legacy plaintext secret is scrubbed from storage',
    )
    assert.equal(
      storageContains(db, legacyPlaintext),
      false,
      'no trace of the legacy plaintext secret remains on disk',
    )
  })

  test('rotates the uplink token when its storage record is cleared', async () => {
    const db = inMemoryDb()
    const { result: first } = await boot(db)
    assert.ok(first.uplinkSecret)

    // Operator rotates by removing the persisted uplink record and restarting.
    db.data.streamwallToken = null
    const { result: second } = await boot(db)

    assert.ok(second.uplinkSecret, 'a fresh secret is revealed after rotation')
    assert.notEqual(
      second.uplinkSecret,
      first.uplinkSecret,
      'rotation produces a new secret',
    )
    const streamwallTokens = db.data.auth.tokens.filter(
      (t) => t.kind === 'streamwall',
    )
    assert.equal(
      streamwallTokens.length,
      1,
      'the superseded uplink token is removed so the old secret stops working',
    )
  })

  test('rejects when persisting a freshly minted uplink token id fails', async () => {
    // A dropped rejection here would strand a token id that exists only in
    // memory, silently rotating the uplink token on every restart (issue #619).
    const db = failingWriteDb(new Error('disk full'))
    const { app, auth } = await initApp({
      baseURL: BASE_URL,
      clientStaticPath: makeStaticDir(),
      db,
      logLevel: 'silent',
      scryptParams: TEST_SCRYPT_PARAMS,
    })
    after(() => app.close())

    await assert.rejects(
      initialInviteCodes({ db, auth, baseURL: BASE_URL }),
      /disk full/,
    )
  })

  test('rejects when scrubbing a legacy plaintext secret fails to persist', async () => {
    // If this write silently fails, the plaintext secret stays on disk while
    // the server carries on as if it had been scrubbed (issue #619).
    const db = failingWriteDb(new Error('read-only volume'))
    const { app, auth } = await initApp({
      baseURL: BASE_URL,
      clientStaticPath: makeStaticDir(),
      db,
      logLevel: 'silent',
      scryptParams: TEST_SCRYPT_PARAMS,
    })
    after(() => app.close())

    // Recreate the pre-fix on-disk shape: a valid hashed uplink token whose
    // storage record still carries the plaintext secret it used to hold.
    const minted = await auth.createToken({
      kind: 'streamwall',
      role: 'admin',
      name: 'Streamwall',
    })
    db.data.streamwallToken = {
      tokenId: minted.tokenId,
      secret: 'legacy-plaintext-secret',
    } as StorageDB['data']['streamwallToken']

    await assert.rejects(
      initialInviteCodes({ db, auth, baseURL: BASE_URL }),
      /read-only volume/,
    )
  })

  test('the surfaced uplink endpoint carries no secret', async () => {
    const db = inMemoryDb()
    const { result } = await boot(db)

    assert.ok(result.uplinkSecret)
    assert.match(result.uplinkEndpoint, /^wss:\/\//)
    assert.equal(
      result.uplinkEndpoint.includes(result.uplinkSecret),
      false,
      'the endpoint string must not embed the secret',
    )
    assert.equal(
      result.uplinkEndpoint.includes('token='),
      false,
      'the endpoint must not carry a token query parameter',
    )
  })
})
