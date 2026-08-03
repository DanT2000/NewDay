const { parseTimeRange } = require('../../lib/dates');

function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
  version: 2,
  name: 'normalize',

  up(db) {
    // ── users ───────────────────────────────────────────────────────────
    addColumn(db, 'users', 'email',          'email TEXT');
    addColumn(db, 'users', 'email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'users', 'display_name',   "display_name TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'users', 'timezone',       "timezone TEXT NOT NULL DEFAULT 'Europe/Moscow'");
    addColumn(db, 'users', 'theme',          "theme TEXT NOT NULL DEFAULT 'system'");
    addColumn(db, 'users', 'week_start',     'week_start INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'users', 'schedule_view',  "schedule_view TEXT NOT NULL DEFAULT 'list'");
    addColumn(db, 'users', 'food_mode',      "food_mode TEXT NOT NULL DEFAULT 'checklist'");
    addColumn(db, 'users', 'is_admin',       'is_admin INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'users', 'updated_at',     "updated_at TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

    // ── days ────────────────────────────────────────────────────────────
    addColumn(db, 'days', 'title',       "title TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'days', 'focus',       "focus TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'days', 'weight',      'weight REAL');
    addColumn(db, 'days', 'notes',       "notes TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'days', 'rev',         'rev INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'days', 'legacy_json', 'legacy_json TEXT');

    // ── habits ──────────────────────────────────────────────────────────
    addColumn(db, 'habits', 'color',                  "color TEXT NOT NULL DEFAULT 'blue'");
    addColumn(db, 'habits', 'type',                   "type TEXT NOT NULL DEFAULT 'binary'");
    addColumn(db, 'habits', 'target_per_day',         'target_per_day INTEGER');
    addColumn(db, 'habits', 'unit',                   'unit TEXT');
    addColumn(db, 'habits', 'schedule_mask',          'schedule_mask INTEGER NOT NULL DEFAULT 127');
    addColumn(db, 'habits', 'polarity',               "polarity TEXT NOT NULL DEFAULT 'do'");
    addColumn(db, 'habits', 'mode',                   "mode TEXT NOT NULL DEFAULT 'ongoing'");
    addColumn(db, 'habits', 'challenge_target_days',  'challenge_target_days INTEGER');
    addColumn(db, 'habits', 'challenge_start_date',   'challenge_start_date TEXT');
    addColumn(db, 'habits', 'break_policy',           "break_policy TEXT NOT NULL DEFAULT 'reset'");
    addColumn(db, 'habits', 'allowed_skips_per_week', 'allowed_skips_per_week INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'habits', 'archived_at',            'archived_at TEXT');

    // ── habit_logs: done 0/1 → status done|missed|skipped ───────────────
    // Отсутствие записи и «не сделал» раньше были неразличимы, из-за этого врала статистика.
    addColumn(db, 'habit_logs', 'status', "status TEXT NOT NULL DEFAULT 'done'");
    addColumn(db, 'habit_logs', 'value',  'value INTEGER');
    const hlCols = db.prepare('PRAGMA table_info(habit_logs)').all().map(c => c.name);
    if (hlCols.includes('done')) {
      db.exec("UPDATE habit_logs SET status = CASE WHEN done = 1 THEN 'done' ELSE 'missed' END");
    }
    // Столбец done не удаляем: DROP COLUMN в SQLite капризен, а лишняя колонка безвредна.

    // ── новые таблицы ───────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        start_min INTEGER NOT NULL DEFAULT 0, end_min INTEGER,
        title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'normal',
        alarm_mode TEXT NOT NULL DEFAULT 'none',
        alarm_profile TEXT NOT NULL DEFAULT 'gentle',
        remind_before_min INTEGER,
        series_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        bucket TEXT NOT NULL DEFAULT 'work',
        text TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, carried_from TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS meals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        slot TEXT NOT NULL DEFAULT 'other', time_min INTEGER,
        title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sport_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        exercise TEXT NOT NULL DEFAULT '', sets INTEGER, reps INTEGER, weight REAL,
        done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, target TEXT NOT NULL,
        freq TEXT NOT NULL DEFAULT 'daily', interval INTEGER NOT NULL DEFAULT 1,
        byweekday INTEGER NOT NULL DEFAULT 127,
        start_date TEXT, end_date TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}', name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS series_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, series_id INTEGER NOT NULL,
        date TEXT NOT NULL, action TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(series_id, date),
        FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS email_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, kind TEXT NOT NULL,
        token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
        prefix TEXT NOT NULL, token_hash TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'read',
        last_used_at TEXT, revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '', prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, code_hash TEXT NOT NULL,
        short_code TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, dedupe_key TEXT NOT NULL,
        fire_at_utc INTEGER NOT NULL, payload_json TEXT NOT NULL,
        sent_at TEXT, failed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, dedupe_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sched_user_date ON schedule_items(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date, bucket);
      CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_sport_user_date ON sport_sets(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_series_user     ON series(user_id, target);
      CREATE INDEX IF NOT EXISTS idx_nq_fire         ON notification_queue(fire_at_utc, sent_at);
      CREATE INDEX IF NOT EXISTS idx_apitok_prefix   ON api_tokens(prefix);
      CREATE INDEX IF NOT EXISTS idx_dev_prefix      ON devices(prefix);
      CREATE INDEX IF NOT EXISTS idx_emailtok_hash   ON email_tokens(token_hash);
    `);

    // ── перенос data_json в нормальные таблицы ──────────────────────────
    // Условие legacy_json IS NULL защищает от повторного прогона.
    const rows = db.prepare(`
      SELECT id, user_id, date, data_json FROM days
      WHERE legacy_json IS NULL AND data_json IS NOT NULL AND data_json != '{}'
    `).all();

    const upDay = db.prepare(
      'UPDATE days SET title = ?, focus = ?, weight = ?, notes = ?, legacy_json = ? WHERE id = ?'
    );
    const insSched = db.prepare(`INSERT INTO schedule_items
      (user_id, date, start_min, end_min, title, note, done, sort_order)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insTask = db.prepare(`INSERT INTO tasks
      (user_id, date, bucket, text, done, sort_order, carried_from) VALUES (?,?,?,?,?,?,?)`);
    const insSport = db.prepare(`INSERT INTO sport_sets
      (user_id, date, exercise, sets, reps, done, sort_order) VALUES (?,?,?,?,?,?,?)`);

    for (const row of rows) {
      let d;
      try { d = JSON.parse(row.data_json); } catch { continue; }
      if (!d || typeof d !== 'object') continue;

      upDay.run(
        String(d.title ?? ''),
        String(d.focus ?? ''),
        typeof d.weight === 'number' ? d.weight : null,
        String(d.notes ?? ''),
        row.data_json,
        row.id
      );

      if (Array.isArray(d.schedule)) {
        d.schedule.forEach((s, i) => {
          const r = parseTimeRange(String(s.time ?? ''));
          insSched.run(
            row.user_id, row.date,
            r ? r.startMin : 0,
            r ? r.endMin : null,
            String(s.action ?? s.title ?? ''),
            String(s.note ?? ''),
            s.done ? 1 : 0, i
          );
        });
      }

      for (const [field, bucket] of [['workTasks', 'work'], ['homeTasks', 'home']]) {
        if (!Array.isArray(d[field])) continue;
        d[field].forEach((t, i) => {
          insTask.run(
            row.user_id, row.date, bucket,
            String(t.text ?? ''), t.done ? 1 : 0, i, t.carriedFrom ?? null
          );
        });
      }

      if (Array.isArray(d.sport)) {
        d.sport.forEach((s, i) => {
          insSport.run(
            row.user_id, row.date, String(s.exercise ?? ''),
            Number.isFinite(Number(s.sets)) && s.sets !== '' && s.sets !== null ? Number(s.sets) : null,
            Number.isFinite(Number(s.reps)) && s.reps !== '' && s.reps !== null ? Number(s.reps) : null,
            s.done ? 1 : 0, i
          );
        });
      }
    }
  },
};
