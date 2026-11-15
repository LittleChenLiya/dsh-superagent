/**
 * Workflow templates for dsh-superagent.
 *
 * Most long goals have one of a few shapes: "fix this bug and prove it is
 * fixed", "review this diff and repair what is broken", "update the docs to
 * match the code", "research this question and write a report". Typing that
 * shape by hand every time invites omissions, and letting the planner invent it
 * from scratch makes two runs of the same task incomparable.
 *
 * A template is that shape written once: a fixed skeleton with named holes, the
 * situations it fits, and the situations where it is the wrong tool. Expanding
 * one produces a single goal string. That string enters the normal start path —
 * the planner still decomposes it, subtasks are still ordered by the run's own
 * plan, and every limit, budget, and quota still applies. There is deliberately
 * no field for limits, providers, or overrides, and an unknown field is
 * rejected, so a template can never widen what a run is allowed to do.
 *
 * Built-ins live in this file. A user template is
 * `<stateDir>/templates/<id>.json` with exactly the same fields; it can be
 * listed, shown, overwritten, and deleted, and it may not take a built-in's id.
 *
 * Placeholders are `{{name}}` and every declared parameter is required. A
 * missing value is refused with the names of what is missing instead of being
 * filled with a guessed default: a plausible default ("the failing test") is
 * how a template silently produces a goal about the wrong thing.
 *
 * @module dsh-superagent/templates
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Placeholder syntax used by a skeleton. */
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g

/** A template id is also a file name under `<stateDir>/templates`. */
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
const MAX_ID_CHARS = 48
const MAX_TITLE_CHARS = 120
const MAX_WHEN_CHARS = 600
const MAX_NOT_CHARS = 400
const MAX_NOT_ITEMS = 8
const MAX_DESCRIPTION_CHARS = 300
const MAX_VARIABLES = 12
const MAX_SKELETON_CHARS = 8000
const MAX_GOAL_CHARS = 16000

/** Fields a template may set. Anything else is refused, not ignored. */
const TEMPLATE_FIELDS = new Set(['id', 'title', 'whenToUse', 'whenNotToUse', 'variables', 'skeleton'])
const VARIABLE_FIELDS = new Set(['name', 'description'])

/**
 * A template problem with a stable code, so the tool can attach the right hint
 * and a test can assert the failure instead of matching prose.
 */
export class TemplateError extends Error {
  /**
   * @param {string} code - stable identifier.
   * @param {string} message - one actionable sentence.
   * @param {{ parameters?: string[] }} [details] - names involved, when known.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
    if (details.parameters) this.parameters = details.parameters
  }
}

function invalid(message) {
  return new TemplateError('invalid-template', message)
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Collapse metadata to one bounded line; a title or reason is never multiline. */
function oneLine(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return [...text].slice(0, limit).join('')
}

/**
 * Placeholder names used by a skeleton, in first-appearance order. Names are
 * returned verbatim so validation can report a malformed one instead of hiding
 * it; expansion only happens after validation.
 *
 * @param {unknown} skeleton - template skeleton.
 * @returns {string[]} placeholder names.
 */
export function placeholdersOf(skeleton) {
  const names = []
  for (const match of String(skeleton ?? '').matchAll(ANY_PLACEHOLDER)) {
    const name = match[1].trim()
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Coerce one template definition into the canonical shape.
 *
 * @param {unknown} input - parsed template (from code or a JSON file).
 * @returns {object} canonical template.
 * @throws {TemplateError} `invalid-template` with the first concrete problem.
 */
export function normalizeTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('a template must be a JSON object')
  }
  const unknown = Object.keys(input).filter(key => !TEMPLATE_FIELDS.has(key))
  if (unknown.length > 0) {
    throw invalid(
      `unknown field(s) ${unknown.join(', ')}; a template may only set ${[...TEMPLATE_FIELDS].join(', ')} `
      + '(limits, providers, and overrides belong to the run, not the template)',
    )
  }

  const id = asText(input.id)
  if (!ID_PATTERN.test(id) || id.length > MAX_ID_CHARS) {
    throw invalid(`id must be a lowercase slug such as "bugfix-verify" (got ${JSON.stringify(input.id)})`)
  }

  const title = oneLine(input.title, MAX_TITLE_CHARS)
  if (!title) throw invalid(`template "${id}" needs a one-line title`)

  const whenToUse = oneLine(input.whenToUse, MAX_WHEN_CHARS)
  if (!whenToUse) throw invalid(`template "${id}" needs whenToUse: the situation it fits`)

  const notList = Array.isArray(input.whenNotToUse)
    ? input.whenNotToUse
    : typeof input.whenNotToUse === 'string'
      ? [input.whenNotToUse]
      : []
  if (notList.length === 0) {
    throw invalid(`template "${id}" needs at least one whenNotToUse entry: when this template is the wrong tool`)
  }
  if (notList.length > MAX_NOT_ITEMS) {
    throw invalid(`template "${id}" lists more than ${MAX_NOT_ITEMS} whenNotToUse entries; keep the decisive ones`)
  }
  const whenNotToUse = notList.map((item, index) => {
    const text = oneLine(item, MAX_NOT_CHARS)
    if (!text) throw invalid(`template "${id}" has an empty whenNotToUse entry at index ${index}`)
    return text
  })

  if (input.variables !== undefined && !Array.isArray(input.variables)) {
    throw invalid(`template "${id}" has variables that are not a list`)
  }
  const rawVariables = input.variables ?? []
  if (rawVariables.length > MAX_VARIABLES) {
    throw invalid(`template "${id}" declares more than ${MAX_VARIABLES} parameters`)
  }
  const variables = []
  const seen = new Set()
  for (const [index, item] of rawVariables.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid(`template "${id}" has a parameter at index ${index} that is not an object`)
    }
    const extra = Object.keys(item).filter(key => !VARIABLE_FIELDS.has(key))
    if (extra.length > 0) {
      throw invalid(`template "${id}" parameter ${JSON.stringify(item.name)} has unknown field(s) ${extra.join(', ')}`)
    }
    const name = asText(item.name)
    if (!NAME_PATTERN.test(name)) {
      throw invalid(`template "${id}" parameter ${JSON.stringify(item.name)} must be a lowercase name such as "reproduction"`)
    }
    if (seen.has(name)) throw invalid(`template "${id}" declares parameter "${name}" twice`)
    seen.add(name)
    const description = oneLine(item.description, MAX_DESCRIPTION_CHARS)
    if (!description) throw invalid(`template "${id}" parameter "${name}" needs a description of the value to pass`)
    variables.push({ name, description })
  }

  const skeleton = typeof input.skeleton === 'string' ? input.skeleton.trim() : ''
  if (!skeleton) throw invalid(`template "${id}" needs a skeleton`)
  if (skeleton.length > MAX_SKELETON_CHARS) {
    throw invalid(`template "${id}" skeleton is longer than ${MAX_SKELETON_CHARS} characters`)
  }
  for (const placeholder of placeholdersOf(skeleton)) {
    if (!NAME_PATTERN.test(placeholder)) {
      throw invalid(`template "${id}" uses {{${placeholder}}}, which is not a valid parameter name`)
    }
    if (!seen.has(placeholder)) {
      throw invalid(
        `template "${id}" uses {{${placeholder}}} in its skeleton but does not declare that parameter`,
      )
    }
  }
  const used = placeholdersOf(skeleton)
  const unused = [...seen].filter(name => !used.includes(name))
  if (unused.length > 0) {
    throw invalid(
      `template "${id}" declares ${unused.join(', ')} but never uses the placeholder(s) in its skeleton; `
      + 'a parameter nobody reads would be collected and silently dropped',
    )
  }

  return { id, title, whenToUse, whenNotToUse, variables, skeleton }
}

/**
 * Validate a template without throwing, for a caller that has to report the
 * problem instead of crashing on a hand-edited JSON file.
 *
 * @param {unknown} input - candidate template.
 * @returns {{ ok: true, template: object } | { ok: false, error: TemplateError }}
 */
export function validateTemplate(input) {
  try {
    return { ok: true, template: normalizeTemplate(input) }
  } catch (error) {
    if (error instanceof TemplateError) return { ok: false, error }
    throw error
  }
}

/**
 * Turn one template parameter into the text that goes into the goal. A value
 * that is absent, null, empty, or only whitespace is missing — never defaulted.
 */
function parameterText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return ''
}

/**
 * Expand one template into a goal.
 *
 * The result is plain goal text with nothing added: no template marker, no
 * limit, no mode. The start path cannot tell it apart from a goal typed by the
 * user, which is what keeps templates inside the existing planner, plan, and
 * quota behaviour.
 *
 * @param {unknown} input - template definition (built-in or custom).
 * @param {Record<string, unknown>} [values] - one value per declared parameter.
 * @returns {{ goal: string, templateId: string, title: string, filled: string[] }}
 * @throws {TemplateError} `invalid-template`, `unknown-parameters`,
 *   `missing-parameters`, or `goal-too-long`.
 */
export function expandTemplate(input, values = {}) {
  // The store marks where a definition came from with `source`. That is not
  // part of the definition a skeleton may set, so it is dropped here rather
  // than declared as a field a saved template could also carry.
  let definition = input
  if (input && typeof input === 'object' && !Array.isArray(input) && 'source' in input) {
    const { source: _source, ...rest } = input
    definition = rest
  }
  const template = normalizeTemplate(definition)
  if (values === undefined || values === null) values = {}
  if (typeof values !== 'object' || Array.isArray(values)) {
    throw new TemplateError('unknown-parameters', 'params must be an object of parameter values')
  }

  const declared = template.variables.map(variable => variable.name)
  const supplied = Object.keys(values).filter(key => values[key] !== undefined)
  const unknown = supplied.filter(key => !declared.includes(key))
  if (unknown.length > 0) {
    throw new TemplateError(
      'unknown-parameters',
      `template "${template.id}" has no parameter(s) ${unknown.sort().join(', ')}; `
      + `it declares ${declared.join(', ') || '(none)'}`,
      { parameters: unknown },
    )
  }

  const missing = declared.filter(name => !parameterText(values[name]))
  if (missing.length > 0) {
    throw new TemplateError(
      'missing-parameters',
      `template "${template.id}" is missing required parameter(s): ${missing.join(', ')}; `
      + 'a template never assumes a default, so pass a value for each one',
      { parameters: missing },
    )
  }

  const goal = template.skeleton.replace(ANY_PLACEHOLDER, (_match, rawName) => {
    const name = String(rawName).trim()
    return parameterText(values[name])
  })
  // Values are opaque text, so a value that itself contains `{{...}}` is left
  // alone: someone documenting this syntax must be able to pass it as a value.
  if (goal.length > MAX_GOAL_CHARS) {
    throw new TemplateError(
      'goal-too-long',
      `template "${template.id}" expands to ${goal.length} characters, over the ${MAX_GOAL_CHARS} limit; `
      + 'shorten the skeleton or the values',
    )
  }
  return { goal, templateId: template.id, title: template.title, filled: declared }
}

/**
 * The built-in library. Each entry answers four questions: when it fits, the
 * fixed skeleton, the holes in that skeleton, and when it is the wrong tool.
 * The last one is not decoration: it is what stops a template from being
 * applied to work it was never designed for.
 */
export const BUILTIN_TEMPLATES = Object.freeze([
  Object.freeze(normalizeTemplate({
    id: 'bugfix-verify',
    title: 'Fix a bug and verify the fix',
    whenToUse: 'A defect has a known symptom and a way to reproduce it, and the work is to find the cause, '
      + 'fix it, and prove the fix with a test.',
    whenNotToUse: [
      'The task is a new feature or a redesign, not a defect against expected behaviour.',
      'The failure cannot be reproduced yet; investigate first, then come back with a reproduction.',
      'The fix needs a product or API decision that only the user can make before any code changes.',
    ],
    variables: [
      { name: 'symptom', description: 'What goes wrong, quoted from the actual output' },
      { name: 'reproduction', description: 'The exact steps or command that trigger it' },
      { name: 'expected', description: 'What correct behaviour looks like' },
      { name: 'scope', description: 'Files or components that may be changed, and what is off limits' },
    ],
    skeleton: [
      'Fix the following bug and prove the fix works.',
      '',
      'Symptom:',
      '{{symptom}}',
      '',
      'How to reproduce it:',
      '{{reproduction}}',
      '',
      'Expected behaviour:',
      '{{expected}}',
      '',
      'Allowed change scope:',
      '{{scope}}',
      '',
      'Work in this order, and do not skip a step:',
      '1. Reproduce the failure and quote the exact error output.',
      '2. Find the root cause and state it in one sentence before changing any file.',
      '3. Make the smallest change that fixes the cause, inside the allowed scope only.',
      '4. Add or update a regression test that fails without the fix and passes with it.',
      '5. Run the relevant test suite and report the real pass and fail numbers.',
      '',
      'In the final report: the root cause, the files changed with a one-line reason for each, the regression test,',
      'the exact commands you ran, and their output. Do not refactor unrelated code, do not change the public API',
      'unless the symptom makes that unavoidable, and do not claim a fix you did not run.',
    ].join('\n'),
  })),
  Object.freeze(normalizeTemplate({
    id: 'review-fix',
    title: 'Review code and fix the confirmed defects',
    whenToUse: 'A diff, file, or module needs review, and the reviewer is expected to repair the defects it '
      + 'finds rather than only list them.',
    whenNotToUse: [
      'The review must stay read-only, for example a pre-merge audit that another person will act on.',
      'Nobody can say what the code is supposed to do; clarify the intended behaviour first.',
      'The target is generated or vendored code that must not be edited.',
    ],
    variables: [
      { name: 'target', description: 'The diff, files, or module to review' },
      { name: 'focus', description: 'What to judge it against: correctness, security, performance, compatibility' },
      { name: 'verification', description: 'The command or check that proves a fix works' },
    ],
    skeleton: [
      'Review the following code, then fix the real defects you find.',
      '',
      'Target:',
      '{{target}}',
      '',
      'What to review it against:',
      '{{focus}}',
      '',
      'How to verify a fix:',
      '{{verification}}',
      '',
      'Work in this order:',
      '1. Read the target before judging it, and list the files you actually read.',
      '2. Report each finding as `file:line — severity — what breaks, under which input, with evidence`.',
      '3. Separate confirmed defects from style preferences, and never report a preference as a defect.',
      '4. Fix only the confirmed defects, smallest change first, and touch no unrelated file.',
      '5. Verify every fix with the check given above; if a fix cannot be verified, say exactly why.',
      '6. Re-run the relevant tests and report the real pass and fail numbers.',
      '',
      'Deliver: the findings with their fate (fixed, or not fixed and why), the diff summary, and the verification',
      'output. If a finding needs a product decision instead of a code change, say so and leave that code alone.',
    ].join('\n'),
  })),
  Object.freeze(normalizeTemplate({
    id: 'docs-examples',
    title: 'Update docs and examples to match the code',
    whenToUse: 'Code or configuration changed and the docs, README, or runnable examples now describe the old '
      + 'behaviour.',
    whenNotToUse: [
      'The docs describe a feature that does not exist yet; build the feature first.',
      'The task is a marketing or positioning rewrite rather than a correctness update.',
      'The examples need a live account, credential, or paid service that this run cannot use.',
    ],
    variables: [
      { name: 'change', description: 'What changed in the code or configuration' },
      { name: 'audience', description: 'Who reads these docs and what they already know' },
      { name: 'sources', description: 'The files that hold the current truth' },
    ],
    skeleton: [
      'Update the documentation and examples so they match what the code actually does.',
      '',
      'What changed:',
      '{{change}}',
      '',
      'Reader:',
      '{{audience}}',
      '',
      'Where the current truth lives:',
      '{{sources}}',
      '',
      'Work in this order:',
      '1. Read the current docs, the examples, and the source they describe.',
      '2. List every statement that is now wrong, missing, or misleading, with its file and line.',
      '3. Rewrite only those parts, keeping the existing voice, structure, and formatting conventions.',
      '4. Update runnable examples and commands so a reader can copy them verbatim; delete an example that cannot work.',
      '5. Run every command you publish where the environment allows it, and quote the output.',
      '6. Search for the old names, flags, or paths you replaced and fix the occurrences you missed.',
      '',
      'Deliver: the files changed, a short before and after for each substantive edit, and the verification results.',
      'Do not document behaviour you could not confirm in the source, and do not add new marketing claims.',
    ].join('\n'),
  })),
  Object.freeze(normalizeTemplate({
    id: 'research-report',
    title: 'Research a question and write a report',
    whenToUse: 'The answer is not in the repository, several sources must be compared, and the outcome is a '
      + 'written report with evidence and a recommendation.',
    whenNotToUse: [
      'The work is to change code, not to answer a question.',
      'The question has one factual answer that a single lookup settles.',
      'The question needs private data or credentials the run is not allowed to use.',
    ],
    variables: [
      { name: 'question', description: 'The question the report must answer' },
      { name: 'scope', description: 'Time range, sources to use or skip, and hard constraints' },
      { name: 'purpose', description: 'The decision this report serves, so the recommendation is concrete' },
    ],
    skeleton: [
      'Research the following question and return one evidence-backed report.',
      '',
      'Question:',
      '{{question}}',
      '',
      'Scope and constraints:',
      '{{scope}}',
      '',
      'What the report must serve:',
      '{{purpose}}',
      '',
      'Work in this order:',
      '1. Split the question into the sub-questions that must be answered, and say what evidence would answer each.',
      '2. Gather evidence from primary sources where possible, and record the source and date for every claim.',
      '3. Note where sources disagree or the evidence is thin, instead of picking the convenient answer.',
      '4. Answer the question, then state what remains unknown and what would resolve it.',
      '5. End with the concrete recommendation or next action that the purpose above calls for.',
      '',
      'The final report must stand alone for a reader who has not seen this goal: question, findings with sources,',
      'disagreement and uncertainty, and a recommendation. Use a table for anything that compares more than two',
      'options. Do not invent numbers or citations, and do not present a search plan as a result.',
    ].join('\n'),
  })),
])

/** One line per template, for tool output. */
export function formatTemplateList(result, limit = 50) {
  const templates = result.templates ?? []
  if (templates.length === 0) return `no workflow templates (${result.dir ?? 'template directory not initialized'})`
  const rows = templates.slice(0, limit).map(template => {
    const params = template.variables.map(variable => variable.name).join(', ') || 'none'
    return `${template.id}  [${template.source}]  ${template.title}  (params: ${params})`
  })
  const lines = [
    `${templates.length} template(s): ${result.builtin ?? 0} built-in, ${result.custom ?? 0} custom in ${result.dir}`,
    ...rows,
  ]
  if (result.bad > 0) {
    lines.push('', `${result.bad} template file(s) were unreadable or invalid and are skipped; `
      + 'call action="show" on a built-in to see the accepted format')
  }
  return lines.join('\n')
}

/** Full definition of one template, including the skeleton. */
export function formatTemplateDetail(template) {
  const params = template.variables.length > 0
    ? template.variables.map(variable => `- ${variable.name}: ${variable.description}`).join('\n')
    : '- none (the skeleton is complete as written)'
  return [
    `${template.id} [${template.source}] — ${template.title}`,
    '',
    `use when: ${template.whenToUse}`,
    '',
    'do not use when:',
    ...template.whenNotToUse.map(item => `- ${item}`),
    '',
    'parameters (all required):',
    params,
    '',
    'skeleton:',
    template.skeleton,
  ].join('\n')
}

/**
 * Template storage under one state root. Built-ins are read from this module;
 * custom templates are JSON files that use the exact same fields.
 *
 * @param {string} root - absolute state directory (`<root>/templates` is used).
 * @param {{ warn?: (message: string) => void }} [options] - diagnostics sink.
 */
export function createTemplateStore(root, { warn = () => {} } = {}) {
  const dir = path.join(root, 'templates')
  const fileOf = id => path.join(dir, `${id}.json`)

  /**
   * Create the directory and keep it out of git even when the state directory
   * sits inside a repository, the same way the memory notebook does.
   */
  async function initDir() {
    await fsp.mkdir(dir, { recursive: true })
    const ignore = path.join(dir, '.gitignore')
    try {
      await fsp.access(ignore)
    } catch {
      await fsp.writeFile(ignore, '*\n', 'utf8')
    }
  }

  function builtinOf(id) {
    return BUILTIN_TEMPLATES.find(template => template.id === id) ?? null
  }

  return {
    root,
    dir,
    fileOf,

    /** Create the directory and its .gitignore. */
    async init() {
      await initDir()
    },

    /**
     * Every usable template, built-ins first by id, with its source. A
     * hand-edited file that is corrupt, invalid, or uses a built-in id is
     * skipped and counted instead of taking the whole listing down.
     *
     * @returns {Promise<{ templates: object[], builtin: number, custom: number, bad: number, dir: string }>}
     */
    async list() {
      const builtins = BUILTIN_TEMPLATES.map(template => ({ ...template, source: 'builtin' }))
      const taken = new Set(builtins.map(template => template.id))
      const custom = []
      let bad = 0
      let names = []
      try {
        names = await fsp.readdir(dir)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue
        const id = name.slice(0, -'.json'.length)
        if (!ID_PATTERN.test(id)) {
          bad++
          warn(`skipping template file ${name}: the name is not a template id`)
          continue
        }
        let parsed
        try {
          parsed = JSON.parse(await fsp.readFile(fileOf(id), 'utf8'))
        } catch (error) {
          bad++
          warn(`skipping template file ${name}: ${error?.message ?? error}`)
          continue
        }
        const result = validateTemplate(parsed)
        if (!result.ok) {
          bad++
          warn(`skipping template file ${name}: ${result.error.message}`)
          continue
        }
        if (result.template.id !== id) {
          bad++
          warn(`skipping template file ${name}: it defines id "${result.template.id}"`)
          continue
        }
        if (taken.has(id)) {
          bad++
          warn(`skipping template file ${name}: a built-in template already has that id`)
          continue
        }
        custom.push({ ...result.template, source: 'custom' })
      }
      return {
        templates: [...builtins, ...custom].sort((a, b) => a.id.localeCompare(b.id)),
        builtin: builtins.length,
        custom: custom.length,
        bad,
        dir,
      }
    },

    /**
     * Read one template by id. A built-in id always resolves to the built-in,
     * even if a file with that name exists.
     *
     * @param {string} id - template id.
     * @returns {Promise<object | null>} template with `source`, or null.
     */
    async get(id) {
      const key = asText(id)
      if (!ID_PATTERN.test(key) || key.length > MAX_ID_CHARS) return null
      const builtin = builtinOf(key)
      if (builtin) return { ...builtin, source: 'builtin' }
      let parsed
      try {
        parsed = JSON.parse(await fsp.readFile(fileOf(key), 'utf8'))
      } catch {
        return null
      }
      const result = validateTemplate(parsed)
      if (!result.ok || result.template.id !== key) return null
      return { ...result.template, source: 'custom' }
    },

    /**
     * Write a custom template, replacing an earlier file with the same id.
     *
     * @param {unknown} input - full template definition.
     * @returns {Promise<{ id: string, path: string, replaced: boolean }>}
     * @throws {TemplateError} when the definition is invalid or uses a built-in id.
     */
    async save(input) {
      const result = validateTemplate(input)
      if (!result.ok) throw result.error
      const template = result.template
      if (builtinOf(template.id)) {
        throw new TemplateError(
          'builtin-template',
          `"${template.id}" is a built-in template and cannot be overwritten; save your version under a new id`,
        )
      }
      await initDir()
      const file = fileOf(template.id)
      let replaced = false
      try {
        await fsp.access(file)
        replaced = true
      } catch {
        // A new template, not a replacement.
      }
      const tmp = path.join(dir, `.${template.id}.${process.pid}.${Date.now()}.tmp`)
      await fsp.writeFile(tmp, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
      await fsp.rename(tmp, file)
      return { id: template.id, path: file, replaced }
    },

    /**
     * Delete a custom template. Built-ins cannot be deleted: removing one would
     * change what every later session sees, and a built-in can always be ignored
     * by not naming it.
     *
     * @param {string} id - template id.
     * @returns {Promise<{ id: string, removed: boolean }>}
     */
    async remove(id) {
      const key = asText(id)
      if (!ID_PATTERN.test(key) || key.length > MAX_ID_CHARS) {
        throw new TemplateError('unknown-template', `"${id}" is not a template id`)
      }
      if (builtinOf(key)) {
        throw new TemplateError(
          'builtin-template',
          `"${key}" is a built-in template and cannot be deleted; create a custom template instead`,
        )
      }
      try {
        await fsp.unlink(fileOf(key))
        return { id: key, removed: true }
      } catch (error) {
        if (error?.code === 'ENOENT') return { id: key, removed: false }
        throw error
      }
    },
  }
}
