// 在「诊断已打开 + 自动聚焦滚动后」的状态下，同一时刻量滚动量和逐行偏移。
// 之前的滚动测试是手动设 scrollTop，这次是走真实的「聚焦自动滚动」路径。
//   node scripts/diag-state.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const MEASURE = (tag) => `
(function(tag) {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  var cs = getComputedStyle(ta)
  var taR = ta.getBoundingClientRect()
  var padTop = parseFloat(cs.paddingTop)
  var scroll = ta.scrollTop
  var m = /matrix\\(1, 0, 0, 1, 0, (-?[\\d.]+)\\)/.exec(getComputedStyle(inner).transform)
  var ty = m ? Number(m[1]) : 0

  var all = document.querySelectorAll('.hl-line')
  var acc = 0
  var worst = 0, worstRow = null
  var samples = []
  for (var i = 0; i < all.length; i++) {
    var r = all[i].getBoundingClientRect()
    var taTop = taR.top + padTop + acc - scroll
    var d = r.top - taTop
    if (Math.abs(d) > Math.abs(worst)) { worst = d; worstRow = i }
    if (i < 6) samples.push({ i: i, hl: Math.round(r.top * 100) / 100, taTop: Math.round(taTop * 100) / 100, dy: Math.round(d * 100) / 100, h: Math.round(r.height * 100) / 100 })
    acc += r.height
  }
  return {
    tag: tag,
    scrollTop: scroll,
    transform: getComputedStyle(inner).transform,
    ty: ty,
    tyMatchesScroll: Math.abs(ty + scroll) < 0.5,
    worstDy: Math.round(worst * 100) / 100,
    worstRow: worstRow,
    taTop: Math.round(taR.top * 100) / 100,
    taH: Math.round(taR.height * 100) / 100,
    innerTop: Math.round(inner.getBoundingClientRect().top * 100) / 100,
    focused: document.activeElement === ta,
    samples: samples,
  }
})('${tag}')
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

  // 回到初始状态：滚到顶、失焦
  await ev(`(function(){ var ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.blur(); ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`)
  await new Promise((r) => setTimeout(r, 400))
  const a = await ev(MEASURE('失焦·顶部'))
  console.log('=== 状态 A：失焦，scrollTop=0 ===')
  console.log(JSON.stringify(a, null, 2))

  // 打开诊断
  await ev(`(function(){
    var b = [].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
    if (b) b.click(); return 1 })()`)
  await new Promise((r) => setTimeout(r, 400))
  const b1 = await ev(MEASURE('诊断开·失焦'))
  console.log('\n=== 状态 B：诊断已开，仍失焦 ===')
  console.log(JSON.stringify(b1, null, 2))

  // 真实聚焦路径：点一下编辑区中间
  const box = await ev(`(function(){ var r=document.querySelector('textarea.raw').getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)} })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 500))
  const c = await ev(MEASURE('点击聚焦后'))
  console.log('\n=== 状态 C：真实点击聚焦后（这就是用户看到的现场）===')
  console.log(JSON.stringify(c, null, 2))

  // 再等一会儿，看会不会自己恢复
  await new Promise((r) => setTimeout(r, 1200))
  const d = await ev(MEASURE('再等 1.2 秒'))
  console.log('\n=== 状态 D：再等 1.2 秒 ===')
  console.log(`  scrollTop=${d.scrollTop}  transform=${d.transform}  worstDy=${d.worstDy}（行 ${d.worstRow}）`)

  // 关掉诊断
  await ev(`(function(){
    var b = [].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
    if (b) b.click(); return 1 })()`)

  console.log('\n=== 结论 ===')
  for (const s of [a, b1, c, d]) {
    console.log(`  ${String(s.tag).padEnd(18)} scrollTop=${String(s.scrollTop).padEnd(6)} transform=${s.transform.padEnd(24)} 逐行最大偏差=${s.worstDy}px`)
  }
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
