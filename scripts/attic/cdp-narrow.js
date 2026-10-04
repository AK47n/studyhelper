// 窄窗口下的对齐体检：模拟用户的窗口宽度，检查折行点是否一致。
//   node scripts/cdp-narrow.js [宽] [高]
import fs from 'node:fs'
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const W = Number(process.argv[2] ?? 1000)
const H = Number(process.argv[3] ?? 700)

const BUILD = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var cs = getComputedStyle(ta)
  var ics = getComputedStyle(inner)
  var lh = parseFloat(cs.lineHeight)
  var taW = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  var hlW = inner.clientWidth - parseFloat(ics.paddingLeft) - parseFloat(ics.paddingRight)

  // textarea 渲染出多少视觉行？（scrollHeight 减掉上下 padding，再除以行高）
  var padT = parseFloat(cs.paddingTop)
  var padB = parseFloat(cs.paddingBottom)
  var contentH = ta.scrollHeight - padT - padB

  // 着色层：逐行量，统计每行占几个视觉行
  var all = document.querySelectorAll('.hl-line')
  var rows = []
  var hlVisual = 0
  var acc = 0
  for (var i = 0; i < all.length; i++) {
    var el = all[i]
    var r = el.getBoundingClientRect()
    // 这一行的字形实际占几个视觉行（按 rect 的 top 去重）
    var txt = el.querySelector('.hl-txt')
    var range = document.createRange()
    range.selectNodeContents(txt)
    var list = range.getClientRects()
    var tops = {}
    var maxRight = 0
    for (var j = 0; j < list.length; j++) {
      if (list[j].width <= 0.5 || list[j].height <= 0.5) continue
      tops[Math.round(list[j].top)] = 1
      if (list[j].right > maxRight) maxRight = list[j].right
    }
    var geom = Object.keys(tops).length
    var lcs = getComputedStyle(el)
    var lineH = parseFloat(lcs.lineHeight) || lh
    var expectedVisual = Math.max(1, Math.round(r.height / lineH))
    hlVisual += geom
    rows.push({
      i: i,
      text: (el.textContent || '').slice(0, 34),
      fontSize: lcs.fontSize,
      boxH: Math.round(r.height * 100) / 100,
      geomLines: geom,
      expectedVisual: expectedVisual,
      overflowsWidth: maxRight > r.right + 0.5,
      maxRight: Math.round(maxRight * 100) / 100,
      boxRight: Math.round(r.right * 100) / 100,
      mismatch: geom !== expectedVisual,
    })
    acc += r.height
  }
  var bad = rows.filter(function(x) { return x.mismatch })
  return {
    textarea: { contentWidth: taW, visualLinesByScroll: Math.round((contentH / lh) * 100) / 100, scrollHeight: ta.scrollHeight, lineHeight: lh },
    highlight: { contentWidth: hlW, visualLinesByGeom: hlVisual, logicalLines: all.length },
    widthDiff: Math.round((taW - hlW) * 100) / 100,
    mismatchCount: bad.length,
    mismatches: bad.slice(0, 10),
    overflowCount: rows.filter(function(x) { return x.overflowsWidth }).length,
    sample: rows.slice(18, 26),
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
  await new Promise((r) => setTimeout(r, 600))
  await ev(`(function(){ var ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`)
  await new Promise((r) => setTimeout(r, 300))

  const d = await ev(BUILD)
  if (!d || d.error) {
    console.log('✗ ' + ((d && d.error) || '无返回'))
    process.exit(1)
  }

  console.log(`=== ${W}x${H} ===`)
  console.log(`  textarea 文字宽 ${d.textarea.contentWidth}   着色层文字宽 ${d.highlight.contentWidth}   差 ${d.widthDiff}`)
  console.log(`  textarea 视觉行数 ${d.textarea.visualLinesByScroll}   着色层几何行数 ${d.highlight.visualLinesByGeom}   逻辑行数 ${d.highlight.logicalLines}`)
  console.log('')
  if (d.widthDiff !== 0) console.log(`  ✗ 两层文字宽度不一致 ${d.widthDiff}px —— 折行点必然不同`)
  else console.log('  ✓ 两层文字宽度一致')
  if (d.mismatchCount) {
    console.log(`  ✗ 有 ${d.mismatchCount} 行的行盒高度和字形行数对不上（会导致叠字/错位）:`)
    for (const m of d.mismatches) {
      console.log(`      行 ${m.i} 行盒高 ${m.boxH}（应为 ${m.expectedVisual} 视觉行）实际几何行 ${m.geomLines}  「${m.text}」`)
    }
  } else console.log('  ✓ 每行的行盒高度都和字形行数吻合')
  if (d.overflowCount) console.log(`  ✗ 有 ${d.overflowCount} 行文字超出行盒右边界`)
  else console.log('  ✓ 没有文字超出行盒')

  console.log('')
  console.log('  行  字号        行盒高  几何行  应占行  maxRight  行盒右   文本')
  for (const r of d.sample) {
    console.log(
      `  ${String(r.i).padEnd(3)} ${r.fontSize.padEnd(11)} ${String(r.boxH).padEnd(7)} ${String(r.geomLines).padEnd(7)} ${String(r.expectedVisual).padEnd(7)} ${String(r.maxRight).padEnd(9)} ${String(r.boxRight).padEnd(8)} ${r.text}`
    )
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`.cache/shot-narrow-${W}.png`, Buffer.from(shot.data, 'base64'))
  console.log(`\n截图 .cache/shot-narrow-${W}.png`)
  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
