/**
 * Выбор эмодзи. Данные локальные — без CDN, иначе пикер не заработает
 * в офлайн-сборке под Android.
 */

import { h, clear, replace} from './dom.js';

const RECENT_KEY = 'newday.emoji.recent';
let cache = null;

async function loadData() {
  if (cache) return cache;
  const res = await fetch('/js/emoji-data.json');
  cache = await res.json();
  return cache;
}

function recent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function remember(emoji) {
  const list = [emoji, ...recent().filter(e => e !== emoji)].slice(0, 16);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

/**
 * Рисует пикер внутрь контейнера.
 * @param onPick (emoji) => void
 */
export async function renderEmojiPicker(root, onPick) {
  const data = await loadData();

  const grid = h('div.emoji-grid');
  const search = h('input.input', {
    type: 'search', placeholder: 'Поиск: вода, зал, книга…',
    'aria-label': 'Поиск эмодзи',
    oninput: e => draw(e.target.value.trim().toLowerCase()),
  });

  function cell(e) {
    return h('button.emoji-cell', {
      type: 'button', text: e, title: e, 'aria-label': `Выбрать ${e}`,
      onclick: () => { remember(e); onPick(e); },
    });
  }

  function draw(query) {
    clear(grid);
    if (query) {
      const hits = [];
      for (const cat of data) {
        for (const it of cat.items) {
          if (it.k.includes(query) || it.e === query) hits.push(it.e);
        }
      }
      if (!hits.length) {
        grid.append(h('p.empty', { text: 'Ничего не нашлось. Попробуйте другое слово.' }));
        return;
      }
      grid.append(h('div.emoji-row', ...hits.map(cell)));
      return;
    }

    const rec = recent();
    if (rec.length) {
      grid.append(
        h('div.eyebrow', { text: 'недавние' }),
        h('div.emoji-row', ...rec.map(cell)));
    }
    for (const cat of data) {
      grid.append(
        h('div.eyebrow', { text: cat.name.toLowerCase() }),
        h('div.emoji-row', ...cat.items.map(it => cell(it.e))));
    }
  }

  draw('');
  replace(root, h('div.stack', search, grid));
  /*
   * Поиск не в фокусе нарочно. На телефоне фокус тут же поднимал клавиатуру
   * поверх сетки: человек пришёл полистать значки, как в телеграмных
   * смайликах, а его встречала клавиатура на полэкрана. Нужен поиск —
   * нажмёт на поле сам.
   */
}

/** Кнопка с текущим эмодзи, открывающая пикер. */
export function emojiButton(current, onPick) {
  const btn = h('button.emoji-btn', {
    type: 'button', 'aria-label': 'Выбрать эмодзи',
    text: current || '🙂',
  });
  btn.addEventListener('click', async () => {
    const { openSheet } = await import('./components/sheet.js');
    openSheet('Выберите эмодзи', async (body, { close }) => {
      await renderEmojiPicker(body, e => {
        btn.textContent = e;
        onPick(e);
        close();
      });
    });
  });
  return btn;
}
