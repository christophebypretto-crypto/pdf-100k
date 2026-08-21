import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  openPdf: (multi?: boolean): Promise<string[] | null> =>
    ipcRenderer.invoke('dialog:openPdf', multi),
  openPdfOrImage: (multi?: boolean): Promise<string[] | null> =>
    ipcRenderer.invoke('dialog:openPdfOrImage', multi),
  savePdf: (defaultName?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:savePdf', defaultName),
  readPdf: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('fs:readPdf', filePath),
  writePdf: (filePath: string, data: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke('fs:writePdf', filePath, data),
  showInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:showInFolder', filePath),
  imageToPdfBytes: (imagePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdf:imageToPdfBytes', imagePath),

  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  onFileOpenRequest: (callback: (path: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('app:openFile', listener)
    return () => {
      ipcRenderer.removeListener('app:openFile', listener)
    }
  },

  pdfMerge: (files: ArrayBuffer[]): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdf:merge', files),
  pdfSplit: (data: ArrayBuffer, ranges: { from: number; to: number }[]): Promise<ArrayBuffer[]> =>
    ipcRenderer.invoke('pdf:split', data, ranges),
  pdfReorder: (
    data: ArrayBuffer,
    ops: { srcIndex: number; rotate: 0 | 90 | 180 | 270 }[]
  ): Promise<ArrayBuffer> => ipcRenderer.invoke('pdf:reorder', data, ops),
  pdfInsert: (host: ArrayBuffer, ins: ArrayBuffer, atIndex: number): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdf:insert', host, ins, atIndex),
  pdfExtract: (data: ArrayBuffer, indices: number[]): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdf:extract', data, indices)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
