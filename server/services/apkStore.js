/**
 * Хранилище APK на самом сайте.
 *
 * Файл лежит рядом с базой — в том же постоянном томе, поэтому переживает
 * пересборку контейнера. В репозиторий четырёхмегабайтный бинарник не кладём:
 * git для этого не предназначен, а история распухает с каждой версией.
 *
 * Раздаёт файл сам сайт, а не GitHub: приложение уже доверяет своему серверу,
 * и человеку не нужен доступ к чужому репозиторию, чтобы обновиться.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const META = 'latest.json';
const KEEP = 3;                  // сколько прошлых версий держим на всякий случай
const NAME_RE = /^\d+\.\d+\.\d+$/;

/** v1.2.3 → 10203. Строками версии сравнивать нельзя: «1.10» < «1.9». */
function versionCodeOf(versionName) {
  const m = String(versionName || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return 0;
  const [, major, minor, patch] = m.map(Number);
  return major * 10000 + minor * 100 + patch;
}

function apkStore({ dir }) {
  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function metaPath() {
    return path.join(dir, META);
  }

  /** Что лежит сейчас, или null. Битую запись считаем отсутствующей. */
  function current() {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
      const file = path.join(dir, meta.fileName);
      if (!fs.existsSync(file)) return null;
      return { ...meta, filePath: file };
    } catch {
      return null;
    }
  }

  /**
   * Кладёт новую версию. Старше или равной не принимаем: подмена свежего APK
   * старым — самый неприятный способ сломать обновление.
   */
  function save(buffer, { versionName, notes = '' }) {
    if (!NAME_RE.test(versionName)) {
      throw Object.assign(new Error('Версия должна быть вида 1.2.3'), { code: 'BAD_VERSION' });
    }
    if (!buffer || buffer.length < 1024) {
      throw Object.assign(new Error('Пустой или слишком маленький файл'), { code: 'BAD_FILE' });
    }
    // APK — это zip: первые байты PK\x03\x04
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      throw Object.assign(new Error('Это не APK'), { code: 'BAD_FILE' });
    }

    const versionCode = versionCodeOf(versionName);
    const existing = current();
    if (existing && existing.versionCode >= versionCode) {
      throw Object.assign(
        new Error(`Уже выложена версия ${existing.versionName}, эта не новее`),
        { code: 'NOT_NEWER' },
      );
    }

    ensureDir();
    const fileName = `NewDay-${versionName}.apk`;
    fs.writeFileSync(path.join(dir, fileName), buffer);

    const meta = {
      versionName,
      versionCode,
      fileName,
      sizeBytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      notes,
      publishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
    prune();
    return meta;
  }

  /** Оставляем несколько последних файлов: откатиться иногда нужно. */
  function prune() {
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.apk'));
    } catch {
      return;
    }
    files
      .map(f => ({ f, code: versionCodeOf(f.replace(/^NewDay-|\.apk$/g, '')) }))
      .sort((a, b) => b.code - a.code)
      .slice(KEEP)
      .forEach(({ f }) => {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* уже нет — и ладно */ }
      });
  }

  return { current, save, dir, versionCodeOf };
}

module.exports = { apkStore, versionCodeOf };
