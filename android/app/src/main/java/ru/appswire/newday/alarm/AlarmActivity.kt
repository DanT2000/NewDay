package ru.appswire.newday.alarm

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.CountDownTimer
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
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
 * Оформление — как в самом NewDay (`Style`), а не системными кнопками на
 * тёмном фоне: экран будильника — единственное, что человек видит нативным, и
 * выглядеть чужим приложением ему нельзя.
 *
 * Вёрстка кодом, без XML: экран один, а лишний слой ресурсов только усложнил
 * бы чтение.
 */
class AlarmActivity : Activity() {

    private var alarm: Alarm? = null
    private lateinit var config: DismissConfig
    private var tasks: List<DismissTask> = emptyList()
    private var index = 0
    private var timer: CountDownTimer? = null
    private var accent = Style.accent("violet")

    private lateinit var ui: Ui
    private lateinit var root: LinearLayout
    private lateinit var stage: LinearLayout          // меняющаяся часть: окно или задача
    private lateinit var capView: TextView
    private lateinit var footView: TextView

    private lateinit var steps: StepCounter
    private var scanner: CodeScanner? = null
    private var rescueTimer: CountDownTimer? = null
    private var rescued = false                       // уже ушли на аварийную задачу
    private var canScan = false                       // есть камера и разрешение
    private var canWalk = false                       // есть шагомер и разрешение

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockScreen()
        blockBackExit()

        ui = Ui(this)
        accent = Style.accent(AlarmStore.accent(this))

        val id = intent.getLongExtra("alarmId", AlarmService.currentAlarmId)
        alarm = AlarmStore.find(this, id)
        config = AlarmStore.config(this)

        // мягкий профиль не должен превращаться в квест: одна задача максимум
        if (alarm?.isWakeup != true) {
            config = config.copy(count = 1.coerceAtMost(config.count))
        }
        steps = StepCounter(this)
        canScan = CodeScanner.hasCamera(this) && CodeScanner.hasPermission(this)
        canWalk = steps.available
        tasks = TaskFactory.makeSet(config, canScan, canWalk)
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
        window.statusBarColor = Style.BG
        window.navigationBarColor = Style.BG
    }

    // ── Разметка ─────────────────────────────────────────────

    /**
     * Шапка: день недели, время, зачем разбудили.
     *
     * Порядок тот же, что на телефонном экране дня: сверху день мелким капсом,
     * под ним большое число. Так будильник читается как продолжение приложения,
     * а не как отдельная штука.
     */
    private fun buildUi() {
        val now = Date()
        val dow = SimpleDateFormat("EEEE", Locale("ru")).format(now).uppercase()

        val head = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        head.addView(ui.cap(dow))
        head.addView(ui.spacer(10))
        head.addView(
            ui.mono(SimpleDateFormat("HH:mm", Locale.getDefault()).format(now), 64f).apply {
                letterSpacing = -0.02f
            },
        )
        head.addView(ui.spacer(8))
        head.addView(
            ui.title(alarm?.body?.ifBlank { alarm?.title } ?: "Пора вставать", 17f, Style.DIM),
        )

        capView = ui.cap("", accent)
        stage = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
        }
        footView = ui.body("", 13f, Style.FAINT)

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(ui.dp(20), ui.dp(44), ui.dp(20), ui.dp(24))
        }
        column.addView(head)
        column.addView(ui.spacer(30))
        column.addView(capView)
        column.addView(ui.spacer(12))
        column.addView(stage)
        column.addView(ui.spacer(16))
        column.addView(footView)

        /*
         * «Отложить» — внизу и тихой кнопкой: это не то, к чему надо тянуться в
         * первую очередь. У подъёма её нет вовсе — иначе будильник, который
         * можно отложить, не будильник.
         */
        if (config.snoozeAllowed && alarm?.isWakeup != true) {
            column.addView(ui.spacer(20))
            column.addView(
                ui.quiet("Отложить на " + config.snoozeMinutes + " мин") { snooze() }.apply {
                    layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(46))
                },
            )
        }

        /*
         * Прокрутка: на маленьком экране с включённым увеличением шрифта
         * клавиатура вместе с шапкой не влезает, а обрезанная нижняя кнопка —
         * это будильник, который нельзя выключить.
         */
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Style.BG)
        }
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(column)
            layoutParams = LinearLayout.LayoutParams(MATCH, 0, 1f)
        }
        root.addView(scroll)
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
        capView.text = "МОЖНО ПРОСТО ВЫКЛЮЧИТЬ"
        stage.removeAllViews()

        val card = ui.card()
        card.addView(
            ui.body("Вы уже встали — гасим будильник одним нажатием, без задач.", 14f, Style.DIM),
        )
        card.addView(ui.spacer(16))
        card.addView(
            ui.primary("Выключить", accent) { dismiss() }.apply {
                layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(60))
            },
        )
        stage.addView(card.apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP) })

        timer?.cancel()
        timer = object : CountDownTimer(leftMs, 1000) {
            override fun onTick(msLeft: Long) {
                val s = msLeft / 1000
                footView.text = "через " + (s / 60) + ":" + String.format(Locale.US, "%02d", s % 60) +
                    " придётся решать задачу"
            }
            override fun onFinish() {
                Log.i("NewDayAlarm", "GRACE_EXPIRED окно простого выключения истекло")
                footView.text = ""
                showTask()
            }
        }.start()
    }

    // ── Задачи ───────────────────────────────────────────────

    private fun showTask() {
        timer?.cancel()
        releaseSensors()
        if (index >= tasks.size) { dismiss(); return }

        val task = tasks[index]
        Log.i("NewDayAlarm", "TASK_SHOWN задача " + (index + 1) + " из " + tasks.size)
        capView.text = if (tasks.size == 1) "ЗАДАЧА" else "ЗАДАЧА " + (index + 1) + " ИЗ " + tasks.size
        stage.removeAllViews()

        when (task) {
            is DismissTask.Math -> buildMath(task)
            is DismissTask.Code -> buildCode(task)
            is DismissTask.Icons -> buildIcons(task)
            is DismissTask.Qr -> buildQr(task)
            is DismissTask.Steps -> buildSteps(task)
        }

        /*
         * Таймер «не уложился — новая задача» к камере и шагам не применяется.
         *
         * Он существует, чтобы нельзя было пересидеть будильник, тупо глядя в
         * экран с примером. Но дойти до чайника и пройти тридцать шагов дольше
         * тридцати секунд — это норма, а не залипание. Менять задачу на новую
         * ровно в тот момент, когда человек уже встал и идёт, — издевательство.
         */
        if (task is DismissTask.Qr || task is DismissTask.Steps) startRescueTimer()
        else startTimer()
    }

    /**
     * Пример и своя цифровая клавиатура.
     *
     * Системную клавиатуру не зовём нарочно: она поднимается поверх экрана,
     * закрывает пример, а на локскрине ведёт себя непредсказуемо. Своя — это
     * двенадцать больших клавиш, которые видно и по которым попадаешь.
     */
    private fun buildMath(task: DismissTask.Math) {
        val entered = StringBuilder()
        val card = ui.card()

        card.addView(ui.mono(task.prompt + " =", 34f).apply { letterSpacing = 0.04f })
        card.addView(ui.spacer(14))

        val field = ui.mono("", 40f, accent).apply {
            background = rounded(Style.RAISE, ui.dp(14))
            setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10))
            layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(72))
            hint = "?"
            setHintTextColor(Style.FAINT)
        }
        card.addView(field)
        card.addView(ui.spacer(14))

        val pad = GridLayout(this).apply {
            columnCount = 3
            layoutParams = LinearLayout.LayoutParams(WRAP, WRAP)
        }
        val redraw = { field.text = entered.toString() }
        val press = { digit: String ->
            if (entered.length < 4) { entered.append(digit); redraw() }
        }

        // 1..9, затем «стереть · 0 · Готово» — привычный порядок телефона
        (1..9).forEach { n -> pad.addView(padKey(n.toString()) { press(n.toString()) }) }
        pad.addView(padKey("←") { if (entered.isNotEmpty()) { entered.deleteCharAt(entered.length - 1); redraw() } })
        pad.addView(padKey("0") { press("0") })
        pad.addView(
            padKey("OK") {
                if (entered.isEmpty()) return@padKey
                if (task.check(entered.toString())) next()
                else { entered.clear(); redraw(); wrong(field) }
            }.apply { setBackgroundDrawable(withRipple(rounded(accent, ui.dp(14)), Color.WHITE)) },
        )
        card.addView(pad)

        stage.addView(card.apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP) })
    }

    /** Клавиша: три в ряд, во всю доступную ширину. */
    private fun padKey(label: String, onClick: () -> Unit): TextView =
        ui.key(label, accent, onClick).apply {
            layoutParams = GridLayout.LayoutParams().apply {
                width = ui.dp(88)
                height = ui.dp(62)
                setMargins(ui.dp(5), ui.dp(5), ui.dp(5), ui.dp(5))
            }
        }

    private fun buildCode(task: DismissTask.Code) {
        val entered = StringBuilder()
        val card = ui.card()
        card.addView(ui.cap("введите код", Style.FAINT))
        card.addView(ui.spacer(8))
        card.addView(ui.mono(task.code, 34f).apply { letterSpacing = 0.22f })
        card.addView(ui.spacer(14))

        val field = ui.mono("", 34f, accent).apply {
            background = rounded(Style.RAISE, ui.dp(14))
            setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10))
            layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(66))
            letterSpacing = 0.22f
        }
        card.addView(field)
        card.addView(ui.spacer(14))

        val pad = GridLayout(this).apply { columnCount = 3 }
        val redraw = { field.text = entered.toString() }
        (1..9).forEach { n -> pad.addView(padKey(n.toString()) { if (entered.length < 8) { entered.append(n); redraw() } }) }
        pad.addView(padKey("←") { if (entered.isNotEmpty()) { entered.deleteCharAt(entered.length - 1); redraw() } })
        pad.addView(padKey("0") { if (entered.length < 8) { entered.append('0'); redraw() } })
        pad.addView(
            padKey("OK") {
                if (task.check(entered.toString())) next()
                else { entered.clear(); redraw(); wrong(field) }
            }.apply { setBackgroundDrawable(withRipple(rounded(accent, ui.dp(14)), Color.WHITE)) },
        )
        card.addView(pad)
        stage.addView(card.apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP) })
    }

    private fun buildIcons(task: DismissTask.Icons) {
        val entered = StringBuilder()
        val card = ui.card()
        card.addView(ui.cap("нажмите по порядку", Style.FAINT))
        card.addView(ui.spacer(8))
        card.addView(ui.title(task.sequence.joinToString("   "), 30f))
        card.addView(ui.spacer(12))

        val echo = ui.title("", 26f, accent).apply {
            background = rounded(Style.RAISE, ui.dp(14))
            layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(56))
        }
        card.addView(echo)
        card.addView(ui.spacer(14))

        val grid = GridLayout(this).apply { columnCount = 4 }
        task.pool.forEach { icon ->
            grid.addView(
                ui.key(icon, accent) {
                    entered.append(icon)
                    echo.text = entered.toString()
                    val target = task.sequence.joinToString("")
                    if (!target.startsWith(entered.toString())) {
                        entered.clear(); echo.text = ""; wrong(echo)
                    } else if (entered.toString() == target) next()
                }.apply {
                    layoutParams = GridLayout.LayoutParams().apply {
                        width = ui.dp(66)
                        height = ui.dp(62)
                        setMargins(ui.dp(5), ui.dp(5), ui.dp(5), ui.dp(5))
                    }
                },
            )
        }
        card.addView(grid)
        stage.addView(card.apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP) })
    }

    /**
     * Найти и отсканировать привязанный код.
     *
     * Весь смысл — в том, что код наклеен не у кровати. Поэтому подпись
     * называет место: спросонья «где мой код» — вопрос настоящий.
     */
    private fun buildQr(task: DismissTask.Qr) {
        val card = ui.card()
        card.addView(ui.cap("наведите камеру", Style.FAINT))
        card.addView(ui.spacer(8))
        card.addView(ui.title(task.label, 22f))
        card.addView(ui.spacer(14))

        // Окно видоискателя: квадрат, скруглённый как всё остальное в приложении
        val frame = FrameLayout(this).apply {
            background = rounded(Style.RAISE, ui.dp(18))
            clipToOutline = true
            layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(240))
        }
        card.addView(frame)
        card.addView(ui.spacer(10))

        val hint = ui.body("Открываю камеру…", 13f, Style.FAINT)
        card.addView(hint)
        stage.addView(card.apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP) })

        val cam = CodeScanner(this) { text ->
            if (task.check(text)) {
                Log.i("NewDayAlarm", "QR_OK код совпал")
                next()
            } else {
                // Чужой код — частый случай: в кадр попала упаковка или чек.
                // Сказать об этом надо прямо, иначе выглядит как «не работает».
                Log.i("NewDayAlarm", "QR_OTHER отсканирован не тот код")
                hint.text = "Это другой код. Нужен тот, что вы привязали: " + task.label
                wrong(frame)
                restartScanner(frame, hint, task)
            }
        }
        scanner = cam
        frame.addView(cam.view)
        cam.start(
            onFail = { why ->
                /*
                 * Камеры нет или в ней отказано — ждать нечего: сразу переводим
                 * на математику. Показывать чёрный прямоугольник и надпись «нет
                 * доступа» означало бы оставить человека с орущим телефоном и
                 * без единого способа его выключить.
                 */
                Log.i("NewDayAlarm", "QR_UNAVAILABLE " + why + " — перехожу на математику")
                hint.text = why + " — переключаю на пример"
                hint.postDelayed({ rescue("Камера недоступна") }, 1200)
            },
            onReady = { hint.text = "Ищу код — держите его в рамке" },
        )
    }

    /** После чужого кода сканер надо поднять заново: он останавливается на находке. */
    private fun restartScanner(frame: FrameLayout, hint: TextView, task: DismissTask.Qr) {
        scanner?.stop()
        frame.removeAllViews()
        val cam = CodeScanner(this) { text ->
            if (task.check(text)) next()
            else { hint.text = "Снова не тот код"; wrong(frame); restartScanner(frame, hint, task) }
        }
        scanner = cam
        frame.addView(cam.view)
        cam.start(onFail = { why -> hint.text = why })
    }

    /**
     * Пройти нужное число шагов.
     *
     * Показываем счётчик и полосу: без обратной связи непонятно, считает ли
     * телефон вообще, и человек трясёт его вместо того, чтобы идти.
     */
    private fun buildSteps(task: DismissTask.Steps) {
        val card = ui.card()
        card.addView(ui.cap("пройдите", Style.FAINT))
        card.addView(ui.spacer(8))

        val counter = ui.mono("0 / " + task.target, 44f, accent)
        card.addView(counter)
        card.addView(ui.spacer(14))

        // Полоса заполнения: видно, что шаги считаются, ещё до того как их станет много
        val bar = View(this).apply {
            background = rounded(Style.RAISE, ui.dp(8))
            layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(14))
        }
        val fill = View(this).apply { background = rounded(accent, ui.dp(8)) }
        val track = FrameLayout(this).apply {
            addView(bar)
            addView(fill, FrameLayout.LayoutParams(0, ui.dp(14)))
            layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(14))
        }
        card.addView(track)
        card.addView(ui.spacer(12))

        val hint = ui.body("Встаньте и пройдитесь — телефон возьмите с собой", 13f, Style.DIM)
        card.addView(hint)
        stage.addView(card.apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP) })

        val started = steps.start { n ->
            runOnUiThread {
                val done = n.coerceAtMost(task.target)
                counter.text = done.toString() + " / " + task.target
                fill.layoutParams = FrameLayout.LayoutParams(
                    (track.width * done / task.target.coerceAtLeast(1)), ui.dp(14),
                )
                fill.requestLayout()
                if (n >= task.target) {
                    Log.i("NewDayAlarm", "STEPS_OK пройдено " + n)
                    next()
                }
            }
        }
        if (!started) {
            val why = steps.whyUnavailable().ifBlank { "шагомер недоступен" }
            Log.i("NewDayAlarm", "STEPS_UNAVAILABLE " + why + " — перехожу на математику")
            hint.text = why + " — переключаю на пример"
            hint.postDelayed({ rescue("Шагомер недоступен") }, 1200)
        }
    }

    // ── Аварийный выход ──────────────────────────────────────

    /**
     * Кнопка «не получается» появляется не сразу.
     *
     * Появись она с первой секунды — ею бы пользовались всегда, и код на
     * чайнике не имел бы смысла. Не появись никогда — человек с отклеившимся
     * кодом остаётся наедине с орущим телефоном. Полторы минуты честных
     * попыток: достаточно, чтобы понять, что код не читается, и мало, чтобы
     * стать привычкой.
     */
    private fun startRescueTimer() {
        rescueTimer?.cancel()
        rescueTimer = object : CountDownTimer(config.rescueAfterSec * 1000L, 1000) {
            override fun onTick(msLeft: Long) { /* молча: обратный отсчёт тут подсказка сдаться */ }
            override fun onFinish() {
                if (rescued || index >= tasks.size) return
                footView.text = ""
                stage.addView(
                    ui.quiet("Не получается — дайте пример") { rescue("Человек попросил сам") }.apply {
                        layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(48)).apply {
                            topMargin = ui.dp(14)
                        }
                    },
                )
                Log.i("NewDayAlarm", "RESCUE_OFFERED аварийный выход предложен")
            }
        }.start()
    }

    /**
     * Переход на аварийную задачу.
     *
     * Она заведомо труднее основной — математика верхнего уровня, — и это
     * нарочно: выход есть всегда, но он не должен быть дорогой полегче.
     */
    private fun rescue(why: String) {
        // rescue приходит и из postDelayed: человек мог успеть нажать
        // «Отложить», и запоздалый вызов на закрытом экране заводил бы
        // самовозобновляющийся таймер, который уже некому отменить
        if (isFinishing || isDestroyed) return
        if (rescued) return
        rescued = true
        Log.i("NewDayAlarm", "RESCUE " + why + " — сложный пример вместо задачи")
        rescueTimer?.cancel()
        releaseSensors()
        tasks = tasks.toMutableList().also { it[index] = TaskFactory.rescue() }
        showTask()
        footView.text = why
    }

    /** Камера и датчики отпускаются, как только перестали быть нужны. */
    private fun releaseSensors() {
        rescueTimer?.cancel()
        scanner?.stop()
        scanner = null
        if (::steps.isInitialized) steps.stop()
    }

    /**
     * Не уложился — задача меняется на новую, звук продолжает играть.
     * Так нельзя пересидеть будильник, тупо глядя в экран.
     */
    private fun startTimer() {
        timer = object : CountDownTimer(config.timeoutSec * 1000L, 1000) {
            override fun onTick(msLeft: Long) {
                footView.text = "осталось " + (msLeft / 1000) + " с"
            }
            override fun onFinish() {
                /*
                 * Замена — только на задачу с вводом, без камеры и шагов.
                 *
                 * Этот таймер стоит на math/code/icons, и заменить пример на
                 * «идите сканировать» посреди решения — значит поменять правила
                 * на ходу. Хуже того: если человек уже ушёл с QR на аварийный
                 * пример, замена по таймауту вернула бы ему тот же нечитаемый
                 * QR — а `rescued` уже истрачен, и выхода бы не осталось.
                 */
                val basic = config.types.filter { it in setOf("math", "code", "icons") }
                tasks = tasks.toMutableList().also {
                    it[index] = TaskFactory.make(
                        basic.randomOrNull() ?: "math", config.difficulty,
                    )
                }
                footView.text = "время вышло — новая задача"
                showTask()
            }
        }.start()
    }

    /** Ошибка видна там, куда человек смотрит, — в поле ответа. */
    private fun wrong(field: View) {
        val was = field.background
        field.background = rounded(Style.mix(Style.WARN, Style.SURFACE, 30), ui.dp(14),
            ui.dp(1), Style.WARN)
        field.postDelayed({ field.background = was }, 420)
    }

    private fun next() {
        index += 1
        // у каждой задачи свой аварийный выход: «не получается» с QR на первой
        // не должно лишать выхода на второй
        rescued = false
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

    /**
     * Кнопка «назад» будильник не выключает.
     *
     * С Android 13 появился второй способ уйти назад — жест, и он идёт мимо
     * `onBackPressed`: система зовёт зарегистрированный OnBackInvokedCallback, а
     * если его нет, сама закрывает экран. Приложениям с targetSdk 36 (наш
     * случай) этот путь включён по умолчанию, то есть на Android 16 будильник
     * смахивался жестом: экран закрывался, задача не решалась, а звук
     * продолжал играть из службы — выключить его было уже нечем, кроме
     * уведомления, которое поднимает тот же экран заново.
     *
     * Поэтому на 13+ вешаем пустой обработчик: он перехватывает и жест, и
     * кнопку. `onBackPressed` остаётся для Android 6..12, где этого механизма
     * ещё нет.
     */
    private fun blockBackExit() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        onBackInvokedDispatcher.registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            OnBackInvokedCallback { /* игнорируем: экран нельзя покинуть, не решив задачу */ },
        )
    }

    @Suppress("GestureBackNavigation")
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
        // Камера, оставленная включённой, держит железо и жжёт индикатор
        // камеры — человек справедливо решает, что за ним подсматривают
        releaseSensors()
        super.onDestroy()
    }

    companion object {
        private const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
        private const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
    }
}
