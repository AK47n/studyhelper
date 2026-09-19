/* 复制 / 粘贴：把框住的一块东西**装进剪贴板**，再落到另一块板上。
 *
 * 为什么单开一个 module：这件事的难点不在"Ctrl+C / Ctrl+V 怎么接"，
 * 而在**一块选中的东西到底是什么、跨界之后哪些 id 该跟着走** ——
 * 那是踩过坑的规矩，必须能被纯逻辑钉住（check-board 的 [6w]）。
 *
 * ── 三条规矩（每条都有理由，改之前先读）────────────────────────────────────
 *
 * ① ★ **剪贴板里只装"内容"，不装"关系"。**
 *    被复制的那几笔之间的关系（板框）跟着走 —— 因为它是**你亲手宣告的**，
 *    属于内容的一部分（"这一块是一个整体"是你要搬的一句话）。
 *    但**连接（`links`）不跟着走**：它的两端是 id，而 id 到了别的板上就是别人的东西 ——
 *    复制一份过去，那条线要么指向空气、要么指向那块板上某个碰巧同名的东西。
 *    所以规矩是：**两端都在复制范围内的连接才跟过去**（框内自洽的那种），
 *    一头在外的丢掉 —— 半条连接不是连接，画出来只会让人以为"这里本来连着"。
 *    同理，指向框外的**条件**（`cond: 'card:<id>'`）也丢掉（它指的是一样没被复制的东西）。
 *
 * ② ★ **落点用"世界坐标的相对偏移"，不是原坐标。**
 *    剪贴板里存的那份**原点归到选中内容的左上角**（`x - box.x0`）。
 *    粘贴时以"你要放的地方"为锚重新摆 —— 于是它落在你看着的那个位置，
 *    而不是原板上它当初在哪（那可能在屏幕外几屏远，用户会以为"粘贴没反应"）。
 *    ⚠ 内部所有相对关系（笔和卡的相对位置、框线）必须原样保留：
 *      所以**同一个 offset 同时作用于笔迹和卡片**，不能各归一化各的。
 *
 * ③ ★ **粘贴出来的东西一律是新的**（新 id）。这正是"贴到别的板上"能成立的前提 ——
 *    两边 id 空间不相干，撞上了会变成"粘贴一次把原来那张卡改了"
 *    （`normalizeFrames` / 关系图都按 id 认人，重 id 的后果是静默的错位）。
 *
 * ── interface ─────────────────────────────────────────────────────────────
 *   copySelection(board, ids, opts) → payload | null
 *     opts.cards  还要一起复制的卡片 id（板框里那几张卡；不传就只复制笔迹）
 *     opts.frame  这一撮笔**正好就是一个板框**时把那个框的标题也带上（见 readSelection）
 *     复制不到东西 → null（调用方别覆盖原来的剪贴板）
 *   pastePayload(board, payload, { world }) → { board, ids, cards }
 *     落点 `world` 是"粘贴中心"的世界坐标（通常= 视野中心或鼠标位置）。
 *     返回新的 board + 这次新造出来的东西的 id（界面拿它选中/提示）。
 *   payloadBounds(payload) → { w, h }   这份剪贴板有多大（提示语和居中要用）
 *
 * 这份 payload 是**纯数据**（能过 JSON），所以它天然能跨板、跨窗口、也能进 localStorage。
 * `CLIPBOARD_VERSION` 是给"以后改了形状"留的回头路：版本对不上一律当没有。 */

import { newId, newFrameId } from './board.js'
import { translateShape } from './shape-object.js'

/* 剪贴板的形状版本。读到对不上的版本 → 当"没有剪贴板"（宁可不粘，也不粘出一团乱的）。
   ⚠ 加字段**不用**动版本号（多出来的字段不认识就忽略掉，老版本照样读得动）；
     真要动是"老字段换了含义"那种时候。 */
export const CLIPBOARD_VERSION = 1

/* 一份 payload 有多宽多高（世界像素）。粘贴时拿它居中。 */
export function payloadBounds(p) {
  const box = p && p.box
  if (!box) return { w: 0, h: 0 }
  return { w: Number(box.w) || 0, h: Number(box.h) || 0 }
}

/* 这份 payload 里有多少东西（提示语用："粘贴了 12 笔 + 2 张卡"）。 */
export function payloadCount(p) {
  return {
    strokes: (p && p.strokes ? p.strokes.length : 0) + 0,
    cards: p && p.cards ? p.cards.length : 0,
    frames: p && p.frames ? p.frames.length : 0,
  }
}

/* 一块东西的包围盒（笔迹的点 + 卡片的框，**都算**）。
   和 geometry.js 的 strokesBBox 分工：那个只管笔迹（框选虚线框用它），
   这个要连卡片一起 —— 剪贴板的原点得罩住**全部**被复制的东西，
   否则卡片会被归一到负坐标、贴出来跑到锚点左上角外面。 */
function payloadBox(strokes, cards) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const eat = (x, y) => {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  for (const s of strokes) {
    const pts = s.points || []
    for (let i = 0; i + 2 < pts.length; i += 3) eat(Number(pts[i]) || 0, Number(pts[i + 1]) || 0)
  }
  for (const c of cards) {
    eat(Number(c.x) || 0, Number(c.y) || 0)
    eat((Number(c.x) || 0) + (Number(c.w) || 0), (Number(c.y) || 0) + (Number(c.h) || 0))
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * 把选中的东西打包成剪贴板内容。
 * 返回 null = **没有可复制的东西**（调用方应当保持原来那份剪贴板不动，
 * 而不是把它清空 —— 用户按 Ctrl+C 时手上没框住东西，多半是误按）。
 */
export function copySelection(board, ids, opts = {}) {
  const set = ids instanceof Set ? ids : new Set(ids || [])
  const cardSet = opts.cards instanceof Set ? opts.cards : new Set(opts.cards || [])
  if (!set.size && !cardSet.size) return null

  const strokes = (board.strokes || []).filter((s) => set.has(s.id))
  const cards = (board.cards || []).filter((c) => cardSet.has(c.id))
  if (!strokes.length && !cards.length) return null

  /* ★ 只带上"两端都在这一份里"的板框（规矩①）。
     注意成员是分开算的：笔迹成员和卡片成员各自都得在。 */
  const frames = []
  for (const f of board.frames || []) {
    const fIds = (f.ids || []).filter((id) => set.has(id))
    const fCards = (f.cards || []).filter((id) => cardSet.has(id))
    /* 一个成员都没进来 → 这个框跟这次复制无关，别带。
       只有**部分**成员进来的话也带（带上进来的那些）—— 用户框了半个框，
       他想要的是"这半个也是一个整体"，这比丢掉框的标题更接近他要的。 */
    if (!fIds.length && !fCards.length) continue
    frames.push({
      ...(typeof f.title === 'string' && f.title.trim() ? { title: f.title.trim() } : {}),
      ids: fIds,
      cards: fCards,
    })
  }

  /* 指向框外的条件丢掉（规矩①的后半）。`cond` 有两种形状：
       'none'（"这个条件不算"）跟内容走 —— 它说的是**这一笔自己**，不指别人；
       'card:<id>' / 'ink:<id>' 指另一样东西，那样没被复制的话就得丢。 */
  const inside = (v) => {
    if (!v || v === 'none') return true
    const s = String(v)
    if (s.startsWith('card:')) return cardSet.has(s.slice(5))
    if (s.startsWith('ink:')) return set.has(s.slice(4))
    return false
  }
  const keepCond = (s) => {
    if (!s.cond || !inside(s.cond)) {
      const next = { ...s }
      delete next.cond
      return next
    }
    return s
  }

  const box = payloadBox(strokes, cards)
  if (!box) return null

  /* ★ 把原点挪到选中内容的左上角（规矩②）——
     存的是**相对坐标**，于是它贴到哪儿都能原样摆出来。 */
  const ox = box.x0
  const oy = box.y0

  return {
    v: CLIPBOARD_VERSION,
    /* 从哪里来（提示语用得上："从《8.2》复制来的"）。**只是个名字**，不参与任何计算。 */
    from: typeof board.title === 'string' ? board.title : '',
    box: { w: box.w, h: box.h },
    /* 笔迹：点整体平移。**点结构一个字不改** —— 扁平数组原样搬，
       它已经是这个应用内部唯一的形状（见 board.js 那条"内存里必须是扁平数组"）。 */
    strokes: strokes.map((s) => {
      const k = keepCond(s)
      const pts = []
      const src = k.points || []
      for (let i = 0; i + 2 < src.length; i += 3) {
        pts.push((Number(src[i]) || 0) - ox, (Number(src[i + 1]) || 0) - oy, Number(src[i + 2]) || 0)
      }
      /* ⚠ `link`（连接那个词）跟不跟着走？**跟** —— 它说的是"这一笔自己是什么关系"，
         不指别人，所以它和 cond:'none' 是同一类（内容自身的属性）。
         而它到了别的板上，那条线的两端照样要重新按内容读出来（连接是**读**的）。 */
      /* ★ 图形那一笔（`shape`，见 shape-object.js）的**参数也要一起搬**：
         只搬 `points` 是不够的 —— 读盘时点会被 `shape` **重烤一遍**
         （那条不变量在 board.js 的 normalizeStroke 里），于是没跟着搬的 `shape`
         会把这一块**拽回原板上的位置**。症状是"复制一个圆、贴出来它跑回原处"，
         而笔迹的点、包围盒、提示语**全都是对的** —— 又是一条静默故障。
         ★ 走 `translateShape` 而不是"我自己减一下 cx/cy"：三角形搬的是三个顶点、
           直线搬的是两个端点、圆搬的是圆心 —— 一条 if 写在两处就会有一天只改一处。 */
      const moved = { ...k, points: pts }
      if (k.shape) {
        const sh = translateShape(k.shape, -ox, -oy)
        if (sh) moved.shape = sh
        else delete moved.shape
      }
      return moved
    }),
    cards: cards.map((c) => ({ ...c, x: (Number(c.x) || 0) - ox, y: (Number(c.y) || 0) - oy })),
    frames: frames.map((f) => ({
      ...f,
      /* ★ 框的成员 id 也要换成"这一份里的新 id"吗？
         不 —— 这里先留着**原来的 id**，由 pastePayload 在造新东西的时候按 id 映射过去。
         为什么不在这一步就映射：这一步还不知道新 id 是什么（那是粘贴时才生成的），
         提前编一套临时 id 再映射一次，等于同一个东西在三个地方各有一套名字。 */
      ids: f.ids,
      cards: f.cards,
    })),
  }
}

/* 这份 payload 是不是能用的（形状 + 版本都对）。
   ⚠ 从 localStorage / 别的窗口拿回来的东西**必须过这一关** ——
     它可能是被别的东西写坏的、也可能是更老版本留下的。 */
export function isPayload(p) {
  if (!p || typeof p !== 'object') return false
  if (p.v !== CLIPBOARD_VERSION) return false
  if (!Array.isArray(p.strokes) || !Array.isArray(p.cards) || !Array.isArray(p.frames)) return false
  return p.strokes.length + p.cards.length > 0
}

/**
 * 把一份 payload 贴进 board，落点是 `world`（世界坐标）。
 * 返回 { board, ids, cards, frames } —— 新造出来的那些东西的 id
 * （界面拿它设焦点 / 报数，撤销由调用方的 `commit` 管）。
 */
export function pastePayload(board, payload, opts = {}) {
  if (!isPayload(payload)) return null
  const cx = Number(opts.world && opts.world.x) || 0
  const cy = Number(opts.world && opts.world.y) || 0
  const { w, h } = payloadBounds(payload)

  /* 落点 = 以 `world` 为中心。于是"粘贴"就是"放在我正看着的这个地方"。
     加个 round：存盘时本来就只留一位小数（见 board.js），
     这里不圆的话每次粘贴都会在数据里多出几位无意义的尾数。 */
  const ox = Math.round(cx - w / 2)
  const oy = Math.round(cy - h / 2)

  /* ★ 旧 id → 新 id 的映射表（规矩③）。**先建完再动内容** ——
     板框的成员要用它换名，换的时候必须两张表都齐了。 */
  const strokeIdMap = new Map()
  const cardIdMap = new Map()

  const strokes = payload.strokes.map((s) => {
    const id = newId('s')
    strokeIdMap.set(s.id, id)
    const pts = []
    const src = s.points || []
    for (let i = 0; i + 2 < src.length; i += 3) {
      pts.push(Math.round(((Number(src[i]) || 0) + ox) * 10) / 10, Math.round(((Number(src[i + 1]) || 0) + oy) * 10) / 10, Number(src[i + 2]) || 0)
    }
    /* ★ 图形那一笔：参数跟着落点一起搬（和 copySelection 里那一段是同一句话，
       那边搬的是 `-ox/-oy`、这边是 `+ox/+oy`）。漏了它的症状是
       "贴出来的圆跑到原板上它待过的位置" —— 因为读盘时点按 shape 重烤。 */
    const out = { ...s, id, points: pts }
    if (s.shape) {
      const sh = translateShape(s.shape, ox, oy)
      if (sh) out.shape = sh
      else delete out.shape
    }
    return out
  })
  const cards = payload.cards.map((c) => {
    const id = newId(c.kind === 'formula' ? 'f' : 'n')
    cardIdMap.set(c.id, id)
    return { ...c, id, x: Math.round((Number(c.x) || 0) + ox), y: Math.round((Number(c.y) || 0) + oy) }
  })

  /* ★ 条件的第二种说法（"条件就是它"）在**笔上**指的是别的 id —— 上面的 keepCond
     已经按"在不在复制范围里"筛过一遍，但**它筛的是旧 id、这里必须换成新 id**。
     漏了这一步的症状：粘贴出来的那一笔带着一个指向原板某张卡的条件，
     换一块板之后那个 id 不存在 → 条件读不出来（而且文件里多了一个死引用）。 */
  const retarget = (s, map, prefix) => {
    if (!s.cond) return s
    const str = String(s.cond)
    if (!str.startsWith(prefix)) return s
    const next = map.get(str.slice(prefix.length))
    if (!next) {
      const copy = { ...s }
      delete copy.cond
      return copy
    }
    return { ...s, cond: prefix + next }
  }
  const strokesFinal = strokes.map((s) => retarget(retarget(s, cardIdMap, 'card:'), strokeIdMap, 'ink:'))

  /* 板框：成员按映射表换名，**换不到的整个丢掉**（成员 id 换了名就是死引用，
     会在下次读盘时被 normalizeFrames 静默清掉 —— 与其让它经过一次"文件里写着、
     内存里没有"的中间状态，不如在这里就换干净）。 */
  const frames = []
  for (const f of payload.frames || []) {
    const ids = (f.ids || []).map((id) => strokeIdMap.get(id)).filter(Boolean)
    const fCards = (f.cards || []).map((id) => cardIdMap.get(id)).filter(Boolean)
    if (!ids.length && !fCards.length) continue
    frames.push({
      id: newFrameId(),
      ...(f.title ? { title: f.title } : {}),
      ids,
      cards: fCards,
    })
  }

  /* ★ 一个成员只属于一个框（board.js 那条不变量）—— 粘贴进来的框只包含**新造的**
     那些 id，所以天然不会和板上原有的框撞。但两个粘贴出来的框之间可能重叠吗？
     不会：payload 里每个成员只出现在一个框里（copySelection 就是这么筛的）。 */

  return {
    board: {
      ...board,
      strokes: [...(board.strokes || []), ...strokesFinal],
      cards: [...(board.cards || []), ...cards],
      frames: [...(board.frames || []), ...frames],
    },
    ids: strokesFinal.map((s) => s.id),
    cards: cards.map((c) => c.id),
    frames: frames.map((f) => f.id),
  }
}
