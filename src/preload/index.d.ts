import { ElectronAPI } from '@electron-toolkit/preload'

export interface Api {
  openPdf: (multi?: boolean) => Promise<string[] | null>
  openPdfOrImage: (multi?: boolean) => Promise<string[] | null>
  savePdf: (defaultName?: string) => Promise<string | null>
  readPdf: (filePath: string) => Promise<ArrayBuffer>
  writePdf: (filePath: string, data: ArrayBuffer) => Promise<boolean>
  showInFolder: (filePath: string) => Promise<boolean>
  imageToPdfBytes: (imagePath: string) => Promise<ArrayBuffer>
  getAppVersion: () => Promise<string>
  getPathForFile: (file: File) => string
  onFileOpenRequest: (callback: (path: string) => void) => () => void
  pdfMerge: (files: ArrayBuffer[]) => Promise<ArrayBuffer>
  pdfSplit: (
    data: ArrayBuffer,
    ranges: { from: number; to: number }[]
  ) => Promise<ArrayBuffer[]>
  pdfReorder: (
    data: ArrayBuffer,
    ops: { srcIndex: number; rotate: 0 | 90 | 180 | 270 }[]
  ) => Promise<ArrayBuffer>
  pdfInsert: (host: ArrayBuffer, ins: ArrayBuffer, atIndex: number) => Promise<ArrayBuffer>
  pdfExtract: (data: ArrayBuffer, indices: number[]) => Promise<ArrayBuffer>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
