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
  DARK, LIGHT, PALETTE, ALARM, LEADS, CATS, NAV, MONTHS, MONTHS_NOM, DOW_LONG, DOW_SHORT,
  SOUNDS, REPEATS, PRINT_PARTS, HABIT_EMOJI,
} from './data.js';
import * as adapt from './adapt.js';
import * as data from './store.js';
import { store } from './store.js';
import * as api from '../api.js';
import { printSheet } from './sheet.js';
import { renderEmojiPicker } from '../emoji.js';

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
  rowId: null, rowStart: null, rowEnd: null, rowField: 'start', rowTitle: '', rowAlarm: 'off', rowLeads: ['at'],
  rowKind: 'normal', rowColor: null, rowConflict: 'overlap',
  taskId: null, taskTitle: '', taskCat: 'work',
  mealId: null, mealTitle: '', mealKcal: '', mealMode: 'none', mealDur: 30, mealSched: false,
  mealStart: 720, mealEnd: 840, mealLeads: ['at'], mealSchedId: null, mealConflict: 'overlap',
  sportId: null, sportTitle: '', sportSets: '', sportReps: '', sportWeight: '',
  noteId: null, noteTitle: '', noteText: '', noteDated: true, noteDate: '',
  remId: null, remRepeat: 'Разово', remTitle: '', remDate: '', remTime: '10:00', remLeads: ['at'],
  remAlarm: 'notify', remSeriesId: null,
  remDays: { 0: false, 1: false, 2: false, 3: false, 4: false, 5: false, 6: false },
  fileKind: 'export', sound: 'Рассвет', notifySound: 'Капля', soundKind: 'Звук будильника',
  tplRows: null, tplEdit: null, tplStart: 420, tplEnd: 480, tplField: 'start',
  tplTitle: '', tplAlarm: 'off', tplLeads: ['at'],
  quietFrom: '23:00', quietTo: '07:00',
  habitId: null, habitKind: 'do', habitEmoji: '💧', habitGoal: 30, habitGoalCustom: false,
  habitTitle: '', habitTimes: 5, habitPlan: 'days', habitGoalDays: 730, habitPicker: false,
  habitDays: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: false, 6: false },
  aiStep: 'input', aiText: '', aiOff: {},
  calY: 0, calM: 0, calFor: 'day', calBack: null,
  printScope: 0, printOff: {},
  statsDays: 30,
  accName: '', passOld: '', passNew: '', passNew2: '',
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

/**
 * Правка внутри шторки перерисовывает только шторку.
 *
 * Раньше любое нажатие в шторке шло через `set`, а он перестраивает весь
 * экран — боковое меню, шапку, сетку дня. На глаз это выглядело как
 * перезагрузка страницы: шторка мигала на каждом нажатии «начало · длится ·
 * конец», а поле ввода теряло курсор посреди набора.
 *
 * Курсор возвращаем по имени поля: без этого набор в «своё: N минут»
 * обрывался бы на первой цифре.
 */
const setIn = patch => {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  const body = $('.wmodal-body');
  if (!body || !state.modal) { render(); return; }

  const live = document.activeElement;
  const name = live && body.contains(live) ? live.getAttribute('name') : null;
  const caret = name && live.selectionStart !== undefined
    ? [live.selectionStart, live.selectionEnd] : null;

  replace(body, ...modalBody());

  if (!name) return;
  const again = body.querySelector(`[name="${name}"]`);
  if (!again) return;
  again.focus();
  if (caret && again.setSelectionRange) {
    try { again.setSelectionRange(caret[0], caret[1]); } catch { /* не текстовое поле */ }
  }
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

/**
 * Стрелки листают то, что показано.
 *
 * На «Расписании» это выбранный период: день — днями, неделя — неделями,
 * месяц — месяцами; на остальных экранах показан день, и листаются дни.
 * Так же ведут себя календари, и без этого лист месяца приходилось бы
 * пролистывать по одному дню тридцать раз.
 */
function shiftPeriod(n) {
  const step = state.screen === 'plan' ? state.view : 'day';
  if (step === 'week') return shiftDay(n * 7);
  if (step !== 'month') return shiftDay(n);

  // Прибавление месяца к 31-му числу даёт следующий-следующий месяц —
  // поэтому день прижимаем к длине месяца, в который переходим
  const cur = dayOf();
  const first = new Date(cur.getFullYear(), cur.getMonth() + n, 1);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(cur.getDate(), days));
  return go(keyOf(first));
}

/** Что за период сейчас на экране — этим подписана шапка. */
function periodLabel() {
  const cur = dayOf();
  if (state.screen !== 'plan' || state.view === 'day') {
    return { top: DOW_LONG[cur.getDay()], main: `${cur.getDate()} ${MONTHS[cur.getMonth()]}` };
  }
  if (state.view === 'month') {
    return { top: 'месяц', main: `${MONTHS_NOM[cur.getMonth()]} ${cur.getFullYear()}` };
  }
  const mon = mondayOf(cur);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const sameMonth = mon.getMonth() === sun.getMonth();
  return {
    top: 'неделя',
    main: sameMonth
      ? `${mon.getDate()}–${sun.getDate()} ${MONTHS[mon.getMonth()]}`
      : `${mon.getDate()} ${MONTHS[mon.getMonth()]} – ${sun.getDate()} ${MONTHS[sun.getMonth()]}`,
  };
}

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
 * Переключение срока предупреждения. «Вовремя» и «за сколько-то» —
 * взаимоисключающие: выбрал «вовремя» — остальные снимаются, выбрал срок —
 * «вовремя» уходит. Пустым набор не остаётся: пусто и есть «вовремя».
 */
function toggleLead(list, k) {
  if (k === 'at') return ['at'];
  const next = list.filter(x => x !== 'at' && x !== k);
  if (!list.includes(k)) next.push(k);
  return next.length ? next : ['at'];
}

/**
 * Отметка. Уходит на сервер сразу, на экране применяется не дожидаясь
 * ответа: галочка, которая ставится через полсекунды, ощущается сломанной.
 */
function toggle(r, kind) {
  const next = !isDone(r);
  const send = kind === 'task' ? data.toggleTask
    : kind === 'meal' ? data.toggleMeal
      : kind === 'habit' ? data.toggleHabit
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
    // Правила повторов: по ним редактор напоминания понимает, повтор это или разовое
    if (needsDay || needsRange) jobs.push(data.loadSeries().catch(() => []));
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

  const period = periodLabel();
  const what = state.screen === 'plan' && state.view !== 'day'
    ? (state.view === 'month' ? 'месяц' : 'неделю')
    : 'день';

  const cal = h('button.wbtn-ghost', { type: 'button', onclick: openCalendar });
  add(cal, ico('calendar-blank', '16px'), h('span', { text: 'Календарь' }));

  return h('div.wtop',
    h('div.wtop-date',
      h('div.wtop-dow', { text: period.top }),
      h('div.wtop-num', { text: period.main })),
    h('div.wtop-nav',
      chip('Сегодня', state.date === todayKey(), () => go(todayKey())),
      cal),
    /*
     * Стрелки по бокам полоски недель, а не обе слева: листают они именно её —
     * и на месяце листают месяц, поэтому стоят там, где человек ждёт.
     */
    h('div.wtop-strip',
      iconBtn('caret-left', { title: `Предыдущий ${what}`, onclick: () => shiftPeriod(-1) }),
      days,
      iconBtn('caret-right', { title: `Следующий ${what}`, onclick: () => shiftPeriod(1) })),
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
      style: r.color ? { '--pin': PALETTE[r.color][dark() ? 'dark' : 'light'] } : {},
      onclick: () => openRow(r),
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
    const row = h('button.wmeal', { type: 'button', onclick: () => openMeal(m) });
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
    onclick: () => openMeal(null),
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
        iconBtn('dots-three-vertical', {
          title: 'Настроить привычку', cls: 'whabit-more', size: '16px',
          onclick: e => { e.stopPropagation(); openHabit(hb); },
        })));
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
      onclick: () => openNote(null),
    });
    add(empty,
      h('div.wdaynote-title', { text: 'Заметок нет' }),
      h('div.wdaynote-text', { text: 'Сюда идёт то, что не влезает в задачу' }));
    return add(wrap, empty);
  }

  add(wrap, ...mine.map(n => {
    const card = h('div.wdaynote', {
      onclick: () => openNote(n),
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
        ...(r.color ? { '--pin': PALETTE[r.color][dark() ? 'dark' : 'light'] } : {}),
        ...(of > 1
          ? { left: `calc(${i * step}% + 3px)`, width: `calc(${step}% - 6px)`, right: 'auto' }
          : {}),
      },
      onclick: e => { e.stopPropagation(); openRow(r, dateKey); },
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

/**
 * Клетки месяца с хвостами соседних.
 *
 * Хвосты считаем по их собственным месяцам, а не по текущему: иначе клетка
 * «5 сентября» брала данные пятого августа — и это было видно на снимке,
 * одни и те же дела в двух местах сетки.
 */
function monthCells(y, m) {
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const dim = new Date(y, m + 1, 0).getDate();
  const prevDim = new Date(y, m, 0).getDate();

  const cells = [];
  for (let i = lead - 1; i >= 0; i--) cells.push({ n: prevDim - i, out: true, dt: new Date(y, m - 1, prevDim - i) });
  for (let n = 1; n <= dim; n++) cells.push({ n, out: false, dt: new Date(y, m, n) });
  let tail = 1;
  while (cells.length % 7) { cells.push({ n: tail, out: true, dt: new Date(y, m + 1, tail) }); tail += 1; }
  return cells;
}

/** Сколько строк дня влезает в клетку месяца, не сминая её. */
const MONTH_FIT = 3;

function monthGrid() {
  const cur = dayOf();
  const y = cur.getFullYear(), m = cur.getMonth();

  const head = h('div.wmonth-head');
  add(head, ...DOW_SHORT.map(d => h('span', { text: d })));

  const grid = h('div.wmonth');
  add(grid, ...monthCells(y, m).map(c => {
    const key = keyOf(c.dt);
    const sel = !c.out && key === state.date;
    const rows = rowsForDate(key).slice().sort((a, b) => a.start - b.start);

    /*
     * Клетка — не кнопка: внутри неё свои нажатия. Число открывает день,
     * строка — свой блок, пустое место создаёт новый. Так же ведут себя
     * календари, и это единственный способ добавить дело, не уходя с месяца.
     */
    const cell = h('div.wcell', {
      class: [c.out ? 'out' : '', sel ? 'on' : ''].filter(Boolean).join(' '),
      // дата в разметке: по ней проверки сверяют клетку с тем, что на сервере
      'data-date': key,
      title: 'Нажмите на пустое место, чтобы добавить',
      onclick: () => { if (!c.out) newRow({ date: key, start: 600, end: 660 }); },
    });

    const items = h('div.wcell-items');
    add(items, ...rows.slice(0, MONTH_FIT).map(r => {
      const line = h('button.wcell-item', {
        type: 'button',
        class: r.isReminder ? 'rem' : '',
        style: r.color ? { '--pin': PALETTE[r.color][dark() ? 'dark' : 'light'] } : {},
        onclick: e => { e.stopPropagation(); openRow(r, key); },
      });
      add(line,
        h('i.wcell-pin'),
        h('span.wcell-time', { text: hhmm(r.start) }),
        h('span.wcell-name', { text: r.title }));
      return line;
    }));

    // Сколько не влезло — сказано прямо: иначе человек считает, что это всё
    const rest = rows.length - MONTH_FIT;
    if (rest > 0) {
      add(items, h('button.wcell-more', {
        type: 'button',
        text: `+ ещё ${rest}`,
        onclick: e => { e.stopPropagation(); set({ date: key, view: 'day' }); reload(); },
      }));
    }

    add(cell,
      h('div.wcell-hd',
        h('button.wcell-num', {
          type: 'button', text: String(c.n), title: 'Открыть день',
          onclick: e => { e.stopPropagation(); if (!c.out) { set({ date: key, view: 'day' }); reload(); } },
        }),
        h('span', { style: { flex: '1' } }),
        rows.length ? h('span.wcell-count', { text: String(rows.length) }) : null),
      items);
    return cell;
  }));

  return h('div', head, grid);
}

// ── Привычки, заметки, настройки ─────────────────────────────

function habitsScreen() {
  const addBtn = h('button.wbtn', { type: 'button', onclick: () => openHabit(null) });
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
    onclick: () => openNote(null),
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
      onclick: () => openNote(n),
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

  /*
   * Аккаунт. В эталоне веб-версии этой панели нет, но в описании функционала
   * она есть, и без неё имя и пароль поменять нечем — а человек про них
   * спросил прямо.
   */
  const account = h('div.wpanel-list', cap('аккаунт'));
  const accountRow = h('button.wrow-link', { type: 'button', onclick: openAccount });
  add(accountRow, ico('user', '17px'), h('span', { text: userName() }),
    h('span.wrow-link-val', { text: store.user?.email ?? '' }), ico('caret-right', '14px'));
  add(account, accountRow);

  return h('div',
    h('div.whead-title', { text: 'Настройки', style: { marginBottom: '18px' } }),
    h('div.wsettings', account, look, day, dataPanel, devices));
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

// ── Аккаунт ──────────────────────────────────────────────────

function openAccount() {
  set({
    modal: 'account', notice: null,
    accName: store.settings?.displayName ?? '',
    passOld: '', passNew: '', passNew2: '',
  });
}

function saveName() {
  const name = String(state.accName ?? '').trim();
  act(api.saveSettings({ displayName: name }).then(() => data.boot()), 'Имя сохранено');
}

/**
 * Смена пароля. Второе поле — не формальность: опечатка в новом пароле
 * запирает человека снаружи, и заметит он это уже при следующем входе.
 */
function savePassword() {
  if (state.passNew.length < 8) { setIn({ notice: 'Новый пароль — не короче восьми знаков' }); return; }
  if (state.passNew !== state.passNew2) { setIn({ notice: 'Пароли не совпали' }); return; }
  act(
    api.POST('/auth/password', { currentPassword: state.passOld, newPassword: state.passNew })
      .then(() => set({ passOld: '', passNew: '', passNew2: '' })),
    'Пароль изменён',
  );
}

// ── Шторки ───────────────────────────────────────────────────

/**
 * Календарь открываем на месяце того дня, который правим — искать его не нужно.
 *
 * `calFor` говорит, чью дату выбираем: открытого дня, заметки или напоминания.
 * Без этого выбор даты в заметке уводил бы весь экран на другой день.
 */
function openCalendar(target = 'day') {
  const base = target === 'note' ? (state.noteDate ?? state.date)
    : target === 'reminder' ? (fromRuDate(state.remDate) ?? state.date)
      : state.date;
  const [y, m] = base.split('-').map(Number);
  set({ modal: 'calendar', calY: y, calM: m - 1, calFor: target, calBack: state.modal });
}

/** Выбранный день уходит туда, откуда календарь позвали. */
function pickDate(key) {
  if (state.calFor === 'note') { set({ modal: state.calBack, noteDate: key }); return; }
  if (state.calFor === 'reminder') { set({ modal: state.calBack, remDate: RU_DATE(key) }); return; }
  closeModal();
  go(key);
}

const shiftCal = n => ({
  calY: state.calM + n < 0 ? state.calY - 1 : state.calM + n > 11 ? state.calY + 1 : state.calY,
  calM: (state.calM + n + 12) % 12,
});

function openRow(r, date = state.date) {
  set({
    modal: 'row', rowId: r.id, rowDate: date,
    rowStart: r.start, rowEnd: r.end ?? r.start + 30, rowField: 'start',
    rowTitle: r.title, rowAlarm: r.alarm, rowLeads: leadsOf(r),
    rowKind: r.isReminder ? 'reminder' : (r.kind ?? 'normal'),
    rowColor: r.color ?? null, rowConflict: 'overlap', notice: null,
  });
}

/** Новый блок: время либо протянутое, либо предложенное кнопкой. */
function newRow({ date = state.date, start = 600, end = 660, kind = 'normal' } = {}) {
  set({
    modal: 'row', rowId: 'new', rowDate: date,
    rowStart: start, rowEnd: end, rowField: 'start',
    rowTitle: '', rowAlarm: kind === 'reminder' ? 'notify' : 'off', rowLeads: ['at'],
    rowKind: kind, rowColor: null, rowConflict: 'overlap', notice: null,
  });
}

/**
 * Сохранить строку. Новую создаём, существующую правим; если конец режет
 * соседний блок — сначала расходимся выбранным способом, иначе «сдвинуть
 * следующие» применилось бы к ещё не сдвинутому расписанию.
 */
function saveRow() {
  const body = adapt.rowToServer({
    title: state.rowTitle, start: state.rowStart, end: state.rowEnd,
    alarm: state.rowAlarm, leads: state.rowLeads,
    color: state.rowColor, kind: state.rowKind,
  });
  if (!body.title) {
    setIn({ notice: state.rowKind === 'reminder' ? 'Впишите, о чём напомнить' : 'Впишите, что делаем' });
    return;
  }

  const date = state.rowDate ?? state.date;
  const other = state.rowKind === 'reminder' ? null : crossing();
  const way = other ? state.rowConflict : 'overlap';

  busy(applyConflict(date, other, way, body.endMin).then(() => (state.rowId === 'new'
    ? data.createRow(date, body)
    : data.updateRow(date, state.rowId, body))));
}

// ── Привычка ─────────────────────────────────────────────────

/**
 * Открыть привычку. Маска дней недели — биты, понедельник младший; полная
 * маска (все семь) значит «каждый день», и тогда график читается как дни.
 */
function openHabit(hb) {
  const raw = hb?.raw ?? null;
  const mask = raw?.scheduleMask ?? 127;
  const target = raw?.challenge?.target ?? raw?.challengeTargetDays ?? 0;
  const preset = [30, 100].includes(target) ? target : (target ? -1 : 0);
  set({
    modal: 'habit', habitId: hb?.id ?? 'new', notice: null,
    habitTitle: hb?.title ?? '',
    habitEmoji: hb?.emoji && hb.emoji !== '•' ? hb.emoji : '💧',
    habitKind: raw?.polarity === 'avoid' ? 'avoid' : 'do',
    habitPlan: raw?.timesPerWeek ? 'times' : 'days',
    habitTimes: raw?.timesPerWeek ?? 5,
    habitDays: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, Boolean(mask & (1 << i))])),
    habitGoal: preset,
    habitGoalCustom: preset === -1,
    habitGoalDays: target || 730,
    habitPicker: false,
  });
}

function saveHabit() {
  const title = state.habitTitle.trim();
  if (!title) { setIn({ notice: 'Впишите название' }); return; }

  const mask = Object.entries(state.habitDays)
    .reduce((acc, [i, on]) => (on ? acc | (1 << Number(i)) : acc), 0);
  const target = state.habitGoal === -1 ? state.habitGoalDays : state.habitGoal;

  const body = {
    title, emoji: state.habitEmoji,
    polarity: state.habitKind === 'avoid' ? 'avoid' : 'do',
    /*
     * «N раз в неделю» — свободный график: конкретные дни не заданы, поэтому
     * активна привычка каждый день, а норму держит счёт за неделю.
     */
    scheduleMask: state.habitPlan === 'times' ? 127 : (mask || 127),
    timesPerWeek: state.habitPlan === 'times' ? state.habitTimes : null,
    mode: target > 0 ? 'challenge' : 'ongoing',
    ...(target > 0 ? { challengeTargetDays: target } : {}),
  };

  busy(state.habitId === 'new' ? data.createHabit(body) : data.updateHabit(state.habitId, body));
}

// ── Приём пищи ───────────────────────────────────────────────

/**
 * Приём пищи. Режим времени восстанавливаем из самих времён — отдельного
 * поля нет, и это нарочно: два источника правды однажды разошлись бы.
 */
function openMeal(m) {
  const mode = m?.mode ?? 'none';
  const start = m?.start ?? 12 * 60;
  set({
    modal: 'meal', mealId: m?.id ?? 'new', notice: null,
    mealTitle: m?.title === 'Без названия' ? '' : (m?.title ?? ''),
    mealKcal: m?.kcal === null || m?.kcal === undefined ? '' : String(m.kcal),
    mealMode: mode,
    mealStart: start,
    mealEnd: m?.end ?? start + 120,
    mealDur: m?.raw?.schedule_item_id && m?.mode === 'exact' ? state.mealDur : 30,
    mealLeads: m ? m.leads : ['at'],
    mealSched: Boolean(m?.scheduled),
    mealSchedId: m?.raw?.schedule_item_id ?? null,
    mealConflict: 'overlap',
  });
}

const mealConflictBlock = () => {
  const end = state.mealStart + state.mealDur;
  const other = crossingIn(state.date, state.mealStart, end, state.mealSchedId);
  return other ? conflictCard(other, end, state.mealConflict, k => setIn({ mealConflict: k })) : null;
};

/**
 * Сохранение приёма пищи вместе с его блоком в расписании.
 *
 * Раньше «Добавить в расписание» был нарисован, но ничего не делал: сам приём
 * писался, а блока не появлялось. Ссылка `schedule_item_id` нужна в обе
 * стороны — иначе выключенный переключатель оставлял бы в расписании блок,
 * которому больше нечего означать.
 */
function saveMeal() {
  const body = adapt.mealToServer({
    title: state.mealTitle, mode: state.mealMode,
    start: state.mealStart, end: state.mealEnd,
    kcal: state.mealKcal, leads: state.mealLeads,
  });
  if (!body.title) { setIn({ notice: 'Впишите, что едим' }); return; }

  const date = state.date;
  const wantBlock = state.mealMode === 'exact' && state.mealSched;
  const end = state.mealStart + state.mealDur;
  const blockBody = {
    title: body.title, startMin: state.mealStart, endMin: end, kind: 'meal',
    ...(state.mealLeads.length ? { remindBefore: adapt.leadMinutes(state.mealLeads) } : {}),
  };

  const job = (async () => {
    const other = wantBlock ? crossingIn(date, state.mealStart, end, state.mealSchedId) : null;
    await applyConflict(date, other, state.mealConflict, end);

    const meal = state.mealId === 'new'
      ? await data.createMeal(date, body)
      : await data.updateMeal(date, state.mealId, body);
    const mealId = meal?.id ?? state.mealId;

    if (wantBlock && state.mealSchedId) {
      await data.updateRow(date, state.mealSchedId, blockBody);
    } else if (wantBlock) {
      const block = await data.createRow(date, blockBody);
      if (block?.id) await data.updateMeal(date, mealId, { scheduleItemId: block.id });
    } else if (state.mealSchedId) {
      await data.removeRow(date, state.mealSchedId);
      await data.updateMeal(date, mealId, { scheduleItemId: null });
    }
  })();

  busy(job);
}

/** Удаление приёма забирает и его блок: иначе в расписании останется сирота. */
function deleteMeal() {
  if (state.mealId === 'new') { closeModal(); return; }
  const date = state.date;
  busy((async () => {
    if (state.mealSchedId) await data.removeRow(date, state.mealSchedId);
    await data.removeMeal(date, state.mealId);
  })());
}

function deleteRow() {
  if (state.rowId === 'new') { closeModal(); return; }
  busy(data.removeRow(state.rowDate ?? state.date, state.rowId));
}

/**
 * Заметка. Заголовок и текст на экране разные поля, а в дне это один
 * текст: первая строка — заголовок. Разделяем при открытии, склеиваем
 * при сохранении.
 */
function openNote(n) {
  set({
    modal: 'note',
    noteId: n?.id ?? 'new',
    noteTitle: n?.raw?.title ?? '',
    noteText: n?.text ?? '',
    // новая заметка по умолчанию на открытый день: чаще всего пишут про него
    noteDated: n ? n.dated : true,
    noteDate: n?.dateKey ?? state.date,
    notice: null,
  });
}

/**
 * Заметка сохраняется туда, где ей место по её же дате: с датой — в день,
 * без даты — в свой список. Смена типа переносит её: иначе заметка осталась
 * бы в прежнем хранилище и показалась дважды.
 */
function saveNote() {
  const title = String(state.noteTitle ?? '').trim();
  const text = String(state.noteText ?? '');
  if (!title && !text.trim()) { setIn({ notice: 'Заметка пустая' }); return; }

  const wasDated = typeof state.noteId === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.noteId);
  const wasFree = state.noteId !== 'new' && !wasDated;
  const date = state.noteDate ?? state.date;

  busy((async () => {
    if (state.noteDated) {
      if (wasFree) await data.removeFreeNote(state.noteId);
      // при переносе на другой день прежний освобождаем: заметка одна на день
      if (wasDated && state.noteId !== date) await data.saveDayNote(state.noteId, '');
      await data.saveDayNote(date, [title, text].filter(Boolean).join('\n'));
      return;
    }
    if (wasDated) await data.saveDayNote(state.noteId, '');
    if (wasFree) { await data.updateFreeNote(state.noteId, { title, text }); return; }
    await data.createFreeNote({ title, text });
  })());
}

function deleteNote() {
  if (state.noteId === 'new') { closeModal(); return; }
  const isDated = /^\d{4}-\d{2}-\d{2}$/.test(String(state.noteId));
  busy(isDated ? data.saveDayNote(state.noteId, '') : data.removeFreeNote(state.noteId));
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

const REPEAT_OF = Object.fromEntries(Object.entries(FREQ_OF).map(([k, v]) => [v, k]));

function openReminder(row) {
  const r = row?.raw ?? row ?? null;
  const seriesId = r?.series_id ?? null;
  const rule = seriesId ? (store.series ?? []).find(s => s.id === seriesId) : null;
  const mask = rule?.byweekday ?? 0;
  return set({
    modal: 'reminder',
    remId: row?.id ?? 'new',
    remTitle: row?.title ?? '',
    remDate: RU_DATE(state.date),
    remTime: hhmm(r?.start_min ?? row?.start ?? 600),
    remLeads: row ? leadsOf(row.raw ? row : adapt.scheduleRow(r, { isToday: false, minutes: 0 })) : ['at'],
    remAlarm: row?.alarm ?? 'notify',
    remRepeat: rule ? (REPEAT_OF[rule.freq] ?? 'Разово') : 'Разово',
    remSeriesId: seriesId,
    // дни недели для еженедельного повтора: пусто значит «в тот же день недели»
    remDays: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, Boolean(mask & (1 << i))])),
    notice: null,
  });
}

function saveReminder() {
  const title = String(state.remTitle ?? '').trim();
  if (!title) { setIn({ notice: 'О чём напомнить?' }); return; }
  const date = fromRuDate(state.remDate);
  if (!date) { setIn({ notice: 'Дата пишется как 05.08.2026' }); return; }
  const startMin = parseHhmm(state.remTime);
  if (startMin === null) { setIn({ notice: 'Время пишется как 10:00' }); return; }

  const body = adapt.rowToServer({
    title, start: startMin, end: null, kind: 'reminder',
    alarm: state.remAlarm, leads: state.remLeads,
  });
  const freq = FREQ_OF[state.remRepeat];
  const mask = Object.entries(state.remDays)
    .reduce((acc, [i, on]) => (on ? acc | (1 << Number(i)) : acc), 0);
  // дни недели имеют смысл только у еженедельного: у остальных период задан иначе
  const byweekday = freq === 'weekly' && mask ? mask : undefined;

  const job = state.remId === 'new'
    ? (freq
      ? data.createRepeat({ freq, startDate: date, row: body, byweekday })
      : data.createRow(date, body))
    : data.updateRow(date, state.remId, body);
  busy(job);
}

/**
 * Удаление напоминания. У повтора это три разных желания, и путать их нельзя:
 * убрать только этот день, прекратить с этого дня и дальше, убрать весь
 * повтор вместе с историей.
 */
function removeReminder(scope) {
  if (state.remId === 'new') { closeModal(); return; }
  const date = state.date;
  if (scope === 'series') { busy(data.removeSeries(state.remSeriesId)); return; }
  if (scope === 'from') { busy(data.endSeries(state.remSeriesId, date)); return; }
  busy(data.removeRow(date, state.remId));
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
    tplLeads: r?.leads ?? ['at'],
  });
}

function saveTplRow() {
  const title = String(state.tplTitle ?? '').trim();
  if (!title) { note('Впишите, что делаем'); return; }
  const rows = [...(state.tplRows ?? [])];
  const row = {
    start: state.tplStart, end: state.tplEnd, title,
    alarm: state.tplAlarm, leads: state.tplLeads,
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
  calendar: () => 'Выбор дня',
  account: () => 'Аккаунт',
  sound: () => state.soundKind,
  template: () => 'Общее расписание',
  tplRow: () => 'Строка шаблона',
  file: () => (state.fileKind === 'import' ? 'Импорт данных' : 'Экспорт данных'),
  print: () => 'Печать дня',
};

const WIDE = new Set(['ai', 'schedule', 'note', 'habit']);

/*
 * Содержимое шторки отдельно от её рамки: `setIn` меняет только его, и
 * заголовок с крестиком при этом не пересоздаются.
 */
const modalBody = () => [
  // Отказ, случившийся в шторке, виден в ней же: на экране под затемнением
  // его никто не прочитает — а «Готово» без названия молчала бы совсем
  state.notice ? h('div.wnotice', { text: state.notice }) : null,
  BODIES[state.modal]?.() ?? h('div'),
];

function modal() {
  if (!state.modal) return null;

  const card = h('div.wmodal', {
    class: WIDE.has(state.modal) ? 'wide' : '',
    role: 'dialog', 'aria-modal': 'true',
    onclick: e => e.stopPropagation(),
  },
    h('div.wmodal-hd',
      h('b', { text: TITLES[state.modal]?.() ?? '' }),
      iconBtn('x', { title: 'Закрыть', onclick: closeModal, cls: 'wmodal-x' })),
    h('div.wmodal-body', ...modalBody()));

  return h('div.wveil', { onclick: closeModal }, card);
}

/** Две кнопки внизу шторки: слева тихая, справа главная. */
const footer = (quiet, main, onMain = closeModal) =>
  h('div.wrow-end',
    h('button.wbtn-quiet', { type: 'button', text: quiet, onclick: closeModal }),
    h('button.wbtn-wide', { type: 'button', text: main, onclick: onMain }));

/** Готовые длительности: от четверти часа до четырёх — как в эталоне. */
const DURS = [15, 30, 45, 60, 90, 120, 180, 240];

const durLabel = min => {
  const hrs = Math.floor(min / 60);
  const mins = min % 60;
  return (hrs ? `${hrs} ч` : '') + (hrs && mins ? ' ' : '') + (mins ? `${mins} мин` : (hrs ? '' : '0 мин'));
};

/**
 * «Длится» — это длительность, а не время.
 *
 * Раньше плитка «длится» открывала ту же сетку часов, что и «начало», и
 * нажатие на час меняло начало: выбрать длительность было нечем. Здесь
 * готовые значения и своё число минут, а конец считается сам.
 */
function durPicker(rs, dur) {
  const chips = h('div.wwrap');
  add(chips, ...DURS.map(v => sheetChip(durLabel(v), dur === v,
    () => setIn({ rowEnd: Math.min(1439, rs + v) }), 'wchip-dur')));

  return h('div.wclock',
    h('div.wclock-cap', { text: 'конец посчитается сам' }),
    chips,
    h('div.wrow', { style: { marginTop: '12px' } },
      h('span.wclock-cap', { text: 'своё:', style: { margin: '0' } }),
      h('input.wnum', {
        name: 'rowDur', value: String(dur), inputMode: 'numeric',
        oninput: e => {
          const n = Number(String(e.target.value).replace(/\D+/g, ''));
          // пустое поле — ещё не значение: человек стирает, чтобы вписать другое
          if (!n) return;
          setIn({ rowEnd: Math.min(1439, rs + n) });
        },
      }),
      h('span.wclock-cap', { text: 'минут', style: { margin: '0' } })));
}

/**
 * С чем пересекается новый конец. Вложение пересечением не считается:
 * созвон внутри рабочего блока — обычное дело, эталон рисует его склеенной
 * карточкой. Пересечение — это когда конец режет соседний блок пополам.
 */
function crossingIn(date, start, end, skipId) {
  return rowsForDate(date)
    .filter(r => r.id !== skipId && r.end !== null && !r.isReminder)
    .filter(r => r.start >= start && r.start < end && r.end > end)
    .sort((a, b) => a.start - b.start)[0] ?? null;
}

const crossing = () => (state.rowKind === 'reminder' ? null : crossingIn(
  state.rowDate ?? state.date, state.rowStart ?? 0, state.rowEnd ?? 0, state.rowId));

/**
 * Пересечение показываем, но сами ничего не двигаем: способ расхождения
 * выбирает человек, и применяется он при сохранении.
 */
function conflictCard(other, end, current, pick) {
  const ways = [
    { k: 'shift', label: 'Сдвинуть следующие', icon: 'arrows-down-up' },
    // сократить можно только то, от чего что-то останется
    ...(other.end > end + 5 ? [{ k: 'trim', label: 'Сократить следующее', icon: 'arrows-in-line-vertical' }] : []),
    { k: 'overlap', label: 'Оставить внахлёст', icon: 'stack-simple' },
  ];

  const list = h('div.wstack-tight', { style: { marginTop: '11px' } });
  add(list, ...ways.map(w => opt(w.label, w.icon, current === w.k, () => pick(w.k), true)));

  return h('div.wconflict',
    h('div.wconflict-hd', ico('warning-circle-fill', '16px'),
      h('span', { text: `Пересекается с «${other.title}» в ${hhmm(other.start)}` })),
    list);
}

const conflictBlock = () => {
  const other = crossing();
  return other ? conflictCard(other, state.rowEnd ?? 0, state.rowConflict, k => setIn({ rowConflict: k })) : null;
};

/** Способ расхождения применяется до записи: иначе сдвиг ляжет на старые времена. */
function applyConflict(date, other, way, end) {
  if (!other || way === 'overlap') return Promise.resolve();
  if (way === 'shift') return data.shiftRows(date, other.id, end - other.start);
  return data.updateRow(date, other.id, { startMin: end });
}

/** Цвет блока. Пусто — цвет приложения: тогда блок красится вместе с ним. */
function colorRow() {
  const row = h('div.wrow');
  const auto = h('button.wpaint.wpaint-auto', {
    type: 'button', class: state.rowColor ? '' : 'on',
    title: 'Как у приложения', 'aria-label': 'Как у приложения',
    onclick: () => setIn({ rowColor: null }),
  });
  add(row, auto, ...Object.entries(PALETTE).map(([k, p]) => h('button.wpaint', {
    type: 'button', class: state.rowColor === k ? 'on' : '',
    title: p.label, 'aria-label': p.label,
    style: { background: p[dark() ? 'dark' : 'light'] },
    onclick: () => setIn({ rowColor: k }),
  })));
  return h('div', h('div.wfield-label', { text: 'цвет' }), row);
}

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
    const moment = state.rowKind === 'reminder';

    const kinds = h('div.wrow');
    add(kinds, ...[
      ['normal', 'Блок времени'],
      ['reminder', 'Напоминание'],
    ].map(([k, label]) => sheetChip(label, (state.rowKind ?? 'normal') === k,
      // У момента конца нет — и править нечего, поэтому возвращаем на «начало»
      () => setIn({ rowKind: k, rowField: k === 'reminder' ? 'start' : field }))));

    /*
     * Три плитки времени. У напоминания их одна: момент длительности не имеет,
     * а пустые «длится» и «конец» только сбивали бы с толку.
     */
    const tiles = h('div', { class: moment ? 'wgrid1' : 'wgrid3' });
    add(tiles, ...[
      ['start', 'начало', hhmm(rs)],
      ['dur', 'длится', durLabel(dur)],
      ['end', 'конец', hhmm(re)],
    ].filter(([k]) => !moment || k === 'start').map(([k, label, value]) => {
      const tile = h('div.wtile', { class: field === k ? 'on' : '', onclick: () => setIn({ rowField: k }) });
      add(tile, h('span.wtile-cap', { text: label }), h('input', { value, readOnly: true, tabIndex: -1 }));
      return tile;
    }));

    /*
     * Правка начала двигает конец, сохраняя длительность; правка конца
     * длительность меняет. Так же ведут себя все календари, и так же
     * описано в эталоне.
     */
    const target = field === 'end' ? re : rs;
    const setClock = (hv, mv) => {
      const at = hv * 60 + mv;
      if (field === 'end') setIn({ rowEnd: Math.max(rs + 5, at) });
      else setIn({ rowStart: at, rowEnd: at + dur });
    };

    const picker = field === 'dur'
      ? durPicker(rs, dur)
      : h('div.wclock',
        h('div.wclock-cap', { text: 'выберите час' }),
        clockGrid(24, 1, target, hv => setClock(hv, target % 60)),
        h('div.wclock-cap', { text: 'минуты', style: { margin: '12px 0 9px' } }),
        clockGrid(12, 5, target, mv => setClock(Math.floor(target / 60), mv)));

    const leads = h('div.wwrap.wleads');
    add(leads, ...LEADS.map(l => sheetChip(l.label, state.rowLeads.includes(l.k),
      () => setIn({ rowLeads: toggleLead(state.rowLeads, l.k) }))));

    const modes = h('div.wgrid2');
    add(modes, ...ALARM.map(a => opt(a.label, a.icon, state.rowAlarm === a.k, () => setIn({ rowAlarm: a.k }))));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: moment ? 'о чём напомнить' : 'что делаем' }),
        h('input.winput', {
          name: 'rowTitle',
          value: state.rowTitle,
          placeholder: moment ? 'Например, забрать документы' : 'Например, работа над отчётом',
          oninput: e => { state.rowTitle = e.target.value; },
        })),
      kinds,
      tiles,
      moment ? null : picker,
      moment ? null : conflictBlock(),
      colorRow(),
      h('div', h('div.wfield-label', { text: 'предупредить · можно несколько' }), leads),
      h('div', h('div.wfield-label', { text: 'чем предупредить' }), modes),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: state.rowId === 'new' ? 'Отменить' : 'Удалить', onclick: deleteRow,
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово',
          disabled: state.busy, onclick: saveRow,
        })));
  },

  /*
   * Выбор дня. Своя пара «год-месяц» нужна затем, чтобы листать календарь,
   * никуда не переходя: месяц перед глазами меняется, а открытый день
   * остаётся прежним, пока по нему не нажали.
   */
  calendar() {
    const y = state.calY, m = state.calM;
    const chosen = state.calFor === 'note' ? (state.noteDate ?? state.date)
      : state.calFor === 'reminder' ? (fromRuDate(state.remDate) ?? state.date)
        : state.date;

    const grid = h('div.wcal');
    add(grid, ...DOW_SHORT.map(d => h('span.wcal-dow', { text: d })));
    add(grid, ...monthCells(y, m).map(c => {
      const key = keyOf(c.dt);
      return h('button.wcal-day', {
        type: 'button',
        class: [c.out ? 'out' : '', key === chosen ? 'on' : '', key === todayKey() ? 'today' : ''].filter(Boolean).join(' '),
        text: String(c.n),
        onclick: () => pickDate(key),
      });
    }));

    const [cy, cm, cd] = chosen.split('-').map(Number);
    return h('div.wstack',
      h('div.wrow',
        iconBtn('caret-left', { title: 'Предыдущий месяц', onclick: () => setIn(shiftCal(-1)) }),
        h('span.wcal-title', { text: `${MONTHS_NOM[m]} ${y}` }),
        iconBtn('caret-right', { title: 'Следующий месяц', onclick: () => setIn(shiftCal(1)) })),
      grid,
      h('button.wbtn-wide', {
        type: 'button',
        text: state.calFor === 'day'
          ? `Открыть ${cd} ${MONTHS[cm - 1]}`
          : `Оставить ${cd} ${MONTHS[cm - 1]} ${cy}`,
        onclick: () => (state.calFor === 'day' ? closeModal() : set({ modal: state.calBack })),
      }));
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
    /*
     * Значок — предложенные шесть и плюсик на все остальные: выбранный смайлик
     * почти всегда среди предложенных, а когда нет — искать его в шести
     * вариантах бессмысленно. Пикер тот же, что был в прежней версии.
     */
    const emoji = h('div.wrow');
    add(emoji, ...[...new Set([state.habitEmoji, ...HABIT_EMOJI])].slice(0, 6).map(e =>
      h('button.wemoji', {
        type: 'button', text: e, class: state.habitEmoji === e ? 'on' : '',
        onclick: () => setIn({ habitEmoji: e }),
      })));
    const more = h('button.wemoji.wemoji-more', {
      type: 'button', title: 'Все смайлики', 'aria-label': 'Все смайлики',
      class: state.habitPicker ? 'on' : '',
      onclick: () => setIn({ habitPicker: !state.habitPicker }),
    });
    add(more, ico('plus', '15px'));
    add(emoji, more, h('span', { style: { flex: '1' } }),
      ...[['do', 'Выполнять'], ['avoid', 'Бросаю']].map(([k, label]) =>
        sheetChip(label, state.habitKind === k, () => setIn({ habitKind: k }))));

    const picker = h('div.wemoji-box');
    if (state.habitPicker) {
      renderEmojiPicker(picker, e => setIn({ habitEmoji: e, habitPicker: false })).catch(fail);
    }

    /*
     * График — выбор, а не два поля рядом: «по дням недели» и «N раз в неделю»
     * это разные способы считать, и вместе они противоречат друг другу.
     */
    const plan = h('div.wrow');
    add(plan, ...[['days', 'По дням недели'], ['times', 'Сколько раз в неделю']].map(([k, label]) =>
      sheetChip(label, state.habitPlan === k, () => setIn({ habitPlan: k }))));

    const days = h('div.wdays7');
    add(days, ...DOW_SHORT.map((d, i) =>
      h('button', {
        type: 'button', text: d, class: state.habitDays[i] ? 'on' : '',
        onclick: () => setIn(s => ({ habitDays: { ...s.habitDays, [i]: !s.habitDays[i] } })),
      })));

    const times = h('div.wrow',
      h('input.wnum', {
        name: 'habitTimes', value: String(state.habitTimes), inputMode: 'numeric',
        oninput: e => {
          const n = Number(String(e.target.value).replace(/\D+/g, ''));
          if (n >= 1 && n <= 7) setIn({ habitTimes: n });
        },
      }),
      h('span.wsmall', { text: 'раз в неделю — день выбираете сами' }));

    const goals = h('div.wrow');
    add(goals, ...[[30, '30 дней'], [100, '100 дней'], [0, '∞'], [-1, 'Своё']].map(([v, label]) => {
      const c = sheetChip(label, state.habitGoal === v, () => setIn({ habitGoal: v, habitGoalCustom: v === -1 }), 'wchip-flex');
      if (v === 0) c.style.font = '500 19px/1 var(--ui)';
      return c;
    }));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'название' }),
        h('input.winput', {
          name: 'habitTitle', value: state.habitTitle, placeholder: 'Например, вода — 2 литра',
          oninput: e => { state.habitTitle = e.target.value; },
        })),
      h('div', h('div.wfield-label', { text: 'значок и тип' }), emoji,
        state.habitPicker ? picker : null,
        // Человек прямо сказал, что не понимает разницы — значит она должна быть написана
        h('div.wclock-cap', {
          style: { marginTop: '9px' },
          text: state.habitKind === 'avoid'
            ? 'бросаю: отмечаете день, в который удержались — серия растёт за каждый такой день'
            : 'выполнять: отмечаете день, в который сделали',
        })),
      h('div',
        h('div.wfield-label', { text: 'график' }), plan,
        h('div', { style: { marginTop: '10px' } }, state.habitPlan === 'times' ? times : days)),
      h('div',
        h('div.wfield-label', { text: 'челлендж' }), goals,
        state.habitGoalCustom
          ? h('div.wrow', { style: { marginTop: '10px' } },
            h('input.wnum', {
              name: 'habitGoalDays', value: String(state.habitGoalDays), inputMode: 'numeric',
              oninput: e => {
                const n = Number(String(e.target.value).replace(/\D+/g, ''));
                if (n >= 1 && n <= 3650) setIn({ habitGoalDays: n });
              },
            }),
            h('span.wsmall', { text: 'дней подряд' }))
          : null),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button',
          text: state.habitId === 'new' ? 'Отмена' : 'Удалить',
          onclick: () => (state.habitId === 'new' ? closeModal() : busy(data.removeHabit(state.habitId))),
        }),
        h('button.wbtn-wide', {
          type: 'button',
          text: state.busy ? 'Сохраняю…' : (state.habitId === 'new' ? 'Создать привычку' : 'Сохранить'),
          disabled: state.busy, onclick: saveHabit,
        })));
  },

  // ── Заметка ──
  note() {
    const kinds = h('div.wrow');
    add(kinds, ...[[false, 'Просто заметка'], [true, 'На дату']].map(([v, label]) =>
      sheetChip(label, state.noteDated === v, () => setIn({ noteDated: v }))));
    if (state.noteDated) {
      const [y, m, d] = String(state.noteDate ?? state.date).split('-').map(Number);
      const badge = h('button.wdate-chip', { type: 'button', onclick: () => openCalendar('note') });
      add(badge, ico('calendar-blank', '15px'),
        h('span', { text: `${d} ${MONTHS[m - 1]} ${y} · покажется в делах` }));
      add(kinds, badge);
    }

    return h('div.wstack',
      h('input.winput', {
        name: 'noteTitle', value: state.noteTitle, placeholder: 'Заголовок — можно оставить пустым',
        oninput: e => { state.noteTitle = e.target.value; },
      }),
      kinds,
      h('textarea.wtextarea', {
        name: 'noteText', value: state.noteText, placeholder: 'О чём не хочется забыть',
        oninput: e => { state.noteText = e.target.value; },
      }),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: state.noteId === 'new' ? 'Отменить' : 'Удалить', disabled: state.busy,
          onclick: deleteNote,
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Сохранить', disabled: state.busy,
          onclick: saveNote,
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
    ].map(([k, label, iconName]) => opt(label, iconName, state.mealMode === k, () => setIn({ mealMode: k }), true)));

    const window_ = state.mealMode === 'window';
    const exact = state.mealMode === 'exact';

    const durs = h('div.wwrap');
    add(durs, ...[15, 30, 45, 60, 90].map(v =>
      sheetChip(durLabel(v), state.mealDur === v, () => setIn({ mealDur: v }), 'wchip-dur')));

    const leads = h('div.wwrap');
    add(leads, ...LEADS.map(l => sheetChip(l.label, state.mealLeads.includes(l.k),
      () => setIn({ mealLeads: toggleLead(state.mealLeads, l.k) }))));

    const schedCard = h('button.wtoggle-card', { type: 'button', onclick: () => setIn(s => ({ mealSched: !s.mealSched })) },
      h('div.wtoggle-card-body',
        h('div.wrow-sw-title', { text: 'Добавить в расписание' }),
        h('div.wrow-sw-hint', { text: `займёт блок ${durLabel(state.mealDur)}, ничего не сдвинет без подтверждения` })),
      sw(state.mealSched));

    /*
     * Времена вписываются руками: сетка часов здесь была бы третьей по счёту
     * на одном экране. Разбор мягкий — «19», «1930» и «19:30» одинаково
     * понятны, и это уже умеет parseHhmm.
     */
    const timeField = (name, value, onDone) => h('input.wtime', {
      name, value: hhmm(value),
      onchange: e => {
        const at = parseHhmm(e.target.value);
        if (at === null) { setIn({ notice: 'Время не понял. Например: 12:30' }); return; }
        setIn({ notice: null, ...onDone(at) });
      },
    });

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что едим' }),
        h('input.winput', {
          name: 'mealTitle', value: state.mealTitle, placeholder: 'Например, курица с рисом',
          oninput: e => { state.mealTitle = e.target.value; },
        })),
      h('div',
        h('div.wfield-label', { text: 'время' }), modes,
        state.mealMode === 'none' ? null : h('div.wrow', { style: { marginTop: '12px' } },
          timeField('mealFrom', state.mealStart, at => ({
            mealStart: at,
            // окно двигается целиком: правя начало, человек не хочет менять его ширину
            mealEnd: window_ ? at + Math.max(15, state.mealEnd - state.mealStart) : state.mealEnd,
          })),
          h('span.whint', { text: window_ ? '—' : '+' }),
          window_
            ? timeField('mealTo', state.mealEnd, at => ({ mealEnd: Math.max(state.mealStart + 15, at) }))
            : h('span.wtime.wtime-flat', { text: durLabel(state.mealDur) })),
        window_
          ? h('div.wclock-cap', { text: 'мягкая рамка: съесть где-то внутри окна', style: { marginTop: '8px' } })
          : null),
      h('div.wrow',
        h('input.wnum', {
          name: 'mealKcal', value: state.mealKcal, placeholder: '—', inputMode: 'numeric',
          oninput: e => { state.mealKcal = e.target.value; },
        }),
        h('span.wsmall', { text: 'ккал — можно оставить пустым' })),
      exact ? h('div', h('div.wfield-label', { text: 'сколько занять в расписании' }), durs) : null,
      exact ? schedCard : null,
      exact && state.mealSched ? mealConflictBlock() : null,
      state.mealMode === 'none' ? null : h('div',
        h('div.wfield-label', { text: 'напомнить · можно несколько' }), leads,
        window_
          ? h('div.wclock-cap', { text: 'считаем от начала окна', style: { marginTop: '8px' } })
          : null),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: state.mealId === 'new' ? 'Отменить' : 'Удалить', onclick: deleteMeal,
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово', disabled: state.busy,
          onclick: saveMeal,
        })));
  },

  // ── Напоминание ──
  reminder() {
    const repeats = h('div.wwrap');
    add(repeats, ...REPEATS.map(r => sheetChip(r, state.remRepeat === r, () => setIn({ remRepeat: r }))));

    const days = h('div.wdays7');
    add(days, ...DOW_SHORT.map((d, i) =>
      h('button', {
        type: 'button', text: d, class: state.remDays[i] ? 'on' : '',
        onclick: () => setIn(s => ({ remDays: { ...s.remDays, [i]: !s.remDays[i] } })),
      })));

    const leads = h('div.wwrap.wleads');
    add(leads, ...[...LEADS, { k: 'week', label: 'за неделю' }].map(l =>
      sheetChip(l.label, state.remLeads.includes(l.k), () => setIn({ remLeads: toggleLead(state.remLeads, l.k) }))));

    const modes = h('div.wgrid2');
    add(modes, ...ALARM.filter(a => a.k !== 'off').map(a =>
      opt(a.label, a.icon, state.remAlarm === a.k, () => setIn({ remAlarm: a.k }))));

    /*
     * У повтора удаление — это три разных желания. Показываем их отдельными
     * кнопками, иначе «Удалить» тихо решает за человека: то ли один день, то
     * ли весь повтор — а вернуть уже нечем.
     */
    const repeating = Boolean(state.remSeriesId);
    const removes = h('div.wstack-tight',
      h('button.wbtn-quiet', {
        type: 'button', text: 'Убрать только этот день', disabled: state.busy,
        onclick: () => removeReminder('day'),
      }),
      h('button.wbtn-quiet', {
        type: 'button', text: 'Не напоминать с этого дня', disabled: state.busy,
        onclick: () => removeReminder('from'),
      }),
      h('button.wbtn-quiet', {
        type: 'button', text: 'Убрать повтор целиком', disabled: state.busy,
        onclick: () => removeReminder('series'),
      }));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'о чём напомнить' }),
        h('input.winput', {
          name: 'remTitle', value: state.remTitle, placeholder: 'Например, забрать документы',
          oninput: e => { state.remTitle = e.target.value; },
        })),
      h('div.wrow',
        h('input.wtime', {
          name: 'remDate', value: state.remDate, 'aria-label': 'Дата',
          oninput: e => { state.remDate = e.target.value; },
        }),
        h('input.wtime', {
          name: 'remTime', value: state.remTime, 'aria-label': 'Время',
          oninput: e => { state.remTime = e.target.value; },
        }),
        (() => {
          const b = h('button.wbtn-ghost', { type: 'button', onclick: () => openCalendar('reminder') });
          add(b, ico('calendar-blank', '15px'), h('span', { text: 'Выбрать' }));
          return b;
        })()),
      h('div', h('div.wfield-label', { text: 'повтор' }), repeats,
        state.remRepeat === 'Еженедельно'
          ? h('div', { style: { marginTop: '10px' } }, days,
            h('div.wclock-cap', { text: 'пусто — в тот же день недели, что и дата', style: { marginTop: '8px' } }))
          : null),
      h('div', h('div.wfield-label', { text: 'предупредить · можно несколько' }), leads),
      h('div', h('div.wfield-label', { text: 'чем предупредить' }), modes),
      repeating ? h('div', h('div.wfield-label', { text: 'убрать' }), removes) : null,
      h('div.wrow-end',
        repeating ? null : h('button.wbtn-quiet', {
          type: 'button', text: state.remId === 'new' ? 'Отменить' : 'Удалить', disabled: state.busy,
          onclick: () => removeReminder('day'),
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово', disabled: state.busy,
          onclick: saveReminder,
        })));
  },

  // ── Аккаунт ──
  account() {
    const field = (label, key, type = 'text') => h('label',
      h('span.wfield-label', { text: label }),
      h('input.winput', {
        name: key, type, value: state[key],
        autocomplete: type === 'password' ? 'new-password' : 'off',
        oninput: e => { state[key] = e.target.value; },
      }));

    return h('div.wstack',
      h('div.wfile',
        ico('envelope-simple', '24px'),
        h('div.wfile-body',
          h('div.wfile-name', { text: store.user?.email ?? '—' }),
          h('div.wfile-meta', {
            text: store.settings?.emailVerified ? 'почта подтверждена' : 'почта не подтверждена',
          }))),
      field('как вас звать', 'accName'),
      h('button.wbtn-wide', {
        type: 'button', text: state.busy ? 'Сохраняю…' : 'Сохранить имя',
        disabled: state.busy, onclick: saveName,
      }),
      h('div.wclock-cap', { text: 'пароль' }),
      field('текущий пароль', 'passOld', 'password'),
      field('новый пароль', 'passNew', 'password'),
      field('новый пароль ещё раз', 'passNew2', 'password'),
      h('div.wrow-end',
        h('button.wbtn-quiet', {
          type: 'button', text: 'Выйти из аккаунта',
          onclick: () => api.POST('/auth/logout').finally(() => { location.href = '/login.html'; }),
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Меняю…' : 'Сменить пароль',
          disabled: state.busy, onclick: savePassword,
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
    add(leads, ...LEADS.map(l => sheetChip(l.label, state.tplLeads.includes(l.k), () => set({ tplLeads: toggleLead(state.tplLeads, l.k) }))));

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
      h('div', h('div.wfield-label', { text: 'предупредить · можно несколько' }), leads),
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
