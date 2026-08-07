/**
 * Service worker.
 *
 * Оболочка приложения кешируется и работает офлайн; данные всегда берутся
 * из сети — показывать вчерашний день как сегодняшний хуже, чем честно
 * сказать, что связи нет.
 */

const VERSION = 'newday-6705fedce7ba';
const SHELL = [
  // Веб-версия: с неё начинается браузер, и офлайн она должна открываться
  '/web.html', '/css/web.css',
  '/js/web/app.js', '/js/web/store.js', '/js/web/adapt.js', '/js/web/data.js', '/js/web/sheet.js',
  '/now.html', '/app.html', '/habits.html', '/stats.html', '/settings.html',
  '/login.html', '/register.html', '/index.html', '/install.html',
  '/css/fonts.css', '/css/tokens.css', '/css/base.css', '/css/components.css',
  '/css/shell.css', '/css/print.css',
  // Шрифт вшит в проект: без него интерфейс поедет системным
  '/fonts/inter-cyrillic-71d5ee93.woff2', '/fonts/inter-latin-3100e775.woff2',
  '/js/boot-theme.js', '/js/shell.js', '/js/vendor/icons.js',
  '/js/now.js', '/js/main.js', '/js/habits.js', '/js/stats.js', '/js/settings.js',
  '/js/api.js', '/js/store.js', '/js/dates.js', '/js/dom.js',
  '/js/theme.js', '/js/toast.js', '/js/emoji.js', '/js/emoji-data.json', '/js/qr.js',
  '/js/update.js', '/js/install-banner.js', '/js/native.js',
  '/js/vendor/qrcode.js',
  '/js/components/drag.js', '/js/components/sheet.js', '/js/components/calendar.js',
  '/js/components/timepicker.js', '/js/push.js',
  '/js/views/schedule.js', '/js/views/schedule-timeline.js', '/js/views/schedule-actions.js',
  '/js/views/lists.js', '/js/views/progress.js', '/js/views/habits-today.js',
  '/js/views/datestrip.js', '/js/views/print.js',
  '/manifest.webmanifest',
  '/icons/favicon.png', '/icons/logo-256.png', '/icons/icon-192.png', '/icons/icon-512.png',
  // знак для тёмной и светлой темы: без него в офлайне место логотипа пустует
  '/icons/logo-dark-64.png', '/icons/logo-light-64.png',
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

  /*
   * Разметка, стили и скрипты — сеть вперёд, кеш только как запас.
   *
   * Раньше здесь было наоборот, и это давало худший из возможных эффектов:
   * после выкладки страница продолжала работать на старом CSS, пока кеш
   * не сменится сам. Человек видел неизменившийся интерфейс и справедливо
   * считал, что ничего не поменялось.
   *
   * Шрифты, иконки и картинки — наоборот, кеш вперёд: их имена содержат
   * хеш или они не меняются вовсе, а тянуть их из сети каждый раз незачем.
   */
  const immutable = /^\/(fonts|icons)\//.test(url.pathname)
    || /\.(woff2|png|svg|jpg|webp)$/.test(url.pathname);

  event.respondWith((async () => {
    if (immutable) {
      const hit = await caches.match(request, { ignoreSearch: true });
      if (hit) return hit;
    }

    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(VERSION);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      const hit = await caches.match(request, { ignoreSearch: true });
      return hit || new Response('Нет связи', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});


// ── Уведомления ──────────────────────────────────────────────

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const isAlarm = data.kind === 'alarm';
  event.waitUntil(self.registration.showNotification(data.title || 'NewDay', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon.png',
    tag: data.itemId ? `nd-${data.date}-${data.itemId}` : undefined,
    renotify: Boolean(data.itemId),
    // будильник должен остаться на экране, пока его не тронут
    requireInteraction: isAlarm,
    vibrate: isAlarm ? [400, 200, 400, 200, 400] : [200],
    data: { url: data.url || '/web.html' },
    actions: [{ action: 'open', title: 'Открыть день' }],
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/web.html';

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // если приложение уже открыто — не плодим вкладки, а переводим фокус
    const target = new URL(url, self.location.origin);
    for (const client of clientsList) {
      if (!client.url.includes(target.pathname)) continue;
      await client.focus();
      /*
       * И показываем тот день, о котором звали: без этого открытая вкладка
       * просто всплывала на сегодняшнем, а напоминание было про завтра.
       */
      if (client.url !== target.href && typeof client.navigate === 'function') {
        await client.navigate(target.href).catch(() => {});
      }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
