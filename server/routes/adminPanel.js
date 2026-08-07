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

/** Сессия админа живёт 12 часов: панель — не то, чему стоит быть открытым месяц. */
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

/** Перебор пароля: пять неудач подряд — и четверть часа тишины. */
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

module.exports = function adminPanelRouter({ db, config, ai, access, push }) {
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

  const flags = () => ({ registrationOpen: panel.registrationOpen(), aiEnabled: panel.aiSwitchOn() });

  router.get('/settings', wrap((_req, res) => res.json(flags())));

  router.patch('/settings', wrap((req, res) => {
    if (req.body?.registrationOpen !== undefined) panel.setRegistrationOpen(Boolean(req.body.registrationOpen));
    if (req.body?.aiEnabled !== undefined) panel.setAiSwitch(Boolean(req.body.aiEnabled));
    res.json(flags());
  }));

  // ── Приглашения ────────────────────────────────────────────

  const inviteUrl = code => `${config.appUrl}/register.html?invite=${code}`;

  router.get('/invites', wrap((_req, res) => {
    res.json(invites.list().map(i => ({
      id: i.id,
      code: i.code,
      url: inviteUrl(i.code),
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
    res.json({ id: row.id, code: row.code, url: inviteUrl(row.code) });
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
      SELECT u.id, u.email, u.display_name, u.created_at, u.timezone, u.ai_tier,
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
    })));
  }));

  router.patch('/users/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const tier = v.oneOf(req.body?.aiTier, TIERS, { field: 'тариф' });
    const u = users.setAiTier(id, tier);
    res.json({ id: u.id, aiTier: u.ai_tier });
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
      proxies: proxies.list().map(publicProxy),
      ...(ai.lastError() ? { lastError: ai.lastError() } : {}),
    };
  }

  router.get('/ai', wrap((_req, res) => res.json(aiOverview())));

  router.patch('/ai', wrap((req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.baseUrl !== undefined) {
      const url = v.str(body.baseUrl, { max: 300, field: 'адрес' });
      if (url && !/^https?:\/\//i.test(url)) {
        throw new ApiError(400, 'BAD_URL', 'Адрес должен начинаться с http:// или https://');
      }
      patch.baseUrl = url;
    }
    for (const [field, name] of [['model', 'модель'], ['smartModel', 'умная модель'], ['voiceModel', 'модель распознавания']]) {
      if (body[field] !== undefined) patch[field] = v.str(body[field], { max: 120, field: name });
    }
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    // Как и в /api/v1/admin/ai: пустая строка — «не менять», null — «стереть»
    if (body.apiKey === null) patch.apiKey = null;
    else if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey;

    settings.saveAi(patch);
    res.json(aiOverview());
  }));

  router.post('/ai/proxies', wrap((req, res) => {
    const type = v.oneOf(req.body?.type, ['http', 'https', 'socks5'], { field: 'тип' });
    // Тип socks5 знаем, но ходить через него пока нечем (см. lib/aiFetch) —
    // лучше отказать сразу, чем молча принять неработающий прокси
    if (type === 'socks5') throw new ApiError(400, 'SOCKS_LATER', 'SOCKS появится позже');
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
   */
  router.post('/ai/check', wrap(async (_req, res) => {
    const r = await ai.chat({
      userId: null,
      kind: 'check',
      messages: [{ role: 'user', content: 'Ответь одним словом: работаешь?' }],
      maxTokens: 20,
    });
    res.json(r.ok
      ? { ok: true, latencyMs: r.ms }
      : { ok: false, error: r.error, ...(r.ms ? { latencyMs: r.ms } : {}) });
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
