import { afterEach, describe, expect, test, vi } from 'vitest'
import { makeConnection, renderControlUI } from './testHelpers.tsx'

vi.mock(
  'react-icons/fa',
  async () => (await import('./testIconStubs.tsx')).faIconStubs,
)
vi.mock(
  'react-icons/md',
  async () => (await import('./testIconStubs.tsx')).mdIconStubs,
)

const useHotkeysMock = vi.hoisted(() => vi.fn())
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: useHotkeysMock,
}))

afterEach(() => {
  useHotkeysMock.mockClear()
})

function renderWithHotkeys(): HTMLDivElement {
  return renderControlUI(makeConnection())
}

describe('alt+<n> listen-toggle hotkey', () => {
  test('enables the hotkey while a grid input is focused via the v5 enableOnFormTags option', () => {
    renderWithHotkeys()

    const listenToggleCall = useHotkeysMock.mock.calls.find(
      ([keys]) =>
        typeof keys === 'string' &&
        keys
          .split(',')
          .every(
            (k) =>
              k.startsWith('alt+') &&
              !k.includes('shift') &&
              !k.includes('ctrl'),
          ),
    )

    expect(listenToggleCall).toBeDefined()
    const options = listenToggleCall?.[2]
    expect(options).toEqual({ enableOnFormTags: true })
  })
})

describe('alt+ctrl+<n> second-layer listen-toggle hotkey (#240)', () => {
  test('registers an alt+ctrl chord layer covering the same 20 trigger keys', () => {
    renderWithHotkeys()

    const secondLayerCall = useHotkeysMock.mock.calls.find(
      ([keys]) =>
        typeof keys === 'string' &&
        keys.split(',').every((k) => k.startsWith('alt+ctrl+')),
    )

    expect(secondLayerCall).toBeDefined()
    const [keys, , options] = secondLayerCall ?? []
    // Same 20 trigger keys as the base layer, just chorded with ctrl.
    expect((keys as string).split(',')).toHaveLength(20)
    // Must stay usable while a grid input is focused, like the base layer.
    expect(options).toEqual({ enableOnFormTags: true })
  })
})

describe('alt+shift+<n> blur-toggle hotkey', () => {
  test('registers a base alt+shift chord layer covering 20 trigger keys', () => {
    renderWithHotkeys()

    const baseLayerCall = useHotkeysMock.mock.calls.find(
      ([keys]) =>
        typeof keys === 'string' &&
        keys
          .split(',')
          .every((k) => k.startsWith('alt+shift+') && !k.includes('ctrl')),
    )

    expect(baseLayerCall).toBeDefined()
    const [keys] = baseLayerCall ?? []
    expect((keys as string).split(',')).toHaveLength(20)
  })
})

describe('alt+ctrl+shift+<n> second-layer blur-toggle hotkey (#294)', () => {
  test('registers an alt+ctrl+shift chord layer covering the same 20 trigger keys', () => {
    renderWithHotkeys()

    const secondLayerCall = useHotkeysMock.mock.calls.find(
      ([keys]) =>
        typeof keys === 'string' &&
        keys.split(',').every((k) => k.startsWith('alt+ctrl+shift+')),
    )

    expect(secondLayerCall).toBeDefined()
    const [keys] = secondLayerCall ?? []
    // Same 20 trigger keys as the base blur layer, just chorded with ctrl too.
    expect((keys as string).split(',')).toHaveLength(20)
  })
})
