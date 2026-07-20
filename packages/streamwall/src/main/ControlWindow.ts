import { BrowserWindow, Event as ElectronEvent, ipcMain, shell } from 'electron'
import EventEmitter from 'events'
import { dirname } from 'node:path'
import path from 'path'
import { ControlCommand, StreamwallState } from 'streamwall-shared'
import { type UpdateStatus } from '../updateStatus'
import { type ControlCommandResult } from './commandDispatch'
import { createExampleConfig } from './exampleConfig'
import { loadHTML } from './loadHTML'

export type ControlCommandHandler = (
  command: ControlCommand,
) => Promise<void | ControlCommandResult>

export interface ControlWindowEventMap {
  load: []
  close: [ElectronEvent]
  ydoc: [Uint8Array]
}

/**
 * How the control window reaches the app updater (#381). Kept as a handler
 * bundle rather than a constructor argument so ControlWindow stays independent
 * of the updater's lifetime, matching `setCommandHandler`.
 */
export interface UpdateHandlers {
  getAppVersion: () => string
  getStatus: () => UpdateStatus
  download: () => void
  install: () => void
  openReleaseNotes: () => void
}

/** Where the user data `config.toml` would live, and whether it exists yet. */
export interface ConfigInfo {
  configPath: string
  hasUserConfig: boolean
}

export default class ControlWindow extends EventEmitter<ControlWindowEventMap> {
  win: BrowserWindow
  private commandHandler?: ControlCommandHandler
  private updateHandlers?: UpdateHandlers

  constructor(configInfo: ConfigInfo) {
    super()

    this.win = new BrowserWindow({
      title: 'Streamwall Control',
      width: 1280,
      height: 1024,
      webPreferences: {
        preload: path.join(__dirname, 'controlPreload.js'),
      },
    })
    // Deliberately keeps the window menu (unlike StreamWindow, which stays
    // menu-free for clean capture): on Windows/Linux this is what surfaces
    // the app-level "Open Config Folder" item (#86).

    this.win.on('close', (event) => this.emit('close', event))

    loadHTML(this.win.webContents, 'control')

    ipcMain.handle('control:load', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      this.emit('load')
    })

    ipcMain.handle('control:devtools', () => {
      this.win.webContents.openDevTools()
    })

    ipcMain.handle('control:command', async (ev, command) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      if (!this.commandHandler) {
        return
      }
      return this.commandHandler(command)
    })

    ipcMain.handle('control:ydoc', (ev, update) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      this.emit('ydoc', update)
    })

    ipcMain.handle('control:first-run-info', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      return configInfo
    })

    ipcMain.handle('control:open-config-folder', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      shell.openPath(dirname(configInfo.configPath))
    })

    ipcMain.handle('control:create-example-config', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      // Lets a write failure (e.g. a file that raced into existence since
      // hasUserConfig was checked) reject the renderer's invoke() call
      // rather than being swallowed (#246).
      createExampleConfig(configInfo.configPath)
    })

    ipcMain.handle('control:update-status', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      // The renderer may mount after the updater already moved past `idle`,
      // so it pulls the current status once instead of only listening for
      // future transitions.
      return this.updateHandlers?.getStatus() ?? { state: 'idle' }
    })

    ipcMain.handle('control:app-version', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      return this.updateHandlers?.getAppVersion() ?? ''
    })

    ipcMain.handle('control:download-update', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      this.updateHandlers?.download()
    })

    ipcMain.handle('control:install-update', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      this.updateHandlers?.install()
    })

    ipcMain.handle('control:open-release-notes', (ev) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      // Deliberately takes no URL from the renderer: main owns the updater
      // status, so a compromised renderer cannot turn this into an
      // open-anything shell.openExternal gadget.
      this.updateHandlers?.openReleaseNotes()
    })
  }

  setCommandHandler(handler: ControlCommandHandler) {
    this.commandHandler = handler
  }

  setUpdateHandlers(handlers: UpdateHandlers) {
    this.updateHandlers = handlers
  }

  onUpdateStatus(status: UpdateStatus) {
    this.win.webContents.send('update-status', status)
  }

  onState(state: StreamwallState) {
    this.win.webContents.send('state', state)
  }

  onYDocUpdate(update: Uint8Array) {
    this.win.webContents.send('ydoc', update)
  }
}
