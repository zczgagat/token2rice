/**
 * 拖拽物理的数值验证(不需要浏览器)。
 *
 * 从 client.js 里把**真实发出去的** stepDragBowl 与其常量原文抽出来,在 Node 里
 * 按 60fps 积分,检查三件事:
 *   ① 抓着一角不动 → 摆到"重心垂在抓取点正下方"的平衡角,且抓取点跟手;
 *   ② 快速绕圈甩 → 数值稳定(无 NaN/Infinity),姿态是摆动而不是无限自转;
 *   ③ 抓不同位置 → 静止姿态不同(证明是绕抓取点转,不是绕碗心)。
 *
 * 跑法:node tools/drag-physics.test.mjs
 *
 * 这个脚本在 2026-10-04 抓出过一个真 bug:角速度曾经以指针为支点算重力力矩,
 * 却没算弹簧在抓取点上的力矩,于是指针不动时碗也会越转越快(5 秒转到 -3194°)。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const src = readFileSync(CLIENT, 'utf8')

/** 从源码里切出一个函数的原文(按花括号配平)。 */
function sliceFunction(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`找不到函数 ${name}`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`函数 ${name} 括号不平衡`)
}

/** 从源码里切出一个常量的定义行。 */
function sliceConst(name) {
  const match = new RegExp(`const ${name} = [^\\n]+`, 'm').exec(src)
  if (match === null) throw new Error(`找不到常量 ${name}`)
  return match[0]
}

const CONST_NAMES = [
  'GRAVITY',
  'DRAG_SPRING',
  'DRAG_DAMP',
  'DRAG_TORQUE',
  'DRAG_ANG_DRAG',
  'DRAG_MAX_ANG_ACC',
  'DRAG_WALL_FRICTION',
  'COM_ARM',
  'MAX_THROW',
  'INHALE_RADIUS_POWER',
  'INHALE_ANGLE_POWER',
  'INHALE_SHRINK',
]

const constants = CONST_NAMES.map(sliceConst).join('\n')
const helpers = 'const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value)'
// 物理函数之间互相调用,所以抽出来的原文要在同一个作用域里一起求值。
const preamble = [constants, helpers, sliceFunction('rotatedExtents')].join('\n')
const stepDragBowl = new Function([preamble, sliceFunction('stepDragBowl'), 'return stepDragBowl'].join('\n'))()
const stepInhaleBowl = new Function([preamble, sliceFunction('stepInhaleBowl'), 'return stepInhaleBowl'].join('\n'))()
const rotatedExtents = new Function([sliceFunction('rotatedExtents'), 'return rotatedExtents'].join('\n'))()
const restingY = new Function(
  [sliceFunction('rotatedExtents'), sliceFunction('restingY'), 'return restingY'].join('\n'),
)()

const W = 56
const H = 56 * (181 / 320)
const VIEW = { w: 1440, h: 900 }
const DT = 1 / 60

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ' — ' + detail}`)
}

function makeBowl(grabLocalX, grabLocalY, x, y) {
  return { x, y, vx: 0, vy: 0, rot: 0, spin: 0, w: W, h: H, grabLocalX, grabLocalY, pointerX: 0, pointerY: 0 }
}

/** 抓取点的世界坐标(与 physics 同一套变换)。 */
function grabWorld(bowl) {
  const rad = (bowl.rot * Math.PI) / 180
  const cs = Math.cos(rad)
  const sn = Math.sin(rad)
  const lx = bowl.grabLocalX - bowl.w / 2
  const ly = bowl.grabLocalY - bowl.h
  return { x: bowl.x + bowl.w / 2 + lx * cs - ly * sn, y: bowl.y + bowl.h + lx * sn + ly * cs }
}

/** 悬停:把指针放在当前抓取点,积分 seconds 秒。 */
function hover(grabLocalX, grabLocalY, seconds) {
  const bowl = makeBowl(grabLocalX, grabLocalY, 400, 300)
  const grab = grabWorld(bowl)
  bowl.pointerX = grab.x
  bowl.pointerY = grab.y
  for (let i = 0; i < seconds * 60; i += 1) stepDragBowl(bowl, VIEW, DT)
  return bowl
}

console.log('① 抓碗沿静置:应当摆到"重心垂在抓取点正下方"并停住')
{
  const bowl = hover(4, 4, 6)
  check('静止姿态在 55°–65°(手算平衡角 59.2°)', bowl.rot > 55 && bowl.rot < 65, `rot=${bowl.rot.toFixed(1)}°`)
  const grab = grabWorld(bowl)
  const drift = Math.hypot(grab.x - bowl.pointerX, grab.y - bowl.pointerY)
  check('抓取点跟手(静垂 ≈ GRAVITY/DRAG_SPRING = 5px)', drift < 10, `${drift.toFixed(1)}px`)
  check('角速度已收敛', Math.abs(bowl.spin) < 120, `${bowl.spin.toFixed(0)}°/s`)
}

console.log('② 快速绕圈甩 10 秒:数值稳定,姿态是摆动不是无限自转')
{
  const bowl = makeBowl(4, 4, 400, 400)
  const grab = grabWorld(bowl)
  bowl.pointerX = grab.x
  bowl.pointerY = grab.y
  let maxSpin = 0
  let maxTilt = 0
  let finite = true
  for (let i = 0; i < 600; i += 1) {
    bowl.pointerX = 400 + Math.sin(i / 6) * 320
    bowl.pointerY = 300 + Math.cos(i / 9) * 160
    stepDragBowl(bowl, VIEW, DT)
    if (!Number.isFinite(bowl.x + bowl.y + bowl.rot + bowl.spin)) finite = false
    maxSpin = Math.max(maxSpin, Math.abs(bowl.spin))
    maxTilt = Math.max(maxTilt, Math.abs(bowl.rot))
  }
  check('没有 NaN / Infinity', finite)
  check('角速度有界(< 1500°/s)', maxSpin < 1500, `峰值 ${maxSpin.toFixed(0)}°/s`)
  check('姿态在摆(< 400°)', maxTilt < 400, `峰值摆幅 ${maxTilt.toFixed(0)}°`)
}

console.log('③ 抓不同位置:静止姿态不同(绕抓取点转,而不是绕碗心)')
{
  const corner = hover(4, 4, 7).rot
  const other = hover(W - 4, H - 4, 7).rot
  check('左上角与右下角姿态明显不同', Math.abs(corner - other) > 60, `${corner.toFixed(0)}° vs ${other.toFixed(0)}°`)
}

console.log('④ 暴风吸入:沿螺旋收向风眼,到点缩小并终止')
{
  const TARGET = { x: 1200, y: 200 }
  const bowl = makeBowl(4, 4, 200, 700)
  bowl.scale = 1
  bowl.inhale = { t: 0, dur: 0.7, cx: TARGET.x, cy: TARGET.y, radius: 700, angle: 0, turns: 2.1, spin: 1200 }

  const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  const distTo = (b) => Math.hypot(centerOf(b).x - TARGET.x, centerOf(b).y - TARGET.y)

  let frames = 0
  let done = false
  let monotone = true
  let swept = 0
  let previous = distTo(bowl)
  let previousAngle = Math.atan2(centerOf(bowl).y - TARGET.y, centerOf(bowl).x - TARGET.x)
  while (!done && frames < 600) {
    done = stepInhaleBowl(bowl, DT)
    const distance = distTo(bowl)
    const angle = Math.atan2(centerOf(bowl).y - TARGET.y, centerOf(bowl).x - TARGET.x)
    let delta = angle - previousAngle
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    swept += Math.abs(delta)
    if (distance > previous + 0.5) monotone = false
    previous = distance
    previousAngle = angle
    frames += 1
  }

  check('在时长内终止', done && frames <= Math.ceil(0.7 * 60) + 2, `${frames} 帧`)
  check('半径一路收小(没有外扩)', monotone)
  check('终点落在风眼(≤2px)', previous <= 2, `${previous.toFixed(2)}px`)
  check('缩到 10% 以下', bowl.scale <= 0.1, `scale=${bowl.scale.toFixed(3)}`)
  check('绕过风眼至少 1.5 圈', swept >= Math.PI * 3, `${(swept / (Math.PI * 2)).toFixed(2)} 圈`)
  check('自身也在打转', Math.abs(bowl.rot) > 360, `${bowl.rot.toFixed(0)}°`)
}

console.log('⑤ 斜着落地不许穿模:任意倾角下,碗的最低点都不越过底边')
{
  const angles = [0, 12, 30, 45, 60, 90, 135, 180, -25, -70, -120]

  // (a) 静置摆位:restingY 给出的位置,最低点必须正好落在底边上
  let worstGap = 0
  let worstDip = 0
  for (const deg of angles) {
    const bowl = makeBowl(4, 4, 400, 300)
    bowl.rot = deg
    bowl.y = restingY(bowl, VIEW.h)
    const lowest = bowl.y + bowl.h + rotatedExtents(bowl.w, bowl.h, bowl.rot, 1, 1).lowest
    const error = lowest - VIEW.h
    if (error > worstDip) worstDip = error
    if (-error > worstGap) worstGap = -error
  }
  check('最低点正好贴底(不越过)', worstDip < 0.01, `最深越界 ${worstDip.toFixed(3)}px`)
  check('也不悬空(浮起 ≤0.01px)', worstGap < 0.01, `最大悬空 ${worstGap.toFixed(3)}px`)

  // (b) 真实拖拽代码:把各种倾角的碗往底边推,看它有没有穿出去
  let worstDragDip = 0
  for (const deg of angles) {
    const bowl = makeBowl(4, 4, 400, 100)
    bowl.rot = deg
    bowl.pointerX = 400
    bowl.pointerY = VIEW.h + 400 // 指针压到屏幕下方,用力把碗往地里按
    for (let i = 0; i < 240; i += 1) stepDragBowl(bowl, VIEW, DT)
    const lowest = bowl.y + bowl.h + rotatedExtents(bowl.w, bowl.h, bowl.rot, 1, 1).lowest
    if (lowest - VIEW.h > worstDragDip) worstDragDip = lowest - VIEW.h
  }
  check('拖拽路径也不穿出底边', worstDragDip < 0.5, `最深越界 ${worstDragDip.toFixed(2)}px`)

  // (c) 接线检查:物理循环里落地判定必须用旋转后的外扩量,不能退回 h
  check('物理循环用的是 rotatedExtents 而不是裸 h', src.includes('const floor = view.h - bowl.h - extents.lowest'))
  check('回正处于贴地状态(restingY)', src.includes('bowl.y = restingY(bowl, view.h)'))
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
