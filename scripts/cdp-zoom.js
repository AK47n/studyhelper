// 把光标放在指定行上，然后放大截取该行区域——用来和用户截图逐像素对照。
//   node scripts/cdp-zoom.js [行号] [放大倍数] [输出名]
import fs from 'node:fs'
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const LINE = Number(process.argv[2] ?? 19)
const SCALE = Number(process.argv[3] ?? 2)
const OUT = process.argv[4] || '.cache/zoom.png'

const PREPARE = `
(function(line) {
  var ta = document.querySelector('textarea.raw')
  if (!ta) return { error: '没有 textarea' }
  var raw = ta.value.split('\\n')
  if (line >= raw.length) return { error: '行号超出' }
  var start = 0
  for (var k = 0; k < line; k++) start += raw[k].length + 1
  // 把这一行滚到视野中间
  var all = document.querySelectorAll('.hl-line')
  var acc = 0
  for (var i = 0; i < line; i++) acc += all[i].getBoundingClientRect().height
  var lh = all[line] ? all[line].getBoundingClientRect().height : 40
  ta.scrollTop = Math.max(0, acc - ta.clientHeight / 2 + lh / 2)
  ta.dispatchEvent(new Event('scroll', { bubbles: true }))
  ta.focus()
  // 光标放在行内 30% 处
  var col = Math.max(1, Math.floor(raw[line].length * 0.3))
  ta.setSelectionRange(start + col, start + col)
  ta.dispatchEvent(new Event('select', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
  // 冻结光标闪烁，方便截图
  var old = document.getElementById('freeze-blink')
  if (old) old.remove()
  var st = document.createElement('style')
  st.id = 'freeze-blink'
  st.textContent = '.caret.on{animation:none !important;opacity:1 !important}'
  document.head.appendChild(st)
  return { line: line, col: col, text: raw[line] }
})(${LINE})
`

const BOX = `
(function(line) {
  var ta = document.querySelector('textarea.raw')
  var all = document.querySelectorAll('.hl-line')
  var taR = ta.getBoundingClientRect()
  var cs = getComputedStyle(ta)
  var padTop = parseFloat(cs.paddingTop)
  var acc = 0
  for (var i = 0; i < line; i++) acc += all[i].getBoundingClientRect().height
  var h = all[line] ? all[line].getBoundingClientRect().height : 40
  // 往上多带一行，方便看行间关系
  var prevH = line > 0 ? all[line - 1].getBoundingClientRect().height : 0
  var top = taR.top + padTop + acc - ta.scrollTop - prevH
  var boxTop = Math.max(taR.top, top)
  var bottom = Math.min(taR.bottom, top + prevH + h + (all[line + 1] ? all[line + 1].getBoundingClientRect().height : 0))
  return {
    x: Math.round(taR.left),
    y: Math.round(boxTop),
    w: Math.round(taR.width),
    h: Math.round(bottom - boxTop),
  }
})(${LINE})
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

  const prep = await ev(PREPARE)
  console.log('光标：', JSON.stringify(prep))
  if (prep.error) process.exit(1)
  await new Promise((r) => setTimeout(r, 400))
  const box = await ev(BOX)
  console.log('区域：', JSON.stringify(box))
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: SCALE },
  })
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('截图：' + OUT + `（放大 ${SCALE} 倍）`)
  await ev(`(function(){ var s=document.getElementById('freeze-blink'); if(s) s.remove(); return 1 })()`)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
