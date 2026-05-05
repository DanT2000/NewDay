function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    return res.redirect('/login');
  }
  next();
}

module.exports = { requireAuth };
