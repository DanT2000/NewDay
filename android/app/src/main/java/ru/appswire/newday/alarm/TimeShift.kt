package ru.appswire.newday.alarm

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

/**
 * Будильник после смены часового пояса.
 *
 * Будильники стоят по абсолютному времени эпохи, и это правильно: система
 * умеет только так. Но человек ставил не момент эпохи, а «подъём в 07:00», и
 * после перелёта тот же момент — уже 11:00 или 03:00: будильник звонит по
 * прежнему поясу, пока приложение не откроют и оно не пересчитает расписание.
 *
 * Чинится это без веб-части и без изменения формата обмена: в момент
 * постановки нативная часть знает и fireAt, и пояс телефона, — значит может
 * вывести из них местное время и сохранить рядом ([Alarm.localHm]). Когда
 * система сообщает о смене пояса или переводе часов, fireAt пересчитывается на
 * то же местное время в новом поясе.
 *
 * Вся арифметика здесь — чистая: пояс и «сейчас» приходят снаружи, поэтому
 * проверяется она юнит-тестами, без телефона.
 */
object TimeShift {

    /** Что получилось из пересчёта — чтобы приёмник мог честно это записать. */
    data class Shift(
        val alarms: List<Alarm>,
        /** Сколько будильников переехало на новое время. */
        val moved: Int,
        /** Сколько оставлено как есть, потому что пересчитанное время уже прошло. */
        val past: Int,
    )

    /** «HH:mm» — местное время момента [at] в поясе [zone]. */
    fun hmOf(at: Long, zone: TimeZone): String = cal(zone, at).let {
        String.format(
            Locale.US, "%02d:%02d",
            it.get(Calendar.HOUR_OF_DAY), it.get(Calendar.MINUTE),
        )
    }

    /** «YYYY-MM-DD» — местная дата момента [at] в поясе [zone]. */
    fun dateOf(at: Long, zone: TimeZone): String = cal(zone, at).let {
        String.format(
            Locale.US, "%04d-%02d-%02d",
            it.get(Calendar.YEAR), it.get(Calendar.MONTH) + 1, it.get(Calendar.DAY_OF_MONTH),
        )
    }

    /**
     * Обратный ход: местные дата и время в поясе — в момент эпохи.
     *
     * Календарь нарочно оставлен снисходительным (lenient). В ночь перехода на
     * летнее время местного «02:30» не существует вовсе, и снисходительный
     * календарь отдаёт 03:30 — то есть будильник звонит сразу, как только это
     * время наступает. Строгий бросил бы исключение, и будильник пропал бы.
     * В ночь обратного перехода «02:30» бывает дважды, и берётся первое из них:
     * подъём раньше на час — неприятно, но не так, как подъём позже.
     *
     * null — разобрать не получилось; такой будильник трогать нельзя.
     */
    fun epochOf(date: String, hm: String, zone: TimeZone): Long? {
        val d = date.split("-")
        val t = hm.split(":")
        if (d.size != 3 || t.size != 2) return null
        val year = d[0].toIntOrNull() ?: return null
        val month = d[1].toIntOrNull() ?: return null
        val day = d[2].toIntOrNull() ?: return null
        val hour = t[0].toIntOrNull() ?: return null
        val minute = t[1].toIntOrNull() ?: return null
        if (month !in 1..12 || day !in 1..31 || hour !in 0..23 || minute !in 0..59) return null
        val c = GregorianCalendar(zone)
        // clear обязателен: иначе в календаре остаются секунды и миллисекунды
        // «сейчас», и пересчитанный будильник каждый раз слегка разъезжается
        c.clear()
        c.set(year, month - 1, day, hour, minute, 0)
        return c.timeInMillis
    }

    /**
     * Поставить отметку местного времени.
     *
     * Зовётся там, где приходит расписание из веб-части: только оно знает, что
     * будильник действительно должен звонить в это местное время.
     *
     * Не размечаются:
     *  - отложенные кнопкой «Отложить»: «через 5 минут» ни к какому местному
     *    времени не привязано, и переносить их по поясу нельзя;
     *  - проверочный будильник из настроек: он тоже относительный, «через минуту»;
     *  - строки без даты: пересчитывать нечего — неизвестен день;
     *  - строки, у которых местная дата в поясе телефона не совпадает с датой
     *    расписания. Так бывает, когда пояс профиля и пояс телефона разные:
     *    отметка получилась бы не тем временем, которое человек назначал, и
     *    смена пояса увела бы будильник на сутки. Такой пусть звонит по fireAt,
     *    а расписание поправит первая же синхронизация.
     */
    fun stamp(alarm: Alarm, zone: TimeZone): Alarm {
        if (alarm.snoozed) return alarm
        if (alarm.id == AlarmScheduler.TEST_ALARM_ID) return alarm
        if (alarm.date.isBlank()) return alarm
        if (dateOf(alarm.fireAt, zone) != alarm.date) return alarm
        val hm = hmOf(alarm.fireAt, zone)
        return if (alarm.localHm == hm) alarm else alarm.copy(localHm = hm)
    }

    fun stampAll(alarms: List<Alarm>, zone: TimeZone = TimeZone.getDefault()): List<Alarm> =
        alarms.map { stamp(it, zone) }

    /**
     * Пересчитать будильники на то же местное время в поясе [zone].
     *
     * Оставляем как есть:
     *  - без отметки местного времени — сборка обновилась поверх старой, и
     *    отметку ставить уже неоткуда: пусть звонит по fireAt, чем пропадёт;
     *  - отложенные: «через 5 минут» — это про пять минут, а не про 07:00;
     *  - уже прошедшие: их дело закрыто, а логика пропущенных разберётся сама;
     *  - те, чьё пересчитанное время уже прошло. Это перелёт на восток: местное
     *    07:00 в новом поясе наступило, пока человек был в воздухе. Звонить в
     *    этот момент нельзя — будильник заорёт в самолёте, — а переносить на
     *    следующие сутки значит выдумать за человека расписание, которого он не
     *    задавал. Оставляем прежний момент: будильник хотя бы существует и
     *    прозвенит, а расписание поправит первая же синхронизация.
     */
    fun recompute(
        alarms: List<Alarm>,
        zone: TimeZone = TimeZone.getDefault(),
        now: Long = System.currentTimeMillis(),
    ): Shift {
        var moved = 0
        var past = 0
        val out = alarms.map { a ->
            if (a.localHm.isBlank() || a.snoozed || a.fireAt <= now) return@map a
            val want = epochOf(a.date, a.localHm, zone) ?: return@map a
            if (want == a.fireAt) return@map a
            if (want <= now) { past += 1; return@map a }
            moved += 1
            a.copy(fireAt = want)
        }
        return Shift(out, moved, past)
    }

    private fun cal(zone: TimeZone, at: Long): Calendar =
        GregorianCalendar(zone).apply { timeInMillis = at }
}
