/**
 * Имя устройства из User-Agent.
 *
 * Приложение может прислать пустое имя или голое «Android» — тогда имя
 * достаётся из скобок User-Agent («; <модель> Build/…»). Осмысленное имя,
 * которое человек дал сам, из-под него не выдёргивается.
 */

const test = require('node:test');
const assert = require('node:assert');
const { deviceNameFrom, modelFromUserAgent } = require('../../server/lib/deviceName');

const WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231005.007; wv) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

test('модель достаётся из скобок после Android', () => {
  assert.strictEqual(modelFromUserAgent(WEBVIEW_UA), 'Pixel 7');
  // Dalvik — так ходит нативный HTTP-клиент Android, скобки те же
  assert.strictEqual(
    modelFromUserAgent('Dalvik/2.1.0 (Linux; U; Android 13; SM-A536E Build/TP1A.220624.014)'),
    'SM-A536E');
  // Без «Build/» модель заканчивается закрывающей скобкой
  assert.strictEqual(
    modelFromUserAgent('Mozilla/5.0 (Linux; Android 9; SAMSUNG SM-G975F)'),
    'SAMSUNG SM-G975F');
});

test('обезличенный и чужой User-Agent модели не дают', () => {
  // «K» — заглушка урезанного User-Agent Chrome, называть так устройство нельзя
  assert.strictEqual(modelFromUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'), '');
  assert.strictEqual(modelFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), '');
  assert.strictEqual(modelFromUserAgent(''), '');
  assert.strictEqual(modelFromUserAgent(undefined), '');
});

test('пустое имя и «Android» заменяются моделью, своё имя — нет', () => {
  assert.strictEqual(deviceNameFrom('', WEBVIEW_UA), 'Pixel 7');
  assert.strictEqual(deviceNameFrom('Android', WEBVIEW_UA), 'Pixel 7');
  assert.strictEqual(deviceNameFrom('android', WEBVIEW_UA), 'Pixel 7');
  // Человек назвал устройство сам — User-Agent его не переубедит
  assert.strictEqual(deviceNameFrom('Мой телефон', WEBVIEW_UA), 'Мой телефон');
  // Заменить нечем — остаётся что было: «Android» лучше пустоты
  assert.strictEqual(deviceNameFrom('Android', 'Mozilla/5.0 (Linux; Android 10; K)'), 'Android');
  assert.strictEqual(deviceNameFrom('', undefined), '');
});
