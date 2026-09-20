/* ═══════════ 词表：从**你自己的笔记**里取词（ADR-0004 第 4 步的"结合我的笔记"）═══════════
 *
 * 为什么要它：手写认错里最烦的一类是**专有名词**（"安培环路定理"认成"安培环路定里"、
 * "螺绕环"认成"螺线环"）—— 而正确的写法就在你自己的笔记里躺着。把那些词当**提示**
 * 发给两趟（认字那趟、结构整理那趟），比让模型凭空猜靠谱得多。
 *
 * 三条规矩（第五条决定的：本地、可见、可关）：
 *   ① 取词只看 `[[…]]` 和节点标题 —— 那是**你亲手写下的名字**，不是我们猜的"关键词"；
 *   ② 同层的笔记优先（`data/大物/电磁感应/` 里的板 → 同一层的笔记）；
 *   ③ 它只是提示：认字那趟**没有它照样认**，结构整理**没有它照样读**。
 *
 * ⚠ **这是唯一一处会把"笔记里的字"发出去的功能**（发的是抽出来的词，不是笔记全文）。
 *   所以界面上要看得见、而且关得掉 —— 和"会发一张多大的图"同一条规矩。
 *   这一整个文件是纯函数（不读盘、不联网），读盘那一步在 App 那边。
 */
import { FIELD_KEYS } from './parse.js'

/* 一个词最长多少个字：太长的多半是整句话被 `[[ ]]` 包了一下，不是词。 */
export const TERM_MAX_LEN = 14
/* 一个词最短：单字（B、I、E）其实是**量**，很有用 —— 但单字噪声也大，
   只收同时出现在 `[[…]]` 里的单字（那是你亲手括起来的）。 */
export const TERM_MIN_LEN = 1
/* 一份草稿最多带多少个词过去。多了是噪声、还费 token。 */
export const TERM_LIMIT = 60

/* 这段文字里"你亲口命名的东西"：
 *   `[[B]]`、`[[安培环路定理]]`  → 最强（你亲手括起来的）
 *   `- 安培环路定理 | 公式 | …`  → 节点标题（次之）
 * `$…$` 里的东西一律不收（那是公式，不是词）；字段名本身也不是词。 */
export function termsFromNote(text) {
  const out = []
  const src = String(text == null ? '' : text)
  for (const m of src.matchAll(/\[\[([^[\]]+)\]\]/g)) out.push({ term: m[1].trim(), weight: 3 })
  for (const line of src.split('\n')) {
    const m = /^\s*-\s+([^|]+?)\s*(\||$)/.exec(line)
    if (!m) continue
    const title = m[1].trim()
    if (!title || title.includes('$') || title.includes('[[')) continue
    if (FIELD_KEYS.includes(title)) continue
    out.push({ term: title, weight: 2 })
  }
  const keep = []
  for (const it of out) {
    const t = it.term.trim()
    if (!t) continue
    if (t.length < TERM_MIN_LEN || t.length > TERM_MAX_LEN) continue
    if (t.includes('$') || t.includes('\n')) continue
    if (/^[\d\s.、,，]+$/.test(t)) continue // 纯数字/标点不是词
    keep.push({ term: t, weight: it.weight })
  }
  return keep
}

/* 多份笔记 → 一份词表。
 *   notes = [{ path, text, near }]   near = 和这张板**同一层**（优先）
 * 排序：先按"同层"、再按**出现次数**、再按权重 —— 出现得多的词更可能是这一课的核心概念。
 * 同一层里出现 1 次的词，也排在别的层的热词前面：**这一课的词才是这一课会写到的词**。 */
export function pickVocab(notes, { limit = TERM_LIMIT } = {}) {
  const stat = new Map()
  for (const n of Array.isArray(notes) ? notes : []) {
    const near = !!(n && n.near)
    for (const { term, weight } of termsFromNote(n && n.text)) {
      const cur = stat.get(term) || { term, count: 0, weight: 0, near: false }
      cur.count += 1
      cur.weight += weight
      cur.near = cur.near || near
      stat.set(term, cur)
    }
  }
  const list = [...stat.values()]
  list.sort((a, b) => {
    if (a.near !== b.near) return a.near ? -1 : 1
    if (a.count !== b.count) return b.count - a.count
    /* 次数打平时**长的先**：多字的专名（"安培环路定理"）正是最容易被认错、
       也最能帮着定住上下文的那一类；单字（B、I）几乎不会被认错，排在后面当兜底。
       ——`limit` 一截，先被砍掉的应该是"没它也认得出来"的那些。 */
    if (a.term.length !== b.term.length) return b.term.length - a.term.length
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.term.localeCompare(b.term, 'zh')
  })
  return list.slice(0, Math.max(0, limit)).map((x) => x.term)
}

/* 从一层笔记的路径判断"是不是和这张板同一层"。
   规矩只有一条：**同一个目录**（`data/大物/电磁感应/board-8.2.md` 的同层是
   `data/大物/电磁感应/` 里的其它文件）。上层/下层的笔记不优先 —— 但**照样收**
   （它们是同一门课的词，只是没那么贴身）。 */
export function isSameLayer(boardPath, notePath) {
  const dir = (p) => String(p || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  return dir(boardPath) === dir(notePath)
}
