package ru.appswire.newday.alarm

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.CountDownTimer
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Экран отключения будильника.
 *
 * Показывается поверх локскрина и не даёт себя закрыть, пока задачи не решены:
 * кнопка «назад» игнорируется, а таймер на задачу заменяет её новой, если
 * человек завис. Смысл именно в этом — выключить не глядя должно быть нельзя.
 *
 * Вёрстка кодом, без XML: экран один, а лишний слой ресурсов только
 * усложнил бы чтение.
 */
class AlarmActivity : Activity() {

    private var alarm: Alarm? = null
    private lateinit var config: DismissConfig
    private var tasks: List<DismissTask> = emptyList()
    private var index = 0
    private var timer: CountDownTimer? = null

    private lateinit var root: LinearLayout
    private lateinit var clockView: TextView
    private lateinit var titleView: TextView
    private lateinit var progressView: TextView
    private lateinit var promptView: TextView
    private lateinit var answerArea: LinearLayout
    private lateinit var timerView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockScreen()

        val id = intent.getLongExtra("alarmId", AlarmService.currentAlarmId)
        alarm = AlarmStore.find(this, id)
        config = AlarmStore.config(this)

        // мягкий профиль не должен превращаться в квест: одна задача максимум
        if (alarm?.isWakeup != true) {
            config = config.copy(count = 1.coerceAtMost(config.count))
        }
        tasks = TaskFactory.makeSet(config)
        Log.i("NewDayAlarm", "Экран отключения: будильник=" + id + ", задач=" + tasks.size)

        buildUi()
        // Время мягкого начала считает сервис — экран мог открыться с задержкой,
        // и свой отсчёт с нуля показал бы окно длиннее настоящего
        val graceLeftMs = AlarmService.graceUntilMs - System.currentTimeMillis()
        if (config.graceEnabled && graceLeftMs > 0) showGrace(graceLeftMs) else showTask()
    }

    /** Окно поверх локскрина с включением экрана. */
    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager)
                .requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // ── Разметка ─────────────────────────────────────────────

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics,
    ).toInt()

    private fun buildUi() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Color.parseColor("#0E1116"))
            setPadding(dp(24), dp(48), dp(24), dp(32))
        }

        clockView = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 56f)
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
            text = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
        }

        titleView = TextView(this).apply {
            setTextColor(Color.parseColor("#AAB3C2"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            gravity = Gravity.CENTER
            text = alarm?.body?.ifBlank { alarm?.title } ?: "Пора вставать"
            setPadding(0, dp(4), 0, dp(28))
        }

        progressView = TextView(this).apply {
            setTextColor(Color.parseColor("#5B9DFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            letterSpacing = 0.08f
        }

        promptView = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
            gravity = Gravity.CENTER
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
            setPadding(0, dp(12), 0, dp(20))
        }

        answerArea = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
        }

        timerView = TextView(this).apply {
            setTextColor(Color.parseColor("#7D8798"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, dp(20), 0, 0)
        }

        root.addView(clockView)
        root.addView(titleView)
        root.addView(progressView)
        root.addView(promptView)
        root.addView(answerArea)
        root.addView(timerView)

        if (config.snoozeAllowed && alarm?.isWakeup != true) {
            root.addView(
                Button(this).apply {
                    text = "Отложить на " + config.snoozeMinutes + " мин"
                    setOnClickListener { snooze() }
                    layoutParams = LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(24) }
                },
            )
        }

        setContentView(root)
    }

    // ── Мягкое начало ────────────────────────────────────────

    /**
     * Пока идёт окно — одна большая кнопка «Выключить» и обратный отсчёт.
     *
     * Так выглядит случай «я уже встал»: будильник звучит тихо, выключается
     * одним нажатием. Когда отсчёт дойдёт до нуля, экран сам превратится в
     * задачи — это ровно тот момент, когда стало ясно, что человек спит.
     */
    private fun showGrace(leftMs: Long) {
        progressView.text = "МОЖНО ПРОСТО ВЫКЛЮЧИТЬ"
        promptView.text = ""
        answerArea.removeAllViews()
        answerArea.addView(
            Button(this).apply {
                text = "Выключить"
                isAllCaps = false      // «ВЫКЛЮЧИТЬ» капсом читается как крик
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
                setOnClickListener { dismiss() }
                layoutParams = LinearLayout.LayoutParams(MATCH, dp(76))
            },
        )

        timer?.cancel()
        timer = object : CountDownTimer(leftMs, 1000) {
            override fun onTick(msLeft: Long) {
                val s = msLeft / 1000
                timerView.text = "через " + (s / 60) + ":" + String.format(Locale.US, "%02d", s % 60) +
                    " придётся решать задачу"
            }
            override fun onFinish() {
                Log.i("NewDayAlarm", "GRACE_EXPIRED окно простого выключения истекло")
                timerView.text = ""
                showTask()
            }
        }.start()
    }

    // ── Задачи ───────────────────────────────────────────────

    private fun showTask() {
        timer?.cancel()
        if (index >= tasks.size) { dismiss(); return }

        val task = tasks[index]
        Log.i("NewDayAlarm", "TASK_SHOWN задача " + (index + 1) + " из " + tasks.size)
        progressView.text = "ЗАДАЧА " + (index + 1) + " ИЗ " + tasks.size
        promptView.text = task.prompt
        answerArea.removeAllViews()

        when (task) {
            is DismissTask.Math -> buildMath(task)
            is DismissTask.Code -> buildCode(task)
            is DismissTask.Icons -> buildIcons(task)
        }
        startTimer()
    }

    private fun buildMath(task: DismissTask.Math) {
        val grid = GridLayout(this).apply {
            columnCount = 2
            layoutParams = LinearLayout.LayoutParams(WRAP, WRAP)
        }
        task.options.forEach { option ->
            grid.addView(
                bigButton(option.toString()) {
                    if (task.check(option.toString())) next() else wrong()
                },
            )
        }
        answerArea.addView(grid)
    }

    private fun buildCode(task: DismissTask.Code) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
            gravity = Gravity.CENTER
            typeface = Typeface.MONOSPACE
            hint = "код"
            width = dp(220)
        }
        answerArea.addView(input)
        answerArea.addView(
            bigButton("Готово") {
                if (task.check(input.text.toString())) next() else { input.setText(""); wrong() }
            },
        )
    }

    private fun buildIcons(task: DismissTask.Icons) {
        val entered = StringBuilder()
        val echo = TextView(this).apply {
            setTextColor(Color.parseColor("#5B9DFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            gravity = Gravity.CENTER
            height = dp(40)
        }
        answerArea.addView(echo)

        val grid = GridLayout(this).apply { columnCount = 4 }
        task.pool.forEach { icon ->
            grid.addView(
                bigButton(icon) {
                    entered.append(icon)
                    echo.text = entered.toString()
                    val target = task.sequence.joinToString("")
                    if (!target.startsWith(entered.toString())) {
                        entered.clear(); echo.text = ""; wrong()
                    } else if (entered.toString() == target) next()
                },
            )
        }
        answerArea.addView(grid)
    }

    private fun bigButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
        setOnClickListener { onClick() }
        layoutParams = GridLayout.LayoutParams().apply {
            width = dp(120)
            height = dp(64)
            setMargins(dp(6), dp(6), dp(6), dp(6))
        }
    }

    /**
     * Не уложился — задача меняется на новую, звук продолжает играть.
     * Так нельзя пересидеть будильник, тупо глядя в экран.
     */
    private fun startTimer() {
        timer = object : CountDownTimer(config.timeoutSec * 1000L, 1000) {
            override fun onTick(msLeft: Long) {
                timerView.text = "осталось " + (msLeft / 1000) + " с"
            }
            override fun onFinish() {
                tasks = tasks.toMutableList().also {
                    it[index] = TaskFactory.make(
                        config.types.randomOrNull() ?: "math", config.difficulty,
                    )
                }
                timerView.text = "время вышло — новая задача"
                showTask()
            }
        }.start()
    }

    private fun wrong() {
        promptView.setTextColor(Color.parseColor("#FF6B6F"))
        promptView.postDelayed({ promptView.setTextColor(Color.WHITE) }, 400)
    }

    private fun next() {
        index += 1
        showTask()
    }

    // ── Выход ────────────────────────────────────────────────

    private fun dismiss() {
        val inGrace = AlarmService.graceUntilMs > System.currentTimeMillis()
        Log.i(
            "NewDayAlarm",
            if (inGrace) "GRACE_DISMISS будильник выключен в мягком начале, без задач"
            else "Будильник выключен, задач решено: " + index,
        )
        timer?.cancel()
        startService(Intent(this, AlarmService::class.java).apply { action = AlarmService.ACTION_STOP })
        openApp()
        finish()
    }

    private fun snooze() {
        timer?.cancel()
        startService(Intent(this, AlarmService::class.java).apply { action = AlarmService.ACTION_SNOOZE })
        finish()
    }

    /** После подъёма логично оказаться в сегодняшнем дне, а не на пустом экране. */
    private fun openApp() {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        startActivity(launch)
    }

    /** Кнопка «назад» будильник не выключает. */
    @Deprecated("Намеренно: экран нельзя покинуть, не решив задачу")
    override fun onBackPressed() { /* игнорируем */ }

    override fun onNewIntent(intent: Intent?) {
        // singleInstance: второй старт приходит сюда, а не создаёт копию —
        // если звонит тот же будильник, просто остаёмся на месте
        super.onNewIntent(intent)
        val id = intent?.getLongExtra("alarmId", -1) ?: -1
        Log.i("NewDayAlarm", "Повторный старт экрана отключения для " + id)
    }

    override fun onDestroy() {
        Log.i("NewDayAlarm", "Экран отключения закрыт")
        timer?.cancel()
        super.onDestroy()
    }

    companion object {
        private const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
        private const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
    }
}
