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
    const QuotePreview = pick('QuotePreview')
    const DetailDocument = pick('DetailDocument')
    const CodeBlock = pick('CodeBlock')
    const MISSING_PRIMITIVES = ['Button', 'MarkdownText', 'UserMessageBubble', 'StateDot', 'Tooltip',
      'DisclosureRow', 'TextShimmer', 'Toast', 'Input', 'Pill', 'Tag', 'FileTypeIcon',
      'QuotePreview', 'DetailDocument', 'CodeBlock']
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
      panel: ui?.IconPanelLeftOutlineRegular ?? ui?.IconPanelLeftOutlineMedium,
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
    /** Composer delivery behaviour: idle sends start a turn, running sends steer. */
    const RAIL_KEY = 'dsh-superagent.rail-open'
    function readRailOpen() {
      try {
        return window.localStorage.getItem(RAIL_KEY) !== '0'
      } catch (error) {
        return true
      }
    }
    function saveRailOpen(open) {
      try {
        window.localStorage.setItem(RAIL_KEY, open ? '1' : '0')
      } catch (error) {
        // Private mode or a sandboxed webview: the layout still works, it just
        // does not remember the choice.
      }
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
.dsa-root{--dsa-col:var(--dsh-chat-content-width,clamp(680px,calc(var(--dsh-conversation-column-width,100%) * .64),920px));--dsa-side:var(--dsh-composer-side-clearance,32px);display:flex;flex-direction:column;height:100%;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:22px}
/* Header geometry follows the host conversation header: 30px title cluster,
   padding 4/8, 28px utilities, hairline below (ConversationRoot.module.css:76,
   147-152 + InputBar.module.css:335-348). */
.dsa-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-height:40px;padding:10px 28px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsa-header-title{display:flex;align-items:center;gap:4px;min-width:0;height:30px;box-sizing:border-box;padding:4px 8px;color:inherit;font:inherit;font-size:14px;font-weight:500;line-height:20px;border:0;border-radius:var(--dsw-radius-sm);background:none;cursor:pointer}
.dsa-header-title:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-header-title span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-iconbtn{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsa-iconbtn svg{width:15px;height:15px}
.dsa-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-iconbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dsa-badge{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color);font-size:9px;line-height:14px;font-weight:600;text-align:center;box-sizing:border-box}
.dsa-body{position:relative;display:grid;grid-template-columns:clamp(106px,14%,162px) minmax(0,1fr) 0;grid-template-rows:minmax(0,1fr);flex:1;min-height:0;overflow:hidden}
.dsa-body[data-rail=open]{grid-template-columns:clamp(106px,14%,162px) minmax(0,1fr) clamp(224px,31%,352px)}
.dsa-main{grid-column:2;grid-row:1;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}
.dsa-project-nav{grid-column:1;grid-row:1;min-width:0;overflow:auto;border-right:.5px solid var(--dsw-alias-border-l3);padding:8px 6px}
.dsa-project-nav .dsa-rowitem[data-current=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-project-head{display:flex;align-items:center;justify-content:space-between;padding:10px 8px 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsa-project-add{display:grid;gap:4px;padding:5px 2px}
.dsa-project-add input{min-width:0;width:100%;box-sizing:border-box}
.dsa-msg .dsa-reply{opacity:0;display:block;margin:2px 0 0 auto}
.dsa-msg:hover .dsa-reply,.dsa-reply:focus-visible{opacity:1}
.dsa-quote{display:flex;gap:6px;align-items:center;margin:0 10px;padding:4px 7px;border-left:2px solid var(--dsw-alias-border-l3);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsa-quote span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-workbench{grid-column:3;grid-row:1;min-width:0;overflow:hidden;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}
.dsa-body[data-rail=closed] .dsa-workbench{visibility:hidden}
/* 48px header bar, 14/20 500, hairline below — the host workspace browser
   header (Rows.module.css:37). */
.dsa-workbench-head{display:flex;align-items:center;justify-content:space-between;gap:6px;flex:none;min-height:48px;padding:0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:14px;line-height:20px;font-weight:500}
.dsa-workbench-head form{display:flex;gap:4px;width:100%;min-width:0;padding:4px 0}
.dsa-workbench-head input{flex:1;min-width:0}
.dsa-workbench-scroll{flex:1;min-height:0;overflow:auto;padding:8px 10px}
.dsa-workbench-section{padding:8px 0}
.dsa-workbench-section+.dsa-workbench-section{border-top:.5px solid var(--dsw-alias-border-l3)}
.dsa-workbench-section h3{margin:0 8px 4px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.dsa-workbench-empty{padding:4px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsa-workbench .dsa-detail{position:relative;inset:auto;width:auto;max-width:none;flex:1;min-height:0;box-shadow:none;border:0;border-radius:0;background:transparent}
.dsa-workbench .dsa-detail-body{min-height:0}
@media(max-width:740px){.dsa-body[data-rail=open]{grid-template-columns:clamp(106px,14%,162px) minmax(0,1fr) 0}.dsa-workbench{position:absolute;grid-column:1/-1;inset:0 0 0 auto;width:min(300px,72%);z-index:10;background:var(--dsw-alias-bg-base)}.dsa-scroll{padding:0 14px}}
.dsa-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;margin-right:2px;padding:0 32px;scrollbar-gutter:stable}
.dsa-scroll::-webkit-scrollbar{width:10px}
.dsa-scroll::-webkit-scrollbar-thumb{border-radius:5px;background:var(--dsw-alias-scrollbar-bg-l1)}
.dsa-flow{width:min(100%,var(--dsa-col));margin:0 auto;padding:16px 0 8px;box-sizing:border-box}
/* New-space hero: 26/32 500 headline and a 12px stack, the host new-session
   hero (HeroShell.module.css:15-45, 122-130). */
.dsa-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:56px 24px;text-align:center}
.dsa-hero-title{font-size:26px;line-height:32px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsa-hero-desc{max-width:420px;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary)}
/* Composer card: InputBar.module.css:54-86 (radius panel, elevation-soft
   hairline, 8px top pad, 12px stack gap) and :273-289/335-417 (toolbar row,
   28px attach circle, 34px send circle). */
.dsa-composer{flex:none;padding:4px var(--dsa-side) 4px;background:var(--dsw-alias-bg-base)}
.dsa-card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,calc(var(--dsa-col) + 32px));margin:0 auto;padding-top:8px;border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft)}
.dsa-input{box-sizing:border-box;width:100%;min-height:36px;max-height:var(--dsh-composer-text-max-height,336px);padding:4px 8px 0 14px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));caret-color:var(--dsw-alias-state-business-primary);resize:none;overflow-y:auto}
.dsa-input::placeholder{color:var(--dsw-alias-label-caption)}
.dsa-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:2px 8px 6px;min-width:0}
.dsa-trailing{display:flex;align-items:center;min-width:0;gap:12px}
.dsa-trailing{margin-left:auto;flex:none}
.dsa-goals{flex:none;width:min(100%,var(--dsa-col));max-height:40vh;overflow:auto;margin:0 auto;padding:0 0 8px}
.dsa-goals details{margin:4px 0;padding:6px 8px}
.dsa-goals summary{cursor:pointer;overflow-wrap:anywhere}
.dsa-goal-phase{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0}
.dsa-goal-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.dsa-instruction{display:grid;gap:6px}
.dsa-add{display:grid;place-items:center;flex:none;width:28px;height:28px;border:0;border-radius:999px;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsa-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
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
.dsa-approvals{display:flex;flex-direction:column;gap:8px;width:min(calc(100% - 64px),var(--dsa-col));margin:0 auto;padding:8px 0 12px}
/* Approval takeover: ApprovalPanel.module.css:1-18 (warn-secondary border,
   xl radius, input-major fill, lv2 shadow), :20-29 strip, :31-46 body,
   :155-168 command + action row. */
.dsa-approval{display:flex;flex-direction:column;overflow:hidden;width:100%;border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2)}
.dsa-approval-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:13px;line-height:18px}
.dsa-approval-main{display:flex;flex-direction:column;gap:6px;padding:12px 16px 0}
.dsa-approval-title{font-size:15px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.dsa-approval-body{font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);word-break:break-all;overflow-wrap:anywhere}
.dsa-approval-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding:14px 16px}
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
.dsa-sessions{position:absolute;top:44px;right:12px;z-index:30;display:flex;flex-direction:column;width:min(300px,80vw);max-height:min(60vh,440px);padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base)));box-shadow:var(--dsw-elevation-panel)}
.dsa-sessions-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 8px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsa-sessions-new,.dsa-linkbtn{border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;padding:2px 6px;border-radius:var(--dsw-radius-sm)}
.dsa-sessions-new:hover,.dsa-linkbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-sessions-list{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto}
.dsa-session-row{cursor:pointer}
.dsa-session-row[data-current=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.dsa-session-meta,.dsa-session-row .dsa-rowtime{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsa-sessions-foot{display:flex;justify-content:flex-end;padding-top:6px}
/* Right-hand detail surface: 48px bar + 16px body rhythm, the host panel
   header geometry (Rows.module.css:37) and section spacing. */
.dsa-detail{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.dsa-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:48px;padding:0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsa-detail-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:500}
.dsa-detail-body{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px}
.dsa-detail-sec{display:flex;flex-direction:column;gap:6px}
.dsa-detail-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsa-detail-item{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
.dsa-detail-q{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);white-space:pre-wrap}
.dsa-answer-row{display:flex;align-items:center;gap:8px}
.dsa-answer-row > span{flex:1;min-width:0}
.dsa-answer-input{flex:1;min-width:0;box-sizing:border-box;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}
.dsa-answer-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsa-artifact-link{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;overflow:hidden}
.dsa-artifact-link:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-artifact-link svg{flex:none}
.dsa-artifact-link span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Attention / plan card: PlanReviewPanel.module.css:1-21 frame + surface,
   :28-39 tinted strip, :64-88 summary, :41-62 footer actions. */
.dsa-attention{display:flex;flex-direction:column;gap:8px;width:min(calc(100% - 64px),var(--dsa-col));margin:0 auto;padding:6px 0 10px}
.dsa-attention-card{display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;width:100%;--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);border:0;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary)}
.dsa-attention-head{display:flex;align-items:center;flex:none;gap:8px;padding:12px 16px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:14px;line-height:20px}
.dsa-attention-head .dsa-session-meta{margin-left:auto;color:var(--dsw-alias-state-warn-primary)}
.dsa-attention-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.dsa-attention-summary{min-width:0;padding:14px 16px 12px;display:flex;flex-direction:column;gap:8px}
.dsa-attention-title{font-size:15px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis}
.dsa-attention-desc{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}
.dsa-attention-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 16px 12px}
.dsa-attention-options{display:flex;flex-wrap:wrap;gap:8px}
.dsa-artifact-row{display:flex;align-items:center;gap:4px}
.dsa-artifact-row .dsa-artifact-link{flex:1;min-width:0;overflow:hidden}
.dsa-preview{display:flex;flex-direction:column;gap:12px;padding:12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base)}
.dsa-preview-img{display:block;max-width:100%;border-radius:var(--dsw-radius-sm)}
.dsa-preview-frame{width:100%;height:320px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.dsa-preview-text{max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsa-chip{height:28px;padding:0 12px;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dsa-chip:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
`

    /** Inject the sheet once; the panel is mounted once per window. */
    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById(STYLE_ID)) return
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
        const error = new Error(body?.message ?? `HTTP ${response.status}`)
        error.hint = typeof body?.hint === 'string' ? body.hint : ''
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
        workbenchRun: null,
        workerSession: null,
        reply: null,
        goalBusy: false,
        toast: null,
        canceling: false,
        approvalBusy: {},
        typing: false,
        sending: false,
        currentId: null,
        sessions: [],
        sessionsOpen: false,
        sessionsBusy: false,
        detail: null,
        detailBusy: false,
        answerDraft: '',
        preview: null,
        previewText: '',
        previewError: '',
        previewBusy: false,
        uploadInsert: '',
        uploading: false,
        unread: 0,
        seenAttention: [],
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
            workbenchRun: null,
            workerSession: null,
            reply: null,
            approvalBusy: {},
            currentId: null,
            typing: false,
            canceling: false,
            sessionsOpen: false,
            detail: null,
            answerDraft: '',
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
            return { ...model, approvals: [...others, approval], unread: (model.unread ?? 0) + 1 }
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
          const seen = Array.isArray(model.seenAttention) ? model.seenAttention : []
          const ids = new Set([
            ...runs.flatMap(run => (run.attention ?? []).map(item => `${run.id}:${item.id}`)),
            ...goals.flatMap(goal => (goal.decisions ?? []).map(item => item.source?.attentionId
              ? `${item.source.runId}:${item.source.attentionId}` : `${goal.id}:${item.id}`)),
          ])
          const fresh = [...ids].filter(id => !seen.includes(id))
          return {
            ...model,
            runs,
            goals,
            detail,
            unread: model.unread + fresh.length,
            seenAttention: fresh.length > 0 ? [...seen, ...fresh].slice(-200) : seen,
          }
        }
        case 'canceling':
          return { ...model, canceling: true }
        default:
          return model
      }
    }

    function Header(props) {
      const { title, railOpen, onToggleRail, onToggleSessions, sessionsOpen, unread } = props
      const toggleLabel = railOpen ? '收起工作台' : '打开工作台'
      return h('header', { className: 'dsa-header' },
        h('button', {
          type: 'button', className: 'dsa-header-title', title: `${toggleLabel}（Ctrl+Shift+B）`,
          'aria-label': `${title}，${toggleLabel}`, 'aria-expanded': railOpen, 'aria-controls': 'dsa-workbench',
          onClick: onToggleRail,
        }, h('span', null, title), h(Icon, { of: 'panel', size: 14 })),
        tipped(unread ? `会话（${unread} 个新问题）` : '会话', h('button', {
          type: 'button', className: 'dsa-iconbtn', 'aria-label': '会话', 'aria-expanded': sessionsOpen,
          onClick: onToggleSessions,
        }, h(Icon, { of: 'clock' }),
        unread ? h('span', { className: 'dsa-badge' }, unread > 9 ? '9+' : String(unread)) : null), 'bottom'))
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
      return h('div', { className: 'dsa-assistant' }, children)
    }

    function Transcript(props) {
      const rows = []
      for (const message of props.model.messages) {
        rows.push(h('div', { key: message.id, className: 'dsa-msg' },
          message.role === 'user'
            ? h(UserMessage, { message })
            : h(AssistantMessage, { message }),
          props.onReply && message.text && !message.streaming && !message.pending ? h('button', {
            type: 'button', className: 'dsa-linkbtn dsa-reply', onClick: () => props.onReply?.(message),
            'aria-label': '回复这条消息', title: '回复这条消息',
          }, '↩ 回复') : null))
      }
      if (props.model.typing) {
        rows.push(h('div', { key: 'typing', className: 'dsa-typing' },
          StateDot ? h(StateDot, { state: 'ongoing', size: 10 }) : null,
          TextShimmer ? h(TextShimmer, { active: true }, '正在生成…') : '正在生成…'))
      }
      if (rows.length === 0) {
        rows.push(h('div', { key: 'hero', className: 'dsa-hero' },
          h('div', { className: 'dsa-hero-title' }, PANEL_LABEL),
          h('div', { className: 'dsa-hero-desc' }, '把一个目标拆成可并行的子任务，交付一份合并报告；重启后还能接着跑。'),
          h('div', { className: 'dsa-hint' }, '在下面描述目标，或直接发消息。')))
      }
      return h('div', {
        className: 'dsa-scroll',
        ref: props.scrollRef,
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
            h(Button ?? 'button', {
              variant: Button ? 'outline' : undefined,
              className: Button ? undefined : 'dsa-add',
              type: Button ? undefined : 'button',
              disabled: busy,
              onClick: () => props.onDecide(entry.id, 'reject'),
            }, '拒绝'),
            h(Button ?? 'button', {
              variant: Button ? 'primary' : undefined,
              type: Button ? undefined : 'button',
              disabled: busy,
              onClick: () => props.onDecide(entry.id, 'allow'),
            }, '允许一次'),
            h(Button ?? 'button', {
              variant: Button ? 'outline' : undefined,
              type: Button ? undefined : 'button',
              disabled: busy,
              onClick: () => props.onDecide(entry.id, 'allow-tool'),
            }, '本会话都放行'))))
      }))
    }

    function Composer(props) {
      const { disabled, onSend } = props
      const [text, setText] = react.useState('')
      const areaRef = react.useRef(null)
      const fileRef = react.useRef(null)

      react.useEffect(() => {
        if (props.model.reply) areaRef.current?.focus()
      }, [props.model.reply?.id])

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

      const submit = () => {
        const value = text.trim()
        if (!value || disabled) return
        setText('')
        if (areaRef.current) areaRef.current.style.height = 'auto'
        onSend(value)
      }

      return h('div', { className: 'dsa-composer' },
        h('div', { className: 'dsa-card' },
          props.model.reply ? (QuotePreview
            ? h(QuotePreview, {
              text: props.model.reply.text,
              removal: { label: '取消引用', onRemove: props.onClearReply },
            })
            : h('div', { className: 'dsa-quote' },
              h('span', null, props.model.reply.text),
              h('button', { type: 'button', className: 'dsa-linkbtn', onClick: props.onClearReply, 'aria-label': '取消引用' }, '×'))) : null,
          h('textarea', {
            ref: areaRef,
            className: 'dsa-input',
            rows: 1,
            value: text,
            placeholder: '发消息或委托任务…',
            disabled,
            onInput: event => {
              setText(event.target.value)
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
            tipped('添加文件到工作区', h('button', {
              type: 'button',
              className: 'dsa-add',
              'aria-label': '添加文件',
              disabled: disabled || props.uploading === true,
              onClick: pickFile,
            }, props.uploading === true ? h('span', { className: 'dsa-spin' }) : h(Icon, { of: 'attach', size: 16 })), 'top'),
            h('div', { className: 'dsa-trailing' },
              Button
                ? h(Button, {
                  variant: 'ghost',
                  size: 'sm',
                  disabled: disabled || !text.trim(),
                  onClick: async () => {
                    const value = text.trim()
                    if (value && await props.onGoal(value)) setText('')
                  },
                }, '委托')
                : h('button', {
                  type: 'button',
                  className: 'dsa-linkbtn',
                  disabled: disabled || !text.trim(),
                  onClick: async () => {
                    const value = text.trim()
                    if (value && await props.onGoal(value)) setText('')
                  },
                }, '委托'),
              props.running
                ? tipped('停止本轮', h('button', {
                  type: 'button',
                  className: 'dsa-send',
                  'data-mode': 'stop',
                  'aria-label': '停止本轮',
                  disabled: props.canceling === true,
                  onClick: () => props.onStop?.(),
                }, props.canceling ? h('span', { className: 'dsa-spin' }) : h(Icon, { of: 'stop', size: 10 })), 'top')
                : null,
              !props.running || text.trim() ? tipped('发送', h('button', {
                  type: 'button',
                  className: 'dsa-send',
                  'aria-label': '发送',
                  disabled: disabled || !text.trim(),
                  onClick: submit,
                }, h(Icon, { of: 'send', size: 15 })), 'top') : null))))
    }

    /** The assistant workbench follows the selected project and its task runs. */
    function Rail(props) {
      const { model } = props
      const [nameDraft, setNameDraft] = react.useState(null)
      const workbench = model.workbench?.sessionId === model.sessionId ? model.workbench : null
      const project = workbench?.project
      const name = workbench?.name || PANEL_LABEL
      const byId = new Map([...(workbench?.runs ?? []), ...model.runs].map(run => [run.id, run]))
      const runs = [...byId.values()]
      const selected = model.workbenchRun ? byId.get(model.workbenchRun) : null
      const artifactRows = runs.flatMap(run => artifactsOf(run).map(item => ({ run, item }))).slice(0, 16)
      const section = (title, content, emptyLabel) => h('section', { className: 'dsa-workbench-section' },
        h('h3', null, title), content.length ? content : h('div', { className: 'dsa-workbench-empty' }, emptyLabel))
      const label = project ? '项目详情' : '工作台'
      let heading = h('span', { title: project?.cwd }, label)
      let rename = null
      if (selected || model.detail) {
        heading = h('button', { type: 'button', className: 'dsa-linkbtn', onClick: props.onCloseRun }, `‹ ${label}`)
      } else if (!project && nameDraft === null) {
        rename = h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => setNameDraft(name), title: '编辑助理名称' }, '改名')
      } else if (!project) {
        heading = h('form', {
          onSubmit: async event => {
            event.preventDefault()
            if (nameDraft.trim() && await props.onName(nameDraft.trim())) setNameDraft(null)
          },
        }, h('input', {
          className: 'dsa-answer-input', 'aria-label': '助理名称', maxLength: 32, value: nameDraft,
          onChange: event => setNameDraft(event.target.value), onKeyDown: event => { if (event.key === 'Escape') setNameDraft(null) },
        }), h('button', { type: 'submit', className: 'dsa-linkbtn' }, '保存'))
      }
      return h('aside', { id: 'dsa-workbench', className: 'dsa-workbench', 'aria-label': label },
        h('div', { className: 'dsa-workbench-head' }, heading, rename),
        model.detail ? props.detail : selected ? h('div', { className: 'dsa-workbench-scroll' },
          h('h3', null, selected.goal),
          h('p', { className: 'dsa-detail-label' }, STATUS_LABELS[selected.status] ?? selected.status),
          h('div', { className: 'dsa-md-plain' }, selected.output ?? selected.report ?? ''),
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onOpenSession(selected) }, '打开会话'))
          : h('div', { className: 'dsa-workbench-scroll' },
            section(project ? '项目任务' : '最近任务', runs.map(run => {
              const waiting = Array.isArray(run.attention) && run.attention.length > 0
              return h('button', {
                key: run.id, type: 'button', className: 'dsa-rowitem', title: run.goal ?? '查看任务详情',
                'data-status': waiting ? 'waiting' : run.status,
                onClick: () => props.onOpen?.(run.id),
              }, StateDot
                ? h(StateDot, { state: statusDot(waiting, run.status), size: 10 })
                : h('span', { className: 'dsa-rowdot', 'data-status': waiting ? 'waiting' : run.status }),
              h('span', { className: 'dsa-rowtitle' }, run.goal ?? '调度中的会话'),
              h('span', { className: 'dsa-rowtime' }, waiting ? '等你决定' : (STATUS_LABELS[run.status] ?? run.status)))
            }), '暂无任务'),
            section(project ? '项目产物' : '工作产物', artifactRows.map(({ run, item }) => h('button', {
              key: `${run.id}:${item.href}`, type: 'button', className: 'dsa-artifact-link', title: item.href,
              onClick: () => props.onArtifact(run, item),
            }, FileTypeIcon ? h(FileTypeIcon, { path: item.href, size: 16 }) : null,
            h('span', null, item.name))), '暂无产物')))
    }

    function ProjectNav({ workbench, onSelect, onAdd, onPick }) {
      const [draft, setDraft] = react.useState(null)
      const project = workbench?.project
      const choose = (entry, label, current) => h('button', {
        key: entry?.cwd ?? 'global', type: 'button', className: 'dsa-rowitem', 'data-current': current,
        title: entry?.cwd ?? '全局助理', onClick: () => onSelect(entry),
      }, h('span', { className: 'dsa-rowtitle' }, label))
      return h('nav', { className: 'dsa-project-nav', 'aria-label': '全局助理和项目' },
        choose(null, '全局助理', !project),
        h('div', { className: 'dsa-project-head' }, h('span', null, '项目'),
          h('button', { type: 'button', className: 'dsa-linkbtn', 'aria-label': '添加项目', onClick: async () => {
            if (workbench?.canPickProject && await onPick()) return
            setDraft(draft === null ? '' : null)
          } }, '+')),
        draft === null ? null : h('form', { className: 'dsa-project-add', onSubmit: async event => {
          event.preventDefault()
          if (draft.trim() && await onAdd(draft.trim())) setDraft(null)
        } }, h('input', { className: 'dsa-answer-input', placeholder: '项目文件夹绝对路径', value: draft, onChange: event => setDraft(event.target.value) }),
        h('button', { type: 'submit', className: 'dsa-linkbtn', disabled: !draft.trim() }, '打开项目')),
        (workbench?.projects ?? []).map(entry => choose(entry, entry.name, entry.cwd === project?.cwd)))
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

    /** History and the "new conversation" entry, opened from the title bar. */
    function SessionsPanel(props) {
      const { model } = props
      if (!model.sessionsOpen) return null
      const sessions = Array.isArray(model.sessions) ? model.sessions : []
      const busy = model.sessionsBusy === true
      return h('div', { className: 'dsa-sessions', role: 'dialog', 'aria-label': '会话' },
        h('div', { className: 'dsa-sessions-head' },
          h('span', null, busy ? '会话 · 读取中' : '会话'),
          Button
            ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => props.onNew?.() }, '新对话')
            : h('button', { type: 'button', className: 'dsa-sessions-new', disabled: busy, onClick: () => props.onNew?.() }, '新对话')),
        h('div', { className: 'dsa-sessions-list' },
          sessions.length === 0
            ? h('div', { className: 'dsa-hint', style: { padding: '8px' } }, '还没有历史会话')
            : sessions.map(item => h('button', {
              key: item.sessionId,
              type: 'button',
              className: 'dsa-rowitem dsa-session-row',
              'data-current': item.sessionId === model.sessionId ? 'true' : 'false',
              disabled: busy,
              onClick: () => props.onSwitch?.(item.sessionId),
            },
            h('span', { className: 'dsa-session-title' }, item.title || item.first || item.sessionId.slice(0, 12)),
            h('span', { className: 'dsa-session-meta' }, `${item.runs ?? 0} 轮`)))),
        h('div', { className: 'dsa-sessions-foot' },
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onClose?.() }, '关闭')))
    }

    const STATUS_LABELS = {
      planning: '规划中', queued: '排队中', running: '进行中', aggregating: '汇总中', verifying: '验收中',
      ready: '待开始', pending: '待开始', 'needs-decision': '等你决定', completed: '完成', partial: '部分完成',
      paused: '已暂停', failed: '失败', stopped: '已停止', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过',
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
        h('div', { className: 'dsa-answer-row' },
          h('input', { className: 'dsa-answer-input', value: note, placeholder: item.options.includes('answer') ? '写下你的回答' : '补充说明（可选）', onInput: event => setNote(event.target.value) }),
          item.options.map(answer => h('button', {
            key: answer, type: 'button', className: 'dsa-linkbtn',
            disabled: busy || (answer === 'answer' && !note.trim()),
            onClick: () => onAction(goal.id, 'answer', { decisionId: item.id, answer, note: note.trim() }),
          }, labels[answer] ?? answer))))
    }

    function GoalCards({ model, onOpen, onAction }) {
      if (!model.goals.length) return null
      return h('section', { className: 'dsa-goals', 'aria-label': '委托的目标' },
        model.goals.map(goal => {
          const active = ['planning', 'running', 'needs-decision'].includes(goal.status)
          const paused = goal.status === 'paused'
          const completed = goal.phases.filter(phase => phase.status === 'completed').length
          const button = (action, label) => h('button', {
            type: 'button', className: 'dsa-linkbtn', disabled: model.goalBusy,
            onClick: () => onAction(goal.id, action),
          }, label)
          return h('div', { key: goal.id },
            h('details', { className: 'dsa-attention-card' },
              h('summary', null, `${STATUS_LABELS[goal.status] ?? goal.status} · ${completed}/${goal.phases.length} · ${goal.goal}`),
              goal.reason ? h('div', { className: 'dsa-detail-label' }, goal.reason) : null,
              goal.phases.map(phase => h('div', { key: phase.id, className: 'dsa-goal-phase' },
                h('span', null, `${phase.title} · ${STATUS_LABELS[phase.status] ?? phase.status}`),
                h('div', { className: 'dsa-goal-actions' },
                  phase.runId ? h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => onOpen(phase.runId) },
                    phase.status === 'completed' ? '产物与报告' : '查看工作线') : null,
                  goal.status !== 'needs-decision' && ['failed', 'skipped'].includes(phase.status) ? h('button', {
                    type: 'button', className: 'dsa-linkbtn', disabled: model.goalBusy,
                    onClick: () => onAction(goal.id, 'retry_phase', { phaseId: phase.id }),
                  }, '重试阶段') : null))),
              h('div', { className: 'dsa-goal-actions' },
                active && goal.status !== 'needs-decision' ? button('pause', '暂停新阶段') : null,
                paused ? button('resume', '继续') : null,
                active || paused ? button('cancel', '取消目标') : null)),
            goal.decisions.map(item => h(GoalDecision, { key: item.id, goal, item, onAction, busy: model.goalBusy })))
        }))
    }

    function ownedRunQuestions(goals) {
      return new Set(goals.flatMap(goal => goal.decisions.map(item => `${item.source?.runId}:${item.source?.attentionId}`)))
    }

    /** One delegated run: status, questions waiting for the user, artifacts. */
    function RunDetail(props) {
      const { model } = props
      const run = model.detail
      if (!run) return null
      if (model.workerSession) {
        const worker = model.workerSession
        return h('section', { className: 'dsa-detail', 'aria-label': '工作线原会话' },
          h('div', { className: 'dsa-detail-head' },
            h('span', { className: 'dsa-detail-title' }, worker.title ?? '工作线原会话'),
            h('button', { type: 'button', className: 'dsa-linkbtn', onClick: props.onCloseWorker }, '返回任务')),
          worker.transcript.messages.length ? h(Transcript, { model: worker.transcript })
            : h('div', { className: 'dsa-workbench-empty' }, '暂无会话记录'))
      }
      const ownedQuestions = ownedRunQuestions(model.goals)
      const attention = (run.attention ?? []).filter(item => !ownedQuestions.has(`${run.id}:${item.id}`))
      const artifacts = artifactsOf(run)
      const busy = model.detailBusy === true
      return h('div', { className: 'dsa-detail', role: 'dialog', 'aria-label': '任务详情' },
        h('div', { className: 'dsa-detail-head' },
          h('span', { className: 'dsa-detail-title' }, run.goal ?? '任务详情'),
          ACTIVE_RUN.has(run.status) ? h('button', {
            type: 'button',
            className: 'dsa-linkbtn',
            onClick: () => props.onCancelRun?.(run.id),
          }, '停止任务') : null),
        h('div', { className: 'dsa-detail-body' },
          (run.subtasks ?? []).some(task => task.childId) ? h('div', { className: 'dsa-detail-sec' },
            h('div', { className: 'dsa-detail-label' }, '工作线会话'),
            (run.subtasks ?? []).filter(task => task.childId).map(task => h('div', { key: task.childId, className: 'dsa-goal-phase' },
              h('span', null, task.title),
              h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onOpenWorker(run.id, task.childId) }, '打开会话')))) : null,
          model.preview
            ? h('div', { className: 'dsa-detail-sec dsa-preview' },
              h('div', { className: 'dsa-detail-head' },
                h('span', { className: 'dsa-detail-title' }, model.preview.name),
                h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onClosePreview?.() }, '关闭预览')),
              model.preview.kind === 'img'
                ? h('img', { className: 'dsa-preview-img', src: model.preview.url, alt: model.preview.name })
                : model.preview.kind === 'html'
                  ? h('iframe', {
                    className: 'dsa-preview-frame',
                    sandbox: '',
                    src: model.preview.url,
                    title: model.preview.name,
                  })
                  : model.preview.kind === 'md' && DetailDocument
                    ? h(DetailDocument, {
                      state: model.previewBusy
                        ? { status: 'loading' }
                        : model.previewError
                          ? { status: 'error', message: model.previewError }
                          : { status: 'found', markdown: model.previewText },
                      labels: DETAIL_LABELS,
                      onRetry: () => props.onRetryPreview?.(),
                    })
                    : h('div', { className: 'dsa-preview-text' },
                      model.previewBusy ? '读取中…' : (model.previewError || model.previewText)))
            : null,
          h('div', { className: 'dsa-detail-sec' },
            h('div', { className: 'dsa-detail-label' }, '状态'),
            h('div', { className: 'dsa-detail-q' }, `${run.status ?? '未知'}${run.startedAt ? ` · ${run.startedAt}` : ''}`)),
          h(InstructionForm, { key: run.id, run, onInstruct: props.onInstruct }),
          attention.length > 0
            ? h('div', { className: 'dsa-detail-sec' },
              h('div', { className: 'dsa-detail-label' }, '等你决定'),
              attention.map(item => h('div', { key: item.id, className: 'dsa-detail-item' },
                h('div', { className: 'dsa-detail-q' }, item.question ?? '有一个问题需要你回答'),
                h('div', { className: 'dsa-answer-row' },
                  Input
                    ? h(Input, {
                      value: model.answerDraft,
                      placeholder: '写下你的回答',
                      onChange: event => props.onDraft?.(event.target.value),
                      onKeyDown: event => {
                        if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                          event.preventDefault()
                          props.onAnswer?.(run.id, item.id, model.answerDraft)
                        }
                      },
                    })
                    : h('input', {
                      className: 'dsa-answer-input',
                      value: model.answerDraft,
                      placeholder: '写下你的回答',
                      onChange: event => props.onDraft?.(event.target.value),
                      onKeyDown: event => {
                        if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                          event.preventDefault()
                          props.onAnswer?.(run.id, item.id, model.answerDraft)
                        }
                      },
                    }),
                  h(Button ?? 'button', {
                    variant: Button ? 'primary' : undefined,
                    type: Button ? undefined : 'button',
                    disabled: busy || !String(model.answerDraft ?? '').trim(),
                    onClick: () => props.onAnswer?.(run.id, item.id, model.answerDraft),
                  }, '回答')))))
            : null,
          artifacts.length > 0
            ? h('div', { className: 'dsa-detail-sec' },
              h('div', { className: 'dsa-detail-label' }, '产物'),
              artifacts.map(item => h('div', { key: item.href, className: 'dsa-artifact-row' },
                h('button', {
                  type: 'button',
                  className: 'dsa-artifact-link',
                  onClick: () => props.onArtifact?.(item),
                }, FileTypeIcon ? h(FileTypeIcon, { path: item.href, size: 16 }) : null, h('span', null, item.name)),
                h('button', {
                  type: 'button',
                  className: 'dsa-linkbtn',
                  onClick: () => props.onReveal?.(item),
                }, '在文件夹中显示'),
                h('button', {
                  type: 'button',
                  className: 'dsa-linkbtn',
                  onClick: () => props.onDownload?.(item),
                }, '下载'))))
            : h('div', { className: 'dsa-detail-sec' },
              h('div', { className: 'dsa-detail-label' }, '产物'),
              h('div', { className: 'dsa-hint' }, '这条任务还没有报告产物')),
          run.output ? h('div', { className: 'dsa-detail-sec' },
            h('div', { className: 'dsa-detail-label' }, '交付内容'),
            h('div', { className: 'dsa-md-plain' }, run.output)) : null,
          run.report
            ? h('div', { className: 'dsa-detail-sec' },
              run.output ? h('details', null, h('summary', null, '验收报告'), h('div', { className: 'dsa-md-plain' }, run.report))
                : h('div', { className: 'dsa-md-plain' }, run.report))
            : null))
    }

    /**
     * Questions that block a run, shown where the user is already typing.
     * A plan confirmation is the same shape with options, so it renders as
     * one-tap chips instead of a yes/no dialog of its own.
     */
    function AttentionCards(props) {
      const { model } = props
      const entries = []
      const ownedQuestions = ownedRunQuestions(model.goals)
      for (const run of Array.isArray(model.runs) ? model.runs : []) {
        for (const item of Array.isArray(run.attention) ? run.attention : []) {
          if (item?.id && !ownedQuestions.has(`${run.id}:${item.id}`)) entries.push({ run, item })
        }
      }
      if (entries.length === 0) return null
      return h('div', { className: 'dsa-attention' },
        entries.map(({ run, item }) => {
          const options = Array.isArray(item.options) ? item.options : []
          const draft = String(model.answerDraft ?? '')
          const submit = () => props.onAnswer?.(run.id, item.id, draft)
          const field = Input
            ? h(Input, {
              value: model.answerDraft,
              placeholder: options.length > 0 ? '或者直接写别的回答' : '写下你的回答',
              onChange: event => props.onDraft?.(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  submit()
                }
              },
            })
            : h('input', {
              className: 'dsa-answer-input',
              value: model.answerDraft,
              placeholder: options.length > 0 ? '或者直接写别的回答' : '写下你的回答',
              onChange: event => props.onDraft?.(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  submit()
                }
              },
            })
          return h('div', { key: `${run.id}:${item.id}`, className: 'dsa-attention-card' },
            h('div', { className: 'dsa-attention-head' },
              StateDot ? h(StateDot, { state: 'warning', size: 10 }) : h('span', { className: 'dsa-attention-dot' }),
              h('span', null, item.source === 'plan' ? '计划确认' : '等你决定'),
              h('span', { className: 'dsa-session-meta' }, run.goal ?? '')),
            h('div', { className: 'dsa-attention-summary' },
              h('div', { className: 'dsa-attention-title' }, item.question ?? '有一个问题需要你回答'),
              item.reason ? h('div', { className: 'dsa-attention-desc' }, item.reason) : null,
              h('div', { className: 'dsa-answer-row' },
                field,
                h(Button ?? 'button', {
                  variant: Button ? 'primary' : undefined,
                  size: Button ? 'sm' : undefined,
                  type: Button ? undefined : 'button',
                  disabled: !draft.trim(),
                  onClick: submit,
                }, '回答'))),
            options.length > 0
              ? h('div', { className: 'dsa-attention-footer' },
                h('div', { className: 'dsa-attention-options' },
                  options.map(option => (Pill
                    ? h(Pill, { key: option, onClick: () => props.onAnswer?.(run.id, item.id, option) }, option)
                    : h('button', {
                      key: option,
                      type: 'button',
                      className: 'dsa-chip',
                      onClick: () => props.onAnswer?.(run.id, item.id, option),
                    }, option)))))
              : null)
        }))
    }

    function Seat(props) {
      const { model, dispatch } = props
      // Hooks must run before the loading/error early returns.
      const [railOpen, setRailOpen] = react.useState(readRailOpen)
      const toggleRail = () => {
        setRailOpen(current => {
          const next = !current
          saveRailOpen(next)
          return next
        })
      }
      const inspectRun = runId => {
        if (!railOpen) {
          setRailOpen(true)
          saveRailOpen(true)
        }
        return dispatch({ type: 'openRun', runId })
      }
      react.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onKey = event => {
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === 'b') {
            event.preventDefault()
            setRailOpen(current => {
              const next = !current
              saveRailOpen(next)
              return next
            })
            return
          }
          if (event.key === 'Escape' && railOpen) {
            setRailOpen(false)
            saveRailOpen(false)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [railOpen])
      if (model.phase === 'loading') {
        return h('div', { className: 'dsa-root' },
          h('div', { className: 'dsa-empty' },
            h('div', { className: 'dsa-note' }, '正在连接 Superagent 专属空间…')))
      }
      if (model.phase === 'error') {
        return h('div', { className: 'dsa-root' },
          h('div', { className: 'dsa-empty' },
            h('div', { className: 'dsa-note' }, model.reason),
            h('div', { className: 'dsa-hint' }, model.hint || '在「高级」里确认控制台端口已开启（consolePort），或重试。'),
            h(Button ?? 'button', {
              variant: Button ? 'outline' : undefined,
              type: Button ? undefined : 'button',
              onClick: () => dispatch({ type: 'retry' }),
            }, '重试')))
      }
      const chatUnavailable = model.capabilities?.chat === false
      return h('div', { className: 'dsa-root', 'data-rail': railOpen ? 'open' : 'closed' },
        h(Header, {
          title: model.workbench?.project?.name || model.workbench?.name || PANEL_LABEL,
          railOpen,
          unread: model.unread ?? 0,
          sessionsOpen: model.sessionsOpen === true,
          onToggleRail: toggleRail,
          onToggleSessions: () => dispatch({ type: 'sessions' }),
        }),
        h(SessionsPanel, {
          model,
          onNew: () => dispatch({ type: 'newSession', cwd: model.workbench?.project?.cwd }),
          onSwitch: sessionId => dispatch({ type: 'switchSession', sessionId }),
          onClose: () => dispatch({ type: 'sessions', open: false }),
        }),
        model.toast
          ? (Toast
            ? h(Toast, {
              key: model.toast.text,
              text: model.toast.text,
              tone: model.toast.kind === 'ok' ? 'success' : undefined,
              holdMs: model.toast.kind === 'err' ? 6000 : 3000,
              onDone: () => dispatch({ type: 'dismissToast' }),
            })
            : h(Notice, { toast: model.toast }))
          : null,
        h('div', { className: 'dsa-body', 'data-rail': railOpen ? 'open' : 'closed' },
          h(ProjectNav, {
            workbench: model.workbench,
            onSelect: entry => dispatch({ type: 'selectProject', project: entry }),
            onAdd: cwd => dispatch({ type: 'newSession', cwd }),
            onPick: () => dispatch({ type: 'pickProject' }),
          }),
          h('div', { className: 'dsa-main' },
            h(Transcript, { model, scrollRef: model.scrollRef, onReply: message => dispatch({ type: 'reply', message }) }),
            h(Approvals, {
              approvals: model.approvals,
              busy: model.approvalBusy,
              onDecide: (id, decision) => dispatch({ type: 'decide', id, decision }),
            }),
            h(AttentionCards, {
              model,
              onDraft: value => dispatch({ type: 'draft', value }),
              onAnswer: (runId, attentionId, answer) => dispatch({ type: 'answer', runId, attentionId, answer }),
            }),
            h(GoalCards, {
              model,
              onOpen: inspectRun,
              onAction: (goalId, action, body) => dispatch({ type: 'goalAction', goalId, action, body }),
            }),
            chatUnavailable ? h('div', { className: 'dsa-detail-label', role: 'status' }, model.capabilities.reason || '暂时无法对话') : null,
            h(Composer, {
              model,
              disabled: model.sending || model.goalBusy || chatUnavailable,
              running: model.typing,
              canceling: model.canceling,
              insert: model.uploadInsert,
              uploading: model.uploading === true,
              onInserted: () => dispatch({ type: 'inserted' }),
              onUpload: file => dispatch({ type: 'upload', file }),
              onStop: () => dispatch({ type: 'cancel' }),
              onSend: text => dispatch({ type: 'send', text }),
              onGoal: text => dispatch({ type: 'newGoal', text }),
              onClearReply: () => dispatch({ type: 'reply' }),
            })),
          h(Rail, {
            model,
            onOpen: inspectRun,
            onCloseRun: () => dispatch({ type: 'closeRun' }),
            onName: name => dispatch({ type: 'nameWorkbench', name }),
            onOpenSession: run => dispatch({ type: 'showOriginalRun', run }),
            onArtifact: (run, item) => dispatch({ type: 'openWorkbenchArtifact', run, item }),
            detail: h(RunDetail, {
              model,
              onOpenWorker: (runId, childId) => dispatch({ type: 'openWorker', runId, childId }),
              onCloseWorker: () => dispatch({ type: 'closeWorker' }),
              onCancelRun: runId => dispatch({ type: 'cancelRun', runId }),
              onInstruct: (runId, text, subtaskIndex) => dispatch({ type: 'instructRun', runId, text, subtaskIndex }),
              onDraft: value => dispatch({ type: 'draft', value }),
              onAnswer: (runId, attentionId, answer) => dispatch({ type: 'answer', runId, attentionId, answer }),
              onArtifact: item => dispatch({ type: 'artifact', item }),
              onClosePreview: () => dispatch({ type: 'closePreview' }),
              onRetryPreview: () => dispatch({ type: 'retryPreview' }),
              onReveal: item => dispatch({ type: 'revealArtifact', item }),
              onDownload: item => dispatch({ type: 'downloadArtifact', item }),
            }),
          })))
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
      modelRef.current = model

      const patch = updater => setModel(current => updater(current))

      async function refreshWorkbench() {
        const workbench = await call('/workbench')
        patch(current => current.sessionId === workbench.sessionId ? { ...current, workbench } : current)
      }

      const taskStates = model.runs.map(run => `${run.id}:${run.status}`).join(',')
      react.useEffect(() => {
        if (model.phase !== 'ready') return undefined
        const refresh = () => refreshWorkbench().catch(() => {})
        refresh()
        const timer = setInterval(refresh, 8000)
        return () => clearInterval(timer)
      }, [model.phase, model.sessionId, taskStates])

      // Connect once per attempt: wait for the relay, then follow the feed.
      react.useEffect(() => {
        let alive = true
        let source = null
        const open = async () => {
          for (let index = 0; index < RETRIES; index += 1) {
            try {
              const data = await call('/state')
              if (!alive) return
              patch(current => ({
                ...current,
                phase: 'ready',
                reason: '',
                hint: '',
                sessionId: data?.sessionId ?? null,
                capabilities: data?.capabilities ?? null,
                approvals: Array.isArray(data?.approvals) ? data.approvals : [],
                runs: Array.isArray(data?.runs) ? data.runs : [],
                goals: Array.isArray(data?.goals) ? data.goals : [],
              }))
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
            patch(current => applyFrame(current, frame))
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
      }, [model.messages.length, model.typing])

      // The host toast fades itself after hold + fade; this timer only sweeps
      // up when the toast surface is unavailable.
      react.useEffect(() => {
        if (!model.toast) return undefined
        const timer = setTimeout(() => patch(current => ({ ...current, toast: null })), 8000)
        return () => clearTimeout(timer)
      }, [model.toast])

      const actions = {
        reply: ({ message }) => patch(current => ({ ...current, reply: message ? { id: message.id, text: message.text.slice(0, 800) } : null })),
        nameWorkbench: async ({ name }) => {
          const workbench = await call('/workbench', { method: 'POST', body: JSON.stringify({ name }) })
          patch(current => current.sessionId === workbench.sessionId ? { ...current, workbench } : current)
        },
        selectProject: async ({ project }) => {
          const current = modelRef.current.workbench
          if ((current?.project?.cwd ?? null) === (project?.cwd ?? null)) return
          const sessionId = project ? project.sessionId : current?.globalSessionId
          if (sessionId) await actions.switchSession({ sessionId })
          else await actions.newSession({ cwd: project?.cwd })
        },
        pickProject: async () => {
          const { cwd } = await call('/projects/pick', { method: 'POST', body: '{}' })
          if (cwd) await actions.newSession({ cwd })
        },
        showOriginalRun: async ({ run }) => {
          if (run.parentSessionId && run.parentSessionId !== modelRef.current.sessionId) {
            await actions.switchSession({ sessionId: run.parentSessionId })
          }
          await actions.openRun({ runId: run.id, original: true })
        },
        openWorkbenchArtifact: async ({ run, item }) => {
          await actions.showOriginalRun({ run })
          await actions.artifact({ item })
        },
        newGoal: async action => {
          const sessionId = modelRef.current.sessionId
          patch(current => ({ ...current, goalBusy: true }))
          try {
            const data = await call('/goals', { method: 'POST', body: JSON.stringify({ sessionId, text: action.text }) })
            patch(current => !current.sessionId || current.sessionId === data.sessionId ? {
              ...current, sessionId: data.sessionId,
              goals: current.goals.some(goal => goal.id === data.goal.id) ? current.goals : [data.goal, ...current.goals],
            } : current)
          } finally {
            patch(current => ({ ...current, goalBusy: false }))
          }
        },
        goalAction: async ({ goalId, action, body }) => {
          const sessionId = modelRef.current.sessionId
          patch(current => ({ ...current, goalBusy: true }))
          try {
            await call(`/goals/${encodeURIComponent(goalId)}/${action}`, { method: 'POST', body: JSON.stringify({ ...body, sessionId }) })
          } finally {
            patch(current => ({ ...current, goalBusy: false }))
          }
        },
        instructRun: async ({ runId, text, subtaskIndex }) => {
          const sessionId = modelRef.current.sessionId
          await call(`/runs/${encodeURIComponent(runId)}/instruction`, {
            method: 'POST',
            body: JSON.stringify({ sessionId, text, subtaskIndex, mode: subtaskIndex === null ? 'followup' : 'inject' }),
          })
        },
        send: async action => {
          const { reply, sessionId } = modelRef.current
          const text = reply ? `${reply.text.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n${action.text}` : String(action.text ?? '')
          localSeq += 1
          const id = `user-local-${localSeq}`
          patch(current => ({
            ...current,
            sending: true,
            typing: true,
            messages: [...current.messages, { id, role: 'user', text, at: Date.now(), pending: true }],
          }))
          const mode = reply && modelRef.current.typing ? 'steer' : 'queue'
          try {
            await call('/message', {
              method: 'POST',
              body: JSON.stringify({ text, mode, sessionId }),
            })
          } catch (error) {
            patch(current => ({
              ...current,
              sending: false,
              typing: false,
              messages: current.messages.filter(message => message.id !== id),
            }))
            throw error
          }
          patch(current => ({ ...current, sending: false, reply: current.reply === reply ? null : current.reply }))
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
          } catch (error) {
            // The card stays and the failure surfaces instead of vanishing.
            patch(current => ({ ...current, approvalBusy: omitKey(current.approvalBusy, id) }))
            throw error
          }
        },
        cancel: async () => {
          patch(current => ({ ...current, canceling: true }))
          const running = (modelRef.current.runs ?? []).filter(run => !run.goalId && ACTIVE_RUN.has(run.status))
          const settled = await Promise.allSettled([
            call('/cancel', { method: 'POST', body: JSON.stringify({ sessionId: modelRef.current.sessionId }) }),
            ...running.map(run => call(`/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' })),
          ])
          if (settled.every(item => item.status === 'rejected')) {
            patch(current => ({ ...current, canceling: false }))
            throw settled[0].reason
          }
          patch(current => ({ ...current, canceling: false }))
        },
        sessions: async action => {
          const open = typeof action.open === 'boolean' ? action.open : modelRef.current.sessionsOpen !== true
          if (!open) {
            patch(current => ({ ...current, sessionsOpen: false }))
            return
          }
          patch(current => ({ ...current, sessionsOpen: true, sessionsBusy: true }))
          call('/notices/read', { method: 'POST', body: '{}' })
            .then(() => patch(current => ({ ...current, unread: 0 })))
            .catch(() => {})
          try {
            const data = await call('/sessions')
            patch(current => ({
              ...current,
              sessionsBusy: false,
              sessions: Array.isArray(data?.sessions) ? data.sessions : [],
            }))
          } catch (error) {
            patch(current => ({ ...current, sessionsBusy: false }))
            throw error
          }
        },
        newSession: async ({ cwd }) => {
          patch(current => ({ ...current, sessionsBusy: true }))
          try {
            const data = await call('/session', { method: 'POST', body: JSON.stringify({ cwd }) })
            patch(current => ({ ...applyFrame(current, { type: 'session', sessionId: data.sessionId }), sessionsBusy: false, sessionsOpen: false }))
          } catch (error) {
            patch(current => ({ ...current, sessionsBusy: false }))
            throw error
          }
        },
        switchSession: async action => {
          patch(current => ({ ...current, sessionsBusy: true }))
          try {
            const data = await call('/session/switch', { method: 'POST', body: JSON.stringify({ sessionId: action.sessionId }) })
            patch(current => ({ ...applyFrame(current, { type: 'session', sessionId: data.sessionId }), sessionsBusy: false, sessionsOpen: false }))
          } catch (error) {
            patch(current => ({ ...current, sessionsBusy: false }))
            throw error
          }
        },
        openRun: async action => {
          const listed = modelRef.current.workbench?.runs?.find(run => run.id === action.runId)
          if (!action.original && listed?.parentSessionId && listed.parentSessionId !== modelRef.current.sessionId) {
            patch(current => ({ ...current, workbenchRun: action.runId, detail: null, preview: null }))
            return
          }
          patch(current => ({ ...current, detailBusy: true }))
          try {
            const run = await call(`/runs/${encodeURIComponent(action.runId)}`)
            patch(current => ({ ...current, detail: run, workbenchRun: null, workerSession: null, detailBusy: false, answerDraft: '', preview: null }))
          } catch (error) {
            patch(current => ({ ...current, detailBusy: false }))
            throw error
          }
        },
        openWorker: async ({ runId, childId }) => {
          const data = await call(`/runs/${encodeURIComponent(runId)}/worker/${encodeURIComponent(childId)}`)
          const transcript = applyFrame(initialModel(), { type: 'stream.snapshot', records: data.records })
          patch(current => current.detail?.id === runId ? { ...current, workerSession: { title: data.title, transcript } } : current)
        },
        closeWorker: () => patch(current => ({ ...current, workerSession: null })),
        closeRun: () => patch(current => ({ ...current, workbenchRun: null, workerSession: null, detail: null, answerDraft: '', preview: null, previewText: '', previewError: '', previewBusy: false })),
        cancelRun: async action => {
          await call(`/runs/${encodeURIComponent(action.runId)}/cancel`, { method: 'POST' })
          patch(current => ({
            ...current,
            detail: current.detail && current.detail.id === action.runId
              ? { ...current.detail, status: 'cancelling' }
              : current.detail,
          }))
        },
        draft: action => patch(current => ({ ...current, answerDraft: String(action.value ?? '') })),
        answer: async action => {
          const answer = String(action.answer ?? '').trim()
          if (!answer) return
          await call('/answer', {
            method: 'POST',
            body: JSON.stringify({ runId: action.runId, attentionId: action.attentionId, answer }),
          })
          patch(current => ({
            ...current,
            answerDraft: '',
            unread: Math.max(0, (current.unread ?? 0) - 1),
            detail: current.detail && current.detail.id === action.runId
              ? {
                ...current.detail,
                attention: (current.detail.attention ?? []).filter(item => item.id !== action.attentionId),
              }
              : current.detail,
          }))
        },
        artifact: async action => {
          const item = action.item ?? {}
          const href = String(item.href ?? '')
          const url = `${API}/artifact?path=${encodeURIComponent(href)}&runId=${encodeURIComponent(item.runId ?? '')}`
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
            preview: { name: item.name ?? href, url, kind },
            previewText: '',
            previewError: '',
            previewBusy: kind === 'md' || kind === 'text',
          }))
          if (kind !== 'md' && kind !== 'text') return
          try {
            const res = await fetch(url, { headers: { accept: 'text/plain, text/markdown, */*' } })
            const text = await res.text()
            if (!res.ok) throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
            patch(current => ({ ...current, previewBusy: false, previewText: text, previewError: '' }))
          } catch (error) {
            patch(current => ({ ...current, previewBusy: false, previewError: `这个产物读不出来：${error.message}` }))
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
          const query = `?path=${encodeURIComponent(item.href ?? '')}&runId=${encodeURIComponent(item.runId ?? '')}`
          await call(`/artifact/reveal${query}`, { method: 'POST', body: '{}' })
        },
        downloadArtifact: action => {
          const item = action.item ?? {}
          const url = `${API}/artifact?download=1&path=${encodeURIComponent(item.href ?? '')}&runId=${encodeURIComponent(item.runId ?? '')}`
            + `&runId=${encodeURIComponent(item.runId ?? '')}`
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener')
        },
        upload: async action => {
          const file = action.file ?? {}
          if (file.error) throw new Error(file.error)
          patch(current => ({ ...current, uploading: true }))
          try {
            const data = await call('/upload', {
              method: 'POST',
              body: JSON.stringify({ name: file.name, data: file.data, sessionId: modelRef.current.sessionId }),
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
