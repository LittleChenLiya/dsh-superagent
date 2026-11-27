import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRepoWiki, REPO_CARD_TYPES } from '../lib/repo-wiki.js'

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'repo-wiki-fixture-'))
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repo-wiki-state-'))
  await fsp.mkdir(path.join(root, 'src'), { recursive: true })
  await fsp.mkdir(path.join(root, 'lib'), { recursive: true })
  await fsp.mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true })
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'repo-wiki-fixture',
    version: '1.0.0',
    description: 'Deterministic repository ontology fixture',
    scripts: { test: 'node --test', build: 'node build.js', lint: 'eslint .' },
    dependencies: { alpha: '1.2.3' },
    devDependencies: { beta: '^2.0.0' },
  }, null, 2))
  await fsp.writeFile(path.join(root, 'README.md'), '# Repo Wiki Fixture\n\nA fixture for source-backed ontology tests.\n')
  await fsp.writeFile(path.join(root, '.env'), 'SECRET=do-not-read\n')
  await fsp.writeFile(path.join(root, 'node_modules', 'ignored', 'index.js'), 'export const ignored = true\n')
  await fsp.writeFile(path.join(root, 'src', 'index.js'), "import { helper } from '../lib/helper.js'\nexport const value = helper()\n")
  await fsp.writeFile(path.join(root, 'src', 'service.py'), 'def serve():\n    return "ok"\n')
  await fsp.writeFile(path.join(root, 'lib', 'helper.js'), 'export function helper() {\n  return 1\n}\n')
  return { root, stateDir, cleanup: async () => {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(stateDir, { recursive: true, force: true })
  } }
}

test('generate builds all card types, module relations and source citations', async () => {
  const { root, stateDir, cleanup } = await fixture()
  try {
    const wiki = createRepoWiki({ stateDir })
    const snapshot = await wiki.generate(root)
    assert.equal(snapshot.schemaVersion, 1)
    assert.equal(snapshot.title, 'repo-wiki-fixture')
    assert.ok(snapshot.stats.files >= 5)
    assert.ok(snapshot.stats.modules >= 2)
    assert.deepEqual(Object.keys(snapshot.repository.cards), REPO_CARD_TYPES)
    assert.match(snapshot.repository.cards.overview, /repo-wiki-fixture|Deterministic repository ontology fixture/)
    assert.match(snapshot.repository.cards.unique_setup_and_commands, /node --test/)
    assert.ok(snapshot.repository.cards.coding_conventions.split('\n').every(line => line.startsWith('- ')))
    assert.ok(snapshot.modules.some(module => module.slug === '/src'))
    assert.ok(snapshot.modules.some(module => module.slug === '/lib'))
    const src = snapshot.modules.find(module => module.slug === '/src')
    assert.ok(src.depends_on.some(relation => relation.target === '/lib'))
    assert.ok(src.sources.every(source => !source.path.includes('node_modules') && source.path !== '.env'))
    assert.ok(src.sources.every(source => source.lineStart >= 1 && source.lineEnd >= source.lineStart))
    assert.equal(snapshot.wiki.length, 6)
  } finally {
    await cleanup()
  }
})

test('fingerprint caching and incremental updates preserve manual relations', async () => {
  const { root, stateDir, cleanup } = await fixture()
  try {
    const wiki = createRepoWiki({ stateDir })
    const first = await wiki.generate(root)
    const cached = await wiki.generate(root)
    assert.equal(cached.baseline.fingerprint, first.baseline.fingerprint)
    assert.equal(cached.generatedAt, first.generatedAt)

    await wiki.link(root, { sourcePath: '/src', targetPath: '/lib', kind: 'related_to', reason: 'shared contract' })
    await fsp.writeFile(path.join(root, 'src', 'index.js'), "import { helper } from '../lib/helper.js'\nexport const value = helper() + 1\n")
    const updated = await wiki.generate(root)
    assert.notEqual(updated.baseline.fingerprint, first.baseline.fingerprint)
    assert.match(updated.modules.find(module => module.slug === '/src').cards.overview, /src/)
    assert.ok(updated.modules.find(module => module.slug === '/src').related_to.some(relation => relation.target === '/lib' && relation.origin === 'manual'))
  } finally {
    await cleanup()
  }
})

test('read, query and context return evidence-backed results', async () => {
  const { root, stateDir, cleanup } = await fixture()
  try {
    const wiki = createRepoWiki({ stateDir })
    await wiki.generate(root)
    const card = await wiki.read(root, { path: '/src/overview' })
    assert.equal(card.cardType, 'overview')
    assert.equal(card.modulePath, '/src')
    assert.ok(card.sources.some(source => source.path === 'src/index.js'))

    const found = await wiki.query(root, { query: 'helper', limit: 5 })
    assert.ok(found.matches.length > 0)
    assert.ok(found.matches.some(match => match.sources.some(source => source.path === 'lib/helper.js')))

    const context = await wiki.context(root, { query: 'helper', chars: 5000 })
    assert.match(context, /Repository ontology/)
    assert.match(context, /source: lib\/helper\.js/)
  } finally {
    await cleanup()
  }
})

test('relations reject self-links and can be removed', async () => {
  const { root, stateDir, cleanup } = await fixture()
  try {
    const wiki = createRepoWiki({ stateDir })
    await wiki.generate(root)
    await assert.rejects(wiki.link(root, { sourcePath: '/src', targetPath: '/src', kind: 'depends_on' }), /self-links/)
    await wiki.link(root, { sourcePath: '/src', targetPath: '/lib', kind: 'depends_on', reason: 'uses helper' })
    let snapshot = await wiki.status(root)
    assert.ok(snapshot.modules.find(module => module.slug === '/src').depends_on.some(relation => relation.target === '/lib' && relation.origin === 'manual'))
    await wiki.unlink(root, { sourcePath: '/src', targetPath: '/lib', kind: 'depends_on' })
    snapshot = await wiki.status(root)
    assert.ok(!snapshot.modules.find(module => module.slug === '/src').depends_on.some(relation => relation.target === '/lib' && relation.origin === 'manual'))
  } finally {
    await cleanup()
  }
})

test('scan limits truncate instead of silently dropping the signal', async () => {
  const { root, stateDir, cleanup } = await fixture()
  try {
    for (let index = 0; index < 120; index++) {
      await fsp.writeFile(path.join(root, 'src', `generated-${index}.js`), `export const value${index} = ${index}\n`)
    }
    const wiki = createRepoWiki({ stateDir, maxFiles: 100 })
    const snapshot = await wiki.generate(root)
    assert.equal(snapshot.stats.truncated, true)
    assert.ok(snapshot.stats.files <= 100)
  } finally {
    await cleanup()
  }
})

test('corrupt stores fail closed and invalid roots are rejected', async () => {
  const { root, stateDir, cleanup } = await fixture()
  try {
    const wiki = createRepoWiki({ stateDir })
    await wiki.generate(root)
    const status = await wiki.status(root)
    const file = path.join(stateDir, 'repo-wiki', `${status.projectId}.json`)
    await fsp.writeFile(file, '{broken')
    await assert.rejects(wiki.status(root), /not valid JSON/)
    await assert.rejects(wiki.generate(path.join(root, 'missing')), /does not exist/)
    await assert.rejects(wiki.generate('relative/path'), /absolute/)
  } finally {
    await cleanup()
  }
})
