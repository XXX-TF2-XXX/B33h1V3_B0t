"""Draw the B33h1V3_B0t icon (honey hexagon on black) and save it as a multi-size .ico."""
import math
import sys

from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else "b33h1v3.ico"
S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)


def hexagon(cx, cy, r):
    return [(cx + r * math.cos(math.radians(60 * i - 30)), cy + r * math.sin(math.radians(60 * i - 30))) for i in range(6)]


d.polygon(hexagon(S / 2, S / 2, 124), fill=(18, 18, 18, 255))
d.polygon(hexagon(S / 2, S / 2, 112), fill=(255, 179, 0, 255))
d.polygon(hexagon(S / 2, S / 2, 92), fill=(18, 18, 18, 255))
try:
    font = ImageFont.truetype("consolab.ttf", 110)
except OSError:
    font = ImageFont.load_default()
d.text((S / 2, S / 2 + 4), "B3", font=font, fill=(255, 179, 0, 255), anchor="mm")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"icon: {out}")
