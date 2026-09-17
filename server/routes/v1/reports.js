const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const busboy = require('busboy');

const { wrap, badRequest, forbidden, ApiError } = require('../../lib/errors');
const { sendFileSafe } = require('../../lib/sendFile');
const v = require('../../lib/validate');
const { isAdmin } = require('../../lib/admin');
const { reportsRepo } = require('../../repos/reports');

/*
 * Пределы. Запись голоса на минуту разговора — около мегабайта, снимок
 * экрана телефона — два-три. Берём с большим запасом и всё равно режем:
 * сообщение о проблеме не повод присылать на сервер видео.
 */
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_SHOT = 12 * 1024 * 1024;
const MAX_TEXT = 4000;
const MAX_CONTEXT = 16 * 1024;
const MAX_LOG = 256 * 1024;

const AUDIO_EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav',
  'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
};
const SHOT_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/heic': 'heic',
};
const MIME_OF = Object.fromEntries(
  [...Object.entries(AUDIO_EXT), ...Object.entries(SHOT_EXT)].map(([mime, ext]) => [ext, mime]));

const STATUSES = ['new', 'seen', 'done'];

/** Разбор формы: два файла и несколько полей, всё в памяти. */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 2, fileSize: MAX_AUDIO, fields: 12 } });
    } catch {
      return reject(new Error('Ожидалась форма'));
    }
    const fields = {};
    const files = {};
    let tooBig = null;

    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const parts = [];
      stream.on('limit', () => { tooBig = name; });
      stream.on('data', d => parts.push(d));
      stream.on('end', () => {
        files[name] = { buf: Buffer.concat(parts), mime: info.mimeType || '', filename: info.filename || '' };
      });
    });
    bb.on('error', e => reject(new Error(`Не разобрал форму: ${e.message}`)));
    bb.on('close', () => {
      if (tooBig) return reject(new Error(tooBig === 'shot' ? 'Снимок слишком большой' : 'Запись слишком длинная'));
      resolve({ fields, files });
    });
    req.pipe(bb);
  });
}

/** Что уходит наружу: строка базы без внутренних полей и без чужих путей. */
const shape = row => ({
  id: row.id,
  text: row.text,
  typed: row.typed === 1,
  voiceError: row.voice_error || null,
  hasAudio: Boolean(row.audio_ext),
  hasShot: Boolean(row.shot_ext),
  audioBytes: row.audio_bytes ?? null,
  shotBytes: row.shot_bytes ?? null,
  status: row.status,
  createdAt: row.created_at,
  from: { id: row.user_id, username: row.username, email: row.email },
  ...(row.context !== undefined ? { context: safeJson(row.context, {}) } : {}),
  ...(row.log !== undefined ? { log: safeJson(row.log, []) } : {}),
});

const safeJson = (raw, fallback) => {
  try { return JSON.parse(raw); } catch { return fallback; }
};

/**
 * Сообщения о проблемах.
 *
 * Пишет любой вошедший — на то и кнопка «одно нажатие». Читает только
 * владелец: в чужом сообщении лежат и текст, и снимок чужого экрана.
 */
module.exports = function reportsRouter({ db, config, ai }) {
  const router = express.Router();
  const repo = reportsRepo(db);

  const dirOf = id => path.join(config.reportsDir, String(id));
  const fileOf = (id, kind, ext) => path.join(dirOf(id), `${kind}.${ext}`);

  const onlyAdmin = (req) => {
    if (!isAdmin(req.user, config)) throw forbidden('Сообщения читает владелец приложения');
  };

  /**
   * Прислать сообщение о проблеме.
   *
   * Ничего не обязательно по отдельности, но что-то быть должно: пустое
   * сообщение — это случайное нажатие, и хранить его незачем.
   *
   * Расшифровка не обязана удаться. Провайдер может лежать, а сказанное
   * не повторишь — поэтому неудача записывается в `voiceError`, файл
   * сохраняется, и сообщение всё равно принимается.
   */
  router.post('/', wrap(async (req, res) => {
    const declared = Number(req.get('content-length')) || 0;
    if (declared > MAX_AUDIO + MAX_SHOT + MAX_LOG) {
      throw new ApiError(413, 'TOO_BIG', 'Сообщение слишком большое');
    }

    const form = await readForm(req).catch(e => { throw badRequest(e.message); });
    const text = v.str(form.fields.text, { max: MAX_TEXT, field: 'сообщение' });
    const audio = form.files.audio?.buf?.length ? form.files.audio : null;
    const shot = form.files.shot?.buf?.length ? form.files.shot : null;

    if (!text && !audio && !shot) throw badRequest('Пустое сообщение: напишите или наговорите, что случилось');
    if (shot && shot.buf.length > MAX_SHOT) throw badRequest('Снимок слишком большой');

    const audioExt = audio ? (AUDIO_EXT[audio.mime.split(';')[0].trim()] || 'webm') : null;
    const shotExt = shot ? SHOT_EXT[shot.mime.split(';')[0].trim()] : null;
    if (shot && !shotExt) throw badRequest('Снимок должен быть картинкой: png, jpeg, webp');

    /*
     * Расшифровываем сразу, а не потом: человек хочет знать, что его
     * услышали, а владелец — читать список глазами, а не слушать записи.
     */
    let voiceError = null;
    let voiceText = '';
    if (audio) {
      if (!ai?.status?.().voice) {
        voiceError = 'Распознавание речи не подключено — запись сохранена';
      } else {
        const r = await ai.transcribe({
          userId: req.user.id, audio: audio.buf,
          filename: audio.filename || `zapis.${audioExt}`, language: 'ru',
        }).catch(e => ({ ok: false, error: e?.message || 'Распознавание не ответило' }));
        if (r.ok) voiceText = String(r.text || '').trim();
        else voiceError = r.error || 'Не удалось распознать запись';
      }
    }

    // Написанное руками и сказанное голосом — одно сообщение, но видно, что
    // откуда: без пометки не понять, ошибка это расшифровки или человека
    const full = [text, voiceText].filter(Boolean).join(text && voiceText ? '\n\n' : '');

    const row = repo.create(req.user.id, {
      text: full,
      typed: Boolean(text),
      voiceError,
      audioExt, audioBytes: audio ? audio.buf.length : null,
      shotExt, shotBytes: shot ? shot.buf.length : null,
      context: safeJson(String(form.fields.context || '{}').slice(0, MAX_CONTEXT), {}),
      log: safeJson(String(form.fields.log || '[]').slice(0, MAX_LOG), []),
    });

    try {
      if (audio || shot) fs.mkdirSync(dirOf(row.id), { recursive: true });
      if (audio) fs.writeFileSync(fileOf(row.id, 'audio', audioExt), audio.buf);
      if (shot) fs.writeFileSync(fileOf(row.id, 'shot', shotExt), shot.buf);
    } catch (e) {
      // Строка без файла обещает запись, которой нет: честнее отказать
      repo.remove(row.id);
      throw e;
    }

    res.status(201).json(shape(row));
  }));

  // ── Чтение: только владелец ───────────────────────────────

  router.get('/', wrap((req, res) => {
    onlyAdmin(req);
    const status = req.query.status ? v.oneOf(req.query.status, STATUSES, { field: 'состояние' }) : null;
    const rows = repo.list({
      status,
      limit: req.query.limit ? v.int(req.query.limit, { min: 1, max: 200, field: 'сколько' }) : undefined,
      before: req.query.before ? v.int(req.query.before, { min: 1, field: 'до номера' }) : null,
    });
    res.json({ reports: rows.map(shape), counts: repo.counts() });
  }));

  router.get('/:id', wrap((req, res) => {
    onlyAdmin(req);
    res.json(shape(repo.get(v.int(req.params.id, { min: 1, field: 'id' }))));
  }));

  /** Сам файл: запись или снимок. Кешировать нечего — читают один раз. */
  for (const kind of ['audio', 'shot']) {
    router.get(`/:id/${kind}`, wrap((req, res, next) => {
      onlyAdmin(req);
      const row = repo.get(v.int(req.params.id, { min: 1, field: 'id' }));
      const ext = kind === 'audio' ? row.audio_ext : row.shot_ext;
      if (!ext) throw new ApiError(404, 'NOT_FOUND', 'К сообщению это не приложено');
      const file = fileOf(row.id, kind, ext);
      if (!fs.existsSync(file)) throw new ApiError(404, 'NOT_FOUND', 'Файл потерян');
      sendFileSafe(res, next, file, {
        headers: {
          'Content-Type': MIME_OF[ext] || 'application/octet-stream',
          'Cache-Control': 'private, no-store',
        },
        notFoundMessage: 'Файл потерян',
      });
    }));
  }

  router.patch('/:id', wrap((req, res) => {
    onlyAdmin(req);
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const status = v.oneOf(req.body?.status, STATUSES, { field: 'состояние' });
    res.json(shape(repo.setStatus(id, status)));
  }));

  router.delete('/:id', wrap((req, res) => {
    onlyAdmin(req);
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    repo.get(id);
    repo.remove(id);
    fs.rmSync(dirOf(id), { recursive: true, force: true });
    res.status(204).end();
  }));

  return router;
};
