const path = require('node:path');

function loadConfig(env = process.env) {
  const smtpHost = env.SMTP_HOST || '';
  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || path.join(__dirname, '../data/newday.db'),
    sessionSecret: env.SESSION_SECRET || 'newday-dev-secret-change-in-production',
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY !== '0',
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
