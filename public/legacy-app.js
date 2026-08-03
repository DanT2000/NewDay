/* ============================================================
   NewDay — main application script
   ============================================================ */

// ─── State ───────────────────────────────────────────────────
const S = {
  user: null,
  days: [],
  selectedDate: null,
  selectedDay: null,
  habits: [],
  habitLogs: [],
  habitStats: [],
  saveTimer: null,
  // mobile state
  activeTab: 'today',
  habitStatsFull: null,
  habitStatsPeriod: '7',
};

// ─── DOM helpers ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Mobile detection ────────────────────────────────────────
function isMobile() { return window.innerWidth <= 768; }

// ─── API ─────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const GET  = path      => api('GET',    path);
const POST = (path, b) => api('POST',   path, b);
const PUT  = (path, b) => api('PUT',    path, b);
const DEL  = path      => api('DELETE', path);

// ─── Toast ───────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = el('div', `toast toast-${type}`, esc(msg));
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ─── Date helpers ────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}
const WEEKDAYS = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
function getWeekday(dateStr) {
  if (!dateStr) return '';
  return WEEKDAYS[new Date(dateStr + 'T12:00:00').getDay()];
}

// ─── Time normalization & schedule sort ──────────────────────
function parseTimePart(str) {
  str = str.trim();
  let m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { const h = +m[1], min = +m[2]; if (h <= 23 && min <= 59) return { ok: true, h, min }; }
  m = str.match(/^(\d{1,2})\.(\d{2})$/);
  if (m) { const h = +m[1], min = +m[2]; if (h <= 23 && min <= 59) return { ok: true, h, min }; }
  m = str.match(/^(\d{1,2})\s+(\d{2})$/);
  if (m) { const h = +m[1], min = +m[2]; if (h <= 23 && min <= 59) return { ok: true, h, min }; }
  m = str.match(/^(\d{1,2})$/);
  if (m) { const h = +m[1]; if (h <= 23) return { ok: true, h, min: 0 }; }
  return { ok: false };
}

function normalizeTimeRange(input) {
  if (!input || !input.trim()) return { ok: false, display: input || '', startMinutes: null };
  const s = input.trim();
  const parts = s.split(/\s*[–\-]\s*/);
  if (parts.length !== 2) return { ok: false, display: s, startMinutes: null };

  const startP = parseTimePart(parts[0]);
  if (!startP.ok) return { ok: false, display: s, startMinutes: null };
  const endP = parseTimePart(parts[1]);
  if (!endP.ok) return { ok: false, display: s, startMinutes: null };

  let endH = endP.h;
  const isSingle = parts[1].trim().length === 1;

  if (isSingle && endH <= startP.h) {
    if (endH === 0 && startP.h >= 20) {
      endH = 0;
    } else if (endH + 12 > startP.h && endH + 12 <= 23) {
      endH = endH + 12;
    }
  }

  const fmt = (h, min) => `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  return {
    ok: true,
    display: `${fmt(startP.h, startP.min)}–${fmt(endH, endP.min)}`,
    startMinutes: startP.h * 60 + startP.min,
  };
}

function sortSchedule(schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return schedule || [];

  const tagged = schedule.map(row => {
    const norm = normalizeTimeRange(row.time);
    return {
      row: { ...row, time: norm.ok ? norm.display : row.time },
      startMinutes: norm.ok ? norm.startMinutes : null,
    };
  });

  const known   = tagged.filter(t => t.startMinutes !== null);
  const unknown = tagged.filter(t => t.startMinutes === null);
  known.sort((a, b) => a.startMinutes - b.startMinutes);

  return [...known, ...unknown].map(t => t.row);
}

// ─── Auth ────────────────────────────────────────────────────
async function checkAuth() {
  const data = await GET('/api/auth/me').catch(() => null);
  if (!data) { window.location.replace('/login.html'); return false; }
  S.user = data;
  const el = $('header-username');
  if (el) el.textContent = data.username;
  return true;
}

async function logout() {
  await POST('/api/auth/logout').catch(() => {});
  window.location.replace('/login.html');
}

// ─── Days ────────────────────────────────────────────────────
async function loadDays() {
  S.days = await GET('/api/days').catch(() => []);
  renderDaysList();
}

async function selectDay(date) {
  S.selectedDate = date;
  document.querySelectorAll('.day-item').forEach(e => e.classList.remove('active'));
  const item = document.querySelector(`.day-item[data-date="${date}"]`);
  if (item) item.classList.add('active');

  try { S.selectedDay = await GET(`/api/days/${date}`); }
  catch { S.selectedDay = { date }; }

  await loadHabitLogs(date);
  renderDay();
  updateProgress();
  loadHabitStats();
  renderWeightHistory();

  if (isMobile()) renderActiveMobileTab();
}

async function saveDay() {
  if (!S.selectedDate || !S.selectedDay) return;
  try {
    await PUT(`/api/days/${S.selectedDate}`, S.selectedDay);
    const idx = S.days.findIndex(d => d.date === S.selectedDate);
    if (idx >= 0) {
      S.days[idx].title  = S.selectedDay.title  || '';
      S.days[idx].weight = S.selectedDay.weight ?? null;
      renderDaysList();
      const active = document.querySelector(`.day-item[data-date="${S.selectedDate}"]`);
      if (active) active.classList.add('active');
    } else {
      await loadDays();
      const active = document.querySelector(`.day-item[data-date="${S.selectedDate}"]`);
      if (active) active.classList.add('active');
    }
  } catch (e) {
    toast('Ошибка сохранения: ' + e.message, 'error');
  }
}

function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveDay, 800);
}

async function deleteDay(date) {
  await DEL(`/api/days/${date}`);
  S.days = S.days.filter(d => d.date !== date);
  S.selectedDate = null;
  S.selectedDay  = null;
  renderDaysList();
  $('day-empty').style.display = '';
  $('day-view').style.display  = 'none';
  toast('День удалён', 'success');
}

// ─── Habits ──────────────────────────────────────────────────
async function loadHabits() {
  S.habits = await GET('/api/habits').catch(() => []);
}

async function loadHabitLogs(date) {
  S.habitLogs = await GET(`/api/habits/logs/${date}`).catch(() => []);
}

async function toggleHabitLog(habitId, done) {
  if (!S.selectedDate) return;
  try {
    await PUT(`/api/habits/logs/${S.selectedDate}/${habitId}`, { done });
    const log = S.habitLogs.find(l => l.id === habitId);
    if (log) log.done = done;
    updateProgress();
    renderHabitsDay();
    const doneCount = S.habitLogs.filter(l => l.done).length;
    const tagEl = $('habits-progress-tag');
    if (tagEl) tagEl.textContent = `${doneCount}/${S.habitLogs.length}`;
    if (isMobile()) renderActiveMobileTab();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
}

async function loadHabitStats() {
  const result = await GET('/api/habits/stats?period=' + (S.habitStatsPeriod || '30')).catch(() => null);
  S.habitStatsFull = result;
  S.habitStats = result;
  renderHabitStats();
}

// ─── Progress ─────────────────────────────────────────────────
function calcPct(arr) {
  if (!arr || !arr.length) return null;
  const done = arr.filter(i => i.done).length;
  return Math.round((done / arr.length) * 100);
}

function setCircle(id, pct) {
  const circle = $(id);
  const pctEl  = $(id + '-pct');
  if (!circle) return;
  if (pct === null) {
    circle.style.strokeDasharray = '0 100';
    if (pctEl) pctEl.textContent = '–';
    return;
  }
  const p = Math.min(100, Math.max(0, pct));
  circle.style.strokeDasharray = `${p} ${100 - p}`;
  if (pctEl) pctEl.textContent = p + '%';
}

function updateProgress() {
  if (!S.selectedDay) return;
  const d = S.selectedDay;

  const workPct   = calcPct(d.workTasks);
  const homePct   = calcPct(d.homeTasks);
  const sportPct  = calcPct(d.sport);
  const habitPct  = S.habitLogs.length ? calcPct(S.habitLogs) : null;

  const parts = [workPct, homePct, sportPct, habitPct].filter(x => x !== null);
  const dayPct = parts.length
    ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length)
    : null;

  setCircle('prog-day',    dayPct);
  setCircle('prog-work',   workPct);
  setCircle('prog-home',   homePct);
  setCircle('prog-sport',  sportPct);
  setCircle('prog-habits', habitPct);
}

// ─── Weight history ──────────────────────────────────────────
function renderWeightHistory() {
  const listEl  = $('weight-history-list');
  const chartEl = $('weight-chart');
  if (!listEl) return;

  const withWeight = S.days.filter(d => d.weight !== null && d.weight !== undefined).slice(0, 10);

  if (!withWeight.length) {
    listEl.innerHTML  = '<div class="no-items">Нет данных о весе</div>';
    if (chartEl) chartEl.innerHTML = '';
    return;
  }

  const recent = withWeight.slice(0, 7).reverse();
  listEl.innerHTML = '';

  recent.forEach((d, i) => {
    const prev = recent[i - 1];
    let changeHtml = '';
    if (prev) {
      const diff = (d.weight - prev.weight).toFixed(1);
      const cls  = diff < 0 ? 'down' : diff > 0 ? 'up' : '';
      const arrow = diff < 0 ? '↓' : diff > 0 ? '↑' : '→';
      if (cls) changeHtml = `<span class="weight-change ${cls}">${arrow}${Math.abs(diff)}</span>`;
    }
    const row = el('div', 'weight-history-row');
    row.innerHTML = `
      <span class="weight-history-date">${fmtDate(d.date)}</span>
      <span class="weight-history-val">${d.weight} кг ${changeHtml}</span>`;
    listEl.appendChild(row);
  });

  if (chartEl && recent.length > 1) {
    const vals = recent.map(d => d.weight);
    const min  = Math.min(...vals);
    const max  = Math.max(...vals);
    const range = max - min || 1;
    const W = 220, H = 44, pad = 4;

    const pts = vals.map((v, i) => {
      const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
      const y = H - pad - ((v - min) / range) * (H - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const lx = pad + (W - 2 * pad);
    const ly = H - pad - ((vals[vals.length - 1] - min) / range) * (H - 2 * pad);

    chartEl.innerHTML = `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="var(--accent)"/>
      </svg>`;
  } else if (chartEl) {
    chartEl.innerHTML = '';
  }
}

// ─── Habit stats (desktop right panel) ──────────────────────
function renderHabitStats() {
  const listEl = $('habit-stats-list');
  if (!listEl) return;

  // Use full stats if available, else fall back to legacy stats
  const fullStats = S.habitStatsFull;

  if (fullStats && Array.isArray(fullStats.habits)) {
    if (!fullStats.habits.length) {
      listEl.innerHTML = '<div class="no-items">Нет активных привычек</div>';
      return;
    }
    listEl.innerHTML = '';
    fullStats.habits.forEach(h => {
      const pct = h.percentPeriod ?? h.percent30 ?? h.percent7 ?? 0;
      const last7html = (h.last7 || []).map(d => {
        const cls = d.done ? 'done' : 'missed';
        return `<span class="hd-dot ${cls}"></span>`;
      }).join('');

      const row = el('div', 'habit-stat-row');
      row.innerHTML = `
        <div class="habit-stat-header">
          <span class="habit-stat-name">${esc(h.emoji)} ${esc(h.title)}</span>
          <span class="habit-stat-pct">${pct !== null ? pct + '%' : '–'}</span>
        </div>
        <div class="habit-stat-bar-bg">
          <div class="habit-stat-bar" style="width:${pct || 0}%"></div>
        </div>
        <div style="font-size:.7rem;color:var(--muted);margin-top:4px;display:flex;gap:3px;align-items:center">
          ${last7html}
        </div>`;
      listEl.appendChild(row);
    });
    return;
  }

  // Legacy fallback
  if (!S.habitStats || !S.habitStats.length) {
    if (!S.habitStats || (Array.isArray(S.habitStats) && !S.habitStats.length)) {
      listEl.innerHTML = '<div class="no-items">Нет активных привычек</div>';
      return;
    }
  }

  // Handle both new API format (has .habits) and old array format
  const statsList = Array.isArray(S.habitStats) ? S.habitStats : [];
  if (!statsList.length) {
    listEl.innerHTML = '<div class="no-items">Нет активных привычек</div>';
    return;
  }

  listEl.innerHTML = '';
  statsList.forEach(h => {
    const pct30 = h.last30 && h.last30.total
      ? Math.round((h.last30.done / h.last30.total) * 100)
      : 0;
    const row = el('div', 'habit-stat-row');
    row.innerHTML = `
      <div class="habit-stat-header">
        <span class="habit-stat-name">${esc(h.emoji)} ${esc(h.title)}</span>
        <span class="habit-stat-pct">${pct30}%</span>
      </div>
      <div class="habit-stat-bar-bg">
        <div class="habit-stat-bar" style="width:${pct30}%"></div>
      </div>
      <div style="font-size:.7rem;color:var(--muted);margin-top:2px">
        7 дн: ${h.last7 ? h.last7.done + '/' + h.last7.total : '–'} · 30 дн: ${h.last30 ? h.last30.done + '/' + h.last30.total : '–'}
      </div>`;
    listEl.appendChild(row);
  });
}

// Desktop period setter
function desktopSetPeriod(p) {
  document.querySelectorAll('#desktop-period-picker .period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.p === p);
  });
  S.habitStatsPeriod = p;
  loadHabitStatsFull(p).then(() => renderHabitStats());
}

// ─── Render: Days list ───────────────────────────────────────
function renderDaysList() {
  const listEl = $('days-list');
  if (!listEl) return;

  if (!S.days.length) {
    listEl.innerHTML = '<div class="no-items">Нет дней</div>';
    return;
  }

  listEl.innerHTML = '';
  S.days.forEach(d => {
    const item = el('div', 'day-item');
    item.dataset.date = d.date;

    const isToday    = d.date === today();
    const weekday    = getWeekday(d.date);
    const titleText  = d.title || '(без заголовка)';
    const weightText = d.weight ? `${d.weight} кг` : '';

    item.innerHTML = `
      <div class="day-item-date">
        ${fmtDate(d.date)}
        ${isToday ? '<span class="tag tag-blue" style="padding:1px 5px;font-size:.65rem">сегодня</span>' : ''}
      </div>
      <div class="day-item-meta">
        <span>${weekday}</span>
        ${weightText ? `<span>${weightText}</span>` : ''}
      </div>
      <div class="day-item-meta day-item-title">${esc(titleText)}</div>`;

    item.addEventListener('click', () => selectDay(d.date));
    listEl.appendChild(item);
  });
}

// ─── Render: Day view ─────────────────────────────────────────
function renderDay() {
  const d = S.selectedDay;
  if (!d) return;

  $('day-empty').style.display = 'none';
  $('day-view').style.display  = 'block';

  $('day-date-display').textContent  = fmtDate(d.date);
  $('day-weekday-display').textContent = getWeekday(d.date);
  $('day-title').value  = d.title  || '';
  $('day-focus').value  = d.focus  || '';
  $('day-weight').value = d.weight ?? '';
  $('day-notes').value  = Array.isArray(d.notes) ? d.notes.join('\n') : (d.notes || '');

  renderWeightChange();
  renderSchedule();
  renderTaskList('work-tasks-list', d.workTasks || [], 'workTasks');
  renderTaskList('home-tasks-list', d.homeTasks || [], 'homeTasks');
  renderSport();
  renderHabitsDay();
}

function renderWeightChange() {
  const changeEl = $('weight-change-display');
  if (!changeEl) return;

  const currentWeight = S.selectedDay?.weight;
  if (!currentWeight) { changeEl.textContent = ''; return; }

  const prev = S.days.find(d => d.date < S.selectedDate && d.weight);
  if (!prev) { changeEl.textContent = ''; return; }

  const diff = (currentWeight - prev.weight).toFixed(1);
  if (diff == 0) { changeEl.textContent = '→'; changeEl.className = 'weight-change'; return; }
  const cls   = diff < 0 ? 'down' : 'up';
  const arrow = diff < 0 ? '↓' : '↑';
  changeEl.textContent = `${arrow}${Math.abs(diff)}`;
  changeEl.className = `weight-change ${cls}`;
}

// ─── Render: Schedule ────────────────────────────────────────
function renderSchedule() {
  const tbody = $('schedule-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows  = S.selectedDay?.schedule  || [];
  const extra = S.selectedDay?.extraScheduleRows || 0;

  rows.forEach((row, i) => addScheduleRow(tbody, row, i, false));

  for (let i = 0; i < extra; i++) {
    addScheduleRow(tbody, { time: '', action: '' }, rows.length + i, true);
  }
}

function addScheduleRow(tbody, row, idx, isExtra) {
  const tr = el('tr');
  tr.dataset.idx   = idx;
  tr.dataset.extra = isExtra ? '1' : '0';

  const timeInput = el('input');
  timeInput.className   = 'schedule-input schedule-time-input';
  timeInput.value       = row.time || '';
  timeInput.placeholder = '00:00–00:00';
  if (isExtra) timeInput.style.color = 'var(--border)';

  const actionInput = el('input');
  actionInput.className   = 'schedule-input';
  actionInput.value       = row.action || '';
  actionInput.placeholder = 'Действие...';

  const delBtn = el('button', 'row-del-btn', '×');
  delBtn.title = 'Удалить строку';
  delBtn.addEventListener('click', () => {
    if (!isExtra) {
      S.selectedDay.schedule.splice(idx, 1);
    } else {
      S.selectedDay.extraScheduleRows = Math.max(0, (S.selectedDay.extraScheduleRows || 0) - 1);
    }
    renderSchedule();
    scheduleSave();
  });

  actionInput.addEventListener('input', () => {
    if (!isExtra && S.selectedDay?.schedule[idx] !== undefined) {
      S.selectedDay.schedule[idx].action = actionInput.value;
      scheduleSave();
    }
  });

  timeInput.addEventListener('input', () => {
    if (!isExtra && S.selectedDay?.schedule[idx] !== undefined) {
      S.selectedDay.schedule[idx].time = timeInput.value;
      scheduleSave();
    }
  });

  timeInput.addEventListener('blur', () => {
    if (isExtra || !S.selectedDay || !timeInput.value.trim()) return;
    if (S.selectedDay.schedule[idx] === undefined) return;

    const norm = normalizeTimeRange(timeInput.value);

    if (norm.ok) {
      if (norm.display !== timeInput.value) {
        timeInput.value = norm.display;
      }
      S.selectedDay.schedule[idx].time = norm.display;
      S.selectedDay.schedule = sortSchedule(S.selectedDay.schedule);
      renderSchedule();
      scheduleSave();
    } else if (timeInput.value.trim()) {
      toast('Время не распознано, строка оставлена в конце', 'info');
    }
  });

  const tdTime   = el('td', 'schedule-time-cell');
  const tdAction = el('td', 'schedule-action-cell');
  const tdDel    = el('td', 'schedule-del-cell');

  tdTime.appendChild(timeInput);
  tdAction.appendChild(actionInput);
  tdDel.appendChild(delBtn);

  tr.appendChild(tdTime);
  tr.appendChild(tdAction);
  tr.appendChild(tdDel);
  tbody.appendChild(tr);
}

// ─── Render: Task list ───────────────────────────────────────
function renderTaskList(containerId, tasks, field) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!tasks.length) {
    container.innerHTML = '<div class="no-items">Нет задач</div>';
    return;
  }

  tasks.forEach((task, i) => {
    const row = el('div', 'task-row');

    const cb = el('input');
    cb.type      = 'checkbox';
    cb.className = 'task-cb';
    cb.checked   = task.done || false;

    const textInput = el('input');
    textInput.type      = 'text';
    textInput.className = 'task-text-input' + (task.done ? ' done-text' : '');
    textInput.value     = task.text || '';
    textInput.placeholder = 'Задача...';

    let carriedEl = null;
    if (task.carriedFrom) {
      carriedEl = el('span', 'carried-tag', `↩ с ${fmtDate(task.carriedFrom)}`);
    }

    const delBtn = el('button', 'row-del-btn', '×');
    delBtn.title = 'Удалить задачу';

    cb.addEventListener('change', () => {
      S.selectedDay[field][i].done = cb.checked;
      textInput.className = 'task-text-input' + (cb.checked ? ' done-text' : '');
      scheduleSave();
      updateProgress();
    });

    textInput.addEventListener('input', () => {
      S.selectedDay[field][i].text = textInput.value;
      scheduleSave();
    });

    delBtn.addEventListener('click', () => {
      S.selectedDay[field].splice(i, 1);
      renderTaskList(containerId, S.selectedDay[field], field);
      scheduleSave();
      updateProgress();
    });

    row.appendChild(cb);
    row.appendChild(textInput);
    if (carriedEl) row.appendChild(carriedEl);
    row.appendChild(delBtn);
    container.appendChild(row);
  });
}

// ─── Render: Sport ───────────────────────────────────────────
function renderSport() {
  const tbody = $('sport-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = S.selectedDay?.sport || [];
  if (!rows.length) {
    const tr = el('tr');
    tr.innerHTML = '<td colspan="5" class="no-items">Нет упражнений</td>';
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row, i) => {
    const tr = el('tr');

    const cbTd = el('td');
    const cb   = el('input');
    cb.type      = 'checkbox';
    cb.className = 'task-cb';
    cb.checked   = row.done || false;
    cb.addEventListener('change', () => {
      S.selectedDay.sport[i].done = cb.checked;
      scheduleSave();
      updateProgress();
    });
    cbTd.appendChild(cb);

    const exTd    = el('td');
    const exInput = el('input');
    exInput.className   = 'sport-input';
    exInput.value       = row.exercise || '';
    exInput.placeholder = 'Упражнение';
    exInput.addEventListener('input', () => {
      S.selectedDay.sport[i].exercise = exInput.value;
      scheduleSave();
    });
    exTd.appendChild(exInput);

    const setsTd    = el('td');
    const setsInput = el('input');
    setsInput.className   = 'sport-input';
    setsInput.value       = row.sets || '';
    setsInput.placeholder = '3';
    setsInput.style.width = '45px';
    setsInput.addEventListener('input', () => {
      S.selectedDay.sport[i].sets = setsInput.value;
      scheduleSave();
    });
    setsTd.appendChild(setsInput);

    const repsTd    = el('td');
    const repsInput = el('input');
    repsInput.className   = 'sport-input';
    repsInput.value       = row.reps || '';
    repsInput.placeholder = '10–15';
    repsInput.addEventListener('input', () => {
      S.selectedDay.sport[i].reps = repsInput.value;
      scheduleSave();
    });
    repsTd.appendChild(repsInput);

    const delTd  = el('td');
    const delBtn = el('button', 'row-del-btn', '×');
    delBtn.addEventListener('click', () => {
      S.selectedDay.sport.splice(i, 1);
      renderSport();
      scheduleSave();
      updateProgress();
    });
    delTd.appendChild(delBtn);

    tr.appendChild(cbTd);
    tr.appendChild(exTd);
    tr.appendChild(setsTd);
    tr.appendChild(repsTd);
    tr.appendChild(delTd);
    tbody.appendChild(tr);
  });
}

// ─── Render: Habits (day view) ────────────────────────────────
function renderHabitsDay() {
  const container = $('habits-day-list');
  const tagEl     = $('habits-progress-tag');
  if (!container) return;
  container.innerHTML = '';

  if (!S.habitLogs.length) {
    container.innerHTML = '<div class="no-items">Нет активных привычек. Добавьте в «Управление привычками».</div>';
    if (tagEl) tagEl.textContent = '–';
    return;
  }

  const doneCount = S.habitLogs.filter(l => l.done).length;
  if (tagEl) tagEl.textContent = `${doneCount}/${S.habitLogs.length}`;

  S.habitLogs.forEach(log => {
    const row = el('div', `habit-day-row${log.done ? ' habit-done' : ''}`);
    row.innerHTML = `
      <input type="checkbox" class="habit-cb" ${log.done ? 'checked' : ''} data-id="${log.id}">
      <span class="habit-emoji">${esc(log.emoji)}</span>
      <span class="habit-title">${esc(log.title)}</span>`;

    const cb = row.querySelector('.habit-cb');
    cb.addEventListener('change', () => toggleHabitLog(log.id, cb.checked));
    row.addEventListener('click', e => {
      if (e.target !== cb) { cb.checked = !cb.checked; toggleHabitLog(log.id, cb.checked); }
    });

    container.appendChild(row);
  });
}

// ─── Modal ───────────────────────────────────────────────────
function openModal(title, contentHtml, wideClass = '') {
  $('modal-title').textContent  = title;
  $('modal-content').innerHTML  = contentHtml;
  $('modal-box').className      = 'modal' + (wideClass ? ' ' + wideClass : '');
  $('modal-overlay').style.display = 'flex';
}
function closeModal() {
  $('modal-overlay').style.display = 'none';
  $('modal-content').innerHTML = '';
}
function handleOverlayClick(e) {
  if (e.target === $('modal-overlay')) closeModal();
}

// ─── Add Day modal ───────────────────────────────────────────
function openAddDayModal() {
  const todayStr = today();
  openModal('Добавить день', `
    <div class="modal-body">
      <div class="form-group">
        <label>Дата</label>
        <input type="date" id="new-day-date" value="${todayStr}">
      </div>
      <div class="form-group">
        <label>Заголовок (необязательно)</label>
        <input type="text" id="new-day-title" placeholder="Заголовок дня...">
      </div>
      <label class="carry-checkbox-label">
        <input type="checkbox" id="new-day-carry" checked>
        Перенести незавершённые рабочие задачи с предыдущего дня
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Отмена</button>
      <button class="btn btn-primary" onclick="confirmAddDay()">Создать</button>
    </div>`);
}

async function confirmAddDay() {
  const date  = $('new-day-date')?.value;
  const title = $('new-day-title')?.value || '';
  const carry = $('new-day-carry')?.checked !== false;
  if (!date) return;

  const existing = S.days.find(d => d.date === date);
  if (existing) { closeModal(); selectDay(date); return; }

  try {
    await POST('/api/days', {
      date,
      title,
      weekday: getWeekday(date),
      carryUnfinishedWorkTasks: carry,
    });
    await loadDays();
    closeModal();
    selectDay(date);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Import JSON ─────────────────────────────────────────────
function openImportModal() {
  openModal('Импорт дня из JSON', `
    <div class="modal-body">
      <div class="form-group">
        <label>Вставьте JSON или загрузите файл</label>
        <textarea class="import-textarea" id="import-json-area" placeholder='{"date":"2026-05-06","title":"..."}'></textarea>
      </div>
      <div>
        <input type="file" id="import-file-input" accept=".json" style="display:none">
        <button class="btn btn-ghost btn-sm" onclick="$('import-file-input').click()">📂 Загрузить файл</button>
      </div>
      <label class="carry-checkbox-label">
        <input type="checkbox" id="import-carry" checked>
        Добавить незавершённые рабочие задачи с предыдущего дня
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Отмена</button>
      <button class="btn btn-primary" onclick="confirmImport()">Импортировать</button>
    </div>`, 'modal-wide');

  $('import-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { $('import-json-area').value = ev.target.result; };
    reader.readAsText(file);
  });
}

async function confirmImport() {
  const raw   = $('import-json-area')?.value?.trim();
  const carry = $('import-carry')?.checked !== false;
  if (!raw) { toast('Введите JSON', 'error'); return; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { toast('Неверный JSON', 'error'); return; }

  if (!parsed.date) { toast('В JSON нет поля "date"', 'error'); return; }

  const existing = S.days.find(d => d.date === parsed.date);
  if (existing) {
    const confirmed = window.confirm(`День ${fmtDate(parsed.date)} уже существует. Заменить?`);
    if (!confirmed) return;
  }

  try {
    await POST('/api/days/import', {
      data: parsed,
      overwrite: true,
      carryUnfinishedWorkTasks: carry,
    });
    await loadDays();
    closeModal();
    selectDay(parsed.date);
    toast('День импортирован', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Export ──────────────────────────────────────────────────
function exportDay() {
  if (!S.selectedDate) return;
  window.location.href = `/api/days/${S.selectedDate}/export`;
}
function exportAll() {
  window.location.href = '/api/export/all';
}

// ─── Delete day ──────────────────────────────────────────────
function confirmDeleteDay() {
  if (!S.selectedDate) return;
  if (window.confirm(`Удалить день ${fmtDate(S.selectedDate)}? Это нельзя отменить.`)) {
    deleteDay(S.selectedDate);
  }
}

// ─── Habits management ────────────────────────────────────────
function openHabitsModal() { renderHabitsModalContent(); }

function renderHabitsModalContent() {
  const active   = S.habits.filter(h =>  h.is_active);
  const inactive = S.habits.filter(h => !h.is_active);

  const rows = list => list.map(h => `
    <div class="habit-mgmt-row ${h.is_active ? '' : 'habit-mgmt-inactive'}" data-id="${h.id}">
      <span class="habit-mgmt-emoji">${esc(h.emoji || '')}</span>
      <span class="habit-mgmt-title">${esc(h.title)}</span>
      <div class="habit-mgmt-actions">
        <button class="btn btn-ghost btn-xs" onclick="openEditHabitModal(${h.id})">✏️</button>
        <button class="btn btn-ghost btn-xs" onclick="toggleHabitActive(${h.id}, ${h.is_active ? 0 : 1})">${h.is_active ? '⏸' : '▶️'}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteHabit(${h.id})">🗑️</button>
      </div>
    </div>`).join('');

  openModal('Управление привычками', `
    <div class="modal-body">
      <div class="form-group">
        <label>Добавить привычку</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="new-habit-emoji" placeholder="😀" style="width:50px">
          <input type="text" id="new-habit-title" placeholder="Название привычки..." style="flex:1">
          <button class="btn btn-primary btn-sm" onclick="addHabit()">Добавить</button>
        </div>
      </div>
      <div>
        <div class="right-section-title" style="margin-bottom:6px">Активные (${active.length})</div>
        <div class="habits-mgmt-list">
          ${active.length ? rows(active) : '<div class="no-items">Нет активных привычек</div>'}
        </div>
      </div>
      ${inactive.length ? `
      <div>
        <div class="right-section-title" style="margin-bottom:6px">Неактивные (${inactive.length})</div>
        <div class="habits-mgmt-list">${rows(inactive)}</div>
      </div>` : ''}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Закрыть</button>
    </div>`, 'modal-wide');
}

async function addHabit() {
  const emoji = $('new-habit-emoji')?.value?.trim() || '';
  const title = $('new-habit-title')?.value?.trim() || '';
  if (!title) { toast('Введите название привычки', 'error'); return; }

  try {
    await POST('/api/habits', { title, emoji });
    await loadHabits();
    if (S.selectedDate) await loadHabitLogs(S.selectedDate);
    renderHabitsModalContent();
    renderHabitsDay();
    updateProgress();
    loadHabitStats();
    toast('Привычка добавлена', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleHabitActive(id, newActive) {
  try {
    await PUT(`/api/habits/${id}`, { is_active: newActive });
    await loadHabits();
    if (S.selectedDate) await loadHabitLogs(S.selectedDate);
    renderHabitsModalContent();
    renderHabitsDay();
    updateProgress();
    loadHabitStats();
  } catch (e) { toast(e.message, 'error'); }
}

function openEditHabitModal(id) {
  const habit = S.habits.find(h => h.id === id);
  if (!habit) return;

  openModal('Редактировать привычку', `
    <div class="modal-body">
      <div class="form-group">
        <label>Эмодзи</label>
        <input type="text" id="edit-habit-emoji" value="${esc(habit.emoji)}" placeholder="😀" style="width:80px">
      </div>
      <div class="form-group">
        <label>Название</label>
        <input type="text" id="edit-habit-title" value="${esc(habit.title)}" placeholder="Название...">
      </div>
      <div class="form-group">
        <label>Описание (необязательно)</label>
        <input type="text" id="edit-habit-desc" value="${esc(habit.description)}" placeholder="Описание...">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="openHabitsModal()">← Назад</button>
      <button class="btn btn-primary" onclick="saveEditHabit(${id})">Сохранить</button>
    </div>`);
}

async function saveEditHabit(id) {
  const emoji       = $('edit-habit-emoji')?.value?.trim() || '';
  const title       = $('edit-habit-title')?.value?.trim() || '';
  const description = $('edit-habit-desc')?.value?.trim()  || '';
  if (!title) { toast('Введите название', 'error'); return; }

  try {
    await PUT(`/api/habits/${id}`, { title, emoji, description });
    await loadHabits();
    if (S.selectedDate) await loadHabitLogs(S.selectedDate);
    renderHabitsModalContent();
    renderHabitsDay();
    loadHabitStats();
    toast('Привычка обновлена', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteHabit(id) {
  const habit = S.habits.find(h => h.id === id);
  if (!window.confirm(`Удалить привычку «${habit?.title}»?\nВсе записи о выполнении тоже будут удалены.`)) return;

  try {
    await DEL(`/api/habits/${id}`);
    await loadHabits();
    if (S.selectedDate) await loadHabitLogs(S.selectedDate);
    renderHabitsModalContent();
    renderHabitsDay();
    updateProgress();
    loadHabitStats();
    toast('Привычка удалена', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Print ───────────────────────────────────────────────────
function buildPrintHTML() {
  if (!S.selectedDay) return '<p>Нет данных</p>';
  const d    = S.selectedDay;
  const logs = S.habitLogs;

  const taskRows = tasks => (tasks || []).map(t => `
    <div class="p-task-row">
      <span class="p-task-box ${t.done ? 'p-task-done' : ''}"></span>
      <span class="p-task-text p-truncate ${t.done ? 'p-task-done' : ''}">${esc(t.text)}</span>
      ${t.carriedFrom ? `<span class="p-task-carried">↩ с ${esc(fmtDate(t.carriedFrom))}</span>` : ''}
    </div>`).join('');

  const scheduleRows = (d.schedule || []).map(r => `
    <tr>
      <td class="p-time-col p-truncate">${esc(r.time)}</td>
      <td class="p-truncate">${esc(r.action)}</td>
    </tr>`).join('');

  const extraRows = Array.from({ length: d.extraScheduleRows || 0 }).map(() =>
    `<tr><td class="p-time-col">&nbsp;</td><td>&nbsp;</td></tr>`
  ).join('');

  const sportRows = (d.sport || []).map(r => `
    <tr>
      <td>${esc(r.exercise)}</td>
      <td style="text-align:center">${esc(r.sets)}</td>
      <td class="p-truncate">${esc(r.reps)}</td>
      <td style="text-align:center">${r.done ? '✓' : '☐'}</td>
    </tr>`).join('');

  const habitChips = logs.map(l => `
    <div class="p-habit-chip">
      <span class="p-habit-chip-box ${l.done ? 'checked' : ''}"></span>
      <span>${esc(l.emoji)} ${esc(l.title)}</span>
    </div>`).join('');

  const notes = Array.isArray(d.notes)
    ? d.notes.filter(Boolean)
    : (d.notes ? [d.notes] : []);
  const notesRows = (notes.length ? notes : ['', '', '']).map(n =>
    `<div class="p-note-line">${esc(n)}</div>`
  ).join('');

  return `
    <div class="p-header">
      <div class="p-header-left">
        <h1>${esc(fmtDate(d.date))} — ${esc(d.title || 'План дня')}</h1>
        <div class="p-weekday">${esc(getWeekday(d.date))}</div>
      </div>
      <div class="p-header-right">
        ${d.weight ? `<div>Вес: <span class="p-weight-val">${d.weight} кг</span></div>` : ''}
        <div style="color:#666;font-size:7.5pt">NewDay</div>
      </div>
    </div>

    ${d.focus ? `<div class="p-focus-row">🎯 ${esc(d.focus)}</div>` : ''}

    ${(d.schedule?.length || d.extraScheduleRows) ? `
    <div class="p-section">
      <div class="p-section-title">Расписание</div>
      <table class="p-table">
        <thead><tr><th style="width:22mm">Время</th><th>Действие</th></tr></thead>
        <tbody>${scheduleRows}${extraRows}</tbody>
      </table>
    </div>` : ''}

    ${(d.workTasks?.length || d.homeTasks?.length) ? `
    <div class="p-section p-two-col">
      ${d.workTasks?.length ? `<div><div class="p-section-title">Работа</div>${taskRows(d.workTasks)}</div>` : '<div></div>'}
      ${d.homeTasks?.length ? `<div><div class="p-section-title">Дом / Питание</div>${taskRows(d.homeTasks)}</div>` : '<div></div>'}
    </div>` : ''}

    ${d.sport?.length ? `
    <div class="p-section">
      <div class="p-section-title">Спорт</div>
      <table class="p-table">
        <thead><tr><th>Упражнение</th><th style="width:12mm;text-align:center">Подх.</th><th>Повторения</th><th style="width:8mm;text-align:center">✓</th></tr></thead>
        <tbody>${sportRows}</tbody>
      </table>
    </div>` : ''}

    ${logs.length ? `
    <div class="p-section">
      <div class="p-section-title">Привычки</div>
      <div class="p-habit-grid">${habitChips}</div>
    </div>` : ''}

    <div class="p-section">
      <div class="p-section-title">Заметки</div>
      <div class="p-notes-lines">${notesRows}</div>
    </div>`;
}

function autoDensity(el) {
  el.className = 'density-normal';
  if (el.scrollHeight <= el.clientHeight + 4) return;
  el.className = 'density-compact';
  if (el.scrollHeight <= el.clientHeight + 4) return;
  el.className = 'density-ultra';
  if (el.scrollHeight <= el.clientHeight + 4) return;
  el.className = 'density-ultra truncate-mode';
}

function openPrintPreview() {
  if (!S.selectedDay) { toast('Выберите день', 'error'); return; }

  const html = buildPrintHTML();
  openModal(`Печать: ${fmtDate(S.selectedDate)}`, `
    <div class="print-preview-wrap">
      <div id="print-body-preview">${html}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Закрыть</button>
      <button class="btn btn-primary" onclick="doPrint()">🖨️ Печать / PDF</button>
    </div>`, 'modal-wide');

  const prev = $('print-body-preview');
  if (prev) requestAnimationFrame(() => autoDensity(prev));
}

function doPrint() {
  if (!S.selectedDay) return;
  const html = buildPrintHTML();
  const body = $('print-body');
  body.innerHTML = html;
  autoDensity(body);
  closeModal();
  setTimeout(() => window.print(), 100);
}

// ─── Keyboard shortcuts ──────────────────────────────────────
function handleKeydown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === 'p' || e.key === 'P') { e.preventDefault(); openPrintPreview(); }
}

// ─── Field event listeners ────────────────────────────────────
function setupFieldListeners() {
  $('day-title')?.addEventListener('input', e => {
    if (S.selectedDay) { S.selectedDay.title = e.target.value; scheduleSave(); }
  });
  $('day-focus')?.addEventListener('input', e => {
    if (S.selectedDay) { S.selectedDay.focus = e.target.value; scheduleSave(); }
  });
  $('day-weight')?.addEventListener('change', e => {
    if (S.selectedDay) {
      const v = parseFloat(e.target.value);
      S.selectedDay.weight = isNaN(v) ? null : v;
      renderWeightChange();
      const item = S.days.find(d => d.date === S.selectedDate);
      if (item) item.weight = S.selectedDay.weight;
      renderDaysList();
      const sideItem = document.querySelector(`.day-item[data-date="${S.selectedDate}"]`);
      if (sideItem) sideItem.classList.add('active');
      scheduleSave();
      renderWeightHistory();
    }
  });
  $('day-notes')?.addEventListener('input', e => {
    if (S.selectedDay) { S.selectedDay.notes = e.target.value.split('\n'); scheduleSave(); }
  });

  $('btn-add-schedule')?.addEventListener('click', () => {
    if (!S.selectedDay) return;
    if (!S.selectedDay.schedule) S.selectedDay.schedule = [];
    S.selectedDay.schedule.push({ time: '', action: '' });
    renderSchedule();
    const rows = $('schedule-tbody')?.querySelectorAll('tr');
    if (rows?.length) rows[rows.length - 1].querySelector('input')?.focus();
    scheduleSave();
  });

  $('btn-add-work-task')?.addEventListener('click', () => {
    if (!S.selectedDay) return;
    if (!S.selectedDay.workTasks) S.selectedDay.workTasks = [];
    S.selectedDay.workTasks.push({ text: '', done: false });
    renderTaskList('work-tasks-list', S.selectedDay.workTasks, 'workTasks');
    const inputs = $('work-tasks-list')?.querySelectorAll('.task-text-input');
    if (inputs?.length) inputs[inputs.length - 1].focus();
    scheduleSave();
  });

  $('btn-add-home-task')?.addEventListener('click', () => {
    if (!S.selectedDay) return;
    if (!S.selectedDay.homeTasks) S.selectedDay.homeTasks = [];
    S.selectedDay.homeTasks.push({ text: '', done: false });
    renderTaskList('home-tasks-list', S.selectedDay.homeTasks, 'homeTasks');
    const inputs = $('home-tasks-list')?.querySelectorAll('.task-text-input');
    if (inputs?.length) inputs[inputs.length - 1].focus();
    scheduleSave();
  });

  $('btn-add-sport')?.addEventListener('click', () => {
    if (!S.selectedDay) return;
    if (!S.selectedDay.sport) S.selectedDay.sport = [];
    S.selectedDay.sport.push({ exercise: '', sets: '', reps: '', done: false });
    renderSport();
    scheduleSave();
  });
}

// ─── Button event listeners ───────────────────────────────────
function setupButtonListeners() {
  $('btn-logout')?.addEventListener('click', logout);
  $('btn-add-day')?.addEventListener('click', openAddDayModal);
  $('btn-add-day-2')?.addEventListener('click', openAddDayModal);
  $('btn-import-json')?.addEventListener('click', openImportModal);
  $('btn-export-all')?.addEventListener('click', exportAll);
  $('btn-print-day')?.addEventListener('click', openPrintPreview);
  $('btn-print-day-2')?.addEventListener('click', openPrintPreview);
  $('btn-export-day')?.addEventListener('click', exportDay);
  $('btn-delete-day')?.addEventListener('click', confirmDeleteDay);
  $('btn-manage-habits')?.addEventListener('click', openHabitsModal);
  document.addEventListener('keydown', handleKeydown);
}

// ============================================================
//  MOBILE FUNCTIONS
// ============================================================

// ─── FAB sheet ───────────────────────────────────────────────
function openFabSheet()  { $('fab-sheet-overlay').style.display = 'flex'; }
function closeFabSheet() { $('fab-sheet-overlay').style.display = 'none'; }

function addWorkTaskFab() {
  if (!S.selectedDay) { toast('Выберите день', 'error'); return; }
  if (!S.selectedDay.workTasks) S.selectedDay.workTasks = [];
  S.selectedDay.workTasks.push({ text: '', done: false });
  scheduleSave();
  setTab('plan');
  renderMobilePlan();
}

function addScheduleRowFab() {
  if (!S.selectedDay) { toast('Выберите день', 'error'); return; }
  if (!S.selectedDay.schedule) S.selectedDay.schedule = [];
  S.selectedDay.schedule.push({ time: '', action: '' });
  scheduleSave();
  setTab('plan');
  renderMobilePlan();
}

// ─── Tab navigation ──────────────────────────────────────────
function setTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.bottom-nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.mobile-panel').forEach(p => p.classList.remove('active'));
  const panel = $('tab-' + tab);
  if (panel) panel.classList.add('active');
  renderActiveMobileTab();
}

function renderActiveMobileTab() {
  switch (S.activeTab) {
    case 'today':    renderMobileToday();    break;
    case 'plan':     renderMobilePlan();     break;
    case 'habits':   renderMobileHabitsTab(); break;
    case 'progress': renderMobileProgress(); break;
    case 'more':     renderMobileMore();     break;
  }
}

// ─── Mobile header ───────────────────────────────────────────
function renderMobileHeader() {
  const el = $('mh-date-info');
  if (!el) return;
  const todayStr = today();
  const d = S.selectedDay;
  if (!d) {
    el.textContent = fmtDate(todayStr) + ' · ' + getWeekday(todayStr);
    return;
  }
  const workPct  = calcPct(d.workTasks);
  const habitPct = S.habitLogs.length ? calcPct(S.habitLogs) : null;
  const parts    = [workPct, habitPct].filter(x => x !== null);
  const dayPct   = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
  el.innerHTML = `${fmtDate(d.date)} · ${getWeekday(d.date)}${dayPct !== null ? ` · <strong>${dayPct}%</strong>` : ''}`;
}

// ─── Mini SVG circle helper ───────────────────────────────────
function miniCircleSVG(pct, color, size = 64) {
  const r = 15.9;
  const p = pct !== null ? Math.min(100, Math.max(0, pct)) : 0;
  const label = pct !== null ? p + '%' : '–';
  return `
    <div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
      <svg width="${size}" height="${size}" viewBox="0 0 36 36" style="transform:rotate(-90deg)">
        <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--border)" stroke-width="4"/>
        <circle cx="18" cy="18" r="${r}" fill="none" stroke="${color || 'var(--accent)'}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${p} ${100 - p}" style="transition:stroke-dasharray .5s ease"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;color:var(--text)">${label}</div>
    </div>`;
}

// ─── renderMobileToday ───────────────────────────────────────
function renderMobileToday() {
  const panel = $('tab-today');
  if (!panel) return;

  if (!S.selectedDay) {
    panel.innerHTML = `
      <div class="mobile-empty">
        <div class="mobile-empty-icon">📅</div>
        <div>Нет выбранного дня</div>
        <button class="btn btn-primary" onclick="openAddDayModal()">Добавить день</button>
      </div>`;
    return;
  }

  const d = S.selectedDay;
  const workPct  = calcPct(d.workTasks);
  const homePct  = calcPct(d.homeTasks);
  const sportPct = calcPct(d.sport);
  const habitPct = S.habitLogs.length ? calcPct(S.habitLogs) : null;
  const allParts = [workPct, homePct, sportPct, habitPct].filter(x => x !== null);
  const dayPct   = allParts.length ? Math.round(allParts.reduce((a, b) => a + b, 0) / allParts.length) : null;

  // Progress bars row
  function barRow(label, pct) {
    const val = pct !== null ? pct + '%' : '–';
    const w   = pct !== null ? pct : 0;
    return `
      <div class="mt-bar-row">
        <span>${label}</span>
        <div class="progress-bar"><div class="progress-fill" style="width:${w}%"></div></div>
        <span>${val}</span>
      </div>`;
  }

  // First 6 habits
  const habitsToShow = S.habitLogs.slice(0, 6);
  const habitsHTML = habitsToShow.length
    ? habitsToShow.map(log => {
        const checkedCls = log.done ? ' checked' : '';
        const doneCls    = log.done ? ' done' : '';
        return `
          <div class="mt-habit-row${doneCls}" onclick="toggleHabitLog(${log.id}, ${!log.done})">
            <div class="mt-habit-cb${checkedCls}">${log.done ? '✓' : ''}</div>
            <span class="mt-habit-emoji">${esc(log.emoji)}</span>
            <span class="mt-habit-title">${esc(log.title)}</span>
          </div>`;
      }).join('')
    : '<div class="no-items">Нет привычек</div>';

  const moreHabitsLink = S.habitLogs.length > 6
    ? `<div class="mt-more-link" onclick="setTab('habits')">Все привычки (${S.habitLogs.length}) →</div>`
    : '';

  // First 5 work tasks
  const workTasks = (d.workTasks || []).slice(0, 5);
  const workHTML = workTasks.length
    ? workTasks.map((t, i) => {
        const doneCls = t.done ? ' done-text' : '';
        return `
          <div class="mt-habit-row${t.done ? ' done' : ''}" onclick="mpUpdateTaskDone('workTasks', ${i}, ${!t.done})">
            <div class="mt-habit-cb${t.done ? ' checked' : ''}">${t.done ? '✓' : ''}</div>
            <span class="mt-habit-title${doneCls}">${esc(t.text || '(без текста)')}</span>
          </div>`;
      }).join('')
    : '<div class="no-items">Нет задач</div>';

  const moreWorkLink = (d.workTasks || []).length > 5
    ? `<div class="mt-more-link" onclick="setTab('plan')">Все задачи (${d.workTasks.length}) →</div>`
    : '';

  // First 4 schedule items
  const schedItems = (d.schedule || []).slice(0, 4);
  const schedHTML = schedItems.length
    ? `<div class="mobile-schedule-list">${schedItems.map(r => `
        <div class="mobile-schedule-item">
          <span class="msi-time">${esc(r.time)}</span>
          <span class="msi-action">${esc(r.action)}</span>
        </div>`).join('')}</div>`
    : '<div class="no-items">Нет расписания</div>';

  const moreSchedLink = (d.schedule || []).length > 4
    ? `<div class="mt-more-link" onclick="setTab('plan')">Всё расписание →</div>`
    : '';

  panel.innerHTML = `
    <div class="mobile-today-content">

      <!-- Date card -->
      <div class="card mt-date-card">
        <div class="mt-date">${fmtDate(d.date)} — ${getWeekday(d.date)}</div>
        ${d.weight ? `<div class="mt-weight">${d.weight} кг</div>` : ''}
        ${d.focus  ? `<div class="mt-focus">${esc(d.focus)}</div>` : ''}
      </div>

      <!-- Progress card -->
      <div class="card">
        <div class="section-title" style="margin-bottom:10px">Прогресс</div>
        <div class="mt-progress-row">
          ${miniCircleSVG(dayPct, 'var(--accent)', 64)}
          <div class="mt-progress-bars">
            ${barRow('Работа', workPct)}
            ${barRow('Дом', homePct)}
            ${barRow('Спорт', sportPct)}
            ${barRow('Привычки', habitPct)}
          </div>
        </div>
      </div>

      <!-- Habits card -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">Привычки</div>
          <span style="font-size:.8rem;color:var(--muted)">${S.habitLogs.filter(l=>l.done).length}/${S.habitLogs.length}</span>
        </div>
        <div class="mt-habits-list">${habitsHTML}</div>
        ${moreHabitsLink}
      </div>

      <!-- Work tasks card -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">Работа</div>
          <span style="font-size:.8rem;color:var(--muted)">${(d.workTasks||[]).filter(t=>t.done).length}/${(d.workTasks||[]).length}</span>
        </div>
        <div class="mt-habits-list">${workHTML}</div>
        ${moreWorkLink}
      </div>

      <!-- Schedule card -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">Расписание</div>
        </div>
        ${schedHTML}
        ${moreSchedLink}
        <div class="mt-more-link" onclick="setTab('plan')">Редактировать →</div>
      </div>

    </div>`;

  renderMobileHeader();
}

// ─── renderMobilePlan ────────────────────────────────────────
function renderMobilePlan() {
  const panel = $('tab-plan');
  if (!panel) return;

  if (!S.selectedDay) {
    if (!S.days.length) {
      panel.innerHTML = `
        <div class="mobile-empty">
          <div class="mobile-empty-icon">📅</div>
          <div>Нет дней</div>
          <button class="btn btn-primary" onclick="openAddDayModal()">Создать день</button>
        </div>`;
      return;
    }
    // Show days list for selection
    panel.innerHTML = `
      <div class="card" style="margin-bottom:10px">
        <div class="section-title" style="margin-bottom:10px">Выберите день</div>
        <div class="mt-habits-list">
          ${S.days.map(d => `
            <div class="mt-habit-row" onclick="selectDay('${d.date}')">
              <span class="mt-habit-title">${fmtDate(d.date)} — ${esc(d.title || '(без заголовка)')}</span>
            </div>`).join('')}
        </div>
      </div>
      <button class="btn btn-primary btn-block" onclick="openAddDayModal()">Добавить день</button>`;
    return;
  }

  const d = S.selectedDay;

  // Schedule rows
  const schedRows = (d.schedule || []).map((row, i) => `
    <div class="mobile-schedule-item">
      <input class="msi-time-input" value="${esc(row.time)}" placeholder="00:00–00:00"
        onblur="mpUpdateScheduleTime(${i}, this.value)"
        oninput="if(S.selectedDay?.schedule?.[${i}]!==undefined){S.selectedDay.schedule[${i}].time=this.value;scheduleSave();}">
      <input class="msi-action-input" value="${esc(row.action)}" placeholder="Действие..."
        oninput="mpUpdateScheduleAction(${i}, this.value)">
      <button class="row-del-btn" style="opacity:1" onclick="mpDeleteScheduleRow(${i})">×</button>
    </div>`).join('');

  // Work tasks
  const workRows = (d.workTasks || []).map((t, i) => `
    <div class="mobile-task-row">
      <input type="checkbox" class="mobile-cb" ${t.done ? 'checked' : ''}
        onchange="mpUpdateTaskDone('workTasks', ${i}, this.checked)">
      <input type="text" class="mobile-task-text${t.done ? ' done-text' : ''}" value="${esc(t.text)}" placeholder="Задача..."
        oninput="mpUpdateTaskText('workTasks', ${i}, this.value)">
      <button class="row-del-btn" style="opacity:1" onclick="mpDeleteTask('workTasks', ${i})">×</button>
    </div>`).join('');

  // Home tasks
  const homeRows = (d.homeTasks || []).map((t, i) => `
    <div class="mobile-task-row">
      <input type="checkbox" class="mobile-cb" ${t.done ? 'checked' : ''}
        onchange="mpUpdateTaskDone('homeTasks', ${i}, this.checked)">
      <input type="text" class="mobile-task-text${t.done ? ' done-text' : ''}" value="${esc(t.text)}" placeholder="Задача..."
        oninput="mpUpdateTaskText('homeTasks', ${i}, this.value)">
      <button class="row-del-btn" style="opacity:1" onclick="mpDeleteTask('homeTasks', ${i})">×</button>
    </div>`).join('');

  // Sport rows
  const sportRows = (d.sport || []).map((row, i) => `
    <div class="mobile-sport-row">
      <input type="checkbox" class="mobile-cb" ${row.done ? 'checked' : ''}
        onchange="mpUpdateSportDone(${i}, this.checked)">
      <div class="mobile-sport-inputs">
        <input class="mobile-sport-name-input" value="${esc(row.exercise)}" placeholder="Упражнение..."
          oninput="mpUpdateSportField(${i}, 'exercise', this.value)">
        <div class="mobile-sport-meta">
          <div class="mobile-sport-meta-field">
            <span class="mobile-sport-meta-label">Подх.</span>
            <input class="mobile-sport-meta-input" value="${esc(row.sets)}" placeholder="3"
              oninput="mpUpdateSportField(${i}, 'sets', this.value)">
          </div>
          <div class="mobile-sport-meta-field">
            <span class="mobile-sport-meta-label">Повторения</span>
            <input class="mobile-sport-meta-input" style="width:90px" value="${esc(row.reps)}" placeholder="10–15"
              oninput="mpUpdateSportField(${i}, 'reps', this.value)">
          </div>
        </div>
      </div>
      <button class="row-del-btn" style="opacity:1" onclick="mpDeleteSport(${i})">×</button>
    </div>`).join('');

  const notesVal = Array.isArray(d.notes) ? d.notes.join('\n') : (d.notes || '');

  panel.innerHTML = `
    <div class="mobile-plan-content">

      <!-- Day header card -->
      <div class="card">
        <div class="section-title" style="margin-bottom:10px">
          ${fmtDate(d.date)} — ${getWeekday(d.date)}
        </div>
        <input class="mobile-day-title-input" value="${esc(d.title || '')}" placeholder="Заголовок дня..."
          oninput="mpUpdateTitle(this.value)">
        <div class="mobile-field-row">
          <span class="mobile-field-label">Фокус:</span>
          <input class="mobile-field-input" value="${esc(d.focus || '')}" placeholder="Фокус дня..."
            oninput="mpUpdateFocus(this.value)">
        </div>
        <div class="mobile-field-row">
          <span class="mobile-field-label">Вес (кг):</span>
          <input class="mobile-field-input" type="number" step="0.1" value="${d.weight ?? ''}" placeholder="–"
            onchange="mpUpdateWeight(this.value)">
        </div>
      </div>

      <!-- Schedule card -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">🕐 Расписание</div>
          <button class="btn btn-ghost btn-xs" onclick="mpAddScheduleRow()">+ Строка</button>
        </div>
        <div class="mobile-schedule-list">
          ${schedRows || '<div class="no-items">Нет строк</div>'}
        </div>
      </div>

      <!-- Work tasks card -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">💼 Работа</div>
          <button class="btn btn-ghost btn-xs" onclick="mpAddWorkTask()">+ Задача</button>
        </div>
        ${workRows || '<div class="no-items">Нет задач</div>'}
      </div>

      <!-- Home tasks card -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">🏠 Дом / Питание</div>
          <button class="btn btn-ghost btn-xs" onclick="mpAddHomeTask()">+ Задача</button>
        </div>
        ${homeRows || '<div class="no-items">Нет задач</div>'}
      </div>

      <!-- Sport card -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">🏋️ Спорт</div>
          <button class="btn btn-ghost btn-xs" onclick="mpAddSport()">+ Упражнение</button>
        </div>
        ${sportRows || '<div class="no-items">Нет упражнений</div>'}
      </div>

      <!-- Notes card -->
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">📝 Заметки</div>
        <textarea class="mobile-notes-textarea" placeholder="Заметки дня..."
          oninput="mpUpdateNotes(this.value)">${esc(notesVal)}</textarea>
      </div>

      <!-- Danger zone -->
      <div style="margin-top:4px">
        <button class="btn btn-danger btn-block" onclick="confirmDeleteDay()">🗑️ Удалить день</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-ghost" style="flex:1" onclick="exportDay()">📤 Экспорт дня</button>
        <button class="btn btn-ghost" style="flex:1" onclick="openPrintPreview()">🖨️ Печать</button>
      </div>

    </div>`;
}

// ─── renderMobileHabitsTab ────────────────────────────────────
function renderMobileHabitsTab() {
  const panel = $('tab-habits');
  if (!panel) return;

  // Quick check section
  const habitsCheckHTML = S.habitLogs.length
    ? S.habitLogs.map(log => {
        const checkedCls = log.done ? ' checked' : '';
        const doneCls    = log.done ? ' done' : '';
        return `
          <div class="mt-habit-row${doneCls}" onclick="toggleHabitLog(${log.id}, ${!log.done})">
            <div class="mt-habit-cb${checkedCls}">${log.done ? '✓' : ''}</div>
            <span class="mt-habit-emoji">${esc(log.emoji)}</span>
            <span class="mt-habit-title">${esc(log.title)}</span>
          </div>`;
      }).join('')
    : '<div class="no-items">Нет активных привычек</div>';

  // If no full stats yet, start loading
  if (!S.habitStatsFull) {
    loadHabitStatsFull(S.habitStatsPeriod).then(() => {
      if (S.activeTab === 'habits') renderMobileHabitsTab();
    });
  }

  const sf = S.habitStatsFull;
  const p  = S.habitStatsPeriod;

  // Overall section
  let overallHTML = '<div class="no-items">Загрузка статистики...</div>';
  let habitCardsHTML = '';

  if (sf) {
    const ov = sf.overall || {};
    overallHTML = `
      <div style="text-align:center;padding:8px 0">
        <div class="overall-pct-big">${ov.percent ?? 0}%</div>
        <div class="overall-stats-row">
          <div class="overall-stat"><div class="os-val">${ov.doneCount ?? 0}</div><div class="os-label">выполнено</div></div>
          <div class="overall-stat"><div class="os-val">${ov.possibleCount ?? 0}</div><div class="os-label">возможно</div></div>
          <div class="overall-stat"><div class="os-val">${ov.activeHabits ?? 0}</div><div class="os-label">привычек</div></div>
        </div>
      </div>`;

    habitCardsHTML = (sf.habits || []).map(h => {
      const pct = h.percentPeriod ?? 0;
      const dotsHTML = (h.last7 || []).map(d => `
        <span class="hd-dot ${d.done ? 'done' : 'missed'}"></span>
      `).join('');

      const pct7   = h.percent7  !== null ? h.percent7  + '%' : '–';
      const pct30  = h.percent30 !== null ? h.percent30 + '%' : '–';
      const pctAll = h.percentAll !== null ? h.percentAll + '%' : '–';

      return `
        <div class="habit-stat-card">
          <div class="hsc-head">
            <div>
              <div class="hsc-name">${esc(h.emoji)} ${esc(h.title)}</div>
              <div class="hsc-streak-row">
                <span>🔥 серия: <span class="hsc-streak-val">${h.currentStreak}</span></span>
                <span>🏆 рекорд: <span class="hsc-streak-val">${h.bestStreak}</span></span>
              </div>
            </div>
            <div style="font-size:1rem;font-weight:700;color:var(--accent)">${pct}%</div>
          </div>
          <div class="hsc-bar-row">
            <div class="progress-bar" style="flex:1"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="hsc-pct">${pct}%</span>
          </div>
          <div class="hsc-meta">
            <span>7д: ${pct7}</span>
            <span>30д: ${pct30}</span>
            <span>Всё: ${pctAll}</span>
            <span>✓${h.doneTotal} ✗${h.missedTotal}</span>
          </div>
          <div class="habit-dots">${dotsHTML}</div>
        </div>`;
    }).join('');
  }

  const periodBtns = ['7', '30', 'all'].map(val => {
    const label = val === 'all' ? 'Всё' : val + 'д';
    return `<button class="period-btn${S.habitStatsPeriod === val ? ' active' : ''}"
      onclick="S.habitStatsFull=null;S.habitStatsPeriod='${val}';renderMobileHabitsTab();loadHabitStatsFull('${val}').then(()=>renderMobileHabitsTab())"
    >${label}</button>`;
  }).join('');

  panel.innerHTML = `
    <div class="mobile-habits-content">

      <!-- Today check -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title">Сегодня — ${fmtDate(S.selectedDate || today())}</div>
          <span style="font-size:.8rem;color:var(--muted)">${S.habitLogs.filter(l=>l.done).length}/${S.habitLogs.length}</span>
        </div>
        <div class="mt-habits-list">${habitsCheckHTML}</div>
      </div>

      <!-- Period picker -->
      <div class="card">
        <div class="section-title" style="margin-bottom:10px">Статистика</div>
        <div class="period-picker">${periodBtns}</div>
        ${overallHTML}
      </div>

      <!-- Habit cards -->
      ${habitCardsHTML}

      <!-- Manage button -->
      <button class="btn btn-ghost btn-block" onclick="openHabitsModal()">⚙️ Управление привычками</button>

    </div>`;
}

// ─── loadHabitStatsFull ──────────────────────────────────────
async function loadHabitStatsFull(period) {
  S.habitStatsPeriod = period || S.habitStatsPeriod;
  S.habitStatsFull = await GET('/api/habits/stats?period=' + S.habitStatsPeriod).catch(() => null);
}

// ─── renderMobileProgress ────────────────────────────────────
function renderMobileProgress() {
  const panel = $('tab-progress');
  if (!panel) return;

  const d = S.selectedDay;
  const workPct  = d ? calcPct(d.workTasks)  : null;
  const homePct  = d ? calcPct(d.homeTasks)  : null;
  const sportPct = d ? calcPct(d.sport)      : null;
  const habitPct = S.habitLogs.length ? calcPct(S.habitLogs) : null;
  const allParts = [workPct, homePct, sportPct, habitPct].filter(x => x !== null);
  const dayPct   = allParts.length ? Math.round(allParts.reduce((a, b) => a + b, 0) / allParts.length) : null;

  // Day circles
  const circlesHTML = `
    <div class="mp-circles-grid">
      <div class="mp-circle-item">${miniCircleSVG(dayPct, 'var(--accent)', 56)}<div class="progress-label">День</div></div>
      <div class="mp-circle-item">${miniCircleSVG(workPct, 'var(--accent)', 56)}<div class="progress-label">Работа</div></div>
      <div class="mp-circle-item">${miniCircleSVG(homePct, 'var(--success)', 56)}<div class="progress-label">Дом</div></div>
      <div class="mp-circle-item">${miniCircleSVG(sportPct, 'var(--warning)', 56)}<div class="progress-label">Спорт</div></div>
      <div class="mp-circle-item">${miniCircleSVG(habitPct, 'var(--accent)', 56)}<div class="progress-label">Привычки</div></div>
    </div>`;

  // Habit period pcts
  const sf = S.habitStatsFull;
  let habitPeriodHTML = '<div class="no-items">Загрузка...</div>';
  let habitRatingHTML = '';
  let summaryHTML = '';

  if (!sf) {
    loadHabitStatsFull(S.habitStatsPeriod).then(() => {
      if (S.activeTab === 'progress') renderMobileProgress();
    });
  } else {
    const pctCards = [
      { label: '7 дней',  val: sf.overall?.percent ?? 0 },
      { label: '30 дней', val: sf.overall?.percent ?? 0 },
      { label: 'За всё',  val: sf.overall?.percent ?? 0 },
    ];

    // Actually show per-period using habits[0] if possible
    const habitsArr = sf.habits || [];
    const avg7  = habitsArr.length ? Math.round(habitsArr.filter(h=>h.percent7!==null).reduce((s,h)=>s+(h.percent7||0),0) / (habitsArr.filter(h=>h.percent7!==null).length || 1)) : 0;
    const avg30 = habitsArr.length ? Math.round(habitsArr.filter(h=>h.percent30!==null).reduce((s,h)=>s+(h.percent30||0),0) / (habitsArr.filter(h=>h.percent30!==null).length || 1)) : 0;
    const avgAll= habitsArr.length ? Math.round(habitsArr.filter(h=>h.percentAll!==null).reduce((s,h)=>s+(h.percentAll||0),0) / (habitsArr.filter(h=>h.percentAll!==null).length || 1)) : 0;

    habitPeriodHTML = `
      <div class="mp-pct-cards">
        <div class="mp-pct-card"><div class="mp-pct-val">${avg7}%</div><div class="mp-pct-label">7 дней</div></div>
        <div class="mp-pct-card"><div class="mp-pct-val">${avg30}%</div><div class="mp-pct-label">30 дней</div></div>
        <div class="mp-pct-card"><div class="mp-pct-val">${avgAll}%</div><div class="mp-pct-label">За всё время</div></div>
      </div>`;

    // Rating list (sorted best to worst by period)
    const sorted = [...habitsArr].sort((a, b) => (b.percentPeriod ?? 0) - (a.percentPeriod ?? 0));
    habitRatingHTML = sorted.map(h => {
      const pct = h.percentPeriod ?? 0;
      return `
        <div class="mp-habit-bar-row">
          <span class="mp-habit-bar-name">${esc(h.emoji)} ${esc(h.title)}</span>
          <div class="progress-bar" style="width:70px;flex-shrink:0"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="mp-habit-bar-pct">${pct}%</span>
        </div>`;
    }).join('');

    // Summary
    const sm = sf.summary || {};
    const parts = [];
    if (sm.bestHabit)    parts.push(`🏆 Лучшая: ${esc(sm.bestHabit.emoji)} ${esc(sm.bestHabit.title)} (${sm.bestHabit.percent}%)`);
    if (sm.weakestHabit) parts.push(`⚠️ Слабейшая: ${esc(sm.weakestHabit.emoji)} ${esc(sm.weakestHabit.title)} (${sm.weakestHabit.percent}%)`);
    if (sm.habitsAbove70 != null) parts.push(`✅ Хороших привычек (≥70%): ${sm.habitsAbove70}`);
    if (sm.habitsBelow40 != null) parts.push(`❗ Слабых привычек (&lt;40%): ${sm.habitsBelow40}`);
    summaryHTML = parts.length ? `<div class="mp-summary-text">${parts.join('<br>')}</div>` : '';
  }

  // Weight list
  const withWeight = S.days.filter(d => d.weight != null).slice(0, 7);
  const weightListHTML = withWeight.length
    ? withWeight.map(d => `
        <div class="mp-weight-row">
          <span class="mp-weight-date">${fmtDate(d.date)}</span>
          <span class="mp-weight-val">${d.weight} кг</span>
        </div>`).join('')
    : '<div class="no-items">Нет данных о весе</div>';

  panel.innerHTML = `
    <div class="mobile-progress-content">

      <!-- Day progress circles -->
      <div class="card">
        <div class="section-title" style="margin-bottom:10px">Прогресс дня</div>
        ${circlesHTML}
      </div>

      <!-- Habit period pcts -->
      <div class="card">
        <div class="section-title" style="margin-bottom:10px">Привычки по периодам</div>
        ${habitPeriodHTML}
      </div>

      ${habitRatingHTML ? `
      <!-- Habit rating -->
      <div class="card">
        <div class="section-title" style="margin-bottom:10px">Рейтинг привычек</div>
        ${habitRatingHTML}
      </div>` : ''}

      <!-- Weight -->
      <div class="card">
        <div class="section-title" style="margin-bottom:10px">Вес</div>
        <div class="mp-weight-list">${weightListHTML}</div>
      </div>

      ${summaryHTML ? `
      <!-- Summary -->
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">Итоги</div>
        ${summaryHTML}
      </div>` : ''}

    </div>`;
}

// ─── renderMobileMore ────────────────────────────────────────
function renderMobileMore() {
  const panel = $('tab-more');
  if (!panel) return;

  const username = S.user?.username || '...';

  panel.innerHTML = `
    <div class="mobile-more-content">

      <!-- User info -->
      <div class="more-user-section">
        <div class="more-user-avatar">👤</div>
        <div>
          <div class="more-username">${esc(username)}</div>
          <div style="font-size:.8rem;color:var(--muted)">NewDay</div>
        </div>
      </div>

      <!-- Actions list -->
      <div class="more-actions-list">
        <button class="more-action-item" onclick="openAddDayModal()">
          <span class="more-action-icon">📅</span> Добавить день
        </button>
        <button class="more-action-item" onclick="openImportModal()">
          <span class="more-action-icon">📥</span> Импорт JSON
        </button>
        <button class="more-action-item" onclick="exportDay()">
          <span class="more-action-icon">📤</span> Экспорт текущего дня
        </button>
        <button class="more-action-item" onclick="exportAll()">
          <span class="more-action-icon">📤</span> Экспорт базы
        </button>
        <button class="more-action-item" onclick="openPrintPreview()">
          <span class="more-action-icon">🖨️</span> Печать дня
        </button>
        <button class="more-action-item" onclick="window.location.href='/install.html'">
          <span class="more-action-icon">📱</span> Установить Android
        </button>
        <button class="more-action-item" onclick="openHabitsModal()">
          <span class="more-action-icon">⚙️</span> Управление привычками
        </button>
        <button class="more-action-item danger" onclick="logout()">
          <span class="more-action-icon">🚪</span> Выйти
        </button>
      </div>

    </div>`;
}

// ─── Mobile edit helpers ──────────────────────────────────────
function mpUpdateTitle(val) {
  if (S.selectedDay) { S.selectedDay.title = val; scheduleSave(); }
}
function mpUpdateFocus(val) {
  if (S.selectedDay) { S.selectedDay.focus = val; scheduleSave(); }
}
function mpUpdateWeight(val) {
  if (S.selectedDay) {
    S.selectedDay.weight = parseFloat(val) || null;
    scheduleSave();
    renderMobileHeader();
    const item = S.days.find(d => d.date === S.selectedDate);
    if (item) item.weight = S.selectedDay.weight;
  }
}
function mpUpdateNotes(val) {
  if (S.selectedDay) { S.selectedDay.notes = val.split('\n'); scheduleSave(); }
}
function mpUpdateScheduleTime(idx, val) {
  if (!S.selectedDay?.schedule?.[idx] === undefined) return;
  const norm = normalizeTimeRange(val);
  S.selectedDay.schedule[idx].time = norm.ok ? norm.display : val;
  if (norm.ok) S.selectedDay.schedule = sortSchedule(S.selectedDay.schedule);
  scheduleSave();
  renderMobilePlan();
}
function mpUpdateScheduleAction(idx, val) {
  if (S.selectedDay?.schedule?.[idx] !== undefined) {
    S.selectedDay.schedule[idx].action = val;
    scheduleSave();
  }
}
function mpDeleteScheduleRow(idx) {
  if (!S.selectedDay?.schedule) return;
  S.selectedDay.schedule.splice(idx, 1);
  renderMobilePlan();
  scheduleSave();
}
function mpAddScheduleRow() {
  if (!S.selectedDay) return;
  if (!S.selectedDay.schedule) S.selectedDay.schedule = [];
  S.selectedDay.schedule.push({ time: '', action: '' });
  renderMobilePlan();
  scheduleSave();
}
function mpUpdateTaskDone(field, idx, done) {
  if (!S.selectedDay?.[field] || S.selectedDay[field][idx] === undefined) return;
  S.selectedDay[field][idx].done = done;
  scheduleSave();
  updateProgress();
  if (S.activeTab === 'today') renderMobileToday();
  else renderMobilePlan();
}
function mpUpdateTaskText(field, idx, text) {
  if (S.selectedDay?.[field]?.[idx] !== undefined) {
    S.selectedDay[field][idx].text = text;
    scheduleSave();
  }
}
function mpDeleteTask(field, idx) {
  if (!S.selectedDay?.[field]) return;
  S.selectedDay[field].splice(idx, 1);
  renderMobilePlan();
  scheduleSave();
  updateProgress();
}
function mpAddWorkTask() {
  if (!S.selectedDay) return;
  if (!S.selectedDay.workTasks) S.selectedDay.workTasks = [];
  S.selectedDay.workTasks.push({ text: '', done: false });
  renderMobilePlan();
  scheduleSave();
}
function mpAddHomeTask() {
  if (!S.selectedDay) return;
  if (!S.selectedDay.homeTasks) S.selectedDay.homeTasks = [];
  S.selectedDay.homeTasks.push({ text: '', done: false });
  renderMobilePlan();
  scheduleSave();
}
function mpUpdateSportDone(idx, done) {
  if (S.selectedDay?.sport?.[idx] !== undefined) {
    S.selectedDay.sport[idx].done = done;
    scheduleSave();
    updateProgress();
  }
}
function mpUpdateSportField(idx, field, val) {
  if (S.selectedDay?.sport?.[idx] !== undefined) {
    S.selectedDay.sport[idx][field] = val;
    scheduleSave();
  }
}
function mpDeleteSport(idx) {
  if (!S.selectedDay?.sport) return;
  S.selectedDay.sport.splice(idx, 1);
  renderMobilePlan();
  scheduleSave();
  updateProgress();
}
function mpAddSport() {
  if (!S.selectedDay) return;
  if (!S.selectedDay.sport) S.selectedDay.sport = [];
  S.selectedDay.sport.push({ exercise: '', sets: '', reps: '', done: false });
  renderMobilePlan();
  scheduleSave();
}

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  const ok = await checkAuth();
  if (!ok) return;

  await Promise.all([loadDays(), loadHabits()]);

  if (isMobile()) {
    // Mobile init
    renderMobileHeader();
    setTab('today');

    const todayStr   = today();
    const todayEntry = S.days.find(d => d.date === todayStr);
    if (todayEntry) {
      await selectDay(todayStr);
    } else if (S.days.length) {
      await selectDay(S.days[0].date);
    }

    // Load habit stats in background
    loadHabitStatsFull(S.habitStatsPeriod);
  } else {
    // Desktop init
    setupFieldListeners();
    setupButtonListeners();

    const todayStr   = today();
    const todayEntry = S.days.find(d => d.date === todayStr);
    if (todayEntry) {
      selectDay(todayStr);
    } else if (S.days.length) {
      selectDay(S.days[0].date);
    }

    document.addEventListener('keydown', handleKeydown);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js');
  }
}

init();
