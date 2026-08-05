/**
 * Экран «Заметки».
 *
 * Пока заметка живёт как поле дня — одна на дату. В макете это отдельная
 * сущность, у которой даты может не быть вовсе; фильтры «Все / На этот день /
 * Без даты» появятся вместе с ней. Показывать фильтр, у которого заведомо
 * пустой результат, — обман, поэтому здесь его нет.
 *
 * Что уже работает: список написанного, правка в шторке, переход в день.
 */

import './theme.js';
import { h, add, replace, $ } from './dom.js';
import { bottomNav, topBar, iconButton, themeButton, screen, emptyState } from './shell.js';
import { icon } from './vendor/icons.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { openSheet } from './components/sheet.js';
import { formatLong, todayFor } from './dates.js';

const els = {};
let notes = [];
let user = null;

function build() {
  // На компьютере карточки встают сеткой по три, на телефоне — столбцом:
  // список заметок в одну колонку шириной с монитор нечитаем
  els.list = h('div.sect.notes-grid');
  replace($('#app'),
    screen(
      topBar('Заметки',
        iconButton('plus', {
          title: 'Новая заметка', accent: true, size: '19px',
          onclick: () => openNote(null),
        }),
        themeButton()),
      els.list),
    bottomNav('notes'));
}

function render() {
  if (!notes.length) {
    replace(els.list, emptyState('note',
      'Заметок пока нет. Первая пригодится для того, что не влезает в задачу.',
      h('button.btn.btn-primary', { text: 'Написать заметку', onclick: () => openNote(null) })));
    return;
  }

  replace(els.list, ...notes.map(n => {
    const card = h('button.notecard', {
      type: 'button',
      onclick: () => openNote(n),
      'aria-label': `Заметка за ${formatLong(n.date)}`,
    });
    add(card,
      h('div.notecard-hd',
        h('span.eyebrow', { text: formatLong(n.date) }),
        icon('caret-right', { size: '15px' })),
      // Три строки достаточно, чтобы узнать заметку; целиком — в шторке
      h('p.notecard-text', { text: n.text }));
    return card;
  }),
  // Пунктирная карточка в конце: на широком экране «плюс» в шапке далеко,
  // а место для новой заметки видно там же, где лежат старые
  h('button.notecard.is-new', {
    type: 'button', onclick: () => openNote(null),
  }, icon('plus', { size: '17px' }), h('span', { text: 'Новая заметка' })));
}

/** Шторка заметки. Без даты заметок пока не бывает — по умолчанию сегодня. */
function openNote(note) {
  const date = note?.date || todayFor(user?.timezone);
  let text = note?.text ?? '';

  openSheet(note ? formatLong(date) : 'Новая заметка', (body, { close }) => {
    const area = h('textarea.input', {
      value: text, placeholder: 'О чём не хочется забыть', rows: 8,
      'aria-label': 'Текст заметки',
      oninput: e => { text = e.target.value; },
    });

    add(body, h('div.stack',
      h('span.eyebrow', { text: `заметка дня · ${formatLong(date)}` }),
      area,
      h('button.btn-sheet', {
        text: 'Сохранить',
        onclick: async () => {
          try {
            await api.patchDay(date, { notes: text.trim() });
            close();
            toast(text.trim() ? 'Сохранено' : 'Заметка удалена');
            await load();
          } catch (e) { toast(e.message, 'error'); }
        },
      }),
      h('a.btn.btn-ghost.btn-block', { href: `/app.html#${date}`, text: 'Открыть этот день' })));
    area.focus();
  });
}

async function load() {
  try {
    notes = await api.GET('/notes');
    render();
  } catch (e) { toast(e.message, 'error'); }
}

async function boot() {
  build();
  try { user = await api.me(); } catch { return; }   // api.js уже увёл на вход
  await load();
}

boot();

if (location.search.includes('diag=1')) import('./dev-overflow.js');
