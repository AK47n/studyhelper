/* ═══════════ 连接读法 ═══════════
 *
 * 「板上那些连接连着谁、是什么关系、条件是什么、能不能串成推导链」。
 *
 * ── 2026-09-17 第二刀：这里砍掉了**一大半**（ADR-0001）────────────────────
 * 砍掉的是"从笔迹形状里猜箭头"那一族（`findTip` / `classifyLinkShape` / `gatherHeads` /
 * 回勾 / 接笔 / 墨迹块当端点 + 三道闸）。理由不是觉得它写得不好，是**它在真笔迹上不成立**：
 * 拿他三张板（494 / 439 / 620 笔）量，判成"箭头"的 92 条笔迹里**没有一条像箭头**
 * （直度中位 0.28；张开角中位 ~20°，而真人手画的箭头是杆 51~59px 笔直、张开 107°）——
 * `findTip` 认下来的是汉字折笔的拐角；三张板读出来的连接都是 **0 条**。
 * 于是"连接从哪来"换了来源：**你宣告**（箭头工具）或者**你画在两张卡之间**（下面那条免费路）。
 *
 * 现在这个 module 只剩三件事：
 *   ① **你画出来的连接**（`buildLinks`）：一笔线，两头各落在一张卡里。不看形状 ——
 *      这样出来的词一律是「相关」，想改就点那排词（`stroke.link` 存你改过的那个词）。
 *   ② **你宣告的连接**（`readDeclaredLinks` + `board.links`）：两端是卡片或板框，
 *      屏幕上那条线和尖是**应用画的**。
 *   ③ **条件**：写在线**弧长中点**旁边那几个字 / 那张卡自动成为这条关系的条件
 *      （`linkCondition`）。位置会读错、也会读不到，所以配了两个手动口子（见 link-kinds.js）。
 *      这一族需要"那撮字算一块"的**最小聚类**（`createInkIndex` / `inkNodeAt`），
 *      所以墨迹块没有全删，只服务条件这一件事 —— 它不再当端点。
 *
 * 对外的 interface 还是那一个：
 *
 *     const reader = createLinkReader()
 *     reader.read(board)        // → links[]（两族合一）
 *
 * 其余导出分两类：
 *   · `deriveChains` —— 面板要把「推导」那几条串成链；
 *   · 标着 **internal seam** 的（`createInkIndex` / `inkNodeAt` / `inkBlocks` / 各阈值）——
 *     只给这个 module 自己的测试用。调用方别走。
 */

import { cardBounds, rectCenter, toFlat, toPoints } from './geometry.js'
import { linkId } from './board.js'
import { CARD_HIT_PAD, COND_SEARCH, edgeDist, edgePointOf, nodeAt, nodeById } from './nodes.js'
import {
  ARROW_LINK, DEFAULT_LINK, LINK_KINDS, isLinkKind, linkKind, parseCond,
} from './link-kinds.js'

/* ═══════════ 小工具 ═══════════ */

function unit(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const n = Math.hypot(dx, dy)
  return n < 1e-6 ? null : { x: dx / n, y: dy / n }
}

function arcLen(pts) {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return s
}

/* 从矩形中心朝 `towards` 射出去、打在矩形边上的那一点 —— 现在住在 `nodes.js`
   （`edgePointOf`）：那是"端点"这一层的几何，"线贴在框边上"是所有连接共用的规矩。
   （原来这里有一份私有实现，links.js 与 readDeclaredLinks 各用一次。） */

/* 点落在哪张卡里（宽容 `CARD_HIT_PAD`）—— 从前这里是 `cardAt`，现在走 `nodes.js` 的
   `nodeAt(board, p, { kinds: ['card'], pad })`（见 buildLinks 里那两行）。
   两处都删掉的原因：同一句"这一点落在谁身上"，五个地方各答一遍 —— 见 README 第 40 条。 */

/* ═══════════ 墨迹块：只为「条件」而留 ═══════════
 *
 * ⚠ 第二刀之前，墨迹块还有第二个身份：**连接的端点**（"没成卡的字迹、手画的图也能连"）。
 *   那个身份连同三道闸一起砍了（ADR-0001）：判据在真笔迹上 92:0。
 *   现在它只服务一件事 —— 认出"写在这条线**中点旁边**的那几个字"，
 *   因为条件常常就是随手写在旁边的一撮字，不是一张卡。
 *   `frames`（你留过板框的那些）仍然优先：框住的字从此刻起是一块，
 *   哪怕它跟旁边那坨挨得很近（"你说它是东西它就是"）。 */

export const INK_BLOCK_GAP = 24      // 笔与笔这么近（世界像素）算同一块
export const INK_NODE_PAD = 12       // 点离块的墨这么近，算"落在这块里"
export const INK_NODE_MIN_SIZE = 18  // 一块墨的"最小个头"（包围盒对角线）：比这小的不算"一个东西"

/* 宣告的连接那条合成线，两端离框/卡的边留多宽（世界像素）。
   世界像素而不是屏幕像素：它和框一样是板上的东西，缩放时该跟着一起放大
   （屏幕上看着"箭头离框总是那么一点"，放大之后才发现贴上了，那就是两套单位混了）。 */
export const LINK_GAP = 6

/* 那条线的弧度（横向偏移 = 两端距离 × 这个系数）。
   0.05 ≈ 5%：看得出是"画出来的一笔"，但仍然是"两点之间那条线"。
   为什么不留成纯直线：两张卡之间的箭头一多，纯直线挤在一起像电路板；
   一点点弧度让每一条都认得出来（关系面板里那些曲线也是同一路数，见 geometry.js 的 relationCurve）。 */
export const LINK_BOW = 0.05

/* 「条件是位置送的」：线**中点**这么近的地方写着的字（或那张卡）就是这条关系的条件。 */
/* 条件搜索半径 —— **就是 `nodes.js` 的 `COND_SEARCH`**（64 世界像素）。
   保留这个名字是因为外面（README、这条自检）叫惯了它；值只在一处定义。 */
export const LINK_COND_RADIUS = COND_SEARCH

const INK_CELL = 32 // 空间格子边长（查"附近有没有墨"用）
/* ⚠ 32 是从 HEAD 那一版原样搬过来的，别顺手改：它不只决定"扫几圈"，
   还决定**同一个格子里点的顺序** —— 而 `inkNodeAt` 是"按种子顺序找第一个 fixed 块"，
   所以"同一个点上先撞见哪一块"是受它影响的（自检 [6h] 有一条断言正好钉在这个边界上：
   两坨只差 6px，查询点离两坨都 ≤ INK_NODE_PAD）。 */

/* 格子键用**数字**，不用 "x,y" 字符串：这段每次 commit 都要跑，
   几百笔的板上字符串拼接和 Map 查找都是白花的钱（实测过）。 */
function inkKey(cx, cy) {
  return (cx + 100000) * 1000000 + (cy + 100000)
}

/* ── 建一次空间索引：每笔一个条目（点列），每个点进一个格子 ──
 *
 * 为什么要有缓存：这是每次 commit 都要跑的（拖卡片、画一笔都会重算连接），
 * 620 笔的板上没有索引要 26ms，有索引 30ms 里能跑完 buildLinks + 条件两趟。
 * 调用方要"按 strokes / frames 的**引用**记忆化再传进来"—— 那件事已经收进
 * `createLinkReader` 了（见那个函数上的说明）。
 *
 * ⚠ **internal seam**：只给这个 module 自己的测试用（`check-board` 里缓存那几条）。
 */
export function createInkIndex(strokes, frames = []) {
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
    /* 你**留过板框**的那些块（见 frames.js）：它们的成员从自动聚类里剔出去。
       ★ 单独放一个 Map，**绝不能挂在 `owner` 上**：`owner` 是"候选线"那套缓存，
         `dropKey` 一变就会被清掉（而 `dropKey` 一开始是 undefined，
         所以第一次 buildLinks 就会把它清光）—— 挂在那上面等于板框从来没生效过：
         本来连得上的连接会消失、把相隔很远的两坨框成一块还会**凭空造出一条连接**。
         （这条是 2026-09-16 让独立审查挑出来的；自检当时只直接问了 inkNodeAt，
           没走 buildLinks，所以漏过了 —— 补的断言必须走 buildLinks。） */
    fixed: new Map(),
    groupIdx: new Set(),
  }
  for (const f of Array.isArray(frames) ? frames : []) {
    const ids = []
    for (const id of (f && f.ids) || []) {
      const i = index.byId.get(id)
      if (i !== undefined) ids.push(i)
    }
    if (!ids.length) continue
    const node = {
      kind: 'ink',
      id: 'frm:' + (f.id || ids.map((i) => index.list[i].id).sort()[0]),
      ids: ids.map((i) => index.list[i].id),
      /* 有标题就用你的话（"这一节是什么"），没有就说清楚它是一块板框。
         这一行是面板上"连着谁"那一栏显示的字 —— 你自己起的名字比"固定的块（7 笔）"有用得多。 */
      label: f.title ? String(f.title) : `板框（${ids.length} 笔）`,
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
   超过 max 就不再往外找（返回 max+1）—— 调用方只关心"够不够远"。 */
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

/* 从这几笔出发，把"笔与笔 ≤ gap"连着的笔全聚起来（连通分量）。 */
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
 *
 * ⚠ 第二刀之后**只有条件那一族**问这个函数（连接的端点只用卡片，见 buildLinks）。
 *   留着它是因为"条件常常是随手写在旁边的一撮字"—— 那一撮字得先被认成"一块"。
 * ⚠ **internal seam**：块、排除集、缓存键都是 module 内部的东西，只给自检用。 */
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
  /* ★ **你留过板框的那些块**（`frames`）永远优先，而且不看 store：
     它们在 `index.fixed` 里 —— 和排除集无关、`owner` 被清也不受影响
     （"你说它是东西它就是"）。不先查这一下，板框在 buildLinks 里就完全失效了。 */
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
     ⚠ 你**亲手留过板框**的块不走这条 —— 它在上面那个 owner 循环里就返回了
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

/* 这次查询该用哪个缓存：
   · 没给排除集 → `owner`（最常用，跟着 dropKey 一起清）；
   · 给了排除集和缓存键 → 那个键专属的小 Map（同一个键重复问是常态：「尖指着谁」按笔画组合缓存）；
   · 给了排除集但没给键 → 不缓存（正确但慢，宁可慢也别串味）。 */
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

/* 板上所有的墨迹块：你**留过板框的**先出（`frames`），然后是自动聚出来的。
   给自检看"板上有哪几块"的。 */
/* ⚠ **internal seam**（同上）。 */
export function inkBlocks(strokes, { gap = INK_BLOCK_GAP, frames = [] } = {}) {
  const index = createInkIndex(strokes, frames)
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
 * 用户的原话：「条件是位置送的。线中点附近那几个字 / 那张卡，自动成为这条关系的条件
 * —— 你本来就要写"仅当…"，不用再告诉它是谁的条件。」
 *
 * 三条规矩（都是踩出来的）：
 *   · **只看中点周围 `LINK_COND_RADIUS`**（64 世界像素）—— 太远就跟这条线没关系了；
 *   · **卡片优先于墨迹块**：一张卡压在字上面时，那个"东西"是卡，不是底下那撮字；
 *   · **这条线自己的笔、以及它两端的那两个东西都不算条件** —— 那是关系本身的两头。
 *     （实测：不排除的话，每条推导线都会把自己当成自己的条件。）
 * ⚠ 条件**不存盘**：位置现算，挪走那几笔条件就没了。只有你亲口说的那三种值才写
 *   （见 link-kinds.js 的 parseCond 与下面 resolveCondSpec）。 */
function linkCondition(ink, boxes, mid, exclude, aNode, bNode, cacheKey = '') {
  if (!mid) return null
  /* 半径内的卡**按距离试**，跳过这条关系两端的卡 ——
     ⚠ 不能只看"最近的那一张"：最近那张要是端点卡，真正的条件卡就被整体漏掉了
     （实测：端点卡 60px、条件卡 62px，两个都在 64px 内 → 条件读成 null）。
     ★ 距离公式走 nodes.js 的 `edgeDist`（它 = geometry.rectDist 的零尺寸矩形情形）——
       这条公式从前在三个文件里各内联一份。半径也只有一个名字：COND_SEARCH。 */
  const skip = new Set([aNode && aNode.id, bNode && bNode.id].filter(Boolean))
  let card = null
  let cd = Infinity
  for (const b of boxes) {
    if (skip.has(b.id)) continue
    const r = b.r
    const d = edgeDist(r, mid)
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
 * 面板把「推导」那几条连接串起来读成一条链，并标出**哪一步缺条件** ——
 * 补条件就是"在线旁边把那句话写上"，写完这一节自己就更新。
 * 分叉要**每条路都走**（只取第一条出边的话，B→D 那条分支会整条消失）；
 * 环用"这条路上已经走过的节点"挡住，到上限标记 truncated（面板要说"只显示前 N 步"）。 */
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

/* ── 连接读法：这个 module 的 **interface** ──
 *
 * 调用方（app 和自检）只该用这一个入口：
 *
 *     const reader = createLinkReader()
 *     reader.read(board)          // → links[]
 *
 * 索引、墨迹块、条件、推导链**都在它后面**：谁按什么记忆化、排除集怎么算、
 * 缓存什么时候失效，全是它自己的事。
 *
 * ★ 为什么要有这一层（2026-09-16 收的口）：在那之前调用方得自己
 *   `createInkIndex(strokes, groups)` 再把它传给 `buildLinks(board, index)` ——
 *   于是"什么时候重建索引""排除集变了要不要清缓存"这些**内部纪律**变成了
 *   调用方必须知道的知识；而自检干脆绕过 `buildLinks` 直接去问 `inkNodeAt`。
 *   结果就是"怎么被调用"这一层两类测试都盖不住：固定块因为被清掉缓存而**整个失效**
 *   那条严重 bug 正是这么漏过去的。
 *   `read()` 每次自己判断要不要重建（按 `strokes`/`frames` 的**引用**比），
 *   所以调用方连"有索引这回事"都不需要知道。 */
export function createLinkReader() {
  let ink = null
  let lastStrokes = null
  let lastFrames = null
  return {
    read(board) {
      const strokes = (board && board.strokes) || []
      const frames = (board && board.frames) || []
      /* 引用没变 = 内容没变（板子的每次改动都会换数组）→ 索引和它那一堆缓存继续用。 */
      if (!ink || strokes !== lastStrokes || frames !== lastFrames) {
        lastStrokes = strokes
        lastFrames = frames
        ink = createInkIndex(strokes, frames)
      }
      /* 两族合一：你**画出来**的（`buildLinks`）+ 你**宣告**的（`board.links`）。
         面板、那排词、箭头渲染都只认这一种对象 —— 区别在 `declared`。 */
      return [...buildLinks(board, ink), ...readDeclaredLinks(board, ink)]
    },
  }
}

/* ═══════════ 你画出来的连接 ═══════════
 *
 * 第二刀之后这条路上只剩**一件事**：一笔线，两头各落在一张卡里 → 一条连接。
 *   · **不看形状**（形状判据整族删了，见文件头）：这样出来的词一律是「相关」；
 *     想表达"因果/推导/并列/等价"，点那排词改一下（存进 `stroke.link`）。
 *   · **不管墨迹块**（它不再当端点）：端点只有卡片 —— 或者你用箭头工具，
 *     那条路还能连板框和手写（`readDeclaredLinks`）。
 *   · 两边都是**同一张卡** → 不算连接（那是你在卡里画了一笔）。
 * 一句话：**这条路是免费的** —— 你已经在画的关系，不用再宣告一次。
 *
 * ⚠ **internal**：调用方请走 `createLinkReader().read(board)`。
 *   这个签名要一个事先建好的墨迹索引（`inkInput`），那是 module 内部的东西。 */
function buildLinks(board, inkInput) {
  const all = (board && board.strokes) || []
  const boxes = ((board && board.cards) || []).map((c) => ({ id: c.id, r: cardBounds(c) }))
  const byId = new Map(all.map((s) => [s.id, s]))
  const ink = inkInput || createInkIndex(all, (board && board.frames) || [])
  const out = []
  /* 成了连接的那些笔：条件那一趟要把它们排除掉 ——
     别的连接线不是"内容"，不该被当成某条关系的条件（实测：两条卡间连线交叉时，
     那条交叉的线会被读成对方的条件）。 */
  const linkStrokeIdx = new Set()
  for (const s of all) {
    if (!s || s.tool === 'highlighter') continue
    const pts = toPoints(s.points)
    if (pts.length < 2) continue
    const first = pts[0]
    const last = pts[pts.length - 1]
    /* 免费路：两头各落在**一张卡片**里（宽容 CARD_HIT_PAD）——
       判据住在 nodes.js（"这一点落在谁身上"那一层），这里不再自己写一份 pointInRect。 */
    const ca = nodeAt(board, first, { kinds: ['card'], pad: CARD_HIT_PAD })
    const cb = nodeAt(board, last, { kinds: ['card'], pad: CARD_HIT_PAD })
    if (!ca || !cb || ca.id === cb.id) continue
    /* 手动标过的词：你点过那排词就有（`stroke.link`），否则「相关」。 */
    const manualStroke = isLinkKind(s.link) ? s : null
    const kind = manualStroke ? manualStroke.link : DEFAULT_LINK
    const meta = linkKind(kind)
    const u = unit(first, last)
    const midInk = chainMid(pts)
    const i = ink.byId.get(s.id)
    if (i !== undefined) linkStrokeIdx.add(i)
    out.push({
      id: linkId(ca.id, cb.id),
      declared: false,
      strokeId: s.id,
      ids: [s.id],
      a: ca.id,
      b: cb.id,
      aKind: 'card',
      bKind: 'card',
      aLabel: '',
      bLabel: '',
      /* 形状不读了 → 一律 'line'。留着这个字段是因为面板/自检还在问它
         （"你画的那条线"和"你连的箭头"长得不一样）。 */
      shape: 'line',
      kind,
      auto: DEFAULT_LINK,
      manual: !!manualStroke,
      dir: meta.dir,
      color: meta.color,
      name: meta.name,
      /* 你自己画的尖也没有了（不读形状了）→ 有方向的词一律由应用补一个尖。
         从前这里是 `!!tip`，那条"一支箭上长两个头"的顾虑随之消失。 */
      headInk: false,
      headIds: [],
      tip: null,
      angle: u ? Math.atan2(u.y, u.x) : 0,
      /* 词放在**两端的中点**上（这一条是直的）——`mid` 和条件用的弧长中点
         在一条直线上是同一个地方，但弯线的可能不同，所以两个都留着。 */
      mid: { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 },
      midInk,
      /* 方向：**第一点 → 最后一点**（你画的顺序）。⇄ 反向 = 把点倒过来，靠的就是这条。 */
      from: { x: first.x, y: first.y },
      to: { x: last.x, y: last.y },
      cond: null,
      condManual: false,
      condSpec: null,
    })
  }
  /* ── 第二趟：条件 ──
     链上挂着的那句话（`stroke.cond`）：挂在**任意一笔**上就生效 —— 和手动改词同一个口径。
     一个字段只能有一个值，所以"否决"和"指定"不可能互相打架。 */
  const manualCondOf = (l) => {
    for (const id of l.ids) {
      const s = byId.get(id)
      const parsed = s ? parseCond(s.cond) : null
      if (parsed) return parsed
    }
    return null
  }
  for (const l of out) {
    /* ★ 你说过的话优先于位置：
       · `'none'`（这个条件不算）→ **别再读**（cond 留 null）；
       · `'card:<id>'` / `'ink:<id>'`（就是它）→ 直接用你指的，不看中点旁边有什么。
       读不出来（指的那张卡/那笔已经没了）→ 当没说过，回到按位置读。
       `condManual` 给面板用：它要显示"你说过的"并给一条回头路 ——
       不然那些话就是单向门（点完只能 Ctrl+Z，重开之后没路可走）。 */
    const spec = manualCondOf(l)
    let manual = null
    if (spec && spec.kind === 'none') manual = { kind: 'none' }
    else if (spec) {
      const resolved = resolveCondSpec({ spec, ink, cards: boxes, byId, mid: l.midInk, cacheKey: 'mc:' + spec.id })
      if (resolved) manual = { kind: 'spec', cond: resolved, spec }
    }
    l.condManual = !!manual
    l.condSpec = manual && manual.kind === 'spec' ? manual.spec : null
    l.cond = manual
      ? manual.kind === 'spec'
        ? manual.cond
        : null
      : linkCondition(
          ink,
          boxes,
          l.midInk,
          linkStrokeIdx,
          { kind: 'card', id: l.a, ids: [] },
          { kind: 'card', id: l.b, ids: [] },
          'c:' + l.ids.join('+')
        )
  }
  return out
}

/* ── 「你亲手指的那个条件」的解析（笔迹版和宣告版共用这一份）──────────────
 * 卡片直接用 id（面板自己会去 board.cards 里取名字）；某一笔要先问索引
 * "它属于哪一撮字"（块是现算的）；索引给不出来（太小、或者那笔已经没了）就退回
 * "这一笔自己" —— **你说过的话要算数**，不能因为算法觉得它太小就丢掉。
 * `at` 只给诊断用（浮层和连线都用不上它）。 */
function resolveCondSpec({ spec, ink, cards, byId, mid, cacheKey }) {
  if (!spec) return null
  if (spec.kind === 'card') {
    const known = (cards || []).some((c) => c.id === spec.id)
    return known ? { kind: 'card', id: spec.id, ids: [], label: '', at: mid } : null
  }
  if (spec.kind === 'ink') {
    const st = byId.get(spec.id)
    if (!st) return null
    const p = toPoints(st.points)[0]
    if (!p) return null
    const node = ink ? inkNodeAt(ink, p, INK_NODE_PAD, INK_BLOCK_GAP, null, cacheKey || 'mc:' + spec.id) : null
    if (node) return { kind: 'ink', id: node.id, ids: node.ids.slice(), label: node.label, at: p }
    return { kind: 'ink', id: spec.id, ids: [spec.id], label: '墨迹块（1 笔）', at: p }
  }
  return null
}

/* ═══════════ 宣告的连接（`board.links`，见 ADR-0001）═══════════
 *
 * 这些连接**没有那一笔**：你划一笔只是"指了哪两样东西"，屏幕上那条线是**应用画的**。
 * 所以几何全部现算：两端取**节点框的边**（不是中心）→ 一条规整的线 + 一个尖；
 * 框一动、卡一挪，线自己跟着走 —— 这正是"连接两个板块"该有的样子
 * （存一条手画的路径反而会把箭头钉死在原地）。
 *
 * ★ 输出故意和"画出来的连接"**同一种形状**（面板、那排词、箭头渲染只认一种对象），
 *   区别只在几个字段：`declared: true`、`strokeId: null`（删它 = 删那条记录，不是擦一笔）。
 * ⚠ 条件（`rec.cond`）这里只认**你说过的**那两种说法（不算 / 就是它）。
 *   "写在中点旁边那几个字"那条位置读法要排除所有连接的笔，那是 `buildLinks` 第二趟的事，
 *   等箭头工具和它合流时再补（记在 README 的"还没做的"里）。
 */
export function readDeclaredLinks(board, ink) {
  const byId = new Map(((board && board.strokes) || []).map((s) => [s.id, s]))
  /* 两端按 id 取节点：判据（卡片 / 板框、框的成员全没了就不画）住在 nodes.js 一处 */
  const nodeFor = (id) => nodeById(board, id)
  const out = []
  for (const rec of (board && board.links) || []) {
    const na = nodeFor(rec.from)
    const nb = nodeFor(rec.to)
    if (!na || !nb) continue
    const p0 = rectCenter(na.box)
    const p1 = rectCenter(nb.box)
    const from = edgePointOf(na.box, p1)
    const rawTo = edgePointOf(nb.box, p0)
    const u0 = unit(from, rawTo)
    /* 尖停在框边上再让开一点点（LINK_GAP）：贴死看着像"插进卡片里"。 */
    const to = u0 ? { x: rawTo.x - u0.x * LINK_GAP, y: rawTo.y - u0.y * LINK_GAP } : rawTo
    const u = unit(from, to)
    /* 那条线的控制点（二次曲线）：中点 + 法线方向让开 LINK_BOW —— 见常量上的说明。
       尖的方向取**末端切线**（二次曲线的末端切线 = 控制点 → 端点），
       不然弧度一大，"尖"和线就对不上了（小弧度看不出来，但那是错的）。 */
    const dx = to.x - from.x
    const dy = to.y - from.y
    const ctrl = { x: (from.x + to.x) / 2 - dy * LINK_BOW, y: (from.y + to.y) / 2 + dx * LINK_BOW }
    const tangent = unit(ctrl, to) || u
    const kind = isLinkKind(rec.kind) ? rec.kind : ARROW_LINK
    const meta = linkKind(kind)
    /* 词放在**曲线的中点**上（t=0.5：Q(0.5) = ¼P₀ + ½C + ¼P₁），不是两端的中点 ——
       带着弧度时那两个点差得开，词会浮在线的旁边。 */
    const mid = {
      x: from.x * 0.25 + ctrl.x * 0.5 + to.x * 0.25,
      y: from.y * 0.25 + ctrl.y * 0.5 + to.y * 0.25,
    }
    const spec = parseCond(rec.cond)
    let cond = null
    let condSpec = null
    let condManual = false
    if (spec && spec.kind === 'none') condManual = true
    else if (spec) {
      const resolved = resolveCondSpec({ spec, ink, cards, byId, mid, cacheKey: 'dc:' + linkId(rec.from, rec.to) })
      if (resolved) {
        condManual = true
        condSpec = spec
        cond = resolved
      }
    }
    out.push({
      id: linkId(rec.from, rec.to),
      declared: true,
      strokeId: null,
      ids: [],
      a: rec.from,
      b: rec.to,
      aKind: na.kind,
      bKind: nb.kind,
      aLabel: na.label,
      bLabel: nb.label,
      shape: 'arrow',
      kind,
      auto: kind,
      manual: true,
      dir: meta.dir,
      color: meta.color,
      name: meta.name,
      /* 尖是**应用画**的（你自己没画过）—— 所以这条永远是 false，
         屏幕上的箭头由 BoardCanvas 的 .bd-linkline 那一层合成（见 ADR-0001）。 */
      headInk: false,
      headIds: [],
      tip: meta.dir ? { x: to.x, y: to.y } : null,
      angle: tangent ? Math.atan2(tangent.y, tangent.x) : 0,
      mid,
      midInk: mid,
      from,
      to,
      ctrl,
      cond,
      condManual,
      condSpec,
    })
  }
  return out
}

/* 白板的文件里其实是 JSON —— 但仍然叫 .md。
   为什么：① 现有服务、备份脚本、Git 流程都按 *.md 走，改后缀就是改了四处；
   ② 万一哪天想手改或想让别的 AI 读，"一个开头是 { 的 .md" 比二进制好救；
   ③ 文件名前缀 board- 让列表一眼能分开白板和笔记。
   解析失败的兜底是"给一张空板"，不是抛错——打不开比丢内容更糟。 */

/* 第二刀删掉的那些（2026-09-17，ADR-0001）——
 * `findTip` / `tipNearEnd` / `endOutward` / `readArrowHead` / `backHook` / `classifyLinkShape` /
 * `autoLinkKind` / `gatherHeads` / `tryPairHead` / `walkSpan` / `joinStrokes` / `chainOfStroke` /
 * `inkLinkShapeOK` 加上 TIP_* / ARMS_SPAN / HEAD_ARM_MAX / STRAIGHT_DEG / JOIN_TOL /
 * INK_LINK_MIN_LEN / INK_LINK_MID_GAP 这些阈值：**一个调用者都没有了**。
 * 为什么删得这么干脆：它们的误报率是 92:0（三张真板），而留着就是"两份真相" ——
 * 下一个人会以为"形状还能读出来"，然后在某个角落里把它接回去。
 * 想回顾它们的形状和那两条判据，看 git 历史里的这一版之前那一版。 */
