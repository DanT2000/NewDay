/**
 * Объявление владельца сервера — то, что видят все вошедшие.
 *
 * Читающий маршрут и больше ничего: писать объявление умеет только панель
 * администратора (/api/admin/announce), у неё свой вход по паролю экземпляра.
 *
 * Выключенное объявление и пустой текст отдаются одинаково — «показывать
 * нечего»: клиенту незачем знать, тумблер погашен или слова не написаны, а
 * заготовленный, но ещё не включённый текст не должен утекать до времени.
 *
 * rev при этом отдаётся настоящий, а не нулевой. Он говорит не «показать»,
 * а «какая это редакция»: человек мог закрыть полосу, админ — выключить и
 * снова включить её, и по сохранённому номеру закрытие остаётся в силе.
 */

const express = require('express');
const { wrap } = require('../../lib/errors');
const { appSettingsRepo } = require('../../repos/appSettings');
const { panelSettings } = require('../../repos/panelSettings');

module.exports = function announceRouter({ db }) {
  const router = express.Router();
  const panel = panelSettings(appSettingsRepo(db));

  router.get('/', wrap((_req, res) => {
    const a = panel.announce();
    const show = a.on && a.text !== '';
    res.json({ on: show, text: show ? a.text : '', rev: a.rev });
  }));

  return router;
};
