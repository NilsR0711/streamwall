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

/**
 * Loads one of the renderer HTML pages into `webContents`. Returns the
 * underlying `loadURL`/`loadFile` promise so callers can attach a `.catch`
 * breadcrumb: a superseded navigation (e.g. a reload/swap racing an in-flight
 * load) rejects with `ERR_ABORTED`, which is otherwise invisible and surfaces
 * as an unhandled promise rejection (issue #392/#626).
 */
export function loadHTML(
  webContents: WebContents,
  name: 'background' | 'overlay' | 'playHLS' | 'control',
  options?: { query?: Record<string, string> },
): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const queryString = options?.query
      ? '?' + querystring.stringify(options.query)
      : ''
    return webContents.loadURL(
      `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/src/renderer/${name}.html` +
        queryString,
    )
  } else {
    return webContents.loadFile(
      path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/src/renderer/${name}.html`,
      ),
      options,
    )
  }
}
