const path = require('node:path');
const os = require('node:os');

function loadConfig(env = process.env) {
  const smtpHost = env.SMTP_HOST || '';
  const dbPath = env.DB_PATH || path.join(__dirname, '../data/newday.db');
  // APK лежит рядом с базой — в том же постоянном томе, чтобы переживать
  // пересборку контейнера. Для базы в памяти (тесты) кладём в temp.
  const apkDir = env.APK_DIR || (dbPath === ':memory:'
    ? path.join(os.tmpdir(), 'newday-apk')
    : path.join(path.dirname(dbPath), 'apk'));
  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    dbPath,
    apkDir,
    // Токен для выкладки APK из CI. Пока не задан — эндпоинт выкладки закрыт.
    apkUploadToken: env.APK_UPLOAD_TOKEN || '',
    sessionSecret: env.SESSION_SECRET || 'newday-dev-secret-change-in-production',
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY !== '0',
    /*
     * Администраторы по адресу почты.
     *
     * Первый зарегистрировавшийся получает флаг в базе, но на живом сервере
     * этого может оказаться недостаточно: аккаунт мог приехать из старой
     * версии или админ появиться позже. Доступа к базе у владельца при этом
     * обычно нет — есть только переменные окружения, поэтому список адресов
     * задаётся здесь и работает поверх флага в базе.
     */
    adminEmails: String(env.ADMIN_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    vapid: (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) ? {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT || `mailto:${env.SMTP_FROM || 'admin@example.com'}`,
    } : null,
    /**
     * Обновление Android-приложения.
     *
     * Основной путь — APK, выложенный на этот же сайт: приложение обновляется
     * со своего сервера, и ничей чужой репозиторий для этого не нужен.
     * UPDATE_APK_URL — если файл раздаётся откуда-то ещё, UPDATE_REPO —
     * запасной вариант через релизы GitHub (по умолчанию выключен).
     */
    update: {
      enabled: env.UPDATE_DISABLED !== '1',
      repo: env.UPDATE_REPO || '',
      apkUrl: env.UPDATE_APK_URL || '',
      versionName: env.UPDATE_VERSION_NAME || '',
      versionCode: env.UPDATE_VERSION_CODE ? Number(env.UPDATE_VERSION_CODE) : 0,
      notes: env.UPDATE_NOTES || '',
    },
    smtp: smtpHost
      ? {
          host: smtpHost,
          port: Number(env.SMTP_PORT || 465),
          secure: env.SMTP_SECURE !== '0',
          user: env.SMTP_USER || '',
          pass: env.SMTP_PASS || '',
          from: env.SMTP_FROM || env.SMTP_USER || '',
        }
      : null,
  };
}

module.exports = { loadConfig };
