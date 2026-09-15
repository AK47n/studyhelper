/* 切换白板摆法并截一张图。
 *
 * 跑：node scripts/shot-board.js [A|B|C] [输出路径]
 * 为什么单独做一个小工具：在浏览器里改完东西、想"自己看一眼"的时候，
 * 每次都手搓一段 CDP 脚本太慢，而且容易漏掉"切回默认摆法"这一步 ——
 * 我就是漏了，结果截出来一张变体 C 的错位图，白吓了一跳。
 */
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'
const want = (process.argv[2] || 'A').toUpperCase()
const outPath = process.argv[3] || '.cache/board-shot.png'

import fs from 'node:fs'

const list = await (await fetch(CDP + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('没有可用的页面 target')
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
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pend.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result && r.result.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 切摆法：点切换器按钮，直到 class 对上
for (let i = 0; i < 5; i++) {
  const cls = await ev(`document.querySelector('.bd').className`)
  if (cls && cls.includes('variant-' + want)) break
  await ev(`(() => { const b = document.querySelectorAll('.bd-proto button')[1]; if (b) b.click(); return 1 })()`)
  await sleep(320)
}
await sleep(400)
// 先滚回顶部再量/截图：上一轮测试如果滚过页面，量到的是"视口外的位置"，
// 截出来会是一张黑图，看着像白板崩了 —— 我就是这么被自己吓过一次。
await ev(`(() => { window.scrollTo(0, 0); if (document.scrollingElement) document.scrollingElement.scrollTop = 0; return 1 })()`)
await sleep(250)
const info = await ev(`(() => {
  const wrap = document.querySelector('.bd-stagewrap')
  const r = wrap ? wrap.getBoundingClientRect() : null
  return {
    cls: document.querySelector('.bd').className,
    file: (document.querySelector('.bd-file') || {}).textContent,
    cards: document.querySelectorAll('.bd-card').length,
    edges: document.querySelectorAll('.bd-edge').length,
    stage: r ? [Math.round(r.width), Math.round(r.height)] : null,
    scale: (document.querySelector('.bd-cards') || {}).style ? document.querySelector('.bd-cards').style.transform : null,
  }
})()`)
console.log('  ' + JSON.stringify(info))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.mkdirSync('.cache', { recursive: true })
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
console.log(`  截图：${outPath}（摆法 ${want}）`)
ws.close()
process.exit(0)
