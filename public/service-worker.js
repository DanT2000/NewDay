/**
 * Service worker.
 *
 * Оболочка приложения кешируется и работает офлайн; данные всегда берутся
 * из сети — показывать вчерашний день как сегодняшний хуже, чем честно
 * сказать, что связи нет.
 */

const VERSION = 'newday-8c23e5634448';
const SHELL = [
  // Веб-версия: с неё начинается браузер, и офлайн она должна открываться
  '/web.html', '/css/web.css',
  '/js/web/app.js', '/js/web/store.js', '/js/web/adapt.js', '/js/web/data.js', '/js/web/sheet.js',
  // офлайн-правки: наложение, описание запроса и сама очередь
  '/js/web/apply.js', '/js/web/ops.js', '/js/outbox.js',
  '/now.html', '/app.html', '/habits.html', '/stats.html', '/settings.html', '/notes.html',
  '/login.html', '/register.html', '/reset.html', '/index.html', '/install.html',
  /*
   * Голый «/» — это адрес запуска установленного приложения (start_url в
   * манифесте). В кеше его не было, а `activate` стирает всё, кроме этого
   * списка: первый же запуск с иконки без сети встречал человека страницей
   * «Нет связи» — без навигации и без кнопки «ещё раз».
   */
  '/',
  '/css/fonts.css', '/css/tokens.css', '/css/base.css', '/css/components.css',
  '/css/shell.css', '/css/print.css',
  // стили входа, широкого экрана и справки: без них страница открывается голой
  '/css/auth.css', '/css/desktop.css', '/css/ref.css',
  // Шрифт вшит в проект: без него интерфейс поедет системным
  '/fonts/inter-cyrillic-71d5ee93.woff2', '/fonts/inter-latin-3100e775.woff2',
  '/js/boot-theme.js', '/js/shell.js', '/js/vendor/icons.js',
  '/js/now.js', '/js/main.js', '/js/habits.js', '/js/stats.js',
  /*
   * Экран настроек — это `settings-ref.js`: на `settings.js` не ссылается ни
   * одна страница. Пока в списке лежал он, правка живого файла не меняла
   * отметку версии (то есть кеш у людей не обновлялся), а правка мёртвого —
   * меняла всем.
   */
  '/js/settings-ref.js', '/js/notes.js', '/js/sidebar.js', '/js/assistant.js',
  '/js/server-pick.js', '/js/local-wipe.js',
  '/js/api.js', '/js/store.js', '/js/dates.js', '/js/dom.js',
  '/js/theme.js', '/js/toast.js', '/js/emoji.js', '/js/emoji-data.json', '/js/qr.js',
  '/js/update.js', '/js/install-banner.js', '/js/native.js', '/js/diag.js',
  '/js/vendor/qrcode.js',
  '/js/components/drag.js', '/js/components/sheet.js', '/js/components/calendar.js',
  '/js/components/timepicker.js', '/js/push.js',
  '/js/views/schedule.js', '/js/views/schedule-timeline.js', '/js/views/schedule-actions.js',
  '/js/views/lists.js', '/js/views/progress.js', '/js/views/habits-today.js',
  '/js/views/datestrip.js', '/js/views/print.js',
  '/manifest.webmanifest',
  '/icons/favicon.png', '/icons/favicon-16.png', '/icons/apple-touch-icon.png',
  '/icons/logo-256.png', '/icons/logo-light-256.png', '/icons/logo-dark-256.png',
  '/icons/icon-192.png', '/icons/icon-512.png',
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

  /*
   * Сеть вперёд, но не дольше порога.
   *
   * «Есть Wi-Fi, а интернета нет» — гостиница, метро, поезд — это не отказ
   * соединения: пакеты идут, просто почти не идут. Сеть-вперёд без порога
   * означала, что человек смотрит в белый экран столько, сколько браузер
   * решит ждать, хотя рабочая копия лежит в кеше рядом. Ждём сеть пару
   * секунд, дальше показываем копию; ответ, который всё-таки придёт,
   * обновит кеш к следующему открытию.
   */
  const СЕТЬ_ЖДЁМ_МС = 2500;

  event.respondWith((async () => {
    const копия = await caches.match(request, { ignoreSearch: true });
    if (immutable && копия) return копия;

    const изСети = fetch(request).then(response => {
      if (response.ok) {
        caches.open(VERSION)
          .then(cache => cache.put(request, response.clone()))
          .catch(() => { /* кеш переполнен или запрещён — ответ всё равно отдадим */ });
      }
      return response;
    });
    /*
     * Когда побеждает порог, отказ сетевого обещания остаётся без обработчика,
     * и браузер пишет в консоль «Uncaught (in promise)». Ответ мы уже отдали из
     * кеша, ошибка здесь никого не касается — но в дневнике ошибок страницы она
     * выглядит как настоящая поломка и уводит от настоящих.
     */
    изСети.catch(() => {});

    if (!копия) {
      try {
        return await изСети;
      } catch {
        return new Response('Нет связи', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    }

    const порог = new Promise(resolve => setTimeout(() => resolve(копия), СЕТЬ_ЖДЁМ_МС));
    try {
      return await Promise.race([изСети, порог]);
    } catch {
      return копия;
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
    // метка склеивает повторные уведомления об одном деле; без даты она
    // превращалась в «nd-undefined-5» и склеивала разные дни в одно
    tag: (data.itemId && data.date) ? `nd-${data.date}-${data.itemId}` : undefined,
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
      // сверяем путь целиком, а не подстрокой: «/now.html» находился внутри
      // чужого адреса, и фокус уезжал не в то окно
      let путь;
      try { путь = new URL(client.url).pathname; } catch { continue; }
      if (путь !== target.pathname) continue;
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
