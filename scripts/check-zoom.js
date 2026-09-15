/* 字号调节的体检：确认"放大"和"缩小"**成对存在**，而且真的生效。
 *
 * 为什么值得单独一个脚本：这个功能曾经是**单向**的 ——
 * 左栏那个按钮写死"字太小 →"、只会放大，而白板模式下顶栏不渲染
 * （白板用自己的工具条），于是白板里根本找不到"调小"的入口。
 * 这种"只做了一半"的功能，看一半的代码是看不出来的 ——
 * 所以这里把两个方向都点一遍，并且断言 --s 真的变了。
 *
 * 跑：node scripts/check-zoom.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'
const CDP_PORT = Number(process.env.CDP_PORT || 9228)
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}

const profile = path.join(ROOT, '.cache', 'zoom-cdp')
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
await send('Page.navigate', { url: APP })
await sleep(2600)

// 每次都从默认值开始，免得受上次（localStorage 记着）影响
await ev(`(() => { localStorage.removeItem('studyhelper.scale'); return 1 })()`)
await send('Page.navigate', { url: APP })
await sleep(2600)

const readS = () => ev(`getComputedStyle(document.documentElement).getPropertyValue('--s').trim()`)
const readPct = () => ev(`(() => { const e = document.querySelector('.bd-t.zoomish'); return e ? e.textContent.trim() : null })()`)
const clickSel = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing'; e.click(); return 'ok' })()`)
const clickByText = (sel, text) =>
  ev(`(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)}))
    if (!e) return 'missing'
    e.click(); return 'ok'
  })()`)

console.log('\n[1] 白板工具条上，字号必须是成对的')
{
  const btns = await ev(`(() => [...document.querySelectorAll('.bd-tools .bd-t')].map(b => b.textContent.trim()))()`)
  const hasMinus = btns.some((t) => t.includes('A−'))
  const hasPlus = btns.some((t) => t.includes('A+'))
  if (hasMinus) ok('有 A−（调小）')
  else bad('工具条上找不到 A− —— 只能放大，不能缩小')
  if (hasPlus) ok('有 A+（放大）')
  else bad('工具条上找不到 A+')
  const pct = await readPct()
  if (pct && /%$/.test(pct)) ok('中间显示当前百分比：' + pct)
  else bad('没有显示当前百分比：' + pct)

  // 画布缩放和界面字号都在同一根工具条上，必须有区分标签
  const hasLabel = await ev(`!!document.querySelector('.bd-zoomlabel')`)
  if (hasLabel) ok('画布缩放那组有「纸」标签，不会和字号那组搞混')
  else bad('两组 −/+ 摆在一起却没有区分标签，用户会懵')
}

console.log('\n[2] 点 A+ 真的变大、点 A− 真的变小')
{
  const s0 = await readS()
  console.log('      起始 --s = ' + s0)
  await clickByText('.bd-tools .bd-t', 'A+')
  await sleep(250)
  const s1 = await readS()
  if (parseFloat(s1) > parseFloat(s0)) ok(`A+ 之后 --s ${s0} → ${s1}（真的变大了）`)
  else bad(`A+ 没生效：--s 还是 ${s1}`)

  await clickByText('.bd-tools .bd-t', 'A−')
  await sleep(250)
  const s2 = await readS()
  if (parseFloat(s2) < parseFloat(s1)) ok(`A− 之后 --s ${s1} → ${s2}（真的变小了）`)
  else bad(`A− 没生效：--s 还是 ${s2}`)

  // 连点到底：上限/下限时按钮要禁用，不能点出负数或者无限大
  for (let i = 0; i < 30; i++) await clickByText('.bd-tools .bd-t', 'A−')
  await sleep(300)
  const sMin = parseFloat(await readS())
  const minusDisabled = await ev(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => x.textContent.includes('A−')); return b ? b.disabled : null })()`)
  if (sMin >= 0.9 - 1e-9) ok(`连点 30 次 A− 停在 ${sMin}（下限守住了）`)
  else bad(`连点 A− 冲过了下限：${sMin}`)
  if (minusDisabled === true) ok('到底之后 A− 变灰（不会让人白点）')
  else bad('到底之后 A− 还是可点的：' + minusDisabled)

  for (let i = 0; i < 40; i++) await clickByText('.bd-tools .bd-t', 'A+')
  await sleep(300)
  const sMax = parseFloat(await readS())
  if (sMax <= 2 + 1e-9) ok(`连点 40 次 A+ 停在 ${sMax}（上限守住了）`)
  else bad(`连点 A+ 冲过了上限：${sMax}`)

  // 百分比按钮：点一下回默认
  await clickSel('.bd-t.zoomish')
  await sleep(300)
  const sBack = parseFloat(await readS())
  if (Math.abs(sBack - 1.25) < 1e-6) ok(`点百分比回到默认 ${sBack}`)
  else bad(`点百分比没回到 125%，现在是 ${sBack}`)
}

console.log('\n[3] 左栏那个入口也得是双向的')
{
  const row = await ev(`(() => [...document.querySelectorAll('.side-zoom-row button')].map(b => b.textContent.trim()))()`)
  console.log('      左栏底部按钮：' + JSON.stringify(row))
  const texts = row.join(' ')
  if (/←|小/.test(texts)) ok('左栏有"变小"的入口')
  else bad('左栏只有放大，没有缩小 —— 就是原来那个"不科学"的样子')

  // 真的点一下"变小"，验证它连的是缩小
  const s0 = parseFloat(await readS())
  await clickByText('.side-zoom-row .side-zoom', '小')
  await sleep(250)
  const s1 = parseFloat(await readS())
  if (s1 < s0) ok(`左栏"变小"真的生效：${s0} → ${s1}`)
  else bad(`左栏"变小"没生效：${s0} → ${s1}`)

  // 调小之后，那个按钮该变成"字太小 →"（提示放大）
  const after = await ev(`(() => [...document.querySelectorAll('.side-zoom-row button')].map(b => b.textContent.trim()))()`)
  if (after.join(' ').includes('字太小')) ok('调小之后左栏改口提示"字太小 →"（跟着当前状态走）')
  else bad('调小之后左栏还是提示缩小：' + JSON.stringify(after))

  // 复位
  await clickSel('.side-zoom-val')
  await sleep(250)
  const back = parseFloat(await readS())
  if (Math.abs(back - 1.25) < 1e-6) ok('左栏百分比按钮能复位到 125%')
  else bad('左栏百分比按钮没复位：' + back)
}

console.log('\n[4] 键盘也能两个方向（Ctrl+Shift+加号/减号）')
{
  const s0 = parseFloat(await readS())
  const press = async (key, code, shift) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === '=' ? 187 : 189, modifiers: 2 | (shift ? 8 : 0) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === '=' ? 187 : 189, modifiers: 2 | (shift ? 8 : 0) })
    await sleep(200)
  }
  await press('+', 'Equal', true)
  const s1 = parseFloat(await readS())
  await press('-', 'Minus', true)
  const s2 = parseFloat(await readS())
  if (s1 > s0 && s2 < s1) ok(`Ctrl+Shift+加号/减号 两个方向都生效（${s0} → ${s1} → ${s2}）`)
  else bad(`键盘缩放出问题：${s0} → ${s1} → ${s2}`)
}

console.log('\n' + '─'.repeat(52))
console.log(fails ? `  ${fails} 项失败` : '  全部通过')
ws.close()
chrome.kill()
process.exit(fails ? 1 : 0)
