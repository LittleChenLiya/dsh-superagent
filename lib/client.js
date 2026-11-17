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
    const Button = ui && typeof ui.Button === 'function' ? ui.Button : null
    const FishLogo = ui && typeof ui.FishLogo === 'function' ? ui.FishLogo : null
    const ICONS = {
      spark: ui?.IconSparkleRegular ?? ui?.IconSparkleMedium,
      send: ui?.IconSendOutlineRegular ?? ui?.IconSendOutlineMedium,
      plus: ui?.IconPlusOutlineRegular ?? ui?.IconPlusOutlineMedium,
      newChat: ui?.IconNewChatOutlineRegular ?? ui?.IconNewChatOutlineMedium,
      refresh: ui?.IconRefreshOutlineRegular ?? ui?.IconRefreshOutlineMedium,
      stop: ui?.IconStopFillRegular ?? ui?.IconStopFillMedium,
      clock: ui?.IconClockOutlineRegular ?? ui?.IconClockOutlineMedium,
      check: ui?.IconCheckOutlineRegular ?? ui?.IconCheckOutlineMedium,
      close: ui?.IconCloseOutlineRegular ?? ui?.IconCloseOutlineMedium,
      folder: ui?.IconFolderCloseRegular ?? ui?.IconFolderCloseMedium,
    }

    /**
     * One class sheet for the panel. Every value is copied from the host's own
     * modules: header 76px / 10-28-0-20, sidebar rows 32px / radius 12 / 5px 9px,
     * hero title 26-32 / 500, hero pad 0 24, composer card radius 28, input
     * 4-8-0-14 with a 36px docked floor and 52px hero floor, toolbar 2-8-6 with
     * 12px gaps, send 34px circle on button-info-fill, stats row 22px.
     */
    const CSS = `
.dsa-root{display:flex;flex-direction:column;height:100%;min-width:0;background:var(--dsw-alias-bg-base,rgb(21,21,23));color:var(--dsw-alias-label-primary,#f9fafb);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px}
.dsa-header{display:flex;align-items:center;gap:10px;flex:none;box-sizing:border-box;min-height:76px;padding:10px 28px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.dsa-crumbs{display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden;white-space:nowrap}
.dsa-crumb{display:inline-block;max-width:220px;overflow:hidden;padding:4px 8px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-tertiary,rgb(129,133,140));font-size:14px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}
.dsa-crumb-current{font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}
.dsa-sep{color:var(--dsw-alias-label-caption,rgb(129,133,140));font-size:14px;line-height:20px}
.dsa-head-actions{display:flex;flex:none;align-items:center;gap:8px;margin-left:20px}
.dsa-iconbtn{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,rgb(207,211,214));cursor:pointer}
.dsa-iconbtn svg{width:15px;height:15px}
.dsa-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-iconbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#7aaaff);outline-offset:-2px}
.dsa-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption,rgb(129,133,140))}
.dsa-dot[data-state=live]{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsa-dot[data-state=warn]{background:var(--dsw-alias-state-warning-primary,#f59e0b)}
.dsa-body{display:flex;flex:1;min-height:0}
.dsa-main{position:relative;display:flex;flex-direction:column;flex:1;min-width:0}
.dsa-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;margin-right:2px;scrollbar-gutter:stable}
.dsa-scroll::-webkit-scrollbar{width:10px}
.dsa-scroll::-webkit-scrollbar-thumb{border-radius:5px;background:var(--dsw-alias-scrollbar-bg-l1,rgba(255,255,255,.16))}
.dsa-flow{width:min(100%,clamp(680px,64%,920px));margin:0 auto;padding:16px 0 8px;box-sizing:border-box}
.dsa-hero{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:0 24px}
.dsa-hero-stack{display:flex;flex-direction:column;gap:12px;width:100%;max-width:calc(clamp(680px,64%,920px) + 32px);padding-bottom:32px}
.dsa-hero-title{display:flex;align-items:center;justify-content:center;gap:10px;font-size:26px;line-height:32px;font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}
.dsa-hero-note{text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-composer{flex:none;padding:0 16px 4px;background:var(--dsw-alias-bg-base,rgb(21,21,23))}
.dsa-card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:100%;max-width:calc(clamp(680px,64%,920px) + 32px);margin:0 auto;padding-top:8px;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-specific-input-major,rgb(35,35,36));box-shadow:var(--dsw-elevation-soft,0 2px 12px rgba(0,0,0,.18))}
.dsa-input{box-sizing:border-box;width:100%;min-height:36px;max-height:336px;padding:4px 8px 0 14px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));resize:none;overflow-y:auto}
.dsa-input::placeholder{color:var(--dsw-alias-label-caption,rgb(129,133,140))}
.dsa-card[data-hero=true] .dsa-input{min-height:52px}
.dsa-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:2px 8px 6px;min-width:0}
.dsa-tools,.dsa-trailing{display:flex;align-items:center;min-width:0;gap:12px}
.dsa-trailing{margin-left:auto;flex:none}
.dsa-add{display:grid;place-items:center;flex:none;width:28px;height:28px;border:0;border-radius:999px;background:var(--dsw-specific-selector,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb);cursor:pointer}
.dsa-add:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.14))}
.dsa-chip{height:28px;padding:0 20px 0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background-color:transparent;background-repeat:no-repeat;background-position:right 4px center;background-size:12px 12px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");color:var(--dsw-alias-label-secondary,rgb(207,211,214));font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;appearance:none}
.dsa-chip:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-send{display:grid;place-items:center;flex:none;width:34px;height:34px;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill,#3964fe);color:var(--dsw-alias-label-on-color,#fff);cursor:pointer;transform:translateY(-2px);transition:background-color 100ms ease}
.dsa-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2f57e6)}
.dsa-send:disabled{opacity:.4;cursor:default}
.dsa-send svg{width:15px;height:15px}
.dsa-stats{min-height:calc(22px + var(--dsh-content-font-delta-secondary,0px));display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-msg{padding:0 0 4px}
.dsa-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-bottom:16px}
.dsa-bubble{max-width:min(calc(clamp(680px,64%,920px) * .702),82%);padding:10px 14px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.08));white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:24px}
.dsa-bubble[data-pending=true]{opacity:.6}
.dsa-assistant{display:flex;flex-direction:column;gap:6px;margin-bottom:16px;font-size:14px;line-height:24px;overflow-wrap:anywhere}
.dsa-md>*:first-child{margin-top:0}
.dsa-md>*:last-child{margin-bottom:0}
.dsa-md p{margin:0 0 8px}
.dsa-md ul,.dsa-md ol{margin:0 0 8px;padding-left:22px}
.dsa-md h1,.dsa-md h2,.dsa-md h3{margin:12px 0 8px;font-size:15px;line-height:24px;font-weight:600}
.dsa-md a{color:var(--dsw-alias-state-business-primary,#7aaaff);text-decoration:none}
.dsa-md code{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:13px}
.dsa-md pre{margin:0 0 8px;padding:12px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,rgb(35,35,36));overflow-x:auto}
.dsa-md pre code{padding:0;background:transparent}
.dsa-tools-row{display:flex;flex-wrap:wrap;gap:6px}
.dsa-tool{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,rgb(207,211,214))}
.dsa-tool[data-status=err]{color:var(--dsw-alias-state-error-primary,#f25a5a)}
.dsa-reasoning{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140));white-space:pre-wrap}
.dsa-typing{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-approvals{display:flex;flex-direction:column;gap:8px;width:min(100%,clamp(680px,64%,920px));margin:0 auto;padding:0 0 8px}
.dsa-approval{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,rgb(35,35,36))}
.dsa-approval-title{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}
.dsa-approval-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,rgb(207,211,214));overflow-wrap:anywhere}
.dsa-approval-actions{display:flex;gap:8px;justify-content:flex-end}
.dsa-rail{display:flex;flex:none;flex-direction:column;width:260px;min-width:0;box-sizing:border-box;padding:6px 8px;border-left:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.dsa-rail-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140))}
.dsa-rail-list{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto;margin-bottom:8px}
.dsa-rowitem{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;height:32px;padding:0 8px 0 9px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer}
.dsa-rowitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-rowitem[data-selected=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsa-rowitem:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#7aaaff);outline-offset:-2px}
.dsa-rowtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-rowtime{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgb(129,133,140));margin-inline-end:-1px}
.dsa-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;text-align:center}
.dsa-note{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,rgb(207,211,214))}
.dsa-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,rgb(129,133,140))}
.dsa-toast{display:flex;align-items:center;gap:8px;margin:8px auto 0;width:min(100%,clamp(680px,64%,920px));padding:6px 10px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,rgb(207,211,214));font-size:12px;line-height:18px}
.dsa-toast[data-kind=err]{color:var(--dsw-alias-state-error-primary,#f25a5a)}
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

    /** Escape one text run before it becomes HTML. */
    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    /** Inline markdown: code spans, bold, links. Everything else is escaped. */
    function inlineHtml(text) {
      let out = escapeHtml(text)
      out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label, href) => {
        const safe = href.replace(/"/g, '&quot;')
        return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`
      })
      return out
    }

    /**
     * A small markdown subset: fenced code, headings, lists, paragraphs. The
     * panel shows the same prose the console page shows; raw HTML is never
     * passed through.
     */
    function markdownHtml(text) {
      const source = String(text ?? '')
      const blocks = []
      const fence = /```([a-zA-Z0-9-]*)\n([\s\S]*?)```/g
      let rest = source.replace(fence, (_, language, body) => {
        blocks.push(`<pre><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`)
        return `\u0000${blocks.length - 1}\u0000`
      })
      const lines = rest.split('\n')
      const html = []
      let paragraph = []
      let list = null
      const flushParagraph = () => {
        if (paragraph.length === 0) return
        html.push(`<p>${inlineHtml(paragraph.join(' '))}</p>`)
        paragraph = []
      }
      const flushList = () => {
        if (!list) return
        html.push(`<${list.tag}>${list.items.map(item => `<li>${inlineHtml(item)}</li>`).join('')}</${list.tag}>`)
        list = null
      }
      for (const line of lines) {
        const placeholder = line.match(/^\u0000(\d+)\u0000$/)
        if (placeholder) {
          flushParagraph()
          flushList()
          html.push(blocks[Number(placeholder[1])] ?? '')
          continue
        }
        if (!line.trim()) {
          flushParagraph()
          flushList()
          continue
        }
        const heading = line.match(/^(#{1,3})\s+(.*)$/)
        if (heading) {
          flushParagraph()
          flushList()
          const level = Math.min(3, heading[1].length)
          html.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`)
          continue
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/)
        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
        if (bullet || ordered) {
          flushParagraph()
          const tag = bullet ? 'ul' : 'ol'
          if (!list || list.tag !== tag) {
            flushList()
            list = { tag, items: [] }
          }
          list.items.push((bullet ?? ordered)[1])
          continue
        }
        flushList()
        paragraph.push(line.trim())
      }
      flushParagraph()
      flushList()
      return html.join('')
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

    function shortId(value) {
      const text = typeof value === 'string' ? value : ''
      return text ? text.slice(0, 8) : ''
    }

    function clockOf(value) {
      const time = value ? Date.parse(value) : NaN
      if (!Number.isFinite(time)) return ''
      const date = new Date(time)
      const sameDay = new Date().toDateString() === date.toDateString()
      const pad = number => String(number).padStart(2, '0')
      return sameDay
        ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
        : `${date.getMonth() + 1}/${date.getDate()}`
    }

    function sessionTitle(session) {
      if (!session || typeof session !== 'object') return ''
      if (typeof session.title === 'string' && session.title.trim()) return session.title.trim()
      if (typeof session.first === 'string' && session.first.trim()) return session.first.trim().slice(0, 60)
      return shortId(session.sessionId) || '会话'
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
        sessions: [],
        sessionsReason: '',
        conn: 'connecting',
        mode: 'queue',
        toast: null,
        typing: false,
        sending: false,
        currentId: null,
        railBusy: false,
      }
    }

    /** Replace one message in place and keep every other row identical. */
    function patchMessage(messages, id, patch) {
      return messages.map(message => (message.id === id ? { ...message, ...patch } : message))
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
          let next = { ...model, typing: false }
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
            messages[pendingIndex] = { ...messages[pendingIndex], pending: false, at: event.time ?? messages[pendingIndex].at }
            return { ...model, messages, typing: true }
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
          return { ...model, sessionId: frame.sessionId ?? model.sessionId, capabilities: frame.capabilities ?? model.capabilities, conn: 'live' }
        case 'session':
          if (!frame.sessionId || frame.sessionId === model.sessionId) return model
          return { ...model, sessionId: frame.sessionId, messages: [], approvals: [], currentId: null, typing: false }
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
          const index = model.messages.findIndex(message => message.role === 'user' && message.pending && message.text.trim() === String(frame.text ?? '').trim())
          if (index < 0) return model
          return { ...model, messages: patchMessage(model.messages, model.messages[index].id, { pending: false, at: Date.now() }) }
        }
        case 'approval': {
          const approval = frame.approval
          if (frame.action === 'asked' && approval?.id) {
            const others = model.approvals.filter(entry => entry.id !== approval.id)
            return { ...model, approvals: [...others, approval] }
          }
          if (frame.id) {
            return { ...model, approvals: model.approvals.filter(entry => entry.id !== frame.id) }
          }
          return model
        }
        case 'runs':
          return { ...model, runs: Array.isArray(frame.runs) ? frame.runs : [] }
        case 'canceling':
          return model
        case 'error':
          return { ...model, conn: frame.code === 'follow-failed' || frame.code === 'state-failed' ? 'warn' : model.conn }
        case 'closed':
          return { ...model, conn: 'warn' }
        default:
          return model
      }
    }

    function Header(props) {
      const { model, title, onNew, onRefresh } = props
      return h('header', { className: 'dsa-header' },
        h('div', { className: 'dsa-crumbs' },
          h('span', { className: 'dsa-crumb' }, PANEL_LABEL),
          h('span', { className: 'dsa-sep' }, '/'),
          h('span', { className: 'dsa-crumb dsa-crumb-current' }, title)),
        h('div', { className: 'dsa-head-actions' },
          h('span', { className: 'dsa-status' },
            h('span', { className: 'dsa-dot', 'data-state': model.conn }),
            model.conn === 'live' ? '已连接' : model.conn === 'warn' ? '流中断' : '连接中'),
          h('button', { type: 'button', className: 'dsa-iconbtn', title: '刷新', onClick: onRefresh },
            h(Icon, { of: 'refresh' })),
          h('button', { type: 'button', className: 'dsa-iconbtn', title: '新建会话', onClick: onNew },
            h(Icon, { of: 'newChat' }))))
    }

    function UserMessage(props) {
      return h('div', { className: 'dsa-user' },
        h('div', {
          className: 'dsa-bubble',
          'data-pending': props.message.pending === true ? 'true' : 'false',
        }, props.message.text))
    }

    function AssistantMessage(props) {
      const message = props.message
      const tools = Array.isArray(message.tools) ? message.tools : []
      const children = []
      if (message.reasoning) {
        children.push(h('div', { key: 'reasoning', className: 'dsa-reasoning' }, message.reasoning))
      }
      if (tools.length > 0) {
        children.push(h('div', { key: 'tools', className: 'dsa-tools-row' }, tools.map(tool => h('span', {
          key: tool.callId ?? tool.name,
          className: 'dsa-tool',
          'data-status': tool.status,
          title: typeof tool.arguments === 'string' ? tool.arguments : undefined,
        }, tool.name))))
      }
      if (message.text) {
        children.push(h('div', {
          key: 'text',
          className: 'dsa-md',
          // The renderer escapes every text run before it becomes markup.
          dangerouslySetInnerHTML: { __html: markdownHtml(message.text) },
        }))
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
      return h('div', { className: 'dsa-approvals' }, props.approvals.map(entry => h('div', {
        key: entry.id,
        className: 'dsa-approval',
      },
      h('div', { className: 'dsa-approval-title' }, `等你决定：${entry.toolName ?? '工具调用'}`),
      entry.callArguments || entry.reason
        ? h('div', { className: 'dsa-approval-body' }, entry.callArguments ?? entry.reason)
        : null,
      h('div', { className: 'dsa-approval-actions' },
        h(Button ?? 'button', {
          variant: Button ? 'outline' : undefined,
          className: Button ? undefined : 'dsa-add',
          type: Button ? undefined : 'button',
          onClick: () => props.onDecide(entry.id, 'reject'),
        }, '拒绝'),
        h(Button ?? 'button', {
          variant: Button ? 'outline' : undefined,
          type: Button ? undefined : 'button',
          onClick: () => props.onDecide(entry.id, 'allow-tool'),
        }, '本会话都放行'),
        h(Button ?? 'button', {
          variant: Button ? 'primary' : undefined,
          type: Button ? undefined : 'button',
          onClick: () => props.onDecide(entry.id, 'allow'),
        }, '允许一次')))))
    }

    function Composer(props) {
      const { hero, disabled, onSend } = props
      const [text, setText] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const areaRef = react.useRef(null)
      const fileRef = react.useRef(null)

      const grow = () => {
        const area = areaRef.current
        if (!area) return
        area.style.height = 'auto'
        area.style.height = `${Math.min(area.scrollHeight, 336)}px`
      }

      /** Files are copied into the workspace by the console, then the path is typed. */
      const attach = async files => {
        const list = Array.from(files || []).filter(Boolean)
        if (list.length === 0) return
        setBusy(true)
        for (const file of list) {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer())
            let binary = ''
            for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
            const data = await call('/upload', {
              method: 'POST',
              body: JSON.stringify({ sessionId: props.model.sessionId, name: file.name, data: btoa(binary) }),
            })
            if (data?.path) {
              setText(current => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${data.path} `)
            }
          } catch (error) {
            props.onError?.(`${file.name}：${error.message}`)
          }
        }
        setBusy(false)
        grow()
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
            h('div', { className: 'dsa-tools' },
              h('input', {
                ref: fileRef,
                type: 'file',
                multiple: true,
                style: { display: 'none' },
                onChange: event => {
                  attach(event.target.files)
                  event.target.value = ''
                },
              }),
              h('button', {
                type: 'button',
                className: 'dsa-add',
                title: '放进工作区',
                disabled: busy,
                onClick: () => fileRef.current?.click(),
              }, h(Icon, { of: 'plus', size: 16 })),
              h('select', {
                className: 'dsa-chip',
                value: props.mode ?? 'queue',
                onChange: event => props.onMode(event.target.value),
                title: '发送方式',
              },
              h('option', { value: 'queue' }, '排队'),
              h('option', { value: 'steer' }, '插话'))),
            h('div', { className: 'dsa-trailing' },
              h('button', {
                type: 'button',
                className: 'dsa-send',
                disabled: disabled || !text.trim(),
                title: '发送',
                onClick: submit,
              }, h(Icon, { of: 'send', size: 15 }))))),
        h('div', { className: 'dsa-stats' },
          h('span', null, props.model.sessionId ? `会话 ${shortId(props.model.sessionId)}` : '还没有会话'),
          h('span', null, `${props.model.runs.length} 条任务线`)))
    }

    function Rail(props) {
      const { model, onSwitch } = props
      return h('aside', { className: 'dsa-rail' },
        h('div', { className: 'dsa-rail-head' },
          h('span', null, '会话'),
          h('span', null, `${model.sessions.length}`)),
        h('div', { className: 'dsa-rail-list' },
          model.sessions.length === 0
            ? h('div', { className: 'dsa-hint', style: { padding: '8px' } }, model.sessionsReason || '还没有历史会话')
            : model.sessions.map(session => h('button', {
              key: session.sessionId,
              type: 'button',
              className: 'dsa-rowitem',
              'data-selected': session.sessionId === model.sessionId ? 'true' : 'false',
              title: sessionTitle(session),
              onClick: () => onSwitch(session.sessionId),
            },
            h('span', { className: 'dsa-rowtitle' }, sessionTitle(session)),
            h('span', { className: 'dsa-rowtime' }, clockOf(session.updatedAt))))),
        h('div', { className: 'dsa-rail-head' },
          h('span', null, '任务线'),
          h('span', null, `${model.runs.length}`)),
        h('div', { className: 'dsa-rail-list' },
          model.runs.length === 0
            ? h('div', { className: 'dsa-hint', style: { padding: '8px' } }, '这一轮还没有任务线')
            : model.runs.map(run => h('div', {
              key: run.id,
              className: 'dsa-rowitem',
              title: run.goal ?? '',
            },
            h('span', { className: 'dsa-rowtitle' }, run.goal ?? '任务线'),
            h('span', { className: 'dsa-rowtime' }, run.status === 'running' ? '运行中' : run.status === 'completed' ? '完成' : '已停')))))
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
      const title = (() => {
        const current = model.sessions.find(session => session.sessionId === model.sessionId)
        return current ? sessionTitle(current) : model.sessionId ? `会话 ${shortId(model.sessionId)}` : '新会话'
      })()
      const empty = model.messages.length === 0
      const notify = text => dispatch({ type: 'toast', text })
      return h('div', { className: 'dsa-root' },
        h(Header, {
          model,
          title,
          onNew: () => dispatch({ type: 'new-session' }),
          onRefresh: () => dispatch({ type: 'refresh' }),
        }),
        h(Toast, { toast: model.toast }),
        h('div', { className: 'dsa-body' },
          h('div', { className: 'dsa-main' },
            empty
              ? h(Hero, {
                model,
                mode: model.mode,
                disabled: model.sending,
                onSend: text => dispatch({ type: 'send', text }),
                onMode: mode => dispatch({ type: 'mode', mode }),
                onError: notify,
              })
              : h(Transcript, { model, scrollRef: model.scrollRef }),
            h(Approvals, {
              approvals: model.approvals,
              onDecide: (id, decision) => dispatch({ type: 'decide', id, decision }),
            }),
            empty ? null : h(Composer, {
              model,
              mode: model.mode,
              disabled: model.sending || model.capabilities?.chat === false,
              onSend: text => dispatch({ type: 'send', text }),
              onMode: mode => dispatch({ type: 'mode', mode }),
              onError: notify,
            })),
          h(Rail, {
            model,
            onSwitch: sessionId => dispatch({ type: 'switch', sessionId }),
          })))
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

      /** Pull the session list; a failure only dims the rail. */
      const loadSessions = async () => {
        try {
          const data = await call('/sessions')
          patch(current => ({
            ...current,
            sessions: Array.isArray(data?.sessions) ? data.sessions : [],
            sessionsReason: typeof data?.reason === 'string' ? data.reason : '',
          }))
        } catch (error) {
          patch(current => ({ ...current, sessionsReason: error.message }))
        }
      }

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
          loadSessions()
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
            if (frame?.type === 'session' || frame?.type === 'runs') loadSessions()
          })
          source.onopen = () => patch(current => ({ ...current, conn: 'live' }))
          source.onerror = () => patch(current => ({ ...current, conn: 'warn' }))
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
          try {
            await call('/message', {
              method: 'POST',
              body: JSON.stringify({ text, mode: modelRef.current.mode ?? 'queue', sessionId }),
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
          try {
            await call('/approval', { method: 'POST', body: JSON.stringify({ id, decision }) })
            patch(current => ({ ...current, approvals: current.approvals.filter(entry => entry.id !== id) }))
          } catch {
            // The card stays: the answer was not applied.
          }
        },
        switch: async action => {
          const { sessionId } = action
          if (!sessionId || sessionId === modelRef.current.sessionId) return
          await call('/session/switch', { method: 'POST', body: JSON.stringify({ sessionId }) })
          patch(current => ({ ...current, phase: 'loading', messages: [], approvals: [], currentId: null, typing: false }))
          setAttempt(value => value + 1)
        },
        'new-session': async () => {
          await call('/session', { method: 'POST', body: JSON.stringify({}) })
          patch(current => ({ ...current, phase: 'loading', messages: [], approvals: [], currentId: null, typing: false }))
          setAttempt(value => value + 1)
        },
        refresh: () => {
          patch(current => ({ ...current, phase: 'loading' }))
          setAttempt(value => value + 1)
        },
        retry: () => {
          patch(current => ({ ...current, phase: 'loading', reason: '' }))
          setAttempt(value => value + 1)
        },
        mode: action => patch(current => ({ ...current, mode: action.mode })),
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
