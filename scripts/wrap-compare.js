// 折行点对比（精确版）：同一段文本，textarea 需要几个视觉行？div 需要几个？
// 上次的统计被元素高度裁切污染了，这次用 scrollHeight（不受裁切影响）。
//   node scripts/wrap-compare.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const BUILD = `
(function() {
  var src = document.querySelector('textarea.raw')
  var cs = getComputedStyle(src)
  var old = document.getElementById('wc-lab')
  if (old) old.remove()
  var host = document.createElement('div')
  host.id = 'wc-lab'
  // 故意不给高度限制，让内容自由撑开
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;background:#fff'
  document.body.appendChild(host)

  var BOXW = 620
  function common(el) {
    el.style.cssText = [
      'position:static','width:' + BOXW + 'px','height:auto','min-height:0','max-height:none',
      'box-sizing:border-box','padding:0','border:0','margin:0','resize:none','outline:none',
      'overflow:visible','background:#fff','color:#000',
      'font-family:' + cs.fontFamily,'font-size:' + cs.fontSize,'line-height:' + cs.lineHeight,
      'letter-spacing:' + cs.letterSpacing,'word-spacing:' + cs.wordSpacing,
      'white-space:' + cs.whiteSpace,'overflow-wrap:' + cs.overflowWrap,'word-break:' + cs.wordBreak,
      'tab-size:' + cs.tabSize
    ].join(';')
  }

  var CASES = [
    { name: '普通中文行', text: '- 毕奥-萨伐尔定律' },
    { name: '公式行（长）', text: '  - 公式 | $d\\\\vec{B} = \\\\frac{\\\\mu_0}{4\\\\pi}\\\\,\\\\frac{I\\\\,d\\\\vec{l}\\\\times\\\\hat{r}}{r^2}$' },
    { name: '中文+公式混排', text: '  - 说的是 | 磁场对运动电荷的作用力，方向垂直于 $\\\\vec{v}$ 和 $\\\\vec{B}$，不做功' },
    { name: '引用行', text: '  - 用到的量 | [[B]] [[mu0]] [[I]] [[r]]' },
    { name: '纯 ASCII 长行', text: '- aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh' },
    { name: '含反斜杠', text: '- 反斜杠测试 \\\\vec{a} \\\\frac{1}{2} \\\\times \\\\hat{r} \\\\mu_0 \\\\partial \\\\nabla' },
    { name: '含 $ 符号', text: '- 美元符 $a$ 和 $b$ 和 $c$ 和 $d$ 和 $e$ 和 $f$ 和 $g$ 和 $h$ 和 $i$ 和 $j$ 和 $k$' },
  ]

  var report = []
  for (var ci = 0; ci < CASES.length; ci++) {
    var text = CASES[ci].text
    var ta = document.createElement('textarea')
    common(ta)
    ta.rows = 1
    ta.value = text
    host.appendChild(ta)
    var dv = document.createElement('div')
    common(dv)
    dv.textContent = text
    host.appendChild(dv)

    void ta.offsetHeight
    void dv.offsetHeight

    var lh = parseFloat(getComputedStyle(ta).lineHeight)
    var taSH = ta.scrollHeight
    var taH = ta.getBoundingClientRect().height
    var dvSH = dv.scrollHeight
    var dvH = dv.getBoundingClientRect().height

    // div 的视觉行数：用 Range 数不同的 top
    var rg = document.createRange()
    rg.selectNodeContents(dv)
    var rects = rg.getClientRects()
    var tops = {}
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].width > 0.5 && rects[i].height > 0.5) tops[Math.round(rects[i].top)] = 1
    }
    var dvVisual = Object.keys(tops).length

    report.push({
      name: CASES[ci].name,
      text: text.slice(0, 44),
      chars: text.length,
      lineHeight: lh,
      taScrollHeight: taSH,
      taHeight: Math.round(taH * 100) / 100,
      taLines: Math.round((taSH / lh) * 100) / 100,
      dvScrollHeight: dvSH,
      dvHeight: Math.round(dvH * 100) / 100,
      dvLines: Math.round((dvSH / lh) * 100) / 100,
      dvVisualByRange: dvVisual,
      match: Math.abs(taSH - dvSH) < 1.5,
    })
    host.removeChild(ta)
    host.removeChild(dv)
  }
  host.remove()
  return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak, report: report }
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
  console.log(`字号 ${d.fontSize}  行高 ${d.lineHeight}`)
  console.log(`white-space: ${d.whiteSpace}   overflow-wrap: ${d.overflowWrap}   word-break: ${d.wordBreak}`)
  console.log('')
  console.log('  用例             字符数  行高     textarea高  div高    行数(ta/div)      一致')
  let bad = 0
  for (const r of d.report) {
    if (!r.match) bad++
    console.log(
      `  ${r.name.padEnd(16)} ${String(r.chars).padEnd(7)} ${String(r.lineHeight).padEnd(7)} ${String(r.taScrollHeight).padEnd(11)} ${String(r.dvScrollHeight).padEnd(8)} ${(r.taLines + ' / ' + r.dvLines).padEnd(17)} ${r.match ? '✓' : '✗ 折行点不同！'}`
    )
    if (!r.match) {
      console.log(`      文本框高 ${r.taHeight}  div高 ${r.dvHeight}  div 按 Range 数出 ${r.dvVisualByRange} 个视觉行`)
      console.log(`      文本: ${r.text}`)
    }
  }
  console.log('')
  console.log(bad ? `  ✗ ${bad} 个用例折行点不一致` : '  ✓ 所有用例折行点一致')

  // 手工用 canvas 算每个用例在 620px 下的宽度，验证是否该折
  console.log('')
  console.log('=== 参考：用 canvas 算各用例的整行宽度（620px 容器）===')
  const widths = await ev(`
  (function() {
    var src = document.querySelector('textarea.raw')
    var cs = getComputedStyle(src)
    var cvs = document.createElement('canvas')
    var ctx = cvs.getContext('2d')
    ctx.font = cs.fontSize + ' ' + cs.fontFamily
    var cases = ${JSON.stringify(d.report.map((r) => r.text))}
    var out = []
    for (var i = 0; i < cases.length; i++) {
      out.push(Math.round(ctx.measureText(cases[i]).width * 100) / 100)
    }
    return out
  })()`)
  d.report.forEach((r, i) => {
    const w = widths[i]
    console.log(`  ${r.name.padEnd(16)} 整行宽 ${String(w).padEnd(9)} → 需要 ${Math.max(1, Math.ceil(w / 620))} 行左右`)
  })
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
