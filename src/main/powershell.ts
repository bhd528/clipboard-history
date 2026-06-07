import { execFile } from 'node:child_process'

const POWERSHELL = 'powershell.exe'

export interface ForegroundWindowInfo {
  hwnd: string
  pid: number
  processName: string
  className: string
  title: string
}

function toEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "''")
}

export function runPowerShell(script: string, timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', toEncodedCommand(script)],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message))
          return
        }

        resolve(stdout.toString().trim())
      }
    )
  })
}

export async function readClipboardFileDropList(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }

  const script = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$paths = @()
try {
  $paths = @(Get-Clipboard -Format FileDropList -ErrorAction Stop | ForEach-Object { $_.FullName })
} catch {
  $paths = @()
}
[Console]::Write((ConvertTo-Json -Compress -InputObject @($paths)))
`

  try {
    const output = await runPowerShell(script)
    if (!output) {
      return []
    }

    const parsed = JSON.parse(output) as string[] | string | null
    if (Array.isArray(parsed)) {
      return parsed.filter(Boolean)
    }

    return parsed ? [parsed] : []
  } catch {
    return []
  }
}

export async function setClipboardFileDropList(paths: string[]): Promise<void> {
  if (process.platform !== 'win32' || paths.length === 0) {
    return
  }

  const script = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$paths = ConvertFrom-Json -InputObject '${jsonLiteral(paths)}'
Set-Clipboard -LiteralPath @($paths)
`

  await runPowerShell(script)
}

export async function getForegroundWindowHandle(): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null
  }

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ClipboardHistoryWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
[Console]::Write([ClipboardHistoryWin32]::GetForegroundWindow().ToInt64())
`

  try {
    const output = await runPowerShell(script)
    return output && output !== '0' ? output : null
  } catch {
    return null
  }
}

export async function getForegroundWindowInfo(): Promise<ForegroundWindowInfo | null> {
  if (process.platform !== 'win32') {
    return null
  }

  const script = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ClipboardHistoryWindowInfoWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
}
"@
$hwnd = [ClipboardHistoryWindowInfoWin32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  [Console]::Write("null")
  return
}
$pidValue = 0
[ClipboardHistoryWindowInfoWin32]::GetWindowThreadProcessId($hwnd, [ref]$pidValue) | Out-Null
$classBuilder = [System.Text.StringBuilder]::new(256)
[ClipboardHistoryWindowInfoWin32]::GetClassName($hwnd, $classBuilder, $classBuilder.Capacity) | Out-Null
$processName = ""
$title = ""
try {
  $process = [System.Diagnostics.Process]::GetProcessById($pidValue)
  $processName = $process.ProcessName
  $title = $process.MainWindowTitle
} catch {}
$info = [ordered]@{
  hwnd = $hwnd.ToInt64().ToString()
  pid = $pidValue
  processName = $processName
  className = $classBuilder.ToString()
  title = $title
}
[Console]::Write((ConvertTo-Json -Compress -InputObject $info))
`

  try {
    const output = await runPowerShell(script)
    if (!output || output === 'null') {
      return null
    }
    const parsed = JSON.parse(output) as ForegroundWindowInfo
    return parsed.hwnd && parsed.hwnd !== '0' ? parsed : null
  } catch {
    return null
  }
}

export async function focusWindowAndPaste(hwnd: string | null): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }

  const numericHwnd = Number.parseInt(hwnd || '0', 10)
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ClipboardHistoryPasteWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$hwndValue = [IntPtr]::new(${Number.isFinite(numericHwnd) ? numericHwnd : 0})
if ($hwndValue -ne [IntPtr]::Zero) {
  [ClipboardHistoryPasteWin32]::ShowWindow($hwndValue, 9) | Out-Null
  [ClipboardHistoryPasteWin32]::SetForegroundWindow($hwndValue) | Out-Null
}
Start-Sleep -Milliseconds 120
$VK_CONTROL = 0x11
$VK_V = 0x56
$KEYEVENTF_KEYUP = 0x0002
[ClipboardHistoryPasteWin32]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero)
[ClipboardHistoryPasteWin32]::keybd_event($VK_V, 0, 0, [UIntPtr]::Zero)
[ClipboardHistoryPasteWin32]::keybd_event($VK_V, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
[ClipboardHistoryPasteWin32]::keybd_event($VK_CONTROL, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
[Console]::Write("ok")
`

  try {
    await runPowerShell(script)
    return true
  } catch {
    return false
  }
}
