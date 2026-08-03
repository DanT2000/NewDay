/**
 * Хранилище сессий express-session поверх той же SQLite-базы.
 * Фабрика, а не синглтон: тесты поднимают изолированный экземпляр базы.
 */
module.exports = function createSessionStore(session, db) {
  return class SQLiteStore extends session.Store {
    constructor() {
      super();
      this.cleanupTimer = setInterval(() => {
        try {
          db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
        } catch { /* база могла закрыться при остановке сервера */ }
      }, 60 * 60 * 1000);
      // не держим процесс живым только ради уборки
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    get(sid, cb) {
      try {
        const row = db
          .prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?')
          .get(sid, Date.now());
        cb(null, row ? JSON.parse(row.sess) : null);
      } catch (e) { cb(e); }
    }

    set(sid, sess, cb) {
      try {
        const ttl = sess.cookie?.maxAge || 30 * 24 * 3600 * 1000;
        db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')
          .run(sid, JSON.stringify(sess), Date.now() + ttl);
        cb(null);
      } catch (e) { cb(e); }
    }

    destroy(sid, cb) {
      try {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        cb(null);
      } catch (e) { cb(e); }
    }

    touch(sid, sess, cb) {
      this.set(sid, sess, cb);
    }
  };
};
