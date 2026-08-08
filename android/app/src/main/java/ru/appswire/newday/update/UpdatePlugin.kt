package ru.appswire.newday.update

import ru.appswire.newday.BuildConfig

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Обновление приложения из своего же сервера.
 *
 * Почему скачиваем нативно, а не через fetch в веб-части: страница живёт на
 * origin https://localhost, и записать файл на диск оттуда некуда — а
 * установщику нужен именно файл. Заодно скачивание не прерывается, когда
 * человек сворачивает приложение.
 *
 * Устанавливает не приложение, а системный установщик: мы только показываем
 * ему файл. Подтверждает установку человек, и обновление встанет только если
 * подписано тем же ключом, что установленная версия.
 */
@CapacitorPlugin(name = "NewDayUpdate")
class UpdatePlugin : Plugin() {

    private val tag = "NewDayUpdate"

    /** Что установлено сейчас — версия из самого пакета, а не из настроек. */
    @PluginMethod
    fun getInfo(call: PluginCall) {
        val pm = context.packageManager
        val info = pm.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            info.versionCode.toLong()
        }
        call.resolve(
            JSObject()
                .put("versionName", info.versionName ?: "")
                .put("versionCode", code)
                .put("packageName", context.packageName)
                .put("canInstall", canInstall())
                /*
                 * Умеет ли эта сборка обновлять себя.
                 *
                 * В сборке для Google Play — нет: магазин запрещает обновляться
                 * в обход себя, и разрешения на установку в ней просто нет.
                 * Веб-часть по этому признаку не показывает ни проверку
                 * обновлений, ни полосу загрузки: кнопка, ведущая в отказ,
                 * хуже отсутствующей.
                 */
                .put("selfUpdate", BuildConfig.SELF_UPDATE)
                .put("debuggable", (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0),
        )
    }

    /**
     * Разрешена ли установка из этого приложения.
     *
     * `canRequestPackageInstalls()` не отвечает «нет», когда разрешение вообще
     * не объявлено, — она бросает SecurityException. В сборке для Google Play
     * разрешения нет нарочно, и этот вызов ронял приложение на первом же
     * запуске: экран входа даже не появлялся. Поймано установкой настоящей
     * сборки на устройство, а не тестами.
     */
    private fun canInstall(): Boolean {
        if (!BuildConfig.SELF_UPDATE) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return try {
            context.packageManager.canRequestPackageInstalls()
        } catch (e: SecurityException) {
            false
        }
    }

    /** Ведёт в системный экран «установка неизвестных приложений». */
    @PluginMethod
    fun openInstallSettings(call: PluginCall) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName))
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            call.resolve(JSObject().put("opened", true))
        } catch (e: Exception) {
            call.reject("Не удалось открыть настройки установки: " + e.message)
        }
    }

    /**
     * Скачивает APK и запускает установщик.
     *
     * Прогресс уходит в веб-часть событиями updateProgress: без него на плохой
     * связи выглядит, будто приложение зависло.
     */
    @PluginMethod
    fun downloadAndInstall(call: PluginCall) {
        // В сборке для Play устанавливать нечем — не тянем зря файл
        if (!BuildConfig.SELF_UPDATE) {
            call.reject("Эта сборка обновляется через магазин")
            return
        }
        val url = call.getString("url")
        val versionName = call.getString("versionName") ?: "new"
        if (url.isNullOrBlank()) {
            call.reject("Не задан адрес файла")
            return
        }
        if (!canInstall()) {
            call.reject("NO_INSTALL_PERMISSION")
            return
        }

        Thread {
            try {
                val file = download(url, versionName)
                Log.i(tag, "Скачано ${file.length()} байт → ${file.name}")
                launchInstaller(file)
                call.resolve(JSObject().put("started", true).put("bytes", file.length()))
            } catch (e: Exception) {
                Log.e(tag, "Обновление не установилось: " + e.message)
                call.reject(e.message ?: "Не удалось скачать обновление")
            }
        }.start()
    }

    private fun download(url: String, versionName: String): File {
        val dir = File(context.filesDir, "updates")
        dir.mkdirs()
        // Прошлые загрузки не копим: они больше не нужны, а места занимают
        dir.listFiles()?.forEach { it.delete() }

        val target = File(dir, "NewDay-$versionName.apk")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/vnd.android.package-archive")
        }

        conn.inputStream.use { input ->
            val total = conn.contentLengthLong
            var done = 0L
            var lastReported = -1
            target.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    done += n
                    if (total > 0) {
                        val percent = (done * 100 / total).toInt()
                        if (percent != lastReported) {
                            lastReported = percent
                            notifyListeners(
                                "updateProgress",
                                JSObject().put("percent", percent).put("bytes", done).put("total", total),
                            )
                        }
                    }
                }
            }
        }
        conn.disconnect()

        if (target.length() < 1024) throw IllegalStateException("Файл скачался пустым")
        // APK — это zip, первые байты PK. Проверяем, чтобы не отдать
        // установщику страницу с ошибкой, полученную вместо файла.
        target.inputStream().use {
            val head = ByteArray(2)
            it.read(head)
            if (head[0] != 0x50.toByte() || head[1] != 0x4b.toByte()) {
                throw IllegalStateException("Скачался не APK — проверьте адрес сервера")
            }
        }
        return target
    }

    private fun launchInstaller(file: File) {
        val uri = FileProvider.getUriForFile(
            context, context.packageName + ".fileprovider", file,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val activity: Activity? = this.activity
        if (activity != null) activity.startActivity(intent) else context.startActivity(intent)
    }
}
