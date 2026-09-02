import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import runServer, { registerShutdownHandlers } from './bootstrap.ts'
import type { StorageDB } from './storage.ts'
import {
  captureLogs,
  fakeProcess,
  fakeUpdateChecker,
  inMemoryDb,
  makeStaticDir,
  type LogCapture,
} from './testHelpers.ts'

/** The slice of a Fastify instance the shutdown wiring actually uses. */
function fakeApp(close: () => Promise<void>, logs: LogCapture) {
  const record =
    (level: string) =>
    (fields: object, msg?: string): void => {
      // Errors are flattened the way pino's standard serializer does, so a
      // spec can assert on what an operator would actually read.
      const { err, ...rest } = fields as { err?: unknown }
      logs.stream.write(
        JSON.stringify({
          level,
          ...rest,
          ...(err instanceof Error && { err: { message: err.message } }),
          msg,
        }),
      )
    }
  let closeCalls = 0
  return {
    app: {
      log: {
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
      },
      close: () => {
        closeCalls += 1
        return close()
      },
    },
    calls: () => closeCalls,
  }
}

describe('registerShutdownHandlers', () => {
  test('closes the app and exits 0 on SIGTERM', async () => {
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    const { app, calls } = fakeApp(() => Promise.resolve(), logs)

    registerShutdownHandlers({ app, process: proc })
    proc.emit('SIGTERM')
    await logs.waitForMessage('Shutdown complete')

    assert.equal(calls(), 1, 'the app must be closed exactly once')
    assert.deepEqual(exitCodes, [0])
  })

  test('closes the app and exits 0 on SIGINT', async () => {
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    const { app, calls } = fakeApp(() => Promise.resolve(), logs)

    registerShutdownHandlers({ app, process: proc })
    proc.emit('SIGINT')
    await logs.waitForMessage('Shutdown complete')

    assert.equal(calls(), 1)
    assert.deepEqual(exitCodes, [0])
  })

  test('a second signal never starts a second shutdown', async () => {
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    let release = () => {}
    const closing = new Promise<void>((resolve) => {
      release = resolve
    })
    const { app, calls } = fakeApp(() => closing, logs)

    registerShutdownHandlers({ app, process: proc })
    proc.emit('SIGTERM')
    proc.emit('SIGINT')
    await logs.waitForMessage('Shutdown already in progress')
    release()
    await logs.waitForMessage('Shutdown complete')

    assert.equal(
      calls(),
      1,
      'close() must not be re-entered by a second signal',
    )
    assert.deepEqual(exitCodes, [0], 'the process must be exited exactly once')
  })

  test('exits non-zero when the shutdown exceeds its budget', async () => {
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    // A close that never settles: without the fallback the process would hang
    // until the supervisor escalates to SIGKILL.
    const { app } = fakeApp(() => new Promise<void>(() => {}), logs)

    registerShutdownHandlers({ app, process: proc, forceExitAfterMs: 20 })
    proc.emit('SIGTERM')
    await logs.waitForMessage('Shutdown timed out')

    assert.deepEqual(exitCodes, [1])
  })

  test('still tears down when the boot fails, but never reports it as clean', async () => {
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    const { app, calls } = fakeApp(() => Promise.resolve(), logs)

    registerShutdownHandlers({
      app,
      process: proc,
      beforeClose: () => Promise.reject(new Error('listen: EADDRINUSE')),
    })
    proc.emit('SIGTERM')
    const entry = await logs.waitForMessage('the boot had failed')

    assert.equal(calls(), 1, 'a failed boot must still be torn down')
    assert.match(JSON.stringify(entry.err), /EADDRINUSE/)
    assert.deepEqual(exitCodes, [1])
  })

  test('exits non-zero when closing fails, and reports the error', async () => {
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    const { app } = fakeApp(
      () => Promise.reject(new Error('close blew up')),
      logs,
    )

    registerShutdownHandlers({ app, process: proc })
    proc.emit('SIGTERM')
    await logs.waitForMessage('Shutdown failed')
    assert.deepEqual(exitCodes, [1])
  })
})

describe('runServer shutdown wiring', () => {
  test('a SIGTERM stops the listening server and exits 0', async () => {
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    const { server } = await runServer({
      baseURL: 'http://127.0.0.1:0',
      clientStaticPath: import.meta.dirname,
      db: inMemoryDb(),
      logLevel: 'trace',
      logStream: logs.stream,
      updateChecker: fakeUpdateChecker(),
      process: proc,
    })
    after(() => server.close())
    assert.ok(server.listening)

    proc.emit('SIGTERM')
    await logs.waitForMessage('Shutdown complete', 10000)

    assert.equal(
      server.listening,
      false,
      'the server must have stopped listening',
    )
    assert.deepEqual(exitCodes, [0])
  })

  test('a signal during the boot waits for the boot to finish writing', async () => {
    // Minting the uplink token is a scrypt derivation plus persisted writes,
    // so a container stop can easily land inside the boot. Exiting on top of
    // those writes is exactly the truncated storage.json #751 is about.
    const db = inMemoryDb() as StorageDB
    const { proc, exitCodes } = fakeProcess()
    const events: string[] = []
    const realUpdate = db.update.bind(db)
    let signalled = false
    db.update = async (fn) => {
      if (!signalled) {
        signalled = true
        // The boot's very first write is in flight: stop the server now.
        proc.emit('SIGTERM')
      }
      events.push('write:start')
      await delay(20)
      await realUpdate(fn)
      events.push('write:done')
    }
    proc.exit = (code) => {
      events.push(`exit:${code}`)
      exitCodes.push(code)
    }

    const logs = captureLogs()
    const { server } = await runServer({
      baseURL: 'http://127.0.0.1:0',
      clientStaticPath: import.meta.dirname,
      db,
      logLevel: 'trace',
      logStream: logs.stream,
      updateChecker: fakeUpdateChecker(),
      process: proc,
    })
    after(() => server.close())
    await logs.waitForMessage('Shutdown complete', 10000)

    assert.ok(
      events.indexOf('write:done') < events.indexOf('exit:0'),
      `the boot's writes must land before the process exits, got ${events.join(', ')}`,
    )
    assert.deepEqual(exitCodes, [0])
  })

  test('closing flushes storage, so a queued auth write cannot be lost', async () => {
    const db = inMemoryDb() as StorageDB
    let writes = 0
    const realWrite = db.write.bind(db)
    db.write = async () => {
      writes += 1
      await delay(5)
      return realWrite()
    }

    const logs = captureLogs()
    const { proc } = fakeProcess()
    const { server } = await runServer({
      baseURL: 'http://127.0.0.1:0',
      clientStaticPath: import.meta.dirname,
      db,
      logLevel: 'trace',
      logStream: logs.stream,
      updateChecker: fakeUpdateChecker(),
      process: proc,
    })
    after(() => server.close())

    const before = writes
    proc.emit('SIGTERM')
    await logs.waitForMessage('Shutdown complete', 10000)

    assert.ok(
      writes > before,
      'shutdown must flush storage rather than leave a fire-and-forget write in flight',
    )
  })
})

test('a real SIGTERM to the entry point exits 0 and leaves storage intact', async () => {
  // The specs above inject a fake process, which is what keeps the handlers off
  // the test runner — but that also means nothing exercises the default
  // binding to the real `process`, or the real `process.exit`. This one boots
  // the entry point as a child and signals it the way a container stop does.
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sw-shutdown-'))
  const dbPath = path.join(dataDir, 'storage.json')
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(import.meta.dirname, 'index.ts')],
    {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        LOG_LEVEL: 'info',
        STREAMWALL_CONTROL_URL: 'http://127.0.0.1:0',
        STREAMWALL_CONTROL_STATIC: makeStaticDir(),
        STREAMWALL_UPDATE_CHECK: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  after(() => child.kill('SIGKILL'))

  // The credential banner is the last thing the boot prints, so seeing it
  // means the server is up and the signal lands on a running process.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the server never finished booting')),
      30000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Admin invite')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  child.kill('SIGTERM')
  const [code] = (await once(child, 'exit')) as [number | null, string | null]

  assert.equal(code, 0, 'a stop signal must produce a clean exit')
  assert.doesNotThrow(
    () => JSON.parse(readFileSync(dbPath, 'utf8')),
    'the storage file must survive the shutdown intact',
  )
})
