/**
 * Наложение ещё не уехавшей правки на день.
 *
 * Правило одно: на экране — последний ответ сервера плюс правки из очереди,
 * наложенные по порядку. Здесь вторая половина этого правила, и только она:
 * ни сети, ни хранилища, ни DOM. Функция чистая, её зовут заново после
 * каждой загрузки дня — поэтому накопиться ошибке негде.
 */

/** Разделы дня со строками. Имя раздела — оно же кусок адреса API. */
export const РАЗДЕЛЫ = ['schedule', 'tasks', 'meals', 'sport'];

/*
 * Сервер принимает camelCase, а в строке дня лежат имена колонок. Карта
 * повторяет FIELD_MAP репозиториев (server/repos/*.js): пока правка не
 * уехала, строка обязана выглядеть ровно так же, как будущий ответ сервера,
 * иначе после отправки она на экране дёрнется.
 */
const В_КОЛОНКУ = {
  startMin: 'start_min', endMin: 'end_min', timeMin: 'time_min',
  alarmMode: 'alarm_mode', alarmProfile: 'alarm_profile',
  remindBeforeMin: 'remind_before_min', remindBefore: 'remind_before_json',
  scheduleItemId: 'schedule_item_id', seriesId: 'series_id',
  sortOrder: 'sort_order', carriedFrom: 'carried_from', repsMax: 'reps_max',
  externalId: 'external_id', lastModifiedBy: 'last_modified_by',
};

/** Поля, которые сервер хранит текстом JSON. */
const ТЕКСТОМ = new Set(['remindBefore']);
/** Флажки: в API это true/false, в строке — 1/0. */
const ФЛАЖКИ = new Set(['done']);

/*
 * Сроки напоминаний сервер приводит к порядку: убирает повторы, сортирует
 * по убыванию и оставляет не больше шести (server/routes/v1/entities.js).
 * Повторяем это здесь, иначе метки перескакивают в другой порядок в тот
 * миг, когда правка доехала, — то самое дёрганье, от которого очередь и
 * должна избавлять.
 */
const МАКС_СРОКОВ = 6;

function сроки(список) {
  if (!Array.isArray(список) || !список.length) return null;
  const числа = [...new Set(список.map(v => (v === 'end' ? 'end' : Number(v))))]
    .filter(v => v === 'end' || Number.isFinite(v))
    .sort((a, b) => (a === 'end' ? 1 : b === 'end' ? -1 : b - a))
    .slice(0, МАКС_СРОКОВ);
  return числа.length ? числа : null;
}

/** Тело запроса → поля строки дня. */
export function вСтроку(поля) {
  const out = {};
  for (const [k, знач] of Object.entries(поля ?? {})) {
    const имя = В_КОЛОНКУ[k] ?? k;
    if (ТЕКСТОМ.has(k)) {
      const список = сроки(знач);
      out[имя] = список ? JSON.stringify(список) : null;
      // первый срок сервер дублирует отдельным полем — и мы тоже
      if (k === 'remindBefore') {
        const обычные = (список ?? []).filter(v => v !== 'end');
        out.remind_before_min = обычные.length ? обычные[0] : null;
      }
    } else if (ФЛАЖКИ.has(k)) {
      out[имя] = знач ? 1 : 0;
    } else {
      out[имя] = знач;
    }
  }
  return out;
}

/*
 * Чего сервер дописывает сам при создании. Без этого новая строка приходит
 * на экран без `done` и без `kind`, и разметка спотыкается о undefined ещё
 * до того, как правка уехала.
 */
const ЗАГОТОВКА = {
  schedule: {
    start_min: 0, end_min: null, title: '', note: '', done: 0, kind: 'normal',
    alarm_mode: 'none', alarm_profile: 'gentle', remind_before_json: null,
    remind_before_min: null, series_id: null, color: null,
  },
  tasks: { bucket: 'work', text: '', done: 0, carried_from: null },
  meals: {
    slot: 'other', time_min: null, end_min: null, title: '', note: '',
    calories: null, done: 0, schedule_item_id: null, remind_before_json: null,
  },
  sport: { exercise: '', sets: null, reps: null, reps_max: null, weight: null, done: 0 },
};

/** Строки раздела одним списком: задачи лежат по двум корзинам. */
const строки = (день, раздел) => (раздел === 'tasks'
  ? [...(день.tasks?.work ?? []), ...(день.tasks?.home ?? [])]
  : (день[раздел] ?? []));

/** Положить список обратно — задачи разложив по корзинам. */
function записать(день, раздел, список) {
  if (раздел !== 'tasks') { день[раздел] = список; return; }
  день.tasks = {
    work: список.filter(t => (t.bucket ?? 'work') === 'work'),
    home: список.filter(t => (t.bucket ?? 'work') !== 'work'),
  };
}

/** Сравнение id: временный — строка, настоящий — число. */
const тот = (a, b) => String(a) === String(b);

export function наложить(день, оп) {
  if (!день || !оп) return день;
  const d = structuredClone(день);
  const раздел = оп.данные?.раздел;
  switch (оп.вид) {
    case 'строка.создать':
      записать(d, раздел, [...строки(d, раздел),
        { ...ЗАГОТОВКА[раздел], ...вСтроку(оп.данные.поля), id: оп.цель }]);
      break;
    case 'строка.изменить':
      записать(d, раздел, строки(d, раздел)
        .map(r => (тот(r.id, оп.цель) ? { ...r, ...вСтроку(оп.данные.поля) } : r)));
      break;
    case 'строка.удалить':
      записать(d, раздел, строки(d, раздел).filter(r => !тот(r.id, оп.цель)));
      break;
    case 'привычка.отметить':
      // отметка за другую дату к этому дню отношения не имеет
      if (оп.данные.дата !== d.date) break;
      d.habits = (d.habits ?? []).map(h => (тот(h.id, оп.цель)
        ? { ...h, status: оп.данные.статус } : h));
      break;
    case 'день.поля':
      if (оп.дата === d.date) Object.assign(d, оп.данные.поля);
      break;
    default:
      break;   // настройки и всё незнакомое день не меняют
  }
  return d;
}

export const наложитьВсе = (день, ops) =>
  (ops ?? []).reduce((d, оп) => наложить(d, оп), день);

/*
 * И для списка заметок.
 *
 * Заметка дня живёт в самом дне, а список заметок сервер собирает отдельным
 * запросом. Без наложения выходила гонка: человек правил заметку, список
 * перечитывался раньше, чем правка доезжала, — и открытая из списка заметка
 * показывала прежний текст, будто сохранение не удалось. Разбор заголовка
 * тот же, что у сервера (server/routes/v1/notes.js): первая строка —
 * заголовок, остальное — текст, пустая заметка в список не попадает.
 */
export function наложитьНаЗаметки(список, ops) {
  const свои = (ops ?? []).filter(о => о.вид === 'день.поля' && о.данные?.поля?.notes !== undefined);
  if (!Array.isArray(список) || !свои.length) return список;
  let out = список.map(n => ({ ...n }));
  for (const оп of свои) {
    const сырой = String(оп.данные.поля.notes ?? '');
    out = out.filter(n => n.date !== оп.дата);
    if (!сырой.trim()) continue;
    const [первая, ...дальше] = сырой.split('\n');
    const заметка = { id: оп.дата, date: оп.дата, title: первая.trim(), text: дальше.join('\n'), updated_at: null };
    // заметки дней идут по убыванию даты, свободные — после них
    const куда = out.findIndex(n => !n.date || n.date < оп.дата);
    out.splice(куда < 0 ? out.length : куда, 0, заметка);
  }
  return out;
}

/*
 * То же самое для сетки недели и месяца.
 *
 * Клетки живут своей выборкой за период, а не днём, и без этого галочка,
 * поставленная в клетке без связи, отскакивала бы назад при первом же
 * обновлении — ровно та беда, ради которой всё и затевалось. В выборке
 * только расписание и задачи, поэтому еда и подходы сюда не попадают.
 */
export function наложитьНаПериод(период, ops) {
  const свои = (ops ?? []).filter(о => о.вид?.startsWith('строка.')
    && (о.данные?.раздел === 'tasks' || о.данные?.раздел === 'schedule'));
  if (!период?.days?.length || !свои.length) return период;
  const out = structuredClone(период);
  for (const день of out.days) {
    for (const оп of свои) {
      if (оп.дата !== день.date) continue;
      const раздел = оп.данные.раздел;
      const список = день[раздел] ?? [];
      if (оп.вид === 'строка.создать') {
        день[раздел] = [...список, { ...ЗАГОТОВКА[раздел], ...вСтроку(оп.данные.поля), id: оп.цель }];
      } else if (оп.вид === 'строка.изменить') {
        день[раздел] = список.map(r => (тот(r.id, оп.цель) ? { ...r, ...вСтроку(оп.данные.поля) } : r));
      } else {
        день[раздел] = список.filter(r => !тот(r.id, оп.цель));
      }
    }
    // счётчики клетки считаются по строкам, а не приходят отдельно
    if (день.counts) {
      день.counts.schedule = (день.schedule ?? []).length;
      день.counts.done = (день.schedule ?? []).filter(r => r.done === 1).length;
    }
  }
  return out;
}
