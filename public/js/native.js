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

/**
 * Значения по умолчанию для будильника.
 * Экран настроек и мост читают их из одного места, чтобы «по умолчанию»
 * на экране и «по умолчанию» в приложении не разъехались.
 */
export const ALARM_DEFAULTS = {
  alarmTaskTypes: ['math', 'code', 'icons'],
  alarmTaskCount: 1,
  alarmTaskDifficulty: 1,
  alarmTaskTimeoutSec: 30,
  alarmSnoozeAllowed: true,
  alarmSnoozeMinutes: 5,
  alarmVolumeRamp: true,
  alarmGraceEnabled: true,
  alarmGraceSec: 60,
};

/** Настройки экрана отключения: их задаёт человек в настройках. */
function dismissConfig(settings = {}) {
  const types = Array.isArray(settings.alarmTaskTypes) && settings.alarmTaskTypes.length
    ? settings.alarmTaskTypes
    : ALARM_DEFAULTS.alarmTaskTypes;
  return {
    types,
    count: Number(settings.alarmTaskCount ?? ALARM_DEFAULTS.alarmTaskCount),
    difficulty: Number(settings.alarmTaskDifficulty ?? ALARM_DEFAULTS.alarmTaskDifficulty),
    timeoutSec: Number(settings.alarmTaskTimeoutSec ?? ALARM_DEFAULTS.alarmTaskTimeoutSec),
    snoozeAllowed: settings.alarmSnoozeAllowed !== false,
    snoozeMinutes: Number(settings.alarmSnoozeMinutes ?? ALARM_DEFAULTS.alarmSnoozeMinutes),
    volumeRamp: settings.alarmVolumeRamp !== false,
    // мягкое начало: сколько секунд будильник звучит тихо и выключается
    // одной кнопкой, без задач
    graceEnabled: settings.alarmGraceEnabled !== false,
    graceSec: Number(settings.alarmGraceSec ?? ALARM_DEFAULTS.alarmGraceSec),
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

/**
 * Отправляет только настройки будильника.
 * Экран настроек не должен перепланировать день из-за одного переключателя:
 * без сети перечитать день не получится, и полная синхронизация сняла бы
 * уже стоящие будильники.
 */
export async function pushAlarmConfig(profile) {
  if (!available()) return null;
  const settings = profile?.settings || {};
  try {
    return await plugin().setConfig({
      config: dismissConfig(settings),
      enabled: settings.alarmEnabled !== false,
    });
  } catch (e) {
    console.warn('[newday] не удалось передать настройки будильника:', e.message);
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
