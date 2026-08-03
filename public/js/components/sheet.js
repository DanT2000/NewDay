/**
 * Модалка. На узком экране те же стили превращают её в нижний лист —
 * это делает CSS, а не отдельный компонент.
 */

import { h } from '../dom.js';

let current = null;

export function closeSheet() {
  current?.remove();
  current = null;
  document.removeEventListener('keydown', onKey);
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
  closeSheet();

  const body = h('div.modal-bd');
  const modal = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-hd',
      h('span.title', { text: title }),
      h('button.icon-btn', { text: '×', 'aria-label': 'Закрыть', onclick: closeSheet })),
    body);

  build(body, { close: closeSheet });
  if (footer) modal.append(h('div.modal-ft', ...footer(closeSheet)));

  const overlay = h('div.overlay', {
    onclick: e => { if (e.target === overlay) closeSheet(); },
  }, modal);

  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  current = overlay;

  // фокус на первый интерактивный элемент, чтобы клавиатура работала сразу
  modal.querySelector('input, button, select, textarea')?.focus();
  return { close: closeSheet, body };
}

/** Подтверждение опасного действия. Возвращает Promise<boolean>. */
export function confirmSheet(title, message, { danger = true, okText = 'Удалить' } = {}) {
  return new Promise(resolve => {
    let decided = false;
    openSheet(title,
      body => body.append(h('p.small', { text: message })),
      close => [
        h('button.btn', { text: 'Отмена', onclick: () => { decided = true; close(); resolve(false); } }),
        h('button.btn', {
          class: danger ? 'btn-danger' : 'btn-primary', text: okText,
          onclick: () => { decided = true; close(); resolve(true); },
        }),
      ]);
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.overlay') && !decided) { observer.disconnect(); resolve(false); }
    });
    observer.observe(document.body, { childList: true });
  });
}
