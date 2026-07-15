import { Menu, MenuItemConstructorOptions, app, dialog, shell } from 'electron'
import { dirname } from 'node:path'
import { createExampleConfig } from './exampleConfig'
import log from './logger'

/**
 * Builds the application menu template. Its main purpose is the "Open Config
 * Folder" item: the userData config path is otherwise only ever printed via
 * `console.debug`, which is invisible to anyone running the packaged app
 * outside a terminal (#86). "Open Logs Folder" serves the same purpose for
 * the electron-log file written to the OS-standard log directory (#85).
 * "Create Example Config" gives a first-time user a working starting point
 * instead of an empty file they have to author from scratch (#246).
 */
export function buildApplicationMenuTemplate(
  configPath: string,
  logPath: string,
  hasUserConfig: boolean,
): MenuItemConstructorOptions[] {
  const openConfigFolder = () => {
    // Targets the userData directory itself (not the config file), since
    // Electron always creates that directory - unlike
    // shell.showItemInFolder, this works even before config.toml exists.
    shell.openPath(dirname(configPath))
  }
  const openLogsFolder = () => {
    shell.openPath(dirname(logPath))
  }
  const createExampleConfigAction = () => {
    try {
      createExampleConfig(configPath)
      dialog.showMessageBoxSync({
        type: 'info',
        message: 'Example config created',
        detail: `Wrote an example config to ${configPath}. Restart Streamwall to use it.`,
      })
    } catch (err) {
      // Write failures (e.g. a file that raced into existence since
      // hasUserConfig was checked) fail loud rather than being silently
      // ignored or clobbering what's there (#246).
      log.error('Failed to create example config', err)
      dialog.showErrorBox(
        'Could not create example config',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  const template: MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
    })
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'Open Config Folder', click: openConfigFolder },
      { label: 'Open Logs Folder', click: openLogsFolder },
      ...(hasUserConfig
        ? []
        : ([
            {
              label: 'Create Example Config',
              click: createExampleConfigAction,
            },
          ] as MenuItemConstructorOptions[])),
      ...(process.platform === 'darwin'
        ? []
        : ([
            { type: 'separator' },
            { role: 'quit' },
          ] as MenuItemConstructorOptions[])),
    ],
  })

  return template
}

export function installApplicationMenu(
  configPath: string,
  logPath: string,
  hasUserConfig: boolean,
): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate(configPath, logPath, hasUserConfig),
    ),
  )
}
