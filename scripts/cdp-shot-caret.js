// 通过 CDP 把光标放进一段公式中间，然后截图。用来肉眼确认「字和光标咬合」。
//   node scripts/cdp-shot-caret.js
import fs from 'node:fs'
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const OUT = process.env.OUT || '.cache/shot-caret.png'

const PLACE_CARET = `(() => {
  const ta = document.querySelector('textarea.raw')
  const lines = ta.value.split('\\n')
  // 找一行含较长行内公式的
  let target = null
  for (let i = 0; i < lines.length; i++) {
    const m = /\\$([^$]{14,})\\$/.exec(lines[i])
    if (m) { target = { i, col: m.index + 1 + Math.floor(m[1].length / 2) }; break }
  }
  if (!target) return { error: '没找到长公式' }
  let lineStart = 0
  for (let k = 0; k < target.i; k++) lineStart += lines[k].length + 1
  const caret = lineStart + target.col
  const cs = getComputedStyle(ta)
  const lh = parseFloat(cs.lineHeight) || 38
  ta.scrollTop = Math.max(0, target.i * lh - ta.clientHeight / 2 + lh)
  ta.focus()
  ta.setSelectionRange(caret, caret)
  ta.dispatchEvent(new Event('scroll', { bubbles: true }))
  return {
    line: target.i,
    text: lines[target.i],
    col: target.col,
    caret,
    charAtCaret: ta.value[caret],
    charBefore: ta.value[caret - 1],
    head: lines[target.i].slice(0, target.col),
    tail: lines[target.i].slice(target.col),
    scrollTop: ta.scrollTop,
  }
})()`

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

  const place = await send('Runtime.evaluate', {
    expression: PLACE_CARET,
    returnByValue: true,
    awaitPromise: true,
  })
  const info = place.result.value
  console.log('光标已放置：')
  console.log(JSON.stringify(info, null, 2))
  if (info.error) process.exit(1)

  await new Promise((r) => setTimeout(r, 400))
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log(`\n截图已存：${OUT}（${fs.statSync(OUT).size} 字节）`)
  console.log(`光标前的内容：…${info.head.slice(-24)}`)
  console.log(`光标后的内容：${info.tail.slice(0, 24)}…`)
  ws.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
