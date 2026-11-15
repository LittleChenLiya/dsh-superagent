/**
 * dsh-superagent — browser half.
 *
 * One left-sidebar navigation entry ("超级智能体") that opens the existing
 * loopback console page inside a main panel. The console keeps its own
 * conversation, task lines, summary, artifacts and history; this module adds
 * no second UI, it only seats the page in the host frame.
 *
 * Failure containment is deliberate: this file must never take the host page
 * down. The top level only registers a factory; everything else runs inside
 * `withFallback`, so a bad address route or a missing slot leaves the entry
 * absent instead of breaking the frame.
 *
 * @module dsh-superagent/client
 */

window.__ModuleLoader__.load({
  id: '@xiangyixie/dsh-superagent',
  factory: require => {
    // The host rejects the whole composition when a client module exposes no
    // `apply`, so publish a valid face first and only then fill it in. Anything
    // that fails below costs the sidebar row, never the page.
    const exports = { apply() {} }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const PANEL_ID = 'superagent'
    const PANEL_LABEL = '超级智能体'
    /** Host web-server route owned by this plugin's node half. */
    const ADDRESS_ROUTE = '/superagent/console-address'
    const RETRIES = 3
    const RETRY_MS = 700

    let react = null
    try {
      react = require('react')
    } catch (error) {
      console.error('[dsh-superagent] cannot load react; the sidebar entry stays absent', error)
    }

    const h = react ? react.createElement : null

    /** Decorative four-point spark used by the sidebar row. */
    function EntryIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4 6.3 9.7 1.6 8l4.7-1.7z' }),
      )
    }

    const frameStyle = { position: 'absolute', inset: 0, width: '100%', height: '100%', border: '0', display: 'block' }
    const seatStyle = { position: 'relative', width: '100%', height: '100%', minHeight: '520px', background: 'transparent' }
    const noteStyle = {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      padding: '24px',
      textAlign: 'center',
      font: '13px/1.6 system-ui, sans-serif',
      color: 'inherit',
    }
    const buttonStyle = {
      font: 'inherit',
      padding: '6px 14px',
      borderRadius: '999px',
      border: '1px solid currentColor',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }

    /**
     * Ask the plugin's node half where the console listens. The answer carries
     * the one-time token because this route is same-origin and loopback-only.
     * @returns {Promise<{src: string} | {reason: string}>} iframe address or why it is missing.
     */
    async function readAddress() {
      let response
      try {
        response = await fetch(ADDRESS_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
      } catch (error) {
        return { reason: `取不到控制台地址：${error?.message ?? error}` }
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        // A non-JSON answer means the host web server did not route to us.
      }
      const data = body?.data
      if (response.ok && data?.ready === true && data.url && data.token) {
        return { src: `${data.url}/?token=${encodeURIComponent(data.token)}` }
      }
      const reason = body?.message
        ?? (typeof data?.reason === 'string' ? data.reason : null)
        ?? (response.status === 404
          ? '宿主还没接入 Superagent 控制台（console-address 路由未注册）。'
          : `控制台暂不可用（HTTP ${response.status}）。`)
      return { reason }
    }

    /**
     * The main panel: the console page itself, filling the frame.
     * @returns {object} React element.
     */
    function ConsoleSurface() {
      const [view, setView] = react.useState({ phase: 'loading', src: null, reason: '' })
      const [attempt, setAttempt] = react.useState(0)

      react.useEffect(() => {
        let alive = true
        let timer = null
        let tries = 0
        const settle = next => {
          if (alive) setView(next)
        }
        const load = async () => {
          const address = await readAddress()
          if (!alive) return
          if (address.src) {
            settle({ phase: 'ready', src: address.src, reason: '' })
            return
          }
          // The node half binds the console after the plugin is ready; a first
          // miss is ordinary startup, not a failure the user should see.
          if (tries < RETRIES) {
            tries += 1
            timer = setTimeout(load, RETRY_MS)
            return
          }
          settle({ phase: 'error', src: null, reason: address.reason })
        }
        load()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [attempt])

      const children = []
      if (view.phase === 'ready') {
        children.push(h('iframe', {
          key: 'frame',
          src: view.src,
          title: 'Superagent 专属空间',
          style: frameStyle,
          allow: 'clipboard-write',
        }))
      } else if (view.phase === 'loading') {
        children.push(h('div', { key: 'note', style: noteStyle }, '正在连接 Superagent 专属空间…'))
      } else {
        children.push(h(
          'div',
          { key: 'note', style: noteStyle },
          h('div', null, view.reason),
          h('div', { style: { opacity: 0.7 } }, '在「高级」里确认控制台端口已开启（consolePort），或重试。'),
          h('button', { style: buttonStyle, type: 'button', onClick: () => setAttempt(n => n + 1) }, '重试'),
        ))
      }
      return h('div', { style: seatStyle }, children)
    }

    /** @param {object} ctx - client root context. */
    function apply(ctx) {
      try {
        if (!h) return
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          ConsoleSurface,
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

    let inject = ['slots']
    try {
      exports.apply = apply
      exports.inject = inject
    } catch (error) {
      console.error('[dsh-superagent] client exports could not be published', error)
    }
    return exports
  },
})
