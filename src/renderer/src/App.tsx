import {
  ArchiveX,
  Clipboard,
  FileText,
  Folder,
  Image,
  Info,
  ListFilter,
  Loader2,
  Power,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Type,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClipboardFilter, ClipboardHistoryItem, ClipboardKind, ClipboardSettings } from '../../shared/types'

const filters: Array<{ value: ClipboardFilter; label: string; icon: typeof Clipboard }> = [
  { value: 'all', label: '全部', icon: Clipboard },
  { value: 'text', label: '文字', icon: Type },
  { value: 'rich-text', label: '富文本', icon: FileText },
  { value: 'image', label: '图片', icon: Image },
  { value: 'files', label: '文件', icon: Folder },
  { value: 'mixed', label: '混合', icon: Sparkles }
]

const kindLabels: Record<ClipboardKind, string> = {
  text: '文字',
  'rich-text': '富文本',
  image: '图片',
  files: '文件',
  mixed: '混合',
  unknown: '未知'
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function blobUrl(relativePath?: string): string | null {
  if (!relativePath) {
    return null
  }
  return `cliphist:///${encodeURI(relativePath)}`
}

function iconForKind(kind: ClipboardKind): typeof Clipboard {
  if (kind === 'text') {
    return Type
  }
  if (kind === 'rich-text') {
    return FileText
  }
  if (kind === 'image') {
    return Image
  }
  if (kind === 'files') {
    return Folder
  }
  if (kind === 'mixed') {
    return Sparkles
  }
  return Clipboard
}

export function App() {
  const [items, setItems] = useState<ClipboardHistoryItem[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ClipboardFilter>('all')
  const [settings, setSettings] = useState<ClipboardSettings>({
    launchAtLogin: true,
    imagePasteAsFileInExplorer: true,
    restoreClipboardAfterImageFilePaste: true
  })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('正在监听剪贴板')

  const refresh = useCallback(async () => {
    const [nextItems, nextSettings] = await Promise.all([
      window.clipboardHistory.listHistory(),
      window.clipboardHistory.getSettings()
    ])
    setItems(nextItems)
    setSettings(nextSettings)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.clipboardHistory.onHistoryUpdated(() => {
      void refresh()
    })

    window.addEventListener('focus', refresh)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) {
        return false
      }
      if (!normalizedQuery) {
        return true
      }
      const haystack = [
        item.title,
        item.preview,
        item.text,
        item.filePaths?.join('\n'),
        item.formats.join(' ')
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [filter, items, query])

  async function restore(item: ClipboardHistoryItem): Promise<void> {
    setBusyId(item.id)
    setMessage('正在恢复并粘贴')
    try {
      const result = await window.clipboardHistory.restoreAndPaste(item.id)
      if (!result.ok) {
        setMessage(result.error ?? '恢复失败')
      } else if (!result.pasted) {
        setMessage('已恢复到剪贴板，请手动 Ctrl+V')
      } else {
        setMessage('已粘贴')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '恢复失败')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(item: ClipboardHistoryItem): Promise<void> {
      await window.clipboardHistory.deleteHistory(item.id)
      setItems((current) => current.filter((entry) => entry.id !== item.id))
      setMessage('已删除一条记录')
  }

  async function clear(): Promise<void> {
    await window.clipboardHistory.clearHistory()
    setItems([])
    setMessage('历史已清空')
  }

  async function toggleLaunchAtLogin(): Promise<void> {
    const next = await window.clipboardHistory.updateSettings({
      launchAtLogin: !settings.launchAtLogin
    })
    setSettings(next)
    setMessage(next.launchAtLogin ? '已开启开机启动' : '已关闭开机启动')
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brandIcon">
            <Clipboard size={20} />
          </div>
          <div>
            <h1>Clipboard History</h1>
            <p>{items.length} 条记录 · 最近 30 天 · 最多 500 条</p>
          </div>
        </div>

        <div className="actions">
          <button className="iconButton" title="刷新" onClick={() => void refresh()}>
            <RefreshCw size={18} />
          </button>
          <button className="iconButton" title="打开数据目录" onClick={() => void window.clipboardHistory.openUserData()}>
            <Settings size={18} />
          </button>
          <button
            className={`toggleButton ${settings.launchAtLogin ? 'isOn' : ''}`}
            title="开机启动"
            onClick={() => void toggleLaunchAtLogin()}
          >
            <Power size={17} />
            <span>{settings.launchAtLogin ? '自启开' : '自启关'}</span>
          </button>
        </div>
      </header>

      <section className="toolbar" aria-label="搜索和筛选">
        <label className="searchBox">
          <Search size={18} />
          <input
            value={query}
            placeholder="搜索文字、文件名、格式"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button className="clearSearch" title="清空搜索" onClick={() => setQuery('')}>
              <X size={16} />
            </button>
          )}
        </label>

        <div className="filterGroup" role="tablist" aria-label="类型筛选">
          {filters.map((entry) => {
            const Icon = entry.icon
            return (
              <button
                key={entry.value}
                role="tab"
                aria-selected={filter === entry.value}
                className={filter === entry.value ? 'active' : ''}
                onClick={() => setFilter(entry.value)}
                title={entry.label}
              >
                <Icon size={16} />
                <span>{entry.label}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="content">
        <div className="listHeader">
          <div>
            <ListFilter size={17} />
            <span>{filteredItems.length} 条匹配</span>
          </div>
          <button className="dangerButton" disabled={items.length === 0} onClick={() => void clear()}>
            <Trash2 size={16} />
            <span>清空</span>
          </button>
        </div>

        {loading ? (
          <div className="emptyState">
            <Loader2 size={24} className="spin" />
            <span>正在读取历史</span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="emptyState">
            <ArchiveX size={28} />
            <span>{items.length === 0 ? '复制一些内容后会出现在这里' : '没有匹配的记录'}</span>
          </div>
        ) : (
          <div className="historyList">
            {filteredItems.map((item) => {
              const Icon = iconForKind(item.kind)
              const imagePreview = item.thumbnailDataUrl ?? blobUrl(item.blobRefs['image/png'])

              return (
                <article key={item.id} className="historyItem" onClick={() => void restore(item)}>
                  <div className={`kindIcon kind-${item.kind}`}>
                    <Icon size={19} />
                  </div>

                  {imagePreview ? (
                    <img className="thumb" src={imagePreview} alt="" />
                  ) : (
                    <div className="thumb placeholder">
                      <Icon size={20} />
                    </div>
                  )}

                  <div className="itemBody">
                    <div className="itemTitleRow">
                      <h2>{item.title}</h2>
                      <span className="kindPill">{kindLabels[item.kind]}</span>
                      {item.truncated && (
                        <span className="warnPill" title="部分原始格式超过单条 25MB 上限，已截断保存">
                          <Info size={13} />
                          截断
                        </span>
                      )}
                    </div>
                    {item.preview && <p>{item.preview}</p>}
                    <div className="meta">
                      <span>{formatTime(item.createdAt)}</span>
                      <span>{formatBytes(item.sizeBytes)}</span>
                      <span>{item.formats.length} 格式</span>
                    </div>
                  </div>

                  <div className="rowActions">
                    <button
                      className="iconButton"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation()
                        void remove(item)
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                    <button className="pasteButton" disabled={busyId === item.id}>
                      {busyId === item.id ? <Loader2 size={17} className="spin" /> : <Clipboard size={17} />}
                      <span>粘贴</span>
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <footer className="statusbar">
        <span>{message}</span>
        <span>Ctrl+Alt+V 打开 · 点击记录自动粘贴</span>
      </footer>
    </main>
  )
}
