"""Cut the white backdrop out of the supplied rice-bowl photo (v2).

v1 leaked: the mound of rice carries genuinely pure-white blown highlights that
touch the background, so a loose "near-white" flood fill ate pockets inside the
rice. v2 seals those thin channels first:

  1. strict background candidate mask (pure white only)
  2. erode it by 1px so 1-2px near-white channels through the rice disconnect
  3. flood fill the eroded mask from the image border -> true outside region
  4. dilate back, re-intersect with the candidate mask, so the recovered ring
     can only contain genuinely white pixels
  5. alpha 0 in that region, 255 elsewhere, with a 2px feathered edge
"""

from PIL import Image, ImageDraw, ImageFilter
import os

SRC = r"C:\Users\33205\.dsh\attachments\v1\objects\69\69954a5b2ad99d55dec15b385e0f58ee52409de5c6207455f7915761bbd1d4fc"
OUT_DIR = r"C:\Users\33205\Documents\deepseek-harness\default-workspace\token2rice\assets"
os.makedirs(OUT_DIR, exist_ok=True)

SCALE = 2
WHITE_MIN = 244          # min channel for "this pixel is backdrop white"
WHITE_SPREAD = 6         # max channel spread for "neutral white"

img = Image.open(SRC).convert("RGB")
w, h = img.size
big = img.resize((w * SCALE, h * SCALE), Image.LANCZOS)
W, H = big.size
px = big.load()

candidate = Image.new("L", (W, H), 0)
cpx = candidate.load()
for y in range(H):
    for x in range(W):
        r, g, b = px[x, y]
        if min(r, g, b) >= WHITE_MIN and (max(r, g, b) - min(r, g, b)) <= WHITE_SPREAD:
            cpx[x, y] = 255

eroded = candidate.filter(ImageFilter.MinFilter(3))

filled = eroded.copy()
seeds = [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1),
         (W // 2, 0), (W // 2, H - 1), (0, H // 2), (W - 1, H // 2)]
for seed in seeds:
    if filled.getpixel(seed) == 255:
        ImageDraw.floodfill(filled, seed, 128, thresh=0)

grown = filled.filter(ImageFilter.MaxFilter(3))       # undo the erosion
fpx = grown.load()
cpx = candidate.load()
background = Image.new("L", (W, H), 0)
bpx = background.load()
for y in range(H):
    for x in range(W):
        # an outside pixel must be both connected to the border and whitish
        if fpx[x, y] == 128 and cpx[x, y] == 255:
            bpx[x, y] = 255

# Feathering band: everything within ~2px of the background keeps a soft edge.
band = background.filter(ImageFilter.MaxFilter(5))
bandpx = band.load()
alpha = Image.new("L", (W, H), 255)
apx = alpha.load()
for y in range(H):
    for x in range(W):
        if bpx[x, y] == 255:
            apx[x, y] = 0
        elif bandpx[x, y] == 255:
            r, g, b = px[x, y]
            mn = min(r, g, b)
            # blend from transparent (255 white) to opaque (215 or darker)
            t = (255 - mn) / (255 - 215)
            apx[x, y] = max(0, min(255, int(t * 255)))

alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))

out = big.convert("RGBA")
out.putalpha(alpha)
out = out.resize((w, h), Image.LANCZOS)

bbox = out.getbbox()
if bbox:
    out = out.crop((max(0, bbox[0] - 2), max(0, bbox[1] - 2),
                    min(w, bbox[2] + 2), min(h, bbox[3] + 2)))

TARGET_W = 320
if out.width > TARGET_W:
    ratio = TARGET_W / out.width
    out = out.resize((TARGET_W, max(1, round(out.height * ratio))), Image.LANCZOS)

out.save(os.path.join(OUT_DIR, "bowl.png"), optimize=True)

# Review composite on a saturated background: leaks show up immediately.
bg = Image.new("RGBA", out.size, (255, 0, 255, 255))
Image.alpha_composite(bg, out).convert("RGB").resize((out.width * 2, out.height * 2), Image.NEAREST).save(
    os.path.join(os.path.dirname(OUT_DIR), "tools", "check-magenta.png"))
print("bowl.png", out.size, os.path.getsize(os.path.join(OUT_DIR, "bowl.png")), "bytes")
