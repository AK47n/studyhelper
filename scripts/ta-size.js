// 量 textarea 的尺寸和"可用宽度"——折行模拟全靠它，错一点就全错。
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const EXPR = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var sc = document.querySelector('.srcscroll')
  var inner = document.querySelector('.hl-inner')
  var cs = getComputedStyle(ta)
  var r = ta.getBoundingClientRect()
  var padL = parseFloat(cs.paddingLeft)
  var padR = parseFloat(cs.paddingRight)
  return JSON.stringify({
    ta: {
      rectW: Math.round(r.width * 100) / 100,
      rectH: Math.round(r.height * 100) / 100,
      clientWidth: ta.clientWidth,
      clientHeight: ta.clientHeight,
      offsetWidth: ta.offsetWidth,
      offsetHeight: ta.offsetHeight,
      scrollHeight: ta.scrollHeight,
      scrollWidth: ta.scrollWidth,
      inlineHeight: ta.style.height || '(未设)',
      padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      boxSizing: cs.boxSizing,
      availWidthByFormula: ta.clientWidth - padL - padR,
    },
    scroller: {
      clientWidth: sc.clientWidth,
      clientHeight: sc.clientHeight,
      scrollHeight: sc.scrollHeight,
      rectW: Math.round(sc.getBoundingClientRect().width * 100) / 100,
    },
    hlInner: {
      clientWidth: inner.clientWidth,
      rectW: Math.round(inner.getBoundingClientRect().width * 100) / 100,
      firstLineWidth: (function(){ var l=document.querySelector('.hl-line'); return l ? Math.round(l.getBoundingClientRect().width*100)/100 : null })(),
    },
    sanity: {
      taContentWidthShouldBe: '733 - 40 = 693',
    },
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
