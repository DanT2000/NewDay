/**
 * Отправка почты. Если SMTP не настроен, mailer работает в режиме «выключен»:
 * письма только логируются, а подтверждение email автоматически отключается.
 * Это нужно, чтобы `git clone && docker compose up` поднимался без почтового сервера.
 */
function createMailer(config) {
  const outbox = [];

  const remember = msg => {
    outbox.push(msg);
    if (outbox.length > 50) outbox.shift();
  };

  if (!config.smtp) {
    return {
      enabled: false,
      outbox,
      async send(msg) {
        remember(msg);
        console.warn(
          `[newday] SMTP не настроен — письмо не отправлено: «${msg.subject}» → ${msg.to}`
        );
      },
    };
  }

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });

  return {
    enabled: true,
    outbox,
    async send(msg) {
      remember(msg);
      if (config.nodeEnv === 'test') return; // в тестах наружу не ходим
      await transport.sendMail({ from: config.smtp.from, ...msg });
    },
  };
}

function verifyEmailMessage({ to, appUrl, token }) {
  const link = `${appUrl}/api/v1/auth/verify?token=${token}`;
  return {
    to,
    subject: 'NewDay — подтверждение почты',
    text: `Здравствуйте!\n\nПодтвердите адрес, чтобы войти в NewDay:\n${link}\n\n`
        + `Ссылка действует 24 часа. Если вы не регистрировались, просто проигнорируйте письмо.`,
    html: `<p>Здравствуйте!</p><p>Подтвердите адрес, чтобы войти в NewDay:</p>`
        + `<p><a href="${link}">${link}</a></p>`
        + `<p>Ссылка действует 24 часа. Если вы не регистрировались, просто проигнорируйте письмо.</p>`,
  };
}

function resetPasswordMessage({ to, appUrl, token }) {
  const link = `${appUrl}/reset.html?token=${token}`;
  return {
    to,
    subject: 'NewDay — восстановление пароля',
    text: `Чтобы задать новый пароль, перейдите по ссылке:\n${link}\n\n`
        + `Ссылка действует 1 час. Если вы не запрашивали смену пароля, ничего делать не нужно.`,
    html: `<p>Чтобы задать новый пароль, перейдите по ссылке:</p>`
        + `<p><a href="${link}">${link}</a></p>`
        + `<p>Ссылка действует 1 час. Если вы не запрашивали смену пароля, ничего делать не нужно.</p>`,
  };
}

module.exports = { createMailer, verifyEmailMessage, resetPasswordMessage };
