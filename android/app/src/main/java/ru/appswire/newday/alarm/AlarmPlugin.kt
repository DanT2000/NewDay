package ru.appswire.newday.alarm

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray

/**
 * Мост между веб-частью и системными будильниками.
 *
 * Веб знает расписание, Android — как разбудить. Плагин переносит первое
 * во второе и честно отвечает, каких разрешений не хватает: молча
 * не сработавший будильник хуже, чем предупреждение заранее.
 */
@CapacitorPlugin(name = "NewDayAlarm")
class AlarmPlugin : Plugin() {

    /** Заменяет весь список будильников на присланный. */
    @PluginMethod
    fun schedule(call: PluginCall) {
        val arr: JSONArray = call.getArray("alarms") ?: JSONArray()
        val alarms = Alarm.listFromJson(arr)
        call.getObject("config")?.let { AlarmStore.saveConfig(context, DismissConfig.fromJson(it)) }
        call.getBoolean("enabled")?.let { AlarmStore.setEnabled(context, it) }

        AlarmService.createChannels(context)
        AlarmScheduler.scheduleAll(context, alarms)

        val now = System.currentTimeMillis()
        call.resolve(
            JSObject()
                .put("scheduled", alarms.count { it.fireAt > now })
                .put("skippedPast", alarms.count { it.fireAt <= now }),
        )
    }

    /**
     * Меняет только настройки отключения, не трогая список будильников.
     *
     * Нужно экрану настроек: правка «мягкого начала» не повод перечитывать день
     * и переставлять всё заново. Раньше настройки уезжали через schedule, и
     * сохранение настройки при отсутствии сети снимало уже стоящие будильники.
     */
    @PluginMethod
    fun setConfig(call: PluginCall) {
        val cfg = DismissConfig.fromJson(call.getObject("config") ?: JSObject())
        AlarmStore.saveConfig(context, cfg)
        call.getBoolean("enabled")?.let { AlarmStore.setEnabled(context, it) }
        call.resolve(JSObject().put("config", cfg.toJson()))
    }

    @PluginMethod
    fun cancelAll(call: PluginCall) {
        AlarmScheduler.cancelAll(context, AlarmStore.load(context))
        AlarmStore.save(context, emptyList())
        call.resolve()
    }

    @PluginMethod
    fun list(call: PluginCall) {
        val arr = JSONArray()
        AlarmStore.load(context).forEach { arr.put(it.toJson()) }
        call.resolve(JSObject().put("alarms", arr).put("enabled", AlarmStore.isEnabled(context)))
    }

    /**
     * Состояние всех разрешений, от которых зависит будильник.
     * Каждый пункт веб-часть показывает отдельной строкой с кнопкой «Исправить».
     *
     * Имя не checkPermissions: так называется метод базового класса Capacitor.
     */
    @PluginMethod
    fun checkAlarmPermissions(call: PluginCall) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager

        val exact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.canScheduleExactAlarms() else true
        val battery = pm.isIgnoringBatteryOptimizations(context.packageName)
        val notifications = nm.areNotificationsEnabled()
        val fullScreen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            nm.canUseFullScreenIntent()
        } else true

        // Без разрешения «поверх других приложений» экран будильника не поднимется,
        // когда телефон разблокирован и им пользуются
        val overlay = Settings.canDrawOverlays(context)

        call.resolve(
            JSObject()
                .put("notifications", notifications)
                .put("overlay", overlay)
                .put("exactAlarm", exact)
                .put("batteryUnrestricted", battery)
                .put("fullScreenIntent", fullScreen)
                .put("manufacturer", Build.MANUFACTURER)
                .put("sdk", Build.VERSION.SDK_INT)
                // на этих оболочках автозапуск режется отдельно от системных разрешений
                .put(
                    "needsVendorAutostart",
                    Build.MANUFACTURER.lowercase() in
                        listOf("xiaomi", "redmi", "poco", "huawei", "honor", "oppo", "vivo", "realme", "meizu"),
                ),
        )
    }

    /** Открывает ровно тот системный экран, где чинится конкретный пункт. */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        val what = call.getString("what") ?: "app"
        val intent = when (what) {
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

            "exactAlarm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + context.packageName))
            } else appDetails()

            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)

            "overlay" -> Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + context.packageName),
            )

            "fullScreenIntent" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + context.packageName))
            } else appDetails()

            else -> appDetails()
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            call.resolve(JSObject().put("opened", true))
        } catch (e: Exception) {
            // не на всех оболочках эти экраны существуют — открываем карточку приложения
            try {
                context.startActivity(appDetails().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(JSObject().put("opened", true).put("fallback", true))
            } catch (e2: Exception) {
                call.reject("Не удалось открыть настройки: " + e2.message)
            }
        }
    }

    private fun appDetails() = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:" + context.packageName),
    )

    /**
     * Проверочный будильник. Единственный способ убедиться, что он реально
     * сработает на этом конкретном телефоне, — дать ему сработать.
     */
    @PluginMethod
    fun testAlarm(call: PluginCall) {
        val delaySec = call.getInt("delaySec") ?: 60
        val test = Alarm(
            id = AlarmScheduler.TEST_ALARM_ID,
            fireAt = System.currentTimeMillis() + delaySec * 1000L,
            title = "⏰ Проверка будильника",
            body = "Если вы это видите и слышите — будильник работает.",
            kind = "alarm",
            profile = call.getString("profile") ?: "gentle",
            date = "",
        )
        AlarmService.createChannels(context)
        AlarmStore.save(context, AlarmStore.load(context).filter { it.id != test.id } + test)
        AlarmScheduler.schedule(context, test)
        call.resolve(JSObject().put("fireAt", test.fireAt))
    }

    @PluginMethod
    fun stopAlarm(call: PluginCall) {
        context.startService(
            Intent(context, AlarmService::class.java).apply { action = AlarmService.ACTION_STOP },
        )
        call.resolve()
    }
}
