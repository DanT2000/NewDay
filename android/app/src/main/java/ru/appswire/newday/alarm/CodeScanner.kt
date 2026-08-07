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
     * Берём только середину кадра. Так быстрее и, что важнее, не ловится чужой
     * код, случайно попавший в угол: человек наводит на тот, что нужен.
     */
    @SuppressLint("UnsafeOptInUsageError")
    private fun analyze(image: ImageProxy) {
        try {
            if (stopped) return
            val plane = image.planes.firstOrNull() ?: return
            val buffer = plane.buffer
            val data = ByteArray(buffer.remaining())
            buffer.get(data)

            val w = image.width
            val h = image.height
            val side = (minOf(w, h) * 0.8).toInt()
            val left = (w - side) / 2
            val top = (h - side) / 2

            val source = PlanarYUVLuminanceSource(
                data, plane.rowStride, h, left, top, side, side, false,
            )
            val result = try {
                reader.decodeWithState(BinaryBitmap(HybridBinarizer(source)))
            } catch (e: Exception) {
                // кадра без кода в потоке большинство — это не ошибка
                null
            } ?: return

            val text = result.text?.trim().orEmpty()
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
