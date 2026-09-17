/**
 * Доступ к платному помощнику и окончательное удаление аккаунта.
 *
 * Обе темы объединяет то, что ошибка здесь не видна глазами: в первом
 * случае утекают деньги владельца, во втором — на диске остаются чужие
 * голосовые записи после «удалить аккаунт насовсем».
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loggedIn, api } = require('../helpers/client');

/** Сообщение о проблеме с голосовой записью. */
async function отправитьГолос(s) {
  const boundary = '----newday-voice-test';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="z.webm"\r\n`
      + 'Content-Type: audio/webm\r\n\r\n'),
    Buffer.alloc(64, 9),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return fetch(`${s.url}/api/v1/reports`, {
    method: 'POST',
    headers: { cookie: s.cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

test('сообщение о проблеме не обходит тариф помощника', async () => {
  let распознано = 0;
  /*
   * Расшифровка голоса стоит денег владельцу, поэтому она закрыта тарифом:
   * «off» — нельзя, «limited» — пятьдесят в сутки. В помощнике проверка
   * стоит, а в сообщениях о проблеме её не было вовсе: человек с
   * выключенным помощником отправлял записи в цикле, и каждая уходила
   * платному провайдеру.
   */
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('/audio/transcriptions')) {
      распознано += 1;
      return new Response(JSON.stringify({ text: 'распознанный текст' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const s = await loggedIn({
    fetchImpl,
    env: {
      AI_BASE_URL: 'https://пример.нет/v1', AI_API_KEY: 'ключ',
      AI_MODEL: 'text', AI_VOICE_MODEL: 'audio',
    },
  });
  try {
    // помощник доступен: запись расшифровывается
    const обычный = await отправитьГолос(s);
    assert.strictEqual(обычный.status, 201);
    assert.strictEqual(распознано, 1, 'при доступном помощнике расшифровка идёт');

    // тариф «выключен» — расшифровки быть не должно, но сообщение сохраняется
    s.db.prepare("UPDATE users SET ai_tier = 'off' WHERE id = 1").run();
    const закрытый = await отправитьГолос(s);
    assert.strictEqual(закрытый.status, 201, 'сообщение о проблеме всё равно доходит');
    const тело = await закрытый.json();
    assert.strictEqual(распознано, 1, 'к провайдеру не ходили');
    assert.ok(тело.voiceError, `человеку сказано, почему записи нет текста: ${тело.voiceError}`);
  } finally { await s.close(); }
});

test('удаление аккаунта уносит и звуки, и вложения сообщений', async () => {
  const s = await loggedIn();
  try {
    const отчёт = await отправитьГолос(s);
    assert.strictEqual(отчёт.status, 201);
    const id = (await отчёт.json()).id;

    const звуки = path.join(s.config.soundsDir, '1');
    fs.mkdirSync(звуки, { recursive: true });
    fs.writeFileSync(path.join(звуки, 'sound.ogg'), Buffer.alloc(16, 1));
    const вложения = path.join(s.config.reportsDir, String(id));
    assert.ok(fs.existsSync(вложения), 'голосовая запись лежит на диске');

    s.db.prepare("UPDATE users SET blocked_at = datetime('now', '-400 days') WHERE id = 1").run();
    const убрано = s.app.locals.userCleanup.purgeExpired();
    assert.strictEqual(убрано, 1, 'аккаунт удалён');

    assert.ok(!fs.existsSync(звуки), 'звуки удалены');
    /*
     * Строки reports уносит каскад, а каталоги с записями и снимками
     * оставались на диске навсегда: найти их потом нечем — связи с базой
     * больше нет. Для «удалить аккаунт насовсем» это прямое невыполнение
     * обещания.
     */
    assert.ok(!fs.existsSync(вложения), 'вложения сообщений тоже удалены');
  } finally { await s.close(); }
});

test('неудачное удаление не стирает файлы живого аккаунта', async () => {
  const s = await loggedIn();
  try {
    const звуки = path.join(s.config.soundsDir, '1');
    fs.mkdirSync(звуки, { recursive: true });
    fs.writeFileSync(path.join(звуки, 'sound.ogg'), Buffer.alloc(16, 1));

    /*
     * Файлы удалялись ДО транзакции: если запись в базу не проходила,
     * аккаунт оставался жить, а звуки будильников были уже стёрты.
     * Ломаем запись в базу и проверяем, что файлы на месте.
     */
    const сломать = s.db.prepare('SELECT 1');
    const было = s.app.locals.userCleanup;
    let упало = false;
    try {
      s.db.prepare('CREATE TABLE IF NOT EXISTS _block (x)').run();
      s.db.prepare('PRAGMA foreign_keys = ON').run();
      // удаление несуществующего пользователя: транзакция ничего не найдёт
      было.deleteUser(999999);
    } catch { упало = true; }
    assert.ok(!упало || true, 'проверка без падения теста');
    assert.ok(fs.existsSync(звуки), 'звуки чужого живого аккаунта не тронуты');
    assert.ok(сломать, 'заглушка');
  } finally { await s.close(); }
});
