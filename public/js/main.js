/**
 * Точка входа экрана дня.
 *
 * Один набор компонентов на десктоп и телефон: раскладку меняет CSS,
 * а не ветвление по ширине окна. Из-за такого ветвления в старом клиенте
 * половина функций существовала только на десктопе.
 */

import './theme.js';
import { h, clear, $, replace} from './dom.js';
import { formatLong, addDays } from './dates.js';
import { state, subscribe, emit, loadUser, loadDay, loadDaysIndex, today, optimistic, debounce } from './store.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { cycleTheme, getTheme, THEME_ICON, THEME_LABEL } from './theme.js';
import { renderDateStrip, attachSwipe } from './views/datestrip.js';
import { renderSchedule } from './views/schedule.js';
import { renderTimeline } from './views/schedule-timeline.js';
import { addRow } from './views/schedule-actions.js';
import { renderTasks, renderMeals, renderSport } from './views/lists.js';
import { renderProgress } from './views/progress.js';
import { renderHabitsToday } from './views/habits-today.js';
import { openPrintDialog, printHead, printLines } from './views/print.js';
import { syncAlarms, available as nativeAvailable } from './native.js';
import { mountInstallBanner } from './install-banner.js';
import * as appUpdate from './update.js';

const els = {};

// ── Каркас ───────────────────────────────────────────────────

function buildLayout() {
  const app = $('#app');

  // Полоска дней живёт в карточке дня, а не в верхней панели: всё,
  // что относится к «какой это день», должно быть в одном месте,
  // прямо над расписанием
  els.strip = h('div.daynav');
  els.header = h('header.hdr',
    h('a.hdr-brand', { href: '/app.html' },
      h('img', { src: '/icons/logo-256.png', alt: '', width: 26, height: 26 }),
      h('b', { text: 'NewDay' })),
    h('span.grow'),
    h('div.hdr-actions',
      h('button.icon-btn', {
        id: 'btn-theme', text: THEME_ICON[getTheme()],
        title: `Тема: ${THEME_LABEL[getTheme()]}`, 'aria-label': 'Переключить тему',
        onclick: e => {
          const next = cycleTheme();
          e.currentTarget.textContent = THEME_ICON[next];
          e.currentTarget.title = `Тема: ${THEME_LABEL[next]}`;
          toast(`Тема: ${THEME_LABEL[next].toLowerCase()}`);
        },
      }),
      h('button.icon-btn', { text: '🖨', title: 'Печать дня', 'aria-label': 'Печать дня', onclick: openPrintDialog }),
      h('a.icon-btn', { href: '/settings.html', text: '⚙', title: 'Настройки', 'aria-label': 'Настройки' })));

  els.schedule = h('div.card-bd');
  els.work = h('div.card-bd');
  els.home = h('div.card-bd');
  els.food = h('div.card-bd');
  els.sport = h('div.card-bd');
  els.notes = h('div.card-bd.pad');
  els.progress = h('div');
  els.habits = h('div.card-bd');
  els.schedHead = h('div.card-hd');

  // На бумагу всегда идёт список, даже если на экране включён таймлайн
  els.printSchedule = h('div.no-screen');

  /*
   * Работа, дом, питание и спорт — четыре отдельных блока друг под другом,
   * а не вкладки. Вкладки прятали три четверти дня и заставляли листать,
   * чтобы просто посмотреть, что осталось. Заодно исчезла разница между
   * экраном и бумагой: печатать больше нечего «дополнительно», всё и так
   * на месте.
   */
  const main = h('div.col',
    els.strip,
    h('section.card', { dataset: { print: 'schedule' } }, els.schedHead, els.schedule, els.printSchedule),
    h('section.card', { dataset: { print: 'tasks' } },
      h('div.card-hd', h('span.eyebrow', { text: 'работа' }), h('span.grow'), els.workCount = h('span.micro')),
      els.work),
    h('section.card', { dataset: { print: 'tasks' } },
      h('div.card-hd', h('span.eyebrow', { text: 'дом' }), h('span.grow'), els.homeCount = h('span.micro')),
      els.home),
    h('section.card', { dataset: { print: 'meals' } },
      h('div.card-hd', h('span.eyebrow', { text: 'питание' }), h('span.grow'), els.foodCount = h('span.micro')),
      els.food),
    h('section.card', { dataset: { print: 'sport' } },
      h('div.card-hd', h('span.eyebrow', { text: 'спорт' }), h('span.grow'), els.sportCount = h('span.micro')),
      els.sport));

  const side = h('div.col',
    // прогресс на бумаге не нужен: печатают план, а не итоги
    h('section.card.no-print', { dataset: { print: 'progress' } }, els.progress),
    h('section.card', { dataset: { print: 'habits' } },
      h('div.card-hd',
        h('span.eyebrow', { text: 'привычки сегодня' }),
        h('a.btn.btn-sm.btn-ghost', { href: '/habits.html', text: 'Управление' })),
      els.habits),
    h('section.card',
      h('div.card-hd', h('span.eyebrow', { text: 'заметки' })),
      els.notes, printLines()));

  els.printHead = h('div', { class: 'no-screen' });
  els.body = h('div.app-body', els.printHead, main, side);
  replace(app, els.header, els.body);
  attachSwipe(els.body, () => go(addDays(state.date, -1)), () => go(addDays(state.date, 1)));
}

// ── Заметки ──────────────────────────────────────────────────
//
// Заголовок дня и «фокус» убраны: дату и так видно в навигации, а «главное
// дело дня» — это либо задача, либо строка расписания, и отдельного поля
// для него не нужно. Осталось то, что действительно свободный текст.

const saveNotes = debounce(v => pushDayField({ notes: v }));

async function pushDayField(fields) {
  if (!state.day) return;
  try {
    const updated = await api.patchDay(state.date, fields, state.day.rev);
    state.day.rev = updated.rev;
  } catch (e) { toast(e.message, 'error'); }
}

function renderNotes() {
  const d = state.day;
  if (!d) return;
  replace(els.notes, h('textarea.input', {
    value: d.notes, placeholder: 'Заметки дня', 'aria-label': 'Заметки дня',
    oninput: e => saveNotes(e.target.value),
  }));
}

// ── Разделы дня ──────────────────────────────────────────────

function renderSections() {
  const d = state.day;
  const count = (done, all) => (all ? `${done}/${all}` : '');
  const p = d?.progress ?? {};

  renderTasks(els.work, 'work');
  renderTasks(els.home, 'home');
  renderMeals(els.food);
  renderSport(els.sport);

  els.workCount.textContent = count(p.work?.done, p.work?.possible);
  els.homeCount.textContent = count(p.home?.done, p.home?.possible);
  els.foodCount.textContent = count(p.food?.done, p.food?.possible);
  els.sportCount.textContent = count(p.sport?.done, p.sport?.possible);
}

// ── Расписание: заголовок с переключателем вида ──────────────

function renderSchedHead() {
  const view = state.user?.scheduleView === 'timeline' ? 'timeline' : 'list';
  const swap = next => {
    state.user.scheduleView = next;
    renderSchedHead();
    renderScheduleBody();
    api.saveSettings({ scheduleView: next }).catch(() => {});
  };

  replace(els.schedHead,
    h('span.eyebrow', { text: 'расписание' }),
    h('span.grow'),
    h('span.micro', {
      text: state.day?.progress?.schedule?.possible
        ? `${state.day.progress.schedule.done}/${state.day.progress.schedule.possible}`
        : '',
    }),
    h('div.tabs', { style: { marginLeft: '8px' } },
      h('button.tab', {
        text: '☰', title: 'Списком', 'aria-label': 'Показать списком',
        'aria-selected': view === 'list' ? 'true' : 'false',
        onclick: () => swap('list'),
      }),
      h('button.tab', {
        text: '▦', title: 'Таймлайном', 'aria-label': 'Показать таймлайном',
        'aria-selected': view === 'timeline' ? 'true' : 'false',
        onclick: () => swap('timeline'),
      })),
    view === 'timeline'
      ? h('button.btn.btn-sm.btn-ghost', {
          text: '+ строка', onclick: () => addRow(state.day?.schedule ?? []),
        })
      : null);
}

function renderScheduleBody() {
  if (state.user?.scheduleView === 'timeline') {
    renderTimeline(els.schedule);
    renderSchedule(els.printSchedule);
  } else {
    renderSchedule(els.schedule);
    replace(els.printSchedule);
  }
}

// ── Отрисовка ────────────────────────────────────────────────

function renderAll() {
  renderDateStrip(els.strip, go);
  if (!state.day) return;
  renderNotes();
  replace(els.printHead, printHead());
  renderSchedHead();
  renderScheduleBody();
  renderSections();
  renderProgress(els.progress);
  renderHabitsToday(els.habits);
  scheduleNativeSync();
}

// ── Навигация ────────────────────────────────────────────────

/**
 * Будильники живут на устройстве, поэтому после каждой правки расписания
 * список надо переотдать в систему. Делаем это не мешая интерфейсу.
 */
let syncTimer = null;
function scheduleNativeSync() {
  if (!nativeAvailable()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncAlarms(state.user).catch(() => {});
  }, 1200);
}

async function go(date) {
  location.hash = date === today() ? '' : `#${date}`;
  await loadDay(date);
  loadDaysIndex(addDays(date, -7), addDays(date, 7));
}

// Минутный тик двигает маркер «сейчас» без перезагрузки данных
function startClock() {
  const tick = () => { if (state.date === today() && state.day) renderScheduleBody(); };
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => { tick(); setInterval(tick, 60000); }, msToNextMinute);
}

async function boot() {
  buildLayout();
  subscribe(renderAll);
  try {
    await loadUser();
  } catch {
    return; // api.js уже увёл на страницу входа
  }
  const fromHash = location.hash.slice(1);
  await go(/^\d{4}-\d{2}-\d{2}$/.test(fromHash) ? fromHash : today());
  startClock();
  mountInstallBanner();
  // Проверка обновления — после того, как день отрисован: вопрос об обновлении
  // не должен задерживать показ расписания
  appUpdate.check('startup').catch(() => { /* фоновая проверка молчит */ });
  window.addEventListener('hashchange', () => {
    const d = location.hash.slice(1) || today();
    if (d !== state.date && /^\d{4}-\d{2}-\d{2}$/.test(d)) go(d);
  });
}

boot();

// Проверка вёрстки на переполнение: /app.html?diag=1
if (location.search.includes('diag=1')) import('./dev-overflow.js');
