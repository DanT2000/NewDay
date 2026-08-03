/**
 * Тема: system | light | dark.
 *
 * Значение читается из localStorage до первой отрисовки, иначе страница
 * моргнёт светлым. На сервер уходит фоном, чтобы совпадало между устройствами.
 */

const KEY = 'newday.theme';
const ORDER = ['system', 'light', 'dark'];

export function getTheme() {
  const v = localStorage.getItem(KEY);
  return ORDER.includes(v) ? v : 'system';
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  const dark = theme === 'dark'
    || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0e1116' : '#ffffff');
}

export function setTheme(theme, { persist = true } = {}) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
  if (persist) {
    import('./api.js')
      .then(({ PATCH }) => PATCH('/settings', { theme }))
      .catch(() => { /* тема уже применена локально, сервер догонит позже */ });
  }
}

export function cycleTheme() {
  const next = ORDER[(ORDER.indexOf(getTheme()) + 1) % ORDER.length];
  setTheme(next);
  return next;
}

export const THEME_LABEL = { system: 'Системная', light: 'Светлая', dark: 'Тёмная' };
export const THEME_ICON  = { system: '◐', light: '☀', dark: '☾' };

// Применяем сразу при импорте — до того, как отрисуется тело страницы
applyTheme(getTheme());
matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => { if (getTheme() === 'system') applyTheme('system'); });
