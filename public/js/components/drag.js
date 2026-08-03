/**
 * Перетаскивание строк. Pointer Events — одинаково работает мышью и пальцем,
 * без библиотек. Тянуть можно только за ручку [.sdrag]; на телефоне ручка
 * скрыта, там порядок меняется через контекстное меню.
 */

export function attachDrag(container, rowSelector, onReorder) {
  let dragging = null;
  let placeholderAfter = null;

  container.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.sdrag, .drag-handle');
    if (!handle) return;
    const row = handle.closest(rowSelector);
    if (!row) return;

    e.preventDefault();
    dragging = row;
    row.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);

    const move = ev => {
      const rows = [...container.querySelectorAll(rowSelector)].filter(r => r !== dragging);
      let target = null;
      for (const r of rows) {
        const box = r.getBoundingClientRect();
        if (ev.clientY > box.top + box.height / 2) target = r;
      }
      if (target !== placeholderAfter) {
        container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        placeholderAfter = target;
        (target?.nextElementSibling ?? rows[0])?.classList.add('drop-target');
      }
    };

    const up = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);

      container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      dragging.classList.remove('dragging');

      if (placeholderAfter) placeholderAfter.after(dragging);
      else container.prepend(dragging);

      const ids = [...container.querySelectorAll(rowSelector)].map(r => r.dataset.id);
      dragging = null;
      placeholderAfter = null;
      onReorder(ids);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}
