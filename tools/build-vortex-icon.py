"""生成"暴风吸入"图标:一条向内的螺旋 + 一圈被卷进来的米粒(带拖尾)。

    python tools/build-vortex-icon.py
    输出:<repo>/assets/vortex.svg          —— 按钮用的矢量图(currentColor)
         <repo>/tools/vortex-preview.png   —— 预览:大图(深/浅底)+ 真实尺寸清晰度检查

设计要点(为 20–34px 的按钮尺寸服务):
  · 1.62 圈,间距拉大,缩小后不会糊成一坨;
  · 中心一个"风眼"实心点,读起来是"被吸进去"而不是"蚊香";
  · 米粒放在外圈 + 一段短拖尾(拖尾在旋转方向的身后),暗示被卷进来;
  · 全部 currentColor,深浅主题都跟宿主走。
"""

import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SIZE = 24.0
CENTER = SIZE / 2
SAMPLES = 96

MAIN_R_OUT = 8.3
MAIN_R_IN = 2.6
MAIN_TURNS = 1.62
MAIN_STROKE = 1.8
EYE_RADIUS = 1.25
GRAIN_ANGLES = (200.0, 302.0, 64.0)
GRAIN_RADIUS = 10.2
GRAIN_RX = 1.25
GRAIN_RY = 0.8
TRAIL_SPAN = 30.0
TRAIL_STROKE = 1.0
TRAIL_OPACITY = 0.42


def spiral_points(r_out, r_in, turns, phase=0.0, samples=SAMPLES):
    """向内的阿基米德螺旋(y 向下,所以正角度方向在屏幕上是顺时针)。"""
    pts = []
    total = turns * 2 * math.pi
    for i in range(samples + 1):
        t = i / samples
        theta = phase + t * total
        r = r_out + (r_in - r_out) * t
        pts.append((CENTER + r * math.cos(theta), CENTER + r * math.sin(theta)))
    return pts


def arc_points(radius, deg_from, deg_to, samples=24):
    pts = []
    for i in range(samples + 1):
        deg = deg_from + (deg_to - deg_from) * i / samples
        theta = math.radians(deg)
        pts.append((CENTER + radius * math.cos(theta), CENTER + radius * math.sin(theta)))
    return pts


def to_path(points):
    head = f"M{points[0][0]:.2f} {points[0][1]:.2f}"
    return head + "".join(f"L{x:.2f} {y:.2f}" for x, y in points[1:])


MAIN = spiral_points(MAIN_R_OUT, MAIN_R_IN, MAIN_TURNS)
MAIN_PATH = to_path(MAIN)

GRAINS = []
TRAILS = []
for deg in GRAIN_ANGLES:
    theta = math.radians(deg)
    GRAINS.append((CENTER + GRAIN_RADIUS * math.cos(theta), CENTER + GRAIN_RADIUS * math.sin(theta), deg))
    TRAILS.append(arc_points(GRAIN_RADIUS, deg - TRAIL_SPAN, deg - 6.0))

svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="storm inhale">',
    '  <!-- 风眼 -->',
    f'  <circle cx="12" cy="12" r="{EYE_RADIUS}" fill="currentColor"/>',
    '  <!-- 向内的主螺旋 -->',
    f'  <path d="{MAIN_PATH}" fill="none" stroke="currentColor" stroke-width="{MAIN_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>',
]
for pts in TRAILS:
    svg.append(
        f'  <path d="{to_path(pts)}" fill="none" stroke="currentColor" stroke-width="{TRAIL_STROKE}" '
        f'stroke-linecap="round" opacity="{TRAIL_OPACITY}"/>'
    )
for gx, gy, deg in GRAINS:
    svg.append(
        f'  <ellipse cx="{gx:.2f}" cy="{gy:.2f}" rx="{GRAIN_RX}" ry="{GRAIN_RY}" '
        f'transform="rotate({deg + 90:.1f} {gx:.2f} {gy:.2f})" fill="currentColor"/>'
    )
svg.append('</svg>')
svg_text = "\n".join(svg) + "\n"

out_svg = os.path.join(ROOT, "assets", "vortex.svg")
os.makedirs(os.path.dirname(out_svg), exist_ok=True)
with open(out_svg, "w", encoding="utf-8") as fh:
    fh.write(svg_text)
print("wrote", out_svg, len(svg_text), "bytes")


def render(canvas_px, fg, bg):
    """用同一套几何栅格化一张预览图。"""
    img = Image.new("RGB", (canvas_px, canvas_px), bg)
    draw = ImageDraw.Draw(img)
    k = canvas_px / SIZE
    eye = EYE_RADIUS * k
    draw.ellipse((CENTER * k - eye, CENTER * k - eye, CENTER * k + eye, CENTER * k + eye), fill=fg)
    for pts, width, opacity in ((MAIN, MAIN_STROKE, 1.0), *[(t, TRAIL_STROKE, TRAIL_OPACITY) for t in TRAILS]):
        scaled = [(x * k, y * k) for x, y in pts]
        rgb = tuple(int(bg[i] + (fg[i] - bg[i]) * opacity) for i in range(3))
        draw.line(scaled, fill=rgb, width=max(1, round(width * k)), joint="curve")
    for gx, gy, deg in GRAINS:
        rx, ry = GRAIN_RX * k, GRAIN_RY * k
        box = Image.new("RGBA", (int(rx * 2) + 4, int(ry * 2) + 4), (0, 0, 0, 0))
        bd = ImageDraw.Draw(box)
        cx, cy = box.width / 2, box.height / 2
        bd.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=fg + (255,))
        box = box.rotate(-(deg + 90), resample=Image.BICUBIC, expand=True)
        img.paste(box, (int(gx * k - box.width / 2), int(gy * k - box.height / 2)), box)
    return img


dark = render(240, (238, 238, 242), (28, 28, 30))
light = render(240, (32, 32, 36), (245, 245, 247))

strip = Image.new("RGB", (3 * 36 * 6 + 40, 36 * 6 + 20), (28, 28, 30))
for i, px in enumerate((20, 26, 34)):
    small = render(px, (238, 238, 242), (28, 28, 30)).resize((px * 6, px * 6), Image.NEAREST)
    strip.paste(small, (10 + i * (36 * 6 + 10), 10))

sheet = Image.new("RGB", (240 * 2 + 30, 240 + strip.height + 30), (18, 18, 20))
sheet.paste(dark, (10, 10))
sheet.paste(light, (260, 10))
sheet.paste(strip, (10, 260))
out_png = os.path.join(HERE, "vortex-preview.png")
sheet.save(out_png)
print("wrote", out_png)
