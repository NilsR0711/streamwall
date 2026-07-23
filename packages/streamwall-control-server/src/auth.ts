import baseX from 'base-x'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto'
import EventEmitter from 'events'
import {
  type AuthTokenInfo,
  type StreamwallRole,
  type StreamwallState,
  validRolesSet,
} from 'streamwall-shared'
import { type Logger, tokenIdPrefix } from './logger.ts'
import type { StoredData } from './storage.ts'

export interface AuthToken extends AuthTokenInfo {
  tokenHash: string
  // Per-token salt. Optional so that tokens persisted before this field
  // existed (hashed with the shared `Auth.salt`) still type-check and keep
  // validating via the shared-salt fallback in `validateToken`.
  salt?: string
}

export interface AuthState {
  invites: AuthTokenInfo[]
  sessions: AuthTokenInfo[]
}

interface AuthEvents {
  state: [AuthState]
}

const base62 = baseX(
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
)

export function rand62(len: number) {
  return base62.encode(randomBytes(len))
}

export function uniqueRand62(len: number, map: Map<string, unknown>) {
  let val = rand62(len)
  while (map.has(val)) {
    // Regenerate in case of a collision
    val = rand62(len)
  }
  return val
}

// Length of the raw scrypt digest, in bytes. Fixed regardless of input, which
// is what lets `validateToken` compare digests in constant time.
const SCRYPT_KEYLEN = 24

export interface ScryptParams {
  N: number
  r: number
  p: number
}

// scrypt cost parameters, pinned explicitly rather than relying on Node's
// implicit defaults. These MUST match the values used to hash every
// already-persisted token (Node's defaults: N=16384, r=8, p=1) — raising them
// would invalidate existing session, invite and streamwall-uplink tokens on
// upgrade. The token secrets themselves are 24 random bytes (~143 bits), so a
// higher work factor would add cost without meaningfully improving security.
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 }

// Raw, fixed-length scrypt digest of a secret under a given salt.
function hashTokenRaw(
  secret: string,
  salt: string,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, SCRYPT_KEYLEN, params, (err, derivedKey) => {
      if (err) {
        reject(err)
      } else {
        resolve(derivedKey)
      }
    })
  })
}

// Persisted form of a token hash: the raw digest, base62-encoded.
async function hashToken62(
  secret: string,
  salt: string,
  params: ScryptParams,
): Promise<string> {
  return base62.encode(await hashTokenRaw(secret, salt, params))
}

// Wrapper for state data to facilitate role-scoped data access.
export class StateWrapper extends EventEmitter {
  _value: StreamwallState

  constructor(value: StreamwallState) {
    super()
    this._value = value
  }

  toJSON() {
    return '<state data>'
  }

  view(role: StreamwallRole) {
    const {
      config,
      auth,
      streams,
      customStreams,
      views,
      fullscreenViewIdx,
      streamdelay,
      layoutPresets,
      favorites,
      dataSourceHealth,
    } = this._value

    const state: StreamwallState = {
      identity: {
        role,
      },
      config,
      streams,
      customStreams,
      views,
      fullscreenViewIdx,
      streamdelay,
      layoutPresets,
      favorites,
      dataSourceHealth,
    }
    if (role === 'admin') {
      state.auth = auth
    }

    return state
  }

  update(value: Partial<StreamwallState>) {
    this._value = { ...this._value, ...value }
    this.emit('state', this)
  }

  // Unprivileged getter
  get info() {
    return this.view('monitor')
  }
}

export class Auth extends EventEmitter<AuthEvents> {
  salt: string
  tokensById: Map<string, AuthToken>
  /**
   * Optional so `Auth` stays usable standalone (specs, tooling); when absent,
   * token lifecycle events simply go unlogged rather than to raw stdout.
   */
  private log?: Logger
  /**
   * The work factor every token of this instance is hashed and verified under.
   * Injectable so test suites that boot a live server per test do not pay the
   * production cost for derivations they never assert on; a lowered factor is
   * deliberately not reachable from the environment, so no deployment can end
   * up with one by accident. It is part of the stored hash: changing it for an
   * existing store invalidates every persisted token.
   */
  readonly scryptParams: ScryptParams

  constructor(
    { salt, tokens = [] }: Partial<StoredData['auth']> = {},
    log?: Logger,
    {
      scryptParams = DEFAULT_SCRYPT_PARAMS,
    }: { scryptParams?: ScryptParams } = {},
  ) {
    super()
    this.log = log
    this.scryptParams = scryptParams
    this.salt = salt ?? rand62(24)
    this.tokensById = new Map()
    for (const token of tokens) {
      this.tokensById.set(token.tokenId, token)
    }
  }

  getStoredData() {
    return {
      salt: this.salt,
      tokens: [...this.tokensById.values()],
    }
  }

  getState() {
    const toTokenInfo = ({ tokenId, name, kind, role }: AuthTokenInfo) => ({
      tokenId,
      name,
      kind,
      role,
    })
    return {
      invites: this.tokensById
        .values()
        .filter((t) => t.kind === 'invite')
        .map(toTokenInfo)
        .toArray(),
      sessions: this.tokensById
        .values()
        .filter((t) => t.kind === 'session')
        .map(toTokenInfo)
        .toArray(),
    }
  }

  emitState() {
    this.emit('state', this.getState())
  }

  async validateToken(
    id: string,
    secret: string,
  ): Promise<AuthTokenInfo | null> {
    const tokenData = this.tokensById.get(id)

    // Hash unconditionally — even for an unknown id — so the response time does
    // not reveal whether the id exists (a user-enumeration oracle). Tokens
    // persisted before per-token salts fall back to the shared salt.
    const salt = tokenData?.salt ?? this.salt
    const providedTokenHash = await hashTokenRaw(
      secret,
      salt,
      this.scryptParams,
    )

    // Re-read the record after the (async) hash: `deleteToken` may have revoked
    // it while scrypt was running. Authenticating against the stale snapshot
    // would let an already revoked secret succeed. Reference equality also
    // rejects the case where the id was deleted and later reused for a new
    // token (whose hash was computed under a different salt).
    if (!tokenData || this.tokensById.get(id) !== tokenData) {
      return null
    }

    // Compare the fixed-length raw digests, not their base62 encodings: base62
    // length depends on the digest's leading zero bytes, and feeding
    // unequal-length buffers to `timingSafeEqual` throws a RangeError (and the
    // early exit leaks the length). Malformed stored data that fails to decode
    // is treated as a non-match.
    let expectedTokenHash: Uint8Array
    try {
      expectedTokenHash = base62.decode(tokenData.tokenHash)
    } catch {
      return null
    }

    if (
      providedTokenHash.length !== expectedTokenHash.length ||
      !timingSafeEqual(providedTokenHash, expectedTokenHash)
    ) {
      return null
    }

    return {
      tokenId: tokenData.tokenId,
      kind: tokenData.kind,
      role: tokenData.role,
      name: tokenData.name,
    }
  }

  async createToken({ kind, role, name }: Omit<AuthTokenInfo, 'tokenId'>) {
    if (!validRolesSet.has(role)) {
      throw new Error(`invalid role: ${role}`)
    }

    const tokenId = uniqueRand62(8, this.tokensById)
    const secret = rand62(24)
    const salt = rand62(24)
    const tokenHash = await hashToken62(secret, salt, this.scryptParams)
    const tokenData: AuthToken = {
      tokenId,
      tokenHash,
      salt,
      kind,
      role,
      name,
    }
    this.tokensById.set(tokenId, tokenData)
    this.emitState()

    // The operator-supplied `name` identifies a person, so it never reaches
    // the log; the token id is truncated to a correlation-only prefix.
    this.log?.debug(
      { kind, role, tokenIdPrefix: tokenIdPrefix(tokenId) },
      'Created token',
    )

    return { tokenId, secret }
  }

  /**
   * Removes the token with `tokenId`. Returns whether a token was actually
   * deleted, so callers can acknowledge the outcome (see the `delete-token`
   * command handler, which relays this to the requesting client).
   */
  deleteToken(tokenId: string): boolean {
    const tokenData = this.tokensById.get(tokenId)
    if (!tokenData) {
      return false
    }
    this.tokensById.delete(tokenData.tokenId)
    this.emitState()
    return true
  }
}
