import Color from 'color'

// Re-exported so consumers construct/re-wrap colors via this exact module
// instance instead of installing their own copy of 'color' — the monorepo's
// per-workspace node_modules layout means a separately imported copy is a
// physically different class, breaking Color's `instanceof` fast path for
// values returned by idColor() below.
export { Color }

export function hashText(text: string, range: number) {
  // DJBX33A-ish
  // based on https://github.com/euphoria-io/heim/blob/978c921063e6b06012fc8d16d9fbf1b3a0be1191/client/lib/hueHash.js#L16-L45
  let val = 0
  for (let i = 0; i < text.length; i++) {
    // Multiply by an arbitrary prime number to spread out similar letters.
    const charVal = (text.charCodeAt(i) * 401) % range

    // Multiply val by 33 while constraining within signed 32 bit int range.
    // this keeps the value within Number.MAX_SAFE_INTEGER without throwing out
    // information.
    const origVal = val
    val = val << 5
    val += origVal

    // Add the character to the hash.
    val += charVal
  }

  // val can wrap into large negative values due to the 32-bit `<<` above, so
  // reduce it into (-range, range) before shifting into [0, range).
  return ((val % range) + range) % range
}

export function idColor(id: string) {
  if (!id) {
    return Color('white')
  }
  const h = hashText(id, 360)
  const sPart = hashText(id, 40)
  return Color({ h, s: 20 + sPart, l: 50 })
}

/**
 * Contrast-safe focus ring colours for a surface painted with an id-derived
 * colour (see idColor above).
 *
 * The shared `:focus-visible` affordance uses the accent token, which works
 * everywhere it sits on a neutral surface. In the grid the ring is drawn with
 * `outline-offset` onto the *neighbouring* cells, whose colour is whatever the
 * stream id hashes to — so a red-ish tile can leave the red accent at roughly
 * 2:1, below the 3:1 WCAG 2.4.11 (Focus Appearance) asks for (#557).
 *
 * Picking the better of black/white clears 3:1 against every colour the id
 * space can paint, and the pair contrasts against itself, so both edges of the
 * indicator stay legible.
 */
export function focusRingColors(tile: ReturnType<typeof Color>) {
  const black = Color('black')
  const white = Color('white')
  const ringIsBlack = tile.contrast(black) >= tile.contrast(white)
  return {
    ring: (ringIsBlack ? black : white).hex(),
    halo: (ringIsBlack ? white : black).hex(),
  }
}
