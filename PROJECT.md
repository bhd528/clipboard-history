# Clipboard History 项目说明

## 项目目标

`Clipboard History` 是一个 Windows 桌面历史剪贴板应用，使用 Electron + React + TypeScript 实现。

应用启动后会后台常驻，自动监听系统剪贴板，保存最近复制的文字、带格式文本、图片、文件路径和可读取的原始剪贴板格式。用户可以通过托盘图标或 `Ctrl+Alt+V` 打开历史窗口，搜索历史内容，并点击记录恢复到剪贴板后自动粘贴。

## 项目结构

```text
<project-root>
├── package.json                 # 项目脚本、依赖、electron-builder 打包配置
├── package-lock.json            # npm 依赖锁定文件
├── electron.vite.config.ts      # electron-vite 构建配置
├── tsconfig.json                # TypeScript 配置
├── PROJECT.md                   # 项目说明文档
├── src
│   ├── main                     # Electron 主进程，负责系统能力
│   │   ├── index.ts             # 应用入口、托盘、快捷键、窗口、IPC、恢复粘贴
│   │   ├── clipboardWatcher.ts  # 剪贴板轮询、格式识别、hash 去重、记录生成
│   │   ├── historyStore.ts      # 历史数据读写、blob 文件管理、清理策略、设置持久化
│   │   ├── imageFilePaste.ts    # 资源管理器 Ctrl+V 图片自动转 PNG 文件粘贴
│   │   └── powershell.ts        # Windows 文件剪贴板、前台窗口、自动 Ctrl+V 辅助
│   ├── preload
│   │   └── index.ts             # 安全暴露主进程 IPC API 给前端页面
│   ├── renderer                 # React 前端界面
│   │   ├── index.html           # 渲染进程 HTML 入口
│   │   └── src
│   │       ├── main.tsx         # React 挂载入口
│   │       ├── App.tsx          # 历史列表、搜索、筛选、设置、删除、粘贴按钮
│   │       ├── styles.css       # UI 样式
│   │       └── env.d.ts         # window.clipboardHistory 类型声明
│   └── shared
│       └── types.ts             # 主进程、preload、前端共用的数据类型
├── out                          # 构建产物，由 npm.cmd run build 生成
├── release                      # exe 打包产物，由 electron-builder 生成
└── node_modules                 # npm 依赖目录
```

`src` 是主要源码目录。`out`、`release`、`node_modules` 都是生成物或依赖，不需要手动改。

## 模块职责

### 主进程：`src/main`

主进程负责所有接近系统的能力：

- 创建托盘图标和托盘菜单。
- 注册 `Ctrl+Alt+V` 全局快捷键。
- 创建历史窗口，并在用户主动关闭前保持窗口存在。
- 监听剪贴板变化。
- 读写历史记录。
- 恢复历史内容到系统剪贴板。
- 尝试把内容自动粘贴回之前的窗口。
- 在资源管理器中把图片剪贴板自动转换为 PNG 文件粘贴。
- 设置开机启动。

关键文件：

- `index.ts`：主流程调度中心。它把窗口、托盘、快捷键、IPC、恢复粘贴串在一起。
- `clipboardWatcher.ts`：每 `1000ms` 检查一次剪贴板，识别文字、HTML、RTF、图片、文件等格式，并用 hash 避免重复记录。
- `historyStore.ts`：管理 `history.json`、`settings.json` 和 `blobs/`，并执行最多 `500` 条、最多 `30` 天、最多 `2GB` 的清理策略。
- `imageFilePaste.ts`：接管资源管理器中的 `Ctrl+V` 图片粘贴，把截图导出为 PNG 临时文件，再交给资源管理器粘贴。
- `powershell.ts`：调用 Windows PowerShell/Win32 能力，读取文件复制列表、获取前台窗口信息、恢复文件路径剪贴板、模拟 `Ctrl+V`。

### 预加载层：`src/preload`

Electron 不允许前端页面直接访问 Node.js 和系统 API，所以用 preload 做一层安全桥。

`src/preload/index.ts` 会在 `window.clipboardHistory` 上暴露这些方法：

- `listHistory`
- `restoreAndPaste`
- `deleteHistory`
- `clearHistory`
- `getSettings`
- `updateSettings`
- `openUserData`

前端只调用这些方法，不直接碰文件系统或剪贴板。

### 前端界面：`src/renderer`

前端是 React 页面，负责展示和交互：

- 历史列表。
- 搜索框。
- 类型筛选。
- 图片缩略图。
- 删除单条记录。
- 清空历史。
- 开机启动开关。
- 打开数据目录按钮。
- 点击记录后恢复并粘贴。

目前列表中“带格式文本”只显示纯文本摘要。真正的 HTML/RTF 格式会保存在后台，恢复粘贴到支持富文本的应用时会尽量保留样式。

### 共享类型：`src/shared`

`src/shared/types.ts` 定义主进程、preload 和前端共同使用的数据结构。

核心类型是：

```ts
type ClipboardKind = 'text' | 'rich-text' | 'image' | 'files' | 'mixed' | 'unknown'

interface ClipboardHistoryItem {
  id: string
  createdAt: string
  kind: ClipboardKind
  formats: string[]
  title: string
  preview?: string
  text?: string
  filePaths?: string[]
  blobRefs: Record<string, string>
  sizeBytes: number
  hash: string
  truncated: boolean
}
```

设置类型是：

```ts
interface ClipboardSettings {
  launchAtLogin: boolean
  imagePasteAsFileInExplorer: boolean
  restoreClipboardAfterImageFilePaste: boolean
}
```

## 运行流程

### 复制内容时

1. `clipboardWatcher.ts` 每 `1000ms` 读取一次系统剪贴板。
2. 它识别当前剪贴板里有哪些格式，例如 `text/plain`、`text/html`、`text/rtf`、图片、文件路径等。
3. 它根据内容生成 hash，避免同一内容重复保存。
4. 文本直接进入历史元数据，大块内容保存为 blob 文件。
5. `historyStore.ts` 把元数据写入 `history.json`，把图片、HTML、RTF 和 raw buffer 写入 `blobs/`。

### 打开历史窗口时

1. 用户按 `Ctrl+Alt+V` 或点击托盘图标。
2. 主进程记录当前活动窗口，方便之后自动粘贴回去。
3. 主进程显示 React 历史窗口。
4. 前端通过 IPC 调用 `history:list` 获取历史记录。

### 点击历史记录时

1. 前端调用 `history:restoreAndPaste`。
2. 主进程找到对应历史记录。
3. 主进程把文字、HTML、RTF、图片或文件路径写回系统剪贴板。
4. 主进程保持历史窗口打开，但把焦点切回之前的活动窗口。
5. 主进程模拟一次 `Ctrl+V`。
6. 如果自动粘贴失败，内容仍然已经在系统剪贴板里，可以手动 `Ctrl+V`。

### 在资源管理器粘贴图片时

1. 用户复制截图或图片后，在 Windows 资源管理器文件夹或桌面中按 `Ctrl+V`。
2. `imageFilePaste.ts` 先确认剪贴板是图片且不是文件路径，再判断当前前台窗口是否为 `explorer.exe`，窗口类名是否属于 `CabinetWClass`、`ExploreWClass`、`Progman` 或 `WorkerW`。
3. 如果剪贴板当前是图片且不是文件路径，应用把图片保存为 `exported-images/clipboard-image-日期-随机值.png`。
4. 应用临时把剪贴板写成该 PNG 文件路径，暂停历史监听记录，然后向资源管理器发送一次 `Ctrl+V`。
5. 约 `1200ms` 后，如果剪贴板仍然是刚才导出的文件路径，应用会恢复原图片剪贴板，方便继续粘贴到聊天、文档或图片编辑器。
6. 为避免影响普通文本粘贴，应用平时不会长期接管全局 `Ctrl+V`；只有“剪贴板是图片 + 前台是资源管理器/桌面”时才会临时注册 `Ctrl+V`。

## 数据存储

运行后数据保存在 Electron 的 `app.getPath('userData')` 目录。当前应用通常对应：

```text
%APPDATA%\windows-clipboard-history
```

里面主要有：

- `history.json`：历史记录元数据。
- `settings.json`：开机启动等设置。
- `blobs/`：图片、HTML、RTF 和可读取 raw buffer。
- `exported-images/`：资源管理器中图片转 PNG 粘贴时生成的图片文件。

默认清理策略：

- 最多保存 `500` 条。
- 最多保留 `30` 天。
- 总存储上限 `2GB`。
- 单条 raw payload 上限 `25MB`，超出会标记为 `truncated`。
- `exported-images/` 默认保留最多 `500` 个 PNG，最多 `30` 天，超出会自动删除旧文件。

文件/文件夹复制只保存路径，不复制文件内容。恢复文件历史时，原文件路径需要仍然存在。

## 运行命令

所有 `npm.cmd` 命令都需要在项目目录中运行：

```powershell
cd <project-root>
npm.cmd install
npm.cmd run dev
npm.cmd run build
```

也可以不切换目录，直接使用 `--prefix`：

```powershell
npm.cmd --prefix <project-root> run dev
npm.cmd --prefix <project-root> run preview
```

PowerShell 中直接运行 `npm` 可能遇到执行策略限制，因此建议使用 `npm.cmd`。

常用脚本：

- `npm.cmd run dev`：开发模式启动。
- `npm.cmd run preview`：构建后预览运行。
- `npm.cmd run build`：类型检查并构建 `out/`。
- `npm.cmd run dist:portable`：生成单文件便携版 exe。
- `npm.cmd run dist:dir`：生成 `release/win-unpacked` 文件夹版。
- `npm.cmd run dist`：尝试同时生成便携版和安装包。

## 打包 EXE

生成单文件便携版 exe：

```powershell
cd <project-root>
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm.cmd run dist:portable
```

产物位置：

```text
<project-root>\release\Clipboard History 0.1.0.exe
```

这个 exe 可以复制到其他 Windows x64 设备上直接运行，不需要安装 Node.js，也不需要复制源码目录。第一次运行时，便携版会把 Electron 运行时释放到系统临时目录，然后启动托盘常驻应用。

生成文件夹版：

```powershell
cd <project-root>
npm.cmd run dist:dir
```

文件夹版位置：

```text
<project-root>\release\win-unpacked\Clipboard History.exe
```

文件夹版需要把整个 `win-unpacked` 文件夹一起复制到其他设备，只复制里面的 `Clipboard History.exe` 不够。

完整安装包命令：

```powershell
cd <project-root>
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm.cmd run dist
```

`dist` 会同时尝试生成便携版和 NSIS 安装包。如果 GitHub 下载超时，优先使用 `dist:portable`。

## 操作方式

### 启动应用

开发运行：

```powershell
cd <project-root>
npm.cmd run dev
```

生产预览运行：

```powershell
cd <project-root>
npm.cmd run preview
```

直接使用打包好的 exe：

```text
<project-root>\release\Clipboard History 0.1.0.exe
```

应用启动后会后台常驻，并在 Windows 托盘区域显示历史剪贴板图标。

### 记录复制内容

应用运行期间，正常使用 Windows 复制操作即可：

- 复制文字：选中文字后按 `Ctrl+C`。
- 复制图片：在支持复制图片的应用里执行复制，或截图后复制到剪贴板。
- 复制文件/文件夹：在资源管理器中选中文件或文件夹后按 `Ctrl+C`。
- 复制带格式文本：从浏览器、Office、编辑器等应用中复制带格式内容。

应用会自动监听系统剪贴板，不需要手动保存。

### 在文件夹中把截图粘贴成 PNG 文件

这个功能默认开启，用于解决“复制的是图片像素，但资源管理器不能直接把它粘贴成文件”的问题。

操作方式：

1. 使用截图工具、浏览器、图片编辑器等方式复制一张图片到剪贴板。
2. 打开 Windows 文件资源管理器，进入目标文件夹，或直接回到桌面。
3. 按原生 `Ctrl+V`。
4. 应用会自动生成一个 PNG 文件并粘贴到当前文件夹中，文件名类似 `clipboard-image-20260523-201530-123-xxxxxxxx.png`。
5. 粘贴完成后，剪贴板会恢复为原图片，仍可继续粘贴到微信、Word、画图等支持图片粘贴的应用。

可以在托盘菜单中勾选或取消“资源管理器 Ctrl+V 图片转 PNG”。关闭后，程序不会再接管资源管理器里的 `Ctrl+V` 图片转文件行为。

注意：第一版只识别 Windows 原生资源管理器和桌面，不覆盖第三方文件管理器。如果某台电脑上 `Ctrl+V` 全局快捷键被其他软件占用，该功能可能不可用，但历史剪贴板主功能不受影响。

### 打开历史窗口

可以用两种方式打开：

- 按 `Ctrl+Alt+V`。
- 点击 Windows 托盘里的历史剪贴板图标。

如果图标没有直接显示在任务栏右下角，点击右下角的小箭头，在隐藏图标面板里查找。

### 查找历史内容

历史窗口支持：

- 在搜索框输入关键词，按文字、文件名或剪贴板格式搜索。
- 点击顶部类型筛选按钮，查看全部、文字、带格式文本、图片、文件或混合内容。
- 点击刷新按钮重新读取当前历史。
- 图片记录会显示缩略图；窄窗口下缩略图会缩小但不会隐藏。如果缩略图异常，优先检查 `blobs/` 中对应 PNG 文件是否存在。

### 恢复并粘贴

在历史窗口中点击任意记录：

1. 应用会先把这条历史恢复到系统剪贴板。
2. 历史窗口会继续打开，不会因为点击记录或粘贴按钮自动关闭。
3. 应用会尝试回到打开历史窗口前的活动窗口。
4. 应用会自动发送一次 `Ctrl+V` 完成粘贴。
5. 需要关闭历史窗口时，使用窗口右上角关闭按钮。

如果自动粘贴失败，内容仍然已经恢复到系统剪贴板，可以手动按 `Ctrl+V`。

### 删除和清空

- 点击单条记录右侧的删除按钮，可以删除该记录。
- 点击窗口顶部的清空按钮，可以删除全部历史。
- 托盘菜单里也提供清空历史入口。

### 开机启动

- 应用默认开启开机自动启动。
- 可以在窗口右上角点击自启开关切换。
- 也可以在托盘菜单中勾选或取消“开机自动启动”。
- 开发模式 `npm.cmd run dev` 不会注册开机启动，避免 Windows 启动到 Electron 默认欢迎页。
- 便携版会优先注册外层 `Clipboard History 0.1.0.exe`，不注册临时解压目录里的 Electron 子进程。
- 如果开机后看到 Electron 默认欢迎页，通常是旧版本留下的错误自启项，可以删除注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `electron.app.Electron`。

### 打开数据目录

点击窗口右上角的设置按钮，可以打开当前应用数据目录。该目录中包含 `history.json`、`settings.json` 和 `blobs/`。

## 构建产物说明

- `out/`：`electron-vite` 构建后的主进程、preload 和前端资源。
- `release/Clipboard History 0.1.0.exe`：单文件便携版，推荐复制到其他设备使用。
- `release/win-unpacked/`：文件夹版，需要整个文件夹一起复制。

当前已生成的便携版 exe：

```text
<project-root>\release\Clipboard History 0.1.0.exe
```

最近一次重新打包后，托盘图标已改为不透明位图，避免 Windows 右下角显示成透明图标。
