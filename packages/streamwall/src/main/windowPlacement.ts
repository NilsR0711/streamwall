export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Minimal shape of an Electron `Display` needed to place a window. */
export interface DisplayInfo {
  bounds: DisplayBounds
}

export interface WindowPlacementConfig {
  x?: number
  y?: number
  width: number
  height: number
  /** 0-based index into the display list; selects the monitor to open on. */
  display?: number
  fullscreen: boolean
}

export interface ResolvedWindowPlacement {
  x?: number
  y?: number
  width: number
  height: number
  fullscreen: boolean
}

export interface WindowPlacementResult {
  placement: ResolvedWindowPlacement
  warning?: string
}

/**
 * Resolves the wall window's on-screen placement from the configured
 * `window.display` / `window.fullscreen` options and the set of displays
 * Electron reports (`screen.getAllDisplays()`).
 *
 * The `display` index is validated here rather than at config-parse time
 * because the display list only exists once Electron is ready and can change
 * between runs (monitors plugged in or out). An out-of-range index therefore
 * degrades to Electron's default placement plus a `warning`, instead of a hard
 * failure that would leave the wall unopenable on a different machine.
 */
export function resolveWindowPlacement(
  config: WindowPlacementConfig,
  displays: DisplayInfo[],
): WindowPlacementResult {
  const { x, y, width, height, display, fullscreen } = config

  // No target display: honor explicit x/y (either may be undefined, letting
  // Electron pick the position) and pass the fullscreen intent through.
  if (display === undefined) {
    return { placement: { x, y, width, height, fullscreen } }
  }

  const target = displays[display]
  if (!target) {
    return {
      placement: { x, y, width, height, fullscreen },
      warning:
        `Configured window.display ${display} is out of range ` +
        `(${displays.length} display(s) detected); using default placement.`,
    }
  }

  const { bounds } = target
  if (fullscreen) {
    // Anchor the window's origin on the target display so Electron opens it
    // fullscreen on that monitor rather than the primary one.
    return {
      placement: { x: bounds.x, y: bounds.y, width, height, fullscreen: true },
    }
  }

  // Windowed: center within the target display, clamped so the window's
  // top-left never lands off the display when it is larger than the monitor.
  const offsetX = Math.max(0, Math.floor((bounds.width - width) / 2))
  const offsetY = Math.max(0, Math.floor((bounds.height - height) / 2))
  return {
    placement: {
      x: bounds.x + offsetX,
      y: bounds.y + offsetY,
      width,
      height,
      fullscreen: false,
    },
  }
}
