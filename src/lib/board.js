/* 白板的数据模型 + 几何 + 「关系怎么算出来」。
 *
 * 这里刻意**不碰任何 DOM 和 canvas**：输入是纯数据（点数组、卡片框），
 * 输出也是纯数据（框、最近邻、父节点）。理由是这一层最容易"看起来对、
 * 实际错"（吸附吸错人、孤岛数错、缩放后锚点飘），而且错了没法靠肉眼发现。
 * 抽出来之后 scripts/check-board.js 能在 node 里直接跑断言。
 *
 * ── 坐标系只有一套：世界坐标（world）──
 * 笔迹的点、卡片的位置，全都存世界坐标。视图有 s（缩放）和 tx/ty（平移），
 * 屏幕坐标 = 世界坐标 * s + t。于是：缩放平移**不改一个字节的数据**，
 * 只改你自己的视图；换个缩放再打开，画的东西还在原地。
 *
 * 坑（已经踩过）：别把屏幕坐标存进文件。一旦存了，"上次在哪里看的"
 * 就变成了数据的一部分，改缩放等于改内容，撤销栈、Git 备份全跟着脏。
 */

export const BOARD_VERSION = 3
export const BOARD_PREFIX = 'board-' // 白板文件都叫 board-xxx.md（内容其实是 JSON，见下）
export const CARD_KINDS = ['formula', 'note']
export const DEFAULT_CARD_SIZE = { w: 260, h: 96 }

/* 荧光笔：颜色和宽度都**钉死**，不给用户选。
   为什么不做成"可选颜色"：荧光笔的语义是"在已有的字上叠一层记号"，
   不是"用另一种颜色写字"。颜色一变，那层半透明的黄底就不成立了
   （红色荧光笔盖在黑字上，字就读不清了）。宽度同理 —— 马克笔只有一种笔头。
   这两个常量被"存储层归一化"和"渲染层"共用，所以只能有一处定义。 */
export const HL_COLOR = '#ffd43b'
export const HL_WIDTH = 16

/* 关系判定的距离阈值，单位是**世界坐标像素**。
   为什么是 26：这是"手画的时候看起来连着、但其实没碰到"的典型间距。
   调大 → 会把无关的卡片连起来（误连比漏连更讨厌，因为它看起来像你说过的话）。 */
export const NEAR_GAP = 26
export const CONTAIN_RATIO = 1.4 // 大框包住小框：面积比超过这个数才算"包含"，否则算"重叠"

let idSeq = 0

/* id 只需要在**一个文件内**唯一（关系图是本文件内算的）。
   故意带上时间戳：两个设备各画一块，Git 合并时不会撞 id。 */
export function newId(prefix = 'x') {
  idSeq += 1
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`
}

// ─────────────────────────── 新建 / 解析 / 序列化 ───────────────────────────

export function newBoard(title = '新白板') {
  return {
    title: String(title || '新白板').replace(/\.md$/i, ''),
    version: BOARD_VERSION,
    view: { s: 1, tx: 0, ty: 0 },
    /* viewPinned：这条视野是**你亲手平移/缩放定的**吗？
       false（默认）= 打开时自动把所有内容装进屏幕；true = 老老实实用存下来的那条。
       为什么要这个东西：tx/ty 是**相对画布容器**的坐标（见 Board.jsx 顶部），
       容器一变（换摆法、改界面字号、窗口大小变了），旧坐标就是个错的位置。
       与其猜"要不要迁移"，不如只在你真的自己动过视图之后才记住它 ——
       没动过就一直自动适配，永远不会因为容器变了而错位。 */
    viewPinned: false,
    strokes: [],
    cards: [],
    // 「圈起来的范围」：暂时不做，先留字段，免得以后加字段要改版本号
    groups: [],
  }
}

export function newCard(kind, x, y, extra = {}) {
  const size = extra.w && extra.h ? { w: extra.w, h: extra.h } : { ...DEFAULT_CARD_SIZE }
  return {
    id: newId(kind === 'formula' ? 'f' : 'n'),
    kind: CARD_KINDS.includes(kind) ? kind : 'note',
    x: Math.round(x - size.w / 2), // 传进来的 x/y 是"我要放的中心"，存的是左上角
    y: Math.round(y - size.h / 2),
    w: size.w,
    h: size.h,
    src: '', // 公式卡片：你随手写的那串（就是文件里存的东西）
    tex: '', // 上面那串渲染用的样子（改烂了随时能从 src 重算）
    text: '', // 便签卡片：一句话
  }
}

export function newStroke(tool, points, brush = {}) {
  const isHi = tool === 'highlighter'
  return {
    id: newId('s'),
    tool: isHi ? 'highlighter' : 'pen',
    color: isHi ? HL_COLOR : brush.color || '#1b1d22',
    // 荧光笔的宽度不给默认值兜底 —— 直接用 HL_WIDTH。
    // 漏了这一步的话，调用方忘了传 brush.width 就会得到 2.5 的"荧光笔"，
    // 画出来是一条细得看不出是荧光笔的线（我自己的样板就这么中过一次）。
    width: isHi ? HL_WIDTH : Number(brush.width) || 2.5,
    pressure: isHi ? false : brush.pressure !== false,
    points: Array.isArray(points) ? points.slice() : [],
  }
}

/* 白板的文件里其实是 JSON —— 但仍然叫 .md。
   为什么：① 现有服务、备份脚本、Git 流程都按 *.md 走，改后缀就是改了四处；
   ② 万一哪天想手改或想让别的 AI 读，"一个开头是 { 的 .md" 比二进制好救；
   ③ 文件名前缀 board- 让列表一眼能分开白板和笔记。
   解析失败的兜底是"给一张空板"，不是抛错——打不开比丢内容更糟。 */
export function isBoardName(name) {
  return new RegExp(`^${BOARD_PREFIX}.*\\.md$`, 'i').test(String(name || ''))
}

export function isBoardDocument(text) {
  const t = String(text || '').trim()
  if (!t.startsWith('{')) return false
  try {
    const o = JSON.parse(t)
    return !!o && Array.isArray(o.strokes)
  } catch {
    return false
  }
}

export function parseBoardDocument(text, fallbackTitle = '新白板') {
  let raw = null
  try {
    raw = JSON.parse(String(text || ''))
  } catch {
    return newBoard(fallbackTitle)
  }
  if (!raw || typeof raw !== 'object') return newBoard(fallbackTitle)

  const b = newBoard(raw.title || fallbackTitle)
  b.version = BOARD_VERSION
  const v = raw.view || {}
  b.view = {
    s: clampScale(Number(v.s)) || 1,
    tx: Number(v.tx) || 0,
    ty: Number(v.ty) || 0,
  }
  b.viewPinned = raw.viewPinned === true
  b.strokes = (Array.isArray(raw.strokes) ? raw.strokes : []).map(normalizeStroke).filter(Boolean)
  b.cards = (Array.isArray(raw.cards) ? raw.cards : []).map(normalizeCard).filter(Boolean)
  return b
}

const clampScale = (s) => (Number.isFinite(s) && s > 0.05 && s < 20 ? s : 0)

function normalizeStroke(s) {
  if (!s || typeof s !== 'object') return null
  const pts = toFlat(s.points) // ★ 一律归成扁平数组，见下方说明
  if (pts.length < 6) return null
  const tool = s.tool === 'highlighter' ? 'highlighter' : 'pen'
  return {
    id: typeof s.id === 'string' && s.id ? s.id : newId('s'),
    tool,
    // 荧光笔固定用荧光黄：它是一次"叠在字上做记号"的动作，
    // 不是一种可选颜色（见 HL_COLOR 的说明）
    color: tool === 'highlighter' ? HL_COLOR : typeof s.color === 'string' ? s.color : '#1b1d22',
    /* ★ 荧光笔的宽度也钉死，**不保留**文件里写的值。
       为什么这里比"保持原样"更狠：荧光笔是马克笔，只有一种笔头；
       而文件里那些 2.5 / 4 的宽度不是用户选的，是早先代码里
       `Number(brush.width) || 2.5` 这个兜底漏出来的默认值。
       留着它们，用户会看到"有的荧光笔粗、有的细"，而且找不到原因。 */
    width: tool === 'highlighter' ? HL_WIDTH : Number(s.width) > 0 ? Number(s.width) : 2.5,
    /* ★ 荧光笔**永远不吃压力**。
       荧光笔是马克笔：笔迹是一道**宽度恒定**的带子。
       早先的代码把 pressure 当成通用属性，于是荧光笔也逐点改线宽 ——
       写起来一下粗一下细，看起来像"效果不均匀"，其实是 bug。
       这一条放在归一化里，所以**老文件里的笔迹下次打开也会自动修好**
       （不用你去把画过的荧光笔重描一遍）。 */
    pressure: tool === 'highlighter' ? false : s.pressure !== false,
    points: pts,
  }
}

/* ⚠ 内存里的点**必须**是扁平数组（[x,y,p, x,y,p, ...]）。
   这一条是踩出来的，而且是最贵的一个坑：
     parseBoardDocument 一开始把点规范化成了**对象数组** [{x,y,p}]，
     而画布、抽稀、包围盒这些读点的地方按扁平数组读下标 0/1/2 ——
     于是一笔 10 个点的线被读成"3 个点"，画出来只有 0 长度，屏幕上什么都没有。
     更气人的是：文件内容是好的、控制台的数字看着也"对"（3 笔），
     只是画布上一片空白，怎么查都像渲染的问题。
   所以：**所有入口都用 toFlat 收敛成扁平数组**，读点的地方统一用 toPoints
   （它两种都认，是给"万一有对象混进来"兜底的，不是给主力路径用的）。 */

function normalizeCard(c) {
  if (!c || typeof c !== 'object') return null
  const kind = CARD_KINDS.includes(c.kind) ? c.kind : 'note'
  const w = Number(c.w) > 40 ? Number(c.w) : DEFAULT_CARD_SIZE.w
  const h = Number(c.h) > 32 ? Number(c.h) : DEFAULT_CARD_SIZE.h
  const src = typeof c.src === 'string' ? c.src : ''
  const tex = typeof c.tex === 'string' ? c.tex : ''
  return {
    id: typeof c.id === 'string' && c.id ? c.id : newId(kind === 'formula' ? 'f' : 'n'),
    kind,
    x: Number(c.x) || 0,
    y: Number(c.y) || 0,
    w,
    h,
    /* 早期版本的手写识别只写 tex、故意把 src 留空（当时的理由是"给手打的那串留个参照"）。
       但**编辑态编辑的就是 src** —— 空 src 等于"双击进卡片看到一个空输入框"，
       而这正是「识别是对的，但放不到白板上」那个 bug 的另一半。
       所以读盘时就地补齐：公式卡有 tex 没 src，就把 src 当成 tex。
       只补公式卡、只在 src 真的空的时候补 —— 手打过的 src 一个字都不动。 */
    src: kind === 'formula' && !src.trim() && tex.trim() ? tex : src,
    tex,
    text: typeof c.text === 'string' ? c.text : '',
  }
}

/* 存的文件要能被人和 Git 看懂一点：坐标保留一位小数，压力保留两位。
   一位小数够不够？线条宽度 2.5px，1/10 像素的误差肉眼看不出；
   但能让一个大板的文件小 30% 左右，diff 也干净得多。

   为什么压力要两位：压力决定线条粗细，0.63 → 0.6 的差别看不见，**但它要能往返**。
   压缩到一位时，"打开文件 → 什么都不改 → 存回去"会和原文不一样，
   于是 Git 每次都报一次假 diff，而你会慢慢学会忽略 diff —— 那比不备份更糟。
   宁可一个点多两个字节，也不要每天一条假改动。 */
export function serializeBoardDocument(board) {
  const out = {
    title: board.title,
    version: BOARD_VERSION,
    viewPinned: board.viewPinned === true,
    view: {
      s: round(board.view && board.view.s ? board.view.s : 1, 3),
      tx: round(board.view && board.view.tx ? board.view.tx : 0, 1),
      ty: round(board.view && board.view.ty ? board.view.ty : 0, 1),
    },
    strokes: (board.strokes || []).map((s) => ({
      id: s.id,
      tool: s.tool,
      color: s.color,
      width: round(s.width, 1),
      pressure: s.pressure !== false,
      // ★ 必须过 toFlat，不能直接 Array.from 遍历。
      //   内存里的点有可能是**对象数组**（parseBoardDocument 规范化出来的就是），
      //   直接遍历再用 Number(n) 读，每个点都会变成 0 —— 又一次静默毁数据。
      //   序列化是"出关"的地方，出关一律走同一个出口，不指望调用方守规矩。
      points: toFlat(s.points).map((n) => round(n, 2)),
    })),
    cards: (board.cards || []).map((c) => ({
      id: c.id,
      kind: c.kind,
      x: round(c.x, 1),
      y: round(c.y, 1),
      w: round(c.w, 1),
      h: round(c.h, 1),
      src: c.src || '',
      tex: c.tex || '',
      text: c.text || '',
    })),
  }
  return JSON.stringify(out, null, 1) + '\n'
}

function round(n, digits) {
  const f = 10 ** digits
  return Math.round((Number(n) || 0) * f) / f
}

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

export function cardBounds(c) {
  return { x: c.x, y: c.y, w: c.w, h: c.h }
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

/* 视图变换。屏幕 = 世界 * s + t；反过来要减 t 再除 s。
   wheel 缩放必须用"光标的那个世界点最后还在光标底下"的算法（见 zoomAt），
   否则每次滚轮画面都会往一角漂——那种错一开始小，滚十下就离谱了。 */
export function worldToScreen(pt, view) {
  return { x: pt.x * view.s + view.tx, y: pt.y * view.s + view.ty }
}

export function screenToWorld(x, y, view) {
  return { x: (x - view.tx) / view.s, y: (y - view.ty) / view.s }
}

export function zoomAt(view, factor, screenX, screenY) {
  const s = clampViewScale(view.s * factor)
  const k = s / view.s
  return {
    s,
    tx: screenX - (screenX - view.tx) * k,
    ty: screenY - (screenY - view.ty) * k,
  }
}

export function clampViewScale(s) {
  const n = Number(s) || 1
  return Math.min(6, Math.max(0.15, n))
}

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
  const boxes = cards.map((c) => ({ id: c.id, r: cardBounds(c), area: c.w * c.h, seq: cards.indexOf(c) }))
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
  return {
    s,
    tx: screenW / 2 - (all.x + all.w / 2) * s,
    ty: screenH / 2 - (all.y + all.h / 2) * s,
  }
}

/* 卡片之间有没有笔迹连着 —— "这条关系是我画了线的"。
   给关系面板用：画了线的排前面，纯靠挨着的排后面并标注出来。
   判定用"这一笔的起点在一张卡里、终点在另一张卡里"或者反过来。
   不做"线穿过卡片"判定：手画的线歪歪扭扭，穿过是常态，会误判一堆。 */
export function inkedEdges(board) {
  const cards = (board && board.cards) || []
  const boxes = cards.map((c) => ({ id: c.id, r: cardBounds(c) }))
  const out = []
  for (const s of (board && board.strokes) || []) {
    const pts = toPoints(s.points)
    if (pts.length < 2) continue
    const first = pts[0]
    const last = pts[pts.length - 1]
    const f = boxes.find((b) => pointInRect(first, b.r, 8))
    const l = boxes.find((b) => pointInRect(last, b.r, 8))
    if (f && l && f.id !== l.id) out.push({ a: f.id, b: l.id, strokeId: s.id })
  }
  return out
}
