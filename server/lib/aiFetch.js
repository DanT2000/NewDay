/**
 * fetch для клиента ИИ с перебором прокси.
 *
 * Некоторые провайдеры недоступны напрямую из некоторых сетей, поэтому
 * владелец задаёт список прокси (таблица ai_proxies), и запросы идут через
 * первый живой по position. Сетевой сбой помечает прокси нерабочим на
 * десять минут — в памяти, не в базе: сбой сети — состояние момента, а не
 * настройка, и после перезапуска сервера стоит попробовать снова.
 * Кончились прокси — идём напрямую: без помощника хуже, чем без прокси.
 *
 * Ходим через https-proxy-agent (он уже в node_modules у web-push):
 * пакета undici с его ProxyAgent в проекте нет, а тянуть новую зависимость
 * ради туннеля не хочется. CONNECT-туннель покрывает http- и https-прокси;
 * для socks5 — socks-proxy-agent, соседний пакет того же автора с тем же
 * интерфейсом агента, так что перебор прокси одинаков для всех типов.
 *
 * Когда прокси не заданы, работает переданный fetchImpl или глобальный
 * fetch — ровно как раньше, тесты с поддельным провайдером ничего не
 * замечают.
 */

const http = require('node:http');
const https = require('node:https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { aiProxiesRepo } = require('../repos/aiProxies');

/** Через сколько снова пробовать прокси, который не ответил. */
const RETRY_MS = 10 * 60 * 1000;

function createAiFetch(db, { fetchImpl, now = () => Date.now() } = {}) {
  const repo = aiProxiesRepo(db);
  const plain = fetchImpl || ((...a) => fetch(...a));
  const failedUntil = new Map();   // id прокси → до какого времени он считается сбойным

  async function aiFetch(url, init = {}) {
    const candidates = repo.alive().filter(p => (failedUntil.get(p.id) ?? 0) <= now());

    for (const p of candidates) {
      try {
        return await viaProxy(p, url, init);
      } catch (e) {
        // Общий срок запроса вышел — перебирать остальных бессмысленно,
        // человек уже получил таймаут
        if (init.signal?.aborted) throw e;
        failedUntil.set(p.id, now() + RETRY_MS);
      }
    }
    return plain(url, init);
  }

  return aiFetch;
}

/**
 * Запрос через CONNECT-туннель силами node:http(s), потому что глобальному
 * fetch агента не подсунуть. Тело сериализуем через Request: он сам
 * превращает FormData в multipart с границей — повторять это руками
 * значило бы однажды разойтись с тем, что шлёт настоящий fetch.
 */
async function viaProxy(p, url, init) {
  const request = new Request(url, { ...init, ...(init.body ? { duplex: 'half' } : {}) });
  const body = ['GET', 'HEAD'].includes(request.method) ? null : Buffer.from(await request.arrayBuffer());

  const headers = {};
  request.headers.forEach((value, name) => { headers[name] = value; });
  if (body) headers['content-length'] = String(body.length);

  const cred = p.login
    ? `${encodeURIComponent(p.login)}:${encodeURIComponent(p.password || '')}@`
    : '';
  // socks5h, а не socks5: имена должны резолвиться на прокси. Локальный DNS
  // может не знать провайдера вовсе — сети, где нужен SOCKS, обычно такие.
  const agent = p.type === 'socks5'
    ? new SocksProxyAgent(`socks5h://${cred}${p.host}:${p.port}`)
    : new HttpsProxyAgent(`${p.type}://${cred}${p.host}:${p.port}`);

  const target = new URL(url);
  const lib = target.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method: request.method, headers, agent }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode || 502;
        const plainHeaders = Object.fromEntries(
          Object.entries(res.headers).filter(([, v]) => typeof v === 'string'),
        );
        // У 204/205/304 тела не бывает — Response с телом на них бросается
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
          { status, headers: plainHeaders }));
      });
    });

    // Таймаут снаружи (AbortSignal.timeout в aiService) должен рвать и
    // туннель, и наружу уйти той же ошибкой TimeoutError
    const onAbort = () => req.destroy(init.signal?.reason ?? new Error('aborted'));
    init.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', err => {
      init.signal?.removeEventListener('abort', onAbort);
      reject(init.signal?.aborted ? (init.signal.reason ?? err) : err);
    });
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort));

    if (body) req.write(body);
    req.end();
  });
}

module.exports = { createAiFetch, RETRY_MS };
