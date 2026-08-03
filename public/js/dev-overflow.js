/**
 * Проверка вёрстки: `?diag=1`.
 *
 * Ловит два класса ошибок, которые глазами на скриншоте не всегда видно,
 * а на дисплее с системным масштабированием скриншот вообще врёт по геометрии:
 *
 *  1. переполнение — элемент вылез за пределы окна;
 *  2. обрезка — содержимое не влезло в собственную ширину
 *     (например, «23:0» вместо «23:00» в поле времени).
 *
 * Результат кладётся в document.title, чтобы его снимал headless-браузер
 * через --dump-dom.
 */

/** Осознанные горизонтальные скроллеры, которым обрезка штатна. */
const SCROLLERS = ['.datestrip-scroll', '.emoji-grid', 'pre', 'textarea'];

function describe(el) {
  const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '';
  return el.tagName.toLowerCase() + cls;
}

export function reportLayout() {
  const vw = document.documentElement.clientWidth;
  const overflow = [];
  const clipped = [];

  for (const el of document.querySelectorAll('body *')) {
    if (el.classList.contains('sr-only')) continue;
    if (SCROLLERS.some(sel => el.matches(sel) || el.closest(sel))) continue;

    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // декоративные полоски и точки уже 2-4px шириной: их псевдоэлементы
    // выступают намеренно, обрезкой это считать нельзя
    if (r.width < 8) continue;

    if (r.right > vw + 1 || r.left < -1) {
      overflow.push(`${describe(el)}@${Math.round(r.left)}..${Math.round(r.right)}`);
    }

    /*
     * Для поля свободного текста обрезка — нормальное поведение: длинное
     * название прокручивается внутри input. Ошибкой это становится только
     * там, где значение фиксированного формата и обязано быть видно целиком:
     * время, числа, счётчики.
     */
    const isFixedField = el.matches('.time-field, .stime, .num, input.mono, select');
    const isFreeText = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !isFixedField;
    if (isFreeText) continue;
    const slack = isFixedField ? 1 : 2;
    if (el.scrollWidth > el.clientWidth + slack && getComputedStyle(el).overflowX !== 'auto') {
      clipped.push(`${describe(el)} sw=${el.scrollWidth} cw=${el.clientWidth}`
        + (isFixedField ? ` value="${el.value ?? ''}"` : ''));
    }
  }

  const pageScrolls = document.body.scrollWidth > vw + 1;
  const ok = overflow.length === 0 && clipped.length === 0 && !pageScrolls;

  document.title = `VW=${vw} ${ok ? 'OK' : 'FAIL'}`
    + (pageScrolls ? ` scrollWidth=${document.body.scrollWidth}` : '')
    + (overflow.length ? ` :: ПЕРЕПОЛНЕНИЕ ${overflow.slice(0, 6).join(' ;; ')}` : '')
    + (clipped.length ? ` :: ОБРЕЗКА ${clipped.slice(0, 8).join(' ;; ')}` : '');

  return { vw, overflow, clipped, pageScrolls, ok };
}

if (location.search.includes('diag=1')) {
  setTimeout(() => {
    try {
      reportLayout();
    } catch (e) {
      // Молчаливое падение проверки опаснее самого дефекта: «всё чисто»
      // тогда означает лишь то, что проверка не доработала
      document.title = 'ПРОВЕРКА УПАЛА: ' + e.message;
    }
  }, 2200);
}
