import type { StreamwallRole } from 'streamwall-shared'
import { describe, expect, test, vi } from 'vitest'
import { makeConnection, renderControlUI } from './testHelpers.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to what is under test here) - stub the icons out so the
// component can render.
vi.mock('react-icons/fa', () => ({
  FaExchangeAlt: () => null,
  FaExclamationTriangle: () => null,
  FaRedoAlt: () => null,
  FaRegLifeRing: () => null,
  FaRegWindowMaximize: () => null,
  FaSyncAlt: () => null,
  FaVideoSlash: () => null,
  FaVolumeUp: () => null,
}))
vi.mock('react-icons/md', () => ({
  MdOutlineStayCurrentLandscape: () => null,
  MdOutlineStayCurrentPortrait: () => null,
}))
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: () => {},
}))

const BLOCKED = 'http://192.168.1.5/overlay'

function shownURLs(root: HTMLDivElement): (string | null)[] {
  return [...root.querySelectorAll('.blocked-layer-url')].map(
    (node) => node.textContent,
  )
}

/**
 * Where the refused-URL notice ends up, rather than what it renders (that is
 * `BlockedLayerURLNotice.test.tsx`): it only helps if it is beside the inputs
 * the operator typed the link into, and only roles that manage custom streams
 * have any use for the wall's own network addresses (issue #797).
 */
describe('blocked layer URL placement', () => {
  test('names a refused URL beside the custom stream inputs', () => {
    const root = renderControlUI(
      makeConnection({ role: 'operator', blockedLayerURLs: [BLOCKED] }),
    )

    expect(shownURLs(root)).toEqual([BLOCKED])
    // Not merely somewhere on screen: the notice is about the link the
    // operator typed, so it belongs in the same section as the input it was
    // typed into.
    const notice = root.querySelector('.blocked-layer-url')!.parentElement!
    expect(
      notice.parentElement?.querySelector('input[aria-label="Stream URL"]'),
    ).not.toBeNull()
  })

  test('renders no notice while nothing was refused', () => {
    const root = renderControlUI(makeConnection({ role: 'operator' }))

    expect(shownURLs(root)).toEqual([])
  })

  // The control server withholds the addresses from this role in the first
  // place; the UI does not offer it the custom-stream section either.
  test('shows no notice to a role that cannot manage custom streams', () => {
    const role: StreamwallRole = 'monitor'
    const root = renderControlUI(
      makeConnection({ role, blockedLayerURLs: [BLOCKED] }),
    )

    expect(shownURLs(root)).toEqual([])
  })
})
