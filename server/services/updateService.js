/**
 * Какая версия Android-приложения считается последней.
 *
 * Порядок источников — от самого надёжного к запасному:
 *  1. файл, выложенный на этот сайт (обычный случай: CI выкладывает APK
 *     сразу после сборки, приложение обновляется со своего же сервера);
 *  2. UPDATE_APK_URL в окружении — если APK раздаётся откуда-то ещё;
 *  3. релизы GitHub — альтернатива для тех, кто раздаёт через них.
 *
 * Приложение спрашивает у своего сервера, а не у GitHub напрямую: своему
 * серверу оно уже доверяет, а репозиторий может быть закрыт или его может
 * не быть вовсе.
 */

const CACHE_MS = 60 * 60 * 1000;

/** v1.2.3 или 1.2.3 → { versionName: '1.2.3', versionCode: 10203 } */
function parseTag(tag) {
  const name = String(tag || '').replace(/^v/, '').trim();
  const m = name.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const [major, minor, patch] = m.slice(1).map(Number);
  return { versionName: name, versionCode: major * 10000 + minor * 100 + patch };
}

function updateService(config, { store, fetchImpl, now = () => Date.now() } = {}) {
  const cfg = config.update || {};
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let cache = null;          // { at, value } — только для GitHub

  function fromStore() {
    const cur = store?.current?.();
    if (!cur) return null;
    return {
      versionName: cur.versionName,
      versionCode: cur.versionCode,
      apkUrl: '/api/v1/app/download',
      sizeBytes: cur.sizeBytes,
      sha256: cur.sha256,
      notes: cur.notes || '',
      publishedAt: cur.publishedAt,
      source: 'site',
    };
  }

  function fromEnv() {
    if (!cfg.apkUrl || !cfg.versionName) return null;
    const parsed = parseTag(cfg.versionName);
    return {
      versionName: cfg.versionName,
      versionCode: cfg.versionCode || parsed?.versionCode || 0,
      apkUrl: cfg.apkUrl,
      notes: cfg.notes || '',
      source: 'env',
    };
  }

  async function fromGithub() {
    const res = await doFetch(`https://api.github.com/repos/${cfg.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NewDay' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const body = await res.json();
    const parsed = parseTag(body.tag_name);
    if (!parsed) throw new Error(`не разобрал тег: ${body.tag_name}`);
    const asset = (body.assets || []).find(a => a.name.endsWith('.apk'));
    if (!asset) throw new Error('в релизе нет apk');
    return {
      ...parsed,
      apkUrl: asset.browser_download_url,
      sizeBytes: asset.size || 0,
      notes: (body.body || '').trim(),
      publishedAt: body.published_at || null,
      source: 'github',
    };
  }

  /**
   * Последняя версия или null, если узнать не удалось.
   *
   * Ошибку наружу не бросаем и старое значение не выкидываем: недоступный
   * GitHub — не повод показать человеку ошибку на экране дня.
   */
  async function latest() {
    if (!cfg.enabled) return null;

    const local = fromStore() || fromEnv();
    if (local) return local;
    if (!cfg.repo) return null;

    if (cache && now() - cache.at < CACHE_MS) return cache.value;
    try {
      const value = await fromGithub();
      cache = { at: now(), value };
      return value;
    } catch (e) {
      console.warn('[newday] не удалось узнать версию приложения:', e.message);
      return cache ? cache.value : null;
    }
  }

  return { latest, parseTag };
}

module.exports = { updateService, parseTag };
