import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { after, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import runServer, {
  registerShutdownHandlers,
  type ProcessLike,
} from './bootstrap.ts'
import type { StorageDB } from './storage.ts'
import {
  captureLogs,
  fakeUpdateChecker,
  inMemoryDb,
  type LogCapture,
} from './testHelpers.ts'

/**
 * A stand-in for `process`: signals are emitted by the spec and `exit` is
 * recorded instead of tearing the test runner down.
 */
function fakeProcess() {
  const emitter = new EventEmitter()
  const exitCodes: (number | undefined)[] = []
  const proc: ProcessLike & { emit(signal: string): void } = {
    on(signal, listener) {
      emitter.on(signal, listener)
      return proc
    },
    exit(code) {
      exitCodes.push(code)
    },
    emit(signal: string) {
      emitter.emit(signal)
    },
  }
  return { proc, exitCodes, listenerCount: () => emitter.eventNames().length }
}

/** The slice of a Fastify instance the shutdown wiring actually uses. */
function fakeApp(close: () => Promise<void>, logs: LogCapture) {
  const record =
    (level: string) =>
    (fields: unknown, msg?: string): void => {
      const entry =
        typeof fields === 'string'
          ? { level, msg: fields }
          : { level, ...(fields as object), msg }
      logs.stream.write(JSON.stringify(entry))
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
