/* ═══════════ 板框 / 连接：你对它们说的那几句话 ═══════════
 *
 * 一张板框**长什么样、怎么读写**在 board.js（`normalizeFrames` / `normalizeLinks`）；
 * 这里只装**动作**：
 *   · 板框：留下 / 加进来 / 拿出去 / 改标题 / 拆开 / 整体挪一下 / 清理死成员；
 *   · 连接：连上 / 换个词 / 删掉（见 ADR-0001）。
 *
 * 全是**纯函数**（board 进、board 出，不改原对象），所以 scripts/check-board.js
 * 在 node 里就能把它们钉住 —— 和 selection.js 一个路子。
 *
 * ★ 为什么这些动作要收在一个 module 里，而不是散在界面的各个处理器里：
 *   「一个成员只能属于一个框」这条规矩必须在**每一个写入口**都成立。散着写的话，
 *   界面能造出"内存里一笔在两个框、文件里只认一个框"的状态 —— 存→读→再存不一致，
 *   下次打开归属悄悄变一个样（当年旧的 `groups` 就是被模糊测试这么逮到的）。
 *   规矩只写一遍，界面只负责调 + 说一句话。
 *
 * ★ 板框和连接**没有**"存一份坐标"这回事：框线按成员包围盒现算（geometry.js 的
 *   frameBounds），箭头两端按框/卡的边现算（links.js 的 readDeclaredLinks）。
 *   所以"整体挪一下"挪的是**成员**，不是框。
 */
import { linkId, newFrameId } from './board.js'
import { cardBounds, frameBounds, pointInRect, toFlat } from './geometry.js'
import { ARROW_LINK, isLinkKind } from './link-kinds.js'

/* 一个东西属于哪个框（笔迹和卡片都问这一个入口）。不属于任何框 → null。 */
export function frameOf(board, itemId) {
  if (!itemId) return null
  for (const f of (board && board.frames) || []) {
    if ((f.ids || []).includes(itemId) || (f.cards || []).includes(itemId)) return f
  }
  return null
}

export function frameById(board, frameId) {
  return ((board && board.frames) || []).find((f) => f.id === frameId) || null
}

/* 一个框里的成员对象（面板和渲染层要拿它们算框线）。 */
export function frameMembers(board, frame) {
  const S = new Set((frame && frame.ids) || [])
  const C = new Set((frame && frame.cards) || [])
  return {
    strokes: ((board && board.strokes) || []).filter((s) => S.has(s.id)),
    cards: ((board && board.cards) || []).filter((c) => C.has(c.id)),
  }
}

/* 把成员从**别的框**里拿走，并且把被拿空的框删掉（不留空壳）。
   每一次写入口都先过这一道 —— 这就是"一个成员只属于一个框"那条规矩的唯一实现。 */
function detach(board, ids, cards) {
  const S = new Set(ids)
  const C = new Set(cards)
  const out = []
  for (const f of (board && board.frames) || []) {
    const keepIds = (f.ids || []).filter((id) => !S.has(id))
    const keepCards = (f.cards || []).filter((id) => !C.has(id))
    if (!keepIds.length && !keepCards.length) continue
    out.push(keepIds.length === (f.ids || []).length && keepCards.length === (f.cards || []).length ? f : { ...f, ids: keepIds, cards: keepCards })
  }
  return out
}

/* 「▣ 留下板框」：圈住的这些东西从**这一刻**起属于它。
   ★ 只在**这一刻**判定归属 —— 以后你往框里再画一笔，它不会自己变成成员
     （那又变成"位置猜"，而这次的整个教训就是别猜；想加就明说，见 addToFrame）。 */
export function freezeFrame(board, { ids = [], cards = [], title = '' } = {}) {
  const S = [...new Set(ids)]
  const C = [...new Set(cards)]
  if (!S.length && !C.length) return board
  const rest = detach(board, S, C)
  const t = String(title == null ? '' : title).trim()
  rest.push({ id: newFrameId(), ...(t ? { title: t } : {}), ids: S, cards: C })
  return { ...board, frames: rest }
}

/* 明说"这几个也加进这个框"（框选之后按同一颗按钮，或者以后别的手动口子）。 */
export function addToFrame(board, frameId, { ids = [], cards = [] } = {}) {
  const f = frameById(board, frameId)
  if (!f) return board
  const S = [...new Set([...(f.ids || []), ...ids])]
  const C = [...new Set([...(f.cards || []), ...cards])]
  const rest = detach(board, [...ids], [...cards]).filter((x) => x.id !== frameId)
  /* 保持它在原数组里的位置（顺序稳定 = 渲染顺序稳定、文件的 diff 小）。 */
  const at = ((board && board.frames) || []).findIndex((x) => x.id === frameId)
  rest.splice(at < 0 ? rest.length : Math.min(at, rest.length), 0, { ...f, ids: S, cards: C })
  return { ...board, frames: rest }
}

/* 从框里拿出来（框空了就自己消失）。 */
export function takeOutOfFrame(board, { ids = [], cards = [] } = {}) {
  if (!ids.length && !cards.length) return board
  return { ...board, frames: detach(board, [...ids], [...cards]) }
}

/* 「⧉ 拆开」：把这个框散掉（成员照旧留在板上）。 */
export function dissolveFrame(board, frameId) {
  const fs = ((board && board.frames) || []).filter((f) => f.id !== frameId)
  return fs.length === ((board && board.frames) || []).length ? board : { ...board, frames: fs }
}

export function setFrameTitle(board, frameId, title) {
  const t = String(title == null ? '' : title).trim()
  let hit = false
  let changed = false
  const frames = ((board && board.frames) || []).map((f) => {
    if (f.id !== frameId) return f
    hit = true
    const was = String(f.title || '').trim()
    if (was === t) return f
    changed = true
    const next = { ...f }
    if (t) next.title = t
    else delete next.title
    return next
  })
  /* 标题没变就**原样返回**：不然"点开又回车"会白记一步撤销、
     还会让自动存盘写一次一样的文件（那条"每天一条假 diff"的老账）。 */
  return hit && changed ? { ...board, frames } : board
}

/* 把整个框（连同里面的东西）平移。★ 挪的是**成员**：框线是成员的函数，跟着走。 */
export function translateFrame(board, frameId, dx, dy) {
  const f = frameById(board, frameId)
  if (!f || (!dx && !dy)) return board
  const S = new Set(f.ids || [])
  const C = new Set(f.cards || [])
  const shift = (points) => {
    const flat = toFlat(points)
    const out = new Array(flat.length)
    for (let i = 0; i < flat.length; i += 3) {
      out[i] = flat[i] + dx
      out[i + 1] = flat[i + 1] + dy
      out[i + 2] = flat[i + 2]
    }
    return out
  }
  return {
    ...board,
    strokes: ((board && board.strokes) || []).map((s) => (S.has(s.id) ? { ...s, points: shift(s.points) } : s)),
    cards: ((board && board.cards) || []).map((c) => (C.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c)),
  }
}

/* 成员被删掉之后清理（擦笔、删卡走的是别的路）：
   把已经不在板上的成员从框里摘掉，空掉的框自己消失。读盘和存盘时也会各滤一次
   （board.js 的 normalizeFrames / serializeBoardDocument），这里是**内存里**那一次 ——
   不然屏幕上会出现一个围着空气的框。 */
export function pruneFrames(board) {
  const liveS = new Set(((board && board.strokes) || []).map((s) => s.id))
  const liveC = new Set(((board && board.cards) || []).map((c) => c.id))
  const frames = []
  let changed = false
  for (const f of (board && board.frames) || []) {
    const ids = (f.ids || []).filter((id) => liveS.has(id))
    const cards = (f.cards || []).filter((id) => liveC.has(id))
    if (!ids.length && !cards.length) {
      changed = true
      continue
    }
    if (ids.length !== (f.ids || []).length || cards.length !== (f.cards || []).length) {
      changed = true
      frames.push({ ...f, ids, cards })
      continue
    }
    frames.push(f)
  }
  return changed ? { ...board, frames } : board
}

/* ═══════════ 连接（你宣告的那条关系） ═══════════
 *
 * 见 ADR-0001：形状/位置猜出来的连接不存，`links` 里只有你亲口说过的话。
 * 一条记录 = 两端（卡片或板框的 id）+ 一个词；有序（「因果」有方向）。
 */

/* 连上两端（同一个有序对只留一条：先有的那条赢，返回原 board —— 调用方靠这个判"什么都没发生"）。 */
export function declareLink(board, from, to, kind = ARROW_LINK) {
  if (!from || !to || from === to) return board
  const known = (id) =>
    ((board && board.cards) || []).some((c) => c.id === id) || ((board && board.frames) || []).some((f) => f.id === id)
  if (!known(from) || !known(to)) return board
  const links = (board && board.links) || []
  if (links.some((l) => linkId(l.from, l.to) === linkId(from, to))) return board
  return { ...board, links: [...links, { from, to, kind: isLinkKind(kind) ? kind : ARROW_LINK }] }
}

export function linkOf(board, from, to) {
  return (((board && board.links) || []).find((l) => linkId(l.from, l.to) === linkId(from, to))) || null
}

/* ── 松手时"这一头落在谁身上"（箭头工具的吸附）─────────────────────────────
 *
 * 和从前那套位置判据的区别，一句话：**只认你亲眼看得见的那些方块** ——
 * 卡片和板框，都是"有边框的东西"。不再去猜"这一撮墨是不是一个东西"
 * （墨迹块那套在真实笔迹上 92:0，见 ADR-0001）。
 *
 * 判据两条，顺序是有意的：
 *   ① **点在框里** → 直接赢，而且**卡片比板框优先**（卡片更具体：一张卡可以落在板框里，
 *      那时候你指的是那张卡，不是外面那个大框）；
 *   ② 都不在里面 → 离**边**最近的那个（≤ radius 世界像素）才算。
 * 半径给得宽（40px）：手画的箭头**常常停在东西前面一点**（尖得留出画 V 的地方），
 * 而"停在前面"和"没连上"在手感上是两件事。 */
export const ARROW_SNAP = 40

export function snapNode(board, p, radius = ARROW_SNAP) {
  if (!p) return null
  const cards = ((board && board.cards) || []).map((c) => ({ kind: 'card', id: c.id, label: '', box: cardBounds(c) }))
  const frames = ((board && board.frames) || [])
    .map((f) => ({ kind: 'frame', id: f.id, label: f.title ? String(f.title) : '板框', box: frameBounds(board, f) }))
    .filter((x) => x.box)
  for (const list of [cards, frames]) {
    const inside = list.find((n) => pointInRect(p, n.box))
    if (inside) return inside
  }
  let best = null
  let bd = radius
  for (const list of [cards, frames]) {
    for (const n of list) {
      const dx = Math.max(n.box.x - p.x, 0, p.x - (n.box.x + n.box.w))
      const dy = Math.max(n.box.y - p.y, 0, p.y - (n.box.y + n.box.h))
      const d = Math.hypot(dx, dy)
      if (d <= bd) {
        bd = d
        best = n
      }
    }
  }
  return best
}

/* 换个词（点线上那颗词、或者那排词里选一个）。 */
export function setLinkKind(board, from, to, kind) {
  if (!isLinkKind(kind)) return board
  let hit = false
  const links = ((board && board.links) || []).map((l) => {
    if (linkId(l.from, l.to) !== linkId(from, to)) return l
    hit = true
    return { ...l, kind }
  })
  return hit ? { ...board, links } : board
}

/* 「删掉这条连接」（那排词里 `0` 那颗位置）。 */
export function removeLink(board, from, to) {
  const links = ((board && board.links) || []).filter((l) => linkId(l.from, l.to) !== linkId(from, to))
  return links.length === ((board && board.links) || []).length ? board : { ...board, links }
}
