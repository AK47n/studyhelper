// 把 caretPoint 暴露到页面，用同一组参数直接调它，看返回值。
// 同时打印它内部的中间量（availW、视觉行数、cells 长度）。
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const EXPOSE = `
(function() {
  // 从模块里拿不到 caretPoint，所以在这里复刻一份同样的算法做对照
  window.__probeCaret = function(lineIdx, col) {
    var ta = document.querySelector('textarea.raw')
    var cs = getComputedStyle(ta)
    var baseFont = parseFloat(cs.fontSize)
    var fontFamily = cs.fontFamily
    var lines = ta.value.split('\\n')
    var text = lines[lineIdx]
    var availW = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    var cvs = document.createElement('canvas')
    var ctx = cvs.getContext('2d')
    ctx.font = baseFont + 'px ' + fontFamily

    var LH = 1.95
    var cells = []
    var x = 0, line = 0
    for (var i = 0; i < text.length; ) {
      var cp = text.codePointAt(i)
      var ch = String.fromCodePoint(cp)
      var step = cp > 0xffff ? 2 : 1
      var w = ctx.measureText(ch).width
      if (x > 0 && x + w > availW + 1e-6) {
        cells.push({ start: i, end: i, line: line + 1, x: 0, w: 0, ch: '' })
        line += 1
        x = 0
      }
      cells.push({ start: i, end: i + step, line: line, x: x, w: w, ch: ch })
      x += w
      i += step
    }

    // caretPoint 的逻辑
    var found = null
    for (var k = 0; k < cells.length; k++) {
      var c = cells[k]
      if (c.end > c.start && col >= c.start && col < c.end) { found = c; break }
      if (c.end === c.start && col === c.start) { found = c; break }
    }
    if (!found) {
      var last = cells[cells.length - 1]
      found = last ? { line: last.line, x: last.x + last.w, ch: '(行尾)' } : { line: 0, x: 0, ch: '(空)' }
    }

    return {
      lineIdx: lineIdx,
      col: col,
      text: text.slice(0, 70),
      baseFont: baseFont,
      availW: availW,
      textLen: text.length,
      cellsLen: cells.length,
      totalVisualLines: cells.length ? Math.max.apply(null, cells.map(function(c) { return c.line })) + 1 : 0,
      cellsPerVisualLine: (function() {
        var m = {}
        cells.forEach(function(c) { if (c.end > c.start) m[c.line] = (m[c.line] || 0) + 1 })
        return m
      })(),
      found: { line: found.line, x: Math.round(found.x * 100) / 100, ch: found.ch },
      // 实测：该列字符在 DOM 里的左边界（相对行盒 padding box）
      domExpected: (function() {
        var lineEl = document.querySelector('.hl-line[data-i="' + lineIdx + '"]')
        if (!lineEl) return null
        var txtEl = lineEl.querySelector('.hl-txt')
        var lineRect = lineEl.getBoundingClientRect()
        var walker = document.createTreeWalker(txtEl, NodeFilter.SHOW_TEXT)
        var n, seen = 0
        while ((n = walker.nextNode())) {
          var len = n.nodeValue.length
          if (seen + len > col) {
            var rg = document.createRange()
            var at = col - seen
            rg.setStart(n, at)
            rg.setEnd(n, Math.min(at + 1, len))
            var rr = rg.getBoundingClientRect()
            return {
              x: Math.round((rr.left - lineRect.left) * 100) / 100,
              visualLine: (function() {
                // 该字符属于第几个视觉行：按 top 去重排序
                var rg2 = document.createRange()
                rg2.selectNodeContents(txtEl)
                var rects = rg2.getClientRects()
                var tops = {}
                for (var q = 0; q < rects.length; q++) if (rects[q].width > 0.5) tops[Math.round(rects[q].top)] = 1
                var keys = Object.keys(tops).map(Number).sort(function(a, b) { return a - b })
                return keys.indexOf(Math.round(rr.top))
              })(),
            }
          }
          seen += len
        }
        return null
      })(),
    }
  }
  return 'ok'
})()
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

  console.log(await ev(EXPOSE))
  for (const [line, col] of [[19, 30], [5, 62], [19, 20], [34, 20]]) {
    const out = await ev(`JSON.stringify(window.__probeCaret(${line}, ${col}), null, 2)`)
    console.log('')
    console.log('=== 行 ' + line + ' 列 ' + col + ' ===')
    console.log(out)
  }
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
