/* 检查"打开的页面到底是哪个版本"，必要时强刷一次。
 *
 * 为什么需要它：服务端发的是最新构建，但浏览器可能拿着几小时前的缓存 ——
 * 这时你会觉得"明明加了按钮却没有"。光看服务端文件是发现不了的，
 * 必须**去问那个页面自己**：它加载的是哪个 js、工具条里有哪些按钮。
 *
 * 用系统自带的 Edge（它支持 --remote-debugging-port=0，会自己挑一个空闲端口，
 * 所以不会跟别的工具抢端口）。跑完就关，不留窗口。
 *
 * 跑：node scripts/check-loaded.js
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { browserExe } from './lib/browser.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'

/* ── 夹具板：这一条自检**会真的画一笔**（"笔能不能用"只有真画一下才算验过）──────
   ⚠ 它原来画在"打开时列表里第一个 board-*.md"上 —— 那多半是**用户自己的板**。
     2026-09-16 实测就出了事：落点算到了底部工具条的按钮上（打印出来是 `bd-t on`），
     于是那一下不是在画画，是在**点工具** —— 点到橡皮的话，后面那 16 个 mouseMoved
     就变成了**擦除用户的笔迹**。自检把测试数据写进用户的数据里，是这个仓库反复
     强调过的红线（check-ocr-browser / check-board-browser 都为它造过夹具板）。
     现在：造一张自己的板（board- 前缀 + zz- 前缀，跑完删掉），点左栏那一行打开它；
     而且**落点不是 .bd-hit 就不画**（宁可不测这一条，也不在板上乱点）。 */
const FIXTURE_NAME = 'board-zz-loaded.md'
const FIXTURE_TITLE = 'board-zz-loaded'
const FIXTURE = path.join(ROOT, 'data', FIXTURE_NAME)
fs.writeFileSync(FIXTURE, serializeBoardDocument(newBoard('自检夹具（跑完自动删除）')), 'utf8')

const exe = browserExe() // Edge 优先，也认 CHROME_PATH，见 scripts/lib/browser.js
// 服务端现在发的是什么
const html = await fetch(APP).then((r) => r.text())
const served = (/assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html) || [])[1] || '(没找到 js 引用)'

const profile = path.join(os.tmpdir(), 'sh-loaded-probe')
fs.rmSync(profile, { recursive: true, force: true })
const chrome = spawn(exe, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, APP], {
  stdio: ['ignore', 'ignore', 'pipe'],
})
const cleanup = () => {
  try {
    chrome.kill()
  } catch {}
  // 夹具板是自己的东西，跑完必须删掉（中途崩了也要删）
  try {
    fs.rmSync(FIXTURE, { force: true })
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

// port=0 时浏览器会把实际端口写进 profile 里的 DevToolsActivePort
let port = null
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 300))
  try {
    const line = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim()
    if (line) {
      port = Number(line)
      break
    }
  } catch {}
}
if (!port) {
  console.error('  浏览器没起来')
  process.exit(2)
}

let page = null
for (let i = 0; i < 20; i++) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
  page = list.find((t) => t.type === 'page' && t.url.includes('5177'))
  if (page) break
  await new Promise((r) => setTimeout(r, 300))
}
if (!page) {
  console.error('  页面没打开')
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pend = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result?.result?.value)
    pend.delete(m.id)
  }
})
const ev = (expr) => new Promise((res) => {
  const i = ++id
  pend.set(i, res)
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
})
const send = (method, params = {}) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, params }))
}
await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 2500))

/* ★ 先换到自己的夹具板再动手。应用打开的是"列表里第一个 board-*.md"，
   那多半是用户自己的板 —— 而这个自检会真的往上画一笔。 */
{
  const pick = await ev(`(() => {
    const cur = (document.querySelector('.bd-file') || {}).textContent || ''
    if (cur.trim() === ${JSON.stringify(FIXTURE_NAME)}) return 'already'
    const row = [...document.querySelectorAll('.filerow')].find(
      (r) => ((r.querySelector('.fname') || {}).textContent || '').trim() === ${JSON.stringify(FIXTURE_TITLE)}
    )
    if (!row) return 'no-row'
    row.click()
    return 'clicked'
  })()`)
  if (pick === 'no-row') {
    console.error('\n  左栏里找不到夹具板 ' + FIXTURE_TITLE + ' —— 后面会往别人的板上画画，停在这里。\n')
    cleanup()
    process.exit(2)
  }
  if (pick === 'clicked') {
    await new Promise((r) => setTimeout(r, 1200))
    const now = await ev(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)
    console.log('  （夹具板：' + now + '）')
  }
}

/* ★ 真的画一笔。
   用户的抱怨是"笔也用不了"，那就不能只看 DOM 里有没有按钮 ——
   必须真的画一下、看画布上有没有墨。这一条是"仿冒打开"最值钱的部分。

   ⚠ 采样步长要够密：一条 2.5px 宽的线，在大画布上按每 5 个像素跳着采，
     很容易整条线都落在采样点之间 —— 于是"画出来了"被判成"画不出来"。
     第一版就是这么误报的（同一个应用在 Chrome 下明明能画）。
     两层画布都数：正在画的那一笔在 .bd-live 上，提交完才挪到 .bd-ink。 */
const countInk = `(() => {
  const out = {}
  for (const [name, sel] of [['scene', 'canvas.bd-ink'], ['live', 'canvas.bd-live']]) {
    const cv = document.querySelector(sel)
    if (!cv) { out[name] = -1; continue }
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++
    out[name] = n
  }
  return out
})()`
const inkBefore = await ev(countInk)

/* 画点必须落在**真正的空白纸面**上，不是"视口内"就行。
   板上压着两块浮层：右上角的关系面板、底下的工具条。
   第一版按 left/top 加偏移算出一个点，它正好落在关系面板上 —— 事件被面板吃掉，
   画布一点墨都没有，看起来就像"笔坏了"。
   2026-09-16 又踩了一次（这次落在**工具条的按钮**上，打印出来是 `bd-t on`）：
   那一下不是在画，是**点了一个工具**；点到橡皮的话，后面那 16 个 mouseMoved
   就变成擦除。所以现在：逐个候选点用 elementFromPoint 验，验不上就**不画**。 */
const spot = await ev(`(() => {
  const hit = document.querySelector('.bd-hit')
  if (!hit) return null
  const r = hit.getBoundingClientRect()
  const panel = document.querySelector('.bd-cpanel') ? document.querySelector('.bd-cpanel').getBoundingClientRect() : null
  const bar = document.querySelector('.bd-tools') ? document.querySelector('.bd-tools').getBoundingClientRect() : null
  for (const fy of [0.88, 0.8, 0.72, 0.94, 0.62]) {
    for (const fx of [0.06, 0.12, 0.2, 0.3]) {
      const x = Math.round(r.left + r.width * fx)
      const y = Math.round(r.top + r.height * fy)
      if (panel && x > panel.left - 8) continue
      if (bar && y > bar.top - 10) continue
      const el = document.elementFromPoint(x, y)
      if (el && el.classList && el.classList.contains('bd-hit')) return { x: x, y: y }
    }
  }
  return null
})()`)

let inkAfter = { scene: -1, live: -1 }
let skipped = false
if (!spot) {
  console.log('  落点检查     ：浮层把这一带占满了，找不到真正的空白纸面 —— 这一条跳过（不画）')
  skipped = true
} else {
  const x0 = spot.x
  const y0 = spot.y
  console.log('  落点检查     ：(' + x0 + ',' + y0 + ') 上确实是 bd-hit（空白纸面）')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 16; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + i * 8, y: y0 + Math.sin(i / 2) * 12, button: 'left', buttons: 1 })
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 128, y: y0, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise((r) => setTimeout(r, 900))
  inkAfter = await ev(countInk)

  /* 如果 CDP 合成的鼠标事件没画出墨，得先分清是**应用不响应**还是
     **浏览器不把合成鼠标事件派成 pointer 事件**（后者是环境问题，不是 bug）。
     办法：直接在页面里派发一串 PointerEvent，看 React 收不收得到。
     两件事分开测，才不会把环境问题当成功能坏了。 */
  if (inkAfter.scene <= inkBefore.scene) {
    const afterSynthetic = await ev(`(() => {
      const hit = document.querySelector('.bd-hit')
      if (!hit) return null
      const r = hit.getBoundingClientRect()
      const x = r.left + 60
      const y = r.bottom - 60
      const mk = (type, cx, cy) => new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'pen', isPrimary: true, buttons: 1, pressure: 0.5,
        clientX: cx, clientY: cy,
      })
      hit.dispatchEvent(mk('pointerdown', x, y))
      for (let i = 1; i <= 14; i++) hit.dispatchEvent(mk('pointermove', x + i * 8, y - Math.sin(i / 2) * 10))
      hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'pen', isPrimary: true, buttons: 0, clientX: x + 112, clientY: y }))
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 700))
    const inkSynthetic = await ev(countInk)
    console.log('  手动派发     ：' + (afterSynthetic ? '笔迹层 ' + inkAfter.scene + '→' + inkSynthetic.scene + (inkSynthetic.scene > inkAfter.scene ? '  ✓ 应用收得到（那就是 CDP 合成事件的问题，不是应用）' : '  ✗ 应用收不到 —— 这才是真问题') : '(没有 .bd-hit)'))
    inkAfter = inkSynthetic
  }
}

const info = await ev(`(() => ({
  js: [...document.scripts].map(s => s.src.split('/').pop()).filter(Boolean),
  board: !!document.querySelector('.bd'),
  toolbar: [...document.querySelectorAll('.bd-tools .bd-t')].map(b => b.textContent.trim()),
  canvases: document.querySelectorAll('canvas').length,
  stageH: (document.querySelector('.bd-stagewrap') || {}).clientHeight,
}))()`)

console.log('\n  服务端发的 js ：' + served)
console.log('  页面加载的 js：' + (info.js.join(', ') || '(无)'))
console.log('  白板挂上了吗 ：' + (info.board ? '是' : '否'))
console.log('  工具条按钮   ：' + (info.toolbar.join(' | ') || '(没有工具条)'))
console.log('  画布层数     ：' + info.canvases + '，画布高 ' + info.stageH + 'px')
console.log('  画一笔       ：笔迹层 ' + inkBefore.scene + '→' + inkAfter.scene + '，实时层 ' + inkBefore.live + '→' + inkAfter.live +
  (inkAfter.scene > inkBefore.scene ? '  ✓ 画得出来' : inkBefore.scene < 0 ? '  （没有画布）' : '  ✗ 没画出墨'))
console.log('')
const fresh = info.js.includes(served)
const hasBtn = info.toolbar.some((t) => t.includes('手写公式'))
const canDraw = skipped || inkBefore.scene < 0 || inkAfter.scene > inkBefore.scene
if (fresh && hasBtn && canDraw) {
  console.log('  ✓ 全新打开完全正常：最新 js + 有「手写公式」+ 笔能画')
  console.log('    → 你那个窗口是缓存了旧版。硬刷一次就好：Ctrl+Shift+R（或 Ctrl+F5）')
} else {
  const why = []
  if (!fresh) why.push('加载的不是最新 js（服务端发的 ' + served + '）')
  if (!hasBtn) why.push('工具条里没有「手写公式」')
  if (!canDraw) why.push('画不出墨（笔迹层没变）')
  console.log('  ✗ 全新打开也不对：' + why.join('；'))
  console.log('    → 这不是缓存问题。先 npm run build，再跑 npm run check:board-browser')
}

cleanup()
process.exit(0)
