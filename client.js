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

    /** 用户可调旋钮的默认值:1M token 一碗、56px 大米饭。 */
    const DEFAULTS = { tokensPerBowl: 1000000, bowlSize: 56, countCache: true, showBadge: true, badgePos: null }
    const SETTINGS_KEY = 'token2rice.settings.v1'

    /** 画面里最多同时摆多少碗;再多就把最老的请出去,避免长会话把 DOM 撑爆。 */
    const MAX_BOWLS = 24
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
    const MAX_THROW = 2600         // 甩出去的速度上限
    const SPIN_PER_VX = 0.42       // 水平初速度换算成自转
    const MAX_SPIN = 720
    const BOUNCE_FLOOR = 220       // 落地速度低于它就直接停住
    const DEFAULT_ASPECT = 181 / 320

    // ---- 计数牌 / 面板几何 ----
    const BADGE_W = 152            // 计数牌定宽:拖动夹取和面板对齐都按它算,几何才是准的
    const BADGE_H = 28
    const BADGE_MARGIN = 14
    const PANEL_WIDTH = 236
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
      '.t2r-panel{position:fixed;pointer-events:auto;box-sizing:border-box;width:' + PANEL_WIDTH + 'px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,rgba(24,24,26,.97));color:var(--dsw-alias-label-primary,#e8e8e8);font:400 12px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;z-index:44;box-shadow:0 10px 32px rgba(0,0,0,.34);display:flex;flex-direction:column;gap:9px}',
      '.t2r-panel h4{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;cursor:move;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:space-between;gap:6px}',
      '.t2r-panel h4 .t2r-grip{color:var(--dsw-alias-label-secondary,rgba(200,200,200,.6));font-weight:400}',
      '.t2r-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.t2r-row .t2r-key{color:var(--dsw-alias-label-secondary,rgba(200,200,200,.75));flex:none}',
      '.t2r-panel input[type=number]{width:92px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:7px;padding:3px 7px;font:inherit;outline:none}',
      '.t2r-panel input[type=number]:focus{border-color:var(--dsw-alias-brand-primary,#4d8dff)}',
      '.t2r-panel input[type=range]{width:118px;accent-color:var(--dsw-alias-brand-primary,#4d8dff)}',
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
      '.t2r-actions button{flex:1}',
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
        const squashX = 1 + bowl.squash * 0.55
        const squashY = 1 - bowl.squash
        el.style.width = bowl.w + 'px'
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

          for (const bowl of sim.list) {
            if (bowl.wait > 0) {
              // 补发时的出场间隔:先在屏幕上方等着,时间到了再落。
              bowl.wait -= dt
              active = true
              continue
            }
            if (bowl.dragging) continue

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
          grabDX: 0,
          grabDY: 0,
          samples: [],
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

      React.useEffect(() => {
        setDraftPer(String(per))
      }, [per])

      // ---- 账本 / 旋钮变化 -> 增减碗 ----
      React.useEffect(() => {
        if (earned === null) return
        const previous = earnedRef.current
        earnedRef.current = earned
        if (previous !== null && earned === previous) return
        const sim = simRef.current

        if (previous === null) {
          // 首屏:把已经挣到的碗直接摆在地上(不动画),刷新不该下 Rice 暴雨。
          const target = Math.min(earned, MAX_BOWLS)
          for (let i = sim.list.length; i < target; i += 1) newBowl(true)
          syncList()
          return
        }

        if (earned > previous) {
          const grew = Math.min(earned - previous, MAX_BOWLS * 2)
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
          trimTo(MAX_BOWLS)
          syncList()
          kick()
          return
        }

        // 阈值调大或账本被重置:按新的目标裁掉最旧的几碗。
        trimTo(Math.min(earned, MAX_BOWLS))
        syncList()
      }, [earned, newBowl, trimTo, syncList, kick])

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
        bowl.dragging = true
        bowl.resting = false
        bowl.vx = 0
        bowl.vy = 0
        bowl.spin = 0
        bowl.squash = 0
        bowl.splashed = false
        bowl.grabDX = event.clientX - bowl.x
        bowl.grabDY = event.clientY - bowl.y
        bowl.samples = [{ t: performance.now(), x: event.clientX, y: event.clientY }]
        event.preventDefault()
        event.stopPropagation()
      }

      const moveBowlDrag = (event, serial) => {
        const bowl = simRef.current.bySerial.get(serial)
        if (bowl === undefined || !bowl.dragging) return
        const view = vpRef.current
        bowl.x = clamp(event.clientX - bowl.grabDX, -bowl.w * 0.4, Math.max(-bowl.w * 0.4, view.w - bowl.w * 0.6))
        bowl.y = clamp(event.clientY - bowl.grabDY, -bowl.h * 1.6, view.h - bowl.h)
        bowl.samples.push({ t: performance.now(), x: event.clientX, y: event.clientY })
        if (bowl.samples.length > 6) bowl.samples.shift()
        paint(bowl)
        event.preventDefault()
      }

      const endBowlDrag = (event, serial) => {
        const bowl = simRef.current.bySerial.get(serial)
        if (bowl === undefined || !bowl.dragging) return
        bowl.dragging = false
        let vx = 0
        let vy = 0
        const samples = bowl.samples
        if (samples.length >= 2) {
          const first = samples[0]
          const lastSample = samples[samples.length - 1]
          const dt = Math.max(0.016, (lastSample.t - first.t) / 1000)
          vx = (lastSample.x - first.x) / dt
          vy = (lastSample.y - first.y) / dt
        }
        const speed = Math.sqrt(vx * vx + vy * vy)
        const cap = speed > MAX_THROW ? MAX_THROW / speed : 1
        bowl.vx = vx * cap
        bowl.vy = vy * cap
        bowl.spin = clamp(-bowl.vx * SPIN_PER_VX, -MAX_SPIN, MAX_SPIN)
        bowl.samples = []
        bowl.wait = 0
        // 松手就是自由落体:哪怕手只是轻轻一放,重力也会接手。
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
      const panelStyle = Object.assign(
        { left: clamp(pos.left, EDGE, Math.max(EDGE, vp.w - PANEL_WIDTH - EDGE)) },
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

      return h(React.Fragment, null, layer, badge, panel)
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
