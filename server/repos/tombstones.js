/**
 * Надгробия интеграционных записей.
 *
 * Человек удалил запись, которую создала интеграция, — она не вправе её
 * воскресить: /integrations/apply на такую пару source + externalId отвечает
 * conflict / removed_by_user. Надгробие ставится при «человеческом» удалении
 * (DELETE строки, PUT дня целиком, архив привычки, удаление повтора) и НЕ
 * ставится, когда интеграция удаляет свою запись сама через delete: true.
 *
 * `date` — пустая строка у сущностей без даты (привычки, series): NULL в
 * UNIQUE-индексе SQLite не равен сам себе, и надгробия дублировались бы.
 */
function tombstonesRepo(db) {
  const key = date => date ?? '';
  return {
    put(userId, entity, date, source, externalId) {
      db.prepare(`
        INSERT OR IGNORE INTO integration_tombstones (user_id, entity, date, source, external_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, entity, key(date), source, externalId);
    },

    has(userId, entity, date, source, externalId) {
      return Boolean(db.prepare(`
        SELECT 1 FROM integration_tombstones
         WHERE user_id = ? AND entity = ? AND date = ? AND source = ? AND external_id = ?
      `).get(userId, entity, key(date), source, externalId));
    },

    clear(userId, entity, date, source, externalId) {
      const r = db.prepare(`
        DELETE FROM integration_tombstones
         WHERE user_id = ? AND entity = ? AND date = ? AND source = ? AND external_id = ?
      `).run(userId, entity, key(date), source, externalId);
      return r.changes;
    },
  };
}

module.exports = { tombstonesRepo };
