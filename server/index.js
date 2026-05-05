require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, runMigrations } = require('./db');
const { requireAuth } = require('./auth');
const authRoutes = require('./routes/auth');
const daysRoutes = require('./routes/days');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Coolify / nginx / Traefik)
app.set('trust proxy', 1);

// Body parsing — limit to 1 MB
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── SQLite session store ────────────────────────────────────
class SQLiteStore extends session.Store {
  constructor(database) {
    super();
    this._db = database;
    // Purge expired sessions every hour
    setInterval(() => {
      this._db.prepare('DELETE FROM sessions WHERE expire < ?').run(Math.floor(Date.now() / 1000));
    }, 3_600_000).unref();
  }

  get(sid, cb) {
    try {
      const row = this._db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expire < Math.floor(Date.now() / 1000)) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const expire = sess.cookie && sess.cookie.expires
        ? Math.floor(new Date(sess.cookie.expires).getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      this._db.prepare(
        'INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)'
      ).run(sid, JSON.stringify(sess), expire);
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb) {
    try {
      this._db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
// ────────────────────────────────────────────────────────────

app.use(
  session({
    store: new SQLiteStore(db),
    name: 'planner.sid',
    secret: process.env.SESSION_SECRET || 'change_me_please_use_a_long_random_string',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    },
  })
);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/days', requireAuth, daysRoutes);

// Export all days for current user
app.get('/api/export/all', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT data FROM days WHERE user_id = ? ORDER BY date DESC').all(req.session.userId);
    const days = rows.map(row => JSON.parse(row.data));
    const json = JSON.stringify(days, null, 2);
    res.setHeader('Content-Disposition', 'attachment; filename="planner-export.json"');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(json);
  } catch (err) {
    console.error('Export all error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Page routes
app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/app');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/register', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, '../public/register.html'));
});

app.get('/app', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/app.html'));
});

app.get('/print/:date', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/print.html'));
});

// Start
runMigrations();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Planner app running on port ${PORT}`);
});
