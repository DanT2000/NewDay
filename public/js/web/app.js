/**
 * Веб-версия NewDay по эталону «NewDay Web».
 *
 * Перенос один в один: разделы, три колонки «Сейчас», сетка недели с
 * созданием блока протягиванием, месяц, привычки, заметки, настройки и
 * двенадцать шторок. Данные пока примерные (`data.js`) — экран работает
 * целиком, но живёт сам по себе. Подключение к серверу — следующий шаг,
 * и форма данных под него уже подогнана.
 *
 * Отрисовка простая: одно состояние, одна функция `render`. Ни виртуального
 * дерева, ни подписок — экранов пять, и перерисовать разметку целиком
 * быстрее, чем следить за тем, что именно изменилось.
 */

import { h, add, replace, $ } from '../dom.js';
import { icon } from '../vendor/icons.js';
import {
  DARK, LIGHT, PALETTE, ALARM, LEADS, SCHEDULE, CATS, TASKS, MEALS, HABITS,
  REMINDERS, NOTES, NAV, MONTHS, DOW_LONG, DOW_SHORT, AI_SAMPLE, AI_PLAN,
  MONTH_SETS, SOUNDS, DEVICES, REPEATS, PRINT_PARTS, HABIT_EMOJI,
} from './data.js';

/** Часовая сетка: 18 часов с 06:00, строка часа — 44 px. */
const HOUR_H = 44;
const FROM_MIN = 6 * 60;
const HOURS = 18;
const PX_PER_MIN = HOUR_H / 60;
/** Шаг протягивания: четверть часа — то, чем люди мыслят расписание. */
const SNAP = 15;
const TODAY = '2026-08-05';

const state = {
  theme: 'dark', color: 'violet', screen: 'today', scale: 1,
  date: TODAY, view: 'week',
  done: {}, alarms: {}, leads: {},
  catFilter: 'all', noteFilter: 'all',
  modal: null,
  rowId: 's4', rowStart: null, rowEnd: null, rowField: 'start',
  taskId: 't2', taskCat: null, mealId: 'm2', mealMode: 'window', mealDur: 30, mealSched: false,
  noteId: 'n1', noteDated: true, remId: 'r1', remRepeat: 'Ежегодно',
  sound: 'Рассвет', soundKind: 'Звук будильника', fileKind: 'export',
  habitKind: 'do', habitEmoji: '💧', habitGoal: 30, habitGoalCustom: false,
  habitTimes: 5, habitDays: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: false, 6: false },
  aiStep: 'input', aiText: '', aiOff: {},
  sw: { carry: true, slots: true, kcal: true, toSched: true },
  printScope: 0, printOff: {},
};

// ── Мелкие помощники ─────────────────────────────────────────

const set = patch => { Object.assign(state, typeof patch === 'function' ? patch(state) : patch); /*
 * Крючок для снимков экрана: tools/shots.mjs открывает каждую шторку по
 * имени. Иначе половину макета нечем показать — шторки не страницы, по
 * адресу их не откроешь.
 */
window.__wopen = name => set({ modal: name });

render(); };

const dark = () => state.theme !== 'light';
const accent = () => PALETTE[state.color][dark() ? 'dark' : 'light'];
const soft = () => `color-mix(in srgb, ${accent()} 18%, transparent)`;

const pad2 = n => String(n).padStart(2, '0');
const hhmm = min => { const m = ((min % 1440) + 1440) % 1440; return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; };
const dayOf = () => { const [y, m, d] = state.date.split('-').map(Number); return new Date(y, m - 1, d); };
const keyOf = dt => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
const shiftDay = n => { const dt = dayOf(); dt.setDate(dt.getDate() + n); set({ date: keyOf(dt) }); };
const mondayOf = dt => { const m = new Date(dt); m.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); return m; };

const isDone = r => state.done[r.id] ?? r.done ?? false;
const toggle = r => set(s => ({ done: { ...s.done, [r.id]: !isDone(r) } }));
const alarmOf = r => state.alarms[r.id] ?? r.alarm ?? 'off';
const leadsOf = r => { const v = state.leads[r.id] ?? r.leads ?? ['at']; return v.length ? v : ['at']; };
const hasLead = (r, k) => leadsOf(r).includes(k);
const leadsLabel = r => leadsOf(r).map(k => LEADS.find(l => l.k === k)?.label ?? k).join(', ');

/** Убрать последнюю метку нельзя: «предупредить, но никогда» — не настройка. */
function toggleLead(r, k) {
  const cur = leadsOf(r).slice();
  const i = cur.indexOf(k);
  if (i >= 0) { if (cur.length === 1) return; cur.splice(i, 1); }
  else cur.push(k);
  set(s => ({ leads: { ...s.leads, [r.id]: cur } }));
}

const bellOf = mode => ALARM.find(a => a.k === mode) ?? ALARM[0];
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

function sideBar() {
  const nav = h('nav.wnav', { 'aria-label': 'Разделы' });
  add(nav, ...NAV.map(n => {
    const on = state.screen === n.key;
    const b = h('button.wnav-item', { type: 'button', class: on ? 'on' : '', onclick: () => set({ screen: n.key, modal: null }) });
    add(b, ico(on ? `${n.icon}-fill` : n.icon, '19px'), h('span', { text: n.label }),
      n.badge ? h('span.wnav-badge', { text: n.badge }) : null);
    return b;
  }));

  const themeBtn = h('button.wbtn-line', {
    type: 'button',
    onclick: () => set(s => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
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
          h('div.wuser-name', { text: 'Даниил' }),
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
      class: [on ? 'on' : '', i < 5 ? 'has' : ''].filter(Boolean).join(' '),
      onclick: () => set({ date: keyOf(dt) }),
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
      chip('Сегодня', state.date === TODAY, () => set({ date: TODAY }))),
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
    const row = h('button.wlist-row', { type: 'button', onclick: () => set({ modal: 'task', taskId: t.id, taskCat: t.cat }) });
    const mark = box(d);
    mark.onclick = e => { e.stopPropagation(); toggle(t); };
    add(row, mark,
      h('span.wstrike', { text: t.title, class: d ? 'done' : '' }),
      t.meta ? h('span.wlist-meta', { text: t.meta }) : null,
      h('span.wtag', { text: CATS.find(c => c.k === t.cat)?.label ?? '' }));
    return row;
  }));
  const addBtn = h('button.wadd', { type: 'button', onclick: () => set({ modal: 'task', taskId: 'new', taskCat: 'work' }) });
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
      onclick: () => set({ modal: 'meal', mealId: m.id, mealMode: m.id === 'm3' ? 'exact' : m.id === 'm2' ? 'window' : 'none' }),
    });
    const mark = box(d);
    mark.onclick = e => { e.stopPropagation(); toggle(m); };
    add(row, mark,
      h('div.wmeal-body',
        h('div.wstrike', { text: m.title, class: d ? 'done' : '' }),
        h('div.wmeal-meta', { text: m.meta })),
      h('span.wmeal-kcal', { text: `${m.kcal} ккал` }),
      mode === 'off' ? null : ico(bellOf(mode).icon, '16px', 'wbell'));
    return row;
  }));
  const addBtn = h('button.wadd', { type: 'button', style: { padding: '8px 0 12px' }, onclick: () => set({ modal: 'meal', mealId: 'new', mealMode: 'none' }) });
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
  if (hb.active) mark.onclick = e => { e.stopPropagation(); toggle(hb); };

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
    const row = h('button.wrem', { type: 'button', onclick: () => set({ modal: 'reminder', remId: r.id }) });
    add(row, ico(r.icon, '17px'),
      h('div.wrem-body', h('div.wrem-title', { text: r.title }), h('div.wrem-meta', { text: r.meta })));
    return row;
  }));
  const addRem = h('button.wadd', { type: 'button', onclick: () => set({ modal: 'reminder', remId: 'new' }) });
  add(addRem, ico('plus', '15px'), h('span', { text: 'Напоминание' }));
  add(remList, addRem);

  const right = h('div.wcol',
    h('div', sectHd('привычки сегодня'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        ...HABITS.map(hb => habitCard(hb)))),
    h('div', sectHd('напоминания'), remList),
    h('div', sectHd('заметки дня'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        ...NOTES.filter(n => n.on).map(n =>
          h('div.wnote-day',
            h('div.wnote-day-title', { text: n.title }),
            h('div.wnote-day-text', { text: n.text }))))));

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

/** Разные дни выглядят по-разному: в выходные короче, в четверг планёрка. */
function rowsForDay(index) {
  const weekend = index > 4;
  let rows = weekend ? SCHEDULE.filter(r => ['s1', 's7', 's8', 's9'].includes(r.id)) : SCHEDULE;
  if (index === 3) {
    rows = rows.concat([{ id: 'x1', start: 600, end: 720, title: 'Планёрка с командой по редизайну расписания' }]);
  }
  return rows;
}

function planColumn(index, dateKey) {
  const { items, place } = lanesFor(rowsForDay(index));
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
    dragging = { col, sel, from, to: from + SNAP };
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
      onclick: e => { e.stopPropagation(); openRow(SCHEDULE.some(x => x.id === r.id) ? r.id : 's4'); },
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

  if (isSel) {
    // Линия текущего времени. Данных о настоящем времени у экрана пока нет,
    // поэтому она стоит там же, где на эталоне
    add(col, h('div.wnowline', { style: { top: `${(11 * 60 + 18 - FROM_MIN) * PX_PER_MIN}px` } }, h('i')));
  }

  return col;
}

function planScreen() {
  const cur = dayOf();
  const mon = mondayOf(cur);
  const single = state.view === 'day';

  const seg = h('div.wseg');
  add(seg, ...[['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц']].map(([k, label]) =>
    h('button', { type: 'button', text: label, class: state.view === k ? 'on' : '', onclick: () => set({ view: k }) })));

  const addBtn = h('button.wbtn', { type: 'button', onclick: () => set({ modal: 'row', rowId: 'new', rowStart: 600, rowEnd: 660, rowField: 'start' }) });
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

  const cells = [];
  for (let i = lead - 1; i >= 0; i--) cells.push({ n: prevDim - i, out: true });
  for (let n = 1; n <= dim; n++) cells.push({ n, out: false });
  let tail = 1;
  while (cells.length % 7) cells.push({ n: tail++, out: true });

  const head = h('div.wmonth-head');
  add(head, ...DOW_SHORT.map(d => h('span', { text: d })));

  const grid = h('div.wmonth');
  add(grid, ...cells.map(c => {
    const dt = new Date(y, m, c.n);
    const key = keyOf(dt);
    const sel = !c.out && key === state.date;
    const items = c.out ? [] : MONTH_SETS[c.n % MONTH_SETS.length];

    const cell = h('button.wcell', {
      type: 'button',
      class: [c.out ? 'out' : '', sel ? 'on' : ''].filter(Boolean).join(' '),
      onclick: () => { if (!c.out) set({ date: key, view: 'day' }); },
    });
    add(cell,
      h('div.wcell-hd',
        h('span.wcell-num', { text: String(c.n) }),
        h('span', { style: { flex: '1' } }),
        c.out ? null : h('span.wcell-count', { text: String(items.length) })),
      h('div.wcell-items', ...items.slice(0, 3).map(t => h('div.wcell-item', { text: t }))),
      items.length > 3 ? h('div.wcell-more', { text: `+ ещё ${items.length - 3}` }) : null);
    return cell;
  }));

  return h('div', head, grid);
}

// ── Привычки, заметки, настройки ─────────────────────────────

function habitsScreen() {
  const addBtn = h('button.wbtn', { type: 'button', onclick: () => set({ modal: 'habit' }) });
  add(addBtn, ico('plus', '16px'), h('span', { text: 'Новая привычка' }));

  const dashed = h('button.wbtn-dashed', { type: 'button', onclick: () => set({ modal: 'habit' }) });
  add(dashed, ico('plus', '16px'), h('span', { text: 'Новая привычка' }));

  const act = HABITS.filter(x => x.active);
  return h('div.wnarrow',
    h('div.whead',
      h('div.whead-text',
        h('div.whead-title', { text: 'Привычки' }),
        h('div.whead-hint', { text: `${act.length} активные сегодня · лучшая серия 24 дня` })),
      addBtn),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      ...HABITS.map(hb => habitCard(hb, true)),
      dashed));
}

function notesScreen() {
  const addBtn = h('button.wbtn', { type: 'button', onclick: () => set({ modal: 'note', noteId: 'new', noteDated: false }) });
  add(addBtn, ico('plus', '16px'), h('span', { text: 'Новая заметка' }));

  const filters = h('div.wwrap', { style: { marginBottom: '14px' } });
  add(filters, ...[['all', 'Все заметки'], ['day', 'На этот день'], ['free', 'Без даты']].map(([k, label]) =>
    chip(label, state.noteFilter === k, () => set({ noteFilter: k }))));

  const shown = NOTES.filter(n => state.noteFilter === 'all' || (state.noteFilter === 'day' ? n.on : !n.on));
  const grid = h('div.wnotes');
  add(grid, ...shown.map(n => {
    const card = h('button.wnote', { type: 'button', onclick: () => set({ modal: 'note', noteId: n.id, noteDated: n.on }) });
    add(card,
      h('div.wnote-hd',
        h('span.wnote-title', { text: n.title }),
        h('span.wnote-date', { text: n.date, class: n.on ? 'on' : '' })),
      h('div.wnote-text', { text: n.text }));
    return card;
  }));
  const newCard = h('button.wnote-new', { type: 'button', onclick: () => set({ modal: 'note', noteId: 'new', noteDated: false }) });
  add(newCard, ico('plus', '17px'), h('span', { text: 'Новая заметка' }));
  add(grid, newCard);

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
    h('button', { type: 'button', text: label, class: state.theme === k ? 'on' : '', onclick: () => set({ theme: k === 'light' ? 'light' : k === 'dark' ? 'dark' : 'system' }) })));

  const scaleSeg = h('div.wsegline');
  add(scaleSeg, ...[[1, '100%'], [1.25, '125%'], [1.5, '150%']].map(([v, label]) =>
    h('button', {
      type: 'button', text: label, class: state.scale === v ? 'on' : '',
      style: { fontSize: `${13 + (v - 1) * 8}px` },
      onclick: () => set({ scale: v }),
    })));

  const swatches = h('div.wswatches');
  add(swatches, ...Object.keys(PALETTE).map(k => {
    const c = PALETTE[k][dark() ? 'dark' : 'light'];
    const on = state.color === k;
    const b = h('button.wswatch', { type: 'button', class: on ? 'on' : '', onclick: () => set({ color: k }) });
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

  const switches = [
    { k: 'carry', label: 'Переносить невыполненное', hint: 'задачи уезжают на завтра' },
    { k: 'slots', label: 'Делить питание на приёмы', hint: 'завтрак, обед, ужин, перекус' },
    { k: 'kcal', label: 'Показывать калории', hint: 'счётчик и дневная цель' },
    { k: 'toSched', label: 'Питание со временем — в расписание', hint: 'только по подтверждению' },
  ];
  const day = h('div.wpanel-list', cap('день и питание'));
  add(day, ...switches.map(s => {
    const on = state.sw[s.k];
    const row = h('button.wrow-sw', { type: 'button', onclick: () => set(x => ({ sw: { ...x.sw, [s.k]: !x.sw[s.k] } })) });
    add(row,
      h('div.wrow-sw-body',
        h('div.wrow-sw-title', { text: s.label }),
        h('div.wrow-sw-hint', { text: s.hint })),
      sw(on));
    return row;
  }));

  const links = [
    { icon: 'alarm-fill', label: 'Звук будильника', value: 'Рассвет', m: 'sound' },
    { icon: 'bell', label: 'Звук уведомлений', value: 'Капля', m: 'sound' },
    { icon: 'calendar-check', label: 'Общее расписание', value: 'шаблон дня', m: 'template' },
    { icon: 'file-arrow-down', label: 'Экспорт данных', value: 'JSON', m: 'export' },
    { icon: 'file-arrow-up', label: 'Импорт данных', value: 'JSON', m: 'import' },
  ];
  const data = h('div.wpanel-list', cap('звуки и данные'));
  add(data, ...links.map(l => {
    const row = h('button.wrow-link', {
      type: 'button',
      onclick: () => set({
        modal: l.m === 'export' || l.m === 'import' ? 'file' : l.m,
        fileKind: l.m, soundKind: l.label,
      }),
    });
    add(row, ico(l.icon, '17px'), h('span', { text: l.label }),
      h('span.wrow-link-val', { text: l.value }), ico('caret-right', '14px'));
    return row;
  }));

  const devices = h('div.wpanel',
    cap('устройства'),
    h('div.wpanel-note', { text: 'Браузер — это ещё одно устройство: расписание и дела синхронизируются с телефоном.' }),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '14px' } },
      ...DEVICES.map(d => h('div.wdev',
        ico(d.icon, '17px'),
        h('div.wdev-body', h('div.wdev-name', { text: d.name }), h('div.wdev-seen', { text: d.seen })),
        h('span.wdev-tag', { text: d.tag })))));

  return h('div',
    h('div.whead-title', { text: 'Настройки', style: { marginBottom: '18px' } }),
    h('div.wsettings', look, day, data, devices));
}

// ── Шторки ───────────────────────────────────────────────────

function openRow(id) {
  const r = SCHEDULE.find(x => x.id === id) ?? SCHEDULE[3];
  set({ modal: 'row', rowId: id, rowStart: r.start, rowEnd: r.end ?? r.start + 30, rowField: 'start' });
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
    const r = SCHEDULE.find(x => x.id === state.rowId) ?? SCHEDULE[3];
    const rs = state.rowStart ?? r.start;
    const re = state.rowEnd ?? (r.end ?? r.start + 30);
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
    add(leads, ...LEADS.map(l => sheetChip(l.label, hasLead(r, l.k), () => toggleLead(r, l.k))));

    const modes = h('div.wgrid2');
    add(modes, ...ALARM.map(a => opt(a.label, a.icon, alarmOf(r) === a.k, () => set(s => ({ alarms: { ...s.alarms, [r.id]: a.k } })))));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что делаем' }),
        h('input.winput', { value: state.rowId === 'new' ? '' : r.title, placeholder: 'Например, работа над отчётом' })),
      tiles,
      h('div.wclock',
        h('div.wclock-cap', { text: 'можно вписать вручную выше или выбрать час' }),
        clockGrid(24, 1, target, setHour),
        h('div.wclock-cap', { text: 'минуты', style: { margin: '12px 0 9px' } }),
        clockGrid(12, 5, target, setMin)),
      h('div', h('div.wfield-label', { text: 'предупредить · можно несколько' }), leads),
      h('div', h('div.wfield-label', { text: 'чем предупредить' }), modes),
      footer('Удалить', 'Готово'));
  },

  // ── Расписание дня списком ──
  schedule() {
    const list = h('div.wstack-tight');
    add(list, ...SCHEDULE.map(r => {
      const mode = alarmOf(r);
      const row = h('button.wsheet-row', { type: 'button', onclick: () => openRow(r.id) });
      add(row,
        ico('dots-six-vertical', '16px', 'wgrab'),
        h('span.wlead', { text: hhmm(r.start) }),
        h('span.wtitle', { text: r.title }),
        mode === 'off' ? null : ico(bellOf(mode).icon, '16px', 'wbell'),
        ico('caret-right', '14px', 'wchev'));
      return row;
    }));

    const addRow = h('button.wbtn-dashed', { type: 'button' });
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
      add(grid, ...AI_PLAN.map(p => {
        const on = !state.aiOff[p.id];
        const row = h('button.wplan-item', { type: 'button', class: on ? '' : 'off', onclick: () => set(s => ({ aiOff: { ...s.aiOff, [p.id]: on } })) });
        add(row, box(on),
          h('div.wplan-item-body',
            h('div.wplan-item-title', { text: p.title }),
            h('div.wplan-item-meta', { text: p.meta })),
          h('span.wtag', { text: p.tag }));
        return row;
      }));
      const count = AI_PLAN.filter(p => !state.aiOff[p.id]).length;
      return h('div.wstack',
        h('div.wbubble',
          h('span.wbubble-ava', ico('sparkle-fill', '16px')),
          h('div.wbubble-text', { text: 'Вот что добавлю. Снимите галочку, если что-то лишнее.' })),
        grid,
        h('div.wrow-end',
          h('button.wbtn-quiet', { type: 'button', text: 'Исправить', onclick: () => set({ aiStep: 'input' }) }),
          h('button.wbtn-wide', { type: 'button', text: `Добавить ${count}`, onclick: closeModal })));
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
      onclick: () => {
        set({ aiStep: 'listening' });
        setTimeout(() => set({ aiStep: 'input', aiText: AI_SAMPLE }), 1700);
      },
    });
    add(mic, ico(listening ? 'waveform-fill' : 'microphone-fill', '22px'));

    return h('div.wstack',
      h('div.whint', { text: 'Опишите день словами или продиктуйте — разложу по расписанию, делам и напоминаниям.' }),
      h('div.wai-row', area, mic),
      h('button.wbtn-wide', {
        type: 'button', text: listening ? 'Слушаю…' : 'Разобрать',
        onclick: () => set({ aiStep: 'plan', aiText: state.aiText || AI_SAMPLE }),
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
        h('input.winput', { value: 'Вода — 2 литра' })),
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
      footer('Отмена', 'Создать привычку'));
  },

  // ── Заметка ──
  note() {
    const n = NOTES.find(x => x.id === state.noteId);
    const kinds = h('div.wrow');
    add(kinds, ...[[false, 'Просто заметка'], [true, 'На дату']].map(([v, label]) =>
      sheetChip(label, state.noteDated === v, () => set({ noteDated: v }))));
    if (state.noteDated) {
      const cur = dayOf();
      const badge = h('span.wdate-chip');
      add(badge, ico('calendar-blank', '15px'), h('span', { text: `${cur.getDate()} ${MONTHS[cur.getMonth()]} · покажется в делах` }));
      add(kinds, badge);
    }

    return h('div.wstack',
      h('input.winput', { value: state.noteId === 'new' ? '' : (n?.title ?? ''), placeholder: 'Заголовок — можно оставить пустым' }),
      kinds,
      h('textarea.wtextarea', { value: state.noteId === 'new' ? '' : (n?.text ?? ''), placeholder: 'О чём не хочется забыть' }),
      footer('Удалить', 'Сохранить'));
  },

  // ── Задача ──
  task() {
    const t = TASKS.find(x => x.id === state.taskId);
    const cats = h('div.wrow');
    add(cats, ...CATS.map(c =>
      sheetChip(c.label, (state.taskCat ?? t?.cat) === c.k, () => set({ taskCat: c.k }), 'wchip-flex')));
    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'задача' }),
        h('input.winput', { value: state.taskId === 'new' ? '' : (t?.title ?? ''), placeholder: 'Что нужно сделать' })),
      h('div', h('div.wfield-label', { text: 'категория' }), cats),
      footer('Удалить', 'Готово'));
  },

  // ── Приём пищи ──
  meal() {
    const m = MEALS.find(x => x.id === state.mealId);
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
    add(leads, ...LEADS.map(l => {
      const fake = { id: `meal-${state.mealId}`, leads: ['at'] };
      return sheetChip(l.label, hasLead(fake, l.k), () => toggleLead(fake, l.k));
    }));

    const schedCard = h('button.wtoggle-card', { type: 'button', onclick: () => set(s => ({ mealSched: !s.mealSched })) },
      h('div.wtoggle-card-body',
        h('div.wrow-sw-title', { text: 'Добавить в расписание' }),
        h('div.wrow-sw-hint', { text: `займёт блок ${state.mealDur < 60 ? state.mealDur + ' мин' : '1 ч'}, ничего не сдвинет без подтверждения` })),
      sw(state.mealSched));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'что едим' }),
        h('input.winput', { value: state.mealId === 'new' ? '' : (m?.title ?? ''), placeholder: 'Например, курица с рисом' })),
      h('div',
        h('div.wfield-label', { text: 'время' }), modes,
        hasTime
          ? h('div.wrow', { style: { marginTop: '12px' } },
            h('input.wtime', { value: state.mealMode === 'window' ? '12:00' : '19:30' }),
            h('span.whint', { text: state.mealMode === 'window' ? '—' : '+' }),
            h('input.wtime', { value: state.mealMode === 'window' ? '14:00' : '00:30' }))
          : null),
      h('div.wrow', h('input.wnum', { value: String(m?.kcal ?? 640) }), h('span.wsmall', { text: 'ккал — можно оставить пустым' })),
      exact ? h('div', h('div.wfield-label', { text: 'сколько занять в расписании' }), durs) : null,
      exact ? schedCard : null,
      h('div', h('div.wfield-label', { text: 'напомнить · можно несколько' }), leads),
      footer('Удалить', 'Готово'));
  },

  // ── Напоминание ──
  reminder() {
    const r = REMINDERS.find(x => x.id === state.remId) ?? REMINDERS[0];
    const repeats = h('div.wwrap');
    add(repeats, ...REPEATS.map(x => sheetChip(x, state.remRepeat === x, () => set({ remRepeat: x }))));

    const leads = h('div.wwrap');
    add(leads, ...[...LEADS, { k: 'week', label: 'за неделю' }].map(l => {
      const fake = { id: `rem-${state.remId}`, leads: ['day'] };
      return sheetChip(l.label, hasLead(fake, l.k), () => toggleLead(fake, l.k));
    }));

    return h('div.wstack',
      h('label', h('span.wfield-label', { text: 'о чём напомнить' }),
        h('input.winput', { value: state.remId === 'new' ? '' : r.title, placeholder: 'Например, продлить подписку' })),
      h('div.wrow',
        h('input.wtime', { value: '05.08.2026', style: { width: '128px' } }),
        h('input.wtime', { value: '10:00' }),
        h('span.whint', { text: 'дата и время — можно вписать вручную' })),
      h('div', h('div.wfield-label', { text: 'повтор' }), repeats),
      h('div', h('div.wfield-label', { text: 'предупредить · можно несколько' }), leads),
      footer('Удалить', 'Готово'));
  },

  // ── Звук ──
  sound() {
    const list = h('div.wstack-tight');
    add(list, ...SOUNDS.map(s => {
      const b = h('button.wopt', { type: 'button', class: state.sound === s.k ? 'on' : '', onclick: () => set({ sound: s.k }) });
      add(b, ico(s.k === 'Случайный' ? 'shuffle' : 'music-note-simple', '17px'),
        h('div', { style: { flex: '1', textAlign: 'left' } },
          h('div', { text: s.k, style: { font: '500 15px/1.2 var(--ui)' } }),
          h('div', { text: s.hint, style: { font: '400 12px/1.4 var(--ui)', opacity: '.75', marginTop: '4px' } })));
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
    const scopes = h('div.wwrap');
    add(scopes, ...(imp ? ['Добавить к текущим', 'Заменить всё'] : ['Этот день', 'Этот месяц', 'Все данные'])
      .map((s, i) => sheetChip(s, state.printScope === i, () => set({ printScope: i }))));

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
          h('div.wfile-name', { text: imp ? 'newday-backup.json' : 'newday-2026-08-05.json' }),
          h('div.wfile-meta', { text: imp ? '2,4 МБ · 184 дня · 12 привычек' : 'сохранится в «Загрузки» · около 240 КБ' }))),
      h('button.wbtn-wide', { type: 'button', text: imp ? 'Выбрать файл и импортировать' : 'Сохранить файл', onclick: closeModal }));
  },

  // ── Общее расписание ──
  template() {
    const list = h('div.wstack-tight');
    add(list, ...SCHEDULE.slice(0, 6).map(r => {
      const row = h('button.wsheet-row', { type: 'button', onclick: () => openRow(r.id) });
      add(row, ico('dots-six-vertical', '16px', 'wgrab'),
        h('span.wlead', { text: hhmm(r.start) }),
        h('span.wtitle', { text: r.title }),
        ico('caret-right', '14px', 'wchev'));
      return row;
    }));
    const addRow = h('button.wbtn-dashed', { type: 'button' });
    add(addRow, ico('plus', '15px'), h('span', { text: 'Строка шаблона' }));
    return h('div.wstack-tight',
      h('div.whint', { text: 'Шаблон без дат. Новые дни заполняются им, если ничего не запланировано.', style: { marginBottom: '4px' } }),
      list, addRow,
      h('button.wbtn-wide', { type: 'button', text: 'Готово', onclick: closeModal }));
  },

  // ── Печать ──
  print() {
    const scopes = h('div.wwrap');
    add(scopes, ...['Этот день', 'Неделя', 'Месяц'].map((s, i) =>
      sheetChip(s, state.printScope === i, () => set({ printScope: i }))));

    const parts = h('div.wgrid2');
    add(parts, ...PRINT_PARTS.map(p => {
      const on = !state.printOff[p];
      const row = h('button.wplan-item', { type: 'button', onclick: () => set(s => ({ printOff: { ...s.printOff, [p]: on } })) });
      add(row, box(on), h('span', { text: p, style: { flex: '1', font: '400 14px/1.3 var(--ui)' } }));
      return row;
    }));

    return h('div.wstack',
      h('div.whint', { text: 'Соберём лист и отдадим в диалог печати браузера — оттуда можно сохранить в PDF.' }),
      scopes, parts,
      h('button.wbtn-wide', { type: 'button', text: 'Отправить на печать', onclick: closeModal }));
  },
};

// ── Сборка ───────────────────────────────────────────────────

const SCREENS = { today: todayScreen, plan: planScreen, habits: habitsScreen, notes: notesScreen, settings: settingsScreen };

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
    h('div.wmain', topBar(), h('div.wbody.wscroll', SCREENS[state.screen]())),
    modal());
}

// Escape закрывает шторку — привычнее, чем искать крестик
addEventListener('keydown', e => { if (e.key === 'Escape' && state.modal) closeModal(); });
/*
 * Отпустили мышь — где бы это ни случилось. Слушаем на окне, потому что
 * человек часто уводит курсор за край колонки, а блок всё равно должен
 * создаться: иначе протягивание вниз до конца дня обрывается ничем.
 */
addEventListener('mouseup', () => {
  if (!dragging) return;
  const { from, to } = dragging;
  dragging.sel.remove();
  dragging = null;
  const a = Math.min(from, to);
  const b = Math.max(a + SNAP, Math.max(from, to));
  set({ modal: 'row', rowId: 'new', rowStart: a, rowEnd: b, rowField: 'start' });
});

render();
