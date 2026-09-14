// 光标横向精度终检：把光标依次放在多行的多个位置，逐个比对
// 「光标元素的 left」和「该字符的真实字形左边界（Range 量）」。
// 注意扣掉行盒的左内边距（光标是相对行盒 padding box 定位的）。
//   node scripts/caret-final.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const SET = (line, col) => `
(function(line, col) {
  var ta = document.querySelector('textarea.raw')
  var lines = ta.value.split('\\n')
  line = Math.max(0, Math.min(line, lines.length - 1))
  col = Math.max(0, Math.min(col, lines[line].length))
  var start = 0
  for (var i = 0; i < line; i++) start += lines[i].length + 1
  ta.focus()
  ta.setSelectionRange(start + col, start + col)
  ta.dispatchEvent(new Event('select', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
  return { line: line, col: col, text: lines[line] }
})(${line}, ${col})
`

const CHECK = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var caretEl = document.querySelector('.caret')
  if (!caretEl) return { error: '没有自绘光标' }
  var lineEl = caretEl.closest('.hl-line')
  if (!lineEl) return { error: '光标不在行盒里' }
  var li = Number(lineEl.dataset.i)
  var txtEl = lineEl.querySelector('.hl-txt')
  var lineRect = lineEl.getBoundingClientRect()
  var lcs = getComputedStyle(lineEl)
  var padL = parseFloat(lcs.paddingLeft)

  // 当前光标对应的行内列
  var lines = ta.value.split('\\n')
  var start = 0
  for (var i = 0; i < li; i++) start += lines[i].length + 1
  var col = ta.selectionStart - start

  // 该列字符的真实左边界
  var rectOf = function(at, len) {
    var seen = 0
    var walker = document.createTreeWalker(txtEl, NodeFilter.SHOW_TEXT)
    var n
    while ((n = walker.nextNode())) {
      var L = n.nodeValue.length
      if (seen + L > at) {
        var rg = document.createRange()
        var s2 = at - seen
        rg.setStart(n, s2)
        rg.setEnd(n, Math.min(s2 + len, L))
        var r = rg.getBoundingClientRect()
        return (r.width === 0 && r.height === 0) ? null : r
      }
      seen += L
    }
    return null
  }
  var r = rectOf(col, 1)
  var expectedX = null, expectedTop = null
  if (r) {
    expectedX = r.left - lineRect.left        // 相对行盒 padding box
    expectedTop = r.top - lineRect.top
  } else {
    var last = rectOf(Math.max(0, lines[li].length - 1), 1)
    if (last) { expectedX = last.right - lineRect.left; expectedTop = last.top - lineRect.top }
  }

  var cr = caretEl.getBoundingClientRect()
  var caretX = cr.left - lineRect.left
  var caretTop = cr.top - lineRect.top

  return {
    li: li,
    col: col,
    charAtCol: lines[li][col] || '(行尾)',
    caretX: Math.round(caretX * 100) / 100,
    expectedX: expectedX === null ? null : Math.round(expectedX * 100) / 100,
    deltaX: expectedX === null ? null : Math.round((caretX - expectedX) * 100) / 100,
    caretTop: Math.round(caretTop * 100) / 100,
    expectedTop: expectedTop === null ? null : Math.round(expectedTop * 100) / 100,
    deltaTop: expectedTop === null ? null : Math.round((caretTop - expectedTop) * 100) / 100,
    caretHeight: Math.round(cr.height * 100) / 100,
    charHeight: r ? Math.round(r.height * 100) / 100 : null,
    padL: padL,
    text: lines[li].slice(0, 44),
  }
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

  const cases = [
    [4, 6],
    [5, 20],
    [5, 62],
    [5, 75],
    [19, 5],
    [19, 30],
    [19, 41],
    [20, 40],
    [21, 25],
    [34, 12],
  ]

  console.log('  行   列   字符      光标x      期望x      偏差    光标顶    期望顶    偏差  文本')
  let worst = 0
  let fails = 0
  for (const [line, col] of cases) {
    await ev(SET(line, col))
    await new Promise((r) => setTimeout(r, 260))
    const d = await ev(CHECK)
    if (d.error) {
      console.log(`  ${line}  ${col}  ✗ ${d.error}`)
      fails++
      continue
    }
    const dx = d.deltaX === null ? 999 : d.deltaX
    worst = Math.max(worst, Math.abs(dx))
    const ok = Math.abs(dx) <= 1.5
    if (!ok) fails++
    console.log(
      `  ${String(d.li).padEnd(4)} ${String(d.col).padEnd(4)} ${String(d.charAtCol).padEnd(8)} ${String(d.caretX).padEnd(10)} ${String(d.expectedX).padEnd(10)} ${String(d.deltaX).padEnd(7)} ${String(d.caretTop).padEnd(9)} ${String(d.expectedTop).padEnd(9)} ${String(d.deltaTop).padEnd(6)} ${ok ? '✓' : '✗'} ${d.text}`
    )
  }
  console.log('')
  console.log(`  最大横向偏差 ${Math.round(worst * 100) / 100}px`)
  console.log(fails ? `  ✗ ${fails} 个位置不准` : '  ✓ 所有位置光标都贴在字符边界上')
  ws.close()
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
