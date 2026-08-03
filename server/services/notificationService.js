/**
 * Планирование и отправка напоминаний.
 *
 * Что важно понимать про время: строка расписания хранит локальную дату и
 * минуты от полуночи, а очередь — момент в UTC. Перевод делает zonedTimeToUtc,
 * иначе весной и осенью уведомления уезжали бы на час.
 *
 * Планирование идемпотентно: у каждого напоминания есть dedupe_key вида
 * `sched:<date>:<id>`, поэтому пересчёт дня двигает уже созданную запись,
 * а не плодит дубли.
 */

const { pushRepo } = require('../repos/push');
const { scheduleRepo } = require('../repos/schedule');
const { usersRepo } = require('../repos/users');
const { todayFor, addDays, zonedTimeToUtc, minutesInZone, formatMinutes } = require('../lib/dates');

const DEFAULTS = {
  notifyEnabled: true,
  notifyDefaultBeforeMin: 10,
  quietFrom: null,     // минуты от полуночи; null — тихих часов нет
  quietTo: null,
};

/** Тихие часы могут пересекать полночь: 23:00–07:00 — это два интервала. */
function inQuietHours(minutes, from, to) {
  if (from === null || to === null || from === to) return false;
  return from < to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}

function settingsOf(users, user) {
  const raw = users.getSettings(user.id);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    notifyEnabled: raw.notifyEnabled === undefined ? DEFAULTS.notifyEnabled : Boolean(raw.notifyEnabled),
    notifyDefaultBeforeMin: num(raw.notifyDefaultBeforeMin, DEFAULTS.notifyDefaultBeforeMin),
    quietFrom: raw.quietFrom === undefined || raw.quietFrom === null ? null : num(raw.quietFrom, null),
    quietTo: raw.quietTo === undefined || raw.quietTo === null ? null : num(raw.quietTo, null),
  };
}

function notificationService(db, { push, now = () => Date.now() } = {}) {
  const queue = pushRepo(db);
  const schedule = scheduleRepo(db);
  const users = usersRepo(db);

  /**
   * Пересчитывает напоминания пользователя на указанную дату.
   * @returns { planned, skipped } — сколько запланировано и сколько отброшено
   */
  function planDay(user, date) {
    const cfg = settingsOf(users, user);
    const prefix = `sched:${date}:`;

    if (!cfg.notifyEnabled) {
      queue.dropQueuedExcept(user.id, prefix, []);
      return { planned: 0, skipped: 0, reason: 'NOTIFICATIONS_OFF' };
    }

    const rows = schedule.list(user.id, date);
    const keep = [];
    let skipped = 0;

    for (const row of rows) {
      if (row.alarm_mode === 'none') continue;
      if (row.done === 1) { skipped += 1; continue; }   // уже сделано — будить незачем

      const before = row.remind_before_min === null
        ? cfg.notifyDefaultBeforeMin
        : row.remind_before_min;
      const fireMinutes = row.start_min - before;

      // напоминание, уехавшее во вчера, не планируем: это уже прошлое
      if (fireMinutes < 0) { skipped += 1; continue; }
      if (inQuietHours(fireMinutes, cfg.quietFrom, cfg.quietTo)) { skipped += 1; continue; }

      const fireAt = zonedTimeToUtc(date, fireMinutes, user.timezone);
      if (fireAt <= now()) { skipped += 1; continue; }

      const key = `${prefix}${row.id}`;
      keep.push(key);
      queue.upsertQueued(user.id, key, fireAt, {
        kind: row.alarm_mode,              // notify | alarm
        title: row.alarm_mode === 'alarm' ? '⏰ Будильник' : 'NewDay',
        body: before > 0
          ? `${row.title || 'Без названия'} — через ${before} мин, в ${formatMinutes(row.start_min)}`
          : `${row.title || 'Без названия'} — начинается`,
        date,
        itemId: row.id,
        startMin: row.start_min,
        profile: row.alarm_profile,
        url: `/app.html#${date}`,
      });
    }

    queue.dropQueuedExcept(user.id, prefix, keep);
    return { planned: keep.length, skipped };
  }

  /** Пересчёт на сегодня и завтра — этого хватает при ежеминутном тике. */
  function planUpcoming(user) {
    const today = todayFor(user.timezone, new Date(now()));
    return [today, addDays(today, 1)].map(date => planDay(user, date));
  }

  function planAll() {
    const all = db.prepare('SELECT * FROM users WHERE email_verified = 1').all();
    for (const user of all) {
      try { planUpcoming(user); }
      catch (e) { console.error('[newday] не удалось спланировать уведомления:', user.id, e.message); }
    }
    return all.length;
  }

  /** Отправляет всё, чему пришло время. Вызывается из планировщика раз в минуту. */
  async function deliverDue() {
    const rows = queue.due(now());
    let sent = 0, failed = 0;

    for (const row of rows) {
      const subs = queue.listSubscriptions(row.user_id);
      if (!subs.length) { queue.markSent(row.id); continue; }   // некуда слать — не копим

      let payload;
      try { payload = JSON.parse(row.payload_json); } catch { queue.markSent(row.id); continue; }

      let anyOk = false;
      for (const sub of subs) {
        const res = await push.send(sub, payload);
        if (res.ok) anyOk = true;
        else if (res.gone) queue.removeSubscriptionById(sub.id);
      }

      if (anyOk) { queue.markSent(row.id); sent += 1; }
      else { queue.markFailed(row.id); failed += 1; }
    }

    queue.purgeOld(now() - 24 * 3600 * 1000);
    return { sent, failed, considered: rows.length };
  }

  return { planDay, planUpcoming, planAll, deliverDue, settingsOf: u => settingsOf(users, u), inQuietHours };
}

module.exports = { notificationService, inQuietHours, NOTIFICATION_DEFAULTS: DEFAULTS };
