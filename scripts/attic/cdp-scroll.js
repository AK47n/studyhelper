// 滚动状态下的对齐体检：把 textarea 滚到不同位置，逐行比对着色层和 textarea 的行位置。
// 之前所有测量都在 scrollTop=0 做的，滚动中同步失效的话就会错位。
//   node scripts/cdp-scroll.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const SET_SCROLL = (pct) => `
(function(pct) {
  var ta = document.querySelector('textarea.raw')
  if (!ta) return { error: '没有 textarea' }
  var max = ta.scrollHeight - ta.clientHeight
  ta.scrollTop = Math.round(max * pct)
  ta.dispatchEvent(new Event('scroll', { bubbles: true }))
  return { target: Math.round(max * pct) }
})(${pct})
`

const CHECK = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  var cs = getComputedStyle(ta)
  var ics = getComputedStyle(inner)
  var padTop = parseFloat(cs.paddingTop)
  var taR = ta.getBoundingClientRect()
  var scroll = ta.scrollTop

  // 1) 平移量对不对
  var m = /matrix\\(1, 0, 0, 1, 0, (-?[\\d.]+)\\)/.exec(getComputedStyle(inner).transform)
  var ty = m ? Number(m[1]) : 0
  var transformOk = Math.abs(ty + scroll) < 0.5

  // 2) 逐行位置：按每行实际高度累加，和着色层比对
  var all = document.querySelectorAll('.hl-line')
  var worst = 0
  var worstRow = null
  var acc = 0
  for (var i = 0; i < all.length; i++) {
    var r = all[i].getBoundingClientRect()
    var taTop = taR.top + padTop + acc - scroll
    var d = r.top - taTop
    if (Math.abs(d) > Math.abs(worst)) { worst = d; worstRow = i }
    acc += r.height
  }

  // 3) 内容盒原点（抵消滚动平移后应为 0）
  var ir = inner.getBoundingClientRect()
  var originDy = (ir.top + parseFloat(ics.paddingTop)) - (taR.top + padTop) + scroll

  return {
    scrollTop: scroll,
    transform: getComputedStyle(inner).transform,
    transformOk: transformOk,
    originDy: Math.round(originDy * 100) / 100,
    worstDy: Math.round(worst * 100) / 100,
    worstRow: worstRow,
    scrollHeight: ta.scrollHeight,
    clientHeight: ta.clientHeight,
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

  console.log('  滚动位置   transform       平移正确  原点偏差  逐行最大偏差  偏差行')
  let bad = 0
  for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
    await ev(SET_SCROLL(pct))
    await new Promise((r) => setTimeout(r, 250))
    const d = await ev(CHECK)
    if (!d || d.error) {
      console.log(`  ${String(pct).padEnd(9)} ✗ ${(d && d.error) || '无返回'}`)
      bad++
      continue
    }
    const ok = d.transformOk && Math.abs(d.originDy) < 0.6 && Math.abs(d.worstDy) < 0.6
    if (!ok) bad++
    console.log(
      `  ${String(Math.round(pct * 100) + '%').padEnd(9)} ${d.transform.padEnd(16)} ${String(d.transformOk ? '✓' : '✗').padEnd(9)} ${String(d.originDy).padEnd(9)} ${String(d.worstDy).padEnd(13)} ${String(d.worstRow).padEnd(7)} ${ok ? '✓' : '✗'}`
    )
    console.log(`            scrollTop=${d.scrollTop}  scrollHeight=${d.scrollHeight}  clientHeight=${d.clientHeight}`)
  }
  console.log('')
  console.log(bad ? `  ✗ ${bad} 个滚动位置有偏差` : '  ✓ 所有滚动位置下两层都逐行对齐')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
