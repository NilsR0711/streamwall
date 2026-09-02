import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Source regression guard for the background layer, which cannot be rendered in
 * a test: `background.tsx` calls `render(<App />, document.body)` at module
 * scope, so importing it runs the app.
 *
 * Both layer renderers must key their iframe with `layerFrameKey` — keyed by
 * the whole layer link set, so that editing any layer link remounts every layer
 * frame. A frame the guard refused is requested exactly once, so a layer that
 * is still blocked has to be re-requested to report itself again once the edit
 * has cleared the notice (#790). `OverlayRoot.tsx` has a behavioural test for
 * this in `OverlayRoot.test.tsx`; this pins the other half.
 */
describe('layer renderer iframe keys', () => {
  for (const file of ['OverlayRoot.tsx', 'background.tsx']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

    it(`${file} keys its iframe with layerFrameKey`, () => {
      expect(source).toMatch(/key=\{layerFrameKey\(/)
    })

    it(`${file} derives that key from the whole layer link set`, () => {
      expect(source).toMatch(/layerLinksKey\(streams\)/)
    })
  }
})
