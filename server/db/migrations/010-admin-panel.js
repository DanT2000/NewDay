/**
 * Панель администратора: приглашения, тарифы помощника, прокси.
 *
 * Приглашения нужны, когда владелец закрывает свободную регистрацию:
 * ссылка с кодом — единственный способ попасть внутрь. У кода есть предел
 * использований, и в нём же записан тариф помощника для новичка — так
 * владелец решает, кому оплачивать модель, ещё до того, как человек вошёл.
 *
 * `ai_tier` у пользователя — 'off' | 'limited' | 'unlimited'. По умолчанию
 * 'unlimited': все, кто уже зарегистрирован, ничего не теряют — ограничения
 * появляются только там, где владелец их явно поставил.
 *
 * `ai_daily_usage` — суточный счётчик обращений для тарифа 'limited'.
 * Таблица ai_usage (миграция 005) не годится: там день считается по UTC
 * и лежат деньги-токены, а лимит должен закрываться в полночь по часам
 * пользователя, иначе он «сгорает» посреди вечера.
 *
 * `ai_proxies` — список прокси, через которые сервер ходит к провайдеру
 * ИИ: некоторые провайдеры недоступны напрямую из некоторых сетей. Пароль
 * хранится как есть по той же причине, что и ключ ИИ: сервер должен уметь
 * им пользоваться, а наружу он не отдаётся.
 */

module.exports = {
  version: 10,
  name: 'admin-panel',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN ai_tier TEXT NOT NULL DEFAULT 'unlimited';

      CREATE TABLE IF NOT EXISTS invites (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        code       TEXT    NOT NULL UNIQUE,
        uses_limit INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        ai_tier    TEXT    NOT NULL DEFAULT 'limited',
        revoked_at TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ai_daily_usage (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day     TEXT    NOT NULL,
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
      );

      CREATE TABLE IF NOT EXISTS ai_proxies (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT    NOT NULL,             -- http | https | socks5
        host        TEXT    NOT NULL,
        port        INTEGER NOT NULL,
        login       TEXT,
        password    TEXT,
        position    INTEGER NOT NULL DEFAULT 0,   -- порядок перебора
        disabled_at TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
