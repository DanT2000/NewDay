/**
 * Флаги панели администратора поверх app_settings.
 *
 * Ключи собраны в одном месте, потому что их читают три разных участка —
 * страница входа, регистрация и маршруты помощника: строка-ключ,
 * повторённая в трёх файлах, однажды разъедется опечаткой.
 *
 * Про рубильник помощника: ключ называется aiAccessEnabled, а не aiEnabled,
 * потому что aiEnabled уже занят настройкой «подключение ИИ настроено»
 * (repos/appSettings) со значением по умолчанию «выключено». У рубильника
 * умолчание обратное — «включено», и делить один ключ на два смысла нельзя.
 */

const DEFAULT_ADMIN_PASSWORD = 'newday';

/** Принимает готовый appSettingsRepo, а не db: репозиторий настроек один. */
function panelSettings(settings) {
  return {
    // Отсутствие ключа значит «да»: свежий сервер ведёт себя как раньше —
    // регистрация открыта, помощник доступен всем.
    registrationOpen: () => settings.get('registrationOpen') !== '0',
    setRegistrationOpen: v => settings.set('registrationOpen', v ? '1' : '0'),

    /**
     * Тариф помощника для новичка без приглашения. Умолчание 'unlimited' —
     * то же, что у колонки users.ai_tier: сервер без этого ключа продолжает
     * вести себя как раньше. Значение проверяет роут (v.oneOf по TIERS);
     * здесь только страховка от мусора в базе — мусор читается как умолчание.
     */
    defaultAiTier: () => {
      const t = settings.get('defaultAiTier');
      return t === 'off' || t === 'limited' || t === 'unlimited' ? t : 'unlimited';
    },
    setDefaultAiTier: t => settings.set('defaultAiTier', t),

    aiSwitchOn: () => settings.get('aiAccessEnabled') !== '0',
    setAiSwitch: v => settings.set('aiAccessEnabled', v ? '1' : '0'),

    adminPasswordHash: () => settings.get('adminPasswordHash'),
    setAdminPasswordHash: hash => settings.set('adminPasswordHash', hash),

    /*
     * Ключ к подробностям здоровья.
     *
     * Само «жив или нет» открыто всем: наблюдалке нужен код ответа, и
     * закрывать его значит требовать ключ ради того, что и так видно по
     * доступности сайта. А подробности — версия схемы, длина очереди,
     * причины поломки — рассказывают о внутренностях, и их отдаём по ключу.
     * Ключ хранится хешем: сервер его не помнит, показать второй раз нельзя.
     */
    healthTokenHash: () => settings.get('healthTokenHash'),
    setHealthTokenHash: hash => settings.set('healthTokenHash', hash || ''),

    // Открыть подробности всем — осознанный выбор владельца закрытого контура
    healthOpen: () => settings.get('healthOpen') === '1',
    setHealthOpen: v => settings.set('healthOpen', v ? '1' : '0'),
  };
}

module.exports = { panelSettings, DEFAULT_ADMIN_PASSWORD };
