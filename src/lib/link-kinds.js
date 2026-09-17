/* ═══════════ 关系的词表 ═══════════
 *
 * 一条连接可以是什么关系（相关 / 因果 / 推导 / 并列 / 等价），以及「这条不算连接」。
 * 这层是**领域的词**，不是逻辑 —— 判定在 links.js，存取盘在 board.js。
 *
 * 为什么单独一个文件：`board.js`（存取盘时要认这些词）和 `links.js`（判定时要用）
 * 都要它，而 board.js 不能反过来 import links.js（会成环）。词表放中间，两边都只依赖它。
 *
 * ★ `LINK_NONE` 不是第六个词：那一排词回答"是什么关系"，它回答"它根本不是关系"——
 *   所以它不在 LINK_KINDS 里，`isLinkKind` 也认不出它。
 */

// ─────────────────────────── 关系：连接线 ───────────────────────────
/* 用户 2026-09-16：「我在思考如何更便捷的显示出两者之间的主次，因果，并列等关系」
 * 「我操作的速度是很快的，我没有时间去逐步花很多时间去操作这个表示关系的步骤」
 * 「连接的不只是卡片，可能还有我没转化成卡片的字迹，我自己手绘的图」
 *
 * 于是这一层的规矩是：
 *   ① **一条连接 = 一笔**（你从一个东西画到另一个东西的那一笔），不是新实体、不用命名、
 *      不用选中再新建。它的两个"端点落在谁身上"每次重算 —— 所以你挪动卡片，关系自己跟着走。
 *   ② **类型从笔迹的形状读出来**（见 classifyLinkShape）：直线 = 相关、带箭头 = 因果。
 *      注意"一条连接"不等于"一笔"：用户是**分开画**的 —— 一杆一笔、V 尖一笔
 *      （2026-09-16 两张截图解出来的事实，见 findTip / gatherHeads / joinStrokes）。
 *      读出来的东西**不存盘** —— 形状是笔迹的属性，随时能重算，存了反而会和笔迹对不上
 *      （你后来把箭头擦掉再补一笔直线，文件里那个"因果"就成了谎话）。
 *   ③ **只有你手动改过的词才存**（stroke.link，且只在非自动值时才写）。
 *      绝大多数连接一个字节都不写 → 老文件、没改过的文件在 Git 里纹丝不动。
 *   ④ 词是**固定几个**，不让自由输入：自由文本第三次就会变成"我上次写的是哪个词"。
 *      （这条是刻意的：要的是"一眼扫过去就懂"，不是表达力。）
 *
 * 方向：`dir: true` 的词有方向，方向就是**你画的方向**（笔迹的第一点 → 最后一点）。
 * 不用额外操作，画反了就点一下 ⇄（见 Board.jsx 的 setLinkKind）。 */
export const LINK_KINDS = [
  { id: 'rel', name: '相关', dir: false, color: '#6b7280', hint: '一般连线：只是"这两块有关"' },
  { id: 'cause', name: '因果', dir: true, color: '#d9480f', hint: '一个引起另一个（箭头指结果）' },
  { id: 'derive', name: '推导', dir: true, color: '#1c7ed6', hint: '由这个式子推出那个式子' },
  { id: 'para', name: '并列', dir: false, color: '#0f6e56', hint: '同一层的几条，平行的' },
  { id: 'equiv', name: '等价', dir: false, color: '#7048e8', hint: '两边说的是同一件事' },
]
export const LINK_KIND_IDS = LINK_KINDS.map((k) => k.id)
/* 没标过词、形状也读不出箭头时给哪一档。挑"相关"是因为它最弱 ——
   猜错了不会误导你（"这两块有关"几乎总是对的），而"因果"猜错就是误导。 */
export const DEFAULT_LINK = 'rel'
/* 形状读出来的默认词：箭头 → 因果。 */
export const ARROW_LINK = 'cause'

export function isLinkKind(id) {
  return LINK_KIND_IDS.includes(id)
}

/* 「这条不算连接」—— 2026-09-16 加的第二个手动口子。
 *
 * 为什么必须有：形状/位置自动读出来的连接**会读错**（一条长竖笔正好跨过两坨字、
 * 或者你的箭头指着一块字迹但它其实什么都不是）。在那之前，认错了只能**擦掉那一笔**重画 ——
 * 那就成了"猜错还锁死"，正是这套设计最怕的事。
 *
 * 存法：还是 `stroke.link`，值是 `'none'`（不是新增字段，也不是往 LINK_KINDS 里加一项 ——
 * 那一排词是给"这条线是什么关系"用的，而这个是"它根本不是连接"）。
 * 读盘只认这个字面值；`isLinkKind('none')` 是 false，所以别的代码路径
 * （比如"手动标过的词"）不会把它当成一个词。 */
export const LINK_NONE = 'none'

export function isNoLink(stroke) {
  return !!stroke && stroke.link === LINK_NONE
}

/* 「这个条件不算」+「条件就是它」—— 2026-09-16 给"位置送的条件"配的两个手动口子
 * （前两个手动口子是：改词、不算连接）。
 *
 * 条件本来是**位置送的**：写在那条线**弧长中点**旁边的字/卡自动成为它的条件
 * （见 links.js 的 linkCondition）。位置有两头都不灵的时候：
 *   ① 读错了 —— 中点旁边那撮字可能是另一条线的东西，或者只是随手写的旁注
 *      → **`'none'`**：这个条件不算（否决权优先，不再往位置里读）；
 *   ② 读不到 —— 条件写在别处（离中点太远、或者你后来把那几笔挪走了）
 *      → **`'card:<卡 id>'`** / **`'ink:<笔 id>'`**：条件就是它（你亲手指的）。
 *
 * 存法：还是 `stroke.cond` 一个字段，值是上面三种形状之一（前缀用冒号分开 ——
 * 固定块的 id 早就是这个写法：`grp:<组 id>`）。这不只是省一个字段：
 * **读的时候只要问一个值**，否决和指定就不可能互相打架（一个字段只能有一个值）。
 *
 * ⚠ 三条规矩（和前两个手动口子一样）：
 *   · 只在你说过时才写；没说过 → 文件里一个字节都不多；
 *   · 值只认这个形状，认不出的一律当没写（回到按位置读）；
 *   · 指的东西**后来没了**（卡删了 / 那笔擦了）→ 这句话作废、回到按位置读，
 *     而且序列化时**不留尸体**（死 id 不写回文件）。 */
export const COND_NONE = 'none'
const COND_CARD = 'card:'
const COND_INK = 'ink:'

export function isCondNone(v) {
  return v === COND_NONE
}

/** 指定"条件是那张卡"时该写什么值 */
export function condCard(cardId) {
  return cardId ? COND_CARD + cardId : null
}

/** 指定"条件是那一笔（它所在的那一撮字）"时该写什么值 */
export function condInk(strokeId) {
  return strokeId ? COND_INK + strokeId : null
}

/* 把一个 `stroke.cond` 值解成 { kind, id } —— 认不出返回 null（当没写）。
   `kind`: 'none' | 'card' | 'ink'。 */
export function parseCond(v) {
  if (typeof v !== 'string' || !v) return null
  if (v === COND_NONE) return { kind: 'none' }
  if (v.startsWith(COND_CARD)) {
    const id = v.slice(COND_CARD.length)
    return id ? { kind: 'card', id } : null
  }
  if (v.startsWith(COND_INK)) {
    const id = v.slice(COND_INK.length)
    return id ? { kind: 'ink', id } : null
  }
  return null
}

export function linkKind(id) {
  return LINK_KINDS.find((k) => k.id === (isLinkKind(id) ? id : DEFAULT_LINK))
}
