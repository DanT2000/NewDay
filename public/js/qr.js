/** Отрисовка QR-кода в SVG: масштабируется без размытия и печатается чётко. */

import qrcode from './vendor/qrcode.js';
import { svg } from './dom.js';

/**
 * @param text   что закодировать
 * @param size   сторона в пикселях
 * @param margin поля в модулях (стандарт требует 4, иначе камеры хуже читают)
 */
export function qrSvg(text, { size = 200, margin = 4 } = {}) {
  const q = qrcode(0, 'M');            // версия подбирается автоматически
  q.addData(text);
  q.make();

  const n = q.getModuleCount();
  const total = n + margin * 2;
  const path = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) path.push(`M${c + margin},${r + margin}h1v1h-1z`);
    }
  }

  return svg('svg', {
    width: size, height: size, viewBox: `0 0 ${total} ${total}`,
    role: 'img', 'aria-label': 'QR-код для входа',
    style: 'background:#fff;border-radius:8px',
  },
    svg('path', { d: path.join(''), fill: '#000', 'shape-rendering': 'crispEdges' }));
}
