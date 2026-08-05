/**
 * Лист на печать.
 *
 * Собирается отдельной разметкой, а не «спрячем лишнее из экрана». На
 * бумаге другие правила: нет тёмного фона, нет наведения, нет прокрутки,
 * и колонка в 236 пикселей слева не нужна вовсе. Проще собрать лист
 * заново, чем отменять десяток экранных правил.
 *
 * Готовый лист кладётся в конец страницы, вызывается печать браузера и
 * лист убирается. Оттуда же сохраняется в PDF — своего генератора PDF
 * не нужно.
 */

import { h, add } from '../dom.js';
import * as adapt from './adapt.js';

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const DOW = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function longDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${d} ${MONTHS[m - 1]} ${y}, ${DOW[dt.getDay()]}`;
}

/** Пустой квадрат под галочку: лист печатают, чтобы отмечать ручкой. */
const tick = () => h('span.psq');

function section(title, rows) {
  if (!rows.length) return null;
  const box = h('section.pbox', h('h2', { text: title }));
  add(box, ...rows);
  return box;
}

/**
 * @param day     полный день с сервера
 * @param parts   какие разделы печатать
 * @param scope   'day' | 'week' | 'month' — что написать в подзаголовке
 * @param range   выборка за период для недели и месяца
 */
export function buildSheet(day, { parts, scope = 'day', range = null } = {}) {
  const sheet = h('div.psheet');
  const want = k => parts.includes(k);

  add(sheet, h('header.phead',
    h('h1', { text: longDate(day.date) }),
    h('span', { text: scope === 'day' ? 'план дня' : scope === 'week' ? 'план недели' : 'план месяца' })));

  if (want('Расписание')) {
    const rows = (day.schedule ?? []).map(r => h('div.prow',
      tick(),
      h('span.ptime', { text: r.end_min === null ? adapt.hhmm(r.start_min) : `${adapt.hhmm(r.start_min)}–${adapt.hhmm(r.end_min)}` }),
      h('span.ptext', { text: r.title })));
    add(sheet, section('Расписание', rows));
  }

  if (want('Задачи')) {
    const rows = [];
    for (const [bucket, list] of Object.entries(day.tasks ?? {})) {
      for (const t of list) {
        rows.push(h('div.prow', tick(),
          h('span.ptext', { text: t.text }),
          h('span.pmeta', { text: bucket === 'work' ? 'работа' : 'дом' })));
      }
    }
    add(sheet, section('Задачи', rows));
  }

  if (want('Питание')) {
    const rows = (day.meals ?? []).map(m => h('div.prow',
      tick(),
      h('span.ptext', { text: m.title }),
      h('span.pmeta', { text: m.calories ? `${m.calories} ккал` : '' })));
    add(sheet, section('Питание', rows));
  }

  if (want('Спорт')) {
    const rows = (day.sport ?? []).map(x => h('div.prow',
      tick(),
      h('span.ptext', { text: x.exercise }),
      h('span.pmeta', {
        text: [x.sets && `${x.sets} подх.`, x.reps && `${x.reps} повт.`, x.weight && `${x.weight} кг`]
          .filter(Boolean).join(' · '),
      })));
    add(sheet, section('Спорт', rows));
  }

  if (want('Напоминания')) {
    const rows = (day.schedule ?? [])
      .filter(r => r.end_min === null && r.alarm_mode !== 'none')
      .map(r => h('div.prow', tick(),
        h('span.ptime', { text: adapt.hhmm(r.start_min) }),
        h('span.ptext', { text: r.title })));
    add(sheet, section('Напоминания', rows));
  }

  if (want('Заметки')) {
    const text = String(day.notes || '').trim();
    add(sheet, section('Заметки', text
      ? [h('p.pnote', { text })]
      // Пустых строк ровно столько, чтобы было куда писать, и не столько,
      // чтобы лист ушёл на второй
      : Array.from({ length: 6 }, () => h('div.pline'))));
  }

  // Неделя и месяц: следом идут остальные дни только с расписанием —
  // иначе лист превращается в брошюру
  if (scope !== 'day' && range) {
    for (const d of range.days) {
      if (d.date === day.date || !d.schedule.length) continue;
      const rows = d.schedule.map(r => h('div.prow',
        tick(),
        h('span.ptime', { text: adapt.hhmm(r.start_min) }),
        h('span.ptext', { text: r.title })));
      add(sheet, section(longDate(d.date), rows));
    }
  }

  return sheet;
}

/** Собрать, напечатать, убрать. */
export function printSheet(day, options) {
  const sheet = buildSheet(day, options);
  document.body.append(sheet);
  const cleanup = () => { sheet.remove(); removeEventListener('afterprint', cleanup); };
  addEventListener('afterprint', cleanup);
  print();
  // Safari и часть браузеров не шлют afterprint — убираем и по таймеру
  setTimeout(cleanup, 2000);
}
