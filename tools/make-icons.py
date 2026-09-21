#!/usr/bin/env python3
"""Generate the app icons (no image libraries needed).

Draws a simple book-spine mark on a warm dark ground and writes the PNG
sizes iOS and the web manifest ask for.
"""
import struct, zlib, os

BG = (107, 69, 80)       # fig
PAGE = (247, 238, 230)   # cream
SPINE = (86, 107, 68)    # moss
MARK = (86, 107, 68)

def draw(size, padding_ratio=0.16):
    px = [[BG for _ in range(size)] for _ in range(size)]
    pad = int(size * padding_ratio)
    w = size - 2 * pad
    h = w
    top = (size - h) // 2
    spine_w = max(2, int(w * 0.18))
    radius = max(1, int(w * 0.06))

    for y in range(top, top + h):
        for x in range(pad, pad + w):
            # rounded corners on the outer block
            cx = min(max(x, pad + radius), pad + w - 1 - radius)
            cy = min(max(y, top + radius), top + h - 1 - radius)
            if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                continue
            px[y][x] = SPINE if x < pad + spine_w else PAGE

    # three "text" rules on the page block
    line_x0 = pad + spine_w + int(w * 0.12)
    line_x1 = pad + int(w * 0.54)  # stop short of the bookmark ribbon
    thick = max(1, int(h * 0.045))
    for i, frac in enumerate((0.30, 0.46, 0.62)):
        y0 = top + int(h * frac)
        x1 = line_x1 if i < 2 else line_x0 + int((line_x1 - line_x0) * 0.55)
        for y in range(y0, y0 + thick):
            for x in range(line_x0, x1):
                px[y][x] = MARK

    # bookmark ribbon hanging off the top
    rib_x = pad + w - int(w * 0.30)
    rib_w = max(2, int(w * 0.12))
    rib_bottom = top + int(h * 0.86)
    for y in range(top, rib_bottom):
        for x in range(rib_x, rib_x + rib_w):
            px[y][x] = SPINE
    notch = int(rib_w * 0.9)
    for i in range(notch):
        for x in range(rib_x + i, rib_x + rib_w - i):
            px[rib_bottom - 1 - i][x] = PAGE
    return px

def write_png(path, px):
    size = len(px)
    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    for size in (180, 192, 512):
        write_png(os.path.join(out, f"icon-{size}.png"), draw(size))
    # maskable needs more breathing room inside the safe zone
    write_png(os.path.join(out, "icon-512-maskable.png"), draw(512, padding_ratio=0.26))
    print("wrote icons")
