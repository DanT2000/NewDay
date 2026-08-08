/**
 * Выбор сервера на входе и при регистрации — как в Bitwarden.
 *
 * Два варианта, один выбран: «NewDay» и «Свой сервер». Поле для адреса
 * появляется только под вторым — и появляется пустым. Раньше поле разворачивалось
 * уже заполненным нашим же адресом, и это читалось так, будто оно было там
 * всегда, а «свой сервер» просто добавляет строчку ввода. Своего адреса в нём не
 * видно, а чужой надо сначала стереть.
 *
 * Заодно закрыта ловушка: адрес из поля уходил в запрос, даже когда поле было
 * скрыто. Свернул обратно — а сервер остался чужим. Теперь адрес берётся из
 * выбранного варианта, а не из того, что осталось в поле.
 *
 * Показываем это только в приложении: в браузере страница уже лежит на нужном
 * сервере, и выбирать нечего.
 */

export const DEFAULT_BASE = 'https://newday.appswire.ru';

const clean = url => String(url || '').trim().replace(/\/+$/, '');

/**
 * @param {object} opts
 * @param {HTMLElement} opts.mount  куда поставить переключатель
 * @param {HTMLElement} opts.group  блок с полем адреса (скрыт по умолчанию)
 * @param {HTMLInputElement} opts.input  само поле адреса
 * @returns {{ base: () => string, custom: () => boolean }}
 */
export function mountServerPick({ mount, group, input }) {
  const saved = clean(localStorage.getItem('newday.apiBase'));
  // Свой сервер — только если сохранён именно чужой адрес
  let custom = Boolean(saved) && saved !== DEFAULT_BASE;

  const ours = document.createElement('button');
  ours.type = 'button';
  ours.className = 'srv-opt';
  ours.append(Object.assign(document.createElement('b'), { textContent: 'NewDay' }));
  ours.append(Object.assign(document.createElement('span'), { textContent: 'сервер по умолчанию' }));

  const mine = document.createElement('button');
  mine.type = 'button';
  mine.className = 'srv-opt';
  mine.append(Object.assign(document.createElement('b'), { textContent: 'Свой сервер' }));
  mine.append(Object.assign(document.createElement('span'), { textContent: 'если NewDay стоит у вас' }));

  const row = document.createElement('div');
  row.className = 'srv-pick';
  row.append(ours, mine);
  mount.replaceChildren(row);
  mount.hidden = false;

  function paint() {
    ours.setAttribute('aria-pressed', String(!custom));
    mine.setAttribute('aria-pressed', String(custom));
    group.hidden = !custom;
    /*
     * required только у видимого поля: у скрытого браузер отказывается
     * показать подсказку и молча блокирует отправку — форма выглядит сломанной.
     */
    input.required = custom;
  }

  ours.addEventListener('click', () => {
    if (!custom) return;
    custom = false;
    // Поле чистим: остаться там чужой адрес не должен даже невидимым
    input.value = '';
    paint();
  });

  mine.addEventListener('click', () => {
    if (custom) return;
    custom = true;
    paint();
    input.focus();
  });

  // Уже настроенный свой адрес показываем в поле — его задал человек
  input.value = custom ? saved : '';
  paint();

  return {
    custom: () => custom,
    base: () => (custom ? clean(input.value) || DEFAULT_BASE : DEFAULT_BASE),
  };
}
