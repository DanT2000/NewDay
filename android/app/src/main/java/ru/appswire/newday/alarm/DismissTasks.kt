package ru.appswire.newday.alarm

import kotlin.random.Random

/**
 * Задачи, которыми выключается будильник.
 *
 * Смысл в том, чтобы человек проснулся, а не отключил будильник во сне.
 * Поэтому задача должна требовать внимания, но решаться за секунды —
 * иначе в шесть утра это превращается в пытку и приложение удаляют.
 */
sealed interface DismissTask {
    val prompt: String
    fun check(answer: String): Boolean

    /**
     * Арифметика. Ответ вводится, а не выбирается из вариантов.
     *
     * Выбор из четырёх чисел просыпаться не заставляет: спросонья попадаешь
     * пальцем наугад и с четверти попыток угадываешь. Ввод требует посчитать.
     */
    data class Math(
        val a: Int, val b: Int, val op: Char, val answer: Int,
    ) : DismissTask {
        override val prompt get() = "$a $op $b"
        override fun check(value: String) = value.trim().toIntOrNull() == answer
    }

    /** Ввести показанную последовательность цифр. */
    data class Code(val code: String) : DismissTask {
        override val prompt get() = "Введите код: $code"
        override fun check(value: String) = value.trim() == code
    }

    /** Нажать показанные символы в правильном порядке. */
    data class Icons(val sequence: List<String>, val pool: List<String>) : DismissTask {
        override val prompt get() = "Нажмите по порядку: " + sequence.joinToString("  ")
        override fun check(value: String) = value == sequence.joinToString("")
    }
}

object TaskFactory {
    private val ICON_POOL = listOf("★", "●", "▲", "■", "◆", "✚", "❤", "☀", "☂", "✿", "♪", "☘")

    fun make(type: String, difficulty: Int, rnd: Random = Random.Default): DismissTask = when (type) {
        "code" -> code(difficulty, rnd)
        "icons" -> icons(difficulty, rnd)
        else -> math(difficulty, rnd)
    }

    /**
     * Три уровня, и они отличаются тем, сколько на это нужно головы:
     *
     *  1 — однозначные на сложение: разлепить глаза и не более;
     *  2 — двузначные на сложение: уже нужно считать в столбик в голове;
     *  3 — двузначные со сложением и вычитанием: тут точно не уснёшь.
     *
     * Ответ всегда положительный. Отрицательный в полусне — это не «сложнее»,
     * а «непонятно»: человек вводит 12 вместо −12, задача не принимается, и
     * будильник выглядит сломанным. Поэтому при вычитании большее число
     * ставится первым.
     */
    fun math(difficulty: Int, rnd: Random = Random.Default): DismissTask.Math {
        val level = difficulty.coerceIn(1, 3)
        val minus = level == 3 && rnd.nextBoolean()
        val range = if (level == 1) 2..9 else 10..99

        var a = rnd.nextInt(range.first, range.last + 1)
        var b = rnd.nextInt(range.first, range.last + 1)

        if (minus) {
            if (b > a) { val t = a; a = b; b = t }
            // равные числа дают ноль — ответ, который вводят не считая
            if (a == b) a = (a + rnd.nextInt(1, 10)).coerceAtMost(99)
            return DismissTask.Math(a, b, '−', a - b)
        }
        return DismissTask.Math(a, b, '+', a + b)
    }

    fun code(difficulty: Int, rnd: Random = Random.Default): DismissTask.Code {
        val len = 3 + difficulty.coerceIn(1, 3)          // 4..6 цифр
        val sb = StringBuilder()
        repeat(len) { sb.append(rnd.nextInt(0, 10)) }
        return DismissTask.Code(sb.toString())
    }

    fun icons(difficulty: Int, rnd: Random = Random.Default): DismissTask.Icons {
        val poolSize = (4 + difficulty.coerceIn(1, 3) * 2).coerceAtMost(ICON_POOL.size)  // 6..10
        val pool = ICON_POOL.shuffled(rnd).take(poolSize)
        val seqLen = 2 + difficulty.coerceIn(1, 3)       // 3..5
        return DismissTask.Icons(pool.shuffled(rnd).take(seqLen), pool)
    }

    /** Набор задач для одного срабатывания. */
    fun makeSet(config: DismissConfig, rnd: Random = Random.Default): List<DismissTask> =
        (1..config.count).map {
            val type = config.types.randomOrNull(rnd) ?: "math"
            make(type, config.difficulty, rnd)
        }
}
