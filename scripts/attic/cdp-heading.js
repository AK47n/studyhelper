// 标题行错位诊断：量每一行的字号、行高、行盒高度，以及两层在同一行的 y 坐标差。
//   node scripts/cdp-heading.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const EXPR = `(() => {
  const ta = document.querySelector('textarea.raw')
  const inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return JSON.stringify({ error: 'DOM 不对' })
  const cs = getComputedStyle(ta)
  const lh = parseFloat(cs.lineHeight)
  const padTop = parseFloat(cs.paddingTop)
  const taR = ta.getBoundingClientRect()
  const taScroll = ta.scrollTop
  const lines = [...document.querySelectorAll('.hl-line')]

  let accH = 0
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const el = lines[i]
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    const txt = el.querySelector('.hl-txt')
    const ts = txt ? getComputedStyle(txt) : null
    const taTop = taR.top + padTop + accH - taScroll
    const isHead = el.className.includes('head')

    // 这一行里字形的实际纵向位置（用 Range 量第一个文本片段）
    let glyphTop = null
    if (txt) {
      const range = document.createRange()
      range.selectNodeContents(txt)
      const rects = [...range.getClientRects()].filter((x) => x.width > 0.5)
      if (rects.length) glyphTop = rects[0].top
    }

    rows.push({
      i,
      head: isHead,
      lv: isHead ? el.className.match(/lv(\\d)/)?.[1] || '?' : '',
      fs: s.fontSize,
      lh: s.lineHeight,
      h: Math.round(r.height * 100) / 100,
      visualRows: Math.round(r.height / lh),
      elTop: Math.round(r.top * 100) / 100,
      taTop: Math.round(taTop * 100) / 100,
      dy: Math.round((r.top - taTop) * 100) / 100,
      glyphTopFromEl: glyphTop === null ? null : Math.round((glyphTop - r.top) * 100) / 100,
      text: (el.textContent || '').slice(0, 20),
    })
    accH += r.height
  }

  return JSON.stringify({
    taLineHeight: lh,
    taFontSize: cs.fontSize,
    maxFontSize: Math.max(...rows.map((r) => parseFloat(r.fs))),
    rows,
    heads: rows.filter((r) => r.head),
  }, null, 2)
})()`

async function main() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可调试页面')
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
  // 先滚到顶，方便读
  await send('Runtime.evaluate', { expression: `(() => { const ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`, returnByValue: true })
  await new Promise((r) => setTimeout(r, 300))
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })
  const d = JSON.parse(r.result.value)
  if (d.error) {
    console.log(d.error)
    process.exit(1)
  }
  console.log(`textarea 字号 ${d.taFontSize} / 行高 ${d.taLineHeight}   最大字号 ${d.maxFontSize}`)
  console.log('')
  console.log('  行  标题  字号        行高      行盒高  视觉行  偏差      字形距行盒顶  文本')
  let worst = 0
  for (const x of d.rows.slice(0, 14)) {
    worst = Math.max(worst, Math.abs(x.dy))
    console.log(
      `  ${String(x.i).padEnd(3)} ${(x.head ? 'lv' + x.lv : '  ').padEnd(5)} ${x.fs.padEnd(11)} ${x.lh.padEnd(9)} ${String(x.h).padEnd(7)} ${String(x.visualRows).padEnd(7)} ${String(x.dy).padEnd(9)} ${String(x.glyphTopFromEl).padEnd(13)} ${x.text}`
    )
  }
  console.log('')
  console.log(`  最大偏差 ${Math.round(worst * 100) / 100}px`)
  console.log('  标题行：')
  for (const h of d.heads) {
    console.log(`    行 ${h.i} lv${h.lv} 字号 ${h.fs} 行高 ${h.lh} 行盒 ${h.h} 偏差 ${h.dy} 字形距行盒顶 ${h.glyphTopFromEl}`)
  }
  ws.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
