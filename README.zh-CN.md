# Clipboard History

[English](README.md)

Clipboard History 是一个 Windows 桌面历史剪贴板工具，使用 Electron、React 和 TypeScript 构建。

它会在后台常驻，记录最近复制的内容，并支持通过 `Ctrl+Alt+V` 或托盘图标打开可搜索的剪贴板历史窗口。

## 功能

- 保存最近复制的文字、富文本、图片、文件路径和可读取的原始剪贴板格式。
- 默认最多保存 500 条记录，最多保留 30 天。
- 支持搜索和按类型筛选历史记录。
- 点击历史记录即可恢复到系统剪贴板。
- 支持自动粘贴回之前的窗口。
- 图片记录支持缩略图显示。
- 提供托盘菜单：打开历史、清空历史、开机启动开关、退出。
- 支持可选的资源管理器图片粘贴：复制截图或图片后，可在文件夹内按 `Ctrl+V` 自动生成 PNG 文件。
- 所有数据仅保存在当前 Windows 用户本机目录。

## 平台

当前版本仅支持 Windows。

第一版尽量避免 Rust、.NET SDK 等原生构建依赖。部分 Windows 集成能力通过 PowerShell 和 Win32 调用实现。

## 安装

正式发布后，可以从 GitHub Releases 下载最新的便携版 `.exe`。

本地打包：

```powershell
cd <project-root>
npm.cmd install
npm.cmd run dist:portable
```

生成的便携版文件位于：

```text
release\Clipboard History 0.1.0.exe
```

不要把 `release/` 里的 exe 或构建产物提交到源码仓库。正式可执行文件应通过 GitHub Releases 发布。

## 开发

安装依赖：

```powershell
npm.cmd install
```

开发模式运行：

```powershell
npm.cmd run dev
```

构建项目：

```powershell
npm.cmd run build
```

打包 Windows 便携版：

```powershell
npm.cmd run dist:portable
```

## 项目结构

```text
src/
  main/       Electron 主进程，负责剪贴板监听、存储、托盘、快捷键等系统能力
  preload/    安全的 IPC 桥接层
  renderer/   React 用户界面
  shared/     主进程、preload、前端共用的 TypeScript 类型
```

更多实现细节见 [PROJECT.md](PROJECT.md)。

## 数据存储

运行时数据保存在 Electron 的 `app.getPath('userData')` 目录中。普通 Windows 用户环境下通常是：

```text
C:\Users\<User>\AppData\Roaming\windows-clipboard-history
```

主要文件：

- `history.json`：剪贴板历史元数据。
- `settings.json`：应用设置。
- `blobs/`：图片、HTML、RTF 和 raw clipboard payload。
- `exported-images/`：资源管理器图片转 PNG 粘贴时生成的图片文件。

剪贴板数据仅保存在本机。当前版本不做敏感内容过滤。如果你的设备或公司策略不允许保存本地剪贴板历史，请不要运行该工具。

## 安全说明

该应用会读取剪贴板内容、注册全局快捷键、发送粘贴按键、调用 PowerShell 辅助脚本，并可选择开机自启。这些行为可能被杀毒软件或企业终端安全软件提示风险。

如果用于企业分发，建议使用签名安装包，审查 PowerShell 辅助逻辑，并考虑默认关闭开机自启和资源管理器图片粘贴功能。

## License

MIT。详见 [LICENSE](LICENSE)。
