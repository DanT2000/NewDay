package ru.appswire.newday.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Приёмник срабатывания. Работает считанные миллисекунды: его задача —
 * поднять foreground-сервис, который уже держит звук и экран.
 * Делать всё прямо здесь нельзя: систему процесс не обязана держать живым.
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getLongExtra("alarmId", -1)
        Log.i("NewDayAlarm", "Сработал будильник $id")
        if (id < 0) return

        val alarm = AlarmStore.find(ctx, id) ?: run {
            Log.w("NewDayAlarm", "Будильник $id не найден в хранилище")
            return
        }

        /*
         * Отмечаем, что он отработал. Без этого перезагрузка или синхронизация
         * сочли бы его пропущенным и позвонили бы второй раз за то же самое.
         */
        AlarmStore.markFired(ctx, alarm.id, alarm.fireAt)

        val svc = Intent(ctx, AlarmService::class.java).apply {
            action = AlarmService.ACTION_START
            putExtra("alarmId", id)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc)
            else ctx.startService(svc)
        } catch (e: Exception) {
            /*
             * Система может отказать в запуске службы из фона.
             *
             * С Android 12 право поднять foreground-службу из фона даёт именно
             * точный будильник; если человек отключил точные будильники, звонок
             * приходит неточным — и отказ роняет приёмник вместе с приложением,
             * а будильник при этом уже помечен отработавшим и пропадает молча.
             *
             * Поэтому не падаем, а снимаем отметку: логика пропущенных
             * подхватит этот будильник после перезагрузки — или зазвонит, если
             * прошло меньше получаса, или хотя бы скажет, что он не прозвенел.
             */
            Log.e("NewDayAlarm", "Служба будильника не запустилась: " + e.message)
            AlarmStore.unmarkFired(ctx, alarm.id, alarm.fireAt)
        }
    }
}
