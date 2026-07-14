import TOML from '@iarna/toml'
import { GRID_MAX, GRID_MIN } from 'streamwall-shared'
import { z } from 'zod'

/**
 * Raised for any invalid startup configuration — malformed TOML or a value that
 * fails schema validation. Carries a message that names the offending file or
 * key so the operator can fix it, instead of surfacing a raw parser stack trace.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Parses a TOML config file, turning the parser's raw exception into a
 * ConfigError that names the file. `@iarna/toml` already reports the row and
 * column of a syntax error, so its message is preserved verbatim.
 */
export function parseConfigToml(text: string, source: string): TOML.JsonMap {
  try {
    return TOML.parse(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`Failed to parse config file "${source}":\n${detail}`)
  }
}

const positiveInt = z.number().int().positive()
const nonNegativeNumber = z.number().nonnegative()
// Kept in lockstep with the WS command schema's grid bounds so a configured
// wall can always be targeted and resized by remote control commands.
const gridDimension = z.number().int().min(GRID_MIN).max(GRID_MAX)

/**
 * Shape of the resolved Streamwall configuration (config file + CLI flags after
 * yargs applies defaults). Unknown keys — including the camelCase and `_`/`$0`
 * entries yargs adds — are ignored; the known ones are type- and range-checked.
 */
const streamwallConfigSchema = z.object({
  help: z.boolean().optional(),
  grid: z.object({
    cols: gridDimension,
    rows: gridDimension,
  }),
  window: z.object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: positiveInt,
    height: positiveInt,
    frameless: z.boolean(),
    'background-color': z.string(),
    'active-color': z.string(),
  }),
  data: z.object({
    interval: z.number().positive(),
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
  retry: z.object({
    enabled: z.boolean(),
    delay: nonNegativeNumber,
    'max-delay': nonNegativeNumber,
    'max-retries': z.number().int().nonnegative(),
    'stalled-timeout': nonNegativeNumber,
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

/**
 * Validates the resolved configuration, throwing a ConfigError that names the
 * offending key(s) when a value is missing, of the wrong type, or out of range.
 */
export function validateConfig(config: unknown): void {
  const result = streamwallConfigSchema.safeParse(config)
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration:\n${z.prettifyError(result.error)}`,
    )
  }
}

/**
 * Recursively finds keys in a raw parsed config object that don't exist in
 * the schema, returning their dotted paths (e.g. "grid.count"). Meant to run
 * against the raw TOML tables read from a config file — not the yargs-merged
 * argv, which carries CLI-only additions (camelCase aliases, `_`, `$0`) that
 * are never mistakes.
 *
 * A key whose schema type isn't an object is treated as a leaf: its value is
 * never walked into, even if the operator nested a table under it by mistake
 * (e.g. `[grid.cols]`) — the type check in validateConfig already covers that.
 */
export function findUnknownConfigKeys(raw: unknown): string[] {
  return collectUnknownKeys(raw, streamwallConfigSchema, [])
}

function collectUnknownKeys(
  raw: unknown,
  schema: z.ZodTypeAny,
  path: string[],
): string[] {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    !(schema instanceof z.ZodObject)
  ) {
    return []
  }

  const shape = schema.shape
  const unknown: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    const fieldSchema = shape[key]
    const keyPath = [...path, key]
    if (fieldSchema === undefined) {
      unknown.push(keyPath.join('.'))
    } else {
      unknown.push(...collectUnknownKeys(value, fieldSchema, keyPath))
    }
  }
  return unknown
}
