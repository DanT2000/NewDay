const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { isValidTimezone, todayFor } = require('../../lib/dates');
const { usersRepo, publicUser } = require('../../repos/users');
const { appSettingsRepo } = require('../../repos/appSettings');
const { isAdmin } = require('../../lib/admin');

const MAX_SETTING_KEYS = 100;
const MAX_SETTING_BYTES = 20000;

const THEMES = ['system', 'light', 'dark'];
const VIEWS = ['list', 'timeline'];
const FOOD_MODES = ['checklist', 'timed'];

module.exports = function settingsRouter({ db, config }) {
  const router = express.Router();
  const users = usersRepo(db);
  const appSettings = appSettingsRepo(db);

  router.get('/', wrap((req, res) => {
    res.json({
      ...publicUser(req.user, users.getSettings(req.user.id)),
      // Админ может быть задан адресом в окружении, а не флагом в базе
      isAdmin: isAdmin(req.user, config),
      today: todayFor(req.user.timezone),
      // ИИ общий на весь экземпляр: интерфейсу нужно знать лишь,
      // работает ли он. Ключ и адрес видит только администратор.
      ai: { ready: appSettings.aiPublic().ready },
    });
  }));

  router.patch('/', wrap((req, res) => {
    const body = req.body || {};
    const profile = {};

    if (body.displayName !== undefined) {
      profile.displayName = v.str(body.displayName, { max: 80, field: 'имя' });
    }
    if (body.timezone !== undefined) {
      const tz = v.str(body.timezone, { max: 64, field: 'таймзона' });
      if (!isValidTimezone(tz)) throw badRequest('Неизвестная таймзона');
      profile.timezone = tz;
    }
    if (body.theme !== undefined) profile.theme = v.oneOf(body.theme, THEMES, { field: 'тема' });
    if (body.weekStart !== undefined) profile.weekStart = v.int(body.weekStart, { min: 1, max: 7, field: 'начало недели' });
    if (body.scheduleView !== undefined) profile.scheduleView = v.oneOf(body.scheduleView, VIEWS, { field: 'вид расписания' });
    if (body.foodMode !== undefined) profile.foodMode = v.oneOf(body.foodMode, FOOD_MODES, { field: 'режим питания' });

    const user = users.patchProfile(req.user.id, profile);

    if (body.settings && typeof body.settings === 'object') {
      const settings = { ...body.settings };
      /*
       * Мешок настроек не резиновый.
       *
       * Ключи и значения здесь свободные — так удобно добавлять
       * переключатели, не трогая сервер. Но без предела один аккаунт
       * раздувает и базу, и собственные ответы: настройки целиком приезжают
       * в каждый GET настроек, в «кто я» и в ответ на вход.
       */
      const ключей = Object.keys(settings);
      if (ключей.length > MAX_SETTING_KEYS) {
        throw badRequest(`Слишком много настроек за раз: максимум ${MAX_SETTING_KEYS}`);
      }
      for (const key of ключей) {
        if (key.length > 64) throw badRequest(`Имя настройки длиннее 64 символов: «${key.slice(0, 40)}…»`);
        const размер = JSON.stringify(settings[key] ?? null).length;
        if (размер > MAX_SETTING_BYTES) {
          throw badRequest(`Настройка «${key}» больше ${MAX_SETTING_BYTES} символов`);
        }
      }
      /*
       * С какого дня включён перенос невыполненного.
       *
       * Человек месяц не пользовался переносом, потом включил — и получил в
       * сегодня всё, что не отметил за прошлые недели, хотя давно сделал это
       * и просто не ставил галочку. Переносим только то, что осталось
       * несделанным с момента включения. Дату ставит сервер, а не клиент:
       * «когда включил» — это факт, а не настройка.
       */
      delete settings.carryOverSince;
      if (settings.carryOver !== undefined) {
        const was = users.getSettings(req.user.id).carryOver === true;
        if (settings.carryOver === true && !was) settings.carryOverSince = todayFor(user.timezone);
        if (settings.carryOver !== true) settings.carryOverSince = null;
      }
      users.setSettings(req.user.id, settings);
    }

    res.json({
      ...publicUser(user, users.getSettings(req.user.id)),
      today: todayFor(user.timezone),
    });
  }));

  return router;
};
