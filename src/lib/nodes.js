/* 端点：板上**能当一条连接的两端**的东西 —— 卡片和板框。
 *
 * 为什么单开一个 module（2026-09-17 架构 review 的候选 2）：
 *   ADR-0001 把"谁是端点"定成这个功能的核心一句话，可这句话**没有家** ——
 *   它被写在五个地方：解析时过滤死 id（board.js）、写盘时再过滤一遍（board.js）、
 *   宣告时校验（frames.js 的 known）、免费路上"线头落在哪张卡里"（links.js 的 cardAt）、
 *   渲染时按 id 取名字（links.js 的 nodeFor）。而"这一点落在谁身上"又有三个半径：
 *   8（免费路宽容）/ 40（箭头工具吸附）/ 64（条件搜索），各写各的。
 *   漏改一处不是崩溃，是**静默**：内存里画着、文件里没了，或者反过来。
 *
 * ★ 它就是"板上的东西"这一层的**读**接口。写（增删改）还在 board.js / frames.js。
 * ★ 不 import React、不碰 DOM：只用传进来的 board（和 geometry.js 的框计算）。
 * ★ 三个半径住在**这里**（各自带着理由）—— 它们是"这一点落在谁身上"的政策，
 *   不是某个调用方的私事。
 */
import { cardBounds, frameBounds, pointInRect, rectCenter, rectDist } from './geometry.js'

/* 免费路（"卡↔卡画一条线即成立"）：手画的线常常差一点点才碰到卡片边 ——
   宽容 8 世界像素是 2026-09-16 量的，ADR-0001 之后一个字没动它
   （那条路是这堆机制里唯一没有假阳性的部分）。 */
export const CARD_HIT_PAD = 8

/* 箭头工具的吸附半径：手画的箭头**常常停在东西前面一点**（尖要留出画 V 的地方），
   而"停在前面"和"没连上"在手感上是两件事。40 是这么来的。 */
export const ARROW_SNAP = 40

/* 条件搜索半径：写在中点旁边那几个字才跟这条线有关系，64 之外就不算。 */
export const COND_SEARCH = 64

/* 板上所有端点，分两类摆好。`box` 是**世界坐标**的框；`label` 是显示名：
   卡片没有名字（空串，屏上不写字），板框用你起的标题、没起就叫"板框"。
   ⚠ 框的成员全没了的板框在内存里是中间态：`frameBounds` 给 null，这里**整个略掉**
     （绝不画一条"指向空气"的箭头，也不让它当端点）。 */
export function nodeList(board) {
  const cards = (((board && board.cards) || [])).map((c) => ({ kind: 'card', id: c.id, label: '', box: cardBounds(c) }))
  const frames = (((board && board.frames) || []))
    .map((f) => ({ kind: 'frame', id: f.id, label: f.title ? String(f.title) : '板框', box: frameBounds(board, f) }))
    .filter((n) => n.box)
  return { cards, frames }
}

/* 按 id 取那一个（渲染宣告连接、取名字都用它）。找不到 → null。 */
export function nodeById(board, id) {
  if (!id) return null
  const { cards, frames } = nodeList(board)
  return cards.find((n) => n.id === id) || frames.find((n) => n.id === id) || null
}

/* 点到框**边**的距离（在框里就是 0）。= geometry.rectDist 的"零尺寸矩形"情形 ——
   同一个公式，别在调用方再内联一份（这一条以前抄了三遍）。 */
export function edgeDist(box, pt) {
  return rectDist(box, { x: pt.x, y: pt.y, w: 0, h: 0 })
}

/* 这一点落在谁身上。
 *
 * 判据两条，顺序是有意的（ADR-0001）：
 *   ① **进框优先**，而且**卡片比板框优先** —— 卡片更具体：一张卡可以落在板框里，
 *      那时候你指的是那张卡，不是外面那个大框；
 *   ② 都不在框里 → 离**边**最近的那个，且 ≤ `radius`（默认 0 = 只认框里）。
 *      距离相同时**先来的赢**（卡片在前），和 ① 是同一条政策。
 *
 * opts:
 *   kinds    只找哪几种（默认两种都找）。免费路只要卡片：`['card']`
 *   pad      进框判定往外放宽多少**世界**像素（默认 0）—— 只有免费路用 8
 *   radius   不在框里时的容忍半径（默认 0）
 *   exclude  不算的那些 id（条件要跳过这条关系自己的两端）
 */
export function nodeAt(board, p, opts = {}) {
  if (!p) return null
  const kinds = opts.kinds || ['card', 'frame']
  const pad = Number(opts.pad) || 0
  const radius = Number(opts.radius) || 0
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || [])
  const { cards, frames } = nodeList(board)
  const list = [...(kinds.includes('card') ? cards : []), ...(kinds.includes('frame') ? frames : [])].filter(
    (n) => !exclude.has(n.id)
  )
  /* ① 进框（卡片在前 → 卡片优先） */
  for (const n of list) {
    if (pointInRect(p, n.box, pad)) return n
  }
  if (!(radius > 0)) return null
  /* ② 离边最近的那个（严格更近才换 → 距离相同保先来的） */
  let best = null
  let bd = Infinity
  for (const n of list) {
    const d = edgeDist(n.box, p)
    if (d > radius) continue
    if (d < bd) {
      bd = d
      best = n
    }
  }
  return best
}

/* 两个框之间的"边点"：从 towards 看过来，线要打在**边**上而不是中心 ——
   连中心的话那条线会穿过卡片自己的边框，屏幕上脏得很（尤其卡片不透明时）。
   长宽谁先被碰到就取谁（t 取两个方向的较小者）。 */
export function edgePointOf(box, towards) {
  const c = rectCenter(box)
  const dx = towards.x - c.x
  const dy = towards.y - c.y
  if (!dx && !dy) return c
  const hw = box.w / 2
  const hh = box.h / 2
  const t = Math.min(hw / (Math.abs(dx) || 1e-9), hh / (Math.abs(dy) || 1e-9))
  return { x: c.x + dx * t, y: c.y + dy * t }
}
