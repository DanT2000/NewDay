const MAX_JSON_BYTES = 512 * 1024; // 512 KB

function validateUsername(username) {
  if (!username || typeof username !== 'string') return 'Имя пользователя обязательно';
  const u = username.trim();
  if (u.length < 2 || u.length > 50) return 'Имя пользователя: от 2 до 50 символов';
  if (!/^[a-zA-Z0-9_\-.]+$/.test(u)) return 'Имя пользователя: только буквы, цифры, _, -, .';
  return null;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Пароль обязателен';
  if (password.length < 4) return 'Пароль: не менее 4 символов';
  if (password.length > 200) return 'Пароль слишком длинный';
  return null;
}

function validateDate(date) {
  if (!date || typeof date !== 'string') return 'Дата обязательна';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Неверный формат даты (YYYY-MM-DD)';
  return null;
}

function validateJsonSize(str) {
  if (Buffer.byteLength(str, 'utf8') > MAX_JSON_BYTES) {
    return 'Данные слишком большие (максимум 512 КБ)';
  }
  return null;
}

module.exports = { validateUsername, validatePassword, validateDate, validateJsonSize };
