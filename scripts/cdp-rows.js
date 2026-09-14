// 逐行体检：把每一行的「文字实际横向范围」「行盒范围」「背景色块范围」「字形纵向范围」都量出来。
// 用来看：底色有没有对齐文字、有没有横向错位、有没有哪一行被压扁。
//   node scripts/cdp-rows.js [起始行] [行数]
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const FROM = Number(process.argv[2] ?? 18)
const N = Number(process.argv[3] ?? 8)

const BUILD = `
(function(from, n) {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var taR = ta.getBoundingClientRect()
  var cs = getComputedStyle(ta)
  var padTop = parseFloat(cs.paddingTop)
  var padL = parseFloat(cs.paddingLeft)
  var raw = ta.value.split('\\n')
  var rows = []
  var acc = 0
  var all = document.querySelectorAll('.hl-line')
  for (var i = 0; i < all.length; i++) {
    var el = all[i]
    var r = el.getBoundingClientRect()
    if (i >= from && i < from + n) {
      var lcs = getComputedStyle(el)
      var txt = el.querySelector('.hl-txt')
      var range = document.createRange()
      range.selectNodeContents(txt)
      var list = range.getClientRects()
      var rects = []
      for (var j = 0; j < list.length; j++) {
        if (list[j].width > 0.5 && list[j].height > 0.5) rects.push(list[j])
      }
      // 文字整体的横向范围
      var textLeft = null, textRight = null, textTop = null, textBottom = null
      for (var k = 0; k < rects.length; k++) {
        if (textLeft === null || rects[k].left < textLeft) textLeft = rects[k].left
        if (textRight === null || rects[k].right > textRight) textRight = rects[k].right
        if (textTop === null || rects[k].top < textTop) textTop = rects[k].top
        if (textBottom === null || rects[k].bottom > textBottom) textBottom = rects[k].bottom
      }
      var taTop = taR.top + padTop + acc - ta.scrollTop
      rows.push({
        i: i,
        cls: el.className,
        text: raw[i].slice(0, 30),
        fontSize: lcs.fontSize,
        bg: lcs.backgroundColor,
        boxH: Math.round(r.height * 100) / 100,
        // 行盒
        boxTopFromTa: Math.round((r.top - taTop) * 100) / 100,
        boxLeft: Math.round(r.left * 100) / 100,
        boxRight: Math.round(r.right * 100) / 100,
        // 文字
        textLeft: textLeft === null ? null : Math.round(textLeft * 100) / 100,
        textRight: textRight === null ? null : Math.round(textRight * 100) / 100,
        textTopInBox: textTop === null ? null : Math.round((textTop - r.top) * 100) / 100,
        textBottomInBox: textBottom === null ? null : Math.round((textBottom - r.top) * 100) / 100,
        // 期望：文字左边界 = textarea 内容盒左边界
        expectTextLeft: Math.round((taR.left + padL) * 100) / 100,
        geomLines: rects.length,
      })
    }
    acc += r.height
  }
  return {
    taContentLeft: Math.round((taR.left + padL) * 100) / 100,
    taScrollTop: ta.scrollTop,
    rows: rows,
  }
})(${FROM}, ${N})
`

async function main() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可调试页面')
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
  await new Promise((r) => setTimeout(r, 250))
  const d = await ev(BUILD)
  if (!d || d.error) {
    console.log('✗ ' + ((d && d.error) || '无返回'))
    process.exit(1)
  }

  console.log(`textarea 内容盒左边 = ${d.taContentLeft}   scrollTop = ${d.taScrollTop}`)
  console.log('')
  console.log('  行  字号        行盒高  几何行  文字左    期望左   左偏差  文字右    行盒右   文字顶  文字底  文本')
  let bad = 0
  for (const r of d.rows) {
    const dLeft = r.textLeft === null ? null : Math.round((r.textLeft - r.expectTextLeft) * 100) / 100
    if (dLeft !== null && Math.abs(dLeft) > 1) bad++
    console.log(
      `  ${String(r.i).padEnd(3)} ${r.fontSize.padEnd(11)} ${String(r.boxH).padEnd(7)} ${String(r.geomLines).padEnd(7)} ${String(r.textLeft).padEnd(9)} ${String(r.expectTextLeft).padEnd(8)} ${String(dLeft).padEnd(7)} ${String(r.textRight).padEnd(9)} ${String(r.boxRight).padEnd(8)} ${String(r.textTopInBox).padEnd(7)} ${String(r.textBottomInBox).padEnd(7)} ${r.text}`
    )
  }
  console.log('')
  console.log(bad ? `  ✗ 有 ${bad} 行文字左边界偏离 textarea 内容盒左边界` : '  ✓ 所有行文字左边界都与 textarea 内容盒对齐')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
