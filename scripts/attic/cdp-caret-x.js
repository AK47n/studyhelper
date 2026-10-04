// 内容一致性 + 光标横向位置双重校验：
//   1) 着色层每一行的文字，是否和 textarea 里对应行逐字一致
//   2) 光标在同一字符偏移处，位置是否和着色层里那个字形重合
//   node scripts/cdp-caret-x.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const BUILD = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var raw = ta.value.split('\\n')
  var all = document.querySelectorAll('.hl-line')

  // 1) 逐字一致性
  var mismatches = []
  for (var i = 0; i < all.length && i < raw.length; i++) {
    var got = (all[i].textContent || '').replace(/\\u00a0/g, ' ')
    var want = raw[i]
    if (got !== want) {
      var idx = -1
      for (var c = 0; c < Math.max(got.length, want.length); c++) {
        if (got[c] !== want[c]) { idx = c; break }
      }
      mismatches.push({ i: i, at: idx, want: want.slice(0, 40), got: got.slice(0, 40) })
    }
  }

  // 2) 光标横向：在几行上各取一个字符偏移，比较「canvas 推算位置」和「着色层字形位置」
  var taR = ta.getBoundingClientRect()
  var cs = getComputedStyle(ta)
  var padL = parseFloat(cs.paddingLeft)
  var cvs = document.createElement('canvas')
  var ctx = cvs.getContext('2d')

  var rows = [4, 19, 20, 21, 23, 34]
  var checks = []
  var acc = 0
  for (var r = 0; r < all.length; r++) {
    var el = all[r]
    if (rows.indexOf(r) >= 0) {
      var lcs = getComputedStyle(el)
      var fontSize = parseFloat(lcs.fontSize)
      ctx.font = fontSize + 'px ' + cs.fontFamily
      var txtEl = el.querySelector('.hl-txt')
      var lineText = raw[r]
      // 取行内 60% 位置那个字符
      var col = Math.max(1, Math.floor(lineText.length * 0.6))
      var before = lineText.slice(0, col)
      var canvasX = ctx.measureText(before).width

      // 着色层里这个字符的实际位置：用 Range 精确取
      var node = null, seen = 0, found = null
      var walker = document.createTreeWalker(txtEl, NodeFilter.SHOW_TEXT)
      var n
      while ((n = walker.nextNode())) {
        var len = n.nodeValue.length
        if (seen + len >= col) {
          var range = document.createRange()
          var at = col - seen
          range.setStart(n, Math.max(0, Math.min(at, len)))
          range.setEnd(n, Math.max(0, Math.min(at + 1, len)))
          var rr = range.getBoundingClientRect()
          if (rr.width > 0 || rr.height > 0) found = { x: rr.left - el.getBoundingClientRect().left - parseFloat(lcs.paddingLeft), w: rr.width }
          break
        }
        seen += len
      }
      checks.push({
        i: r,
        fontSize: fontSize,
        col: col,
        charAt: lineText[col] || '(行尾)',
        canvasX: Math.round(canvasX * 100) / 100,
        glyphX: found ? Math.round(found.x * 100) / 100 : null,
        delta: found ? Math.round((found.x - canvasX) * 100) / 100 : null,
        text: lineText.slice(0, 34),
      })
    }
    acc += el.getBoundingClientRect().height
  }

  return {
    totalLines: all.length,
    rawLines: raw.length,
    contentMismatches: mismatches,
    checks: checks,
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

  await ev(`(function(){ var ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`)
  await new Promise((r) => setTimeout(r, 300))
  const d = await ev(BUILD)
  if (!d || d.error) {
    console.log('✗ ' + ((d && d.error) || '无返回'))
    process.exit(1)
  }

  console.log('=== 内容一致性 ===')
  console.log(`  着色层 ${d.totalLines} 行 / textarea ${d.rawLines} 行`)
  if (d.contentMismatches.length) {
    console.log(`  ✗ ${d.contentMismatches.length} 行文字对不上：`)
    for (const m of d.contentMismatches.slice(0, 6)) {
      console.log(`      行 ${m.i} 第 ${m.at} 个字符起不同`)
      console.log(`        textarea: ${JSON.stringify(m.want)}`)
      console.log(`        着色层  : ${JSON.stringify(m.got)}`)
    }
  } else console.log('  ✓ 每一行都逐字一致')

  console.log('')
  console.log('=== 光标横向位置 ===')
  console.log('  行   字号        行内位置  该字符   canvas 推算   着色层字形    偏差')
  let worst = 0
  for (const c of d.checks) {
    if (c.delta !== null) worst = Math.max(worst, Math.abs(c.delta))
    console.log(
      `  ${String(c.i).padEnd(4)} ${String(c.fontSize).padEnd(11)} ${String(c.col).padEnd(9)} ${String(c.charAt).padEnd(7)} ${String(c.canvasX).padEnd(13)} ${String(c.glyphX).padEnd(13)} ${c.delta}`
    )
  }
  console.log('')
  console.log(`  最大偏差 ${Math.round(worst * 100) / 100}px  ${worst <= 1 ? '✓ canvas 推算与真实字形一致' : '✗ 不一致，自绘光标会横向错位'}`)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
