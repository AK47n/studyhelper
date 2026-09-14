// 回归检查（真浏览器）：着色层和 textarea 必须逐行对齐，折行的行也要按实际高度算对。
// 这是「直接编辑渲染视图」这套做法的命门，所以留一个能真跑的断言。
//
// 用法：先启动 Chrome 带调试端口，再跑本脚本
//   chrome --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\p http://127.0.0.1:5177/
//   node scripts/cdp-align.js
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

const EXPR = `(() => {
  const ta = document.querySelector('textarea.raw')
  const inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return JSON.stringify({ error: '找不到 textarea 或 .hl-inner' })
  const cs = getComputedStyle(ta)
  const lh = parseFloat(cs.lineHeight)
  const padTop = parseFloat(cs.paddingTop)
  const padL = parseFloat(cs.paddingLeft)
  const taR = ta.getBoundingClientRect()
  const taScroll = ta.scrollTop
  const lines = [...document.querySelectorAll('.hl-line')]

  // 逐行比对：textarea 的第 i 行视觉顶 = 内容顶 + 前面所有行**实际高度**之和
  let accH = 0
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const el = lines[i]
    const r = el.getBoundingClientRect()
    const taTop = taR.top + padTop + accH - taScroll
    rows.push({
      i,
      text: (el.textContent || '').slice(0, 22),
      hlTop: Math.round(r.top * 100) / 100,
      hlH: Math.round(r.height * 100) / 100,
      visualRows: Math.round(r.height / lh),
      taTop: Math.round(taTop * 100) / 100,
      dy: Math.round((r.top - taTop) * 100) / 100,
    })
    accH += r.height
  }

  // 内容盒原点也必须重合。注意纵向：.hl-inner 带着 translateY(-scrollTop)，
  // 所以它的（视觉）原点本来就该比 textarea 高出一个 scrollTop —— 这是对的，不是错位。
  const ics = getComputedStyle(inner)
  const ir = inner.getBoundingClientRect()
  const originDx = Math.round((ir.left + parseFloat(ics.paddingLeft) - (taR.left + padL)) * 100) / 100
  const originDyRaw = ir.top + parseFloat(ics.paddingTop) - (taR.top + padTop)
  const originDy = Math.round((originDyRaw + taScroll) * 100) / 100 // 抵消滚动平移后应为 0

  // 可用宽度必须相等（不等就会在不同位置折行）
  const taW = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const hlW = inner.clientWidth - parseFloat(ics.paddingLeft) - parseFloat(ics.paddingRight)

  const worst = rows.reduce((m, r) => Math.max(m, Math.abs(r.dy)), 0)
  return JSON.stringify({
    lineHeight: lh,
    taScrollTop: taScroll,
    originDx, originDy,
    textWidth: { ta: taW, hl: hlW, diff: Math.round((taW - hlW) * 100) / 100 },
    rowCount: rows.length,
    wrappedRows: rows.filter((r) => r.visualRows > 1).length,
    worstDy: Math.round(worst * 100) / 100,
    worstRows: rows.filter((r) => Math.abs(r.dy) > 0.5).slice(0, 6),
    sample: rows.slice(0, 10),
  }, null, 2)
})()`

async function main() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可调试的页面')
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
  const d = JSON.parse(r.result.value)
  if (d.error) {
    console.log('  ✗ ' + d.error)
    process.exit(1)
  }

  console.log('=== 真浏览器对齐回归 ===')
  console.log(`  行高 ${d.lineHeight}px ｜ 行数 ${d.rowCount}（其中折行的 ${d.wrappedRows} 行）`)
  console.log(`  滚动位置 scrollTop = ${d.taScrollTop}`)
  console.log(`  内容盒原点偏差（已抵消滚动平移） Δx=${d.originDx}px  Δy=${d.originDy}px`)
  console.log(`  文字可用宽度    textarea ${d.textWidth.ta}px / 着色层 ${d.textWidth.hl}px（差 ${d.textWidth.diff}px）`)
  console.log('')
  console.log('  行  文本                    着色y       高      视觉行  偏差')
  for (const s of d.sample) {
    console.log(
      `  ${String(s.i).padEnd(3)} ${s.text.padEnd(22)} ${String(s.hlTop).padEnd(11)} ${String(s.hlH).padEnd(7)} ${String(s.visualRows).padEnd(7)} ${s.dy}`
    )
  }
  console.log('')

  let bad = 0
  const TOL = 0.6
  if (d.worstDy <= TOL) console.log(`  ✓ 逐行完全对齐（最大偏差 ${d.worstDy}px，容差 ${TOL}px）`)
  else {
    console.log(`  ✗ 有行错位，最大偏差 ${d.worstDy}px：`)
    for (const r2 of d.worstRows) console.log(`     行 ${r2.i} 偏差 ${r2.dy}px  「${r2.text}」`)
    bad++
  }
  if (Math.abs(d.originDx) <= TOL && Math.abs(d.originDy) <= TOL) console.log('  ✓ 内容盒原点重合')
  else {
    console.log(`  ✗ 内容盒原点错开 Δx=${d.originDx} Δy=${d.originDy}`)
    bad++
  }
  if (Math.abs(d.textWidth.diff) <= TOL) console.log('  ✓ 两层文字可用宽度相等（折行点必然一致）')
  else {
    console.log(`  ✗ 可用宽度差 ${d.textWidth.diff}px，折行点会不一致`)
    bad++
  }

  ws.close()
  console.log(bad ? '\n有问题 ✗' : '\n全部通过 ✓')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
