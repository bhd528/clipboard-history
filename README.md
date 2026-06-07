# Clipboard History

[简体中文](README.zh-CN.md)

Clipboard History is a Windows desktop clipboard history tool built with Electron, React, and TypeScript.

It runs in the background, records recent clipboard content, and lets you reopen a searchable clipboard history window with `Ctrl+Alt+V` or the tray icon.

## Features

- Stores recent text, rich text, images, file paths, and readable raw clipboard formats.
- Keeps up to 500 history items for up to 30 days.
- Shows searchable and filterable clipboard history.
- Restores a selected history item back to the system clipboard.
- Supports automatic paste back to the previous window.
- Shows image thumbnails in the history list.
- Provides a tray menu for opening history, clearing history, toggling startup, and exiting.
- Supports optional Explorer image paste: copied screenshots/images can be pasted into File Explorer as PNG files with `Ctrl+V`.
- Stores all data locally under the current Windows user profile.

## Platform

This project currently targets Windows only.

The first version intentionally avoids native build dependencies such as Rust or the .NET SDK. Some Windows integration is implemented through PowerShell and Win32 calls.

## Install

Download the latest portable `.exe` from GitHub Releases once releases are published.

For a local build, use:

```powershell
cd <project-root>
npm.cmd install
npm.cmd run dist:portable
```

The portable executable will be generated in:

```text
release\Clipboard History 0.1.0.exe
```

Do not commit files from `release/` to the source repository. Publish built executables through GitHub Releases instead.

## Development

Install dependencies:

```powershell
npm.cmd install
```

Run in development mode:

```powershell
npm.cmd run dev
```

Build the app:

```powershell
npm.cmd run build
```

Package a portable Windows executable:

```powershell
npm.cmd run dist:portable
```

## Project Structure

```text
src/
  main/       Electron main process, clipboard monitoring, storage, tray, shortcuts
  preload/    Safe IPC bridge exposed to the renderer
  renderer/   React user interface
  shared/     Shared TypeScript types
```

Additional implementation notes are documented in [PROJECT.md](PROJECT.md).

## Data Storage

Runtime data is stored in Electron's `app.getPath('userData')` directory. On a normal Windows user profile, this is usually:

```text
C:\Users\<User>\AppData\Roaming\windows-clipboard-history
```

Main runtime files:

- `history.json`: clipboard history metadata.
- `settings.json`: app settings.
- `blobs/`: image, HTML, RTF, and raw clipboard payloads.
- `exported-images/`: generated PNG files for Explorer image paste.

Clipboard data is stored locally. There is currently no sensitive content filtering. Do not run this tool on machines where local clipboard history storage is not allowed by policy.

## Security Notes

This app can read clipboard content, register global shortcuts, send paste keystrokes, use PowerShell helpers, and optionally start at login. These behaviors may be flagged by antivirus or enterprise endpoint protection software.

For enterprise distribution, use a signed installer, review the PowerShell-based helpers, and consider disabling startup and Explorer image paste by default.

## License

MIT. See [LICENSE](LICENSE).
