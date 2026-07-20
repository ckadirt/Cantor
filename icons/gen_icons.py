#!/usr/bin/env python3
"""Generate Cantor Android launcher icon sources from icons/cantor-glyph.svg."""
import re, os, math

GLYPH = "/home/ckadirt/projects/step-ace 1.5/acestep-fable/icons/cantor-glyph.svg"
RES = "/home/ckadirt/projects/step-ace 1.5/acestep-fable/cantor/android/app/src/main/res"
SCRATCH = os.path.dirname(os.path.abspath(__file__))

rects = []
with open(GLYPH) as f:
    for m in re.finditer(r'<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"', f.read()):
        rects.append(tuple(float(v) for v in m.groups()))

assert len(rects) == 29, f"expected 29 rects, got {len(rects)}"

C = 256.0  # center of the 512 viewbox

def scaled(rects, s):
    out = []
    for x, y, w, h, r in rects:
        out.append((C + (x - C) * s, C + (y - C) * s, w * s, h * s, r * s))
    return out

def rounded_rect_path(x, y, w, h, r):
    f = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")
    return (f"M{f(x+r)},{f(y)} L{f(x+w-r)},{f(y)} A{f(r)},{f(r)} 0 0 1 {f(x+w)},{f(y+r)} "
            f"L{f(x+w)},{f(y+h-r)} A{f(r)},{f(r)} 0 0 1 {f(x+w-r)},{f(y+h)} "
            f"L{f(x+r)},{f(y+h)} A{f(r)},{f(r)} 0 0 1 {f(x)},{f(y+h-r)} "
            f"L{f(x)},{f(y+r)} A{f(r)},{f(r)} 0 0 1 {f(x+r)},{f(y)} Z")

# sanity: glyph corner distance from center, and safe-zone radius in viewport units
xs = [r[0] for r in rects] + [r[0] + r[2] for r in rects]
ys = [r[1] for r in rects] + [r[1] + r[3] for r in rects]
half_w = max(abs(v - C) for v in xs)
half_h = max(abs(v - C) for v in ys)
corner = math.hypot(half_w, half_h)
safe_r = 33.0 / 108.0 * 512.0
FG_SCALE = 0.68
print(f"glyph corner dist {corner:.1f}, safe radius {safe_r:.1f}, "
      f"scaled corner {corner * FG_SCALE:.1f} (must be <= safe radius)")
assert corner * FG_SCALE <= safe_r

# 1) adaptive-icon foreground vectors: black glyph by default, white in dark mode
def write_foreground(subdir, color):
    paths = "\n".join(
        f'    <path android:fillColor="{color}" android:pathData="{rounded_rect_path(*r)}"/>'
        for r in scaled(rects, FG_SCALE))
    os.makedirs(f"{RES}/{subdir}", exist_ok=True)
    with open(f"{RES}/{subdir}/ic_launcher_foreground.xml", "w") as f:
        f.write(f'''<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
{paths}
</vector>
''')

write_foreground("drawable", "#000000")
write_foreground("drawable-night", "#FFFFFF")

# 2) adaptive icon defs (round variant is identical; launcher applies the mask)
os.makedirs(f"{RES}/mipmap-anydpi-v26", exist_ok=True)
adaptive = '''<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
'''
for name in ("ic_launcher", "ic_launcher_round"):
    with open(f"{RES}/mipmap-anydpi-v26/{name}.xml", "w") as f:
        f.write(adaptive)
for subdir, color in (("values", "#FFFFFF"), ("values-night", "#000000")):
    os.makedirs(f"{RES}/{subdir}", exist_ok=True)
    with open(f"{RES}/{subdir}/ic_launcher_background.xml", "w") as f:
        f.write(f'''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">{color}</color>
</resources>
''')

# 3) source SVGs for the legacy PNGs (circle crop + full-bleed Play Store square)
# legacy (Android 7) has no dark mode, so these use the light scheme
glyph_svg = lambda s: "\n".join(
    f'    <rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{r:.1f}"/>'
    for x, y, w, h, r in scaled(rects, s))
with open(f"{SCRATCH}/cantor-icon-circle.svg", "w") as f:
    f.write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <circle cx="256" cy="256" r="256" fill="#FFFFFF"/>
  <g fill="#000000">
{glyph_svg(0.78)}
  </g>
</svg>
''')
with open(f"{SCRATCH}/cantor-playstore.svg", "w") as f:
    f.write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#FFFFFF"/>
  <g fill="#000000">
{glyph_svg(0.85)}
  </g>
</svg>
''')
print("wrote vector drawable, adaptive XMLs, and legacy source SVGs")
