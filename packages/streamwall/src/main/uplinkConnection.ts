import EventEmitter from 'node:events'
import ReconnectingWebSocket from 'reconnecting-websocket'
import {
  type ControlCommand,
  type StreamwallState,
  isSocketOpen,
  parseControlEndpoint,
} from 'streamwall-shared'
import WebSocket from 'ws'
import * as Y from 'yjs'
import {
  type CommandSource,
  type ControlCommandResult,
  dispatchCommand,
} from './commandDispatch'
import { decideControlEndpointConnection } from './controlEndpointConnection'
import log from './logger'
import { UPLINK_ORIGIN, shouldForwardUpdateToUplink } from './uplinkEcho'
import { routeUplinkWsMessage } from './uplinkMessageRouting'

/**
 * Builds a WebSocket subclass for the control uplink.
 *
 * It enforces TLS certificate validation on wss:// connections: together with
 * the wss:// requirement on the control endpoint, this authenticates the
 * control server to the desktop and prevents a man-in-the-middle from
 * impersonating it. `rejectUnauthorized` defaults to true in `ws`, but we set
 * it explicitly so the guarantee cannot be silently lost to a future change.
 *
 * It also injects the uplink credential as an `Authorization` header rather
 * than a URL query parameter, keeping the secret out of server and proxy
 * access logs. `reconnecting-websocket` does not forward constructor options,
 * so the header is baked into the subclass here.
 */
export function makeControlWebSocket(authorization: string | null) {
  return class ControlWebSocket extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, {
        rejectUnauthorized: true,
        headers: authorization ? { authorization } : undefined,
      })
    }
  }
}

/** The uplink WebSocket surface `connectControlUplink` drives. */
export interface UplinkSocket {
  binaryType: string
  readonly readyState: number
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(
    type: 'message',
    listener: (event: { data: ArrayBuffer | string }) => void,
  ): void
  send(data: string | ArrayBufferLike | ArrayBufferView): void
}

export interface UplinkConnectionDeps {
  /** The configured control endpoint URL, or null when none is set. */
  endpoint: string | null
  stateDoc: Y.Doc
  stateEmitter: EventEmitter<{ state: [StreamwallState] }>
  /** Reads the current broadcast client state. */
  getClientState: () => StreamwallState
  /** Dispatches a command received over the uplink. */
  onCommand: (
    msg: ControlCommand,
    source: CommandSource,
  ) => Promise<void | ControlCommandResult>
  /**
   * Builds the reconnecting uplink socket. Injectable so the connection wiring
   * can be tested without a live server; defaults to a ReconnectingWebSocket
   * with the hardened control WebSocket subclass.
   */
  createSocket?: (opts: {
    url: string
    authorization: string | null
  }) => UplinkSocket
}

function defaultCreateSocket({
  url,
  authorization,
}: {
  url: string
  authorization: string | null
}): UplinkSocket {
  return new ReconnectingWebSocket(url, [], {
    WebSocket: makeControlWebSocket(authorization),
    maxReconnectionDelay: 5000,
    minReconnectionDelay: 100 + Math.random() * 500,
    reconnectionDelayGrowFactor: 1.25,
    // The 'open' handler always re-sends the full client state and Yjs doc as
    // soon as the connection (re)opens, so anything sent while disconnected is
    // stale by the time it could be delivered. Disable the library's default
    // unbounded queue rather than let it buffer full state snapshots for as
    // long as the control server is unreachable.
    maxEnqueuedMessages: 0,
  }) as unknown as UplinkSocket
}

/**
 * Connects the desktop to the remote control server, if one is configured and
 * the endpoint is secure.
 *
 * An insecure endpoint is refused outright (the connection must use wss://, or
 * ws:// to a loopback host). On connect, the full client state and Yjs doc are
 * (re)sent on every open, incoming messages are routed (Yjs updates applied,
 * commands dispatched through the uplink gate), and local state/doc changes are
 * forwarded while the socket is open.
 */
export function connectControlUplink(deps: UplinkConnectionDeps): void {
  const { stateDoc, stateEmitter, getClientState, onCommand } = deps
  const createSocket = deps.createSocket ?? defaultCreateSocket

  const controlConnection = decideControlEndpointConnection(deps.endpoint)
  if (
    controlConnection.action === 'skip' &&
    controlConnection.reason === 'insecure'
  ) {
    log.error(
      `Refusing to connect to insecure control endpoint "${controlConnection.endpoint}". ` +
        'The control connection must use wss:// (or ws:// to a loopback host).',
    )
    return
  }
  if (controlConnection.action !== 'connect') {
    return
  }

  log.debug('Connecting to control server...')
  // Move the uplink secret out of the URL query string and into an
  // Authorization header so it never reaches server or proxy access logs.
  const { url: controlURL, authorization } = parseControlEndpoint(
    controlConnection.endpoint,
  )
  const ws = createSocket({ url: controlURL, authorization })
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('open', () => {
    log.debug('Control WebSocket connected.')
    ws.send(JSON.stringify({ type: 'state', state: getClientState() }))
    ws.send(Y.encodeStateAsUpdate(stateDoc))
  })
  ws.addEventListener('close', () => {
    log.debug('Control WebSocket disconnected.')
  })
  ws.addEventListener('message', (ev) => {
    const route = routeUplinkWsMessage(ev.data)
    switch (route.kind) {
      case 'yjs-update':
        Y.applyUpdate(stateDoc, route.update, UPLINK_ORIGIN)
        return
      case 'parse-error':
        log.warn('Failed to parse control WebSocket message:', route.error)
        return
      case 'uplink-error':
        log.warn('Control server refused the uplink connection:', route.message)
        return
      case 'command':
        dispatchCommand(onCommand, route.message as ControlCommand, 'uplink')
    }
  })
  stateEmitter.on('state', () => {
    if (!isSocketOpen(ws)) {
      return
    }
    ws.send(JSON.stringify({ type: 'state', state: getClientState() }))
  })
  stateDoc.on('update', (update, origin) => {
    if (!shouldForwardUpdateToUplink(origin) || !isSocketOpen(ws)) {
      return
    }
    ws.send(update)
  })
}
