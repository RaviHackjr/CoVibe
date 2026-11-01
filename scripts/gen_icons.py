#!/usr/bin/env python3
"""Generate resources/icon.png (128x128) using pure stdlib (zlib+struct)."""
import math
import struct
import zlib
import sys

W = H = 128
px = [[None] * W for _ in range(H)]


def put(x, y, rgba):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = rgba


def rounded_rect_mask(x, y, x0, y0, x1, y1, r):
    if not (x0 + r <= x <= x1 - r or x0 <= x <= x1):
        pass
    inside_h = x0 <= x <= x1
    inside_v = y0 <= y <= y1
    if not (inside_h and inside_v):
        return False
    # corner check
    corners = [
        (x0 + r, y0 + r, lambda cx, cy: (x - cx) ** 2 + (y - cy) ** 2 <= r * r),
        (x1 - r, y0 + r, lambda cx, cy: (x - cx) ** 2 + (y - cy) ** 2 <= r * r),
        (x0 + r, y1 - r, lambda cx, cy: (x - cx) ** 2 + (y - cy) ** 2 <= r * r),
        (x1 - r, y1 - r, lambda cx, cy: (x - cx) ** 2 + (y - cy) ** 2 <= r * r),
    ]
    for cx, cy, cond in corners:
        if (x < cx and y < cy) or (x > cx and y < cy) or (x < cx and y > cy) or (x > cx and y > cy):
            # top-left, top-right, bottom-left, bottom-right checks individually
            pass
    # simple: check 4 corners
    if x - (x0 + r) < 0 and y - (y0 + r) < 0:
        return (x - (x0 + r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
    if (x1 - r) - x < 0 and y - (y0 + r) < 0:
        return (x - (x1 - r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
    if x - (x0 + r) < 0 and (y1 - r) - y < 0:
        return (x - (x0 + r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
    if (x1 - r) - x < 0 and (y1 - r) - y < 0:
        return (x - (x1 - r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
    return True


def lerp(a, b, t):
    return int(a + (b - a) * t)


def c1(c, t):
    return (lerp(c[0][0], c[1][0], t), lerp(c[0][1], c[1][1], t), lerp(c[0][2], c[1][2], t))


TL = (41, 182, 246)     # light blue
BR = (38, 70, 160)      # deep blue
TR = (56, 142, 60)      # teal green
BL = (142, 36, 170)     # purple

for yy in range(H):
    for xx in range(W):
        if not rounded_rect_mask(xx, yy, 4, 4, W - 5, H - 5, 24):
            continue
        tx = xx / (W - 1)
        ty = yy / (H - 1)
        top = c1([TL, TR], tx)
        bot = c1([BL, BR], tx)
        col = c1([top, bot], ty)
        put(xx, yy, (*col, 255))

# Play triangle (centered, nudged right like a "run" arrow)
cx0, cy0, size = 34, 36, 56


def tri_inside(x, y):
    ax, ay = cx0, cy0
    bx, by = cx0, cy0 + size
    cx, cy = cx0 + size * 0.88, cy0 + size / 2
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by) if False else 0
    s = (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) / 2
    s1 = ((x - bx) * (cy - by) - (cx - bx) * (y - by))
    s2 = ((x - cx) * (ay - cy) - (ax - cx) * (y - cy))
    s3 = ((x - cx) * (by - cy) - (bx - cx) * (y - cy))
    neg = s1 < 0 or s2 < 0 or s3 < 0
    pos = s1 > 0 or s2 > 0 or s3 > 0
    return not (neg and pos)


for yy in range(H):
    for xx in range(W):
        if tri_inside(xx, yy):
            px[yy][xx] = (255, 255, 255, 255)

# small drive-ish bar icon bottom-left
for yy in range(96, 112):
    for xx in range(30, 98):
        if 34 <= xx <= 94:
            alpha = 230 if 6 <= yy - 96 or yy - 96 <= 14 else 210
            px[yy][xx] = (255, 255, 255, alpha) if (yy - 96) not in (12, 13) else (60, 120, 200, 255)


def encode_png(rgb_rows):
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)  # RGBA 8bit
    raw = b""
    for row in rgb_rows:
        raw += b"\x00"  # filter none
        for x in range(W):
            p = row[x] or (0, 0, 0, 0)
            raw += bytes(p)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


with open(sys.argv[1] if len(sys.argv) > 1 else "resources/icon.png", "wb") as f:
    f.write(encode_png(px))
print("icon.png written")
