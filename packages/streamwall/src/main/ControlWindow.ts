import { BrowserWindow, Event as ElectronEvent, ipcMain, shell } from 'electron'
import EventEmitter from 'events'
import { dirname } from 'node:path'
import path from 'path'
import { ControlCommand, StreamwallState } from 'streamwall-shared'
import { loadHTML } from './loadHTML'

export interface ControlWindowEventMap {
  load: []
  close: [ElectronEvent]
  command: [ControlCommand]
  ydoc: [Uint8Array]
}

/** Where the user data `config.toml` would live, and whether it exists yet. */
export interface ConfigInfo {
  configPath: string
  hasUserConfig: boolean
}

export default class ControlWindow extends EventEmitter<ControlWindowEventMap> {
  win: BrowserWindow

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

    ipcMain.handle('control:command', (ev, command) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      this.emit('command', command)
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
  }

  onState(state: StreamwallState) {
    this.win.webContents.send('state', state)
  }

  onYDocUpdate(update: Uint8Array) {
    this.win.webContents.send('ydoc', update)
  }
}
