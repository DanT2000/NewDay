'use strict';

// ============================================================
// Utils
// ============================================================
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateRu(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function weekdayFromDate(dateStr) {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const d = new Date(dateStr + 'T00:00:00');
  return days[d.getDay()];
}

function calcProgress(items) {
  if (!items || items.length === 0) return null;
  const done = items.filter(i => i.done).length;
  return Math.round((done / items.length) * 100);
}

function calcAllProgress(day) {
  const work  = calcProgress(day.workTasks);
  const home  = calcProgress(day.homeTasks);
  const sport = calcProgress(day.sport);
  const habits = calcProgress(day.habits);
  const nonNull = [work, home, sport, habits].filter(v => v !== null);
  const overall = nonNull.length > 0
    ? Math.round(nonNull.reduce((a, b) => a + b, 0) / nonNull.length)
    : 0;
  return { overall, work, home, sport, habits };
}

// ============================================================
// State
// ============================================================
const state = {
  user: null,
  days: [],            // [{date, weekday, title, weight}]
  currentDate: null,
  currentDay: null,    // full day JSONB object
};

// ============================================================
// API helpers
// ============================================================
async function apiFetch(url, opts = {}) {
  const defaults = { headers: { 'Content-Type': 'application/json' } };
  const res = await fetch(url, { ...defaults, ...opts });
  if (res.status === 401) {
    window.location.href = '/login';
    return null;
  }
  return res;
}

// ============================================================
// Save logic (debounced)
// ============================================================
let saveTimer = null;
let savePending = false;

function scheduleSave() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1500);
}

async function doSave() {
  if (!state.currentDate || !state.currentDay) return;
  savePending = false;
  try {
    const res = await apiFetch(`/api/days/${state.currentDate}`, {
      method: 'PUT',
      body: JSON.stringify(state.currentDay),
    });
    if (res && res.ok) {
      showSaveIndicator();
      // Refresh weight in sidebar list
      const idx = state.days.findIndex(d => d.date === state.currentDate);
      if (idx !== -1 && state.currentDay.weight != null) {
        state.days[idx].weight = state.currentDay.weight;
      }
    }
  } catch (err) {
    console.error('Save error:', err);
  }
}

function showSaveIndicator() {
  const el = document.getElementById('saveIndicator');
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}

// ============================================================
// Progress circle SVG
// ============================================================
function progressCircleSVG(pct, size = 80) {
  if (pct === null) {
    return `<svg viewBox="0 0 80 80" class="progress-svg" style="width:${size}px;height:${size}px">
      <circle cx="40" cy="40" r="30" fill="none" stroke="#e2e8f0" stroke-width="7"/>
      <text x="40" y="45" text-anchor="middle" font-size="12" fill="#94a3b8" font-family="inherit">—</text>
    </svg>`;
  }
  const r = 30;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#4f6ef7';
  return `<svg viewBox="0 0 80 80" class="progress-svg" style="width:${size}px;height:${size}px">
    <circle cx="40" cy="40" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="7"/>
    <circle cx="40" cy="40" r="${r}" fill="none" stroke="${color}" stroke-width="7"
      stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
      stroke-linecap="round" transform="rotate(-90 40 40)"/>
    <text x="40" y="44" text-anchor="middle" font-size="14" font-weight="700" fill="${color}" font-family="inherit">${pct}%</text>
  </svg>`;
}

function progressCircleItem(label, pct, large) {
  const cls = large ? 'progress-circle-item full-width' : 'progress-circle-item';
  const size = large ? 96 : 72;
  return `<div class="${cls}">
    ${progressCircleSVG(pct, size)}
    <div class="progress-label">${esc(label)}</div>
  </div>`;
}

// ============================================================
// Render: Progress Panel
// ============================================================
function renderProgressPanel() {
  const panel = document.getElementById('progressContent');
  if (!state.currentDay) {
    panel.innerHTML = `<div class="panel-section"><div class="panel-heading">Прогресс дня</div>
      <p class="text-muted text-sm">Выберите день</p></div>`;
    return;
  }

  const p = calcAllProgress(state.currentDay);
  const weightHistory = state.days
    .map(d => ({ date: d.date, weight: d.weight }))
    .filter(d => d.weight != null && d.weight > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const curWeight = state.currentDay.weight;
  const curIdx = weightHistory.findIndex(d => d.date === state.currentDate);
  const prevWeight = curIdx > 0 ? weightHistory[curIdx - 1].weight : null;
  let diffHtml = '';
  if (curWeight != null && prevWeight != null) {
    const diff = (curWeight - prevWeight).toFixed(1);
    if (diff > 0) diffHtml = `<span class="weight-diff-pos">+${diff} кг</span>`;
    else if (diff < 0) diffHtml = `<span class="weight-diff-neg">${diff} кг</span>`;
    else diffHtml = `<span class="weight-diff-zero">без изменений</span>`;
  }

  // Sparkline
  let sparkHtml = '';
  if (weightHistory.length >= 2) {
    const W = 236, H = 44;
    const vals = weightHistory.map(d => d.weight);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1;
    const pts = vals.map((w, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - 6 - ((w - min) / range) * (H - 12);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const curPt = vals.map((w, i) => {
      if (weightHistory[i].date !== state.currentDate) return '';
      const x = (i / (vals.length - 1)) * W;
      const y = H - 6 - ((w - min) / range) * (H - 12);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#4f6ef7" stroke="white" stroke-width="1.5"/>`;
    }).join('');
    sparkHtml = `<div class="sparkline-wrap">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible">
        <polyline points="${pts}" fill="none" stroke="#4f6ef7" stroke-width="2" stroke-linejoin="round"/>
        ${curPt}
      </svg>
    </div>`;
  }

  panel.innerHTML = `
    <div class="panel-section">
      <div class="panel-heading">Прогресс дня</div>
      <div class="progress-circles">
        ${progressCircleItem('День', p.overall, true)}
        ${progressCircleItem('Работа', p.work, false)}
        ${progressCircleItem('Дом', p.home, false)}
        ${progressCircleItem('Спорт', p.sport, false)}
        ${progressCircleItem('Привычки', p.habits, false)}
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-heading">Вес</div>
      <div class="weight-stat">
        <div class="weight-stat-row">
          <span class="weight-stat-label">Сегодня</span>
          <span class="weight-stat-value">${curWeight != null ? curWeight + ' кг' : '—'}</span>
        </div>
        ${prevWeight != null ? `<div class="weight-stat-row" style="margin-top:4px">
          <span class="weight-stat-label">Предыдущий</span>
          <span style="font-size:13px;color:var(--text-2)">${prevWeight} кг</span>
        </div>` : ''}
        ${diffHtml ? `<div class="weight-stat-row" style="margin-top:6px;justify-content:flex-end">${diffHtml}</div>` : ''}
      </div>
      ${sparkHtml}
    </div>

    <div class="panel-section">
      <div class="panel-heading">Действия</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn btn-secondary btn-full btn-sm" onclick="exportCurrentDay()">↓ Скачать день JSON</button>
        <button class="btn btn-secondary btn-full btn-sm" onclick="openPrint()">🖨 Печать / PDF</button>
      </div>
    </div>
  `;
}

// ============================================================
// Render: Days List (sidebar)
// ============================================================
function renderDaysList() {
  const container = document.getElementById('daysList');
  if (state.days.length === 0) {
    container.innerHTML = `<div class="days-empty">Нет дней.<br>Создайте или импортируйте.</div>`;
    return;
  }
  container.innerHTML = state.days.map(d => {
    const active = d.date === state.currentDate ? 'active' : '';
    return `<div class="day-item ${active}" data-date="${esc(d.date)}">
      <div class="day-item-body">
        <div class="day-item-date">${esc(formatDateRu(d.date))}</div>
        <div class="day-item-meta">${esc(d.weekday)}${d.weight ? ' · ' + d.weight + ' кг' : ''}</div>
      </div>
      <button class="day-item-delete" data-delete-date="${esc(d.date)}" title="Удалить">×</button>
    </div>`;
  }).join('');
}

// ============================================================
// Render: Day View
// ============================================================
function renderDayView() {
  const day = state.currentDay;
  if (!day) return;

  const view = document.getElementById('dayView');

  const schedule = day.schedule || [];
  const workTasks = day.workTasks || [];
  const homeTasks = day.homeTasks || [];
  const sport = day.sport || [];
  const habits = day.habits || [];
  const notes = day.notes || ['', '', ''];

  view.innerHTML = `
    ${renderHeader(day)}
    ${renderSchedule(schedule)}
    <div class="grid-two">
      ${renderTaskList('workTasks', 'Рабочие задачи', workTasks)}
      ${renderTaskList('homeTasks', 'Дом и питание', homeTasks)}
    </div>
    ${renderSport(sport)}
    ${renderHabits(habits)}
    ${renderNotes(notes)}
  `;
}

function renderHeader(day) {
  return `<div class="day-header">
    <div class="day-header-top">
      <div class="day-header-left">
        <div class="day-date-line">
          <span class="day-date-text">${esc(formatDateRu(day.date))}</span>
          <span class="day-weekday-badge">${esc(day.weekday || '')}</span>
        </div>
        <input class="day-focus-input" id="focusInput" type="text"
          value="${esc(day.focus || '')}"
          placeholder="Фокус дня: детокс · подъём · без экрана...">
      </div>
      <div class="day-header-right">
        <div class="weight-box">
          <label for="weightInput">Вес:</label>
          <input class="weight-input" id="weightInput" type="number"
            value="${day.weight != null ? day.weight : ''}"
            min="0" max="999" step="0.1" placeholder="—">
          <span class="weight-unit">кг</span>
        </div>
        <div class="day-header-actions">
          <button class="btn btn-secondary btn-sm" onclick="openPrint()" title="Печать / PDF (P)">🖨 Печать</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderSchedule(schedule) {
  const rows = schedule.map((item, i) => `
    <tr>
      <td class="col-time"><input class="inline-input" data-sched-time="${i}"
        value="${esc(item.time || '')}" placeholder="09:00–10:00"></td>
      <td class="col-action"><input class="inline-input" data-sched-action="${i}"
        value="${esc(item.action || '')}" placeholder="Действие"></td>
      <td class="col-del">
        <button class="btn btn-ghost btn-icon" data-delete-sched="${i}" title="Удалить строку">×</button>
      </td>
    </tr>`).join('');

  return `<div class="section-card">
    <div class="section-header">
      <div class="section-title">Расписание</div>
    </div>
    <table class="data-table">
      <colgroup>
        <col class="col-time"><col class="col-action"><col class="col-del">
      </colgroup>
      <thead><tr>
        <th>Время</th><th>Действие</th><th></th>
      </tr></thead>
      <tbody id="scheduleBody">${rows}</tbody>
      <tfoot>
        <tr class="table-add-row">
          <td colspan="3">
            <button class="btn btn-ghost btn-sm" id="addSchedBtn">+ Добавить строку</button>
          </td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

function renderTaskList(category, title, tasks) {
  const items = tasks.map((t, i) => `
    <div class="task-item">
      <input type="checkbox" class="task-checkbox"
        data-cat="${esc(category)}" data-idx="${i}"
        ${t.done ? 'checked' : ''}>
      <input type="text" class="task-text-input ${t.done ? 'done-text' : ''}"
        data-task-text="${esc(category)}" data-idx="${i}"
        value="${esc(t.text || '')}" placeholder="Задача...">
      <button class="task-delete-btn" data-delete-task="${esc(category)}" data-idx="${i}" title="Удалить">×</button>
    </div>`).join('');

  return `<div class="section-card">
    <div class="section-header">
      <div class="section-title">${esc(title)}</div>
    </div>
    <div class="task-list" id="list-${esc(category)}">${items}</div>
    <button class="task-add-btn" data-add-task="${esc(category)}">+ Добавить задачу</button>
  </div>`;
}

function renderSport(sport) {
  const rows = sport.map((item, i) => `
    <tr>
      <td><input class="inline-input" data-sport-ex="${i}"
        value="${esc(item.exercise || '')}" placeholder="Упражнение"></td>
      <td class="col-sets"><input class="inline-input" data-sport-sets="${i}"
        value="${esc(item.sets || '')}" placeholder="3" style="text-align:center"></td>
      <td class="col-reps"><input class="inline-input" data-sport-reps="${i}"
        value="${esc(item.reps || '')}" placeholder="10–15"></td>
      <td class="col-done" style="text-align:center">
        <input type="checkbox" class="task-checkbox"
          data-cat="sport" data-idx="${i}"
          ${item.done ? 'checked' : ''}>
      </td>
      <td class="col-del">
        <button class="btn btn-ghost btn-icon" data-delete-sport="${i}" title="Удалить">×</button>
      </td>
    </tr>`).join('');

  return `<div class="section-card">
    <div class="section-header">
      <div class="section-title">Спорт</div>
    </div>
    <table class="data-table">
      <thead><tr>
        <th>Упражнение</th>
        <th class="col-sets">Подходы</th>
        <th class="col-reps">Повторения</th>
        <th class="col-done">Выполнено</th>
        <th class="col-del"></th>
      </tr></thead>
      <tbody id="sportBody">${rows}</tbody>
      <tfoot>
        <tr class="table-add-row">
          <td colspan="5">
            <button class="btn btn-ghost btn-sm" id="addSportBtn">+ Добавить упражнение</button>
          </td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

function renderHabits(habits) {
  const items = habits.map((h, i) => `
    <div class="habit-item ${h.done ? 'done-habit' : ''}">
      <input type="checkbox" class="task-checkbox"
        data-cat="habits" data-idx="${i}"
        ${h.done ? 'checked' : ''}>
      <input type="text" class="habit-text-input"
        data-habit-text="${i}"
        value="${esc(h.text || '')}" placeholder="Привычка">
      <button class="habit-delete-btn" data-delete-habit="${i}" title="Удалить">×</button>
    </div>`).join('');

  return `<div class="section-card">
    <div class="section-header">
      <div class="section-title">Привычки дня</div>
    </div>
    <div class="habits-grid" id="habitsGrid">${items}</div>
    <button class="task-add-btn" id="addHabitBtn" style="margin-top:8px">+ Добавить привычку</button>
  </div>`;
}

function renderNotes(notes) {
  const arr = Array.isArray(notes) ? notes : ['', '', ''];
  const textareas = arr.map((note, i) => `
    <textarea class="note-textarea" data-note-idx="${i}" rows="2"
      placeholder="Заметка ${i + 1}...">${esc(note)}</textarea>`).join('');

  return `<div class="section-card">
    <div class="section-header">
      <div class="section-title">Заметки</div>
    </div>
    <div class="notes-list">${textareas}</div>
  </div>`;
}

// ============================================================
// Event Delegation — Day View
// ============================================================
function attachDayViewEvents() {
  const view = document.getElementById('dayView');

  // Clicks
  view.addEventListener('click', (e) => {
    // Checkbox
    if (e.target.matches('.task-checkbox')) {
      const cat = e.target.dataset.cat;
      const idx = parseInt(e.target.dataset.idx);
      handleCheckbox(cat, idx, e.target.checked);
    }
    // Delete task
    if (e.target.matches('[data-delete-task]') || e.target.closest('[data-delete-task]')) {
      const btn = e.target.closest('[data-delete-task]');
      deleteTask(btn.dataset.deleteTask, parseInt(btn.dataset.idx));
    }
    // Delete schedule row
    if (e.target.matches('[data-delete-sched]') || e.target.closest('[data-delete-sched]')) {
      const btn = e.target.closest('[data-delete-sched]');
      deleteScheduleRow(parseInt(btn.dataset.deleteSched));
    }
    // Delete sport row
    if (e.target.matches('[data-delete-sport]') || e.target.closest('[data-delete-sport]')) {
      const btn = e.target.closest('[data-delete-sport]');
      deleteSportRow(parseInt(btn.dataset.deleteSport));
    }
    // Delete habit
    if (e.target.matches('[data-delete-habit]') || e.target.closest('[data-delete-habit]')) {
      const btn = e.target.closest('[data-delete-habit]');
      deleteHabit(parseInt(btn.dataset.deleteHabit));
    }
    // Add schedule row
    if (e.target.id === 'addSchedBtn') addScheduleRow();
    // Add sport row
    if (e.target.id === 'addSportBtn') addSportRow();
    // Add habit
    if (e.target.id === 'addHabitBtn') addHabit();
    // Add task
    if (e.target.matches('[data-add-task]')) addTask(e.target.dataset.addTask);
  });

  // Input changes
  view.addEventListener('input', (e) => {
    // Weight
    if (e.target.id === 'weightInput') {
      const v = parseFloat(e.target.value);
      state.currentDay.weight = isNaN(v) ? null : v;
      scheduleSave();
    }
    // Focus
    if (e.target.id === 'focusInput') {
      state.currentDay.focus = e.target.value;
      scheduleSave();
    }
    // Schedule time
    if (e.target.dataset.schedTime !== undefined) {
      const i = parseInt(e.target.dataset.schedTime);
      if (state.currentDay.schedule && state.currentDay.schedule[i]) {
        state.currentDay.schedule[i].time = e.target.value;
        scheduleSave();
      }
    }
    // Schedule action
    if (e.target.dataset.schedAction !== undefined) {
      const i = parseInt(e.target.dataset.schedAction);
      if (state.currentDay.schedule && state.currentDay.schedule[i]) {
        state.currentDay.schedule[i].action = e.target.value;
        scheduleSave();
      }
    }
    // Task text
    if (e.target.dataset.taskText) {
      const cat = e.target.dataset.taskText;
      const idx = parseInt(e.target.dataset.idx);
      if (state.currentDay[cat] && state.currentDay[cat][idx] !== undefined) {
        state.currentDay[cat][idx].text = e.target.value;
        scheduleSave();
      }
    }
    // Sport fields
    if (e.target.dataset.sportEx !== undefined) {
      const i = parseInt(e.target.dataset.sportEx);
      if (state.currentDay.sport && state.currentDay.sport[i]) {
        state.currentDay.sport[i].exercise = e.target.value;
        scheduleSave();
      }
    }
    if (e.target.dataset.sportSets !== undefined) {
      const i = parseInt(e.target.dataset.sportSets);
      if (state.currentDay.sport && state.currentDay.sport[i]) {
        state.currentDay.sport[i].sets = e.target.value;
        scheduleSave();
      }
    }
    if (e.target.dataset.sportReps !== undefined) {
      const i = parseInt(e.target.dataset.sportReps);
      if (state.currentDay.sport && state.currentDay.sport[i]) {
        state.currentDay.sport[i].reps = e.target.value;
        scheduleSave();
      }
    }
    // Habit text
    if (e.target.dataset.habitText !== undefined) {
      const i = parseInt(e.target.dataset.habitText);
      if (state.currentDay.habits && state.currentDay.habits[i] !== undefined) {
        state.currentDay.habits[i].text = e.target.value;
        scheduleSave();
      }
    }
    // Notes
    if (e.target.dataset.noteIdx !== undefined) {
      const i = parseInt(e.target.dataset.noteIdx);
      if (!state.currentDay.notes) state.currentDay.notes = [];
      state.currentDay.notes[i] = e.target.value;
      scheduleSave();
    }
  });
}

// ============================================================
// Checkbox
// ============================================================
function handleCheckbox(cat, idx, checked) {
  if (!state.currentDay) return;
  const arr = state.currentDay[cat];
  if (!arr || arr[idx] === undefined) return;
  arr[idx].done = checked;

  // Update task text strikethrough without full re-render
  const textInput = document.querySelector(`[data-task-text="${cat}"][data-idx="${idx}"]`);
  if (textInput) {
    textInput.classList.toggle('done-text', checked);
  }
  // Update habit cell class
  const habitItem = document.querySelector(`.habit-item [data-cat="habits"][data-idx="${idx}"]`);
  if (habitItem) {
    habitItem.closest('.habit-item').classList.toggle('done-habit', checked);
  }

  scheduleSave();
  renderProgressPanel();
}

// ============================================================
// Add / Delete rows
// ============================================================
function addScheduleRow() {
  if (!state.currentDay) return;
  if (!state.currentDay.schedule) state.currentDay.schedule = [];
  state.currentDay.schedule.push({ time: '', action: '' });
  renderDayView();
  renderProgressPanel();
  scheduleSave();
  // Focus the last time input
  setTimeout(() => {
    const inputs = document.querySelectorAll('[data-sched-time]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
}

function deleteScheduleRow(idx) {
  if (!state.currentDay || !state.currentDay.schedule) return;
  state.currentDay.schedule.splice(idx, 1);
  renderDayView();
  scheduleSave();
}

function addTask(cat) {
  if (!state.currentDay) return;
  if (!state.currentDay[cat]) state.currentDay[cat] = [];
  state.currentDay[cat].push({ text: '', done: false });
  renderDayView();
  renderProgressPanel();
  scheduleSave();
  setTimeout(() => {
    const inputs = document.querySelectorAll(`[data-task-text="${cat}"]`);
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
}

function deleteTask(cat, idx) {
  if (!state.currentDay || !state.currentDay[cat]) return;
  state.currentDay[cat].splice(idx, 1);
  renderDayView();
  renderProgressPanel();
  scheduleSave();
}

function addSportRow() {
  if (!state.currentDay) return;
  if (!state.currentDay.sport) state.currentDay.sport = [];
  state.currentDay.sport.push({ exercise: '', sets: '', reps: '', done: false });
  renderDayView();
  renderProgressPanel();
  scheduleSave();
  setTimeout(() => {
    const inputs = document.querySelectorAll('[data-sport-ex]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
}

function deleteSportRow(idx) {
  if (!state.currentDay || !state.currentDay.sport) return;
  state.currentDay.sport.splice(idx, 1);
  renderDayView();
  renderProgressPanel();
  scheduleSave();
}

function addHabit() {
  if (!state.currentDay) return;
  if (!state.currentDay.habits) state.currentDay.habits = [];
  state.currentDay.habits.push({ text: '', done: false });
  renderDayView();
  renderProgressPanel();
  scheduleSave();
  setTimeout(() => {
    const inputs = document.querySelectorAll('[data-habit-text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
}

function deleteHabit(idx) {
  if (!state.currentDay || !state.currentDay.habits) return;
  state.currentDay.habits.splice(idx, 1);
  renderDayView();
  renderProgressPanel();
  scheduleSave();
}

// ============================================================
// Select Day
// ============================================================
async function selectDay(date) {
  // Flush any pending save for old day
  if (savePending && state.currentDate) {
    clearTimeout(saveTimer);
    await doSave();
  }

  state.currentDate = date;

  try {
    const res = await apiFetch(`/api/days/${date}`);
    if (!res) return;

    if (!res.ok) {
      console.error('Failed to load day');
      return;
    }

    state.currentDay = await res.json();
  } catch (err) {
    console.error('Load day error:', err);
    return;
  }

  document.getElementById('emptyState').classList.add('hidden');
  const view = document.getElementById('dayView');
  view.classList.remove('hidden');

  renderDayView();
  renderProgressPanel();
  renderDaysList(); // update active item
}

// ============================================================
// Load Days List
// ============================================================
async function loadDays() {
  try {
    const res = await apiFetch('/api/days');
    if (!res || !res.ok) return;
    state.days = await res.json();
  } catch (err) {
    console.error('Load days error:', err);
  }
  renderDaysList();
}

// ============================================================
// Delete Day
// ============================================================
async function deleteDay(date) {
  const confirmed = await showConfirm(
    '🗑 Удалить день?',
    `День ${formatDateRu(date)} будет удалён без возможности восстановления.`,
    'Удалить',
    true
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/days/${date}`, { method: 'DELETE' });
    if (!res || !res.ok) {
      const d = await res.json();
      alert(d.error || 'Ошибка удаления');
      return;
    }
  } catch (err) {
    console.error('Delete day error:', err);
    return;
  }

  state.days = state.days.filter(d => d.date !== date);

  if (state.currentDate === date) {
    state.currentDate = null;
    state.currentDay = null;
    document.getElementById('dayView').classList.add('hidden');
    document.getElementById('emptyState').classList.remove('hidden');
    renderProgressPanel();
  }

  renderDaysList();

  // Auto-select first available day
  if (state.days.length > 0 && !state.currentDate) {
    selectDay(state.days[0].date);
  }
}

// ============================================================
// New Day Modal
// ============================================================
function openNewDayModal() {
  document.getElementById('newDayDate').value = todayStr();
  document.getElementById('newDayFocus').value = '';
  document.getElementById('newDayModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('newDayDate').focus(), 50);
}

function closeNewDayModal() {
  document.getElementById('newDayModal').classList.add('hidden');
}

async function createNewDay() {
  const dateVal = document.getElementById('newDayDate').value;
  const focus = document.getElementById('newDayFocus').value.trim();

  if (!dateVal) {
    alert('Введите дату');
    return;
  }

  const existing = state.days.find(d => d.date === dateVal);
  if (existing) {
    const ok = await showConfirm(
      '⚠️ День уже существует',
      `День ${formatDateRu(dateVal)} уже есть. Открыть его?`,
      'Открыть',
      false
    );
    if (ok) {
      closeNewDayModal();
      selectDay(dateVal);
    }
    return;
  }

  const dayData = {
    date: dateVal,
    weekday: weekdayFromDate(dateVal),
    title: 'План дня',
    focus: focus,
    weight: null,
    schedule: [],
    workTasks: [],
    homeTasks: [],
    sport: [],
    habits: [],
    notes: ['', '', ''],
  };

  try {
    const res = await apiFetch('/api/days', {
      method: 'POST',
      body: JSON.stringify(dayData),
    });
    if (!res || !res.ok) {
      const d = await res.json();
      alert(d.error || 'Ошибка создания дня');
      return;
    }
  } catch (err) {
    console.error('Create day error:', err);
    return;
  }

  await loadDays();
  closeNewDayModal();
  selectDay(dateVal);
}

// ============================================================
// Import Modal
// ============================================================
let parsedImportData = null;

function openImportModal() {
  parsedImportData = null;
  document.getElementById('importTextarea').value = '';
  document.getElementById('importPreview').classList.add('hidden');
  document.getElementById('importPreview').textContent = '';
  document.getElementById('importModal').classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('importModal').classList.add('hidden');
  parsedImportData = null;
}

function validateAndPreviewImport(jsonText) {
  const preview = document.getElementById('importPreview');
  parsedImportData = null;

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    preview.textContent = '❌ Ошибка: невалидный JSON — ' + e.message;
    preview.className = 'import-preview';
    preview.style.background = 'var(--danger-light)';
    preview.style.borderColor = 'var(--danger-border)';
    preview.style.color = '#be123c';
    preview.classList.remove('hidden');
    return;
  }

  if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    preview.textContent = '❌ Ошибка: поле "date" обязательно в формате YYYY-MM-DD';
    preview.className = 'import-preview';
    preview.style.background = 'var(--danger-light)';
    preview.style.borderColor = 'var(--danger-border)';
    preview.style.color = '#be123c';
    preview.classList.remove('hidden');
    return;
  }

  const existsAlready = state.days.find(d => d.date === data.date);

  parsedImportData = data;
  const tasks = (data.workTasks || []).length + (data.homeTasks || []).length;
  const sched = (data.schedule || []).length;
  preview.innerHTML = `✓ Дата: <strong>${formatDateRu(data.date)}</strong> (${data.weekday || weekdayFromDate(data.date)})
    · ${sched} строк расписания · ${tasks} задач
    ${existsAlready ? '<br>⚠️ <strong>День уже существует — будет заменён</strong>' : ''}`;
  preview.className = 'import-preview';
  preview.style.background = 'var(--success-light)';
  preview.style.borderColor = 'var(--success-border)';
  preview.style.color = '#065f46';
  preview.classList.remove('hidden');
}

async function doImport() {
  if (!parsedImportData) {
    const text = document.getElementById('importTextarea').value.trim();
    if (!text) { alert('Вставьте JSON для импорта'); return; }
    validateAndPreviewImport(text);
    if (!parsedImportData) return;
  }

  const existsAlready = state.days.find(d => d.date === parsedImportData.date);
  if (existsAlready) {
    const ok = await showConfirm(
      '⚠️ Заменить день?',
      `День ${formatDateRu(parsedImportData.date)} уже существует. Заменить его данными из JSON?`,
      'Заменить',
      true
    );
    if (!ok) return;
  }

  try {
    const res = await apiFetch('/api/days/import', {
      method: 'POST',
      body: JSON.stringify(parsedImportData),
    });
    if (!res || !res.ok) {
      const d = await res.json();
      alert(d.error || 'Ошибка импорта');
      return;
    }
  } catch (err) {
    console.error('Import error:', err);
    return;
  }

  const importedDate = parsedImportData.date;
  closeImportModal();
  await loadDays();
  selectDay(importedDate);
}

// ============================================================
// Export
// ============================================================
async function exportCurrentDay() {
  if (!state.currentDate) return;
  window.location.href = `/api/days/${state.currentDate}/export`;
}

async function exportAll() {
  window.location.href = '/api/export/all';
}

// ============================================================
// Print
// ============================================================
function openPrint() {
  if (!state.currentDate) { alert('Выберите день для печати'); return; }
  window.open(`/print/${state.currentDate}`, '_blank');
}

// ============================================================
// Confirm dialog helper
// ============================================================
function showConfirm(title, message, okLabel, isDanger) {
  return new Promise((resolve) => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    const okBtn = document.getElementById('confirmOkBtn');
    okBtn.textContent = okLabel || 'OK';
    okBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';

    document.getElementById('confirmModal').classList.remove('hidden');

    const cleanup = () => {
      document.getElementById('confirmModal').classList.add('hidden');
      okBtn.onclick = null;
      document.getElementById('confirmCancelBtn').onclick = null;
    };

    okBtn.onclick = () => { cleanup(); resolve(true); };
    document.getElementById('confirmCancelBtn').onclick = () => { cleanup(); resolve(false); };
  });
}

// ============================================================
// Init & global event wiring
// ============================================================
async function init() {
  // Verify session
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    state.user = await res.json();
  } catch (err) {
    window.location.href = '/login';
    return;
  }

  document.getElementById('navUsername').textContent = state.user.username;

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  // New Day buttons
  document.getElementById('newDayBtn').addEventListener('click', openNewDayModal);
  document.getElementById('emptyNewDayBtn').addEventListener('click', openNewDayModal);
  document.getElementById('newDayCancelBtn').addEventListener('click', closeNewDayModal);
  document.getElementById('newDayConfirmBtn').addEventListener('click', createNewDay);
  document.getElementById('newDayModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('newDayModal')) closeNewDayModal();
  });

  // Import
  document.getElementById('importBtn').addEventListener('click', openImportModal);
  document.getElementById('importCancelBtn').addEventListener('click', closeImportModal);
  document.getElementById('importConfirmBtn').addEventListener('click', doImport);
  document.getElementById('importModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('importModal')) closeImportModal();
  });

  // Import textarea — parse on input (debounced)
  let importDebounce = null;
  document.getElementById('importTextarea').addEventListener('input', (e) => {
    clearTimeout(importDebounce);
    const text = e.target.value.trim();
    if (!text) {
      document.getElementById('importPreview').classList.add('hidden');
      parsedImportData = null;
      return;
    }
    importDebounce = setTimeout(() => validateAndPreviewImport(text), 400);
  });

  // File drop zone
  const dropZone = document.getElementById('fileDropZone');
  const fileInput = document.getElementById('fileInput');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      document.getElementById('importTextarea').value = text;
      validateAndPreviewImport(text);
    };
    reader.readAsText(file);
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById('importTextarea').value = ev.target.result;
      validateAndPreviewImport(ev.target.result);
    };
    reader.readAsText(file);
  });

  // Export all
  document.getElementById('exportAllBtn').addEventListener('click', exportAll);

  // Days list click delegation
  document.getElementById('daysList').addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('[data-delete-date]');
    if (deleteBtn) {
      e.stopPropagation();
      deleteDay(deleteBtn.dataset.deleteDate);
      return;
    }
    const item = e.target.closest('.day-item');
    if (item) selectDay(item.dataset.date);
  });

  // Keyboard: P → print current day
  document.addEventListener('keydown', (e) => {
    const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (!isTyping && e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      openPrint();
    }
    // Escape closes modals
    if (e.key === 'Escape') {
      closeImportModal();
      closeNewDayModal();
      document.getElementById('confirmModal').classList.add('hidden');
    }
  });

  // Attach day view event handlers
  attachDayViewEvents();

  // Load data
  await loadDays();

  // Auto-select most recent day
  if (state.days.length > 0) {
    selectDay(state.days[0].date);
  }
}

window.addEventListener('DOMContentLoaded', init);
