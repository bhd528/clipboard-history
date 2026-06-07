import { contextBridge, ipcRenderer } from 'electron'
import type { ClipboardHistoryItem, ClipboardSettings, RestoreResult } from '../shared/types'

const api = {
  listHistory: (): Promise<ClipboardHistoryItem[]> => ipcRenderer.invoke('history:list'),
  restoreAndPaste: (id: string): Promise<RestoreResult> => ipcRenderer.invoke('history:restoreAndPaste', id),
  deleteHistory: (id: string): Promise<void> => ipcRenderer.invoke('history:delete', id),
  clearHistory: (): Promise<void> => ipcRenderer.invoke('history:clear'),
  getSettings: (): Promise<ClipboardSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<ClipboardSettings>): Promise<ClipboardSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  openUserData: (): Promise<void> => ipcRenderer.invoke('app:openUserData'),
  onHistoryUpdated: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('history-updated', listener)
    return () => ipcRenderer.off('history-updated', listener)
  }
}

contextBridge.exposeInMainWorld('clipboardHistory', api)

export type ClipboardHistoryApi = typeof api
