import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ClipboardHistoryItem, ClipboardSettings } from '../shared/types'

export interface PendingBlob {
  key: string
  extension: string
  buffer: Buffer
}

export interface PendingHistoryItem {
  kind: ClipboardHistoryItem['kind']
  formats: string[]
  title: string
  preview?: string
  text?: string
  filePaths?: string[]
  hash: string
  truncated: boolean
  blobs: PendingBlob[]
}

const MAX_ITEMS = 500
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024

const DEFAULT_SETTINGS: ClipboardSettings = {
  launchAtLogin: true,
  imagePasteAsFileInExplorer: true,
  restoreClipboardAfterImageFilePaste: true
}

function safeBlobName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90)
}

function serializeJson<T>(value: T): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export class HistoryStore {
  private readonly rootDir: string
  private readonly blobsDir: string
  private readonly historyPath: string
  private readonly settingsPath: string
  private items: ClipboardHistoryItem[] = []
  private settings: ClipboardSettings = DEFAULT_SETTINGS

  constructor(rootDir = app.getPath('userData')) {
    this.rootDir = rootDir
    this.blobsDir = path.join(rootDir, 'blobs')
    this.historyPath = path.join(rootDir, 'history.json')
    this.settingsPath = path.join(rootDir, 'settings.json')
  }

  getRootDir(): string {
    return this.rootDir
  }

  getBlobsDir(): string {
    return this.blobsDir
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true })
    await this.loadHistory()
    await this.loadSettings()
    await this.prune()
    await this.saveHistory()
  }

  list(): ClipboardHistoryItem[] {
    return [...this.items]
  }

  getSettings(): ClipboardSettings {
    return { ...this.settings }
  }

  async updateSettings(patch: Partial<ClipboardSettings>): Promise<ClipboardSettings> {
    this.settings = {
      ...this.settings,
      ...patch
    }
    await writeFile(this.settingsPath, serializeJson(this.settings), 'utf8')
    return this.getSettings()
  }

  async add(pending: PendingHistoryItem): Promise<ClipboardHistoryItem | null> {
    if (this.items[0]?.hash === pending.hash) {
      return null
    }

    const duplicateIndex = this.items.findIndex((item) => item.hash === pending.hash)
    if (duplicateIndex >= 0) {
      const [duplicate] = this.items.splice(duplicateIndex, 1)
      duplicate.createdAt = new Date().toISOString()
      this.items.unshift(duplicate)
      await this.saveHistory()
      return duplicate
    }

    const id = randomUUID()
    const blobRefs: Record<string, string> = {}
    let sizeBytes = Buffer.byteLength(pending.text ?? '', 'utf8')

    for (const blob of pending.blobs) {
      const fileName = `${id}_${safeBlobName(blob.key)}${blob.extension}`
      const absolutePath = path.join(this.blobsDir, fileName)
      await writeFile(absolutePath, blob.buffer)
      blobRefs[blob.key] = `blobs/${fileName}`
      sizeBytes += blob.buffer.byteLength
    }

    const item: ClipboardHistoryItem = {
      id,
      createdAt: new Date().toISOString(),
      kind: pending.kind,
      formats: pending.formats,
      title: pending.title,
      preview: pending.preview,
      text: pending.text,
      filePaths: pending.filePaths,
      blobRefs,
      sizeBytes,
      hash: pending.hash,
      truncated: pending.truncated
    }

    this.items.unshift(item)
    await this.prune()
    await this.saveHistory()
    return item
  }

  async get(id: string): Promise<ClipboardHistoryItem | null> {
    return this.items.find((item) => item.id === id) ?? null
  }

  async readBlob(item: ClipboardHistoryItem, key: string): Promise<Buffer | null> {
    const relativePath = item.blobRefs[key]
    if (!relativePath) {
      return null
    }

    const absolutePath = this.resolveBlobRef(relativePath)
    if (!absolutePath) {
      return null
    }

    try {
      return await readFile(absolutePath)
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<void> {
    const item = await this.get(id)
    this.items = this.items.filter((entry) => entry.id !== id)
    if (item) {
      await this.deleteItemBlobs(item)
    }
    await this.saveHistory()
  }

  async clear(): Promise<void> {
    this.items = []
    await rm(this.blobsDir, { recursive: true, force: true })
    await mkdir(this.blobsDir, { recursive: true })
    await this.saveHistory()
  }

  resolveBlobRef(relativePath: string): string | null {
    const normalized = relativePath.replaceAll('/', path.sep)
    const absolutePath = path.resolve(this.rootDir, normalized)
    const root = path.resolve(this.rootDir)
    const relative = path.relative(root, absolutePath)
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? absolutePath : null
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = await readFile(this.historyPath, 'utf8')
      const parsed = JSON.parse(raw) as ClipboardHistoryItem[]
      this.items = Array.isArray(parsed) ? parsed : []
    } catch {
      this.items = []
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...(JSON.parse(raw) as Partial<ClipboardSettings>)
      }
    } catch {
      this.settings = DEFAULT_SETTINGS
      await writeFile(this.settingsPath, serializeJson(this.settings), 'utf8')
    }
  }

  private async saveHistory(): Promise<void> {
    await writeFile(this.historyPath, serializeJson(this.items), 'utf8')
  }

  private async prune(): Promise<void> {
    const cutoff = Date.now() - MAX_AGE_MS
    const retained: ClipboardHistoryItem[] = []
    const removed: ClipboardHistoryItem[] = []

    for (const item of this.items) {
      if (retained.length >= MAX_ITEMS || new Date(item.createdAt).getTime() < cutoff) {
        removed.push(item)
      } else {
        retained.push(item)
      }
    }

    let totalBytes = retained.reduce((sum, item) => sum + item.sizeBytes, 0)
    while (retained.length > 0 && totalBytes > MAX_STORAGE_BYTES) {
      const oldest = retained.pop()
      if (!oldest) {
        break
      }
      totalBytes -= oldest.sizeBytes
      removed.push(oldest)
    }

    this.items = retained
    await Promise.all(removed.map((item) => this.deleteItemBlobs(item)))
    await this.deleteOrphanedBlobs()
  }

  private async deleteItemBlobs(item: ClipboardHistoryItem): Promise<void> {
    await Promise.all(
      Object.values(item.blobRefs).map(async (relativePath) => {
        const absolutePath = this.resolveBlobRef(relativePath)
        if (absolutePath) {
          await rm(absolutePath, { force: true })
        }
      })
    )
  }

  private async deleteOrphanedBlobs(): Promise<void> {
    let files: string[] = []
    try {
      files = await readdir(this.blobsDir)
    } catch {
      return
    }

    const referenced = new Set(
      this.items.flatMap((item) =>
        Object.values(item.blobRefs).map((relativePath) => path.basename(relativePath))
      )
    )

    await Promise.all(
      files.map(async (fileName) => {
        if (!referenced.has(fileName)) {
          const absolutePath = path.join(this.blobsDir, fileName)
          const fileStat = await stat(absolutePath).catch(() => null)
          if (fileStat?.isFile()) {
            await rm(absolutePath, { force: true })
          }
        }
      })
    )
  }
}
