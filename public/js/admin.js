/**
 * Страница администратора: вход, обзор, пользователи, приглашения,
 * помощник и настройки — всё без перезагрузки.
 *
 * Сервер может быть ещё не готов или недоступен — каждая ошибка
 * называется по-русски там, где человек нажал кнопку, а не в консоли.
 * Ответ 401 где угодно, кроме входа, означает, что сессия кончилась:
 * возвращаемся на экран входа и объясняем почему.
 */

import { icon } from '/js/vendor/icons.js';
import { toast } from '/js/toast.js';

const root = document.getElementById('admin');

const state = {
  authed: false,        // показан ли внутренний интерфейс
  password: '',         // пароль со входа — нужен экрану принудительной смены
  section: 'overview',
  viewToken: 0,         // защита от гонки при быстром переключении разделов
};

/* ── Запросы ─────────────────────────────────────────────────
   Сервер отвечает { error: { code, message } }; если сообщения нет,
   подставляем своё по коду состояния. Отказ сети — отдельный случай:
   fetch, упавший молча, оставил бы кнопку «нажатой в пустоту». */

const NET_ERR = 'Не получилось связаться с сервером. Проверьте, что он запущен, и попробуйте ещё раз.';

function messageFor(status) {
  if (status === 400) return 'Сервер не принял запрос.';
  if (status === 403) return 'Не хватает прав для этого действия.';
  if (status === 404) return 'Сервер пока не отвечает на этот запрос — возможно, он ещё не обновлён.';
  if (status === 429) return 'Слишком много запросов подряд. Подождите немного.';
  if (status >= 500) return 'На сервере что-то сломалось. Попробуйте ещё раз чуть позже.';
  return 'Ошибка ' + status;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw { network: true, message: NET_ERR };
  }
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ — это нормально */ }
  if (!res.ok) {
    if (res.status === 401 && state.authed) {
      state.authed = false;
      renderGate({ error: 'Сессия закончилась — войдите ещё раз.' });
    }
    throw {
      status: res.status,
      message: data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || messageFor(res.status),
    };
  }
  return data;
}

/* ── Мелкие помощники ───────────────────────────────────────── */

let uid = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'disabled') node.disabled = Boolean(v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const nf = new Intl.NumberFormat('ru-RU');
const fmtInt = n => (Number.isFinite(Number(n)) ? nf.format(Number(n)) : '—');

const dfDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dfDateTime = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dfDow = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmtDate = v => { const d = parseDate(v); return d ? dfDate.format(d) : '—'; };
const fmtDateTime = v => { const d = parseDate(v); return d ? dfDateTime.format(d) : '—'; };

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} дн ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин`;
  return `${sec} с`;
}

/* Тарифы помощника: значения из контракта, подписи по-русски */
const TIERS = [
  ['off', 'выключен'],
  ['limited', 'ограниченный'],
  ['unlimited', 'безлимит'],
];
const tierLabel = v => (TIERS.find(t => t[0] === v)?.[1]) ?? String(v ?? '—');

function tierSelect(value) {
  const s = el('select', { class: 'field' });
  for (const [v, label] of TIERS) s.append(el('option', { value: v, text: label }));
  s.value = value ?? 'off';
  if (s.selectedIndex < 0) s.selectedIndex = 0;
  return s;
}

function group(labelText, control, cls = '') {
  const id = 'adm-f' + (++uid);
  control.id = id;
  return el('div', { class: 'form-group' + (cls ? ' ' + cls : '') },
    el('label', { for: id, text: labelText }), control);
}

/* Ошибка на месте действия: красная плашка, как на экране входа */
function errBox() {
  return el('div', { class: 'form-error', style: 'display:none' });
}
function showErr(box, message) { box.textContent = message; box.style.display = ''; }
function hideErr(box) { box.textContent = ''; box.style.display = 'none'; }

function card(title, hdExtra, ...body) {
  const hd = el('div', { class: 'card-hd' }, el('h2', { class: 'eyebrow', text: title }));
  if (hdExtra) hd.append(hdExtra);
  return el('section', { class: 'card' }, hd, el('div', { class: 'card-bd pad stack' }, ...body));
}

/**
 * Переключатель. Сам блокируется на время запроса; onToggle возвращает
 * фактическое значение с сервера (или бросает — тогда положение
 * не меняется, а ошибку показывает вызывающий).
 */
function makeSwitch(checked, onToggle, label) {
  const b = el('button', {
    class: 'adm-switch', type: 'button', role: 'switch',
    'aria-checked': String(Boolean(checked)),
    'aria-label': label,
  });
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    const next = b.getAttribute('aria-checked') !== 'true';
    b.disabled = true;
    try {
      const actual = await onToggle(next);
      b.setAttribute('aria-checked', String(actual ?? next));
    } catch { /* положение не меняем — ошибка уже показана */ }
    b.disabled = false;
  });
  return b;
}

function setRow(title, note, control) {
  return el('div', { class: 'adm-setrow' },
    el('div', { class: 'adm-setrow-t' }, el('b', { text: title }), el('span', { text: note })),
    control);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Буфер обмена без https недоступен — старый обходной путь
    const ta = el('textarea', { style: 'position:fixed;opacity:0', value: text });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* не вышло */ }
    ta.remove();
    return ok;
  }
}

/* ── Экран входа ────────────────────────────────────────────── */

function renderGate({ error = '', note = '' } = {}) {
  state.authed = false;
  root.replaceChildren();

  const err = errBox();
  if (error) showErr(err, error);
  const info = note ? el('p', { class: 'adm-note', text: note }) : null;

  const pass = el('input', {
    type: 'password', name: 'password', required: '',
    autocomplete: 'current-password', placeholder: 'Пароль администратора',
  });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Войти' });

  const form = el('form', { class: 'auth-form' }, group('Пароль', pass), err, btn);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    hideErr(err);
    btn.disabled = true;
    try {
      const data = await api('POST', '/api/admin/login', { password: pass.value });
      state.password = pass.value;
      state.authed = true;
      if (data?.mustChangePassword) renderForcedChange();
      else renderShell();
      return;
    } catch (ex) {
      if (ex.status === 401) showErr(err, 'Неверный пароль.');
      else if (ex.status === 429) showErr(err, 'Слишком много попыток входа. Подождите пару минут и попробуйте ещё раз.');
      else showErr(err, ex.message);
    }
    btn.disabled = false;
  });

  root.append(el('div', { class: 'adm-gate' },
    el('div', { class: 'auth-card' },
      el('div', { class: 'auth-logo' },
        el('img', { class: 'auth-logo-icon', src: '/icons/logo-light-256.png', alt: 'NewDay', width: '88', height: '88' }),
        el('h1', { class: 'auth-logo-title', text: 'NewDay' }),
        el('p', { class: 'auth-logo-sub', text: 'Администрирование' })),
      info,
      form)));
  pass.focus();
}

/* ── Принудительная смена пароля ─────────────────────────────
   Сюда попадают, когда сервер ответил mustChangePassword: стоит
   пароль по умолчанию, и пускать дальше с ним нельзя. */

function renderForcedChange() {
  root.replaceChildren();

  const err = errBox();
  const next = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Придумайте новый пароль' });
  const again = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'И ещё раз, чтобы не опечататься' });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Сохранить и продолжить' });

  const form = el('form', { class: 'auth-form' },
    group('Новый пароль', next),
    group('Повторите пароль', again),
    err, btn);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    hideErr(err);
    if (!next.value) { showErr(err, 'Введите новый пароль.'); return; }
    if (next.value === 'newday') { showErr(err, 'Это и есть пароль по умолчанию — придумайте другой.'); return; }
    if (next.value !== again.value) { showErr(err, 'Пароли не совпадают.'); return; }
    btn.disabled = true;
    try {
      await api('POST', '/api/admin/password', { current: state.password, next: next.value });
      state.password = '';
      renderShell();
      return;
    } catch (ex) {
      showErr(err, ex.message);
    }
    btn.disabled = false;
  });

  root.append(el('div', { class: 'adm-gate' },
    el('div', { class: 'auth-card' },
      el('div', { class: 'auth-logo' },
        el('img', { class: 'auth-logo-icon', src: '/icons/logo-light-256.png', alt: 'NewDay', width: '88', height: '88' }),
        el('h1', { class: 'auth-logo-title', text: 'Смените пароль' })),
      el('p', { class: 'adm-lead', text:
        'Сейчас действует пароль по умолчанию — newday. Он одинаковый у всех установок, ' +
        'поэтому админку с ним нельзя считать закрытой. Придумайте свой — и продолжим.' }),
      el('div', { style: 'height:16px' }),
      form)));
  next.focus();
}

/* ── Каркас: шапка, навигация, разделы ──────────────────────── */

const SECTIONS = [
  ['overview', 'Обзор', 'chart-bar', renderOverview],
  ['users', 'Пользователи', 'user', renderUsers],
  ['invites', 'Приглашения', 'envelope-simple', renderInvites],
  ['ai', 'Помощник', 'sparkle-fill', renderAi],
  ['settings', 'Настройки', 'gear', renderSettings],
];

let navEl = null;
let mainEl = null;

function renderShell() {
  state.authed = true;
  root.replaceChildren();

  const logout = el('button', { class: 'icon-btn', title: 'Выйти', 'aria-label': 'Выйти' },
    icon('sign-out', { size: '18px' }));
  logout.addEventListener('click', async () => {
    try { await api('POST', '/api/admin/logout'); } catch { /* выходим в любом случае */ }
    state.authed = false;
    renderGate({ note: 'Вы вышли. Чтобы вернуться, войдите ещё раз.' });
  });

  navEl = el('nav', { class: 'adm-nav', 'aria-label': 'Разделы' });
  for (const [name, label, ico] of SECTIONS) {
    const b = el('button', { type: 'button', 'data-section': name },
      icon(ico, { size: '17px' }), el('span', { text: label }));
    b.addEventListener('click', () => showSection(name));
    navEl.append(b);
  }

  mainEl = el('main', { class: 'adm-main' });

  root.append(el('div', { class: 'adm' },
    el('header', { class: 'hdr' },
      el('div', { class: 'hdr-brand' },
        el('img', { src: '/icons/favicon.png', alt: '' }),
        el('b', { text: 'NewDay' }),
        el('span', { class: 'pill', text: 'администратор' })),
      el('div', { class: 'hdr-spacer' }),
      el('div', { class: 'hdr-actions' }, logout)),
    el('div', { class: 'adm-body' }, navEl, mainEl)));

  showSection(state.section);
}

async function showSection(name) {
  state.section = name;
  const token = ++state.viewToken;
  for (const b of navEl.querySelectorAll('button')) {
    b.setAttribute('aria-current', String(b.dataset.section === name));
  }
  mainEl.replaceChildren(el('p', { class: 'empty', text: 'Загружаю…' }));

  const entry = SECTIONS.find(s => s[0] === name);
  try {
    const content = await entry[3]();
    if (token !== state.viewToken || !state.authed) return; // раздел уже сменили
    mainEl.replaceChildren(...content);
  } catch (ex) {
    if (token !== state.viewToken || !state.authed) return;
    mainEl.replaceChildren(errorCard(ex.message, () => showSection(name)));
  }
}

function errorCard(message, retry) {
  const btn = el('button', { class: 'btn', type: 'button' },
    icon('arrows-clockwise', { size: '16px' }), el('span', { text: 'Повторить' }));
  btn.addEventListener('click', retry);
  return el('section', { class: 'card' },
    el('div', { class: 'card-bd pad stack' },
      el('div', { class: 'adm-ai-status warn' },
        icon('warning-circle-fill', { size: '18px' }),
        el('span', { text: message })),
      el('div', { class: 'adm-actions' }, btn)));
}

/* ── Обзор ──────────────────────────────────────────────────── */

async function renderOverview() {
  const stats = await api('GET', '/api/admin/stats');
  const users = stats?.users ?? {};
  const ai = stats?.ai ?? {};

  const statCard = (label, value, note) => el('div', { class: 'adm-stat' },
    el('span', { class: 'eyebrow', text: label }),
    el('span', { class: 'adm-stat-num', text: fmtInt(value) }),
    note ? el('span', { class: 'small', text: note }) : null);

  const cards = el('div', { class: 'adm-stats' },
    statCard('Пользователи', users.total, 'всего зарегистрировано'),
    statCard('За неделю', users.activeWeek, 'заходили хотя бы раз'),
    statCard('ИИ сегодня', ai.today, 'запросов к помощнику'),
    statCard('ИИ за неделю', ai.week, 'запросов к помощнику'));

  return [
    cards,
    card('Запросы к помощнику по дням', null, barsChart(ai.byDay)),
    card('Состояние сервера', null, ...healthRows(stats?.health)),
  ];
}

/**
 * Столбики по дням на чистом CSS — тот же рисунок, что у недельных
 * полосок привычек. Форма ответа сервера заранее не зафиксирована,
 * поэтому принимаем и числа, и объекты с датой.
 */
function normByDay(byDay) {
  if (!Array.isArray(byDay)) return [];
  const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  return byDay.map((it, i) => {
    if (typeof it === 'number') return { date: ago(byDay.length - 1 - i), count: it };
    const count = Number(it?.count ?? it?.n ?? it?.total ?? it?.requests ?? it?.value ?? 0) || 0;
    return { date: it?.date ?? it?.day ?? null, count };
  });
}

function barsChart(byDay) {
  const items = normByDay(byDay);
  if (!items.length) return el('p', { class: 'empty', text: 'Данных по дням пока нет.' });
  const max = Math.max(1, ...items.map(i => i.count));
  const chart = el('div', { class: 'adm-chart', role: 'img', 'aria-label': 'Запросы к помощнику по дням' });
  for (const it of items) {
    const d = parseDate(it.date);
    const col = el('div', { class: 'adm-bar', title: `${fmtInt(it.count)} — ${d ? fmtDate(it.date) : 'день ' + (items.indexOf(it) + 1)}` });
    // Подпись значения — только там, где оно есть: цифра на каждом
    // пустом столбике превращает график в таблицу нулей
    col.append(el('span', { class: 'adm-bar-v', text: it.count ? String(it.count) : '' }));
    col.append(el('div', { class: 'adm-vbar' },
      el('i', { style: `height:${Math.round((it.count / max) * 100)}%` })));
    col.append(el('span', { class: 'adm-bar-l', text: d ? dfDow.format(d) : '' }));
    chart.append(col);
  }
  const wrap = el('div', { class: 'stack' }, chart);
  if (items.every(i => !i.count)) {
    wrap.append(el('p', { class: 'small', text: 'За эти дни запросов к помощнику не было.' }));
  }
  return wrap;
}

function healthRows(health) {
  const nothing = () => [el('p', { class: 'small', text: 'Сервер не рассказал о своём состоянии.' })];
  const kv = (label, value, cls = '') => el('div', { class: 'adm-kv-row' },
    el('span', { text: label }), el('b', { class: cls, text: value }));

  if (health == null) return nothing();
  if (typeof health !== 'object') {
    return [kv('Состояние', String(health), String(health).toLowerCase() === 'ok' ? 'ok' : '')];
  }
  const LABELS = {
    ok: 'Общее состояние', status: 'Общее состояние', db: 'База данных',
    database: 'База данных', uptime: 'Время работы', uptimeSec: 'Время работы',
    uptimeSeconds: 'Время работы', memory: 'Память', rss: 'Память',
    version: 'Версия', node: 'Node.js', ai: 'Помощник', disk: 'Диск',
    schemaVersion: 'Версия схемы базы', dbWritable: 'База принимает запись',
    aiReady: 'Помощник подключён', pushEnabled: 'Уведомления настроены',
  };
  /*
   * Не всякое «нет» — сбой. Неподключённый помощник и невключённые
   * уведомления — это выбор владельца, а не поломка: красный цвет здесь
   * пугал бы на живом сервере, где просто не задан ключ ИИ.
   */
  const OPTIONAL = new Set(['aiReady', 'pushEnabled', 'ai']);
  const rows = [];
  for (const [k, v] of Object.entries(health)) {
    const label = LABELS[k] || k;
    let text; let cls = '';
    if (typeof v === 'boolean') {
      if (OPTIONAL.has(k)) { text = v ? 'да' : 'нет'; cls = v ? 'ok' : ''; }
      else { text = v ? 'в порядке' : 'сбой'; cls = v ? 'ok' : 'bad'; }
    }
    else if (/uptime/i.test(k) && Number.isFinite(Number(v))) text = fmtDuration(Number(v));
    else if (v && typeof v === 'object') text = JSON.stringify(v);
    else { text = String(v); if (String(v).toLowerCase() === 'ok') cls = 'ok'; }
    rows.push(kv(label, text, cls));
  }
  return rows.length ? rows : nothing();
}

/* ── Пользователи ───────────────────────────────────────────── */

/**
 * Спросить перед окончательным удалением. Возвращает true, если подтвердили.
 *
 * Своё окно, а не `confirm()`: тот показывает одну строку без переносов и без
 * возможности перечислить, что именно исчезнет, — а исчезает всё, что человек
 * вносил. Нативный `<dialog>` даёт и Esc, и фокус, и затемнение бесплатно.
 *
 * По умолчанию выбрана «Отмена»: у необратимого действия опасная кнопка не
 * должна срабатывать от случайного Enter.
 */
function askDelete(email) {
  return new Promise(resolve => {
    const кого = email || 'этого пользователя';
    const cancel = el('button', { class: 'btn btn-sm', type: 'button', text: 'Отмена' });
    const ok = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Удалить навсегда' });
    const dlg = el('dialog', { class: 'adm-ask' },
      el('h3', { text: 'Удалить пользователя?' }),
      el('p', {}, el('b', { text: кого })),
      el('p', {
        class: 'adm-ask-what',
        text: 'Вместе с ним исчезнет всё, что он вносил: расписание и дела, '
            + 'привычки и отметки, заметки, питание и вес, загруженные звуки, '
            + 'устройства и токены доступа.',
      }),
      el('p', { class: 'adm-ask-warn', text: 'Отменить это будет нечем.' }),
      el('div', { class: 'adm-ask-row' }, cancel, ok));

    const close = ответ => {
      dlg.close();
      dlg.remove();
      resolve(ответ);
    };
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    // Esc и нажатие мимо окна — это «нет»
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(false); });
    dlg.addEventListener('click', e => { if (e.target === dlg) close(false); });

    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

async function renderUsers() {
  const users = await api('GET', '/api/admin/users');
  const err = errBox();

  if (!Array.isArray(users) || !users.length) {
    return [card('Пользователи', null, el('p', { class: 'empty', text: 'Пока никто не зарегистрировался.' }))];
  }

  const tbody = el('tbody');
  for (const u of users) {
    const sel = tierSelect(u.aiTier);
    sel.addEventListener('change', async () => {
      hideErr(err);
      sel.disabled = true;
      try {
        await api('PATCH', `/api/admin/users/${encodeURIComponent(u.id)}`, { aiTier: sel.value });
        u.aiTier = sel.value;
        toast(`Тариф ИИ для ${u.email || 'пользователя'}: ${tierLabel(sel.value)}`);
      } catch (ex) {
        sel.value = u.aiTier ?? 'off';
        showErr(err, `Не получилось сменить тариф для ${u.email || 'пользователя'}: ${ex.message}`);
      }
      sel.disabled = false;
    });

    /*
     * Два действия — два значка, а не две кнопки с подписями.
     *
     * Подписи «Закрыть доступ» и «Удалить окончательно» не влезали в столбец и
     * разъезжались в две строки. Замок сам показывает состояние: открыт —
     * доступ есть, закрыт — доступ закрыт; нажатие переключает. Корзина рядом.
     *
     * Порядок шагов остался прежним, он же и на сервере: сначала закрыть
     * доступ, только потом удалять. Пока доступ открыт, корзина неактивна и
     * говорит почему — блокировка обратима, удаление нет.
     */
    const state = el('div', { class: 'adm-user-state' });
    const actions = el('td', { class: 'adm-user-actions' });

    const redraw = () => {
      const blocked = Boolean(u.blockedAt);
      state.replaceChildren();
      if (blocked) {
        state.append(el('span', { class: 'pill bad', text: 'доступ закрыт' }));
        if (u.deleteAfter) {
          state.append(el('span', { class: 'adm-user-till', text: `удалится сам ${fmtDate(u.deleteAfter)}` }));
        }
      }

      const lock = el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-pressed': blocked ? 'true' : 'false',
        title: blocked ? 'Доступ закрыт. Нажмите, чтобы вернуть' : 'Закрыть доступ',
        'aria-label': blocked ? 'Вернуть доступ' : 'Закрыть доступ',
      }, icon(blocked ? 'lock-simple' : 'lock-simple-open', { size: '16px' }));
      lock.addEventListener('click', async () => {
        hideErr(err);
        lock.disabled = true;
        const путь = `/api/admin/users/${encodeURIComponent(u.id)}/${blocked ? 'unblock' : 'block'}`;
        try {
          const r = await api('POST', путь);
          u.blockedAt = blocked ? null : (r?.blockedAt || new Date().toISOString());
          u.deleteAfter = blocked ? null : (r?.deleteAfter ?? null);
          toast(blocked ? 'Доступ возвращён' : `Доступ закрыт: ${u.email || 'пользователь'}`);
          redraw();
        } catch (ex) {
          showErr(err, (blocked ? 'Не получилось вернуть доступ: ' : 'Не получилось закрыть доступ: ') + ex.message);
          lock.disabled = false;
        }
      });

      const kill = el('button', {
        class: 'icon-btn adm-kill',
        type: 'button',
        disabled: !blocked,
        title: blocked
          ? 'Удалить вместе со всеми данными'
          : 'Сначала закройте доступ — удаление необратимо',
        'aria-label': 'Удалить пользователя',
      }, icon('trash', { size: '16px' }));
      kill.addEventListener('click', async () => {
        hideErr(err);
        if (!await askDelete(u.email)) return;
        kill.disabled = true;
        try {
          await api('DELETE', `/api/admin/users/${encodeURIComponent(u.id)}`);
          toast('Пользователь и его данные удалены');
          kill.closest('tr')?.remove();
        } catch (ex) {
          showErr(err, 'Не получилось удалить: ' + ex.message);
          kill.disabled = false;
        }
      });

      actions.replaceChildren(lock, kill);
    };
    redraw();

    tbody.append(el('tr', {},
      el('td', {}, el('div', { class: 'adm-user' },
        el('b', { text: u.email || '—' }),
        u.displayName ? el('span', { text: u.displayName }) : null,
        state)),
      el('td', { text: fmtDate(u.createdAt) }),
      el('td', { text: u.lastSeen ? fmtDateTime(u.lastSeen) : '—' }),
      el('td', { class: 'mono', text: fmtInt(u.aiUsedToday) }),
      el('td', {}, sel),
      actions));
  }

  const table = el('div', { class: 'adm-scroll' },
    el('table', { class: 'adm-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Пользователь' }),
        el('th', { text: 'Зарегистрирован' }),
        el('th', { text: 'Был в сети' }),
        el('th', { text: 'ИИ сегодня' }),
        el('th', { text: 'Тариф ИИ' }),
        el('th', { text: '' }))),
      tbody));

  return [card('Пользователи', el('span', { class: 'pill', text: fmtInt(users.length) }), err, table)];
}

/* ── Приглашения ────────────────────────────────────────────── */

/** Текст для «Скопировать с инструкцией»: приветствие, два слова о NewDay,
 *  просьба зарегистрироваться и сама ссылка. */
function inviteMessage(url) {
  return [
    'Здравствуйте!',
    '',
    'Приглашаю вас в NewDay — это личный планировщик: расписание дня, задачи и привычки в одном месте.',
    '',
    'Зарегистрируйтесь по этой ссылке:',
    url,
  ].join('\n');
}

async function renderInvites() {
  const invites = await api('GET', '/api/admin/invites');
  const list = Array.isArray(invites) ? invites.slice() : [];

  const createErr = errBox();
  const listErr = errBox();
  const listBox = el('div');

  const inviteUrl = inv =>
    inv.url || `${location.origin}/register.html?invite=${encodeURIComponent(inv.code ?? '')}`;

  function inviteNode(inv) {
    // сервер отвечает короткими именами (uses/used/revoked) — принимаем оба
    const limit = inv.usesLimit ?? inv.uses;
    const used = inv.usedCount ?? inv.used ?? 0;
    const revoked = Boolean(inv.revokedAt ?? inv.revoked);
    const spent = Number.isFinite(Number(limit)) && Number(limit) > 0
      && Number(used) >= Number(limit);

    const status = revoked
      ? el('span', { class: 'pill bad', text: 'отозвано' })
      : spent
        ? el('span', { class: 'pill', text: 'использовано полностью' })
        : el('span', { class: 'pill ok', text: 'действует' });

    const node = el('div', { class: 'adm-invite' + (revoked ? ' off' : '') },
      el('div', { class: 'adm-invite-hd' },
        el('span', { class: 'adm-invite-code', text: inv.code || '—' }),
        status,
        el('span', { class: 'pill', text: 'ИИ: ' + tierLabel(inv.aiTier) }),
        el('span', { class: 'small', text: `использовано ${fmtInt(used)} из ${fmtInt(limit)}` }),
        el('span', { class: 'small muted', text: 'создано ' + fmtDate(inv.createdAt) })),
      el('div', { class: 'adm-invite-url', text: inviteUrl(inv) }));

    if (!revoked) {
      const copyLink = el('button', { class: 'btn btn-sm', type: 'button', text: 'Скопировать ссылку' });
      copyLink.addEventListener('click', async () => {
        const ok = await copyText(inviteUrl(inv));
        if (ok) toast('Ссылка скопирована');
        else showErr(listErr, 'Не получилось скопировать — выделите адрес и скопируйте вручную.');
      });

      const copyFull = el('button', { class: 'btn btn-sm', type: 'button', text: 'Скопировать с инструкцией' });
      copyFull.addEventListener('click', async () => {
        const ok = await copyText(inviteMessage(inviteUrl(inv)));
        if (ok) toast('Приглашение с инструкцией скопировано');
        else showErr(listErr, 'Не получилось скопировать — выделите адрес и скопируйте вручную.');
      });

      const revoke = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Отозвать' });
      revoke.addEventListener('click', async () => {
        hideErr(listErr);
        revoke.disabled = true;
        try {
          await api('DELETE', `/api/admin/invites/${encodeURIComponent(inv.id)}`);
          inv.revokedAt = new Date().toISOString();
          node.replaceWith(inviteNode(inv));
          toast('Приглашение отозвано');
        } catch (ex) {
          showErr(listErr, 'Не получилось отозвать приглашение: ' + ex.message);
          revoke.disabled = false;
        }
      });

      node.append(el('div', { class: 'adm-invite-btns' }, copyLink, copyFull, revoke));
    }
    return node;
  }

  function paintList() {
    listBox.replaceChildren();
    if (!list.length) {
      listBox.append(el('p', { class: 'empty', text: 'Приглашений пока нет. Создайте первое — и пришлите ссылку тому, кого ждёте.' }));
      return;
    }
    for (const inv of list) listBox.append(inviteNode(inv));
  }
  paintList();

  // Форма создания: на сколько человек и с каким тарифом помощника
  const uses = el('input', { type: 'number', min: '1', max: '1000', step: '1', value: '1', inputmode: 'numeric' });
  const tier = tierSelect('limited');
  const createBtn = el('button', { class: 'btn btn-primary', type: 'submit' },
    icon('plus', { size: '16px' }), el('span', { text: 'Создать приглашение' }));

  const form = el('form', { class: 'adm-form-row' },
    group('На сколько человек', uses, 'w-s'),
    group('Тариф ИИ', tier),
    createBtn);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (createBtn.disabled) return;
    hideErr(createErr);
    const n = Math.floor(Number(uses.value));
    if (!Number.isFinite(n) || n < 1) {
      showErr(createErr, 'Укажите, на сколько регистраций рассчитано приглашение, — хотя бы на одну.');
      return;
    }
    createBtn.disabled = true;
    try {
      const inv = await api('POST', '/api/admin/invites', { uses: n, aiTier: tier.value });
      if (inv && typeof inv === 'object') list.unshift(inv);
      paintList();
      toast('Приглашение создано');
    } catch (ex) {
      showErr(createErr, 'Не получилось создать приглашение: ' + ex.message);
    }
    createBtn.disabled = false;
  });

  return [
    card('Новое приглашение', null,
      el('p', { class: 'adm-lead', text:
        'Приглашение — это ссылка, по которой можно зарегистрироваться, даже когда регистрация закрыта. ' +
        'Тариф ИИ достанется каждому, кто зарегистрируется по ней.' }),
      form, createErr),
    card('Приглашения', list.length ? el('span', { class: 'pill', text: fmtInt(list.length) }) : null,
      listErr, listBox),
  ];
}

/* ── Помощник ───────────────────────────────────────────────── */

const PROXY_TYPES = ['http', 'https', 'socks5', 'socks4'];

async function renderAi() {
  // Настройки нужны только ради выключателя: если они не пришли,
  // остальной раздел всё равно полезен
  const [ai, settings] = await Promise.all([
    api('GET', '/api/admin/ai'),
    api('GET', '/api/admin/settings').catch(() => null),
  ]);

  const out = [];

  // Выключатель помощника
  const swErr = errBox();
  const sw = makeSwitch(settings?.aiEnabled, async next => {
    hideErr(swErr);
    try {
      const r = await api('PATCH', '/api/admin/settings', { aiEnabled: next });
      toast(next ? 'Помощник включён' : 'Помощник выключен');
      return r?.aiEnabled ?? next;
    } catch (ex) {
      showErr(swErr, 'Не получилось переключить: ' + ex.message);
      throw ex;
    }
  }, 'Помощник включён');
  if (!settings) sw.disabled = true;

  out.push(card('Помощник', null,
    setRow('Помощник включён',
      settings
        ? 'Когда выключен, кнопка помощника скрыта у всех, а запросы к ИИ не уходят.'
        : 'Не удалось узнать текущее состояние — обновите страницу или загляните позже.',
      sw),
    swErr));

  // Состояние подключения и форма адрес/модель/ключ
  const stStack = el('div', { class: 'stack' });
  stStack.append(ai?.ready
    ? el('div', { class: 'adm-ai-status ok' }, icon('check-circle-fill', { size: '18px' }),
        el('span', { text: 'Подключение настроено, сервер ИИ на связи.' }))
    : el('div', { class: 'adm-ai-status warn' }, icon('warning-circle-fill', { size: '18px' }),
        el('span', { text: 'Подключение пока не готово: проверьте адрес, ключ и модель ниже.' })));
  if (ai?.lastError) {
    stStack.append(el('p', { class: 'small danger', text: 'Последняя ошибка: ' + ai.lastError }));
  }

  const formErr = errBox();
  const baseUrl = el('input', { type: 'url', value: ai?.baseUrl ?? '', placeholder: 'https://api.example.com/v1', autocomplete: 'off' });
  const model = el('input', { type: 'text', value: ai?.model ?? '', placeholder: 'название модели', autocomplete: 'off' });
  let keySet = Boolean(ai?.keySet);
  const key = el('input', {
    type: 'password', autocomplete: 'new-password',
    placeholder: keySet ? 'Ключ задан. Введите новый, чтобы заменить' : 'Ключ не задан',
  });

  const saveBtn = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Сохранить' });
  const aiForm = el('form', { class: 'stack' },
    group('Адрес сервера ИИ', baseUrl),
    group('Модель', model),
    group('Ключ API', key),
    formErr,
    el('div', { class: 'adm-actions' }, saveBtn));

  aiForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (saveBtn.disabled) return;
    hideErr(formErr);
    saveBtn.disabled = true;
    try {
      const body = { baseUrl: baseUrl.value.trim(), model: model.value.trim() };
      // сервер ждёт поле apiKey; пустую строку он читает как «не менять»
      if (key.value) body.apiKey = key.value;
      /*
       * Заполненное подключение включается само. Без этого адрес, ключ и
       * модель сохранялись, а «подключение не готово» продолжало гореть —
       * из-за внутреннего флага, о котором человек знать не обязан.
       */
      if (body.baseUrl && body.model && (key.value || keySet)) body.enabled = true;
      await api('PATCH', '/api/admin/ai', body);
      if (key.value) { keySet = true; key.value = ''; key.placeholder = 'Ключ задан. Введите новый, чтобы заменить'; }
      toast('Настройки помощника сохранены');
    } catch (ex) {
      showErr(formErr, 'Не получилось сохранить: ' + ex.message);
    }
    saveBtn.disabled = false;
  });

  // Проверка связи: задержка числом или ошибка словами
  const checkOut = el('span', { class: 'adm-check-out', 'aria-live': 'polite' });
  const checkBtn = el('button', { class: 'btn', type: 'button' },
    icon('arrows-clockwise', { size: '16px' }), el('span', { text: 'Проверить связь' }));
  checkBtn.addEventListener('click', async () => {
    if (checkBtn.disabled) return;
    checkBtn.disabled = true;
    checkOut.className = 'adm-check-out';
    checkOut.textContent = 'Проверяю…';
    try {
      const r = await api('POST', '/api/admin/ai/check');
      if (r?.ok) {
        checkOut.className = 'adm-check-out ok';
        checkOut.textContent = `Сервер ИИ отвечает, задержка ${fmtInt(r.latencyMs)} мс.`;
      } else {
        checkOut.className = 'adm-check-out bad';
        checkOut.textContent = 'Связи нет: ' + (r?.error || 'сервер ИИ не ответил.');
      }
    } catch (ex) {
      checkOut.className = 'adm-check-out bad';
      checkOut.textContent = 'Проверка не удалась: ' + ex.message;
    }
    checkBtn.disabled = false;
  });

  out.push(card('Подключение для текста', null,
    stStack, aiForm,
    el('div', { class: 'adm-check-line' }, checkBtn, checkOut)));

  /*
   * Распознавание речи — своё подключение.
   *
   * Текст и голос часто живут у разных провайдеров: один держит удобную
   * текстовую модель, другой — whisper. Пустые адрес и ключ означают «то же,
   * что у текста»: тем, у кого провайдер один, второй раз заполнять нечего.
   */
  const vErr = errBox();
  const vBase = el('input', {
    type: 'url', value: ai?.voiceOwn ? (ai?.voiceBaseUrl ?? '') : '',
    placeholder: 'как у текста: ' + (ai?.baseUrl || 'адрес не задан'), autocomplete: 'off',
  });
  const vModel = el('input', { type: 'text', value: ai?.voiceModel ?? '', placeholder: 'whisper-1', autocomplete: 'off' });
  let vKeySet = Boolean(ai?.voiceOwn && ai?.voiceKeySet);
  const vKey = el('input', {
    type: 'password', autocomplete: 'new-password',
    placeholder: vKeySet ? 'Свой ключ задан. Введите новый, чтобы заменить' : 'как у текста',
  });

  const vSave = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Сохранить' });
  const vReset = el('button', { class: 'btn', type: 'button', text: 'Вернуть к текстовому' });
  const vForm = el('form', { class: 'stack' },
    el('p', { class: 'adm-lead', text: 'Пусто — распознавание пойдёт через то же подключение, что и текст.' }),
    group('Адрес сервера', vBase),
    group('Модель распознавания', vModel),
    group('Ключ API', vKey),
    vErr,
    el('div', { class: 'adm-actions' }, vSave, vReset));

  vForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (vSave.disabled) return;
    hideErr(vErr);
    vSave.disabled = true;
    try {
      const body = { voiceBaseUrl: vBase.value.trim(), voiceModel: vModel.value.trim() };
      if (vKey.value) body.voiceApiKey = vKey.value;
      await api('PATCH', '/api/admin/ai', body);
      if (vKey.value) {
        vKeySet = true;
        vKey.value = '';
        vKey.placeholder = 'Свой ключ задан. Введите новый, чтобы заменить';
      }
      toast('Распознавание речи сохранено');
    } catch (ex) {
      showErr(vErr, 'Не получилось сохранить: ' + ex.message);
    }
    vSave.disabled = false;
  });

  vReset.addEventListener('click', async () => {
    hideErr(vErr);
    vReset.disabled = true;
    try {
      // null стирает свои значения: дальше речь идёт тем же путём, что текст
      await api('PATCH', '/api/admin/ai', { voiceBaseUrl: '', voiceApiKey: null });
      vBase.value = '';
      vKey.value = '';
      vKeySet = false;
      vKey.placeholder = 'как у текста';
      toast('Распознавание вернулось к текстовому подключению');
    } catch (ex) {
      showErr(vErr, 'Не получилось вернуть: ' + ex.message);
    }
    vReset.disabled = false;
  });

  const vCheckOut = el('span', { class: 'adm-check-out', 'aria-live': 'polite' });
  const vCheckBtn = el('button', { class: 'btn', type: 'button' },
    icon('arrows-clockwise', { size: '16px' }), el('span', { text: 'Проверить связь' }));
  vCheckBtn.addEventListener('click', async () => {
    if (vCheckBtn.disabled) return;
    vCheckBtn.disabled = true;
    vCheckOut.className = 'adm-check-out';
    vCheckOut.textContent = 'Проверяю…';
    try {
      const r = await api('POST', '/api/admin/ai/check', { what: 'voice' });
      if (r?.ok) {
        vCheckOut.className = 'adm-check-out ok';
        vCheckOut.textContent = `Отвечает, задержка ${fmtInt(r.latencyMs)} мс.`;
      } else {
        vCheckOut.className = 'adm-check-out bad';
        vCheckOut.textContent = 'Связи нет: ' + (r?.error || 'сервер не ответил.');
      }
    } catch (ex) {
      vCheckOut.className = 'adm-check-out bad';
      vCheckOut.textContent = 'Проверка не удалась: ' + ex.message;
    }
    vCheckBtn.disabled = false;
  });

  const vStatus = ai?.voiceReady
    ? el('div', { class: 'adm-ai-status ok' }, icon('check-circle-fill', { size: '18px' }),
        el('span', { text: ai?.voiceOwn ? 'Своё подключение настроено.' : 'Работает через текстовое подключение.' }))
    : el('div', { class: 'adm-ai-status warn' }, icon('warning-circle-fill', { size: '18px' }),
        el('span', { text: 'Распознавание не настроено: без модели голосовой ввод не заработает.' }));

  out.push(card('Распознавание речи', null,
    vStatus, vForm,
    el('div', { class: 'adm-check-line' }, vCheckBtn, vCheckOut)));

  // Прокси: список и добавление
  const proxyErr = errBox();
  const proxyBox = el('div');
  const proxies = Array.isArray(ai?.proxies) ? ai.proxies.slice() : [];

  function proxyNode(p) {
    const del = el('button', { class: 'icon-btn', type: 'button', title: 'Удалить прокси', 'aria-label': 'Удалить прокси' },
      icon('trash', { size: '16px' }));
    const node = el('div', { class: 'adm-proxy' },
      el('span', { class: 'pill', text: p.type || 'http' }),
      el('span', { class: 'mono', text: `${p.host ?? '—'}:${p.port ?? '—'}` }),
      p.login ? el('span', { class: 'adm-proxy-login', text: 'логин: ' + p.login }) : null,
      del);
    del.addEventListener('click', async () => {
      hideErr(proxyErr);
      del.disabled = true;
      try {
        await api('DELETE', `/api/admin/ai/proxies/${encodeURIComponent(p.id)}`);
        const i = proxies.indexOf(p);
        if (i >= 0) proxies.splice(i, 1);
        paintProxies();
        toast('Прокси удалён');
      } catch (ex) {
        showErr(proxyErr, 'Не получилось удалить прокси: ' + ex.message);
        del.disabled = false;
      }
    });
    return node;
  }

  function paintProxies() {
    proxyBox.replaceChildren();
    if (!proxies.length) {
      proxyBox.append(el('p', { class: 'empty', text: 'Прокси не добавлены. Они нужны, только если сервер ИИ недоступен напрямую.' }));
      return;
    }
    for (const p of proxies) proxyBox.append(proxyNode(p));
  }
  paintProxies();

  const pType = el('select', {});
  for (const t of PROXY_TYPES) pType.append(el('option', { value: t, text: t }));
  const pHost = el('input', { type: 'text', placeholder: 'proxy.example.com', autocomplete: 'off' });
  const pPort = el('input', { type: 'number', min: '1', max: '65535', placeholder: '1080', inputmode: 'numeric' });
  const pLogin = el('input', { type: 'text', placeholder: 'необязательно', autocomplete: 'off' });
  const pPass = el('input', { type: 'password', placeholder: 'необязательно', autocomplete: 'new-password' });
  const addBtn = el('button', { class: 'btn', type: 'submit' },
    icon('plus', { size: '16px' }), el('span', { text: 'Добавить' }));

  const proxyForm = el('form', { class: 'adm-form-row' },
    group('Тип', pType, 'w-s'),
    group('Адрес', pHost),
    group('Порт', pPort, 'w-s'),
    group('Логин', pLogin),
    group('Пароль', pPass),
    addBtn);

  proxyForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (addBtn.disabled) return;
    hideErr(proxyErr);
    const port = Math.floor(Number(pPort.value));
    if (!pHost.value.trim() || !Number.isFinite(port) || port < 1) {
      showErr(proxyErr, 'Укажите адрес и порт прокси.');
      return;
    }
    addBtn.disabled = true;
    try {
      const body = { type: pType.value, host: pHost.value.trim(), port };
      if (pLogin.value.trim()) body.login = pLogin.value.trim();
      if (pPass.value) body.password = pPass.value;
      const created = await api('POST', '/api/admin/ai/proxies', body);
      proxies.push(created && typeof created === 'object' ? created : body);
      paintProxies();
      pHost.value = ''; pPort.value = ''; pLogin.value = ''; pPass.value = '';
      toast('Прокси добавлен');
    } catch (ex) {
      showErr(proxyErr, 'Не получилось добавить прокси: ' + ex.message);
    }
    addBtn.disabled = false;
  });

  out.push(card('Прокси', proxies.length ? el('span', { class: 'pill', text: fmtInt(proxies.length) }) : null,
    el('p', { class: 'adm-lead', text: 'Запросы к серверу ИИ пойдут через прокси из этого списка, если прямое подключение не работает.' }),
    proxyBox, proxyErr, proxyForm));

  return out;
}

/* ── Настройки ──────────────────────────────────────────────── */

async function renderSettings() {
  const settings = await api('GET', '/api/admin/settings');

  const regErr = errBox();
  const regSwitch = makeSwitch(settings?.registrationOpen, async next => {
    hideErr(regErr);
    try {
      const r = await api('PATCH', '/api/admin/settings', { registrationOpen: next });
      toast(next ? 'Регистрация открыта' : 'Регистрация закрыта');
      return r?.registrationOpen ?? next;
    } catch (ex) {
      showErr(regErr, 'Не получилось переключить: ' + ex.message);
      throw ex;
    }
  }, 'Регистрация открыта');

  /*
   * Тариф ИИ новым пользователям. Открытая регистрация не означает щедрый
   * ИИ: у кого-то ключ платный, и «всем безлимит» стоил бы денег каждому
   * незнакомцу. Приглашение перекрывает это значение своим тарифом.
   */
  const tierErr = errBox();
  const tierSel = tierSelect(settings?.defaultAiTier ?? 'unlimited');
  tierSel.addEventListener('change', async () => {
    hideErr(tierErr);
    tierSel.disabled = true;
    try {
      await api('PATCH', '/api/admin/settings', { defaultAiTier: tierSel.value });
      toast('Тариф для новых сохранён');
    } catch (ex) {
      showErr(tierErr, 'Не получилось сохранить: ' + ex.message);
    }
    tierSel.disabled = false;
  });

  const regCard = card('Регистрация', null,
    setRow('Регистрация открыта',
      'Когда закрыта, новые люди попадают в NewDay только по приглашению.',
      regSwitch),
    regErr,
    setRow('Тариф ИИ новым пользователям',
      'Достаётся каждому, кто регистрируется сам. Приглашение выдаёт свой тариф и перекрывает этот.',
      tierSel),
    tierErr);

  // Смена пароля администратора
  const passErr = errBox();
  const cur = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Действующий пароль' });
  const next = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Новый пароль' });
  const again = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Новый пароль ещё раз' });
  const passBtn = el('button', { class: 'btn btn-primary', type: 'submit' },
    icon('key', { size: '16px' }), el('span', { text: 'Сменить пароль' }));

  const passForm = el('form', { class: 'stack' },
    group('Текущий пароль', cur),
    group('Новый пароль', next),
    group('Повторите новый', again),
    passErr,
    el('div', { class: 'adm-actions' }, passBtn));

  passForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (passBtn.disabled) return;
    hideErr(passErr);
    if (!cur.value || !next.value) { showErr(passErr, 'Заполните текущий и новый пароль.'); return; }
    if (next.value !== again.value) { showErr(passErr, 'Новые пароли не совпадают.'); return; }
    passBtn.disabled = true;
    try {
      await api('POST', '/api/admin/password', { current: cur.value, next: next.value });
      cur.value = ''; next.value = ''; again.value = '';
      toast('Пароль администратора изменён');
    } catch (ex) {
      if (ex.status === 401) showErr(passErr, 'Текущий пароль не подошёл.');
      else showErr(passErr, 'Не получилось сменить пароль: ' + ex.message);
    }
    passBtn.disabled = false;
  });

  const passCard = card('Пароль администратора', null,
    el('p', { class: 'adm-lead', text: 'Этим паролем открывается вся админка — не делитесь им и не ставьте короткий.' }),
    passForm);

  /*
   * Ключ для наблюдалки (Uptime Kuma и подобных).
   *
   * «Жив или нет» открыто всем: наблюдалке нужен код ответа, и требовать
   * ключ ради того, что видно по доступности сайта, незачем. А подробности —
   * версия схемы, длина очереди, причины поломки — рассказывают о
   * внутренностях, и их закрывает ключ. Показывается он один раз: сервер
   * хранит только хеш.
   */
  const hErr = errBox();
  const hBox = el('div', { class: 'stack' });
  let health = null;
  try { health = await api('GET', '/api/admin/health-token'); }
  catch { /* сервер старой версии — покажем, что раздел недоступен */ }

  function drawHealth(fresh) {
    hBox.replaceChildren();
    if (!health) {
      hBox.append(el('p', { class: 'adm-lead', text: 'Раздел недоступен: сервер ещё не обновлён.' }));
      return;
    }
    const issued = Boolean(health.issued);
    hBox.append(el('p', { class: 'adm-lead', text: issued
      ? 'Подробности здоровья закрыты ключом. Проверка «жив или нет» по-прежнему открыта всем.'
      : 'Ключ не выпущен: подробности здоровья видны всем, у кого есть адрес. Для публичного сервера выпустите ключ.' }));

    hBox.append(el('div', { class: 'adm-kv-row' },
      el('span', { text: 'Адрес для наблюдалки' }),
      el('b', { class: 'mono', text: health.url || '/api/health' })));

    if (fresh?.token) {
      // Ключ показывается ровно один раз — говорим об этом прямо
      hBox.append(
        el('p', { class: 'small', text: 'Скопируйте сейчас: второй раз его не покажет даже сервер.' }),
        el('div', { class: 'adm-token' }, el('code', { text: fresh.token })),
        el('div', { class: 'adm-actions' },
          (() => {
            const b = el('button', { class: 'btn btn-sm', type: 'button', text: 'Скопировать ключ' });
            b.addEventListener('click', async () => {
              toast(await copyText(fresh.token) ? 'Ключ скопирован' : 'Не получилось скопировать');
            });
            return b;
          })(),
          (() => {
            const b = el('button', { class: 'btn btn-sm', type: 'button', text: 'Скопировать заголовок' });
            b.addEventListener('click', async () => {
              toast(await copyText(fresh.header) ? 'Заголовок скопирован' : 'Не получилось скопировать');
            });
            return b;
          })()));
    }

    const issue = el('button', { class: 'btn btn-primary', type: 'button' },
      icon('key', { size: '16px' }),
      el('span', { text: issued ? 'Выпустить новый ключ' : 'Выпустить ключ' }));
    issue.addEventListener('click', async () => {
      hideErr(hErr);
      issue.disabled = true;
      try {
        const r = await api('POST', '/api/admin/health-token');
        health = { issued: true, open: false, url: r.url };
        drawHealth(r);
        toast(issued ? 'Ключ заменён — старый больше не работает' : 'Ключ выпущен');
      } catch (ex) {
        showErr(hErr, 'Не получилось выпустить: ' + ex.message);
        issue.disabled = false;
      }
    });

    const actions = el('div', { class: 'adm-actions' }, issue);
    if (issued) {
      const drop = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Отозвать' });
      drop.addEventListener('click', async () => {
        hideErr(hErr);
        drop.disabled = true;
        try {
          await api('DELETE', '/api/admin/health-token');
          health = { ...health, issued: false };
          drawHealth(null);
          toast('Ключ отозван — подробности снова открыты');
        } catch (ex) {
          showErr(hErr, 'Не получилось отозвать: ' + ex.message);
          drop.disabled = false;
        }
      });
      actions.append(drop);
    }
    hBox.append(actions, hErr);
  }
  drawHealth(null);

  const healthCard = card('Наблюдение за сервером', null, hBox);

  return [regCard, healthCard, passCard];
}

/* ── Старт ──────────────────────────────────────────────────────
   Сначала показываем вход — он работает даже без сервера. Затем тихо
   проверяем, жива ли сессия: если да, вход не нужен. */

renderGate();
(async () => {
  try {
    await api('GET', '/api/admin/settings');
    renderShell();
  } catch { /* сессии нет или сервер молчит — остаёмся на входе */ }
})();
