const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../auth');
const { validateUsername, validatePassword } = require('../validation');

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { username, password, confirmPassword } = req.body;

  const uErr = validateUsername(username);
  if (uErr) return res.status(400).json({ error: uErr });

  const pErr = validatePassword(password);
  if (pErr) return res.status(400).json({ error: pErr });

  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Пароли не совпадают' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(400).json({ error: 'Это имя пользователя уже занято' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username.trim(), hash);

  req.session.userId = result.lastInsertRowid;
  req.session.username = username.trim();

  res.json({ success: true, username: username.trim() });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Введите имя пользователя и пароль' });
  }

  const user = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username.trim());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;

  res.json({ success: true, username: user.username });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ userId: req.session.userId, username: req.session.username });
});

module.exports = router;
