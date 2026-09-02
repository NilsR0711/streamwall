import { WebContents } from 'electron'
import path from 'path'
import querystring from 'querystring'
import { pathToFileURL } from 'url'

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

/** The renderer HTML pages the app ships. */
export type RendererPage = 'background' | 'overlay' | 'playHLS' | 'control'

/** Directory the packaged renderer bundle (HTML pages and assets) lives in. */
function rendererRoot(): string {
  return path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`)
}

/** Where `loadHTML` reads `name` from in a packaged build. */
function rendererPagePath(name: RendererPage): string {
  return path.join(rendererRoot(), `src/renderer/${name}.html`)
}

/**
 * The exact URL a window ends up on after `loadHTML(webContents, name)` -- the
 * one navigation target a window rendering that page may reach (#732).
 *
 * A single page rather than the whole bundle: the app's renderer pages do not
 * all carry the same CSP (the layer and HLS pages allow remote frames and
 * media), and a window keeps its preload across a same-directory navigation, so
 * "somewhere under the renderer directory" would be a weaker guarantee than it
 * looks.
 */
export function rendererPageURL(name: RendererPage): string {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/src/renderer/${name}.html`
  }
  return pathToFileURL(rendererPagePath(name)).href
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
  name: RendererPage,
  options?: { query?: Record<string, string> },
): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const queryString = options?.query
      ? '?' + querystring.stringify(options.query)
      : ''
    return webContents.loadURL(rendererPageURL(name) + queryString)
  } else {
    return webContents.loadFile(rendererPagePath(name), options)
  }
}
