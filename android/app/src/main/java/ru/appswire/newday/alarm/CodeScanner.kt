package ru.appswire.newday.alarm

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Чтение QR и штрих-кодов камерой.
 *
 * Всё происходит на телефоне: zxing разбирает кадр сам, без сервисов Google и
 * без сети. Это не мелочь — сканировать код придётся в шесть утра, и в этот
 * момент интернета может не быть вовсе.
 *
 * Класс живёт в двух местах и одинаково: на экране будильника (отсканируй, чтобы
 * выключить) и в настройках (привяжи код). Один и тот же сканер в обоих —
 * иначе привязанный код мог бы не читаться тем, что стоит на будильнике.
 */
class CodeScanner(
    private val context: Context,
    private val onCode: (String) -> Unit,
) : LifecycleOwner {

    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry

    private var executor: ExecutorService? = null
    private var provider: ProcessCameraProvider? = null

    // пишется с главного потока, читается из analyzer-потока: без @Volatile
    // кадр в полёте может не увидеть остановку и позвать onCode после stop()
    @Volatile private var stopped = false

    /*
     * Ридер один на сканер и настроен на попытку получше.
     *
     * TRY_HARDER стоит нарочно: код будет наклеен на чайник и снят под углом
     * в темноте одной рукой. Лишние миллисекунды на кадр здесь ничего не стоят,
     * а нечитающийся код стоит того, что будильник не выключается.
     */
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.TRY_HARDER to true))
    }

    /** Видоискатель, который надо положить в разметку. */
    val view: FrameLayout = FrameLayout(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
    }

    private val previewView = PreviewView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        scaleType = PreviewView.ScaleType.FILL_CENTER
    }

    init {
        view.addView(previewView)
        registry.currentState = Lifecycle.State.CREATED
    }

    /**
     * Запуск камеры. [onFail] зовётся, если её нет или в ней отказано — вызвавший
     * должен показать другой путь, а не пустой чёрный прямоугольник.
     * [onReady] — когда камера действительно открылась: подпись «открываю
     * камеру» не должна висеть поверх уже живого видоискателя.
     */
    fun start(onFail: (String) -> Unit, onReady: () -> Unit = {}) {
        if (!hasCamera(context)) { onFail("камеры нет"); return }
        if (!hasPermission(context)) { onFail("нет разрешения на камеру"); return }

        executor = Executors.newSingleThreadExecutor()
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                val cameraProvider = future.get()
                provider = cameraProvider
                if (stopped) { cameraProvider.unbindAll(); return@addListener }

                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { it.setAnalyzer(executor!!, ::analyze) }

                cameraProvider.unbindAll()
                registry.currentState = Lifecycle.State.RESUMED
                cameraProvider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis,
                )
                onReady()
            } catch (e: Exception) {
                Log.w("NewDayAlarm", "камера не открылась: " + e.message)
                onFail("камера не открылась")
            }
        }, androidx.core.content.ContextCompat.getMainExecutor(context))
    }

    /**
     * Разбор кадра.
     *
     * Кадр от камеры лежит в ориентации матрицы, а не в той, в которой его
     * видит человек: телефон в руке стоит вертикально, матрица в нём — на боку.
     * Поэтому кадр сначала доворачивают (см. [CodeFrame]), и только потом
     * отдают zxing.
     */
    @SuppressLint("UnsafeOptInUsageError")
    private fun analyze(image: ImageProxy) {
        try {
            if (stopped) return
            val plane = image.planes.firstOrNull() ?: return
            val buffer = plane.buffer
            val data = ByteArray(buffer.remaining())
            buffer.get(data)

            val frame = CodeFrame.upright(
                data, plane.rowStride, image.width, image.height,
                image.imageInfo.rotationDegrees,
            )
            val text = CodeFrame.read(reader, frame)?.trim().orEmpty()
            if (text.isEmpty()) return
            stopped = true
            view.post { onCode(text) }
        } catch (e: Exception) {
            Log.w("NewDayAlarm", "кадр не разобрался: " + e.message)
        } finally {
            reader.reset()
            image.close()
        }
    }

    /**
     * Остановка.
     *
     * Камеру надо отпускать явно: оставленная включённой, она держит железо и
     * ест батарею, а индикатор камеры продолжает гореть — человек справедливо
     * решает, что за ним подсматривают.
     */
    fun stop() {
        stopped = true
        try { provider?.unbindAll() } catch (e: Exception) { /* уже отвязано */ }
        registry.currentState = Lifecycle.State.DESTROYED
        executor?.shutdown()
        executor = null
        provider = null
    }

    companion object {
        fun hasCamera(context: Context): Boolean =
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

        // ContextCompat, а не Context.checkSelfPermission: тот появился в API 23,
        // а мы поддерживаем 22, где разрешения выдаются при установке
        fun hasPermission(context: Context): Boolean =
            androidx.core.content.ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.CAMERA,
            ) == PackageManager.PERMISSION_GRANTED
    }
}

/**
 * Кадр камеры, приведённый к тому, что видит человек, и его разбор.
 *
 * Вынесено из [CodeScanner] нарочно: камеру в юнит-тесте не открыть, а ломалось
 * именно здесь — и ломалось молча, «через раз». Теперь это проверяется без
 * телефона, см. CodeFrameTest.
 */
internal object CodeFrame {

    /** Яркость кадра построчно, без выравнивания: шаг строки равен ширине. */
    class Luma(val data: ByteArray, val width: Int, val height: Int)

    /**
     * Кадр в ориентации человека.
     *
     * Две вещи, на которых терялся штрих-код.
     *
     * Первая — поворот. ImageAnalysis отдаёт кадр как есть с матрицы, а она в
     * телефоне повёрнута: у вертикально стоящего телефона кадр лежит на боку, и
     * `rotationDegrees` говорит, на сколько его довернуть. QR это переживает —
     * он читается под любым углом, — а штрих-код нет: zxing ищет его,
     * просматривая строки кадра, и у кода, повёрнутого на четверть, полосы идут
     * вдоль строки, а не поперёк. Поэтому доворачиваем сами:
     * PlanarYUVLuminanceSource поворот не поддерживает, и TRY_HARDER, который
     * умеет повторить попытку на повёрнутом кадре, на нём не срабатывает.
     *
     * Вторая — [rowStride]. У камеры он больше ширины: строки выровнены по
     * границе, и хвост каждой строки — не изображение. Здесь выравнивание
     * снимается, чтобы дальше никто не путал ширину кадра с шагом строки.
     */
    fun upright(y: ByteArray, rowStride: Int, width: Int, height: Int, rotation: Int): Luma {
        val turn = ((rotation % 360) + 360) % 360
        val quarter = turn == 90 || turn == 270
        val w = if (quarter) height else width
        val h = if (quarter) width else height
        val out = ByteArray(w * h)
        var i = 0
        for (dy in 0 until h) {
            for (dx in 0 until w) {
                val sx: Int
                val sy: Int
                when (turn) {
                    90 -> { sx = dy; sy = height - 1 - dx }
                    180 -> { sx = width - 1 - dx; sy = height - 1 - dy }
                    270 -> { sx = width - 1 - dy; sy = dx }
                    else -> { sx = dx; sy = dy }
                }
                val src = sy * rowStride + sx
                // последняя строка в буфере бывает короче полного шага —
                // берём, что есть, вместо падения на границе массива
                out[i++] = if (src < y.size) y[src] else 0
            }
        }
        return Luma(out, w, h)
    }

    /**
     * Прочитать код в кадре: сначала как он есть, потом развернув на четверть.
     *
     * Второй проход — для штрих-кода. Наклейка на чайнике может быть наклеена
     * боком, и телефон в шесть утра держат как попало; QR находится на первом
     * проходе и до второго не доходит.
     */
    fun read(reader: MultiFormatReader, frame: Luma): String? =
        decode(reader, frame) ?: decode(reader, quarterTurn(frame))

    /**
     * Окно разбора: вся ширина кадра и середина по высоте.
     *
     * По бокам не обрезаем — именно так пропадал штрих-код: в видоискателе он
     * виден целиком, а разбиралась только середина кадра, и концы кода со
     * старт-стоп полосами оставались за краем окна. По высоте берём середину:
     * это ровно то, что показывает видоискатель, и чужой код, попавший в кадр
     * сверху или снизу, в привязку не уедет.
     */
    private fun decode(reader: MultiFormatReader, f: Luma): String? {
        val band = minOf(f.height, f.width)
        val top = (f.height - band) / 2
        val source = PlanarYUVLuminanceSource(
            f.data, f.width, f.height, 0, top, f.width, band, false,
        )
        return try {
            reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
        } catch (e: Exception) {
            // кадра без кода в потоке большинство — это не ошибка
            null
        }
    }

    /** Тот же кадр на четверть оборота: сам PlanarYUVLuminanceSource так не умеет. */
    private fun quarterTurn(f: Luma): Luma =
        upright(f.data, f.width, f.width, f.height, 90)
}
