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

    /** Арифметика с вариантами ответа. */
    data class Math(
        val a: Int, val b: Int, val op: Char, val answer: Int, val options: List<Int>,
    ) : DismissTask {
        override val prompt get() = "$a $op $b = ?"
        override fun check(value: String) = value.toIntOrNull() == answer
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

    /** Сложность: 1 — двузначные, 2 — с умножением, 3 — трёхзначные и умножение. */
    fun math(difficulty: Int, rnd: Random = Random.Default): DismissTask.Math {
        val (a, b, op) = when (difficulty.coerceIn(1, 3)) {
            1 -> Triple(rnd.nextInt(10, 60), rnd.nextInt(10, 40), if (rnd.nextBoolean()) '+' else '−')
            2 -> if (rnd.nextBoolean()) Triple(rnd.nextInt(3, 13), rnd.nextInt(3, 10), '×')
                 else Triple(rnd.nextInt(40, 160), rnd.nextInt(10, 60), '+')
            else -> if (rnd.nextBoolean()) Triple(rnd.nextInt(11, 30), rnd.nextInt(6, 19), '×')
                    else Triple(rnd.nextInt(200, 900), rnd.nextInt(50, 300), '−')
        }
        val answer = when (op) {
            '+' -> a + b
            '−' -> a - b
            else -> a * b
        }

        // Неправильные варианты держим рядом с ответом: далёкие числа
        // видно не думая, и задача перестаёт будить.
        val wrong = LinkedHashSet<Int>()
        while (wrong.size < 3) {
            val delta = rnd.nextInt(1, 12) * (if (rnd.nextBoolean()) 1 else -1)
            val candidate = answer + delta
            if (candidate != answer) wrong.add(candidate)
        }
        val options = (wrong + answer).shuffled(rnd)
        return DismissTask.Math(a, b, op, answer, options)
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
