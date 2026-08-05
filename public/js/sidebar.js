/**
 * Боковая навигация — то, чем приложение становится на компьютере.
 *
 * На телефоне разделы внизу, пятью вкладками; на широком экране они уходят
 * влево колонкой, и освободившаяся ширина достаётся содержимому. Это не
 * украшение: на мониторе полоса шириной 560 пикселей посреди пустоты — это
 * телефон, которым заставили пользоваться сидя.
 *
 * Размеры взяты из эталонного макета: колонка 236, строка 44, отступ 12,
 * скругление 12. Внизу — «Помощник», переключатель темы и карточка
 * пользователя.
 *
 * Модуль сам находит своё место (`#sidebar`) и сам определяет активный
 * раздел по адресу страницы, поэтому подключать его достаточно одной
 * строкой в разметке — экраны о нём ничего не знают.
 */

import { h, add, replace, $ } from './dom.js';
import { icon } from './vendor/icons.js';
import { TABS } from './shell.js';
import { cycleTheme, getTheme, THEME_LABEL } from './theme.js';
import { toast } from './toast.js';
import * as api from './api.js';
import { state, subscribe, today } from './store.js';
import { openAssistant, aiStatus } from './assistant.js';

/** Значок темы: показываем, что сейчас, а не что будет. */
const THEME_ICON = { light: 'sun', dark: 'moon', system: 'sun-horizon' };

let box = null;
let badges = {};
let aiReady = false;

export function mountSidebar() {
  box = $('#sidebar');
  if (!box) return;
  render();
  loadBadges();
}

function activeKey() {
  const path = location.pathname;
  return TABS.find(t => t.href === path)?.key
    ?? (path === '/' || path === '/index.html' ? 'today' : '');
}

function render() {
  if (!box) return;
  const active = activeKey();
  const theme = getTheme();

  const brand = h('a.sb-brand', { href: '/now.html', 'aria-label': 'NewDay' });
  add(brand,
    h('span.sb-mark', icon('sun-horizon', { size: '16px' })),
    h('b', { text: 'NewDay' }));

  const nav = h('nav.sb-nav', { 'aria-label': 'Разделы' });
  add(nav, ...TABS.map(t => {
    const on = t.key === active;
    const link = h('a.sb-item', {
      href: t.href,
      class: on ? 'is-active' : '',
      ...(on ? { 'aria-current': 'page' } : {}),
    });
    add(link,
      icon(on ? `${t.icon}-fill` : t.icon, { size: '19px' }),
      h('span.sb-label', { text: t.label }),
      // Счётчик появляется, только когда есть что показать: пустой кружок
      // рядом с «Заметками» ничего не сообщает
      badges[t.key] ? h('span.sb-badge', { text: badges[t.key] }) : null);
    return link;
  }));

  const foot = h('div.sb-foot');
  add(foot,
    // Кнопки нет, пока помощник не подключён: нажатие, которое отвечает
    // «не настроено», хуже отсутствующей кнопки
    aiReady
      ? h('button.sb-ai', {
        type: 'button',
        onclick: () => openAssistant(),
      }, icon('sparkle-fill', { size: '17px' }), h('span', { text: 'Помощник' }))
      : null,

    h('button.sb-ghost', {
      type: 'button',
      title: 'Переключить тему',
      onclick: e => {
        const next = cycleTheme();
        toast(`Тема: ${THEME_LABEL[next].toLowerCase()}`);
        // Перерисовываем целиком: меняется и значок, и подпись
        render();
        e.currentTarget?.blur?.();
      },
    }, icon(THEME_ICON[theme] ?? 'sun-horizon', { size: '16px' }),
       h('span', { text: THEME_LABEL[theme] })),

    h('a.sb-user', { href: '/settings.html' },
      h('span.sb-avatar', icon('user', { size: '15px' })),
      h('div.sb-user-body',
        h('div.sb-user-name', { text: userName() }),
        h('div.sb-user-note', { text: 'синхронизировано' }))));

  replace(box, brand, nav, foot);
  box.hidden = false;
}

/** Имя из профиля, если он уже загружен страницей. Иначе — почта. */
function userName() {
  const p = window.__newdayProfile;
  if (!p) return 'Профиль';
  const email = String(p.email || p.username || '');
  return p.name || email.split('@')[0] || 'Профиль';
}

/**
 * Счётчики у разделов.
 *
 * День берём из общего хранилища: экраны «Сейчас» и «Дела» его уже
 * загрузили, и второй такой же запрос был бы платой за то, что и так
 * лежит рядом. На страницах без дня (привычки, заметки, настройки)
 * запрашиваем сами — один раз.
 */
async function loadBadges() {
  try {
    const me = await api.me();
    window.__newdayProfile = me.user ?? me;
  } catch { /* не вошли — ни имени, ни счётчиков */ }

  aiReady = Boolean((await aiStatus()).ready);
  render();

  // Если день уже в хранилище — считаем сразу и следим за изменениями
  subscribe(() => fromDay(state.day));
  if (state.day) fromDay(state.day);
  else {
    try { fromDay(await api.getDay(today())); } catch { /* пусто */ }
  }

  try {
    const rows = await api.GET('/notes');
    const days = Array.isArray(rows) ? rows : (rows.days ?? []);
    if (days.length) { badges.notes = String(days.length); render(); }
  } catch { /* пусто */ }
}

/** «Сделано из возможного» по привычкам — то же число, что в прогрессе дня. */
function fromDay(day) {
  const h = day?.progress?.habits;
  if (!h?.possible) return;
  const next = `${h.done}/${h.possible}`;
  if (badges.habits === next) return;
  badges.habits = next;
  render();
}

mountSidebar();
