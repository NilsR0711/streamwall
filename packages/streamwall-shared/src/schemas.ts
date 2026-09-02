import { z } from 'zod'
import { GRID_MAX, GRID_MIN } from './geometry.ts'
import { invitableRoles, validRoles } from './roles.ts'
import { asCellIdx, asViewId } from './viewAddressing.ts'

/**
 * Runtime schemas for every piece of external, untrusted input that crosses a
 * trust boundary: stream data pulled from files/URLs and control messages
 * received over the WebSocket control channel.
 *
 * These are the single source of truth for the *shape* of that input. Numeric
 * fields are bounded, unknown keys are stripped, and the discriminated command
 * union rejects anything that is not an explicitly enumerated command — so a
 * malformed or malicious payload is turned away before it can corrupt shared
 * state or drive an unintended action.
 */

/** Largest allowed image rotation, in degrees. */
export const MAX_ROTATION = 360

/**
 * Highest addressable grid cell index. The grid is at most GRID_MAX×GRID_MAX,
 * so view indices live in `[0, GRID_MAX² - 1]`.
 */
export const MAX_VIEW_IDX = GRID_MAX * GRID_MAX - 1

const contentKindSchema = z.enum([
  'video',
  'audio',
  'web',
  'background',
  'overlay',
])

const labelPositionSchema = z.enum([
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
])

const orientationSchema = z.enum(['V', 'H'])

const rotationSchema = z.number().min(0).max(MAX_ROTATION)

/** A grid cell index, bounded by the largest grid the wall supports. */
const viewIdxSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_VIEW_IDX)
  .transform(asCellIdx)

/**
 * A stable per-view identity, fixed when a view actor is created and preserved
 * across grid resizes and remaps (issue #397). Unlike {@link viewIdxSchema} —
 * a *grid cell index* that shifts whenever the layout changes — this addresses
 * one specific running view for the lifetime of its actor, so a control command
 * cannot race a concurrent resize into acting on the wrong tile. It is an
 * opaque non-negative integer (the actor's creation-time `webContents.id`); it
 * is deliberately not bounded by `MAX_VIEW_IDX`, which only limits grid cells.
 *
 * Both axes are branded (see `./viewAddressing.ts`), so the compiler rejects a
 * cell index used as a view id and vice versa (issue #507).
 */
const viewIdSchema = z.number().int().nonnegative().transform(asViewId)
const gridDimensionSchema = z.number().int().min(GRID_MIN).max(GRID_MAX)
const volumeSchema = z.number().min(0).max(1)

/** Longest allowed name for a saved layout preset. */
export const MAX_LAYOUT_PRESET_NAME_LENGTH = 100
const layoutPresetNameSchema = z
  .string()
  .min(1)
  .max(MAX_LAYOUT_PRESET_NAME_LENGTH)
const layoutPresetIdSchema = z.string().min(1).max(100)

/**
 * Longest allowed URL anywhere it crosses a trust boundary: a control command
 * argument (`rotate-stream`, `update-custom-stream`, `delete-custom-stream`,
 * `browse`, `add-favorite`, `remove-favorite`), a stream entry's `link` from
 * an external data source or an `update-custom-stream` payload
 * ({@link streamDataInputSchema}, {@link localStreamDataSchema}), or a view's
 * displayed content URL in the broadcast `StreamwallState` (issue #770,
 * following up on #734; extended to the upstream `link` fields by #778).
 * These ultimately originate from operator input or a data source, both of
 * which are untrusted, and the content URL in particular is re-broadcast on
 * every state update - an unbounded value could grow a `state` frame past
 * the uplink's `maxPayload`, the same denial-of-service loop #734 fixed for
 * `document.title`. Left unbounded upstream, an oversized `link` would still
 * fail the bounded `viewContentSchema.url` it feeds, and
 * `streamwallStateSchema.safeParse` rejects an entire state update (not just
 * the offending view) on any field failure - a full state-broadcast outage
 * for that desktop rather than a single bad stream. 2048 mirrors the URL
 * length browsers themselves treat as a practical limit, generous enough for
 * any real stream or page URL.
 */
export const MAX_URL_LENGTH = 2048
const urlSchema = z.string().max(MAX_URL_LENGTH)
const nonEmptyUrlSchema = z.string().min(1).max(MAX_URL_LENGTH)

/**
 * True for a value that is a syntactically valid, bounded `http:`/`https:`
 * URL - the only schemes a `target="_blank"` anchor should ever be allowed
 * to carry (issue #773). Exported so the control UI can apply the same
 * check at render time, independent of the schema layer.
 */
export function isHttpUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) {
    return false
  }
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Narrows a nullable, server-controlled URL field to `null` whenever it
 * isn't a valid `http(s)` URL, instead of failing the whole containing
 * object. `releaseUrl` (issue #773) is rendered straight into an `<a href>`
 * by the control UI; a compromised or misconfigured server could otherwise
 * put an arbitrary scheme there (`javascript:`, `data:`, a custom protocol
 * registered by another installed app). Narrowing rather than rejecting
 * keeps the rest of a status/state payload usable in a mixed-version
 * deployment where an older or buggy server sends a malformed value here.
 */
const nullableHttpUrlSchema = z
  .string()
  .nullable()
  .transform((value) => (value != null && isHttpUrl(value) ? value : null))

/** Optional descriptive fields shared by every stream-data shape. */
const streamMetaFields = {
  label: z.string().optional(),
  labelPosition: labelPositionSchema.optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  orientation: orientationSchema.optional(),
  addedDate: z.string().optional(),
  rotation: rotationSchema.optional(),
}

/**
 * A single stream entry as it arrives from an untrusted data source (a TOML
 * file or a polled JSON URL). `link` identifies the stream and is required;
 * `kind` defaults downstream when omitted. Internal fields (`_id`,
 * `_dataSource`) are intentionally absent so a source cannot forge a stream's
 * identity or provenance — unknown keys are stripped by default.
 */
export const streamDataInputSchema = z.object({
  link: nonEmptyUrlSchema,
  kind: contentKindSchema.optional(),
  ...streamMetaFields,
})

export type StreamDataInput = z.infer<typeof streamDataInputSchema>

/**
 * Payload of an `update-custom-stream` command. Unlike an external data source
 * this carries a resolved `kind`, matching the shared `LocalStreamData` type.
 */
export const localStreamDataSchema = z.object({
  link: nonEmptyUrlSchema,
  kind: contentKindSchema,
  ...streamMetaFields,
})

/**
 * Validates a list of stream entries from an untrusted source, tolerating bad
 * data: valid entries are kept, invalid ones are dropped and reported (by index
 * and reason) rather than discarding the whole batch. Non-array input yields an
 * empty result.
 */
export function parseStreamList(input: unknown): {
  streams: StreamDataInput[]
  errors: { index: number; message: string }[]
} {
  if (!Array.isArray(input)) {
    return { streams: [], errors: [] }
  }

  const streams: StreamDataInput[] = []
  const errors: { index: number; message: string }[] = []

  input.forEach((entry, index) => {
    const result = streamDataInputSchema.safeParse(entry)
    if (result.success) {
      streams.push(result.data)
    } else {
      errors.push({ index, message: z.prettifyError(result.error) })
    }
  })

  return { streams, errors }
}

/**
 * Every control command a client may send, as a discriminated union keyed on
 * `type`. Any unrecognized `type` — including prototype-polluting strings like
 * `__proto__` — fails to match and is rejected.
 */
export const controlCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set-listening-view'),
    viewId: viewIdSchema.nullable(),
  }),
  z.object({
    type: z.literal('set-view-background-listening'),
    viewId: viewIdSchema,
    listening: z.boolean(),
  }),
  z.object({
    type: z.literal('set-view-blurred'),
    viewId: viewIdSchema,
    blurred: z.boolean(),
  }),
  z.object({
    type: z.literal('set-view-volume'),
    viewId: viewIdSchema,
    volume: volumeSchema,
  }),
  z.object({
    type: z.literal('rotate-stream'),
    url: urlSchema,
    rotation: rotationSchema,
  }),
  z.object({
    type: z.literal('update-custom-stream'),
    url: urlSchema,
    data: localStreamDataSchema,
  }),
  z.object({
    type: z.literal('delete-custom-stream'),
    url: urlSchema,
  }),
  z.object({
    type: z.literal('reload-view'),
    viewId: viewIdSchema,
  }),
  z.object({
    type: z.literal('set-view-fullscreen'),
    viewId: viewIdSchema,
    fullscreen: z.boolean(),
  }),
  z.object({
    type: z.literal('browse'),
    url: urlSchema,
  }),
  z.object({
    type: z.literal('dev-tools'),
    viewId: viewIdSchema,
  }),
  z.object({
    type: z.literal('set-stream-censored'),
    isCensored: z.boolean(),
  }),
  z.object({
    type: z.literal('set-stream-running'),
    isStreamRunning: z.boolean(),
  }),
  z.object({
    type: z.literal('create-invite'),
    role: z.enum(invitableRoles),
    name: z.string(),
  }),
  z.object({
    type: z.literal('delete-token'),
    tokenId: z.string(),
  }),
  z.object({
    type: z.literal('set-grid-size'),
    cols: gridDimensionSchema,
    rows: gridDimensionSchema,
  }),
  z.object({
    type: z.literal('save-layout-preset'),
    name: layoutPresetNameSchema,
  }),
  z.object({
    type: z.literal('load-layout-preset'),
    presetId: layoutPresetIdSchema,
  }),
  z.object({
    type: z.literal('delete-layout-preset'),
    presetId: layoutPresetIdSchema,
  }),
  z.object({
    type: z.literal('add-favorite'),
    url: nonEmptyUrlSchema,
  }),
  z.object({
    type: z.literal('remove-favorite'),
    url: nonEmptyUrlSchema,
  }),
])

/**
 * Every control command a client may send, derived from `controlCommandSchema`
 * so the static type and its runtime validation can never drift apart.
 */
export type ControlCommand = z.infer<typeof controlCommandSchema>

/**
 * An inbound control-command message: a command plus the client-supplied
 * numeric `id` used to correlate responses. `clientId` is attached server-side
 * and is deliberately not required here.
 */
export const controlCommandMessageSchema = z.intersection(
  z.object({ id: z.number() }),
  controlCommandSchema,
)

/**
 * A `state` update message sent by the Streamwall desktop over its uplink. The
 * full `StreamwallState` is authored by the (authenticated) desktop, so this
 * only enforces the structural invariants the server relies on: a `state`
 * discriminator and a non-null object payload. The payload itself is
 * validated separately by {@link streamwallStateSchema} before it is ever
 * used to build or update a `StateWrapper`.
 */
export const controlStateMessageSchema = z.object({
  type: z.literal('state'),
  id: z.number().optional(),
  state: z.object({}).loose(),
})

const authTokenKindSchema = z.enum(['invite', 'session', 'streamwall'])

const authTokenInfoSchema = z.object({
  tokenId: z.string(),
  kind: authTokenKindSchema,
  role: z.enum(validRoles),
  name: z.string(),
})

const streamWindowConfigSchema = z.object({
  cols: gridDimensionSchema,
  rows: gridDimensionSchema,
  width: z.number(),
  height: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
  frameless: z.boolean(),
  fullscreen: z.boolean(),
  display: z.number().int().min(0).optional(),
  activeColor: z.string(),
  backgroundColor: z.string(),
})

/**
 * A single stream entry as it appears inside a full `StreamwallState`
 * snapshot: unlike {@link streamDataInputSchema}, `_id`/`_dataSource` are
 * required here since the desktop always attaches them before broadcasting.
 */
const streamDataSchema = localStreamDataSchema.extend({
  _id: z.string(),
  _dataSource: z.string(),
})

const viewContentSchema = z.object({
  url: urlSchema,
  kind: contentKindSchema,
})

/**
 * Longest allowed `document.title` reported by a stream page (issue #734).
 * The page is untrusted and this value crosses into the shared,
 * server-broadcast state, so it needs the same kind of bound every other
 * externally-supplied growable string in this file has (e.g.
 * {@link MAX_LAYOUT_PRESET_NAME_LENGTH}) - otherwise a hostile page can grow
 * its title without limit and push a `state` frame over the uplink's
 * `maxPayload`, repeatedly dropping the connection. The preload truncates to
 * the same length before this ever reaches the wire; this bound is the
 * server-side backstop in case that truncation is ever bypassed.
 */
export const MAX_VIEW_INFO_TITLE_LENGTH = 200
const contentViewInfoSchema = z.object({
  title: z.string().max(MAX_VIEW_INFO_TITLE_LENGTH),
})

const viewPosSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  spaces: z.array(z.number().transform(asCellIdx)),
})

/**
 * Matches the shape produced by `viewStateMachine.ts`'s XState snapshot
 * `.value`.
 *
 * This is a hand-written mirror of a machine that lives in another package
 * (`streamwall`), so nothing but a test can keep the two in step: it is
 * exported for `viewStateMachineSchemaDrift.test.ts`, which enumerates the
 * machine's reachable state values and asserts every one of them parses here
 * losslessly (issue #419).
 *
 * Unknown keys are stripped rather than rejected on purpose: an unforeseen new
 * region should degrade the control server's picture of that view, never sever
 * the uplink of an otherwise healthy desktop build.
 */
export const viewStateValueSchema = z.union([
  z.literal('empty'),
  z.object({
    displaying: z.union([
      z.literal('error'),
      z.object({
        loading: z.enum(['navigate', 'waitForInit', 'waitForVideo']),
      }),
      z.object({
        running: z.object({
          playback: z.enum(['playing', 'stalled']),
          video: z.enum(['normal', 'blurred']),
          audio: z.enum(['background', 'muted', 'listening']),
          // Media playback paused while the view is parked (issue #374).
          pause: z.enum(['unpaused', 'paused']),
          // Background preload of the next view during a content swap.
          swap: z.union([
            z.literal('idle'),
            z.object({
              preloading: z.enum(['navigate', 'waitForInit', 'waitForVideo']),
            }),
          ]),
        }),
      }),
    ]),
  }),
])

/**
 * Longest allowed reason string for a view's `error` context field (issue
 * #770, following up on #734). `formatError()`
 * (packages/streamwall/src/main/viewStateMachine.ts) derives this from
 * whatever a page's `main()` promise rejects with - in some paths that
 * wraps a real `Error` thrown while loading page-supplied content, so its
 * `.message` could in principle carry attacker-influenced text. The reason
 * flows into the broadcast `StreamwallState`, so left unbounded it is the
 * same denial-of-service vector #734 fixed for `document.title`.
 * `formatError()` truncates to this length before the reason ever reaches
 * this schema; the bound here is the server-side backstop in case that
 * truncation is ever bypassed.
 */
export const MAX_VIEW_ERROR_LENGTH = 1000

const viewStateSchema = z.object({
  state: viewStateValueSchema,
  context: z.object({
    // Stable per-view identity (issue #397). Control commands target views by
    // this `id`, not by grid cell index, so a resize can't misroute them.
    id: viewIdSchema,
    content: viewContentSchema.nullable(),
    info: contentViewInfoSchema.nullable(),
    pos: viewPosSchema.nullable(),
    error: z.string().max(MAX_VIEW_ERROR_LENGTH).nullable(),
    volume: volumeSchema,
  }),
})

const streamDelayStatusSchema = z.object({
  isConnected: z.boolean(),
  delaySeconds: z.number(),
  restartSeconds: z.number(),
  isCensored: z.boolean(),
  isStreamRunning: z.boolean(),
  startTime: z.number(),
  state: z.string(),
})

const layoutPresetSchema = z.object({
  id: layoutPresetIdSchema,
  name: layoutPresetNameSchema,
  cols: gridDimensionSchema,
  rows: gridDimensionSchema,
  views: z.record(z.string(), z.object({ streamId: z.string() })),
})

const dataSourceHealthSchema = z.object({
  id: z.string(),
  type: z.enum(['json-url', 'toml-file']),
  status: z.enum(['ok', 'error']),
  message: z.string().nullable(),
  updatedAt: z.number(),
})

/**
 * The full `StreamwallState` snapshot broadcast by the Streamwall desktop
 * over the trusted uplink. Every field the server actually reads is validated
 * here, so a malformed or adversarial payload can never wrap `StateWrapper`
 * around garbage and fan corrupted state out to connected clients (issue
 * #387). `auth` is intentionally not required: the desktop's own snapshot
 * never includes it, since the control server attaches it separately.
 */
export const streamwallStateSchema = z.object({
  identity: z.object({
    role: z.enum(validRoles),
  }),
  auth: z
    .object({
      invites: z.array(authTokenInfoSchema),
      sessions: z.array(authTokenInfoSchema),
    })
    .optional(),
  config: streamWindowConfigSchema,
  streams: z.array(streamDataSchema),
  customStreams: z.array(streamDataSchema),
  views: z.array(viewStateSchema),
  fullscreenViewIdx: viewIdxSchema.nullable(),
  streamdelay: streamDelayStatusSchema.nullable(),
  layoutPresets: z.array(layoutPresetSchema),
  favorites: z.array(z.string()),
  dataSourceHealth: z.array(dataSourceHealthSchema),
})

/**
 * Response body of the control server's admin-only `GET /admin/status`
 * endpoint (issue #430): the running server version plus whether a newer
 * release exists. The single source of truth for this cross-boundary payload
 * (issue #649): the server derives its `UpdateStatus` response type from it,
 * and the control UI validates the fetched body with it, so producer and
 * consumer cannot drift.
 */
export const serverStatusSchema = z.object({
  /** Version of the running server. */
  version: z.string(),
  /** Latest release seen by the most recent successful check, if any. */
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  /**
   * Narrowed to `null` on anything other than a valid `http(s)` URL rather
   * than rejecting the whole status (issue #773) - see
   * {@link nullableHttpUrlSchema}.
   */
  releaseUrl: nullableHttpUrlSchema,
  /** ISO timestamp of the last *successful* check. */
  lastCheckedAt: z.string().nullable(),
  checkEnabled: z.boolean(),
})

export type ServerStatus = z.infer<typeof serverStatusSchema>
