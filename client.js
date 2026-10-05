/**
 * token2rice — 浏览器半边(v2:拖动 + 自由落体)。
 *
 * 窗口级浮层 `shell.overlay` 里跑一套简单的 2D 物理:
 *   · 每攒够一碗的 token 额度,就从视口顶端生成一碗,重力自由落体、落地弹跳、压扁回弹;
 *   · 每碗都可以用指针抓住拖到任意位置,松手时把手速当作初速度甩出去(水平速度还带自转);
 *   · 碗落在窗口底部边框后靠地面摩擦停住,左右边界会回弹;
 *   · 双击一碗可以把它扔掉(免得碗挡住底下的按钮)。
 * 计数牌(默认右下角)也能拖,面板跟着它走,位置存 localStorage。
 *
 * 位置全部由物理量(x/y 是元素左上角在视口坐标系里的 px)驱动,直接写
 * element.style.transform,不走 React 每帧重渲染。
 *
 * 注册 id 必须等于 loader entry 名(token2rice),否则 ModuleLoader 会报
 * "loaded without registering token2rice"。
 */

window.__ModuleLoader__.load({
  id: 'token2rice',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 用户可调旋钮的默认值:1M token 一碗、56px 大米饭、最多 24 碗、落地自动回正、吸入有音效。 */
    const DEFAULTS = { tokensPerBowl: 1000000, bowlSize: 56, maxBowls: 24, countCache: true, showBadge: true, settleUpright: true, soundOn: true, badgePos: null }
    const SETTINGS_KEY = 'token2rice.settings.v1'

    /** 画面里同时摆几碗:面板可调(滑杆范围),这里只是兜底夹取。 */
    const BOWL_LIMIT_FLOOR = 1
    const BOWL_LIMIT_CEIL = 200
    const BOWL_LIMIT_SLIDER_MIN = 4
    const BOWL_LIMIT_SLIDER_MAX = 80
    const BOWL_LIMIT_SLIDER_STEP = 4
    /** 面板高度上限:内容变长之后靠它 + overflow 滚动,而不是无限往下长。 */
    const PANEL_MAX_HEIGHT = 'max-height:min(68vh,520px)'
    /** 一次补发的下落动画上限:离开很久回来时不至于下 Rice 暴雨。 */
    const MAX_DROP_BATCH = 4
    const POLL_MS = 2500
    const SPLASH_MS = 620
    const PRESETS = [100000, 500000, 1000000, 2000000, 5000000]

    /** 自带米饭图:和后端一致的上限与可接受的位图类型(SVG 是脚本载体,不收)。 */
    const ART_MAX_BYTES = 4 * 1024 * 1024
    const ART_TYPES = /^image\/(png|jpeg|webp|gif)$/
    const ART_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i
    /**
     * 内置图(assets/bowl.png)的缓存版本号。宿主新版会给出文件 mtime,旧版没有
     * 这个字段,就靠这个常量:换内置图时把它 +1,浏览器才会重新拉而不是吃
     * `max-age=86400` 的旧副本。
     */
    const BUILTIN_ART_TAG = 'b3'

    // ---- 物理常量(单位:px、秒、度)----
    const GRAVITY = 2600
    const RESTITUTION = 0.26
    const AIR_DRAG = 0.5           // v *= pow(AIR_DRAG, dt):空中每秒衰减到一半
    const GROUND_FRICTION = 0.02   // 落地后水平速度每秒保留 2%
    const WALL_BOUNCE = 0.42
    const MAX_THROW = 2600         // 松手时的速度上限
    const MAX_SPIN = 720           // 松手时的自转上限(deg/s)
    const BOUNCE_FLOOR = 220       // 落地速度低于它就直接停住
    const DEFAULT_ASPECT = 181 / 320

    // ---- 拖拽物理(鼠标是"手",碗吊在手上)----
    const DRAG_SPRING = 520        // 抓取点被拉向指针的弹簧刚度(1/s²);静垂 = GRAVITY/它 ≈ 5px
    const DRAG_DAMP = 38           // 线速度阻尼,略欠阻尼才有跟手的"甩"感
    const DRAG_TORQUE = 1          // 重力力矩系数,1 = 标准单摆
    const DRAG_ANG_DRAG = 0.45     // 角速度每秒保留比例
    const DRAG_MAX_ANG_ACC = 6000  // 角加速度上限(deg/s²)
    const DRAG_WALL_FRICTION = 0.3 // 拖到墙边/地面时保留的速度比例
    const COM_ARM = 0.42           // 重心在底面之上的高度(占碗高比例)

    // ---- 暴风吸入 ----
    const VORTEX_SIZE = 36         // 圆钮直径(px)
    const VORTEX_ICON_SIZE = 22    // 钮里的图标尺寸
    const VORTEX_DROP_RADIUS = 68  // 把碗拖到钮心多近松手,算"喂给漩涡"(px)
    const INHALE_MIN_SEC = 0.5     // 最近的碗也要转这么久才被吸进去
    const INHALE_MAX_SEC = 0.9     // 最远的碗
    const INHALE_RADIUS_POWER = 1.25 // 半径收缩曲线:(1-p)^1.25,越靠近风眼收得越急
    const INHALE_ANGLE_POWER = 0.85  // 角度推进曲线:p^0.85,越靠近风眼转得越快
    const INHALE_TURNS_MIN = 1.5   // 每个碗绕风眼转几圈(按序号取伪随机)
    const INHALE_TURNS_MAX = 2.7
    const INHALE_SHRINK = 0.92     // 到达风眼时缩到原来的 8%

    // ---- 计数牌 / 面板几何 ----
    const BADGE_W = 152            // 计数牌定宽:拖动夹取和面板对齐都按它算,几何才是准的
    const BADGE_H = 28
    const BADGE_MARGIN = 14
    const PANEL_WIDTH = 280
    const EDGE = 6
    const DRAG_SLOP = 4

    /** 图走不通时的兜底:一个纯 SVG 米饭碗,永远画得出来。 */
    const FALLBACK_BOWL =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40">' +
          '<path d="M14 18c0-7 8-12 18-12s18 5 18 12z" fill="#f7f6f3"/>' +
          '<path d="M6 18h52c0 12-8 20-26 20S6 30 6 18z" fill="#c9ccd1"/>' +
          '<path d="M6 18h52c0 3-.5 5.6-1.6 8H7.6C6.5 23.6 6 21 6 18z" fill="#e2e5e9"/>' +
        '</svg>',
      )

    /** 主题令牌取自宿主:只引 --dsw-alias-*,改版也只会掉色不会崩。 */
    const CSS = [
      '.t2r-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:40}',
      '.t2r-bowl{position:absolute;left:0;top:0;transform-origin:50% 100%;will-change:transform;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-drag:none;filter:drop-shadow(0 6px 10px rgba(0,0,0,.22))}',
      '.t2r-bowl:active{cursor:grabbing}',
      '.t2r-grain{position:absolute;left:0;top:0;width:5px;height:4px;border-radius:50%;background:#fdfdfb;opacity:0;box-shadow:0 0 1px rgba(0,0,0,.25)}',
      '.t2r-grain--go{animation:t2r-splash .62s ease-out forwards}',
      '@keyframes t2r-splash{0%{opacity:.95;transform:translate3d(0,0,0) scale(.7)}100%{opacity:0;transform:translate3d(var(--t2r-dx),var(--t2r-dy),0) scale(1)}}',
      '.t2r-badge{position:fixed;width:' + BADGE_W + 'px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;height:' + BADGE_H + 'px;padding:0 10px 0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,rgba(28,28,30,.86));color:var(--dsw-alias-label-primary,#e8e8e8);font:500 12px/1 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;cursor:grab;user-select:none;touch-action:none;overflow:hidden;white-space:nowrap;z-index:43;backdrop-filter:blur(8px);box-shadow:0 2px 10px rgba(0,0,0,.18)}',
      '.t2r-badge:hover{border-color:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-badge:active{cursor:grabbing}',
      '.t2r-badge img{width:22px;height:auto;display:block;pointer-events:none}',
      '.t2r-badge .t2r-dim{color:var(--dsw-alias-label-secondary,rgba(200,200,200,.72));font-weight:400}',
      '.t2r-dot{position:fixed;width:14px;height:14px;border-radius:50%;cursor:grab;touch-action:none;z-index:43;background:var(--dsw-alias-bg-layer-2,rgba(28,28,30,.8));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));opacity:.45;transition:opacity .15s ease}',
      '.t2r-dot:hover{opacity:1}',
      '.t2r-panel{position:fixed;pointer-events:auto;box-sizing:border-box;width:' + PANEL_WIDTH + 'px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,rgba(24,24,26,.97));color:var(--dsw-alias-label-primary,#e8e8e8);font:400 12px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;z-index:44;box-shadow:0 10px 32px rgba(0,0,0,.34);display:flex;flex-direction:column;gap:9px;' + PANEL_MAX_HEIGHT + ';overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l1,rgba(128,128,128,.5)) transparent}',
      '.t2r-panel::-webkit-scrollbar{width:8px}',
      '.t2r-panel::-webkit-scrollbar-track{background:transparent}',
      '.t2r-panel::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l1,rgba(128,128,128,.5));border-radius:999px}',
      '.t2r-panel::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-secondary,rgba(200,200,200,.6))}',
      '.t2r-panel h4{margin:-12px 0 0;padding:12px 0 8px;font-size:12px;font-weight:600;letter-spacing:.02em;cursor:move;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:space-between;gap:6px;position:sticky;top:-12px;z-index:1;background:inherit}',
      '.t2r-panel h4 .t2r-grip{color:var(--dsw-alias-label-secondary,rgba(200,200,200,.6));font-weight:400}',
      '.t2r-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
      '.t2r-row .t2r-key{color:var(--dsw-alias-label-secondary,rgba(200,200,200,.75));flex:none}',
      '.t2r-panel input[type=number]{width:92px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:7px;padding:3px 7px;font:inherit;outline:none}',
      '.t2r-panel input[type=number]:focus{border-color:var(--dsw-alias-brand-primary,#4d8dff)}',
      // 滑杆必须是可收缩的:固定宽度会让整行横向溢出,面板就会长出横向滚动条。
      '.t2r-panel input[type=range]{flex:1 1 auto;min-width:0;width:auto;max-width:128px;accent-color:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-swatches{display:flex;gap:5px;flex-wrap:wrap}',
      '.t2r-swatches button,.t2r-panel button.t2r-btn{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:7px;padding:3px 8px;font:inherit;cursor:pointer}',
      '.t2r-swatches button:hover,.t2r-panel button.t2r-btn:hover{border-color:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-swatches button.on{border-color:var(--dsw-alias-brand-primary,#4d8dff);color:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-switch{position:relative;width:34px;height:19px;border-radius:999px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.45));cursor:pointer;flex:none;transition:background .15s ease}',
      '.t2r-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease}',
      '.t2r-switch.on{background:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-switch.on::after{transform:translateX(15px)}',
      '.t2r-hint{color:var(--dsw-alias-label-secondary,rgba(200,200,200,.72));font-size:11px;line-height:1.45}',
      '.t2r-thumb{width:46px;height:27px;object-fit:contain;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3))}',
      '.t2r-panel input[type=file]{display:none}',
      '.t2r-panel.t2r-dropping{border-color:var(--dsw-alias-brand-primary,#4d8dff);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d8dff) 35%,transparent),0 10px 32px rgba(0,0,0,.34)}',
      '.t2r-actions{display:flex;gap:6px}',
      '.t2r-actions button{flex:1 1 0;min-width:0;white-space:nowrap}',
      '.t2r-actions button.t2r-btn{display:flex;align-items:center;justify-content:center;gap:5px}',
      '.t2r-vortex{position:fixed;width:' + VORTEX_SIZE + 'px;height:' + VORTEX_SIZE + 'px;box-sizing:border-box;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-bg-layer-2,rgba(28,28,30,.86));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));z-index:43;backdrop-filter:blur(8px);box-shadow:0 2px 10px rgba(0,0,0,.18);transition:transform .12s ease,border-color .12s ease,color .12s ease}',
      '.t2r-vortex:hover{border-color:var(--dsw-alias-brand-primary,#4d8dff);color:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-vortex:active{transform:scale(.92)}',
      // 拖着一碗靠近时点亮:松手就单碗吸入
      '.t2r-vortex[data-hot="yes"]{transform:scale(1.12);color:var(--dsw-alias-brand-primary,#4d8dff);border-color:var(--dsw-alias-brand-primary,#4d8dff);box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d8dff) 28%,transparent),0 2px 10px rgba(0,0,0,.2)}',
      '.t2r-vortex[data-hot="yes"] svg{animation:t2r-spin 1.1s linear infinite}',
      '.t2r-vortex[data-storming="yes"]{pointer-events:none;color:var(--dsw-alias-brand-primary,#4d8dff);border-color:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-vortex[data-storming="yes"] svg{animation:t2r-spin .45s linear infinite}',
      '@keyframes t2r-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      '.t2r-storm{position:fixed;pointer-events:none;z-index:42;transform:translate(-50%,-50%);color:var(--dsw-alias-brand-primary,#4d8dff);animation:t2r-storm .9s ease-out forwards}',
      '@keyframes t2r-storm{0%{transform:translate(-50%,-50%) scale(.3) rotate(0deg);opacity:0}12%{opacity:.85}55%{opacity:.6}100%{transform:translate(-50%,-50%) scale(1.45) rotate(400deg);opacity:0}}',
      '.t2r-panel button.t2r-btn:disabled{opacity:.45;cursor:default}',
      '.t2r-panel button.t2r-btn:disabled:hover{border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.35))}',
      '.t2r-warn{color:var(--dsw-alias-label-warning,#e0a94a)}',
    ].join('')

    const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value)

    /** 读一次设置;坏值逐字段回退,旧版本字段缺失也回退。 */
    function loadSettings() {
      const out = { ...DEFAULTS }
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        if (raw === null) return out
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return out
        if (Number.isFinite(parsed.tokensPerBowl) && parsed.tokensPerBowl >= 1000) out.tokensPerBowl = Math.round(parsed.tokensPerBowl)
        if (Number.isFinite(parsed.bowlSize) && parsed.bowlSize >= 12 && parsed.bowlSize <= 240) out.bowlSize = Math.round(parsed.bowlSize)
        if (Number.isFinite(parsed.maxBowls) && parsed.maxBowls >= BOWL_LIMIT_FLOOR && parsed.maxBowls <= BOWL_LIMIT_CEIL) {
          out.maxBowls = Math.round(parsed.maxBowls)
        }
        if (typeof parsed.countCache === 'boolean') out.countCache = parsed.countCache
        if (typeof parsed.showBadge === 'boolean') out.showBadge = parsed.showBadge
        if (typeof parsed.settleUpright === 'boolean') out.settleUpright = parsed.settleUpright
        if (typeof parsed.soundOn === 'boolean') out.soundOn = parsed.soundOn
        const pos = parsed.badgePos
        if (pos !== null && typeof pos === 'object' && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          out.badgePos = { left: Math.round(pos.left), top: Math.round(pos.top) }
        }
      } catch (error) {
        // 隐私模式下 localStorage 会抛;用默认值继续。
      }
      return out
    }

    function saveSettings(settings) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch (error) {
        // 存不下就是下次回到默认值,不影响本次会话。
      }
    }

    /** 1234567 -> "1.23M";牌面只放三位有效数字。 */
    function formatTokens(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n >= 1000000000) return (n / 1000000000).toFixed(2) + 'B'
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M'
      if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K'
      return String(Math.round(n))
    }

    /** 本次"花了多少 token":默认把四个桶都算上(缓存读通常是大头)。 */
    function countedTokens(totals, countCache) {
      if (totals === null || typeof totals !== 'object') return 0
      const direct = (Number(totals.inputTokens) || 0) + (Number(totals.outputTokens) || 0)
      if (!countCache) return direct
      return direct + (Number(totals.cacheReadTokens) || 0) + (Number(totals.cacheWriteTokens) || 0)
    }

    /** 确定性伪随机:同一个序号每次都给同一个数,重渲染不跳位。 */
    function noiseAt(seed) {
      const x = Math.sin(seed * 12.9898) * 43758.5453
      return x - Math.floor(x)
    }

    /** 第 n 碗的出场横向位置(视口百分比)和静止倾角。 */
    function spawnPose(serial) {
      return {
        xPercent: 2 + ((serial * 6.7 + noiseAt(serial + 1) * 5) % 82),
        tilt: (noiseAt(serial + 13) - 0.5) * 8,
      }
    }

    /** 拼一个端点候选表:base 优先,再退到站点根,最后相对路径。 */
    function endpointCandidates(path) {
      const out = []
      try {
        out.push(new URL(path, document.baseURI).toString())
      } catch (error) {
        // 没有 baseURI 就算了。
      }
      try {
        if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
          out.push(location.origin + '/' + path)
        }
      } catch (error) {
        // 没有 location 就算了。
      }
      out.push(path)
      return out.filter((item, index) => out.indexOf(item) === index)
    }

    const STATE_PATH = 'token2rice/state'
    const BOWL_PATH = 'token2rice/bowl.png'

    /**
     * 宿主端点解析:候选顺序里第一个 2xx 就被记住,之后只打这一个。
     * 失败返回 null,调用方按"宿主未连接"处理——插件不该因此崩掉。
     */
    function makeEndpoint() {
      let resolved
      const probe = async function probe() {
        const candidates = resolved === undefined ? endpointCandidates(STATE_PATH) : [resolved]
        for (const url of candidates) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
            if (!response.ok) continue
            const data = await response.json()
            if (data === null || typeof data !== 'object' || data.ok !== true) continue
            resolved = url
            return data
          } catch (error) {
            // 试下一个候选。
          }
        }
        return null
      }
      /**
       * 同一个插件下另一个路由的地址:解析成功过就用同一个前缀,
       * 否则退回和 state 一样的候选逻辑。
       *
       * @param name - 路由名(如 `art`)。
       * @returns 绝对地址。
       */
      probe.sibling = (name) => {
        if (resolved !== undefined) {
          const cut = resolved.lastIndexOf('/')
          if (cut !== -1) return resolved.slice(0, cut + 1) + name
        }
        try {
          return new URL('token2rice/' + name, document.baseURI).toString()
        } catch (error) {
          return 'token2rice/' + name
        }
      }
      return probe
    }

    /**
     * 自带米饭图的地址。`tag` 非空时带上 `?v=`:换成自己的图用上传时间,
     * 用内置图用文件 mtime(旧宿主则用 BUILTIN_ART_TAG),浏览器就不会拿旧缓存。
     *
     * @param tag - 版本标记。
     * @returns 绝对地址。
     */
    function bowlImageUrl(tag) {
      let base = BOWL_PATH
      try {
        base = new URL(BOWL_PATH, document.baseURI).toString()
      } catch (error) {
        base = BOWL_PATH
      }
      return tag === '' ? base : base + '?v=' + encodeURIComponent(tag)
    }

    // ---- 本地兜底图库(IndexedDB)----
    // 宿主还没有 /art 路由时(插件升级后没重启),自带图先存在这个浏览器里,
    // 这样"导入图片"刷新就能用;等宿主路由上线,下一次导入会自动改存到宿主。
    const IDB_NAME = 'token2rice'
    const IDB_STORE = 'art'
    const IDB_KEY = 'bowl'

    function openArtDb() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('no-indexeddb'))
          return
        }
        const request = indexedDB.open(IDB_NAME, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error === null ? new Error('idb-open-failed') : request.error)
      })
    }

    /** 在 art 表上跑一次事务。 */
    async function withArtStore(mode, run) {
      const db = await openArtDb()
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, mode)
          const request = run(tx.objectStore(IDB_STORE))
          tx.oncomplete = () => resolve(request === undefined ? undefined : request.result)
          tx.onerror = () => reject(tx.error === null ? new Error('idb-failed') : tx.error)
          tx.onabort = () => reject(tx.error === null ? new Error('idb-aborted') : tx.error)
        })
      } finally {
        db.close()
      }
    }

    const idbReadArt = () => withArtStore('readonly', (store) => store.get(IDB_KEY))
    const idbWriteArt = (blob) => withArtStore('readwrite', (store) => store.put(blob, IDB_KEY))
    const idbDropArt = () => withArtStore('readwrite', (store) => store.delete(IDB_KEY))

    // ---- 掉落时的随机初始状态 ----
    const SPAWN_VX_MAX = 160       // 初速度的水平分量上限(px/s),方向任意
    const SPAWN_VY_MIN = 30        // 初速度的垂直分量:一定是向下,所以只给正区间
    const SPAWN_VY_MAX = 240
    const SPAWN_SPIN_MAX = 360     // 自转 0~1 r/s,方向随机

    /**
     * 给刚生成的一碗随机初始状态。
     *
     *   · 朝向:任意角(0~360°);
     *   · 自转:0~1 r/s(0~360°/s),方向随机;
     *   · 速度:方向任意,但 **y 分量必定向下**(只取正区间),大小在合理范围内。
     *
     * 伪随机取自碗的序号,所以同一碗每次算出来都一样(可复现、可数值测试)。
     * 只改初始状态,不动 restTilt —— 那是落地回正的目标倾角。
     *
     * @param bowl - 刚 makeBowl 出来的状态(原地修改)。
     * @returns 同一个 bowl。
     */
    function randomizeSpawn(bowl) {
      const serial = bowl.serial
      const turn = noiseAt(serial * 1.7 + 11)
      const spinNoise = noiseAt(serial * 2.3 + 29)
      const vxNoise = noiseAt(serial * 3.1 + 53)
      const vyNoise = noiseAt(serial * 0.9 + 71)
      bowl.rot = turn * 360
      bowl.spin = (spinNoise < 0.5 ? -1 : 1) * spinNoise * SPAWN_SPIN_MAX
      bowl.vx = (vxNoise - 0.5) * 2 * SPAWN_VX_MAX
      bowl.vy = SPAWN_VY_MIN + vyNoise * (SPAWN_VY_MAX - SPAWN_VY_MIN)
      return bowl
    }

    /**
     * 旋转+缩放之后,碗的包围盒相对**变换原点(底面中点,见 CSS transform-origin)**
     * 在 x / y 上的最大外扩量。
     *
     * 为什么必须有它:碗是绕底面中点转的,一旦不是正着的,它的角就会落到"底面中点"
     * 以下 —— 落地判定若还按未旋转的盒子(height)算,斜着落地的那碗就会穿到底边
     * 下面去。所以地面高度与左右边墙都要用旋转后的包围盒来算。
     *
     * @param w - 盒宽(px)。
     * @param h - 盒高(px)。
     * @param rotDeg - 旋转角(度,CSS 正向)。
     * @param scaleX - 横向缩放。
     * @param scaleY - 纵向缩放。
     * @returns `halfWidth` 为相对原点的最大水平外扩,`lowest` 为最低点相对原点的下沉量。
     */
    function rotatedExtents(w, h, rotDeg, scaleX, scaleY) {
      const rad = (rotDeg * Math.PI) / 180
      const cs = Math.cos(rad)
      const sn = Math.sin(rad)
      let halfWidth = 0
      let lowest = 0
      const corners = [[-w / 2, 0], [w / 2, 0], [-w / 2, -h], [w / 2, -h]]
      for (const corner of corners) {
        const sx = corner[0] * scaleX
        const sy = corner[1] * scaleY
        const wx = sx * cs - sy * sn
        const wy = sx * sn + sy * cs
        if (Math.abs(wx) > halfWidth) halfWidth = Math.abs(wx)
        if (wy > lowest) lowest = wy
      }
      return { halfWidth, lowest }
    }

    /** 静置时碗的 y:旋转后的最低点正好贴着底边。 */
    function restingY(bowl, viewHeight) {
      const extents = rotatedExtents(bowl.w, bowl.h, bowl.rot, 1, 1)
      return viewHeight - bowl.h - extents.lowest
    }

    /**
     * 这一碗离暴风钮中心有多近。
     *
     * 取"碗心"和"手(指针)"两处距离的较小值:碗在单摆模型里吊在手下,拖的时候
     * 碗身比指针低一截,只看碗或只看手都会让玩家觉得判定别扭。
     *
     * @param bowl - 物理状态。
     * @param target - 暴风钮中心 { x, y }。
     * @returns 距离(px)。
     */
    function nearVortex(bowl, target) {
      const byBowl = Math.hypot(bowl.x + bowl.w / 2 - target.x, bowl.y + bowl.h / 2 - target.y)
      const byPointer = Math.hypot(bowl.pointerX - target.x, bowl.pointerY - target.y)
      return Math.min(byBowl, byPointer)
    }

    /**
     * 拖拽中的一碗:鼠标是"手",碗吊在手上。
     *
     *   · 抓取点被一根弹簧拉向指针(带阻尼),所以碗会稍微滞后、静垂一点点;
     *   · 碗绕抓取点受重力力矩,也就是单摆方程 θ″ = g·sinφ / L —— 于是它会荡到
     *     "重心垂在手下"的姿态,拖着走时绕鼠标摆、甩一下会荡起来;
     *   · 墙壁与地面照样挡住它,只是撞上去不再弹跳。
     *
     * 抓取点存的是**碗的局部坐标**,所以它随碗一起转:无论从哪个角抓起来,
     * 都是那个角被手捏着转。
     *
     * @param bowl - 物理状态(原地修改)。
     * @param view - 视口尺寸 { w, h }。
     * @param dt - 时间步长(秒)。
     */
    function stepDragBowl(bowl, view, dt) {
      const halfW = bowl.w / 2
      const rad = (bowl.rot * Math.PI) / 180
      const cs = Math.cos(rad)
      const sn = Math.sin(rad)

      // 抓取点:局部坐标 → 世界坐标(变换原点是底面中点,见 CSS 的 transform-origin)
      const localX = bowl.grabLocalX - halfW
      const localY = bowl.grabLocalY - bowl.h
      const grabX = bowl.x + halfW + localX * cs - localY * sn
      const grabY = bowl.y + bowl.h + localX * sn + localY * cs

      // 重心:相对变换原点的偏移是 (0, -COM_ARM·h)

      // 线速度:弹簧跟手 + 重力,再积分(semi-implicit Euler,DRAG_SPRING 在这个步长下稳定)
      const errX = bowl.pointerX - grabX
      const errY = bowl.pointerY - grabY
      bowl.vx += (DRAG_SPRING * errX - DRAG_DAMP * bowl.vx) * dt
      bowl.vy += (DRAG_SPRING * errY - DRAG_DAMP * bowl.vy + GRAVITY) * dt
      bowl.x += bowl.vx * dt
      bowl.y += bowl.vy * dt

      // 角速度:单摆。支点是**抓取点**(不是碗的变换原点,也不是指针):
      // 力臂 = 抓取点 → 重心这条随碗一起转的向量,重力在它水平分量上产生力矩。
      //   τ/m = g · armWorldX
      //   I/m = |arm|² + (w²+h²)/12     ← 平行轴定理,盒子自身转动惯量兜底
      const comLocalY = -COM_ARM * bowl.h
      const armLocalX = -localX // 重心的 x 相对原点是 0
      const armLocalY = comLocalY - localY
      const armWorldX = armLocalX * cs - armLocalY * sn
      const inertia = armLocalX * armLocalX + armLocalY * armLocalY + (bowl.w * bowl.w + bowl.h * bowl.h) / 12
      const angularAcc = clamp((GRAVITY * armWorldX * DRAG_TORQUE * 180) / (Math.PI * inertia), -DRAG_MAX_ANG_ACC, DRAG_MAX_ANG_ACC)
      bowl.spin += angularAcc * dt
      bowl.spin *= Math.pow(DRAG_ANG_DRAG, dt)
      bowl.rot += bowl.spin * dt

      // 边墙与地面:按**旋转后**的包围盒挡,斜着的碗才不会探出屏幕/穿到底边以下。
      const extents = rotatedExtents(bowl.w, bowl.h, bowl.rot, 1, 1)
      const centerX = bowl.x + halfW
      const margin = extents.halfWidth * 0.2
      if (centerX < margin) {
        bowl.x = margin - halfW
        bowl.vx = Math.abs(bowl.vx) * DRAG_WALL_FRICTION
      } else if (centerX > view.w - margin) {
        bowl.x = view.w - margin - halfW
        bowl.vx = -Math.abs(bowl.vx) * DRAG_WALL_FRICTION
      }
      const floor = view.h - bowl.h - extents.lowest
      if (bowl.y > floor) {
        bowl.y = floor
        if (bowl.vy > 0) bowl.vy = -bowl.vy * DRAG_WALL_FRICTION
      }
    }

    // ---- 暴风吸入的音效 ----
    // 内嵌 base64,而不是让宿主多发一个 /token2rice/food.mp3 路由:宿主半边的新路由
    // 要重启 DSH 才生效,而客户端半边刷新即可。换音效跑 tools/embed-sound.py。
    // >>> token2rice:inhale-sound (由 tools/embed-sound.py 生成,勿手改下面这行)
    const INHALE_SOUND_B64 = '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'
    // <<< token2rice:inhale-sound

    /** 解码后的 object URL 与复用的 Audio 元素(都只建一次)。 */
    let inhaleSoundUrl
    let inhaleSoundElement = null

    /**
     * 播一次吸入音效。
     *
     * 连点 / 连续喂碗都从头重放同一个元素,不叠音。两个触发点(点钮、松手喂碗)
     * 都是用户手势,所以不会被浏览器的自动播放策略拦。
     */
    function playInhaleSound() {
      if (INHALE_SOUND_B64 === '') return
      try {
        if (inhaleSoundUrl === undefined) {
          const binary = atob(INHALE_SOUND_B64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
          inhaleSoundUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
        }
        if (inhaleSoundElement === null) {
          inhaleSoundElement = new Audio(inhaleSoundUrl)
          inhaleSoundElement.preload = 'auto'
        }
        inhaleSoundElement.currentTime = 0
        const started = inhaleSoundElement.play()
        if (started !== undefined && typeof started.catch === 'function') started.catch(() => {})
      } catch (error) {
        // 解码或播放失败不该影响吸入动画。
      }
    }

    /** 卸载时收尾:停掉播放并释放 object URL。 */
    function disposeInhaleSound() {
      if (inhaleSoundElement !== null) {
        try {
          inhaleSoundElement.pause()
        } catch (error) {
          // 忽略:元素可能已经被丢弃。
        }
        inhaleSoundElement = null
      }
      if (inhaleSoundUrl !== undefined) {
        URL.revokeObjectURL(inhaleSoundUrl)
        inhaleSoundUrl = undefined
      }
    }

    // ---- "暴风吸入"图标 ----
    // 和 assets/vortex.svg 是同一套几何(中心 12,12):一条向内的阿基米德螺旋、
    // 一个风眼、三粒带着拖尾被卷进来的米。这里现场算路径,免得往代码里贴坐标。

    /** 向内的螺旋路径(屏幕 y 向下,所以正角度方向看起来是顺时针)。 */
    function vortexSpiralPath(rOut, rIn, turns, samples) {
      const total = turns * Math.PI * 2
      let d = ''
      for (let i = 0; i <= samples; i += 1) {
        const t = i / samples
        const theta = t * total
        const r = rOut + (rIn - rOut) * t
        d += (i === 0 ? 'M' : 'L') + (12 + r * Math.cos(theta)).toFixed(2) + ' ' + (12 + r * Math.sin(theta)).toFixed(2)
      }
      return d
    }

    /** 一段圆弧路径(米粒身后的拖尾)。 */
    function vortexArcPath(radius, degFrom, degTo, samples) {
      let d = ''
      for (let i = 0; i <= samples; i += 1) {
        const deg = degFrom + ((degTo - degFrom) * i) / samples
        const theta = (deg * Math.PI) / 180
        d += (i === 0 ? 'M' : 'L') + (12 + radius * Math.cos(theta)).toFixed(2) + ' ' + (12 + radius * Math.sin(theta)).toFixed(2)
      }
      return d
    }

    const VORTEX_GRAIN_ANGLES = [200, 302, 64]
    const VORTEX_GRAIN_RADIUS = 10.2
    const VORTEX_ART = {
      eye: 1.25,
      main: vortexSpiralPath(8.3, 2.6, 1.62, 60),
      mainStroke: 1.8,
      trailStroke: 1,
      trailOpacity: 0.42,
      trails: VORTEX_GRAIN_ANGLES.map((deg) => vortexArcPath(VORTEX_GRAIN_RADIUS, deg - 30, deg - 6, 10)),
      grains: VORTEX_GRAIN_ANGLES.map((deg) => {
        const theta = (deg * Math.PI) / 180
        return {
          cx: 12 + VORTEX_GRAIN_RADIUS * Math.cos(theta),
          cy: 12 + VORTEX_GRAIN_RADIUS * Math.sin(theta),
          deg: deg + 90,
        }
      }),
    }

    /** 暴风吸入图标(纯 currentColor,深浅主题都跟宿主走)。 */
    function VortexIcon(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 24
      const art = VORTEX_ART
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('circle', { cx: 12, cy: 12, r: art.eye, fill: 'currentColor' }),
        h('path', {
          d: art.main,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: art.mainStroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        art.trails.map((d, index) =>
          h('path', {
            key: 'trail' + index,
            d,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: art.trailStroke,
            strokeLinecap: 'round',
            opacity: art.trailOpacity,
          }),
        ),
        art.grains.map((grain, index) =>
          h('ellipse', {
            key: 'grain' + index,
            cx: grain.cx.toFixed(2),
            cy: grain.cy.toFixed(2),
            rx: 1.25,
            ry: 0.8,
            transform: 'rotate(' + grain.deg.toFixed(1) + ' ' + grain.cx.toFixed(2) + ' ' + grain.cy.toFixed(2) + ')',
            fill: 'currentColor',
          }),
        ),
      )
    }

    /**
     * 被漩涡吸走的一帧。
     *
     * 位置沿一条对数感的螺旋收向风眼:半径按 (1-p)^1.25 收,角度按 p^0.85 推进
     * (所以越靠近风眼转得越快、越挤),同时等比缩小并淡出。
     *
     * @param bowl - 物理状态(要求 bowl.inhale 已就位)。
     * @param dt - 时间步长(秒)。
     * @returns 是否已经吸到风眼(该被移除)。
     */
    function stepInhaleBowl(bowl, dt) {
      const swirl = bowl.inhale
      swirl.t += dt
      const p = Math.min(1, swirl.t / swirl.dur)
      const radius = swirl.radius * Math.pow(1 - p, INHALE_RADIUS_POWER)
      const angle = swirl.angle + swirl.turns * Math.PI * 2 * Math.pow(p, INHALE_ANGLE_POWER)
      bowl.x = swirl.cx + radius * Math.cos(angle) - bowl.w / 2
      bowl.y = swirl.cy + radius * Math.sin(angle) - bowl.h / 2
      bowl.rot += swirl.spin * (0.35 + p) * dt
      bowl.scale = Math.max(0.06, 1 - p * INHALE_SHRINK)
      return p >= 1
    }

    function Token2RiceOverlay() {
      const [settings, setSettings] = React.useState(loadSettings)
      const [snapshot, setSnapshot] = React.useState(null)
      const [connected, setConnected] = React.useState(true)
      /** 只用来触发 DOM 增删:碗的位置和速度全在 simRef 里,不走 React。 */
      const [serialList, setSerialList] = React.useState([])
      const [grains, setGrains] = React.useState([])
      const [panelOpen, setPanelOpen] = React.useState(false)
      const [artFailed, setArtFailed] = React.useState(false)
      const [vp, setVp] = React.useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
      const [dragPos, setDragPos] = React.useState(null)
      /** 暴风吸入的视觉:非 null 时在风眼放一圈旋转扩散的螺旋。 */
      const [storm, setStorm] = React.useState(null)
      /** 正把某碗拖到暴风钮附近(钮会点亮,提示"松手就被吸走")。 */
      const [vortexHot, setVortexHot] = React.useState(false)
      /** 自带米饭图:上传/恢复后先信本地值,等下一次快照确认再交回宿主。 */
      const [artOverride, setArtOverride] = React.useState(null)
      const [artNotice, setArtNotice] = React.useState(null)
      const [artDropping, setArtDropping] = React.useState(false)
      /** 本地兜底图:宿主没有 /art 路由时,图存在这个浏览器的 IndexedDB 里。 */
      const [localArt, setLocalArt] = React.useState(null)
      /** 输入框草稿:受控 number 直接绑 per 会让用户根本打不出新数字。 */
      const [draftPer, setDraftPer] = React.useState(() => String(loadSettings().tokensPerBowl))

      const probeRef = React.useRef(null)
      if (probeRef.current === null) probeRef.current = makeEndpoint()

      /** 物理世界。list 顺序 = 生成顺序,bySerial 给指针回调反查。 */
      const simRef = React.useRef({ list: [], bySerial: new Map() })
      const elRefs = React.useRef(new Map())
      const engineRef = React.useRef(null)
      const vpRef = React.useRef(vp)
      const settingsRef = React.useRef(settings)
      const aspectRef = React.useRef(DEFAULT_ASPECT)
      const serialRef = React.useRef(0)
      const earnedRef = React.useRef(null)
      /** 上一次生效的"最多摆几碗",用来在用户拖动滑杆时重新裁剪。 */
      const limitRef = React.useRef(0)
      const anchorDragRef = React.useRef(null)
      const dragPosRef = React.useRef(null)
      const fileInputRef = React.useRef(null)
      /** 面板里改完图之后立刻拉一次账本,不用等下一个轮询周期。 */
      const refreshRef = React.useRef(null)
      /** 当前本地图的对象 URL;换图/卸载时都要撤销。 */
      const localUrlRef = React.useRef(null)
      /** 本地图的原始 Blob:宿主路由上线后要把它搬过去。 */
      const localBlobRef = React.useRef(null)
      /** 搬运每次挂载只试一次,免得失败时每 2.5 秒重试一遍。 */
      const migrateTriedRef = React.useRef(false)
      /** 暴风钮中心:拖拽/松手判定要在事件回调里读,所以放 ref。 */
      const vortexCenterRef = React.useRef({ x: 0, y: 0 })
      /** 上一次的"是否靠近暴风钮",避免 pointermove 每次都 setState。 */
      const vortexHotRef = React.useRef(false)

      const reduceMotion = React.useRef(false)
      if (typeof window.matchMedia === 'function') {
        reduceMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      }

      vpRef.current = vp
      settingsRef.current = settings

      const update = React.useCallback((patch) => {
        setSettings((prev) => {
          const next = { ...prev, ...patch }
          saveSettings(next)
          return next
        })
      }, [])

      // ---- 渲染写入:位置只在这里落到 DOM ----
      const paint = React.useCallback((bowl) => {
        const el = elRefs.current.get(bowl.serial)
        if (el === undefined) return
        const scale = bowl.scale === undefined ? 1 : bowl.scale
        const squashX = (1 + bowl.squash * 0.55) * scale
        const squashY = (1 - bowl.squash) * scale
        el.style.width = bowl.w + 'px'
        el.style.opacity = scale < 0.999 ? String(Math.max(0.12, scale)) : ''
        el.style.transform =
          'translate3d(' + bowl.x.toFixed(1) + 'px,' + bowl.y.toFixed(1) + 'px,0) rotate(' +
          bowl.rot.toFixed(2) + 'deg) scale(' + squashX.toFixed(3) + ',' + squashY.toFixed(3) + ')'
      }, [])

      const spawnGrains = React.useCallback((bowl) => {
        const count = 5
        const burst = []
        for (let i = 0; i < count; i += 1) {
          const angle = (i / count) * Math.PI - Math.PI * 0.06
          burst.push({
            key: bowl.serial + '-g' + i,
            x: bowl.x + bowl.w / 2,
            y: bowl.y + bowl.h * 0.92,
            dx: Math.cos(angle) * (12 + i * 3),
            dy: -Math.sin(angle) * 9,
          })
        }
        setGrains((current) => current.concat(burst))
        window.setTimeout(() => {
          setGrains((current) => current.filter((grain) => grain.key.indexOf(bowl.serial + '-g') !== 0))
        }, SPLASH_MS)
      }, [])

      // ---- 物理循环:一个 rAF 同时管"掉落""被甩出去""落地弹跳" ----
      React.useEffect(() => {
        const sim = simRef.current
        let raf = 0
        let last = 0

        const step = (now) => {
          raf = 0
          const dt = last === 0 ? 0.016 : Math.min(0.032, (now - last) / 1000)
          last = now
          const view = vpRef.current
          const settleUpright = settingsRef.current.settleUpright !== false
          let active = false
          const dead = []

          for (const bowl of sim.list) {
            if (bowl.inhale !== null && bowl.inhale !== undefined) {
              // 被暴风吸走:沿螺旋收向风眼,到点就报销,并在风眼溅一小撮米。
              if (stepInhaleBowl(bowl, dt)) {
                spawnGrains(bowl)
                bowl.inhale = null
                dead.push(bowl.serial)
              } else {
                paint(bowl)
              }
              active = true
              continue
            }
            if (bowl.wait > 0) {
              // 补发时的出场间隔:先在屏幕上方等着,时间到了再落。
              bowl.wait -= dt
              active = true
              continue
            }
            if (bowl.dragging) {
              // 拖拽中:鼠标是手,碗吊在手上——弹簧跟手 + 绕抓取点的重力力矩(单摆)。
              stepDragBowl(bowl, view, dt)
              paint(bowl)
              active = true
              continue
            }

            if (!bowl.resting) {
              bowl.vy += GRAVITY * dt
              bowl.x += bowl.vx * dt
              bowl.y += bowl.vy * dt
              bowl.rot += bowl.spin * dt
              bowl.vx *= Math.pow(AIR_DRAG, dt)
              bowl.spin *= Math.pow(0.3, dt)
            }

            // 落地判定按**旋转后**的包围盒:斜着落的那碗最低点是它的角,不是底面中点。
            const extents = rotatedExtents(bowl.w, bowl.h, bowl.rot, 1, 1)
            const floor = view.h - bowl.h - extents.lowest
            if (bowl.y > floor) {
              bowl.y = floor
              const impact = bowl.vy
              if (impact > BOUNCE_FLOOR) {
                bowl.squash = Math.min(0.5, impact / 5200)
                bowl.vy = -impact * RESTITUTION
                bowl.vx *= 0.7
                bowl.spin *= 0.45
                if (!bowl.splashed) {
                  bowl.splashed = true
                  spawnGrains(bowl)
                }
              } else {
                bowl.vy = 0
                bowl.resting = true
              }
            }

            if (bowl.resting) {
              // 地面上滑行;滑停之后是否"慢慢摆正到自己的静止倾角"由用户开关决定
              // (面板里的「落地自动回正」)。关掉就保持落地时的倾角,一堆米歪着更自然。
              if (Math.abs(bowl.vx) > 4) {
                bowl.x += bowl.vx * dt
                bowl.vx *= Math.pow(GROUND_FRICTION, dt)
                active = true
              } else {
                bowl.vx = 0
                if (settleUpright) {
                  if (Math.abs(bowl.rot - bowl.restTilt) > 0.08) {
                    bowl.rot += (bowl.restTilt - bowl.rot) * Math.min(1, 6 * dt)
                    active = true
                  } else {
                    bowl.rot = bowl.restTilt
                  }
                }
              }
              // 回正/滑行会改变"旋转后的最低点",所以每帧重新贴一次地:
              // 否则碗回正时会浮起一条缝,或者又沉回底边以下。
              bowl.y = restingY(bowl, view.h)
            } else {
              active = true
            }

            // 左右墙:同样按旋转后的包围盒算,允许探出小半个身子,撞上去回弹。
            const centerX = bowl.x + bowl.w / 2
            const wallMargin = extents.halfWidth * 0.2
            if (centerX < wallMargin) {
              bowl.x = wallMargin - bowl.w / 2
              bowl.vx = Math.abs(bowl.vx) * WALL_BOUNCE
            } else if (centerX > view.w - wallMargin) {
              bowl.x = view.w - wallMargin - bowl.w / 2
              bowl.vx = -Math.abs(bowl.vx) * WALL_BOUNCE
            }

            if (bowl.squash > 0.001) {
              bowl.squash *= Math.pow(0.0005, dt)
              if (bowl.squash < 0.001) bowl.squash = 0
              active = true
            } else {
              bowl.squash = 0
            }

            paint(bowl)
          }

          if (dead.length > 0) {
            // 吸到风眼的那几碗:摘出物理世界并重渲染列表(React 会卸载对应 img)。
            const gone = new Set(dead)
            sim.list = sim.list.filter((bowl) => !gone.has(bowl.serial))
            for (const serial of dead) sim.bySerial.delete(serial)
            setSerialList(sim.list.map((bowl) => bowl.serial))
          }

          if (active) raf = requestAnimationFrame(step)
          else last = 0
        }

        engineRef.current = {
          kick() {
            if (raf !== 0) return
            last = 0
            raf = requestAnimationFrame(step)
          },
          stop() {
            if (raf !== 0) cancelAnimationFrame(raf)
            raf = 0
            last = 0
          },
        }
        return () => {
          if (raf !== 0) cancelAnimationFrame(raf)
          engineRef.current = null
        }
      }, [paint, spawnGrains])

      const kick = React.useCallback(() => {
        const engine = engineRef.current
        if (engine !== null) engine.kick()
      }, [])

      // ---- 碗的增删 ----
      const makeBowl = React.useCallback((serial, rest) => {
        const pose = spawnPose(serial)
        const size = settingsRef.current.bowlSize
        const height = size * aspectRef.current
        const view = vpRef.current
        const x = clamp((pose.xPercent / 100) * view.w, 0, Math.max(0, view.w - size))
        const bowl = {
          serial,
          x,
          y: rest ? view.h - height - rotatedExtents(size, height, pose.tilt, 1, 1).lowest : -height - 24,
          vx: 0,
          vy: 0,
          rot: pose.tilt,
          restTilt: pose.tilt,
          spin: 0,
          w: size,
          h: height,
          squash: 0,
          wait: 0,
          splashed: false,
          dragging: false,
          resting: rest,
          // 抓取点(碗的局部坐标,随碗一起转)与指针的世界坐标
          grabLocalX: 0,
          grabLocalY: 0,
          pointerX: 0,
          pointerY: 0,
          // 视觉缩放(暴风吸入时收缩)与吸入状态
          scale: 1,
          inhale: null,
        }
        simRef.current.list.push(bowl)
        simRef.current.bySerial.set(serial, bowl)
        return bowl
      }, [])

      const newBowl = React.useCallback((rest) => {
        serialRef.current += 1
        return makeBowl(serialRef.current, rest)
      }, [makeBowl])

      const removeBowl = React.useCallback((serial) => {
        const sim = simRef.current
        const index = sim.list.findIndex((bowl) => bowl.serial === serial)
        if (index === -1) return
        sim.list.splice(index, 1)
        sim.bySerial.delete(serial)
        setSerialList(sim.list.map((bowl) => bowl.serial))
      }, [])

      const syncList = React.useCallback(() => {
        setSerialList(simRef.current.list.map((bowl) => bowl.serial))
      }, [])

      /** 把碗数裁到 target:先扔最老的、没在被拖的那些。 */
      const trimTo = React.useCallback((target) => {
        const sim = simRef.current
        while (sim.list.length > target) {
          const index = sim.list.findIndex((bowl) => !bowl.dragging)
          if (index === -1) break
          sim.bySerial.delete(sim.list[index].serial)
          sim.list.splice(index, 1)
        }
      }, [])

      // ---- 账本轮询 ----
      React.useEffect(() => {
        let alive = true
        let busy = false
        const tick = async () => {
          if (!alive || busy) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          busy = true
          try {
            const data = await probeRef.current()
            if (!alive) return
            setConnected(data !== null)
            if (data !== null) {
              setSnapshot(data)
              // 快照已经和本地改动一致,就把图的决定权交回宿主。
              setArtOverride((current) => {
                if (current === null) return null
                const next = data.art === undefined ? { custom: false, version: 0 } : data.art
                const same =
                  (next.custom === true) === (current.custom === true) &&
                  (Number(next.version) || 0) === (Number(current.version) || 0)
                return same ? null : current
              })
            }
          } finally {
            busy = false
          }
        }
        refreshRef.current = () => { void tick() }
        void tick()
        const timer = window.setInterval(() => { void tick() }, POLL_MS)
        const onVisible = () => { if (document.visibilityState === 'visible') void tick() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          refreshRef.current = null
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      // ---- 本地兜底图:开面板之前就该就位,否则会先闪一下默认图 ----
      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const blob = await idbReadArt()
            if (!alive || blob === null || blob === undefined) return
            installLocalArt(blob)
          } catch (error) {
            // 没有本地图,或者浏览器不给用 IndexedDB。
          }
        })()
        return () => {
          alive = false
          if (localUrlRef.current !== null) {
            URL.revokeObjectURL(localUrlRef.current)
            localUrlRef.current = null
          }
        }
      }, [])

      // ---- 宿主路由上线后,把本地那张图自动搬过去(每次挂载只试一次) ----
      // 场景:先在不带 /art 的宿主版本上导入了图,图暂存在本浏览器;重启 DSH 后
      // 宿主能收图了,就把本地那份搬过去,以后换浏览器也在。
      React.useEffect(() => {
        if (localArt === null || snapshot === null) return
        if (snapshot.art === undefined) return // 宿主还是旧版,没有 /art
        if (snapshot.art.custom === true) return // 宿主已经有图,别悄悄盖掉
        if (migrateTriedRef.current) return
        const blob = localBlobRef.current
        if (blob === null) return
        migrateTriedRef.current = true
        void (async () => {
          try {
            const response = await fetch(probeRef.current.sibling('art'), {
              method: 'POST',
              headers: { 'content-type': blob.type === '' ? 'application/octet-stream' : blob.type },
              body: blob,
              signal: AbortSignal.timeout(20000),
            })
            if (!response.ok) return
            const data = await response.json()
            if (data !== null && typeof data === 'object' && data.art !== undefined) setArtOverride(data.art)
            await dropLocalArt()
            flashArt('ok', '本地那张图已经搬到宿主')
            if (refreshRef.current !== null) refreshRef.current()
          } catch (error) {
            // 搬不过去就继续用本地那张,下次挂载再试。
          }
        })()
      }, [snapshot, localArt])

      // ---- 视口尺寸:重新夹取位置,躺着的碗重新贴上底边 ----
      React.useEffect(() => {
        const onResize = () => {
          const next = { w: window.innerWidth, h: window.innerHeight }
          vpRef.current = next
          setVp(next)
          for (const bowl of simRef.current.list) {
            bowl.w = settingsRef.current.bowlSize
            bowl.h = bowl.w * aspectRef.current
            const minX = -bowl.w * 0.4
            bowl.x = clamp(bowl.x, minX, Math.max(minX, next.w - bowl.w * 0.6))
            if (bowl.resting) bowl.y = restingY(bowl, next.h)
            paint(bowl)
          }
          kick()
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [paint, kick])

      const counted = countedTokens(snapshot === null ? null : snapshot.totals, settings.countCache)
      const per = Math.max(1000, Math.round(settings.tokensPerBowl))
      const earned = snapshot === null ? null : Math.floor(counted / per)
      /** 画面上同时摆几碗(用户可调),超出就把最老的请出去。 */
      const bowlLimit = clamp(Math.round(settings.maxBowls), BOWL_LIMIT_FLOOR, BOWL_LIMIT_CEIL)

      React.useEffect(() => {
        setDraftPer(String(per))
      }, [per])

      // ---- 账本 / 旋钮变化 -> 增减碗 ----
      React.useEffect(() => {
        if (earned === null) return
        const previous = earnedRef.current
        earnedRef.current = earned
        if (previous !== null && earned === previous && bowlLimit === limitRef.current) return
        limitRef.current = bowlLimit
        const sim = simRef.current

        if (previous === null) {
          // 首屏:把已经挣到的碗直接摆在地上(不动画),刷新不该下 Rice 暴雨。
          const target = Math.min(earned, bowlLimit)
          for (let i = sim.list.length; i < target; i += 1) newBowl(true)
          syncList()
          return
        }

        if (earned > previous) {
          const grew = Math.min(earned - previous, bowlLimit * 2)
          let dropped = 0
          for (let i = 0; i < grew; i += 1) {
            const animate = !reduceMotion.current && dropped < MAX_DROP_BATCH
            if (animate) {
              // 掉下来的这碗:随机朝向 + 随机自转 + 随机初速度(y 分量必定向下)。
              const bowl = randomizeSpawn(newBowl(false))
              bowl.y = -bowl.h - 24 - dropped * 20
              bowl.wait = dropped * 0.13
              dropped += 1
            } else {
              // 直接摆到地上的那几碗:同样给随机朝向(看起来就是"刚落地、还歪着"),
              // 但没有初速度,并且按旋转后的包围盒重新贴地。
              const bowl = randomizeSpawn(newBowl(true))
              bowl.vx = 0
              bowl.vy = 0
              bowl.spin = 0
              bowl.y = restingY(bowl, vpRef.current.h)
            }
          }
          trimTo(bowlLimit)
          syncList()
          kick()
          return
        }

        // 阈值调大、账本被重置,或者用户改了"最多摆几碗":按新目标裁掉最旧的几碗。
        trimTo(Math.min(earned, bowlLimit))
        syncList()
      }, [earned, bowlLimit, newBowl, trimTo, syncList, kick])

      // ---- 米饭大小变化:飞行中的碗也立刻换尺寸 ----
      React.useEffect(() => {
        for (const bowl of simRef.current.list) {
          bowl.w = settings.bowlSize
          bowl.h = settings.bowlSize * aspectRef.current
          if (bowl.resting) bowl.y = restingY(bowl, vpRef.current.h)
          paint(bowl)
        }
        kick()
      }, [settings.bowlSize, paint, kick])

      // ---- 开关"落地自动回正"后立刻重跑一遍:躺着的碗当场摆正 / 就地停住 ----
      React.useEffect(() => {
        kick()
      }, [settings.settleUpright, kick])

      // ---- 卸载时收尾音效(停播 + 释放 object URL) ----
      React.useEffect(() => () => { disposeInhaleSound() }, [])

      // ---- 碗的拖动 ----
      const setBowlEl = React.useCallback((serial, el) => {
        if (el === null) {
          elRefs.current.delete(serial)
          return
        }
        elRefs.current.set(serial, el)
        const bowl = simRef.current.bySerial.get(serial)
        if (bowl !== undefined) paint(bowl)
      }, [paint])

      /** 图加载完拿到真实纵横比,顺手把所有碗的高度对齐。 */
      const onArtLoad = React.useCallback((event) => {
        const el = event.currentTarget
        if (el.naturalWidth > 0 && el.naturalHeight > 0) {
          const aspect = el.naturalHeight / el.naturalWidth
          if (Math.abs(aspect - aspectRef.current) > 0.001) {
            aspectRef.current = aspect
            for (const bowl of simRef.current.list) {
              bowl.h = bowl.w * aspect
              if (bowl.resting) bowl.y = restingY(bowl, vpRef.current.h)
              paint(bowl)
            }
          }
        }
      }, [paint])

      const beginBowlDrag = (event, serial) => {
        const bowl = simRef.current.bySerial.get(serial)
        if (bowl === undefined) return
        if (event.pointerType === 'mouse' && event.button !== 0) return
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (error) {
          // 捕获失败也还能靠元素上的事件勉强拖;不致命。
        }
        const pointerX = event.clientX
        const pointerY = event.clientY
        bowl.dragging = true
        bowl.resting = false
        bowl.squash = 0
        bowl.splashed = false
        vortexHotRef.current = false
        setVortexHot(false)
        // 把指针位置换算成碗的局部坐标 = 手捏住的那个点;之后它随碗一起转,
        // 所以抓着碗沿拖的时候,碗是绕着那个碗沿摆的。
        const rad = (-bowl.rot * Math.PI) / 180
        const cs = Math.cos(rad)
        const sn = Math.sin(rad)
        const dx = pointerX - bowl.x - bowl.w / 2
        const dy = pointerY - bowl.y - bowl.h
        bowl.pointerX = pointerX
        bowl.pointerY = pointerY
        bowl.grabLocalX = bowl.w / 2 + dx * cs - dy * sn
        bowl.grabLocalY = bowl.h + dx * sn + dy * cs
        // 抓到手的一瞬间接管动量,之后由弹簧与单摆重新积累。
        bowl.vx = 0
        bowl.vy = 0
        bowl.spin = 0
        kick()
        event.preventDefault()
        event.stopPropagation()
      }

      const moveBowlDrag = (event, serial) => {
        const bowl = simRef.current.bySerial.get(serial)
        if (bowl === undefined || !bowl.dragging) return
        // 只记手的位置:位置与姿态由 stepDragBowl 用物理算出来,不再是"贴到指针上"。
        bowl.pointerX = event.clientX
        bowl.pointerY = event.clientY
        // 拖到暴风钮附近就把钮点亮:提示"在这儿松手会被吸走"。
        const hot = nearVortex(bowl, vortexCenterRef.current) <= VORTEX_DROP_RADIUS
        if (hot !== vortexHotRef.current) {
          vortexHotRef.current = hot
          setVortexHot(hot)
        }
        event.preventDefault()
      }

      const endBowlDrag = (event, serial) => {
        const bowl = simRef.current.bySerial.get(serial)
        if (bowl === undefined || !bowl.dragging) return
        // 松手时若碗(或手)落在暴风钮附近,就**单碗吸入**,而不是抛出去。
        if (nearVortex(bowl, vortexCenterRef.current) <= VORTEX_DROP_RADIUS) {
          inhaleOne(bowl)
          event.preventDefault()
          return
        }
        bowl.dragging = false
        bowl.wait = 0
        vortexHotRef.current = false
        setVortexHot(false)
        // 松手就是自由落体:弹簧攒下的线速度与摆动的角速度直接变成抛出去的初速度,
        // 只做上限保护,免得猛甩一下把碗甩到屏幕外。
        const speed = Math.sqrt(bowl.vx * bowl.vx + bowl.vy * bowl.vy)
        if (speed > MAX_THROW) {
          const scale = MAX_THROW / speed
          bowl.vx *= scale
          bowl.vy *= scale
        }
        bowl.spin = clamp(bowl.spin, -MAX_SPIN, MAX_SPIN)
        bowl.resting = false
        kick()
        event.preventDefault()
      }

      // ---- 计数牌 / 面板的拖动 ----
      const badgeSize = { w: BADGE_W, h: BADGE_H }
      const homePos = {
        left: Math.max(EDGE, vp.w - BADGE_MARGIN - badgeSize.w),
        top: Math.max(EDGE, vp.h - 12 - badgeSize.h),
      }
      const storedPos = settings.badgePos === null
        ? homePos
        : {
            left: clamp(settings.badgePos.left, EDGE, Math.max(EDGE, vp.w - badgeSize.w - EDGE)),
            top: clamp(settings.badgePos.top, EDGE, Math.max(EDGE, vp.h - badgeSize.h - EDGE)),
          }
      const pos = dragPos === null ? storedPos : dragPos

      // 暴风钮跟在计数牌旁边:左边放得下就放左边,放不下就摞在它上方。
      const vortexPos = pos.left - VORTEX_SIZE - 8 >= EDGE
        ? { left: pos.left - VORTEX_SIZE - 8, top: pos.top + (badgeSize.h - VORTEX_SIZE) / 2 }
        : { left: pos.left, top: Math.max(EDGE, pos.top - VORTEX_SIZE - 8) }
      const vortexCenter = { x: vortexPos.left + VORTEX_SIZE / 2, y: vortexPos.top + VORTEX_SIZE / 2 }
      vortexCenterRef.current = vortexCenter

      /**
       * 给一碗装上螺旋吸入参数(单个吸入与整屏吸入共用同一套几何)。
       *
       * @param bowl - 要吸的那碗。
       * @param target - 风眼(暴风钮中心)的世界坐标。
       */
      const armInhale = (bowl, target) => {
        const dx = bowl.x + bowl.w / 2 - target.x
        const dy = bowl.y + bowl.h / 2 - target.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        const noise = noiseAt(bowl.serial + 31)
        if (bowl.dragging) bowl.dragging = false // 手还按着也先松手,再卷走
        bowl.wait = 0
        bowl.resting = false
        bowl.squash = 0
        bowl.inhale = {
          t: 0,
          dur: INHALE_MIN_SEC + Math.min(1, distance / Math.max(1, vp.w)) * (INHALE_MAX_SEC - INHALE_MIN_SEC),
          cx: target.x,
          cy: target.y,
          radius: Math.max(18, distance),
          angle: Math.atan2(dy, dx),
          turns: INHALE_TURNS_MIN + noiseAt(bowl.serial + 47) * (INHALE_TURNS_MAX - INHALE_TURNS_MIN),
          // 图标里的螺旋是顺时针向内卷的,所以碗也统一顺时针,视觉上才"同一个漩涡"
          spin: 720 + noise * 900,
        }
      }

      /** 在风眼放一圈旋转扩散的螺旋(单碗 / 全屏吸入共用)。 */
      const flashStorm = (target) => {
        setStorm({ key: Date.now(), x: target.x, y: target.y })
        window.setTimeout(() => setStorm(null), 950)
      }

      /**
       * 暴风吸入:把所有碗卷进漩涡。
       *
       * 每碗记一份螺旋参数(起点半径、起始角、圈数、自转方向),之后由
       * stepInhaleBowl 逐帧推进;正在被拖的碗先松手再吸。已挣到的计费不受影响
       * (想立刻清屏且不做动画,面板里还有「清空画面」)。
       */
      const startInhale = () => {
        if (storm !== null) return
        const sim = simRef.current
        let count = 0
        for (const bowl of sim.list) {
          if (bowl.inhale !== null && bowl.inhale !== undefined) continue
          armInhale(bowl, vortexCenter)
          count += 1
        }
        if (count === 0) return
        flashStorm(vortexCenter)
        if (settings.soundOn !== false) playInhaleSound()
        kick()
      }

      /** 拖到漩涡钮附近松手:只吸这一碗。 */
      const inhaleOne = (bowl) => {
        const target = vortexCenterRef.current
        armInhale(bowl, target)
        flashStorm(target)
        if (settings.soundOn !== false) playInhaleSound()
        setVortexHot(false)
        kick()
      }

      const beginAnchorDrag = (event, toggleOnClick) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (error) {
          // 同上,不致命。
        }
        anchorDragRef.current = {
          id: event.pointerId,
          sx: event.clientX,
          sy: event.clientY,
          ox: storedPos.left,
          oy: storedPos.top,
          moved: false,
          toggleOnClick,
        }
        event.preventDefault()
      }

      const moveAnchorDrag = (event) => {
        const drag = anchorDragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        const dx = event.clientX - drag.sx
        const dy = event.clientY - drag.sy
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
        drag.moved = true
        const next = {
          left: clamp(drag.ox + dx, EDGE, Math.max(EDGE, vp.w - badgeSize.w - EDGE)),
          top: clamp(drag.oy + dy, EDGE, Math.max(EDGE, vp.h - badgeSize.h - EDGE)),
        }
        dragPosRef.current = next
        setDragPos(next)
        event.preventDefault()
      }

      const endAnchorDrag = (event) => {
        const drag = anchorDragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        anchorDragRef.current = null
        if (drag.moved) {
          const landed = dragPosRef.current
          dragPosRef.current = null
          setDragPos(null)
          if (landed !== null) update({ badgePos: landed })
          return
        }
        if (drag.toggleOnClick) setPanelOpen((open) => !open)
      }

      /** 指针被系统取消:位置退回拖动前,也不要把面板点开。 */
      const cancelAnchorDrag = (event) => {
        const drag = anchorDragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        anchorDragRef.current = null
        dragPosRef.current = null
        setDragPos(null)
      }

      const anchorHandlers = (toggleOnClick) => ({
        onPointerDown: (event) => beginAnchorDrag(event, toggleOnClick),
        onPointerMove: moveAnchorDrag,
        onPointerUp: endAnchorDrag,
        onPointerCancel: cancelAnchorDrag,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (toggleOnClick) setPanelOpen((open) => !open)
          }
        },
      })

      const clearBowls = () => {
        earnedRef.current = earned
        simRef.current.list = []
        simRef.current.bySerial.clear()
        syncList()
      }

      const resetLedger = async () => {
        try {
          const url = new URL('token2rice/reset', document.baseURI).toString()
          const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(4000) })
          if (!response.ok) return
          earnedRef.current = 0
          simRef.current.list = []
          simRef.current.bySerial.clear()
          syncList()
          setSnapshot((prev) => (prev === null ? prev : { ...prev, totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }))
        } catch (error) {
          // 重置失败就保持现状。
        }
      }

      /** 提示条:出错就留着,成功 2.6 秒后自己消失。 */
      const flashArt = (kind, text) => {
        setArtNotice({ kind, text })
        if (kind !== 'ok') return
        window.setTimeout(() => {
          setArtNotice((current) => (current !== null && current.text === text ? null : current))
        }, 2600)
      }

      /** 把本地那张图挂成对象 URL(旧的要先撤销,否则每换一次漏一个)。 */
      const installLocalArt = (blob) => {
        let url = null
        try {
          url = URL.createObjectURL(blob)
        } catch (error) {
          return false
        }
        if (localUrlRef.current !== null) URL.revokeObjectURL(localUrlRef.current)
        localUrlRef.current = url
        localBlobRef.current = blob
        setLocalArt({ url, size: blob.size, type: blob.type })
        return true
      }

      const dropLocalArt = async () => {
        if (localUrlRef.current !== null) {
          URL.revokeObjectURL(localUrlRef.current)
          localUrlRef.current = null
        }
        localBlobRef.current = null
        setLocalArt(null)
        try {
          await idbDropArt()
        } catch (error) {
          // 表不存在 / 隐私模式:没有本地图可删。
        }
      }

      const handleUploadArt = async (file) => {
        if (file === undefined || file === null) return
        const looksImage = ART_TYPES.test(file.type) || (file.type === '' && ART_EXTENSIONS.test(file.name || ''))
        if (!looksImage) {
          flashArt('error', '只认 PNG / JPEG / WebP / GIF 位图')
          return
        }
        if (file.size > ART_MAX_BYTES) {
          flashArt('error', '图片太大,上限 4MB')
          return
        }
        flashArt('ok', '上传中…')

        // 先试宿主:存到 $DSH_HOME,换浏览器也还在。
        let hostArt = null
        let hostMissing = false
        try {
          const response = await fetch(probeRef.current.sibling('art'), {
            method: 'POST',
            headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
            body: file,
            signal: AbortSignal.timeout(20000),
          })
          if (response.ok) {
            const data = await response.json()
            hostArt = data !== null && typeof data === 'object' && data.art !== undefined ? data.art : { custom: true, version: Date.now(), contentType: file.type }
          } else if (response.status === 404 || response.status === 405) {
            hostMissing = true
          } else if (response.status === 413) {
            flashArt('error', '图片太大,上限 4MB')
            return
          } else if (response.status === 415) {
            flashArt('error', '宿主认不出这个图片格式')
            return
          } else if (response.status === 403) {
            flashArt('error', '只有本机页面能改米饭图(当前不是回环访问)')
            return
          } else {
            flashArt('error', '上传失败(' + response.status + ')')
            return
          }
        } catch (error) {
          hostMissing = true
        }

        if (hostArt !== null) {
          setArtOverride(hostArt)
          setArtFailed(false)
          await dropLocalArt()
          flashArt('ok', '已换成你自己的图(存在宿主)')
          if (refreshRef.current !== null) refreshRef.current()
          return
        }

        // 宿主还没有这个路由(装了新版但没重启):存在本浏览器,现在就能看。
        try {
          await idbWriteArt(file)
          installLocalArt(file)
          setArtFailed(false)
          flashArt('ok', hostMissing ? '已换成你自己的图(存在本浏览器;宿主路由要重启 DSH 才有)' : '已换成你自己的图')
        } catch (error) {
          flashArt('error', '这张图存不下(浏览器不允许本地存储)')
        }
      }

      /** 恢复默认:本地和宿主都清掉,回落到包里的 assets/bowl.png。 */
      const handleResetArt = async () => {
        await dropLocalArt()
        try {
          const response = await fetch(probeRef.current.sibling('art'), { method: 'DELETE', signal: AbortSignal.timeout(8000) })
          if (response.ok) {
            setArtOverride({ custom: false, version: 0, contentType: 'image/png' })
            setArtFailed(false)
            flashArt('ok', '已恢复默认米饭图')
            if (refreshRef.current !== null) refreshRef.current()
            return
          }
          if (response.status === 404 || response.status === 405) {
            setArtFailed(false)
            flashArt('ok', '已恢复默认米饭图(本地)')
            return
          }
          flashArt('error', '恢复失败(' + response.status + ')')
        } catch (error) {
          setArtFailed(false)
          flashArt('ok', '已恢复默认米饭图(本地)')
        }
      }

      const artInfo = artOverride !== null
        ? artOverride
        : snapshot === null || snapshot.art === undefined
          ? null
          : snapshot.art
      const artVersion = artInfo === null ? 0 : Number(artInfo.version) || 0
      const artCustom = artInfo !== null && artInfo.custom === true
      const artTag = artVersion > 0
        ? String(artVersion)
        : String(artInfo !== null && artInfo.builtinVersion !== undefined && Number(artInfo.builtinVersion) > 0 ? artInfo.builtinVersion : BUILTIN_ART_TAG)

      const imageUrl = localArt !== null
        ? localArt.url
        : artFailed
          ? FALLBACK_BOWL
          : bowlImageUrl(artTag)
      const artSource = localArt !== null ? '本浏览器' : artCustom ? '宿主' : '默认'
      const artIsCustom = localArt !== null || artCustom
      const remaining = earned === null ? null : per - (counted % per)
      const panelOnTop = pos.top + badgeSize.h / 2 > vp.h / 2
      // 面板横向居中于"暴风钮 + 计数牌"这一整组的中心,而不是对齐计数牌左缘:
      // 组合宽度 = 暴风钮 + 8 间隙 + 计数牌,所以面板比它宽,两侧各探出去一点。
      const clusterLeft = Math.min(pos.left, vortexPos.left)
      const clusterRight = Math.max(pos.left + badgeSize.w, vortexPos.left + VORTEX_SIZE)
      const panelLeft = clamp(
        (clusterLeft + clusterRight) / 2 - PANEL_WIDTH / 2,
        EDGE,
        Math.max(EDGE, vp.w - PANEL_WIDTH - EDGE),
      )
      const panelStyle = Object.assign(
        { left: panelLeft },
        panelOnTop ? { bottom: Math.max(EDGE, vp.h - pos.top + 8) } : { top: pos.top + badgeSize.h + 8 },
      )

      const layer = h(
        'div',
        { className: 't2r-layer', 'data-token2rice': 'layer' },
        serialList.map((serial) =>
          h('img', {
            key: serial,
            className: 't2r-bowl',
            src: imageUrl,
            alt: '',
            draggable: false,
            ref: (el) => setBowlEl(serial, el),
            onLoad: onArtLoad,
            onError: () => setArtFailed(true),
            onPointerDown: (event) => beginBowlDrag(event, serial),
            onPointerMove: (event) => moveBowlDrag(event, serial),
            onPointerUp: (event) => endBowlDrag(event, serial),
            onPointerCancel: (event) => endBowlDrag(event, serial),
            onDoubleClick: () => removeBowl(serial),
            style: { zIndex: 40 + (serial % 3) },
          }),
        ),
        grains.map((grain) =>
          h('span', {
            key: grain.key,
            className: 't2r-grain t2r-grain--go',
            style: {
              left: grain.x.toFixed(1) + 'px',
              top: grain.y.toFixed(1) + 'px',
              '--t2r-dx': grain.dx.toFixed(1) + 'px',
              '--t2r-dy': grain.dy.toFixed(1) + 'px',
            },
          }),
        ),
      )

      const earnedText = (earned === null ? 0 : earned) + ' 碗'

      // 暴风吸入钮:挂在计数牌左边(位置跟着计数牌走),按下后所有碗被卷进漩涡。
      const vortex = h(
        'button',
        {
          className: 't2r-vortex',
          'data-token2rice': 'vortex',
          'data-storming': storm === null ? 'no' : 'yes',
          'data-hot': vortexHot ? 'yes' : 'no',
          type: 'button',
          title: '暴风吸入:点一下卷走全部米饭;把一碗拖到这儿松手则只吸这一碗',
          disabled: storm !== null,
          style: { left: vortexPos.left + 'px', top: vortexPos.top + 'px' },
          onClick: startInhale,
        },
        h(VortexIcon, { size: VORTEX_ICON_SIZE }),
      )

      // 风眼处旋转扩散的螺旋(纯装饰,~0.9 秒后自己消失)
      const stormRing = storm === null
        ? null
        : h(
            'div',
            {
              className: 't2r-storm',
              'data-token2rice': 'storm',
              key: storm.key,
              style: { left: storm.x + 'px', top: storm.y + 'px' },
            },
            h(VortexIcon, { size: 96 }),
          )

      const badge = settings.showBadge
        ? h(
            'div',
            Object.assign(
              {
                className: 't2r-badge',
                'data-token2rice': 'badge',
                role: 'button',
                tabIndex: 0,
                title:
                  (connected ? 'token2rice:点击开面板,拖动移动位置' : 'token2rice:宿主计数未连接') +
                  ' · 当前 ' + formatTokens(counted) + ' / 每碗 ' + formatTokens(per),
              },
              anchorHandlers(true),
              { style: { left: pos.left + 'px', top: pos.top + 'px' } },
            ),
            h('img', { src: imageUrl, alt: '', draggable: false, onError: () => setArtFailed(true) }),
            h('span', null, earnedText),
            h(
              'span',
              { className: 't2r-dim' },
              connected ? formatTokens(counted) : h('span', { className: 't2r-warn' }, '未连接'),
            ),
          )
        : // 收起计数牌后仍留一个亮点,否则用户再也点不开设置。
          h(
            'div',
            Object.assign(
              {
                className: 't2r-dot',
                'data-token2rice': 'dot',
                role: 'button',
                tabIndex: 0,
                title: 'token2rice(' + earnedText + '):点击开面板,拖动移动位置',
              },
              anchorHandlers(true),
              { style: { left: pos.left + 'px', top: pos.top + 'px' } },
            ),
          )

      const panel = panelOpen
        ? h(
            'div',
            {
              className: 't2r-panel' + (artDropping ? ' t2r-dropping' : ''),
              'data-token2rice': 'panel',
              style: panelStyle,
              onDragOver: (event) => {
                event.preventDefault()
                event.stopPropagation()
                if (!artDropping) setArtDropping(true)
              },
              onDragLeave: () => setArtDropping(false),
              onDrop: (event) => {
                event.preventDefault()
                event.stopPropagation()
                setArtDropping(false)
                const transfer = event.dataTransfer
                const files = transfer === null || transfer === undefined ? undefined : transfer.files
                void handleUploadArt(files === undefined || files === null || files.length === 0 ? undefined : files[0])
              },
            },
            h(
              'h4',
              Object.assign({ title: '拖动这里可以移动面板' }, anchorHandlers(false)),
              h('span', null, 'token2rice · 一碗白米饭'),
              h('span', { className: 't2r-grip' }, '⠿'),
            ),
            h(
              'div',
              { className: 't2r-hint' },
              snapshot === null
                ? '读不到宿主账本(插件宿主半边没起来或页面不是同源)。'
                : '自 ' + new Date(snapshot.startedAt || Date.now()).toLocaleString() + ' 起累计 ' + formatTokens(counted) + ' token,已换 ' + (earned === null ? 0 : earned) + ' 碗。',
            ),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '每碗 token'),
              h('input', {
                type: 'number',
                min: 1000,
                step: 10000,
                value: draftPer,
                onChange: (event) => setDraftPer(event.target.value),
                onBlur: () => {
                  const value = Number(draftPer)
                  if (Number.isFinite(value) && value >= 1000) update({ tokensPerBowl: Math.round(value) })
                  else setDraftPer(String(per))
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                },
              }),
            ),
            h(
              'div',
              { className: 't2r-swatches' },
              PRESETS.map((preset) =>
                h(
                  'button',
                  { key: preset, className: per === preset ? 'on' : '', onClick: () => update({ tokensPerBowl: preset }) },
                  formatTokens(preset),
                ),
              ),
            ),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '米饭大小'),
              h('input', {
                type: 'range',
                min: 28,
                max: 140,
                step: 2,
                value: settings.bowlSize,
                onChange: (event) => update({ bowlSize: Number(event.target.value) }),
              }),
              h('span', { className: 't2r-dim' }, settings.bowlSize + 'px'),
            ),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '最多摆几碗'),
              h('input', {
                type: 'range',
                min: BOWL_LIMIT_SLIDER_MIN,
                max: BOWL_LIMIT_SLIDER_MAX,
                step: BOWL_LIMIT_SLIDER_STEP,
                value: bowlLimit,
                onChange: (event) => update({ maxBowls: Number(event.target.value) }),
              }),
              h('span', { className: 't2r-dim' }, bowlLimit + ' 碗'),
            ),
            h('div', { className: 't2r-hint' }, '超出这个数量的碗会被最旧的先顶掉;计数的碗数不受影响。'),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '计入缓存 token'),
              h('div', {
                className: 't2r-switch' + (settings.countCache ? ' on' : ''),
                role: 'switch',
                'aria-checked': settings.countCache ? 'true' : 'false',
                tabIndex: 0,
                onClick: () => update({ countCache: !settings.countCache }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') update({ countCache: !settings.countCache })
                },
              }),
            ),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '显示计数牌'),
              h('div', {
                className: 't2r-switch' + (settings.showBadge ? ' on' : ''),
                role: 'switch',
                'aria-checked': settings.showBadge ? 'true' : 'false',
                tabIndex: 0,
                onClick: () => update({ showBadge: !settings.showBadge }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') update({ showBadge: !settings.showBadge })
                },
              }),
            ),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '落地自动回正'),
              h('div', {
                className: 't2r-switch' + (settings.settleUpright ? ' on' : ''),
                role: 'switch',
                'aria-checked': settings.settleUpright ? 'true' : 'false',
                tabIndex: 0,
                title: '关掉后,碗保持落地那一刻的倾角,不再自己摆正',
                onClick: () => update({ settleUpright: !settings.settleUpright }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') update({ settleUpright: !settings.settleUpright })
                },
              }),
            ),
            settings.settleUpright ? null : h('div', { className: 't2r-hint' }, '碗会保持落地时的倾角(歪着堆),不再自己摆正。'),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '吸入音效'),
              h('div', {
                className: 't2r-switch' + (settings.soundOn ? ' on' : ''),
                role: 'switch',
                'aria-checked': settings.soundOn ? 'true' : 'false',
                tabIndex: 0,
                title: '点暴风钮、或把碗拖到钮上松手时播放音效',
                onClick: () => update({ soundOn: !settings.soundOn }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') update({ soundOn: !settings.soundOn })
                },
              }),
            ),
            h('div', { className: 't2r-hint' }, remaining === null ? '' : '距下一碗还差 ' + formatTokens(remaining) + ' token'),
            h(
              'div',
              { className: 't2r-row' },
              h('span', { className: 't2r-key' }, '米饭图片'),
              h('img', { className: 't2r-thumb', src: imageUrl, alt: '', onError: () => setArtFailed(true) }),
            ),
            h(
              'div',
              { className: 't2r-actions' },
              h('input', {
                ref: fileInputRef,
                type: 'file',
                accept: 'image/png,image/jpeg,image/webp,image/gif',
                onChange: (event) => {
                  const files = event.target.files
                  const file = files === null || files === undefined || files.length === 0 ? undefined : files[0]
                  event.target.value = ''
                  void handleUploadArt(file)
                },
              }),
              h(
                'button',
                {
                  className: 't2r-btn',
                  onClick: () => {
                    const el = fileInputRef.current
                    if (el !== null) el.click()
                  },
                },
                '选择图片…',
              ),
              h('button', { className: 't2r-btn', disabled: !artIsCustom, onClick: () => { void handleResetArt() } }, '恢复默认'),
            ),
            artNotice === null ? null : h('div', { className: 't2r-hint' + (artNotice.kind === 'error' ? ' t2r-warn' : '') }, artNotice.text),
            h(
              'div',
              { className: 't2r-hint' },
              '当前图来自:' + artSource + '。PNG / JPEG / WebP / GIF,上限 4MB;也可以直接把图片拖到面板上。',
            ),
            h(
              'div',
              { className: 't2r-actions' },
              h('button', { className: 't2r-btn', onClick: clearBowls }, '清空画面'),
              h('button', { className: 't2r-btn', onClick: () => { void resetLedger() } }, '重置账本'),
              h('button', { className: 't2r-btn', onClick: () => update({ badgePos: null }) }, '归位'),
            ),
            h('div', { className: 't2r-hint' }, '拖着米饭可以扔,松手自由落体;拖到漩涡钮上松手则只吸这一碗;双击一碗把它扔掉。面板标题栏也能拖。'),
            h('div', { className: 't2r-hint' }, '计数自插件启用起;缓存读取通常是大头,关掉它更接近"新算的 token"。'),
          )
        : null

      return h(React.Fragment, null, layer, vortex, stormRing, badge, panel)
    }

    const STYLE_ID = 'token2rice-style'

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        let style = document.getElementById(STYLE_ID)
        if (style === null) {
          style = document.createElement('style')
          style.id = STYLE_ID
          style.dataset.plugin = 'token2rice'
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return () => {
          const current = document.getElementById(STYLE_ID)
          if (current !== null) current.remove()
        }
      }, 'token2rice: styles')

      ctx.effect(() => {
        const dispose = slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'token2rice', order: 60 }, Token2RiceOverlay),
        )
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, 'token2rice: overlay slot')
    }

    return { inject: ['slots'], apply }
  },
})
