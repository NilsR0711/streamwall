import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

  test('a signal arriving during init is replayed once the app exists', async () => {
    // `runServer` runs synchronously up to `await initApp`, so a signal emitted
    // right after the call lands in the window where there is no app to close
    // yet. It must not be dropped: as PID 1 the kernel discards a signal only
    // while no handler is installed, and this one is.
    const logs = captureLogs()
    const { proc, exitCodes } = fakeProcess()
    const starting = runServer({
      baseURL: 'http://127.0.0.1:0',
      clientStaticPath: import.meta.dirname,
      db: inMemoryDb(),
      logLevel: 'trace',
      logStream: logs.stream,
      updateChecker: fakeUpdateChecker(),
      process: proc,
    })
    proc.emit('SIGTERM')

    const { server } = await starting
    after(() => server.close())
    await logs.waitForMessage('Shutdown complete', 15000)

    assert.equal(server.listening, false)
    assert.deepEqual(exitCodes, [0])
  })

  test('a signal during a slow init force-exits within one budget of the signal, not two', async () => {
    // Issue #823: the force-exit budget used to be armed twice in series
    // for exactly this path -- once by the init-window listener above, then
    // again from scratch once `registerShutdownHandlers` took over -- so a
    // signal landing during a slow `initApp` (a `mkdir` or first write
    // wedged on an unresponsive volume) could take up to roughly double the
    // documented budget before the process gave up, well past Docker's stop
    // grace period.
    const db = inMemoryDb() as StorageDB
    // The boot mints the uplink token via `db.update`, which this hangs
    // forever, so `beforeClose` (the boot) never settles and the shutdown's
    // own force-exit timer is what has to fire -- the wedged-shutdown case
    // the budget exists for.
    db.write = () => new Promise<void>(() => {})

    const { proc } = fakeProcess()
    // Wide margins on purpose: `initDelayMs` only needs to land the signal
    // before `initApp` resolves, and the gap between it and
    // `forceExitAfterMs` has to comfortably outlast whatever `initApp`
    // (Fastify setup, route registration) actually takes on a loaded CI
    // runner, well clear of the 500ms floor `remainingForceExitMs` applies.
    const forceExitAfterMs = 3000
    const initDelayMs = 1500
    const exitTimes: number[] = []
    proc.exit = () => {
      exitTimes.push(Date.now())
    }

    const signalledAt = Date.now()
    void runServer({
      baseURL: 'http://127.0.0.1:0',
      clientStaticPath: import.meta.dirname,
      db,
      logLevel: 'silent',
      updateChecker: fakeUpdateChecker(),
      process: proc,
      forceExitAfterMs,
      initDelayMs,
    })
    // `runServer` runs synchronously up to the init delay, so the signal
    // listeners are already attached by the time this line runs -- still
    // well inside the delayed init window.
    proc.emit('SIGTERM')

    // Long enough to observe the force-exit even under the old, doubled
    // budget (initDelayMs + forceExitAfterMs, roughly).
    await delay(initDelayMs + forceExitAfterMs + 500)

    assert.equal(
      exitTimes.length,
      1,
      'the process must force-exit exactly once',
    )
    const elapsedFromSignal = exitTimes[0] - signalledAt
    assert.ok(
      elapsedFromSignal < forceExitAfterMs + 400,
      `expected a single ~${forceExitAfterMs}ms budget measured from the ` +
        `signal, took ${elapsedFromSignal}ms (a doubled budget would take ` +
        `roughly ${initDelayMs + forceExitAfterMs}ms)`,
    )
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

  test('the storage flush completes before the process exits', async () => {
    // Starting the flush is not enough: auth persistence is fire-and-forget, so
    // a shutdown that exits while the write is still in flight truncates
    // exactly the state it was supposed to save.
    const db = inMemoryDb() as StorageDB
    const { proc, exitCodes } = fakeProcess()
    const events: string[] = []
    const realWrite = db.write.bind(db)
    let booted = false
    db.write = async () => {
      if (booted) {
        events.push('flush:start')
        await delay(50)
        await realWrite()
        events.push('flush:done')
        return
      }
      return realWrite()
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
    booted = true

    proc.emit('SIGTERM')
    await logs.waitForMessage('Shutdown complete', 10000)

    assert.deepEqual(
      events,
      ['flush:start', 'flush:done', 'exit:0'],
      'the flush must have landed before the process exited',
    )
  })
})

test(
  'a real SIGTERM to the entry point exits 0 and leaves storage intact',
  {
    // Windows has no POSIX signals: `kill('SIGTERM')` there is an unconditional
    // TerminateProcess, so there is no graceful path to observe.
    skip: process.platform === 'win32' ? 'POSIX signals only' : false,
  },
  async () => {
    // The specs above inject a fake process, which is what keeps the handlers off
    // the test runner — but that also means nothing exercises the default
    // binding to the real `process`, or the real `process.exit`. This one boots
    // the entry point as a child and signals it the way a container stop does.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sw-shutdown-'))
    const dbPath = path.join(dataDir, 'storage.json')
    // Launched exactly the way the image's CMD does — `node <entry>`, on Node's
    // own type stripping — so this covers the same invocation a container stops.
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, 'index.ts')],
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
    after(() => {
      child.kill('SIGKILL')
      rmSync(dataDir, { recursive: true, force: true })
    })

    // Both streams are drained: an unread pipe blocks the child once it fills,
    // and stderr is what says why a boot died.
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

    // The credential banner is the last thing the boot prints, so seeing it
    // means the server is up and the signal lands on a running process. Matched
    // against everything received so far, since a pipe splits where it likes.
    //
    // The wait is bounded well under the file's 120000ms `--test-timeout`
    // (#804/#537): a real child process spawn plus a scrypt-hashed token boot
    // measurably needs more than 30s of wall clock on a machine running many
    // `node --test` files (each its own process) concurrently, and letting the
    // *outer* per-test timeout win that race instead of this one turns a
    // readable "never finished booting" failure into an unattributed
    // `testTimeoutFailure` that reports no failing subtest at all.
    await new Promise<void>((resolve, reject) => {
      const fail = (reason: string) =>
        reject(new Error(`${reason}\nstdout: ${stdout}\nstderr: ${stderr}`))
      const timer = setTimeout(
        () => fail('the server never finished booting'),
        45000,
      )
      child.on('error', (err) =>
        fail(`the server could not be spawned: ${err}`),
      )
      child.on('exit', (code) => fail(`the server exited early with ${code}`))
      child.stdout.on('data', () => {
        if (stdout.includes('Admin invite')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    child.removeAllListeners('exit')
    child.kill('SIGTERM')
    const [code] = (await once(child, 'exit')) as [number | null, string | null]

    assert.equal(code, 0, `a stop signal must produce a clean exit\n${stderr}`)
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(dbPath, 'utf8')),
      'the storage file must survive the shutdown intact',
    )
  },
)
