const express = require('express');
const session = require('express-session');
const path = require('node:path');
const createSessionStore = require('./lib/session-store');
const { errorHandler, ApiError } = require('./lib/errors');
const { createMailer } = require('./lib/mailer');
const { createAuthMiddleware } = require('./middleware/auth');

const healthRouter = require('./routes/health');
const authRouter = require('./routes/v1/auth');
const tokensRouter = require('./routes/v1/tokens');

function createApp({ db, config }) {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  const SQLiteStore = createSessionStore(session, db);
  app.use(session({
    store: new SQLiteStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  const mailer = createMailer(config);
  const auth = createAuthMiddleware(db);

  app.locals.db = db;
  app.locals.config = config;
  app.locals.mailer = mailer;

  app.use('/api/health', healthRouter(db));
  app.use('/api/v1/auth', authRouter({ db, config, mailer, auth }));

  // Всё остальное под /api/v1 требует аутентификации; пишущие методы — ещё и scope=write.
  app.use('/api/v1', auth.requireAuth);
  app.use('/api/v1', (req, res, next) =>
    ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      ? next()
      : auth.requireScope('write')(req, res, next));

  app.use('/api/v1', tokensRouter({ db, auth }));

  app.use('/api', (req, _res, next) => {
    next(new ApiError(404, 'NOT_FOUND', `Неизвестный эндпоинт: ${req.method} ${req.baseUrl}${req.path}`));
  });

  app.use(express.static(path.join(__dirname, '../public')));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
