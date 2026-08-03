const express = require('express');
const session = require('express-session');
const path = require('node:path');
const createSessionStore = require('./lib/session-store');
const healthRouter = require('./routes/health');

function createApp({ db, config }) {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

  app.locals.db = db;
  app.locals.config = config;

  app.use('/api/health', healthRouter(db));

  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  return app;
}

module.exports = { createApp };
