/**
 * Readable error messages for tool results.
 *
 * Host errors reach the plugin as raw strings: SDK messages, filesystem codes,
 * sandbox launcher output, provider HTTP text. A user cannot act on
 * `Cannot read properties of undefined (reading 'maxDepth')`. This module maps
 * the known shapes to one sentence plus a next step, and always keeps the
 * original text so nothing is hidden.
 *
 * @module dsh-longhaul/errors
 */

const RULES = [
  {
    id: 'sandbox',
    test: /windows-acl-run|--temp is not an existing directory|sandbox.*(acl|launch)/i,
    summary: 'the Windows file sandbox could not start a child process, so that subtask never reached the model',
    hint: 'this is a host sandbox failure, not your goal and not your API key. The subtask is retried once. '
      + 'If it repeats: restart the host, or disable the Windows ACL sandbox in the profile, '
      + 'then run the diagnose-windows-sandbox-acl skill before retrying the run.',
  },
  {
    id: 'quota',
    test: /quota exceeded/i,
    summary: 'the run was not started because the active-run limit is already in use',
    hint: 'wait for a running run with longhaul_status, stop one with longhaul_cancel, '
      + 'or raise maxActiveRuns in the longhaul config and restart the host.',
  },
  {
    id: 'budget',
    test: /budget exceeded|budget reached/i,
    summary: 'the run stopped because it reached its spending cap',
    hint: 'read the partial report first; raise maxModelCallsPerRun or maxTokensPerRun only if this spend was expected.',
  },
  {
    id: 'corrupt',
    test: /not valid json|state file .*damaged|unexpected end of json/i,
    summary: 'a saved run file is damaged, so that run cannot be read',
    hint: 'the original file is kept next to it with a .corrupt- suffix. Inspect it, then delete it; '
      + 'other runs and new runs are unaffected.',
  },
  {
    id: 'unknown-run',
    test: /unknown run/i,
    summary: 'no run with that id is recorded in this state directory',
    hint: 'call longhaul_list to see recorded run ids. If the run was started with a different DSH_HOME or stateDir, '
      + 'point this host at the same directory.',
  },
  {
    id: 'auth',
    test: /\b401\b|\b403\b|unauthori[sz]ed|invalid api key|incorrect api key|authentication failed|invalid_api_key/i,
    summary: 'the model provider rejected the API key',
    hint: 'set the environment variable named by apiKeyEnv (DASHSCOPE_API_KEY or HAODUO_API_KEY) in the environment '
      + 'that starts the host, then restart the host. The key is never stored in the plugin config.',
  },
  {
    id: 'context',
    test: /context length|context window|too many tokens|maximum context|token limit/i,
    summary: 'the model refused the request because the prompt is too long',
    hint: 'lower maxSubtasks so each worker prompt is smaller, or configure a model with a larger context window.',
  },
  {
    id: 'network',
    test: /fetch failed|econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up|network error|\b50[234]\b/i,
    summary: 'the model provider could not be reached',
    hint: 'check network or proxy access to the provider. The subtask was retried; longhaul_resume will retry it again '
      + 'without re-running the subtasks that already finished.',
  },
  {
    id: 'filesystem',
    test: /\bEPERM\b|\bEACCES\b|\bEBUSY\b|\bENOSPC\b|no space left|read-only file system|permission denied/i,
    summary: 'the plugin could not write its state directory',
    hint: 'make sure stateDir (default $DSH_HOME/state/longhaul) is writable by the user running the host. '
      + 'On Windows, antivirus software and synced folders such as OneDrive can lock these files.',
  },
  {
    id: 'host-api',
    test: /reading 'maxDepth'|reading "maxDepth"|cannot read properties of undefined|is not a function|startActivation/i,
    summary: 'the harness API did not match what this plugin expects, so the child agent could not be created',
    hint: 'check that the harness version satisfies the plugin engines field (dsh >=0.2.2-rc.1 <0.3.0). '
      + 'This is a version mismatch, not a problem with the goal.',
  },
  {
    id: 'no-goal',
    test: /goal is required/i,
    summary: 'longhaul_start was called without a goal',
    hint: 'pass a concrete goal string, for example "compare X and Y and return a table of prices".',
  },
  {
    id: 'no-agent',
    test: /no live agent|live parent agent/i,
    summary: 'the tool was called outside a live session',
    hint: 'start runs from an interactive session; a run needs a parent agent to own its children.',
  },
  {
    id: 'no-subagents',
    test: /subagent service is unavailable/i,
    summary: 'this profile has no subagent service, so the plugin cannot spawn workers',
    hint: 'enable the subagents service in the profile or use a bundle that includes it.',
  },
  {
    id: 'recursion',
    test: /^refused:/i,
    summary: 'a longhaul worker tried to start or resume a run, which is blocked',
    hint: 'workers must finish their own subtask; only the top-level agent starts runs.',
  },
]

function rawOf(input) {
  if (input === null || input === undefined) return ''
  const text = typeof input === 'string' ? input : input.message ?? String(input)
  return String(text).trim()
}

function shorten(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Classify one error message.
 * @param {unknown} input - Error, message, or diagnostic string.
 * @returns {{ id: string, summary: string, hint: string, detail: string }}
 */
export function classifyError(input) {
  const detail = rawOf(input) || 'unknown error'
  for (const rule of RULES) {
    if (rule.test.test(detail)) return { id: rule.id, summary: rule.summary, hint: rule.hint, detail }
  }
  return {
    id: 'unclassified',
    summary: shorten(detail, 300),
    hint: 'this is the untouched message from the host. If it is not actionable, call longhaul_list to check '
      + 'state, then retry once; the failure is recorded, so longhaul_resume will retry only the failed subtasks.',
    detail,
  }
}

/**
 * One-line form used inside run listings and subtask rows.
 * @param {unknown} input - Error, message, or diagnostic string.
 * @returns {string} summary sentence.
 */
export function summarizeError(input) {
  const { summary } = classifyError(input)
  return summary.endsWith('.') ? summary.slice(0, -1) : summary
}

/**
 * Full form used as a tool result.
 * @param {unknown} input - Error, message, or diagnostic string.
 * @returns {string} `[error]` block with hint and untouched detail.
 */
export function describeError(input) {
  const { summary, hint, detail } = classifyError(input)
  return [
    `[error] ${summary}`,
    `hint: ${hint}`,
    `detail: ${detail}`,
  ].join('\n')
}
