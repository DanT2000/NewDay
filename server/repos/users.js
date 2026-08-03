const { notFound } = require('../lib/errors');

const PROFILE_FIELDS = {
  displayName: 'display_name', timezone: 'timezone', theme: 'theme',
  weekStart: 'week_start', scheduleView: 'schedule_view', foodMode: 'food_mode',
};

function usersRepo(db) {
  const self = {
    findById(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    },
    findByEmail(email) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase()) || null;
    },
    findByUsername(username) {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
    },
    /** Вход принимает и почту, и старый логин — мигрированные аккаунты не ломаются. */
    findByLogin(login) {
      const s = String(login || '').trim();
      return self.findByEmail(s) || self.findByUsername(s);
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    },
    create({ email, passwordHash, emailVerified = 0, displayName = '' }) {
      const isFirst = self.count() === 0;
      // username NOT NULL достался от старой схемы: для новых аккаунтов кладём туда почту
      const info = db.prepare(`
        INSERT INTO users (username, email, password_hash, email_verified, display_name, is_admin)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(email, email, passwordHash, emailVerified ? 1 : 0, displayName, isFirst ? 1 : 0);
      return self.findById(info.lastInsertRowid);
    },
    setEmailVerified(id) {
      db.prepare("UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?").run(id);
      return self.findById(id);
    },
    setPassword(id, passwordHash) {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
        .run(passwordHash, id);
    },
    bindEmail(id, email) {
      db.prepare("UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?")
        .run(String(email).toLowerCase(), id);
      return self.findById(id);
    },
    patchProfile(id, fields) {
      const cols = [], vals = [];
      for (const [key, col] of Object.entries(PROFILE_FIELDS)) {
        if (fields[key] === undefined) continue;
        cols.push(`${col} = ?`);
        vals.push(fields[key]);
      }
      if (cols.length) {
        cols.push("updated_at = datetime('now')");
        const r = db.prepare(`UPDATE users SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
        if (r.changes === 0) throw notFound('Пользователь не найден');
      }
      return self.findById(id);
    },

    // ── произвольные настройки ключ-значение ──────────────────────────
    getSettings(userId) {
      const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId);
      const out = {};
      for (const r of rows) {
        try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
      }
      return out;
    },
    setSettings(userId, obj) {
      const stmt = db.prepare(
        'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'
      );
      const tx = db.transaction(() => {
        for (const [k, v] of Object.entries(obj)) stmt.run(userId, k, JSON.stringify(v));
      });
      tx();
      return self.getSettings(userId);
    },
  };
  return self;
}

/** Наружу отдаём только безопасные поля — без хеша пароля. */
function publicUser(u, settings = {}) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    emailVerified: u.email_verified === 1,
    displayName: u.display_name || '',
    timezone: u.timezone,
    theme: u.theme,
    weekStart: u.week_start,
    scheduleView: u.schedule_view,
    foodMode: u.food_mode,
    isAdmin: u.is_admin === 1,
    settings,
  };
}

module.exports = { usersRepo, publicUser, PROFILE_FIELDS };
