/**
 * Модалка. На узком экране те же стили превращают её в нижний лист —
 * это делает CSS, а не отдельный компонент.
 *
 * Модалки складываются стопкой, а не заменяют друг друга. Раньше здесь
 * лежала одна текущая, и `openSheet` начинался с `closeSheet()`: пикер
 * эмодзи, открытый из формы привычки, уносил саму форму — человек выбирал
 * смайлик и оказывался с пустым экраном. Закрывается всегда верхняя.
 */

import { h } from '../dom.js';

const stack = [];

/** Закрывает верхнюю модалку. */
export function closeSheet() {
  const top = stack.pop();
  top?.overlay.remove();
  if (!stack.length) document.removeEventListener('keydown', onKey);
  // фокус возвращается туда, откуда открыли: иначе с клавиатуры некуда идти
  top?.opener?.focus?.();
}

/** Закрывает всё — например, когда уходим со страницы. */
export function closeAllSheets() {
  while (stack.length) closeSheet();
}

function onKey(e) {
  if (e.key === 'Escape') closeSheet();
}

/**
 * @param title  заголовок
 * @param build  (body, { close }) => void — наполняет содержимое
 * @param footer (close) => Node[]         — кнопки внизу, необязательно
 */
export function openSheet(title, build, footer = null) {
  const opener = document.activeElement;
  const body = h('div.modal-bd');

  // close закрывает именно эту модалку, даже если поверх успели открыть другую
  const close = () => {
    const at = stack.findIndex(s => s.overlay === overlay);
    if (at === -1) return;
    while (stack.length > at) closeSheet();
  };

  const modal = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-hd',
      h('span.title', { text: title }),
      h('button.icon-btn', { text: '×', 'aria-label': 'Закрыть', onclick: close })),
    body);

  build(body, { close });
  if (footer) modal.append(h('div.modal-ft', ...footer(close)));

  const overlay = h('div.overlay', {
    onclick: e => { if (e.target === overlay) close(); },
  }, modal);
  // Каждая следующая выше предыдущей. Начинаем с 90 — как в CSS, чтобы
  // всплывашки (z-index 100) оставались видны поверх любой модалки.
  overlay.style.zIndex = String(90 + stack.length * 2);

  document.body.append(overlay);
  if (!stack.length) document.addEventListener('keydown', onKey);
  stack.push({ overlay, opener });

  // фокус на первый интерактивный элемент, чтобы клавиатура работала сразу
  modal.querySelector('input, button, select, textarea')?.focus();
  return { close, body };
}

/** Подтверждение опасного действия. Возвращает Promise<boolean>. */
export function confirmSheet(title, message, { danger = true, okText = 'Удалить' } = {}) {
  return new Promise(resolve => {
    let decided = false;
    const sheet = openSheet(title,
      body => body.append(h('p.small', { text: message })),
      close => [
        h('button.btn', { text: 'Отмена', onclick: () => { decided = true; close(); resolve(false); } }),
        h('button.btn', {
          class: danger ? 'btn-danger' : 'btn-primary', text: okText,
          onclick: () => { decided = true; close(); resolve(true); },
        }),
      ]);

    // Закрыли крестиком, Escape или щелчком по фону — это «нет».
    // Следим за исчезновением своей модалки, а не любой: поверх может
    // висеть другая, и раньше это давало ложное «нет».
    const observer = new MutationObserver(() => {
      if (!sheet.body.isConnected && !decided) {
        decided = true;
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
