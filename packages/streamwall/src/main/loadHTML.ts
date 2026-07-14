import { WebContents } from 'electron'
import path from 'path'
import querystring from 'querystring'

/**
 * Origin of the Vite dev server that serves the renderer HTML pages during
 * development, or undefined in a packaged build (where those pages are loaded
 * from disk via file://). The dev server lives on loopback, so the SSRF request
 * guard must allow this origin explicitly or it would cancel the HLS renderer
 * page and its bundled assets while developing.
 */
export function devServerOrigin(): string | undefined {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return undefined
  }
  try {
    return new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
  } catch {
    return undefined
  }
}

export function loadHTML(
  webContents: WebContents,
  name: 'background' | 'overlay' | 'playHLS' | 'control',
  options?: { query?: Record<string, string> },
) {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const queryString = options?.query
      ? '?' + querystring.stringify(options.query)
      : ''
    webContents.loadURL(
      `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/src/renderer/${name}.html` +
        queryString,
    )
  } else {
    webContents.loadFile(
      path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/src/renderer/${name}.html`,
      ),
      options,
    )
  }
}
