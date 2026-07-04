import { describe, expect, it } from 'vitest'
import {
  ConfigValidationError,
  MAX_WS_TEXT_MESSAGE_BYTES,
  MAX_YJS_DOC_BYTES,
  MAX_YJS_UPDATE_BYTES,
  byteLength,
  formatZodError,
  isWithinByteLimit,
  parseControlCommandMessage,
  parseControlUpdateMessage,
  parseInvitableRole,
  parseInviteResponse,
  parseStreamList,
  streamwallConfigSchema,
  validateConfig,
  validateStreamwallStateShape,
  verifyCollabState,
} from './schemas.ts'

function validRawConfig() {
  return {
    help: false,
    grid: { cols: 3, rows: 3 },
    window: {
      width: 1920,
      height: 1080,
      frameless: false,
      'background-color': '#000',
      'active-color': '#fff',
    },
    data: { interval: 30, 'json-url': [], 'toml-file': [] },
    streamdelay: { endpoint: 'http://localhost:8404', key: null },
    control: { endpoint: null },
    twitch: {
      channel: null,
      username: null,
      token: null,
      color: '#ff0000',
      announce: { template: 'x', interval: 60, delay: 30 },
      vote: { template: 'y', interval: 0 },
    },
    telemetry: { sentry: true },
    // yargs pollutants that must be stripped:
    _: [],
    $0: 'streamwall',
  }
}

describe('formatZodError', () => {
  it('names the offending key path', () => {
    const result = streamwallConfigSchema.safeParse({
      ...validRawConfig(),
      grid: { cols: -1, rows: 3 },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const msg = formatZodError(result.error)
    expect(msg).toContain('grid.cols')
  })

  it('prefixes messages with the provided source', () => {
    const result = streamwallConfigSchema.safeParse({
      ...validRawConfig(),
      grid: { cols: 0, rows: 3 },
    })
    if (result.success) throw new Error('expected failure')
    const msg = formatZodError(result.error, { source: 'config.toml' })
    expect(msg).toContain('config.toml')
    expect(msg).toContain('grid.cols')
  })
})

describe('parseStreamList', () => {
  it('keeps valid entries and reports invalid ones', () => {
    const { streams, errors } = parseStreamList([
      { link: 'https://a.example/live', kind: 'video', label: 'A' },
      { kind: 'video' }, // missing link
      'not-an-object',
    ])
    expect(streams).toHaveLength(1)
    expect(streams[0].link).toBe('https://a.example/live')
    expect(errors).toHaveLength(2)
    expect(errors.join('\n')).toContain('1')
  })

  it('defaults kind to video when omitted', () => {
    const { streams } = parseStreamList([{ link: 'https://a.example/live' }])
    expect(streams[0].kind).toBe('video')
  })

  it('strips injected internal fields (_id, _dataSource)', () => {
    const { streams } = parseStreamList([
      {
        link: 'https://a.example/live',
        _id: 'evil',
        _dataSource: 'spoofed',
      } as unknown,
    ])
    expect(streams[0]).not.toHaveProperty('_id')
    expect(streams[0]).not.toHaveProperty('_dataSource')
  })

  it('rejects non-array input with an error and empty result', () => {
    const { streams, errors } = parseStreamList({ streams: [] })
    expect(streams).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
  })

  it('bounds rotation to a sane range', () => {
    const { streams, errors } = parseStreamList([
      { link: 'https://a.example/live', rotation: 9999 },
    ])
    expect(streams).toHaveLength(0)
    expect(errors.length).toBe(1)
  })
})

describe('validateConfig', () => {
  it('returns a typed config for valid input, stripping yargs pollutants', () => {
    const config = validateConfig(validRawConfig())
    expect(config.grid.cols).toBe(3)
    expect(config.window['background-color']).toBe('#000')
    expect(config).not.toHaveProperty('_')
    expect(config).not.toHaveProperty('$0')
  })

  it('throws ConfigValidationError naming the bad key', () => {
    const bad = { ...validRawConfig(), grid: { cols: 0, rows: 3 } }
    expect(() => validateConfig(bad)).toThrow(ConfigValidationError)
    try {
      validateConfig(bad)
    } catch (err) {
      expect((err as Error).message).toContain('grid.cols')
    }
  })

  it('rejects NaN that slipped through numeric coercion', () => {
    const bad = { ...validRawConfig(), grid: { cols: NaN, rows: 3 } }
    expect(() => validateConfig(bad)).toThrow(ConfigValidationError)
  })

  it('accepts optional window position', () => {
    const raw = validRawConfig()
    raw.window = { ...raw.window, x: 10, y: 20 } as typeof raw.window & {
      x: number
      y: number
    }
    const config = validateConfig(raw)
    expect(config.window.x).toBe(10)
  })
})

describe('parseControlCommandMessage', () => {
  it('accepts a well-formed command with a numeric id', () => {
    const result = parseControlCommandMessage({
      id: 0,
      type: 'set-view-blurred',
      viewIdx: 2,
      blurred: true,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.message.type).toBe('set-view-blurred')
    expect(result.message.id).toBe(0)
  })

  it('accepts null viewIdx for set-listening-view', () => {
    const result = parseControlCommandMessage({
      id: 1,
      type: 'set-listening-view',
      viewIdx: null,
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown command type', () => {
    const result = parseControlCommandMessage({ id: 1, type: 'drop-database' })
    expect(result.success).toBe(false)
  })

  it('rejects a command missing required fields', () => {
    const result = parseControlCommandMessage({
      id: 1,
      type: 'set-view-blurred',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a create-invite with an unknown role', () => {
    const result = parseControlCommandMessage({
      id: 1,
      type: 'create-invite',
      name: 'x',
      role: 'superuser',
    })
    expect(result.success).toBe(false)
  })

  it('rejects create-invite with role "local" (privilege confusion)', () => {
    const result = parseControlCommandMessage({
      id: 1,
      type: 'create-invite',
      name: 'x',
      role: 'local',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid create-invite', () => {
    const result = parseControlCommandMessage({
      id: 3,
      type: 'create-invite',
      name: 'Alice',
      role: 'operator',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a message with no id', () => {
    const result = parseControlCommandMessage({
      type: 'reload-view',
      viewIdx: 0,
    })
    expect(result.success).toBe(false)
  })

  it('validates the nested data of update-custom-stream', () => {
    const ok = parseControlCommandMessage({
      id: 4,
      type: 'update-custom-stream',
      url: 'https://x.example/s',
      data: { link: 'https://x.example/s', kind: 'video' },
    })
    expect(ok.success).toBe(true)

    const bad = parseControlCommandMessage({
      id: 4,
      type: 'update-custom-stream',
      url: 'https://x.example/s',
      data: { kind: 'not-a-kind' },
    })
    expect(bad.success).toBe(false)
  })

  it('accepts a set-grid-size command with finite dimensions', () => {
    const result = parseControlCommandMessage({
      id: 9,
      type: 'set-grid-size',
      cols: 4,
      rows: 3,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a set-grid-size command with a non-numeric dimension', () => {
    const result = parseControlCommandMessage({
      id: 9,
      type: 'set-grid-size',
      cols: 'four',
      rows: 3,
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(parseControlCommandMessage('hello').success).toBe(false)
    expect(parseControlCommandMessage(null).success).toBe(false)
  })
})

describe('parseControlUpdateMessage', () => {
  it('accepts a state envelope with an object state', () => {
    const result = parseControlUpdateMessage({
      type: 'state',
      state: { identity: { role: 'local' } },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a wrong envelope type', () => {
    const result = parseControlUpdateMessage({ type: 'nope', state: {} })
    expect(result.success).toBe(false)
  })

  it('rejects a non-object state', () => {
    const result = parseControlUpdateMessage({ type: 'state', state: 42 })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid role in the state identity', () => {
    const result = parseControlUpdateMessage({
      type: 'state',
      state: { identity: { role: 'root' } },
    })
    expect(result.success).toBe(false)
  })
})

describe('byte-size guards', () => {
  it('exposes sane, ordered size limits', () => {
    expect(MAX_WS_TEXT_MESSAGE_BYTES).toBeGreaterThan(0)
    expect(MAX_YJS_UPDATE_BYTES).toBeGreaterThan(0)
    expect(MAX_YJS_DOC_BYTES).toBeGreaterThanOrEqual(MAX_YJS_UPDATE_BYTES)
  })

  it('measures byte length of strings (utf-8) and buffers', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('é')).toBe(2)
    expect(byteLength(new Uint8Array([1, 2, 3, 4]))).toBe(4)
    expect(byteLength(new ArrayBuffer(8))).toBe(8)
  })

  it('accepts data within the limit and rejects oversized data', () => {
    expect(isWithinByteLimit(new Uint8Array(10), 16)).toBe(true)
    expect(isWithinByteLimit(new Uint8Array(20), 16)).toBe(false)
    expect(isWithinByteLimit('abc', 3)).toBe(true)
    expect(isWithinByteLimit('abcd', 3)).toBe(false)
  })
})

describe('parseInviteResponse', () => {
  it('accepts a well-formed invite, ignoring transport fields', () => {
    const result = parseInviteResponse({
      tokenId: 't1',
      name: 'Alice',
      secret: 's3cr3t',
      response: true,
      id: 7,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.invite).toEqual({
      tokenId: 't1',
      name: 'Alice',
      secret: 's3cr3t',
    })
  })

  it('rejects an invite missing its secret', () => {
    const result = parseInviteResponse({ tokenId: 't1', name: 'Alice' })
    expect(result.success).toBe(false)
  })

  it('rejects a non-object / error response', () => {
    expect(parseInviteResponse({ error: 'unauthorized' }).success).toBe(false)
    expect(parseInviteResponse(null).success).toBe(false)
  })
})

describe('parseInvitableRole', () => {
  it('returns the role for admin/operator/monitor', () => {
    expect(parseInvitableRole('admin')).toBe('admin')
    expect(parseInvitableRole('operator')).toBe('operator')
    expect(parseInvitableRole('monitor')).toBe('monitor')
  })

  it('returns null for local and unknown roles', () => {
    expect(parseInvitableRole('local')).toBeNull()
    expect(parseInvitableRole('root')).toBeNull()
    expect(parseInvitableRole(42)).toBeNull()
  })
})

describe('validateStreamwallStateShape', () => {
  it('accepts an object state with a valid identity role', () => {
    expect(
      validateStreamwallStateShape({ identity: { role: 'local' } }).success,
    ).toBe(true)
  })

  it('accepts a state without an identity', () => {
    expect(validateStreamwallStateShape({}).success).toBe(true)
  })

  it('rejects a non-object state', () => {
    expect(validateStreamwallStateShape(42).success).toBe(false)
    expect(validateStreamwallStateShape(null).success).toBe(false)
  })

  it('rejects an invalid identity role', () => {
    expect(
      validateStreamwallStateShape({ identity: { role: 'root' } }).success,
    ).toBe(false)
  })
})

describe('verifyCollabState', () => {
  it('accepts a well-formed views map', () => {
    const result = verifyCollabState({
      '0': { streamId: 'abc' },
      '1': { streamId: undefined },
      '2': {},
    })
    expect(result.valid).toBe(true)
  })

  it('rejects a corrupted views map (non-object value)', () => {
    const result = verifyCollabState({ '0': 'corrupt' })
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.error).toBeTruthy()
  })

  it('rejects a non-string streamId', () => {
    const result = verifyCollabState({ '0': { streamId: 123 } })
    expect(result.valid).toBe(false)
  })

  it('rejects a non-object top level', () => {
    expect(verifyCollabState('nope').valid).toBe(false)
    expect(verifyCollabState(null).valid).toBe(false)
  })
})
