/* 「留到板上」：把追问 / 作业里那一轮问答，落成课件页边的一张**答案卡**。
 *
 * ── 这个文件管什么、不管什么 ─────────────────────────────────────────────
 * 管**内容**：一段对话 / 一道题 → 一张卡上的那两行（标题 + 正文）。
 * 不管**几何**（摆哪儿、量多大）—— 那是 `doc-cards.js` 的 `planAnswerCard` /
 * `measureDeck`；也不管**存盘**（卡片的 `ask` 字段）—— 那是 `ask-region.js`
 * 的 `normalizeAsk` / `serializeAsk` 加 `board.js` 那两道闸。
 * 三条都住在各自本来就该在的地方，所以这里只剩纯文本处理，node 里断言得住。
 *
 * ── 为什么留下的正文里**必须带上"你问的那句话"** ────────────────────────
 * 一周后你只看到页边一张卡："那这一步为什么成立？" —— 没有指代对象，
 * 连"这一步"是哪一步都不知道。这和「作业辅导」里"题干要照抄一遍"是同一条教训
 * （那边防串题，这边防失忆）。所以标题永远是**你问的那句话**，正文才是答案。
 *
 * ── 追问留的是"到这一轮为止"（ADR-0006 决定 ①）─────────────────────────
 * 多轮追问里，第二答常常写着"上面那个符号"—— 只留最后一答同样看不懂。
 * 所以留下的是**从第一问到这一轮**的整段（问 / 答 成对，中间空一行），
 * 而按钮挂在每一条回答下面：看见哪一条想留就点哪一条，位置就是"留到这儿"的意思。
 *
 * ⚠ **按钮上的字只有一处**（和 `followup.js` 的 `ASK_BUTTON` 同一条纪律）：
 *   `AskBox` / `HomeworkBox` 用它渲染，自检按它找按钮 —— 抄成两份的话，
 *   改了文案而自检还在找旧字，症状是"自检报找不着按钮"，而功能其实是好的。
 *
 * ⚠ 这个文件**谁都不 import**（连 doc-cards.js 都不）：`doc-cards.js` 反过来要 import
 *   它的 `ANSWER_KIND`（量尺寸那一趟得知道"答案卡也是讲义卡，正文要排公式"）。
 *   互相 import 就是一个环 —— 现在这样只有一个方向。
 */

/** 「留到板上」那颗按钮上的字（两个窗里是同一句话：做的都是同一件事）。 */
export const KEEP_BUTTON = '⬇ 留到板上'

/** 留下之后那颗按钮变成什么（点了不会再落一张 —— 想再要一张就关窗重问）。 */
export const KEPT_LABEL = '✓ 已在板上'

/** 答案卡上「◎」那颗按钮（回看"我当时圈的是哪一块"）。 */
export const ASK_MARK_GLYPH = '◎'

/* 正文的上限：**防疯，不是目标长度**。
 * 一段正常回答 200~600 字、一道题的解析 200~800 字，都远在线上。
 * 超了要**报数**（`clipped`），不静默截断 —— 卡片上的字少了，用户得知道为什么。
 * ★ 这几个数是**卡片**的账（一段话能有多长），和 doc-cards.js 里那几个
 *   （`MAX_BODY_CHARS` 那些，是"一页提炼出来的短句"的账）不是同一件事，所以各写一份。 */
export const MAX_ASK_Q = 160
export const MAX_ASK_A = 2000
export const MAX_HW_Q = 600
export const MAX_HW_A = 900
export const MAX_HW_E = 2000
/** 速查那张卡的三段各自能写多少字。它们和作业那一族分开的原因同上
 *  （借 MAX_HW_* 顶着的话，改作业那边会顺手把这边也改了）：
 *    词 —— 它同时是卡片的**标题**，长了会把卡撑成一条横幅；
 *    讲 —— 主体，和 MAX_ASK_A 同一个量级但略短（速查的答案本来就短）；
 *    例 —— 半句到两句，够让人想起那个场景就行。 */
export const MAX_LOOK_TERM = 60
export const MAX_LOOK_SAY = 1600
export const MAX_LOOK_EG = 900
/** 卡片的标题（题号 / 一句话）最多几个字。标题太长会把卡片撑成一条横幅。 */
export const MAX_ANSWER_TITLE = 60

/** 答案卡在 `measureDeck` / `projectDeck` 里的 kind。
 *  ⚠ 它不是"第三种卡片"（板上仍然只有 note / formula 两种）——
 *    这是**摆版时**的分派键：文字卡、正文按讲义那一套（rich）排。 */
export const ANSWER_KIND = 'answer'

const oneLine = (s) => String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').trim()

/** 文本清洗：和 doc-cards.js 的 `cleanText` 同一套（只动"看着一样"的空白，一个字都不删）。 */
function clean(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 截断：**按码点**数（`[...s]`），不是按 UTF-16 长度 —— 不然一个 emoji 会被切成半个。 */
function clip(s, max) {
  const chars = [...String(s || '')]
  if (!max || chars.length <= max) return { s: String(s || ''), cut: false }
  return { s: chars.slice(0, max).join(''), cut: true }
}

/**
 * 追问那一窗里的对话 → 一张答案卡的内容（纯函数）。
 *
 * @param {Array<{role:'user'|'assistant', text:string, pending?:boolean}>} turns
 *        `AskBox` 里的那一份（只在组件里活着，关窗就散）。
 * @param {number} upto 留到第几条（默认最后一条）。**回答的下标** ——
 *        按钮挂在哪一条回答下面，传的就是那一条的下标。
 * @returns {{title, body, clipped}|null} null = 这一段里没有可留的东西
 *          （还没答完、或者一个字都没有）。
 */
export function askThreadText(turns, upto = -1) {
  const list = Array.isArray(turns) ? turns : []
  const end = upto >= 0 ? Math.min(Math.trunc(upto), list.length - 1) : list.length - 1
  const pairs = []
  let q = ''
  for (let i = 0; i <= end; i += 1) {
    const t = list[i]
    if (!t || t.pending) continue
    const text = clean(t.text)
    if (!text) continue
    if (t.role === 'user') {
      q = text
      continue
    }
    if (t.role !== 'assistant') continue
    pairs.push({ q, a: text })
    q = ''
  }
  if (!pairs.length) return null
  let clipped = false
  const title = (() => {
    const c = clip(oneLine(pairs[0].q), MAX_ANSWER_TITLE)
    clipped = clipped || c.cut
    /* 第一问一个字都没有（不该发生：`ask()` 要非空才发）—— 标题不能空着，
       但也不许编一句"关于这一块的问题"冒充用户说过的话，所以用一句**说明**。 */
    return c.s || '这一块的问题'
  })()
  const body = pairs
    .map((p, i) => {
      const a = clip(p.a, MAX_ASK_A)
      if (a.cut) clipped = true
      if (i === 0) return a.s
      const qq = clip(oneLine(p.q), MAX_ASK_Q)
      if (qq.cut) clipped = true
      return (qq.s ? qq.s + '\n\n' : '') + a.s
    })
    .join('\n\n')
  return { title, body, clipped }
}

/**
 * 作业辅导里的一道题 → 一张答案卡的内容（纯函数）。
 *
 * 顺序照用户说的：「每道题要有答案也要有解析」——
 * 但卡片上**题干必须跟着**（"答案：C"孤零零一张卡，一周后没有任何意义），
 * 所以是 题号 / 题干 / 答案 / 解析 四样。
 *
 * @param {{label?, question?, answer?, explain?, page?}} p
 *        `homework.js` 的 `parseHomework` 交回来的那一条。
 * @returns {{title, body, clipped}|null}
 */
export function homeworkText(p) {
  const it = p && typeof p === 'object' ? p : {}
  const page = Math.trunc(Number(it.page))
  const fallback = page > 0 ? `第 ${page} 页那一道` : '这一道题'
  const t = clip(oneLine(it.label) || fallback, MAX_ANSWER_TITLE)
  let clipped = t.cut
  const parts = []
  const q = clip(clean(it.question), MAX_HW_Q)
  if (q.cut) clipped = true
  if (q.s) parts.push(q.s)
  const a = clip(clean(it.answer), MAX_HW_A)
  if (a.cut) clipped = true
  if (a.s) parts.push('答案：' + a.s)
  const e = clip(clean(it.explain), MAX_HW_E)
  if (e.cut) clipped = true
  if (e.s) parts.push('解析：' + e.s)
  if (!parts.length) return null
  return { title: t.s, body: parts.join('\n\n'), clipped }
}

/**
 * 速查的一条 → 一张卡的内容（纯函数）。
 *
 * 卡上留 **`词` + `讲` + `例`** 三样：
 *   · 「词」必须留 —— 一周后翻到一张只有解释的卡，你不知道它讲的是谁；
 *   · 「近」（那几个相关词）**刻意丢掉**：它在那个浮着的窗里点了就能接着查，
 *     落到板上就只是一串谁都不会去点的标签 —— 而它随时能再查一次拿回来。
 *
 * @param {{term?, say?, eg?}} p `lookup.js` 的 `parseLookup` 交回来的那几个字段。
 * @returns {{title, body, clipped}|null} null = 这一条没什么可留的。
 */
export function lookupText(p) {
  const it = p && typeof p === 'object' ? p : {}
  const term = clip(oneLine(it.term), MAX_LOOK_TERM)
  let clipped = term.cut
  const say = clip(clean(it.say), MAX_LOOK_SAY)
  if (say.cut) clipped = true
  const eg = clip(clean(it.eg), MAX_LOOK_EG)
  if (eg.cut) clipped = true
  const parts = []
  if (say.s) parts.push(say.s)
  if (eg.s) parts.push('例：' + eg.s)
  if (!parts.length) return null
  return { title: term.s || '查过的一个词', body: parts.join('\n\n'), clipped }
}

/** 卡的内容 → `measureDeck` / `projectDeck` 认的那个条目。
 *  ⚠ `kind: 'answer'` 是**摆版时的分派键**（文字卡 + 讲义渲染），不是新的卡片种类 ——
 *    `board.js` 的 `CARD_KINDS` 仍然是 note / formula 两种。 */
export function answerItem(id, made) {
  if (!made || !String(made.body || '').trim()) return null
  return { id: String(id || 'a1'), kind: ANSWER_KIND, title: String(made.title || ''), body: String(made.body || '') }
}
