import { pathToFileURL } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadHTML, rendererPageURL } from './loadHTML'

// `MAIN_WINDOW_VITE_DEV_SERVER_URL` and `MAIN_WINDOW_VITE_NAME` are injected by
// the Forge/Vite plugin at build time; under test they are stubbed per case.
afterEach(() => {
  vi.unstubAllGlobals()
})

// Records what `loadHTML` actually puts in a window.
function fakeWebContents() {
  const calls: { loadFile: string[]; loadURL: string[] } = {
    loadFile: [],
    loadURL: [],
  }
  const webContents = {
    loadFile: (filePath: string) => {
      calls.loadFile.push(filePath)
      return Promise.resolve()
    },
    loadURL: (url: string) => {
      calls.loadURL.push(url)
      return Promise.resolve()
    },
  }
  return { calls, webContents: webContents as never }
}

const packaged = () => {
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined)
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
}

const dev = () => {
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173')
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
}

describe('rendererPageURL', () => {
  // The whole point of the export: `secureAppWindow` pins a window to this URL,
  // so it has to be the URL the window actually ends up on. A drift between the
  // two would either wedge the window or open a hole.
  it('is the file URL loadHTML loads in a packaged build', async () => {
    packaged()
    const { calls, webContents } = fakeWebContents()

    await loadHTML(webContents, 'control')

    expect(calls.loadFile).toHaveLength(1)
    expect(rendererPageURL('control')).toBe(
      pathToFileURL(calls.loadFile[0]).href,
    )
  })

  it('is the dev server URL loadHTML loads in development', async () => {
    dev()
    const { calls, webContents } = fakeWebContents()

    await loadHTML(webContents, 'control')

    expect(calls.loadURL).toEqual([rendererPageURL('control')])
  })

  it('names a different URL per page', () => {
    packaged()

    expect(rendererPageURL('control')).not.toBe(rendererPageURL('overlay'))
  })

  it('points at the page itself, not just its directory', () => {
    packaged()

    expect(rendererPageURL('control').endsWith('/control.html')).toBe(true)
  })

  it('is an absolute file URL in a packaged build', () => {
    packaged()

    expect(rendererPageURL('control').startsWith('file:///')).toBe(true)
  })

  it('is served from the dev server origin in development', () => {
    dev()

    expect(new URL(rendererPageURL('control')).origin).toBe(
      'http://localhost:5173',
    )
  })
})
