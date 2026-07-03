import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Reads the Content-Security-Policy meta tag from a renderer HTML file that
 * sits next to this test and returns its raw policy string.
 */
function readCSP(fileName: string): string {
  const html = readFileSync(new URL(`./${fileName}`, import.meta.url), 'utf8')
  const match = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i,
  )
  expect(
    match,
    `${fileName} must declare a Content-Security-Policy meta tag`,
  ).not.toBeNull()
  return match![1]
}

/**
 * Parses a CSP string into a map of directive name -> array of source tokens.
 */
function parseCSP(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) {
      continue
    }
    const [name, ...sources] = tokens
    directives.set(name.toLowerCase(), sources)
  }
  return directives
}

const ALL_RENDERERS = [
  'background.html',
  'overlay.html',
  'playHLS.html',
  'control.html',
]

describe('renderer Content-Security-Policy', () => {
  it('never uses the bare "*" wildcard source', () => {
    for (const file of ALL_RENDERERS) {
      const directives = parseCSP(readCSP(file))
      for (const [name, sources] of directives) {
        expect(
          sources,
          `${file}: directive "${name}" must not use the bare "*" wildcard`,
        ).not.toContain('*')
      }
    }
  })

  it("keeps scripts locked to 'self' in every renderer", () => {
    for (const file of ALL_RENDERERS) {
      const directives = parseCSP(readCSP(file))
      const scriptSrc =
        directives.get('script-src') ?? directives.get('default-src')
      expect(
        scriptSrc,
        `${file}: scripts must stay restricted to 'self'`,
      ).toEqual(["'self'"])
    }
  })

  it('restricts overlay/background frame-src to http(s) stream origins', () => {
    // Streams are embedded from arbitrary user-configured origins, all of
    // which ensureValidURL constrains to http(s), so both schemes must remain
    // allowed for the grid to keep working.
    for (const file of ['background.html', 'overlay.html']) {
      const frameSrc = parseCSP(readCSP(file)).get('frame-src')
      expect(frameSrc, `${file}: frame-src must be present`).toBeDefined()
      expect(new Set(frameSrc)).toEqual(new Set(['https:', 'http:']))
    }
  })

  it('restricts playHLS connect-src to self and http(s) origins', () => {
    // hls.js fetches manifests/segments over http(s); 'self' keeps same-origin
    // requests (e.g. the Vite dev server) working.
    const connectSrc = parseCSP(readCSP('playHLS.html')).get('connect-src')
    expect(
      connectSrc,
      'playHLS.html: connect-src must be present',
    ).toBeDefined()
    expect(new Set(connectSrc)).toEqual(new Set(["'self'", 'https:', 'http:']))
  })

  it('keeps playHLS blob media playback without a wildcard', () => {
    // hls.js plays through a MediaSource blob: URL; http/https cover any direct
    // source fallback.
    const mediaSrc = parseCSP(readCSP('playHLS.html')).get('media-src')
    expect(mediaSrc, 'playHLS.html: media-src must be present').toBeDefined()
    expect(new Set(mediaSrc)).toEqual(new Set(['blob:', 'https:', 'http:']))
  })
})
