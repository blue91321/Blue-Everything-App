/**
 * Service worker: makes the app installable and survivable offline.
 *
 * Deliberately simple. The shell is cached so the app opens instantly and still
 * opens when the PC is asleep; API calls are never cached, because stale tasks
 * are worse than an honest error.
 */
const CACHE = 'everything-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/health') {
    return; // straight to the network
  }

  // Network first, so a rebuilt app doesn't get pinned to a stale cache, with
  // the cache as the offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('/index.html')))
  );
});

/**
 * Web push. iOS delivers these to home-screen PWAs from 16.4 onward; the server
 * doesn't send any yet, so this is the receiving half waiting for a sender.
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'Everything', body: '' };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag,
      data: payload,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => 'focus' in c);
      return existing ? existing.focus() : self.clients.openWindow('/');
    })
  );
});
