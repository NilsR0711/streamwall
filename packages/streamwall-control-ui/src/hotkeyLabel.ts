export const hotkeyTriggers = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '0',
  'q',
  'w',
  'e',
  'r',
  't',
  'y',
  'u',
  'i',
  'o',
  'p',
]

/** Builds the `alt+<...>+<key>` combos for each layer, e.g. `alt+1,alt+2,...`. */
function hotkeyLayerBindingsFor(
  layers: ReadonlyArray<{ readonly prefix: string }>,
): string[] {
  return layers.map((layer) =>
    hotkeyTriggers.map((k) => `${layer.prefix}+${k}`).join(','),
  )
}

/**
 * Audio-listen hotkeys are laid out in "layers": each layer maps the same 20
 * trigger keys to a block of grid cells, distinguished by an extra modifier.
 * Layer 0 (`alt+<key>`) covers cells 0-19; layer 1 (`alt+ctrl+<key>`) covers
 * cells 20-39. `alt+shift+<key>` is already taken by the blur toggle's own
 * base layer, so the second audio layer stacks `ctrl` instead. (Caveat: on
 * Windows international layouts `Ctrl+Alt` acts as AltGr; acceptable since
 * the control UI runs primarily in the Electron control window and the
 * handler preventDefault()s.)
 *
 * Grids can have up to GRID_MAX * GRID_MAX = 64 cells, but cells 40-63 (only
 * reachable on 7x7/8x8 grids) are intentionally left without a hotkey rather
 * than introducing a fragile triple-modifier layer that conflicts with OS
 * shortcuts.
 */
export const hotkeyLayers = [
  { prefix: 'alt', label: 'Alt' },
  { prefix: 'alt+ctrl', label: 'Alt+Ctrl' },
] as const

/** The `alt+<...>+<key>` combos each layer binds, e.g. `alt+1,alt+2,...`. */
export const hotkeyLayerBindings = hotkeyLayerBindingsFor(hotkeyLayers)

/**
 * Blur-toggle hotkeys, laid out the same way as the audio-listen layers above
 * for parity (see #294): layer 0 (`alt+shift+<key>`) covers cells 0-19, layer
 * 1 covers cells 20-39. `alt+ctrl+<key>` is already taken by the audio-listen
 * layer 1, so the second blur layer stacks `ctrl+shift` together instead of
 * reusing either modifier alone. Same AltGr caveat as the audio layer above,
 * plus the extra `shift` chord on top.
 */
export const blurHotkeyLayers = [
  { prefix: 'alt+shift', label: 'Alt+Shift' },
  { prefix: 'alt+ctrl+shift', label: 'Alt+Ctrl+Shift' },
] as const

/** The `alt+shift+...+<key>` combos each blur layer binds. */
export const blurHotkeyLayerBindings = hotkeyLayerBindingsFor(blurHotkeyLayers)

/**
 * Label for the audio-toggle hotkey assigned to grid cell `idx` (e.g. `Alt+1`
 * or `Alt+Ctrl+1`), or `undefined` if `idx` falls outside every hotkey layer.
 */
export function getHotkeyLabel(idx: number): string | undefined {
  if (idx < 0) {
    return undefined
  }
  const layer = hotkeyLayers[Math.floor(idx / hotkeyTriggers.length)]
  const key = hotkeyTriggers[idx % hotkeyTriggers.length]
  if (layer === undefined || key === undefined) {
    return undefined
  }
  return `${layer.label}+${key.toUpperCase()}`
}
