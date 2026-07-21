import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import * as Y from 'yjs'

import {
  controlCommandMessageSchema,
  roleCan,
  type StreamwallRole,
} from 'streamwall-shared'
import { uniqueRand62 } from '../auth.ts'
import { SESSION_COOKIE_NAME } from '../config.ts'
import { type AppContext, type Client } from '../context.ts'
import { applyValidatedDocUpdate } from '../stateDocGuard.ts'
import { createWsMessageGuard, queueWebSocketMessages } from '../wsSupport.ts'

export interface ClientRouteOptions {
  /** Filesystem root of the built control client served at `/`. */
  clientStaticPath: string
}

/**
 * Registers the authenticated surface as an encapsulated Fastify plugin: a
 * session-cookie auth `preHandler`, the admin-only `/admin/status` endpoint,
 * the static control client, and the browser control WebSocket at `/client/ws`.
 */
export function registerClientRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { clientStaticPath }: ClientRouteOptions,
): void {
  app.register(async function (fastify) {
    fastify.addHook('preHandler', async (request) => {
      const sessionCookie = request.cookies[SESSION_COOKIE_NAME]
      if (sessionCookie) {
        const [tokenId, tokenSecret] = sessionCookie.split(':', 2)
        const tokenInfo = await ctx.auth.validateToken(tokenId, tokenSecret)
        if (tokenInfo && tokenInfo.kind === 'session') {
          request.identity = tokenInfo
        }
      }
    })

    // Deployment status for self-hosters (issue #382): the running version
    // plus whether a newer release exists. Admin-only — the version of a
    // publicly reachable server is exactly the kind of detail that helps
    // someone shop for a known vulnerability, so it stays behind auth.
    fastify.get('/admin/status', async (request, reply) => {
      if (!roleCan(request.identity?.role ?? null, 'view-server-status')) {
        return reply.code(403).send()
      }
      return reply
        .header('cache-control', 'no-store')
        .send(ctx.updateChecker.getStatus())
    })

    // Serve frontend assets
    await fastify.register(fastifyStatic, {
      root: clientStaticPath,
    })

    // Client WebSocket connection
    fastify.get('/client/ws', { websocket: true }, async (ws, request) => {
      ws.binaryType = 'arraybuffer'
      const handleMessage = queueWebSocketMessages(ws)

      const { identity } = request

      if (request.headers.origin !== ctx.expectedOrigin || !identity) {
        ws.send(JSON.stringify({ error: 'unauthorized' }))
        ws.close()
        return
      }

      const streamwallConn = ctx.currentStreamwallConn
      if (!streamwallConn) {
        ws.send(JSON.stringify({ error: 'streamwall disconnected' }))
        ws.close()
        return
      }

      const clientId = uniqueRand62(8, ctx.clients)
      const client: Client = {
        clientId,
        ws,
        lastStateSent: null,
        identity,
      }
      ctx.clients.set(clientId, client)

      const pingInterval = setInterval(() => {
        ws.ping()
      }, 20 * 1000)

      ws.on('close', () => {
        ctx.clients.delete(clientId)
        clearInterval(pingInterval)

        console.log(
          'Client',
          clientId,
          'disconnected from',
          request.ip,
          client.identity,
        )
      })

      console.log(
        'Client',
        clientId,
        'connected from',
        request.ip,
        client.identity,
      )

      const allowMessage = createWsMessageGuard(
        ws,
        ctx.wsMessageLimitConfig,
        `client ${clientId} from ${request.ip}`,
      )

      handleMessage(async (rawData) => {
        if (!allowMessage()) {
          return
        }
        let messageId: number | undefined
        const respond = (responseData: Record<string, unknown>) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return
          }
          ws.send(
            JSON.stringify({
              ...responseData,
              response: true,
              id: messageId,
            }),
          )
        }

        if (!ctx.currentStreamwallConn) {
          respond({ error: 'streamwall disconnected' })
          return
        }

        if (rawData instanceof ArrayBuffer) {
          if (!roleCan(identity.role, 'mutate-state-doc')) {
            console.warn(
              `Unauthorized attempt to edit state doc by "${identity.name}"`,
            )
            respond({ error: 'unauthorized' })
            return
          }
          if (
            !applyValidatedDocUpdate(
              streamwallConn.stateDoc,
              new Uint8Array(rawData),
              ctx.docUpdateLimits,
              clientId,
            )
          ) {
            // The client already applied this edit to its local doc. Dropping
            // it server-side would leave the operator UI out of sync with the
            // shared doc, so close the socket (like a rate-limit violation) to
            // force a clean reconnect and resync.
            console.warn(
              `Rejected invalid state doc update from client ${clientId}, closing to force resync`,
            )
            ws.close(1008, 'invalid state update')
          }
          return
        }

        let raw: unknown
        try {
          raw = JSON.parse(rawData.toString())
        } catch (err) {
          console.warn('Received unexpected ws data: ', rawData.length, 'bytes')
          return
        }

        // Preserve the client-supplied id (when present) so an error response
        // can still be correlated even if the message is otherwise invalid.
        if (
          typeof raw === 'object' &&
          raw !== null &&
          typeof (raw as { id?: unknown }).id === 'number'
        ) {
          messageId = (raw as { id: number }).id
        }

        // Every command is validated against the shared schema before it is
        // authorized or dispatched: an admin passes every roleCan check, so
        // this is the only barrier stopping a malformed or unknown command
        // from being forwarded to — and executed on — the desktop.
        const parsed = controlCommandMessageSchema.safeParse(raw)
        if (!parsed.success) {
          console.warn(
            `Rejected invalid control message from client ${clientId}:`,
            parsed.error.issues[0]?.message,
          )
          respond({ error: 'invalid message' })
          return
        }
        const msg = parsed.data

        try {
          if (!roleCan(identity.role, msg.type)) {
            console.warn(
              `Unauthorized attempt to "${msg.type}" by "${identity.name}"`,
            )
            respond({ error: 'unauthorized' })
            return
          }

          if (msg.type === 'create-invite') {
            console.debug('Creating invite for role:', msg.role)
            const { tokenId, secret } = await ctx.auth.createToken({
              kind: 'invite',
              role: msg.role as StreamwallRole,
              name: msg.name,
            })
            respond({ name: msg.name, secret, tokenId })
          } else if (msg.type === 'delete-token') {
            console.debug('Deleting token:', msg.tokenId)
            ctx.auth.deleteToken(msg.tokenId)
          } else {
            streamwallConn.ws.send(
              JSON.stringify({ ...msg, clientId: identity.tokenId }),
            )
          }
        } catch (err) {
          console.error('Failed to handle ws message:', rawData, err)
          ctx.reportCaughtError(err)
        }
      })

      const state = streamwallConn.clientState.view(identity.role)
      ws.send(JSON.stringify({ type: 'state', state }))
      ws.send(Y.encodeStateAsUpdate(streamwallConn.stateDoc))
      client.lastStateSent = state
    })
  })
}
