/**
 * dsh-superagent — browser half.
 *
 * The "超级智能体" entry opens a main panel that is rendered natively inside
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
    const PANEL_LABEL = '超级智能体'
    /** Same-origin relay owned by this plugin's node half. */
    const API = '/superagent/api/console'
    const RETRIES = 8
    const RETRY_MS = 500
    const STYLE_ID = 'dsh-superagent-native-style'

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
.dsa-workbench{grid-column:2;grid-row:1;min-width:0;overflow:hidden;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}
.dsa-rail-scrim{display:none}
.dsa-workbench-head{display:flex;align-items:center;gap:8px;flex:none;min-height:48px;padding:0 12px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:14px;line-height:20px;font-weight:500}
.dsa-workbench-head h2{flex:1;min-width:0;margin:0;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-workbench-scroll{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:10px 12px 16px}
.dsa-workbench-section{padding:8px 0}
.dsa-workbench-section+.dsa-workbench-section{border-top:.5px solid var(--dsw-alias-border-l3)}
.dsa-workbench-section h3{margin:0 8px 4px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.dsa-workbench-empty{padding:4px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
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
.dsa-answer-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsa-answer-row > button{max-width:100%;min-width:0}
.dsa-answer-row > span{flex:1;min-width:0}
.dsa-answer-input{flex:1;min-width:0;box-sizing:border-box;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}
.dsa-answer-input:focus{border-color:var(--dsw-alias-state-business-primary)}
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
        throw error
      }
      return body?.data ?? null
    }

    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms))
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
            return h('button', {
              key: id, type: 'button', className: 'dsa-task-receipt', title: task?.goal,
              onClick: () => message.choiceFor && props.onChoose ? props.onChoose(message.choiceFor, id) : props.onTask(id),
            }, h('span', { className: 'dsa-receipt-icon' }, h(Icon, { of: 'checklist', size: 17 })),
            h('span', { className: 'dsa-receipt-copy' },
              h('strong', null, task?.title || task?.goal || '查看任务'), task ? h(TaskStatus, { task }) : null),
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
      const areaRef = react.useRef(null)
      const fileRef = react.useRef(null)
      const scoped = props.model.reply?.taskId
      const sendLabel = '发送给超级智能体'

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

      const uploadFile = file => {
        if (!file || !props.onUpload) return
        const reader = new FileReader()
        reader.onload = () => {
          const data = String(reader.result ?? '').replace(/^data:[^,]*,/, '')
          props.onUpload({ name: file.name, data })
        }
        reader.onerror = () => props.onUpload({ name: file.name, data: '', error: '文件读不出来' })
        reader.readAsDataURL(file)
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
      if (props.apiRef) props.apiRef.current = { insert: insertCommand }

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

      return h('div', { className: 'dsa-composer', ref: props.workspaceRef },
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
          h('textarea', {
            ref: areaRef,
            className: 'dsa-input',
            rows: 1,
            value: text,
            'aria-label': scoped ? '任务补充要求' : '给超级智能体发消息',
            placeholder: scoped ? '补充这项任务的要求…' : '给超级智能体发消息…',
            disabled,
            onInput: event => {
              setText(event.target.value)
              if (insertHint) setInsertHint('')
              grow()
            },
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
              style: { display: 'none' },
              onChange: event => uploadFile(event.target.files?.[0]),
            }),
            h('div', { className: 'dsa-compose-tools' },
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

    function Rail(props) {
      const { model } = props
      const { workerSession, preview, detail } = model
      const back = workerSession ? props.onCloseWorker : preview ? props.onClosePreview : detail ? props.onCloseRun : null
      const title = model.inboxOpen ? '待办' : workerSession?.title || preview?.name || detail?.goal || '任务'
      return h('aside', { id: 'dsa-workbench', className: 'dsa-workbench', 'aria-labelledby': 'dsa-workbench-title' },
        h('div', { className: 'dsa-workbench-head' },
          back ? h(IconButton, { icon: 'back', label: preview || workerSession ? '返回任务详情' : '返回任务列表', onClick: back }) : null,
          h('h2', { id: 'dsa-workbench-title', title }, title),
          model.inboxOpen && model.workbench?.inbox?.some(entry => !entry.read)
            ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: props.onReadInbox }, '标为已读') : null,
          h(IconButton, { icon: 'close', label: '关闭侧栏', onClick: props.onClose })),
        h(TaskList, { ...props, hidden: model.inboxOpen || Boolean(detail) }),
        model.inboxOpen ? props.inbox : detail ? props.detail : null)
    }

    function taskRank(task) {
      if (task.status === 'needs-decision' || task.attention?.length) return 0
      if (ACTIVE_RUN.has(task.status)) return 1
      return 2
    }

    function TaskList({ model, onOpen, onGoal, onGoalAction, onReply, onArtifact, onRecord, hidden }) {
      const [search, setSearch] = react.useState('')
      const [results, setResults] = react.useState(null)
      const query = search.trim()
      react.useEffect(() => {
        if (!query) return undefined
        let alive = true
        const timer = setTimeout(async () => {
          try {
            const data = await call(`/workbench?q=${encodeURIComponent(query)}`)
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
      const tasks = [...goals.values(), ...[...runs.values()].filter(run => !goals.has(run.goalId))]
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
            onOpen, onToggle: onGoal, onAction: onGoalAction, onReply, onArtifact, onRecord,
          })
          : h('section', { key: task.id, 'aria-label': task.goal },
            h(TaskRow, { task, project: nameFor(task), onClick: () => onOpen(task.id, task.parentSessionId) }),
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
          'aria-label': '项目文件夹绝对路径', placeholder: '项目文件夹绝对路径', onChange: event => setDraft(event.target.value),
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
      const labels = { answer: '提交回答', accept: '接受验收', retry: '再试一次', skip: '跳过', stop: '停止', continue: '继续' }
      return h('div', { className: 'dsa-attention-card' },
        h('div', { className: 'dsa-detail-q' }, item.question),
        item.reason ? h('div', { className: 'dsa-detail-label' }, item.reason) : null,
        item.source?.options?.length ? h('div', { className: 'dsa-goal-actions' },
          item.source.options.map(option => h('button', {
            key: option, type: 'button', className: 'dsa-chip', disabled: busy,
            onClick: () => onAction(goal.id, 'answer', { decisionId: item.id, answer: 'answer', note: option }),
          }, option))) : null,
        h('div', { className: 'dsa-answer-row' },
          h('input', { className: 'dsa-answer-input', value: note, placeholder: item.options.includes('answer') ? '写下你的回答' : '补充说明（可选）', onInput: event => setNote(event.target.value) }),
          item.options.map(answer => h('button', {
            key: answer, type: 'button', className: 'dsa-linkbtn',
            disabled: busy || (answer === 'answer' && !note.trim()),
            onClick: () => onAction(goal.id, 'answer', { decisionId: item.id, answer, note: note.trim() }),
          }, labels[answer] ?? answer))))
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

    function GoalCard({ goal, project, projectCwd, model, runs, onOpen, onToggle, onAction, onReply, onArtifact, onRecord }) {
      const rowRef = react.useRef(null)
      const [page, setPage] = react.useState(0)
      const [filter, setFilter] = react.useState('all')
      const [recordHint, setRecordHint] = react.useState('')
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
        .filter(fact => fact.taskId === goal.id && (!fact.expiresAt || fact.expiresAt > Date.now())) : []
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

    function ArtifactPreview({ model, onRetry, onReveal, onDownload }) {
      const [zoom, setZoom] = react.useState(false)
      const preview = model.preview
      const file = preview.item
      let content
      if (preview.kind === 'img') {
        const image = h('img', { className: 'dsa-preview-img', src: preview.url, alt: preview.name })
        content = ImageLightbox ? h('button', {
          type: 'button', className: 'dsa-preview-thumb', 'aria-label': `放大预览 ${preview.name}`,
          onClick: () => setZoom(true),
        }, image) : image
      } else if (preview.kind === 'html') {
        content = h('iframe', { className: 'dsa-preview-frame', sandbox: '', src: preview.url, title: preview.name })
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
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onReveal(file) }, '在文件夹中显示'),
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onDownload(file) }, '下载')),
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
        key: model.preview.url, model, onRetry: props.onRetryPreview, onReveal: props.onReveal, onDownload: props.onDownload,
      })
      const linked = (model.workbench?.inbox ?? []).filter(entry => entry.kind === 'decision')
        .map(entry => entry.item.source).filter(source => source?.runId === run.id)
      const linkedIds = new Set(linked.map(source => source.attentionId))
      const attention = (run.attention ?? []).filter(item => !linkedIds.has(item.id))
      const artifacts = artifactsOf(run)
      const workers = (run.subtasks ?? []).filter(task => task.childId)
      const running = ACTIVE_RUN.has(run.status)
      return h('div', { className: 'dsa-workbench-scroll', 'aria-label': '任务详情' },
        h('div', { className: 'dsa-run-actions' },
          h(TaskStatus, { task: run }),
          h('div', { className: 'dsa-goal-actions' },
            running || run.status === 'interrupted'
              ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onReply(run) }, '补充要求') : null,
            running ? h('button', {
              type: 'button', className: 'dsa-linkbtn dsa-stop-task',
              disabled: model.detailBusy, onClick: () => props.onCancelRun(run.id),
            }, '停止任务') : null)),
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
      const [railOpen, setRailOpen] = react.useState(false)
      const [workspaceOpen, setWorkspaceOpen] = react.useState(false)
      const workspaceRef = react.useRef(null)
      const composerApi = react.useRef(null)
      const view = railOpen ? (model.inboxOpen ? 'inbox' : 'tasks') : null
      const closeMenus = () => {
        setWorkspaceOpen(false)
      }
      const selectView = (next, toggle = false) => {
        closeMenus()
        if (toggle && view === next) {
          setRailOpen(false)
          return
        }
        setRailOpen(true)
        if (model.inboxOpen !== (next === 'inbox')) dispatch({ type: 'showInbox', open: next === 'inbox' })
      }
      const inspectRun = (runId, owner) => {
        selectView('tasks')
        return dispatch({ type: 'openRun', runId, owner })
      }
      const showGoal = goalId => {
        selectView('tasks')
        dispatch(goalId ? { type: 'openTask', taskId: goalId } : { type: 'focusGoal', goalId: null })
      }
      const replyRun = (run, phase) => {
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
          selectView('tasks', true)
        } else if (event.key === 'Escape') {
          if (workspaceOpen) closeMenus()
          else if (railOpen && model.workerSession) dispatch({ type: 'closeWorker' })
          else if (railOpen && model.preview) dispatch({ type: 'closePreview' })
          else if (railOpen && model.detail) dispatch({ type: 'closeRun' })
          else setRailOpen(false)
        }
      }
      if (model.phase === 'loading') {
        return h('div', { className: 'dsa-root' },
          h('div', { className: 'dsa-empty' },
            h('div', { className: 'dsa-note', role: 'status' }, '正在连接 Superagent 专属空间…')))
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
      const closeRail = () => setRailOpen(false)
      return h('div', { className: 'dsa-root', onKeyDown },
        h(Header, {
          view,
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
                onUpload: file => dispatch({ type: 'upload', file }),
                onSend: (text, contextMode) => dispatch({ type: 'send', text, contextMode }),
                onClearReply: () => dispatch({ type: 'reply' }),
              }))),
          railOpen ? h('button', {
            type: 'button', className: 'dsa-rail-scrim', tabIndex: -1,
            'aria-label': '关闭侧栏', onClick: closeRail,
          }) : null,
          railOpen ? h(Rail, {
            model, onClose: closeRail, onOpen: inspectRun, onGoal: showGoal, onReply: replyRun, onRecord: recordFact,
            onCloseRun: () => dispatch({ type: 'closeRun' }),
            onClosePreview: closePreview, onCloseWorker: closeWorker,
            onReadInbox: () => dispatch({ type: 'readInbox' }),
            onGoalAction: (goalId, action, body, owner) => dispatch({ type: 'goalAction', goalId, action, body, owner }),
            onArtifact: (run, item) => dispatch({ type: 'openWorkbenchArtifact', run, item }),
            inbox: h(Inbox, { model, dispatch }),
            detail: h(RunDetail, {
              model, onReply: replyRun, onInbox: () => selectView('inbox'),
              onOpenWorker: (runId, childId) => dispatch({ type: 'openWorker', runId, childId }),
              onCancelRun: runId => dispatch({ type: 'cancelRun', runId }),
              onInstruct: (runId, text, subtaskIndex) => dispatch({
                type: 'instructRun', runId, text, subtaskIndex, owner: model.detail?.parentSessionId,
              }),
              onAnswer: (runId, attentionId, answer) => dispatch({ type: 'answer', runId, attentionId, answer }),
              onArtifact: item => dispatch({ type: 'artifact', item }),
              onRetryPreview: () => dispatch({ type: 'retryPreview' }),
              onReveal: item => dispatch({ type: 'revealArtifact', item }),
              onDownload: item => dispatch({ type: 'downloadArtifact', item }),
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
      const sendRequest = react.useRef(null)
      modelRef.current = model

      const patch = updater => setModel(current => updater(current))

      async function refreshWorkbench() {
        const request = ++workbenchRequest.current
        const workbench = await call('/workbench')
        patch(current => {
          if (request !== workbenchRequest.current || current.sessionId !== workbench.sessionId) return current
          const run = workbench.runs?.find(item => item.id === current.detail?.id)
          const detail = run ? { ...run, report: run.reportTruncated && current.detail.report?.startsWith(run.report) ? current.detail.report : run.report } : current.detail
          return { ...current, workbench, detail }
        })
      }

      function applyRouter(current, router) {
        if (!router || router.revision < current.routerRevision) return current
        return { ...current, routerRevision: router.revision, messages: router.messages ?? [],
          contextFacts: router.facts ?? [], typing: router.pending > 0 }
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
        readInbox: async () => {
          const ids = modelRef.current.workbench?.inbox?.filter(entry => !entry.read).map(entry => entry.id) ?? []
          if (!ids.length) return
          await call('/notices/read', { method: 'POST', body: JSON.stringify({ ids }) })
          await refreshWorkbench().catch(() => {})
        },
        selectProject: ({ project }) => patch(current => ({ ...current, project })),
        chooseTask: async ({ requestId, target }) => {
          await call('/router/choose', { method: 'POST', body: JSON.stringify({ requestId, target }) })
          await refreshRouter().catch(() => {})
        },
        registerProject: async ({ cwd }) => {
          const data = await call('/projects', { method: 'POST', body: JSON.stringify({ cwd }) })
          patch(current => ({ ...current, project: data.project }))
          await refreshWorkbench().catch(() => {})
        },
        pickProject: async () => {
          const { cwd } = await call('/projects/pick', { method: 'POST', body: '{}' })
          if (cwd) await actions.registerProject({ cwd })
        },
        openWorkbenchArtifact: async ({ run, item }) => {
          if (await actions.openRun({ runId: run.id, owner: run.parentSessionId })) {
            await actions.artifact({ item: { ...item, owner: run.parentSessionId } })
          }
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
          const href = String(item.href ?? '')
          const owner = item.owner ?? modelRef.current.detail?.parentSessionId
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
            patch(current => current.preview?.url === url ? { ...current, previewBusy: false, previewError: `这个产物读不出来：${error.message}` } : current)
          }
        },
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
            patch(current => ({ ...current, previewBusy: false, previewError: `这个产物读不出来：${error.message}` }))
          }
        },
        closePreview: () => patch(current => ({ ...current, preview: null, previewText: '', previewError: '', previewBusy: false })),
        revealArtifact: async action => {
          const item = action.item ?? {}
          const owner = item.owner ?? modelRef.current.detail?.parentSessionId
          const query = `?path=${encodeURIComponent(item.href ?? '')}&runId=${encodeURIComponent(item.runId ?? '')}&owner=${encodeURIComponent(owner ?? '')}`
          await call(`/artifact/reveal${query}`, { method: 'POST', body: '{}' })
        },
        downloadArtifact: action => {
          const item = action.item ?? {}
          const owner = item.owner ?? modelRef.current.detail?.parentSessionId
          const url = `${API}/artifact?download=1&path=${encodeURIComponent(item.href ?? '')}&runId=${encodeURIComponent(item.runId ?? '')}`
            + `&owner=${encodeURIComponent(owner ?? '')}`
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener')
        },
        upload: async action => {
          const file = action.file ?? {}
          if (file.error) throw new Error(file.error)
          patch(current => ({ ...current, uploading: true }))
          try {
            const data = await call('/upload', {
              method: 'POST',
              body: JSON.stringify({ name: file.name, data: file.data, project: modelRef.current.project?.cwd }),
            })
            patch(current => ({ ...current, uploading: false, uploadInsert: data?.path ?? '' }))
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
        toast: action => patch(current => ({ ...current, toast: { kind: 'err', text: String(action.text ?? '') } })),
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
    } catch (error) {
      console.error('[dsh-superagent] client exports could not be published', error)
    }
    return exports
  },
})
