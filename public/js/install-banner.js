/**
 * Предложение поставить приложение — только для Android-браузера.
 *
 * Смысл в том, что будильник умеет только приложение: страница в браузере
 * не разбудит человека, у неё нет на это прав. Поэтому предложение уместно,
 * но навязываться нельзя — узкая полоса внизу, закрывается насовсем.
 *
 * Не показываем: внутри самого приложения, на iOS и на компьютере,
 * а также если человек уже закрыл полосу или уже заходил из приложения.
 */

import { h, add } from './dom.js';

const KEY = 'newday.install-banner.hidden';

function shouldShow() {
  if (localStorage.getItem(KEY)) return false;
  if (window.Capacitor?.isNativePlatform?.()) return false;
  // standalone — уже поставлено как PWA, предлагать нечего
  if (window.matchMedia('(display-mode: standalone)').matches) return false;
  if (navigator.standalone) return false;
  return /Android/i.test(navigator.userAgent);
}

function hide(el) {
  localStorage.setItem(KEY, '1');
  el.remove();
  document.body.classList.remove('has-install-banner');
}

export function mountInstallBanner() {
  if (!shouldShow()) return;

  const bar = h('div.installbar', { role: 'region', 'aria-label': 'Установка приложения' });
  const close = h('button.installbar-x', {
    type: 'button', text: '×', title: 'Больше не предлагать', 'aria-label': 'Больше не предлагать',
  });
  close.addEventListener('click', () => hide(bar));

  add(bar,
    h('span.installbar-t', { text: 'Будильник — только в приложении' }),
    h('a.installbar-go', { href: '/install.html', text: 'Поставить' }),
    close);

  document.body.classList.add('has-install-banner');
  document.body.append(bar);
}
