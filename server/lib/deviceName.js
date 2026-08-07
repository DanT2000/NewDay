/**
 * Имя устройства для списка «Устройства».
 *
 * Android-приложение может прислать пустое имя или голое «Android» —
 * в списке из трёх таких строк не понять, которая из них чужая, а отзывать
 * токены вслепую страшно. User-Agent WebView при этом обычно знает модель:
 * в скобках после версии Android стоит «; <модель> Build/…». Берём её,
 * когда присланное имя ничего не говорит; осмысленное имя не трогаем —
 * человек назвал устройство сам.
 */

function deviceNameFrom(name, userAgent) {
  const given = String(name || '').trim();
  if (given && !/^android$/i.test(given)) return given;
  return modelFromUserAgent(userAgent) || given;
}

/** Модель из скобок User-Agent: «(Linux; Android 14; Pixel 7 Build/…)» → «Pixel 7». */
function modelFromUserAgent(ua) {
  const m = /Android\s[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(String(ua || ''));
  if (!m) return '';
  const model = m[1].trim();
  // «K» — обезличенная модель урезанного User-Agent Chrome, это не имя
  if (model === 'K') return '';
  // В колонку имени влезает 80 символов (см. валидацию deviceName в роутах)
  return model.slice(0, 80).trim();
}

module.exports = { deviceNameFrom, modelFromUserAgent };
