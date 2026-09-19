const { badRequest } = require('./errors');

/** Дольше суток повтор не приходит: очередь на устройстве живёт часами, не днями. */
const ХРАНИТЬ_ЧАСОВ = 24;
const МАКС_ДЛИНА = 100;

/**
 * Ключ повторного запроса.
 *
 * Хранится вместе с ответом: повтор обязан получить то же самое, включая
 * номер созданной записи, — иначе очередь на устройстве не сможет заменить
 * временный id настоящим и следующая правка той же строки уйдёт в никуда.
 */
function opKeys(db) {
  return {
    /** Проверка и приведение заголовка. Пусто — значит, ключа нет. */
    ключИз(raw) {
      if (raw === undefined || raw === null || raw === '') return null;
      const key = String(raw).trim();
      if (!key) return null;
      if (key.length > МАКС_ДЛИНА) {
        throw badRequest(`Слишком длинный Idempotency-Key: максимум ${МАКС_ДЛИНА}`);
      }
      if (!/^[\w.:-]+$/.test(key)) {
        throw badRequest('Idempotency-Key: допустимы буквы, цифры, «-», «_», «.» и «:»');
      }
      return key;
    },

    повтор(userId, key) {
      const row = db.prepare('SELECT status, body FROM op_keys WHERE user_id = ? AND key = ?')
        .get(userId, key);
      if (!row) return null;
      try { return { status: row.status, body: row.body ? JSON.parse(row.body) : null }; }
      catch { return null; }
    },

    запомнить(userId, key, status, body) {
      db.prepare(`INSERT INTO op_keys (user_id, key, status, body) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id, key) DO NOTHING`)
        .run(userId, key, status, body === undefined ? null : JSON.stringify(body));
    },

    убратьСтарые(часов = ХРАНИТЬ_ЧАСОВ) {
      return db.prepare("DELETE FROM op_keys WHERE created_at < datetime('now', ?)")
        .run(`-${Number(часов) || ХРАНИТЬ_ЧАСОВ} hours`).changes;
    },
  };
}

module.exports = { opKeys, ХРАНИТЬ_ЧАСОВ };
