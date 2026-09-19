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
import { cardBounds, cardVisualRect, frameBounds, pointInRect, rectCenter, rectDist } from './geometry.js'

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
     （绝不画一条"指向空气"的箭头，也不让它当端点）。
 * ★ 卡片多带一个 `rect`（**没转的那个**可视矩形，含倍率、带 `rot`）——
   箭头要"打在卡片的边上"，而 `box` 是转过之后的外接框：
   拿外接框去求边点，箭头会停在离卡片还有一段的空中（见 `edgePointOf`）。
   板框没有 rect（它的框线本来就是轴对齐的，没有"转过的框"这回事）。 */
export function nodeList(board) {
  const cards = (((board && board.cards) || [])).map((c) => ({
    kind: 'card',
    id: c.id,
    label: '',
    box: cardBounds(c),
    rect: cardVisualRect(c),
  }))
  const frames = (((board && board.frames) || []))
    .map((f) => ({ kind: 'frame', id: f.id, label: f.title ? String(f.title) : '板框', box: frameBounds(board, f) }))
    .filter((n) => n.box)
  return { cards, frames }
}

/* 按 id 取那一个（渲染宣告连接、取名字都用它）。找不到 → null。
   `nodes` 同上：一次性的调用方不用传；循环里（`readDeclaredLinks` 每条连接问两次）
   传算好的那一份，免得又变成"每条连接重建一遍全板的端点清单"。 */
export function nodeById(board, id, nodes = null) {
  if (!id) return null
  const { cards, frames } = nodes || nodeList(board)
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
 *   nodes    **算好的端点清单**（`nodeList(board)` 的返回值）。见下面那段说明。
 *
 * ── ★ 为什么要有 `nodes` 这个参数（2026-09-18 用户报"一放板框就巨卡"）──────
 * 从前这里每次都自己 `nodeList(board)`，而 `nodeList` 会给**每一个板框**跑一遍
 * `frameBounds` —— 那是"把这个框的**全部成员**（可能几百笔）逐点扫一遍求包围盒"。
 * 单看一次 0.25ms 不吓人，可调用点的形状是**灾难性**的：
 * `buildLinks` 的第一趟对**每一笔**问 2 次（首点在谁身上、尾点在谁身上），
 * 于是 1451 笔的板上是 `2 × 1451 = 2902` 次 `nodeList`，而那个框装了 777 笔
 * → 实测 **549ms/次**。
 * 更坏的是它在**每一帧**都会跑：拖动板框时 `translateFrame` 每帧换一次 `strokes`
 * 数组 → `createLinkReader` 按引用判"变了" → 全套（索引 + buildLinks + 条件）重来
 * → **每帧 650ms，约 1.5fps**。用户说的"巨卡"就是这个数。
 * （这也解释了为什么"框越大越卡"：代价 ∝ 笔数 × 框成员数。）
 *
 * 所以：**热循环里把 `nodeList` 算一次传进来**。不传还是老样子（自己算），
 * 一次性的调用方（面板、箭头吸附）什么都不用改。
 */
export function nodeAt(board, p, opts = {}) {
  if (!p) return null
  const kinds = opts.kinds || ['card', 'frame']
  const pad = Number(opts.pad) || 0
  const radius = Number(opts.radius) || 0
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || [])
  const { cards, frames } = opts.nodes || nodeList(board)
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
   长宽谁先被碰到就取谁（t 取两个方向的较小者）。
 * ★ 框**转过**（`box.rot`，2026-09-21 卡片能旋转之后）→ 把 towards **转进框自己的坐标系**
   算完再转回来。不这么做的话，箭头会打在"没转那个矩形"的边上 ——
   屏幕上就是尖端戳进卡片里、或者停在离卡片还有一段的空中，
   而两端的框、线的曲率看着都对（静默的那种错）。
 * ⚠ 入参要么是轴对齐框 `{x,y,w,h}`（板框 / 没转的卡），要么是 `cardVisualRect` 那种
   带 `rot` 的框。**别把 AABB 喂进来又指望它打准** —— 转过的卡要传 `rect`（见 nodeList）。 */
export function edgePointOf(box, towards) {
  const rot = Number(box && box.rot) || 0
  if (!rot) {
    const c = rectCenter(box)
    const dx = towards.x - c.x
    const dy = towards.y - c.y
    if (!dx && !dy) return c
    const t = Math.min(box.w / 2 / (Math.abs(dx) || 1e-9), box.h / 2 / (Math.abs(dy) || 1e-9))
    return { x: c.x + dx * t, y: c.y + dy * t }
  }
  const c = rectCenter(box)
  const co = Math.cos(-rot)
  const si = Math.sin(-rot)
  /* towards 在框的局部坐标系里（框的中心当原点、框自己的轴当坐标轴）。 */
  const dx0 = towards.x - c.x
  const dy0 = towards.y - c.y
  const lx = dx0 * co - dy0 * si
  const ly = dx0 * si + dy0 * co
  if (!lx && !ly) return c
  const t = Math.min(box.w / 2 / (Math.abs(lx) || 1e-9), box.h / 2 / (Math.abs(ly) || 1e-9))
  const px = lx * t
  const py = ly * t
  /* 转回世界坐标。 */
  const co2 = Math.cos(rot)
  const si2 = Math.sin(rot)
  return { x: c.x + px * co2 - py * si2, y: c.y + px * si2 + py * co2 }
}
