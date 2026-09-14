// 量两层的"总高度"和"最后一行位置"——不受行高假设影响。
// 如果两层行高一致，最后一行位置必须重合。
//   node scripts/tail-compare.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const BUILD = `
(function() {
  var sc = document.querySelector('.srcscroll')
  var inner = document.querySelector('.hl-inner')
  var ta = document.querySelector('textarea.raw')
  if (!sc || !inner || !ta) return { error: 'DOM 不对' }

  var all = document.querySelectorAll('.hl-line')
  var last = all[all.length - 1]
  var first = all[0]
  var scRect = sc.getBoundingClientRect()
  var ics = getComputedStyle(inner)

  // 着色层：首行顶、末行底（相对滚动容器内容顶）
  var innerTop = inner.getBoundingClientRect().top
  var firstTop = first.getBoundingClientRect().top - innerTop
  var lastBottom = last.getBoundingClientRect().bottom - innerTop
  var hlTotal = lastBottom - firstTop

  // textarea：内容高度 = scrollHeight - 上下 padding
  var cs = getComputedStyle(ta)
  var padT = parseFloat(cs.paddingTop)
  var padB = parseFloat(cs.paddingBottom)
  var taContentH = ta.scrollHeight - padT - padB
  var taBoxH = ta.getBoundingClientRect().height
  var taStyleH = ta.style.height

  return {
    scrollTop: sc.scrollTop,
    scScrollHeight: sc.scrollHeight,
    scClientHeight: sc.clientHeight,
    hlLineCount: all.length,
    hlFirstTop: Math.round(firstTop * 100) / 100,
    hlLastBottom: Math.round(lastBottom * 100) / 100,
    hlTotalHeight: Math.round(hlTotal * 100) / 100,
    hlInnerHeight: Math.round(inner.getBoundingClientRect().height * 100) / 100,
    taScrollHeight: ta.scrollHeight,
    taContentHeight: taContentH,
    taBoxHeight: Math.round(taBoxH * 100) / 100,
    taInlineHeight: taStyleH,
    taPadding: padT + ' / ' + padB,
    diffTotal: Math.round((hlTotal - taContentH) * 100) / 100,
    diffBoxHeight: Math.round((inner.getBoundingClientRect().height - taBoxH) * 100) / 100,
    taLineHeight: cs.lineHeight,
    taFontSize: cs.fontSize,
    hlLineHeight: getComputedStyle(first).lineHeight,
    hlFontSize: getComputedStyle(first).fontSize,
    innerMinHeight: ics.minHeight,
    innerTop: Math.round(innerTop * 100) / 100,
    taTop: Math.round(ta.getBoundingClientRect().top * 100) / 100,
    sameTop: Math.abs(innerTop - ta.getBoundingClientRect().top) < 0.5,
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
  console.log('=== 两层总高度对照 ===')
  console.log(`  着色层：首行顶 ${d.hlFirstTop}  末行底 ${d.hlLastBottom}  总高 ${d.hlTotalHeight}  元素高 ${d.hlInnerHeight}`)
  console.log(`  文本框：内容高 ${d.taContentHeight}  盒子高 ${d.taBoxHeight}  内联 height=${d.taInlineHeight}  scrollHeight=${d.taScrollHeight}`)
  console.log(`  内边距 ${d.taPadding}`)
  console.log('')
  console.log(`  总高之差（着色层 − 文本框内容） = ${d.diffTotal}px`)
  console.log(`  盒子高之差（着色层 − 文本框盒子） = ${d.diffBoxHeight}px`)
  console.log(`  两者顶边重合: ${d.sameTop ? '✓' : '✗'}（着色层 ${d.innerTop} / 文本框 ${d.taTop}）`)
  console.log('')
  console.log(`  色调参数：textarea ${d.taFontSize}/${d.taLineHeight}   着色层 ${d.hlFontSize}/${d.hlLineHeight}`)
  console.log(`  滚动容器 scrollHeight=${d.scScrollHeight} clientHeight=${d.scClientHeight} scrollTop=${d.scrollTop}`)
  console.log('')
  const ok = Math.abs(d.diffBoxHeight) <= 1 && Math.abs(d.diffTotal) <= 1 && d.sameTop
  console.log(ok ? '  ✓ 两层几何一致' : '  ✗ 两层几何不一致 —— 这就是根因')
  ws.close()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
