import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Source regression guard: the two layer renderers must not fall back to the
 * ineffective `allow-scripts allow-same-origin` sandbox, and must instead
 * apply the shared LAYER_FRAME_SANDBOX policy to their iframe.
 */
describe('layer renderer iframe sandbox', () => {
  for (const file of ['OverlayRoot.tsx', 'background.tsx']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

    it(`${file} does not hardcode the ineffective allow-same-origin sandbox`, () => {
      expect(source).not.toMatch(/allow-same-origin/)
    })

    it(`${file} applies the shared LAYER_FRAME_SANDBOX policy to its iframe`, () => {
      expect(source).toMatch(/sandbox=\{LAYER_FRAME_SANDBOX\}/)
    })
  }
})
