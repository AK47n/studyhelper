/* 画出来的连接（关系）—— 真浏览器自检。
 *
 * 用户 2026-09-16：「更便捷的显示出两者之间的主次、因果、并列等关系」
 *              「我操作的速度是很快的，我没有时间去逐步花很多时间操作这个表示关系的步骤」
 * 纯逻辑那一层（形状怎么读、什么写进文件）在 check-board.js 的 [6d]；
 * 这里管**行为**，而且只能在这儿管：画线 → 浮词 → 点词 → 存盘 → 重开还在。
 *
 * 断言清单：
 *   [1] 拿**笔**从一张卡画到另一张卡 → 连接当场成立（不用点任何东西）+ 浮出那排词，
 *       而且自动读出来的是「相关」（直线）
 *   [2] 点「因果」→ 面板改词、屏幕上出现一颗词 + 一个箭头、文件里写上 link
 *   [3] elementFromPoint 证明那颗词**点得到**（这是"回头改"的唯一入口）
 *   [4] 点那颗词 → 浮词再来一次；按 `1` 选回「相关」→ **文件里的 link 字段消失**
 *       （选的就是自动那一档 = 回到自动，不写字节）
 *   [5] 框住那条线（真框选）→ 浮层里多出一排词，选「推导」→ 面板和文件都跟上
 *   [6] 画一条**带箭头**的线（一笔画成、末端回勾）→ 自动读成「因果」，
 *       而且**文件里没有 link 字段**（形状读出来的不存盘）
 *   [6b] 用**他本人画的箭头**（真实点列，两笔：一杆 + 一个 V 尖）→ 也读成「因果」，
 *       而且屏幕上**不叠合成箭头**（尖是他自己画的）；顺带验世界→屏幕的映射对得上
 *   [7] 在空白处乱画一笔 → 不算连接、也不浮词
 *   [8] 重开一次 → 你标过的那个词还在（存在笔迹上）
 *   [9] 「这条不算连接」：点它 → 不再是关系、文件里写 link:"none"、重开还在；
 *       再框住那一笔 → 浮层里「又算回连接」→ 点回去，文件里那个字段也去掉
 *
 * 自己起服务（5203）和 headless Edge（9233），跑完都收掉；
 * 只碰自己造的夹具板 board-zz-linkcheck.md（跑完删）。
 *
 * 用法：node scripts/check-link.js   （或 npm run check:link）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { browserExe } from './lib/browser.js'
import { waitForAppPage } from './lib/cdp.js'
import { BOARD_PREFIX, newBoard, newCard, serializeBoardDocument, toPoints } from '../src/lib/board.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA = path.join(ROOT, 'data')
const PORT = Number(process.env.TEST_PORT || 5203)
const CDP_PORT = Number(process.env.TEST_CDP || 9233)
const CDP = `http://127.0.0.1:${CDP_PORT}`
const APP = `http://127.0.0.1:${PORT}/`

let fails = 0
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => {
  fails++
  console.log('  \u2717 ' + m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 夹具：两张文字卡、**一笔都没有**。两张卡**上下摆**，不是左右摆 ——
 * ★ 左右摆踩过：屏幕右边 ~330px 是关系面板（.bd-cpanel，覆盖在画布上面），
 *   而"装回屏幕"会把这两张卡居中，于是右边那张正好钻到面板底下。
 *   症状是"第二笔怎么画都不出墨"，报出来像"画不出来"，其实是**在面板上按的**
 *   （面板在 .bd-stagewrap 外面，捕获阶段的监听都收不到 pointerdown）。
 *   上下摆之后两张卡都落在画布中轴附近，离面板远远的。
 * 为什么板上一笔都没有：第 5 步要"框住那条线"，而浮层只在
 *   "框里正好一条连接线"时出现（inkSel.size === 1）—— 板上多一笔就测不到那条路了。 */
const FIXTURE_NAME = BOARD_PREFIX + 'zz-linkcheck.md'
const FIXTURE_TITLE = BOARD_PREFIX + 'zz-linkcheck'
const FIXTURE = path.join(DATA, FIXTURE_NAME)
{
  const b = newBoard('连接自检夹具（跑完自动删除）')
  b.cards.push(
    { ...newCard('note', 500, 120), id: 'lk-a', text: '原因这一块', w: 220, h: 90 },
    { ...newCard('note', 500, 560), id: 'lk-b', text: '结果这一块', w: 220, h: 90 }
  )
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
  /* 用**笔**画（pointerType: 'pen'）。
   * ★ 为什么必须是笔、不能是鼠标：卡片是 DOM、会收指针事件（鼠标按上去是**拖卡片**）。
   *   用笔时卡片让路（.bd.penink .bd-card），笔尖才能从卡片上写过去 ——
   *   而这正是用户的真实姿势（他就是要在两张卡之间画线）。
   * ★ 而且**先悬停一下**：应用靠"最近一次是什么设备"来判断要不要加 .penink，
   *   直接按下去的话，那一下还是会被卡片接走（悬停即生效，见 Board.jsx 的注释）。 */
  async penStroke(from, to, { steps = 10, hover = true } = {}) {
    if (hover) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'pen' })
      await sleep(140)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
      const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'pen',
      })
      await sleep(12)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
    await sleep(220)
  }
  async mouse(x, y, { steps = 0, dx = 0, dy = 0 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1 })
      await sleep(12)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0 })
    await sleep(220)
  }
  async key(k, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
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

const profile = path.join(os.tmpdir(), `studyhelper-link-${CDP_PORT}`)
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

/* 切到夹具（应用打开时挑的是"列表里第一个 board-*.md"，那常常是用户自己那张板）。 */
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

/* 读板上的情况：面板里那节"你画过的"、浮词那排、屏幕上的词、以及卡片位置。 */
const readBoard = () => s.eval(`(() => {
  const rows = [...document.querySelectorAll('.bd-link-row')]
  const chips = document.querySelector('.bd-linkchips')
  const card = (id) => {
    const el = document.querySelector('.bd-card[data-card-id="' + id + '"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const pill = document.querySelector('.bd-linkpill')
  const pr = pill ? pill.getBoundingClientRect() : null
  return {
    count: rows.length,
    /* 词里带方向记号（「因果 →」），自检只关心词本身 —— 统一去掉箭头再比，
       不然每个断言都得把方向符号抄一遍（抄错了就是假红）。 */
    kinds: rows.map((r) => ((r.querySelector('.bd-link-kind') || {}).textContent || '').replace(/[→⇒]/g, '').trim()),
    chipsOpen: !!chips,
    chipsPick: chips ? chips.dataset.linkPick : null,
    chipsKinds: chips ? [...chips.querySelectorAll('.bd-linkchip')].map((b) => b.dataset.linkKind || 'rev') : [],
    chipsOn: chips ? (chips.querySelector('.bd-linkchip.on') || {}).dataset?.linkKind : null,
    pillText: pill ? pill.textContent.trim() : null,
    pillKind: pill ? pill.dataset.linkKind : null,
    pillCx: pr ? Math.round(pr.x + pr.width / 2) : null,
    pillCy: pr ? Math.round(pr.y + pr.height / 2) : null,
    arrows: document.querySelectorAll('[data-link-arrow]').length,
    pills: document.querySelectorAll('.bd-linkpill').length,
    ink: Number(document.querySelector('canvas.bd-ink').dataset.strokes),
    selLink: !!document.querySelector('[data-sel-link]'),
    selChips: [...document.querySelectorAll('[data-sel-link] .bd-linkchip')].map((b) => b.dataset.linkKind || 'rev'),
    /* 框住的笔里有"你说过不算连接"的那些 → 浮层里会给一条回头路 */
    inkNoLink: !!document.querySelector('[data-ink-nolink]'),
    /* 框选浮层（虚线框 + 那一排动作）在不在 */
    inkBox: !!document.querySelector('.bd-inkbox'),
    inkActs: !!document.querySelector('.bd-inkacts'),
    /* 推导链那一节（面板）：几条链、哪几步缺条件、每一步的条件写的是什么 */
    chainCount: document.querySelectorAll('.bd-chain').length,
    chainMissing: document.querySelectorAll('.bd-chain-cond.miss').length,
    chainConds: [...document.querySelectorAll('.bd-chain-cond')].map((e) => e.textContent.trim()),
    condRows: [...document.querySelectorAll('.bd-link-row .bd-cond')].map((e) => e.textContent.trim()),
    a: card('lk-a'),
    b: card('lk-b'),
    toast: ((document.querySelector('.toast') || {}).textContent || '').trim(),
  }
})()`)

/* 板文件里的 link 字段（等它自动存盘再读）。 */
async function fileLinks(ms = 1100) {
  await sleep(ms)
  try {
    const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    return doc.strokes.filter((x) => x.link).map((x) => x.link)
  } catch {
    return null
  }
}

const hitAt = (x, y) => s.eval(`(() => {
  const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
  if (!el) return '(无)'
  return el.className && typeof el.className === 'string' ? el.className : el.tagName
})()`)

/* 切工具：点工具条上那个按钮（真实用户路径）。
 * ⚠ 别用键盘 'S'/'P' 切：这条自检里键盘已经用在别处（数字键选词），
 *   而且"按了键但工具没换"会让后面整段全红，报出来却像"画不出来"。
 *   —— 这一条踩过：第一次跑 [5] 用 key('s') 切框选，[6] 就再也画不出墨了。 */
const pickTool = (label) => s.eval(`(() => {
  const b = [...document.querySelectorAll('.bd-tools .bd-t')].find((x) => x.textContent.includes(${JSON.stringify(label)}))
  if (!b) return false
  b.click()
  return true
})()`)

let st = await readBoard()
if (!st.a || !st.b) {
  bad('夹具的两张卡没渲染出来 —— 后面的断言都没意义了')
  console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
  process.exit(1)
}
console.log(`\n  （两张卡在屏幕上：A(${st.a.cx},${st.a.cy}) · B(${st.b.cx},${st.b.cy})）`)

/* ═════════════════ 1. 画一条线：连接当场成立 + 浮出那排词 ═════════════════ */
console.log('\n[1] 从一张卡画到另一张卡：连接当场成立，不用点任何东西')
{
  const from = { x: st.a.cx, y: st.a.cy }
  const to = { x: st.b.cx, y: st.b.cy }
  await s.penStroke(from, to, { steps: 10, hover: true })
  const now = await readBoard()
  if (now.count === 1) ok('面板里出现了 1 条"你画过的"连接')
  else bad(`面板里"你画过的"是 ${now.count} 条，应该是 1 条`)
  if (now.kinds[0] === '相关') ok('直线自动读成「相关」（无向）')
  else bad(`直线读成了「${now.kinds[0]}」，应该是「相关」`)
  if (now.chipsOpen) ok('那排词自己浮出来了（画完就有，不用去点什么）')
  else bad('画完之后没浮出那排词')
  if (now.chipsOn === 'rel') ok('浮出来的那排词里，"相关"是亮着的（= 它的判断）')
  else bad(`浮词里亮着的是 ${JSON.stringify(now.chipsOn)}，应该是 rel`)
  if (now.pillText === null && now.arrows === 0) ok('屏幕上**什么都没加**（默认那一档不加装饰：你画的那一笔就是它该有的样子）')
  else bad(`默认那一档却说画了东西：词=${now.pillText} 箭头=${now.arrows}`)
  if (now.ink === 1) ok('那一笔落在墨迹层里（是真的画了一笔，不是箭头之类）')
  else bad(`墨迹层里有 ${now.ink} 笔，应该是 1 笔`)
}

/* ═════════════════ 2. 点一个词 ═════════════════ */
console.log('\n[2] 点「因果」：面板改词、屏幕上出现词和箭头、文件里写上')
{
  const clicked = await s.eval(`(() => {
    const chips = document.querySelector('.bd-linkchips')
    if (!chips) return 'no-chips'
    const b = chips.querySelector('.bd-linkchip[data-link-kind="cause"]')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  if (clicked === 'ok') ok('点了「因果」')
  else bad(`点不到「因果」那颗词（${clicked}）`)
  await s.sleep(300)
  const now = await readBoard()
  if (now.kinds[0] === '因果') ok('面板里那一条改成了「因果」')
  else bad(`面板里还是「${now.kinds[0]}」`)
  if (now.pillText === '因果 →') ok('屏幕上多了一颗词「因果 →」')
  else bad(`屏幕上那颗词是 ${JSON.stringify(now.pillText)}`)
  if (now.arrows === 1) ok('还画了一个箭头（有方向的词才有）')
  else bad(`箭头画了 ${now.arrows} 个，应该是 1 个`)
  if (!now.chipsOpen) ok('点完那排词自己收走了（不留在屏幕上碍事）')
  else bad('点完那排词还挂着')
  const links = await fileLinks()
  if (links && links.join(',') === 'cause') ok('文件里这一笔写了 link: "cause"')
  else bad(`文件里的 link 不对：${JSON.stringify(links)}`)
}

/* ═════════════════ 3. 那颗词点得到 ═════════════════ */
console.log('\n[3] 那颗词**点得到**（回头改词的唯一入口）')
{
  const now = await readBoard()
  const hit = await hitAt(now.pillCx, now.pillCy)
  if (String(hit).includes('bd-linkpill')) ok(`词中心那一点命中的就是它自己（${hit}）`)
  else bad(`词中心命中的是「${hit}」—— 被别的东西盖住了，用户点不到`)
}

/* ═════════════════ 4. 选回"自动那一档" → 文件里的字段消失 ═════════════════ */
console.log('\n[4] 点那颗词 → 按 1 选回「相关」：回到自动，文件里那个字段消失')
{
  const before = await readBoard()
  await s.mouse(before.pillCx, before.pillCy)
  const opened = await readBoard()
  if (opened.chipsOpen) ok('点那颗词 → 那排词又出来了（可以改）')
  else bad('点那颗词没有重新浮出那排词')
  await s.key('1', 'Digit1', 49)
  const now = await readBoard()
  if (now.kinds[0] === '相关') ok('面板里回到「相关」')
  else bad(`面板里是「${now.kinds[0]}」`)
  if (now.pillText === null && now.arrows === 0) ok('屏幕上那颗词和箭头都撤了（回到默认的样子）')
  else bad(`屏幕上还留着：词=${now.pillText} 箭头=${now.arrows}`)
  const links = await fileLinks()
  if (links && links.length === 0) ok('文件里的 link 字段**没了**（选的就是自动那一档 → 不写字节）')
  else bad(`文件里还留着 ${JSON.stringify(links)} —— 会造假 diff`)
}

/* ═════════════════ 5. 框住那条线 → 浮层里再改一次 ═════════════════ */
console.log('\n[5] 框住那条线，在浮层里选「推导」')
{
  /* 切到框选（点工具条），从**空白处**起手往下拖一个框把线整个圈住。
     起点必须在空白上 —— 在卡片上按下会是拖卡片。
     ★ 框子的边一定要**离那条线有距离**：线正好压在框边上时，
       命中判定（strokeHitsRect）在边界上是说不清楚的 —— 第一次跑就是框边压着线，
       于是"框里一条笔迹都没有"，报出来却是"浮层里没有那排词"。
     ★ 尺寸都从**量到的卡片框**推出来，不写死方向：夹具换成横着摆也照样对。 */
  await pickTool('框选')
  await s.sleep(200)
  const st2 = await readBoard()
  const from = { x: st2.a.x - 70, y: st2.a.y - 60 }
  const to = { x: st2.b.x + st2.b.w + 70, y: st2.b.y + st2.b.h + 60 }
  await s.mouse(from.x, from.y, { steps: 8, dx: to.x - from.x, dy: to.y - from.y })
  const sel = await readBoard()
  if (sel.selLink) ok('框住了那条线：浮层里多出一排词')
  else bad('框住之后没看到那排词（浮层里没有 [data-sel-link]）')
  if (sel.selChips.includes('derive')) ok(`浮层里的词齐全：${sel.selChips.join(' · ')}`)
  else bad(`浮层里的词不对：${JSON.stringify(sel.selChips)}`)
  const picked = await s.eval(`(() => {
    const b = document.querySelector('[data-sel-link] .bd-linkchip[data-link-kind="derive"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  await s.sleep(300)
  const now = await readBoard()
  if (picked && now.kinds[0] === '推导') ok('选「推导」之后面板跟着改了')
  else bad(`点了「推导」，面板里却是「${now.kinds[0]}」`)
  const links = await fileLinks()
  if (links && links.join(',') === 'derive') ok('文件里改成 link: "derive"')
  else bad(`文件里的 link 不对：${JSON.stringify(links)}`)
  await pickTool('笔') // 切回笔：下面两条要画线
  await s.sleep(200)
  await s.key('Escape', 'Escape', 27)
}

/* ═════════════════ 6. 带箭头的一笔：自动读成因果，但不写盘 ═════════════════ */
console.log('\n[6] 一笔画成的箭头：自动读成「因果」，而且**不写进文件**')
{
  const st3 = await readBoard()
  /* 从 B 画回 A，末端回勾出箭头。方向、垂直方向都从两卡位置算出来 ——
     夹具横着摆还是竖着摆都成立（第一版写死"水平往左"，夹具一换就全错）。 */
  const from = { x: st3.b.cx + 10, y: st3.b.cy - 10 }
  const to = { x: st3.a.cx + 10, y: st3.a.cy + 10 }
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  const ux = (to.x - from.x) / len
  const uy = (to.y - from.y) / len
  const px = -uy
  const py = ux
  const steps = []
  const N = 12
  for (let i = 1; i <= N; i++) steps.push({ x: Math.round(from.x + ((to.x - from.x) * i) / N), y: Math.round(from.y + ((to.y - from.y) * i) / N) })
  /* 回勾：先沿反方向退 26px、再往侧面让开 15px（这就是"手画箭头"的动作）。
     世界像素要够大（judge 的阈值是 6/7 世界像素），屏幕缩放 ~1 时 26/15 稳稳够。 */
  steps.push({ x: Math.round(to.x - ux * 26 + px * 15), y: Math.round(to.y - uy * 26 + py * 15) })
  steps.push({ x: Math.round(to.x - ux * 6 - px * 12), y: Math.round(to.y - uy * 6 - py * 12) })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'pen' })
  await sleep(140)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
  for (const p of steps) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'pen' })
    await sleep(12)
  }
  const last = steps[steps.length - 1]
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
  await sleep(300)
  const now = await readBoard()
  if (now.count === 2) ok('第二条连接也认出来了')
  else bad(`连接数变成 ${now.count}，应该是 2`)
  const causeRow = now.kinds.find((k) => k === '因果')
  if (causeRow) ok('带箭头那一笔自动读成「因果」（形状读出来的，不用点）')
  else bad(`带箭头那一笔读成了 ${JSON.stringify(now.kinds)}`)
  const links = await fileLinks()
  if (links && links.join(',') === 'derive') ok('文件里仍然只有你手动标过的那一个词（形状读出来的没写进去）')
  else bad(`文件里的 link 变了：${JSON.stringify(links)} —— 形状读出来的东西不该写盘`)
}

/* ═════════════════ 6b. 他本人画的箭头（两笔：一杆 + 一个 V 尖）═════════════════ */
console.log('\n[6b] 用他本人的笔迹（scripts/fixtures/hand-arrows.json）：一杆 + 一个 V 尖，两笔')
{
  /* ★ 这一节为什么值得存在：**判据的阈值是从这里来的。**
     用户 2026-09-16 把两张手画箭头的截图发来，scripts/extract-hand-arrows.py
     把墨迹解成骨架、按纸的横线反推出缩放，得到"杆 / 两只臂"的真实点列。
     这里就是把那两条真实点列**按屏幕映射画一遍**（真笔事件），
     再看应用认不认 —— 判据只在合成图形上验过，是不算数的。
     ⚠ 这条也顺带钉住"合成的箭头不许叠在你自己画的尖上"（headInk）。 */
  const fix = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures', 'hand-arrows.json'), 'utf8'))
  const img = fix.images.find((x) => x.key === 'long')
  const role = Object.fromEntries(img.strokes.map((x) => [x.role, toPoints(x.points)]))
  const V = role.barbA.slice().reverse().concat(role.barbB) // 一个 V：臂A 的末端 → 尖 → 臂B 的末端

  /* 摆法：**全部按屏幕上量到的卡片位置算**，不去猜卡片的"世界坐标"。
     ★ 为什么不能猜：应用打开板子时会**按内容重算一次卡片尺寸**（第 16 条踩过的坑），
       夹具里写的 w:220 到屏幕上就不是 220 了 —— 拿它反推世界坐标会整体偏上百像素，
       箭头画到两张卡外面去（第一版就是这么"画了但不算连接"的）。
     世界→屏幕只用一次：把**应用自己存下来的点**映回来，跟我要画的位置对一下
     （这一步验的是"我算的屏幕坐标和应用算的是不是同一套"）。 */
  const bt = await readBoard()
  const A = bt.a
  const B = bt.b
  const tailW = role.shaft[0]
  const tipW0 = role.shaft[role.shaft.length - 1]
  const shaftLen = Math.hypot(tipW0.x - tailW.x, tipW0.y - tailW.y)
  /* 杆尾放在 A 里靠下 3/4 处；尖停在 B 上边往上 16px ——
     他真实的画法就是"停在卡前面一点"（尖得留出画 V 的地方）。 */
  const tailS = { x: A.cx, y: A.y + Math.round(A.h * 0.75) }
  const tipS = { x: B.cx, y: B.y - 16 }
  const k = Math.hypot(tipS.x - tailS.x, tipS.y - tailS.y) / shaftLen
  /* 旋转量：把**夹具里"杆 → 尖"的方向**转到**屏幕上"A → B"的方向**。
     ⚠ 这里必须是"世界方向 → 屏幕方向"的**角度差**（两套坐标系的朝向不一样：
       他的箭头在世界里指向 +x，而这两张卡是上下摆的，屏幕上要指向 +y）。
       第一版把世界方向当屏幕方向直接用了，于是箭头整个横过来，
       尖落到两张卡外面 —— 症状是"画了但不算连接"。 */
  const angW = Math.atan2(tipW0.y - tailW.y, tipW0.x - tailW.x)
  const angS = Math.atan2(B.cy - A.cy, B.cx - A.cx)
  const cosR = Math.cos(angS - angW)
  const sinR = Math.sin(angS - angW)
  const place = (p) => {
    const vx = (p.x - tailW.x) * k
    const vy = (p.y - tailW.y) * k
    return { x: tailS.x + vx * cosR - vy * sinR, y: tailS.y + vx * sinR + vy * cosR }
  }
  const shaftS = role.shaft.map(place)
  const vS = V.map(place)
  console.log(`  （贴在卡片上：杆尾 (${Math.round(shaftS[0].x)},${Math.round(shaftS[0].y)}) → 尖 (${Math.round(tipS.x)},${Math.round(tipS.y)})，B 的上边在 y=${B.y}）`)

  /* 沿点列走真笔事件（点之间插值，别让浏览器看到几像素一跳的折线）。 */
  const drawScreen = async (pts) => {
    const first = pts[0]
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, button: 'none', buttons: 0, pointerType: 'pen' })
    await sleep(140)
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
    let last = first
    for (const p of pts.slice(1)) {
      const d = Math.hypot(p.x - last.x, p.y - last.y)
      const n = Math.max(1, Math.ceil(d / 4))
      for (let i = 1; i <= n; i++) {
        await s.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n,
          button: 'left', buttons: 1, pointerType: 'pen',
        })
        await sleep(8)
      }
      last = p
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
    await sleep(260)
  }

  await s.key('Escape', 'Escape', 27)
  await drawScreen(shaftS) // ① 一杆
  await s.key('Escape', 'Escape', 27) // 把这杆浮出来的那排词收掉（不然下面数词会数到它）
  await drawScreen(vS) // ② 一个 V 尖（单独一笔）

  /* 验一次"我算的屏幕坐标 = 应用算的"：把**应用自己存下来的点**（板文件里的最后一笔）
     用同一个公式映回屏幕，跟我打算画的位置比。差一点点没关系（应用会抽稀），
     差几十像素就说明 dpr / 原点 / 缩放有一样算错了。 */
  await sleep(1100)
  let mapOk = null
  try {
    const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    const last = doc.strokes[doc.strokes.length - 1]
    const w0 = { x: last.points[0], y: last.points[1] }
    const vi = await s.eval(`(() => {
      const [xs, xtx, xty] = document.querySelector('canvas.bd-ink').dataset.xform.split(',').map(Number)
      const dpr = window.devicePixelRatio || 1
      const st = document.querySelector('.bd-stagewrap').getBoundingClientRect()
      return { s: xs / dpr, tx: xtx / dpr, ty: xty / dpr, left: st.left, top: st.top }
    })()`)
    const back = { x: vi.left + w0.x * vi.s + vi.tx, y: vi.top + w0.y * vi.s + vi.ty }
    mapOk = Math.hypot(back.x - vS[0].x, back.y - vS[0].y)
    if (mapOk <= 6) ok(`世界→屏幕的映射对得上（应用存下的第一点映回来离我要画的地方 ${mapOk.toFixed(1)}px，缩放 ${vi.s.toFixed(3)}）`)
    else bad(`映射差了 ${mapOk.toFixed(1)}px：应用存的是 ${JSON.stringify(w0)}，映回屏幕是 (${Math.round(back.x)},${Math.round(back.y)})，我要画的是 (${Math.round(vS[0].x)},${Math.round(vS[0].y)})`)
  } catch (e) {
    bad('读不到板文件里的最后一笔：' + e.message)
  }

  const now = await readBoard()
  if (now.count === 3) ok('连接变成 3 条（这一杆连着 A → B）')
  else bad(`连接数是 ${now.count}，应该是 3`)
  if (now.kinds.filter((x) => x === '因果').length === 2) ok('两笔分开画的箭头也被读成「因果」—— 尖是旁边那一笔，但它认出来了')
  else bad(`面板里的词是 ${JSON.stringify(now.kinds)}，应该出现两次「因果」`)
  if (now.pills === 3) ok('三条连接各一颗词（手动标的「推导」+ 两条读出来的「因果」）')
  else bad(`屏幕上挂着 ${now.pills} 颗词，应该是 3`)
  /* ★ 合成箭头的数：只有**手动标了方向**的那条（[5] 标的「推导」）才画一个。
     这一节的两条箭头（[6] 的回勾 + 这里的真箭头）都应该**一个都不画** ——
     尖是用户自己画上去的，再叠一个就是"一支箭上长两个头"。 */
  if (now.arrows === 1) ok('屏幕上只有 1 个合成箭头（[5] 那条手动标了「推导」的）；你自己画了尖的两条都不叠')
  else bad(`屏幕上有 ${now.arrows} 个合成箭头 —— 应该是 1（手动标的那条）`)
  const links = await fileLinks(200)
  if (links && links.join(',') === 'derive') ok('文件里还是只有你手动标过的那一个词（形状读出来的一律不写盘）')
  else bad(`文件里的 link 变了：${JSON.stringify(links)}`)
}

/* ═════════════════ 7. 空白处的乱笔不算连接 ═════════════════ */
console.log('\n[7] 在空白处乱画一笔：不算连接，也不浮词')
{
  /* ★ 先把上一笔留下的那排词收掉再测。
     踩过：上一步（带箭头那一笔）也浮了词，3.5 秒才自己收走 ——
     不等它收就画乱笔，看到的还是**上一步那排词**，报出来却是"乱画也浮词"。
     这类"上一屏的东西还没走"的假红，在这一族自检里很常见（浮层都有停留时间）。 */
  await s.key('Escape', 'Escape', 27)
  const st4 = await readBoard()
  if (!st4.chipsOpen) ok('先把上一步那排词收干净了（不然下面看到的是它）')
  else bad('那排词没收掉 —— 这一条没测准')
  if (st4.count !== 3) bad(`开始这一步时连接应该是 3 条，实际 ${st4.count}`)
  /* 空白处：两张卡中间那一带的**侧面**（中轴上是那条连线）。 */
  const x = st4.a.cx + Math.round(st4.a.w * 0.75)
  const y = Math.round((st4.a.y + st4.a.h + st4.b.y) / 2)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'pen' })
  await sleep(120)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
  for (let i = 1; i <= 8; i++) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + i * 9, y: y + (i % 2 ? 14 : -14), button: 'left', buttons: 1, pointerType: 'pen' })
    await sleep(12)
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 72, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
  await sleep(300)
  const now = await readBoard()
  if (now.count === 3) ok('连接还是 3 条（乱笔没有变成关系）')
  else bad(`连接变成了 ${now.count} 条 —— 空白处的笔被当成连线了`)
  if (!now.chipsOpen) ok('也没有浮出那排词（不该打断你）')
  else bad('乱画一笔也浮出了那排词')
}

/* ═════════════════ 8. 重开：你标过的词还在 ═════════════════ */
console.log('\n[8] 重开一次：你标过的那个词还在')
{
  await s.send('Page.navigate', { url: APP })
  await openFixture()
  const now = await readBoard()
  if (now.count === 3) ok('重开之后还是 3 条连接（都是从笔迹现算的）')
  else bad(`重开之后连接数变成 ${now.count}`)
  if (now.kinds.includes('推导')) ok('你标过的「推导」还在（存在那一笔上）')
  else bad(`你标过的词丢了：${JSON.stringify(now.kinds)}`)
  if (now.kinds.filter((k) => k === '因果').length === 2) ok('两条形状读出来的「因果」也都在（每次从笔迹重算）')
  else bad(`形状读出来的词丢了：${JSON.stringify(now.kinds)}`)
}

/* ═════════════════ 9. 「这条不算连接」：读错了要能一键改回来 ═════════════════ */
console.log('\n[9] 「不算连接」：自动读错了能一键改回来（点错了还能改回去）')
{
  /* 为什么这一条这么要紧：形状/位置读出来的连接**会读错**（实测：一条 121px 的手写竖笔
     正好跨过两坨字就被读成连接）。没有这个口子的话，猜错了只能擦掉那一笔重画 ——
     那就成了"猜错还锁死"。这里走一遍真实路径：画一条线 → 点「不算连接」→ 它不再是关系、
     文件里写着 link:"none" → 再框住它 → 点「又算回连接」→ 它又回来了。 */
  const st5 = await readBoard()
  if (st5.count === 3) ok(`开始这一步时有 ${st5.count} 条连接`)
  else bad(`开始这一步时应该是 3 条连接，实际 ${st5.count}`)

  /* ① 再画一条 A→B 的线（从卡片里偏一点起手，免得和 [1] 那条完全重合） */
  const from = { x: st5.a.cx - Math.round(st5.a.w * 0.25), y: st5.a.cy }
  const to = { x: st5.b.cx + Math.round(st5.b.w * 0.25), y: st5.b.cy }
  await pickTool('笔')
  await s.sleep(150)
  await s.penStroke(from, to, { steps: 10, hover: true })
  const drew = await readBoard()
  if (drew.count === 4) ok('新画的这条也成了连接（4 条）')
  else bad(`画完应该是 4 条连接，实际 ${drew.count}`)
  if (drew.chipsOpen) ok('那排词浮出来了（「不算连接」就在这排里）')
  else bad('没浮出那排词，后面点不到「不算连接」')

  /* ② 点那排词里的「不算连接」 */
  const clicked = await s.eval(`(() => {
    const chips = document.querySelector('.bd-linkchips')
    if (!chips) return 'no-chips'
    const b = chips.querySelector('.bd-linkchip[data-link-kind="none"]')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  if (clicked === 'ok') ok('点了「不算连接」')
  else bad(`点不到「不算连接」那颗（${clicked}）`)
  await s.sleep(400)
  const after = await readBoard()
  if (after.count === 3) ok('它不再是连接了（回到 3 条）')
  else bad(`点完还剩下 ${after.count} 条连接，应该是 3 条`)
  const links9 = await fileLinks()
  if (links9 && links9.includes('none')) ok('文件里那一笔写着 link: "none"（重开也丢不了）')
  else bad(`文件里没有 link: "none"：${JSON.stringify(links9)}`)

  /* ③ 重开一次：这句"不算连接"还在 */
  await s.send('Page.navigate', { url: APP })
  await openFixture()
  const reopened = await readBoard()
  if (reopened.count === 3) ok('重开之后它仍然不算连接（那句话是存在笔迹上的）')
  else bad(`重开之后连接数变成 ${reopened.count}`)

  /* ④ 回头路：框住那一笔 → 浮层里出现「又算回连接」→ 点它 → 它又回来了 */
  await pickTool('框选')
  await s.sleep(200)
  const st6 = await readBoard()
  /* ⚠ 框子要从**卡片外面的空白**起手、一路框过两张卡（和 [5] 同一套写法）：
     起点落在卡片上就成了"拖卡片"，画不出框 —— 第一次写这一步时框了 80×80 的小框、
     起点正好在卡上，于是"[data-ink-nolink] 没出现"，看起来像功能坏了。
     框大一点没关系：选中一条 noLink 的笔就够了（清的时候只清它）。 */
  const f2 = { x: st6.a.x - 70, y: st6.a.y - 60 }
  const t2 = { x: st6.b.x + st6.b.w + 70, y: st6.b.y + st6.b.h + 60 }
  await s.mouse(f2.x, f2.y, { steps: 8, dx: t2.x - f2.x, dy: t2.y - f2.y })
  const sel = await readBoard()
  if (sel.inkNoLink) ok('框住它之后，浮层里出现了「又算回连接」')
  else bad('框住之后没看到回头路（[data-ink-nolink]）')
  const back = await s.eval(`(() => {
    const b = document.querySelector('[data-ink-nolink] .bd-linkchip')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  if (back === 'ok') ok('点了「又算回连接」')
  else bad(`点不到「又算回连接」（${back}）`)
  await s.sleep(400)
  const restored = await readBoard()
  if (restored.count === 4) ok('它又算回连接了（4 条）')
  else bad(`恢复之后是 ${restored.count} 条，应该是 4 条`)
  const links9b = await fileLinks()
  if (links9b && !links9b.includes('none')) ok('文件里那个 link: "none" 也去掉了')
  else bad(`文件里还留着 link: "none"：${JSON.stringify(links9b)}`)
}

/* ═════════════════ 10. 框选固化：固定成一块 / 拆开 ═════════════════ */
console.log('\n[10] 框选固化（`groups`）：固定成一块 → 文件里记下来 → 能拆开')
{
  /* 自动聚类会把挨得近的并成一块。这一步验的是"纠正它的那个口子"：
     框住一块 → ⧉ 固定成一块 → 写进 groups；再点 ⧉ 拆开 → 那个字段消失。 */
  await pickTool('框选')
  await s.sleep(200)
  const st7 = await readBoard()
  const f3 = { x: st7.a.x - 70, y: st7.a.y - 60 }
  const t3 = { x: st7.a.x + st7.a.w + 70, y: st7.a.y + st7.a.h + 60 }
  await s.mouse(f3.x, f3.y, { steps: 8, dx: t3.x - f3.x, dy: t3.y - f3.y })
  const sel = await readBoard()
  if (sel.inkBox && sel.inkActs) ok('框住了东西（虚线框和那排动作都在）')
  else bad(`框选没选上东西（inkBox=${sel.inkBox} inkActs=${sel.inkActs}）—— 后面两条没意义`)
  const hasFreeze = await s.eval(`!!document.querySelector('[data-ink-group="on"]')`)
  if (hasFreeze) ok('浮层上有「⧉ 固定成一块」')
  else bad('浮层上没有「固定成一块」那个按钮')

  const clicked = await s.eval(`(() => {
    const b = document.querySelector('[data-ink-group="on"]')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  if (clicked === 'ok') ok('点了「固定成一块」')
  else bad(`点不到那个按钮（${clicked}）`)
  await sleep(1200)
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  if (Array.isArray(doc.groups) && doc.groups.length === 1 && doc.groups[0].ids.length >= 2) {
    ok(`文件里写下了 1 块（${doc.groups[0].ids.length} 笔）`)
  } else {
    bad(`文件里的 groups 不对：${JSON.stringify(doc.groups)}`)
  }
  const flip = await s.eval(`!!document.querySelector('[data-ink-group="off"]')`)
  if (flip) ok('按钮换成了「⧉ 拆开这块」（说明它认得出这是固定块）')
  else bad('固定之后按钮没换成「拆开」')

  const undone = await s.eval(`(() => {
    const b = document.querySelector('[data-ink-group="off"]')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  if (undone === 'ok') ok('点了「拆开这块」')
  else bad(`点不到「拆开」（${undone}）`)
  await sleep(1200)
  const doc2 = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  if (!doc2.groups || doc2.groups.length === 0) ok('拆开之后文件里那个字段也没了（不留空壳）')
  else bad(`拆开之后 groups 还在：${JSON.stringify(doc2.groups)}`)
}

/* ═════════════════ 11. 条件从位置送 + 推导链 ═════════════════ */
console.log('\n[11] 条件从位置送：线中点旁边写几个字，面板上的"缺条件"就变成"条件：…"')
{
  /* 用户的原话：「条件是位置送的。线中点附近那几个字 / 那张卡，自动成为这条关系的条件
     —— 你本来就要写"仅当…"，不用再告诉它是谁的条件。」
     这一步走的正是那句话：链上那一步缺条件 → 在线中点旁边写两笔 → 它自己补上。 */
  const st8 = await readBoard()
  if (st8.chainCount === 1) ok('面板里读出了 1 条推导链（[5] 标的那条「推导」）')
  else bad(`推导链应该是 1 条，实际 ${st8.chainCount}（chainConds=${JSON.stringify(st8.chainConds)}）`)
  const before = await readBoard()
  const missBefore = before.chainMissing
  if (missBefore >= 0) ok(`现在有 ${missBefore} 步是"缺条件"（下一步把它补上）`)
  /* 在那条线的**中点**旁边写两个短笔 —— 尺寸要按**世界像素**算：
     条件要过"块的最小个头"（18 世界像素）和"中点在 64 世界像素之内"两条闸，
     而屏幕上看到的距离要乘/除视图缩放。缩放从"两张卡的屏幕距离 ÷ 世界距离"量出来
     （踩过：第一次按屏幕像素画 22px，视图一缩小就只剩 11 世界像素 → 个头不够、条件读不出来）。 */
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const ca = fixture.cards.find((c) => c.id === 'lk-a')
  const cb = fixture.cards.find((c) => c.id === 'lk-b')
  const wDist = Math.hypot(ca.x + ca.w / 2 - (cb.x + cb.w / 2), ca.y + ca.h / 2 - (cb.y + cb.h / 2))
  const sDist = Math.hypot(before.a.cx - before.b.cx, before.a.cy - before.b.cy)
  const scale = wDist > 0 ? sDist / wDist : 1
  const mx = Math.round((before.a.cx + before.b.cx) / 2)
  const my = Math.round((before.a.cy + before.b.cy) / 2)
  const wx = (n) => n * scale // 世界像素 → 屏幕像素
  await pickTool('笔')
  await s.sleep(150)
  /* 两条 30 世界像素的短笔（< INK_LINK_MIN_LEN 48，所以不会变成新连接），
     离中点 30 / 40 世界像素（< LINK_COND_RADIUS 64），彼此差 10 像素（< 24 → 聚成一块） */
  await s.penStroke({ x: mx - wx(15), y: my - wx(40) }, { x: mx + wx(15), y: my - wx(38) }, { steps: 4, hover: true })
  await s.penStroke({ x: mx - wx(14), y: my - wx(30) }, { x: mx + wx(16), y: my - wx(28) }, { steps: 4, hover: true })
  await s.key('Escape', 'Escape', 27) // 收掉可能浮出来的那排词，别挡住读数
  await s.sleep(500)
  const after = await readBoard()
  if (after.ink > before.ink) ok(`中点旁边真的写上了（墨迹层 ${before.ink} → ${after.ink}，缩放 ${scale.toFixed(2)}）`)
  else bad(`那两笔没写上（墨迹层 ${before.ink} → ${after.ink}）—— 后面的读数没意义`)
  if (after.chainMissing < missBefore || (missBefore === 0 && after.chainConds.length > 0)) {
    ok(`写完那几个字，"缺条件"少了（${missBefore} → ${after.chainMissing}）`)
  } else {
    bad(`在中点旁边写了字，条件没被读出来（missing ${missBefore} → ${after.chainMissing}，conds=${JSON.stringify(after.chainConds)}）`)
  }
  if (after.condRows.some((t) => /条件/.test(t))) ok(`「你画过的」那一行也挂上了条件（${after.condRows[0]}）`)
  else bad(`连接那一行没显示条件：${JSON.stringify(after.condRows)}`)
  if (after.count === before.count) ok('这两笔短笔没有变成新连接（够短 → 不进连接那套判据）')
  else bad(`短笔变成了连接：${before.count} → ${after.count}`)
  /* 条件**不写盘**：它是从位置读出来的，文件里一个字段都不该多 */
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  if (!JSON.stringify(doc).includes('"cond"')) ok('条件没写进文件（位置读出来的，随时能重算）')
  else bad('文件里出现了 cond 字段 —— 位置推断不该存盘')
}

/* ═════════════════ 12. 页面里不许有 JS 报错 ═════════════════ */
console.log('\n[12] 整个流程跑下来，页面里没有任何 JS 报错')
if (!s.exceptions.length) ok('没有报错 —— "处理器抛异常"和"处理器没跑"在屏幕上是同一个样子，所以这条是兜底')
else bad(`页面里有 ${s.exceptions.length} 条报错：` + s.exceptions.slice(0, 3).join(' ｜ '))

console.log(fails ? `\n  ${fails} 项失败\n` : '\n  全部通过\n')
cleanup()
process.exit(fails ? 1 : 0)
