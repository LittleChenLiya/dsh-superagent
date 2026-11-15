#!/usr/bin/env node
/**
 * Live proof for the desktop half of runtime control.
 *
 * It opens a test window that is deliberately built to never take focus
 * (`WS_EX_NOACTIVATE` + `ShowWithoutActivation`), then proves three things
 * against it through the real tools:
 *
 * 1. `desktop_windows` sees it in the real window list;
 * 2. a background click arrives (the window counts the click in a state file);
 * 3. background `WM_CHAR` text arrives (the window appends the characters);
 * 4. `desktop_screenshot` captures that window with PrintWindow.
 *
 * Using our own no-activate window is the point: the user's foreground window is
 * never touched, and the assertions come from the target process, not from the
 * tool's own report.
 *
 * Usage: node scripts/runtime-desktop-demo.mjs [--out <dir>]
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAuditor } from '../lib/audit.js'
import { createRuntimeControl } from '../lib/runtime-control.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outDir = path.resolve(outIndex >= 0 ? argv[outIndex + 1] : path.join(root, '.runtime-demo'))
const title = 'DSH desktop test'
const typedText = 'posted characters arrived'

/** A WinForms form that refuses activation and records what it receives. */
const WINDOW_SOURCE = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class NoActivateForm : Form {
  public int Clicks;
  public string Typed = "";
  public string StatePath = "";

  public NoActivateForm() {
    Text = "DSH desktop test";
    Width = 520;
    Height = 260;
    StartPosition = FormStartPosition.Manual;
    Location = new Point(60, 60);
    Label banner = new Label();
    banner.Text = "no-activate window: background input only";
    banner.AutoSize = true;
    banner.Location = new Point(20, 20);
    Controls.Add(banner);
    Label counter = new Label();
    counter.Name = "counter";
    counter.Text = "clicks: 0";
    counter.AutoSize = true;
    counter.Location = new Point(20, 60);
    Controls.Add(counter);
    Label typed = new Label();
    typed.Name = "typed";
    typed.Text = "typed: ";
    typed.AutoSize = true;
    typed.Location = new Point(20, 100);
    Controls.Add(typed);
    MouseDown += (sender, args) => {
      Clicks += 1;
      counter.Text = "clicks: " + Clicks;
      Save();
    };
    Shown += (sender, args) => Save();
  }

  protected override bool ShowWithoutActivation { get { return true; } }

  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
      return cp;
    }
  }

  protected override void WndProc(ref Message message) {
    // WM_CHAR: exactly what the background typing path posts.
    if (message.Msg == 0x0102) {
      Typed += (char)message.WParam;
      foreach (Control control in Controls) {
        if (control.Name == "typed") control.Text = "typed: " + Typed;
      }
      Save();
    }
    base.WndProc(ref message);
  }

  public void Save() {
    if (StatePath.Length == 0) return;
    string escaped = Typed.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
    File.WriteAllText(StatePath, "{\"clicks\":" + Clicks + ",\"typed\":\"" + escaped + "\"}", new UTF8Encoding(false));
  }
}
`

const WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${WINDOW_SOURCE}
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing
$form = New-Object NoActivateForm
$form.StatePath = $env:DSH_DEMO_STATE
[System.Windows.Forms.Application]::Run($form)
`

const stateFile = path.join(outDir, 'desktop-state.json')
await fsp.mkdir(path.join(outDir, 'shots'), { recursive: true })
await fsp.writeFile(stateFile, '{"clicks":0,"typed":""}', 'utf8')

const audit = createAuditor({ dir: path.join(outDir, 'audit'), warn: message => console.error(`[warn] ${message}`) })
const runtime = createRuntimeControl({
  config: {
    enabled: true,
    browser: { enabled: false },
    desktop: { enabled: true, allowActivation: false },
    shotDir: path.join(outDir, 'shots'),
    stopFile: path.join(outDir, 'STOP'),
  },
  stateRoot: outDir,
  auditor: audit,
  warn: message => console.error(`[warn] ${message}`),
})
const tool = name => runtime.tools.find(entry => entry.name === name)
const readState = async () => JSON.parse(await fsp.readFile(stateFile, 'utf8'))

const enabled = Buffer.from(WINDOW_SCRIPT, 'utf16le').toString('base64')
const window = spawn('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', enabled,
], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    TEMP: path.join(process.env.LOCALAPPDATA ?? outDir, 'Temp', 'dsh-runtime-control'),
    TMP: path.join(process.env.LOCALAPPDATA ?? outDir, 'Temp', 'dsh-runtime-control'),
    DSH_DEMO_STATE: stateFile,
  },
})

let failure = null
try {
  let rect = null
  for (let attempt = 0; attempt < 40 && !rect; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    const listing = await tool('desktop_windows').execute({ filter: title, limit: 5 })
    const line = listing.split('\n').find(row => row.includes(title))
    const match = line && /\s(\d+),(\d+) (\d+)×(\d+)/.exec(line)
    if (match) rect = { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }
  }
  if (!rect) throw new Error(`the test window titled "${title}" never appeared`)
  console.log(`### desktop_windows\nfound "${title}" at ${rect.x},${rect.y} ${rect.width}×${rect.height}`)

  const point = { x: rect.x + 120, y: rect.y + 90 }
  console.log(`\n### desktop_click (background, no activation)\n${await tool('desktop_click').execute({ ...point, window: title })}`)
  await new Promise(resolve => setTimeout(resolve, 300))
  const afterClick = await readState()
  console.log(`state after click: ${JSON.stringify(afterClick)}`)
  if (afterClick.clicks < 1) failure = 'the posted click never reached the window'

  console.log(`\n### desktop_type (background)\n${await tool('desktop_type').execute({ text: typedText, window: title })}`)
  await new Promise(resolve => setTimeout(resolve, 400))
  const afterType = await readState()
  console.log(`state after type: ${JSON.stringify(afterType)}`)
  if (afterType.typed !== typedText) {
    failure = failure ?? `the posted characters did not arrive intact: ${JSON.stringify(afterType.typed)}`
  }

  const shotPath = path.join(outDir, 'shots', 'desktop-window.png')
  console.log(`\n### desktop_screenshot (window)\n${await tool('desktop_screenshot').execute({ window: title, path: shotPath })}`)
  const stat = await fsp.stat(shotPath)
  if (stat.size < 1000) failure = failure ?? 'the window screenshot is suspiciously small'
} catch (error) {
  failure = error?.stack ?? String(error)
} finally {
  window.kill()
  await runtime.dispose().catch(() => {})
}

const { events } = await audit.query({ source: 'runtime', limit: 100 })
console.log(`\n### audit trail (${audit.file}) — ${events.length} runtime event(s)`)
for (const event of events) {
  console.log(JSON.stringify({
    at: event.at,
    kind: event.kind,
    action: event.action,
    target: event.target,
    decision: event.decision,
    result: event.result,
    durationMs: event.durationMs,
    rule: event.rule,
  }))
}

if (failure) {
  console.error(`\nDEMO FAILED: ${failure}`)
  process.exit(1)
}
console.log('DEMO OK')
