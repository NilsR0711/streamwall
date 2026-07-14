import { describe, expect, test } from 'vitest'
import {
  controlCommandMessageSchema,
  controlStateMessageSchema,
  localStreamDataSchema,
  parseStreamList,
  streamDataInputSchema,
} from './schemas.ts'
import type { ControlCommand } from './types.ts'

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
        viewIdx: 0,
        blurred: true,
      }).success,
    ).toBe(true)
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
        viewIdx: 0,
      }).success,
    ).toBe(false)
  })

  test('rejects a command with a wrongly-typed field', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-blurred',
        viewIdx: 0,
        blurred: 'yes',
      }).success,
    ).toBe(false)
  })

  test('rejects a message without a numeric id', () => {
    expect(
      controlCommandMessageSchema.safeParse({ type: 'reload-view', viewIdx: 0 })
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

  test('bounds the view index to a non-negative integer', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'reload-view',
        viewIdx: -1,
      }).success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'reload-view',
        viewIdx: 1.5,
      }).success,
    ).toBe(false)
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
        viewIdx: null,
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
        viewIdx: 0,
        volume: 0.5,
      }).success,
    ).toBe(true)
  })

  test('bounds volume to the 0-1 range on set-view-volume', () => {
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-volume',
        viewIdx: 0,
        volume: 1.5,
      }).success,
    ).toBe(false)
    expect(
      controlCommandMessageSchema.safeParse({
        id: 1,
        type: 'set-view-volume',
        viewIdx: 0,
        volume: -0.1,
      }).success,
    ).toBe(false)
  })

  test('parsed commands remain assignable to the ControlCommand type', () => {
    const result = controlCommandMessageSchema.safeParse({
      id: 7,
      type: 'reload-view',
      viewIdx: 2,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // Compile-time guard against schema/type drift.
      const command: ControlCommand = result.data
      expect(command.type).toBe('reload-view')
    }
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
