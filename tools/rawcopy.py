"""把源图原样写进 assets/bowl.png:不抠底、不缩放、不裁边,连 alpha 一起保留。

源图本身就是抠好的 RGBA(约一半像素全透明),所以这里只做容器转换 webp -> png,
像素逐点不变。要另做抠底或换尺寸,见 cutout.py。
"""

from PIL import Image
import os

SRC = r"C:\Users\33205\.dsh\attachments\v1\objects\69\69954a5b2ad99d55dec15b385e0f58ee52409de5c6207455f7915761bbd1d4fc"
OUT = r"C:\Users\33205\Documents\deepseek-harness\default-workspace\token2rice\assets\bowl.png"

img = Image.open(SRC)
print("source", img.mode, img.size, img.getbands())
if "A" in img.getbands():
    hist = img.getchannel("A").histogram()
    total = img.width * img.height
    print("alpha=0 占比 %.1f%% / alpha=255 占比 %.1f%%" % (100.0 * hist[0] / total, 100.0 * hist[255] / total))
# 原样保存:保持 RGBA 与原始尺寸,PNG 是无损容器。
img.save(OUT, format="PNG", optimize=True)
print("wrote", OUT, os.path.getsize(OUT), "bytes")
