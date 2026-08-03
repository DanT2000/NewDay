const { badRequest } = require('./errors');
const { isValidDate } = require('./dates');

function str(v, { max = 500, field = 'значение', trim = true, fallback = '' } = {}) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw badRequest(`Поле «${field}» должно быть строкой`);
  const s = trim ? v.trim() : v;
  if (s.length > max) throw badRequest(`Поле «${field}» длиннее ${max} символов`);
  return s;
}

function int(v, { min = -1e9, max = 1e9, field = 'значение', nullable = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (nullable) return null;
    throw badRequest(`Поле «${field}» обязательно`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`Поле «${field}» должно быть целым числом от ${min} до ${max}`);
  }
  return n;
}

function num(v, { min = -1e9, max = 1e9, field = 'значение', nullable = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (nullable) return null;
    throw badRequest(`Поле «${field}» обязательно`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`Поле «${field}» должно быть числом от ${min} до ${max}`);
  }
  return n;
}

const bool = v => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;

function oneOf(v, allowed, { field = 'значение', fallback } = {}) {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`Поле «${field}» обязательно`);
  }
  if (!allowed.includes(v)) {
    throw badRequest(`Поле «${field}»: допустимые значения — ${allowed.join(', ')}`);
  }
  return v;
}

function date(v, { field = 'дата' } = {}) {
  if (!isValidDate(v)) throw badRequest(`Поле «${field}»: ожидается формат YYYY-MM-DD`);
  return v;
}

function email(v, { field = 'почта' } = {}) {
  const s = str(v, { max: 254, field }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw badRequest('Некорректный адрес почты');
  return s;
}

function password(v) {
  if (typeof v !== 'string') throw badRequest('Пароль обязателен');
  if (v.length < 8) throw badRequest('Пароль: не менее 8 символов');
  if (v.length > 200) throw badRequest('Пароль слишком длинный');
  return v;
}

module.exports = { str, int, num, bool, oneOf, date, email, password };
