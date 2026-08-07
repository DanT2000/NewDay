const express = require('express');
const session = require('express-session');
const path = require('node:path');
const createSessionStore = require('./lib/session-store');
const { errorHandler, ApiError } = require('./lib/errors');
const { createMailer } = require('./lib/mailer');
const { createPush } = require('./lib/push');
const { notificationService } = require('./services/notificationService');
const { createAuthMiddleware } = require('./middleware/auth');
const { cors } = require('./middleware/cors');

const healthRouter = require('./routes/health');
const authRouter = require('./routes/v1/auth');
const tokensRouter = require('./routes/v1/tokens');
const daysRouter = require('./routes/v1/days');
const habitsRouter = require('./routes/v1/habits');
const statsRouter = require('./routes/v1/stats');
const seriesRouter = require('./routes/v1/series');
const pushRouter = require('./routes/v1/push');
const settingsRouter = require('./routes/v1/settings');
const notesRouter = require('./routes/v1/notes');
const soundsRouter = require('./routes/v1/sounds');
const adminRouter = require('./routes/v1/admin');
const adminPanelRouter = require('./routes/adminPanel');
const aiRouter = require('./routes/v1/ai');
const exportRouter = require('./routes/v1/export');
const openapiRouter = require('./routes/v1/openapi');
const appVersionRouter = require('./routes/v1/app');
const legacyRouter = require('./routes/legacy');
const { apkStore } = require('./services/apkStore');
const { updateService } = require('./services/updateService');
const { aiService } = require('./services/aiService');
const { aiAccess } = require('./services/aiAccess');

/**
 * `fetchImpl` подменяется в тестах: настоящий провайдер в них ходить не
 * должен — иначе тесты станут падать от чужих лимитов и молчать о своих
 * ошибках.
 */
function createApp({ db, config, fetchImpl, env = process.env }) {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(cors());   // мобильное приложение живёт на origin https://localhost
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
  const push = createPush(config);
  const notify = notificationService(db, { push });
  const auth = createAuthMiddleware(db);

  app.locals.db = db;
  app.locals.config = config;
  app.locals.mailer = mailer;
  app.locals.push = push;
  app.locals.notify = notify;

  const store = apkStore({ dir: config.apkDir });
  const update = updateService(config, { store });
  app.locals.apkStore = store;
  app.locals.update = update;

  // Помощник обращается к облаку напрямую. Ключ и модели задаёт владелец
  // в админских настройках; переменные окружения — только первые значения.
  const ai = aiService(db, { env, fetchImpl });
  app.locals.ai = ai;

  // Рубильник и тарифы помощника: кто и сколько может его тратить
  const access = aiAccess(db);
  app.locals.aiAccess = access;

  app.use('/api/health', healthRouter(db, { ai, push, mailer }));
  // Спецификация и документация доступны без входа
  app.use('/api/v1', openapiRouter({ config }));
  app.get('/api/docs', (_req, res) => res.sendFile(path.join(__dirname, '../public/api-docs.html')));
  app.use('/api/v1/auth', authRouter({ db, config, mailer, auth }));

  /**
   * Версия и раздача приложения — до требования входа: приложение узнаёт
   * о новой версии ещё на экране входа, а ссылку на скачивание человек
   * открывает в браузере телефона, где сессии этого сайта нет.
   */
  app.use('/api/v1/app', appVersionRouter({ config, store, update }));

  /**
   * Панель администратора — до общих требований аутентификации: у неё
   * свой вход по паролю экземпляра, пользовательская сессия не нужна.
   * Ниже по цепочке /api перекрыт auth.requireAuth, поэтому позже её
   * подключать нельзя — login отвечал бы 401 раньше, чем его увидит панель.
   */
  app.use('/api/admin', adminPanelRouter({ db, config, ai, access, push }));

  // Старые пути — до конца этапа 2, пока фронтенд не переписан.
  app.use('/api/auth', authRouter({ db, config, mailer, auth }));
  app.use('/api', legacyRouter({ db, auth }));
  app.use('/api', auth.requireAuth, exportRouter({ db }));   // /api/export/all — алиас внутри роутера

  /*
   * Данные не кешируются браузером.
   *
   * У дня есть ETag, и без явного запрета браузер считает себя вправе отдать
   * сохранённый ответ, не спрашивая сервер. Это ловилось руками: сразу после
   * удаления строки чтение дня возвращало день со строкой, а попытка удалить
   * её ещё раз давала «не найдено». Показать вчерашний день как сегодняшний
   * хуже, чем сходить за ним в сеть.
   */
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Всё остальное под /api/v1 требует аутентификации; пишущие методы — ещё и scope=write.
  app.use('/api/v1', auth.requireAuth);
  app.use('/api/v1', (req, res, next) =>
    ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      ? next()
      : auth.requireScope('write')(req, res, next));

  app.use('/api/v1', tokensRouter({ db, auth }));
  /**
   * Правка расписания меняет то, когда должны прийти напоминания.
   * Пересчитываем после успешного ответа, чтобы не задерживать запрос
   * и не ломать его, если планирование почему-то упало.
   */
  app.use('/api/v1/days/:date', (req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) return next();
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user) return;
      try { notify.planDay(req.user, req.params.date); }
      catch (e) { console.error('[newday] пересчёт уведомлений:', e.message); }
    });
    next();
  });

  app.use('/api/v1/days', daysRouter({ db }));
  app.use('/api/v1/habits', habitsRouter({ db }));
  app.use('/api/v1/stats', statsRouter({ db }));
  app.use('/api/v1/series', seriesRouter({ db }));
  app.use('/api/v1/push', pushRouter({ db, push }));

  app.use('/api/v1/ai', aiRouter({ ai, access }));
  app.use('/api/v1/notes', notesRouter({ db }));
  app.use('/api/v1/sounds', soundsRouter({ db, config }));
  app.use('/api/v1/admin', adminRouter({ db, config, ai }));
  app.use('/api/v1/settings', settingsRouter({ db, config }));
  app.use('/api/v1', exportRouter({ db }));

  app.use('/api', (req, _res, next) => {
    next(new ApiError(404, 'NOT_FOUND', `Неизвестный эндпоинт: ${req.method} ${req.baseUrl}${req.path}`));
  });

  app.get('/pair', (_req, res) => res.sendFile(path.join(__dirname, '../public/pair.html')));
  // админка живёт по короткому пути: /admin вводится руками, а не по ссылке
  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
  /*
   * Заголовки кеша.
   *
   * Разметка, стили и скрипты — с обязательной перепроверкой: браузер
   * спрашивает сервер, изменился ли файл, и по ETag получает либо 304,
   * либо новую версию. Без этого после выкладки человек продолжал видеть
   * старый интерфейс и справедливо считал, что ничего не поменялось.
   *
   * Шрифты и иконки — на год: их имена содержат хеш содержимого, поэтому
   * новая версия приходит под новым адресом, а старую можно держать вечно.
   */
  app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders(res, filePath) {
      // разделитель любой: на Windows путь приходит с обратными слэшами
      if (/[\\/](fonts|icons)[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(html|css|js|json|webmanifest)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
