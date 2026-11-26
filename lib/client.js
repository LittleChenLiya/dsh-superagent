/**
 * dsh-superagent — browser half.
 *
 * The "全局助理" entry opens a main panel that is rendered natively inside
 * the host React tree: host primitives (Button, MarkdownText, the host icon set)
 * plus the host's measured geometry, so the panel reads as one of the shell's
 * own spaces. Nothing is framed: the page never carries its own chrome.
 *
 * Data still comes from the loopback console through the node half's
 * same-origin relay (`/superagent/api` → `/api`), so no CORS or token handling
 * lives in the browser.
 *
 * Failure containment is deliberate: this file must never take the host page
 * down. The top level only registers a factory; everything else runs inside
 * `apply`, so a bad relay or a missing slot leaves the entry absent instead of
 * breaking the frame.
 *
 * @module dsh-superagent/client
 */

window.__ModuleLoader__.load({
  id: '@xiangyixie/dsh-superagent',
  factory: require => {
    // The host rejects the whole composition when a client module exposes no
    // `apply`, so publish a valid face first and only then fill it in.
    const exports = { apply() {} }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const PANEL_ID = 'superagent'
    const PANEL_LABEL = '全局助理'
    const RAIL_TABS = [
      { id: 'overview', label: '概览' },
      { id: 'tasks', label: '任务' },
      { id: 'artifacts', label: '产物' },
      { id: 'inbox', label: '待办' },
      { id: 'automation', label: '自动化' },
      { id: 'more', label: '更多' },
    ]
    const MORE_ENTRIES = [
      { id: 'notifications', label: '通知中心', icon: 'checklist', description: '收件箱、每日简报与免打扰' },
      { id: 'capabilities', label: '能力中心', icon: 'code', description: 'Skills、MCP 与授权状态' },
      { id: 'memory', label: '记忆中心', icon: 'folder', description: '搜索、更正与遗忘可写记忆' },
      { id: 'runtime', label: '运行时视图', icon: 'panel', description: '截图、人工接管、释放与停止' },
      { id: 'evidence', label: '质量证据', icon: 'check', description: '当前或最近任务的验收与审计证据' },
      { id: 'cost', label: '成本中心', icon: 'clock', description: '按币种汇总成本与未定价用量' },
      { id: 'profiles', label: 'Agent 档案', icon: 'spark', description: '查看 Agent 路由并启停档案' },
      { id: 'device', label: '设备配对', icon: 'panel', description: '查看设备状态并创建配对凭据' },
      { id: 'plan', label: '计划预览', icon: 'checklist', description: '从任务子任务预览阻塞、警告与成本' },
      { id: 'automations', label: '自动化规则', icon: 'clock', description: '创建、预览、启停并立即运行自动化' },
      { id: 'shares', label: '分享', icon: 'right', description: '创建、查看并撤销产物的只读分享' },
      { id: 'market', label: '市场', icon: 'plus', description: '搜索市场、导入本地 Skill 并查看安装交接' },
      { id: 'cloud-worker', label: '云端 Worker', icon: 'code', description: '提交任务、查询 Worker 并完成产物' },
    ]
    /** Same-origin relay owned by this plugin's node half. */
    const API = '/superagent/api/console'
    const RETRIES = 8
    const RETRY_MS = 500
    const STYLE_ID = 'dsh-superagent-native-style'

    /**
     * What a receipt button opens. A phase receipt carries phaseId+runId, so it
     * must reach that phase's own execution evidence; a whole-task receipt
     * opens the task. When the run record is gone the click still lands on the
     * owning task and says so, instead of silently doing nothing.
     * @returns {Promise<{opened: 'phase'|'task'|null, phaseId?: string, runId?: string, taskId?: string, fellBack?: boolean}>}
     */
    async function openReceiptTarget({ message, openRun, openTask, notify }) {
      const phaseId = message?.phaseId ?? null
      const runId = message?.runId ?? null
      if (phaseId && runId) {
        let opened = false
        try {
          opened = await openRun(runId)
        } catch {
          opened = false
        }
        if (opened) return { opened: 'phase', phaseId, runId }
      }
      if (message?.taskId) {
        try {
          await openTask(message.taskId)
          if (phaseId) notify(`阶段 ${phaseId} 的执行记录已失效，已打开所属任务。`)
          return { opened: 'task', phaseId, runId, taskId: message.taskId, fellBack: Boolean(phaseId) }
        } catch {
          notify(phaseId ? `阶段 ${phaseId} 的记录暂时无法打开。` : '任务记录暂时无法打开。')
          return { opened: null, phaseId, runId, taskId: message.taskId }
        }
      }
      notify('这条回执没有可打开的记录。')
      return { opened: null, phaseId, runId }
    }

    let react = null
    try {
      react = require('react')
    } catch (error) {
      console.error('[dsh-superagent] cannot load react; the sidebar entry stays absent', error)
    }

    // Route A: the host exposes its own component library to plugin clients.
    // Anything missing here degrades to a plain element, never to a second
    // visual language (the metrics below are the host's).
    let ui = null
    try {
      ui = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      ui = null
    }

    const h = react ? react.createElement : null
    const ReactFragment = react?.Fragment ?? Symbol.for('react.fragment')
    // React.memo / React.forwardRef components are objects, not functions.
    // Checking typeof alone silently rejected MarkdownText and Button and made
    // assistant prose fall back to raw text.
    const isComponent = value => typeof value === 'function'
      || (value !== null && typeof value === 'object'
        && (value.$$typeof === Symbol.for('react.memo') || value.$$typeof === Symbol.for('react.forward_ref')))
    const pick = name => (isComponent(ui?.[name]) ? ui[name] : null)
    const Button = pick('Button')
    const MarkdownText = pick('MarkdownText')
    const UserMessageBubble = pick('UserMessageBubble')
    const StateDot = pick('StateDot')
    const Tooltip = pick('Tooltip')
    // Host process rows and surfaces: reasoning/tool rows, activity text, the
    // transient notice, inline fields, option capsules, document previews and
    // the file glyphs all exist in the primitives package, so the panel never
    // draws a near-copy of them.
    const DisclosureRow = pick('DisclosureRow')
    const TextShimmer = pick('TextShimmer')
    const Toast = pick('Toast')
    const Input = pick('Input')
    const Pill = pick('Pill')
    const Tag = pick('Tag')
    const FileTypeIcon = pick('FileTypeIcon')
    const ImageLightbox = pick('ImageLightbox')
    const QuotePreview = pick('QuotePreview')
    const DetailDocument = pick('DetailDocument')
    const CodeBlock = pick('CodeBlock')
    const FishLogo = pick('FishLogo')
    const MISSING_PRIMITIVES = ['Button', 'MarkdownText', 'UserMessageBubble', 'StateDot', 'Tooltip',
      'DisclosureRow', 'TextShimmer', 'Toast', 'Input', 'Pill', 'Tag', 'FileTypeIcon',
      'ImageLightbox', 'QuotePreview', 'DetailDocument', 'CodeBlock']
      .filter(name => !pick(name))
    if (!ui) {
      console.warn('[dsh-superagent] host primitives module is absent; assistant text renders as plain text')
    } else if (MISSING_PRIMITIVES.length > 0) {
      console.warn(`[dsh-superagent] host primitives unavailable: ${MISSING_PRIMITIVES.join(', ')}; those spots fall back to plain rendering`)
    }
    const ICONS = {
      spark: ui?.IconSparkleRegular ?? ui?.IconSparkleMedium,
      send: ui?.IconSendOutlineRegular ?? ui?.IconSendOutlineMedium,
      stop: ui?.IconStopFillRegular ?? ui?.IconStopFillMedium,
      clock: ui?.IconClockOutlineRegular ?? ui?.IconClockOutlineMedium,
      check: ui?.IconCheckOutlineRegular ?? ui?.IconCheckOutlineMedium,
      close: ui?.IconCloseOutlineRegular ?? ui?.IconCloseOutlineMedium,
      folder: ui?.IconFolderCloseRegular ?? ui?.IconFolderCloseMedium,
      panel: ui?.IconPanelRightOutlineRegular ?? ui?.IconPanelLeftOutlineRegular,
      down: ui?.IconChevronDownOutlineRegular ?? ui?.IconChevronDownRegular,
      right: ui?.IconChevronRightOutlineRegular ?? ui?.IconChevronRightRegular,
      back: ui?.IconArrowLeftOutlineRegular ?? ui?.IconChevronLeftOutlineRegular,
      // The host's own glyphs for the three process rows the panel shows.
      think: ui?.IconThinkOutlineRegular ?? ui?.IconThinkOutlineMedium,
      code: ui?.IconCodeOutlineRegular ?? ui?.IconCodeOutlineMedium,
      question: ui?.IconQuestionOutlineRegular ?? ui?.IconQuestionOutlineMedium,
      attach: ui?.IconPaperclipOutlineRegular ?? ui?.IconPaperclipOutlineMedium,
      checklist: ui?.IconChecklistOutlineRegular ?? ui?.IconChecklistOutlineMedium,
      plus: ui?.IconPlusOutlineRegular ?? ui?.IconPlusOutlineMedium,
      mic: ui?.IconMicrophoneOutlineRegular ?? ui?.IconMicrophoneOutlineMedium
        ?? ui?.IconVoiceOutlineRegular ?? ui?.IconVoiceOutlineMedium,
      share: ui?.IconShareOutlineRegular ?? ui?.IconShareOutlineMedium,
      device: ui?.IconDeviceOutlineRegular ?? ui?.IconDeviceOutlineMedium,
    }
    // MarkdownText reads `labels.code` on every fenced block, so the host
    // component is only safe with this shape filled in.
    const MARKDOWN_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: {
          codeLabel: '代码',
          wrapLabel: '换行',
          unwrapLabel: '取消换行',
        },
      },
      footnotes: '脚注',
    }
    /** DetailDocument chrome; same markdown labels as assistant prose. */
    const DETAIL_LABELS = {
      title: '产物内容',
      loading: '正在读取产物…',
      retry: '重试',
      markdown: MARKDOWN_LABELS,
    }
    /**
     * Host tooltip when it exists; the native `title` only survives as the
     * fallback for a host that ships no primitives at all.
     */
    function tipped(label, node, side = 'bottom', key) {
      if (Tooltip) return h(Tooltip, { key, label, side }, node)
      return react.cloneElement(node, { key, title: label })
    }

    const MARKDOWN_FALLBACKS = new Set()
    function noteMarkdownFallback(id, reason) {
      if (MARKDOWN_FALLBACKS.has(id)) return
      MARKDOWN_FALLBACKS.add(id)
      console.error(`[dsh-superagent] assistant message ${id} fell back to plain text: ${reason}`)
    }

    // A throw inside MarkdownText must be visible, not silently swallowed by
    // React. This logs once and keeps the prose on screen as plain text.
    const MarkdownBoundary = react && typeof react.Component === 'function'
      ? class MarkdownBoundary extends react.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }
        static getDerivedStateFromError() {
          return { failed: true }
        }
        componentDidCatch(error) {
          noteMarkdownFallback(this.props.messageId, error?.message ?? String(error))
        }
        render() {
          return this.state.failed
            ? h('div', { className: 'dsa-md-plain' }, this.props.text)
            : this.props.children
        }
      }
      : null

    const CSS = `
.dsa-root{--dsa-col:var(--dsh-chat-content-width,740px);--dsa-side:24px;display:flex;flex-direction:column;height:100%;min-width:0;container:dsa-shell / inline-size;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:22px}
.dsa-header{position:relative;z-index:12;display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-height:48px;padding:0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsa-header-start,.dsa-header-actions{display:flex;align-items:center;gap:4px;min-width:0}
.dsa-header-actions{flex:none}
.dsa-header-title{display:flex;align-items:center;gap:4px;min-width:0;height:30px;box-sizing:border-box;padding:4px 8px;color:inherit;font:inherit;font-size:14px;font-weight:500;line-height:20px;border:0;border-radius:var(--dsw-radius-sm);background:none;cursor:pointer}
.dsa-header-action:hover,.dsa-header-action[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-header-title span,.dsa-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-header-title svg,.dsa-header-action svg,.dsa-file-card svg,.dsa-receipt-icon svg{flex:none}
.dsa-header-action{display:flex;align-items:center;gap:5px;min-height:30px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}
.dsa-count{min-width:14px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary-bluish);font-size:11px;line-height:16px;text-align:center}
.dsa-iconbtn{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsa-iconbtn svg{width:15px;height:15px}
.dsa-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-iconbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dsa-body{position:relative;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1;min-height:0;overflow:hidden;container-type:size}
.dsa-body[data-rail=open]{grid-template-columns:minmax(0,1fr) clamp(340px,34%,416px)}
.dsa-main{grid-column:1;grid-row:1;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}
.dsa-main[data-empty=true]{justify-content:safe center;overflow:auto}
.dsa-main[data-empty=true] > .dsa-scroll{display:none}
.dsa-project-nav{min-width:0;overflow:auto}
.dsa-project-nav .dsa-rowitem[data-current=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-project-head{display:flex;align-items:center;justify-content:space-between;padding:10px 8px 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsa-picker-actions{display:flex;flex-wrap:wrap;gap:4px;padding:6px 2px 2px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsa-project-add{display:grid;gap:4px;padding:5px 2px}
.dsa-project-add input{min-width:0;width:100%;box-sizing:border-box}
.dsa-project-add > span{display:block;box-sizing:border-box;width:100%;min-width:0}
.dsa-msg .dsa-reply{opacity:0;display:block;margin:2px 0 0 auto}
.dsa-msg:hover .dsa-reply,.dsa-reply:focus-visible{opacity:1}
.dsa-quote{display:flex;gap:6px;align-items:center;margin:0 10px;padding:4px 7px;border-left:2px solid var(--dsw-alias-border-l3);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsa-quote span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-workbench{grid-column:2;grid-row:1;min-width:0;overflow:hidden;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);container:dsa-rail / inline-size}
.dsa-workbench-badge{display:flex;align-items:center;gap:10px;flex:none;min-height:58px;padding:10px 12px 8px 16px}
.dsa-workbench-avatar{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-card-tile-fill,var(--dsw-specific-selector));color:var(--dsw-alias-label-primary);overflow:hidden}
.dsa-workbench-avatar img{width:100%;height:100%;object-fit:cover}
.dsa-workbench-identity{display:grid;flex:1;min-width:0;gap:2px}
.dsa-workbench-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsa-workbench-status{min-width:0;margin-top:4px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsa-workbench-role{display:flex;align-items:center;gap:6px;min-width:0;font-size:14px;line-height:20px;font-weight:500}
.dsa-workbench-online{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:11px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dsa-workbench-online::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}
.dsa-workbench-workspace{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsa-workbench-tabs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));flex:none;gap:2px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsa-workbench-tab{min-width:0;height:34px;padding:0 2px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsa-workbench-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-workbench-tab[aria-selected=true]{border-bottom-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.dsa-workbench-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dsa-rail-detail-head{display:flex;align-items:center;gap:8px;flex:none;min-height:42px;padding:0 8px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsa-rail-detail-head h2{flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:13px;font-weight:500}
.dsa-rail-scrim{display:none}
.dsa-workbench-scroll{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:10px 12px 16px}
.dsa-workbench > [role=tabpanel]{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}
.dsa-workbench > [role=tabpanel][hidden]{display:none}
.dsa-workbench-section{padding:8px 0}
.dsa-workbench-section+.dsa-workbench-section{border-top:.5px solid var(--dsw-alias-border-l3)}
.dsa-workbench-section h3{margin:0 8px 4px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.dsa-workbench-empty{padding:4px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsa-overview{display:grid;gap:14px}
.dsa-overview-section{display:grid;gap:6px;min-width:0}
.dsa-overview-section h3{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsa-overview-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsa-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.dsa-summary-stat{display:grid;gap:2px;min-width:0;padding:8px 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-card-fill)}
.dsa-summary-stat strong{font-size:18px;line-height:24px;font-weight:500}
.dsa-summary-stat span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsa-summary-stat[data-tone=error] strong{color:var(--dsw-alias-state-error-primary)}
.dsa-summary-stat[data-tone=warning] strong{color:var(--dsw-alias-state-warn-primary)}
.dsa-overview-list{display:grid;gap:4px}
.dsa-overview-row{width:100%;min-width:0;min-height:40px;height:auto;padding-block:5px}
.dsa-overview-row .dsa-task-label > span:first-child{white-space:normal;overflow-wrap:anywhere}
.dsa-overview-inbox{display:grid;gap:6px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dsa-overview-inbox p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsa-artifact-tools{display:grid;gap:8px;margin-bottom:10px}
.dsa-artifact-filters{display:flex;flex-wrap:wrap;gap:6px}
.dsa-artifact-filters select{flex:1;min-width:96px;max-width:100%}
.dsa-artifact-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.dsa-artifact-list{grid-template-columns:minmax(0,1fr)!important}
.dsa-artifact-card{display:grid;gap:7px;width:100%;min-width:0;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-card-fill);color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsa-artifact-card:hover{background:var(--dsw-alias-card-fill-hover,var(--dsw-alias-interactive-bg-hover))}
.dsa-artifact-card:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsa-artifact-title{display:flex;align-items:flex-start;gap:7px;min-width:0;font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.dsa-artifact-title .dsa-file-icon{width:26px;height:26px}
.dsa-artifact-title span:last-child{flex:1;min-width:0}
.dsa-artifact-goal{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsa-artifact-meta{display:flex;flex-wrap:wrap;gap:4px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dsa-artifact-error,.dsa-automation-error{padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsa-automation-list{display:grid;gap:8px}
.dsa-automation-record{display:grid;gap:5px;width:100%;min-width:0;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-card-fill);color:inherit;font:inherit;text-align:left}
button.dsa-automation-record{cursor:pointer}
button.dsa-automation-record:hover{background:var(--dsw-alias-card-fill-hover,var(--dsw-alias-interactive-bg-hover))}
.dsa-automation-record strong{min-width:0;font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.dsa-automation-record .dsa-artifact-meta{margin-top:2px}
@container dsa-rail (min-width:360px){.dsa-artifact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.dsa-workbench > .dsa-scroll{padding-inline:14px}
.dsa-workbench .dsa-goal-phase{align-items:flex-start}
@container dsa-shell (max-width:820px){
  .dsa-body[data-rail=open]{grid-template-columns:minmax(0,1fr)}
  .dsa-workbench{position:absolute;grid-column:1/-1;inset:0 0 0 auto;width:min(400px,100%);z-index:10;box-shadow:var(--dsw-elevation-panel)}
  .dsa-rail-scrim{display:block;position:absolute;inset:0;z-index:9;border:0;background:color-mix(in srgb,#000 25%,transparent);cursor:pointer}
}
@container dsa-shell (max-width:480px){
  .dsa-header{padding-inline:8px}
  .dsa-header-action{padding-inline:6px}
  .dsa-scroll,.dsa-composer,.dsa-hero{padding-inline:12px}
  .dsa-composer{--dsa-side:12px}
  .dsa-workbench{width:min(375px,100%)}
  .dsa-project-nav{max-height:min(70vh,470px)}
}
.dsa-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;margin-right:2px;padding:0 32px;scrollbar-gutter:stable}
.dsa-scroll::-webkit-scrollbar{width:10px}
.dsa-scroll::-webkit-scrollbar-thumb{border-radius:5px;background:var(--dsw-alias-scrollbar-bg-l1)}
.dsa-flow{width:min(100%,var(--dsa-col));margin:0 auto;padding:16px 0 8px;box-sizing:border-box}
/* New-space hero: 26/32 500 headline and a 12px stack, the host new-session
   hero (HeroShell.module.css:15-45, 122-130). */
.dsa-hero{display:flex;align-items:center;gap:10px;width:min(100%,var(--dsa-col));box-sizing:border-box;margin:0 auto;padding:0 16px 14px}
.dsa-hero-title{font-size:26px;line-height:32px;font-weight:500;margin:0}
.dsa-hero-mark{display:grid;place-items:center;flex:none;width:32px;height:32px;color:var(--dsw-alias-label-primary)}
.dsa-compose-area{padding-bottom:12px}
.dsa-main[data-empty=true] .dsa-compose-area{padding:24px 0 clamp(18px,9vh,92px)}
.dsa-chat-unavailable{max-width:var(--dsa-col);margin:0 auto;padding:4px var(--dsa-side);color:var(--dsw-alias-label-secondary)}
/* Composer card: InputBar.module.css:54-86 (radius panel, elevation-soft
   hairline, 8px top pad, 12px stack gap) and :273-289/335-417 (toolbar row,
   28px attach circle, 34px send circle). */
.dsa-composer{position:relative;flex:none;padding:4px var(--dsa-side) 4px;background:var(--dsw-alias-bg-base)}
.dsa-composer.dragover .dsa-card{outline:2px dashed var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsa-composer.dragover .dsa-composer-hint{color:var(--dsw-alias-state-business-primary)}
.dsa-card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,calc(var(--dsa-col) + 32px));margin:0 auto;padding-top:8px;border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft)}
.dsa-input{box-sizing:border-box;width:100%;min-height:36px;max-height:min(var(--dsh-composer-text-max-height,336px),max(36px,calc(100cqb - 126px)));padding:4px 8px 0 14px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));caret-color:var(--dsw-alias-state-business-primary);resize:none;overflow-y:auto}
.dsa-input::placeholder{color:var(--dsw-alias-label-caption)}
.dsa-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 8px 6px;min-width:0}
.dsa-trailing{display:flex;align-items:center;min-width:0;gap:12px}
.dsa-trailing{margin-left:auto;flex:none}
.dsa-goal-phase{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0}
.dsa-goal-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.dsa-goal-actions > button{height:auto;min-height:28px;min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere}
.dsa-goal-actions > button > span{min-width:0;white-space:normal;overflow-wrap:anywhere}
.dsa-project-chip{display:flex;align-items:center;gap:5px;min-height:28px;max-width:clamp(90px,30cqi,220px);padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-specific-selector);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsa-project-chip svg{flex:none}
.dsa-compose-tools{display:flex;align-items:center;gap:8px;min-width:0}
.dsa-task-list,.dsa-task-stages,.dsa-file-list,.dsa-instruction,.dsa-project-add{grid-template-columns:minmax(0,1fr)}
.dsa-task-list{display:grid;align-content:start;gap:4px}
.dsa-task-list[hidden]{display:none}
.dsa-task-search{width:100%;margin-bottom:6px}
.dsa-task-label{flex:1;min-width:0}
.dsa-task-label > span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-task-row{height:auto;min-height:42px;padding-block:6px}
.dsa-task-row[data-current=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-task-row .dsa-rowtime{font-size:11px}
.dsa-status{display:inline-flex;flex:none;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.dsa-task-stages{display:grid;gap:6px;margin:4px 8px 10px 16px;padding-left:12px;border-left:.5px solid var(--dsw-alias-border-l2)}
.dsa-task-stage{width:100%;justify-content:flex-start;padding-inline:4px}
.dsa-task-stage > span:first-child,.dsa-goal-phase > span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-task-links{margin:0 8px 4px}
.dsa-record-actions{padding:0 4px 2px}
.dsa-record-hint{padding:0 4px 4px}
.dsa-composer-hint{padding:0 14px 4px}
.dsa-run-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px}
.dsa-run-actions .dsa-stop-task{color:var(--dsw-alias-state-error-primary)}
.dsa-workbench-section > summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsa-task-receipt,.dsa-file-card{display:flex;align-items:center;box-sizing:border-box;min-width:0;max-width:100%;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-card-fill,var(--dsw-alias-bg-base));color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsa-task-receipt:hover,.dsa-file-card:hover{background:var(--dsw-alias-card-fill-hover,var(--dsw-alias-interactive-bg-hover))}
.dsa-task-receipt{width:min(100%,460px);margin:4px 0 12px}
.dsa-receipt-copy{display:grid;flex:1;min-width:0;gap:2px}
.dsa-receipt-copy strong{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere;font-size:13px;line-height:20px;font-weight:500}
.dsa-task-receipt:focus-visible,.dsa-header-action:focus-visible,.dsa-project-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsa-receipt-icon,.dsa-file-icon{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-card-tile-fill,var(--dsw-specific-selector));color:var(--dsw-alias-link)}
.dsa-file-card{width:100%;min-height:46px}
.dsa-file-name{flex:1;font-size:13px}
.dsa-file-list{display:grid;gap:6px;margin:4px 0}
.dsa-inbox-project{margin:8px 0 4px;padding-inline:4px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsa-inbox-meta{display:flex;align-items:center;gap:6px;margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.dsa-inbox-unread{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-business-primary)}
.dsa-instruction{display:grid;gap:6px}
.dsa-add{display:grid;place-items:center;flex:none;width:28px;height:28px;border:0;border-radius:999px;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsa-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsa-add[aria-pressed=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary-bluish)}
.dsa-add:disabled{opacity:.5;cursor:default}
.dsa-add svg{width:16px;height:16px}
.dsa-send{display:grid;place-items:center;flex:none;width:34px;height:34px;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-on-color);cursor:pointer;transform:translateY(-2px);transition:background-color 100ms ease}
.dsa-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.dsa-send:disabled{opacity:.4;cursor:default}
.dsa-send svg{width:15px;height:15px}
.dsa-send[data-mode=stop] svg{width:10px;height:10px;border-radius:2px}
.dsa-spin{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;animation:dsa-spin .8s linear infinite}
@keyframes dsa-spin{to{transform:rotate(360deg)}}
.dsa-msg{padding:0 0 4px}
/* User row: 70.2% of the content column, capped at 82% (MessageItem.module.css:20);
   the bubble itself is the host UserMessageBubble — this width is its owner's. */
.dsa-user{display:flex;flex-direction:column;align-items:flex-end;gap:8px;margin-bottom:16px}
.dsa-user > *{max-width:min(calc(var(--dsa-col) * .702),82%)}
.dsa-bubble{box-sizing:border-box;max-width:min(calc(var(--dsa-col) * .702),82%);padding:10px 16px;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}
.dsa-bubble[data-pending=true]{opacity:.6}
.dsa-assistant{display:flex;flex-direction:column;gap:12px;margin-bottom:16px;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));overflow-wrap:anywhere}
.dsa-md-plain{white-space:pre-wrap;overflow-wrap:anywhere}
/* Process rows are the host DisclosureRow (24px header, tertiary ink); the
   nested body keeps the host's 22px indent (MessageItem.module.css:233). */
.dsa-proc{display:flex;flex-direction:column;gap:2px;margin:-4px 0 0}
.dsa-proc-body{margin:2px 0 6px;padding:0 0 0 calc(22px + var(--dsh-content-font-delta,0px));font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dsa-proc-code{margin:0 0 6px;padding-left:calc(22px + var(--dsh-content-font-delta,0px))}
.dsa-typing{display:inline-flex;align-items:center;gap:8px;padding:2px 0 12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsa-approvals{display:flex;flex-direction:column;gap:8px}
/* Approval takeover: ApprovalPanel.module.css:1-18 (warn-secondary border,
   xl radius, input-major fill, lv2 shadow), :20-29 strip, :31-46 body,
   :155-168 command + action row. */
.dsa-approval{display:flex;flex-direction:column;overflow:hidden;width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-card-fill)}
.dsa-approval-bar{display:flex;align-items:center;gap:8px;padding:9px 12px 4px;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.dsa-approval-main{display:flex;flex-direction:column;gap:6px;padding:0 12px 10px}
.dsa-approval-title{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsa-approval-body{font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);word-break:break-all;overflow-wrap:anywhere}
.dsa-approval-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.dsa-rowdot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}
/* 32px host row (Rows.module.css): 14/20 title, 10/16 tertiary trailing. */
.dsa-rowitem{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer}
.dsa-rowitem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-rowtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-rowtime{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-inline-end:-1px}
.dsa-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:24px;text-align:center}
.dsa-note{font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dsa-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.dsa-toast{display:flex;align-items:center;gap:8px;margin:8px auto 0;width:min(calc(100% - 64px),var(--dsa-col));padding:4px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsa-toast[data-kind=err]{color:var(--dsw-alias-state-error-primary)}
.dsa-workspace-picker{position:absolute;bottom:calc(100% + 4px);left:var(--dsa-side);z-index:30;display:flex;flex-direction:column;width:min(320px,calc(100% - 2 * var(--dsa-side)));box-sizing:border-box;max-height:min(55vh,400px);overflow:auto;overscroll-behavior:contain;padding:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base)));box-shadow:var(--dsw-elevation-panel)}
.dsa-workspace-picker > nav{min-height:0}
.dsa-workspace-picker > :not(nav){flex:none}
.dsa-sessions-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 8px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsa-linkbtn{min-height:28px;border:0;background:transparent;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));font:inherit;font-size:12px;line-height:18px;cursor:pointer;padding:2px 6px;border-radius:var(--dsw-radius-sm)}
.dsa-linkbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsa-linkbtn:disabled{opacity:.55;cursor:default}
.dsa-sessions-list{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto}
.dsa-session-row{cursor:pointer}
.dsa-session-row[data-current=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.dsa-session-meta,.dsa-session-row .dsa-rowtime{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsa-detail-sec{display:flex;flex-direction:column;gap:6px;padding-top:8px}
.dsa-detail-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsa-detail-q{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);white-space:pre-wrap}
.dsa-decision-summary{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsa-decision-impact{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsa-decision-details{margin-top:2px}
.dsa-decision-details > summary{cursor:pointer;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsa-decision-details > summary::-webkit-details-marker{display:none}
.dsa-decision-details > summary::before{content:'▸ '}
.dsa-decision-details[open] > summary::before{content:'▾ '}
.dsa-decision-details > pre{max-height:220px;overflow:auto;margin:6px 0 0;padding:8px 9px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:11px/1.55 var(--dsw-font-mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere}
.dsa-answer-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsa-answer-row > button{max-width:100%;min-width:0}
.dsa-answer-row > span{flex:1;min-width:0}
.dsa-answer-input{flex:1;min-width:0;box-sizing:border-box;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}
.dsa-answer-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsa-source-form{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;min-width:0}
.dsa-source-form > .dsa-answer-input{flex:1 1 120px;min-width:0;max-width:100%}
.dsa-source-row{overflow-wrap:anywhere}
.dsa-impact-row{overflow-wrap:anywhere}
.dsa-impact-row .dsa-linkbtn{text-align:left;padding-left:0}
.dsa-attention-card{display:flex;flex-direction:column;gap:8px;overflow-wrap:anywhere;box-sizing:border-box;width:100%;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-card-fill)}
.dsa-attention-title{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsa-attention-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsa-preview-pane,.dsa-preview-content{flex:1;min-height:0;display:flex;flex-direction:column}
.dsa-preview-content{overflow:auto;padding:12px}
.dsa-preview-content > *{min-width:0;max-width:100%;overflow-wrap:anywhere}
.dsa-preview-content :is(pre,table){max-width:100%;overflow:auto}
.dsa-preview-content table{display:block}
.dsa-preview-tools{display:flex;justify-content:flex-end;gap:4px;flex:none;padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsa-preview-img{display:block;max-width:100%;border-radius:var(--dsw-radius-sm)}
.dsa-preview-thumb{display:block;align-self:flex-start;max-width:100%;padding:0;border:0;background:none;cursor:zoom-in}
.dsa-preview-frame{width:100%;flex:1;min-height:220px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.dsa-preview-text{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsa-chip{height:28px;padding:0 12px;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dsa-chip:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsa-more-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.dsa-more-card{display:grid;grid-template-columns:32px minmax(0,1fr) 16px;align-items:center;gap:9px;width:100%;min-width:0;min-height:64px;box-sizing:border-box;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-card-fill);color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsa-more-card:hover{background:var(--dsw-alias-card-fill-hover,var(--dsw-alias-interactive-bg-hover))}
.dsa-more-card:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsa-more-card-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-card-tile-fill,var(--dsw-specific-selector));color:var(--dsw-alias-link)}
.dsa-more-card-copy{display:grid;gap:2px;min-width:0}
.dsa-more-card-copy strong{font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.dsa-more-card-copy span{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dsa-more-panel{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;outline:none}
.dsa-more-head{display:flex;align-items:center;gap:6px;flex:none;min-height:42px;padding:4px 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsa-more-head h2{flex:1;min-width:0;margin:0;font:inherit;font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-more-content{display:grid;align-content:start;gap:10px;min-width:0;padding:10px 0 16px}
.dsa-more-section{display:grid;gap:7px;min-width:0;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-card-fill)}
.dsa-more-section h3{margin:0;font-size:13px;line-height:20px;font-weight:500}
.dsa-more-form{display:grid;gap:8px;min-width:0}
.dsa-more-field{display:grid;grid-template-columns:minmax(92px,.8fr) minmax(0,1.2fr);align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsa-more-field > :is(input,select,textarea){width:100%;min-width:0;box-sizing:border-box}
.dsa-more-field input[type=checkbox]{width:16px;height:16px;justify-self:start;accent-color:var(--dsw-alias-state-business-primary)}
.dsa-more-check{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsa-more-check input{flex:none;accent-color:var(--dsw-alias-state-business-primary)}
.dsa-more-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.dsa-more-actions > button{max-width:100%;min-width:0;white-space:normal;overflow-wrap:anywhere}
.dsa-more-list{display:grid;gap:6px;min-width:0}
.dsa-more-row{display:grid;gap:6px;min-width:0;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}
.dsa-more-row-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
.dsa-more-row-title{flex:1;min-width:0;font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.dsa-more-meta{display:flex;flex-wrap:wrap;gap:3px 9px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dsa-more-error{padding:9px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-error-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsa-more-code{max-height:180px;overflow:auto;margin:0;padding:9px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:11px/1.55 var(--dsw-font-mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere}
.dsa-more-editor{display:grid;gap:8px;min-width:0}
.dsa-more-editor textarea.dsa-answer-input{height:auto;min-height:64px;padding-block:7px;resize:vertical}
.dsa-more-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;padding:7px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warning-tertiary,var(--dsw-alias-interactive-bg-hover));font-size:12px;line-height:18px}
.dsa-more-success{padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-success-tertiary,var(--dsw-alias-card-fill));color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsa-more-token{max-height:96px;user-select:all}
.dsa-more-row[data-enabled=false]{opacity:.72}
.dsa-more-rowactions{display:flex;flex-wrap:wrap;gap:4px 8px;min-width:0}
.dsa-more-rowactions .dsa-linkbtn{padding-left:0}
.dsa-more-statgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.dsa-more-stat{display:grid;gap:2px;min-width:0;padding:8px 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dsa-runtime-frame{display:block;width:100%;max-height:320px;object-fit:contain;background:var(--dsw-alias-bg-base);border-radius:var(--dsw-radius-md)}
.dsa-more-stat strong{font-size:16px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.dsa-more-stat span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsa-plan-issue[data-severity=block]{border-color:var(--dsw-alias-state-error-primary)}
.dsa-plan-issue[data-severity=warning]{border-color:var(--dsw-alias-state-warn-primary)}
.dsa-voice-status{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsa-voice-status[data-state=recording]::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:dsa-voice-pulse 1s ease-in-out infinite}
@keyframes dsa-voice-pulse{50%{opacity:.35}}
.dsa-add[data-voice=true]{color:var(--dsw-alias-state-error-primary)}
@container dsa-rail (min-width:360px){.dsa-more-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container dsa-rail (max-width:375px){
  .dsa-more-grid{grid-template-columns:minmax(0,1fr)}
  .dsa-more-field{grid-template-columns:minmax(0,1fr);gap:4px}
  .dsa-more-row-head{flex-wrap:wrap}
  .dsa-more-statgrid{grid-template-columns:minmax(0,1fr)}
}
`

    /** A plugin reload can leave the previous bundle's sheet in the same document. */
    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      const current = document.getElementById(STYLE_ID)
      if (current) {
        if (current.textContent !== CSS) current.textContent = CSS
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Host icon, or nothing when the primitives module is absent. */
    function Icon(props) {
      const component = ICONS[props.of]
      if (!isComponent(component)) return null
      return h(component, { size: props.size ?? 16, className: props.className })
    }

    /** Local echo while a sent message waits for the host to accept it. */
    let localSeq = 0

    /** One text run out of a content-part array. */
    function contentText(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter(part => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('')
    }

    /** JSON call against the same-origin relay. */
    async function call(path, init) {
      const options = { cache: 'no-store', ...(init ?? {}) }
      const headers = { accept: 'application/json', ...(init?.headers ?? {}) }
      if (init && init.body) headers['content-type'] = 'application/json'
      options.headers = headers
      const response = await fetch(`${API}${path}`, options)
      let body = null
      try {
        body = await response.json()
      } catch {
        // A non-JSON answer means the relay or a gate answered instead.
      }
      if (!response.ok || body?.ok === false) {
        const error = new Error(body?.error?.summary ?? body?.message ?? `HTTP ${response.status}`)
        error.hint = body?.error?.hint ?? body?.hint ?? ''
        error.status = response.status
        // Some intentional handoffs (notably market installation) return a
        // useful, non-executed plan in the error body. Keep it renderable.
        error.data = body?.data ?? null
        throw error
      }
      return body?.data ?? null
    }

    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms))
    }

    function initialMore() {
      return {
        panel: null,
        loading: false,
        error: '',
        notifications: null,
        capabilities: null,
        capabilityResult: null,
        mcpDraft: { name: '', transport: 'stdio', command: 'node', args: '', url: '', env: '', timeoutMs: '' },
        loadedSkill: null,
        memory: null,
        memoryQuery: '',
        runtime: null,
        runtimeDraft: { source: 'auto', confirmStop: false, live: true, frameView: null, streamError: '', cursor: 0 },
        runtimeActionResult: null,
        evidence: null,
        evidenceRunId: '',
        cost: null,
        routeDraft: { role: 'worker', complexity: 'medium', tokens: '4000' },
        routeResult: null,
        costBudgetDraft: { currency: 'USD', micros: '1000000' },
        profiles: null,
        profileDraft: assistantDraftFromProfile(null),
        devices: null,
        pairing: null,
        shares: null,
        market: null,
        cloudWorker: null,
        cloudWorkers: [],
        cloudDraft: null,
        cloudWorkerId: '',
        cloudActionResult: null,
        automations: null,
        automationDraft: automationDraftFromRule(null),
        automationEditId: null,
        automationPreview: null,
        automationExecutions: null,
        automationActionResult: null,
        shareDraft: { artifactId: '', role: 'viewer', ttlMs: 604800000 },
        marketQuery: '',
        marketDetail: null,
        marketHandoff: null,
        marketImport: null,
        planPreview: null,
        planApproval: null,
        planHandoff: null,
        planDraft: { goal: '', tasks: '', allow: 'read, write', deny: 'shell.execute, network', isolation: 'workspace', budget: '' },
        planRunId: null,
        planBusy: false,
        shareBusy: false,
        lastShare: null,
        busy: {},
        confirming: {},
      }
    }

    function listOf(value, ...keys) {
      if (Array.isArray(value)) return value
      for (const key of keys) {
        if (Array.isArray(value?.[key])) return value[key]
      }
      return []
    }

    const GLOBAL_ASSISTANT_ID = 'global-assistant'
    const CANDIDATE_PLAN_ROUTER_VERSION = 'candidate-plan-v1'

    function globalAssistantOf(profiles) {
      const assistants = listOf(profiles, 'profiles', 'items').filter(profile => profile?.role === 'assistant')
      return assistants.find(profile => profile.id === GLOBAL_ASSISTANT_ID) ?? assistants[0] ?? null
    }

    function commaList(value) {
      return [...new Set((Array.isArray(value) ? value : String(value ?? '').split(','))
        .map(item => String(item).trim()).filter(Boolean))]
    }

    function assistantDraftFromProfile(profile) {
      return {
        name: profile?.name ?? 'Global Assistant',
        avatar: profile?.avatar ?? 'assistant',
        provider: profile?.provider ?? '',
        model: profile?.model ?? '',
        tools: commaList(profile?.tools ?? ['read_file']).join(', '),
        permissions: commaList(profile?.permissions ?? ['workspace.read', 'memory.global']).join(', '),
        expectedRevision: profile?.revision ?? null,
        dirty: false,
      }
    }

    /** The reserved identity and fixed global scopes never come from form input. */
    function assistantProfilePayload(draft = {}, profiles = null) {
      const editable = {
        name: String(draft.name ?? '').trim(),
        avatar: String(draft.avatar ?? '').trim() || null,
        provider: String(draft.provider ?? '').trim() || null,
        model: String(draft.model ?? '').trim() || null,
        tools: commaList(draft.tools),
        permissions: commaList(draft.permissions),
        memoryScope: 'global',
        workspaceScope: 'global',
      }
      if (!editable.name) throw new Error('全局助理名称不能为空')
      const assistants = listOf(profiles, 'profiles', 'items').filter(profile => profile?.role === 'assistant')
      if (assistants.length > 1) throw new Error('检测到多个助理档案，请先修正档案存储')
      const assistant = assistants[0] ?? null
      if (!assistant) return { action: 'create', profile: { id: GLOBAL_ASSISTANT_ID, role: 'assistant', ...editable } }
      if (assistant.id !== GLOBAL_ASSISTANT_ID) throw new Error('全局助理必须使用保留 ID global-assistant')
      const expectedRevision = draft.expectedRevision ?? assistant.revision
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('全局助理缺少有效的修订号')
      return { action: 'update', id: GLOBAL_ASSISTANT_ID, expectedRevision, patch: editable }
    }

    function candidatePlanBlocked(preview) {
      return preview?.status === 'blocked' || preview?.canApprove === false || listOf(preview?.blocks).length > 0
    }

    function routerSupportsCandidatePlans(router) {
      return router?.planExecution === CANDIDATE_PLAN_ROUTER_VERSION
    }

    /**
     * Build the future Router handoff only from a server-approved credential.
     * The current Router does not advertise this contract, so callers must gate
     * the request on routerSupportsCandidatePlans rather than dropping these
     * fields into an ordinary chat submission.
     */
    function candidatePlanRouterSubmission(preview, approval, requestId) {
      if (preview?.kind !== 'candidate-plan-preview' || candidatePlanBlocked(preview)) {
        throw new Error('阻塞计划或非候选计划不能运行')
      }
      const input = preview.inputSnapshot
      if (!input || typeof input !== 'object' || !Array.isArray(input.subtasks) || !input.subtasks.length
        || input.goal == null || input.project == null || !input.permissionScope || !input.runtime) {
        throw new Error('候选预览缺少执行输入，不能绑定运行')
      }
      const digest = preview.planDigest
      if (typeof digest !== 'string' || !digest || approval?.kind !== 'plan-approval-credential'
        || approval?.state !== 'approved' || approval?.planDigest !== digest || approval?.executionStarted !== false) {
        throw new Error('批准凭据与候选计划摘要不匹配')
      }
      if (!requestId) throw new Error('运行提交缺少请求 ID')
      return {
        id: requestId,
        text: typeof input.goal === 'string' ? input.goal : JSON.stringify(input.goal),
        project: typeof input.project === 'string' ? input.project : null,
        target: null,
        intent: 'task',
        planApproval: approval,
        candidatePlan: input,
      }
    }

    function latestRun(model) {
      const listed = [...(model.workbench?.runs ?? []), ...(model.runs ?? [])]
      const unique = new Map(listed.filter(run => run?.id).map(run => [run.id, run]))
      return [...unique.values()].sort((left, right) =>
        timeValue(right.finishedAt, right.startedAt, right.createdAt, right.updatedAt)
        - timeValue(left.finishedAt, left.startedAt, left.createdAt, left.updatedAt))[0] ?? null
    }

    function planFromRun(model, run) {
      const subtasks = listOf(run?.subtasks).map((task, index) => {
        const usage = task.usage ?? {}
        return {
          id: String(task.id ?? task.childId ?? task.key ?? task.index ?? index),
          title: task.title ?? task.goal ?? `工作线 ${index + 1}`,
          ...(task.description ? { description: task.description } : {}),
          ...(task.model ? { model: task.model } : {}),
          ...(Array.isArray(task.dependsOn) ? { dependsOn: task.dependsOn } : {}),
          ...(Array.isArray(task.capabilities) ? { capabilities: task.capabilities } : {}),
          ...(Array.isArray(task.operations) ? { operations: task.operations } : {}),
          inputTokens: task.inputTokens ?? task.estimatedInputTokens ?? usage.inputTokens ?? usage.promptTokens ?? 0,
          outputTokens: task.outputTokens ?? task.estimatedOutputTokens ?? usage.outputTokens ?? usage.completionTokens ?? 0,
          ...(task.cacheReadTokens ?? usage.cacheReadTokens
            ? { cacheReadTokens: task.cacheReadTokens ?? usage.cacheReadTokens } : {}),
        }
      })
      const capabilities = [...new Set([
        ...listOf(run?.capabilities),
        ...subtasks.flatMap(task => listOf(task.capabilities)),
        ...subtasks.filter(task => task.model).map(task => `model.${task.model}`),
      ].filter(Boolean))]
      const workspace = taskWorkspace(model, run).cwd
      return {
        goal: {
          id: run.goalId ?? run.id,
          title: run.title ?? run.goal ?? '任务计划',
          description: String(run.output ?? run.report ?? '').slice(0, 4000),
        },
        plan: { subtasks },
        capabilities,
        ...(workspace ? { workspace } : {}),
      }
    }

    function formatMicros(value, currency = '') {
      if (!Number.isSafeInteger(value) || value < 0) return '未定价'
      const amount = value / 1_000_000
      return `${currency ? `${currency} ` : ''}${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}`
    }

    function artifactIdOf(item = {}) {
      const href = String(item.href ?? item.path ?? '')
      return item.id ?? item.artifactId ?? (item.runId ? `${item.runId}:${href}` : href)
    }

    const AUTOMATION_EVENTS = ['started', 'completed', 'failed', 'cancelled', 'budget']
    const EMPTY_AUTOMATION_DRAFT = Object.freeze({
      name: '', description: '', triggerType: 'cron', cron: '0 9 * * *', timeZone: 'UTC',
      everyMs: '300000', source: '', eventTypes: '', prompt: '', relativePath: 'artifacts/automation.md',
      events: ['completed', 'failed'], maxRuns: '', maxModelCalls: '', maxTokens: '', maxCost: '',
    })

    function integerOrNull(value) {
      if (value === '' || value === null || value === undefined) return null
      const number = Number(value)
      // Preserve invalid numeric input for server-side validation instead of
      // silently turning a malformed budget into an unlimited one.
      return Number.isFinite(number) ? number : String(value)
    }

    function automationDraftFromRule(rule) {
      if (!rule) return { ...EMPTY_AUTOMATION_DRAFT, events: [...EMPTY_AUTOMATION_DRAFT.events] }
      const trigger = rule.trigger ?? {}
      return {
        ...EMPTY_AUTOMATION_DRAFT,
        name: rule.name ?? '', description: rule.description ?? '', triggerType: trigger.type ?? 'cron',
        cron: trigger.cron ?? EMPTY_AUTOMATION_DRAFT.cron, timeZone: trigger.timeZone ?? 'UTC',
        everyMs: String(trigger.everyMs ?? EMPTY_AUTOMATION_DRAFT.everyMs), source: trigger.source ?? '',
        eventTypes: (trigger.eventTypes ?? []).join(', '), prompt: rule.action?.prompt ?? '',
        relativePath: rule.output?.relativePath ?? EMPTY_AUTOMATION_DRAFT.relativePath,
        events: [...(rule.notify?.events ?? EMPTY_AUTOMATION_DRAFT.events)],
        maxRuns: rule.budget?.maxRuns == null ? '' : String(rule.budget.maxRuns),
        maxModelCalls: rule.budget?.maxModelCalls == null ? '' : String(rule.budget.maxModelCalls),
        maxTokens: rule.budget?.maxTokens == null ? '' : String(rule.budget.maxTokens),
        maxCost: rule.budget?.maxCost == null ? '' : String(rule.budget.maxCost),
      }
    }

    /** Convert only the fields owned by this form; the server remains authoritative. */
    function automationRuleFromDraft(draft = EMPTY_AUTOMATION_DRAFT) {
      const trigger = draft.triggerType === 'every'
        ? { type: 'every', everyMs: integerOrNull(draft.everyMs) }
        : draft.triggerType === 'source'
          ? { type: 'source', source: String(draft.source ?? '').trim(),
            ...(String(draft.eventTypes ?? '').trim()
              ? { eventTypes: String(draft.eventTypes).split(',').map(value => value.trim()).filter(Boolean) } : {}) }
          : { type: 'cron', cron: String(draft.cron ?? '').trim(), timeZone: String(draft.timeZone ?? '').trim() || 'UTC' }
      return {
        name: String(draft.name ?? '').trim(), description: String(draft.description ?? '').trim(),
        trigger, action: { type: 'run', prompt: String(draft.prompt ?? '').trim() },
        output: { relativePath: String(draft.relativePath ?? '').trim() },
        notify: { events: [...(draft.events ?? [])] },
        budget: {
          maxRuns: integerOrNull(draft.maxRuns), maxModelCalls: integerOrNull(draft.maxModelCalls),
          maxTokens: integerOrNull(draft.maxTokens), maxCost: integerOrNull(draft.maxCost),
        },
      }
    }

    function automationTriggerLabel(rule) {
      const trigger = rule?.trigger ?? {}
      if (trigger.type === 'every') return `每 ${Math.max(1, Math.round((trigger.everyMs ?? 0) / 60000))} 分钟`
      if (trigger.type === 'source') return `来源 ${trigger.source ?? '—'}${trigger.eventTypes?.length ? `：${trigger.eventTypes.join('、')}` : ''}`
      return `${trigger.cron ?? '—'} (${trigger.timeZone ?? 'UTC'})`
    }

    function availableArtifacts(model) {
      const candidates = [
        ...(model.artifacts ?? []), ...overviewArtifacts(model),
        ...(model.workbench?.runs ?? []).flatMap(run => run.artifacts ?? []),
        ...(model.detail?.artifacts ?? []), ...(model.preview?.item ? [model.preview.item] : []),
      ]
      const unique = new Map()
      for (const item of candidates) {
        if (!item || typeof item !== 'object') continue
        const id = String(item.id ?? item.artifactId ?? '')
        if (/^art_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(id)) {
          unique.set(id, { ...item, shareId: id })
        }
      }
      return [...unique.values()]
    }

    function shareUrlOf(result) {
      if (result?.url) return result.url
      const token = result?.token ?? result?.share?.token
      return token ? `${API.replace(/\/console$/, '')}/share/${encodeURIComponent(token)}` : ''
    }

    function marketInstallCommand(result) {
      const handoff = result?.handoff ?? result ?? {}
      const item = handoff.package ?? {}
      if (!item.name) return ''
      const registry = handoff.registry ? ` --registry ${shellQuote(handoff.registry)}` : ''
      // A display-only handoff. Scripts stay disabled; this string is never run
      // by the browser and the host must review it before using another tool.
      return `npm install --ignore-scripts${registry} '${`${item.name}@${item.version}`.replaceAll("'", "'\\''")}'`
    }

    function shellQuote(value) {
      const text = String(value)
      return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
    }

    function cloudWorkSpecFromDraft(model, draft = {}) {
      const runId = String(draft.runId ?? '').trim()
      const subtaskId = String(draft.subtaskId ?? '').trim()
      const attempt = Number(draft.attempt)
      const project = model.project?.cwd ?? taskWorkspace(model, { id: runId }).cwd ?? ''
      const requestedDeadline = draft.deadline ? new Date(draft.deadline) : new Date(Date.now() + Math.max(1, Number(draft.maxWallSeconds) || 900) * 1000)
      const deadline = Number.isFinite(requestedDeadline.getTime()) ? requestedDeadline.toISOString() : String(draft.deadline)
      const budget = {}
      for (const [field, key] of [['maxTokens', 'maxTokens'], ['maxCostUsd', 'maxCostUsd'],
        ['maxWallSeconds', 'maxWallSeconds'], ['maxToolCalls', 'maxToolCalls']]) {
        const value = draft[field]
        if (value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))) budget[key] = Number(value)
      }
      return {
        run: { id: runId }, subtask: { id: subtaskId }, attempt,
        repoSnapshot: { provider: 'local', ref: String(draft.repoSnapshot ?? project).trim() },
        prompt: String(draft.prompt ?? '').trim(),
        model: { provider: String(draft.modelProvider ?? model.more?.cloudWorker?.provider ?? 'host').trim(),
          ref: String(draft.modelRef ?? model.more?.cloudWorker?.model ?? 'default').trim() },
        toolScope: { allow: String(draft.toolAllow ?? '').split(',').map(value => value.trim()).filter(Boolean) },
        approvalScope: { mode: draft.approvalMode ?? 'manual' },
        budget, deadline,
        checkpoint: { ref: String(draft.checkpointRef ?? `checkpoint:${runId}:${subtaskId}:${attempt}`).trim() },
      }
    }

    function cloudDraftFromModel(model) {
      const run = model.detail?.id ? model.detail : latestRun(model)
      const deadline = new Date(Date.now() + 900000)
      const local = new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      return {
        runId: run?.id ?? '', subtaskId: run ? `${run.id}:cloud` : '', attempt: '1',
        repoSnapshot: model.project?.cwd ?? taskWorkspace(model, run ?? {}).cwd ?? '',
        prompt: run?.goal ?? run?.title ?? '', modelProvider: model.more?.cloudWorker?.provider ?? 'host',
        modelRef: model.more?.cloudWorker?.model ?? run?.model ?? 'default', toolAllow: '',
        approvalMode: 'manual', maxTokens: '', maxCostUsd: '', maxWallSeconds: '900', maxToolCalls: '',
        deadline: local, checkpointRef: '', idempotencyKey: '',
      }
    }

    function idempotencyKey(prefix) {
      return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`}`
    }

    function voiceErrorMessage(error) {
      const code = typeof error?.code === 'string' ? error.code : error?.name
      if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'permission-denied'].includes(code)) {
        return '麦克风权限被拒绝，请在浏览器设置中允许后重试。'
      }
      if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError', 'no-device'].includes(code)) {
        return '未检测到可用的麦克风设备。'
      }
      if (['NotReadableError', 'AbortError', 'TrackStartError', 'device-busy'].includes(code)) {
        return '麦克风正被其它应用占用，请稍后重试。'
      }
      if (code === 'unavailable' || error?.status === 503 || /unavailable|remote\.speech/i.test(error?.message ?? '')) {
        return '语音转写服务暂不可用，请稍后重试。'
      }
      if (code === 'empty-recording') return '没有录到音频，请靠近麦克风后重试。'
      if (code === 'audio-too-long') return '录音超过 120 秒，已停止，请分段重试。'
      if (code === 'audio-too-large') return '录音文件过大，请缩短录音后重试。'
      if (['decode-failed', 'decode-unavailable', 'invalid-audio'].includes(code)) return '浏览器无法解码这段录音，请重试。'
      return error?.message ? `语音输入失败：${error.message}` : '语音输入失败，请重试。'
    }

    function releaseVoiceStream(stream) {
      const tracks = typeof stream?.getTracks === 'function' ? stream.getTracks()
        : typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks() : []
      for (const track of Array.isArray(tracks) ? tracks : []) {
        try { track?.stop?.() } catch { /* release every remaining track */ }
      }
    }

    /** Mix/resample decoded browser audio to the console's 16kHz mono PCM16 WAV. */
    function audioBufferToWav(audio) {
      if (!audio || !Number.isSafeInteger(audio.sampleRate) || audio.sampleRate <= 0
        || !Number.isSafeInteger(audio.length) || audio.length <= 0
        || !Number.isSafeInteger(audio.numberOfChannels) || audio.numberOfChannels <= 0
        || typeof audio.getChannelData !== 'function') {
        throw Object.assign(new Error('录音解码结果为空'), { code: 'invalid-audio' })
      }
      const durationMs = audio.length * 1000 / audio.sampleRate
      if (durationMs > 120_000) throw Object.assign(new Error('录音超过 120 秒'), { code: 'audio-too-long' })
      const count = Math.ceil(audio.length * 16_000 / audio.sampleRate)
      if (count <= 0 || 44 + count * 2 > 10 * 1024 * 1024) {
        throw Object.assign(new Error('录音文件过大'), { code: 'audio-too-large' })
      }
      const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => {
        const data = audio.getChannelData(channel)
        if (!data || data.length < audio.length) throw Object.assign(new Error('录音数据不完整'), { code: 'invalid-audio' })
        return data
      })
      const pcm = new Int16Array(count)
      const ratio = audio.sampleRate / 16_000
      for (let index = 0; index < count; index += 1) {
        const position = index * ratio
        const left = Math.min(Math.floor(position), audio.length - 1)
        const right = Math.min(left + 1, audio.length - 1)
        const fraction = position - left
        let sample = 0
        for (const channel of channels) {
          const from = Number.isFinite(channel[left]) ? channel[left] : 0
          const to = fraction === 0 ? from : Number.isFinite(channel[right]) ? channel[right] : from
          sample += from + (to - from) * fraction
        }
        sample = Math.max(-1, Math.min(1, sample / channels.length))
        pcm[index] = Math.round(sample < 0 ? sample * 32768 : sample * 32767)
      }
      const bytes = new Uint8Array(44 + pcm.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (offset, value) => {
        for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
      }
      text(0, 'RIFF')
      view.setUint32(4, 36 + pcm.length * 2, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16_000, true)
      view.setUint32(28, 32_000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, pcm.length * 2, true)
      for (let index = 0; index < pcm.length; index += 1) view.setInt16(44 + index * 2, pcm[index], true)
      return bytes
    }

    function bytesToBase64(bytes) {
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      return globalThis.btoa(binary)
    }

    async function recordedBlobToWav(blob) {
      const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext
      if (typeof AudioContext !== 'function') {
        throw Object.assign(new Error('浏览器不支持 AudioContext'), { code: 'decode-unavailable' })
      }
      const context = new AudioContext()
      try {
        return audioBufferToWav(await context.decodeAudioData(await blob.arrayBuffer()))
      } catch (error) {
        if (error?.name === 'EncodingError') error.code = 'decode-failed'
        throw error
      } finally {
        try { await context.close?.() } catch { /* decoded samples no longer need the context */ }
      }
    }

    /** Push-to-talk lifecycle; a cancelled or superseded request can never insert text. */
    function createVoiceRecorder({ onState, onTranscript, onError }) {
      const browser = globalThis.window ?? globalThis
      const navigator = browser.navigator ?? globalThis.navigator
      const document = browser.document ?? globalThis.document
      const Recorder = browser.MediaRecorder ?? globalThis.MediaRecorder
      let phase = 'idle'
      let active = null
      let generation = 0
      let starting = null
      let timer = null
      let disposed = false
      const cleanups = []
      const setPhase = next => {
        if (phase === next) return
        phase = next
        onState?.(next)
      }
      const clearTimer = () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
      }
      const current = session => !disposed && active === session && session.id === generation
      const release = session => {
        releaseVoiceStream(session.stream)
        session.stream = null
      }
      const fail = (session, error) => {
        clearTimer()
        if (session) {
          session.failure = error
          session.rejectStop?.(error)
          release(session)
          if (session.recorder?.state === 'recording') {
            try { session.recorder.stop() } catch { /* preserve the original failure */ }
          }
        }
        if (!session || current(session)) {
          active = null
          setPhase('idle')
        }
        onError?.(error)
        return error
      }
      const cancel = () => {
        if (disposed) return
        generation += 1
        clearTimer()
        const session = active
        active = null
        if (session) {
          session.resolveStop?.(null)
          release(session)
          if (session.recorder?.state === 'recording') {
            try { session.recorder.stop() } catch { /* cancellation still releases the track */ }
          }
        }
        setPhase('idle')
      }
      const listen = (target, type, handler) => {
        if (typeof target?.addEventListener === 'function') {
          target.addEventListener(type, handler)
          return () => target.removeEventListener?.(type, handler)
        }
        const property = `on${type}`
        const previous = target?.[property]
        if (target) target[property] = handler
        return () => { if (target) target[property] = previous }
      }
      const start = () => {
        if (disposed) return Promise.reject(Object.assign(new Error('语音输入已关闭'), { code: 'disposed' }))
        if (starting) return starting
        if (phase !== 'idle') return Promise.reject(Object.assign(new Error('语音输入正在进行'), { code: 'recording-active' }))
        if (typeof navigator?.mediaDevices?.getUserMedia !== 'function' || typeof Recorder !== 'function') {
          const error = Object.assign(new Error('浏览器不支持录音'), { code: 'recording-unavailable' })
          onError?.(error)
          return Promise.reject(error)
        }
        const id = ++generation
        setPhase('requesting')
        const operation = (async () => {
          let stream
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            })
          } catch (error) {
            if (!disposed && id === generation) fail(null, error)
            return
          }
          if (disposed || id !== generation) {
            releaseVoiceStream(stream)
            return
          }
          const tracks = typeof stream?.getTracks === 'function' ? stream.getTracks() : stream?.getAudioTracks?.() ?? []
          if (!Array.isArray(tracks) || !tracks.length || tracks.every(track => track?.readyState === 'ended')) {
            releaseVoiceStream(stream)
            fail(null, Object.assign(new Error('没有可用的麦克风'), { code: 'no-device' }))
            return
          }
          const session = { id, stream, recorder: null, chunks: [], bytes: 0, mimeType: '', resolveStop: null, rejectStop: null }
          active = session
          try {
            const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
              .find(type => typeof Recorder.isTypeSupported === 'function' && Recorder.isTypeSupported(type)) ?? ''
            session.mimeType = mime
            const recorder = mime ? new Recorder(stream, { mimeType: mime }) : new Recorder(stream)
            session.recorder = recorder
            cleanups.push(listen(recorder, 'dataavailable', event => {
              if (!current(session) || !event?.data?.size) return
              session.bytes += event.data.size
              if (session.bytes > 10 * 1024 * 1024) {
                fail(session, Object.assign(new Error('录音文件过大'), { code: 'audio-too-large' }))
                return
              }
              session.chunks.push(event.data)
            }))
            cleanups.push(listen(recorder, 'stop', () => { if (current(session)) session.resolveStop?.(null) }))
            cleanups.push(listen(recorder, 'error', event => {
              if (current(session)) fail(session, event?.error ?? new Error('录音失败'))
            }))
            recorder.start(250)
          } catch (error) {
            fail(session, error)
            return
          }
          setPhase('recording')
          timer = setTimeout(() => { stop().catch(error => { if (current(active)) fail(active, error) }) }, 120_000)
        })()
        starting = operation
        return operation.finally(() => { if (starting === operation) starting = null })
      }
      const stop = () => {
        if (disposed || phase === 'idle') return Promise.resolve(null)
        if (phase === 'requesting') { cancel(); return Promise.resolve(null) }
        const session = active
        if (!session?.recorder) return Promise.resolve(null)
        if (session.stopping) return session.stopping
        clearTimer()
        setPhase('transcribing')
        session.stopping = (async () => {
          try {
            await new Promise((resolve, reject) => {
              session.resolveStop = resolve
              session.rejectStop = reject
              try { session.recorder.stop() } catch (error) { reject(error); return }
              release(session)
            })
            if (!current(session)) return null
            if (session.failure) throw session.failure
            if (!session.chunks.length) throw Object.assign(new Error('没有录到音频'), { code: 'empty-recording' })
            const blob = new Blob(session.chunks, { type: session.mimeType || 'audio/webm' })
            const wav = await recordedBlobToWav(blob)
            if (!current(session)) return null
            const result = await call('/voice/transcribe', {
              method: 'POST', body: JSON.stringify({ audio: bytesToBase64(wav), options: {} }),
            })
            if (!current(session)) return null
            const text = typeof result === 'string' ? result : result?.text ?? result?.transcript
            if (typeof text !== 'string' || !text.trim()) throw new Error('转写服务没有返回可编辑文本')
            active = null
            setPhase('idle')
            onTranscript?.(text.trim())
            return text.trim()
          } catch (error) {
            if (!current(session)) return null
            throw fail(session, error)
          }
        })()
        return session.stopping
      }
      const onVisibility = () => { if (document?.hidden) cancel() }
      if (typeof document?.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibility)
        cleanups.push(() => document.removeEventListener?.('visibilitychange', onVisibility))
      }
      for (const type of ['pagehide', 'beforeunload']) {
        if (typeof browser?.addEventListener === 'function') {
          browser.addEventListener(type, cancel)
          cleanups.push(() => browser.removeEventListener?.(type, cancel))
        }
      }
      return {
        start, stop, cancel,
        get state() { return phase },
        dispose() { cancel(); disposed = true; for (const cleanup of cleanups.splice(0)) cleanup() },
      }
    }

    /** Blank model for one panel mount. */
    function initialModel() {
      return {
        phase: 'loading',
        reason: '',
        hint: '',
        sessionId: null,
        capabilities: null,
        messages: [],
        approvals: [],
        runs: [],
        goals: [],
        workbench: null,
        inboxOpen: false,
        artifacts: [],
        artifactsLoading: false,
        artifactsError: '',
        artifactsQuery: { q: '', kind: '', project: '', from: '', to: '' },
        automation: null,
        automationLoading: false,
        automationError: '',
        more: initialMore(),
        selectedGoalId: null,
        workerSession: null,
        reply: null,
        goalBusy: false,
        toast: null,
        canceling: false,
        approvalBusy: {},
        typing: false,
        sending: false,
        currentId: null,
        routerRevision: -1,
        contextFacts: [],
        sourceBindings: [],
        sourceState: null,
        project: null,
        focusedBench: null,
        detail: null,
        detailBusy: false,
        preview: null,
        previewText: '',
        previewError: '',
        previewBusy: false,
        uploadInsert: '',
        uploading: false,
      }
    }

    /** Replace one message in place and keep every other row identical. */
    function patchMessage(messages, id, patch) {
      return messages.map(message => (message.id === id ? { ...message, ...patch } : message))
    }

    /** Drop one key from a busy-map without touching the rest. */
    function omitKey(map, key) {
      const next = { ...(map ?? {}) }
      delete next[key]
      return next
    }

    /** Add or update a tool chip on the streaming assistant message. */
    function upsertTool(messages, id, tool) {
      return messages.map(message => {
        if (message.id !== id) return message
        const tools = Array.isArray(message.tools) ? message.tools.slice() : []
        const index = tools.findIndex(entry => entry.callId === tool.callId)
        if (index >= 0) tools[index] = { ...tools[index], ...tool }
        else tools.push(tool)
        return { ...message, tools }
      })
    }

    /** The streaming assistant row, created on first use. */
    function assistantRow(model, at) {
      if (model.currentId && model.messages.some(message => message.id === model.currentId)) {
        return { model, id: model.currentId }
      }
      localSeq += 1
      const id = `assistant-local-${localSeq}`
      const row = { id, role: 'assistant', text: '', reasoning: '', tools: [], at: at ?? Date.now(), streaming: true }
      return { model: { ...model, messages: [...model.messages, row], currentId: id }, id }
    }

    /**
     * Fold one session event into the model, mirroring what the console page
     * does with the same frames.
     */
    function applySessionEvent(model, event) {
      if (!event || typeof event !== 'object') return model
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      switch (event.type) {
        case 'turn/start':
        case 'step/start':
          return { ...model, typing: true }
        case 'turn/end': {
          let next = { ...model, typing: false, canceling: false }
          if (next.messages.some(message => message.pending)) {
            next = {
              ...next,
              messages: next.messages.map(message => message.pending ? { ...message, pending: false, accepted: true } : message),
            }
          }
          if (next.currentId) {
            next = { ...next, messages: patchMessage(next.messages, next.currentId, { streaming: false }), currentId: null }
          }
          return next
        }
        case 'user/message': {
          if (data.source && data.source.kind && data.source.kind !== 'user') return model
          const text = contentText(data.content).trim()
          if (!text) return model
          const pendingIndex = model.messages.findIndex(message => message.role === 'user' && message.pending && message.text.trim() === text)
          if (pendingIndex >= 0) {
            const messages = model.messages.slice()
            messages[pendingIndex] = { ...messages[pendingIndex], pending: false, accepted: true, at: event.time ?? messages[pendingIndex].at }
            return { ...model, messages, typing: true }
          }
          // The accepted frame and the host event can race; if this exact user
          // turn was already settled moments ago, fold instead of duplicating.
          const tail = model.messages[model.messages.length - 1]
          if (tail && tail.role === 'user' && tail.text.trim() === text && Math.abs((event.time ?? Date.now()) - tail.at) < 5000) {
            return { ...model, typing: true }
          }
          localSeq += 1
          const row = { id: `user-${localSeq}`, role: 'user', text, at: event.time ?? Date.now() }
          return { ...model, messages: [...model.messages, row], typing: true }
        }
        case 'assistant/message': {
          const finalText = contentText(data.message?.content)
          const reasoning = contentText((data.message?.content ?? []).filter(part => part && part.type === 'reasoning'))
          let next = model
          const created = assistantRow(next, event.time)
          next = created.model
          const id = created.id
          const patch = { streaming: false }
          if (finalText) patch.text = finalText
          if (reasoning) patch.reasoning = reasoning
          if (data.interrupted === true) patch.interrupted = true
          next = { ...next, messages: patchMessage(next.messages, id, patch), currentId: null }
          const calls = Array.isArray(data.message?.content)
            ? data.message.content.filter(part => part && part.type === 'tool-call')
            : []
          for (const entry of calls) {
            next = { ...next, messages: upsertTool(next.messages, id, {
              callId: entry.id ?? entry.callId,
              name: entry.name ?? 'tool',
              status: 'ok',
              arguments: entry.arguments,
            }) }
          }
          return next
        }
        case 'tool/call': {
          const created = assistantRow(model, event.time)
          const next = { ...created.model, typing: true }
          return { ...next, messages: upsertTool(next.messages, created.id, {
            callId: data.callId,
            name: data.name ?? 'tool',
            status: 'running',
            arguments: data.arguments,
          }) }
        }
        case 'tool/result': {
          const callId = data.callId ?? data.message?.toolCallId ?? data.message?.source?.callId
          if (!callId) return model
          return {
            ...model,
            messages: model.messages.map(message => {
              if (!Array.isArray(message.tools) || !message.tools.some(tool => tool.callId === callId)) return message
              return {
                ...message,
                tools: message.tools.map(tool => (tool.callId === callId
                  ? { ...tool, status: data.message?.isError ? 'err' : 'ok' }
                  : tool)),
              }
            }),
          }
        }
        default:
          return model
      }
    }

    /** Fold one assistant streaming frame into the model. */
    function applyAssistantFrame(model, frame) {
      if (!frame || typeof frame !== 'object') return model
      if (frame.type === 'start') {
        const created = assistantRow(model, Date.now())
        return { ...created.model, typing: true }
      }
      if (frame.type === 'chunk' && frame.chunk) {
        const created = assistantRow(model, Date.now())
        const id = created.id
        const current = created.model.messages.find(message => message.id === id) ?? {}
        if (frame.chunk.type === 'text-delta' && typeof frame.chunk.text === 'string') {
          return { ...created.model, messages: patchMessage(created.model.messages, id, { text: `${current.text ?? ''}${frame.chunk.text}` }) }
        }
        if (frame.chunk.type === 'reasoning-delta' && typeof frame.chunk.text === 'string') {
          return { ...created.model, messages: patchMessage(created.model.messages, id, { reasoning: `${current.reasoning ?? ''}${frame.chunk.text}` }) }
        }
        return created.model
      }
      if (frame.type === 'end' && model.currentId) {
        return {
          ...model,
          messages: patchMessage(model.messages, model.currentId, { streaming: false }),
          currentId: null,
          typing: false,
        }
      }
      return model
    }

    /** Fold one console frame into the model. */
    function applyFrame(model, frame) {
      if (!frame || typeof frame !== 'object') return model
      switch (frame.type) {
        case 'hello':
          return { ...model, sessionId: frame.sessionId ?? model.sessionId, capabilities: frame.capabilities ?? model.capabilities }
        case 'session':
          if (!frame.sessionId || frame.sessionId === model.sessionId) return model
          return {
            ...model,
            sessionId: frame.sessionId,
            messages: [],
            approvals: [],
            runs: [],
            goals: [],
            workbench: null,
            inboxOpen: false,
            artifacts: [],
            artifactsError: '',
            automation: null,
            automationError: '',
            more: initialMore(),
            selectedGoalId: null,
            workerSession: null,
            reply: null,
            approvalBusy: {},
            currentId: null,
            typing: false,
            canceling: false,
            detail: null,
            preview: null,
            previewText: '',
            previewBusy: false,
          }
        case 'stream.snapshot': {
          let next = { ...model, messages: [], currentId: null }
          if (frame.header?.id) next.sessionId = frame.header.id
          for (const record of Array.isArray(frame.records) ? frame.records : []) {
            if (record?.type === 'event' && record.event) next = applySessionEvent(next, record.event)
          }
          return next
        }
        case 'session.event':
          return applySessionEvent(model, frame.event)
        case 'assistant.frame':
          return applyAssistantFrame(model, frame.frame)
        case 'accepted': {
          // Do not settle the pending row here: the host still emits the
          // authoritative user/message event, and settling early makes that
          // event append a second copy. Just mark it confirmed.
          const index = model.messages.findIndex(message => message.role === 'user' && message.pending && message.text.trim() === String(frame.text ?? '').trim())
          if (index < 0) return model
          return { ...model, messages: patchMessage(model.messages, model.messages[index].id, { accepted: true }) }
        }
        case 'approval': {
          const approval = frame.approval
          if (frame.action === 'asked' && approval?.id) {
            const others = model.approvals.filter(entry => entry.id !== approval.id)
            return { ...model, approvals: [...others, approval] }
          }
          if (frame.action === 'expired' && frame.id) {
            // The card must not vanish silently: the tool call it guarded is
            // already cancelled, and the user should know why.
            return {
              ...model,
              approvals: model.approvals.filter(entry => entry.id !== frame.id),
              toast: { kind: 'err', text: '这个审批已超时，工具调用已取消' },
            }
          }
          if (frame.id) {
            return { ...model, approvals: model.approvals.filter(entry => entry.id !== frame.id) }
          }
          return model
        }
        case 'runs': {
          if (frame.sessionId && model.sessionId && frame.sessionId !== model.sessionId) return model
          const runs = Array.isArray(frame.runs) ? frame.runs : []
          const goals = Array.isArray(frame.goals) ? frame.goals : []
          const update = model.detail ? runs.find(run => run.id === model.detail.id) : null
          const sameReport = update?.reportTruncated && model.detail?.report?.startsWith(update.report)
          const detail = update ? { ...update, report: sameReport ? model.detail.report : update.report } : model.detail
          return { ...model, runs, goals, detail }
        }
        default:
          return model
      }
    }

    function IconButton({ icon, label, onClick, ...props }) {
      const fallback = { plus: '+', clock: '◷', close: '×', back: '←' }
      return h('button', {
        ...props, type: 'button', className: 'dsa-iconbtn', title: label, 'aria-label': label, onClick,
      }, isComponent(ICONS[icon]) ? h(Icon, { of: icon, size: 16 })
        : h('span', { 'aria-hidden': true }, fallback[icon]))
    }

    function Header({ view, onTasks, onInbox, inboxCount }) {
      const panelButton = (id, icon, label, action, count) => h('button', {
        type: 'button', className: 'dsa-header-action', 'aria-expanded': view === id,
        'aria-controls': view === id ? 'dsa-workbench' : undefined,
        'aria-label': count ? `${label} ${count} 项` : label, onClick: action,
      }, h(Icon, { of: icon, size: 16 }), label, count ? h('span', { className: 'dsa-count', 'aria-hidden': true }, count) : null)
      return h('header', { className: 'dsa-header' },
        h('div', { className: 'dsa-header-title' }, h(EntryIcon, { size: 16 }), PANEL_LABEL),
        h('div', { className: 'dsa-header-actions' },
          panelButton('tasks', 'panel', '任务', onTasks),
          panelButton('inbox', 'checklist', '待办', onInbox, inboxCount)))
    }

    function UserMessage(props) {
      const pending = props.message.pending === true
      return h('div', { className: 'dsa-user', style: pending ? { opacity: 0.6 } : undefined },
        UserMessageBubble
          ? h(UserMessageBubble, { className: pending ? 'dsa-bubble-pending' : undefined }, props.message.text)
          : h('div', { className: 'dsa-bubble', 'data-pending': pending ? 'true' : 'false' }, props.message.text))
    }

    /** One host process row (reasoning or tool call) with its own disclosure. */
    function ProcessRow(props) {
      const [open, setOpen] = react.useState(false)
      const toggle = react.useCallback(() => setOpen(value => !value), [])
      const body = props.body
      const row = DisclosureRow
        ? h(DisclosureRow, {
          icon: h(Icon, { of: props.icon, size: 16 }),
          title: props.title,
          open,
          expandable: Boolean(body),
          expandOnRowClick: true,
          onToggle: toggle,
          running: props.running === true,
        }, body)
        : h('div', { className: 'dsa-proc' },
          h('button', {
            type: 'button', className: 'dsa-rowitem', 'aria-expanded': open, disabled: !body,
            onClick: toggle,
          }, h(Icon, { of: props.icon, size: 16 }), h('span', { className: 'dsa-rowtitle' }, props.title)),
          open && body ? body : null)
      return row
    }

    const RECEIPT_LABELS = {
      registered: '已登记', delivered: '已送达', accepted: '已验收', 'action-required': '需要你决定',
    }

    function AssistantMessage(props) {
      const message = props.message
      const tools = Array.isArray(message.tools) ? message.tools : []
      const children = []
      if (message.reasoning) {
        children.push(h(ProcessRow, {
          key: 'reasoning',
          icon: 'think',
          title: '思考',
          running: message.streaming === true,
          body: h('div', { className: 'dsa-proc-body' }, message.reasoning),
        }))
      }
      if (tools.length > 0) {
        children.push(h('div', { key: 'tools', className: 'dsa-proc' }, tools.map(tool => {
          const args = typeof tool.arguments === 'string' && tool.arguments ? tool.arguments : ''
          const body = args
            ? (CodeBlock
              ? h('div', { className: 'dsa-proc-code' }, h(CodeBlock, {
                code: args,
                lang: 'json',
                copyLabel: '复制',
                copiedLabel: '已复制',
                toolbarLabels: { codeLabel: '参数', wrapLabel: '换行', unwrapLabel: '取消换行' },
                showHeader: false,
              }))
              : h('div', { className: 'dsa-proc-body' }, args))
            : null
          return h(ProcessRow, {
            key: tool.callId ?? tool.name,
            icon: tool.status === 'err' ? 'question' : 'code',
            title: tool.name,
            running: tool.status === 'running',
            body,
          })
        })))
      }
      if (message.text) {
        if (MarkdownText) {
          const node = h(MarkdownText, {
            text: message.text,
            streaming: message.streaming === true,
            labels: MARKDOWN_LABELS,
          })
          children.push(MarkdownBoundary
            ? h(MarkdownBoundary, { key: 'text', messageId: message.id, text: message.text }, node)
            : react.cloneElement(node, { key: 'text' }))
        } else {
          noteMarkdownFallback(message.id, 'host MarkdownText export is unavailable')
          children.push(h('div', { key: 'text', className: 'dsa-md-plain' }, message.text))
        }
      }
      if (message.interrupted) {
        children.push(Tag
          ? h(Tag, { key: 'interrupted', tone: 'neutral' }, '已中断')
          : h('div', { key: 'interrupted', className: 'dsa-hint' }, '已中断'))
      }
      // A receipt names where the message actually stands: registered with the
      // router, delivered to a run, accepted as a finished result, or waiting
      // on a person. The same id is reused after a restart, so the label never
      // flickers between states.
      const receipt = RECEIPT_LABELS[message.receipt]
      if (receipt) {
        children.push(Tag
          ? h(Tag, { key: 'receipt', tone: message.receipt === 'action-required' ? 'warning' : 'neutral' }, receipt)
          : h('div', { key: 'receipt', className: 'dsa-hint' }, receipt))
      }
      return h('div', { className: 'dsa-assistant' }, children)
    }

    function Transcript(props) {
      const tasks = new Map([...(props.model.workbench?.goals ?? []), ...(props.model.workbench?.runs ?? [])].map(task => [task.id, task]))
      const rows = props.model.messages.map(message => {
        const targets = message.role === 'assistant' ? message.taskIds ?? (message.taskId ? [message.taskId] : []) : []
        return h('div', { key: message.id, className: 'dsa-msg' },
          message.role === 'user'
            ? h(UserMessage, { message })
            : h(AssistantMessage, { message }),
          props.onTask ? targets.map(id => {
            const task = tasks.get(id)
            const phaseReceipt = Boolean(message.phaseId && message.runId)
            return h('button', {
              key: id, type: 'button', className: 'dsa-task-receipt',
              title: phaseReceipt ? `打开阶段 ${message.phaseId} 的执行证据` : task?.goal,
              onClick: () => message.choiceFor && props.onChoose ? props.onChoose(message.choiceFor, id)
                : phaseReceipt && props.onReceipt ? props.onReceipt(message) : props.onTask(id),
            }, h('span', { className: 'dsa-receipt-icon' }, h(Icon, { of: 'checklist', size: 17 })),
            h('span', { className: 'dsa-receipt-copy' },
              h('strong', null, phaseReceipt ? `查看阶段 ${message.phaseId} 证据` : task?.title || task?.goal || '查看任务'),
              task ? h(TaskStatus, { task }) : null),
            h(Icon, { of: 'right', size: 14 }))
          }) : null,
          props.onReply && message.text && !message.streaming && !message.pending ? h('button', {
            type: 'button', className: 'dsa-linkbtn dsa-reply', onClick: () => props.onReply?.(message),
            'aria-label': '回复这条消息', title: '回复这条消息',
          }, '↩ 回复') : null)
      })
      if (props.model.typing) {
        rows.push(h('div', { key: 'typing', className: 'dsa-typing' },
          StateDot ? h(StateDot, { state: 'ongoing', size: 10 }) : null,
          TextShimmer ? h(TextShimmer, { active: true }, '正在处理消息…') : '正在处理消息…'))
      }
      return h('div', {
        className: 'dsa-scroll',
        ref: props.scrollRef,
        role: 'log',
        'aria-live': 'polite',
        'aria-label': '对话',
      }, h('div', { className: 'dsa-flow' }, rows))
    }

    function Approvals(props) {
      if (!props.approvals.length) return null
      return h('div', { className: 'dsa-approvals' }, props.approvals.map(entry => {
        const busy = props.busy?.[entry.id] === true
        return h('div', {
          key: entry.id,
          className: 'dsa-approval',
          'aria-busy': busy ? 'true' : undefined,
        },
        h('div', { className: 'dsa-approval-bar' },
          StateDot ? h(StateDot, { state: 'warning', size: 10 }) : null,
          h('span', null, '等待你的批准')),
        h('div', { className: 'dsa-approval-main' },
          h('div', { className: 'dsa-approval-title' }, entry.toolName ?? '工具调用'),
          entry.callArguments || entry.reason
            ? h('div', { className: 'dsa-approval-body' }, entry.callArguments ?? entry.reason)
            : null,
          h('div', { className: 'dsa-approval-actions' },
            [['reject', '拒绝', 'outline'], ['allow', '允许一次', 'primary'], ['allow-tool', '本会话都放行', 'outline']]
              .filter(([decision]) => decision !== 'allow-tool' || entry.ownerSessionId === props.sessionId)
              .map(([decision, label, variant]) => (Button
                ? h(Button, {
                  key: decision,
                  variant,
                  size: 'sm',
                  disabled: busy,
                  onClick: () => props.onDecide(entry.id, decision),
                }, label)
                : h('button', {
                  key: decision,
                  type: 'button',
                  className: 'dsa-chip',
                  disabled: busy,
                  onClick: () => props.onDecide(entry.id, decision),
                }, label))))))
      }))
    }

    function Composer(props) {
      const { disabled, onSend } = props
      const [text, setText] = react.useState('')
      const [withContext, setWithContext] = react.useState(false)
      const [insertHint, setInsertHint] = react.useState('')
      const [dragging, setDragging] = react.useState(false)
      const [voiceState, setVoiceState] = react.useState('idle')
      const [voiceHint, setVoiceHint] = react.useState('')
      const areaRef = react.useRef(null)
      const fileRef = react.useRef(null)
      const voiceRef = react.useRef(null)
      const voicePointer = react.useRef(false)
      const dragDepth = react.useRef(0)
      const uploadChain = react.useRef(Promise.resolve())
      const pasteSeq = react.useRef(0)
      const scoped = props.model.reply?.taskId
      const sendLabel = '发送给全局助理'
      if (!voiceRef.current) {
        voiceRef.current = createVoiceRecorder({
          onState: setVoiceState,
          onTranscript: text => {
            setText(current => current ? `${current}${/\s$/.test(current) ? '' : ' '}${text}` : text)
            setVoiceHint('转写完成，可编辑后发送')
            areaRef.current?.focus?.()
          },
          onError: error => setVoiceHint(voiceErrorMessage(error)),
        })
      }

      react.useEffect(() => () => voiceRef.current?.dispose(), [])
      const voiceLabel = voiceState === 'idle' ? '语音输入'
        : voiceState === 'transcribing' ? '取消语音输入' : voiceState === 'requesting' ? '取消麦克风请求' : '停止录音'
      const beginVoice = () => {
        if (disabled) return
        setVoiceHint('')
        const voice = voiceRef.current
        if (!voice) return
        const operation = voice.state === 'idle' ? voice.start()
          : voice.state === 'requesting' || voice.state === 'transcribing' ? Promise.resolve(voice.cancel()) : null
        return operation?.catch(() => {})
      }
      const endVoice = () => {
        const voice = voiceRef.current
        if (voice?.state === 'recording') return voice.stop().catch(() => {})
      }

      react.useEffect(() => {
        if (props.model.reply) areaRef.current?.focus()
      }, [props.model.reply])

      // An uploaded file lands as a path the user can see and edit before sending.
      react.useEffect(() => {
        if (!props.insert) return
        setText(current => (current ? `${current}\n${props.insert}` : props.insert))
        props.onInserted?.()
      }, [props.insert])

      const pickFile = () => {
        const input = fileRef.current
        if (!input) return
        input.value = ''
        input.click()
      }

      const readUpload = (file, name) => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({
          name,
          data: String(reader.result ?? '').replace(/^data:[^,]*,/, ''),
        })
        reader.onerror = () => reject(new Error('文件读不出来'))
        reader.readAsDataURL(file)
      })

      const uploadFiles = files => {
        const list = Array.from(files || []).filter(Boolean)
        // A queued batch belongs to the workspace and callback that accepted
        // the drop, even if the person switches projects before it starts.
        const onUpload = props.onUpload
        const project = props.model.project?.cwd
        const uploadDisabled = disabled || props.uploading === true
        if (list.length === 0 || !onUpload || uploadDisabled) return uploadChain.current
        uploadChain.current = uploadChain.current.then(async () => {
          for (const file of list) {
            const mime = String(file.type || '')
            const mimeExt = {
              'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
              'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
            }[mime] ?? ''
            const name = file.name || `pasted-${mime.startsWith('image/') ? 'image' : 'file'}-${Date.now()}-${pasteSeq.current++}${mimeExt}`
            try {
              await onUpload(await readUpload(file, name), project)
            } catch (error) {
              await onUpload({ name, data: '', error: error?.message ?? '文件读不出来' }, project)
            }
          }
        })
        return uploadChain.current
      }

      const dragHasFiles = event => {
        const transfer = event.dataTransfer
        if (!transfer) return false
        return transfer.files?.length > 0 || Array.from(transfer.types || []).includes('Files')
      }

      const dragEnter = event => {
        if (!dragHasFiles(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        dragDepth.current += 1
        setDragging(true)
      }

      const dragOver = event => {
        if (!dragHasFiles(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }

      const dragLeave = () => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }

      const drop = event => {
        if (!dragHasFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current = 0
        setDragging(false)
        uploadFiles(event.dataTransfer?.files)
      }

      const paste = event => {
        const transfer = event.clipboardData
        const files = transfer?.files?.length
          ? transfer.files
          : Array.from(transfer?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean)
        if (!files.length) return
        event.preventDefault()
        uploadFiles(files)
      }

      const grow = () => {
        const area = areaRef.current
        if (!area) return
        area.style.height = 'auto'
        area.style.height = `${Math.min(area.scrollHeight, 336)}px`
      }

      // The task card hands its command template in here. The user still
      // presses send: a draft or an active quote/follow-up is never replaced.
      const insertCommand = command => {
        if (props.model.reply) {
          setInsertHint(`正在${scoped ? '补充这项任务的要求' : '引用一条消息'}，先点「${scoped ? '取消追加' : '取消引用'}」再插入记录命令`)
          return false
        }
        if (text.trim()) {
          setInsertHint('输入框里已有草稿，已原样保留；发送或清空后再插入记录命令')
          return false
        }
        setText(command)
        setInsertHint('')
        areaRef.current?.focus?.()
        return true
      }
      if (props.apiRef) props.apiRef.current = {
        insert: insertCommand,
        prefill: value => {
          setText(current => current.includes(value) ? current : current ? `${current}\n${value}` : value)
          areaRef.current?.focus?.()
        },
      }

      const submit = async () => {
        const value = text.trim()
        if (!value || disabled) return
        if (await onSend(value, withContext && !props.model.reply ? 'snapshot' : undefined)) {
          setText(current => current === text ? '' : current)
          setWithContext(false)
          setInsertHint('')
          if (areaRef.current) areaRef.current.style.height = 'auto'
        }
      }
      const clearLabel = scoped ? '取消追加' : '取消引用'

      return h('div', {
        className: `dsa-composer${dragging ? ' dragover' : ''}`,
        ref: node => {
          if (props.workspaceRef) props.workspaceRef.current = node
        },
        onDragEnter: dragEnter,
        onDragOver: dragOver,
        onDragLeave: dragLeave,
        onDrop: drop,
      },
        h('div', { className: 'dsa-card' },
          props.model.reply ? (QuotePreview
            ? h(QuotePreview, {
              text: props.model.reply.text,
              removal: { label: clearLabel, onRemove: props.onClearReply },
            })
            : h('div', { className: 'dsa-quote' },
              h('span', null, props.model.reply.text),
              h('button', { type: 'button', className: 'dsa-linkbtn', onClick: props.onClearReply, 'aria-label': clearLabel }, '×'))) : null,
          insertHint ? h('div', { className: 'dsa-hint dsa-composer-hint', role: 'status' }, insertHint) : null,
          dragging ? h('div', { className: 'dsa-hint dsa-composer-hint', role: 'status' }, '松开即可放进当前工作区') : null,
          voiceState !== 'idle' || voiceHint ? h('div', {
            className: 'dsa-voice-status dsa-composer-hint', role: 'status', 'data-state': voiceState,
          }, voiceState === 'requesting' ? '正在请求麦克风权限…'
            : voiceState === 'recording' ? '正在录音，松开结束'
              : voiceState === 'transcribing' ? '正在转写，可取消本次输入' : voiceHint) : null,
          h('textarea', {
            ref: areaRef,
            className: 'dsa-input',
            rows: 1,
            value: text,
            'aria-label': scoped ? '任务补充要求' : '给全局助理发消息',
            placeholder: scoped ? '补充这项任务的要求…' : '给全局助理发消息…',
            disabled,
            onInput: event => {
              setText(event.target.value)
              if (insertHint) setInsertHint('')
              grow()
            },
            onPaste: paste,
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault()
                submit()
              }
            },
          }),
          h('div', { className: 'dsa-row' },
            h('input', {
              ref: fileRef,
              type: 'file',
              multiple: true,
              style: { display: 'none' },
              onChange: event => {
                uploadFiles(event.target.files)
                event.target.value = ''
              },
            }),
            h('div', { className: 'dsa-compose-tools' },
              tipped('语音输入，转写文本只插入草稿', h('button', {
                type: 'button', className: 'dsa-add', 'data-voice': voiceState !== 'idle' ? 'true' : undefined,
                'aria-label': voiceLabel, 'aria-pressed': voiceState !== 'idle', disabled,
                onPointerDown: event => {
                  if (event.button !== 0) return
                  event.preventDefault()
                  voicePointer.current = true
                  event.currentTarget.setPointerCapture?.(event.pointerId)
                  return beginVoice()
                },
                onPointerUp: event => {
                  if (!voicePointer.current) return
                  voicePointer.current = false
                  event.currentTarget.releasePointerCapture?.(event.pointerId)
                  return endVoice()
                },
                onPointerCancel: () => {
                  voicePointer.current = false
                  voiceRef.current?.cancel()
                },
                onKeyDown: event => {
                  if (![' ', 'Enter'].includes(event.key) || event.repeat) return
                  event.preventDefault()
                  beginVoice()
                },
                onKeyUp: event => {
                  if (![' ', 'Enter'].includes(event.key)) return
                  event.preventDefault()
                  endVoice()
                },
              }, voiceState === 'transcribing' ? h('span', { className: 'dsa-spin' })
                : isComponent(ICONS.mic) ? h(Icon, { of: 'mic', size: 16 }) : h('span', { 'aria-hidden': true }, '●')), 'top'),
              !scoped ? tipped('添加文件到工作区', h('button', {
                type: 'button', className: 'dsa-add', 'aria-label': '添加文件',
                disabled: disabled || props.uploading === true, onClick: pickFile,
              }, props.uploading ? h('span', { className: 'dsa-spin' }) : h(Icon, { of: 'attach', size: 16 })), 'top') : null,
              !scoped ? h('button', {
                type: 'button', className: 'dsa-project-chip', 'aria-expanded': props.workspaceOpen,
                'aria-label': `工作区，${props.model.project?.name ?? '默认工作区'}`, onClick: props.onWorkspace,
              }, h(Icon, { of: 'folder', size: 15 }), h('span', { className: 'dsa-rowtitle' }, props.model.project?.name ?? '工作区'),
              h(Icon, { of: 'down', size: 12 })) : null,
              !props.model.reply ? tipped('带上当前工作区最近 10 条消息', h('button', {
                type: 'button', className: 'dsa-add', disabled, 'aria-label': '沿用最近对话', 'aria-pressed': withContext,
                onClick: () => setWithContext(value => !value),
              }, h(Icon, { of: 'clock', size: 16 })), 'top') : null,
              !props.model.reply ? tipped('批量清单，每行一项；可用「 => 相对路径」验收文件', h('button', {
                type: 'button', className: 'dsa-add', disabled, 'aria-label': '插入批量清单',
                onClick: () => {
                  if (!/^\/批量\s/.test(text)) setText(`/批量 批次名称\n${text}`)
                  areaRef.current?.focus()
                },
              }, h(Icon, { of: 'checklist', size: 16 })), 'top') : null),
            h('div', { className: 'dsa-trailing' },
              tipped(sendLabel, h('button', {
                  type: 'button',
                  className: 'dsa-send',
                  'aria-label': sendLabel,
                  disabled: disabled || !text.trim(),
                  onClick: submit,
                }, h(Icon, { of: 'send', size: 15 })), 'top')))),
        props.workspace)
    }

    function timeValue(...values) {
      for (const value of values) {
        const time = Date.parse(value)
        if (Number.isFinite(time)) return time
      }
      return 0
    }

    function sameLocalDay(value, now) {
      const time = Date.parse(value)
      if (!Number.isFinite(time)) return false
      const date = new Date(time)
      return date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
    }

    function formatTime(value) {
      const time = Date.parse(value)
      return Number.isFinite(time) ? new Date(time).toLocaleString() : ''
    }

    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    function artifactQuery(filters = {}) {
      const from = String(filters.from ?? '')
      const to = String(filters.to ?? '')
      return `q=${encodeURIComponent(String(filters.q ?? ''))}&kind=${encodeURIComponent(String(filters.kind ?? ''))}`
        + `&project=${encodeURIComponent(String(filters.project ?? ''))}`
        + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to)}&limit=50`
    }

    function artifactKind(item) {
      if (item.kind) return String(item.kind)
      const ext = String(item.href ?? item.path ?? '').toLowerCase().split('.').pop()
      if (['md', 'markdown'].includes(ext)) return 'markdown'
      if (['html', 'htm'].includes(ext)) return 'html'
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
      return 'file'
    }

    function workbenchTasks(model) {
      const bench = model.workbench ?? model
      const goals = new Map((bench.goals ?? []).map(goal => [goal.id, goal]))
      const runs = (bench.runs ?? []).filter(run => !goals.has(run.goalId)
        && !(run.origin?.kind === 'long-goal' && goals.has(run.origin.goalId)))
      return [...goals.values(), ...runs]
    }

    function taskWorkspace(model, task) {
      const owner = task.ownerSessionId ?? task.parentSessionId ?? model.sessionId
      const known = model.workbench?.sessionProjects?.[owner]
      const cwd = known?.cwd ?? (typeof task.project === 'string' ? task.project : task.project?.cwd) ?? null
      return { cwd, name: known?.name ?? task.project?.name ?? cwd ?? '默认工作区' }
    }

    function overviewArtifacts(model) {
      const runs = new Map([...(model.runs ?? []), ...(model.workbench?.runs ?? [])].map(run => [run.id, run]))
      const found = new Map()
      for (const run of runs.values()) {
        for (const item of artifactsOf(run)) {
          const workspace = taskWorkspace(model, run)
          const href = item.href ?? item.path ?? ''
          const descriptor = {
            ...item, id: item.id ?? `${run.id}:${href}`, href, path: item.path ?? href,
            runId: item.runId ?? run.id,
            ownerSessionId: item.ownerSessionId ?? run.ownerSessionId ?? run.parentSessionId ?? model.sessionId,
            project: item.project ?? workspace.cwd, goal: item.goal ?? run.goal,
            runStatus: item.runStatus ?? run.status, kind: artifactKind(item),
            at: item.at ?? item.createdAt ?? run.finishedAt ?? run.createdAt,
          }
          found.set(descriptor.id, descriptor)
        }
      }
      for (const item of model.artifacts ?? []) {
        const href = item.href ?? item.path ?? ''
        const descriptor = {
          ...item, href, path: item.path ?? href, kind: artifactKind(item),
          at: item.at ?? item.createdAt ?? item.finishedAt,
        }
        const key = descriptor.id ?? `${descriptor.runId}:${href}`
        for (const [knownKey, known] of found) {
          if (knownKey === key || (descriptor.runId && known.runId === descriptor.runId && known.href === href)) found.delete(knownKey)
        }
        found.set(key, descriptor)
      }
      return [...found.values()].sort((left, right) => timeValue(right.at, right.finishedAt, right.createdAt)
        - timeValue(left.at, left.finishedAt, left.createdAt))
    }

    /** Local-date dashboard math only: no model request and no clock-hidden randomness. */
    function todaySummary(model, now = new Date()) {
      if (model.workbench?.summary) return model.workbench.summary
      const tasks = workbenchTasks(model)
      const finishedToday = task => sameLocalDay(task.finishedAt, now)
        || (!task.finishedAt && sameLocalDay(task.createdAt, now))
      return {
        added: tasks.filter(task => sameLocalDay(task.createdAt, now)).length,
        active: tasks.filter(task => ACTIVE_RUN.has(task.status) || task.status === 'verifying').length,
        completed: tasks.filter(task => ['completed', 'partial'].includes(task.status) && finishedToday(task)).length,
        failed: tasks.filter(task => ['failed', 'cancelled', 'stopped', 'interrupted'].includes(task.status) && finishedToday(task)).length,
        decisions: tasks.filter(task => task.status === 'needs-decision' || task.attention?.length).length,
        artifacts: overviewArtifacts(model).filter(item => sameLocalDay(item.at, now)).length,
      }
    }

    function Overview({ model, onOpen, onGoal, onArtifact, onInbox }) {
      const summary = todaySummary(model)
      const tasks = workbenchTasks(model).sort((left, right) =>
        timeValue(right.finishedAt, right.startedAt, right.createdAt) - timeValue(left.finishedAt, left.startedAt, left.createdAt))
      const artifacts = overviewArtifacts(model).slice(0, 5)
      const inbox = model.workbench?.inbox ?? []
      const unread = inbox.filter(entry => !entry.read).length
      const stats = [
        ['added', '新增'], ['active', '进行中'], ['completed', '完成'],
        ['failed', '失败'], ['decisions', '需要决定'], ['artifacts', '产物就绪'],
      ]
      return h('div', { className: 'dsa-workbench-scroll dsa-overview', 'aria-label': '概览' },
        h('section', { className: 'dsa-overview-section' },
          h('h3', null, '今日摘要'), h('div', { className: 'dsa-overview-meta' }, '按本地日期确定性统计'),
          h('div', { className: 'dsa-summary-grid' }, stats.map(([key, label]) =>
            h('div', { key, className: 'dsa-summary-stat', 'data-tone': key === 'failed' ? 'error' : key === 'decisions' ? 'warning' : undefined },
              h('strong', null, summary[key]), h('span', null, label))))),
        h('section', { className: 'dsa-overview-section' },
          h('h3', null, '最近任务'),
          tasks.length ? h('div', { className: 'dsa-overview-list' }, tasks.slice(0, 5).map(task =>
            h(TaskRow, { key: task.id, task, project: taskWorkspace(model, task).name,
              onClick: () => (model.workbench?.goals ?? []).some(goal => goal.id === task.id)
                ? onGoal(task.id) : onOpen(task.id, task.ownerSessionId ?? task.parentSessionId) })))
            : h('div', { className: 'dsa-workbench-empty' }, '暂无任务')),
        h('section', { className: 'dsa-overview-section' },
          h('h3', null, '待办摘要'),
          h('div', { className: 'dsa-overview-inbox' },
            h('p', null, inbox.length ? `${inbox.length} 项待处理，${unread} 项未读` : '暂无待处理事项'),
            inbox.slice(0, 3).map(entry => h('div', { key: entry.id, className: 'dsa-detail-label' }, entry.title || entry.item?.question || '待处理事项')),
            inbox.length ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: onInbox }, '查看全部待办') : null)),
        h('section', { className: 'dsa-overview-section' },
          h('h3', null, '最近产物'),
          artifacts.length ? h('div', { className: 'dsa-overview-list' }, artifacts.map(item =>
            h('button', { key: item.id, type: 'button', className: 'dsa-rowitem dsa-overview-row', onClick: () => onArtifact(item) },
              h('span', { className: 'dsa-file-icon' }, FileTypeIcon ? h(FileTypeIcon, { path: item.href, size: 16 }) : h(Icon, { of: 'code', size: 14 })),
              h('span', { className: 'dsa-task-label' }, h('span', null, item.name || item.href),
                h('span', { className: 'dsa-hint' }, item.goal || '产物')),
              h(Icon, { of: 'right', size: 14 }))))
            : h('div', { className: 'dsa-workbench-empty' }, '暂无产物')))
    }

    function artifactProjectLabel(item, projects) {
      const project = item.project
      if (project && typeof project === 'object') return project.name || project.cwd || '默认工作区'
      return projects.get(project) ?? project ?? '默认工作区'
    }

    function ArtifactLibrary({ model, onLoad, onArtifact }) {
      const [search, setSearch] = react.useState(model.artifactsQuery?.q ?? '')
      const [view, setView] = react.useState('grid')
      const query = model.artifactsQuery ?? { q: '', kind: '', project: '', from: '', to: '' }
      const projects = new Map((model.workbench?.projects ?? []).map(project => [project.cwd, project.name]))
      const kinds = new Set([
        query.kind, ...(model.artifacts ?? []).map(artifactKind), ...overviewArtifacts(model).map(artifactKind),
      ].filter(Boolean))
      const filtered = Boolean(query.q || query.kind || query.project || query.from || query.to)
      const load = (kind = query.kind, project = query.project, from = query.from, to = query.to) =>
        onLoad({ q: search.trim(), kind, project, from, to })
      const tools = h('div', { className: 'dsa-artifact-tools' },
        h('form', { className: 'dsa-answer-row', onSubmit: event => { event.preventDefault(); load() } },
          h('input', { type: 'search', className: 'dsa-answer-input', value: search, 'aria-label': '搜索产物',
            placeholder: '搜索产物', onChange: event => setSearch(event.target.value) }),
          h('button', { type: 'submit', className: 'dsa-linkbtn', disabled: model.artifactsLoading }, '搜索')),
        h('div', { className: 'dsa-artifact-filters' },
          h('select', { className: 'dsa-answer-input', value: query.kind, 'aria-label': '产物类型',
            onChange: event => load(event.target.value, query.project) },
          h('option', { value: '' }, '全部类型'), [...kinds].sort().map(kind => h('option', { key: kind, value: kind }, kind))),
          h('select', { className: 'dsa-answer-input', value: query.project, 'aria-label': '产物工作区',
            onChange: event => load(query.kind, event.target.value) },
          h('option', { value: '' }, '全部工作区'), [...projects].map(([cwd, name]) => h('option', { key: cwd, value: cwd }, name)))),
        h('div', { className: 'dsa-artifact-filters' },
          h('label', { className: 'dsa-more-field' }, '开始日期', h('input', { type: 'date', className: 'dsa-answer-input',
            value: query.from ?? '', 'aria-label': '产物开始日期', onChange: event => load(query.kind, query.project, event.target.value, query.to) })),
          h('label', { className: 'dsa-more-field' }, '结束日期', h('input', { type: 'date', className: 'dsa-answer-input',
            value: query.to ?? '', 'aria-label': '产物结束日期', onChange: event => load(query.kind, query.project, query.from, event.target.value) }))),
        h('div', { className: 'dsa-artifact-filters', role: 'group', 'aria-label': '产物视图' },
          h('button', { type: 'button', className: 'dsa-chip', 'aria-pressed': view === 'grid', onClick: () => setView('grid') }, '网格'),
          h('button', { type: 'button', className: 'dsa-chip', 'aria-pressed': view === 'list', onClick: () => setView('list') }, '列表')))
      const cards = (model.artifacts ?? []).map(item => h('button', { key: item.id, type: 'button',
        className: 'dsa-artifact-card', onClick: () => onArtifact(item) },
        h('span', { className: 'dsa-artifact-title' },
          h('span', { className: 'dsa-file-icon' }, FileTypeIcon ? h(FileTypeIcon, { path: item.href ?? item.path, size: 16 }) : h(Icon, { of: 'code', size: 14 })),
          h('span', null, item.name || item.path || item.href)),
        h('span', { className: 'dsa-artifact-goal' }, item.goal || '产物'),
        h('span', { className: 'dsa-artifact-meta' },
          h('span', null, artifactProjectLabel(item, projects)),
          h('span', null, artifactKind(item)), h('span', null, STATUS_LABELS[item.runStatus] ?? item.runStatus ?? ''),
          formatBytes(item.bytes) ? h('span', null, formatBytes(item.bytes)) : null,
          item.versionCount > 1 ? h('span', null, `${item.versionCount} 个版本`) : null,
          formatTime(item.at ?? item.createdAt ?? item.finishedAt) ? h('span', null, formatTime(item.at ?? item.createdAt ?? item.finishedAt)) : null)))
      return h('div', { className: 'dsa-workbench-scroll', 'aria-label': '全局产物' },
        tools,
        model.artifactsError ? h('div', { className: 'dsa-artifact-error', role: 'alert' },
          `产物读取失败：${model.artifactsError}`,
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => load() }, '重试')) : null,
        model.artifactsLoading ? h('div', { className: 'dsa-workbench-empty', role: 'status' }, '正在读取产物…') : null,
        !model.artifactsLoading && cards.length === 0
          ? h('div', { className: 'dsa-workbench-empty' }, filtered ? '没有找到匹配的产物' : '暂无产物') : null,
        h('div', { className: `dsa-artifact-grid dsa-artifact-${view}` }, cards))
    }

    function automationRecords(data) {
      return (data?.sessions ?? []).flatMap(session => (session.rows ?? [])
        .filter(run => run.origin?.kind === 'scheduled')
        .map(run => ({
          ...run, sessionId: run.parentSessionId ?? session.sessionId,
          sessionTitle: session.title, cwd: session.cwd,
        }))).sort((left, right) => timeValue(right.finishedAt, right.startedAt, right.createdAt)
        - timeValue(left.finishedAt, left.startedAt, left.createdAt))
    }

    function Automation({ model, onLoad, onOpen }) {
      const records = automationRecords(model.automation)
      return h('div', { className: 'dsa-workbench-scroll', 'aria-label': '自动化记录' },
        h('div', { className: 'dsa-overview-section' },
          h('h3', null, '最近执行记录'),
          model.automationError ? h('div', { className: 'dsa-automation-error', role: 'alert' },
            `自动化记录读取失败：${model.automationError}`,
            h('button', { type: 'button', className: 'dsa-linkbtn', onClick: onLoad }, '重试')) : null,
          model.automationLoading ? h('div', { className: 'dsa-workbench-empty', role: 'status' }, '正在读取自动化记录…') : null,
          !model.automationLoading && records.length === 0 ? h('div', { className: 'dsa-workbench-empty' },
            '暂无自动化执行记录', model.automation?.reason ? h('div', null, model.automation.reason) : null) : null,
          h('div', { className: 'dsa-automation-list' }, records.slice(0, 30).map(run => {
            const content = [
              h('strong', { key: 'goal' }, run.goal || run.title || '自动化执行'),
              h('span', { key: 'session', className: 'dsa-overview-meta' }, run.sessionTitle || run.sessionId || '自动化任务'),
              h('span', { key: 'meta', className: 'dsa-artifact-meta' },
                h('span', null, STATUS_LABELS[run.status] ?? run.status ?? ''),
                run.cwd ? h('span', null, run.cwd) : null,
                formatTime(run.finishedAt ?? run.startedAt ?? run.createdAt) ? h('span', null, formatTime(run.finishedAt ?? run.startedAt ?? run.createdAt)) : null),
            ]
            return run.id ? h('button', { key: `${run.sessionId}:${run.id}`, type: 'button', className: 'dsa-automation-record',
              onClick: () => onOpen(run.id, run.sessionId) }, content)
              : h('div', { key: `${run.sessionId}:${run.goal}`, className: 'dsa-automation-record' }, content)
          }))))
    }

    function ActionButton({ model, dispatch, confirmKey, label, confirmLabel, detail, onConfirm, disabled = false, busy = false, ariaLabel }) {
      const confirming = model?.more?.confirming?.[confirmKey] === true
      const ask = () => dispatch?.({ type: 'setMoreConfirm', key: confirmKey, confirming: true })
      const cancel = () => dispatch?.({ type: 'setMoreConfirm', key: confirmKey, confirming: false })
      if (busy) return h('button', { type: 'button', className: 'dsa-linkbtn', disabled: true, 'aria-busy': 'true', 'aria-label': ariaLabel }, '处理中…')
      if (!confirming) return h('button', {
        type: 'button', className: 'dsa-linkbtn', disabled, onClick: ask, 'aria-label': ariaLabel,
      }, label)
      return h('span', { className: 'dsa-more-confirm', role: 'alert' },
        h('span', null, detail ?? `确认${label}？`),
        h('button', {
          type: 'button', className: 'dsa-linkbtn', disabled,
          onClick: async () => { if (await onConfirm?.() !== false) cancel() },
        }, confirmLabel),
        h('button', { type: 'button', className: 'dsa-linkbtn', onClick: cancel }, '取消'))
    }

    function MoreHub({ model, dispatch }) {
      const more = model.more ?? initialMore()
      const entry = MORE_ENTRIES.find(item => item.id === more.panel)
      const panelRef = react.useRef(null)
      const cardRefs = react.useRef(new Map())
      const hadPanel = react.useRef(false)
      react.useEffect(() => {
        if (more.panel) panelRef.current?.focus?.()
        else if (hadPanel.current) cardRefs.current.get(more.lastPanel)?.focus?.()
        hadPanel.current = Boolean(more.panel)
      }, [more.panel])
      const open = panel => dispatch({ type: 'openMore', panel })
      const cardKeys = event => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const cards = [...cardRefs.current.values()].filter(Boolean)
        const index = cards.indexOf(event.target)
        if (index < 0) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1
          : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % cards.length : (index - 1 + cards.length) % cards.length
        cards[next]?.focus?.()
      }
      const content = more.panel === 'notifications' ? h(NotificationsPanel, { model, dispatch })
        : more.panel === 'capabilities' ? h(CapabilitiesPanel, { model, dispatch })
          : more.panel === 'memory' ? h(MemoryPanel, { model, dispatch })
            : more.panel === 'runtime' ? h(RuntimePanel, { model, dispatch })
              : more.panel === 'evidence' ? h(EvidencePanel, { model, dispatch })
                : more.panel === 'cost' ? h(CostPanel, { model, dispatch })
                  : more.panel === 'profiles' ? h(ProfilesPanel, { model, dispatch })
                    : more.panel === 'device' ? h(DevicePanel, { model, dispatch })
                      : more.panel === 'plan' ? h(PlanPreviewPanel, { model, dispatch })
                        : more.panel === 'automations' ? h(AutomationsPanel, { model, dispatch })
                          : more.panel === 'shares' ? h(SharesPanel, { model, dispatch })
                            : more.panel === 'market' ? h(MarketPanel, { model, dispatch })
                              : more.panel === 'cloud-worker' ? h(CloudWorkerPanel, { model, dispatch })
                                : h(CollectionPanel, { model, dispatch, panel: more.panel })
      return h('div', { className: 'dsa-workbench-scroll', 'aria-label': '更多' },
        more.panel ? h('section', {
          className: 'dsa-more-panel', ref: panelRef, tabIndex: -1, role: 'region', 'aria-labelledby': 'dsa-more-title',
          onKeyDown: event => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            dispatch({ type: 'closeMore' })
          },
        },
        h('div', { className: 'dsa-more-head' },
          h(IconButton, { icon: 'back', label: '返回更多', onClick: () => dispatch({ type: 'closeMore' }) }),
          h('h2', { id: 'dsa-more-title' }, entry?.label ?? '更多')),
        more.error ? h('div', { className: 'dsa-more-error', role: 'alert' },
          more.error,
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => dispatch({ type: 'loadMore', panel: more.panel, force: true }) }, '重试')) : null,
        more.loading ? h('div', { className: 'dsa-workbench-empty', role: 'status' }, '正在读取…') : null,
        !more.loading ? h('div', { className: 'dsa-more-content' }, content) : null)
          : h('div', { className: 'dsa-more-grid', onKeyDown: cardKeys },
            MORE_ENTRIES.map(item => h('button', {
              key: item.id, type: 'button', className: 'dsa-more-card', ref: node => {
                if (node) cardRefs.current.set(item.id, node)
                else cardRefs.current.delete(item.id)
              },
              onClick: () => open(item.id), 'aria-label': item.label,
            },
            h('span', { className: 'dsa-more-card-icon', 'aria-hidden': true }, h(Icon, { of: item.icon, size: 17 })),
            h('span', { className: 'dsa-more-card-copy' }, h('strong', null, item.label), h('span', null, item.description)),
            h(Icon, { of: 'right', size: 14 })))))
    }

    function NotificationsPanel({ model, dispatch }) {
      const data = model.more.notifications ?? {}
      const preferences = data.preferences ?? {
        events: { added: 'inbox', completed: 'both', failed: 'both', decision: 'both', approval: 'both', artifact: 'inbox' },
        channels: ['inbox', 'push'], maxPushPerHour: 3,
        dailyBrief: { enabled: true, time: '09:00', timeZone: 'UTC', channels: ['inbox'] },
        quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: 'UTC', except: [] },
      }
      const eventLabels = { added: '新增', completed: '完成', failed: '失败', decision: '需要决定', approval: '审批', artifact: '产物就绪' }
      const [draft, setDraft] = react.useState(preferences)
      const busy = model.more.busy?.notifications === true
      react.useEffect(() => setDraft(preferences), [data.revision, preferences.dailyBrief?.time, preferences.quietHours?.start])
      const patch = (group, key, value) => setDraft(current => ({
        ...current, [group]: { ...current[group], [key]: value },
      }))
      const toggleChannel = (group, channel, checked) => {
        const current = draft[group]?.channels ?? []
        const channels = checked ? [...new Set([...current, channel])] : current.filter(value => value !== channel)
        if (channels.length) patch(group, 'channels', channels)
      }
      const brief = data.brief ?? data.dailyBrief
      return h('div', null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '通知收件箱'),
          h('div', { className: 'dsa-more-meta' }, `${data.unreadCount ?? 0} 项未读`,
            data.unreadCount ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy,
              onClick: () => dispatch({ type: 'readNotifications' }) }, '全部标为已读') : null),
          listOf(data.inbox).length ? h('div', { className: 'dsa-more-list' }, data.inbox.map(item =>
            h('div', { key: item.id, className: 'dsa-more-row' },
              h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, item.title ?? item.event), item.read ? null : h('span', { className: 'dsa-inbox-unread', 'aria-label': '未读' })),
              h('div', { className: 'dsa-detail-label' }, item.body ?? item.taskTitle ?? ''),
              h('div', { className: 'dsa-more-meta' }, item.event, formatTime(item.at), item.read ? null : h('button', {
                type: 'button', className: 'dsa-linkbtn', disabled: busy,
                onClick: () => dispatch({ type: 'readNotifications', ids: [item.id] }),
              }, '标为已读'))))) : h('div', { className: 'dsa-workbench-empty' }, '暂无通知')),
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '每日简报'),
          brief ? h('div', { className: 'dsa-more-list' },
            h('div', { className: 'dsa-more-meta' }, brief.date ?? '', brief.nextAt ? `下次：${formatTime(brief.nextAt)}` : ''),
            h('pre', { className: 'dsa-more-code' }, brief.text ?? '今日暂无通知活动'))
            : h('div', { className: 'dsa-workbench-empty' }, '每日简报已关闭')),
        h('form', { className: 'dsa-more-section dsa-more-form', onSubmit: event => {
          event.preventDefault()
          return dispatch({ type: 'saveNotifications', patch: { events: draft.events, channels: draft.channels,
            maxPushPerHour: draft.maxPushPerHour, dailyBrief: draft.dailyBrief, quietHours: draft.quietHours } })
        } },
        h('h3', null, '通知偏好'),
        Object.entries(eventLabels).map(([event, label]) => h('label', { key: event, className: 'dsa-more-field' }, label, h('select', {
          className: 'dsa-answer-input', value: draft.events?.[event] ?? 'inbox', disabled: busy,
          onChange: change => patch('events', event, change.target.value),
        }, h('option', { value: 'off' }, '关闭'), h('option', { value: 'inbox' }, '仅收件箱'),
          h('option', { value: 'push' }, '仅推送'), h('option', { value: 'both' }, '收件箱并推送')))),
        ['inbox', 'push'].map(channel => h('label', { key: `channel-${channel}`, className: 'dsa-more-check' }, h('input', {
          type: 'checkbox', checked: draft.channels?.includes(channel) === true, disabled: busy,
          onChange: event => toggleChannel('channels', channel, event.target.checked),
        }), `启用 ${channel} 通道`)),
        h('label', { className: 'dsa-more-field' }, '每小时最多推送', h('input', {
          type: 'number', min: 0, max: 1000, className: 'dsa-answer-input', value: draft.maxPushPerHour ?? 3, disabled: busy,
          onChange: event => patch('maxPushPerHour', Number(event.target.value)),
        })),
        h('label', { className: 'dsa-more-check' }, h('input', {
          type: 'checkbox', checked: draft.dailyBrief?.enabled === true, disabled: busy,
          onChange: event => patch('dailyBrief', 'enabled', event.target.checked),
        }), '启用每日简报'),
        h('label', { className: 'dsa-more-field' }, '简报时间', h('input', {
          type: 'time', className: 'dsa-answer-input', value: draft.dailyBrief?.time ?? '09:00', disabled: busy,
          onChange: event => patch('dailyBrief', 'time', event.target.value),
        })),
        h('label', { className: 'dsa-more-field' }, '简报时区', h('input', {
          className: 'dsa-answer-input', value: draft.dailyBrief?.timeZone ?? 'UTC', disabled: busy,
          onChange: event => patch('dailyBrief', 'timeZone', event.target.value),
        })),
        ['inbox', 'push'].map(channel => h('label', { key: channel, className: 'dsa-more-check' }, h('input', {
          type: 'checkbox', checked: draft.dailyBrief?.channels?.includes(channel) === true, disabled: busy,
          onChange: event => toggleChannel('dailyBrief', channel, event.target.checked),
        }), `简报送达至 ${channel}`)),
        h('label', { className: 'dsa-more-check' }, h('input', {
          type: 'checkbox', checked: draft.quietHours?.enabled === true, disabled: busy,
          onChange: event => patch('quietHours', 'enabled', event.target.checked),
        }), '启用免打扰'),
        h('label', { className: 'dsa-more-field' }, '免打扰开始', h('input', {
          type: 'time', className: 'dsa-answer-input', value: draft.quietHours?.start ?? '22:00', disabled: busy,
          onChange: event => patch('quietHours', 'start', event.target.value),
        })),
        h('label', { className: 'dsa-more-field' }, '免打扰结束', h('input', {
          type: 'time', className: 'dsa-answer-input', value: draft.quietHours?.end ?? '08:00', disabled: busy,
          onChange: event => patch('quietHours', 'end', event.target.value),
        })),
        h('label', { className: 'dsa-more-field' }, '免打扰时区', h('input', {
          className: 'dsa-answer-input', value: draft.quietHours?.timeZone ?? 'UTC', disabled: busy,
          onChange: event => patch('quietHours', 'timeZone', event.target.value),
        })),
        h('div', { className: 'dsa-more-meta' }, '免打扰例外'),
        ['added', 'completed', 'failed', 'decision', 'approval', 'artifact', 'dailyBrief'].map(event => h('label', { key: event, className: 'dsa-more-check' }, h('input', {
          type: 'checkbox', checked: draft.quietHours?.except?.includes(event) === true, disabled: busy,
          onChange: change => {
            const current = draft.quietHours?.except ?? []
            patch('quietHours', 'except', change.target.checked ? [...new Set([...current, event])] : current.filter(value => value !== event))
          },
        }), event)),
        h('button', { type: 'submit', className: 'dsa-chip', disabled: busy }, busy ? '正在保存…' : '保存通知偏好')))
    }

    function CapabilitiesPanel({ model, dispatch }) {
      const data = model.more.capabilities ?? {}
      const busy = model.more.busy ?? {}
      const draft = model.more.mcpDraft ?? { name: '', transport: 'stdio', command: 'node', args: '', url: '', env: '', timeoutMs: '' }
      const loadedSkill = model.more.loadedSkill
      const field = (key, value) => dispatch({ type: 'updateMcpDraft', patch: { [key]: value } })
      const addServer = () => {
        const server = { transport: draft.transport, enabled: true }
        if (draft.transport === 'stdio') {
          server.command = draft.command.trim()
          server.args = draft.args.split('\n').map(value => value.trim()).filter(Boolean)
        } else server.url = draft.url.trim()
        const env = Object.fromEntries(draft.env.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
          const separator = line.indexOf('=')
          return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : null
        }).filter(Boolean))
        if (Object.keys(env).length) server.env = env
        if (draft.timeoutMs) server.timeoutMs = Number(draft.timeoutMs)
        return dispatch({ type: 'capabilityAction', name: draft.name.trim(), action: 'add', server,
          expectedSettingsRevision: data.settingsRevision })
      }
      const action = (name, operation, enabled) => dispatch({
        type: 'capabilityAction', name, action: operation, enabled,
        expectedSettingsRevision: data.settingsRevision,
      })
      const group = (title, collection, key, empty) => h('section', { className: 'dsa-more-section' },
        h('h3', null, title),
        listOf(collection?.[key]).length ? h('div', { className: 'dsa-more-list' }, collection[key].map((item, index) => {
          const name = item.name ?? item.id ?? `${title} ${index + 1}`
          const rowBusy = busy[`capability:${name}:probe`] || busy[`capability:${name}:restart`] || busy[`capability:${name}:setEnabled`]
          return h('div', { key: name, className: 'dsa-more-row' },
            h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, name), h('span', { className: 'dsa-status' }, item.status ?? (item.enabled === false ? 'disabled' : 'enabled'))),
            item.description ? h('div', { className: 'dsa-detail-label' }, item.description) : null,
            h('div', { className: 'dsa-more-meta' }, item.scope, item.version, item.provider, item.transport, item.owner,
              item.kind, item.type, item.resource, item.action, item.effect, item.scopes?.join('、')),
            title === 'MCP 连接器' ? h('div', { className: 'dsa-more-actions' },
              h('button', { type: 'button', className: 'dsa-linkbtn', disabled: rowBusy || item.enabled === false, onClick: () => action(name, 'probe') }, '探测'),
              h('button', { type: 'button', className: 'dsa-linkbtn', disabled: rowBusy || item.enabled === false, onClick: () => action(name, 'restart') }, '重启'),
              h('button', {
                type: 'button', className: 'dsa-linkbtn', disabled: rowBusy || item.manageable === false || item.pluginOwned === true,
                onClick: () => action(name, 'setEnabled', item.enabled === false),
              }, item.enabled === false ? '启用' : '停用')) : null,
            title === 'Skills' && item.imported ? h('div', { className: 'dsa-more-actions' },
              h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy[`capability:${name}:loadSkill`],
                onClick: () => action(name, 'loadSkill') }, '按需加载'),
              h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy[`capability:${name}:setSkillEnabled`],
                onClick: () => action(name, 'setSkillEnabled', item.enabled === false) }, item.enabled === false ? '启用 Skill' : '停用 Skill')) : null)
        })) : h('div', { className: 'dsa-workbench-empty' }, empty))
      return h('div', null,
        h('div', { className: 'dsa-more-meta' }, `设置版本：${data.settingsRevision ?? '—'}`),
        data.available === false ? h('div', { className: 'dsa-more-error' }, '当前宿主未提供能力中心') : null,
        h('section', { className: 'dsa-more-section dsa-more-editor', 'aria-label': '添加 MCP 连接器' },
          h('h3', null, '添加 MCP 连接器'),
          h('label', { className: 'dsa-more-field' }, '名称', h('input', { className: 'dsa-answer-input', value: draft.name,
            'aria-label': 'MCP 名称', onChange: event => field('name', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '传输', h('select', { className: 'dsa-answer-input', value: draft.transport,
            'aria-label': 'MCP 传输', onChange: event => field('transport', event.target.value) },
          h('option', { value: 'stdio' }, 'stdio'), h('option', { value: 'http' }, 'HTTP'), h('option', { value: 'sse' }, 'SSE'))),
          draft.transport === 'stdio' ? h(ReactFragment, null,
            h('label', { className: 'dsa-more-field' }, '命令', h('input', { className: 'dsa-answer-input', value: draft.command,
              'aria-label': 'MCP 命令', onChange: event => field('command', event.target.value) })),
            h('label', { className: 'dsa-more-field' }, '参数（每行一个）', h('textarea', { className: 'dsa-answer-input', value: draft.args,
              'aria-label': 'MCP 参数', onChange: event => field('args', event.target.value) })))
            : h('label', { className: 'dsa-more-field' }, 'HTTPS 地址', h('input', { className: 'dsa-answer-input', value: draft.url,
              'aria-label': 'MCP 地址', onChange: event => field('url', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '环境变量引用', h('textarea', { className: 'dsa-answer-input', value: draft.env,
            placeholder: 'TOKEN=${MCP_TOKEN}', 'aria-label': 'MCP 环境变量引用', onChange: event => field('env', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '超时（毫秒）', h('input', { className: 'dsa-answer-input', type: 'number', min: 100,
            value: draft.timeoutMs, 'aria-label': 'MCP 超时毫秒', onChange: event => field('timeoutMs', event.target.value) })),
          h('div', { className: 'dsa-more-meta' }, '只接受 ${ENV_VAR} 引用，不保存明文凭据；添加后由宿主加载，必要时手动重启。'),
          h(ActionButton, { model, dispatch, confirmKey: 'capability:add', label: '添加 MCP', confirmLabel: '确认添加',
            busy: busy['capability:add'] === true, disabled: data.mcp?.operations?.add === false || !draft.name.trim()
              || (draft.transport === 'stdio' ? !draft.command.trim() : !draft.url.trim()),
            detail: '确认将这条 MCP 配置写入宿主 settings？', onConfirm: addServer })),
        group('Skills', data.skills, 'items', '暂无 Skill'),
        group('MCP 连接器', data.mcp, 'servers', '暂无 MCP 连接器'),
        group('授权与 Grants', data.grants, 'items', '暂无授权记录'),
        loadedSkill ? h('section', { className: 'dsa-more-section' },
          h('h3', null, `已加载 Skill · ${loadedSkill.name}`),
          h('div', { className: 'dsa-more-meta' }, loadedSkill.provider, loadedSkill.source, loadedSkill.path),
          h('pre', { className: 'dsa-more-code' }, loadedSkill.content)) : null,
        model.more.capabilityResult ? h('section', { className: 'dsa-more-section' },
          h('h3', null, '最近操作'), h('pre', { className: 'dsa-more-code' }, JSON.stringify(model.more.capabilityResult, null, 2))) : null)
    }

    function MemoryRow({ entry, model, dispatch }) {
      const [editing, setEditing] = react.useState(false)
      const [body, setBody] = react.useState(entry.body ?? '')
      const [confirming, setConfirming] = react.useState(false)
      const busy = model.more.busy?.[`memory:${entry.id}`] === true
      if (editing) return h('form', {
        className: 'dsa-more-row dsa-more-form', onSubmit: async event => {
          event.preventDefault()
          if (busy || body === entry.body) return
          const saved = await dispatch({ type: 'updateMemory', id: entry.id, expectedRevision: entry.revision, patch: { body } })
          if (saved) setEditing(false)
          return saved
        },
      },
      h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, entry.title ?? entry.id), h('span', { className: 'dsa-more-meta' }, `修订 ${entry.revision ?? 1}`)),
      h('textarea', { className: 'dsa-answer-input dsa-more-code', value: body, 'aria-label': `编辑记忆 ${entry.title ?? entry.id}`, onChange: event => setBody(event.target.value) }),
      h('div', { className: 'dsa-more-actions' },
        h('button', { type: 'submit', className: 'dsa-linkbtn', disabled: busy || body === entry.body }, '保存记忆'),
        h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy, onClick: () => { setBody(entry.body ?? ''); setEditing(false) } }, '取消')))
      return h('div', { className: 'dsa-more-row' },
        h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, entry.title ?? entry.id), h('span', { className: 'dsa-status' }, entry.status ?? entry.type)),
        h('div', { className: 'dsa-detail-label' }, entry.body || '（空记录）'),
        h('div', { className: 'dsa-more-meta' }, entry.type, entry.scope, entry.project, entry.task, entry.phase, `修订 ${entry.revision ?? 1}`),
        entry.editable || entry.forgettable ? h('div', { className: 'dsa-more-actions' },
          entry.editable ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy, onClick: () => setEditing(true) }, '编辑') : null,
          entry.forgettable ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy, onClick: () => setConfirming(true) }, '遗忘') : null,
          confirming ? h('span', { className: 'dsa-meta' }, '遗忘后不可恢复') : null,
          confirming ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy, onClick: async () => {
            if (await dispatch({ type: 'forgetMemory', id: entry.id, expectedRevision: entry.revision })) setConfirming(false)
          } }, '确认遗忘') : null,
          confirming ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy, onClick: () => setConfirming(false) }, '取消') : null)
          : h('span', { className: 'dsa-more-meta' }, '只读记录'))
    }

    function MemoryPanel({ model, dispatch }) {
      const data = model.more.memory ?? {}
      const [search, setSearch] = react.useState(model.more.memoryQuery ?? '')
      const entries = listOf(data.entries)
      return h('div', null,
        h('form', { className: 'dsa-more-section dsa-more-form', onSubmit: event => {
          event.preventDefault()
          return dispatch({ type: 'searchMemory', query: search.trim() })
        } },
        h('h3', null, '搜索记忆'),
        h('div', { className: 'dsa-more-actions' },
          h('input', { type: 'search', className: 'dsa-answer-input', value: search, 'aria-label': '搜索记忆', placeholder: '标题、正文、标签或任务', onChange: event => setSearch(event.target.value) }),
          h('button', { type: 'submit', className: 'dsa-linkbtn', disabled: model.more.busy?.memory === true }, '搜索'))),
        data.enabled === false ? h('div', { className: 'dsa-more-error' }, '记忆服务未启用') : null,
        entries.length ? h('div', { className: 'dsa-more-list' }, entries.map(entry =>
          h(MemoryRow, { key: entry.id, entry, model, dispatch }))) : h('div', { className: 'dsa-workbench-empty' }, '暂无匹配的记忆'))
    }

    function RuntimePanel({ model, dispatch }) {
      const data = model.more.runtime ?? {}
      const draft = model.more.runtimeDraft ?? { source: 'auto', confirmStop: false, live: true, frameView: null, streamError: '', cursor: 0 }
      const update = patch => dispatch({ type: 'updateRuntimePanel', patch })
      const busy = model.more.busy?.runtime === true
      const control = data.control ?? {}
      react.useEffect(() => {
        if (!draft.live || typeof EventSource === 'undefined') return undefined
        const stream = new EventSource(`${API}/runtime-view/events?cursor=${draft.cursor}`)
        const receive = message => {
          try {
            const frame = JSON.parse(message.data)
            const event = frame.event
            if (Number.isSafeInteger(event?.cursor)) update({ cursor: Math.max(draft.cursor, event.cursor) })
            dispatch({ type: 'applyRuntimeEvent', event })
            const next = event?.type === 'screenshot' ? event : event?.snapshot?.frame ?? event?.frame
            if (next?.path) update({ frameView: { path: next.path, seq: next.seq ?? next.capturedAt ?? event?.cursor ?? Date.now() } })
          } catch {
            update({ streamError: '运行时事件流返回了无法解析的数据' })
          }
        }
        stream.addEventListener('console', receive)
        stream.onopen = () => update({ streamError: '' })
        stream.onerror = () => update({ streamError: '运行时事件流连接失败；正在按事件游标重连' })
        return () => stream.close()
      }, [draft.live])
      react.useEffect(() => {
        const result = model.more.runtimeActionResult
        if (result?.path) update({ frameView: { path: result.path, seq: result.seq ?? result.capturedAt ?? Date.now() } })
      }, [model.more.runtimeActionResult])
      return h('div', null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '运行时状态'),
          h('div', { className: 'dsa-more-meta' }, `模式：${control.mode ?? 'unknown'}`, `自动操作：${control.automaticActions ?? 'unknown'}`, data.currentAction?.name ? `当前动作：${data.currentAction.name}` : '', data.capturedAt ? formatTime(data.capturedAt) : ''),
          h('div', { className: 'dsa-more-meta' }, ...Object.entries(data.services ?? {}).map(([name, available]) => `${name}: ${available ? 'available' : 'unavailable'}`))),
        data.available === false ? h('div', { className: 'dsa-more-error' }, '当前宿主未提供可控制的运行时') : null,
        h('section', { className: 'dsa-more-section dsa-more-form' },
          h('h3', null, '运行时操作'),
          h('label', { className: 'dsa-more-field' }, '截图来源', h('select', {
            className: 'dsa-answer-input', value: draft.source, onChange: event => update({ source: event.target.value }),
          }, h('option', { value: 'auto' }, '自动选择'), h('option', { value: 'browser' }, '浏览器'), h('option', { value: 'desktop' }, '桌面'))),
          h('div', { className: 'dsa-more-actions' },
            h('button', { type: 'button', className: 'dsa-chip', disabled: busy || data.available === false, onClick: () => dispatch({ type: 'runtimeAction', action: 'capture', payload: { source: draft.source } }) }, '截图'),
            h('button', { type: 'button', className: 'dsa-chip', 'aria-pressed': draft.live, onClick: () => update({ live: !draft.live }) }, draft.live ? '暂停实时画面' : '恢复实时画面'),
            h('button', { type: 'button', className: 'dsa-chip', disabled: busy || data.available === false, onClick: () => dispatch({ type: 'runtimeAction', action: 'takeover', payload: {} }) }, '接管'),
            h('button', { type: 'button', className: 'dsa-chip', disabled: busy || data.available === false, onClick: () => dispatch({ type: 'runtimeAction', action: 'release', payload: {} }) }, '释放'),
            h('button', { type: 'button', className: 'dsa-linkbtn dsa-stop-task', disabled: busy || data.available === false, onClick: () => update({ confirmStop: true }) }, '停止')),
          draft.confirmStop ? h('div', { className: 'dsa-more-actions', role: 'alert' },
            h('span', null, '停止会写入紧急停止标记并取消当前运行。'),
            h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy, onClick: () => dispatch({ type: 'runtimeAction', action: 'stop', payload: { runId: model.detail?.id ?? null } }) }, '确认停止'),
            h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => update({ confirmStop: false }) }, '取消')) : null),
        model.more.runtimeActionResult ? h('section', { className: 'dsa-more-section' },
          h('h3', null, '最近操作结果'),
          model.more.runtimeActionResult.path ? h('div', { className: 'dsa-more-meta' }, `截图：${model.more.runtimeActionResult.path}`, model.more.runtimeActionResult.capturedAt ? formatTime(model.more.runtimeActionResult.capturedAt) : '') : null,
          h('pre', { className: 'dsa-more-code' }, JSON.stringify(model.more.runtimeActionResult, null, 2))) : null,
        draft.streamError ? h('div', { className: 'dsa-more-error', role: 'alert' }, draft.streamError) : null,
        draft.frameView?.path ? h('section', { className: 'dsa-more-section' },
          h('h3', null, '实时画面'),
          h('img', { className: 'dsa-runtime-frame', alt: '当前浏览器或桌面画面',
            src: `${API}/runtime-view/frame?path=${encodeURIComponent(draft.frameView.path)}&seq=${encodeURIComponent(draft.frameView.seq)}` })) : null,
        listOf(data.actions).length ? h('section', { className: 'dsa-more-section' },
          h('h3', null, '最近动作'), h('div', { className: 'dsa-more-list' }, data.actions.slice(-12).reverse().map(item =>
            h('div', { key: item.id, className: 'dsa-more-row' }, h('span', { className: 'dsa-more-row-title' }, item.name), h('span', { className: 'dsa-more-meta' }, item.source, item.phase, item.durationMs != null ? `${item.durationMs}ms` : ''))))) : null)
    }

    function EvidencePanel({ model, dispatch }) {
      const data = model.more.evidence ?? {}
      const runs = new Map([...(model.workbench?.runs ?? []), ...(model.runs ?? [])].filter(run => run?.id).map(run => [run.id, run]))
      if (model.detail?.id) runs.set(model.detail.id, model.detail)
      const selected = model.more.evidenceRunId || [...runs.keys()][0] || ''
      return h('div', null,
        h('section', { className: 'dsa-more-section dsa-more-form' },
          h('h3', null, '证据任务'),
          runs.size ? h('select', {
            className: 'dsa-answer-input', value: selected, 'aria-label': '证据任务',
            onChange: event => dispatch({ type: 'loadMore', panel: 'evidence', runId: event.target.value, force: true }),
          }, [...runs].map(([id, run]) => h('option', { key: id, value: id }, run.title ?? run.goal ?? id)))
            : h('div', { className: 'dsa-workbench-empty' }, '当前或最近任务中没有可加载的运行记录')),
        data.summary ? h('div', { className: 'dsa-more-statgrid' },
          h('div', { className: 'dsa-more-stat' }, h('strong', null, data.summary.total ?? 0), h('span', null, '证据总数')),
          h('div', { className: 'dsa-more-stat' }, h('strong', null, data.summary.byStatus?.passed ?? 0), h('span', null, '通过')),
          h('div', { className: 'dsa-more-stat' }, h('strong', null, data.summary.byStatus?.failed ?? 0), h('span', null, '失败')),
          h('div', { className: 'dsa-more-stat' }, h('strong', null, data.summary.byStatus?.unverified ?? 0), h('span', null, '无法核验'))) : null,
        listOf(data.cards).length ? h('div', { className: 'dsa-more-list' }, data.cards.map(card =>
          h('article', { key: card.id, className: 'dsa-more-row' },
            h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, card.title), h('span', { className: 'dsa-status' }, card.status)),
            h('div', { className: 'dsa-more-meta' }, card.category, card.kind, card.confidence?.level ? `置信度：${card.confidence.level}` : ''),
            card.basis?.summary ? h('div', { className: 'dsa-detail-label' }, card.basis.summary) : null,
            listOf(card.basis?.evidence).length ? h('ul', { className: 'dsa-detail-label' }, card.basis.evidence.map((item, index) => h('li', { key: index }, item))) : null))) : h('div', { className: 'dsa-workbench-empty' }, '暂无质量证据'),
        data.confidencePolicy?.explanation ? h('div', { className: 'dsa-hint' }, data.confidencePolicy.explanation) : null)
    }

    function CostPanel({ model, dispatch }) {
      const data = model.more.cost ?? {}
      const draft = model.more.routeDraft ?? { role: 'worker', complexity: 'medium', tokens: '4000' }
      const routeResult = model.more.routeResult
      const budgetDraft = model.more.costBudgetDraft ?? { currency: 'USD', micros: '1000000' }
      const busy = model.more.busy?.cost === true
      const field = (key, value) => dispatch({ type: 'updateRouteDraft', patch: { [key]: value } })
      const currencies = Object.entries(data.byCurrency ?? {})
      return h('div', null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '成本汇总'),
          h('div', { className: 'dsa-more-meta' }, `${data.runs ?? 0} 个运行`, `${data.records ?? 0} 条用量`, data.complete === false ? '存在未定价用量' : '全部已定价'),
          currencies.length ? h('div', { className: 'dsa-more-statgrid' }, currencies.map(([currency, amount]) =>
            h('div', { key: currency, className: 'dsa-more-stat' }, h('strong', null, formatMicros(amount, currency)), h('span', null, currency))))
            : h('div', { className: 'dsa-workbench-empty' }, '暂无成本记录')),
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '未定价项'),
          listOf(data.unpricedItems).length ? h('div', { className: 'dsa-more-list' }, data.unpricedItems.map((item, index) =>
            h('div', { key: `${item.model}:${item.runId}:${index}`, className: 'dsa-more-row' },
              h('span', { className: 'dsa-more-row-title' }, item.model ?? '未知模型'),
              h('span', { className: 'dsa-more-meta' }, item.runId, item.reason))))
            : h('div', { className: 'dsa-workbench-empty' }, '没有未定价项')),
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '按模型'),
          Object.keys(data.byModel ?? {}).length ? h('div', { className: 'dsa-more-list' }, Object.entries(data.byModel).map(([name, item]) =>
            h('div', { key: name, className: 'dsa-more-row' },
              h('span', { className: 'dsa-more-row-title' }, name),
              h('span', { className: 'dsa-more-meta' }, `${item.calls ?? 0} 次调用`, `${item.totalTokens ?? 0} tokens`, item.priced === false ? '未定价' : formatMicros(item.amountMicros, item.usageByCurrency && Object.keys(item.usageByCurrency).length === 1 ? Object.keys(item.usageByCurrency)[0] : '')))))
            : h('div', { className: 'dsa-workbench-empty' }, '暂无模型用量')),
        h('section', { className: 'dsa-more-section dsa-more-form' },
          h('h3', null, '成本预算'),
          h('label', { className: 'dsa-more-field' }, '币种', h('input', { className: 'dsa-answer-input', value: budgetDraft.currency,
            'aria-label': '预算币种', onChange: event => dispatch({ type: 'updateCostBudget', patch: { currency: event.target.value.toUpperCase() } }) })),
          h('label', { className: 'dsa-more-field' }, '预算（微单位）', h('input', { className: 'dsa-answer-input', type: 'number', min: 0, value: budgetDraft.micros,
            'aria-label': '预算微单位', onChange: event => dispatch({ type: 'updateCostBudget', patch: { micros: event.target.value } }) })),
          h('button', { type: 'button', className: 'dsa-chip', disabled: busy,
            onClick: () => dispatch({ type: 'saveCostBudget', currency: budgetDraft.currency, micros: Number(budgetDraft.micros) }) }, '保存预算')),
        h('section', { className: 'dsa-more-section dsa-more-form' },
          h('h3', null, '模型路由建议'),
          h('label', { className: 'dsa-more-field' }, '角色', h('select', { className: 'dsa-answer-input', value: draft.role,
            'aria-label': '路由角色', onChange: event => field('role', event.target.value) },
          h('option', { value: 'planner' }, '规划'), h('option', { value: 'worker' }, '执行'), h('option', { value: 'reviewer' }, '复核'), h('option', { value: 'aggregator' }, '汇总'))),
          h('label', { className: 'dsa-more-field' }, '复杂度', h('select', { className: 'dsa-answer-input', value: draft.complexity,
            'aria-label': '路由复杂度', onChange: event => field('complexity', event.target.value) },
          h('option', { value: 'low' }, '低'), h('option', { value: 'medium' }, '中'), h('option', { value: 'high' }, '高'))),
          h('label', { className: 'dsa-more-field' }, '预计输入 Tokens', h('input', { className: 'dsa-answer-input', type: 'number', min: 0, value: draft.tokens,
            'aria-label': '路由预计 Tokens', onChange: event => field('tokens', event.target.value) })),
          h('button', { type: 'button', className: 'dsa-chip', onClick: () => dispatch({ type: 'suggestRoute',
            role: draft.role, complexity: draft.complexity, inputTokens: Number(draft.tokens) }) }, '获取路由建议'),
          routeResult ? h('div', { className: 'dsa-more-meta' }, routeResult.status, routeResult.provider, routeResult.model,
            routeResult.route, routeResult.reason, routeResult.estimatedMicros != null ? formatMicros(routeResult.estimatedMicros, routeResult.currency) : '') : null))
    }

    function ProfilesPanel({ model, dispatch }) {
      const profiles = listOf(model.more.profiles, 'profiles', 'items')
      const assistant = globalAssistantOf(model.more.profiles)
      const draft = model.more.profileDraft ?? assistantDraftFromProfile(assistant)
      const busy = model.more.busy?.[`profile:${GLOBAL_ASSISTANT_ID}:save`] === true
      const field = (key, value) => dispatch({ type: 'updateAssistantDraft', patch: { [key]: value } })
      return h('div', null,
        h('form', { className: 'dsa-more-section dsa-more-form', 'aria-label': '全局助理编辑器', onSubmit: event => {
          event.preventDefault()
          if (busy || !String(draft.name ?? '').trim()) return
          return dispatch({ type: 'saveAssistantProfile' })
        } },
          h('h3', null, assistant ? '编辑全局助理' : '创建全局助理'),
          h('div', { className: 'dsa-more-meta' }, '角色：assistant（不可修改）', 'ID：global-assistant（保留且不可修改）', '记忆范围：global（固定）', '工作区范围：global（固定）'),
          h('label', { className: 'dsa-more-field' }, '名称', h('input', { className: 'dsa-answer-input', value: draft.name,
            maxLength: 120, 'aria-label': '全局助理名称', onChange: event => field('name', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '头像', h('input', { className: 'dsa-answer-input', value: draft.avatar,
            maxLength: 2048, placeholder: 'assistant 或图片地址', 'aria-label': '全局助理头像', onChange: event => field('avatar', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, 'Provider', h('input', { className: 'dsa-answer-input', value: draft.provider,
            maxLength: 200, placeholder: '使用默认路由', 'aria-label': '全局助理 Provider', onChange: event => field('provider', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '模型', h('input', { className: 'dsa-answer-input', value: draft.model,
            maxLength: 200, placeholder: '使用默认路由', 'aria-label': '全局助理模型', onChange: event => field('model', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '工具（逗号分隔）', h('input', { className: 'dsa-answer-input', value: draft.tools,
            'aria-label': '全局助理工具', onChange: event => field('tools', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '权限（逗号分隔）', h('input', { className: 'dsa-answer-input', value: draft.permissions,
            'aria-label': '全局助理权限', onChange: event => field('permissions', event.target.value) })),
          h('div', { className: 'dsa-more-meta' }, assistant
            ? `保存使用乐观修订 ${draft.expectedRevision ?? assistant.revision ?? '—'}；冲突时不会覆盖远端修改。`
            : '档案缺失时将创建唯一的 global-assistant，不会创建第二个助理。'),
          h('div', { className: 'dsa-more-actions' },
            h('button', { type: 'submit', className: 'dsa-chip', disabled: busy || !String(draft.name ?? '').trim() },
              busy ? '正在保存…' : assistant ? '保存全局助理' : '创建全局助理'),
            h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy,
              onClick: () => dispatch({ type: 'resetAssistantDraft' }) }, '重新加载'))),
        h('div', { className: 'dsa-more-meta' }, `${profiles.length} 个 Agent 档案`),
        profiles.length ? h('div', { className: 'dsa-more-list' }, profiles.map(profile =>
          h('div', { key: profile.id, className: 'dsa-more-row' },
            h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, profile.name ?? profile.id), h('span', { className: 'dsa-status' }, profile.enabled === false ? '已停用' : '已启用')),
            h('div', { className: 'dsa-more-meta' }, profile.role, profile.provider, profile.model, `记忆：${profile.memoryScope ?? '—'}`, `工作区：${profile.workspaceScope ?? '—'}`, `修订 ${profile.revision ?? 1}`),
            h('div', { className: 'dsa-more-meta' }, `工具：${listOf(profile.tools).join('、') || '无'}`, `权限：${listOf(profile.permissions).join('、') || '无'}`),
            h('button', {
              type: 'button', className: 'dsa-linkbtn', disabled: model.more.busy?.[`profile:${profile.id}`] === true,
              onClick: () => dispatch({ type: 'toggleProfile', id: profile.id, enabled: profile.enabled === false }),
            }, profile.enabled === false ? '启用档案' : '停用档案'))))
          : h('div', { className: 'dsa-workbench-empty' }, '暂无 Agent 档案'))
    }

    function DevicePanel({ model, dispatch }) {
      const [name, setName] = react.useState('')
      const [scopes, setScopes] = react.useState(['chat', 'tasks'])
      const [expires, setExpires] = react.useState('86400')
      const devices = listOf(model.more.devices, 'devices', 'items')
      const busy = model.more.busy?.device === true
      const pairing = model.more.pairing
      return h('div', null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '设备状态'),
          devices.length ? h('div', { className: 'dsa-more-list' }, devices.map(device =>
            h('div', { key: device.id, className: 'dsa-more-row' },
              h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, device.name ?? device.id), h('span', { className: 'dsa-status' }, device.status)),
              h('div', { className: 'dsa-more-meta' }, device.scopes?.join('、'), device.expiresAt ? `到期：${formatTime(device.expiresAt)}` : '', device.lastUsedAt ? `最近使用：${formatTime(device.lastUsedAt)}` : ''),
              device.status === 'active' ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy, onClick: () => dispatch({ type: 'revokeDevice', id: device.id }) }, '撤销设备') : null)))
            : h('div', { className: 'dsa-workbench-empty' }, '暂无配对设备')),
        h('form', { className: 'dsa-more-section dsa-more-form', onSubmit: event => {
          event.preventDefault()
          if (!name.trim() || !scopes.length || busy) return
          return dispatch({ type: 'pairDevice', name: name.trim(), scopes, expiresInSeconds: Number(expires) })
        } },
        h('h3', null, '创建设备配对'),
        h('label', { className: 'dsa-more-field' }, '设备名称', h('input', { className: 'dsa-answer-input', value: name, 'aria-label': '设备名称', maxLength: 80, onChange: event => setName(event.target.value) })),
        h('label', { className: 'dsa-more-field' }, '有效期（秒）', h('input', { className: 'dsa-answer-input', type: 'number', min: 1, max: 31536000, value: expires, 'aria-label': '设备有效期', onChange: event => setExpires(event.target.value) })),
        ['chat', 'tasks', 'inbox', 'artifacts', 'approval'].map(scope => h('label', { key: scope, className: 'dsa-more-check' }, h('input', {
          type: 'checkbox', checked: scopes.includes(scope), onChange: event => setScopes(current => event.target.checked ? [...new Set([...current, scope])] : current.filter(value => value !== scope)),
        }), scope)),
        h('button', { type: 'submit', className: 'dsa-chip', disabled: busy || !name.trim() || !scopes.length }, busy ? '正在创建…' : '创建设备配对')),
        pairing ? h('div', { className: 'dsa-more-error', role: 'status' },
          '配对凭据仅显示一次，请立即复制；关闭面板后不再保留。', h('pre', { className: 'dsa-more-code' }, pairing.token)) : null)
    }

    function PlanPreviewView({ model, preview, run, busy, onPreview, onClose, showButton = true,
      approval = null, handoff = null, routerSupported = false, onApproveRun = null }) {
      if (!run && !preview) return h('div', { className: 'dsa-workbench-empty' }, '当前或最近任务中没有可预览的子任务')
      const estimate = preview?.estimate ?? {}
      const cost = estimate.cost ?? {}
      const title = run?.title ?? run?.goal ?? run?.id ?? preview?.goal?.title ?? preview?.goal ?? '候选计划'
      const candidate = preview?.kind === 'candidate-plan-preview'
      const blocked = candidatePlanBlocked(preview)
      const missingInput = candidate && (!preview?.inputSnapshot || !Array.isArray(preview.inputSnapshot.subtasks)
        || !preview.inputSnapshot.subtasks.length || preview.inputSnapshot.goal == null
        || preview.inputSnapshot.project == null || !preview.inputSnapshot.permissionScope || !preview.inputSnapshot.runtime)
      return h('section', { className: 'dsa-more-section dsa-more-form', 'aria-label': '计划预览' },
        h('div', { className: 'dsa-more-row-head' }, h('h3', null, title), preview ? h('span', { className: 'dsa-status' }, preview.status) : null),
        h('div', { className: 'dsa-more-meta' }, `${listOf(run?.subtasks).length || listOf(preview?.dag?.tasks).length} 个子任务`, preview?.sideEffects === 'none' ? '无副作用' : '', preview?.executionStarted === false ? '未开始执行' : ''),
        showButton ? h('button', { type: 'button', className: 'dsa-chip', disabled: busy, onClick: onPreview }, busy ? '正在预览…' : preview ? '刷新计划预览' : '预览计划') : null,
        onClose && preview ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: onClose }, '收起预览') : null,
        candidate ? h('div', { className: 'dsa-more-section' },
          h('div', { className: 'dsa-more-meta' }, preview.planDigest ? `计划摘要：${preview.planDigest}` : '预览缺少计划摘要，不能运行'),
          blocked ? h('div', { className: 'dsa-more-error', role: 'alert' }, '阻塞计划不能运行，请先修正上方问题并重新预览。') : null,
          missingInput ? h('div', { className: 'dsa-more-error', role: 'alert' }, '候选预览缺少 goal、project、subtasks、permissionScope 或 runtime，不能绑定运行。') : null,
          !routerSupported && !blocked && !missingInput ? h('div', { className: 'dsa-more-meta' },
            '当前 Router 未声明 candidate-plan-v1 计划执行支持；批准后不会发送普通消息或启动无绑定任务。') : null,
          h('button', { type: 'button', className: 'dsa-chip', disabled: busy || blocked || missingInput || !onApproveRun || handoff?.state === 'submitted',
            onClick: onApproveRun }, busy ? '正在处理批准与运行…' : handoff?.state === 'submitted' ? '已提交 Router'
              : approval ? '运行已批准计划' : '批准并运行'),
          handoff?.state === 'awaiting-router' ? h('div', { className: 'dsa-more-error', role: 'status' },
            '计划已批准，但 Router 尚未确认候选计划执行合约；未发送任务，避免无绑定执行。') : null,
          handoff?.state === 'submitted' ? h('div', { className: 'dsa-more-meta', role: 'status' },
            `Router 已确认计划摘要 ${handoff.planDigest}，请求 ${handoff.requestId}。`) : null) : null,
        preview ? h('div', null,
          h('div', { className: 'dsa-more-statgrid' },
            h('div', { className: 'dsa-more-stat' }, h('strong', null, estimate.modelCalls ?? 0), h('span', null, '模型调用')),
            h('div', { className: 'dsa-more-stat' }, h('strong', null, estimate.tokens?.total ?? 0), h('span', null, '预计 Tokens')),
            h('div', { className: 'dsa-more-stat' }, h('strong', null, formatMicros(cost.totalMicros, cost.currency)), h('span', null, '预计成本')),
            h('div', { className: 'dsa-more-stat' }, h('strong', null, cost.complete === false ? '未定价' : '已定价'), h('span', null, '成本状态'))),
          listOf(cost.unpriced).length ? h('div', { className: 'dsa-more-error' }, `未定价模型：${cost.unpriced.join('、')}`) : null,
          listOf(preview.issues).length ? h('div', { className: 'dsa-more-list' }, preview.issues.map((issue, index) =>
            h('div', { key: `${issue.code}:${index}`, className: 'dsa-more-row dsa-plan-issue', 'data-severity': issue.severity },
              h('span', { className: 'dsa-more-row-title' }, issue.severity === 'block' ? `阻塞：${issue.message}` : `警告：${issue.message}`),
              h('span', { className: 'dsa-more-meta' }, issue.code, issue.taskId, issue.model, issue.path))))
            : h('div', { className: 'dsa-workbench-empty' }, '没有阻塞或警告'),
          preview.permissionScope ? h('details', { className: 'dsa-more-section' },
            h('summary', null, '权限范围'),
            h('pre', { className: 'dsa-more-code' }, JSON.stringify(preview.permissionScope, null, 2))) : null,
          preview.runtime ? h('details', { className: 'dsa-more-section' },
            h('summary', null, '运行环境'),
            h('pre', { className: 'dsa-more-code' }, JSON.stringify(preview.runtime, null, 2))) : null,
          listOf(preview.dag?.tasks).length ? h('details', { className: 'dsa-more-section' },
            h('summary', null, '执行顺序与依赖'), h('div', { className: 'dsa-more-list' }, preview.dag.tasks.map(task =>
              h('div', { key: task.id, className: 'dsa-more-row' }, h('span', { className: 'dsa-more-row-title' }, task.title ?? task.id), h('span', { className: 'dsa-more-meta' }, task.model, task.dependsOn?.length ? `依赖：${task.dependsOn.join('、')}` : '无依赖'))))) : null) : null)
    }

    function PlanPreviewPanel({ model, dispatch }) {
      const run = model.detail?.id === model.more.planRunId ? model.detail : latestRun(model)
      const draft = model.more.planDraft ?? { goal: '', tasks: '', allow: 'read, write', deny: 'shell.execute, network', isolation: 'workspace', budget: '' }
      const field = (key, value) => dispatch({ type: 'updatePlanDraft', patch: { [key]: value } })
      const project = model.project?.cwd ?? run?.workspace?.base ?? run?.goalMode?.cwd
        ?? model.workbench?.projects?.[0]?.cwd ?? taskWorkspace(model, run ?? {}).cwd
      const submit = event => {
        event.preventDefault()
        const subtasks = draft.tasks.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
          const separator = line.search(/[|：:]/)
          return separator > 0
            ? { id: `candidate-${index + 1}`, title: line.slice(0, separator).trim(), prompt: line.slice(separator + 1).trim(), capabilities: ['analysis'] }
            : { id: `candidate-${index + 1}`, title: line.slice(0, 80), prompt: line, capabilities: ['analysis'] }
        })
        return dispatch({ type: 'previewCandidatePlan', goal: draft.goal.trim(), ...(project ? { project } : {}), subtasks,
          capabilities: ['analysis'], ...(run?.model ? { model: run.model } : {}),
          permissionScope: { tools: draft.allow.split(',').map(value => value.trim()).filter(Boolean),
            allow: draft.allow.split(',').map(value => value.trim()).filter(Boolean),
            deny: draft.deny.split(',').map(value => value.trim()).filter(Boolean), approvalMode: 'policy' },
          runtime: { cwd: project, isolation: draft.isolation, provider: 'local', mode: 'execute', platform: 'host', shell: 'host' },
          ...(draft.budget ? { budget: { maxTokens: Number(draft.budget) } } : {}) })
      }
      return h('div', null,
        h('form', { className: 'dsa-more-section dsa-more-form', onSubmit: submit },
          h('h3', null, '执行前候选计划'),
          h('label', { className: 'dsa-more-field' }, '目标', h('textarea', { className: 'dsa-answer-input', value: draft.goal,
            'aria-label': '候选计划目标', onChange: event => field('goal', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '子任务（每行一个）', h('textarea', { className: 'dsa-answer-input', value: draft.tasks,
            placeholder: '起草：写报告\n复核：检查证据', 'aria-label': '候选计划子任务', onChange: event => field('tasks', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '允许工具', h('input', { className: 'dsa-answer-input', value: draft.allow,
            'aria-label': '候选计划允许工具', onChange: event => field('allow', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '拒绝工具', h('input', { className: 'dsa-answer-input', value: draft.deny,
            'aria-label': '候选计划拒绝工具', onChange: event => field('deny', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '隔离方式', h('input', { className: 'dsa-answer-input', value: draft.isolation,
            'aria-label': '候选计划隔离方式', onChange: event => field('isolation', event.target.value) })),
          h('label', { className: 'dsa-more-field' }, '最大 Tokens', h('input', { className: 'dsa-answer-input', type: 'number', min: 1, value: draft.budget,
            'aria-label': '候选计划最大 Tokens', onChange: event => field('budget', event.target.value) })),
          h('div', { className: 'dsa-more-meta' }, `工作区：${project ?? '未选择'}`, '预览不启动任务、不写运行状态。'),
          h('button', { type: 'submit', className: 'dsa-chip', disabled: model.more.planBusy || !draft.goal.trim() || !draft.tasks.trim() }, model.more.planBusy ? '正在预览…' : '预览候选计划')),
        h(PlanPreviewView, { model, run, preview: model.more.planPreview, busy: model.more.planBusy,
          approval: model.more.planApproval, handoff: model.more.planHandoff,
          routerSupported: model.routerPlanExecution === CANDIDATE_PLAN_ROUTER_VERSION,
          onApproveRun: () => dispatch({ type: 'approveAndRunCandidatePlan' }),
          onPreview: run ? () => dispatch({ type: 'previewPlan', runId: run.id }) : null,
          onClose: () => dispatch({ type: 'clearPlanPreview' }) }))
    }

    function CollectionPanel({ model, dispatch, panel }) {
      const data = model.more[panel]
      const labels = { notifications: '通知', capabilities: '能力', memory: '记忆', runtime: '运行时记录',
        evidence: '证据', cost: '成本', profiles: 'Agent 档案', devices: '设备', plan: '计划' }
      const items = listOf(data, 'items', 'entries', 'records')
      return h('div', null, items.length ? h('div', { className: 'dsa-more-list' }, items.map((item, index) =>
        h('div', { key: item.id ?? index, className: 'dsa-more-row' },
          h('span', { className: 'dsa-more-row-title' }, item.name ?? item.title ?? item.id ?? `${labels[panel] ?? '记录'} ${index + 1}`),
          h('div', { className: 'dsa-detail-label' }, item.description ?? item.body ?? ''),
          h('div', { className: 'dsa-more-meta' }, item.status, item.version))))
        : h('div', { className: 'dsa-workbench-empty' }, `暂无${labels[panel] ?? '记录'}`))
    }

    function AutomationsPanel({ model, dispatch }) {
      const more = model.more
      const rules = listOf(more.automations, 'rules', 'items')
      const draft = more.automationDraft ?? automationDraftFromRule(null)
      const editing = rules.find(rule => rule.id === more.automationEditId) ?? null
      const busy = more.busy ?? {}
      const field = (key, value) => dispatch({ type: 'updateAutomationDraft', patch: { [key]: value } })
      const toggleEvent = (event, checked) => field('events', checked
        ? [...new Set([...(draft.events ?? []), event])] : (draft.events ?? []).filter(value => value !== event))
      const edit = rule => dispatch({ type: 'editAutomation', rule })
      const fresh = () => dispatch({ type: 'newAutomation' })
      const preview = more.automationPreview
      const history = more.automationExecutions
      const triggerRows = listOf(preview?.triggerTimes).map((at, index) => h('div', { key: String(index), className: 'dsa-more-row' }, formatTime(at)))
      const errorRows = listOf(preview?.errors).map((error, index) => h('div', { key: String(index) }, [error.path || 'rule', error.message].join('：')))
      const warningRows = listOf(preview?.warnings).map((warning, index) => h('div', { key: String(index), className: 'dsa-more-row' }, warning))
      const historyRows = listOf(history?.items).map(execution => h('div', { key: execution.id, className: 'dsa-more-row' },
        h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, execution.action?.prompt ?? execution.id), h('span', { className: 'dsa-more-status' }, execution.status)),
        h('div', { className: 'dsa-more-meta' }, execution.id, `规则修订 ${execution.ruleRevision}`, formatTime(execution.recordedAt ?? execution.startedAt), `模型调用 ${execution.usage?.modelCalls ?? 0}`, `Tokens ${execution.usage?.tokens ?? 0}`),
        execution.error ? h('div', { className: 'dsa-more-error' }, String(execution.error.message ?? execution.error)) : null))
      return h('div', null,
        h('section', { className: 'dsa-more-section dsa-more-editor', 'aria-label': '自动化规则编辑器' },
          h('div', { className: 'dsa-more-row-head' },
            h('h3', null, editing ? `编辑规则 · 修订 ${editing.revision}` : '新建自动化规则'),
            h('button', { type: 'button', className: 'dsa-linkbtn', onClick: fresh }, '新建')),
          h('label', { className: 'dsa-more-field' }, '规则名称', h('input', {
            className: 'dsa-answer-input', value: draft.name, maxLength: 120, 'aria-label': '规则名称', onChange: event => field('name', event.target.value),
          })),
          h('label', { className: 'dsa-more-field' }, '触发类型', h('select', {
            className: 'dsa-answer-input', value: draft.triggerType, 'aria-label': '触发类型', onChange: event => field('triggerType', event.target.value),
          }, h('option', { value: 'cron' }, 'Cron'), h('option', { value: 'every' }, '周期'), h('option', { value: 'source' }, '来源事件'))),
          draft.triggerType === 'cron' ? h(ReactFragment, null,
            h('label', { className: 'dsa-more-field' }, 'Cron 表达式', h('input', {
              className: 'dsa-answer-input', value: draft.cron, 'aria-label': 'Cron 表达式', onChange: event => field('cron', event.target.value),
            })),
            h('label', { className: 'dsa-more-field' }, '时区', h('input', {
              className: 'dsa-answer-input', value: draft.timeZone, 'aria-label': '规则时区', onChange: event => field('timeZone', event.target.value),
            }))) : null,
          draft.triggerType === 'every' ? h('label', { className: 'dsa-more-field' }, '周期（毫秒）', h('input', {
            className: 'dsa-answer-input', type: 'number', min: 60000, step: 60000, value: draft.everyMs, 'aria-label': '周期毫秒',
            onChange: event => field('everyMs', event.target.value),
          })) : null,
          draft.triggerType === 'source' ? h(ReactFragment, null,
            h('label', { className: 'dsa-more-field' }, '来源', h('input', {
              className: 'dsa-answer-input', value: draft.source, 'aria-label': '触发来源', onChange: event => field('source', event.target.value),
            })),
            h('label', { className: 'dsa-more-field' }, '事件类型（逗号分隔）', h('input', {
              className: 'dsa-answer-input', value: draft.eventTypes, 'aria-label': '来源事件类型', onChange: event => field('eventTypes', event.target.value),
            }))) : null,
          h('label', { className: 'dsa-more-field' }, '执行 Prompt', h('textarea', {
            className: 'dsa-answer-input', value: draft.prompt, maxLength: 8000, 'aria-label': '自动化 Prompt', onChange: event => field('prompt', event.target.value),
          })),
          h('label', { className: 'dsa-more-field' }, '产物相对路径', h('input', {
            className: 'dsa-answer-input', value: draft.relativePath, 'aria-label': '产物相对路径', onChange: event => field('relativePath', event.target.value),
          })),
          h('div', { className: 'dsa-more-meta' }, '通知事件'),
          AUTOMATION_EVENTS.map(event => h('label', { key: event, className: 'dsa-more-check' }, h('input', {
            type: 'checkbox', checked: (draft.events ?? []).includes(event), onChange: change => toggleEvent(event, change.target.checked),
          }), event)),
          [['maxRuns', '最大运行次数'], ['maxModelCalls', '最大模型调用'], ['maxTokens', '最大 Tokens'], ['maxCost', '最大成本（微单位）']].map(([key, label]) =>
            h('label', { key, className: 'dsa-more-field' }, label, h('input', {
              className: 'dsa-answer-input', type: 'number', min: 1, step: 1, value: draft[key], 'aria-label': label,
              onChange: event => field(key, event.target.value),
            }))),
          h('div', { className: 'dsa-more-meta' }, '预览不执行任务、不写入文件；保存后规则默认停用。'),
          h('div', { className: 'dsa-more-actions' },
            h('button', {
              type: 'button', className: 'dsa-chip', disabled: busy['automation-preview'] === true,
              onClick: () => dispatch({ type: 'previewAutomation', rule: automationRuleFromDraft(draft) }),
            }, busy['automation-preview'] ? '正在预览…' : '预览规则'),
            h(ActionButton, { model, dispatch,
              confirmKey: `automation:${editing?.id ?? 'new'}:save`, label: editing ? '保存规则' : '创建规则', confirmLabel: editing ? '确认保存' : '确认创建',
              detail: editing ? `将按修订 ${editing.revision} 保存并创建新修订。` : '确认创建这条停用的自动化规则？',
              disabled: !draft.name.trim() || !draft.prompt.trim() || !draft.relativePath.trim(),
              busy: busy[`automation:${editing?.id ?? 'new'}:save`] === true,
              onConfirm: () => dispatch({ type: 'saveAutomation', rule: automationRuleFromDraft(draft),
                id: editing?.id ?? null, expectedRevision: editing?.revision ?? null }),
            }))),
        preview ? h('section', { className: 'dsa-more-section', 'aria-label': '自动化预览' },
          h('h3', null, '规则预览'),
          h('div', { className: 'dsa-more-meta' }, `有效性：${preview.valid ? 'valid' : 'invalid'}`, `副作用：${preview.sideEffects ?? 'none'}`, `已开始执行：${preview.executionStarted === false ? '否' : '否'}`),
          h('div', { className: 'dsa-more-meta' }, '未来触发'),
          triggerRows.length ? h('div', { className: 'dsa-more-list' }, triggerRows) : h('div', { className: 'dsa-workbench-empty' }, preview.valid ? '来源触发暂无未来时间，等待匹配事件' : '修复规则后查看未来触发'),
          errorRows.length ? h('div', { className: 'dsa-more-error', role: 'alert' }, errorRows) : null,
          h('div', { className: 'dsa-more-meta' }, '警告 ' + String(warningRows.length) + ' 条'),
          warningRows.length ? h('div', { className: 'dsa-more-list' }, warningRows) : null) : null,
        more.automationActionResult ? h('section', { className: 'dsa-more-section' },
          h('h3', null, '最近操作结果'), h('pre', { className: 'dsa-more-code' }, JSON.stringify(more.automationActionResult, null, 2))) : null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, `自动化规则（${rules.length}）`),
          rules.length ? h('div', { className: 'dsa-more-list' }, rules.map(rule => {
            const key = action => `automation:${rule.id}:${action}`
            return h('article', { key: rule.id, className: 'dsa-more-row', 'data-enabled': String(rule.enabled === true) },
              h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, rule.name), h('span', { className: 'dsa-more-status' }, rule.enabled ? '已启用' : '已停用')),
              h('div', { className: 'dsa-detail-label' }, rule.description || rule.action?.prompt),
              h('div', { className: 'dsa-more-meta' }, automationTriggerLabel(rule), `修订 ${rule.revision}`, rule.output?.relativePath, `通知：${(rule.notify?.events ?? []).join('、') || '无'}`),
              h('div', { className: 'dsa-more-rowactions' },
                h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => edit(rule) }, '编辑'),
                h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy[key('executions')], onClick: () => dispatch({ type: 'loadAutomationExecutions', id: rule.id }) }, busy[key('executions')] ? '正在读取…' : '执行历史'),
                h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy['automation-preview'], onClick: () => dispatch({ type: 'previewAutomation', rule }) }, '预览'),
                h(ActionButton, { model, dispatch,
                  confirmKey: key('toggle'), label: rule.enabled ? '停用' : '启用', confirmLabel: rule.enabled ? '确认停用' : '确认启用', busy: busy[key('toggle')],
                  detail: rule.enabled ? '停用后不再定时触发。' : '启用会注册宿主调度；来源规则等待事件。',
                  onConfirm: () => dispatch({ type: 'automationAction', action: 'toggle', id: rule.id, expectedRevision: rule.revision, enabled: !rule.enabled }),
                }),
                h(ActionButton, { model, dispatch,
                  confirmKey: key('run-now'), label: '立即运行', confirmLabel: '确认运行', busy: busy[key('run-now')], disabled: rule.enabled === false,
                  detail: '立即运行会提交真实任务；重复请求使用同一幂等键。',
                  onConfirm: () => dispatch({ type: 'automationAction', action: 'run-now', id: rule.id }),
                }),
                h(ActionButton, { model, dispatch,
                  confirmKey: key('remove'), label: '删除', confirmLabel: '确认删除', busy: busy[key('remove')], detail: `删除规则及修订 ${rule.revision}？此操作不可撤销。`,
                  onConfirm: () => dispatch({ type: 'automationAction', action: 'remove', id: rule.id, expectedRevision: rule.revision }),
                })))
          })) : h('div', { className: 'dsa-workbench-empty' }, '暂无自动化规则')),
        history?.ruleId ? h('section', { className: 'dsa-more-section', 'aria-label': '自动化执行历史' },
          h('div', { className: 'dsa-more-row-head' }, h('h3', null, `执行历史 · ${rules.find(rule => rule.id === history.ruleId)?.name ?? history.ruleId}`),
            h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => dispatch({ type: 'clearAutomationExecutions' }) }, '收起')),
          historyRows.length ? h('div', { className: 'dsa-more-list' }, historyRows)
            : h('div', { className: 'dsa-workbench-empty' }, '暂无执行记录')) : null)
    }

    function SharesPanel({ model, dispatch }) {
      const more = model.more
      const shares = listOf(more.shares, 'shares', 'items')
      const artifacts = availableArtifacts(model)
      const draft = more.shareDraft ?? { artifactId: '', role: 'viewer', ttlMs: 604800000 }
      const result = more.lastShare
      const share = result?.share ?? result ?? {}
      return h('div', null,
        h('section', { className: 'dsa-more-section dsa-more-editor', 'aria-label': '创建分享' },
          h('h3', null, '分享当前产物'),
          artifacts.length ? h('label', { className: 'dsa-more-field' }, '当前产物', h('select', {
            className: 'dsa-answer-input', value: draft.artifactId, 'aria-label': '分享产物',
            onChange: event => dispatch({ type: 'updateShareDraft', patch: { artifactId: event.target.value } }),
          }, h('option', { value: '' }, '请选择产物'), artifacts.map(item =>
            h('option', { key: item.shareId, value: item.shareId }, `${item.name ?? item.path ?? item.href ?? item.shareId} · ${item.shareId}`))))
            : h('div', { className: 'dsa-workbench-empty' }, '当前没有可分享的产物，请先打开一个产物。'),
          h('label', { className: 'dsa-more-field' }, '分享权限', h('select', {
            className: 'dsa-answer-input', value: draft.role, 'aria-label': '分享权限',
            onChange: event => dispatch({ type: 'updateShareDraft', patch: { role: event.target.value } }),
          }, h('option', { value: 'viewer' }, '只读'), h('option', { value: 'commenter' }, '只读并允许评论'))),
          h('label', { className: 'dsa-more-field' }, '有效期（毫秒）', h('input', {
            className: 'dsa-answer-input', type: 'number', min: 1, value: draft.ttlMs, 'aria-label': '分享有效期毫秒',
            onChange: event => dispatch({ type: 'updateShareDraft', patch: { ttlMs: Number(event.target.value) } }),
          })),
          h('div', { className: 'dsa-more-meta' }, '令牌仅显示一次；持有者可在有效期内读取明确选中的产物。'),
          h(ActionButton, { model, dispatch,
            confirmKey: `share:create:${draft.artifactId}`, label: '创建分享', confirmLabel: '确认创建', busy: more.shareBusy === true, disabled: !draft.artifactId,
            detail: `确认分享 ${draft.artifactId || '所选产物'}？`, onConfirm: () => dispatch({ type: 'shareArtifact', ...draft }),
          })),
        result ? h('section', { className: 'dsa-more-section', 'aria-label': '分享结果' },
          h('h3', null, '分享已创建'),
          h('div', { className: 'dsa-more-meta' }, share.id, share.role, share.expiresAt ? `到期：${formatTime(share.expiresAt)}` : ''),
          h('div', { className: 'dsa-more-field' }, 'Token', h('pre', { className: 'dsa-more-code dsa-more-token' }, result.token ?? share.token ?? '仅创建时显示')),
          h('div', { className: 'dsa-more-field' }, 'URL', h('pre', { className: 'dsa-more-code dsa-more-token' }, shareUrlOf(result))),
          h('div', { className: 'dsa-more-meta' }, '请立即复制；关闭或刷新后令牌无法再次读取。')) : null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, `分享列表（${shares.length}）`),
          shares.length ? h('div', { className: 'dsa-more-list' }, shares.map(item =>
            h('article', { key: item.id, className: 'dsa-more-row', 'data-enabled': String(item.revokedAt === null) },
              h('div', { className: 'dsa-more-row-head' }, h('span', { className: 'dsa-more-row-title' }, item.artifactIds?.join('、') ?? item.id), h('span', { className: 'dsa-more-status' }, item.revokedAt ? '已撤销' : '有效')),
              h('div', { className: 'dsa-more-meta' }, item.role, item.expiresAt ? `到期：${formatTime(item.expiresAt)}` : '', item.revokedAt ? `撤销：${formatTime(item.revokedAt)}` : ''),
              item.revokedAt ? null : h(ActionButton, { model, dispatch,
                confirmKey: `share:${item.id}:remove`, label: '撤销分享', confirmLabel: '确认撤销', busy: more.busy?.[`share:${item.id}:remove`] === true,
                detail: '撤销后现有令牌立即失效。', onConfirm: () => dispatch({ type: 'removeShare', id: item.id }),
              }))))
            : h('div', { className: 'dsa-workbench-empty' }, '暂无分享')))
    }

    function MarketPanel({ model, dispatch }) {
      const more = model.more
      const data = more.market ?? {}
      const items = listOf(data, 'items', 'entries')
      const query = more.marketQuery ?? ''
      const sourceDirectory = more.marketImport?.sourceDirectory ?? ''
      const enabled = more.marketImport?.enabled === true
      const detail = more.marketDetail
      const handoff = more.marketHandoff
      const imported = more.marketImport
      const busy = more.busy ?? {}
      return h('div', null,
        h('form', { className: 'dsa-more-section dsa-more-form', onSubmit: event => {
          event.preventDefault()
          return dispatch({ type: 'searchMarket', query: query.trim() })
        } },
        h('h3', null, '搜索市场'),
        h('div', { className: 'dsa-more-actions' },
          h('input', { type: 'search', className: 'dsa-answer-input', value: query, maxLength: 200, 'aria-label': '搜索市场', placeholder: '插件或 Skill 名称', onChange: event => dispatch({ type: 'updateMarketQuery', query: event.target.value }) }),
          h('button', { type: 'submit', className: 'dsa-chip', disabled: busy.market === true }, busy.market ? '正在搜索…' : '搜索')),
        h('div', { className: 'dsa-more-meta' }, `注册表：${data.registry ?? '—'}`, '仅展示签名与宿主版本已验证的项目')),
        detail ? h('section', { className: 'dsa-more-section', 'aria-label': '市场详情' },
          h('div', { className: 'dsa-more-row-head' }, h('h3', null, detail.displayName ?? detail.name), h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => dispatch({ type: 'clearMarketDetail' }) }, '返回列表')),
          h('div', { className: 'dsa-detail-label' }, detail.description),
          h('div', { className: 'dsa-more-meta' }, detail.kind, detail.version, `签名：${detail.signature?.verified ? '已验证' : '未验证'}`, `Node：${detail.engines?.node ?? '—'}`, `DSH：${detail.engines?.dsh ?? '—'}`),
          h('div', { className: 'dsa-more-meta' }, `commit：${detail.commit ?? '—'}`, `sha256：${detail.sha256 ?? '—'}`),
          h('div', { className: 'dsa-more-meta' }, detail.disabledReason ?? ''),
          h(ActionButton, { model, dispatch,
            confirmKey: `market:${detail.name}:install-handoff`, label: '生成安装交接', confirmLabel: '确认生成', busy: busy['market:install-handoff'] === true,
            detail: '只生成安装交接与命令，不下载、不安装、不执行。',
            onConfirm: () => dispatch({ type: 'marketHandoff', item: detail, enabled: true }),
          })) : null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, `市场项目（${items.length}）`),
          items.length ? h('div', { className: 'dsa-more-list' }, items.map(item =>
            h('button', { key: `${item.kind}:${item.name}:${item.version}`, type: 'button', className: 'dsa-more-row', onClick: () => dispatch({ type: 'marketDetail', item }) },
              h('span', { className: 'dsa-more-row-title' }, item.displayName ?? item.name),
              h('span', { className: 'dsa-detail-label' }, item.description),
              h('span', { className: 'dsa-more-meta' }, item.kind, item.version, item.signature?.verified ? '签名已验证' : '签名未验证'))))
            : h('div', { className: 'dsa-workbench-empty' }, query ? '没有匹配的市场项目' : '暂无市场项目')),
        h('section', { className: 'dsa-more-section dsa-more-editor', 'aria-label': '本地 Skill 导入' },
          h('h3', null, '导入本地 Skill'),
          h('label', { className: 'dsa-more-field' }, '本地绝对路径', h('input', {
            className: 'dsa-answer-input', value: sourceDirectory, 'aria-label': '本地 Skill 绝对路径', placeholder: 'D:\\path\\to\\skill',
            onChange: event => dispatch({ type: 'updateMarketImport', patch: { sourceDirectory: event.target.value } }),
          })),
          h('label', { className: 'dsa-more-check' }, h('input', { type: 'checkbox', checked: enabled, onChange: event => dispatch({ type: 'updateMarketImport', patch: { enabled: event.target.checked } }) }), '导入后启用（仍不会自动执行）'),
          h('div', { className: 'dsa-more-meta' }, '仅复制文档与惰性资源；拒绝脚本、符号链接和路径穿越，不覆盖已有 Skill。'),
          h(ActionButton, { model, dispatch,
            confirmKey: 'market:import', label: '导入 Skill', confirmLabel: '确认导入', busy: busy['market:import'] === true, disabled: !sourceDirectory.trim(),
            detail: `确认从 ${sourceDirectory || '所选目录'} 导入？`, onConfirm: () => dispatch({ type: 'importMarketSkill', sourceDirectory: sourceDirectory.trim(), enabled }),
          })),
        imported ? h('section', { className: 'dsa-more-section', 'aria-label': 'Skill 导入结果' },
          h('h3', null, `已导入：${imported.name}`), h('div', { className: 'dsa-detail-label' }, imported.description),
          h('div', { className: 'dsa-more-meta' }, imported.status, imported.enabled ? '已启用' : '已停用', imported.execution ?? 'never-automatic', imported.directory),
          h('div', { className: 'dsa-more-meta' }, `文件：${listOf(imported.files).length}`, `字节：${imported.totalBytes ?? 0}`)) : null,
        handoff ? h('section', { className: 'dsa-more-section', 'aria-label': '安装交接' },
          h('h3', null, '安装交接（未执行）'),
          h('div', { className: 'dsa-more-meta' }, handoff.status, handoff.code, `installed: ${handoff.installed === true ? '是' : '否'}`, `executed: ${handoff.executed === true ? '是' : '否'}`),
          h('div', { className: 'dsa-more-field' }, '宿主安装命令', h('pre', { className: 'dsa-more-code dsa-more-token' }, marketInstallCommand(handoff))),
          h('div', { className: 'dsa-more-error' }, handoff.message ?? '宿主尚未提供安装 API；没有下载、安装或执行任何内容。'),
          h('pre', { className: 'dsa-more-code' }, JSON.stringify(handoff.handoff ?? handoff, null, 2))) : null)
    }

    function CloudWorkerPanel({ model, dispatch }) {
      const more = model.more
      const data = more.cloudWorker ?? {}
      const draft = more.cloudDraft ?? cloudDraftFromModel(model)
      const busy = more.busy ?? {}
      const field = (key, value) => dispatch({ type: 'updateCloudWorkerDraft', patch: { [key]: value } })
      const workers = listOf(more.cloudWorker, 'jobs', 'workers')
      const result = more.cloudActionResult
      const workerRows = workers.map(worker => {
        const key = action => `cloud-worker:${worker.workerId}:${action}`
        return h('article', { key: worker.workerId, className: 'dsa-more-row' },
          h('div', { className: 'dsa-more-row-head' },
            h('span', { className: 'dsa-more-row-title' }, worker.workerId),
            h('span', { className: 'dsa-more-status' }, worker.state ?? worker.status ?? 'submitted')),
          h('div', { className: 'dsa-more-meta' }, worker.runId, worker.subtaskId,
            worker.submittedAt ? formatTime(worker.submittedAt) : ''),
          h('div', { className: 'dsa-more-rowactions' },
            h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy[key('snapshot')],
              onClick: () => dispatch({ type: 'cloudWorkerAction', action: 'snapshot', workerId: worker.workerId }) },
            busy[key('snapshot')] ? '正在查询…' : '刷新快照'),
            h(ActionButton, { model, dispatch,
              confirmKey: key('cancel'), label: '取消 Worker', confirmLabel: '确认取消', busy: busy[key('cancel')],
              disabled: ['succeeded', 'failed', 'stopped', 'timed_out'].includes(worker.state),
              detail: '取消是异步请求，不代表远端已经停止。',
              onConfirm: () => dispatch({ type: 'cloudWorkerAction', action: 'cancel', workerId: worker.workerId, idempotencyKey: `cancel:${worker.workerId}` }),
            }),
            h(ActionButton, { model, dispatch,
              confirmKey: key('finalize'), label: '完成产物', confirmLabel: '确认完成', busy: busy[key('finalize')],
              disabled: worker.state !== 'succeeded',
              detail: '校验远端产物清单的大小与 SHA-256 后完成交付。',
              onConfirm: () => dispatch({ type: 'cloudWorkerAction', action: 'finalize', workerId: worker.workerId, idempotencyKey: `finalize:${worker.workerId}` }),
            })))
      })
      const manifestRows = listOf(result?.manifest?.entries).map(entry => h('div', { key: entry.path, className: 'dsa-more-row' },
        h('span', { className: 'dsa-more-row-title' }, entry.path),
        h('span', { className: 'dsa-more-meta' }, `${entry.size} bytes`, entry.sha256)))
      const fields = [
        ['runId', '运行 ID', 'text'], ['subtaskId', '子任务 ID', 'text'], ['attempt', '尝试次数', 'number'],
        ['repoSnapshot', '仓库快照引用', 'text'], ['prompt', '任务 Prompt', 'textarea'], ['modelProvider', '模型提供方', 'text'],
        ['modelRef', '模型引用', 'text'], ['toolAllow', '允许工具（逗号分隔）', 'text'], ['checkpointRef', '检查点引用', 'text'],
        ['maxTokens', '最大 Tokens', 'number'], ['maxCostUsd', '最大成本（USD）', 'number'],
        ['maxWallSeconds', '最长墙钟秒数', 'number'], ['maxToolCalls', '最大工具调用', 'number'],
        ['deadline', '截止时间', 'datetime-local'], ['idempotencyKey', '幂等键（可选）', 'text'],
      ]
      return h('div', null,
        h('section', { className: 'dsa-more-section' },
          h('h3', null, '云端 Worker 状态'),
          h('div', { className: 'dsa-more-meta' }, data.available === false ? '服务不可用' : '服务可用',
            `提供方：${data.provider ?? '—'}`, `模型：${data.model ?? '—'}`, `活跃任务：${data.active ?? 0}`),
          h('div', { className: 'dsa-more-meta' }, data.endpoint ?? '端点未配置'),
          h('div', { className: 'dsa-more-meta' }, `协议：${data.capabilities?.protocol ?? '—'}`,
            `取消：${data.capabilities?.cancellation ?? '—'}`, `产物：${data.capabilities?.artifactDigest ?? '—'}`),
          h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy['cloud-worker:status'],
            onClick: () => dispatch({ type: 'refreshCloudWorker' }) }, busy['cloud-worker:status'] ? '正在刷新…' : '刷新状态')),
        h('section', { className: 'dsa-more-section dsa-more-editor', 'aria-label': '提交云端任务' },
          h('h3', null, '提交当前任务'),
          h('div', { className: 'dsa-more-meta' }, model.detail?.id
            ? `当前任务：${model.detail.goal ?? model.detail.title ?? model.detail.id}` : '未打开任务时使用最近一次运行'),
          fields.map(([key, label, type]) => h('label', { key, className: 'dsa-more-field' }, label,
            h(type === 'textarea' ? 'textarea' : 'input', {
              className: 'dsa-answer-input', type: type === 'textarea' ? undefined : type, value: draft[key] ?? '', 'aria-label': label,
              min: type === 'number' ? 0 : undefined, onChange: event => field(key, event.target.value),
            }))),
          h('label', { className: 'dsa-more-field' }, '审批模式', h('select', {
            className: 'dsa-answer-input', value: draft.approvalMode, 'aria-label': '云端审批模式',
            onChange: event => field('approvalMode', event.target.value),
          }, h('option', { value: 'manual' }, '人工审批'), h('option', { value: 'policy' }, '策略审批'),
            h('option', { value: 'never' }, '无需审批'))),
          h('div', { className: 'dsa-more-meta' }, '凭据只能由服务端持有；此处不接收令牌。相同运行、子任务、尝试与幂等键不会重复提交。'),
          h(ActionButton, { model, dispatch,
            confirmKey: 'cloud-worker:submit', label: '提交云端任务', confirmLabel: '确认提交',
            busy: busy['cloud-worker:submit'] === true,
            disabled: data.available === false || !draft.runId || !draft.subtaskId || !draft.prompt?.trim(),
            detail: '确认把当前工作规格提交到远端 Worker？',
            onConfirm: () => dispatch({ type: 'submitCloudWorker', workSpec: cloudWorkSpecFromDraft(model, draft),
              idempotencyKey: draft.idempotencyKey.trim() || undefined }),
          })),
        h('section', { className: 'dsa-more-section' },
          h('h3', null, `Worker 列表（${workers.length}）`),
          h('div', { className: 'dsa-more-meta' }, '服务端持久化任务列表；重启后仍可查询快照、取消和完成产物。'),
          h('div', { className: 'dsa-more-actions' },
            h('input', { className: 'dsa-answer-input', value: more.cloudWorkerId ?? '', 'aria-label': 'Worker ID',
              placeholder: '已知 Worker ID', onChange: event => dispatch({ type: 'updateCloudWorkerId', workerId: event.target.value }) }),
            h('button', { type: 'button', className: 'dsa-linkbtn',
              disabled: !more.cloudWorkerId?.trim() || busy[`cloud-worker:${more.cloudWorkerId}:snapshot`],
              onClick: () => dispatch({ type: 'cloudWorkerAction', action: 'snapshot', workerId: more.cloudWorkerId.trim() }) }, '查询快照')),
          workerRows.length ? h('div', { className: 'dsa-more-list' }, workerRows)
            : h('div', { className: 'dsa-workbench-empty' }, '暂无云端 Worker')),
        result ? h('section', { className: 'dsa-more-section', 'aria-label': '云端操作结果' },
          h('h3', null, '最近操作结果'),
          h('div', { className: 'dsa-more-meta' }, result.workerId, result.state ?? result.status, result.artifactId,
            result.finalizedAt ? formatTime(result.finalizedAt) : ''),
          manifestRows.length ? h('div', { className: 'dsa-more-list' }, manifestRows) : null,
          h('pre', { className: 'dsa-more-code' }, JSON.stringify(result.manifest
            ? { ...result, manifest: { ...result.manifest, entries: result.manifest.entries?.map(({ content, ...entry }) => entry) } }
            : result, null, 2))) : null)
    }

    function Rail(props) {
      const { model } = props
      const { workerSession, preview, detail } = model
      const activeView = model.inboxOpen ? 'inbox' : props.view
      const back = workerSession ? props.onCloseWorker : preview ? props.onClosePreview : detail ? props.onCloseRun : null
      const title = workerSession?.title || preview?.name || detail?.goal || '任务'
      const tab = RAIL_TABS.find(entry => entry.id === activeView) ?? RAIL_TABS[0]
      const inboxCount = model.workbench?.inbox?.filter(entry => !entry.read).length ?? 0
      const assistantStatus = model.workbench?.assistantStatus ?? {}
      return h('aside', { id: 'dsa-workbench', className: 'dsa-workbench', 'aria-label': '全局助理工作台' },
        h('div', { className: 'dsa-workbench-badge' },
          h('span', { className: 'dsa-workbench-avatar', 'aria-hidden': true },
            /^(?:https:\/\/|\/|data:image\/)/.test(assistantStatus.avatar ?? '')
              ? h('img', { src: assistantStatus.avatar, alt: '' }) : h(EntryIcon, { size: 18 })),
          h('div', { className: 'dsa-workbench-identity' },
            h('div', { className: 'dsa-workbench-name' }, assistantStatus.name || model.workbench?.name || '全局助理'),
            h('div', { className: 'dsa-workbench-role' }, PANEL_LABEL,
              h('span', { className: 'dsa-workbench-online' }, model.phase === 'ready' ? '在线' : '连接中')),
            h('div', { className: 'dsa-workbench-status' },
              `模型：${assistantStatus.model ?? '跟随宿主'} · 权限：${assistantStatus.permissions ?? '宿主策略'} · IM：${assistantStatus.im ?? '飞书未配置'}`)),
          h(IconButton, { icon: 'close', label: '关闭侧栏', onClick: props.onClose })),
        h('div', { className: 'dsa-workbench-workspace', title: model.project?.cwd ?? undefined },
          `当前工作区：${model.project?.name ?? '默认工作区'}`),
        h('nav', { className: 'dsa-workbench-tabs', role: 'tablist', 'aria-label': '工作台页签',
          onKeyDown: event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const index = RAIL_TABS.findIndex(entry => entry.id === activeView)
            if (index < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? RAIL_TABS.length - 1
              : event.key === 'ArrowRight' ? (index + 1) % RAIL_TABS.length : (index - 1 + RAIL_TABS.length) % RAIL_TABS.length
            props.onView(RAIL_TABS[next].id)
            requestAnimationFrame(() => event.currentTarget.querySelector(`[aria-controls="dsa-rail-${RAIL_TABS[next].id}"]`)?.focus?.())
          },
        }, RAIL_TABS.map(entry => h('button', {
            key: entry.id, type: 'button', className: 'dsa-workbench-tab', role: 'tab',
            'aria-selected': activeView === entry.id, 'aria-controls': `dsa-rail-${entry.id}`,
            tabIndex: activeView === entry.id ? 0 : -1,
            onClick: () => props.onView(entry.id),
          }, entry.label, entry.id === 'inbox' && inboxCount ? h('span', { className: 'dsa-count', 'aria-hidden': true }, inboxCount) : null))),
        detail ? h('div', { className: 'dsa-rail-detail-head' },
          back ? h(IconButton, { icon: 'back', label: workerSession ? '返回任务详情' : `返回${tab.label}`, onClick: back }) : null,
          h('h2', null, title),
          activeView === 'inbox' && inboxCount
            ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: props.onReadInbox }, '标为已读') : null) : null,
        h('div', { id: 'dsa-rail-tasks', role: 'tabpanel', hidden: activeView !== 'tasks' || Boolean(detail) },
          h(TaskList, { ...props, hidden: activeView !== 'tasks' || Boolean(detail) })),
        h('div', { id: 'dsa-rail-overview', role: 'tabpanel', hidden: activeView !== 'overview' || Boolean(detail) },
          activeView === 'overview' && !detail ? props.overview : null),
        h('div', { id: 'dsa-rail-artifacts', role: 'tabpanel', hidden: activeView !== 'artifacts' || Boolean(detail) },
          activeView === 'artifacts' && !detail ? props.artifacts : null),
        h('div', { id: 'dsa-rail-inbox', role: 'tabpanel', hidden: activeView !== 'inbox' || Boolean(detail) },
          activeView === 'inbox' && !detail ? props.inbox : null),
        h('div', { id: 'dsa-rail-automation', role: 'tabpanel', hidden: activeView !== 'automation' || Boolean(detail) },
          activeView === 'automation' && !detail ? props.automation : null),
        h('div', { id: 'dsa-rail-more', role: 'tabpanel', hidden: activeView !== 'more' || Boolean(detail) },
          activeView === 'more' && !detail ? props.more : null),
        detail ? props.detail : null)
    }

    function taskRank(task) {
      if (task.status === 'needs-decision' || task.attention?.length) return 0
      if (ACTIVE_RUN.has(task.status)) return 1
      return 2
    }

    function TaskList({ model, onOpen, onGoal, onGoalAction, onReply, onArtifact, onRecord, onBind, onUnbind, hidden }) {
      const [search, setSearch] = react.useState('')
      const [results, setResults] = react.useState(null)
      const query = search.trim()
      react.useEffect(() => {
        if (!query) return undefined
        let alive = true
        const timer = setTimeout(async () => {
          try {
            const data = await call(`/workbench?scope=global&q=${encodeURIComponent(query)}`)
            if (alive) setResults({ query, data })
          } catch (error) {
            if (alive) setResults({ query, error: error.message })
          }
        }, 200)
        return () => { alive = false; clearTimeout(timer) }
      }, [query])
      const result = results?.query === query ? results : null
      const bench = query ? result?.data : model.workbench
      const focused = query ? null : model.focusedBench
      const runs = new Map([...(focused?.runs ?? []), ...(bench?.runs ?? [])].map(run => [run.id, run]))
      const goals = new Map([...(focused?.goals ?? []), ...(bench?.goals ?? [])].map(goal => [goal.id, goal]))
      const source = bench?.sessionProjects ?? focused?.sessionProjects ?? {}
      const nameFor = task => source[task.ownerSessionId ?? task.parentSessionId]?.name
      const cwdFor = task => source[task.ownerSessionId ?? task.parentSessionId]?.cwd ?? null
      const tasks = [...goals.values(), ...[...runs.values()].filter(run => !goals.has(run.goalId)
        && !(run.origin?.kind === 'long-goal' && goals.has(run.origin.goalId)))]
      tasks.sort((left, right) => taskRank(left) - taskRank(right)
        || (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0))
      return h('div', { className: 'dsa-workbench-scroll dsa-task-list', 'aria-label': '任务列表', hidden },
        h('input', {
          type: 'search', className: 'dsa-task-search dsa-answer-input', value: search,
          'aria-label': '搜索任务与交付', placeholder: '搜索任务与交付', onChange: event => setSearch(event.target.value),
        }),
        tasks.length === 0 ? h('div', { className: 'dsa-workbench-empty' },
          result?.error ?? (bench ? query ? '没有找到匹配的任务' : '暂无任务' : '正在读取任务…')) : null,
        tasks.map(task => goals.has(task.id)
          ? h(GoalCard, {
            key: task.id, goal: task, project: nameFor(task), projectCwd: cwdFor(task), model, runs,
            bindings: (model.sourceBindings ?? []).filter(item => item.taskId === task.id && item.project === cwdFor(task) && !item.revokedAt),
            onOpen, onToggle: onGoal, onAction: onGoalAction, onReply, onArtifact, onRecord,
            onBind: onBind ? payload => onBind(task.id, payload) : undefined,
            onUnbind: onUnbind ? item => onUnbind(item) : undefined,
          })
          : h('section', { key: task.id, 'aria-label': task.goal },
            h(TaskRow, { task, project: nameFor(task), onClick: () => onOpen(task.id, task.parentSessionId ?? task.ownerSessionId) }),
            h(TaskLinks, { run: task, onReply, onArtifact }))))
    }

    function WorkspacePicker({ workbench, project, onSelect, onAdd, onPick, anchorRef }) {
      const [draft, setDraft] = react.useState(null)
      const [position, setPosition] = react.useState(null)
      react.useEffect(() => {
        const anchor = anchorRef.current
        const viewport = anchor?.closest('.dsa-main')
        if (!viewport) return undefined
        const measure = () => {
          const bounds = viewport.getBoundingClientRect()
          const composer = anchor.getBoundingClientRect()
          const above = Math.floor(composer.top - bounds.top - 8)
          const below = Math.floor(bounds.bottom - composer.bottom - 8)
          const room = Math.max(above, below)
          const placement = room < 120 ? 'overlay' : below > above ? 'below' : 'above'
          const maxHeight = Math.min(400, Math.max(24, placement === 'overlay' ? viewport.clientHeight - 8 : room))
          const top = placement === 'overlay' ? Math.round(bounds.top - composer.top + 4) : null
          setPosition(prior => prior?.placement === placement && prior.maxHeight === maxHeight && prior.top === top
            ? prior : { placement, maxHeight, top })
        }
        const observer = new ResizeObserver(measure)
        observer.observe(anchor)
        observer.observe(viewport)
        viewport.addEventListener('scroll', measure, { passive: true })
        measure()
        return () => {
          observer.disconnect()
          viewport.removeEventListener('scroll', measure)
        }
      }, [anchorRef])
      const choose = (entry, label) => h('button', {
        key: entry?.cwd ?? 'global', type: 'button', className: 'dsa-rowitem',
        'data-current': (entry?.cwd ?? null) === (project?.cwd ?? null),
        title: entry?.cwd ?? label, onClick: () => onSelect(entry),
      }, h(Icon, { of: entry ? 'folder' : 'spark', size: 16 }), h('span', { className: 'dsa-rowtitle' }, label))
      const style = position ? {
        maxHeight: position.maxHeight,
        ...(position.placement !== 'above' ? {
          bottom: 'auto', top: position.top ?? 'calc(100% + 4px)',
        } : {}),
      } : { visibility: 'hidden' }
      return h('div', { className: 'dsa-workspace-picker', role: 'dialog', 'aria-label': '工作区', style },
        h('nav', { className: 'dsa-project-nav', 'aria-label': '工作区列表' },
          choose(null, '默认工作区'), (workbench?.projects ?? []).map(entry => choose(entry, entry.name))),
        h('div', { className: 'dsa-picker-actions' },
          workbench?.canPickProject ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: onPick }, '选择文件夹') : null,
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => setDraft(value => value === null ? '' : null) }, '输入路径')),
        draft !== null ? h('form', { className: 'dsa-project-add', onSubmit: async event => {
          event.preventDefault()
          if (draft.trim() && await onAdd(draft.trim())) setDraft(null)
        } }, h(Input ?? 'input', {
          className: 'dsa-answer-input', value: draft, autoFocus: true,
          'aria-label': '工作区文件夹绝对路径', placeholder: '工作区文件夹绝对路径', onChange: event => setDraft(event.target.value),
        }), h('button', { type: 'submit', className: 'dsa-linkbtn', disabled: !draft.trim() }, '添加工作区')) : null)
    }

    /** Artifacts are whatever the run report links to, same rule as the console page. */
    function artifactsOf(run) {
      const report = typeof run?.report === 'string' ? run.report : ''
      const found = (run.artifacts ?? []).filter(item => item.href).map(item => ({ ...item, runId: run.id }))
      const pattern = /\[([^\]\n]{1,80})\]\(<?([^)>\n]+)>?\)/g
      let match = pattern.exec(report)
      while (match) {
        const href = match[2].trim()
        if (href && !/^[a-z][a-z0-9+.-]*:\/\//i.test(href) && !href.startsWith('#')) {
          if (!found.some(item => item.href === href)) found.push({ name: match[1].trim(), href, runId: run.id })
        }
        if (found.length >= 20) break
        match = pattern.exec(report)
      }
      return found
    }


    const STATUS_LABELS = {
      planning: '规划中', queued: '排队中', running: '进行中', aggregating: '汇总中', verifying: '验收中',
      ready: '待开始', pending: '待开始', 'needs-decision': '等你决定', completed: '完成', partial: '部分完成',
      paused: '已暂停', failed: '失败', stopped: '已停止', cancelling: '停止中', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过',
    }
    const ACTIVE_RUN = new Set(['queued', 'planning', 'running', 'aggregating'])

    /** Host StateDot semantics: amber attention, spinner, green done, red failure. */
    function statusDot(waiting, status) {
      if (waiting || status === 'needs-decision') return 'warning'
      if (ACTIVE_RUN.has(status) || status === 'verifying') return 'ongoing'
      if (status === 'completed' || status === 'partial') return 'done'
      if (['failed', 'cancelled', 'stopped', 'interrupted'].includes(status)) return 'error'
      return 'idle'
    }

    function InstructionForm({ run, onInstruct }) {
      const [text, setText] = react.useState('')
      const [target, setTarget] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const workers = (run.subtasks ?? []).filter(item => item.status === 'running' && item.childId)
      const targetAvailable = target === '' || workers.some(item => String(item.index) === target)
      const canSend = ACTIVE_RUN.has(run.status) || run.status === 'interrupted'
      const receipts = [...(run.instructions ?? []), ...(run.followups ?? [])]
      const receiptLabels = { pending: '待读取', applied: '已进入执行上下文', missed: '未应用', failed: '发送失败' }
      return h('div', { className: 'dsa-detail-sec' },
        canSend ? h('form', {
          className: 'dsa-instruction',
          onSubmit: async event => {
            event.preventDefault()
            if (busy || !text.trim() || !targetAvailable) return
            setBusy(true)
            try {
              if (await onInstruct(run.id, text.trim(), target === '' ? null : Number(target))) setText('')
            } finally {
              setBusy(false)
            }
          },
        },
        h('select', { className: 'dsa-answer-input', 'aria-label': '指令接收任务', value: target, onChange: event => setTarget(event.target.value) },
          h('option', { value: '' }, '该任务的下一次执行或汇总'),
          !targetAvailable ? h('option', { value: target, disabled: true }, '原工作线已停止，请重新选择') : null,
          workers.map(item => h('option', { key: item.index, value: String(item.index) }, item.title ?? `工作线 ${item.index}`))),
        h('input', { className: 'dsa-answer-input', placeholder: '补充这项任务的要求', value: text, onInput: event => setText(event.target.value) }),
        h('button', { type: 'submit', className: 'dsa-linkbtn', disabled: busy || !text.trim() || !targetAvailable }, '发送指令')) : null,
      receipts.map(entry => h('div', { key: entry.id, className: 'dsa-detail-label' },
        `${entry.text} · ${entry.targets
          ? entry.targets.map(item => `工作线 ${item.subtaskIndex} ${receiptLabels[item.status] ?? item.status}`).join('，')
          : receiptLabels[entry.status] ?? entry.status}`)))
    }

    function GoalDecision({ goal, item, onAction, busy }) {
      const [note, setNote] = react.useState('')
      if (item.source?.kind === 'human') {
        const verified = item.source.runtimeVerified === true
        const retry = !verified || item.source.headless
        const action = (answer, label, note) => h('button', {
          type: 'button', className: 'dsa-linkbtn', disabled: busy,
          onClick: () => onAction(goal.id, 'answer', { decisionId: item.id, answer, note }),
        }, label)
        return h('div', { className: 'dsa-attention-card' },
          h('div', { className: 'dsa-detail-q' }, verified ? item.question : '这条旧的登录请求需要重新检查'),
          verified && item.reason ? h('div', { className: 'dsa-detail-label' }, item.reason) : null,
          h('div', { className: 'dsa-goal-actions' },
            action('answer', retry ? '重新检查页面' : '我已完成，继续', retry ? '请重新检查页面' : '已完成，请重新检查页面并继续'),
            action('stop', '停止', '')))
      }
      const labels = { answer: '提交回答', accept: '接受验收', retry: '换做法重试', skip: '跳过此阶段', stop: '停止目标', continue: '继续' }
      const options = Array.isArray(item.options) ? item.options : []
      const actions = options.filter(answer => answer !== 'answer')
      const detail = item.detail || item.reason
      const phaseLabel = item.kind === 'phase-exhausted'
        ? String(item.question).match(/^阶段\s+([^\s「]+)\s+「([^」]+)」/)?.[0]
        : null
      const summary = item.summary || (phaseLabel ? `${phaseLabel}需要你决定下一步。` : item.question)
      return h('div', { className: 'dsa-attention-card' },
        h('div', { className: 'dsa-decision-summary' }, summary),
        item.impact ? h('div', { className: 'dsa-decision-impact' }, item.impact) : null,
        item.source?.options?.length ? h('div', { className: 'dsa-goal-actions' },
          item.source.options.map(option => h('button', {
            key: option, type: 'button', className: 'dsa-chip', disabled: busy,
            onClick: () => onAction(goal.id, 'answer', { decisionId: item.id, answer: 'answer', note: option }),
          }, option))) : null,
        actions.length ? h('div', { className: 'dsa-goal-actions' }, actions.map(answer => h('button', {
          key: answer, type: 'button', className: 'dsa-linkbtn', disabled: busy,
          onClick: () => onAction(goal.id, 'answer', { decisionId: item.id, answer, note: note.trim() }),
        }, labels[answer] ?? answer))) : null,
        options.includes('answer') ? h('div', { className: 'dsa-answer-row' },
          h('input', { className: 'dsa-answer-input', value: note, placeholder: '写下你的回答', onInput: event => setNote(event.target.value) }),
          h('button', {
            type: 'button', className: 'dsa-linkbtn', disabled: busy || !note.trim(),
            onClick: () => onAction(goal.id, 'answer', { decisionId: item.id, answer: 'answer', note: note.trim() }),
          }, '提交回答')) : null,
        detail ? h('details', { className: 'dsa-decision-details' },
          h('summary', null, '技术详情'), h('pre', null, detail)) : null)
    }

    function TaskStatus({ task }) {
      const waiting = Boolean(task.attention?.length)
      const status = waiting ? 'waiting' : task.status
      return h('span', { className: 'dsa-status' },
        StateDot ? h(StateDot, { state: statusDot(waiting, task.status), size: 10 })
          : h('span', { className: 'dsa-rowdot', 'data-status': status }),
        waiting ? '等你决定' : (STATUS_LABELS[status] ?? status))
    }

    function TaskRow({ task, project, onClick, open, rowRef }) {
      const progress = task.phases?.length
        ? `${task.phases.filter(phase => phase.status === 'completed').length}/${task.phases.length}` : null
      return h('button', {
        type: 'button', className: 'dsa-rowitem dsa-task-row', ref: rowRef, title: task.goal,
        'aria-expanded': open, 'data-current': open, onClick,
      }, h('span', { className: 'dsa-task-label' },
        h('span', null, task.title || task.goal || '任务'), project ? h('span', { className: 'dsa-hint' }, project) : null),
      progress ? h('span', { className: 'dsa-rowtime', 'aria-label': `${progress} 个阶段已完成` }, progress) : null,
      h(TaskStatus, { task }), h(Icon, { of: open ? 'down' : 'right', size: 14 }))
    }

    function FileCard({ item, onClick }) {
      return h('button', {
        type: 'button', className: 'dsa-file-card', title: item.href, onClick,
      }, h('span', { className: 'dsa-file-icon' }, FileTypeIcon
        ? h(FileTypeIcon, { path: item.href, size: 18 }) : h(Icon, { of: 'code', size: 16 })),
      h('span', { className: 'dsa-file-name' }, item.name || item.href),
      h(Icon, { of: 'right', size: 14 }))
    }

    function TaskLinks({ run, onReply, onArtifact }) {
      const artifacts = artifactsOf(run)
      const canReply = onReply && (ACTIVE_RUN.has(run.status) || run.status === 'interrupted')
      if (!canReply && artifacts.length === 0) return null
      return h('div', { className: 'dsa-task-links' },
        canReply ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onReply(run) }, '补充要求') : null,
        artifacts.length ? h('div', { className: 'dsa-file-list' }, artifacts.slice(0, 2).map(item =>
          h(FileCard, { key: item.href, item, onClick: () => onArtifact(run, item) }))) : null)
    }

    function sourceLabel(event) {
      const data = event?.data
      if (!data) return null
      if (event.source === 'github') {
        return [data.repository?.fullName, data.subject?.number ? `#${data.subject.number}` : null,
          data.subject?.title ?? data.subject?.name ?? data.type].filter(Boolean).join(' ')
      }
      return data.subject?.text?.replace(/\s+/gu, ' ').trim().slice(0, 80) || '飞书消息'
    }

    const sourceStatus = {
      registered: '等待投递', dispatching: '正在投递', retrying: '等待重试',
      dispatched: '已进入路由队列', failed: '投递失败', held: '已暂存',
      unauthorized: '投递未获授权', revoked: '绑定已撤销或变更', ignored: '已忽略', unbound: '尚未绑定',
    }

    function GoalCard({ goal, project, projectCwd, model, runs, bindings, onOpen, onToggle, onAction, onReply, onArtifact, onRecord, onBind, onUnbind }) {
      const rowRef = react.useRef(null)
      const [page, setPage] = react.useState(0)
      const [filter, setFilter] = react.useState('all')
      const [recordHint, setRecordHint] = react.useState('')
      const [bindOpen, setBindOpen] = react.useState(false)
      const [sourceChoice, setBindSource] = react.useState('')
      const [bindObject, setBindObject] = react.useState('')
      const [manualSource, setManualSource] = react.useState(false)
      const [bindPhase, setBindPhase] = react.useState('')
      const [bindHint, setBindHint] = react.useState('')
      const sourceState = model.sourceState
      const sourceTypes = ['github', 'feishu'].filter(type => sourceState?.instances?.[type]?.enabled)
      const bindSource = sourceTypes.includes(sourceChoice) ? sourceChoice : sourceTypes[0]
      const instanceId = sourceState?.instances?.[bindSource]?.instanceId
      const recent = sourceState?.recent ?? []
      const available = new Map()
      for (const event of recent) {
        if (event.status === 'unbound' && event.source === bindSource && event.instanceId === instanceId
          && !(model.sourceBindings ?? []).some(item => item.source === event.source
            && item.instanceId === event.instanceId && item.objectId === event.objectId)
          && !available.has(event.objectId)) {
          available.set(event.objectId, sourceLabel(event) || event.objectId)
        }
      }
      const visible = goal.phases.filter(phase => filter === 'all' || (filter === 'completed' ? phase.status === 'completed'
        : filter === 'failed' ? ['failed', 'skipped'].includes(phase.status)
          : !['completed', 'cancelled', 'failed', 'skipped'].includes(phase.status)))
      const pageSize = 30
      const pages = Math.ceil(visible.length / pageSize)
      const currentPage = Math.min(page, Math.max(pages - 1, 0))
      const open = model.selectedGoalId === goal.id
      react.useEffect(() => {
        if (open) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
      }, [open])
      const control = (action, label, body) => h('button', {
        type: 'button', className: 'dsa-linkbtn', disabled: model.goalBusy,
        onClick: () => onAction(goal.id, action, body, goal.ownerSessionId),
      }, label)
      const active = ACTIVE_RUN.has(goal.status) || goal.status === 'needs-decision'
      const canInstruct = active || goal.status === 'paused'
      const phases = new Map(goal.phases.map(phase => [phase.id, phase]))
      const context = open ? (model.contextFacts ?? [])
        .filter(fact => fact.taskId === goal.id && (fact.project ?? null) === projectCwd
          && (!fact.expiresAt || fact.expiresAt > Date.now())) : []
      const aliases = context.filter(fact => fact.kind === 'alias')
      const decisions = [
        ...context.filter(fact => fact.kind === 'decision').map(fact => ({
          id: fact.id, subject: fact.subject, value: fact.value, confirmedAt: fact.confirmedAt,
          phaseId: fact.phaseId, origin: fact.origin, source: fact.source,
        })),
        ...(goal.confirmedDecisions ?? []).map(item => ({
          id: item.id, subject: item.question, value: item.answer, confirmedAt: item.answeredAt,
          phaseId: item.phaseId, origin: 'user', source: 'task-answer',
        })),
      ]
      const evidence = context.filter(fact => fact.kind === 'evidence')
      const sources = context.filter(fact => fact.kind === 'source' || fact.origin === 'external')
      const phaseName = phaseId => phaseId ? phases.get(phaseId)?.title ?? phaseId : '整个任务'
      const when = value => {
        const time = new Date(value)
        return Number.isNaN(time.getTime()) ? '' : time.toLocaleDateString()
      }
      const contextLine = (key, label, detail, meta) => h('div', { key, className: 'dsa-detail-label' },
        `${label} · ${detail}`, h('div', null, meta))
      const contextRows = [
        ...aliases.map(fact => contextLine(`alias-${fact.id}`, '别名', fact.value,
          `由你记录 · ${when(fact.confirmedAt)}`)),
        ...decisions.map(fact => contextLine(`decision-${fact.id}`, phaseName(fact.phaseId),
          `${fact.subject} · ${fact.value}`,
          `${fact.source === 'task-answer' ? '来自待办回答' : '由你记录'} · ${when(fact.confirmedAt)}`
          + (fact.expiresAt ? ` · 有效至 ${when(fact.expiresAt)}` : ''))),
        ...sources.map(fact => contextLine(`source-${fact.id}`, '来源',
          `${fact.subject ?? '外部事件'} · ${fact.value ?? ''}`,
          `${fact.source ?? '外部'} · ${when(fact.validFrom ?? fact.confirmedAt)}`)),
        ...evidence.map(fact => contextLine(`evidence-${fact.id}`, '证据', fact.value,
          `${fact.origin === 'run' ? '运行结果' : '记录'} · ${when(fact.observedAt ?? fact.validFrom)}`)),
      ]
      const label = goal.title || goal.goal || '这项任务'
      const record = kind => {
        const selected = model.project?.cwd ?? null
        if (selected !== projectCwd) {
          setRecordHint(`请在输入框旁切换到「${project ?? projectCwd ?? '默认工作区'}」，再插入记录命令`)
          return
        }
        setRecordHint('')
        onRecord?.(goal, kind)
      }
      return h('section', { 'aria-label': goal.goal },
        h(TaskRow, { task: goal, project, open, rowRef, onClick: () => onToggle(open ? null : goal.id) }),
        open ? h('div', { className: 'dsa-task-stages' },
          goal.reason ? h('div', { className: 'dsa-detail-label' }, goal.reason) : null,
          goal.contextCount ? h('div', { className: 'dsa-detail-label' }, `已沿用 ${goal.contextCount} 条对话`) : null,
          goal.impact?.reReview?.length ? h('details', { className: 'dsa-workbench-section' },
            h('summary', null, `变更影响 · ${goal.impact.reReview.length} 项需要重审`),
            goal.impact.reReview.map(item => h('div', { key: item.phaseId, className: 'dsa-detail-label dsa-impact-row' },
              item.runId ? h('button', {
                type: 'button', className: 'dsa-linkbtn', onClick: () => onOpen(item.runId, goal.ownerSessionId),
              }, item.title) : item.title, h('div', null, item.reason))),
            goal.impact.canContinue.length ? h('div', { className: 'dsa-detail-label dsa-impact-row' },
              `仍可使用：${goal.impact.canContinue.map(item => item.title).join('、')}`) : null) : null,
          h('details', { className: 'dsa-workbench-section' },
            h('summary', null, '工作上下文'),
            contextRows.length
              ? contextRows.slice(-14)
              : h('div', { className: 'dsa-detail-label' }, '还没有别名或已确认的决定。')),
          h('div', { className: 'dsa-goal-actions dsa-record-actions' },
            h('button', {
              type: 'button', className: 'dsa-linkbtn', 'aria-label': `给「${label}」加别名`,
              onClick: () => record('alias'),
            }, '加别名'),
            h('button', {
              type: 'button', className: 'dsa-linkbtn', 'aria-label': `记下「${label}」的决定`,
              onClick: () => record('decision'),
            }, '记决定')),
          recordHint ? h('div', { className: 'dsa-hint dsa-record-hint', role: 'status' }, recordHint) : null,
          (onBind && bindSource) || (bindings ?? []).length ? h('details', { className: 'dsa-workbench-section dsa-source-section' },
            h('summary', null, `来源绑定${(bindings ?? []).length ? ` · ${(bindings ?? []).length}` : ''}`),
            (bindings ?? []).map(item => h('div', { key: item.id, className: 'dsa-detail-label dsa-source-row' },
              sourceLabel(recent.find(event => event.source === item.source && event.instanceId === item.instanceId
                && event.objectId === item.objectId)) || `${item.source} · ${item.objectId}`,
              h('div', null, `${phaseName(item.phaseId)} · ${item.autoStart ? '允许自动开工' : '只补上下文'}`),
              (sourceState?.deliveries?.[item.id] ?? []).map(delivery => h('div', { key: delivery.key },
                `${sourceStatus[delivery.status] ?? '收到事件'} · ${delivery.type} · ${new Date(delivery.at).toLocaleString()}`,
                delivery.reason ? h('div', null, delivery.reason) : null,
                delivery.nextAttemptAt ? h('div', null, `下次重试：${new Date(delivery.nextAttemptAt).toLocaleString()}`) : null)),
              onUnbind ? h('button', {
                type: 'button', className: 'dsa-linkbtn', disabled: model.goalBusy,
                'aria-label': `撤销来源绑定 ${item.objectId}`,
                onClick: () => Promise.resolve(onUnbind(item)).catch(error => setBindHint(error.message || '撤销失败')),
              }, '撤销') : null)),
            onBind && bindSource ? h('div', null,
              h('button', {
                type: 'button', className: 'dsa-linkbtn',
                'aria-label': `给「${label}」绑定来源`,
                onClick: () => { setBindOpen(!bindOpen); setBindHint('') },
              }, bindOpen ? '收起绑定' : '绑定来源'),
              bindOpen ? h('div', { className: 'dsa-source-form' },
                h('select', {
                  className: 'dsa-answer-input', 'aria-label': '来源类型', value: bindSource,
                  onChange: event => { setBindSource(event.target.value); setBindObject(''); setBindHint('') },
                }, sourceTypes.map(value => h('option', { key: value, value }, value === 'github' ? 'GitHub' : '飞书'))),
                manualSource ? h('input', {
                  className: 'dsa-answer-input', value: bindObject, 'aria-label': '来源对象 ID',
                  placeholder: '输入来源对象 ID', onChange: event => setBindObject(event.target.value),
                }) : h('select', {
                  className: 'dsa-answer-input', value: bindObject, 'aria-label': '选择收到的来源',
                  onChange: event => setBindObject(event.target.value),
                }, h('option', { value: '' }, available.size ? '选择收到的来源' : '暂无可绑定的事件'),
                [...available].map(([value, name]) => h('option', { key: value, value }, name))),
                h('button', {
                  type: 'button', className: 'dsa-linkbtn',
                  onClick: () => { setManualSource(!manualSource); setBindObject(''); setBindHint('') },
                }, manualSource ? '从已收到的事件选择' : '手动输入 ID'),
                h('select', {
                  className: 'dsa-answer-input', 'aria-label': '归到哪个阶段', value: bindPhase,
                  onChange: event => setBindPhase(event.target.value),
                }, h('option', { value: '' }, '整个任务'),
                goal.phases.filter(phase => !['completed', 'failed', 'skipped', 'cancelled'].includes(phase.status))
                  .map(phase => h('option', { key: phase.id, value: phase.id }, phase.title))),
                h('button', {
                  type: 'button', className: 'dsa-linkbtn', disabled: model.goalBusy,
                  onClick: async () => {
                    const objectId = bindObject.trim()
                    if (!projectCwd) { setBindHint('这个任务还没有工作区，先选一个再绑定'); return }
                    if (!objectId) { setBindHint(manualSource ? '先填写来源对象 ID' : '先选一个来源'); return }
                    setBindHint('正在绑定…')
                    try {
                      await onBind({ source: bindSource, instanceId, objectId, project: projectCwd, taskId: goal.id, phaseId: bindPhase })
                      setBindObject('')
                      setManualSource(false)
                      setBindOpen(false)
                      setBindHint('已绑定，后续来源事件会补充到这个任务')
                    } catch (error) {
                      setBindHint(error.message || '绑定失败')
                    }
                  },
                }, '绑定')) : null) : null,
            bindHint ? h('div', { className: 'dsa-hint dsa-record-hint', role: 'status' }, bindHint) : null) : null,
          goal.batch ? h('div', { className: 'dsa-goal-actions' },
            h('select', { className: 'dsa-answer-input', 'aria-label': '按批量事项状态筛选', value: filter,
              onChange: event => { setFilter(event.target.value); setPage(0) } },
            h('option', { value: 'all' }, '全部事项'), h('option', { value: 'open' }, '待处理'),
            h('option', { value: 'completed' }, '已完成'), h('option', { value: 'failed' }, '失败或跳过')),
            pages > 1 ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: currentPage === 0, onClick: () => setPage(currentPage - 1) }, '上一页') : null,
            h('span', { className: 'dsa-detail-label' }, pages > 1 ? `${currentPage + 1} / ${pages} 页` : `${visible.length} 项`),
            pages > 1 ? h('button', { type: 'button', className: 'dsa-linkbtn', disabled: currentPage + 1 >= pages, onClick: () => setPage(currentPage + 1) }, '下一页') : null) : null,
          visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(phase => {
            const run = runs.get(phase.runId)
            const waitingFor = ['pending', 'ready'].includes(phase.status)
              ? (phase.dependsOn ?? []).map(id => phases.get(id)).filter(item => item && item.status !== 'completed') : []
            const canReply = canInstruct && ['pending', 'ready', 'running', 'needs-decision', 'verifying'].includes(phase.status)
            const children = [h('span', { key: 'title' }, phase.title), h(TaskStatus, { key: 'status', task: phase })]
            return h('div', { key: phase.id },
              phase.runId ? h('button', {
                type: 'button', className: 'dsa-rowitem dsa-task-stage', title: phase.title,
                onClick: () => onOpen(phase.runId, goal.ownerSessionId),
              }, children, h(Icon, { of: 'right', size: 14 }))
                : h('div', { className: 'dsa-goal-phase', title: phase.title }, children),
              waitingFor.length ? h('div', { className: 'dsa-detail-label' }, `等待 ${waitingFor.map(item => item.title).join('、')}`) : null,
              phase.outcome ? h('div', { className: 'dsa-detail-label' }, phase.outcome) : null,
              canReply ? h('button', {
                type: 'button', className: 'dsa-linkbtn', onClick: () => onReply(goal, phase),
                  'aria-label': `补充阶段要求 ${phase.title}`,
              }, '补充阶段要求') : null,
              goal.status !== 'needs-decision' && ['failed', 'skipped'].includes(phase.status)
                ? control('retry_phase', goal.batch ? '重试此项' : '重试阶段', { phaseId: phase.id }) : null,
              run ? h(TaskLinks, { run, onArtifact }) : null)
          }),
          h('div', { className: 'dsa-goal-actions' },
            canInstruct ? h('button', {
              type: 'button', className: 'dsa-linkbtn', onClick: () => onReply(goal),
            }, '补充要求') : null,
            active && goal.status !== 'needs-decision' ? control('pause', '暂停新阶段') : null,
            goal.status === 'paused' ? control('resume', '继续') : null,
            active || goal.status === 'paused' ? control('cancel', '停止任务') : null),
          goal.instructions?.length ? h('details', { className: 'dsa-workbench-section' },
            h('summary', null, '补充记录'),
            goal.instructions.map(item => {
              const scope = item.phaseId ? phases.get(item.phaseId)?.title ?? item.phaseId : '整个任务'
              const status = item.targets.some(target => target.status === 'delivered') ? '已写入运行记录'
                : item.targets.length && item.targets.every(target => target.status === 'missed') ? '本轮结束前未送达' : '已登记'
              return h('div', { key: item.id, className: 'dsa-detail-label' }, `${scope} · ${item.text} · ${status}`)
            })) : null) : null)
    }

    function ArtifactPreview({ model, dispatch, onRetry, onReveal, onDownload, onShare, onError, onOpenOriginal, onContinue }) {
      const [zoom, setZoom] = react.useState(false)
      const preview = model.preview
      const file = preview.item
      const failed = () => onError?.({ message: `这个产物读不出来：${preview.name}` })
      let content
      if (preview.kind === 'img') {
        const image = h('img', { className: 'dsa-preview-img', src: preview.url, alt: preview.name, onError: failed })
        content = ImageLightbox ? h('button', {
          type: 'button', className: 'dsa-preview-thumb', 'aria-label': `放大预览 ${preview.name}`,
          onClick: () => setZoom(true),
        }, image) : image
      } else if (preview.kind === 'html') {
        content = h('iframe', { className: 'dsa-preview-frame', sandbox: '', src: preview.url, title: preview.name, onError: failed })
      } else if (preview.kind === 'md' && DetailDocument) {
        content = h(DetailDocument, {
          state: model.previewBusy ? { status: 'loading' }
            : model.previewError ? { status: 'error', message: model.previewError }
              : { status: 'found', markdown: model.previewText },
          labels: DETAIL_LABELS, onRetry,
        })
      } else {
        content = h('div', { className: 'dsa-preview-text' },
          model.previewBusy ? '正在读取…' : (model.previewError || model.previewText),
          model.previewError ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: onRetry }, '重试') : null)
      }
      return h('div', { className: 'dsa-preview-pane' },
        h('div', { className: 'dsa-preview-tools' },
          file.runId ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onOpenOriginal?.(file) }, '在原任务打开') : null,
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onContinue?.(file) }, '新对话继续'),
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onReveal(file) }, '在文件夹中显示'),
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onDownload(file) }, '下载'),
          h(ActionButton, { model, dispatch,
            confirmKey: `share:${artifactIdOf(file)}`, label: '分享', confirmLabel: '确认分享', busy: model.more?.shareBusy === true, ariaLabel: `分享 ${preview.name}`,
            detail: `确认为 ${preview.name} 创建只读分享？`, onConfirm: () => onShare?.(file),
          })),
        model.more?.lastShare && model.more.lastShare.artifactId === artifactIdOf(file) ? h('div', { className: 'dsa-hint dsa-composer-hint', role: 'status' },
          `分享已创建：${shareUrlOf(model.more.lastShare) || model.more.lastShare.token || model.more.lastShare.share?.id || '已生成'}`) : null,
        listOf(file.versions).length > 1 ? h('div', { className: 'dsa-preview-versions', 'aria-label': '产物版本' },
          h('div', { className: 'dsa-hint' }, `共 ${file.versionCount ?? listOf(file.versions).length} 个版本`),
          listOf(file.versions).map(version => h('button', { key: version.id, type: 'button', className: 'dsa-linkbtn',
            onClick: () => onOpenOriginal?.(version) }, `${formatTime(version.at)} · ${version.goal ?? version.runId}`))) : null,
        h('div', { className: 'dsa-preview-content' }, content),
        zoom && ImageLightbox ? h(ImageLightbox, {
          src: preview.url, alt: preview.name, labels: { dialog: '图片预览', close: '关闭图片预览' },
          onClose: () => setZoom(false),
        }) : null)
    }

    function RunDetail(props) {
      const { model } = props
      const run = model.detail
      if (!run) return null
      if (model.workerSession) return model.workerSession.transcript.messages.length
        ? h(Transcript, { model: model.workerSession.transcript })
        : h('div', { className: 'dsa-workbench-empty' }, '暂无会话记录')
      if (model.preview) return h(ArtifactPreview, {
        key: model.preview.url, model, dispatch: props.dispatch, onRetry: props.onRetryPreview, onReveal: props.onReveal, onDownload: props.onDownload,
        onShare: props.onShare, onError: props.onPreviewError,
        onOpenOriginal: props.onOpenOriginal, onContinue: props.onContinue,
      })
      const linked = (model.workbench?.inbox ?? []).filter(entry => entry.kind === 'decision')
        .map(entry => entry.item.source).filter(source => source?.runId === run.id)
      const linkedIds = new Set(linked.map(source => source.attentionId))
      const attention = (run.attention ?? []).filter(item => !linkedIds.has(item.id))
      const artifacts = artifactsOf(run)
      const workers = (run.subtasks ?? []).filter(task => task.childId)
      const running = ACTIVE_RUN.has(run.status)
      const planPreview = model.more?.planRunId === run.id ? model.more.planPreview : null
      return h('div', { className: 'dsa-workbench-scroll', 'aria-label': '任务详情' },
        h('div', { className: 'dsa-run-actions' },
          h(TaskStatus, { task: run }),
          h('div', { className: 'dsa-goal-actions' },
            running || run.status === 'interrupted'
              ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onReply(run) }, '补充要求') : null,
            h('button', { type: 'button', className: 'dsa-linkbtn', disabled: model.more?.planBusy === true, onClick: () => props.onPreviewPlan(run) }, '预览计划'),
            props.onEvidence ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onEvidence(run.id) }, '查看质量证据') : null,
            running ? h('button', {
              type: 'button', className: 'dsa-linkbtn dsa-stop-task',
              disabled: model.detailBusy, onClick: () => props.onCancelRun(run.id),
            }, '停止任务') : null)),
        h(PlanPreviewView, {
          model, run, preview: planPreview, busy: model.more?.planBusy === true, showButton: false,
          onPreview: () => props.onPreviewPlan(run), onClose: props.onClosePlan,
        }),
        linked.length ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: props.onInbox }, '在待办中处理') : null,
        attention.map(item => h(QuestionCard, {
          key: item.id, item,
          onAnswer: answer => props.onAnswer(run.id, item.id, answer),
        })),
        artifacts.length ? h('section', { className: 'dsa-workbench-section' },
          h('h3', null, '产物'), h('div', { className: 'dsa-file-list' }, artifacts.map(item =>
            h(FileCard, { key: item.href, item, onClick: () => props.onArtifact(item) })))) : null,
        run.acceptance?.checks?.length ? h('details', { className: 'dsa-workbench-section', open: run.status === 'failed' },
          h('summary', null, '验收证据'),
          run.acceptance.checks.map(check => {
            const status = check.source === 'model'
              ? (check.ok === true ? '模型判断通过' : check.ok === false ? '模型判断未通过' : '未经判断')
              : check.unverified || check.integrity === false ? '无法核验' : check.ok ? '机器校验通过' : '机器校验未通过'
            const evidence = check.exitCode != null ? `退出码 ${check.exitCode}` : check.detail
            return h('div', { key: check.id, className: 'dsa-detail-label', title: check.receipt },
              `${check.text} · ${status}${evidence ? ` · ${evidence}` : ''}${check.integrity ? ` · 回执 ${check.receipt.slice(0, 12)}` : ''}`)
          })) : null,
        run.output || run.report ? h('section', { className: 'dsa-workbench-section' },
          h('h3', null, run.output ? '交付内容' : '报告'),
          h('div', { className: 'dsa-md-plain' }, run.output || run.report),
          run.output && run.report ? h('details', null, h('summary', null, '验收报告'),
            h('div', { className: 'dsa-md-plain' }, run.report)) : null) : null,
        workers.length ? h('details', { className: 'dsa-workbench-section' },
          h('summary', null, '工作线'),
          workers.map(task => h('button', {
            key: task.childId, type: 'button', className: 'dsa-rowitem',
            onClick: () => props.onOpenWorker(run.id, task.childId),
          }, h('span', { className: 'dsa-rowtitle' }, task.title),
          h(TaskStatus, { task }), h(Icon, { of: 'right', size: 14 })))) : null,
        running || run.status === 'interrupted' || run.instructions?.length || run.followups?.length
          ? h('details', { className: 'dsa-workbench-section' }, h('summary', null, '定向指令与回执'),
            h(InstructionForm, { key: run.id, run, onInstruct: props.onInstruct })) : null)
    }

    function QuestionCard({ item, onAnswer }) {
      const [draft, setDraft] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const answer = async value => {
        if (!value.trim() || busy) return
        setBusy(true)
        try {
          if (await onAnswer(value.trim())) setDraft('')
        } finally {
          setBusy(false)
        }
      }
      if (item.kind === 'human') {
        const retry = !item.handoff || item.handoff.headless
        return h('div', { className: 'dsa-attention-card' },
          h('div', { className: 'dsa-attention-title' }, item.handoff ? '需要本人操作' : '需要重新检查'),
          h('div', null, item.handoff ? item.question : '这条旧的登录请求需要重新检查'),
          item.handoff && item.url ? h('div', { className: 'dsa-attention-desc' }, item.url) : null,
          item.handoff && item.reason ? h('div', { className: 'dsa-attention-desc' }, item.reason) : null,
          h('button', { type: 'button', className: 'dsa-linkbtn', disabled: busy,
            onClick: () => answer(retry ? '请重新检查页面' : '已完成，请重新检查页面并继续'),
          }, retry ? '重新检查页面' : '我已完成，继续'))
      }
      return h('div', { className: 'dsa-attention-card' },
        h('div', { className: 'dsa-attention-title' }, item.source === 'plan' ? '计划确认' : '等你决定'),
        h('div', null, item.question),
        item.reason ? h('div', { className: 'dsa-attention-desc' }, item.reason) : null,
        (item.options ?? []).length ? h('div', { className: 'dsa-goal-actions' }, item.options.map(option => h(Button ?? 'button', {
          key: option, type: 'button', variant: Button ? 'outline' : undefined, size: Button ? 'sm' : undefined,
          className: Button ? undefined : 'dsa-chip', disabled: busy, onClick: () => answer(option),
        }, option))) : null,
        h('form', {
          className: 'dsa-answer-row',
          onSubmit: event => {
            event.preventDefault()
            answer(draft)
          },
        },
        h(Input ?? 'input', {
          className: 'dsa-answer-input', value: draft, 'aria-label': '回答', placeholder: '写下回答',
          onChange: event => setDraft(event.target.value),
        }),
        h(Button ?? 'button', {
          type: 'submit', variant: Button ? 'primary' : undefined, size: Button ? 'sm' : undefined,
          className: Button ? undefined : 'dsa-chip', disabled: busy || !draft.trim(),
        }, '提交')))
    }

    function Inbox({ model, dispatch }) {
      const entries = model.workbench?.inbox ?? []
      const groups = new Map()
      for (const entry of entries) {
        const key = entry.project?.cwd ?? null
        if (!groups.has(key)) groups.set(key, { title: entry.project?.name ?? '全局助理', entries: [] })
        groups.get(key).entries.push(entry)
      }
      return h('div', { className: 'dsa-workbench-scroll' },
        entries.length === 0 ? h('div', { className: 'dsa-workbench-empty' }, '暂无待处理事项') : null,
        [...groups].map(([key, group]) => h('section', { key: key ?? 'global' },
          h('h3', { className: 'dsa-inbox-project', title: key ?? undefined }, group.title),
          group.entries.map(entry => h('div', { key: entry.id, className: 'dsa-workbench-section' },
            h('div', { className: 'dsa-inbox-meta' },
              !entry.read ? h('span', { className: 'dsa-inbox-unread', role: 'img', 'aria-label': '未读' }) : null,
              entry.kind === 'approval' ? entry.item.source || '工具审批' : entry.title),
            entry.kind === 'approval' ? h(Approvals, {
              approvals: [entry.item], busy: model.approvalBusy, sessionId: model.sessionId,
              onDecide: (id, decision) => dispatch({ type: 'decide', id, decision }),
            }) : entry.kind === 'decision' ? h(GoalDecision, {
              goal: { id: entry.goalId }, item: entry.item, busy: model.goalBusy,
              onAction: (goalId, action, body) => dispatch({ type: 'goalAction', goalId, action, body, owner: entry.sessionId }),
            }) : h(QuestionCard, {
              item: entry.item, onAnswer: answer => dispatch({ type: 'answer', runId: entry.runId,
                attentionId: entry.item.id, answer, owner: entry.sessionId }),
            }))))))
    }

    function Seat({ model, dispatch }) {
      const [railOpen, setRailOpen] = react.useState(true)
      const [railPreference, setRailPreference] = react.useState(null)
      const [view, setView] = react.useState(model.inboxOpen ? 'inbox' : 'overview')
      const [workspaceOpen, setWorkspaceOpen] = react.useState(false)
      const rootRef = react.useRef(null)
      const workspaceRef = react.useRef(null)
      const composerApi = react.useRef(null)
      const activeView = model.inboxOpen ? 'inbox' : view
      const closeMenus = () => {
        setWorkspaceOpen(false)
      }
      (react.useLayoutEffect ?? react.useEffect)(() => {
        const root = rootRef.current
        if (!root || railPreference !== null) return undefined
        const measure = () => setRailOpen(root.clientWidth > 820)
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(root)
        return () => observer.disconnect()
      }, [railPreference, model.phase])
      const selectView = (next, toggle = false) => {
        closeMenus()
        if (toggle && railOpen && activeView === next) {
          setRailPreference(false)
          setRailOpen(false)
          return
        }
        setRailPreference('open')
        setRailOpen(true)
        setView(next)
        if (activeView !== next && (model.workerSession || model.preview || model.detail)) dispatch({ type: 'closeRun' })
        if (model.inboxOpen !== (next === 'inbox')) dispatch({ type: 'showInbox', open: next === 'inbox' })
        if (next === 'artifacts') dispatch({ type: 'loadArtifacts', filters: model.artifactsQuery ?? {} })
        if (next === 'automation') dispatch({ type: 'loadAutomation' })
      }
      const inspectRun = (runId, owner) => {
        setRailPreference('open')
        setRailOpen(true)
        return dispatch({ type: 'openRun', runId, owner })
      }
      const showGoal = goalId => {
        selectView('tasks')
        dispatch(goalId ? { type: 'openTask', taskId: goalId } : { type: 'focusGoal', goalId: null })
      }
      const replyRun = (run, phase) => {
        setRailPreference(false)
        setRailOpen(false)
        return dispatch({ type: 'replyRun', run, phase })
      }
      // Record commands only prefill the composer; sending stays the user's
      // own click, so the text goes through the plain message entry.
      const recordFact = (task, kind) => {
        const api = composerApi.current
        if (!api) return false
        api.insert(kind === 'alias' ? `/别名 ${task.id} | ` : `/决定 ${task.id} | `)
        // Close the drawer either way: a kept draft asks for an explanation,
        // and that hint sits in the composer on wide and narrow layouts alike.
        setRailPreference(false)
        setRailOpen(false)
        return true
      }
      const workspaceAction = async action => {
        const changed = await dispatch(action)
        if (changed) setWorkspaceOpen(false)
        return changed
      }
      react.useEffect(() => {
        if (!workspaceOpen || typeof document === 'undefined') return undefined
        const outside = event => {
          if (!workspaceRef.current?.contains(event.target)) closeMenus()
        }
        document.addEventListener('pointerdown', outside)
        return () => document.removeEventListener('pointerdown', outside)
      }, [workspaceOpen])
      const onKeyDown = event => {
        if (event.defaultPrevented) return
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
          event.preventDefault()
          setRailPreference(railOpen ? false : 'open')
          setRailOpen(open => !open)
        } else if (event.key === 'Escape') {
          if (workspaceOpen) closeMenus()
          else if (railOpen && activeView === 'more' && model.more?.panel) dispatch({ type: 'closeMore' })
          else if (railOpen && model.workerSession) dispatch({ type: 'closeWorker' })
          else if (railOpen && model.preview) dispatch({ type: 'closePreview' })
          else if (railOpen && model.detail) dispatch({ type: 'closeRun' })
          else {
            setRailPreference(false)
            setRailOpen(false)
          }
        }
      }
      if (model.phase === 'loading') {
        return h('div', { className: 'dsa-root' },
          h('div', { className: 'dsa-empty' },
            h('div', { className: 'dsa-note', role: 'status' }, '正在连接全局助理…')))
      }
      if (model.phase === 'error') {
        return h('div', { className: 'dsa-root' },
          h('div', { className: 'dsa-empty' },
            h('div', { className: 'dsa-note' }, model.reason),
            h('div', { className: 'dsa-hint' }, model.hint || '在「高级」里确认控制台端口已开启（consolePort），或重试。'),
            h(Button ?? 'button', {
              variant: Button ? 'outline' : undefined, type: 'button', onClick: () => dispatch({ type: 'retry' }),
            }, '重试')))
      }
      const empty = !model.messages.length && !model.typing
      const chatUnavailable = model.capabilities?.chat === false
      const closePreview = () => dispatch({ type: 'closePreview' })
      const closeWorker = () => dispatch({ type: 'closeWorker' })
      const closeRail = () => {
        setRailPreference(false)
        setRailOpen(false)
      }
      return h('div', { className: 'dsa-root', onKeyDown, ref: rootRef },
        h(Header, {
          view: activeView,
          inboxCount: model.workbench?.inbox?.length ?? 0,
          onTasks: () => selectView('tasks', true),
          onInbox: () => selectView('inbox', true),
        }),
        model.toast
          ? (Toast ? h(Toast, {
            key: model.toast.text, text: model.toast.text,
            tone: model.toast.kind === 'ok' ? 'success' : undefined, holdMs: model.toast.kind === 'err' ? 6000 : 3000,
            onDone: () => dispatch({ type: 'dismissToast' }),
          }) : h(Notice, { toast: model.toast })) : null,
        h('div', { className: 'dsa-body', 'data-rail': railOpen ? 'open' : 'closed' },
          h('main', { className: 'dsa-main', 'data-empty': empty },
            h(Transcript, {
              model, scrollRef: model.scrollRef, onReply: message => dispatch({ type: 'reply', message }), onTask: showGoal,
              onReceipt: message => {
                selectView('tasks')
                dispatch({ type: 'openReceipt', message })
              },
              onChoose: (requestId, target) => dispatch({ type: 'chooseTask', requestId, target }),
            }),
            h('div', { className: 'dsa-compose-area' },
              empty ? h('div', { className: 'dsa-hero' },
                h('span', { className: 'dsa-hero-mark', 'aria-hidden': true },
                  FishLogo ? h(FishLogo, { size: 32 }) : h(EntryIcon, { size: 30 })),
                h('h1', { className: 'dsa-hero-title' }, PANEL_LABEL)) : null,
              chatUnavailable ? h('div', { className: 'dsa-chat-unavailable', role: 'status' },
                model.capabilities.reason || '暂时无法对话') : null,
              h(Composer, {
                model, disabled: model.sending || chatUnavailable, apiRef: composerApi,
                workspaceRef, workspaceOpen, onWorkspace: () => setWorkspaceOpen(open => !open),
                workspace: workspaceOpen ? h(WorkspacePicker, {
                  workbench: model.workbench, project: model.project, anchorRef: workspaceRef,
                  onSelect: project => workspaceAction({ type: 'selectProject', project }),
                  onAdd: cwd => workspaceAction({ type: 'registerProject', cwd }),
                  onPick: () => workspaceAction({ type: 'pickProject' }),
                }) : null,
                insert: model.uploadInsert, uploading: model.uploading === true,
                onInserted: () => dispatch({ type: 'inserted' }),
                onUpload: (file, project) => dispatch({ type: 'upload', file, project }),
                onSend: (text, contextMode) => dispatch({ type: 'send', text, contextMode }),
                onClearReply: () => dispatch({ type: 'reply' }),
              }))),
          railOpen ? h('button', {
            type: 'button', className: 'dsa-rail-scrim', tabIndex: -1,
            'aria-label': '关闭侧栏', onClick: closeRail,
          }) : null,
          railOpen ? h(Rail, {
            model, view: activeView, onView: selectView, onClose: closeRail,
            onOpen: inspectRun, onGoal: showGoal, onReply: replyRun, onRecord: recordFact,
            onBind: (goalId, payload) => dispatch({ type: 'sourceBind', ...payload }),
            onUnbind: item => dispatch({ type: 'sourceUnbind', id: item.id }),
            onCloseRun: () => dispatch({ type: 'closeRun' }),
            onClosePreview: closePreview, onCloseWorker: closeWorker,
            onReadInbox: () => dispatch({ type: 'readInbox' }),
            onGoalAction: (goalId, action, body, owner) => dispatch({ type: 'goalAction', goalId, action, body, owner }),
            onArtifact: (run, item) => dispatch({ type: 'openWorkbenchArtifact', run, item }),
            inbox: h(Inbox, { model, dispatch }),
            overview: h(Overview, { model, onOpen: inspectRun, onGoal: showGoal, onArtifact: item => dispatch({ type: 'openWorkbenchArtifact', run: item, item }), onInbox: () => selectView('inbox') }),
            artifacts: h(ArtifactLibrary, {
              model, onLoad: filters => dispatch({ type: 'loadArtifacts', filters }),
              onArtifact: item => dispatch({ type: 'openWorkbenchArtifact', run: item, item }),
            }),
            automation: h(Automation, {
              model, onLoad: () => dispatch({ type: 'loadAutomation' }), onOpen: inspectRun,
            }),
            more: h(MoreHub, { model, dispatch }),
            detail: h(RunDetail, {
              model, dispatch, onReply: replyRun, onInbox: () => selectView('inbox'),
              onOpenWorker: (runId, childId) => dispatch({ type: 'openWorker', runId, childId }),
              onCancelRun: runId => dispatch({ type: 'cancelRun', runId }),
              onInstruct: (runId, text, subtaskIndex) => dispatch({
                type: 'instructRun', runId, text, subtaskIndex, owner: model.detail?.parentSessionId,
              }),
              onAnswer: (runId, attentionId, answer) => dispatch({ type: 'answer', runId, attentionId, answer }),
              onArtifact: item => dispatch({ type: 'artifact', item }),
              onRetryPreview: () => dispatch({ type: 'retryPreview' }),
              onPreviewError: message => dispatch({ type: 'previewError', message }),
              onReveal: item => dispatch({ type: 'revealArtifact', item }),
              onDownload: item => dispatch({ type: 'downloadArtifact', item }),
              onShare: item => dispatch({ type: 'shareArtifact', item }),
              onOpenOriginal: item => dispatch({ type: 'openOriginalArtifact', item }),
              onContinue: item => dispatch({ type: 'continueArtifact', item }),
              onPreviewPlan: run => dispatch({ type: 'previewPlan', runId: run.id }),
              onClosePlan: () => dispatch({ type: 'clearPlanPreview' }),
              onEvidence: runId => {
                selectView('more')
                return dispatch({ type: 'openMore', panel: 'evidence', runId })
              },
            }),
          }) : null))
    }

    /** One-line status above the composer; errors stay until replaced. */
    function Notice(props) {
      if (!props.toast) return null
      return h('div', { className: 'dsa-toast', 'data-kind': props.toast.kind }, props.toast.text)
    }

    function Panel() {
      const [model, setModel] = react.useState(initialModel)
      const [attempt, setAttempt] = react.useState(0)
      const scrollRef = react.useRef(null)
      const modelRef = react.useRef(model)
      const workbenchRequest = react.useRef(0)
      const detailRequest = react.useRef(0)
      const artifactRequest = react.useRef(0)
      const automationRequest = react.useRef(0)
      const moreRequest = react.useRef(0)
      const memoryRequest = react.useRef(0)
      const automationRunKeys = react.useRef(new Map())
      const sendRequest = react.useRef(null)
      modelRef.current = model

      const patch = updater => setModel(current => {
        const base = current.more ? current : { ...current, more: initialMore() }
        return updater(base)
      })

      async function mutateMore(key, operation, refreshPanel = null) {
        patch(current => ({ ...current, more: { ...current.more, busy: { ...current.more.busy, [key]: true }, error: '' } }))
        try {
          const result = await operation()
          if (refreshPanel) await actions.loadMore({ panel: refreshPanel, force: true, silent: true }).catch(() => {})
          return result
        } catch (error) {
          if (error.status === 409 && key.startsWith('capability:')) {
            await actions.loadMore({ panel: 'capabilities', force: true }).catch(() => {})
          } else if (error.status === 409 && key.startsWith('automation:')) {
            await actions.loadMore({ panel: 'automations', force: true, silent: true }).catch(() => {})
            const id = key.split(':')[1]
            if (id) patch(current => ({ ...current, more: { ...current.more,
              automations: listOf(current.more.automations, 'rules', 'items').map(rule => rule.id === id
                ? { ...rule, name: rule.name?.endsWith('（已刷新）') ? rule.name : `${rule.name}（已刷新）` }
                : rule) } }))
          }
          patch(current => ({ ...current, more: { ...current.more, error: error.message } }))
          throw error
        } finally {
          patch(current => ({ ...current, more: { ...current.more, busy: omitKey(current.more.busy, key),
            confirming: { ...current.more.confirming, [key]: false } } }))
        }
      }

      async function refreshWorkbench() {
        const request = ++workbenchRequest.current
        // Sources are optional; an install without them simply shows no
        // binding section instead of failing the whole workbench refresh.
        const [workbench, sources] = await Promise.all([
          call('/workbench?scope=global'),
          call('/sources').catch(() => null),
        ])
        patch(current => {
          if (request !== workbenchRequest.current || current.sessionId !== workbench.sessionId) return current
          const run = workbench.runs?.find(item => item.id === current.detail?.id)
          const detail = run ? { ...run, report: run.reportTruncated && current.detail.report?.startsWith(run.report) ? current.detail.report : run.report } : current.detail
          return { ...current, workbench, detail, sourceState: sources ?? current.sourceState,
            sourceBindings: sources?.bindings ?? current.sourceBindings }
        })
      }

      function applyRouter(current, router) {
        if (!router || router.revision < current.routerRevision) return current
        return { ...current, routerRevision: router.revision, messages: router.messages ?? [],
          contextFacts: router.facts ?? [], typing: router.pending > 0,
          routerPlanExecution: router.planExecution ?? null }
      }

      async function refreshRouter() {
        const router = await call('/router')
        patch(current => applyRouter(current, router))
      }

      const taskStates = model.runs.map(run => `${run.id}:${run.status}:${(run.attention ?? []).map(item => item.id).join(',')}`).join(';')
      const decisions = model.goals.flatMap(goal => (goal.decisions ?? []).map(item => item.id)).join(',')
      const pendingApprovals = model.approvals.map(entry => entry.id).join(',')
      react.useEffect(() => {
        if (model.phase !== 'ready') return undefined
        const refresh = () => {
          refreshWorkbench().catch(() => {})
          refreshRouter().catch(() => {})
        }
        refresh()
        const timer = setInterval(refresh, 8000)
        return () => clearInterval(timer)
      }, [model.phase, model.sessionId, taskStates, pendingApprovals, decisions])

      // Connect once per attempt: wait for the relay, then follow the feed.
      react.useEffect(() => {
        let alive = true
        let source = null
        const open = async () => {
          for (let index = 0; index < RETRIES; index += 1) {
            try {
              const data = await call('/state')
              if (!alive) return
              patch(current => applyRouter({
                ...current,
                phase: 'ready',
                reason: '',
                hint: '',
                sessionId: data?.sessionId ?? null,
                capabilities: data?.capabilities ?? null,
                approvals: Array.isArray(data?.approvals) ? data.approvals : [],
                runs: Array.isArray(data?.runs) ? data.runs : [],
                goals: Array.isArray(data?.goals) ? data.goals : [],
              }, data?.router))
              break
            } catch (error) {
              if (index === RETRIES - 1) {
                if (!alive) return
                patch(current => ({ ...current, phase: 'error', reason: error.message, hint: error.hint ?? '' }))
                return
              }
              await wait(RETRY_MS)
            }
          }
          if (!alive) return
          if (typeof EventSource === 'undefined') return
          source = new EventSource(`${API}/events`)
          source.addEventListener('console', message => {
            let frame = null
            try {
              frame = JSON.parse(message.data)
            } catch {
              return
            }
            if (frame.type === 'router.changed') {
              refreshRouter().catch(() => {})
              refreshWorkbench().catch(() => {})
            } else if (frame.type === 'notification') {
              refreshWorkbench().catch(() => {})
              if (modelRef.current.more?.panel === 'notifications') {
                actions.loadMore({ panel: 'notifications', force: true, silent: true }).catch(() => {})
              }
            } else {
              patch(current => applyFrame(current, frame))
            }
          })
        }
        open()
        return () => {
          alive = false
          source?.close()
        }
      }, [attempt])

      // Keep the newest row in view while the answer streams.
      react.useEffect(() => {
        const node = scrollRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [model.messages.length, model.goals.length, model.typing])

      // The host toast fades itself after hold + fade; this timer only sweeps
      // up when the toast surface is unavailable.
      react.useEffect(() => {
        if (!model.toast) return undefined
        const timer = setTimeout(() => patch(current => ({ ...current, toast: null })), 8000)
        return () => clearTimeout(timer)
      }, [model.toast])

      const actions = {
        reply: ({ message }) => patch(current => ({ ...current, reply: message ? { id: message.id, text: message.text.slice(0, 800) } : null })),
        replyRun: ({ run, phase }) => patch(current => ({
          ...current,
          reply: { id: run.id, taskId: run.id, phaseId: phase?.id, text: `补充给 ${phase?.title || run.title || run.goal || '该任务'}` },
        })),
        showInbox: ({ open }) => {
          actions.closeRun()
          patch(current => ({ ...current, inboxOpen: open }))
          if (open) refreshWorkbench().catch(() => {})
        },
        focusGoal: ({ goalId }) => {
          actions.closeRun()
          patch(current => ({ ...current, inboxOpen: false, selectedGoalId: goalId }))
        },
        openTask: async ({ taskId }) => {
          const current = modelRef.current
          const base = current.workbench
          const known = base?.goals?.some(goal => goal.id === taskId) || base?.runs?.some(run => run.id === taskId)
          const data = known ? base : await call(`/workbench?q=${encodeURIComponent(taskId)}`)
          const goal = data?.goals?.find(item => item.id === taskId)
          if (goal) {
            patch(model => ({ ...model, focusedBench: known ? null : data }))
            actions.focusGoal({ goalId: taskId })
            return
          }
          const run = data?.runs?.find(item => item.id === taskId)
          if (run) await actions.openRun({ runId: run.id, owner: run.parentSessionId })
          else throw new Error('任务暂时无法打开')
        },
        openReceipt: async ({ message }) => openReceiptTarget({
          message,
          openRun: runId => actions.openRun({ runId }),
          openTask: taskId => actions.openTask({ taskId }),
          notify: text => actions.toast({ text }),
        }),
        readInbox: async () => {
          const ids = modelRef.current.workbench?.inbox?.filter(entry => !entry.read).map(entry => entry.id) ?? []
          if (!ids.length) return
          await call('/notices/read', { method: 'POST', body: JSON.stringify({ ids }) })
          await refreshWorkbench().catch(() => {})
        },
        readNotifications: async ({ ids } = {}) => mutateMore('notifications:read', async () => {
          const selected = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id)
            : listOf(modelRef.current.more?.notifications?.inbox).filter(item => !item.read).map(item => item.id)
          if (!selected.length) return null
          const result = await call('/notices/read', { method: 'POST', body: JSON.stringify({ ids: selected }) })
          await actions.loadMore({ panel: 'notifications', force: true, silent: true })
          return result
        }),
        loadArtifacts: async ({ filters = {} }) => {
          const request = ++artifactRequest.current
          const sessionId = modelRef.current.sessionId
          const query = { q: String(filters.q ?? '').trim(), kind: String(filters.kind ?? ''), project: String(filters.project ?? ''),
            from: String(filters.from ?? ''), to: String(filters.to ?? '') }
          patch(current => ({ ...current, artifactsLoading: true, artifactsError: '', artifactsQuery: query }))
          try {
            const data = await call(`/artifacts?${artifactQuery(query)}`)
            if (request !== artifactRequest.current || sessionId !== modelRef.current.sessionId) return
            patch(current => ({ ...current, artifacts: Array.isArray(data?.artifacts) ? data.artifacts : [], artifactsLoading: false, artifactsError: '' }))
          } catch (error) {
            if (request === artifactRequest.current && sessionId === modelRef.current.sessionId) {
              patch(current => ({ ...current, artifactsLoading: false, artifactsError: error.message }))
            }
            throw error
          }
        },
        loadAutomation: async () => {
          const request = ++automationRequest.current
          const sessionId = modelRef.current.sessionId
          patch(current => ({ ...current, automationLoading: true, automationError: '' }))
          try {
            const data = await call('/schedules')
            if (request !== automationRequest.current || sessionId !== modelRef.current.sessionId) return
            patch(current => ({ ...current, automation: data ?? { sessions: [] }, automationLoading: false, automationError: '' }))
          } catch (error) {
            if (request === automationRequest.current && sessionId === modelRef.current.sessionId) {
              patch(current => ({ ...current, automationLoading: false, automationError: error.message }))
            }
            throw error
          }
        },
        openMore: ({ panel, runId }) => {
          if (!MORE_ENTRIES.some(entry => entry.id === panel)) return false
          patch(current => ({
            ...current,
            more: {
              ...current.more, panel, lastPanel: current.more.panel ?? panel, error: '',
              pairing: current.more.panel === panel ? current.more.pairing : null,
            },
            toast: null,
          }))
          return actions.loadMore({ panel, runId, force: true })
        },
        closeMore: () => {
          moreRequest.current += 1
          patch(current => ({ ...current, more: { ...current.more, panel: null, loading: false, error: '', pairing: null, lastShare: null, confirming: {} } }))
        },
        loadMore: async ({ panel, runId, force = false, silent = false }) => {
          const current = modelRef.current
          const more = current.more ?? initialMore()
          if (!MORE_ENTRIES.some(entry => entry.id === panel)) return false
          if (!force && more.panel === panel && more[panel] !== null && !more.loading) return true
          const request = ++moreRequest.current
          const sessionId = current.sessionId
          if (panel === 'plan') {
            const run = current.detail?.id === runId ? current.detail
              : (current.workbench?.runs ?? []).find(item => item.id === runId) ?? (current.runs ?? []).find(item => item.id === runId) ?? latestRun(current)
            patch(value => ({ ...value, more: { ...value.more, panel, loading: false, error: '', planRunId: run?.id ?? null } }))
            return true
          }
          patch(value => ({ ...value, more: { ...value.more, panel, ...(!silent ? { loading: true } : {}), error: '' } }))
          try {
            let data
            if (panel === 'notifications') {
              const [center, preference] = await Promise.all([call('/notifications'), call('/notifications/preferences')])
              data = { ...center, preferences: preference?.preferences ?? center?.preferences, revision: preference?.revision ?? center?.revision }
            } else if (panel === 'memory') {
              const query = String(more.memoryQuery ?? '').trim()
              data = await call(`/memory?${query ? `search=${encodeURIComponent(query)}&` : ''}pageSize=50`)
            } else if (panel === 'evidence') {
              const target = runId ?? current.detail?.id ?? latestRun(current)?.id ?? ''
              if (!target) {
                patch(value => ({ ...value, more: { ...value.more, loading: false, evidenceRunId: '', evidence: { cards: [], summary: { total: 0 } } } }))
                return true
              }
              data = await call(`/runs/${encodeURIComponent(target)}/evidence?limit=100`)
              if (request === moreRequest.current && sessionId === modelRef.current.sessionId) {
                patch(value => ({ ...value, more: { ...value.more, evidenceRunId: target } }))
              }
            } else {
              const route = {
                capabilities: '/capabilities', runtime: '/runtime-view', cost: '/cost',
                profiles: '/profiles?includeDisabled=true', device: '/device/status', shares: '/shares',
                market: `/market${String(more.marketQuery ?? '').trim() ? `?query=${encodeURIComponent(String(more.marketQuery).trim())}` : ''}`,
                'cloud-worker': '/cloud-worker', automations: '/automations',
              }[panel]
              data = await call(route)
            }
            if (request !== moreRequest.current || sessionId !== modelRef.current.sessionId) return false
            const key = { 'cloud-worker': 'cloudWorker', device: 'devices' }[panel] ?? panel
            patch(value => ({
              ...value,
              more: {
                ...value.more, panel, loading: false, error: '', [key]: data,
                ...(panel === 'profiles' ? { profileDraft: value.more.profileDraft?.dirty
                  ? value.more.profileDraft : assistantDraftFromProfile(globalAssistantOf(data)) } : {}),
                ...(panel === 'evidence' && runId ? { evidenceRunId: runId } : {}),
              },
            }))
            return true
          } catch (error) {
            if (request !== moreRequest.current || sessionId !== modelRef.current.sessionId) return false
            const phaseTwo = MORE_ENTRIES.find(entry => entry.id === panel)?.phase === 2
            const message = phaseTwo && [404, 501, 503].includes(error.status)
              ? `服务暂不可用：${error.message}` : error.message
            patch(value => ({ ...value, more: { ...value.more, loading: false, error: message } }))
            throw error
          }
        },
        saveNotifications: async ({ patch: preferences }) => mutateMore('notifications', async () => {
          const saved = await call('/notifications/preferences', { method: 'PATCH', body: JSON.stringify(preferences) })
          const center = await call('/notifications')
          patch(current => ({ ...current, more: { ...current.more, notifications: { ...center, preferences: saved?.preferences ?? center?.preferences, revision: saved?.revision ?? center?.revision } } }))
          return saved
        }),
        capabilityAction: async ({ name, action, enabled, server, cwd, expectedSettingsRevision }) => mutateMore(`capability:${name}:${action}`, async () => {
          const payload = { name, ...(action === 'setEnabled' ? { enabled, expectedSettingsRevision } : {}),
            ...(action === 'add' ? { server, expectedSettingsRevision } : {}),
            ...(action === 'setSkillEnabled' ? { enabled } : {}),
            ...(action === 'loadSkill' && cwd ? { cwd } : {}) }
          const result = await call('/capabilities', { method: 'POST', body: JSON.stringify({ action, ...payload }) })
          patch(current => ({ ...current, more: { ...current.more, capabilityResult: result,
            ...(action === 'loadSkill' ? { loadedSkill: result } : {}) } }))
          return result
        }, ['setEnabled', 'add', 'setSkillEnabled'].includes(action) ? 'capabilities' : null),
        updateMcpDraft: ({ patch: mcpPatch }) => patch(current => ({ ...current, more: { ...current.more,
          mcpDraft: { ...current.more.mcpDraft, ...mcpPatch } } })),
        searchMemory: async ({ query = '' }) => {
          const request = ++memoryRequest.current
          const normalized = String(query).trim()
          patch(current => ({ ...current, more: { ...current.more, memoryQuery: normalized, busy: { ...current.more.busy, memory: true }, error: '' } }))
          try {
            const data = await call(`/memory?${normalized ? `search=${encodeURIComponent(normalized)}&` : ''}pageSize=50`)
            if (request !== memoryRequest.current) return false
            patch(current => ({ ...current, more: { ...current.more, memory: data, busy: omitKey(current.more.busy, 'memory'), error: '' } }))
            return true
          } catch (error) {
            if (request === memoryRequest.current) patch(current => ({ ...current, more: { ...current.more, busy: omitKey(current.more.busy, 'memory'), error: error.message } }))
            throw error
          }
        },
        updateMemory: async ({ id, expectedRevision, patch: memoryPatch }) => mutateMore(`memory:${id}`, async () => {
          const result = await call('/memory', { method: 'POST', body: JSON.stringify({ action: 'update', id, expectedRevision, patch: memoryPatch }) })
          await actions.searchMemory({ query: modelRef.current.more?.memoryQuery ?? '' })
          return result
        }),
        forgetMemory: async ({ id, expectedRevision }) => mutateMore(`memory:${id}`, async () => {
          const result = await call('/memory', { method: 'POST', body: JSON.stringify({ action: 'forget', id, expectedRevision }) })
          await actions.searchMemory({ query: modelRef.current.more?.memoryQuery ?? '' })
          return result
        }),
        updateRuntimePanel: ({ patch: runtimePatch }) => patch(current => ({ ...current, more: { ...current.more,
          runtimeDraft: { ...current.more.runtimeDraft, ...runtimePatch } } })),
        applyRuntimeEvent: ({ event }) => patch(current => {
          if (!event || typeof event !== 'object') return current
          const runtime = current.more.runtime ?? {}
          if (event.type === 'state' && event.snapshot) {
            return { ...current, more: { ...current.more, runtime: { ...runtime, ...event.snapshot } } }
          }
          if (['action', 'current-action'].includes(event.type) && event.action) {
            const actions = [...listOf(runtime.actions)].filter(item => item.id !== event.action.id)
            actions.push(event.action)
            return { ...current, more: { ...current.more, runtime: { ...runtime, currentAction: event.action,
              actions: actions.slice(-50) } } }
          }
          return current
        }),
        runtimeAction: async ({ action, payload = {} }) => mutateMore('runtime', async () => {
          const result = await call('/runtime-view', { method: 'POST', body: JSON.stringify({ action, payload }) })
          const snapshot = await call('/runtime-view')
          patch(current => ({ ...current, more: { ...current.more, runtime: snapshot, runtimeActionResult: result } }))
          return result
        }),
        updateAssistantDraft: ({ patch: profilePatch }) => patch(current => ({ ...current, more: { ...current.more,
          profileDraft: { ...(current.more.profileDraft ?? assistantDraftFromProfile(globalAssistantOf(current.more.profiles))),
            ...profilePatch, dirty: true } } })),
        resetAssistantDraft: () => patch(current => ({ ...current, more: { ...current.more,
          profileDraft: assistantDraftFromProfile(globalAssistantOf(current.more.profiles)) } })),
        saveAssistantProfile: async () => mutateMore(`profile:${GLOBAL_ASSISTANT_ID}:save`, async () => {
          const current = modelRef.current
          const profiles = current.more.profiles ?? await call('/profiles?includeDisabled=true')
          const payload = assistantProfilePayload(current.more.profileDraft ?? assistantDraftFromProfile(globalAssistantOf(profiles)), profiles)
          const result = await call('/profiles', { method: 'POST', body: JSON.stringify(payload) })
          if (!result) {
            await actions.loadMore({ panel: 'profiles', force: true, silent: true }).catch(() => {})
            return null
          }
          patch(value => {
            const listed = listOf(value.more.profiles, 'profiles', 'items')
            const exists = listed.some(profile => profile.id === result.id)
            const nextProfiles = exists ? listed.map(profile => profile.id === result.id ? result : profile) : [...listed, result]
            return { ...value, more: { ...value.more, profiles: nextProfiles,
              profileDraft: assistantDraftFromProfile(result) } }
          })
          return result
        }),
        toggleProfile: async ({ id, enabled }) => mutateMore(`profile:${id}`, async () => {
          const result = await call('/profiles', { method: 'POST', body: JSON.stringify({ action: 'toggle', id, enabled }) })
          return result
        }, 'profiles'),
        pairDevice: async ({ name, scopes, expiresInSeconds }) => mutateMore('device', async () => {
          const result = await call('/device/pair', { method: 'POST', body: JSON.stringify({ name, scopes, expiresInSeconds }) })
          const devices = await call('/device/status')
          patch(current => ({ ...current, more: { ...current.more, devices, pairing: result } }))
          return result
        }),
        revokeDevice: async ({ id }) => mutateMore(`device:${id}`, async () => {
          const result = await call('/device/revoke', { method: 'POST', body: JSON.stringify({ id }) })
          const devices = await call('/device/status')
          patch(current => ({ ...current, more: { ...current.more, devices } }))
          return result
        }),
        setMoreConfirm: ({ key, confirming }) => patch(current => ({ ...current, more: { ...current.more,
          confirming: { ...current.more.confirming, [key]: confirming } } })),
        updateAutomationDraft: ({ patch: draftPatch }) => patch(current => ({ ...current, more: { ...current.more,
          automationDraft: { ...current.more.automationDraft, ...draftPatch } } })),
        newAutomation: () => patch(current => ({ ...current, more: { ...current.more,
          automationEditId: null, automationDraft: automationDraftFromRule(null), automationPreview: null } })),
        editAutomation: ({ rule }) => patch(current => ({ ...current, more: { ...current.more,
          automationEditId: rule.id, automationDraft: automationDraftFromRule(rule), automationPreview: null } })),
        previewAutomation: async ({ rule }) => mutateMore('automation-preview', async () => {
          const result = await call('/automations', { method: 'POST', body: JSON.stringify({ action: 'preview', rule }) })
          patch(current => ({ ...current, more: { ...current.more, automationPreview: result } }))
          return result
        }),
        saveAutomation: async ({ rule, id = null, expectedRevision = null }) => mutateMore(`automation:${id ?? 'new'}:save`, async () => {
          const action = id ? 'update' : 'create'
          const result = await call('/automations', { method: 'POST', body: JSON.stringify({
            action, ...(id ? { id, expectedRevision, patch: rule } : { rule }),
          }) })
          patch(current => ({ ...current, more: { ...current.more, automationActionResult: result,
            automationEditId: result.id, automationDraft: automationDraftFromRule(result), automationPreview: null } }))
          return result
        }, 'automations'),
        automationAction: async ({ action, id, expectedRevision = null, enabled }) => {
          const key = `automation:${id}:${action}`
          let runKey = null
          if (action === 'run-now') {
            runKey = automationRunKeys.current.get(id) ?? idempotencyKey(`manual:${id}`)
            automationRunKeys.current.set(id, runKey)
          }
          return mutateMore(key, async () => {
            const result = await call('/automations', { method: 'POST', body: JSON.stringify({
              action, id, ...(expectedRevision === null ? {} : { expectedRevision }),
              ...(typeof enabled === 'boolean' ? { enabled } : {}), ...(runKey ? { idempotencyKey: runKey } : {}),
            }) })
            if (runKey) automationRunKeys.current.delete(id)
            patch(current => ({ ...current, more: { ...current.more, automationActionResult: result,
              ...(action === 'remove' ? { automationEditId: null, automationDraft: automationDraftFromRule(null),
                automationExecutions: current.more.automationExecutions?.ruleId === id ? null : current.more.automationExecutions } : {}) } }))
            return result
          }, 'automations')
        },
        loadAutomationExecutions: async ({ id }) => mutateMore(`automation:${id}:executions`, async () => {
          const items = await call(`/automations/${encodeURIComponent(id)}/executions?limit=100`)
          patch(current => ({ ...current, more: { ...current.more, automationExecutions: { ruleId: id, items: listOf(items) } } }))
          return items
        }),
        clearAutomationExecutions: () => patch(current => ({ ...current, more: { ...current.more, automationExecutions: null } })),
        updateShareDraft: ({ patch: sharePatch }) => patch(current => ({ ...current, more: { ...current.more,
          shareDraft: { ...current.more.shareDraft, ...sharePatch } } })),
        shareArtifact: async ({ item = {}, artifactId = artifactIdOf(item), role = 'viewer', ttlMs } = {}) => {
          if (!artifactId) throw new Error('这个产物没有可分享的标识')
          return mutateMore('share', async () => {
            const result = await call('/shares', { method: 'POST', body: JSON.stringify({ action: 'create',
              share: { artifactIds: [artifactId], role, ...(Number.isSafeInteger(ttlMs) && ttlMs > 0 ? { ttlMs } : {}) } }) })
            const normalized = { ...(typeof result === 'string' ? { token: result } : result), artifactId, url: shareUrlOf(result) }
            patch(current => ({ ...current, more: { ...current.more, lastShare: normalized,
              shareDraft: { ...current.more.shareDraft, artifactId } } }))
            return result
          }, 'shares')
        },
        removeShare: async ({ id }) => mutateMore(`share:${id}:remove`, async () => {
          const result = await call('/shares', { method: 'POST', body: JSON.stringify({ action: 'remove', id }) })
          patch(current => ({ ...current, more: { ...current.more,
            lastShare: current.more.lastShare?.share?.id === id ? null : current.more.lastShare } }))
          return result
        }, 'shares'),
        updateMarketQuery: ({ query }) => patch(current => ({ ...current, more: { ...current.more, marketQuery: query } })),
        updateMarketImport: ({ patch: importPatch }) => patch(current => ({ ...current, more: { ...current.more,
          marketImport: { sourceDirectory: '', enabled: false, ...(current.more.marketImport ?? {}), ...importPatch } } })),
        searchMarket: async ({ query = '' }) => mutateMore('market', async () => {
          const result = await call('/market', { method: 'POST', body: JSON.stringify({ action: 'search', query }) })
          patch(current => ({ ...current, more: { ...current.more, market: result, marketQuery: query, marketDetail: null } }))
          return result
        }),
        marketDetail: async ({ item }) => mutateMore(`market:${item.kind}:${item.name}:detail`, async () => {
          const result = await call('/market', { method: 'POST', body: JSON.stringify({ action: 'detail',
            name: item.name, kind: item.kind, version: item.version }) })
          patch(current => ({ ...current, more: { ...current.more, marketDetail: result, marketHandoff: null } }))
          return result
        }),
        clearMarketDetail: () => patch(current => ({ ...current, more: { ...current.more, marketDetail: null } })),
        marketHandoff: async ({ item, enabled }) => mutateMore('market:install-handoff', async () => {
          try {
            const result = await call('/market', { method: 'POST', body: JSON.stringify({ action: 'install-handoff', item, enabled }) })
            patch(current => ({ ...current, more: { ...current.more, marketHandoff: result } }))
            return result
          } catch (error) {
            if (error.data) patch(current => ({ ...current, more: { ...current.more, marketHandoff: error.data } }))
            throw error
          }
        }),
        importMarketSkill: async ({ sourceDirectory, enabled }) => mutateMore('market:import', async () => {
          const result = await call('/market', { method: 'POST', body: JSON.stringify({ action: 'import', sourceDirectory, enabled }) })
          patch(current => ({ ...current, more: { ...current.more, marketImport: result } }))
          return result
        }),
        refreshCloudWorker: async () => mutateMore('cloud-worker:status', async () => {
          const result = await call('/cloud-worker')
          patch(current => ({ ...current, more: { ...current.more, cloudWorker: result } }))
          return result
        }),
        updateCloudWorkerId: ({ workerId }) => patch(current => ({ ...current, more: { ...current.more, cloudWorkerId: workerId } })),
        updateCloudWorkerDraft: ({ patch: draftPatch }) => patch(current => ({ ...current, more: { ...current.more,
          cloudDraft: { ...cloudDraftFromModel(current), ...(current.more.cloudDraft ?? {}), ...draftPatch } } })),
        submitCloudWorker: async ({ workSpec, idempotencyKey: requestedKey }) => mutateMore('cloud-worker:submit', async () => {
          const key = requestedKey || `dsh:${workSpec.run.id}:${workSpec.subtask.id}:${workSpec.attempt}`
          const result = await call('/cloud-worker', { method: 'POST', body: JSON.stringify({ action: 'submit', workSpec, idempotencyKey: key }) })
          patch(current => ({ ...current, more: { ...current.more, cloudActionResult: result, cloudWorkerId: result.workerId } }))
          await actions.refreshCloudWorker()
          return result
        }, 'cloud-worker'),
        cloudWorkerAction: async ({ action, workerId, idempotencyKey: requestedKey }) => mutateMore(`cloud-worker:${workerId}:${action}`, async () => {
          const key = requestedKey ?? (action === 'cancel' ? `cancel:${workerId}` : action === 'finalize' ? `finalize:${workerId}` : undefined)
          const result = await call('/cloud-worker', { method: 'POST', body: JSON.stringify({ action, workerId,
            ...(key ? { idempotencyKey: key } : {}) }) })
          patch(current => ({ ...current, more: { ...current.more, cloudActionResult: result } }))
          await actions.refreshCloudWorker()
          return result
        }, 'cloud-worker'),
        updateRouteDraft: ({ patch: routePatch }) => patch(current => ({ ...current, more: { ...current.more,
          routeDraft: { ...current.more.routeDraft, ...routePatch } } })),
        updateCostBudget: ({ patch: budgetPatch }) => patch(current => ({ ...current, more: { ...current.more,
          costBudgetDraft: { ...current.more.costBudgetDraft, ...budgetPatch } } })),
        saveCostBudget: async ({ currency, micros }) => mutateMore('cost', async () => {
          const result = await call('/cost', { method: 'POST', body: JSON.stringify({ action: 'budget',
            budgets: { [currency]: micros } }) })
          await actions.loadMore({ panel: 'cost', force: true, silent: true })
          return result
        }),
        suggestRoute: async ({ type, ...payload }) => {
          const result = await call('/cost', { method: 'POST', body: JSON.stringify({ action: 'route', ...payload }) })
          patch(current => ({ ...current, more: { ...current.more, routeResult: result } }))
          return result
        },
        updatePlanDraft: ({ patch: planPatch }) => patch(current => ({ ...current, more: { ...current.more,
          planDraft: { ...current.more.planDraft, ...planPatch }, planPreview: null, planApproval: null, planHandoff: null } })),
        previewCandidatePlan: async ({ type, ...payload }) => {
          patch(value => ({ ...value, more: { ...value.more, planBusy: true, planRunId: null,
            planApproval: null, planHandoff: null, error: '' } }))
          try {
            const preview = await call('/plan-preview', { method: 'POST', body: JSON.stringify({ action: 'candidate', ...payload }) })
            patch(value => ({ ...value, more: { ...value.more, planPreview: preview, planBusy: false, error: '' } }))
            return preview
          } catch (error) {
            patch(value => ({ ...value, more: { ...value.more, planBusy: false, error: error.message } }))
            throw error
          }
        },
        approveAndRunCandidatePlan: async () => {
          const current = modelRef.current
          const preview = current.more.planPreview
          if (preview?.kind !== 'candidate-plan-preview' || candidatePlanBlocked(preview)) throw new Error('阻塞计划或非候选计划不能运行')
          patch(value => ({ ...value, more: { ...value.more, planBusy: true, error: '',
            planHandoff: { state: 'approving', planDigest: preview.planDigest } } }))
          try {
            let approval = current.more.planApproval
            try {
              candidatePlanRouterSubmission(preview, approval, 'pending')
            } catch {
              approval = await call('/plan-preview', { method: 'POST', body: JSON.stringify({ action: 'approve', preview,
                planDigest: preview.planDigest,
                confirmations: listOf(preview.pendingConfirmations).map(item => item.id).filter(Boolean) }) })
            }
            const requestId = `plan-${globalThis.crypto.randomUUID()}`
            const submission = candidatePlanRouterSubmission(preview, approval, requestId)
            patch(value => ({ ...value, more: { ...value.more, planApproval: approval,
              planHandoff: { state: 'checking-router', planDigest: preview.planDigest, requestId } } }))
            const router = await call('/router')
            patch(value => applyRouter(value, router))
            if (!routerSupportsCandidatePlans(router)) {
              patch(value => ({ ...value, more: { ...value.more,
                planHandoff: { state: 'awaiting-router', planDigest: preview.planDigest, requestId } } }))
              return { accepted: false, approved: true, planDigest: preview.planDigest, reason: 'router-contract-unsupported' }
            }
            patch(value => ({ ...value, more: { ...value.more,
              planHandoff: { state: 'submitting', planDigest: preview.planDigest, requestId } } }))
            const result = await call('/message', { method: 'POST', body: JSON.stringify(submission) })
            if (result?.accepted !== true || result.planDigest !== preview.planDigest) {
              throw new Error('Router 未确认计划摘要；请检查任务列表，未将本次提交视为已绑定运行')
            }
            patch(value => ({ ...value, more: { ...value.more,
              planHandoff: { state: 'submitted', planDigest: preview.planDigest, requestId: result.id ?? requestId } } }))
            await refreshRouter().catch(() => {})
            return result
          } catch (error) {
            patch(value => ({ ...value, more: { ...value.more, error: error.message,
              planHandoff: value.more.planHandoff?.state === 'submitting'
                ? { ...value.more.planHandoff, state: 'unconfirmed' } : value.more.planHandoff } }))
            throw error
          } finally {
            patch(value => ({ ...value, more: { ...value.more, planBusy: false } }))
          }
        },
        previewPlan: async ({ runId }) => {
          const current = modelRef.current
          const run = current.detail?.id === runId ? current.detail
            : (current.workbench?.runs ?? []).find(item => item.id === runId) ?? (current.runs ?? []).find(item => item.id === runId)
          if (!run) throw new Error('找不到要预览的任务')
          patch(value => ({ ...value, more: { ...value.more, planBusy: true, planRunId: runId,
            planApproval: null, planHandoff: null, error: '' } }))
          try {
            const preview = await call('/plan-preview', { method: 'POST', body: JSON.stringify({ action: 'preview', ...planFromRun(current, run) }) })
            patch(value => ({ ...value, more: { ...value.more, planPreview: preview, planBusy: false, error: '' } }))
            return preview
          } catch (error) {
            patch(value => ({ ...value, more: { ...value.more, planBusy: false, error: error.message } }))
            throw error
          }
        },
        clearPlanPreview: () => patch(current => ({ ...current, more: { ...current.more,
          planPreview: null, planApproval: null, planHandoff: null, planRunId: null } })),
        selectProject: ({ project }) => patch(current => ({ ...current, project, uploadInsert: '' })),
        chooseTask: async ({ requestId, target }) => {
          await call('/router/choose', { method: 'POST', body: JSON.stringify({ requestId, target }) })
          await refreshRouter().catch(() => {})
        },
        registerProject: async ({ cwd }) => {
          const data = await call('/projects', { method: 'POST', body: JSON.stringify({ cwd }) })
          patch(current => ({ ...current, project: data.project, uploadInsert: '' }))
          await refreshWorkbench().catch(() => {})
        },
        pickProject: async () => {
          const { cwd } = await call('/projects/pick', { method: 'POST', body: '{}' })
          if (cwd) await actions.registerProject({ cwd })
        },
        openWorkbenchArtifact: async ({ run, item }) => {
          const descriptor = { ...(run ?? {}), ...(item ?? {}) }
          if (typeof descriptor.href === 'string' && /^https?:\/\//i.test(descriptor.href)) {
            if (typeof window !== 'undefined') window.open(descriptor.href, '_blank', 'noopener,noreferrer')
            return true
          }
          const runId = descriptor.runId ?? descriptor.id
          const owner = descriptor.ownerSessionId ?? descriptor.owner ?? descriptor.parentSessionId
          if (!runId) throw new Error('这个产物缺少所属任务，暂时无法预览')
          if (!await actions.openRun({ runId, owner })) throw new Error('产物所属任务已切换，请重试')
          await actions.artifact({ item: { ...descriptor, runId, owner } })
        },
        goalAction: async ({ goalId, action, body, owner }) => {
          const sessionId = owner ?? modelRef.current.sessionId
          patch(current => ({ ...current, goalBusy: true }))
          try {
            await call(`/goals/${encodeURIComponent(goalId)}/${action}?owner=${encodeURIComponent(sessionId ?? '')}`, { method: 'POST', body: JSON.stringify({ ...body, sessionId }) })
            await refreshWorkbench().catch(() => {})
          } finally {
            patch(current => ({ ...current, goalBusy: false }))
          }
        },
        sourceBind: async ({ source, instanceId, objectId, project, taskId, phaseId }) => {
          patch(current => ({ ...current, goalBusy: true }))
          try {
            await call('/sources/bind', {
              method: 'POST',
              body: JSON.stringify({
                source, instanceId, objectId, project, taskId, phaseId: phaseId || null,
                allowFollowup: true, autoStart: false,
              }),
            })
            await refreshWorkbench().catch(() => {})
          } finally {
            patch(current => ({ ...current, goalBusy: false }))
          }
        },
        sourceUnbind: async ({ id }) => {
          patch(current => ({ ...current, goalBusy: true }))
          try {
            await call('/sources/unbind', { method: 'POST', body: JSON.stringify({ id }) })
            await refreshWorkbench().catch(() => {})
          } finally {
            patch(current => ({ ...current, goalBusy: false }))
          }
        },
        instructRun: async ({ runId, text, subtaskIndex, owner }) => {
          const sessionId = owner ?? modelRef.current.sessionId
          const receipt = await call(`/runs/${encodeURIComponent(runId)}/instruction?owner=${encodeURIComponent(sessionId ?? '')}`, {
            method: 'POST',
            body: JSON.stringify({ sessionId, text, subtaskIndex, mode: subtaskIndex === null ? 'followup' : 'inject' }),
          })
          await refreshWorkbench().catch(() => {})
          if (receipt.targets?.some(target => target.status === 'failed')) throw new Error('指令未送达工作线，请查看任务详情')
          return receipt
        },
        send: async action => {
          const { reply, project } = modelRef.current
          const target = reply?.taskId ?? null
          const text = reply && !target ? `${reply.text.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n${action.text}` : action.text
          const payload = { text, target, phaseId: reply?.phaseId, project: target ? null : project?.cwd,
            contextMode: action.contextMode, intent: target ? 'followup' : null }
          const fingerprint = JSON.stringify(payload)
          if (sendRequest.current?.fingerprint !== fingerprint) {
            sendRequest.current = { fingerprint, id: globalThis.crypto.randomUUID() }
          }
          const id = sendRequest.current.id
          patch(current => ({ ...current, sending: true }))
          try {
            await call('/message', { method: 'POST', body: JSON.stringify({ ...payload, id }) })
            sendRequest.current = null
            patch(current => ({ ...current, reply: current.reply === reply ? null : current.reply }))
            await refreshRouter().catch(() => {})
          } finally {
            patch(current => ({ ...current, sending: false }))
          }
        },
        decide: async action => {
          const { id, decision } = action
          patch(current => ({ ...current, approvalBusy: { ...current.approvalBusy, [id]: true } }))
          try {
            await call('/approval', { method: 'POST', body: JSON.stringify({ id, decision }) })
            patch(current => ({
              ...current,
              approvals: current.approvals.filter(entry => entry.id !== id),
              approvalBusy: omitKey(current.approvalBusy, id),
            }))
            await refreshWorkbench().catch(() => {})
          } catch (error) {
            // The card stays and the failure surfaces instead of vanishing.
            patch(current => ({ ...current, approvalBusy: omitKey(current.approvalBusy, id) }))
            throw error
          }
        },
        openRun: async action => {
          const request = ++detailRequest.current
          const sessionId = modelRef.current.sessionId
          const listed = modelRef.current.workbench?.runs?.find(run => run.id === action.runId)
          const owner = action.owner ?? listed?.parentSessionId ?? sessionId
          patch(current => ({ ...current, detailBusy: true }))
          try {
            const run = await call(`/runs/${encodeURIComponent(action.runId)}?owner=${encodeURIComponent(owner ?? '')}`)
            if (request !== detailRequest.current || sessionId !== modelRef.current.sessionId) return false
            patch(current => ({ ...current, detail: run, inboxOpen: false, workerSession: null, detailBusy: false, preview: null }))
            return true
          } catch (error) {
            if (request !== detailRequest.current || sessionId !== modelRef.current.sessionId) return false
            patch(current => ({ ...current, detailBusy: false }))
            throw error
          }
        },
        openWorker: async ({ runId, childId }) => {
          const owner = modelRef.current.detail?.parentSessionId
          const data = await call(`/runs/${encodeURIComponent(runId)}/worker/${encodeURIComponent(childId)}?owner=${encodeURIComponent(owner ?? '')}`)
          const transcript = applyFrame(initialModel(), { type: 'stream.snapshot', records: data.records })
          patch(current => current.detail?.id === runId ? { ...current, workerSession: { title: data.title, transcript } } : current)
        },
        closeWorker: () => patch(current => ({ ...current, workerSession: null })),
        closeRun: () => {
          detailRequest.current += 1
          patch(current => ({ ...current, workerSession: null, detail: null, detailBusy: false, preview: null, previewText: '', previewError: '', previewBusy: false }))
        },
        cancelRun: async action => {
          const owner = modelRef.current.detail?.parentSessionId
          const result = await call(`/runs/${encodeURIComponent(action.runId)}/cancel`, {
            method: 'POST', body: JSON.stringify({ owner }),
          })
          patch(current => ({
            ...current,
            detail: current.detail && current.detail.id === action.runId
              ? { ...current.detail, status: result.cancelPending ? 'cancelling' : result.status }
              : current.detail,
          }))
          await refreshWorkbench().catch(() => {})
        },
        answer: async action => {
          const answer = String(action.answer ?? '').trim()
          if (!answer) return
          const owner = action.owner ?? modelRef.current.detail?.parentSessionId
          await call('/answer', {
            method: 'POST',
            body: JSON.stringify({ owner, runId: action.runId, attentionId: action.attentionId, answer }),
          })
          patch(current => ({
            ...current,
            detail: current.detail && current.detail.id === action.runId
              ? {
                ...current.detail,
                attention: (current.detail.attention ?? []).filter(item => item.id !== action.attentionId),
              }
              : current.detail,
          }))
          await refreshWorkbench().catch(() => {})
        },
        artifact: async action => {
          const item = action.item ?? {}
          const href = String(item.href ?? item.path ?? '')
          const owner = item.owner ?? item.ownerSessionId ?? modelRef.current.detail?.parentSessionId
          const url = `${API}/artifact?path=${encodeURIComponent(href)}&runId=${encodeURIComponent(item.runId ?? '')}&owner=${encodeURIComponent(owner ?? '')}`
          const ext = href.toLowerCase().split('.').pop()
          const kind = ['md', 'markdown'].includes(ext)
            ? 'md'
            : ['html', 'htm'].includes(ext)
              ? 'html'
              : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
                ? 'img'
                : 'text'
          patch(current => ({
            ...current,
            preview: { name: item.name ?? href, url, kind, item: { ...item, owner } },
            previewText: '',
            previewError: '',
            previewBusy: kind === 'md' || kind === 'text',
          }))
          if (kind !== 'md' && kind !== 'text') return
          try {
            const res = await fetch(url, { headers: { accept: 'text/plain, text/markdown, */*' } })
            const text = await res.text()
            if (!res.ok) throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
            patch(current => current.preview?.url === url ? { ...current, previewBusy: false, previewText: text, previewError: '' } : current)
          } catch (error) {
            const message = `这个产物读不出来：${error.message}`
            patch(current => current.preview?.url === url
              ? { ...current, previewBusy: false, previewError: message, toast: { kind: 'err', text: message } } : current)
          }
        },
        previewError: ({ message = '这个产物读不出来' }) => patch(current => ({
          ...current, previewError: message, toast: { kind: 'err', text: message },
        })),
        retryPreview: async () => {
          const preview = modelRef.current.preview
          if (!preview) return
          patch(current => ({ ...current, previewBusy: true, previewError: '', previewText: '' }))
          try {
            const res = await fetch(preview.url, { headers: { accept: 'text/plain, text/markdown, */*' } })
            const text = await res.text()
            if (!res.ok) throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
            patch(current => ({ ...current, previewBusy: false, previewText: text }))
          } catch (error) {
            const message = `这个产物读不出来：${error.message}`
            patch(current => ({ ...current, previewBusy: false, previewError: message, toast: { kind: 'err', text: message } }))
          }
        },
        closePreview: () => patch(current => ({ ...current, preview: null, previewText: '', previewError: '', previewBusy: false,
          more: { ...current.more, lastShare: null } })),
        revealArtifact: async action => {
          const item = action.item ?? {}
          const owner = item.owner ?? item.ownerSessionId ?? modelRef.current.detail?.parentSessionId
          const query = `?path=${encodeURIComponent(item.href ?? item.path ?? '')}&runId=${encodeURIComponent(item.runId ?? '')}&owner=${encodeURIComponent(owner ?? '')}`
          await call(`/artifact/reveal${query}`, { method: 'POST', body: '{}' })
        },
        downloadArtifact: action => {
          const item = action.item ?? {}
          const owner = item.owner ?? item.ownerSessionId ?? modelRef.current.detail?.parentSessionId
          const url = `${API}/artifact?download=1&path=${encodeURIComponent(item.href ?? item.path ?? '')}&runId=${encodeURIComponent(item.runId ?? '')}`
            + `&owner=${encodeURIComponent(owner ?? '')}`
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener')
        },
        openOriginalArtifact: async ({ item = {} }) => {
          if (!item.runId) throw new Error('这个产物缺少所属任务')
          return actions.openRun({ runId: item.runId, owner: item.ownerSessionId ?? item.owner ?? modelRef.current.detail?.parentSessionId })
        },
        continueArtifact: async ({ item = {} }) => {
          const cwd = typeof item.project === 'string' ? item.project : item.project?.cwd ?? modelRef.current.project?.cwd
          let created = null
          if (modelRef.current.routerRevision < 0) {
            try {
              created = await call('/session', { method: 'POST', body: JSON.stringify({ cwd }) })
            } catch (error) {
              if (error.status !== 405) throw error
            }
          }
          const name = item.name ?? item.href ?? item.path ?? '所选产物'
          const location = item.path ?? item.href ?? ''
          const prompt = `请基于产物「${name}」继续：${location}`
          patch(current => ({ ...current,
            ...(created ? { sessionId: created.sessionId, currentId: null, typing: false,
              messages: [], approvals: [], runs: [], goals: [], detail: null, workerSession: null,
              inboxOpen: false, artifacts: [], workbench: null, automation: null,
              capabilities: created.capabilities ?? current.capabilities } : { detail: null, preview: null }),
            uploadInsert: prompt }))
          await new Promise(resolve => setTimeout(resolve, 0))
          composerApi.current?.prefill?.(prompt)
          if (created) refreshWorkbench().catch(() => {})
          return created ?? { continued: true, mode: 'router' }
        },
        upload: async action => {
          const file = action.file ?? {}
          if (file.error) throw new Error(file.error)
          patch(current => ({ ...current, uploading: true }))
          try {
            const data = await call('/upload', {
              method: 'POST',
              body: JSON.stringify({ name: file.name, data: file.data, project: action.project }),
            })
            const insert = (modelRef.current.project?.cwd ?? null) === (action.project ?? null) ? data?.path ?? '' : ''
            patch(current => ({ ...current, uploading: false, uploadInsert: insert }))
          } catch (error) {
            patch(current => ({ ...current, uploading: false }))
            throw error
          }
        },
        inserted: () => patch(current => ({ ...current, uploadInsert: '' })),
        retry: () => {
          patch(current => ({ ...current, phase: 'loading', reason: '' }))
          setAttempt(value => value + 1)
        },
        toast: action => patch(current => ({ ...current, toast: { kind: action.kind ?? 'err', text: String(action.text ?? '') } })),
        dismissToast: () => patch(current => ({ ...current, toast: null })),
      }

      const dispatch = action => {
        // The shell must survive a failed action: show it, never throw.
        const run = actions[action.type]
        if (!run) return
        return Promise.resolve().then(() => run(action)).then(() => true).catch(error => {
          patch(current => ({
            ...current,
            reason: error.message,
            hint: error.hint ?? '',
            toast: { kind: 'err', text: `${error.message}${error.hint ? ` ${error.hint}` : ''}` },
            phase: current.phase === 'loading' ? 'error' : current.phase,
          }))
          return false
        })
      }

      return h(Seat, { model: { ...model, scrollRef }, dispatch })
    }

    /**
     * The sidebar row's glyph. The host draws the row itself, so only the mark
     * belongs to this module; it uses the shell's icon set for the same reason
     * the panel does.
     */
    function EntryIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      const host = ICONS.spark
      if (isComponent(host)) return h(host, { size })
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4 6.3 9.7 1.6 8l4.7-1.7z' }))
    }

    /** @param {object} ctx - client root context. */
    function apply(ctx) {
      try {
        if (!h) return
        ensureStyle()
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          Panel,
        ))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 5,
            label: PANEL_LABEL,
          },
          EntryIcon,
        ))
      } catch (error) {
        // A seat that cannot be taken must cost only this entry, never the frame.
        console.error('[dsh-superagent] the sidebar entry could not be seated', error)
      }
    }

    try {
      exports.apply = apply
      exports.inject = ['slots']
      // Exposed for the client-side click test; the panel itself uses the
      // `openReceipt` action above.
      exports.openReceiptTarget = openReceiptTarget
      exports.todaySummary = todaySummary
      exports.workbenchTasks = workbenchTasks
      exports.artifactQuery = artifactQuery
      exports.automationRecords = automationRecords
      exports.automationRuleFromDraft = automationRuleFromDraft
      exports.automationDraftFromRule = automationDraftFromRule
      exports.automationTriggerLabel = automationTriggerLabel
      exports.availableArtifacts = availableArtifacts
      exports.shareUrlOf = shareUrlOf
      exports.marketInstallCommand = marketInstallCommand
      exports.cloudWorkSpecFromDraft = cloudWorkSpecFromDraft
      exports.cloudDraftFromModel = cloudDraftFromModel
      exports.planFromRun = planFromRun
      exports.assistantDraftFromProfile = assistantDraftFromProfile
      exports.assistantProfilePayload = assistantProfilePayload
      exports.candidatePlanBlocked = candidatePlanBlocked
      exports.candidatePlanRouterSubmission = candidatePlanRouterSubmission
      exports.routerSupportsCandidatePlans = routerSupportsCandidatePlans
      exports.audioBufferToWav = audioBufferToWav
    } catch (error) {
      console.error('[dsh-superagent] client exports could not be published', error)
    }
    return exports
  },
})
