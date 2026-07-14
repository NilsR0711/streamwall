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

function searchForMenuItem(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  for (const item of template) {
    if (item.label === label) {
      return item
    }
    if (Array.isArray(item.submenu)) {
      const found = searchForMenuItem(
        item.submenu as MenuItemConstructorOptions[],
        label,
      )
      if (found) {
        return found
      }
    }
  }
  return undefined
}

function findMenuItem(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions {
  const found = searchForMenuItem(template, label)
  if (!found) {
    throw new Error(`"${label}" menu item not found in template`)
  }
  return found
}

const CONFIG_PATH =
  '/Users/test/Library/Application Support/Streamwall/config.toml'
const LOG_PATH = '/Users/test/Library/Logs/Streamwall/main.log'

describe('buildApplicationMenuTemplate', () => {
  afterEach(() => {
    openPath.mockClear()
  })

  it('includes an "Open Config Folder" item that opens the directory containing the config path', () => {
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH)

    const item = findMenuItem(template, 'Open Config Folder')
    expect(typeof item.click).toBe('function')

    ;(item.click as () => void)()

    expect(openPath).toHaveBeenCalledWith(
      '/Users/test/Library/Application Support/Streamwall',
    )
  })

  it('works when the config file does not exist yet (first run)', () => {
    const template = buildApplicationMenuTemplate(
      '/home/test/.config/Streamwall/config.toml',
      '/home/test/.config/Streamwall/logs/main.log',
    )

    const item = findMenuItem(template, 'Open Config Folder')
    ;(item.click as () => void)()

    // openPath targets the userData directory itself, which Electron always
    // creates - unlike shell.showItemInFolder, it doesn't require config.toml
    // to already exist.
    expect(openPath).toHaveBeenCalledWith('/home/test/.config/Streamwall')
  })

  it('includes an "Open Logs Folder" item that opens the directory containing the log file', () => {
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH)

    const item = findMenuItem(template, 'Open Logs Folder')
    expect(typeof item.click).toBe('function')

    ;(item.click as () => void)()

    expect(openPath).toHaveBeenCalledWith('/Users/test/Library/Logs/Streamwall')
  })
})

describe('installApplicationMenu', () => {
  afterEach(() => {
    setApplicationMenu.mockClear()
    buildFromTemplate.mockClear()
  })

  it('builds a menu from the template and installs it as the application menu', () => {
    installApplicationMenu(CONFIG_PATH, LOG_PATH)

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledWith(
      buildFromTemplate.mock.results[0]?.value,
    )
  })
})
