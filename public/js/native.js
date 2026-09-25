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
  alarmStepsTarget: 30,
  alarmRescueAfterSec: 90,
  alarmQrLabel: '',
  alarmRampSec: 30,
  soundFile: 'dawn.ogg',
};

/*
 * Старые профили хранят только русское название звука, без имени файла.
 * Название локализовано и может меняться, файл — инвариант, поэтому у
 * прежних пяти имён есть карта; всё новое сохраняет soundFile само.
 */
const LEGACY_SOUND_FILES = {
  'Рассвет': 'dawn.ogg', 'Капля': 'drop.ogg', 'Птицы': 'birds.ogg',
  'Сирена': 'siren.ogg',
  // «Колокол» из первого набора не пережил замену синтезированных звуков
  // настоящими: ближайший по смыслу — колокольчик уведомления
  'Колокол': 'chime.ogg',
};

/*
 * Имя файла из старого профиля.
 *
 * Первый набор был в WAV и синтезированным; сейчас звуки настоящие и в OGG.
 * Профиль человека мог сохранить «bell.wav» — такого файла больше нет, и
 * будильник упал бы на системный сигнал молча. Переводим по названию.
 */
function soundFileOf(settings) {
  const saved = String(settings.soundFile ?? '');
  if (saved && !saved.endsWith('.wav')) return saved;
  return LEGACY_SOUND_FILES[settings.sound] ?? saved.replace(/\.wav$/, '.ogg');
}

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
    // Сколько шагов и через сколько появится аварийный выход.
    //
    // Само значение кода сюда не входит нарочно: оно хранится только на
    // телефоне и в настройки профиля не уезжает. Отправь мы его здесь — код с
    // чайника оказался бы на сервере, где ему делать нечего.
    stepsTarget: Number(settings.alarmStepsTarget ?? ALARM_DEFAULTS.alarmStepsTarget),
    rescueAfterSec: Number(settings.alarmRescueAfterSec ?? ALARM_DEFAULTS.alarmRescueAfterSec),
    qrLabel: String(settings.alarmQrLabel ?? ''),
    // за сколько секунд громкость доходит до максимума после мягкого начала
    rampSec: Number(settings.alarmRampSec ?? ALARM_DEFAULTS.alarmRampSec),
    soundFile: soundFileOf(settings),
  };
}

/** «К концу» — не минуты до начала, а отметка; то же число, что на сервере. */
const К_КОНЦУ = -1;

/**
 * Сроки предупреждения строки — списком, как их понимает сервер.
 *
 * Раньше здесь читалось только одиночное `remind_before_min`, и телефон звонил
 * не о том, что просили: пара «за день и за час» давала одно число 1440, из
 * него выходило время до полуночи — и будильник не ставился вовсе; «к концу»
 * (−1) в одиночное число не попадает, и вместо конца окна телефон брал общую
 * настройку «за 10 минут». Уведомления, поставленные ради офлайна, офлайн и
 * не приходили.
 */
function срокиСтроки(row, settings) {
  // будильник звонит в срок, а не заранее — у него сроков нет
  if (row.alarm_mode === 'alarm') return [0];

  let list = null;
  if (row.remind_before_json) {
    try {
      const разобрано = JSON.parse(row.remind_before_json);
      if (Array.isArray(разобрано) && разобрано.length) {
        list = [...new Set(разобрано.filter(Number.isFinite))].sort((a, b) => b - a);
      }
    } catch { list = null; }
  }
  if (!list) {
    list = [row.remind_before_min ?? Number(settings.notifyDefaultBeforeMin ?? 10)];
  }
  return list.slice(0, 6);
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
    catch {
      /*
       * Не дочитали день — список не отправляем вовсе.
       *
       * Присланный список заменяет на устройстве всё (AlarmPlugin: «Заменяет
       * весь список будильников на присланный»), поэтому пропустить день
       * значило снять его будильники, а пропустить оба — снять все. Человек
       * открывал приложение вечером в метро, и утром не звонило ничего.
       *
       * Настройки отправить можно: они список не трогают.
       */
      await pushAlarmConfig(profile);
      return null;
    }

    for (const row of day.schedule) {
      if (row.alarm_mode === 'none') continue;
      if (row.done === 1) continue;

      срокиСтроки(row, settings).forEach((before, i) => {
        // «к концу» — отметка, а не минуты: момент считается по концу блока
        if (before === К_КОНЦУ && row.end_min === null) return;
        /*
         * Вычитаем из самого времени начала, а не из минут внутри суток: «за
         * день» и «за неделю» приходятся на другую дату, и вычитание в
         * минутах уводило их в отрицательные числа — такие сроки просто
         * пропадали. Сервер считает так же (notificationService).
         */
        const fireAt = before === К_КОНЦУ
          ? zonedTimeToUtc(date, row.end_min, tz)
          : zonedTimeToUtc(date, row.start_min, tz) - before * 60000;
        if (fireAt <= now) return;

        alarms.push({
          /*
           * Номер будильника на устройстве становится кодом запроса
           * (`alarm.id.toInt()`), поэтому он должен быть единственным. У
           * первого срока это номер строки — таким он был всегда, и
           * отложенный кнопкой «Отложить» будильник продолжает узнаваться.
           * Остальным срокам той же строки отводится своя сотня миллионов:
           * пересечься с чужим номером строки или с проверочным будильником
           * (999 999 999) так нельзя.
           */
          id: i === 0 ? row.id : row.id + i * 100000000,
          fireAt,
          title: row.alarm_mode === 'alarm' ? 'Будильник' : 'NewDay',
          body: row.title || 'Без названия',
          kind: row.alarm_mode,
          profile: row.alarm_profile || 'gentle',
          date,
        });
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

/**
 * Какая это оболочка и есть ли у неё свои экраны автозапуска.
 *
 * Нужно, чтобы не предлагать «Автозапуск» там, где такого экрана нет: кнопка,
 * ведущая в никуда, хуже её отсутствия. Имя оболочки — чтобы подписать строку
 * теми словами, которые человек увидит на своём телефоне.
 */
export async function vendorSettings() {
  if (!available()) return null;
  try { return await plugin().vendorSettings(); } catch { return null; }
}

export async function testAlarm(delaySec = 60, profile = 'wakeup') {
  if (!available()) return null;
  return plugin().testAlarm({ delaySec, profile });
}

export async function listAlarms() {
  if (!available()) return null;
  try { return await plugin().list(); } catch { return null; }
}

// ── Задачи пробуждения, которым нужно железо ─────────────────

/**
 * Что возможно на этом телефоне: камера, шагомер, выданы ли разрешения,
 * привязан ли код. В браузере — всё выключено: камеру там теоретически найти
 * можно, но будильника, ради которого стоило бы сканировать, там нет.
 */
export async function missionCapabilities() {
  if (!available()) return null;
  try { return await plugin().missionCapabilities(); } catch { return null; }
}

/** Открывает сканер и запоминает прочитанный код на телефоне. */
export async function bindCode(label = '') {
  if (!available()) return null;
  return plugin().bindCode({ label });
}

export async function unbindCode() {
  if (!available()) return null;
  try { return await plugin().unbindCode(); } catch { return null; }
}

export async function setCodeLabel(label) {
  if (!available()) return null;
  try { return await plugin().setCodeLabel({ label }); } catch { return null; }
}

/** Спрашивает разрешение на камеру или на распознавание активности. */
export async function requestMissionPermission(what) {
  if (!available()) return { granted: false };
  try { return await plugin().requestMissionPermission({ what }); }
  catch { return { granted: false }; }
}

/**
 * Красит системные полосы под тему приложения. Полоса жестов внизу без
 * этого остаётся белой на тёмной теме — как чужая наклейка на экране.
 */
export async function setSystemBars(darkTheme, color) {
  if (!available()) return null;
  try { return await plugin().setSystemBars({ dark: Boolean(darkTheme), color }); }
  catch { return null; }
}

/**
 * Насколько системные полосы залезают на страницу, в CSS-пикселях.
 *
 * Спрашиваем у системы, а не у CSS: в Android WebView `env(safe-area-inset-top)`
 * заполняется только для выреза камеры, а обычная шторка в него не попадает —
 * на телефоне без выреза он остаётся нулём. А приложение рисуется край-в-край:
 * начиная с targetSdk 35 это делает Android сам, и отказаться нельзя.
 *
 * `null` значит «пока неизвестно»: окно ещё не прикреплено. Лучше спросить
 * снова, чем сдвинуть содержимое на выдуманное число.
 */
export async function systemInsets() {
  if (!available()) return null;
  try {
    const r = await plugin().systemInsets();
    return r?.known ? r : null;
  } catch { return null; }
}

/**
 * Кладёт свой звук на телефон. Будильник звонит из убитого процесса и до
 * сервера в этот момент не достучится — файл должен лежать на устройстве.
 */
export async function saveSound(file, base64) {
  if (!available()) return null;
  return plugin().saveSound({ file, base64 });
}

export async function removeSound(file) {
  if (!available()) return null;
  try { return await plugin().removeSound({ file }); } catch { return null; }
}

export async function hasSound(file) {
  if (!available()) return false;
  try { return Boolean((await plugin().hasSound({ file }))?.exists); } catch { return false; }
}
