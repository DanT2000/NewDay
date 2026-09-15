/**
 * Разбор заполненного шаблона дня — без модели.
 *
 * Свободную речь разбирает помощник: «завтра в девять созвон» не описать
 * правилами. Но день целиком человек надиктовать не может, он его пишет — и
 * пишет по образцу, который приложение само и предлагает. У этого образца
 * есть заголовки и формат строки, то есть он разбирается кодом, точно и
 * мгновенно.
 *
 * Почему это важнее, чем кажется: модель на длинном размеченном тексте
 * ведёт себя хуже, а не лучше. Проверка на живом сервере показала, как
 * gpt-oss съел разделы «Питание», «Привычки» и «Заметки» целиком — из
 * двенадцати пунктов осталось восемь, и три приёма пищи с граммами
 * превратились в ничто. Там, где формат известен заранее, гадание — худший
 * из возможных способов.
 *
 * Модель остаётся на своём месте: всё, что не похоже на шаблон, уходит к
 * ней как прежде. А шаблон работает и тогда, когда помощник не подключён
 * или провайдер лежит.
 */

const { addDays } = require('./dates');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Заголовки разделов. Ключ — что это за раздел. */
const SECTIONS = [
  { key: 'schedule', re: /^распис\w*/i },
  { key: 'meals', re: /^питани\w*|^еда/i },
  { key: 'tasks', re: /^задач\w*|^дела/i },
  { key: 'habits', re: /^привыч\w*/i },
  { key: 'sport', re: /^тренировк[а-яё]*|^спорт|^зал$/i },
  { key: 'notes', re: /^заметк\w*/i },
];

/** Метки в квадратных скобках у строки расписания. */
const BLOCKS = {
  работа: 'work', рабочий: 'work', дело: 'work',
  еда: 'meal', приём: 'meal', приёмпищи: 'meal',
  спорт: 'sport', движение: 'sport', прогулка: 'sport',
  отдых: 'rest', перерыв: 'rest', сон: 'rest',
};
const SLOTS = [
  { re: /^завтрак/i, slot: 'breakfast' },
  { re: /^обед/i, slot: 'lunch' },
  { re: /^ужин/i, slot: 'dinner' },
  { re: /^перекус|^полдник/i, slot: 'snack' },
];
const BUCKETS = {
  работа: 'work', work: 'work',
  дом: 'home', быт: 'home', home: 'home',
  покупки: 'buy', купить: 'buy', buy: 'buy',
  личное: 'life', своё: 'life', life: 'life',
};
/*
 * Кириллица и `\w` — разные вещи: в JavaScript `\w` это [A-Za-z0-9_], и
 * «кажд\w*» не совпадало с «каждый». Хвост «, каждый день» оставался в
 * названии привычки, а частота молча падала в значение по умолчанию.
 */
const DAYS = [
  { re: /кажд[а-яё]*\s+день|ежедневн[а-яё]*/i, days: 'daily' },
  { re: /по\s+будн[а-яё]*|будни/i, days: 'weekdays' },
  { re: /по\s+выходн[а-яё]*|выходны[а-яё]*/i, days: 'weekend' },
];

const DASH = '[–—−-]';
const TIME = '(\\d{1,2})[:.](\\d{2})';

const pad2 = n => String(n).padStart(2, '0');
const hhmm = (h, m) => `${pad2(Number(h))}:${pad2(Number(m))}`;

/**
 * Похоже ли это на заполненный шаблон, а не на живую речь.
 *
 * Два заголовка раздела — шаблон. Один — тоже, если рядом есть строка
 * «День: …» или хотя бы три строки по формату «09:00–09:10 — …».
 *
 * Раньше требовались два раздела, и день из одного расписания — «День:
 * 2026-09-16» и восемнадцать строк под «Расписание:» — считался живой речью.
 * Он уходил к модели, та полминуты не отвечала, и человек получал «Не
 * удалось соединиться с моделью» на тексте, который разбирается кодом за
 * миллисекунду. Один заголовок и одна строка («Расписание: 09:00 подъём»)
 * по-прежнему не шаблон: так человек мог просто начать фразу.
 */
function looksLikeTemplate(text) {
  const lines = String(text || '').split('\n').map(l => l.trim());
  const timed = new RegExp(`^${TIME}(?:\\s*${DASH}\\s*${TIME})?\\s*${DASH}\\s*\\S`);
  let sections = 0;
  let dayLine = false;
  let rows = 0;
  for (const line of lines) {
    const head = line.replace(/:\s*$/, '');
    if (line.endsWith(':') && SECTIONS.some(s => s.re.test(head))) sections += 1;
    else if (/^день\s*:\s*\S/i.test(line)) dayLine = true;
    else if (timed.test(line)) rows += 1;
  }
  if (sections >= 2) return true;
  return sections === 1 && (dayLine || rows >= 3);
}

/** Дата из строки «День: …»: и «2026-09-14», и «14 сентября». */
function dateFrom(line, today) {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(line);
  if (iso) return iso[0];
  const ru = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})`, 'i').exec(line);
  if (ru) {
    const month = MONTHS.findIndex(m => m === ru[2].toLowerCase());
    const year = Number(today.slice(0, 4));
    return `${year}-${pad2(month + 1)}-${pad2(Number(ru[1]))}`;
  }
  if (/завтра/i.test(line)) return addDays(today, 1);
  if (/послезавтра/i.test(line)) return addDays(today, 2);
  return null;
}

/** Метки в скобках: [работа] [будильник] [напоминание]. */
function labelsOf(text) {
  const labels = [];
  const clean = text.replace(/\[([^\]]+)\]/g, (_, inner) => {
    labels.push(inner.trim().toLowerCase());
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
  return { clean, labels };
}

function scheduleLine(raw, date) {
  const re = new RegExp(`^${TIME}(?:\\s*${DASH}\\s*${TIME})?\\s*(?:${DASH}\\s*)?(.+)$`);
  const m = re.exec(raw);
  if (!m) return null;
  const [, h1, m1, h2, m2, tail] = m;
  const { clean, labels } = labelsOf(tail);
  if (!clean) return null;

  let block = null;
  let alarm = 'notify';
  let kind = h2 === undefined ? 'reminder' : 'schedule';
  for (const label of labels) {
    const key = label.replace(/\s+/g, '');
    if (BLOCKS[key]) block = BLOCKS[key];
    else if (/будильник|подъ[ёе]м|жёстк|жестк|хардкор/.test(label)) alarm = 'alarm';
    else if (/напоминание|точка|момент/.test(label)) kind = 'reminder';
    else if (/напомн|уведом/.test(label)) alarm = 'notify';
    else if (/без\s*сигнала|тихо|молч/.test(label)) alarm = 'off';
  }
  return {
    kind,
    title: clean,
    start: hhmm(h1, m1),
    end: kind === 'reminder' ? null : (h2 === undefined ? null : hhmm(h2, m2)),
    date,
    block,
    alarm,
  };
}

function mealLine(raw, date) {
  const slot = SLOTS.find(s => s.re.test(raw));
  if (!slot) {
    /*
     * Строка в «Питании», но не приём пищи: «Итого: примерно 1700–2150 ккал
     * без большого количества масла». Это план на день целиком — он едет в
     * план питания дня, а не пропадает молча.
     */
    return { kind: 'foodPlan', details: raw.trim(), date };
  }
  const title = raw.match(/^[^\s\d–—−-]+/)?.[0] ?? 'Приём пищи';

  const times = new RegExp(`${TIME}(?:\\s*${DASH}\\s*${TIME})?`).exec(raw);
  /*
   * Калории бывают вилкой: «~450–600 ккал». Храним верх — это потолок, в
   * который человек укладывается, и сумма верхов сходится с его же «итого».
   * Раньше брали только число перед «ккал», а «~450–» оставалось висеть в
   * составе обеда.
   */
  const kcalRe = new RegExp(`[~≈]?\\s*(\\d{3,5})(?:\\s*${DASH}\\s*(\\d{3,5}))?\\s*ккал\\.?`, 'i');
  const kcal = kcalRe.exec(raw);

  // Состав — всё после первого длинного тире; если тире нет, всё после времени
  let details = '';
  const dash = new RegExp(`\\s${DASH}\\s`).exec(raw);
  if (dash) details = raw.slice(dash.index + dash[0].length);
  else if (times) details = raw.slice(times.index + times[0].length);
  details = details.replace(kcalRe, '').trim()
    // тире, которым калории отделялись от состава, осталось без пары
    .replace(new RegExp(`(?:\\s*${DASH})+\\s*$`), '')
    .replace(/[,;]\s*$/, '')
    .trim();

  return {
    kind: 'meal',
    title: title.charAt(0).toUpperCase() + title.slice(1),
    slot: slot.slot,
    start: times ? hhmm(times[1], times[2]) : null,
    end: times && times[3] !== undefined ? hhmm(times[3], times[4]) : null,
    details,
    kcal: kcal ? Number(kcal[2] ?? kcal[1]) : null,
    date,
  };
}

/**
 * Упражнение: «Жим лёжа 4×8 60 кг», «Отжимания от стены — 3×8–12 — свой вес».
 *
 * Подходы, повторы и вес — три числа, и человек пишет их так, как привык:
 * «4х8», «4*8», «3 по 12», вилкой «3×8–12». Вес с килограммами или словами
 * «свой вес». Поля часто разделены длинным тире — тогда название то, что
 * стоит до первого тире.
 *
 * Строка без подходов и веса, но с точкой или длинная — это не упражнение, а
 * примечание к тренировке: «Отдых между подходами — 60–90 секунд. Если колени
 * начинают болеть — вставания прекращаешь». Раньше она становилась пятым
 * «упражнением» с названием в полтора предложения. Теперь уходит в заметку
 * дня — сказанное не теряется, но и в список подходов не лезет.
 */
function sportLine(raw, date) {
  const nxm = new RegExp(`(\\d{1,3})\\s*(?:[x×хХ*]|по)\\s*(\\d{1,3})(?:\\s*${DASH}\\s*(\\d{1,3}))?`).exec(raw);
  const kg = /(\d{1,3}(?:[.,]\d{1,2})?)\s*кг/i.exec(raw);
  const bodyweight = /свой\s+вес|собственн[а-яё]*\s+вес|без\s+веса/i.exec(raw);

  if (!nxm && !kg && !bodyweight) {
    const words = raw.trim().split(/\s+/).length;
    if (/[.!?]/.test(raw) || words > 6) {
      return { kind: 'note', title: 'К тренировке', details: raw.trim(), date };
    }
  }

  // «Название — 3×8–12 — вес»: название до первого тире, если в нём нет цифр подходов
  const sep = new RegExp(`\\s${DASH}\\s`).exec(raw);
  let title;
  if (sep && (nxm || kg || bodyweight) && !/\d\s*[x×хХ*]\s*\d/.test(raw.slice(0, sep.index))) {
    title = raw.slice(0, sep.index);
  } else {
    title = raw;
    if (nxm) title = title.replace(nxm[0], ' ');
    if (kg) title = title.replace(kg[0], ' ');
    if (bodyweight) title = title.replace(bodyweight[0], ' ');
    /*
     * Единица без своего числа — мусор: от «Планка 3 по 60 сек» после выемки
     * чисел оставалось «Планка сек». Срезаем только если числа действительно
     * нашлись: у «Бег 30 мин» ничего не выняли, и «мин» там при деле.
     */
    if (nxm || kg) title = title.replace(/\s*(?:сек|секунд|мин|минут|раз|повт)[а-яё]*\.?\s*$/i, '');
  }
  title = title.replace(/\s{2,}/g, ' ')
    .replace(new RegExp(`(?:\\s*${DASH})+\\s*$`), '')
    .replace(/[,;]\s*$/, '')
    .trim();
  if (!title) return null;

  const low = nxm ? Number(nxm[2]) : null;
  const high = nxm && nxm[3] !== undefined ? Number(nxm[3]) : null;
  return {
    kind: 'sport',
    title,
    sets: nxm ? Number(nxm[1]) : null,
    reps: low,
    repsMax: high !== null && high > low ? high : null,
    weight: kg ? Number(kg[1].replace(',', '.')) : null,
    date,
  };
}

function taskLine(raw, date) {
  const m = /^(?:([^:]{1,20}):\s*)?(.+)$/.exec(raw);
  if (!m) return null;
  const [, prefix, text] = m;
  const bucket = prefix ? BUCKETS[prefix.trim().toLowerCase()] : null;
  if (prefix && !bucket) {
    // Двоеточие было частью самой задачи — «Позвонить: уточнить сроки»
    return { kind: 'task', title: raw.trim(), category: 'home', date };
  }
  return { kind: 'task', title: text.trim(), category: bucket ?? 'home', date };
}

function habitLine(raw, date) {
  const found = DAYS.find(d => d.re.test(raw));
  let title = raw;
  if (found) {
    /*
     * Отрезаем хвост «, каждый день» вместе с тем, что его отделяет: запятой,
     * точкой с запятой или длинным тире. Сначала резалась только запятая, и
     * из «Не курить — каждый день» выходила привычка «Не курить —» — рядом
     * с настоящей «Не курить», то есть дубль с мусором в конце.
     *
     * Скобки вокруг образца обязательны: внутри него есть «или», и без них
     * правило читалось как «первый вариант» ИЛИ «второй и всё до конца».
     */
    title = raw.replace(new RegExp(`\\s*(?:[,;]|${DASH})?\\s*(?:${found.re.source}).*$`, 'i'), '').trim();
  }
  title = title.replace(new RegExp(`(?:\\s*${DASH})+\\s*$`), '').trim();
  if (!title) return null;
  return {
    kind: 'habit',
    title,
    days: found ? found.days : 'daily',
    // «Не курить» — привычка, которую держат отказом, а не делом
    polarity: /^не\s/i.test(title) ? 'avoid' : 'do',
    date,
  };
}

/**
 * Разбирает шаблон. `date` — день, открытый в приложении: он же по умолчанию
 * у всех пунктов, если в тексте нет строки «День: …».
 */
function parseDayTemplate(text, { date }) {
  const lines = String(text || '').split('\n');
  let day = date;
  for (const line of lines) {
    if (/^\s*день\s*:/i.test(line)) {
      day = dateFrom(line, date) ?? date;
      break;
    }
  }

  const items = [];
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^день\s*:/i.test(line)) continue;

    if (line.endsWith(':')) {
      const head = line.replace(/:\s*$/, '');
      const found = SECTIONS.find(sec => sec.re.test(head));
      if (found) { section = found.key; continue; }
    }
    if (!section) continue;

    const body = line.replace(/^[-•*—–]\s*/, '').trim();
    if (!body) continue;

    let item = null;
    if (section === 'schedule') item = scheduleLine(body, day);
    else if (section === 'meals') item = mealLine(body, day);
    else if (section === 'tasks') item = taskLine(body, day);
    else if (section === 'sport') item = sportLine(body, day);
    else if (section === 'habits') item = habitLine(body, day);
    else if (section === 'notes') {
      item = { kind: 'note', title: body.slice(0, 60), details: body, date: day };
    }
    if (item) items.push(item);
  }
  return { items, date: day };
}

module.exports = { looksLikeTemplate, parseDayTemplate };
