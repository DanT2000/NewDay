const express = require('express');
const pkg = require('../../package.json');

/**
 * Состояние службы. Открыто без входа, поэтому здесь только то, по чему
 * нельзя ничего узнать о людях и секретах: версия, версия схемы, пишется
 * ли база и подключён ли помощник.
 *
 * Про помощника — признак «да/нет», без адреса, ключа и названий моделей.
 * Он нужен затем, чтобы после развёртывания было видно, доехали ли до
 * контейнера переменные. Без него проверить нечем: настройки закрыты
 * админом, а вход требует подтверждённой почты — и неподключённый помощник
 * обнаружился бы только тогда, когда человек нажал кнопку и ничего не
 * произошло.
 */
module.exports = function healthRouter(db, { ai } = {}) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    let schemaVersion = 0;
    let dbWritable = false;
    try {
      schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
      db.prepare('CREATE TABLE IF NOT EXISTS _write_probe (x INTEGER)').run();
      db.prepare('DROP TABLE IF EXISTS _write_probe').run();
      dbWritable = true;
    } catch {
      dbWritable = false;
    }

    const state = ai?.status();

    res.status(dbWritable ? 200 : 503).json({
      ok: dbWritable,
      schemaVersion,
      dbWritable,
      version: pkg.version,
      ...(state ? { ai: { ready: state.ready, voice: state.voice } } : {}),
    });
  });

  return router;
};
