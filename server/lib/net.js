/**
 * Откуда пришёл запрос: «из этой же сети» или «из интернета».
 *
 * Нужно ровно одному месту — заводскому паролю панели. Свежий сервер надо
 * как-то настроить, и пароль по умолчанию для этого и есть; но тот же пароль,
 * работающий из интернета, — это открытая панель со списком людей, кодами
 * приглашений и ключами помощника.
 */

/** IPv4-адрес в виде четырёх чисел или null. */
function квартет(ip) {
  // Express отдаёт IPv4 внутри IPv6 как ::ffff:172.18.0.1
  const чистый = String(ip || '').replace(/^::ffff:/i, '');
  const части = чистый.split('.');
  if (части.length !== 4) return null;
  const числа = части.map(Number);
  return числа.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? числа : null;
}

/**
 * `true` для своей машины и локальной сети: петля, 10/8, 172.16/12,
 * 192.168/16, link-local 169.254/16, а из IPv6 — ::1 и fc00::/7 (а также
 * fe80::/10, адреса канала).
 */
function локальныйАдрес(ip) {
  const s = String(ip || '').toLowerCase();
  if (!s) return false;
  if (s === '::1' || s === '::') return true;

  const q = квартет(s);
  if (q) {
    const [a, b] = q;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6: уникальные локальные (fc00::/7) и адреса канала (fe80::/10)
  const первый = s.split(':')[0];
  if (/^f[cd]/.test(первый)) return true;
  if (/^fe[89ab]/.test(первый)) return true;
  return false;
}

module.exports = { локальныйАдрес };
