package ru.appswire.newday.alarm

import android.content.Context
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
    private const val PREFS = "newday_alarms"
    private const val KEY_ALARMS = "alarms"
    private const val KEY_CONFIG = "dismiss_config"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_ACCENT = "accent"
    private const val KEY_FIRED = "fired_ids"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun save(ctx: Context, alarms: List<Alarm>) {
        val arr = JSONArray()
        alarms.forEach { arr.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY_ALARMS, arr.toString()).apply()
    }

    fun load(ctx: Context): List<Alarm> = try {
        Alarm.listFromJson(JSONArray(prefs(ctx).getString(KEY_ALARMS, "[]")))
    } catch (e: Exception) {
        emptyList()
    }

    fun find(ctx: Context, id: Long): Alarm? = load(ctx).firstOrNull { it.id == id }

    fun saveConfig(ctx: Context, config: DismissConfig) {
        prefs(ctx).edit().putString(KEY_CONFIG, config.toJson().toString()).apply()
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
        prefs(ctx).edit().putStringSet(KEY_FIRED, fired.takeLast(100).toSet()).apply()
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
