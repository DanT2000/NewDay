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
  DARK, LIGHT, PALETTE, ALARM, LEADS, CATS, NAV, NAV_PHONE, MONTHS, MONTHS_NOM,
  DOW_LONG, DOW_SHORT, SOUNDS, REPEATS, PRINT_PARTS, HABIT_EMOJI,
} from './data.js';
import * as adapt from './adapt.js';
import * as data from './store.js';
import { store } from './store.js';
import * as api from '../api.js';
import { printSheet } from './sheet.js';
import { renderEmojiPicker } from '../emoji.js';
/*
 * Мост в нативные будильники. В браузере плагина нет, и `native.available()`
 * честно отвечает «нет» — раздел разрешений тогда просто не показывается.
 */
import * as native from '../native.js';

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
  modal: null, busy: false, notice: null, noticeBad: false, toast: null,
  rowId: null, rowStart: null, rowEnd: null, rowField: 'start', rowTitle: '', rowAlarm: 'off', rowLeads: ['at'],
  rowKind: 'normal', rowColor: null, rowConflict: 'overlap', rowNote: '',
  rowRepeat: 'Разово', rowSeriesId: null, rowDate: null, rowWasDate: null,
  rowDays: { 0: false, 1: false, 2: false, 3: false, 4: false, 5: false, 6: false },
  taskId: null, taskTitle: '', taskCat: 'work',
  mealId: null, mealTitle: '', mealKcal: '', mealMode: 'none', mealField: 'start', mealSched: false,
  mealStart: 720, mealEnd: 840, mealLeads: ['at'], mealSchedId: null, mealConflict: 'overlap',
  mealDate: null,
  foodPlan: '', foodGoal: '',
  sportId: null, sportTitle: '', sportSets: '', sportReps: '', sportWeight: '',
  noteId: null, noteTitle: '', noteText: '', noteDated: true, noteDate: '',
  fileKind: 'export', sound: 'Рассвет', notifySound: 'Капля', soundKind: 'Звук будильника',
  tplRows: null, tplEdit: null, tplStart: 420, tplEnd: 480, tplField: 'start',
  tplTitle: '', tplAlarm: 'off', tplLeads: ['at'],
  quietFrom: '23:00', quietTo: '07:00',
  habitId: null, habitKind: 'do', habitEmoji: '💧', habitGoal: 30, habitGoalCustom: false,
  habitTitle: '', habitTimes: 5, habitPlan: 'days', habitGoalDays: 730, habitPicker: false,
  habitDays: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: false, 6: false },
  aiStep: 'input', aiText: '', aiOff: {}, aiItems: null, aiQuestion: '', aiOptions: [],
  // запись, поток микрофона и остановка счётчика громкости — их надо отпускать
  recorder: null, micStream: null, stopMeter: null,
  calY: 0, calM: 0, calFor: 'day', calBack: null,
  printScope: 0, printOff: {},
  statsDays: 30,
  accName: '', passOld: '', passNew: '', passNew2: '',
  // что разрешено будильнику на этом телефоне; в браузере остаётся null
  alarmPerms: null,
  // есть ли камера и шагомер и привязан ли код; в браузере тоже null
  missionCaps: null,
  // секрет токена живёт только пока открыта шторка: сервер его не помнит
  tokenShown: null,
  pairCode: null,
  tokenName: '', tokenScope: 'read', tokenSecret: null,
  aiDraft: null,
  // открытый раздел настроек; null — оглавление
  setPage: null,
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
/**
 * Сказать, что поле не заполнено, — и показать, какое именно.
 *
 * Одной подписи мало: она набрана акцентом, стоит выше поля, и на длинной
 * шторке её можно вовсе не увидеть — человек нажимает «Готово» второй раз и
 * считает, что кнопка не работает. Поэтому поле обводим красным, ставим в него
 * курсор и подкручиваем к нему шторку.
 */
function needField(name, text) {
  setIn({ notice: text, noticeBad: true });
  const field = document.querySelector(`.wmodal [name="${name}"]`);
  if (!field) return;
  field.classList.add('bad');
  // обводка снимается с первой же буквой: человек уже понял
  field.addEventListener('input', () => field.classList.remove('bad'), { once: true });
  field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  field.focus();
}

/**
 * Перерисовать один блок на месте.
 *
 * Фильтр меняет только свой список, а `set` перестраивает весь экран: боковое
 * меню, шапку, сетку дня. На глаз это выглядит как перезагрузка — экран
 * моргает, прокрутка прыгает наверх. Здесь заменяется ровно то поддерево,
 * которое изменилось.
 */
function repaint(selector, build) {
  const el = document.querySelector(selector);
  if (!el) { render(); return; }
  el.replaceWith(build());
}

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
/*
 * Ещё две зацепки для проверок и съёмки карточки магазина: перейти на экран
 * (и, если нужно, в раздел настроек) и сменить вид расписания. Клик по кнопке
 * из скрипта зависит от подписи, а подписи меняются — эти два вызова нет.
 */
window.__wgo = (screen, page = null) => set({ screen, setPage: page, modal: null });
window.__wsetview = view => set({ view });

window.__wopen = name => {
  if (name === 'notify' || name === 'template') return openLink(name);
  if (name === 'file') return openLink('export');
  if (name === 'tplRow') return openTplRow('new');
  if (name === 'reminder') return newRow({ kind: 'reminder' });
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
const leadsLabel = r => leadsOf(r)
  .map(k => LEADS.find(l => l.k === k)?.label ?? (/^\d+$/.test(k) ? leadOwnLabel(k) : k))
  .join(', ');

/** Свой срок словами: «за 40 мин», «за 2 ч», «за 1 ч 30 мин». */
function leadOwnLabel(k) {
  const n = Number(k);
  if (n < 60) return `за ${n} мин`;
  const hh = Math.floor(n / 60);
  const mm = n % 60;
  return mm ? `за ${hh} ч ${mm} мин` : `за ${hh} ч`;
}

/**
 * Свой срок предупреждения. prompt намеренно: это редкое действие, и своя
 * шторка ради него отняла бы больше внимания, чем сэкономила.
 */
function askOwnLead() {
  const raw = prompt('За сколько минут предупредить?', '40');
  if (raw === null) return;
  const n = Number(String(raw).replace(/\D+/g, ''));
  // сутки — потолок: дальше это уже не «предупредить», а другой день
  if (!n || n < 1 || n > 1440) { setIn({ notice: 'Нужно число от 1 до 1440 минут' }); return; }
  setIn({ rowLeads: toggleLead(state.rowLeads, String(n)) });
}

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

/**
 * Короткое сообщение поверх экрана. Через четыре секунды убирается само.
 *
 * Экранное сообщение и сообщение шторки — разные вещи и лежат в разных
 * местах. Раньше это было одно поле, и «Впишите, что делаем» из редактора
 * оставалось висеть над днём: человек уходил в другой раздел, листал дни, а
 * сообщение шло за ним и читалось как поломка экрана.
 */
function note(text) {
  state.toast = text;
  render();
  setTimeout(() => { if (state.toast === text) { state.toast = null; render(); } }, 4000);
}

/** Сообщение об отказе. Молчаливая неудача — худшее, что может быть. */
/*
 * Отказ из-за связи и отказ сервера — разные вещи, и говорить о них надо
 * по-разному. «Не удалось сохранить» при выключенном интернете звучит как
 * поломка приложения, хотя приложение тут ни при чём.
 */
const fail = e => note(navigator.onLine === false
  ? 'Нет связи — правка не ушла на сервер. Появится связь, попробуйте снова'
  : (e?.message || 'Не удалось сохранить'));

/**
 * Действие в шторке: кнопка занята, пока запрос в пути, исход виден.
 * Шторка при этом остаётся открытой — в отличие от `busy`, которая её
 * закрывает: «проверить уведомление» не повод уходить с экрана.
 */
function act(job, okText) {
  state.busy = true;
  state.notice = null;
  render();
  // и промис, и функция: Promise.resolve(fn) резолвится самой функцией,
  // не вызывая её, — кнопка отчитывалась «готово», не сделав ничего
  return Promise.resolve(typeof job === 'function' ? job() : job)
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
      /*
       * Разрешения будильника спрашиваем у телефона тут же: список меняется
       * снаружи приложения — человек мог выдать или отобрать разрешение в
       * системных настройках, — и показывать запомненное значило бы врать.
       */
      if (native.available()) {
        jobs.push(native.checkPermissions().then(p => { state.alarmPerms = p; }).catch(() => null));
        // то же самое про камеру, шагомер и привязанный код
        jobs.push(native.missionCapabilities().then(c => { state.missionCaps = c; }).catch(() => null));
        // свой звук, выбранный в браузере, довозится на телефон здесь:
        // будильник звонит без сети, файл обязан лежать на устройстве
        jobs.push(ensureCustomSound().catch(() => null));
      }
    }
    /*
     * `allSettled`, а не `all`: одна неудачная попутная загрузка не должна
     * обваливать всё обновление.
     *
     * Без сети первым падали заметки — и вместе с ними не выполнялись `fill` и
     * `render`. Расписание в локальной копии лежало целым, а на экране его не
     * было: приложение выглядело так, будто офлайн у него ничего нет.
     *
     * Об отказах сообщаем один раз и коротко: список причин на экране человеку
     * не нужен, ему нужно понимать, что данные могут быть не свежие, — и это
     * говорит спокойная полоса.
     */
    const итоги = await Promise.allSettled(jobs);
    fill();
    render();
    const беда = итоги.find(r => r.status === 'rejected');
    if (беда && navigator.onLine !== false && !store.offline) fail(беда.reason);
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

function sideBar() {
  const nav = h('nav.wnav', { 'aria-label': 'Разделы' });
  /*
   * Цифр у разделов нет.
   *
   * Они показывали разное в зависимости от того, где человек находится:
   * привычки на «Сейчас» считались по дню, а внутри раздела — по всему списку,
   * и число на глазах менялось с «0 из 1» на «1 из 1». Счётчик, который врёт
   * при переходе, хуже отсутствующего.
   */
  add(nav, ...NAV.map(n => {
    const on = state.screen === n.key;
    const b = h('button.wnav-item', {
      type: 'button', class: on ? 'on' : '',
      onclick: () => {
        /*
         * «Сейчас» — это всегда сегодня. Человек листал дни на неделю вперёд,
         * уходил в заметки, возвращался — и попадал не в свой день, а туда,
         * где остановился. Раздел называется «Сейчас», и открывать он должен
         * именно сейчас.
         */
        if (n.key === 'today') state.date = store.settings?.today ?? state.date;
        state.screen = n.key;
        state.modal = null;
        render();
        reload();
      },
    });
    add(b, ico(on ? `${n.icon}-fill` : n.icon, '19px'), h('span', { text: n.label }));
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

  /*
   * Кнопки помощника нет, когда его нет: администратор выключил ИИ или
   * этому аккаунту он не разрешён. Кнопка, ведущая в отказ, хуже отсутствия.
   */
  const ai = aiAllowed()
    ? h('button.wbtn-ai', { type: 'button', onclick: () => openAi() })
    : null;
  if (ai) add(ai, ico('sparkle-fill', '17px'), h('span', { text: 'Помощник' }));

  return h('aside.wside',
    /*
     * Знак — картинкой, и своей для каждой темы: у светлого знака подложка
     * почти белая, и на тёмном фоне он светится пятном, у тёмного наоборот.
     */
    h('div.wbrand',
      h('img.wbrand-mark', {
        src: dark() ? '/icons/logo-dark-64.png' : '/icons/logo-light-64.png',
        width: '28', height: '28', alt: '', draggable: 'false',
      }),
      h('b', { text: 'NewDay' })),
    nav,
    h('div.wside-foot',
      ai,
      themeBtn,
      /*
       * Персонаж — дверь в свои настройки: аккаунт, устройства, день и
       * питание. Раньше блок был просто картинкой, и его нажимали впустую.
       */
      h('button.wuser', {
        type: 'button',
        onclick: () => set({ screen: 'settings', setPage: 'account' }),
      },
      avatarEl('15px'),
      h('div.wuser-body',
        h('div.wuser-name', { text: userName() }),
        h('div.wuser-note', { text: 'синхронизировано' })))));
}

/** Аватар: своя картинка из настроек или значок-заглушка. */
function avatarEl(size) {
  const src = store.settings?.settings?.avatar;
  return src
    ? h('img.wuser-ava.wuser-pic', { src, alt: '' })
    : h('span.wuser-ava', ico('user', size));
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

  /*
   * На настройках и привычках полосы дня нет.
   *
   * «Сегодня», календарь и стрелки там ничего не меняли: ни настройки, ни
   * список привычек к дате не привязаны. Кнопка, которая нажимается и не
   * делает ничего, хуже отсутствующей. На заметках полоса остаётся — у них
   * есть фильтр «на этот день», и он про выбранную дату.
   */
  if (state.screen === 'settings' || state.screen === 'habits') return null;

  return h('div.wtop',
    h('div.wtop-date',
      h('div.wtop-dow', { text: period.top }),
      h('div.wtop-num', { text: period.main })),
    /*
     * Стрелки — рядом с датой, а не по краям полоски недель.
     *
     * Разнесённые по краям они читались как рамка вокруг недели, а тянуться до
     * них приходилось через весь экран. Листают они по-прежнему выбранный
     * период: на месяце — месяц.
     */
    h('div.wtop-nav',
      (() => {
        /*
         * «Сегодня» со значком: рядом стоит «Календарь», и две одинаковые
         * подписи без картинок читались как один блок. Значок отличает
         * возврат к текущему дню от выбора произвольного.
         */
        const b = h('button.wchip.wchip-icon', {
          type: 'button', class: state.date === todayKey() ? 'on' : '',
          title: 'Вернуться к сегодняшнему дню',
          onclick: () => go(todayKey()),
        });
        add(b, ico('sun-horizon', '15px'), h('span', { text: 'Сегодня' }));
        return b;
      })(),
      cal,
      iconBtn('caret-left', { title: `Предыдущий ${what}`, onclick: () => shiftPeriod(-1) }),
      iconBtn('caret-right', { title: `Следующий ${what}`, onclick: () => shiftPeriod(1) })),
    days,
    (() => {
      const b = h('button.wbtn-ghost', { type: 'button', onclick: () => set({ modal: 'print' }) });
      add(b, ico('printer', '16px'), h('span', { text: 'Печать' }));
      return b;
    })());
}

// ── Экран «Сейчас» ───────────────────────────────────────────

/**
 * Вложенность: строка, начавшаяся до конца предыдущей, лежит внутри неё.
 *
 * Напоминания участвуют наравне с блоками: это одна сущность, и напоминание в
 * десять внутри рабочего блока — такое же «внутри», как созвон. Отличается оно
 * только тем, что не занимает времени, и это показано значком, а не другим
 * поведением.
 */
function nesting() {
  const inner = {}, parent = {};
  let base = null;
  for (const r of SCHEDULE) {
    if (base && base.end !== null && r.start < base.end) { inner[r.id] = true; parent[base.id] = true; }
    else if (r.end !== null) base = r;
  }
  return { inner, parent };
}

function scheduleList() {
  const { inner, parent } = nesting();
  const wrap = h('div.wsched');
  add(wrap, ...SCHEDULE.map(r => {
    const mode = alarmOf(r);
    const sub = [];
    if (r.isReminder) sub.push('напоминание');
    // «внутри блока» словами больше не пишем: вложенность видна отступом и
    // цветной чертой слева — объяснять нарисованное незачем
    if (r.fromFood) sub.push('из питания');
    if (mode !== 'off' && !hasLead(r, 'at')) sub.push(leadsLabel(r));
    // комментарий — первым: это то, что человек написал сам
    if (r.note) sub.unshift(r.note.split('\n')[0]);

    const row = h('button.wsched-row', {
      type: 'button',
      class: [
        r.past ? 'past' : '', r.now ? 'now' : '',
        inner[r.id] ? 'inner' : '', parent[r.id] ? 'parent' : '',
        r.isReminder ? 'moment' : '',
      ].filter(Boolean).join(' '),
      style: r.color ? { '--pin': PALETTE[r.color][dark() ? 'dark' : 'light'] } : {},
      onclick: () => openRow(r),
    });
    /*
     * Напоминание видно значком и подписью «напоминание»: сущность та же, а
     * смысл другой — у него нет длительности, и путать его с блоком не нужно.
     */
    add(row,
      h('span.wsched-time', { text: r.end === null ? hhmm(r.start) : `${hhmm(r.start)}–${hhmm(r.end)}` }),
      h('span.wsched-mark', h('span.wsched-dot')),
      h('div.wsched-body',
        h('div.wsched-title',
          r.isReminder ? ico('bell', '13px', 'wsched-kind') : null,
          h('span', { text: r.title })),
        sub.length ? h('div.wsched-sub', { text: sub.join(' · ') }) : null),
      // пустой значок вместо null: колонка держит ширину, и строки без
      // напоминания стоят вровень с остальными
      mode === 'off' ? h('span') : ico(bellOf(mode).icon, '16px', 'wbell'));
    return row;
  }));
  return wrap;
}

function progress() {
  const scored = [...TASKS, ...MEALS, ...HABITS.filter(x => x.active)];
  const done = scored.filter(isDone).length;
  // Пустой день — это не ноль процентов и уж точно не NaN: считать нечего
  const percent = scored.length ? Math.round((done / scored.length) * 100) : 0;
  return { done, total: scored.length, percent, empty: scored.length === 0 };
}

/**
 * Карточка «сейчас»: текущий блок расписания, сколько осталось и доля дня.
 *
 * Раньше здесь стояли постоянные значения из макета — «сейчас · 09:00 – 12:30»,
 * «Работа: первый блок», «1 ч 12 мин до конца блока». Самый заметный блок
 * экрана сообщал то, чего на сервере нет, и на пустом дне утверждал, что
 * человек сейчас работает.
 */
function nowCard() {
  const { percent, empty } = progress();
  const C = 2 * Math.PI * 34;

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const isToday = state.date === todayKey();
  const cur = isToday ? SCHEDULE.find(r => r.now) : null;
  const next = isToday
    ? SCHEDULE.find(r => r.start > minutes)
    : SCHEDULE.find(r => !r.past);

  /*
   * Промежуток склеен неразрывными пробелами нарочно: подпись переносится по
   * «·», а «13:30 – 17:00» остаётся целым. Разрыв после тире читается как
   * другое время, и это хуже, чем вторая строка.
   */
  const live = cur
    ? { top: `сейчас · ${hhmm(cur.start)} – ${cur.end === null ? '' : hhmm(cur.end)}`.trim(),
      title: cur.title,
      left: cur.end === null ? null : durLabel(Math.max(1, cur.end - minutes)),
      leftNote: 'до конца блока',
      share: cur.end === null ? 0 : Math.round(((minutes - cur.start) / (cur.end - cur.start)) * 100) }
    : next
      ? { top: isToday ? 'дальше' : 'начало дня', title: next.title,
        left: isToday ? durLabel(Math.max(1, next.start - minutes)) : hhmm(next.start),
        leftNote: isToday ? 'до начала' : 'по расписанию', share: 0 }
      : { top: isToday ? 'сейчас' : 'этот день', title: 'Расписание пустое',
        left: null, leftNote: '', share: 0 };

  return h('div.wnow',
    h('div.wnow-in',
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div.wnow-live', cur ? h('i') : null, h('span', { text: live.top })),
        h('div.wnow-title', { text: live.title }),
        live.left
          ? h('div.wnow-left', h('b', { text: live.left }), h('span', { text: live.leftNote }))
          : null,
        h('div.wbar', h('i', { style: { width: `${Math.max(0, Math.min(100, live.share))}%` } }))),
      (() => {
        const box = h('div.wring');
        box.innerHTML = `<svg viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" fill="none" stroke="${dark() ? 'rgba(233,233,237,0.10)' : 'rgba(41,43,49,0.12)'}" stroke-width="6"></circle>
          <circle cx="40" cy="40" r="34" fill="none" stroke="${accent()}" stroke-width="6" stroke-linecap="round"
            stroke-dasharray="${(C * percent) / 100} ${C}"></circle>
        </svg>`;
        add(box, h('span', { text: empty ? '—' : `${percent}%` }));
        return box;
      })()));
}

function statCards() {
  const { done, total, percent, empty } = progress();
  const act = HABITS.filter(x => x.active);
  const hd = act.filter(isDone).length;

  /*
   * Третья плитка — привычки за неделю. Раньше здесь стояли «71%» и «лучшая
   * серия 12» из макета: числа не менялись никогда, что бы человек ни делал.
   * Считаем по той же недели истории, которую сервер отдаёт с каждой привычкой.
   */
  const week = HABITS.flatMap(hb => hb.week ?? []);
  const weekDone = week.filter(k => k === 'done').length;
  const weekAsked = week.filter(k => k !== 'off' && k !== 'skip').length;
  const weekPct = weekAsked ? Math.round((weekDone / weekAsked) * 100) : 0;
  const best = HABITS.reduce((m, hb) => Math.max(m, hb.raw?.bestStreak ?? 0), 0);

  const cards = [
    {
      value: empty ? '—' : `${percent}%`,
      label: total ? `дела сегодня · ${done} из ${total}` : 'на этот день ничего не запланировано',
      p: percent,
    },
    {
      value: `${hd}/${act.length}`,
      label: act.length ? 'привычки сегодня' : 'привычек на сегодня нет',
      p: act.length ? Math.round((hd / act.length) * 100) : 0,
    },
    {
      value: weekAsked ? `${weekPct}%` : '—',
      label: `привычки за 7 дней${best ? ` · лучшая серия ${best}` : ''}`,
      p: weekPct,
    },
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

  const chips = h('div.wwrap.wchips', { style: { paddingBottom: '10px' } });
  add(chips, ...[{ k: 'all', label: 'Все' }, ...CATS].map(c =>
    chip(c.label, state.catFilter === c.k, () => {
      state.catFilter = c.k;
      repaint('.wtasks', tasksBlock);
    })));

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

  return h('div.wtasks',
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

  /*
   * План дня и цель по калориям — настоящие, а не строка из макета.
   *
   * Раньше здесь стояло «Курица, рис, овощи, творог, кофе без сахара» и цель
   * 2200 ккал: одно и то же во всех днях и у всех людей. План живёт в дне,
   * цель — в настройках, потому что она общая для всех дней.
   */
  const goal = kcalGoal();
  const plan = store.day?.foodPlan ?? '';
  const planLine = h('button.wfood-plan', {
    type: 'button', class: plan ? '' : 'empty',
    title: 'Изменить план питания на день',
    onclick: openFood,
  }, h('span', { text: plan || 'План на день: что нужно съесть' }));

  return h('div',
    sectHd('питание', h('span.wcount', { text: goal ? `${kcal} из ${goal} ккал` : `${kcal} ккал` }), shades[1]),
    h('div.wfood',
      planLine,
      goal ? h('div.wbar', h('i', { style: { width: `${Math.min(100, (kcal / goal) * 100)}%` } })) : null,
      inner));
}

/**
 * Цель по калориям. Ноль или пусто значит «не считаю»: тогда ни полосы, ни
 * доли — считать калории хочет не каждый, и навязывать это нечестно.
 */
const kcalGoal = () => {
  const raw = store.settings?.settings?.kcalGoal;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** Шторка «Питание на день»: свободный план и цель по калориям. */
function openFood() {
  set({
    modal: 'food', notice: null,
    foodPlan: store.day?.foodPlan ?? '',
    foodGoal: kcalGoal() ? String(kcalGoal()) : '',
  });
}

function saveFood() {
  const goalRaw = String(state.foodGoal ?? '').replace(/\D+/g, '');
  const goal = goalRaw ? Math.min(20000, Number(goalRaw)) : 0;
  busy((async () => {
    await data.saveDayField(state.date, { foodPlan: String(state.foodPlan ?? '').slice(0, 500) });
    if (goal !== kcalGoal()) await data.saveSettings({ kcalGoal: goal });
  })());
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
  /*
   * Напоминания живут в расписании, а не отдельным блоком.
   *
   * Блок времени и напоминание — одна сущность: у одного есть длительность, у
   * другого нет. Разделять их на два списка значило заставлять человека искать
   * своё дело в двух местах и помнить, чем они отличаются.
   */
  /*
   * Кнопок «Блок» и «Напоминание» под расписанием на компьютере больше нет:
   * пришитые снизу, они выбивались из колонки и выглядели чужими. Всё
   * добавляется через «изменить» — там и строка, и напоминание в одном месте.
   */
  const left = h('div.wcol', nowCard(),
    h('div',
      sectHd('расписание', (() => {
        const b = h('button.wlink', { type: 'button', onclick: () => set({ modal: 'schedule' }) });
        add(b, ico('pencil-simple', '13px'), h('span', { text: 'изменить' }));
        return b;
      })()),
      scheduleList()));

  const mid = h('div.wcol', statCards(), tasksBlock(), foodBlock());

  const right = h('div.wcol',
    h('div', sectHd('привычки сегодня'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        ...HABITS.map(hb => habitCard(hb)))),
    h('div', sectHd('заметки дня'), dayNotes()));

  return h('div.wcols', left, mid, right);
}

// ── Телефон ──────────────────────────────────────────────────

/*
 * Телефонная раскладка — не сжатый компьютер, а другая расстановка.
 *
 * Сетки расписания здесь нет вовсе: в прототипе телефона её нет, и это верно —
 * восемнадцать часов по вертикали на ладони не читаются. Само расписание живёт
 * шторкой, а содержимое дня собрано в «Делах» одной прокруткой.
 *
 * Разделов пять, «Сейчас» в середине. Правки — снизу вверх шторками: на
 * телефоне окно посередине экрана отбирает половину места под пустоту.
 */
const PHONE_MAX = 720;
const isPhone = () => matchMedia(`(max-width: ${PHONE_MAX}px)`).matches;

/**
 * Разрешён ли помощник этому аккаунту. Пока статус не пришёл, верим ready:
 * прятать кнопку на секунду загрузки и возвращать — это мигание.
 */
function aiAllowed() {
  const a = store.ai ?? {};
  if (!a.ready) return false;
  if (a.enabled === false) return false;
  if (a.tier === 'off') return false;
  return true;
}

/** Шапка дня: день недели, число, стрелки, календарь и помощник. */
function phoneDayHead() {
  const cur = dayOf();
  const ai = aiAllowed()
    ? h('button.wpbtn.wpbtn-ai', {
      type: 'button', title: 'Помощник', 'aria-label': 'Помощник',
      onclick: () => openAi(),
    })
    : null;
  if (ai) add(ai, ico('sparkle-fill', '17px'));

  const cal = h('button.wpbtn.wpbtn-accent', {
    type: 'button', title: 'Выбрать день', 'aria-label': 'Выбрать день',
    onclick: () => openCalendar('day'),
  });
  add(cal, ico('calendar-blank', '17px'));

  const back = h('button.wpbtn', { type: 'button', title: 'Предыдущий день', 'aria-label': 'Предыдущий день', onclick: () => shiftDay(-1) });
  add(back, ico('caret-left', '17px'));
  const fwd = h('button.wpbtn', { type: 'button', title: 'Следующий день', 'aria-label': 'Следующий день', onclick: () => shiftDay(1) });
  add(fwd, ico('caret-right', '17px'));

  /*
   * Кнопки собраны в одну группу, а не разбросаны по шапке. При увеличении
   * 125 % место кончается, и группа целиком переходит на вторую строку —
   * иначе на неё уползала одна последняя кнопка, а «6 августа» ломалось
   * пополам.
   */
  return h('div.wphead',
    h('div.wphead-text',
      h('div.wphead-dow', { text: DOW_LONG[cur.getDay()] }),
      h('div.wphead-num', { text: `${cur.getDate()} ${MONTHS[cur.getMonth()]}` })),
    h('div.wphead-btns', back, fwd, cal, ai));
}

/** Полоска недели: семь дней, точка — «в этом дне что-то есть». */
function phoneWeek() {
  const mon = mondayOf(dayOf());
  const strip = h('div.wpweek');
  add(strip, ...Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(mon); dt.setDate(mon.getDate() + i);
    const key = keyOf(dt);
    const b = h('button.wpday', {
      type: 'button',
      class: [key === state.date ? 'on' : '', hasPlans(key) ? 'has' : ''].filter(Boolean).join(' '),
      onclick: () => go(key),
    });
    add(b,
      h('span.wpday-dow', { text: DOW_SHORT[i] }),
      h('span.wpday-num', { text: pad2(dt.getDate()) }),
      h('span.wpday-dot'));
    return b;
  }));
  return strip;
}

/**
 * Экран «Сейчас» на телефоне: текущий блок, две строки расписания вокруг него
 * и три плитки прогресса. Всё остальное — в «Делах»: на телефоне длинная
 * прокрутка на главном экране означает, что главное в ней теряется.
 */
function phoneToday() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const isToday = state.date === todayKey();

  const past = isToday ? [...SCHEDULE].reverse().find(r => (r.end ?? r.start) <= minutes) : null;
  const next = isToday
    ? SCHEDULE.find(r => r.start > minutes)
    : SCHEDULE.find(r => !r.past);

  const near = h('div.wpcard');
  const nearRows = [
    past ? { tag: 'было', row: past } : null,
    next ? { tag: 'дальше', row: next } : null,
  ].filter(Boolean);

  if (!nearRows.length) {
    add(near, h('div.wpempty', { text: 'На этот день расписания нет' }));
  } else {
    add(near, ...nearRows.map(({ tag, row }) => {
      const line = h('button.wprow', { type: 'button', onclick: () => openRow(row) });
      const mode = alarmOf(row);
      add(line,
        h('span.wptag', { text: tag }),
        h('span.wptime', { text: hhmm(row.start) }),
        h('span.wpname', { text: row.title }),
        mode === 'off' ? null : ico(bellOf(mode).icon, '15px', 'wbell'));
      return line;
    }));
  }

  /*
   * Кнопки под расписанием крупные: на телефоне ссылка в углу — цель для
   * пальца слишком мелкая, а добавить строку прямо отсюда хочется чаще, чем
   * открывать весь список.
   */
  const all = h('button.wbtn-dashed', { type: 'button', onclick: () => set({ modal: 'schedule' }) });
  add(all, ico('list-checks', '15px'), h('span', { text: 'Всё расписание' }));
  const addRow = h('button.wbtn-dashed', { type: 'button', onclick: () => newRow() });
  add(addRow, ico('plus', '15px'), h('span', { text: 'Строка' }));

  return h('div.wpscreen',
    phoneDayHead(), phoneWeek(), nowCard(),
    h('div', sectHd('расписание'), near,
      h('div.wrow', { style: { marginTop: '10px' } }, all, addRow)),
    statCards());
}

/** Экран «Дела»: всё содержимое дня одной прокруткой. */
function phoneTasks() {
  const { done, total, percent, empty } = progress();
  const C = 2 * Math.PI * 25;

  const ring = h('div.wpring');
  ring.innerHTML = `<svg viewBox="0 0 60 60">
    <circle cx="30" cy="30" r="25" fill="none" stroke="${dark() ? 'rgba(233,233,237,0.10)' : 'rgba(41,43,49,0.12)'}" stroke-width="5"></circle>
    <circle cx="30" cy="30" r="25" fill="none" stroke="${accent()}" stroke-width="5" stroke-linecap="round"
      stroke-dasharray="${(C * percent) / 100} ${C}"></circle>
  </svg>`;
  add(ring, h('span', { text: empty ? '—' : `${percent}%` }));

  const notesLink = h('button.wlink', { type: 'button', onclick: () => set({ screen: 'notes' }) });
  add(notesLink, h('span', { text: 'все заметки' }), ico('caret-right', '13px'));

  /*
   * Отдельного блока напоминаний здесь тоже нет: они часть расписания, и
   * искать своё дело в двух списках человеку не нужно.
   */
  return h('div.wpscreen',
    phoneDayHead(), phoneWeek(),
    h('div.wprow-head',
      h('div',
        h('div.wphead-title', { text: 'Дела дня' }),
        h('div.wphead-hint', {
          text: total ? `${done} из ${total} отмечено` : 'на этот день ничего не запланировано',
        })),
      ring),
    tasksBlock(),
    foodBlock(),
    h('div', sectHd('заметки дня', notesLink), dayNotes()));
}

/** Нижняя полоса разделов. «Сейчас» в середине — до него дотягивается палец. */
function phoneNav() {
  const bar = h('nav.wpnav');
  add(bar, ...NAV_PHONE.map(n => {
    const on = state.screen === n.key;
    const b = h('button.wpnav-item', {
      type: 'button',
      class: [on ? 'on' : '', on && n.key === 'today' ? 'mid' : ''].filter(Boolean).join(' '),
      onclick: () => {
        if (state.screen === n.key) return;
        set({ screen: n.key, modal: null });
        reload();
      },
    });
    add(b, ico(on ? `${n.icon}-fill` : n.icon, '23px'), h('span', { text: n.label }));
    return b;
  }));
  return bar;
}

// ── Экран «Расписание» ───────────────────────────────────────

/** Что тянут прямо сейчас. Не в state: живёт доли секунды и на вид не влияет. */
let dragging = null;

/*
 * Минута в сетке по вертикали. Верх ограничен последней минутой суток, а не
 * их концом: 24:00 в сутках не существует, и протягивание до самого низа
 * давало 1440 — сервер такое время не принимает, и блок не создавался вовсе.
 */
const snap = px => FROM_MIN
  + Math.max(0, Math.min(HOURS * 60 - SNAP, Math.round((px / PX_PER_MIN) / SNAP) * SNAP));

/**
 * Дорожки для пересечений.
 *
 * Считаем по группам, а не по всему дню. Если в дне есть хотя бы одна пара
 * наложений, деление ширины на всё подряд сжимало бы и одинокие блоки — и
 * тогда «Подъём» на полчаса становится узкой полоской без названия. Здесь
 * группа — цепочка блоков, которые действительно задевают друг друга;
 * ширину делят только они.
 */
/** Сколько места занимает момент в сетке: своей длительности у него нет. */
const MOMENT_MIN = 20;

function lanesFor(rows) {
  /*
   * Моменты — напоминания — считаются наравне с блоками и занимают дорожку.
   *
   * Раньше они рисовались меткой поверх сетки и ложились на чужие блоки: в
   * неделе, где колонка узкая, под напоминанием не было видно вообще ничего.
   * Своей длительности у момента нет, поэтому для раскладки берём короткую
   * условную — на вид это остаётся точкой со временем, но место оно занимает
   * честно и никого не перекрывает.
   */
  const items = rows
    .filter(r => r.start >= FROM_MIN)
    .map(r => (r.end === null
      ? { ...r, end: Math.min(1439, r.start + MOMENT_MIN), moment: true }
      : r))
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

/**
 * Строки нужного дня.
 *
 * Берём из выборки за период, а если её нет — из открытого дня. Без второго
 * пути на «Сейчас» не работало ничего, что спрашивает про строки другого
 * места: разбор пересечений молча считал, что пересекаться не с чем, и клал
 * блоки внахлёст без предупреждения.
 */
function rowsForDate(date) {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const day = (store.range?.days ?? []).find(d => d.date === date);
  const rows = day?.schedule ?? (store.day?.date === date ? store.day.schedule : null);
  if (!rows) return [];
  return rows.map(r => adapt.scheduleRow(r, { isToday: date === todayKey(), minutes }));
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
      class: [compact ? 'compact' : '', i > 0 ? 'inner' : '', r.moment ? 'moment' : ''].filter(Boolean).join(' '),
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
    /*
     * Комментарий видно в блоке, если под него осталось место.
     *
     * Столько строк, сколько влезает, и ни одной больше: блок нельзя растить
     * под текст — он стоит на сетке времени. Полный текст в подсказке под
     * курсором, и по многоточию понятно, что там есть продолжение.
     */
    const room = height - 22;
    /*
     * Место делим: если комментарий есть, заголовок берёт не больше двух строк,
     * остальное достаётся комментарию. Раньше заголовок занимал всё подряд, и
     * под комментарий не оставалось ни строки — он не показывался никогда.
     */
    const fits = Math.max(1, Math.floor(room / 16));
    const titleLines = compact ? 1 : (r.note ? Math.min(2, fits) : fits);
    const noteRoom = compact ? 0 : Math.floor((room - titleLines * 16) / 15);
    const showNote = Boolean(r.note) && noteRoom >= 1;
    /*
     * У момента нет конца, и показывать «15:00–15:20» было бы враньём:
     * двадцать минут придуманы ради раскладки. Пишем только время начала.
     */
    const when = r.moment ? hhmm(r.start) : `${hhmm(r.start)}–${hhmm(r.end)}`;
    const hint = `${when} · ${r.title}${r.note ? `\n${r.note}` : ''}`;

    add(block,
      r.moment ? h('i.wblock-dot') : null,
      tight ? null : h('span.wblock-time', { text: when }),
      h('span.wblock-title', {
        text: r.title,
        title: hint,
        style: compact ? {} : { WebkitLineClamp: String(titleLines) },
      }),
      /*
       * В низкий блок комментарий не поместится, но знать о нём надо: ставим
       * точку. Полный текст — в подсказке под курсором.
       */
      r.note && !showNote ? h('i.wblock-mark', { title: hint }) : null,
      showNote
        ? h('span.wblock-note', {
          text: r.note,
          title: r.note,
          style: { WebkitLineClamp: String(Math.min(noteRoom, 3)) },
        })
        : null);
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
      onclick: () => {
        state.view = k;
        render();
        reload();
        data.saveSettings({ planView: k }).catch(fail);
      },
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
      // через go: иначе открытый день менялся, а содержимое оставалось от прежнего
      onclick: () => go(key),
    });
    /*
     * В виде «День» колонка одна и места много: пишем «суббота, 8 августа».
     * Одинокая «08» посреди широкой полосы читалась как обрубок.
     */
    if (single) {
      add(dayBtn, h('span.wplan-day-full', {
        text: `${DOW_LONG[dt.getDay()]}, ${dt.getDate()} ${MONTHS[dt.getMonth()]}`,
      }));
    } else {
      add(dayBtn,
        h('span.wplan-day-dow', { text: DOW_SHORT[i] }),
        h('span.wplan-day-num', { text: pad2(dt.getDate()) }));
    }
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
  /*
   * Шапка во всю ширину, а сами карточки — в узкой колонке.
   *
   * Раньше в узкую колонку уходил и заголовок, и кнопка «Новая привычка»
   * оказывалась посреди экрана: на остальных экранах главная кнопка стоит у
   * правого края, и одна выбивающаяся выглядит ошибкой вёрстки.
   */
  return h('div',
    h('div.whead',
      h('div.whead-text',
        h('div.whead-title', { text: 'Привычки' }),
        h('div.whead-hint', {
          text: `${act.length} ${adapt.plural(act.length, 'активная', 'активные', 'активных')} сегодня`
            + (best ? ` · лучшая серия ${best} ${adapt.plural(best, 'день', 'дня', 'дней')}` : ''),
        })),
      addBtn),
    h('div.whabits.wnarrow', ...HABITS.map(hb => habitCard(hb, true))));
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
    chip(label, state.noteFilter === k, () => {
      state.noteFilter = k;
      repaint('.wnotes-box', notesScreen);
    })));

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

  return h('div.wnotes-box',
    h('div.whead',
      h('div.whead-text',
        h('div.whead-title', { text: 'Заметки' }),
        h('div.whead-hint', { text: 'С датой попадают в дела нужного дня, без даты — живут только здесь' })),
      addBtn),
    filters, grid);
}

/*
 * Настройки — разделами, как в мессенджерах: список, из него — в раздел.
 *
 * Раньше всё лежало одной простынёй, и любое переключение перерисовывало её
 * целиком — экран прыгал, а нужный пункт приходилось искать заново. Разделы
 * держат каждый экран коротким: почти всё видно без прокрутки, а «назад»
 * возвращает в оглавление, где человек уже ориентируется.
 */
const SET_PAGES = {
  account: { icon: 'user', title: 'Аккаунт', hint: () => store.user?.email ?? '' },
  look: { icon: 'paint-brush', title: 'Оформление', hint: () => ({ system: 'системная тема', light: 'светлая тема', dark: 'тёмная тема' })[state.theme] ?? '' },
  alarm: { icon: 'alarm-fill', title: 'Будильник', hint: () => (store.settings?.settings?.alarmMode === 'advanced' ? 'продвинутый' : 'простой') },
  sounds: { icon: 'speaker-high', title: 'Звуки', hint: () => state.sound },
  day: { icon: 'fork-knife', title: 'День и питание', hint: () => '' },
  data: { icon: 'database', title: 'Данные', hint: () => 'шаблон, экспорт, импорт' },
  devices: { icon: 'devices', title: 'Устройства', hint: () => devicesHint() },
};

function devicesHint() {
  const n = 1 + (store.devices?.length ?? 0);
  const word = n === 1 ? 'устройство' : n < 5 ? 'устройства' : 'устройств';
  return `${n} ${word}`;
}

/*
 * На телефоне разделы открываются переходом с «назад»: экран один, и это
 * привычный мессенджерный ход. На компьютере места хватает на оба —
 * список слева, открытый раздел справа, и нажатие просто меняет правую
 * часть. Переход туда-обратно на большом экране был бы лишним кликом.
 */
function settingsScreen() {
  const page = SET_PAGES[state.setPage] ? state.setPage : null;

  if (isPhone()) {
    if (page) return settingsPage(page);
    return h('div',
      h('div.whead-title', { text: 'Настройки', style: { marginBottom: '18px' } }),
      h('div.wsettings', settingsMaster(null)));
  }

  const cur = page ?? 'account';
  const bodies = {
    account: accountPanel,
    look: lookPanel,
    alarm: alarmPanel,
    sounds: soundsPanel,
    day: dayPanel,
    data: dataPanel,
    devices: devicesPanel,
  };
  return h('div',
    h('div.whead-title', { text: 'Настройки', style: { marginBottom: '18px' } }),
    h('div.wset-cols',
      settingsMaster(cur),
      h('div.wset-detail', bodies[cur]())));
}

/** Оглавление настроек; cur — подсвеченный раздел (на телефоне null). */
function settingsMaster(cur) {
  const list = h('div.wpanel-list');
  add(list, ...Object.entries(SET_PAGES).map(([k, p]) => {
    const row = h('button.wrow-link', {
      type: 'button', class: cur === k ? 'on' : '',
      onclick: () => set({ setPage: k }),
    });
    add(row, ico(p.icon, '17px'), h('span', { text: p.title }),
      h('span.wrow-link-val', { text: p.hint() }), ico('caret-right', '14px'));
    return row;
  }));
  return list;
}

/** Один раздел настроек: шапка с «назад» и своя панель. */
function settingsPage(key) {
  const p = SET_PAGES[key];
  const body = {
    account: accountPanel,
    look: lookPanel,
    alarm: alarmPanel,
    sounds: soundsPanel,
    day: dayPanel,
    data: dataPanel,
    devices: devicesPanel,
  }[key];

  return h('div',
    h('button.wset-back', {
      type: 'button',
      onclick: () => set({ setPage: null }),
    }, ico('caret-left', '16px'), h('span', { text: 'Настройки' })),
    h('div.whead-title', { text: p.title, style: { marginBottom: '18px' } }),
    h('div.wsettings', body()));
}

function lookPanel() {
  const themeSeg = h('div.wsegline');
  add(themeSeg, ...[['system', 'Система'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([k, label]) =>
    h('button', {
      type: 'button', text: label, class: state.theme === k ? 'on' : '',
      onclick: () => { state.theme = k; render(); api.saveSettings({ theme: k }).catch(fail); },
    })));

  const scaleSeg = h('div.wsegline');
  add(scaleSeg, ...SCALES.map(v =>
    h('button', {
      type: 'button', text: `${Math.round(v * 100)}%`, class: state.scale === v ? 'on' : '',
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

  return h('div.wpanel',
    cap('оформление'),
    h('div.wpanel-label', { text: 'Тема' }), themeSeg,
    h('div.wpanel-label', { text: 'Крупный текст' }), scaleSeg,
    h('div.wclock-cap', {
      text: 'увеличивается только текст, который читают: заметки, названия дел, подписи. '
        + 'Кнопки и меню остаются на месте',
      style: { marginTop: '8px' },
    }),
    h('div.wpanel-label', { text: 'Цвет приложения' }), swatches);
}

function dayPanel() {
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
  return day;
}

function soundsPanel() {
  const links = [
    { icon: 'alarm-fill', label: 'Звук будильника', value: state.sound, m: 'sound' },
    { icon: 'bell', label: 'Звук уведомлений', value: state.notifySound, m: 'sound' },
  ];
  const panel = h('div.wpanel-list', cap('звуки'));
  add(panel, ...links.map(l => {
    const row = h('button.wrow-link', { type: 'button', onclick: () => openLink(l.m, l.label) });
    add(row, ico(l.icon, '17px'), h('span', { text: l.label }),
      h('span.wrow-link-val', { text: l.value }), ico('caret-right', '14px'));
    return row;
  }));
  return panel;
}

function dataPanel() {
  const links = [
    { icon: 'calendar-check', label: 'Общее расписание', value: 'шаблон дня', m: 'template' },
    { icon: 'file-arrow-down', label: 'Экспорт данных', value: 'JSON', m: 'export' },
    { icon: 'file-arrow-up', label: 'Импорт данных', value: 'JSON', m: 'import' },
  ];
  const panel = h('div.wpanel-list', cap('шаблон и перенос'));
  add(panel, ...links.map(l => {
    const row = h('button.wrow-link', { type: 'button', onclick: () => openLink(l.m, l.label) });
    add(row, ico(l.icon, '17px'), h('span', { text: l.label }),
      h('span.wrow-link-val', { text: l.value }), ico('caret-right', '14px'));
    return row;
  }));
  return panel;
}

function devicesPanel() {
  /*
   * Текущий вход называем тем, чем он является: из приложения человек
   * читает «этот браузер» как враньё — он же с телефона.
   */
  const native = api.isNative();
  const panel = h('div.wpanel',
    cap('устройства'),
    h('div.wpanel-note', {
      text: 'Каждый вход — своё устройство: расписание и дела синхронизируются между всеми. '
        + 'Отключённое устройство выходит из аккаунта при первом же обращении.',
    }),
    h('div.wdevs',
      h('div.wdev',
        ico(native ? 'device-mobile' : 'browser', '17px'),
        h('div.wdev-body',
          h('div.wdev-name', { text: native ? 'Это приложение' : 'Этот браузер' }),
          h('div.wdev-seen', { text: store.user?.email ?? '' })),
        h('span.wdev-tag', { text: 'сейчас' })),
      ...store.devices.map(d => {
        const row = h('div.wdev',
          ico(d.platform === 'android' ? 'device-mobile' : 'laptop', '17px'),
          h('div.wdev-body',
            h('div.wdev-name', { text: d.name || 'Устройство' }),
            h('div.wdev-seen', {
              /*
               * Чем это устройство отличить от соседнего: платформа, откуда
               * заходило и когда. Без адреса список из двух «Android» ничего
               * не говорит — а по нему видно, своё это или чужое.
               */
              text: [
                d.platform === 'android' ? 'Android' : (d.platform || 'приложение'),
                d.lastIp || null,
                d.last_seen_at
                  ? `заходило ${adapt.shortDate(String(d.last_seen_at).slice(0, 10))}`
                  : 'ещё не заходило',
              ].filter(Boolean).join(' · '),
            })),
          h('button.wbtn-line', {
            type: 'button', text: 'Отключить',
            onclick: () => act(async () => {
              await api.devices.revoke(d.id);
              await data.loadAccount();
              note('Устройство отключено');
            }),
          }));
        return row;
      })));
  return panel;
}

/*
 * Аккаунт. В эталоне веб-версии этой панели нет, но в описании функционала
 * она есть, и без неё имя и пароль поменять нечем — а человек про них
 * спросил прямо.
 */
function accountPanel() {
  /*
   * Фото профиля — сверху: раздел открывается нажатием на персонажа, и
   * первым делом человек видит себя. Обрезка своя, прямоугольником со
   * скруглением — как принято в мессенджерах, только не кружок.
   */
  const hasAva = Boolean(store.settings?.settings?.avatar);
  const avaRow = h('div.wava-row',
    avatarEl('22px'),
    h('div.wrow',
      h('button.wbtn-line', { type: 'button', text: hasAva ? 'Сменить фото' : 'Добавить фото', onclick: pickAvatar }),
      hasAva ? h('button.wbtn-line', {
        type: 'button', text: 'Убрать',
        onclick: () => act(async () => { await data.saveSettings({ avatar: null }); }),
      }) : null));

  const account = h('div.wpanel-list', cap('аккаунт'), avaRow);
  const accountRows = [
    { icon: 'user', label: 'Имя', value: userName(), go: openAccount },
    { icon: 'envelope-simple', label: 'Почта', value: store.user?.email ?? '—', go: openAccount },
    { icon: 'lock-simple', label: 'Пароль', value: 'сменить', go: openAccount },
    // устройства — «про меня», им место у персонажа; разделы дня и оформления
    // живут в общем списке и здесь не дублируются
    { icon: 'devices', label: 'Устройства', value: devicesHint(), go: () => set({ setPage: 'devices' }) },
  ];
  add(account, ...accountRows.map(r => {
    const row = h('button.wrow-link', { type: 'button', onclick: r.go });
    add(row, ico(r.icon, '17px'), h('span', { text: r.label }),
      h('span.wrow-link-val', { text: r.value }), ico('caret-right', '14px'));
    return row;
  }));

  // выход — часть аккаунта, а не общий пункт настроек: выходят из аккаунта
  const out = h('button.wrow-link.wrow-danger', { type: 'button', onclick: () => logOut() });
  add(out, ico('sign-out', '17px'), h('span', { text: 'Выйти из аккаунта' }),
    h('span.wrow-link-val', { text: '' }), ico('caret-right', '14px'));
  add(account, out);
  return account;
}

// ── Фото профиля ─────────────────────────────────────────────

/*
 * Кадрирование живёт вне state: тянуть картинку мышью через полный render
 * значило бы перерисовывать всё приложение на каждый пиксель движения.
 * Канва рисует сама, state узнаёт только результат.
 */
const avaCrop = { img: null, zoom: 1, x: 0, y: 0 };

function pickAvatar() {
  const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      avaCrop.img = img;
      avaCrop.zoom = 1;
      avaCrop.x = 0;
      avaCrop.y = 0;
      set({ modal: 'avatar' });
    };
    img.onerror = () => setIn({ notice: 'Это не похоже на картинку' });
    img.src = url;
  };
  input.click();
}

/** Рисует картинку с текущим сдвигом и приближением в квадрат канвы. */
function drawAvaCrop(canvas) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const img = avaCrop.img;
  if (!img) return;
  const base = Math.max(size / img.width, size / img.height) * avaCrop.zoom;
  const w = img.width * base;
  const hh = img.height * base;
  // сдвиг ограничен так, чтобы в кадре не оказалось пустоты
  avaCrop.x = Math.min(Math.max(avaCrop.x, size - w), 0);
  avaCrop.y = Math.min(Math.max(avaCrop.y, size - hh), 0);
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, avaCrop.x, avaCrop.y, w, hh);
}

/**
 * Будильник. Настройки общие на человека, а не у каждой строки: «математика
 * средней сложности» — свойство человека, а не восьми утра вторника, и
 * задавать её каждому будильнику отдельно значило бы восемь раз повторить один
 * выбор.
 *
 * Звонит будильник на телефоне, и об этом сказано прямо. В браузере уведомление
 * показывает система, а звук играет страница — и только пока она открыта;
 * задачу пробуждения там ставить некому. Настройки при этом правятся и здесь:
 * они хранятся в профиле и доезжают до телефона синхронизацией.
 */
function alarmPanel() {
  const s = store.settings?.settings ?? {};
  const advanced = s.alarmMode === 'advanced';
  const graceOn = s.alarmGraceEnabled !== false;
  const graceSec = Number(s.alarmGraceSec ?? 60);
  const save = patch => data.saveSettings(patch).then(() => {
    render();
    // на телефоне настройка должна подействовать сразу, а не с очередной
    // синхронизацией: человек проверяет будильник тут же. Уезжает весь
    // профиль: pushAlarmConfig читает profile.settings, и что-либо меньшее
    // он молча превращал бы в значения по умолчанию, затирая на телефоне
    // только что сохранённое
    native.pushAlarmConfig?.(store.settings).catch(() => {});
  }).catch(fail);

  const panel = h('div.wpanel', cap('будильник'));
  add(panel, h('div.wpanel-note', {
    text: 'Будильник звонит на телефоне: там он поднимает экран, звучит в беззвучном режиме '
      + 'и переживает перезагрузку. Настройки ниже общие для всех будильников и доезжают '
      + 'до телефона сами.',
  }));

  // ── Режим ──
  const modeSeg = h('div.wsegline');
  add(modeSeg, ...[['simple', 'Простой'], ['advanced', 'Продвинутый']].map(([k, label]) =>
    h('button', {
      type: 'button', text: label, class: (s.alarmMode ?? 'simple') === k ? 'on' : '',
      onclick: () => save({ alarmMode: k }),
    })));
  add(panel, h('div.wpanel-label', { text: 'Режим' }), modeSeg,
    h('div.wclock-cap', {
      text: advanced
        ? 'выключается задачей — «просто нажал и спишь дальше» не выйдет'
        : 'звонит, нажали — выключился, как обычный будильник',
      style: { marginTop: '8px' },
    }));

  if (advanced) {
    // ── Окно «просто выключить» ──
    const graceSeg = h('div.wsegline');
    add(graceSeg, ...[[0, 'Нет'], [30, '30 с'], [60, '1 мин'], [300, '5 мин']].map(([v, label]) =>
      h('button', {
        type: 'button', text: label,
        class: (v === 0 ? !graceOn : graceOn && graceSec === v) ? 'on' : '',
        onclick: () => save(v === 0
          ? { alarmGraceEnabled: false }
          : { alarmGraceEnabled: true, alarmGraceSec: v }),
      })));
    add(panel, h('div.wpanel-label', { text: 'Сначала можно просто выключить' }), graceSeg,
      h('div.wclock-cap', {
        text: 'столько будильник звучит тихо и гаснет одной кнопкой — на случай, '
          + 'если вы уже встали сами. Дальше громкость идёт вверх и появляется задача',
        style: { marginTop: '8px' },
      }));

    // ── Пробуждение: как быстро громкость доходит до максимума ──
    const rampOn = s.alarmVolumeRamp !== false;
    const rampSec = Number(s.alarmRampSec ?? 30);
    const rampSeg = h('div.wsegline');
    add(rampSeg, ...[[0, 'Сразу'], [15, '15 с'], [30, '30 с'], [60, '1 мин']].map(([v, label]) =>
      h('button', {
        type: 'button', text: label,
        class: (v === 0 ? !rampOn : rampOn && rampSec === v) ? 'on' : '',
        onclick: () => save(v === 0
          ? { alarmVolumeRamp: false }
          : { alarmVolumeRamp: true, alarmRampSec: v }),
      })));
    add(panel, h('div.wpanel-label', { text: 'Пробуждение' }), rampSeg,
      h('div.wclock-cap', {
        text: rampOn
          ? `за сколько громкость дойдёт до максимума: ${rampSec === 15 ? '15 секунд' : rampSec === 60 ? 'минута' : '30 секунд'}. `
            + 'Даже если звук на телефоне стоял на минимуме — будильник поднимет его сам'
          : 'звонит сразу на полную. Даже с минимальной громкости телефона — будильник поднимет её сам',
        style: { marginTop: '8px' },
      }));

    // ── Задача ──
    // фолбэк — из native.ALARM_DEFAULTS: пока набор не сохранён, экран должен
    // показывать ровно то, что телефон выдаст на самом деле, а не своё мнение
    const types = Array.isArray(s.alarmTaskTypes) && s.alarmTaskTypes.length
      ? s.alarmTaskTypes : native.ALARM_DEFAULTS.alarmTaskTypes;
    /*
     * Каждая задача — строкой с описанием, а не голым чипом: «Значки» без
     * объяснения ничего не говорят, а ряд чипов на телефоне ломался косо.
     * Выбранные отмечены переключателем — тем же, что и остальные настройки.
     */
    const taskList = h('div.wstack-tight', { style: { marginTop: '4px' } });
    add(taskList, ...ALARM_TASKS.map(t => {
      const on = types.includes(t.k);
      const row = h('button.wrow-sw', {
        type: 'button',
        onclick: () => {
          const next = on ? types.filter(x => x !== t.k) : [...types, t.k];
          // без задачи будильник перестаёт быть продвинутым — математику не отнять
          save({ alarmTaskTypes: next.length ? next : ['math'] });
        },
      });
      add(row,
        h('div.wrow-sw-body',
          h('div.wrow-sw-title', { text: t.label }),
          h('div.wrow-sw-hint', { text: t.hint })),
        sw(on));
      return row;
    }));
    add(panel, h('div.wpanel-label', { text: 'Задача пробуждения' }), taskList,
      h('div.wclock-cap', {
        text: 'QR-код и шаги работают только на телефоне: камеры и датчика шагов в браузере нет. '
          + 'Если код потерялся или идти некуда, будильник через полторы минуты сам предложит '
          + 'пример — сложный, чтобы этим не пользовались вместо задачи',
        style: { marginTop: '8px' },
      }));

    if (types.includes('qr')) add(panel, ...qrRows(s, save));
    if (types.includes('steps')) add(panel, ...stepsRows(s, save));

    if (types.includes('math')) {
      const lvlSeg = h('div.wsegline');
      add(lvlSeg, ...[[1, 'Простая'], [2, 'Средняя'], [3, 'Сложная']].map(([v, label]) =>
        h('button', {
          type: 'button', text: label,
          class: Number(s.alarmTaskDifficulty ?? 1) === v ? 'on' : '',
          onclick: () => save({ alarmTaskDifficulty: v }),
        })));
      add(panel, h('div.wpanel-label', { text: 'Сложность математики' }), lvlSeg,
        h('div.wclock-cap', {
          text: ['однозначные на сложение', 'двузначные на сложение',
            'двузначные со сложением и вычитанием'][Number(s.alarmTaskDifficulty ?? 1) - 1],
          style: { marginTop: '8px' },
        }));
    }
  }

  // ── Разрешения: только на телефоне ──
  if (!native.available()) {
    add(panel, h('div.wclock-cap', {
      text: 'Разрешения будильника проверяются в приложении на телефоне — там же есть кнопка '
        + '«Проверить будильник», которая даёт ему прозвенеть по-настоящему.',
      style: { marginTop: '14px' },
    }));
    return panel;
  }

  const perms = state.alarmPerms;
  add(panel, h('div.wpanel-label', { text: 'Разрешения', style: { marginTop: '16px' } }));
  if (!perms) {
    add(panel, h('div.wclock-cap', { text: 'Смотрю…', style: { margin: '0' } }));
    return panel;
  }

  /*
   * Каждое разрешение — своей строкой, и рядом сказано, что без него сломается.
   * «Разрешите доступ» без объяснения человек не выдаёт, и правильно делает.
   */
  const list = h('div.wstack-tight', { style: { marginTop: '4px' } });
  add(list, ...ALARM_PERMS.filter(p => p.shown(perms)).map(p => {
    const ok = Boolean(perms[p.k]);
    const row = h('div.wperm', { class: ok ? 'ok' : '' });
    add(row,
      ico(ok ? 'check-circle-fill' : 'warning-circle-fill', '18px', ok ? 'wperm-ok' : 'wperm-bad'),
      h('div.wperm-body',
        h('div.wperm-title', { text: p.label }),
        h('div.wperm-hint', { text: ok ? p.done : p.why })),
      ok ? null : h('button.wbtn-line', {
        type: 'button', text: 'Разрешить',
        onclick: () => native.openSystemSettings(p.what).then(refreshAlarmPerms).catch(fail),
      }));
    return row;
  }));
  add(panel, list);

  if (perms.needsVendorAutostart) {
    add(panel, h('div.wclock-cap', {
      text: `На ${perms.manufacturer} автозапуск режется отдельно от системных разрешений: `
        + 'найдите NewDay в списке автозапуска оболочки и разрешите его, иначе будильник '
        + 'может не сработать после долгого простоя.',
      style: { marginTop: '10px' },
    }));
  }

  add(panel, h('div.wrow', { style: { marginTop: '14px' } },
    h('button.wbtn-line', {
      type: 'button', text: 'Проверить разрешения', onclick: refreshAlarmPerms,
    }),
    h('button.wbtn-line', {
      type: 'button', text: 'Проверить будильник',
      onclick: () => native.testAlarm(15, 'wakeup')
        .then(() => note('Через 15 секунд зазвонит — заблокируйте экран, чтобы увидеть, как это выглядит'))
        .catch(fail),
    })));
  return panel;
}

/**
 * Настройка задачи «QR-код».
 *
 * Привязать код можно только с телефона — камеры в браузере для этого нет.
 * Но увидеть, что код уже привязан и куда наклеен, полезно и с компьютера:
 * человек может править настройки там и должен понимать, что его ждёт утром.
 */
function qrRows(s, save) {
  const caps = state.missionCaps;
  const rows = [h('div.wpanel-label', { text: 'Код', style: { marginTop: '14px' } })];

  if (!native.available()) {
    rows.push(h('div.wclock-cap', {
      text: 'Привязать код можно в приложении на телефоне: нужна камера. '
        + (s.alarmQrLabel ? `Сейчас привязан код — ${s.alarmQrLabel}.` : 'Пока не привязан.'),
      style: { margin: '0' },
    }));
    return rows;
  }

  if (!caps) {
    rows.push(h('div.wclock-cap', { text: 'Смотрю…', style: { margin: '0' } }));
    return rows;
  }
  if (!caps.camera) {
    rows.push(h('div.wclock-cap', {
      text: 'На этом телефоне нет камеры — эта задача станет примером.',
      style: { margin: '0' },
    }));
    return rows;
  }

  const bound = Boolean(caps.qrBound);
  rows.push(h('div.wperm', { class: bound ? 'ok' : '' },
    ico(bound ? 'check-circle-fill' : 'warning-circle-fill', '18px',
      bound ? 'wperm-ok' : 'wperm-bad'),
    h('div.wperm-body',
      h('div.wperm-title', { text: bound ? 'Код привязан' : 'Код не привязан' }),
      h('div.wperm-hint', {
        text: bound
          ? (caps.qrLabel || s.alarmQrLabel || 'место не подписано')
          : 'без кода задача станет примером — сканировать будет нечего',
      })),
    h('button.wbtn-line', {
      type: 'button', text: bound ? 'Заново' : 'Привязать',
      onclick: () => act(async () => {
        const res = await native.bindCode(s.alarmQrLabel || '');
        await refreshMissionCaps();
        // note, не set({ notice }): notice живёт в шторке, а панель — экран
        if (res?.bound) note('Код привязан');
      }),
    })));

  /*
   * Подпись места — не украшение.
   *
   * В шесть утра «отсканируйте код» без уточнения вызывает единственный вопрос:
   * какой и где. Поэтому подпись показывается прямо на экране будильника.
   */
  rows.push(h('label.wfield', { style: { marginTop: '10px' } },
    h('span.wfield-cap', { text: 'Где наклеен' }),
    h('input.winput', {
      type: 'text', value: s.alarmQrLabel ?? '', placeholder: 'на чайнике', maxLength: 60,
      onchange: e => {
        const label = e.target.value.trim();
        native.setCodeLabel(label).catch(() => {});
        save({ alarmQrLabel: label });
      },
    })));

  if (bound) {
    rows.push(h('div.wrow', { style: { marginTop: '10px' } },
      h('button.wbtn-line', {
        type: 'button', text: 'Отвязать код',
        onclick: () => act(async () => {
          await native.unbindCode();
          await refreshMissionCaps();
          note('Код отвязан');
        }),
      })));
  }
  return rows;
}

/** Настройка задачи «шаги»: сколько идти и есть ли чем считать. */
function stepsRows(s, save) {
  const caps = state.missionCaps;
  const target = Number(s.alarmStepsTarget ?? 30);
  const rows = [h('div.wpanel-label', { text: 'Сколько шагов', style: { marginTop: '14px' } })];

  const seg = h('div.wsegline');
  add(seg, ...[10, 20, 30, 50].map(v => h('button', {
    type: 'button', text: String(v), class: target === v ? 'on' : '',
    onclick: () => save({ alarmStepsTarget: v }),
  })));
  rows.push(seg);

  if (!native.available()) {
    rows.push(h('div.wclock-cap', {
      text: 'Шаги считает телефон: в браузере датчика нет.',
      style: { marginTop: '8px' },
    }));
    return rows;
  }
  if (!caps) return rows;

  if (!caps.stepSensor) {
    rows.push(h('div.wclock-cap', {
      text: 'На этом телефоне нет шагомера — эта задача станет примером.',
      style: { marginTop: '8px' },
    }));
    return rows;
  }
  if (!caps.stepsGranted) {
    rows.push(h('div.wperm',
      ico('warning-circle-fill', '18px', 'wperm-bad'),
      h('div.wperm-body',
        h('div.wperm-title', { text: 'Нет доступа к распознаванию активности' }),
        h('div.wperm-hint', { text: 'без него шаги не посчитать, и задача станет примером' })),
      h('button.wbtn-line', {
        type: 'button', text: 'Разрешить',
        onclick: () => act(async () => {
          await native.requestMissionPermission('steps');
          await refreshMissionCaps();
        }),
      })));
  }
  return rows;
}

/** Заново спросить у телефона, что разрешено. */
function refreshAlarmPerms() {
  if (!native.available()) return Promise.resolve();
  return native.checkPermissions()
    .then(p => { state.alarmPerms = p; render(); })
    .catch(fail);
}

/** Заново спросить, что телефон умеет: камера, шагомер, привязанный код. */
function refreshMissionCaps() {
  if (!native.available()) return Promise.resolve();
  return native.missionCapabilities()
    .then(c => { state.missionCaps = c; render(); })
    .catch(() => null);
}

// ── Предпросмотр звука ───────────────────────────────────────

/*
 * Плеер один на всю страницу: два звука разом — это какофония, а не выбор.
 * Останавливается сам, когда шторка звука закрылась (см. render).
 */
let previewAudio = null;

function stopPreview() {
  if (!previewAudio) return;
  try { previewAudio.pause(); } catch { /* уже остановлен */ }
  if (previewAudio.src.startsWith('blob:')) URL.revokeObjectURL(previewAudio.src);
  previewAudio = null;
  if (state.soundPlay) { state.soundPlay = null; }
}

async function togglePreview(playKey, src) {
  if (state.soundPlay === playKey) { stopPreview(); render(); return; }
  stopPreview();
  try {
    let url = src;
    if (!url) {
      // свой звук: тег audio заголовков не умеет, а доступ живёт на токене
      const id = playKey.slice(2);
      url = URL.createObjectURL(await api.sounds.fileBlob(id));
    }
    previewAudio = new Audio(url);
    previewAudio.loop = false;
    previewAudio.onended = () => { stopPreview(); render(); };
    await previewAudio.play();
    state.soundPlay = playKey;
    render();
  } catch (e) {
    stopPreview();
    fail(e);
  }
}

/**
 * Свой звук, выбранный на другом устройстве, довозится сюда сам: настройка
 * синхронизировалась, а файла на телефоне ещё нет — без этой проверки
 * будильник молча падал бы на системный сигнал.
 */
async function ensureCustomSound() {
  const file = store.settings?.settings?.soundFile;
  if (!file || !/^u-(\d+)\./.test(file)) return;
  if (await native.hasSound(file)) return;
  const id = /^u-(\d+)\./.exec(file)[1];
  const blob = await api.sounds.fileBlob(id);
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  await native.saveSound(file, base64);
}

/** Имя файла своего звука на телефоне: u-<id>.<расширение из mime>. */
function customSoundFile(sd) {
  const ext = { 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a' }[sd.mime] ?? 'mp3';
  return `u-${sd.id}.${ext}`;
}

/**
 * Выбор своего звука. На телефоне файл заранее уезжает на устройство:
 * будильник звонит из убитого процесса и часто без сети — качать с сервера
 * в этот момент нечем.
 */
async function pickCustomSound(sd, forAlarm, key) {
  const file = customSoundFile(sd);
  if (forAlarm && native.available()) {
    const blob = await api.sounds.fileBlob(sd.id);
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    await native.saveSound(file, base64);
  }
  state[key] = sd.name;
  await data.saveSettings(forAlarm ? { sound: sd.name, soundFile: file } : { notifySound: sd.name });
  await native.pushAlarmConfig?.(store.settings);
  if (forAlarm && !native.available()) {
    note('Выбрано. На телефоне звук доедет сам, когда откроете приложение');
  }
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
    set({ modal: 'sound', soundKind: label, soundPlay: null });
    // подборка и свои звуки подгружаются следом: шторка уже открыта с
    // встроенным списком, а сеть дорисует своё без мигания
    if (!store.soundManifest) {
      fetch('/sounds/manifest.json').then(r => r.json())
        .then(m => { store.soundManifest = m; render(); })
        .catch(() => { store.soundManifest = []; });
    }
    api.sounds.list()
      .then(list => { store.mySounds = list; render(); })
      .catch(() => { store.mySounds = store.mySounds ?? []; });
    return;
  }
  set({ modal: 'template', tplRows: adapt.templateRows(store.template), tplEdit: null });
  // День нужен свежий: «взять из этого дня» берёт то, что в нём сейчас,
  // а на экране настроек день сам по себе не перечитывается
  Promise.all([data.loadTemplate(), data.loadDay(state.date)])
    .then(() => { fill(); set({ tplRows: adapt.templateRows(store.template) }); })
    .catch(fail);
}

/**
 * Выход из аккаунта забирает и локальную копию.
 *
 * Копия нужна, чтобы приложение открывалось без сети, — но она же означает, что
 * чужой день остался бы на устройстве и открылся бы у следующего вошедшего,
 * пока нет связи. Выходя, человек рассчитывает, что его данных здесь больше
 * нет.
 */
function logOut() {
  data.forgetLocal();
  // токен устройства стирается после ответа сервера: запрос на выход сам
  // ходит с этим токеном, и сервер по нему же его отзывает. Сотри раньше —
  // отзывать было бы нечем, и токен остался бы жив на сервере
  return api.POST('/auth/logout')
    .finally(() => { api.setDeviceToken(null); location.href = '/login.html'; });
}

// ── Помощник ─────────────────────────────────────────────────

/**
 * Помощник открывается чистым.
 *
 * Раньше шторка просто ставила шаг «ввод», не тронув остального: человек
 * закрывал её, открывал снова — и видел прошлый текст, а иногда и прошлый
 * разобранный план. Выглядело так, будто приложение уже что-то записало, хотя
 * это был мусор от предыдущего раза, и диктовать поверх него никто не просил.
 */
function openAi() {
  set({
    modal: 'ai', aiStep: 'input',
    aiText: '', aiItems: null, aiOff: {}, aiQuestion: '', aiOptions: [],
    notice: null,
  });
}

// ── Аккаунт ──────────────────────────────────────────────────

function openAccount() {
  set({
    modal: 'account', notice: null,
    accName: store.settings?.displayName ?? '',
    passOld: '', passNew: '', passNew2: '',
    // сам секрет показывается один раз, сразу после выпуска
    tokenShown: null,
  });
  data.loadTokens().then(() => setIn({})).catch(fail);
}

/**
 * Токен для интеграций.
 *
 * Секрет виден один раз — в ответе на выпуск. Сервер хранит только хеш, и
 * «показать ещё раз» невозможно даже ему: если человек не сохранил, остаётся
 * перевыпустить. Поэтому свежий токен держим в состоянии шторки, а не в
 * общем хранилище: перерисовка экрана его не потеряет, а закрытие — потеряет,
 * и это правильно.
 */
function issueToken() {
  /*
   * `act`, а не `busy`: `busy` закрывает шторку, а закрыть её сразу после
   * выпуска — значит унести секрет вместе с ней. Скопировать его человек
   * должен успеть.
   */
  act(data.createToken('Интеграция').then(t => {
    state.tokenShown = t.token;
    return data.loadTokens();
  }), 'Токен выпущен — скопируйте его сейчас');
}

/** Перевыпуск — это отзыв старого и выпуск нового: сам секрет не восстановить. */
function reissueToken(id) {
  act((async () => {
    await data.revokeToken(id);
    const t = await data.createToken('Интеграция');
    state.tokenShown = t.token;
    await data.loadTokens();
  })(), 'Токен перевыпущен — старый больше не действует');
}

function revokeToken(id) {
  act(data.revokeToken(id).then(() => {
    state.tokenShown = null;
    return data.loadTokens();
  }), 'Токен удалён');
}

/**
 * Копирование в буфер. `navigator.clipboard` работает только на https и на
 * localhost, поэтому запас — выделить текст и дать скопировать руками; молча
 * ничего не делать нельзя.
 */
async function copyText(text, okText = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
    note(okText);
  } catch {
    const field = document.querySelector('.wmodal [name="tokenValue"]');
    if (field) { field.focus(); field.select(); }
    note('Скопируйте вручную: Ctrl+C');
  }
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
const CAL_FIELD = { note: 'noteDate', row: 'rowDate', meal: 'mealDate' };

function openCalendar(target = 'day') {
  const base = state[CAL_FIELD[target]] ?? state.date;
  const [y, m] = base.split('-').map(Number);
  set({ modal: 'calendar', calY: y, calM: m - 1, calFor: target, calBack: state.modal });
}

/** Выбранный день уходит туда, откуда календарь позвали. */
function pickDate(key) {
  const field = CAL_FIELD[state.calFor];
  if (field) { set({ modal: state.calBack, [field]: key }); return; }
  closeModal();
  go(key);
}

const shiftCal = n => ({
  calY: state.calM + n < 0 ? state.calY - 1 : state.calM + n > 11 ? state.calY + 1 : state.calY,
  calM: (state.calM + n + 12) % 12,
});

function openRow(r, date = state.date) {
  /*
   * Повтор читается из правила самой строки: блок и напоминание — одна
   * сущность, и повторяться может любая. Раньше повтор жил только в шторке
   * напоминания, и «каждый вторник зал» задать было нечем.
   */
  const seriesId = r.seriesId ?? r.raw?.series_id ?? null;
  const rule = seriesId ? (store.series ?? []).find(x => x.id === seriesId) : null;
  const mask = rule?.byweekday ?? 0;

  set({
    modal: 'row', rowId: r.id, rowDate: date,
    /*
     * Прежний день помним отдельно от открытого. Строку правят и из недельной
     * сетки, и из месяца — там колонка своя, а открытый день чужой: сравнение с
     * `state.date` считало правку среды переносом с понедельника, и строка
     * пересоздавалась. Вместе с ней слетала галочка, терялся повтор и рвалась
     * связь с приёмом пищи.
     */
    rowWasDate: date,
    /*
     * Конец у момента считаем от начала и прижимаем к суткам: «напомнить в
     * 23:50» при переключении на блок давало 24:20, и сервер отказывал.
     */
    rowStart: r.start, rowEnd: Math.min(1439, r.end ?? r.start + 30), rowField: 'start',
    rowTitle: r.title, rowAlarm: r.alarm, rowLeads: leadsOf(r),
    rowKind: r.isReminder ? 'reminder' : (r.kind ?? 'normal'),
    rowColor: r.color ?? null, rowConflict: 'overlap', rowNote: r.note ?? '', notice: null,
    rowRepeat: rule ? (REPEAT_OF[rule.freq] ?? 'Разово') : 'Разово',
    rowSeriesId: seriesId,
    rowDays: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, Boolean(mask & (1 << i))])),
  });
}

/** Новый блок: время либо протянутое, либо предложенное кнопкой. */
function newRow({ date = state.date, start = 600, end = 660, kind = 'normal' } = {}) {
  set({
    modal: 'row', rowId: 'new', rowDate: date, rowWasDate: date,
    rowStart: start, rowEnd: Math.min(1439, end), rowField: 'start',
    rowTitle: '', rowAlarm: kind === 'reminder' ? 'notify' : 'off', rowLeads: ['at'],
    rowKind: kind, rowColor: null, rowConflict: 'overlap', rowNote: '', notice: null,
    rowRepeat: 'Разово', rowSeriesId: null,
    rowDays: { 0: false, 1: false, 2: false, 3: false, 4: false, 5: false, 6: false },
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
    color: state.rowColor, kind: state.rowKind, note: state.rowNote,
  });
  if (!body.title) {
    needField('rowTitle', state.rowKind === 'reminder' ? 'Впишите, о чём напомнить' : 'Впишите, что делаем');
    return;
  }

  const date = state.rowDate ?? state.date;
  const wasDate = state.rowWasDate ?? state.date;
  const other = state.rowKind === 'reminder' ? null : crossing();
  const way = other ? state.rowConflict : 'overlap';

  const freq = FREQ_OF[state.rowRepeat];
  const mask = Object.entries(state.rowDays)
    .reduce((acc, [i, on]) => (on ? acc | (1 << Number(i)) : acc), 0);
  /*
   * Дни недели имеют смысл только у еженедельного, и посылать их надо всегда:
   * без явной маски сервер берёт «все дни», и «каждый вторник» приходило бы
   * каждый день. Пусто значит «в тот же день недели» — считаем из даты.
   */
  const byweekday = freq !== 'weekly' ? undefined
    : (mask || (1 << ((new Date(`${date}T00:00:00`).getDay() + 6) % 7)));

  if (state.rowId === 'new') {
    busy(applyConflict(date, other, way, body.endMin).then(() => (freq
      ? data.createRepeat({ freq, startDate: date, row: body, byweekday })
      : data.createRow(date, body))));
    return;
  }

  /*
   * Правка существующей. Дату строки нельзя поменять на месте — она часть её
   * адреса, поэтому при переносе строку пересоздаём в нужном дне.
   */
  busy((async () => {
    await applyConflict(date, other, way, body.endMin);

    let id = state.rowId;
    if (date !== wasDate) {
      /*
       * Сначала создаём в новом дне, потом убираем из старого. Обратный
       * порядок терял запись целиком, если создание не прошло: в старом дне
       * её уже нет, в новом ещё нет. Лишняя копия — беда меньшая, её видно и
       * её можно убрать.
       */
      const made = await data.createRow(date, body);
      await data.removeRow(wasDate, state.rowId);
      id = made?.id ?? id;
    } else {
      await data.updateRow(wasDate, state.rowId, body);
    }

    /*
     * Повтор приводим к выбранному, и это не только про правило — сама строка
     * должна быть к нему привязана или отвязана.
     *
     * Было «Разово», стало «Ежедневно»: одного правила мало. Строка остаётся
     * ничьей, сервер видит, что повтор в этом дне не материализован, и создаёт
     * вторую такую же — на экране появлялся близнец.
     *
     * Было правило, стало «Разово»: сначала отвязываем строку, потом убираем
     * правило. Иначе удаление правила забирало с собой и её — «Разово»
     * означало «удалить», хотя человек просил всего лишь не повторять.
     */
    const rule = state.rowSeriesId
      ? (store.series ?? []).find(s => s.id === state.rowSeriesId)
      : null;

    if (!freq) {
      if (!rule) return;
      await data.detachRow(date, id);
      await data.removeSeries(rule.id);
      return;
    }
    if (rule) {
      /*
       * Начало правила не двигаем: правка вторничного зала в августе не должна
       * отменять июльские вторники. Меняем только то, о чём спросили, — саму
       * частоту и дни недели.
       */
      await data.updateSeries(rule.id, { freq, ...(byweekday ? { byweekday } : {}) });
      return;
    }
    const made = await data.createRepeat({ freq, startDate: date, row: body, byweekday });
    if (made?.id) await data.attachRow(date, id, made.id);
  })());
}

/**
 * Удаление строки повтора — это три разных желания, и путать их нельзя:
 * убрать только этот день, прекратить с этого дня, убрать весь повтор.
 */
function removeRowScope(scope) {
  if (state.rowId === 'new') { closeModal(); return; }
  const date = state.rowDate ?? state.date;
  if (scope === 'series') { busy(data.removeSeries(state.rowSeriesId)); return; }
  if (scope === 'from') { busy(data.endSeries(state.rowSeriesId, date)); return; }
  busy(data.removeRow(date, state.rowId));
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
  if (!title) { needField('habitTitle', 'Впишите название'); return; }

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
  const blockId = m?.raw?.schedule_item_id ?? null;

  /*
   * Длительность берём у самого блока, а не из прошлого состояния.
   *
   * Раньше здесь оставалось значение от предыдущей правки, и открыв приём,
   * занимающий полтора часа, человек видел «30 мин» — а «Готово» молча
   * сжимало блок до получаса.
   *
   * Блока может уже не быть: его удалили прямо в расписании. Тогда и ссылку
   * не держим, иначе сохранение упиралось бы в «строка не найдена».
   */
  const block = blockId
    ? (store.day?.schedule ?? []).find(r => r.id === blockId)
    : null;
  const blockEnd = block && block.end_min !== null ? Math.max(start + 5, block.end_min) : null;

  set({
    modal: 'meal', mealId: m?.id ?? 'new', notice: null,
    mealTitle: m?.title === 'Без названия' ? '' : (m?.title ?? ''),
    mealKcal: m?.kcal === null || m?.kcal === undefined ? '' : String(m.kcal),
    mealMode: mode,
    mealStart: start,
    /*
     * Конец у окна свой, у точного времени — конец его блока. Готовка бывает
     * дольше самой еды, поэтому запас берём от блока, а не считаем получасом.
     */
    mealEnd: m?.end ?? blockEnd ?? (mode === 'window' ? start + 120 : start + 30),
    mealField: 'start',
    mealDate: state.date,
    mealLeads: m ? m.leads : ['at'],
    mealSched: Boolean(block),
    mealSchedId: block ? blockId : null,
    mealConflict: 'overlap',
  });
}

/**
 * Сколько времени приём пищи займёт в расписании.
 *
 * Диапазон один и тот же в обоих режимах: «обед с 12:00 до 14:00» стоит в
 * сетке окном, а «в 12:00, готовлю два часа» — блоком той же длины. Раньше у
 * точного времени было пять готовых длительностей, и полтора часа на плиту
 * задать было нечем.
 */
const mealBlockEnd = () => Math.max(state.mealStart + 5, state.mealEnd);

/*
 * Пересечение считаем в том дне, который выбран плиткой, а не в открытом.
 * Иначе предупреждение приходило про чужой день: человек переставлял обед на
 * завтра, а ему показывали сегодняшний созвон — и наоборот, настоящее
 * пересечение в завтрашнем дне проходило молча.
 */
const mealConflictBlock = () => {
  const end = mealBlockEnd();
  const date = state.mealDate ?? state.date;
  const other = crossingIn(date, state.mealStart, end, state.mealSchedId);
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
  if (!body.title) { needField('mealTitle', 'Впишите, что едим'); return; }

  /*
   * День — часть адреса приёма пищи, поменять его на месте нельзя. При
   * переезде убираем из старого дня и заводим в новом, забирая с собой и
   * блок расписания: иначе завтрашний ужин остался бы стоять сегодня.
   */
  const wasDate = state.date;
  const date = state.mealDate ?? wasDate;
  const moved = date !== wasDate && state.mealId !== 'new';
  /*
   * В расписание попадает и окно, а не только точное время: «обед с 12:00 до
   * 14:00» — это тоже занятое время, и в сетке он должен стоять окном. Дела
   * внутри такого окна рисуются вложенными — многодорожечность для этого и
   * сделана.
   */
  const wantBlock = state.mealMode !== 'none' && state.mealSched;
  const end = mealBlockEnd();
  /*
   * Блок создаём с включённым уведомлением, если сроки заданы. Без `alarmMode`
   * он получал «без напоминания», и планировщик пропускал его первым же
   * условием: колокольчик у приёма пищи горел, а уведомление не приходило.
   */
  const blockBody = {
    title: body.title, startMin: state.mealStart, endMin: end, kind: 'meal',
    alarmMode: state.mealLeads.length ? 'notify' : 'none',
    remindBefore: adapt.leadMinutes(state.mealLeads),
  };

  const job = (async () => {
    const other = wantBlock ? crossingIn(date, state.mealStart, end, state.mealSchedId) : null;
    await applyConflict(date, other, state.mealConflict, end);

    /*
     * Порядок при переезде: сначала создать в новом дне, потом убрать из
     * старого. Обратный порядок терял запись целиком, если создание не прошло —
     * в старом дне её уже нет, в новом ещё нет, и повторное «Готово» упиралось
     * в «Запись не найдена» навсегда. Лишняя копия — беда меньшая.
     */
    const meal = state.mealId === 'new' || moved
      ? await data.createMeal(date, body)
      : await data.updateMeal(date, state.mealId, body);
    const mealId = meal?.id ?? state.mealId;
    // после переезда прежней ссылки на блок нет — он остался в старом дне
    const schedId = moved ? null : state.mealSchedId;

    if (wantBlock && schedId) {
      await data.updateRow(date, schedId, blockBody);
    } else if (wantBlock) {
      const block = await data.createRow(date, blockBody);
      if (block?.id) await data.updateMeal(date, mealId, { scheduleItemId: block.id });
    } else if (schedId) {
      await data.removeRow(date, schedId);
      await data.updateMeal(date, mealId, { scheduleItemId: null });
    }

    if (moved) {
      if (state.mealSchedId) await data.removeRow(wasDate, state.mealSchedId);
      await data.removeMeal(wasDate, state.mealId);
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
    // новая заметка по умолчанию на дату, и дата эта — сегодня: человек чаще
    // пишет про сегодняшний день, а не про тот, который листал неделю назад
    noteDated: n ? n.dated : true,
    noteDate: n?.dateKey ?? store.settings?.today ?? state.date,
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
  if (!title && !text.trim()) { needField('noteTitle', 'Заметка пустая: впишите заголовок или текст'); return; }

  const wasDated = typeof state.noteId === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.noteId);
  const wasFree = state.noteId !== 'new' && !wasDated;
  const date = state.noteDate ?? state.date;

  /*
   * Заметка на день одна, поэтому запись в чужой день затирала бы то, что там
   * уже написано, — молча и без возврата. Пока заметок на день не может быть
   * несколько, честнее не дать этого сделать и сказать, куда идти.
   */
  if (state.noteDated && state.noteId !== date) {
    const busyDay = NOTES.find(n => n.dateKey === date);
    if (busyDay) {
      setIn({ notice: `На ${adapt.shortDate(date)} уже есть заметка «${busyDay.title}» — откройте её и дополните` });
      return;
    }
  }

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
  'Разово': null, 'Ежедневно': 'daily', 'По дням недели': 'weekly',
  'Ежемесячно': 'monthly', 'Ежегодно': 'yearly',
};

const REPEAT_OF = Object.fromEntries(Object.entries(FREQ_OF).map(([k, v]) => [v, k]));

/*
 * Своей шторки у напоминания больше нет: блок времени и напоминание правятся
 * одним редактором строки, где тип выбирается двумя кнопками. Две шторки на
 * одну сущность значили два места, где приходится держать одно и то же —
 * повтор, сроки, цвет, — и они начали расходиться.
 */

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
    tplColor: r?.color ?? null,
    /*
     * Тип и комментарий редактор строки шаблона не показывает, но и не теряет:
     * шаблон пишется набором целиком, и стоило открыть одну строку, как
     * напоминание в соседней превращалось в обычный блок.
     */
    tplKind: r?.kind ?? 'normal',
    tplNote: r?.note ?? '',
    notice: null,
  });
}

function saveTplRow() {
  const title = String(state.tplTitle ?? '').trim();
  if (!title) { note('Впишите, что делаем'); return; }
  const rows = [...(state.tplRows ?? [])];
  const row = {
    start: state.tplStart, end: state.tplEnd, title,
    alarm: state.tplAlarm, leads: state.tplLeads,
    // цвет, тип и комментарий в шаблоне не выбирают, но и не теряют: правка
    // строки их сохраняет
    color: state.tplColor ?? null,
    kind: state.tplKind ?? 'normal',
    note: state.tplNote ?? '',
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
  job.then(() => {
    state.busy = false;
    state.modal = null;
    // сообщение о проверке относилось к шторке: после удачного сохранения оно
    // висело красной плашкой над днём, и человек читал это как «не сохранилось»
    state.notice = null;
    state.noticeBad = false;
    return reload();
  }).catch(e => { state.busy = false; fail(e); });
}

/*
 * Закрывая шторку, гасим и её сообщение.
 *
 * Сообщение о проверке относилось к шторке, а висело над днём: человек выходил
 * из редактора, а сверху по-прежнему стояло «Впишите, что делаем». Это читается
 * как ошибка экрана, которой нет.
 */
const closeModal = () => set({ modal: null, notice: null, noticeBad: false });

const TITLES = {
  /*
   * Редактор один, а заголовок называет вещи своими именами: напоминание —
   * та же строка расписания, но человек-то заводил именно напоминание.
   */
  row: () => (state.rowKind === 'reminder'
    ? (state.rowId === 'new' ? 'Новое напоминание' : 'Напоминание')
    : (state.rowId === 'new' ? 'Новый блок' : 'Строка расписания')),
  schedule: () => 'Расписание дня',
  ai: () => 'Помощник',
  habit: () => (state.habitId === 'new' ? 'Новая привычка' : 'Привычка'),
  note: () => 'Заметка',
  task: () => 'Задача',
  food: () => 'Питание на день',
  meal: () => 'Приём пищи',
  calendar: () => 'Выбор дня',
  account: () => 'Аккаунт',
  sound: () => state.soundKind,
  avatar: () => 'Фото профиля',
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
  state.notice ? h('div.wnotice', { class: state.noticeBad ? 'bad' : '', text: state.notice }) : null,
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

/*
 * Задачи пробуждения. Математика — основная и всегда доступна: она работает на
 * любом устройстве и не зависит ни от камеры, ни от датчиков. QR и шаги живут
 * только на телефоне, и если код потерялся или идти некуда, будильник
 * предлагает математику — иначе выключить его было бы нечем.
 */
const ALARM_TASKS = [
  { k: 'math', label: 'Математика', hint: 'решить пример — работает всегда и везде' },
  { k: 'qr', label: 'QR-код', hint: 'дойти и отсканировать код, наклеенный не у кровати' },
  { k: 'steps', label: 'Шаги', hint: 'встать и пройтись — считает шагомер телефона' },
  { k: 'code', label: 'Код', hint: 'переписать показанные цифры — глаза придётся открыть' },
  { k: 'icons', label: 'Значки', hint: 'нажать значки в показанном порядке' },
];

/*
 * Разрешения будильника. У каждого — зачем оно, потому что «разрешите доступ»
 * без объяснения человек не выдаёт, и правильно делает.
 */
const ALARM_PERMS = [
  {
    k: 'notifications', what: 'notifications', label: 'Уведомления',
    why: 'без них будильник не покажется на экране и не зазвонит',
    done: 'разрешены',
    shown: () => true,
  },
  {
    k: 'exactAlarm', what: 'exactAlarm', label: 'Точное время',
    why: 'без него система разбудит «примерно тогда» — на четверть часа позже',
    done: 'будильник сработает точно в срок',
    shown: p => p.sdk >= 31,
  },
  {
    k: 'batteryUnrestricted', what: 'battery', label: 'Работа в фоне',
    why: 'экономия батареи усыпляет приложение, и будильник может не прозвенеть',
    done: 'приложение не усыпляется',
    shown: () => true,
  },
  {
    k: 'overlay', what: 'overlay', label: 'Поверх других приложений',
    why: 'без него экран будильника не поднимется, если телефоном в этот момент пользуются',
    done: 'экран будильника поднимется поверх всего',
    shown: () => true,
  },
  {
    k: 'fullScreenIntent', what: 'fullScreenIntent', label: 'Экран на весь экран',
    why: 'без него будильник придёт полоской уведомления, а не экраном',
    done: 'будильник откроется на весь экран',
    shown: p => p.sdk >= 34,
  },
];

/*
 * Два размера текста, а не три. Полуторный на телефоне не оставлял места ни
 * строке расписания, ни полосе разделов: экран превращался в две карточки и
 * прокрутку. Крупнее 125 % имеет смысл делать системным увеличением телефона,
 * а не своим.
 */
/*
 * Крупный текст — 110 %, а не 125: четверть сверху ломала телефонную
 * раскладку (почта складывалась вертикально, привычки не влезали), и
 * выглядело это хуже, чем читалось. Десятая доля — ощутимая прибавка
 * читаемости без переломанных строк.
 */
const SCALES = [1, 1.1];

/**
 * Подписи трёх плиток времени правятся на месте.
 *
 * Нужно там, где перерисовывать шторку нельзя: пока человек набирает число,
 * возвращать в поле вычисленное значение — значит мешать ему набирать.
 *
 * Плитки одни и те же везде, где задаётся промежуток: строка расписания,
 * приём пищи, шаблон. Подписи и служат ключом — искать по ним надёжнее, чем
 * заводить каждому редактору свой набор имён.
 */
/**
 * Поле плитки времени: смотрится как надпись, по двойному нажатию — ввод.
 *
 * Сетка часов быстрее для «примерно в десять», но «в 9:47» ею не набрать, а
 * с клавиатуры это две секунды. Одиночное нажатие оставлено плитке — оно
 * переключает, что именно правит сетка; ввод открывается двойным, чтобы одно
 * другому не мешало.
 *
 * Принимает «9:47», «947», «9.47» и «19» — так же, как разбирает время сервер.
 */
function timeInput(value, key, onDone) {
  const input = h('input', {
    value, readOnly: true, tabIndex: -1, name: `tile-${key}`,
    title: 'Двойное нажатие — ввести с клавиатуры',
    ondblclick: e => {
      const el = e.target;
      el.readOnly = false;
      el.tabIndex = 0;
      el.select();
    },
    onblur: e => {
      const el = e.target;
      if (el.readOnly) return;
      el.readOnly = true;
      el.tabIndex = -1;
      onDone(el.value);
    },
    onkeydown: e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      if (e.key === 'Escape') { e.target.value = value; e.target.blur(); }
      // нажатия внутри поля не должны трогать плитку под ним
      e.stopPropagation();
    },
    onclick: e => { if (!e.target.readOnly) e.stopPropagation(); },
  });
  return input;
}

/** «9:47», «947», «9.47», «19» → минуты от полуночи; иначе null. */
function parseTime(raw) {
  const s = String(raw ?? '').trim().replace(/[.,]/g, ':');
  let hh; let mm;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) { hh = Number(m[1]); mm = Number(m[2]); }
  else if (/^\d{1,2}$/.test(s)) { hh = Number(s); mm = 0; }
  else if (/^\d{3,4}$/.test(s)) { hh = Number(s.slice(0, -2)); mm = Number(s.slice(-2)); }
  else return null;
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** «90», «1:30», «1 ч 30 мин», «2ч» → минуты; иначе null. */
function parseDur(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const hm = /^(\d{1,2})\s*(?:ч|:)\s*(\d{1,2})?\s*(?:мин|м)?$/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] ?? 0);
  const only = /^(\d{1,4})\s*(мин|м)?$/.exec(s);
  if (only) return Number(only[1]);
  return null;
}

function paintTiles(start, end) {
  const values = { начало: hhmm(start), длится: durLabel(Math.max(5, end - start)), конец: hhmm(end) };
  for (const tile of document.querySelectorAll('.wmodal .wtile')) {
    const cap = tile.querySelector('.wtile-cap')?.textContent;
    const field = tile.querySelector('input');
    if (cap && field && values[cap] !== undefined) field.value = values[cap];
  }
}


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
 *
 * `endKey` — где лежит конец: у строки расписания это `rowEnd`, у приёма пищи
 * `mealEnd`. Сетка одна на всех: промежуток задаётся всюду одинаково, и
 * привыкать к разному не приходится.
 */
function durPicker(rs, dur, endKey = 'rowEnd') {
  const chips = h('div.wwrap');
  add(chips, ...DURS.map(v => sheetChip(durLabel(v), dur === v,
    () => setIn({ [endKey]: Math.min(1439, rs + v) }), 'wchip-dur')));

  return h('div.wclock',
    h('div.wclock-cap', { text: 'конец посчитается сам' }),
    chips,
    h('div.wrow', { style: { marginTop: '12px' } },
      h('span.wclock-cap', { text: 'своё:', style: { margin: '0' } }),
      /*
       * Поле не перерисовывается на каждую цифру: состояние меняется молча, а
       * подписи плиток правятся на месте.
       *
       * Иначе «45» набрать было нельзя. Перерисовка возвращала в поле
       * вычисленное значение: после первой цифры длительность становилась 4,
       * поле показывало минимальные «5», и вторая цифра дописывалась к ним —
       * выходило 55. То же с 15, 20, 30. А применение по уходу из поля роняло
       * первое нажатие «Готово»: кнопку пересоздавали до того, как отпустили
       * мышь.
       */
      h('input.wnum', {
        name: `${endKey}Dur`, value: String(dur), inputMode: 'numeric',
        oninput: e => {
          const n = Number(String(e.target.value).replace(/\D+/g, ''));
          if (!n) return;
          state[endKey] = Math.min(1439, rs + Math.max(5, n));
          paintTiles(rs, state[endKey]);
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
  /*
   * Двигать следующие нечем нарочно: сдвиг тянет за собой весь остаток дня,
   * а человек правил один блок. Остаётся то, что меняет только соседа:
   * оставить внахлёст (так и стоит по умолчанию — пересечение бывает
   * настоящим) или сократить следующее.
   */
  const ways = [
    { k: 'overlap', label: 'Оставить внахлёст', icon: 'stack-simple' },
    // сократить можно только то, от чего что-то останется
    ...(other.end > end + 5 ? [{ k: 'trim', label: 'Сократить следующее', icon: 'arrows-in-line-vertical' }] : []),
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

/**
 * Способ расхождения применяется до записи: иначе правка соседа легла бы на
 * старые времена. Внахлёст ничего не меняет — это и есть согласие оставить как
 * есть.
 */
function applyConflict(date, other, way, end) {
  if (!other || way !== 'trim') return Promise.resolve();
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
  /*
   * Часы и минуты помечены отдельно: на телефоне двенадцать колонок не влезают,
   * и правый край сетки уезжал за экран — часы 11 и 23 были обрезаны пополам.
   * Там их восемь и шесть, как в прототипе телефона.
   */
  const grid = h('div.wclock-grid', { class: step === 1 ? 'wclock-hours' : 'wclock-mins' });
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
     * Дата — тут же: и блок, и напоминание могут переехать на другой день.
     * Раньше день менялся только у напоминания, и перенести блок было нечем.
     */
    const [dy, dm, dd] = String(state.rowDate ?? state.date).split('-').map(Number);
    const dayTile = h('div.wtile', { onclick: () => openCalendar('row') });
    add(dayTile, h('span.wtile-cap', { text: 'день' }),
      h('input', { value: `${dd} ${MONTHS[dm - 1]} ${dy}`, readOnly: true, tabIndex: -1 }));

    /*
     * Повтор — у любой строки, не только у напоминания: «каждый вторник зал»
     * такое же обычное дело, как ежегодный день рождения.
     */
    const repeats = h('div.wwrap');
    add(repeats, ...REPEATS.map(r => sheetChip(r, state.rowRepeat === r, () => setIn({ rowRepeat: r }))));

    const weekdays = h('div.wdays7');
    add(weekdays, ...DOW_SHORT.map((d, i) =>
      h('button', {
        type: 'button', text: d, class: state.rowDays[i] ? 'on' : '',
        onclick: () => setIn(s => ({ rowDays: { ...s.rowDays, [i]: !s.rowDays[i] } })),
      })));

    /*
     * У повтора удаление — три разных желания. Показываем их отдельно: одно
     * «Удалить» тихо решало бы за человека, то ли день, то ли весь повтор.
     */
    const repeating = Boolean(state.rowSeriesId);
    const removes = h('div.wstack-tight',
      h('button.wbtn-quiet', {
        type: 'button', text: 'Убрать только в этот день', disabled: state.busy,
        onclick: () => removeRowScope('day'),
      }),
      h('button.wbtn-quiet', {
        type: 'button', text: 'Прекратить с этого дня', disabled: state.busy,
        onclick: () => removeRowScope('from'),
      }),
      h('button.wbtn-quiet', {
        type: 'button', text: 'Убрать повтор целиком', disabled: state.busy,
        onclick: () => removeRowScope('series'),
      }));

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
      add(tile, h('span.wtile-cap', { text: label }),
        timeInput(value, k, next => {
          if (k === 'dur') {
            const mins = parseDur(next);
            if (mins !== null) setIn({ rowEnd: rs + Math.min(Math.max(mins, 5), 1440 - rs) });
            return;
          }
          const t = parseTime(next);
          if (t === null) return;
          if (k === 'start') {
            // сдвиг начала тянет конец за собой, сохраняя длительность
            setIn({ rowStart: t, rowEnd: moment ? state.rowEnd : Math.min(1440, t + dur) });
          } else {
            setIn({ rowEnd: Math.max(rs + 5, t) });
          }
        }));
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
      // конец прижимаем к суткам: часовой блок с началом в 23:00 давал 24:00,
      // и сервер отказывал — «конец должен быть от 0 до 1439»
      else setIn({ rowStart: at, rowEnd: Math.min(1439, at + dur) });
    };

    /*
     * Сетка часов нужна и напоминанию: у него нет длительности, но время-то
     * есть. Раньше её для момента не рисовали вовсе, и нажатие на «начало»
     * ничем не отвечало — время напоминания было не поменять.
     */
    const picker = field === 'dur' && !moment
      ? durPicker(rs, dur)
      : h('div.wclock',
        h('div.wclock-cap', { text: 'выберите час' }),
        clockGrid(24, 1, target, hv => setClock(hv, target % 60)),
        h('div.wclock-cap', { text: 'минуты', style: { margin: '12px 0 9px' } }),
        clockGrid(12, 5, target, mv => setClock(Math.floor(target / 60), mv)));

    const leads = h('div.wwrap.wleads');
    add(leads, ...LEADS.map(l => sheetChip(l.label, state.rowLeads.includes(l.k),
      () => setIn({ rowLeads: toggleLead(state.rowLeads, l.k) }))));
    /*
     * Свой срок — сверх готовых. Готовые покрывают почти всё, но «за сорок
     * минут, потому что дорога» встречается, и задать такое было нечем.
     * Уже выбранные свои значения показываются рядом обычными чипами.
     */
    add(leads, ...state.rowLeads
      .filter(k => /^\d+$/.test(k) && !LEADS.some(l => l.k === k))
      .map(k => sheetChip(leadOwnLabel(k), true,
        () => setIn({ rowLeads: toggleLead(state.rowLeads, k) }))));
    add(leads, (() => {
      const b = h('button.wchip-sheet.wchip-add', {
        type: 'button', title: 'Свой срок', 'aria-label': 'Свой срок',
        onclick: () => askOwnLead(),
      });
      add(b, ico('plus', '14px'));
      return b;
    })());

    /*
     * Четыре степени в одну строку: они и так короткие, а сеткой два на два
     * занимали вдвое больше места и читались как две пары, хотя это одна шкала
     * от тишины до будильника.
     */
    const modes = h('div.wgrid4');
    add(modes, ...ALARM.map(a =>
      opt(a.label, a.icon, state.rowAlarm === a.k, () => setIn({ rowAlarm: a.k }), true)));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: moment ? 'о чём напомнить' : 'что делаем' }),
        h('input.winput', {
          name: 'rowTitle',
          value: state.rowTitle,
          placeholder: moment ? 'Например, забрать документы' : 'Например, работа над отчётом',
          oninput: e => { state.rowTitle = e.target.value; },
        })),
      kinds,
      dayTile,
      tiles,
      picker,
      // Момент времени не занимает — и пересечься ни с чем не может
      moment ? null : conflictBlock(),
      /*
       * Комментарий к активности: необязательный и короткий. Виден и в самом
       * блоке расписания — иначе человек не узнает, что там что-то написано,
       * и комментарий превращается в тайник.
       */
      h('label',
        h('span.wfield-label', { text: 'комментарий · необязательно' }),
        h('textarea.wtextarea.wtextarea-slim', {
          name: 'rowNote', value: state.rowNote,
          placeholder: moment ? 'Подробности напоминания' : 'Что важно помнить про этот блок',
          oninput: e => { state.rowNote = e.target.value; },
        })),
      colorRow(),
      h('div', h('div.wfield-label', { text: 'повтор' }), repeats,
        state.rowRepeat === 'По дням недели'
          ? h('div', { style: { marginTop: '10px' } }, weekdays,
            h('div.wclock-cap', { text: 'ничего не отмечено — повторится в тот же день недели, что и дата', style: { marginTop: '8px' } }))
          : null),
      h('div', h('div.wfield-label', { text: 'предупредить · можно несколько' }), leads),
      /*
       * Про будильник говорим честно: звонит он на телефоне.
       *
       * В браузере уведомление показывает система, а звук играет страница — и
       * только пока она открыта. Задачу пробуждения в браузере ставить некому:
       * закрыл вкладку, и будильника нет. Обещать здесь звонок значило бы
       * обещать то, чего не будет; поэтому подпись тихая, а не красная — это
       * не ошибка, а объяснение, где эта настройка работает.
       */
      h('div', h('div.wfield-label', { text: 'чем предупредить' }), modes,
        state.rowAlarm === 'alarm' || state.rowAlarm === 'sound'
          ? h('div.wclock-cap', {
            text: 'будильник звонит на телефоне — там же настраиваются звук и задача '
              + 'пробуждения. В браузере придёт уведомление, а звук — только пока NewDay открыт',
            style: { marginTop: '9px' },
          })
          : null),
      repeating ? h('div', h('div.wfield-label', { text: 'убрать' }), removes) : null,
      h('div.wrow-end',
        repeating ? null : h('button.wbtn-quiet', {
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
    const chosen = state[CAL_FIELD[state.calFor]] ?? state.date;

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
    const withAi = h('button.wbtn-dashed', { type: 'button', onclick: () => openAi() });
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
          onclick: () => setIn(x => ({ aiOff: { ...x.aiOff, [i]: on } })),
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
          h('button.wbtn-quiet', { type: 'button', text: 'Исправить', onclick: () => setIn({ aiStep: 'input' }) }),
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
        h('button.wbtn-quiet', { type: 'button', text: 'Назад к тексту', onclick: () => setIn({ aiStep: 'input' }) }));
    }

    const listening = state.aiStep === 'listening';
    const area = h('textarea.wai-input', {
      value: state.aiText,
      placeholder: 'Опишите день словами — например, «завтра подъём в семь, в два созвон на час, вечером зал»',
      oninput: e => { state.aiText = e.target.value; },
    });
    const mic = h('button.wmic', {
      type: 'button', class: listening ? 'listening' : '',
      title: listening ? 'Остановить запись' : 'Продиктовать',
      'aria-label': listening ? 'Остановить запись' : 'Продиктовать',
      // запись всегда можно остановить: запертая кнопка оставила бы микрофон включённым
      disabled: !store.ai.voice && !listening,
      onclick: dictate,
    });
    add(mic, ico(listening ? 'waveform-fill' : 'microphone-fill', '22px'));

    /*
     * Пока идёт запись — живые полоски по громкости.
     *
     * Без них непонятно, слышит ли микрофон вообще: кнопка просто мигала, и
     * человек мог говорить в выключенный вход, а узнать об этом только по
     * пустому распознаванию. Полоски двигает настоящий звук; тишина — это
     * маленькие полоски, а не их отсутствие.
     */
    const meter = listening ? h('div.wlevel', { 'aria-hidden': 'true' }) : null;
    if (meter) add(meter, ...Array.from({ length: 28 }, () => h('i')));

    return h('div.wstack',
      h('div.whint', {
        text: store.ai.ready
          ? 'Опишите день словами или продиктуйте — разложу по расписанию, делам и напоминаниям.'
          : 'Помощник не подключён. Владелец задаёт подключение в настройках.',
      }),
      h('div.wai-row', area, mic),
      listening
        ? h('div.wlevel-row', meter,
          h('span.wlevel-hint', { text: 'слушаю — нажмите микрофон, чтобы закончить' }))
        : null,
      state.notice ? h('div.whint', { text: state.notice, style: { color: 'var(--accent)' } }) : null,
      /*
       * Кнопка на месте всегда, даже пока текста нет.
       *
       * Раньше она была живой и на пустом поле: нажатие отвечало «Сначала
       * скажите, что нужно сделать» — то есть кнопка выглядела рабочей и
       * ругалась в ответ. Теперь она погашена, а под ней написано, чего не
       * хватает: видно и что делать, и почему пока нельзя.
       */
      h('button.wbtn-wide', {
        type: 'button', text: state.busy ? 'Разбираю…' : 'Разобрать',
        disabled: state.busy || !store.ai.ready || !state.aiText.trim(),
        onclick: () => aiSend(null),
      }),
      !store.ai.ready || state.aiText.trim() || state.busy
        ? null
        : h('div.wclock-cap', {
          text: 'напишите или продиктуйте — и кнопка оживёт',
          style: { margin: '0' },
        }));
  },

  // ── Новая привычка ──
  habit() {
    /*
     * Значок — шесть предложенных и плюсик на все остальные.
     *
     * Ряд не переставляется: раньше выбранный смайлик вставал в начало, и
     * при каждом нажатии все значки перескакивали — попасть по второму разу
     * было не во что. Пресет стоит на месте, выбранное подсвечивается; свой
     * значок из полного набора занимает последнюю клетку, не трогая первые.
     */
    const presets = HABIT_EMOJI.slice(0, 6);
    const shown = presets.includes(state.habitEmoji)
      ? presets
      : [...presets.slice(0, 5), state.habitEmoji];
    const emoji = h('div.wrow.wrow-emoji');
    add(emoji, ...shown.map(e =>
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
    /*
     * «На дату» — сама кнопка с датой, а не переключатель и отдельный чип
     * рядом. Раньше выбранная дата висела вторым элементом, и после выбора
     * кнопка «На дату» выглядела нажатой, но мёртвой: непонятно, куда жать,
     * чтобы дату поменять. Теперь нажатие на неё каждый раз открывает
     * календарь, а дата написана прямо на ней.
     */
    const dated = state.noteDated;
    const [y, m, d] = String(state.noteDate ?? state.date).split('-').map(Number);
    const thisYear = Number(String(store.settings?.today ?? state.date).slice(0, 4));
    const dateText = `${d} ${MONTHS[m - 1]}${y === thisYear ? '' : ` ${y}`}`;

    const kinds = h('div.wrow');
    add(kinds,
      sheetChip('Просто заметка', !dated, () => setIn({ noteDated: false })),
      (() => {
        const b = h('button.wchip-sheet.wchip-date', {
          type: 'button',
          class: dated ? 'on' : '',
          // не выбрано — первое нажатие включает вид и сразу спрашивает дату
          onclick: () => (dated ? openCalendar('note') : setIn({ noteDated: true })),
        });
        add(b, ico('calendar-blank', '14px'),
          h('span', { text: dated ? `На ${dateText}` : 'На дату' }));
        return b;
      })());

    return h('div.wstack',
      h('input.winput', {
        name: 'noteTitle', value: state.noteTitle, placeholder: 'Заголовок — можно оставить пустым',
        oninput: e => { state.noteTitle = e.target.value; },
      }),
      kinds,
      state.noteDated
        ? h('div.wclock-cap', { text: 'заметка с датой покажется в делах этого дня' })
        : null,
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
      sheetChip(c.label, state.taskCat === c.k, () => setIn({ taskCat: c.k }), 'wchip-flex')));

    const save = () => {
      const body = adapt.taskToServer({ title: state.taskTitle, cat: state.taskCat });
      if (!body.text) { needField('taskTitle', 'Впишите задачу'); return; }
      busy(state.taskId === 'new'
        ? data.createTask(state.date, body)
        : data.updateTask(state.date, state.taskId, body));
    };

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'задача' }),
        h('input.winput', {
          name: 'taskTitle', value: state.taskTitle, placeholder: 'Что нужно сделать',
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

  // ── Питание на день ──
  food() {
    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что нужно съесть за день' }),
        h('textarea.wtextarea', {
          name: 'foodPlan', value: state.foodPlan,
          placeholder: 'Например, курица, рис, овощи, творог',
          oninput: e => { state.foodPlan = e.target.value; },
        })),
      h('div.wclock-cap', { text: 'свободный текст: время и калории — по желанию' }),
      h('div',
        h('div.wfield-label', { text: 'цель по калориям' }),
        h('div.wrow',
          h('input.wnum', {
            name: 'foodGoal', value: state.foodGoal, placeholder: '—', inputMode: 'numeric',
            oninput: e => { state.foodGoal = e.target.value; },
          }),
          h('span.wsmall', { text: 'ккал в день — пусто значит «не считаю»' }))),
      h('div.wrow-end',
        h('button.wbtn-quiet', { type: 'button', text: 'Отмена', onclick: closeModal }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Готово',
          disabled: state.busy, onclick: saveFood,
        })));
  },

  // ── Приём пищи ──
  meal() {
    /*
     * Переключение на «окно» раздвигает промежуток до двух часов, если он ещё
     * не тронут: окно в полчаса — это не рамка, а то же точное время, и
     * задавать его заново пришлось бы каждому.
     *
     * Уходя с окна, снимаем «к концу окна»: чипа для него в других режимах нет,
     * а сама отметка оставалась в состоянии. Колокольчик горел, уведомление не
     * приходило никогда, и снять отметку было нечем.
     */
    const setMode = k => setIn(s => ({
      mealMode: k,
      mealEnd: k === 'window' && s.mealEnd - s.mealStart <= 30
        ? Math.min(1439, s.mealStart + 120)
        : s.mealEnd,
      mealLeads: k === 'window' ? s.mealLeads : s.mealLeads.filter(l => l !== 'end'),
    }));

    const modes = h('div.wgrid3');
    add(modes, ...[
      ['none', 'Без времени', 'list-dashes'],
      ['window', 'Окно', 'arrows-out-line-horizontal'],
      ['exact', 'Точное время', 'clock'],
    ].map(([k, label, iconName]) => opt(label, iconName, state.mealMode === k, () => setMode(k), true)));

    const window_ = state.mealMode === 'window';

    /*
     * У окна есть свой срок — «к концу окна». Съесть можно где угодно внутри,
     * но напомнить полезно и о том, что оно закрывается; момент считается от
     * конца окна, поэтому правка окна двигает и напоминание.
     */
    const mealLeadOpts = window_ ? [...LEADS, { k: 'end', label: 'к концу окна' }] : LEADS;
    const leads = h('div.wwrap.wleads');
    add(leads, ...mealLeadOpts.map(l => sheetChip(l.label, state.mealLeads.includes(l.k),
      () => setIn({ mealLeads: toggleLead(state.mealLeads, l.k) }))));

    /*
     * Переключатель есть и у окна: окно — это тоже занятое время, и в сетке оно
     * должно стоять окном. Дела внутри него рисуются вложенными.
     */
    const schedCard = h('button.wtoggle-card', { type: 'button', onclick: () => setIn(s => ({ mealSched: !s.mealSched })) },
      h('div.wtoggle-card-body',
        h('div.wrow-sw-title', { text: 'Добавить в расписание' }),
        h('div.wrow-sw-hint', {
          text: `займёт ${hhmm(state.mealStart)}–${hhmm(mealBlockEnd())}`
            + ', ничего не сдвинет без подтверждения',
        })),
      sw(state.mealSched));

    /*
     * Время — теми же плитками и той же сеткой, что у строки расписания.
     *
     * Раньше здесь было «точное время + 30 минут» с готовыми длительностями:
     * а если человек готовит наперёд, ему нужно два часа, и такого выбора не
     * было вовсе. Плюс времена набирались руками, и нажатия по ним ничего не
     * делали. Диапазон везде задаётся одинаково — привыкать заново не нужно.
     */
    const ms = state.mealStart;
    const me = Math.max(ms + 5, state.mealEnd);
    const mdur = me - ms;
    const mfield = state.mealField ?? 'start';

    /*
     * День — такой же плиткой, как у строки расписания: приём пищи тоже
     * переезжает, и записывать завтрашний ужин, стоя в сегодняшнем дне,
     * человек должен уметь, не выходя из шторки.
     */
    const [dy, dm, dd] = String(state.mealDate ?? state.date).split('-').map(Number);
    const mdayTile = h('div.wtile', { onclick: () => openCalendar('meal') });
    add(mdayTile, h('span.wtile-cap', { text: 'день' }),
      h('input', { value: `${dd} ${MONTHS[dm - 1]} ${dy}`, readOnly: true, tabIndex: -1 }));

    const mtiles = h('div.wgrid3');
    add(mtiles, ...[
      ['start', 'начало', hhmm(ms)],
      ['dur', 'длится', durLabel(mdur)],
      ['end', 'конец', hhmm(me)],
    ].map(([k, label, value]) => {
      const tile = h('div.wtile', { class: mfield === k ? 'on' : '', onclick: () => setIn({ mealField: k }) });
      add(tile, h('span.wtile-cap', { text: label }), h('input', { value, readOnly: true, tabIndex: -1 }));
      return tile;
    }));

    const mtarget = mfield === 'end' ? me : ms;
    const setMealClock = (hv, mv) => {
      const at = hv * 60 + mv;
      if (mfield === 'end') setIn({ mealEnd: Math.max(ms + 5, at) });
      // правка начала двигает конец, сохраняя длительность — как в расписании
      else setIn({ mealStart: at, mealEnd: Math.min(1439, at + mdur) });
    };

    const mpicker = mfield === 'dur'
      ? durPicker(ms, mdur, 'mealEnd')
      : h('div.wclock',
        h('div.wclock-cap', { text: 'выберите час' }),
        clockGrid(24, 1, mtarget, hv => setMealClock(hv, mtarget % 60)),
        h('div.wclock-cap', { text: 'минуты', style: { margin: '12px 0 9px' } }),
        clockGrid(12, 5, mtarget, mv => setMealClock(Math.floor(mtarget / 60), mv)));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что едим' }),
        h('input.winput', {
          name: 'mealTitle', value: state.mealTitle, placeholder: 'Например, курица с рисом',
          oninput: e => { state.mealTitle = e.target.value; },
        })),
      h('div',
        h('div.wfield-label', { text: 'время' }), modes,
        window_
          ? h('div.wclock-cap', { text: 'мягкая рамка: съесть где-то внутри окна', style: { marginTop: '10px' } })
          : null),
      mdayTile,
      state.mealMode === 'none' ? null : mtiles,
      /*
       * У точного времени промежуток живёт только в блоке расписания: сам приём
       * пищи хранит одно время, и режим читается из пары времён — заполнены
       * оба, значит окно. Поэтому, если блок выключен, честно говорим, где
       * пропадут выбранные два часа. Раньше подпись молчала, и «2 ч» при
       * следующем открытии превращались в «30 мин».
       */
      state.mealMode === 'exact' && !state.mealSched
        ? h('div.wclock-cap', {
          text: 'чтобы это время заняло место в дне, включите «Добавить в расписание»',
          style: { margin: '0' },
        })
        : null,
      state.mealMode === 'none' ? null : mpicker,
      h('div.wrow',
        h('input.wnum', {
          name: 'mealKcal', value: state.mealKcal, placeholder: '—', inputMode: 'numeric',
          oninput: e => { state.mealKcal = e.target.value; },
        }),
        h('span.wsmall', { text: 'ккал — можно оставить пустым' })),
      state.mealMode === 'none' ? null : schedCard,
      state.mealMode !== 'none' && state.mealSched ? mealConflictBlock() : null,
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

  // ── Аккаунт ──
  account() {
    /*
     * Токен для интеграций живёт здесь же, внизу шторки аккаунта: это про
     * доступ к своим данным, и искать его в другом месте незачем.
     *
     * Токен один. Их может быть сколько угодно, но человеку нужен «ключ от
     * своего NewDay», а не список ключей: список — это уже задача, которую он
     * не просил решать. Есть — показываем, нет — предлагаем выпустить.
     */
    const tokenBlock = () => {
      const list = store.tokens ?? [];
      const cur = list[0] ?? null;
      const fresh = state.tokenShown;

      const head = h('div.wclock-cap', { text: 'токен для интеграций', style: { marginTop: '4px' } });

      if (!cur) {
        return h('div.wtoken',
          head,
          h('div.wtoken-hint', {
            text: 'Ключ, которым сторонняя программа читает и пишет ваш день по API. '
              + 'Вставляется в неё как «Authorization: Bearer nd_…».',
          }),
          h('button.wbtn-wide', {
            type: 'button', text: state.busy ? 'Выпускаю…' : 'Выпустить токен',
            disabled: state.busy, onclick: issueToken,
          }));
      }

      /*
       * Секрет показывается один раз — сервер хранит только хеш. Пока он на
       * экране, поле с ним и кнопка «Скопировать»; потом остаётся строка с
       * префиксом, по которой видно, что токен есть, и когда им пользовались.
       */
      const shown = fresh
        ? h('div',
          h('div.wtoken-warn', { text: 'Скопируйте сейчас — второй раз он не покажется.' }),
          h('div.wrow',
            h('input.winput.wtoken-value', {
              name: 'tokenValue', value: fresh, readOnly: true,
              onclick: e => e.target.select(),
            }),
            h('button.wbtn-line', {
              type: 'button', text: 'Скопировать',
              onclick: () => copyText(fresh, 'Токен скопирован'),
            })))
        : h('div.wtoken-row',
          ico('key', '17px'),
          h('div.wtoken-body',
            h('div.wtoken-name', { text: `${cur.prefix}…` }),
            h('div.wtoken-meta', {
              text: cur.last_used_at
                ? `последний раз использован ${String(cur.last_used_at).slice(0, 16).replace('T', ' ')}`
                : 'ещё не использовался',
            })));

      return h('div.wtoken',
        head, shown,
        h('div.wrow-end', { style: { marginTop: '10px' } },
          h('button.wbtn-quiet', {
            type: 'button', text: 'Удалить', disabled: state.busy,
            onclick: () => revokeToken(cur.id),
          }),
          h('button.wbtn-line', {
            type: 'button', text: state.busy ? 'Работаю…' : 'Перевыпустить',
            disabled: state.busy, onclick: () => reissueToken(cur.id),
          })),
        h('div.wtoken-hint', {
          text: 'Что можно делать этим токеном — в описании API: ',
        }, h('a', { href: '/api/v1/openapi.json', target: '_blank', text: 'openapi.json' })));
    };

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
          onclick: () => logOut(),
        }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Меняю…' : 'Сменить пароль',
          disabled: state.busy, onclick: savePassword,
        })),
      tokenBlock());
  },

  // ── Звук ──
  sound() {
    const forAlarm = state.soundKind !== 'Звук уведомлений';
    const key = forAlarm ? 'sound' : 'notifySound';
    const manifest = store.soundManifest ?? [];

    /*
     * Каждый звук можно послушать до выбора: название «Клаксон» о громкости
     * ничего не говорит, а будильник — не то место, где сюрприз уместен.
     */
    const soundRow = (name, hint, opts) => {
      const playing = state.soundPlay === opts.playKey;
      // div, а не button: внутри живут свои кнопки «послушать» и «удалить»,
      // а кнопка в кнопке — невалидная разметка с непредсказуемыми кликами
      const b = h('div.wopt', {
        class: opts.on ? 'on' : '', role: 'button', tabindex: '0',
        onclick: opts.pick,
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.pick(); } },
      });
      add(b, ico(opts.icon ?? 'music-note-simple', '17px'),
        h('div.wopt-body',
          h('div.wopt-title', { text: name }),
          h('div.wopt-hint', { text: hint })),
        h('button.wplay', {
          type: 'button', class: playing ? 'on' : '',
          title: playing ? 'Остановить' : 'Послушать',
          'aria-label': playing ? 'Остановить' : 'Послушать',
          onclick: e => { e.stopPropagation(); togglePreview(opts.playKey, opts.src); },
        }, ico(playing ? 'stop' : 'play-fill', '15px')),
        opts.trash ? h('button.wplay', {
          type: 'button', title: 'Удалить',
          'aria-label': 'Удалить',
          onclick: e => { e.stopPropagation(); opts.trash(); },
        }, ico('trash', '15px')) : null);
      return b;
    };

    const groups = [];
    const wanted = manifest.filter(s => (forAlarm ? s.kind === 'alarm' : true));
    for (const mood of ['мягкий', 'злой']) {
      const items = wanted.filter(s => s.mood === mood);
      if (!items.length) continue;
      groups.push(h('div.wclock-cap', {
        text: mood === 'злой' ? 'злые — поднимут кого угодно' : 'мягкие',
        style: { margin: '6px 0 2px' },
      }));
      groups.push(...items.map(s => soundRow(s.name,
        mood === 'злой' ? 'громкий и настойчивый' : 'спокойный',
        {
          on: state[key] === s.name,
          playKey: s.file,
          src: `/sounds/${s.file}`,
          pick: () => {
            state[key] = s.name;
            render();
            // для будильника вместе с названием сохраняется имя файла:
            // название — человеку, файл — телефону
            data.saveSettings(forAlarm ? { sound: s.name, soundFile: s.file } : { notifySound: s.name })
              .then(() => native.pushAlarmConfig?.(store.settings))
              .catch(fail);
          },
        })));
    }

    // ── Свои звуки ──
    const mine = store.mySounds ?? [];
    if (mine.length) {
      groups.push(h('div.wclock-cap', { text: 'свои', style: { margin: '6px 0 2px' } }));
      groups.push(...mine.map(sd => soundRow(sd.name, `${(sd.sizeBytes / 1048576).toFixed(1)} МБ`, {
        icon: 'waveform',
        on: state[key] === sd.name,
        playKey: `u-${sd.id}`,
        src: null, // тег audio заголовков не умеет — файл едет блобом с токеном
        blobId: sd.id,
        pick: () => act(() => pickCustomSound(sd, forAlarm, key)),
        trash: () => act(async () => {
          await api.sounds.remove(sd.id);
          native.removeSound(customSoundFile(sd)).catch(() => {});
          store.mySounds = await api.sounds.list();
          note('Звук удалён');
        }),
      })));
    }

    /*
     * Свой звук добавляется и здесь, и в приложении: хранится он на сервере
     * и синхронизируется между устройствами, а на телефон при выборе
     * уезжает целиком — будильник звонит и без сети.
     */
    const own = h('button.wbtn-dashed', {
      type: 'button',
      onclick: () => {
        const input = h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
        input.onchange = () => {
          const f = input.files?.[0];
          if (!f) return;
          if (f.size > 10 * 1048576) {
            setIn({ notice: `Файл весит ${(f.size / 1048576).toFixed(1)} МБ, а будильнику хватает 10: это десять минут звука в хорошем качестве` });
            return;
          }
          act(async () => {
            await api.sounds.upload(f);
            store.mySounds = await api.sounds.list();
            note('Звук добавлен — он синхронизируется между устройствами');
          });
        };
        input.click();
      },
    });
    add(own, ico('plus', '15px'), h('span', { text: 'Добавить свой звук — до 10 МБ' }));

    return h('div.wstack', h('div.wstack-tight', ...groups), own,
      h('button.wbtn-wide', { type: 'button', text: 'Готово', onclick: closeModal }));
  },

  // ── Фото профиля: кадрирование ──
  avatar() {
    const canvas = h('canvas.wava-crop', { width: '560', height: '560' });
    requestAnimationFrame(() => drawAvaCrop(canvas));

    // перетаскивание рисует прямо на канве, без render: полный цикл на
    // каждый пиксель движения дёргал бы всё приложение
    let dragFrom = null;
    canvas.onpointerdown = e => {
      dragFrom = { x: e.clientX, y: e.clientY, ax: avaCrop.x, ay: avaCrop.y };
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.onpointermove = e => {
      if (!dragFrom) return;
      const k = canvas.width / canvas.getBoundingClientRect().width;
      avaCrop.x = dragFrom.ax + (e.clientX - dragFrom.x) * k;
      avaCrop.y = dragFrom.ay + (e.clientY - dragFrom.y) * k;
      drawAvaCrop(canvas);
    };
    canvas.onpointerup = () => { dragFrom = null; };

    const zoom = h('input.wava-zoom', {
      type: 'range', min: '100', max: '300', value: String(Math.round(avaCrop.zoom * 100)),
      'aria-label': 'Приближение',
      oninput: e => { avaCrop.zoom = Number(e.target.value) / 100; drawAvaCrop(canvas); },
    });

    return h('div.wstack',
      h('div.wclock-cap', { text: 'потяните, чтобы сдвинуть; ползунком — приблизить' }),
      canvas, zoom,
      h('div.wrow-end',
        h('button.wbtn-quiet', { type: 'button', text: 'Отмена', onclick: closeModal }),
        h('button.wbtn-wide', {
          type: 'button', text: state.busy ? 'Сохраняю…' : 'Сохранить',
          disabled: state.busy,
          onclick: () => act(async () => {
            /*
             * Храним готовый маленький JPEG в настройках: он синхронизируется
             * между устройствами тем же путём, что и всё остальное, и не
             * требует отдельного хранилища. 256 пикселей на аватар 40px —
             * запас на плотные экраны, вес ~20–40 КБ.
             */
            const out = document.createElement('canvas');
            out.width = 256;
            out.height = 256;
            const k = 256 / canvas.width;
            const ctx = out.getContext('2d');
            const img = avaCrop.img;
            const base = Math.max(canvas.width / img.width, canvas.width / img.height) * avaCrop.zoom;
            ctx.drawImage(img, avaCrop.x * k, avaCrop.y * k, img.width * base * k, img.height * base * k);
            await data.saveSettings({ avatar: out.toDataURL('image/jpeg', 0.85) });
            closeModal();
          }),
        })));
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
    ).map(([k, label]) => sheetChip(label, scope === k, () => setIn({ fileScope: k }))));

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
      // тип, цвет и комментарий берём тоже: без них напоминание уезжало в
      // шаблон обычным блоком, а цветной день выходил бесцветным
      onclick: () => saveTemplate(SCHEDULE.map(r => ({
        start: r.start, end: r.end, title: r.title, alarm: r.alarm, leads: r.leads,
        kind: r.isReminder ? 'reminder' : (r.kind ?? 'normal'), note: r.note ?? '', color: r.color ?? null,
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
      ['dur', 'длится', durLabel(dur)],
      ['end', 'конец', hhmm(re)],
    ].map(([k, label, value]) => {
      const tile = h('div.wtile', { class: field === k ? 'on' : '', onclick: () => setIn({ tplField: k }) });
      add(tile, h('span.wtile-cap', { text: label }), h('input', { value, readOnly: true, tabIndex: -1 }));
      return tile;
    }));

    /*
     * Плитки ведут себя так же, как в редакторе строки дня: «длится» — это
     * длительность, а не время. Раньше здесь нажатие на час меняло начало, и
     * длительность в шаблоне задать было нечем.
     */
    const setClock = (hv, mv) => {
      const at = hv * 60 + mv;
      if (field === 'end') setIn({ tplEnd: Math.max(rs + 5, at) });
      else setIn({ tplStart: at, tplEnd: Math.min(1439, at + dur) });
    };

    const durs = h('div.wwrap');
    add(durs, ...DURS.map(v => sheetChip(durLabel(v), dur === v,
      () => setIn({ tplEnd: Math.min(1439, rs + v) }), 'wchip-dur')));

    const picker = field === 'dur'
      ? h('div.wclock', h('div.wclock-cap', { text: 'конец посчитается сам' }), durs)
      : h('div.wclock',
        h('div.wclock-cap', { text: 'можно выбрать час' }),
        clockGrid(24, 1, target, hv => setClock(hv, target % 60)),
        h('div.wclock-cap', { text: 'минуты', style: { margin: '12px 0 9px' } }),
        clockGrid(12, 5, target, mv => setClock(Math.floor(target / 60), mv)));

    const leads = h('div.wwrap.wleads');
    add(leads, ...LEADS.map(l => sheetChip(l.label, state.tplLeads.includes(l.k), () => setIn({ tplLeads: toggleLead(state.tplLeads, l.k) }))));

    const modes = h('div.wgrid2');
    add(modes, ...ALARM.map(a => opt(a.label, a.icon, state.tplAlarm === a.k, () => setIn({ tplAlarm: a.k }))));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что делаем' }),
        h('input.winput', {
          name: 'tplTitle', value: state.tplTitle, placeholder: 'Например, подъём',
          oninput: e => { state.tplTitle = e.target.value; },
        })),
      tiles,
      picker,
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
      sheetChip(label, state.printScope === i, () => setIn({ printScope: i }))));

    const parts = h('div.wgrid2');
    add(parts, ...PRINT_PARTS.map(name => {
      const on = !state.printOff[name];
      const row = h('button.wplan-item', {
        type: 'button',
        onclick: () => setIn(x => ({ printOff: { ...x.printOff, [name]: on } })),
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
        /*
         * Тип передаём явно. Без него напоминание от помощника приезжало
         * обычной строкой без конца: в сетке оно рисовалось моментом, а в
         * списке и в редакторе считалось блоком — и первая же правка молча
         * приделывала ему конец «плюс полчаса».
         */
        await data.createRow(date, adapt.rowToServer({
          title: it.title, start: start ?? 0,
          end: it.kind === 'reminder' ? null : toMin(it.end),
          kind: it.kind === 'reminder' ? 'reminder' : 'normal',
          alarm: it.alarm ?? 'notify', leads: ['at'],
        }));
      }
      ok += 1;
    }
    state.busy = false;
    state.modal = null;
    /*
     * Записанное стираем: текст своё дело сделал, и в следующий раз шторка
     * должна открыться пустой. Иначе человек видел бы предложение записать то,
     * что уже записано, и делал это дважды.
     */
    Object.assign(state, { aiText: '', aiItems: null, aiOff: {}, aiStep: 'input' });
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
/**
 * Живые полоски громкости, пока идёт запись.
 *
 * Полоски двигаются от настоящего звука, а не по таймеру: смысл в том, чтобы
 * человек видел, слышит ли его микрофон. Тишина — это ряд маленьких полосок:
 * так видно, что запись идёт, но в неё ничего не попадает.
 *
 * Рисуем прямо в DOM, минуя перерисовку: шестьдесят кадров в секунду через
 * состояние экрана — это шестьдесят перестроений разметки в секунду.
 */
function levelMeter(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return () => {};

  const ctx = new Ctx();
  /*
   * Разбудить контекст. Браузер создаёт его приостановленным, если не увидел
   * жеста человека, — а тогда анализатор молчит и полоски стоят на месте,
   * хотя звук в микрофон идёт. Нажатие на микрофон жестом считается, но
   * страховка ничего не стоит.
   */
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  const trail = [];
  let alive = true;

  const tick = () => {
    if (!alive) return;
    analyser.getByteTimeDomainData(data);
    // громкость как среднее отклонение от тишины: пики ловятся, шум не мельтешит
    let sum = 0;
    for (const v of data) sum += Math.abs(v - 128);
    const level = Math.min(1, (sum / data.length) / 40);

    trail.push(level);
    const bars = document.querySelectorAll('.wlevel > i');
    if (bars.length) {
      while (trail.length > bars.length) trail.shift();
      bars.forEach((bar, i) => {
        // хвост показывает недавнее прошлое: слева старое, справа только что
        const v = trail[trail.length - bars.length + i] ?? 0;
        bar.style.height = `${Math.round(3 + v * 25)}px`;
        bar.style.opacity = String(0.35 + v * 0.65);
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return () => {
    alive = false;
    ctx.close().catch(() => {});
  };
}

/**
 * Отпустить микрофон.
 *
 * Одно место на все случаи, и это важно: раньше поток закрывался только в
 * `onstop` самой записи. Кто закрыл шторку крестиком, щелчком по фону или
 * Escape посреди диктовки — оставлял микрофон включённым навсегда: в браузере
 * горел индикатор записи, и человек справедливо считал, что сайт его слушает.
 *
 * Останавливаем и дорожки, и счётчик громкости: без остановки дорожек
 * индикатор не гаснет, даже если запись давно не идёт.
 */
function releaseMic() {
  try { state.stopMeter?.(); } catch { /* контекст мог быть уже закрыт */ }
  state.stopMeter = null;
  try { state.micStream?.getTracks().forEach(t => t.stop()); } catch { /* уже отпущен */ }
  state.micStream = null;
  const rec = state.recorder;
  state.recorder = null;
  if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* уже остановлена */ } }
  if (state.aiStep === 'listening') state.aiStep = 'input';
}

async function dictate() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    state.notice = 'Этот браузер не умеет записывать звук'; render(); return;
  }
  if (state.recorder) { state.recorder.stop(); return; }

  /*
   * Причину отказа называем настоящую.
   *
   * Раньше на любую неудачу писалось «Не дали доступ к микрофону», и человек
   * искал разрешение, которое давно выдал: на самом деле бывает и занятый
   * другой программой вход, и отсутствующий микрофон, и запрет из-за того, что
   * страница открыта не по https. Неверный диагноз отправляет чинить не то.
   */
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) {
    const name = e?.name ?? '';
    state.notice = !window.isSecureContext
      ? 'Микрофон работает только по https. Откройте сайт по защищённому адресу'
      : name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Доступ к микрофону запрещён. Разрешите его в настройках сайта в браузере'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'Микрофон не найден — проверьте, что он подключён и выбран в системе'
          : name === 'NotReadableError'
            ? 'Микрофон занят другой программой — закройте её и попробуйте снова'
            : `Микрофон не открылся: ${e?.message || name || 'неизвестная причина'}`;
    render();
    return;
  }

  const chunks = [];
  const rec = new MediaRecorder(stream);
  state.recorder = rec;
  state.micStream = stream;
  state.aiStep = 'listening';
  state.notice = null;
  render();
  const stopMeter = levelMeter(stream);
  state.stopMeter = stopMeter;

  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stopMeter();
    state.stopMeter = null;
    stream.getTracks().forEach(t => t.stop());
    state.micStream = null;
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

/*
 * На телефоне свой набор: «Расписание» сеткой отсутствует, зато есть «Дела».
 * Раздел, которого в этой раскладке нет, переводим в ближайший осмысленный —
 * иначе поворот телефона или сужение окна оставляли бы пустой экран.
 */
const PHONE_SCREENS = {
  today: phoneToday, tasks: phoneTasks, habits: habitsScreen,
  notes: notesScreen, settings: settingsScreen,
};
const SAME_SCREEN = { plan: 'tasks', tasks: 'plan' };

function render() {
  const root = $('#wapp');
  if (!root) return;

  /*
   * Микрофон живёт ровно столько, сколько открыта шторка помощника.
   *
   * Проверка стоит здесь нарочно, а не в каждом обработчике закрытия: путей
   * уйти со шторки много — крестик, щелчок по фону, Escape, переход в другой
   * раздел, нажатие на уведомление, — и достаточно забыть один, чтобы
   * микрофон остался включённым. Одно правило в одном месте забыть нельзя.
   */
  if ((state.recorder || state.micStream) && state.modal !== 'ai') releaseMic();
  // предпросмотр звука живёт ровно столько, сколько открыта шторка звука
  if (previewAudio && state.modal !== 'sound') stopPreview();

  // Тема: переменные ставим на корень, чтобы CSS остался без вариантов
  const vars = { ...(dark() ? DARK : LIGHT) };
  vars['--accent'] = accent();
  vars['--accent-soft'] = soft();
  vars['--accent-line'] = `color-mix(in srgb, ${accent()} 40%, transparent)`;
  root.dataset.theme = dark() ? 'dark' : 'light';
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  /*
   * Крупный текст — класс, а не zoom.
   *
   * zoom растил всё подряд: иконки, меню, кнопки — и на телефоне ломал
   * раскладку (почта складывалась вертикально, привычки не влезали).
   * Увеличивать нужно только то, что читают: названия дел, заметки,
   * подписи. Это делает CSS по классу wbig — точечно, без пересчёта
   * высот и без уехавшей за экран полосы разделов.
   */
  root.style.zoom = '';
  root.style.setProperty('--zoom', '1');
  root.classList.toggle('wbig', state.scale > 1);

  /*
   * Системные полосы Android — статусбар и полоса жестов — следуют за темой.
   * Стартовые цвета задаёт styles.xml по теме телефона, но выбранная в
   * приложении тема может быть противоположной — тогда без этого вызова
   * снизу оставалась белая полоса на тёмном экране. Зовём только при
   * фактической смене: мост не место для шума на каждый render.
   */
  const barColor = vars['--bg'];
  if (native.available() && (paintedBars.dark !== root.dataset.theme || paintedBars.color !== barColor)) {
    paintedBars.dark = root.dataset.theme;
    paintedBars.color = barColor;
    native.setSystemBars(dark(), barColor).catch(() => {});
  }

  const phone = isPhone();
  root.classList.toggle('wphone', phone);
  const screens = phone ? PHONE_SCREENS : SCREENS;
  if (!screens[state.screen]) state.screen = SAME_SCREEN[state.screen] ?? 'today';

  /*
   * Полоса «нет связи» стоит выше всего остального: пока её нет, человек
   * считает, что правки уходят на сервер, и узнаёт обратное позже — когда
   * откроет тот же день на другом устройстве.
   *
   * Спокойная, а не красная: связи нет — это состояние, а не поломка. Человек
   * в метро, приложение работает, и пугать его нечем. Но сказать, что правки
   * сейчас не сохранятся, обязательно: промолчать здесь хуже, чем встревожить.
   */
  /*
   * Признак не только `navigator.onLine`: он врёт в обе стороны — показывает
   * «связь есть» при подключении к точке без интернета и «нет» на некоторых
   * оболочках Android. Поэтому вторым признаком служит то, что данные на
   * экране прочитаны из локальной копии: это факт, а не догадка.
   */
  const noNet = navigator.onLine === false || store.offline;
  const offline = noNet
    ? h('div.wnotice.calm',
      h('b', { text: 'Нет связи. ' }),
      'Расписание и дела видны — это последнее, что успело сохраниться на устройстве. '
      + 'Правки пока не уходят на сервер: появится связь — повторите.')
    : null;

  /*
   * На экране показываем только экранное сообщение. Сообщение шторки живёт в
   * самой шторке и с ней же исчезает — иначе «Впишите, что делаем» уходило
   * вместе с человеком в другой раздел и читалось как поломка экрана.
   */
  const notice = state.toast ? h('div.wnotice', { text: state.toast }) : null;

  /*
   * Прокрутка переживает перерисовку.
   *
   * render() пересобирает DOM целиком, и контейнеры прокрутки рождаются
   * заново с нулевой позицией: любое переключение в настройках — тема,
   * сложность математики, «переносить невыполненное» — уводило экран вверх,
   * и до следующего пункта приходилось доезжать заново. Позицию запоминаем
   * до пересборки и возвращаем после — но только пока человек остался там
   * же: новый экран или другая шторка честно открываются с начала.
   */
  const keepScroll = [];
  const sameScreen = renderedAt.screen === state.screen && renderedAt.phone === phone;
  const sameModal = renderedAt.modal === state.modal;
  /*
   * Новый заход — чистый лист. Фильтр «без даты», оставшийся с прошлого
   * раза, читается как «заметки пропали»; раздел настроек, открытый
   * позавчера, — как чужой экран. Внутри одного захода состояние живёт,
   * при возврате на экран — сбрасывается.
   */
  if (!sameScreen && state.screen === 'notes') state.noteFilter = 'all';
  if (!sameScreen && state.screen === 'settings') state.setPage = null;
  if (sameScreen) {
    for (const sel of ['.wpbody', '.wbody']) {
      const el = root.querySelector(sel);
      if (el?.scrollTop) keepScroll.push([sel, el.scrollTop]);
    }
  }
  if (sameModal && state.modal) {
    const el = root.querySelector('.wmodal-body');
    if (el?.scrollTop) keepScroll.push(['.wmodal-body', el.scrollTop]);
  }
  renderedAt.screen = state.screen;
  renderedAt.modal = state.modal;
  renderedAt.phone = phone;

  if (phone) {
    replace(root,
      h('div.wpbody.wscroll', offline, notice, screens[state.screen]()),
      phoneNav(),
      modal());
  } else {
    replace(root,
      sideBar(),
      h('div.wmain', topBar(), h('div.wbody.wscroll', offline, notice, screens[state.screen]())),
      modal());
  }
  for (const [sel, top] of keepScroll) {
    const el = root.querySelector(sel);
    if (el) el.scrollTop = top;
  }
}

// где человек был при прошлой отрисовке — чтобы вернуть ему прокрутку
const renderedAt = { screen: null, modal: null, phone: null };
// каким цветом покрашены системные полосы Android — чтобы не дёргать мост зря
const paintedBars = { dark: null, color: null };

/*
 * Смена ширины меняет раскладку целиком, поэтому перерисовываем — но только
 * когда сторона действительно поменялась: на телефоне при появлении клавиатуры
 * событие приходит десятками, и перерисовка на каждое отбирала бы фокус у поля.
 */
let wasPhone = null;
addEventListener('resize', () => {
  const now = isPhone();
  if (now === wasPhone) return;
  wasPhone = now;
  render();
});

/*
 * Связь появилась или пропала — видно сразу, а не при первой неудачной правке.
 *
 * Признак снимаем не дожидаясь ответа сервера: он ставится при чтении из
 * локальной копии и сам не сбрасывается, поэтому спокойная полоса висела бы до
 * конца перечитывания, а при неудаче — и дольше. Если перечитать не удастся,
 * следующее же чтение поставит признак обратно.
 */
addEventListener('online', () => { store.offline = false; render(); reload(); });
addEventListener('offline', render);

/*
 * Возврат к приложению — тоже повод перечитать.
 *
 * На событие `online` полагаться нельзя: на части оболочек Android оно не
 * приходит вовсе, а в браузере срабатывает и при подключении к точке без
 * интернета. Человек же обычно возвращается к приложению уже со связью — и
 * ждёт увидеть свежий день, а не полосу «нет связи», оставшуюся с метро.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!store.offline && navigator.onLine !== false) return;
  store.offline = false;
  render();
  reload();
});

/*
 * Уходя со страницы, отпускаем микрофон. Закрытую вкладку браузер разбирает
 * сам, но переход по ссылке или назад в истории её не закрывает — а индикатор
 * записи остаётся горящим, и это уже похоже на слежку.
 */
addEventListener('pagehide', releaseMic);

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
  // конец не выходит за последнюю минуту суток — иначе сервер откажет
  const b = Math.min(1439, Math.max(a + SNAP, Math.max(from, to)));
  newRow({ date, start: Math.min(a, b - SNAP), end: b });
});

/*
 * Запуск. Сначала настройки — от них зависят и тема, и сегодняшняя дата в
 * часовом поясе человека; рисовать до этого значит мигнуть чужой темой.
 */
async function bootstrap() {
  api.setUnauthorizedHandler(() => {
    // протухший токен устройства стираем, как это делает и обработчик по
    // умолчанию: иначе точка входа продолжала бы верить, что человек вошёл,
    // и гоняла бы его по кругу web → login
    if (api.isNative()) api.setDeviceToken(null);
    location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
  });

  try {
    const settings = await data.boot();
    // Из уведомления приходят с датой в хвосте адреса: «/web.html#2026-08-12».
    // Открыть при этом сегодняшний день значит показать не то, о чём звали
    state.date = askedDate() ?? settings.today;
    state.theme = settings.theme ?? 'dark';
    state.color = settings.settings?.accent ?? 'violet';
    /*
     * Размеров теперь два. Кто успел выбрать полуторный, получал экран,
     * увеличенный на 150 %, и ни одной подсвеченной кнопки в настройках:
     * состояние выглядело сломанным. Незнакомое значение приводим к 100 %.
     */
    state.scale = SCALES.includes(settings.settings?.scale) ? settings.settings.scale : 1;
    state.sound = settings.settings?.sound ?? 'Рассвет';
    state.notifySound = settings.settings?.notifySound ?? 'Капля';
    /*
     * Выбранный вид расписания запоминается. Раньше здесь сверялось значение
     * 'grid', которого сервер не отдаёт вовсе, — условие было мёртвым, и вид
     * каждый раз возвращался к неделе.
     */
    const view = settings.settings?.planView;
    if (view === 'day' || view === 'week' || view === 'month') state.view = view;
  } catch (e) {
    /*
     * Не вошли — обработчик выше уже увёл на страницу входа. Всё остальное
     * сюда доходит только если нет ни связи, ни локальной копии: тогда
     * показывать нечего, и честнее сказать это, чем рисовать пустой день.
     */
    if (e?.status !== 401) {
      replace($('#wapp'), h('div.wboot', {
        text: navigator.onLine === false
          ? 'Нет связи, а сохранённой копии на этом устройстве ещё нет. Откройте приложение один раз со связью.'
          : `Не удалось загрузить: ${e.message}`,
      }));
    }
    return;
  }

  render();
  await reload();
}

bootstrap();
