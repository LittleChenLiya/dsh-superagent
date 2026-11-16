import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  auditLayout,
  auditPackedFiles,
  auditRegistry,
  readRegisteredTools,
  readTarEntries,
  renderReport,
  runDoctor,
  satisfiesRange,
  TOOL_NAMES,
} from '../lib/doctor.js'

const NAME = '@xiangyixie/dsh-superagent'

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

async function writeFile(root, rel, content) {
  const abs = path.join(root, rel)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
}

function indexSource({ imported, tools }) {
  const imports = imported.map((name, index) => `import * as m${index} from './${name}.js'`)
  const registrations = tools.map(name => `ctx.tools.register(defineTool({
    name: '${name}',
    description: 'fixture tool',
    execute: async () => '',
  }))`)
  return `${imports.join('\n')}

function defineTool(spec) {
  return spec
}

export function apply(ctx) {
${registrations.map(block => `  ${block.split('\n').join('\n  ')}`).join('\n')}
}
`
}

async function createPackage(root, {
  version = '0.10.0',
  libFiles = ['index', 'store', 'memory', 'notify', 'lock'],
  imported = libFiles.filter(name => name !== 'index'),
  tools = TOOL_NAMES,
  declared = null,
} = {}) {
  const files = declared ?? [
    ...libFiles.map(name => `lib/${name}.js`),
    'bin/watch.js',
    'cordis.patch.yml',
    'README.md',
  ]
  const manifest = {
    name: NAME,
    version,
    type: 'module',
    main: 'lib/index.js',
    bin: { 'dsh-superagent-watch': 'bin/watch.js' },
    exports: {
      '.': './lib/index.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    },
    files,
    engines: { node: '>=24.9.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  await writeFile(root, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(root, 'lib/index.js', indexSource({ imported, tools }))
  for (const name of libFiles) {
    if (name === 'index') continue
    await writeFile(root, `lib/${name}.js`, 'export const value = 1\n')
  }
  await writeFile(root, 'bin/watch.js', "import { value } from '../lib/store.js'\nif (value !== 1) throw new Error('bad fixture')\n")
  await writeFile(root, 'cordis.patch.yml', `- insert:\n    - id: superagent\n      name: '${NAME}'\n`)
  await writeFile(root, 'README.md', '# fixture\n')
  return root
}

/** Files under `root`, relative and slash-separated. */
async function listFiles(root) {
  const found = []
  const walk = async dir => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else found.push(path.relative(root, abs).replace(/\\/g, '/'))
    }
  }
  await walk(root)
  return found.sort()
}

/** A ustar archive good enough for the reader under test. */
function tarBuffer(entries) {
  const chunks = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data)
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8)
    header.write('0000000\0', 108, 8)
    header.write('0000000\0', 116, 8)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12)
    header.write('00000000000\0', 136, 12)
    header.write('0', 156, 1)
    header.write('ustar\0', 257, 6)
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

async function tarOfDirectory(root) {
  const files = (await listFiles(root)).filter(file => file !== 'package.json')
  const entries = []
  for (const file of files) {
    entries.push({ name: `package/${file}`, data: await fsp.readFile(path.join(root, file)) })
  }
  return gzipSync(tarBuffer(entries))
}

function fakeRegistry(tarball) {
  return async url => {
    if (String(url).includes('/-/')) {
      return { ok: true, arrayBuffer: async () => tarball }
    }
    return { ok: true, json: async () => ({ dist: { tarball: `https://registry.test/${NAME}/-/pkg-0.10.0.tgz` } }) }
  }
}

function checkOf(result, id) {
  return result.checks.find(item => item.id === id)
}

test('a complete copy passes every blocking check', async t => {
  const root = await tempRoot(t)
  await createPackage(root)
  const result = await runDoctor({ packageRoot: root, profile: null, online: false })
  for (const id of ['node-engine', 'package-files', 'installed-copy', 'syntax', 'tools', 'patch']) {
    assert.equal(checkOf(result, id).status, 'pass', `${id}: ${checkOf(result, id).detail.join(' | ')}`)
  }
  assert.equal(result.ok, true)
  assert.equal(checkOf(result, 'tools').detail[0], '14/14 expected tools are registered')
})

test('a files whitelist that drops an imported module is caught, with the entry to add', async t => {
  const root = await tempRoot(t)
  await createPackage(root, {
    declared: ['lib/index.js', 'lib/store.js', 'lib/notify.js', 'lib/lock.js', 'bin/watch.js', 'cordis.patch.yml', 'README.md'],
  })
  const layout = await auditLayout(root)
  assert.deepEqual(layout.uncovered, ['lib/memory.js'])

  const result = await runDoctor({ packageRoot: root, profile: null, online: false })
  const files = checkOf(result, 'package-files')
  assert.equal(files.status, 'fail')
  assert.match(files.detail.join('\n'), /lib\/memory\.js/)
  assert.match(files.fix, /"lib\/memory\.js"/)
  assert.match(files.fix, /npm pack --dry-run/)

  // The pack guard sees the same hole without needing a tarball.
  const packed = await auditPackedFiles({ packageRoot: root, packed: layout.declared })
  assert.deepEqual(packed.missing, ['lib/memory.js'])
})

test('a half-unpacked 0.9.1 copy reports its file counts instead of failing silently', async t => {
  const root = await tempRoot(t)
  const libFiles = ['index', 'orchestrator', 'store', 'errors', 'usage', 'control', 'memory', 'notify', 'lock', 'watch', 'report']
  await createPackage(root, {
    version: '0.9.1',
    libFiles,
    imported: ['store'],
  })
  for (const name of libFiles.slice(5)) {
    await fsp.rm(path.join(root, 'lib', `${name}.js`))
  }

  const layout = await auditLayout(root)
  assert.equal(layout.libDeclared, 11)
  assert.equal(layout.libOnDisk, 5)

  const result = await runDoctor({ packageRoot: root, profile: null, online: false })
  const installed = checkOf(result, 'installed-copy')
  assert.equal(installed.status, 'fail')
  assert.match(installed.detail[0], /0\.9\.1/)
  assert.match(installed.detail[0], /lists 11 lib file\(s\).*only 5 are on disk/)
  assert.match(installed.detail.join('\n'), /lib\/control\.js/)
  assert.match(installed.fix, /0\.9\.1/)
  assert.equal(result.ok, false)
})

test('a truncated file is reported as unparsable, not as a missing one', async t => {
  const root = await tempRoot(t)
  await createPackage(root)
  await writeFile(root, 'lib/store.js', 'export const value = (\n')

  const result = await runDoctor({ packageRoot: root, profile: null, online: false })
  const syntax = checkOf(result, 'syntax')
  assert.equal(syntax.status, 'fail')
  assert.match(syntax.detail.join('\n'), /lib\/store\.js/)
})

test('a lost tool registration is counted against the expected set', async t => {
  const root = await tempRoot(t)
  await createPackage(root, { tools: TOOL_NAMES.slice(0, 4) })

  const result = await runDoctor({ packageRoot: root, profile: null, online: false })
  const tools = checkOf(result, 'tools')
  assert.equal(tools.status, 'fail')
  assert.match(tools.detail[0], /registered 4 of 14 expected tools/)
  assert.match(tools.detail.join('\n'), /superagent_resume/)
  assert.equal(readRegisteredTools(indexSource({ imported: [], tools: TOOL_NAMES })).length, 14)
})

test('node engine ranges accept the documented cases and reject older ones', () => {
  assert.equal(satisfiesRange('>=24.9.0', '24.14.1'), true)
  assert.equal(satisfiesRange('>=24.9.0', '24.8.9'), false)
  assert.equal(satisfiesRange('^24.9.0', '24.14.1'), true)
  assert.equal(satisfiesRange('^24.9.0', '25.0.0'), false)
  assert.equal(satisfiesRange('>=20 <25', '24.14.1'), true)
  assert.equal(satisfiesRange('>=20 <24', '24.14.1'), false)
  assert.equal(satisfiesRange('nonsense', '24.14.1'), false)
})

test('the registry comparison hashes the published tarball and names what differs', async t => {
  const root = await tempRoot(t)
  await createPackage(root)
  const tarball = await tarOfDirectory(root)

  const match = await auditRegistry({ packageRoot: root, fetchImpl: fakeRegistry(tarball) })
  assert.equal(match.status, 'pass', match.detail.join(' | '))
  assert.match(match.detail[0], /match @xiangyixie\/dsh-superagent@0\.10\.0 by sha256/)

  await writeFile(root, 'lib/store.js', 'export const value = 2\n')
  const mismatch = await auditRegistry({ packageRoot: root, fetchImpl: fakeRegistry(tarball) })
  assert.equal(mismatch.status, 'fail')
  assert.match(mismatch.detail.join('\n'), /lib\/store\.js/)

  const offline = await auditRegistry({
    packageRoot: root,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') },
  })
  assert.equal(offline.status, 'warn')
  assert.match(offline.detail[0], /registry comparison skipped/)
  assert.match(offline.fix, /npm view/)

  const entries = readTarEntries(tarball)
  assert.ok(entries.some(entry => entry.name === 'lib/index.js'))
})

test('a profile without the bundle row is reported as installed but not mounted', async t => {
  const root = await tempRoot(t)
  const profile = path.join(root, 'profiles', 'web')
  const installed = path.join(profile, 'node_modules', '@xiangyixie', 'dsh-superagent')
  await createPackage(installed)
  await writeFile(profile, 'cordis.yml', '[]\n')
  await writeFile(profile, 'package.json', `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: [NAME] } },
    dependencies: { [NAME]: 'file:./local.tgz' },
  }, null, 2)}\n`)

  const healthy = await runDoctor({ packageRoot: installed, profile, online: false })
  assert.equal(checkOf(healthy, 'profile').status, 'pass')
  assert.equal(checkOf(healthy, 'bundle').status, 'pass')
  assert.equal(healthy.ok, true)

  await writeFile(profile, 'package.json', `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    dependencies: { [NAME]: 'file:./local.tgz' },
  }, null, 2)}\n`)
  const unmounted = await runDoctor({ packageRoot: installed, profile, online: false })
  const bundle = checkOf(unmounted, 'bundle')
  assert.equal(bundle.status, 'fail')
  assert.match(bundle.detail.join('\n'), /never loaded/)
  assert.match(bundle.fix, /dsh plugin --profile web add @xiangyixie\/dsh-superagent@0\.10\.0/)
  assert.equal(unmounted.ok, false)
})

test('a missing profile is a failure, not a skipped check', async t => {
  const root = await tempRoot(t)
  await createPackage(root)
  const result = await runDoctor({
    packageRoot: root,
    profile: path.join(root, 'profiles', 'ghost'),
    online: false,
  })
  const profile = checkOf(result, 'profile')
  assert.equal(profile.status, 'fail')
  assert.match(profile.detail[0], /no profile at/)
  assert.match(profile.fix, /dsh plugin --profile ghost add/)
})

test('the report is plain text with copyable fix lines and no ANSI codes', async t => {
  const root = await tempRoot(t)
  await createPackage(root, {
    declared: ['lib/index.js', 'lib/store.js', 'bin/watch.js', 'cordis.patch.yml', 'README.md'],
  })
  const result = await runDoctor({ packageRoot: root, profile: null, online: false })
  const text = renderReport(result, { color: false })
  assert.doesNotMatch(text, /\u001b\[/)
  assert.match(text, /\[FAIL\] Package files/)
  assert.match(text, /\n       fix:\n       add the missing entry/)
  assert.match(text, /1 failed, 2 warning\(s\), /)
  assert.match(text, /blocking checks failed/)
})
