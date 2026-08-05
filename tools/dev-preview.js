// Локальный стенд с наполненным днём — чтобы посмотреть интерфейс вживую
process.env.NODE_ENV = 'development';
process.env.DB_PATH = process.env.SEED_DB || require('node:path').join(require('node:os').tmpdir(), 'newday-preview.db');
process.env.SESSION_SECRET = 'local-preview-secret-0123456789012345';
process.env.PORT = '4010';
process.env.TRUST_PROXY = '0';
/*
 * Своя пара VAPID для стенда: без неё раздел уведомлений показывает
 * «не настроены», и проверить его нечем. Пара сгенерирована для стенда
 * и никак не связана с рабочим сервером.
 */
process.env.VAPID_PUBLIC_KEY = 'BDA9gPQ1b8cc-SifnADg6vs4tOQKsLCY3uLNz4TSqAg4inEucDSqCRsuvuUXcFzx48kRzTp186D9l4OI0Al_fMU';
process.env.VAPID_PRIVATE_KEY = 'DmFl4f9dWbd9OgU9m0L6797qkFWYvBQ7DtiUPRgOOPY';
process.env.VAPID_SUBJECT = 'mailto:dev@newday.local';

const bcrypt = require('bcryptjs');
const { loadConfig } = require('../server/config');
const { createDb } = require('../server/db');
const { runMigrations } = require('../server/db/migrations');
const { createApp } = require('../server/app');

const config = loadConfig();
const db = createDb(config.dbPath);
runMigrations(db);

const now = new Date();
const tz = 'Europe/Moscow';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

// админ: иначе на стенде не видно раздела подключения ИИ
db.prepare('INSERT INTO users (id, username, email, password_hash, email_verified, timezone, is_admin) VALUES (1,?,?,?,1,?,1)')
  .run('demo@newday.local', 'demo@newday.local', bcrypt.hashSync('demo1234', 8), tz);
db.prepare('INSERT INTO days (user_id, date, title, focus, weight, notes) VALUES (1,?,?,?,?,?)')
  .run(today, '', 'Закрыть отчёт по июлю', 78.4, 'Позвонить в сервис насчёт машины.');
db.prepare('INSERT INTO days (user_id, date, weight) VALUES (1,?,?)')
  .run('2000-01-01', 78.7);

/*
 * День засеян так, чтобы на нём было видно всё, что умеет экран: вложенный
 * блок (созвон внутри второй половины дня), строки с одним и с несколькими
 * сроками предупреждения, момент без длительности. Без этих случаев их
 * вёрстку никто не увидит — а именно она и расходилась с эталоном.
 */
const S = db.prepare(`INSERT INTO schedule_items
  (user_id,date,start_min,end_min,title,done,sort_order,alarm_mode,alarm_profile,remind_before_min,remind_before_json)
  VALUES (1,?,?,?,?,?,?,?,?,?,?)`);
[[400,430,'Подъём и вода',1,'alarm','wakeup',0,null],
 [430,470,'Зарядка и душ',1,'notify','gentle',0,null],
 [490,540,'Дорога',1,'none','gentle',null,null],
 [540,750,'Работа: первый блок',1,'notify','gentle',15,null],
 [780,810,'Обед',0,'none','gentle',null,null],
 [810,1020,'Работа: второй блок',0,'none','gentle',null,null],
 [840,885,'Созвон с подрядчиком',0,'notify','gentle',15,null],
 [1080,1140,'Зал',0,'alarm','gentle',1440,'[1440,30]'],
 [1170,1230,'Ужин и дом',0,'none','gentle',null,null],
 [1350,null,'Отбой',0,'notify','gentle',0,null]]
 .forEach((r,i)=>S.run(today,r[0],r[1],r[2],r[3],i,r[4],r[5],r[6],r[7]));

const T = db.prepare('INSERT INTO tasks (user_id,date,bucket,text,done,sort_order,carried_from) VALUES (1,?,?,?,?,?,?)');
T.run(today,'work','Созвон с подрядчиком',0,0,null);
T.run(today,'work','Отчёт за июль',1,1,'2026-08-02');
T.run(today,'work','Ревью пул-реквеста',0,2,null);
T.run(today,'home','Посуда',1,0,null);
T.run(today,'home','Забрать посылку',0,1,null);

// С калориями: без них колонка справа в питании пустая, и её не проверить
const M = db.prepare('INSERT INTO meals (user_id,date,slot,time_min,title,done,sort_order,calories) VALUES (1,?,?,?,?,?,?,?)');
M.run(today,'breakfast',420,'Завтрак — овсянка и кофе',1,0,320);
M.run(today,'lunch',780,'Обед — курица и рис',0,1,640);
M.run(today,'dinner',1170,'Ужин — рыба и овощи',0,2,430);

const P = db.prepare('INSERT INTO sport_sets (user_id,date,exercise,sets,reps,done,sort_order) VALUES (1,?,?,?,?,?,?)');
P.run(today,'Приседания',4,12,0,0);
P.run(today,'Жим лёжа',4,8,0,1);
P.run(today,'Планка',3,60,0,2);

const H = db.prepare(`INSERT INTO habits (user_id,title,emoji,color,mode,polarity,break_policy,
  challenge_target_days,challenge_start_date,schedule_mask,sort_order,created_at)
  VALUES (1,?,?,?,?,?,?,?,?,?,?,'2026-05-01 00:00:00')`);
const h1 = H.run('Вода 2 литра','💧','blue','ongoing','do','reset',null,null,127,0).lastInsertRowid;
const h2 = H.run('Не курить','🚭','pink','challenge','avoid','reset',300,'2026-06-18',127,1).lastInsertRowid;
const h3 = H.run('Зал','🏋','orange','ongoing','do','reset',null,null,(1<<0)|(1<<2)|(1<<4),2).lastInsertRowid;
const h4 = H.run('Читать 20 страниц','📖','home','challenge','do','keep',300,'2026-06-01',127,3).lastInsertRowid;

const L = db.prepare('INSERT OR REPLACE INTO habit_logs (user_id,habit_id,date,status) VALUES (1,?,?,?)');
const addDays = (d,n)=>{const [y,m,dd]=d.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,dd,12));t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
for (let i = 45; i >= 0; i--) {
  const d = addDays(today, -i);
  L.run(h1, d, i % 7 === 3 ? 'missed' : 'done');
  L.run(h2, d, 'done');
  if ([1,3,5].includes(new Date(d+'T12:00:00Z').getUTCDay())) L.run(h3, d, i % 4 === 0 ? 'missed' : 'done');
  L.run(h4, d, i % 5 === 0 ? 'missed' : 'done');
}
L.run(h1, today, 'done');
L.run(h2, today, 'done');

const app = createApp({ db, config });

// Стенд для проверки вёрстки на узких ширинах (см. tools/widths-harness.html)
app.get('/_widths', (_req, res) =>
  res.sendFile(require('node:path').join(__dirname, 'widths-harness.html')));

// Только для локального стенда: вход без пароля, чтобы снимать скриншоты
app.get('/dev-login', (req, res) => {
  req.session.userId = 1;
  req.session.save(() => res.redirect(req.query.to || '/app.html'));
});
app.listen(4010, '127.0.0.1', () => console.log('preview on 4010, today =', today));
