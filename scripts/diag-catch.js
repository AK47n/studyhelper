// 抓现行：在「诊断已开」的状态下，同一时刻既量 DOM 又截图，反复几次，
// 直到抓到一次"DOM 说 0px 但图上有偏差"的现场。
//   node scripts/diag-catch.js
import fs from 'node:fs'
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const SNAP = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  var cs = getComputedStyle(ta)
  var taR = ta.getBoundingClientRect()
  var padTop = parseFloat(cs.paddingTop)
  var scroll = ta.scrollTop
  var m = /matrix\\(1, 0, 0, 1, 0, (-?[\\d.]+)\\)/.exec(getComputedStyle(inner).transform)
  var ty = m ? Number(m[1]) : 0
  var all = document.querySelectorAll('.hl-line')
  var acc = 0, worst = 0, worstRow = null
  for (var i = 0; i < all.length; i++) {
    var r = all[i].getBoundingClientRect()
    var taTop = taR.top + padTop + acc - scroll
    var d = r.top - taTop
    if (Math.abs(d) > Math.abs(worst)) { worst = d; worstRow = i }
    acc += r.height
  }
  var f = all[0] ? all[0].getBoundingClientRect() : null
  return {
    scrollTop: scroll,
    transform: getComputedStyle(inner).transform,
    ty: ty,
    expectedTy: -scroll,
    worstDy: Math.round(worst * 100) / 100,
    worstRow: worstRow,
    firstLineTop: f ? Math.round(f.top * 100) / 100 : null,
    taContentTop: Math.round((taR.top + padTop) * 100) / 100,
    focused: document.activeElement === ta,
    activeLineText: document.querySelector('.hl-line.active') ? (document.querySelector('.hl-line.active').textContent || '').slice(0, 24) : null,
    diagOn: document.querySelector('.srcscroll').className.indexOf('diag') >= 0,
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

  // 确保诊断开着
  const on = await ev(`(function(){ return document.querySelector('.srcscroll').className.indexOf('diag') >= 0 })()`)
  if (!on) {
    await ev(`(function(){
      var b=[].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
      if(b) b.click(); return 1 })()`)
    await new Promise((r) => setTimeout(r, 400))
  }

  for (let round = 1; round <= 6; round++) {
    // 随机滚到某处（模拟用户滚动后停下来）
    const pct = round === 1 ? 0 : Math.round(Math.random() * 100) / 100
    await ev(`(function(pct){
      var ta = document.querySelector('textarea.raw')
      var max = ta.scrollHeight - ta.clientHeight
      ta.scrollTop = Math.round(max * pct)
      ta.dispatchEvent(new Event('scroll', { bubbles: true }))
      ta.focus()
      return 1 })(${pct})`)
    await new Promise((r) => setTimeout(r, 350))

    const before = await ev(SNAP)
    const s = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`.cache/diag-catch-${round}.png`, Buffer.from(s.data, 'base64'))
    const after = await ev(SNAP)

    console.log(`--- 第 ${round} 轮 (pct=${pct}) ---`)
    console.log(`  截图前: scrollTop=${before.scrollTop}  transform=${before.transform}  期望=${before.expectedTy}  逐行最大偏差=${before.worstDy}px`)
    console.log(`  截图后: scrollTop=${after.scrollTop}  transform=${after.transform}  期望=${after.expectedTy}  逐行最大偏差=${after.worstDy}px`)
    console.log(`  活跃行: ${before.activeLineText}   首行顶=${before.firstLineTop}  内容盒顶=${before.taContentTop}`)
    if (!before.tyMatchesScroll || !after.tyMatchesScroll) console.log('  ⚠ transform 与 scrollTop 不匹配！')
    if (Math.abs(before.scrollTop - after.scrollTop) > 1) console.log('  ⚠ 截图前后 scrollTop 变了！')
  }
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
