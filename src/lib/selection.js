/* 选中这一族：框住的那些笔**意味着什么**，以及你能对它说的那几句话。
 *
 * 为什么单开一个 module（2026-09-16 架构 review 的 C3）：
 *   "框住一笔之后能干什么"这件事，从前散在三个地方 ——
 *   Board.jsx 里几个 useMemo（`selLink` / `selBox` / `selFrame` / …）
 *   加一串处理器（删 / 改词 / 反向 / 留下板框 / 拆开）、
 *   BoardCanvas 里 3 段各自 `{xx && …}` 的条件渲染，外加 11 个 prop。
 *   而这里面全是**踩过坑的规矩**，却没有一条在纯逻辑里钉得住：
 *     · 选的那个词**正好等于默认那一档** → **不写字段**（一条没动过的连接是零字节）；
 *     · ⇄ 反向 = 把这笔的点**倒过来**（方向就是"第一点 → 最后一点"）；
 *     · 框住"正好是一个板框的笔"才算那个框（少一笔都不算，不然框一大片会顺手拆了它）；
 *     · 留下板框时要把这些东西从**别的框**里拿走（一个成员只属于一个框）。
 *   现在这些规矩都在这里，一处、可断言：读（`readSelection`）+ 写（下面那几个纯函数）。
 *
 * ⚠ 第二刀之后这个 module 变短了：`clearNoLinkMarks`（"又算回连接"）跟着「不算连接」
 *   一起删掉 —— 那个口子的前提是"形状判读会猜错"，而形状判读整族已经删了（ADR-0001）。
 *
 * ── interface ─────────────────────────────────────────────────────────────
 *   readSelection(board, ids, links, cardIds) → {
 *     ids, cards, count, empty, strokes, box,
 *     link,     // 框里**正好一条**连接线时是那条连接（改词那排的入口），否则 null
 *     frame,    // 框住的这些笔**正好就是**某个板框吗（是 → 浮层给「拆开这个框」）
 *   }
 *   applyStrokeLink(board, links, strokeId, kind, { reverse }) → board' | null
 *     kind = 词表里的词 → 写/清那个字段；词不认识 → **null**（什么都没改，调用方也别弹提示）。
 *   removePick(board, ids, cards) → board'   删掉这些笔**和这些卡**（顺手把板框里的死成员摘掉）
 *   transformPick(board, pick, xf) → board'  把框住的这一撮东西当成**一个整体**缩放 / 旋转
 *     xf 只有两种形状（一次拖动只有一种，见 Board.jsx 的两段手势）：
 *       { scale:  { fx, fy, anchor } }  —— 拖角；锚点是**对角**那一点
 *       { rotate: { d, center } }       —— 拖那颗圆的；绕选区中心
 *   freezeFrameSelection(board, ids, cards) → { board, movedFrom }   留下板框；movedFrom 是被挪过的别的框
 *   这些函数都是**纯的**：不动原对象、只返回新的 board（约定见 board.js 顶部）。
 *   「拆开一个板框」在 frames.js 的 `dissolveFrame`（它只认 board + frameId）。
 *   `clearNoLinkMarks`（"又算回连接"）第二刀删掉了 —— 见下面那段说明。 */

/* 板框那一族（留下 / 拆开 / 改标题 / 整体挪）搬去了 frames.js（2026-09-17）：
   从前的 `groups`（"固定成一块"）在这里，现在它长成了板框 —— 成员多了卡片、多了标题，
   所以规矩跟着那个概念一起走，这个 module 只管"**框住**这一撮笔意味着什么"。 */
import { freezeFrame, pruneFrames } from './frames.js'
/* 点 / 几何 / 关系搬去了 geometry.js（2026-09-16 架构 review 的 C5）。 */
import { cardBounds, cardVisualRect, strokesBBox } from './geometry.js'
/* 连接记录的身份（`linkId(from, to)`）—— 条件的第三个说法住在 `links[i]` 上，
   找那一条记录用的就是这把钥匙（和 frames.js / links.js 同一把）。 */
import { linkId, nextCardScale } from './board.js'
/* 图形的三个变换（缩放 / 旋转 / 重烤点）在 shape-object.js ——
   "成组变换"（本文件下半段）不许自己再写一份：图形那条铁律是
   **`shape` 和 `points` 任何时候都对得上**，而唯一的入口就是 `retargetStroke`。 */
import { normAngle, retargetStroke, rotateShape, scaleShape } from './shape-object.js'
import { COND_NONE, DEFAULT_LINK, isLinkKind, parseCond } from './link-kinds.js'

/** 把扁平点数组整个倒过来（[x,y,p] 三个一组）。⇄ 反向就是它。 */
export function reverseFlat(flat) {
  const out = []
  for (let i = flat.length - 3; i >= 0; i -= 3) out.push(flat[i], flat[i + 1], flat[i + 2])
  return out
}

/** 笔迹 id → 它属于的那条连接（一条连接可能由好几笔拼成，所以每一笔都要映射到同一条）。 */
export function linkMap(links = []) {
  const m = new Map()
  for (const l of links) for (const id of l.ids || [l.strokeId]) m.set(id, l)
  return m
}

const asSet = (ids) => (ids instanceof Set ? ids : new Set(ids || []))

/* 选区的外框 = 笔迹的包围盒 ∪ 卡片的**可视**外接框（含倍率和旋转，见 geometry.cardBounds）。
 * ★ 为什么卡片也要进来（2026-09-21）：框选现在把卡片一起框进来，而那个虚线框**必须**
 *   把它们圈住 —— 不然手柄钉在一个不含卡片的框上，用户拖角时会觉得"卡片没跟着动"
 *   （它其实动了，只是框和它各说各话）。用可视框而不是布局框：转过 30° 的卡，
 *   肉眼看到的就是外接框。
 * 返回的仍然是 `{x0,y0,x1,y1}` —— 和 strokesBBox 同一个形状（调用方只认这一种）。 */
export function pickBox(strokes, cards) {
  const sb = strokesBBox(strokes || [])
  let box = sb ? { ...sb } : null
  for (const c of cards || []) {
    const r = cardBounds(c)
    if (!r || !(r.w >= 0) || !(r.h >= 0)) continue
    if (!box) box = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }
    else
      box = {
        x0: Math.min(box.x0, r.x),
        y0: Math.min(box.y0, r.y),
        x1: Math.max(box.x1, r.x + r.w),
        y1: Math.max(box.y1, r.y + r.h),
      }
  }
  return box
}

export function readSelection(board, ids, links = [], cardIds = []) {
  const set = asSet(ids)
  const cset = asSet(cardIds)
  const strokes = set.size ? (board.strokes || []).filter((s) => set.has(s.id)) : []
  const cards = cset.size ? (board.cards || []).filter((c) => cset.has(c.id)) : []
  const byStroke = linkMap(links)

  /* 框里**正好只有一条**连接线 → 那条（改词的入口）。
     两条线就不是"这条线"了 —— 那时候该让用户框窄一点，而不是替他挑一条。 */
  let link = null
  if (set.size === 1) for (const id of set) link = byStroke.get(id) || null

  /* 框住的这些笔**正好就是**某个板框的笔吗？判据是"集合完全相等"：
     少一笔都不算 —— 不然框一大片会把某个框顺手拆了。
     （框里可以还有卡片成员：卡片框不进来，所以只比笔迹这一半。）
     ⚠ 2026-09-21：`cards` 现在也框得进来，但这条判据**仍然只比笔迹这一半** ——
       一次框选顺手扫进来的卡片不该改变"这正好是那个板框吗"的答案
       （框的成员归属是你说过的话，框选是手上的一下）。 */
  let frame = null
  for (const f of board.frames || []) {
    const ids = f.ids || []
    if (ids.length !== set.size) continue
    if (ids.every((id) => set.has(id))) {
      frame = f
      break
    }
  }

  return {
    ids: [...set],
    cardIds: [...cset],
    /* `count` 仍然是**笔数**（老读法：日志、提示语都按它说话），
       `countAll` 才是"框里一共几样东西"（笔 + 卡）。
       ⚠ 别把 `count` 改成总数 —— 面板上那句"框选 3 笔"说的是笔，卡片另有说法。 */
    count: set.size,
    countAll: set.size + cset.size,
    empty: set.size === 0 && cset.size === 0,
    strokes,
    cards,
    box: pickBox(strokes, cards),
    link,
    frame,
  }
}

/* 改一条连接（你画出来的那条线）的词。opt.reverse = ⇄ 反向。
 * ★ 第二刀之后这里只剩"是什么关系"这一件事：「不算连接」连同形状判读一起删掉了
 *   （见 ADR-0001）—— 现在"删掉这条连接"由 Board.jsx 直接调用 `removePick`。 */
export function applyStrokeLink(board, links, strokeId, kind, opt = {}) {
  const byStroke = linkMap(links)
  if (!isLinkKind(kind)) return null // 词不认识：什么都没改

  return {
    ...board,
    strokes: board.strokes.map((st) => {
      if (st.id !== strokeId) return st
      /* ⇄ 反向 = 把这笔的点**倒过来**。倒过来渲染出来一模一样（都是同一条路径），
         但"第一点 → 最后一点"变了 —— 箭头方向就是靠这个表达的，所以不用另存一个方向字段。 */
      const points = opt.reverse ? reverseFlat(st.points) : st.points
      const next = { ...st, points }
      /* ★ 选的就是这一档的默认词（「相关」）→ **不写这个字段**（回到默认）。
         于是文件里只有"你特意改过的"那几个词：一条没动过的连接是零字节，
         老文件也不会因为我们加了这个功能而变脏。
         （从前这里比的是"形状读出来的那一档"，形状判读删掉之后就是 DEFAULT_LINK。） */
      if (kind === DEFAULT_LINK) delete next.link
      else next.link = kind
      return next
    }),
  }
}

/* 把"不算连接"改回来：删掉了（2026-09-17 第二刀）——
 * 它存在的前提是"形状判读会猜错"，而形状判读整族已经删掉（见 ADR-0001）。
 * 现在"删掉这条连接"由 frames.js 的 `removeLink`（宣告的那种）/ 删掉那一笔（画出来的那种）负责。 */

/** 删掉这些笔**和这些卡**（撤销栈由调用方管：这是"一步"操作）。
 *  顺手把板框里的**死成员**摘掉（框围着空气的样子很怪），空掉的框自己消失。
 *  ★ 2026-09-21：卡片也归它删 —— 框选把卡片一起框进来了，Delete 就该一起删。
 *    分成两个函数的话，"框住 3 笔 + 1 张卡按 Delete"会只删一半，
 *    而屏幕上看起来就是"删除只做了一半"。 */
export function removePick(board, ids, cards = []) {
  const S = asSet(ids)
  const C = asSet(cards)
  if (!S.size && !C.size) return board
  return pruneFrames({
    ...board,
    strokes: S.size ? board.strokes.filter((s) => !S.has(s.id)) : board.strokes,
    cards: C.size ? (board.cards || []).filter((c) => !C.has(c.id)) : board.cards,
  })
}

/* ═══════════════ 把框住的这一撮东西当成**一个整体**来缩放 / 旋转 ═══════════════
 *
 * 用户 2026-09-21：「框选中任意的字迹——卡片都应该能够放大，旋转，这点类似 OneNote」。
 * 在这之前只有**一个**规整过的图形（`stroke.shape`）才有手柄；现在任意一撮笔迹、
 * 以及被框进来的卡片，都算"一个东西"。
 *
 * ★★ 两条规矩，先说清楚（都是这一族踩过的账）：
 *
 * ① **每次拖动都从"按下那一刻的那一份 board"重算，不许累加。**
 *    `Board.jsx` 的手势里存着起点快照，每一帧拿"指针现在在哪"去算一个**绝对**变换。
 *    累加那条路没有自愈能力（一帧算成 0，加多少次还是 0），而且会把浮点误差和
 *    1/10 像素的量化误差一帧一帧地攒起来 —— 拖十下图形就糊了。
 *    这也是为什么这个函数是**纯的**、输入是一整张 board：调用方没法"只传增量"。
 *
 * ② **笔迹可以非等比（横竖分开拉），卡片只能等比。**
 *    笔迹是一堆点，横着拉 2 倍、竖着不动，屏幕上就是"字被拉宽了" —— 那是用户要的
 *    （和"圆拉成椭圆"同一条），而且随时能拉回来。
 *    卡片不行：它的内容是**文字**，宽高分开变要么把字挤变形、要么让文字重新折行
 *    （`w` 是硬约束，写小了当场裁内容 —— 见 README 第 15 条）。
 *    所以卡片走**几何平均** `sqrt(fx·fy)`（"总体上放大了多少"），
 *    而**位置**照样按 fx/fy 走 —— 卡片会待在这个整体变换让它待的地方，
 *    只是自己不跟着变形。代价说清楚：非等比拖的时候，卡片和周围的笔迹会错开一点点。
 *    这是唯一诚实的做法（另一个选择是让卡片撒谎：框变了、里面没变）。
 *
 * ★ 线宽（`stroke.width`）跟着**几何平均**一起缩放：放大三倍的手写如果笔画还是原来
 *   那么细，看起来像"一张放大的复印件"（OneNote 缩放手写就是这个手感 ——
 *   它变换的是整幅墨迹）。夹在 `PICK_MIN_W ~ PICK_MAX_W` 之间：拖到最小的时候
 *   不能细成一根看不见的头发（那之后就再也抓不回来了）。
 */

/* 缩放到底之后，选区的跨度至少还剩这么大（世界像素）。
 * ★ 必须有下限，理由和 `shape-object.js` 里 `MIN_SPAN` 那条一模一样：
 *   拖到 0 之后，手柄会摞成一点、包围盒是零宽 —— 下一次连"往哪拖"都无从谈起。 */
export const PICK_MIN_SPAN = 2
/* 倍率的上下限：50 倍再往上就是"屏幕外的一坨点云"，而文件也会跟着胖起来。 */
export const PICK_MAX_FACTOR = 50
/* 线宽的上下限（世界像素）。下限 0.5 是"还看得见"，上限 24 是"再粗就不是笔了"。 */
export const PICK_MIN_W = 0.5
export const PICK_MAX_W = 24

const clampMaxFactor = (f) => {
  const v = Math.abs(Number(f))
  if (!Number.isFinite(v)) return 1
  return Math.min(PICK_MAX_FACTOR, v)
}
/** 把一根轴上的倍率夹到"这一轴还剩至少 PICK_MIN_SPAN"为止（见上面那段）。
 *  ⚠ **0 也要夹、不能当成 1**：指针正好拖到锚点那一点上时倍率就是 0，
 *    当成 1 的话屏幕上就是"拖到底了它却一动不动"（而且包围盒还是原来那么大，
 *    下一次连"往哪拖"都看不出来）。shape-object.js 的 `clampFactor` 把 0 当 1
 *    是因为它那边的手势永远拿不到精确的 0（指针贴着锚点也差着几个像素）——
 *    这里不许照抄那一条。 */
function clampToSpan(f, span) {
  const lo = Number.isFinite(span) && span > 0 ? PICK_MIN_SPAN / span : 0.001
  return Math.max(lo, clampMaxFactor(f))
}
const q1 = (n) => Math.round(Number(n) * 10) / 10

/** 把一撮扁平点按 (fx,fy) 绕 anchor 缩放。压力原样带走 —— 它是"你的力道"，不是几何。 */
export function scaleFlat(points, fx, fy, anchor) {
  const flat = Array.isArray(points) ? points : []
  const ax = Number(anchor && anchor.x) || 0
  const ay = Number(anchor && anchor.y) || 0
  const out = new Array(flat.length)
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out[i] = q1(ax + (flat[i] - ax) * fx)
    out[i + 1] = q1(ay + (flat[i + 1] - ay) * fy)
    out[i + 2] = flat[i + 2]
  }
  return out
}

/** 把一撮扁平点绕 center 转 d 弧度。 */
export function rotateFlat(points, d, center) {
  const flat = Array.isArray(points) ? points : []
  const cx = Number(center && center.x) || 0
  const cy = Number(center && center.y) || 0
  const co = Math.cos(d)
  const si = Math.sin(d)
  const out = new Array(flat.length)
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const dx = flat[i] - cx
    const dy = flat[i + 1] - cy
    out[i] = q1(cx + dx * co - dy * si)
    out[i + 1] = q1(cy + dx * si + dy * co)
    out[i + 2] = flat[i + 2]
  }
  return out
}

/** 一笔按 (fx,fy) 绕 anchor 缩放：图形走参数（重烤点），普通笔迹走点。
 *  ★ 图形那条路必须走 `scaleShape` + `retargetStroke` —— 直接改点会把"这是个圆"
 *    这件事改没（文件头那条铁律：`shape` 和 `points` 任何时候都对得上）。 */
function scaleStroke(s, fx, fy, anchor, wk) {
  const width = Math.min(PICK_MAX_W, Math.max(PICK_MIN_W, q1((Number(s.width) || 0) * wk)))
  if (s.shape) {
    const next = scaleShape(s.shape, fx, fy, anchor)
    if (!next) return s
    return { ...retargetStroke(s, next), width }
  }
  return { ...s, points: scaleFlat(s.points, fx, fy, anchor), width }
}

/** 一笔绕 center 转 d：图形走参数，普通笔迹走点。线宽不变（转不改变粗细）。 */
function rotateStroke(s, d, center) {
  if (s.shape) {
    const next = rotateShape(s.shape, d, center)
    if (!next) return s
    return retargetStroke(s, next)
  }
  return { ...s, points: rotateFlat(s.points, d, center) }
}

/* 一张卡按组变换走：**尺寸**只吃几何平均（等比），**中心**吃完整的 fx/fy。
 * ★ 中心用可视中心（`cardVisualRect` 的 cx/cy）而不是 x/y —— 转过 30° 的卡，
 *   它的 x/y 是"没转那个矩形的左上角"，拿它算中心会整体偏一截。 */
function scaleCard(c, fx, fy, anchor) {
  const r = cardVisualRect(c)
  const k = nextCardScale(c, Math.sqrt(Math.abs(fx * fy)))
  const cx = anchor.x + (r.cx - anchor.x) * fx
  const cy = anchor.y + (r.cy - anchor.y) * fy
  const w = (Number(c.w) || 0) * k
  const h = (Number(c.h) || 0) * k
  return { ...c, scale: k, x: q1(cx - w / 2), y: q1(cy - h / 2) }
}

/** 一张卡绕 center 转 d：角度加在 `rot` 上，位置跟着中心转（见上面 scaleCard 那段）。 */
function rotateCard(c, d, center) {
  const r = cardVisualRect(c)
  const co = Math.cos(d)
  const si = Math.sin(d)
  const dx = r.cx - center.x
  const dy = r.cy - center.y
  const cx = center.x + dx * co - dy * si
  const cy = center.y + dx * si + dy * co
  const w = (Number(c.w) || 0) * (Number(c.scale) > 0 ? Number(c.scale) : 1)
  const h = (Number(c.h) || 0) * (Number(c.scale) > 0 ? Number(c.scale) : 1)
  return { ...c, rot: normAngle((Number(c.rot) || 0) + d), x: q1(cx - w / 2), y: q1(cy - h / 2) }
}

/* ★★ 唯一的入口：把框住的这一撮东西当成一个整体动一下。
 *   `pick` = `{ ids, cardIds }`（就是 `readSelection` 交出来的那两个字段）。
 *   `xf`   = `{ scale: { fx, fy, anchor } }` 或 `{ rotate: { d, center } }`。
 *   ⚠ 入参的 `board` 必须是**按下那一刻**的那一份（见上面 ① 那条），
 *     不是在拖的过程中不断变化的当前板 —— 那样就成了累加。 */
export function transformPick(board, pick, xf) {
  const S = asSet(pick && pick.ids)
  const C = asSet(pick && pick.cardIds)
  if ((!S.size && !C.size) || !xf || !board) return board

  if (xf.rotate) {
    const d = Number(xf.rotate.d) || 0
    const center = xf.rotate.center
    if (!d || !center) return board
    return {
      ...board,
      strokes: S.size ? board.strokes.map((s) => (S.has(s.id) ? rotateStroke(s, d, center) : s)) : board.strokes,
      cards: C.size ? (board.cards || []).map((c) => (C.has(c.id) ? rotateCard(c, d, center) : c)) : board.cards,
    }
  }

  const sp = xf.scale
  if (!sp) return board
  const anchor = sp.anchor
  if (!anchor) return board
  const box = pickBox(
    (board.strokes || []).filter((s) => S.has(s.id)),
    (board.cards || []).filter((c) => C.has(c.id))
  )
  /* 倍率夹到"这一轴还剩 PICK_MIN_SPAN"（见 PICK_MIN_SPAN 那段）——
     夹的是**倍率**，不是"算完发现太小就放弃这一帧"（那条路拖不回来，
     shape-object.js 的 `scaleShape` 为同一件事写过一整段）。 */
  const spanW = box ? Math.max(1, box.x1 - box.x0) : 1
  const spanH = box ? Math.max(1, box.y1 - box.y0) : 1
  const fx = clampToSpan(sp.fx, spanW)
  const fy = clampToSpan(sp.fy, spanH)
  /* 线宽按几何平均走（见文件上半段那条）。 */
  const wk = Math.sqrt(fx * fy)
  return {
    ...board,
    strokes: S.size ? board.strokes.map((s) => (S.has(s.id) ? scaleStroke(s, fx, fy, anchor, wk) : s)) : board.strokes,
    cards: C.size ? (board.cards || []).map((c) => (C.has(c.id) ? scaleCard(c, fx, fy, anchor) : c)) : board.cards,
  }
}

/* 「▣ 留下板框」（写进 `frames`，见 frames.js 的 freezeFrame）。
 * 这些成员会从**别的框**里被拿走（一个成员只能属于一个框）—— 不这么干，界面就能造出
 * "内存里重叠、文件里只认一个框"的状态，下次打开归属悄悄变（旧 groups 的模糊测试逮到过）。
 * `movedFrom` 是原来装着这些东西的那些框 —— 界面拿它决定提示语怎么说（"其中几笔原来在别处"）。 */
export function freezeFrameSelection(board, ids, cards = []) {
  const list = [...asSet(ids)]
  const cardList = [...asSet(cards)]
  if (!list.length && !cardList.length) return { board, movedFrom: [] }
  const S = new Set(list)
  const C = new Set(cardList)
  const movedFrom = (board.frames || []).filter(
    (f) => (f.ids || []).some((id) => S.has(id)) || (f.cards || []).some((id) => C.has(id))
  )
  return { board: freezeFrame(board, { ids: list, cards: cardList }), movedFrom }
}

/* ── 条件那一族的三个"说法"（值见 link-kinds.js 的 parseCond）──────────────
 * 条件本来是位置送的（线弧长中点旁边那几个字/那张卡）。位置会读错、也有读不到的时候，
 * 所以配了三个手动口子：
 *   vetoCond  ——「这个条件不算」（`'none'`）
 *   specCond  ——「条件就是它」（`'card:<卡 id>'` / `'ink:<笔 id>'`，你亲手指的）
 *   clearCond —— 回到按位置读（把那个字段清掉）—— **这就是上面两个口子的回头路**。
 *
 * ★ 三个口子收的都是**连接对象本身**（reader 交出来的那个 `link`），"写到哪儿"由这里决定：
 *   · 你**画**的那条：住在那一笔上（`stroke.cond`）。清要按**整条链**清 ——
 *     读的时候链里任意一笔挂着都算数（见 links.js），只清一笔的话链里还剩一笔，
 *     用户点「改回来」就像没反应（`link:'none'` 那条踩过）。
 *   · 你**连**的那条（宣告的）：它没有笔，住在**记录**上（`links[i].cond`，
 *     记录身份 = 两端那一对）。存储层一直读得出、写得出这个字段 ——
 *     从前只是**没有 writer**：三个写入口都只看 `link.strokeId`，而宣告的连接那个字段
 *     **恒为 null**，于是"点一下那颗按钮"是个**静默 no-op**（界面不动、文件不动、
 *     连一句提示都没有）。这是架构 review 候选 4 挑出来的那半件事。
 */
const linkStrokeIds = (link) => {
  const ids = link && link.ids && link.ids.length ? link.ids : [link && link.strokeId]
  return new Set(ids.filter(Boolean))
}

/* 改一条连接的条件字段：`value` 是三种说法之一，`null` = 把它清掉（回到按位置读）。
   写哪一处、以及"没变就不动原对象"这两条都在这里，调用方只管说那句话。 */
function withCond(board, link, value) {
  if (!link) return board
  if (link.declared) {
    /* 宣告的连接：记录身份就是两端那一对（和 frames.js 的 setLinkKind / removeLink 同一把钥匙）。 */
    let changed = false
    const links = (board.links || []).map((rec) => {
      if (linkId(rec.from, rec.to) !== link.id) return rec
      if (value === null) {
        if (!rec.cond) return rec
        const next = { ...rec }
        delete next.cond
        changed = true
        return next
      }
      if (rec.cond === value) return rec
      changed = true
      return { ...rec, cond: value }
    })
    return changed ? { ...board, links } : board
  }
  const ids = value === null ? linkStrokeIds(link) : new Set([link.strokeId].filter(Boolean))
  if (!ids.size) return board
  let changed = false
  const strokes = board.strokes.map((s) => {
    if (!ids.has(s.id)) return s
    if (value === null) {
      if (!s.cond) return s
      const next = { ...s }
      delete next.cond
      changed = true
      return next
    }
    if (s.cond === value) return s
    changed = true
    return { ...s, cond: value }
  })
  return changed ? { ...board, strokes } : board
}

export function vetoCond(board, link) {
  return withCond(board, link, COND_NONE)
}

export function specCond(board, link, value) {
  if (!parseCond(value)) return board
  return withCond(board, link, value)
}

export function clearCond(board, link) {
  return withCond(board, link, null)
}
