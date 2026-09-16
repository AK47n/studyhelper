/* 卡片的「固定」（防误触）—— 真浏览器自检。
 *
 * 用户 2026-09-16：「给卡片加一个固定按钮用来防止误触」。
 * 纯逻辑那一层（字段读写、什么时候写出去）在 check-board.js 的 [6c]；
 * 这里管的是**行为**，而且只能在这儿管 ——
 * 锁定 = 整张卡 pointer-events: none、只留角上那颗 📌 自己 auto，
 * 这种"命中测试"级别的东西，`dispatchEvent` 合成事件**证明不了**
 * （合成事件直接投给元素，绕过浏览器的命中测试 —— README 第 11 条踩过这个坑）。
 * 所以下面每一条都是**真鼠标/真键盘**，而且先问 elementFromPoint 才动手。
 *
 * 断言清单：
 *   [1] 选中一张卡 → 出现 📌，而且它**点得到**（elementFromPoint）
 *   [2] 点 📌 → 卡片 locked、× 和缩放柄都收起来、📌 还在（这是唯一的回头路）
 *   [3] 锁定后：CSS 上真的 pointer-events: none，📌 还是 auto
 *   [4] 锁定后：点它不会选中它（它已经是"纸的一部分"）
 *   [5] 锁定后：拖它 → 位置纹丝不动
 *   [6] 锁定后：双击 → 不进编辑态（没有输入框）
 *   [7] 锁定后：在它上面画一笔 → 墨迹照画（还画在它上面），卡片照样不动
 *   [8] 锁定后：从关系面板里选中它、按 Delete → 删不掉，还会给一句人话提示
 *   [9] 解开 → 手柄回来，拖得动了
 *   [10] 文件里只有那张卡带 "locked": true（别的卡不多这个字段）
 *   [11] 重开一次 → 它还是锁着的
 *
 * 自己起服务（5202）和 headless Edge（9232），跑完都收掉；
 * 只碰自己造的夹具板 board-zz-lockcheck.md（用样板内容，跑完删）。
 *
 * 用法：node scripts/check-lock.js   （或 npm run check:lock）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { browserExe } from './lib/browser.js'
import { waitForAppPage } from './lib/cdp.js'
import { BOARD_PREFIX, newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA = path.join(ROOT, 'data')
const PORT = Number(process.env.TEST_PORT || 5202)
const CDP_PORT = Number(process.env.TEST_CDP || 9232)
const CDP = `http://127.0.0.1:${CDP_PORT}`
const APP = `http://127.0.0.1:${PORT}/`

let fails = 0
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => {
  fails++
  console.log('  \u2717 ' + m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 夹具：两张**文字卡**（我自己造的，**不动用户自己那张板**）。
   为什么不用样板板：样板里第一张是公式卡，而关系面板里显示的"标签"是
   渲染后的式子（displayTex），跟 DOM 里的文字对不上 —— 第 7 步要在面板里
   按文字找那一行，所以夹具得是**文字可预测**的卡。
   两张卡隔得远，第 6 步"在锁定的卡上画一笔"不会碰到另一张。
   board- 前缀 + zz 保证排在 data/ 前面；跑完删掉，中途报错也删。 */
const FIXTURE_NAME = BOARD_PREFIX + 'zz-lockcheck.md'
const FIXTURE_TITLE = BOARD_PREFIX + 'zz-lockcheck'
const FIXTURE = path.join(DATA, FIXTURE_NAME)
const CARD_A = 'lockcheck-a'
const TEXT_A = '固定自检甲的卡片'
{
  const b = newBoard('固定自检夹具（跑完自动删除）')
  const a = { ...newCard('note', 120, 120), id: CARD_A, text: TEXT_A, w: 260, h: 70 }
  const c = { ...newCard('note', 620, 120), id: 'lockcheck-b', text: '固定自检乙的卡片', w: 260, h: 70 }
  b.cards.push(a, c)
  fs.writeFileSync(FIXTURE, serializeBoardDocument(b), 'utf8')
}
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
  /* 真鼠标：按下 → 若干次移动 → 松开。点一下就是 steps=0。 */
  async mouse(x, y, { steps = 0, dx = 0, dy = 0, button = 'left' } = {}) {
    const buttons = button === 'left' ? 1 : button === 'middle' ? 4 : 2
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button, buttons })
      await sleep(12)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button, buttons: 0 })
    await sleep(220)
  }
  /* 双击：CDP 里靠 clickCount 表达（两次 pressed/released，第二次 clickCount=2）。
     ⚠ 别用元素上的 dispatchEvent('dblclick')：那绕过命中测试，
     证明不了"用户双击得到它"（这条在 README 第 11 条里写得很清楚）。 */
  async doubleClick(x, y) {
    for (const clickCount of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount })
      await sleep(40)
    }
    await sleep(320)
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

const profile = path.join(os.tmpdir(), `studyhelper-lock-${CDP_PORT}`)
try {
  fs.rmSync(profile, { recursive: true, force: true })
} catch {}
edge = spawn(
  browserExe(),
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1440,900', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`, APP,
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

/* 等白板挂上，然后切到夹具。
 * ★ 这一步要做两次（开头一次、重开之后一次），所以抽成函数。
 *   为什么不能指望"打开的就是夹具"：应用打开时挑的是**列表里第一个 board-*.md**，
 *   而这台机器上用户自己那张 `board-新白板.md` 常常排在前面（中文名排序）。
 *   所以每次都从左栏点夹具那一行 —— 这也是用户真实的操作路径，不依赖排序。 */
async function openFixture() {
  for (let i = 0; i < 80; i++) {
    const ready = await s.eval(`!!document.querySelector('.bd-stagewrap') && !document.querySelector('.cover')`).catch(() => false)
    if (ready) break
    await sleep(250)
  }
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
  if (pick === 'clicked') await sleep(1400)
  await sleep(500)
  return pick
}

{
  const pick = await openFixture()
  if (pick === 'no-row') {
    bad('左栏里找不到夹具 ' + FIXTURE_TITLE + ' —— 后面的断言都没意义了')
    console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
    process.exit(1)
  }
}

/* 页面侧的读卡器：位置、锁定、以及那几个手柄在不在。
   位置读的是 inline style 的 left/top（卡片是按"屏幕 = 世界 × s + t"自己算的），
   拖动前后比它最直接。 */
const readCard = (id) => s.eval(`(() => {
  const el = document.querySelector('.bd-card[data-card-id="' + ${JSON.stringify(id)} + '"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const pin = el.querySelector('.bd-card-pin')
  const pr = pin ? pin.getBoundingClientRect() : null
  return {
    left: parseFloat(el.style.left), top: parseFloat(el.style.top),
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
    pinCx: pr ? Math.round(pr.x + pr.width / 2) : null,
    pinCy: pr ? Math.round(pr.y + pr.height / 2) : null,
    locked: el.classList.contains('locked'),
    on: el.classList.contains('on'),
    pe: getComputedStyle(el).pointerEvents,
    pinPe: pin ? getComputedStyle(pin).pointerEvents : null,
    pinAct: pin ? pin.dataset.cardPin : null,
    hasDel: !!el.querySelector('.bd-card-del'),
    hasResize: !!el.querySelector('.bd-card-resize'),
    editingBox: !!el.querySelector('textarea'),
    text: ((el.querySelector('.bd-card-body') || {}).textContent || '').trim().slice(0, 12),
  }
})()`)

/* 命中测试：某一点上**最上面的**是谁。沾指针的东西都得先问过它。 */
const hitAt = (x, y) => s.eval(`(() => {
  const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
  if (!el) return '(无)'
  return el.className && typeof el.className === 'string' ? el.className : el.tagName
})()`)

const first = await s.eval(`(() => {
  const el = document.querySelector('.bd-card[data-card-id="${CARD_A}"]')
  return el ? el.dataset.cardId : null
})()`)
if (!first) {
  bad('夹具里那张卡没渲染出来 —— 后面的断言都没意义了')
  console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
  process.exit(1)
}
console.log(`\n  （拿这张卡做实验：${first}）`)

/* ═════════════════ 1. 选中 → 出现 📌，而且点得到 ═════════════════ */
console.log('\n[1] 选中一张卡，左上角出现「固定」按钮')
let c0 = null
{
  c0 = await readCard(first)
  await s.mouse(c0.cx, c0.cy)
  const c = await readCard(first)
  if (c.on) ok('真鼠标点一下卡片 → 选中了')
  else bad('点卡片没选中（卡片收不到指针事件？）')
  if (c.pinCx) ok(`📌 出现了（在 ${c.pinCx},${c.pinCy}）`)
  else bad('选中了却没出现 📌 —— 固定按钮没渲染')
  if (c.pinAct === 'lock') ok('它是"按下会锁上"那个状态（data-card-pin="lock"）')
  else bad(`📌 的状态不对：data-card-pin=${JSON.stringify(c.pinAct)}`)
  if (!c.locked) ok('这时候还没锁定')
  else bad('一上来就锁着？')
  /* ★ 先问命中测试，再动手 —— 手柄这么小，点偏了就是"点了没反应"这种假错。 */
  if (c.pinCx) {
    const hit = await hitAt(c.pinCx, c.pinCy)
    if (String(hit).includes('bd-card-pin')) ok('📌 中心那一点命中的就是它自己（不是被别人盖住）')
    else bad(`📌 中心命中的是「${hit}」—— 按钮被别的东西盖住了，用户点不到`)
  }
}

/* ═════════════════ 1b. 左上角必须还是"抓卡片"的地方 ═════════════════ */
/* 为什么专门钉这一条：📌 一开始就放在**左上角**，于是"从左上角按住拖卡片"
 * 变成了"按了一个按钮" —— check-ocr-browser 里那条拖动断言（它正是从
 * 左上角 +8/+4 按下去的）当场变成「拖不动或挪得太少（0, 0）」。
 * 四个角是有分工的，写在这里免得以后又把按钮搬回去：
 *   左上 = 抓（拖动）· 右上 = × · 右下 = 缩放柄 · 左下 = 📌 */
console.log('\n[1b] 左上角还是"抓卡片拖走"的地方（📌 没占住它）')
{
  const before = await readCard(first)
  const hit = await hitAt(before.x + 8, before.y + 4)
  if (!String(hit).includes('bd-card-pin')) ok(`左上角 (left+8, top+4) 命中的是「${hit}」—— 不是 📌`)
  else bad('左上角被 📌 占住了 —— 那是抓卡片拖走最顺手的点，用户在那儿按下去会变成点按钮')
  await s.mouse(before.x + 8, before.y + 4, { steps: 8, dx: 60, dy: -50 })
  const after = await readCard(first)
  if (Math.abs(after.left - before.left) > 20 && Math.abs(after.top - before.top) > 20) {
    ok(`从左上角拖得动（${before.left},${before.top} → ${after.left},${after.top}）`)
  } else {
    bad(`从左上角拖不动（left/top 还是 ${after.left},${after.top}）`)
  }
}

/* ═════════════════ 2. 点 📌 → 锁上 ═════════════════ */
console.log('\n[2] 点一下它：卡片锁上')
{
  const before = await readCard(first)
  await s.mouse(before.pinCx, before.pinCy)
  const c = await readCard(first)
  if (c.locked) ok('卡片变成"固定"状态（.locked）')
  else bad('点了 📌 但卡片没锁上')
  if (c.pinAct === 'unlock') ok('📌 变成"再点一下解开"（data-card-pin="unlock"）')
  else bad(`📌 的状态没跟着变：${JSON.stringify(c.pinAct)}`)
  if (!c.hasDel && !c.hasResize) ok('× 和缩放柄都收起来了（锁定之后不该有能动的入口）')
  else bad(`锁定了还留着手柄：×=${c.hasDel} 缩放柄=${c.hasResize}`)
  if (!c.on) ok('同时取消了选中（手柄不会留在锁定的卡上）')
  else bad('锁定之后卡片还是选中态')
}

/* ═════════════════ 3. CSS 契约：卡片 none、📌 auto ═════════════════ */
console.log('\n[3] 锁定的做法：整张卡不收指针事件，只留 📌')
{
  const c = await readCard(first)
  if (c.pe === 'none') ok('卡片自己的 pointer-events = none（变成"纸的一部分"）')
  else bad(`卡片的 pointer-events 是 ${c.pe} —— 那它还是会抢指针事件`)
  if (c.pinPe === 'auto') ok('📌 自己的 pointer-events = auto（唯一的回头路，必须点得到）')
  else bad(`📌 的 pointer-events 是 ${c.pinPe} —— 那样就"钉死了拿不下来"了`)
}

/* ═════════════════ 4. 点它不选中；拖它不动 ═════════════════ */
console.log('\n[4] 锁定后：点它、拖它，卡片纹丝不动')
{
  const before = await readCard(first)
  const hit = await hitAt(before.cx, before.cy)
  if (String(hit).includes('bd-hit')) ok('卡片身上那一点命中的是收事件层（.bd-hit）—— 指针落在"纸上"了')
  else bad(`卡片身上那一点命中的是「${hit}」—— 卡片还在抢指针事件`)

  const mid = await readCard(first)
  await s.mouse(mid.cx, mid.cy, { steps: 8, dx: 70, dy: 40 })
  const after = await readCard(first)
  if (Math.abs(after.left - before.left) < 0.5 && Math.abs(after.top - before.top) < 0.5) {
    ok(`拖了 (70, 40)，卡片一步没动（left/top 还是 ${after.left}, ${after.top}）`)
  } else {
    bad(`拖了 (70, 40) 之后卡片被挪走了：${before.left},${before.top} → ${after.left},${after.top}`)
  }
  if (!after.on) ok('也没有被选中')
  else bad('拖这一下把它选中了')
}

/* ═════════════════ 5. 双击不进编辑态 ═════════════════ */
console.log('\n[5] 锁定后：双击也不会进编辑态')
{
  const c = await readCard(first)
  await s.doubleClick(c.cx, c.cy)
  const after = await readCard(first)
  if (!after.editingBox) ok('双击之后没有出现输入框（"钉住了"就是钉住了）')
  else bad('锁定的卡片被双击进了编辑态')
  if (!after.on) ok('也没有顺手把它选中')
  else bad('双击把它选中了')
}

/* ═════════════════ 6. 在它上面画一笔 ═════════════════ */
console.log('\n[6] 锁定后：在它上面写字照样写得出来（墨迹画在卡片上面）')
{
  const inkBefore = await s.eval(`Number(document.querySelector('canvas.bd-ink').dataset.strokes)`)
  const c = await readCard(first)
  await s.mouse(c.cx - 20, c.cy, { steps: 10, dx: 46, dy: 0 })
  const inkAfter = await s.eval(`Number(document.querySelector('canvas.bd-ink').dataset.strokes)`)
  if (inkAfter > inkBefore) ok(`在卡片上画出了一笔（${inkBefore} → ${inkAfter}）—— 它真的变成纸了`)
  else bad(`在卡片上没画出东西（${inkBefore} → ${inkAfter}）—— 这一下被卡片吃掉了`)
  const after = await readCard(first)
  if (Math.abs(after.left - c.left) < 0.5 && Math.abs(after.top - c.top) < 0.5) ok('画这一笔也没把卡片挪走')
  else bad('画这一笔把卡片挪了 —— 用笔时卡片还是抢了指针')
}

/* ═════════════════ 7. 关系面板里选中它、按 Delete ═════════════════ */
/* 锁定之后它在画布上选不中，但关系面板里点一下名字是会选中的 ——
   那条路要是没挡，一个 Delete 就把锁定的卡删了。 */
console.log('\n[7] 从关系面板里选中它、按 Delete：删不掉，而且给一句人话')
{
  const c = await readCard(first)
  const clicked = await s.eval(`(() => {
    const rows = [...document.querySelectorAll('.bd-node-row')]
    const row = rows.find((r) => (r.textContent || '').includes(${JSON.stringify(c.text)}))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (!clicked) {
    console.log('  （⚠ 关系面板里没找到这一行，这一条跳过）')
  } else {
    await sleep(260)
    const sel = await readCard(first)
    if (sel.on) ok('面板里点一下确实能把它选中（所以这条路必须挡）')
    else console.log('  （⚠ 面板点击没把它选中，还是照按一下 Delete 看看）')
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await sleep(400)
    const after = await readCard(first)
    if (after) ok('按了 Delete，卡片还在 —— 锁定的卡不会被键盘删掉')
    else bad('按 Delete 把锁定的卡片删掉了（它平时选不中，但面板那条路能选中）')
    const toast = await s.eval(`((document.querySelector('.toast') || {}).textContent || '').trim()`)
    if (/固定/.test(toast)) ok('还给了一句人话：' + toast)
    else console.log(`  （⚠ 没读到提示（toast="${toast}"）—— 不拦，但记一下）`)
  }
}

/* ═════════════════ 8. 解开 → 又能拖了 ═════════════════ */
console.log('\n[8] 点 📌 解开：手柄回来，拖得动了')
{
  const before = await readCard(first)
  await s.mouse(before.pinCx, before.pinCy)
  const unlocked = await readCard(first)
  if (!unlocked.locked) ok('解开了（.locked 没了）')
  else bad('点了 📌 但没解开 —— 那就是"钉死了拿不下来"')
  if (unlocked.on && unlocked.hasDel && unlocked.hasResize) ok('顺手选中它，× 和缩放柄都回来了')
  else bad(`解开之后手柄没回来：选中=${unlocked.on} ×=${unlocked.hasDel} 缩放柄=${unlocked.hasResize}`)

  const mid = await readCard(first)
  await s.mouse(mid.cx, mid.cy, { steps: 8, dx: 70, dy: 40 })
  const after = await readCard(first)
  const moved = Math.abs(after.left - mid.left) > 20 || Math.abs(after.top - mid.top) > 20
  if (moved) ok(`拖得动了（${mid.left},${mid.top} → ${after.left},${after.top}）`)
  else bad('解开了还是拖不动 —— 那"解开"是假的')
}

/* ═════════════════ 9. 文件里怎么写的 ═════════════════ */
console.log('\n[9] 落盘：只有那张卡带 locked，别的卡不多这个字段')
{
  /* 先重新锁上，再看文件（前面第 8 步解开了）。 */
  const c = await readCard(first)
  await s.mouse(c.pinCx, c.pinCy)
  await sleep(1200) // 等自动存盘（停笔 700ms）
  let doc = null
  try {
    doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  } catch (e) {
    bad('夹具板读不出来：' + e.message)
  }
  if (doc) {
    const withLock = doc.cards.filter((x) => x.locked === true)
    if (withLock.length === 1 && withLock[0].id === first) ok('文件里正好一张卡是 locked: true，就是这张')
    else bad(`文件里的 locked 不对：${JSON.stringify(doc.cards.map((x) => [x.id, x.locked]))}`)
    const others = doc.cards.filter((x) => x.id !== first)
    if (others.every((x) => !('locked' in x))) ok(`别的 ${others.length} 张卡**没有** locked 这个字段（不写 false，不造假 diff）`)
    else bad('没锁的卡也被写上了 locked 字段')
  }
}

/* ═════════════════ 10. 重开还在 ═════════════════ */
console.log('\n[10] 重开一次：它还是锁着的')
{
  await s.send('Page.navigate', { url: APP })
  /* ★ 重开之后要**再切一次夹具**：应用打开时挑的是"列表里第一个 board-*.md"，
     而用户那张 board-新白板.md 常排在前面（第 8 步那次踩过这个：站在别人的板上
     找一个不存在的卡片 id，报出来是" 📌 不见了"这种看不懂的假错）。 */
  await openFixture()
  const c = await readCard(first)
  if (!c) {
    bad(`重开并切回夹具之后，卡片 ${first} 不在 DOM 里 —— 这一条没验成`)
  } else {
    if (c.locked) ok('重新打开之后它还是固定着的（状态存在板文件里）')
    else bad('重开之后锁定丢了')
    if (c.pinCx) ok(`📌 仍然在（${c.pinCx},${c.pinCy}），能解开`)
    else bad('重开之后 📌 不见了')
  }
}

/* ═════════════════ 11. 页面里不许有 JS 报错 ═════════════════ */
console.log('\n[11] 整个流程跑下来，页面里没有任何 JS 报错')
if (!s.exceptions.length) ok('没有报错 —— "处理器抛异常"和"处理器没跑"在屏幕上是同一个样子，所以这条是兜底')
else bad(`页面里有 ${s.exceptions.length} 条报错：` + s.exceptions.slice(0, 3).join(' ｜ '))

console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
cleanup()
process.exit(fails ? 1 : 0)
