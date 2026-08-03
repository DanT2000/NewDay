/**
 * Обновление Android-приложения.
 *
 * Спрашиваем при запуске, но не назойливо: «Позже» откладывает вопрос до
 * следующего дня, а не до следующего запуска — иначе предложение превращается
 * в помеху, которую человек закрывает не читая. Проверить и обновиться
 * вручную можно в настройках в любой момент.
 *
 * Сравниваем versionCode, а не versionName: «1.10» как строка меньше «1.9»,
 * хотя на самом деле новее.
 */

import { h, add } from './dom.js';
import { openSheet, closeSheet } from './components/sheet.js';
import { toast } from './toast.js';
import { apiBase } from './api.js';

const KEY_POSTPONED = 'newday.update.postponedUntil';   // YYYY-MM-DD
const KEY_SKIPPED = 'newday.update.skippedCode';        // отложенная версия

const plugin = () => globalThis.Capacitor?.Plugins?.NewDayUpdate ?? null;
export const available = () => Boolean(globalThis.Capacitor?.isNativePlatform?.() && plugin());

function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function formatSize(bytes) {
  if (!bytes) return '';
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
}

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
    return body.latest || null;
  } catch {
    return null;
  }
}

/** Абсолютный адрес: нативному скачиванию относительный путь ни о чём не говорит. */
function absoluteUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  const base = apiBase().replace(/\/api\/v1$/, '');
  return base.startsWith('http') ? base + url : location.origin + url;
}

/**
 * Проверяет и, если есть что предложить, показывает вопрос.
 * @param mode 'startup' — уважает отложенное; 'manual' — спрашивает всегда
 */
export async function check(mode = 'startup') {
  if (!available()) return { state: 'not-app' };

  const [me, top] = await Promise.all([installed(), latest()]);
  if (!me) return { state: 'unknown' };
  if (!top) return { state: 'no-info', installed: me };

  if (Number(top.versionCode) <= Number(me.versionCode)) {
    return { state: 'current', installed: me, latest: top };
  }

  if (mode === 'startup') {
    const until = localStorage.getItem(KEY_POSTPONED);
    const skipped = Number(localStorage.getItem(KEY_SKIPPED) || 0);
    // Откладывали именно эту версию и день ещё не наступил — молчим.
    // Более новая версия спросит заново: её человек не откладывал.
    if (until && localDay() < until && skipped >= Number(top.versionCode)) {
      return { state: 'postponed', installed: me, latest: top };
    }
  }

  offer(me, top);
  return { state: 'offered', installed: me, latest: top };
}

function postpone(code) {
  localStorage.setItem(KEY_POSTPONED, localDay(1));
  localStorage.setItem(KEY_SKIPPED, String(code));
}

/** Окно с предложением обновиться. */
export function offer(me, top) {
  openSheet('Есть новая версия', (body, { close }) => {
    const progress = h('div.small', { style: { display: 'none' } });
    const bar = h('div.hbar', { style: { display: 'none' } }, h('i', { style: { width: '0%' } }));

    add(body, h('div.stack',
      h('p', { text: `Установлена ${me.versionName}, доступна ${top.versionName}.` }),
      top.sizeBytes ? h('p.small', { text: `Загрузка ${formatSize(top.sizeBytes)}. Данные останутся на месте.` }) : null,
      top.notes ? h('p.small', { text: top.notes.slice(0, 400) }) : null,
      bar, progress,
      h('div.row', { style: { gap: 'var(--s-2)', flexWrap: 'wrap', marginTop: 'var(--s-2)' } },
        h('button.btn.btn-primary', {
          text: 'Обновить',
          onclick: async e => {
            const btn = e.currentTarget;
            btn.disabled = true;
            bar.style.display = '';
            progress.style.display = '';
            progress.textContent = 'Скачиваю…';
            const ok = await install(top, p => {
              bar.firstChild.style.width = p + '%';
              progress.textContent = `Скачиваю… ${p}%`;
            });
            if (ok) {
              progress.textContent = 'Скачано. Подтвердите установку в системном окне.';
            } else {
              btn.disabled = false;
              bar.style.display = 'none';
            }
          },
        }),
        h('button.btn', {
          text: 'Позже',
          onclick: () => { postpone(top.versionCode); close(); toast('Напомню завтра'); },
        }))));
  });
}

/**
 * Скачивает и передаёт установщику. Возвращает true, если дошло до установщика.
 * Разрешение на установку спрашиваем ровно тогда, когда оно понадобилось.
 */
export async function install(top, onProgress = null) {
  if (!available()) return false;
  let listener = null;
  try {
    if (onProgress) {
      listener = await plugin().addListener('updateProgress', e => onProgress(e.percent ?? 0));
    }
    await plugin().downloadAndInstall({
      url: absoluteUrl(top.apkUrl),
      versionName: top.versionName,
    });
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('NO_INSTALL_PERMISSION')) {
      askInstallPermission();
    } else {
      toast(msg || 'Не удалось скачать обновление', 'error');
    }
    return false;
  } finally {
    listener?.remove?.();
  }
}

function askInstallPermission() {
  closeSheet();
  openSheet('Нужно разрешение', body => {
    add(body, h('div.stack',
      h('p.small', { text: 'Android не даёт приложению установить обновление, пока вы это не разрешите. '
        + 'Разрешение касается только NewDay и отзывается там же.' }),
      h('button.btn.btn-primary', {
        text: 'Открыть настройки',
        onclick: () => plugin()?.openInstallSettings?.(),
      })));
  });
}
