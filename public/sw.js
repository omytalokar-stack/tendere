self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open('auraalgo-pwa-v1');
    await cache.addAll([
      '/',
      '/manifest.webmanifest',
      '/icons/auraalgo.svg',
      '/icons/auraalgo-192.png',
      '/icons/auraalgo-512.png',
      '/icons/auraalgo-maskable-512.png',
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('auraalgo-pwa-') && key !== 'auraalgo-pwa-v1')
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open('auraalgo-pwa-v1');
          await cache.put('/', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('/'))
          || new Response('AuraAlgo is offline. Connect to the internet to load the app.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
      }
    })());
    return;
  }

  if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/icons/')
    && url.pathname !== '/manifest.webmanifest') return;

  event.respondWith((async () => {
    const cache = await caches.open('auraalgo-pwa-v1');
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(event.notification.data?.url || '/');
  })());
});
