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
      db.update((data) => {
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
    db.update((data) => {
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

export default async function runServer({
  port: overridePort,
  hostname: overrideHostname,
  baseURL,
  clientStaticPath,
  db: injectedDb,
  logLevel,
  logStream,
  updateChecker: injectedUpdateChecker,
}: AppOptions & {
  hostname?: string
  port?: string
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

  const bootstrap = await initialInviteCodes({ db, auth, baseURL })
  logBootstrap(bootstrap)

  // Hooks must be registered before the instance starts listening -- Fastify 5
  // throws FST_ERR_INSTANCE_ALREADY_LISTENING otherwise (issue #442).
  app.addHook('onClose', async () => {
    updateChecker.stop()
  })

  await app.listen({ port, host: hostname })

  // Fire-and-forget: a slow or unreachable GitHub must never delay serving.
  void updateChecker.start()

  return { server: app.server }
}
