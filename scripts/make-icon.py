"""Draw gitidor's source icon: a paper-white tile, a column rule, a caret.

Run once; `npm run tauri icon src-tauri/icons/source.png` turns the result
into every size Tauri bundles (icns, ico, iOS asset catalogue).
"""
import sys
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# The tile.
d.rounded_rectangle((64, 64, S - 64, S - 64), radius=200, fill=(250, 249, 246, 255))
# Three columns, as the interface has: two quiet rules, then text.
d.rounded_rectangle((196, 232, 236, 792), radius=20, fill=(214, 211, 204, 255))
d.rounded_rectangle((300, 232, 340, 792), radius=20, fill=(214, 211, 204, 255))
for i, w in enumerate([420, 360, 400, 250]):
    y = 262 + i * 110
    d.rounded_rectangle((420, y, 420 + w, y + 44), radius=22, fill=(60, 60, 64, 255))
# iA's blue caret.
d.rounded_rectangle((690, 592, 716, 760), radius=12, fill=(32, 136, 255, 255))
img.save(sys.argv[1])
