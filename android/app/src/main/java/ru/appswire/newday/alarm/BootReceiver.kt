package ru.appswire.newday.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * После перезагрузки телефона система забывает все будильники.
 * Ставим их заново из локального хранилища — иначе человек,
 * перезагрузивший телефон вечером, утром не проснётся.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != "android.intent.action.QUICKBOOT_POWERON") return

        AlarmStore.prune(ctx)
        val alarms = AlarmStore.load(ctx)
        Log.i("NewDayAlarm", "После загрузки восстанавливаю будильников: ${alarms.size}")
        AlarmScheduler.scheduleAll(ctx, alarms)
    }
}
