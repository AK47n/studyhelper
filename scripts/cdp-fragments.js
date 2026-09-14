// 折行片段的左边界体检：同一逻辑行折成多个视觉行时，
// 第二行及以后的起点必须 = 第一行起点（都是行盒内容左边界）。
// 只要有偏移，视觉上就是"折下来的字没对齐"。
//   node scripts/cdp-fragments.js [宽] [高]
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const W = Number(process.argv[2] ?? 1000)
const H = Number(process.argv[3] ?? 700)

const BUILD = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var taR = ta.getBoundingClientRect()
  var cs = getComputedStyle(ta)
  var padL = parseFloat(cs.paddingLeft)
  var taContentLeft = taR.left + padL

  var all = document.querySelectorAll('.hl-line')
  var report = []
  for (var i = 0; i < all.length; i++) {
    var el = all[i]
    var r = el.getBoundingClientRect()
    var lcs = getComputedStyle(el)
    var contentLeft = r.left + parseFloat(lcs.paddingLeft)
    var txt = el.querySelector('.hl-txt')
    var range = document.createRange()
    range.selectNodeContents(txt)
    var list = range.getClientRects()
    var rects = []
    for (var j = 0; j < list.length; j++) {
      if (list[j].width > 0.5 && list[j].height > 0.5) rects.push(list[j])
    }
    if (!rects.length) continue
    // 按 top 分组成视觉行
    var groups = {}
    for (var k = 0; k < rects.length; k++) {
      var key = Math.round(rects[k].top)
      if (!groups[key]) groups[key] = { top: rects[k].top, lefts: [], rights: [] }
      groups[key].lefts.push(rects[k].left)
      groups[key].rights.push(rects[k].right)
    }
    var tops = Object.keys(groups).map(Number).sort(function(a, b) { return a - b })
    if (tops.length < 2) continue
    var frags = tops.map(function(t) {
      var g = groups[t]
      return {
        top: Math.round(g.top * 100) / 100,
        left: Math.round(Math.min.apply(null, g.lefts) * 100) / 100,
        right: Math.round(Math.max.apply(null, g.rights) * 100) / 100,
      }
    })
    report.push({
      i: i,
      text: (el.textContent || '').slice(0, 30),
      contentLeft: Math.round(contentLeft * 100) / 100,
      frags: frags,
      // 第二行及以后相对第一行起点的偏移
      deltas: frags.slice(1).map(function(f) { return Math.round((f.left - frags[0].left) * 100) / 100 }),
      maxRight: Math.round(Math.max.apply(null, frags.map(function(f) { return f.right })) * 100) / 100,
      contentRight: Math.round((r.left + r.width - parseFloat(lcs.paddingRight)) * 100) / 100,
    })
  }
  return {
    taContentLeft: Math.round(taContentLeft * 100) / 100,
    wrappedRows: report.length,
    rows: report,
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

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await new Promise((r) => setTimeout(r, 500))
  await ev(`(function(){ var ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`)
  await new Promise((r) => setTimeout(r, 300))
  const d = await ev(BUILD)
  if (!d || d.error) {
    console.log('✗ ' + ((d && d.error) || '无返回'))
    process.exit(1)
  }

  console.log(`=== ${W}x${H}  折行片段检查 ===`)
  console.log(`  textarea 内容盒左边界 ${d.taContentLeft}   折行的逻辑行 ${d.wrappedRows} 个`)
  console.log('')
  let bad = 0
  for (const r of d.rows) {
    const worst = Math.max.apply(null, r.deltas.map(Math.abs))
    if (worst > 1) bad++
    console.log(`  行 ${String(r.i).padEnd(3)} 起点 ${r.contentLeft}  「${r.text}」`)
    for (let i = 0; i < r.frags.length; i++) {
      const f = r.frags[i]
      const delta = i === 0 ? 0 : r.deltas[i - 1]
      console.log(`        视觉行 ${i + 1}: top=${f.top}  left=${f.left}  right=${f.right}  ${i === 0 ? '' : '相对起点偏移 ' + delta + 'px'}  ${f.right > r.contentRight + 0.5 ? '⚠ 超出右边界 ' + r.contentRight : ''}`)
    }
  }
  console.log('')
  console.log(bad ? `  ✗ 有 ${bad} 个折行行的后续片段起点偏移超过 1px` : '  ✓ 所有折行片段的起点都对齐到行盒内容左边界')
  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
