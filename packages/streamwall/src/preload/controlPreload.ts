import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { StreamwallState } from 'streamwall-shared'
import { type UpdateStatus } from '../updateStatus'
import './sentryPreload'

export interface FirstRunInfo {
  configPath: string
  hasUserConfig: boolean
}

const api = {
  load: () => ipcRenderer.invoke('control:load'),
  openDevTools: () => ipcRenderer.invoke('control:devtools'),
  invokeCommand: (msg: object) => ipcRenderer.invoke('control:command', msg),
  updateYDoc: (update: Uint8Array) =>
    ipcRenderer.invoke('control:ydoc', update),
  getFirstRunInfo: (): Promise<FirstRunInfo> =>
    ipcRenderer.invoke('control:first-run-info'),
  openConfigFolder: () => ipcRenderer.invoke('control:open-config-folder'),
  createExampleConfig: (): Promise<void> =>
    ipcRenderer.invoke('control:create-example-config'),
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('control:app-version'),
  getUpdateStatus: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('control:update-status'),
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke('control:install-update'),
  // Takes no URL: main opens the release page for the update it actually
  // downloaded, so the renderer cannot steer shell.openExternal.
  openReleaseNotes: (): Promise<void> =>
    ipcRenderer.invoke('control:open-release-notes'),
  onUpdateStatus: (handleStatus: (status: UpdateStatus) => void) => {
    const internalHandler = (_ev: IpcRendererEvent, status: UpdateStatus) =>
      handleStatus(status)
    ipcRenderer.on('update-status', internalHandler)
    return () => {
      ipcRenderer.off('update-status', internalHandler)
    }
  },
  onState: (handleState: (state: StreamwallState) => void) => {
    const internalHandler = (_ev: IpcRendererEvent, state: StreamwallState) =>
      handleState(state)
    ipcRenderer.on('state', internalHandler)
    return () => {
      ipcRenderer.off('state', internalHandler)
    }
  },
  onYDoc: (handleUpdate: (update: Uint8Array) => void) => {
    const internalHandler = (_ev: IpcRendererEvent, update: Uint8Array) =>
      handleUpdate(update)
    ipcRenderer.on('ydoc', internalHandler)
    return () => {
      ipcRenderer.off('ydoc', internalHandler)
    }
  },
}

export type StreamwallControlGlobal = typeof api

contextBridge.exposeInMainWorld('streamwallControl', api)
