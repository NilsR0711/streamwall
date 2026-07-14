import { describe, expect, it } from 'vitest'
import { DisplayInfo, resolveWindowPlacement } from './windowPlacement'

const PRIMARY: DisplayInfo = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
}
// A secondary display positioned to the right of the primary one, as Electron
// reports it via `screen.getAllDisplays()`.
const SECONDARY: DisplayInfo = {
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
}

describe('resolveWindowPlacement', () => {
  describe('without a target display', () => {
    it('passes through undefined x/y so Electron places the window itself', () => {
      const { placement, warning } = resolveWindowPlacement(
        { width: 1280, height: 720, fullscreen: false },
        [PRIMARY, SECONDARY],
      )

      expect(placement).toEqual({
        x: undefined,
        y: undefined,
        width: 1280,
        height: 720,
        fullscreen: false,
      })
      expect(warning).toBeUndefined()
    })

    it('preserves explicit x/y coordinates', () => {
      const { placement } = resolveWindowPlacement(
        { x: 100, y: 200, width: 1280, height: 720, fullscreen: false },
        [PRIMARY],
      )

      expect(placement.x).toBe(100)
      expect(placement.y).toBe(200)
    })

    it('carries the fullscreen flag through unchanged', () => {
      const { placement } = resolveWindowPlacement(
        { width: 1920, height: 1080, fullscreen: true },
        [PRIMARY],
      )

      expect(placement.fullscreen).toBe(true)
    })
  })

  describe('with a valid target display, windowed', () => {
    it('centers the window within the primary display', () => {
      const { placement, warning } = resolveWindowPlacement(
        { width: 1280, height: 720, display: 0, fullscreen: false },
        [PRIMARY, SECONDARY],
      )

      // (1920 - 1280) / 2 = 320, (1080 - 720) / 2 = 180
      expect(placement).toEqual({
        x: 320,
        y: 180,
        width: 1280,
        height: 720,
        fullscreen: false,
      })
      expect(warning).toBeUndefined()
    })

    it('centers the window within a secondary display, offset by its origin', () => {
      const { placement } = resolveWindowPlacement(
        { width: 1280, height: 720, display: 1, fullscreen: false },
        [PRIMARY, SECONDARY],
      )

      // origin 1920 + (2560 - 1280) / 2 = 1920 + 640 = 2560
      expect(placement.x).toBe(2560)
      // origin 0 + (1440 - 720) / 2 = 360
      expect(placement.y).toBe(360)
    })

    it('clamps to the display origin when the window is larger than the display', () => {
      const { placement } = resolveWindowPlacement(
        { width: 4000, height: 3000, display: 1, fullscreen: false },
        [PRIMARY, SECONDARY],
      )

      // Never offset past the display's top-left corner.
      expect(placement.x).toBe(1920)
      expect(placement.y).toBe(0)
    })

    it('ignores explicit x/y in favor of the selected display', () => {
      const { placement } = resolveWindowPlacement(
        {
          x: 50,
          y: 50,
          width: 1280,
          height: 720,
          display: 1,
          fullscreen: false,
        },
        [PRIMARY, SECONDARY],
      )

      expect(placement.x).toBe(2560)
      expect(placement.y).toBe(360)
    })
  })

  describe('with a valid target display, fullscreen', () => {
    it('anchors the window origin on the target display', () => {
      const { placement, warning } = resolveWindowPlacement(
        { width: 1920, height: 1080, display: 1, fullscreen: true },
        [PRIMARY, SECONDARY],
      )

      expect(placement.x).toBe(1920)
      expect(placement.y).toBe(0)
      expect(placement.fullscreen).toBe(true)
      expect(warning).toBeUndefined()
    })
  })

  describe('with an invalid target display', () => {
    it('warns and falls back to default placement when the index is too high', () => {
      const { placement, warning } = resolveWindowPlacement(
        {
          x: 10,
          y: 20,
          width: 1280,
          height: 720,
          display: 5,
          fullscreen: false,
        },
        [PRIMARY, SECONDARY],
      )

      expect(placement).toEqual({
        x: 10,
        y: 20,
        width: 1280,
        height: 720,
        fullscreen: false,
      })
      expect(warning).toMatch(/display 5/)
      expect(warning).toMatch(/2 display/)
    })

    it('warns and falls back when the index is negative', () => {
      const { placement, warning } = resolveWindowPlacement(
        { width: 1280, height: 720, display: -1, fullscreen: false },
        [PRIMARY],
      )

      expect(placement.x).toBeUndefined()
      expect(placement.y).toBeUndefined()
      expect(warning).toBeDefined()
    })

    it('warns when no displays are reported', () => {
      const { placement, warning } = resolveWindowPlacement(
        { width: 1280, height: 720, display: 0, fullscreen: true },
        [],
      )

      // Fullscreen intent is still honored even without a resolvable display.
      expect(placement.fullscreen).toBe(true)
      expect(warning).toMatch(/0 display/)
    })
  })
})
