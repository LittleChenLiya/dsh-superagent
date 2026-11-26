import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SkillImportError,
  SkillImporter,
  assertSafeRelativePath,
  createSkillImporter,
  importLocalSkill,
  importSkillDirectory,
  inspectLocalSkill,
  parseSkillFrontmatter,
  previewPermissions,
} from '../lib/skill-import.js'

const DEFAULT_SKILL = `---
name: safe-skill
description: A safe local Skill.
allowed-tools: [Read, Bash]
---
# Safe Skill

This is documentation. \`node -e "require('node:fs').writeFileSync('executed', 'yes')"\` must never run.
`

async function fixture(t, { markdown = DEFAULT_SKILL, files = {} } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-skill-import-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const source = path.join(base, 'source')
  const skillsDir = path.join(base, 'skills')
  await fsp.mkdir(source)
  await fsp.writeFile(path.join(source, 'SKILL.md'), markdown)
  for (const [relative, contents] of Object.entries(files)) {
    assertSafeRelativePath(relative)
    const target = path.join(source, ...relative.split('/'))
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, contents)
  }
  return { base, source, skillsDir }
}

async function rejectsCode(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof SkillImportError)
    assert.equal(error.code, code)
    return true
  })
}

async function exists(file) {
  try {
    await fsp.lstat(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function symlinkOrSkip(t, target, link, type = 'dir') {
  try {
    await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : type)
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`symbolic links are unavailable: ${error.code}`)
      return false
    }
    throw error
  }
  return true
}

test('a local directory imports root SKILL.md and allowlisted inert files with a permission preview', async t => {
  const { source, skillsDir, base } = await fixture(t, {
    files: {
      'README.md': '# Read me\n',
      'references/guide.md': '# Guide\n',
      'references/data.txt': 'reference data\n',
      'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
      'templates/config.json': '{"enabled":false}\n',
    },
  })
  const inspected = await inspectLocalSkill(source)
  assert.equal(inspected.name, 'safe-skill')
  assert.equal(inspected.execution, 'never-automatic')
  assert.equal(await exists(skillsDir), false, 'inspection must not create a destination')

  const record = await importLocalSkill(source, { skillsDir })
  const target = path.join(skillsDir, 'safe-skill')
  assert.equal(record.name, 'safe-skill')
  assert.equal(record.origin, 'local')
  assert.equal(record.remote, false)
  assert.equal(record.enabled, true)
  assert.equal(record.status, 'imported')
  assert.equal(record.execution, 'never-automatic')
  assert.deepEqual(record.declaredTools, ['Read', 'Bash'])
  assert.deepEqual(record.permissionsPreview.requested, ['Read', 'Bash'])
  assert.deepEqual(record.permissionsPreview.effective, [])
  assert.deepEqual(record.permissionsPreview.commands, [])
  assert.equal(record.permissionsPreview.network, 'not-granted')
  assert.ok(record.permissionsPreview.filesystem.read.includes('SKILL.md'))
  assert.deepEqual(record.permissionsPreview.filesystem.write, [])
  assert.equal(await fsp.readFile(path.join(target, 'SKILL.md'), 'utf8'), DEFAULT_SKILL)
  assert.equal(await fsp.readFile(path.join(target, 'references/guide.md'), 'utf8'), '# Guide\n')
  assert.equal(await exists(path.join(base, 'executed')), false)
  assert.equal(await exists(path.join(target, 'executed')), false)
  assert.equal(await exists(path.join(process.cwd(), 'executed')), false)

  const manifest = JSON.parse(await fsp.readFile(path.join(target, 'skill.json'), 'utf8'))
  assert.equal(manifest.name, 'safe-skill')
  for (const file of manifest.files) {
    const digest = createHash('sha256').update(await fsp.readFile(path.join(target, ...file.path.split('/')))).digest('hex')
    assert.equal(digest, file.sha256)
  }
})

test('frontmatter supports quoted scalars and folded descriptions but rejects missing, duplicate and nested data', () => {
  const parsed = parseSkillFrontmatter(`---
name: 'quoted-skill'
description: >-
  First line
  second line
allowed-tools: Read, "Bash"
license: MIT
---
# Body
`)
  assert.equal(parsed.name, 'quoted-skill')
  assert.equal(parsed.description, 'First line second line')
  assert.deepEqual(parsed.declaredTools, ['Read', 'Bash'])
  assert.equal(parsed.metadata.license, 'MIT')

  assert.throws(() => parseSkillFrontmatter('# no frontmatter'), { code: 'MISSING_FRONTMATTER' })
  assert.throws(() => parseSkillFrontmatter('---\nname: a\n---\n'), { code: 'MISSING_FRONTMATTER' })
  assert.throws(() => parseSkillFrontmatter('---\nname: a\nname: b\ndescription: d\n---\n'), { code: 'INVALID_FRONTMATTER' })
  assert.throws(() => parseSkillFrontmatter('---\nname: a\ndescription: d\nmetadata:\n  nested: true\n---\n'), { code: 'INVALID_FRONTMATTER' })
  assert.throws(() => parseSkillFrontmatter('---\nname: *alias\ndescription: d\n---\n'), { code: 'INVALID_FRONTMATTER' })
  assert.throws(() => parseSkillFrontmatter('---\nname: a\ndescription: "unterminated\n---\n'), { code: 'INVALID_FRONTMATTER' })
})

test('executables, package manifests, secrets and non-allowlisted directories are refused before writing', async t => {
  const forbidden = [
    'package.json',
    '.env',
    'run.js',
    'scripts/run.js',
    'references/program.exe',
    'docs/guide.md',
  ]
  for (const relative of forbidden) {
    const { source, skillsDir } = await fixture(t, { files: { [relative]: 'untrusted' } })
    const directoryForbidden = relative.startsWith('docs/') || relative.startsWith('scripts/')
    await rejectsCode(() => importLocalSkill(source, { skillsDir }), directoryForbidden ? 'DIRECTORY_NOT_ALLOWED' : 'FILE_NOT_ALLOWED')
    assert.equal(await exists(skillsDir), false, relative)
  }
})

test('a root-level SKILL.md is required; nested lookalikes are not accepted', async t => {
  const { source, skillsDir } = await fixture(t, { files: { 'references/SKILL.md': DEFAULT_SKILL } })
  await fsp.rm(path.join(source, 'SKILL.md'))
  await rejectsCode(() => importLocalSkill(source, { skillsDir }), 'MISSING_SKILL_MD')
  assert.equal(await exists(skillsDir), false)
})

test('zip-slip and directory traversal paths are rejected in both separator and absolute forms', () => {
  const unsafe = [
    '../escape',
    'references/../../escape',
    'references/../escape',
    '/absolute',
    '\\absolute',
    'C:\\escape',
    'C:/escape',
    'references\\..\\escape',
    'references//guide.md',
    './SKILL.md',
    'references/%2e%2e/escape',
    'NUL.txt',
    'references/guide.md/',
  ]
  for (const value of unsafe) {
    assert.throws(() => assertSafeRelativePath(value), error => {
      assert.ok(error instanceof SkillImportError)
      assert.equal(error.code, 'PATH_TRAVERSAL')
      return true
    })
  }
  assert.equal(assertSafeRelativePath('references/guide.md'), 'references/guide.md')

  const preview = () => previewPermissions({ declaredTools: ['Read'] }, [{ path: '../outside' }])
  assert.throws(preview, { code: 'PATH_TRAVERSAL' })
})

test('a traversal Skill name cannot choose an output directory', async t => {
  const { source, skillsDir, base } = await fixture(t, {
    markdown: '---\nname: ../../escaped\ndescription: malicious\n---\n',
  })
  await rejectsCode(() => importLocalSkill(source, { skillsDir }), 'INVALID_SKILL_NAME')
  assert.equal(await exists(skillsDir), false)
  assert.equal(await exists(path.join(base, 'escaped')), false)
})

test('source file and directory symlinks, including Windows junctions, cannot escape the source root', async t => {
  const outside = path.join(os.tmpdir(), `skill-outside-${process.pid}-${Date.now()}.md`)
  await fsp.writeFile(outside, 'outside secret')
  t.after(() => fsp.rm(outside, { force: true }))

  const fileCase = await fixture(t)
  if (await symlinkOrSkip(t, outside, path.join(fileCase.source, 'references-link.md'), 'file')) {
    await fsp.mkdir(path.join(fileCase.source, 'references'))
    await rejectsCode(() => importLocalSkill(fileCase.source, { skillsDir: fileCase.skillsDir }), 'SYMLINK_FORBIDDEN')
  }

  const directoryCase = await fixture(t)
  await fsp.mkdir(path.join(directoryCase.source, 'references'))
  if (await symlinkOrSkip(t, path.dirname(outside), path.join(directoryCase.source, 'references', 'outside'))) {
    await rejectsCode(() => importLocalSkill(directoryCase.source, { skillsDir: directoryCase.skillsDir }), 'SYMLINK_FORBIDDEN')
  }

  const rootCase = await fixture(t)
  const rootLink = path.join(rootCase.base, 'source-link')
  if (await symlinkOrSkip(t, rootCase.source, rootLink)) {
    await rejectsCode(() => importLocalSkill(rootLink, { skillsDir: rootCase.skillsDir }), 'SYMLINK_FORBIDDEN')
  }
})

test('destination roots and existing symlinked ancestors are refused', async t => {
  const first = await fixture(t)
  const outside = path.join(first.base, 'outside')
  await fsp.mkdir(outside)
  const link = path.join(first.base, 'skills-link')
  if (await symlinkOrSkip(t, outside, link)) {
    await rejectsCode(() => importLocalSkill(first.source, { skillsDir: link }), 'SYMLINK_FORBIDDEN')
    assert.deepEqual(await fsp.readdir(outside), [])
  }

  const second = await fixture(t)
  const realParent = path.join(second.base, 'real-parent')
  await fsp.mkdir(realParent)
  const linkedParent = path.join(second.base, 'linked-parent')
  if (await symlinkOrSkip(t, realParent, linkedParent)) {
    await rejectsCode(() => importLocalSkill(second.source, { skillsDir: path.join(linkedParent, 'skills') }), 'SYMLINK_FORBIDDEN')
    assert.deepEqual(await fsp.readdir(realParent), [])
  }
})

test('per-file, SKILL.md, total-byte, file-count and depth limits fail before import', async t => {
  const perFile = await fixture(t, { files: { 'references/large.md': 'x'.repeat(300) } })
  await rejectsCode(() => importLocalSkill(perFile.source, { skillsDir: perFile.skillsDir, maxFileBytes: 200 }), 'FILE_TOO_LARGE')
  assert.equal(await exists(perFile.skillsDir), false)

  const skillMd = await fixture(t)
  await rejectsCode(() => importLocalSkill(skillMd.source, { skillsDir: skillMd.skillsDir, maxSkillMdBytes: 20 }), 'FILE_TOO_LARGE')

  const total = await fixture(t, { files: { 'README.md': 'x'.repeat(150), 'references/a.md': 'x'.repeat(150) } })
  await rejectsCode(() => importLocalSkill(total.source, { skillsDir: total.skillsDir, maxSkillBytes: 400 }), 'SKILL_TOO_LARGE')

  const count = await fixture(t, { files: { 'references/a.md': 'a', 'references/b.md': 'b' } })
  await rejectsCode(() => importLocalSkill(count.source, { skillsDir: count.skillsDir, maxFiles: 1 }), 'TOO_MANY_FILES')

  const deep = await fixture(t, { files: { 'references/a/b/c.md': 'deep' } })
  await rejectsCode(() => importLocalSkill(deep.source, { skillsDir: deep.skillsDir, maxDepth: 2 }), 'DEPTH_LIMIT')
})

test('duplicate and concurrent imports never overwrite an existing Skill', async t => {
  const first = await fixture(t)
  const original = await importLocalSkill(first.source, { skillsDir: first.skillsDir })
  const targetFile = path.join(first.skillsDir, 'safe-skill', 'SKILL.md')
  const before = createHash('sha256').update(await fsp.readFile(targetFile)).digest('hex')

  await fsp.writeFile(path.join(first.source, 'SKILL.md'), DEFAULT_SKILL.replace('A safe local Skill.', 'Changed description.'))
  await rejectsCode(() => importLocalSkill(first.source, { skillsDir: first.skillsDir }), 'SKILL_ALREADY_EXISTS')
  assert.equal(createHash('sha256').update(await fsp.readFile(targetFile)).digest('hex'), before)
  assert.equal(original.description, 'A safe local Skill.')

  const second = await fixture(t)
  const results = await Promise.allSettled([
    importLocalSkill(second.source, { skillsDir: second.skillsDir }),
    importSkillDirectory(second.source, { skillsDir: second.skillsDir }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const refused = results.find(result => result.status === 'rejected')
  assert.equal(refused.reason.code, 'SKILL_ALREADY_EXISTS')
  assert.equal((await fsp.readdir(path.join(second.skillsDir, 'safe-skill'))).filter(name => name === 'skill.json').length, 1)
})

test('disabled state persists and enabling a Skill still never executes it', async t => {
  const { source, skillsDir, base } = await fixture(t)
  const importer = createSkillImporter({ skillsDir })
  const disabled = await importer.import(source, { enabled: false })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.status, 'imported-disabled')
  assert.equal(disabled.disabledReason, 'disabled-by-user')
  assert.equal((await importer.get('safe-skill')).enabled, false)
  assert.deepEqual((await importer.preview('safe-skill')).effective, [])

  const enabled = await importer.setEnabled('safe-skill', true)
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.status, 'imported')
  assert.equal((await new SkillImporter({ skillsDir }).list())[0].enabled, true)
  assert.equal(await exists(path.join(base, 'executed')), false)

  const disabledAgain = await importer.setEnabled('safe-skill', false)
  assert.equal(disabledAgain.enabled, false)
  assert.equal((await importer.get('safe-skill')).enabled, false)
  await rejectsCode(() => importer.setEnabled('safe-skill', 'true'), 'INVALID_OPTIONS')
  await rejectsCode(() => importer.get('missing-skill'), 'SKILL_NOT_FOUND')
})

test('overlapping source/destination paths, invalid options and corrupt manifests fail closed', async t => {
  const { source, skillsDir } = await fixture(t)
  await rejectsCode(() => importLocalSkill(source, { skillsDir: path.join(source, 'skills') }), 'OVERLAPPING_PATHS')
  await rejectsCode(() => importLocalSkill(source, { skillsDir, enabled: 'false' }), 'INVALID_OPTIONS')
  await rejectsCode(() => importLocalSkill(source, { skillsDir, maxSkillBytes: 0 }), 'INVALID_LIMIT')
  await rejectsCode(() => importLocalSkill(path.join(source, 'missing'), { skillsDir }), 'SOURCE_NOT_FOUND')

  const imported = await importLocalSkill(source, { skillsDir })
  const manifest = path.join(imported.directory, 'skill.json')
  await fsp.writeFile(manifest, '{"schemaVersion":1,"name":"../escape"}')
  const importer = new SkillImporter({ skillsDir })
  await rejectsCode(() => importer.list(), 'CORRUPT_MANIFEST')
})
