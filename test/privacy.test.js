const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers/server');

/**
 * Политика конфиденциальности — не украшение, а обязательное условие.
 *
 * Адрес https://newday.appswire.ru/privacy вписан в карточки Google Play и
 * RuStore, и Play проверяет ссылку сам: если она перестанет открываться,
 * приложение снимут с публикации. Поэтому у неё есть тест — как у любого
 * обещания, которое дано наружу.
 *
 * Заодно проверяется, что на странице остались утверждения, на которых
 * построена форма о данных: «нет трекеров» и срок хранения. Убрать их из
 * текста, не заметив, — значит разойтись с тем, что заявлено магазину.
 */
test('политика конфиденциальности', async t => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  await t.test('открывается по адресу из карточки магазина', async () => {
    const r = await fetch(`${srv.url}/privacy`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
  });

  await t.test('открывается и с расширением — ссылки со стороны не ломаются', async () => {
    const r = await fetch(`${srv.url}/privacy.html`);
    assert.equal(r.status, 200);
  });

  await t.test('содержит то, на чём построена форма о данных', async () => {
    const html = await (await fetch(`${srv.url}/privacy`)).text();
    // Якорь #delete — на него ссылается поле «удаление аккаунта» в Play
    assert.ok(html.includes('id="delete"'), 'пропал якорь #delete');
    assert.ok(html.includes('трекеров'), 'пропало утверждение об отсутствии трекеров');
    assert.ok(html.includes('60 дней'), 'пропал срок хранения данных');
    assert.ok(html.includes('support@appswire.ru'), 'пропал адрес для обращений');
  });
});
