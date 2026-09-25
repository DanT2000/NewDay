/**
 * Данные веб-версии: чтение и запись.
 *
 * Слой между экраном и API. Экран не знает ни про адреса, ни про формат
 * ответов: он просит «день такой-то» и получает то же, что раньше лежало
 * в `data.js` примерами. Поэтому подключение и вышло подстановкой, а не
 * переписыванием разметки.
 *
 * Правка применяется на экране сразу и ложится в очередь на устройстве;
 * сеть в этот момент не нужна вовсе. То, что видно, — это последний ответ
 * сервера плюс ещё не уехавшие правки, наложенные по порядку.
 */

import * as api from '../api.js';
import * as очередь from '../outbox.js';
import { наложить, наложитьВсе, наложитьНаПериод, наложитьНаЗаметки } from './apply.js';
import { запрос } from './ops.js';

const pad2 = n => String(n).padStart(2, '0');
export const keyOf = dt => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;

/** Понедельник недели, в которую попадает дата. */
export function mondayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return keyOf(dt);
}

/** Сегодня в часовом поясе человека, а не браузера. */
export function todayFor(timezone) {
  return new Date().toLocaleDateString('en-CA', timezone ? { timeZone: timezone } : undefined);
}

// ── Что лежит в памяти ───────────────────────────────────────

export const store = {
  user: null,
  settings: null,
  day: null,          // полный день: расписание, задачи, еда, привычки, прогресс
  range: null,        // { from, to, days: [...] } — для сетки недели и месяца
  habits: [],
  notes: [],
  devices: [],
  tokens: [],         // токены интеграций: список без секретов
  template: null,     // именованное правило-шаблон, применяется вручную
  series: [],         // правила повторов без имени: ими живут повторяющиеся напоминания
  ai: { ready: false, voice: false },
  /*
   * `true`, если то, что на экране, прочитано из локальной копии, а не с
   * сервера. Экран по этому признаку показывает спокойную полосу: «видно, но
   * это последнее известное».
   */
  offline: false,
  /*
   * На устройстве кончилось место, и очередь правок остановилась: её не
   * получается даже переложить в «не сохранилось». Сама она не поедет, и
   * молчать об этом нельзя — значок связи говорит это словами.
   */
  нетМеста: false,
};

/*
 * Последняя известная копия — чтобы приложение открывалось без сети.
 *
 * На телефоне это главное: человек заходит в метро, и приложение обязано
 * показать сегодняшний день, а не «нет связи с сервером». Раньше запуск падал
 * на первом же запросе настроек, и от офлайна оставался только кеш оболочки —
 * то есть пустая страница с сообщением об ошибке.
 *
 * Храним в localStorage, а не в Cache API: это не ответы, а состояние, и читать
 * его нужно синхронно на запуске, до первой отрисовки.
 */
const LOCAL = 'newday.local.';

function keep(name, value) {
  try { localStorage.setItem(LOCAL + name, JSON.stringify({ at: Date.now(), value })); }
  catch { /* приватный режим или переполнение — офлайн просто не будет */ }
}

function kept(name) {
  try {
    const raw = localStorage.getItem(LOCAL + name);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Когда копия была снята: этим экран объясняет, насколько данные свежие. */
export const keptAt = name => kept(name)?.at ?? null;

/** Забыть всё локальное: при выходе из аккаунта чужой день видеть нельзя. */
export function forgetLocal() {
  try {
    // перебираем через length/key, а не Object.keys: так надёжнее и так
    // хранилище перечисляется по правилам, а не по своим полям
    const ключи = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(LOCAL) || k === КЛЮЧ_ХОЗЯИНА)) ключи.push(k);
    }
    for (const k of ключи) localStorage.removeItem(k);
  } catch { /* нечего забывать */ }
  // и очередь тоже: чужие правки отправлять некуда и незачем
  очередь.очистить();
  // и то, что уже прочитано в память: чужой день на экране висеть не должен
  store.day = null;
  store.range = null;
  store.notes = [];
  store.habits = [];
}

/**
 * Один раз при запуске: кто мы и что настроено.
 *
 * Без сети берём последнюю копию и говорим об этом полем `offline`: врать, что
 * это свежие настройки, нельзя — от них зависит и «сегодня», и тема.
 */
/*
 * Чьё это устройство.
 *
 * Очередь и местные копии лежат в одном хранилище на всех, кто сюда
 * входил. Пока хозяин один, это незаметно; стоит войти второму — и правки
 * первого уехали бы в его день, а до первого удачного запроса он видел бы
 * чужие дни и чужое имя. Поэтому при входе сверяем, тот ли человек, и
 * чужое стираем. Свой же повторный вход (сессия истекла, токен отозвали)
 * правки сохраняет: они его и ждут.
 */
const КЛЮЧ_ХОЗЯИНА = 'newday.owner';

function сменаХозяина(кто) {
  if (!кто) return;
  let прежний = null;
  try { прежний = localStorage.getItem(КЛЮЧ_ХОЗЯИНА); } catch { /* нет хранилища — нечего и сверять */ }
  if (прежний && прежний !== кто) forgetLocal();
  try { localStorage.setItem(КЛЮЧ_ХОЗЯИНА, кто); } catch { /* не запомнили — сверим в следующий раз */ }
  // теперь известно, чьи правки в очереди, — можно отправлять
  хозяинИзвестен = true;
  очередь.отправить();
}

export async function boot() {
  try {
    const settings = await api.getSettings();
    сменаХозяина(settings.email || settings.username || null);
    store.settings = settings;
    store.user = { email: settings.email, username: settings.username, isAdmin: settings.isAdmin };
    store.offline = false;
    keep('settings', settings);
    /*
     * Состояние помощника не задерживает открытие.
     *
     * Раньше старт ждал два запроса подряд: настройки и статус помощника. На
     * плохой связи это удваивало время до первого экрана, хотя статус нужен
     * ровно одной шторке — и та открывается позже. Спрашиваем его вдогонку.
     */
    store.ai = store.ai ?? { ready: false, voice: false };
    api.GET('/ai/status')
      .then(ai => { store.ai = ai; })
      .catch(() => { /* не ответил — шторка помощника скажет, что он не подключён */ });
    return settings;
  } catch (e) {
    // 401 разбирает вызывающий: там нужен переход на страницу входа, а не копия
    if (e?.status === 401) throw e;
    const saved = kept('settings');
    if (!saved) throw e;
    /*
     * Открылись без связи, но копия настроек своя — значит это тот же
     * человек, что и в прошлый раз. Этого довольно, чтобы разрешить
     * очереди отправку, когда связь появится: иначе она простояла бы всю
     * сессию, начатую в метро.
     */
    сменаХозяина(saved.value.email || saved.value.username || null);
    store.settings = saved.value;
    store.user = {
      email: saved.value.email, username: saved.value.username, isAdmin: saved.value.isAdmin,
    };
    store.offline = true;
    store.ai = { ready: false, voice: false };
    return saved.value;
  }
}

/*
 * Опоздавший ответ не должен побеждать свежий.
 *
 * Человек листает дни быстрее, чем отвечает сеть: два нажатия «вперёд» —
 * два запроса в пути, и раньше в `store.day` оставался тот, что вернулся
 * последним, а не тот, который человек ждёт. Отсюда весь набор странностей
 * на телефоне: под сегодняшним числом висел вчерашний день, только что
 * добавленная задача пропадала с экрана, удалённая возвращалась.
 *
 * Считаем поколения: применяем только ответ на последнюю просьбу. В
 * локальную копию кладём все — там они по своим датам и пригодятся без сети.
 */
let dayGen = 0;
let rangeGen = 0;

export async function loadDay(date) {
  const gen = ++dayGen;
  /*
   * Поверх ответа сервера ложатся неуехавшие правки.
   *
   * Без этого ответ, в котором правки ещё нет, стирал бы её с экрана до тех
   * пор, пока очередь не доедет: человек видел бы, как только что
   * отмеченное дело отскакивает обратно. В локальную копию кладём именно
   * ответ сервера — очередь лежит отдельно и накладывается заново при
   * каждом чтении.
   */
  const сОчередью = день => наложитьВсе(день, очередь.список().filter(о => о.дата === date));
  try {
    const day = await api.getDay(date);
    keep(`day.${date}`, day);
    if (gen !== dayGen) return store.day;
    store.day = сОчередью(day);
    store.offline = false;
    return store.day;
  } catch (e) {
    if (e?.status === 401) throw e;
    if (gen !== dayGen) return store.day;
    const saved = kept(`day.${date}`);
    /*
     * Копии этого дня нет — показываем пустой день этой даты, а не оставляем
     * на экране прежний. Иначе выходило так: человек без связи листает на
     * день, которого он ещё не открывал, добавляет задачу — и не видит её.
     * Правка уезжала на сервер потом, но выглядело это как «нажал, и ничего
     * не произошло». Пустой день — то же самое, что отдал бы сервер за день,
     * в котором ничего нет.
     */
    store.day = сОчередью(saved ? saved.value : пустойДень(date));
    store.offline = true;
    return store.day;
  }
}

/** День, в котором ничего нет: тот же вид, что отдаёт сервер за пустую дату. */
const пустойДень = date => ({
  date, rev: 0, title: '', focus: '', weight: null, notes: '', foodPlan: '',
  schedule: [], tasks: { work: [], home: [] }, meals: [], sport: [],
  habits: [], progress: {}, habitsStreak: 0,
});

/**
 * Период для сетки. Неделя — семь дней от понедельника, месяц — вся сетка
 * вместе с хвостами соседних месяцев: клетки соседей тоже показывают дела.
 */
export async function loadRange(date, view) {
  let from;
  let to;
  if (view === 'month') {
    const [y, m] = date.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    from = keyOf(mondayOf(keyOf(first)));
    to = addDays(from, 41);            // шесть недель — максимум для любого месяца
  } else {
    from = keyOf(mondayOf(date));
    to = addDays(from, 6);
  }
  const gen = ++rangeGen;
  // в клетках сетки — то же правило, что и в дне: ответ сервера плюс очередь
  const сОчередью = период => наложитьНаПериод(период, очередь.список());
  try {
    const range = await api.GET(`/days/range?from=${from}&to=${to}`);
    keep(`range.${from}.${to}`, range);
    // лист месяца листается так же быстро, как дни, — тот же счёт поколений
    if (gen !== rangeGen) return store.range;
    store.range = сОчередью(range);
    // связь есть — полоса «нет связи» должна уйти и с экрана недели,
    // а не ждать, пока человек переключит экран
    store.offline = false;
    return store.range;
  } catch (e) {
    if (e?.status === 401) throw e;
    // сетка недели и месяца без сети показывает последнее известное
    const saved = kept(`range.${from}.${to}`);
    if (!saved) throw e;
    if (gen !== rangeGen) return store.range;
    store.range = сОчередью(saved.value);
    store.offline = true;
    return store.range;
  }
}

/**
 * Устройства аккаунта — для панели «Устройства» в настройках.
 *
 * Раньше экран настроек звал функцию, которой не было: вызов падал сразу же,
 * и вместо настроек человек читал «data.loadAccount is not a function».
 * Отказ здесь не должен ронять экран — список устройств не главное на нём.
 */
export async function loadAccount() {
  store.devices = await api.devices.list().catch(() => []);
  return store.devices;
}

/**
 * Токены для интеграций. Список приходит без секретов — только имя, префикс и
 * когда им пользовались в последний раз. Сам секрет сервер хранит хешем и
 * показывает единственный раз, в ответе на выпуск.
 */
export async function loadTokens() {
  store.tokens = await api.tokens.list().catch(() => []);
  return store.tokens;
}

export const createToken = (name = 'Интеграция') => api.tokens.create(name, 'write');
export const revokeToken = id => api.tokens.revoke(id);

export async function loadNotes() {
  /*
   * Поверх ответа — неуехавшие правки заметок дня, как и у самого дня. В
   * копию кладём ответ сервера: очередь накладывается заново при чтении.
   */
  const сОчередью = список => наложитьНаЗаметки(список, очередь.список());
  try {
    const rows = await api.GET('/notes');
    const список = Array.isArray(rows) ? rows : (rows.days ?? []);
    keep('notes', список);
    store.notes = сОчередью(список);
    store.offline = false;
    return store.notes;
  } catch (e) {
    if (e?.status === 401) throw e;
    // заметки без сети тоже нужны: в них лежит то, что человек записал для себя
    const saved = kept('notes');
    if (!saved) throw e;
    store.notes = сОчередью(saved.value);
    store.offline = true;
    return store.notes;
  }
}

// ── Шаблон дня ───────────────────────────────────────────────

/*
 * Шаблон — это правило с именем. Повтор сам достраивает дни, шаблон ждёт
 * нажатия: набор строк, которым можно заполнить любой день. Имя одно, и
 * шаблон в веб-версии тоже один — «общее расписание» человек держит в
 * голове в единственном числе.
 */
export const TEMPLATE_NAME = 'Общее расписание';

export async function loadTemplate() {
  const rows = await api.series.list({ templates: true });
  const list = Array.isArray(rows) ? rows : [];
  store.template = list.find(r => r.name === TEMPLATE_NAME) ?? list[0] ?? null;
  return store.template;
}

/** Сохраняем целиком: правка строки — это новая версия всего набора. */
export async function saveTemplate(rows) {
  if (!rows.length) return removeTemplate();
  const body = { name: TEMPLATE_NAME, target: 'schedule', rows, forceRows: true };
  store.template = store.template
    ? await api.series.update(store.template.id, body)
    : await api.series.create(body);
  return store.template;
}

export async function removeTemplate() {
  if (!store.template) return null;
  await api.series.remove(store.template.id);
  store.template = null;
  return null;
}

/**
 * Повтор — правило без имени: сервер сам достраивает им дни. Так живут
 * «ежедневно», «еженедельно», «ежемесячно» и «ежегодно» у напоминаний.
 */
export const createRepeat = ({ freq, startDate, row, byweekday }) =>
  api.series.create({
    target: 'schedule', freq, startDate, rows: [row],
    ...(byweekday ? { byweekday } : {}),
  });

/** Правила повторов нужны редактору напоминания: по ним видно, что за повтор. */
export async function loadSeries() {
  const rows = await api.series.list({ templates: false });
  store.series = Array.isArray(rows) ? rows : [];
  return store.series;
}

export const updateSeries = (id, body) => api.series.update(id, body);
/*
 * «Убрать повтор целиком»: правило уходит вместе с будущими строками, прошлые
 * остаются — они часть прожитых дней. Разбирается с этим сервер.
 */
export const removeSeries = id => api.series.remove(id);
/*
 * «Не напоминать с этого дня» — это конец правила, а не удаление: прошлые дни
 * остаются как были. Сервер сам обрезает правило датой окончания.
 */
export const endSeries = (id, date) => api.series.endFrom(id, date);

// ── Правки ───────────────────────────────────────────────────

/*
 * Правка применяется на устройстве и ложится в очередь. Сеть в этот момент
 * никого не интересует: человек нажал — человек увидел. Отправкой занимается
 * очередь, и она же расскажет, если сервер откажет.
 *
 * Так ушли сразу две беды. Первая: на телефоне каждая правка ждала ответа —
 * отправить, дождаться, перерисовать, — и это полторы секунды на нажатие.
 * Вторая: без связи правка откатывалась назад, и отмеченное в метро дело
 * приходилось отмечать заново вечером.
 */

const слушатели = new Set();
export function подписаться(fn) { слушатели.add(fn); return () => слушатели.delete(fn); }
function сообщить() {
  for (const fn of слушатели) { try { fn(); } catch { /* экран не должен ронять правку */ } }
}

/**
 * Наложить правку на то, что сейчас на экране, и сказать об этом экрану.
 *
 * В местную копию проекцию не пишем — там лежит только ответ сервера.
 * Иначе очередь накладывалась бы на собственный результат: задача,
 * добавленная без связи, показывалась дважды после первого же
 * перечитывания дня, трижды после второго — а человек, приняв это за сбой,
 * удалял «лишнюю» и терял обе.
 */
function местно(оп) {
  if (store.day && store.day.date === оп.дата) {
    store.day = наложить(store.day, оп);
  }
  // и на сетку недели/месяца: галочку в клетке ставят с того же экрана
  if (store.range) store.range = наложитьНаПериод(store.range, [оп]);
  // и на список заметок: заметку дня открывают из него же
  if (Array.isArray(store.notes)) store.notes = наложитьНаЗаметки(store.notes, [оп]);
  сообщить();
}

/**
 * Положить правку в очередь.
 *
 * Возвращает уже выполненное обещание: ждать нечего, но экран вызывает
 * правки цепочками (`.then`, `await`, обёртка `busy`), и ломать эту форму
 * ради синхронности значило бы переписать полсотни мест ради ничего.
 */
function вОчередь(правка, результат) {
  /*
   * Без даты правку отправлять некуда: адрес собрался бы как
   * «/days/undefined/…» и уехал в «не сохранилось». Такое бывает, когда
   * день ещё не загрузился, а человек уже нажал.
   */
  if (!правка.дата) {
    return Promise.reject(new Error('День ещё не загрузился — попробуйте ещё раз'));
  }
  let оп;
  try {
    оп = очередь.добавить(правка);
  } catch (e) {
    /*
     * Переполнение — единственная причина отказа, и отказываем обещанием, а
     * не броском: экран ловит отказы через `.catch`, а брошенное прямо из
     * обработчика нажатия до него не доедет.
     */
    return Promise.reject(e);
  }
  местно(оп);
  return Promise.resolve(результат);
}

/*
 * Отправитель для очереди: превращает правку в запрос и зовёт api.
 * Заводится один раз при старте, чтобы очередь не знала ни про адреса, ни
 * про заголовки.
 */
export function запуститьОчередь() {
  очередь.настроить({
    отправитель: оп => {
      /*
       * Пока неизвестно, чей это вход, не отправляем ничего. Отказ «нет
       * связи» тут — ровно то, что нужно: очередь встаёт и ждёт, ничего не
       * теряя, а `boot()` разбудит её, как только выяснит хозяина.
       */
      if (!хозяинИзвестен) {
        return Promise.reject({ status: 0, code: 'NETWORK', message: 'Ещё не знаем, чей это вход' });
      }
      const r = запрос(оп);
      if (r.ревизия !== undefined) return api.withRev(r.метод, r.путь, r.тело, r.ревизия);
      const заголовки = r.ключ ? { 'Idempotency-Key': r.ключ } : undefined;
      if (r.метод === 'DELETE') return api.DELETE(r.путь, заголовки);
      if (r.метод === 'POST') return api.POST(r.путь, r.тело, заголовки);
      if (r.метод === 'PUT') return api.PUT(r.путь, r.тело, заголовки);
      return api.PATCH(r.путь, r.тело, заголовки);
    },
  });
  /*
   * Временный номер строки заменяется настоящим и в местной копии: иначе
   * следующая правка той же строки ушла бы в никуда, а на экране остался бы
   * «tmp-…», который не переживёт перечитывание дня.
   */
  очередь.подписаться(весть => {
    // и здесь копию не трогаем: в ней ответ сервера, у него свои номера
    if (весть.вид === 'подстановка' && store.day) {
      store.day = подменитьId(store.day, весть.было, весть.стало);
    }
    /*
     * Сервер отказал — значит на экране осталось то, чего на сервере нет.
     * Перечитываем день: показывать правку, которая не сохранилась, нельзя,
     * а сказать о ней есть чему — значок и список «не доехали».
     */
    if (весть.вид === 'конфликт') { послеОтказа(весть.оп); return; }
    // место кончилось — очередь встала, и человеку нужно это увидеть
    if (весть.вид === 'нетМеста') { store.нетМеста = true; сообщить(); return; }
    /*
     * Правка уехала — перечитываем день, когда очередь опустела.
     *
     * Во-первых, ответ сервера мог обогнать саму правку: запрос дня ушёл
     * раньше, чем запись доехала, и строка на мгновение пропадала с
     * экрана. Во-вторых, «Повторить» из списка «не доехали» иначе ничего
     * на экране не меняет — правка уезжает, а человек видит прежнее и
     * жмёт ещё раз.
     */
    if (весть.вид === 'уехала') { store.нетМеста = false; послеОтправки(); return; }
    сообщить();
  });
  /*
   * Не отправляем, пока не известно, чей это вход.
   *
   * Запуск очереди стоит в начале работы экрана, а хозяин выясняется
   * ответом на запрос настроек — то есть позже. Отправь мы сразу, правка
   * прежнего человека успела бы уехать в аккаунт нового, и стирали бы её
   * уже после. `boot()` разбудит очередь сам, как только всё выяснит.
   */
  if (хозяинИзвестен) очередь.отправить();
}

/** Пока `false`, очередь стоит: неизвестно, чьи в ней правки. */
let хозяинИзвестен = false;

/*
 * Сервер отказал — значит на экране осталось то, чего на сервере нет.
 *
 * Убираем копию того дня, к которому правка относилась: копия хранит ответ
 * сервера, а открытый день мог быть уже другим — перечитывать надо не «то,
 * что на экране», а то, что отвергли. Сам день просим один раз на все
 * отказы подряд: при массовом отказе (долго работали без связи, а сервер
 * не принял) на каждую правку уходил отдельный запрос — сотня правок
 * означала сотню запросов и замерший экран.
 */
let отказЖдёт = null;

function послеОтказа(оп) {
  if (оп?.дата) забытьДень(оп.дата);
  clearTimeout(отказЖдёт);
  отказЖдёт = setTimeout(() => {
    отказЖдёт = null;
    const дата = store.day?.date;
    Promise.allSettled([
      дата ? loadDay(дата) : null,
      // настройки могли не примениться — перечитываем и их
      boot().catch(() => null),
    ].filter(Boolean)).then(сообщить);
  }, 300);
  сообщить();
}

/** Перечитать день, когда очередь опустела: один раз на всю пачку правок. */
let отправкаЖдёт = null;

function послеОтправки() {
  сообщить();
  clearTimeout(отправкаЖдёт);
  отправкаЖдёт = setTimeout(() => {
    отправкаЖдёт = null;
    if (очередь.ожидает() || !store.day?.date) return;
    loadDay(store.day.date).finally(сообщить);
  }, 400);
}

/** Забыть местную копию дня: следующий заход прочитает его с сервера. */
function забытьДень(date) {
  try { localStorage.removeItem(`${LOCAL}day.${date}`); } catch { /* нечего забывать */ }
}

/**
 * Замена номера строки во всех разделах дня.
 *
 * Вместе с самим номером меняем и ссылку на него: приём пищи помнит свой
 * блок расписания полем `schedule_item_id`, и оставить там «tmp-…» значило
 * бы показать связанную запись как несвязанную.
 */
function подменитьId(день, было, стало) {
  const d = structuredClone(день);
  const тот = знач => String(знач) === String(было);
  const правь = список => (список ?? []).map(r => {
    const s = тот(r.id) ? { ...r, id: стало } : r;
    return тот(s.schedule_item_id) ? { ...s, schedule_item_id: стало } : s;
  });
  d.schedule = правь(d.schedule);
  d.meals = правь(d.meals);
  d.sport = правь(d.sport);
  d.tasks = { work: правь(d.tasks?.work), home: правь(d.tasks?.home) };
  return d;
}

export const ожидает = () => очередь.ожидает();
/** Когда сделана самая старая неуехавшая правка: по ней видно, что очередь застряла. */
export const старейшаяПравка = () => очередь.список()[0]?.at ?? null;
export const конфликты = () => очередь.конфликты();
export const забыть = id => очередь.забыть(id);
export const повторитьПравку = id => очередь.повторить(id);
export const отправитьОчередь = () => очередь.отправить();

const dateOf = () => store.day?.date;

/** Строка раздела: общая обвязка для четырёх одинаковых троек. */
const разделСтрок = раздел => ({
  создать(дата, поля) {
    /*
     * Строка получает временный номер и живёт с ним, пока правка не уехала.
     * Тем, кто берёт `id` из ответа — приём пищи со своим блоком в
     * расписании, — временный годится так же: подстановку настоящего сделает
     * очередь, и сделает её и в очереди, и в местной копии.
     */
    const цель = очередь.новыйId();
    return вОчередь({ вид: 'строка.создать', дата, цель, данные: { раздел, поля } }, { id: цель });
  },
  изменить(дата, id, поля) {
    return вОчередь({ вид: 'строка.изменить', дата, цель: id, данные: { раздел, поля } });
  },
  удалить(дата, id) {
    return вОчередь({ вид: 'строка.удалить', дата, цель: id, данные: { раздел } });
  },
});

const строкиРасписания = разделСтрок('schedule');
const строкиЗадач = разделСтрок('tasks');
const строкиЕды = разделСтрок('meals');
const строкиСпорта = разделСтрок('sport');

export const createRow = (date, body) => строкиРасписания.создать(date, body);
export const updateRow = (date, id, body) => строкиРасписания.изменить(date, id, body);
export const removeRow = (date, id) => строкиРасписания.удалить(date, id);

export const createTask = (date, body) => строкиЗадач.создать(date, body);
export const updateTask = (date, id, body) => строкиЗадач.изменить(date, id, body);
export const removeTask = (date, id) => строкиЗадач.удалить(date, id);

export const createMeal = (date, body) => строкиЕды.создать(date, body);
export const updateMeal = (date, id, body) => строкиЕды.изменить(date, id, body);
export const removeMeal = (date, id) => строкиЕды.удалить(date, id);

export const createSport = (date, body) => строкиСпорта.создать(date, body);
export const updateSport = (date, id, body) => строкиСпорта.изменить(date, id, body);
export const removeSport = (date, id) => строкиСпорта.удалить(date, id);

export const toggleScheduleRow = (row, done) => строкиРасписания.изменить(dateOf(), row.id, { done });
export const toggleTask = (task, done) => строкиЗадач.изменить(dateOf(), task.id, { done });
export const toggleMeal = (meal, done) => строкиЕды.изменить(dateOf(), meal.id, { done });
export const toggleSport = (row, done) => строкиСпорта.изменить(dateOf(), row.id, { done });

/**
 * Привычка отмечается не полем `done`, а записью в журнале за дату:
 * привычки живут отдельно от дня и считают серии по этим записям.
 */
export function toggleHabit(habit, done) {
  const дата = dateOf();
  return вОчередь({
    вид: 'привычка.отметить', дата, цель: habit.id,
    данные: { дата, статус: done ? 'done' : null },
  });
}

/*
 * Заметка с датой — это заметка дня, поэтому пишется в день. Заметка без
 * даты живёт своим списком. Вид определяется датой, и других правил тут нет.
 */
export const saveDayNote = (date, text) => saveDayField(date, { notes: text });

/** Поля самого дня: заметка, вес, план питания. Вложенные строки не трогает. */
export function saveDayField(date, patch) {
  return вОчередь({
    вид: 'день.поля', дата: date, цель: null,
    данные: { поля: patch, rev: store.day?.date === date ? (store.day.rev ?? 0) : 0 },
  });
}

/** Настройки приложения: тема, акцент, масштаб, переключатели дня. */
export function saveSettings(patch) {
  if (store.settings) {
    store.settings.settings = { ...store.settings.settings, ...patch };
    keep('settings', store.settings);
  }
  return вОчередь({
    вид: 'настройки', дата: todayFor(store.settings?.timezone), цель: null,
    данные: { поля: patch },
  });
}

/*
 * Остальное требует связи и уходит на сервер сразу: повторы и шаблоны
 * достраивает сервер, привычки как сущности человек трогает редко. Класть
 * это в очередь значило бы повторять серверную логику на клиенте — и
 * заводить вторую правду.
 */
/*
 * «Повторять» и «не повторять» — это и про саму строку, а не только про
 * правило. Привязанная строка говорит серверу, что этот день уже достроен;
 * отвязанная переживает удаление правила и остаётся в дне.
 */
export const attachRow = (date, id, seriesId) => api.schedule.setSeries(date, id, seriesId);
export const detachRow = (date, id) => api.schedule.setSeries(date, id, null);
/** Сдвиг блока вместе со всем, что начинается позже: способ разойтись при пересечении. */
export const shiftRows = (date, fromId, minutes) => api.schedule.shift(date, fromId, minutes, true);

export const createFreeNote = body => api.POST('/notes', body);
export const updateFreeNote = (id, body) => api.PATCH(`/notes/${id}`, body);
export const removeFreeNote = id => api.DELETE(`/notes/${id}`);

export const createHabit = body => api.habits.create(body);
export const updateHabit = (id, body) => api.habits.update(id, body);
/*
 * Убираем в архив, а не стираем: журнал отметок — это история, и удалить её
 * вместе с привычкой значит переписать прошлое. Архивная привычка исчезает
 * из списка, но дни, в которые она была выполнена, остаются правдой.
 */
export const removeHabit = id => api.habits.archive(id);
