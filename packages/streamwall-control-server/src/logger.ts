import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import process from 'node:process'

import type { AuthTokenInfo } from 'streamwall-shared'

/**
 * The logger interface the server codes against: Fastify's own (pino) logger,
 * reached as `app.log` / `request.log`. Handlers take it as a parameter rather
 * than importing a module-level singleton, so every entry inherits the request
 * correlation id (`reqId`) of the connection it belongs to.
 */
export type Logger = FastifyBaseLogger

const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

const DEFAULT_LOG_LEVEL: LogLevel = 'info'

/**
 * Parses `LOG_LEVEL` into a pino level. An unset, blank or unrecognized value
 * falls back to `info`: a typo must never silence the server (or crash it at
 * boot), which is the failure mode that hurts most in production.
 */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(value ?? '')
    ? (value as LogLevel)
    : DEFAULT_LOG_LEVEL
}

/**
 * How many leading characters of a token id survive into a debug log entry.
 * Enough to correlate two entries within one process, far too few to be used
 * as a credential or to re-identify a session from an aggregated log store.
 */
const TOKEN_ID_PREFIX_LENGTH = 4

/** Truncates a token id to a correlation-only prefix (debug level). */
export function tokenIdPrefix(tokenId: string): string {
  return tokenId.slice(0, TOKEN_ID_PREFIX_LENGTH)
}

/**
 * Identity fields safe to log at info level and above: the role only. Token
 * ids and the operator-supplied token name are deliberately omitted — they are
 * identifiable session metadata that would otherwise end up in shared hosting
 * or log-aggregation systems (issue #410).
 */
export function identityFields(identity: AuthTokenInfo): { role: string } {
  return { role: identity.role }
}

/** Identity fields for debug level: adds a truncated token id, never the name. */
export function identityDebugFields(identity: AuthTokenInfo): {
  role: string
  kind: string
  tokenIdPrefix: string
} {
  return {
    role: identity.role,
    kind: identity.kind,
    tokenIdPrefix: tokenIdPrefix(identity.tokenId),
  }
}

// Routes that carry a token id in their path. Fastify's default request
// serializer logs the raw url, which would otherwise publish those ids on
// every request line.
const TOKEN_PATH_PATTERN = /^\/(streamwall|invite)\/[^/?#]+/

/** Replaces a token id embedded in a request path with a redaction marker. */
export function redactRequestUrl(url: string): string {
  return url.replace(TOKEN_PATH_PATTERN, '/$1/[redacted]')
}

/** Request serializer mirroring pino's default, with the url redacted. */
function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: redactRequestUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
  }
}

export interface LoggerOptions {
  level: LogLevel
  serializers: { req: typeof serializeRequest }
}

/**
 * Fastify logger options: structured JSON on stdout (pino's default output),
 * at the level configured via `LOG_LEVEL`. Read per `initApp` call rather than
 * at module load so overrides apply cleanly in tests.
 */
export function getLoggerOptions(
  level: LogLevel = resolveLogLevel(process.env.LOG_LEVEL),
): LoggerOptions {
  return { level, serializers: { req: serializeRequest } }
}
