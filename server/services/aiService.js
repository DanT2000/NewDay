/**
 * Помощник: разбор речи в план дня, причёсывание текста, распознавание.
 *
 * Провайдер OpenAI-совместимый: адрес плюс ключ. Так подходят и OpenAI,
 * и AI Tunnel, и DeepSeek, и локальная LM Studio — путь у всех один и
 * тот же.
 *
 * Подключений при этом два: текстовое и голосовое. Речь распознают не все,
 * и владелец вправе взять текст у одного провайдера, а whisper у другого,
 * со своим ключом. Пустое голосовое подключение подставляется от текстового
 * (repos/appSettings), так что для одного провайдера всё как было. Прокси
 * общие: они про сеть, а не про провайдера.
 *
 * Никакой очереди и никаких работников: обращаемся напрямую и ждём ответ.
 * Замеры (docs/стоимость.md) показали, что десять активных человек стоят
 * около ста рублей в месяц, и выстраивать вокруг этого отдельную службу
 * с ботом на компьютере было бы дороже самой экономии.
 */

const { appSettingsRepo } = require('../repos/appSettings');
const { aiUsageRepo } = require('../repos/aiUsage');
const { createAiFetch } = require('../lib/aiFetch');

const CHAT_TIMEOUT_MS = 90_000;
const VOICE_TIMEOUT_MS = 180_000;
/** Проверка связи ждёт недолго: человек стоит над кнопкой и смотрит. */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * Длинный текст модель норовит пересказать вместо того, чтобы причесать:
 * на 2135 токенов входа gpt-4o-mini выдал 121 токен ответа. Поэтому режем
 * на куски по абзацам и склеиваем обратно.
 */
const CHUNK_CHARS = 3500;

const SYSTEM = {
  parse: `Ты разбираешь свободную русскую речь в план дня приложения NewDay.
Отвечай ТОЛЬКО JSON, без пояснений и без markdown.

{"items":[{"kind":"schedule|task|reminder","title":"строка",
"start":"HH:MM|null","end":"HH:MM|null","date":"YYYY-MM-DD",
"category":"work|home|life|buy|null","repeat":"once|daily|weekly|monthly|yearly|null",
"remind":["at","5","15","30","60","day"],"alarm":"off|notify|sound|alarm"}],
"question":"уточняющий вопрос|null","options":["короткий вариант ответа"]}

Что чем является:
- schedule — занимает время в дне, есть начало;
- task — чек-лист без времени;
- reminder — привязано к моменту, может повторяться.

Обязательно:
- ПОДЪЁМ. Если человек сказал «встаю», «встать», «подъём», «просыпаюсь»,
  «проснуться», «будильник» — сделай ОТДЕЛЬНЫЙ пункт schedule с title
  "Подъём", временем из его слов и alarm:"alarm". Это главный будильник
  дня, терять его нельзя. Но если про подъём не сказано ни слова, пункта
  "Подъём" в ответе быть не должно — придуманный будильник хуже, чем
  отсутствующий.
- ДАТА у каждого пункта заполнена. «завтра» — следующий день от сегодня,
  «послезавтра» — через день, «сегодня» и когда день не назван — сегодня.
  Названный день недели — ближайший такой день, не раньше сегодня.
- ДЛИТЕЛЬНОСТЬ. «на час», «на полтора часа», «часа на два» — посчитай end
  от start. «до шести» — end 18:00.

Разделы:
- work — работа: созвоны, встречи по делу, отчёты, задачи, клиенты, коллеги;
- home — дом и быт: уборка, готовка, ремонт, стирка, счета и платежи;
- buy — покупки;
- life — своё: здоровье, спорт, учёба, друзья, семья, отдых.

Будильники: подъём — "alarm"; то, что нельзя пропустить (встреча, поезд,
лекарство) — "sound"; обычное дело — "notify"; мелочь — "off".

Уточняющий вопрос:
- если время расплывчато («вечером», «после обеда», «днём», «как-нибудь»),
  оставь start null и задай ОДИН вопрос, приложив 2-4 коротких варианта
  в options — это будут кнопки;
- вопрос задавай только про то, что действительно мешает поставить пункт
  в день. Если всё понятно, question и options — null.

Ничего не добавляй от себя: в ответе должны быть только те дела, которые
человек назвал. Речь бывает сбивчивой — «э», «ну», «короче», оговорки и
повторы пропускай, но ни одного настоящего дела не теряй. Названия пиши с большой буквы, коротко и так,
как сказал человек, а не своими словами.`,

  improve: `Ты причёсываешь надиктованный русский текст.
Убери слова-паразиты и повторы, расставь знаки препинания, раздели на
предложения и абзацы. Смысл, порядок мыслей и все числа сохрани точно.
Ничего не сокращай и не пересказывай: на выходе должен быть тот же текст,
только чистый. Ничего не добавляй от себя. Отвечай только текстом.`,
};

function aiService(db, { env = process.env, fetchImpl, now = () => Date.now() } = {}) {
  const settings = appSettingsRepo(db, { env });
  const usage = aiUsageRepo(db);
  // Прокси-перебор живёт внутри: пока прокси не заданы, это тот же
  // fetchImpl или глобальный fetch, что и раньше
  const doFetch = createAiFetch(db, { fetchImpl });

  /**
   * Последняя ошибка провайдера — для админки. Владелец, глядя на «не
   * работает», должен видеть последнюю причину, а не идти в логи.
   */
  let lastError = null;
  const remember = message => { lastError = { message, at: new Date().toISOString() }; return message; };

  /** Что показывать интерфейсу: есть ли смысл в кнопке помощника. */
  const status = () => {
    const c = settings.aiPublic();
    return { ready: c.ready, voice: c.voiceReady, model: c.model };
  };

  // ── Разговор ───────────────────────────────────────────────

  /**
   * Один запрос к модели. Возвращает `{ok, text, usage}` и никогда не
   * бросает: провайдер, который не ответил, — обычное дело, и это должно
   * стать понятной причиной для человека, а не ошибкой 500.
   */
  async function chat({ userId, kind, messages, smart = false, maxTokens }) {
    const cfg = settings.aiConfig();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) {
      return { ok: false, error: 'Помощник не подключён' };
    }
    const model = smart ? cfg.smartModel : cfg.model;
    if (!model) return { ok: false, error: 'Не выбрана модель' };

    const started = now();
    try {
      const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model, messages, stream: false, temperature: 0.1,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });

      const body = await res.json().catch(() => null);
      const ms = now() - started;

      if (!res.ok || body?.error) {
        const error = remember(reason(res.status, body));
        usage.add({ userId, kind, model, ok: false, ms });
        return { ok: false, error };
      }

      const text = body?.choices?.[0]?.message?.content ?? '';
      const u = body.usage ?? {};
      usage.add({
        userId, kind, model, ok: true, ms,
        tokensIn: u.prompt_tokens ?? u.input_tokens ?? 0,
        tokensOut: u.completion_tokens ?? u.output_tokens ?? 0,
        costRub: u.cost_rub ?? 0,
      });

      if (!text.trim()) return { ok: false, error: 'Модель вернула пустой ответ' };
      return { ok: true, text: strip(text), ms, model, cost: u.cost_rub ?? null };
    } catch (e) {
      const ms = now() - started;
      usage.add({ userId, kind, model, ok: false, ms });
      return {
        ok: false, ms,
        error: remember(e.name === 'TimeoutError' ? 'Модель не ответила вовремя' : 'Не удалось соединиться с моделью'),
      };
    }
  }

  // ── Разбор речи в план дня ─────────────────────────────────

  /**
   * `history` — предыдущие ходы того же разбора. Уточняющий вопрос делает
   * разбор двухэтапным: модель спросила, человек нажал вариант, разбор
   * продолжился. Замер показал, что второй этап стоит те же три копейки:
   * заново уезжает тот же разговор плюс одна короткая реплика.
   */
  async function parse({ userId, text, date, timezone, history = [] }) {
    const r = await chat({
      userId, kind: 'parse',
      smart: text.length > 1500,
      messages: [
        { role: 'system', content: `${SYSTEM.parse}\nСегодня ${date}. Часовой пояс ${timezone}.` },
        { role: 'user', content: text },
        ...history,
      ],
    });
    if (!r.ok) return r;

    const parsed = asJson(r.text);
    return {
      ok: true, ms: r.ms, model: r.model, cost: r.cost,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      question: parsed.question || null,
      options: Array.isArray(parsed.options) ? parsed.options.slice(0, 4) : [],
      ...(parsed.unparsed ? { unparsed: parsed.unparsed } : {}),
    };
  }

  // ── Причёсывание ───────────────────────────────────────────

  /**
   * Длинный текст обрабатываем частями. Это не оптимизация, а исправление:
   * целиком модель его пересказывает, и человек молча получает не свой
   * текст вместо своего.
   */
  async function improve({ userId, text }) {
    const parts = splitByParagraphs(String(text), CHUNK_CHARS);
    const done = [];
    let ms = 0, cost = 0;

    for (const part of parts) {
      const r = await chat({
        userId, kind: 'improve',
        smart: false,
        messages: [
          { role: 'system', content: SYSTEM.improve },
          { role: 'user', content: part },
        ],
        // Выход должен вмещать вход целиком, иначе ответ обрежется на
        // середине фразы
        maxTokens: Math.min(8000, Math.ceil(part.length / 2) + 400),
      });
      if (!r.ok) return { ...r, done: done.length, of: parts.length };
      done.push(r.text.trim());
      ms += r.ms ?? 0;
      cost += r.cost ?? 0;
    }

    return { ok: true, text: done.join('\n\n'), ms, parts: parts.length, cost: cost || null };
  }

  // ── Речь в текст ───────────────────────────────────────────

  /**
   * Речь уходит на голосовой адрес со своим ключом. Если своих нет, там
   * лежат текстовые — подстановка живёт в aiConfig(), а здесь просто
   * эффективные значения.
   */
  async function transcribe({ userId, audio, filename = 'zapis.webm', language = 'ru' }) {
    const cfg = settings.aiConfig();
    if (!cfg.enabled || !cfg.voiceBaseUrl || !cfg.voiceApiKey) return { ok: false, error: 'Помощник не подключён' };
    if (!cfg.voiceModel) return { ok: false, error: 'Не выбрана модель распознавания' };

    const form = new FormData();
    form.append('file', new Blob([audio]), filename);
    form.append('model', cfg.voiceModel);
    // Язык указываем всегда: без него на короткой фразе модель угадывает
    // и записывает русскую речь латиницей. Проверено на живом ключе.
    form.append('language', language);

    const started = now();
    try {
      const res = await doFetch(`${cfg.voiceBaseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.voiceApiKey}` },
        body: form,
        signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
      });

      const body = await res.json().catch(() => null);
      const ms = now() - started;

      if (!res.ok || body?.error) {
        usage.add({ userId, kind: 'transcribe', model: cfg.voiceModel, ok: false, ms });
        return { ok: false, error: remember(reason(res.status, body)) };
      }

      const text = String(body?.text ?? '').trim();
      usage.add({
        userId, kind: 'transcribe', model: cfg.voiceModel, ok: true, ms,
        seconds: body?.usage?.seconds ?? 0,
        costRub: body?.usage?.cost_rub ?? 0,
      });

      if (!text) return { ok: false, error: 'Ничего не расслышал' };
      return { ok: true, text, ms, model: cfg.voiceModel, cost: body?.usage?.cost_rub ?? null };
    } catch (e) {
      const ms = now() - started;
      usage.add({ userId, kind: 'transcribe', model: cfg.voiceModel, ok: false, ms });
      return {
        ok: false, ms,
        error: remember(e.name === 'TimeoutError' ? 'Распознавание не успело' : 'Не удалось отправить запись'),
      };
    }
  }

  /**
   * Проверка голосового подключения.
   *
   * Настоящей расшифровки здесь нет нарочно: распознавание тарифицируется
   * по секундам, а многие провайдеры округляют вверх, и кнопка «проверить»
   * тратила бы деньги при каждом нажатии. Спрашиваем список моделей — это
   * бесплатно и отвечает на оба вопроса сразу: адрес верный и ключ принят.
   * Идём тем же doFetch, что и настоящие запросы, — через те же прокси.
   */
  async function checkVoice() {
    const cfg = settings.aiConfig();
    if (!cfg.enabled || !cfg.voiceBaseUrl || !cfg.voiceApiKey) return { ok: false, error: 'Помощник не подключён' };
    if (!cfg.voiceModel) return { ok: false, error: 'Не выбрана модель распознавания' };

    const started = now();
    try {
      const res = await doFetch(`${cfg.voiceBaseUrl}/models`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${cfg.voiceApiKey}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const ms = now() - started;
      const body = await res.json().catch(() => null);

      // Списка моделей нет у всех подряд: у самодельных шлюзов whisper за
      // /models может не быть ничего. Признаваться в этом честнее, чем
      // объявлять живое подключение сломанным или гонять платную расшифровку.
      if (res.status === 404 || res.status === 405) {
        return {
          ok: false, ms,
          error: 'Провайдер не отдаёт список моделей — проверить голосовое подключение, не потратив денег, нечем. Просто надиктуйте что-нибудь',
        };
      }
      if (!res.ok || body?.error) return { ok: false, ms, error: remember(reason(res.status, body)) };

      const ids = Array.isArray(body?.data) ? body.data.map(m => m?.id) : [];
      return {
        ok: true, ms, model: cfg.voiceModel,
        // Список пришёл, а модели в нём нет — ключ принят, но расшифровка
        // всё равно не заработает. Пусть владелец узнает об этом сейчас.
        ...(ids.length && !ids.includes(cfg.voiceModel)
          ? { warning: `Ключ принят, но модели «${cfg.voiceModel}» в списке провайдера нет` }
          : {}),
      };
    } catch (e) {
      return {
        ok: false, ms: now() - started,
        error: remember(e.name === 'TimeoutError'
          ? 'Голосовой адрес не ответил за 15 секунд'
          : 'Не удалось соединиться с голосовым адресом'),
      };
    }
  }

  return {
    status, chat, parse, improve, transcribe, checkVoice, usage, settings, SYSTEM,
    lastError: () => lastError,
  };
}

// ── Мелочи ───────────────────────────────────────────────────

/** Некоторые модели возвращают размышления прямо в тексте. */
const strip = text => String(text)
  .replace(/<think>[\s\S]*?<\/think>/gi, '')
  .replace(/^```(?:json|markdown)?\s*\n?([\s\S]*?)\n?```$/m, '$1')
  .trim();

/**
 * Модели иногда оборачивают JSON в пояснения. Вырезаем и разбираем; если
 * не вышло — отдаём текст как есть, чтобы было видно, что ответили, а не
 * пустой экран.
 */
function asJson(text) {
  const t = strip(text);
  try { return JSON.parse(t); } catch { /* пробуем по скобкам */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* не вышло */ }
  }
  return { items: [], question: null, unparsed: t.slice(0, 500) };
}

/**
 * Резать по абзацам, а не по символам: разрыв посередине фразы модель
 * достроит по-своему, и склеенный текст будет с швом.
 */
function splitByParagraphs(text, limit) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = '';
  for (const block of text.split(/\n\s*\n/)) {
    if (current && current.length + block.length + 2 > limit) { parts.push(current); current = ''; }
    current = current ? `${current}\n\n${block}` : block;
    // Один абзац длиннее предела — режем по предложениям
    while (current.length > limit) {
      const cut = current.lastIndexOf('. ', limit);
      const at = cut > limit / 2 ? cut + 1 : limit;
      parts.push(current.slice(0, at).trim());
      current = current.slice(at).trim();
    }
  }
  if (current) parts.push(current);
  return parts;
}

function reason(status, body) {
  const detail = String(body?.error?.message || body?.message || '').replace(/\s+/g, ' ').slice(0, 160);
  if (status === 401 || status === 403) return 'Ключ не принят';
  if (status === 402) return 'На счету провайдера закончились деньги';
  if (status === 404) return 'Такой модели у провайдера нет';
  if (status === 429) return 'Слишком много запросов, провайдер просит подождать';
  return `Провайдер ответил ${status}${detail ? ': ' + detail : ''}`;
}

module.exports = { aiService, SYSTEM, splitByParagraphs, asJson };
