/**
 * Service worker: makes the app installable and survivable offline.
 *
 * Deliberately simple. The shell is cached so the app opens instantly and still
 * opens when the PC is asleep; API calls are never cached, because stale tasks
 * are worse than an honest error.
 */
const PREFIX = 'everything-shell-';
/*
 * v2: v1 could hold the app's page saved under a script's name — the server
 * answered missing scripts with it — which drew a white window offline.
 * Changing the name is what clears it: `activate` deletes the old shells.
 */
const CACHE = `${PREFIX}v2`;
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
      /*
       * Only this worker's own old shells. It used to delete every cache but the
       * current one, which was harmless while nothing else stored anything —
       * and would now silently empty the chapters you downloaded to read on a
       * train, the first time the app updated. Other caches belong to whoever
       * made them.
       */
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))
      )
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
      /*
       * Offline: what was saved for this URL, and for a page the shell. Only for
       * a page: handing the shell back for a missing script or stylesheet is
       * HTML where code was expected, which runs nothing and leaves the window
       * white. A missing file is an error the page can see.
       */
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit) return hit;
          if (request.mode !== 'navigate') return Response.error();
          return caches.match('/').then((page) => page ?? caches.match('/index.html'));
        })
      )
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
