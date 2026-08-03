/**
 * Настройки: профиль, вид, приложение, доступ для ботов, данные.
 *
 * Токен показывается ровно один раз — сервер хранит только его хеш.
 * Об этом прямо написано рядом с кнопкой, а не спрятано в подсказке.
 */

import './theme.js';
import { h, replace, add, $ } from './dom.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { openSheet, confirmSheet } from './components/sheet.js';
import { cycleTheme, getTheme, setTheme, THEME_ICON, THEME_LABEL } from './theme.js';
import { qrSvg } from './qr.js';
import { formatShort, formatMinutes, parseTimeToMinutes } from './dates.js';
import * as push from './push.js';
import * as native from './native.js';

const TIMEZONES = [
  'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg',
  'Asia/Omsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk',
  'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka', 'UTC',
];

let profile = null;
let pushStatus = null;
let alarmPerms = null;
let tokenList = [];
let deviceList = [];
let col;

// ── Каркас ───────────────────────────────────────────────────

function layout() {
  const body = h('div.app-body', { style: { gridTemplateColumns: 'minmax(0, 1fr)' } },
    h('div.col', { id: 'settings-col', style: { maxWidth: '720px' } }));

  replace($('#app'),
    h('header.hdr',
      h('a.hdr-brand', { href: '/app.html' },
        h('img', { src: '/icons/logo-256.png', alt: '', width: 26, height: 26 }),
        h('b', { text: 'NewDay' })),
      h('span.grow', h('span.eyebrow', { text: 'настройки' })),
      h('div.hdr-actions', h('a.btn.btn-sm', { href: '/app.html', text: '← К дню' }))),
    body);
  return $('#settings-col');
}

const section = (title, ...children) =>
  h('section.card',
    h('div.card-hd', h('span.eyebrow', { text: title })),
    h('div.card-bd.pad', h('div.stack', ...children)));

const field = (label, control, hint) =>
  h('label.stack', { style: { gap: '4px' } },
    h('span.eyebrow', { text: label }),
    control,
    hint ? h('span.small', { text: hint }) : null);

function segmented(options, value, onChange) {
  return h('div.row', { style: { gap: '4px', flexWrap: 'wrap' } },
    ...options.map(([v, t]) => h('button.tab', {
      type: 'button', text: t,
      'aria-selected': v === value ? 'true' : 'false',
      onclick: e => {
        [...e.currentTarget.parentNode.children].forEach(n => n.setAttribute('aria-selected', 'false'));
        e.currentTarget.setAttribute('aria-selected', 'true');
        onChange(v);
      },
    })));
}

async function save(fields) {
  try {
    profile = await api.saveSettings(fields);
    toast('Сохранено');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Разделы ──────────────────────────────────────────────────

function profileSection() {
  return section('профиль',
    field('Почта', h('input.input', { value: profile.email || profile.username || '', disabled: true })),
    field('Имя', h('input.input', {
      value: profile.displayName, placeholder: 'Как к вам обращаться',
      onchange: e => save({ displayName: e.target.value.trim() }),
    })),
    field('Часовой пояс',
      h('select.input', {
        onchange: e => save({ timezone: e.target.value }),
      }, ...timezoneOptions()),
      'От него зависят «сегодня», границы суток и подсчёт серий'),
    h('div.row',
      h('button.btn.btn-ghost', {
        text: 'Выйти из аккаунта',
        onclick: async () => {
          await api.logout().catch(() => {});
          location.replace('/login.html');
        },
      })));
}

function timezoneOptions() {
  const list = TIMEZONES.includes(profile.timezone) ? TIMEZONES : [profile.timezone, ...TIMEZONES];
  return list.map(tz => h('option', {
    value: tz, text: tz.replace('_', ' '), selected: tz === profile.timezone,
  }));
}

function viewSection() {
  return section('вид',
    field('Тема', segmented(
      [['system', 'Системная'], ['light', 'Светлая'], ['dark', 'Тёмная']],
      getTheme(), v => setTheme(v))),
    field('Расписание', segmented(
      [['list', 'Список'], ['timeline', 'Таймлайн']],
      profile.scheduleView, v => save({ scheduleView: v })),
      'Список компактнее и лучше печатается, таймлайн показывает длительность и дыры в дне'),
    field('Питание', segmented(
      [['checklist', 'Чек-лист'], ['timed', 'По времени']],
      profile.foodMode, v => save({ foodMode: v })),
      'В режиме «по времени» приёмы пищи попадают в расписание дня'),
    field('Начало недели', segmented(
      [[1, 'Понедельник'], [7, 'Воскресенье']],
      profile.weekStart, v => save({ weekStart: v }))));
}

const LEAD_TIMES = [[0, 'Ровно в срок'], [5, 'За 5 мин'], [10, 'За 10 мин'], [15, 'За 15 мин'], [30, 'За 30 мин']];

function notificationsSection() {
  const perm = push.permission();
  const st = pushStatus;

  if (!st?.enabled) {
    return section('уведомления',
      h('p.small', { text: 'Уведомления на сервере не настроены: не заданы VAPID-ключи. Раздел появится, когда администратор их добавит.' }));
  }

  const subscribed = (st.subscriptions?.length ?? 0) > 0;
  const cfg = st.settings || {};
  const quietOn = cfg.quietFrom !== null && cfg.quietTo !== null;

  const state = perm === 'unsupported' ? h('p.small', { text: 'Этот браузер не умеет уведомления.' })
    : perm === 'denied' ? h('div.form-error', {
        text: 'Уведомления заблокированы в настройках браузера. Разрешите их для этого сайта в адресной строке — иконка слева от адреса.',
      })
    : subscribed ? h('div.row',
        h('span.pill', { text: '✓ этот браузер подписан' }),
        h('button.btn.btn-sm', { text: 'Проверить', onclick: testPush }),
        h('button.btn.btn-sm.btn-ghost', { text: 'Отключить', onclick: disablePush }))
    : h('button.btn.btn-primary', { text: 'Разрешить уведомления', onclick: enablePush });

  return section('уведомления',
    h('p.small', { text: 'Приходят к строкам расписания, у которых стоит колокольчик или будильник. Работают, даже когда вкладка закрыта.' }),
    state,
    h('div.divider'),
    field('Предупреждать по умолчанию', segmented(
      LEAD_TIMES.map(([v, t]) => [v, t]), cfg.notifyDefaultBeforeMin,
      v => saveNotify({ notifyDefaultBeforeMin: v })),
      'У отдельной строки можно задать своё время'),
    field('Уведомления включены', segmented(
      [[true, 'Да'], [false, 'Нет']], cfg.notifyEnabled !== false,
      v => saveNotify({ notifyEnabled: v })),
      'Выключатель снимает всё запланированное, отметки на строках сохраняются'),
    quietHoursBlock(cfg, quietOn),
    st.pending?.length
      ? h('div',
          h('span.eyebrow', { text: `ближайшие · ${st.pending.length}` }),
          h('div.stack', { style: { marginTop: '6px' } },
            ...st.pending.slice(0, 5).map(p => h('div.row',
              h('span.mono', { text: new Date(p.fireAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
              h('span.small', { text: p.payload.body })))))
      : h('p.small', { text: 'Пока ничего не запланировано: поставьте колокольчик на строке расписания.' }));
}

function quietHoursBlock(cfg, quietOn) {
  const from = h('input.input.time-field', {
    value: quietOn ? formatMinutes(cfg.quietFrom) : '23:00',
    'aria-label': 'Начало тихих часов', inputMode: 'numeric',
  });
  const to = h('input.input.time-field', {
    value: quietOn ? formatMinutes(cfg.quietTo) : '07:00',
    'aria-label': 'Конец тихих часов', inputMode: 'numeric',
  });

  return h('div',
    h('span.eyebrow', { text: 'тихие часы' }),
    h('div.row', { style: { marginTop: '6px', flexWrap: 'wrap' } },
      segmented([[true, 'Включены'], [false, 'Выключены']], quietOn, v => {
        if (!v) return saveNotify({ quietFrom: null, quietTo: null });
        saveNotify({
          quietFrom: parseTimeToMinutes(from.value) ?? 23 * 60,
          quietTo: parseTimeToMinutes(to.value) ?? 7 * 60,
        });
      }),
      from, h('span.small', { text: '—' }), to,
      h('button.btn.btn-sm', {
        text: 'Применить',
        onclick: () => {
          const a = parseTimeToMinutes(from.value);
          const b = parseTimeToMinutes(to.value);
          if (a === null || b === null) { toast('Не понял время', 'error'); return; }
          saveNotify({ quietFrom: a, quietTo: b });
        },
      })),
    h('span.small', { text: 'В этот промежуток уведомления не приходят. Промежуток может пересекать полночь.' }));
}

async function saveNotify(settings) {
  try {
    await api.saveSettings({ settings });
    await api.POST('/push/replan');
    await reload();
    toast('Сохранено');
  } catch (e) { toast(e.message, 'error'); }
}

async function enablePush() {
  const res = await push.enable();
  if (res.ok) { await reload(); toast('Уведомления включены'); return; }
  const why = {
    UNSUPPORTED: 'Этот браузер не умеет уведомления',
    SERVER_DISABLED: 'На сервере не настроены VAPID-ключи',
    DENIED: 'Разрешение не выдано. Его можно вернуть в настройках сайта в браузере',
  };
  toast(why[res.reason] || 'Не получилось включить уведомления', 'error');
}

async function disablePush() {
  await push.disable();
  await reload();
  toast('Уведомления отключены в этом браузере');
}

async function testPush() {
  try {
    await push.sendTest();
    toast('Отправил — уведомление должно прийти через пару секунд');
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * Проверка будильника.
 *
 * Разрешения не выпрашиваются пачкой при запуске: человек, не понимающий,
 * зачем его спросили, жмёт «запретить» навсегда. Здесь каждый пункт объяснён
 * и чинится кнопкой, которая ведёт ровно в нужный системный экран.
 * Внизу — тестовый будильник: убедиться, что он сработает на этом телефоне,
 * можно только дав ему сработать.
 */
const ALARM_CHECKS = [
  {
    key: 'notifications', what: 'notifications', title: 'Уведомления разрешены',
    why: 'Без них система не покажет ни напоминание, ни экран будильника.',
  },
  {
    key: 'exactAlarm', what: 'exactAlarm', title: 'Точные будильники',
    why: 'Иначе Android разбудит «примерно когда-нибудь», а не в 6:00.',
  },
  {
    key: 'overlay', what: 'overlay', title: 'Показ поверх других приложений',
    why: 'Без этого экран будильника не поднимется, если телефон разблокирован и им пользуются.',
  },
  {
    key: 'fullScreenIntent', what: 'fullScreenIntent', title: 'Экран поверх блокировки',
    why: 'Нужно, чтобы будильник появился на заблокированном телефоне.',
  },
  {
    key: 'batteryUnrestricted', what: 'battery', title: 'Без ограничений батареи',
    why: 'С ограничениями система может задержать будильник или не дать ему звучать.',
  },
];

function alarmSection() {
  if (!native.available()) return null;
  const p = alarmPerms;
  if (!p) {
    return section('будильник',
      h('p.small', { text: 'Не удалось получить состояние разрешений. Перезапустите приложение.' }));
  }

  const rows = ALARM_CHECKS.map(c => {
    const ok = Boolean(p[c.key]);
    return h('div.permrow', { class: ok ? 'ok' : 'bad' },
      h('span.permmark', { text: ok ? '✓' : '!' }),
      h('div',
        h('b', { text: c.title }),
        h('div.hmeta', { text: c.why })),
      ok
        ? h('span.pill', { text: 'готово' })
        : h('button.btn.btn-sm.btn-primary', {
            text: 'Исправить',
            onclick: async () => { await native.openSystemSettings(c.what); },
          }));
  });

  const problems = ALARM_CHECKS.filter(c => !p[c.key]).length;

  return section('будильник',
    problems === 0
      ? h('p.small', { text: 'Все разрешения на месте. Будильник сработает даже в беззвучном режиме и при «Не беспокоить».' })
      : h('div.form-error', { text: `Не хватает разрешений: ${problems}. Пока они не выданы, будильник может не сработать.` }),
    ...rows,
    p.needsVendorAutostart
      ? h('div',
          h('span.eyebrow', { text: 'оболочка ' + p.manufacturer }),
          h('p.small', { text: 'На этой прошивке автозапуск приложений отключается отдельно от системных разрешений. '
            + 'Найдите NewDay в списке автозапуска и разрешите его, иначе будильник может не сработать после перезагрузки.' }),
          h('button.btn.btn-sm', {
            text: 'Открыть настройки приложения',
            onclick: () => native.openSystemSettings('app'),
          }))
      : null,
    h('div.divider'),
    h('div.row', { style: { flexWrap: 'wrap' } },
      h('button.btn.btn-primary', {
        text: 'Тестовый будильник через минуту',
        onclick: async () => {
          await native.testAlarm(60, 'wakeup');
          toast('Заблокируйте экран и подождите минуту');
        },
      }),
      h('button.btn', {
        text: 'Проверить сейчас',
        onclick: async () => {
          await native.testAlarm(5, 'gentle');
          toast('Через 5 секунд');
        },
      })),
    h('p.small', { text: 'Если приложение принудительно остановить в настройках Android, будильники перестанут '
      + 'приходить, пока приложение не запустят снова — так работает система, обойти это нельзя.' }));
}

function appSection() {
  const link = `${location.origin}/downloads/NewDay.apk`;
  return section('приложение для android',
    h('div.row', { style: { alignItems: 'flex-start', gap: 'var(--s-4)', flexWrap: 'wrap' } },
      qrSvg(link, { size: 132 }),
      h('div.stack', { style: { flex: '1 1 220px' } },
        h('p.small', { text: 'Наведите камеру телефона или откройте ссылку — начнётся загрузка APK.' }),
        h('a.btn.btn-primary', { href: '/downloads/NewDay.apk', text: 'Скачать APK', download: '' }),
        h('a.btn.btn-ghost', { href: '/install.html', text: 'Как установить' }))));
}

function devicesSection() {
  const rows = deviceList.length
    ? deviceList.map(d => h('div.trow', { style: { gridTemplateColumns: 'minmax(0,1fr) auto auto' } },
        h('div',
          h('b', { text: d.name || 'Устройство' }),
          h('div.hmeta', { text: `${d.platform || 'неизвестная платформа'} · подключено ${formatShort(d.created_at.slice(0, 10))}` })),
        d.last_seen_at ? h('span.pill', { text: `был ${formatShort(d.last_seen_at.slice(0, 10))}` }) : null,
        h('button.btn.btn-sm.btn-danger', {
          text: 'Отозвать',
          onclick: async () => {
            const ok = await confirmSheet('Отозвать устройство?',
              `«${d.name || 'Устройство'}» потеряет доступ немедленно. Войти снова можно будет по новому коду.`,
              { okText: 'Отозвать' });
            if (!ok) return;
            try { await api.devices.revoke(d.id); await reload(); toast('Устройство отозвано'); }
            catch (e) { toast(e.message, 'error'); }
          },
        })))
    : [h('p.empty', { text: 'Подключённых устройств нет.' })];

  return section('устройства',
    h('p.small', { text: 'Войдите в приложение на телефоне, не вводя пароль: покажите ему код.' }),
    h('button.btn.btn-primary', { text: 'Показать код для входа', onclick: openPairing }),
    ...rows);
}

async function openPairing() {
  let pair;
  try { pair = await api.devices.pair(); }
  catch (e) { toast(e.message, 'error'); return; }

  openSheet('Вход на телефоне', (body, { close }) => {
    const left = Math.max(0, Math.round((pair.expiresAt - Date.now()) / 1000));
    const timer = h('span.pill', { text: `код действует ${left} с` });

    add(body, h('div.stack', { style: { justifyItems: 'center', textAlign: 'center' } },
      qrSvg(pair.url, { size: 220 }),
      h('p.small', { text: 'Откройте NewDay на телефоне → «Войти по QR-коду» и наведите камеру.' }),
      h('div.divider'),
      h('span.eyebrow', { text: 'или введите код вручную' }),
      h('div.display', { text: pair.shortCode, style: { fontFamily: 'var(--font-mono)' } }),
      timer));

    const tick = setInterval(() => {
      const s = Math.round((pair.expiresAt - Date.now()) / 1000);
      if (s <= 0) { clearInterval(tick); close(); toast('Код истёк, создайте новый'); return; }
      timer.textContent = `код действует ${s} с`;
    }, 1000);
  });
}

function tokensSection() {
  const rows = tokenList.length
    ? tokenList.map(t => h('div.trow', { style: { gridTemplateColumns: 'minmax(0,1fr) auto auto' } },
        h('div',
          h('b', { text: t.name || 'Без названия' }),
          h('div.hmeta', { text: `nd_${t.prefix}… · ${t.scope === 'write' ? 'чтение и запись' : 'только чтение'}` +
            (t.last_used_at ? ` · использован ${formatShort(t.last_used_at.slice(0, 10))}` : ' · ещё не использован') })),
        h('span'),
        h('button.btn.btn-sm.btn-danger', {
          text: 'Отозвать',
          onclick: async () => {
            const ok = await confirmSheet('Отозвать токен?',
              `«${t.name || 'Без названия'}» перестанет работать сразу. Всё, что им пользуется, потеряет доступ.`,
              { okText: 'Отозвать' });
            if (!ok) return;
            try { await api.tokens.revoke(t.id); await reload(); toast('Токен отозван'); }
            catch (e) { toast(e.message, 'error'); }
          },
        })))
    : [h('p.empty', { text: 'Токенов нет. Создайте, если хотите заполнять день из бота или нейросети.' })];

  return section('доступ для ботов',
    h('p.small', { text: 'Токен даёт программный доступ к вашим дням, привычкам и настройкам через API. Документация — на странице /api/docs.' }),
    h('button.btn.btn-primary', { text: 'Создать токен', onclick: openTokenDialog }),
    ...rows);
}

function openTokenDialog() {
  let name = '';
  let scope = 'read';

  openSheet('Новый токен', (body, { close }) => {
    add(body, h('div.stack',
      field('Название', h('input.input', {
        placeholder: 'Например, «Телеграм-бот»',
        oninput: e => { name = e.target.value; },
      }), 'Чтобы потом понять, какой токен за что отвечает'),
      field('Права', segmented(
        [['read', 'Только чтение'], ['write', 'Чтение и запись']], scope, v => { scope = v; }),
        'С правом записи токен сможет создавать, менять и удалять ваши дни и привычки'),
      h('p.small', {
        text: 'Секрет будет показан один раз. Сервер хранит только его хеш и восстановить не сможет.',
      })));
  },
  close => [
    h('button.btn', { text: 'Отмена', onclick: close }),
    h('button.btn.btn-primary', {
      text: 'Создать',
      onclick: async () => {
        try {
          const created = await api.tokens.create(name.trim(), scope);
          close();
          showSecret(created);
          await reload();
        } catch (e) { toast(e.message, 'error'); }
      },
    }),
  ]);
}

function showSecret(created) {
  openSheet('Токен создан', (body) => {
    const box = h('textarea.input', {
      value: created.token, readOnly: true, rows: 3,
      style: { fontFamily: 'var(--font-mono)', fontSize: '13px' },
      onclick: e => e.target.select(),
    });
    add(body, h('div.stack',
      h('p.small', { text: 'Скопируйте сейчас — второй раз он не покажется.' }),
      box,
      h('button.btn', {
        text: 'Скопировать',
        onclick: async () => {
          try { await navigator.clipboard.writeText(created.token); toast('Токен скопирован'); }
          catch { box.select(); toast('Выделено — скопируйте вручную'); }
        },
      }),
      h('div.divider'),
      h('span.eyebrow', { text: 'проверить' }),
      h('textarea.input', {
        readOnly: true, rows: 3,
        style: { fontFamily: 'var(--font-mono)', fontSize: '12px' },
        value: `curl -H "Authorization: Bearer ${created.token}" \\\n  ${location.origin}/api/v1/days/${new Date().toISOString().slice(0, 10)}/full`,
      })));
  }, close => [h('button.btn.btn-primary', { text: 'Готово', onclick: close })]);
}

function dataSection() {
  return section('данные',
    h('p.small', { text: 'Выгрузка содержит все дни, привычки, отметки и повторы в формате JSON.' }),
    h('div.row', { style: { flexWrap: 'wrap' } },
      h('a.btn', { href: '/api/v1/export?download=1', text: 'Скачать выгрузку', download: '' }),
      h('button.btn', { text: 'Загрузить из файла', onclick: openImport })),
    h('a.small', { href: '/api/docs', text: 'Документация API →' }));
}

function openImport() {
  let file = null;
  let mode = 'merge';

  openSheet('Загрузка данных', (body) => {
    add(body, h('div.stack',
      field('Файл выгрузки', h('input.input', {
        type: 'file', accept: 'application/json,.json',
        onchange: e => { file = e.target.files[0] || null; },
      })),
      field('Как загружать', segmented(
        [['merge', 'Дополнить'], ['replace', 'Заменить всё']], mode, v => { mode = v; }),
        '«Дополнить» пропускает дни, которые уже есть. «Заменить всё» стирает текущие данные и заливает файл.')));
  },
  close => [
    h('button.btn', { text: 'Отмена', onclick: close }),
    h('button.btn.btn-primary', {
      text: 'Загрузить',
      onclick: async () => {
        if (!file) { toast('Выберите файл', 'error'); return; }
        if (mode === 'replace') {
          const ok = await confirmSheet('Заменить все данные?',
            'Текущие дни, привычки и отметки будут стёрты и заменены содержимым файла.',
            { okText: 'Заменить' });
          if (!ok) return;
        }
        try {
          const data = JSON.parse(await file.text());
          await api.importAll(data, mode);
          close();
          toast('Данные загружены');
        } catch (e) { toast(e.message || 'Не удалось прочитать файл', 'error'); }
      },
    }),
  ]);
}

// ── Загрузка ─────────────────────────────────────────────────

async function reload() {
  [profile, tokenList, deviceList, pushStatus] = await Promise.all([
    api.getSettings(),
    api.tokens.list().catch(() => []),
    api.devices.list().catch(() => []),
    push.status().catch(() => null),
  ]);
  alarmPerms = await native.checkPermissions();
  replace(col,
    profileSection(), alarmSection(), notificationsSection(), viewSection(), appSection(),
    devicesSection(), tokensSection(), dataSection());
}

async function boot() {
  col = layout();
  try { await reload(); }
  catch (e) { toast(e.message, 'error'); }
}

boot();

// Проверка вёрстки на переполнение: /settings.html?diag=1
if (location.search.includes('diag=1')) import('./dev-overflow.js');
