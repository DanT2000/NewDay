/**
 * Проверка горизонтального переполнения: `?diag=1`.
 *
 * На экранах с системным масштабированием скриншот врёт по геометрии,
 * поэтому единственный надёжный способ поймать «уехало вправо» — измерить.
 * Результат кладётся в document.title, чтобы его можно было снять
 * headless-браузером через --dump-dom.
 */

export function reportOverflow() {
  const vw = document.documentElement.clientWidth;
  const offenders = [];

  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.datestrip-scroll')) continue;   // это осознанный горизонтальный скроллер
    if (el.classList.contains('datestrip-scroll')) continue;
    if (el.classList.contains('sr-only')) continue;  // спрятано в 1px, ширина неинформативна

    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push(`${el.tagName.toLowerCase()}.${el.className || '—'}@${Math.round(r.left)}..${Math.round(r.right)}`);
    }
  }

  const body = document.body;
  const scrolls = body.scrollWidth > vw + 1;
  const verdict = offenders.length === 0 && !scrolls
    ? 'OK'
    : `FAIL scrollWidth=${body.scrollWidth}`;

  document.title = `VW=${vw} ${verdict} :: ${offenders.slice(0, 12).join(' ;; ')}`;
  return { vw, offenders, scrolls };
}

if (location.search.includes('diag=1')) {
  setTimeout(reportOverflow, 2200);
}
