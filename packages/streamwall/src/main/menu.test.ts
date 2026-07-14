import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const setApplicationMenu = vi.fn()
const buildFromTemplate = vi.fn((template: MenuItemConstructorOptions[]) => ({
  __template: template,
}))
const openPath = vi.fn()

vi.mock('electron', () => ({
  Menu: { setApplicationMenu, buildFromTemplate },
  shell: { openPath },
  app: { name: 'Streamwall' },
}))

const { buildApplicationMenuTemplate, installApplicationMenu } =
  await import('./menu')

function searchForOpenConfigFolderItem(
  template: MenuItemConstructorOptions[],
): MenuItemConstructorOptions | undefined {
  for (const item of template) {
    if (item.label === 'Open Config Folder') {
      return item
    }
    if (Array.isArray(item.submenu)) {
      const found = searchForOpenConfigFolderItem(
        item.submenu as MenuItemConstructorOptions[],
      )
      if (found) {
        return found
      }
    }
  }
  return undefined
}

function findOpenConfigFolderItem(
  template: MenuItemConstructorOptions[],
): MenuItemConstructorOptions {
  const found = searchForOpenConfigFolderItem(template)
  if (!found) {
    throw new Error('"Open Config Folder" menu item not found in template')
  }
  return found
}

describe('buildApplicationMenuTemplate', () => {
  afterEach(() => {
    openPath.mockClear()
  })

  it('includes an "Open Config Folder" item that opens the directory containing the config path', () => {
    const template = buildApplicationMenuTemplate(
      '/Users/test/Library/Application Support/Streamwall/config.toml',
    )

    const item = findOpenConfigFolderItem(template)
    expect(typeof item.click).toBe('function')

    ;(item.click as () => void)()

    expect(openPath).toHaveBeenCalledWith(
      '/Users/test/Library/Application Support/Streamwall',
    )
  })

  it('works when the config file does not exist yet (first run)', () => {
    const template = buildApplicationMenuTemplate(
      '/home/test/.config/Streamwall/config.toml',
    )

    const item = findOpenConfigFolderItem(template)
    ;(item.click as () => void)()

    // openPath targets the userData directory itself, which Electron always
    // creates - unlike shell.showItemInFolder, it doesn't require config.toml
    // to already exist.
    expect(openPath).toHaveBeenCalledWith('/home/test/.config/Streamwall')
  })
})

describe('installApplicationMenu', () => {
  afterEach(() => {
    setApplicationMenu.mockClear()
    buildFromTemplate.mockClear()
  })

  it('builds a menu from the template and installs it as the application menu', () => {
    installApplicationMenu('/home/test/.config/Streamwall/config.toml')

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledWith(
      buildFromTemplate.mock.results[0]?.value,
    )
  })
})
