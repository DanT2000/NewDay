/**
 * Панель администратора: /api/admin/*.
 *
 * Вход отдельный от пользовательского — по одному паролю на экземпляр,
 * а не по аккаунту. Так владелец попадает в панель даже тогда, когда
 * с пользовательским входом что-то не так (регистрация закрыта, почта
 * не подтверждается), и наоборот: чужая пользовательская сессия сама
 * по себе не даёт панели.
 *
 * Пароль хранится bcrypt-хешем в app_settings (adminPasswordHash). Пока
 * хеша нет, действует пароль по умолчанию «newday», и каждый вход честно
 * отвечает mustChangePassword: true — снять это можно только сменой.
 *
 * Существующий /api/v1/admin (настройки ИИ по пользовательскому токену
 * администратора) не трогаем: приложение продолжает им пользоваться.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const pkg = require('../../package.json');
const { wrap, ApiError, badRequest, notFound, unauthorized } = require('../lib/errors');
const v = require('../lib/validate');
const { MIGRATIONS } = require('../db/migrations');
const { appSettingsRepo } = require('../repos/appSettings');
const { panelSettings, DEFAULT_ADMIN_PASSWORD } = require('../repos/panelSettings');
const { invitesRepo } = require('../repos/invites');
const { aiProxiesRepo, publicProxy } = require('../repos/aiProxies');
const { usersRepo } = require('../repos/users');
const { TIERS } = require('../services/aiAccess');
const { deleteAfterOf } = require('../services/userCleanup');

/** Сессия админа живёт 12 часов: панель — не то, чему стоит быть открытым месяц. */
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

/** Перебор пароля: пять неудач подряд — и четверть часа тишины. */
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

module.exports = function adminPanelRouter({ db, config, ai, access, push, cleanup }) {
  const router = express.Router();
  const settings = appSettingsRepo(db);
  const panel = panelSettings(settings);
  const invites = invitesRepo(db);
  const proxies = aiProxiesRepo(db);
  const users = usersRepo(db);

  // Ответы панели не должны оседать в кеше браузера: там списки людей и кодов
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ── Вход ───────────────────────────────────────────────────

  /**
   * Счётчик неудач — свой, а не middleware/rateLimit: тот считает все
   * запросы подряд, а здесь нельзя наказывать за успешные входы —
   * только за подбор пароля. Успех сбрасывает счётчик.
   */
  const fails = new Map();   // ip → { count, resetAt }

  function checkBruteforce(ip) {
    const entry = fails.get(ip);
    if (!entry || entry.resetAt <= Date.now()) return;
    if (entry.count >= FAIL_LIMIT) {
      throw new ApiError(429, 'TOO_MANY_REQUESTS',
        'Слишком много неудачных попыток — подождите 15 минут',
        { retryAfterSec: Math.ceil((entry.resetAt - Date.now()) / 1000) });
    }
  }

  function noteFail(ip) {
    const now = Date.now();
    const entry = fails.get(ip);
    if (!entry || entry.resetAt <= now) fails.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    else entry.count += 1;
  }

  const verifyPassword = password => {
    const hash = panel.adminPasswordHash();
    return hash ? bcrypt.compareSync(password, hash) : password === DEFAULT_ADMIN_PASSWORD;
  };

  router.post('/login', wrap((req, res) => {
    checkBruteforce(req.ip);
    const password = String(req.body?.password ?? '');
    if (!password || !verifyPassword(password)) {
      noteFail(req.ip);
      throw unauthorized('Неверный пароль');
    }
    fails.delete(req.ip);
    req.session.adminAt = Date.now();
    res.json({ ok: true, mustChangePassword: !panel.adminPasswordHash() });
  }));

  router.post('/logout', (req, res) => {
    // Гасим только админскую отметку: в этой же сессии человек может
    // оставаться вошедшим как обычный пользователь
    delete req.session.adminAt;
    res.json({ ok: true });
  });

  /** Всё ниже — только со свежим входом администратора. */
  router.use((req, _res, next) => {
    const at = req.session?.adminAt;
    if (!at || Date.now() - at > ADMIN_TTL_MS) {
      return next(unauthorized('Нужен вход администратора'));
    }
    next();
  });

  router.post('/password', wrap((req, res) => {
    const current = String(req.body?.current ?? '');
    const next = v.password(req.body?.next);
    if (!verifyPassword(current)) {
      throw new ApiError(400, 'BAD_PASSWORD', 'Текущий пароль не совпадает');
    }
    panel.setAdminPasswordHash(bcrypt.hashSync(next, 10));
    res.json({ ok: true });
  }));

  // ── Флаги экземпляра ───────────────────────────────────────

  const flags = () => ({
    registrationOpen: panel.registrationOpen(),
    aiEnabled: panel.aiSwitchOn(),
    defaultAiTier: panel.defaultAiTier(),
  });

  router.get('/settings', wrap((_req, res) => res.json(flags())));

  router.patch('/settings', wrap((req, res) => {
    if (req.body?.registrationOpen !== undefined) panel.setRegistrationOpen(Boolean(req.body.registrationOpen));
    if (req.body?.aiEnabled !== undefined) panel.setAiSwitch(Boolean(req.body.aiEnabled));
    // Тариф новичка без приглашения; код приглашения этот выбор перекрывает
    if (req.body?.defaultAiTier !== undefined) {
      panel.setDefaultAiTier(v.oneOf(req.body.defaultAiTier, TIERS, { field: 'тариф' }));
    }
    res.json(flags());
  }));

  // ── Приглашения ────────────────────────────────────────────

  /*
   * Адрес приглашения — тот, по которому админ сюда пришёл, а APP_URL лишь
   * запасной. Без этого свежеразвёрнутый сервер выдавал ссылки на
   * http://localhost:3000: скопировать такую и отправить человеку значит
   * отправить его в никуда. APP_URL остаётся источником истины для писем,
   * которые уходят без запроса.
   */
  const inviteUrl = (code, req) => {
    const base = req?.get('host')
      ? `${req.protocol}://${req.get('host')}`
      : config.appUrl;
    return `${base}/register.html?invite=${code}`;
  };

  router.get('/invites', wrap((req, res) => {
    res.json(invites.list().map(i => ({
      id: i.id,
      code: i.code,
      url: inviteUrl(i.code, req),
      uses: i.uses_limit,
      used: i.used_count,
      aiTier: i.ai_tier,
      revoked: Boolean(i.revoked_at),
      createdAt: i.created_at,
    })));
  }));

  router.post('/invites', wrap((req, res) => {
    const uses = v.int(req.body?.uses ?? 1, { min: 1, max: 1000, field: 'число использований' });
    const aiTier = v.oneOf(req.body?.aiTier, TIERS, { field: 'тариф', fallback: 'limited' });
    const row = invites.create({ usesLimit: uses, aiTier });
    res.json({ id: row.id, code: row.code, url: inviteUrl(row.code, req) });
  }));

  router.delete('/invites/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    if (!invites.findById(id)) throw notFound('Приглашение не найдено');
    invites.revoke(id);
    res.json({ ok: true });
  }));

  // ── Пользователи ───────────────────────────────────────────

  router.get('/users', wrap((_req, res) => {
    // last_seen_at обновляют только устройства (приложение); человек,
    // живущий в браузере, здесь честно показывается как null
    const rows = db.prepare(`
      SELECT u.id, u.email, u.display_name, u.created_at, u.timezone, u.ai_tier, u.blocked_at,
             (SELECT MAX(d.last_seen_at) FROM devices d WHERE d.user_id = u.id) AS last_seen
        FROM users u ORDER BY u.id
    `).all();
    res.json(rows.map(u => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name || '',
      createdAt: u.created_at,
      lastSeen: u.last_seen || null,
      aiTier: u.ai_tier,
      aiUsedToday: access.usedToday({ id: u.id, timezone: u.timezone }),
      blockedAt: u.blocked_at || null,
      // Когда заблокированного удалит автоочистка — чтобы админка могла
      // показать «исчезнет такого-то числа», не зная про 60 дней
      deleteAfter: deleteAfterOf(u.blocked_at),
    })));
  }));

  router.patch('/users/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const tier = v.oneOf(req.body?.aiTier, TIERS, { field: 'тариф' });
    const u = users.setAiTier(id, tier);
    res.json({ id: u.id, aiTier: u.ai_tier });
  }));

  // ── Двухступенчатое удаление: блокировка → окончательное удаление ──

  router.post('/users/:id/block', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const u = users.block(id);
    res.json({ id: u.id, blockedAt: u.blocked_at, deleteAfter: deleteAfterOf(u.blocked_at) });
  }));

  router.post('/users/:id/unblock', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const u = users.unblock(id);
    res.json({ id: u.id, blockedAt: null, deleteAfter: null });
  }));

  router.delete('/users/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const u = users.findById(id);
    if (!u) throw notFound('Пользователь не найден');
    // Стереть можно только уже заблокированного: блокировка обратима,
    // удаление — нет, и между ними обязан стоять отдельный осознанный шаг
    if (!u.blocked_at) {
      throw new ApiError(400, 'NOT_BLOCKED',
        'Сначала закройте доступ — окончательное удаление необратимо');
    }
    cleanup.deleteUser(id);
    res.json({ ok: true });
  }));

  // ── ИИ: подключение и прокси ───────────────────────────────

  function aiOverview() {
    const c = settings.aiPublic();
    return {
      ready: c.ready,
      enabled: panel.aiSwitchOn(),
      baseUrl: c.baseUrl,
      keySet: c.hasKey,
      keyTail: c.keyTail,
      model: c.model,
      smartModel: c.smartModel,
      voiceModel: c.voiceModel,
      // Голосовое подключение — с подстановкой от текстового: показываем
      // то, куда запросы уйдут на самом деле, а voiceOwn говорит, своё это
      // или отражение текстового
      voiceBaseUrl: c.voiceBaseUrl,
      voiceKeySet: c.voiceKeySet,
      voiceKeyTail: c.voiceKeyTail,
      voiceOwn: c.voiceOwn,
      // Рядом с ready, чтобы страница не пересчитывала готовность речи сама:
      // здешний enabled — это рубильник панели, а не флаг подключения
      voiceReady: c.voiceReady,
      proxies: proxies.list().map(publicProxy),
      ...(ai.lastError() ? { lastError: ai.lastError() } : {}),
    };
  }

  router.get('/ai', wrap((_req, res) => res.json(aiOverview())));

  router.patch('/ai', wrap((req, res) => {
    const body = req.body || {};
    const patch = {};
    // Пустой voiceBaseUrl — законное значение: «распознавать там же, где текст»
    for (const [field, name] of [['baseUrl', 'адрес'], ['voiceBaseUrl', 'адрес распознавания']]) {
      if (body[field] === undefined) continue;
      const url = v.str(body[field], { max: 300, field: name });
      if (url && !/^https?:\/\//i.test(url)) {
        throw new ApiError(400, 'BAD_URL', 'Адрес должен начинаться с http:// или https://');
      }
      patch[field] = url;
    }
    for (const [field, name] of [['model', 'модель'], ['smartModel', 'умная модель'], ['voiceModel', 'модель распознавания']]) {
      if (body[field] !== undefined) patch[field] = v.str(body[field], { max: 120, field: name });
    }
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    // Как и в /api/v1/admin/ai: пустая строка — «не менять», null — «стереть».
    // Стёртый голосовой ключ возвращает подстановку от текстового.
    for (const field of ['apiKey', 'voiceApiKey']) {
      if (body[field] === null) patch[field] = null;
      else if (typeof body[field] === 'string') patch[field] = body[field];
    }

    settings.saveAi(patch);
    res.json(aiOverview());
  }));

  router.post('/ai/proxies', wrap((req, res) => {
    const type = v.oneOf(req.body?.type, ['http', 'https', 'socks5'], { field: 'тип' });
    const host = v.str(req.body?.host, { max: 200, field: 'хост' });
    if (!host) throw badRequest('Укажите хост прокси');
    const port = v.int(req.body?.port, { min: 1, max: 65535, field: 'порт' });
    const login = v.str(req.body?.login, { max: 100, field: 'логин' });
    const password = v.str(req.body?.password, { max: 200, field: 'пароль прокси' });

    res.json(publicProxy(proxies.add({ type, host, port, login, password })));
  }));

  router.patch('/ai/proxies/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    if (!proxies.findById(id)) throw notFound('Прокси не найден');
    const patch = {};
    if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
    if (req.body?.position !== undefined) patch.position = v.int(req.body.position, { min: 0, max: 1e6, field: 'позиция' });
    res.json(publicProxy(proxies.patch(id, patch)));
  }));

  router.delete('/ai/proxies/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    if (!proxies.remove(id)) throw notFound('Прокси не найден');
    res.json({ ok: true });
  }));

  /**
   * Живой пинг: маленький настоящий запрос к модели тем же путём, что и
   * рабочие, — через те же прокси. Проверка списком моделей (v1) отвечает
   * «ключ принят», а эта — «модель правда отвечает».
   *
   * what: 'voice' проверяет второе подключение, голосовое. Там пинг другой —
   * список моделей, а не расшифровка: секунда звука стоит денег, и кнопка
   * не должна их тратить. Подробности — в aiService.checkVoice.
   */
  router.post('/ai/check', wrap(async (req, res) => {
    const what = v.oneOf(req.body?.what, ['text', 'voice'], { field: 'что проверяем', fallback: 'text' });
    const r = what === 'voice'
      ? await ai.checkVoice()
      : await ai.chat({
        userId: null,
        kind: 'check',
        messages: [{ role: 'user', content: 'Ответь одним словом: работаешь?' }],
        maxTokens: 20,
      });
    res.json(r.ok
      ? { ok: true, what, latencyMs: r.ms, ...(r.warning ? { warning: r.warning } : {}) }
      : { ok: false, what, error: r.error, ...(r.ms ? { latencyMs: r.ms } : {}) });
  }));

  // ── Статистика ─────────────────────────────────────────────

  router.get('/stats', wrap((_req, res) => {
    const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    // Активность видна по устройствам: только они отмечают last_seen_at
    const activeWeek = db.prepare(
      "SELECT COUNT(DISTINCT user_id) AS c FROM devices WHERE last_seen_at >= datetime('now', '-7 days')",
    ).get().c;

    const aiToday = db.prepare(
      "SELECT COALESCE(SUM(ok + failed), 0) AS c FROM ai_usage WHERE day = date('now')",
    ).get().c;
    const aiWeek = db.prepare(
      "SELECT COALESCE(SUM(ok + failed), 0) AS c FROM ai_usage WHERE day >= date('now', '-6 days')",
    ).get().c;
    const byDay = db.prepare(
      "SELECT day, SUM(ok + failed) AS count FROM ai_usage WHERE day >= date('now', '-13 days') GROUP BY day ORDER BY day",
    ).all();

    // Краткое здоровье — то же, что смотрит /api/health, без подробностей
    let dbWritable = true;
    try {
      db.prepare('CREATE TABLE IF NOT EXISTS _write_probe (x INTEGER)').run();
      db.prepare('DROP TABLE IF EXISTS _write_probe').run();
    } catch { dbWritable = false; }
    const schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;

    res.json({
      users: { total: totalUsers, activeWeek },
      ai: { today: aiToday, week: aiWeek, byDay },
      health: {
        ok: dbWritable && schemaVersion >= MIGRATIONS.length,
        version: pkg.version,
        schemaVersion,
        dbWritable,
        aiReady: ai.status().ready,
        pushEnabled: Boolean(push?.enabled),
      },
    });
  }));

  return router;
};
