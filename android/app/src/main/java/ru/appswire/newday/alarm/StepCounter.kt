package ru.appswire.newday.alarm

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.util.Log

/**
 * Счётчик шагов для задачи пробуждения «пройди N шагов».
 *
 * Считает системный шагомер, а не время и не тряска: пролежать это нельзя,
 * только встать и пойти. Трясти телефон рукой, впрочем, можно — но шагомеры
 * научились такое отбрасывать лучше, чем это сделали бы мы.
 */
class StepCounter(private val context: Context) : SensorEventListener {

    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private var listener: ((Int) -> Unit)? = null
    private var counted = 0

    /*
     * Базовое значение для TYPE_STEP_COUNTER.
     *
     * Этот датчик отдаёт шаги, накопленные с момента загрузки телефона, — число
     * порядка десятков тысяч. Считать надо от текущего, поэтому первое
     * показание запоминаем как ноль. −1 значит «ещё не приходило».
     */
    private var base = -1f

    val available: Boolean get() = sensor() != null && allowed()

    /**
     * Почему шагомер недоступен — словами, которые можно показать человеку.
     * Пусто, если всё в порядке.
     */
    fun whyUnavailable(): String = when {
        manager == null -> "датчики недоступны"
        sensor() == null -> "на этом телефоне нет шагомера"
        !allowed() -> "нет разрешения на распознавание активности"
        else -> ""
    }

    /*
     * Берём детектор, если он есть, и счётчик как запасной.
     *
     * TYPE_STEP_DETECTOR присылает по событию на шаг — считать от нуля с ним
     * проще и точнее. TYPE_STEP_COUNTER есть чаще, но отдаёт накопленное с
     * загрузки, и его приходится приводить к нулю самому.
     */
    private fun sensor(): Sensor? =
        manager?.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR)
            ?: manager?.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)

    private fun allowed(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            androidx.core.content.ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.ACTIVITY_RECOGNITION,
            ) == PackageManager.PERMISSION_GRANTED
        } else true

    /** Начать считать с нуля. [onStep] приходит с текущим числом шагов. */
    fun start(onStep: (Int) -> Unit): Boolean {
        val s = sensor() ?: return false
        if (!allowed()) return false
        listener = onStep
        counted = 0
        base = -1f
        // SENSOR_DELAY_FASTEST здесь ни к чему: шаги идут раз в полсекунды,
        // а частый опрос только греет телефон
        val ok = manager?.registerListener(this, s, SensorManager.SENSOR_DELAY_NORMAL) ?: false
        Log.i("NewDayAlarm", "шагомер запущен: " + s.name + ", ok=" + ok)
        return ok
    }

    fun stop() {
        try { manager?.unregisterListener(this) } catch (e: Exception) { /* уже снят */ }
        listener = null
    }

    override fun onSensorChanged(event: SensorEvent?) {
        val e = event ?: return
        when (e.sensor.type) {
            Sensor.TYPE_STEP_DETECTOR -> counted += 1
            Sensor.TYPE_STEP_COUNTER -> {
                val total = e.values.firstOrNull() ?: return
                if (base < 0) base = total
                counted = (total - base).toInt().coerceAtLeast(0)
            }
            else -> return
        }
        listener?.invoke(counted)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { /* не важно */ }

    companion object {
        /** Есть ли на этом телефоне чем считать шаги — без создания счётчика. */
        fun sensorPresent(context: Context): Boolean {
            val pm = context.packageManager
            return pm.hasSystemFeature(PackageManager.FEATURE_SENSOR_STEP_DETECTOR) ||
                pm.hasSystemFeature(PackageManager.FEATURE_SENSOR_STEP_COUNTER)
        }
    }
}
