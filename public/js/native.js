/**
 * Мост в нативные будильники Android.
 *
 * Веб-часть знает расписание, Android — как разбудить. Здесь расписание
 * на сегодня и завтра превращается в список моментов в UTC и уезжает в плагин.
 * Дальше будильник живёт на устройстве и срабатывает без сети — сервер
 * может быть недоступен ровно в тот момент, когда нужно вставать.
 */

import * as api from './api.js';
import { todayFor, addDays, zonedTimeToUtc } from './dates.js';

const plugin = () => globalThis.Capacitor?.Plugins?.NewDayAlarm ?? null;

export const isNative = () => Boolean(globalThis.Capacitor?.isNativePlatform?.());
export const available = () => isNative() && Boolean(plugin());

/** Настройки экрана отключения: их задаёт человек, по умолчанию — один пример. */
function dismissConfig(settings = {}) {
  const types = Array.isArray(settings.alarmTaskTypes) && settings.alarmTaskTypes.length
    ? settings.alarmTaskTypes
    : ['math'];
  return {
    types,
    count: Number(settings.alarmTaskCount ?? 1),
    difficulty: Number(settings.alarmTaskDifficulty ?? 1),
    timeoutSec: Number(settings.alarmTaskTimeoutSec ?? 30),
    snoozeAllowed: settings.alarmSnoozeAllowed !== false,
    snoozeMinutes: Number(settings.alarmSnoozeMinutes ?? 5),
    volumeRamp: settings.alarmVolumeRamp !== false,
  };
}

/**
 * Пересчитывает нативные будильники на сегодня и завтра.
 * Двух дней достаточно: приложение синхронизируется при каждом открытии дня,
 * а после перезагрузки телефона список восстанавливает BootReceiver.
 */
export async function syncAlarms(profile) {
  if (!available()) return null;

  const tz = profile?.timezone || 'Europe/Moscow';
  const settings = profile?.settings || {};
  const today = todayFor(tz);
  const dates = [today, addDays(today, 1)];
  const now = Date.now();
  const alarms = [];

  for (const date of dates) {
    let day;
    try { day = await api.getDay(date); }
    catch { continue; }   // нет связи — оставляем то, что уже стоит на устройстве

    for (const row of day.schedule) {
      if (row.alarm_mode === 'none') continue;
      if (row.done === 1) continue;

      const before = row.alarm_mode === 'alarm'
        ? 0                                    // будильник звонит в срок, а не заранее
        : (row.remind_before_min ?? Number(settings.notifyDefaultBeforeMin ?? 10));
      const fireMinutes = row.start_min - before;
      if (fireMinutes < 0) continue;

      const fireAt = zonedTimeToUtc(date, fireMinutes, tz);
      if (fireAt <= now) continue;

      alarms.push({
        id: row.id,
        fireAt,
        title: row.alarm_mode === 'alarm' ? 'Будильник' : 'NewDay',
        body: row.title || 'Без названия',
        kind: row.alarm_mode,
        profile: row.alarm_profile || 'gentle',
        date,
      });
    }
  }

  try {
    return await plugin().schedule({
      alarms,
      config: dismissConfig(settings),
      enabled: settings.alarmEnabled !== false,
    });
  } catch (e) {
    console.warn('[newday] не удалось передать будильники в систему:', e.message);
    return null;
  }
}

export async function checkPermissions() {
  if (!available()) return null;
  try { return await plugin().checkAlarmPermissions(); }
  catch { return null; }
}

export async function openSystemSettings(what) {
  if (!available()) return;
  try { await plugin().openSettings({ what }); } catch { /* экрана может не быть */ }
}

export async function testAlarm(delaySec = 60, profile = 'wakeup') {
  if (!available()) return null;
  return plugin().testAlarm({ delaySec, profile });
}

export async function listAlarms() {
  if (!available()) return null;
  try { return await plugin().list(); } catch { return null; }
}
