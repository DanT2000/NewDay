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

    aiSwitchOn: () => settings.get('aiAccessEnabled') !== '0',
    setAiSwitch: v => settings.set('aiAccessEnabled', v ? '1' : '0'),

    adminPasswordHash: () => settings.get('adminPasswordHash'),
    setAdminPasswordHash: hash => settings.set('adminPasswordHash', hash),
  };
}

module.exports = { panelSettings, DEFAULT_ADMIN_PASSWORD };
