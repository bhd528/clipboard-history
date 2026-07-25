import { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, protocol, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ClipboardHistoryItem, ClipboardSettings, RestoreResult } from '../shared/types'
import { ClipboardWatcher, createImageFromBlob } from './clipboardWatcher'
import { HistoryStore } from './historyStore'
import { ImageFilePasteService } from './imageFilePaste'
import { focusWindowAndPaste, getForegroundWindowHandle, setClipboardFileDropList } from './powershell'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cliphist',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
const PASTE_SUPPRESSION_MS = 1800
const THUMBNAIL_EDGE_PX = 96

app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let store: HistoryStore
let watcher: ClipboardWatcher
let imageFilePasteService: ImageFilePasteService | null = null
let isQuitting = false
let lastForegroundWindow: string | null = null
let backgroundServicesTimer: NodeJS.Timeout | null = null
const thumbnailCache = new Map<string, string | null>()

function createTrayIcon(): Electron.NativeImage {
  const size = 32
  const channels = 4
  const bitmap = Buffer.alloc(size * size * channels)

  const setPixel = (x: number, y: number, r: number, g: number, b: number, a = 255): void => {
    const index = (y * size + x) * channels
    bitmap[index] = b
    bitmap[index + 1] = g
    bitmap[index + 2] = r
    bitmap[index + 3] = a
  }

  const fillRect = (left: number, top: number, width: number, height: number, color: [number, number, number]): void => {
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        setPixel(x, y, color[0], color[1], color[2])
      }
    }
  }

  const fillRoundedRect = (
    left: number,
    top: number,
    width: number,
    height: number,
    radius: number,
    color: [number, number, number]
  ): void => {
    const right = left + width - 1
    const bottom = top + height - 1

    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x < left + radius ? left + radius - x : x > right - radius ? x - (right - radius) : 0
        const dy = y < top + radius ? top + radius - y : y > bottom - radius ? y - (bottom - radius) : 0
        if (dx * dx + dy * dy <= radius * radius) {
          setPixel(x, y, color[0], color[1], color[2])
        }
      }
    }
  }

  fillRoundedRect(2, 2, 28, 28, 7, [31, 41, 55])
  fillRoundedRect(5, 6, 22, 22, 5, [37, 99, 235])
  fillRoundedRect(10, 3, 12, 8, 3, [20, 184, 166])
  fillRect(11, 14, 11, 2, [255, 255, 255])
  fillRect(11, 19, 9, 2, [255, 255, 255])
  fillRect(11, 24, 7, 2, [255, 255, 255])

  const image = nativeImage.createFromBitmap(bitmap, {
    width: size,
    height: size,
    scaleFactor: 1
  })
  image.setTemplateImage(false)
  return image.resize({ width: 16, height: 16 })
}

function applyLoginSetting(settings: ClipboardSettings): void {
  const loginItemPath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath

  if (isDev) {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: process.execPath
    })
    return
  }

  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    path: loginItemPath
  })
}

function buildTrayMenu(): void {
  if (!tray) {
    return
  }

  const settings = store.getSettings()
  const imagePasteShortcutUnavailable =
    settings.imagePasteAsFileInExplorer && imageFilePasteService?.hasShortcutRegistrationFailed()
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Clipboard History',
      click: () => {
        void showHistoryWindow()
      }
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: async (item) => {
        const updated = await store.updateSettings({ launchAtLogin: item.checked })
        applyLoginSetting(updated)
        buildTrayMenu()
      }
    },
    {
      label: imagePasteShortcutUnavailable ? '资源管理器 Ctrl+V 图片转 PNG（快捷键不可用）' : '资源管理器 Ctrl+V 图片转 PNG',
      type: 'checkbox',
      checked: settings.imagePasteAsFileInExplorer,
      click: async (item) => {
        await store.updateSettings({ imagePasteAsFileInExplorer: item.checked })
        imageFilePasteService?.syncRegistration()
        buildTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: '清空历史',
      click: async () => {
        await store.clear()
        notifyHistoryUpdated()
      }
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)
}

function notifyHistoryUpdated(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history-updated')
  }
}

async function createThumbnailDataUrl(item: ClipboardHistoryItem): Promise<string | undefined> {
  const imageRef = item.blobRefs['image/png']
  if (!imageRef) {
    return undefined
  }

  const cacheKey = `${item.id}:${item.hash}:${imageRef}`
  if (thumbnailCache.has(cacheKey)) {
    return thumbnailCache.get(cacheKey) ?? undefined
  }

  try {
    const imageBuffer = await store.readBlob(item, 'image/png')
    if (!imageBuffer) {
      thumbnailCache.set(cacheKey, null)
      return undefined
    }

    const image = nativeImage.createFromBuffer(imageBuffer)
    if (image.isEmpty()) {
      thumbnailCache.set(cacheKey, null)
      return undefined
    }

    const size = image.getSize()
    const thumbnail =
      size.width >= size.height
        ? image.resize({ width: THUMBNAIL_EDGE_PX, quality: 'best' })
        : image.resize({ height: THUMBNAIL_EDGE_PX, quality: 'best' })
    const dataUrl = `data:image/png;base64,${thumbnail.toPNG().toString('base64')}`
    thumbnailCache.set(cacheKey, dataUrl)
    return dataUrl
  } catch {
    thumbnailCache.set(cacheKey, null)
    return undefined
  }
}

async function listHistoryForRenderer(): Promise<ClipboardHistoryItem[]> {
  const items = store.list()
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      thumbnailDataUrl: await createThumbnailDataUrl(item)
    }))
  )
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 780,
    minHeight: 520,
    show: false,
    title: 'Clipboard History',
    backgroundColor: '#f7f7f4',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      destroyHistoryWindow()
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

function destroyHistoryWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.destroy()
}

async function showHistoryWindow(): Promise<void> {
  const activeWindow = await getForegroundWindowHandle()
  if (activeWindow) {
    lastForegroundWindow = activeWindow
  }

  if (!mainWindow) {
    mainWindow = createMainWindow()
  }

  if (mainWindow.webContents.isLoading()) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show()
      mainWindow?.focus()
      notifyHistoryUpdated()
    })
    return
  }

  mainWindow.show()
  mainWindow.focus()
  notifyHistoryUpdated()
}

async function restoreItemToClipboard(id: string): Promise<RestoreResult> {
  const item = await store.get(id)
  if (!item) {
    return { ok: false, pasted: false, error: '找不到这条历史记录。' }
  }

  watcher.suppressFor(PASTE_SUPPRESSION_MS)
  clipboard.clear()

  if (item.filePaths?.length) {
    await setClipboardFileDropList(item.filePaths)
  } else {
    const html = await store.readBlob(item, 'text/html')
    const rtf = await store.readBlob(item, 'text/rtf')
    const image = await store.readBlob(item, 'image/png')

    const payload: Electron.Data = {}
    if (item.text) {
      payload.text = item.text
    }
    if (html) {
      payload.html = html.toString('utf8')
    }
    if (rtf) {
      payload.rtf = rtf.toString('utf8')
    }
    if (image) {
      payload.image = createImageFromBlob(image)
    }
    if (Object.keys(payload).length > 0) {
      clipboard.write(payload)
    }

    for (const [key, relativePath] of Object.entries(item.blobRefs)) {
      if (!key.startsWith('raw:')) {
        continue
      }
      const absolutePath = store.resolveBlobRef(relativePath)
      if (!absolutePath) {
        continue
      }
      const raw = await store.readBlob(item, key)
      if (raw) {
        clipboard.writeBuffer(key.slice(4), raw)
      }
    }
  }

  const pasted = await focusWindowAndPaste(lastForegroundWindow)
  return { ok: true, pasted }
}

function registerIpc(): void {
  ipcMain.handle('history:list', () => listHistoryForRenderer())
  ipcMain.handle('history:restoreAndPaste', async (_event, id: string) => restoreItemToClipboard(id))
  ipcMain.handle('history:delete', async (_event, id: string) => {
    await store.delete(id)
    thumbnailCache.clear()
  })
  ipcMain.handle('history:clear', async () => {
    await store.clear()
    thumbnailCache.clear()
  })
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:update', async (_event, patch: Partial<ClipboardSettings>) => {
    const updated = await store.updateSettings(patch)
    applyLoginSetting(updated)
    buildTrayMenu()
    return updated
  })
  ipcMain.handle('app:openUserData', async () => {
    await shell.openPath(store.getRootDir())
  })
}

function registerBlobProtocol(): void {
  protocol.handle('cliphist', async (request) => {
    const url = new URL(request.url)
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const absolutePath = store.resolveBlobRef(relativePath)
    if (!absolutePath) {
      return new Response('Not found', { status: 404 })
    }

    try {
      const buffer = await readFile(absolutePath)
      const extension = path.extname(absolutePath).toLowerCase()
      const contentType =
        extension === '.png'
          ? 'image/png'
          : extension === '.jpg' || extension === '.jpeg'
            ? 'image/jpeg'
            : extension === '.html'
              ? 'text/html; charset=utf-8'
              : extension === '.rtf'
                ? 'application/rtf'
                : 'application/octet-stream'

      return new Response(buffer, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) {
      void showHistoryWindow()
    }
  })

  app.whenReady().then(async () => {
    store = new HistoryStore()
    await store.init()
    applyLoginSetting(store.getSettings())

    registerBlobProtocol()
    registerIpc()

    watcher = new ClipboardWatcher(store, notifyHistoryUpdated)
    imageFilePasteService = new ImageFilePasteService(() => watcher ?? null, () => store.getSettings())

    tray = new Tray(createTrayIcon())
    tray.setToolTip('Clipboard History')
    tray.on('click', () => {
      void showHistoryWindow()
    })

    globalShortcut.register('CommandOrControl+Alt+V', () => {
      void showHistoryWindow()
    })

    buildTrayMenu()

    // Keep the tray responsive immediately after launch. The two background
    // services can synchronously inspect the clipboard (and, for Explorer
    // image pasting, start a PowerShell query), which otherwise competes with
    // the first native tray-menu interaction on Windows.
    backgroundServicesTimer = setTimeout(() => {
      backgroundServicesTimer = null
      imageFilePasteService?.start()
      watcher.start()
    }, 750)
    backgroundServicesTimer.unref?.()
  })
}

app.on('window-all-closed', () => {
  // Keep the tray app alive after the history window is closed.
})

app.on('before-quit', () => {
  isQuitting = true
  if (backgroundServicesTimer) {
    clearTimeout(backgroundServicesTimer)
    backgroundServicesTimer = null
  }
  imageFilePasteService?.stop()
  watcher?.stop()
  globalShortcut.unregisterAll()
})
