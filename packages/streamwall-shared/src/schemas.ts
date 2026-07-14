import { z } from 'zod'
import { GRID_MAX, GRID_MIN } from './geometry.ts'
import { validRoles } from './roles.ts'

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
const viewIdxSchema = z.number().int().min(0).max(MAX_VIEW_IDX)
const gridDimensionSchema = z.number().int().min(GRID_MIN).max(GRID_MAX)

/** Longest allowed name for a saved layout preset. */
export const MAX_LAYOUT_PRESET_NAME_LENGTH = 100
const layoutPresetNameSchema = z
  .string()
  .min(1)
  .max(MAX_LAYOUT_PRESET_NAME_LENGTH)
const layoutPresetIdSchema = z.string().min(1).max(100)

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
  link: z.string().min(1),
  kind: contentKindSchema.optional(),
  ...streamMetaFields,
})

export type StreamDataInput = z.infer<typeof streamDataInputSchema>

/**
 * Payload of an `update-custom-stream` command. Unlike an external data source
 * this carries a resolved `kind`, matching the shared `LocalStreamData` type.
 */
export const localStreamDataSchema = z.object({
  link: z.string().min(1),
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
    viewIdx: viewIdxSchema.nullable(),
  }),
  z.object({
    type: z.literal('set-view-background-listening'),
    viewIdx: viewIdxSchema,
    listening: z.boolean(),
  }),
  z.object({
    type: z.literal('set-view-blurred'),
    viewIdx: viewIdxSchema,
    blurred: z.boolean(),
  }),
  z.object({
    type: z.literal('rotate-stream'),
    url: z.string(),
    rotation: rotationSchema,
  }),
  z.object({
    type: z.literal('update-custom-stream'),
    url: z.string(),
    data: localStreamDataSchema,
  }),
  z.object({
    type: z.literal('delete-custom-stream'),
    url: z.string(),
  }),
  z.object({
    type: z.literal('reload-view'),
    viewIdx: viewIdxSchema,
  }),
  z.object({
    type: z.literal('browse'),
    url: z.string(),
  }),
  z.object({
    type: z.literal('dev-tools'),
    viewIdx: viewIdxSchema,
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
    role: z.enum(validRoles),
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
])

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
 * discriminator and a non-null object payload.
 */
export const controlStateMessageSchema = z.object({
  type: z.literal('state'),
  id: z.number().optional(),
  state: z.object({}).loose(),
})
