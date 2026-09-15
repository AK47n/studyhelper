/* 截一张写字板的图（含识别结果）。
 * 跑：node scripts/shot-pad.js [输出路径]
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractFilePart } from '../src/lib/multipart.js'
import { browserExe } from './lib/browser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const APP_PORT = 5182
const MOCK_PORT = 5197
const CDP_PORT = 9225
const APP = `http://127.0.0.1:${APP_PORT}/`
const out = process.argv[2] || '.cache/pad-shot.png'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mock = http.createServer((req, res) => {
  const cs = []
  req.on('data', (c) => cs.push(c))
  req.on('end', () => {
    // 故意拖一下，让"识别中…"这个状态有机会被截到
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: true, res: { latex: 'B = \\frac{\\mu_{0} I}{2\\pi r}', conf: 0.88 }, request_id: 'shot' }))
    }, 500)
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r))
void extractFilePart

const srv = spawn(process.execPath, ['server.js', '--no-open', '--no-auto-exit'], {
  cwd: ROOT,
  env: {
    ...process.env,
    STUDYHELPER_PORT: String(APP_PORT),
    STUDYHELPER_OCR_BASE: `http://127.0.0.1:${MOCK_PORT}/api/latex_ocr`,
    STUDYHELPER_OCR_TOKEN: 'shot-token-abcdefgh',
  },
  stdio: 'ignore',
})
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(APP + 'api/list')).ok) break
  } catch {}
  await sleep(250)
}

const userDataDir = path.join(ROOT, '.cache', 'shot-cdp')
fs.rmSync(userDataDir, { recursive: true, force: true })
const chrome = spawn(
  browserExe(),
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, APP],
  { stdio: 'ignore' }
)

let targets = null
for (let i = 0; i < 40; i++) {
  targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => null)
  if (targets && targets.find((t) => t.type === 'page' && t.url.startsWith('http'))) break
  await sleep(300)
}
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
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
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result?.value)

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: APP })
await sleep(2500)

await ev(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /手写公式/.test(x.textContent)); b.click(); return 1 })()`)
await sleep(500)

// 写一个"B = mu0 I / 2 pi r"的样子（手写风格的多笔）
const box = await ev(`(() => { const r = document.querySelector('.wp-pad').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
const strokes = [
  [[0.12, 0.35], [0.16, 0.62], [0.20, 0.35], [0.24, 0.35]],
  [[0.30, 0.45], [0.37, 0.45]],
  [[0.45, 0.32], [0.45, 0.62], [0.52, 0.62], [0.52, 0.32], [0.45, 0.32]],
  [[0.60, 0.30], [0.60, 0.66]],
  [[0.68, 0.40], [0.72, 0.66]],
  [[0.80, 0.35], [0.80, 0.66], [0.86, 0.40]],
]
for (const pts of strokes) {
  const [sx, sy] = pts[0]
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + box.w * sx, y: box.y + box.h * sy, button: 'left', buttons: 1, clickCount: 1 })
  for (const [px, py] of pts.slice(1)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.w * px, y: box.y + box.h * py, button: 'left', buttons: 1 })
  }
  const [ex, ey] = pts[pts.length - 1]
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.w * ex, y: box.y + box.h * ey, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(60)
}
await sleep(300)

await ev(`(() => { const b = [...document.querySelectorAll('.wp-acts .btn')].find(x => /识别/.test(x.textContent)); b.click(); return 1 })()`)
await sleep(1500)

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(`  截图：${out}（${Math.round(fs.statSync(out).size / 1024)} KB）`)
console.log('  状态：' + (await ev(`document.querySelector('.wp-res') ? '认出来了' : '没有结果区'`)))

ws.close()
chrome.kill()
srv.kill()
mock.close()
process.exit(0)
