# token2rice

**每花掉一笔 token,就从 DSH 窗口顶端掉下一碗白米饭。**
Every N tokens you spend drops a bowl of rice from the top of the DSH window.

![rice bowl](assets/bowl.png)

```
花掉的 token ÷ 每碗额度 = 画面上的碗数
spent tokens ÷ tokens-per-bowl = bowls on screen
```

一个 DeepSeek Harness(DSH)Web 界面插件:把"烧掉的 token"变成一个看得见的东西。
A DeepSeek Harness (DSH) web-UI plugin that turns burned tokens into something you can see.

## 它做什么 / What it does

- **宿主半边**:折叠全进程 `session/event` 里 `assistant/message` 的 provider 用量
  (input / output / cacheRead / cacheWrite),原子写入 `$DSH_HOME/token2rice/state.json`,重启不丢。
- **浏览器半边**:注册进窗口级浮层 `shell.overlay`,在一个 `requestAnimationFrame` 循环里跑 2D 物理。
- **Host half** folds provider-reported usage from every session into a durable ledger at
  `$DSH_HOME/token2rice/state.json`.
- **Browser half** registers into the frame-wide `shell.overlay` slot and runs a small 2D physics loop.

## 玩法 / What you can do

| | |
|---|---|
| 掉落 | 每攒够一碗的额度就从视口顶端生成一碗:**初始朝向随机、自转 0~1 r/s 方向随机、初速度方向随机但一定向下**;之后重力自由落体、落地弹跳、压扁回弹、溅几粒米 |
| 拖动 | 鼠标就是手:碗吊在你抓住的那个点上,拖着走会绕着鼠标摆、甩一下会荡起来,松手按当前速度继续飞 |
| 暴风吸入 | 计数牌左边的漩涡钮:点一下把所有碗卷进风眼;**把一碗拖到钮上松手则只吸这一碗**(靠近时钮会点亮) |
| 扔掉 | 双击一碗把它从画面上删掉;面板里「清空画面」一次全清 |
| 计数牌 | 右下角(可拖到任意位置)显示已换多少碗、当前花了多少 token;轻点开面板 |
| 换图 | 面板里「选择图片…」或把图片拖到面板上,换成自己的图(PNG / JPEG / WebP / GIF,≤4MB) |

- Drops: each bowl spawns with a random orientation, a random spin (0–1 r/s, either direction) and a
  random initial velocity (any direction, but always downward); then gravity, bounce, squash-and-rebound
  and a few flying grains on impact.
- Drag any bowl: the cursor is the hand — the bowl hangs from the point you grabbed and swings around
  the cursor under gravity (a pendulum pivoting at the grab point); releasing hands its momentum to the free fall.
- Double-click a bowl to remove it; the panel can clear the whole screen.
- The vortex button beside the counter ([assets/vortex.svg](assets/vortex.svg)) sucks every bowl into the
  eye of the storm along an inward spiral — they shrink and fade as they go; the earned count is untouched.
- The badge (bottom-right, draggable) shows bowls earned and tokens counted; click it for settings.
- Bring your own artwork (PNG/JPEG/WebP/GIF, ≤ 4MB) — pick a file or drag it onto the panel.

## 安装 / Install

从仓库装 / from the repo:

```powershell
dsh plugin --profile desktop add github:zczgagat/token2rice
```

本地开发安装 / local development:

```powershell
dsh plugin --profile desktop add link:C:\path\to\token2rice
```

装完刷新一次页面 / refresh the page afterwards. 卸载 / uninstall:

```powershell
dsh plugin --profile desktop remove token2rice
```

## 设置 / Settings

点计数牌开面板,设置存在浏览器 `localStorage`(`token2rice.settings.v1`),不需要改 profile。

| 旋钮 | 默认 | 说明 |
|---|---|---|
| 每碗 token | `1000000` | 攒够这么多 token 掉一碗;预设 100K / 500K / 1M / 2M / 5M,也可直接填 |
| 米饭大小 | `56px` | 碗宽 28–140px,已落地和飞行中的碗都会立刻跟着变 |
| 最多摆几碗 | `24` | 画面同时显示的上限,滑杆 4–80;超出时最旧的先被顶掉(计数不受影响) |
| 计入缓存 token | 开 | 关掉只算新算的 input + output,缓存读取不计入 |
| 显示计数牌 | 开 | 关掉只留一个小圆点,仍可点开设置 |
| 落地自动回正 | 开 | 关掉后碗保持落地那一刻的倾角,歪着堆在一起,不再自己摆正 |
| 位置 | 右下角 | 拖计数牌或面板标题栏即可移动;「归位」按钮回默认位置 |

> 面板内容较长时会自己滚动(标题栏固定在上方,仍可拖动移动面板)。


## 口径 / What counts

默认把四个桶都算上(input / output / cacheRead / cacheWrite)——缓存读取通常占大头,重度使用
一天可能就是几千万,这样才有"掉米饭"的观感。想更接近"真正新算的 token"就关掉「计入缓存 token」。
计数**自插件首次启用起算**,不回溯安装之前的花费。
By default all four provider buckets count; turn off "count cached tokens" for a stricter measure.
Counting starts when the plugin is first enabled, never retroactively.

## 自带米饭图 / Your own artwork

- 正常路径:图交给宿主存成 `$DSH_HOME/token2rice/art.img`,换浏览器、重开会话、重启 DSH 都还在。
- 兜底路径:宿主还没有 `/token2rice/art` 路由时(例如升级插件后还没重启),图存进**当前浏览器的 IndexedDB**,
  刷新即可用;宿主路由上线后,下一次挂载会自动把本地那张搬到宿主。
- **恢复默认**两边一起清,回到仓库里的 `assets/bowl.png`。

## 已知边界 / Known limits

- 只认 `assistant/message` 上 provider 上报的 usage:路由不上报用量就是零。
- 画面最多同时摆 24 碗(默认,面板里可调 4–80),超出的只进计数牌,最旧的先退场。
- 刷新页面会把已经挣到的碗**直接摆好**,只有新挣到的才下落;一次最多 4 碗做下落动画。
- 宿主半边的代码改动要**重启 DSH** 才生效(已安装的包不会热替换宿主模块);浏览器半边改完刷新即可。
- 宿主进程会缓存读过的米饭图,换 `assets/bowl.png` 之后同样要重启才吃得到新字节。

## 文件 / Layout

| 文件 | 作用 |
|---|---|
| [index.js](index.js) | 宿主半边:`session/event` 折叠、账本落盘、HTTP 路由 |
| [client.js](client.js) | 浏览器半边:浮层、物理、面板、导入图片 |
| [cordis.patch.yml](cordis.patch.yml) | bundle patch,把插件行插进 profile |
| [docs/notes.zh.md](docs/notes.zh.md) | 中文实现笔记(路由表、缓存、竞态处理等细节) |
| [tools/](tools) | 米饭图来源脚本:`rawcopy.py`(原样拷贝)/ `cutout.py`(自动抠底) |

## License

[MIT](LICENSE)
