require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { requireAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure runtime dirs exist
['public/downloads', 'public/icons'].forEach(dir => {
  const p = path.join(__dirname, '..', dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// SQLite session store (uses same DB file)
class SQLiteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => {
      db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
    }, 60 * 60 * 1000);
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const ttl = (sess.cookie?.maxAge || 30 * 24 * 3600 * 1000);
      const expired = Date.now() + ttl;
      db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expired);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(session({
  store: new SQLiteStore(),
  secret: process.env.SESSION_SECRET || 'newday-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // set true only behind HTTPS reverse proxy with trust proxy
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/days',   require('./routes/days'));
app.use('/api/habits', require('./routes/habits'));

// Export all data
app.get('/api/export/all', requireAuth, (req, res) => {
  function tryParse(s) { try { return JSON.parse(s); } catch { return {}; } }

  const days = db
    .prepare('SELECT date, data_json FROM days WHERE user_id = ? ORDER BY date DESC')
    .all(req.session.userId)
    .map(r => tryParse(r.data_json));

  const habits = db
    .prepare('SELECT id, title, description, emoji, is_active, sort_order, created_at FROM habits WHERE user_id = ? ORDER BY sort_order ASC')
    .all(req.session.userId);

  const habitLogs = db
    .prepare('SELECT habit_id, date, done FROM habit_logs WHERE user_id = ? ORDER BY date DESC')
    .all(req.session.userId);

  const payload = {
    exportDate: new Date().toISOString(),
    username: req.session.username,
    days,
    habits,
    habitLogs,
  };

  res.setHeader('Content-Disposition', 'attachment; filename="newday-full-export.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload, null, 2));
});

// Android install page
app.get('/install', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/install.html'));
});

// Root → index.html (auth check handled client-side)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NewDay listening on port ${PORT}`);
});
