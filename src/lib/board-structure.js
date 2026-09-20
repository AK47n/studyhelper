/* ═══════════ 结构整理：把"一行一行认回来的字"读成笔记的骨架（ADR-0004 第 4 步）═══════════
 *
 * 这是整条链路里**唯一会"猜"的一步**，所以它被四条规矩捆着：
 *
 *   ① **两趟分开**：认字那一趟（看图）只按行抄；这一趟**不看图**，纯文本。
 *      理由是实测过的那一条 —— 视觉模型最弱的一环就是逻辑，而纯文本调用更便宜、
 *      更快，而且**离线可测**（夹具 = 一份行清单 + 一份文字，断言钉得住）。
 *   ② **只许引用，不许新增**：模型交回来的是**结构**（哪几行是一节、谁挂在谁下面、
 *      谁推出谁），**文字一个字都不由它写** —— 每个字都来自第一趟认回来的行。
 *      于是"编造内容"在结构上不可能发生：它没有地方写。
 *   ③ **引不出来就丢掉，并且报数**：引用了不存在的行号 → 整条丢，记在 `dropped` 里，
 *      由调用方报给用户。不静默、不猜一个最近的行。
 *   ④ **看不出来就说看不出来**：空输出是合法结果（草稿退回"按行平铺"）。
 *
 * ⚠ 这一整个文件都是**纯函数**（不联网、不碰 DOM、不改板），所以自检直接喂夹具。
 *   出网那一半在 server-ocr.js（提示词 + 多一个 mode），界面那一半在 App.jsx。
 */
import { linkKind } from './link-kinds.js'
import { FIELD_KEYS } from './parse.js'
/* ★ `noteLines` 是"什么算一条笔记行的正文"的**唯一**实现（board-note.js）：
   `say`（机器写的那一段）也走它 —— 项目符号、行内 ` | `、`$$…$$` 这些规矩
   在一个地方说了算，别在这儿再写第二份（两份规矩迟早对不上）。 */
import { noteLines } from './board-note.js'

/* 关系词只认词表里那五个（和板上的连接同一套词 —— 自由文本第三次就会变成
   "我上次写的是哪个词"）。 */
const KINDS = ['rel', 'cause', 'derive', 'para', 'equiv']
const KIND_ALIAS = new Map([
  ['相关', 'rel'], ['因果', 'cause'], ['推导', 'derive'], ['并列', 'para'], ['等价', 'equiv'],
  ['rel', 'rel'], ['cause', 'cause'], ['derive', 'derive'], ['para', 'para'], ['equiv', 'equiv'],
])
export const STRUCT_INDENT_MAX = 4

/* ═══════════ `say`：整条链路里**唯一**放行"机器自己写字"的地方（2026-09-20）═══════════
 *
 * 由来：ADR-0004 原本的铁律是"文字一个字都不许它写"（只许引用行号）。跑了两天之后
 * 用户的判据是**「完全没有体现出来 LLM 对与我的笔记的理解与整合，象是纯粹的识别」** ——
 * 只许重排的话，草稿永远是"你的碎行 + 一副骨架"，它读出来的东西（这几行到底在讲什么）
 * 一个字都没地方放。所以放行**一小段**：每一节可以有一句/几句人话，把这一节的几行串起来。
 *
 * 四条护栏（放行不等于放开）：
 *   ① **只有这一处**：`sections[].say` 是唯一的自由文本字段；行的文字、标题、
 *      关系两头，全都照旧只许引用行号；
 *   ② **只许用这一节已有的东西**：不许引入新量、新数字、新结论（提示词里明写）；
 *   ③ **必须标出来**：`〔机器整理〕` 这个前缀**由我们加**（不靠模型自觉）——
 *      于是"哪句是它写的"在笔记里一眼看得见，和"手写转录（机器认的，还没校对）"同一个态度；
 *   ④ **看不出来就别写**：`say` 缺席/空 → 这一节跟从前一字不差（不硬凑）。
 *
 * ⚠ `say` 必须**只占一行**：笔记是一行一个节点，换行会把后半句变成"看不见的行"。
 *   模型爱分点、爱换行，所以这里一律压成一段（走 noteLines 那套规矩）。 */
export const MACHINE_SAY_MARK = '〔机器整理〕'
/* 一段整理稿最长多少字。长了没有意义（它是"把这几行串起来"，不是"替我重写笔记"），
   而且会在草稿里盖过你写的那几行。超了截断并**记一笔**（不静默）。 */
export const SAY_MAX = 240

/* 模型给的 `say` → 能直接落进笔记的一行（或不写）。
   返回 `{ text, truncated }`：`text` 为 null = 这一节没有整理稿。 */
export function cleanSay(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return { text: null, truncated: false }
  /* 小节头（`# …`）不是"一段话"的一部分 —— 节名由草稿自己写。 */
  const parts = noteLines(text)
    .filter((l) => !/^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^- /, '').trim())
    .filter(Boolean)
  let s = parts.join(' ').replace(/\s+/g, ' ').trim()
  /* 模型自己写了标记也不重复（标记是我们加的）—— 它写了几遍都清掉。 */
  while (s.startsWith(MACHINE_SAY_MARK)) s = s.slice(MACHINE_SAY_MARK.length).trim()
  if (!s) return { text: null, truncated: false }
  if (s.length > SAY_MAX) return { text: s.slice(0, SAY_MAX).trim() + '…', truncated: true }
  return { text: s, truncated: false }
}

/* ── 一、行清单 → 给识别那一趟的"这块有哪几行"（纯文本，随图一起发）──────────
 *
 * 为什么值得把行号写进提示词：模型要按 `L3|` 这样的前缀回话，它得先知道
 * "这一块有几行、从上到下是 L1…Ln"。百分比是给它一个**对得上图的位置感**
 * （图里那一行大概在哪个高度），`左边缘` 是那一行比这块里大多数行靠右多少像素
 * （一个事实，不是"缩进层级"—— 真板上左边缘是连续铺开的，见 ink-lines.js 文件头）。 */
export function manifestText(lines) {
  const list = Array.isArray(lines) ? lines : []
  if (!list.length) return ''
  let top = Infinity
  let bot = -Infinity
  for (const l of list) {
    if (l.y < top) top = l.y
    if (l.y + l.h > bot) bot = l.y + l.h
  }
  const span = Math.max(1, bot - top)
  const out = [`行清单（这一块从上到下共 ${list.length} 行，行号就用下面这些）：`]
  for (const l of list) {
    const pct = Math.round(((l.y - top) / span) * 100)
    const rel = l.x0Rel === 0 ? '居中' : l.x0Rel > 0 ? `靠右 ${l.x0Rel}` : `靠左 ${-l.x0Rel}`
    out.push(`${l.id} 位于 ${pct}% 高度，${rel}`)
  }
  return out.join('\n')
}

/* ── 二、识别回来的"L<k>|文字" → 一行一条（**落行校验的第一道**）─────────────
 *
 * 契约（写在 BOARD_LINES_PROMPT 里）：
 *   `L3|文字`        第 3 行
 *   `L3-4|文字`      第 3、4 行其实是**一整块东西**（分数的分子分母、矩阵的几行）→ 合成一条
 *   认不清：`L7|〔认不出〕`
 *
 * 返回：
 *   items     [{ from, to, text }]，按行号排好
 *   loose     不符合格式的行（模型没按契约来）
 *   missing   清单里有、但一条都没提到的行号
 *   bad       越界 / 重复引用 / 范围写反 的条数
 *   followed  **格式跟上了吗**（有 items 而且没有 loose）—— 这是"用不用结构化那一趟"的闸。
 *             ⚠ 覆盖率（missing）**不是**闸：漏认一行只是那一行没字，其余的照样能用，
 *               由人在校对界面里补；格式没跟上才是"整段退回按原文抄"的信号。 */
export function parseLineOutput(raw, lineCount) {
  const n = Math.max(0, Number(lineCount) || 0)
  const items = []
  const loose = []
  const used = new Set()
  const bad = { outOfRange: 0, dup: 0, flipped: 0 }
  for (const rawLine of String(raw == null ? '' : raw).replace(/\r\n/g, '\n').split('\n')) {
    const s = rawLine.trim()
    if (!s) continue
    const m = /^L\s*(\d+)\s*(?:[-–~—]\s*(\d+))?\s*[|｜:：]\s*([\s\S]*)$/i.exec(s)
    if (!m) {
      loose.push(s)
      continue
    }
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (!(a >= 1 && a <= n) || !(b >= 1 && b <= n)) {
      bad.outOfRange++
      continue
    }
    const from = Math.min(a, b)
    const to = Math.max(a, b)
    if (a > b) bad.flipped++
    let overlap = false
    for (let i = from; i <= to; i++) if (used.has(i)) overlap = true
    if (overlap) {
      bad.dup++
      continue
    }
    for (let i = from; i <= to; i++) used.add(i)
    items.push({ from, to, text: String(m[3] || '').trim() })
  }
  items.sort((x, y) => x.from - y.from)
  const missing = []
  for (let i = 1; i <= n; i++) if (!used.has(i)) missing.push(i)
  return { items, loose, missing, bad, followed: items.length > 0 && loose.length === 0 && bad.outOfRange === 0 && bad.dup === 0 }
}

/* ── 三、把"整板读到的行"拼成给结构整理那一趟的输入 ──────────────────────────
 *
 * 输入（调用方手里就有的东西）：
 *   title    板名
 *   blocks   [{ name, frameId, lines, items }]
 *            `lines` 是本地算的行清单（`buildLines` 的产物）；
 *            `items` 是识别那一趟回来的 `[{from, to, text}]`（**块内**行号 —— from~to 表示
 *            "这几行其实是一整块东西"，比如分数的分子分母）。
 *   vocab    **你自己的词**（从同一层的笔记里抽的，见 note-vocab.js）—— 只做提示，不做判据
 *   links    板上已经宣告/画出来的连接（两端是卡片或板框的名字，只做提示）
 *
 * 输出：
 *   text     发给模型的那段纯文本
 *   rows     [{ id:'L1', text, block, blockName, x0Rel }] —— **整板唯一的坐标系**，
 *            结构整理说的每一句话都只许引用这里的 id（校验和渲染都用它）。
 *
 * ★ 坐标系是**一段一段**的，不是"原始一行一行"的：`L3-4|` 那种合并（分数的分子分母）
 *   在模型眼里本来就是一整块东西 —— 给它一个 id 才对得上。所以这里按 item 编号，
 *   一行都没认到的那几行也各占一个号（内容写"没认出来"），
 *   于是"模型能引用的 id"和"我认得的 id"是**同一个集合**，不会出现"引了个中间号"的坑。
 * ⚠ 两层编号各管各的：块内 L1..Lk 是发给**识别**那一趟的，这里 L1..Ln 是发给
 *   **结构整理**那一趟的 —— 换算只在这一处。 */
export function buildStructureInput({ title = '', blocks = [], vocab = [], links = [] } = {}) {
  const rows = []
  const out = []
  out.push(`【这是一块白板上的手写】${title || '（没名字）'}`)
  out.push('下面每一行都是**已经认出来的字**，行号是它在这块板上的位置（从上往下）。')
  out.push('你要做的只有一件事：**说清楚哪几行是一节、谁挂在谁下面、谁推出谁**。')
  out.push('文字一个字都不要改、不要补 —— 你只能引用行号。')
  out.push('')

  let seq = 0
  let bi = 0
  for (const blk of Array.isArray(blocks) ? blocks : []) {
    const lines = Array.isArray(blk && blk.lines) ? blk.lines : []
    const items = (Array.isArray(blk && blk.items) ? blk.items : []).filter(
      (it) => it && Number.isFinite(it.from) && it.from >= 1 && it.from <= Math.max(1, lines.length)
    )
    const name = String((blk && blk.name) || '').trim()
    out.push(`── 第 ${bi + 1} 段${name ? `（你圈的板框：「${name}」）` : '（框外的手写）'} ──`)
    const covered = new Set()
    for (const it of items) {
      /* ⚠ 一律按**数组下标**算（`from-1` ~ `to-1`），不按 `lines[i].n` ——
         两套数法混着用的话，一旦调用方给的 `lines` 不是从 1 连号（切片、子集），
         "哪几行被认到了"就会静默错位（实测：给一段 n=3,4 的 lines，覆盖判定全落空）。 */
      for (let i = it.from - 1; i <= it.to - 1; i++) covered.add(i)
      seq += 1
      const text = String(it.text || '').trim()
      const x0Rel = (lines[it.from - 1] && lines[it.from - 1].x0Rel) || 0
      rows.push({ id: 'L' + seq, block: bi, blockName: name, text, x0Rel })
      /* 位置提示只在**真的偏得多**的时候才写（|x0Rel| ≥ 80 ≈ 四个字宽）：
         真板上大多数行都在中位附近（实测 p75 只有 44px），每行都标一句是纯噪声。 */
      const hint = Math.abs(x0Rel) >= 80 ? `（比大多数行${x0Rel > 0 ? '靠右' : '靠左'} ${Math.abs(x0Rel)}）` : ''
      out.push(`L${seq}${hint}${text ? '：' + text : '：（这一行没认出来）'}`)
    }
    /* 一行都没认到的那几行也摆出来（模型得给它们一个去处；缺号比空行更糟）。 */
    lines.forEach((ln, i) => {
      if (covered.has(i)) return
      seq += 1
      rows.push({ id: 'L' + seq, block: bi, blockName: name, text: '', x0Rel: ln.x0Rel })
      out.push(`L${seq}：（这一行没认出来）`)
    })
    if (!lines.length) out.push('（这一段没有行）')
    out.push('')
    bi += 1
  }

  if (Array.isArray(vocab) && vocab.length) {
    out.push('【你自己的词】下面这些词出自你自己的笔记（同层的优先）—— 认错字的时候优先往这些词上靠：')
    out.push(vocab.slice(0, 60).join('、'))
    out.push('')
  }
  if (Array.isArray(links) && links.length) {
    out.push('【你在板上连过的关系】（只作参考，不是所有关系都在这里）：')
    for (const l of links) out.push(`- ${l.from} → ${l.to}（${l.kind}）`)
    out.push('')
  }
  return { text: out.join('\n'), rows }
}

/* ── 四、结构整理交回来的东西 → 校验过的结构（**落行校验**）────────────────────
 *
 * 契约（写在 STRUCT_PROMPT 里）是一个 JSON：
 *   {
 *     "sections": [ { "title": 3, "frame": null, "say": "…", "rows": [ { "line": 4, "indent": 0 }, … ] }, … ],
 *     "relations": [ { "kind": "derive", "from": 3, "to": 9, "cond": 4 }, … ]
 *   }
 *   · `title` 是**行号**（拿那一行当小节的标题），不是文字；`frame` 是**第几段**
 *     （整段都在一个板框里时用它 —— 这样你亲手起的框名就成了小节名）；两个都可以省
 *   · `say` 是**唯一放行的一小段机器自己写的话**（见上面那一段说明）：缺席/空 = 不写
 *   · `rows` 里每一行只能出现一次；`indent` 0~3
 *   · `relations` 的 kind 只认那五个词（相关/因果/推导/并列/等价，写中文写英文都认）
 *
 * 校验（**每一条不通过的都是"丢掉 + 记一笔"，不是"猜一个近的"**）：
 *   · 行号必须在 rows 里 → 否则 dropped.push({why:'没有这一行', …})
 *   · indent 不是 0~3 的整数 → 夹到 0~3（这一条是**能用就用**，不值得丢一整行）
 *   · 同一行出现两次 → 第二次丢掉
 *   · 没被任何一节提到的行 → 记在 `unplaced`（调用方要把它们摆进草稿，不许丢）
 */
export function parseStructureOutput(raw, rows) {
  const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.id, r]))
  const dropped = []
  const body = stripFence(String(raw == null ? '' : raw)).trim()
  let obj = null
  try {
    obj = JSON.parse(body)
  } catch {
    /* 抠第一个 { 到最后一个 } 再试一次：模型常常在前后多说一句 */
    const a = body.indexOf('{')
    const b = body.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try {
        obj = JSON.parse(body.slice(a, b + 1))
      } catch {}
    }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '结构整理回的不是 JSON', sections: [], relations: [], dropped, unplaced: [...byId.keys()] }

  const num = (v) => (Number.isInteger(v) ? v : null)
  const idOf = (n) => (n == null ? null : 'L' + n)
  const sections = []
  const placed = new Set()
  /* 当小节标题用的行**也算"摆进去了"**（它以标题的身份出现在草稿里）。
     而且它还可以同时出现在 rows 里 —— 那是最自然的写法（标题就是这一节第一行），
     渲染那一趟会把它跳过，不重复列两遍。 */
  const titled = new Set()
  const blockIds = new Set((Array.isArray(rows) ? rows : []).map((r) => r.block))
  const arr = Array.isArray(obj.sections) ? obj.sections : []
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    const titleNum = num(s.title)
    const titleId = idOf(titleNum)
    let title = null
    if (titleNum != null) {
      if (!byId.has(titleId)) dropped.push({ why: '小节标题引用了没有的那一行', ref: titleId })
      else {
        title = titleId
        titled.add(titleId)
      }
    }
    /* **板框的名字也能当小节名**（第 2 步挣来的东西不能在这一步丢掉）：
       整段都在一个板框里时，模型写 `"frame": 2` 就用那个框的名字当标题。
       ⚠ 段号是**从 1 数**的（就是输入里 `── 第 N 段 ──` 那个 N）——
         让人（和模型）数错一格是最容易发生的事，所以协议和显示必须同一个数法。 */
    let frame = null
    const frameNum = num(s.frame)
    if (frameNum != null) {
      if (!blockIds.has(frameNum - 1)) dropped.push({ why: '小节说的"第几段"不存在（段号从 1 开始数）', ref: String(s.frame) })
      else frame = frameNum - 1
    }
    const rowsOut = []
    for (const r of Array.isArray(s.rows) ? s.rows : []) {
      if (!r || typeof r !== 'object') continue
      const n = num(r.line)
      const id = idOf(n)
      if (n == null || !byId.has(id)) {
        dropped.push({ why: '引用了没有的那一行', ref: id || JSON.stringify(r.line) })
        continue
      }
      if (placed.has(id)) {
        dropped.push({ why: '同一行被摆进了两次', ref: id })
        continue
      }
      placed.add(id)
      const ind = num(r.indent)
      rowsOut.push({ id, indent: Math.max(0, Math.min(STRUCT_INDENT_MAX, ind == null ? 0 : ind)) })
    }
    /* `say`：唯一放行的那一小段人话（护栏见文件头）。太长**截断并记一笔** ——
       截断是"丢了一点东西"，所以它必须出现在 `dropped` 里，不许静默。 */
    const say = cleanSay(s.say)
    if (say.truncated) dropped.push({ why: `整理稿太长（超过 ${SAY_MAX} 字），截断了`, ref: String(s.say).slice(0, 24) })
    if (title || frame != null || rowsOut.length || say.text) sections.push({ title, frame, rows: rowsOut, say: say.text })
  }

  const relations = []
  const seenRel = new Set()
  for (const r of Array.isArray(obj.relations) ? obj.relations : []) {
    if (!r || typeof r !== 'object') continue
    const kind = KIND_ALIAS.get(String(r.kind || '').trim().toLowerCase()) || KIND_ALIAS.get(String(r.kind || '').trim())
    if (!KINDS.includes(kind)) {
      dropped.push({ why: '关系词不在词表里（只有 相关/因果/推导/并列/等价）', ref: String(r.kind) })
      continue
    }
    const from = idOf(num(r.from))
    const to = idOf(num(r.to))
    if (!(from && to && byId.has(from) && byId.has(to))) {
      dropped.push({ why: '关系两头引用了没有的行', ref: `${from || r.from} → ${to || r.to}` })
      continue
    }
    const cond = num(r.cond) == null ? null : idOf(num(r.cond))
    if (cond && !byId.has(cond)) {
      dropped.push({ why: '关系的条件引用了没有的那一行', ref: cond })
    }
    const key = `${kind}|${from}|${to}`
    if (seenRel.has(key)) continue
    seenRel.add(key)
    relations.push({ kind, from, to, cond: cond && byId.has(cond) ? cond : null })
  }

  const unplaced = [...byId.keys()].filter((id) => !placed.has(id) && !titled.has(id))
  return { ok: true, sections, relations, dropped, unplaced }
}

function stripFence(s) {
  const m = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s)
  return m ? m[1] : s
}

/* ── 五、校验过的结构 → **笔记的小节**（第 1 步那套规矩在这儿落地）──────────────
 *
 * 返回 `{ sections: [{ title, lines }], leftover: [行 id…] }`：
 *   · `title` 是这一节的名字（字符串或 null，null 时由调用方起名 —— 草稿那边会编号）；
 *   · `lines` 是**没有 `##` 前缀的笔记行**（`- …` 和缩进）—— 小节头由草稿自己写，
 *     因为一份草稿里的节号是连着的（卡片几节 + 手写几节），这一层不该替它决定。
 *
 * 三条硬规矩：
 *   ① 每一个字都来自行清单（**模型没机会写字**）；
 *   ② 每一条都是笔记语法（`- ` 开头、两个空格一层），而且过得了 parseDoc
 *      （board-note.js 的 unreadableLines —— 那是第 1 步的判据）；
 *   ③ **没被摆进任何一节的行照样要出现在草稿里**（`leftover`，宁可丑不可丢）。
 *
 * 关系摆在哪：跟着**它的出发行**走，缩进一层挂在那一行底下 —— 于是"推导"就长在
 * 它所属的那一小节里，而不是文末一张和谁都无关的平表（第 1 步那张平表是权宜）。
 *
 * ★ **同一节里一模一样的关系行只写一遍**（2026-09-20）。真板上实测：同一条
 *   `推导 | → 那一大坨公式` 被挂在 4 个出发行底下，那 5 行 LaTeX 在同一节里出现 4 遍
 *   （一份 6850 字的草稿里一半是重复）。去掉重复**只去掉"同一节 + 同一行文字"**：
 *   换了一节照样各写各的（那是两个话题），而**你自己的行一个字都不动** ——
 *   你写了两遍同样的东西，那也得出现两遍（宁可丑，不可丢）。
 *   去掉几条**报数**给调用方（`dupRel`），草稿里会写一句 —— 不静默。 */
export function renderStructuredNote(structure, rows) {
  const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.id, r]))
  const struct = structure && structure.ok ? structure : { sections: [], relations: [], unplaced: [...byId.keys()] }
  const relByFrom = new Map()
  for (const r of struct.relations || []) {
    const arr = relByFrom.get(r.from)
    if (arr) arr.push(r)
    else relByFrom.set(r.from, [r])
  }
  let dupRel = 0
  const lineText = (id) => {
    const r = byId.get(id)
    if (!r) return ''
    return r.text && r.text.trim() ? r.text.trim() : '〔这一行没认出来〕'
  }
  const blockName = (bi) => {
    for (const r of byId.values()) if (r.block === bi) return r.blockName || ''
    return ''
  }
  /* `seen` 是**这一节**已经写过的那几行（每进一节换一个新的 Set —— 去重按节算）。 */
  const emitRel = (rel, atIndent, arr, seen) => {
    const meta = linkKind(rel.kind)
    const arrow = meta.dir ? '→' : '↔'
    const cond = rel.cond ? `（条件：${lineText(rel.cond)}）` : ''
    const line = '  '.repeat(atIndent) + `- ${meta.name} | ${arrow} ${lineText(rel.to)}${cond}`
    if (seen.has(line)) {
      dupRel += 1
      return
    }
    seen.add(line)
    arr.push(line)
  }
  const emitRow = (row, arr, seen) => {
    const ind = Math.min(STRUCT_INDENT_MAX, row.indent)
    arr.push('  '.repeat(ind) + '- ' + escapePipe(lineText(row.id)))
    for (const rel of relByFrom.get(row.id) || []) emitRel(rel, ind + 1, arr, seen)
  }

  const sections = []
  for (const s of struct.sections || []) {
    const lines = []
    const seen = new Set()
    const title = s.title ? lineText(s.title) : s.frame != null ? blockName(s.frame) : ''
    /* ★ 机器写的那一段**排在这一节的最前面**（先给"这几行在讲什么"，再给你写的原行）。
       它是一条**真节点**（`- ` 开头）—— 不是 `>` 那种只在编辑框里看得见的说明，
       所以阅读页签和导出里都有它。标记由我们加（`cleanSay` 已经把模型自己写的清掉了）。 */
    if (s.say) lines.push('- ' + MACHINE_SAY_MARK + s.say)
    for (const row of s.rows || []) {
      /* 当标题那一行不再重复列一遍（它就是小节名）—— 但它的关系照样要摆出来 */
      if (s.title && row.id === s.title) {
        for (const rel of relByFrom.get(row.id) || []) emitRel(rel, 1, lines, seen)
        continue
      }
      emitRow(row, lines, seen)
    }
    if (title || lines.length) sections.push({ title: title || '', lines })
  }

  const leftover = (struct.unplaced || []).filter((id) => byId.has(id))
  return { sections, leftover, dupRel }
}

/* 整块手写"没读成结构"时的退路：按行平铺成一节（一个字都不丢）。
   什么时候会走到这儿：模型没按行回话、或者结构整理没读出来 —— 退化成"照原文抄"，
   而不是编一个结构出来。 */
export function flatSection(rows, title = '') {
  const lines = []
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push('- ' + escapePipe(r.text && r.text.trim() ? r.text.trim() : '〔这一行没认出来〕'))
  }
  return { title, lines }
}

/* 校对界面那一栏：把"按行回来的稿"拆成**纯文字**（一行一条）给文本框 ——
   行号那一层是契约，不该让改字的人盯着 `L7|` 看。改完再用 `relines` 挂回去。 */
export function plainText(items) {
  return (Array.isArray(items) ? items : []).map((it) => (it && it.text) || '').join('\n')
}

/* 把改过的纯文字**挂回行号**上。
 * ⚠ 行数对不上（你在框里加了一行/删了一行）→ 回 null：**退化成"整段一块"**，
 *   结构整理那一趟就不参与这一块了。宁可退化，也不许把字挂到错的行号上 ——
 *   挂错了比不挂更糟（草稿里会出现一句"看着像你说的、其实位置是我们猜的"的话）。 */
export function relines(text, items) {
  const list = Array.isArray(items) ? items : []
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n')
  /* 空块（没认到任何一行，框里也确实是空的）→ 空数组，不是"退化" —— 本来就没东西可挂。 */
  if (!list.length && !lines.join('').trim()) return []
  if (lines.length !== list.length) return null
  return list.map((it, i) => ({ from: it.from, to: it.to, text: lines[i] }))
}

/* 和 board-note.js 的 noteLines 同一条规矩：行内的 ` | ` 会被笔记当成"标题 | 正文"的
   分隔符，悄悄把一行切成两半 —— 转成全角，两边空格留着。 */
function escapePipe(s) {
  return String(s == null ? '' : s).replace(/\s\|\s/g, ' ｜ ')
}

/* 给"这一段认得怎么样"的一句话（校对面板上显示）。**报数，不修饰**。 */
export function coverageNote(parsed, lineCount) {
  const got = Array.isArray(parsed && parsed.items) ? parsed.items.reduce((n, it) => n + (it.to - it.from + 1), 0) : 0
  const bits = [`${got}/${lineCount} 行认到了`]
  if (parsed && parsed.missing && parsed.missing.length) bits.push(`第 ${parsed.missing.join('、')} 行没认出来`)
  if (parsed && parsed.loose && parsed.loose.length) bits.push(`${parsed.loose.length} 行没按格式回`)
  if (parsed && parsed.bad && (parsed.bad.outOfRange || parsed.bad.dup)) bits.push(`${parsed.bad.outOfRange + parsed.bad.dup} 条行号有问题（已丢）`)
  return bits.join('；')
}

/* 笔记里认得的字段名（结构整理用它决定"这一行是不是一条字段"）。
   导出是给提示词那份说明用的 —— 两边（这里和 server-ocr.js 的提示词）必须对得上。 */
export const STRUCT_FIELD_KEYS = FIELD_KEYS
