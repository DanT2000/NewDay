/**
 * Приглашения.
 *
 * Код — случайные 16 шестнадцатеричных символов: достаточно, чтобы не
 * подобрать перебором, и достаточно коротко, чтобы жить в ссылке вида
 * /register.html?invite=<код>. Хешировать его, как токены, незачем: код
 * и так одноразовый по счётчику, а админ должен видеть его в списке,
 * чтобы отправить ссылку повторно.
 */

const { randomHex } = require('../lib/secrets');

function invitesRepo(db) {
  const self = {
    list() {
      return db.prepare('SELECT * FROM invites ORDER BY id DESC').all();
    },

    findByCode(code) {
      return db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code || '').trim()) || null;
    },

    findById(id) {
      return db.prepare('SELECT * FROM invites WHERE id = ?').get(id) || null;
    },

    create({ usesLimit = 1, aiTier = 'limited' } = {}) {
      const code = randomHex(8);
      const info = db.prepare(
        'INSERT INTO invites (code, uses_limit, ai_tier) VALUES (?, ?, ?)',
      ).run(code, usesLimit, aiTier);
      return self.findById(info.lastInsertRowid);
    },

    /** Отзыв не удаляет строку: в списке должно быть видно, что код был и чем кончился. */
    revoke(id) {
      return db.prepare(
        "UPDATE invites SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
      ).run(id).changes > 0;
    },

    /**
     * Потратить код. Проверка и трата — одним UPDATE с условием: две
     * одновременные регистрации по последнему использованию кода не
     * пройдут обе, потому что вторая не найдёт строку с used_count < uses_limit.
     */
    spend(code) {
      const c = String(code || '').trim();
      if (!c) return null;
      const r = db.prepare(
        'UPDATE invites SET used_count = used_count + 1 WHERE code = ? AND revoked_at IS NULL AND used_count < uses_limit',
      ).run(c);
      return r.changes ? self.findByCode(c) : null;
    },
  };
  return self;
}

module.exports = { invitesRepo };
