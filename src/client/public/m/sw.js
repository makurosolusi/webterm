// Service worker of the /m PWA (scope /m/). Two jobs only:
//  1. Offline shell: the /m/ page, its manifest/icons and the hashed build assets (/assets/*), so the
//     app opens without a network. NEVER /api/* or /ws: those carry the access token and live data,
//     and a cached approval list or brief would be both stale and a secret at rest.
//  2. Web Push: show the notification (payload = { id, kind, title, url }) and open /m on tap.
const CACHE = 'webterm-m-v1'
const SHELL = '/m/'
const PRECACHE = [SHELL, '/m/manifest.json', '/m/icon-192.png', '/m/icon.svg']

/** 'shell' = network first, cached page offline; 'asset' = cache first; null = not ours, browser default. */
function cachePolicy(request) {
  if (request.method !== 'GET') return null
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return null
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return null
  if (request.mode === 'navigate') return url.pathname.startsWith('/m') ? 'shell' : null
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) return 'asset'
  return null
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const policy = cachePolicy(event.request)
  if (!policy) return
  if (policy === 'shell') {
    // Stored under the bare shell key: a `?token=` link must never become a cache key.
    event.respondWith(fetch(event.request).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(SHELL, copy)) }
      return res
    }).catch(() => caches.match(SHELL)))
    return
  }
  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)) }
    return res
  })))
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = {} }
  const title = typeof data.title === 'string' && data.title ? data.title : 'webterm'
  const url = typeof data.url === 'string' && data.url.startsWith('/m/') ? data.url : SHELL
  event.waitUntil(self.registration.showNotification(title, {
    tag: typeof data.id === 'string' ? data.id : undefined,
    icon: '/m/icon-192.png',
    badge: '/m/icon-192.png',
    data: { url },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || SHELL
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).pathname.startsWith('/m'))
    // navigate() refuses a page this worker does not control yet; the focused page is still right.
    if (open) return open.focus().then(() => open.navigate(url)).catch(() => undefined)
    return self.clients.openWindow(url)
  }))
})
