/**
 * token2rice — 宿主半边。
 *
 * 职责只有两件:
 *   1. 折叠全进程的 token 用量。`session/event` 上的 `assistant/message` 带
 *      provider 上报的 usage(输入/输出/缓存读/缓存写),每次调用累加一次,
 *      结果原子写入 `$DSH_HOME/token2rice/state.json`,因此重启不丢。
 *   2. 把累计值和米饭图交给浏览器:GET /token2rice/state、GET
 *      /token2rice/bowl.png、POST /token2rice/reset(仅回环)、
 *      POST|DELETE /token2rice/art(仅回环,用户自带米饭图,存
 *      `$DSH_HOME/token2rice/art.img`,存在即覆盖包里的默认图)。
 *
 * 这里不声明 Config,也不读别人的账本:阈值、米饭大小这些旋钮全在浏览器
 * 侧(localStorage + 面板),宿主只负责"一共花了多少 token"这一个事实。
 * 累计自插件首次启用起计,不回溯安装之前的花费。
 *
 * @module token2rice
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'token2rice'

/** 没有 HTTP 服务就没有这个插件:宿主半边整个挂在路由上。 */
export const inject = ['webServer']

/** 路由前缀。刻意避开 `/api`(那是 api-gateway 的地盘)。 */
const ROUTE_PREFIX = '/token2rice'

/** 落盘防抖:流式输出期间事件很密,每条都写盘是浪费。 */
const FLUSH_DEBOUNCE_MS = 2000

const STATE_VERSION = 1

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** `$DSH_HOME`,回退到 `~/.dsh`(与 dsh-home-paths 相同的约定)。 */
function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 一个空的用量桶。字段名照抄 provider 上报的 `TokenUsage`。 */
function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
  }
}

/** 取有限非负数,其余一律当 0:provider 字段是可选的,坏值不该污染账本。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把一个 provider 用量样本折进累计桶。 */
function foldUsage(totals, usage) {
  if (usage === null || typeof usage !== 'object') return false
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  if (input + output + cacheRead + cacheWrite <= 0) return false
  totals.inputTokens += input
  totals.outputTokens += output
  totals.cacheReadTokens += cacheRead
  totals.cacheWriteTokens += cacheWrite
  totals.reasoningTokens += num(usage.reasoningTokens)
  totals.calls += 1
  return true
}

/** 从不可信 JSON 还原累计桶:形状不对就当空账本,永不抛。 */
function reviveState(raw) {
  const state = { version: STATE_VERSION, totals: emptyTotals(), startedAt: 0, updatedAt: 0, revision: 0 }
  if (raw === null || typeof raw !== 'object') return state
  const totals = raw.totals
  if (totals !== null && typeof totals === 'object') {
    for (const key of Object.keys(state.totals)) state.totals[key] = num(totals[key])
  }
  state.startedAt = num(raw.startedAt)
  state.updatedAt = num(raw.updatedAt)
  state.revision = num(raw.revision)
  return state
}

/**
 * 同一进程里的上一份账本。DSH 重挂载这一行(改配置、HMR)时,新激活的读盘
 * 可能正好撞上旧激活的收尾写、或者干脆读失败;合并磁盘值与内存值,米饭就
 * 不会在一次重挂载后凭空少一截。跨进程仍然只认磁盘。
 */
let carryOver = null

/** 上一次激活的收尾写盘;新激活先等它落地再读,避免读到比自己还旧的账本。 */
let pendingStop = Promise.resolve()

/**
 * 取磁盘账本与内存账本各字段的较大值。
 *
 * @param fileState - 刚从磁盘读到的账本,读失败时为 null。
 * @param memory - 上一次激活留在进程里的账本,没有则为 null。
 * @returns 合并后的账本。
 */
function mergeStates(fileState, memory) {
  const fresh = { version: STATE_VERSION, totals: emptyTotals(), startedAt: 0, updatedAt: 0, revision: 0 }
  const a = fileState === null || fileState === undefined ? fresh : fileState
  const b = memory === null || memory === undefined ? fresh : memory
  const totals = emptyTotals()
  for (const key of Object.keys(totals)) totals[key] = Math.max(num(a.totals[key]), num(b.totals[key]))
  const starts = [num(a.startedAt), num(b.startedAt)].filter((value) => value > 0)
  return {
    version: STATE_VERSION,
    totals,
    startedAt: starts.length > 0 ? Math.min(...starts) : 0,
    updatedAt: Math.max(num(a.updatedAt), num(b.updatedAt)),
    revision: Math.max(num(a.revision), num(b.revision)),
  }
}

/** 唯一临时名 + fsync + rename:落盘要么是旧账本,要么是新账本。 */
async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 1), 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** 二进制版的原子写:自带图要么是旧的那张,要么是新的那张。 */
async function writeBytesAtomic(path, bytes) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, bytes)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function writeJson(res, status, body, headers) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

/** 请求是否来自本机:重置这种写操作只认回环。 */
function isLoopback(req) {
  const address = req.socket === undefined || req.socket === null ? '' : req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 用户自带米饭图的上限:足够放一张照片,又不至于让路由变成上传盘。 */
const ART_MAX_BYTES = 4 * 1024 * 1024

/**
 * 按魔数认图片类型。只认位图:SVG 是脚本载体,不收。
 *
 * @param bytes - 文件头若干字节。
 * @returns 可用的 content-type,认不出则为 null。
 */
function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** 收请求体,超过上限就抛 ETOOLARGE(路由据此回 413)。 */
async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) {
      const error = new Error('body too large')
      error.code = 'ETOOLARGE'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 宿主半边。
 *
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx) {
  const stateDir = join(dshHomeDir(), 'token2rice')
  const statePath = join(stateDir, 'state.json')
  /** 用户自带的米饭图;存在即覆盖包里的默认图。 */
  const artPath = join(stateDir, 'art.img')

  let state = { version: STATE_VERSION, totals: emptyTotals(), startedAt: 0, updatedAt: 0, revision: 0 }
  let loaded = false
  let flushTimer = undefined
  let flushing = undefined
  let imageCache = undefined

  /** 当前生效的米饭图:`custom` 为假时用包里的 assets/bowl.png。 */
  let art = { custom: false, contentType: 'image/png', version: 0, bytes: null }

  /** 内置图的版本(文件 mtime):换图后浏览器 URL 跟着变,不会吃 24 小时缓存。 */
  let builtinVersion = 0

  const builtinStamp = async () => {
    if (builtinVersion !== 0) return builtinVersion
    try {
      const info = await stat(join(PLUGIN_DIR, 'assets', 'bowl.png'))
      builtinVersion = Math.round(Number(info.mtimeMs) || 0)
    } catch (error) {
      // 读不到就让前端用自己的兜底版本号。
    }
    return builtinVersion
  }

  /** 读一次用户自带的图;没有或认不出就当没有,不影响默认图。 */
  const loadArt = async () => {
    try {
      const info = await stat(artPath)
      const bytes = await readFile(artPath)
      const contentType = sniffImageType(bytes)
      if (contentType === null || bytes.length === 0 || bytes.length > ART_MAX_BYTES) return
      art = { custom: true, contentType, version: Math.round(Number(info.mtimeMs) || Date.now()), bytes }
    } catch (error) {
      // ENOENT 就是没自定义过,其它错误也保持默认图。
    }
  }

  /** 读磁盘账本;失败重试一次,再不行就用内存里的上一份兜底(不阻塞挂载)。 */
  const load = async () => {
    let fromFile = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await readFile(statePath, 'utf8')
        fromFile = reviveState(JSON.parse(raw))
        break
      } catch (error) {
        // ENOENT 是首次启用,不必重试。
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') break
        if (attempt === 0) await new Promise((resolve) => { setTimeout(resolve, 80) })
      }
    }
    state = mergeStates(fromFile, carryOver)
    if (!state.startedAt) state.startedAt = Date.now()
    carryOver = state
    loaded = true
  }

  const flush = async () => {
    flushTimer = undefined
    if (flushing !== undefined) return flushing
    const payload = JSON.parse(JSON.stringify(state))
    flushing = (async () => {
      try {
        await mkdir(stateDir, { recursive: true })
        await writeJsonAtomic(statePath, payload)
      } catch (error) {
        ctx.logger?.warn?.(`[token2rice] 账本写入失败: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        flushing = undefined
      }
    })()
    return flushing
  }

  const scheduleFlush = () => {
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => { void flush() }, FLUSH_DEBOUNCE_MS)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  // 先等上一任激活的收尾写盘落地,再读盘:否则新激活可能读到比它更旧的一份。
  const ready = (async () => {
    await pendingStop.catch(() => {})
    await Promise.all([load(), loadArt()])
  })()

  const onSessionEvent = async (_session, event) => {
    if (event === null || typeof event !== 'object') return
    if (event.type !== 'assistant/message') return
    const usage = event.data === undefined || event.data === null ? undefined : event.data.usage
    if (usage === undefined) return
    await ready
    if (!foldUsage(state.totals, usage)) return
    state.updatedAt = Date.now()
    state.revision += 1
    scheduleFlush()
  }

  ctx.on('session/event', (session, event) => { void onSessionEvent(session, event) })

  /** 米饭图:读一次就缓存;读不到就让浏览器自己去画兜底 SVG。 */
  const bowlImage = async () => {
    if (imageCache !== undefined) return imageCache
    try {
      imageCache = await readFile(join(PLUGIN_DIR, 'assets', 'bowl.png'))
    } catch (error) {
      imageCache = null
    }
    return imageCache
  }

  const routes = [
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/state',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          await ready
          if (flushTimer !== undefined) void flush()
          writeJson(res, 200, {
            ok: true,
            version: STATE_VERSION,
            totals: state.totals,
            startedAt: state.startedAt,
            updatedAt: state.updatedAt,
            revision: state.revision,
            art: {
              custom: art.custom,
              version: art.version,
              contentType: art.contentType,
              builtinVersion: art.custom ? builtinVersion : await builtinStamp(),
            },
            serverTime: Date.now(),
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: 'state-failed' })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/bowl.png',
      handler: async (req, res) => {
        try {
          await ready
          const bytes = art.custom && art.bytes !== null ? art.bytes : await bowlImage()
          if (bytes === null) {
            writeJson(res, 404, { ok: false, error: 'no-artwork' })
            return
          }
          res.writeHead(200, {
            'content-type': art.custom && art.bytes !== null ? art.contentType : 'image/png',
            'content-length': bytes.length,
            // 自带图换一次 version 就换一次 URL,所以可以长时间缓存。
            'cache-control': 'public, max-age=86400',
          })
          res.end(req.method === 'HEAD' ? undefined : bytes)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: 'artwork-failed' })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/art',
      handler: async (req, res) => {
        try {
          if (!isLoopback(req)) {
            writeJson(res, 403, { ok: false, error: 'loopback-only' })
            return
          }
          await ready
          if (req.method === 'DELETE') {
            // 恢复默认:删掉自带图,前端随即回落到包里的 assets/bowl.png。
            try {
              await unlink(artPath)
            } catch (error) {
              // 本来就没有。
            }
            art = { custom: false, contentType: 'image/png', version: 0, bytes: null }
            writeJson(res, 200, { ok: true, art: { custom: false, version: 0, contentType: 'image/png' } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          let body
          try {
            body = await readBody(req, ART_MAX_BYTES)
          } catch (error) {
            if (error !== null && typeof error === 'object' && error.code === 'ETOOLARGE') {
              writeJson(res, 413, { ok: false, error: 'too-large', limit: ART_MAX_BYTES })
              return
            }
            throw error
          }
          const contentType = sniffImageType(body)
          if (contentType === null) {
            writeJson(res, 415, { ok: false, error: 'unsupported-image' })
            return
          }
          await mkdir(stateDir, { recursive: true })
          await writeBytesAtomic(artPath, body)
          art = { custom: true, contentType, version: Date.now(), bytes: body }
          writeJson(res, 200, { ok: true, art: { custom: true, version: art.version, contentType } })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: 'art-failed' })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/reset',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          if (!isLoopback(req)) {
            writeJson(res, 403, { ok: false, error: 'loopback-only' })
            return
          }
          await ready
          state = { version: STATE_VERSION, totals: emptyTotals(), startedAt: Date.now(), updatedAt: Date.now(), revision: 0 }
          // 清零也要覆盖进程里的那份,否则下次重挂载会把旧账合并回来。
          carryOver = state
          await flush()
          writeJson(res, 200, { ok: true, totals: state.totals, startedAt: state.startedAt })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: 'reset-failed' })
        }
      },
    },
  ]

  ctx.effect(() => {
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(ctx.webServer.register(route))
      } catch (error) {
        ctx.logger?.warn?.(`[token2rice] 路由注册失败 ${route.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return () => {
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flushTimer = undefined
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          // 关闭过程中路由 fiber 已经没了。
        }
      }
      // 收尾写盘排进进程级队列:下一任激活的读盘会先等它。
      const stopping = flush()
      pendingStop = pendingStop.then(() => stopping, () => stopping)
    }
  }, 'token2rice: routes')

  void ready.then(() => {
    ctx.logger?.info?.(`[token2rice] 已挂载,账本: ${statePath}`)
  })
}
