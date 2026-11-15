/**
 * dsh-superagent — the Chinese copy the board shows to a person.
 *
 * Every string here answers "what happened, why do I care, what can I do".
 * Raw error text is kept as `detail` so the page can fold it away instead of
 * leading with a stack trace.
 *
 * @module dsh-superagent/board-messages
 */

export const RUN_STATUS = Object.freeze({
  queued: '排队中',
  planning: '正在拆解任务',
  running: '正在执行',
  aggregating: '正在汇总结果',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被中断，可继续',
})

export const SUBTASK_STATUS = Object.freeze({
  pending: '等待执行',
  waiting: '等待前置任务',
  running: '正在执行',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  unverified: '等你确认',
  cancelled: '已取消',
  blocked: '缺少能力，未启动',
})

export const INBOX_KIND = Object.freeze({
  question: '需要你回答',
  review: '需要你验收',
  permission: '需要你授权',
  human: '需要你亲自操作',
  resume: '需要你继续',
})

export function runStatusLabel(status) {
  return RUN_STATUS[status] ?? (status ? `未知状态（${status}）` : '未知状态')
}

export function subtaskStatusLabel(status) {
  return SUBTASK_STATUS[status] ?? (status ? `未知状态（${status}）` : '未知状态')
}

const CAPABILITY_HINTS = Object.freeze({
  browser: '在宿主的工具配置里启用 runtime.browser，或换一个带浏览器工具的会话。',
  desktop: '在宿主配置里启用 runtime.desktop，或在有桌面控制能力的会话里重跑。',
  shell: '给当前会话加上命令执行工具，或在支持命令的会话里重跑。',
  network: '当前会话禁用了联网工具；换一个有联网能力的会话再重跑。',
})

export function capabilityHint(name) {
  return CAPABILITY_HINTS[name] ?? `给当前会话加上提供「${name}」的工具，然后从待办里点重跑。`
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function firstMissing(subtask) {
  return Array.isArray(subtask?.missingCapabilities) ? subtask.missingCapabilities.filter(Boolean) : []
}

/**
 * Explain one failure in plain Chinese.
 *
 * @param {object} run - run record, or a subtask-bearing view.
 * @param {object | null} [subtask] - the subtask the failure belongs to.
 * @returns {{ code: string, title: string, what: string, why: string, action: object | null, detail: string | null }}
 */
export function explainFailure(run, subtask = null) {
  const raw = textOf(subtask?.error) || textOf(subtask?.blockedReason) || textOf(subtask?.unverifiedReason)
    || textOf(run?.error) || ''
  const missing = firstMissing(subtask)
  const source = subtask ?? {}
  const where = source.title ? `「${source.title}」` : '这个任务'

  if (missing.length > 0 || source.blockKind === 'capability') {
    return {
      code: 'capability-missing',
      title: '缺少这项能力，任务没有开始',
      what: `${where}需要 ${missing.join('、') || '一个当前会话没有的工具'}，当前会话没有提供，所以它没有启动，也没有花 token。`,
      why: '能力预检在开工前就拦住了它，这是有意的：让一个没有工具的模型硬做，只会编造结果。',
      action: { kind: 'config', label: '看看怎么补上这项能力' },
      detail: raw || null,
    }
  }

  if (/plan rejected|no parsable plan|planner did not return a usable plan|planner reply|plan is not|unparsable/i.test(raw)) {
    return {
      code: 'plan-unusable',
      title: '规划器没有给出能执行的计划',
      what: '任务在拆解阶段就停了，一个子任务都没有启动。常见原因是模型回复不是合法 JSON，或计划里出现了循环依赖。',
      why: '与其拿一份看不懂的计划硬跑，不如停下来把原因告给你，这样不会白花钱。',
      action: { kind: 'retry', label: '重新规划并重试' },
      detail: raw || null,
    }
  }

  if (/empty deliverable|deliverable|交付物|expected a .* file|not a file|misplaced/i.test(raw)) {
    return {
      code: 'deliverable-missing',
      title: '子任务说做完了，但交付物没通过检查',
      what: `${where}声明要交出的文件或结果没有通过校验：可能不存在、是空的、类型不对，或被写到了别的目录。`,
      why: '完成与否看的是产物，不是模型说自己做完了。没有产物的「完成」会污染最后的报告。',
      action: { kind: 'rerun', label: '让这条子任务重做' },
      detail: raw || null,
    }
  }

  if (/spawn\s+EPERM/i.test(raw)) {
    return {
      code: 'spawn-eperm',
      title: '系统拒绝了启动子任务进程',
      what: '宿主沙箱不允许再启动一个子进程（spawn EPERM）。这是宿主的权限边界，不是任务本身做错了。',
      why: '常见于沙箱权限过严或临时目录不可写；子任务需要在自己的会话里启动。',
      action: { kind: 'config', label: '查看沙箱设置说明' },
      detail: raw || null,
    }
  }

  if (/sandbox|EPERM|EACCES|not writable|cannot write|write denied|ACL|permission denied|access is denied/i.test(raw)) {
    return {
      code: 'sandbox-write',
      title: '沙箱不允许写入这个目录',
      what: `${where}需要写文件，但目标目录不在当前会话的可写范围里，写入被拒绝了。`,
      why: '沙箱的可写边界跟随父会话的工作目录；工作目录和任务目录不一致时会这样。',
      action: { kind: 'config', label: '查看工作目录设置' },
      detail: raw || null,
    }
  }

  if (/subagent-unavailable|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|unauthorized|401|403|429|model.*(not found|unavailable)|endpoint|provider|api key|rate limit|额度/i.test(raw)) {
    return {
      code: 'model-unavailable',
      title: '模型或接口暂时不可用',
      what: '子任务需要调用模型，但请求被拒绝、超时，或这个模型在当前配置里找不到。',
      why: '这通常是地址、密钥、额度或模型名的问题，任务本身没有被执行。',
      action: { kind: 'model', label: '检查模型配置' },
      detail: raw || null,
    }
  }

  if (/deadline|timed? ?out|budget|max(imum)? (spend|tokens|model calls)|quota|额度|超时/i.test(raw)) {
    return {
      code: 'budget-or-timeout',
      title: '预算或时间用完了',
      what: '运行达到了时间、token 或花费上限，剩下的工作没有继续。已经完成的部分会保留。',
      why: '上限是为了避免一次运行花掉太多；提高上限或缩小目标后可以继续。',
      action: { kind: 'retry', label: '继续未完成的工作' },
      detail: raw || null,
    }
  }

  if (/owning session .* is not live|owner session|not live/i.test(raw)) {
    return {
      code: 'schedule-owner-gone',
      title: '定时计划的发起会话已经关闭',
      what: '定时任务由创建它的会话发起；那个会话已经不在了，所以这次窗口没有执行。',
      why: '定时运行需要一个活着的会话来承载权限和模型配置。',
      action: { kind: 'config', label: '查看定时任务说明' },
      detail: raw || null,
    }
  }

  if (source.status === 'cancelled') {
    return {
      code: 'cancelled',
      title: '这条子任务被你取消了',
      what: '它停下了，同一次运行里的其他子任务不受影响。依赖它的子任务会被跳过，并注明原因。',
      why: '取消只停这一条，不会重跑整个任务。',
      action: { kind: 'rerun', label: '重新运行这一条' },
      detail: null,
    }
  }

  if (source.status === 'unverified') {
    return {
      code: 'needs-review',
      title: '交付物需要你确认',
      what: `${where}写出了文件，但当前会话没有能力判断它是否正确，所以没有算作完成。`,
      why: '让一个无法验证的模型自称完成，会污染最终报告；这一票留给你。',
      action: { kind: 'review', label: '去验收' },
      detail: raw || null,
    }
  }

  return {
    code: 'unknown',
    title: '运行失败了',
    what: raw ? `失败信息：${raw}` : '没有拿到具体错误。可以先重试；如果重复出现，把诊断信息复制出来。',
    why: '这条错误不在已知类型里，原始信息保留在下面。',
    action: { kind: 'retry', label: '重试' },
    detail: raw || null,
  }
}

/**
 * Explain a whole run. Subtask failures win over the run's own summary because
 * they name the thing that actually broke.
 *
 * @param {object} run - run record.
 * @returns {object | null} an explanation, or null when nothing failed.
 */
export function explainRun(run) {
  const failed = (run?.subtasks ?? []).find(subtask => subtask.status === 'failed' && subtask.error)
  if (failed) return { ...explainFailure(run, failed), subtaskKey: failed.key ?? null }
  const blocked = (run?.subtasks ?? []).find(subtask => subtask.status === 'blocked')
  if (blocked) return { ...explainFailure(run, blocked), subtaskKey: blocked.key ?? null }
  const unverified = (run?.subtasks ?? []).find(subtask => subtask.status === 'unverified')
  if (unverified) return { ...explainFailure(run, unverified), subtaskKey: unverified.key ?? null }
  if (run?.error) return explainFailure(run, null)
  return null
}

/** A short, non-technical label for why a subtask never ran. */
export function skipReason(subtask, run) {
  if (subtask?.status !== 'skipped') return null
  const upstream = Array.isArray(subtask.waitingOn) && subtask.waitingOn.length > 0
    ? subtask.waitingOn
    : (subtask.dependsOn ?? [])
  const names = upstream.map(key => {
    const other = (run?.subtasks ?? []).find(item => item.key === key)
    if (!other) return key
    return `${other.title || key}（${subtaskStatusLabel(other.status)}）`
  })
  if (names.length > 0) return `前置任务没有完成：${names.join('、')}`
  return subtask.skippedReason || '前置任务没有完成'
}

const PARAM_COPY = Object.freeze({
  symptom: { label: '故障现象', hint: '粘贴真实报错或错误输出，不要转述' },
  reproduction: { label: '复现步骤', hint: '能触发问题的命令或操作步骤' },
  expected: { label: '期望结果', hint: '正确时应有的行为' },
  scope: { label: '允许改动的范围', hint: '可改的文件或模块，以及不能碰的部分' },
  target: { label: '要审查的对象', hint: 'diff、文件或模块' },
  focus: { label: '审查重点', hint: '正确性、安全、性能、兼容性等' },
  verification: { label: '验证方式', hint: '证明修复有效的命令或检查' },
  change: { label: '改了什么', hint: '代码或配置的变更内容' },
  audience: { label: '读者是谁', hint: '他们已具备哪些背景知识' },
  sources: { label: '权威来源', hint: '保存当前事实的文件' },
  question: { label: '要研究的问题', hint: '报告必须回答的问题' },
  scope_research: { label: '范围与限制', hint: '时间范围、可用或不可用的来源' },
  purpose: { label: '报告用途', hint: '这份报告要支持哪个决定' },
})

export function parameterCopy(name) {
  return PARAM_COPY[name] ?? { label: name, hint: '按模板要求填写' }
}

const TEMPLATE_COPY = Object.freeze({
  'bugfix-verify': {
    purpose: '修一个已知的缺陷，并用测试证明修好了',
    bestFor: '有稳定复现步骤的 bug',
    estimate: 3,
  },
  'review-fix': {
    purpose: '审查一段代码，并把确认的问题直接修掉',
    bestFor: '提交前审查、模块体检',
    estimate: 3,
  },
  'docs-examples': {
    purpose: '让文档和示例与代码的真实行为一致',
    bestFor: '改了接口、配置或命令之后',
    estimate: 2,
  },
  'research-report': {
    purpose: '比较多个来源，产出一份有证据的调研报告',
    bestFor: '需要结论和推荐动作的问题',
    estimate: 3,
  },
})

export function templateCopy(id) {
  return TEMPLATE_COPY[id] ?? { purpose: '按模板发起一次多子任务运行', bestFor: '不确定时先看模板说明', estimate: 3 }
}

/** One sentence a person can act on, without reading the stack. */
export function humanizeErrorText(text) {
  const explanation = explainFailure({ error: text }, null)
  return explanation.title
}
