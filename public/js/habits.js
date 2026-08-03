/**
 * Экран управления привычками.
 *
 * Создание — в один шаг: эмодзи, название, пресет. Три оси (цель, поведение
 * при срыве, полярность) настраиваются по отдельности под «Настроить»,
 * потому что вместе они дают восемь осмысленных комбинаций, а сразу
 * показывать восемь переключателей — способ отпугнуть человека.
 */

import './theme.js';
import { h, clear, $, replace, add } from './dom.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { openSheet, confirmSheet } from './components/sheet.js';
import { emojiButton } from './emoji.js';
import { cycleTheme, getTheme, THEME_ICON, THEME_LABEL } from './theme.js';
import { days as plDays } from './dates.js';

const PRESETS = [
  { id: 'simple',      title: 'Просто привычка', hint: 'Делаю регулярно, считаю серию и процент' },
  { id: 'challenge30', title: '30 дней подряд',  hint: 'Сбился — счётчик начинается заново' },
  { id: 'marathon300', title: 'Марафон 300 дней',hint: 'Копятся выполненные дни, пропуски не обнуляют' },
  { id: 'quit',        title: 'Бросаю',          hint: 'Отмечаю, что удержался; срыв обнуляет счётчик' },
];

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'teal', 'pink', 'gray'];
const COLOR_VAR = {
  blue: 'var(--c-work)', green: 'var(--c-home)', orange: 'var(--c-sport)',
  red: 'var(--c-danger)', purple: 'var(--c-food)', teal: 'var(--c-success)',
  pink: 'var(--c-habits)', gray: 'var(--ink-3)',
};

let list = [];
let showArchived = false;
const statsCache = new Map();

// ── Каркас ───────────────────────────────────────────────────

function layout() {
  const body = h('div.app-body', { style: { gridTemplateColumns: 'minmax(0, 1fr)' } },
    h('div.col', { id: 'habits-col' }));

  replace($('#app'), 
    h('header.hdr',
      h('a.hdr-brand', { href: '/app.html' },
        h('img', { src: '/icons/logo-256.png', alt: '', width: 26, height: 26 }),
        h('b', { text: 'NewDay' })),
      h('span.grow', h('span.eyebrow', { text: 'привычки' })),
      h('div.hdr-actions',
        h('button.icon-btn', {
          text: THEME_ICON[getTheme()], 'aria-label': 'Переключить тему',
          title: `Тема: ${THEME_LABEL[getTheme()]}`,
          onclick: e => { const n = cycleTheme(); e.currentTarget.textContent = THEME_ICON[n]; },
        }),
        h('a.btn.btn-sm', { href: '/app.html', text: '← К дню' }))),
    body);
  return $('#habits-col');
}

// ── Список ───────────────────────────────────────────────────

async function render(col) {
  const active = list.filter(x => !x.archived_at);
  const archived = list.filter(x => x.archived_at);

  replace(col, 
    h('section.card',
      h('div.card-hd',
        h('span.eyebrow', { text: `мои привычки · ${active.length}` }),
        h('button.btn.btn-sm.btn-primary', { text: '+ Привычка', onclick: () => openEditor(null) })),
      active.length
        ? h('div.card-bd', ...active.map(card))
        : h('p.empty', { text: 'Привычек пока нет. Начните с одной — например, «Вода».' })),

    archived.length
      ? h('section.card',
          h('div.card-hd',
            h('span.eyebrow', { text: `архив · ${archived.length}` }),
            h('button.btn.btn-sm.btn-ghost', {
              text: showArchived ? 'Скрыть' : 'Показать',
              onclick: () => { showArchived = !showArchived; render(col); },
            })),
          showArchived ? h('div.card-bd', ...archived.map(card)) : null)
      : null);

  for (const x of active) loadStats(x.id, col);
}

function card(x) {
  const color = COLOR_VAR[x.color] || 'var(--c-work)';
  const s = statsCache.get(x.id);

  return h('div.hcard', { dataset: { id: x.id } },
    h('span.hemoji', { text: x.emoji || '•', style: { fontSize: '20px' } }),
    h('div', { style: { minWidth: 0 } },
      h('div.row',
        h('b', { text: x.title }),
        x.archived_at ? h('span.pill', { text: 'в архиве' }) : null),
      h('div.hmeta', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
        h('span', { text: describe(x) }),
        s ? h('span', { text: `серия ${plDays(s.currentStreak)}` }) : null,
        s && s.percent !== null ? h('span', { text: `${s.percent}%` }) : null),
      s ? h('div.dots', { style: { marginTop: '6px' } },
            ...s.last14.map(d => h('i', { class: d.status || 'none', title: d.date })))
        : null),
    h('div.row',
      s?.challenge
        ? h('span.hchal', { text: `${s.challenge.day}/${s.challenge.target}`, style: { color } })
        : null,
      x.archived_at
        ? h('button.btn.btn-sm', { text: 'Вернуть', onclick: () => restore(x) })
        : h('button.icon-btn', { text: '⋯', 'aria-label': 'Действия', onclick: () => openMenu(x) })));
}

function describe(x) {
  const parts = [];
  if (x.mode === 'challenge') {
    parts.push(x.break_policy === 'reset' ? 'подряд' : 'накопительно');
    if (x.challenge_target_days) parts.push(`${x.challenge_target_days} дней`);
  } else parts.push('бессрочно');
  if (x.polarity === 'avoid') parts.push('удерживаюсь');
  if (x.schedule_mask !== 127) {
    parts.push(WEEKDAYS.filter((_, i) => x.schedule_mask & (1 << i)).join(' '));
  }
  if (x.allowed_skips_per_week > 0) parts.push(`заморозок ${x.allowed_skips_per_week}/нед`);
  return parts.join(' · ');
}

async function loadStats(id, col) {
  if (statsCache.has(id)) return;
  try {
    statsCache.set(id, await api.habits.stats(id));
    const node = col.querySelector(`.hcard[data-id="${id}"]`);
    if (node) node.replaceWith(card(list.find(x => x.id === id)));
  } catch { /* статистика не критична для управления */ }
}

// ── Редактор ─────────────────────────────────────────────────

function openEditor(existing) {
  const draft = existing
    ? {
        emoji: existing.emoji, title: existing.title, preset: null,
        mode: existing.mode, polarity: existing.polarity,
        breakPolicy: existing.break_policy,
        challengeTargetDays: existing.challenge_target_days,
        scheduleMask: existing.schedule_mask,
        allowedSkipsPerWeek: existing.allowed_skips_per_week,
        color: existing.color,
      }
    : {
        emoji: '💧', title: '', preset: 'simple',
        mode: 'ongoing', polarity: 'do', breakPolicy: 'reset',
        challengeTargetDays: null, scheduleMask: 127,
        allowedSkipsPerWeek: 0, color: 'blue',
      };

  openSheet(existing ? 'Настроить привычку' : 'Новая привычка', (body, { close }) => {
    const advanced = h('div.stack', { style: { display: existing ? 'grid' : 'none' } });
    const presetBox = h('div.stack');

    const titleInput = h('input.input', {
      value: draft.title, placeholder: 'Например, «Вода 2 литра»',
      'aria-label': 'Название привычки',
      oninput: e => { draft.title = e.target.value; },
    });

    add(body,
      h('div.row',
        emojiButton(draft.emoji, e => { draft.emoji = e; }),
        h('div.grow', titleInput)),
      !existing ? h('div', h('div.eyebrow', { text: 'как считать' }), presetBox) : null,
      h('button.btn.btn-ghost.btn-block', {
        text: existing ? 'Свернуть настройки' : 'Настроить подробнее',
        onclick: e => {
          const open = advanced.style.display !== 'none';
          advanced.style.display = open ? 'none' : 'grid';
          e.currentTarget.textContent = open ? 'Настроить подробнее' : 'Свернуть настройки';
        },
      }),
      advanced);

    // пресеты
    for (const p of PRESETS) {
      presetBox.append(h('button.preset', {
        type: 'button', 'aria-pressed': draft.preset === p.id ? 'true' : 'false',
        onclick: () => {
          draft.preset = p.id;
          applyPreset(draft, p.id);
          [...presetBox.children].forEach((c, i) =>
            c.setAttribute('aria-pressed', PRESETS[i].id === p.id ? 'true' : 'false'));
          drawAdvanced();
        },
      },
        h('b', { text: p.title }),
        h('span.small', { text: p.hint })));
    }

    function drawAdvanced() {
      replace(advanced, 
        pickRow('Цель', [['ongoing', 'Бессрочно'], ['challenge', 'Челлендж']],
          draft.mode, v => { draft.mode = v; drawAdvanced(); }),
        draft.mode === 'challenge'
          ? h('label.stack',
              h('span.eyebrow', { text: 'сколько дней' }),
              h('input.input', {
                type: 'number', min: 1, max: 3650, value: draft.challengeTargetDays ?? 30,
                oninput: e => { draft.challengeTargetDays = Number(e.target.value) || null; },
              }))
          : null,
        pickRow('При срыве', [['reset', 'Начинать заново'], ['keep', 'Копить дальше']],
          draft.breakPolicy, v => { draft.breakPolicy = v; }),
        pickRow('Что отмечаю', [['do', 'Сделал'], ['avoid', 'Удержался']],
          draft.polarity, v => { draft.polarity = v; }),
        h('div',
          h('span.eyebrow', { text: 'дни недели' }),
          h('div.row', { style: { gap: '4px', marginTop: '6px', flexWrap: 'wrap' } },
            ...WEEKDAYS.map((d, i) => h('button.tab', {
              type: 'button',
              'aria-selected': (draft.scheduleMask & (1 << i)) ? 'true' : 'false',
              text: d,
              onclick: e => {
                draft.scheduleMask ^= (1 << i);
                if (draft.scheduleMask === 0) draft.scheduleMask = 1 << i; // хотя бы один день
                e.currentTarget.setAttribute('aria-selected',
                  (draft.scheduleMask & (1 << i)) ? 'true' : 'false');
              },
            })))),
        h('label.stack',
          h('span.eyebrow', { text: 'заморозок в неделю' }),
          h('input.input', {
            type: 'number', min: 0, max: 7, value: draft.allowedSkipsPerWeek,
            oninput: e => { draft.allowedSkipsPerWeek = Number(e.target.value) || 0; },
          }),
          h('span.small', { text: 'Замороженный день не портит серию и не входит в процент' })),
        h('div',
          h('span.eyebrow', { text: 'цвет' }),
          h('div.row', { style: { gap: '6px', marginTop: '6px' } },
            ...COLORS.map(c => h('button.swatch', {
              type: 'button', 'aria-label': c,
              'aria-pressed': draft.color === c ? 'true' : 'false',
              style: { background: COLOR_VAR[c] },
              onclick: e => {
                draft.color = c;
                [...e.currentTarget.parentNode.children].forEach(n =>
                  n.setAttribute('aria-pressed', 'false'));
                e.currentTarget.setAttribute('aria-pressed', 'true');
              },
            })))));
    }
    drawAdvanced();
    titleInput.focus();
  },
  close => [
    h('button.btn', { text: 'Отмена', onclick: close }),
    h('button.btn.btn-primary', {
      text: existing ? 'Сохранить' : 'Создать',
      onclick: async () => {
        if (!draft.title.trim()) { toast('Введите название привычки', 'error'); return; }
        try {
          const payload = {
            emoji: draft.emoji, title: draft.title.trim(), color: draft.color,
            mode: draft.mode, polarity: draft.polarity, breakPolicy: draft.breakPolicy,
            challengeTargetDays: draft.mode === 'challenge' ? (draft.challengeTargetDays || 30) : null,
            scheduleMask: draft.scheduleMask, allowedSkipsPerWeek: draft.allowedSkipsPerWeek,
          };
          if (existing) await api.habits.update(existing.id, payload);
          else await api.habits.create({ ...payload, preset: draft.preset || 'simple' });
          close();
          statsCache.delete(existing?.id);
          await reload();
          toast(existing ? 'Привычка сохранена' : 'Привычка создана');
        } catch (e) { toast(e.message, 'error'); }
      },
    }),
  ]);
}

function applyPreset(draft, id) {
  const map = {
    simple:      { mode: 'ongoing',   polarity: 'do',    breakPolicy: 'reset', challengeTargetDays: null },
    challenge30: { mode: 'challenge', polarity: 'do',    breakPolicy: 'reset', challengeTargetDays: 30 },
    marathon300: { mode: 'challenge', polarity: 'do',    breakPolicy: 'keep',  challengeTargetDays: 300 },
    quit:        { mode: 'challenge', polarity: 'avoid', breakPolicy: 'reset', challengeTargetDays: 300 },
  };
  Object.assign(draft, map[id]);
}

function pickRow(label, options, value, onChange) {
  return h('div',
    h('span.eyebrow', { text: label.toLowerCase() }),
    h('div.row', { style: { gap: '4px', marginTop: '6px' } },
      ...options.map(([v, t]) => h('button.tab', {
        type: 'button', text: t,
        'aria-selected': v === value ? 'true' : 'false',
        onclick: e => {
          [...e.currentTarget.parentNode.children].forEach(n => n.setAttribute('aria-selected', 'false'));
          e.currentTarget.setAttribute('aria-selected', 'true');
          onChange(v);
        },
      }))));
}

// ── Действия ─────────────────────────────────────────────────

function openMenu(x) {
  openSheet(x.title, (body, { close }) => {
    add(body, h('div.stack',
      h('button.btn.btn-block', {
        text: 'Настроить', style: { justifyContent: 'flex-start' },
        onclick: () => { close(); openEditor(x); },
      }),
      h('button.btn.btn-block', {
        text: 'В архив', style: { justifyContent: 'flex-start' },
        onclick: async () => {
          close();
          try { await api.habits.archive(x.id); await reload(); toast('Привычка в архиве'); }
          catch (e) { toast(e.message, 'error'); }
        },
      }),
      h('div.divider'),
      h('button.btn.btn-danger.btn-block', {
        text: 'Удалить вместе с историей', style: { justifyContent: 'flex-start' },
        onclick: async () => {
          close();
          const ok = await confirmSheet('Удалить привычку?',
            `«${x.title}» и вся её история отметок будут стёрты без возможности вернуть. ` +
            'Если нужно просто убрать её с глаз — отправьте в архив.');
          if (!ok) return;
          try { await api.habits.destroy(x.id); await reload(); toast('Привычка удалена'); }
          catch (e) { toast(e.message, 'error'); }
        },
      })));
  });
}

async function restore(x) {
  try { await api.habits.restore(x.id); await reload(); toast('Привычка возвращена'); }
  catch (e) { toast(e.message, 'error'); }
}

// ── Загрузка ─────────────────────────────────────────────────

let col;

async function reload() {
  list = await api.habits.list(true);
  statsCache.clear();
  await render(col);
}

async function boot() {
  col = layout();
  try { await reload(); }
  catch (e) { toast(e.message, 'error'); }
}

boot();

// Проверка вёрстки на переполнение: /habits.html?diag=1
if (location.search.includes('diag=1')) import('./dev-overflow.js');
