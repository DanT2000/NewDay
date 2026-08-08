/**
 * Выбор сервера на входе и при регистрации.
 *
 *   node tools/auth-server-check.mjs [--base http://127.0.0.1:4010]
 *
 * Проверять это глазами нельзя: переключатель показывается только внутри
 * приложения (`Capacitor.isNativePlatform()`), а в браузере его нет вовсе —
 * поэтому ни одна прежняя проверка сюда не заглядывала, и в коде спокойно жила
 * ловушка: адрес из скрытого поля всё равно уходил в запрос.
 *
 * Здесь приложение изображается заранее: в страницу до её кода подставляется
 * `window.Capacitor` с `isNativePlatform() → true`. Дальше проверяется то, что
 * видит человек, и то, куда реально уходит запрос.
 */
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import tmp from './lib/tmp.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://127.0.0.1:4010');
const PORT = 9417;
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const EDGE = BROWSERS.find(b => { try { fsSync.accessSync(b); return true; } catch { return false; } });
if (!EDGE) { console.error('Не нашёл ни Edge, ни Chrome'); process.exit(1); }

const profile = tmp.tempDir('auth-server');
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=390,844', '--hide-scrollbars',
  '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let ws;
const rpc = (method, params) => new Promise(resolve => {
  const id = ++rpc.n;
  const on = e => {
    const m = JSON.parse(e.data);
    if (m.id === id) { ws.removeEventListener('message', on); resolve(m.result ?? m); }
  };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
rpc.n = 0;
const js = async (expr, awaitPromise = false) => {
  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return `ИСКЛЮЧЕНИЕ: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
  return r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Видно ли элемент человеку.
 *
 * Смотреть на свойство `hidden` нельзя: оно стояло, а поле оставалось на виду —
 * авторское `display: grid` перебивало браузерное правило `[hidden]`. Проверять
 * надо то же, что видит глаз: занимает ли элемент место на странице.
 */
const видно = selector => js(`(() => {
  const n = document.querySelector(${JSON.stringify(selector)});
  if (!n) return false;
  const r = n.getBoundingClientRect();
  return Boolean(n.offsetParent) && r.height > 0 && r.width > 0;
})()`);

let всего = 0; let сошлось = 0;
const проба = (имя, ок, деталь = '') => {
  всего += 1; if (ок) сошлось += 1;
  console.log(`  ${ок ? '\u2714' : '\u2716'} ${имя}${деталь ? ` — ${деталь}` : ''}`);
};

/** Открыть страницу «как в приложении» и с заданным сохранённым адресом. */
async function открыть(страница, сохранённый = null) {
  await rpc('Page.navigate', { url: `${BASE}/${страница}` });
  await wait(600);
  await js(`localStorage.clear(); ${сохранённыйКод(сохранённый)} 'ok'`);
  await rpc('Page.reload', { ignoreCache: true });
  await wait(1400);
}
const сохранённыйКод = адрес =>
  (адрес ? `localStorage.setItem('newday.apiBase', ${JSON.stringify(адрес)});` : '');

try {
  let list;
  for (let i = 0; i < 60; i += 1) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; }
    catch { await wait(250); }
  }
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.addEventListener('open', r, { once: true }); });
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  /*
   * Изображаем приложение и перехватываем запросы входа.
   *
   * Подставляется до кода страницы, поэтому её скрипты видят Capacitor с самого
   * начала. Заодно подменяется fetch: нам нужен адрес, по которому ушёл бы
   * запрос, а не настоящий вход.
   */
  await rpc('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.Capacitor = { isNativePlatform: () => true };
      window.__ушло = [];
      const настоящий = window.fetch;
      window.fetch = (u, o) => {
        window.__ушло.push(String(u));
        if (String(u).includes('/auth/login') || String(u).includes('/auth/register')) {
          return Promise.resolve(new Response('{"error":{"message":"проба"}}',
            { status: 400, headers: { 'Content-Type': 'application/json' } }));
        }
        return настоящий(u, o);
      };`,
  });

  for (const [страница, кнопка] of [['login.html', 'Войти'], ['register.html', 'Зарегистрироваться']]) {
    console.log(`\n── ${страница} ──`);
    await открыть(страница);

    проба('переключатель серверов виден',
      await js(`Boolean(document.querySelector('.srv-pick'))`));
    проба('наш сервер назван по имени, без адреса',
      (await js(`document.querySelector('.srv-opt b')?.textContent`)) === 'NewDay',
      await js(`document.querySelector('.srv-opt b')?.textContent ?? 'нет'`));
    проба('по умолчанию выбран NewDay',
      (await js(`document.querySelectorAll('.srv-opt')[0]?.getAttribute('aria-pressed')`)) === 'true');
    проба('поля для адреса не видно', (await видно('#server-group')) === false);

    // ── выбираем свой сервер ──
    await js(`document.querySelectorAll('.srv-opt')[1].click()`);
    await wait(300);
    проба('после выбора «Свой сервер» поле появилось',
      (await видно('#server-group')) === true);
    проба('поле пустое, а не с нашим адресом внутри',
      (await js(`document.getElementById('server').value`)) === '',
      `в поле «${await js(`document.getElementById('server').value`)}»`);
    проба('поле стало обязательным',
      (await js(`document.getElementById('server').required`)) === true);

    // ── возврат к нашему ──
    await js(`document.getElementById('server').value = 'https://other.example';
      document.querySelectorAll('.srv-opt')[0].click()`);
    await wait(300);
    проба('возврат к NewDay прячет поле', (await видно('#server-group')) === false);
    проба('и чистит введённый чужой адрес',
      (await js(`document.getElementById('server').value`)) === '',
      `в поле «${await js(`document.getElementById('server').value`)}»`);

    /*
     * Главное: куда уходит запрос. Раньше адрес брался из поля — свернул выбор
     * обратно, а вход всё равно шёл на чужой сервер.
     */
    /*
     * Заполняем все поля формы: на регистрации есть ещё и подтверждение пароля,
     * и при расхождении обработчик выходит до запроса — проба тогда молча
     * «не видит запроса» и обвиняет не то.
     */
    await js(`document.getElementById('server').value = 'https://other.example';
      document.getElementById('username').value = 'a@b.ru';
      document.getElementById('password').value = 'secret12';
      const подтв = document.getElementById('confirmPassword');
      if (подтв) подтв.value = 'secret12';
      window.__ушло = [];
      document.querySelector('form').requestSubmit()`);
    await wait(1200);
    const ушло = await js(`(window.__ушло || []).filter(u => /auth\\/(login|register)/.test(u)).join(' | ')`);
    проба('запрос ушёл на NewDay, а не на адрес из скрытого поля',
      typeof ушло === 'string' && ушло.includes('newday.appswire.ru') && !ушло.includes('other'),
      ушло || 'запроса не было');

    // ── уже настроенный свой сервер: поле открыто и заполнено ──
    await открыть(страница, 'https://my.example.org');
    проба('сохранённый свой адрес открывает поле сразу',
      (await видно('#server-group')) === true);
    проба('и показывает именно его',
      (await js(`document.getElementById('server').value`)) === 'https://my.example.org',
      await js(`document.getElementById('server').value`));
    проба('выбран второй вариант, а не NewDay',
      (await js(`document.querySelectorAll('.srv-opt')[1]?.getAttribute('aria-pressed')`)) === 'true');

    // ── ничего не вылезает за края на узком экране ──
    const за = await js(`(() => {
      const r = document.querySelector('.srv-pick')?.getBoundingClientRect();
      return r ? Math.round(Math.max(0, r.right - window.innerWidth) + Math.max(0, -r.left)) : -1;
    })()`);
    проба('переключатель не вылезает за края', за === 0, `${за} px за краем`);
  }

  console.log(`\n── Итог ──\n${сошлось} из ${всего}`);
} finally {
  try { ws?.close(); } catch { /* уже закрыт */ }
  proc.kill();
  await tmp.release(profile);
}
process.exit(сошлось === всего ? 0 : 1);
