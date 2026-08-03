/**
 * Итоги: прогресс по дням и статистика привычек за период.
 *
 * Графики рисуются inline-SVG без библиотек: они должны читаться
 * в обеих темах и работать офлайн внутри APK.
 */

import './theme.js';
import { h, svg, replace, $ } from './dom.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { addDays, formatShort, weekdayShort, days as plDays } from './dates.js';

const PERIODS = [['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['365', 'Год']];
const COLOR_VAR = {
  blue: 'var(--c-work)', green: 'var(--c-home)', orange: 'var(--c-sport)',
  red: 'var(--c-danger)', purple: 'var(--c-food)', teal: 'var(--c-success)',
  pink: 'var(--c-habits)', gray: 'var(--ink-3)',
};

let period = '30';
let data = null;
let col;

function layout() {
  const body = h('div.app-body', { style: { gridTemplateColumns: 'minmax(0, 1fr)' } },
    h('div.col', { id: 'stats-col', style: { maxWidth: '880px' } }));

  replace($('#app'),
    h('header.hdr',
      h('a.hdr-brand', { href: '/app.html' },
        h('img', { src: '/icons/logo-256.png', alt: '', width: 26, height: 26 }),
        h('b', { text: 'NewDay' })),
      h('span.grow', h('span.eyebrow', { text: 'итоги' })),
      h('div.hdr-actions', h('a.btn.btn-sm', { href: '/app.html', text: '← К дню' }))),
    body);
  return $('#stats-col');
}

// ── Графики ──────────────────────────────────────────────────

/** Сервер отдаёт день как { date, progress: {...} } — приводим к плоскому виду один раз. */
const flatten = days => days.map(d => ({ date: d.date, percent: d.progress?.percent ?? null }));

/** Столбики прогресса по дням. Дни без плана рисуются только подложкой. */
function barsChart(points) {
  const W = 100, H = 30, gap = 0.6;
  const n = Math.max(points.length, 1);
  const bw = (W - gap * (n - 1)) / n;

  return svg('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none',
    role: 'img', 'aria-label': 'Прогресс по дням',
  },
    ...points.map((p, i) => {
      const x = i * (bw + gap);
      const pct = p.percent ?? 0;
      const hh = Math.max(pct / 100 * H, pct > 0 ? 0.8 : 0);
      return svg('g', null,
        svg('rect', { x, y: 0, width: bw, height: H, fill: 'var(--ring-track)', rx: 0.6 }),
        // высота уже передаёт значение — менять ещё и цвет было бы украшением
        hh > 0 ? svg('rect', { x, y: H - hh, width: bw, height: hh, rx: 0.6, fill: 'var(--c-day)' }) : null,
        svg('title', null, `${p.date}: ${p.percent === null ? 'нет данных' : p.percent + '%'}`));
    }));
}

/** Плитка дней недели: где систематически проседает. */
function weekdayGrid(points) {
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
  for (const p of points) {
    if (p.percent === null) continue;
    const i = (new Date(p.date + 'T12:00:00Z').getUTCDay() + 6) % 7;
    buckets[i].sum += p.percent;
    buckets[i].n += 1;
  }
  return h('div.wgrid',
    ...buckets.map((b, i) => {
      const avg = b.n ? Math.round(b.sum / b.n) : null;
      return h('div.wcell',
        h('span.micro', { text: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][i] }),
        h('div.wbar', h('i', {
          style: {
            height: `${avg ?? 0}%`,
            background: avg === null ? 'var(--hairline)' : 'var(--c-day)',
          },
        })),
        h('span.micro', { text: avg === null ? '—' : `${avg}` }));
    }));
}

// ── Разделы ──────────────────────────────────────────────────

function render() {
  if (!data) return;
  const flat = flatten(data.days);
  const filled = data.days.filter(d => d.progress.possible > 0);
  const avg = filled.length
    ? Math.round(filled.reduce((s, d) => s + d.progress.percent, 0) / filled.length)
    : null;
  const best = filled.reduce((a, b) => (b.progress.percent > (a?.progress.percent ?? -1) ? b : a), null);

  replace(col,
    h('section.card',
      h('div.card-hd',
        h('span.eyebrow', { text: 'период' }),
        h('div.tabs', ...PERIODS.map(([v, t]) => h('button.tab', {
          text: t, 'aria-selected': v === period ? 'true' : 'false',
          onclick: () => { period = v; load(); },
        })))),
      h('div.card-bd.pad',
        h('div.row', { style: { gap: 'var(--s-6)', flexWrap: 'wrap' } },
          stat('средний день', avg === null ? '—' : `${avg}%`),
          stat('дней с планом', `${filled.length} из ${data.days.length}`),
          stat('лучший день', best ? `${formatShort(best.date)} · ${best.progress.percent}%` : '—')),
        h('div', { style: { marginTop: 'var(--s-4)' } }, barsChart(flat)),
        h('div.row', { style: { justifyContent: 'space-between', marginTop: '4px' } },
          h('span.micro', { text: formatShort(data.from) }),
          h('span.micro', { text: formatShort(data.to) })))),

    h('section.card',
      h('div.card-hd', h('span.eyebrow', { text: 'по дням недели' })),
      h('div.card-bd.pad', weekdayGrid(flat))),

    h('section.card',
      h('div.card-hd', h('span.eyebrow', { text: `привычки · ${data.habits.length}` })),
      data.habits.length
        ? h('div.card-bd', ...data.habits.map(habitRow))
        : h('p.empty', { text: 'Привычек нет. Заведите первую на экране «Привычки».' })),

    summaryCard());
}

const stat = (label, value) => h('div',
  h('div.eyebrow', { text: label }),
  h('div.title', { text: value, style: { marginTop: '2px' } }));

function habitRow(x) {
  const color = COLOR_VAR[x.color] || 'var(--c-work)';
  return h('div.hcard',
    h('span.hemoji', { text: x.emoji || '•', style: { fontSize: '20px' } }),
    h('div', { style: { minWidth: 0 } },
      h('b', { text: x.title }),
      h('div.hmeta', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
        h('span', { text: `серия ${plDays(x.currentStreak)}` }),
        h('span', { text: `лучшая ${plDays(x.bestStreak)}` }),
        h('span', { text: `сделано ${x.done}` }),
        x.missed ? h('span.danger', { text: `пропусков ${x.missed}` }) : null,
        x.skipped ? h('span', { text: `заморозок ${x.skipped}` }) : null),
      h('div.bar', { style: { marginTop: '6px' } },
        h('i', { style: { width: `${x.percent ?? 0}%`, background: color } })),
      h('div.dots', { style: { marginTop: '6px' } },
        ...x.last14.map(d => h('i', { class: d.status || 'none', title: d.date })))),
    h('div', { style: { textAlign: 'right' } },
      h('div.title', { text: x.percent === null ? '—' : `${x.percent}%` }),
      x.challenge
        ? h('div.hchal', { text: `${x.challenge.day}/${x.challenge.target}`, style: { color } })
        : null));
}

function summaryCard() {
  const s = data.summary;
  if (!s.bestHabit && !s.weakestHabit) return null;
  return h('section.card',
    h('div.card-hd', h('span.eyebrow', { text: 'коротко' })),
    h('div.card-bd.pad', h('div.stack',
      s.bestHabit ? h('p', { text: `Лучше всего идёт «${s.bestHabit.title}» — ${s.bestHabit.percent}%.` }) : null,
      s.weakestHabit ? h('p', { text: `Слабее всего «${s.weakestHabit.title}» — ${s.weakestHabit.percent}%. Может, сузить дни недели или добавить заморозки.` }) : null,
      h('p.small', { text: `Выше 70 % — ${s.habitsAbove70}, ниже 40 % — ${s.habitsBelow40}.` }))));
}

// ── Загрузка ─────────────────────────────────────────────────

async function load() {
  const { todayFor } = await import('./dates.js');
  const me = await api.me().catch(() => null);
  const to = todayFor(me?.timezone || 'Europe/Moscow');
  const from = addDays(to, -(Number(period) - 1));
  try {
    data = await api.stats(from, to);
    render();
  } catch (e) { toast(e.message, 'error'); }
}

async function boot() {
  col = layout();
  await load();
}

boot();

// Проверка вёрстки на переполнение: /stats.html?diag=1
if (location.search.includes('diag=1')) import('./dev-overflow.js');
