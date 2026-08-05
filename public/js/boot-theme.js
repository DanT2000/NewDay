/**
 * Тема и цвет приложения до первой отрисовки.
 *
 * Обычный скрипт, а не модуль: модуль загружается отложенно, и страница
 * успевает моргнуть светлым фоном и чужим акцентом. Подключается в <head>
 * тегом <script src> — один файл вместо десяти копий одного и того же
 * inline-кода, которые неизбежно разъезжаются.
 *
 * «Системная» тема разрешается здесь же в явное light/dark: держать
 * тёмные значения дважды — в :root[data-theme] и в @media — значит
 * однажды поправить только одно место.
 */
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem('newday.theme') || 'system';
    var accent = localStorage.getItem('newday.accent') || 'violet';
    var dark = theme === 'dark'
      || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-accent', accent);
    root.style.colorScheme = dark ? 'dark' : 'light';

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#161826' : '#f3f5fe');
  } catch (e) {
    /* приватный режим без localStorage — останется тема по умолчанию */
  }
})();
