#!/usr/bin/env python3
"""CoVibe icon — stylized C+V monogram on a dark rounded tile (512→256)."""
import math
from PIL import Image, ImageDraw

S = 512


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # dark tile with subtle gradient (top #12161c → bottom #0a0e13)
    for y in range(S):
        col = lerp((18, 22, 28), (10, 14, 19), y / S) + (255,)
        d.line([(0, y), (S, y)], fill=col)
    # rounded mask
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((8, 8, S - 8, S - 8), radius=104, fill=255)
    im.putalpha(Image.composite(im.getchannel("A"), Image.new("L", (S, S), 0), mask))

    # ── C: gradient arc (green → teal), opening toward the right ──
    cx, cy, r, w = 214, 256, 122, 58
    start, end = -52, 52            # gap on the right (where V sits)
    steps = 90
    span = (start % 360) - (end % 360) + 360
    c1, c2 = (46, 160, 67), (0, 208, 153)
    for i in range(steps):
        t = i / (steps - 1)
        a0 = start + span * t
        a1 = a0 + span / steps * 1.6
        d.arc((cx - r, cy - r, cx + r, cy + r), a0, a1, fill=lerp(c1, c2, t), width=w)

    # ── V: two gradient strokes (teal → azure), overlapping the C gap ──
    v1, v2 = (0, 208, 153), (56, 166, 255)
    pts_left, pts_right, apex = (316, 148), (438, 148), (377, 372)
    stroke = 52
    for i in range(steps):
        t = i / (steps - 1)
        ax, ay = pts_left, pts_right
        # left leg downward
        x = ax[0] + (apex[0] - ax[0]) * t
        y = ax[1] + (apex[1] - ax[1]) * t
        d.ellipse((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2), fill=lerp(v1, v2, t))
        # right leg upward (reflected)
        x2 = pts_right[0] + (apex[0] - pts_right[0]) * (1 - t)
        y2 = pts_right[1] + (apex[1] - pts_right[1]) * (1 - t)
        d.ellipse((x2 - stroke / 2, y2 - stroke / 2, x2 + stroke / 2, y2 + stroke / 2),
                  fill=lerp(v1, v2, 1 - t))

    # vibe dot: small pulse node at the V apex
    d.ellipse((apex[0] - 16, apex[1] - 16, apex[0] + 16, apex[1] + 16), fill=(255, 214, 0, 255))

    # UI-level downscale → crisp edges
    out = im.resize((256, 256), Image.LANCZOS)
    out.save("/home/runner/workspace/Colab/extension/resources/icon.png")
    print("icon.png written")


if __name__ == "__main__":
    draw()
