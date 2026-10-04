// 关键对账：在同一时刻，既读 DOM 状态，又截图。
// 之前分开做，滚动状态在两次之间变了，所以 DOM 说 0px、截图却看得出偏移。
//   node scripts/pixel-state.js
import fs from 'node:fs'
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const STATE = `
(function(tag) {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  var clip = document.querySelector('.hl-inner')
  var hl = document.querySelector('.hl-inner')
  var taR = ta.getBoundingClientRect()
  var ir = inner.getBoundingClientRect()
  var cs = getComputedStyle(ta)
  var ics = getComputedStyle(inner)
  var padTop = parseFloat(cs.paddingTop)
  var m = /matrix\\(1, 0, 0, 1, 0, (-?[\\d.]+)\\)/.exec(getComputedStyle(inner).transform)
  return {
    tag: tag,
    taScrollTop: ta.scrollTop,
    taTransformHeight: ta.scrollHeight,
    innerTransform: getComputedStyle(inner).transform,
    innerTy: m ? Number(m[1]) : null,
    // 着色层第一行的屏幕 y
    firstLineY: inner.querySelector('.hl-line') ? Math.round(inner.querySelector('.hl-line').getBoundingClientRect().top * 100) / 100 : null,
    // textarea 第一行的屏幕 y（按内容盒顶 - scrollTop 推算）
    taFirstLineY: Math.round((taR.top + padTop - ta.scrollTop) * 100) / 100,
    taTop: Math.round(taR.top * 100) / 100,
    taHeight: Math.round(taR.height * 100) / 100,
    innerTop: Math.round(ir.top * 100) / 100,
    innerHeight: Math.round(ir.height * 100) / 100,
    innerPaddingTop: ics.paddingTop,
    taPaddingTop: cs.paddingTop,
    taVis: ta.style.visibility || '(默认)',
    clipVis: hl.style.visibility || '(默认)',
    taFontSize: cs.fontSize,
    innerFontSize: ics.fontSize,
    taLineHeight: cs.lineHeight,
    innerLineHeight: ics.lineHeight,
  }
})('%TAG%')
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

  // 1) 干净状态下的对账
  await ev(`(function(){ var ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`)
  await new Promise((r) => setTimeout(r, 400))
  const s0 = await ev(STATE.replace('%TAG%', '干净状态'))
  console.log('=== 干净状态 ===')
  console.log(JSON.stringify(s0, null, 2))

  // 2) 注入实验样式后再对账（模拟 pixel-verify 的现场）
  await ev(`
  (function(){
    var old = document.getElementById('pixel-lab'); if (old) old.remove()
    var st = document.createElement('style'); st.id='pixel-lab'
    st.textContent = '.srcscroll{background:#fff !important}.hl-inner{color:#000 !important}.raw{color:#000 !important;-webkit-text-fill-color:#000 !important}'
    document.head.appendChild(st)
    var ta = document.querySelector('textarea.raw')
    ta.scrollTop = 0; ta.dispatchEvent(new Event('scroll',{bubbles:true}))
    return 1
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  const s1 = await ev(STATE.replace('%TAG%', '注入样式后'))
  console.log('\n=== 注入实验样式后 ===')
  console.log(JSON.stringify(s1, null, 2))

  // 3) 藏掉着色层（pixel-verify 拍 textarea 时的状态）
  await ev(`(function(){ document.querySelector('.hl-inner').style.visibility='hidden'; return 1 })()`)
  await new Promise((r) => setTimeout(r, 300))
  const s2 = await ev(STATE.replace('%TAG%', '藏掉着色层（拍 textarea 时）'))
  console.log('\n=== 藏掉着色层后（这正是 pixel-verify 拍 textarea 的时刻）===')
  console.log(JSON.stringify(s2, null, 2))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('.cache/pixel-state.png', Buffer.from(shot.data, 'base64'))
  console.log('\n截图 .cache/pixel-state.png')

  // 复原
  await ev(`(function(){
    var c=document.querySelector('.hl-inner'); if(c) c.style.visibility=''
    var s=document.getElementById('pixel-lab'); if(s) s.remove()
    return 1 })()`)

  // 4) 结论
  console.log('\n=== 结论 ===')
  console.log(`  干净状态下：着色层首行 y=${s0.firstLineY}，textarea 首行 y=${s0.taFirstLineY}，差 ${Math.round((s0.firstLineY - s0.taFirstLineY) * 100) / 100}px`)
  console.log(`  藏掉着色层后：ta.scrollTop=${s2.taScrollTop}，inner transform=${s2.innerTransform}`)
  if (s2.taScrollTop !== s0.taScrollTop) {
    console.log(`  ⚠ 藏掉着色层改变了 scrollTop（${s0.taScrollTop} → ${s2.taScrollTop}）—— 测量装置本身有副作用`)
  }
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
