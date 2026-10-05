"""把 assets/food.mp3 内嵌成 base64 写进 client.js 的标记区。

    python tools/embed-sound.py

为什么内嵌而不是让宿主发一个 /token2rice/food.mp3 路由:宿主半边的新路由要重启
DSH 才生效(已安装的包不热替换宿主模块),而客户端半边改完刷新即可。39KB 的音频
base64 之后约 53KB,塞进 bundle 完全划算。

换音效:替换 assets/food.mp3,重跑本脚本,刷新页面。
标记区在 client.js 里长这样(勿手改中间那行):

    // >>> token2rice:inhale-sound (...)
    const INHALE_SOUND_B64 = '...'
    // <<< token2rice:inhale-sound
"""

import base64
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOUND = os.path.join(ROOT, "assets", "food.mp3")
CLIENT = os.path.join(ROOT, "client.js")

BEGIN = "// >>> token2rice:inhale-sound"
END = "// <<< token2rice:inhale-sound"
MAX_BYTES = 512 * 1024  # 内嵌上限:再大就该考虑宿主路由 + 缓存了

with open(SOUND, "rb") as fh:
    raw = fh.read()

if not raw:
    raise SystemExit("assets/food.mp3 是空的")
if len(raw) > MAX_BYTES:
    raise SystemExit(f"音频 {len(raw)} 字节,超过内嵌上限 {MAX_BYTES};请先压缩,或改成宿主路由方案")
if raw[:3] != b"ID3" and not (raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0):
    print("警告:文件头不像 MP3(ID3 / 0xFFEx),仍按 audio/mpeg 内嵌")

payload = base64.b64encode(raw).decode("ascii")
with open(CLIENT, "r", encoding="utf-8") as fh:
    source = fh.read()

pattern = re.compile(
    r"(" + re.escape(BEGIN) + r"[^\n]*\n)(.*?)(\n\s*" + re.escape(END) + r")",
    re.DOTALL,
)
if not pattern.search(source):
    raise SystemExit("client.js 里找不到 inhale-sound 标记区")

filled = f"    const INHALE_SOUND_B64 = '{payload}'"
updated = pattern.sub(lambda m: m.group(1) + filled + m.group(3), source, count=1)
if updated == source:
    print("内容没变化(可能已经是同一份音频)")
else:
    with open(CLIENT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(updated)
    print("client.js 已更新")

print(f"音频 {len(raw)} 字节 → base64 {len(payload)} 字符"
      f"(client.js 现在 {len(updated)} 字符)")
