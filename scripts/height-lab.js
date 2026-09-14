// 逐字号验证：同一段文字，textarea 和 div 在各种字号下的高度必须相等。
// 总高差 71px 的根因就藏在这里。
//   node scripts/height-lab.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const BUILD = `
(function() {
  var src = document.querySelector('textarea.raw')
  var cs = getComputedStyle(src)
  var old = document.getElementById('hl-lab'); if (old) old.remove()
  var host = document.createElement('div')
  host.id = 'hl-lab'
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;background:#fff'
  document.body.appendChild(host)

  var BOXW = 640
  function common(el) {
    el.style.cssText = [
      'position:static','width:' + BOXW + 'px','box-sizing:border-box',
      'padding:0','border:0','margin:0','resize:none','outline:none','overflow:visible',
      'font-family:' + cs.fontFamily,
      'font-kerning:' + cs.fontKerning,
      'font-variant-ligatures:' + cs.fontVariantLigatures,
      'font-feature-settings:' + cs.fontFeatureSettings,
      'font-synthesis:' + cs.fontSynthesis,
      'text-rendering:' + cs.textRendering,
      'letter-spacing:' + cs.letterSpacing,'word-spacing:' + cs.wordSpacing,
      'white-space:pre-wrap','overflow-wrap:break-word','word-break:normal','tab-size:' + cs.tabSize
    ].join(';')
  }

  var N = 6
  var text = Array.from({ length: N }, function(_, i) { return '行' + i + ' test line with some ascii text' }).join('\\n')

  var out = []
  // 覆盖正文、各标题层级、以及一些极端字号
  var sizes = [
    ['正文 19.375', 19.375, 1.95],
    ['lv3 21.7', 19.375 * 1.12, 1.95],
    ['lv2 24.8', 19.375 * 1.28, 1.95],
    ['lv1 29.06', 19.375 * 1.5, 1.95],
    ['小 13', 13, 1.95],
    ['大 40', 40, 1.95],
  ]
  for (var i = 0; i < sizes.length; i++) {
    var name = sizes[i][0], fs = sizes[i][1], lh = sizes[i][2]
    var ta = document.createElement('textarea')
    common(ta)
    ta.style.fontSize = fs + 'px'
    ta.style.lineHeight = lh
    ta.rows = 1
    ta.value = text
    host.appendChild(ta)
    var dv = document.createElement('div')
    common(dv)
    dv.style.fontSize = fs + 'px'
    dv.style.lineHeight = lh
    dv.textContent = text
    host.appendChild(dv)
    void ta.offsetHeight
    void dv.offsetHeight
    var taH = ta.scrollHeight
    var dvH = dv.scrollHeight
    out.push({
      name: name,
      fontSize: Math.round(fs * 100) / 100,
      lineHeight: Math.round(fs * lh * 100) / 100,
      taScrollHeight: taH,
      divScrollHeight: dvH,
      diff: Math.round((dvH - taH) * 100) / 100,
      taPerLine: Math.round((taH / N) * 100) / 100,
      dvPerLine: Math.round((dvH / N) * 100) / 100,
      match: Math.abs(taH - dvH) < 1,
    })
    host.removeChild(ta)
    host.removeChild(dv)
  }
  host.remove()
  return { fontFamily: cs.fontFamily, report: out }
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

  const d = await ev(BUILD)
  console.log(`字体 ${d.fontFamily}`)
  console.log('')
  console.log('  用例          字号     行高      textarea高  div高     差      每行(ta/div)      一致')
  let bad = 0
  for (const r of d.report) {
    if (!r.match) bad++
    console.log(
      `  ${r.name.padEnd(13)} ${String(r.fontSize).padEnd(8)} ${String(r.lineHeight).padEnd(8)} ${String(r.taScrollHeight).padEnd(11)} ${String(r.divScrollHeight).padEnd(9)} ${String(r.diff).padEnd(7)} ${(r.taPerLine + ' / ' + r.dvPerLine).padEnd(17)} ${r.match ? '✓' : '✗'}`
    )
  }
  console.log('')
  console.log(bad ? `  ✗ ${bad} 个字号下两层高度不同 —— 这就是总高差 71px 的来源` : '  ✓ 所有字号下两层高度一致')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
