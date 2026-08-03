/**
 * CORS для мобильного приложения.
 *
 * Ассеты вшиты в APK, поэтому WebView живёт на origin `https://localhost`
 * и обращается к серверу кросс-доменно. Cookie в такой схеме не годятся
 * (SameSite их не пропустит), поэтому приложение авторизуется device-токеном
 * в заголовке Authorization — а значит, разрешать credentials не нужно.
 *
 * Список origin закрытый: '*' с Authorization работал бы, но открывал бы API
 * любому сайту, который заманит пользователя с готовым токеном в буфере.
 */

const APP_ORIGINS = new Set([
  'https://localhost',        // Capacitor Android, androidScheme: https
  'capacitor://localhost',    // Capacitor iOS
  'http://localhost',         // локальная отладка веб-части
]);

function cors() {
  return (req, res, next) => {
    const origin = req.get('origin');

    if (origin && APP_ORIGINS.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
      res.set('Access-Control-Expose-Headers', 'ETag');
      res.set('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      return res.status(origin && APP_ORIGINS.has(origin) ? 204 : 403).end();
    }
    next();
  };
}

module.exports = { cors, APP_ORIGINS };
