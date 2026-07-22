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
// react-hotkeys-hook resolves its own copy of `react` (bypassing this
// package's `react` -> `preact/compat` test alias), which crashes under
// happy-dom with an "Invalid hook call" error unrelated to the markup under
// test here - stub it out so the component's own rendering logic can be
// exercised in isolation.
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: () => {},
}))

// styled-components v6 forwards any non-`$`-prefixed custom prop that isn't a
// recognized HTML attribute straight onto the DOM node. Each of these is a
// custom prop consumed by a styled component in this file (see #152) and must
// never show up as a literal attribute in the rendered markup.
const leakedPropNames = [
  'direction',
  'flex',
  'gap',
  'scroll',
  'minheight',
  'isconnected',
  'isactive',
  'activecolor',
]

describe('styled-component custom props (transient props)', () => {
  test('never leak onto rendered DOM elements as literal attributes', () => {
    const root = renderControlUI(makeConnection())

    for (const el of root.querySelectorAll('*')) {
      for (const propName of leakedPropNames) {
        expect(
          el.hasAttribute(propName),
          `<${el.tagName.toLowerCase()}> unexpectedly has a "${propName}" attribute`,
        ).toBe(false)
      }
    }
  })
})
