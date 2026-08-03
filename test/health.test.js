const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers/server');

test('GET /api/health отдаёт ok и версию схемы', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.url}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.dbWritable, true);
    assert.strictEqual(typeof body.schemaVersion, 'number');
    assert.ok(body.schemaVersion >= 1);
  } finally {
    await srv.close();
  }
});
