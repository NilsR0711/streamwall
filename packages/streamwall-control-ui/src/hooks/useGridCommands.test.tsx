import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { ControlCommand, StreamData } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { type CollabData } from '../collabData.ts'
import { type Invite } from '../invite.ts'
import { useGridCommands } from './useGridCommands.ts'

type Commands = ReturnType<typeof useGridCommands>

function makeStream(
  id: string,
  overrides: Partial<StreamData> = {},
): StreamData {
  return {
    _id: id,
    _dataSource: 'test',
    kind: 'video',
    link: `https://example.com/${id}`,
    ...overrides,
  }
}

interface Overrides {
  streams?: StreamData[]
  sharedState?: CollabData | undefined
  stateDoc?: Y.Doc
  cols?: number | null
  rows?: number | null
  fullscreenViewIdx?: number | null
  focusedInputIdx?: number | undefined
  favoritesSet?: ReadonlySet<string>
  onInvite?: (invite: Invite) => void
  onError?: (message: string) => void
}

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** happy-dom does not implement window.confirm, so install a mock for it. */
function stubConfirm(returnValue: boolean) {
  const mock = vi.fn().mockReturnValue(returnValue)
  vi.stubGlobal('confirm', mock)
  return mock
}

/**
 * Render the hook and return its command bag plus the mock `send`. `send`
 * records the last response callback so invite-flow tests can drive the
 * server reply.
 */
function renderCommands(overrides: Overrides = {}) {
  const send =
    vi.fn<(msg: ControlCommand, cb?: (msg: unknown) => void) => void>()
  let commands: Commands | undefined
  function Probe() {
    commands = useGridCommands({
      send,
      streams: overrides.streams ?? [],
      sharedState: overrides.sharedState,
      stateDoc: overrides.stateDoc ?? new Y.Doc(),
      cols: overrides.cols ?? 2,
      rows: overrides.rows ?? 2,
      fullscreenViewIdx: overrides.fullscreenViewIdx ?? null,
      focusedInputIdx: overrides.focusedInputIdx,
      favoritesSet: overrides.favoritesSet ?? new Set(),
      onInvite: overrides.onInvite ?? (() => {}),
      onError: overrides.onError ?? (() => {}),
    })
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Probe />, container!)
  })
  return { commands: commands!, send }
}

describe('useGridCommands', () => {
  test('dispatches view commands through send', () => {
    const { commands, send } = renderCommands()
    act(() => commands.handleSetListening(3, true))
    expect(send).toHaveBeenLastCalledWith({
      type: 'set-listening-view',
      viewId: 3,
    })
    act(() => commands.handleSetListening(3, false))
    expect(send).toHaveBeenLastCalledWith({
      type: 'set-listening-view',
      viewId: null,
    })
    act(() => commands.handleSetVolume(1, 0.5))
    expect(send).toHaveBeenLastCalledWith({
      type: 'set-view-volume',
      viewId: 1,
      volume: 0.5,
    })
    act(() => commands.handleReloadView(2))
    expect(send).toHaveBeenLastCalledWith({ type: 'reload-view', viewId: 2 })
  })

  test('derives the fullscreen flag from the current fullscreen index', () => {
    const notFull = renderCommands({ fullscreenViewIdx: null })
    act(() => notFull.commands.handleToggleFullscreen(0))
    expect(notFull.send).toHaveBeenLastCalledWith({
      type: 'set-view-fullscreen',
      viewId: 0,
      fullscreen: true,
    })

    const full = renderCommands({ fullscreenViewIdx: 0 })
    act(() => full.commands.handleToggleFullscreen(0))
    expect(full.send).toHaveBeenLastCalledWith({
      type: 'set-view-fullscreen',
      viewId: 0,
      fullscreen: false,
    })
  })

  test('resolves browse/rotate by stream id and no-ops for unknown ids', () => {
    const stream = makeStream('a', { link: 'https://x/a', rotation: 90 })
    const { commands, send } = renderCommands({ streams: [stream] })
    act(() => commands.handleBrowse('a'))
    expect(send).toHaveBeenLastCalledWith({
      type: 'browse',
      url: 'https://x/a',
    })
    act(() => commands.handleRotateStream('a'))
    expect(send).toHaveBeenLastCalledWith({
      type: 'rotate-stream',
      url: 'https://x/a',
      rotation: 180,
    })
    send.mockClear()
    act(() => commands.handleBrowse('missing'))
    act(() => commands.handleRotateStream('missing'))
    expect(send).not.toHaveBeenCalled()
  })

  test('clamps grid size and confirms before a destructive shrink', () => {
    const sharedState = {
      views: { 0: { streamId: 'a' }, 3: { streamId: 'b' } },
    } as unknown as CollabData
    const confirmMock = stubConfirm(false)
    const { commands, send } = renderCommands({ cols: 2, sharedState })

    // Shrinking 2x2 -> 1x1 would drop the occupied cell at index 3; a declined
    // confirm cancels the command.
    act(() => commands.handleSetGridSize(1, 1))
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    // Accepting the confirm lets it through.
    confirmMock.mockReturnValue(true)
    act(() => commands.handleSetGridSize(1, 1))
    expect(send).toHaveBeenLastCalledWith({
      type: 'set-grid-size',
      cols: 1,
      rows: 1,
    })
  })

  test('confirms before loading a preset over a populated layout', () => {
    const sharedState = {
      views: { 0: { streamId: 'a' } },
    } as unknown as CollabData
    const confirmMock = stubConfirm(false)
    const { commands, send } = renderCommands({ sharedState })
    act(() => commands.handleLoadLayoutPreset('p1'))
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    confirmMock.mockReturnValue(true)
    act(() => commands.handleLoadLayoutPreset('p1'))
    expect(send).toHaveBeenLastCalledWith({
      type: 'load-layout-preset',
      presetId: 'p1',
    })
  })

  test('toggles favorites based on the current favorites set', () => {
    const { commands, send } = renderCommands({
      favoritesSet: new Set(['https://fav/x']),
    })
    act(() => commands.handleToggleFavorite('https://fav/x'))
    expect(send).toHaveBeenLastCalledWith({
      type: 'remove-favorite',
      url: 'https://fav/x',
    })
    act(() => commands.handleToggleFavorite('https://new/y'))
    expect(send).toHaveBeenLastCalledWith({
      type: 'add-favorite',
      url: 'https://new/y',
    })
  })

  test('surfaces a valid invite response and reports a malformed one', () => {
    const onInvite = vi.fn()
    const onError = vi.fn()
    const { commands, send } = renderCommands({ onInvite, onError })

    act(() => commands.handleCreateInvite({ name: 'Guest', role: 'operator' }))
    const cb = send.mock.calls.at(-1)?.[1]
    expect(cb).toBeTypeOf('function')

    act(() => cb!({ tokenId: 't1', name: 'Guest', secret: 's1' }))
    expect(onInvite).toHaveBeenCalledWith({
      tokenId: 't1',
      name: 'Guest',
      secret: 's1',
    })
    expect(onError).not.toHaveBeenCalled()

    act(() => cb!({ bogus: true }))
    expect(onError).toHaveBeenCalledWith(
      'Received a malformed invite response from the server',
    )
  })

  test('writes the resolved stream id into the shared views doc', () => {
    const stateDoc = new Y.Doc()
    const views = stateDoc.getMap<Y.Map<string | undefined>>('views')
    const cell = new Y.Map<string | undefined>()
    views.set('0', cell)
    const { commands } = renderCommands({
      stateDoc,
      streams: [makeStream('a')],
    })
    act(() => commands.handleSetView(0, 'a'))
    expect(cell.get('streamId')).toBe('a')
  })
})
