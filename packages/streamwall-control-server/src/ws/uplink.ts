import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'

import {
  controlStateMessageSchema,
  streamwallStateSchema,
} from 'streamwall-shared'
import { StateWrapper } from '../auth.ts'
import { STREAMWALL_PING_TIMEOUT_MS } from '../config.ts'
import type { AppContext } from '../context.ts'
import {
  bearerToken,
  createWsMessageGuard,
  queueWebSocketMessages,
} from '../wsSupport.ts'

/**
 * Registers the desktop uplink endpoint `GET /streamwall/:id/ws`. The uplink is
 * the trusted authority for the shared Yjs doc: it streams the full state
 * snapshot on connect and relays doc updates to every browser client. Only one
 * uplink may be connected at a time; a second is rejected.
 */
export function registerUplinkRoute(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get<{ Params: { id: string } }>(
    '/streamwall/:id/ws',
    { websocket: true },
    async (ws, request) => {
      ws.binaryType = 'arraybuffer'
      const handleMessage = queueWebSocketMessages(ws)

      const { id } = request.params
      const token = bearerToken(request.headers.authorization)

      if (!token) {
        ws.send(JSON.stringify({ error: 'unauthorized' }))
        ws.close()
        return
      }

      const tokenInfo = await ctx.auth.validateToken(id, token)
      if (!tokenInfo || tokenInfo.kind !== 'streamwall') {
        ws.send(JSON.stringify({ error: 'unauthorized' }))
        ws.close()
        return
      }

      if (ctx.currentStreamwallWs != null) {
        console.warn(
          'Rejecting Streamwall connection (already connected) from',
          request.ip,
          tokenInfo,
        )
        ws.send(JSON.stringify({ error: 'streamwall already connected' }))
        ws.close()
        return
      }

      ctx.currentStreamwallWs = ws

      const pingInterval = setInterval(() => {
        ws.ping()
        const pongTimeout = setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            console.warn(
              `Streamwall timeout: no pong within ${STREAMWALL_PING_TIMEOUT_MS}ms. Closing connection.`,
            )
            ws.terminate()
          }
        }, STREAMWALL_PING_TIMEOUT_MS)
        ws.once('pong', () => {
          clearTimeout(pongTimeout)
        })
      }, STREAMWALL_PING_TIMEOUT_MS)

      ws.on('close', () => {
        console.log('Streamwall disconnected')
        ctx.currentStreamwallWs = null
        ctx.currentStreamwallConn = null
        clearInterval(pingInterval)

        for (const client of ctx.clients.values()) {
          client.ws.close()
        }
      })

      let clientState: StateWrapper | null = null
      const stateDoc = new Y.Doc()

      console.log('Streamwall connecting from', request.ip, tokenInfo)

      const allowMessage = createWsMessageGuard(
        ws,
        ctx.wsMessageLimitConfig,
        `streamwall connection from ${request.ip}`,
      )

      handleMessage((rawData) => {
        if (!allowMessage()) {
          return
        }
        if (rawData instanceof ArrayBuffer) {
          // The uplink is the trusted authority for the shared doc and streams
          // the full state snapshot on connect, so it bypasses the size/shape
          // guard applied to untrusted client updates (which would otherwise
          // reject a legitimately large snapshot and silently break sync).
          Y.applyUpdate(stateDoc, new Uint8Array(rawData))
          return
        }

        let raw: unknown
        try {
          raw = JSON.parse(rawData.toString())
        } catch (err) {
          console.warn('Received unexpected ws data: ', rawData.length, 'bytes')
          return
        }

        // The desktop only ever sends `state` messages over this channel.
        // Validate structurally so a malformed payload can never wrap the
        // shared StateWrapper around garbage (which crashed clients on view()).
        const parsed = controlStateMessageSchema.safeParse(raw)
        if (!parsed.success) {
          console.warn(
            'Rejected invalid Streamwall state message:',
            parsed.error.issues[0]?.message,
          )
          return
        }

        // The envelope check above only guarantees "an object". Validate the
        // full snapshot itself so a malformed or adversarial desktop build can
        // never seed StateWrapper with garbage that crashes clients on
        // view() or corrupts the role-scoped projection (issue #387).
        const stateResult = streamwallStateSchema.safeParse(parsed.data.state)
        if (!stateResult.success) {
          console.warn(
            'Rejected invalid Streamwall state payload:',
            stateResult.error.issues[0]?.message,
          )
          return
        }
        const state = stateResult.data

        try {
          if (clientState === null) {
            const newClientState = new StateWrapper(state)
            // Broadcasting on every `'state'` event (rather than only here)
            // is what makes auth-only changes — invite/session created or
            // deleted while the desktop pushes no new state — reach already
            // connected clients; see `auth.on('state', ...)` in initApp.
            newClientState.on('state', () =>
              ctx.broadcastStateDeltas(newClientState),
            )
            clientState = newClientState
            clientState.update({ auth: ctx.auth.getState() })
            ctx.currentStreamwallConn = {
              ws,
              clientState,
              stateDoc,
            }

            console.log('Streamwall connected from', request.ip, tokenInfo)
          } else {
            clientState.update(state)
          }
        } catch (err) {
          console.error('Failed to handle ws message:', rawData, err)
          ctx.reportCaughtError(err)
        }
      })

      stateDoc.on('update', (update, origin) => {
        try {
          ws.send(update)
        } catch (err) {
          console.error('Failed to send Streamwall doc update', err)
          ctx.reportCaughtError(err)
        }
        for (const client of ctx.clients.values()) {
          if (client.clientId === origin) {
            continue
          }
          try {
            client.ws.send(update)
          } catch (err) {
            console.error('Failed to send client doc update:', client, err)
            ctx.reportCaughtError(err)
          }
        }
      })
    },
  )
}
