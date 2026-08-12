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
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
        /*
         * Отметку местного времени ставим здесь, а не в планировщике.
         *
         * Это единственное место, куда приходит расписание из веб-части, — то
         * есть единственное, где известно, что будильник действительно должен
         * звонить в это местное время. Планировщик зовут ещё и после
         * перезагрузки: размечать там значило бы переписать «07:00» тем
         * временем, которое получилось после смены пояса, и следующая смена
         * увезла бы будильник ещё дальше.
         */
        val alarms = TimeShift.stampAll(Alarm.listFromJson(arr))
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
        // Через Compat, а не nm.areNotificationsEnabled(): тот появился только в
        // Android 7, а minSdk у нас 23 — на Android 6 экран разрешений падал бы
        // с NoSuchMethodError, не показав ни одной строки
        val notifications = NotificationManagerCompat.from(context).areNotificationsEnabled()
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

            /*
             * Автозапуск. Своего экрана в Android нет вовсе: это выдумка
             * оболочек. На Xiaomi, Huawei, Oppo, Vivo приложение без него
             * система выгружает целиком, и будильник не звонит — самая частая
             * причина «поставил, а он молчит».
             */
            "autostart" -> vendorIntent(AUTOSTART) ?: appDetails()

            // Xiaomi: «Другие разрешения» — там живёт показ окон из фона,
            // без которого экран будильника не поднимается
            "vendorExtra" -> vendorIntent(EXTRA_PERMS) ?: appDetails()

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

    /*
     * Экраны оболочек производителей.
     *
     * У Xiaomi, Huawei, Oppo, Vivo, Samsung есть свои списки — автозапуск,
     * «другие разрешения», защищённые приложения, — и без них будильник не
     * звонит: система выгружает приложение целиком. Стандартного способа туда
     * попасть нет, в Android этих экранов не существует; остаются точные адреса
     * активностей. Они меняются между версиями оболочек, поэтому берём первый,
     * который вообще существует на этом телефоне, а не первый в списке.
     *
     * Проверяем через resolveActivity: неизвестная активность даёт не отказ, а
     * падение ActivityNotFoundException — и человек вместо настроек получил бы
     * закрывшееся приложение.
     */
    private val AUTOSTART = listOf(
        "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
        "com.letv.android.letvsafe/.AutobootManageActivity",
        "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
        "com.huawei.systemmanager/.optimize.process.ProtectActivity",
        "com.coloros.safecenter/.permission.startup.StartupAppListActivity",
        "com.coloros.safecenter/.startupapp.StartupAppListActivity",
        "com.oppo.safe/.permission.startup.StartupAppListActivity",
        "com.iqoo.secure/.ui.phoneoptimize.AddWhiteListActivity",
        "com.vivo.permissionmanager/.activity.BgStartUpManagerActivity",
        "com.samsung.android.lool/com.samsung.android.sm.ui.battery.BatteryActivity",
        "com.asus.mobilemanager/.MainActivity",
    )
    private val EXTRA_PERMS = listOf(
        // Xiaomi: показ окон из фона и прочие «другие разрешения»
        "com.miui.securitycenter/com.miui.permcenter.permissions.PermissionsEditorActivity",
        "com.miui.securitycenter/com.miui.permcenter.permissions.AppPermissionsEditorActivity",
    )

    /** Первый экран из списка, который есть на этом телефоне. */
    private fun vendorIntent(candidates: List<String>): Intent? {
        for (name in candidates) {
            val parts = name.split("/")
            if (parts.size != 2) continue
            val pkg = parts[0]
            val cls = if (parts[1].startsWith(".")) pkg + parts[1] else parts[1]
            val intent = Intent().setClassName(pkg, cls)
                .putExtra("package_name", context.packageName)
                .putExtra("extra_pkgname", context.packageName)
            if (intent.resolveActivity(context.packageManager) != null) return intent
        }
        return null
    }

    /**
     * Какая это оболочка и есть ли у неё свои экраны.
     *
     * Веб-часть по этому ответу решает, показывать ли строку «Автозапуск»:
     * предлагать её там, где такого экрана нет, значит вести человека в
     * никуда. Название оболочки нужно, чтобы подписать строку словами, которые
     * он увидит на своём телефоне.
     */
    @PluginMethod
    fun vendorSettings(call: PluginCall) {
        val brand = Build.MANUFACTURER?.lowercase() ?: ""
        val shell = when {
            brand.contains("xiaomi") || brand.contains("redmi") || brand.contains("poco") -> "Xiaomi"
            brand.contains("huawei") || brand.contains("honor") -> "Huawei"
            brand.contains("oppo") || brand.contains("realme") -> "Oppo"
            brand.contains("vivo") -> "Vivo"
            brand.contains("samsung") -> "Samsung"
            brand.contains("asus") -> "Asus"
            brand.contains("letv") -> "LeEco"
            else -> ""
        }
        call.resolve(
            JSObject()
                .put("brand", Build.MANUFACTURER ?: "")
                .put("shell", shell)
                .put("autostart", vendorIntent(AUTOSTART) != null)
                .put("extraPerms", vendorIntent(EXTRA_PERMS) != null),
        )
    }

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
        // Подпись места уезжает в экран привязки: записывать её будет он же,
        // вместе со значением кода, — см. codeBound
        val intent = Intent(context, BindCodeActivity::class.java)
            .putExtra(BindCodeActivity.EXTRA_LABEL, call.getString("label").orEmpty())
        startActivityForResult(call, intent, "codeBound")
    }

    /**
     * Ответ экрана привязки.
     *
     * Сам код здесь уже не сохраняется — это делает экран привязки, и нарочно.
     * Пока камера открыта, система разрушает активность с вебвью; Capacitor
     * после этого восстанавливает вызов «висящим» (callbackId «-1»), и ответ в
     * веб-часть выбрасывается молча, а иногда вызова нет вовсе — [call] придёт
     * пустым. Сохраняли бы код здесь — в этом случае он пропадал бы весь:
     * сканирование удалось, а в настройках «код не привязан».
     *
     * Поэтому отвечаем тем, что действительно записано на устройстве, а не тем,
     * что нам передали.
     */
    @ActivityCallback
    private fun codeBound(call: PluginCall?, result: ActivityResult) {
        val scanned = result.data?.getStringExtra("code").orEmpty()
        val cfg = AlarmStore.config(context)
        val bound = scanned.isNotBlank() && cfg.qrBound
        Log.i(TAG, if (bound) "BIND_OK код привязан" else "BIND_NONE код не привязан")
        // Вызова может не быть: веб-часть за это время пережила пересоздание.
        // Терять тут нечего — состояние уже на устройстве, и настройки прочтут
        // его через missionCapabilities.
        call?.resolve(JSObject().put("bound", bound).put("label", cfg.qrLabel))
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

    /**
     * Насколько системные полосы залезают на страницу — в CSS-пикселях.
     *
     * Начиная с targetSdk 35 Android рисует приложение край-в-край и не
     * спрашивает: окно занимает весь экран, вебвью вместе с ним, и содержимое
     * уезжает под верхнюю шторку. Это и увидел владелец на телефоне.
     *
     * Одним CSS не обойтись: `env(safe-area-inset-top)` в Android WebView
     * заполняется только для выреза камеры, а обычная шторка в него не
     * попадает — на телефоне без выреза он остаётся нулём. Поэтому отступы
     * берём у системы и отдаём числами, а CSS берёт большее из двух.
     *
     * Делим на плотность: у системы отступы в пикселях устройства, у CSS — в
     * своих. Без деления на экране с плотностью 3 отступ вышел бы втрое больше.
     */
    @PluginMethod
    fun systemInsets(call: PluginCall) {
        val act = activity ?: run {
            call.resolve(JSObject().put("known", false))
            return
        }
        act.runOnUiThread {
            val insets = act.window?.decorView?.let { ViewCompat.getRootWindowInsets(it) }
            if (insets == null) {
                // Окно ещё не прикреплено. Честное «не знаю» лучше выдуманного
                // числа: веб-часть спросит снова.
                call.resolve(JSObject().put("known", false))
                return@runOnUiThread
            }
            /*
             * Полосы и вырез вместе: на телефоне с «капелькой» шторка тонкая, а
             * вырез выше её, и по одним systemBars содержимое всё равно попало
             * бы под камеру.
             */
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val d = act.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
            call.resolve(
                JSObject()
                    .put("known", true)
                    .put("top", (bars.top / d).toInt())
                    .put("bottom", (bars.bottom / d).toInt())
                    .put("left", (bars.left / d).toInt())
                    .put("right", (bars.right / d).toInt()),
            )
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
        private const val TAG = "NewDayAlarm"
    }
}
