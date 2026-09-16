/* 纸面（白板的背景）：纯白 / 方格 / 横线 / 点阵 —— 用真浏览器盯住五条用户真正在意的：
 *   ① 四个按钮在工具条上、点得动、选中的那一个亮着；
 *   ② 每种纸**真的画出来了**（像素证明：纯白那块区域一个暗点都没有，
 *      有底纹的那几种能在一小块里读到明显更暗的像素）；
 *   ③ ★ **底纹和墨迹是同一个变换**（格距 = 世界格距 × 视图缩放，原点落在世界原点上）
 *      —— 平移、缩放之后仍然成立。也就是说"字就在纸上，一起动"；
 *   ④ 换了之后**重开还是它**（存在 localStorage 里，不是存在板文件里）；
 *   ⑤ 换纸**一个字都不动你的板文件**（板文件是内容，纸是"我怎么看"）。
 *
 * 两轮用户反馈合起来就是这份自检的由来：
 *   2026-09-16「现在白板背景是十字格子纸，可以改成纯白纸，或者说有几种类型的背景
 *              让用户去选择」→ 四档可挑、默认纯白（第 ①②④⑤ 条）。
 *   2026-09-16「平移的时候有一种背景不动字动的感觉，我要的是字就在背景上，
 *              字跟着背景一起动」→ 第 ③ 条。上一版底纹是"贴在屏幕上的纹理"
 *              （写死 32px），于是墨迹在走、格线钉在屏幕上 —— 那一条就是把它钉住。
 *
 * 为什么这也要单独一条自检：纸面的故障全是**静默**的 ——
 * 类名换了但 CSS 没跟上（纸变成"没有底纹"却显示成选中了某一档）、
 * 格距写死回 px（平移时又变成"背景不动"）、原点没跟着视图走（格线整体偏半格）……
 * 这些都不报错，也不影响画和存，只有"看一眼屏幕 / 量一下数字"才知道。
 *
 * 它自己起服务（5201）和 headless Edge（9231），跑完都收掉；
 * 全程只碰自己造的夹具板 board-zz-papercheck.md，用户的板一个字节都不动。
 *
 * 用法：node scripts/check-paper.js    （或 npm run check:paper）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { browserExe } from './lib/browser.js'
import { waitForAppPage } from './lib/cdp.js'
import { BOARD_PREFIX, parseBoardDocument, serializeBoardDocument } from '../src/lib/board.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA = path.join(ROOT, 'data')
const PORT = Number(process.env.TEST_PORT || 5201)
const CDP_PORT = Number(process.env.TEST_CDP || 9231)
const CDP = `http://127.0.0.1:${CDP_PORT}`
const APP = `http://127.0.0.1:${PORT}/`

let fails = 0
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => {
  fails++
  console.log('  \u2717 ' + m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol) => Math.abs(a - b) <= tol

/* 四档纸的"应该长什么样"。和 Board.jsx 的 PAPERS / styles.css 的 .paper-* 一一对应。
 * gradients：computed backgroundImage 里应该出现几个 gradient（纯白是 0 = none）。
 * tile：**世界坐标**里的格距（0 = 没有底纹）。屏幕格距必须是 tile × 视图缩放 ——
 *       这一条就是"字在纸上"的全部内容，也是"背景不动"那个 bug 的判据。 */
const PAPERS = [
  { id: 'plain', name: '纯白', gradients: 0, tile: 0, radial: false },
  { id: 'grid', name: '方格', gradients: 2, tile: 32, radial: false },
  { id: 'rule', name: '横线', gradients: 1, tile: 32, radial: false, noVlines: true },
  { id: 'dots', name: '点阵', gradients: 1, tile: 24, radial: true },
]

/* ── 夹具板：一张**空**板（0 笔 0 卡）──
 * 故意要空的：底纹要在真的空白处才量得准。板上有卡片时那些浮层会挡住采样点，
 * 而且量到的可能是卡片的底色（白）而不是纸的颜色。
 * board- 前缀 + zz 保证排在 data/ 里所有文件前面；跑完删掉，中途报错也删。 */
const FIXTURE_NAME = BOARD_PREFIX + 'zz-papercheck.md'
const FIXTURE_TITLE = BOARD_PREFIX + 'zz-papercheck'
const FIXTURE = path.join(DATA, FIXTURE_NAME)
fs.writeFileSync(FIXTURE, serializeBoardDocument(parseBoardDocument('', '纸面自检夹具（跑完自动删除）')), 'utf8')
process.on('exit', () => {
  try {
    fs.rmSync(FIXTURE, { force: true })
  } catch {}
})

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.exceptions.push((d.exception?.description || d.text || '').split('\n').slice(0, 2).join(' | '))
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.exceptions.push('console.error：' + msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 160))
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 20000)
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 出错')
    return r.result.value
  }
  /* 真鼠标：平移靠它。⚠ 不沾指针的东西用 eval 就够了，
     但"拖一下能不能推动视图"只有真事件能证明（见 README 第 11 条）。 */
  async drag(x0, y0, dx, dy, { steps = 8, button = 'middle' } = {}) {
    const buttons = button === 'middle' ? 4 : 1
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button, buttons, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps, button, buttons })
      await sleep(12)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button, buttons: 0 })
    await sleep(260)
  }
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
}

const server = spawn(process.execPath, ['server.js', '--no-auto-exit', '--no-open'], {
  cwd: ROOT,
  env: { ...process.env, STUDYHELPER_PORT: String(PORT) },
  stdio: 'ignore',
})
let edge = null
const cleanup = () => {
  for (const p of [edge, server]) {
    try {
      if (p && !p.killed) p.kill()
    } catch {}
  }
}
process.on('exit', cleanup)

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(APP + 'api/list').then((x) => x.ok).catch(() => false)
    if (r) return true
    await sleep(200)
  }
  return false
}

/* 每次都用**全新的浏览器档案**：纸面存在 localStorage 里，
   老档案留着偏好，就量不到"第一次打开默认是纯白"这一条。 */
const profile = path.join(os.tmpdir(), `studyhelper-paper-${CDP_PORT}`)
try {
  fs.rmSync(profile, { recursive: true, force: true })
} catch {}
edge = spawn(
  browserExe(),
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1440,900',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    APP,
  ],
  { stdio: 'ignore' }
)

if (!(await waitServer())) bad('服务没起来（' + APP + '）')
else ok('服务起来了：' + APP)

const page = await waitForAppPage(CDP, { appUrl: APP })
if (!page) {
  bad('等不到浏览器里的应用页（CDP ' + CDP + '）')
  console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
const s = new Session(ws)
await s.send('Runtime.enable')
await s.send('Page.enable')

/* 页面里读一次"纸面现在长什么样"。
   格距和原点用 **computed style**（那才是真正画出来的值，不是我们写进去的字符串）；
   视图从 canvas 的 dataset.xform 读（"dpr*s, dpr*tx, dpr*ty"，BoardCanvas 写的，
   和墨迹/卡片用的是同一个变换 —— 拿它来对账才有意义）。
   ★ 别改成读 inline style：那样只能证明"我们写了什么"，证明不了"浏览器认不认"。 */
const PROBE = `(() => {
  const wrap = document.querySelector('.bd-stagewrap')
  const bd = document.querySelector('.bd')
  const cv = document.querySelector('canvas.bd-ink')
  if (!wrap || !bd || !cv) return null
  const cs = getComputedStyle(wrap)
  const nums = (str) => (String(str || '').match(/-?[\\d.]+/g) || []).map(Number)
  const xf = nums(cv.dataset.xform)          // [dpr*s, dpr*tx, dpr*ty]
  const dpr = window.devicePixelRatio || 1
  return {
    cls: bd.className,
    img: cs.backgroundImage,
    color: cs.backgroundColor,
    size: nums(cs.backgroundSize),           // 方格/点阵两层 → [a,b, a,b]；横线 → [100, b]
    pos: nums(cs.backgroundPosition),        // 同上，一层一份
    s: xf[0] / dpr,
    tx: xf[1] / dpr,
    ty: xf[2] / dpr,
    dpr,
    on: [...document.querySelectorAll('.bd-paper')].filter((b) => b.classList.contains('on')).map((b) => b.dataset.paper),
    btns: [...document.querySelectorAll('.bd-paper')].map((b) => b.dataset.paper),
    saved: (() => { try { return localStorage.getItem('studyhelper.paper') } catch { return '(读不了)' } })(),
    padImg: (() => { const el = document.querySelector('.wp-padwrap'); return el ? getComputedStyle(el).backgroundImage : null })(),
    file: ((document.querySelector('.bd-file') || {}).textContent || '').trim(),
    cover: !!document.querySelector('.cover'),
  }
})()`

/* 把 PROBE 的结果整理成"纸面的几何"：每轴的格距、原点，外加视图那两个数。
   横线那一档横向没有线（background-size 的宽度是 100%），所以 tileX = null。
   ⚠ tx/ty 一定要带上：锚定判据是"原点 + 整数格 = 视图平移"，两边都得有。 */
function geom(g, p) {
  return {
    tileX: p.noVlines ? null : g.size[0],
    tileY: g.size[1],
    posX: g.pos[0],
    posY: g.pos[1],
    tx: g.tx,
    ty: g.ty,
    s: g.s,
  }
}

/* 锚定误差：底纹的原点应该正好落在世界原点上 —— 也就是 (视图平移 − 底纹原点)
   是格距的整数倍。返回"离最近的整格差多少像素"。
   ★ 这一条就是"字在纸上"的判据：上一版底纹钉在屏幕上，平移之后视图平移变了、
   底纹原点没变，这个差值立刻就不是整数倍（实测能差半格多）。 */
function anchorErr(g, axis) {
  const tile = axis === 'x' ? g.tileX : g.tileY
  const pos = axis === 'x' ? g.posX : g.posY
  const t = axis === 'x' ? g.tx : g.ty
  if (!(tile > 0) || !Number.isFinite(pos) || !Number.isFinite(t)) return null
  const d = (((t - pos) % tile) + tile) % tile
  return Math.min(d, tile - d)
}

/* "差多少才算是同一格" —— 取模之后比较两个位移：把差值折进 [0, tile/2]，够小就是同一个。 */
function modDiff(delta, tile) {
  if (!(tile > 0)) return Math.abs(delta)
  const d = (((delta % tile) + tile) % tile)
  return Math.min(d, tile - d)
}

/* 一档纸的几何自检：格距 = 世界格距 × 缩放、原点锚在世界原点上。
   label 用来区分"刚开始 / 平移之后 / 缩放之后"。 */
function checkGeometry(label, g, p) {
  const gm = geom(g, p)
  if (p.tile === 0) return
  const wantX = p.noVlines ? null : p.tile * g.s
  const wantY = p.tile * g.s
  if (wantX !== null) {
    if (near(gm.tileX, wantX, 0.05)) ok(`${label}：横向格距 ${gm.tileX.toFixed(2)}px = 世界 ${p.tile} × 缩放 ${g.s.toFixed(3)}`)
    else bad(`${label}：横向格距是 ${gm.tileX}px，应该是 世界格距 ${p.tile} × 缩放 ${g.s.toFixed(3)} = ${wantX.toFixed(2)}px`)
  }
  if (near(gm.tileY, wantY, 0.05)) ok(`${label}：纵向格距 ${gm.tileY.toFixed(2)}px = 世界 ${p.tile} × 缩放 ${g.s.toFixed(3)}`)
  else bad(`${label}：纵向格距是 ${gm.tileY}px，应该是 ${wantY.toFixed(2)}px`)
  for (const axis of ['x', 'y']) {
    const e = anchorErr(gm, axis)
    if (e === null) continue
    if (e <= 0.5) ok(`${label}：${axis} 方向锚在世界原点上（离最近的整格差 ${e.toFixed(2)}px）`)
    else bad(`${label}：${axis} 方向没跟视图走（离最近的整格差 ${e.toFixed(2)}px）—— 格线没和墨迹用同一个变换`)
  }
}

/* 找一块**真的空白**的纸面（中心和四角都要命中 .bd-hit）。
   平移要落在这里，采样也要落在这里 —— 落在卡片/提示框/工具条上就不是"在纸上"了。 */
async function findPaperSpot(half) {
  return s.eval(`(() => {
    const hit = document.querySelector('.bd-hit')
    const wrap = document.querySelector('.bd-stagewrap')
    if (!hit || !wrap) return null
    const r = wrap.getBoundingClientRect()
    const half = ${Math.round(half)}
    for (const fy of [0.12, 0.18, 0.26, 0.34, 0.42, 0.5, 0.6, 0.7, 0.8]) {
      for (const fx of [0.06, 0.14, 0.24, 0.34, 0.46, 0.58, 0.7]) {
        const x = Math.round(r.left + r.width * fx)
        const y = Math.round(r.top + r.height * fy)
        const pts = [[x, y], [x - half, y - half], [x + half, y - half], [x - half, y + half], [x + half, y + half]]
        if (pts.every(([px, py]) => document.elementFromPoint(px, py) === hit)) return { x, y, half }
      }
    }
    return null
  })()`)
}

let st = null
for (let i = 0; i < 60; i++) {
  st = await s.eval(PROBE).catch(() => null)
  if (st && !st.cover) break
  await sleep(250)
}
if (!st) {
  bad('白板界面没挂上（找不到 .bd-stagewrap）—— 后面的断言都没意义了')
  console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
  process.exit(1)
}

/* 先把打开的板换成夹具 —— 应用打开时挑"列表里第一个 board-*.md"，
   而"data/ 里一张板都没有"时它会自己补一张 board-新白板.md（中文名排序在前），
   夹具就选不上。从左栏点它一行：这是用户真实的操作路径，不依赖排序。 */
{
  const pick = await s.eval(`(() => {
    const cur = (document.querySelector('.bd-file') || {}).textContent || ''
    if (cur.trim() === ${JSON.stringify(FIXTURE_TITLE + '.md')}) return 'already'
    const row = [...document.querySelectorAll('.filerow')].find(
      (r) => (((r.querySelector('.fname') || {}).textContent) || '').trim() === ${JSON.stringify(FIXTURE_TITLE)}
    )
    if (!row) return 'no-row'
    row.click()
    return 'clicked'
  })()`)
  if (pick === 'no-row') {
    bad('左栏里找不到夹具 ' + FIXTURE_TITLE + ' —— 后面的断言都没意义了')
    console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
    process.exit(1)
  }
  if (pick === 'clicked') await s.sleep(1000)
  st = await s.eval(PROBE)
  console.log(`\n  （打开的是：${st.file || '(空)'}；视图缩放 ${st.s.toFixed(3)}，平移 ${st.tx.toFixed(1)}, ${st.ty.toFixed(1)}）`)
}

/* ═════════════════ 1. 四个纸面按钮 + 默认是纯白 ═════════════════ */
console.log('\n[1] 工具条上能挑纸，第一次打开是纯白')
{
  const want = PAPERS.map((p) => p.id).join(',')
  if (st.btns.join(',') === want) ok(`工具条上有 ${st.btns.length} 个纸面按钮：${st.btns.join(' · ')}`)
  else bad(`纸面按钮不对：拿到 [${st.btns.join(',')}]，应该是 [${want}]`)
  if (st.cls.includes('paper-plain')) ok('新档案第一次打开是**纯白**（用户 2026-09-16 要的默认）')
  else bad(`第一次打开不是纯白：.bd 的类里没有 paper-plain（实际 "${st.cls}"）`)
  if (st.img === 'none') ok('纯白那档真的一条线都没画（background-image: none）')
  else bad(`纯白那档还有底纹：${st.img}`)
  if (st.on.join(',') === 'plain') ok('选中的那个按钮亮着，而且只有一个亮着')
  else bad(`选中态不对：亮着的是 [${st.on.join(',')}]`)
}

/* ═════════════════ 2. 逐档点一遍 + 几何 ═════════════════ */
console.log('\n[2] 点一遍四种纸：类名、底纹、格距、选中态、存没存下来')
for (const p of PAPERS) {
  const hit = await s.eval(`(() => {
    const b = document.querySelector('.bd-paper[data-paper="${p.id}"]')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  if (hit !== 'ok') {
    bad(`找不到纸面按钮 ${p.id}`)
    continue
  }
  await s.sleep(240)
  const now = await s.eval(PROBE)
  const grads = now.img === 'none' ? 0 : (now.img.match(/gradient\(/g) || []).length
  const isRadial = /radial-gradient/.test(now.img)

  if (now.cls.includes('paper-' + p.id)) ok(`${p.name}：.bd 上是 paper-${p.id}`)
  else bad(`${p.name}：.bd 上没有 paper-${p.id}（实际 "${now.cls}"）`)
  if (grads === p.gradients && (!p.radial || isRadial)) ok(`${p.name}：底纹对（${grads} 条 ${p.radial ? 'radial' : 'linear'} gradient）`)
  else bad(`${p.name}：底纹不对（拿到 ${grads} 条，radial=${isRadial}，img="${now.img}"）`)
  if (p.tile > 0) checkGeometry(p.name, now, p)
  if (now.on.length === 1 && now.on[0] === p.id) ok(`${p.name}：只有它亮着`)
  else bad(`${p.name}：选中态不对（亮着 [${now.on.join(',')}]）`)
  if (now.saved === p.id) ok(`${p.name}：当场存进 localStorage（studyhelper.paper = ${now.saved}）`)
  else bad(`${p.name}：没存下来（localStorage 里是 ${JSON.stringify(now.saved)}）`)
}

/* ═════════════════ 3. 底色必须真的是"白纸" ═════════════════ */
console.log('\n[3] 底色是浅色（"白纸"这句话的全部意思就是这个）')
{
  const rgb = (css) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(css || ''))
    return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), min: Math.min(Number(m[1]), Number(m[2]), Number(m[3])) } : null
  }
  const seen = []
  for (const id of ['plain', 'grid', 'dots']) {
    await s.eval(`document.querySelector('.bd-paper[data-paper="${id}"]').click()`)
    await s.sleep(200)
    const c = rgb((await s.eval(PROBE)).color)
    if (c) seen.push({ id, c })
  }
  const dark = seen.filter((x) => x.c.min < 240)
  if (!seen.length) bad('读不到纸的底色（computed backgroundColor 不是 rgb 形式）')
  else if (!dark.length) ok('底色的 RGB 三个通道都 ≥ 240：' + seen.map((x) => `${x.id} rgb(${x.c.r},${x.c.g},${x.c.b})`).join(' · '))
  else bad('纸的底色太深：' + dark.map((x) => `${x.id} rgb(${x.c.r},${x.c.g},${x.c.b})`).join(' · '))
}

/* ═════════════════ 4. ★ 字在纸上：视图动，纸跟着动 ═════════════════ */
/* 用户 2026-09-16 的第二条反馈就是这个。
   判据不看"好看的截图"，只看两个数：
     · 格距 = 世界格距 × 视图缩放（缩放时它必须跟着变）
     · 底纹原点 + 整数个格距 = 视图平移（平移时它必须跟着走）
   两条合起来就是"底纹和墨迹共用同一个变换"。上一版这条会红 —— 格距永远是 32px。 */
console.log('\n[4] ★ 字就在纸上：平移 / 缩放时，底纹和墨迹一起动')
{
  const mid = PAPERS.find((p) => p.id === 'grid')
  await s.eval(`document.querySelector('.bd-paper[data-paper="grid"]').click()`)
  await s.sleep(260)
  const before = await s.eval(PROBE)
  checkGeometry('平移前', before, mid)

  const spot = await findPaperSpot(12)
  if (!spot) {
    bad('找不到一块干净的空白纸面来拖（板上东西太满？）—— 平移这一条没验成')
  } else {
    /* 拖一段**不是整格**的距离（70/45 对 32 格距取模是 6/13）：
       这样"底纹跟着动"和"底纹钉在屏幕上"在数字上是分得开的 ——
       拖整格的话，跟着动和没动都长一个样（都被取模折回来了）。 */
    const DX = 70
    const DY = 45
    await s.drag(spot.x, spot.y, DX, DY)
    const after = await s.eval(PROBE)
    const dx = after.tx - before.tx
    const dy = after.ty - before.ty
    if (near(dx, DX, 2) && near(dy, DY, 2)) ok(`中键拖了 (${DX}, ${DY}) → 视图平移跟着走了 ${dx.toFixed(1)}, ${dy.toFixed(1)}`)
    else bad(`拖了 (${DX}, ${DY})，视图只走了 ${dx.toFixed(1)}, ${dy.toFixed(1)}（中键平移没生效？）`)
    /* ★ 底纹的原点必须跟着一起走。它要是不动，就是用户报的那个"背景不动、字在动"。 */
    const gmB = geom(before, mid)
    const gmA = geom(after, mid)
    const pdx = gmA.posX - gmB.posX
    const pdy = gmA.posY - gmB.posY
    const ex = modDiff(pdx - dx, gmB.tileX)
    const ey = modDiff(pdy - dy, gmB.tileY)
    if (ex <= 0.6 && ey <= 0.6) {
      ok(`底纹原点跟着走了同一段（${gmB.posX.toFixed(1)},${gmB.posY.toFixed(1)} → ${gmA.posX.toFixed(1)},${gmA.posY.toFixed(1)}；取过模仍对得上）`)
    } else if (near(pdx, 0, 0.6) && near(pdy, 0, 0.6)) {
      bad('视图走了、底纹原点一点没动 —— 这就是"背景不动、字在动"：格线钉在屏幕上了')
    } else {
      bad(`底纹原点挪的不是那一段（视图走了 ${dx.toFixed(1)},${dy.toFixed(1)}，底纹挪了 ${pdx.toFixed(1)},${pdy.toFixed(1)}）`)
    }
    checkGeometry('平移后', after, mid)

    /* 缩放：点两次工具条上的 ＋（1.2 倍）——格距必须跟着 ×1.44，而且仍然锚在世界原点上 */
    const z = await s.eval(`(() => {
      const b = [...document.querySelectorAll('.bd-tools .bd-t')].find((x) => x.textContent.trim() === '＋')
      if (!b) return false
      b.click(); b.click()
      return true
    })()`)
    await s.sleep(320)
    const zoomed = await s.eval(PROBE)
    if (!z) bad('工具条上找不到画布放大按钮 ＋（缩放这一条没验成）')
    else if (near(zoomed.s, after.s * 1.44, 0.02)) {
      ok(`画布放大了 1.2² 倍（${after.s.toFixed(3)} → ${zoomed.s.toFixed(3)}）`)
      checkGeometry('缩放后', zoomed, mid)
    } else bad(`点了两次 ＋，缩放只从 ${after.s.toFixed(3)} 变成 ${zoomed.s.toFixed(3)}（应该 ×1.44）`)

    /* 装回屏幕（⤢）：换了视野之后锚定还得成立 —— 这条顺手把 fit 那条路也覆盖了 */
    const f = await s.eval(`(() => {
      const b = [...document.querySelectorAll('.bd-tools .bd-t')].find((x) => x.textContent.trim() === '⤢')
      if (!b) return false
      b.click()
      return true
    })()`)
    await s.sleep(400)
    if (f) checkGeometry('装回屏幕后', await s.eval(PROBE), mid)
    else bad('工具条上找不到 ⤢（装回屏幕）')
  }
}

/* ═════════════════ 5. 像素证明 ═════════════════ */
/* 只断言 computed style 是假安心（"样式里写着有格子"≠"屏幕上真的画出了格子"，
   类名/CSS 变量任一处对不上就是一片空白）。所以这里截一张真图、
   拿回页面里解码、在**一块真的空白纸面**上读像素：
     · 纯白 → 这一块里最暗和最亮几乎一样（没有一个暗点）
     · 有底纹 → 能读到明显更暗的像素（那就是格线 / 横线 / 点）
   ⚠ 采样框要**按真实格距**放大：格距现在跟着视图缩放走，
     框如果小于一格，可能整块落在两条线中间 —— 那样会误报成"没有底纹"。 */
console.log('\n[5] 像素证明：底纹真的画在屏幕上（不是"样式里写着有"）')
for (const p of PAPERS) {
  await s.eval(`document.querySelector('.bd-paper[data-paper="${p.id}"]').click()`)
  await s.sleep(320)
  const now = await s.eval(PROBE)
  const gm = geom(now, p)
  const tile = p.tile > 0 ? Math.max(gm.tileY || 0, gm.tileX || 0) : 0
  const half = Math.max(26, Math.ceil(tile) + 2) // 保证采样框跨过至少一格
  const spot = await findPaperSpot(half)
  if (!spot) {
    bad(`${p.name}：找不到一块干净的空白纸面来采样（板上东西太满？）`)
    continue
  }
  const shot = await s.send('Page.captureScreenshot', { format: 'png' })
  const px = await s.eval(`(async () => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + ${JSON.stringify(shot.data)}
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.width; cv.height = img.height
    const ctx = cv.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const dpr = img.width / window.innerWidth
    const half = Math.round(${spot.half} * dpr)
    const bx = Math.round(${spot.x} * dpr) - half
    const by = Math.round(${spot.y} * dpr) - half
    const d = ctx.getImageData(bx, by, half * 2, half * 2).data
    let min = 999, max = -1, dark = null
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (lum < min) { min = lum; dark = [d[i], d[i + 1], d[i + 2]] }
      if (lum > max) max = lum
    }
    return { min: Math.round(min), max: Math.round(max), dark, dpr }
  })()`)
  if (!px) {
    bad(`${p.name}：截图读像素失败`)
    continue
  }
  const spread = px.max - px.min
  const box = spot.half * 2
  if (p.id === 'plain') {
    if (spread <= 4) ok(`纯白：${box}×${box} 一块里最暗 ${px.min} / 最亮 ${px.max} —— 一条线都没有`)
    else bad(`纯白：那一块里居然有暗像素（最暗 ${px.min}，rgb(${px.dark})）—— 还有底纹没去掉`)
  } else {
    if (spread >= 6 && px.min <= 250) {
      ok(`${p.name}：${box}×${box}（跨 ${(box / Math.max(1, tile)).toFixed(1)} 格）里读到 ${px.min} 的暗像素 rgb(${px.dark}) —— 底纹真的画出来了`)
    } else bad(`${p.name}：整块都是亮的（最暗 ${px.min}，明暗差只有 ${spread}）—— 样式写着有底纹，屏幕上没有`)
  }
  if (px.dpr !== 1) console.log(`  （⚠ 这个环境的 devicePixelRatio 是 ${px.dpr}，已按它换算采样框）`)
}

/* ═════════════════ 6. 写字板也跟着换纸 ═════════════════ */
console.log('\n[6] 「✍ 手写公式」那块写字板跟着换同一张纸')
{
  await s.eval(`document.querySelector('.bd-paper[data-paper="plain"]').click()`)
  await s.sleep(200)
  const opened = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.bd-tools .bd-t')].find((x) => x.textContent.includes('手写公式'))
    if (!b) return 'no-btn'
    b.click(); return 'ok'
  })()`)
  await s.sleep(700)
  const plainPad = (await s.eval(PROBE)).padImg
  if (opened !== 'ok') bad('工具条上找不到「手写公式」，没法验写字板')
  else if (plainPad === null) bad('写字板没打开（找不到 .wp-padwrap）—— 这一条没验成')
  else if (plainPad === 'none') ok('纯白时写字板也是纯白（没有底纹）')
  else bad(`纯白时写字板的底纹还在：${plainPad}`)

  await s.eval(`document.querySelector('.bd-paper[data-paper="grid"]').click()`)
  await s.sleep(260)
  const gridPad = (await s.eval(PROBE)).padImg
  if (gridPad && gridPad !== 'none') ok(`方格时写字板跟着变成格子（${(gridPad.match(/gradient\(/g) || []).length} 条 gradient）`)
  else bad(`方格时写字板没跟着变：${gridPad}`)

  /* 关掉写字板（不然它盖在画布上，后面几屏的量法都不对） */
  await s.eval(`(() => { const x = document.querySelector('.wp-x'); if (x) x.click(); return !!x })()`)
  await s.sleep(500)
  if (await s.eval(`!!document.querySelector('.wp-padwrap')`)) bad('写字板没关掉')
  else ok('写字板关掉了（不影响后面的量法）')
}

/* ═════════════════ 7. 重开还是它 ═════════════════ */
console.log('\n[7] 重开一次：还是上次选的那张纸')
{
  const want = await s.eval(`localStorage.getItem('studyhelper.paper')`)
  await s.send('Page.navigate', { url: APP })
  let now = null
  for (let i = 0; i < 80; i++) {
    now = await s.eval(PROBE).catch(() => null)
    if (now && !now.cover && now.cls.includes('paper-')) break
    await sleep(250)
  }
  await s.sleep(400)
  now = await s.eval(PROBE)
  if (want === null || want === '') bad('重开之前 localStorage 里就没有值 —— 上一步"当场存"那一批已经红过了')
  else if (now.saved === want) ok(`上次选的（${want}）还在 localStorage 里`)
  else bad(`偏好丢了：localStorage 里是 ${JSON.stringify(now.saved)}，上次存的是 ${want}`)
  if (now.cls.includes('paper-' + want) && now.on.join(',') === want) ok(`重新打开用的就是它（paper-${want}，按钮也亮着）`)
  else bad(`重新打开没用上次选的：类里是 "${now.cls}"，亮着的是 [${now.on.join(',')}]`)
}

/* ═════════════════ 8. 地址栏 ?paper= 优先 ═════════════════ */
console.log('\n[8] 地址栏的 ?paper= 优先于偏好，而且不改偏好')
{
  await s.eval(`localStorage.setItem('studyhelper.paper', 'grid')`)
  await s.send('Page.navigate', { url: APP + '?paper=dots' })
  let now = null
  for (let i = 0; i < 60; i++) {
    now = await s.eval(PROBE).catch(() => null)
    if (now && !now.cover) break
    await s.sleep(250)
  }
  await s.sleep(300)
  if (now && now.cls.includes('paper-dots')) ok('?paper=dots 把纸定成了点阵（自检和"发给同学看"都靠它）')
  else bad(`?paper=dots 没生效（类里是 "${now && now.cls}"）`)
  if (now && now.saved === 'grid') ok('地址栏这一下**没有**改掉偏好（偏好还是 grid）')
  else bad(`地址栏把偏好改坏了：localStorage 里是 ${now && JSON.stringify(now.saved)}，应该还是 grid`)
}

/* ═════════════════ 9. 换纸动了板文件吗 ═════════════════ */
console.log('\n[9] 换纸没有碰板文件（纸是"我怎么看"，不是板的内容）')
{
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  } catch (e) {
    bad('夹具板读不出来了：' + e.message)
  }
  if (parsed) {
    if (!('paper' in parsed) && !('background' in parsed)) ok('板文件里没有 paper / background 字段（上面点了十几次纸，文件没被塞东西）')
    else bad('板文件里多了字段：' + JSON.stringify(Object.keys(parsed)))
    if (Array.isArray(parsed.cards) && Array.isArray(parsed.strokes)) ok('板文件还是合法白板 JSON（打开不会退化成空板）')
    else bad('板文件不是合法白板 JSON 了')
  }
}

/* ═════════════════ 10. 页面里不许有 JS 报错 ═════════════════ */
console.log('\n[10] 整个流程跑下来，页面里没有任何 JS 报错')
if (!s.exceptions.length) ok('没有报错 —— "处理器抛异常"和"处理器没跑"在屏幕上是同一个样子，所以这条是兜底')
else bad(`页面里有 ${s.exceptions.length} 条报错：` + s.exceptions.slice(0, 3).join(' ｜ '))

console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
cleanup()
process.exit(fails ? 1 : 0)
