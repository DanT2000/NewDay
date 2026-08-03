const express = require('express');
const pkg = require('../../package.json');

module.exports = function healthRouter(db) {
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
    res.status(dbWritable ? 200 : 503).json({
      ok: dbWritable,
      schemaVersion,
      dbWritable,
      version: pkg.version,
    });
  });

  return router;
};
