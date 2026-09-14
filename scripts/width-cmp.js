// canvas 量出的文本宽度 vs 浏览器实际渲染的宽度，必须相等。
// 光标横向位置全靠它。
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const EXPR = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var taCs = getComputedStyle(ta)
  var lineEl = document.querySelector('.hl-line')
  var lineCs = getComputedStyle(lineEl)

  var SAMPLE = '  - 公式 | $\\u005cvec{F} = q\\u005cvec{v}\\u005ctimes\\u005cvec{B}$'

  // canvas 量
  var cvs = document.createElement('canvas')
  var ctx = cvs.getContext('2d')
  var measureWith = function(fontStr) {
    ctx.font = fontStr
    return Math.round(ctx.measureText(SAMPLE).width * 100) / 100
  }

  var fontFromTa = taCs.fontStyle + ' ' + taCs.fontVariant + ' ' + taCs.fontWeight + ' ' + taCs.fontSize + '/' + taCs.lineHeight + ' ' + taCs.fontFamily
  var fontSimple = taCs.fontSize + ' ' + taCs.fontFamily

  // 用 DOM 量同一段文字的真实渲染宽度
  var probe = document.createElement('span')
  probe.style.cssText = [
    'position:absolute','left:-99999px','top:0','white-space:pre',
    'font-family:' + lineCs.fontFamily,
    'font-size:' + lineCs.fontSize,
    'font-weight:' + lineCs.fontWeight,
    'letter-spacing:' + lineCs.letterSpacing,
    'word-spacing:' + lineCs.wordSpacing,
    'font-kerning:' + lineCs.fontKerning,
    'font-variant-ligatures:' + lineCs.fontVariantLigatures,
    'text-rendering:' + lineCs.textRendering
  ].join(';')
  probe.textContent = SAMPLE
  document.body.appendChild(probe)
  var domW = Math.round(probe.getBoundingClientRect().width * 100) / 100
  probe.remove()

  // 用 Range 量同一行实际文本的整行宽度（不带任何字体假设）
  var txtEl = lineEl.querySelector('.hl-txt')
  var rg = document.createRange()
  rg.selectNodeContents(txtEl)
  var rects = rg.getClientRects()
  var rangeW = 0
  for (var i = 0; i < rects.length; i++) rangeW += rects[i].width
  rangeW = Math.round(rangeW * 100) / 100

  return JSON.stringify({
    sample: SAMPLE,
    fontFromTa: fontFromTa,
    fontSimple: fontSimple,
    canvasWithTaFont: measureWith(fontFromTa),
    canvasWithSimpleFont: measureWith(fontSimple),
    domRenderedWidth: domW,
    rowRangeTotalWidth: rangeW,
    perChar: {
      canvas: Math.round((measureWith(fontSimple) / SAMPLE.length) * 1000) / 1000,
      dom: Math.round((domW / SAMPLE.length) * 1000) / 1000,
    },
    taFont: { size: taCs.fontSize, family: taCs.fontFamily, weight: taCs.fontWeight, kerning: taCs.fontKerning, ligatures: taCs.fontVariantLigatures, textRendering: taCs.textRendering },
    lineFont: { size: lineCs.fontSize, family: lineCs.fontFamily, weight: lineCs.fontWeight, kerning: lineCs.fontKerning, ligatures: lineCs.fontVariantLigatures, textRendering: lineCs.textRendering },
    verdict: {
      canvasMatchesDom: Math.abs(measureWith(fontSimple) - domW) < 1,
      diff: Math.round((measureWith(fontSimple) - domW) * 100) / 100,
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
  if (r.exceptionDetails) {
    console.error(r.exceptionDetails.exception && r.exceptionDetails.exception.description)
    process.exit(1)
  }
  console.log(r.result.value)
  ws.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
