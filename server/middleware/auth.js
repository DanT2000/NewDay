const { ApiError, unauthorized, forbidden } = require('../lib/errors');
const { usersRepo } = require('../repos/users');
const { tokensRepo } = require('../repos/tokens');
const { devicesRepo } = require('../repos/devices');

/**
 * Три способа аутентификации на одних и тех же путях:
 *   - cookie-сессия (веб)        → scope write
 *   - Bearer nd_…  (API-токен)   → scope из токена
 *   - Bearer ndd_… (устройство)  → scope write
 *
 * Кладёт в req.user строку пользователя, в req.auth — { kind, scope, id }.
 */
function createAuthMiddleware(db) {
  const users = usersRepo(db);
  const tokens = tokensRepo(db);
  const devices = devicesRepo(db);

  function resolve(req) {
    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (bearer) {
      const asToken = tokens.authenticate(bearer);
      if (asToken) {
        return { userId: asToken.userId, kind: 'token', scope: asToken.scope, id: asToken.tokenId };
      }
      const asDevice = devices.authenticate(bearer);
      if (asDevice) {
        return { userId: asDevice.userId, kind: 'device', scope: 'write', id: asDevice.deviceId };
      }
      return null;
    }

    if (req.session?.userId) {
      return { userId: req.session.userId, kind: 'session', scope: 'write', id: req.session.userId };
    }
    return null;
  }

  function requireAuth(req, _res, next) {
    const auth = resolve(req);
    if (!auth) return next(unauthorized());

    const user = users.findById(auth.userId);
    if (!user) return next(unauthorized());
    if (user.email_verified !== 1) {
      return next(new ApiError(403, 'EMAIL_NOT_VERIFIED',
        'Подтвердите адрес почты, чтобы продолжить'));
    }

    req.user = user;
    req.auth = { kind: auth.kind, scope: auth.scope, id: auth.id };
    next();
  }

  /** Пишущие методы недоступны токенам со scope=read. */
  function requireScope(required) {
    return (req, _res, next) => {
      if (required === 'write' && req.auth?.scope !== 'write') {
        return next(new ApiError(403, 'INSUFFICIENT_SCOPE',
          'Токену не хватает прав на запись'));
      }
      next();
    };
  }

  /** Только сессия: создание токенов и кодов привязки нельзя делать самим токеном. */
  function requireSession(req, _res, next) {
    if (req.auth?.kind !== 'session') {
      return next(forbidden('Действие доступно только из веб-сессии'));
    }
    next();
  }

  return { requireAuth, requireScope, requireSession };
}

module.exports = { createAuthMiddleware };
