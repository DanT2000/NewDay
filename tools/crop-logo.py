#!/usr/bin/env python3
"""
Обрезка логотипа из присланных картинок и раскладка по нужным размерам.

    python tools/crop-logo.py "путь/тёмный.png" "путь/светлый.png"

Логотип нарисован плиткой со скруглением, но лежит на подложке: тёмный — на
чёрном, светлый — на белом. Нужен сам знак, обрезанный по плитке, с прозрачными
углами: тогда он ложится на любой фон и не тащит за собой чужую подложку.

Границы и скругление ищем по тёмной картинке: на чёрном фоне край плитки виден
однозначно. К светлой применяем те же числа — у неё край размыт свечением, и
искать его отдельно значит получить другую обрезку у пары, которая должна
совпадать.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'icons'
# Большие версии знака — исходники, а не то, что раздаётся. В public/ они
# никуда не подключались, но попадали и в кеш браузера, и внутрь APK: два
# мегабайта, которые никто не открывает.
BRAND = ROOT / 'brand'

# Что делаем из знака. Имена — те, что уже ждут разметка и манифест.
SIZES = {
    'icon-512.png': 512,
    'icon-192.png': 192,
    'logo-256.png': 256,
    'apple-touch-icon.png': 180,
    'favicon.png': 32,
    'favicon-16.png': 16,
}


def tile_box(img, bg_is_dark=True):
    """Границы плитки: отступаем от подложки, а не от края картинки."""
    gray = img.convert('L')
    w, h = gray.size
    px = gray.load()
    # порог с запасом: у подложки значения близки к 0 (или к 255 у светлой)
    def solid(v):
        return v > 24 if bg_is_dark else v < 231

    left, right, top, bottom = w, -1, h, -1
    for y in range(h):
        for x in range(w):
            if solid(px[x, y]):
                if x < left: left = x
                if x > right: right = x
                if y < top: top = y
                if y > bottom: bottom = y
    return left, top, right + 1, bottom + 1


def corner_radius(img, box, bg_is_dark=True):
    """
    Скругление: идём по верхней кромке плитки и смотрим, где она начинается.
    Радиус — это сдвиг первой закрашенной точки от левого края плитки.
    """
    gray = img.convert('L')
    px = gray.load()
    left, top, right, bottom = box
    def solid(v):
        return v > 24 if bg_is_dark else v < 231

    # в первой строке плитки закрашенная часть начинается со смещением ≈ радиусу
    for x in range(left, right):
        if solid(px[x, top + 1]):
            return max(0, x - left)
    return 0


def rounded(img, radius):
    """Прозрачные углы: маска со скруглением того же радиуса."""
    img = img.convert('RGBA')
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1],
                                          radius=radius, fill=255)
    # мягкая кромка: без неё на светлом фоне видна ступенька
    mask = mask.filter(ImageFilter.GaussianBlur(0.6))
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    dark_src, light_src = Path(sys.argv[1]), Path(sys.argv[2])

    dark = Image.open(dark_src).convert('RGBA')
    light = Image.open(light_src).convert('RGBA')
    if dark.size != light.size:
        light = light.resize(dark.size, Image.LANCZOS)

    box = tile_box(dark, bg_is_dark=True)
    radius = corner_radius(dark, box, bg_is_dark=True)
    side = min(box[2] - box[0], box[3] - box[1])
    # ровный квадрат: у присланных картинок кромка на пиксель-два несимметрична
    box = (box[0], box[1], box[0] + side, box[1] + side)
    print(f'плитка: {box}, сторона {side}, скругление {radius} '
          f'({radius / side * 100:.1f}% стороны)')

    OUT.mkdir(parents=True, exist_ok=True)
    BRAND.mkdir(parents=True, exist_ok=True)
    for name, src in (('dark', dark), ('light', light)):
        tile = rounded(src.crop(box), radius)
        big = BRAND / f'logo-{name}-1024.png'
        tile.resize((1024, 1024), Image.LANCZOS).save(big)
        print('  ', big.relative_to(ROOT))

    # Иконки приложения — из тёмного: он читается и на светлом фоне,
    # а светлый на светлом растворяется
    tile = rounded(dark.crop(box), radius)
    for name, size in SIZES.items():
        tile.resize((size, size), Image.LANCZOS).save(OUT / name)
        print('  ', (OUT / name).relative_to(ROOT), f'{size}x{size}')

    # Маскируемая иконка Android: систему нельзя ограничить формой, она обрежет
    # как захочет — кругом, квадратом, каплей. Поэтому знак уменьшаем до
    # безопасной зоны и кладём на сплошную подложку его же цвета.
    plain = dark.crop(box)
    fill = plain.convert('RGB').getpixel((int(side * 0.5), int(side * 0.06)))
    mask_icon = Image.new('RGBA', (512, 512), (*fill, 255))
    # углы уменьшенной плитки делаем прозрачными: иначе на подложке виден
    # чёрный квадрат от исходной картинки
    inner = rounded(plain, radius).resize((400, 400), Image.LANCZOS)
    mask_icon.paste(inner, (56, 56), inner)
    mask_icon.save(OUT / 'icon-maskable-512.png')
    print('  ', (OUT / 'icon-maskable-512.png').relative_to(ROOT), 'подложка', fill)

    # Светлый знак нужен разметке для светлой темы
    light_tile = rounded(light.crop(box), radius)
    for size in (256, 64):
        light_tile.resize((size, size), Image.LANCZOS).save(OUT / f'logo-light-{size}.png')
        print('  ', (OUT / f'logo-light-{size}.png').relative_to(ROOT))
    for size in (256, 64):
        tile.resize((size, size), Image.LANCZOS).save(OUT / f'logo-dark-{size}.png')
        print('  ', (OUT / f'logo-dark-{size}.png').relative_to(ROOT))


if __name__ == '__main__':
    main()
