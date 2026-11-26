import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  IMPORTED_SKILL_PROVIDER,
  IMPORTED_SKILL_RANK,
  createImportedSkillProvider,
} from '../lib/imported-skills.js'
import {
  HARD_MAX_SKILL_MD_BYTES,
  SkillImporter,
  SkillImportError,
} from '../lib/skill-import.js'

const MARKDOWN = `---
name: local-review
description: Review a local document.
allowed-tools: [Read, Bash]
license: MIT
---
# Local review

Read the document. \`node -e "require('node:fs').writeFileSync('executed', 'yes')"\` is inert text.
`

function fakeSkills() {
  const calls = { registrations: 0, invalidations: 0, disposals: 0 }
  let provider
  let control = { invalidate: () => { calls.invalidations += 1 } }
  const skills = {
    registerProvider(factory) {
      calls.registrations += 1
      provider = factory(control)
      return () => { calls.disposals += 1 }
    },
  }
  return { skills, calls, get provider() { return provider }, control }
}

async function fixture(t, { disabled = false } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-imported-skills-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const source = path.join(base, 'source')
  const skillsDir = path.join(base, 'skills')
  await fsp.mkdir(source)
  await fsp.writeFile(path.join(source, 'SKILL.md'), MARKDOWN)
  const importer = new SkillImporter({ skillsDir })
  const record = await importer.import(source, { enabled: !disabled })
  return { base, source, skillsDir, importer, record }
}

function countingImporter(importer) {
  const calls = { lists: 0, gets: [] }
  return {
    calls,
    get skillsDir() { return importer.skillsDir },
    async list() { calls.lists += 1; return importer.list() },
    async get(name) { calls.gets.push(name); return importer.get(name) },
  }
}

async function rejectsCode(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof SkillImportError)
    assert.equal(error.code, code)
    return true
  })
}

async function symlinkOrSkip(t, target, link, type = 'file') {
  try {
    await fsp.symlink(target, link, process.platform === 'win32' && type === 'dir' ? 'junction' : type)
    return true
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`symbolic links are unavailable: ${error.code}`)
      return false
    }
    throw error
  }
}

test('hosts without registerProvider are reported as unsupported without registration', () => {
  assert.deepEqual(createImportedSkillProvider({ skills: {}, importer: {} }), { supported: false })
  assert.deepEqual(createImportedSkillProvider(), { supported: false })
})

test('registration is synchronous and lists only enabled imports with host candidate fields', async t => {
  const enabled = await fixture(t)
  const disabled = await fixture(t, { disabled: true })
  const importer = {
    calls: { lists: 0, gets: [] },
    get skillsDir() { return enabled.skillsDir },
    async list() {
      this.calls.lists += 1
      return [...await enabled.importer.list(), ...await disabled.importer.list()]
    },
    async get(name) { this.calls.gets.push(name); return enabled.importer.get(name) },
  }
  const host = fakeSkills()
  const lifecycle = createImportedSkillProvider({ skills: host.skills, importer, now: () => '2026-11-26T00:00:00.000Z' })

  assert.equal(host.calls.registrations, 1, 'registration must not wait for list()')
  assert.equal(lifecycle.supported, true)
  assert.equal(lifecycle.provider, host.provider)
  assert.equal(lifecycle.provider.name, IMPORTED_SKILL_PROVIDER)
  assert.equal(importer.calls.lists, 0, 'registration must not enumerate imports')
  assert.deepEqual(importer.calls.gets, [])

  const candidates = await lifecycle.provider.list({ modelInvocable: true })
  assert.equal(candidates.length, 1)
  assert.deepEqual(candidates[0], {
    name: 'local-review',
    description: 'Review a local document.',
    path: path.join(enabled.record.directory, 'SKILL.md'),
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: IMPORTED_SKILL_PROVIDER,
    rank: IMPORTED_SKILL_RANK,
    locator: 'local-review',
    resourceBase: { kind: 'directory', path: enabled.record.directory },
  })
  assert.equal(importer.calls.lists, 1)
  assert.deepEqual(importer.calls.gets, [], 'list must not load SKILL.md')
  assert.equal(lifecycle.status().lists, 1)
  assert.equal(lifecycle.status().lastListAt, '2026-11-26T00:00:00.000Z')
})

test('get loads by locator on demand, strips frontmatter, and never executes Skill text', async t => {
  const { importer, record, base } = await fixture(t)
  const counted = countingImporter(importer)
  const host = fakeSkills()
  const lifecycle = createImportedSkillProvider({ skills: host.skills, importer: counted })
  const [candidate] = await lifecycle.provider.list()
  assert.deepEqual(counted.calls.gets, [])

  const loaded = await lifecycle.provider.get({ ...candidate, path: '/ignored/untrusted/SKILL.md' })
  const realDirectory = await fsp.realpath(record.directory)
  assert.deepEqual(counted.calls.gets, ['local-review'])
  assert.equal(loaded.name, 'local-review')
  assert.equal(loaded.description, 'Review a local document.')
  assert.equal(loaded.path, path.join(realDirectory, 'SKILL.md'))
  assert.deepEqual(loaded.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(loaded.source, 'custom')
  assert.equal(loaded.provider, IMPORTED_SKILL_PROVIDER)
  assert.deepEqual(loaded.resourceBase, { kind: 'directory', path: realDirectory })
  assert.equal(loaded.content, '# Local review\n\nRead the document. `node -e "require(\'node:fs\').writeFileSync(\'executed\', \'yes\')"` is inert text.\n')
  assert.deepEqual(loaded.metadata, {
    name: 'local-review',
    description: 'Review a local document.',
    'allowed-tools': '[Read, Bash]',
    license: 'MIT',
  })
  assert.equal(lifecycle.status().gets, 1)
  await assert.rejects(fsp.lstat(path.join(base, 'executed')), { code: 'ENOENT' })
  await assert.rejects(fsp.lstat(path.join(process.cwd(), 'executed')), { code: 'ENOENT' })

  await lifecycle.provider.get(candidate)
  assert.deepEqual(counted.calls.gets, ['local-review', 'local-review'], 'get is intentionally uncached')
})

test('disabled, missing, and malformed candidates fail closed', async t => {
  const { importer } = await fixture(t, { disabled: true })
  const host = fakeSkills()
  const lifecycle = createImportedSkillProvider({ skills: host.skills, importer })
  assert.deepEqual(await lifecycle.provider.list(), [])
  await rejectsCode(() => lifecycle.provider.get({ locator: 'local-review' }), 'SKILL_DISABLED')
  await rejectsCode(() => lifecycle.provider.get({ locator: 'missing-skill' }), 'SKILL_NOT_FOUND')
  await rejectsCode(() => lifecycle.provider.get({ locator: '../escape' }), 'INVALID_CANDIDATE')
  await rejectsCode(() => lifecycle.provider.get({}), 'INVALID_CANDIDATE')
  assert.equal(lifecycle.status().errors, 4)
})

test('digest changes, oversize files, and manifest directory escapes are rejected on get', async t => {
  const digest = await fixture(t)
  const digestHost = fakeSkills()
  const digestLifecycle = createImportedSkillProvider({ skills: digestHost.skills, importer: digest.importer })
  const [digestCandidate] = await digestLifecycle.provider.list()
  const digestFile = path.join(digest.record.directory, 'SKILL.md')
  const changed = MARKDOWN.replace('Review a local document.', 'Review a remote document')
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(MARKDOWN))
  await fsp.writeFile(digestFile, changed)
  await rejectsCode(() => digestLifecycle.provider.get(digestCandidate), 'SKILL_DIGEST_MISMATCH')

  const oversized = await fixture(t)
  const oversizedHost = fakeSkills()
  const oversizedLifecycle = createImportedSkillProvider({ skills: oversizedHost.skills, importer: oversized.importer })
  const [oversizedCandidate] = await oversizedLifecycle.provider.list()
  await fsp.writeFile(path.join(oversized.record.directory, 'SKILL.md'), 'x'.repeat(HARD_MAX_SKILL_MD_BYTES + 1))
  await rejectsCode(() => oversizedLifecycle.provider.get(oversizedCandidate), 'FILE_TOO_LARGE')

  const escaped = await fixture(t)
  const escapedHost = fakeSkills()
  const escapedLifecycle = createImportedSkillProvider({ skills: escapedHost.skills, importer: escaped.importer })
  const [escapedCandidate] = await escapedLifecycle.provider.list()
  const manifestFile = path.join(escaped.record.directory, 'skill.json')
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'))
  manifest.directory = escaped.base
  await fsp.writeFile(manifestFile, JSON.stringify(manifest))
  await rejectsCode(() => escapedLifecycle.provider.get(escapedCandidate), 'PATH_TRAVERSAL')
})

test('SKILL.md symlinks are rejected without following them', async t => {
  const fileCase = await fixture(t)
  const fileHost = fakeSkills()
  const fileLifecycle = createImportedSkillProvider({ skills: fileHost.skills, importer: fileCase.importer })
  const [fileCandidate] = await fileLifecycle.provider.list()
  const skillFile = path.join(fileCase.record.directory, 'SKILL.md')
  const outsideFile = path.join(fileCase.base, 'outside.md')
  await fsp.writeFile(outsideFile, MARKDOWN)
  await fsp.rm(skillFile)
  if (await symlinkOrSkip(t, outsideFile, skillFile)) {
    await rejectsCode(() => fileLifecycle.provider.get(fileCandidate), 'SYMLINK_FORBIDDEN')
  }
})

test('imported-directory symlinks and junctions are rejected without following them', async t => {
  const directoryCase = await fixture(t)
  const directoryHost = fakeSkills()
  const directoryLifecycle = createImportedSkillProvider({ skills: directoryHost.skills, importer: directoryCase.importer })
  const [directoryCandidate] = await directoryLifecycle.provider.list()
  const importedDirectory = directoryCase.record.directory
  const movedDirectory = path.join(directoryCase.base, 'moved')
  await fsp.rename(importedDirectory, movedDirectory)
  if (await symlinkOrSkip(t, movedDirectory, importedDirectory, 'dir')) {
    await rejectsCode(() => directoryLifecycle.provider.get(directoryCandidate), 'SYMLINK_FORBIDDEN')
  }
})

test('invalidate delegates to host control and dispose is idempotent and terminal', async t => {
  const { importer } = await fixture(t)
  const host = fakeSkills()
  const lifecycle = createImportedSkillProvider({ skills: host.skills, importer })
  assert.equal(lifecycle.status().registered, true)
  assert.equal(lifecycle.status().disposed, false)
  assert.equal(lifecycle.invalidate(), undefined)
  assert.equal(host.calls.invalidations, 1)
  assert.equal(lifecycle.status().invalidations, 1)
  assert.ok(lifecycle.status().lastInvalidateAt)

  lifecycle.dispose()
  lifecycle.dispose()
  assert.equal(host.calls.disposals, 1)
  assert.equal(lifecycle.status().registered, false)
  assert.equal(lifecycle.status().disposed, true)
  assert.ok(lifecycle.status().disposedAt)
  await rejectsCode(() => lifecycle.provider.list(), 'PROVIDER_DISPOSED')
  await rejectsCode(() => lifecycle.provider.get({ locator: 'local-review' }), 'PROVIDER_DISPOSED')
  assert.throws(() => lifecycle.invalidate(), { code: 'PROVIDER_DISPOSED' })
  assert.equal(host.calls.invalidations, 1)
})

test('frontmatter identity must match the imported manifest', async t => {
  const { importer, record } = await fixture(t)
  const host = fakeSkills()
  const lifecycle = createImportedSkillProvider({ skills: host.skills, importer })
  const [candidate] = await lifecycle.provider.list()
  const changed = MARKDOWN.replace('name: local-review', 'name: other-review')
  await fsp.writeFile(path.join(record.directory, 'SKILL.md'), changed)
  const manifestFile = path.join(record.directory, 'skill.json')
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'))
  const entry = manifest.files.find(file => file.path === 'SKILL.md')
  entry.bytes = Buffer.byteLength(changed)
  entry.sha256 = createHash('sha256').update(changed).digest('hex')
  manifest.totalBytes += entry.bytes - MARKDOWN.length
  await fsp.writeFile(manifestFile, JSON.stringify(manifest))
  await rejectsCode(() => lifecycle.provider.get(candidate), 'CORRUPT_MANIFEST')
})
