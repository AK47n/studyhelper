/* 课件整理：把模型读回来的一段 JSON 收成**讲解**，再摆成板上的**卡片**。
 *
 * ── 这条路在整条链路上的位置 ────────────────────────────────────────────
 *   板上的一份资料（PDF/PPT，docs.js）
 *     → 你挑一段页（`DeckReview` 那个窗口里选的）
 *     → 每一页渲染成位图（doc-read.js，pdf.js 那一套和 DocLayer 同源）
 *     → 逐页发给视觉模型（server-ocr.js 的 mode:'doc'）
 *     → 回来一段 JSON —— **这个文件把它收成"讲解 + 重点 + 公式"**（normalizeDocExtract）
 *     → 你在窗口里校对/删减（DeckReview.jsx）
 *     → 落成板上的卡片（projectDeck，纯函数；写盘由 Board.jsx 做）
 *
 * ── 产出是"老师讲解"，不是"知识点卡"（2026-09-20 换的）──────────────────
 * 第一版（2026-09-22）是一页提炼 0~4 条知识点卡，贴成资料右边的一长溜。
 * 用户看完整份课件之后说：「这样子得出来的这些东西只能说是"可以读"但是完全无法自行理解……
 * 我们的目的是让这样整理 pdf/PPT 后学生能够在摆脱老师的情况下仍然能够学习」。
 * 所以现在一页出三样，**贴着这一页**摆（左：重点 + 公式；右：讲解）：
 *   · `explain` —— 像老师上课那样讲这一页（为什么、符号什么意思、和上一页什么关系）；
 *   · `points`  —— 3~5 条重点短句（复习扫一眼用的）；
 *   · `formulas`—— 关键式子，一条一张公式卡。
 * 一页 = 一个"讲台"：课件页在中间，右边是老师说的话，左边是板书提纲。
 *
 * ── 一条设计纪律：模型只交**内容**，位置和尺寸由本地算 ──────────────────
 * 提示词里**没有** x/y/宽高这一族字段，模型也没机会猜。它回来的是
 * `{ page, unit, explain, points, formulas }`（见 DOC_PROMPT），这个文件做两件事：
 *   · `normalizeDocExtract` —— 校验 + 补齐 + 拒绝，**一个字都不编**；
 *   · `projectDeck`         —— 把讲解摆成世界坐标的卡片（尺寸是量出来的，见下）。
 * 和 board-structure.js 那条纪律同源：**能算的绝不问模型，模型只负责"读出来"**。
 *
 * ★ 尺寸不是估的，是**量**出来的（`.bd-card` 的规矩：贴合内容）。
 *   `measureDeck` 用一个藏在屏幕外的真卡片量 —— 和 fitCardSize 量的是同一种 DOM。
 *   ⚠ 它只在浏览器里能跑；这个文件其余的导出全是纯函数（自检里断言得住）。
 *
 * ── 这个文件还管"另一张也要贴在页边的卡"（2026-09-22 加）──────────────────
 * 「留到板上」落下来的**答案卡**（追问 / 作业的答案，见 ADR-0006）贴在**同一栏**
 * （右栏 = 讲解那一栏），所以"这一页这一栏已经占到哪儿了"必须是**一份**判据：
 * `columnOccupancy` 算它，`projectDeck`（贴讲解）和 `planAnswerCard`（贴答案）都问它。
 * 各算一份的话，先留答案再整理课件，讲解会**正正压在**答案卡上 —— 而"压住"在板上
 * 是看不出来的（你得一张张拖开才知道），正是这个文件开头那段最忌讳的东西。
 *
 * ── 退化：模型没按格式回话时 ────────────────────────────────────────────
 * 和 board-structure.js 一样：**解析不了就报 parse 失败**，不猜、不硬凑。
 * 界面那一侧把它显示成"这一页没读懂"，让你重读那一页 —— 而不是悄悄少几张卡。
 */
import { CARD_MIN_W, DEFAULT_CARD_FONT, TEXT_CARD_MAX_W, cardHeightFromContent, cardWidthFromContent, fontCss } from './board.js'
import { DOC_PAGE_GAP } from './docs.js'
import { worldLenToScreen } from './view.js'
/* 「留到板上」那张答案卡的 kind（见 answer-cards.js）：它也是**讲义卡**（正文里的式子要排出来），
   所以量尺寸那一趟得按富文本量。单向依赖：那个文件谁都不 import。 */
import { ANSWER_KIND } from './answer-cards.js'
/* ★ 单方向：这一份**引** doc-summary，doc-summary 一个字都不引这里。
   为什么"哪些 kind 算讲义卡"这张表住在它那边：整节课的提纲也是其中一种，
   而提纲那一半的东西（字段、文案、摆位）都不属于"一页一课"这一套。 */
import { TEXT_KINDS } from './doc-summary.js'

/* ── 上限（都在这一处，别在调用方散着写）──
 * 为什么要有：模型偶尔会"把整页抄成 20 条"，而白板一次贴 200 张卡就不是"起点"了，
 * 是一场灾难。超了**不静默**：报数给界面，让人知道自己少拿到了什么。
 * ★ 2026-09-20 换了产出（老师讲解，见文件头）：一页固定是「讲解 1 + 重点 1 + 公式 ≤4」，
 *   所以每页的上限从 4 提到 6；总上限跟着从 60 提到 400（49 页的课件 ≈ 150~250 条，
 *   60 会把整份课件切成四段贴，而这条路的意义就是"一页一页顺着读"）。 */
export const MAX_ITEMS_PER_PAGE = 6
export const MAX_ITEMS_TOTAL = 400
export const MAX_TITLE_CHARS = 60
export const MAX_BODY_CHARS = 320
/* 讲解卡那一段可以很长（它就是"老师讲的话"）：900 字 ≈ 400 宽的一栏排 40 行左右。
   上限只是防疯，不是目标长度 —— 提示词里要的是 200~400 字。 */
export const MAX_EXPLAIN_CHARS = 900
export const MAX_POINT_CHARS = 90
export const MAX_POINTS = 6
export const MAX_FORMULAS = 4
export const MAX_UNIT_CHARS = 40

/* 本节这几条也是给量尺寸那一半用的：知识点卡**不是**公式卡也不是从笔迹认出来的卡，
 * 它是"一页纸上的几句话"，所以宽度夹在 [CARD_MIN_W, TEXT_CARD_MAX_W] ——
 * 太窄读不了、太宽一张卡就横穿整块板（那正是 TEXT_CARD_MAX_W 存在的理由）。 */
export const NOTE_MIN_W = CARD_MIN_W
export const NOTE_MAX_W = TEXT_CARD_MAX_W

/* ══════════════════ 一、把模型的话收成"老师讲解" ══════════════════ */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 文本清洗：**只做"看着一样"的那几件事**（空白、全角空格），一个字都不删。
 *  ★ 引号也留着：模型爱给标题包一对引号，但"定理：…"里的引号可能是真有意义的
 *    （board-structure.js 那边踩过同族的坑：剥引号会吃掉用户自己写的半个句子）。 */
function cleanText(raw, max) {
  let s = String(raw == null ? '' : raw)
  s = s.replace(/\r\n?/g, '\n').replace(/\u3000/g, ' ')
  s = s.replace(/[ \t]+/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  s = s.trim()
  if (max && [...s].length > max) s = [...s].slice(0, max).join('')
  return s
}

/** 一行内的换行压成空格（标题、小节名用）。 */
const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim()

/** 模型的原始 JSON 文本 → 对象。抠不出对象就返回 null（调用方报 parse 失败）。
 *  为什么这么松：模型爱包 ```json 围栏、爱在前后说两句人话 —— 那是噪声不是错误。 */
export function parseDocExtract(text) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fence ? fence[1].trim() : raw
  const direct = tryJson(body)
  if (direct) return direct
  /* 最后一道：从第一个 `{` 到最后一个 `}` 中间那段（前后有人话时）。 */
  const a = body.indexOf('{')
  const b = body.lastIndexOf('}')
  if (a >= 0 && b > a) return tryJson(body.slice(a, b + 1))
  return null
}

function tryJson(s) {
  try {
    const v = JSON.parse(s)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** 一条重点：**必须有内容**。空的丢掉（模型爱回空壳占位）。 */
function normPointLine(raw) {
  if (isObj(raw)) {
    const t = oneLine(cleanText(raw.title != null ? raw.title : raw.body, MAX_POINT_CHARS))
    return t || ''
  }
  return oneLine(cleanText(raw, MAX_POINT_CHARS))
}

/** 一串重点 → 重点卡上那一栏文字（每行一个 `- `）。一条都没有 → 空串（不出这张卡）。 */
export function pointLines(raw) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]
  const lines = []
  for (const it of list) {
    if (lines.length >= MAX_POINTS) break
    const s = normPointLine(it)
    if (s) lines.push('- ' + s)
  }
  return lines.join('\n')
}

/** 公式那一栏：字符串数组、`{tex}` 数组、或者一条字符串，都认。 */
export function formulaList(raw) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]
  const out = []
  for (const it of list) {
    if (out.length >= MAX_FORMULAS) break
    const tex = stripTexDelims(isObj(it) ? it.tex : it)
    if (tex) out.push(tex)
  }
  return out
}

/** 公式卡里存的是**不带定界符**的 tex（和 formula.js / ocr.js 同一条规矩）。 */
export function stripTexDelims(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) s = s.slice(2, -2).trim()
  /* ⚠ 这里原来是 `slice(1, -2)` —— 把 `$x^2$` 剥成 `x^`（连公式尾巴一起吃掉了）。
     以前没人发现，是因为老提示词要的是"不带 $ 定界符"；现在模型常常顺手包一层 `$…$`，
     2026-09-20 的自检当场把它抓出来了。**单 $ 要剥一头一尾**。 */
  else if (s.startsWith('$') && s.endsWith('$') && s.length > 2) s = s.slice(1, -1).trim()
  s = s.replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '').trim()
  return s
}

/**
 * 页面序列 → 小节（**纯函数**）。
 *
 * 为什么要有这一刀：模型是**一页一次**叫的（doc-read.js），而"这一节叫什么"
 * 只在换小节的那一页写（DOC_PROMPT 的 `unit`，空 = 沿用上一节）。
 * 所以"连着几页讲同一件事"这件事只有把页拼起来才看得出来 —— 拼的规矩在这里，
 * 界面和落卡都认这一份（免得窗口里分了组、落到板上又散成 8 张一样的小节卡）。
 *
 * @param {Array} pageList 按页号排好的每一项 `{ page, unit, items }`
 * @returns {{ units, items }}
 *   `units[]` = { id, name, pages, items }（`name` 可能是空串 —— 那一批没有小节名）
 *   `items[]` = 展平的知识点，**每一项都带 unitId**（落卡时要按 units 摆版）
 */
export function groupBySection(pageList = []) {
  const units = []
  let cur = null
  let seq = 0
  for (const p of pageList) {
    if (!p) continue
    const name = oneLine(p.unit)
    const items = Array.isArray(p.items) ? p.items : []
    /* 名字一样就并进上一组；名字空也并进上一组（"还在这一节里"）。
       第一页就没名字 → 开一个无名小节（不硬凑"未命名"，板上就不出那张小节卡）。 */
    if (cur && (name === '' || name === cur.name)) {
      cur.pages.push(p.page)
      cur.items.push(...items)
    } else {
      cur = { id: 'du' + (seq += 1), name, pages: [p.page], items: [...items] }
      units.push(cur)
    }
  }
  const items = []
  for (const u of units) for (const it of u.items) items.push({ ...it, unitId: u.id })
  return { units, items }
}

/**
 * 模型的一段回话 → 一页（或几页）的"老师讲解"骨架。
 *
 * ── 产出换了（2026-09-20）：从"知识点卡"换成"讲解 + 重点 + 公式" ─────────
 * 用户看完整份课件整理出来的知识点卡之后说：「只能说是"可以读"，但是完全无法自行理解……
 * 我们的目的是让这样整理 pdf/PPT 后学生能够在摆脱老师的情况下仍然能够学习」。
 * 所以一页不再只出 0~4 条提炼，而是出三样：
 *   · `explain`  右边那张卡：**像老师上课那样讲**（这页要解决什么、每个概念/符号什么
 *                意思、为什么这么做、和上一页什么关系）；
 *   · `points`   左边那张卡：3~5 条重点短句（复习扫一眼用的）；
 *   · `formulas` 左边的公式卡（一条一张，tex 不带定界符）。
 * 这三种在这条链路上是同一种东西（`items`），只是 `kind` 不同 —— 窗口、量尺寸、
 * 摆版都照旧按 kind 分派，所以换产出**没有**动那几层。
 *
 * ★ 回话形状认两档（**为了一个字段名把整批判失败不划算**）：
 *     ① `{ page, unit, explain, points: [...], formulas: [...] }`  ← 提示词要的这一档
 *     ② `{ pages: [ {…①…}, {…①…} ] }`                              ← 它把好几页塞一个回包
 *   `points` 里给字符串或 `{title, body}` 都认（老形状也吃得下，改提示词时不用同步改这里）。
 *
 * @param {string|object} raw      模型的回话（字符串或已经 parse 好的对象）
 * @param {object} opts
 *   · pages   这一批**发出去**的页号（1 起）。回来的 page 不在这张表里 → 归到这一批的
 *             第一页（模型报错页号是常事，不能因此把内容丢了）。
 *   · startId id 计数从哪儿起（同一个窗口里多批之间不撞号）
 * @returns {{ ok, sections, items, dropped, notes, nextId }}
 *   `sections[]` = { id, name, pages: [页号…] }（这一页开始的小节；空名 = 还在上一节）
 *   `items[]`    = { id, kind, title, body, tex, sectionId, page }
 *                 kind = 'explain' | 'points' | 'formula'
 *   `dropped`    = 因为"没内容 / 超上限"丢掉的条数（**要报给用户看**）
 *   `notes[]`    = 给人看的提示
 */
export function normalizeDocExtract(raw, { pages = [], startId = 0 } = {}) {
  const out = { ok: false, sections: [], items: [], dropped: 0, notes: [], nextId: startId }
  const obj = typeof raw === 'string' ? parseDocExtract(raw) : raw
  if (!isObj(obj)) return out

  const known = new Set((pages || []).map((n) => Number(n)))
  const fallbackPage = Number(pages && pages[0]) || 0

  const groups = Array.isArray(obj.pages) && obj.pages.length ? obj.pages.filter(isObj) : [obj]
  if (!groups.length) return out

  let id = startId
  let seen = 0
  let cur = null // 现在这一节（unit 为空就沿用上一节 —— 提示词里就是这么说的）
  for (const g of groups) {
    const unit = oneLine(cleanText(g.unit != null ? g.unit : g.name, MAX_UNIT_CHARS))
    if (unit) {
      cur = { id: 'ds' + (id += 1), name: unit, pages: [] }
      out.sections.push(cur)
    }
    if (!cur) {
      /* 一条都不在任何一节里（模型没写 unit）—— 给它一节"这一批"，
         不然它在板上没有归属。第一条回话必然走到这里。 */
      cur = { id: 'ds' + (id += 1), name: '', pages: [] }
      out.sections.push(cur)
    }
    const page = known.has(Number(g.page)) ? Number(g.page) : fallbackPage
    if (page && !cur.pages.includes(page)) cur.pages.push(page)

    /* 这一页要出的三样，按"右栏（讲解）→ 左栏（重点、公式）"的顺序收。 */
    const want = []
    const explain = cleanText(g.explain != null ? g.explain : g.lecture, MAX_EXPLAIN_CHARS)
    if (explain) {
      want.push({
        kind: 'explain',
        title: unit ? `${unit}（第 ${page} 页）` : `第 ${page} 页 · 讲解`,
        body: explain,
        tex: '',
      })
    }
    const points = pointLines(g.points != null ? g.points : g.items)
    if (points) want.push({ kind: 'points', title: `第 ${page} 页 · 重点`, body: points, tex: '' })
    for (const tex of formulaList(g.formulas != null ? g.formulas : null)) {
      want.push({ kind: 'formula', title: '', body: '', tex })
    }

    if (!want.length) {
      /* 一页什么都没讲出来 = 封面/目录/过渡页，**不是错误**（提示词允许空回话）。
         不报 dropped（那是"丢掉了东西"），也不出卡。 */
      out.notes.push(`第 ${page} 页没有可讲的内容（封面/目录/过渡页？）`)
      continue
    }
    for (let i = 0; i < want.length; i += 1) {
      /* 每页最多 6 条（讲解 1 + 重点 1 + 公式 ≤4，所以正常走不到这个上限）；
         超了**丢掉并报数**：白板的空间是有限的资源，多出来的卡会把板淹掉。 */
      if (seen >= MAX_ITEMS_TOTAL || i >= MAX_ITEMS_PER_PAGE) {
        out.dropped += 1
        continue
      }
      seen += 1
      out.items.push({ id: 'di' + (id += 1), ...want[i], sectionId: cur.id, page })
    }
  }

  /* 空节（有名字、一条都没有）：留着没用 —— 板上一张只有标题的卡不是讲解。
     但**报数**：那说明模型那一节什么都没读出来（可能是转场页），用户该知道。 */
  const used = new Set(out.items.map((x) => x.sectionId))
  const before = out.sections.length
  out.sections = out.sections.filter((s) => used.has(s.id))
  if (before > out.sections.length) out.notes.push(`有 ${before - out.sections.length} 个小节一条内容都没读到（多半是转场页）`)

  out.nextId = id
  out.ok = out.items.length > 0 || (out.sections.length === 0 && out.dropped === 0)
  return out
}

/* ══════════════════ 二、讲解 → 板上的卡片（贴着每一页摆） ══════════════════ */

/* 摆版的常量 —— 都在这一处。
 * 一栏多宽、一张卡之间留多少，直接决定"贴上去像不像一份讲义"。 */
export const CARD_GAP_X = 26 // 栏与栏之间（这一版按页分栏，留着给别处复用）
export const CARD_GAP_Y = 18 // 卡与卡之间
export const HEADING_GAP = 10
export const GROUP_GAP = 34
export const ORIGIN_GAP = 44 // 页面边缘和旁边那一栏之间
export const HEADING_H = 34

/* ── 「老师讲解」那一版的版面（2026-09-20）────────────────────────────────
 * 一页的左右两侧各一栏，**贴着这一页**：
 *   右栏 = 讲解（一张卡：像老师上课那样几段话）；
 *   左栏 = 重点（一张卡：几行短句）+ 公式（一条一张公式卡）。
 * ★ 为什么左右分开、而不是像上一版那样在资料右边排成一长溜：这一版要的是
 *   "翻到哪一页，那一页的讲解就在旁边" —— 学生顺着往下读就是一节课，没老师在也读得下去。
 * ★ 栏宽**固定** `SIDE_W`，不按内容量：讲解是几段话，按内容量会量成一条又宽又矮的
 *   长条（上限 TEXT_CARD_MAX_W=560），读起来像一行横幅。固定 400 宽 + 高度由内容定，
 *   才是"一栏讲义"。量尺寸那一半靠 `measureDeck` 的 `fixedW` 参数。
 * ★ 公式卡不固定宽（式子有长有短），按量出来的宽度**右对齐**贴在资料左边 ——
 *   往左长不会啃到页面上。 */
export const SIDE_W = 400
export const PAGE_PUSH = 30 // 上一块（栏）的底和下一块之间至少留这么多

/** 一页的左右两栏从哪儿起（世界坐标）。**只有这一处算** —— 摆版和自检都问它。 */
export function sideColumns(rect, sideW = SIDE_W, gap = ORIGIN_GAP) {
  return {
    left: { x: Math.round(rect.x - gap - sideW), y: Math.round(rect.y) },
    right: { x: Math.round(rect.x + rect.w + gap), y: Math.round(rect.y) },
  }
}

/** 一页的卡片标题（你圈的课件小节名）。空名就没有这张卡 —— 不硬凑"未命名"。
 *  ⚠ 这一版不再单出"小节卡"：小节名写进讲解卡的标题里（见 normalizeDocExtract）。 */
export function sectionHeading(section) {
  return section && section.name ? section.name : ''
}

/** 这一页的内容高到 `blockH`（从页顶量起）时，它后面要**额外**留多少空（`pageGaps` 那一格）。
 *  ★ 这个数**只有这一处**算：`projectDeck`（贴讲解）和 `planAnswerCard`（贴答案卡）都问它 ——
 *    两条路各写一遍的话，"一页 = 页面 + 它两侧的卡片"这条版面立刻会分叉。
 *  ★ 只有真的比页面还高才推下一页（`blockH > rectH`）：装得下就一个字节都不动 ——
 *    否则"整理过的资料"会整体多出一点缝，和没整理过的看起来不一样（假 diff 的来源）。 */
export function pageGapFor(blockH, rectH) {
  const h = Number(blockH) || 0
  const r = Number(rectH) || 0
  return h > r ? Math.max(0, Math.ceil(h + PAGE_PUSH - (r + DOC_PAGE_GAP))) : 0
}

/** ★ 「这一页多占的那点空」这一笔的**唯一**实现（2026-10-06 从三处收拢到这儿）。
 *
 * ── 为什么要收（和 C1 同一个病）────────────────────────────────────────
 *   `pageGaps` 那笔账有三个入口（`projectDeck` 贴讲解、`placeDeckCards` 落讲解卡、
 *   `keepAnswer` 留答案卡），每一处都要做**同样三件事**：
 *     ① 并进文件里已经写着的那个值 —— **只涨不缩**（地占下了就留着）；
 *     ② 算出每页**涨了多少**（`pageGaps` 记的是"多高"，不记"谁因此被推下去"）；
 *     ③ 把后面那些页上**已经在板上**的卡片按同样的量往下挪。
 *   三处各写一遍的后果不是"啰嗦"，是**2026-09-23 那个真 bug**（第 37 页涨 418、
 *   第 38 页那 5 张卡当场错位，文件里一切正常）：第三步最容易漏，而漏了**不报错**。
 *   ⚠ 真的已经漏过一次：留答案卡那处算 delta 时用的是 `const deltas = []` +
 *     `deltas[n-1] = delta`，即**稀疏数组** —— 而 `pageGapDeltas` 上面那段注释
 *     恰恰写着"稀疏数组的 `.length` 不等于页数，第一版写错过"。同一个陷阱有两个入口。
 *
 * @param {number} was  文件里这一页**已经写着的**空（0 / 垃圾值 / 负数都当 0）
 * @param {number} want 这一笔想让这一页有多少空（0 = 不动它）
 * @returns {{keep:number, delta:number}}
 *   `keep` = 并完之后该写的值；`delta` = 涨了多少（**只涨不缩**，所以恒 ≥ 0）。
 */
export function mergePageGap(was, want) {
  const lo = Math.max(0, Number(was) || 0)
  const hi = Math.max(0, Number(want) || 0)
  const keep = hi > lo ? hi : lo
  return { keep, delta: keep - lo }
}

/**
 * 整份 `pageGaps` 的同一笔账（`mergePageGap` 的批量版，**稠密**）。
 *
 * @param {Array<number>} was  文件里已经写着的（`[]` = 没整理过）
 * @param {Array<number>} want 这一笔想让每一页有多少空（可以稀疏：没给的格子当 0 = 不动）
 * @returns {{gaps:Array<number>, deltas:Array<number>, grew:boolean}}
 *   · `gaps`   并完之后该写进文件的那份（0 的格子不写，保持稀疏 —— 和旧文件一样干净）
 *   · `deltas` 每页涨了多少，**稠密且长度 = max(两份的长度)**，
 *               可以直接喂 `shiftLaterPageCards`（它要按下标做前缀和，
 *               稀疏的话 `.length` 不等于页数，第 3 页该挪多少就算不出来）
 *   · `grew`   到底有没有涨 —— 调用方靠它决定"这次要不要把 `pageGaps` 写回文件"
 */
export function growPageGaps(was, want) {
  const a = Array.isArray(was) ? was : []
  const b = Array.isArray(want) ? want : []
  const n = Math.max(a.length, b.length)
  const gaps = []
  const deltas = new Array(n)
  let grew = false
  for (let i = 0; i < n; i += 1) {
    const m = mergePageGap(a[i], b[i])
    if (m.keep > 0) gaps[i] = m.keep
    deltas[i] = m.delta
    if (m.delta > 0) grew = true
  }
  return { gaps, deltas, grew }
}

/**
 * 这一份资料的每一页、左右两栏里**已经有的东西**占到哪儿了（世界坐标的底边）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────────
 * 「讲解」和「答案卡」贴在**同一栏**（右栏），而它们是两条路落下来的
 * （课件整理 / 「留到板上」）。谁后落谁就得知道"这一栏上面已经到哪儿了"：
 * 各算一份的话，先留一张答案卡再整理这一页，讲解会正正压在它身上 ——
 * 而"压住"在板上是**看不出来**的（要一张张拖开才知道）。
 *
 * ── 一张卡归哪一页、哪一栏（一条口径，两处用）──────────────────────────
 *   · **归哪一页**：最后一个**不高于它页顶**的那一页（卡片是从页顶往下摆的）——
 *     和 `homework.js` 的 `spotOfCard` 同一条读法；
 *   · **归哪一栏**：按卡片的**中心 x** 落在哪一栏的横带里（`sideColumns` 那两栏）。
 *     按哪一条边判都会漏：讲解卡左对齐、公式卡右对齐，两边的边缘都不齐；
 *   · 两栏都不在（卡片浮在页面上、或者被拖到很右边）→ 它不占栏，谁都不挡。
 *
 * @returns {Array<{left:number|null, right:number|null}>} 下标 = 页号 - 1。
 *   `null` = 这一栏还空着（**不是 0** —— 资料的 y 可以是负的，0 会被读成"页顶之上还有东西"）。
 */
export function columnOccupancy({ rects = [], cards = [], sideW = SIDE_W, gap = ORIGIN_GAP, slack = 20 } = {}) {
  const list = Array.isArray(rects) ? rects : []
  const out = list.map(() => ({ left: null, right: null }))
  if (!list.length) return out
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c) continue
    const x = Number(c.x) || 0
    const y = Number(c.y) || 0
    const w = Number(c.w) > 0 ? Number(c.w) : 0
    const h = Number(c.h) > 0 ? Number(c.h) : 0
    let at = -1
    for (let i = 0; i < list.length; i += 1) {
      if (y >= (Number(list[i].y) || 0) - slack) at = i
    }
    if (at < 0) continue
    const cols = sideColumns(list[at], sideW, gap)
    const cx = x + w / 2
    const side = cx >= cols.right.x && cx <= cols.right.x + sideW ? 'right' : cx >= cols.left.x && cx <= cols.left.x + sideW ? 'left' : ''
    if (!side) continue
    const bottom = y + h
    const had = out[at][side]
    out[at][side] = had == null ? bottom : Math.max(had, bottom)
  }
  return out
}

/**
 * 「留到板上」那张卡摆哪儿（**纯函数**，ADR-0006 的决定 ②）。
 *
 * 贴在那一页的**右栏**（讲解那一栏），**接在已经有的东西下面**：
 * 答案和讲解是同一栏里的话（左栏是提纲：重点、公式）。
 *
 * @param {object} arg
 *   · rects / page —— 这一份资料的页面矩形 + 要贴哪一页（1 起）
 *   · cards        —— 板上现在那些卡片（算"这一栏占到哪儿了"用；`columnOccupancy`）
 *   · w / h        —— **量出来的**卡片尺寸（世界像素，见 measureDeck）
 * @returns {{x,y,w,h,pageGap}|null}
 *   `pageGap` = 这一页该有的 `pageGaps` 值。调用方**只涨不缩**地并进文件
 *   （和 `placeDeckCards` 同一条账），并和卡片**一次 commit** 写下去 ——
 *   分两次写的话，中间那一帧卡片和页面对不上。
 *   null = 这一页不在 rects 里（页号对不上）。
 */
export function planAnswerCard({ rects = [], page = 1, cards = [], w = SIDE_W, h = 0, sideW = SIDE_W, originGap = ORIGIN_GAP } = {}) {
  const n = Math.trunc(Number(page))
  const rect = (rects || [])[n - 1]
  if (!rect) return null
  const occ = columnOccupancy({ rects, cards, sideW, gap: originGap })[n - 1] || null
  const used = occ ? occ.right : null
  /* 空栏 → 从页顶起；有东西 → 接在它下面留一道缝。 */
  const y = used != null ? Math.round(used) + CARD_GAP_Y : Math.round(Number(rect.y) || 0)
  const x = sideColumns(rect, sideW, originGap).right.x
  return { x, y, w, h, pageGap: pageGapFor(y + (Number(h) || 0) - (Number(rect.y) || 0), rect.h) }
}

/**
 * 两份 `pageGaps` 的差 —— **只留正的**（`pageGaps` 只涨不缩，缩了就不是"多占了空"）。
 * 下标 = 页号 - 1，和 `pageGaps` 本身对齐。
 *
 * ★★ 返回的是**稠密**数组（没涨的格子是 0），长度 = max(两份的长度)。
 *   为什么不写成"稀疏、没涨的格子不写"（第一版就是那么写的，当场就错了）：
 *   稀疏数组的 `.length` **不等于页数** —— `[, 418]`（只有第 1 页涨了）的 length 是 1，
 *   而"总共有几页"这件事调用方必须知道，不然就没法算前缀和
 *   （第 3 页该挪多少？得知道第 1、2 页各涨了多少）。密度这点开销（一百来个 0）换来
 *   "length 就是页数"这条能站住的规矩，划算。
 */
export function pageGapDeltas(keep = [], was = []) {
  const a = Array.isArray(keep) ? keep : []
  const b = Array.isArray(was) ? was : []
  const n = Math.max(a.length, b.length)
  const out = new Array(n)
  for (let i = 0; i < n; i += 1) {
    const hi = Math.max(0, Number(a[i]) || 0)
    const lo = Math.max(0, Number(b[i]) || 0)
    out[i] = hi > lo ? hi - lo : 0
  }
  return out
}

/**
 * 某些页的 `pageGaps` 涨了 → 把**它们后面那些页上的卡片**一起往下挪同样的量。
 *
 * ── 为什么非要有这一步（用户 2026-09-23 报的真 bug）─────────────────────
 *   「问这里后印上板子会让原本与ppt对齐的卡片错位」。
 *   `pageGaps[n-1]` 一写大，`pageRects` 就把第 n 页**后面每一页**推下去
 *   （`docs.js` 那条累加），**可那些页上的卡片是绝对坐标、谁都不会动** ——
 *   于是页面走了、卡片留在原地，滚下去一看全对不上。
 *
 *   算一遍用户那张板的真数（`data/热力学与统计物理/board-近独立粒子地最概然分布.md`）：
 *     · 第 37 页 `pageGaps[36] = 238`（讲解卡比页面高，把第 38 页推下去 238）；
 *     · 在第 37 页「留到板上」，答案卡接在讲解卡下面 → 算出来这一页该留 **656**；
 *     · `planAnswerCard` 那边 `max(238, 656) = 656` ⇒ **增量 418**；
 *     · 第 38 页被推下去 418px，而它那 5 张卡一个都没动 ⇒ 错位 418。
 *
 * ── 判据为什么是卡片自己身上的 `ask.page`（而不是按几何猜）───────────────
 *   `ask: { doc, page }` 是卡片**自己声明**的出处 —— 讲解 / 重点 / 公式 / 答案卡
 *   落板时全都带着它（`Board.jsx` 的 `placeDeckCards` / `keepAnswer`），
 *   而且「？问这里」认"这张卡讲第几页"走的也是同一个字段（`ask-region.js`）。
 *   ⇒ 这里不再造第二份判据。按几何（卡片落在哪一栏的横带里）也能推，
 *     但那会把用户**故意拖到别处**的卡一并推走 —— 那是另一种看不懂。
 *   ⚠ 已知边界：**没有 `ask` 的卡**（用户自己手放、拖到页边的卡）不跟着走 ——
 *     它们没声明自己是哪一页的，推了反而错。这一条写在这儿，别当漏洞去"修"。
 *
 * ★ 和 `projectDeck` 里那个 `shift` 是同一条不变量的两半：
 *   那个管"**这一次要落**的卡"（边摆边把增量算进去），这个管"**已经在板上**的卡"。
 *   缺了后一半就会出现上面那个 418 —— 而且是**静默**的（文件里一切正常）。
 * ★ 挪多少是**按页累加**的（前缀和），不是"一律挪第一个增量"：
 *   一次操作里可能好几页都涨了（课件整理一批好几页），第 5 页上的卡该挪的是
 *   第 1~4 页涨的那些之和。⚠ 而**比 deltas 还靠后的页**（比如只涨了第 1 页，
 *   卡却在第 9 页）该挪的是**全部累计量**，不是 0 —— 第一版这里也写错过一次
 *   （前缀和数组查不到就当成"没涨"，于是第 3 页以后的卡一张都没动）。
 *
 * @param {object} arg
 *   · cards    板上现有的卡片
 *   · docPath  这些涨的空是**哪一份资料**的（`ask.doc` 精确比 —— 换过路径就认不出，
 *              那时候宁可不挪，也不"猜着挪"：挪错是不可逆的版面破坏）
 *   · deltas   `pageGapDeltas` 那份结果（下标 = 页号 - 1，稠密）
 * @returns {{ cards: Array, moved: number }} `moved` = 挪了几张（0 = 一个字节都没动，
 *   **连数组都不换**，免得调用方拿"引用变了"当成"真有东西动了"）。
 */
export function shiftLaterPageCards({ cards = [], docPath = '', deltas = null } = {}) {
  const list = Array.isArray(cards) ? cards : []
  const path = String(docPath || '')
  const d = Array.isArray(deltas) ? deltas : []
  if (!path || !d.length) return { cards: list, moved: 0 }
  /* 前缀和：`pre[i]` = 前 i 页涨的那些之和。
     ⇒ 第 k 页上的卡该挪 `pre[k - 1]`；而 k 超出 d 的范围时用 `pre[d.length]`（全部）——
       "比每一页涨的地方都靠后的页"要被**整笔**推下去，不是不动。 */
  const pre = [0]
  for (let i = 0; i < d.length; i += 1) pre.push(pre[i] + (Number(d[i]) || 0))
  const total = pre[pre.length - 1]
  if (!total) return { cards: list, moved: 0 }
  let moved = 0
  const out = list.map((c) => {
    if (!c) return c
    const ask = c.ask
    if (!ask || ask.doc !== path) return c
    const k = Math.trunc(Number(ask.page)) || 0
    if (!(k > 1)) return c
    const dy = pre[Math.min(k - 1, pre.length - 1)] || 0
    if (!(dy > 0)) return c
    moved += 1
    return { ...c, y: (Number(c.y) || 0) + dy }
  })
  if (!moved) return { cards: list, moved: 0 }
  return { cards: out, moved }
}

/**
 * 把讲解摆成世界坐标的卡片（**纯函数**：给同样的输入，永远摆出同样的版）。
 *
 * @param {object} arg
 *   · pages  [{ page, items }] —— 按页号排好的条目（items 已经是你筛过的那些）
 *   · sizes  Map<itemId, {w,h}> 或 { [itemId]: {w,h} } —— measureDeck 量的尺寸。
 *            **缺尺寸的条目会被跳过**（宁可少一张卡，也不要一张按估的尺寸摆下去的卡 ——
 *            估错高度 = 卡片互相压住，而"压住"在板上是看不出来的，得拖开才知道）。
 *   · rects  每一页的世界矩形（`docs.js` 的 `pageRects(doc)`，下标 = 页号 - 1）
 *   · occupied `columnOccupancy` 的那份结果 —— 这一页两栏里**已经有的东西**（答案卡、
 *            你自己拖过去的卡）占到哪儿了。**不传 = 老行为**（两栏都从页顶起），
 *            一个字节都不变。
 *   · existing 资料里**已经写着的** `pageGaps`（'' / 不传 = 没整理过）。
 *            ★ 为什么必须传（2026-09-22 修的一个真 bug）：`rects` 是从 `pageRects(doc)`
 *              来的，**里面已经含着这些空** —— 而下面那个 `shift` 是"自己从头累加一遍"，
 *              不减去已经含着的部分就等于**加了两遍**。症状是**安安静静**的：
 *              在一份整理过的课件上再点一次「课件整理」（默认全选，正是最常见的用法），
 *              第 2 页开始的讲解卡一页比一页低（第 2 页 +370、第 3 页 +740……），
 *              于是"第 7 页的讲解"贴在"第 5 页"旁边 —— 正是用户当年报的那句话。
 *              （现场探针：`npm run diag:deckshift`，一步就能看见。）
 *   · sideW / gap —— 见上面那两个常量
 * @returns {{ cards, placed, skipped, noRect, bounds }}
 *   `cards` 每一项 = { itemId, kind, side, page, x, y, w, h, text?, src?, tex? }
 *   —— 已经是**卡片的内容**（不是条目本身），Board.jsx 直接把它喂给 newCard。
 *   ⚠ `page`（1 起）是这张卡在讲第几页：落卡那一侧要把它写进卡片的 `ask`，
 *     不然"圈住讲解卡 → 问这里"认不出该问哪一页（ask-region.js 的第 ② 条路）。
 *   `noRect` = 没有页面矩形、因而摆不了的页号（资料不在板上 / 页号越界）。
 */
export function projectDeck({ pages = [], sizes = null, rects = [], sideW = SIDE_W, gap = ORIGIN_GAP, occupied = null, existing = null } = {}) {
  const sizeOf = (id) => {
    if (!sizes) return null
    const s = typeof sizes.get === 'function' ? sizes.get(id) : sizes[id]
    const w = Number(s && s.w)
    const h = Number(s && s.h)
    if (!(w > 0) || !(h > 0)) return null
    /* 夹一遍宽度：量尺寸那一侧已经夹过（measureCard），这里是第二道 ——
       摆版的输入也可能是别的调用方手工给的（夹具、以后的复用），
       而"卡片比板还宽"这种事在板上是看得见的丑。 */
    return { w: Math.min(NOTE_MAX_W, Math.max(NOTE_MIN_W, w)), h }
  }

  const cards = []
  const pageGaps = [] // 每一页后面额外留多少空（下标 = 页号 - 1）—— 见下面那段
  let skipped = 0
  const noRect = []

  /* ══ 一页 = 一个"讲台"：页面在中间，左右两栏**都从这一页的顶开始** ══
   *
   * ★ 为什么不是"两栏各自往下流"（第一版就是这么写的，2026-09-20 用户当场指出问题）：
   *   讲解常常比页面还高（页面 540 世界像素，400 多字的讲解 ≈ 900），一页的讲解流下去，
   *   下一页的卡片就被顶得更低 —— **滚下去以后卡片和页面对不上**，学生看到的是
   *   "第 7 页的讲解挨着第 5 页"。用户原话：「每一页卡片过长会让下一张卡片被顶到更加
   *   靠下的位置，这样就会让每页 ppt 并没有对齐每个卡片」。
   * ★ 所以：每页两栏都从**页顶**起，这一页占多高按它自己的内容算 ——
   *   比"页面 + 那道缝"高出来的部分，当作**这一页后面额外留的空**报出去（pageGaps），
   *   由调用方写进资料（docs.js 的 pageGaps）把下面那一页推开。
   *   于是"页面 + 它两侧的讲解"永远是一个整体，往下滚就是一页一课。
   * ⚠ 位置必须是**加过前面那些空之后**的 y：所以这里自己从头累加一遍 shift，
   *   而不是直接用 rects[i].y（那个 y 是"没被推开时"的位置）。
   *   ★★ 但 `rects` 是 `pageRects(doc)` 来的，**里面已经含着资料里写着的那些空** ——
   *      所以 shift 累加的必须是**增量**（`existing` 那个参数，见上面的说明），
   *      累加绝对值就等于把已经含着的空又加了一遍。
   * ⚠ 和"页面矩形只由 docs.js 的 pageRects 算"不冲突：pageRects 仍然是唯一定义，
   *   这里只是为**还没写进文件的新空**预算一遍（写完盘之后两者必然一致）。 */
  let shift = 0
  const topOf = []
  const list = [...(pages || [])].filter(Boolean).sort((a, b) => Number(a.page) - Number(b.page))
  for (const p of list) {
    const n = Number(p.page)
    const all = p.items || []
    const items = all.filter((it) => it && sizeOf(it.id))
    skipped += all.length - items.length
    const r = rects[n - 1]
    if (!r) {
      noRect.push(n)
      continue
    }
    const top = Math.round(r.y + shift)
    topOf[n - 1] = top
    const cols = sideColumns(r, sideW, gap)
    /* ★ 两栏各自的**起点**：页顶，或者"这一栏上面已经有的东西"之下（`occupied`）。
       ⚠ 没有这一条的话，"先点「留到板上」留了一张答案卡、再整理这一页"会让讲解卡
         **正正压在**答案卡上 —— 而"压住"在板上是看不出来的（见 columnOccupancy）。
       `-Infinity` = 这一栏空着（不是 0：资料的 y 可以是负的）。 */
    const occ = (occupied && occupied[n - 1]) || null
    const below = (v) => (v == null ? -Infinity : Math.round(Number(v)) + CARD_GAP_Y)
    const startR = Math.max(top, below(occ && occ.right))
    const startL = Math.max(top, below(occ && occ.left))
    /* 右栏：讲解（一条一张，正常就一张） */
    let rightH = 0
    let ry = startR
    for (const it of items.filter((x) => x.kind === 'explain')) {
      const sz = sizeOf(it.id)
      /* ⚠ `page` 要跟着卡交出去：落卡的那一侧靠它把"这张卡讲的是第几页"写进卡片的
         `ask`（圈住讲解卡 → 「？问这里」才知道该问哪一页，见 ask-region.js 第 ② 条路）。 */
      cards.push({ itemId: it.id, kind: it.kind, side: 'right', page: n, x: cols.right.x, y: Math.round(ry), w: sz.w, h: sz.h, text: cardText(it) })
      ry += sz.h + CARD_GAP_Y
    }
    /* 这一栏占多高**从页顶量起**（含它上面那段已经被占掉的）—— 下一页推多少看的是它。 */
    if (ry > startR) rightH = ry - CARD_GAP_Y - top
    /* 左栏：重点在上、公式在下 */
    let leftH = 0
    let ly = startL
    for (const it of items.filter((x) => x.kind !== 'explain')) {
      const sz = sizeOf(it.id)
      cards.push({
        itemId: it.id,
        kind: it.kind,
        side: 'left',
        page: n,
        x: Math.round(r.x - gap - sz.w), // 右对齐到资料左边：宽公式往左长，不啃页面
        y: Math.round(ly),
        w: sz.w,
        h: sz.h,
        ...(it.kind === 'formula' ? { src: it.tex, tex: it.tex } : { text: cardText(it) }),
      })
      ly += sz.h + CARD_GAP_Y
    }
    if (ly > startL) leftH = ly - CARD_GAP_Y - top
    /* 这一页占多高 = 页面、左栏、右栏里最高的那个。
       ★ 只有真的比页面还高才推下一页（`pageGapFor` 里那条）：装得下就一个字节都不动 ——
         否则"整理过的资料"会整体多出一点缝，和没整理过的看起来不一样（假 diff 的来源）。
       推的量 = 高出来的部分 + 一点缝，减去这一页本来就有的页间距。 */
    const blockH = Math.max(r.h, leftH, rightH)
    /* 这一页最后该有多少空 = 算出来的和**文件里已经写着的**取大的那个。
       ★ 「只涨不缩」那笔账在 `mergePageGap` 里（全仓唯一实现）——
         报出去的 `pageGaps` 是 `keep`，而 `shift` 累加的是 `keep - was` 这个**增量**。
         ⚠ 写成 `shift += extra` 就是上面那个"加两遍"的 bug（把已经含着的空又加一次）。 */
    const { keep, delta } = mergePageGap(existing && existing[n - 1], pageGapFor(blockH, r.h))
    if (keep > 0) pageGaps[n - 1] = keep
    shift += delta
  }

  const bounds = cards.length
    ? {
        x: Math.min(...cards.map((c) => c.x)),
        y: Math.min(...cards.map((c) => c.y)),
        w: Math.max(...cards.map((c) => c.x + c.w)) - Math.min(...cards.map((c) => c.x)),
        h: Math.max(...cards.map((c) => c.y + c.h)) - Math.min(...cards.map((c) => c.y)),
      }
    : null
  /* 加过新空之后的页面矩形：**只给调用方挪视野用**（写盘的是 pageGaps 本身）。 */
  const shiftedRects = rects.map((r, i) => (topOf[i] != null ? { ...r, y: topOf[i] } : r))
  return { cards, rects: shiftedRects, pageGaps, placed: cards.length, skipped, noRect, bounds }
}

/** 一条内容在一张文字卡里长什么样。
 *  ★ 为什么标题和正文合成**一张**卡而不是两张：板书是一小块一小块的，
 *    两张卡（标题一张、说明一张）在板上是并排/上下两张要你拖到一起 —— 而它们本来就是一件事。
 *    所以这里拼成一段文本，中间空一行（板上的卡片是 pre-wrap，空行就是段落）。 */
export function cardText(item) {
  const title = oneLine(item && item.title)
  const body = cleanText(item && item.body)
  if (title && body) return title + '\n\n' + body
  return title || body
}

/* ══════════════════ 三、量尺寸（只有浏览器里跑得了） ══════════════════
 *
 * 为什么摆版之前要**量**、不能按字数估：
 *   · 卡片的宽度是**硬约束**（board.js：`width` 写小了内容当场被裁），而文字折行只有
 *     排版引擎算得准；
 *   · 高度估小了 → 卡片互相压住。板上"压住"是看不出来的（不像纸上有重叠的边），
 *     你得一张张拖开才知道 —— 那正是这个功能最不该给的东西。
 * ★ 所以这里量的方式**和卡片平时量尺寸那一趟（Board.jsx 的 sampleCardForFit +
 *   card-fit.js 的 fitPass）逐条对齐**，连换算都调 board.js 那两个函数：
 *     · 量的是 `.bd-card-body` 的高度、读的是 `offsetWidth/offsetHeight`（布局值，
 *       不吃 transform —— 2026-09-21 那条"转过 30° 的卡被量胖一圈"的教训）；
 *     · 内边距从 computed style 读（box-sizing: border-box，不加就少一整圈）；
 *     · 屏幕像素 → 世界像素走 `cardWidthFromContent` / `cardHeightFromContent`。
 *   对齐的意义：贴上去之后**卡片不会自己再跳一下**（fitPass 会算出同一个数）。
 */

/* 量尺寸的台子：一张真的 `.bd-card` 挂在屏幕外。
 *
 * ★ **挂在谁身上很重要**（2026-09-22 自检抓到的第四处真 bug）：卡片的字号是
 *   `calc(15px * var(--s) * --bd-card-scale)` —— `--s` 是**界面字号档**，
 *   它由白板容器（`.bd-wrap`）定。挂在 `document.body` 上的话 `var(--s)` 取不到，
 *   字号退回根上的默认值，量出来的高度比板上真实渲染的**大一截**
 *   （实测同一句话：这里 137 世界像素、板上 101），于是紧接着摆的那张卡
 *   算出来的 y 就压在它身上（"后面的卡盖住前面的卡"，而且文件里看着一切正常）。
 *   所以台子挂在**板容器**里，量尺和真卡片处在同一个字体环境里。
 * ⚠ 挂进板容器之后**不要**再设 `--s: 1`：那等于把界面字号档强行掰成 1，
 *   又和板上的真实环境不一致了（README 第 15/16/17 条那一族坑的同一个形状）。 */
export function makeMeasureHost(wrap) {
  const host = document.createElement('div')
  host.setAttribute('data-deck-measure', '1')
  host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:0;height:0;overflow:visible;'
  ;(wrap || document.body).appendChild(host)
  return host
}

/** 把一段内容塞进屏幕外那张卡里量一次，返回 { w, h, padX, padY }（屏幕像素）。
 *  `content` 决定卡里装什么：文字卡给一个 `.bd-note`，公式卡给一个装了 KaTeX 的 `.bd-tex`。
 *  `maxW` 是这张卡的世界宽度上限（文字卡和公式卡各有一个，见 measureDeck）。
 *  `fixedW`（世界像素，>0 时生效）**跳过"按内容量宽"那一步**，直接按这个宽度量高度 ——
 *  「老师讲解」那一版要的是**一栏讲义**（固定 400 宽、高度随内容），
 *  而不是一条按内容撑开的长横幅（那是上一版知识点卡的量法）。 */
function measureCard(host, { kind, content, s, maxW, fixedW }) {
  const el = document.createElement('div')
  el.className = 'bd-card ' + (kind === 'formula' ? 'is-formula' : 'is-note')
  /* 位置/尺寸都钉死：位置在屏幕外（host 已经挪走了），宽度先给一个"自然宽"的测量值，
     高度写 `auto`（量的是内容，不是 min-height —— 卡片自己是 min-height，量它等于量自己）。 */
  el.style.cssText = `position:absolute;left:0;top:0;width:max-content;max-width:none;min-height:0;--bd-card-scale:${s};`
  const bodyEl = document.createElement('div')
  bodyEl.className = 'bd-card-body'
  bodyEl.appendChild(content)
  el.appendChild(bodyEl)
  host.appendChild(el)
  const cs = getComputedStyle(el)
  const padX =
    parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
  const padY =
    parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  /* 自然宽 → 夹进上下限 → 按**夹完的宽度**再量一次高度（宽度一窄，行数就变多）。
     两次量都在同一帧里做，屏幕上什么都看不见（host 在屏幕外、visibility: hidden）。 */
  const natural = cardWidthFromContent(bodyEl.offsetWidth, { s, scale: 1, padPx: padX })
  const w = Number(fixedW) > 0 ? Math.round(Number(fixedW)) : Math.min(Number(maxW) || NOTE_MAX_W, Math.max(NOTE_MIN_W, natural))
  el.style.width = worldLenToScreen(w, s) + 'px'
  const h = cardHeightFromContent(bodyEl.offsetHeight, { s, scale: 1, padPx: padY })
  host.removeChild(el)
  return { w, h }
}

const clampNoteW = (w) => Math.min(NOTE_MAX_W, Math.max(NOTE_MIN_W, Number(w) || NOTE_MIN_W))

/**
 * 量出每一条内容该占多大的卡（世界像素）。
 *
 * @param {object} arg
 *   · items   —— normalizeDocExtract 出来的条目（讲解 / 重点 / 公式）
 *   · renderTex(tex) → DOM 节点 | null  公式卡的渲染（App 层有 KaTeX，这里不引它）
 *   · renderRich(text) → HTML 串  讲义卡正文的渲染（`rich.js` 的 richHtml，App 传进来）。
 *                 **必须和 Card 那一侧同一份**，否则量出来的高度和真实渲染对不上。
 *   · host / s —— 量尺寸的台子；s 是**视图缩放**（和 card-fit.js 那个 s 一个意思）
 *   · fixedW  —— 文字卡的固定世界宽度（「老师讲解」那一版给 SIDE_W=400）。
 *                ⚠ 只对文字卡生效：公式卡按式子自己的宽度量（见 projectDeck 的右对齐）。
 * @returns {{ sizes: Map, note, formula, missing }}
 *   `missing` = 量不出来的（公式渲染失败 / 空内容）—— 那些**不会**被摆到板上，
 *   调用方要把它报出来（宁可少一张卡，也不要一张内容被裁掉的卡）。
 */
export function measureDeck({ items = [], renderTex = null, renderRich = null, host, s = 1, maxNoteW = NOTE_MAX_W, fixedW = 0 } = {}) {
  /* ★ 讲义卡（正文里能带 `$…$` 的那几种）**只有一处**说 —— 住 doc-summary.js，
     因为"整节课的提纲"也是其中一种。这里从前是手写的
     `it.kind === 'explain' || it.kind === 'points' || it.kind === ANSWER_KIND`，
     加第四种时必然有一处忘掉，而忘掉的表现是"提纲里那几行式子按纯文本量了高度，
     摆下去就压住旁边那张卡"—— 板上"压住"看不出来，得拖开才知道。 */
  const rich = new Set([...TEXT_KINDS, ANSWER_KIND])
  const sizes = new Map()
  let note = 0
  let formula = 0
  let missing = 0
  const scale = Number(s) > 0 ? Number(s) : 1
  for (const it of items) {
    if (!it) continue
    const node = document.createElement('div')
    if (it.kind === 'formula') {
      const inner = renderTex && it.tex ? renderTex(it.tex) : null
      if (!inner) {
        missing += 1
        continue
      }
      node.className = 'bd-tex'
      node.appendChild(inner)
      sizes.set(it.id, measureCard(host, { kind: 'formula', content: node, s: scale, maxW: maxNoteW }))
      formula += 1
      continue
    }
    const text = cardText(it)
    if (!text.trim()) {
      missing += 1
      continue
    }
    node.className = 'bd-note'
    node.style.fontFamily = fontCss(DEFAULT_CARD_FONT)
    /* ★ 讲义卡（讲解 / 重点，以及「留到板上」落下来的**答案卡**）：正文里夹着 `$…$` 的式子，
       要**按排出来的样子**量 —— 纯文本量一遍、真实渲染又是另一套 DOM 的话，
       高度差一截，贴上去就互相压住。
       所以这里向调用方要"和 Card 那一侧同一个 richHtml"（见 rich.js 的文件头）。 */
    if (renderRich && rich.has(it.kind)) {
      node.classList.add('rich')
      node.innerHTML = renderRich(text)
    } else {
      node.textContent = text
    }
    sizes.set(it.id, measureCard(host, { kind: 'note', content: node, s: scale, maxW: maxNoteW, fixedW }))
    note += 1
  }
  return { sizes, note, formula, missing }
}

/* ══════════════════ 四、分批（纯的，所以住在这里） ══════════════════
 *
 * ⚠ 为什么这几行不在 doc-read.js 里 —— 那个文件**一 import 就拉起 pdf.js**
 *   （`?url` 那两条 vite 语法 node 读不了），于是任何想在 node 里断言的脚本
 *   连碰都碰不到它。规矩是：**能被断言的纯函数住这个文件**，
 *   doc-read.js 只留"渲染 + 出网 + 缓存"那些非浏览器不可的东西。
 */

/* 一批最多几页、合计多少 base64 字符。
 * ★ 为什么按"合计字符数"分而不只按"页数"分：一页 4:3 的 PPT 和一张几千像素宽的
 *   长图（讲义扫描件常常是竖版）发出去的大小差好几倍 —— 只按页数分，
 *   遇到长图那一批会顶到服务端的体积上限（8MB）当场整批失败。
 * ★ 两个数是**一起**说话的（先撞上哪个听哪个）：一页按最坏情况估 1.4M 字符
 *   （1440×1080 的 JPEG 顶天 ~1MB，base64 之后 ×1.37），所以 4 页 ≈ 5.6M
 *   —— 上限就设在这个数上，于是"最多 4 页"和"最多 5.6M 字符"是同一条线。
 *   估大一点只是多分一批（多花几次往返），估小了会整批失败。 */
export const DOC_PAGE_CHARS_EST = 1400000
export const DOC_MAX_PER_BATCH = 4
export const DOC_BATCH_CHARS = DOC_MAX_PER_BATCH * DOC_PAGE_CHARS_EST

export function buildBatches(pages, { maxChars = DOC_BATCH_CHARS, maxPer = DOC_MAX_PER_BATCH } = {}) {
  const out = []
  let cur = []
  let chars = 0
  for (const p of pages || []) {
    const n = Number(p)
    if (!(n > 0)) continue
    if (cur.length && (cur.length >= maxPer || chars + DOC_PAGE_CHARS_EST > maxChars)) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(n)
    chars += DOC_PAGE_CHARS_EST
  }
  if (cur.length) out.push(cur)
  return out
}

/* ══════════════════ 五、显示用的小工具 ══════════════════ */

/** 知识点在窗口里/卡上显示成什么（标题 + 空行 + 正文）。 */
export function cardHasContent(c) {
  if (!c) return false
  if (c.heading) return !!String(c.text || '').trim()
  if (c.tex) return true
  return !!String(c.text || '').trim()
}

/** 「第 3-7 页」这种说法（窗口里、提示语里、卡片上都用它）。 */
export function pagesLabel(pages) {
  const list = [...new Set((pages || []).map((n) => Number(n)).filter((n) => n > 0))].sort((a, b) => a - b)
  if (!list.length) return ''
  const runs = []
  let start = list[0]
  let prev = list[0]
  for (const n of list.slice(1)) {
    if (n === prev + 1) {
      prev = n
      continue
    }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = n
    prev = n
  }
  runs.push(start === prev ? `${start}` : `${start}-${prev}`)
  return '第 ' + runs.join('、') + ' 页'
}

/* `parsePageSpec` 的**反方向**：`[1,2,3,8]` → `"1-3、8"`。
 * ★ 为什么要有它（2026-09-21）：选页那个框里"整段往前/往后挪一页"那两颗，
 *   挪完要把那句话**写回输入框** —— 输入框是唯一的实情，不能另存一份"挪了几页"
 *   （那样输入框和预览会各说一套）。写成什么样只有这一处说了算：连续的并成区间，
 *   和 `pagesLabel` 是同一副样子（人读得出来的那副）。
 * ⚠ 排好序、去重 —— 用户可能打 "8,3,3"。 */
export function formatPageSpec(pages) {
  const list = [...new Set((pages || []).map((n) => Math.trunc(Number(n))).filter((n) => n > 0))].sort((a, b) => a - b)
  const runs = []
  let start = null
  let prev = null
  for (const n of list) {
    if (start === null) {
      start = n
      prev = n
      continue
    }
    if (n === prev + 1) {
      prev = n
      continue
    }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = n
    prev = n
  }
  if (start !== null) runs.push(start === prev ? `${start}` : `${start}-${prev}`)
  return runs.join('、')
}

/* 屏幕上的页码选择那一套（"1-5、8、10-12" → [1,2,3,4,5,8,10,11,12]）。
 * ★ 为什么让人手打区间、而不是只做点选：49 页的课件点 30 下太烦，而"整理哪几页"
 *   本来就是一句话的事。纯函数，自检里断言得住。 */
export function parsePageSpec(spec, { max = 0 } = {}) {
  const out = new Set()
  const text = String(spec == null ? '' : spec)
  for (const chunk of text.split(/[\s,，、;；]+/)) {
    if (!chunk) continue
    const m = /^(\d+)\s*(?:[-~—–至到]\s*(\d+))?$/.exec(chunk)
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (!(a > 0) || !(b > 0)) continue
    const lo = Math.min(a, b)
    const hi = Math.min(Math.max(a, b), max > 0 ? max : Math.max(a, b))
    /* 一次最多展开 400 页：手滑打一个 "1-99999" 不该把界面卡死。 */
    if (hi - lo > 400) continue
    for (let i = lo; i <= hi; i += 1) out.add(i)
  }
  return [...out].sort((x, y) => x - y)
}

