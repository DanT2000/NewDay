package ru.appswire.newday.alarm

import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.MultiFormatWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Разбор кадра камеры.
 *
 * Проверяется без телефона нарочно: на телефоне это видно только глазами и
 * только иногда — «навожу, а он не читает». Кадр здесь собирается такой же,
 * какой отдаёт камера: код нарисован так, как его видит человек, буфер повёрнут
 * на четверть (телефон стоит вертикально, матрица в нём лежит на боку), а строки
 * в буфере выровнены — rowStride больше ширины кадра.
 *
 * Каждая проверка ниже — пойманный дефект, а не украшение: до правки на таком
 * кадре не читался ни один штрих-код.
 */
class CodeFrameTest {

    private val reader get() = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.TRY_HARDER to true))
    }

    private val bar = "1234"
    private val qr = "newday-teapot-1"

    // ── Сборка кадра ─────────────────────────────────────────

    /**
     * Белый кадр «как видит человек» с кодом посередине.
     *
     * Масштаб задаётся целым числом пикселей на модуль, а не желаемой шириной:
     * ширину zxing может увеличить сам, и тогда проверка «код во всю ширину»
     * втихую перестала бы проверять то, ради чего написана.
     */
    private fun drawn(
        text: String,
        format: BarcodeFormat,
        frameW: Int,
        frameH: Int,
        scale: Int,
        barH: Int = 0,
    ): ByteArray {
        val m = MultiFormatWriter().encode(text, format, 1, 1)   // модуль в пиксель
        val cw = m.width * scale
        val ch = if (barH > 0) barH else m.height * scale
        val out = ByteArray(frameW * frameH) { -1 }              // -1 = 0xFF, белое
        val left = (frameW - cw) / 2
        val top = (frameH - ch) / 2
        for (dy in 0 until ch) {
            val my = if (barH > 0) 0 else dy / scale
            for (dx in 0 until cw) {
                if (m.get(dx / scale, my)) out[(top + dy) * frameW + (left + dx)] = 0
            }
        }
        return out
    }

    /**
     * Буфер камеры для кадра, который человек видит как [up] размером [w]×[h].
     *
     * Матрица повёрнута на четверть, поэтому буфер лежит на боку: его размеры
     * h×w. Строки в нём выровнены — за каждой [pad] байт, к изображению не
     * относящихся; оставляем их чёрными, чтобы принятые за изображение они сразу
     * ломали разбор.
     */
    private fun sensor(up: ByteArray, w: Int, h: Int, pad: Int): ByteArray {
        val stride = h + pad
        val buf = ByteArray(stride * w)
        for (sy in 0 until w) {
            for (sx in 0 until h) {
                buf[sy * stride + sx] = up[sx * w + (w - 1 - sy)]
            }
        }
        return buf
    }

    // ── Штрих-код ────────────────────────────────────────────

    @Test
    fun `штрих-код читается у вертикально стоящего телефона`() {
        // Тот самый дефект: кадр разбирали в ориентации матрицы, полосы кода
        // шли вдоль строк — и zxing не находил ничего, сколько ни держи.
        val up = drawn(bar, BarcodeFormat.CODE_128, 480, 640, scale = 4, barH = 200)
        val buf = sensor(up, 480, 640, 16)
        val frame = CodeFrame.upright(buf, 640 + 16, 640, 480, 90)
        assertEquals(480, frame.width)
        assertEquals(640, frame.height)
        assertEquals(bar, CodeFrame.read(reader, frame))
    }

    @Test
    fun `штрих-код во всю ширину кадра не обрезается по бокам`() {
        // Второй дефект: разбиралась середина кадра — 80% меньшей стороны.
        // Код, который человек видит в рамке целиком, лишался старт-стопа.
        val up = drawn(bar, BarcodeFormat.CODE_128, 480, 640, scale = 6, barH = 200)
        val buf = sensor(up, 480, 640, 16)
        val frame = CodeFrame.upright(buf, 640 + 16, 640, 480, 90)
        assertEquals(bar, CodeFrame.read(reader, frame))
    }

    @Test
    fun `штрих-код, наклеенный боком, читается вторым проходом`() {
        // Наклейку на чайнике клеят как получится, и телефон в шесть утра
        // держат как попало: код в кадре оказывается повёрнутым на четверть.
        val up = drawn(bar, BarcodeFormat.CODE_128, 480, 640, scale = 4, barH = 200)
        val buf = sensor(up, 480, 640, 16)
        val frame = CodeFrame.upright(buf, 640 + 16, 640, 480, 0)
        assertEquals(bar, CodeFrame.read(reader, frame))
    }

    // ── QR ───────────────────────────────────────────────────

    @Test
    fun `QR читается и в повёрнутом кадре, и в невыровненном буфере`() {
        val up = drawn(qr, BarcodeFormat.QR_CODE, 480, 640, scale = 9)
        for (pad in listOf(0, 16, 64)) {
            val buf = sensor(up, 480, 640, pad)
            val frame = CodeFrame.upright(buf, 640 + pad, 640, 480, 90)
            assertEquals("выравнивание строк $pad", qr, CodeFrame.read(reader, frame))
        }
    }

    @Test
    fun `в кадре без кода ничего не находится`() {
        // Ложная находка хуже ненайденной: привязался бы мусор, и «код привязан»
        // означало бы код, которого нет.
        val white = ByteArray(480 * 640) { -1 }
        val frame = CodeFrame.upright(white, 480, 480, 640, 0)
        assertNull(CodeFrame.read(reader, frame))
    }

    // ── Геометрия ────────────────────────────────────────────

    @Test
    fun `поворот на четверть переставляет стороны и снимает выравнивание`() {
        // Кадр 3×2 с шагом строки 5: хвосты строк (9) в изображение попасть не
        // должны, иначе кадр разъезжается по диагонали.
        val src = byteArrayOf(
            1, 2, 3, 9, 9,
            4, 5, 6, 9, 9,
        )
        val f = CodeFrame.upright(src, 5, 3, 2, 90)
        assertEquals(2, f.width)
        assertEquals(3, f.height)
        // по часовой: левый верхний угол уходит вправо вверх
        assertEquals(listOf<Byte>(4, 1, 5, 2, 6, 3), f.data.toList())
    }

    @Test
    fun `короткий буфер не роняет разбор`() {
        // У части телефонов последняя строка буфера обрезана по ширине кадра.
        val src = byteArrayOf(1, 2, 3, 9, 9, 4, 5, 6)
        val f = CodeFrame.upright(src, 5, 3, 2, 90)
        assertEquals(6, f.data.size)
    }
}
