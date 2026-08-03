package ru.appswire.newday.alarm

import org.json.JSONArray
import org.json.JSONObject

/**
 * Один запланированный будильник или напоминание.
 *
 * profile решает, насколько настойчиво он себя ведёт:
 *  - WAKEUP — подъём: задачи обязательны, громкость нарастает, отложить нельзя;
 *  - GENTLE — совещание или дневной сон: тише, одна задача, «отложить» доступно.
 */
data class Alarm(
    val id: Long,
    val fireAt: Long,          // мс эпохи
    val title: String,
    val body: String,
    val kind: String,          // "alarm" | "notify"
    val profile: String,       // "wakeup" | "gentle"
    val date: String,          // YYYY-MM-DD, для перехода в нужный день
) {
    val isAlarm get() = kind == "alarm"
    val isWakeup get() = profile == "wakeup"

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("fireAt", fireAt)
        put("title", title)
        put("body", body)
        put("kind", kind)
        put("profile", profile)
        put("date", date)
    }

    companion object {
        fun fromJson(o: JSONObject) = Alarm(
            id = o.optLong("id"),
            fireAt = o.optLong("fireAt"),
            title = o.optString("title", "NewDay"),
            body = o.optString("body", ""),
            kind = o.optString("kind", "alarm"),
            profile = o.optString("profile", "gentle"),
            date = o.optString("date", ""),
        )

        fun listFromJson(arr: JSONArray): List<Alarm> =
            (0 until arr.length()).map { fromJson(arr.getJSONObject(it)) }
    }
}

/**
 * Настройки экрана отключения. Приходят из веб-части вместе с расписанием.
 *
 * graceSec — «мягкое начало»: столько секунд будильник звучит тихо, и выключить
 * его можно одной кнопкой, без задач. Случай простой: человек уже встал сам, а
 * будильник всё равно звонит — решать в этот момент примеры незачем. Если окно
 * кончилось, значит на будильник не отреагировали, то есть скорее всего спят:
 * громкость идёт вверх, и появляются задачи.
 */
data class DismissConfig(
    val types: List<String>,   // math | code | icons
    val count: Int,
    val difficulty: Int,       // 1..3
    val timeoutSec: Int,
    val snoozeAllowed: Boolean,
    val snoozeMinutes: Int,
    val volumeRamp: Boolean,
    val graceEnabled: Boolean,
    val graceSec: Int,
) {
    /** Сколько длится мягкое начало на самом деле: выключенное окно — это ноль. */
    val effectiveGraceSec get() = if (graceEnabled) graceSec else 0

    fun toJson(): JSONObject = JSONObject().apply {
        put("types", JSONArray(types))
        put("count", count)
        put("difficulty", difficulty)
        put("timeoutSec", timeoutSec)
        put("snoozeAllowed", snoozeAllowed)
        put("snoozeMinutes", snoozeMinutes)
        put("volumeRamp", volumeRamp)
        put("graceEnabled", graceEnabled)
        put("graceSec", graceSec)
    }

    companion object {
        val DEFAULT = DismissConfig(
            types = listOf("math", "code", "icons"), count = 1, difficulty = 1,
            timeoutSec = 30, snoozeAllowed = true, snoozeMinutes = 5, volumeRamp = true,
            graceEnabled = true, graceSec = 60,
        )

        fun fromJson(o: JSONObject?): DismissConfig {
            if (o == null) return DEFAULT
            val arr = o.optJSONArray("types")
            val types = if (arr == null || arr.length() == 0) DEFAULT.types
                        else (0 until arr.length()).map { arr.getString(it) }
            return DismissConfig(
                types = types,
                count = o.optInt("count", DEFAULT.count).coerceIn(1, 5),
                difficulty = o.optInt("difficulty", DEFAULT.difficulty).coerceIn(1, 3),
                timeoutSec = o.optInt("timeoutSec", DEFAULT.timeoutSec).coerceIn(10, 120),
                snoozeAllowed = o.optBoolean("snoozeAllowed", DEFAULT.snoozeAllowed),
                snoozeMinutes = o.optInt("snoozeMinutes", DEFAULT.snoozeMinutes).coerceIn(1, 30),
                volumeRamp = o.optBoolean("volumeRamp", DEFAULT.volumeRamp),
                graceEnabled = o.optBoolean("graceEnabled", DEFAULT.graceEnabled),
                // до 15 минут: дольше — это уже не «успеть выключить»,
                // а будильник, который звонит впустую
                graceSec = o.optInt("graceSec", DEFAULT.graceSec).coerceIn(5, 900),
            )
        }
    }
}
