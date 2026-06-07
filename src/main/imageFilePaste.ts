import { app, clipboard, globalShortcut } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ClipboardSettings } from '../shared/types'
import type { ClipboardWatcher } from './clipboardWatcher'
import {
  focusWindowAndPaste,
  getForegroundWindowInfo,
  readClipboardFileDropList,
  setClipboardFileDropList,
  type ForegroundWindowInfo
} from './powershell'

const IMAGE_FILE_PASTE_SHORTCUT = 'CommandOrControl+V'
const SHORTCUT_ARM_CHECK_INTERVAL_MS = 650
const RESTORE_CLIPBOARD_DELAY_MS = 1200
const WATCHER_SUPPRESSION_MS = 2600
const SHORTCUT_RESUME_DELAY_MS = 120
const EXPORTED_IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const EXPORTED_IMAGE_MAX_COUNT = 500

interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  image: Electron.NativeImage | null
}

const EXPLORER_WINDOW_CLASSES = new Set(['CabinetWClass', 'ExploreWClass', 'Progman', 'WorkerW'])

function hasFileDropFormat(formats: string[]): boolean {
  const markers = [
    'filedrop',
    'filename',
    'file name',
    'filegroupdescriptor',
    'file group descriptor',
    'shell idlist',
    'preferred dropeffect'
  ]

  return formats.some((format) => {
    const normalized = format.toLowerCase()
    return markers.some((marker) => normalized.includes(marker))
  })
}

function isExplorerTarget(info: ForegroundWindowInfo | null): boolean {
  if (!info || info.processName.toLowerCase() !== 'explorer') {
    return false
  }
  return EXPLORER_WINDOW_CLASSES.has(info.className)
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, length = 2): string => value.toString().padStart(length, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    pad(date.getMilliseconds(), 3)
  ].join('')
}

function captureRestorableClipboard(): ClipboardSnapshot {
  const image = clipboard.readImage()
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image.isEmpty() ? null : image
  }
}

function restoreSnapshot(snapshot: ClipboardSnapshot): void {
  const payload: Electron.Data = {}
  if (snapshot.text) {
    payload.text = snapshot.text
  }
  if (snapshot.html) {
    payload.html = snapshot.html
  }
  if (snapshot.rtf) {
    payload.rtf = snapshot.rtf
  }
  if (snapshot.image && !snapshot.image.isEmpty()) {
    payload.image = snapshot.image
  }

  clipboard.clear()
  if (Object.keys(payload).length > 0) {
    clipboard.write(payload)
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function pruneExportedImages(directory: string): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(directory)
  } catch {
    return
  }

  const now = Date.now()
  const entries = (
    await Promise.all(
      names
        .filter((name) => /^clipboard-image-\d{8}-\d{6}-\d{3}-[a-f0-9-]+\.png$/i.test(name))
        .map(async (name) => {
          const absolutePath = path.join(directory, name)
          const fileStat = await stat(absolutePath).catch(() => null)
          return fileStat?.isFile() ? { name, absolutePath, mtimeMs: fileStat.mtimeMs } : null
        })
    )
  ).filter(Boolean) as Array<{ name: string; absolutePath: string; mtimeMs: number }>

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)

  await Promise.all(
    entries.map(async (entry, index) => {
      if (index >= EXPORTED_IMAGE_MAX_COUNT || now - entry.mtimeMs > EXPORTED_IMAGE_MAX_AGE_MS) {
        await rm(entry.absolutePath, { force: true })
      }
    })
  )
}

export class ImageFilePasteService {
  private registered = false
  private handling = false
  private checking = false
  private registrationFailed = false
  private monitorTimer: NodeJS.Timeout | null = null
  private resumeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly getWatcher: () => ClipboardWatcher | null,
    private readonly getSettings: () => ClipboardSettings
  ) {}

  start(): void {
    this.syncRegistration()
    void pruneExportedImages(this.getExportDirectory())
  }

  stop(): void {
    this.stopMonitor()
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    this.unregisterShortcut()
  }

  syncRegistration(): void {
    if (process.platform !== 'win32') {
      return
    }

    if (this.getSettings().imagePasteAsFileInExplorer) {
      this.startMonitor()
      void this.refreshShortcutRegistration()
    } else {
      this.stopMonitor()
      this.unregisterShortcut()
      this.registrationFailed = false
    }
  }

  hasShortcutRegistrationFailed(): boolean {
    return this.registrationFailed
  }

  private startMonitor(): void {
    if (this.monitorTimer) {
      return
    }

    this.monitorTimer = setInterval(() => {
      void this.refreshShortcutRegistration()
    }, SHORTCUT_ARM_CHECK_INTERVAL_MS)
    this.monitorTimer.unref?.()
  }

  private stopMonitor(): void {
    if (!this.monitorTimer) {
      return
    }
    clearInterval(this.monitorTimer)
    this.monitorTimer = null
  }

  private async refreshShortcutRegistration(): Promise<void> {
    if (this.checking || this.handling) {
      return
    }

    this.checking = true
    try {
      if (await this.shouldArmShortcut()) {
        this.registerShortcut()
      } else {
        this.unregisterShortcut()
      }
    } finally {
      this.checking = false
    }
  }

  private async shouldArmShortcut(): Promise<boolean> {
    if (process.platform !== 'win32' || !this.getSettings().imagePasteAsFileInExplorer) {
      return false
    }

    const image = clipboard.readImage()
    if (image.isEmpty()) {
      return false
    }

    if (hasFileDropFormat(clipboard.availableFormats())) {
      return false
    }

    return isExplorerTarget(await getForegroundWindowInfo())
  }

  private registerShortcut(): void {
    if (this.registered) {
      return
    }

    this.registered = globalShortcut.register(IMAGE_FILE_PASTE_SHORTCUT, () => {
      void this.handleCtrlV()
    })

    if (!this.registered) {
      this.registrationFailed = true
      console.warn('Failed to register Ctrl+V image file paste shortcut.')
    } else {
      this.registrationFailed = false
    }
  }

  private unregisterShortcut(): void {
    if (!this.registered) {
      return
    }
    globalShortcut.unregister(IMAGE_FILE_PASTE_SHORTCUT)
    this.registered = false
  }

  private suspendShortcutForPaste(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    this.unregisterShortcut()
  }

  private scheduleShortcutResume(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      this.syncRegistration()
    }, SHORTCUT_RESUME_DELAY_MS)
  }

  private async sendPasteWithShortcutSuspended(hwnd: string | null): Promise<boolean> {
    this.suspendShortcutForPaste()
    try {
      return await focusWindowAndPaste(hwnd)
    } finally {
      this.scheduleShortcutResume()
    }
  }

  private async handleCtrlV(): Promise<void> {
    if (this.handling) {
      return
    }

    this.handling = true
    try {
      const info = await getForegroundWindowInfo()
      const hwnd = info?.hwnd ?? null

      if (!this.getSettings().imagePasteAsFileInExplorer || !isExplorerTarget(info)) {
        await this.sendPasteWithShortcutSuspended(hwnd)
        return
      }

      const formats = clipboard.availableFormats()
      const image = clipboard.readImage()
      if (image.isEmpty()) {
        await this.sendPasteWithShortcutSuspended(hwnd)
        return
      }

      if (hasFileDropFormat(formats)) {
        const filePaths = await readClipboardFileDropList()
        if (filePaths.length > 0) {
          await this.sendPasteWithShortcutSuspended(hwnd)
          return
        }
      }

      const snapshot = captureRestorableClipboard()
      const exportedPath = await this.exportImageAsPng(image)
      this.getWatcher()?.suppressFor(WATCHER_SUPPRESSION_MS)
      await setClipboardFileDropList([exportedPath])
      await this.sendPasteWithShortcutSuspended(hwnd)

      if (this.getSettings().restoreClipboardAfterImageFilePaste) {
        this.scheduleClipboardRestore(snapshot, exportedPath)
      }
    } catch (error) {
      console.warn('Image file paste failed.', error)
      await this.sendPasteWithShortcutSuspended(null)
    } finally {
      this.handling = false
    }
  }

  private async exportImageAsPng(image: Electron.NativeImage): Promise<string> {
    const directory = this.getExportDirectory()
    await mkdir(directory, { recursive: true })
    const fileName = `clipboard-image-${formatTimestamp(new Date())}-${randomUUID().slice(0, 8)}.png`
    const absolutePath = path.join(directory, fileName)
    await writeFile(absolutePath, image.toPNG())
    void pruneExportedImages(directory)
    return absolutePath
  }

  private getExportDirectory(): string {
    return path.join(app.getPath('userData'), 'exported-images')
  }

  private scheduleClipboardRestore(snapshot: ClipboardSnapshot, exportedPath: string): void {
    setTimeout(() => {
      void this.restoreClipboardIfStillExport(snapshot, exportedPath)
    }, RESTORE_CLIPBOARD_DELAY_MS)
  }

  private async restoreClipboardIfStillExport(snapshot: ClipboardSnapshot, exportedPath: string): Promise<void> {
    const currentFilePaths = await readClipboardFileDropList()
    if (!currentFilePaths.some((filePath) => samePath(filePath, exportedPath))) {
      return
    }

    this.getWatcher()?.suppressFor(WATCHER_SUPPRESSION_MS)
    restoreSnapshot(snapshot)
  }
}
