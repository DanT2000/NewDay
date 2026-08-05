const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { isValidTimezone, todayFor } = require('../../lib/dates');
const { usersRepo, publicUser } = require('../../repos/users');
const { appSettingsRepo } = require('../../repos/appSettings');
const { isAdmin } = require('../../lib/admin');

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
      users.setSettings(req.user.id, body.settings);
    }

    res.json({
      ...publicUser(user, users.getSettings(req.user.id)),
      today: todayFor(user.timezone),
    });
  }));

  return router;
};
