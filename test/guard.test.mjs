import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { createGuard } from '../lib/guard.js'
import { approvePlan, createCandidatePlanPreview } from '../lib/plan-preview.js'

const BASE = {
  cwd: 'C:\\work\\proj',
  homedir: 'C:\\Users\\tester',
  tmpdir: 'C:\\Temp',
  platform: 'win32',
  env: {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    ProgramData: 'C:\\ProgramData',
    USERPROFILE: 'C:\\Users\\tester',
  },
}

function harness(config) {
  const guard = createGuard({ ...BASE, config })
  guard.bindChild('child-1', { runId: 'run-1', label: 'superagent-1' })
  const call = (name, args, agent = { id: 'child-1' }) => guard.checkToolCall({ name, arguments: args, agent })
  return { guard, call }
}

function contractHarness(permissionScope, config = {}) {
  const guard = createGuard({ ...BASE, config })
  guard.bindChild('child-1', {
    runId: 'run-contract',
    label: 'contract-child',
    executionContract: {
      permissionScope,
      runtime: { isolation: 'workspace' },
      planDigest: 'sha256:test-plan',
    },
  })
  const call = (name, args, agent = { id: 'child-1' }) => guard.checkToolCall({ name, arguments: args, agent })
  return { guard, call }
}

test('a worker may write inside its workspace and the OS temp directory', () => {
  const { call, guard } = harness()
  assert.equal(call('write', { file_path: 'C:\\work\\proj\\src\\index.js' }).blocked, false)
  assert.equal(call('write', { file_path: 'C:\\work\\proj\\dist\\out.js' }).blocked, false)
  assert.equal(call('write', { file_path: 'C:\\Temp\\scratch.txt' }).blocked, false)
  assert.equal(call('edit', { file_path: 'src\\index.js', old_string: 'a', new_string: 'b' }).blocked, false)
  assert.equal(guard.snapshot('run-1'), null, 'normal calls are not recorded as guard events')
})

test('writing outside the workspace is refused and names the allowlist rule', () => {
  const { call } = harness()
  const write = call('write', { file_path: 'C:\\work\\other\\index.js' })
  assert.equal(write.blocked, true)
  assert.equal(write.rule, 'path/outside-allowlist')
  assert.match(write.reason, /outside every allowed write root/)
  assert.match(write.reasonText, /rule path\/outside-allowlist/)
  assert.match(write.reasonText, /did not run/)
})

test('system directories are writable by nobody', () => {
  const { call } = harness()
  const write = call('write', { file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' })
  assert.equal(write.blocked, true)
  assert.equal(write.rule, 'path/system-directory')
  const programFiles = call('write', { file_path: 'C:\\Program Files\\app\\config.ini' })
  assert.equal(programFiles.rule, 'path/system-directory')
})

test('credential stores are refused for reading and writing', () => {
  const { call } = harness()
  for (const file of [
    'C:\\Users\\tester\\.ssh\\authorized_keys',
    'C:\\Users\\tester\\.aws\\credentials',
    'C:\\Users\\tester\\.npmrc',
    'C:\\Users\\tester\\.git-credentials',
    'C:\\work\\proj\\.git\\config',
  ]) {
    const read = call('read', { file_path: file })
    assert.equal(read.blocked, true, file)
    assert.match(read.rule, /^path\/(credentials|git-control)$/, file)
  }
  assert.equal(call('write', { file_path: 'C:\\Users\\tester\\.ssh\\known_hosts' }).rule, 'path/credentials')
})

test('reading a system file stays legal; reading a credential does not', () => {
  const { call } = harness()
  assert.equal(call('read', { file_path: 'C:\\Windows\\win.ini' }).blocked, false)
  assert.equal(call('read', { file_path: 'C:\\Users\\tester\\.ssh\\id_rsa' }).rule, 'path/credentials')
})

test('an apply_patch touching the system directory is refused', () => {
  const { call } = harness()
  const patch = [
    '*** Begin Patch',
    '*** Add File: C:\\Windows\\System32\\evil.dll',
    '+binary',
    '*** End Patch',
  ].join('\n')
  const verdict = call('apply_patch', { input: patch })
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.rule, 'path/system-directory')

  const local = '*** Begin Patch\n*** Update File: src\\index.js\n@@\n-a\n+b\n*** End Patch'
  assert.equal(call('apply_patch', { input: local }).blocked, false)
})

test('recursive forced deletes are judged by their target', () => {
  const { call } = harness()
  for (const command of ['rm -rf /', 'rm -rf ~', 'rm -rf .', 'rm -rf ..', 'rm -rf *', 'Remove-Item -Recurse -Force C:\\Windows']) {
    const verdict = call('bash', { command })
    assert.equal(verdict.blocked, true, command)
    assert.match(verdict.rule, /^(cmd\/recursive-force-delete|path\/system-directory)$/, command)
  }
  for (const command of ['rm -rf build', 'rm -rf node_modules', 'rm -rf C:\\work\\proj\\dist']) {
    assert.equal(call('bash', { command }).blocked, false, command)
  }
})

test('the default command rules block disk, scheduler, registry, and system writes', () => {
  const { call } = harness()
  const blocked = {
    'format C: /q': 'cmd/disk-format',
    'mkfs.ext4 /dev/sda1': 'cmd/disk-format',
    'diskpart /s script.txt': 'cmd/disk-format',
    'schtasks /create /tn evil /tr calc.exe': 'cmd/system-scheduler',
    'reg add HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v evil /d calc.exe': 'cmd/system-registry',
    'echo pwn > C:\\Windows\\System32\\evil.bat': 'path/system-directory',
    'echo pwn > /etc/hosts': /^(cmd\/system-write|path\/system-directory|path\/outside-allowlist)$/,
    'cat ~/.ssh/id_rsa': 'cmd/credential-access',
    'chmod -R 777 /': 'cmd/permission-nuke',
  }
  for (const [command, rule] of Object.entries(blocked)) {
    const verdict = call('bash', { command })
    assert.equal(verdict.blocked, true, command)
    if (rule instanceof RegExp) assert.match(verdict.rule, rule, command)
    else assert.equal(verdict.rule, rule, command)
  }
})

test('alternate file and terminal tools use the same policy', () => {
  const { call } = harness()
  assert.equal(call('str_replace_editor', { command: 'create', path: 'C:\\Windows\\x.txt', file_text: 'x' }).blocked, true)
  assert.equal(call('str_replace_editor', { command: 'view', path: 'C:\\Users\\tester\\.ssh\\id_rsa' }).rule, 'path/credentials')
  assert.equal(call('str_replace_editor', { command: 'str_replace', path: 'src\\index.js' }).blocked, false)
  assert.equal(call('terminal_send', { sessionId: 't1', text: 'rm -rf /' }).blocked, true)
  assert.equal(call('terminal_send', { sessionId: 't1', text: 'npm test' }).blocked, false)
})

test('normal development commands are not blocked', () => {
  const { call, guard } = harness()
  for (const command of [
    'npm test',
    'git status',
    'git diff --stat',
    'mkdir -p src/components',
    'node scripts/build.js',
    'echo hello > notes.txt',
    'cp README.md docs\\README.md',
    'rm -rf node_modules',
    'eslint .',
  ]) {
    assert.equal(call('bash', { command }).blocked, false, command)
  }
  assert.equal(guard.snapshot('run-1'), null)
})

test('an explicit allow is recorded and overrides the matching denial', () => {
  const { guard, call } = harness({
    allowCommands: [
      { id: 'clean-build', pattern: '^rm -rf build$', reason: 'clean build output' },
      { id: 'root-reset', pattern: '^rm -rf /$', reason: 'lab machine reset' },
    ],
  })
  const normal = call('bash', { command: 'rm -rf build' })
  assert.equal(normal.blocked, false)
  assert.equal(normal.explicitAllow, true)
  assert.equal(normal.rule, 'allow/clean-build')

  const override = call('bash', { command: 'rm -rf /' })
  assert.equal(override.blocked, false)
  assert.equal(override.rule, 'allow/root-reset')
  assert.equal(override.overridden, 'cmd/recursive-force-delete')

  const snapshot = guard.snapshot('run-1')
  assert.equal(snapshot.blocked, 0)
  assert.equal(snapshot.allowed, 2)
  assert.equal(snapshot.byRule['allow/clean-build'], 1)
  assert.equal(snapshot.byRule['allow/root-reset'], 1)
  assert.equal(snapshot.events[1].overridden, 'cmd/recursive-force-delete')
  assert.match(guard.reportSection('run-1'), /2 explicit allow\(s\) recorded/)
})

test('blocked events are counted, attributed, and capped', () => {
  const { guard, call } = harness({ maxEvents: 2 })
  call('write', { file_path: 'C:\\Windows\\a' })
  call('bash', { command: 'rm -rf /' })
  call('read', { file_path: 'C:\\Users\\tester\\.ssh\\id_rsa' })
  const snapshot = guard.snapshot('run-1')
  assert.equal(snapshot.blocked, 3)
  assert.equal(snapshot.events.length, 2)
  assert.equal(snapshot.omitted, 1)
  assert.equal(snapshot.byRule['path/system-directory'], 1)
  assert.equal(snapshot.byRule['cmd/recursive-force-delete'], 1)
  assert.equal(snapshot.events[0].label, 'superagent-1')
  assert.match(guard.reportSection('run-1'), /further event\(s\) were counted/)
})

test('the OS temp directory stays writable even under a system path', () => {
  const guard = createGuard({
    ...BASE,
    tmpdir: 'C:\\Windows\\TEMP',
    config: {},
  })
  guard.bindChild('child-1', { runId: 'run-1' })
  const call = (name, args) => guard.checkToolCall({ name, arguments: args, agent: { id: 'child-1' } })
  assert.equal(call('write', { file_path: 'C:\\Windows\\TEMP\\scratch.txt' }).blocked, false)
  assert.equal(call('bash', { command: 'rm -rf C:\\Windows\\TEMP\\build' }).blocked, false)
  assert.equal(call('write', { file_path: 'C:\\Windows\\TEMP2\\scratch.txt' }).blocked, true)
})

test('a quoted node script is not mistaken for a redirect', () => {
  // The real incident ran with cwd=C:\ and was blocked as `C:\^`. Operators
  // inside a quoted -e body must never be read as write targets.
  const guard = createGuard({ ...BASE, cwd: 'C:\\', config: {} })
  guard.bindChild('child-1', { runId: 'run-1' })
  const call = (name, args) => guard.checkToolCall({ name, arguments: args, agent: { id: 'child-1' } })
  const commands = [
    'node -e "console.log(1 > 0)"',
    'node -e "const f = x => x + 1"',
    "node -e \"const r = /^a/.test('a')\"",
    'node -e "const n = 1 ^ 2; console.log(n)"',
  ]
  for (const command of commands) {
    assert.equal(call('bash', { command }).blocked, false, command)
  }
  assert.equal(guard.snapshot('run-1'), null, 'no guard event is recorded for a quoted script')
})

test('a real redirect outside the workspace is still refused', () => {
  const guard = createGuard({ ...BASE, cwd: 'C:\\', config: {} })
  guard.bindChild('child-1', { runId: 'run-1' })
  const verdict = guard.checkToolCall({
    name: 'bash',
    arguments: { command: 'echo x > C:\\Windows\\System32\\drivers\\etc\\hosts.bak' },
    agent: { id: 'child-1' },
  })
  assert.equal(verdict.blocked, true)
  assert.match(verdict.rule, /^path\/(system-directory|outside-allowlist)$/)
})

test('an unrelated session and a disabled guard are never policed', () => {
  const { call, guard } = harness()
  assert.equal(call('write', { file_path: 'C:\\Windows\\x' }, { id: 'parent-session' }).blocked, false)
  assert.equal(guard.snapshot('run-1'), null)

  const disabled = harness({ enabled: false })
  assert.equal(disabled.call('bash', { command: 'rm -rf /' }).blocked, false)
  assert.equal(disabled.guard.enabled, false)
})

test('an invalid custom pattern is ignored instead of breaking the guard', () => {
  const warnings = []
  const guard = createGuard({ ...BASE, warn: message => warnings.push(message), config: { denyCommands: [{ id: 'bad', pattern: '(' }] } })
  guard.bindChild('child-1', { runId: 'run-1' })
  const verdict = guard.checkToolCall({ name: 'bash', arguments: { command: 'npm test' }, agent: { id: 'child-1' } })
  assert.equal(verdict.blocked, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /invalid cmd\/custom pattern/)
})

test('an execution contract allows normalized read and write categories', () => {
  const { call, guard } = contractHarness({
    tools: [' READ ', 'workspace.write'],
    allow: ['fs.read', 'file.write'],
    deny: ['network.request'],
    approvalMode: 'policy',
  })
  for (const [name, args] of [
    ['read_file', { file_path: 'src\\index.js' }],
    ['list_directory', { path: 'src' }],
    ['search_files', { path: 'src', query: 'guard' }],
    ['write_file', { file_path: 'src\\index.js', content: 'x' }],
    ['edit_file', { file_path: 'src\\index.js' }],
    ['create_file', { file_path: 'src\\new.js' }],
    ['delete_file', { file_path: 'src\\old.js' }],
    ['move_file', { file_path: 'src\\index.js' }],
    ['copy_file', { file_path: 'src\\index.js' }],
    ['apply_patch', { input: '*** Begin Patch\n*** Add File: src\\new.js\n+x\n*** End Patch' }],
  ]) {
    const verdict = call(name, args)
    assert.equal(verdict.blocked, false, name)
    assert.equal(verdict.rule, null, name)
    assert.equal(verdict.explicitAllow, undefined, name)
  }
  assert.equal(guard.snapshot('run-contract'), null)
})

test('an approved auto candidate plan allows its normalized read and edit tools while deny still wins', () => {
  const input = {
    goal: 'Update the release notes',
    project: BASE.cwd,
    subtasks: [{
      id: 'release-notes',
      operations: [
        { type: 'read', path: 'README.md' },
        { type: 'edit', path: 'README.md' },
      ],
    }],
    capabilities: ['filesystem.read', 'filesystem.write'],
    permissionScope: {
      tools: ['read_file', 'write', 'edit'],
      allow: [],
      deny: ['network.request'],
      approvalMode: 'policy',
    },
    runtime: { cwd: BASE.cwd, isolation: 'workspace', provider: 'host' },
  }
  const preview = createCandidatePlanPreview(input)
  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.permissionScope.allow, ['filesystem.read', 'filesystem.write'])
  const credential = approvePlan(preview, { planDigest: preview.planDigest })
  assert.deepEqual(credential.permissionScope.deny, ['network'])
  assert.equal(credential.permissionScope.approvalMode, 'policy')

  const approved = contractHarness(credential.permissionScope)
  assert.equal(approved.call('read_file', { file_path: 'README.md' }).blocked, false)
  assert.equal(approved.call('edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' }).blocked, false)

  const deniedInput = structuredClone(input)
  deniedInput.permissionScope.deny = ['edit']
  const deniedPreview = createCandidatePlanPreview(deniedInput)
  assert.equal(deniedPreview.status, 'blocked')
  assert.ok(deniedPreview.issues.some(item => item.code === 'tool_denied'))
  const denied = contractHarness(deniedPreview.permissionScope)
  assert.equal(denied.call('read_file', { file_path: 'README.md' }).blocked, false)
  const edit = denied.call('edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' })
  assert.equal(edit.blocked, true)
  assert.equal(edit.rule, 'contract/permission-denied')
  assert.match(edit.reason, /filesystem\.write/)
})

test('filesystem.read denial blocks read, list, search, and every shell host tool', () => {
  const { call } = contractHarness({ tools: ['*'], allow: ['*'], deny: ['fs.read'] })
  for (const name of ['read', 'read_file', 'list_directory', 'search', 'search_files', 'glob', 'grep']) {
    const verdict = call(name, { file_path: 'src\\index.js', path: 'src', query: 'x' })
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/permission-denied', name)
    assert.match(verdict.reason, /filesystem\.read/)
    assert.match(verdict.reasonText, /revised execution contract/)
  }
  for (const name of ['bash', 'pwsh', 'terminal', 'run_command']) {
    const verdict = call(name, { command: 'echo hello', text: 'echo hello' })
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/permission-denied', name)
  }
})

test('filesystem.write denial blocks write, edit, create, delete, move, copy, patch, and shell', () => {
  const { call } = contractHarness({ tools: ['*'], allow: ['*'], deny: ['file.write'] })
  for (const name of ['write', 'write_file', 'edit', 'create_file', 'delete_file', 'move_file', 'copy_file', 'apply_patch']) {
    const verdict = call(name, { file_path: 'src\\index.js', path: 'src\\index.js', input: '' })
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/permission-denied', name)
    assert.match(verdict.reason, /filesystem\.write/)
  }
  for (const name of ['bash', 'pwsh', 'terminal', 'run_command']) {
    const verdict = call(name, { command: 'echo hello', text: 'echo hello' })
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/permission-denied', name)
  }
})

test('shell.execute denial blocks shell tools without denying ordinary file work', () => {
  const { call } = contractHarness({ tools: ['*'], allow: ['*'], deny: ['execute'] })
  for (const name of ['bash', 'pwsh', 'terminal', 'terminal_send', 'run_command']) {
    const verdict = call(name, { command: 'echo hello', text: 'echo hello' })
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/permission-denied', name)
    assert.match(verdict.reason, /shell\.execute/)
  }
  assert.equal(call('read_file', { file_path: 'src\\index.js' }).blocked, false)
  assert.equal(call('write_file', { file_path: 'src\\index.js', content: 'x' }).blocked, false)

  const allowed = contractHarness({ tools: ['bash'], deny: [] })
  assert.equal(allowed.call('bash', { command: 'echo hello' }).blocked, false)
})

test('network denial blocks web, search, browser, http, and fetch tools', () => {
  const { call } = contractHarness({ tools: ['*'], allow: ['*'], deny: ['net'] })
  for (const name of ['web', 'search', 'web_search', 'browser_navigate', 'http_request', 'fetch']) {
    const verdict = call(name, { url: 'https://example.com', query: 'x' })
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/permission-denied', name)
    assert.match(verdict.reason, /network/)
  }
  assert.equal(call('search_files', { path: 'src', query: 'x' }).blocked, false, 'local search remains a read')
})

test('contract denial wins over tools, allow, and global command allows', () => {
  const { call, guard } = contractHarness({
    tools: ['filesystem.read', 'filesystem.write'],
    allow: ['*'],
    deny: ['filesystem.write'],
  }, {
    allowCommands: [{ id: 'all-commands', pattern: '.*', reason: 'lab override' }],
  })
  for (const [name, args] of [
    ['write_file', { file_path: 'src\\index.js', content: 'x' }],
    ['bash', { command: 'rm -rf /' }],
  ]) {
    const verdict = call(name, args)
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/permission-denied', name)
    assert.equal(verdict.explicitAllow, undefined, name)
  }
  const snapshot = guard.snapshot('run-contract')
  assert.equal(snapshot.blocked, 2)
  assert.equal(snapshot.allowed, 0)
})

test('permissionScope.tools and allow restrict mapped abstract categories', () => {
  const { call } = contractHarness({ tools: ['read_file'], deny: [] })
  assert.equal(call('read', { file_path: 'src\\index.js' }).blocked, false)
  assert.equal(call('mcp__local__read_file', { file_path: 'src\\index.js' }).blocked, false)
  for (const [name, args] of [
    ['write_file', { file_path: 'src\\index.js' }],
    ['web_search', { query: 'x' }],
    ['bash', { command: 'echo hello' }],
  ]) {
    const verdict = call(name, args)
    assert.equal(verdict.blocked, true, name)
    assert.equal(verdict.rule, 'contract/tool-not-allowed', name)
  }

  const allowed = contractHarness({ tools: ['*'], allow: ['filesystem.read'], deny: [] })
  assert.equal(allowed.call('list_directory', { path: 'src' }).blocked, false)
  assert.equal(allowed.call('write_file', { file_path: 'src\\index.js' }).rule, 'contract/tool-not-allowed')
})

test('unknown tools require an explicit wildcard approval while uncontracted tools keep global guard', () => {
  const guard = createGuard({ ...BASE, config: {} })
  guard.bindChild('contracted', {
    runId: 'run-contract',
    executionContract: { permissionScope: { tools: ['filesystem.read'], deny: [] } },
  })
  guard.bindChild('uncontracted', { runId: 'run-plain' })
  const args = { value: 'x' }
  const contracted = guard.checkToolCall({ name: 'vendor_custom_tool', arguments: args, agent: { id: 'contracted' } })
  const uncontracted = guard.checkToolCall({ name: 'vendor_custom_tool', arguments: args, agent: { id: 'uncontracted' } })
  assert.equal(contracted.blocked, true)
  assert.equal(contracted.rule, 'contract/tool-not-approved')
  assert.equal(uncontracted.blocked, false)
  assert.equal(uncontracted.rule, null)
  assert.ok(guard.snapshot('run-contract').events.some(event => event.rule === 'contract/tool-not-approved'))
  assert.equal(guard.snapshot('run-plain'), null)
})

test('unbinding a child removes its execution contract', () => {
  const { call, guard } = contractHarness({ tools: ['*'], allow: ['*'], deny: ['filesystem.write'] })
  assert.equal(call('write_file', { file_path: 'src\\index.js' }).rule, 'contract/permission-denied')
  guard.unbindChild('child-1')
  assert.equal(call('write_file', { file_path: 'src\\index.js' }).blocked, false)
  assert.equal(guard.snapshot('run-contract').blocked, 1)

  guard.bindChild('child-1', { runId: 'run-contract' })
  assert.equal(call('write_file', { file_path: 'src\\index.js' }).blocked, false)
  assert.equal(call('write', { file_path: 'C:\\Windows\\x.txt' }).rule, 'path/system-directory')
})

test('an execution contract never relaxes global path and command policy', () => {
  const { call } = contractHarness({ tools: ['*'], allow: ['*'], deny: [] })
  assert.equal(call('write', { file_path: 'C:\\Windows\\System32\\x.txt' }).rule, 'path/system-directory')
  assert.equal(call('bash', { command: 'rm -rf /' }).rule, 'cmd/recursive-force-delete')
})

/**
 * Mount the plugin with a fake host that has a `tools.guard` hook, then fire a
 * worker command through that hook while the run is live.
 */
test('a blocked worker call reaches status and the final report', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-guard-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const hooks = []
  const workerUp = gate()
  const workerDone = gate()
  const ctx = {
    tools: {
      register: tool => tools.set(tool.name, tool),
      guard: fn => {
        hooks.push(fn)
        return () => {}
      },
    },
    subagents: {
      async startActivation(spec) {
        if (spec.label === 'superagent-plan') {
          return {
            childId: 'child-plan',
            result: Promise.resolve({
              output: [{ type: 'text', text: JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }) }],
              stopReason: 'completed',
            }),
            dispose: async () => {},
          }
        }
        workerUp.open()
        return {
          childId: 'child-worker',
          result: (async () => {
            await workerDone.opened
            return { output: [{ type: 'text', text: 'the answer' }], stopReason: 'completed' }
          })(),
          dispose: async () => {},
        }
      },
    },
    get: () => undefined,
    effect: callback => callback(),
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: false })
    assert.equal(hooks.length, 1, 'the plugin mounts one tool guard')

    const started = tools.get('superagent_start').execute(
      { goal: 'guard integration', wait_seconds: 10 },
      { agent: { id: 'session-1' } },
    )
    await workerUp.opened
    // The plugin binds the child to its run right after `startActivation`
    // resolves; let that continuation run before firing the host hook.
    await new Promise(resolve => setTimeout(resolve, 20))

    const denied = hooks[0]({
      name: 'bash',
      arguments: { command: 'rm -rf /' },
      agent: { id: 'child-worker', session: { header: { cwd: stateDir } } },
    })
    assert.match(denied, /rule cmd\/recursive-force-delete/)
    assert.match(denied, /did not run/)
    workerDone.open()

    const rendered = await started
    assert.match(rendered, /guard: 1 tool call\(s\) blocked/)
    assert.match(rendered, /cmd\/recursive-force-delete/)
    const runId = /run (\S+) —/.exec(rendered)?.[1]
    assert.ok(runId, 'the started result carries the run id')

    const status = await tools.get('superagent_status').execute({ run_id: runId })
    assert.match(status, /guard: 1 tool call\(s\) blocked/)
    assert.match(status, /blocked bash/) 
    assert.match(status, /## Safety guard/)
    assert.match(status, /1 tool call\(s\) blocked/)

    const run = JSON.parse(await fsp.readFile(path.join(stateDir, 'runs', `${runId}.json`), 'utf8'))
    assert.equal(run.guard.blocked, 1)
    assert.equal(run.guard.byRule['cmd/recursive-force-delete'], 1)
    assert.match(run.report, /## Safety guard/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})

function gate() {
  let open
  const opened = new Promise(resolve => {
    open = resolve
  })
  return { opened, open: () => open() }
}
