/**
 * Windows desktop control without third-party packages.
 *
 * Every call compiles a small C# helper with `Add-Type` inside a fresh
 * `powershell.exe` and talks to it through `user32.dll`. That is slower than a
 * native module, but it needs no compiler on the user's machine, no npm
 * dependency, and no long-lived process holding the desktop.
 *
 * Background delivery is the default: input is posted to the target window's
 * message queue, so the user's foreground window keeps focus. A visible
 * activation is only performed when the caller passes `activate: true`, and the
 * audit trail records that it happened.
 *
 * @module dsh-superagent/desktop
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const POWERSHELL_TIMEOUT_MS = 30000

/** Message ids and flags the helper uses. Kept in one place so the C# and JS agree. */
const WM = { mousemove: 0x0200, lbuttondown: 0x0201, lbuttonup: 0x0202, char: 0x0102, keydown: 0x0100, keyup: 0x0101 }

/**
 * C# helper. `Add-Type` compiles it once per PowerShell process; nothing is
 * written to disk and nothing persists between calls.
 */
const HELPER_SOURCE = String.raw`
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class DshDesktop {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint cbSize; public uint flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;

  public static string[] List() {
    List<string> rows = new List<string>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      int length = GetWindowTextLengthW(hWnd);
      if (length <= 0) return true;
      StringBuilder text = new StringBuilder(length + 1);
      GetWindowTextW(hWnd, text, text.Capacity);
      string title = text.ToString();
      if (title.Length == 0) return true;
      RECT rect;
      GetWindowRect(hWnd, out rect);
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      rows.Add(string.Join("\t", new string[] {
        hWnd.ToInt64().ToString(), title, pid.ToString(),
        rect.Left.ToString(), rect.Top.ToString(),
        (rect.Right - rect.Left).ToString(), (rect.Bottom - rect.Top).ToString(),
        IsIconic(hWnd) ? "1" : "0"
      }));
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }

  public static IntPtr FindByTitle(string fragment) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      int length = GetWindowTextLengthW(hWnd);
      if (length <= 0) return true;
      StringBuilder text = new StringBuilder(length + 1);
      GetWindowTextW(hWnd, text, text.Capacity);
      if (text.ToString().IndexOf(fragment, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Activate(IntPtr hWnd) {
    if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
    SetForegroundWindow(hWnd);
  }

  public static bool ClickBackground(IntPtr hWnd, int screenX, int screenY) {
    POINT point = new POINT { X = screenX, Y = screenY };
    if (!ScreenToClient(hWnd, ref point)) return false;
    IntPtr lParam = (IntPtr)((point.Y << 16) | (point.X & 0xFFFF));
    PostMessageW(hWnd, 0x0200, IntPtr.Zero, lParam);
    PostMessageW(hWnd, 0x0201, (IntPtr)1, lParam);
    PostMessageW(hWnd, 0x0202, IntPtr.Zero, lParam);
    return true;
  }

  public static void ClickForeground(int x, int y, bool right) {
    SetCursorPos(x, y);
    mouse_event(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    mouse_event(right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }

  public static IntPtr FocusOf(IntPtr hWnd) {
    uint pid;
    uint thread = GetWindowThreadProcessId(hWnd, out pid);
    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(thread, ref info)) return IntPtr.Zero;
    return info.hwndFocus != IntPtr.Zero ? info.hwndFocus : hWnd;
  }

  public static int TypeBackground(IntPtr hWnd, string text) {
    IntPtr target = FocusOf(hWnd);
    foreach (char ch in text) {
      PostMessageW(target, 0x0102, (IntPtr)ch, IntPtr.Zero);
    }
    return text.Length;
  }

  public static void TypeForeground(string text) {
    List<INPUT> inputs = new List<INPUT>();
    foreach (char ch in text) {
      INPUT down = new INPUT();
      down.type = 1;
      down.U.ki.wScan = (ushort)ch;
      down.U.ki.dwFlags = KEYEVENTF_UNICODE;
      inputs.Add(down);
      INPUT up = new INPUT();
      up.type = 1;
      up.U.ki.wScan = (ushort)ch;
      up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      inputs.Add(up);
    }
    if (inputs.Count > 0) SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static bool KeyBackground(IntPtr hWnd, int virtualKey) {
    IntPtr target = FocusOf(hWnd);
    PostMessageW(target, 0x0100, (IntPtr)virtualKey, IntPtr.Zero);
    PostMessageW(target, 0x0101, (IntPtr)virtualKey, IntPtr.Zero);
    return true;
  }

  public static void KeyForeground(int virtualKey) {
    INPUT down = new INPUT();
    down.type = 1;
    down.U.ki.wVk = (ushort)virtualKey;
    INPUT up = new INPUT();
    up.type = 1;
    up.U.ki.wVk = (ushort)virtualKey;
    up.U.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static bool CaptureWindow(IntPtr hWnd, string file) {
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return false;
    int width = rect.Right - rect.Left;
    int height = rect.Bottom - rect.Top;
    if (width <= 0 || height <= 0) return false;
    using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        IntPtr hdc = graphics.GetHdc();
        // 2 = PW_RENDERFULLCONTENT, so a covered window still yields its own pixels.
        bool ok = PrintWindow(hWnd, hdc, 2);
        graphics.ReleaseHdc(hdc);
        if (!ok) return false;
      }
      bitmap.Save(file, ImageFormat.Png);
    }
    return true;
  }

  public static bool CaptureScreen(string file, int x, int y, int width, int height) {
    if (width <= 0 || height <= 0) return false;
    using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height));
      }
      bitmap.Save(file, ImageFormat.Png);
    }
    return true;
  }
}
`

const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Window titles are frequently non-ASCII. Without this the JSON reply comes back
# in the OEM code page and every Chinese or accented title is corrupted.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
${HELPER_SOURCE}
'@ -ReferencedAssemblies System.Drawing
[DshDesktop]::SetProcessDPIAware() | Out-Null
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:DSH_DESKTOP_PAYLOAD)) | ConvertFrom-Json
`

/** Emit one JSON reply so the caller never has to parse prose. */
const REPLY = String.raw`
function Reply($object) { $object | ConvertTo-Json -Compress -Depth 6; exit 0 }
`

const SCRIPTS = {
  list: `${PRELUDE}${REPLY}
$rows = [DshDesktop]::List()
$items = @()
foreach ($row in $rows) {
  $parts = $row.Split("\t")
  $items += [pscustomobject]@{
    hwnd = $parts[0]; title = $parts[1]; pid = [int]$parts[2]
    rect = [pscustomobject]@{ x = [int]$parts[3]; y = [int]$parts[4]; width = [int]$parts[5]; height = [int]$parts[6] }
    minimized = ($parts[7] -eq '1')
  }
}
Reply ([pscustomobject]@{ ok = $true; windows = $items })
`,
  screenshot: `${PRELUDE}${REPLY}
if ($payload.window) {
  $hwnd = [DshDesktop]::FindByTitle([string]$payload.window)
  if ($hwnd -eq [IntPtr]::Zero) { Reply ([pscustomobject]@{ ok = $false; error = "no visible window title contains '$($payload.window)'" }) }
  if (-not [DshDesktop]::CaptureWindow($hwnd, [string]$payload.path)) {
    Reply ([pscustomobject]@{ ok = $false; error = 'PrintWindow could not capture that window' })
  }
  Reply ([pscustomobject]@{ ok = $true; path = [string]$payload.path; window = [string]$payload.window; scope = 'window' })
}
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if (-not [DshDesktop]::CaptureScreen([string]$payload.path, $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)) {
  Reply ([pscustomobject]@{ ok = $false; error = 'CopyFromScreen failed' })
}
Reply ([pscustomobject]@{ ok = $true; path = [string]$payload.path; scope = 'screen'; rect = [pscustomobject]@{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height } })
`,
  click: `${PRELUDE}${REPLY}
$hwnd = [IntPtr]::Zero
if ($payload.window) {
  $hwnd = [DshDesktop]::FindByTitle([string]$payload.window)
  if ($hwnd -eq [IntPtr]::Zero) { Reply ([pscustomobject]@{ ok = $false; error = "no visible window title contains '$($payload.window)'" }) }
}
if ($payload.activate) {
  if ($hwnd -ne [IntPtr]::Zero) { [DshDesktop]::Activate($hwnd) }
  [DshDesktop]::ClickForeground([int]$payload.x, [int]$payload.y, [bool]$payload.right)
  Reply ([pscustomobject]@{ ok = $true; mode = 'foreground'; x = [int]$payload.x; y = [int]$payload.y; activated = ($hwnd -ne [IntPtr]::Zero) })
}
if ($hwnd -eq [IntPtr]::Zero) { Reply ([pscustomobject]@{ ok = $false; error = 'a background click needs window (window title) so it can be posted without stealing focus' }) }
if (-not [DshDesktop]::ClickBackground($hwnd, [int]$payload.x, [int]$payload.y)) {
  Reply ([pscustomobject]@{ ok = $false; error = 'ScreenToClient refused the point' })
}
Reply ([pscustomobject]@{ ok = $true; mode = 'background'; x = [int]$payload.x; y = [int]$payload.y; hwnd = $hwnd.ToInt64() })
`,
  type: `${PRELUDE}${REPLY}
$hwnd = [IntPtr]::Zero
if ($payload.window) {
  $hwnd = [DshDesktop]::FindByTitle([string]$payload.window)
  if ($hwnd -eq [IntPtr]::Zero) { Reply ([pscustomobject]@{ ok = $false; error = "no visible window title contains '$($payload.window)'" }) }
}
if ($payload.activate) {
  if ($hwnd -ne [IntPtr]::Zero) { [DshDesktop]::Activate($hwnd) }
  [DshDesktop]::TypeForeground([string]$payload.text)
  Reply ([pscustomobject]@{ ok = $true; mode = 'foreground'; chars = ([string]$payload.text).Length; activated = ($hwnd -ne [IntPtr]::Zero) })
}
if ($hwnd -eq [IntPtr]::Zero) { Reply ([pscustomobject]@{ ok = $false; error = 'background typing needs window (window title)' }) }
$count = [DshDesktop]::TypeBackground($hwnd, [string]$payload.text)
Reply ([pscustomobject]@{ ok = $true; mode = 'background'; chars = $count; hwnd = $hwnd.ToInt64() })
`,
  keys: `${PRELUDE}${REPLY}
$hwnd = [IntPtr]::Zero
if ($payload.window) {
  $hwnd = [DshDesktop]::FindByTitle([string]$payload.window)
  if ($hwnd -eq [IntPtr]::Zero) { Reply ([pscustomobject]@{ ok = $false; error = "no visible window title contains '$($payload.window)'" }) }
}
if ($payload.activate) {
  if ($hwnd -ne [IntPtr]::Zero) { [DshDesktop]::Activate($hwnd) }
  foreach ($key in $payload.virtualKeys) { [DshDesktop]::KeyForeground([int]$key) }
  Reply ([pscustomobject]@{ ok = $true; mode = 'foreground'; keys = $payload.virtualKeys.Count; activated = ($hwnd -ne [IntPtr]::Zero) })
}
if ($hwnd -eq [IntPtr]::Zero) { Reply ([pscustomobject]@{ ok = $false; error = 'background key presses need window (window title)' }) }
foreach ($key in $payload.virtualKeys) { [DshDesktop]::KeyBackground($hwnd, [int]$key) | Out-Null }
Reply ([pscustomobject]@{ ok = $true; mode = 'background'; keys = $payload.virtualKeys.Count; hwnd = $hwnd.ToInt64() })
`,
}

/**
 * Directory PowerShell may use for its compile scratch file.
 *
 * `Add-Type` writes a `.cs` file into `%TEMP%` and then compiles it. Under a
 * restricted token that can read `C:\Windows\TEMP` but not create files there,
 * the compiler reports "source file not found" — a confusing error that looks
 * like a C# syntax problem. Pointing TEMP at a directory the user owns avoids
 * it. This also keeps the helper working when the host runs inside a sandbox.
 */
let powershellTemp = null
function tempDirForPowerShell() {
  if (powershellTemp) return powershellTemp
  const base = process.env.LOCALAPPDATA || os.tmpdir()
  const dir = path.join(base, 'Temp', 'dsh-runtime-control')
  mkdirSync(dir, { recursive: true })
  powershellTemp = dir
  return dir
}

/**
 * Run one helper script with a JSON payload and parse its JSON reply.
 * @param {string} name - key of {@link SCRIPTS}.
 * @param {object} payload
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options]
 */
export async function runDesktopScript(name, payload, { timeoutMs = POWERSHELL_TIMEOUT_MS, env = process.env } = {}) {
  const script = SCRIPTS[name]
  if (!script) throw new Error(`no desktop script named ${name}`)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const temp = tempDirForPowerShell()
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...env,
      TEMP: temp,
      TMP: temp,
      DSH_DESKTOP_PAYLOAD: Buffer.from(JSON.stringify(payload ?? {}), 'utf8').toString('base64'),
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const code = await new Promise(resolve => child.on('close', resolve))
  clearTimeout(timer)
  const text = stdout.trim()
  if (!text) {
    throw new Error(
      `powershell produced no result (exit ${code})${stderr ? `: ${stderr.trim().slice(0, 1500)}` : ''}`,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text.split('\n').at(-1))
  } catch {
    throw new Error(`powershell output was not JSON: ${text.slice(0, 300)}`)
  }
  if (parsed?.ok === false) throw new Error(parsed.error ?? 'the desktop helper refused the action')
  return parsed
}

/** Snapshot of every visible titled top-level window. */
export async function listWindows(options = {}) {
  const result = await runDesktopScript('list', {}, options)
  return result.windows ?? []
}

/**
 * Capture the screen or one window.
 * @param {{ path: string, window?: string|null, timeoutMs?: number }} options
 */
export async function captureScreenshot({ path: file, window = null, ...options }) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  return runDesktopScript('screenshot', { path: file, window }, options)
}

/**
 * Click at screen coordinates.
 * @param {{ x: number, y: number, window?: string|null, activate?: boolean, right?: boolean }} options
 */
export async function clickAt({ x, y, window = null, activate = false, right = false, ...options }) {
  return runDesktopScript('click', { x, y, window, activate, right }, options)
}

/**
 * Type text into a window.
 * @param {{ text: string, window?: string|null, activate?: boolean }} options
 */
export async function typeText({ text, window = null, activate = false, ...options }) {
  return runDesktopScript('type', { text, window, activate }, options)
}

/**
 * Press virtual-key codes (see {@link VIRTUAL_KEYS}).
 * @param {{ virtualKeys: number[], window?: string|null, activate?: boolean }} options
 */
export async function pressKeys({ virtualKeys, window = null, activate = false, ...options }) {
  return runDesktopScript('keys', { virtualKeys, window, activate }, options)
}

/** The subset of virtual-key codes the key tool accepts by name. */
export const VIRTUAL_KEYS = {
  enter: 13,
  tab: 9,
  escape: 27,
  esc: 27,
  space: 32,
  backspace: 8,
  delete: 46,
  up: 38,
  down: 40,
  left: 37,
  right: 39,
  home: 36,
  end: 35,
  pageup: 33,
  pagedown: 34,
  f1: 112,
  f2: 113,
  f3: 114,
  f4: 115,
  f5: 116,
  f6: 117,
  f7: 118,
  f8: 119,
  f9: 120,
  f10: 121,
  f11: 122,
  f12: 123,
}

/**
 * Resolve a key name such as `enter`, `A`, or `Ctrl+A` into virtual-key codes.
 * A chord is rejected: the helper presses keys one after another, so a chord
 * would be a lie about what the desktop received.
 * @param {string[]} names
 * @returns {number[]}
 */
export function resolveVirtualKeys(names) {
  const out = []
  for (const raw of names) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    const lower = name.toLowerCase()
    if (Object.hasOwn(VIRTUAL_KEYS, lower)) {
      out.push(VIRTUAL_KEYS[lower])
      continue
    }
    if (/^[a-z]$/i.test(name)) {
      out.push(name.toUpperCase().charCodeAt(0))
      continue
    }
    if (/^\d$/.test(name)) {
      out.push(name.charCodeAt(0))
      continue
    }
    throw new Error(
      `unknown key "${name}"; use a letter, a digit, or one of: ${Object.keys(VIRTUAL_KEYS).join(', ')}`,
    )
  }
  if (out.length === 0) throw new Error('keys must name at least one key')
  return out
}

export { WM, POWERSHELL_TIMEOUT_MS }
