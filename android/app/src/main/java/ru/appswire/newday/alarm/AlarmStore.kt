package ru.appswire.newday.alarm

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.UserManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Локальный список будильников.
 *
 * Хранится на устройстве, потому что будильник обязан сработать без сети:
 * сервер может быть недоступен ровно в тот момент, когда нужно вставать.
 * После перезагрузки телефона всё перепланируется отсюда же.
 */
object AlarmStore {
    private const val TAG = "NewDayAlarm"
    private const val PREFS = "newday_alarms"
    private const val KEY_ALARMS = "alarms"
    private const val KEY_CONFIG = "dismiss_config"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_ACCENT = "accent"
    private const val KEY_FIRED = "fired_ids"

    /*
     * Перенос в device-protected пробуется один раз на запуск процесса.
     *
     * moveSharedPreferencesFrom требует, чтобы файл не был открыт, поэтому
     * трогаем его до первого обращения к настройкам и больше в этом процессе
     * не возвращаемся: удавшийся перенос второй раз не нужен (источника уже
     * нет), а неудавшийся будет повторён при следующем запуске.
     */
    @Volatile private var moveTried = false
    @Volatile private var moveOk = false

    private fun prefs(ctx: Context): SharedPreferences =
        storageCtx(ctx).getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Где лежат будильники: в device-protected, а не в обычном хранилище.
     *
     * Обычное (credential-protected) на телефонах с шифрованием файлов — а это
     * почти всё, начиная с Android 10 — недоступно до первой разблокировки.
     * Телефон, перезагрузившийся ночью сам, утром до разблокировки не смог бы
     * даже прочитать список будильников: приёмник просыпался бы и ничего не
     * находил. Device-protected доступно сразу после включения, ещё до ввода
     * пина, — там же, где живёт приёмник с directBootAware.
     *
     * Уже стоящие будильники переносим на новое место один раз
     * (moveSharedPreferencesFrom). Перенос может не удаться — например, файл
     * занят, — и тогда старые данные остаются целыми на прежнем месте: пока
     * телефон отперт, работаем с ними там, а перенос повторится при следующем
     * запуске. До разблокировки прежнего места нет вовсе, поэтому остаётся
     * device-protected: пустой список хуже настоящего, но падение приёмника
     * сразу после включения телефона — хуже всего.
     */
    private fun storageCtx(ctx: Context): Context {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return ctx   // до 7 шифрования файлов нет
        if (ctx.isDeviceProtectedStorage) return ctx                    // уже оно
        val dev = try {
            ctx.createDeviceProtectedStorageContext()
        } catch (e: Exception) {
            Log.e(TAG, "Нет device-protected хранилища: " + e.message)
            return ctx
        }
        if (!moveTried) {
            moveTried = true
            moveOk = try {
                // true и когда переносить было нечего — на чистой установке
                dev.moveSharedPreferencesFrom(ctx, PREFS)
            } catch (e: Exception) {
                Log.e(TAG, "Перенос будильников в device-protected сорвался: " + e.message)
                false
            }
            if (!moveOk) Log.e(TAG, "Будильники остались в обычном хранилище — повторю при следующем запуске")
        }
        if (moveOk) return dev
        return if (userUnlocked(ctx)) ctx else dev
    }

    private fun userUnlocked(ctx: Context): Boolean = try {
        (ctx.getSystemService(Context.USER_SERVICE) as UserManager).isUserUnlocked
    } catch (e: Exception) {
        false
    }

    /**
     * Список будильников пишем сразу на диск, а не отложенно.
     *
     * `apply()` возвращает управление до записи, и телефон, выключенный или
     * убитый в этот момент, теряет список — а значит и будильник. Для сотни
     * байт раз в несколько минут `commit()` ничего не стоит, зато после
     * выключения питания список на месте и будильник восстанавливается.
     */
    fun save(ctx: Context, alarms: List<Alarm>) {
        val arr = JSONArray()
        alarms.forEach { arr.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY_ALARMS, arr.toString()).commit()
    }

    fun load(ctx: Context): List<Alarm> = try {
        Alarm.listFromJson(JSONArray(prefs(ctx).getString(KEY_ALARMS, "[]")))
    } catch (e: Exception) {
        emptyList()
    }

    fun find(ctx: Context, id: Long): Alarm? = load(ctx).firstOrNull { it.id == id }

    fun saveConfig(ctx: Context, config: DismissConfig) {
        // commit, как и у списка: сюда пишется привязанный код, и отложенная
        // запись, потерянная при выключении питания, съела бы привязку —
        // утром вместо QR был бы пример, а человек решил бы, что «не сохранилось»
        prefs(ctx).edit().putString(KEY_CONFIG, config.toJson().toString()).commit()
    }

    fun config(ctx: Context): DismissConfig = try {
        DismissConfig.fromJson(JSONObject(prefs(ctx).getString(KEY_CONFIG, "{}")!!))
    } catch (e: Exception) {
        DismissConfig.DEFAULT
    }

    fun setEnabled(ctx: Context, enabled: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    /**
     * Цвет оформления. Экран будильника рисуется нативно, до вебвью в шесть
     * утра дело не доходит, — поэтому выбранный человеком цвет приходится
     * хранить и здесь, иначе будильник выглядел бы чужим приложением.
     */
    fun setAccent(ctx: Context, accent: String) {
        prefs(ctx).edit().putString(KEY_ACCENT, accent).apply()
    }

    fun accent(ctx: Context): String = prefs(ctx).getString(KEY_ACCENT, "violet") ?: "violet"

    /**
     * Отметка «это срабатывание уже было».
     *
     * Нужна для пропущенных. Телефон, выключенный в момент звонка, о будильнике
     * забывает совсем: после включения его время уже прошло, и планировщик
     * молча отбрасывал его — человек просто не просыпался. Теперь недавно
     * пропущенный звонит сразу после загрузки, но тогда нужен и способ не
     * зазвонить второй раз: список будильников приходит из веб-части при каждой
     * синхронизации, и прошедший будильник без отметки звонил бы снова и снова.
     *
     * Ключ — номер вместе с временем срабатывания, а не один номер. Иначе
     * повторяющийся будильник, у которого номер один на все дни, после первого
     * же звонка считался бы отработавшим навсегда — и завтрашний подъём тихо
     * пропадал бы. Поймалось это проверкой: «пропущенный после включения»
     * падал ровно потому, что тот же номер уже звонил в предыдущем сценарии.
     */
    fun markFired(ctx: Context, id: Long, fireAt: Long) {
        val fired = firedKeys(ctx).toMutableList()
        val key = "$id@$fireAt"
        if (fired.contains(key)) return
        fired.add(key)
        // держим сотню последних: список не должен расти бесконечно
        prefs(ctx).edit().putStringSet(KEY_FIRED, fired.takeLast(100).toSet()).commit()
    }

    /**
     * Снять отметку: срабатывания не было.
     *
     * Нужно приёмнику, когда система отказалась поднять службу и будильник не
     * зазвонил вовсе. Без этого он остаётся «отработавшим» и логика пропущенных
     * о нём уже не вспомнит.
     */
    fun unmarkFired(ctx: Context, id: Long, fireAt: Long) {
        val key = "$id@$fireAt"
        val fired = firedKeys(ctx)
        if (!fired.contains(key)) return
        prefs(ctx).edit().putStringSet(KEY_FIRED, (fired - key).toSet()).commit()
    }

    fun hasFired(ctx: Context, id: Long, fireAt: Long): Boolean =
        firedKeys(ctx).contains("$id@$fireAt")

    private fun firedKeys(ctx: Context): List<String> =
        (prefs(ctx).getStringSet(KEY_FIRED, emptySet()) ?: emptySet()).toList()

    fun isEnabled(ctx: Context) = prefs(ctx).getBoolean(KEY_ENABLED, true)

    /** Убирает то, что уже отзвонило: список не должен расти бесконечно. */
    fun prune(ctx: Context, now: Long = System.currentTimeMillis()) {
        save(ctx, load(ctx).filter { it.fireAt > now - 12 * 60 * 60 * 1000 })
    }
}
