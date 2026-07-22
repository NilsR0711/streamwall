import { describe, expect, test, vi } from 'vitest'
import { makeConnection, renderControlUI } from './testHelpers.tsx'

vi.mock(
  'react-icons/fa',
  async () => (await import('./testIconStubs.tsx')).faIconStubs,
)
vi.mock(
  'react-icons/md',
  async () => (await import('./testIconStubs.tsx')).mdIconStubs,
)
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: () => {},
}))

// Regression test for issue #594: `renderControlUI` used to track the
// mounted container in a single module-scope `let`, so a second call within
// the same test silently leaked the first container (and its Preact root) -
// the shared `afterEach` only ever unmounted the last one.
//
// This spans two `test`s deliberately: the leak can only be observed once
// the shared `afterEach` between them has actually run.
let containersFromPriorTest: HTMLDivElement[] = []

describe('renderControlUI container cleanup (issue #594)', () => {
  test('mounts two independent containers within a single test', () => {
    const first = renderControlUI(makeConnection())
    const second = renderControlUI(makeConnection())

    expect(first).not.toBe(second)
    expect(document.body.contains(first)).toBe(true)
    expect(document.body.contains(second)).toBe(true)

    containersFromPriorTest = [first, second]
  })

  test('the shared afterEach unmounted and detached both prior containers', () => {
    expect(containersFromPriorTest).toHaveLength(2)
    for (const container of containersFromPriorTest) {
      expect(document.body.contains(container)).toBe(false)
      expect(container.childElementCount).toBe(0)
    }
  })
})
