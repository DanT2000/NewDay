package ru.appswire.newday.alarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Сервис, который держит будильник живым.
 *
 * Почему именно так:
 *  - foreground-сервис — система не убьёт процесс, пока звонит будильник;
 *  - STREAM_ALARM — единственный поток, который звучит в беззвучном режиме
 *    и при «Не беспокоить»;
 *  - full-screen intent — экран включается и показывает окно поверх локскрина;
 *  - WakeLock — экран не гаснет, пока человек решает задачу.
 */
class AlarmService : Service() {

    companion object {
        const val ACTION_START = "ru.appswire.newday.ALARM_START"
        const val ACTION_STOP = "ru.appswire.newday.ALARM_STOP"
        const val ACTION_SNOOZE = "ru.appswire.newday.ALARM_SNOOZE"

        const val CHANNEL_ALARM = "newday_alarm"
        const val CHANNEL_NOTIFY = "newday_notify"
        /*
         * Номер уведомления звонящего будильника — заведомо вне диапазона
         * номеров строк расписания.
         *
         * Напоминания показываются под своим номером (номер строки), и
         * прежнее значение 4201 однажды совпало бы с настоящей строкой:
         * напоминание подменило бы собой уведомление звонящего будильника
         * вместе с его full-screen intent — экран отключения перестал бы
         * подниматься. Строк с таким номером просто не бывает.
         */
        private const val NOTIFICATION_ID = 1_000_004_201

        /** Экран отключения спрашивает у сервиса, что именно звонит. */
        @Volatile
        var currentAlarmId: Long = -1
            private set

        /**
         * До какого момента идёт мягкое начало (мс эпохи), 0 — его нет.
         *
         * Владелец времени — сервис, а не экран: если система не даст поднять
         * окно, тихая фаза всё равно должна закончиться и будильник — заорать.
         * Экран только читает это значение, поэтому обратный отсчёт на экране
         * совпадает с реальностью, даже если окно открылось с задержкой.
         */
        @Volatile
        var graceUntilMs: Long = 0L
            private set

        fun createChannels(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(NotificationManager::class.java)

            val alarm = NotificationChannel(
                CHANNEL_ALARM, "Будильники", NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Подъём и важные события. Звучит даже в беззвучном режиме."
                setSound(null, null)        // звук проигрывает сервис сам
                enableVibration(false)      // вибрацией тоже управляем сами
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setBypassDnd(true)          // пробивает «Не беспокоить»
            }
            val notify = NotificationChannel(
                CHANNEL_NOTIFY, "Напоминания", NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Напоминания о делах из расписания." }

            nm.createNotificationChannel(alarm)
            nm.createNotificationChannel(notify)
        }
    }

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var rampHandler: Handler? = null
    private var alarm: Alarm? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopEverything(); return START_NOT_STICKY }
            ACTION_SNOOZE -> { snooze(); return START_NOT_STICKY }
        }

        val id = intent?.getLongExtra("alarmId", -1) ?: -1
        val found = AlarmStore.find(this, id)
        if (found == null) {
            /*
             * Сюда же приходит перезапуск службы системой — с пустым intent — и
             * устаревший PendingIntent будильника, которого в списке уже нет.
             * Звонить нечему, но если будильник в этот момент звучит, глушить
             * его нельзя: stopSelf() снял бы звук с уже открытого экрана
             * отключения, и выключать стало бы нечего.
             */
            keepRinging()?.let { return it }
            stopSelf()
            return START_NOT_STICKY
        }

        createChannels(this)
        if (!found.isAlarm) return showReminder(found)

        /*
         * Второй будильник приходит в уже живую службу.
         *
         * Два будильника на одну минуту — обычное дело, и раньше второй просто
         * перезаписывал `player`: первый плеер продолжал играть, а
         * `stopEverything` отпускал только последний. Оставшийся звук не
         * выключался уже ничем, кроме смерти процесса. Тот же счёт у wakelock и
         * вибрации, поэтому отпускаем всё разом.
         */
        releasePlayback()

        alarm = found
        currentAlarmId = id
        startAlarmForeground(buildNotification(found))

        val cfg = AlarmStore.config(this)
        val grace = cfg.effectiveGraceSec
        graceUntilMs = if (grace > 0) System.currentTimeMillis() + grace * 1000L else 0L
        acquireWakeLock()
        startSound(found)
        startVibration(found, gentle = grace > 0)
        launchDismissScreen(found)

        /*
         * REDELIVER, а не STICKY.
         *
         * Службу, убитую нехваткой памяти, STICKY поднимает с пустым intent:
         * будильника в нём нет, служба сама себя останавливает — и человек не
         * просыпается, притом что экран отключения мог даже не успеть
         * появиться. REDELIVER возвращает тот же intent, и будильник звонит
         * дальше.
         */
        return START_REDELIVER_INTENT
    }

    /**
     * Обычное напоминание: своё уведомление, и всё.
     *
     * Уведомлением foreground-службы оно быть не может, хотя раньше было им:
     * служба показывала напоминание и тут же останавливалась, а
     * `stopForeground(STOP_FOREGROUND_REMOVE)` снимал его в ту же секунду —
     * напоминание не видел никто. Хуже другое: напоминание, пришедшее в минуту
     * подъёма, вешалось на тот же номер уведомления, подменяло собой
     * уведомление звонящего будильника (вместе с его full-screen intent) и
     * своим `stopSelf()` глушило сам будильник.
     */
    private fun showReminder(a: Alarm): Int {
        NotificationManagerCompat.from(this).notify(a.id.toInt(), buildNotification(a))
        keepRinging()?.let { return it }
        stopSelf()
        return START_NOT_STICKY
    }

    /**
     * Будильник в это время звучит — служба остаётся как есть.
     *
     * Возвращает код возврата для onStartCommand или null, если ничего не
     * звучит. Обязательство перед `startForegroundService` закрываем
     * уведомлением звонящего будильника: подменять его чужим нельзя — вместе с
     * ним ушёл бы full-screen intent, и экран отключения перестал бы
     * подниматься.
     */
    private fun keepRinging(): Int? {
        val ringing = alarm ?: return null
        if (currentAlarmId < 0) return null
        startAlarmForeground(buildNotification(ringing))
        return START_REDELIVER_INTENT
    }

    /**
     * Тип foreground-службы указываем явно.
     *
     * С Android 15 служба, поднятая из приёмника BOOT_COMPLETED, не имеет права
     * объявить тип `mediaPlayback`: система бросает
     * ForegroundServiceStartNotAllowedException. А поднимается она оттуда
     * ровно в самом обидном случае — телефон был выключен в момент звонка, и
     * пропущенный будильник должен зазвонить сразу после включения. Вместо
     * звонка приложение падало. `specialUse` с подтипом «alarm» (он объявлен в
     * манифесте) под это ограничение не попадает.
     */
    private fun startAlarmForeground(notification: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Отказ системы поднять службу — не повод падать: уведомление с
            // full-screen intent показываем обычным способом, чтобы будильник
            // хотя бы поднял экран
            Log.e("NewDayAlarm", "Foreground-служба не поднялась: " + e.message)
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification)
        }
    }

    // ── Уведомление ──────────────────────────────────────────

    private fun buildNotification(a: Alarm): Notification {
        val builder = NotificationCompat.Builder(this, if (a.isAlarm) CHANNEL_ALARM else CHANNEL_NOTIFY)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(a.title)
            .setContentText(a.body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(
                if (a.isAlarm) NotificationCompat.CATEGORY_ALARM
                else NotificationCompat.CATEGORY_REMINDER,
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(!a.isAlarm)
            .setOngoing(a.isAlarm)

        /*
         * Куда ведёт нажатие.
         *
         * У будильника — на экран отключения; тот же PendingIntent поднимает
         * его поверх локскрина как full-screen intent. У напоминания — в само
         * приложение: экран отключения не пускает назад, пока не решена задача,
         * и человек, нажавший на «выпить воды», оказывался запертым в
         * будильнике, который даже не звонит.
         */
        if (a.isAlarm) {
            val pi = dismissScreenIntent(a)
            builder.setContentIntent(pi)
            // именно это поднимает окно поверх локскрина
            builder.setFullScreenIntent(pi, true)
        } else {
            openAppIntent()?.let { builder.setContentIntent(it) }
        }
        return builder.build()
    }

    private fun dismissScreenIntent(a: Alarm): PendingIntent {
        val full = Intent(this, AlarmActivity::class.java).apply {
            putExtra("alarmId", a.id)
            // без CLEAR_TASK: экран стартует дважды (вручную и через full-screen
            // intent), и CLEAR_TASK убивал уже открытую копию
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        return PendingIntent.getActivity(
            this, a.id.toInt(), full,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun openAppIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(
            this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    // ── Звук, вибрация, экран ────────────────────────────────

    private fun startSound(a: Alarm) {
        val cfg = AlarmStore.config(this)
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager

        // Выбранный звук лежит либо в веб-ассетах APK (встроенный набор),
        // либо в filesDir/sounds (свой, загруженный человеком). Любая ошибка
        // с файлом — и звоним системным: будильник с не тем звуком будит,
        // молчащий будильник — нет.
        player = if (cfg.soundFile.isNotBlank()) {
            openAssetPlayer(cfg.soundFile) ?: openCustomPlayer(cfg.soundFile) ?: openSystemPlayer()
        } else {
            openSystemPlayer()
        }

        val grace = cfg.effectiveGraceSec
        if (grace > 0) {
            // Тихое начало: слышно, но не подбрасывает. Кто уже встал — просто
            // выключит, кто спит — дождётся полной громкости.
            val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            am.setStreamVolume(
                AudioManager.STREAM_ALARM,
                (max * 0.15).toInt().coerceAtLeast(1), 0,
            )
            val handler = Handler(Looper.getMainLooper())
            rampHandler = handler
            handler.postDelayed({ escalate(a, cfg) }, grace * 1000L)
            Log.i("NewDayAlarm", "GRACE_START мягкое начало: " + grace + " с тихо")
        } else {
            goLoud(a, cfg, am)
        }
    }

    /**
     * Звук из ассетов APK: public/sounds/<файл> — то, что cap sync положил
     * туда из public/ репозитория. null — файл не открылся, звонить нечем.
     */
    private fun openAssetPlayer(file: String): MediaPlayer? {
        val mp = MediaPlayer()
        return try {
            assets.openFd("public/sounds/$file").use { fd ->
                mp.setDataSource(fd.fileDescriptor, fd.startOffset, fd.length)
            }
            mp.configureAndStart()
            mp
        } catch (e: Exception) {
            Log.e("NewDayAlarm", "Звук '" + file + "' не открылся: " + e.message + " — беру системный")
            mp.release()
            null
        }
    }

    /**
     * Свой звук: файл, который веб-часть заранее положила в filesDir/sounds
     * через saveSound. С сервера в момент звонка тянуть нечего — процесс
     * только что подняли, сети может не быть вовсе.
     */
    private fun openCustomPlayer(file: String): MediaPlayer? {
        val f = java.io.File(filesDir, "sounds/$file")
        if (!f.isFile) return null
        val mp = MediaPlayer()
        return try {
            mp.setDataSource(f.absolutePath)
            mp.configureAndStart()
            mp
        } catch (e: Exception) {
            Log.e("NewDayAlarm", "Свой звук '" + file + "' не открылся: " + e.message)
            mp.release()
            null
        }
    }

    private fun openSystemPlayer(): MediaPlayer? {
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        return try {
            MediaPlayer().apply {
                setDataSource(this@AlarmService, uri)
                configureAndStart()
            }
        } catch (e: Exception) {
            Log.e("NewDayAlarm", "Не удалось запустить звук: " + e.message)
            null
        }
    }

    private fun MediaPlayer.configureAndStart() {
        setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)   // звучит в беззвучном
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
        isLooping = true
        prepare()
        start()
    }

    /** Окно кончилось: громкость вверх, вибрация настойчивее, задачи обязательны. */
    private fun escalate(a: Alarm, cfg: DismissConfig) {
        if (currentAlarmId != a.id) return   // будильник уже выключили
        graceUntilMs = 0L
        Log.i("NewDayAlarm", "GRACE_END мягкое начало кончилось — будим по-настоящему")
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        goLoud(a, cfg, am)
        startVibration(a, gentle = false)
    }

    private fun goLoud(a: Alarm, cfg: DismissConfig, am: AudioManager) {
        val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        if (cfg.volumeRamp && a.isWakeup) {
            /*
             * Резкий максимум в 6 утра жесток, тихий будильник не будит —
             * поэтому громкость нарастает. За сколько именно, решает человек
             * в настройках (rampSec): «медленное пробуждение» — минута,
             * «быстрое» — пятнадцать секунд до полной громкости.
             */
            var level = (max * 0.25).toInt().coerceAtLeast(1)
            am.setStreamVolume(AudioManager.STREAM_ALARM, level, 0)
            val handler = Handler(Looper.getMainLooper())
            rampHandler = handler
            val stepsLeft = (max - level).coerceAtLeast(1)
            val stepMs = (cfg.rampSec * 1000L / stepsLeft).coerceAtLeast(500L)
            val step = object : Runnable {
                override fun run() {
                    if (level >= max) return
                    level += 1
                    am.setStreamVolume(AudioManager.STREAM_ALARM, level, 0)
                    handler.postDelayed(this, stepMs)
                }
            }
            handler.postDelayed(step, stepMs)
        } else {
            am.setStreamVolume(AudioManager.STREAM_ALARM, max, 0)
        }
    }

    /**
     * gentle — короткая деликатная вибрация мягкого начала; иначе рабочий
     * рисунок профиля. Повторный вызов заменяет предыдущий рисунок.
     */
    private fun startVibration(a: Alarm, gentle: Boolean) {
        vibrator?.cancel()
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        val pattern = when {
            gentle -> longArrayOf(0, 200, 1800)
            a.isWakeup -> longArrayOf(0, 600, 400, 600, 400)
            else -> longArrayOf(0, 300, 300)
        }
        /*
         * Вибрация тоже «будильничная», и это не украшение.
         *
         * Без AudioAttributes вибрация уходит с назначением USAGE_UNKNOWN, а
         * такие система выбрасывает при включённом «Не беспокоить» и в
         * беззвучном режиме. Ночью «Не беспокоить» включён почти у всех: звук
         * пробивался (STREAM_ALARM и канал с setBypassDnd), а вибрации не было
         * вовсе — ровно там, где она нужнее всего.
         */
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0), attrs)
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(pattern, 0, attrs)
        }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        wakeLock = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "NewDay:alarm",
        ).apply { acquire(10 * 60 * 1000L) }
    }

    private fun launchDismissScreen(a: Alarm) {
        startActivity(
            Intent(this, AlarmActivity::class.java).apply {
                putExtra("alarmId", a.id)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            },
        )
    }

    // ── Остановка ────────────────────────────────────────────

    private fun snooze() {
        val a = alarm ?: AlarmStore.find(this, currentAlarmId)
        val cfg = AlarmStore.config(this)
        if (a != null && cfg.snoozeAllowed) {
            // snoozed = true: отметка «этот будильник переставлен здесь, на
            // телефоне». Без неё первая же синхронизация с веб-частью снимала
            // отложенный будильник — в присланном списке его нет, потому что
            // его время уже прошло
            val later = a.copy(
                fireAt = System.currentTimeMillis() + cfg.snoozeMinutes * 60_000L,
                snoozed = true,
            )
            AlarmStore.save(this, AlarmStore.load(this).filter { it.id != a.id } + later)
            AlarmScheduler.schedule(this, later)
            Log.i("NewDayAlarm", "Отложен на " + cfg.snoozeMinutes + " мин")
        }
        stopEverything()
    }

    /**
     * Отпускает звук, вибрацию и wakelock, не останавливая саму службу.
     *
     * Нужно отдельно от [stopEverything]: когда в живую службу приходит второй
     * будильник, старый звук обязан замолчать, а служба — остаться.
     */
    private fun releasePlayback() {
        rampHandler?.removeCallbacksAndMessages(null)
        rampHandler = null
        try {
            player?.stop()
        } catch (e: Exception) {
            Log.d("NewDayAlarm", "Плеер уже остановлен")
        }
        player?.release()
        player = null
        vibrator?.cancel()
        vibrator = null
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
    }

    private fun stopEverything() {
        releasePlayback()
        alarm = null
        currentAlarmId = -1
        graceUntilMs = 0L
        /*
         * stopForeground(int) появился только в Android 7.
         *
         * minSdk у нас 23, и на Android 6 этот вызов — NoSuchMethodError прямо в
         * момент выключения будильника: звук уже остановлен, а приложение
         * падает, уведомление будильника остаётся висеть навсегда. Для шестой
         * версии есть логический предшественник — stopForeground(true).
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }
}
