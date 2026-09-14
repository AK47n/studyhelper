// 定位 71px 总高差的来源：分别数出两层各有多少视觉行。
// textarea 没法直接数行，所以用「镜像 div」逐行量：把每一条逻辑行单独放进
// 一个和 textarea 同参数的 div，量它占几个视觉行；再和着色层逐行比对。
//   node scripts/linecount.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const BUILD = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var cs = getComputedStyle(ta)
  var raw = ta.value.split('\\n')
  var all = document.querySelectorAll('.hl-line')

  // 量尺：和 textarea 同参数，宽度也相同
  var ruler = document.createElement('div')
  ruler.style.cssText = [
    'position:fixed','left:0','top:0','visibility:hidden','pointer-events:none','z-index:-1',
    'width:' + ta.getBoundingClientRect().width + 'px',
    'box-sizing:' + cs.boxSizing,
    'padding:' + cs.paddingLeft + ' ' + cs.paddingRight,
    'margin:0','border:0',
    'font-family:' + cs.fontFamily,'font-size:' + cs.fontSize,'font-weight:' + cs.fontWeight,
    'line-height:' + cs.lineHeight,
    'letter-spacing:' + cs.letterSpacing,'word-spacing:' + cs.wordSpacing,
    'white-space:' + cs.whiteSpace,'overflow-wrap:' + cs.overflowWrap,'word-break:' + cs.wordBreak,
    'tab-size:' + cs.tabSize
  ].join(';')
  ruler.textContent = '\\u0001'
  document.body.appendChild(ruler)
  var rulerW = ruler.getBoundingClientRect().width
  var padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight)
  var contentW = rulerW - padL - padR

  // 逐逻辑行：用 Range 数量尺里那条文本占几个几何行
  var rows = []
  var totalVisual = 0
  for (var i = 0; i < raw.length; i++) {
    ruler.textContent = raw[i] || '\\u0001'
    var rg = document.createRange()
    rg.selectNodeContents(ruler)
    var rects = rg.getClientRects()
    var tops = {}
    for (var j = 0; j < rects.length; j++) {
      if (rects[j].width > 0.5 && rects[j].height > 0.5) tops[Math.round(rects[j].top)] = 1
    }
    var visual = Object.keys(tops).length || 1
    totalVisual += visual

    // 着色层同一行：按行盒高度推算视觉行数
    var el = all[i]
    var lh = el ? parseFloat(getComputedStyle(el).lineHeight) : parseFloat(cs.lineHeight)
    var boxH = el ? el.getBoundingClientRect().height : 0
    var hlVisual = lh ? Math.round(boxH / lh) : 0
    rows.push({
      i: i,
      text: raw[i].slice(0, 30),
      fontSize: el ? getComputedStyle(el).fontSize : null,
      lineHeight: lh,
      hlVisual: hlVisual,
      hlBoxH: Math.round(boxH * 100) / 100,
      rulerVisual: visual,
      match: hlVisual === visual,
    })
  }
  ruler.remove()

  var hlTotalVisual = rows.reduce(function(a, r) { return a + r.hlVisual }, 0)
  return {
    logicalLines: raw.length,
    contentWidth: contentW,
    textareaVisualLines: totalVisual,
    highlightVisualLines: hlTotalVisual,
    taContentHeight: ta.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    mismatchCount: rows.filter(function(r) { return !r.match }).length,
    mismatches: rows.filter(function(r) { return !r.match }).slice(0, 12),
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

  const d = await ev(BUILD)
  if (d.error) {
    console.log('✗ ' + d.error)
    process.exit(1)
  }
  console.log(`  逻辑行 ${d.logicalLines}   内容宽 ${d.contentWidth}`)
  console.log(`  按 textarea 参数数出的视觉行 ${d.textareaVisualLines}`)
  console.log(`  着色层行盒数出的视觉行     ${d.highlightVisualLines}`)
  console.log(`  差 ${d.highlightVisualLines - d.textareaVisualLines} 行`)
  console.log(`  textarea 内容高 ${Math.round(d.taContentHeight * 100) / 100}`)
  console.log('')
  if (d.mismatchCount) {
    console.log(`  ✗ ${d.mismatchCount} 行的视觉行数对不上:`)
    console.log('     行   字号        行高     着色层(行数/高)   文本框(行数)   文本')
    for (const m of d.mismatches) {
      console.log(
        `     ${String(m.i).padEnd(4)} ${String(m.fontSize).padEnd(11)} ${String(Math.round(m.lineHeight * 100) / 100).padEnd(8)} ${(m.hlVisual + ' / ' + m.hlBoxH).padEnd(17)} ${String(m.rulerVisual).padEnd(14)} ${m.text}`
      )
    }
  } else {
    console.log('  ✓ 每一行的视觉行数都一致')
  }
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
