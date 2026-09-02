import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { StreamwallState } from 'streamwall-shared'
import './sentryPreload'

const api = {
  openDevTools: () => ipcRenderer.send('devtools-overlay'),
  load: () => ipcRenderer.invoke('layer:load'),
  onState: (handleState: (state: StreamwallState) => void) => {
    const internalHandler = (_ev: IpcRendererEvent, state: StreamwallState) =>
      handleState(state)
    ipcRenderer.on('state', internalHandler)
    return () => {
      ipcRenderer.off('state', internalHandler)
    }
  },
  /**
   * URLs this layer's session refused to fetch. The SSRF request guard cancels
   * them at the network layer, which the layer would otherwise experience only
   * as an iframe that never paints (#790).
   */
  onBlockedURL: (handleBlocked: (url: string) => void) => {
    const internalHandler = (_ev: IpcRendererEvent, url: string) =>
      handleBlocked(url)
    ipcRenderer.on('layer:blocked-url', internalHandler)
    return () => {
      ipcRenderer.off('layer:blocked-url', internalHandler)
    }
  },
}

export type StreamwallLayerGlobal = typeof api

contextBridge.exposeInMainWorld('streamwallLayer', api)
