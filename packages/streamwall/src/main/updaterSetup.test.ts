import { afterEach, describe, expect, it, vi } from 'vitest'
import { type UpdateStatus } from '../updateStatus'
import { type UpdateHandlers } from './ControlWindow'
import log from './logger'
import {
  type SelfUpdater,
  type SetupAppUpdaterContext,
  type UpdateStatusSource,
  setupAppUpdater,
} from './updaterSetup'

/** A controllable update source that records its status listener. */
function fakeUpdateSource(initial: UpdateStatus = { state: 'idle' }) {
  let status = initial
  let listener: ((status: UpdateStatus) => void) | undefined
  return {
    on: vi.fn((_event: 'status', cb: (status: UpdateStatus) => void) => {
      listener = cb
    }),
    getStatus: vi.fn(() => status),
    start: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    setStatus(next: UpdateStatus) {
      status = next
    },
    emit(next: UpdateStatus) {
      status = next
      listener?.(next)
    },
  }
}

function fakeControlWindow() {
  let handlers: UpdateHandlers | undefined
  return {
    onUpdateStatus: vi.fn<(status: UpdateStatus) => void>(),
    setUpdateHandlers: vi.fn((h: UpdateHandlers) => {
      handlers = h
    }),
    get handlers() {
      return handlers!
    },
  }
}

function baseContext(
  overrides: Partial<SetupAppUpdaterContext> = {},
): SetupAppUpdaterContext {
  return {
    platform: 'darwin',
    isPackaged: true,
    currentVersion: '1.2.3',
    repositorySlug: 'owner/repo',
    controlWindow: fakeControlWindow(),
    openExternal: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('setupAppUpdater — Linux (notify-only)', () => {
  it('wires the Linux checker and forwards status to the control window', () => {
    const checker = fakeUpdateSource()
    const controlWindow = fakeControlWindow()
    const createLinuxUpdateChecker = vi.fn(() => checker as UpdateStatusSource)

    setupAppUpdater(
      baseContext({
        platform: 'linux',
        controlWindow,
        createLinuxUpdateChecker,
      }),
    )

    expect(createLinuxUpdateChecker).toHaveBeenCalledWith({
      currentVersion: '1.2.3',
      repository: 'owner/repo',
    })
    expect(checker.start).toHaveBeenCalledOnce()

    checker.emit({ state: 'checking' })
    expect(controlWindow.onUpdateStatus).toHaveBeenCalledWith({
      state: 'checking',
    })
  })

  it('offers only a release link and never downloads or installs', () => {
    const checker = fakeUpdateSource()
    const controlWindow = fakeControlWindow()
    const openExternal = vi.fn()

    setupAppUpdater(
      baseContext({
        platform: 'linux',
        controlWindow,
        openExternal,
        createLinuxUpdateChecker: () => checker as UpdateStatusSource,
      }),
    )

    const handlers = controlWindow.handlers
    expect(handlers.getAppVersion()).toBe('1.2.3')

    // download/install are inert on Linux.
    expect(() => handlers.download()).not.toThrow()
    expect(() => handlers.install()).not.toThrow()

    checker.setStatus({
      state: 'available',
      version: '2.0.0',
      releaseUrl: 'https://example.com/release',
      canDownload: false,
    })
    handlers.openReleaseNotes()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/release')
  })

  it('does not open a link when no release is available', () => {
    const checker = fakeUpdateSource({ state: 'idle' })
    const controlWindow = fakeControlWindow()
    const openExternal = vi.fn()

    setupAppUpdater(
      baseContext({
        platform: 'linux',
        controlWindow,
        openExternal,
        createLinuxUpdateChecker: () => checker as UpdateStatusSource,
      }),
    )

    controlWindow.handlers.openReleaseNotes()
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('setupAppUpdater — self-updater (macOS / Windows)', () => {
  it('starts the updater only when packaged with a repository slug', () => {
    const updater = fakeUpdateSource()
    setupAppUpdater(
      baseContext({
        platform: 'darwin',
        isPackaged: true,
        createSelfUpdater: () => updater as SelfUpdater,
      }),
    )
    expect(updater.start).toHaveBeenCalledOnce()
  })

  it('does not start the updater in development (not packaged)', () => {
    const updater = fakeUpdateSource()
    setupAppUpdater(
      baseContext({
        isPackaged: false,
        createSelfUpdater: () => updater as SelfUpdater,
      }),
    )
    expect(updater.start).not.toHaveBeenCalled()
  })

  it('does not start the updater without a repository slug', () => {
    const updater = fakeUpdateSource()
    setupAppUpdater(
      baseContext({
        repositorySlug: null,
        createSelfUpdater: () => updater as SelfUpdater,
      }),
    )
    expect(updater.start).not.toHaveBeenCalled()
  })

  it('routes download and install through the updater', () => {
    const updater = fakeUpdateSource()
    const controlWindow = fakeControlWindow()
    setupAppUpdater(
      baseContext({
        controlWindow,
        createSelfUpdater: () => updater as SelfUpdater,
      }),
    )
    controlWindow.handlers.download()
    controlWindow.handlers.install()
    expect(updater.download).toHaveBeenCalledOnce()
    expect(updater.install).toHaveBeenCalledOnce()
  })

  it('logs a warning but still forwards error statuses to the UI', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log)
    const updater = fakeUpdateSource()
    const controlWindow = fakeControlWindow()
    setupAppUpdater(
      baseContext({
        controlWindow,
        createSelfUpdater: () => updater as SelfUpdater,
      }),
    )

    updater.emit({ state: 'error', message: 'offline' })
    expect(warnSpy).toHaveBeenCalledWith('Update check failed:', 'offline')
    expect(controlWindow.onUpdateStatus).toHaveBeenCalledWith({
      state: 'error',
      message: 'offline',
    })
  })

  it('opens the release URL for an available update and release notes when ready', () => {
    const updater = fakeUpdateSource()
    const controlWindow = fakeControlWindow()
    const openExternal = vi.fn()
    setupAppUpdater(
      baseContext({
        controlWindow,
        openExternal,
        createSelfUpdater: () => updater as SelfUpdater,
      }),
    )
    const handlers = controlWindow.handlers

    updater.setStatus({
      state: 'available',
      version: '2.0.0',
      releaseUrl: 'https://example.com/available',
      canDownload: true,
    })
    handlers.openReleaseNotes()
    expect(openExternal).toHaveBeenLastCalledWith(
      'https://example.com/available',
    )

    updater.setStatus({
      state: 'ready',
      version: '2.0.0',
      releaseNotesUrl: 'https://example.com/notes',
    })
    handlers.openReleaseNotes()
    expect(openExternal).toHaveBeenLastCalledWith('https://example.com/notes')
  })
})
