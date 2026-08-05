/**
 * Данные для веб-версии: пока примерные, как в эталоне.
 *
 * Это не заглушки «Заголовок 1» — это то, как выглядит настоящий день:
 * названия из двух-десяти слов, время с длительностями, вложенный блок
 * внутри рабочего, перенесённая задача, привычка с выходным по графику.
 * На пустых и однословных примерах вёрстка врёт: длинное название не
 * переносится, а короткое не показывает, что будет с длинным.
 *
 * Когда экран подключат к серверу, эти списки заменятся ответами API —
 * форма полей нарочно близка к тому, что отдаёт сервер.
 */

export const DARK = {
  '--bg': '#161826', '--surface': '#232532', '--raise': '#2e3040',
  '--text': '#e9e9ed', '--dim': '#9ba0b5', '--faint': '#7b8092',
  '--line': 'rgba(233,233,237,0.10)',
};

export const LIGHT = {
  '--bg': '#f3f5fe', '--surface': '#ffffff', '--raise': '#e8ebf8',
  '--text': '#232530', '--dim': '#565b6e', '--faint': '#767b8d',
  '--line': 'rgba(41,43,49,0.12)',
};

export const PALETTE = {
  violet: { label: 'Сиреневый', dark: '#9d8cf0', light: '#6a54e8' },
  orange: { label: 'Оранжевый', dark: '#ff9330', light: '#f07d12' },
  green: { label: 'Зелёный', dark: '#3fd0b0', light: '#0fa88c' },
  red: { label: 'Красный', dark: '#ff6a5e', light: '#e83a30' },
};

/** Четыре степени напоминания — от тишины до будильника. */
export const ALARM = [
  { k: 'off', label: 'Без напоминания', icon: 'bell-slash' },
  { k: 'notify', label: 'Уведомление', icon: 'bell' },
  { k: 'sound', label: 'Со звуком', icon: 'bell-ringing' },
  { k: 'alarm', label: 'Будильник', icon: 'alarm-fill' },
];

export const LEADS = [
  { k: 'at', label: 'вовремя' }, { k: '5', label: 'за 5 мин' }, { k: '15', label: 'за 15 мин' },
  { k: '30', label: 'за 30 мин' }, { k: '60', label: 'за час' }, { k: 'day', label: 'за день' },
];

/**
 * День: минуты от полуночи. `s6b` нарочно лежит внутри `s6` — так видно,
 * как рисуется вложенный блок и в списке, и в сетке недели.
 */
export const SCHEDULE = [
  { id: 's1', start: 400, end: 430, title: 'Подъём и стакан воды', past: true, alarm: 'alarm', leads: ['at'] },
  { id: 's2', start: 430, end: 470, title: 'Зарядка и душ', past: true },
  { id: 's3', start: 490, end: 540, title: 'Дорога до офиса', past: true },
  { id: 's4', start: 540, end: 750, title: 'Работа: первый блок', now: true, alarm: 'notify', leads: ['15'] },
  { id: 's5', start: 780, end: 810, title: 'Обед', alarm: 'sound', leads: ['15'], fromFood: true },
  { id: 's6', start: 810, end: 1020, title: 'Работа: второй блок' },
  { id: 's6b', start: 840, end: 885, title: 'Созвон с подрядчиком по смете', alarm: 'sound', leads: ['15'] },
  { id: 's7', start: 1080, end: 1140, title: 'Зал: спина и руки', alarm: 'sound', leads: ['30', 'day'] },
  { id: 's8', start: 1170, end: 1230, title: 'Ужин и дела по дому', fromFood: true },
  { id: 's9', start: 1350, end: null, title: 'Отбой', alarm: 'notify', leads: ['at'] },
];

export const CATS = [
  { k: 'work', label: 'Работа' }, { k: 'home', label: 'Дом' },
  { k: 'life', label: 'Личное' }, { k: 'buy', label: 'Покупки' },
];

export const TASKS = [
  { id: 't1', title: 'Закрыть отчёт за июль', done: true, cat: 'work' },
  { id: 't2', title: 'Ревью макетов нового расписания', done: false, cat: 'work' },
  { id: 't3', title: 'Согласовать смету с подрядчиком', done: false, cat: 'work' },
  { id: 't4', title: 'Оплатить интернет и свет', done: true, cat: 'home' },
  { id: 't5', title: 'Забрать посылку из пункта выдачи', done: false, cat: 'home', meta: '↩ с 3 авг' },
  { id: 't6', title: 'Записаться к стоматологу', done: false, cat: 'life' },
  { id: 't7', title: 'Купить корм, кофе и молоко', done: false, cat: 'buy' },
];

export const MEALS = [
  { id: 'm1', title: 'Завтрак — овсянка и кофе', kcal: 320, done: true, meta: 'без времени' },
  { id: 'm2', title: 'Обед — курица, рис, овощи', kcal: 640, alarm: 'notify', meta: 'окно 12:00–14:00 · напоминание вовремя' },
  { id: 'm3', title: 'Ужин — рыба и салат', kcal: 430, alarm: 'sound', meta: '19:30 · 30 мин · в расписании' },
  { id: 'm4', title: 'Творог с ягодами', kcal: 180, meta: 'без времени' },
];

export const HABITS = [
  {
    id: 'hb1', emoji: '💧', title: 'Вода — 2 литра', done: true, active: true,
    meta: 'подряд 12 дней · лучшая серия 24',
    week: ['done', 'done', 'done', 'miss', 'done', 'done', 'done'],
  },
  {
    id: 'hb2', emoji: '🚫', title: 'Без сахара', done: false, active: true,
    meta: 'челлендж 46 из 300 дней',
    week: ['done', 'done', 'miss', 'done', 'done', 'miss', 'none'],
  },
  {
    id: 'hb3', emoji: '📖', title: 'Чтение 20 минут перед сном', done: false, active: true,
    meta: 'челлендж 18 из 30 дней',
    week: ['done', 'done', 'done', 'done', 'skip', 'done', 'none'],
  },
  {
    id: 'hb4', emoji: '🗣', title: 'Английский', done: false, active: false,
    meta: 'сегодня по графику выходной',
    week: ['off', 'done', 'off', 'done', 'off', 'done', 'off'],
  },
];

export const REMINDERS = [
  { id: 'r1', title: 'День рождения Ани', meta: 'Ежегодно · 5 августа · за день', icon: 'cake' },
  { id: 'r2', title: 'Забрать документы из МФЦ', meta: 'Разово · 5 августа · за час', icon: 'bell' },
  { id: 'r3', title: 'Продлить подписку на хостинг', meta: 'Ежемесячно · 7 августа · вовремя', icon: 'bell' },
];

export const NOTES = [
  { id: 'n1', title: 'Сервис ноутбука', date: '5 авг', on: true, text: 'Позвонить в сервис, спросить про сроки и стоимость замены аккумулятора.' },
  { id: 'n2', title: 'Сборы в поездку', date: '5 авг', on: true, text: 'Зарядка, кроссовки, документы, наушники. Собрать сумку с вечера.' },
  { id: 'n3', title: 'Идеи на ремонт', date: 'без даты', on: false, text: 'Полка над столом, лампа тёплого света, крючки в коридоре.' },
  { id: 'n4', title: 'Книги на осень', date: 'без даты', on: false, text: 'Список того, что хочется прочитать без привязки к дню.' },
  { id: 'n5', title: 'Разговор с подрядчиком', date: '6 авг', on: true, text: 'Уточнить сроки по смете, спросить про материалы и гарантию.' },
];

export const NAV = [
  { key: 'today', label: 'Сейчас', icon: 'sun-horizon', badge: '' },
  { key: 'plan', label: 'Расписание', icon: 'calendar-blank', badge: '' },
  { key: 'habits', label: 'Привычки', icon: 'check-circle', badge: '2/3' },
  { key: 'notes', label: 'Заметки', icon: 'note', badge: '5' },
  { key: 'settings', label: 'Настройки', icon: 'gear', badge: '' },
];

export const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
export const MONTHS_NOM = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
export const DOW_LONG = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const DOW_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export const AI_SAMPLE = 'Завтра подъём в семь, в два созвон с подрядчиком на час, '
  + 'вечером зал, купить корм и продлить подписку в пятницу';

/** Что помощник «разобрал» — пока фиксированный пример под AI_SAMPLE. */
export const AI_PLAN = [
  { id: 'p1', title: 'Подъём', meta: '07:00 · будильник', tag: 'расписание' },
  { id: 'p2', title: 'Созвон с подрядчиком', meta: '14:00–15:00 · за 15 мин', tag: 'расписание' },
  { id: 'p3', title: 'Зал', meta: '18:00 · 1 ч', tag: 'расписание' },
  { id: 'p4', title: 'Купить корм', meta: 'категория «Покупки»', tag: 'дела' },
  { id: 'p5', title: 'Продлить подписку', meta: '7 августа · вовремя', tag: 'напоминание' },
];

/** Наборы дел для клеток месяца — чтобы месяц не выглядел пустым. */
export const MONTH_SETS = [
  ['07:00 Подъём', '09:00 Работа: первый блок', '18:00 Зал'],
  ['07:00 Подъём', '10:00 Планёрка с командой по редизайну', '14:00 Созвон с подрядчиком'],
  ['08:30 Дорога до офиса', '09:00 Работа', '19:30 Ужин и дела по дому'],
  ['09:00 Работа', '12:30 Обед', '20:00 Чтение перед сном'],
  ['10:00 Прогулка в парке'],
];

export const SOUNDS = [
  { k: 'Рассвет', hint: 'мягкое нарастание' },
  { k: 'Колокол', hint: 'громко и сразу' },
  { k: 'Капля', hint: 'короткий сигнал' },
  { k: 'Птицы', hint: 'живой звук' },
  { k: 'Случайный', hint: 'меняет звуки каждые 5 секунд во время звонка' },
];

export const DEVICES = [
  { icon: 'device-mobile', name: 'Pixel 7a', seen: 'сейчас в сети', tag: 'телефон' },
  { icon: 'browser', name: 'Chrome · Windows', seen: 'это устройство', tag: 'браузер' },
];

export const REPEATS = ['Разово', 'Ежедневно', 'Еженедельно', 'Ежемесячно', 'Ежегодно'];
export const PRINT_PARTS = ['Расписание', 'Задачи', 'Спорт', 'Питание', 'Напоминания', 'Заметки'];
export const HABIT_EMOJI = ['💧', '📖', '🏃', '🧘', '🚫', '🍎'];
