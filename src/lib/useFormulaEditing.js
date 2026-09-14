import { useEffect, useRef, useState } from 'react'

// 插入的片段里用 \u0001 标记"光标停这里"。textarea 里显示成 \t，
// 提交/解析前统一转回 \u0001 —— 见 normalizeMarkers。
export const CURSOR = '\u0001'
export const MARKER_AS_TAB = '\t'

export function normalizeMarkers(s) {
  return String(s ?? '').replace(/\t/g, CURSOR)
}

/** 在光标处插入，返回新文本、新光标位置、所有空位位置 */
export function spliceAt(text, start, end, insert) {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const stops = []
  let built = ''
  for (const ch of insert) {
    if (ch === CURSOR) {
      stops.push(before.length + built.length)
      built += MARKER_AS_TAB
    } else {
      built += ch
    }
  }
  return {
    text: before + built + after,
    cursor: stops.length ? stops[0] : before.length + built.length,
    stops,
  }
}

export function isInsideFormula(text, pos) {
  const before = text.slice(0, pos).replace(/\\\$/g, '')
  return (before.match(/\$/g) || []).length % 2 === 1
}

/** [[ 自动补全上下文 */
export function refContext(text, pos) {
  const before = text.slice(0, pos)
  const m = before.match(/\[\[([^[\]]*)$/)
  if (!m) return null
  return { start: pos - m[0].length, query: m[1] }
}

/**
 * 公式输入的全部交互逻辑。
 * textareaRef 指向"当前正在编辑的那个 textarea"，插入永远发生在它身上。
 */
export function useFormulaEditing({ textareaRef, nodes, onEdit }) {
  const [ac, setAc] = useState(null)
  const stopsRef = useRef([])
  const stopIdxRef = useRef(0)
  const acRef = useRef(null)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const el = () => textareaRef.current

  function commit(text, cursor) {
    const ta = el()
    if (!ta) return
    ta.value = text
    ta.focus()
    try {
      ta.setSelectionRange(cursor, cursor)
      // 让光标可见
      const ratio = cursor / Math.max(1, text.length)
      ta.scrollTop = Math.max(0, ratio * ta.scrollHeight - ta.clientHeight / 2)
    } catch {
      /* ignore */
    }
    onEdit && onEdit()
  }

  function doInsert(raw, { wrapFormula = true } = {}) {
    const ta = el()
    if (!ta) return
    const val = ta.value
    const start = ta.selectionStart ?? val.length
    const end = ta.selectionEnd ?? start
    let insert = raw
    if (wrapFormula && !isInsideFormula(val, start)) insert = `$${raw}$`
    const r = spliceAt(val, start, end, insert)
    stopsRef.current = r.stops
    stopIdxRef.current = 0
    commit(r.text, r.cursor)
  }

  function jumpStop(dir = 1) {
    const stops = stopsRef.current
    const ta = el()
    if (!ta || stops.length < 2) return false
    const next = stopIdxRef.current + dir
    if (next < 0 || next >= stops.length) return false
    stopIdxRef.current = next
    const pos = stops[next]
    ta.focus()
    ta.setSelectionRange(pos, pos)
    return true
  }

  // ---- 唯一一个键盘处理器：window 上监听，只认"当前正在编辑的那个 textarea" ----
  // 之所以合并成一个：Tab 若同时被 React 的 onKeyDown 和 window 监听处理，会跳两次空位。
  const composingRef = useRef(false)

  useEffect(() => {
    function onKeyDown(e) {
      const ta = el()
      if (!ta || e.target !== ta) return

      if (e.key === 'Escape') {
        stopsRef.current = []
        if (acRef.current) {
          acRef.current = null
          setAc(null)
          e.preventDefault()
        }
        return
      }

      // ---- [[ 自动补全面板打开时，方向键 / Enter / Tab 先给它 ----
      const cur = acRef.current
      if (cur && cur.list.length && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const sel = (cur.sel + (e.key === 'ArrowDown' ? 1 : -1) + cur.list.length) % cur.list.length
          acRef.current = { ...cur, sel }
          setAc(acRef.current)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          acceptAutocomplete(cur.list[cur.sel])
          return
        }
      }

      const mod = e.ctrlKey || e.metaKey

      // ---- Tab：先跳公式空位，没有空位就缩进 / 反缩进 ----
      if (e.key === 'Tab' && !mod) {
        e.preventDefault()
        if (!e.shiftKey && jumpStop(1)) return
        const start = ta.selectionStart
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1
        if (e.shiftKey) {
          if (ta.value.slice(lineStart, lineStart + 2) === '  ') {
            commit(ta.value.slice(0, lineStart) + ta.value.slice(lineStart + 2), Math.max(lineStart, start - 2))
          }
        } else {
          commit(ta.value.slice(0, lineStart) + '  ' + ta.value.slice(lineStart), start + 2)
        }
        return
      }

      // ---- Enter：自动续 "- "，保持缩进 ----
      if (e.key === 'Enter' && !mod && !e.shiftKey) {
        const start = ta.selectionStart
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1
        const line = ta.value.slice(lineStart, start)
        const m = line.match(/^(\s*)-\s+/)
        stopsRef.current = []
        if (m) {
          e.preventDefault()
          const nl = ta.value.indexOf('\n', start)
          const end = nl === -1 ? ta.value.length : nl
          const insert = `\n${m[1]}- `
          commit(ta.value.slice(0, start) + insert + ta.value.slice(end), start + insert.length)
        }
        setTimeout(refreshAutocomplete, 0)
        return
      }

      // ---- 打 "-" 后按空格，自动补成 "- " ----
      if (e.key === ' ' && !mod) {
        const start = ta.selectionStart
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1
        if (ta.value.slice(lineStart, start) === '-') {
          e.preventDefault()
          commit(ta.value.slice(0, start) + ' ' + ta.value.slice(start), start + 1)
          return
        }
      }

      if (!mod || e.altKey) {
        if (!e.altKey) setTimeout(refreshAutocomplete, 0)
        return
      }

      // ---- Ctrl 系快捷键 ----
      const k = e.key
      if (k === '/' || k === 'Divide') {
        e.preventDefault()
        doInsert(`\\frac{${CURSOR}}{${CURSOR}}`, { wrapFormula: false })
      } else if (k === '2' || k === '@') {
        e.preventDefault()
        doInsert(`^{${CURSOR}}`, { wrapFormula: false })
      } else if (k === '_') {
        e.preventDefault()
        doInsert(`_{${CURSOR}}`, { wrapFormula: false })
      } else if ((k === 'R' || k === 'r') && e.shiftKey) {
        e.preventDefault()
        doInsert(`\\sqrt{${CURSOR}}`, { wrapFormula: false })
      } else if ((k === 'V' || k === 'v') && e.shiftKey) {
        e.preventDefault()
        doInsert(`\\vec{${CURSOR}}`, { wrapFormula: false })
      }
    }

    // 中文输入法组字期间不要插手，否则会把候选词打断
    function onCompositionStart() {
      composingRef.current = true
    }
    function onCompositionEnd() {
      composingRef.current = false
      setTimeout(refreshAutocomplete, 0)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('compositionstart', onCompositionStart, true)
    window.addEventListener('compositionend', onCompositionEnd, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('compositionstart', onCompositionStart, true)
      window.removeEventListener('compositionend', onCompositionEnd, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- [[ 自动补全 ----
  function refreshAutocomplete() {
    if (composingRef.current) return
    const ta = el()
    if (!ta) return
    const ctx = refContext(ta.value, ta.selectionStart)
    if (!ctx) {
      if (acRef.current) {
        acRef.current = null
        setAc(null)
      }
      return
    }
    const q = ctx.query.trim()
    const list = (nodesRef.current || [])
      .filter((n) => n.title && !n.title.includes('$'))
      .filter((n) => !q || n.title.includes(q) || n.title.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 10)
    acRef.current = { ...ctx, list, sel: 0 }
    setAc(acRef.current)
  }

  function acceptAutocomplete(item) {
    const ta = el()
    const ctx = acRef.current
    if (!ta || !ctx || !item) return
    const insert = `[[${item.title}]]`
    const next = ta.value.slice(0, ctx.start) + insert + ta.value.slice(ta.selectionStart)
    acRef.current = null
    setAc(null)
    commit(next, ctx.start + insert.length)
  }

  function onKeyUp(e) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      refreshAutocomplete()
    }
  }

  function onClick() {
    refreshAutocomplete()
  }

  return {
    ac,
    doInsert,
    onKeyUp,
    onClick,
    acceptAutocomplete,
    refreshAutocomplete,
  }
}
