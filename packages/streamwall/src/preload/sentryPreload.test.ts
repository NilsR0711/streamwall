// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
}))

// The real module hooks up @sentry/electron's own IPC transport as a side
// effect of being imported. That wiring is third-party behavior, not this
// file's own logic, so it's stubbed out to isolate sentryPreload's own
// contribution: exposing `sentryEnabled` from the --sentry-enabled=true arg.
vi.mock('@sentry/electron/preload', () => ({}))

const ORIGINAL_ARGV = process.argv

afterEach(() => {
  vi.resetModules()
  exposeInMainWorld.mockClear()
  process.argv = ORIGINAL_ARGV
})

describe('sentryPreload', () => {
  it('exposes sentryEnabled=true when --sentry-enabled=true is present in argv', async () => {
    process.argv = [...ORIGINAL_ARGV, '--sentry-enabled=true']

    await import('./sentryPreload')

    expect(exposeInMainWorld).toHaveBeenCalledWith('sentryEnabled', true)
  })

  it('exposes sentryEnabled=false when the switch is absent from argv', async () => {
    process.argv = ORIGINAL_ARGV

    await import('./sentryPreload')

    expect(exposeInMainWorld).toHaveBeenCalledWith('sentryEnabled', false)
  })

  it('exposes sentryEnabled=false when the switch is present but set to false', async () => {
    process.argv = [...ORIGINAL_ARGV, '--sentry-enabled=false']

    await import('./sentryPreload')

    expect(exposeInMainWorld).toHaveBeenCalledWith('sentryEnabled', false)
  })
})
