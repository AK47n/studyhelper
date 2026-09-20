import { parseBoardDocument } from './board.js'
import { frameBounds, strokeBounds } from './geometry.js'
import { linkKind } from './link-kinds.js'
import { createLinkReader } from './links.js'
import { parseDoc } from './parse.js'

/* ═══════════ 从白板"收拢"出一份笔记草稿 ═══════════
 *
 * 定位（2026-09-19 和用户对齐的方向 B）：白板为主、笔记为辅。
 * 白板是"算"的地方，笔记是"算完之后留下来的一句话结论"。
 * 所以草稿**不是**把板翻译一遍，而是把板上已经提纯的东西拣出来：
 *   · 卡片（文字卡 / 公式卡）—— 手写经「∑ 公式 / ✨ 美化」认出来的那部分；
 *   · 板框（frames）—— 你亲手圈出来的"这一块是一个整体"，天然就是笔记的小节；
 *   · 连接（links）—— 你亲口宣告的关系（A → B 因果），天然就是"关系"一节。
 * 没收进来的：裸手写（strokes）。它们是过程不是结论，而且机器批量 OCR 又慢又错 ——
 * 想收的，框选 → 美化成卡片，再收拢一次。草稿头部会把这笔账写出来。
 *
 * ★ 草稿是**草稿**：格式宽松、内容可能有冗余，人接手改。它存在的意义是
 *   "不用从零打字"，不是"自动写好笔记"。
 */

/* ═══════════ 转录稿 → 合法的笔记行（2026-09-19，ADR-0004 第 1 步）═══════════
 *
 * ★ 为什么非有这一步：笔记格式的硬规矩是**每行一个节点、行首 `- `**（parse.js 的
 *   `LEADING`）。读不到的行**在阅读页签和导出里是不存在的** —— 不是"排得不好看"，
 *   是"没有"。2026-09-19 拿真草稿量过：`data/大物/电磁感应/8.2 · 笔记.md` 67 行里
 *   **34 行 `parseDoc` 读不到**，而那 34 行正是转录的正文（整段手写认回来的东西）。
 *   根因就是这里：模型回的是**自由 Markdown**，我们把它**原样倒进了笔记文件**。
 *
 * 三条规矩，都是"宁可丑，不可丢"：
 *   ① `#` 开头的行**原样留着** —— 那是模型自己分的小节，笔记语法也认它（`HEADING`）；
 *   ② 行内的 ` | `（空格-竖线-空格）转成**全角 `｜`**：笔记拿第一个 ` | ` 切
 *      "标题 | 正文"，留着它这一行会被**悄悄拆成两半**（和"字段名写错会静默变成
 *      子节点"同一族的坑：屏幕上看着像格式没生效，其实是内容被重新解释过了）；
 *   ③ 模型自带的项目符号（`- `/`* `/`1. `）剥掉 —— 我们统一只用一个 `- `，
 *      不然 `- - 什么` 这种套娃会一路带进笔记里。
 *
 * 另外两件小事：独占一行的 `$$…$$` 归一成 `$…$`（笔记里 `$…$` 才是行内公式；
 * `$$…$$` 会被切成"一个空公式 + 一个公式"，屏上多一截空白），
 * 纯分隔线（`---`）丢掉（它不承载任何内容）。 */
const LIST_MARK = /^(?:[-*+]|\d+[.、)])\s+/
const HR_LINE = /^([-*_])\1{2,}$/

export function noteLines(text) {
  const out = []
  for (const raw of String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n')) {
    let s = raw.trim()
    if (!s) continue
    if (/^#{1,6}\s+\S/.test(s)) {
      out.push(s)
      continue
    }
    if (HR_LINE.test(s)) continue
    s = s.replace(LIST_MARK, '')
    if (!s) continue
    s = s.replace(/^\$\$([\s\S]+)\$\$$/, '$$$1$')
    /* 转成全角，但**两边的空格留着** —— 屏幕上还是"竖线两边各空一格"，
       只是笔记不再拿它当"标题 | 正文"的分隔符。 */
    s = s.replace(/\s\|\s/g, ' ｜ ')
    out.push('- ' + s)
  }
  return out
}

/* 草稿自审：拿**应用自己的解析器**读一遍，数出"读不到的行"。
 *
 * 为什么值得做成一个纯函数、而且拿 `parseDoc` 当判据：这一条判据的全部意义是
 * **"屏幕上的东西 == 文件里的东西"**，那就不能自己再写一份"什么算一行"的规矩
 * （两份规矩 = 迟早对不上，而这个仓库已经为"同一句话有两份实现"栽过两次）。
 * `doc.nodes[].line` 就是解析器认下来的行号，不在里面、又不是我们**有意**写的
 * 引用段（`>` 开头）的，就是"看不见的行"。
 *
 * ★ 它必须永远是 0。不为 0 = 格式契约破了，而那些行在界面上**一点异常都没有**，
 *   所以它得有个数、有个地方报出来（`writeDraft` 会 flash 它）。 */
export function unreadableLines(md) {
  const text = String(md == null ? '' : md)
  const seen = new Set(parseDoc(text).nodes.map((n) => n.line))
  const out = []
  text.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('>') || seen.has(i)) return
    out.push({ line: i + 1, text: t })
  })
  return out
}

/* 公式卡的一行。src 是你随手写的那串（认出来时候的原样），tex 是渲染用的；
   优先 src —— 它更接近你写的时候的样子。卡里不带 $，笔记格式要自己包上。 */
function formulaLine(c) {
  const body = (c.src || c.tex || '').trim()
  if (!body) return null
  return `- 公式 | $${body}$`
}

/* 文字卡 → 一条节点。多行的卡：第一行是这一条，后面的行缩进挂着（还是你写的顺序）。 */
function textLines(c) {
  const lines = String(c.text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!lines.length) return []
  return lines.map((s, i) => (i === 0 ? `- ${s}` : `  - ${s}`))
}

/* 卡片排序：先上后下、再左后右 —— 手写板从上往下铺，读草稿的顺序该跟视觉一致。 */
function byPosition(a, b) {
  const dy = a.y - b.y
  return Math.abs(dy) > 40 ? dy : a.x - b.x
}

export function draftNoteFromBoard(board, { when = '', transcription = '', blocks = null, structured = null } = {}) {
  if (!board || typeof board !== 'object') return null
  const cards = Array.isArray(board.cards) ? board.cards : []
  const frames = Array.isArray(board.frames) ? board.frames : []
  const strokes = Array.isArray(board.strokes) ? board.strokes : []

  /* 手写那一段今天有**两种交法**（ADR-0004 第 2 步）：
     · 新的：`blocks` —— 每块带着它的**板框 id 和名字**（"一块 = 一节"就靠这个成立）；
     · 老的：`transcription` 一整段字符串（自检和别的调用方还在用）。
     两种都收敛成同一个形状，下面只有一套逻辑。 */
  const hand = []
  const pushHand = (h) => {
    const text = String((h && h.text) || '').trim()
    const error = String((h && h.error) || '').trim()
    if (!text && !error) return
    hand.push({ name: String((h && h.name) || '').trim(), frameId: (h && h.frameId) || null, text, error })
  }
  if (Array.isArray(blocks) && blocks.length) for (const b of blocks) pushHand(b)
  else if (String(transcription || '').trim()) pushHand({ text: transcription })

  /* ── 第 4 步的产物：**结构整理读过一遍的手写** ──────────────────────────────
   * 有它的时候，手写不再按"块"平铺，而是按模型读出来的小节摆（`structured.sections`）；
   * 板框那一节里就**不再重复**贴一遍同样的字（否则同一段话会出现两次）。
   * ★ 每一个字仍然来自识别那一趟（模型只许引用行号，见 board-structure.js）——
   *   所以这里换掉的只是**排版**，不是内容。
   * ⚠ 退路：`structured` 没有 / 空 → 一字不差地走原来那条路（按块平铺）。
   * ⚠ 它在**上面**（板框那个循环之前）算好：那个循环要知道"手写该不该在这儿贴"。 */
  const structSections = structured && Array.isArray(structured.sections) ? structured.sections.filter((s) => s && (s.title || (s.lines || []).length)) : []
  const structLeftover = structured && Array.isArray(structured.leftover) ? structured.leftover : []
  const useStructured = structSections.length > 0

  const byId = new Map(cards.map((c) => [c.id, c]))
  /* 卡片可能属于某个板框；一份草稿里每张卡只出现一次（跟着它的框走）。 */
  const framed = new Set()
  for (const f of frames) for (const id of f.cards || []) framed.add(id)
  const looseCards = cards.filter((c) => !framed.has(c.id)).slice().sort(byPosition)

  const out = []
  const title = (board.title || '未命名').trim()
  out.push(`# ${title} · 收拢草稿`)
  out.push('')
  out.push(
    `> 从白板「${title}」收拢于 ${when}。这是**草稿**：挑出要留的，删掉多余的，` +
      `标题和格式随手改 —— 格式只有一条硬规矩：行首 \`- \` 是一条，缩进两个空格是"属于上一条"。`
  )
  out.push('')

  let cardCount = 0
  let secNo = 0
  const sec = (name) => {
    secNo += 1
    out.push(`## ${secNo}、${name}`)
    out.push('')
  }

  /* 一块手写怎么落进草稿：先一句"这是机器认的"，再逐行。
     ★ 那句话不能省：草稿的价值建立在"机器的话可以信一半"上（和 BOARD_PROMPT 里
       那句"绝对不要编造"是同一个意思）—— 混进一段看不出出处的字，你就得逐字对原图。 */
  const emitHand = (h, { mark = true } = {}) => {
    if (h.text) {
      if (mark) out.push('> 下面这一段是机器认的手写（还没校对）：')
      for (const line of noteLines(h.text)) out.push(line)
    } else if (h.error) {
      out.push(`> 这一块的手写没认出来（${h.error}）—— 回白板框住它，点「✨ 美化」可以单独认一块。`)
    }
  }
  const handOf = (frameId) => hand.filter((h) => frameId && h.frameId === frameId)

  /* 有标题的板框 = 你已经想过的结构，按它的顺序来；**没标题的也照样成节**（叫"未命名的一块"）。
     ★ 一个框现在**既是卡的节、也是手写的节**（2026-09-19 第 2 步）：框里那几笔手写认回来的字
       落在**这个框的小节底下** —— 从前它们只能挤在文末那一段里，连"这是哪一块"都看不出来；
       而"只装手写、没有卡片的框"从前是**一个字都不出现**的。 */
  for (const f of frames) {
    const members = (f.cards || []).map((id) => byId.get(id)).filter(Boolean).sort(byPosition)
    /* 结构整理那一趟已经把这些手写摆进它自己的小节了 → 这儿不再重复贴一遍。 */
    const mine = useStructured ? [] : handOf(f.id)
    if (!members.length && !mine.length) continue
    sec(f.title || '未命名的一块')
    for (const c of members) {
      const lines = (c.kind === 'formula' ? [formulaLine(c)] : textLines(c)).filter(Boolean)
      if (lines.length) cardCount += 1
      for (const l of lines) out.push(l)
    }
    for (const h of mine) emitHand(h)
    out.push('')
  }
  if (secNo === 0 && frames.length === 0 && looseCards.length === 0 && !hand.length) {
    /* 一张卡都没有、也没有转录稿：不生成空草稿，让调用方提示"先美化再收拢"。 */
    return { md: '', cards: 0, frames: 0, links: 0, strokesLeft: strokes.length, unreadable: 0, unreadableLines: [] }
  }

  if (looseCards.length) {
    sec(frames.length ? '散着的卡（还没归进哪一块）' : '这一板的卡')
    for (const c of looseCards) {
      const lines = (c.kind === 'formula' ? [formulaLine(c)] : textLines(c)).filter(Boolean)
      if (lines.length) cardCount += 1
      for (const l of lines) out.push(l)
    }
    out.push('')
  }

  /* 卡片用文字开头那截当名字（板框用它自己的标题）。 */
  const nameOf = (id) => {
    const c = byId.get(id)
    if (c) {
      const t = (c.kind === 'formula' ? c.src || c.tex : c.text) || ''
      return t.replace(/\s+/g, ' ').trim().slice(0, 24) || '一张卡'
    }
    const f = frames.find((x) => x.id === id)
    return (f && f.title) || '一块'
  }
  /* 条件的名字。`cond` 是 links.js 读出来的那个东西（`{kind:'card'|'ink', id, ids, label}`）：
     卡片 → 用卡片自己那几个字；墨迹块 → **只说有几个字**。
     ⚠ 那几个字**没认过**（条件写在中点旁边的手写上），草稿里不能替它编 ——
     编了就是"看着像内容，其实是我猜的"，那正是这份草稿最怕的东西。 */
  const condNote = (cond) => {
    if (!cond) return ''
    if (cond.kind === 'card') return nameOf(cond.id)
    const n = Array.isArray(cond.ids) ? cond.ids.length : 0
    return n ? `板上的手写（${n} 笔，还没认）` : '板上的手写（还没认）'
  }

  /* ── 板上的连接：**你宣告的**和**你画出来的**都要读 ─────────────────────
   * 从前这里只读 `board.links`（你宣告的那几条），于是"两张卡之间画一条线"
   * 这条免费路在草稿里是**隐形**的 —— 而它恰恰是零字节的那种关系：
   * 你画的那条线不写 `links`，只活在笔迹里（见 ADR-0001）。
   * 读法只有一处：`createLinkReader()`（第二刀之后所有连接的唯一入口，
   * 它自己管索引和缓存），这里不再自己拼一遍。 */
  let links = []
  let linksError = ''
  try {
    links = createLinkReader().read(board)
  } catch (e) {
    /* 读连接失败**不该拦住收笔记**（草稿的价值在字），但也**绝不能静默** ——
       "少了一节而屏幕上看不出来"正是这个仓库最怕的那类故障，所以在草稿里写一行。 */
    linksError = (e && e.message) || String(e)
  }

  if (links.length) {
    sec('关系（板上的连接：你连的 + 你画的）')
    /* 同一条关系可能既是"你画的"又是"你宣告的"（同一对卡之间两种说法）——
       重复的不再写第二遍，但**不同词的照样各写一行**（那是两句话）。 */
    const seen = new Set()
    for (const l of links) {
      const meta = linkKind(l.kind)
      const kind = meta.name
      const a = nameOf(l.a)
      const b = nameOf(l.b)
      const key = `${kind}|${a}|${b}`
      if (seen.has(key)) continue
      seen.add(key)
      const cond = condNote(l.cond)
      /* 箭头跟词表走：有方向的词（因果/推导）用 `→`，没方向的（相关/并列/等价）用 `↔` ——
         词表里 `dir` 就是这个意思，别在这儿再写一份"哪几个算有方向"。 */
      out.push(`- ${kind} | ${a} ${meta.dir ? '→' : '↔'} ${b}${cond ? `（条件：${cond}）` : ''}`)
    }
    out.push('')
  } else if (linksError) {
    out.push(`> ⚠ 板上的连接没读出来（${linksError}）—— 这一份草稿里少了"关系"这一节。`)
    out.push('')
  }

  /* 卡和关系一个都没拣出来（卡都在、但全是空的）：和"一张卡都没有"同一条路。 */
  if (cardCount === 0 && links.length === 0 && !hand.length) {
    return { md: '', cards: 0, frames: frames.length, links: 0, strokesLeft: strokes.length, unreadable: 0, unreadableLines: [] }
  }

  /* 没归进任何板框的手写（框外那些散的）：还是文末这一段（2026-09-19 晚加的整板转录）。
     ★ **框里的那一部分不在这儿** —— 它跟着自己的框走了（见上面那个循环，第 2 步）。
     ★ 每一行都要走 `noteLines`（第 1 步）：模型回的是自由 Markdown，
       原样倒进来 = 那些行在阅读页签和导出里**根本不存在**（量过：67 行里 32 行读不到）。
     ★ 它和卡片是**两种可信度**：卡片是你亲手美化过的，转录是机器认的 ——
     所以分开一节，而且标题里就把"没校对"写在脸上（下面还有两句 ★ 说明）。*/
  const framedIds = new Set(frames.map((f) => f.id))
  const looseHand = hand.filter((h) => !h.frameId || !framedIds.has(h.frameId))
  const transcribed = hand.some((h) => h.text)

  if (!useStructured && looseHand.length) {
    sec('手写转录（机器认的，还没校对）')
    /* 标题已经写着"机器认的"了，每一块不用再重复那句 —— 所以 `mark: false`。 */
    for (const h of looseHand) emitHand(h, { mark: false })
    out.push('')
  }

  if (useStructured) {
    /* ★ 这一句必须把**两种出处**都说清（2026-09-20 起结构整理多了一样东西）：
       每一节开头那条带 `〔机器整理〕` 的，是模型**自己写的话**（不是认出来的字），
       其余每一行才是你板上那几行认回来的原字。混在一起而不说，
       就正好踩中这份草稿最怕的那件事："看着像内容，其实是它编的"。 */
    out.push('> 下面这几节是机器认的手写（先按行认字、再读一遍结构），还没校对：')
    out.push('> 每节开头带 `〔机器整理〕` 的那一条是**机器自己写的一段话**（把这一节串起来用的），其余每一行都是你板上的原字。')
    out.push('')
    for (const s of structSections) {
      sec(s.title || '手写转录')
      for (const line of s.lines || []) out.push(line)
      out.push('')
    }
    /* ★ 没被摆进任何一节的行：收在最后一节（`flatSection` 平铺）—— 宁可丑，不可丢。 */
    const leftLines = []
    for (const r of structLeftover) {
      if (r && typeof r === 'object' && Array.isArray(r.lines)) for (const l of r.lines) leftLines.push(l)
    }
    if (leftLines.length) {
      sec('没归进哪一块的行')
      for (const line of leftLines) out.push(line)
      out.push('')
    }
    /* 同一节里一模一样的关系行只写了一遍 —— **报数**（少了几条得看得见；
       你自己的行一条都没动，去的只是"同一节里说第二遍"的关系）。 */
    const dup = Number(structured && structured.dupRel) || 0
    if (dup > 0) {
      out.push(`> 同一节里一模一样的关系行只写了一遍（省掉 ${dup} 条重复）—— 你写的行一条都没动。`)
      out.push('')
    }
  }

  const strokesLeft = strokes.length
  if (strokesLeft > 0) {
    if (transcribed) {
      out.push(`> 草稿里的手写转录（一共 ${strokesLeft} 笔）都是机器认的 —— **记得对照原板校对一遍**再当真。`)
    } else {
      out.push(`> 还有 ${strokesLeft} 笔手写没进来 —— 它们是过程，不是结论。`)
      out.push('> 想收哪一笔：回白板，框选它 → 点「✨ 美化」变成卡片，再来收拢一次。')
    }
    out.push('')
  }

  /* 自审：读不到的行**必须永远是 0**（ADR-0004 第 1 步的判据）。
     它在这里算、跟着返回值交出去，所以调用方不必自己去 parse 一遍，
     而自检可以断言这个数（两条路走的是同一个数）。 */
  const md = out.join('\n')
  const unreadable = unreadableLines(md)
  return {
    md,
    cards: cardCount,
    frames: frames.length,
    links: links.length,
    strokesLeft,
    unreadable: unreadable.length,
    unreadableLines: unreadable,
  }
}

/* 便利入口：直接吃板文件的原文（App 那边多数时候手里是对象，自检手里是文本）。
   ⚠ 选项要**整个转发**（transcription 这类新选项从这里漏掉过一次——症状是
   "单测里转录段死活不出现"，而主入口明明是对的）。 */
export function draftNoteFromBoardText(text, opts = {}) {
  const board = parseBoardDocument(text, '')
  return draftNoteFromBoard(board, opts)
}

/* ═══════════ 分块：板框优先，留白兜底（2026-09-19，ADR-0004 第 2 步）═══════════
 *
 * 为什么不能只按留白切：**板框是你亲手圈的"这一块是一个整体"**（ADR-0001），
 * 而"竖直大留白"只是几何上的一个猜。你圈了 5 块，就该发 5 次、认回来 5 节；
 * 按留白切则可能把你一个框**切成两半**（模型拿到的半节没有名字、也没有边界），
 * 而框外那条孤零零的笔迹又可能跟你框里的内容混成一块。
 *
 * 三条规矩：
 *   ① **框里有笔迹的，一块就是那个框**（成员在你圈的那一刻定死）——
 *      块的名字就是框的名字，认回来的字最后落在**同名的那一节**底下；
 *   ② **不在任何框里的笔迹，才走留白分块**（`splitByBands`，一个字没改）；
 *   ③ 块按**从上到下**排 —— 框块和散块混在一起时，顺序也该是阅读顺序。
 *
 * ⚠ 这里只决定"发几次、每次发哪几笔"，**不碰板**（纯函数，自检断言得住）。
 *   图怎么取景、框怎么画进图，仍然是 `strokesToPngBlob` + `frameRectsForBand` 的事。
 * ⚠ 返回的 `top` 是成员包围盒的**上沿**（世界像素）—— 排序用，也给自检看。 */
export function splitByBlocks(strokes, board, { maxBands = 4, minGap = 90 } = {}) {
  const list = []
  for (const s of Array.isArray(strokes) ? strokes : []) {
    if (!s || !Array.isArray(s.points) || s.points.length < 6) continue
    if (!strokeBounds(s)) continue
    list.push(s)
  }
  if (!list.length) return []
  const byId = new Map(list.map((s) => [s.id, s]))
  const frames = board && Array.isArray(board.frames) ? board.frames : []

  const blocks = []
  const claimed = new Set()
  for (const f of frames) {
    /* 框的成员里**在这一批笔迹里的**才算（调用方可能已经把荧光笔滤掉了）。 */
    const mine = (f.ids || []).map((id) => byId.get(id)).filter(Boolean)
    if (!mine.length) continue
    for (const s of mine) claimed.add(s.id)
    blocks.push({ strokes: mine, ids: mine.map((s) => s.id), name: String(f.title || '').trim(), frameId: f.id })
  }
  const rest = list.filter((s) => !claimed.has(s.id))
  for (const band of splitByBands(rest, { maxBands, minGap })) {
    blocks.push({ strokes: band, ids: band.map((s) => s.id), name: '', frameId: null })
  }
  const topOf = (b) => {
    let y = Infinity
    for (const s of b.strokes) {
      const bb = strokeBounds(s)
      if (bb) y = Math.min(y, bb.y)
    }
    return Number.isFinite(y) ? y : Infinity
  }
  /* `at` 只为了**稳定排序**（上沿一样时按原来的先后，别让顺序抖动）。 */
  return blocks
    .map((b, at) => ({ ...b, top: topOf(b), at }))
    .sort((a, b) => a.top - b.top || a.at - b.at)
}

/* ═══════════ 分块：按竖直方向的大片留白把整板切成横条 ═══════════
 *
 * 为什么要分：识别准确率的第一决定因素是**字在图里有多大**。一整块板压进
 * 一张 2400px 高的图，单字只剩十几像素，模型对这种输入的准确率断崖式下跌。
 * 而板面本来就是从上往下写的 —— 竖直方向的大片空白是天然的分节线，
 * 从那里横切，阅读顺序一点不破坏，每一块却能用足分辨率单独认。
 *
 * 算法（纯几何，node 里可测）：
 *   ① 每笔算包围盒，按 y0 排序；
 *   ② 扫相邻笔迹之间的竖直空隙，≥ minGap（世界像素）的算"大留白"；
 *   ③ 挑最大的 maxBands−1 条作为切线，切在空隙正中间（那一带没有笔迹，切不伤字）；
 *   ④ 每笔按**中心 y** 归入哪一块 —— 因为切线穿过的是空白，没有笔迹跨线。
 * 没有大留白（写得满）就返回一块，行为和不分块时一样。 */
export function splitByBands(strokes, { maxBands = 4, minGap = 90 } = {}) {
  const items = []
  for (const s of Array.isArray(strokes) ? strokes : []) {
    if (!s || !Array.isArray(s.points) || s.points.length < 6) continue
    const b = strokeBounds(s)
    if (!b) continue
    items.push({ s, y0: b.y, y1: b.y + b.h })
  }
  if (!items.length) return []
  items.sort((a, b) => a.y0 - b.y0)

  const gaps = []
  let curY1 = items[0].y1
  for (let i = 1; i < items.length; i++) {
    const it = items[i]
    if (it.y0 - curY1 >= minGap) gaps.push({ at: (curY1 + it.y0) / 2, size: it.y0 - curY1 })
    if (it.y1 > curY1) curY1 = it.y1
  }
  gaps.sort((a, b) => b.size - a.size)
  const cuts = gaps.slice(0, Math.max(0, maxBands - 1)).map((g) => g.at).sort((a, b) => a - b)
  if (!cuts.length) return [items.map((it) => it.s)]

  const groups = [[]]
  let bi = 0
  for (const it of items) {
    const cy = (it.y0 + it.y1) / 2
    while (bi < cuts.length && cy > cuts[bi]) {
      groups.push([])
      bi++
    }
    groups[groups.length - 1].push(it.s)
  }
  return groups.filter((g) => g.length)
}

/* ═══════════ 板框脚手架：把用户圈的框画进识别图（2026-09-19 晚，第②刀）═══════════
 *
 * 板框是用户亲手圈的"这一块是一个整体"——把它画成**浅灰虚线**跟图一起发过去，
 * 模型分节就有了现成的视觉线索（BOARD_PROMPT 里配了一句"虚线框只是记号"）。
 *
 * 两条硬规矩：
 * ① **框不参与取景**。发送图的取景只由笔迹包围盒决定（strokesToPngBlob），
 *    这里的矩形交给 overlays 画上去，出界部分被画布自然裁掉 ——
 *    不然一个大框会把整块图的字压小，分块挣来的分辨率就白费了。
 * ② **框和这块笔迹不相交就不给**。框里只有卡片、原笔迹又被擦掉的话，
 *    图上那块本来就是空的，画个框等于让模型对着空白分节，纯属添乱。
 *
 * 输入：某一块（splitByBands 切出的）笔迹 + 整块板；输出：世界坐标矩形数组。 */
export function frameRectsForBand(bandStrokes, board) {
  const frames = board && Array.isArray(board.frames) ? board.frames : []
  if (!frames.length) return []
  let box = null
  for (const s of Array.isArray(bandStrokes) ? bandStrokes : []) {
    const b = s && s.points && s.points.length >= 3 ? strokeBounds(s) : null
    if (!b) continue
    box = box
      ? { x0: Math.min(box.x0, b.x), y0: Math.min(box.y0, b.y), x1: Math.max(box.x1, b.x + b.w), y1: Math.max(box.y1, b.y + b.h) }
      : { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }
  }
  if (!box) return []
  const hit = (r) => r.x < box.x1 && r.x + r.w > box.x0 && r.y < box.y1 && r.y + r.h > box.y0
  const out = []
  for (const f of frames) {
    const r = frameBounds(board, f)
    if (r && r.w > 1 && r.h > 1 && hit(r)) out.push(r)
  }
  return out
}
