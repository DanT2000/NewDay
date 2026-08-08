package ru.appswire.newday.update

import android.content.pm.ApplicationInfo
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Что за версия приложения стоит на телефоне.
 *
 * Обновляет приложение магазин, а не оно само. Раньше здесь была установка
 * обновления с сайта: скачать APK и показать его системному установщику. Для
 * этого требовалось REQUEST_INSTALL_PACKAGES — самое подозрительное разрешение
 * из всех, через него распространяют вредоносное, — и каждый магазин требовал
 * его отдельно обосновывать. Google Play такое обновление запрещает прямо, а в
 * RuStore обновляет сам магазин; людей, которые ставили APK с сайта и которым
 * это могло пригодиться, не появилось. Всё это убрано целиком: не осталось ни
 * разрешения, ни FileProvider, ни кода скачивания.
 *
 * Версию берём из самого пакета, а не из настроек: настройки могут отстать от
 * установленного, и тогда «текущая версия» на экране врёт.
 */
@CapacitorPlugin(name = "NewDayUpdate")
class UpdatePlugin : Plugin() {

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
                /*
                 * selfUpdate остаётся в ответе и всегда false: по нему веб-часть
                 * понимает, что предлагать установку не нужно, и молчит. Убрать
                 * поле значило бы сломать эту проверку у старых экранов.
                 */
                .put("selfUpdate", false)
                .put("canInstall", false)
                .put("debuggable", (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0),
        )
    }
}
