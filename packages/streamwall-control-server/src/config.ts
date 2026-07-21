import process from 'node:process'

import type { DocUpdateLimits } from './stateDocGuard.ts'

export const SESSION_COOKIE_NAME = 's'
// `@fastify/cookie` serializes `maxAge` into the RFC 6265 `Max-Age` attribute,
// which is measured in SECONDS (not milliseconds). Keep this value in seconds —
// one year — so sessions stay long-lived while remaining bounded.
export const SESSION_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
export const STREAMWALL_PING_TIMEOUT_MS = 5 * 1000

const DEFAULT_GLOBAL_RATE_LIMIT_MAX = 100
const DEFAULT_AUTH_RATE_LIMIT_MAX = 10
const DEFAULT_RATE_LIMIT_WINDOW = '1 minute'

// Inbound WebSocket message limits, applied per connection as a token bucket.
// Defaults are generous: normal collaborative editing bursts (e.g. dragging a
// tile) stay well under them, while a flood empties the bucket and the socket
// is closed so the client reconnects and cleanly resyncs.
const DEFAULT_WS_MSG_RATE = 100
const DEFAULT_WS_MSG_BURST = 1000

// Bounds on inbound binary Yjs updates from untrusted clients. The shared state
// doc only holds a grid of view assignments, so these are generous headroom
// rather than tight fits — enough to block a single oversized update, or one
// that balloons the doc, from corrupting shared state or exhausting memory.
const DEFAULT_WS_UPDATE_MAX_BYTES = 512 * 1024
const DEFAULT_WS_DOC_GROWTH_MAX_BYTES = 1024 * 1024

/** Parses a positive numeric env value, falling back when unset or invalid. */
function parsePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export interface RateLimitConfig {
  globalMax: number
  authMax: number
  timeWindow: string
}

/**
 * Reads the per-IP rate limit configuration from the environment. Read lazily
 * (per `initApp` call) rather than at module load so overrides apply cleanly.
 */
export function getRateLimitConfig(): RateLimitConfig {
  return {
    globalMax: parsePositiveNumber(
      process.env.STREAMWALL_RATE_LIMIT_MAX,
      DEFAULT_GLOBAL_RATE_LIMIT_MAX,
    ),
    authMax: parsePositiveNumber(
      process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_MAX,
    ),
    timeWindow:
      process.env.STREAMWALL_RATE_LIMIT_WINDOW ?? DEFAULT_RATE_LIMIT_WINDOW,
  }
}

/**
 * Parse `STREAMWALL_TRUST_PROXY` for Fastify's `trustProxy` option.
 * Off by default so a bare internet-facing server never trusts client-supplied
 * `X-Forwarded-For`. Behind a reverse proxy, set `true` (or an IP/CIDR list).
 * @see https://fastify.dev/docs/latest/Reference/Server/#trustproxy
 */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  if (raw == null || raw.trim() === '') {
    return false
  }
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
    return true
  }
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') {
    return false
  }
  // IP, CIDR, or comma-separated list — pass through for Fastify.
  return raw.trim()
}

export interface WsMessageLimitConfig {
  capacity: number
  refillPerSec: number
}

/** Reads the inbound WebSocket message rate configuration from the env. */
export function getWsMessageLimitConfig(): WsMessageLimitConfig {
  return {
    capacity: parsePositiveNumber(
      process.env.STREAMWALL_WS_MSG_BURST,
      DEFAULT_WS_MSG_BURST,
    ),
    refillPerSec: parsePositiveNumber(
      process.env.STREAMWALL_WS_MSG_RATE,
      DEFAULT_WS_MSG_RATE,
    ),
  }
}

/** Reads the binary Yjs update size limits from the environment. */
export function getDocUpdateLimits(): DocUpdateLimits {
  return {
    maxUpdateBytes: parsePositiveNumber(
      process.env.STREAMWALL_WS_UPDATE_MAX_BYTES,
      DEFAULT_WS_UPDATE_MAX_BYTES,
    ),
    maxDocGrowthBytes: parsePositiveNumber(
      process.env.STREAMWALL_WS_DOC_GROWTH_MAX_BYTES,
      DEFAULT_WS_DOC_GROWTH_MAX_BYTES,
    ),
  }
}

/**
 * Resolve the TCP listen port for the control server.
 * `URL.port` is `""` (not undefined) when the URL has no explicit port, so
 * `??` alone would leave an empty string and `Number('') === 0` (ephemeral bind).
 * Prefer an explicit override, else URL port, else the scheme default.
 */
export function resolveListenPort(
  baseURL: string,
  overridePort?: string,
): number {
  const url = new URL(baseURL)
  const explicit =
    overridePort != null && String(overridePort).trim() !== ''
      ? String(overridePort).trim()
      : undefined
  const fromUrl = url.port || (url.protocol === 'https:' ? '443' : '80')
  return Number(explicit ?? fromUrl)
}
