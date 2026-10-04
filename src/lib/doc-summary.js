/* 课件整理 · **整节课那一层的两张卡**（提纲 + 做题须知，都落在第一页左边）。
 *
 * ── 它补的是哪个洞（用户 2026-09-22 的请求）──────────────────────────────
 * 「讲解 ppt 最后给一个总结，这个总结你自己想想该怎么写包含什么比较好，
 *   现在只是讲解每一页」。
 * 逐页那一趟（`DOC_PROMPT`）出的三样东西都是**挂在某一页上**的：讲解、重点、公式。
 * 一节课的**骨架**（哪几节、每节在讲什么、节与节怎么接上）在逐页那一趟里
 * 一个字都没有 —— 小节名只在每页那个小标签里闪一下，学生合上课件之后手里没有线的这一头。
 * 这个文件负责把"线的另一头"拼出来：**提纲**（形状，给学生复习）。
 *
 * 后来又加了第二张（用户同一天的原话）：
 *   「我需要这个总结一方面用于自己看，还有一方面我在思考现在的老师做题
 *     无法吸纳一整节课的卡片因为太多了，但是有这个总结会不会好很多」。
 * 「老师做题」那一趟（`mode:'homework'`）要的不是形状而是**口径** ——
 * 于是这个文件里多了**做题须知**（口径，给做题那一趟看）。两者的分工、
 * 以及为什么必须分开两张卡，写在下面 `RULES_KIND` 那一段里（改之前先读）。
 *
 * ── 它为什么**不住** doc-cards.js ────────────────────────────────────────
 * 不是因为那一半不纯 —— 它也是纯的；是**份量**：
 * 整节课那一层的字段、文案、摆位和逐页那一套（三样东西、左右两栏）几乎没有交集，
 * 住一起会让下面这些"一页一课"的推导段被一份"整份课件"的说明夹在中间，
 * 下一批来读的人两件事一起看，分不清哪条规矩对哪一边。
 * `doc-cards.js` 里那份 `_避免_` 单子也不是随便划的：逐页那三样东西要躲开"总结"这个词，
 * 不然模型会退化成"把这一页要点再抄一遍"—— 所以这两半的产物在**形状和话术上**
 * 本来就得分开长。
 *
 * ── ★ 三条铁律（改这个文件之前先读）────────────────────────────────────
 *  ① **只许用"已经讲过的内容"**：这一趟拿到的是一份**摘要**（逐页的节名和重点），
 *     不是原始课件 —— 模型看不见图，任何"补充""展开"都是从别处搬来的，
 *     而这份提纲是要当**整节课的地图**用的：地图上多画一条路，学生就会走错。
 *     这条护栏靠提示词（`SUMMARY_PROMPT` / `RULES_PROMPT`）压，
 *     也靠自检里的 `_判据_` 那几节钉住。
 *  ② **不写 `pageGaps`**：整节课那两张卡不是"某一页的东西"，它们不该把任何一页往下推。
 *     这条有自检（"源码里不许出现 pageGaps"）—— 见下面 `placeDeckCard` 的说明。
 *  ③ **缺什么就不写什么**（`section: null` / 段里没内容就不出那一段），
 *     绝不硬凑一句"本节内容较为基础"这种话 —— 那是要被人先删掉才能用的东西
 *     （和 STRUCT_PROMPT 的 `say`、board-structure 那位老前辈同一个规矩）。
 */

/* ══════════════════ 一、形状 ══════════════════ */

/** 提纲在条目（`items`）里的 kind —— 和 'explain' / 'points' / 'formula' 平级。
 *  ⚠ 值必须和 `doc-cards.js` 的 `TEXT_KINDS`（哪些算讲义卡）以及
 *    DeckReview 的空行判断保持一致；三处对不上时，"它自己那一段"会连着一堆空行。 */
export const SUMMARY_KIND = 'summary'

/** 提纲卡的标题（显示在卡上、也可以改）。
 *  ★ 为什么不写课件的名字：整块卡片就贴在**这份课件**的第一页左边，
 *    "这份"已经由位置说清了（文件头的规矩：人一眼看明白的，卡上不必再写一遍）。 */
export const SUMMARY_TITLE = '这一节课的提纲'

/* ══════════════════ 「做题须知」══════════════════
 *
 * ── 它补的是哪个洞（用户 2026-09-22 的原话）──────────────────────────────
 * 「我需要这个总结一方面用于自己看，还有一方面我在思考现在的老师做题
 *   无法吸纳一整节课的卡片因为太多了，但是有这个总结会不会好很多」。
 *
 * ── 它和「提纲」差在哪儿（这是这一整块存在的理由）────────────────────────
 * **提纲回答"这节课讲了什么"，须知回答"做题时按哪套规矩来"。**
 * 前者是**地图**（给学生复习用的）：骨架、脉络、必记、易错、核心式子、自测。
 * 后者是**说明书**（给下一趟"做题的那位"看的）：单位怎么写、符号怎么约定、
 * 有哪几条一路要守的口径、这一步最经典的那种错法。
 *
 * ★ 为什么**必须分开两张卡**，不能塞进提纲里：
 *   · 两者的**读者不是同一个人**。学生要的是"合上课件之后手里那条线"，
 *     所以提纲里要有骨架和页号、要有自测问题；而做题的人（`mode:'homework'`
 *     的那一趟）拿到"自测：为什么第一步要画受力图？"**一点用都没有** ——
 *     那是给学生的自查题，不是它会用到的口径。
 *   · 反过来，"单位一律用国际单位制、矢量要标方向"这种话对复习的学生是噪音。
 *     一张卡同时给两个人写，两边都会觉得一半是废话 —— 而卡片是**要读完才有用**的，
 *     一半废话的代价不只是浪费一半篇幅。
 *   · 落卡这件事本身也支持拆开：两张卡都是"整节课的东西"（`page: 0`），
 *     都走 `placeDeckCard` 那一条路（一上一下排开），多一张只是多占一次第一页左栏，
 *     不需要动"一页一课"的那整套账（铁律②照旧）。
 *
 * ── 为什么叫「须知」不叫「注意事项 / 提示」──────────────────────────────
 * 「注意事项」听着像免责声明（读完就忘）；「提示」太轻（像是可选的）。
 * 「须知」在中文里就是**"下手之前得知道的那几条"** —— 旅馆的入住须知、
 * 考场的考生须知，都是"你不看就一定会踩坑"的那个语气。正好是这一张要的。
 */

/** 「做题须知」在条目（`items`）里的 kind —— 和 `SUMMARY_KIND` 平级。
 *  ⚠ 同样是**条目层**的：板上的 `kind` 仍然是 `'note'`（走 `rules: true` 认亲），
 *    和提纲那一张同一条道理（见 doc-summary.js 文件头 + Board.jsx 的注释）。 */
export const RULES_KIND = 'rules'

/** 「做题须知」卡的标题。
 *  ★ 不写"这一节课的"：它就贴在这份课件的提纲下面，位置已经说清了是哪一节课的。 */
export const RULES_TITLE = '做题须知'

/** 须知的**固定顺序**（也是模型要按这个顺序回）。
 *  ★ 这三段是照着"做题的人翻到这张卡时会问什么"排的，不是照着知识结构排的：
 *    ① 先问"拿什么量"（单位/符号）→ ② 再问"按哪套口径来"（约定/步骤）
 *    → ③ 最后是"最容易在哪儿翻车"（常见错法）。
 *  ⚠ **不要**把提纲那六段抄过来：`must` / `pitfalls` 和这里的 `traps` 看着像，
 *    其实不同 —— 提纲的「易错」是"学生最容易想错的地方"（概念层），
 *    这里的 `traps` 是"做题时最容易写错的那一步"（操作层，比如"最后忘了写单位"
 *    "矢量只写大小不写方向"）。混在一起，模型会退化成把提纲的易错再抄一遍。 */
export const RULES_PARTS = [
  { key: 'units', short: '单位与符号', ask: '做题时用哪套单位、哪些量怎么写、下标的约定' },
  { key: 'conv', short: '口径', ask: '动手前得知道的那几条规矩：先干什么、按什么格式写、答案留几位' },
  { key: 'traps', short: '最容易错的', ask: '写这一步时最容易漏掉/写错的地方（操作层的，不是概念层的）' },
]

/* 每一段的条数上限 —— 和 `RULES_PROMPT` 里那句"最多几条"是**一对**。
 * ★ 为什么比提纲紧得多：须知是**做每一道题之前**扫一眼的东西，
 *   它长了就没人看第二遍（"一张读不完的须知"和没有须知是一样的）。
 *   一张卡上最多 3+4+3 = 10 行 —— 比提纲（最多 12+6+7+4+5+5）短得多，这是**故意的**。 */
export const MAX_UNITS = 3
export const MAX_CONV = 4
export const MAX_TRAPS = 3

/** 提纲四段的**固定顺序**（也是显示顺序，也是模型要按这个顺序回）。
 *  `short` 是段在卡上的小标题；`ask` 是给模型看的一句话说明（拼提示词用）。
 *  ⚠ 顺序不能随手调：脉络接在骨架后面读，才像一条路。 */
export const SUMMARY_PARTS = [
  { key: 'sections', short: '骨架', ask: '这节课分成几节、每节讲什么、每节是哪几页' },
  { key: 'flow', short: '脉络', ask: '这几节之间怎么接上的（从哪儿来、接下来用到什么）' },
  { key: 'must', short: '必记', ask: '跨页的通则或结论（换一页也仍然成立的那种）' },
  { key: 'pitfalls', short: '易错', ask: '最容易想错、最容易混的地方' },
  { key: 'formulas', short: '核心式子', ask: '整节课真正在用的那几个式子（不是每一页的式子的堆砌）' },
  { key: 'check', short: '自测', ask: '几个能自查"我到底学懂没有"的问题（**不要写答案**）' },
]

/* 每一段的条数上限。
 * ★ 这些数和 `SUMMARY_PROMPT` 里那句"最多几条"是**一对**，改一处就得改另一处
 *   （自检里直接判提示词里有没有这几个数）。
 * ★ 为什么是这几条：提纲卡是**整节课一张**，而逐页那三样东西已经很多了 ——
 *   它再长出十几行，学生第一眼就跳过它（一块谁也读不完的提纲等于没有提纲）。 */
export const MAX_SECTIONS = 12
export const MAX_FLOW = 6
export const MAX_MUST = 7
export const MAX_PITFALLS = 4
export const MAX_FORMULAS = 5
export const MAX_CHECK = 5

/* 一条有多长。**一行**是硬约束：卡片的宽度是固定一栏宽（SIDE_W），
   一行太长会折成两行 —— 那正是"一块读不完的提纲"的开头。 */
export const MAX_LINE_CHARS = 46
export const MAX_SECTION_NAME_CHARS = 24
export const MAX_CHECK_CHARS = 56

/* 逐页那三样东西 + 整节课那两张的 kind（"算讲义卡"的那几个 —— 正文按 Markdown 排、
   里面能带 `$…$` 的那几种）。
 * ⚠ 这份表**只有这一处**：doc-cards.js 的 TEXT_KINDS 从这里引 ——
 *   加一种正文里能带 `$…$` 的卡，就在这儿加一行。
 * ★ 目前 = 逐页的 {讲解, 重点} + 整节课的 {提纲, 须知}。 */
export const TEXT_KINDS = ['explain', 'points', SUMMARY_KIND, RULES_KIND]

/** 这一条是不是"整节课的提纲"（不是挂在某一页上的东西）。
 *  落卡、量尺寸、显示三处都问它 —— 三处各写一遍 `kind === 'summary'` 的话，
 *  加第四种正文卡时必然有一处忘掉（那种表现是"一条内容静默地按别的方式处理"）。 */
export function isSummary(item) {
  return !!item && item.kind === SUMMARY_KIND
}

/** 这一条是不是"做题须知"（整节课的、给做题那一趟看的口径）。
 *  ★ 和 `isSummary` **分开两个函数**（不是 `isDeckLevel(item)` 一个）：两处的**去处不同** ——
 *    提纲和须知在 `placeDeckCards` 里各占一次第一页左栏、各带各的 provenance 字段
 *    （`sum` / `rules`）、界面上也各有各的一块。合成一个的话，那张"是整节课的"
 *    布尔值到了落卡那一步还得再分一次，等于把同一件事判两遍。
 *  ★ 但两者**共同的那一件事**（"它没有页号、不进 projectDeck"）单有一个谓词：见 `isDeckLevel`。 */
export function isRules(item) {
  return !!item && item.kind === RULES_KIND
}

/** 是不是"整节课那一层的东西"（提纲 / 须知 —— 不属于任何一页、`page: 0`）。
 *  ★ 这个谓词是**给 Board.jsx 分半用的**：那一处只关心"哪些条目不走 projectDeck"，
 *    不关心它是提纲还是须知。散成两处 `isSummary(it) || isRules(it)` 的话，
 *    加第三张整节课的卡（比如"作业页码表"）时必然漏掉一处 —— 而漏掉的后果是
 *    那个条目被塞进 projectDeck，`rects[-1]` 取不到 → flash 里冒一句没指任何人的错。 */
export function isDeckLevel(item) {
  return isSummary(item) || isRules(item)
}

/* ══════════════════ 二、模型回话 → 提纲 ══════════════════ */

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => String(v == null ? '' : v)

/** 一行文字：压掉换行和多余空白、夹到 `max` 个字。空 → 空串。 */
function oneLine(raw, max = MAX_LINE_CHARS) {
  const s = str(raw).replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 一段纯文字里的式子定界符。**剥掉**（和 `formulaList` 同一条）：
 *  公式卡的 tex 不带 `$`。 */
function stripDollars(raw) {
  let s = str(raw).trim()
  if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) s = s.slice(2, -2).trim()
  else if (s.startsWith('$') && s.endsWith('$') && s.length > 2) s = s.slice(1, -1).trim()
  return s
}

/** 一串字符串 → 干净的行（去空、去重、夹条数）。 */
function lines(raw, max, maxChars = MAX_LINE_CHARS) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]
  const out = []
  const seen = new Set()
  for (const it of list) {
    if (out.length >= max) break
    /* `{title}` / `{text}` 那种形状也认（模型老爱加一层壳，
       和 doc-cards 的 `normPointLine` 同一条：**为了一个字段名把整批判失败不划算**）。 */
    const s = oneLine(isObj(it) ? (it.text != null ? it.text : it.title) : it, maxChars)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 模型回的那段话 → 一块提纲（**纯函数、不抛错**）。
 *
 * 认两档形状（和 `normalizeDocExtract` 同一个理由：为一个字段名把整批判失败不划算）：
 *   ① `{ "sections": [{ "name", "pages", "about" }], "flow": [...], "must": [...],
 *        "pitfalls": [...], "formulas": [{ "tex", "note" }], "check": [...] }`  ← 提示词要的
 *   ② 整段被 ``` 围栏包着（模型老爱包）—— 先剥壳再 parse。
 *
 * @param {string|object} raw  模型的回话（字符串或已经 parse 好的对象）
 * @returns {{ ok, title, items, blank, dropped }}
 *   `items[]` = **和 `normalizeDocExtract` 出来的一模一样的那种条目**
 *     `{ id, kind:'summary', title, body, tex:'', sectionId:null, page:0 }`。
 *     ★ 少一样字段都不行：它要和逐页那些条目一起下板（`measureDeck`、`projectDeck`、
 *       `placeDeckCards` 都按同一套字段取）。
 *   `blank` = true 表示"回了话，但一段都收不出来"（模型答非所问 / 全是空数组）——
 *     **不是错误**，界面上就写"这次没生成"（和封面页讲不出东西同一条规矩：
 *     空着比硬凑好）。
 *   `dropped` = 因为超上限/太短被丢掉的条数（**要报出来**：那是"丢了东西"，
 *     和"本来就没有"是两句不同的话）。
 */
export function normalizeSummary(raw) {
  const out = { ok: false, title: SUMMARY_TITLE, items: [], blank: false, dropped: 0 }
  let obj = raw
  if (typeof raw === 'string') {
    const s = str(raw).trim()
    /* 剥 ``` 围栏（只剥整段包着的）—— 和 server-ocr.js 的 stripFence 同一套正则，
       但那一份在服务端、这个函数要在 node 里被测，所以这里自己再来一份小的。 */
    const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s)
    const body = (m ? m[1] : s).trim()
    if (!body) {
      out.blank = true
      return out
    }
    try {
      obj = JSON.parse(body)
    } catch {
      /* 回了一段人话而不是 JSON —— 那是**模型没按格式回**，不是"这节课没有提纲"。
         两种都给 blank（界面上都是"这次没生成"），因为用户在这一步能做的事是一样的：
         再点一次。区别在自检里（`ok:false` 那条路）。 */
      out.blank = true
      return out
    }
  }
  if (!isObj(obj)) {
    out.blank = true
    return out
  }
  /* 模型有时把整块塞在 `summary` / `outline` 里 —— 认一下，不认也不亏。 */
  const root = isObj(obj.summary) ? obj.summary : isObj(obj.outline) ? obj.outline : obj

  const parts = []
  let dropped = 0

  /* ── 骨架：`[{name, pages, about}]` ──
     这是提纲里**唯一**要写"哪几页"的一段：学生回头翻课件靠的就是它。
     ★ 页号只从**逐页那一趟真读过的页**里取（提示词里给了），模型若写了个范围之外
       的数，夹回这一趟的区间 —— 不然提纲会指着一页它没讲过的地方说"就是这一节"。 */
  const sections = []
  const secList = Array.isArray(root.sections) ? root.sections : []
  for (const g of secList) {
    if (sections.length >= MAX_SECTIONS) {
      dropped += 1
      continue
    }
    if (!isObj(g)) continue
    const name = oneLine(g.name != null ? g.name : g.unit, MAX_SECTION_NAME_CHARS)
    const pages = String(g.pages == null ? '' : g.pages).replace(/\s+/g, '')
    const about = oneLine(g.about != null ? g.about : g.say, MAX_LINE_CHARS)
    /* 名字和"在讲什么"**至少得有一个** —— 一页号不算一条骨架。 */
    if (!name && !about) {
      dropped += 1
      continue
    }
    sections.push({ name, pages, about })
  }
  if (sections.length) {
    parts.push({
      key: 'sections',
      short: '骨架',
      lines: sections.map((s) => (s.pages ? `${s.name || '（这一节）'} · 第 ${s.pages} 页${s.about ? ' —— ' + s.about : ''}` : `${s.name || '（这一节）'}${s.about ? ' —— ' + s.about : ''}`)),
    })
  }

  /* ── 脉络 / 必记 / 易错 / 自测：一串行 ── */
  const push = (key, raw, max, maxChars = MAX_LINE_CHARS) => {
    const before = Array.isArray(raw) ? raw.length : 0
    const got = lines(raw, max, maxChars)
    if (!got.length) return
    parts.push({ key, short: SUMMARY_PARTS.find((p) => p.key === key).short, lines: got })
    if (before > got.length) dropped += before - got.length
  }
  push('flow', root.flow != null ? root.flow : root.thread, MAX_FLOW)
  push('must', root.must != null ? root.must : root.keypoints != null ? root.keypoints : root.points, MAX_MUST)
  push('pitfalls', root.pitfalls != null ? root.pitfalls : root.watch, MAX_PITFALLS)
  push('check', root.check != null ? root.check : root.questions, MAX_CHECK, MAX_CHECK_CHARS)

  /* ── 核心式子：`[{tex, note}]` 或者一串 tex 字符串 ──
     ★ 它们**不走 `formulas` 那一段**（那一段是"一条式子一张公式卡"），
       而是**写在提纲卡的正文里**（`$…$`）。为什么：
       · 提纲是**一张卡**，学生扫一眼就够 —— 式子散成五张公式卡贴在旁边，
         一眼望去分不清哪几张是"整节课的"，哪几张是"第 7 页那个推导的"；
       · 而且这样落卡仍然只落一张，`placeDeckCard` 那句"每张卡只占第一页左栏一次"才成立。 */
  const forms = []
  const fList = Array.isArray(root.formulas) ? root.formulas : []
  for (const f of fList) {
    if (forms.length >= MAX_FORMULAS) {
      dropped += 1
      continue
    }
    const tex = stripDollars(isObj(f) ? (f.tex != null ? f.tex : f.latex) : f)
    if (!tex) continue
    /* `:` 后面是说明那一行（有就写，没有就只留式子） */
    const note = isObj(f) ? oneLine(f.note != null ? f.note : f.means, MAX_LINE_CHARS) : ''
    forms.push({ tex, note })
  }
  if (forms.length) {
    parts.push({
      key: 'formulas',
      short: '核心式子',
      /* 一行一条：`$$式子$$ —— 说明`。★ 式子**必须**用 `$$…$$` 整行包起来 ——
         卡片正文是按 richHtml 排的，行内 `$…$` 会把长式子挤在一个字的高度里。 */
      lines: forms.map((f) => `$$${f.tex}$$${f.note ? ' —— ' + f.note : ''}`),
    })
  }

  if (!parts.length) {
    out.blank = true
    return out
  }

  /* ── 拼成卡上的正文 ──
     ★ 分段写 `**小标题**` + 每行一个 `- `：卡片正文走 richHtml（和讲义卡同一套），
       粗体和小列表都排得出来。这与 `pointLines` 的 `- ` 是同一个路子。 */
  const body = parts.map((p) => `**${p.short}**\n` + p.lines.map((l) => '- ' + l).join('\n')).join('\n\n')
  out.title = SUMMARY_TITLE
  out.items = [
    {
      id: 'dsm1',
      kind: SUMMARY_KIND,
      title: SUMMARY_TITLE,
      body,
      tex: '',
      /* ★ `sectionId: null` + `page: 0` 是**有意的**：它不属于任何一节、也不属于任何一页。
         groupBySection 按 `unitId` 分组时它不会被并进任何一节（它本来就在 `items` 表末尾，
         见 DeckReview 的 `list`），落卡时 `projectDeck` 也认得出"这不是页上的东西"。 */
      sectionId: null,
      page: 0,
    },
  ]
  out.ok = true
  out.dropped = dropped
  return out
}

/**
 * 模型回的那段话 → 一张「做题须知」（**纯函数、不抛错**）。
 *
 * 认的形状（比提纲宽，和 `normalizeSummary` 同一条理由：为一个字段名把整批判失败不划算）：
 *   `{ "units": [...], "conv": [...], "traps": [...] }`
 *   几个常见的别名也认（`symbols`→units、`rules`→conv、`mistakes`/`watch`→traps）。
 *
 * ★ 和 `normalizeSummary` 的**关键差别**：须知里**没有页号**、也**没有式子**。
 *   · 它不写"第几页"：口径是整节课的东西，指到某一页反而是错的
 *     （"第 3 页那个公式里的 g 取 10" —— 那 g 整节课都取 10）；
 *   · 它不出 `formulas` 那一段：整节课的式子已经在提纲的「核心式子」里了，
 *     再来一份就是同样的东西摆两块地方（而且两块还可能改得不一样）。
 *
 * @param {string|object} raw  模型的回话
 * @returns {{ ok, title, items, blank, dropped }}  形状和 `normalizeSummary` 一致
 *   （`items[]` 同样是**和逐页条目同构**的那种条目，只是 `kind: RULES_KIND`）。
 */
export function normalizeRules(raw) {
  const out = { ok: false, title: RULES_TITLE, items: [], blank: false, dropped: 0 }
  let obj = raw
  if (typeof raw === 'string') {
    const s = str(raw).trim()
    const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s)
    const body = (m ? m[1] : s).trim()
    if (!body) {
      out.blank = true
      return out
    }
    try {
      obj = JSON.parse(body)
    } catch {
      out.blank = true
      return out
    }
  }
  if (!isObj(obj)) {
    out.blank = true
    return out
  }
  /* 模型偶尔把整块塞在 `rules` / `notes` / `tips` 里 —— 认一下，不认也不亏。
     ⚠ 先试 `rules` 那个键**再**看它是不是一段内容：`{rules:[...]}` 是老实的形状，
     而 `{rules:{units:[...]}}` 才是包了一层壳 —— 两种都认，判据是"它里面有没有分段"。 */
  const cand = isObj(obj.rules) ? obj.rules : isObj(obj.notes) ? obj.notes : isObj(obj.tips) ? obj.tips : null
  const root = cand && (cand.units || cand.conv || cand.traps || cand.symbols || cand.mistakes) ? cand : obj

  const parts = []
  let dropped = 0
  /* 和提纲那个 `push` 同一套：收行 → 夹条数 → 超了的报数（不静默）。
     ⚠ 这里的 `dropped` 和提纲那个**是两笔账**（两张卡各报各的），
     界面上也分两块显示 —— 合成一笔的话，用户看不出是哪一张短了。 */
  const push = (key, rawList, max) => {
    const before = Array.isArray(rawList) ? rawList.length : 0
    const got = lines(rawList, max)
    if (!got.length) return
    parts.push({ key, short: RULES_PARTS.find((p) => p.key === key).short, lines: got })
    if (before > got.length) dropped += before - got.length
  }
  push('units', root.units != null ? root.units : root.symbols, MAX_UNITS)
  push('conv', root.conv != null ? root.conv : root.rules != null ? root.rules : root.conventions, MAX_CONV)
  push('traps', root.traps != null ? root.traps : root.mistakes != null ? root.mistakes : root.watch, MAX_TRAPS)

  if (!parts.length) {
    out.blank = true
    return out
  }
  const body = parts.map((p) => `**${p.short}**\n` + p.lines.map((l) => '- ' + l).join('\n')).join('\n\n')
  out.title = RULES_TITLE
  out.items = [
    {
      id: 'dsr1',
      kind: RULES_KIND,
      title: RULES_TITLE,
      body,
      tex: '',
      sectionId: null,
      page: 0,
    },
  ]
  out.ok = true
  out.dropped = dropped
  return out
}

/* ══════════════════ 三、摆哪儿 ══════════════════
 *
 * ── 为什么是"第一页左边"，而不是"整份课件后面" ─────────────────────────
 * 第一版想的是后面（那是"总结"该在的地方）。改掉的三个理由，一条比一条硬：
 *  ① `projectDeck` 推下一页靠的是 `pageGaps`（一页一个数、逐页往后推）——
 *     在最后一页**之后**加东西，那个循环里没有哪一页能碰它：它要么压住最后一页的卡片，
 *     要么得为它单造一个新的 `pageGaps` 槽位，而那个槽位在语义上是空的（没有下一页要推）；
 *  ② 导出 PDF（export-html.js）和「留到板上」的 `columnOccupancy` 都要跟着认这个新位置；
 *  ③ **资料末尾那块地是谁的不一定**（你可能在那儿写过东西、贴过答案卡）：
 *     往里加空之前得先查一遍，加错了是**静默**的（只是看起来远了点）。
 * 而"第一页左边"有三个现成的好处：每一份课件的**干净地**（左栏从页顶起，只有整理过
 * 才会有东西，而那是 `occupied` 能算出来的）；`columnOccupancy` 本来就把"这一页左栏
 * 到哪儿了"算好了；`placeDeckCards` 里那张 `occupied` 表顺手就是它的起点。
 *
 * ★★ 铁律 ② 的落点：这个函数**没有 pageGaps 这回事** —— 返回的就是一个矩形。
 *    多出来的那一栏会凸出去、可能压到上一份课件，那是可以接受、也一眼看得见的代价
 *    （"有一样东西被人拖了过来"），换来的是**不需要动"一页一课"的那整套账**。
 *    自检里有一条**源码扫描**钉住这里不许出现 `pageGaps`。
 */

/** 整节课那种卡（提纲 / 须知）摆哪儿（世界坐标）。**纯函数**，只有这一处算。
 *
 * @param {object} arg
 *   · rects  每一页的世界矩形（`docs.js` 的 `pageRects(doc)`）—— 只看第一页
 *   · used   **第一页左栏已经占到哪儿了**（世界 y；`null` = 那一栏还空着）。
 *            ⚠ 这个数**由调用方算**（Board.jsx 那边问 `doc-cards.js` 的 `columnOccupancy`）——
 *              这一份**不许引 doc-cards.js**（单方向：doc-cards 引这里，这里不引它，
 *              不然就成环）。而且那份表本来就要算（`placeDeckCards` 逐页摆版也要它），
 *              传进来是"同一份数据两处用"，不是多跑一趟。
 *            ★ **第二张**（须知）就是这么来的：调用方把 `used` 抬到提纲的底边，
 *              两张卡自动一上一下排开 —— 这里不需要知道"我是第几张"。
 *   · w / h  **量出来的**卡片尺寸（世界像素，见 measureDeck）
 *   · gap    页面边缘和这一栏之间留多少（`ORIGIN_GAP`，和左右两栏同一个数）
 * @returns {{ x, y, w, h } | null}  null = 这份课件在板上找不到第一页（页号对不上）
 *
 * ★ 名字从 `placeSummaryCard` 改成 `placeDeckCard`：它现在管的不只是提纲。
 *   留一个只有提纲才用的名字，会让第二张（须知）的调用点读起来像在**误用**
 *   （"为什么摆须知要调 placeSummaryCard？"）。位置这件事本来就只有一种算法。
 */
export function placeDeckCard({ rects = [], used = null, w = 0, h = 0, gap = 44 } = {}) {
  const first = (rects || [])[0]
  if (!first) return null
  const width = Math.max(1, Math.round(Number(w) || 0))
  const height = Math.max(1, Math.round(Number(h) || 0))
  /* 第一页左栏已经有东西（先留过一张答案卡、或者上面已经摆了提纲）→ 接在它下面，
     不许压上去。那个数从 `used` 来（见上），这里只做一次加法。 */
  const between = 18 /* `CARD_GAP_Y` 的同一个数（doc-cards.js）——
                        那一份是给"页上两栏"用的，这里是"整节课的东西"，
                        但缝看着要一样宽，所以照抄那个值，**不引它**（引了就成环）。 */
  const y = used != null ? Math.round(Number(used)) + between : Math.round(Number(first.y) || 0)
  /* 右边缘**贴着资料左边**（往左长，不啃页面）—— 和左栏那几张卡同一条。 */
  const x = Math.round((Number(first.x) || 0) - gap - width)
  return { x, y, w: width, h: height }
}

/* ⚠ 老名字留一个别名 —— 自检（check-doc-read 第 [10] 节）和外面那一处调用
 *   都还在用 `placeSummaryCard`。改名时**两边一起改**是正路，但留个箭头
 *   比"改漏一处 → 那个 import 静默变成 undefined → 运行时才炸"要好：
 *   多这一个 export 的代价是零。 */
export const placeSummaryCard = placeDeckCard

/* ══════════════════ 四、给提示词用的那份"前面讲了什么" ══════════════════ */

/**
 * 把逐页那些条目压成一份**紧凑的摘要**，交给总结那一趟。
 *
 * ── 为什么发摘要、不发原始回话 ───────────────────────────────────────────
 * 一节课 40 页，每页的 `explain` 是 250~400 字 + 重点 + 公式 —— 全发出去是几万字，
 * 光是这一趟就得付一份"重新读一遍课件"的钱，而它要的东西（骨架、必记、易错）
 * 恰恰**不需要**那些展开的讲解细节。
 * ★ 而且这份摘要是**唯一的输入** —— 提示词里那句"不许引入这份摘要之外的东西"
 *   能立住，靠的就是它：模型手里没有别的料，编不出来。
 *
 * @param {Array} items     逐页那些条目（`{kind,title,body,page,…}`）
 * @param {object} opts
 *   · units        `groupBySection` 出来的小节（`{name, pages}`）—— 骨架的候选
 *   · readPages    这一趟真读到的页号（写进提示词的抬头："这份课件你讲了这几页"）
 *   · maxChar      **硬上限**（服务端那边也有一个，两处一起夹）——
 *                  超了就按"重点优先"截断，且**明说截断了**，不假装讲完了
 * @returns {{ text, truncated }}
 */
export function summaryInput(items = [], { units = [], readPages = [], maxChar = 24000 } = {}) {
  const pages = (readPages || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b)
  const head = pages.length
    ? `这份课件你讲了第 ${pages[0]}~${pages[pages.length - 1]} 页（一共 ${pages.length} 页，下面是你当时讲的内容）。`
    : '下面是你当时讲的内容。'

  const segs = []
  /* ① 骨架的候选：小节名 + 它覆盖的页 —— 这一行是**模型定骨架时最靠得住的依据**，
     比让它自己从讲解正文里猜"哪几页是一节"准得多（那是 `groupBySection` 算出来的）。 */
  const named = (units || []).filter((u) => u && u.name)
  if (named.length) {
    segs.push(
      '「你当时划的小节」：\n' +
        named.map((u) => `- ${u.name}：第 ${(u.pages || []).join('、')} 页`).join('\n')
    )
  }
  /* ② 每页的重点（不是讲解全文）：提纲要的"必记/易错"就是从这些短句里长出来的。 */
  const byPage = new Map()
  for (const it of items || []) {
    if (!it || !it.page) continue
    const n = Number(it.page)
    if (!byPage.has(n)) byPage.set(n, [])
    byPage.get(n).push(it)
  }
  const rows = []
  for (const n of [...byPage.keys()].sort((a, b) => a - b)) {
    const mine = byPage.get(n)
    const title = (mine.find((x) => x.kind === 'explain') || {}).title || ''
    const points = mine.filter((x) => x.kind === 'points').map((x) => String(x.body || '').trim()).join(' ')
    const tex = mine.filter((x) => x.kind === 'formula').map((x) => `$${x.tex}$`).join(' ')
    const line = [`第 ${n} 页`, title ? `（${title}）` : '', points ? '：' + points : '', tex ? ' 式子：' + tex : ''].join('')
    rows.push(line.trim())
  }
  if (rows.length) segs.push('「每一页的重点」：\n' + rows.join('\n'))

  let text = head + '\n\n' + segs.join('\n\n')
  let truncated = false
  const cap = Number(maxChar) > 0 ? Number(maxChar) : 0
  if (cap && text.length > cap) {
    /* ★ **从后面砍，并且明说砍了**：尾部的页先丢。
       ⚠ 反过来"悄悄发半份"是最坏的一种（模型会以为课件就这么长，
         然后一本正经地给一份缺了后半截的提纲）。 */
    text = text.slice(0, cap)
    truncated = true
    text += '\n\n（注意：上面这份内容太长了，**只给到了前一部分** —— 提纲就按已有的这部分写，不要猜后面还有什么。）'
  }
  return { text, truncated }
}
