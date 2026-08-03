const express = require('express');
const { wrap } = require('../../lib/errors');
const v = require('../../lib/validate');
const { tokensRepo } = require('../../repos/tokens');
const { devicesRepo } = require('../../repos/devices');

module.exports = function tokensRouter({ db, auth }) {
  const router = express.Router();
  const tokens = tokensRepo(db);
  const devices = devicesRepo(db);

  router.get('/tokens', auth.requireAuth, wrap((req, res) => {
    res.json(tokens.list(req.user.id));
  }));

  // Создание токена — только из веб-сессии: токен не должен уметь плодить токены.
  router.post('/tokens', auth.requireAuth, auth.requireSession, wrap((req, res) => {
    const name = v.str(req.body.name, { max: 80, field: 'название' });
    const scope = v.oneOf(req.body.scope, ['read', 'write'], { field: 'scope', fallback: 'read' });
    res.status(201).json(tokens.create(req.user.id, { name, scope }));
  }));

  router.delete('/tokens/:id', auth.requireAuth, auth.requireSession, wrap((req, res) => {
    tokens.revoke(req.user.id, v.int(req.params.id, { min: 1, field: 'id' }));
    res.status(204).end();
  }));

  router.get('/devices', auth.requireAuth, wrap((req, res) => {
    res.json(devices.list(req.user.id));
  }));

  router.delete('/devices/:id', auth.requireAuth, auth.requireSession, wrap((req, res) => {
    devices.revoke(req.user.id, v.int(req.params.id, { min: 1, field: 'id' }));
    res.status(204).end();
  }));

  return router;
};
