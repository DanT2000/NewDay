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
const { mealsRepo } = require('../repos/meals');
const { usersRepo } = require('../repos/users');
const { seriesService } = require('./seriesService');
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
  const list = parseLeads(row.remind_before_json);
  if (list) return list;
  return [row.remind_before_min === null ? fallback : row.remind_before_min];
}

/** Список сроков из колонки; null — списка нет или он испорчен. */
function parseLeads(raw) {
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return null;
    return [...new Set(list.filter(Number.isFinite))].sort((a, b) => b - a);
  } catch { return null; }
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
  const meals = mealsRepo(db);
  const users = usersRepo(db);
  const series = seriesService(db);

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

    /*
     * Сначала достраиваем день повторами.
     *
     * Материализация раньше жила только в чтении дня, а планировщик читал
     * то, что уже лежит в таблице. Из-за этого ежедневный будильник не звонил
     * в день, который никто не открывал: в понедельник утром человек ждал
     * звонка, а строки в базе ещё не было.
     */
    series.materializeDay(user.id, date, { today: todayFor(user.timezone, new Date(now())) });

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
         * −1 — «к концу», а не «за минус одну минуту». Так помечает свой срок
         * приём пищи окном, а в расписание он ставит блок с теми же сроками:
         * без этой ветки блок звонил бы в начало окна вместо его конца. Без
         * конца отметке нечего означать.
         */
        const atEnd = before === -1;
        if (atEnd && row.end_min === null) { skipped += 1; continue; }
        /*
         * Момент считаем вычитанием из начала, а не из минут дня: «за день»
         * и «за неделю» приходятся на другую дату, и вычитание в минутах
         * уводило их в отрицательные числа — такие сроки просто пропадали.
         */
        const fireAt = atEnd
          ? zonedTimeToUtc(date, row.end_min, user.timezone)
          : startsAt - before * 60000;
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
          body: atEnd
            ? `${row.title || 'Без названия'} — заканчивается в ${formatMinutes(row.end_min)}`
            : before > 0
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

    /*
     * Приёмы пищи со своим сроком напоминания.
     *
     * Раньше их не планировал никто: строки расписания читались, а `meals`
     * нет — и колокольчик у приёма пищи в интерфейсе горел, обещая
     * напоминание, которого не будет. У окна отсчёт идёт от его начала:
     * «съесть где-то внутри» — это и значит «начиная с».
     */
    for (const meal of meals.list(user.id, date)) {
      if (meal.time_min === null || meal.time_min === undefined) continue;
      if (meal.done === 1) { skipped += 1; continue; }
      // блок в расписании напомнит сам — второе напоминание об одном и том же лишнее
      if (meal.schedule_item_id) continue;

      const leads = parseLeads(meal.remind_before_json);
      if (!leads) continue;

      const startsAt = zonedTimeToUtc(date, meal.time_min, user.timezone);
      for (const before of leads) {
        /*
         * −1 — это «к концу окна», а не «за минус одну минуту»: у окна
         * «с 12:00 до 14:00» напомнить к концу значит в 14:00. Считаем от конца
         * окна, каким он лежит сейчас, — поэтому правка окна двигает и
         * напоминание. Если окна нет, отметке нечего означать.
         */
        const atEnd = before === -1;
        if (atEnd && (meal.end_min === null || meal.end_min === undefined)) { skipped += 1; continue; }
        const fireAt = atEnd
          ? zonedTimeToUtc(date, meal.end_min, user.timezone)
          : startsAt - before * 60000;
        if (fireAt <= now()) { skipped += 1; continue; }
        if (inQuietHours(minutesInZone(fireAt, user.timezone), cfg.quietFrom, cfg.quietTo)) {
          skipped += 1;
          continue;
        }

        const key = `${prefix}meal${meal.id}:${before}`;
        keep.push(key);
        queue.upsertQueued(user.id, key, fireAt, {
          kind: 'notify',
          title: 'NewDay',
          body: atEnd
            ? `${meal.title || 'Приём пищи'} — окно закрывается в ${formatMinutes(meal.end_min)}`
            : before > 0
              ? `${meal.title || 'Приём пищи'} — через ${humanLead(before)}, в ${formatMinutes(meal.time_min)}`
              : `${meal.title || 'Приём пищи'} — пора`,
          date,
          itemId: `meal${meal.id}`,
          startMin: atEnd ? meal.end_min : meal.time_min,
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
