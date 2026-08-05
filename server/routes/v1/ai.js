/**
 * Помощник — то, чем пользуется приложение.
 *
 * Три действия и ничего лишнего: узнать, подключён ли помощник; разобрать
 * надиктованное в план дня; причесать текст. Плюс распознавание речи —
 * оно приходит формой, потому что везёт звук.
 *
 * Разбор бывает двухэтапным: модель может задать один уточняющий вопрос
 * с готовыми вариантами ответа. Приложение показывает их кнопками и
 * присылает выбранное обратно в `history`.
 */

const express = require('express');
const busboy = require('busboy');
const { wrap, ApiError, badRequest } = require('../../lib/errors');

/** Диктовка длиннее двадцати минут — это уже не планирование дня. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 20000;

module.exports = function aiRouter({ ai }) {
  const router = express.Router();

  router.get('/status', wrap((_req, res) => res.json(ai.status())));

  /** Разобрать сказанное в дела, расписание и напоминания. */
  router.post('/parse', wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw badRequest('Нет текста');
    if (text.length > MAX_TEXT) throw badRequest('Слишком длинный текст');
    ready(ai);

    const r = await ai.parse({
      userId: req.user.id,
      text,
      date: String(req.body?.date || '').slice(0, 10) || today(req.user.timezone),
      timezone: req.user.timezone,
      history: asHistory(req.body?.history),
    });
    if (!r.ok) throw failed(r.error);
    res.json(r);
  }));

  /** Причесать надиктованный текст. */
  router.post('/improve', wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw badRequest('Нет текста');
    if (text.length > MAX_TEXT) throw badRequest('Слишком длинный текст');
    ready(ai);

    const r = await ai.improve({ userId: req.user.id, text });
    if (!r.ok) throw failed(r.error);
    res.json(r);
  }));

  /**
   * Речь в текст. Звук не сохраняем: он нужен ровно на время запроса,
   * а хранить чужие голоса на сервере — лишняя ответственность.
   */
  router.post('/transcribe', wrap(async (req, res) => {
    if (!ai.status().voice) {
      throw new ApiError(503, 'AI_OFF', 'Распознавание речи не подключено');
    }

    const form = await readAudio(req).catch(e => { throw badRequest(e.message); });
    if (!form.file) throw badRequest('Нет записи');

    const r = await ai.transcribe({
      userId: req.user.id,
      audio: form.file,
      filename: form.filename,
      language: form.fields.language || 'ru',
    });
    if (!r.ok) throw failed(r.error);
    res.json(r);
  }));

  return router;
};

function ready(ai) {
  if (!ai.status().ready) {
    throw new ApiError(503, 'AI_OFF', 'Помощник не подключён. Владелец задаёт подключение в настройках');
  }
}

/** Отказ провайдера — это 502: сервер работает, а тот, кто за ним, нет. */
const failed = message => new ApiError(502, 'AI_FAILED', message || 'Помощник не справился');

/**
 * Ходы предыдущего разбора. Пускаем только роли и текст: сюда приходит
 * то, что приложение получило от нас же, но проверять всё равно надо.
 */
function asHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
    .slice(-6)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

const today = timezone => new Date().toLocaleDateString('en-CA', { timeZone: timezone || 'UTC' });

/** Разбор формы без временных файлов: запись помещается в память. */
function readAudio(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_AUDIO_BYTES } });
    } catch {
      return reject(new Error('Ожидалась форма со звуком'));
    }

    const fields = {};
    const parts = [];
    let filename = 'zapis.webm';
    let tooBig = false;

    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (_name, stream, info) => {
      filename = info.filename || filename;
      stream.on('limit', () => { tooBig = true; });
      stream.on('data', d => parts.push(d));
    });
    bb.on('error', e => reject(new Error(`Не разобрал форму: ${e.message}`)));
    bb.on('close', () => {
      if (tooBig) return reject(new Error('Запись больше 25 МБ'));
      resolve({ fields, filename, file: parts.length ? Buffer.concat(parts) : null });
    });

    req.pipe(bb);
  });
}
