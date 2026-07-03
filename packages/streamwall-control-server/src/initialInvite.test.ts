import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { Auth } from './auth.ts'
import { initialInviteCodes } from './index.ts'
import { loadStorage } from './storage.ts'

const ENV_KEY = 'STREAMWALL_CONTROL_NEW_ADMIN_INVITE'

async function makeAuthDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'swcs-invite-'))
  const db = await loadStorage(path.join(dir, 'storage.json'))
  const auth = new Auth(db.data.auth)
  return { db, auth, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function runCapturing(args: {
  db: Awaited<ReturnType<typeof makeAuthDb>>['db']
  auth: Auth
  baseURL: string
}): Promise<string[]> {
  const logs: string[] = []
  await initialInviteCodes({
    ...args,
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
  })
  return logs
}

function adminInvites(auth: Auth) {
  return auth.getState().invites.filter((t) => t.role === 'admin')
}

function loggedInviteLinks(logs: string[]) {
  return logs.filter((line) => line.includes('/invite/'))
}

describe('initialInviteCodes admin bootstrap', () => {
  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  test('mints and logs an admin invite on first run', async () => {
    const { db, auth, cleanup } = await makeAuthDb()
    try {
      const logs = await runCapturing({ db, auth, baseURL: 'http://localhost:3000' })
      assert.equal(adminInvites(auth).length, 1)
      assert.equal(loggedInviteLinks(logs).length, 1)
    } finally {
      cleanup()
    }
  })

  test('does not mint or log a new admin invite when an admin session exists', async () => {
    const { db, auth, cleanup } = await makeAuthDb()
    try {
      await auth.createToken({ kind: 'session', role: 'admin', name: 'Admin' })
      const logs = await runCapturing({ db, auth, baseURL: 'http://localhost:3000' })
      assert.equal(adminInvites(auth).length, 0)
      assert.equal(loggedInviteLinks(logs).length, 0)
    } finally {
      cleanup()
    }
  })

  test('does not reprint or duplicate a still-pending admin invite on restart', async () => {
    const { db, auth, cleanup } = await makeAuthDb()
    try {
      await initialInviteCodes({
        db,
        auth,
        baseURL: 'http://localhost:3000',
        log: () => {},
      })
      const logs = await runCapturing({ db, auth, baseURL: 'http://localhost:3000' })
      assert.equal(adminInvites(auth).length, 1, 'must not duplicate the invite')
      assert.equal(
        loggedInviteLinks(logs).length,
        0,
        'the secret must not be reprinted',
      )
    } finally {
      cleanup()
    }
  })

  test('env flag forces a fresh admin invite even when an admin session exists', async () => {
    const { db, auth, cleanup } = await makeAuthDb()
    try {
      await auth.createToken({ kind: 'session', role: 'admin', name: 'Admin' })
      process.env[ENV_KEY] = '1'
      const logs = await runCapturing({ db, auth, baseURL: 'http://localhost:3000' })
      assert.equal(adminInvites(auth).length, 1)
      assert.equal(loggedInviteLinks(logs).length, 1)
    } finally {
      cleanup()
    }
  })

  test('reuses the persisted uplink token across restarts', async () => {
    const { db, auth, cleanup } = await makeAuthDb()
    try {
      await initialInviteCodes({
        db,
        auth,
        baseURL: 'http://localhost:3000',
        log: () => {},
      })
      const firstTokenId = db.data.streamwallToken?.tokenId
      assert.ok(firstTokenId)

      await initialInviteCodes({
        db,
        auth,
        baseURL: 'http://localhost:3000',
        log: () => {},
      })
      assert.equal(db.data.streamwallToken?.tokenId, firstTokenId)
    } finally {
      cleanup()
    }
  })
})
