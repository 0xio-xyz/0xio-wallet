#!/usr/bin/env python3
"""Toolbar icons for the locked wallet.

Draws a solid white padlock with a thin black outline around its own silhouette over the bottom
right corner of the shipped toolbar icons (public/icon{16,32,48,128}.png, the 0xio logo tile from
0xio-logo/build.py) and writes public/icon-locked-{16,32,48,128}.png. No disc or badge behind it.
The tile pixels stay exactly the shipped ones, so locking only adds the padlock. The padlock is
vector geometry on a pixel grid: one grid for 16 px, one for 32 px that also scales to 48 and
128, every edge on a whole pixel, the outline flush with the icon corner, rendered at 16x and box
filtered down.

Run from the repo root (needs Pillow):
  python3 scripts/lock-icons.py                    writes the chosen variant into public/
  python3 scripts/lock-icons.py --variant P1       writes another variant into public/
  python3 scripts/lock-icons.py --sheet DIR        writes every variant and a comparison sheet to DIR
"""
import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
SIZES = (16, 32, 48, 128)
SS = 16
INK = (0, 0, 0)
PAPER = (255, 255, 255)
OUTLINE = {16: 1, 32: 2, 48: 2, 128: 5}
CHOSEN = "P2"

# body: x0 y0 x1 y1 and corner radius, shackle: x0 x1 (outer), top, stroke and outer corner
# radius, key: x0 y0 x1 y1 cut. Positions are moved so the outline sits flush in the corner.
VARIANTS = {
    "P1": {
        "label": "P1 small padlock",
        16: {"body": (9, 11, 14, 14, 0), "shackle": (10, 13, 8, 1, 1.5), "key": None},
        32: {
            "body": (18, 22, 28, 29, 1),
            "shackle": (20, 26, 16, 2, 3),
            "key": (22, 24, 24, 27),
        },
    },
    "P2": {
        "label": "P2 medium padlock",
        16: {"body": (8, 10, 14, 14, 0), "shackle": (9, 13, 7, 1, 2), "key": None},
        32: {
            "body": (16, 21, 28, 29, 1),
            "shackle": (18, 26, 14, 2, 4),
            "key": (21, 24, 23, 27),
        },
    },
    "P3": {
        "label": "P3 large padlock",
        16: {"body": (7, 9, 14, 14, 0), "shackle": (8, 13, 5, 1, 2.5), "key": (10, 11, 11, 13)},
        32: {
            "body": (14, 19, 28, 29, 1.5),
            "shackle": (16, 26, 11, 3, 5),
            "key": (20, 23, 22, 27),
        },
    },
}


def grid_for(variant, n):
    if n in (16, 32):
        g = variant[n]
    else:
        g32, k = variant[32], n / 32

        def snap(v):
            return math.floor(v * k + 0.5)

        bx0, by0, bx1, by1, br = g32["body"]
        sx0, sx1, st, sw, sr = g32["shackle"]
        g = {
            "body": (snap(bx0), snap(by0), snap(bx1), snap(by1), br * k),
            "shackle": (snap(sx0), snap(sx1), snap(st), snap(sw), sr * k),
            "key": tuple(snap(v) for v in g32["key"]) if g32["key"] else None,
        }
    w = OUTLINE[n]
    dx, dy = n - w - g["body"][2], n - w - g["body"][3]
    bx0, by0, bx1, by1, br = g["body"]
    sx0, sx1, st, sw, sr = g["shackle"]
    return {
        "body": (bx0 + dx, by0 + dy, bx1 + dx, by1 + dy, br),
        "shackle": (sx0 + dx, sx1 + dx, st + dy, sw, sr),
        "key": tuple(v + (dx, dy)[i % 2] for i, v in enumerate(g["key"])) if g["key"] else None,
        "outline": w,
        "round": n > 16,
    }


def box(x0, y0, x1, y1):
    return (x0 * SS, y0 * SS, x1 * SS - 1, y1 * SS - 1)


def silhouette(n, g):
    m = Image.new("L", (n * SS, n * SS), 0)
    d = ImageDraw.Draw(m)
    w = g["outline"]
    bx0, by0, bx1, by1, br = g["body"]
    sx0, sx1, st, sw, sr = g["shackle"]
    d.rounded_rectangle(box(sx0 - w, st - w, sx1 + w, by0 + sr + 1), radius=(sr + w) * SS, fill=255)
    corner = (br + w) * SS if g["round"] else 0
    d.rounded_rectangle(box(bx0 - w, by0 - w, bx1 + w, by1 + w), radius=corner, fill=255)
    return m.reduce(SS)


def glyph(n, g):
    m = Image.new("L", (n * SS, n * SS), 0)
    d = ImageDraw.Draw(m)
    bx0, by0, bx1, by1, br = g["body"]
    sx0, sx1, st, sw, sr = g["shackle"]
    d.rounded_rectangle(box(sx0, st, sx1, by0 + sr + 1), radius=sr * SS, fill=255)
    inner = max(0.0, sr - sw)
    d.rounded_rectangle(box(sx0 + sw, st + sw, sx1 - sw, by0 + sr + 1), radius=inner * SS, fill=0)
    d.rounded_rectangle(box(bx0, by0, bx1, by1), radius=br * SS, fill=255)
    if g["key"]:
        d.rectangle(box(*g["key"]), fill=0)
    return m.reduce(SS)


def layer(n, color, mask):
    im = Image.new("RGBA", (n, n), color + (255,))
    im.putalpha(mask)
    return im


def locked(base, variant):
    n = base.size[0]
    g = grid_for(variant, n)
    out = Image.alpha_composite(base.convert("RGBA"), layer(n, INK, silhouette(n, g)))
    return Image.alpha_composite(out, layer(n, PAPER, glyph(n, g)))


def base_icon(n):
    return Image.open(PUBLIC / f"icon{n}.png").convert("RGBA")


def render(name):
    return {n: locked(base_icon(n), VARIANTS[name]) for n in SIZES}


TOOLBARS = (("light", (241, 243, 244)), ("dark", (32, 33, 36)))


def sheet(rows, out):
    zoom, pad, label_h = 8, 24, 22
    cells = [(n, bg) for n in (16, 32) for bg in TOOLBARS]
    widths = [n * zoom + 2 * pad for n, _ in cells]
    width = max(sum(widths), 6 * (len(rows) * 40 + 24)) + 2 * pad
    row_h = 32 * zoom + 2 * pad + label_h
    im = Image.new("RGB", (width, label_h + row_h * len(rows) + 120), (250, 250, 250))
    d = ImageDraw.Draw(im)
    x = pad
    for (n, (bg_name, _)), w in zip(cells, widths):
        d.text((x + pad, 6), f"{n} px at 8x on {bg_name}", fill=(0, 0, 0))
        x += w
    for i, (label, icons) in enumerate(rows):
        y = label_h + i * row_h
        d.text((pad, y + 4), label, fill=(0, 0, 0))
        x = pad
        for (n, (_, bg)), w in zip(cells, widths):
            tile = Image.new("RGBA", (w - 8, 32 * zoom + 2 * pad - 8), bg + (255,))
            big = icons[n].resize((n * zoom, n * zoom), Image.NEAREST)
            tile.alpha_composite(big, ((w - 8 - n * zoom) // 2, (tile.size[1] - n * zoom) // 2))
            im.paste(tile.convert("RGB"), (x, y + label_h))
            x += w
    y = label_h + row_h * len(rows) + 10
    x0 = pad
    for scale, label in ((1, "1x"), (2, "2x display")):
        d.text((x0, y), f"toolbar {label}", fill=(0, 0, 0))
        for j, (_, bg) in enumerate(TOOLBARS):
            strip = Image.new("RGBA", (len(rows) * 40 * scale // 1 + 24, 36 * scale // 1), bg + (255,))
            for k, (_, icons) in enumerate(rows):
                icon = icons[16 * scale]
                strip.alpha_composite(icon, (12 + k * 40 * scale // 1, (strip.size[1] - icon.size[1]) // 2))
            im.paste(strip.convert("RGB"), (x0 + j * (strip.size[0] + 12), y + 16))
        x0 += 2 * (len(rows) * 40 * scale + 24) + 40
    im.save(out, optimize=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--variant", default=CHOSEN, choices=sorted(VARIANTS))
    p.add_argument("--sheet", type=Path)
    a = p.parse_args()
    if a.sheet:
        a.sheet.mkdir(parents=True, exist_ok=True)
        rows = [("normal (unlocked)", {n: base_icon(n) for n in SIZES})]
        for name in VARIANTS:
            icons = render(name)
            for n, icon in icons.items():
                icon.save(a.sheet / f"{name}-icon-locked-{n}.png", optimize=True)
            rows.append((VARIANTS[name]["label"], icons))
        sheet(rows, a.sheet / "lock-icon-variants.png")
        print(f"wrote {a.sheet / 'lock-icon-variants.png'}")
        return
    for n, icon in render(a.variant).items():
        icon.save(PUBLIC / f"icon-locked-{n}.png", optimize=True)
    print(f"wrote public/icon-locked-{{{','.join(map(str, SIZES))}}}.png ({a.variant})")


if __name__ == "__main__":
    main()
