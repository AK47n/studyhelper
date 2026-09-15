/* 手写识别的端到端自检：真浏览器 + 真本地服务 + **假的识别服务**。
 *
 * ── 这一条测的是"整条链路"，不是某一层 ──
 *   写字板上画一笔（合成指针事件）
 *     → 前端把笔迹画成 PNG → POST /api/ocr
 *     → 本地服务加上密钥转发给"识别服务"（这里是一个本地假服务）
 *     → 拿回 LaTeX → 渲染预览 → 点"放到白板上" → 白板上真的多了一张公式卡
 * 每一步都断言，而且假服务会把**收到的东西**记下来给这里检查。
 *
 * ── 为什么必须用真浏览器 ──
 * canvas.toBlob、指针事件、ResizeObserver 在 jsdom 里都没有。
 * "画了一笔但发出去一张空白图"这种错，只有真浏览器能发现。
 *
 * ── 完全离线、不花额度 ──
 * 假服务是我们自己起的。它还会**故意**把鉴权头复制到响应里，
 * 这样这里能断言"密钥确实带上了"，而真密钥一次都没出过这台机器。
 *
 * 跑：npm run check:ocr-browser
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const APP_PORT = Number(process.env.OCR_TEST_APP_PORT || 5179)
const MOCK_PORT = Number(process.env.OCR_TEST_MOCK_PORT || 5198)
const CDP_PORT = Number(process.env.OCR_TEST_CDP_PORT || 9223)
const APP = `http://127.0.0.1:${APP_PORT}/`
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const TEST_TOKEN = 'test-uat-token-abcdefgh'

let fails = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ═════════════ 1. 假的识别服务（DeepSeek 形状）═════════════
/* default provider 现在是 deepseek，所以这个假服务回 OpenAI 兼容的形状：
   { choices: [ { message: { content: "..." } } ] }
   而且**故意**把公式包在 ```latex 里 —— LLM 就是这么干的，
   正好顺便验证"回话清洗"在真链路里也生效。 */
const seen = []
let mockReply = {
  code: 200,
  body: { choices: [{ message: { role: 'assistant', content: '```latex\nE = mc^{2}\n```' } }] },
}
const mock = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    let json = null
    try {
      json = JSON.parse(raw.toString('utf8'))
    } catch {}
    const content = json && json.messages && json.messages[0] && json.messages[0].content
    const img = Array.isArray(content) ? content.find((c) => c.type === 'image_url') : null
    const b64 = img && img.image_url && img.image_url.url ? String(img.image_url.url).replace(/^data:image\/\w+;base64,/, '') : ''
    seen.push({
      url: req.url,
      method: req.method,
      auth: req.headers.authorization || null,
      contentType: req.headers['content-type'] || '',
      model: json ? json.model : null,
      temperature: json ? json.temperature : null,
      blockTypes: Array.isArray(content) ? content.map((c) => c.type) : null,
      promptText: Array.isArray(content) && content[0] ? String(content[0].text || '') : '',
      imageBytes: b64 ? Buffer.from(b64, 'base64').length : 0,
      imageMagic: b64 ? Buffer.from(b64, 'base64').subarray(0, 4).toString('hex') : null,
    })
    res.writeHead(mockReply.code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mockReply.body))
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r))

// ═════════════ 2. 起本地服务（指向假识别服务）═════════════
// 把可能存在的真配置挪开：这个自检必须用环境变量里的假地址，不能碰用户的真密钥
const realConfig = path.join(ROOT, 'config', 'ocr.json')
const stash = realConfig + '.checkocr-bak'
let stashed = false
if (fs.existsSync(realConfig)) {
  fs.renameSync(realConfig, stash)
  stashed = true
}

const serverLog = []
const server = spawn(process.execPath, ['server.js', '--no-open', '--no-auto-exit'], {
  cwd: ROOT,
  env: {
    ...process.env,
    STUDYHELPER_PORT: String(APP_PORT),
    // 默认 provider 就是 deepseek，这里把它的接口地址指到假服务上
    STUDYHELPER_OCR_PROVIDER: 'deepseek',
    STUDYHELPER_OCR_DS_BASE: `http://127.0.0.1:${MOCK_PORT}/chat/completions`,
    STUDYHELPER_OCR_MODEL: 'deepseek-flash',
    STUDYHELPER_OCR_TOKEN: TEST_TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => serverLog.push(String(d)))
server.stderr.on('data', (d) => serverLog.push(String(d)))

const cleanup = () => {
  try {
    server.kill()
  } catch {}
  try {
    mock.close()
  } catch {}
  if (stashed && fs.existsSync(stash)) {
    try {
      fs.renameSync(stash, realConfig)
    } catch {}
  }
  // 自检期间写下的配置也要清掉（它是假的地址 + 假密钥，留着会让人困惑）
  try {
    if (fs.existsSync(realConfig)) fs.rmSync(realConfig)
  } catch {}
  try {
    if (fs.existsSync(path.join(ROOT, 'config')) && fs.readdirSync(path.join(ROOT, 'config')).length === 0) {
      fs.rmdirSync(path.join(ROOT, 'config'))
    }
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

// 等服务起来
let up = false
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(APP + 'api/list')
    if (r.ok) {
      up = true
      break
    }
  } catch {}
  await sleep(250)
}
if (!up) {
  console.error('\n  本地服务没起来。它的输出：\n' + serverLog.join(''))
  cleanup()
  process.exit(2)
}

// ═════════════ 3. Chrome + CDP ═════════════
const userDataDir = path.join(ROOT, '.cache', 'ocr-cdp')
fs.rmSync(userDataDir, { recursive: true, force: true })
const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1440,900',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    APP,
  ],
  { stdio: 'ignore' }
)
process.on('exit', () => {
  try {
    chrome.kill()
  } catch {}
})

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(JSON.stringify(m.error)))
        else resolve(m.result)
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
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
}

let targets = null
for (let i = 0; i < 40; i++) {
  targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => null)
  if (targets && targets.find((t) => t.type === 'page' && t.url.startsWith('http'))) break
  await sleep(300)
}
const page = targets && targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('\n  Chrome 没起来或没打开页面。CHROME_PATH=' + CHROME)
  cleanup()
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
const s = new Session(ws)
await s.send('Runtime.enable')
await s.send('Page.enable')
await s.send('Page.navigate', { url: APP })
await s.sleep(2600)

// ═════════════════════ 开始断言 ═════════════════════
console.log('\n[1] 工具条上有「手写公式」这个入口')
{
  const has = await s.eval(`[...document.querySelectorAll('.bd-tools .bd-t')].some(b => /手写公式/.test(b.textContent))`)
  if (has) ok('工具条里有「✍ 手写公式」')
  else bad('工具条里找不到手写公式入口')
}

console.log('\n[2] 打开写字板')
{
  await s.eval(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /手写公式/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(500)
  const info = await s.eval(`(() => {
    const pad = document.querySelector('.wp-padwrap')
    const cv = document.querySelector('canvas.wp-pad')
    const r = pad ? pad.getBoundingClientRect() : null
    return {
      open: !!document.querySelector('.wp'),
      padSize: r ? [Math.round(r.width), Math.round(r.height)] : null,
      cvSize: cv ? [cv.width, cv.height] : null,
      warn: (document.querySelector('.wp-warn') || {}).textContent || '',
      hint: (document.querySelector('.wp-hint') || {}).textContent || '',
    }
  })()`)
  if (info.open) ok('写字板弹出来了')
  else bad('写字板没弹出来')
  if (info.padSize && info.padSize[0] > 200 && info.padSize[1] > 100) ok(`写字区有尺寸 ${info.padSize.join('×')}`)
  else bad('写字区尺寸不对：' + JSON.stringify(info.padSize))
  if (info.cvSize && info.cvSize[0] > 300) ok(`画布位图 ${info.cvSize.join('×')}（按 dpr 放大过）`)
  else bad('画布位图太小：' + JSON.stringify(info.cvSize))
  // 环境变量给了假密钥，所以这里不该出现"还没配密钥"的警告
  if (!/还没配/.test(info.warn)) ok('没报"还没配密钥"（环境变量里的假密钥被认了）')
  else bad('明明有密钥却说没配：' + info.warn)

  console.log('\n[3] 在写字板上写一笔')
  const box = await s.eval(`(() => { const r = document.querySelector('.wp-pad').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  const cx = box.x + box.w * 0.3
  const cy = box.y + box.h * 0.5
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 20; i++) {
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cx + i * 9,
      y: cy + Math.sin(i / 2.2) * 26,
      button: 'left',
      buttons: 1,
    })
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 180, y: cy, button: 'left', buttons: 0, clickCount: 1 })
  await s.sleep(400)

  const after = await s.eval(`(() => {
    const meta = [...document.querySelectorAll('.wp-acts .dim')].map(e => e.textContent).join(' ')
    const ink = (() => {
      const cv = document.querySelector('canvas.wp-pad')
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let i = 3; i < d.length; i += 4 * 5) if (d[i] > 20) n++
      return n
    })()
    return { meta, ink, hintGone: !document.querySelector('.wp-hint') }
  })()`)
  if (after.ink > 0) ok(`笔迹真的画上了（墨点采样 ${after.ink}）`)
  else bad('写字板上没画出东西')
  if (/1 笔/.test(after.meta)) ok('界面报「1 笔」')
  else bad('笔数不对：' + after.meta)
  if (/会发一张 \d+×\d+ 的图/.test(after.meta)) ok('把"会发多大的图"告诉你了：' + (after.meta.match(/会发一张 \S+ 的图/) || [''])[0])
  else bad('没有显示要发送的图片尺寸：' + after.meta)
  if (after.hintGone) ok('占位提示自动消失')
  else bad('写了字还留着"在这一块里写"的提示')

  console.log('\n[4] 点「识别」→ 本地服务 → 假识别服务')
  seen.length = 0
  await s.eval(`(() => { const b = [...document.querySelectorAll('.wp-acts .btn')].find(x => /识别/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(1600)

  if (seen.length === 1) ok('假识别服务收到了 1 次请求')
  else bad(`假识别服务收到 ${seen.length} 次请求（期望 1）`)
  if (seen[0]) {
    const r = seen[0]
    if (r.url === '/chat/completions') ok('打到 OpenAI 兼容的 /chat/completions（DeepSeek 那条路）')
    else bad('打错了地址：' + r.url)
    if (r.method === 'POST') ok('用的是 POST')
    else bad('方法不对：' + r.method)
    if (r.auth === 'Bearer ' + TEST_TOKEN) ok('鉴权是 Authorization: Bearer，值就是配置里那一串')
    else bad('鉴权头不对：' + r.auth)
    if (r.model === 'deepseek-flash') ok('model=deepseek-flash（旧名字已下线，用错会被拒）')
    else bad('model 不对：' + r.model)
    if (r.temperature === 0) ok('temperature=0（识别是"抄"，不让它发挥）')
    else bad('temperature 不是 0：' + r.temperature)
    if (Array.isArray(r.blockTypes) && r.blockTypes.includes('text') && r.blockTypes.includes('image_url')) {
      ok(`content 是块数组，含 ${JSON.stringify(r.blockTypes)}（写成字符串会被 400）`)
    } else {
      bad('content 块数组不对：' + JSON.stringify(r.blockTypes))
    }
    if (/只输出.*LaTeX/.test(r.promptText)) ok('带上了"只输出 LaTeX"的指令（不写它会回一句人话）')
    else bad('提示词没发出去：' + r.promptText.slice(0, 60))
    if (r.imageMagic === '89504e47') ok('图是 base64 内联的 PNG（魔数 89 50 4e 47）')
    else bad('发出去的图不对，魔数 ' + r.imageMagic)
    if (r.imageBytes > 2000) ok(`图片有实际内容（${r.imageBytes} 字节）—— 不是一张空白图`)
    else bad(`图片只有 ${r.imageBytes} 字节，多半是空白的（笔迹没画上去？）`)
  }

  console.log('\n[5] 认出来的东西要能看、能改、能放上去')
  const res = await s.eval(`(() => {
    const el = document.querySelector('.wp-res')
    return {
      shown: !!el,
      katex: el ? el.querySelectorAll('.katex').length : 0,
      conf: (document.querySelector('.wp-conf') || {}).textContent || '',
      draft: (document.querySelector('.wp-res .wp-edit') || {}).value || '',
      insertBtn: !!([...document.querySelectorAll('.wp-res-acts .btn')].find(b => /放到白板上/.test(b.textContent))),
    }
  })()`)
  if (res.shown) ok('结果区出现了')
  else bad('没有结果区（识别可能失败了）')
  if (res.katex > 0) ok('结果渲染成了数学（KaTeX）')
  else bad('结果没有渲染成数学 —— 认出来的 LaTeX 有问题？')
  /* ★ 这一条是"回话清洗"在真链路里的证据：
     假服务故意回的是 ```latex\nE = mc^{2}\n```，也就是**带代码块围栏**的。
     前端必须把围栏剥掉、把式子取出来 —— 不然卡片上会显示一串反引号。
     （SimpleTex 不会这么回，所以这个问题只有走 LLM 那条路才会遇到。） */
  if (res.draft === 'E = mc^{2}') ok('把模型回的 ```latex 围栏剥掉了，只留下式子：' + res.draft)
  else bad('围栏没剥干净：' + JSON.stringify(res.draft))
  if (res.insertBtn) ok('有「放到白板上」按钮')
  else bad('没有放上去的按钮')

  const cardsBefore = await s.eval(`document.querySelectorAll('.bd-card').length`)
  await s.eval(`(() => { const b = [...document.querySelectorAll('.wp-res-acts .btn')].find(x => /放到白板上/.test(x.textContent)); b.click(); return 1 })()`)
  /* ★ 轮询，别睡死一个固定时间。
     这里是"点一下 → React 渲染新卡片 → 新卡片进编辑态"，是异步的。
     固定 sleep(700) 会**偶发**失败（我遇到过一次"新卡片没进编辑态"，
     重跑就过）—— 偶发红灯比没有测试更糟：你会开始不信红灯。
     判据：卡片数到位**并且**编辑态出现。 */
  let afterInsert = { cards: cardsBefore, padClosed: false, editing: false }
  for (let i = 0; i < 20; i++) {
    await s.sleep(250)
    afterInsert = await s.eval(`(() => ({
      cards: document.querySelectorAll('.bd-card').length,
      padClosed: !document.querySelector('.wp'),
      editing: !!document.querySelector('.bd-card.editing'),
    }))()`)
    if (afterInsert.cards > cardsBefore && afterInsert.editing && afterInsert.padClosed) break
  }
  if (afterInsert.cards === cardsBefore + 1) ok(`白板上多了一张卡（${cardsBefore} → ${afterInsert.cards}）`)
  else bad(`卡片数没变（${cardsBefore} → ${afterInsert.cards}）`)
  if (afterInsert.padClosed) ok('写字板自己关掉了')
  else bad('写字板没关')
  if (afterInsert.editing) ok('新卡片直接进入编辑态（识别总会认错，让你马上能改）')
  else bad('新卡片没进编辑态')

  await s.sleep(1200) // 等自动存盘
  const saved = await s.eval(`(() => { const e = document.querySelector('.bd-save'); return e ? e.textContent : null })()`)
  if (saved === '已存') ok('识别出来的公式已经落盘')
  else bad('没落盘：状态「' + saved + '」')
}

console.log('\n[6] 失败路径：密钥不对时要说人话')
{
  mockReply = { code: 401, body: { error: { message: 'Authentication Fails' } } }
  await s.eval(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /手写公式/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(400)
  const box = await s.eval(`(() => { const r = document.querySelector('.wp-pad').getBoundingClientRect(); return { x: r.left + 60, y: r.top + 60 } })()`)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 10, y: box.y + i * 4, button: 'left', buttons: 1 })
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 100, y: box.y + 40, button: 'left', buttons: 0, clickCount: 1 })
  await s.sleep(300)
  await s.eval(`(() => { const b = [...document.querySelectorAll('.wp-acts .btn')].find(x => /识别/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(1200)

  const err = await s.eval(`(() => {
    const el = document.querySelector('.wp-err')
    return { text: el ? el.textContent : '', cls: el ? el.className : '', hasSettingsBtn: !!(el && el.querySelector('button')) }
  })()`)
  if (/密钥不对/.test(err.text)) ok('401 被翻译成「密钥不对」（而不是"识别失败"）')
  else bad('401 的提示不对：' + err.text)
  if (err.hasSettingsBtn) ok('直接给了「打开设置」的按钮')
  else bad('没给去设置的入口')
  if (/kind-key/.test(err.cls)) ok('错误分了类（界面能按类别给不同的下一步）')
  else bad('错误没分类：' + err.cls)

  // 关掉写字板，别影响后面的检查
  await s.eval(`(() => { const x = document.querySelector('.wp-x'); if (x) x.click(); return 1 })()`)
  await s.sleep(300)
}

console.log('\n[7] 键盘：W 打开写字板，Esc 关掉')
{
  await s.eval(`(() => { document.body.focus(); return 1 })()`)
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await s.sleep(400)
  const opened = await s.eval(`!!document.querySelector('.wp')`)
  if (opened) ok('按 W 打开了写字板')
  else bad('W 没打开写字板')
  await s.eval(`(() => { const x = document.querySelector('.wp-x'); if (x) x.click(); return 1 })()`)
  await s.sleep(300)
  const closed = await s.eval(`!document.querySelector('.wp')`)
  if (closed) ok('关得掉')
  else bad('关不掉')
}

console.log('\n' + '─'.repeat(56))
console.log(fails ? `  ${fails} 项失败` : '  全部通过')
ws.close()
cleanup()
process.exit(fails ? 1 : 0)
