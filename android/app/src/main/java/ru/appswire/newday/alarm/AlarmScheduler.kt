package ru.appswire.newday.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Постановка будильников в системный AlarmManager.
 *
 * setAlarmClock — единственный способ, который переживает Doze и режим
 * энергосбережения. Он же показывает иконку будильника в статусбаре:
 * система относится к нему как к настоящему будильнику, а не к «напоминалке».
 */
object AlarmScheduler {
    private const val TAG = "NewDayAlarm"

    fun scheduleAll(ctx: Context, alarms: List<Alarm>) {
        cancelAll(ctx, AlarmStore.load(ctx))
        AlarmStore.save(ctx, alarms)
        if (!AlarmStore.isEnabled(ctx)) {
            Log.i(TAG, "Будильники выключены в настройках — ничего не ставим")
            return
        }
        val now = System.currentTimeMillis()
        alarms.filter { it.fireAt > now }.forEach { schedule(ctx, it) }
        Log.i(TAG, "Запланировано: ${alarms.count { it.fireAt > now }}")
    }

    fun schedule(ctx: Context, alarm: Alarm) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val fire = pendingIntent(ctx, alarm)

        if (alarm.isAlarm) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                // без разрешения точный будильник поставить нельзя — ставим неточный
                // и честно сообщаем об этом в экране проверки
                Log.w(TAG, "Нет разрешения на точные будильники, ставим приблизительный")
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.fireAt, fire)
                return
            }
            // показывает системную иконку будильника и имеет высший приоритет
            am.setAlarmClock(AlarmManager.AlarmClockInfo(alarm.fireAt, openAppIntent(ctx)), fire)
        } else {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.fireAt, fire)
        }
    }

    fun cancelAll(ctx: Context, alarms: List<Alarm>) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarms.forEach { am.cancel(pendingIntent(ctx, it)) }
    }

    fun cancel(ctx: Context, alarm: Alarm) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(pendingIntent(ctx, alarm))
    }

    private fun pendingIntent(ctx: Context, alarm: Alarm): PendingIntent {
        val intent = Intent(ctx, AlarmReceiver::class.java).apply {
            action = "ru.appswire.newday.FIRE"
            // помогает доставке, если система считает пакет «остановленным»
            addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
            putExtra("alarmId", alarm.id)
            // data делает PendingIntent уникальным для каждого будильника
            data = android.net.Uri.parse("newday://alarm/${alarm.id}")
        }
        return PendingIntent.getBroadcast(
            ctx, alarm.id.toInt(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun openAppIntent(ctx: Context): PendingIntent {
        val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        return PendingIntent.getActivity(
            ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
