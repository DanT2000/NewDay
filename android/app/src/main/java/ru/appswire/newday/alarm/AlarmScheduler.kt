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

    /** Идентификатор проверочного будильника из настроек. */
    const val TEST_ALARM_ID = 999_999_999L

    fun scheduleAll(ctx: Context, incoming: List<Alarm>) {
        /*
         * Проверочный будильник переживает синхронизацию.
         *
         * Список из веб-части заменяет всё, что стоит на устройстве, — иначе
         * удалённые строки продолжали бы звонить. Но проверочный будильник в
         * этом списке никогда не приходит, и раньше его снимала первая же
         * синхронизация: человек нажимал «тестовый будильник через минуту»,
         * открывал день — и будильник молча не срабатывал.
         */
        val now = System.currentTimeMillis()
        val keepTest = AlarmStore.load(ctx)
            .filter { it.id == TEST_ALARM_ID && it.fireAt > now && incoming.none { n -> n.id == it.id } }
        val alarms = incoming + keepTest

        cancelAll(ctx, AlarmStore.load(ctx))
        AlarmStore.save(ctx, alarms)
        if (!AlarmStore.isEnabled(ctx)) {
            Log.i(TAG, "SYNCED будильники выключены в настройках — ничего не ставим")
            return
        }
        alarms.filter { it.fireAt > now }.forEach { schedule(ctx, it) }
        // SYNCED — метка латиницей: по ней живые тесты понимают, что приложение
        // уже отправило свой список и можно ставить проверочный будильник,
        // не боясь, что следующая синхронизация его снимет
        Log.i(TAG, "SYNCED запланировано: ${alarms.count { it.fireAt > now }}")
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
