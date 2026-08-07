/**
 * Настройки экземпляра: ключ — значение.
 *
 * Сюда попадает то, что задаёт владелец сервера, а не пользователь.
 * Первый случай — подключение ИИ: одна модель на всех.
 *
 * Моделей три, потому что задачи разные. Быстрая причёсывает фразу,
 * умная разбирает длинный текст, голосовая слушает речь — и стоят они
 * по-разному. Одна модель на всё либо дорога там, где не надо, либо
 * слаба там, где надо.
 *
 * У распознавания речи вдобавок своё подключение: адрес и ключ. Текст и
 * whisper не обязаны жить у одного провайдера — текст дешевле взять в
 * агрегаторе, а речь у того, кто её умеет. Пустой aiVoiceBaseUrl или
 * пустой aiVoiceApiKey означают «то же, что у текста»: уже настроенные
 * установки продолжают работать, а заполнять второй раз одно и то же
 * большинству не нужно.
 */

const AI_KEYS = [
  'aiBaseUrl', 'aiApiKey', 'aiModel', 'aiSmartModel',
  'aiVoiceBaseUrl', 'aiVoiceApiKey', 'aiVoiceModel', 'aiEnabled',
];

/** Значения по умолчанию: пустая конфигурация — это выключенный ИИ. */
const AI_DEFAULTS = {
  aiEnabled: '0',
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  aiSmartModel: '',
  aiVoiceBaseUrl: '',
  aiVoiceApiKey: '',
  aiVoiceModel: '',
};

/**
 * Первичные значения из окружения. Так свежий сервер уже работает после
 * развёртывания, а поменять всё равно можно в админке, не перезапуская
 * контейнер: сохранённое в базе всегда сильнее переменной.
 */
function fromEnv(env) {
  return {
    aiBaseUrl: env.AI_BASE_URL || '',
    aiApiKey: env.AI_API_KEY || '',
    aiModel: env.AI_MODEL || '',
    aiSmartModel: env.AI_SMART_MODEL || '',
    aiVoiceBaseUrl: env.AI_VOICE_BASE_URL || '',
    aiVoiceApiKey: env.AI_VOICE_API_KEY || '',
    aiVoiceModel: env.AI_VOICE_MODEL || '',
    aiEnabled: env.AI_API_KEY ? '1' : '',
  };
}

function appSettingsRepo(db, { env = process.env } = {}) {
  const defaults = { ...AI_DEFAULTS };
  for (const [k, v] of Object.entries(fromEnv(env))) if (v) defaults[k] = v;

  const get = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;

  const set = (key, value) => {
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, value === null || value === undefined ? null : String(value));
  };

  /** Сырая конфигурация ИИ — только для серверного кода. */
  function aiConfig() {
    const out = { ...defaults };
    for (const k of AI_KEYS) {
      const v = get(k);
      if (v !== null) out[k] = v;
    }
    return {
      enabled: out.aiEnabled === '1',
      baseUrl: out.aiBaseUrl,
      apiKey: out.aiApiKey,
      model: out.aiModel,
      // Не задана умная — работает обычная. Не задана голосовая — речь
      // не распознаём: подсунуть текстовую модель звук нельзя.
      smartModel: out.aiSmartModel || out.aiModel,
      voiceModel: out.aiVoiceModel,
      // Эффективные адрес и ключ распознавания: чего нет своего — берём
      // от текста. Каждое поле подставляется само по себе, чтобы можно
      // было сменить только ключ, оставив адрес общим, и наоборот.
      voiceBaseUrl: out.aiVoiceBaseUrl || out.aiBaseUrl,
      voiceApiKey: out.aiVoiceApiKey || out.aiApiKey,
      // Заданное руками — отдельно: по нему админка показывает, где
      // подстановка, а где настоящее второе подключение.
      voiceOwnBaseUrl: out.aiVoiceBaseUrl,
      voiceOwnApiKey: out.aiVoiceApiKey,
    };
  }

  /**
   * То же для интерфейса: ключ наружу не отдаётся.
   * Показываем только, задан ли он, и хвост — чтобы человек узнал свой,
   * не раскрывая его целиком.
   */
  function aiPublic() {
    const c = aiConfig();
    return {
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      model: c.model,
      smartModel: c.smartModel,
      voiceModel: c.voiceModel,
      hasKey: Boolean(c.apiKey),
      keyTail: c.apiKey ? c.apiKey.slice(-4) : '',
      ready: Boolean(c.enabled && c.baseUrl && c.model && c.apiKey),
      // Показываем то, куда запросы пойдут на самом деле, — с подстановкой:
      // иначе при пустых полях админка рисовала бы «не задано» рядом с
      // работающим распознаванием.
      voiceBaseUrl: c.voiceBaseUrl,
      voiceKeySet: Boolean(c.voiceApiKey),
      voiceKeyTail: c.voiceApiKey ? c.voiceApiKey.slice(-4) : '',
      voiceOwn: Boolean(c.voiceOwnBaseUrl || c.voiceOwnApiKey),
      voiceReady: Boolean(c.enabled && c.voiceBaseUrl && c.voiceModel && c.voiceApiKey),
    };
  }

  function saveAi(fields) {
    // Пустой голосовой адрес — не поломка, а возврат к подстановке от текста
    for (const [field, key] of [['baseUrl', 'aiBaseUrl'], ['voiceBaseUrl', 'aiVoiceBaseUrl']]) {
      if (fields[field] !== undefined) set(key, String(fields[field] ?? '').trim().replace(/\/+$/, ''));
    }
    for (const [field, key] of [['model', 'aiModel'], ['smartModel', 'aiSmartModel'], ['voiceModel', 'aiVoiceModel']]) {
      if (fields[field] !== undefined) set(key, String(fields[field] ?? '').trim());
    }
    if (fields.enabled !== undefined) set('aiEnabled', fields.enabled ? '1' : '0');
    // Пустая строка означает «оставить как было»: иначе открытая форма,
    // где ключ не показан, стирала бы его при каждом сохранении.
    // null — «стереть»; для голосового это ещё и «вернуться к текстовому».
    for (const [field, key] of [['apiKey', 'aiApiKey'], ['voiceApiKey', 'aiVoiceApiKey']]) {
      if (typeof fields[field] === 'string' && fields[field].trim()) set(key, fields[field].trim());
      if (fields[field] === null) set(key, '');
    }
    return aiPublic();
  }

  return { get, set, aiConfig, aiPublic, saveAi };
}

module.exports = { appSettingsRepo, AI_DEFAULTS };
