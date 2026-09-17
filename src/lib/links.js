/* ═══════════ 连接读法 ═══════════
 *
 * 「你画出来的那条线算什么关系、连着谁、条件是什么、能不能串成推导链」。
 * 这一族原来长在 `board.js` 里（和数据模型 + 几何 + 关系推断挤在一个 2000 行的文件），
 * 2026-09-16 挪出来：board.js **不再转发**这里的任何东西 —— 想摸内部就得知道这个文件存在。
 *
 * 对外的 interface 只有一个：
 *
 *     const reader = createLinkReader()
 *     reader.read(board)        // → links[]
 *
 * 其余导出分两类：
 *   · `deriveChains` / `chainOfStroke` —— 面板和 UI 确实要用的派生；
 *   · 标着 **internal seam** 的（`createInkIndex` / `inkNodeAt` / `inkBlocks` /
 *     `findTip` 那一族纯函数 / 各阈值常量）—— 只给这个 module 自己的测试用。调用方别走。
 */

import { cardBounds, pointInRect, toFlat, toPoints } from './geometry.js'
import {
  ARROW_LINK, DEFAULT_LINK, LINK_KINDS, LINK_NONE, isLinkKind, isNoLink, linkKind,
} from './link-kinds.js'

/* ═══════════ 形状判据：这一笔是不是箭头 ═══════════
 *
 * 阈值不是拍的。用户 2026-09-16 发来两张真手画箭头的截图，
 * scripts/extract-hand-arrows.py 把墨迹细化成骨架、量出来的事实：
 *   · 两只臂张开 **107.4° / 106.2°** —— 两只箭头杆长差了 4 倍，张开角几乎一样
 *   · 臂长 **51~59 世界像素**（换算按纸的横线 32px 反推的缩放）
 *   · **杆的墨迹一直画到尖上**：V 的顶点和杆的末端是叠在一起的
 *   · 他的箭头常常是**分开的两笔**（一杆、一个 V），不是一笔画成的回勾
 *
 * 最后一条是最要紧的：原来只认"末尾回勾"（一笔画成才会有的形状），
 * 于是他的箭头在应用里读出来永远是"相关"。现在两条判据都要认：
 *   ① 末尾回勾（一笔画成）
 *   ② 有个尖：两只臂张开 ≤ TIP_MAX_ANGLE，且尖离某一头不远（见 findTip / buildLinks）
 *
 * 余量都给得很足（120° vs 实测 107°，臂下限 18px vs 实测 51px）：
 * 漏判只是少一个箭头标记，误判是多一个"因果" —— 两个都能一键改，
 * 但手画的形状因人因笔因纸而异，把阈值卡在实测值上没有便宜可占。 */
export const TIP_MAX_ANGLE = 120
export const TIP_ARM_MIN = 18
export const ARMS_SPAN = 22      // 量张开角时沿臂走多远（笔宽会把顶点糊掉，太短会虚高）
export const JOIN_TOL = 12       // 端点相接的容差：这么近的两笔算同一根线
export const TIP_PAD = 34        // "尖指着这张卡"的宽容：尖离卡边多近算指着它
export const STRAIGHT_DEG = 150  // 接笔时的"顺着往下"：夹角 ≥ 150° 才算续着画的
export const HEAD_ARM_MAX = 150  // 箭头那两只臂的单笔长度上限（世界像素）

function unit(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const n = Math.hypot(dx, dy)
  return n < 1e-6 ? null : { x: dx / n, y: dy / n }
}

function angleDeg(u, v) {
  const c = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y))
  return (Math.acos(c) * 180) / Math.PI
}

/* 从下标 i 出发、朝 dir（+1 往后 / -1 往前）走 span 像素，落到哪个点。
   走到头了就返回最后一个点 —— 调用方用"实际走了多远"判断臂够不够长。 */
function walkSpan(pts, i, span, dir) {
  let acc = 0
  let j = i
  for (;;) {
    const k = j + dir
    if (k < 0 || k >= pts.length) return pts[j]
    acc += Math.hypot(pts[k].x - pts[j].x, pts[k].y - pts[j].y)
    j = k
    if (acc >= span) return pts[j]
  }
}

function arcLen(pts) {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return s
}

/* 点列里有没有"尖"（两只臂张开得够小），返回张开角最小的那一个。
 *   { at, i, open, back, fwd, total }
 *   open = 张开角（度，直线 = 180）；back/fwd = 尖两侧各自的**弧长**；total = 全长。
 * 为什么要 back/fwd 而不是"尖在下标第几"：下标密度随采样而变，
 *   而"尖离某一头占全长多少"这件事只有弧长算得准（实测：短粗箭头按下标算是 0.67、
 *   按弧长算是 0.28 —— 阈值卡在 0.72 时会漏掉一整张图）。
 * 传世界坐标的点（数组或扁平数组都行）。 */
export function findTip(points) {
  const pts = toPoints(points)
  if (pts.length < 3) return null
  /* 前缀弧长：有了它，每个候选点的两侧长度是 O(1)（不然每比一次都要走一遍点列）。 */
  const S = new Array(pts.length)
  S[0] = 0
  for (let i = 1; i < pts.length; i++) S[i] = S[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const total = S[pts.length - 1]
  let best = null
  for (let i = 1; i < pts.length - 1; i++) {
    const back = walkSpan(pts, i, ARMS_SPAN, -1)
    const fwd = walkSpan(pts, i, ARMS_SPAN, 1)
    if (Math.hypot(back.x - pts[i].x, back.y - pts[i].y) < TIP_ARM_MIN) continue
    if (Math.hypot(fwd.x - pts[i].x, fwd.y - pts[i].y) < TIP_ARM_MIN) continue
    const a = unit(pts[i], back)
    const b = unit(pts[i], fwd)
    if (!a || !b) continue
    const open = angleDeg(a, b)
    if (!best || open < best.open) best = { at: pts[i], i, open, back: S[i], fwd: total - S[i], total }
  }
  return best && best.open <= TIP_MAX_ANGLE ? best : null
}

/* 尖是不是"像个箭头尖"：两侧里短的那一段既**不长**、又**占不到全长的一小半**。
 * 两条都要，少一条都会把"折线式连接"（L 形）读成箭头：
 *   · 只比比例 —— 200 + 400 那种不对称的 L，短边正好是全长的 0.33，比他的箭头（0.28）还小；
 *   · 只比长度 —— 一条 600px 的直线中间拐个 90°、两边各 300，照样超过上限。
 * 实测他的箭头：短边 51~59 世界像素、占全长 0.11 / 0.28 —— 两条都过得很宽。 */
export function tipNearEnd(tip) {
  if (!tip || !(tip.total > 0)) return false
  const short = Math.min(tip.back, tip.fwd)
  return short <= HEAD_ARM_MAX && short <= 0.35 * tip.total
}

/* 这一头"往外"的方向（点列上往里退 span 像素的那个点 → 这一头的端点）。
   用它而不是"端点 → 尖"那个向量，是因为**实测他总是把杆一路画到尖上**：
   那个向量长度是 0，方向无从谈起（第一版就是这么把 Two-stroke 整条路丢掉的）。 */
export function endOutward(pts, atFirst, span = 20) {
  if (pts.length < 2) return null
  const end = atFirst ? pts[0] : pts[pts.length - 1]
  const inner = atFirst ? walkSpan(pts, 0, span, 1) : walkSpan(pts, pts.length - 1, span, -1)
  return unit(inner, end)
}

/* 这**整条点列**是不是"单独一个箭头尖"（V）。
   用户画的箭头就是这样：杆一笔，V 尖又一笔 —— V 自己看，尖在正中、两半差不多长。
   返回 { at, dir, arm }（dir = 手指的方向）或 null。
   ★ dir 的算法：两只臂的反方向的角平分线。设尖指向 +x、张开 107°，两只臂对称指向
     126.5° 和 233.5°，两个单位向量加起来是 (-1.19, 0)，取反就是 (1, 0) ✓。
     ⚠ 这里**不能**用"起点指向终点"：对 V 来说那正好是横穿过去的方向，和手指方向垂直。
     杆那一头（Case A：一笔画成）用这个公式会偏一点，所以杆的方向另有算法 ——
     buildLinks 里直接用"尾巴 → 尖"定方向。 */
export function readArrowHead(points) {
  const t = findTip(points)
  if (!t) return null
  const pts = toPoints(points)
  const backLen = arcLen(pts.slice(0, t.i + 1))
  const fwdLen = arcLen(pts.slice(t.i))
  const small = Math.min(backLen, fwdLen)
  /* 两半差不到一倍才算"一个 V"：差太多的是"一根线 + 半路上拐个弯"。
     实测他的箭头两半 59/51（1.16 倍），余量给到 1.8 倍。 */
  if (small < TIP_ARM_MIN || Math.max(backLen, fwdLen) > small * 1.8) return null
  const a = unit(t.at, pts[0])
  const b = unit(t.at, pts[pts.length - 1])
  if (!a || !b) return null
  const dx = -(a.x + b.x)
  const dy = -(a.y + b.y)
  const n = Math.hypot(dx, dy)
  if (n < 1e-6) return null
  return { at: t.at, dir: { x: dx / n, y: dy / n }, arm: small }
}

/* 末尾回勾：一笔画成的箭头（先画杆、到地方回手带出一个撇）。
 *
 * 判据两条，都是**绝对尺寸**（世界像素）：
 *   末尾 25% 的点里，沿主轴"往回走"的总距离 > 6px   且   这一段的离轴 > 7px  → 有箭头
 * 为什么**不按笔画长度按比例**算（第一版就是按比例，结果连自己造的箭头都读成线）：
 *   真手画的箭头，那个撇的大小是**恒定**的（十几二十像素），跟杆有多长没关系 ——
 *   一条 600px 的长线，箭头回勾也只有 20px，按"全长的 5%"要 30px 才算，于是全漏。
 *   而 6 / 7 这两个数是从"抖动有多大"倒推的：手画直线抖 ±3~6px，箭头撇有 ±10~15px，
 *   两条闸（回勾 + 离轴）分开判，抖动两条都过不了。
 *
 * ⚠ 两个"看着更聪明、实际不行"的写法，都试过：
 *   · **拿投影最远的那一点来切"末尾"**：箭头的尖往往正好就是投影最远的点，
 *     于是整个箭头都被排除在"末尾"之外，一个箭头都认不出来。所以末尾按**下标**取。
 *   · **只判"离轴"**：弧形、S 形、抖动的线全都离轴，但它们不回勾 ——
 *     所以"离轴"只是第二道闸（滤掉沿轴来回抖：那种 off 很小）。 */
export function backHook(points) {
  const pts = toPoints(points)
  if (pts.length < 4) return false
  const a = pts[0]
  const b = pts[pts.length - 1]
  const L = Math.hypot(b.x - a.x, b.y - a.y)
  if (L < 24) return false // 太短，不猜
  const ux = (b.x - a.x) / L
  const uy = (b.y - a.y) / L
  const proj = new Array(pts.length)
  const off = new Array(pts.length)
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - a.x
    const dy = pts[i].y - a.y
    proj[i] = dx * ux + dy * uy
    off[i] = Math.abs(dx * uy - dy * ux)
  }
  const k = Math.max(3, Math.ceil(pts.length * 0.25))
  const from = Math.max(0, pts.length - k)
  let back = 0
  let maxOff = 0
  for (let i = from; i < pts.length; i++) {
    if (off[i] > maxOff) maxOff = off[i]
    if (i > from) back += Math.max(0, proj[i - 1] - proj[i]) // 只累加"往回走"的那部分
  }
  return back > 6 && maxOff > 7
}

/* 一笔看形状：是"线"还是"带箭头"。两条判据满足一条就算（见上面那段说明）。 */
export function classifyLinkShape(points) {
  const pts = toPoints(points)
  const t = findTip(pts)
  /* ★ 2026-09-16（DSH 会话）修：这里原来写的是 `t.frac >= 0.72 || t.frac <= 0.28`，
     而 `findTip` 从来不返回 `frac` —— 于是这个判据**从来没生效过**（undefined 比数字全是 false），
     "有尖"那条路只剩 backHook 撑着；一笔画成、末端带个小尖（不回勾）的箭头一律读成"线"。
     改成调真正干这件事的 `tipNearEnd`（就是为这条写的那两条闸：短边 ≤ HEAD_ARM_MAX
     且 ≤ 全长 35%），并且它和 buildLinks 用的是同一个函数，两处不会再分叉。 */
  if (t && tipNearEnd(t)) return 'arrow'
  return backHook(pts) ? 'arrow' : 'line'
}

/* 一笔**实际**算哪种关系：手动标过就用手动标的，否则看形状。
 * ⚠ 这是给"单笔"用的判断。连接那一层请用 `links[i].auto`（尖是旁边一笔画的时，
 *   单笔永远读成"相关"，只有链上才知道那个尖是它的）。
 *
 * 删掉了 `effectiveLinkKind`（2026-09-16）：它零调用者，而"手动标过就赢、否则按形状读"
 * 这条规矩在 buildLinks 里已经有一份（选择手动词那几行）—— 两份实现摆在那儿，
 * 迟早会分叉。 */
export function autoLinkKind(stroke) {
  return classifyLinkShape(stroke && stroke.points) === 'arrow' ? ARROW_LINK : DEFAULT_LINK
}

/* 点落在哪张卡里（宽容 8px：手画的线常常差一点点才碰到卡片边）。 */
function cardAt(boxes, p, pad = 8) {
  return boxes.find((b) => pointInRect(p, b.r, pad)) || null
}

/* 离这一点最近的卡（0 = 它本来就在卡里），但只认 pad 之内。
   为什么需要它：用户画箭头常常**停在卡前面一点**（尖得留出画 V 的地方），
   于是"尖落在哪张卡里"永远不成立 —— 可"尖指着谁"是明摆着的。
   这是"停在空中"和"真的连着"之间那道闸：超过 TIP_PAD 就不认。 */
function nearestCard(boxes, p, pad) {
  let best = null
  let bd = pad
  for (const b of boxes) {
    const r = b.r
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w))
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h))
    const d = Math.hypot(dx, dy)
    if (d <= bd) {
      bd = d
      best = b
    }
  }
  return best
}

/* 端点相接的笔迹接成一条通路（**只在分析时用，不改数据、不写盘**）。
 *
 * 什么时候需要它：一条连接线分两笔画（画到一半断了一下，接着往下画）。
 * 什么时候**绝不能**接（这几条都是想清楚才加上的，少一条就会出事）：
 *   · **两笔都是从同一个点出发的**（一支箭头分叉、或者从一张卡拉出两根线）——
 *     接起来会把两根揉成一根，还会把其中一个目标整个吞掉（a/b 变成同一张卡，
 *     于是两条连接**全没了**）。判据：只在"**一笔的末 → 另一笔的首**"之间接，
 *     首↔首、末↔末一律不接。
 *   · **拐着弯的**（画成一个 L）：接起来会把 A→B、B→C 两根连成一根 A→C，
 *     中间那张卡的连接就丢了。判据：夹角 ≥ STRAIGHT_DEG(150°) 才算"顺着往下"。
 *   · **一个端点上挤了三笔以上**：不碰（互相最近说不定，接出来的链条没有意义）。
 *   · **接头落在卡片里**（`blockedAt`）：不接。卡片是连接的**端点**该在的地方 ——
 *     两根线各自画进同一张卡、两个笔尖刚好挨着又有 2 像素的共线，几何上跟
 *     "一笔画到一半断了"**完全一样**，只有"接头在卡里"这一条能分开它们。
 *     （这条是 check-board [6d] 的"把点倒过来 → 方向反过来"那条老断言抓出来的：
 *      倒了之后两根线的接头正好落在 k2 里，被接成了一根，两条连接变一条。）
 * 箭头那两只臂**不走这条路**：它们是"首↔首"（都从尖出发），本来就该各留各的，
 * 由 gatherHeads 那边单独拼成一个 V —— 两件事分开做，互不干扰。 */
export function joinStrokes(strokes, tol = JOIN_TOL, blockedAt = null) {
  const items = []
  for (const s of strokes || []) {
    if (!s || s.tool === 'highlighter') continue
    const pts = toPoints(s.points)
    if (pts.length >= 2) items.push({ id: s.id, pts })
  }
  const blocked = (p) => !!blockedAt && blockedAt(p)
  const ends = []
  items.forEach((it, si) => {
    ends.push({ si, e: 0, p: it.pts[0] })
    ends.push({ si, e: 1, p: it.pts[it.pts.length - 1] })
  })
  /* 网格分桶：600 多笔的板上端点有 1200 个，两两比是 144 万次 ——
     而这是每次 commit 都要算一遍的量，得是 O(端点)。 */
  const cell = (p) => Math.floor(p.x / tol) + '|' + Math.floor(p.y / tol)
  const grid = new Map()
  ends.forEach((x, i) => {
    const k = cell(x.p)
    const arr = grid.get(k)
    if (arr) arr.push(i)
    else grid.set(k, [i])
  })
  const nearEnds = (i) => {
    const p = ends[i].p
    const cx = Math.floor(p.x / tol)
    const cy = Math.floor(p.y / tol)
    const out = []
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = grid.get(gx + '|' + gy)
        if (!arr) continue
        for (const j of arr) {
          if (j === i || ends[j].si === ends[i].si) continue
          if (ends[j].e === ends[i].e) continue // 首↔首 / 末↔末 不接（见上面）
          out.push({ j, d: Math.hypot(ends[j].p.x - p.x, ends[j].p.y - p.y) })
        }
      }
    }
    out.sort((a, b) => a.d - b.d)
    return out
  }
  const dest = (i) => ends[i ^ 1].p // 这根笔迹的另一头
  const mate = ends.map((_, i) => {
    if (blocked(ends[i].p)) return -1
    for (const c of nearEnds(i)) {
      if (c.d > tol) break
      if (blocked(ends[c.j].p)) continue
      const u = unit(dest(i), ends[i].p)
      const v = unit(ends[c.j].p, dest(c.j))
      if (!u || !v) continue
      /* "顺着往下"：两条笔在这一头的**内角** ≥ STRAIGHT_DEG(150°) 才算续着画的。
         u 是"进来"的方向（本笔另一头 → 接头）、v 是"出去"的方向（接头 → 对方另一头），
         两者之间那个角是**偏转角**，内角 = 180 − 偏转 —— 所以判据要写成"偏转 ≤ 30°"。
         ⚠ 2026-09-16 修：原来写的是 `偏转 < STRAIGHT_DEG 就 continue` ——
           那等于"只有**折回来**才接"，恰好把这条判据要接的那种（方向接着往下）
           全部拒掉，而 V 形折回反倒被接成一条。实测（修之前）：
             直线续画 → 2 条（该接没接）；折回来 → 1 条（不该接却接了）—— 正好反了。
           自检里以前没有一条断言"直线续画能被接上"，所以这个反了的判据一直没被抓到
           （是 2026-09-16 审查 + chainOfStroke 的断言顺带挖出来的）。 */
      if (angleDeg(u, v) > 180 - STRAIGHT_DEG) continue
      return c.j
    }
    return -1
  })
  const paired = (i) => mate[i] >= 0 && mate[mate[i]] === i
  const used = new Set()
  const out = []
  const order = []
  for (let i = 0; i < ends.length; i++) if (!paired(i)) order.push(i) // 先从自由端出发
  for (let i = 0; i < ends.length; i++) order.push(i) // 剩下的（闭环那种）兜底
  for (const start of order) {
    if (used.has(ends[start].si)) continue
    let cur = start
    const ids = []
    const points = []
    for (;;) {
      const it = items[ends[cur].si]
      used.add(ends[cur].si)
      ids.push(it.id)
      const seq = ends[cur].e === 0 ? it.pts : it.pts.slice().reverse()
      for (const q of seq) points.push(q)
      const exit = cur ^ 1 // 每根笔迹的两个端点在 ends 里是相邻的一对，异或就是"另一头"
      const nxt = mate[exit]
      if (nxt < 0 || !paired(exit) || used.has(ends[nxt].si)) break
      cur = nxt
    }
    if (points.length >= 2) out.push({ ids, points })
  }
  return out
}

/* 把两条短笔按四个朝向拼起来，挑出"正好是一个 V"的那个拼法。 */
function tryPairHead(a, b, tol) {
  for (const ra of [false, true]) {
    for (const rb of [false, true]) {
      const A = ra ? a.slice().reverse() : a
      const B = rb ? b.slice().reverse() : b
      if (Math.hypot(A[A.length - 1].x - B[0].x, A[A.length - 1].y - B[0].y) > tol) continue
      const h = readArrowHead(A.concat(B))
      if (h) return h
    }
  }
  return null
}

/* 板上所有的"箭头尖"。用户是**分开画**的（两张样例都是：一杆一笔、尖一笔），
 * 而尖自己又可能是"一笔画成的 V"或者"两撇各一笔"。两种都收：
 *   ① 单笔就是一个 V；
 *   ② 两笔**短笔**（各自 ≤ HEAD_ARM_MAX）在端点处挨着，拼起来正好是一个 V。
 * 返回 [{ at, dir, arm, ids }]。 */
export function gatherHeads(strokes, tol = JOIN_TOL, skip = null) {
  const out = []
  const short = []
  for (const s of strokes || []) {
    if (!s || s.tool === 'highlighter') continue
    if (skip && skip.has(s.id)) continue
    const pts = toPoints(s.points)
    if (pts.length < 2) continue
    const h = readArrowHead(pts)
    if (h) {
      out.push({ ...h, ids: [s.id] })
      continue
    }
    if (arcLen(pts) <= HEAD_ARM_MAX) short.push({ id: s.id, pts })
  }
  /* 两笔拼：先用网格把"端点挨得近"的挑出来，别两两全比（板上可能有几百笔）。 */
  const byCell = new Map()
  short.forEach((it, i) => {
    for (const p of [it.pts[0], it.pts[it.pts.length - 1]]) {
      const k = Math.floor(p.x / tol) + '|' + Math.floor(p.y / tol)
      const arr = byCell.get(k)
      if (arr) arr.push(i)
      else byCell.set(k, [i])
    }
  })
  const tried = new Set()
  for (const [k, arr] of byCell) {
    const [kx, ky] = k.split('|').map(Number)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const other = byCell.get(kx + dx + '|' + (ky + dy))
        if (!other) continue
        for (const i of arr) {
          for (const j of other) {
            if (i === j) continue
            const key = Math.min(i, j) + ':' + Math.max(i, j)
            if (tried.has(key)) continue
            tried.add(key)
            const h = tryPairHead(short[i].pts, short[j].pts, tol)
            if (h) out.push({ ...h, ids: [short[i].id, short[j].id] })
          }
        }
      }
    }
  }
  return out
}

/* ═══════════ 墨迹块：没成卡的字迹、手画的图也能当端点 ═══════════
 *
 * 用户 2026-09-16 的原话：「连接的不只是卡片，可能还有我没转化成卡片的字迹，
 * 我自己手绘的图」。在数据层它们本来就是 strokes —— 缺的只是"端点落在谁身上"
 * 这一步：`cardAt` 只认卡片，所以那些字迹和图上永远连不住。
 *
 * 这里把"节点"扩成 **卡片 ∪ 墨迹块**：笔与笔挨得够近（≤ INK_BLOCK_GAP）就算同一块，
 * 于是一段式子、一张手画的图各自是一块。**不存盘、不新增实体** —— 块是每次现算的，
 * 像连接一样跟着笔迹走。（`groups` 字段留着给以后的"框选固化"，这一版还没用。）
 *
 * 三道闸（阈值都是拿他板上 439 笔量的，见 README 第 22 条）：
 *   ① **两头各落在不同的节点里**。字里的一横两头在同一坨里 → 直接出局。
 *   ② **中段是空白**：弧长 30%~70% 那五个采样点，离别的墨都要 ≥ INK_LINK_MID_GAP。
 *      这条挡的是"长横线"：公式的分数线中段上下就是分子分母，一量就贴着；
 *      而真的连接线中段是空的。
 *   ③ **够长**（≥ INK_LINK_MIN_LEN）。
 * 实测：他 439 笔长度中位 **26px**、99% 不到 146px；"长 ≥120px 且中段空 ≥20px"的
 * 只有**个位数**笔。所以这三条一起非常保守 —— 宁可漏（少一条连接），不误判。
 *
 * ⚠ 代价（写清楚，别以后自己踩）：两块靠得很近、线又画得短时，中段采样点会落在
 *   端点那块墨的 18px 里 → 判不出来。**把线画长一点**（跨过空白）就认了。
 * ⚠ 卡片↔卡片那条路**一条闸都不加**（它铁定是连接，见 buildLinks 里"顺序很重要"）——
 *   这里只约束"要落在墨迹块上"的那些。 */
export const INK_BLOCK_GAP = 24      // 笔与笔这么近（世界像素）算同一块
export const INK_NODE_PAD = 12       // 端点离块的墨这么近，算"落在这块里"
export const INK_LINK_MIN_LEN = 48   // 比这短的笔不当连接
export const INK_LINK_MID_GAP = 18   // 中段离别的墨要这么远（降到 12 会误判，实测：见 README 第 22 条）
export const INK_NODE_MIN_SIZE = 18  // 一块墨的"最小个头"（包围盒对角线）：比这小的不算"一个东西"
/* 「条件是位置送的」：线**中点**这么近的地方写着的字（或那张卡）就是这条关系的条件。
   64 世界像素大约是"贴着线写两三个字"的距离 —— 他本来就要写"仅当…"，
   不用再告诉应用这是谁的条件。见 linkCondition。 */
export const LINK_COND_RADIUS = 64

const INK_CELL = 32 // 空间格子边长（查"附近有没有墨"用）

/* 格子键用**数字**，不用 "x,y" 字符串：这段每次 commit 都要跑，
   字符串拼接 + 解析实测比数字键慢一倍以上（620 笔的板上差 10ms 量级）。
   ±10 万格 = ±320 万像素，够用了，而且远在 Number 精确整数范围内。 */
function inkKey(cx, cy) {
  return (cx + 100000) * 1000000 + (cy + 100000)
}

/* 建一次空间索引：每笔一个条目（点列），每个点进一个格子。
   为什么要它：板上 600+ 笔、上万点，而这是**每次 commit 都要跑**的一段，
   两两全比是上亿次。索引本身是 O(点数)。荧光笔不进索引：它是"在字上做记号"，
   一划一大片，端点很容易落在两坨字上，那属于误判（和 joinStrokes 同一条理由）。
   ★ 它是**只依赖 strokes** 的（和卡片无关），所以上层可以按 `board.strokes` 缓存它 ——
     拖卡片时 strokes 引用没变，就不必重建（见 Board.jsx）。 */
/* ⚠ **internal seam**：只给这个 module 自己的测试用（`check-board` 里缓存那几条）。
   调用方请走 `createLinkReader().read(board)` —— 把索引直接递给 `buildLinks` 的那条路
   已经收掉了，它就是"内部纪律变成调用方知识"的入口。 */
export function createInkIndex(strokes, groups = []) {
  const grid = new Map()
  const list = []
  for (const s of strokes || []) {
    if (!s || s.tool === 'highlighter') continue
    const pts = toPoints(s.points)
    if (pts.length < 2) continue
    const i = list.length
    list.push({ id: s.id, pts })
    for (const p of pts) {
      const k = inkKey(Math.floor(p.x / INK_CELL), Math.floor(p.y / INK_CELL))
      const arr = grid.get(k)
      if (arr) arr.push({ x: p.x, y: p.y, i })
      else grid.set(k, [{ x: p.x, y: p.y, i }])
    }
  }
  const index = {
    list,
    grid,
    owner: new Map(),
    /* 按"排除集"分开的缓存（见 inkNodeAt 的 cacheKey）：
       同一个点上，用不同的排除集问出来的块**不是同一个块** ——
       "尖指着谁"那一次要把箭头自己的尖排除掉，混进同一个 owner 就会串味
       （实测：目标变成"箭头自己的两撇 + 一个小点"）。 */
    caches: new Map(),
    byId: new Map(list.map((it, i) => [it.id, i])),
    /* 你**固定过**的那些块（见 normalizeGroups）：它们的成员从自动聚类里剔出去。
       ★ 单独放一个 Map，**绝不能挂在 `owner` 上**：`owner` 是"候选线"那套缓存，
         `dropKey` 一变就会被清掉（而 `dropKey` 一开始是 undefined，
         所以第一次 buildLinks 就会把它清光）—— 挂在那上面等于固定块从来没生效过：
         本来连得上的连接会消失、把相隔很远的两坨固定成一块还会**凭空造出一条连接**。
         （这条是 2026-09-16 让独立审查挑出来的；自检当时只直接问了 inkNodeAt，
           没走 buildLinks，所以漏过了 —— 补的断言必须走 buildLinks。） */
    fixed: new Map(),
    groupIdx: new Set(),
  }
  for (const g of Array.isArray(groups) ? groups : []) {
    const ids = []
    for (const id of (g && g.ids) || []) {
      const i = index.byId.get(id)
      if (i !== undefined) ids.push(i)
    }
    if (!ids.length) continue
    const node = {
      kind: 'ink',
      id: 'grp:' + (g.id || ids.map((i) => index.list[i].id).sort()[0]),
      ids: ids.map((i) => index.list[i].id),
      label: `固定的块（${ids.length} 笔）`,
      box: inkBounds(index, ids),
      fixed: true,
    }
    for (const i of ids) {
      index.fixed.set(i, node)
      index.groupIdx.add(i)
    }
  }
  return index
}

/* 离 (x,y) 最近的墨点距离；`exclude`（笔画下标集合）里的点不算。
   超过 max 就不再往外找（返回 max+1）—— 调用方只关心"够不够远"。
   ★ 收工判据是 `best <= (ring-1) * INK_CELL`：第 ring 圈的格子里的点，
     最近也可能离查询点在 (ring-1) 格之内，所以不能拿 ring 本身当界。 */
function nearestInk(index, x, y, exclude, max) {
  const grid = index.grid
  const cx = Math.floor(x / INK_CELL)
  const cy = Math.floor(y / INK_CELL)
  /* 第 r 圈的格子最近也在 (r-1) 格之外，所以够到 max 只需要 floor(max/格) + 1 圈。
     （写成 ceil(...) + 1 会白扫一圈 —— 这块是每次 commit 都跑的，实测差一倍。） */
  const rings = Math.floor(max / INK_CELL) + 1
  let best = max + 1
  for (let ring = 0; ring <= rings; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const arr = grid.get(inkKey(cx + dx, cy + dy))
        if (!arr) continue
        for (const it of arr) {
          if (exclude && exclude.has(it.i)) continue
          const d = Math.hypot(it.x - x, it.y - y)
          if (d < best) best = d
        }
      }
    }
    if (best <= Math.max(0, ring - 1) * INK_CELL) break
  }
  return best
}

/* (x,y) 周围 pad 之内有哪些笔（返回它们在索引里的下标）。`exclude` 里的不算。 */
function inkNear(index, x, y, pad, exclude = null) {
  const grid = index.grid
  const cx = Math.floor(x / INK_CELL)
  const cy = Math.floor(y / INK_CELL)
  const rings = Math.floor(pad / INK_CELL) + 1 // 同上：第 r 圈最近也在 (r-1) 格外
  const out = new Set()
  for (let ring = 0; ring <= rings; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const arr = grid.get(inkKey(cx + dx, cy + dy))
        if (!arr) continue
        for (const it of arr) {
          if (exclude && exclude.has(it.i)) continue
          if (Math.hypot(it.x - x, it.y - y) <= pad) out.add(it.i)
        }
      }
    }
  }
  return out
}

/* 从这几笔出发，把"笔与笔 ≤ gap"连着的笔全聚起来（连通分量）。
   `index.groupIdx`（你固定过的那些块）不参与：固定的块就是块，不该再被并大。 */
function inkComponentFrom(index, seeds, gap, exclude = null) {
  const seen = new Set(seeds)
  const stack = [...seeds]
  while (stack.length) {
    const i = stack.pop()
    for (const p of index.list[i].pts) {
      for (const j of inkNear(index, p.x, p.y, gap, exclude)) {
        if (seen.has(j) || index.groupIdx.has(j)) continue
        seen.add(j)
        stack.push(j)
      }
    }
  }
  return [...seen]
}

function inkBounds(index, ids) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const i of ids) {
    for (const p of index.list[i].pts) {
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y
      if (p.y > y1) y1 = p.y
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/* 点 p 落在哪一块墨迹里。返回 { kind:'ink', id, ids, label, box } 或 null。
   id 取块里**最小的那个笔迹 id** —— 只要这块的成员不变，id 就稳定
   （面板那一行、以及"两条连接是不是同一对节点"都靠它对齐）。
   ★ `index.owner` 是"笔画下标 → 块"的记忆：一块只 flood fill 一次。
     没有它的话每个端点都要重走一遍整块（实测 620 笔的板上 35ms → 4.1s，
     因为一条板书上几百个端点、每块几十笔）。 */
/* 这次查询该用哪个缓存：
   · 给了 `cacheKey` → 用它（**跨调用**都能复用，比如"尖指着谁"那一族）；
   · 没给、但排除集正好是本次 buildLinks 的主排除集（候选线那批）→ 用 `owner`
     （这是热路径：端点的普通查询，跨调用复用才有意义）；
   · 其它情况（有人加了新的排除集却忘了给 key）→ **给一个一次性的 Map**：
     正确性优先 —— 不缓存只是慢一点，串味却会给出错的块。 */
function storeFor(index, exclude, cacheKey) {
  if (cacheKey) {
    let m = index.caches.get(cacheKey)
    if (!m) {
      m = new Map()
      index.caches.set(cacheKey, m)
    }
    return m
  }
  if (index.mainExclude && exclude === index.mainExclude) return index.owner
  return new Map()
}

/* ⚠ **internal seam**（同上）：块、排除集、缓存键都是 module 内部的东西。 */
export function inkNodeAt(index, p, pad = INK_NODE_PAD, gap = INK_BLOCK_GAP, exclude = null, cacheKey = '') {
  /* ⚠ 缓存必须**按排除集分开**：带额外排除集的查询
     （"尖指着谁"要把箭头自己的尖排掉、"线中点旁边是什么"要把这条线自己排掉）
     和通用查询问出来的**不是同一个块**。混用一个 Map 就会读到别人的结果 ——
     实测：同一个索引、同一个点，先按"排除 line1"问，再问"不排除"，
     第二次读到的还是第一次那个不含 line1 的节点（缓存把结果固定住了）。
     加新的带排除集的查询时：**要么给 cacheKey，要么什么都会被 storeFor 兜住**
     （兜住 = 不缓存，正确但慢），所以不会再串味。 */
  const store = storeFor(index, exclude, cacheKey)
  const seeds = [...inkNear(index, p.x, p.y, pad, exclude)]
  if (!seeds.length) return null
  /* ★ **亲手固定过的块**（`groups`）永远优先，而且不看 store：
     它们在 `index.fixed` 里 —— 和排除集无关、`owner` 被清也不受影响
     （"你说它是东西它就是"）。不先查这一下，固定块在 buildLinks 里就完全失效了。 */
  for (const i of seeds) {
    const f = index.fixed.get(i)
    if (f) return f
  }
  for (const i of seeds) if (store.has(i)) return store.get(i)
  const ids = inkComponentFrom(index, seeds, gap, exclude)
  if (!ids.length) return null
  const strokeIds = ids.map((i) => index.list[i].id)
  const box = inkBounds(index, ids)
  /* ★ 太小的不算"一个东西"（见 INK_NODE_MIN_SIZE）。
     实测：他手写公式里有个 **2px 的小点**，旁边一条 121px 的竖笔 + 一个 V 形短笔
     于是被读成"从公式卡指向那个点的箭头" —— 一个 2px 的点没有可指的对象。
     这里返回 null = 这一头不算落在块上（那一笔就不是连接）。
     ⚠ 你**亲手固定过**的块不走这条 —— 它在上面那个 owner 循环里就返回了
     （"你说它是东西它就是"）。 */
  if (Math.hypot(box.w, box.h) < INK_NODE_MIN_SIZE) return null
  const node = {
    kind: 'ink',
    id: 'ink:' + strokeIds.slice().sort()[0],
    ids: strokeIds,
    label: `墨迹块（${strokeIds.length} 笔）`,
    box,
  }
  /* ★ `noCache`（"尖指着谁"那一次查询用）：那种查询带着**额外的排除集**
     （要把它自己的箭头尖排除掉），算出来的节点和通用缓存里的不是同一个东西 ——
     写进 `owner` 就会串味。实测：不关缓存时，"公式卡 → 墨迹块（2 笔）"里
     那 2 笔就是**箭头自己的尖 + 一个小点**（目标里混进了箭头本身）。 */
  for (const i of ids) store.set(i, node)
  return node
}

/* 板上所有的墨迹块：你**固定过的**先出（`groups`），然后是自动聚出来的。
   给自检和"框选固化"的界面用；不进 buildLinks 的热路径。 */
/* ⚠ **internal seam**（同上）：给自检看"板上有哪几块"的。 */
export function inkBlocks(strokes, { gap = INK_BLOCK_GAP, groups = [] } = {}) {
  const index = createInkIndex(strokes, groups)
  const out = []
  const fixed = new Set()
  for (const node of index.fixed.values()) {
    if (fixed.has(node.id)) continue
    fixed.add(node.id)
    out.push(node)
  }
  const done = new Set(index.groupIdx)
  for (let i = 0; i < index.list.length; i++) {
    if (done.has(i)) continue
    const ids = inkComponentFrom(index, [i], gap)
    for (const j of ids) done.add(j)
    const strokeIds = ids.map((k) => index.list[k].id)
    out.push({ kind: 'ink', id: 'ink:' + strokeIds.slice().sort()[0], ids: strokeIds, box: inkBounds(index, ids) })
  }
  return out
}

/* 离 (x,y) 最近的那**一笔**墨（不是距离），返回 { i, p, d } 或 null。
   和 nearestInk 是一对：那个只要距离（判"够不够远"），这个要"是谁"。 */
function nearestInkStroke(index, x, y, exclude, max) {
  const grid = index.grid
  const cx = Math.floor(x / INK_CELL)
  const cy = Math.floor(y / INK_CELL)
  const rings = Math.floor(max / INK_CELL) + 1
  let best = null
  for (let ring = 0; ring <= rings; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const arr = grid.get(inkKey(cx + dx, cy + dy))
        if (!arr) continue
        for (const it of arr) {
          if (exclude && exclude.has(it.i)) continue
          const d = Math.hypot(it.x - x, it.y - y)
          if (d <= max && (!best || d < best.d)) best = { i: it.i, p: { x: it.x, y: it.y }, d }
        }
      }
    }
    if (best && best.d <= Math.max(0, ring - 1) * INK_CELL) break
  }
  return best
}

/* 一条连接的**中点**（按弧长，不按两端点的中点 —— 线和端点的中点常常不是同一个地方）。 */
function chainMid(pts) {
  const total = arcLen(pts)
  if (!(total > 0)) return pts[0] || null
  const target = total / 2
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (acc + seg >= target) {
      const t = seg > 0 ? (target - acc) / seg : 0
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }
    }
    acc += seg
  }
  return pts[pts.length - 1]
}

/* ═══════════ 条件：线中点附近那几个字（或那张卡）自动成为这条关系的条件 ═══════════
 *
 * 用户 2026-09-16：「条件是位置送的。线中点附近那几个字 / 那张卡，自动成为这条关系的条件
 * —— 你本来就要写"仅当…"，不用再告诉它是谁的条件。」
 *
 * 规矩：
 *   · 只看**中点**（弧长一半那一点，不是两端点的中点）周围 LINK_COND_RADIUS 之内；
 *   · **卡片优先**：线中段旁边放一张卡，那是最明确的条件；
 *   · 排除这条线自己的笔（`exclude`）、以及**它两端的节点**（那是关系本身的两头，
 *     不是条件）；别的连接线也不算（条件是你写的内容，不是另一条关系）；
 *   · 太小的一撮墨不算（`INK_NODE_MIN_SIZE`，和墨迹块同一条闸）。
 * **不存盘**：条件是从位置读出来的，随时能重算 —— 你把那几笔挪走，它就不成立了。 */
function linkCondition(ink, boxes, mid, exclude, aNode, bNode, cacheKey = '') {
  if (!mid) return null
  /* 半径内的卡**按距离试**，跳过这条关系两端的卡 ——
     ⚠ 不能只看"最近的那一张"：最近那张要是端点卡，真正的条件卡就被整体漏掉了
     （实测：端点卡 60px、条件卡 62px，两个都在 64px 内 → 条件读成 null）。 */
  const skip = new Set([aNode && aNode.id, bNode && bNode.id].filter(Boolean))
  let card = null
  let cd = Infinity
  for (const b of boxes) {
    if (skip.has(b.id)) continue
    const r = b.r
    const dx = Math.max(r.x - mid.x, 0, mid.x - (r.x + r.w))
    const dy = Math.max(r.y - mid.y, 0, mid.y - (r.y + r.h))
    const d = Math.hypot(dx, dy)
    if (d <= LINK_COND_RADIUS && d < cd) {
      cd = d
      card = b
    }
  }
  if (card) return { kind: 'card', id: card.id, ids: [], label: '', at: mid }
  const hit = nearestInkStroke(ink, mid.x, mid.y, exclude, LINK_COND_RADIUS)
  if (!hit) return null
  /* ★ `cacheKey` 必须给：这次查询带着"把这条线自己排除掉"的额外排除集，
     和通用缓存里的节点**不是同一个东西** —— 不给就会读到别人算的节点
     （实测：同一个索引、同一个点，先按"排除 line1"问一次，再问"不排除"，
     第二次读到的还是第一次那个不含 line1 的节点 → 缓存把结果固定住了）。 */
  const node = inkNodeAt(ink, hit.p, INK_NODE_PAD, INK_BLOCK_GAP, exclude, cacheKey)
  if (!node) return null
  if ((aNode && node.id === aNode.id) || (bNode && node.id === bNode.id)) return null
  return { kind: 'ink', id: node.id, ids: node.ids, label: node.label, at: hit.p }
}

/* ═══════════ 推导链：A —(条件)→ B —(条件)→ C ═══════════
 *
 * 「面板读成链并标出缺条件那步」——链只在有方向的连接上成立，这里从**推导**那条
 * （`derive`）走：由一个式子推出下一个式子，条件是中点旁边那些字（见 linkCondition）。
 * 返回每条链的步骤（谁 → 谁、条件是什么、**缺不缺条件**），给面板用。
 * 规矩：
 *   · 从"只有出、没有进"的节点出发（根）；走不通就停；
 *   · 一个节点有两条出边 = 分叉，各自成链（不做拓扑排序那套，够用就行）；
 *   · **防环**：走过的节点不再走（手画的关系里出环太容易了）。
 * **不存盘**：链是现算的，和关系本身一样。 */
export function deriveChains(links = [], maxSteps = 24) {
  /* ⚠ 只认 `derive`，而且**自环（a===b）直接不算**（它没有任何意义，还会让下面的走法打转）。 */
  const steps = (links || []).filter((l) => l && l.kind === 'derive' && l.a !== l.b)
  if (!steps.length) return []
  const out = new Map()
  const ind = new Set()
  for (const l of steps) {
    const arr = out.get(l.a)
    if (arr) arr.push(l)
    else out.set(l.a, [l])
    ind.add(l.b)
  }
  /* 从"只有出、没有进"的节点出发；整条都是环的时候，每个节点都当起点（免得一条都不显示）。 */
  const roots = [...out.keys()].filter((id) => !ind.has(id))
  const starts = roots.length ? roots : [...out.keys()]
  const chains = []
  const seen = new Set()
  const emit = (start, list, truncated) => {
    if (!list.length) return
    const key = list.map((s) => s.from + '>' + s.to).join(',')
    if (seen.has(key)) return
    seen.add(key)
    chains.push({ start, steps: list, missing: list.filter((s) => s.missing).length, truncated: !!truncated })
  }
  /* ★ 分叉要**每条路都走**（原来只取第一条出边，B→D 那条分支会整条消失）。
     环用"这条路上已经走过的节点"挡住；到上限就标记 truncated（面板要能说明"只显示前 N 步"）。 */
  const walk = (start, node, path, list) => {
    const outs = out.get(node) || []
    if (!outs.length) {
      emit(start, list, false)
      return
    }
    for (const l of outs) {
      if (path.has(l.b)) {
        emit(start, list, false) // 环：走到这儿为止，但走出来的部分要显示
        continue
      }
      if (list.length >= maxSteps) {
        emit(start, list, true)
        continue
      }
      const step = { from: l.a, to: l.b, link: l, cond: l.cond || null, missing: !l.cond }
      walk(start, l.b, new Set([...path, l.b]), [...list, step])
    }
  }
  for (const s of starts) walk(s, s, new Set([s]), [])
  return chains
}
/* 这条链"像不像一条连接线"（只在要落在墨迹块上时用）：够长 + 中段是空白。
   中段按**弧长**取 30%~70%（不按下标 —— 采样密度会骗人，见 findTip 那段）。
   ★ 采样点要**沿线插值**，不能"取离目标弧长最近的那个现有点"：
     一条直线笔迹可能只有两个点（存盘前会 simplifyPoints），那样按点取的话
     30% 和 70% 都落在两个端点上 —— 而端点正扎在字迹里，中段判据永远不通过，
     "一块字迹都连不上"（自检 [6f] 就是这么抓出来的）。 */
function inkLinkShapeOK(pts, index, exclude) {
  const total = arcLen(pts)
  if (total < INK_LINK_MIN_LEN) return false
  const S = new Array(pts.length)
  S[0] = 0
  for (let i = 1; i < pts.length; i++) S[i] = S[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  for (const f of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const target = f * total
    let i = 1
    while (i < pts.length - 1 && S[i] < target) i++
    const a = pts[i - 1]
    const b = pts[i]
    const seg = S[i] - S[i - 1]
    const t = seg > 0 ? (target - S[i - 1]) / seg : 0
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    if (nearestInk(index, p.x, p.y, exclude, INK_LINK_MID_GAP) < INK_LINK_MID_GAP) return false
  }
  return true
}

/* ── 连接读法：这个 module 的 **interface** ──
 *
 * 调用方（app 和自检）只该用这一个入口：
 *
 *     const reader = createLinkReader()
 *     reader.read(board)          // → links[]
 *
 * 索引、候选线、墨迹块、条件、推导链**都在它后面**：谁按什么记忆化、排除集怎么算、
 * 缓存什么时候失效，全是它自己的事。
 *
 * ★ 为什么要有这一层（2026-09-16 收的口）：在那之前调用方得自己
 *   `createInkIndex(strokes, groups)` 再把它传给 `buildLinks(board, index)` ——
 *   于是"什么时候重建索引""排除集变了要不要清缓存"这些**内部纪律**变成了
 *   调用方必须知道的知识；而自检干脆绕过 `buildLinks` 直接去问 `inkNodeAt`。
 *   结果就是"怎么被调用"这一层两类测试都盖不住：固定块因为被清掉缓存而**整个失效**
 *   那条严重 bug 正是这么漏过去的（`[6h]` 当时只直接问了 `inkNodeAt`）。
 *   `read()` 每次自己判断要不要重建（按 `strokes`/`groups` 的**引用**比），
 *   所以调用方连"有索引这回事"都不需要知道。
 *
 * 想在测试里直接摸内部（`inkNodeAt` / `inkBlocks` / `createInkIndex`）请先看下面
 * 那几个函数上的 **internal seam** 标注：它们只给这个 module 自己的测试用。 */
export function createLinkReader() {
  let ink = null
  let lastStrokes = null
  let lastGroups = null
  return {
    read(board) {
      const strokes = (board && board.strokes) || []
      const groups = (board && board.groups) || []
      /* 引用没变 = 内容没变（板子的每次改动都会换数组）→ 索引和它那一堆缓存继续用。 */
      if (!ink || strokes !== lastStrokes || groups !== lastGroups) {
        lastStrokes = strokes
        lastGroups = groups
        ink = createInkIndex(strokes, groups)
      }
      return buildLinks(board, ink)
    },
  }
}

/* 板上所有"画出来的连接"。
 * 每一条带着：两端是谁、形状、实际的词、方向、给屏幕用的点（中点放词 / 尖在哪）。
 * **不碰 DOM**，所以能在 node 里断言。
 *
 * ⚠ **internal**：调用方请走 `createLinkReader().read(board)`。这个签名要一个
 *   事先建好的墨迹索引（`inkInput`），那是 module 内部的东西 —— 以前的调用方
 *   必须自己记着"按 strokes/groups 记忆化再传进来"，那正是上面说的那类 bug 的入口。 */
function buildLinks(board, inkInput) {
  const all = (board && board.strokes) || []
  const boxes = ((board && board.cards) || []).map((c) => ({ id: c.id, r: cardBounds(c) }))
  const byId = new Map(all.map((s) => [s.id, s]))
  const chains = joinStrokes(all, JOIN_TOL, (p) => !!cardAt(boxes, p))
  /* ── 第一步分两类，顺序很重要 ──
     **两端各落在一张卡里的链，铁定是连接**（不看形状）——
     它可能是个 V 形（从上方的卡画下去再上来进另一张卡），形状上跟箭头尖一模一样。
     先把它挑出来，它就不再参与"尖"的评选（gatherHeads 的 skip）。
     反过来的顺序会出事：V 形的连接被判成"箭头尖"，整条连接凭空消失 ——
     这正是 check-board [5] 那条老断言当场抓到的。 */
  const connChain = chains.map((ch) => {
    const a = cardAt(boxes, ch.points[0])
    const b = cardAt(boxes, ch.points[ch.points.length - 1])
    return !!(a && b && a.id !== b.id)
  })
  /* ── 第二步：墨迹块（"没成卡的字迹、手画的图"当端点用）──
     ⚠ 顺序在这里很要命：**先挑出"够格当连接线"的笔，再把它们排除掉**。
     连接线的两头是**扎在字迹里**的 —— 留着它做连通判定，两块会被它粘成一块，
     于是"两头在两个不同节点里"永远不成立，自己把自己接没了（第一版就这样，一个都不出）。
     判据用"全板"量（链自己的笔排除在外），块用"去掉候选线之后"的笔来聚。 */
  const ink = inkInput || createInkIndex(all, (board && board.groups) || [])
  const chainOwn = chains.map((ch) => {
    const ex = new Set()
    for (const id of ch.ids) {
      const i = ink.byId.get(id)
      if (i !== undefined) ex.add(i)
    }
    return ex
  })
  const inkOK = chains.map((ch, ci) => (connChain[ci] ? false : inkLinkShapeOK(ch.points, ink, chainOwn[ci])))
  const dropIdx = new Set()
  chains.forEach((ch, ci) => {
    if (inkOK[ci]) {
      for (const id of ch.ids) {
        const i = ink.byId.get(id)
        if (i !== undefined) dropIdx.add(i)
      }
    }
  })
  /* 块是按"排除集"算出来的 —— 排除集一变，缓存就得清（不然会拿到上一版的块）。
     `mainExclude` 是**普通端点查询**用的那一个（别的排除集走 storeFor 给的一次性缓存）。 */
  const dropKey = [...dropIdx].sort((a, b) => a - b).join(',')
  if (ink.dropKey !== dropKey) {
    ink.owner.clear()
    ink.caches.clear()
    ink.dropKey = dropKey
  }
  ink.mainExclude = dropIdx
  /* 一个"节点"= 卡片 或 墨迹块。卡片带 label:''（面板拿 src 显示），块自带 label。 */
  const asCard = (b) => (b ? { kind: 'card', id: b.id, label: '' } : null)
  const nodeAt = (p, pad = 8) => asCard(cardAt(boxes, p, pad)) || inkNodeAt(ink, p, INK_NODE_PAD, INK_BLOCK_GAP, dropIdx)
  const busy = new Set()
  chains.forEach((ch, i) => {
    if (connChain[i]) for (const id of ch.ids) busy.add(id)
  })
  /* 独立的"箭头尖"：不参与任何连接的笔迹，自己是个 V（一笔或两笔拼的）。 */
  const heads = gatherHeads(all, JOIN_TOL, busy)
  const out = []
  for (let ci = 0; ci < chains.length; ci++) {
    const ch = chains[ci]
    /* ★ 「你说了它不是连接」的笔：整条跳过（见 LINK_NONE）。
       放在最前面 —— 它连"两头落在谁身上"都不用判。
       （它仍然会进 dropIdx：那是一根线，不该被聚进旁边那一坨字里。） */
    if (ch.ids.some((id) => isNoLink(byId.get(id)))) continue
    const pts = ch.points
    const first = pts[0]
    const last = pts[pts.length - 1]
    /* 这一头是尖吗？两个来源：
       ① **链自己带的**：一笔画成的（杆 + 回勾），或者杆和尖被接成了一根。
          要求尖挨着某一头 —— 尖装在正中间的是"折线式连接"（L 形），不是箭头。
       ② **旁边一根独立的 V 尖**：尖离这一头够近，而且**顺着这一头往外指**。
          这就是用户的实际画法（一杆 + 一个 V，两笔）。 */
    const own = findTip(pts)
    let tip = null
    let head = null
    if (own && tipNearEnd(own)) tip = own.at
    if (!tip) {
      let bestD = Infinity
      for (const h of heads) {
        const dFirst = Math.hypot(h.at.x - first.x, h.at.y - first.y)
        const dLast = Math.hypot(h.at.x - last.x, h.at.y - last.y)
        const d = Math.min(dFirst, dLast)
        const reach = Math.min(110, Math.max(TIP_PAD, h.arm * 1.6))
        if (d > reach) continue
        const atFirst = dFirst <= dLast
        /* ★ 判"尖顺着往外指"的基准 = 这一头**往外**的方向，不是"端点到尖"的向量。
           实测他总是把杆一路画到尖上 —— 端点和尖重合，那个向量长度是 0，
           既算不出方向，还会把整条 Two-stroke 路线直接丢掉（探针里踩过）。 */
        const outward = endOutward(pts, atFirst)
        if (!outward) continue
        if (outward.x * h.dir.x + outward.y * h.dir.y < 0.3) continue
        if (d > 6) {
          const toTip = unit(atFirst ? first : last, h.at)
          if (toTip && toTip.x * h.dir.x + toTip.y * h.dir.y < 0) continue // 尖跑到线的背后去了
        }
        if (d < bestD) {
          bestD = d
          tip = h.at
          head = h
        }
      }
    }
    if (!tip && !connChain[ci] && !inkOK[ci]) continue // 没尖、两头又没进卡/块 → 不是连接
    /* ── 谁连着谁、朝哪边 ──
       **两头都落在卡里的：a/b 就按你画的方向**（第一点 → 最后一点）。
       这一条不能动 —— ⇄ 的实现就是"把这一笔的点倒过来"，
       而 ⇄ 的全部意义就是让 a/b 换过来（check-board [6d] 那条断言钉着它）。
       只有"尖那一头没落进卡、靠尖指认目标"那一种，才改成"尾巴 → 尖"：
       那种情况本来也只有一个方向说得通（从卡出发、指着另一张卡）。
       ★ 2026-09-16 起端点可以是**墨迹块**（没成卡的字迹、手画的图）。
         规矩两条：① 只要**有一头落在块上**，这一笔就得先过 inkOK 那三道闸；
         ② **卡片优先于块** —— 免得一支箭头指着卡片时，被"尖旁边那两撇墨"
            当成目标（[6e] 的两笔箭头就是这么被抢走的）。 */
    const usable = (na, nb) => {
      if (!na || !nb || na.id === nb.id) return false
      if (na.kind === 'ink' || nb.kind === 'ink') return inkOK[ci]
      return true
    }
    let aNode = null
    let bNode = null
    /* ① 两头都在卡里：铁定是连接，不看形状、也不受这三道闸约束 */
    const ca = cardAt(boxes, first)
    const cb = cardAt(boxes, last)
    if (ca && cb && ca.id !== cb.id) {
      aNode = asCard(ca)
      bNode = asCard(cb)
    }
    /* ② 有尖：靠"尖指着谁"定方向（先在卡片里找，找不到才认墨迹块） */
    if (!aNode && tip) {
      const dToLast = Math.hypot(tip.x - last.x, tip.y - last.y)
      const dToFirst = Math.hypot(tip.x - first.x, tip.y - first.y)
      const tailPt = dToLast > dToFirst ? last : first // 尾巴 = 离尖远的那一头
      const otherEnd = tailPt === first ? last : first
      const na = nodeAt(tailPt)
      /* ★ 尖自己那一坨墨**不算目标**：他画的箭头是"杆 + 两撇"，那两撇就在尖旁边，
         不排除的话"尖指着谁"会指到自己的箭头尖上（实测：会连成 杆→自己那个 V）。
         排除的是：链自己的笔 + gatherHeads 挑出来的那个尖的笔。 */
      const tipEx = new Set(dropIdx)
      for (const ids of [ch.ids, head ? head.ids : []]) {
        for (const id of ids) {
          const i = ink.byId.get(id)
          if (i !== undefined) tipEx.add(i)
        }
      }
      /* 兜底那条也用**同一个排除集 + 同一个缓存键**：不然"我这一笔的另一头"
         会撞上我自己画的箭尖，于是目标变成箭头自己（实测过）。 */
      const tipKey = 'h:' + ch.ids.join('+') + '|' + (head ? head.ids.join('+') : '')
      const nb =
        asCard(cardAt(boxes, tip)) ||
        asCard(nearestCard(boxes, tip, TIP_PAD)) ||
        inkNodeAt(ink, tip, TIP_PAD, INK_BLOCK_GAP, tipEx, tipKey) ||
        asCard(cardAt(boxes, otherEnd)) ||
        inkNodeAt(ink, otherEnd, INK_NODE_PAD, INK_BLOCK_GAP, tipEx, tipKey)
      if (usable(na, nb)) {
        aNode = na
        bNode = nb
      }
    }
    /* ③ 没有尖：两头各落在谁身上（卡片或墨迹块 —— 块那条要过闸）
       ★ 这一条**只在没尖的时候**走。有尖的链必须由"尖指着谁"定目标：
         否则轮到这一条时，它会拿**这一笔的末端**去找块 —— 而末端正贴着
         他自己画的那个箭尖，于是目标变成箭头自己（实测：一条竖笔 + 两撇
         被读成"卡 → 那两撇"，`ink:smu3re2y15b`）。 */
    if (!aNode && !tip) {
      const na = nodeAt(first)
      const nb = nodeAt(last)
      if (usable(na, nb)) {
        aNode = na
        bNode = nb
      }
    }
    if (!aNode || !bNode) continue
    /* 屏幕上的 from→to 一律指向尖（有尖时）/ 顺着你画的方向（没尖时）。 */
    const toPt = tip || last
    const fromPt =
      tip && Math.hypot(tip.x - first.x, tip.y - first.y) < Math.hypot(tip.x - last.x, tip.y - last.y)
        ? last
        : first

    /* 手动标过的词：挂在链里**任意一笔**上都算（框选改词改在的是那一笔上）。 */
    const manualStroke = ch.ids.map((id) => byId.get(id)).find((s) => s && isLinkKind(s.link))
    /* ★ 只有"尖挨着一头"才算箭头（`tip`）；`own` 是"链上任意位置有尖"，
       装在正中间的是折线式连接（L 形），它不该被读成因果。 */
    const shape = tip || backHook(pts) ? 'arrow' : 'line'
    const auto = shape === 'arrow' ? ARROW_LINK : DEFAULT_LINK
    const kind = manualStroke ? manualStroke.link : auto
    const meta = linkKind(kind)
    const u = unit(fromPt, toPt)
    const midInk = chainMid(pts)
    out.push({
      strokeId: ch.ids[0],
      ids: ch.ids.slice(),
      a: aNode.id,
      b: bNode.id,
      /* 两端各是什么：'card' | 'ink'。面板要按这个决定显示 src 还是"墨迹块（N 笔）"；
         块还有 label（卡片没有 —— 它的名字在 src 里）。 */
      aKind: aNode.kind,
      bKind: bNode.kind,
      aLabel: aNode.label || '',
      bLabel: bNode.label || '',
      shape,
      kind,
      auto,
      manual: !!manualStroke,
      dir: meta.dir,
      color: meta.color,
      name: meta.name,
      /* ★ 尖是你自己画上去的 → 屏幕上**不要再合成一个箭头**压在它上面。
         实测出来的头一条事实就是"墨迹一直画到尖上"，这条跟着它走。 */
      headInk: !!tip,
      headIds: head ? head.ids.slice() : tip ? ch.ids.slice() : [],
      tip: tip ? { x: tip.x, y: tip.y } : null,
      angle: u ? Math.atan2(u.y, u.x) : 0,
      mid: { x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2 },
      /* 线**弧长**的中点（`mid` 是两端点的中点，两者常常不是同一个地方）——
         条件就是从这里周围读出来的。 */
      midInk,
      /* 这条关系的条件（`{kind:'ink'|'card', id, ids, label, at}` 或 null）。
         ⚠ 它是在下面**第二趟**填的（见 `linkStrokeIdx`）：要排除"所有成为连接的链"的笔，
           而那件事得等第一趟把链都定下来才知道。 */
      cond: null,
      from: { x: fromPt.x, y: fromPt.y },
      to: { x: toPt.x, y: toPt.y },
    })
  }
  /* ── 第二趟：条件从位置送 ──
     ★ 为什么放第二趟：条件要排除**所有成为连接的链**的笔 ——
       别的连接线不是"内容"，不该被当成某条关系的条件。
       实测：两条卡片连线交叉时，"那条交叉的线"会被读成对方的条件。
       而"哪些链成了连接"要等第一趟把端点都解完才知道，所以只能第二趟算。
     条件用**弧长中点**（不是两端点的中点），排除集 = 候选线 ∪ 所有成为连接的链。 */
  const linkStrokeIdx = new Set(dropIdx)
  for (const l of out) {
    for (const id of l.ids) {
      const i = ink.byId.get(id)
      if (i !== undefined) linkStrokeIdx.add(i)
    }
  }
  for (const l of out) {
    l.cond = linkCondition(
      ink,
      boxes,
      l.midInk,
      linkStrokeIdx,
      { kind: l.aKind, id: l.a },
      { kind: l.bKind, id: l.b },
      'c:' + l.ids.join('+')
    )
  }
  return out
}

/* 和这一笔**接成同一条线**的所有笔（判据就是 `joinStrokes` 那条）。
 * 为什么需要它：`link: 'none'`（"不算连接"）是写在**整条链**上的（applyLink 就是这么写的），
 * 那么恢复的时候也必须按**链**清 —— 只清框住的那一笔，链里还剩一笔 none，
 * `buildLinks` 仍然整条跳过，用户点「又算回连接」就像没反应（审查挑出来的）。 */
export function chainOfStroke(board, strokeId) {
  const all = (board && board.strokes) || []
  const boxes = ((board && board.cards) || []).map((c) => ({ id: c.id, r: cardBounds(c) }))
  const chains = joinStrokes(all, JOIN_TOL, (p) => !!cardAt(boxes, p))
  const hit = chains.find((ch) => ch.ids.includes(strokeId))
  return hit ? hit.ids.slice() : [strokeId]
}

/* 白板的文件里其实是 JSON —— 但仍然叫 .md。
   为什么：① 现有服务、备份脚本、Git 流程都按 *.md 走，改后缀就是改了四处；
   ② 万一哪天想手改或想让别的 AI 读，"一个开头是 { 的 .md" 比二进制好救；
   ③ 文件名前缀 board- 让列表一眼能分开白板和笔记。
   解析失败的兜底是"给一张空板"，不是抛错——打不开比丢内容更糟。 */

/* `inkedEdges(board)` 删掉了（2026-09-16）。它只是 `buildLinks` 的一行**薄壳**
 * （老接口，只要 a/b/strokeId），而 deletion test 的答案很清楚：删掉它，复杂度并没有
 * 散到调用方去 —— 关系面板要的那份"哪两张卡之间有笔迹"直接从 `links` 派生就行
 * （Board.jsx 早就是这么干的）。留着它只会多一个能绕过 `createLinkReader()` 的入口。 */
