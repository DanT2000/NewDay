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
 */

const AI_KEYS = ['aiBaseUrl', 'aiApiKey', 'aiModel', 'aiSmartModel', 'aiVoiceModel', 'aiEnabled'];

/** Значения по умолчанию: пустая конфигурация — это выключенный ИИ. */
const AI_DEFAULTS = {
  aiEnabled: '0',
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  aiSmartModel: '',
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
      voiceReady: Boolean(c.enabled && c.baseUrl && c.voiceModel && c.apiKey),
    };
  }

  function saveAi(fields) {
    if (fields.baseUrl !== undefined) set('aiBaseUrl', String(fields.baseUrl).trim().replace(/\/+$/, ''));
    for (const [field, key] of [['model', 'aiModel'], ['smartModel', 'aiSmartModel'], ['voiceModel', 'aiVoiceModel']]) {
      if (fields[field] !== undefined) set(key, String(fields[field] ?? '').trim());
    }
    if (fields.enabled !== undefined) set('aiEnabled', fields.enabled ? '1' : '0');
    // Пустая строка означает «оставить как было»: иначе открытая форма,
    // где ключ не показан, стирала бы его при каждом сохранении.
    if (typeof fields.apiKey === 'string' && fields.apiKey.trim()) {
      set('aiApiKey', fields.apiKey.trim());
    }
    if (fields.apiKey === null) set('aiApiKey', '');
    return aiPublic();
  }

  return { get, set, aiConfig, aiPublic, saveAi };
}

module.exports = { appSettingsRepo, AI_DEFAULTS };
