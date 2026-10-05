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

    /** 用户可调旋钮的默认值:1M token 一碗、56px 大米饭、画面上最多摆 24 碗。 */
    const DEFAULTS = { tokensPerBowl: 1000000, bowlSize: 56, maxBowls: 24, countCache: true, showBadge: true, badgePos: null }
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

      // 边墙与地面:挡住 + 吃掉大部分速度(拖拽时不该弹跳)
      const minX = -bowl.w * 0.4
      const maxX = view.w - bowl.w * 0.6
      if (bowl.x < minX) {
        bowl.x = minX
        bowl.vx = Math.abs(bowl.vx) * DRAG_WALL_FRICTION
      } else if (bowl.x > maxX) {
        bowl.x = maxX
        bowl.vx = -Math.abs(bowl.vx) * DRAG_WALL_FRICTION
      }
      const floor = view.h - bowl.h
      if (bowl.y > floor) {
        bowl.y = floor
        if (bowl.vy > 0) bowl.vy = -bowl.vy * DRAG_WALL_FRICTION
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

            // 落地:够快就弹一下并溅米,不够快就停住。
            const floor = view.h - bowl.h
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
              // 地面上滑行,然后慢慢摆正到自己的静止倾角。
              if (Math.abs(bowl.vx) > 4) {
                bowl.x += bowl.vx * dt
                bowl.vx *= Math.pow(GROUND_FRICTION, dt)
                active = true
              } else {
                bowl.vx = 0
                if (Math.abs(bowl.rot - bowl.restTilt) > 0.08) {
                  bowl.rot += (bowl.restTilt - bowl.rot) * Math.min(1, 6 * dt)
                  active = true
                } else {
                  bowl.rot = bowl.restTilt
                }
              }
            } else {
              active = true
            }

            // 左右墙:允许探出小半个身子,撞上去回弹。
            const minX = -bowl.w * 0.4
            const maxX = view.w - bowl.w * 0.6
            if (bowl.x < minX) {
              bowl.x = minX
              bowl.vx = Math.abs(bowl.vx) * WALL_BOUNCE
            } else if (bowl.x > maxX) {
              bowl.x = maxX
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
          y: rest ? view.h - height : -height - 24,
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
            if (bowl.resting) bowl.y = next.h - bowl.h
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
              const bowl = newBowl(false)
              bowl.y = -bowl.h - 24 - dropped * 20
              bowl.wait = dropped * 0.13
              dropped += 1
            } else {
              newBowl(true)
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
          if (bowl.resting) bowl.y = vpRef.current.h - bowl.h
          paint(bowl)
        }
        kick()
      }, [settings.bowlSize, paint, kick])

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
              if (bowl.resting) bowl.y = vpRef.current.h - bowl.h
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
        event.preventDefault()
      }

      const endBowlDrag = (event, serial) => {
        const bowl = simRef.current.bySerial.get(serial)
        if (bowl === undefined || !bowl.dragging) return
        bowl.dragging = false
        bowl.wait = 0
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

      /**
       * 暴风吸入:把所有碗卷进漩涡。
       *
       * 每碗记一份螺旋参数(起点半径、起始角、圈数、自转方向),之后由
       * stepInhaleBowl 逐帧推进;正在被拖的碗先松手再吸。已挣到的计数不受影响
       * (想立刻清屏且不做动画,面板里还有「清空画面」)。
       */
      const startInhale = () => {
        if (storm !== null) return
        const sim = simRef.current
        const target = vortexCenter
        let count = 0
        for (const bowl of sim.list) {
          if (bowl.inhale !== null && bowl.inhale !== undefined) continue
          if (bowl.dragging) bowl.dragging = false // 手还按着也先松手,再卷走
          const dx = bowl.x + bowl.w / 2 - target.x
          const dy = bowl.y + bowl.h / 2 - target.y
          const distance = Math.sqrt(dx * dx + dy * dy)
          const noise = noiseAt(bowl.serial + 31)
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
          count += 1
        }
        if (count === 0) return
        setStorm({ key: Date.now(), x: target.x, y: target.y })
        window.setTimeout(() => setStorm(null), 950)
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
          type: 'button',
          title: '暴风吸入:把所有米饭卷进漩涡',
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
            h('div', { className: 't2r-hint' }, '拖着米饭可以扔,松手自由落体;双击一碗把它扔掉。面板标题栏也能拖。'),
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
