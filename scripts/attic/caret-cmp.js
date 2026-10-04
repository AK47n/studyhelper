// 一次读全：当前 selectionStart、光标元素的实际 left、以及按算法算出的应有 left。
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const EXPR = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var cs = getComputedStyle(ta)
  var baseFont = parseFloat(cs.fontSize)
  var fontFamily = cs.fontFamily
  var lines = ta.value.split('\\n')

  // 当前光标在哪
  var s = ta.selectionStart
  var acc = 0, li = 0, col = 0
  for (var i = 0; i < lines.length; i++) {
    if (s <= acc + lines[i].length) { li = i; col = s - acc; break }
    acc += lines[i].length + 1
  }

  // 算法算出应有的 x
  var availW = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  var cvs = document.createElement('canvas')
  var ctx = cvs.getContext('2d')
  ctx.font = baseFont + 'px ' + fontFamily
  var text = lines[li]
  var cells = [], x = 0, vline = 0
  for (var j = 0; j < text.length; ) {
    var cp = text.codePointAt(j)
    var ch = String.fromCodePoint(cp)
    var step = cp > 0xffff ? 2 : 1
    var w = ctx.measureText(ch).width
    if (x > 0 && x + w > availW + 1e-6) { cells.push({ start: j, end: j, line: vline + 1, x: 0 }); vline++; x = 0 }
    cells.push({ start: j, end: j + step, line: vline, x: x, w: w, ch: ch })
    x += w
    j += step
  }
  var found = null
  for (var k = 0; k < cells.length; k++) {
    var c = cells[k]
    if (c.end > c.start && col >= c.start && col < c.end) { found = c; break }
    if (c.end === c.start && col === c.start) { found = c; break }
  }
  var expectedX = found ? found.x : (cells.length ? cells[cells.length - 1].x + cells[cells.length - 1].w : 0)
  var expectedVLine = found ? found.line : 0

  var caretEl = document.querySelector('.caret')
  return JSON.stringify({
    selectionStart: s,
    computedLine: li,
    computedCol: col,
    caretEl: caretEl ? {
      left: caretEl.style.left,
      top: caretEl.style.top,
      height: caretEl.style.height,
      key: caretEl.getAttribute('key') || null,
      display: getComputedStyle(caretEl).display,
    } : null,
    algorithm: {
      availW: availW,
      expectedX: Math.round(expectedX * 100) / 100,
      expectedVLine: expectedVLine,
      charAtCol: text[col] || '(行尾)',
    },
    delta: caretEl ? Math.round((parseFloat(caretEl.style.left) - expectedX) * 100) / 100 : null,
    // 光标元素所在的行
    caretLineIdx: (function() {
      var el = caretEl
      while (el && !el.dataset.i) el = el.parentElement
      return el ? Number(el.dataset.i) : null
    })(),
  }, null, 2)
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

  for (const [line, col] of [[19, 30], [5, 62], [34, 20], [4, 8]]) {
    await ev(`(function(){
      var ta = document.querySelector('textarea.raw')
      var lines = ta.value.split('\\n')
      var start = 0
      for (var i = 0; i < ${line}; i++) start += lines[i].length + 1
      ta.focus()
      ta.setSelectionRange(start + ${col}, start + ${col})
      ta.dispatchEvent(new Event('select', { bubbles: true }))
      ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
      return 1 })()`)
    await new Promise((r) => setTimeout(r, 300))
    console.log('=== 设置到 行' + line + ' 列' + col + ' ===')
    console.log(await ev(EXPR))
    console.log('')
  }
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
