/* 「作业辅导」这一趟**前端这一侧的纯口径**：学生说的"第几页第几题"怎么读、
 * 模型回的 JSON 怎么收、板上哪些卡算"这节课的知识"。
 *
 * ── 这一趟是干什么的（用户 2026-09-22 的原话）─────────────────────────────
 * 「用户会明确告知作业在哪里，通常来说都在书上。那么如果说我上传的是讲的 ppt，
 *   那么这个时候就还需要提醒我：我要把作业所在的那个 PDF 也传上来。然后我会告诉你
 *   具体的是哪几道题（第几页第几题），然后可以结合本节课的知识，这样能够对这道题
 *   做出更准确的回答。然后每道题要有答案也要有解析，解析的时候说人话。」
 *
 * 所以一条链路是四步：
 *   ① 作业在哪一份 PDF 里（多半是教材，和讲课那份 PPT **不是**同一份）；
 *   ② 哪几页哪几题（`parseHomeworkAsk`）；
 *   ③ 这节课讲过什么（`collectKnowledge` —— 板上那些讲义卡）；
 *   ④ 一页页图 + 这段话发给模型，回来每题一份「答案 + 解析」（`parseHomework`）。
 *
 * ── 为什么纯函数全在**这一个**文件里 ────────────────────────────────────
 * 划图和出网那半在 `homework-read.js`（它一 import 就拉起 pdf.js，自检碰不到）。
 * 这个文件一个浏览器 API 都不碰：**能在 node 里断言得住的东西住这边，
 * 要浏览器的住那边** —— 仓库里那条老规矩（doc-cards.js / doc-read.js 是同一刀）。
 *
 * ── 三条从"用起来会怎样"倒推出来的规矩 ──────────────────────────────────
 *   · **页号必须解析出来**：它不是给模型看的（模型看的是图上那条白带），
 *     是给**本地**用的 —— 要渲染哪几页、页号越界了要当场拦住。题号不解析：
 *     用户那句话原样发给模型更准（"第 3 题和第 5 题的第二问"这种写法，
 *     正则只会把它读坏）；
 *   · **一次最多问 `HW_MAX_PAGES` 页**：图是要花钱的，而作业的典型形状是
 *     "书上第 12 页第 3 题"这一两页。页数多了不是功能，是把钱烧在一堆没做的题上；
 *   · **空壳要丢掉、要报数**：模型偶尔会回一条 `answer` 和 `explain` 都空的题
 *     （它只是在占位）。丢掉它，并且把丢了几条说给用户听（和 doc-cards.js 的
 *     `dropped` 同一条纪律：**少拿到的东西不静默**）。
 */
import { ORIGIN_GAP, SIDE_W } from './doc-cards.js'
import { pageRects } from './docs.js'

/** 工具条上那颗按钮上的字（自检靠它找按钮；改字别只改 JSX）。只有一处。 */
export const HW_BUTTON = '✎ 作业辅导'

/** **选区浮层**上那颗按钮上的字（作业辅导的第二个入口）。
 *  ★ 为什么两颗按钮的字不一样：在浮层那里，你的动作已经说清了"就是这一块"，
 *    那颗按钮要回答的是"拿这一块做什么" —— 所以写"做这道题"比再写一遍"作业辅导"清楚。
 *    （和「？ 问这里」同一种口气：那一颗也没写"框选追问"。） */
export const HW_INK_BUTTON = '✎ 做这道题'

/** 一次最多问几页 —— **只有一处说这个数**。
 *  服务端（server.js 收 `file`、`file2`…）和这个文件都读它，别各写一个 3。 */
export const HW_MAX_PAGES = 3

/** 带上去的"这节课的知识"最多多少字。
 *  ★ 超了**不是"从后往前砍"**了（2026-09-22 改的）—— 现在是**分三段、按优先级保**：
 *    整节课那两张（提纲/须知）先保、逐页的重点和公式再保、讲解吃剩下的。
 *    完整规矩和理由在 `collectKnowledge` 的注释里（改之前先读那儿）。
 *  24000 ≈ 一份 15~20 页课件的讲解。再长的话：输入的钱和延迟都开始不像话，
 *  而且这一趟要的只是"这节课的那套语言"，不是把整本书塞进去。 */
export const HW_KNOWLEDGE_MAX_CHARS = 24000

/** 本地服务还是旧版时那句提示 —— 和「课件整理」「框选追问」同源同一条防线。
 *  5177 上跑的是**启动那一刻加载进内存的模块**：改了 server-ocr.js 却不重启，
 *  服务端就不认识 `mode:'homework'`，于是它按**公式**认、回一个 `{ ok, latex }`。
 *  前端不查 `mode` 回声的话，会把一句别的东西当成答案显示出来，而且一句报错都没有
 *  （2026-09-16「美化手写依旧在认公式」就是这个形状）。 */
export const HW_STALE_HINT =
  '本地服务还是旧版：它不知道「作业辅导」这个口。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后再点一次。'

/** 板上一张讲义卡都没有时，窗口里那一行字。
 *  ★ 这里要**说清楚"为什么没有"和"怎么才有"** —— 用户看到的只是一个空的知识栏，
 *    不说的话他会以为这个功能坏了。
 *  ★ 顺手提一句提纲和须知（它们也是这一趟要读的）：用户既然整理了课件，
 *    这一趟就该用上那份口径 —— 见 `collectKnowledge` 的三段排法。 */
export const HW_NO_LESSON_HINT =
  '板上一张讲解卡都没有，这一趟就只按作业页本身讲。想要它用上这节课的语言，先用「✧ 课件整理」把讲课那份 PPT 讲一遍 —— 讲解卡落到板上之后，这里会自动带上（整节课的提纲和做题须知排在最前面）。'

/* ══════════════════ 追问（学生对着刚拿到的答案接着问）══════════════════
 *
 * 用户原话：「对于问到的答案再加一个追问的功能，学生不懂的话可以继续问答案哪里是为什么」。
 *
 * ── 这一趟和「框选追问」差在哪儿 ────────────────────────────────────────
 * 框选追问的疑问在**课件那一页**上（红框定位）；这一趟的疑问在**老师刚写的那段答案**里，
 * 位置由**对话本身**定。所以这一趟的历史**必须先摆出那道题和那段答案**，
 * 否则老师看见的是一个凭空冒出来的"这一步为什么要除以 m" —— 它连是哪道题都不知道。
 *
 * ── 为什么"题目 + 答案 + 解析"要拼成一段**用户的**发言 ───────────────────
 * 上游只认 user / assistant 两个角色。把"老师给的答案"当成 assistant 的发言是**假**的
 * （那是我们贴上去的题，不是它说的），但拼成一条**用户**的话就完全成立：
 *   「老师，这道题是这样的：<题干>。你给的答案是……解析是……」
 * ★ 于是模型读到的是"学生转述了一道题和他的答案"，然后学生问"这一步为什么" ——
 *   对话是通的，而且**没有一个字是我们替模型说的**（没把它塞进它没说过的话里）。
 * ⚠ 反转过来（把答案标成 assistant）看着更自然，实则是让它"认领"一段它没说过的正文 ——
 *   它会顺着那段话往下编（"正如我上面说的……"），而那段话可能根本不是它写的
 *   （用户可以在两趟之间点「↻ 再做一次」，那是另一次调用、另一段答案）。 */

/** 题目的标签（"第 3 题"），没有就用页号兜底。 */
export function problemLabel(p) {
  const label = String((p && p.label) || '').trim()
  if (label) return label
  const page = Math.trunc(Number(p && p.page))
  return page > 0 ? `第 ${page} 页那道题` : '这道题'
}

/**
 * 把"这道题 + 老师给的答案"拼成追问历史的第一条（**用户**的发言）。
 *
 * @param {object} p  一道题（`parseHomework` 收出来的形状：label/page/question/answer/explain）
 * @returns {string}  拼好的那段话；这道题一个字都没有时回空串（调用方就别问了）
 */
export function problemPreamble(p) {
  if (!p || typeof p !== 'object') return ''
  const q = String(p.question || '').trim()
  const a = String(p.answer || '').trim()
  const e = String(p.explain || '').trim()
  if (!q && !a && !e) return ''
  const out = [`老师，这道题是这样的（${problemLabel(p)}）：`]
  if (q) out.push('', '【题目】', q)
  if (a) out.push('', '【你给的答案】', a)
  if (e) out.push('', '【你给的解析】', e)
  return out.join('\n')
}

/**
 * 拼出发给服务端的 `history` —— **这一趟追问之前的所有轮次**，按时间顺序。
 *
 * 形状就是「框选追问」那一个（`{ role, text }`），因为服务端那一侧的拼装
 * （`callDeepSeek` 的 `messages`）是**同一段代码**：第 0 条 = 图 + 提示词，
 * 后面按时间顺序跟历史，最后一条是这一次问的。两三处各拼一遍一定会有一处忘了拼。
 *
 * @param {object} p      这道题（见 `problemPreamble`）
 * @param {Array}  turns  这道题下面**已经问过的**几轮：`[{ role:'user'|'assistant', text }]`
 * @returns {Array<{role:string,text:string}>}
 *   ★ 空的那几条**不发**：上游会把 `content: ''` 当成空消息（不报错，但模型看到的是
 *     "自己刚才什么都没说"）。没答完的占位（`pending`）也不发 —— 它没有正文。
 */
export function problemHistory(p, turns = []) {
  const head = problemPreamble(p)
  const rest = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && !t.pending && String(t.text || '').trim())
    .map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text) }))
  if (!head) return rest
  return [{ role: 'user', text: head }, ...rest]
}

/* ══════════════════ 一、学生说的"第几页第几题" ══════════════════ */

/* 全角数字洗成半角：中文输入法下 `１２` 是家常便饭，而正则里写两套字符类
   只会让后面每一条都长一倍。**只洗数字** —— 别的全角字符（，、：）模型自己看得懂。 */
const toHalf = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

/**
 * 把学生写的那句话读成**要发哪几页**。
 *
 * 认这几种写法（都是手边最顺的写法，不是"设计过的语法"）：
 *   · `第 12 页第 3 题`、`12页3题`、`第12页 3、4 题`
 *   · `第 12-13 页第 3 题`（范围；`-` `–` `—` `~` `～` `至` `到` 都算）
 *   · `P120 第 3 题`、`p.120 第 3 题`
 * ★ 题号**不解析**（见文件头）：只有页号是本地非要知道的东西。
 *
 * @param {string} text  学生写的那句话（原话会原样发给模型，这里只是**另外**读一遍）
 * @param {object} arg
 *   · maxPage  这份资料一共几页（0 = 不知道，就不校验越界）
 * @returns {{ pages:number[], ask:string, error:string }}
 *   `error` 非空 = 这一趟点不下去（界面拿它拦住按钮并显示那句话）。
 */
export function parseHomeworkAsk(text, { maxPage = 0 } = {}) {
  const ask = String(text == null ? '' : text).trim()
  const out = { pages: [], ask, error: '' }
  if (!ask) {
    out.error = '先写一句做哪几道题 —— 比如「第 12 页第 3 题」'
    return out
  }
  let rest = toHalf(ask)
  const push = (n) => {
    const v = Math.round(Number(n))
    if (v > 0 && !out.pages.includes(v)) out.pages.push(v)
  }
  /* ⚠ 顺序要紧：先认**范围**，并且把认掉的那一段从串里抹掉 ——
     `第 12-13 页` 里那个 12 也会被下面"单页"那条抓到，抹不掉就会算两遍。 */
  rest = rest.replace(/(\d{1,4})\s*[-–—~～至到]\s*(\d{1,4})\s*页/g, (m, a, b) => {
    const x = Number(a)
    const y = Number(b)
    if (y >= x) for (let i = x; i <= y; i += 1) push(i)
    else push(x)
    return ' '
  })
  /* 单页：`第 12 页` / `12 页` / `12页`。`第` 可有可无 —— 省一个字是人之常情。 */
  rest = rest.replace(/第?\s*(\d{1,4})\s*页/g, (m, a) => {
    push(a)
    return ' '
  })
  /* `P120` / `p.120`：`P` 前面不能是字母（不然 `PPT 12` 里的 P 也想插一脚）。 */
  rest = rest.replace(/(?:^|[^a-zA-Z0-9])[Pp]\.?\s*(\d{1,4})(?![0-9])/g, (m, a) => {
    push(a)
    return ' '
  })

  if (!out.pages.length) {
    out.error = '得知道是**哪一页**上的题 —— 写「第 12 页第 3 题」这样（只写"第 3 题"的话，我不知道去翻哪一页）'
    return out
  }
  out.pages.sort((a, b) => a - b)
  if (maxPage > 0) {
    const over = out.pages.filter((p) => p > maxPage)
    if (over.length) {
      out.pages = out.pages.filter((p) => p <= maxPage)
      out.error = `这份资料只有 ${maxPage} 页，没有第 ${over.join('、')} 页 —— 页码是不是写错了？`
      return out
    }
  }
  if (out.pages.length > HW_MAX_PAGES) {
    out.error = `一次最多 ${HW_MAX_PAGES} 页（这一趟要把每一页都发给模型看）—— 你写了 ${out.pages.length} 页，挑最要紧的那几页，或者分几次问`
    out.pages = out.pages.slice(0, HW_MAX_PAGES)
    return out
  }
  return out
}

/* ══════════════════ 二、模型回的 JSON ══════════════════ */

/* 从一段话里把 JSON 抠出来：模型偶尔会在前面加一句"好的，我看看"、
   后面加一句"希望有帮助"（哪怕提示词里明说了不要）。
 * ★ 先试整个串（正常情况），不行再抠第一个 `{` 到最后一个 `}`。
 * ⚠ 别写成"从头扫括号配对"：JSON 的字符串里就有花括号（答案里写集合 `{1,2}` 是常事），
   手工配对一定会错，而 `JSON.parse` 自己就够聪明。 */
function sliceJson(text) {
  const s = String(text == null ? '' : text).trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  return a >= 0 && b > a ? s.slice(a, b + 1) : s
}

const clip = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()
  return max && s.length > max ? s.slice(0, max) + '…' : s
}

/* 一条题目归一。**空壳丢掉**（返回 null）：`answer` 和 `explain` 都空的，
 * 是模型在占位，不是一道题。 */
function normProblem(it) {
  if (!it || typeof it !== 'object') return null
  const label = clip(it.label || it.title || it.no || it.name, 40)
  const question = clip(it.question || it.stem || it.body || it.problem, 4000)
  const answer = clip(it.answer || it.result || it.solution, 4000)
  const explain = clip(it.explain || it.explanation || it.analysis || it.reason, 12000)
  const page = Math.round(Number(it.page)) || 0
  if (!answer && !explain) return null
  return { label: label || (page ? `第 ${page} 页` : '这道题'), page, question, answer, explain }
}

/**
 * 把模型回的那段 JSON 收成题目数组。
 *
 * @returns {{ problems:Array, dropped:number, error:string }}
 *   `dropped` = 丢掉的空壳条数（**要报给用户**，见文件头）；
 *   `error` 非空 = 整趟没成（一条都没收出来，或者它压根没回 JSON）。
 *   ★ 「回了个空数组」是**成功**的一种（`problems: []`、`error: ''`）：
 *     那一页上找不到他说的那道题时，模型就是照提示词这么回的 ——
 *     界面要能把这句话显示出来，而不是弹一句"失败了"。
 */
export function parseHomework(raw) {
  const out = { problems: [], dropped: 0, error: '' }
  const text = String(raw == null ? '' : raw).trim()
  if (!text) {
    out.error = '模型没回内容'
    return out
  }
  let obj = null
  try {
    obj = JSON.parse(text)
  } catch {
    try {
      obj = JSON.parse(sliceJson(text))
    } catch {
      out.error = '模型回的不是 JSON（它多半写成了一段话）—— 再点一次试试'
      return out
    }
  }
  const list = Array.isArray(obj)
    ? obj
    : obj && Array.isArray(obj.problems)
      ? obj.problems
      : obj && Array.isArray(obj.items)
        ? obj.items
        : obj && Array.isArray(obj.results)
          ? obj.results
          : null
  if (!list) {
    out.error = '回话里没有 `problems` 这一栏 —— 再点一次试试'
    return out
  }
  for (const it of list) {
    const p = normProblem(it)
    if (!p) {
      out.dropped += 1
      continue
    }
    out.problems.push(p)
  }
  return out
}

/* ══════════════════ 三、这节课的知识（板上的讲义卡） ══════════════════ */

/* 哪些卡算"这节课讲过的"：
 *   · **讲义卡**（`rich: true` 的文字卡）—— 课件整理贴上去的讲解和重点。
 *     这个字段是那一趟**独有**的：你手写的笔记卡永远不会带 `rich`
 *     （board.js 注释里写死了"手写笔记那条路不许被当 Markdown 渲染"）；
 *   · **钉住的公式卡**：整理贴上去的公式一律 `locked: true`。用 `locked` 当判据是
 *     因为它是"这张卡是素材、不是我此刻在写的东西"那个意思 —— 正好是我们要的。
 *     ⚠ 你自己后来钉住的公式卡也会算进来。那是**故意的**：它就在这节课的板面上，
 *       对这道题有用；多一条式子比少一条强。
 * 判据写得松一点没关系（多带一点上下文），**紧了才有害**（学生会觉得"我讲过的东西它不知道"）。
 * ★ 整节课那两张卡（提纲 / 须知）也是 `rich: true` 的钉住的文字卡，所以它们**天然**落在
 *   这一条里 —— 不需要在这里为它们加分支。它们和逐页那些卡的区别在 `collectKnowledge`
 *   里处理（那是"摆在哪一段"的事，不是"算不算知识"的事）。 */
function isLessonCard(c) {
  if (!c || typeof c !== 'object') return false
  /* ★ 答案卡不算"这节课讲过的东西"：它是「留到板上」落下来的**上一题的答案**，
     和课件整理贴上去的讲解长得一模一样（都是 `rich` 的文字卡）—— 带进来就是让模型抄自己
     （第二题的答案里混着第一题的解法，而且它会一路攒下去）。
     出处是独立字段 `answer`（和 sum/rules 同一个套路，Board.jsx 的 keepAnswer 写上去的）。 */
  if (c.answer === true) return false
  if (c.kind === 'note') return c.rich === true && !!String(c.text || '').trim()
  if (c.kind === 'formula') return c.locked === true && !!String(c.src || c.tex || '').trim()
  return false
}

/* 这一张是不是"整节课那一层"的卡（提纲 / 须知）。
 * ★ 判据是卡上的**出处字段**（`sum` / `rules`）—— 和 Board 那边
 *   "认亲不动 kind"同一条（板层的 kind 只有 formula/note 两种，出处写在独立字段上）。
 * ⚠ **不要**用位置判（"它没贴在任何一页旁边"）：板书上一条普通笔记也可能落在页面左边，
 *   而那正是这一趟最不该误伤的东西（它是学生自己写的）。
 * ⚠ 也不要在这里 import doc-summary.js 的 `isSummary`：那两个谓词吃的是**条目层**
 *   的 kind（`'summary'`/`'rules'`），而这里手里拿到的是**板层的卡**（它们的 kind 是 'note'）。
 *   两层混用会让判据永远为假 —— 而表现是"提纲照旧被当成某一页的卡混在中间"（静默）。 */
function isDeckLevelCard(c) {
  return !!c && (c.sum === true || c.rules === true)
}

/* 一张卡属于**哪一份资料的哪一页**：按位置判（卡片是贴着页面摆的，位置就是它唯一的关联）。
 * ★ 判不出来返回 `{ doc: null, page: 0 }` —— 那就把它放在最前面，别丢
 *   （"不知道是哪一页"比"没有这条知识"好得多）。
 * ★★ 整节课那两张卡（提纲 / 须知）走**另一条**：它们的 `page` 是 0
 *   （`placeDeckCard` 就摆在第一页左边），位置判会把它们算成"第 1 页的卡"。
 *   而它们要说的是"整节课的东西"，不是"第 1 页的重点" —— 这一趟（做题）读到的
 *   【第 1 页】底下如果蹲着一份六段提纲，模型会以为那是第一页的内容。
 *   ⚠ 它们**还是要知道属于哪一份课件**（板上可能并排两份课件的题）——
 *     所以这里照旧走横向那一段，只是把页号钉成 0。
 *   判据用 `isDeckLevelCard`（看卡上的 `sum`/`rules`），**不是**看位置猜。 */
function spotOfCard(card, docs) {
  const cx = Number(card && card.x) || 0
  const cy = Number(card && card.y) || 0
  const deckLevel = isDeckLevelCard(card)
  for (const d of docs) {
    const rects = pageRects(d)
    if (!rects.length) continue
    const first = rects[0]
    const last = rects[rects.length - 1]
    /* 横向：页面 + 它两侧那两栏（SIDE_W + ORIGIN_GAP，和 projectDeck 摆版时同一条账）——
       板上并排两份资料时，只按纵向判会把右边那份的卡算到左边那份头上。 */
    const left = first.x - SIDE_W - ORIGIN_GAP - 20
    const right = first.x + first.w + SIDE_W + ORIGIN_GAP + 20
    if (cx < left || cx > right) continue
    if (cy < first.y - 20 || cy > last.y + last.h + 20) continue
    /* 整节课那两张：属于这份课件，但**不属于任何一页**（page 0 = 那一段"整节课的"）。 */
    if (deckLevel) return { doc: d, page: 0 }
    /* 落在第几页：**最后一个不高于它的页顶**那一页（卡片是从页顶往下摆的）。
       ⚠ 页与页之间那道缝（DOC_PAGE_GAP）也可能夹着一张卡 —— 那就算它属于上一页，
         差一页不影响用途（这段文本是给模型当语言背景的，不是给学生看的目录）。 */
    let page = 1
    for (let i = 0; i < rects.length; i += 1) {
      if (cy >= rects[i].y - 20) page = i + 1
    }
    return { doc: d, page }
  }
  return { doc: null, page: 0 }
}

/** 板上那几份讲义（给窗口里的"知识来源"下拉用）：`[{ path, title, count }]`。
 *  一份都没有 = 这块板上还没整理过课件。 */
export function lessonSources(cards = [], docs = []) {
  const out = []
  const seen = new Map()
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!isLessonCard(c)) continue
    const { doc } = spotOfCard(c, Array.isArray(docs) ? docs : [])
    const key = doc ? doc.path : ''
    if (!seen.has(key)) {
      const item = { path: key, title: doc ? String(doc.title || doc.path || '') : '不在这几份课件旁边', count: 0 }
      seen.set(key, item)
      out.push(item)
    }
    seen.get(key).count += 1
  }
  return out
}

/**
 * 把板上的讲义卡拼成"这节课讲过的东西"那一段文字。
 *
 * ── 这一段的排法（2026-09-22 改过，改之前先读）───────────────────────────
 * 用户的顾虑：「现在的老师做题无法吸纳一整节课的卡片因为太多了，
 *   但是有这个总结会不会好很多」。所以这一段的形状**不是**"一堆卡按位置排开"，
 * 而是**三段，从粗到细**：
 *   ① **【整节课】**  —— 提纲 + 做题须知（整节课那两张卡，`page: 0`）。
 *      放在最前面、单独一段、标题就写"整节课"。为什么：
 *      · 做题最需要的是**口径**（单位、符号、先干什么），那是须知要说的；
 *      · 其次需要**形状**（这几节在讲什么），那是提纲要说的；
 *      · 这两样是"整节课"的，**不属于任何一页** —— 埋在三十张逐页卡中间，
 *        模型得自己去认哪几条是"整节课的规矩"（而它只有一次机会读）。
 *   ② **【这节课的要点】** —— 逐页的重点卡和公式卡（`points` / `formula`）。
 *      "要问的那道题大概率就在这些页附近"，所以它们排第二。
 *   ③ **【逐页讲解】** —— 讲解卡（`explain`，最长的那一批，一页 250~400 字）。
 *      排最后、而且**超上限时最先被丢的就是它**（见下面"三段预算"）。
 *
 * ── ★ 为什么截断**不能**再是"从后往前砍"（老写法）────────────────────────
 * 老写法是：按位置排好之后，从头往里塞，塞不下就 `continue` —— 于是末尾那一批
 * **静默地整批消失**，只在最后留一句"还有 N 张卡没带上"。
 * 而排在最前面的是第 1 页的东西 —— 一节课 40 页时，前面几页把预算吃光，
 * **后半节课的讲解全没了**，而那道作业题很可能就在后面。
 * ★★ 提纲当时"侥幸活着"纯属排序巧合（`x` 降序让左栏排前）。现在它是**明文保下来的**。
 *
 * ── 三段的预算（改数之前先读）───────────────────────────────────────────
 * 预算按段给，而且**优先级是反的**（越靠前越不可动）：
 *   · ① 整节课那两张：**先保**（最多 40% 的预算）。它们本来就只有一两千字，
 *     正常情况下一次就用完，永远轮不到"被丢"。万一板上有十份课件都贴了提纲，
 *     那也不该把预算全吃了 —— 所以给个盖子。
 *   · ② 重点/公式：**再保**（剩下的里最多 45%）—— 它们是"这道题要用到的那几条"。
 *   · ③ 讲解：**吃剩下的全部**，不够就按页**从后往前**丢。
 *   ★ 于是"被丢的"永远是**最后面那几页的讲解**，而不是"整份的后半截什么都看不见"。
 *     而"整节课"那一段**任何情况下都在**。
 *
 * @param {Array} cards  板上的卡片（`board.cards`）
 * @param {Array} docs   板上的资料（`board.docs`）—— 只用来判"这张卡属于哪一页"
 * @param {object} arg
 *   · path      只取这一份资料的卡（空 = 板上所有讲义卡都带上）
 *   · maxChars  上限（见上：三段各有各的盖子）
 * @returns {{ text, count, chars, truncated, pages, sources, droppedPages }}
 *   `truncated` = 丢掉了多少张卡（不是字数）—— 界面要把它说给用户听。
 *   `droppedPages` = 被丢掉的卡涉及哪几页（**报给用户看**：他能判断"丢的那几页里有没有我要的题"）。
 */
export function collectKnowledge(cards = [], docs = [], { path = '', maxChars = HW_KNOWLEDGE_MAX_CHARS } = {}) {
  const docList = Array.isArray(docs) ? docs : []
  const docIndex = new Map(docList.map((d, i) => [d.path, i]))
  const picked = []
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!isLessonCard(c)) continue
    const spot = spotOfCard(c, docList)
    const key = spot.doc ? spot.doc.path : ''
    if (path && key !== path) continue
    /* `deck` = 整节课那两张（提纲 / 须知）：它们单独成段，不参与页序排列。 */
    picked.push({ card: c, key, page: spot.page, di: docIndex.has(key) ? docIndex.get(key) : -1, deck: isDeckLevelCard(c) })
  }
  /* 排序：先按资料在板上的顺序，再按页，再**按 x 从大到小**（一页的右栏是讲解、
     左栏是重点和公式 —— 先读讲解、再读提纲，正是上课的顺序），最后按 y。
     ⚠ `di - 1`（判不出属于哪份资料的）排最前 —— 和从前一样，"不知道是哪一页"
       比"没有这条知识"好得多。 */
  picked.sort((a, b) => a.di - b.di || a.page - b.page || (Number(b.card.x) || 0) - (Number(a.card.x) || 0) || (Number(a.card.y) || 0) - (Number(b.card.y) || 0))

  const sources = lessonSources(cards, docList)
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 0
  /* ── 预算怎么切（★ 改比例之前先读这一段，2026-09-22 在这里踩过一次）────────
     第一版是按"整节课 ≤ 40%、重点/公式 ≤ 45%、讲解吃剩下的"切的，
     结果自检当场打脸：20 页的板、预算 12000 时，**前面 8 页的重点和讲解都在，
     第 9~20 页的重点全丢了** —— 因为重点段的 45% 被前几页**按顺序**吃光了，
     而重点卡恰恰是"一页一张、每张都很小"的东西：它是**逐页均匀**的，
     不该被"前面几页先到先得"分配。
     ⇒ 现在的规矩是：**重点/公式一页一张，优先全保**（它本来就小：20 页也就两三千字）；
       讲解才是那个会被砍的（它有 250~400 字/页，是真正的开销）。
       于是"预算不够"的表现变成**只有讲解被裁**，而每一页的**重点都还在** ——
       做题的人至少每一页都有抓手，不会出现"后面半本书对我来说是空的"。
     ★ 整节课那两张仍然单独先保（它们比重点还优先：口径错了，后面全错）。 */
  const deckCap = Math.round(cap * 0.4)
  const bodyOf = (c) => (c.kind === 'formula' ? '公式：$$' + String(c.src || c.tex || '').trim() + '$$' : String(c.text || '').trim())

  /* ── ① 整节课那两张：**先保**，两张各自带一句小标题（"提纲" / "做题须知"）──
     ★ 小标题不是装饰：模型看到【整节课】底下两段，得知道哪一段是**口径**（须知）、
       哪一段是**形状**（提纲）。不给小标题的话它们就是一坨，而须知那一张的
       三段小标题（单位/口径/最容易错的）在下面接得**像同一段话的延续**。 */
  const deckRows = []
  let deckUsed = 0
  let deckDropped = 0
  for (const it of picked.filter((x) => x.deck)) {
    const body = bodyOf(it.card)
    if (!body) continue
    const label = it.card.rules === true ? '做题须知' : '提纲'
    const block = `\n<${label}>\n${body}\n`
    if (cap && deckUsed + block.length > deckCap) {
      deckDropped += 1
      continue
    }
    deckRows.push(block)
    deckUsed += block.length
  }

  /* ── ② 重点/公式（逐页，page ≥ 1）：**优先全保**（见上面"预算怎么切"那段）──
     ★ 它们也**从后往前丢**吗？不 —— 这一段的每一条都小，正常情况一页都丢不着；
       真到了"板上有 200 页的重点卡"这种地步（有人把整本书都整理了），
       丢尾部的那些：**读得进去的前面那部分仍然是一份连贯的讲义**，
       比"每两页留一条"更像讲义。 */
  const mkRow = (it) => {
    const body = bodyOf(it.card)
    if (!body) return null
    return { it, body, block: `\n【第 ${it.page} 页】\n${body}\n` }
  }
  const keyRows = []
  let keyUsed = 0
  let keyDropped = 0
  let lastKeyPage = -1
  for (const it of picked.filter((x) => !x.deck && x.card.kind !== 'explain')) {
    const row = mkRow(it)
    if (!row) continue
    /* 同页的第二条起不用再写一次页头 —— 省下来的正是"能多带一张卡"的那点钱。 */
    const block = it.page !== lastKeyPage ? row.block : '\n' + row.body + '\n'
    if (cap && deckUsed + keyUsed + block.length > cap) {
      keyDropped += 1
      continue
    }
    keyRows.push({ ...row, block })
    keyUsed += block.length
    lastKeyPage = it.page
  }
  const explRows = []
  let explUsed = 0
  let explDropped = 0
  const droppedPages = new Set()
  let lastExplPage = -1
  for (const it of picked.filter((x) => !x.deck && x.card.kind === 'explain')) {
    const row = mkRow(it)
    if (!row) continue
    const block = it.page !== lastExplPage ? row.block : '\n' + row.body + '\n'
    /* 讲解的预算是**剩下的全部**（`cap` 减去上面两段真用掉的）。 */
    if (cap && deckUsed + keyUsed + explUsed + block.length > cap) {
      explDropped += 1
      if (it.page > 0) droppedPages.add(it.page)
      continue
    }
    explRows.push({ ...row, block })
    explUsed += block.length
    lastExplPage = it.page
  }

  const truncated = deckDropped + keyDropped + explDropped
  const pageRows = [...keyRows, ...explRows].sort((a, b) => a.it.page - b.it.page)
  const count = deckRows.length + pageRows.length
  if (!count) return { text: '', count: 0, chars: 0, truncated: 0, pages: [], sources, droppedPages: [] }

  const segs = []
  if (deckRows.length) segs.push(`\n【整节课】（不属于任何一页，整节课都适用）\n${deckRows.join('')}`)
  if (pageRows.length) segs.push(pageRows.map((r) => r.block).join(''))
  const head = '── 这节课的讲义（板上整理出来的）──'
  let text = head + segs.join('')
  /* 页号那一份：**只报逐页那些**（第 0 页是"整节课"，它不是页）——
     界面和自检都拿它当"讲到第几页了"。 */
  const pages = []
  for (const r of pageRows) if (r.it.page > 0 && !pages.includes(r.it.page)) pages.push(r.it.page)
  pages.sort((a, b) => a - b)

  if (truncated) {
    /* ★ 尾注要说三件事，别只说一句"还有 N 张没带"：
       ① 丢的是**哪些页**（用户能自己判断"我要的题在不在这几页里"）；
       ② 丢的是**讲解**为主（不是"整份的后半截都没了"）；
       ③ 整节课那两张**在不在** —— ⚠ 只有板真有那两张时才敢这么说
          （老板、或者没整理过整节课那两张时说了就是**假话**，
           而假话比不说更坏：用户会去板上找一张不存在的卡）。 */
    const tailPages = [...droppedPages].sort((a, b) => a - b)
    const deckWords = deckRows.length ? '**整节课那两张（提纲、须知）都在**，' : ''
    text +=
      `\n（这份讲义太长，装不下全部：${deckWords}` +
      `上面是第 ${pages[0] || 1}~${pages[pages.length - 1] || 1} 页的重点和讲解，` +
      (tailPages.length ? `第 ${tailPages.join('、')} 页的讲解没带上` : `有 ${truncated} 张卡没带上`) +
      '。）'
  }
  return { text, count, chars: text.length, truncated, pages, sources, droppedPages: [...droppedPages].sort((a, b) => a - b) }
}
