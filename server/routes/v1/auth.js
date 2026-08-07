const express = require('express');
const bcrypt = require('bcryptjs');
const { wrap, badRequest, unauthorized, ApiError } = require('../../lib/errors');
const v = require('../../lib/validate');
const { hashToken, randomHex } = require('../../lib/secrets');
const { usersRepo, publicUser } = require('../../repos/users');
const { devicesRepo } = require('../../repos/devices');
const { generateSecret, formatToken } = require('../../lib/secrets');
const { verifyEmailMessage, resetPasswordMessage } = require('../../lib/mailer');
const { rateLimit } = require('../../middleware/rateLimit');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

module.exports = function authRouter({ db, config, mailer, auth }) {
  const router = express.Router();
  const users = usersRepo(db);
  const devices = devicesRepo(db);

  const limiter = rateLimit({ max: 10 });
  const claimLimiter = rateLimit({ max: 20 });

  function issueEmailToken(userId, kind, ttlMs) {
    const token = randomHex(32);
    db.prepare(
      'INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) VALUES (?,?,?,?)'
    ).run(userId, kind, hashToken(token), Date.now() + ttlMs);
    return token;
  }

  function consumeEmailToken(token, kind) {
    const row = db.prepare(
      'SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL'
    ).get(hashToken(String(token || '')), kind);
    if (!row || row.expires_at <= Date.now()) {
      throw badRequest('Ссылка недействительна или истекла', { code: 'TOKEN_INVALID' });
    }
    db.prepare("UPDATE email_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
    return row;
  }

  // ── POST /register ────────────────────────────────────────────────
  router.post('/register', limiter, wrap(async (req, res) => {
    const email = v.email(req.body.email);
    const password = v.password(req.body.password);

    if (users.findByEmail(email)) {
      throw badRequest('Этот адрес уже зарегистрирован');
    }

    // Без SMTP подтверждать нечем — впускаем сразу, иначе self-host не поднимется.
    const verified = mailer.enabled ? 0 : 1;
    const user = users.create({
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      emailVerified: verified,
    });

    if (mailer.enabled) {
      const token = issueEmailToken(user.id, 'verify', VERIFY_TTL_MS);
      await mailer.send(verifyEmailMessage({ to: email, appUrl: config.appUrl, token }));
    } else {
      req.session.userId = user.id;
    }

    /*
     * Токен устройства — сразу при регистрации, как и при входе.
     *
     * Приложение работает кросс-доменно, где cookie не проходят. Раньше токен
     * выдавался только на входе, и человек, зарегистрировавшийся из приложения,
     * оказывался «вошедшим» по сессии, которой у него нет: первый же запрос
     * упирался в «не вошли».
     *
     * Когда почту надо подтвердить, токен не выдаём: до подтверждения входа
     * нет, и выдавать ключ от аккаунта не за что.
     */
    let deviceToken = null;
    if (req.body.issueDeviceToken && !mailer.enabled) {
      const name = v.str(req.body.deviceName, { max: 80, field: 'устройство' }) || 'Приложение';
      const platform = v.str(req.body.platform, { max: 40, field: 'платформа' });
      deviceToken = devices.issueToken(user.id, { deviceName: name, platform });
    }

    res.json({
      success: true,
      needsVerification: mailer.enabled,
      user: publicUser(user),
      ...(deviceToken ? { deviceToken } : {}),
    });
  }));

  // ── GET /verify ───────────────────────────────────────────────────
  router.get('/verify', wrap(async (req, res) => {
    const row = consumeEmailToken(req.query.token, 'verify');
    users.setEmailVerified(row.user_id);
    req.session.userId = row.user_id;
    if (req.get('accept')?.includes('application/json')) {
      return res.json({ success: true });
    }
    res.redirect('/app.html?verified=1');
  }));

  // ── POST /resend-verification ─────────────────────────────────────
  router.post('/resend-verification', limiter, wrap(async (req, res) => {
    const email = v.email(req.body.email);
    const user = users.findByEmail(email);
    if (user && user.email_verified !== 1 && mailer.enabled) {
      const token = issueEmailToken(user.id, 'verify', VERIFY_TTL_MS);
      await mailer.send(verifyEmailMessage({ to: email, appUrl: config.appUrl, token }));
    }
    res.json({ success: true });
  }));

  // ── POST /login ───────────────────────────────────────────────────
  router.post('/login', limiter, wrap(async (req, res) => {
    const login = v.str(req.body.emailOrUsername ?? req.body.email ?? req.body.username,
      { max: 254, field: 'логин' });
    const password = v.str(req.body.password, { max: 200, field: 'пароль', trim: false });
    if (!login || !password) throw badRequest('Введите почту и пароль');

    const user = users.findByLogin(login);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      throw unauthorized('Неверная почта или пароль');
    }
    if (user.email_verified !== 1) {
      throw new ApiError(403, 'EMAIL_NOT_VERIFIED',
        'Подтвердите адрес почты — письмо отправлено при регистрации');
    }

    req.session.userId = user.id;

    // Мобильное приложение работает кросс-доменно, где cookie не проходят,
    // поэтому по запросу отдаём device-токен вместо опоры на сессию.
    let deviceToken = null;
    if (req.body.issueDeviceToken) {
      const name = v.str(req.body.deviceName, { max: 80, field: 'устройство' }) || 'Приложение';
      const platform = v.str(req.body.platform, { max: 40, field: 'платформа' });
      deviceToken = devices.issueToken(user.id, { deviceName: name, platform });
    }

    res.json({
      success: true,
      user: publicUser(user, users.getSettings(user.id)),
      ...(deviceToken ? { deviceToken } : {}),
    });
  }));

  // ── POST /logout ──────────────────────────────────────────────────
  /*
   * Выход гасит то, чем человек вошёл.
   *
   * В приложении сессии нет — там живёт токен устройства, и раньше logout
   * рушил только сессию: человек выходил, открывал приложение — и снова был
   * в аккаунте, потому что токен оставался живым. «Отдал телефон — отдал
   * аккаунт». Токен опознаётся по Bearer-заголовку этого же запроса.
   */
  router.post('/logout', (req, res) => {
    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (bearer) {
      const asDevice = devices.authenticate(bearer);
      if (asDevice) {
        try { devices.revoke(asDevice.userId, asDevice.deviceId); } catch { /* уже отозван */ }
      }
    }
    req.session.destroy(() => res.json({ success: true }));
  });

  // ── GET /me ───────────────────────────────────────────────────────
  router.get('/me', auth.requireAuth, (req, res) => {
    res.json({
      ...publicUser(req.user, usersRepo(db).getSettings(req.user.id)),
      auth: req.auth,
    });
  });

  // ── POST /forgot ──────────────────────────────────────────────────
  router.post('/forgot', limiter, wrap(async (req, res) => {
    const email = v.email(req.body.email);
    const user = users.findByEmail(email);
    // Отвечаем одинаково независимо от того, есть ли аккаунт.
    if (user && mailer.enabled) {
      const token = issueEmailToken(user.id, 'reset', RESET_TTL_MS);
      await mailer.send(resetPasswordMessage({ to: email, appUrl: config.appUrl, token }));
    }
    res.json({ success: true });
  }));

  // ── POST /reset ───────────────────────────────────────────────────
  router.post('/reset', limiter, wrap(async (req, res) => {
    const password = v.password(req.body.password);
    const row = consumeEmailToken(req.body.token, 'reset');
    users.setPassword(row.user_id, bcrypt.hashSync(password, 10));
    users.setEmailVerified(row.user_id);
    res.json({ success: true });
  }));

  /**
   * Смена пароля из настроек.
   *
   * Требуем текущий пароль, хотя человек уже вошёл: сессия могла остаться
   * открытой на чужом устройстве, и тогда смена пароля без подтверждения —
   * это способ отобрать аккаунт, а не защитить его.
   *
   * Отдельно от /reset: тот работает по письму и нужен, когда пароль забыт.
   */
  router.post('/password', auth.requireAuth, auth.requireSession, wrap(async (req, res) => {
    const current = String(req.body?.currentPassword ?? '');
    const next = v.password(req.body?.newPassword);

    const user = users.findById(req.user.id);
    if (!user?.password_hash || !bcrypt.compareSync(current, user.password_hash)) {
      throw new ApiError(400, 'BAD_PASSWORD', 'Текущий пароль не совпадает');
    }
    if (bcrypt.compareSync(next, user.password_hash)) {
      throw badRequest('Новый пароль совпадает с текущим');
    }

    users.setPassword(user.id, bcrypt.hashSync(next, 10));
    res.json({ success: true });
  }));

  // ── POST /bind-email — для мигрированных аккаунтов без почты ──────
  router.post('/bind-email', auth.requireAuth, wrap(async (req, res) => {
    const email = v.email(req.body.email);
    const existing = users.findByEmail(email);
    if (existing && existing.id !== req.user.id) {
      throw badRequest('Этот адрес уже занят');
    }
    const user = users.bindEmail(req.user.id, email);
    if (mailer.enabled) {
      const token = issueEmailToken(user.id, 'verify', VERIFY_TTL_MS);
      await mailer.send(verifyEmailMessage({ to: email, appUrl: config.appUrl, token }));
    }
    res.json({ success: true, user: publicUser(user) });
  }));

  // ── Привязка устройства по QR ─────────────────────────────────────
  router.post('/pair/create', auth.requireAuth, auth.requireSession, wrap(async (req, res) => {
    const { code, shortCode, expiresAt } = devices.createPairCode(req.user.id);
    res.json({ code, shortCode, expiresAt, url: `${config.appUrl}/pair#${code}` });
  }));

  router.post('/pair/claim', claimLimiter, wrap(async (req, res) => {
    const deviceName = v.str(req.body.deviceName, { max: 80, field: 'устройство' });
    const platform = v.str(req.body.platform, { max: 40, field: 'платформа' });
    const result = devices.claimPairCode(req.body.code, { deviceName, platform });
    res.json(result);
  }));

  return router;
};
