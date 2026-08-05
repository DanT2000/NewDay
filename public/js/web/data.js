/**
 * Словари веб-версии: палитра, степени напоминания, разделы, подписи.
 *
 * Здесь только то, что не приходит с сервера и не меняется от человека:
 * названия месяцев, четыре цвета оформления, четыре степени сигнала.
 * Дела, расписание, привычки и заметки читаются через `store.js`.
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

export const CATS = [
  { k: 'work', label: 'Работа' }, { k: 'home', label: 'Дом' },
  { k: 'life', label: 'Личное' }, { k: 'buy', label: 'Покупки' },
];

export const NAV = [
  { key: 'today', label: 'Сейчас', icon: 'sun-horizon', badge: '' },
  { key: 'plan', label: 'Расписание', icon: 'calendar-blank', badge: '' },
  { key: 'habits', label: 'Привычки', icon: 'check-circle', badge: '2/3' },
  { key: 'notes', label: 'Заметки', icon: 'note', badge: '' },
  { key: 'settings', label: 'Настройки', icon: 'gear', badge: '' },
];
/** Родительный падеж: «5 августа», а не «5 август». */
export const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
export const DOW_LONG = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const DOW_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export const SOUNDS = [
  { k: 'Рассвет', hint: 'мягкое нарастание' },
  { k: 'Колокол', hint: 'громко и сразу' },
  { k: 'Капля', hint: 'короткий сигнал' },
  { k: 'Птицы', hint: 'живой звук' },
  { k: 'Случайный', hint: 'меняет звуки каждые 5 секунд во время звонка' },
];

export const REPEATS = ['Разово', 'Ежедневно', 'Еженедельно', 'Ежемесячно', 'Ежегодно'];
export const PRINT_PARTS = ['Расписание', 'Задачи', 'Спорт', 'Питание', 'Напоминания', 'Заметки'];
export const HABIT_EMOJI = ['💧', '📖', '🏃', '🧘', '🚫', '🍎'];
