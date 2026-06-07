/// <reference types="vite/client" />

import type { ClipboardHistoryApi } from '../../preload'

declare global {
  interface Window {
    clipboardHistory: ClipboardHistoryApi
  }
}
