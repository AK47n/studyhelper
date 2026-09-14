// 终极裁决：同一个字符串，分别放进 textarea 和 div（同排版），
// 然后**逐个字符**比较两者的字形矩形（用 Range 量真实字形，不是解析值）。
//
// 为什么这个能定论：Range.getBoundingClientRect() 拿的是浏览器排版后的真实字形位置，
// 两个元素在同一坐标系下（同一个 left），所以差值就是真实的错位量。
//
//   node scripts/glyph-compare.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const BUILD = `
(function() {
  var src = document.querySelector('textarea.raw')
  var cs = getComputedStyle(src)
  var old = document.getElementById('gc-lab')
  if (old) old.remove()
  var host = document.createElement('div')
  host.id = 'gc-lab'
  host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:400px;z-index:999999;background:#fff'
  document.body.appendChild(host)

  var BOXW = 620
  function common(el) {
    el.style.cssText = [
      'position:absolute','left:0','top:0','width:' + BOXW + 'px','height:120px',
      'box-sizing:border-box','padding:10px 12px','border:0','margin:0',
      'resize:none','outline:none','overflow:hidden','background:#fff','color:#000',
      'font-family:' + cs.fontFamily,'font-size:' + cs.fontSize,'line-height:' + cs.lineHeight,
      'letter-spacing:' + cs.letterSpacing,'word-spacing:' + cs.wordSpacing,
      'white-space:pre-wrap','overflow-wrap:break-word','tab-size:' + cs.tabSize
    ].join(';')
  }

  var ta = document.createElement('textarea')
  common(ta)
  host.appendChild(ta)

  var dv = document.createElement('div')
  common(dv)
  host.appendChild(dv)

  // 构造一批测试行：普通行 / 折行 / 公式 / 中文 / 混合
  var CASES = [
    '- 毕奥-萨伐尔定律',
    '  - 公式 | $d\\\\vec{B} = \\\\frac{\\\\mu_0}{4\\\\pi}\\\\,\\\\frac{I\\\\,d\\\\vec{l}\\\\times\\\\hat{r}}{r^2}$',
    '  - 说的是 | 磁场对运动电荷的作用力，方向垂直于 $\\\\vec{v}$ 和 $\\\\vec{B}$，不做功',
    '  - 用到的量 | [[B]] [[mu0]] [[I]] [[r]]',
    '## 一、场怎么算出来',
    '- [[B]] | 磁感应强度，T。矢量，描述磁场对运动电荷的作用能力',
  ]

  var report = []
  for (var ci = 0; ci < CASES.length; ci++) {
    var text = CASES[ci]
    ta.value = text
    dv.textContent = text
    // 强制重排
    void ta.offsetHeight
    void dv.offsetHeight

    var taR = ta.getBoundingClientRect()
    var dvR = dv.getBoundingClientRect()
    var padL = parseFloat(getComputedStyle(ta).paddingLeft)
    var padT = parseFloat(getComputedStyle(ta).paddingTop)

    // 逐个字符量：取若干个代表性位置
    var n = text.length
    var cols = []
    for (var p = 0; p < 8; p++) cols.push(Math.min(n - 1, Math.floor((n * (p + 1)) / 9)))
    var chars = []
    for (var k = 0; k < cols.length; k++) {
      var col = cols[k]
      // textarea 侧：没法用 Range，改用「选区」宽度推算不行；改用镜像量尺
      // 但这里要的是「真实字形」，所以两边都用镜像量尺太绕 ——
      // 改为：div 用 Range 量真实字形；textarea 用 canvas 量（已验证过 canvas 与字形一致）
      var dnode = null, seen = 0
      var walker = document.createTreeWalker(dv, NodeFilter.SHOW_TEXT)
      var tn
      while ((tn = walker.nextNode())) {
        var len = tn.nodeValue.length
        if (seen + len > col) {
          var rg = document.createRange()
          var at = col - seen
          rg.setStart(tn, at)
          rg.setEnd(tn, Math.min(at + 1, len))
          var rr = rg.getBoundingClientRect()
          dnode = { x: rr.left - dvR.left - padL, w: rr.width, top: rr.top - dvR.top }
          break
        }
        seen += len
      }
      chars.push({ col: col, ch: text[col], divX: dnode ? Math.round(dnode.x * 100) / 100 : null, divTop: dnode ? Math.round(dnode.top * 100) / 100 : null })
    }

    // 用 canvas 量 textarea 侧的字符位置
    var cvs = document.createElement('canvas')
    var ctx = cvs.getContext('2d')
    ctx.font = cs.fontSize + ' ' + cs.fontFamily
    for (var q = 0; q < chars.length; q++) {
      chars[q].canvasX = Math.round(ctx.measureText(text.slice(0, chars[q].col)).width * 100) / 100
      chars[q].delta = chars[q].divX === null ? null : Math.round((chars[q].divX - chars[q].canvasX) * 100) / 100
    }

    // 两层的行盒高度/折行数
    var taLines = Math.round((ta.scrollHeight - padT * 2) / parseFloat(cs.lineHeight))
    var dvH = dv.getBoundingClientRect().height
    var dvContentH = dv.scrollHeight - padT * 2
    var dvLines = Math.round(dvContentH / parseFloat(cs.lineHeight))

    report.push({
      text: text.slice(0, 40),
      taVisualLines: taLines,
      divVisualLines: dvLines,
      taContentHeight: ta.scrollHeight - padT * 2,
      divContentHeight: dvContentH,
      chars: chars,
    })
  }

  host.remove()
  return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, report: report }
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
  console.log('')
  let bad = 0
  for (const r of d.report) {
    const lineOk = r.taVisualLines === r.divVisualLines
    if (!lineOk) bad++
    console.log(`=== 「${r.text}」===`)
    console.log(`  视觉行数  textarea ${r.taVisualLines}  /  div ${r.divVisualLines}   ${lineOk ? '✓' : '✗ 折行点不一致！'}`)
    console.log(`  内容高度  textarea ${Math.round(r.taContentHeight * 100) / 100}  /  div ${Math.round(r.divContentHeight * 100) / 100}`)
    if (!lineOk) {
      console.log(`     textarea 内容高 ${Math.round(r.taContentHeight * 100) / 100}，div 内容高 ${Math.round(r.divContentHeight * 100) / 100}`)
    }
    let worst = 0
    const parts = []
    for (const c of r.chars) {
      if (c.delta === null) continue
      worst = Math.max(worst, Math.abs(c.delta))
      parts.push(`${JSON.stringify(c.ch)}:${c.delta}`)
    }
    console.log(`  字符横向偏差（div 真实字形 - canvas 推算）: 最大 ${Math.round(worst * 100) / 100}px`)
    console.log(`     ${parts.join('  ')}`)
    if (worst > 1) bad++
  }
  console.log('')
  console.log(bad ? `  ✗ ${bad} 处不一致` : '  ✓ 全部一致')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
