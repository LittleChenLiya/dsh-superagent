import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BUILTIN_TEMPLATES,
  TemplateError,
  createTemplateStore,
  expandTemplate,
  normalizeTemplate,
  placeholdersOf,
  validateTemplate,
} from '../lib/templates.js'
import { dedupeKeyOf } from '../lib/orchestrator.js'
import { apply } from '../lib/index.js'

const VALUES = {
  symptom: 'TypeError: cannot read properties of undefined (reading "id") while listing runs',
  reproduction: 'node --test test/store.test.mjs with one truncated JSON file in runs/',
  expected: 'the corrupt run is reported and the other runs still list',
  scope: 'lib/store.js only; test/store.test.mjs may gain one case',
}

const CUSTOM = {
  id: 'release-notes',
  title: 'Draft release notes for one version',
  whenToUse: 'A tagged release needs human-readable notes that match what actually shipped.',
  whenNotToUse: [
    'Nothing user-visible changed, so a changelog entry would be noise.',
    'The version number is not decided yet; settle the version first.',
  ],
  variables: [{ name: 'version', description: 'The version being released' }],
  skeleton: [
    'Draft the release notes for {{version}}.',
    '',
    '1. Read the commits and merged changes since the previous tag.',
    '2. List only user-visible changes, each with the evidence that shipped it.',
    '3. Group them under Added, Changed, Fixed, and Removed.',
    '',
    'Deliver Markdown ready to paste into the release page. Do not invent a change that no commit supports.',
  ].join('\n'),
}

async function withRoot(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-templates-'))
  try {
    return await fn(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

/** A fake host: tool registration plus a subagent backend whose replies the test chooses. */
function mount({ stateDir, home, config = {}, spawn }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents: { startActivation: spawn },
    get: () => undefined,
  }
  apply(ctx, { stateDir, notifyOnComplete: false, ...config })
  return {
    tools,
    restore() {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

test('the built-in library covers the four common workflows and states when each is wrong', () => {
  const ids = BUILTIN_TEMPLATES.map(template => template.id)
  for (const required of ['bugfix-verify', 'review-fix', 'docs-examples', 'research-report']) {
    assert.ok(ids.includes(required), `missing built-in template ${required}`)
  }
  for (const template of BUILTIN_TEMPLATES) {
    assert.match(template.id, /^[a-z0-9-]+$/)
    assert.ok(template.whenToUse.length > 20, `${template.id} needs a usable whenToUse`)
    assert.ok(template.whenNotToUse.length >= 1, `${template.id} must say when it is the wrong tool`)
    assert.ok(template.variables.length >= 1, `${template.id} should expose parameters`)
    const placeholders = placeholdersOf(template.skeleton)
    assert.deepEqual(
      placeholders.sort(),
      template.variables.map(variable => variable.name).sort(),
      `${template.id} placeholders and declared parameters must match`,
    )
  }
})

test('expansion fills every placeholder and adds nothing to the goal', () => {
  const template = BUILTIN_TEMPLATES.find(candidate => candidate.id === 'bugfix-verify')
  const expanded = expandTemplate(template, VALUES)

  assert.equal(expanded.templateId, 'bugfix-verify')
  assert.deepEqual(expanded.filled.sort(), Object.keys(VALUES).sort())
  assert.doesNotMatch(expanded.goal, /\{\{|\}\}/)
  for (const value of Object.values(VALUES)) assert.ok(expanded.goal.includes(value), `goal is missing ${value}`)
  // The expanded text is the skeleton itself: no template marker, no limits,
  // nothing the normal start path would have to interpret specially.
  assert.ok(expanded.goal.startsWith('Fix the following bug and prove the fix works.'))
  assert.ok(expanded.goal.includes('Work in this order'))
})

test('a missing parameter is refused by name instead of defaulted', () => {
  const template = BUILTIN_TEMPLATES.find(candidate => candidate.id === 'bugfix-verify')

  assert.throws(
    () => expandTemplate(template, { symptom: VALUES.symptom }),
    error => {
      assert.ok(error instanceof TemplateError)
      assert.equal(error.code, 'missing-parameters')
      assert.deepEqual(error.parameters, ['reproduction', 'expected', 'scope'])
      for (const name of error.parameters) assert.match(error.message, new RegExp(name))
      assert.match(error.message, /never assumes a default/)
      return true
    },
  )

  // A blank value is missing, not a value: a goal about "   " would be worse
  // than an error that says which field to fill.
  assert.throws(
    () => expandTemplate(template, { ...VALUES, expected: '   ' }),
    error => error.code === 'missing-parameters' && error.parameters.join() === 'expected',
  )
})

test('an undeclared parameter is refused so a typo cannot silently disappear', () => {
  assert.throws(
    () => expandTemplate(BUILTIN_TEMPLATES[0], { ...VALUES, reprodution: 'typo' }),
    error => {
      assert.equal(error.code, 'unknown-parameters')
      assert.deepEqual(error.parameters, ['reprodution'])
      assert.match(error.message, /symptom, reproduction, expected, scope/)
      return true
    },
  )
})

test('a template definition cannot carry limits or overrides', () => {
  const withLimits = validateTemplate({ ...CUSTOM, limits: { maxSubtasks: 99 } })
  assert.equal(withLimits.ok, false)
  assert.match(withLimits.error.message, /unknown field/)
  assert.match(withLimits.error.message, /limits/)

  assert.throws(() => normalizeTemplate({ ...CUSTOM, skeleton: `${CUSTOM.skeleton}\n{{undeclared}}` }), /does not declare/)
  assert.throws(
    () => normalizeTemplate({ ...CUSTOM, variables: [...CUSTOM.variables, { name: 'unused', description: 'never appears' }] }),
    /never uses the placeholder/,
  )
  assert.throws(() => normalizeTemplate({ ...CUSTOM, whenNotToUse: [] }), /at least one whenNotToUse/)
  assert.throws(() => normalizeTemplate({ ...CUSTOM, id: 'Release Notes' }), /lowercase slug/)
})

test('custom templates are written, listed, overwritten, and deleted under the state directory', async () => {
  await withRoot(async root => {
    const warns = []
    const store = createTemplateStore(root, { warn: message => warns.push(message) })

    const before = await store.list()
    assert.equal(before.builtin, BUILTIN_TEMPLATES.length)
    assert.equal(before.custom, 0)
    assert.equal(before.bad, 0)

    const saved = await store.save(CUSTOM)
    assert.equal(saved.replaced, false)
    assert.equal(saved.path, path.join(root, 'templates', 'release-notes.json'))
    const onDisk = JSON.parse(await fsp.readFile(saved.path, 'utf8'))
    assert.deepEqual(onDisk, normalizeTemplate(CUSTOM), 'the file uses exactly the built-in shape')
    assert.equal(await fsp.readFile(path.join(root, 'templates', '.gitignore'), 'utf8'), '*\n')

    const listed = await store.list()
    assert.equal(listed.custom, 1)
    const custom = listed.templates.find(template => template.id === 'release-notes')
    assert.equal(custom.source, 'custom')
    assert.equal((await store.get('release-notes')).source, 'custom')

    const replaced = await store.save({ ...CUSTOM, title: 'Draft release notes (short)' })
    assert.equal(replaced.replaced, true)
    assert.equal((await store.get('release-notes')).title, 'Draft release notes (short)')

    assert.deepEqual(await store.remove('release-notes'), { id: 'release-notes', removed: true })
    assert.equal(await store.get('release-notes'), null)
    assert.equal((await store.remove('release-notes')).removed, false)
    assert.equal(warns.length, 0)
  })
})

test('a custom template cannot shadow a built-in and a broken file cannot break the listing', async () => {
  await withRoot(async root => {
    const warns = []
    const store = createTemplateStore(root, { warn: message => warns.push(message) })

    await assert.rejects(() => store.save({ ...CUSTOM, id: 'bugfix-verify' }), error => error.code === 'builtin-template')
    await assert.rejects(() => store.remove('bugfix-verify'), error => error.code === 'builtin-template')
    assert.equal((await store.get('bugfix-verify')).source, 'builtin')

    await store.init()
    await fsp.writeFile(path.join(root, 'templates', 'broken.json'), '{not json', 'utf8')
    await fsp.writeFile(path.join(root, 'templates', 'widened.json'), JSON.stringify({ ...CUSTOM, id: 'widened', limits: {} }), 'utf8')
    await fsp.writeFile(path.join(root, 'templates', 'renamed.json'), JSON.stringify(CUSTOM), 'utf8')

    const listed = await store.list()
    assert.equal(listed.builtin, BUILTIN_TEMPLATES.length)
    assert.equal(listed.custom, 0)
    assert.equal(listed.bad, 3)
    assert.equal(warns.length, 3)
    assert.ok(listed.templates.some(template => template.id === 'bugfix-verify'))
  })
})

test('the template tool lists, shows, expands, saves, and deletes', async () => {
  await withRoot(async root => {
    const stateDir = path.join(root, 'state')
    const home = path.join(root, 'home')
    const host = mount({ stateDir, home, spawn: async () => { throw new Error('no run expected') } })
    const call = args => host.tools.get('superagent_template').execute(args, { agent: { id: 'session-1' } })
    try {
      const listed = await call({ action: 'list' })
      assert.match(listed, /4 template\(s\): 4 built-in, 0 custom/)
      assert.match(listed, /bugfix-verify {2}\[builtin\]/)
      assert.match(listed, /params: symptom, reproduction, expected, scope/)

      const shown = await call({ action: 'show', id: 'research-report' })
      assert.match(shown, /do not use when:/)
      assert.match(shown, /{{question}}/)
      assert.match(shown, /parameters \(all required\):/)

      const denied = await call({ action: 'expand', id: 'bugfix-verify', params: { symptom: 'x' } })
      assert.match(denied, /^\[error\] template "bugfix-verify" is missing required parameter\(s\): reproduction, expected, scope/)
      assert.match(denied, /^hint: pass every declared parameter/m)

      const saved = await call({ action: 'save', template: CUSTOM })
      assert.match(saved, /saved template "release-notes"/)
      assert.match(await call({ action: 'list' }), /5 template\(s\): 4 built-in, 1 custom/)
      assert.match(await call({ action: 'show', id: 'release-notes' }), /\[custom\]/)

      const widened = await call({ action: 'save', template: { ...CUSTOM, id: 'widened', limits: { maxSubtasks: 99 } } })
      assert.match(widened, /^\[error\] unknown field\(s\) limits/)

      assert.match(await call({ action: 'delete', id: 'release-notes' }), /deleted custom template "release-notes"/)
      assert.match(await call({ action: 'delete', id: 'release-notes' }), /^\[error\] no custom template/)
      assert.match(await call({ action: 'delete', id: 'bugfix-verify' }), /^\[error\] .*built-in template/)
    } finally {
      host.restore()
    }
  })
})

test('an expanded template is a normal goal: same planner, same plan, same limits', async () => {
  await withRoot(async root => {
    const stateDir = path.join(root, 'state')
    const home = path.join(root, 'home')
    const plannerPrompts = []
    let childSeq = 0
    const activation = text => ({
      childId: `child-${++childSeq}`,
      result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
      dispose: async () => {},
    })
    const host = mount({
      stateDir,
      home,
      config: { workspaceIsolation: false, repoWiki: { enabled: false } },
      spawn: async spec => {
        if (spec.label === 'superagent-plan') {
          plannerPrompts.push(spec.request.prompt[0].text)
          // The planner owns the plan, including any ordering. The template
          // only supplies the goal text, so a dependency the planner declares
          // is executed by the run's own plan path, not by this feature.
          return activation(JSON.stringify({
            subtasks: [
              { id: 'w1', title: 'root cause', prompt: 'find the cause' },
              { id: 'w2', title: 'regression test', prompt: 'prove it', dependsOn: ['w1'] },
            ],
          }))
        }
        if (spec.label === 'superagent-aggregate') return activation('merged report')
        return activation(`result for ${spec.label}`)
      },
    })
    try {
      const expanded = await host.tools.get('superagent_template').execute(
        { action: 'expand', id: 'bugfix-verify', params: VALUES },
        { agent: { id: 'session-1' } },
      )
      const goal = expanded.slice(expanded.indexOf('\n\n') + 2)
      assert.ok(goal.startsWith('Fix the following bug'))
      assert.doesNotMatch(goal, /\{\{/)

      const started = await host.tools.get('superagent_start').execute(
        { goal, wait_seconds: 10 },
        { agent: { id: 'session-1' } },
      )
      assert.match(started, /— completed/)
      assert.match(started, /2\/2 completed/)

      assert.equal(plannerPrompts.length, 1)
      assert.match(plannerPrompts[0], /Fix the following bug and prove the fix works\./)
      assert.match(plannerPrompts[0], /Work in this order/)

      const runId = /run ([0-9A-Za-z-]+) —/.exec(started)?.[1]
      const run = JSON.parse(await fsp.readFile(path.join(stateDir, 'runs', `${runId}.json`), 'utf8'))
      assert.equal(run.goal, goal)
      assert.equal(run.dedupeKey, dedupeKeyOf(goal), 'the expanded goal gets the identity of a typed goal')
      assert.equal(run.plan.mode, 'planned')
      assert.equal(run.subtasks.length, 2)
      // Every limit comes from the operator's config, not from the template.
      assert.equal(run.limits.maxSubtasks, 8)
      assert.equal(run.limits.maxParallel, 4)
      assert.equal(run.limits.attempts, 2)
      assert.equal(run.limits.deadlineMinutes, 120)
    } finally {
      host.restore()
    }
  })
})

test('starting from a template still hits the active-run quota', async () => {
  await withRoot(async root => {
    const stateDir = path.join(root, 'state')
    const home = path.join(root, 'home')
    let openWorker
    const workerGate = new Promise(resolve => { openWorker = resolve })
    let childSeq = 0
    const activation = text => ({
      childId: `child-${++childSeq}`,
      result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
      dispose: async () => {},
    })
    const host = mount({
      stateDir,
      home,
      config: { maxActiveRuns: 1, queueOnFull: false },
      spawn: async spec => {
        if (spec.label === 'superagent-plan') {
          return activation(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
        }
        if (spec.label === 'superagent-aggregate') return activation('merged report')
        return {
          childId: `child-${++childSeq}`,
          result: workerGate.then(() => ({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })),
          dispose: async () => {},
        }
      },
    })
    const call = (name, args) => host.tools.get(name).execute(args, { agent: { id: 'session-1' } })
    try {
      const bugfix = await call('superagent_template', { action: 'expand', id: 'bugfix-verify', params: VALUES })
      const bugfixGoal = bugfix.slice(bugfix.indexOf('\n\n') + 2)
      const started = await call('superagent_start', { goal: bugfixGoal })
      const runId = /run ([0-9A-Za-z-]+) —/.exec(started)?.[1]
      assert.ok(runId, started)

      const research = await call('superagent_template', {
        action: 'expand',
        id: 'research-report',
        params: { question: 'Which queue shape fits?', scope: 'public docs only', purpose: 'pick one this week' },
      })
      const researchGoal = research.slice(research.indexOf('\n\n') + 2)
      const refused = await call('superagent_start', { goal: researchGoal })
      assert.match(refused, /^\[error\] the run was not started because the active-run limit is already in use/)
      assert.match(refused, /maxActiveRuns is 1/)

      openWorker()
      assert.match(await call('superagent_status', { run_id: runId, wait_seconds: 10 }), /— completed/)
    } finally {
      openWorker()
      host.restore()
    }
  })
})
