/**
 * Административные настройки экземпляра.
 *
 * Пока здесь только подключение ИИ. Оно общее: владелец задаёт адрес,
 * ключ и модель один раз, и помощник работает у всех, кому он дал доступ.
 * Поэтому раздел не должен быть виден в обычном профиле — и не должен
 * быть доступен по обычному токену.
 *
 * Подключение стандартное, OpenAI-совместимое: базовый адрес плюс ключ.
 * Так подходят и OpenAI, и AI Tunnel, и локальная LM Studio — у всех
 * один и тот же путь /v1/chat/completions.
 */

const express = require('express');
const { wrap, ApiError } = require('../../lib/errors');
const v = require('../../lib/validate');
const { appSettingsRepo } = require('../../repos/appSettings');
const { isAdmin } = require('../../lib/admin');

module.exports = function adminRouter({ db, config, ai }) {
  const router = express.Router();
  const settings = ai.settings ?? appSettingsRepo(db);

  // Проверка админа — на весь роутер: забыть её на одном эндпоинте
  // означает отдать ключ любому пользователю.
  router.use((req, _res, next) => {
    if (!isAdmin(req.user, config)) {
      return next(new ApiError(403, 'NOT_ADMIN', 'Раздел доступен только администратору'));
    }
    next();
  });

  router.get('/ai', wrap((_req, res) => res.json(settings.aiPublic())));

  router.patch('/ai', wrap((req, res) => {
    const body = req.body || {};
    const patch = {};

    // Адреса два: текстовый и голосовой. Пустой голосовой — «речь туда же,
    // куда текст»: подстановка живёт в repos/appSettings
    for (const [field, name] of [['baseUrl', 'адрес'], ['voiceBaseUrl', 'адрес распознавания']]) {
      if (body[field] === undefined) continue;
      const url = v.str(body[field], { max: 300, field: name });
      if (url && !/^https?:\/\//i.test(url)) {
        throw new ApiError(400, 'BAD_URL', 'Адрес должен начинаться с http:// или https://');
      }
      patch[field] = url;
    }
    // Моделей три: быстрая для фраз, умная для длинных текстов, голосовая
    // для речи. Одна на всё либо дорога, либо слаба — замеры в docs/стоимость.md
    for (const [field, name] of [['model', 'модель'], ['smartModel', 'умная модель'], ['voiceModel', 'модель распознавания']]) {
      if (body[field] !== undefined) patch[field] = v.str(body[field], { max: 120, field: name });
    }
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    // null — «удалить ключ», пустая строка — «не менять».
    // Удалённый голосовой ключ возвращает подстановку от текстового.
    for (const field of ['apiKey', 'voiceApiKey']) {
      if (body[field] === null) patch[field] = null;
      else if (typeof body[field] === 'string') patch[field] = body[field];
    }

    res.json(settings.saveAi(patch));
  }));

  /**
   * Проверка связи. Спрашиваем список моделей — самый дешёвый запрос,
   * который отвечает на оба вопроса сразу: адрес верный и ключ принят.
   * Без такой кнопки человек узнаёт об ошибке в конфигурации только тогда,
   * когда помощник молча не работает.
   */
  router.post('/ai/test', wrap(async (_req, res) => {
    const cfg = settings.aiConfig();
    if (!cfg.baseUrl) throw new ApiError(400, 'NO_URL', 'Сначала укажите адрес');

    const started = Date.now();
    try {
      const r = await fetch(`${cfg.baseUrl}/models`, {
        headers: {
          Accept: 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      if (!r.ok) {
        return res.json({
          ok: false,
          status: r.status,
          message: r.status === 401 ? 'Ключ не принят' : `Сервер ответил ${r.status}`,
          detail: text.slice(0, 300),
        });
      }
      let models = [];
      try { models = (JSON.parse(text).data || []).map(m => m.id).slice(0, 50); } catch { /* не JSON — просто нет списка */ }
      res.json({ ok: true, ms: Date.now() - started, models });
    } catch (e) {
      res.json({
        ok: false,
        message: e.name === 'TimeoutError' ? 'Не ответил за 15 секунд' : 'Не удалось соединиться',
        detail: String(e.message).slice(0, 200),
      });
    }
  }));

  // ── Расход ─────────────────────────────────────────────────

  /**
   * Сколько потрачено. Владелец платит за модель и должен видеть это здесь,
   * а не в личном кабинете провайдера: иначе о всплеске он узнаёт, когда
   * кончаются деньги.
   */
  router.get('/ai/usage', wrap((req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json({ ...ai.usage.summary(days), daily: ai.usage.daily(days) });
  }));

  return router;
};
