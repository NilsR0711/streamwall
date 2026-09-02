import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import runServer, { registerShutdownHandlers } from './bootstrap.ts'
import type { StorageDB } from './storage.ts'
import {
  captureLogs,
  fakeProcess,
  fakeUpdateChecker,
  inMemoryDb,
  type LogCapture,
} from './testHelpers.ts'

/** The slice of a Fastify instance the shutdown wiring actually uses. */
function fakeApp(close: () => Promise<void>, logs: LogCapture) {
  const record =
    (level: string) =>
    (fields: object, msg?: string): void => {
      logs.stream.write(JSON.stringify({ level, ...fields, msg }))
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
