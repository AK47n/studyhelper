/* ═══════════ 关系的词表 ═══════════
 *
 * 一条连接可以是什么关系（相关 / 因果 / 推导 / 并列 / 等价），以及那排词里
 * `0` 那颗「删掉这条连接」。
 * 这层是**领域的词**，不是逻辑 —— 判定在 links.js，存取盘在 board.js。
 *
 * 为什么单独一个文件：`board.js`（存取盘时要认这些词）和 `links.js`（判定时要用）
 * 都要它，而 board.js 不能反过来 import links.js（会成环）。词表放中间，两边都只依赖它。
 *
 * ── 2026-09-17 第二刀之后，"一条连接"只有两个来源（ADR-0001）──────────────
 *   ① **你宣告**：箭头工具划一笔（两端吸到卡片/板框上）→ 写进板文件的 `links`；
 *   ② **你画的**：一笔线，两头各落在一张卡里 → 自动成立，词默认「相关」。
 *   两条路都**带方向**：方向就是你说的那个方向（宣告版是 from → to，画出来的是第一点 → 最后一点），
 *   画反了点一下 ⇄。词是**固定几个**，不让自由输入：自由文本第三次就会变成"我上次写的是哪个词"。
 *
 * ★ 词表里**没有**「不算连接」了：那是给"从形状猜错了"配的否决权，
 *   而猜形状那一族已经删掉（它在真笔迹上 92:0，见 ADR-0001）。那位置换成了「删掉这条连接」。 */
export const LINK_KINDS = [
  { id: 'rel', name: '相关', dir: false, color: '#6b7280', hint: '一般连线：只是"这两块有关"' },
  { id: 'cause', name: '因果', dir: true, color: '#d9480f', hint: '一个引起另一个（箭头指结果）' },
  { id: 'derive', name: '推导', dir: true, color: '#1c7ed6', hint: '由这个式子推出那个式子' },
  { id: 'para', name: '并列', dir: false, color: '#0f6e56', hint: '同一层的几条，平行的' },
  { id: 'equiv', name: '等价', dir: false, color: '#7048e8', hint: '两边说的是同一件事' },
]
export const LINK_KIND_IDS = LINK_KINDS.map((k) => k.id)
/* 你画出来的那条线（卡↔卡）默认给哪一档。挑"相关"是因为它最弱 ——
   没说过的话就该按最弱的记（"这两块有关"几乎总是对的）。 */
export const DEFAULT_LINK = 'rel'
/* 箭头工具的默认词：**箭头 = 因果**（你手上画的那个东西和它同名，不用想）。 */
export const ARROW_LINK = 'cause'

export function isLinkKind(id) {
  return LINK_KIND_IDS.includes(id)
}

/* ── 那排词里 `0` 那颗：**删掉这条连接**（2026-09-17 第二刀，ADR-0001）──
 *
 * 它顶掉了从前那个「不算连接」（`LINK_NONE = 'none'`）。理由很简单：
 * 那个口子是给"**猜**错了"配的否决权，而第二刀把"猜形状"整族删掉了 ——
 * 猜没了，否决权就没有对象。
 * 而这颗位置本来就在手边（画完之后 3.5 秒内、或者点线上那颗词），
 * 用来干"这条连错了，删掉"正好。
 *
 * 一条连接现在有两种来源，同一个动作翻译成两件事：
 *   · **你连的**（`links` 里那条记录）→ 删掉那条记录；
 *   · **你画的**（一笔线连了两张卡）→ 删掉那一笔（线没了，关系自然也没了）。
 * 两个都进撤销栈。 */
export const LINK_DELETE = 'delete'

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
