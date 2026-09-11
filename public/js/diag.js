/**
 * Дневник происходящего — чтобы сообщение о проблеме несло больше, чем «не
 * работает».
 *
 * Человек пользуется приложением, что-то ломается, он нажимает одну кнопку и
 * говорит своими словами. Разбираться потом придётся не ему: к его словам
 * нужны обстоятельства — какая сборка, какой экран, что отвечал сервер,
 * какие ошибки случились перед этим. Всё это собирается здесь и уходит
 * вместе с сообщением.
 *
 * Кольцо на 120 записей: этого хватает на несколько минут живой работы, а
 * больше человек всё равно не вспомнит. Записи переживают перезапуск —
 * лежат в localStorage: сбой и рассказ о нём часто разделены перезапуском,
 * и самое интересное как раз в том, что было до него.
 *
 * Чего здесь нет и не будет: содержимого дней, названий задач, текста
 * заметок. Дневник рассказывает, что приложение делало, а не что человек
 * запланировал.
 */

const MAX = 120;
const MAX_TEXT = 300;
const KEY = 'newday.diag';

const ring = [];
let saveTimer = null;

/** Время с миллисекундами: по нему видно, что за чем шло и как быстро. */
const now = () => new Date().toISOString();

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(ring.slice(-MAX))); }
    catch { /* переполнение или приватный режим — дневник просто не переживёт перезапуск */ }
  }, 400);
}

/** Записать событие. `kind` — короткое слово, по которому видно род события. */
export function note(kind, text, extra) {
  ring.push({
    t: now(),
    kind,
    text: String(text ?? '').slice(0, MAX_TEXT),
    ...(extra && Object.keys(extra).length ? { extra } : {}),
  });
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  save();
}

/** Весь дневник — для отправки. */
export const entries = () => ring.slice();

/** Забыть всё: при выходе из аккаунта чужие следы хранить нельзя. */
export function forget() {
  ring.length = 0;
  try { localStorage.removeItem(KEY); } catch { /* нечего забывать */ }
}

// ── Что цепляем сами ─────────────────────────────────────────

/*
 * Ошибки страницы, отказы обещаний и console.error. Последнее — потому что
 * приложение и само рассказывает о своих бедах через него, и эти рассказы
 * ценнее всего: они уже написаны по-человечески.
 */
let hooked = false;
export function watch() {
  if (hooked) return;
  hooked = true;

  // Прошлый запуск: читаем то, что осталось, и отделяем чертой
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved) && saved.length) ring.push(...saved.slice(-MAX));
  } catch { /* испорчено — начнём заново */ }
  note('запуск', 'приложение открыто');

  addEventListener('error', e => {
    // Ошибка загрузки картинки или скрипта приходит сюда же, но без message
    const where = e.filename ? `${e.filename.replace(/^https?:\/\/[^/]+/, '')}:${e.lineno}` : '';
    note('ошибка', e.message || `не загрузилось: ${e.target?.src || e.target?.href || '?'}`, where ? { где: where } : null);
  });

  addEventListener('unhandledrejection', e => {
    const r = e.reason;
    note('обещание', r?.message || String(r || 'отказ без причины'));
  });

  const был = console.error.bind(console);
  console.error = (...args) => {
    note('console', args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
    был(...args);
  };

  addEventListener('online', () => note('сеть', 'связь появилась'));
  addEventListener('offline', () => note('сеть', 'связь пропала'));
}

// ── Обстоятельства ───────────────────────────────────────────

/*
 * Отметка сборки лежит в service-worker.js — тем же числом помечен кеш
 * оболочки. По ней видно точно, какой код выполняется на телефоне, а это
 * первый вопрос к любому «у меня не работает»: обновилось или нет.
 */
let stamp = null;
async function buildStamp() {
  if (stamp !== null) return stamp;
  try {
    const text = await (await fetch('/service-worker.js', { cache: 'no-store' })).text();
    stamp = /const VERSION = '([^']*)'/.exec(text)?.[1] ?? 'неизвестно';
  } catch { stamp = 'не прочиталась'; }
  return stamp;
}

/**
 * Снимок обстоятельств. `extra` — то, что знает только приложение: какой
 * экран открыт, какой день выбран.
 */
export async function context(extra = {}) {
  const c = navigator.connection || {};
  return {
    сборка: await buildStamp(),
    где: globalThis.Capacitor?.isNativePlatform?.() ? `приложение (${globalThis.Capacitor.getPlatform?.()})` : 'браузер',
    сервер: (() => { try { return localStorage.getItem('newday.apiBase') || location.origin; } catch { return location.origin; } })(),
    экранТочек: `${screen.width}×${screen.height}`,
    окно: `${innerWidth}×${innerHeight}`,
    плотность: devicePixelRatio,
    связь: navigator.onLine === false ? 'нет' : (c.effectiveType || 'есть'),
    поясУстройства: Intl.DateTimeFormat().resolvedOptions().timeZone,
    часыУстройства: new Date().toString(),
    браузер: navigator.userAgent,
    язык: navigator.language,
    ...extra,
  };
}
