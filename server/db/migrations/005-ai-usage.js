/**
 * Счётчики обращений к ИИ.
 *
 * Модель платная, и владелец должен видеть, куда уходят деньги, не заходя
 * в личный кабинет провайдера. Поэтому после каждого ответа сюда ложится
 * строка: сколько запросов, сколько токенов, сколько рублей и сколько
 * времени.
 *
 * Содержания запросов здесь нет и быть не должно. Это счётчики, а не
 * переписка: по ним видно «двадцать разборов за день на девять рублей»,
 * но не то, что человек надиктовал.
 *
 * Стоимость берём из ответа провайдера, если он её присылает (AI Tunnel
 * присылает `usage.cost_rub`). Считать по прайсу самим — значит однажды
 * показать неправду, когда прайс поменяется.
 */

module.exports = {
  version: 5,
  name: 'ai-usage',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        day         TEXT    NOT NULL,
        user_id     INTEGER,
        kind        TEXT    NOT NULL,          -- parse | improve | transcribe
        model       TEXT    NOT NULL DEFAULT '',
        ok          INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        tokens_in   INTEGER NOT NULL DEFAULT 0,
        tokens_out  INTEGER NOT NULL DEFAULT 0,
        seconds     INTEGER NOT NULL DEFAULT 0, -- для распознавания речи
        cost_rub    REAL    NOT NULL DEFAULT 0,
        ms_sum      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, user_id, kind, model)
      );

      CREATE INDEX IF NOT EXISTS ai_usage_day ON ai_usage (day);
    `);
  },
};
