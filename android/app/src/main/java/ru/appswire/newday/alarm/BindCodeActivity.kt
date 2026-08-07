package ru.appswire.newday.alarm

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Привязка кода в настройках: «вот этот код я буду искать по утрам».
 *
 * Сканер здесь тот же, что на экране будильника (`CodeScanner`), и это главное
 * в этом экране. Разные сканеры расходятся в мелочах — угол, освещение, размер
 * кода, — и код, привязанный одним, мог бы не читаться другим. Обнаружилось бы
 * это в шесть утра.
 *
 * Хранится значение кода, а не картинка: сверяется содержимое, и подойдёт любой
 * код с тем же содержимым — можно распечатать второй экземпляр, если первый
 * отклеился.
 */
class BindCodeActivity : Activity() {

    private var scanner: CodeScanner? = null
    private var frame: FrameLayout? = null
    private lateinit var ui: Ui
    private lateinit var hint: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = Ui(this)
        val accent = Style.accent(AlarmStore.accent(this))
        window.statusBarColor = Style.BG
        window.navigationBarColor = Style.BG

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Style.BG)
            setPadding(ui.dp(20), ui.dp(36), ui.dp(20), ui.dp(24))
        }
        column.addView(ui.cap("ПРИВЯЗКА КОДА", accent))
        column.addView(ui.spacer(12))
        column.addView(ui.title("Наведите на код", 26f))
        column.addView(ui.spacer(8))
        column.addView(
            ui.body(
                "Подойдёт любой QR или штрих-код: наклейка на чайнике, этикетка "
                    + "на пачке кофе, код на коробке. Главное — чтобы он был не у кровати.",
                14f, Style.DIM,
            ),
        )
        column.addView(ui.spacer(18))

        val frame = FrameLayout(this).apply {
            background = rounded(Style.RAISE, ui.dp(18))
            clipToOutline = true
            layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(300))
        }
        column.addView(frame)
        column.addView(ui.spacer(14))

        hint = ui.body("Открываю камеру…", 13f, Style.FAINT)
        column.addView(hint)
        column.addView(ui.spacer(18))
        column.addView(
            ui.quiet("Отмена") { setResult(Activity.RESULT_CANCELED); finish() }.apply {
                layoutParams = LinearLayout.LayoutParams(MATCH, ui.dp(48))
            },
        )
        setContentView(column)
        this.frame = frame

        // До Android 6 разрешения выдавались при установке — спрашивать нечего
        if (!CodeScanner.hasPermission(this) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(arrayOf(android.Manifest.permission.CAMERA), REQ_CAMERA)
        } else {
            startScanner(frame)
        }
    }

    private fun startScanner(frame: FrameLayout) {
        val cam = CodeScanner(this) { text -> done(text) }
        scanner = cam
        frame.addView(cam.view)
        cam.start(
            onFail = { why -> hint.text = why },
            onReady = { hint.text = "Ищу код — держите его в рамке" },
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            frame?.let { startScanner(it) }
        } else {
            // Без камеры привязывать нечего. Говорим прямо и закрываемся —
            // с паузой, чтобы причину успели прочесть: экран с пустым
            // прямоугольником ничего не объясняет.
            hint.text = "Без доступа к камере код не привязать"
            setResult(Activity.RESULT_CANCELED)
            hint.postDelayed({ if (!isFinishing) finish() }, 1600)
        }
    }

    private fun done(text: String) {
        scanner?.stop()
        setResult(Activity.RESULT_OK, Intent().putExtra("code", text))
        finish()
    }

    override fun onDestroy() {
        scanner?.stop()
        scanner = null
        super.onDestroy()
    }

    companion object {
        private const val REQ_CAMERA = 4711
        private const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
    }
}
