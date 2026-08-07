/**
 * Окончательное удаление аккаунтов.
 *
 * Удаление двухступенчатое: сначала администратор закрывает доступ
 * (users.blocked_at), и только заблокированного можно стереть насовсем —
 * рукой из админки или автоочисткой отсюда. Так один случайный клик не
 * уносит чьи-то годы записей: пока аккаунт лишь заблокирован, всё обратимо.
 *
 * Почему именно удаление, а не вечная блокировка: заблокированный аккаунт —
 * это чужие персональные данные, которые сервер продолжает хранить без
 * согласия человека. Держать их вечно нельзя, а стирать сразу — страшно.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Сколько дней заблокированный аккаунт ждёт автоочистки. 60 — достаточно,
 * чтобы блокировка по ошибке успела вскрыться (человек напишет владельцу),
 * и достаточно мало, чтобы мёртвые данные не лежали годами.
 */
const BLOCKED_RETENTION_DAYS = 60;

/** Когда заблокированного удалит автоочистка; null — не заблокирован. */
function deleteAfterOf(blockedAt) {
  if (!blockedAt) return null;
  // blocked_at пишет sqlite-датой «YYYY-MM-DD HH:MM:SS» в UTC — вернём той же монетой
  const t = Date.parse(String(blockedAt).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return null;
  return new Date(t + BLOCKED_RETENTION_DAYS * 24 * 3600 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

function userCleanup(db, { soundsDir }) {
  /**
   * Стереть пользователя и всё его. Почти всё уносит каскад по FK
   * (users … ON DELETE CASCADE у таблиц данных, устройств и токенов),
   * но два хвоста каскаду недоступны:
   *   - ai_usage (миграция 005) — без FK, там nullable user_id;
   *   - файлы звуков — лежат на диске (sounds/<user_id>/…), база про них
   *     знает только метаданными.
   * Осиротевшие веб-сессии не трогаем: без строки в users они отвечают 401
   * сами собой и истекают по своему сроку.
   */
  function deleteUser(id) {
    // Сначала файлы: если диск откажет, строки останутся и попытку можно повторить
    fs.rmSync(path.join(soundsDir, String(id)), { recursive: true, force: true });
    db.transaction(() => {
      db.prepare('DELETE FROM ai_usage WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  }

  /** Ежедневный проход: стереть всех, кто заблокирован дольше срока. */
  function purgeExpired() {
    const rows = db.prepare(
      "SELECT id FROM users WHERE blocked_at IS NOT NULL AND blocked_at <= datetime('now', ?)",
    ).all(`-${BLOCKED_RETENTION_DAYS} days`);
    for (const row of rows) deleteUser(row.id);
    return rows.length;
  }

  return { deleteUser, purgeExpired };
}

module.exports = { userCleanup, deleteAfterOf, BLOCKED_RETENTION_DAYS };
