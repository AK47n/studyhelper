// 光标横向精度（修正版）：只在**同一视觉行**里比较光标位置和字符区间。
// 上一版拿第一视觉行的字符区间去比第二视觉行的光标，必然报错位。
//   node scripts/caret-h.js [行号] [行内第几个字符]
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const LINE_ARG = process.argv[2] ? Number(process.argv[2]) : null
const COL_ARG = process.argv[3] ? Number(process.argv[3]) : null

const BUILD = `
(function(lineArg, colArg) {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var raw = ta.value.split('\\n')

  var line = lineArg
  if (line === null) {
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].length > 30 && raw[i].indexOf('#') !== 0) { line = i; break }
    }
  }
  if (line < 0 || line >= raw.length) return { error: '行号无效' }
  var lineStart = 0
  for (var k = 0; k < line; k++) lineStart += raw[k].length + 1

  var col = colArg
  if (col === null) col = Math.max(1, Math.min(raw[line].length - 1, Math.round(raw[line].length * 0.8)))
  col = Math.min(col, raw[line].length)

  ta.focus()
  ta.setSelectionRange(lineStart + col, lineStart + col)
  ta.dispatchEvent(new Event('select', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))

  var lineEl = document.querySelector('.hl-line[data-i="' + line + '"]')
  if (!lineEl) return { error: '找不到 .hl-line' }
  var caretEl = lineEl.querySelector('.caret')
  var txtEl = lineEl.querySelector('.hl-txt')
  var lineRect = lineEl.getBoundingClientRect()

  // 逐字符量，带上 top 以便按视觉行分组
  var chars = []
  var walker = document.createTreeWalker(txtEl, NodeFilter.SHOW_TEXT)
  var n, seen = 0
  while ((n = walker.nextNode())) {
    var len = n.nodeValue.length
    for (var c = 0; c < len; c++) {
      var rg = document.createRange()
      rg.setStart(n, c)
      rg.setEnd(n, c + 1)
      var rr = rg.getBoundingClientRect()
      if (rr.width === 0 && rr.height === 0) continue
      chars.push({
        idx: seen + c,
        ch: n.nodeValue[c],
        left: Math.round((rr.left - lineRect.left) * 100) / 100,
        right: Math.round((rr.right - lineRect.left) * 100) / 100,
        top: Math.round((rr.top - lineRect.top) * 100) / 100,
      })
    }
    seen += len
  }

  if (!caretEl) return { error: '没有自绘光标（可能没聚焦）', line: line, col: col, text: raw[line] }
  var cr = caretEl.getBoundingClientRect()
  var caret = {
    left: Math.round((cr.left - lineRect.left) * 100) / 100,
    top: Math.round((cr.top - lineRect.top) * 100) / 100,
    h: Math.round(cr.height * 100) / 100,
  }

  // 按视觉行分组（top 相近归一组）
  var groups = []
  chars.forEach(function(c) {
    var g = groups.filter(function(x) { return Math.abs(x.top - c.top) < 4 })[0]
    if (!g) { g = { top: c.top, items: [] }; groups.push(g) }
    g.items.push(c)
  })
  groups.sort(function(a, b) { return a.top - b.top })
  groups.forEach(function(g) { g.items.sort(function(a, b) { return a.left - b.left }) })

  // 光标属于哪个视觉行
  var caretGroup = groups.filter(function(g) { return Math.abs(g.top - caret.top) < g.items[0] ? false : Math.abs(g.top - caret.top) < 20 })[0]
  if (!caretGroup) {
    var best = null
    groups.forEach(function(g) { var d = Math.abs(g.top - caret.top); if (best === null || d < best) { best = d; caretGroup = g } })
  }

  // 目标字符所在视觉行
  var targetGroup = null
  var target = null
  groups.forEach(function(g) {
    g.items.forEach(function(c) { if (c.idx === col) { targetGroup = g; target = c } })
  })

  return {
    line: line,
    col: col,
    text: raw[line],
    caret: caret,
    visualLines: groups.length,
    caretVisualLine: groups.indexOf(caretGroup),
    targetVisualLine: targetGroup ? groups.indexOf(targetGroup) : null,
    sameVisualLine: caretGroup === targetGroup,
    expectedLeft: target ? target.left : null,
    deltaX: target ? Math.round((caret.left - target.left) * 100) / 100 : null,
    // 光标在它所在视觉行里，落在哪个字符区间内
    landing: (function() {
      if (!caretGroup) return null
      for (var i = 0; i < caretGroup.items.length; i++) {
        var c = caretGroup.items[i]
        if (caret.left > c.left + 0.6 && caret.left < c.right - 0.6) {
          return { idx: c.idx, ch: c.ch, left: c.left, right: c.right, width: Math.round((c.right - c.left) * 100) / 100, into: Math.round((caret.left - c.left) * 100) / 100 }
        }
      }
      return null
    })(),
    caretGroupChars: caretGroup ? caretGroup.items.map(function(c) { return '#' + c.idx + '「' + c.ch + '」[' + c.left + ',' + c.right + ']' }) : [],
  }
})(${LINE_ARG === null ? 'null' : LINE_ARG}, ${COL_ARG === null ? 'null' : COL_ARG})
`

async function main() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, { res, rej })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text)
    return r.result && r.result.value
  }

  await ev(BUILD)
  await new Promise((r) => setTimeout(r, 350))
  const d = await ev(BUILD)
  if (d.error) {
    console.log('✗ ' + d.error)
    if (d.text) console.log(`  行 ${d.line} 列 ${d.col}：「${d.text}」`)
    process.exit(1)
  }

  console.log(`=== 光标横向精度（同一视觉行内比较）===`)
  console.log(`  行 ${d.line}：「${d.text.slice(0, 60)}」`)
  console.log(`  行内第 ${d.col} 个位置（应在第 ${d.col + 1} 个字符左侧）`)
  console.log(`  该行有 ${d.visualLines} 个视觉行；光标在第 ${d.caretVisualLine} 个；目标字符在第 ${d.targetVisualLine} 个`)
  console.log('')
  console.log(`  光标 x = ${d.caret.left}（相对行盒）   y = ${d.caret.top}   高 ${d.caret.h}`)
  console.log(`  期望 x = ${d.expectedLeft}`)
  console.log(`  偏差   = ${d.deltaX}px`)
  console.log('')
  if (d.landing) {
    console.log(`  ✗ 光标插在第 ${d.landing.idx} 个字符「${d.landing.ch}」内部（区间 [${d.landing.left}, ${d.landing.right}]，宽 ${d.landing.width}，偏左 ${d.landing.into}px）`)
  } else {
    console.log('  ✓ 光标落在字符边界上（没有插进字符内部）')
  }
  const ok = !d.landing && d.deltaX !== null && Math.abs(d.deltaX) <= 1.5 && d.sameVisualLine
  console.log('')
  console.log('  光标所在视觉行的字符（最多列 14 个）:')
  for (const s of d.caretGroupChars.slice(0, 14)) console.log('    ' + s)
  console.log('')
  console.log(ok ? '  ✓ 横向位置正确' : '  ✗ 横向位置不对')
  ws.close()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
