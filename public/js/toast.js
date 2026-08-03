/** Короткие сообщения внизу экрана. Ошибки живут дольше обычных. */

let host = null;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = document.createElement('div');
  host.className = 'toasts';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/**
 * @param message  текст
 * @param kind     'info' | 'error'
 * @param action   { label, onClick } — например «Отменить»
 */
export function toast(message, kind = 'info', action = null) {
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' error' : ''}`;
  el.append(Object.assign(document.createElement('span'), { textContent: message }));

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'undo';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick(); el.remove(); });
    el.append(btn);
  }

  ensureHost().append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
  return el;
}
