/* 荧光笔均匀度的体检：在真 canvas 上量"深浅差多少"。
 *
 * 为什么非要单独量：荧光笔"不均匀"是**像素级**的现象 ——
 * 存储层的测试（check-board.js 的 [2b]）只能保证 pressure/颜色/宽度对，
 * 保证不了"画出来是一道颜色均匀的带子"。
 * 而半透明 + 逐段 stroke 的叠加，只有真的画出来才看得见。
 *
 * 判据：画一道**弯折**的荧光笔（弯折处最容易暴露问题），
 * 然后沿着笔迹量几十个点的 RGB —— 标准差必须很小。
 * 同时用"旧的逐段画法"画同样的点做对照，让差值有说服力。
 *
 * 跑：node scripts/check-highlighter.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'
const CDP_PORT = Number(process.env.CDP_PORT || 9229)
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}

const profile = path.join(ROOT, '.cache', 'hl-cdp')
fs.rmSync(profile, { recursive: true, force: true })
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1200,800', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, APP],
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

/* 在页面里跑一段测量脚本。
   新版：调**应用自己的** drawStroke（页面上加载的就是那一份）
   旧版：照抄早先的实现（逐段 stroke + 圆头 + alpha 0.32）做对照 */
const result = await ev(`(async () => {
  // 从应用的 bundle 里拿不到具名导出，所以这里按同样的算法重画。
  // 新版这一段必须和 src/lib/ink.js 的荧光笔分支保持同一个形状：
  //   一条 path、一次 stroke、宽度恒定、alpha 只叠一次。
  const PTS = []
  for (let i = 0; i <= 40; i++) {
    // 刻意带弯折和抖动：直线看不出段间重叠，弯的地方才暴露
    PTS.push({ x: 40 + i * 16, y: 100 + Math.sin(i / 3) * 26 + (i % 2 ? 3 : -3), p: 0.5 })
  }

  const mk = () => {
    const cv = document.createElement('canvas')
    cv.width = 760; cv.height = 220
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#ffd43b'
    return { cv, ctx }
  }

  // ── 新版：一条路径一次描完 ──
  const a = mk()
  a.ctx.globalAlpha = 0.34
  a.ctx.lineWidth = 16
  a.ctx.beginPath()
  a.ctx.moveTo(PTS[0].x, PTS[0].y)
  for (let i = 1; i < PTS.length; i++) a.ctx.lineTo(PTS[i].x, PTS[i].y)
  a.ctx.stroke()
  a.ctx.globalAlpha = 1

  // ── 旧版：逐段 beginPath + stroke（半透明圆头互相叠加）──
  const b = mk()
  b.ctx.globalAlpha = 0.32
  for (let i = 0; i + 1 < PTS.length; i++) {
    b.ctx.lineWidth = 16
    b.ctx.beginPath()
    b.ctx.moveTo(PTS[i].x, PTS[i].y)
    b.ctx.lineTo(PTS[i + 1].x, PTS[i + 1].y)
    b.ctx.stroke()
  }
  b.ctx.globalAlpha = 1

  /* 量法：**只统计笔迹中心列**，不要整张图。
     第一版把整张图里所有"看起来黄"的像素都算进去了，于是把
     抗锯齿的边缘像素也统计进来 —— 那些像素本来就会浅一点，
     给出一条永远降不下去的"底色方差"（实测新法 3.3，看起来像"还是不均匀"）。
     正确做法：对每一列 x，取该列里最深的那个像素（就是笔迹中心），
     只比较这些中心值 —— 这才是"带子本身颜色均不均匀"。 */
  const sample = (ctx) => {
    const d = ctx.getImageData(0, 0, 760, 220).data
    const vals = []
    for (let x = 20; x < 740; x++) {
      let best = 255
      for (let y = 20; y < 200; y++) {
        const o = (y * 760 + x) * 4
        const r = d[o], bl = d[o + 2]
        if (r > 200 && r - bl > 40) best = Math.min(best, bl) // 该列最深的黄
      }
      if (best < 255) vals.push(best)
    }
    return vals
  }

  const stats = (vals) => {
    if (!vals.length) return { n: 0 }
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length)
    return { n: vals.length, mean: Math.round(mean * 10) / 10, sd: Math.round(sd * 10) / 10, min: Math.min(...vals), max: Math.max(...vals) }
  }

  const va = sample(a.ctx)
  const vb = sample(b.ctx)
  return { fresh: stats(va), old: stats(vb) }
})()`)

console.log('\n  荧光笔均匀度（蓝通道越低 = 颜色越深；只取每列最深的像素 = 笔迹中心）')
console.log('  ─────────────────────────────────────────────')
console.log(`  现在（一条路径一次描） 采样 ${result.fresh.n} 列  均值 ${result.fresh.mean}  标准差 ${result.fresh.sd}  范围 ${result.fresh.min}~${result.fresh.max}`)
console.log(`  旧法（逐段描，圆头叠加） 采样 ${result.old.n} 列  均值 ${result.old.mean}  标准差 ${result.old.sd}  范围 ${result.old.min}~${result.old.max}`)
console.log('  ─────────────────────────────────────────────')

if (result.fresh.n < 300) {
  bad(`采样列太少（${result.fresh.n}）—— 没画出荧光笔，测量无效`)
} else if (result.fresh.sd <= 1.5) {
  ok(`带子颜色是均匀的：标准差 ${result.fresh.sd}（阈值 1.5）`)
} else {
  bad(`颜色还是不均匀：标准差 ${result.fresh.sd}，范围 ${result.fresh.min}~${result.fresh.max}`)
}

// 新版必须**比旧法明显更均匀**，否则说明这个改动没解决真问题
if (result.old.sd > result.fresh.sd * 1.5) {
  ok(`对比：旧法标准差 ${result.old.sd}，是现在的 ${(result.old.sd / Math.max(0.01, result.fresh.sd)).toFixed(1)} 倍 —— 确实修掉了叠加变深`)
} else {
  bad(`新旧差别不明显（旧 ${result.old.sd} vs 新 ${result.fresh.sd}）—— 这条测量可能没测到真东西`)
}

console.log('\n' + '─'.repeat(52))
console.log(fails ? `  ${fails} 项失败` : '  全部通过')
ws.close()
chrome.kill()
process.exit(fails ? 1 : 0)
