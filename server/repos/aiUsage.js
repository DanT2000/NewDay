/**
 * Расход на ИИ.
 *
 * Владелец платит за модель и должен видеть, куда уходят деньги, не заходя
 * в личный кабинет провайдера. Здесь только счётчики: сколько обращений,
 * сколько токенов, сколько рублей. Ни текста, ни звука.
 *
 * Стоимость берём из ответа провайдера, когда он её присылает. Считать по
 * прайсу самим — значит однажды показать неправду, потому что прайс
 * поменяется, а формула останется.
 */

function aiUsageRepo(db) {
  /**
   * Записать одно обращение. Ошибки считаем отдельно от удач: строка
   * «двадцать запросов» без разбивки скрывает, что половина не сработала.
   */
  function add({ userId, kind, model, ok, tokensIn = 0, tokensOut = 0, seconds = 0, costRub = 0, ms = 0 }) {
    db.prepare(
      `INSERT INTO ai_usage (day, user_id, kind, model, ok, failed, tokens_in, tokens_out, seconds, cost_rub, ms_sum)
       VALUES (date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, user_id, kind, model) DO UPDATE SET
         ok = ok + excluded.ok,
         failed = failed + excluded.failed,
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         seconds = seconds + excluded.seconds,
         cost_rub = cost_rub + excluded.cost_rub,
         ms_sum = ms_sum + excluded.ms_sum`,
    ).run(
      userId ?? null, kind, String(model || ''),
      ok ? 1 : 0, ok ? 0 : 1,
      Math.round(tokensIn) || 0, Math.round(tokensOut) || 0,
      Math.round(seconds) || 0, Number(costRub) || 0,
      Math.round(ms) || 0,
    );
  }

  /**
   * Сводка за период. Разбивки две: по видам работы (за что платим) и по
   * людям (кто расходует). Вторая нужна, чтобы понять, один человек
   * увлёкся или пользуются все.
   */
  function summary(days = 30) {
    const since = `-${Math.max(1, days) - 1} days`;
    const rows = db.prepare(
      `SELECT u.kind, u.model, u.user_id, u.ok, u.failed, u.tokens_in, u.tokens_out,
              u.seconds, u.cost_rub, u.ms_sum, us.email
         FROM ai_usage u LEFT JOIN users us ON us.id = u.user_id
        WHERE u.day >= date('now', ?)`,
    ).all(since);

    const byKind = {}, byUser = {}, byModel = {};
    let ok = 0, failed = 0, rub = 0, msSum = 0, tokens = 0;

    for (const r of rows) {
      const n = r.ok + r.failed;
      ok += r.ok; failed += r.failed;
      rub += r.cost_rub; msSum += r.ms_sum;
      tokens += r.tokens_in + r.tokens_out;

      bump(byKind, r.kind, n, r.cost_rub);
      bump(byModel, r.model || '—', n, r.cost_rub);
      bump(byUser, r.email || 'без имени', n, r.cost_rub);
    }

    const total = ok + failed;
    const today = db.prepare(
      "SELECT COALESCE(SUM(ok + failed), 0) AS n, COALESCE(SUM(cost_rub), 0) AS rub FROM ai_usage WHERE day = date('now')",
    ).get();

    return {
      days, total, ok, failed,
      tokens,
      rub: round(rub),
      avgMs: total ? Math.round(msSum / total) : null,
      // Средняя цена обращения отвечает на вопрос «а если людей станет
      // вдвое больше» без калькулятора
      perRequest: total ? round(rub / total) : 0,
      today: { requests: today.n, rub: round(today.rub) },
      byKind, byModel, byUser,
    };
  }

  /** Расход по дням — чтобы был виден не только итог, но и всплеск. */
  const daily = (days = 30) => db.prepare(
    `SELECT day, SUM(ok + failed) AS requests, SUM(cost_rub) AS rub
       FROM ai_usage WHERE day >= date('now', ?) GROUP BY day ORDER BY day`,
  ).all(`-${Math.max(1, days) - 1} days`).map(r => ({ day: r.day, requests: r.requests, rub: round(r.rub) }));

  return { add, summary, daily };
}

function bump(target, key, n, rub) {
  const cell = target[key] ?? (target[key] = { requests: 0, rub: 0 });
  cell.requests += n;
  cell.rub = round(cell.rub + rub);
}

/** Копейки: дробить рубль мельче нет смысла, а длинные хвосты мешают читать. */
const round = v => Math.round((Number(v) || 0) * 100) / 100;

module.exports = { aiUsageRepo };
