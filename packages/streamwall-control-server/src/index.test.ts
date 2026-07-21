import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { DEFAULT_SCRYPT_PARAMS } from './auth.ts'
import runServer, {
  initApp,
  resolveListenPort,
  SESSION_COOKIE_NAME,
} from './index.ts'
import { captureLogs, inMemoryDb } from './testHelpers.ts'
import type { UpdateChecker, UpdateStatus } from './updateCheck.ts'

const ONE_YEAR_IN_SECONDS = 365 * 24 * 60 * 60

/** Stub `UpdateChecker` so specs never reach GitHub. */
function fakeUpdateChecker(): UpdateChecker {
  const status: UpdateStatus = {
    version: 'test',
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    lastCheckedAt: null,
    checkEnabled: false,
  }
  return {
    getStatus: () => status,
    checkNow: async () => status,
    start: async () => {},
    stop: () => {},
  }
}

/**
 * Build an isolated control-server app backed by in-memory storage, mint a
 * fresh invite token and redeem it via `POST /invite/:id` (the secret travels
 * in the body, never the URL). Returns the raw `Set-Cookie` header produced for
 * the resulting session cookie.
 */
async function redeemInvite(baseURL: string) {
  const { app, auth } = await initApp({
    baseURL,
    clientStaticPath: import.meta.dirname,
    db: inMemoryDb(),
  })
  after(() => app.close())

  const { tokenId, secret } = await auth.createToken({
    kind: 'invite',
    role: 'admin',
    name: 'Test invite',
  })

  const response = await app.inject({
    method: 'POST',
    url: `/invite/${tokenId}`,
    headers: { 'content-type': 'application/json' },
    payload: { token: secret },
  })

  const rawSetCookie = response.headers['set-cookie']
  const setCookie = Array.isArray(rawSetCookie)
    ? rawSetCookie.join('\n')
    : String(rawSetCookie ?? '')

  return { app, auth, response, setCookie }
}

describe('session cookie security attributes', () => {
  test('Max-Age is one year expressed in seconds (not milliseconds)', async () => {
    const { setCookie } = await redeemInvite('http://localhost:3000')

    const match = setCookie.match(/Max-Age=(\d+)/i)
    assert.ok(match, 'session cookie should carry a Max-Age attribute')
    assert.equal(
      Number(match[1]),
      ONE_YEAR_IN_SECONDS,
      'Max-Age must be in seconds; a ms value yields an effectively permanent cookie',
    )
  })

  test('SameSite=Strict is set on the session cookie', async () => {
    const { setCookie } = await redeemInvite('http://localhost:3000')
    assert.match(setCookie, /SameSite=Strict/i)
  })

  test('session cookie stays HttpOnly and scoped to /', async () => {
    const { setCookie } = await redeemInvite('http://localhost:3000')
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=`))
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /Path=\//i)
  })

  test('session cookie is marked Secure when served over https', async () => {
    const { setCookie } = await redeemInvite('https://localhost:3000')
    assert.match(setCookie, /Secure/i)
    const match = setCookie.match(/Max-Age=(\d+)/i)
    assert.ok(match)
    assert.equal(Number(match[1]), ONE_YEAR_IN_SECONDS)
    assert.match(setCookie, /SameSite=Strict/i)
  })

  test('an invalid invite token is rejected without setting a cookie', async () => {
    const { app } = await initApp({
      baseURL: 'http://localhost:3000',
      clientStaticPath: import.meta.dirname,
      db: inMemoryDb(),
    })
    after(() => app.close())

    const response = await app.inject({
      method: 'POST',
      url: '/invite/does-not-exist',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'bogus' },
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.headers['set-cookie'], undefined)
  })
})

test('initApp keeps the production scrypt work factor unless one is injected', async () => {
  // `scryptParams` exists so tests can pay a cheap derivation; a real
  // deployment must never end up with a lowered work factor by omission.
  const { app, auth } = await initApp({
    baseURL: 'http://localhost:3000',
    clientStaticPath: import.meta.dirname,
    db: inMemoryDb(),
  })
  after(() => app.close())

  assert.deepEqual(auth.scryptParams, DEFAULT_SCRYPT_PARAMS)
})

describe('runServer', () => {
  test('starts for real via app.listen() without throwing (issue #442)', async () => {
    // Regression test: `fastify.inject()` (used by every other spec in this
    // file) drives the app *before* it ever listens, so a hook registered
    // after `app.listen()` slips past the whole suite. Only a real
    // `app.listen()` call reproduces FST_ERR_INSTANCE_ALREADY_LISTENING.
    const { server } = await runServer({
      baseURL: 'http://127.0.0.1:0',
      clientStaticPath: import.meta.dirname,
      db: inMemoryDb(),
      updateChecker: fakeUpdateChecker(),
    })
    after(() => {
      server.close()
    })

    assert.ok(
      server.listening,
      'server should be listening after runServer resolves',
    )
  })

  test('writes its startup diagnostics to the structured logger (issue #493)', async () => {
    const logs = captureLogs()
    const consoleCalls: unknown[][] = []
    const originalLog = console.log
    const originalDebug = console.debug
    console.log = (...args: unknown[]) => {
      consoleCalls.push(args)
    }
    console.debug = (...args: unknown[]) => {
      consoleCalls.push(args)
    }
    let server: { close(): void }
    try {
      ;({ server } = await runServer({
        baseURL: 'http://127.0.0.1:0',
        clientStaticPath: import.meta.dirname,
        db: inMemoryDb(),
        logLevel: 'trace',
        logStream: logs.stream,
        updateChecker: fakeUpdateChecker(),
      }))
    } finally {
      console.log = originalLog
      console.debug = originalDebug
    }
    after(() => server.close())

    const starting = logs.entries.find(
      (e) => e.msg === 'Starting streamwall-control-server',
    )
    assert.ok(starting, 'the startup banner must be a structured entry')
    assert.equal(typeof starting.version, 'string')

    const initializing = logs.entries.find(
      (e) => e.msg === 'Initializing web server',
    )
    assert.ok(initializing, 'the listen diagnostics must be a structured entry')
    assert.equal(initializing.hostname, '127.0.0.1')
    assert.equal(typeof initializing.port, 'number')

    // The credential banner (`logBootstrap`) stays on `console` by design, so
    // only the two startup diagnostics must have moved off it.
    const startupOnConsole = consoleCalls.filter((args) =>
      String(args[0]).match(/Starting streamwall-control-server|web server/),
    )
    assert.deepEqual(startupOnConsole, [])
  })
})

describe('resolveListenPort', () => {
  test('https URL with no explicit port defaults to 443 (not 0)', () => {
    assert.equal(resolveListenPort('https://wall.example.com'), 443)
  })

  test('http URL with no explicit port defaults to 80 (not 0)', () => {
    assert.equal(resolveListenPort('http://wall.example.com'), 80)
  })

  test('explicit URL port is used when present', () => {
    assert.equal(resolveListenPort('https://wall.example.com:8443'), 8443)
    assert.equal(resolveListenPort('http://localhost:3000'), 3000)
  })

  test('override port wins over URL (including scheme default)', () => {
    assert.equal(resolveListenPort('https://wall.example.com', '8080'), 8080)
    assert.equal(
      resolveListenPort('https://wall.example.com:8443', '9090'),
      9090,
    )
  })

  test('empty override falls through to URL / scheme default', () => {
    assert.equal(resolveListenPort('https://wall.example.com', ''), 443)
    assert.equal(resolveListenPort('https://wall.example.com', '   '), 443)
    assert.equal(resolveListenPort('http://localhost:3000', ''), 3000)
  })
})
