export type ClipboardKind = 'text' | 'rich-text' | 'image' | 'files' | 'mixed' | 'unknown'

export interface ClipboardHistoryItem {
  id: string
  createdAt: string
  kind: ClipboardKind
  formats: string[]
  title: string
  preview?: string
  thumbnailDataUrl?: string
  text?: string
  filePaths?: string[]
  blobRefs: Record<string, string>
  sizeBytes: number
  hash: string
  truncated: boolean
}

export interface ClipboardSettings {
  launchAtLogin: boolean
  imagePasteAsFileInExplorer: boolean
  restoreClipboardAfterImageFilePaste: boolean
}

export type ClipboardFilter = 'all' | ClipboardKind

export interface RestoreResult {
  ok: boolean
  pasted: boolean
  error?: string
}
