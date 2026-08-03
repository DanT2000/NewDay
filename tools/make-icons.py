#!/usr/bin/env python3
"""
Генерация всех иконок из одного исходника.

    python tools/make-icons.py [brand-icon.png]

Исходник — квадратный PNG, желательно 1024x1024 или больше.
Скрипт лежит в репозитории, чтобы иконку можно было заменить одной командой.

Требуется Pillow:  pip install Pillow
"""
import sys
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'brand-icon.png')

WEB = os.path.join(ROOT, 'public', 'icons')
ANDROID = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

# Обычные иконки: сколько пикселей, как назвать
WEB_SIZES = {
    'favicon.png': 32,
    'favicon-16.png': 16,
    'apple-touch-icon.png': 180,
    'logo-256.png': 256,
    'icon-192.png': 192,
    'icon-512.png': 512,
}

# Плотности Android для legacy-иконок (mipmap-*/ic_launcher.png)
ANDROID_MIPMAP = {
    'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192,
}
# Adaptive icon: холст 108dp, из них видно только центральные 72dp.
# Значит содержимое надо ужать до ~66% и положить по центру прозрачного квадрата.
ANDROID_FOREGROUND = {
    'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432,
}
SAFE_ZONE_RATIO = 0.66


def load(path):
    im = Image.open(path).convert('RGBA')
    if im.width != im.height:
        side = min(im.width, im.height)
        left = (im.width - side) // 2
        top = (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side))
    return im


def resized(im, size):
    return im.resize((size, size), Image.LANCZOS)


def inset(im, size, ratio, bg=(0, 0, 0, 0)):
    """Кладёт уменьшенную картинку в центр квадрата заданного цвета."""
    canvas = Image.new('RGBA', (size, size), bg)
    inner = int(round(size * ratio))
    offset = (size - inner) // 2
    small = resized(im, inner)
    canvas.paste(small, (offset, offset), small)
    return canvas


def edge_color(im):
    """Средний цвет по краям — им заливается фон maskable-иконки и adaptive-слой."""
    w = im.width
    px = im.load()
    step = max(1, w // 32)
    samples = []
    for i in range(0, w, step):
        for x, y in ((i, 0), (i, w - 1), (0, i), (w - 1, i)):
            r, g, b, a = px[x, y]
            if a > 200:
                samples.append((r, g, b))
    if not samples:
        return (46, 123, 228, 255)  # запасной вариант — акцентный синий
    n = len(samples)
    return (sum(s[0] for s in samples) // n,
            sum(s[1] for s in samples) // n,
            sum(s[2] for s in samples) // n, 255)


def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, 'PNG', optimize=True)
    print('  ', os.path.relpath(path, ROOT), f'{im.width}x{im.height}')


def main():
    if not os.path.exists(SRC):
        sys.exit(f'Не найден исходник: {SRC}')
    src = load(SRC)
    print(f'Исходник: {os.path.relpath(SRC, ROOT)} {src.width}x{src.height}')

    print('Веб и PWA:')
    for name, size in WEB_SIZES.items():
        save(resized(src, size), os.path.join(WEB, name))
    # maskable обрезается системой под свою форму, поэтому фон должен быть залит,
    # а содержимое — с полями, иначе по краям окажется дыра
    bg = edge_color(src)
    print(f'Фоновый цвет из иконки: #{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}')
    save(inset(src, 512, 0.80, bg), os.path.join(WEB, 'icon-maskable-512.png'))

    if os.path.isdir(os.path.join(ROOT, 'android')):
        print('Android:')
        # фоновый слой adaptive-иконки — тот же цвет
        bg_xml = os.path.join(ANDROID, 'values', 'ic_launcher_background.xml')
        os.makedirs(os.path.dirname(bg_xml), exist_ok=True)
        with open(bg_xml, 'w', encoding='utf-8') as f:
            f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                    f'    <color name="ic_launcher_background">#{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}</color>\n'
                    '</resources>\n')
        print('  ', os.path.relpath(bg_xml, ROOT))
        for density, size in ANDROID_MIPMAP.items():
            d = os.path.join(ANDROID, f'mipmap-{density}')
            save(resized(src, size), os.path.join(d, 'ic_launcher.png'))
            save(resized(src, size), os.path.join(d, 'ic_launcher_round.png'))
        for density, size in ANDROID_FOREGROUND.items():
            save(inset(src, size, SAFE_ZONE_RATIO),
                 os.path.join(ANDROID, f'mipmap-{density}', 'ic_launcher_foreground.png'))
        for name, size in (('drawable/splash.png', 960),):
            save(inset(src, size, 0.35, bg), os.path.join(ANDROID, name))
    else:
        print('Каталог android/ не найден — пропускаю нативные иконки')

    print('Готово.')


if __name__ == '__main__':
    main()
