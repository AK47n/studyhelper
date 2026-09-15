/* 拿**真笔迹**试一次真的识别服务（会真的出网、消耗一点额度）。
 *
 * 存在的理由：/api/ocr/test 发的是一张留白图 —— 它只能证明"鉴权过了"，
 * 证明不了"手写公式认得出来"。而后者才是这个功能成不成立的关键。
 * 这个脚本在写字板上画一笔**真的像公式**的笔迹，走完整条链路，
 * 把识别结果和实际发出去的图一起报出来。
 *
 * 跑：node scripts/try-ocr.js            （画 "F = ma"）
 *     node scripts/try-ocr.js "x^2+1"    （换一个形状）
 *
 * 前提：服务在跑（npm start），config/ocr.json 里已经配好密钥。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'
const CDP_PORT = Number(process.env.CDP_PORT || 9226)
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const want = process.argv[2] || 'x+1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 用几条折线"手写"出一段形状，坐标是 0..1 的相对位置。
 *
 * ⚠ 这些形状是**测试数据**。踩过的坑，记在这里省得以后再走一遍：
 *   ① 我一度想用手搓的数学曲线去"画"出字母（贝塞尔弧线拼 m、a）。
 *      结果是 —— 画出来根本不像字，而我却在拿它判"模型准不准"。
 *      那是兔子洞：测出来的是**我的画法**，不是模型的能力。
 *   ② 所以这里的形状都选**几何上简单、不容易画错**的那些：
 *      横、竖、斜线、等号、加号、数字、单字母。复杂字母（m、a、∫）不硬画。
 *
 * 真实的手写准确率只能由**你自己的笔迹**来判 —— 跑 `node scripts/try-ocr.js`
 * 只是确认"链路通、格式对、能出 LaTeX"，不是准确率评测。
 * 出结果不对时，先看它存下来的那张图（.cache/ocr-sent.png）：
 * 十有八九是形状本身就不像那个字。 */
const SHAPES = {
  'x+1': [
    [[0.12, 0.38], [0.24, 0.66]], // x
    [[0.24, 0.38], [0.12, 0.66]],
    [[0.36, 0.52], [0.46, 0.52]], // +
    [[0.41, 0.42], [0.41, 0.62]],
    [[0.58, 0.32], [0.58, 0.66]], // 1
    [[0.58, 0.32], [0.54, 0.38]], // 1 的小起笔
  ],
  'F=ma': [
    [[0.06, 0.20], [0.06, 0.80]], // F 竖
    [[0.06, 0.20], [0.18, 0.20]], // F 上横
    [[0.06, 0.47], [0.16, 0.47]], // F 中横
    [[0.26, 0.45], [0.37, 0.45]], // =
    [[0.26, 0.57], [0.37, 0.57]], // =
    [[0.46, 0.66], [0.46, 0.40], [0.49, 0.36], [0.52, 0.40], [0.52, 0.66]], // m 左拱
    [[0.52, 0.40], [0.55, 0.36], [0.58, 0.40], [0.58, 0.66]], // m 右拱
    [[0.68, 0.44], [0.72, 0.40], [0.74, 0.46], [0.74, 0.62], [0.71, 0.66], [0.68, 0.62], [0.68, 0.48]], // a 肚子
    [[0.74, 0.42], [0.75, 0.62], [0.78, 0.66]], // a 竖和尾巴
  ],
  '4x+2': [
    [[0.22, 0.30], [0.10, 0.60], [0.26, 0.60]], // 4 的斜竖和横
    [[0.22, 0.25], [0.22, 0.74]], // 4 的长竖
    [[0.34, 0.40], [0.46, 0.68]], // x
    [[0.46, 0.40], [0.34, 0.68]],
    [[0.54, 0.52], [0.64, 0.52]], // +
    [[0.59, 0.42], [0.59, 0.62]],
    [[0.74, 0.36], [0.80, 0.40], [0.82, 0.48], [0.74, 0.62], [0.72, 0.66]], // 2 的弯
    [[0.72, 0.66], [0.84, 0.66]], // 2 的底横
  ],
  'B=I/r': [
    [[0.08, 0.25], [0.08, 0.72]], // B 竖
    [[0.08, 0.25], [0.18, 0.28], [0.18, 0.45], [0.08, 0.47]], // B 上肚
    [[0.08, 0.47], [0.19, 0.50], [0.19, 0.70], [0.08, 0.72]], // B 下肚
    [[0.30, 0.47], [0.40, 0.47]], // =
    [[0.30, 0.59], [0.40, 0.59]], // =
    [[0.50, 0.28], [0.50, 0.70]], // I
    [[0.60, 0.45], [0.68, 0.62]], // /
    [[0.76, 0.45], [0.76, 0.68]], // r 竖
    [[0.76, 0.45], [0.83, 0.42], [0.84, 0.48]], // r 的肩
  ],
}

const shape = SHAPES[want] || SHAPES['x+1']

const userDataDir = path.join(ROOT, '.cache', 'try-cdp')
fs.rmSync(userDataDir, { recursive: true, force: true })
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1200,800', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, APP],
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
await send('Page.navigate', { url: APP })
await sleep(2600)

const status = await fetch(APP + 'api/ocr/status').then((r) => r.json())
console.log(`\n  当前配置：${status.provider} · ${status.model} · ${status.endpoint}`)
if (!status.configured) {
  console.error('  还没配密钥，先去设置里填\n')
  process.exit(2)
}

await ev(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /手写公式/.test(x.textContent)); b.click(); return 1 })()`)
await sleep(500)

const box = await ev(`(() => { const r = document.querySelector('.wp-pad').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
for (const pts of shape) {
  const [sx, sy] = pts[0]
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + box.w * sx, y: box.y + box.h * sy, button: 'left', buttons: 1, clickCount: 1 })
  for (const [px, py] of pts.slice(1)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.w * px, y: box.y + box.h * py, button: 'left', buttons: 1 })
  }
  const [ex, ey] = pts[pts.length - 1]
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.w * ex, y: box.y + box.h * ey, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(40)
}
await sleep(300)
console.log('  写的是：' + want + `（${shape.length} 笔）`)

const t0 = Date.now()
await ev(`(() => { const b = [...document.querySelectorAll('.wp-acts .btn')].find(x => /识别/.test(x.textContent)); b.click(); return 1 })()`)
// 等结果（真服务有网络延迟）
let got = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  got = await ev(`(() => {
    const err = document.querySelector('.wp-err')
    const res = document.querySelector('.wp-res')
    return {
      err: err ? { text: err.textContent, cls: err.className } : null,
      latex: res ? (document.querySelector('.wp-res .wp-edit') || {}).value : null,
      katex: res ? res.querySelectorAll('.katex').length : 0,
      busy: !!([...document.querySelectorAll('.wp-acts .btn')].find(b => /识别中/.test(b.textContent))),
    }
  })()`)
  if (got && (got.err || got.latex)) break
}
const ms = Date.now() - t0

console.log('\n  ── 结果 ──')
if (got?.err) {
  console.log('  ✗ 失败了：' + got.err.text)
} else if (got?.latex != null) {
  console.log(`  用时 ${ms}ms`)
  console.log('  认出来：' + JSON.stringify(got.latex))
  console.log('  渲染：' + (got.katex > 0 ? '✓ 成功（' + got.katex + ' 块）' : '✗ 没渲染出来'))
} else {
  console.log('  没等到结果（超时）')
}

// 把发出去的那张图存下来 —— 出问题时第一件事就是看它
const dataUrl = await ev(`(() => {
  const cv = document.querySelector('canvas.wp-pad')
  return cv ? cv.toDataURL('image/png') : null
})()`)
if (dataUrl) {
  const out = path.join(ROOT, '.cache', 'ocr-sent.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('  画的东西存在：' + path.relative(ROOT, out))
}

ws.close()
chrome.kill()
process.exit(0)
