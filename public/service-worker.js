/**
 * Service worker.
 *
 * Оболочка приложения кешируется и работает офлайн; данные всегда берутся
 * из сети — показывать вчерашний день как сегодняшний хуже, чем честно
 * сказать, что связи нет.
 */

const VERSION = 'newday-v2';
const SHELL = [
  '/app.html', '/habits.html', '/stats.html', '/settings.html',
  '/login.html', '/register.html', '/index.html', '/install.html',
  '/css/tokens.css', '/css/base.css', '/css/components.css', '/css/print.css',
  '/js/main.js', '/js/habits.js', '/js/stats.js', '/js/settings.js',
  '/js/api.js', '/js/store.js', '/js/dates.js', '/js/dom.js',
  '/js/theme.js', '/js/toast.js', '/js/emoji.js', '/js/emoji-data.json', '/js/qr.js',
  '/js/vendor/qrcode.js',
  '/js/components/drag.js', '/js/components/sheet.js',
  '/js/views/schedule.js', '/js/views/schedule-timeline.js', '/js/views/schedule-actions.js',
  '/js/views/lists.js', '/js/views/progress.js', '/js/views/habits-today.js',
  '/js/views/datestrip.js', '/js/views/print.js',
  '/manifest.webmanifest',
  '/icons/favicon.png', '/icons/logo-256.png', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll падает целиком, если хоть один файл недоступен — кешируем по одному
    await Promise.all(SHELL.map(url =>
      cache.add(url).catch(() => console.warn('[sw] не закешировано:', url))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;      // данные — только из сети
  if (url.pathname.startsWith('/downloads/')) return; // APK не кешируем

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    const network = fetch(request).then(async response => {
      if (response.ok) {
        const cache = await caches.open(VERSION);
        cache.put(request, response.clone());
      }
      return response;
    }).catch(() => null);

    // отдаём кеш сразу, а сеть обновляет его в фоне
    return cached || await network || new Response('Нет связи', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
