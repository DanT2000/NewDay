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

/**
 * Сроки предупреждения строки. Список хранится в `remind_before_json`;
 * если его нет — берётся одно прежнее число, а если и его нет — общая
 * настройка человека.
 */
function leadsOf(row, fallback) {
  if (row.remind_before_json) {
    try {
      const list = JSON.parse(row.remind_before_json);
      if (Array.isArray(list) && list.length) {
        return [...new Set(list.filter(Number.isFinite))].sort((a, b) => b - a);
      }
    } catch { /* испорченное значение — ведём себя как будто его нет */ }
  }
  return [row.remind_before_min === null ? fallback : row.remind_before_min];
}

/** «за день» читается лучше, чем «через 1440 мин». */
function humanLead(min) {
  if (min >= 10080) return 'неделю';
  if (min >= 1440) return `${Math.round(min / 1440)} дн.`;
  if (min >= 60 && min % 60 === 0) return `${min / 60} ч`;
  return `${min} мин`;
}

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

      /*
       * Сроков может быть несколько: «за день» и «за час» вместе. Каждый
       * получает свою запись в очереди и свой ключ — иначе второй затирал
       * бы первый, и приходило бы только одно напоминание из двух.
       */
      const startsAt = zonedTimeToUtc(date, row.start_min, user.timezone);

      for (const before of leadsOf(row, cfg.notifyDefaultBeforeMin)) {
        /*
         * Момент считаем вычитанием из начала, а не из минут дня: «за день»
         * и «за неделю» приходятся на другую дату, и вычитание в минутах
         * уводило их в отрицательные числа — такие сроки просто пропадали.
         */
        const fireAt = startsAt - before * 60000;
        if (fireAt <= now()) { skipped += 1; continue; }

        // тихие часы проверяем по местному времени самого напоминания
        if (inQuietHours(minutesInZone(fireAt, user.timezone), cfg.quietFrom, cfg.quietTo)) {
          skipped += 1;
          continue;
        }

        const key = `${prefix}${row.id}:${before}`;
        keep.push(key);
        queue.upsertQueued(user.id, key, fireAt, {
          kind: row.alarm_mode,              // notify | alarm
          title: row.alarm_mode === 'alarm' ? '⏰ Будильник' : 'NewDay',
          body: before > 0
            ? `${row.title || 'Без названия'} — через ${humanLead(before)}, в ${formatMinutes(row.start_min)}`
            : `${row.title || 'Без названия'} — начинается`,
          date,
          itemId: row.id,
          startMin: row.start_min,
          profile: row.alarm_profile,
          // Нажатие на уведомление открывает именно тот день, о котором оно
          url: `/web.html#${date}`,
        });
      }
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
