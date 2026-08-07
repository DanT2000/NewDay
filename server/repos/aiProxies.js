/**
 * Прокси для походов к провайдеру ИИ.
 *
 * Некоторые провайдеры недоступны напрямую из некоторых сетей, поэтому
 * владелец задаёт список прокси, а клиент ИИ перебирает их по `position`.
 * Здесь только хранение; сам перебор и память о сбоях — в lib/aiFetch.
 *
 * Пароль наружу не отдаётся — publicProxy() существует, чтобы никакой
 * роутер не собирал ответ из сырой строки и не отдал его случайно.
 */

function aiProxiesRepo(db) {
  const self = {
    list() {
      return db.prepare('SELECT * FROM ai_proxies ORDER BY position, id').all();
    },

    /** Только включённые — то, что перебирает клиент ИИ. */
    alive() {
      return db.prepare('SELECT * FROM ai_proxies WHERE disabled_at IS NULL ORDER BY position, id').all();
    },

    findById(id) {
      return db.prepare('SELECT * FROM ai_proxies WHERE id = ?').get(id) || null;
    },

    add({ type, host, port, login = '', password = '' }) {
      // Новый прокси встаёт в конец очереди: добавление не должно молча
      // менять, через кого сервер ходит прямо сейчас
      const pos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM ai_proxies').get().p + 1;
      const info = db.prepare(
        'INSERT INTO ai_proxies (type, host, port, login, password, position) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(type, host, port, login || null, password || null, pos);
      return self.findById(info.lastInsertRowid);
    },

    patch(id, { active, position } = {}) {
      if (active !== undefined) {
        db.prepare(
          active
            ? 'UPDATE ai_proxies SET disabled_at = NULL WHERE id = ?'
            : "UPDATE ai_proxies SET disabled_at = datetime('now') WHERE id = ? AND disabled_at IS NULL",
        ).run(id);
      }
      if (position !== undefined) {
        db.prepare('UPDATE ai_proxies SET position = ? WHERE id = ?').run(position, id);
      }
      return self.findById(id);
    },

    remove(id) {
      return db.prepare('DELETE FROM ai_proxies WHERE id = ?').run(id).changes > 0;
    },
  };
  return self;
}

/** Что можно показывать в админке: всё, кроме пароля. */
function publicProxy(p) {
  return {
    id: p.id,
    type: p.type,
    host: p.host,
    port: p.port,
    ...(p.login ? { login: p.login } : {}),
    active: !p.disabled_at,
  };
}

module.exports = { aiProxiesRepo, publicProxy };
