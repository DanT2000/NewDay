const fs = require('node:fs');
const path = require('node:path');

const KEEP = 14;

function backupDir(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

/** Снимок базы средствами SQLite — консистентнее, чем копирование файла. */
function runBackup(db, dbPath, stamp) {
  const dir = backupDir(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const ts = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `newday-${ts}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  rotate(dir);
  return target;
}

function rotate(dir, keep = KEEP) {
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('newday-') && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const f of files.slice(keep)) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* уже удалён */ }
  }
}

/**
 * Ежедневный бэкап плюс снимок перед применением миграций.
 * Возвращает функцию остановки таймера.
 */
function scheduleDailyBackup(db, dbPath) {
  const timer = setInterval(() => {
    try { runBackup(db, dbPath); }
    catch (e) { console.error('[newday] бэкап не удался:', e.message); }
  }, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { runBackup, rotate, scheduleDailyBackup, backupDir };
