import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { katexHtml } from '../lib/renderMath.js'
/* FIELD_KEYS 只有一份，定义在 parse.js（格式的唯一权威）。
   曾经这里也抄了一份：加字段时漏改一边，着色层就会和解析器打架
   —— 解析器认了字段，颜色却还是普通正文，看起来像"没生效"。 */
import { splitTitleBody, FIELD_KEYS } from '../lib/parse.js'

/* ────────────────────────────────────────────────────────────
   编辑区：一个视图同时满足两件事
     · 直接改原文（不存在"改不了"）
     · 看到的又是渲染后的样子（公式有底纹、标题变粗、字段成标签）

   ── 架构（重要，改之前先读）──

   曾经的做法：textarea 自己滚动，着色层用 translateY(-scrollTop) 去追。
   结果是**渲染层的错位**：DOM 几何永远自洽（transform == -scrollTop），
   但浏览器实际把 textarea 内容画在了别处，随滚动漂移 ±14px。
   实测（scripts/paint-offset.js、offset-scan.js）：
       scrollTop   0    300   700   1200  1700
       绘制偏移   -4px   0    +10px -11px -14px
   而同一时刻 DOM 探针一律报 0px —— 所以"量 DOM"永远查不出来，只有比像素才发现。

   现在的做法：
     .srcscroll  = 唯一的滚动容器
       .hl-inner = 着色层（绝对定位，撑开容器高度）
       textarea  = 也绝对定位、也撑开同样高度，**自己不滚动**
   两层在同一个滚动容器里，由浏览器一起滚动 —— 没有 transform 要同步，
   错位在结构上就不可能发生。

   scripts/check-align.js 与 scripts/cdp-align.js 盯着这套约束。
   ──────────────────────────────────────────────────────────── */

const RE_HEADING = /^(\s*)(#{1,6})\s+(\S.*)$/
const RE_ITEM = /^(\s*)-\s+(\S.*)$/

/* 字号倍率。这三个数必须和 styles.css 里 .hl-line.head.lv1/lv2/lv3 的 font-size 对上。
/* 行高倍数，必须和 styles.css 里的 --src-lh 一致。
   注意：**这里没有 HEAD_SCALE，而且不能再加回来**。
   曾经的教训：给标题行放大字号，但 <textarea> 里所有行共用同一个 font-size，
   于是两层的行盒高度不一致 —— 实测总高差 71.34px（正好 3 个标题多出来的高度），
   整篇文字越往下错得越多。而且 DOM 几何永远自洽，所以探针查不出来，只有比像素才发现。
   标题现在只用字重 / 颜色 / 行首色带区分，字号与正文完全一致。
   scripts/tail-compare.js 盯着"两层总高必须相等"。 */
const LH_MULT = 1.95 // = styles.css 里的 --src-lh
const CARET_WIDTH = 2

/* ── 长文件：只把看得见的那几行画成"着色行" ────────────────────────────
 * 为什么要有这一档（2026-10-01，用户：「点笔记与点白板这个切换…卡了一下得要 1，2 秒」）：
 *   编辑区原来**整篇逐行画**。实测一次切换：`.hl-line` 50073 个 + span 50074 个
 *   = body 里 10 万个节点 —— 界面 1.1 秒才换过去，之后还有 2.0 秒的排版长任务。
 *   而**真正看得见的只有 30 行**。所以超过 VIRT_MIN_ROWS 行的文件改成"分块"：
 *     · 每 CHUNK_ROWS 行一块；看得见的块（IntersectionObserver 判定）照旧逐行画；
 *     · 看不见的块用**整块原文**撑着 —— 排版参数（字体 / 行高 / 可用宽度 / 折行规则）
 *       和 textarea 逐字相同，所以折行点、每一行的位置、总高全都一样，
 *       两层仍然对齐（scripts/check-srcvirt.js 盯着这条底线）。
 *   低于这个行数**完全走老路**：真实笔记（几百行）本来也没必要分块，
 *   而那一档的行为必须一个字节都不变。 */
const CHUNK_ROWS = 250
const VIRT_MIN_ROWS = 2000

/** 一行的"宽度单位"：半角算 1、全角（CJK 及全角标点）算 2。
    只用来判断"这一行放不放得下"，够用就行 —— 逐行 measureText 太贵。 */
function rowUnits(line) {
  let u = 0
  for (let i = 0; i < line.length; i++) u += line.charCodeAt(i) > 0x2e7f ? 2 : 1
  return u
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])

/** 一行的着色：公式 / 引用 / 整行类型。返回 HTML 和这行的类型。 */
export function highlightLine(line) {
  const src0 = String(line ?? '')
  const h = src0.match(RE_HEADING)
  const it = src0.match(RE_ITEM)

  let kind = 'plain'
  if (h) kind = 'h' + Math.min(h[2].length, 4)
  else if (it) kind = 'item'

  let fieldKey = null
  if (it) {
    const { title } = splitTitleBody(it[2])
    const first = title.split('|')[0].trim()
    if (FIELD_KEYS.includes(first)) fieldKey = first
  }

  const DEC = '\u0002'
  const src = src0.replace(/\\\$/g, DEC)
  const chunks = src.split('$')
  const out = []

  const pushRefs = (text) => {
    const re = /\[\[([^[\]]*)(\]\])?/g
    let l = 0
    let mm
    while ((mm = re.exec(text))) {
      if (mm.index > l) out.push({ t: 'text', s: text.slice(l, mm.index) })
      out.push({ t: 'ref', s: mm[0], open: !mm[2] })
      l = mm.index + mm[0].length
    }
    if (l < text.length) out.push({ t: 'text', s: text.slice(l) })
  }

  chunks.forEach((chunk, ci) => {
    if (ci % 2 === 1) {
      const closed = ci !== chunks.length - 1
      out.push({ t: 'formula', s: '$' + chunk.replaceAll(DEC, '$') + (closed ? '$' : ''), open: !closed })
    } else {
      pushRefs(chunk.replaceAll(DEC, '$'))
    }
  })

  const html = out
    .map((p) => {
      if (p.t === 'formula') {
        return `<span class="hl-formula${p.open ? ' unclosed' : ''}" data-token="formula">${esc(p.s)}</span>`
      }
      if (p.t === 'ref') {
        return `<span class="hl-ref${p.open ? ' unclosed' : ''}" data-token="ref">${esc(p.s)}</span>`
      }
      return esc(p.s)
    })
    .join('')

  return { html, kind, fieldKey }
}

/** 整篇文本 → 每行 html + 类型 + 起始偏移 + 字号倍率 */
export function buildLines(text) {
  const raw = String(text ?? '').split('\n')
  const lines = []
  let off = 0
  for (let i = 0; i < raw.length; i++) {
    const { html, kind, fieldKey } = highlightLine(raw[i])
    const lv = kind.startsWith('h') ? Number(kind.slice(1)) : 0
    lines.push({
      i,
      text: raw[i],
      html,
      kind,
      fieldKey,
      start: off,
      
    })
    off += raw[i].length + 1
  }
  return lines
}

/** 光标字符偏移 → 行号 */
export function lineIndexAt(lines, pos) {
  for (let i = lines.length - 1; i >= 0; i--) if (pos >= lines[i].start) return i
  return 0
}

/* 光标字符偏移 → 行号（**按原文数换行**，不整篇切行）。
   为什么不能继续用 `buildLines(el.value)`：那是整篇重新做一遍正则 + 建 5 万个对象，
   长文件里每敲一个键、每移一次光标都要付一次（实测整篇 21ms 起跳，加上对象分配远不止）。
   数到光标那一个字符就够了 —— 光标在文件末尾时也就几十万次比较，一次不到 1ms。 */
export function lineNoAt(value, pos) {
  const end = Math.min(pos, value.length)
  let n = 0
  for (let i = 0; i < end; i++) if (value.charCodeAt(i) === 10) n++
  return n
}

/** 只给"光标所在这一行"做公式渲染预览 */
export function linePreview(lineText) {
  const DEC = '\u0002'
  const src = String(lineText ?? '').replace(/\\\$/g, DEC)
  const chunks = src.split('$')
  const parts = []
  chunks.forEach((chunk, ci) => {
    if (ci % 2 === 1) {
      const latex = chunk.replaceAll(DEC, '$')
      if (!latex.trim()) return
      /* ★ 走 `renderMath.js` 那一份（带缓存：翻页来回切，式子不重排）。 */
      const html = katexHtml(latex, { throwOnError: false, displayMode: false, output: 'html' })
      parts.push({ type: 'math', latex, html })
    } else {
      const plain = chunk.replaceAll(DEC, '$').trim()
      if (plain) parts.push({ type: 'text', text: plain })
    }
  })
  return { parts, formulaCount: parts.filter((p) => p.type === 'math').length }
}

/** 点覆盖层时反查：点在哪个着色胶囊上 */
function spanAtPoint(x, y) {
  try {
    const el =
      (document.caretPositionFromPoint && document.caretPositionFromPoint(x, y)?.offsetNode) ||
      (document.caretRangeFromPoint && document.caretRangeFromPoint(x, y)?.startContainer)
    const node = el && el.nodeType === 3 ? el.parentElement : el
    return node && node.closest ? node.closest('[data-token]') : null
  } catch {
    return null
  }
}

/** 让元素滚进最近一次可滚动祖先的可视区（自己实现，避免依赖 scrollIntoView 的差异） */
function revealInScroller(scroller, el, pad = 40) {
  if (!scroller || !el) return
  const sRect = scroller.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  if (eRect.top < sRect.top + pad) {
    scroller.scrollTop -= sRect.top + pad - eRect.top
  } else if (eRect.bottom > sRect.bottom - pad) {
    scroller.scrollTop += eRect.bottom - (sRect.bottom - pad)
  }
}

/* ────────────────────────────────────────────────────────────
   字符几何：逐"占据位"量宽度。

   为什么必须这样（踩过的坑）：判断逻辑位置 pos 落在第几个视觉行，用的是
   「从行首到 pos 的总宽度」（canvas 量），然后再和该视觉行的宽度区间比较 ——
   这两者的坐标系根本不一致（前者含换行前的部分）。实测后果：
     行内第 31 个字符 → 光标 x 算出 316.59，实际应在 367.89，偏差 -51.3px，
     于是光标插进了第 26 个字符「{」的正中间。
   改成逐"占据位"累计之后，每个占据位自带 (逻辑偏移, 视觉行, x)，两件事一次对齐。
   ──────────────────────────────────────────────────────────── */

/** 一个逻辑行的字符占据位（坐标系 = 行盒 content-box 原点） */
function rowGlyphs(row, baseFont, fontFamily, ctx, availW) {
  if (row._glyphs && row._availW === availW && row._fontKey === `${baseFont}|${fontFamily}`) return row._glyphs
  ctx.font = `${baseFont}px ${fontFamily}`
  const text = row.text
  const cells = []
  let x = 0
  let line = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const step = cp > 0xffff ? 2 : 1
    const charW = ctx.measureText(ch).width
    if (x > 0 && x + charW > availW + 1e-6) {
      // 这个字放不下 → 换行：逻辑偏移停在原地，视觉行 +1，x 归零
      cells.push({ start: i, end: i, line: line + 1, x: 0, w: 0, ch: '' })
      line += 1
      x = 0
    }
    cells.push({ start: i, end: i + step, line, x, w: charW, ch })
    x += charW
    i += step
  }
  row._glyphs = cells
  row._availW = availW
  row._fontKey = `${baseFont}|${fontFamily}`
  return cells
}

/** 逻辑偏移 → 光标在该行内的 (视觉行, x) */
function caretPoint(row, logicalPos, baseFont, fontFamily, ctx, availW) {
  const cells = rowGlyphs(row, baseFont, fontFamily, ctx, availW)
  for (const c of cells) {
    if (c.end > c.start && logicalPos >= c.start && logicalPos < c.end) return { line: c.line, x: c.x }
    if (c.end === c.start && logicalPos === c.start) return { line: c.line, x: c.x }
  }
  const last = cells[cells.length - 1]
  return last ? { line: last.line, x: last.x + last.w } : { line: 0, x: 0 }
}



export default function SourceEditor({
  text,
  textareaRef,
  editing,
  onEdit,
  onSelectNode,
  onRefTitle,
  jumpRef,
  fontSizePx,
  diag,
}) {
  const scrollRef = useRef(null)
  const innerRef = useRef(null)
  const [activeLine, setActiveLine] = useState(0)
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(null)
  const [fontRatios, setFontRatios] = useState(null)
  /* 长文件里"哪几块正看着"（IntersectionObserver 填的）。短文件一直是 null。 */
  const [visChunks, setVisChunks] = useState(null)

  /* 行的两个来源（见文件头「长文件」那一节）：
       · 短文件：整篇切好（`buildLines`），老样子一行不差；
       · 长文件：只留原文 + 每行起始偏移，着色**按需**算（见 getRow）。 */
  const rawLines = useMemo(() => String(text ?? '').split('\n'), [text])
  const starts = useMemo(() => {
    const out = new Array(rawLines.length)
    let off = 0
    for (let i = 0; i < rawLines.length; i++) {
      out[i] = off
      off += rawLines[i].length + 1
    }
    return out
  }, [rawLines])
  const virtual = rawLines.length > VIRT_MIN_ROWS
  const lines = useMemo(() => (virtual ? null : buildLines(text ?? '')), [text, virtual])
  const rowCount = lines ? lines.length : rawLines.length

  /** 取第 i 行（长文件下现算这一行的着色 —— 一行的正则，几微秒） */
  const getRow = useCallback(
    (i) => {
      if (lines) return lines[i]
      const raw = rawLines[i]
      if (raw === undefined) return null
      const { html, kind, fieldKey } = highlightLine(raw)
      return { i, text: raw, html, kind, fieldKey, start: starts[i] }
    },
    [lines, rawLines, starts]
  )

  /* ---- 一屏放得下多少字（只用来判断"这一行会不会折行"）---- */
  const measureCtx = useRef(null)

  /** textarea 内容的可用宽度（= 它 clientWidth 减左右内边距）。折行模拟要用。 */
  const availWidth = useCallback(() => {
    const el = textareaRef.current
    if (!el) return 0
    const cs = window.getComputedStyle(el)
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  }, [textareaRef])

  /** 一屏最多能放多少个"宽度单位"（canvas 只量一次半角字宽，不逐行量 ——
      5 万行逐行 measureText 是几十万次调用，比排版本身还贵） */
  const availUnits = useCallback(() => {
    const el = textareaRef.current
    if (!el) return 0
    const w = availWidth()
    if (!(w > 0)) return 0
    if (!measureCtx.current) measureCtx.current = document.createElement('canvas').getContext('2d')
    const ctx = measureCtx.current
    const cs = window.getComputedStyle(el)
    ctx.font = `${parseFloat(cs.fontSize) || 19.4}px ${cs.fontFamily}`
    const mw = ctx.measureText('M').width
    return mw > 0 ? Math.floor(w / mw) : 0
  }, [availWidth, textareaRef])

  /* ★ 分块要等 textarea 挂载完再算一次：第一次渲染时 `textareaRef.current` 还是 null，
     `availUnits()` 量不到宽度（返回 0）→ 所有块都会被当成"会折行"（保守那一档），
     于是整篇又排一遍 —— 白优化。挂载好之后重算，才拿得到真正的宽度。 */
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  /* 分块（只长文件用）。★ 块文本**按块缓存**：打字时只有光标那一块的内容真变了，
     其余块复用**同一个字符串对象** —— React 认引用相同就不会去动那些 DOM，
     于是敲一个键不会被迫把整篇重排一遍。 */
  const chunkCache = useRef(new Map())
  const chunks = useMemo(() => {
    if (!virtual) return null
    const cap = availUnits()
    const out = []
    for (let a = 0; a < rawLines.length; a += CHUNK_ROWS) {
      const k = a / CHUNK_ROWS
      const b = Math.min(a + CHUNK_ROWS, rawLines.length)
      const s = rawLines.slice(a, b).join('\n')
      const prev = chunkCache.current.get(k)
      const t = prev === s ? prev : s
      chunkCache.current.set(k, t)
      /* 这块里有没有"放不下、会折行"的行 —— 有的话就不能用「行数 × 行高」占位
         （占位算不出折行多出来的那些高度），只能把原文交给浏览器排。
         量不出宽度（`cap === 0`，比如还没挂载）就一律按"会折行"处理：慢一点，但不会错。 */
      let wrap = cap <= 0
      if (!wrap) {
        for (let i = a; i < b; i++) {
          if (rowUnits(rawLines[i]) > cap) {
            wrap = true
            break
          }
        }
      }
      out.push({ k, a, b, text: t, wrap })
    }
    return out
  }, [virtual, rawLines, availUnits, fontSizePx, mounted])

  /* 一行的真实高度（**量出来的**，不用 baseFont × 1.95 去算）。
     为什么必须量：浏览器把行盒高度取整到 1/64px，5 万行各自取整之后累加出来的总高，
     和"行数 × 算出来的行高"能差出几千 px —— 而着色层和 textarea 必须一层不差。
     ★ 量法必须是**已经画出来的相邻两行**：这一档里"看不见的块"就是靠「行数 × 行高」
     撑着的，行高差 0.06px，5 万行就差出 3000px（实测：错 3405px）。
     试过塞一个空行探针进去量 —— 量出来 28.7477，而真实行是 28.6875（探针所处的
     字体/样式时机和真实行不一致）。所以只信真实行。 */
  const [lineH, setLineH] = useState(0)
  /* 占位块用的行高（`0` = 还没量，先拿 baseFont 推的那个顶着）。
     ★ 它 = 真实行高 + 残差/行，是**一次算准**的，不是一轮轮迭代出来的 ——
       迭代那版实测抖出 107 次布局（两个 effect 互相推翻对方的基准）。 */
  const [placeLineH, setPlaceLineH] = useState(0)
  useEffect(() => {
    if (!virtual) return
    const host = innerRef.current
    if (!host) return
    let best = 0
    /* 只在"不会折行、而且正被逐行画着"的块里量 —— 折行块的高度掺了折行，不能拿来当行高 */
    for (const blk of host.querySelectorAll('.hl-chunk[data-wrap="0"].rows')) {
      const ls = blk.querySelectorAll('.hl-line')
      if (ls.length < 2) continue
      const i0 = Number(ls[0].dataset.i)
      const i1 = Number(ls[ls.length - 1].dataset.i)
      const d = ls[ls.length - 1].getBoundingClientRect().top - ls[0].getBoundingClientRect().top
      if (i1 > i0 && d > 0) {
        best = d / (i1 - i0)
        break
      }
    }
    if (best > 0 && Math.abs(best - lineH) > 0.005) setLineH(best)
    /* ⚠ 依赖里**不能**写 `fontFamily`：它是下面才定义的（TDZ，实测整页白屏）。
       字号变化由 fontSizePx 带着走；字体晚到那一趟由下面 fonts.ready 补一次。 */
  }, [virtual, lineH, visChunks, activeLine, fontSizePx, text])

  /* 字体晚到（webfont 异步加载）会让行高变一次 —— 加载完再量一遍，
     不然会一直用着加载前那个行高（实测错位就是从这儿来的）。 */
  useEffect(() => {
    if (!virtual || typeof document === 'undefined' || !document.fonts) return
    let alive = true
    document.fonts.ready.then(() => {
      if (alive) setLineH(0) // 归零 = 逼上面那个 effect 重量
    })
    return () => {
      alive = false
    }
  }, [virtual])

  /* 哪几块看得见 —— 交给浏览器判（IntersectionObserver），**不自己算滚动位置**。
     为什么不自己算：块有多高取决于折行，只有浏览器排完版才知道；自己估就等于
     重新踩一遍"用假设代替测量"（这个文件里光标那一段记着三次）。 */
  const chunkEls = useRef(new Map())
  const activeChunkRef = useRef(0)
  useEffect(() => {
    activeChunkRef.current = Math.floor(activeLine / CHUNK_ROWS)
  }, [activeLine])
  useEffect(() => {
    if (!virtual || !chunks) return
    const root = scrollRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        setVisChunks((prev) => {
          const next = new Set(prev || [])
          let changed = false
          for (const e of entries) {
            const k = Number(e.target.dataset.k)
            if (!Number.isFinite(k)) continue
            if (e.isIntersecting) {
              if (!next.has(k)) {
                next.add(k)
                changed = true
              }
            } else if (next.has(k) && k !== activeChunkRef.current) {
              /* 光标所在那一块不加不减 —— 它随时要量光标、要高亮 */
              next.delete(k)
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      /* 上下各多留 320px：滚到之前就画好，别让人看见"没着色的一块" */
      { root, rootMargin: '320px 0px' }
    )
    /* 文件变短时，多出来的块已经不在 DOM 里了 —— 别再盯着它们 */
    for (const k of [...chunkEls.current.keys()]) {
      if (k >= chunks.length) chunkEls.current.delete(k)
    }
    for (const el of chunkEls.current.values()) io.observe(el)
    return () => io.disconnect()
  }, [virtual, chunks])

  const baseFont = useMemo(() => {
    const el = textareaRef.current
    if (!el) return 19.4
    const v = parseFloat(window.getComputedStyle(el).fontSize)
    return Number.isFinite(v) ? v : 19.4
    /* ★ `mounted` 必须在这儿：第一次渲染时 textarea 还没挂上，`el` 是 null，
       量出来的就是兜底的 19.4 —— 而长文件那一档的"行高"是从它推出来的，
       19.4 × 1.95 和真实的 14.7 × 1.95 差着一倍，整篇会错出几十万 px。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, rawLines, fontSizePx, textareaRef, mounted])

  const fontFamily = useMemo(() => {
    const el = textareaRef.current
    return el ? window.getComputedStyle(el).fontFamily : 'monospace'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSizePx, textareaRef])

  // 所有行同高：正文和标题共用同一个字号/行高（这是两层对齐的前提）
  const lineHeightOf = useCallback(() => baseFont * LH_MULT, [baseFont])

  // 字体 content area 比例（决定自绘光标高度）。
  // 用一个大字号量出来，再按行字号缩放；这是纯比例，不涉及任何"宽度假设"。
  useEffect(() => {
    const d = document.createElement('div')
    d.style.cssText = `position:fixed;left:-9999px;top:0;font-family:${fontFamily};font-size:1000px;line-height:1;white-space:pre`
    d.textContent = 'Hg'
    document.body.appendChild(d)
    const total = d.getBoundingClientRect().height / 1000
    d.remove()
    // 'Hg' 的实测高度 ≈ 字体的 ascent+descent；再乘 1.18 覆盖中文全角字，
    // 让竖条把中文也完整罩住（纯比例，不涉及任何宽度假设）
    setFontRatios({ total: (total > 0.5 ? total : 1.0) * 1.18 })
  }, [fontFamily])

  const syncActive = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    setActiveLine(lineNoAt(el.value, el.selectionStart ?? 0))
  }, [textareaRef])

  /* ---- 自绘光标（接管所有行）----
     为什么不用原生光标：textarea 只有一个字号，浏览器画的原生光标也只按这个字号
     算高度和纵向位置。实测（scripts/caret-shot.js）：
       正文 19.375px → 原生光标高 23、顶在内容盒下 8px（对）
       标题 29.06px  → 原生光标仍高 34、顶在 2px，而标题字形顶在 11px（差约 9px）
     textarea 的字形本来就被着色层盖住了，所以干脆连光标也自己画：
     高度取该行字体的 content area，纵向居中在行盒里，横向用 canvas 量。 */

  /* 自绘光标的横向位置：**用 Range 量真实字形**，不做任何宽度推算。

     三次踩坑，都是"用假设代替测量"：
       1. 按「行首到光标的整段宽度」当 x  → 折行后偏出一整行（实测 -51px）
       2. 按 baseFont × fontScale 算字宽  → 恒定偏大约 1.2 倍（实测 -46.6px）
       3. 用块级测量元素量宽度            → 块级宽度恒等于行宽（699px）
     现在：在渲染出来的文本节点里定位第 col 个字符，用 Range 拿它的真实字形矩形，
     光标的 x 就是该字符左边界、纵向就是该字符所在的视觉行。
     和文字同一个坐标系，零假设。 */
  const measureCaretX = useCallback(
    (lineIdx, colInRow) => {
    const lineEl = document.querySelector(`.hl-line[data-i="${lineIdx}"]`)
    const row = getRow(lineIdx)
    if (!lineEl || !row) return null
    const txtEl = lineEl.querySelector('.hl-txt')
    if (!txtEl) return null
    const lineRect = lineEl.getBoundingClientRect()
    const lineH = baseFont * LH_MULT

    const rectOf = (at, len) => {
      let seen = 0
      // 用数字常量 4（SHOW_TEXT）而不是全局 NodeFilter —— 后者在非浏览器环境（如 jsdom）里不存在
      const walker = document.createTreeWalker(txtEl, 4, null)
      let n
      while ((n = walker.nextNode())) {
        const L = n.nodeValue.length
        if (seen + L > at) {
          try {
            const rg = document.createRange()
            const s = at - seen
            rg.setStart(n, s)
            rg.setEnd(n, Math.min(s + len, L))
            // 某些环境（jsdom）没实现 Range.getBoundingClientRect，量不到就返回 null
            if (typeof rg.getBoundingClientRect !== 'function') return null
            const r = rg.getBoundingClientRect()
            return r.width === 0 && r.height === 0 ? null : r
          } catch {
            return null
          }
        }
        seen += L
      }
      return null
    }

    // 光标在第 col 个字符左侧 → 用第 col 个字符的左边界
    let r = rectOf(colInRow, 1)
    let x
    if (r) {
      x = r.left - lineRect.left
    } else {
      // 行尾：用最后一个字符的右边界
      const last = rectOf(Math.max(0, row.text.length - 1), 1)
      x = last ? last.right - lineRect.left : 0
      r = last
    }
    // 纵向：这个字符在第几个视觉行
    let visualLine = 0
    if (r) {
      const rel = r.top - lineRect.top
      visualLine = Math.max(0, Math.round((rel - (lineH - r.height) / 2) / lineH))
    }
    return { x: Math.max(0, x), visualLine }
    },
    [baseFont, getRow]
  )

  const updateCaret = useCallback(() => {
    const el = textareaRef.current
    if (!el || document.activeElement !== el || el.selectionStart !== el.selectionEnd) {
      setCaret(null)
      return
    }
    const pos = el.selectionStart ?? 0
    const li = lineNoAt(el.value, pos)
    const start = el.value.lastIndexOf('\n', pos - 1) + 1
    let end = el.value.indexOf('\n', pos)
    if (end < 0) end = el.value.length
    if (start > pos) {
      setCaret(null)
      return
    }
    const col = pos - start
    const m = measureCaretX(li, col)
    // 量不到真实字形时（非浏览器环境）就退回原生光标，宁可不画也不要画错
    if (!m) {
      setCaret(null)
      return
    }
    const lineH = baseFont * LH_MULT
    const textH = baseFont * (fontRatios?.total || 1.18)
    setCaret({
      line: li,
      x: m.x,
      anchor: m.visualLine,
      top: (lineH - textH) / 2 + m.visualLine * lineH,
      height: textH,
      key: `${li}:${el.selectionStart}`,
    })
  }, [baseFont, fontRatios, measureCaretX, textareaRef])
  const refreshAll = useCallback(() => {
    syncActive()
    updateCaret()
  }, [syncActive, updateCaret])

  useEffect(() => {
    updateCaret()
  }, [text, fontSizePx, fontRatios, updateCaret])

  /* textarea 自己不滚动，所以必须把它的高度撑到和内容一样高。
     内容一变（开文件、打字、字号变化）就得重设。 */
  const fitHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const h = el.scrollHeight
    const cur = parseFloat(el.style.height) || 0
    if (Math.abs(cur - h) > 0.5) el.style.height = h + 'px'
  }, [textareaRef])

  useEffect(() => {
    fitHeight()
  }, [text, fontSizePx, fitHeight])

  /* 挂载时，自己把 text 灌进 textarea。
     ── 为什么非要有这一句 ──
     这个 textarea 是**非受控**的（刻意不写 value={text}，受控会让 React 在打字时重渲染抢光标），
     平时靠 App.open() 里那句 `taRef.current.value = shown` 直接写 DOM。
     但**从白板切回笔记**的时候，SourceEditor 还没挂载 —— taRef.current 是 null，
     那句就静默落空了。结果是"着色层有字、编辑框是空的"，
     用户往空框里打一个字，onEdit 拿到的就只有那一个字，整篇被覆盖（丢数据）。
     实测：切到笔记后 ta.value.length = 0，而 .hl-line 有 52 行。
     挂载这一下必须自己兜住 —— effect 在首次渲染后跑，拿到的就是最新的 text。 */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const want = text ?? ''
    if (el.value !== want) el.value = want
    fitHeight()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fitHeight())
    ro.observe(el)
    if (innerRef.current) ro.observe(innerRef.current)
    return () => ro.disconnect()
  }, [fitHeight, textareaRef])

  /* 外部请求跳行。★ 滚动**不在这儿做**，挂个 pending 交给下面那个 effect：
     长文件里目标行所在的那一块可能还没画出来（IntersectionObserver 刚把它标成可见），
     此刻 DOM 里没有那个 `.hl-line`，量出来的 rect 是假的 —— 同步滚就会滚错地方。 */
  const pendingReveal = useRef(null)
  useEffect(() => {
    if (!jumpRef) return
    jumpRef.current = (line) => {
      const el = textareaRef.current
      if (!el) return
      const i = Math.max(0, Math.min(line, rowCount - 1))
      const st = starts[i] ?? 0
      const len = (rawLines[i] || '').length
      el.focus()
      el.setSelectionRange(st, st + len)
      setActiveLine(i)
      onSelectNode && onSelectNode(i)
      pendingReveal.current = i
      updateCaret()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowCount, starts, rawLines, onSelectNode, updateCaret])

  useEffect(() => {
    const i = pendingReveal.current
    if (i == null) return
    const rowEl = document.querySelector(`.hl-line[data-i="${i}"]`)
    if (!rowEl) return // 那一块还没画出来 —— 等下一次（activeLine / visChunks 变了会再跑）
    pendingReveal.current = null
    const sc = scrollRef.current
    if (!sc) return
    const sRect = sc.getBoundingClientRect()
    const rRect = rowEl.getBoundingClientRect()
    sc.scrollTop += rRect.top - sRect.top - (sc.clientHeight - rRect.height) / 2
  }, [activeLine, visChunks, rowCount])

  function handleClick(e) {
    editing.onClick()
    const tok = spanAtPoint(e.clientX, e.clientY)
    if (tok && tok.dataset.token === 'ref') {
      const name = (tok.textContent || '').replace(/^\[\[/, '').replace(/\]\]$/, '').trim()
      if (name) {
        onRefTitle && onRefTitle(name)
        return
      }
    }
    if (tok && tok.dataset.token === 'formula') {
      // 点公式胶囊：把光标放进这段公式里，方便直接改
      const el = textareaRef.current
      const rowEl = tok.closest('.hl-line')
      const row = rowEl ? getRow(Number(rowEl.dataset.i)) : null
      if (el && row) {
        const col = row.text.indexOf(tok.textContent)
        const pos = row.start + (col === -1 ? 0 : Math.min(col + 1, row.text.length))
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    }
    // 普通点击不干预：textarea 自己的 hit-test 就准（它的排版和着色层完全一致），
    // 让它自己放光标，我们只负责更新自绘光标的位置。
    refreshAll()
  }

  const active = getRow(activeLine)
  const activeText = active ? active.text : ''
  const preview = useMemo(
    () => (activeText ? linePreview(activeText) : { parts: [], formulaCount: 0 }),
    [activeText]
  )
  const activeLineHeight = activeLine === undefined ? baseFont * LH_MULT : lineHeightOf(activeLine)

  // 光标移动时把它带进视野（自绘光标 + 原生都不越界）
  useEffect(() => {
    if (!focused) return
    const rowEl = document.querySelector(`.hl-line[data-i="${activeLine}"]`)
    revealInScroller(scrollRef.current, rowEl)
  }, [activeLine, focused, caret?.key])

  /* 还没量到（比如刚挂载那一帧）就用字号推一个，量到了就用量的 */
  const baseLineHpx = lineH > 0 ? lineH : baseFont * LH_MULT

  /* ★ 残差补偿：浏览器把**每一行**的行盒高度各自取整到 1/64px，取出来的整行数乘回去
     和 textarea 排出来的总高差一点点（实测 5 万行差约 30px —— 看着小，可它全堆在末尾，
     滚到底的时候着色层就比文字差出将近一行）。
     修法不是去猜浏览器怎么取整，而是**量一次总高、把差摊回每一行**：
       行高 = 量到的行高 + 残差 ÷ 占位块的总行数
     残差随行数线性累积，所以线性摊回去正好抵消（末尾对上了，中间也不走偏）。 */
  const phRows = useMemo(() => {
    if (!chunks) return 0
    let n = 0
    for (const c of chunks) if (!c.wrap) n += c.b - c.a
    return n
  }, [chunks])
  const lineHpx = placeLineH > 0 ? placeLineH : baseLineHpx

  /* ★ 占位块该用多高的行高：**一次算准**。
     浏览器把**每一行**的行盒高度各自取整到 1/64px，所以"真实行高 × 行数"和
     textarea 排出来的总高差一点点（实测 5 万行差约 30px —— 看着小，可它全堆在末尾，
     滚到底的时候着色层就比文字差出将近一行）。
     不去猜浏览器怎么取整，而是把"除占位块以外"的高度量出来，剩下的按行数均分：
       占位行高 = (textarea 内容高 − 其它块实测高) ÷ 占位行数
     ⚠ 只能一次算准，**不能**写成一个"差多少补多少"的迭代：那两个量会互相推翻对方的
       基准，实测抖出 107 次布局（每次都是整篇重排，比不优化还慢）。 */
  useEffect(() => {
    if (!virtual) return
    const inner = innerRef.current
    const ta = textareaRef.current
    if (!inner || !ta) return
    const blks = [...inner.querySelectorAll('.hl-chunk')]
    if (!blks.length) return
    let other = 0
    let placeRows = 0
    for (const b of blks) {
      const isPlace = b.dataset.wrap === '0' && !b.classList.contains('rows')
      if (isPlace) placeRows += Number(b.dataset.rows) || 0
      else other += b.getBoundingClientRect().height
    }
    if (placeRows <= 0) return
    const cs = window.getComputedStyle(ta)
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const x = (ta.scrollHeight - pad - other) / placeRows
    if (x > 1 && Math.abs(x - placeLineH) > 0.0005) setPlaceLineH(x)
  }, [virtual, placeLineH, lineH, visChunks, chunks, text, fontSizePx])

  /* 一行。**两种画法共用这一个**（短文件整篇画 / 长文件只画看得见的块）——
     改着色、自绘光标、行内公式预览都只改这里，别去改下面那两个分支。 */
  const renderLine = (l) => {
    if (!l) return null
    return (
      <div
        key={l.i}
        data-i={l.i}
        className={
          'hl-line' +
          (l.i === activeLine ? ' active' : '') +
          (l.kind.startsWith('h') ? ' head lv' + l.kind.slice(1) : '') +
          (l.fieldKey ? ' field k-' + l.fieldKey : '')
        }
      >
        <span className="hl-txt" dangerouslySetInnerHTML={{ __html: l.html || '&nbsp;' }} />
        {caret && caret.line === l.i && (
          <span
            key={caret.key}
            className={'caret' + (focused ? ' on' : '')}
            style={{ left: `${caret.x}px`, top: `${caret.top}px`, height: `${caret.height}px`, width: `${CARET_WIDTH}px` }}
          />
        )}
        {l.i === activeLine && preview.formulaCount > 0 && (
          <span className="line-preview" style={{ top: `${-activeLineHeight - 8}px` }}>
            {preview.parts.map((p, i) =>
              p.type === 'math' ? (
                p.html ? (
                  <span key={i} className="math" dangerouslySetInnerHTML={{ __html: p.html }} />
                ) : (
                  <span key={i} className="math-bad">
                    {p.latex}
                  </span>
                )
              ) : (
                <span key={i} className="lp-text">
                  {p.text}
                </span>
              )
            )}
          </span>
        )}
      </div>
    )
  }

  /** 一块里那几行（只有长文件、而且这一块正被看着的时候才走它） */
  const renderChunkRows = (c) => {
    const out = []
    for (let i = c.a; i < c.b; i++) out.push(renderLine(getRow(i)))
    return out
  }

  return (
    <div className="srcwrap">
      <div className={'srcscroll' + (focused ? ' focused' : '') + (diag ? ' diag' : '')} ref={scrollRef}>
        <div className="hl-inner" ref={innerRef}>
          {virtual
            ? chunks.map((c) => {
                /* 看得见 = 浏览器说它在视野里，**或者**光标正在这一块里
                   （那一块随时要量光标、要画高亮，不能是块没着色的原文） */
                const show = c.k === Math.floor(activeLine / CHUNK_ROWS) || !!(visChunks && visChunks.has(c.k))
                /* 看不见的块有两种撑法（见 chunks 里 `wrap` 那段说明）：
                     · 会折行的块 —— 只能把原文交出去，让浏览器排（慢，但高度是准的）；
                     · 不折行的块 —— 行数 × 实测行高，一个空盒子就够，浏览器**不用排它**。 */
                const plain = !show && !c.wrap
                return (
                  <div
                    key={c.k}
                    data-k={c.k}
                    data-wrap={c.wrap ? '1' : '0'}
                    data-rows={c.b - c.a}
                    ref={(el) => {
                      if (el) chunkEls.current.set(c.k, el)
                      else chunkEls.current.delete(c.k)
                    }}
                    /* ★ `.text` 那一档（= 把原文整块交给浏览器排）才需要左右那 3px 的
                       补偿；逐行画的块由每一行自己去补，**块上再补一次行宽就少 6px**，
                       折行点跟着变 —— 两层立刻错开。 */
                    className={'hl-chunk' + (show ? ' rows' : plain ? '' : ' text')}
                    style={plain ? { height: (c.b - c.a) * lineHpx } : undefined}
                  >
                    {show ? renderChunkRows(c) : plain ? null : c.text}
                  </div>
                )
              })
            : lines.map((l) => renderLine(l))}
        </div>

        {/* textarea 自己不滚动：高度由 JS 撑到和内容一样高，滚动交给 .srcscroll */}
        <textarea
          ref={textareaRef}
          className="raw"
          spellCheck={false}
          wrap="soft"
          placeholder={'- 一个节点标题\n  - 公式 | $F = ma$\n  - 用到的量 | [[B]] [[I]]'}
          onInput={(e) => {
            const el = e.currentTarget
            onEdit && onEdit(el.value)
            el.style.height = el.scrollHeight + 'px'
            refreshAll()
          }}
          onKeyUp={(e) => {
            editing.onKeyUp(e)
            refreshAll()
          }}
          onClick={refreshAll}
          onSelect={refreshAll}
          onFocus={() => {
            setFocused(true)
            refreshAll()
          }}
          onBlur={() => {
            setFocused(false)
            setCaret(null)
          }}
        />
      </div>

      <div className="srcfoot">
        <span className="dim small">
          第 {activeLine + 1} / {rowCount} 行
          {active?.kind?.startsWith('h') ? ` · ${active.kind.slice(1)} 级标题` : ''}
          {active?.fieldKey ? ` · 字段「${active.fieldKey}」` : ''}
        </span>
        <span className="dim small">
          公式直接写 <code>$...$</code> · 引用打 <code>[[</code> 有补全 · 点引用胶囊可跳转
        </span>
      </div>
    </div>
  )
}
