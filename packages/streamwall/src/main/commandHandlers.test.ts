import { type ControlCommand, type StreamwallState } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  type BrowseWindow,
  type CommandHandlerDeps,
  createOnCommand,
} from './commandHandlers'
import { buildLayoutPreset } from './layoutPresets'

/** Casts a plain literal to a ControlCommand for routing tests. */
function cmd(msg: Record<string, unknown>): ControlCommand {
  return msg as unknown as ControlCommand
}

function fakeBrowseWindow(): BrowseWindow & {
  destroy: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
} {
  return {
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
    loadURL: vi.fn(),
    webContents: {} as BrowseWindow['webContents'],
  }
}

function makeDeps(overrides: Partial<CommandHandlerDeps> = {}) {
  const doc = new Y.Doc()
  const viewsState = doc.getMap<Y.Map<string | undefined>>('views')

  let clientState = {
    layoutPresets: [],
    favorites: [],
  } as unknown as StreamwallState

  const streamWindow = {
    setListeningView: vi.fn(),
    setViewBackgroundListening: vi.fn(),
    setViewBlurred: vi.fn(),
    setViewVolume: vi.fn(),
    reloadView: vi.fn(),
    setGridSize: vi.fn(),
    openDevTools: vi.fn(),
    // Resolves a stable view id to the grid cell it currently occupies.
    getViewAnchorIdx: vi.fn((viewId: number) => viewId + 3),
  }

  const deps: CommandHandlerDeps = {
    streamWindow,
    overlayStreamData: { update: vi.fn() },
    localStreamData: { update: vi.fn(), delete: vi.fn() },
    viewsState,
    transact: (fn) => doc.transact(fn),
    streamWindowConfig: { cols: 3, rows: 3 },
    getClientState: () => clientState,
    getStreamdelayClient: () => null,
    updateState: vi.fn((partial: Partial<StreamwallState>) => {
      clientState = { ...clientState, ...partial }
    }),
    updateViewsFromStateDoc: vi.fn(),
    persistLayoutPresets: vi.fn(),
    persistFavorites: vi.fn(),
    createBrowseWindow: vi.fn(() => fakeBrowseWindow()),
    validateBrowseURL: vi.fn(async () => {}),
    generateId: () => 'preset-id',
    ...overrides,
  }

  return {
    deps,
    streamWindow,
    viewsState,
    setClientState: (next: Partial<StreamwallState>) => {
      clientState = { ...clientState, ...next }
    },
    getClientState: () => clientState,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createOnCommand — uplink gate', () => {
  it('rejects a browse command arriving from the uplink', async () => {
    const { deps } = makeDeps()
    const onCommand = createOnCommand(deps)

    await onCommand(
      cmd({ type: 'browse', url: 'https://example.com' }),
      'uplink',
    )

    expect(deps.createBrowseWindow).not.toHaveBeenCalled()
  })

  it('allows an allowlisted command from the uplink', async () => {
    const { deps, streamWindow } = makeDeps()
    const onCommand = createOnCommand(deps)

    await onCommand(cmd({ type: 'set-listening-view', viewId: 1 }), 'uplink')

    expect(streamWindow.setListeningView).toHaveBeenCalledWith(1)
  })
})

describe('createOnCommand — view controls', () => {
  let ctx: ReturnType<typeof makeDeps>
  let onCommand: ReturnType<typeof createOnCommand>

  beforeEach(() => {
    ctx = makeDeps()
    onCommand = createOnCommand(ctx.deps)
  })

  it('routes set-listening-view', async () => {
    await onCommand(cmd({ type: 'set-listening-view', viewId: 2 }))
    expect(ctx.streamWindow.setListeningView).toHaveBeenCalledWith(2)
  })

  it('routes set-view-background-listening', async () => {
    await onCommand(
      cmd({
        type: 'set-view-background-listening',
        viewId: 1,
        listening: true,
      }),
    )
    expect(ctx.streamWindow.setViewBackgroundListening).toHaveBeenCalledWith(
      1,
      true,
    )
  })

  it('routes set-view-blurred', async () => {
    await onCommand(cmd({ type: 'set-view-blurred', viewId: 0, blurred: true }))
    expect(ctx.streamWindow.setViewBlurred).toHaveBeenCalledWith(0, true)
  })

  it('routes set-view-volume', async () => {
    await onCommand(cmd({ type: 'set-view-volume', viewId: 0, volume: 0.5 }))
    expect(ctx.streamWindow.setViewVolume).toHaveBeenCalledWith(0, 0.5)
  })

  it('routes reload-view', async () => {
    await onCommand(cmd({ type: 'reload-view', viewId: 3 }))
    expect(ctx.streamWindow.reloadView).toHaveBeenCalledWith(3)
  })

  it('routes rotate-stream to the overlay data source', async () => {
    await onCommand(cmd({ type: 'rotate-stream', url: 'u', rotation: 90 }))
    expect(ctx.deps.overlayStreamData.update).toHaveBeenCalledWith('u', {
      rotation: 90,
    })
  })

  it('routes update-custom-stream and delete-custom-stream', async () => {
    await onCommand(cmd({ type: 'update-custom-stream', url: 'u', data: {} }))
    expect(ctx.deps.localStreamData.update).toHaveBeenCalledWith('u', {})

    await onCommand(cmd({ type: 'delete-custom-stream', url: 'u' }))
    expect(ctx.deps.localStreamData.delete).toHaveBeenCalledWith('u')
  })

  it('resolves the view id to its anchor cell when expanding, and clears it', async () => {
    await onCommand(
      cmd({ type: 'set-view-fullscreen', viewId: 2, fullscreen: true }),
    )
    // The command carries a stable view id (#397); the broadcast state keys on
    // the cell that view currently occupies.
    expect(ctx.streamWindow.getViewAnchorIdx).toHaveBeenCalledWith(2)
    expect(ctx.deps.updateState).toHaveBeenCalledWith({ fullscreenViewIdx: 5 })
    expect(ctx.deps.updateViewsFromStateDoc).toHaveBeenCalled()

    await onCommand(
      cmd({ type: 'set-view-fullscreen', viewId: 2, fullscreen: false }),
    )
    expect(ctx.deps.updateState).toHaveBeenCalledWith({
      fullscreenViewIdx: null,
    })
  })

  it('does not expand a view that has no placement', async () => {
    const ctx = makeDeps()
    ctx.streamWindow.getViewAnchorIdx.mockReturnValue(null as unknown as number)
    const onCommand = createOnCommand(ctx.deps)

    await onCommand(
      cmd({ type: 'set-view-fullscreen', viewId: 9, fullscreen: true }),
    )

    expect(ctx.deps.updateState).toHaveBeenCalledWith({
      fullscreenViewIdx: null,
    })
  })
})

describe('createOnCommand — browse / dev-tools', () => {
  it('opens a validated URL in a fresh browse window', async () => {
    const win = fakeBrowseWindow()
    const { deps } = makeDeps({ createBrowseWindow: vi.fn(() => win) })
    const onCommand = createOnCommand(deps)

    await onCommand(cmd({ type: 'browse', url: 'https://example.com' }))

    expect(deps.validateBrowseURL).toHaveBeenCalledWith(
      'https://example.com',
      win,
    )
    expect(win.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('returns an error and does not load when the URL is rejected', async () => {
    const win = fakeBrowseWindow()
    const { deps } = makeDeps({
      createBrowseWindow: vi.fn(() => win),
      validateBrowseURL: vi.fn(async () => {
        throw new Error('blocked')
      }),
    })
    const onCommand = createOnCommand(deps)

    const result = await onCommand(
      cmd({ type: 'browse', url: 'http://169.254.169.254' }),
    )

    expect(result).toEqual({ error: 'invalid url' })
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('recreates the browse window for dev-tools and opens the tools', async () => {
    const createBrowseWindow = vi.fn(() => fakeBrowseWindow())
    const { deps, streamWindow } = makeDeps({ createBrowseWindow })
    const onCommand = createOnCommand(deps)

    await onCommand(cmd({ type: 'browse', url: 'https://example.com' }))
    await onCommand(cmd({ type: 'dev-tools', viewId: 1 }))

    // A fresh window is created for dev-tools (the first is destroyed).
    expect(createBrowseWindow).toHaveBeenCalledTimes(2)
    expect(streamWindow.openDevTools).toHaveBeenCalledWith(1, expect.anything())
  })
})

describe('createOnCommand — streamdelay', () => {
  it('forwards censor/running to the stream-delay client when present', async () => {
    const streamdelayClient = {
      setCensored: vi.fn(),
      setStreamRunning: vi.fn(),
    }
    const { deps } = makeDeps({
      getStreamdelayClient: () => streamdelayClient,
    })
    const onCommand = createOnCommand(deps)

    await onCommand(cmd({ type: 'set-stream-censored', isCensored: true }))
    await onCommand(cmd({ type: 'set-stream-running', isStreamRunning: false }))

    expect(streamdelayClient.setCensored).toHaveBeenCalledWith(true)
    expect(streamdelayClient.setStreamRunning).toHaveBeenCalledWith(false)
  })

  it('does nothing when no stream-delay client is configured', async () => {
    const { deps } = makeDeps({ getStreamdelayClient: () => null })
    const onCommand = createOnCommand(deps)

    // Should not throw despite no client.
    await expect(
      onCommand(cmd({ type: 'set-stream-censored', isCensored: true })),
    ).resolves.toBeUndefined()
  })
})

describe('createOnCommand — grid and layout presets', () => {
  it('applies a grid resize and rebroadcasts state', async () => {
    const { deps, streamWindow } = makeDeps()
    const onCommand = createOnCommand(deps)

    await onCommand(cmd({ type: 'set-grid-size', cols: 4, rows: 2 }))

    expect(streamWindow.setGridSize).toHaveBeenCalledWith(4, 2)
    expect(deps.updateState).toHaveBeenCalledWith({})
  })

  it('saves a layout preset and persists it', async () => {
    const { deps } = makeDeps()
    const onCommand = createOnCommand(deps)

    await onCommand(cmd({ type: 'save-layout-preset', name: 'My Preset' }))

    expect(deps.persistLayoutPresets).toHaveBeenCalledTimes(1)
    const persisted = (deps.persistLayoutPresets as ReturnType<typeof vi.fn>)
      .mock.calls[0][0]
    expect(persisted).toEqual([
      expect.objectContaining({ id: 'preset-id', name: 'My Preset' }),
    ])
    expect(deps.updateState).toHaveBeenCalledWith({ layoutPresets: persisted })
  })

  it('loads an existing layout preset', async () => {
    const ctx = makeDeps()
    const preset = buildLayoutPreset(
      { viewsState: ctx.viewsState, cols: 3, rows: 3 },
      'preset-id',
      'Saved',
    )
    ctx.setClientState({ layoutPresets: [preset] })
    const onCommand = createOnCommand(ctx.deps)

    await onCommand(cmd({ type: 'load-layout-preset', presetId: 'preset-id' }))

    expect(ctx.deps.updateState).toHaveBeenCalledWith({})
  })

  it('ignores loading a non-existent layout preset', async () => {
    const { deps } = makeDeps()
    const onCommand = createOnCommand(deps)

    await onCommand(cmd({ type: 'load-layout-preset', presetId: 'missing' }))

    expect(deps.updateState).not.toHaveBeenCalled()
  })

  it('deletes a layout preset by id', async () => {
    const ctx = makeDeps()
    const preset = buildLayoutPreset(
      { viewsState: ctx.viewsState, cols: 3, rows: 3 },
      'preset-id',
      'Saved',
    )
    ctx.setClientState({ layoutPresets: [preset] })
    const onCommand = createOnCommand(ctx.deps)

    await onCommand(
      cmd({ type: 'delete-layout-preset', presetId: 'preset-id' }),
    )

    expect(ctx.deps.persistLayoutPresets).toHaveBeenCalledWith([])
    expect(ctx.deps.updateState).toHaveBeenCalledWith({ layoutPresets: [] })
  })
})

describe('createOnCommand — favorites', () => {
  it('adds a new favorite and persists it', async () => {
    const ctx = makeDeps()
    ctx.setClientState({
      favorites: [] as unknown as StreamwallState['favorites'],
    })
    const onCommand = createOnCommand(ctx.deps)

    await onCommand(cmd({ type: 'add-favorite', url: 'https://a' }))

    expect(ctx.deps.persistFavorites).toHaveBeenCalledTimes(1)
    expect(ctx.deps.updateState).toHaveBeenCalledTimes(1)
  })

  it('does nothing when adding a duplicate favorite', async () => {
    const ctx = makeDeps()
    ctx.setClientState({
      favorites: ['https://a'] as unknown as StreamwallState['favorites'],
    })
    const onCommand = createOnCommand(ctx.deps)

    await onCommand(cmd({ type: 'add-favorite', url: 'https://a' }))

    expect(ctx.deps.persistFavorites).not.toHaveBeenCalled()
    expect(ctx.deps.updateState).not.toHaveBeenCalled()
  })

  it('removes an existing favorite and persists it', async () => {
    const ctx = makeDeps()
    ctx.setClientState({
      favorites: ['https://a'] as unknown as StreamwallState['favorites'],
    })
    const onCommand = createOnCommand(ctx.deps)

    await onCommand(cmd({ type: 'remove-favorite', url: 'https://a' }))

    expect(ctx.deps.persistFavorites).toHaveBeenCalledTimes(1)
    expect(ctx.deps.updateState).toHaveBeenCalledTimes(1)
  })

  it('does nothing when removing a favorite that is not present', async () => {
    const ctx = makeDeps()
    ctx.setClientState({
      favorites: [] as unknown as StreamwallState['favorites'],
    })
    const onCommand = createOnCommand(ctx.deps)

    await onCommand(cmd({ type: 'remove-favorite', url: 'https://missing' }))

    expect(ctx.deps.persistFavorites).not.toHaveBeenCalled()
    expect(ctx.deps.updateState).not.toHaveBeenCalled()
  })
})
