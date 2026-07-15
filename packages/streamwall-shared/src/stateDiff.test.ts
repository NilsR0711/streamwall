import { describe, expect, it } from 'vitest'
import { stateDiff } from './stateDiff.ts'
import type { StreamData, StreamwallState, ViewState } from './types.ts'

function makeStream(
  id: string,
  overrides: Partial<StreamData> = {},
): StreamData {
  return {
    _id: id,
    _dataSource: 'test',
    kind: 'video',
    link: `https://example.com/${id}`,
    label: id,
    ...overrides,
  }
}

function makeView(id: number, overrides: Partial<ViewState> = {}): ViewState {
  return {
    state: 'empty',
    context: {
      id,
      content: null,
      info: null,
      pos: null,
      error: null,
      volume: 1,
    },
    ...overrides,
  }
}

function makeState(overrides: Partial<StreamwallState> = {}): StreamwallState {
  return {
    identity: { role: 'admin' },
    config: {
      cols: 2,
      rows: 2,
      width: 800,
      height: 600,
      frameless: false,
      fullscreen: false,
      activeColor: '#fff',
      backgroundColor: '#000',
    },
    streams: [makeStream('a'), makeStream('b'), makeStream('c')],
    customStreams: [],
    views: [makeView(0), makeView(1)],
    streamdelay: null,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
    ...overrides,
  }
}

// Round-trips a diff through patch and asserts the result matches `next`
// exactly, mirroring how the control server/client actually consume deltas:
// `patch` mutates a clone of `prev` in place using the delta from `diff`.
function expectRoundTrip(prev: unknown, next: unknown) {
  const delta = stateDiff.diff(prev, next)
  const patched = stateDiff.patch(structuredClone(prev), delta)
  expect(patched).toEqual(next)
  return delta
}

describe('stateDiff round-trips', () => {
  it('produces no delta when nothing changed', () => {
    const state = makeState()
    const delta = stateDiff.diff(state, structuredClone(state))
    expect(delta).toBeUndefined()
  })

  it('round-trips a scalar property change', () => {
    const prev = makeState()
    const next = makeState({
      streamdelay: {
        isConnected: true,
        delaySeconds: 30,
        restartSeconds: 0,
        isCensored: false,
        isStreamRunning: true,
        startTime: 0,
        state: 'running',
      },
    })
    expectRoundTrip(prev, next)
  })

  it('round-trips a stream being added', () => {
    const prev = makeState()
    const next = makeState({
      streams: [...prev.streams, makeStream('d')],
    })
    expectRoundTrip(prev, next)
  })

  it('round-trips a stream being removed, honoring omitRemovedValues', () => {
    const prev = makeState()
    const next = makeState({
      streams: prev.streams.filter((s) => s._id !== 'b'),
    })
    const delta = expectRoundTrip(prev, next)
    // omitRemovedValues strips the removed item's value from the delta so
    // it can't be used to reconstruct it (only forward `patch` is supported).
    const streamsDelta = (delta as { streams: Record<string, unknown> }).streams
    const removalEntry = Object.entries(streamsDelta).find(
      ([key, value]) =>
        key !== '_t' && Array.isArray(value) && value.length === 3,
    )
    expect(removalEntry?.[1]).toEqual([0, 0, 0])
  })

  it('round-trips a stream list reorder as moves, not delete+insert', () => {
    const prev = makeState()
    const next = makeState({
      streams: [prev.streams[2], prev.streams[0], prev.streams[1]],
    })
    const delta = expectRoundTrip(prev, next)
    const streamsDelta = (delta as { streams: Record<string, unknown> }).streams
    const entries = Object.entries(streamsDelta).filter(([key]) => key !== '_t')
    // Every entry should be a move op (`['', destIdx, 3]`); none should be a
    // deletion (`[oldValue, 0, 0]`) or a fresh insertion (`[newValue]`).
    expect(entries.length).toBeGreaterThan(0)
    for (const [, value] of entries) {
      expect(Array.isArray(value)).toBe(true)
      const arr = value as unknown[]
      expect(arr).toEqual(['', arr[1], 3])
    }
  })

  it('round-trips a reordered item that also changed', () => {
    const prev = makeState()
    const next = makeState({
      streams: [
        { ...prev.streams[1], label: 'renamed-b' },
        prev.streams[0],
        prev.streams[2],
      ],
    })
    expectRoundTrip(prev, next)
  })

  it('round-trips a nested views state change', () => {
    const prev = makeState()
    const next = makeState({
      views: [makeView(0, { state: { displaying: 'error' } }), prev.views[1]],
    })
    expectRoundTrip(prev, next)
  })

  it('round-trips a nested view context change without touching sibling views', () => {
    const prev = makeState({
      views: [makeView(0), makeView(1), makeView(2)],
    })
    const next = makeState({
      views: [
        prev.views[0],
        makeView(1, {
          context: { ...prev.views[1].context, error: 'boom' },
        }),
        prev.views[2],
      ],
    })
    const delta = expectRoundTrip(prev, next)
    const viewsDelta = (delta as { views: Record<string, unknown> }).views
    expect(Object.keys(viewsDelta).filter((k) => k !== '_t')).toEqual(['1'])
  })

  it('round-trips a whole key being removed, honoring omitRemovedValues', () => {
    const prev = makeState({
      auth: {
        invites: [
          { tokenId: 't1', kind: 'invite', role: 'operator', name: 'x' },
        ],
        sessions: [],
      },
    })
    const next = makeState()
    delete (next as Partial<StreamwallState>).auth
    const delta = expectRoundTrip(prev, next)
    expect((delta as { auth: unknown }).auth).toEqual([0, 0, 0])
  })

  it('round-trips multiple simultaneous changes across the whole state', () => {
    const prev = makeState()
    const next = makeState({
      config: { ...prev.config, cols: 3, rows: 3 },
      streams: [prev.streams[1], makeStream('d'), prev.streams[0]],
      views: [makeView(0, { state: { displaying: 'error' } }), prev.views[1]],
      streamdelay: {
        isConnected: false,
        delaySeconds: 0,
        restartSeconds: 0,
        isCensored: true,
        isStreamRunning: false,
        startTime: 0,
        state: 'idle',
      },
    })
    expectRoundTrip(prev, next)
  })
})
