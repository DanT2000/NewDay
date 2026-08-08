package ru.appswire.newday.alarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.GregorianCalendar
import java.util.TimeZone

/**
 * Пересчёт будильников по местному времени.
 *
 * Проверяется без телефона нарочно: арифметика здесь чистая, а стенд для смены
 * пояса дорогой и медленный — на нём проверяется, что система вообще присылает
 * такое событие, а не то, что 07:00 остаётся 07:00.
 */
class TimeShiftTest {

    private val msk = TimeZone.getTimeZone("Europe/Moscow")       // UTC+3, без летнего времени
    private val nsk = TimeZone.getTimeZone("Asia/Novosibirsk")    // UTC+7, без летнего времени
    private val berlin = TimeZone.getTimeZone("Europe/Berlin")    // с переходом на летнее время

    /** Момент эпохи по времени UTC — чтобы ожидания не зависели от пояса машины. */
    private fun utc(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long =
        GregorianCalendar(TimeZone.getTimeZone("UTC")).apply { clear(); set(y, mo - 1, d, h, mi, 0) }
            .timeInMillis

    private fun wakeup(
        fireAt: Long,
        date: String,
        localHm: String = "",
        snoozed: Boolean = false,
        id: Long = 42,
    ) = Alarm(
        id = id, fireAt = fireAt, title = "Подъём", body = "вставать",
        kind = "alarm", profile = "wakeup", date = date, snoozed = snoozed, localHm = localHm,
    )

    // ── Местное время из момента эпохи и обратно ──────────────

    @Test
    fun `местное время выводится из fireAt и пояса`() {
        val at = utc(2026, 8, 10, 4, 0)               // 07:00 в Москве
        assertEquals("07:00", TimeShift.hmOf(at, msk))
        assertEquals("2026-08-10", TimeShift.dateOf(at, msk))
        // тот же момент в Новосибирске — уже 11:00
        assertEquals("11:00", TimeShift.hmOf(at, nsk))
    }

    @Test
    fun `местные дата и время превращаются в момент эпохи по правилам пояса`() {
        assertEquals(utc(2026, 8, 10, 4, 0), TimeShift.epochOf("2026-08-10", "07:00", msk))
        assertEquals(utc(2026, 8, 10, 0, 0), TimeShift.epochOf("2026-08-10", "07:00", nsk))
    }

    @Test
    fun `мусор вместо даты или времени ничего не даёт`() {
        assertNull(TimeShift.epochOf("", "07:00", msk))
        assertNull(TimeShift.epochOf("2026-08-10", "", msk))
        assertNull(TimeShift.epochOf("10.08.2026", "07:00", msk))
        assertNull(TimeShift.epochOf("2026-08-10", "25:00", msk))
    }

    // ── Отметка ───────────────────────────────────────────────

    @Test
    fun `отметка пишет то время, которое человек видел`() {
        val a = TimeShift.stamp(wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10"), msk)
        assertEquals("07:00", a.localHm)
    }

    @Test
    fun `отложенный не размечается — «через 5 минут» не привязано к местному времени`() {
        val a = wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10", snoozed = true)
        assertEquals("", TimeShift.stamp(a, msk).localHm)
    }

    @Test
    fun `проверочный будильник не размечается`() {
        val a = wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10", id = AlarmScheduler.TEST_ALARM_ID)
        assertEquals("", TimeShift.stamp(a, msk).localHm)
    }

    @Test
    fun `без даты размечать нечего`() {
        assertEquals("", TimeShift.stamp(wakeup(utc(2026, 8, 10, 4, 0), ""), msk).localHm)
    }

    @Test
    fun `дата расписания не совпала с местной — отметки нет`() {
        // пояс профиля и пояс телефона разные: тот же момент в Новосибирске
        // приходится уже на другие сутки, и отметка означала бы не то время,
        // которое человек назначал
        val a = wakeup(utc(2026, 8, 10, 20, 0), "2026-08-10")   // 03:00 11-го в Новосибирске
        assertEquals("", TimeShift.stamp(a, nsk).localHm)
    }

    // ── Пересчёт ──────────────────────────────────────────────

    @Test
    fun `подъём переезжает на то же местное время нового пояса`() {
        val a = TimeShift.stamp(wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10"), msk)
        val shift = TimeShift.recompute(listOf(a), nsk, now = utc(2026, 8, 9, 12, 0))
        assertEquals(1, shift.moved)
        assertEquals(0, shift.past)
        assertEquals(utc(2026, 8, 10, 0, 0), shift.alarms[0].fireAt)
        assertEquals("07:00", TimeShift.hmOf(shift.alarms[0].fireAt, nsk))
    }

    @Test
    fun `тот же пояс — ничего не двигаем`() {
        val a = TimeShift.stamp(wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10"), msk)
        val shift = TimeShift.recompute(listOf(a), msk, now = utc(2026, 8, 9, 12, 0))
        assertEquals(0, shift.moved)
        assertEquals(a, shift.alarms[0])
    }

    @Test
    fun `отложенный будильник пересчёт не трогает`() {
        // отметка у него могла остаться с прошлой жизни строки — всё равно не трогаем
        val a = wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10", localHm = "07:00", snoozed = true)
        val shift = TimeShift.recompute(listOf(a), nsk, now = utc(2026, 8, 9, 12, 0))
        assertEquals(0, shift.moved)
        assertEquals(a.fireAt, shift.alarms[0].fireAt)
    }

    @Test
    fun `будильник прежней сборки без отметки продолжает звонить по fireAt`() {
        val a = wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10")     // localHm пуст
        val shift = TimeShift.recompute(listOf(a), nsk, now = utc(2026, 8, 9, 12, 0))
        assertEquals(0, shift.moved)
        assertEquals(a, shift.alarms[0])
    }

    @Test
    fun `пересчитанное время уже прошло — оставляем как было, не звоним`() {
        // перелёт на восток: местное 07:00 в новом поясе наступило, пока человек
        // был в воздухе. Сдвинуть будильник в прошлое — значит заорать в самолёте.
        val a = TimeShift.stamp(wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10"), msk)
        val shift = TimeShift.recompute(listOf(a), nsk, now = utc(2026, 8, 10, 2, 0))
        assertEquals(0, shift.moved)
        assertEquals(1, shift.past)
        assertEquals(a.fireAt, shift.alarms[0].fireAt)
    }

    @Test
    fun `уже прошедший будильник не оживает`() {
        val a = TimeShift.stamp(wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10"), msk)
        val shift = TimeShift.recompute(listOf(a), nsk, now = utc(2026, 8, 10, 5, 0))
        assertEquals(0, shift.moved)
        assertEquals(a, shift.alarms[0])
    }

    // ── Летнее время ──────────────────────────────────────────

    @Test
    fun `переход на летнее время не сдвигает подъём`() {
        // 29 марта 2026 Берлин переходит на летнее время: 07:00 до и после
        // перехода — это разные моменты эпохи, и пересчёт обязан считать по
        // правилам пояса, а не по разнице смещений
        val before = TimeShift.stamp(wakeup(utc(2026, 3, 28, 6, 0), "2026-03-28"), berlin)
        val after = TimeShift.stamp(wakeup(utc(2026, 3, 29, 5, 0), "2026-03-29", id = 43), berlin)
        assertEquals("07:00", before.localHm)
        assertEquals("07:00", after.localHm)
        val shift = TimeShift.recompute(listOf(before, after), berlin, now = utc(2026, 3, 27, 0, 0))
        assertEquals(0, shift.moved)
    }

    @Test
    fun `будильник на несуществующее местное время звонит сразу после перевода часов`() {
        // 02:30 в ночь перехода на летнее время не существует вовсе: часы
        // прыгают с 02:00 на 03:00. Такой будильник должен прозвенеть, а не
        // пропасть — снисходительный календарь отдаёт 03:30.
        val at = TimeShift.epochOf("2026-03-29", "02:30", berlin)
        assertEquals(utc(2026, 3, 29, 1, 30), at)
        assertEquals("03:30", TimeShift.hmOf(at!!, berlin))
    }

    // ── Дорога через json ─────────────────────────────────────

    @Test
    fun `отметка переживает дорогу в json и обратно`() {
        val a = TimeShift.stamp(wakeup(utc(2026, 8, 10, 4, 0), "2026-08-10"), msk)
        assertEquals(a, Alarm.fromJson(org.json.JSONObject(a.toJson().toString())))
        // будильник от прежней сборки читается без отметки и не ломается
        val old = Alarm.fromJson(
            org.json.JSONObject("""{"id":1,"fireAt":123,"kind":"alarm","date":"2026-08-10"}"""),
        )
        assertEquals("", old.localHm)
    }
}
