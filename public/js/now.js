/**
 * Экран «Сейчас» — главный экран приложения.
 *
 * Отвечает на один вопрос: что происходит прямо в эту минуту и что дальше.
 * Поэтому здесь ничего не редактируется: карточка текущего блока, соседние
 * строки расписания «было / дальше» и три плитки прогресса. Всё остальное —
 * на «Делах» и в шторках.
 *
 * Экран сам обновляется раз в минуту: остаток времени, который не двигается,
 * хуже, чем его отсутствие.
 */

import './theme.js';
import { h, add, replace, $ } from './dom.js';
import { icon } from './vendor/icons.js';
import { bottomNav, topBar, iconButton, themeButton, screen, emptyState } from './shell.js';
import {
  state, subscribe, loadUser, loadDay, loadDaysIndex, today,
} from './store.js';
import * as api from './api.js';
import { addDays, weekdayShort, dayNumber, weekdayLong, formatShort, formatMinutes, nowMinutes, rangeDates, weekdayOf, plural } from './dates.js';
import { toast } from './toast.js';
import { syncAlarms, available as nativeAvailable } from './native.js';
import { mountInstallBanner } from './install-banner.js';
import * as appUpdate from './update.js';

const els = {};
let stats7 = null;      // сводка привычек за неделю, грузится отдельно

// ── Каркас ───────────────────────────────────────────────────

function build() {
  els.head = h('div');
  els.week = h('div.weekstrip');
  els.now = h('div');
  els.near = h('div.sect');
  els.tiles = h('div.tiles');

  replace($('#app'),
    screen(els.head, els.week, els.now, els.near, els.tiles),
    bottomNav('today'));
}

// ── Шапка дня ────────────────────────────────────────────────

function renderHead() {
  const d = state.date;
  replace(els.head, h('div.topbar',
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div.eyebrow', { text: weekdayLong(d) }),
      h('div', {
        text: formatShort(d),
        style: { font: 'var(--t-display)', letterSpacing: 'var(--track-tight)', marginTop: '8px' },
      })),
    h('div.topbar-actions',
      iconButton('caret-left', { title: 'Предыдущий день', onclick: () => go(addDays(d, -1)) }),
      iconButton('caret-right', { title: 'Следующий день', onclick: () => go(addDays(d, 1)) }),
      iconButton('calendar-blank', { title: 'Выбрать дату', accent: true, onclick: openCalendar }),
      themeButton())));
}

/** Неделя выбранного дня, от понедельника: числа не должны прыгать. */
function renderWeek() {
  const cur = state.date;
  const t = today();
  const from = addDays(cur, -(weekdayOf(cur) - 1));
  const index = new Map(state.daysIndex.map(x => [x.date, x]));

  replace(els.week, ...rangeDates(from, addDays(from, 6)).map(date => {
    const btn = h('button.wday', {
      type: 'button',
      class: [
        date === cur ? 'is-sel' : '',
        date === t ? 'is-today' : '',
        index.has(date) ? 'has-data' : '',
      ].filter(Boolean).join(' '),
      onclick: () => go(date),
      'aria-label': `${weekdayLong(date)}, ${formatShort(date)}`,
      ...(date === cur ? { 'aria-current': 'date' } : {}),
    });
    add(btn,
      h('span.dow', { text: weekdayShort(date) }),
      h('span.num', { text: dayNumber(date) }),
      h('span.mark'));
    return btn;
  }));
}

// ── Карточка «сейчас» и соседние строки ──────────────────────

/**
 * Раскладывает расписание относительно текущей минуты.
 * Для не-сегодняшнего дня «сейчас» не существует: показываем первый блок
 * как «начало дня», а не врём про текущий момент.
 */
function split() {
  const rows = [...(state.day?.schedule ?? [])].sort((a, b) => a.start_min - b.start_min);
  if (!rows.length) return { rows, now: null, past: null, next: null, isToday: false };

  const isToday = state.date === today();
  if (!isToday) return { rows, now: null, past: null, next: rows[0], isToday };

  const min = nowMinutes(state.user?.timezone);
  const endOf = r => r.end_min ?? r.start_min + 30;
  const now = rows.find(r => r.start_min <= min && min < endOf(r)) ?? null;
  const past = [...rows].reverse().find(r => endOf(r) <= min) ?? null;
  const next = rows.find(r => r.start_min > min) ?? null;
  return { rows, now, past, next, isToday, min };
}

function renderNow() {
  const { rows, now, next, isToday, min } = split();

  if (!rows.length) {
    replace(els.now, h('div.bigcard',
      h('div.kicker', { text: isToday ? 'сегодня' : 'этот день' }),
      h('div.bigcard-title', { text: 'Расписание пустое' }),
      h('div.bigcard-left', h('span', { text: 'Составьте план дня — и здесь появится текущий блок' }))));
    return;
  }

  if (now) {
    const end = now.end_min ?? now.start_min + 30;
    const left = end - min;
    const total = Math.max(1, end - now.start_min);
    const done = Math.round(((min - now.start_min) / total) * 100);
    const card = h('div.bigcard.is-now');
    add(card,
      h('div.kicker', h('span.livedot'),
        h('span', { text: `сейчас · ${formatMinutes(now.start_min)}–${formatMinutes(end)}` })),
      h('div.bigcard-title', { text: now.title || 'Без названия' }),
      h('div.bigcard-left',
        h('b', { text: leftLabel(left) }),
        h('span', { text: 'до конца блока' })),
      h('div.pbar', h('i', { style: { width: `${Math.min(100, Math.max(0, done))}%` } })));
    replace(els.now, card);
    return;
  }

  // Между блоками или день ещё не начался
  const card = h('div.bigcard');
  const beforeStart = isToday && next && min < next.start_min;
  add(card,
    h('div.kicker', { text: isToday ? 'свободно' : 'начало дня' }),
    h('div.bigcard-title', { text: next ? (next.title || 'Без названия') : 'День закончен' }),
    h('div.bigcard-left',
      next
        ? h('b', { text: beforeStart ? `через ${leftLabel(next.start_min - min)}` : formatMinutes(next.start_min) })
        : null,
      h('span', { text: next ? 'следующий блок' : 'запланированного больше нет' })));
  replace(els.now, card);
}

/** «1 ч 20 мин», «25 мин» — без нулевых частей. */
function leftLabel(minutes) {
  const m = Math.max(0, minutes);
  const hh = Math.floor(m / 60), mm = m % 60;
  if (!hh) return `${mm} мин`;
  return mm ? `${hh} ч ${mm} мин` : `${hh} ч`;
}

function renderNear() {
  const { rows, past, next } = split();
  const list = h('div.bigcard', { style: { padding: 'var(--s-2) var(--s-4)' } });

  if (past) add(list, miniLine(past, 'было', true));
  if (next) add(list, miniLine(next, 'дальше', false));
  if (!past && !next) add(list, h('p.small', { text: 'Расписание на этот день пустое.', style: { padding: 'var(--s-3) 0' } }));

  replace(els.near,
    h('div.sect-hd',
      h('span.eyebrow', { text: 'расписание' }),
      h('a.btn.btn-sm.btn-ghost', { href: '/app.html', text: `всё · ${rows.length}` })),
    list);
}

function miniLine(row, cap, isPast) {
  const line = h('div.miniline', { class: isPast ? 'is-past' : '' });
  add(line,
    h('time', { text: formatMinutes(row.start_min) }),
    h('span.t', { text: row.title || 'Без названия' }),
    row.alarm_mode && row.alarm_mode !== 'none'
      ? icon(row.alarm_mode === 'alarm' ? 'alarm-fill' : 'bell', { size: '16px', label: 'напоминание' })
      : h('span.eyebrow', { text: cap }));
  return line;
}

// ── Три плитки ───────────────────────────────────────────────

function renderTiles() {
  const p = state.day?.progress?.total ?? { done: 0, possible: 0, percent: null };
  const habits = state.day?.habits ?? [];
  const activeHabits = habits.filter(x => x.activeToday);
  const doneHabits = activeHabits.filter(x => x.status === 'done').length;

  const tile = (cap, val, sub, href) => {
    const el = h('button.tile', { type: 'button', onclick: () => { if (href) location.href = href; } });
    add(el, h('span.cap', { text: cap }), h('span.val', { text: val }), h('span.sub', { text: sub }));
    return el;
  };

  replace(els.tiles,
    tile('дела', p.percent === null ? '—' : `${p.percent}%`,
      p.possible ? `${p.done} из ${p.possible} отмечено` : 'отмечать нечего', '/app.html'),
    tile('привычки', activeHabits.length ? `${doneHabits}/${activeHabits.length}` : '—',
      activeHabits.length ? 'за этот день' : 'на этот день нет', '/habits.html'),
    // «неделя», а не «за 7 дней»: на 320 px подпись не влезала в плитку,
    // а смысл всё равно раскрывает вторая строка
    tile('неделя',
      stats7?.percent === null || stats7 === null ? '—' : `${stats7.percent}%`,
      stats7?.best
        ? `серия ${stats7.best} ${plural(stats7.best, 'день', 'дня', 'дней')}`
        : 'привычки за 7 дней', '/habits.html'));
}

/**
 * Сводка привычек за неделю. Считаем на клиенте из /stats: отдельный
 * эндпоинт ради двух чисел не нужен, а данные там уже есть.
 */
async function loadWeekStats() {
  try {
    const from = addDays(state.date, -6);
    const data = await api.GET(`/stats?from=${from}&to=${state.date}`);
    const withPercent = (data.habits ?? []).filter(hh => hh.percent !== null);
    const percent = withPercent.length
      ? Math.round(withPercent.reduce((s, hh) => s + hh.percent, 0) / withPercent.length)
      : null;
    const best = Math.max(0, ...(data.habits ?? []).map(hh => hh.bestStreak ?? 0));
    stats7 = { percent, best };
  } catch {
    stats7 = null;   // сводка не критична: экран должен работать и без неё
  }
  renderTiles();
}

// ── Календарь ────────────────────────────────────────────────

async function openCalendar() {
  const { openSheet } = await import('./components/sheet.js');
  const { renderCalendar } = await import('./components/calendar.js');
  openSheet('Выберите дату', (body, { close }) => {
    add(body, renderCalendar(state.date, date => { close(); go(date); }));
  });
}

// ── Навигация и отрисовка ────────────────────────────────────

function renderAll() {
  renderHead();
  renderWeek();
  if (!state.day) return;
  renderNow();
  renderNear();
  renderTiles();
}

async function go(date) {
  location.hash = date;
  try {
    await loadDay(date);
    await loadWeekStats();
    if (nativeAvailable()) syncAlarms(state.user).catch(() => {});
  } catch (e) { toast(e.message, 'error'); }
}

/** Минутный тик: остаток времени и маркер «сейчас» должны быть живыми. */
function startClock() {
  const tick = () => { if (state.day && state.date === today()) { renderNow(); renderNear(); } };
  setTimeout(() => { tick(); setInterval(tick, 60000); }, 60000 - (Date.now() % 60000));
}

async function boot() {
  build();
  subscribe(renderAll);
  try { await loadUser(); } catch { return; }   // api.js уже увёл на вход

  const fromHash = location.hash.slice(1);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(fromHash) ? fromHash : today();
  await loadDaysIndex(addDays(start, -35), addDays(start, 35));
  await go(start);
  startClock();
  mountInstallBanner();
  appUpdate.check('startup').catch(() => {});

  window.addEventListener('hashchange', () => {
    const d = location.hash.slice(1) || today();
    if (d !== state.date && /^\d{4}-\d{2}-\d{2}$/.test(d)) go(d);
  });
}

boot();

// Проверка вёрстки на переполнение: /now.html?diag=1
if (location.search.includes('diag=1')) import('./dev-overflow.js');
