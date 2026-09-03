import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { inviteLink } from 'streamwall-shared'
import type { Auth } from './auth.ts'
import { resolveListenPort } from './config.ts'
import { type AppOptions, initApp } from './index.ts'
import type { LogLevel } from './logger.ts'
import type { StorageDB } from './storage.ts'
import { SERVER_VERSION, type UpdateChecker } from './updateCheck.ts'

/** Builds the uplink WebSocket endpoint URL, which never embeds the secret. */
function uplinkEndpointURL(baseURL: string, tokenId: string) {
  return `${baseURL.replace(/^http/, 'ws')}/streamwall/${tokenId}/ws`
}

export interface BootstrapResult {
  /**
   * The plaintext uplink secret, exposed *only* when the token was freshly
   * minted. `null` on a restart, where the secret is unrecoverable by design.
   */
  uplinkSecret: string | null
  /** The uplink WebSocket endpoint (never carries the secret). */
  uplinkEndpoint: string
  /** A fresh single-use admin invite link (regenerated every startup). */
  adminInviteLink: string
}

export async function initialInviteCodes({
  db,
  auth,
  baseURL,
}: {
  db: StorageDB
  auth: Auth
  baseURL: string
}): Promise<BootstrapResult> {
  // The uplink token is validated against its scrypt hash in `auth.tokens`,
  // exactly like session and invite tokens. We persist only its id; the
  // plaintext secret is shown once, at creation, and never written to disk.
  const record = db.data.streamwallToken
  const hasValidUplinkToken =
    record != null && auth.tokensById.has(record.tokenId)

  let uplinkSecret: string | null = null
  let uplinkTokenId: string

  if (hasValidUplinkToken) {
    uplinkTokenId = record.tokenId
    // Scrub any plaintext secret a pre-fix server version may have persisted
    // alongside the id, so it stops leaking through storage.json.
    if ((record as { secret?: string }).secret !== undefined) {
      // Awaited so a failed scrub write surfaces at startup instead of being
      // silently dropped, leaving the plaintext secret on disk (issue #619).
      await db.update((data) => {
        data.streamwallToken = { tokenId: uplinkTokenId }
      })
    }
  } else {
    // Minting a fresh uplink token (first run, or a rotation triggered by
    // clearing the stored record). Delete any superseded uplink tokens first so
    // an old secret can never authenticate again.
    for (const token of [...auth.tokensById.values()]) {
      if (token.kind === 'streamwall') {
        auth.deleteToken(token.tokenId)
      }
    }
    const minted = await auth.createToken({
      kind: 'streamwall',
      role: 'admin',
      name: 'Streamwall',
    })
    uplinkSecret = minted.secret
    uplinkTokenId = minted.tokenId
    // Awaited so an unwritable storage fails the boot loudly: dropping this
    // rejection would strand a token id that only exists in memory, forcing a
    // silent uplink-token rotation on every restart (issue #619).
    await db.update((data) => {
      data.streamwallToken = { tokenId: minted.tokenId }
    })
  }

  // Invalidate any existing admin invites and create a new one:
  for (const adminToken of auth
    .getState()
    .invites.filter(({ role }) => role === 'admin')) {
    auth.deleteToken(adminToken.tokenId)
  }
  const adminToken = await auth.createToken({
    kind: 'invite',
    role: 'admin',
    name: 'Server admin',
  })

  return {
    uplinkSecret,
    uplinkEndpoint: uplinkEndpointURL(baseURL, uplinkTokenId),
    adminInviteLink: inviteLink({
      baseURL,
      tokenId: adminToken.tokenId,
      secret: adminToken.secret,
    }),
  }
}

/**
 * Logs the bootstrap credentials to stdout. The uplink secret is printed only
 * when it was just minted (shown once); on subsequent starts we print the
 * endpoint without it and point the operator at how to rotate.
 *
 * Deliberately written to `console` rather than the structured logger: this
 * banner is the operator's only chance to copy these credentials, so it must
 * stay visible whatever `LOG_LEVEL` is set to (issue #410).
 */
export function logBootstrap({
  uplinkSecret,
  uplinkEndpoint,
  adminInviteLink,
}: BootstrapResult) {
  if (uplinkSecret) {
    console.log(
      '🔌 Streamwall uplink (shown once — save it now):',
      `${uplinkEndpoint}?token=${uplinkSecret}`,
    )
  } else {
    console.log('🔌 Streamwall uplink endpoint:', uplinkEndpoint)
    console.log(
      '   (the uplink secret is shown only at creation; to rotate it, clear ' +
        '"streamwallToken" in storage.json and restart)',
    )
  }
  console.log('🔑 Admin invite:', adminInviteLink)
}

/** The slice of `process` the shutdown wiring uses, so specs can inject one. */
export interface ProcessLike {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
  exit(code?: number): void
}

/** The slice of a Fastify instance the shutdown wiring uses. */
interface ClosableApp {
  log: {
    info(fields: object, msg?: string): void
    warn(fields: object, msg?: string): void
    error(fields: object, msg?: string): void
  }
  close(): Promise<void>
}

/**
 * How long a shutdown may take before the process exits anyway. Kept just
 * under Docker's default ten-second stop grace period, so a wedged shutdown
 * still exits with a logged reason instead of being SIGKILLed unannounced.
 */
export const DEFAULT_FORCE_EXIT_MS = 8_000

/**
 * Terminates the server on `SIGTERM`/`SIGINT` instead of letting the runtime
 * kill it outright: `app.close()` runs the `onClose` hooks (update-checker
 * teardown, storage flush) and sends WebSocket peers a close frame rather than
 * a TCP reset (issue #751).
 *
 * The shutdown runs at most once, so the second signal an impatient operator
 * sends cannot re-enter it, and a close that gets stuck still exits by way of
 * the force-exit timer.
 *
 * `beforeClose` lets the caller finish work the instance knows nothing about
 * (the boot, which is still minting and persisting tokens) before the teardown
 * runs; a rejection there is ignored, since a failed boot must not keep the
 * process alive. `flush` then persists whatever that work left queued, ahead of
 * draining connections and — unlike a Fastify hook — genuinely awaited. The
 * force-exit timer bounds both waits.
 */
export function registerShutdownHandlers({
  app,
  process: proc,
  forceExitAfterMs = DEFAULT_FORCE_EXIT_MS,
  beforeClose,
  flush,
}: {
  app: ClosableApp
  process: ProcessLike
  forceExitAfterMs?: number
  beforeClose?: () => Promise<unknown>
  flush?: () => Promise<void>
}): {
  isShuttingDown: () => boolean
  shutdown: (signal: 'SIGTERM' | 'SIGINT') => void
} {
  let shuttingDown = false

  const shutdown = (signal: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) {
      app.log.warn({ signal }, 'Shutdown already in progress, ignoring signal')
      return
    }
    shuttingDown = true
    app.log.info({ signal }, 'Shutting down')

    // Deliberately not unref'd: a wedged `close()` can leave nothing but
    // pending promises behind, and an unref'd timer would let the process
    // slip out with code 0 instead of reporting the timeout. Both settle
    // paths clear it, so it can never hold an orderly shutdown open.
    const forceExit = setTimeout(() => {
      app.log.error({ signal, forceExitAfterMs }, 'Shutdown timed out, exiting')
      proc.exit(1)
    }, forceExitAfterMs)

    let bootError: unknown = null
    const closed = (async () => {
      if (beforeClose) {
        try {
          await beforeClose()
        } catch (err) {
          // A boot that failed has nothing left to protect, so the teardown
          // still runs — but the process must not report a clean stop for it.
          bootError = err
        }
      }
      if (flush) {
        await flush()
      }
      await app.close()
    })()

    void closed.then(
      () => {
        clearTimeout(forceExit)
        if (bootError !== null) {
          app.log.error(
            { err: bootError, signal },
            'Shutdown complete, but the boot had failed',
          )
          proc.exit(1)
          return
        }
        app.log.info({ signal }, 'Shutdown complete')
        proc.exit(0)
      },
      (err: unknown) => {
        clearTimeout(forceExit)
        app.log.error({ err, signal }, 'Shutdown failed')
        proc.exit(1)
      },
    )
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.on(signal, () => shutdown(signal))
  }

  // `isShuttingDown` lets the caller skip work it would otherwise start on top
  // of a teardown that is already running; `shutdown` lets it replay a signal
  // that arrived before the app existed.
  return { isShuttingDown: () => shuttingDown, shutdown }
}

export default async function runServer({
  port: overridePort,
  hostname: overrideHostname,
  baseURL,
  clientStaticPath,
  db: injectedDb,
  logLevel,
  logStream,
  updateChecker: injectedUpdateChecker,
  process: proc = process,
  forceExitAfterMs = DEFAULT_FORCE_EXIT_MS,
  initDelayMs,
}: AppOptions & {
  hostname?: string
  port?: string
  /** Test-only override for the signal source and exit path. */
  process?: ProcessLike
  /** Test-only override so specs can exercise the real listen() path without touching disk. */
  db?: StorageDB
  /** Overrides the level from `LOG_LEVEL` (used by tests to silence or widen output). */
  logLevel?: LogLevel
  /** Test-only sink for log output; defaults to pino's stdout destination. */
  logStream?: { write(line: string): void }
  /** Test-only override so specs can exercise the real listen() path without reaching GitHub. */
  updateChecker?: UpdateChecker
  /**
   * Test-only override for the force-exit budget. Bounds the init-window
   * listener below and, once a signal replays into it, the shutdown timer
   * `registerShutdownHandlers` arms further down -- the same single deadline,
   * measured from whenever the signal actually arrived (issue #823), not two
   * budgets armed one after the other.
   */
  forceExitAfterMs?: number
  /** Test-only delay inserted before `initApp`, so a spec can land a signal deterministically inside the init window. */
  initDelayMs?: number
}) {
  const url = new URL(baseURL)
  const hostname = overrideHostname ?? url.hostname
  const port = resolveListenPort(baseURL, overridePort)

  // As PID 1 in a container the kernel drops a signal for which no handler is
  // installed, so a `docker stop` during `initApp` — which creates the storage
  // directory and may write the default storage.json — would be ignored
  // outright until the grace period expires. Catch it here and replay it into
  // the real handler as soon as there is an app to shut down.
  //
  // Installing a listener also suppresses the default disposition everywhere
  // else, so this one arms a deadline of its own: a `mkdir` or first write
  // wedged on an unresponsive volume must not leave the process unkillable,
  // and a second signal in that window gives up immediately — nothing has been
  // built yet that could be flushed. The timestamp of that first signal is
  // recorded so the deadline below can be measured from it rather than from
  // whenever `registerShutdownHandlers` happens to take over -- otherwise the
  // budget effectively gets armed twice in series (issue #823).
  let signalDuringInit: 'SIGTERM' | 'SIGINT' | null = null
  let signalledDuringInitAt: number | undefined
  let initDeadline: ReturnType<typeof setTimeout> | undefined
  const initListeners = (['SIGTERM', 'SIGINT'] as const).map((signal) => {
    const listener = () => {
      if (signalDuringInit !== null) {
        proc.exit(1)
        return
      }
      signalDuringInit = signal
      signalledDuringInitAt = Date.now()
      initDeadline = setTimeout(() => proc.exit(1), forceExitAfterMs)
    }
    proc.on(signal, listener)
    return { signal, listener }
  })

  // Test-only: lets a spec land a signal deterministically inside the window
  // above, simulating a slow `mkdir`/first write without actually needing one.
  if (initDelayMs) {
    await delay(initDelayMs)
  }

  // The startup diagnostics below run *after* `initApp` purely so they can go
  // through `app.log`: they belong in the structured stream like every other
  // server diagnostic, and the logger only exists once Fastify does (#493).
  const { app, db, auth, updateChecker, reportCaughtError } = await initApp({
    baseURL,
    clientStaticPath,
    db: injectedDb,
    logLevel,
    logStream,
    updateChecker: injectedUpdateChecker,
  })

  app.log.info(
    { version: SERVER_VERSION },
    'Starting streamwall-control-server',
  )
  app.log.debug({ hostname, port }, 'Initializing web server')

  // Hooks must be registered before the instance starts listening -- Fastify 5
  // throws FST_ERR_INSTANCE_ALREADY_LISTENING otherwise (issue #442).
  app.addHook('onClose', async () => {
    updateChecker.stop()
  })

  // Auth persistence is fire-and-forget (`auth.on('state')` in `initApp`) and
  // storage writes are serialized, so one more write drains whatever is still
  // queued instead of letting a shutdown truncate it.
  //
  // It is driven from the shutdown path rather than from a Fastify hook: an
  // `onClose` hook runs only after connections have drained, which a peer with
  // a dead TCP path can stall past the force-exit budget, and a `preClose` hook
  // is not reliably awaited — `@fastify/websocket`'s own `preClose` calls its
  // `done` twice, letting `app.close()` resolve while a later hook is still
  // running. A storage that is already failing must not turn an orderly
  // shutdown into a crash, so it is reported the way the fire-and-forget writes
  // are.
  const flushStorage = async () => {
    try {
      await db.write()
    } catch (err) {
      app.log.error({ err }, 'Failed to flush storage during shutdown')
      reportCaughtError(err)
    }
  }

  // The rest of the boot runs as one awaitable unit so the shutdown handlers
  // can be armed before it starts: a stop signal arriving during a slow start
  // — minting the uplink token is a scrypt derivation plus two storage writes
  // — then waits for those writes to land instead of exiting on top of them.
  const boot = (async () => {
    const bootstrap = await initialInviteCodes({ db, auth, baseURL })
    logBootstrap(bootstrap)
    await app.listen({ port, host: hostname })
  })()

  // A signal that arrived during init already spent part of the force-exit
  // budget waiting for init itself to finish; the shutdown timer below gets
  // whatever is left of that one budget, not a fresh one, so the two stages
  // together never take longer than `forceExitAfterMs` measured from the
  // signal (issue #823). The floor keeps a signal that arrived right at the
  // edge of the budget from arming an effectively-zero deadline.
  const remainingForceExitMs =
    signalledDuringInitAt !== undefined
      ? Math.max(500, forceExitAfterMs - (Date.now() - signalledDuringInitAt))
      : forceExitAfterMs

  const { isShuttingDown, shutdown } = registerShutdownHandlers({
    app,
    process: proc,
    forceExitAfterMs: remainingForceExitMs,
    beforeClose: () => boot,
    flush: flushStorage,
  })

  // Every signal now goes through the single idempotent handler above; leaving
  // the init-window listeners in place would let a second one hard-exit on top
  // of the teardown they were only ever meant to bridge to.
  for (const { signal, listener } of initListeners) {
    proc.off(signal, listener)
  }
  clearTimeout(initDeadline)

  if (signalDuringInit !== null) {
    shutdown(signalDuringInit)
  }

  try {
    await boot
  } catch (err) {
    // While shutting down, the teardown owns the outcome: rethrowing here
    // would surface as an unhandled rejection and kill the process in the
    // middle of the storage flush the shutdown is running.
    if (!isShuttingDown()) {
      throw err
    }
    return { server: app.server }
  }

  // Fire-and-forget: a slow or unreachable GitHub must never delay serving.
  // Skipped when a signal already arrived during the boot: the checker's first
  // request would then go out as part of shutting down, and it would arm a
  // poll interval after `onClose` had already stopped it.
  if (!isShuttingDown()) {
    void updateChecker.start()
  }

  return { server: app.server }
}
