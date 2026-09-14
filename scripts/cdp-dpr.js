// 高分屏扫描：不同 deviceScaleFactor（Windows 缩放 100%/125%/150%/200%）下，
// 两层的内容宽度、折行点、以及光标横向位置是否仍然一致。
// subpixel 取整在非整数缩放时最容易翻车。
//   node scripts/cdp-dpr.js
import fs from 'node:fs'
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const CASES = []
for (const dpr of [1, 1.25, 1.5, 2]) {
  for (const [w, h] of [
    [1500, 950],
    [1280, 800],
    [1100, 700],
  ]) {
    CASES.push({ dpr, w, h })
  }
}

const BUILD = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var cs = getComputedStyle(ta)
  var ics = getComputedStyle(inner)
  var padL = parseFloat(cs.paddingLeft)
  var padR = parseFloat(cs.paddingRight)
  var taW = ta.clientWidth - padL - padR
  var hlW = inner.clientWidth - parseFloat(ics.paddingLeft) - parseFloat(ics.paddingRight)

  var taR = ta.getBoundingClientRect()
  var raw = ta.value.split('\\n')
  var all = document.querySelectorAll('.hl-line')
  var cvs = document.createElement('canvas')
  var ctx = cvs.getContext('2d')

  // 逐行：几何行数 vs 行盒高度推算的视觉行数
  var mismatch = 0
  var widthOverflow = 0
  var fragOffsets = []
  for (var i = 0; i < all.length; i++) {
    var el = all[i]
    var r = el.getBoundingClientRect()
    var lcs = getComputedStyle(el)
    var lineH = parseFloat(lcs.lineHeight) || 1
    var txt = el.querySelector('.hl-txt')
    var range = document.createRange()
    range.selectNodeContents(txt)
    var list = range.getClientRects()
    var groups = {}
    for (var j = 0; j < list.length; j++) {
      if (list[j].width <= 0.5 || list[j].height <= 0.5) continue
      var key = Math.round(list[j].top)
      if (!groups[key]) groups[key] = []
      groups[key].push(list[j])
    }
    var tops = Object.keys(groups).map(Number).sort(function(a, b) { return a - b })
    var expect = Math.max(1, Math.round(r.height / lineH))
    if (tops.length !== expect) mismatch++
    // 折行片段的左边界
    if (tops.length > 1) {
      var first = Math.min.apply(null, groups[tops[0]].map(function(x) { return x.left }))
      for (var t = 1; t < tops.length; t++) {
        var l = Math.min.apply(null, groups[tops[t]].map(function(x) { return x.left }))
        fragOffsets.push(Math.round((l - first) * 100) / 100)
      }
    }
    // 右边界溢出
    var contentRight = r.left + r.width - parseFloat(lcs.paddingRight)
    for (var q = 0; q < list.length; q++) {
      if (list[q].width > 0.5 && list[q].right > contentRight + 1) { widthOverflow++; break }
    }
  }

  // 光标横向：取 6 行，比较 canvas 推算 vs 真实字形
  var worstX = 0
  var worstRow = null
  var probeRows = [4, 12, 19, 20, 21, 23, 34, 41]
  for (var p = 0; p < probeRows.length; p++) {
    var idx = probeRows[p]
    var el2 = all[idx]
    if (!el2) continue
    var lcs2 = getComputedStyle(el2)
    var fs = parseFloat(lcs2.fontSize)
    ctx.font = fs + 'px ' + cs.fontFamily
    var text = raw[idx] || ''
    var col = Math.max(1, Math.floor(text.length * 0.6))
    var canvasX = ctx.measureText(text.slice(0, col)).width
    var txtEl = el2.querySelector('.hl-txt')
    var walker = document.createTreeWalker(txtEl, NodeFilter.SHOW_TEXT)
    var n, seen = 0, glyphX = null
    while ((n = walker.nextNode())) {
      var len = n.nodeValue.length
      if (seen + len >= col) {
        var rg = document.createRange()
        var at = col - seen
        rg.setStart(n, Math.max(0, Math.min(at, len)))
        rg.setEnd(n, Math.max(0, Math.min(at + 1, len)))
        var rr = rg.getBoundingClientRect()
        if (rr.width > 0 || rr.height > 0) {
          glyphX = rr.left - el2.getBoundingClientRect().left - parseFloat(lcs2.paddingLeft)
        }
        break
      }
      seen += len
    }
    if (glyphX !== null) {
      var d = Math.abs(glyphX - canvasX)
      if (d > worstX) { worstX = d; worstRow = { i: idx, fs: fs, canvasX: Math.round(canvasX * 100) / 100, glyphX: Math.round(glyphX * 100) / 100 } }
    }
  }

  return {
    taContentWidth: Math.round(taW * 1000) / 1000,
    hlContentWidth: Math.round(hlW * 1000) / 1000,
    widthDiff: Math.round((taW - hlW) * 1000) / 1000,
    rowHeightMismatch: mismatch,
    widthOverflowRows: widthOverflow,
    maxFragOffset: fragOffsets.length ? Math.max.apply(null, fragOffsets.map(Math.abs)) : 0,
    worstCaretX: Math.round(worstX * 100) / 100,
    worstCaretRow: worstRow,
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

  console.log('  缩放   窗口       层宽差    行盒不符  越界行  折行片段最大偏移  光标横向最大偏差')
  let bad = 0
  for (const c of CASES) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: c.w,
      height: c.h,
      deviceScaleFactor: c.dpr,
      mobile: false,
    })
    await new Promise((r) => setTimeout(r, 450))
    await ev(`(function(){ var ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`)
    await new Promise((r) => setTimeout(r, 250))
    let d
    try {
      d = await ev(BUILD)
    } catch (e) {
      console.log(`  ${String(c.dpr).padEnd(6)} ${String(c.w + 'x' + c.h).padEnd(10)} 测量失败: ${e.message}`)
      bad++
      continue
    }
    const ok = d.widthDiff === 0 && d.rowHeightMismatch === 0 && d.maxFragOffset <= 1 && d.worstCaretX <= 1.5
    if (!ok) bad++
    console.log(
      `  ${String(c.dpr).padEnd(6)} ${String(c.w + 'x' + c.h).padEnd(10)} ${String(d.widthDiff).padEnd(9)} ${String(d.rowHeightMismatch).padEnd(9)} ${String(d.widthOverflowRows).padEnd(7)} ${String(d.maxFragOffset).padEnd(17)} ${String(d.worstCaretX).padEnd(9)} ${ok ? '✓' : '✗'}`
    )
    if (!ok && d.worstCaretRow) {
      console.log(`         光标偏差最大的是行 ${d.worstCaretRow.i}（字号 ${d.worstCaretRow.fs}）: canvas ${d.worstCaretRow.canvasX} vs 字形 ${d.worstCaretRow.glyphX}`)
    }
  }
  await send('Emulation.clearDeviceMetricsOverride')
  console.log('')
  console.log(bad ? `  ✗ ${bad} 个组合有问题` : '  ✓ 所有缩放/窗口组合都一致')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
