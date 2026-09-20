/* 课件整理：把模型读回来的一段 JSON 收成**知识点**，再摆成板上的**卡片**。
 *
 * ── 这条路在整条链路上的位置 ────────────────────────────────────────────
 *   板上的一份资料（PDF/PPT，docs.js）
 *     → 你挑一段页（`DeckReview` 那个窗口里选的）
 *     → 每一页渲染成位图（doc-read.js，pdf.js 那一套和 DocLayer 同源）
 *     → 分批发给视觉模型（server-ocr.js 的 mode:'doc'）
 *     → 回来一段 JSON —— **这个文件把它收成知识点**（normalizeDocExtract）
 *     → 你在窗口里校对/删减（DeckReview.jsx）
 *     → 落成板上的卡片（projectDeck，纯函数；写盘由 Board.jsx 做）
 *
 * ── 为什么是"知识点卡"而不是"把 PPT 抄一遍" ─────────────────────────────
 * 用户 2026-09-22 的原话：「整理出来这个 pdf/ppt 这节课的内容……把这个结果贴到白板上，
 * 这样就能让学生不从一个空的白板开始，而是从一个**已经有知识的内容**开始，
 * 写写画画只是加深当中某些点或映像」。
 * 所以卡片是**起点**不是成品：一页提炼 0~4 条（一句标题 + 一两句人话，公式单独成卡），
 * 一节课十来张 —— 留白是留给你写和画的。抄得越全，白板越挤，越回到"对着 PPT 抄"。
 *
 * ── 一条设计纪律：模型只交**内容**，位置和尺寸由本地算 ──────────────────
 * 提示词里**没有** x/y/宽高这一族字段，模型也没机会猜。它回来的是
 * `{ sections, items }`（见 DOC_PROMPT），这个文件做两件事：
 *   · `normalizeDocExtract` —— 校验 + 补齐 + 拒绝，**一个字都不编**；
 *   · `projectDeck`         —— 把知识点摆成世界坐标的卡片（尺寸是量出来的，见下）。
 * 和 board-structure.js 那条纪律同源：**能算的绝不问模型，模型只负责"读出来"**。
 *
 * ★ 尺寸不是估的，是**量**出来的（`.bd-card` 的规矩：贴合内容）。
 *   `measureDeck` 用一个藏在屏幕外的真卡片量 —— 和 fitCardSize 量的是同一种 DOM。
 *   ⚠ 它只在浏览器里能跑；这个文件其余的导出全是纯函数（自检里断言得住）。
 *
 * ── 退化：模型没按格式回话时 ────────────────────────────────────────────
 * 和 board-structure.js 一样：**解析不了就报 parse 失败**，不猜、不硬凑。
 * 界面那一侧把它显示成"这一批没读懂"，让你重读那一批 —— 而不是悄悄少几张卡。
 */
import { CARD_MIN_W, DEFAULT_CARD_FONT, TEXT_CARD_MAX_W, cardHeightFromContent, cardWidthFromContent, fontCss } from './board.js'
import { worldLenToScreen } from './view.js'

/* ── 上限（都在这一处，别在调用方散着写）──
 * 为什么要有：模型偶尔会"把整页抄成 20 条"，而白板一次贴 200 张卡就不是"起点"了，
 * 是一场灾难。超了**不静默**：报数给界面，让人知道自己少拿到了什么。 */
export const MAX_ITEMS_PER_PAGE = 4
export const MAX_ITEMS_TOTAL = 60
export const MAX_TITLE_CHARS = 60
export const MAX_BODY_CHARS = 320
export const MAX_UNIT_CHARS = 40

/* 本节这几条也是给量尺寸那一半用的：知识点卡**不是**公式卡也不是从笔迹认出来的卡，
 * 它是"一页纸上的几句话"，所以宽度夹在 [CARD_MIN_W, TEXT_CARD_MAX_W] ——
 * 太窄读不了、太宽一张卡就横穿整块板（那正是 TEXT_CARD_MAX_W 存在的理由）。 */
export const NOTE_MIN_W = CARD_MIN_W
export const NOTE_MAX_W = TEXT_CARD_MAX_W

/* ══════════════════ 一、把模型的话收成知识点 ══════════════════ */

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

/** 一条知识点：**必须有内容**。标题和正文都空 → 丢掉（模型爱回空壳占位）。 */
function normItem(raw) {
  if (!isObj(raw)) return null
  const kind = raw.kind === 'formula' ? 'formula' : 'note'
  const title = oneLine(cleanText(raw.title, MAX_TITLE_CHARS))
  const body = cleanText(raw.body, MAX_BODY_CHARS)
  const tex = String(raw.tex == null ? '' : raw.tex).trim()
  if (kind === 'formula') {
    /* 公式卡只有 tex 一个字段（board.js 的 src/tex）—— 没 tex 就不是公式卡，
       退回文字卡（宁可当一句话，也不要一张空卡）。 */
    if (!tex) {
      if (!title && !body) return null
      return { kind: 'note', title, body }
    }
    /* 标题/正文都给公式卡用不上（卡里只有那条式子），丢的时候不报数 —— 那是设计。 */
    return { kind: 'formula', title: '', body: '', tex: stripTexDelims(tex) }
  }
  if (!title && !body) return null
  return { kind: 'note', title, body }
}

/** 公式卡里存的是**不带定界符**的 tex（和 formula.js / ocr.js 同一条规矩）。 */
export function stripTexDelims(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) s = s.slice(2, -2).trim()
  else if (s.startsWith('$') && s.endsWith('$') && s.length > 2) s = s.slice(1, -2).trim()
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
 * 模型的一段回话 → 知识点骨架。
 *
 * @param {string|object} raw      模型的回话（字符串或已经 parse 好的对象）
 * @param {object} opts
 *   · pages   这一批**发出去**的页号（1 起）。回来的 page 不在这张表里 → 归到这一批的
 *             第一页（模型报错页号是常事，不能因此把内容丢了）。
 *   · startId id 计数从哪儿起（同一个窗口里多批之间不撞号）
 * @returns {{ ok, sections, items, dropped, notes, nextId }}
 *   `sections[]` = { id, name, pages: [页号…] }
 *   `items[]`    = { id, kind, title, body, tex, sectionId, page }
 *   `dropped`    = 因为"没内容 / 重复 / 超上限"丢掉的条数（**要报给用户看**）
 *   `notes[]`    = 给人看的提示（一页太多、页号对不上…）
 */
export function normalizeDocExtract(raw, { pages = [], startId = 0 } = {}) {
  const out = { ok: false, sections: [], items: [], dropped: 0, notes: [], nextId: startId }
  const obj = typeof raw === 'string' ? parseDocExtract(raw) : raw
  if (!isObj(obj)) return out

  const known = new Set((pages || []).map((n) => Number(n)))
  const fallbackPage = Number(pages && pages[0]) || 0

  /* 回来的形状有三档，都认 —— **为了一个字段名把整批判失败不划算**，
   * 因为那个形状里信息一点不少，丢掉的是钱和时间：
   *   ① `{ page, unit, points: [...] }`               ← 提示词要的就是这个（一页一次调用）
   *   ② `{ sections: [{ name, items: [...] }] }`      ← 它自作主张按节组织
   *   ③ `{ pages: [{ page, unit, points: [...] }] }`  ← 它自作主张把好几页塞在一个回包里
   * ★ 三档的共同点是"**节名 + 一串条目 + 页号**"这三样，`groups` 就是这三样的中间形状
   *   （`name` 空 = 沿用上一节；`pageHint` 空 = 这一档没带页号，落到这一批的页上）。 */
  const groups = []
  if (Array.isArray(obj.sections) && obj.sections.length) {
    for (const sec of obj.sections) {
      if (!isObj(sec)) continue
      const name = oneLine(cleanText(sec.name != null ? sec.name : sec.title, MAX_UNIT_CHARS))
      const list = Array.isArray(sec.items) ? sec.items : Array.isArray(sec.points) ? sec.points : []
      groups.push({ name, items: list })
    }
  } else if (Array.isArray(obj.pages) && obj.pages.length) {
    for (const pg of obj.pages) {
      if (!isObj(pg)) continue
      const name = oneLine(cleanText(pg.unit != null ? pg.unit : pg.name, MAX_UNIT_CHARS))
      const list = Array.isArray(pg.points) ? pg.points : Array.isArray(pg.items) ? pg.items : []
      groups.push({ name, items: list, pageHint: pg.page })
    }
  } else if (Array.isArray(obj.points) || Array.isArray(obj.items)) {
    /* 第一档：这一页就是整个回包（**最常见的一档** —— 提示词要的就是它）。
       没有 `points` 字段（只有 sections）时才轮到上面那两档。 */
    const name = oneLine(cleanText(obj.unit != null ? obj.unit : obj.name, MAX_UNIT_CHARS))
    const list = Array.isArray(obj.points) ? obj.points : obj.items
    groups.push({ name, items: list, pageHint: obj.page })
  } else {
    return out
  }

  let id = startId
  let seen = 0
  let cur = null // 现在这一节（名字为空就沿用上一节 —— 提示词里就是这么说的）
  for (const g of groups) {
    if (g.name) {
      cur = { id: 'ds' + (id += 1), name: g.name, pages: [] }
      out.sections.push(cur)
    }
    const pageHint = known.has(Number(g.pageHint)) ? Number(g.pageHint) : null
    let onThisGroup = 0
    for (const rawItem of g.items) {
      if (seen >= MAX_ITEMS_TOTAL) {
        out.dropped += 1
        continue
      }
      const it = normItem(rawItem)
      if (!it) {
        out.dropped += 1
        continue
      }
      onThisGroup += 1
      if (onThisGroup > MAX_ITEMS_PER_PAGE) {
        /* 一页超过 4 条：**丢掉**并报数（提示词里写了 0~4，超了就是它没守规矩）。
           为什么不静默收下：白板的空间是有限的资源，多出来的卡会把板淹掉。 */
        out.dropped += 1
        continue
      }
      if (!cur) {
        /* 一条知识点都不在任何一节里（模型没写 name）—— 给它一节"这一批"，
           不然它在板上没有归属，摆出来是一堆浮着的卡。 */
        cur = { id: 'ds' + (id += 1), name: '', pages: [] }
        out.sections.push(cur)
      }
      const p = known.has(Number(rawItem && rawItem.page)) ? Number(rawItem.page) : pageHint || fallbackPage
      if (p && !cur.pages.includes(p)) cur.pages.push(p)
      out.items.push({
        id: 'di' + (id += 1),
        kind: it.kind,
        title: it.title,
        body: it.body,
        tex: it.tex || '',
        sectionId: cur.id,
        page: p,
      })
      seen += 1
    }
  }

  /* 空节（有名字、一条知识点都没有）：留着没用 —— 板上一张只有标题的卡不是知识点。
     但**报数**：那说明模型那一节什么都没读出来（可能是转场页），用户该知道。 */
  const used = new Set(out.items.map((x) => x.sectionId))
  const before = out.sections.length
  out.sections = out.sections.filter((s) => used.has(s.id))
  if (before > out.sections.length) out.notes.push(`有 ${before - out.sections.length} 个小节一条知识点都没读到（多半是转场页）`)

  out.nextId = id
  out.ok = out.items.length > 0 || (out.sections.length === 0 && out.dropped === 0)
  return out
}

/* ══════════════════ 二、知识点 → 板上的卡片 ══════════════════ */

/* 摆版的常量 —— 都在这一处。
 * 一栏多宽、一张卡之间留多少，直接决定"贴上去像不像一份讲义"。 */
export const CARD_GAP_X = 26 // 栏与栏之间
export const CARD_GAP_Y = 18 // 卡与卡之间
export const HEADING_GAP = 10 // 小节卡和它第一张卡之间
export const GROUP_GAP = 34 // 上一节最后一张卡和下一节小节卡之间
export const ORIGIN_GAP = 60 // 资料右边缘和第一栏之间
/* 小节卡的高度（一行标题 + 内边距）。它是纯标题，量也只值一行。 */
export const HEADING_H = 34

/** 一节的卡片标题（你圈的课件小节名）。空名就没有这张卡 —— 不硬凑"未命名"。 */
export function sectionHeading(section) {
  return section && section.name ? section.name : ''
}

/**
 * 把知识点摆成世界坐标的卡片（**纯函数**：给同样的输入，永远摆出同样的版）。
 *
 * @param {object} arg
 *   · sections / items —— normalizeDocExtract 的产物（items 已经是你筛过的那些）
 *   · sizes  Map<itemId, {w,h}> 或 { [itemId]: {w,h} } —— measureDeck 量的尺寸。
 *            **缺尺寸的条目会被跳过**（宁可少一张卡，也不要一张按估的尺寸摆下去的卡 ——
 *            估错高度 = 卡片互相压住，而"压住"在板上是看不出来的，得拖开才知道）。
 *   · origin {x,y} —— 从哪儿开始摆。调用方给"资料右边"或"视野中心"。
 *   · columnH 一栏最高多少（世界像素）。超了就开下一栏。
 * @returns {{ cards, placed, skipped, bounds }}
 *   `cards` 每一项 = { itemId, kind, sectionId, x, y, w, h, text?, src?, tex? }
 *   —— 已经是**卡片的内容**（不是知识点），Board.jsx 直接把它喂给 newCard。
 */
export function projectDeck({ sections = [], items = [], sizes = null, origin = { x: 0, y: 0 }, columnH = 1500 } = {}) {
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

  /* ★ 一条知识点挂在哪一节：认 `sectionId` **和** `unitId` 两个字段名。
     前者是 normalizeDocExtract 的叫法、后者是 groupBySection 的叫法（界面上用的是它）。
     ⚠ 2026-09-22 自检抓到的第三处真 bug：两个名字各叫各的，于是**每一条都落进 loose**、
     小节名一个字都不上板 —— 而屏幕上看起来只是"少了一张卡"，不报任何错。
     这里认两个名字，比"让调用方记得改名"稳（这条数据要在 UI 和落卡之间走一趟）。 */
  const unitOf = (it) => (it.sectionId != null ? it.sectionId : it.unitId)

  /* 每一节有哪几条（按 sections 的顺序 = 模型给的顺序 = 讲课顺序）。 */
  const bySection = new Map(sections.map((s) => [s.id, []]))
  const loose = []
  for (const it of items) {
    if (!it) continue
    const bucket = bySection.get(unitOf(it))
    if (bucket) bucket.push(it)
    else loose.push(it)
  }

  /* 没有小节归属的（手改过 items？）挂在最后一节后面，别丢。 */
  const groups = sections.map((s) => ({ section: s, items: bySection.get(s.id) || [] }))
  if (loose.length) groups.push({ section: { id: null, name: '' }, items: loose })

  /* ══ 摆版是**两趟**（2026-09-22 自检在真浏览器里抓到的两处 bug 促成的）══
   * 一趟的写法（边摆边判"放得下吗"）在两个地方都是错的，而且都不报错：
   *   ① 决定"这张卡放哪一栏"必须在写坐标**之前** —— 否则换栏之后那张卡
   *      留在上一栏的底部，屏幕上多出一张**孤零零的卡**（小节名漂在栏底最好认）；
   *   ② 换栏之后**不能**把这张卡按上一栏的 y 写进去 —— 新栏的 y 是栏顶。
   * 所以：**先把"每一栏装哪些卡"算出来，再按算好的分组写坐标。**
   * 这样"同一栏里谁的 y 在谁下面"在结构上就成立了（不必再靠一条条判断去维持），
   * 小节卡和它的知识点也允许被分栏切开（一节 20 条时这是必然会发生的）。 */
  const colMax = Math.max(200, Number(columnH) || 1500)
  let skipped = 0
  const columns = []
  {
    let col = { items: [], h: 0 }
    columns.push(col)
    for (const g of groups) {
      const list = g.items.filter((it) => sizeOf(it.id))
      skipped += g.items.length - list.length
      if (!list.length) continue
      const name = sectionHeading(g.section)
      const headW = sizeOf(list[0].id).w
      /* 一节的开头：先量"开这一节要多少地方"（小节卡 + 那条缝），再看要不要换栏。 */
      const openH = name ? HEADING_H + HEADING_GAP : 0
      if (col.items.length && col.h + GROUP_GAP + openH + sizeOf(list[0].id).h > colMax) {
        col = { items: [], h: 0 }
        columns.push(col)
      }
      if (name) {
        col.items.push({ kind: 'head', text: name, sectionId: g.section.id, w: headW, h: HEADING_H })
        col.h += HEADING_H + HEADING_GAP
      }
      for (let i = 0; i < list.length; i += 1) {
        const size = sizeOf(list[i].id)
        const sep = i === 0 ? 0 : CARD_GAP_Y
        if (col.items.length && col.h + sep + size.h > colMax) {
          /* 这一条放不进这一栏 → 另起一栏。**小节卡跟着过去**：
             一节被切开之后，新栏顶上那个名字就是"接着上一栏的那一节"。 */
          col = { items: [], h: 0 }
          columns.push(col)
          if (name) {
            col.items.push({ kind: 'head', text: name, sectionId: g.section.id, w: headW, h: HEADING_H })
            col.h += HEADING_H + HEADING_GAP
          }
          col.items.push({ kind: 'item', item: list[i], size })
          col.h += size.h
          continue
        }
        col.items.push({ kind: 'item', item: list[i], size })
        col.h += sep + size.h
      }
      /* 下一节和这一节之间留一条大缝。 */
      col.h += GROUP_GAP - CARD_GAP_Y
    }
  }

  /* 写坐标：每一栏从 (x, y0) 往下排，栏宽 = 这一栏最宽的那张卡。 */
  const x0 = Math.round(Number(origin.x) || 0)
  const y0 = Math.round(Number(origin.y) || 0)
  const cards = []
  let x = x0
  for (const col of columns) {
    if (!col.items.length) continue
    const w = Math.round(col.items.reduce((m, it) => Math.max(m, it.kind === 'head' ? it.w : it.size.w), 0))
    let y = y0
    for (const c of col.items) {
      if (c.kind === 'head') {
        cards.push({ itemId: null, sectionId: c.sectionId, x: Math.round(x), y: Math.round(y), w, h: c.h, text: c.text, heading: true })
        y += c.h + HEADING_GAP
        continue
      }
      const it = c.item
      const extra = it.kind === 'formula' ? { src: it.tex, tex: it.tex } : { text: cardText(it) }
      cards.push({ itemId: it.id, sectionId: unitOf(it) || null, x: Math.round(x), y: Math.round(y), w: c.size.w, h: c.size.h, ...extra })
      y += c.size.h + CARD_GAP_Y
    }
    x += w + CARD_GAP_X
  }

  const bounds = cards.length
    ? {
        x: Math.min(...cards.map((c) => c.x)),
        y: Math.min(...cards.map((c) => c.y)),
        w: Math.max(...cards.map((c) => c.x + c.w)) - Math.min(...cards.map((c) => c.x)),
        h: Math.max(...cards.map((c) => c.y + c.h)) - Math.min(...cards.map((c) => c.y)),
      }
    : null
  return { cards, placed: cards.length, skipped, bounds }
}

/** 一条知识点在一张文字卡里长什么样。
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
 *  `maxW` 是这张卡的世界宽度上限（文字卡和公式卡各有一个，见 measureDeck）。 */
function measureCard(host, { kind, content, s, maxW }) {
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
  const w = Math.min(Number(maxW) || NOTE_MAX_W, Math.max(NOTE_MIN_W, cardWidthFromContent(bodyEl.offsetWidth, { s, scale: 1, padPx: padX })))
  el.style.width = worldLenToScreen(w, s) + 'px'
  const h = cardHeightFromContent(bodyEl.offsetHeight, { s, scale: 1, padPx: padY })
  host.removeChild(el)
  return { w, h }
}

const clampNoteW = (w) => Math.min(NOTE_MAX_W, Math.max(NOTE_MIN_W, Number(w) || NOTE_MIN_W))

/**
 * 量出每一条知识点该占多大的卡（世界像素）。
 *
 * @param {object} arg
 *   · items   —— normalizeDocExtract 出来的知识点
 *   · renderTex(tex) → DOM 节点 | null  公式卡的渲染（App 层有 KaTeX，这里不引它）
 *   · host / s —— 量尺寸的台子；s 是**视图缩放**（和 card-fit.js 那个 s 一个意思）
 * @returns {{ sizes: Map, note, formula, missing }}
 *   `missing` = 量不出来的（公式渲染失败 / 空内容）—— 那些**不会**被摆到板上，
 *   调用方要把它报出来（宁可少一张卡，也不要一张内容被裁掉的卡）。
 */
export function measureDeck({ items = [], renderTex = null, host, s = 1, maxNoteW = NOTE_MAX_W } = {}) {
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
    node.textContent = text
    sizes.set(it.id, measureCard(host, { kind: 'note', content: node, s: scale, maxW: maxNoteW }))
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

