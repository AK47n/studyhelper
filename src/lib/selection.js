/* 选中这一族：框住的那些笔**意味着什么**，以及你能对它说的那几句话。
 *
 * 为什么单开一个 module（2026-09-16 架构 review 的 C3）：
 *   "框住一笔之后能干什么"这件事，从前散在三个地方 ——
 *   Board.jsx 里 5 个 useMemo（`selLink` / `inkNoLink` / `inkGroup` / `inkBox` / `inkStrokes`）
 *   加 6 个处理器（删 / 改词 / 反向 / 否决 / 回头路 / 固定 / 拆开）、
 *   BoardCanvas 里 3 段各自 `{xx && …}` 的条件渲染，外加 11 个 prop。
 *   而这里面全是**踩过坑的规矩**，却没有一条在纯逻辑里钉得住：
 *     · 「不算连接」要写在**整条链**上（`chainOfStroke`），只清框住那一笔 =
 *       点了按钮什么都没发生（审查挑出来的那条）；
 *     · 选的那个词**正好等于形状读出来的** → **不写字段**（一条没动过的连接是零字节）；
 *     · ⇄ 反向 = 把这笔的点**倒过来**（方向就是"第一点 → 最后一点"），
 *       而反向之后形状变了，得退回**单笔**判断（连接层那个 auto 是给没反向时用的）；
 *     · 框住"正好一整块"才算那一块（少一笔都不算，不然框一大片会顺手把某块拆了）；
 *     · 固定一块时要把这些笔从**别的块**里拿走（一笔只能属于一个组）。
 *   现在这些规矩都在这里，一处、可断言：读（`readSelection`）+ 写（下面那 5 个纯函数）。
 *
 * ── interface ─────────────────────────────────────────────────────────────
 *   readSelection(board, ids, links) → {
 *     ids, count, empty, strokes, box,
 *     link,     // 框里**正好一条**连接线时是那条连接（改词那排的入口），否则 null
 *     noLink,   // 框住的笔里有没有"你说过不算连接"的（有就给一条回头路）
 *     group,    // 框住的这些笔**正好就是**某一块固定块吗（是 → 浮层给「拆开这块」）
 *   }
 *   applyStrokeLink(board, links, strokeId, kind, { reverse }) → board' | null
 *     kind = 词表里的词 → 写/清那个字段；kind = LINK_NONE → 写在整条链上；
 *     词不认识 → **null**（什么都没改，调用方也别弹提示）。
 *   clearNoLinkMarks(board, ids) → board'   按**整条链**把 `link:'none'` 清掉（回头路）
 *   removeStrokes(board, ids) → board'      删掉这些笔（一步撤销交给调用方）
 *   freezeSelection(board, ids) → { board, movedFrom }   固定成一块；movedFrom 是被挪过的别的块
 *   dissolveGroup(board, groupId) → board'  拆开一块
 * 这些函数都是**纯的**：不动原对象、只返回新的 board（约定见 board.js 顶部）。
 */

import { freezeGroup } from './board.js'
/* 点 / 几何 / 关系搬去了 geometry.js（2026-09-16 架构 review 的 C5）。 */
import { strokesBBox } from './geometry.js'
import { autoLinkKind, chainOfStroke } from './links.js'
import { LINK_NONE, isLinkKind } from './link-kinds.js'

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

  /* 框住的笔里有没有"你说过不算连接"的 —— 有就给它一条回头路
     （不然那句话是单向门：点完只能 Ctrl+Z，重开之后就没路可走了）。 */
  const noLink = strokes.some((s) => s.link === LINK_NONE)

  /* 框住的这些笔**正好就是**某一块固定块吗？判据是"集合完全相等"：
     少一笔都不算 —— 不然框一大片会把某块顺手拆了。 */
  let group = null
  for (const g of board.groups || []) {
    if (g.ids.length !== set.size) continue
    if (g.ids.every((id) => set.has(id))) {
      group = g
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
    noLink,
    group,
  }
}

/* 改一条连接的词。opt.reverse = ⇄ 反向。
 * ★ 「不算连接」（LINK_NONE）走的是另一条语义：它回答的是"它根本不是关系"，
 *   而且**要写在整条链上**（那一笔可能只是链里的一段）—— 跟"是什么关系"那排词不是一回事。 */
export function applyStrokeLink(board, links, strokeId, kind, opt = {}) {
  const byStroke = linkMap(links)

  if (kind === LINK_NONE) {
    const known = byStroke.get(strokeId)
    const ids = new Set(known ? known.ids : [strokeId])
    return { ...board, strokes: board.strokes.map((st) => (ids.has(st.id) ? { ...st, link: LINK_NONE } : st)) }
  }
  if (!isLinkKind(kind)) return null // 词不认识：什么都没改

  return {
    ...board,
    strokes: board.strokes.map((st) => {
      if (st.id !== strokeId) return st
      /* ⇄ 反向 = 把这笔的点**倒过来**。倒过来渲染出来一模一样（都是同一条路径），
         但"第一点 → 最后一点"变了 —— 箭头方向就是靠这个表达的，所以不用另存一个方向字段。 */
      const points = opt.reverse ? reverseFlat(st.points) : st.points
      /* ★ auto 取**连接这一层**读出来的那个（buildLinks 的结果），不是单看这一笔：
         用户的箭头常常是"一杆 + 一个 V 尖"两笔画的 —— 单看那根杆永远是"相关"，
         只有连接层知道旁边那个尖是它的。所以选"因果"时不能写进文件（写进去就是噪音，
         而且以后擦掉尖它也不会自己回来）。
         ⇄ 反向时形状变了（回勾跑到另一头去），这时退回单笔判断。 */
      const known = byStroke.get(strokeId)
      const auto = !opt.reverse && known ? known.auto : autoLinkKind({ ...st, points })
      const next = { ...st, points }
      /* ★ 选的就是"形状自动读出来那一档" → **不写这个字段**（回到自动）。
         于是文件里只有"你特意改过的"那几个词：一条没动过的连接是零字节，
         老文件也不会因为我们加了这个功能而变脏。 */
      if (kind === auto) delete next.link
      else next.link = kind
      return next
    }),
  }
}

/* 把"不算连接"改回来：去掉 `link: 'none'` → 回到按形状自动判（那道单向门的回头路）。
 * ★ 要按**整条链**清（`chainOfStroke`），不能只清框住的那一笔：
 *   `link:'none'` 当初是写在整条链上的，链里还剩一笔 none，buildLinks 仍然整条跳过 ——
 *   用户点了按钮却什么都没发生（审查挑出来的）。 */
export function clearNoLinkMarks(board, ids) {
  const set = asSet(ids)
  if (!set.size) return board
  const all = new Set()
  for (const id of set) for (const cid of chainOfStroke(board, id)) all.add(cid)
  return {
    ...board,
    strokes: board.strokes.map((st) => {
      if (!all.has(st.id) || st.link !== LINK_NONE) return st
      const next = { ...st }
      delete next.link
      return next
    }),
  }
}

/** 删掉这些笔（撤销栈由调用方管：这是"一步"操作）。 */
export function removeStrokes(board, ids) {
  const set = asSet(ids)
  if (!set.size) return board
  return { ...board, strokes: board.strokes.filter((s) => !set.has(s.id)) }
}

/* 固定成一块（写进 `groups`）。`freezeGroup` 会把这些笔从**别的块**里拿走
 * （一笔只能属于一个组）—— 不这么干，界面就能造出"内存里重叠、文件里只认一笔"的状态，
 * 下次打开分组悄悄变（模糊测试逮到过）。
 * `movedFrom` 是原来装着这些笔的那些块 —— 界面拿它决定提示语怎么说（"其中几笔原来在别处"）。 */
export function freezeSelection(board, ids) {
  const list = [...asSet(ids)]
  if (!list.length) return { board, movedFrom: [] }
  const set = new Set(list)
  const movedFrom = (board.groups || []).filter((g) => g.ids.some((id) => set.has(id)))
  return { board: { ...board, groups: freezeGroup(board.groups, list) }, movedFrom }
}

/** 拆开一块（把这条组整个去掉）。 */
export function dissolveGroup(board, groupId) {
  if (!groupId) return board
  return { ...board, groups: (board.groups || []).filter((g) => g.id !== groupId) }
}
