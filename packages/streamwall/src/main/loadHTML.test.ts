import path from 'path'
import { pathToFileURL } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isAppPageURL, loadHTML } from './loadHTML'

// `MAIN_WINDOW_VITE_DEV_SERVER_URL` and `MAIN_WINDOW_VITE_NAME` are injected by
// the Forge/Vite plugin at build time; under test they are stubbed per case.
afterEach(() => {
  vi.unstubAllGlobals()
})

const rendererRoot = path.resolve(__dirname, '../renderer/main_window')
const appPage = pathToFileURL(
  path.join(rendererRoot, 'src/renderer/control.html'),
).href

describe('isAppPageURL in a packaged build', () => {
  // No dev server URL is the packaged case; pages come off disk.
  const packaged = () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined)
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
  }

  it('accepts a page inside the bundled renderer directory', () => {
    packaged()

    expect(isAppPageURL(appPage)).toBe(true)
  })

  // Ties the allowlist to the loader: whatever `loadHTML` actually puts in the
  // window must be an app page, and its parent directory must not be. Without
  // this, a wrong renderer root in `isAppPageURL` (say one segment too high,
  // allowlisting everything under `src/`) would leave every other case here
  // green because they all derive their fixtures from the same expression.
  it('accepts exactly what loadHTML loads, and not the directory above it', async () => {
    packaged()
    let loaded = ''
    const webContents = {
      loadFile: (filePath: string) => {
        loaded = filePath
        return Promise.resolve()
      },
      loadURL: () => Promise.resolve(),
    }

    await loadHTML(webContents as never, 'control')

    expect(isAppPageURL(pathToFileURL(loaded).href)).toBe(true)
    // `src/renderer/control.html` -> `src/renderer` -> `src` -> the renderer
    // root itself, whose parent is outside the bundle.
    const outside = path.resolve(loaded, '../../../..')
    expect(isAppPageURL(pathToFileURL(path.join(outside, 'x.html')).href)).toBe(
      false,
    )
  })

  it('rejects a file URL outside the renderer directory', () => {
    packaged()

    expect(isAppPageURL(pathToFileURL('/etc/passwd').href)).toBe(false)
  })

  it('rejects a file URL that tries to climb out of the renderer directory', () => {
    packaged()

    expect(
      isAppPageURL(`${pathToFileURL(rendererRoot).href}/../../../etc/passwd`),
    ).toBe(false)
  })

  it('rejects a sibling directory that merely starts with the renderer directory name', () => {
    // What the trailing separator in the prefix check is for: without it,
    // `.../main_window_evil/` passes as `.../main_window` + more.
    packaged()

    expect(
      isAppPageURL(pathToFileURL(`${rendererRoot}_evil/control.html`).href),
    ).toBe(false)
  })

  it('rejects the renderer directory itself, which is not a page', () => {
    packaged()

    expect(isAppPageURL(pathToFileURL(rendererRoot).href)).toBe(false)
  })

  it('rejects remote origins', () => {
    packaged()

    expect(isAppPageURL('https://evil.example/')).toBe(false)
  })

  it('rejects a string that is not a URL', () => {
    packaged()

    expect(isAppPageURL('not a url')).toBe(false)
  })

  it('rejects about:blank, which carries no origin of its own', () => {
    packaged()

    expect(isAppPageURL('about:blank')).toBe(false)
  })
})

describe('isAppPageURL against a dev server', () => {
  const dev = () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173')
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
  }

  it('accepts any page served from the dev server origin', () => {
    dev()

    expect(
      isAppPageURL('http://localhost:5173/src/renderer/control.html'),
    ).toBe(true)
  })

  it('rejects a different port on the same host', () => {
    dev()

    expect(
      isAppPageURL('http://localhost:5174/src/renderer/control.html'),
    ).toBe(false)
  })

  it('rejects a file URL while the dev server is in use', () => {
    dev()

    expect(isAppPageURL(appPage)).toBe(false)
  })
})
