package ru.appswire.newday.alarm

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Оформление экрана будильника — то же, что в самом NewDay.
 *
 * Экран будильника — единственное место, которое человек видит не в вебвью, а
 * нативным: до вебвью в шесть утра дело не доходит, там нужен мгновенный отклик
 * и работа поверх локскрина. Но выглядеть он должен так же, иначе просыпаешься
 * в чужом приложении.
 *
 * Цвета взяты из `public/js/web/data.js` один в один, а не подобраны на глаз:
 * два набора «почти таких же» оттенков разошлись бы при первой же правке темы.
 */
object Style {
    val BG = Color.parseColor("#161826")
    val SURFACE = Color.parseColor("#232532")
    val RAISE = Color.parseColor("#2e3040")
    val TEXT = Color.parseColor("#e9e9ed")
    val DIM = Color.parseColor("#9ba0b5")
    val FAINT = Color.parseColor("#7b8092")
    val LINE = Color.parseColor("#1ae9e9ed")          // те же 10 % прозрачности
    val WARN = Color.parseColor("#ff6a5e")

    /** Четыре цвета оформления — как в вебе; какой выбран, знает AlarmStore. */
    private val ACCENTS = mapOf(
        "violet" to "#9d8cf0",
        "orange" to "#ff9330",
        "green" to "#3fd0b0",
        "red" to "#ff6a5e",
    )

    fun accent(key: String?): Int =
        Color.parseColor(ACCENTS[key] ?: ACCENTS["violet"]!!)

    /** Тот же акцент, но еле заметной заливкой — как `--accent-soft`. */
    fun accentSoft(key: String?): Int {
        val c = accent(key)
        return Color.argb(46, Color.red(c), Color.green(c), Color.blue(c))
    }

    fun mix(color: Int, over: Int, percent: Int): Int {
        val p = percent.coerceIn(0, 100) / 100f
        return Color.rgb(
            (Color.red(color) * p + Color.red(over) * (1 - p)).toInt(),
            (Color.green(color) * p + Color.green(over) * (1 - p)).toInt(),
            (Color.blue(color) * p + Color.blue(over) * (1 - p)).toInt(),
        )
    }
}

/** Скруглённый фон с необязательной рамкой — из него собран весь экран. */
fun rounded(fill: Int, radiusPx: Int, strokePx: Int = 0, strokeColor: Int = 0): GradientDrawable =
    GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = radiusPx.toFloat()
        setColor(fill)
        if (strokePx > 0) setStroke(strokePx, strokeColor)
    }

/**
 * Нажатие должно быть видно.
 *
 * Системная кнопка рисует свой отклик сама, а у нас фон свой — без ripple
 * нажатие на большую плитку в полусне выглядит как «не сработало», и человек
 * жмёт второй раз.
 */
fun withRipple(base: GradientDrawable, accent: Int): RippleDrawable =
    RippleDrawable(ColorStateList.valueOf(Style.mix(accent, Style.BG, 35)), base, null)

class Ui(private val ctx: Context) {

    fun dp(v: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), ctx.resources.displayMetrics,
    ).toInt()

    fun sp(view: TextView, size: Float) = view.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)

    /** Надпись-этикетка: капсом, разряжённая, тусклая — как `.wfield-label`. */
    fun cap(text: String, color: Int = Style.FAINT): TextView = TextView(ctx).apply {
        this.text = text.uppercase()
        setTextColor(color)
        sp(this, 12f)
        letterSpacing = 0.12f
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER
    }

    fun title(text: String, size: Float = 22f, color: Int = Style.TEXT): TextView = TextView(ctx).apply {
        this.text = text
        setTextColor(color)
        sp(this, size)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER
    }

    fun body(text: String, size: Float = 14f, color: Int = Style.DIM): TextView = TextView(ctx).apply {
        this.text = text
        setTextColor(color)
        sp(this, size)
        gravity = Gravity.CENTER
        setLineSpacing(dp(4).toFloat(), 1f)
    }

    /** Числа — моноширинным: время и примеры не должны дёргаться при смене цифр. */
    fun mono(text: String, size: Float, color: Int = Style.TEXT, bold: Boolean = true): TextView =
        TextView(ctx).apply {
            this.text = text
            setTextColor(color)
            sp(this, size)
            typeface = Typeface.create(Typeface.MONOSPACE, if (bold) Typeface.BOLD else Typeface.NORMAL)
            gravity = Gravity.CENTER
        }

    /** Карточка: поверхность со скруглением 20 — как шторки в вебе. */
    fun card(): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        background = rounded(Style.SURFACE, dp(20))
        setPadding(dp(18), dp(18), dp(18), dp(18))
    }

    /** Главная кнопка: акцентом во всю ширину, высотой в палец. */
    fun primary(label: String, accent: Int, onClick: () -> Unit): TextView = TextView(ctx).apply {
        text = label
        setTextColor(Color.WHITE)
        sp(this, 17f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER
        background = withRipple(rounded(accent, dp(14)), Color.WHITE)
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    /** Тихая кнопка: рамкой, без заливки. */
    fun quiet(label: String, onClick: () -> Unit): TextView = TextView(ctx).apply {
        text = label
        setTextColor(Style.DIM)
        sp(this, 15f)
        gravity = Gravity.CENTER
        background = withRipple(rounded(Color.TRANSPARENT, dp(12), dp(1), Style.LINE), Style.DIM)
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    /**
     * Клавиша цифровой клавиатуры.
     *
     * Большая нарочно: в шесть утра попасть по маленькой кнопке нельзя, и
     * промах читается как «приложение не отвечает». Высота — как у главной
     * кнопки в вебе, чтобы палец не искал.
     */
    fun key(label: String, accent: Int, onClick: () -> Unit): TextView = TextView(ctx).apply {
        text = label
        setTextColor(Style.TEXT)
        sp(this, 24f)
        typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        gravity = Gravity.CENTER
        background = withRipple(rounded(Style.RAISE, dp(14)), accent)
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    fun spacer(height: Int): View = View(ctx).apply {
        layoutParams = LinearLayout.LayoutParams(1, dp(height))
    }

    fun row(vararg views: View): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        views.forEach { addView(it) }
    }
}
