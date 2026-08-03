#!/usr/bin/env python3
"""Переносит qrcode-generator в public/js/vendor и делает из UMD ES-модуль.

    npm i qrcode-generator --no-save && python tools/vendor-qr.py
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'node_modules', 'qrcode-generator', 'qrcode.js')
DST = os.path.join(ROOT, 'public', 'js', 'vendor', 'qrcode.js')

UMD_TAIL = """(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));"""

HEADER = """/*
 * qrcode-generator by Kazuhiko Arase — MIT.
 * https://github.com/kazuhikoarase/qrcode-generator
 *
 * Вендорится, чтобы страница работала без CDN и внутри офлайн-сборки под Android.
 * Обновление: npm i qrcode-generator --no-save && python tools/vendor-qr.py
 * Единственная правка — UMD-хвост заменён на `export default qrcode;`.
 */

"""

if not os.path.exists(SRC):
    sys.exit('Сначала: npm i qrcode-generator --no-save')
src = io.open(SRC, encoding='utf-8').read()
if UMD_TAIL not in src:
    sys.exit('UMD-хвост не найден — версия пакета изменилась, проверьте вручную')
os.makedirs(os.path.dirname(DST), exist_ok=True)
io.open(DST, 'w', encoding='utf-8').write(HEADER + src.replace(UMD_TAIL, 'export default qrcode;'))
print('Записано:', os.path.relpath(DST, ROOT))
