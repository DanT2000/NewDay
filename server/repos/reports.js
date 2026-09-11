const { notFound } = require('../lib/errors');

/** Сколько сообщений отдаём списком за раз: больше одного экрана не читают. */
const PAGE = 50;

/**
 * Сообщения о проблемах.
 *
 * Читает их владелец — человеку, который сообщение оставил, перечитывать
 * его незачем: он уже вернулся к своим делам. Поэтому `list` и `get` здесь
 * без user_id, а право смотреть проверяет маршрут.
 */
function reportsRepo(db) {
  const self = {
    create(userId, {
      text = '', typed = false, voiceError = null,
      audioExt = null, audioBytes = null, shotExt = null, shotBytes = null,
      context = {}, log = [],
    }) {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO reports (user_id, text, typed, voice_error,
                             audio_ext, audio_bytes, shot_ext, shot_bytes, context, log)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(userId, text, typed ? 1 : 0, voiceError,
        audioExt, audioBytes, shotExt, shotBytes,
        JSON.stringify(context ?? {}), JSON.stringify(log ?? []));
      return self.get(lastInsertRowid);
    },

    /**
     * Список: без `context` и `log` — они длинные, а в списке нужен повод
     * открыть, а не всё содержимое.
     */
    list({ status = null, limit = PAGE, before = null } = {}) {
      const where = ['1 = 1'];
      const args = [];
      if (status) { where.push('r.status = ?'); args.push(status); }
      if (before) { where.push('r.id < ?'); args.push(before); }
      return db.prepare(`
        SELECT r.id, r.user_id, r.text, r.typed, r.voice_error, r.audio_ext, r.audio_bytes,
               r.shot_ext, r.shot_bytes, r.status, r.created_at,
               u.username, u.email
          FROM reports r JOIN users u ON u.id = r.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.id DESC
         LIMIT ?
      `).all(...args, Math.min(Number(limit) || PAGE, 200));
    },

    get(id) {
      const row = db.prepare(`
        SELECT r.*, u.username, u.email
          FROM reports r JOIN users u ON u.id = r.user_id
         WHERE r.id = ?
      `).get(id);
      if (!row) throw notFound('Сообщение не найдено');
      return row;
    },

    setStatus(id, status) {
      const r = db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id);
      if (r.changes === 0) throw notFound('Сообщение не найдено');
      return self.get(id);
    },

    remove(id) {
      const r = db.prepare('DELETE FROM reports WHERE id = ?').run(id);
      if (r.changes === 0) throw notFound('Сообщение не найдено');
    },

    counts() {
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status').all();
      return Object.fromEntries(rows.map(r => [r.status, r.n]));
    },
  };
  return self;
}

module.exports = { reportsRepo, PAGE };
