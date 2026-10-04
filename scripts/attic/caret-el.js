// 检查自绘光标元素的实际位置，以及文本行里字符的期望位置
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const EXPR = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var carets = document.querySelectorAll('.caret')
  var out = []
  for (var i = 0; i < carets.length; i++) {
    var e = carets[i]
    var r = e.getBoundingClientRect()
    out.push({
      cls: e.className,
      styleLeft: e.style.left,
      styleTop: e.style.top,
      rect: { l: Math.round(r.left * 100) / 100, t: Math.round(r.top * 100) / 100, w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 },
    })
  }
  return JSON.stringify({
    caretCount: carets.length,
    carets: out,
    selectionStart: ta.selectionStart,
    activeIndex: (function () {
      var raw = ta.value.split('\\n')
      var s = 0
      for (var i = 0; i < raw.length; i++) {
        if (ta.selectionStart >= s && ta.selectionStart <= s + raw[i].length) return { line: i, col: ta.selectionStart - s }
        s += raw[i].length + 1
      }
      return null
    })(),
    taRect: (function () { var r = ta.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top) } })(),
    innerRect: (function () { var e = document.querySelector('.hl-inner'); var r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top) } })(),
    scScrollTop: document.querySelector('.srcscroll').scrollTop,
  }, null, 2)
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
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })
  console.log(r.result.value)
  ws.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
