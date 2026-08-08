package ru.appswire.newday.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.util.TimeZone

/**
 * Системные события, после которых будильники надо ставить заново.
 *
 * Перезагрузка: система забывает все будильники, восстанавливаем их из
 * локального хранилища — иначе человек, перезагрузивший телефон вечером, утром
 * не проснётся.
 *
 * LOCKED_BOOT_COMPLETED — не то же самое, что BOOT_COMPLETED, и без него
 * половина случаев не покрыта. На телефонах с шифрованием файлов (почти всё,
 * начиная с Android 10) BOOT_COMPLETED приходит только после первой
 * разблокировки. Телефон, перезагрузившийся сам в три ночи — обновление
 * системы, паника ядра, — до утра никто не разблокирует, и в семь будильника
 * нет вообще: заново его никто не поставил. LOCKED_BOOT_COMPLETED приходит
 * сразу после загрузки, ещё до пина, и вместе с device-protected хранилищем
 * (см. [AlarmStore]) этого достаточно, чтобы поставить всё заново.
 *
 * Смена пояса и перевод часов: будильники стоят по абсолютному времени, и
 * «подъём в 07:00» после перелёта звонит по прежнему поясу. Пересчитываем на то
 * же местное время (см. [TimeShift]).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action ?: return
        /*
         * Ни одно исключение отсюда не должно уйти наружу.
         *
         * Приёмник работает в самый неудачный момент — сразу после включения
         * телефона, до разблокировки, — и любое падение здесь означает не
         * только окно «приложение остановлено», но и не поставленные
         * будильники: человек просто не просыпается.
         */
        try {
            when (action) {
                Intent.ACTION_BOOT_COMPLETED,
                Intent.ACTION_LOCKED_BOOT_COMPLETED,
                Intent.ACTION_MY_PACKAGE_REPLACED,
                "android.intent.action.QUICKBOOT_POWERON" -> afterBoot(ctx, action)

                Intent.ACTION_TIMEZONE_CHANGED,
                Intent.ACTION_TIME_CHANGED -> afterClockChange(ctx, action)

                else -> return
            }
        } catch (e: Exception) {
            Log.e(TAG, "Восстановление будильников по «$action» сорвалось: " + e.message)
        }
    }

    private fun afterBoot(ctx: Context, action: String) {
        AlarmStore.prune(ctx)
        // Пояс мог поменяться, пока телефон был выключен: человек летел, а
        // телефон в самолёте лежал в сумке. Пересчитываем до постановки.
        val shift = TimeShift.recompute(AlarmStore.load(ctx), zoneNow())
        Log.i(
            TAG,
            "После загрузки ($action) восстанавливаю будильников: ${shift.alarms.size}" +
                if (shift.moved > 0) ", по новому поясу переехало ${shift.moved}" else "",
        )
        AlarmScheduler.scheduleAll(ctx, shift.alarms)
    }

    /**
     * Пояс сменился или часы перевели.
     *
     * Переставляем через [AlarmScheduler.rearm], а не через scheduleAll:
     * пересчёт может отправить будущий будильник в прошлое, а логика
     * пропущенных зазвонила бы за него сразу — то есть разбудила человека в
     * самолёте. После перезагрузки такой звонок нужен, после перелёта — нет.
     */
    private fun afterClockChange(ctx: Context, action: String) {
        val shift = TimeShift.recompute(AlarmStore.load(ctx), zoneNow())
        Log.i(
            TAG,
            "TZ_SHIFT «$action»: пояс ${zoneNow().id}, переехало ${shift.moved}, " +
                "оставлено прошедшими ${shift.past}",
        )
        if (shift.moved == 0) {
            // Ничего не переехало — переставлять нечего: часы могло подвинуть
            // на секунду сверкой времени по сети, и снимать-ставить весь список
            // из-за этого незачем.
            return
        }
        AlarmScheduler.rearm(ctx, shift.alarms)
    }

    /**
     * Пояс читаем заново.
     *
     * Система рассылает и широковещание, и отдельное указание процессам сбросить
     * кэш пояса, но порядок между ними не обещан: приёмник может проснуться
     * раньше, чем кэш сброшен, и пересчитать будильники в прежний пояс — то
     * есть не сделать ничего. setDefault(null) заставляет прочитать пояс из
     * системы: ровно это делает и сам фреймворк.
     */
    private fun zoneNow(): TimeZone {
        try {
            TimeZone.setDefault(null)
        } catch (e: Exception) {
            Log.e(TAG, "Не удалось сбросить кэш пояса: " + e.message)
        }
        return TimeZone.getDefault()
    }

    private companion object {
        const val TAG = "NewDayAlarm"
    }
}
