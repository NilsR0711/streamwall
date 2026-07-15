import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import log from './logger'

const setApplicationMenu = vi.fn()
const buildFromTemplate = vi.fn((template: MenuItemConstructorOptions[]) => ({
  __template: template,
}))
const openPath = vi.fn()
const showMessageBoxSync = vi.fn()
const showErrorBox = vi.fn()

vi.mock('electron', () => ({
  Menu: { setApplicationMenu, buildFromTemplate },
  shell: { openPath },
  dialog: { showMessageBoxSync, showErrorBox },
  app: { name: 'Streamwall' },
}))

const createExampleConfig = vi.fn()
vi.mock('./exampleConfig', () => ({ createExampleConfig }))

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
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH, true)

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
      false,
    )

    const item = findMenuItem(template, 'Open Config Folder')
    ;(item.click as () => void)()

    // openPath targets the userData directory itself, which Electron always
    // creates - unlike shell.showItemInFolder, it doesn't require config.toml
    // to already exist.
    expect(openPath).toHaveBeenCalledWith('/home/test/.config/Streamwall')
  })

  it('includes an "Open Logs Folder" item that opens the directory containing the log file', () => {
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH, true)

    const item = findMenuItem(template, 'Open Logs Folder')
    expect(typeof item.click).toBe('function')

    ;(item.click as () => void)()

    expect(openPath).toHaveBeenCalledWith('/Users/test/Library/Logs/Streamwall')
  })
})

describe('buildApplicationMenuTemplate "Create Example Config" item', () => {
  afterEach(() => {
    createExampleConfig.mockReset()
    showMessageBoxSync.mockClear()
    showErrorBox.mockClear()
    vi.restoreAllMocks()
  })

  it('is offered when no config.toml exists yet', () => {
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH, false)

    expect(searchForMenuItem(template, 'Create Example Config')).toBeDefined()
  })

  it('is not offered once a user config already exists, matching the hasUserConfig gating used elsewhere (#246)', () => {
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH, true)

    expect(searchForMenuItem(template, 'Create Example Config')).toBeUndefined()
  })

  it('writes the example config to the config path and confirms success', () => {
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH, false)

    const item = findMenuItem(template, 'Create Example Config')
    ;(item.click as () => void)()

    expect(createExampleConfig).toHaveBeenCalledWith(CONFIG_PATH)
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(showErrorBox).not.toHaveBeenCalled()
  })

  it('fails loud with an error dialog instead of silently ignoring a write failure (e.g. a race left a file there)', () => {
    const err = new Error('EEXIST: file already exists')
    createExampleConfig.mockImplementationOnce(() => {
      throw err
    })
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log)
    const template = buildApplicationMenuTemplate(CONFIG_PATH, LOG_PATH, false)

    const item = findMenuItem(template, 'Create Example Config')
    ;(item.click as () => void)()

    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(showMessageBoxSync).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to create example config',
      err,
    )
  })
})

describe('installApplicationMenu', () => {
  afterEach(() => {
    setApplicationMenu.mockClear()
    buildFromTemplate.mockClear()
  })

  it('builds a menu from the template and installs it as the application menu', () => {
    installApplicationMenu(CONFIG_PATH, LOG_PATH, true)

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledWith(
      buildFromTemplate.mock.results[0]?.value,
    )
  })
})
