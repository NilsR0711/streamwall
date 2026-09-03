import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { Auth } from '../auth.ts'
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from '../config.ts'

// The invite exchange page and its client script are shipped as static assets
// alongside this module (rather than inline strings) so the script can be
// linted and unit-tested on its own. They are read once and cached; the whole
// `src/` tree is copied into the runtime image, so these resolve both under
// `tsx`/native-TS dev and in the container.
const ASSET_DIR = import.meta.dirname
let pageHtmlCache: string | null = null
let exchangeScriptCache: string | null = null

async function invitePageHtml(): Promise<string> {
  pageHtmlCache ??= await readFile(path.join(ASSET_DIR, 'page.html'), 'utf8')
  return pageHtmlCache
}

async function inviteExchangeScript(): Promise<string> {
  exchangeScriptCache ??= await readFile(
    path.join(ASSET_DIR, 'exchange.js'),
    'utf8',
  )
  return exchangeScriptCache
}

export interface InviteRouteOptions {
  auth: Auth
  /** Whether the server is reached over TLS, gating the `Secure` cookie flag. */
  isSecure: boolean
  /** The limiter shared by every scrypt-deriving route. */
  scryptRateLimit: onRequestAsyncHookHandler
}

/**
 * Registers the invite exchange endpoints:
 * - `GET /invite/:id` serves the exchange page (carries no secret).
 * - `GET /invite-exchange.js` serves the client redemption script.
 * - `POST /invite/:id` redeems the secret (from the body) for a session cookie.
 */
export async function registerInviteRoutes(
  app: FastifyInstance,
  { auth, isSecure, scryptRateLimit }: InviteRouteOptions,
): Promise<void> {
  const pageHtml = await invitePageHtml()
  const exchangeScript = await inviteExchangeScript()

  // The invite page never receives the secret — it lives in the URL fragment,
  // which the browser does not send — so this bare GET only serves the exchange
  // page and needs no auth rate limit.
  app.get<{ Params: { id: string } }>(
    '/invite/:id',
    async (_request, reply) => {
      return reply.type('text/html').send(pageHtml)
    },
  )

  app.get('/invite-exchange.js', async (_request, reply) => {
    return reply
      .type('application/javascript')
      .header('cache-control', 'no-store')
      .send(exchangeScript)
  })

  // Redeems an invite. The secret arrives in the request body (not the URL),
  // and this route runs the expensive scrypt verification, so it carries the
  // strict auth rate limit — the one shared across every deriving route, which
  // is why the budget is spent through the hook rather than a per-route config
  // (issue #821). A redemption is unconditionally charged: the body is not
  // parsed yet when the limiter runs, so there is nothing to classify on, and
  // a redemption that carries no token has no legitimate caller anyway.
  app.post<{ Params: { id: string }; Body: { token?: string } }>(
    '/invite/:id',
    {
      onRequest: scryptRateLimit,
      config: { rateLimit: false, scryptDerives: () => true },
    },
    async (request, reply) => {
      const { id } = request.params
      const token = request.body?.token

      if (!token || typeof token !== 'string') {
        return reply.code(403).send()
      }

      const tokenInfo = await auth.validateToken(id, token)
      if (!tokenInfo || tokenInfo.kind !== 'invite') {
        return reply.code(403).send()
      }

      const sessionToken = await auth.createToken({
        kind: 'session',
        name: tokenInfo.name,
        role: tokenInfo.role,
      })

      reply.setCookie(
        SESSION_COOKIE_NAME,
        `${sessionToken.tokenId}:${sessionToken.secret}`,
        {
          path: '/',
          httpOnly: true,
          secure: isSecure,
          sameSite: 'strict',
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        },
      )

      await auth.deleteToken(tokenInfo.tokenId)
      return reply.code(204).send()
    },
  )
}
