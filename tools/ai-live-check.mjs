/**
 * Проверка качества разбора на живой модели.
 *
 * Это не юнит-тест и в `npm test` не входит: скрипт ходит в платный
 * провайдер и проверяет подсказку, а не код. Тесты с подделкой лежат в
 * test/api/ai.test.js и гоняются всегда.
 *
 * Нужен потому, что подсказку легко испортить незаметно. Например,
 * требование «не теряй подъём» заставило модель добавлять «Подъём» без
 * времени туда, где про него не говорили, — юнит-тест такого не увидит,
 * а этот скрипт увидел.
 *
 * Запуск: поднять стенд `node tools/dev-preview.js` с переменными AI_*,
 * затем `node tools/ai-live-check.mjs`. Один прогон стоит около 15 копеек.
 */

const URL = process.env.STAND || 'http://127.0.0.1:4010';

const login = await fetch(`${URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ emailOrUsername: 'demo@newday.local', password: 'demo1234' }),
});
const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

const сегодня = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
const завтра = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

const РЕЧЬ = 'Так завтра встаю в семь тридцать, в девять созвон с Андреем на полтора часа, '
  + 'надо не забыть заплатить за интернет, вечером в зал часов в семь, '
  + 'и купить молоко, хлеб и кофе.';

async function разбор(text, history) {
  const res = await fetch(`${URL}/api/v1/ai/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text, ...(history ? { history } : {}) }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(d)}`);
  return d;
}

function показать(d) {
  console.log(`  ${d.model} · ${d.ms} мс · ${d.cost} ₽`);
  if (d.question) console.log(`  вопрос: ${d.question} → ${d.options.join(' / ')}`);
  for (const it of d.items) {
    const t = it.start ? `${it.start}${it.end ? '–' + it.end : ''}` : '—';
    console.log(`   · ${(it.kind ?? '').padEnd(9)} ${(it.title ?? '').padEnd(32)} ${t.padEnd(12)} ${(it.date ?? '—').padEnd(11)} ${(it.category ?? '—').padEnd(5)} ${it.alarm ?? ''}`);
  }
  if (d.unparsed) console.log('  не разобрано:', d.unparsed);
}

const проверки = [];
const проверить = (что, условие) => проверки.push([что, Boolean(условие)]);

console.log(`Сегодня ${сегодня}, завтра ${завтра}\n`);
console.log('── Полный план дня ──');
console.log(`  «${РЕЧЬ}»`);
const d = await разбор(РЕЧЬ);
показать(d);

const найти = re => d.items.find(i => re.test(i.title ?? ''));
const подъём = найти(/подъём|встаю|встать/i);
const созвон = найти(/созвон|андре/i);
const интернет = найти(/интернет/i);
const зал = найти(/зал/i);
const покупки = найти(/молоко|хлеб|кофе|купить/i);

проверить('подъём не потерян', подъём);
проверить('у подъёма время 07:30', подъём?.start === '07:30');
проверить('у подъёма будильник alarm', подъём?.alarm === 'alarm');
проверить('созвон в 09:00', созвон?.start === '09:00');
проверить('созвон длится до 10:30', созвон?.end === '10:30');
проверить('созвон отнесён к работе', созвон?.category === 'work');
проверить('интернет попал в дела', интернет);
проверить('зал не потерян', зал);
проверить('покупки не потеряны', покупки);
проверить('покупки помечены как покупки', покупки?.category === 'buy');
проверить('всё поставлено на завтра', d.items.length > 0 && d.items.every(i => i.date === завтра));

console.log('\n── Расплывчатое время: должен быть вопрос ──');
const РАСПЛЫВЧАТО = 'Надо вечером как-нибудь позвонить Андрею.';
console.log(`  «${РАСПЛЫВЧАТО}»`);
const v = await разбор(РАСПЛЫВЧАТО);
показать(v);
проверить('задан уточняющий вопрос', v.question);
проверить('к вопросу есть варианты-кнопки', v.options?.length >= 2);
// Подсказка требует не терять подъём — и однажды из-за этого модель начала
// придумывать «Подъём» без времени там, где про него не говорили
проверить('подъём не выдуман на пустом месте', !v.items.some(i => /подъём/i.test(i.title ?? '')));

if (v.question) {
  console.log('\n── Ответ на вопрос продолжает разбор ──');
  const второй = await разбор(РАСПЛЫВЧАТО, [
    { role: 'assistant', content: JSON.stringify({ question: v.question, options: v.options }) },
    { role: 'user', content: v.options[v.options.length - 1] },
  ]);
  показать(второй);
  проверить('после ответа время проставлено', второй.items.some(i => i.start));
  проверить('после ответа вопроса больше нет', !второй.question);
  проверить('после ответа подъём тоже не выдуман',
    !второй.items.some(i => /подъём/i.test(i.title ?? '')));
}

console.log('\n── Итог ──');
let плохо = 0;
for (const [что, ок] of проверки) {
  console.log(`  ${ок ? '✔' : '✖'} ${что}`);
  if (!ок) плохо += 1;
}
console.log(`\n${проверки.length - плохо} из ${проверки.length}`);
process.exit(плохо ? 1 : 0);
