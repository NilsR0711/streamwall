import type { Delta } from 'jsondiffpatch'
import type { z } from 'zod'
import type { ViewContent, ViewPos } from './geometry.ts'
import type { StreamwallRole } from './roles.ts'
import type { ControlCommand, viewStateValueSchema } from './schemas.ts'

export interface StreamWindowConfig {
  cols: number
  rows: number
  width: number
  height: number
  x?: number
  y?: number
  frameless: boolean
  fullscreen: boolean
  /** 0-based index of the display the wall opens on, if pinned to one. */
  display?: number
  activeColor: string
  backgroundColor: string
}

export interface ContentDisplayOptions {
  rotation?: number
}

/** Metadata scraped from a loaded view */
export interface ContentViewInfo {
  title: string
}

export type ContentKind = 'video' | 'audio' | 'web' | 'background' | 'overlay'

export interface StreamDataContent extends ContentDisplayOptions {
  kind: ContentKind
  link: string
  label?: string
  labelPosition?: 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'
  source?: string
  notes?: string
  status?: string
  city?: string
  state?: string
  orientation?: 'V' | 'H'
  addedDate?: string
  _id?: string
  _dataSource?: string
}

export interface StreamData extends StreamDataContent {
  _id: string
  _dataSource: string
}

export type LocalStreamData = Omit<StreamData, '_id' | '_dataSource'>

export type StreamList = StreamData[] & { byURL?: Map<string, StreamData> }

/**
 * Mirrors `viewStateMachine.ts`'s snapshot `.value`. Derived from the schema so
 * that the type and the runtime validation can never disagree; the schema in
 * turn is held to the machine by `viewStateMachineSchemaDrift.test.ts` (#419).
 */
export type ViewStateValue = z.infer<typeof viewStateValueSchema>

export interface ViewState {
  state: ViewStateValue
  context: {
    id: number
    content: ViewContent | null
    info: ContentViewInfo | null
    pos: ViewPos | null
    // Human-readable reason when the view is in displaying.error, else null.
    error: string | null
    // Per-tile playback volume, from 0 (silent) to 1 (full). Independent of
    // the mute/listening state: it is the level applied once the tile is
    // unmuted.
    volume: number
  }
}

export interface StreamDelayStatus {
  isConnected: boolean
  delaySeconds: number
  restartSeconds: number
  isCensored: boolean
  isStreamRunning: boolean
  startTime: number
  state: string
}

export type DataSourceType = 'json-url' | 'toml-file'

/**
 * Health of a single stream data source (a `--data.json-url` or
 * `--data.toml-file`), so a dead source is diagnosable from the control UI
 * instead of only from a log.
 */
export interface DataSourceHealth {
  /** The URL or file path, which also identifies the source. */
  id: string
  type: DataSourceType
  status: 'ok' | 'error'
  /** Set when status is 'error'. */
  message: string | null
  updatedAt: number
}

export type AuthTokenKind = 'invite' | 'session' | 'streamwall'

export interface AuthTokenInfo {
  tokenId: string
  kind: AuthTokenKind
  role: StreamwallRole
  name: string
}

/** Maximum number of saved layout presets, bounding unbounded storage growth. */
export const MAX_LAYOUT_PRESETS = 50

/** A named, saved grid layout: its dimensions and per-cell stream assignments. */
export interface LayoutPreset {
  id: string
  name: string
  cols: number
  rows: number
  /** Sparse: only cells with an assigned stream are present. */
  views: { [viewIdx: string]: { streamId: string } }
}

export interface StreamwallState {
  identity: {
    role: StreamwallRole
  }
  auth?: {
    invites: AuthTokenInfo[]
    sessions: AuthTokenInfo[]
  }
  config: StreamWindowConfig
  streams: StreamList
  customStreams: StreamList
  views: ViewState[]
  /**
   * Anchor grid-cell index of the view currently expanded to fill the whole
   * wall, or `null` when the normal grid layout is shown. Purely a runtime,
   * view-local override (issue #362): it is broadcast so every client renders
   * the expansion consistently, but is never written to the persisted grid
   * assignments.
   */
  fullscreenViewIdx: number | null
  streamdelay: StreamDelayStatus | null
  layoutPresets: LayoutPreset[]
  /** Stream URLs (`StreamDataContent.link`) a user has starred for quick access. */
  favorites: string[]
  dataSourceHealth: DataSourceHealth[]
}

type MessageMeta = {
  id: number
  clientId: string
}

export type ControlUpdate = {
  type: 'state'
  state: StreamwallState
}

export type ControlCommandMessage = MessageMeta & ControlCommand

export type ControlUpdateMessage = MessageMeta & ControlUpdate

/** Sent to a `/client/ws` socket once, immediately after it connects. */
export type ClientStateMessage = {
  type: 'state'
  state: StreamwallState
}

/** An incremental jsondiffpatch delta applied to a client's last-known state. */
export type ClientStateDeltaMessage = {
  type: 'state-delta'
  delta: Delta
}

/** A connection-level rejection, sent before a client session is ever established. */
export type ClientErrorMessage = {
  error: string
}

/**
 * The server's reply to a specific client-issued command, correlated by the
 * client-supplied `id`. `error` is present only when the command was
 * rejected; a successful `create-invite` additionally returns the minted
 * token's `name`/`secret`/`tokenId`.
 */
export type ClientCommandResponse = {
  response: true
  id?: number
  error?: string
  name?: string
  secret?: string
  tokenId?: string
}

/** Every message shape the control server sends over a `/client/ws` socket. */
export type ServerToClientMessage =
  | ClientStateMessage
  | ClientStateDeltaMessage
  | ClientErrorMessage
  | ClientCommandResponse
