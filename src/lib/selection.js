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
 *   readSelection(board, ids, links) → {
 *     ids, count, empty, strokes, box,
 *     link,     // 框里**正好一条**连接线时是那条连接（改词那排的入口），否则 null
 *     frame,    // 框住的这些笔**正好就是**某个板框吗（是 → 浮层给「拆开这个框」）
 *   }
 *   applyStrokeLink(board, links, strokeId, kind, { reverse }) → board' | null
 *     kind = 词表里的词 → 写/清那个字段；词不认识 → **null**（什么都没改，调用方也别弹提示）。
 *   removeStrokes(board, ids) → board'      删掉这些笔（顺手把板框里的死成员摘掉）
 *   freezeFrameSelection(board, ids, cards) → { board, movedFrom }   留下板框；movedFrom 是被挪过的别的框
 *   这些函数都是**纯的**：不动原对象、只返回新的 board（约定见 board.js 顶部）。
 *   「拆开一个板框」在 frames.js 的 `dissolveFrame`（它只认 board + frameId）。
 *   `clearNoLinkMarks`（"又算回连接"）第二刀删掉了 —— 见下面那段说明。 */

/* 板框那一族（留下 / 拆开 / 改标题 / 整体挪）搬去了 frames.js（2026-09-17）：
   从前的 `groups`（"固定成一块"）在这里，现在它长成了板框 —— 成员多了卡片、多了标题，
   所以规矩跟着那个概念一起走，这个 module 只管"**框住**这一撮笔意味着什么"。 */
import { freezeFrame, pruneFrames } from './frames.js'
/* 点 / 几何 / 关系搬去了 geometry.js（2026-09-16 架构 review 的 C5）。 */
import { strokesBBox } from './geometry.js'
/* 连接记录的身份（`linkId(from, to)`）—— 条件的第三个说法住在 `links[i]` 上，
   找那一条记录用的就是这把钥匙（和 frames.js / links.js 同一把）。 */
import { linkId } from './board.js'
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

export function readSelection(board, ids, links = []) {
  const set = asSet(ids)
  const strokes = set.size ? (board.strokes || []).filter((s) => set.has(s.id)) : []
  const byStroke = linkMap(links)

  /* 框里**正好只有一条**连接线 → 那条（改词的入口）。
     两条线就不是"这条线"了 —— 那时候该让用户框窄一点，而不是替他挑一条。 */
  let link = null
  if (set.size === 1) for (const id of set) link = byStroke.get(id) || null

  /* 框住的这些笔**正好就是**某个板框的笔吗？判据是"集合完全相等"：
     少一笔都不算 —— 不然框一大片会把某个框顺手拆了。
     （框里可以还有卡片成员：卡片框不进来，所以只比笔迹这一半。） */
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
    count: set.size,
    empty: set.size === 0,
    strokes,
    box: set.size ? strokesBBox(strokes) : null,
    link,
    frame,
  }
}

/* 改一条连接（你画出来的那条线）的词。opt.reverse = ⇄ 反向。
 * ★ 第二刀之后这里只剩"是什么关系"这一件事：「不算连接」连同形状判读一起删掉了
 *   （见 ADR-0001）—— 现在"删掉这条连接"由 Board.jsx 直接调用 removeStrokes。 */
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

/** 删掉这些笔（撤销栈由调用方管：这是"一步"操作）。
 *  顺手把板框里的**死成员**摘掉（框围着空气的样子很怪），空掉的框自己消失。 */
export function removeStrokes(board, ids) {
  const set = asSet(ids)
  if (!set.size) return board
  return pruneFrames({ ...board, strokes: board.strokes.filter((s) => !set.has(s.id)) })
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
