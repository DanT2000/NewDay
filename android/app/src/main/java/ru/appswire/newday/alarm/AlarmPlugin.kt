package ru.appswire.newday.alarm

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONArray

/**
 * Мост между веб-частью и системными будильниками.
 *
 * Веб знает расписание, Android — как разбудить. Плагин переносит первое
 * во второе и честно отвечает, каких разрешений не хватает: молча
 * не сработавший будильник хуже, чем предупреждение заранее.
 */
@CapacitorPlugin(
    name = "NewDayAlarm",
    permissions = [
        Permission(strings = [android.Manifest.permission.CAMERA], alias = "camera"),
        Permission(strings = [android.Manifest.permission.ACTIVITY_RECOGNITION], alias = "steps"),
    ],
)
class AlarmPlugin : Plugin() {

    /** Заменяет весь список будильников на присланный. */
    @PluginMethod
    fun schedule(call: PluginCall) {
        val arr: JSONArray = call.getArray("alarms") ?: JSONArray()
        val alarms = Alarm.listFromJson(arr)
        call.getObject("config")?.let { AlarmStore.saveConfig(context, incoming(it)) }
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
        val cfg = incoming(call.getObject("config") ?: JSObject())
        AlarmStore.saveConfig(context, cfg)
        call.getBoolean("enabled")?.let { AlarmStore.setEnabled(context, it) }
        // в ответ значение кода не кладём: оно не покидает телефон, а всё,
        // что дошло до JS, может оказаться в логах или в синхронизации
        call.resolve(JSObject().put("config", cfg.copy(qrValue = "").toJson()))
    }

    /**
     * Настройки из веб-части, сшитые с тем, что живёт только на телефоне.
     *
     * Значение привязанного кода веб не знает и знать не должен: оно не уезжает
     * ни на сервер, ни в синхронизацию. Но `fromJson` на отсутствующий ключ
     * ставит пустую строку — и любое сохранение настроек стирало бы привязку.
     * Человек привязал код вечером, утром подвинул «мягкое начало» — и код
     * пропал. Поэтому отсутствие ключа означает «не трогать сохранённое».
     *
     * Явно присланный ключ — намерение, и он проходит: так проверочный прогон
     * ставит код без камеры, а в будущем тем же путём можно перенести привязку
     * с телефона на телефон.
     */
    private fun incoming(obj: JSObject): DismissConfig {
        val parsed = DismissConfig.fromJson(obj)
        if (obj.has("qrValue")) return parsed
        return parsed.copy(qrValue = AlarmStore.config(context).qrValue)
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

    /**
     * Что вообще возможно на этом телефоне.
     *
     * Веб-часть без этого предлагала бы «шаги» на телефоне без шагомера, а
     * человек получал бы вместо шагов пример и решил, что настройка не
     * сохраняется. Лучше не предлагать вовсе и сказать почему.
     */
    @PluginMethod
    fun missionCapabilities(call: PluginCall) {
        val cfg = AlarmStore.config(context)
        call.resolve(
            JSObject()
                .put("camera", CodeScanner.hasCamera(context))
                .put("cameraGranted", CodeScanner.hasPermission(context))
                .put("stepSensor", StepCounter.sensorPresent(context))
                .put("stepsGranted", StepCounter(context).available)
                // сам код наружу не отдаём: веб-части он не нужен, а в
                // синхронизацию и логи попадать ему незачем
                .put("qrBound", cfg.qrBound)
                .put("qrLabel", cfg.qrLabel),
        )
    }

    /**
     * Привязать код: открывает сканер и запоминает то, что он прочитал.
     *
     * Значение хранится только на телефоне. На сервер его не отправляем: код с
     * чайника не нужен ни синхронизации, ни веб-версии, а всё лишнее, что уехало
     * наружу, однажды оттуда утечёт.
     */
    @PluginMethod
    fun bindCode(call: PluginCall) {
        if (!CodeScanner.hasCamera(context)) {
            call.reject("На этом телефоне нет камеры — код привязать нечем")
            return
        }
        val intent = Intent(context, BindCodeActivity::class.java)
        startActivityForResult(call, intent, "codeBound")
    }

    @ActivityCallback
    private fun codeBound(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val code = result.data?.getStringExtra("code").orEmpty()
        if (code.isBlank()) {
            call.resolve(JSObject().put("bound", false))
            return
        }
        val label = call.getString("label").orEmpty()
        AlarmStore.saveConfig(
            context,
            AlarmStore.config(context).copy(qrValue = code, qrLabel = label),
        )
        call.resolve(JSObject().put("bound", true).put("label", label))
    }

    /** Отвязать код: задача «QR» после этого сама станет математикой. */
    @PluginMethod
    fun unbindCode(call: PluginCall) {
        AlarmStore.saveConfig(context, AlarmStore.config(context).copy(qrValue = "", qrLabel = ""))
        call.resolve(JSObject().put("bound", false))
    }

    /**
     * Подпись места остаётся в настройках отдельно: её человек правит текстом,
     * не пересканируя код.
     */
    @PluginMethod
    fun setCodeLabel(call: PluginCall) {
        val label = call.getString("label").orEmpty()
        AlarmStore.saveConfig(context, AlarmStore.config(context).copy(qrLabel = label))
        call.resolve(JSObject().put("label", label))
    }

    /**
     * Разрешения камеры и распознавания активности спрашиваются на месте.
     *
     * Только через алиасы аннотации и requestPermissionForAlias: свой
     * requestPermissions с переопределением handleRequestPermissionsResult
     * в Capacitor 5 не работает — Bridge зовёт этот метод лишь у плагинов
     * старого образца, и ответ на системный диалог уходил бы в никуда, а
     * промис в JS висел бы вечно.
     */
    @PluginMethod
    fun requestMissionPermission(call: PluginCall) {
        val what = call.getString("what") ?: "camera"
        // до Android 10 распознавание активности не спрашивается,
        // до Android 6 разрешения выдаются при установке
        val askable = when (what) {
            "steps" -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            else -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
        }
        if (!askable) {
            call.resolve(JSObject().put("granted", true).put("what", what))
            return
        }
        requestPermissionForAlias(if (what == "steps") "steps" else "camera", call, "missionPermDone")
    }

    @PermissionCallback
    private fun missionPermDone(call: PluginCall) {
        val what = call.getString("what") ?: "camera"
        val granted = getPermissionState(if (what == "steps") "steps" else "camera") ==
            com.getcapacitor.PermissionState.GRANTED
        call.resolve(JSObject().put("granted", granted).put("what", what))
    }

    /**
     * Красит системные полосы — статусбар и полосу жестов — под тему приложения.
     *
     * Стартовые цвета задаёт styles.xml, но он следует за темой телефона,
     * а человек может выбрать в приложении противоположную — тогда полосы
     * остаются чужого цвета. Веб-часть зовёт этот метод при каждой смене
     * темы, и полосы догоняют её.
     */
    @PluginMethod
    fun setSystemBars(call: PluginCall) {
        // Активности может не быть: вызов пришёл, когда она уже разрушена или
        // ещё не поднялась. Это не ошибка — следующая смена темы докрасит,
        // поэтому отвечаем честным «не применилось», а не отказом.
        val act = activity ?: run {
            call.resolve(JSObject().put("applied", false))
            return
        }
        val raw = call.getString("color") ?: ""
        val color = try {
            Color.parseColor(raw)
        } catch (e: Exception) {
            // parseColor на пустую строку кидает не IllegalArgument, а выход
            // за границы строки — поэтому ловим шире, чем хотелось бы
            call.reject("Ожидался цвет вида #rrggbb, пришло: «$raw»")
            return
        }
        val dark = call.getBoolean("dark") ?: false
        // Окно можно трогать только с главного потока,
        // а вызовы плагина приходят с потока моста
        act.runOnUiThread {
            val window = act.window
            window.statusBarColor = color
            window.navigationBarColor = color
            // Значки: тёмные на светлом фоне и наоборот. Compat сам знает,
            // с какого API какая полоса умеет тёмные значки, — где не умеет,
            // просто ничего не делает
            WindowInsetsControllerCompat(window, window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
            call.resolve(JSObject().put("applied", true))
        }
    }

    @PluginMethod
    fun stopAlarm(call: PluginCall) {
        context.startService(
            Intent(context, AlarmService::class.java).apply { action = AlarmService.ACTION_STOP },
        )
        call.resolve()
    }

    /**
     * Кладёт свой звук будильника на устройство.
     *
     * Будильник звонит из только что поднятого процесса, часто без сети —
     * тянуть файл с сервера в этот момент нечем и неоткуда. Поэтому веб-часть
     * при выборе своего звука заранее привозит его сюда целиком, base64 через
     * мост: десять мегабайт — это терпимые ~13 МБ строки на один раз.
     */
    @PluginMethod
    fun saveSound(call: PluginCall) {
        val file = call.getString("file")?.takeIf { it.isNotBlank() && !it.contains('/') && !it.contains("..") }
            ?: run { call.reject("Нужно имя файла без пути"); return }
        val base64 = call.getString("base64") ?: run { call.reject("Пустой файл"); return }
        try {
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            val dir = java.io.File(filesDirOf(), "sounds").apply { mkdirs() }
            java.io.File(dir, file).writeBytes(bytes)
            call.resolve(JSObject().put("saved", true).put("sizeBytes", bytes.size))
        } catch (e: Exception) {
            call.reject("Звук не сохранился: " + e.message)
        }
    }

    /** Есть ли такой свой звук на устройстве — чтобы не возить 10 МБ зря. */
    @PluginMethod
    fun hasSound(call: PluginCall) {
        val file = call.getString("file")?.takeIf { it.isNotBlank() && !it.contains('/') && !it.contains("..") }
            ?: run { call.reject("Нужно имя файла без пути"); return }
        val f = java.io.File(java.io.File(filesDirOf(), "sounds"), file)
        call.resolve(JSObject().put("exists", f.isFile))
    }

    @PluginMethod
    fun removeSound(call: PluginCall) {
        val file = call.getString("file")?.takeIf { it.isNotBlank() && !it.contains('/') && !it.contains("..") }
            ?: run { call.reject("Нужно имя файла без пути"); return }
        val f = java.io.File(java.io.File(filesDirOf(), "sounds"), file)
        call.resolve(JSObject().put("removed", f.delete()))
    }

    private fun filesDirOf(): java.io.File = context.filesDir

    companion object {
        private const val REQ_MISSION = 4712
    }
}
