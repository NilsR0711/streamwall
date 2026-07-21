import { describe, expect, test } from 'vitest'
import {
  type ControlCommand,
  MAX_VIEW_IDX,
  controlCommandMessageSchema,
  controlStateMessageSchema,
  localStreamDataSchema,
  parseStreamList,
  streamDataInputSchema,
  streamwallStateSchema,
} from './schemas.ts'
import type { StreamwallState } from './types.ts'

/** A minimal, fully-populated valid state, mirroring what the desktop uplink sends. */
const VALID_STATE = {
  identity: { role: 'admin' },
  config: {
    cols: 3,
    rows: 3,
    width: 1920,
    height: 1080,
    frameless: false,
    fullscreen: false,
    activeColor: '#fff',
    backgroundColor: '#000',
  },
  streams: [],
  customStreams: [],
  views: [],
  fullscreenViewIdx: null,
  streamdelay: null,
  layoutPresets: [],
  favorites: [],
  dataSourceHealth: [],
}

describe('streamDataInputSchema', () => {
  test('accepts a minimal entry with just a link', () => {
    expect(
      streamDataInputSchema.safeParse({ link: 'https://example.com/s' })
        .success,
    ).toBe(true)
  })

  test('rejects an entry without a link', () => {
    expect(streamDataInputSchema.safeParse({ label: 'no link' }).success).toBe(
      false,
    )
  })

  test('rejects an empty link', () => {
    expect(streamDataInputSchema.safeParse({ link: '' }).success).toBe(false)
  })

  test('rejects a non-string link', () => {
    expect(streamDataInputSchema.safeParse({ link: 42 }).success).toBe(false)
  })

  test('strips internal identity fields from untrusted input', () => {
    const result = streamDataInputSchema.safeParse({
      link: 'https://example.com/s',
      _id: 'injected',
      _dataSource: 'attacker',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('_id')
      expect(result.data).not.toHaveProperty('_dataSource')
    }
  })

  test('accepts all known content kinds', () => {
    for (const kind of ['video', 'audio', 'web', 'background', 'overlay']) {
      expect(streamDataInputSchema.safeParse({ link: 'x', kind }).success).toBe(
        true,
      )
    }
  })

  test('rejects an unknown content kind', () => {
    expect(
      streamDataInputSchema.safeParse({ link: 'x', kind: 'malware' }).success,
    ).toBe(false)
  })

  test('bounds rotation to a sane range', () => {
    expect(
      streamDataInputSchema.safeParse({ link: 'x', rotation: 90 }).success,
    ).toBe(true)
    expect(
      streamDataInputSchema.safeParse({ link: 'x', rotation: 720 }).success,
    ).toBe(false)
    expect(
      streamDataInputSchema.safeParse({ link: 'x', rotation: -1 }).success,
    ).toBe(false)
  })

  test('rejects an unknown label position', () => {
    expect(
      streamDataInputSchema.safeParse({ link: 'x', labelPosition: 'middle' })
        .success,
    ).toBe(false)
  })
})

describe('parseStreamList', () => {
  test('returns all valid entries with no errors', () => {
    const { streams, errors } = parseStreamList([
      { link: 'a' },
      { link: 'b', kind: 'audio' },
    ])
    expect(streams.map((s) => s.link)).toEqual(['a', 'b'])
    expect(errors).toHaveLength(0)
  })

  test('skips invalid entries but keeps valid ones', () => {
    const { streams, errors } = parseStreamList([
      { link: 'a' },
      { kind: 'video' }, // missing link
      { link: 'c', rotation: 999 }, // bad rotation
      { link: 'd' },
    ])
    expect(streams.map((s) => s.link)).toEqual(['a', 'd'])
    expect(errors.map((e) => e.index)).toEqual([1, 2])
  })

  test('returns an empty list for non-array input', () => {
    expect(parseStreamList('nope').streams).toEqual([])
    expect(parseStreamList(null).streams).toEqual([])
    expect(parseStreamList(undefined).streams).toEqual([])
    expect(parseStreamList({ streams: [] }).streams).toEqual([])
  })
})

describe('localStreamDataSchema', () => {
  test('requires a content kind', () => {
    expect(localStreamDataSchema.safeParse({ link: 'x' }).success).toBe(false)
    expect(
      localStreamDataSchema.safeParse({ link: 'x', kind: 'video' }).success,
    ).toBe(true)
  })

  test('rejects an empty link', () => {
    expect(
      localStreamDataSchema.safeParse({ link: '', kind: 'video' }).success,
    ).toBe(false)
  })
})

describe('controlCommandMessageSchema', () => {
  test('accepts a valid set-view-blurred command', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-blurred',
        viewId: 0,
        blurred: true,
      }).success,
    ).toBe(true)
  })

  test('accepts a valid set-view-fullscreen command', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-fullscreen',
        viewId: 3,
        fullscreen: true,
      }).success,
    ).toBe(true)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-fullscreen',
        viewId: 0,
        fullscreen: false,
      }).success,
    ).toBe(true)
  })

  test('rejects a set-view-fullscreen command with a non-boolean flag', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-fullscreen',
        viewId: 0,
        fullscreen: 'yes',
      }).success,
    ).toBe(false)
  })

  test('rejects a set-view-fullscreen command missing the fullscreen flag', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-fullscreen',
        viewId: 0,
      }).success,
    ).toBe(false)
  })

  test('rejects an unknown command type', () => {
    expect(
      controlCommandMessageSchema.safeParse({ id: 1, type: 'rm -rf /' })
        .success,
    ).toBe(false)
  })

  test('rejects prototype-pollution command types', () => {
    expect(
      controlCommandMessageSchema.safeParse({ id: 1, type: '__proto__' })
        .success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({ id: 1, type: 'constructor' })
        .success,
    ).toBe(false)
  })

  test('rejects a command missing a required field', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-blurred',
        viewId: 0,
      }).success,
    ).toBe(false)
  })

  test('rejects a command with a wrongly-typed field', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-blurred',
        viewId: 0,
        blurred: 'yes',
      }).success,
    ).toBe(false)
  })

  test('rejects a message without a numeric id', () => {
    expect(
      controlCommandMessageSchema.safeParse({ type: 'reload-view', viewId: 0 })
        .success,
    ).toBe(false)
  })

  test('bounds the grid size to the allowed range', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-grid-size',
        cols: 3,
        rows: 3,
      }).success,
    ).toBe(true)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-grid-size',
        cols: 0,
        rows: 3,
      }).success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-grid-size',
        cols: 99,
        rows: 3,
      }).success,
    ).toBe(false)
  })

  test('bounds the view id to a non-negative integer', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'reload-view',
        viewId: -1,
      }).success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'reload-view',
        viewId: 1.5,
      }).success,
    ).toBe(false)
  })

  test('accepts a view id above the max grid cell index (issue #397)', () => {
    // A view id is the actor's stable identity, not a grid cell, so unlike a
    // grid index it must not be capped at MAX_VIEW_IDX.
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'reload-view',
        viewId: MAX_VIEW_IDX + 100,
      }).success,
    ).toBe(true)
  })

  test('rejects an out-of-range rotation on rotate-stream', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'rotate-stream',
        url: 'x',
        rotation: 999,
      }).success,
    ).toBe(false)
  })

  test('allows a null listening view', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-listening-view',
        viewId: null,
      }).success,
    ).toBe(true)
  })

  test('validates the nested data of update-custom-stream', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'update-custom-stream',
        url: 'x',
        data: { link: 'x', kind: 'video' },
      }).success,
    ).toBe(true)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'update-custom-stream',
        url: 'x',
        data: { link: 'x', kind: 'not-a-kind' },
      }).success,
    ).toBe(false)
  })

  test('rejects an update-custom-stream with an empty data link', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'update-custom-stream',
        url: 'x',
        data: { link: '', kind: 'video' },
      }).success,
    ).toBe(false)
  })

  test('accepts create-invite with a known role', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'create-invite',
        role: 'operator',
        name: 'x',
      }).success,
    ).toBe(true)
  })

  test('rejects create-invite with an unknown role', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'create-invite',
        role: 'superuser',
        name: 'x',
      }).success,
    ).toBe(false)
  })

  test('rejects create-invite with the local role', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'create-invite',
        role: 'local',
        name: 'x',
      }).success,
    ).toBe(false)
  })

  test('accepts a save-layout-preset command with a non-empty name', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'save-layout-preset',
        name: 'My Layout',
      }).success,
    ).toBe(true)
  })

  test('rejects save-layout-preset with an empty or overlong name', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'save-layout-preset',
        name: '',
      }).success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'save-layout-preset',
        name: 'x'.repeat(101),
      }).success,
    ).toBe(false)
  })

  test('accepts load-layout-preset and delete-layout-preset with a non-empty presetId', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'load-layout-preset',
        presetId: 'preset-1',
      }).success,
    ).toBe(true)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'delete-layout-preset',
        presetId: 'preset-1',
      }).success,
    ).toBe(true)
  })

  test('rejects load-layout-preset and delete-layout-preset with an empty presetId', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'load-layout-preset',
        presetId: '',
      }).success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'delete-layout-preset',
        presetId: '',
      }).success,
    ).toBe(false)
  })

  test('accepts a valid set-view-volume command', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-volume',
        viewId: 0,
        volume: 0.5,
      }).success,
    ).toBe(true)
  })

  test('bounds volume to the 0-1 range on set-view-volume', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-volume',
        viewId: 0,
        volume: 1.5,
      }).success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-volume',
        viewId: 0,
        volume: -0.1,
      }).success,
    ).toBe(false)
  })

  test('accepts a valid add-favorite command', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'add-favorite',
        url: 'https://example.com/stream',
      }).success,
    ).toBe(true)
  })

  test('rejects add-favorite with an empty url', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'add-favorite',
        url: '',
      }).success,
    ).toBe(false)
  })

  test('accepts a valid remove-favorite command', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'remove-favorite',
        url: 'https://example.com/stream',
      }).success,
    ).toBe(true)
  })

  test('rejects remove-favorite with an empty url', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'remove-favorite',
        url: '',
      }).success,
    ).toBe(false)
  })

  test('parsed commands remain assignable to the ControlCommand type', () => {
    const result = controlCommandMessageSchema.safeParse({
      id: 7,
      type: 'reload-view',
      viewId: 2,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // Compile-time guard against schema/type drift.
      const command: ControlCommand = result.data
      expect(command.type).toBe('reload-view')
    }
  })

  test('ControlCommand rejects a create-invite role outside InvitableRole at compile time', () => {
    const command: ControlCommand = {
      type: 'create-invite',
      // @ts-expect-error - ControlCommand must derive `role` from the schema's
      // InvitableRole enum, not accept an arbitrary string (regression for #354).
      role: 'not-a-real-role',
      name: 'x',
    }
    expect(command.type).toBe('create-invite')
  })
})

describe('controlStateMessageSchema', () => {
  test('accepts a state message with an object payload', () => {
    expect(
      controlStateMessageSchema.safeParse({
        type: 'state',
        state: { streams: [] },
      }).success,
    ).toBe(true)
  })

  test('rejects a state message without a payload', () => {
    expect(controlStateMessageSchema.safeParse({ type: 'state' }).success).toBe(
      false,
    )
  })

  test('rejects a state message with a non-object payload', () => {
    expect(
      controlStateMessageSchema.safeParse({ type: 'state', state: 'nope' })
        .success,
    ).toBe(false)
  })
})

describe('streamwallStateSchema', () => {
  test('accepts a fully-populated valid state with empty views', () => {
    const result = streamwallStateSchema.safeParse(VALID_STATE)
    expect(result.success).toBe(true)
  })

  test('accepts a state with populated streams, views and layout presets', () => {
    const full = {
      ...VALID_STATE,
      identity: { role: 'operator' },
      auth: { invites: [], sessions: [] },
      streams: [
        {
          link: 'https://example.com/s',
          kind: 'video',
          _id: 'id-1',
          _dataSource: 'source-1',
        },
      ],
      customStreams: [],
      views: [
        {
          state: 'empty',
          context: {
            id: 0,
            content: null,
            info: null,
            pos: null,
            error: null,
            volume: 1,
          },
        },
        {
          state: {
            displaying: {
              running: {
                playback: 'playing',
                video: 'normal',
                audio: 'listening',
              },
            },
          },
          context: {
            id: 1,
            content: { url: 'https://example.com/s', kind: 'video' },
            info: { title: 'A stream' },
            pos: { x: 0, y: 0, width: 100, height: 100, spaces: [1] },
            error: null,
            volume: 0.5,
          },
        },
      ],
      layoutPresets: [
        {
          id: 'preset-1',
          name: 'My Layout',
          cols: 3,
          rows: 3,
          views: { '0': { streamId: 'id-1' } },
        },
      ],
      favorites: ['https://example.com/s'],
      dataSourceHealth: [
        {
          id: 'https://source.example/data.json',
          type: 'json-url',
          status: 'ok',
          message: null,
          updatedAt: 1700000000000,
        },
      ],
    }
    const result = streamwallStateSchema.safeParse(full)
    expect(result.success).toBe(true)
  })

  test('rejects a state missing the required streams field', () => {
    const { streams: _streams, ...withoutStreams } = VALID_STATE
    expect(streamwallStateSchema.safeParse(withoutStreams).success).toBe(false)
  })

  test('rejects a state with a malformed view state machine snapshot', () => {
    const malformed = {
      ...VALID_STATE,
      views: [
        {
          state: { displaying: { running: { playback: 'exploded' } } },
          context: {
            id: 0,
            content: null,
            info: null,
            pos: null,
            error: null,
            volume: 1,
          },
        },
      ],
    }
    expect(streamwallStateSchema.safeParse(malformed).success).toBe(false)
  })

  test('rejects a state with an unrecognized top-level view state string', () => {
    const malformed = {
      ...VALID_STATE,
      views: [
        {
          state: 'not-a-real-state',
          context: {
            id: 0,
            content: null,
            info: null,
            pos: null,
            error: null,
            volume: 1,
          },
        },
      ],
    }
    expect(streamwallStateSchema.safeParse(malformed).success).toBe(false)
  })

  test('rejects a non-object payload', () => {
    expect(streamwallStateSchema.safeParse('nope').success).toBe(false)
    expect(streamwallStateSchema.safeParse(null).success).toBe(false)
    expect(streamwallStateSchema.safeParse(undefined).success).toBe(false)
  })

  test('rejects an unknown identity role', () => {
    const malformed = { ...VALID_STATE, identity: { role: 'superuser' } }
    expect(streamwallStateSchema.safeParse(malformed).success).toBe(false)
  })

  test('rejects an out-of-bounds fullscreenViewIdx', () => {
    const malformed = { ...VALID_STATE, fullscreenViewIdx: -1 }
    expect(streamwallStateSchema.safeParse(malformed).success).toBe(false)
  })

  test('accepts a view whose stable id exceeds MAX_VIEW_IDX (issue #397)', () => {
    // A view's `context.id` is its stable actor identity (a webContents id),
    // which grows unbounded over a session and is not a grid cell — so it must
    // not be rejected for exceeding MAX_VIEW_IDX.
    const state = {
      ...VALID_STATE,
      views: [
        {
          state: 'empty',
          context: {
            id: MAX_VIEW_IDX + 500,
            content: null,
            info: null,
            pos: null,
            error: null,
            volume: 0,
          },
        },
      ],
    }
    expect(streamwallStateSchema.safeParse(state).success).toBe(true)
  })

  test('accepts a null fullscreenViewIdx and a populated streamdelay', () => {
    const state = {
      ...VALID_STATE,
      fullscreenViewIdx: null,
      streamdelay: {
        isConnected: true,
        delaySeconds: 30,
        restartSeconds: 0,
        isCensored: false,
        isStreamRunning: true,
        startTime: 1700000000000,
        state: 'running',
      },
    }
    expect(streamwallStateSchema.safeParse(state).success).toBe(true)
  })

  test('parsed state is assignable to StreamwallState at compile time', () => {
    const result = streamwallStateSchema.safeParse(VALID_STATE)
    expect(result.success).toBe(true)
    if (result.success) {
      // Compile-time guard against schema/type drift.
      const state: StreamwallState = result.data
      expect(state.identity.role).toBe('admin')
    }
  })
})
