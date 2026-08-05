/**
 * Настройки экземпляра: ключ — значение.
 *
 * Сюда попадает то, что задаёт владелец сервера, а не пользователь.
 * Первый случай — подключение ИИ: одна модель на всех.
 */

const AI_KEYS = ['aiBaseUrl', 'aiApiKey', 'aiModel', 'aiEnabled'];

/** Значения по умолчанию: пустая конфигурация — это выключенный ИИ. */
const AI_DEFAULTS = {
  aiEnabled: '0',
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
};

function appSettingsRepo(db) {
  const get = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;

  const set = (key, value) => {
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, value === null || value === undefined ? null : String(value));
  };

  /** Сырая конфигурация ИИ — только для серверного кода. */
  function aiConfig() {
    const out = { ...AI_DEFAULTS };
    for (const k of AI_KEYS) {
      const v = get(k);
      if (v !== null) out[k] = v;
    }
    return {
      enabled: out.aiEnabled === '1',
      baseUrl: out.aiBaseUrl,
      apiKey: out.aiApiKey,
      model: out.aiModel,
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
      hasKey: Boolean(c.apiKey),
      keyTail: c.apiKey ? c.apiKey.slice(-4) : '',
      ready: Boolean(c.enabled && c.baseUrl && c.model),
    };
  }

  function saveAi(fields) {
    if (fields.baseUrl !== undefined) set('aiBaseUrl', String(fields.baseUrl).trim().replace(/\/+$/, ''));
    if (fields.model !== undefined) set('aiModel', String(fields.model).trim());
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

module.exports = { appSettingsRepo };
