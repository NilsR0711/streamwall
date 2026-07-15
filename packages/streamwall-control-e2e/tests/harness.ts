import { test as base } from '@playwright/test'
import { Low, Memory } from 'lowdb'
import { EventEmitter, once } from 'node:events'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { initApp } from 'streamwall-control-server'
import type { StoredData } from 'streamwall-control-server/src/storage.ts'
import {
  inviteLink,
  type StreamData,
  type StreamwallRole,
  type StreamwallState,
} from 'streamwall-shared'
import WebSocket from 'ws'
import * as Y from 'yjs'

const COLS = 3
const ROWS = 3
const CELL_COUNT = COLS * ROWS

/** Absolute path to the built control-client assets the server serves. */
const CLIENT_DIST = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../streamwall-control-client/dist',
)

/**
 * Three demo streams, mirroring the dev harness fixtures. Only their `_id`s
 * matter to the tests: a grid cell only commits a typed value when it matches
 * a known stream `_id` (see `resolveEagerWriteStreamId`).
 */
const DEMO_STREAMS: StreamData[] = [
  {
    _id: 'wok',
    _dataSource: 'e2e',
    kind: 'video',
    link: 'https://twitch.tv/woke',
    label: 'PDX Live',
    source: 'woke.net',
    status: 'Live',
  },
  {
    _id: 'oma',
    _dataSource: 'e2e',
    kind: 'video',
    link: 'https://youtube.com/watch?v=oma',
    label: 'Capitol Hill',
    source: 'Omari Salisbury',
    status: 'Live',
  },
  {
    _id: 'uni',
    _dataSource: 'e2e',
    kind: 'video',
    link: 'https://facebook.com/unicornriot/v/1',
    label: 'South MPLS',
    source: 'Unicorn Riot',
    status: 'Live',
  },
]

/**
 * A minimal but complete admin `StreamwallState` the fake uplink pushes on
 * connect. `views` is intentionally empty (no running streams) — the grid still
 * renders all `COLS*ROWS` cell inputs, which the tests drive directly.
 */
const E2E_STATE: StreamwallState = {
  identity: { role: 'admin' },
  auth: { invites: [], sessions: [] },
  config: {
    cols: COLS,
    rows: ROWS,
    width: 1920,
    height: 1080,
    frameless: false,
    fullscreen: false,
    activeColor: '#f24d2e',
    backgroundColor: '#000000',
  },
  streams: DEMO_STREAMS,
  customStreams: [],
  views: [],
  fullscreenViewIdx: null,
  streamdelay: null,
  layoutPresets: [],
  favorites: [],
  dataSourceHealth: [],
}

/** A handle to one running control server + connected fake Streamwall uplink. */
export interface Harness {
  /** Origin the browser must use (matches the server's expected WS origin). */
  readonly baseURL: string
  readonly cols: number
  readonly rows: number
  /** The stream `_id`s the seeded state knows about. */
  readonly streamIds: readonly string[]
  /** Mints an invite and returns its full `/invite/:id#token=…` link. */
  createInviteLink(role?: StreamwallRole): Promise<string>
  /**
   * Resolves once the fake uplink has observed `streamId` assigned to grid cell
   * `idx` in the shared Yjs doc — i.e. the browser's grid-cell edit reached the
   * Streamwall peer over the wire. Rejects on timeout.
   */
  waitForViewAssignment(
    idx: number,
    streamId: string,
    timeoutMs?: number,
  ): Promise<void>
  /**
   * Resolves with the next JSON `ControlCommand` message of the given `type`
   * the fake uplink receives — i.e. a UI-driven action (grid resize, blur
   * toggle, ...) reached the Streamwall peer over the wire, forwarded by the
   * control server. Rejects on timeout.
   */
  waitForCommand<T extends { type: string } = { type: string }>(
    type: T['type'],
    timeoutMs?: number,
  ): Promise<T>
  close(): Promise<void>
}

/** Reserves a free localhost TCP port by briefly binding port 0. */
async function getFreePort(): Promise<number> {
  const srv = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', resolve)
    })
    return (srv.address() as AddressInfo).port
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
}

/** Normalizes a `ws` binary frame to the `Uint8Array` Yjs expects. */
function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data))
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  return new Uint8Array(data)
}

/**
 * Boots a control server backed by in-memory storage and throwaway state,
 * connects a fake Streamwall uplink to it, and seeds a `COLS*ROWS` grid of
 * (empty) view cells into the shared Yjs doc so the browser can edit them.
 */
export async function startHarness(): Promise<Harness> {
  if (!existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    throw new Error(
      `Control client build not found at ${CLIENT_DIST}. Run ` +
        '`npm -w streamwall-control-client run build` first (the `test:e2e` ' +
        'script does this automatically).',
    )
  }

  // Give the browser plenty of request headroom: loading the app pulls many
  // font/asset requests that would otherwise brush against the per-IP limit.
  process.env.STREAMWALL_RATE_LIMIT_MAX ??= '100000'

  const port = await getFreePort()
  const baseURL = `http://127.0.0.1:${port}`

  const initialData: StoredData = {
    auth: { salt: null, tokens: [] },
    streamwallToken: null,
  }
  const db = new Low<StoredData>(new Memory<StoredData>(), initialData)

  const { app, auth } = await initApp({
    baseURL,
    clientStaticPath: CLIENT_DIST,
    db,
  })
  await app.listen({ port, host: '127.0.0.1' })

  // Connect the fake Streamwall uplink (the trusted authority for shared state).
  const uplink = await auth.createToken({
    kind: 'streamwall',
    role: 'admin',
    name: 'e2e-uplink',
  })
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/streamwall/${uplink.tokenId}/ws`,
    { headers: { authorization: `Bearer ${uplink.secret}` } },
  )
  ws.binaryType = 'arraybuffer'

  // The peer's mirror of the shared doc: seeded here, then kept in sync with
  // every update the server forwards, so tests can observe client grid edits.
  const peerDoc = new Y.Doc()
  peerDoc.transact(() => {
    const views = peerDoc.getMap<Y.Map<string | undefined>>('views')
    for (let idx = 0; idx < CELL_COUNT; idx++) {
      const cell = new Y.Map<string | undefined>()
      cell.set('streamId', undefined)
      views.set(String(idx), cell)
    }
  })

  // Text frames on the uplink socket are the server-forwarded JSON
  // `ControlCommand` messages (see control-server's ws handler): re-emitted
  // here, keyed by `type`, so `waitForCommand` can observe a UI-driven action
  // reaching the peer without every test having to parse frames itself.
  const commandEvents = new EventEmitter()
  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      Y.applyUpdate(peerDoc, toUint8Array(data), 'server')
      return
    }
    let msg: unknown
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (
      typeof msg === 'object' &&
      msg !== null &&
      typeof (msg as { type?: unknown }).type === 'string'
    ) {
      commandEvents.emit((msg as { type: string }).type, msg)
    }
  })

  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'state', state: E2E_STATE }))
  ws.send(Y.encodeStateAsUpdate(peerDoc))

  const redeemSessionCookie = async (role: StreamwallRole) => {
    const invite = await auth.createToken({ kind: 'invite', role, name: 'e2e' })
    const res = await app.inject({
      method: 'POST',
      url: `/invite/${invite.tokenId}`,
      headers: { 'content-type': 'application/json' },
      payload: { token: invite.secret },
    })
    const rawCookie = res.headers['set-cookie']
    return (Array.isArray(rawCookie) ? rawCookie[0] : String(rawCookie)).split(
      ';',
    )[0]
  }

  // The server only echoes the uplink's *own* seed back once it has fully wired
  // up the connection, so we can't confirm the seed landed by listening on the
  // uplink. Instead, connect a throwaway client and wait until it sees the full
  // grid in the shared doc — a deterministic barrier that the browser client
  // (which connects much later) will find the cells it needs to edit.
  const probeSharedDocSize = async (cookie: string) => {
    const probe = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { Cookie: cookie, Origin: baseURL },
    })
    probe.binaryType = 'arraybuffer'
    const doc = new Y.Doc()
    try {
      return await new Promise<number>((resolve, reject) => {
        const settle = () => resolve(doc.getMap('views').size)
        const timer = setTimeout(settle, 1000)
        probe.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
          if (!isBinary) {
            return
          }
          Y.applyUpdate(doc, toUint8Array(data))
          if (doc.getMap('views').size >= CELL_COUNT) {
            clearTimeout(timer)
            settle()
          }
        })
        probe.on('close', () => {
          clearTimeout(timer)
          settle()
        })
        probe.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
    } finally {
      probe.terminate()
      doc.destroy()
    }
  }

  const sessionCookie = await redeemSessionCookie('admin')
  const deadline = Date.now() + 10_000
  while (
    (await probeSharedDocSize(sessionCookie).catch(() => 0)) < CELL_COUNT
  ) {
    if (Date.now() > deadline) {
      throw new Error('Timed out confirming the shared grid doc was seeded.')
    }
    await delay(50)
  }

  const createInviteLink = async (role: StreamwallRole = 'admin') => {
    const invite = await auth.createToken({ kind: 'invite', role, name: 'e2e' })
    return inviteLink({
      baseURL,
      tokenId: invite.tokenId,
      secret: invite.secret,
    })
  }

  const waitForViewAssignment = (
    idx: number,
    streamId: string,
    timeoutMs = 5000,
  ) =>
    new Promise<void>((resolve, reject) => {
      const current = () =>
        peerDoc.getMap<Y.Map<string | undefined>>('views').get(String(idx))
      const matches = () => current()?.get('streamId') === streamId
      if (matches()) {
        resolve()
        return
      }
      const onUpdate = () => {
        if (matches()) {
          cleanup()
          resolve()
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `Timed out waiting for cell ${idx} to become "${streamId}" ` +
              `(saw "${current()?.get('streamId')}")`,
          ),
        )
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        peerDoc.off('update', onUpdate)
      }
      peerDoc.on('update', onUpdate)
    })

  const waitForCommand = <T extends { type: string } = { type: string }>(
    type: T['type'],
    timeoutMs = 5000,
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        commandEvents.off(type, onCommand)
        reject(
          new Error(
            `Timed out waiting for a "${type}" command to reach the uplink`,
          ),
        )
      }, timeoutMs)
      const onCommand = (msg: T) => {
        clearTimeout(timer)
        resolve(msg)
      }
      commandEvents.once(type, onCommand)
    })

  const close = async () => {
    ws.terminate()
    peerDoc.destroy()
    await app.close()
  }

  return {
    baseURL,
    cols: COLS,
    rows: ROWS,
    streamIds: DEMO_STREAMS.map((s) => s._id),
    createInviteLink,
    waitForViewAssignment,
    waitForCommand,
    close,
  }
}

/** Playwright fixture that provides a fresh, isolated harness per test. */
export const test = base.extend<{ harness: Harness }>({
  // eslint-disable-next-line no-empty-pattern
  harness: async ({}, use) => {
    const harness = await startHarness()
    try {
      await use(harness)
    } finally {
      await harness.close()
    }
  },
})

export { expect } from '@playwright/test'
