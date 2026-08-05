/**
 * Помощник: сказал словами — получил день.
 *
 * Три состояния и переходы между ними:
 *
 *   ввод → (уточняющий вопрос → ответ кнопкой) → разбор → добавление
 *
 * Уточняющий вопрос не диалог с чат-ботом, а одна развилка с готовыми
 * ответами. Модель спрашивает только тогда, когда без ответа дело нельзя
 * поставить в день («вечером» — это во сколько), и прикладывает варианты.
 * Свой ответ тоже можно написать.
 *
 * Разобранное показывается списком с галочками до того, как что-то будет
 * записано. Помощник, который сразу правит день, страшно нажимать: человек
 * не знает, что получит, и не может отменить.
 */

import { h, add, replace } from './dom.js';
import { icon } from './vendor/icons.js';
import { openSheet } from './components/sheet.js';
import { toast } from './toast.js';
import * as api from './api.js';
import { state, reloadDay, today } from './store.js';
import { formatShort, formatMinutes } from './dates.js';

/** Что помощник умеет прямо сейчас. Кэшируем: статус меняется редко. */
let cached = null;

export async function aiStatus() {
  if (cached) return cached;
  try { cached = await api.GET('/ai/status'); } catch { cached = { ready: false, voice: false }; }
  return cached;
}

// ── Как разобранное ложится в день ───────────────────────────

/**
 * Модель различает четыре степени: без напоминания, уведомление, со звуком
 * и будильник. У расписания их три, зато есть профиль звонка. «Со звуком» —
 * это будильник помягче, поэтому он и раскладывается так.
 */
const ALARM = {
  off:    { alarmMode: 'none',   alarmProfile: 'gentle' },
  notify: { alarmMode: 'notify', alarmProfile: 'gentle' },
  sound:  { alarmMode: 'alarm',  alarmProfile: 'gentle' },
  alarm:  { alarmMode: 'alarm',  alarmProfile: 'wakeup' },
};

/** Покупки и личное живут в «доме»: отдельных разделов у задач два. */
const BUCKET = { work: 'work', home: 'home', buy: 'home', life: 'home' };

const CAT_LABEL = { work: 'работа', home: 'дом', buy: 'покупки', life: 'личное' };

const toMin = t => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : null;
};

/**
 * Куда пойдёт пункт. Решаем здесь, а не в модели: она разбирает речь, а как
 * это устроено в приложении — не её дело.
 */
function place(item) {
  const start = toMin(item.start);
  const end = toMin(item.end);
  const kind = item.kind === 'reminder' && start === null ? 'task' : item.kind;

  if (kind === 'schedule' || kind === 'reminder') {
    return {
      where: 'schedule',
      // Напоминание не занимает время — только момент
      body: {
        title: item.title,
        startMin: start ?? 0,
        endMin: kind === 'reminder' ? null : end,
        ...(ALARM[item.alarm] ?? ALARM.notify),
      },
      tag: kind === 'reminder' ? 'напоминание' : 'расписание',
      meta: start === null ? 'без времени' : formatMinutes(start) + (end ? `–${formatMinutes(end)}` : ''),
    };
  }
  return {
    where: 'tasks',
    body: { text: item.title, bucket: BUCKET[item.category] ?? 'work' },
    tag: 'дело',
    meta: CAT_LABEL[item.category] ?? 'работа',
  };
}

const dateOf = item => (/^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ? item.date : (state.date || today()));

// ── Экран помощника ──────────────────────────────────────────

export async function openAssistant(prefill = '') {
  const status = await aiStatus();
  if (!status.ready) {
    toast('Помощник не подключён. Владелец задаёт подключение в настройках', 'error');
    return;
  }

  openSheet('Помощник', (body, { close }) => {
    body.classList.add('ai-body');
    // Разобранное встаёт в две колонки — узкой модалки для него мало
    body.closest('.modal')?.classList.add('is-wide');

    // Состояние живёт здесь, а не в модуле: закрыли окно — забыли разговор
    const talk = { text: prefill, history: [], items: null, off: new Set(), busy: false, question: null, options: [] };

    const draw = () => replace(body, ...screenFor(talk, draw, close));
    draw();
  });
}

function screenFor(talk, draw, close) {
  if (talk.items) return planScreen(talk, draw, close);
  if (talk.question) return questionScreen(talk, draw);
  return inputScreen(talk, draw);
}

// ── 1. Ввод ──────────────────────────────────────────────────

function inputScreen(talk, draw) {
  const area = h('textarea.ai-input', {
    value: talk.text,
    placeholder: 'Завтра подъём в семь, в два созвон с подрядчиком на час, вечером зал, купить корм…',
    rows: 4,
    oninput: e => { talk.text = e.target.value; },
    // Отправка с клавиатуры: тянуться мышью к кнопке после набора текста лишнее
    onkeydown: e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(talk, draw); }
    },
  });

  const hint = h('div.ai-hint');
  const parseBtn = h('button.btn-sheet', {
    text: talk.busy ? 'Разбираю…' : 'Разобрать',
    disabled: talk.busy,
    onclick: () => send(talk, draw),
  });

  return [
    h('p.ai-lead', { text: 'Опишите день словами или продиктуйте — разложу по расписанию, делам и напоминаниям.' }),
    h('div.ai-row', area, micButton(talk, draw, hint)),
    hint,
    talk.error ? h('div.ai-error', { text: talk.error }) : null,
    parseBtn,
  ];
}

/**
 * Микрофон. Пишем через MediaRecorder и отправляем на распознавание.
 * Кнопка сама себе индикатор: пока идёт запись, она красная и пульсирует —
 * иначе непонятно, слушает приложение или нет.
 */
function micButton(talk, draw, hint) {
  const btn = h('button.ai-mic', {
    type: 'button',
    title: 'Продиктовать',
    'aria-label': 'Продиктовать',
  });
  add(btn, icon('microphone-fill', { size: '19px' }));

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    btn.disabled = true;
    btn.title = 'Этот браузер не умеет записывать звук';
    return btn;
  }

  let rec = null;
  let chunks = [];

  const stop = () => {
    if (rec && rec.state !== 'inactive') rec.stop();
  };

  btn.onclick = async () => {
    if (rec) { stop(); return; }
    const voice = (await aiStatus()).voice;
    if (!voice) { hint.textContent = 'Распознавание речи не подключено'; return; }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      hint.textContent = 'Не дали доступ к микрофону';
      return;
    }

    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      // Дорожку надо закрыть руками, иначе в браузере останется гореть
      // значок записи, хотя мы уже не слушаем
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('is-rec');
      rec = null;

      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      if (blob.size < 1200) { hint.textContent = 'Слишком коротко — попробуйте ещё раз'; return; }

      hint.textContent = 'Распознаю…';
      try {
        const form = new FormData();
        form.append('file', blob, 'zapis.webm');
        form.append('language', 'ru');
        const r = await api.postForm('/ai/transcribe', form);
        const area = hint.parentElement?.querySelector('.ai-input');
        talk.text = talk.text ? `${talk.text} ${r.text}` : r.text;
        if (area) { area.value = talk.text; area.focus(); }
        hint.textContent = '';
      } catch (e) {
        hint.textContent = e.message || 'Не получилось распознать';
      }
    };

    rec.start();
    btn.classList.add('is-rec');
    hint.textContent = 'Говорите. Нажмите ещё раз, когда закончите.';
  };

  return btn;
}

async function send(talk, draw, extraAnswer = null) {
  const text = talk.text.trim();
  if (!text) { talk.error = 'Сначала скажите, что нужно сделать'; draw(); return; }

  if (extraAnswer !== null) {
    talk.history = [
      ...talk.history,
      { role: 'assistant', content: JSON.stringify({ question: talk.question, options: talk.options }) },
      { role: 'user', content: extraAnswer },
    ];
  }

  talk.busy = true; talk.error = null; talk.question = null;
  draw();

  try {
    const r = await api.POST('/ai/parse', {
      text,
      date: state.date || today(),
      history: talk.history,
    });
    talk.busy = false;

    if (r.question) {
      talk.question = r.question;
      talk.options = r.options ?? [];
      // Уже разобранное придержим: после ответа модель вернёт всё вместе
      draw();
      return;
    }
    if (!r.items?.length) {
      talk.error = r.unparsed
        ? `Не понял: ${r.unparsed.slice(0, 160)}`
        : 'Ничего не нашлось. Скажите иначе или подробнее.';
      draw();
      return;
    }
    talk.items = r.items;
    talk.off = new Set();
    draw();
  } catch (e) {
    talk.busy = false;
    talk.error = e.message || 'Помощник не ответил';
    draw();
  }
}

// ── 2. Уточняющий вопрос ─────────────────────────────────────

function questionScreen(talk, draw) {
  const own = h('input.input', {
    placeholder: 'или свой ответ',
    onkeydown: e => {
      if (e.key === 'Enter' && e.target.value.trim()) send(talk, draw, e.target.value.trim());
    },
  });

  const chips = h('div.ai-options');
  add(chips, ...talk.options.map(o => h('button.ai-chip', {
    type: 'button', text: o,
    onclick: () => send(talk, draw, o),
  })));

  return [
    h('div.ai-bubble',
      h('span.ai-avatar', icon('sparkle-fill', { size: '16px' })),
      h('div.ai-said', { text: talk.question })),
    talk.options.length ? chips : null,
    own,
    h('button.btn', {
      type: 'button', text: 'Назад к тексту',
      onclick: () => { talk.question = null; draw(); },
    }),
  ];
}

// ── 3. Что будет добавлено ───────────────────────────────────

function planScreen(talk, draw, close) {
  const rows = talk.items.map((item, i) => {
    const p = place(item);
    const on = !talk.off.has(i);
    const row = h('button.ai-plan', {
      type: 'button',
      class: on ? '' : 'is-off',
      onclick: () => { on ? talk.off.add(i) : talk.off.delete(i); draw(); },
    });
    add(row,
      h('span.ai-box', { class: on ? 'is-on' : '' }, icon('check-bold', { size: '13px' })),
      h('div.ai-plan-body',
        h('div.ai-plan-title', { text: item.title || 'Без названия' }),
        h('div.ai-plan-meta', { text: `${p.meta} · ${dayLabel(item)}` })),
      h('span.ai-tag', { text: p.tag }));
    return row;
  });

  const chosen = talk.items.filter((_, i) => !talk.off.has(i));

  return [
    h('div.ai-bubble',
      h('span.ai-avatar', icon('sparkle-fill', { size: '16px' })),
      h('div.ai-said', { text: 'Вот что добавлю. Снимите галочку, если что-то лишнее.' })),
    h('div.ai-plans', ...rows),
    talk.error ? h('div.ai-error', { text: talk.error }) : null,
    h('div.ai-actions',
      h('button.btn', {
        type: 'button', text: 'Исправить',
        onclick: () => { talk.items = null; talk.error = null; draw(); },
      }),
      h('button.btn-sheet', {
        text: talk.busy ? 'Добавляю…' : addLabel(chosen.length),
        disabled: talk.busy || !chosen.length,
        onclick: () => apply(talk, draw, close),
      })),
  ];
}

function dayLabel(item) {
  const d = dateOf(item);
  return d === today() ? 'сегодня' : formatShort(d);
}

const addLabel = n => {
  const word = n % 10 === 1 && n % 100 !== 11 ? 'дело'
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дела' : 'дел';
  return `Добавить ${n} ${word}`;
};

/**
 * Записываем. По одному запросу на пункт — их единицы, а пакетного
 * эндпоинта нет; зато при обрыве связи посреди списка часть уже добавлена,
 * и человеку об этом честно сообщается.
 */
async function apply(talk, draw, close) {
  talk.busy = true; talk.error = null; draw();

  const chosen = talk.items.filter((_, i) => !talk.off.has(i));
  let ok = 0;
  const touched = new Set();

  for (const item of chosen) {
    const p = place(item);
    const date = dateOf(item);
    try {
      await api[p.where].create(date, p.body);
      touched.add(date);
      ok += 1;
    } catch (e) {
      talk.busy = false;
      talk.error = ok
        ? `Добавлено ${ok} из ${chosen.length}, дальше не вышло: ${e.message}`
        : `Не получилось добавить: ${e.message}`;
      draw();
      return;
    }
  }

  close();
  toast(ok === chosen.length ? `Добавлено: ${ok}` : `Добавлено ${ok} из ${chosen.length}`);

  // Обновляем день, только если тронули именно тот, что открыт
  if (touched.has(state.date)) { try { await reloadDay(); } catch { /* страница сама перечитает */ } }
  else if (touched.size === 1) {
    const [d] = [...touched];
    toast(`Записано на ${formatShort(d)}`);
  }
}
