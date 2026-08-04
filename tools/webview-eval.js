/**
 * Выполняет JS внутри WebView приложения через DevTools Protocol.
 *
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   node tools/webview-eval.js "выражение"
 *
 * Нужен, чтобы проверять нативный плагин так, как его вызывает
 * настоящая веб-часть, а не в обход.
 */
const expression = process.argv[2];
if (!expression) {
  console.error('Использование: node tools/webview-eval.js "<js>"');
  process.exit(1);
}

// Порт можно переопределить: тот же инструмент нужен и для обычного
// headless-браузера, а не только для WebView приложения.
const port = process.env.CDP_PORT || 9222;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('Страница WebView не найдена'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

const send = (method, params) => new Promise(resolve => {
  const msgId = ++id;
  pending.set(msgId, resolve);
  ws.send(JSON.stringify({ id: msgId, method, params }));
});

ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

await new Promise(r => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');

const res = await send('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

if (res.result?.exceptionDetails) {
  console.error('ОШИБКА:', res.result.exceptionDetails.exception?.description
    || res.result.exceptionDetails.text);
  process.exit(2);
}
console.log(JSON.stringify(res.result?.result?.value ?? res.result?.result?.description ?? null, null, 2));
ws.close();
