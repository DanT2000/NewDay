/**
 * Кому и сколько помощника.
 *
 * Модель оплачивает владелец, поэтому у него два рычага: общий рубильник
 * (aiAccessEnabled в app_settings) и тариф каждого пользователя
 * (users.ai_tier: off | limited | unlimited). 'limited' — 50 обращений в
 * сутки: достаточно для живого планирования, но не для скрипта в цикле.
 *
 * День лимита считается по часам пользователя, а не сервера: лимит,
 * который обнуляется посреди вечера, выглядит как поломка.
 *
 * Проверка (gate) и запись (note) разнесены сознательно: неудачный запрос
 * к модели не должен съедать лимит — человек не виноват, что провайдер
 * не ответил.
 */

const { ApiError } = require('../lib/errors');
const { appSettingsRepo } = require('../repos/appSettings');
const { panelSettings } = require('../repos/panelSettings');
const { todayFor } = require('../lib/dates');

const DAILY_LIMIT = 50;
const TIERS = ['off', 'limited', 'unlimited'];

function aiAccess(db) {
  const panel = panelSettings(appSettingsRepo(db));

  const dayOf = user => todayFor(user.timezone || 'UTC');

  /** Сколько успешных обращений сегодня — по суткам пользователя. */
  const usedToday = user => db.prepare(
    'SELECT count FROM ai_daily_usage WHERE user_id = ? AND day = ?',
  ).get(user.id, dayOf(user))?.count ?? 0;

  /** Бросает, если помощник этому человеку сейчас недоступен. */
  function gate(user) {
    if (!panel.aiSwitchOn() || user.ai_tier === 'off') {
      throw new ApiError(403, 'AI_DISABLED', 'Помощник отключён — обратитесь к администратору');
    }
    if (user.ai_tier === 'limited' && usedToday(user) >= DAILY_LIMIT) {
      throw new ApiError(429, 'AI_LIMIT', 'Дневной лимит помощника исчерпан — обратитесь к администратору');
    }
  }

  /** Засчитать одно успешное обращение. */
  function note(user) {
    db.prepare(
      `INSERT INTO ai_daily_usage (user_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1`,
    ).run(user.id, dayOf(user));
  }

  /** Что показать человеку в статусе помощника. */
  const statusFor = user => ({
    enabled: panel.aiSwitchOn(),
    tier: user.ai_tier,
    usedToday: usedToday(user),
    dailyLimit: user.ai_tier === 'limited' ? DAILY_LIMIT : null,
  });

  return { gate, note, usedToday, statusFor, panel, DAILY_LIMIT };
}

module.exports = { aiAccess, DAILY_LIMIT, TIERS };
