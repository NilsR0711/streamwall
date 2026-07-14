import { Menu, MenuItemConstructorOptions, app, shell } from 'electron'
import { dirname } from 'node:path'

/**
 * Builds the application menu template. Its main purpose is the "Open Config
 * Folder" item: the userData config path is otherwise only ever printed via
 * `console.debug`, which is invisible to anyone running the packaged app
 * outside a terminal (#86). "Open Logs Folder" serves the same purpose for
 * the electron-log file written to the OS-standard log directory (#85).
 */
export function buildApplicationMenuTemplate(
  configPath: string,
  logPath: string,
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
): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildApplicationMenuTemplate(configPath, logPath)),
  )
}
