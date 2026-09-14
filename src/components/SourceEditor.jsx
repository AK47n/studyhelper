import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
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
      let html = null
      try {
        html = katex.renderToString(latex, { throwOnError: false, displayMode: false, output: 'html' })
      } catch {
        html = null
      }
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

  const lines = useMemo(() => buildLines(text ?? ''), [text])

  const baseFont = useMemo(() => {
    const el = textareaRef.current
    if (!el) return 19.4
    const v = parseFloat(window.getComputedStyle(el).fontSize)
    return Number.isFinite(v) ? v : 19.4
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, fontSizePx, textareaRef])

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
    const ls = buildLines(el.value)
    setActiveLine(lineIndexAt(ls, el.selectionStart ?? 0))
  }, [textareaRef])

  /* ---- 自绘光标（接管所有行）----
     为什么不用原生光标：textarea 只有一个字号，浏览器画的原生光标也只按这个字号
     算高度和纵向位置。实测（scripts/caret-shot.js）：
       正文 19.375px → 原生光标高 23、顶在内容盒下 8px（对）
       标题 29.06px  → 原生光标仍高 34、顶在 2px，而标题字形顶在 11px（差约 9px）
     textarea 的字形本来就被着色层盖住了，所以干脆连光标也自己画：
     高度取该行字体的 content area，纵向居中在行盒里，横向用 canvas 量。 */
  const measureCtx = useRef(null)

  /** textarea 内容的可用宽度（= 它 clientWidth 减左右内边距）。折行模拟要用。 */
  const availWidth = useCallback(() => {
    const el = textareaRef.current
    if (!el) return 0
    const cs = window.getComputedStyle(el)
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  }, [textareaRef])

  /* 自绘光标的横向位置：**用 Range 量真实字形**，不做任何宽度推算。

     三次踩坑，都是"用假设代替测量"：
       1. 按「行首到光标的整段宽度」当 x  → 折行后偏出一整行（实测 -51px）
       2. 按 baseFont × fontScale 算字宽  → 恒定偏大约 1.2 倍（实测 -46.6px）
       3. 用块级测量元素量宽度            → 块级宽度恒等于行宽（699px）
     现在：在渲染出来的文本节点里定位第 col 个字符，用 Range 拿它的真实字形矩形，
     光标的 x 就是该字符左边界、纵向就是该字符所在的视觉行。
     和文字同一个坐标系，零假设。 */
  const measureCaretX = useCallback((lineIdx, colInRow) => {
    const lineEl = document.querySelector(`.hl-line[data-i="${lineIdx}"]`)
    const row = lines[lineIdx]
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
  }, [baseFont, lines])

  const updateCaret = useCallback(() => {
    const el = textareaRef.current
    if (!el || document.activeElement !== el || el.selectionStart !== el.selectionEnd) {
      setCaret(null)
      return
    }
    const ls = buildLines(el.value)
    const li = lineIndexAt(ls, el.selectionStart ?? 0)
    const row = ls[li]
    if (!row) {
      setCaret(null)
      return
    }
    const col = Math.max(0, (el.selectionStart ?? 0) - row.start)
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
  }, [lines, fontSizePx, fontRatios, updateCaret])

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
  }, [lines, fontSizePx, fitHeight])

  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fitHeight())
    ro.observe(el)
    if (innerRef.current) ro.observe(innerRef.current)
    return () => ro.disconnect()
  }, [fitHeight, textareaRef])

  // 外部请求跳行
  useEffect(() => {
    if (!jumpRef) return
    jumpRef.current = (line) => {
      const el = textareaRef.current
      if (!el) return
      const ls = buildLines(el.value)
      const target = ls[Math.max(0, Math.min(line, ls.length - 1))]
      if (!target) return
      const end = target.start + target.text.length
      el.focus()
      el.setSelectionRange(target.start, end)
      setActiveLine(target.i)
      onSelectNode && onSelectNode(target.i)
      // 滚动容器里把这行带到中间
      const rowEl = document.querySelector(`.hl-line[data-i="${target.i}"]`)
      const sc = scrollRef.current
      if (rowEl && sc) {
        const sRect = sc.getBoundingClientRect()
        const rRect = rowEl.getBoundingClientRect()
        sc.scrollTop += rRect.top - sRect.top - (sc.clientHeight - rRect.height) / 2
      }
      updateCaret()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, onSelectNode, updateCaret])

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
      const row = rowEl ? lines[Number(rowEl.dataset.i)] : null
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

  const active = lines[activeLine]
  const preview = useMemo(() => (active ? linePreview(active.text) : { parts: [], formulaCount: 0 }), [active])
  const activeLineHeight = activeLine === undefined ? baseFont * LH_MULT : lineHeightOf(activeLine)

  // 光标移动时把它带进视野（自绘光标 + 原生都不越界）
  useEffect(() => {
    if (!focused) return
    const rowEl = document.querySelector(`.hl-line[data-i="${activeLine}"]`)
    revealInScroller(scrollRef.current, rowEl)
  }, [activeLine, focused, caret?.key])

  return (
    <div className="srcwrap">
      <div className={'srcscroll' + (focused ? ' focused' : '') + (diag ? ' diag' : '')} ref={scrollRef}>
        <div className="hl-inner" ref={innerRef}>
          {lines.map((l) => (
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
          ))}
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
          第 {activeLine + 1} / {lines.length} 行
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
