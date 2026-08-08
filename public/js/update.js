/**
 * Версия приложения и сообщение о новой.
 *
 * Приложение не обновляет себя — обновляет магазин, откуда его поставили.
 * Раньше здесь было полноценное самообновление: проверка, скачивание APK с
 * сайта и передача его системному установщику. Для этого приложению требовалось
 * REQUEST_INSTALL_PACKAGES — самое подозрительное разрешение из всех, — и каждый
 * магазин требовал обосновывать его отдельно. Google Play такие обновления
 * запрещает прямо, RuStore обновляет сам, а людей, которые ставили APK с сайта,
 * не появилось. Механизм убран целиком, вместе с разрешением.
 *
 * Что осталось: узнать установленную версию и, если на сервере лежит новее,
 * сказать об этом словами. Обновляется человек в магазине.
 *
 * Сравниваем versionCode, а не versionName: «1.10» как строка меньше «1.9»,
 * хотя на самом деле новее.
 */

import { h, add } from './dom.js';
import { openSheet } from './components/sheet.js';
import { apiBase } from './api.js';

const plugin = () => globalThis.Capacitor?.Plugins?.NewDayUpdate ?? null;
export const available = () => Boolean(globalThis.Capacitor?.isNativePlatform?.() && plugin());

/** Что установлено сейчас. В браузере версии приложения нет. */
export async function installed() {
  if (!available()) return null;
  try { return await plugin().getInfo(); } catch { return null; }
}

/** Что лежит на сервере. Ошибку не поднимаем: это фоновая проверка. */
export async function latest() {
  try {
    const res = await fetch(apiBase() + '/app/version', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.latest ?? null;
  } catch {
    return null;
  }
}

/**
 * Проверка при запуске.
 *
 * Ничего не спрашивает и ничего не показывает: обновление приходит из магазина
 * само, и предложение «обновиться» при запуске было бы помехой без действия.
 * Функция оставлена, потому что её зовут экраны запуска, и возвращает состояние
 * — по нему видно, что проверять нечего.
 */
export async function check() {
  if (!available()) return { state: 'not-app' };
  const me = await installed();
  return me ? { state: 'store-managed', installed: me } : { state: 'unknown' };
}

/**
 * Сказать, что вышла новая версия. Зовут вручную из настроек.
 *
 * Кнопки «Обновить» здесь нет намеренно: устанавливать приложение само не
 * умеет, а кнопка, ведущая в отказ, хуже отсутствующей.
 */
export function offer(me, top) {
  openSheet('Есть новая версия', (body, { close }) => {
    add(body, h('div.stack',
      h('p', { text: `Установлена ${me.versionName}, доступна ${top.versionName}.` }),
      top.notes ? h('p.small', { text: top.notes.slice(0, 400) }) : null,
      h('p.small', {
        text: 'Обновите приложение в магазине, откуда его установили — RuStore '
            + 'или Google Play. Данные останутся на месте: они на сервере.',
      }),
      h('div.row', { style: { gap: 'var(--s-2)', flexWrap: 'wrap', marginTop: 'var(--s-2)' } },
        h('button.btn.btn-primary', { text: 'Понятно', onclick: () => close() }))));
  });
}
