const { notFound, badRequest } = require('../lib/errors');
const {
  generateSecret, formatToken, parseToken, hashToken, safeEqual, shortCode, randomHex,
} = require('../lib/secrets');

const PAIR_TTL_MS = 2 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 60 * 1000;
const lastSeenCache = new Map();

function devicesRepo(db) {
  const self = {
    /** Показывается на компьютере авторизованному пользователю. */
    createPairCode(userId) {
      const code = randomHex(24);
      const short = shortCode();
      const expiresAt = Date.now() + PAIR_TTL_MS;
      db.prepare(
        'INSERT INTO pair_codes (user_id, code_hash, short_code, expires_at) VALUES (?,?,?,?)'
      ).run(userId, hashToken(code), short, expiresAt);
      return { code, shortCode: short, expiresAt };
    },

    /** Принимает как полный код из QR, так и короткий для ручного ввода. */
    claimPairCode(rawCode, { deviceName = '', platform = '' }) {
      const input = String(rawCode || '').trim();
      const now = Date.now();

      const row =
        db.prepare(
          'SELECT * FROM pair_codes WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ?'
        ).get(hashToken(input), now) ||
        db.prepare(
          'SELECT * FROM pair_codes WHERE short_code = ? AND claimed_at IS NULL AND expires_at > ?'
        ).get(input, now);

      if (!row) throw badRequest('Код недействителен или истёк', { code: 'PAIR_CODE_INVALID' });

      const { secret, prefix, hash } = generateSecret();
      let deviceId;
      const tx = db.transaction(() => {
        const claimed = db.prepare(
          "UPDATE pair_codes SET claimed_at = datetime('now') WHERE id = ? AND claimed_at IS NULL"
        ).run(row.id);
        if (claimed.changes === 0) {
          throw badRequest('Код уже использован', { code: 'PAIR_CODE_INVALID' });
        }
        const info = db.prepare(
          'INSERT INTO devices (user_id, name, platform, prefix, token_hash) VALUES (?,?,?,?,?)'
        ).run(row.user_id, deviceName, platform, prefix, hash);
        deviceId = info.lastInsertRowid;
      });
      tx();

      const device = db.prepare(
        'SELECT id, name, platform, created_at FROM devices WHERE id = ?'
      ).get(deviceId);
      return { token: formatToken('ndd', prefix, secret), device };
    },

    list(userId) {
      return db.prepare(`
        SELECT id, name, platform, last_seen_at, created_at
          FROM devices WHERE user_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC
      `).all(userId);
    },

    revoke(userId, id) {
      const r = db.prepare(
        "UPDATE devices SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
      ).run(id, userId);
      if (r.changes === 0) throw notFound('Устройство не найдено');
    },

    /** Возвращает { userId, deviceId } или null. Устройство всегда имеет права на запись. */
    authenticate(raw) {
      const parsed = parseToken(raw);
      if (!parsed || parsed.kind !== 'ndd') return null;

      const row = db.prepare(
        'SELECT * FROM devices WHERE prefix = ? AND revoked_at IS NULL'
      ).get(parsed.prefix);
      if (!row) return null;
      if (!safeEqual(hashToken(parsed.secret), row.token_hash)) return null;

      const now = Date.now();
      if ((lastSeenCache.get(row.id) ?? 0) + LAST_SEEN_THROTTLE_MS < now) {
        lastSeenCache.set(row.id, now);
        db.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?").run(row.id);
      }
      return { userId: row.user_id, deviceId: row.id };
    },
  };
  return self;
}

module.exports = { devicesRepo, PAIR_TTL_MS };
