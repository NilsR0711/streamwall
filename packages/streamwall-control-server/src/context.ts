import WebSocket from 'ws'
import type * as Y from 'yjs'

import { type AuthTokenInfo, stateDiff } from 'streamwall-shared'
import type { Auth, StateWrapper } from './auth.ts'
import type { ClientPingConfig, WsMessageLimitConfig } from './config.ts'
import { identityFields, type Logger } from './logger.ts'
import type { DocUpdateLimits } from './stateDocGuard.ts'
import type { UpdateChecker } from './updateCheck.ts'

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AuthTokenInfo
  }
}

export interface Client {
  clientId: string
  ws: WebSocket
  lastStateSent: unknown
  identity: AuthTokenInfo
}

export interface StreamwallConnection {
  ws: WebSocket
  clientState: StateWrapper
  stateDoc: Y.Doc
}

/**
 * Shared server state and dependencies threaded through the route and
 * WebSocket handler modules. The `currentStreamwall*` fields are reassigned as
 * the desktop uplink connects and disconnects, so this object is always passed
 * by reference — those fields must be read off the live context, never
 * destructured up front.
 */
export interface AppContext {
  /** Server-wide logger; per-connection handlers prefer `request.log`. */
  log: Logger
  auth: Auth
  updateChecker: UpdateChecker
  expectedOrigin: string
  isSecure: boolean
  wsMessageLimitConfig: WsMessageLimitConfig
  clientPingConfig: ClientPingConfig
  docUpdateLimits: DocUpdateLimits
  clients: Map<string, Client>
  currentStreamwallWs: WebSocket | null
  currentStreamwallConn: StreamwallConnection | null
  broadcastStateDeltas: (clientState: StateWrapper) => void
  reportCaughtError: (err: unknown) => void
}

/**
 * Builds the state-delta broadcaster bound to a connection registry. It diffs
 * `clientState`'s current view against what each connected client last saw and
 * sends only the delta. Subscribed to `clientState`'s own `'state'` event (see
 * the uplink handler) so it also runs for auth-only changes — e.g.
 * `auth.on('state', ...)` calling `clientState.update({ auth: ... })` when an
 * invite/session is created or deleted — not only when the desktop pushes a
 * full state.
 */
export function createBroadcastStateDeltas(
  clients: Map<string, Client>,
  reportCaughtError: (err: unknown) => void,
  log: Logger,
): (clientState: StateWrapper) => void {
  return (clientState: StateWrapper) => {
    for (const client of clients.values()) {
      try {
        if (client.ws.readyState !== WebSocket.OPEN) {
          continue
        }
        const stateView = clientState.view(client.identity.role)
        const delta = stateDiff.diff(client.lastStateSent, stateView)
        if (!delta) {
          continue
        }
        client.ws.send(JSON.stringify({ type: 'state-delta', delta }))
        client.lastStateSent = stateView
      } catch (err) {
        log.error(
          {
            err,
            clientId: client.clientId,
            ...identityFields(client.identity),
          },
          'Failed to send client state delta',
        )
        reportCaughtError(err)
      }
    }
  }
}
