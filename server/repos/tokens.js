const { notFound } = require('../lib/errors');
const { generateSecret, formatToken, parseToken, hashToken, safeEqual } = require('../lib/secrets');

const LAST_USED_THROTTLE_MS = 60 * 1000;

function tokensRepo(db) {
  /*
   * Троттлинг last_used_at — на экземпляр репозитория, а не на модуль (то же,
   * что у devices): общий на процесс кеш ключуется одним номером строки и
   * путал токены разных баз, когда в одном процессе живут несколько
   * экземпляров. Второй токен с тем же номером считался только что
   * отмеченным и навсегда оставался в списке «ни разу не использованным» —
   * а это единственный признак, по которому забытый токен отличают от живого.
   */
  const lastUsedCache = new Map();   // id → когда отметку писали в базу
  const self = {
    list(userId) {
      return db.prepare(`
        SELECT id, name, prefix, scope, last_used_at, created_at
          FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC
      `).all(userId);
    },

    create(userId, { name = '', scope = 'read' }) {
      const { secret, prefix, hash } = generateSecret();
      const info = db.prepare(
        'INSERT INTO api_tokens (user_id, name, prefix, token_hash, scope) VALUES (?,?,?,?,?)'
      ).run(userId, name, prefix, hash, scope);
      const row = db.prepare(
        'SELECT id, name, prefix, scope, created_at FROM api_tokens WHERE id = ?'
      ).get(info.lastInsertRowid);
      // единственный момент, когда секрет виден
      return { ...row, token: formatToken('nd', prefix, secret) };
    },

    revoke(userId, id) {
      const r = db.prepare(
        "UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
      ).run(id, userId);
      if (r.changes === 0) throw notFound('Токен не найден');
    },

    /** Возвращает { userId, scope, tokenId } или null. */
    authenticate(raw) {
      const parsed = parseToken(raw);
      if (!parsed || parsed.kind !== 'nd') return null;

      const row = db.prepare(
        'SELECT * FROM api_tokens WHERE prefix = ? AND revoked_at IS NULL'
      ).get(parsed.prefix);
      if (!row) return null;
      if (!safeEqual(hashToken(parsed.secret), row.token_hash)) return null;

      const now = Date.now();
      if ((lastUsedCache.get(row.id) ?? 0) + LAST_USED_THROTTLE_MS < now) {
        lastUsedCache.set(row.id, now);
        db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
      }
      return { userId: row.user_id, scope: row.scope, tokenId: row.id };
    },
  };
  return self;
}

module.exports = { tokensRepo };
