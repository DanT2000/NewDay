/**
 * Наполняет два дня примером через публичное API.
 *
 *   NEWDAY_TOKEN=nd_... NEWDAY_URL=https://newday.appswire.ru node tools/seed-example.js
 *
 * Нужен, чтобы у нового аккаунта было на что смотреть, и одновременно
 * служит живой проверкой API: если скрипт прошёл, значит заполнение дня
 * снаружи работает.
 */

const BASE = (process.env.NEWDAY_URL || 'https://newday.appswire.ru').replace(/\/+$/, '') + '/api/v1';
const TOKEN = process.env.NEWDAY_TOKEN;

if (!TOKEN) {
  console.error('Нужен NEWDAY_TOKEN — создайте токен с правом записи в настройках.');
  process.exit(1);
}

const headers = extra => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
});

/**
 * Запрос с повтором. Десятки последовательных вызовов через обратный прокси
 * иногда получают 502/504 — это не ошибка данных, а обрыв соединения,
 * и падать из-за него посреди наполнения бессмысленно.
 */
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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Дата в таймзоне аккаунта, чтобы «сегодня» совпало с тем, что видит человек. */
function localDate(timeZone, offsetDays = 0) {
  const at = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

const WORKDAY = {
  focus: 'Закрыть отчёт по июлю',
  schedule: [
    { time: '06:30-07:00', title: 'Подъём', alarmMode: 'alarm', alarmProfile: 'wakeup' },
    { time: '07:00-07:30', title: 'Душ и процедуры' },
    { time: '07:30-08:00', title: 'Завтрак', kind: 'meal' },
    { time: '09:00-13:00', title: 'Работа', kind: 'work', alarmMode: 'notify', remindBeforeMin: 10 },
    { time: '13:00-14:00', title: 'Обед', kind: 'meal' },
    { time: '14:00-18:00', title: 'Работа, вторая половина', kind: 'work' },
    { time: '19:00-20:00', title: 'Зал', kind: 'sport', alarmMode: 'alarm', alarmProfile: 'gentle' },
    { time: '21:30-22:00', title: 'Чтение' },
    { time: '23:00-23:30', title: 'Отбой', alarmMode: 'notify', remindBeforeMin: 15 },
  ],
  tasks: {
    work: [
      { text: 'Созвон с подрядчиком в 11:00' },
      { text: 'Свести цифры по июлю' },
      { text: 'Ревью пул-реквеста' },
    ],
    home: [
      { text: 'Забрать посылку' },
      { text: 'Оплатить интернет' },
    ],
  },
  meals: [
    { slot: 'breakfast', timeMin: 450, title: 'Овсянка, ягоды, кофе', calories: 420 },
    { slot: 'lunch', timeMin: 780, title: 'Суп, курица с рисом', calories: 680 },
    { slot: 'snack', timeMin: 1020, title: 'Творог, орехи', calories: 300 },
    { slot: 'dinner', timeMin: 1230, title: 'Рыба, овощи', calories: 520 },
  ],
  sport: [
    { exercise: 'Приседания', sets: 4, reps: 12 },
    { exercise: 'Жим лёжа', sets: 4, reps: 8, weight: 60 },
    { exercise: 'Тяга верхнего блока', sets: 3, reps: 12, weight: 45 },
    { exercise: 'Планка', sets: 3, reps: 60 },
  ],
  notes: 'Позвонить в сервис насчёт машины. Забрать документы в среду.',
};

const DAYOFF = {
  focus: 'Разгрузить день, дойти до родителей',
  schedule: [
    { time: '08:30-09:00', title: 'Подъём без будильника' },
    { time: '09:00-09:40', title: 'Завтрак не спеша', kind: 'meal' },
    { time: '10:30-12:00', title: 'Прогулка' },
    { time: '13:00-14:00', title: 'Обед', kind: 'meal' },
    { time: '15:00-17:00', title: 'Родители', alarmMode: 'notify', remindBeforeMin: 30 },
    { time: '19:00-21:00', title: 'Кино' },
  ],
  tasks: {
    work: [],
    home: [
      { text: 'Разобрать шкаф' },
      { text: 'Купить продуктов на неделю' },
      { text: 'Полить растения' },
    ],
  },
  meals: [
    { slot: 'breakfast', timeMin: 540, title: 'Сырники', calories: 480 },
    { slot: 'lunch', timeMin: 780, title: 'Борщ', calories: 550 },
    { slot: 'dinner', timeMin: 1200, title: 'Салат, индейка', calories: 460 },
  ],
  sport: [
    { exercise: 'Растяжка', sets: 1, reps: 20 },
  ],
  notes: '',
};

async function fillDay(date, plan, title) {
  const current = await call('GET', `/days/${date}/full`);
  await call('PUT', `/days/${date}/full`, { title, ...plan }, { 'If-Match': `"${current.rev}"` });
  const after = await call('GET', `/days/${date}/full`);
  console.log(`  ${date} «${title}»: расписание ${after.schedule.length}, `
    + `задачи ${after.tasks.work.length}+${after.tasks.home.length}, `
    + `питание ${after.meals.length}, спорт ${after.sport.length}`);
  return after;
}

async function ensureHabits() {
  const existing = await call('GET', '/habits');
  const have = new Set(existing.map(h => h.title));
  const wanted = [
    { title: 'Вода 2 литра', emoji: '💧', color: 'blue', preset: 'simple' },
    { title: 'Не курить', emoji: '🚭', color: 'pink', preset: 'quit', challengeTargetDays: 300 },
    { title: 'Зал', emoji: '🏋', color: 'orange', preset: 'simple', scheduleMask: 0b0010101 },
    { title: 'Читать 20 страниц', emoji: '📖', color: 'teal', preset: 'marathon300' },
  ];
  for (const h of wanted) {
    if (have.has(h.title)) continue;
    await call('POST', '/habits', h);
    console.log(`  привычка «${h.title}» создана`);
  }
  return call('GET', '/habits');
}

const me = await call('GET', '/auth/me');
const tz = me.timezone || 'Europe/Moscow';
console.log(`Аккаунт: ${me.email || me.username}, таймзона ${tz}`);

console.log('Привычки:');
const habits = await ensureHabits();

/*
 * Заполняем не два дня, а неделю вокруг сегодня: экран «Сейчас» и полоска
 * недели без данных выглядят пустыми, и понять по ним ничего нельзя.
 * Прошедшие дни идут с отметками, будущие — планом без отметок: так видно
 * и то, как выглядит закрытый день, и то, как выглядит предстоящий.
 */
console.log('Дни:');
const plan = [
  [-3, WORKDAY, 'Рабочий день', 0.8],
  [-2, WORKDAY, 'Рабочий день', 0.5],
  [-1, DAYOFF,  'Выходной',     1.0],
  [0,  WORKDAY, 'Рабочий день', 0.35],
  [1,  DAYOFF,  'Выходной',     0],
  [2,  WORKDAY, 'Рабочий день', 0],
  [3,  WORKDAY, 'Рабочий день', 0],
];

for (const [offset, tpl, title, doneShare] of plan) {
  const date = localDate(tz, offset);
  // Отметки ставим долей от списка: ровные 100 % выглядят подделкой
  const mark = (list, share) => list.map((row, i) => ({
    ...row, done: i < Math.round(list.length * share),
  }));
  await fillDay(date, {
    ...tpl,
    schedule: tpl.schedule,
    tasks: {
      work: mark(tpl.tasks.work, doneShare),
      home: mark(tpl.tasks.home, doneShare),
    },
    meals: mark(tpl.meals, doneShare),
    sport: mark(tpl.sport, doneShare),
    weight: 78.4 - offset * 0.15,
  }, title);
}

const today = localDate(tz, 0);

// Немного отметок за прошедшие дни, чтобы статистика и серии были не пустыми
console.log('Отметки привычек за две недели:');
let marks = 0;
for (const habit of habits) {
  // по одной привычке за раз, но дни параллельно: последовательные 60 запросов
  // через прокси занимали минуты и упирались в таймаут
  const jobs = [];
  for (let back = 14; back >= 0; back--) {
    const date = localDate(tz, -back);
    // оставляем пропуски: ровные 100 % выглядят как подделка
    const status = (back % 5 === 2) ? 'missed' : 'done';
    jobs.push(call('PUT', `/habits/${habit.id}/log/${date}`, { status }));
  }
  await Promise.all(jobs);
  marks += jobs.length;
  console.log(`  ${habit.title}: ${jobs.length}`);
}
console.log(`  поставлено отметок: ${marks}`);

console.log('Готово.');
