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

        val svc = Intent(ctx, AlarmService::class.java).apply {
            action = AlarmService.ACTION_START
            putExtra("alarmId", id)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc)
        else ctx.startService(svc)
    }
}
