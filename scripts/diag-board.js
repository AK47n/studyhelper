/* 白板几何诊断：在真浏览器里把关键尺寸量出来。
 *
 * 为什么需要它：白板"看着不对"的时候，可能的根因有七八个
 * （canvas 的 CSS 尺寸、devicePixelRatio、视野缩放、卡片层的 transform、
 *  容器高度是 0……），光看截图猜不出来。这里一次性把每一层都打出来，
 * 比对一下就定位了。
 *
 * 跑：node scripts/diag-board.js
 */
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'

const list = await (await fetch(CDP + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('没有可用的页面 target（Chrome 起了吗？地址是 ' + APP + ' 吗？）')
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pend = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result)
    pend.delete(m.id)
  }
})
const ev = (expr) =>
  new Promise((res) => {
    const i = ++id
    pend.set(i, (r) => res(r.result && r.result.value))
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })

const out = await ev(`(() => {
  const wrap = document.querySelector('.bd-stagewrap')
  if (!wrap) return { error: '没有 .bd-stagewrap —— 白板没挂上' }
  const stage = document.querySelector('.bd-stage')
  const ink = document.querySelector('canvas.bd-ink')
  const live = document.querySelector('canvas.bd-live')
  const c0 = document.querySelector('.bd-card')
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
  return {
    dpr: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    wrap: rect(wrap),
    stageStyle: stage ? [stage.style.width, stage.style.height] : null,
    stage: rect(stage),
    ink: rect(ink),
    inkBitmap: ink ? [ink.width, ink.height] : null,
    liveBitmap: live ? [live.width, live.height] : null,
    card0: rect(c0),
    /* 卡片的位置是 JS 按"屏幕 = 世界 * s + t"算的，所以要同时看
       style（算出来的值）和实测（相对容器）——两者必须一致，这是坐标基准的哨兵。
       见 check-board-browser.js 的 [6]，那边有正式断言。 */
    card0StyleRel: c0 ? [Math.round(parseFloat(c0.style.left)), Math.round(parseFloat(c0.style.top))] : null,
    card0MeasuredRel: c0 ? [rect(c0).l - rect(wrap).l, rect(c0).t - rect(wrap).t] : null,
    nCards: document.querySelectorAll('.bd-card').length,
    nEdges: document.querySelectorAll('.bd-edge').length,
    toolbar: rect(document.querySelector('.bd-tools')),
  }
})()`)

console.log('\n白板几何诊断')
console.log('─'.repeat(60))
for (const [k, v] of Object.entries(out)) {
  console.log('  ' + k.padEnd(16) + JSON.stringify(v))
}
console.log('─'.repeat(60))
if (out.wrap && out.stage) {
  const bad = []
  if (out.wrap.h < 200) bad.push('stagewrap 高度只有 ' + out.wrap.h + ' —— 容器塌了，白板会看不见')
  if (out.stage.w !== out.wrap.w) bad.push(`stage 宽 ${out.stage.w} ≠ 容器宽 ${out.wrap.w}（画布没铺满）`)
  if (out.ink && Math.abs(out.ink.w - out.wrap.w) > 1) bad.push('canvas 的 CSS 宽度和容器不一致')
  if (out.inkBitmap && out.dpr && Math.abs(out.inkBitmap[0] - out.wrap.w * out.dpr) > 2) {
    bad.push(`canvas 位图宽 ${out.inkBitmap[0]} 与 容器宽×dpr(${Math.round(out.wrap.w * out.dpr)}) 不符 —— 会糊`)
  }
  if (out.card0 && out.card0.w < 40) bad.push('卡片在屏幕上不到 40px 宽 —— 视野缩放太小（fitView 算错了？）')
  // 坐标基准：卡片 style 里算出来的 left/top，和实测相对容器的位置必须一致
  if (out.card0StyleRel && out.card0MeasuredRel) {
    const dx = Math.abs(out.card0StyleRel[0] - out.card0MeasuredRel[0])
    const dy = Math.abs(out.card0StyleRel[1] - out.card0MeasuredRel[1])
    if (dx > 2 || dy > 2) {
      bad.push(`卡片坐标基准不一致：style ${JSON.stringify(out.card0StyleRel)} vs 实测 ${JSON.stringify(out.card0MeasuredRel)}（差 ${dx}/${dy}px）—— 两层坐标又分家了`)
    }
  }
  if (bad.length) {
    console.log('  问题：')
    for (const b of bad) console.log('   ✗ ' + b)
  } else {
    console.log('  ✓ 几何看着正常')
  }
}
ws.close()
