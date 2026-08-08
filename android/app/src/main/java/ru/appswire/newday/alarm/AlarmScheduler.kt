package ru.appswire.newday.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

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
         * Проверочный и отложенный будильники переживают синхронизацию.
         *
         * Список из веб-части заменяет всё, что стоит на устройстве, — иначе
         * удалённые строки продолжали бы звонить. Но есть будильники, которые
         * веб-часть прислать не может, потому что о них не знает:
         *
         *  - проверочный: человек нажимал «тестовый будильник через минуту»,
         *    открывал день — и будильник молча не срабатывал;
         *  - отложенный кнопкой «Отложить»: его исходное время уже прошло,
         *    поэтому в присланном списке его нет вовсе. Человек откладывал
         *    напоминание на пять минут, за эти пять минут открывал приложение —
         *    и будильник больше не звонил никогда.
         *
         * Оба остаются, пока их время в будущем и пока веб-часть не прислала
         * строку с тем же номером: присланная — это правка расписания, и она
         * старше местной перестановки.
         */
        val now = System.currentTimeMillis()
        val keepLocal = AlarmStore.load(ctx).filter {
            (it.id == TEST_ALARM_ID || it.snoozed) && it.fireAt > now &&
                incoming.none { n -> n.id == it.id }
        }
        val alarms = incoming + keepLocal

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

        fireMissed(ctx, alarms, now)
    }

    /**
     * Переставить готовый список, ничего не досочиняя.
     *
     * Отличие от [scheduleAll] в том, чего здесь нет: за пропущенные не звоним.
     * Нужно это смене пояса и переводу часов — они могут отправить будущий
     * будильник в прошлое, и звонок «за пропущенный» разбудил бы человека в
     * самолёте. После включения телефона такой звонок нужен, после перелёта —
     * нет. Список здесь уже готов (пересчитан), поэтому и «оставить местное»
     * тоже не наше дело.
     */
    fun rearm(ctx: Context, alarms: List<Alarm>) {
        cancelAll(ctx, AlarmStore.load(ctx))
        AlarmStore.save(ctx, alarms)
        if (!AlarmStore.isEnabled(ctx)) {
            Log.i(TAG, "REARMED будильники выключены в настройках — ничего не ставим")
            return
        }
        val now = System.currentTimeMillis()
        alarms.filter { it.fireAt > now }.forEach { schedule(ctx, it) }
        Log.i(TAG, "REARMED переставлено: ${alarms.count { it.fireAt > now }}")
    }

    /**
     * Пропущенный будильник звонит сразу.
     *
     * Самый обидный случай: человек выключил телефон на ночь, будильник должен
     * был прозвенеть в 07:00, а телефон включили в 07:05. Система про этот
     * будильник уже забыла — её будильники живут только до перезагрузки, — а
     * планировщик отбрасывал его как прошедший. Человек просто не просыпался, и
     * приложение об этом даже не сообщало.
     *
     * Окно — полчаса. Дольше нельзя: будильник, зазвонивший в полдень за
     * утренний подъём, — не помощь, а недоумение. О таком говорим спокойным
     * уведомлением: человек хотя бы узнает, что телефон его подвёл, а не решит,
     * что подвело приложение.
     *
     * Отметка `markFired` обязательна: список приходит из веб-части при каждой
     * синхронизации, и без неё прошедший будильник звонил бы при каждом
     * открытии приложения.
     */
    private fun fireMissed(ctx: Context, alarms: List<Alarm>, now: Long) {
        val missed = alarms.filter {
            it.isAlarm && it.fireAt <= now && !AlarmStore.hasFired(ctx, it.id, it.fireAt)
        }
        if (missed.isEmpty()) return

        val recent = missed.filter { now - it.fireAt <= MISSED_WINDOW_MS }.maxByOrNull { it.fireAt }
        if (recent != null) {
            Log.i(TAG, "MISSED звоню за пропущенный будильник ${recent.id}, " +
                "опоздание ${(now - recent.fireAt) / 1000} с")
            AlarmStore.markFired(ctx, recent.id, recent.fireAt)
            val svc = Intent(ctx, AlarmService::class.java).apply {
                action = AlarmService.ACTION_START
                putExtra("alarmId", recent.id)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc)
                else ctx.startService(svc)
            } catch (e: Exception) {
                /*
                 * Отказ в запуске службы — не повод падать: этот код работает в
                 * приёмнике загрузки, и исключение здесь уронило бы приложение
                 * сразу после включения телефона. Раз дозвонить не удалось,
                 * говорим то же, что и о слишком старых: будильник не прозвенел.
                 */
                Log.e(TAG, "Пропущенный будильник не зазвонил: " + e.message)
                tellMissed(ctx, recent, now)
            }
        }

        // о слишком старых просто сообщаем и больше о них не вспоминаем
        for (old in missed.filter { now - it.fireAt > MISSED_WINDOW_MS }) {
            AlarmStore.markFired(ctx, old.id, old.fireAt)
            tellMissed(ctx, old, now)
        }
    }

    /** Спокойное уведомление: будильник не прозвенел, потому что телефон был выключен. */
    private fun tellMissed(ctx: Context, alarm: Alarm, now: Long) {
        AlarmService.createChannels(ctx)
        val hours = (now - alarm.fireAt) / 3_600_000
        val late = if (hours >= 1) "$hours ч назад" else "меньше часа назад"
        Log.i(TAG, "MISSED_OLD сообщаю о пропущенном ${alarm.id}, опоздание $late")
        val note = NotificationCompat.Builder(ctx, AlarmService.CHANNEL_NOTIFY)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Будильник не прозвенел")
            .setContentText("${alarm.title.ifBlank { "Будильник" }} — $late. Телефон был выключен")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "${alarm.title.ifBlank { "Будильник" }} должен был прозвенеть $late, " +
                    "но телефон в это время был выключен.",
            ))
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(ctx).notify(alarm.id.toInt(), note)
    }

    /** Насколько опоздавший будильник ещё имеет смысл. */
    private const val MISSED_WINDOW_MS = 30 * 60 * 1000L

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

    /**
     * Куда ведёт нажатие на системную иконку будильника в часах.
     *
     * До первой разблокировки его нет и быть не может: главный экран
     * приложения — вебвью, он не directBootAware, и система в этом состоянии
     * запуск обычной активности не отдаёт — `getLaunchIntentForPackage`
     * возвращает null. Раньше этот null уходил в `PendingIntent.getActivity`, а
     * тот падал с NullPointerException — то есть приёмник, разбуженный
     * LOCKED_BOOT_COMPLETED, ронял приложение и не ставил ни одного будильника.
     * Ровно в том случае, для которого всё это и делалось.
     *
     * `AlarmClockInfo` пустой showIntent принимает: сам звонок от него не
     * зависит, теряется только переход в приложение из системных часов — и
     * только до разблокировки.
     */
    private fun openAppIntent(ctx: Context): PendingIntent? {
        val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
        return PendingIntent.getActivity(
            ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
