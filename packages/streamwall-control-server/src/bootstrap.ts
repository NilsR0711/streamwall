import process from 'node:process'
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
 * How long a shutdown may take before the process exits anyway. A container
 * runtime escalates to SIGKILL after ~10s of its own, so hanging any longer
 * only trades a logged force-exit for an unlogged kill.
 */
export const DEFAULT_FORCE_EXIT_MS = 10_000

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
 * process alive. The force-exit timer bounds that wait too.
 */
export function registerShutdownHandlers({
  app,
  process: proc,
  forceExitAfterMs = DEFAULT_FORCE_EXIT_MS,
  beforeClose,
}: {
  app: ClosableApp
  process: ProcessLike
  forceExitAfterMs?: number
  beforeClose?: () => Promise<unknown>
}): void {
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

    const closed = (async () => {
      if (beforeClose) {
        try {
          await beforeClose()
        } catch {
          // A boot that failed has nothing left to protect; close anyway.
        }
      }
      await app.close()
    })()

    void closed.then(
      () => {
        clearTimeout(forceExit)
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
}) {
  const url = new URL(baseURL)
  const hostname = overrideHostname ?? url.hostname
  const port = resolveListenPort(baseURL, overridePort)

  // The startup diagnostics below run *after* `initApp` purely so they can go
  // through `app.log`: they belong in the structured stream like every other
  // server diagnostic, and the logger only exists once Fastify does (#493).
  const { app, db, auth, updateChecker } = await initApp({
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
    // Auth persistence is fire-and-forget (`auth.on('state')` in `initApp`) and
    // storage writes are serialized, so one more write drains whatever is
    // still queued instead of letting a shutdown truncate it. A storage that
    // is already failing must not turn an orderly shutdown into a crash — it
    // is reported the same way the fire-and-forget writes are.
    try {
      await db.write()
    } catch (err) {
      app.log.error({ err }, 'Failed to flush storage during shutdown')
    }
  })

  // The rest of the boot runs as one awaitable unit so the shutdown handlers
  // can be armed before it starts: a stop signal arriving during a slow start
  // — minting the uplink token is a scrypt derivation plus two storage writes
  // — then waits for those writes to land instead of exiting on top of them.
  const boot = (async () => {
    const bootstrap = await initialInviteCodes({ db, auth, baseURL })
    logBootstrap(bootstrap)
    await app.listen({ port, host: hostname })
  })()

  registerShutdownHandlers({ app, process: proc, beforeClose: () => boot })

  await boot

  // Fire-and-forget: a slow or unreachable GitHub must never delay serving.
  void updateChecker.start()

  return { server: app.server }
}
