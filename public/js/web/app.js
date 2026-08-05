/**
 * Веб-версия NewDay по эталону «NewDay Web».
 *
 * Разделы, три колонки «Сейчас», сетка недели с созданием блока
 * протягиванием, месяц, привычки, заметки, настройки и двенадцать шторок.
 * Данные настоящие: читаются и пишутся через API.
 *
 * Перевод ответов сервера в то, чем рисует разметка, живёт в `adapt.js`,
 * чтение и запись — в `store.js`. Здесь только вид и поведение.
 *
 * Отрисовка простая: одно состояние, одна функция `render`. Ни виртуального
 * дерева, ни подписок — экранов пять, и перерисовать разметку целиком
 * быстрее, чем следить за тем, что именно изменилось.
 */

import { h, add, replace, svg, $ } from '../dom.js';
import { icon } from '../vendor/icons.js';
import {
  DARK, LIGHT, PALETTE, ALARM, LEADS, CATS, NAV, MONTHS, DOW_LONG, DOW_SHORT,
  SOUNDS, REPEATS, PRINT_PARTS, HABIT_EMOJI,
} from './data.js';
import * as adapt from './adapt.js';
import * as data from './store.js';
import { store } from './store.js';
import * as api from '../api.js';
import { printSheet } from './sheet.js';

/** Часовая сетка: 18 часов с 06:00, строка часа — 44 px. */
const HOUR_H = 44;
const FROM_MIN = 6 * 60;
const HOURS = 18;
const PX_PER_MIN = HOUR_H / 60;
/** Шаг протягивания: четверть часа — то, чем люди мыслят расписание. */
const SNAP = 15;

const state = {
  theme: 'dark', color: 'violet', screen: 'today', scale: 1,
  date: '', view: 'week',
  catFilter: 'all', noteFilter: 'all',
  modal: null, busy: false, notice: null,
  rowId: null, rowStart: null, rowEnd: null, rowField: 'start', rowTitle: '', rowAlarm: 'off', rowLead: 'at',
  taskId: null, taskTitle: '', taskCat: 'work',
  mealId: null, mealTitle: '', mealKcal: '', mealMode: 'none', mealDur: 30, mealSched: false,
  sportId: null, sportTitle: '', sportSets: '', sportReps: '', sportWeight: '',
  noteId: null, noteText: '', noteDated: true,
  remId: null, remRepeat: 'Разово', remTitle: '', remDate: '', remTime: '10:00', remLead: 'at',
  fileKind: 'export', sound: 'Рассвет', notifySound: 'Капля', soundKind: 'Звук будильника',
  tplRows: null, tplEdit: null, tplStart: 420, tplEnd: 480, tplField: 'start',
  tplTitle: '', tplAlarm: 'off', tplLead: 'at',
  quietFrom: '23:00', quietTo: '07:00',
  habitKind: 'do', habitEmoji: '💧', habitGoal: 30, habitGoalCustom: false,
  habitTitle: '', habitTimes: 5,
  habitDays: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: false, 6: false },
  aiStep: 'input', aiText: '', aiOff: {},
  printScope: 0, printOff: {},
  statsDays: 30,
  passOld: '', passNew: '', passNew2: '',
  pairCode: null,
  tokenName: '', tokenScope: 'read', tokenSecret: null,
  aiDraft: null,
};

/*
 * Списки для разметки. Заполняются из ответа сервера при каждой загрузке
 * дня — разметка обращается к ним так же, как раньше к примерам, поэтому
 * подключение не потребовало переписывать экраны.
 */
let SCHEDULE = [];
let TASKS = [];
let MEALS = [];
let HABITS = [];
let NOTES = [];
let REMINDERS = [];

/** Сегодня по часовому поясу человека, а не браузера. */
const todayKey = () => store.settings?.today ?? data.todayFor();

// ── Мелкие помощники ─────────────────────────────────────────

const set = patch => {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  render();
};

/*
 * Крючок для снимков экрана и живых проверок: шторку открывают по имени.
 * Иначе половину макета нечем показать — шторки не страницы, по адресу их
 * не откроешь. Те, что читают данные, открываются своим путём: пустая
 * шторка на снимке ничего не рассказывает.
 */
window.__wopen = name => {
  if (name === 'notify' || name === 'template') return openLink(name);
  if (name === 'file') return openLink('export');
  if (name === 'tplRow') return openTplRow('new');
  if (name === 'reminder') return openReminder(null);
  return set({ modal: name });
};

/**
 * «Система» — это правда система, а не «тёмная по умолчанию»: спрашиваем
 * браузер. Иначе человек, выбравший «Система» на светлом компьютере,
 * получал бы тёмный экран и считал настройку сломанной.
 */
const dark = () => (state.theme === 'system'
  ? !matchMedia('(prefers-color-scheme: light)').matches
  : state.theme !== 'light');
const accent = () => PALETTE[state.color][dark() ? 'dark' : 'light'];
const soft = () => `color-mix(in srgb, ${accent()} 18%, transparent)`;

const pad2 = n => String(n).padStart(2, '0');
const hhmm = min => { const m = ((min % 1440) + 1440) % 1440; return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; };
const dayOf = () => { const [y, m, d] = state.date.split('-').map(Number); return new Date(y, m - 1, d); };
const keyOf = dt => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
const shiftDay = n => go(data.addDays(state.date, n));

/** Перейти на дату: меняем и сразу перечитываем — день другой. */
function go(date) {
  state.date = date;
  render();
  reload();
}
const mondayOf = dt => { const m = new Date(dt); m.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); return m; };

const isDone = r => Boolean(r.done);
const alarmOf = r => r.alarm ?? 'off';
const leadsOf = r => (r.leads?.length ? r.leads : ['at']);
const hasLead = (r, k) => leadsOf(r).includes(k);
const leadsLabel = r => leadsOf(r).map(k => LEADS.find(l => l.k === k)?.label ?? k).join(', ');

/**
 * Отметка. Уходит на сервер сразу, на экране применяется не дожидаясь
 * ответа: галочка, которая ставится через полсекунды, ощущается сломанной.
 */
function toggle(r, kind) {
  const next = !isDone(r);
  const send = kind === 'task' ? data.toggleTask
    : kind === 'meal' ? data.toggleMeal
      : kind === 'habit' ? data.toggleHabit
        : kind === 'sport' ? data.toggleSport
          : data.toggleScheduleRow;
  r.done = next;
  if (kind === 'habit') r.status = next ? 'done' : null;
  render();
  send(r.raw ?? r, next).then(() => reload()).catch(e => {
    r.done = !next;
    fail(e);
  });
}

const bellOf = mode => ALARM.find(a => a.k === mode) ?? ALARM[0];

/** Есть ли в дне дела — по выборке за период, если она загружена. */
const hasPlans = date => {
  if (date === state.date) return SCHEDULE.length > 0;
  return (store.range?.days ?? []).some(d => d.date === date && d.counts.schedule > 0);
};

/** Короткое сообщение поверх экрана. Через четыре секунды убирается само. */
function note(text) {
  state.notice = text;
  render();
  setTimeout(() => { if (state.notice === text) { state.notice = null; render(); } }, 4000);
}

/** Сообщение об отказе. Молчаливая неудача — худшее, что может быть. */
const fail = e => note(e?.message || 'Не удалось сохранить');

/**
 * Действие в шторке: кнопка занята, пока запрос в пути, исход виден.
 * Шторка при этом остаётся открытой — в отличие от `busy`, которая её
 * закрывает: «проверить уведомление» не повод уходить с экрана.
 */
function act(job, okText) {
  state.busy = true;
  state.notice = null;
  render();
  return Promise.resolve(job)
    .then(() => { state.busy = false; if (okText) note(okText); else render(); })
    .catch(e => { state.busy = false; fail(e); });
}

/**
 * Перечитать то, что нужно текущему экрану. Не всё сразу: на «Заметках»
 * незачем считать прогресс дня, а на «Расписании» — тянуть привычки.
 */
async function reload() {
  const needsDay = state.screen === 'today';
  const needsRange = state.screen === 'plan';
  try {
    const jobs = [];
    if (needsDay || state.modal) jobs.push(data.loadDay(state.date));
    if (needsRange) jobs.push(data.loadRange(state.date, state.view));
    if (state.screen === 'habits') jobs.push(data.loadDay(state.date));
    // Заметки нужны и на «Сейчас»: правая колонка показывает заметки дня
    if (state.screen === 'notes' || needsDay) jobs.push(data.loadNotes());
    // На настройках нужны шаблон (для его шторки) и список устройств
    if (state.screen === 'settings') {
      jobs.push(data.loadTemplate().catch(() => null), data.loadAccount().catch(() => null));
    }
    await Promise.all(jobs);
    fill();
    render();
  } catch (e) {
    fail(e);
  }
}

/** Разложить ответы сервера по спискам, которыми рисует разметка. */
function fill() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  SCHEDULE = adapt.schedule(store.day, { minutes, todayKey: todayKey() });
  TASKS = adapt.tasks(store.day);
  MEALS = adapt.meals(store.day);
  HABITS = adapt.habits(store.day);
  REMINDERS = adapt.reminders(SCHEDULE);
  NOTES = adapt.notes(store.notes, todayKey(), state.date);
}
const ico = (name, size = '17px', cls = '') => icon(name, { size, cls });

/** Кнопка-иконка без рамки: используется в шапках и строках. */
const iconBtn = (name, { title, onclick, cls = '', size = '15px' } = {}) => {
  const b = h(`button.${cls || 'wsq'}`, { type: 'button', title, 'aria-label': title, onclick });
  add(b, ico(name, size));
  return b;
};

const box = (on, extra = '') => {
  const b = h(`span.wbox${on ? '.on' : ''}${extra ? '.' + extra : ''}`);
  add(b, ico(extra === 'off' ? 'moon' : 'check-bold', '13px'));
  return b;
};

const sw = (on, onclick) => h('button.wsw', { type: 'button', class: on ? 'on' : '', role: 'switch', 'aria-checked': on ? 'true' : 'false', onclick }, h('i'));

const chip = (label, on, onclick, cls = '') =>
  h(`button.wchip${cls ? '.' + cls.split(' ').join('.') : ''}`, { type: 'button', text: label, class: on ? 'on' : '', onclick });

const sheetChip = (label, on, onclick, extra = '') => chip(label, on, onclick, `wchip-sheet ${extra}`.trim());

const opt = (label, iconName, on, onclick, small = false) => {
  const b = h(`button.wopt${small ? '.wopt-sm' : ''}`, { type: 'button', class: on ? 'on' : '', onclick });
  add(b, iconName ? ico(iconName, '17px') : null, h('span', { text: label }));
  return b;
};

const cap = text => h('span.wcap', { text });
const sectHd = (label, right = null, mark = null) =>
  h('div.wsect-hd',
    mark ? h('span.wdot6', { style: { background: mark } }) : null,
    cap(label), h('span.wrule'), right);

// ── Боковая колонка ──────────────────────────────────────────

/** Имя: как назвал себя человек, иначе начало почты. */
const userName = () =>
  store.settings?.displayName || String(store.user?.email ?? '').split('@')[0] || 'Профиль';

/** Счётчик у раздела: показываем только то, что посчитано по-настоящему. */
function badgeFor(key) {
  if (key === 'habits') {
    const act = HABITS.filter(x => x.active);
    return act.length ? `${act.filter(isDone).length}/${act.length}` : '';
  }
  if (key === 'notes') return store.notes.length ? String(store.notes.length) : '';
  return '';
}

function sideBar() {
  const nav = h('nav.wnav', { 'aria-label': 'Разделы' });
  add(nav, ...NAV.map(n => {
    const on = state.screen === n.key;
    const b = h('button.wnav-item', {
      type: 'button', class: on ? 'on' : '',
      onclick: () => { state.screen = n.key; state.modal = null; render(); reload(); },
    });
    const badge = badgeFor(n.key);
    add(b, ico(on ? `${n.icon}-fill` : n.icon, '19px'), h('span', { text: n.label }),
      badge ? h('span.wnav-badge', { text: badge }) : null);
    return b;
  }));

  // Переключатель темы тоже сохраняется: тема, забытая при перезагрузке,
  // выглядит так, будто выбор не сработал
  const themeBtn = h('button.wbtn-line', {
    type: 'button',
    onclick: () => {
      const next = dark() ? 'light' : 'dark';
      set({ theme: next });
      api.saveSettings({ theme: next }).catch(fail);
    },
  });
  add(themeBtn, ico(dark() ? 'moon' : 'sun', '16px'), h('span', { text: dark() ? 'Тёмная тема' : 'Светлая тема' }));

  const ai = h('button.wbtn-ai', { type: 'button', onclick: () => set({ modal: 'ai', aiStep: 'input' }) });
  add(ai, ico('sparkle-fill', '17px'), h('span', { text: 'Помощник' }));

  return h('aside.wside',
    h('div.wbrand', h('span.wbrand-mark', ico('sun-horizon', '16px')), h('b', { text: 'NewDay' })),
    nav,
    h('div.wside-foot',
      ai,
      themeBtn,
      h('div.wuser',
        h('span.wuser-ava', ico('user', '15px')),
        h('div.wuser-body',
          h('div.wuser-name', { text: userName() }),
          h('div.wuser-note', { text: 'синхронизировано' })))));
}

// ── Верхняя полоса ───────────────────────────────────────────

function topBar() {
  const cur = dayOf();
  const mon = mondayOf(cur);

  const days = h('div.wdays');
  add(days, ...Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(mon); dt.setDate(mon.getDate() + i);
    const on = keyOf(dt) === state.date;
    const b = h('button.wday', {
      type: 'button',
      // Точка — признак «в этом дне что-то запланировано», а не «будний день»
      class: [on ? 'on' : '', hasPlans(keyOf(dt)) ? 'has' : ''].filter(Boolean).join(' '),
      onclick: () => go(keyOf(dt)),
    });
    add(b,
      h('span.wday-dow', { text: DOW_SHORT[i] }),
      h('span.wday-num', { text: pad2(dt.getDate()) }),
      h('span.wday-dot'));
    return b;
  }));

  return h('div.wtop',
    h('div.wtop-date',
      h('div.wtop-dow', { text: DOW_LONG[cur.getDay()] }),
      h('div.wtop-num', { text: `${cur.getDate()} ${MONTHS[cur.getMonth()]}` })),
    h('div.wtop-nav',
      iconBtn('caret-left', { title: 'Предыдущий день', onclick: () => shiftDay(-1) }),
      iconBtn('caret-right', { title: 'Следующий день', onclick: () => shiftDay(1) }),
      chip('Сегодня', state.date === todayKey(), () => go(todayKey()))),
    days,
    (() => {
      const b = h('button.wbtn-ghost', { type: 'button', onclick: () => set({ modal: 'print' }) });
      add(b, ico('printer', '16px'), h('span', { text: 'Печать' }));
      return b;
    })());
}

// ── Экран «Сейчас» ───────────────────────────────────────────

/** Вложенность: строка, начавшаяся до конца предыдущей, лежит внутри неё. */
function nesting() {
  const inner = {}, parent = {};
  let base = null;
  for (const r of SCHEDULE) {
    if (base && base.end !== null && r.start < base.end) { inner[r.id] = true; parent[base.id] = true; }
    else base = r;
  }
  return { inner, parent };
}

function scheduleList() {
  const { inner, parent } = nesting();
  const wrap = h('div.wsched');
  add(wrap, ...SCHEDULE.map(r => {
    const mode = alarmOf(r);
    const sub = [];
    if (inner[r.id]) sub.push('внутри блока');
    if (r.fromFood) sub.push('из питания');
    if (mode !== 'off' && !hasLead(r, 'at')) sub.push(leadsLabel(r));

    const row = h('button.wsched-row', {
      type: 'button',
      class: [r.past ? 'past' : '', r.now ? 'now' : '', inner[r.id] ? 'inner' : '', parent[r.id] ? 'parent' : ''].filter(Boolean).join(' '),
      onclick: () => openRow(r.id),
    });
    add(row,
      h('span.wsched-time', { text: r.end === null ? hhmm(r.start) : `${hhmm(r.start)}–${hhmm(r.end)}` }),
      h('span.wsched-mark', h('span.wsched-dot')),
      h('div.wsched-body',
        h('div.wsched-title', { text: r.title }),
        sub.length ? h('div.wsched-sub', { text: sub.join(' · ') }) : null),
      mode === 'off' ? null : ico(bellOf(mode).icon, '16px', 'wbell'));
    return row;
  }));
  return wrap;
}

function progress() {
  const scored = [...TASKS, ...MEALS, ...HABITS.filter(x => x.active)];
  const done = scored.filter(isDone).length;
  return { done, total: scored.length, percent: Math.round((done / scored.length) * 100) };
}

function nowCard() {
  const { percent } = progress();
  const C = 2 * Math.PI * 34;
  return h('div.wnow',
    h('div.wnow-in',
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div.wnow-live', h('i'), h('span', { text: 'сейчас · 09:00 – 12:30' })),
        h('div.wnow-title', { text: 'Работа: первый блок' }),
        h('div.wnow-left', h('b', { text: '1 ч 12 мин' }), h('span', { text: 'до конца блока' })),
        h('div.wbar', h('i', { style: { width: '66%' } }))),
      (() => {
        const box = h('div.wring');
        box.innerHTML = `<svg viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" fill="none" stroke="${dark() ? 'rgba(233,233,237,0.10)' : 'rgba(41,43,49,0.12)'}" stroke-width="6"></circle>
          <circle cx="40" cy="40" r="34" fill="none" stroke="${accent()}" stroke-width="6" stroke-linecap="round"
            stroke-dasharray="${(C * percent) / 100} ${C}"></circle>
        </svg>`;
        add(box, h('span', { text: `${percent}%` }));
        return box;
      })()));
}

function statCards() {
  const { done, total, percent } = progress();
  const act = HABITS.filter(x => x.active);
  const hd = act.filter(isDone).length;
  const cards = [
    { value: `${percent}%`, label: `дела сегодня · ${done} из ${total}`, p: percent },
    { value: `${hd}/${act.length}`, label: 'привычки сегодня', p: Math.round((hd / act.length) * 100) },
    { value: '71%', label: 'привычки за 7 дней · лучшая серия 12', p: 71 },
  ];
  const grid = h('div.wstats');
  add(grid, ...cards.map(c => h('div.wstat',
    h('div.wstat-val', { text: c.value }),
    h('div.wstat-lab', { text: c.label }),
    h('div.wbar', h('i', { style: { width: `${Math.max(3, c.p)}%` } })))));
  return grid;
}

function tasksBlock() {
  const shades = shadeSet();
  const filtered = TASKS.filter(t => state.catFilter === 'all' || t.cat === state.catFilter);

  const chips = h('div.wwrap', { style: { paddingBottom: '10px' } });
  add(chips, ...[{ k: 'all', label: 'Все' }, ...CATS].map(c =>
    chip(c.label, state.catFilter === c.k, () => set({ catFilter: c.k }))));

  const list = h('div.wlist');
  add(list, ...filtered.map(t => {
    const d = isDone(t);
    const row = h('button.wlist-row', {
      type: 'button',
      onclick: () => set({ modal: 'task', taskId: t.id, taskCat: t.cat, taskTitle: t.title }),
    });
    const mark = box(d);
    mark.onclick = e => { e.stopPropagation(); toggle(t, 'task'); };
    add(row, mark,
      h('span.wstrike', { text: t.title, class: d ? 'done' : '' }),
      t.meta ? h('span.wlist-meta', { text: t.meta }) : null,
      h('span.wtag', { text: CATS.find(c => c.k === t.cat)?.label ?? '' }));
    return row;
  }));
  const addBtn = h('button.wadd', {
    type: 'button',
    onclick: () => set({ modal: 'task', taskId: 'new', taskCat: 'work', taskTitle: '' }),
  });
  add(addBtn, ico('plus', '15px'), h('span', { text: 'Добавить задачу' }));
  add(list, addBtn);

  return h('div',
    sectHd('задачи', h('span.wcount', { text: `${TASKS.filter(isDone).length}/${TASKS.length}` }), shades[0]),
    chips, list);
}

function foodBlock() {
  const shades = shadeSet();
  const kcal = MEALS.filter(isDone).reduce((s, m) => s + (m.kcal || 0), 0);

  const inner = h('div', { style: { marginTop: '8px' } });
  add(inner, ...MEALS.map(m => {
    const d = isDone(m);
    const mode = alarmOf(m);
    const row = h('button.wmeal', {
      type: 'button',
      onclick: () => set({
        modal: 'meal', mealId: m.id, mealTitle: m.title,
        mealKcal: m.kcal === null || m.kcal === undefined ? '' : String(m.kcal),
        mealMode: 'none', mealLead: 'at',
      }),
    });
    const mark = box(d);
    mark.onclick = e => { e.stopPropagation(); toggle(m, 'meal'); };
    add(row, mark,
      h('div.wmeal-body',
        h('div.wstrike', { text: m.title, class: d ? 'done' : '' }),
        h('div.wmeal-meta', { text: m.meta })),
      m.kcal === null || m.kcal === undefined ? null : h('span.wmeal-kcal', { text: `${m.kcal} ккал` }),
      mode === 'off' ? null : ico(bellOf(mode).icon, '16px', 'wbell'));
    return row;
  }));
  const addBtn = h('button.wadd', {
    type: 'button', style: { padding: '8px 0 12px' },
    onclick: () => set({ modal: 'meal', mealId: 'new', mealTitle: '', mealKcal: '', mealMode: 'none', mealLead: 'at' }),
  });
  add(addBtn, ico('plus', '15px'), h('span', { text: 'Добавить приём пищи' }));
  add(inner, addBtn);

  return h('div',
    sectHd('питание', h('span.wcount', { text: `${kcal} из 2200 ккал` }), shades[1]),
    h('div.wfood',
      h('div.wfood-plan', { text: 'Курица, рис, овощи, творог, кофе без сахара' }),
      h('div.wbar', h('i', { style: { width: `${Math.min(100, (kcal / 2200) * 100)}%` } })),
      inner));
}

/** Четыре оттенка акцента для точек-маркеров разделов. */
function shadeSet() {
  const a = accent();
  const g = dark() ? '#161826' : '#f3f5fe';
  const mix = (p, o) => `color-mix(in srgb, ${a} ${p}%, ${o})`;
  return dark()
    ? [mix(65, '#ffffff'), a, mix(74, g), mix(52, g)]
    : [mix(72, '#000000'), a, mix(78, g), mix(56, g)];
}

function habitCard(hb, wide = false) {
  const d = hb.active && isDone(hb);
  const mark = hb.active ? box(d) : box(false, 'off');
  if (hb.active) mark.onclick = e => { e.stopPropagation(); toggle(hb, 'habit'); };

  const week = h('div.whabit-week');
  add(week, ...hb.week.map(k => h('i', { class: k })));

  if (wide) {
    return h('div.wcard', { class: hb.active ? '' : 'dim' },
      h('div.whabit-wide',
        mark,
        h('span.whabit-emoji', { text: hb.emoji }),
        h('div.whabit-body',
          h('div.whabit-title', { text: hb.title, class: d ? 'done' : '' }),
          h('div.whabit-meta', { text: hb.meta })),
        week,
        iconBtn('dots-three-vertical', { title: 'Ещё', cls: 'whabit-more', size: '16px' })));
  }

  return h('div.wcard', { class: hb.active ? '' : 'dim' },
    h('div.whabit-in',
      mark,
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div.whabit-name', h('span', { text: hb.emoji }), h('span.whabit-title', { text: hb.title, class: d ? 'done' : '' })),
        h('div.whabit-meta', { text: hb.meta }),
        week)));
}

/**
 * Заметки дня карточками: заголовок — первая строка, ниже остальное.
 * Заметка в этой модели одна на день, поэтому карточка одна; нажатие
 * открывает её редактор.
 */
function dayNotes() {
  const wrap = h('div.wdaynotes');
  const mine = NOTES.filter(n => n.on);

  if (!mine.length) {
    const empty = h('div.wdaynote', {
      onclick: () => set({ modal: 'note', noteId: state.date, noteText: '', noteDated: true }),
    });
    add(empty,
      h('div.wdaynote-title', { text: 'Заметок нет' }),
      h('div.wdaynote-text', { text: 'Сюда идёт то, что не влезает в задачу' }));
    return add(wrap, empty);
  }

  add(wrap, ...mine.map(n => {
    const card = h('div.wdaynote', {
      onclick: () => set({ modal: 'note', noteId: n.id, noteText: n.text, noteDated: true }),
    });
    add(card,
      h('div.wdaynote-title', { text: n.title }),
      h('div.wdaynote-text', { text: n.text }));
    return card;
  }));
  return wrap;
}

function todayScreen() {
  const left = h('div.wcol', nowCard(),
    h('div',
      sectHd('расписание', (() => {
        const b = h('button.wlink', { type: 'button', onclick: () => set({ modal: 'schedule' }) });
        add(b, ico('pencil-simple', '13px'), h('span', { text: 'изменить' }));
        return b;
      })()),
      scheduleList()));

  const mid = h('div.wcol', statCards(), tasksBlock(), foodBlock());

  const remList = h('div.wlist');
  add(remList, ...REMINDERS.map(r => {
    const row = h('button.wrem', { type: 'button', onclick: () => openReminder(r.raw) });
    add(row, ico(r.icon, '17px'),
      h('div.wrem-body', h('div.wrem-title', { text: r.title }), h('div.wrem-meta', { text: r.meta })));
    return row;
  }));
  const addRem = h('button.wadd', { type: 'button', onclick: () => openReminder(null) });
  add(addRem, ico('plus', '15px'), h('span', { text: 'Напоминание' }));
  add(remList, addRem);

  const right = h('div.wcol',
    h('div', sectHd('привычки сегодня'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        ...HABITS.map(hb => habitCard(hb)))),
    h('div', sectHd('напоминания'), remList),
    h('div', sectHd('заметки дня'), dayNotes()));

  return h('div.wcols', left, mid, right);
}

// ── Экран «Расписание» ───────────────────────────────────────

/** Что тянут прямо сейчас. Не в state: живёт доли секунды и на вид не влияет. */
let dragging = null;

const snap = px => FROM_MIN + Math.max(0, Math.min(HOURS * 60, Math.round((px / PX_PER_MIN) / SNAP) * SNAP));

/**
 * Дорожки для пересечений.
 *
 * Считаем по группам, а не по всему дню. Если в дне есть хотя бы одна пара
 * наложений, деление ширины на всё подряд сжимало бы и одинокие блоки — и
 * тогда «Подъём» на полчаса становится узкой полоской без названия. Здесь
 * группа — цепочка блоков, которые действительно задевают друг друга;
 * ширину делят только они.
 */
function lanesFor(rows) {
  const items = rows
    .filter(r => r.end !== null && r.start >= FROM_MIN)
    .slice()
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const place = {};
  let group = [];
  let groupEnd = -1;

  const flush = () => {
    if (!group.length) return;
    const ends = [];
    for (const r of group) {
      let i = ends.findIndex(e => e <= r.start);
      if (i < 0) i = ends.length;
      ends[i] = r.end;
      place[r.id] = { lane: i };
    }
    for (const r of group) place[r.id].of = ends.length;
    group = [];
    groupEnd = -1;
  };

  for (const r of items) {
    if (r.start >= groupEnd) flush();
    group.push(r);
    groupEnd = Math.max(groupEnd, r.end);
  }
  flush();

  return { items, place };
}

/** Строки нужного дня из выборки за период. */
function rowsForDate(date) {
  const day = (store.range?.days ?? []).find(d => d.date === date);
  if (!day) return [];
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return day.schedule.map(r => adapt.scheduleRow(r, { isToday: date === todayKey(), minutes }));
}

function planColumn(index, dateKey) {
  const { items, place } = lanesFor(rowsForDate(dateKey));
  const isSel = dateKey === state.date;

  const col = h('div.wplan-col', { class: isSel ? 'on' : '' });

  /*
   * Протягивание не перерисовывает экран. Меняется только пунктирный след,
   * и он правится на месте: полная перерисовка убивала бы под курсором тот
   * самый элемент, который ловит движение мыши.
   */
  const paint = (sel, from, to) => {
    const a = Math.min(from, to), b = Math.max(from, to);
    sel.style.top = `${(a - FROM_MIN) * PX_PER_MIN}px`;
    sel.style.height = `${Math.max(18, (b - a) * PX_PER_MIN)}px`;
    sel.textContent = `${hhmm(a)}–${hhmm(b)}`;
  };

  col.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = snap(e.clientY - col.getBoundingClientRect().top);
    const sel = h('div.wsel');
    add(col, sel);
    dragging = { col, sel, from, to: from + SNAP, date: dateKey };
    paint(sel, from, from + SNAP);
  });

  col.addEventListener('mousemove', e => {
    if (dragging?.col !== col) return;
    const to = snap(e.clientY - col.getBoundingClientRect().top);
    if (to === dragging.to) return;
    dragging.to = to;
    paint(dragging.sel, dragging.from, to);
  });

  for (const r of items) {
    const { lane: i, of } = place[r.id];
    const height = Math.max(20, (r.end - r.start) * PX_PER_MIN - 4);
    const compact = height < 48;
    const step = 100 / of;
    const block = h('button.wblock', {
      type: 'button',
      class: [compact ? 'compact' : '', i > 0 ? 'inner' : ''].filter(Boolean).join(' '),
      style: {
        top: `${(r.start - FROM_MIN) * PX_PER_MIN}px`,
        height: `${height}px`,
        zIndex: String(1 + i),
        ...(of > 1
          ? { left: `calc(${i * step}% + 3px)`, width: `calc(${step}% - 6px)`, right: 'auto' }
          : {}),
      },
      onclick: e => { e.stopPropagation(); openRow(r); },
      // Нажатие на блок — это правка блока, а не новый блок под ним
      onmousedown: e => e.stopPropagation(),
    });
    /*
     * В узкой дорожке низкому блоку хватает места только на одну строку.
     * Показываем название, а не время: когда блок стоит — видно по сетке,
     * а что это за блок — больше нигде не написано.
     */
    const tight = compact && of > 1;
    add(block,
      tight ? null : h('span.wblock-time', { text: `${hhmm(r.start)}–${hhmm(r.end)}` }),
      h('span.wblock-title', {
        text: r.title,
        title: `${hhmm(r.start)}–${hhmm(r.end)} · ${r.title}`,
        style: compact ? {} : { WebkitLineClamp: String(Math.max(1, Math.floor((height - 22) / 16))) },
      }));
    add(col, block);
  }

  if (dateKey === todayKey()) {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (minutes >= FROM_MIN && minutes <= FROM_MIN + HOURS * 60) {
      add(col, h('div.wnowline', { style: { top: `${(minutes - FROM_MIN) * PX_PER_MIN}px` } }, h('i')));
    }
  }

  return col;
}

function planScreen() {
  const cur = dayOf();
  const mon = mondayOf(cur);
  const single = state.view === 'day';

  const seg = h('div.wseg');
  add(seg, ...[['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц']].map(([k, label]) =>
    h('button', {
      type: 'button', text: label, class: state.view === k ? 'on' : '',
      // Месяцу нужны шесть недель, неделе — семь дней: период меняется вместе с видом
      onclick: () => { state.view = k; render(); reload(); },
    })));

  const addBtn = h('button.wbtn', { type: 'button', onclick: () => newRow() });
  add(addBtn, ico('plus', '16px'), h('span', { text: 'Блок' }));

  const head = h('div.whead',
    h('div.whead-text',
      h('div.whead-title', { text: 'Расписание' }),
      h('div.whead-hint', {
        text: state.view === 'month'
          ? 'Клик по дню открывает его целиком. Числами показано, сколько дел запланировано.'
          : 'Потяните по сетке, чтобы создать блок — отпустите, и откроется редактор. Клик по блоку — редактирование или удаление.',
      })),
    seg, addBtn);

  if (state.view === 'month') return h('div', head, monthGrid());

  const cols = single ? 1 : 7;
  const gridCols = `58px repeat(${cols}, minmax(0, 1fr))`;

  const headRow = h('div.wplan-head', { style: { gridTemplateColumns: gridCols } }, h('span'));
  const grid = h('div.wplan-grid', { style: { gridTemplateColumns: gridCols } });

  const hours = h('div.wplan-hours');
  add(hours, ...Array.from({ length: HOURS }, (_, i) => h('div.wplan-hour', { text: `${pad2(i + 6)}:00` })));
  add(grid, hours);

  for (let i = 0; i < 7; i++) {
    const dt = new Date(mon); dt.setDate(mon.getDate() + i);
    const key = keyOf(dt);
    if (single && key !== state.date) continue;

    const dayBtn = h('button.wplan-day', {
      type: 'button', class: key === state.date ? 'on' : '',
      onclick: () => set({ date: key }),
    });
    add(dayBtn,
      h('span.wplan-day-dow', { text: DOW_SHORT[i] }),
      h('span.wplan-day-num', { text: pad2(dt.getDate()) }));
    add(headRow, dayBtn);
    add(grid, planColumn(i, key));
  }

  return h('div', head, headRow, grid);
}

function monthGrid() {
  const cur = dayOf();
  const y = cur.getFullYear(), m = cur.getMonth();
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const dim = new Date(y, m + 1, 0).getDate();
  const prevDim = new Date(y, m, 0).getDate();

  /*
   * Хвосты соседних месяцев считаем по их месяцам, а не по текущему.
   * Иначе клетка «5 сентября» брала данные пятого августа — и это было
   * видно на снимке: одни и те же дела в двух местах сетки.
   */
  const cells = [];
  for (let i = lead - 1; i >= 0; i--) cells.push({ n: prevDim - i, out: true, dt: new Date(y, m - 1, prevDim - i) });
  for (let n = 1; n <= dim; n++) cells.push({ n, out: false, dt: new Date(y, m, n) });
  let tail = 1;
  while (cells.length % 7) { cells.push({ n: tail, out: true, dt: new Date(y, m + 1, tail) }); tail += 1; }

  const head = h('div.wmonth-head');
  add(head, ...DOW_SHORT.map(d => h('span', { text: d })));

  const grid = h('div.wmonth');
  add(grid, ...cells.map(c => {
    const key = keyOf(c.dt);
    const sel = !c.out && key === state.date;
    const day = (store.range?.days ?? []).find(d => d.date === key);
    const items = (day?.schedule ?? [])
      .slice()
      .sort((a, b) => a.start_min - b.start_min)
      .map(r => `${adapt.hhmm(r.start_min)} ${r.title}`);

    const cell = h('button.wcell', {
      type: 'button',
      class: [c.out ? 'out' : '', sel ? 'on' : ''].filter(Boolean).join(' '),
      onclick: () => { if (!c.out) set({ date: key, view: 'day' }); },
    });
    add(cell,
      h('div.wcell-hd',
        h('span.wcell-num', { text: String(c.n) }),
        h('span', { style: { flex: '1' } }),
        items.length ? h('span.wcell-count', { text: String(items.length) }) : null),
      h('div.wcell-items', ...items.slice(0, 3).map(t => h('div.wcell-item', { text: t }))),
      items.length > 3 ? h('div.wcell-more', { text: `+ ещё ${items.length - 3}` }) : null);
    return cell;
  }));

  return h('div', head, grid);
}

// ── Привычки, заметки, настройки ─────────────────────────────

function habitsScreen() {
  const addBtn = h('button.wbtn', { type: 'button', onclick: () => set({ modal: 'habit', habitTitle: '' }) });
  add(addBtn, ico('plus', '16px'), h('span', { text: 'Новая привычка' }));

  const act = HABITS.filter(x => x.active);
  const best = HABITS.reduce((m, x) => Math.max(m, x.raw?.bestStreak ?? 0), 0);
  return h('div.wnarrow',
    h('div.whead',
      h('div.whead-text',
        h('div.whead-title', { text: 'Привычки' }),
        h('div.whead-hint', {
          text: `${act.length} ${adapt.plural(act.length, 'активная', 'активные', 'активных')} сегодня`
            + (best ? ` · лучшая серия ${best} ${adapt.plural(best, 'день', 'дня', 'дней')}` : ''),
        })),
      addBtn),
    h('div.whabits', ...HABITS.map(hb => habitCard(hb, true))));
}

function notesScreen() {
  const addBtn = h('button.wbtn', {
    type: 'button',
    onclick: () => set({ modal: 'note', noteId: state.date, noteText: '', noteDated: true }),
  });
  add(addBtn, ico('plus', '16px'), h('span', { text: 'Новая заметка' }));

  /*
   * Фильтров три, как на эталоне. «Без даты» в этой модели всегда пуст:
   * заметка живёт полем дня, и заметок без даты не бывает — но кнопка есть,
   * и пустой список честно говорит, что таких заметок нет.
   */
  const filters = h('div.wwrap', { style: { marginBottom: '14px' } });
  add(filters, ...[['all', 'Все заметки'], ['day', 'На этот день'], ['free', 'Без даты']].map(([k, label]) =>
    chip(label, state.noteFilter === k, () => set({ noteFilter: k }))));

  const shown = NOTES.filter(n => (state.noteFilter === 'all' ? true : state.noteFilter === 'day' ? n.on : !n.on));
  const grid = h('div.wnotes');
  add(grid, ...shown.map(n => {
    const card = h('button.wnote', {
      type: 'button',
      onclick: () => set({ modal: 'note', noteId: n.id, noteText: n.text, noteDated: true }),
    });
    add(card,
      h('div.wnote-hd',
        h('span.wnote-title', { text: n.title }),
        h('span.wnote-date', { text: n.date, class: n.on ? 'on' : '' })),
      h('div.wnote-text', { text: n.text }));
    return card;
  }));

  return h('div',
    h('div.whead',
      h('div.whead-text',
        h('div.whead-title', { text: 'Заметки' }),
        h('div.whead-hint', { text: 'С датой попадают в дела нужного дня, без даты — живут только здесь' })),
      addBtn),
    filters, grid);
}

function settingsScreen() {
  const themeSeg = h('div.wsegline');
  add(themeSeg, ...[['system', 'Система'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([k, label]) =>
    h('button', {
      type: 'button', text: label, class: state.theme === k ? 'on' : '',
      onclick: () => { state.theme = k; render(); api.saveSettings({ theme: k }).catch(fail); },
    })));

  const scaleSeg = h('div.wsegline');
  add(scaleSeg, ...[[1, '100%'], [1.25, '125%'], [1.5, '150%']].map(([v, label]) =>
    h('button', {
      type: 'button', text: label, class: state.scale === v ? 'on' : '',
      style: { fontSize: `${13 + (v - 1) * 8}px` },
      onclick: () => { state.scale = v; render(); data.saveSettings({ scale: v }).catch(fail); },
    })));

  const swatches = h('div.wswatches');
  add(swatches, ...Object.keys(PALETTE).map(k => {
    const c = PALETTE[k][dark() ? 'dark' : 'light'];
    const on = state.color === k;
    const b = h('button.wswatch', {
      type: 'button', class: on ? 'on' : '',
      onclick: () => { state.color = k; render(); data.saveSettings({ accent: k }).catch(fail); },
    });
    const sq = h('i', { style: { background: c, ...(on ? { boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${c}` } : {}) } });
    add(sq, ico('check-bold', '16px'));
    add(b, sq, h('span', { text: PALETTE[k].label }));
    return b;
  }));

  const look = h('div.wpanel',
    cap('оформление'),
    h('div.wpanel-label', { text: 'Тема' }), themeSeg,
    h('div.wpanel-label', { text: 'Размер текста' }), scaleSeg,
    h('div.wpanel-label', { text: 'Цвет приложения' }), swatches);

  const flags = store.settings?.settings ?? {};
  const switches = [
    { k: 'carryOver', label: 'Переносить невыполненное', hint: 'задачи уезжают на завтра' },
    { k: 'mealSlots', label: 'Делить питание на приёмы', hint: 'завтрак, обед, ужин, перекус' },
    { k: 'showKcal', label: 'Показывать калории', hint: 'счётчик и дневная цель' },
    { k: 'mealsToSchedule', label: 'Питание со временем — в расписание', hint: 'только по подтверждению' },
  ];
  const day = h('div.wpanel-list', cap('день и питание'));
  add(day, ...switches.map(s => {
    const on = Boolean(flags[s.k]);
    const row = h('button.wrow-sw', {
      type: 'button',
      onclick: () => data.saveSettings({ [s.k]: !on }).then(render).catch(fail),
    });
    add(row,
      h('div.wrow-sw-body',
        h('div.wrow-sw-title', { text: s.label }),
        h('div.wrow-sw-hint', { text: s.hint })),
      sw(on));
    return row;
  }));

  const links = [
    { icon: 'alarm-fill', label: 'Звук будильника', value: state.sound, m: 'sound' },
    { icon: 'bell', label: 'Звук уведомлений', value: state.notifySound, m: 'sound' },
    { icon: 'calendar-check', label: 'Общее расписание', value: 'шаблон дня', m: 'template' },
    { icon: 'file-arrow-down', label: 'Экспорт данных', value: 'JSON', m: 'export' },
    { icon: 'file-arrow-up', label: 'Импорт данных', value: 'JSON', m: 'import' },
  ];
  const dataPanel = h('div.wpanel-list', cap('звуки и данные'));
  add(dataPanel, ...links.map(l => {
    const row = h('button.wrow-link', { type: 'button', onclick: () => openLink(l.m, l.label) });
    add(row, ico(l.icon, '17px'), h('span', { text: l.label }),
      h('span.wrow-link-val', { text: l.value }), ico('caret-right', '14px'));
    return row;
  }));

  const devices = h('div.wpanel',
    cap('устройства'),
    h('div.wpanel-note', { text: 'Браузер — это ещё одно устройство: расписание и дела синхронизируются с телефоном.' }),
    h('div.wdevs',
      h('div.wdev',
        ico('browser', '17px'),
        h('div.wdev-body',
          h('div.wdev-name', { text: 'Этот браузер' }),
          h('div.wdev-seen', { text: store.user?.email ?? '' })),
        h('span.wdev-tag', { text: 'сейчас' })),
      ...store.devices.map(d => h('div.wdev',
        ico(d.platform === 'android' ? 'device-mobile' : 'laptop', '17px'),
        h('div.wdev-body',
          h('div.wdev-name', { text: d.name || 'Устройство' }),
          h('div.wdev-seen', {
            text: d.last_seen_at ? `заходило ${adapt.shortDate(String(d.last_seen_at).slice(0, 10))}` : 'ещё не заходило',
          }))))));

  return h('div',
    h('div.whead-title', { text: 'Настройки', style: { marginBottom: '18px' } }),
    h('div.wsettings', look, day, dataPanel, devices));
}

/**
 * Шторки из настроек. Открываются с уже загруженными данными, а не с
 * пустотой, которая через секунду заполнится: мигание списком читается
 * как ошибка.
 */
function openLink(kind, label) {
  if (kind === 'export' || kind === 'import') {
    // Вид выгрузки сбрасываем: «календарь», выбранный в экспорте, в импорте
    // не значит ничего, и ни одна кнопка не выглядела бы нажатой
    set({ modal: 'file', fileKind: kind, fileScope: null, notice: null });
    return;
  }
  if (kind === 'sound') {
    set({ modal: 'sound', soundKind: label });
    return;
  }
  set({ modal: 'template', tplRows: adapt.templateRows(store.template), tplEdit: null });
  // День нужен свежий: «взять из этого дня» берёт то, что в нём сейчас,
  // а на экране настроек день сам по себе не перечитывается
  Promise.all([data.loadTemplate(), data.loadDay(state.date)])
    .then(() => { fill(); set({ tplRows: adapt.templateRows(store.template) }); })
    .catch(fail);
}

// ── Шторки ───────────────────────────────────────────────────

function openRow(r) {
  set({
    modal: 'row', rowId: r.id, rowDate: state.date,
    rowStart: r.start, rowEnd: r.end ?? r.start + 30, rowField: 'start',
    rowTitle: r.title, rowAlarm: r.alarm, rowLead: leadsOf(r)[0],
  });
}

/** Новый блок: время либо протянутое, либо предложенное кнопкой. */
function newRow({ date = state.date, start = 600, end = 660 } = {}) {
  set({
    modal: 'row', rowId: 'new', rowDate: date,
    rowStart: start, rowEnd: end, rowField: 'start',
    rowTitle: '', rowAlarm: 'off', rowLead: 'at',
  });
}

/** Сохранить строку. Новую создаём, существующую правим. */
function saveRow() {
  const body = adapt.rowToServer({
    title: state.rowTitle, start: state.rowStart, end: state.rowEnd,
    alarm: state.rowAlarm, lead: state.rowLead,
  });
  if (!body.title) { state.notice = 'Впишите, что делаем'; render(); return; }
  const date = state.rowDate ?? state.date;
  const job = state.rowId === 'new'
    ? data.createRow(date, body)
    : data.updateRow(date, state.rowId, body);
  busy(job);
}

function deleteRow() {
  if (state.rowId === 'new') { closeModal(); return; }
  busy(data.removeRow(state.rowDate ?? state.date, state.rowId));
}

// ── Напоминание ──────────────────────────────────────────────

/*
 * Напоминание — это момент без длительности, у которого включён сигнал.
 * Отдельной сущности в модели нет, и придумывать её здесь нельзя; зато
 * повтор настоящий: он уходит правилом в `series`.
 */
const RU_DATE = date => {
  const [y, m, d] = String(date).split('-');
  return `${d}.${m}.${y}`;
};
const fromRuDate = text => {
  const m = /^(\d{2})[.\-/](\d{2})[.\-/](\d{4})$/.exec(String(text).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const FREQ_OF = {
  Разово: null, Ежедневно: 'daily', Еженедельно: 'weekly',
  Ежемесячно: 'monthly', Ежегодно: 'yearly',
};

function openReminder(row) {
  set({
    modal: 'reminder',
    remId: row?.id ?? 'new',
    remTitle: row?.title ?? '',
    remDate: RU_DATE(state.date),
    remTime: hhmm(row?.start_min ?? row?.start ?? 600),
    remLead: row ? leadsOf(adapt.scheduleRow(row, { isToday: false, minutes: 0 }))[0] : 'at',
    remRepeat: 'Разово',
  });
}

function saveReminder() {
  const title = String(state.remTitle ?? '').trim();
  if (!title) { note('О чём напомнить?'); return; }
  const date = fromRuDate(state.remDate);
  if (!date) { note('Дата пишется как 05.08.2026'); return; }
  const startMin = parseHhmm(state.remTime);
  if (startMin === null) { note('Время пишется как 10:00'); return; }

  const body = adapt.rowToServer({
    title, start: startMin, end: null, alarm: 'notify', lead: state.remLead,
  });
  const freq = FREQ_OF[state.remRepeat];

  const job = state.remId === 'new'
    ? (freq
      ? data.createRepeat({ freq, startDate: date, row: body })
      : data.createRow(date, body))
    : data.updateRow(date, state.remId, body);
  busy(job);
}

// ── Шаблон дня ───────────────────────────────────────────────

/** Открыть строку шаблона. `new` — добавление. */
function openTplRow(index) {
  const r = index === 'new' ? null : (state.tplRows ?? [])[index];
  set({
    modal: 'tplRow', tplEdit: index, tplField: 'start',
    tplStart: r?.start ?? 420,
    tplEnd: r?.end ?? (r ? r.start + 60 : 480),
    tplTitle: r?.title ?? '',
    tplAlarm: r?.alarm ?? 'off',
    tplLead: (r?.leads ?? ['at'])[0],
  });
}

function saveTplRow() {
  const title = String(state.tplTitle ?? '').trim();
  if (!title) { note('Впишите, что делаем'); return; }
  const rows = [...(state.tplRows ?? [])];
  const row = {
    start: state.tplStart, end: state.tplEnd, title,
    alarm: state.tplAlarm, leads: [state.tplLead],
  };
  if (state.tplEdit === 'new') rows.push(row);
  else rows[state.tplEdit] = row;
  saveTemplate(rows);
}

function removeTplRow() {
  if (state.tplEdit === 'new') { set({ modal: 'template' }); return; }
  const rows = (state.tplRows ?? []).filter((_, i) => i !== state.tplEdit);
  saveTemplate(rows, rows.length ? undefined : 'Шаблон опустел и больше не хранится');
}

/**
 * Шаблон пишется целиком: правка одной строки — это новая версия всего
 * набора. Набор маленький, а частичное обновление потребовало бы у строк
 * шаблона своих идентификаторов, которых у них нет.
 */
function saveTemplate(rows, okText) {
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  return act(
    data.saveTemplate(adapt.templateToServer(sorted)).then(() => {
      state.tplRows = adapt.templateRows(store.template);
      state.modal = 'template';
    }),
    okText,
  );
}

/**
 * Пока запрос в пути — кнопка занята. Иначе двойное нажатие создаёт две
 * строки, и это замечают уже в расписании.
 */
function busy(job) {
  state.busy = true;
  render();
  job.then(() => { state.busy = false; state.modal = null; return reload(); })
    .catch(e => { state.busy = false; fail(e); });
}

const closeModal = () => set({ modal: null });

const TITLES = {
  row: () => (state.rowId === 'new' ? 'Новый блок' : 'Строка расписания'),
  schedule: () => 'Расписание дня',
  ai: () => 'Помощник',
  habit: () => 'Новая привычка',
  note: () => 'Заметка',
  task: () => 'Задача',
  meal: () => 'Приём пищи',
  reminder: () => 'Напоминание',
  sound: () => state.soundKind,
  template: () => 'Общее расписание',
  tplRow: () => 'Строка шаблона',
  file: () => (state.fileKind === 'import' ? 'Импорт данных' : 'Экспорт данных'),
  print: () => 'Печать дня',
};

const WIDE = new Set(['ai', 'schedule', 'note', 'habit']);

function modal() {
  if (!state.modal) return null;
  const body = BODIES[state.modal]?.() ?? h('div');

  const card = h('div.wmodal', {
    class: WIDE.has(state.modal) ? 'wide' : '',
    role: 'dialog', 'aria-modal': 'true',
    onclick: e => e.stopPropagation(),
  },
    h('div.wmodal-hd',
      h('b', { text: TITLES[state.modal]?.() ?? '' }),
      iconBtn('x', { title: 'Закрыть', onclick: closeModal, cls: 'wmodal-x' })),
    // Отказ, случившийся в шторке, виден в ней же: на экране под затемнением
    // его никто не прочитает — а «Готово» без названия молчала бы совсем
    state.notice ? h('div.wnotice', { text: state.notice }) : null,
    body);

  return h('div.wveil', { onclick: closeModal }, card);
}

/** Две кнопки внизу шторки: слева тихая, справа главная. */
const footer = (quiet, main, onMain = closeModal) =>
  h('div.wrow-end',
    h('button.wbtn-quiet', { type: 'button', text: quiet, onclick: closeModal }),
    h('button.wbtn-wide', { type: 'button', text: main, onclick: onMain }));

function clockGrid(count, step, value, onPick) {
  const grid = h('div.wclock-grid');
  add(grid, ...Array.from({ length: count }, (_, i) => {
    const v = i * step;
    const on = step === 1 ? Math.floor(value / 60) === v : value % 60 === v;
    return h('button', {
      type: 'button', class: on ? 'on' : '',
      text: step === 1 ? String(v) : pad2(v),
      onclick: () => onPick(v),
    });
  }));
  return grid;
}

const BODIES = {
  // ── Строка расписания ──
  row() {
    const rs = state.rowStart ?? 600;
    const re = state.rowEnd ?? rs + 60;
    const dur = Math.max(5, re - rs);
    const field = state.rowField;
    const target = field === 'end' ? re : rs;

    const tiles = h('div.wgrid3');
    add(tiles, ...[
      ['start', 'начало', hhmm(rs)],
      ['dur', 'длится', hhmm(dur)],
      ['end', 'конец', hhmm(re)],
    ].map(([k, label, value]) => {
      const tile = h('div.wtile', { class: field === k ? 'on' : '', onclick: () => set({ rowField: k }) });
      add(tile, h('span.wtile-cap', { text: label }), h('input', { value, readOnly: true }));
      return tile;
    }));

    const setHour = hv => {
      const mins = target % 60;
      if (field === 'end') set({ rowEnd: hv * 60 + mins });
      else set({ rowStart: hv * 60 + mins, rowEnd: hv * 60 + mins + dur });
    };
    const setMin = mv => {
      const hv = Math.floor(target / 60);
      if (field === 'end') set({ rowEnd: hv * 60 + mv });
      else set({ rowStart: hv * 60 + mv, rowEnd: hv * 60 + mv + dur });
    };

    const leads = h('div.wwrap');
    add(leads, ...LEADS.map(l => sheetChip(l.label, state.rowLead === l.k, () => set({ rowLead: l.k }))));

    const modes = h('div.wgrid2');
    add(modes, ...ALARM.map(a => opt(a.label, a.icon, state.rowAlarm === a.k, () => set({ rowAlarm: a.k }))));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что делаем' }),
        h('input.winput', {
          value: state.rowTitle,
          placeholder: 'Например, работа над отчётом',
          oninput: e => { state.rowTitle = e.target.value; },
        })),
      tiles,
      h('div.wclock',
        h('div.wclock-cap', { text: 'можно вписать вручную выше или выбрать час' }),
        clockGrid(24, 1, target, setHour),
        h('div.wclock-cap', { text: 'минуты', style: { margin: '12px 0 9px' } }),
        clockGrid(12, 5, target, setMin)),
      h('div', h('div.wfield-label', { text: 'предупредить' }), leads),
      h('div', h('div.wfield-label', { text: 'чем предупредить' }), modes),
      h('div.wrow-end',
        h('button.wbtn-quiet', { type: 'button', text: 'Удалить', onclick: deleteRow }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово',
          disabled: state.busy, onclick: saveRow,
        })));
  },

  // ── Расписание дня списком ──
  schedule() {
    const list = h('div.wstack-tight');
    add(list, ...SCHEDULE.map(r => {
      const mode = alarmOf(r);
      const row = h('button.wsheet-row', { type: 'button', onclick: () => openRow(r) });
      add(row,
        ico('dots-six-vertical', '16px', 'wgrab'),
        h('span.wlead', { text: hhmm(r.start) }),
        h('span.wtitle', { text: r.title }),
        mode === 'off' ? null : ico(bellOf(mode).icon, '16px', 'wbell'),
        ico('caret-right', '14px', 'wchev'));
      return row;
    }));

    const addRow = h('button.wbtn-dashed', { type: 'button', onclick: () => newRow() });
    add(addRow, ico('plus', '15px'), h('span', { text: 'Строка' }));
    const withAi = h('button.wbtn-dashed', { type: 'button', onclick: () => set({ modal: 'ai', aiStep: 'input' }) });
    add(withAi, ico('sparkle-fill', '15px'), h('span', { text: 'С помощью ИИ' }));

    return h('div.wstack-tight', list,
      h('div.wrow', { style: { marginTop: '6px' } }, addRow, withAi),
      h('button.wbtn-wide', { type: 'button', text: 'Готово', onclick: closeModal }));
  },

  // ── Помощник ──
  ai() {
    if (state.aiStep === 'plan') {
      const grid = h('div.wgrid2');
      add(grid, ...(state.aiItems ?? []).map((p, i) => {
        const on = !state.aiOff[i];
        const row = h('button.wplan-item', {
          type: 'button', class: on ? '' : 'off',
          onclick: () => set(x => ({ aiOff: { ...x.aiOff, [i]: on } })),
        });
        add(row, box(on),
          h('div.wplan-item-body',
            h('div.wplan-item-title', { text: p.title || 'Без названия' }),
            h('div.wplan-item-meta', { text: aiMeta(p) })),
          h('span.wtag', { text: AI_TAG[p.kind] ?? 'дело' }));
        return row;
      }));
      const chosen = (state.aiItems ?? []).filter((_, i) => !state.aiOff[i]);
      return h('div.wstack',
        h('div.wbubble',
          h('span.wbubble-ava', ico('sparkle-fill', '16px')),
          h('div.wbubble-text', { text: 'Вот что добавлю. Снимите галочку, если что-то лишнее.' })),
        grid,
        h('div.wrow-end',
          h('button.wbtn-quiet', { type: 'button', text: 'Исправить', onclick: () => set({ aiStep: 'input' }) }),
          h('button.wbtn-wide', {
            type: 'button', text: state.busy ? 'Добавляю…' : `Добавить ${chosen.length}`,
            disabled: state.busy || !chosen.length,
            onclick: () => aiApply(chosen),
          })));
    }

    if (state.aiStep === 'ask') {
      const chips = h('div.wwrap');
      add(chips, ...(state.aiOptions ?? []).map(o => sheetChip(o, false, () => aiSend(o))));
      return h('div.wstack',
        h('div.wbubble',
          h('span.wbubble-ava', ico('sparkle-fill', '16px')),
          h('div.wbubble-text', { text: state.aiQuestion })),
        chips,
        h('input.winput', {
          placeholder: 'или свой ответ',
          onkeydown: e => { if (e.key === 'Enter' && e.target.value.trim()) aiSend(e.target.value.trim()); },
        }),
        h('button.wbtn-quiet', { type: 'button', text: 'Назад к тексту', onclick: () => set({ aiStep: 'input' }) }));
    }

    const listening = state.aiStep === 'listening';
    const area = h('textarea.wai-input', {
      value: state.aiText,
      placeholder: 'Опишите день словами — например, «завтра подъём в семь, в два созвон на час, вечером зал»',
      oninput: e => { state.aiText = e.target.value; },
    });
    const mic = h('button.wmic', {
      type: 'button', class: listening ? 'listening' : '',
      title: 'Продиктовать', 'aria-label': 'Продиктовать',
      disabled: !store.ai.voice,
      onclick: dictate,
    });
    add(mic, ico(listening ? 'waveform-fill' : 'microphone-fill', '22px'));

    return h('div.wstack',
      h('div.whint', {
        text: store.ai.ready
          ? 'Опишите день словами или продиктуйте — разложу по расписанию, делам и напоминаниям.'
          : 'Помощник не подключён. Владелец задаёт подключение в настройках.',
      }),
      h('div.wai-row', area, mic),
      state.notice ? h('div.whint', { text: state.notice, style: { color: 'var(--accent)' } }) : null,
      h('button.wbtn-wide', {
        type: 'button', text: state.busy ? 'Разбираю…' : 'Разобрать',
        disabled: state.busy || !store.ai.ready,
        onclick: () => aiSend(null),
      }));
  },

  // ── Новая привычка ──
  habit() {
    const emoji = h('div.wrow');
    add(emoji, ...HABIT_EMOJI.map(e =>
      h('button.wemoji', { type: 'button', text: e, class: state.habitEmoji === e ? 'on' : '', onclick: () => set({ habitEmoji: e }) })));
    add(emoji, h('span', { style: { flex: '1' } }),
      ...[['do', 'Выполнять'], ['avoid', 'Бросаю']].map(([k, label]) =>
        sheetChip(label, state.habitKind === k, () => set({ habitKind: k }))));

    const days = h('div.wdays7');
    add(days, ...DOW_SHORT.map((d, i) =>
      h('button', { type: 'button', text: d, class: state.habitDays[i] ? 'on' : '', onclick: () => set(s => ({ habitDays: { ...s.habitDays, [i]: !s.habitDays[i] } })) })));

    const goals = h('div.wrow');
    add(goals, ...[[30, '30 дней'], [100, '100 дней'], [0, '∞'], [-1, 'Своё']].map(([v, label]) => {
      const c = sheetChip(label, state.habitGoal === v, () => set({ habitGoal: v, habitGoalCustom: v === -1 }), 'wchip-flex');
      if (v === 0) c.style.font = '500 19px/1 var(--ui)';
      return c;
    }));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'название' }),
        h('input.winput', {
          value: state.habitTitle, placeholder: 'Например, вода — 2 литра',
          oninput: e => { state.habitTitle = e.target.value; },
        })),
      h('div', h('div.wfield-label', { text: 'значок и тип' }), emoji),
      h('div',
        h('div.wfield-label', { text: 'дни недели' }), days,
        h('div.wrow', { style: { marginTop: '10px' } },
          h('span.wsmall', { text: 'или свободно' }),
          h('input.wnum', { value: String(state.habitTimes) }),
          h('span.wsmall', { text: 'раз в неделю' }))),
      h('div',
        h('div.wfield-label', { text: 'челлендж' }), goals,
        state.habitGoalCustom
          ? h('div.wrow', { style: { marginTop: '10px' } },
            h('input.wnum', { value: '730' }), h('span.wsmall', { text: 'дней подряд' }))
          : null),
      h('div.wrow-end',
        h('button.wbtn-quiet', { type: 'button', text: 'Отмена', onclick: closeModal }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Создаю…' : 'Создать привычку', disabled: state.busy,
          onclick: () => {
            const title = state.habitTitle.trim();
            if (!title) { state.notice = 'Впишите название'; render(); return; }
            // Маска дней недели битами: понедельник — младший
            const mask = Object.entries(state.habitDays)
              .reduce((acc, [i, on]) => (on ? acc | (1 << Number(i)) : acc), 0);
            busy(data.createHabit({
              title, emoji: state.habitEmoji,
              polarity: state.habitKind === 'avoid' ? 'avoid' : 'do',
              scheduleMask: mask || 127,
              mode: state.habitGoal > 0 ? 'challenge' : 'ongoing',
              ...(state.habitGoal > 0 ? { challengeTargetDays: state.habitGoal } : {}),
            }));
          },
        })));
  },

  // ── Заметка ──
  note() {
    const kinds = h('div.wrow');
    add(kinds, ...[[false, 'Просто заметка'], [true, 'На дату']].map(([v, label]) =>
      sheetChip(label, state.noteDated === v, () => set({ noteDated: v }))));
    if (state.noteDated) {
      const cur = dayOf();
      const badge = h('span.wdate-chip');
      add(badge, ico('calendar-blank', '15px'), h('span', { text: `${cur.getDate()} ${MONTHS[cur.getMonth()]} · покажется в делах` }));
      add(kinds, badge);
    }

    /*
     * Заметка пока одна на день: сервер держит её полем дня. Заголовок —
     * первая строка текста, поэтому отдельного поля нет: два поля, из
     * которых одно — начало другого, только путают.
     */
    return h('div.wstack',
      h('div.whint', { text: `Заметка дня ${adapt.shortDate(state.noteId ?? state.date)}. Первая строка станет заголовком в списке.` }),
      kinds,
      h('textarea.wtextarea', {
        value: state.noteText, placeholder: 'О чём не хочется забыть',
        oninput: e => { state.noteText = e.target.value; },
      }),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: 'Очистить',
          onclick: () => busy(data.saveNote(state.noteId ?? state.date, '')),
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Сохранить', disabled: state.busy,
          onclick: () => busy(data.saveNote(state.noteId ?? state.date, state.noteText)),
        })));
  },

  // ── Задача ──
  task() {
    const cats = h('div.wrow');
    add(cats, ...CATS.map(c =>
      sheetChip(c.label, state.taskCat === c.k, () => set({ taskCat: c.k }), 'wchip-flex')));

    const save = () => {
      const body = adapt.taskToServer({ title: state.taskTitle, cat: state.taskCat });
      if (!body.text) { state.notice = 'Впишите задачу'; render(); return; }
      busy(state.taskId === 'new'
        ? data.createTask(state.date, body)
        : data.updateTask(state.date, state.taskId, body));
    };

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'задача' }),
        h('input.winput', {
          value: state.taskTitle, placeholder: 'Что нужно сделать',
          oninput: e => { state.taskTitle = e.target.value; },
        })),
      h('div', h('div.wfield-label', { text: 'категория' }), cats),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: 'Удалить',
          onclick: () => (state.taskId === 'new' ? closeModal() : busy(data.removeTask(state.date, state.taskId))),
        }),
        h('button.wbtn-wide', { type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово', disabled: state.busy, onclick: save })));
  },

  // ── Приём пищи ──
  meal() {
    const modes = h('div.wgrid3');
    add(modes, ...[
      ['none', 'Без времени', 'list-dashes'],
      ['window', 'Окно', 'arrows-out-line-horizontal'],
      ['exact', 'Точное время', 'clock'],
    ].map(([k, label, iconName]) => opt(label, iconName, state.mealMode === k, () => set({ mealMode: k }), true)));

    const hasTime = state.mealMode !== 'none';
    const exact = state.mealMode === 'exact';

    const durs = h('div.wrow');
    add(durs, ...[15, 30, 45, 60].map(v =>
      sheetChip(v < 60 ? `${v} мин` : '1 ч', state.mealDur === v, () => set({ mealDur: v }), 'wchip-flex')));

    const leads = h('div.wwrap');
    add(leads, ...LEADS.map(l => sheetChip(l.label, (state.mealLead ?? 'at') === l.k, () => set({ mealLead: l.k }))));

    const schedCard = h('button.wtoggle-card', { type: 'button', onclick: () => set(s => ({ mealSched: !s.mealSched })) },
      h('div.wtoggle-card-body',
        h('div.wrow-sw-title', { text: 'Добавить в расписание' }),
        h('div.wrow-sw-hint', { text: `займёт блок ${state.mealDur < 60 ? state.mealDur + ' мин' : '1 ч'}, ничего не сдвинет без подтверждения` })),
      sw(state.mealSched));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что едим' }),
        h('input.winput', {
          value: state.mealTitle, placeholder: 'Например, курица с рисом',
          oninput: e => { state.mealTitle = e.target.value; },
        })),
      h('div',
        h('div.wfield-label', { text: 'время' }), modes,
        hasTime
          ? h('div.wrow', { style: { marginTop: '12px' } },
            h('input.wtime', { value: state.mealMode === 'window' ? '12:00' : '19:30' }),
            h('span.whint', { text: state.mealMode === 'window' ? '—' : '+' }),
            h('input.wtime', { value: state.mealMode === 'window' ? '14:00' : '00:30' }))
          : null),
      h('div.wrow',
        h('input.wnum', {
          value: state.mealKcal, placeholder: '—', inputMode: 'numeric',
          oninput: e => { state.mealKcal = e.target.value; },
        }),
        h('span.wsmall', { text: 'ккал — можно оставить пустым' })),
      exact ? h('div', h('div.wfield-label', { text: 'сколько занять в расписании' }), durs) : null,
      exact ? schedCard : null,
      h('div', h('div.wfield-label', { text: 'напомнить · можно несколько' }), leads),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: 'Удалить',
          onclick: () => (state.mealId === 'new' ? closeModal() : busy(data.removeMeal(state.date, state.mealId))),
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово', disabled: state.busy,
          onclick: () => {
            const body = adapt.mealToServer({
              title: state.mealTitle,
              kcal: Number.parseInt(state.mealKcal, 10),
            });
            if (!body.title) { state.notice = 'Впишите, что едим'; render(); return; }
            busy(state.mealId === 'new'
              ? data.createMeal(state.date, body)
              : data.updateMeal(state.date, state.mealId, body));
          },
        })));
  },

  // ── Напоминание ──
  reminder() {
    const repeats = h('div.wwrap');
    add(repeats, ...REPEATS.map(r => sheetChip(r, state.remRepeat === r, () => set({ remRepeat: r }))));

    const leads = h('div.wwrap');
    add(leads, ...[...LEADS, { k: 'week', label: 'за неделю' }].map(l =>
      sheetChip(l.label, state.remLead === l.k, () => set({ remLead: l.k }))));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'о чём напомнить' }),
        h('input.winput', {
          value: state.remTitle, placeholder: 'Например, забрать документы',
          oninput: e => { state.remTitle = e.target.value; },
        })),
      h('div.wrow',
        h('input.wtime', {
          value: state.remDate, 'aria-label': 'Дата',
          oninput: e => { state.remDate = e.target.value; },
        }),
        h('input.wtime', {
          value: state.remTime, 'aria-label': 'Время',
          oninput: e => { state.remTime = e.target.value; },
        }),
        h('span.whint', { text: 'дата и время — можно вписать вручную' })),
      h('div', h('div.wfield-label', { text: 'повтор' }), repeats),
      h('div', h('div.wfield-label', { text: 'предупредить' }), leads),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: 'Удалить', disabled: state.busy,
          onclick: () => (state.remId === 'new' ? closeModal() : busy(data.removeRow(state.date, state.remId))),
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово', disabled: state.busy,
          onclick: saveReminder,
        })));
  },

  // ── Звук ──
  sound() {
    const key = state.soundKind === 'Звук уведомлений' ? 'notifySound' : 'sound';
    const list = h('div.wstack-tight');
    add(list, ...SOUNDS.map(s => {
      const b = h('button.wopt', {
        type: 'button', class: state[key] === s.k ? 'on' : '',
        onclick: () => {
          state[key] = s.k;
          render();
          data.saveSettings({ [key]: s.k }).catch(fail);
        },
      });
      add(b, ico(s.k === 'Случайный' ? 'shuffle' : 'music-note-simple', '17px'),
        h('div.wopt-body',
          h('div.wopt-title', { text: s.k }),
          h('div.wopt-hint', { text: s.hint })));
      return b;
    }));
    const own = h('button.wbtn-dashed', { type: 'button' });
    add(own, ico('plus', '15px'), h('span', { text: 'Добавить свой звук' }));
    return h('div.wstack', list, own,
      h('button.wbtn-wide', { type: 'button', text: 'Готово', onclick: closeModal }));
  },

  // ── Экспорт и импорт ──
  file() {
    const imp = state.fileKind === 'import';

    /*
     * Виды выгрузки — как на эталоне: день, месяц, всё. Первые два сервер
     * не умеет, поэтому день и месяц вырезаются из общей выгрузки уже
     * здесь — по датам. Файл при этом остаётся тем же форматом, и обратно
     * он вливается той же загрузкой.
     */
    const scope = state.fileScope ?? (imp ? 'merge' : 'all');
    const scopes = h('div.wwrap');
    add(scopes, ...(imp
      ? [['merge', 'Добавить к текущим'], ['replace', 'Заменить всё']]
      : [['day', 'Этот день'], ['month', 'Этот месяц'], ['all', 'Все данные']]
    ).map(([k, label]) => sheetChip(label, scope === k, () => set({ fileScope: k }))));

    const picker = h('input', {
      type: 'file', accept: 'application/json,.json',
      style: { display: 'none' },
      onchange: e => importFile(e.target.files?.[0], scope),
    });

    const name = imp ? 'newday-backup.json'
      : scope === 'day' ? `newday-${state.date}.json`
        : scope === 'month' ? `newday-${state.date.slice(0, 7)}.json`
          : 'newday-all.json';

    return h('div.wstack',
      h('div.whint', {
        text: imp
          ? 'Возьмём JSON из экспорта. Ничего не удаляется без вашего выбора.'
          : 'Выгрузим всё в один JSON-файл — его можно сохранить или перенести на телефон.',
      }),
      scopes,
      h('div.wfile',
        ico(imp ? 'file-arrow-up' : 'file-arrow-down', '24px'),
        h('div.wfile-body',
          h('div.wfile-name', { text: name }),
          h('div.wfile-meta', {
            text: imp
              ? 'выгрузка NewDay · дни, задачи, питание, привычки'
              : 'сохранится в «Загрузки» · дни, задачи, питание, спорт, привычки',
          }))),
      picker,
      h('button.wbtn-wide', {
        type: 'button',
        text: state.busy ? 'Работаю…' : imp ? 'Выбрать файл и импортировать' : 'Сохранить файл',
        disabled: state.busy,
        onclick: () => (imp ? picker.click() : downloadExport(scope)),
      }));
  },

  // ── Общее расписание ──
  template() {
    const rows = state.tplRows ?? [];

    const list = h('div.wstack-tight');
    add(list, ...rows.map((r, i) => {
      const row = h('button.wsheet-row', { type: 'button', onclick: () => openTplRow(i) });
      add(row, ico('dots-six-vertical', '16px', 'wgrab'),
        h('span.wlead', { text: r.end === null ? hhmm(r.start) : `${hhmm(r.start)}–${hhmm(r.end)}` }),
        h('span.wtitle', { text: r.title }),
        r.alarm === 'off' ? null : ico(bellOf(r.alarm).icon, '16px', 'wbell'),
        ico('caret-right', '14px', 'wchev'));
      return row;
    }));

    const addRow = h('button.wbtn-dashed', { type: 'button', onclick: () => openTplRow('new') });
    add(addRow, ico('plus', '15px'), h('span', { text: 'Строка шаблона' }));

    // Шаблон почти всегда собирают не с нуля, а из дня, который получился
    const fromDay = h('button.wbtn-dashed', {
      type: 'button', disabled: state.busy || !SCHEDULE.length,
      onclick: () => saveTemplate(SCHEDULE.map(r => ({
        start: r.start, end: r.end, title: r.title, alarm: r.alarm, leads: r.leads,
      })), 'Шаблон собран из этого дня'),
    });
    add(fromDay, ico('list-dashes', '15px'), h('span', { text: 'Взять из этого дня' }));

    return h('div.wstack-tight',
      h('div.whint', {
        text: 'Шаблон без дат. Новые дни заполняются им, если ничего не запланировано.',
        style: { marginBottom: '4px' },
      }),
      rows.length ? list : h('div.whint', { text: 'Пока пусто.' }),
      h('div.wrow', { style: { marginTop: '6px' } }, addRow, fromDay),
      h('button.wbtn-wide', {
        type: 'button',
        text: state.busy ? 'Работаю…' : 'Готово',
        disabled: state.busy,
        onclick: closeModal,
      }));
  },

  /*
   * Строка шаблона. На эталоне её редактора нет — там строки просто
   * кликабельны, а что открывается, не нарисовано. Без этого экрана ни
   * одна строка шаблона не правится, поэтому он взят с редактора строки
   * дня: поля те же.
   */
  tplRow() {
    const rs = state.tplStart ?? 420;
    const re = state.tplEnd ?? rs + 60;
    const dur = Math.max(5, re - rs);
    const field = state.tplField;
    const target = field === 'end' ? re : rs;

    const tiles = h('div.wgrid3');
    add(tiles, ...[
      ['start', 'начало', hhmm(rs)],
      ['dur', 'длится', hhmm(dur)],
      ['end', 'конец', hhmm(re)],
    ].map(([k, label, value]) => {
      const tile = h('div.wtile', { class: field === k ? 'on' : '', onclick: () => set({ tplField: k }) });
      add(tile, h('span.wtile-cap', { text: label }), h('input', { value, readOnly: true }));
      return tile;
    }));

    const setHour = hv => {
      const mins = target % 60;
      if (field === 'end') set({ tplEnd: hv * 60 + mins });
      else set({ tplStart: hv * 60 + mins, tplEnd: hv * 60 + mins + dur });
    };
    const setMin = mv => {
      const hv = Math.floor(target / 60);
      if (field === 'end') set({ tplEnd: hv * 60 + mv });
      else set({ tplStart: hv * 60 + mv, tplEnd: hv * 60 + mv + dur });
    };

    const leads = h('div.wwrap');
    add(leads, ...LEADS.map(l => sheetChip(l.label, state.tplLead === l.k, () => set({ tplLead: l.k }))));

    const modes = h('div.wgrid2');
    add(modes, ...ALARM.map(a => opt(a.label, a.icon, state.tplAlarm === a.k, () => set({ tplAlarm: a.k }))));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что делаем' }),
        h('input.winput', {
          value: state.tplTitle, placeholder: 'Например, подъём',
          oninput: e => { state.tplTitle = e.target.value; },
        })),
      tiles,
      h('div.wclock',
        h('div.wclock-cap', { text: 'можно выбрать час' }),
        clockGrid(24, 1, target, setHour),
        h('div.wclock-cap', { text: 'минуты', style: { margin: '12px 0 9px' } }),
        clockGrid(12, 5, target, setMin)),
      h('div', h('div.wfield-label', { text: 'предупредить' }), leads),
      h('div', h('div.wfield-label', { text: 'чем предупредить' }), modes),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: state.tplEdit === 'new' ? 'Отмена' : 'Удалить',
          disabled: state.busy, onclick: removeTplRow,
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово',
          disabled: state.busy, onclick: saveTplRow,
        })));
  },

  // ── Печать ──
  print() {
    const SCOPES = ['day', 'week', 'month'];
    const scopes = h('div.wwrap');
    add(scopes, ...['Этот день', 'Неделя', 'Месяц'].map((label, i) =>
      sheetChip(label, state.printScope === i, () => set({ printScope: i }))));

    const parts = h('div.wgrid2');
    add(parts, ...PRINT_PARTS.map(name => {
      const on = !state.printOff[name];
      const row = h('button.wplan-item', {
        type: 'button',
        onclick: () => set(x => ({ printOff: { ...x.printOff, [name]: on } })),
      });
      add(row, box(on), h('span', { text: name, style: { flex: '1', font: '400 14px/1.3 var(--ui)' } }));
      return row;
    }));

    const chosen = PRINT_PARTS.filter(name => !state.printOff[name]);

    return h('div.wstack',
      h('div.whint', { text: 'Соберём лист и отдадим в диалог печати браузера — оттуда можно сохранить в PDF.' }),
      scopes, parts,
      h('button.wbtn-wide', {
        type: 'button',
        text: state.busy ? 'Собираю…' : 'Отправить на печать',
        disabled: state.busy || !chosen.length,
        onclick: async () => {
          const scope = SCOPES[state.printScope] ?? 'day';
          state.busy = true; render();
          try {
            // День всегда нужен целиком: в выборке за период есть только
            // расписание, а на листе печатают и задачи, и еду
            const day = store.day?.date === state.date ? store.day : await data.loadDay(state.date);
            const range = scope === 'day' ? null : await data.loadRange(state.date, scope);
            state.busy = false;
            state.modal = null;
            render();
            // Даём кадр на закрытие шторки: печатать поверх затемнения незачем
            requestAnimationFrame(() => printSheet(day, { parts: chosen, scope, range }));
          } catch (e) {
            state.busy = false;
            fail(e);
          }
        },
      }));
  },
};

// ── Выгрузка и загрузка ──────────────────────────────────────

/**
 * Выгрузка. Скачиваем через ссылку с blob, а не переходом по адресу:
 * переход по адресу с сессией открыл бы файл во вкладке, а имя файла
 * пришлось бы вычитывать из заголовка.
 */
async function downloadExport(scope) {
  state.busy = true; state.notice = null; render();
  try {
    const dump = await api.GET('/export');
    const name = scope === 'day' ? `newday-${state.date}.json`
      : scope === 'month' ? `newday-${state.date.slice(0, 7)}.json`
        : 'newday-all.json';

    const blob = new Blob([JSON.stringify(narrow(dump, scope), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    state.busy = false;
    state.modal = null;
    render();
  } catch (e) {
    state.busy = false;
    fail(e);
  }
}

/**
 * День и месяц вырезаются из общей выгрузки по датам: сервер отдаёт всё
 * целиком, а урезать до нужного проще здесь, чем заводить три маршрута.
 * Формат остаётся тем же, поэтому такой файл вливается обратно загрузкой.
 */
function narrow(dump, scope) {
  if (scope !== 'day' && scope !== 'month') return dump;
  const prefix = scope === 'day' ? state.date : state.date.slice(0, 7);
  const inRange = d => String(d ?? '').startsWith(prefix);

  const days = (dump.days ?? []).filter(d => inRange(d.date));
  const keepHabit = new Set();
  const habitLogs = (dump.habitLogs ?? []).filter(l => {
    if (!inRange(l.date)) return false;
    keepHabit.add(l.habit_id);
    return true;
  });

  return {
    ...dump,
    days,
    scheduleItems: (dump.scheduleItems ?? []).filter(r => inRange(r.date)),
    tasks: (dump.tasks ?? []).filter(r => inRange(r.date)),
    meals: (dump.meals ?? []).filter(r => inRange(r.date)),
    sportSets: (dump.sportSets ?? []).filter(r => inRange(r.date)),
    // Привычки без своих отметок в этот период не нужны: они бы приехали
    // пустыми и только засорили список при восстановлении
    habits: (dump.habits ?? []).filter(hb => keepHabit.has(hb.id)),
    habitLogs,
  };
}

// ── Мелочи разбора ───────────────────────────────────────────

/** «23:00», «23.00», «2300» — всё это время. Иначе null. */
function parseHhmm(text) {
  const m = /^(\d{1,2})[:. ]?(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** Загрузка. Читаем файл в браузере: проверить формат надо до отправки. */
async function importFile(file, mode) {
  if (!file) return;
  state.busy = true; state.notice = null; render();
  try {
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('Это не JSON — выберите файл из выгрузки NewDay'); }

    await api.POST('/import', { data: parsed, mode });
    state.busy = false;
    state.modal = null;
    state.notice = mode === 'replace' ? 'Данные заменены' : 'Данные добавлены';
    render();
    await reload();
  } catch (e) {
    state.busy = false;
    fail(e);
  }
}

// ── Помощник ─────────────────────────────────────────────────

const AI_TAG = { schedule: 'расписание', reminder: 'напоминание', task: 'дело' };

const aiMeta = p => {
  const when = p.start ? `${p.start}${p.end ? '–' + p.end : ''}` : 'без времени';
  const day = p.date && p.date !== todayKey() ? adapt.shortDate(p.date) : 'сегодня';
  return `${when} · ${day}`;
};

/**
 * Отправить текст на разбор. `answer` — ответ на уточняющий вопрос: тогда
 * к разговору добавляется предыдущий ход, и модель продолжает с того же
 * места, а не начинает заново.
 */
async function aiSend(answer) {
  const text = state.aiText.trim();
  if (!text) { state.notice = 'Сначала скажите, что нужно сделать'; render(); return; }

  const history = answer === null ? (state.aiHistory ?? []) : [
    ...(state.aiHistory ?? []),
    { role: 'assistant', content: JSON.stringify({ question: state.aiQuestion, options: state.aiOptions }) },
    { role: 'user', content: answer },
  ];

  state.busy = true; state.notice = null; state.aiHistory = history;
  render();

  try {
    const r = await api.POST('/ai/parse', { text, date: state.date, history });
    state.busy = false;
    if (r.question) {
      Object.assign(state, { aiStep: 'ask', aiQuestion: r.question, aiOptions: r.options ?? [] });
      render();
      return;
    }
    if (!r.items?.length) {
      state.aiStep = 'input';
      state.notice = r.unparsed ? `Не понял: ${r.unparsed.slice(0, 120)}` : 'Ничего не нашлось — скажите иначе';
      render();
      return;
    }
    Object.assign(state, { aiStep: 'plan', aiItems: r.items, aiOff: {} });
    render();
  } catch (e) {
    state.busy = false;
    state.aiStep = 'input';
    fail(e);
  }
}

/** Записать выбранное. По запросу на пункт — их единицы, пакетного нет. */
async function aiApply(items) {
  state.busy = true; render();
  let ok = 0;
  try {
    for (const it of items) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : state.date;
      const start = toMin(it.start);
      if (it.kind === 'task' || (it.kind === 'reminder' && start === null)) {
        await data.createTask(date, adapt.taskToServer({ title: it.title, cat: it.category === 'work' ? 'work' : 'home' }));
      } else {
        await data.createRow(date, adapt.rowToServer({
          title: it.title, start: start ?? 0,
          end: it.kind === 'reminder' ? null : toMin(it.end),
          alarm: it.alarm ?? 'notify', lead: 'at',
        }));
      }
      ok += 1;
    }
    state.busy = false;
    state.modal = null;
    await reload();
  } catch (e) {
    state.busy = false;
    fail(ok ? `Добавлено ${ok} из ${items.length}: ${e.message}` : e.message);
  }
}

const toMin = t => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : null;
};

/** Диктовка: пишем с микрофона и отправляем на распознавание. */
async function dictate() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    state.notice = 'Этот браузер не умеет записывать звук'; render(); return;
  }
  if (state.recorder) { state.recorder.stop(); return; }

  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { state.notice = 'Не дали доступ к микрофону'; render(); return; }

  const chunks = [];
  const rec = new MediaRecorder(stream);
  state.recorder = rec;
  state.aiStep = 'listening';
  render();

  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    state.recorder = null;
    state.aiStep = 'input';
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    if (blob.size < 1200) { state.notice = 'Слишком коротко — попробуйте ещё раз'; render(); return; }
    state.notice = 'Распознаю…';
    render();
    try {
      const form = new FormData();
      form.append('file', blob, 'zapis.webm');
      form.append('language', 'ru');
      const r = await api.postForm('/ai/transcribe', form);
      state.aiText = state.aiText ? `${state.aiText} ${r.text}` : r.text;
      state.notice = null;
    } catch (e) { state.notice = e.message; }
    render();
  };
  rec.start();
}

// ── Сборка ───────────────────────────────────────────────────

const SCREENS = {
  today: todayScreen, plan: planScreen, habits: habitsScreen,
  notes: notesScreen, settings: settingsScreen,
};

function render() {
  const root = $('#wapp');
  if (!root) return;

  // Тема: переменные ставим на корень, чтобы CSS остался без вариантов
  const vars = { ...(dark() ? DARK : LIGHT) };
  vars['--accent'] = accent();
  vars['--accent-soft'] = soft();
  vars['--accent-line'] = `color-mix(in srgb, ${accent()} 40%, transparent)`;
  root.dataset.theme = dark() ? 'dark' : 'light';
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.zoom = String(state.scale);

  replace(root,
    sideBar(),
    h('div.wmain', topBar(), h('div.wbody.wscroll',
      // Отказ сервера виден на экране, а не только в консоли
      state.notice && !state.modal ? h('div.wnotice', { text: state.notice }) : null,
      SCREENS[state.screen]())),
    modal());
}

/*
 * Дата в хвосте адреса. Нажатие на уведомление в уже открытой вкладке
 * меняет только хвост — страница при этом не перезагружается, и без этого
 * обработчика человек попадал бы на сегодняшний день вместо того, о котором
 * его позвали.
 */
const askedDate = () => /^#(\d{4}-\d{2}-\d{2})$/.exec(location.hash)?.[1];
addEventListener('hashchange', () => {
  const asked = askedDate();
  if (asked && asked !== state.date) go(asked);
});

// Escape закрывает шторку — привычнее, чем искать крестик
addEventListener('keydown', e => { if (e.key === 'Escape' && state.modal) closeModal(); });
/*
 * Отпустили мышь — где бы это ни случилось. Слушаем на окне, потому что
 * человек часто уводит курсор за край колонки, а блок всё равно должен
 * создаться: иначе протягивание вниз до конца дня обрывается ничем.
 */
addEventListener('mouseup', () => {
  if (!dragging) return;
  const { from, to, date } = dragging;
  dragging.sel.remove();
  dragging = null;
  const a = Math.min(from, to);
  const b = Math.max(a + SNAP, Math.max(from, to));
  newRow({ date, start: a, end: b });
});

/*
 * Запуск. Сначала настройки — от них зависят и тема, и сегодняшняя дата в
 * часовом поясе человека; рисовать до этого значит мигнуть чужой темой.
 */
async function bootstrap() {
  api.setUnauthorizedHandler(() => {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
  });

  try {
    const settings = await data.boot();
    // Из уведомления приходят с датой в хвосте адреса: «/web.html#2026-08-12».
    // Открыть при этом сегодняшний день значит показать не то, о чём звали
    state.date = askedDate() ?? settings.today;
    state.theme = settings.theme ?? 'dark';
    state.color = settings.settings?.accent ?? 'violet';
    state.scale = settings.settings?.scale ?? 1;
    state.sound = settings.settings?.sound ?? 'Рассвет';
    state.notifySound = settings.settings?.notifySound ?? 'Капля';
    if (settings.scheduleView === 'grid') state.view = 'week';
  } catch (e) {
    // Не вошли — обработчик выше уже увёл на страницу входа
    if (e?.status !== 401) {
      replace($('#wapp'), h('div.wboot', { text: `Не удалось загрузить: ${e.message}` }));
    }
    return;
  }

  render();
  await reload();
}

bootstrap();
