const crypto = require('node:crypto');

const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

/** В базе лежит только sha256-хеш. Сам токен показывается один раз и не восстановим. */
function generateSecret(bytes = 32) {
  const secret = crypto.randomBytes(bytes).toString('hex');
  const prefix = crypto.randomBytes(4).toString('hex'); // 8 символов, ищем по нему в индексе
  return { secret, prefix, hash: hashToken(secret) };
}

/** Полный токен вида nd_<prefix>_<secret> или ndd_<prefix>_<secret>. */
function formatToken(kind, prefix, secret) {
  return `${kind}_${prefix}_${secret}`;
}

function parseToken(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(nd|ndd)_([a-f0-9]{8})_([a-f0-9]{64})$/);
  if (!m) return null;
  return { kind: m[1], prefix: m[2], secret: m[3] };
}

/** Восьмизначный код для ручного ввода, если камера не сработала. */
function shortCode() {
  const n = crypto.randomInt(0, 100000000).toString().padStart(8, '0');
  return `${n.slice(0, 4)}-${n.slice(4)}`;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

module.exports = {
  hashToken, generateSecret, formatToken, parseToken, shortCode, safeEqual, randomHex,
};
