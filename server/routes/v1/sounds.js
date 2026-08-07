/**
 * Свои звуки будильника.
 *
 * Встроенных мелодий мало, а просыпаться приятнее под свою. Файл хранится
 * на сервере, а не в браузере: браузерное хранилище живёт до первой чистки,
 * и будильник, потерявший звук за ночь, — это проспанное утро. С сервера же
 * звук доступен с любого устройства под тем же аккаунтом.
 *
 * Метаданные — в таблице user_sounds, сам файл — на диске рядом с базой:
 * sounds/<user_id>/<id>.<ext>. Пути к файлу наружу не отдаются — только id,
 * а расширение хранится в строке таблицы, чтобы путь собирался из неё.
 *
 * Ограничения — не жадность, а здравый смысл: 10 МБ — это десять минут звука
 * в хорошем качестве, дольше будильник не звонит; 20 звуков — это уже
 * фонотека, а не набор будильников.
 */

const express = require('express');
const busboy = require('busboy');
const fs = require('node:fs');
const path = require('node:path');
const { wrap, notFound, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');

const MB = 1024 * 1024;
const MAX_FILE_BYTES = 10 * MB;
/** Запас на служебные строки multipart: сам файл в них чуть «тяжелеет». */
const FORM_OVERHEAD = 16 * 1024;
const MAX_SOUNDS = 20;

/** Что принимаем и под каким расширением кладём на диск. */
const AUDIO_EXT = {
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/x-m4a': 'm4a',
};

/** 11534336 → «11», 11010048 → «10.5»: человеку хватает одного знака. */
const fmtMb = bytes => (bytes / MB).toFixed(1).replace(/\.0$/, '');

const tooBig = bytes => badRequest(
  `Файл весит ${bytes ? fmtMb(bytes) : 'больше 10'} МБ, `
  + 'а будильнику хватает 10: десять минут звука в хорошем качестве');

const notAudio = () => badRequest('Это не похоже на звук: нужен mp3, ogg, wav или m4a');

module.exports = function soundsRouter({ db, config }) {
  const router = express.Router();

  const own = (userId, id) => {
    const row = db.prepare('SELECT * FROM user_sounds WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw notFound('Звук не найден');
    return row;
  };

  const fileOf = row =>
    path.join(config.soundsDir, String(row.user_id), `${row.id}.${row.ext}`);

  const shape = row => ({
    id: row.id,
    name: row.name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  });

  router.get('/', wrap((req, res) => {
    const rows = db.prepare(
      'SELECT * FROM user_sounds WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    ).all(req.user.id);
    res.json(rows.map(shape));
  }));

  router.post('/', wrap(async (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM user_sounds WHERE user_id = ?')
      .get(req.user.id).n;
    if (count >= MAX_SOUNDS) {
      throw badRequest(`Уже ${MAX_SOUNDS} своих звуков — удалите ненужный`);
    }

    /*
     * Сначала — заявленный размер: клиент, честно приславший Content-Length,
     * получает отказ сразу, а не после выгрузки всех своих мегабайтов.
     * Но верить заголовку на слово нельзя, поэтому ниже busboy режет и по
     * фактически пришедшим байтам.
     */
    const declared = Number(req.get('content-length')) || 0;
    if (declared > MAX_FILE_BYTES + FORM_OVERHEAD) throw tooBig(declared);

    const form = await readSound(req).catch(e => { throw badRequest(e.message); });
    if (form.truncated) throw tooBig(declared > MAX_FILE_BYTES ? declared : 0);
    if (!form.file) throw badRequest('Нет файла: пришлите форму с полем file');

    const ext = AUDIO_EXT[form.mime];
    if (!ext) throw notAudio();

    // Имя — как человек назвал, иначе имя файла без расширения
    const name = v.str(form.fields.name, { max: 200, field: 'название' })
      || form.filename.replace(/\.[^.]*$/, '').trim()
      || 'Звук';

    const { lastInsertRowid } = db.prepare(
      'INSERT INTO user_sounds (user_id, name, mime, ext, size_bytes) VALUES (?,?,?,?,?)',
    ).run(req.user.id, name, form.mime, ext, form.file.length);

    const row = own(req.user.id, lastInsertRowid);
    try {
      fs.mkdirSync(path.dirname(fileOf(row)), { recursive: true });
      fs.writeFileSync(fileOf(row), form.file);
    } catch (e) {
      // Запись без файла — обещание звука, которого нет. Лучше честный отказ.
      db.prepare('DELETE FROM user_sounds WHERE id = ?').run(row.id);
      throw e;
    }

    res.status(201).json(shape(row));
  }));

  /**
   * Сам звук. Кешировать можно, но только себе (`private`): файл загружен
   * под аккаунтом, и общий кеш по пути отдал бы его другому человеку.
   * Час — достаточно, чтобы будильник не ходил за звуком каждую минуту,
   * и достаточно мало, чтобы удалённый звук не жил в кеше вечно.
   */
  router.get('/:id/file', wrap((req, res, next) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const row = own(req.user.id, id);
    res.sendFile(fileOf(row), {
      headers: {
        'Content-Type': row.mime,
        'Cache-Control': 'private, max-age=3600',
      },
    }, err => {
      if (!err) return;
      // Строка есть, а файла нет — том потеряли; для клиента это те же 404
      next(err.code === 'ENOENT' ? notFound('Звук не найден') : err);
    });
  }));

  router.delete('/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const row = own(req.user.id, id);
    db.prepare('DELETE FROM user_sounds WHERE id = ? AND user_id = ?').run(id, req.user.id);
    try { fs.unlinkSync(fileOf(row)); } catch { /* файла уже нет — и ладно */ }
    res.json({ success: true });
  }));

  return router;
};

/**
 * Разбор формы без временных файлов: 10 МБ спокойно живут в памяти.
 * Тот же busboy, что и в /ai/transcribe, — новая зависимость не нужна.
 */
function readSound(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_FILE_BYTES },
        // Имена файлов приходят в UTF-8, а busboy по умолчанию читает
        // заголовки как latin1 — «Пение птиц.mp3» превращалось в кашу
        defParamCharset: 'utf8',
      });
    } catch {
      return reject(new Error('Ожидалась форма со звуком (multipart/form-data)'));
    }

    const fields = {};
    const parts = [];
    let filename = '';
    let mime = '';
    let truncated = false;

    bb.on('field', (fieldName, value) => { fields[fieldName] = value; });
    bb.on('file', (_name, stream, info) => {
      filename = info.filename || '';
      // Тип может прийти с параметрами («audio/ogg; codecs=opus») — они не важны
      mime = String(info.mimeType || '').split(';')[0].trim().toLowerCase();
      stream.on('limit', () => { truncated = true; });
      stream.on('data', d => parts.push(d));
    });
    bb.on('error', e => reject(new Error(`Не разобрал форму: ${e.message}`)));
    bb.on('close', () => resolve({
      fields, filename, mime, truncated,
      file: parts.length ? Buffer.concat(parts) : null,
    }));

    req.pipe(bb);
  });
}
