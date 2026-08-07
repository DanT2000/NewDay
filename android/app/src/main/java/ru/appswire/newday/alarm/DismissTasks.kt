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

    /**
     * Найти и отсканировать заранее привязанный код.
     *
     * Смысл не в сканировании, а в том, что код наклеен не у кровати: на чайнике,
     * на двери ванной, на пачке кофе. Чтобы выключить будильник, надо дойти —
     * а дойдя, уже не ляжешь.
     *
     * [expected] — значение, привязанное в настройках. Пусто быть не должно:
     * без привязанного кода задача не имеет решения, и такую не выдаём вовсе.
     */
    data class Qr(val expected: String, val label: String) : DismissTask {
        override val prompt get() = "Отсканируйте код: " + label
        override fun check(value: String) = value.trim() == expected
    }

    /**
     * Пройти нужное число шагов.
     *
     * Считает системный шагомер, а не таймер: пролежать это нельзя, только
     * встать и пойти.
     */
    data class Steps(val target: Int) : DismissTask {
        override val prompt get() = "Пройдите " + target + " шагов"
        override fun check(value: String) = (value.trim().toIntOrNull() ?: 0) >= target
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
     * Задача нужного вида с учётом того, что вообще возможно на этом телефоне.
     *
     * [canScan] и [canCountSteps] приходят от железа: камеры может не быть,
     * шагомера на многих старых и почти на всех эмуляторах нет. Выдать задачу,
     * которую нечем решить, — то же самое, что запереть человека наедине с
     * орущим будильником, поэтому невозможное молча становится математикой.
     */
    fun make(
        type: String,
        config: DismissConfig,
        canScan: Boolean = true,
        canCountSteps: Boolean = true,
        rnd: Random = Random.Default,
    ): DismissTask = when (type) {
        "qr" -> if (canScan && config.qrValue.isNotBlank()) {
            DismissTask.Qr(config.qrValue, config.qrLabel.ifBlank { "привязанный код" })
        } else math(config.difficulty, rnd)

        "steps" -> if (canCountSteps) DismissTask.Steps(config.stepsTarget) else math(config.difficulty, rnd)

        else -> make(type, config.difficulty, rnd)
    }

    /**
     * Аварийная задача: то, чем будильник выключают, когда основную решить нечем.
     *
     * Код отклеился, отсырел, его закрыла коробка; шагомер врёт или человек в
     * гипсе. Оставить в этом случае только орущий телефон нельзя — но и лёгкий
     * путь в обход задачи открывать нельзя, иначе им будут пользоваться всегда.
     * Поэтому выход есть, и он заведомо труднее: математика верхнего уровня.
     */
    fun rescue(rnd: Random = Random.Default): DismissTask.Math = math(3, rnd)

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

    /**
     * Набор задач для одного срабатывания.
     *
     * Виды, которые на этом телефоне не решить, выбрасываются до жеребьёвки, а
     * не подменяются потом: иначе при «QR + шаги» на телефоне без шагомера
     * половина подъёмов молча превращалась бы в математику, и человек решил бы,
     * что настройка не сохраняется.
     */
    fun makeSet(
        config: DismissConfig,
        canScan: Boolean = true,
        canCountSteps: Boolean = true,
        rnd: Random = Random.Default,
    ): List<DismissTask> {
        val usable = config.types.filter {
            when (it) {
                "qr" -> canScan && config.qrBound
                "steps" -> canCountSteps
                else -> true
            }
        }
        val pool = usable.ifEmpty { listOf("math") }
        return (1..config.count).map {
            make(pool.randomOrNull(rnd) ?: "math", config, canScan, canCountSteps, rnd)
        }
    }
}
