/* SuperAgent mobile shell: a strict, credentials-free static cache. */
const CACHE_PREFIX = 'superagent-mobile-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v1`
const SHELL_URLS = Object.freeze([
  '/mobile.html',
  '/icons/superagent-192.svg',
  '/icons/superagent-512.svg',
])
const SHELL_PATHS = new Set(SHELL_URLS)
const SENSITIVE_SEGMENTS = new Set([
  'api', 'sse', 'event', 'events', 'stream', 'streaming',
  'artifact', 'artifacts', 'token', 'tokens', 'auth',
  'authentication', 'authorization', 'login', 'logout', 'signin', 'signout',
  'oauth', 'refresh', 'bearer', 'access-token', 'api-key',
  'session', 'sessions', 'credential', 'credentials', 'control',
])

function pathOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).toLowerCase()
  } catch {
    return ''
  }
}

function isSensitivePath(pathname) {
  return pathname.split('/').some(segment => SENSITIVE_SEGMENTS.has(segment))
}

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin
}

function isCacheableRequest(request) {
  if (request.method !== 'GET' || request.mode === 'navigate' || !isSameOrigin(request)) return false
  // Only credential-free subresource requests may populate the cache. Navigations
  // can carry ambient cookies, which are not exposed through Request.headers.
  if (request.credentials !== 'omit') return false
  const url = new URL(request.url)
  const pathname = pathOf(url)
  if (url.search || url.username || url.password || isSensitivePath(pathname)) return false
  if (!SHELL_PATHS.has(pathname) || request.cache === 'no-store') return false
  const headers = request.headers
  return !headers.has('authorization')
    && !headers.has('cookie')
    && !headers.has('x-api-key')
    && !headers.has('x-access-token')
}

function isSafeStaticResponse(request, response) {
  if (!response.ok || response.type !== 'basic' || response.redirected) return false
  if (!isCacheableRequest(request)) return false
  const headers = response.headers
  const control = headers.get('cache-control') || ''
  if (/(?:^|,)\s*(?:no-store|private)\s*(?:,|$)/i.test(control)) return false
  if (headers.has('set-cookie') || headers.has('www-authenticate')) return false
  if ((headers.get('vary') || '').trim() === '*') return false
  const contentType = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const pathname = pathOf(request.url)
  if (pathname === '/mobile.html') return contentType === 'text/html'
  return contentType === 'image/svg+xml'
}

async function notifyOffline() {
  try {
    if (!self.clients || typeof self.clients.matchAll !== 'function') return
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      client.postMessage({ type: 'SUPERAGENT_OFFLINE' })
    }
  } catch {
    /* The explicit 503/offline shell must still be returned if notification fails. */
  }
}

function offlineResponse() {
  return new Response('无法连接执行服务', {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function networkOnly(request) {
  try {
    return await fetch(request)
  } catch {
    await notifyOffline()
    const pathname = pathOf(request.url)
    const allowShell = request.mode === 'navigate' && !isSensitivePath(pathname)
    if (allowShell) {
      const shell = await caches.match(new URL('/mobile.html', self.location.origin).href, { cacheName: CACHE_NAME })
      if (shell) return shell
    }
    return offlineResponse()
  }
}

async function shellFirstFromNetwork(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME })
  try {
    const response = await fetch(request)
    if (isSafeStaticResponse(request, response)) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    await notifyOffline()
    if (cached) return cached
    return offlineResponse()
  }
}

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME)
  await Promise.all(SHELL_URLS.map(async url => {
    const request = new Request(new URL(url, self.location.origin).href, {
      method: 'GET',
      mode: 'same-origin',
      credentials: 'omit',
      cache: 'reload',
      redirect: 'error',
    })
    const response = await fetch(request)
    if (!isSafeStaticResponse(request, response)) {
      throw new Error(`Refusing to cache non-static shell response: ${url}`)
    }
    await cache.put(request, response)
  }))
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (!isSameOrigin(request)) return
  if (!isCacheableRequest(request)) {
    event.respondWith(networkOnly(request))
    return
  }
  event.respondWith(shellFirstFromNetwork(request))
})
