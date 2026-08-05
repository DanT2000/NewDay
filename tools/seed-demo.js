/**
 * Наполняет три недели вокруг сегодня днями разной формы.
 *
 *   NEWDAY_TOKEN=nd_... NEWDAY_URL=https://newday.appswire.ru node tools/seed-demo.js
 *
 * Чем отличается от `seed-example.js`: тот кладёт два ровных дня — рабочий и
 * выходной. Здесь нарочно разные случаи, потому что ровные дни ничего не
 * проверяют. Пустой день, день из трёх строк, день с вложенным блоком, день
 * внахлёст, день из двенадцати коротких дел, день только с напоминаниями —
 * на каждом из них интерфейс ведёт себя по-своему, и увидеть это можно
 * только если такой день есть.
 *
 * Скрипт идемпотентен: `PUT /days/:date/full` заменяет день целиком, поэтому
 * повторный запуск не удваивает данные.
 */

const BASE = (process.env.NEWDAY_URL || 'https://newday.appswire.ru').replace(/\/+$/, '') + '/api/v1';
const TOKEN = process.env.NEWDAY_TOKEN;

if (!TOKEN) {
  console.error('Нужен NEWDAY_TOKEN.');
  process.exit(1);
}

const headers = extra => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
});

/** Запрос с повтором: десятки вызовов через прокси иногда обрываются на 502. */
async function call(method, path, body, extraHeaders, attempt = 1) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: headers(extraHeaders),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    if (attempt >= 4) throw new Error(`${method} ${path} → нет связи: ${e.message}`);
    await new Promise(r => setTimeout(r, 500 * attempt));
    return call(method, path, body, extraHeaders, attempt + 1);
  }
  if (res.status >= 500 && attempt < 4) {
    await new Promise(r => setTimeout(r, 500 * attempt));
    return call(method, path, body, extraHeaders, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const localDate = (timeZone, offsetDays = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offsetDays * 86400000));

// ── Формы дней ───────────────────────────────────────────────

/** Полный день: с подъёма до отбоя, все разделы заполнены. */
const FULL = {
  title: 'Рабочий день',
  focus: 'Закрыть отчёт по июлю',
  schedule: [
    { time: '06:40-07:10', title: 'Подъём', alarmMode: 'alarm', alarmProfile: 'wakeup', remindBefore: [0] },
    { time: '07:10-07:40', title: 'Душ и завтрак', kind: 'meal' },
    { time: '08:00-08:40', title: 'Дорога' },
    { time: '09:00-13:00', title: 'Работа', kind: 'work', alarmMode: 'notify', remindBefore: [15, 0] },
    { time: '13:00-13:45', title: 'Обед', kind: 'meal' },
    { time: '14:00-18:00', title: 'Работа, вторая половина', kind: 'work' },
    { time: '18:30-19:30', title: 'Зал', kind: 'sport', alarmMode: 'alarm', alarmProfile: 'gentle', color: 'green' },
    { time: '20:00-20:40', title: 'Ужин', kind: 'meal' },
    { time: '21:00-21:40', title: 'Чтение' },
    { time: '23:00', title: 'Отбой', alarmMode: 'notify', remindBefore: [15] },
  ],
  tasks: {
    work: [
      { text: 'Свести цифры по июлю', done: true },
      { text: 'Ревью пул-реквеста' },
      { text: 'Ответить подрядчику' },
    ],
    home: [
      { text: 'Забрать посылку', done: true },
      { text: 'Оплатить интернет' },
    ],
  },
  meals: [
    { slot: 'breakfast', timeMin: 430, title: 'Овсянка, ягоды, кофе', calories: 420, done: true },
    { slot: 'lunch', timeMin: 720, endMin: 840, title: 'Суп, курица с рисом', calories: 680 },
    { slot: 'snack', title: 'Творог и орехи', calories: 300 },
    { slot: 'dinner', timeMin: 1200, title: 'Рыба, овощи', calories: 520 },
  ],
  sport: [
    { exercise: 'Приседания', sets: 4, reps: 12, done: true },
    { exercise: 'Жим лёжа', sets: 4, reps: 8, weight: 60 },
    { exercise: 'Планка', sets: 3, reps: 60 },
  ],
  notes: 'Сервис ноутбука\nПозвонить насчёт ремонта, спросить про сроки и стоимость.',
};

/** Частичный: три строки и одна задача — так выглядит день, который только начали. */
const PARTIAL = {
  title: 'Свободный день',
  focus: '',
  schedule: [
    { time: '09:30-10:15', title: 'Завтрак не спеша', kind: 'meal' },
    { time: '12:00-14:00', title: 'Прогулка' },
    { time: '19:00-21:00', title: 'Кино', color: 'orange' },
  ],
  tasks: { work: [], home: [{ text: 'Полить растения' }] },
  meals: [{ slot: 'other', title: 'Что-нибудь простое' }],
  sport: [],
  notes: '',
};

/**
 * Вложенные блоки: созвон и обед внутри рабочего. Ровно тот случай, который
 * эталон рисует склеенной карточкой, — без него код вложенности не виден.
 */
const NESTED = {
  title: 'День со созвонами',
  focus: 'Собрать требования',
  schedule: [
    { time: '08:00-08:30', title: 'Разбор почты' },
    { time: '10:00-18:00', title: 'Рабочий блок', kind: 'work' },
    { time: '13:00-13:40', title: 'Обед', kind: 'meal' },
    { time: '14:00-14:45', title: 'Созвон с подрядчиком', alarmMode: 'notify', remindBefore: [15], color: 'red' },
    { time: '16:00-16:30', title: 'Созвон с дизайнером', alarmMode: 'notify', remindBefore: [5] },
    { time: '19:00-20:00', title: 'Ужин и дом', kind: 'meal', alarmMode: 'notify', remindBefore: [1440, 60, 0] },
  ],
  tasks: {
    work: [{ text: 'Записать итоги созвона' }, { text: 'Отправить смету' }],
    home: [{ text: 'Купить корм' }],
  },
  meals: [
    { slot: 'lunch', timeMin: 780, title: 'Обед на работе', calories: 700 },
    { slot: 'dinner', timeMin: 1140, endMin: 1260, title: 'Ужин дома' },
  ],
  sport: [],
  notes: '',
};

/** Внахлёст: зал и ужин пересекаются. Человек так живёт, и это должно рисоваться. */
const OVERLAP = {
  title: 'День внахлёст',
  focus: '',
  schedule: [
    { time: '07:00-07:30', title: 'Подъём', alarmMode: 'alarm', alarmProfile: 'wakeup' },
    { time: '10:00-12:00', title: 'Дела по дому' },
    { time: '18:00-19:30', title: 'Зал', kind: 'sport', color: 'green' },
    { time: '19:00-19:40', title: 'Ужин', kind: 'meal', color: 'orange' },
    { time: '19:20-20:20', title: 'Звонок родителям', alarmMode: 'notify', remindBefore: [30] },
  ],
  tasks: { work: [], home: [{ text: 'Разобрать шкаф' }, { text: 'Вынести старое' }] },
  meals: [{ slot: 'dinner', timeMin: 1140, title: 'Салат и индейка', calories: 460 }],
  sport: [{ exercise: 'Тяга верхнего блока', sets: 3, reps: 12, weight: 45 }],
  notes: '',
};

/** Много коротких дел: проверяет, как держится плотная сетка и месяц. */
const MANY = {
  title: 'Плотный день',
  focus: 'Успеть всё до вечера',
  schedule: [
    { time: '07:00-07:20', title: 'Зарядка', kind: 'sport' },
    { time: '07:20-07:50', title: 'Завтрак', kind: 'meal' },
    { time: '08:00-08:30', title: 'Планирование' },
    { time: '08:30-09:00', title: 'Почта' },
    { time: '09:00-09:30', title: 'Планёрка', alarmMode: 'notify', remindBefore: [5] },
    { time: '09:30-10:15', title: 'Правки по макету', color: 'violet' },
    { time: '10:15-11:00', title: 'Созвон с командой' },
    { time: '11:00-11:30', title: 'Смета' },
    { time: '11:30-12:00', title: 'Звонок в банк', alarmMode: 'notify', remindBefore: [15] },
    { time: '12:00-12:40', title: 'Обед', kind: 'meal' },
    { time: '13:00-14:00', title: 'Документы' },
    { time: '14:00-15:00', title: 'Собеседование', color: 'red' },
    { time: '15:00-15:30', title: 'Разбор задач' },
    { time: '16:00-17:00', title: 'Отчёт' },
    { time: '18:00-19:00', title: 'Зал', kind: 'sport', color: 'green' },
  ],
  tasks: {
    work: [
      { text: 'Согласовать смету', done: true }, { text: 'Отправить отчёт' },
      { text: 'Назначить встречу' }, { text: 'Проверить счёт' },
    ],
    home: [{ text: 'Купить продуктов' }, { text: 'Записаться к врачу' }],
  },
  meals: [
    { slot: 'breakfast', timeMin: 440, title: 'Яичница', calories: 380, done: true },
    { slot: 'lunch', timeMin: 720, title: 'Паста', calories: 720 },
    { slot: 'snack', title: 'Яблоко', calories: 90 },
  ],
  sport: [
    { exercise: 'Разминка', sets: 1, reps: 10, done: true },
    { exercise: 'Приседания', sets: 5, reps: 10, weight: 70 },
    { exercise: 'Гребля', sets: 1, reps: 500 },
  ],
  notes: 'Дела на неделю\nПродлить подписку, забрать документы, записаться на ТО.',
};

/** Только напоминания: моменты без длительности — их видно и в месяце. */
const REMIND_ONLY = {
  title: '',
  focus: '',
  schedule: [
    { time: '09:00', title: 'Продлить подписку', kind: 'reminder', alarmMode: 'notify', remindBefore: [1440, 60] },
    { time: '12:00', title: 'Забрать документы', kind: 'reminder', alarmMode: 'notify', remindBefore: [60] },
    { time: '19:00', title: 'День рождения Ани', kind: 'reminder', alarmMode: 'notify', remindBefore: [1440], color: 'red' },
  ],
  tasks: { work: [], home: [] },
  meals: [],
  sport: [],
  notes: '',
};

/** Пустой день: тоже случай — по нему видно, как выглядит «ничего не запланировано». */
const EMPTY = {
  title: '', focus: '', schedule: [],
  tasks: { work: [], home: [] }, meals: [], sport: [], notes: '',
};

/*
 * Раскладка по дням. Три недели: прошлое с отметками, будущее планом.
 * Доля отметок разная — ровные 100 % выглядят подделкой и скрывают то,
 * как рисуется наполовину закрытый день.
 */
const LAYOUT = [
  [-9, MANY, 0.9], [-8, FULL, 0.7], [-7, EMPTY, 0],
  [-6, NESTED, 1], [-5, PARTIAL, 0.5], [-4, FULL, 0.8],
  [-3, OVERLAP, 0.6], [-2, MANY, 0.45], [-1, REMIND_ONLY, 0],
  [0, FULL, 0.35],
  [1, NESTED, 0], [2, PARTIAL, 0], [3, MANY, 0], [4, EMPTY, 0],
  [5, OVERLAP, 0], [6, REMIND_ONLY, 0], [7, FULL, 0],
  [9, PARTIAL, 0], [11, NESTED, 0], [14, MANY, 0],
];

const HABITS = [
  { title: 'Вода 2 литра', emoji: '💧', color: 'blue', preset: 'simple' },
  { title: 'Читать 20 страниц', emoji: '📖', color: 'teal', preset: 'marathon300' },
  { title: 'Зал', emoji: '🏋', color: 'orange', preset: 'simple', scheduleMask: 0b0010101 },
  { title: 'Не курить', emoji: '🚭', color: 'pink', preset: 'quit', challengeTargetDays: 300 },
  { title: 'Медитация', emoji: '🧘', color: 'violet', preset: 'simple', scheduleMask: 0b1111100 },
];

async function main() {
  const me = await call('GET', '/auth/me');
  const tz = me.timezone || 'Europe/Moscow';
  console.log(`Аккаунт: ${me.email || me.username}, таймзона ${tz}`);

  console.log('Привычки:');
  const have = new Set((await call('GET', '/habits')).map(h => h.title));
  for (const habit of HABITS) {
    if (have.has(habit.title)) { console.log(`  ${habit.title}: уже есть`); continue; }
    await call('POST', '/habits', habit);
    console.log(`  ${habit.title}: создана`);
  }
  const habits = await call('GET', '/habits');

  console.log('Дни:');
  // Отметки долей от списка — так в дне видно и сделанное, и оставшееся
  const mark = (list, share) => list.map((row, i) => ({
    ...row, done: i < Math.round(list.length * share),
  }));

  for (const [offset, tpl, share] of LAYOUT) {
    const date = localDate(tz, offset);
    const current = await call('GET', `/days/${date}/full`);
    await call('PUT', `/days/${date}/full`, {
      ...tpl,
      tasks: { work: mark(tpl.tasks.work, share), home: mark(tpl.tasks.home, share) },
      meals: mark(tpl.meals, share),
      sport: mark(tpl.sport, share),
      weight: offset % 3 === 0 ? Number((78.4 - offset * 0.1).toFixed(1)) : null,
    }, { 'If-Match': `"${current.rev}"` });
    const after = await call('GET', `/days/${date}/full`);
    console.log(`  ${date} «${tpl.title || 'без названия'}»: расписание ${after.schedule.length}`
      + `, задачи ${after.tasks.work.length + after.tasks.home.length}`
      + `, питание ${after.meals.length}, спорт ${after.sport.length}`);
  }

  console.log('Отметки привычек за две недели:');
  let marks = 0;
  for (const habit of habits) {
    const jobs = [];
    for (let back = 14; back >= 1; back--) {
      const date = localDate(tz, -back);
      // пропуски нарочные: непрерывная серия скрывает, как рисуется пропуск
      if (back % 6 === 3) continue;
      jobs.push(call('PUT', `/habits/${habit.id}/log/${date}`, {
        status: back % 5 === 2 ? 'missed' : 'done',
      }));
    }
    await Promise.all(jobs);
    marks += jobs.length;
    console.log(`  ${habit.title}: ${jobs.length}`);
  }
  console.log(`  всего отметок: ${marks}`);

  /*
   * Повторы и шаблон. Без них не проверить ни ежегодное напоминание, ни
   * автозаполнение нового дня общим расписанием.
   */
  console.log('Повторы:');
  const rules = await call('GET', '/series?target=schedule');
  const named = new Set(rules.map(r => r.name).filter(Boolean));
  const anniversary = localDate(tz, 0);

  if (!rules.some(r => !r.name)) {
    await call('POST', '/series', {
      target: 'schedule', freq: 'yearly', startDate: anniversary,
      rows: [{
        title: 'День рождения Ани', startMin: 600, endMin: null, kind: 'reminder',
        alarmMode: 'notify', remindBefore: [1440], color: 'red',
      }],
    });
    console.log('  ежегодное напоминание создано');
  } else {
    console.log('  повтор уже есть');
  }

  if (!named.has('Общее расписание')) {
    await call('POST', '/series', {
      target: 'schedule', name: 'Общее расписание', freq: 'daily', startDate: anniversary,
      rows: [
        { title: 'Подъём', startMin: 420, endMin: 450, alarmMode: 'alarm', alarmProfile: 'wakeup' },
        { title: 'Работа', startMin: 540, endMin: 1080, kind: 'work' },
        { title: 'Ужин', startMin: 1140, endMin: 1200, kind: 'meal' },
      ],
    });
    console.log('  шаблон «Общее расписание» создан');
  } else {
    console.log('  шаблон уже есть');
  }

  console.log('Готово.');
}

main().catch(e => { console.error(String(e.message || e)); process.exit(1); });
