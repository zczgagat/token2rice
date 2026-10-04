# token2rice

每花掉一笔 token,就从 DSH 窗口顶端掉下一碗白米饭;米饭会自由落体砸到底部边框,你可以拖着它扔。

```
花掉的 token  ÷  每碗额度  =  画面上的碗数
```

- **宿主半边**([index.js](index.js)):折叠全进程的 `session/event` 用量(`assistant/message` 里 provider 上报的
  input / output / cacheRead / cacheWrite),原子写入 `$DSH_HOME/token2rice/state.json`,重启不丢;米饭图也归它管
  (`$DSH_HOME/token2rice/art.img`)。路由:
  `GET /token2rice/state`、`GET /token2rice/bowl.png`、`POST /token2rice/reset`(仅回环)、
  `POST|DELETE /token2rice/art`(仅回环,导入/恢复自带米饭图)。
- **浏览器半边**([client.js](client.js)):注册进窗口级浮层 `shell.overlay`,轮询上面的账本,
  在一个 `requestAnimationFrame` 循环里跑 2D 物理(重力 / 弹跳 / 地面摩擦 / 左右墙回弹),
  并提供一个可拖可点的计数牌用于现场调参。

## 装

```powershell
dsh plugin --profile desktop add link:C:\Users\33205\Documents\deepseek-harness\default-workspace\token2rice
```

装完刷新一次页面(浏览器半边随启动清单下发,不刷新拿不到新 bundle)。卸载:

```powershell
dsh plugin --profile desktop remove token2rice
```

改代码什么时候生效:

| 改了什么 | 怎么生效 |
|---|---|
| `client.js`、`assets/`、`cordis.patch.yml` | 宿主会盯着 bundle 文件,改完**刷新页面**即可(rev 会自动变) |
| `index.js`(宿主半边) | 需要**重启 DSH**(已安装的包不会热替换宿主模块) |

## 玩

- **拖动计数牌**:按住计数牌拖到任意位置,松手记住;位置存在 `localStorage`,下次还在那儿。
  轻点(位移 <4px)是开关面板,拖动才是移动。
- **拖动面板**:面板标题栏(带 `⠿` 的那行)同样能拖,面板跟着计数牌走;计数牌在屏幕下半时面板向上弹,在上半时向下弹。
- **拖动米饭**:直接抓住任意一碗拖走,松手后按你甩出去的手速继续飞——水平速度会带自转,落地弹跳、压扁回弹,最后在底边停住。
- **双击一碗**把它扔掉(万一碗挡住了底下的按钮)。「清空画面」一次清掉所有碗。

## 调

点计数牌开面板,设置存在浏览器 `localStorage`(`token2rice.settings.v1`),不需要改 profile:

| 旋钮 | 默认 | 说明 |
|---|---|---|
| 每碗 token | `1000000` | 攒够这么多 token 就掉一碗。预设 100K / 500K / 1M / 2M / 5M,也可以直接填数字 |
| 米饭大小 | `56px` | 碗的宽度,28–140px,已落地和飞行中的碗都会立刻跟着变 |
| 计入缓存 token | 开 | 关掉之后只算「新算的」input + output,缓存读取不计入 |
| 显示计数牌 | 开 | 关掉只留一个小圆点,仍可点开设置 |

面板底部三个按钮:**清空画面**(只清屏,不动账本)、**重置账本**(宿主计数清零)、**归位**(计数牌回到右下角默认位置)。

### 关于口径

默认把四个桶都算上,因为缓存读取通常占大头(重度使用一天可能就是几千万),
这样才有「掉米饭」的观感;想更接近「真正新算的 token」就关掉「计入缓存 token」。
计数**自插件首次启用起算**,不回溯安装之前的花费;`state.json` 删掉即从头开始。

## 换成你自己的图

面板里「米饭图片」那一行:**选择图片…** 或直接把图片**拖到面板上**。

- 支持 PNG / JPEG / WebP / GIF(位图;SVG 是脚本载体,不收),单张上限 4MB。
- 正常路径:图交给宿主存成 `$DSH_HOME/token2rice/art.img`,**换浏览器、重开会话、重启 DSH 都还在**;
  文件名固定,想手动换图直接覆盖这个文件再刷新也行。
- 兜底路径:如果宿主还没加载 `/art` 路由(例如升级插件后还没重启 DSH),图会存进**当前浏览器的 IndexedDB**,
  刷新就能用,只是不跨浏览器。装了新版宿主之后,下一次导入会自动改存到宿主并清掉本地那份。
- 面板里会写明**当前图来自哪**:`默认` / `宿主` / `本浏览器`。
- **恢复默认**两边一起清,回到包里的 `assets/bowl.png`。

## 已知边界

- 只认 `assistant/message` 上 provider 上报的 usage:没上报用量的路由就是零。
- **宿主半边的改动要重启 DSH 才生效**(已安装的包不会热替换宿主模块):`/token2rice/art` 就是这样一个新路由,
  重启前导入的图只存在浏览器本地。客户端半边改完刷新页面即可。
- 自带图只按魔数校验类型、按大小卡 4MB,不解析像素:给一张坏图会让碗显示成兜底 SVG(面板预览也一起坏)。
- 画面最多同时摆 24 碗,超出的只进计数牌(最旧的先退场,米饭雨不会停)。
- 刷新页面会按当前账本把碗**直接摆好**(不做下落动画),只有新挣到的碗才掉下来;
  同一次补发最多 4 碗做下落动画,其余直接摆好,免得离开很久回来时下暴雨。
- 系统开了「减少动态效果」(`prefers-reduced-motion`)时,自动掉落改成直接摆好;手动拖动照旧。
- 浏览器半边要求页面与宿主同源(Web GUI 就是)。相对路径取不到时会退到站点根,再不行就显示「未连接」。

## 素材

`assets/bowl.png` 是用户自己抠好的原图(**原样拷贝**,RGBA 与透明通道一并保留,脚本见 [tools/rawcopy.py](tools/rawcopy.py));
碗的纵横比在图片加载后实测,抠图链路整个失败时前端会退回内联 SVG 米饭碗。
[tools/cutout.py](tools/cutout.py) 是备用的自动抠底脚本(遇到连白底一起照片时用得上)。

换内置图:替换 `assets/bowl.png` 后,宿主新版会把文件 mtime 当版本号塞进 `?v=`,浏览器自动重取;
宿主还是旧版(状态里没有 `builtinVersion`)时,把 [client.js](client.js) 顶部的 `BUILTIN_ART_TAG` +1 再刷新。
另外宿主进程会把自己读过的图缓存进内存,换文件后要**重启 DSH** 才吃得到新字节。
