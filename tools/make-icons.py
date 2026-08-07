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

"""
`--android-only` нужен затем, что источники у иконок разные.

Иконка запуска на телефоне — светлая: на рабочем столе Android она соседствует
с чужими значками, и тёмная плашка среди них выглядит дырой. Страницы входа в
вебе берут светлый вариант в разметке, а тёмная тема подменяет его через CSS.
Поэтому одна команда правит только нативные иконки, не задевая веб.

`--night <тёмный.png>` добавляет ночной экран запуска: на телефоне с тёмной
темой светлый сплеш, за которым идёт тёмная страница входа, читается как «две
разные картинки». Иконку запуска ночной вариант не трогает — она остаётся
светлой всегда.
"""
ANDROID_ONLY = '--android-only' in sys.argv
NIGHT_SRC = None
if '--night' in sys.argv:
    i = sys.argv.index('--night')
    if i + 1 < len(sys.argv):
        NIGHT_SRC = sys.argv[i + 1]
args = [a for a in sys.argv[1:] if not a.startswith('--') and a != NIGHT_SRC]
SRC = args[0] if args else os.path.join(ROOT, 'brand-icon.png')

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

    bg = edge_color(src)
    print(f'Фоновый цвет из иконки: #{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}')

    if ANDROID_ONLY:
        print('Только Android: веб-иконки не трогаю')
    else:
        print('Веб и PWA:')
        for name, size in WEB_SIZES.items():
            save(resized(src, size), os.path.join(WEB, name))
        # maskable обрезается системой под свою форму, поэтому фон должен быть залит,
        # а содержимое — с полями, иначе по краям окажется дыра
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
        """
        Экран запуска — во всех вариантах сразу.

        Android выбирает `@drawable/splash` по уточнителям, и портретный
        `drawable-port-xxxhdpi` перебивает обычный `drawable`. Раньше правился
        только обычный, а в портретных лежала синяя заглушка Capacitor — и при
        запуске человек видел сначала чужой логотип, потом наш. Поэтому пишем
        все варианты одним и тем же.

        Ещё нужен `splash_icon`: на Android 12 и новее систему не обмануть
        картинкой в фоне окна — она рисует свой экран запуска и берёт для него
        отдельную иконку.
        """
        for size in (960,):
            splash = inset(src, size, 0.35, bg)
            save(splash, os.path.join(ANDROID, 'drawable/splash.png'))
            for orient in ('port', 'land'):
                for density in ANDROID_MIPMAP:
                    save(splash, os.path.join(ANDROID, f'drawable-{orient}-{density}', 'splash.png'))
        # иконка для системного экрана запуска: холст 288dp, содержимое в центре
        save(inset(src, 576, 0.62), os.path.join(ANDROID, 'drawable/splash_icon.png'))

        # цвет фона системного экрана запуска — отдельным именем: он не может
        # делить имя с ic_launcher_background, иначе ночной вариант затемнил бы
        # и иконку запуска, а она остаётся светлой всегда
        def write_color(dirname, color):
            path = os.path.join(ANDROID, dirname, 'splash_background.xml')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                        f'    <color name="splash_background">'
                        f'#{color[0]:02X}{color[1]:02X}{color[2]:02X}</color>\n'
                        '</resources>\n')
            print('  ', os.path.relpath(path, ROOT))
        write_color('values', bg)

        """
        Ночной экран запуска.

        На телефоне с тёмной темой светлый сплеш, за которым открывается тёмная
        страница, читается как «две разные картинки». Android сам выбирает
        ресурсы с уточнителем -night, когда тема тёмная, — кладём туда тёмный
        вариант того же логотипа. Порядок уточнителей в имени каталога жёсткий:
        ориентация раньше ночного режима, ночной режим раньше плотности.
        """
        if NIGHT_SRC:
            if not os.path.exists(NIGHT_SRC):
                sys.exit(f'Не найден ночной исходник: {NIGHT_SRC}')
            night = load(NIGHT_SRC)
            nbg = edge_color(night)
            print(f'Ночной фон из иконки: #{nbg[0]:02X}{nbg[1]:02X}{nbg[2]:02X}')
            write_color('values-night', nbg)
            nsplash = inset(night, 960, 0.35, nbg)
            save(nsplash, os.path.join(ANDROID, 'drawable-night/splash.png'))
            for orient in ('port', 'land'):
                for density in ANDROID_MIPMAP:
                    save(nsplash, os.path.join(
                        ANDROID, f'drawable-{orient}-night-{density}', 'splash.png'))
            save(inset(night, 576, 0.62),
                 os.path.join(ANDROID, 'drawable-night/splash_icon.png'))
    else:
        print('Каталог android/ не найден — пропускаю нативные иконки')

    print('Готово.')


if __name__ == '__main__':
    main()
