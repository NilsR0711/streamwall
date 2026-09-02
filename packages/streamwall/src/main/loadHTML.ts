import { WebContents } from 'electron'
import path from 'path'
import querystring from 'querystring'
import { fileURLToPath } from 'url'

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

/** Directory the packaged renderer bundle (HTML pages and assets) lives in. */
function rendererRoot(): string {
  return path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`)
}

/**
 * Whether `url` is one of the app's own renderer pages -- the only navigation
 * target a window rendering Streamwall's own UI may reach (#732).
 *
 * In development that is the Vite dev server's origin; in a packaged build it is
 * a `file:` URL inside the bundled renderer directory. The prefix check carries
 * the trailing separator so a sibling directory that merely starts with the same
 * name (`.../main_window_evil/`) is not accepted, and the path is resolved first
 * so the answer does not depend on the URL parser having folded `..` segments
 * away.
 */
export function isAppPageURL(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const devOrigin = devServerOrigin()
  if (devOrigin) {
    return parsed.origin === devOrigin
  }

  if (parsed.protocol !== 'file:') {
    return false
  }
  try {
    const root = rendererRoot()
    return path.resolve(fileURLToPath(parsed)).startsWith(root + path.sep)
  } catch {
    return false
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
      path.join(rendererRoot(), `src/renderer/${name}.html`),
      options,
    )
  }
}
