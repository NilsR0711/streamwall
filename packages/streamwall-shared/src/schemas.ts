import { z } from 'zod'
import { validRoles, type StreamwallRole } from './roles.ts'
import type { StreamDataContent } from './types.ts'

/**
 * Runtime validation for every piece of external/untrusted data that enters
 * Streamwall: the desktop config file, stream data from URLs/files, and the
 * WebSocket control protocol (both JSON commands and binary Yjs updates).
 *
 * The schemas live here in the shared package so the desktop app, the control
 * server and the web clients all validate against a single source of truth.
 */

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Render a {@link z.ZodError} into a compact, human-readable string that names
 * the offending key path(s) — e.g. `config: grid.cols: Too small`.
 */
export function formatZodError(
  error: z.ZodError,
  opts?: { source?: string },
): string {
  const prefix = opts?.source ? `${opts.source}: ` : ''
  const lines = error.issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  return `${prefix}${lines.join('; ')}`
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const roleSchema = z.enum(validRoles)

/**
 * Roles that may be handed out via an invite. Deliberately excludes `local`
 * (the desktop's own all-powerful role) to prevent privilege confusion from a
 * crafted `create-invite` message.
 */
export const invitableRoleSchema = z.enum(['admin', 'operator', 'monitor'])

/** Validate a role string chosen for an invite; returns null if not invitable. */
export function parseInvitableRole(raw: unknown): StreamwallRole | null {
  const result = invitableRoleSchema.safeParse(raw)
  return result.success ? result.data : null
}

// ---------------------------------------------------------------------------
// Stream data (from JSON URLs and TOML files)
// ---------------------------------------------------------------------------

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

/**
 * A single incoming stream entry. Unknown keys (including the internal `_id`
 * and `_dataSource`) are stripped so untrusted sources cannot spoof them.
 */
export const streamDataInputSchema = z.object({
  kind: contentKindSchema.default('video'),
  link: z.string().min(1),
  label: z.string().optional(),
  labelPosition: labelPositionSchema.optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  orientation: orientationSchema.optional(),
  addedDate: z.string().optional(),
  rotation: z.number().min(0).max(360).optional(),
})

/**
 * Leniently parse a list of stream entries: valid entries are kept, invalid
 * ones are dropped and reported (so a single bad row doesn't wipe the wall).
 */
export function parseStreamList(raw: unknown): {
  streams: StreamDataContent[]
  errors: string[]
} {
  const streams: StreamDataContent[] = []
  const errors: string[] = []

  if (!Array.isArray(raw)) {
    errors.push('stream data must be an array')
    return { streams, errors }
  }

  raw.forEach((entry, index) => {
    const result = streamDataInputSchema.safeParse(entry)
    if (result.success) {
      streams.push(result.data)
    } else {
      errors.push(formatZodError(result.error, { source: `stream[${index}]` }))
    }
  })

  return { streams, errors }
}

// ---------------------------------------------------------------------------
// Desktop configuration
// ---------------------------------------------------------------------------

const nonNegativeNumber = z.number().finite().min(0)

export const streamwallConfigSchema = z.object({
  help: z.boolean().optional(),
  grid: z.object({
    cols: z.number().int().min(1).max(100),
    rows: z.number().int().min(1).max(100),
  }),
  window: z.object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameless: z.boolean(),
    'background-color': z.string(),
    'active-color': z.string(),
  }),
  data: z.object({
    interval: nonNegativeNumber,
    'json-url': z.array(z.string()),
    'toml-file': z.array(z.string()),
  }),
  streamdelay: z.object({
    endpoint: z.string(),
    key: z.string().nullable(),
  }),
  control: z.object({
    endpoint: z.string().nullable(),
  }),
  twitch: z.object({
    channel: z.string().nullable(),
    username: z.string().nullable(),
    token: z.string().nullable(),
    color: z.string(),
    announce: z.object({
      template: z.string(),
      interval: nonNegativeNumber,
      delay: nonNegativeNumber,
    }),
    vote: z.object({
      template: z.string(),
      interval: nonNegativeNumber,
    }),
  }),
  telemetry: z.object({
    sentry: z.boolean(),
  }),
})

export type StreamwallConfig = z.infer<typeof streamwallConfigSchema>

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

/**
 * Validate the merged (CLI + TOML) config. Throws {@link ConfigValidationError}
 * with a message naming the offending key(s) on failure. Extra keys yargs adds
 * (`_`, `$0`, camelCase aliases) are stripped.
 */
export function validateConfig(raw: unknown): StreamwallConfig {
  const result = streamwallConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigValidationError(
      formatZodError(result.error, { source: 'config' }),
    )
  }
  return result.data
}

// ---------------------------------------------------------------------------
// Control protocol: JSON commands (client -> server -> desktop)
// ---------------------------------------------------------------------------

const viewIdxSchema = z.number().int().min(0)
const nonEmptyString = z.string().min(1)
const rotationSchema = z.number().min(0).max(360)

/**
 * Discriminated union of every control command, mirroring `ControlCommand`.
 * Numeric fields are bounded and roles are constrained.
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
    url: nonEmptyString,
    rotation: rotationSchema,
  }),
  z.object({
    type: z.literal('update-custom-stream'),
    url: nonEmptyString,
    data: streamDataInputSchema,
  }),
  z.object({
    type: z.literal('delete-custom-stream'),
    url: nonEmptyString,
  }),
  z.object({
    type: z.literal('reload-view'),
    viewIdx: viewIdxSchema,
  }),
  z.object({
    type: z.literal('browse'),
    url: nonEmptyString,
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
    // cols/rows are clamped to the valid grid range by the handler, so only
    // finiteness is enforced here.
    type: z.literal('set-grid-size'),
    cols: z.number().finite(),
    rows: z.number().finite(),
  }),
  z.object({
    type: z.literal('create-invite'),
    role: invitableRoleSchema,
    name: nonEmptyString,
  }),
  z.object({
    type: z.literal('delete-token'),
    tokenId: nonEmptyString,
  }),
])

export type ValidatedControlCommand = z.infer<typeof controlCommandSchema>

const commandMetaSchema = z.object({ id: z.number().int().min(0) })

export type ControlCommandResult =
  | { success: true; message: ValidatedControlCommand & { id: number } }
  | { success: false; error: string }

/**
 * Validate a JSON control message received from a web client. The client
 * attaches a numeric `id` (for response correlation); the command payload must
 * match {@link controlCommandSchema}.
 */
export function parseControlCommandMessage(raw: unknown): ControlCommandResult {
  const meta = commandMetaSchema.safeParse(raw)
  if (!meta.success) {
    return { success: false, error: formatZodError(meta.error) }
  }
  const command = controlCommandSchema.safeParse(raw)
  if (!command.success) {
    return { success: false, error: formatZodError(command.error) }
  }
  return { success: true, message: { ...command.data, id: meta.data.id } }
}

// ---------------------------------------------------------------------------
// Control protocol: state envelope (desktop -> server -> client)
// ---------------------------------------------------------------------------

const streamwallStateSchema = z
  .object({
    identity: z.object({ role: roleSchema }).loose().optional(),
  })
  .loose()

const controlUpdateMessageSchema = z
  .object({
    type: z.literal('state'),
    state: streamwallStateSchema,
  })
  .loose()

export type ControlUpdateResult =
  | { success: true; message: z.infer<typeof controlUpdateMessageSchema> }
  | { success: false; error: string }

/**
 * Validate the `{ type: 'state', state }` envelope sent by the desktop uplink.
 * The full state is large and evolving, so only the security-relevant shape is
 * enforced (envelope type, state is an object, valid identity role); all other
 * keys pass through untouched for forwarding.
 */
export function parseControlUpdateMessage(raw: unknown): ControlUpdateResult {
  const result = controlUpdateMessageSchema.safeParse(raw)
  if (!result.success) {
    return { success: false, error: formatZodError(result.error) }
  }
  return { success: true, message: result.data }
}

export type StreamwallStateShapeResult =
  | { success: true }
  | { success: false; error: string }

/**
 * Lenient shape check for a received `StreamwallState`: it must be an object
 * and, if present, its identity role must be valid. Used defensively by the
 * clients before trusting incoming state.
 */
export function validateStreamwallStateShape(
  raw: unknown,
): StreamwallStateShapeResult {
  const result = streamwallStateSchema.safeParse(raw)
  if (!result.success) {
    return { success: false, error: formatZodError(result.error) }
  }
  return { success: true }
}

// ---------------------------------------------------------------------------
// Invite response (server -> client)
// ---------------------------------------------------------------------------

export const inviteResponseSchema = z.object({
  tokenId: z.string().min(1),
  name: z.string(),
  secret: z.string().min(1),
})

export type InviteResponse = z.infer<typeof inviteResponseSchema>

export type InviteResponseResult =
  | { success: true; invite: InviteResponse }
  | { success: false; error: string }

/**
 * Validate the invite created in response to a `create-invite` command. The
 * transport fields (`response`, `id`) are ignored.
 */
export function parseInviteResponse(raw: unknown): InviteResponseResult {
  const result = inviteResponseSchema.safeParse(raw)
  if (!result.success) {
    return { success: false, error: formatZodError(result.error) }
  }
  return { success: true, invite: result.data }
}

// ---------------------------------------------------------------------------
// Byte-size guards (DoS protection for WS messages and Yjs updates)
// ---------------------------------------------------------------------------

/** Maximum size of a single JSON (text) control-protocol message. */
export const MAX_WS_TEXT_MESSAGE_BYTES = 256 * 1024
/** Maximum size of a single incoming binary Yjs update. */
export const MAX_YJS_UPDATE_BYTES = 1024 * 1024
/** Maximum size of the full encoded Yjs document. */
export const MAX_YJS_DOC_BYTES = 8 * 1024 * 1024

const textEncoder = new TextEncoder()

/** Byte length of a string (UTF-8), ArrayBuffer or typed-array view. */
export function byteLength(
  data: string | ArrayBuffer | ArrayBufferView,
): number {
  if (typeof data === 'string') {
    return textEncoder.encode(data).length
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength
  }
  return data.byteLength
}

/** True when `data` is within (<=) the given byte limit. */
export function isWithinByteLimit(
  data: string | ArrayBuffer | ArrayBufferView,
  maxBytes: number,
): boolean {
  return byteLength(data) <= maxBytes
}

// ---------------------------------------------------------------------------
// Collaborative (Yjs) document shape
// ---------------------------------------------------------------------------

const collabViewSchema = z.object({ streamId: z.string().optional() }).loose()

const collabViewsSchema = z.record(z.string(), collabViewSchema)

export type CollabStateResult =
  | { valid: true }
  | { valid: false; error: string }

/**
 * Verify the shape of the collaborative `views` map (as returned by
 * `Y.Map.toJSON()`) after applying an update, to catch corruption before it is
 * broadcast. `views` must map indices to `{ streamId?: string }` objects.
 */
export function verifyCollabState(json: unknown): CollabStateResult {
  const result = collabViewsSchema.safeParse(json)
  if (!result.success) {
    return { valid: false, error: formatZodError(result.error) }
  }
  return { valid: true }
}
