/**
 * Сессии express-session лежат в той же базе (см. lib/session-store.js):
 * sid, sess (JSON) и срок. Номер человека внутри JSON, поэтому выбирать
 * приходится через json_extract — колонки под него нет.
 *
 * Нужно это только для одного случая: сменил пароль — чужие входы закончились.
 */
function sessionsRepo(db) {
  return {
    /**
     * Закрывает все входы человека, кроме одного.
     * @param {number} userId
     * @param {string|null} keepSid — сессия, из которой пришёл запрос: закрывать
     *   её значит выкинуть человека из вкладки, где он только что менял пароль.
     * @returns {number} сколько входов закрыто
     */
    revokeAllForUser(userId, keepSid = null) {
      const r = db.prepare(`
        DELETE FROM sessions
         WHERE json_extract(sess, '$.userId') = ?
           AND (? IS NULL OR sid <> ?)
      `).run(userId, keepSid, keepSid);
      return r.changes;
    },
  };
}

module.exports = { sessionsRepo };
