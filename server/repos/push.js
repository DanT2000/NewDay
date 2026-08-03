const { notFound } = require('../lib/errors');

function pushRepo(db) {
  return {
    // ── Подписки браузеров ──────────────────────────────────────
    listSubscriptions(userId) {
      return db.prepare(
        'SELECT id, endpoint, p256dh, auth, user_agent, created_at FROM push_subscriptions WHERE user_id = ?'
      ).all(userId);
    },

    saveSubscription(userId, { endpoint, p256dh, auth, userAgent }) {
      db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES (?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id, p256dh = excluded.p256dh,
          auth = excluded.auth, user_agent = excluded.user_agent
      `).run(userId, endpoint, p256dh, auth, userAgent || null);
      return db.prepare('SELECT id, endpoint, created_at FROM push_subscriptions WHERE endpoint = ?')
        .get(endpoint);
    },

    removeSubscription(userId, endpoint) {
      const r = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
        .run(userId, endpoint);
      if (r.changes === 0) throw notFound('Подписка не найдена');
    },

    removeSubscriptionById(id) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
    },

    // ── Очередь отправки ────────────────────────────────────────
    /**
     * dedupe_key делает планирование идемпотентным: пересчёт дня не создаёт
     * дублей, а меняет время уже запланированного уведомления.
     */
    upsertQueued(userId, dedupeKey, fireAtUtc, payload) {
      db.prepare(`
        INSERT INTO notification_queue (user_id, dedupe_key, fire_at_utc, payload_json)
        VALUES (?,?,?,?)
        ON CONFLICT(user_id, dedupe_key) DO UPDATE SET
          fire_at_utc = excluded.fire_at_utc,
          payload_json = excluded.payload_json,
          sent_at = NULL, failed_at = NULL, attempts = 0
        WHERE notification_queue.sent_at IS NULL
      `).run(userId, dedupeKey, fireAtUtc, JSON.stringify(payload));
    },

    /** Убирает запланированное, чего в дне больше нет. */
    dropQueuedExcept(userId, prefix, keepKeys) {
      const rows = db.prepare(
        'SELECT id, dedupe_key FROM notification_queue WHERE user_id = ? AND sent_at IS NULL AND dedupe_key LIKE ?'
      ).all(userId, `${prefix}%`);
      const keep = new Set(keepKeys);
      const del = db.prepare('DELETE FROM notification_queue WHERE id = ?');
      for (const r of rows) if (!keep.has(r.dedupe_key)) del.run(r.id);
    },

    due(nowMs, limit = 200) {
      return db.prepare(`
        SELECT * FROM notification_queue
         WHERE sent_at IS NULL AND failed_at IS NULL AND fire_at_utc <= ?
         ORDER BY fire_at_utc ASC LIMIT ?
      `).all(nowMs, limit);
    },

    markSent(id) {
      db.prepare("UPDATE notification_queue SET sent_at = datetime('now') WHERE id = ?").run(id);
    },

    markFailed(id) {
      db.prepare(`
        UPDATE notification_queue
           SET attempts = attempts + 1,
               failed_at = CASE WHEN attempts + 1 >= 3 THEN datetime('now') ELSE NULL END
         WHERE id = ?
      `).run(id);
    },

    /** Уведомления старше суток чистим: догонять их уже бессмысленно. */
    purgeOld(beforeMs) {
      db.prepare('DELETE FROM notification_queue WHERE fire_at_utc < ?').run(beforeMs);
    },

    pending(userId) {
      return db.prepare(`
        SELECT dedupe_key, fire_at_utc, payload_json FROM notification_queue
         WHERE user_id = ? AND sent_at IS NULL ORDER BY fire_at_utc
      `).all(userId);
    },
  };
}

module.exports = { pushRepo };
