import { BrowserWindow, Event as ElectronEvent, ipcMain, shell } from 'electron'
import EventEmitter from 'events'
import { dirname } from 'node:path'
import path from 'path'
import { ControlCommand, StreamwallState } from 'streamwall-shared'
import { type UpdateStatus } from '../updateStatus'
import { type ControlCommandResult } from './commandDispatch'
import { createExampleConfig } from './exampleConfig'
import { loadHTML } from './loadHTML'
import log from './logger'
import { secureAppWindow } from './navigationSecurity'

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

    // Pin the window to the bundled control UI. The sidebar lists
    // operator-supplied stream URLs, and a click on one must not be able to
    // carry this webContents -- which holds the `streamwallControl` bridge and
    // satisfies every `control:*` sender guard -- onto remote content (#732).
    secureAppWindow(this.win.webContents, (url) => {
      shell.openExternal(url).catch((err) => {
        log.warn('error opening external link', err)
      })
    })

    this.win.on('close', (event) => this.emit('close', event))

    // A superseded load rejects with ERR_ABORTED; log it so it leaves a
    // breadcrumb instead of an unhandled promise rejection (issue #392/#626).
    loadHTML(this.win.webContents, 'control').catch((err) => {
      log.warn('error loading control window', err)
    })

    this.handleFromControlWindow('control:load', () => {
      this.emit('load')
    })

    this.handleFromControlWindow('control:devtools', () => {
      this.win.webContents.openDevTools()
    })

    this.handleFromControlWindow('control:command', async (_ev, command) => {
      if (!this.commandHandler) {
        return
      }
      return this.commandHandler(command)
    })

    this.handleFromControlWindow('control:ydoc', (_ev, update) => {
      this.emit('ydoc', update)
    })

    this.handleFromControlWindow('control:first-run-info', () => configInfo)

    this.handleFromControlWindow('control:open-config-folder', () => {
      shell.openPath(dirname(configInfo.configPath))
    })

    this.handleFromControlWindow('control:create-example-config', () => {
      // Lets a write failure (e.g. a file that raced into existence since
      // hasUserConfig was checked) reject the renderer's invoke() call
      // rather than being swallowed (#246).
      createExampleConfig(configInfo.configPath)
    })

    this.handleFromControlWindow('control:update-status', () => {
      // The renderer may mount after the updater already moved past `idle`,
      // so it pulls the current status once instead of only listening for
      // future transitions.
      return this.updateHandlers?.getStatus() ?? { state: 'idle' }
    })

    this.handleFromControlWindow(
      'control:app-version',
      () => this.updateHandlers?.getAppVersion() ?? '',
    )

    this.handleFromControlWindow('control:download-update', () => {
      this.updateHandlers?.download()
    })

    this.handleFromControlWindow('control:install-update', () => {
      this.updateHandlers?.install()
    })

    this.handleFromControlWindow('control:open-release-notes', () => {
      // Deliberately takes no URL from the renderer: main owns the updater
      // status, so a compromised renderer cannot turn this into an
      // open-anything shell.openExternal gadget.
      this.updateHandlers?.openReleaseNotes()
    })
  }

  /**
   * Registers an `ipcMain.handle` listener that only runs for invocations from
   * this window's own webContents. `ipcMain` is process-global, so without the
   * sender check any renderer in the process could reach these channels; making
   * the guard part of the registration means a newly added channel cannot
   * forget it (#736).
   */
  private handleFromControlWindow(
    channel: string,
    listener: Parameters<typeof ipcMain.handle>[1],
  ) {
    ipcMain.handle(channel, (ev, ...args) => {
      if (ev.sender !== this.win.webContents) {
        return
      }
      return listener(ev, ...args)
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
