import { clipboard, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import type { ClipboardKind } from '../shared/types'
import type { HistoryStore, PendingBlob, PendingHistoryItem } from './historyStore'
import { readClipboardFileDropList } from './powershell'

const POLL_INTERVAL_MS = 1000
const MAX_ITEM_PAYLOAD_BYTES = 25 * 1024 * 1024
const MAX_TEXT_BYTES = 25 * 1024 * 1024
const PREVIEW_LENGTH = 240

const CORE_FORMAT_KEYS = new Set([
  'text/plain',
  'text/html',
  'text/rtf',
  'image/png',
  'image/jpeg',
  'FileDrop'
])

function bufferHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function textPreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH)
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function extensionForFormat(format: string): string {
  if (format.includes('html')) {
    return '.html'
  }
  if (format.includes('rtf')) {
    return '.rtf'
  }
  if (format.includes('png')) {
    return '.png'
  }
  if (format.includes('jpeg') || format.includes('jpg')) {
    return '.jpg'
  }
  return '.bin'
}

function isFileDropCandidate(formats: string[]): boolean {
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

function determineKind(options: {
  text: string
  html: string
  rtf: string
  hasImage: boolean
  hasFiles: boolean
  rawCount: number
}): ClipboardKind {
  const kinds = new Set<ClipboardKind>()
  if (options.hasFiles) {
    kinds.add('files')
  }
  if (options.hasImage) {
    kinds.add('image')
  }
  if (options.html || options.rtf) {
    kinds.add('rich-text')
  } else if (options.text) {
    kinds.add('text')
  }
  if (options.rawCount > 0 && kinds.size === 0) {
    kinds.add('unknown')
  }
  if (kinds.size > 1) {
    return 'mixed'
  }
  return [...kinds][0] ?? 'unknown'
}

function buildTitle(kind: ClipboardKind, data: {
  text: string
  html: string
  rtf: string
  filePaths: string[]
  imageSize?: Electron.Size
  formats: string[]
}): string {
  if (kind === 'files') {
    return `${data.filePaths.length} file${data.filePaths.length === 1 ? '' : 's'} copied`
  }
  if (kind === 'image') {
    return data.imageSize ? `Image ${data.imageSize.width} x ${data.imageSize.height}` : 'Image'
  }
  if (kind === 'rich-text') {
    return textPreview(data.text || stripHtml(data.html) || data.rtf) || 'Rich text'
  }
  if (kind === 'mixed') {
    return textPreview(data.text || stripHtml(data.html)) || `${data.formats.length} clipboard formats`
  }
  if (kind === 'text') {
    return textPreview(data.text) || 'Text'
  }
  return data.formats[0] || 'Unknown clipboard data'
}

function buildPreview(kind: ClipboardKind, data: {
  text: string
  html: string
  rtf: string
  filePaths: string[]
  formats: string[]
}): string | undefined {
  if (data.filePaths.length > 0) {
    return data.filePaths.slice(0, 3).join('\n')
  }
  if (data.text) {
    return textPreview(data.text)
  }
  if (data.html) {
    return textPreview(stripHtml(data.html))
  }
  if (data.rtf && kind === 'rich-text') {
    return 'RTF content'
  }
  return data.formats.length > 0 ? data.formats.join(', ') : undefined
}

export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null
  private suppressUntil = 0
  private reading = false
  private lastFingerprint = ''

  constructor(
    private readonly store: HistoryStore,
    private readonly onChange?: () => void
  ) {}

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.capture()
    }, POLL_INTERVAL_MS)
    void this.capture()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  suppressFor(ms: number): void {
    this.suppressUntil = Math.max(this.suppressUntil, Date.now() + ms)
  }

  private async capture(): Promise<void> {
    if (this.reading || Date.now() < this.suppressUntil) {
      return
    }

    this.reading = true
    try {
      const pending = await this.readCurrentClipboard()
      if (pending) {
        const item = await this.store.add(pending)
        if (item) {
          this.onChange?.()
        }
      }
    } finally {
      this.reading = false
    }
  }

  private async readCurrentClipboard(): Promise<PendingHistoryItem | null> {
    const formats = clipboard.availableFormats().sort()
    const normalizedFormats = new Set(formats.map((format) => format.toLowerCase()))
    // Clipboard reads are synchronous in Electron. Avoid asking Windows to
    // materialize formats that are not actually present: certain applications
    // advertise expensive delayed-rendering formats, which can briefly block
    // the main process and make the tray appear busy.
    const text = normalizedFormats.has('text/plain') ? clipboard.readText() : ''
    const html = normalizedFormats.has('text/html') ? clipboard.readHTML() : ''
    const rtf = normalizedFormats.has('text/rtf') ? clipboard.readRTF() : ''
    const hasImageFormat = [...normalizedFormats].some((format) => format.startsWith('image/'))
    const image = hasImageFormat ? clipboard.readImage() : nativeImage.createEmpty()
    const imageSize = image.isEmpty() ? undefined : image.getSize()
    const filePaths = isFileDropCandidate(formats) ? await readClipboardFileDropList() : []
    const lightFingerprint = createHash('sha256')
      .update(JSON.stringify({ formats, text, html, rtf, imageSize, filePaths }))
      .digest('hex')

    if (lightFingerprint === this.lastFingerprint) {
      return null
    }
    this.lastFingerprint = lightFingerprint

    const imageBuffer = image.isEmpty() ? null : image.toPNG()

    const blobs: PendingBlob[] = []
    const hash = createHash('sha256')
    let payloadBytes = Buffer.byteLength(text, 'utf8')
    let truncated = payloadBytes > MAX_TEXT_BYTES
    const storedText = truncated ? text.slice(0, MAX_TEXT_BYTES) : text

    hash.update(JSON.stringify({ formats, text, html, rtf, filePaths }))
    if (imageBuffer) {
      hash.update(bufferHash(imageBuffer))
    }

    if (html) {
      const buffer = Buffer.from(html, 'utf8')
      payloadBytes += buffer.byteLength
      if (payloadBytes <= MAX_ITEM_PAYLOAD_BYTES) {
        blobs.push({ key: 'text/html', extension: '.html', buffer })
      } else {
        truncated = true
      }
    }

    if (rtf) {
      const buffer = Buffer.from(rtf, 'utf8')
      payloadBytes += buffer.byteLength
      if (payloadBytes <= MAX_ITEM_PAYLOAD_BYTES) {
        blobs.push({ key: 'text/rtf', extension: '.rtf', buffer })
      } else {
        truncated = true
      }
    }

    if (imageBuffer) {
      payloadBytes += imageBuffer.byteLength
      if (payloadBytes <= MAX_ITEM_PAYLOAD_BYTES) {
        blobs.push({ key: 'image/png', extension: '.png', buffer: Buffer.from(imageBuffer) })
      } else {
        truncated = true
      }
    }

    for (const format of formats) {
      if (CORE_FORMAT_KEYS.has(format)) {
        continue
      }

      try {
        const raw = clipboard.readBuffer(format)
        if (!raw || raw.byteLength === 0) {
          continue
        }

        hash.update(format)
        hash.update(bufferHash(raw))
        payloadBytes += raw.byteLength
        if (payloadBytes <= MAX_ITEM_PAYLOAD_BYTES) {
          blobs.push({
            key: `raw:${format}`,
            extension: extensionForFormat(format),
            buffer: Buffer.from(raw)
          })
        } else {
          truncated = true
        }
      } catch {
        // Some advertised clipboard formats cannot be read by Electron.
      }
    }

    if (!storedText && !html && !rtf && !imageBuffer && filePaths.length === 0 && blobs.length === 0) {
      return null
    }

    const kind = determineKind({
      text: storedText,
      html,
      rtf,
      hasImage: Boolean(imageBuffer),
      hasFiles: filePaths.length > 0,
      rawCount: blobs.filter((blob) => blob.key.startsWith('raw:')).length
    })

    const title = buildTitle(kind, {
      text: storedText,
      html,
      rtf,
      filePaths,
      imageSize,
      formats
    })

    const preview = buildPreview(kind, {
      text: storedText,
      html,
      rtf,
      filePaths,
      formats
    })

    return {
      kind,
      formats,
      title,
      preview,
      text: storedText || undefined,
      filePaths: filePaths.length > 0 ? filePaths : undefined,
      hash: hash.digest('hex'),
      truncated,
      blobs
    }
  }
}

export function createImageFromBlob(buffer: Buffer): Electron.NativeImage {
  return nativeImage.createFromBuffer(buffer)
}
