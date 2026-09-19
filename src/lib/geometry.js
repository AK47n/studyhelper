/* 点、几何、以及「关系怎么算出来」—— 白板这一侧的**纯数学**。
 *
 * 为什么单开一个 module（2026-09-16 架构 review 的 C5）：
 *   这些原来都住在 board.js 的末尾（三节：点的读写 / 几何 / 关系）。而 board.js
 *   是"一张板长什么样、怎么读写"的那个文件 —— 想改一行包围盒，得翻过 500 行
 *   数据模型和卡片排布；反过来想看清"卡片有哪些字段"，又会被 300 行数学挡住。
 *   两边其实谁也不依赖谁：数据模型只用得上 `toFlat`（把所有入口的点收敛成扁平数组），
 *   这边一个东西都不从那边拿（关系那两个阈值 NEAR_GAP / CONTAIN_RATIO 也跟着过来了 ——
 *   留在 board.js 里就会变成环）。
 *
 * 谁在用：`ink.js` / `links.js` / `ocr.js` / `selection.js` / `Board.jsx` /
 * `BoardCanvas.jsx` / `WritingPad.jsx`，以及几乎每一条纯逻辑自检。
 * ⚠ 口径两条（都踩过，见下面各自的注释）：
 *   · 点只有一种格式：**扁平 number 数组** `[x,y,p, …]`；`toPoints`/`toFlat` 必须互相容错；
 *   · 这里全是**世界坐标**（屏幕 = 世界 × s + t 那一份实现在 `view.js`）。
 */
/* fitView 要用视图那一份实现里的两件：缩放归一 + "把某个点摆进容器中心"。 */
import { centerOn, clampViewScale } from './view.js'

/* 关系判定的距离阈值，单位是**世界坐标像素**。
   为什么是 26：这是"手画的时候看起来连着、但其实没碰到"的典型间距。
   调大 → 会把无关的卡片连起来（误连比漏连更讨厌，因为它看起来像你说过的话）。 */
export const NEAR_GAP = 26
export const CONTAIN_RATIO = 1.4 // 大框包住小框：面积比超过这个数才算"包含"，否则算"重叠"

// ─────────────────────────────── 点的读写 ───────────────────────────────
/* 点存成一个**扁平的 number 数组** [x0,y0,p0, x1,y1,p1, ...]，不是 [{x,y,p}]。
   原因很实在：一个 60 点的笔画，对象形式在 JSON 里是 ~1800 字节，
   扁平数组是 ~400 字节。一节课画几百笔，差的是一整个数量级的文件大小。
   代价是读写都要经过 toPoints/点数 这两个函数——所以别在别处手搓下标。

   ⚠ 这一对函数**必须互相容错**，这是踩过的坑：
   toFlat 写出的是扁平数组，但原先的 toPoints 只认对象数组，
   于是「读进来的 → 原样再存一次」这一步会把 120 个点全变成 0。
   而且不报错、文件看着还是好的——纯粹的静默毁数据。
   所以：两边都接受两种形状。做法是先把输入规范化成对象数组，再统一出口。*/

export function toPoints(raw) {
  return toObjPoints(raw)
}

export function toFlat(points) {
  const pts = toObjPoints(points)
  const out = new Array(pts.length * 3)
  for (let i = 0; i < pts.length; i++) {
    out[i * 3] = pts[i].x
    out[i * 3 + 1] = pts[i].y
    out[i * 3 + 2] = pts[i].p
  }
  return out
}

function toObjPoints(raw) {
  const out = []
  if (!Array.isArray(raw)) return out
  // 扁平数组：[x, y, p, x, y, p, ...]
  if (typeof raw[0] === 'number') {
    for (let i = 0; i + 1 < raw.length; i += 3) {
      const x = Number(raw[i])
      const y = Number(raw[i + 1])
      const p = Number(raw[i + 2])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      out.push({ x, y, p: Number.isFinite(p) && p > 0 ? p : 0.5 })
    }
    return out
  }
  // 对象数组：[{x, y, p}, ...]
  for (const pt of raw) {
    if (!pt || typeof pt !== 'object') continue
    const x = Number(pt.x)
    const y = Number(pt.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const p = Number(pt.p)
    out.push({ x, y, p: Number.isFinite(p) && p > 0 ? p : 0.5 })
  }
  return out
}

// ─────────────────────────────── 几何 ───────────────────────────────

export function strokeBounds(stroke) {
  const pts = toPoints(stroke && stroke.points)
  if (!pts.length) return null
  let minX = pts[0].x
  let maxX = pts[0].x
  let minY = pts[0].y
  let maxY = pts[0].y
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const w = stroke && stroke.tool === 'highlighter' ? Number(stroke.width) || 14 : Number(stroke.width) || 2.5
  const pad = w / 2
  return { x: minX - pad, y: minY - pad, w: maxX - minX + w, h: maxY - minY + w }
}

/* 一张卡片**画在纸上的样子**：布局尺寸 × 倍率，再绕自己的中心转 `rot`。
 *
 * ★ 为什么单开这一个函数（2026-09-21）：卡片现在有**两个**尺寸概念（`w/h` 是布局尺寸、
 *   `scale` 是倍率）和一个姿态（`rot`）。它们各自在三个地方被乘一遍的话，
 *   总有一处会漏乘（README 第 15/16 条那一族的账：同一个矩形两处各算一遍，
 *   就一定有一处忘了乘别的东西）。所以"肉眼看到的那个矩形"只有这一份：
 *     `{ x, y, w, h, cx, cy, rot }` —— x/y/w/h 是**没转的**那个矩形（中心在 cx,cy）。
 *   ⚠ 它和 `strokeBounds` 一样是**世界坐标**；屏幕那一半在 view.js。
 * ⚠ `scale` 在这里只做兜底（`normalizeCard` 已经把它夹在 0.5~4 了）。
 *   **不能 import board.js 的 clampCardScale** —— board.js 要 import 这里的 toFlat，
 *   反过来就是环（这个仓库为这件事专门写过一条注释，见文件头）。 */
export function cardVisualRect(c) {
  const k = Number(c && c.scale) > 0 ? Number(c.scale) : 1
  const w = (Number(c && c.w) || 0) * k
  const h = (Number(c && c.h) || 0) * k
  const x = Number(c && c.x) || 0
  const y = Number(c && c.y) || 0
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, rot: Number(c && c.rot) || 0 }
}

/* 卡片的**外接矩形**（轴对齐，世界坐标 {x,y,w,h}）。
 * ★ 含倍率和旋转 —— 关系（包含/重叠/挨着）、板框的框线、"装回屏幕"都吃这一个：
 *   一张转过 30° 的卡，肉眼看到的范围就是它的外接框；拿没转的那个矩形去判关系，
 *   会出现"明明叠在一起却说挨着"。
 * ⚠ 代价说清楚：轴对齐的外接框对**斜着的**卡略微偏大（四角那一圈）。
 *   这是已知且接受的近似 —— 真按旋转矩形判交，收益是几个像素、代价是这一族
 *   所有判据都要重写一遍；而且"包含"那条本来就有 CONTAIN_RATIO 的余量。 */
export function cardBounds(c) {
  const r = cardVisualRect(c)
  if (!r.rot) return { x: r.x, y: r.y, w: r.w, h: r.h }
  const co = Math.abs(Math.cos(r.rot))
  const si = Math.abs(Math.sin(r.rot))
  const w = r.w * co + r.h * si
  const h = r.w * si + r.h * co
  return { x: r.cx - w / 2, y: r.cy - h / 2, w, h }
}

/* 一组笔迹的包围盒（世界坐标，**不带线宽**）。
   用途：框选之后那个虚线框、以及"这一下是不是按在选区里"（见 Board.jsx 的 onPointerDown）。
   ⚠ 和 `strokeBounds` 的分工：那个是**单笔**、而且把线宽/2 撑出去（命中测试要算笔尖的宽度）；
   这个是**多笔**的外框、不撑 —— 虚线框要正好贴着你圈住的那几笔，撑出去看着就"框大了"。
   （它原来住在 Board.jsx 底部，2026-09-16 跟着"选中那一族"一起收进 lib。） */
export function strokesBBox(strokes) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of strokes || []) {
    for (const p of toPoints(s.points)) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null
}

export function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

export function rectsOverlap(a, b, gap = 0) {
  return (
    a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h
  )
}

export function pointInRect(pt, r, gap = 0) {
  return pt.x >= r.x - gap && pt.x <= r.x + r.w + gap && pt.y >= r.y - gap && pt.y <= r.y + r.h + gap
}

export function rectDist(a, b) {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)))
  return Math.hypot(dx, dy)
}

export function boundsOfAll(items, boundsFn) {
  let box = null
  for (const it of items || []) {
    const b = boundsFn(it)
    if (!b) continue
    box = box ? unionRect(box, b) : { ...b }
  }
  return box
}

export function unionRect(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/* 点到线段的距离。擦除、命中测试、"这一笔是从哪张卡出发的"都靠它。 */
export function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

/* 笔画有没有挨到某个圆（橡皮/命中）。直接遍历线段，不做空间索引——
   一节课的笔画量（几百笔、每笔几十点）线性扫一遍是微秒级，
   加索引只会多一处能错的地方。真到了卡顿再按 bounds 先筛。 */
export function strokeHitsCircle(stroke, cx, cy, radius, extra = 0) {
  const pts = toPoints(stroke && stroke.points)
  if (!pts.length) return false
  const r = radius + extra + (Number(stroke.width) || 2.5) / 2
  if (pts.length === 1) return Math.hypot(pts[0].x - cx, pts[0].y - cy) <= r
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pointSegDist(cx, cy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= r) return true
  }
  return false
}

/* ═══════════ 板框的几何 ═══════════
 *
 * 板框（`frames`，见 board.js 的 normalizeFrames 与 ADR-0001）只存**成员 id**，
 * 框线是**算出来的**：成员的包围盒 + 一圈内边距。所以内容一挪，框自己跟着走。
 * ★ 这就是"为什么框不存矩形"的落地处：只有一份真相（内容），框是它的函数。
 * 内边距给 14 世界像素：比笔宽和卡片边框都宽一点，框线才能"抱着"内容而不是压在上面
 * （卡片自己的边框 1px、字号 15px，14 看起来是"一圈留白"而不是"贴边"）。 */
export const FRAME_PAD = 14

/* 一个板框的框线矩形（世界坐标 {x,y,w,h}）；成员一个都不在了 → null（框就不该画）。 */
export function frameBounds(board, frame, pad = FRAME_PAD) {
  const S = new Set((frame && frame.ids) || [])
  const C = new Set((frame && frame.cards) || [])
  const sb = boundsOfAll(((board && board.strokes) || []).filter((s) => S.has(s.id)), strokeBounds)
  const cb = boundsOfAll(((board && board.cards) || []).filter((c) => C.has(c.id)), cardBounds)
  const inner = sb && cb ? unionRect(sb, cb) : sb || cb
  if (!inner) return null
  return { x: inner.x - pad, y: inner.y - pad, w: inner.w + pad * 2, h: inner.h + pad * 2 }
}

/* 一笔有没有"碰到"这个矩形（世界坐标，{x0,y0,x1,y1} 的圈选框）。
 * 判定用碰着就算 —— 只要有任意一个点落在框里，这一笔就算被圈住了。
 * 比"整笔必须完全落在里面"符合直觉得多：手写时很少有人能一笔不越界地圈住东西，
 * 按"完全包含"来判，用户会觉得"我明明框住了它却没选上"。
 * （它原来住在 Board.jsx 底部；2026-09-17 搬进来，因为"留下板框"要用**同一个**判据。） */
export function strokeHitsRect(stroke, r) {
  for (const p of toPoints(stroke && stroke.points)) {
    if (p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1) return true
  }
  return false
}

/* 框里圈到了哪些东西：笔迹（碰着就算，同 strokeHitsRect）+ 卡片（**中心**落在框里才算）。
 * ★ 卡片为什么不按"碰着就算"：一张便签常常很大，碰着一条边就把它整个拉进一个框，
 *   而"我圈住的是这一节"这句话就变味了；中心在框里，才是"我圈的是这张卡"。
 *   （和"留下板框"那句话对齐：框住的东西从那一刻起属于它 —— 归属要你圈得明白。） */
export function membersInBox(board, box) {
  if (!box) return { ids: [], cards: [] }
  const r = { x: box.x0, y: box.y0, w: Math.max(0, box.x1 - box.x0), h: Math.max(0, box.y1 - box.y0) }
  const ids = ((board && board.strokes) || []).filter((s) => strokeHitsRect(s, box)).map((s) => s.id)
  const cards = ((board && board.cards) || [])
    .filter((c) => pointInRect(rectCenter(cardBounds(c)), r))
    .map((c) => c.id)
  return { ids, cards }
}

/* 点抽稀：道格拉斯—普克。
   为什么必须在保存前跑：Surface 的笔 + getCoalescedEvents 一秒钟能给 240 个点，
   一笔签名就是几十个点。不抽稀的话，一节课的文件几兆，打开要等、Git 每次全量 diff。
   容差 0.6 世界像素：小于半像素的抖动在 100% 缩放下本来就看不见，
   放大到 400% 才可能看出一点点棱角——划算。

   ★ 两个"抽不干净"的坑，都是实测出来的：

   ① **必须先按存盘精度去重。** 两个几乎重合的点（坐标 0 和 0.01）会造出一条
      零长度的线段，而"点到零长度线段的距离"退化成点到点的距离，数值上一点不小，
      于是这段噪声永远超过容差、永远删不掉。手写笔画里这种点满地都是，
      结果是文件比不抽稀还难看。先去重（阈值 0.03 < 存盘精度 0.1）再抽。
   ② 端点必须原样保留。下面第一个断言就是钉这个，不然每存一次笔画都在慢慢缩。

   去重会把坐标对齐到 1/10 像素 —— 这和存盘精度一致，所以**不算丢精度**。 */
export function simplifyPoints(points, tol = 0.6) {
  const pts = dedupePoints(points || [])
  const n = pts.length
  if (n <= 2) return pts
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [i0, i1] = stack.pop()
    if (i1 - i0 < 2) continue
    let maxD = -1
    let idx = -1
    const a = pts[i0]
    const b = pts[i1]
    for (let i = i0 + 1; i < i1; i++) {
      const d = pointSegDist(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1
      stack.push([i0, idx], [idx, i1])
    }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i])
  return out
}

const Q = 10 // 存盘精度：1/10 像素。去重阈值也按这个来（见上）

function dedupePoints(points) {
  const out = []
  for (const p of points) {
    const x = Math.round(p.x * Q) / Q
    const y = Math.round(p.y * Q) / Q
    const last = out[out.length - 1]
    if (last && last.x === x && last.y === y) {
      // 同步一下压力：重合的点里最后的压力更接近"你此刻的力道"
      last.p = p.p
      continue
    }
    out.push({ x, y, p: p.p })
  }
  return out
}

/* 视图映射（屏幕 = 世界 × s + t）整体搬去了 `src/lib/view.js` —— 2026-09-16。
   为什么搬：这条公式以前被手抄 14 处、canvas 变换写了两份、捏合还复制了一份
   导出逻辑，而**导出那份有自检、手指走的是复制品**。现在口径只在一个文件里，
   调用方（Board.jsx / BoardCanvas.jsx / 自检）都从 view.js 取。
   `fitView` 留在这里：它要算"内容包围盒"，属于板的几何，不属于视图映射。 */

// ─────────────────────── 关系：就近归属 / 枢纽 / 孤岛 ───────────────────────
/* 「关系」不是让你填的字段，是**从你画的位置里读出来的**。
 *
 * 判定的顺序（从强到弱）：
 *   ① 包含 —— 一张卡整个落在另一张卡里面（面积差得够多）。这是最强的意图：
 *      "这公式属于这一节"。
 *   ② 重叠 —— 框搭在一起。算相关，父节点给先画的那张（稳定，不会因为拖动而翻来覆去）。
 *   ③ 挨着 —— 框之间空着但在 NEAR_GAP 以内。手画的人就是这样表达的：
 *      写个名字，旁边写公式，中间不连线。
 *   ④ 都没有 —— 孤岛。**孤岛不是错误**，是"这块我还没想清楚它跟谁有关"，
 *      正是最值得停一下的地方（沿用旧版的这个说法）。
 *
 * 为什么不用"你必须在中间画一条线"：那又变成要你学一套规矩了。
 * 位置本身就是关系，这也是白板比大纲强的地方。
 */
export function buildRelations(board) {
  const cards = (board && board.cards) || []
  /* ★ 面积按**外接框**算，不按 `c.w * c.h`（2026-09-21）：判重叠用的是 `r`，
     判"大框包住小框"却用另一个数的话，两张各自都是同一个倍率的卡会比出不同的结论 ——
     "包含"那条就会时而成立时而不成立（同一个矩形两份算法，这个仓库记了十几条账）。 */
  const boxes = cards.map((c) => {
    const r = cardBounds(c)
    return { id: c.id, r, area: r.w * r.h, seq: cards.indexOf(c) }
  })
  const edges = []
  const parentOf = new Map()
  const children = new Map()

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i]
      const B = boxes[j]
      const d = rectDist(A.r, B.r)
      const overlap = rectsOverlap(A.r, B.r)
      if (!overlap && d > NEAR_GAP) continue

      let kind = overlap ? 'overlap' : 'near'
      let parent = null
      let child = null
      if (overlap) {
        const big = A.area >= B.area ? A : B
        const small = A.area >= B.area ? B : A
        if (big.area / Math.max(1, small.area) >= CONTAIN_RATIO) {
          kind = 'contain'
          parent = big.id
          child = small.id
        } else {
          // 差不多大又叠着：算相关；父节点给先画的，保证拖来拖去结果不变
          parent = A.seq < B.seq ? A.id : B.id
          child = parent === A.id ? B.id : A.id
        }
      } else {
        parent = A.seq < B.seq ? A.id : B.id
        child = parent === A.id ? B.id : A.id
      }
      edges.push({ a: A.id, b: B.id, kind, dist: Math.round(d * 10) / 10 })
      // 只记最强的那条父边：一张卡两个父，大纲就画不出来了
      if (!parentOf.has(child)) parentOf.set(child, parent)
      if (!children.has(parent)) children.set(parent, [])
      const list = children.get(parent)
      if (!list.includes(child)) list.push(child)
    }
  }

  const degree = new Map()
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) || 0) + 1)
    degree.set(e.b, (degree.get(e.b) || 0) + 1)
  }
  const orphans = cards.filter((c) => !degree.get(c.id)).map((c) => c.id)
  const hubs = [...degree.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 6)
    .map(([id]) => id)

  return { edges, parentOf, children, degree, orphans, hubs }
}

/* 一张卡的全部后代（含自己）。用来给"这一节"整体上色/整体挪动。 */
export function descendantsOf(relations, id) {
  const out = new Set([id])
  const walk = (cur) => {
    for (const k of relations.children.get(cur) || []) {
      if (out.has(k)) continue
      out.add(k)
      walk(k)
    }
  }
  walk(id)
  return out
}

/* 连线怎么画：从 A 中心到 B 中心，控制点按垂直方向推开一点，
   让它看起来像"一条弧"而不是生硬的直线。距离越远弧越平。 */
export function relationCurve(ra, rb, bow = 0.18) {
  const a = rectCenter(ra)
  const b = rectCenter(rb)
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const cx = mx - (dy / len) * len * bow
  const cy = my + (dx / len) * len * bow
  return { a, b, c: { x: cx, y: cy } }
}

/* 兜底视口：把所有内容都装进 screenW×screenH，四周留 pad。
   打开一个从没看过的大板时，不这么做就会"打开是一片空白"，
   用户以为内容丢了。

   ★ 缩放下限 READABLE_FIT_S = 0.55 —— 这是实测加的：
     在 758×426 的窗口里（笔记本分屏、或者浏览器窗口拖小了），
     "全部装进去"会算出 0.37 倍，卡片上的公式小到看不清。
     装不下就装不下，宁可让你**平移着看**，也不能把板缩成蚂蚁。
     （Ctrl+0 是"装回屏幕"，会走这里；想真的看到全部内容就用它，然后自己放大。） */
export const READABLE_FIT_S = 0.55
export function fitView(board, screenW, screenH, pad = 60) {
  const box = boundsOfAll(
    [...((board && board.strokes) || [])],
    strokeBounds
  )
  const cbox = boundsOfAll((board && board.cards) || [], cardBounds)
  const all = box && cbox ? unionRect(box, cbox) : box || cbox
  if (!all || all.w <= 0 || all.h <= 0) return { s: 1, tx: screenW / 2, ty: screenH / 2 }
  const raw = Math.min((screenW - pad * 2) / all.w, (screenH - pad * 2) / all.h)
  const s = clampViewScale(Math.max(READABLE_FIT_S, Math.min(raw, 2)))
  /* 把内容包围盒的中心摆进容器中心 —— 和"聚焦到一张卡"是同一件事，走同一个函数。 */
  return centerOn({ s, tx: 0, ty: 0 }, { x: all.x + all.w / 2, y: all.y + all.h / 2 }, screenW, screenH)
}
