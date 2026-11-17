/**
 * dsh-superagent — browser half.
 *
 * The "超级智能体" entry opens a main panel that is rendered natively inside
 * the host React tree: host primitives (Button, FishLogo, the host icon set)
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
    const FishLogo = pick('FishLogo')
    const MarkdownText = pick('MarkdownText')
    const UserMessageBubble = pick('UserMessageBubble')
    const StateDot = pick('StateDot')
    const Tooltip = pick('Tooltip')
    const MISSING_PRIMITIVES = ['Button', 'FishLogo', 'MarkdownText', 'UserMessageBubble', 'StateDot', 'Tooltip']
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
    /** Composer delivery behaviour: idle sends start a turn, running sends steer. */
    const RAIL_KEY = 'dsh-superagent.rail-open'
    function readRailOpen() {
      try {
        return window.localStorage.getItem(RAIL_KEY) === '1'
      } catch (error) {
        return false
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

    /**
     * One class sheet for the panel. Every value is copied from the host's own
     * modules: header 76px / 10-28-0-20, sidebar rows 32px / radius 12 / 5px 9px,
     * hero title 26-32 / 500, hero pad 0 24, composer card radius 28, input
     * 4-8-0-14 with a 36px docked floor and 52px hero floor, toolbar 2-8-6 with
     * 12px gaps, send 34px circle on button-info-fill, stats row 22px.
     */
    const CSS = `
.dsa-root{--dsa-col:var(--dsh-chat-content-width,clamp(680px,calc(var(--dsh-conversation-column-width,100%) * .64),920px));display:flex;flex-direction:column;height:100%;min-width:0;background:var(--dsw-alias-bg-base,rgb(21,21,23));color:var(--dsw-alias-label-primary,#f9fafb);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px}
.dsa-header{display:flex;align-items:center;gap:10px;flex:none;box-sizing:border-box;min-height:76px;padding:10px 28px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.dsa-crumbs{display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden;white-space:nowrap}
.dsa-crumb{display:inline-block;max-width:220px;overflow:hidden;padding:4px 8px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-tertiary,rgb(129,133,140));font-size:14px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}
.dsa-crumb-current{font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}
.dsa-sep{color:var(--dsw-alias-label-caption,rgb(129,133,140));font-size:14px;line-height:20px}
.dsa-head-actions{display:flex;flex:none;align-items:center;gap:8px;margin-left:20px}
.dsa-iconbtn{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,rgb(207,211,214));cursor:pointer}
.dsa-iconbtn svg{width:15px;height:15px}
.dsa-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-iconbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#7aaaff);outline-offset:-2px}
.dsa-railtoggle{position:relative}
.dsa-railtoggle[aria-expanded=false] svg{transform:scaleX(-1)}
.dsa-badge{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-size:9px;line-height:14px;font-weight:600;text-align:center;box-sizing:border-box}
.dsa-body{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 0;grid-template-rows:minmax(0,1fr);flex:1;min-height:0;overflow:hidden;transition:grid-template-columns var(--ds-transition-duration-slow,240ms) var(--ds-ease-in-out,ease)}
.dsa-body[data-rail=open]{grid-template-columns:minmax(0,1fr) 360px}
.dsa-main{grid-column:1;grid-row:1;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}
.dsa-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;margin-right:2px;padding:0 32px;scrollbar-gutter:stable}
.dsa-scroll::-webkit-scrollbar{width:10px}
.dsa-scroll::-webkit-scrollbar-thumb{border-radius:5px;background:var(--dsw-alias-scrollbar-bg-l1,rgba(255,255,255,.16))}
.dsa-flow{width:min(100%,var(--dsa-col));margin:0 auto;padding:16px 0 8px;box-sizing:border-box}
.dsa-hero{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:0 24px}
.dsa-hero-stack{display:flex;flex-direction:column;gap:12px;width:100%;max-width:calc(var(--dsa-col) + 32px);padding-bottom:32px}
.dsa-hero-title{display:flex;align-items:center;justify-content:center;gap:10px;font-size:26px;line-height:32px;font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}
.dsa-hero-note{text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-composer{flex:none;padding:0 16px 4px;background:var(--dsw-alias-bg-base,rgb(21,21,23))}
.dsa-card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:100%;max-width:calc(var(--dsa-col) + 32px);margin:0 auto;padding-top:8px;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-specific-input-major,rgb(35,35,36));box-shadow:var(--dsw-elevation-soft,0 2px 12px rgba(0,0,0,.18))}
.dsa-input{box-sizing:border-box;width:100%;min-height:36px;max-height:336px;padding:4px 8px 0 14px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));resize:none;overflow-y:auto}
.dsa-input::placeholder{color:var(--dsw-alias-label-caption,rgb(129,133,140))}
.dsa-card[data-hero=true] .dsa-input{min-height:52px}
.dsa-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px;padding:2px 8px 6px;min-width:0}
.dsa-trailing{display:flex;align-items:center;min-width:0;gap:12px}
.dsa-trailing{margin-left:auto;flex:none}
.dsa-add{display:grid;place-items:center;flex:none;width:28px;height:28px;border:0;border-radius:999px;background:var(--dsw-specific-selector,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb);cursor:pointer}
.dsa-add:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.14))}
.dsa-send{display:grid;place-items:center;flex:none;width:34px;height:34px;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill,#3964fe);color:var(--dsw-alias-label-on-color,#fff);cursor:pointer;transform:translateY(-2px);transition:background-color 100ms ease}
.dsa-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2f57e6)}
.dsa-send:disabled{opacity:.4;cursor:default}
.dsa-send svg{width:15px;height:15px}
.dsa-send[data-mode=stop] svg{width:10px;height:10px;border-radius:2px}
.dsa-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:var(--dsw-alias-label-on-color,#fff);animation:dsa-spin .8s linear infinite}
@keyframes dsa-spin{to{transform:rotate(360deg)}}
.dsa-stats{min-height:calc(22px + var(--dsh-content-font-delta-secondary,0px));display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-msg{padding:0 0 4px}
.dsa-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-bottom:16px}
.dsa-bubble{max-width:min(calc(var(--dsa-col) * .702),82%);padding:10px 16px;border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-specific-bubble,var(--dsw-static-deepseek-50,#eef4ff));color:var(--dsw-alias-label-primary,#f9fafb);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;overflow-wrap:anywhere}
.dsa-bubble[data-pending=true]{opacity:.6}
.dsa-assistant{display:flex;flex-direction:column;gap:6px;margin-bottom:16px;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));overflow-wrap:anywhere}
.dsa-md-plain{white-space:pre-wrap;overflow-wrap:anywhere}
.dsa-tools-row{display:flex;flex-wrap:wrap;gap:6px}
.dsa-tool{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,rgb(207,211,214))}
.dsa-tool[data-status=err]{color:var(--dsw-alias-state-error-primary,#f25a5a)}
.dsa-reasoning{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140));white-space:pre-wrap}
.dsa-typing{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-approvals{display:flex;flex-direction:column;gap:8px;width:min(calc(100% - 64px),var(--dsa-col));margin:0 auto;padding:0 0 8px}
.dsa-approval{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-state-warn-secondary,var(--dsw-static-amber-400,#fbbf24));border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-specific-input-major,rgb(35,35,36));box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.18))}
.dsa-approval-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--dsw-alias-state-warn-tertiary,var(--dsw-static-amber-100,#fef3c7));color:var(--dsw-alias-state-warn-label,var(--dsw-static-amber-600,#d97706));font-size:13px;line-height:20px;font-weight:500}
.dsa-approval-main{display:flex;flex-direction:column;gap:10px;padding:12px 14px}
.dsa-approval-title{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}
.dsa-approval-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,rgb(207,211,214));overflow-wrap:anywhere}
.dsa-approval-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.dsa-rail{grid-column:2;grid-row:1;justify-self:end;display:flex;flex-direction:column;width:360px;max-width:min(84vw,360px);min-width:0;box-sizing:border-box;padding:8px;border-left:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));background:var(--dsw-alias-bg-base,rgb(21,21,23));overflow:hidden;visibility:hidden;transform:translateX(100%);transition:transform var(--ds-transition-duration-slow,240ms) var(--ds-ease-in-out,ease),visibility 0s linear var(--ds-transition-duration-slow,240ms)}
.dsa-body[data-rail=open] .dsa-rail{visibility:visible;transform:none;transition:transform var(--ds-transition-duration-slow,240ms) var(--ds-ease-in-out,ease)}
@media (max-width:960px){
  .dsa-body[data-rail=open]{grid-template-columns:minmax(0,1fr) 0}
  .dsa-body[data-rail=open] .dsa-rail{box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.32))}
}
@media (prefers-reduced-motion:reduce){
  .dsa-body,.dsa-rail,.dsa-body[data-rail=open] .dsa-rail{transition:none}
}
.dsa-rail-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-rowdot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption,rgb(129,133,140))}
.dsa-rowdot[data-status=running]{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsa-rowdot[data-status=waiting]{background:var(--dsw-alias-state-warning-primary,#ffc140)}
.dsa-rowdot[data-status=stopped]{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsa-rail-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-rail-list{display:flex;flex:1;flex-direction:column;gap:2px;min-height:0;overflow-y:auto;margin-bottom:8px}
.dsa-rowitem{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;height:32px;padding:0 8px 0 9px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:default}
.dsa-rowtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-rowtime{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140));margin-inline-end:-1px}
.dsa-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;text-align:center}
.dsa-note{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,rgb(207,211,214))}
.dsa-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,rgb(129,133,140))}
.dsa-toast{display:flex;align-items:center;gap:8px;margin:8px auto 0;width:min(calc(100% - 64px),var(--dsa-col));padding:6px 10px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,rgb(207,211,214));font-size:12px;line-height:18px}
.dsa-toast[data-kind=err]{color:var(--dsw-alias-state-error-primary,#f25a5a)}
.dsa-sessions{position:absolute;top:64px;right:20px;z-index:30;display:flex;flex-direction:column;width:300px;max-height:min(60vh,440px);padding:8px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-base,rgb(21,21,23));box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.32))}
.dsa-sessions-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-sessions-new,.dsa-linkbtn{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#7aaaff);font:inherit;font-size:12px;line-height:18px;cursor:pointer;padding:2px 6px;border-radius:var(--dsw-radius-sm,8px)}
.dsa-sessions-new:hover,.dsa-linkbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-sessions-list{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto}
.dsa-session-row{height:40px;gap:8px;cursor:pointer}
.dsa-session-row[data-current=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.dsa-session-meta{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-sessions-foot{display:flex;justify-content:flex-end;padding-top:6px}
.dsa-detail{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,rgb(21,21,23))}
.dsa-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.dsa-detail-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500}
.dsa-detail-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px}
.dsa-detail-sec{display:flex;flex-direction:column;gap:6px}
.dsa-detail-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-detail-item{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsa-detail-q{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#f9fafb);white-space:pre-wrap}
.dsa-answer-row{display:flex;gap:6px}
.dsa-answer-input{flex:1;min-width:0;box-sizing:border-box;padding:5px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:12px;outline:none}
.dsa-artifact-link{display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-state-business-primary,#7aaaff);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsa-artifact-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-attention{display:flex;flex-direction:column;gap:8px;margin:8px 0}
.dsa-attention-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-state-warning-primary,rgba(255,193,64,.45));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-base,rgb(21,21,23))}
.dsa-attention-head{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warning-primary,#ffc140)}
.dsa-attention-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#ffc140)}
.dsa-attention-options{display:flex;flex-wrap:wrap;gap:6px}
.dsa-artifact-row{display:flex;align-items:center;gap:4px}
.dsa-artifact-row .dsa-artifact-link{flex:1;min-width:0;overflow:hidden}
.dsa-preview{border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));border-radius:var(--dsw-radius-md,12px);padding:8px}
.dsa-preview-img{display:block;max-width:100%;border-radius:var(--dsw-radius-sm,8px)}
.dsa-preview-frame{width:100%;height:320px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base,rgb(21,21,23))}
.dsa-preview-text{max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgb(207,211,214))}
.dsa-chip{padding:3px 10px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsa-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
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
      if (typeof component !== 'function') return null
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
          const runs = Array.isArray(frame.runs) ? frame.runs : []
          const detail = model.detail ? runs.find(run => run.id === model.detail.id) ?? model.detail : null
          const seen = Array.isArray(model.seenAttention) ? model.seenAttention : []
          const fresh = []
          for (const run of runs) {
            for (const item of Array.isArray(run.attention) ? run.attention : []) {
              if (item?.id && !seen.includes(item.id) && !fresh.includes(item.id)) fresh.push(item.id)
            }
          }
          return {
            ...model,
            runs,
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
      const { railOpen, runningCount, onToggleRail, onToggleSessions, sessionsOpen, unread } = props
      const toggleLabel = railOpen ? '收起任务栏（Ctrl+Shift+B）' : '展开任务栏（Ctrl+Shift+B）'
      return h('header', { className: 'dsa-header' },
        h('div', { className: 'dsa-crumbs' },
          h('span', { className: 'dsa-crumb dsa-crumb-current' }, PANEL_LABEL)),
        h('div', { className: 'dsa-head-actions' },
          tipped(unread > 0 ? `会话（${unread} 个新问题）` : '会话', h('button', {
            type: 'button',
            className: 'dsa-iconbtn',
            'aria-label': '会话',
            'aria-expanded': sessionsOpen ? 'true' : 'false',
            onClick: onToggleSessions,
          }, h(Icon, { of: 'clock' }),
          unread > 0 ? h('span', { className: 'dsa-badge' }, unread > 9 ? '9+' : String(unread)) : null), 'bottom'),
          tipped(toggleLabel, h('button', {
            type: 'button',
            className: 'dsa-iconbtn dsa-railtoggle',
            'aria-label': runningCount > 0 ? `${toggleLabel}，${runningCount} 条任务线运行中` : toggleLabel,
            'aria-expanded': railOpen ? 'true' : 'false',
            onClick: onToggleRail,
          },
          h(Icon, { of: 'panel' }),
          runningCount > 0 ? h('span', { className: 'dsa-badge' }, runningCount > 9 ? '9+' : String(runningCount)) : null))))
    }

    function UserMessage(props) {
      const pending = props.message.pending === true
      return h('div', { className: 'dsa-user', style: pending ? { opacity: 0.6 } : undefined },
        UserMessageBubble
          ? h(UserMessageBubble, { className: pending ? 'dsa-bubble-pending' : undefined }, props.message.text)
          : h('div', { className: 'dsa-bubble', 'data-pending': pending ? 'true' : 'false' }, props.message.text))
    }

    function AssistantMessage(props) {
      const message = props.message
      const tools = Array.isArray(message.tools) ? message.tools : []
      const children = []
      if (message.reasoning) {
        children.push(h('div', { key: 'reasoning', className: 'dsa-reasoning' }, message.reasoning))
      }
      if (tools.length > 0) {
        children.push(h('div', { key: 'tools', className: 'dsa-tools-row' }, tools.map(tool => {
          const chip = h('span', {
            key: tool.callId ?? tool.name,
            className: 'dsa-tool',
            'data-status': tool.status,
          }, tool.name)
          return typeof tool.arguments === 'string' && tool.arguments
            ? (Tooltip
              ? h(Tooltip, { key: tool.callId ?? tool.name, label: tool.arguments, side: 'top', maxWidth: 420 }, chip)
              : react.cloneElement(chip, { title: tool.arguments }))
            : chip
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
      return h('div', { className: 'dsa-assistant' }, children)
    }

    function Transcript(props) {
      const rows = []
      for (const message of props.model.messages) {
        rows.push(h('div', { key: message.id, className: 'dsa-msg' },
          message.role === 'user'
            ? h(UserMessage, { message })
            : h(AssistantMessage, { message })))
      }
      if (props.model.typing) {
        rows.push(h('div', { key: 'typing', className: 'dsa-typing' }, '正在生成…'))
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
      const { hero, disabled, onSend } = props
      const [text, setText] = react.useState('')
      const areaRef = react.useRef(null)
      const fileRef = react.useRef(null)

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
        h('div', { className: 'dsa-card', 'data-hero': hero ? 'true' : 'false' },
          h('textarea', {
            ref: areaRef,
            className: 'dsa-input',
            rows: 1,
            value: text,
            placeholder: hero ? '想让我做什么？' : '继续这条对话…',
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
            }, props.uploading === true ? h('span', { className: 'dsa-spin' }) : '+'), 'top'),
            h('div', { className: 'dsa-trailing' },
              props.running
                ? tipped('停止本轮', h('button', {
                  type: 'button',
                  className: 'dsa-send',
                  'data-mode': 'stop',
                  'aria-label': '停止本轮',
                  disabled: props.canceling === true,
                  onClick: () => props.onStop?.(),
                }, props.canceling ? h('span', { className: 'dsa-spin' }) : h(Icon, { of: 'stop', size: 10 })), 'top')
                : tipped('发送', h('button', {
                  type: 'button',
                  className: 'dsa-send',
                  'aria-label': '发送',
                  disabled: disabled || !text.trim(),
                  onClick: submit,
                }, h(Icon, { of: 'send', size: 15 })), 'top')))),
        h('div', { className: 'dsa-stats' },
          h('span', null, `${props.model.runs.length} 条调度会话`)))
    }

    /**
     * The superagent is the only conversation. This panel lists what it is
     * orchestrating — the delegated sessions/task lines — never a chat history
     * of the user's own conversations.
     */
    function Rail(props) {
      const { model } = props
      const runs = Array.isArray(model.runs) ? model.runs : []
      const running = runs.filter(run => run.status === 'running').length
      return h('aside', { className: 'dsa-rail', 'aria-label': '调度的会话' },
        h('div', { className: 'dsa-rail-head' },
          h('span', null, '调度的会话'),
          h('span', { className: 'dsa-rail-count' }, running > 0 ? `${running} 运行中` : `${runs.length}`)),
        h('div', { className: 'dsa-rail-list' },
          runs.length === 0
            ? h('div', { className: 'dsa-hint', style: { padding: '8px' } }, '超级智能体还没有调度新的会话')
            : runs.map(run => {
              // A run with an unanswered attention item is waiting on the user,
              // not running: show that as its own amber state.
              const waiting = Array.isArray(run.attention) && run.attention.length > 0
              return tipped(run.goal ?? '', h('button', {
                key: run.id,
                type: 'button',
                className: 'dsa-rowitem',
                title: '查看任务详情',
                onClick: () => props.onOpen?.(run.id),
              },
              h('span', { className: 'dsa-rowdot', 'data-status': waiting ? 'waiting' : run.status }),
              h('span', { className: 'dsa-rowtitle' }, run.goal ?? '调度中的会话'),
              h('span', { className: 'dsa-rowtime' }, waiting ? '等你决定' : run.status === 'running' ? '运行中' : run.status === 'completed' ? '完成' : '已停')), 'left', run.id)
            })))
    }

    /** Artifacts are whatever the run report links to, same rule as the console page. */
    function artifactsOf(run) {
      const report = typeof run?.report === 'string' ? run.report : ''
      const found = []
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
          h('span', null, '会话'),
          h('button', {
            type: 'button',
            className: 'dsa-sessions-new',
            disabled: busy,
            onClick: () => props.onNew?.(),
          }, '新对话')),
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

    /** One delegated run: status, questions waiting for the user, artifacts. */
    function RunDetail(props) {
      const { model } = props
      const run = model.detail
      if (!run) return null
      const attention = Array.isArray(run.attention) ? run.attention : []
      const artifacts = artifactsOf(run)
      const busy = model.detailBusy === true
      return h('div', { className: 'dsa-detail', role: 'dialog', 'aria-label': '任务详情' },
        h('div', { className: 'dsa-detail-head' },
          h('span', { className: 'dsa-detail-title' }, run.goal ?? '任务详情'),
          h('button', {
            type: 'button',
            className: 'dsa-linkbtn',
            onClick: () => props.onCancelRun?.(run.id),
          }, run.status === 'running' ? '停止' : '已停'),
          h('button', { type: 'button', className: 'dsa-linkbtn', onClick: () => props.onClose?.() }, '关闭')),
        h('div', { className: 'dsa-detail-body' },
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
                  : h('div', { className: 'dsa-preview-text' },
                    model.previewBusy
                      ? '读取中…'
                      : model.preview.kind === 'md' && MarkdownText
                        ? h(MarkdownText, { text: model.previewText, labels: MARKDOWN_LABELS })
                        : model.previewText))
            : null,
          h('div', { className: 'dsa-detail-sec' },
            h('div', { className: 'dsa-detail-label' }, '状态'),
            h('div', { className: 'dsa-detail-q' }, `${run.status ?? '未知'}${run.startedAt ? ` · ${run.startedAt}` : ''}`)),
          attention.length > 0
            ? h('div', { className: 'dsa-detail-sec' },
              h('div', { className: 'dsa-detail-label' }, '等你决定'),
              attention.map(item => h('div', { key: item.id, className: 'dsa-detail-item' },
                h('div', { className: 'dsa-detail-q' }, item.question ?? '有一个问题需要你回答'),
                h('div', { className: 'dsa-answer-row' },
                  h('input', {
                    className: 'dsa-answer-input',
                    value: model.answerDraft,
                    placeholder: '写下你的回答',
                    onInput: event => props.onDraft?.(event.target.value),
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
                }, item.name),
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
          run.report
            ? h('div', { className: 'dsa-detail-sec' },
              h('div', { className: 'dsa-detail-label' }, '报告'),
              h('div', { className: 'dsa-md-plain' }, run.report))
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
      for (const run of Array.isArray(model.runs) ? model.runs : []) {
        for (const item of Array.isArray(run.attention) ? run.attention : []) {
          if (item?.id) entries.push({ run, item })
        }
      }
      if (entries.length === 0) return null
      return h('div', { className: 'dsa-attention' },
        entries.map(({ run, item }) => {
          const options = Array.isArray(item.options) ? item.options : []
          return h('div', { key: `${run.id}:${item.id}`, className: 'dsa-attention-card' },
            h('div', { className: 'dsa-attention-head' },
              h('span', { className: 'dsa-attention-dot' }),
              h('span', null, item.source === 'plan' ? '计划确认' : '等你决定'),
              h('span', { className: 'dsa-session-meta' }, run.goal ?? '')),
            h('div', { className: 'dsa-detail-q' }, item.question ?? '有一个问题需要你回答'),
            item.reason ? h('div', { className: 'dsa-detail-label' }, item.reason) : null,
            h('div', { className: 'dsa-answer-row' },
              h('input', {
                className: 'dsa-answer-input',
                value: model.answerDraft,
                placeholder: options.length > 0 ? '或者直接写别的回答' : '写下你的回答',
                onInput: event => props.onDraft?.(event.target.value),
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
                disabled: !String(model.answerDraft ?? '').trim(),
                onClick: () => props.onAnswer?.(run.id, item.id, model.answerDraft),
              }, '回答')),
            options.length > 0
              ? h('div', { className: 'dsa-attention-options' },
                options.map(option => h('button', {
                  key: option,
                  type: 'button',
                  className: 'dsa-chip',
                  onClick: () => props.onAnswer?.(run.id, item.id, option),
                }, option)))
              : null)
        }))
    }

    function Hero(props) {
      const ready = props.model.capabilities?.chat !== false
      return h('div', { className: 'dsa-hero' },
        h('div', { className: 'dsa-hero-stack' },
          h('div', { className: 'dsa-hero-title' },
            FishLogo ? h(FishLogo, { size: 32 }) : h(Icon, { of: 'spark', size: 26 }),
            h('span', null, PANEL_LABEL)),
          h('div', { className: 'dsa-hero-note' }, ready
            ? '说一句话就开始：它会拆任务、并行走、把结果收回来说给你。'
            : (props.model.capabilities?.reason ?? '这个宿主暂时不能对话')),
          h(Composer, { ...props, hero: true, disabled: props.disabled || !ready })))
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
      const empty = model.messages.length === 0
      const runningCount = Array.isArray(model.runs)
        ? model.runs.filter(run => run.status === 'running').length
        : 0
      return h('div', { className: 'dsa-root', 'data-rail': railOpen ? 'open' : 'closed' },
        h(Header, {
          railOpen,
          runningCount,
          unread: model.unread ?? 0,
          sessionsOpen: model.sessionsOpen === true,
          onToggleRail: toggleRail,
          onToggleSessions: () => dispatch({ type: 'sessions' }),
        }),
        h(SessionsPanel, {
          model,
          onNew: () => dispatch({ type: 'newSession' }),
          onSwitch: sessionId => dispatch({ type: 'switchSession', sessionId }),
          onClose: () => dispatch({ type: 'sessions', open: false }),
        }),
        h(Toast, { toast: model.toast }),
        h('div', { className: 'dsa-body', 'data-rail': railOpen ? 'open' : 'closed' },
          h('div', { className: 'dsa-main' },
            empty
              ? h(Hero, {
                model,
                disabled: model.sending,
                running: model.typing,
                canceling: model.canceling,
                insert: model.uploadInsert,
                uploading: model.uploading === true,
                onInserted: () => dispatch({ type: 'inserted' }),
                onUpload: file => dispatch({ type: 'upload', file }),
                onStop: () => dispatch({ type: 'cancel' }),
                onSend: text => dispatch({ type: 'send', text }),
              })
              : h(Transcript, { model, scrollRef: model.scrollRef }),
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
            empty ? null : h(Composer, {
              model,
              disabled: model.sending || model.capabilities?.chat === false,
              running: model.typing,
              canceling: model.canceling,
              insert: model.uploadInsert,
              uploading: model.uploading === true,
              onInserted: () => dispatch({ type: 'inserted' }),
              onUpload: file => dispatch({ type: 'upload', file }),
              onStop: () => dispatch({ type: 'cancel' }),
              onSend: text => dispatch({ type: 'send', text }),
            }),
            h(RunDetail, {
              model,
              onClose: () => dispatch({ type: 'closeRun' }),
              onCancelRun: runId => dispatch({ type: 'cancelRun', runId }),
              onDraft: value => dispatch({ type: 'draft', value }),
              onAnswer: (runId, attentionId, answer) => dispatch({ type: 'answer', runId, attentionId, answer }),
              onArtifact: item => dispatch({ type: 'artifact', item }),
              onClosePreview: () => dispatch({ type: 'closePreview' }),
              onReveal: item => dispatch({ type: 'revealArtifact', item }),
              onDownload: item => dispatch({ type: 'downloadArtifact', item }),
            })),
          h(Rail, { model, onOpen: runId => dispatch({ type: 'openRun', runId }) })))
    }

    /** One-line status above the composer; errors stay until replaced. */
    function Toast(props) {
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

      // A notice clears itself; errors do not stack up.
      react.useEffect(() => {
        if (!model.toast) return undefined
        const timer = setTimeout(() => patch(current => ({ ...current, toast: null })), 6000)
        return () => clearTimeout(timer)
      }, [model.toast])

      const actions = {
        send: async action => {
          const text = String(action.text ?? '')
          const sessionId = modelRef.current.sessionId
          localSeq += 1
          const id = `user-local-${localSeq}`
          patch(current => ({
            ...current,
            sending: true,
            typing: true,
            messages: [...current.messages, { id, role: 'user', text, at: Date.now(), pending: true }],
          }))
          const mode = modelRef.current.typing ? 'steer' : 'queue'
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
          patch(current => ({ ...current, sending: false }))
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
          const running = (modelRef.current.runs ?? []).filter(run => run.status === 'running')
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
        newSession: async () => {
          patch(current => ({ ...current, sessionsBusy: true }))
          try {
            await call('/session', { method: 'POST', body: '{}' })
            patch(current => ({ ...current, sessionsBusy: false, sessionsOpen: false }))
          } catch (error) {
            patch(current => ({ ...current, sessionsBusy: false }))
            throw error
          }
        },
        switchSession: async action => {
          patch(current => ({ ...current, sessionsBusy: true }))
          try {
            await call('/session/switch', { method: 'POST', body: JSON.stringify({ sessionId: action.sessionId }) })
            patch(current => ({ ...current, sessionsBusy: false, sessionsOpen: false }))
          } catch (error) {
            patch(current => ({ ...current, sessionsBusy: false }))
            throw error
          }
        },
        openRun: async action => {
          patch(current => ({ ...current, detailBusy: true }))
          try {
            const run = await call(`/runs/${encodeURIComponent(action.runId)}`)
            patch(current => ({ ...current, detail: run, detailBusy: false, answerDraft: '' }))
          } catch (error) {
            patch(current => ({ ...current, detailBusy: false }))
            throw error
          }
        },
        closeRun: () => patch(current => ({ ...current, detail: null, answerDraft: '', preview: null, previewText: '', previewBusy: false })),
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
            previewBusy: kind === 'md' || kind === 'text',
          }))
          if (kind !== 'md' && kind !== 'text') return
          try {
            const res = await fetch(url, { headers: { accept: 'text/plain, text/markdown, */*' } })
            const text = await res.text()
            if (!res.ok) throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
            patch(current => ({ ...current, previewBusy: false, previewText: text }))
          } catch (error) {
            patch(current => ({ ...current, previewBusy: false, previewText: `这个产物读不出来：${error.message}` }))
          }
        },
        closePreview: () => patch(current => ({ ...current, preview: null, previewText: '', previewBusy: false })),
        revealArtifact: async action => {
          const item = action.item ?? {}
          const query = `?path=${encodeURIComponent(item.href ?? '')}&runId=${encodeURIComponent(item.runId ?? '')}`
          await call(`/artifact/reveal${query}`, { method: 'POST', body: '{}' })
        },
        downloadArtifact: action => {
          const item = action.item ?? {}
          const url = `${API}/artifact?download=1&path=${encodeURIComponent(item.href ?? '')}`
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
      }

      const dispatch = action => {
        // The shell must survive a failed action: show it, never throw.
        const run = actions[action.type]
        if (!run) return
        Promise.resolve(run(action)).catch(error => {
          patch(current => ({
            ...current,
            reason: error.message,
            hint: error.hint ?? '',
            toast: { kind: 'err', text: `${error.message}${error.hint ? ` ${error.hint}` : ''}` },
            phase: current.phase === 'loading' ? 'error' : current.phase,
          }))
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
      if (typeof host === 'function') return h(host, { size })
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
