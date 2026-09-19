/* 白板交互体检：为什么"能看见但点不动"。
 *
 * 用系统浏览器（默认 Edge，见 scripts/lib/browser.js）+
 * CDP 的 Input.dispatchMouseEvent，把这几件事查清楚：
 *   ① 光标所在的那一层是不是 .bd-hit（不是的话，事件被别人吃了）
 *   ② pointerdown 到底有没有派到 .bd-hit 上
 *   ③ 各层的 z-index / pointer-events / 覆盖范围
 *   ④ 真按一下、真拖一段，画布上有没有墨
 * 最后截一张图，人眼也看一眼。
 *
 * 跑：node scripts/diag-interact.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { browserExe } from './lib/browser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'
const CDP_PORT = Number(process.env.CDP_PORT || 9227)
const CHROME = browserExe()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = path.join(ROOT, '.cache', 'interact-cdp')
fs.rmSync(profile, { recursive: true, force: true })
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, APP],
  { stdio: 'ignore' }
)
process.on('exit', () => {
  try {
    chrome.kill()
  } catch {}
})

let targets = null
for (let i = 0; i < 40; i++) {
  targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => null)
  if (targets && targets.find((t) => t.type === 'page' && t.url.startsWith('http'))) break
  await sleep(300)
}
const page = targets && targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('  Chrome 没起来')
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
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)

await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')
// 把页面里的报错全收下来 —— "点了没反应"十有八九是处理函数里抛了异常
const pageErrors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    pageErrors.push('异常：' + (d.exception?.description || d.text || '').split('\n').slice(0, 3).join(' | '))
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    pageErrors.push(m.params.type + '：' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 200))
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    pageErrors.push('log：' + m.params.entry.text.slice(0, 200))
  }
})
await send('Page.navigate', { url: APP })
await sleep(2600)

console.log('\n  当前页面：' + (await ev(`location.href`)))
console.log('  加载的 js：' + (await ev(`[...document.scripts].map(s=>s.src.split('/').pop()).filter(Boolean).join(',')`)))

/* ① 各层的几何 + 层级。重点看 .bd-hit 是不是真的盖在纸面上、以及有没有
      别的东西（面板/工具条）盖在它上面却又不该吃事件。 */
const layers = await ev(`(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      z: cs.zIndex, pe: cs.pointerEvents, pos: cs.position, cursor: cs.cursor, display: cs.display,
    }
  }
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    stagewrap: pick('.bd-stagewrap'), stage: pick('.bd-stage'),
    ink: pick('canvas.bd-ink'), hit: pick('.bd-hit'),
    tools: pick('.bd-tools'),
    cards: document.querySelectorAll('.bd-card').length,
    // 中间那片"应该能画"的位置，从上往下数三层是谁
    stack: (() => {
      const out = []
      for (const [x, y] of [[500, 400], [700, 500], [300, 700]]) {
        out.push([x, y, document.elementsFromPoint(x, y).slice(0, 4).map(e => e.className || e.tagName)])
      }
      return out
    })(),
  }
})()`)
console.log('\n  层级：')
for (const k of ['stagewrap', 'stage', 'ink', 'hit', 'tools']) {
  const v = layers[k]
  console.log('    ' + k.padEnd(10) + (v ? `rect=${JSON.stringify(v.rect)} z=${v.z} pe=${v.pe} pos=${v.pos} cursor=${v.cursor}` : '(没有)'))
}
console.log('\n  从上往下的元素（前 4 层）：')
for (const [x, y, names] of layers.stack) console.log(`    (${x},${y})  ` + names.join(' > '))

/* ② pointerdown 到底有没有派到 .bd-hit 上。
      这能分清"事件被别的东西吃了"和"事件派到了但处理函数没跑"。 */
await ev(`(() => {
  window.__probe = []
  const hit = document.querySelector('.bd-hit')
  if (hit) {
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'mousedown']) {
      hit.addEventListener(t, () => window.__probe.push(t), true)
    }
  }
  return 1
})()`)

const spot = { x: 500, y: 400 }
const under = await ev(`(() => { const e = document.elementFromPoint(${spot.x}, ${spot.y}); return e ? (e.className || e.tagName) : 'none' })()`)
console.log('\n  准备在 (' + spot.x + ',' + spot.y + ') 画：那一点上是「' + under + '」')

const inkBefore = await ev(`(() => { const cv=document.querySelector('canvas.bd-ink'); const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>20) n++; return n })()`)

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 15; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + i * 10, y: spot.y + Math.sin(i / 2) * 14, button: 'left', buttons: 1 })
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x + 150, y: spot.y, button: 'left', buttons: 0, clickCount: 1 })
await sleep(900)

const probe = await ev(`window.__probe`)
const inkAfter = await ev(`(() => { const cv=document.querySelector('canvas.bd-ink'); const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>20) n++; return n })()`)

console.log('  .bd-hit 收到的事件：' + (probe && probe.length ? probe.join(', ') : '（一个都没有）'))
console.log('  画布墨点：' + inkBefore + ' → ' + inkAfter + (inkAfter > inkBefore ? '  ✓ 能画' : '  ✗ 没画出墨'))
if (pageErrors.length) {
  console.log('\n  页面里的报错（' + pageErrors.length + ' 条）：')
  for (const e of pageErrors.slice(0, 8)) console.log('    ' + e)
} else {
  console.log('  页面里没有报错')
}

/* 事件只到 pointerdown 就停了 —— 说明"按下"之后的移动/抬起没送到。
   这一条专门验它：再按一次，把中间发生的事全记下来。 */
const trace = await ev(`(() => {
  const hit = document.querySelector('.bd-hit')
  const log = []
  const on = (t) => (e) => log.push(t + '#' + (e.pointerId ?? '?') + '/' + e.pointerType + (e.buttons !== undefined ? '/b' + e.buttons : ''))
  window.__trace = log
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'gotpointercapture']) {
    hit.addEventListener(t, on(t), true)
    document.addEventListener(t, (e) => { if (e.target !== hit) log.push('doc:' + t) }, true)
  }
  return 1
})()`)
void trace
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 300, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 620, y: 310, button: 'left', buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 320, button: 'left', buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 660, y: 330, button: 'left', buttons: 0, clickCount: 1 })
await sleep(500)
console.log('\n  一次完整按下的过程：' + JSON.stringify(await ev(`window.__trace`)))
console.log('  （缺 pointermove/pointerup 就说明"按住之后的移动没送到"——')
console.log('    那多半是 setPointerCapture 在这个环境里没生效，不是应用逻辑的问题）')

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true })
const out = path.join(ROOT, '.cache', 'interact-shot.png')
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log('  截图：' + path.relative(ROOT, out))

console.log('\n  ── 判断 ──')
if (!layers.hit) {
  console.log('  ✗ 没有 .bd-hit 这一层 —— 收事件的层没挂上')
} else if (probe && probe.length === 0) {
  console.log('  ✗ 鼠标事件根本没派到 .bd-hit 上 → 有别的元素盖在上面吃掉了事件')
  console.log('    上面「从上往下的元素」那一栏里，排在 bd-hit 前面的就是元凶')
} else if (inkAfter <= inkBefore) {
  console.log('  ✗ 事件派到了，但没画出墨 → 处理函数的问题（看浏览器控制台有没有报错）')
} else {
  console.log('  ✓ 这一条链路是通的：事件派得到、墨画得出')
}

ws.close()
chrome.kill()
process.exit(0)
