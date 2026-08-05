/**
 * Каркас приложения: нижняя навигация и верхняя полоса.
 *
 * Пять вкладок, «Сейчас» посередине и подсвечена акцентом — так в макете.
 * Порядок слева направо: Заметки · Привычки · Сейчас · Дела · Настройки.
 * Раньше навигация была прописана в разметке каждой страницы отдельно,
 * и вкладки на разных экранах успели разъехаться; теперь одно место.
 *
 * Иконки — вшитые Phosphor: активная во fill, остальные в regular.
 */

import { h, add, replace } from './dom.js';
import { icon } from './vendor/icons.js';
import { cycleTheme, getTheme, THEME_ICON, THEME_LABEL } from './theme.js';
import { toast } from './toast.js';

export const TABS = [
  { key: 'notes',    label: 'Заметки',   href: '/notes.html',    icon: 'note' },
  { key: 'habits',   label: 'Привычки',  href: '/habits.html',   icon: 'check-circle' },
  { key: 'today',    label: 'Сейчас',    href: '/now.html',      icon: 'sun-horizon' },
  { key: 'tasks',    label: 'Дела',      href: '/app.html',      icon: 'list-checks' },
  { key: 'settings', label: 'Настройки', href: '/settings.html', icon: 'gear' },
];

/**
 * Нижняя навигация. `active` — ключ текущей вкладки.
 * Возвращает готовый элемент: страница вставляет его сама, чтобы порядок
 * блоков остался за ней.
 */
export function bottomNav(active) {
  const nav = h('nav.tabbar', { 'aria-label': 'Разделы' });
  add(nav, ...TABS.map(t => {
    const on = t.key === active;
    const link = h('a.tab-item', {
      href: t.href,
      class: [on ? 'is-active' : '', t.key === 'today' ? 'is-center' : ''].filter(Boolean).join(' '),
      ...(on ? { 'aria-current': 'page' } : {}),
    });
    add(link,
      icon(on ? `${t.icon}-fill` : t.icon, { size: '23px' }),
      h('span', { text: t.label }));
    return link;
  }));
  return nav;
}

/**
 * Верхняя полоса экрана: крупный заголовок и кнопки справа.
 * Заголовок 28 px — размер из макета, он же нижняя граница для читаемости.
 */
export function topBar(title, ...actions) {
  return h('header.topbar',
    h('h1.topbar-title', { text: title }),
    h('div.topbar-actions', ...actions));
}

/** Кнопка-иконка в рамке: базовая форма всех действий в шапке. */
export function iconButton(name, { title, onclick, accent = false, size = '17px' } = {}) {
  const btn = h('button.roundbtn', {
    type: 'button', title, 'aria-label': title,
    class: accent ? 'is-accent' : '',
    onclick,
  });
  add(btn, icon(name, { size }));
  return btn;
}

/** Переключатель темы — одинаковый на всех экранах. */
export function themeButton() {
  const btn = h('button.roundbtn.is-theme', {
    type: 'button',
    title: `Тема: ${THEME_LABEL[getTheme()]}`,
    'aria-label': 'Переключить тему',
    text: THEME_ICON[getTheme()],
    onclick: e => {
      const next = cycleTheme();
      e.currentTarget.textContent = THEME_ICON[next];
      e.currentTarget.title = `Тема: ${THEME_LABEL[next]}`;
      toast(`Тема: ${THEME_LABEL[next].toLowerCase()}`);
    },
  });
  return btn;
}

/**
 * Пустое состояние: иконка, строка и, если есть что предложить, действие.
 * Пустой экран — приглашение к действию, а не сообщение об отсутствии данных.
 */
export function emptyState(iconName, text, action = null) {
  const box = h('div.emptybox');
  add(box, icon(iconName, { size: '28px' }), h('p', { text }), action);
  return box;
}

/** Обёртка экрана: колонка с отступами и запасом под нижнюю навигацию. */
export function screen(...children) {
  return h('main.screen', ...children);
}

export { replace };
