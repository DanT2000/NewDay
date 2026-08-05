/**
 * Кто считается администратором.
 *
 * Два источника, и оба нужны. Флаг в базе получает первый зарегистрировавшийся —
 * этого достаточно для свежей установки. Список адресов в ADMIN_EMAILS нужен
 * живому серверу: аккаунт мог приехать из старой версии без флага, а доступа
 * к базе у владельца обычно нет — только переменные окружения.
 *
 * Одна функция на весь проект: проверка админа, размазанная по роутерам,
 * однажды где-нибудь окажется забытой, и это будет утечка ключа.
 */

function isAdmin(user, config) {
  if (!user) return false;
  if (user.is_admin === 1) return true;
  const list = config?.adminEmails ?? [];
  if (!list.length) return false;
  const email = String(user.email || '').toLowerCase();
  return Boolean(email) && list.includes(email);
}

module.exports = { isAdmin };
