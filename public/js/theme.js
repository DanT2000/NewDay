/**
 * Оформление: тема и цвет приложения.
 *
 * Тема: system | light | dark. Цвет: violet | orange | green | red.
 * Оба значения читаются из localStorage до первой отрисовки, иначе страница
 * моргнёт светлым или чужим цветом. На сервер уходят фоном, чтобы совпадало
 * между устройствами.
 *
 * «Системная» разрешается здесь в явное light/dark и ставится атрибутом.
 * Раньше в этом случае атрибут просто снимался, а тёмные значения дублировались
 * в CSS внутри @media — два набора одних и тех же цветов неизбежно разъезжаются.
 */

const KEY = 'newday.theme';
const KEY_ACCENT = 'newday.accent';
const ORDER = ['system', 'light', 'dark'];

export const ACCENTS = [
  { key: 'violet', label: 'Сиреневый', dark: '#9d8cf0', light: '#6a54e8' },
  { key: 'orange', label: 'Оранжевый', dark: '#ff9330', light: '#f07d12' },
  { key: 'green',  label: 'Зелёный',   dark: '#3fd0b0', light: '#0fa88c' },
  { key: 'red',    label: 'Красный',   dark: '#ff6a5e', light: '#e83a30' },
];

const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

/*
 * Хранилище может быть запрещено — и не только в приватном окне: настройка
 * «блокировать данные сайтов» заставляет само обращение к localStorage
 * бросать. Этот модуль импортируется первым на каждом прежнем экране, и
 * бросок на уровне модуля означал не «тема по умолчанию», а пустую страницу
 * без единого слова. Ровно от этого и обёрнут boot-theme.js — здесь правило
 * то же, только записано было в одном месте из двух.
 */
const прочитать = (ключ) => {
  try { return globalThis.localStorage?.getItem(ключ) ?? null; } catch { return null; }
};
const записать = (ключ, значение) => {
  try { globalThis.localStorage?.setItem(ключ, значение); } catch { /* останется на этот заход */ }
};

export function getTheme() {
  const v = прочитать(KEY);
  return ORDER.includes(v) ? v : 'system';
}

export function getAccent() {
  const v = прочитать(KEY_ACCENT);
  return ACCENTS.some(a => a.key === v) ? v : 'violet';
}

/** Тема, которая реально нарисована: «системная» уже разрешена. */
export const resolvedTheme = () => {
  const t = getTheme();
  return t === 'system' ? (prefersDark() ? 'dark' : 'light') : t;
};

export function applyTheme(theme = getTheme(), accent = getAccent()) {
  const root = document.documentElement;
  const dark = theme === 'system' ? prefersDark() : theme === 'dark';
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-accent', accent);
  root.style.colorScheme = dark ? 'dark' : 'light';

  // Цвет системной строки статуса на телефоне — под фон приложения
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#161826' : '#f3f5fe');
}

function persist(fields) {
  import('./api.js')
    .then(({ PATCH }) => PATCH('/settings', fields))
    .catch(() => { /* локально уже применено, сервер догонит позже */ });
}

export function setTheme(theme, { save = true } = {}) {
  записать(KEY, theme);
  applyTheme(theme);
  if (save) persist({ theme });
}

export function setAccent(accent, { save = true } = {}) {
  записать(KEY_ACCENT, accent);
  applyTheme(getTheme(), accent);
  if (save) persist({ settings: { accent } });
}

export function cycleTheme() {
  const next = ORDER[(ORDER.indexOf(getTheme()) + 1) % ORDER.length];
  setTheme(next);
  return next;
}

export const THEME_LABEL = { system: 'Системная', light: 'Светлая', dark: 'Тёмная' };
export const THEME_ICON  = { system: '◐', light: '☀', dark: '☾' };

// Применяем сразу при импорте — до того, как отрисуется тело страницы
applyTheme();
matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => { if (getTheme() === 'system') applyTheme(); });
