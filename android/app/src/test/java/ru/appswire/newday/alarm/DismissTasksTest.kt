package ru.appswire.newday.alarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * Логика задач пробуждения. Проверяется то, что нельзя увидеть глазами на
 * одном прогоне: свойства держатся на сотнях случайных генераций.
 */
class DismissTasksTest {

    private val rnd = Random(7)

    // ── Математика ───────────────────────────────────────────

    @Test
    fun `ответ всегда положительный на любом уровне`() {
        repeat(500) {
            for (level in 1..3) {
                val t = TaskFactory.math(level, rnd)
                assertTrue("уровень $level дал ответ ${t.answer}", t.answer > 0)
            }
        }
    }

    @Test
    fun `первый уровень — однозначные`() {
        repeat(200) {
            val t = TaskFactory.math(1, rnd)
            assertTrue(t.a in 2..9 && t.b in 2..9)
            assertEquals('+', t.op)
        }
    }

    @Test
    fun `вычитание бывает только на третьем уровне и большее число первым`() {
        repeat(200) {
            assertEquals('+', TaskFactory.math(2, rnd).op)
            val t = TaskFactory.math(3, rnd)
            if (t.op == '−') assertTrue("${t.a} − ${t.b}", t.a > t.b)
        }
    }

    // ── QR ───────────────────────────────────────────────────

    private val cfgQr = DismissConfig.DEFAULT.copy(
        types = listOf("qr"), qrValue = "чайник-1", qrLabel = "на чайнике",
    )

    @Test
    fun `qr сверяет содержимое, а не точную строку с пробелами`() {
        val t = TaskFactory.make("qr", cfgQr) as DismissTask.Qr
        assertTrue(t.check("чайник-1"))
        assertTrue(t.check("  чайник-1  "))
        assertFalse(t.check("чайник-2"))
        assertFalse(t.check(""))
    }

    @Test
    fun `qr без привязанного кода превращается в математику`() {
        val unbound = cfgQr.copy(qrValue = "")
        val t = TaskFactory.make("qr", unbound)
        assertTrue("задача без решения недопустима", t is DismissTask.Math)
    }

    @Test
    fun `qr без камеры превращается в математику`() {
        val t = TaskFactory.make("qr", cfgQr, canScan = false)
        assertTrue(t is DismissTask.Math)
    }

    // ── Шаги ─────────────────────────────────────────────────

    @Test
    fun `шаги принимают достигнутую и перевыполненную цель`() {
        val t = DismissTask.Steps(30)
        assertTrue(t.check("30"))
        assertTrue(t.check("31"))
        assertFalse(t.check("29"))
        assertFalse(t.check("мусор"))
    }

    @Test
    fun `шаги без шагомера превращаются в математику`() {
        val cfg = DismissConfig.DEFAULT.copy(types = listOf("steps"))
        val t = TaskFactory.make("steps", cfg, canCountSteps = false)
        assertTrue(t is DismissTask.Math)
    }

    // ── Набор ────────────────────────────────────────────────

    @Test
    fun `невозможные виды выбрасываются из жеребьёвки до раздачи`() {
        // «QR + шаги» на телефоне без шагомера: шагов в наборе быть не должно
        val cfg = DismissConfig.DEFAULT.copy(
            types = listOf("qr", "steps"), count = 5,
            qrValue = "код", qrLabel = "",
        )
        repeat(50) {
            val set = TaskFactory.makeSet(cfg, canScan = true, canCountSteps = false, rnd = rnd)
            assertTrue(set.none { it is DismissTask.Steps })
            assertTrue(set.all { it is DismissTask.Qr })
        }
    }

    @Test
    fun `если не осталось ни одного возможного вида — математика`() {
        val cfg = DismissConfig.DEFAULT.copy(types = listOf("qr", "steps"), qrValue = "")
        val set = TaskFactory.makeSet(cfg, canScan = false, canCountSteps = false, rnd = rnd)
        assertTrue(set.isNotEmpty())
        assertTrue(set.all { it is DismissTask.Math })
    }

    // ── Аварийный выход ──────────────────────────────────────

    @Test
    fun `аварийная задача — математика верхнего уровня`() {
        repeat(100) {
            val t = TaskFactory.rescue(rnd)
            assertTrue("двузначные, а не разминка", t.a >= 10 && t.b >= 10)
            assertTrue(t.answer > 0)
        }
    }

    // ── Настройки ────────────────────────────────────────────

    @Test
    fun `настройки из json держат границы`() {
        val o = org.json.JSONObject(
            """{"stepsTarget": 5000, "rescueAfterSec": 1, "qrValue": "x", "qrLabel": "y"}""",
        )
        val cfg = DismissConfig.fromJson(o)
        assertEquals(200, cfg.stepsTarget)
        assertEquals(30, cfg.rescueAfterSec)
        assertTrue(cfg.qrBound)
    }

    @Test
    fun `настройки без новых полей получают прежние значения по умолчанию`() {
        // старый клиент присылает конфиг без qr и шагов — это не должно ломаться
        val cfg = DismissConfig.fromJson(org.json.JSONObject("""{"count": 2}"""))
        assertEquals(2, cfg.count)
        assertEquals(30, cfg.stepsTarget)
        assertFalse(cfg.qrBound)
    }

    @Test
    fun `конфиг переживает дорогу в json и обратно`() {
        val cfg = DismissConfig.DEFAULT.copy(
            types = listOf("qr", "steps", "math"),
            qrValue = "значение", qrLabel = "на двери", stepsTarget = 50, rescueAfterSec = 120,
        )
        assertEquals(cfg, DismissConfig.fromJson(org.json.JSONObject(cfg.toJson().toString())))
    }

    @Test
    fun `имя файла звука доезжает туда и обратно, без него — пусто, то есть системный`() {
        val cfg = DismissConfig.fromJson(org.json.JSONObject("""{"soundFile": "siren.wav"}"""))
        assertEquals("siren.wav", cfg.soundFile)
        assertEquals(cfg, DismissConfig.fromJson(org.json.JSONObject(cfg.toJson().toString())))
        assertEquals("", DismissConfig.fromJson(org.json.JSONObject("{}")).soundFile)
    }
}
