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

  /*
   * Обращения в полёте.
   *
   * Между проверкой и записью живёт запрос к модели — секунды. Пока он идёт,
   * следующие запросы успевали пройти проверку по ещё не изменившемуся
   * счётчику, и «пятьдесят в сутки» превращалось в «сколько успеешь запустить
   * разом»: десять параллельных обращений при остатке в пять проходили все
   * десять.
   *
   * Поэтому обращение занимает место сразу, а освобождает его, когда ответ
   * ушёл. Счётчик в базе при этом остаётся счётчиком успехов: к моменту
   * освобождения удачное обращение уже записано, а неудачное лимита не
   * тратит — ради этого проверка и запись и разнесены.
   */
  const inFlight = new Map();   // user_id → сколько обращений сейчас в работе

  function hold(userId, res) {
    inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1);
    let freed = false;
    const free = () => {
      if (freed) return;
      freed = true;
      const left = (inFlight.get(userId) ?? 1) - 1;
      if (left > 0) inFlight.set(userId, left);
      else inFlight.delete(userId);
    };
    // 'close' приходит и когда ответ дописан, и когда клиент отвалился;
    // на 'finish' место осталось бы занятым за оборвавшимся запросом навсегда
    res.on('close', free);
    /*
     * Ответ мог закрыться ещё до подписки — клиент оборвал запрос совсем рано.
     * Тогда события уже не будет, и место осталось бы занятым навсегда: для
     * тарифа «ограниченный» это тихая блокировка, лимит упирается в обращения,
     * которых человек не делал.
     */
    if (res.writableEnded || res.destroyed) free();
  }

  /**
   * Бросает, если помощник этому человеку сейчас недоступен.
   *
   * `res` нужен, чтобы занятое место освободилось само по завершении ответа.
   * Без него проверка прежняя — годится там, где обращения к модели не будет.
   */
  function gate(user, res) {
    if (!panel.aiSwitchOn() || user.ai_tier === 'off') {
      throw new ApiError(403, 'AI_DISABLED', 'Помощник отключён — обратитесь к администратору');
    }
    if (user.ai_tier === 'limited'
        && usedToday(user) + (inFlight.get(user.id) ?? 0) >= DAILY_LIMIT) {
      throw new ApiError(429, 'AI_LIMIT', 'Дневной лимит помощника исчерпан — обратитесь к администратору');
    }
    if (res) hold(user.id, res);
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
