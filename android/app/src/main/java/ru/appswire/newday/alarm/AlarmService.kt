package ru.appswire.newday.alarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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
        private const val NOTIFICATION_ID = 4201

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
            stopSelf()
            return START_NOT_STICKY
        }

        alarm = found
        currentAlarmId = id
        createChannels(this)
        startForeground(NOTIFICATION_ID, buildNotification(found))

        if (found.isAlarm) {
            val cfg = AlarmStore.config(this)
            val grace = cfg.effectiveGraceSec
            graceUntilMs = if (grace > 0) System.currentTimeMillis() + grace * 1000L else 0L
            acquireWakeLock()
            startSound(found)
            startVibration(found, gentle = grace > 0)
            launchDismissScreen(found)
        } else {
            // обычное напоминание: показали и ушли
            stopSelf()
        }
        return START_STICKY
    }

    // ── Уведомление ──────────────────────────────────────────

    private fun buildNotification(a: Alarm): Notification {
        val full = Intent(this, AlarmActivity::class.java).apply {
            putExtra("alarmId", a.id)
            // без CLEAR_TASK: экран стартует дважды (вручную и через full-screen
            // intent), и CLEAR_TASK убивал уже открытую копию
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val fullPi = PendingIntent.getActivity(
            this, a.id.toInt(), full,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

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
            .setContentIntent(fullPi)

        // именно это поднимает окно поверх локскрина
        if (a.isAlarm) builder.setFullScreenIntent(fullPi, true)
        return builder.build()
    }

    // ── Звук, вибрация, экран ────────────────────────────────

    private fun startSound(a: Alarm) {
        val cfg = AlarmStore.config(this)
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

        try {
            player = MediaPlayer().apply {
                setDataSource(this@AlarmService, uri)
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
        } catch (e: Exception) {
            Log.e("NewDayAlarm", "Не удалось запустить звук: " + e.message)
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
            // резкий максимум в 6 утра жесток, тихий будильник не будит —
            // поэтому доходим до максимума примерно за минуту
            var level = (max * 0.25).toInt().coerceAtLeast(1)
            am.setStreamVolume(AudioManager.STREAM_ALARM, level, 0)
            val handler = Handler(Looper.getMainLooper())
            rampHandler = handler
            val step = object : Runnable {
                override fun run() {
                    if (level >= max) return
                    level += 1
                    am.setStreamVolume(AudioManager.STREAM_ALARM, level, 0)
                    handler.postDelayed(this, 60_000L / max.coerceAtLeast(1))
                }
            }
            handler.postDelayed(step, 4000)
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(pattern, 0)
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
            val later = a.copy(fireAt = System.currentTimeMillis() + cfg.snoozeMinutes * 60_000L)
            AlarmStore.save(this, AlarmStore.load(this).filter { it.id != a.id } + later)
            AlarmScheduler.schedule(this, later)
            Log.i("NewDayAlarm", "Отложен на " + cfg.snoozeMinutes + " мин")
        }
        stopEverything()
    }

    private fun stopEverything() {
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
        currentAlarmId = -1
        graceUntilMs = 0L
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }
}
