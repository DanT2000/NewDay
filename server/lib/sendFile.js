const path = require('node:path');
const { notFound, ApiError } = require('./errors');

/**
 * Отдать файл с диска, не рискуя процессом.
 *
 * `fs.createReadStream(file).pipe(res)` выглядит короче, но у него два
 * изъяна, и оба стреляют в проде. Первый: у потока нет обработчика `error`,
 * а значит ошибка чтения — нечитаемый том, удалённый между проверкой и
 * открытием файл, EMFILE — приходит необработанным исключением и убивает
 * процесс целиком, вместе с чужими сессиями и будильниками. Второй: при
 * обрыве соединения `pipe` только отсоединяет поток, файловый дескриптор
 * остаётся открытым до сборки мусора, и тысяча оборванных загрузок доводит
 * до «слишком много открытых файлов».
 *
 * `res.sendFile` закрывает оба: ошибки приходят в колбэк, поток закрывается
 * сам. Путь обязан быть абсолютным — иначе Express бросает, поэтому
 * приводим здесь, а не в каждом вызове.
 */
function sendFileSafe(res, next, file, { headers = {}, notFoundMessage = 'Файл потерян' } = {}) {
  res.sendFile(path.resolve(file), { headers }, err => {
    if (!err) return;
    /*
     * Соединение оборвано клиентом — обычное дело, а не поломка: человек
     * закрыл вкладку или ушёл в туннель. Отвечать уже некому и незачем.
     */
    if (res.headersSent || err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
      res.destroy?.();
      return;
    }
    if (err.code === 'ENOENT') { next(notFound(notFoundMessage)); return; }
    if (err.code === 'EISDIR' || err.code === 'EACCES' || err.code === 'EIO') {
      next(new ApiError(503, 'FILE_UNREADABLE', 'Файл сейчас не читается'));
      return;
    }
    next(err);
  });
}

module.exports = { sendFileSafe };
