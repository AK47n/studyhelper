// 截图指定行区域（放大 2 倍便于肉眼检查）
//   node scripts/cdp-shot-row.js [起始行] [行数]
import fs from 'node:fs'
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const FROM = Number(process.argv[2] ?? 18)
const N = Number(process.argv[3] ?? 5)
const OUT = process.argv[4] || '.cache/shot-row.png'

const BUILD = `
(function(from, n) {
  var ta = document.querySelector('textarea.raw')
  ta.scrollTop = 0
  ta.dispatchEvent(new Event('scroll', { bubbles: true }))
  var taR = ta.getBoundingClientRect()
  var cs = getComputedStyle(ta)
  var padTop = parseFloat(cs.paddingTop)
  var all = document.querySelectorAll('.hl-line')
  var acc = 0, top = null, bottom = null
  for (var i = 0; i < all.length; i++) {
    var r = all[i].getBoundingClientRect()
    if (i === from) top = taR.top + padTop + acc
    acc += r.height
    if (i === from + n - 1) { bottom = taR.top + padTop + acc; break }
  }
  return { x: Math.round(taR.left), y: Math.round(top), w: Math.round(taR.width), h: Math.round(bottom - top) }
})(${FROM}, ${N})
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
  const box = await ev(BUILD)
  console.log('区域：', JSON.stringify(box))
  await new Promise((r) => setTimeout(r, 300))
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 },
  })
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('截图：' + OUT)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
