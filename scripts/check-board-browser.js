/* 白板在**真浏览器**里的自检：用 CDP 连上 headless Chrome，检查
 *  ① 打开就是白板（不是笔记），画布/卡片/连线都真的挂上了
 *  ② 公式卡片渲染成了数学（KaTeX）
 *  ③ 画一笔：合成指针事件 → 笔迹进数据 → 存盘请求发出去了
 *  ④ 落盘的是合法的白板文件（点的坐标必须全是数字）
 *  ⑤ 双击公式卡能编辑，写 dS/dt 就排成分式
 *  ⑥ ★ 墨迹和卡片对齐（这一条只有真浏览器能测，今天栽了三次）
 *  ⑦ 截图，自己也看一眼
 *  ⑧ 三种摆法都能切，切完还能画
 *
 * 为什么非要在真浏览器里跑：jsdom 没有真实尺寸、没有 canvas、没有指针事件 ——
 * 白板恰恰全靠这三样。单元测试（check-board.js）能保证"算得对"，
 * 只有这里能保证"真的画得出来、而且画在对的地方"。
 *
 * 前提：服务跑着（默认 http://127.0.0.1:5177/），Chrome 带
 *       --remote-debugging-port=9222 起着。都不想手动起就用：
 *       npm run check:board-browser
 */
import fs from 'node:fs'

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const APP = process.env.APP_URL || 'http://127.0.0.1:5177/'
const SHOT = process.env.SHOT_PATH || '.cache/board-shot.png'

let fails = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
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
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
}

const targets = await fetch(CDP + '/json/list')
  .then((r) => r.json())
  .catch(() => null)
if (!targets) {
  console.error(`\n  连不上 Chrome 的调试端口 ${CDP}。先起一个（或者用 npm run check:board-browser）：`)
  console.error(`    chrome --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\\sh-cdp ${APP}\n`)
  process.exit(2)
}
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('  找不到可用的页面 target（Chrome 起来的时候要带上 ' + APP + '）')
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
await s.send('Log.enable')

/* ★ 把页面里的报错全收下来。
   为什么必须有这一条：曾经有一个 `ReferenceError: drawStroke is not defined`
   活了很久 —— 它只在**鼠标按下的那一刻**才炸，所以
   "模块加载正常、构建正常、工具条按钮都在、状态栏数字也对"，
   唯一的症状是"笔点不动"。这种"某个标识符没定义"的错，
   光看代码、光看构建产物都发现不了。
   这个自检本来就会真的按下去画一笔，所以它撞得上这个错 ——
   加上这一条之后，它会**直接报出是哪一行**，而不是只说"没画出墨"。 */
const pageErrors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    pageErrors.push('异常：' + (d.exception?.description || d.text || '').split('\n').slice(0, 2).join(' | '))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push('console.error：' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 200))
  }
})

await s.send('Page.navigate', { url: APP })
await s.sleep(2800)

console.log('\n[1] 打开就是白板')
{
  const info = await s.eval(`(() => {
    const q = (sel) => document.querySelectorAll(sel).length
    return {
      hasBoard: !!document.querySelector('.bd'),
      boardMode: !!document.querySelector('.app.board-mode'),
      shell: !!document.querySelector('.bd-shell'),
      canvas: q('canvas.bd-ink') + q('canvas.bd-live'),
      svg: q('svg.bd-edges'),
      cards: q('.bd-card'),
      edges: q('.bd-edge'),
      tools: q('.bd-tools .bd-t'),
      proto: !!document.querySelector('.bd-proto'),
      file: (document.querySelector('.bd-file') || {}).textContent || '(空)',
      stageH: (document.querySelector('.bd-stagewrap') || {}).clientHeight || 0,
    }
  })()`)
  if (info.hasBoard) ok('白板挂上了（.bd）')
  else bad('没找到白板（是不是又打开成笔记了）')
  if (info.boardMode && info.shell) ok('两列布局 + 白板容器都在（.app.board-mode / .bd-shell）')
  else bad('布局容器不对：boardMode=' + info.boardMode + ' shell=' + info.shell)
  if (info.stageH > 300) ok(`画布有高度（${info.stageH}px）`)
  else bad(`画布高度只有 ${info.stageH}px —— 容器塌了，白板会看不见`)
  if (info.canvas === 2) ok('两层 canvas 都在（笔迹 + 正在画的那一笔）')
  else bad(`canvas 数量是 ${info.canvas}，期望 2`)
  if (info.svg === 1) ok('连线层在（svg.bd-edges）')
  else bad('没有连线层')
  if (info.cards >= 5) ok(`样板卡片渲染出来了：${info.cards} 张`)
  else bad(`只渲染了 ${info.cards} 张卡片（样板是 5 张）`)
  if (info.edges >= 3) ok(`连线画出来了：${info.edges} 条`)
  else bad(`连线只有 ${info.edges} 条，期望 ≥3（2 包含 + 1 挨着）`)
  if (info.tools >= 8) ok(`工具条按钮 ${info.tools} 个`)
  else bad(`工具条只有 ${info.tools} 个按钮`)
  if (info.proto) ok('摆法切换器在（给你挑完就该删掉的那个）')
  else bad('没有摆法切换器 —— 那三套摆法就挑不了了')
  console.log('      当前文件：' + info.file)
}

console.log('\n[2] 公式卡片真的渲染成了数学')
{
  const texCount = await s.eval(`document.querySelectorAll('.bd-tex .katex').length`)
  if (texCount >= 4) ok(`KaTeX 渲染了 ${texCount} 处`)
  else bad(`只渲染了 ${texCount} 处公式，期望 ≥4`)
  const fracs = await s.eval(`document.querySelectorAll('.bd-tex .katex .mfrac').length`)
  if (fracs >= 1) ok(`分式排出来了（${fracs} 个 \\frac）`)
  else bad('没有分式 —— mu0 I / (2 pi r) 应该是个分式')
}

console.log('\n[3] 画一笔：合成指针事件 → 真的落到数据里')
{
  const before = await s.eval(`document.querySelectorAll('.bd-card').length`)
  const box = await s.eval(`(() => { const r = document.querySelector('.bd-hit').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  // 挑一处空白画：靠左下，避开卡片
  const y0 = box.y + box.h - 170
  const x0 = box.x + 150
  const pts = []
  for (let i = 0; i <= 14; i++) pts.push([x0 + i * 16, y0 + Math.sin(i / 2) * 20])

  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts[0][0], y: pts[0][1], button: 'left', buttons: 1, clickCount: 1 })
  for (const [x, y] of pts.slice(1)) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
  }
  const last = pts[pts.length - 1]
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last[0], y: last[1], button: 'left', buttons: 0, clickCount: 1 })
  await s.sleep(2400) // 等自动存盘（700ms 防抖 + 写盘；给宽一点，不然偶发报「正在存…」）

  const after = await s.eval(`document.querySelectorAll('.bd-card').length`)
  const saveState = await s.eval(`(() => { const e = document.querySelector('.bd-save'); return e ? e.textContent : null })()`)
  if (after === before) ok(`画完之后卡片数没变（${after}），笔画没被误当成卡片`)
  else bad('画一笔居然多了卡片')
  if (saveState === '已存') ok('画的笔已经落盘（状态显示「已存」）')
  else bad(`存盘状态是「${saveState}」，画的笔可能没存上`)

  /* 顺手确认"真的画出来了"：canvas 里必须出现墨点。
     这一条是这次排查的关键 —— 前几版"画完就没了"的 bug 全都表现为
     状态是对的（已存、数据里有坐标），但画布上什么都没有。 */
  const ink = await s.eval(`(() => {
    const scan = (cv) => {
      if (!cv) return -1
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 20) n++
      return n
    }
    const scene = document.querySelector('canvas.bd-ink')
    return {
      scene: scan(scene),
      live: scan(document.querySelector('canvas.bd-live')),
      // 画布自己报的"收到了几笔、几个点、用的什么变换"（见 BoardCanvas.jsx）
      gotStrokes: scene ? scene.dataset.strokes : null,
      gotPts: scene ? scene.dataset.pts : null,
      xform: scene ? scene.dataset.xform : null,
    }
  })()`)
  if (ink.scene > 0) ok(`笔画真的画在画布上了（墨点采样 ${ink.scene}）`)
  else {
    bad(`画布上没有墨点（scene=${ink.scene}, live=${ink.live}）—— 画了但没显示出来`)
    console.log(`      画布自报：收到 ${ink.gotStrokes} 笔 / ${ink.gotPts} 个点，变换 [${ink.xform}]（dpr, tx, ty）`)
  }
}

console.log('\n[4] 落盘的内容是合法的白板文件')
{
  const list = await (await fetch(new URL('/api/list', APP))).json()
  const boardFile = (list.files || []).find((f) => /^board-/i.test(f.name))
  if (boardFile) ok('服务端能看到白板文件：' + boardFile.name)
  else bad('服务端列表里没有 board- 开头的文件')
  if (boardFile) {
    const got = await (await fetch(new URL('/api/file/' + encodeURIComponent(boardFile.name), APP))).json()
    let parsed = null
    try {
      parsed = JSON.parse(got.text)
    } catch {
      bad('白板文件不是合法 JSON（打开会退化成空板）')
    }
    if (parsed) {
      if (Array.isArray(parsed.strokes)) ok(`文件里有 ${parsed.strokes.length} 笔（样板 3 + 刚画的 1）`)
      else bad('文件里没有 strokes 数组')
      const flat = parsed.strokes.every((st) => Array.isArray(st.points) && st.points.every((n) => typeof n === 'number'))
      if (flat) ok('点的坐标全是数字（没有对象混进去 —— 那会让整笔变成 0）')
      else bad('点数组里混进了非数字，序列化会把它全变成 0')
      if (parsed.strokes.some((st) => st.points.length > 6)) ok('刚画的那一笔有坐标，不是空笔')
      else bad('画的笔画是空的（指针事件没被收下）')
    }
  }
}

console.log('\n[5] 双击公式卡 → 能编辑 → 写 dS/dt 就排成分式')
{
  const sent = await s.eval(`(() => {
    const card = document.querySelector('.bd-card.is-formula')
    if (!card) return 'no-card'
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return 'sent'
  })()`)
  if (sent !== 'sent') bad('找不到公式卡')
  await s.sleep(400)
  const editing = await s.eval(`document.querySelectorAll('.bd-card.editing textarea').length`)
  if (editing === 1) ok('双击后出现了输入框')
  else bad(`双击没打开输入框（textarea 数 = ${editing}）`)

  if (editing === 1) {
    await s.eval(`(() => {
      const ta = document.querySelector('.bd-card.editing textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, 'dS/dt')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return 1
    })()`)
    await s.sleep(350)
    const preview = await s.eval(`(() => {
      const p = document.querySelector('.bd-mini-preview')
      return p ? { text: p.textContent, frac: p.querySelectorAll('.mfrac').length } : null
    })()`)
    if (preview && preview.frac >= 1) ok('实时预览里 dS/dt 已经排成了分式')
    else bad('实时预览没排成分式：' + JSON.stringify(preview))

    await s.eval(`(() => {
      const ta = document.querySelector('.bd-card.editing textarea')
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 1
    })()`)
    await s.sleep(400)
    const stillEditing = await s.eval(`!!document.querySelector('.bd-card.editing')`)
    if (!stillEditing) ok('Enter 收工，输入框关掉了')
    else bad('Enter 没关掉输入框')
  }
}

console.log('\n[6] ★ 对齐：墨迹和卡片必须落在同一处')
{
  /* 今天栽了三次的 bug 的哨兵：canvas 的变换和卡片的定位一旦用了不同的原点
     （一个相对画布容器、一个相对页面），卡片就会整体偏移
     "侧栏宽 + 顶上文件名那一行高"那么多 —— 表现是"线和公式卡对不上、内容跑出屏幕"。
     纯逻辑测不出来，它只在真实布局里才发生，所以只能在这里量。 */
  const geo = await s.eval(`(() => {
    const ink = document.querySelector('canvas.bd-ink')
    const wrap = document.querySelector('.bd-stagewrap').getBoundingClientRect()
    const card = document.querySelector('.bd-card')
    const cr = card ? card.getBoundingClientRect() : null
    return {
      inkCss: [ink.clientWidth, ink.clientHeight],
      bitmap: [ink.width, ink.height],
      dpr: window.devicePixelRatio,
      cardRel: cr ? [Math.round(cr.left - wrap.left), Math.round(cr.top - wrap.top)] : null,
      cardStyle: card ? [Math.round(parseFloat(card.style.left)), Math.round(parseFloat(card.style.top))] : null,
    }
  })()`)

  const expectW = Math.round(geo.inkCss[0] * geo.dpr)
  if (Math.abs(geo.bitmap[0] - expectW) <= 2) ok(`canvas 位图和 CSS 尺寸吻合（${geo.bitmap[0]} ≈ ${geo.inkCss[0]}×${geo.dpr}），不会糊`)
  else bad(`canvas 位图 ${geo.bitmap[0]} 与 CSS ${geo.inkCss[0]}×dpr=${expectW} 不符，画面会糊`)

  if (geo.cardRel && geo.cardStyle && Math.abs(geo.cardRel[0] - geo.cardStyle[0]) <= 2 && Math.abs(geo.cardRel[1] - geo.cardStyle[1]) <= 2) {
    ok(`卡片坐标基准一致（style ${JSON.stringify(geo.cardStyle)} ≈ 实测相对容器 ${JSON.stringify(geo.cardRel)}）`)
  } else {
    bad(`卡片基准不一致：style ${JSON.stringify(geo.cardStyle)} vs 实测 ${JSON.stringify(geo.cardRel)} —— 两层坐标又分家了`)
  }

  /* ★ 笔迹必须**画穿一张卡片**才能验对齐。
     第一版是在"左下角随便挑个空白处"画一笔，然后要求墨迹和卡片相交 ——
     这在样板板上碰巧成立（卡片多），在别的板上必然误报
     （明明两层坐标是对的，只是那笔离所有卡片都远）。
     现在改成：先挑一张卡，算它屏幕上的中心，然后横着画一条穿过去的线。
     这样"相交"是**强断言**：坐标轴一旦错位，线立刻不落在卡片上。 */
  const target = await s.eval(`(() => {
    const wrap = document.querySelector('.bd-stagewrap').getBoundingClientRect()
    const cards = [...document.querySelectorAll('.bd-card')]
    const c = cards.find(x => x.classList.contains('is-formula')) || cards[0]
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2), box: [Math.round(r.left - wrap.left), Math.round(r.top - wrap.top), Math.round(r.right - wrap.left), Math.round(r.bottom - wrap.top)], n: cards.length }
  })()`)
  if (!target) {
    bad('一张卡片都没有，没法验对齐')
  } else {
    ok(`准备画穿这张卡：中心在屏幕 (${target.cx},${target.cy})，相对容器 ${JSON.stringify(target.box)}`)
    const y = target.cy
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.cx - 120, y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 24; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.cx - 120 + i * 10, y: y + Math.sin(i / 3) * 6, button: 'left', buttons: 1 })
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.cx + 120, y, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(1200)
  }

  const boxes = await s.eval(`(() => {
    const ink = document.querySelector('canvas.bd-ink')
    const ctx = ink.getContext('2d')
    const d = ctx.getImageData(0, 0, ink.width, ink.height).data
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0
    for (let y = 0; y < ink.height; y += 2) {
      for (let x = 0; x < ink.width; x += 2) {
        if (d[(y * ink.width + x) * 4 + 3] > 20) {
          n++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    const wrap = document.querySelector('.bd-stagewrap').getBoundingClientRect()
    const cards = [...document.querySelectorAll('.bd-card')].map(c => {
      const r = c.getBoundingClientRect()
      return [Math.round(r.left - wrap.left), Math.round(r.top - wrap.top), Math.round(r.right - wrap.left), Math.round(r.bottom - wrap.top)]
    })
    return { n, box: n ? [minX, minY, maxX, maxY] : null, cards }
  })()`)

  /* ★ 强断言：我们**故意画穿了那卡片**，所以卡片自己的矩形里必须有墨。
     只判"和随便哪张卡相交"是不够的 —— 卡片多的时候它几乎总是成立，
     等于没测（第一版就是这样，在样板板上碰巧过、在别的板上误报）。 */
  if (boxes.n > 0) ok(`画布上确实有墨迹（采样到 ${boxes.n} 个墨点）`)
  else bad('画布上一个墨点都没有 —— 笔迹没画出来（或者被清掉了）')

  if (target && boxes.n > 0) {
    const k = geo.inkCss[0] / geo.bitmap[0] // canvas 像素 → CSS 像素
    const insideBox = await s.eval(`(() => {
      const ink = document.querySelector('canvas.bd-ink')
      const d = ink.getContext('2d').getImageData(0, 0, ink.width, ink.height).data
      const k = ${k}
      const b = ${JSON.stringify(target.box)} // 相对容器的 CSS 像素
      const x0 = Math.max(0, Math.floor(b[0] / k)), x1 = Math.min(ink.width - 1, Math.ceil(b[2] / k))
      const y0 = Math.max(0, Math.floor(b[1] / k)), y1 = Math.min(ink.height - 1, Math.ceil(b[3] / k))
      let n = 0
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (d[(y * ink.width + x) * 4 + 3] > 20) n++
      return n
    })()`)
    if (insideBox > 0) ok(`画穿卡片的那条线，墨落在卡片矩形里（${insideBox} 个墨点）—— 两层坐标是同一套`)
    else {
      bad('画穿卡片的那条线，卡片范围内一个墨点都没有 —— 两层坐标分家了')
      console.log(`      卡片相对容器 ${JSON.stringify(target.box)}，墨迹相对容器 ${JSON.stringify((boxes.box || []).map((v) => Math.round(v * k)))}`)
    }
  }

  /* 上面那条是"画穿卡片 ⇒ 卡片范围内有墨"的强断言。
     这里留一条**弱**的兜底：万一没有卡片可挑（空板），至少确认墨迹存在。
     （不再要求"和某张卡相交"——那个判据太松，等于没测。） */
  if (!target && boxes.n === 0) bad('既没卡片也没墨迹，这一节什么都没验到')
}

console.log('\n[7] 截图（自己也看一眼）')
{
  const shot = await s.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync('.cache', { recursive: true })
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  ok(`截图存到 ${SHOT}（${Math.round(fs.statSync(SHOT).size / 1024)} KB）`)
}

console.log('\n[8] 三种摆法都能切（点切换器按钮，走的是真路径）')
{
  for (const v of ['A', 'B', 'C']) {
    // 点"下一个"直到到位 —— 比直接改 URL 更接近用户真会做的事
    for (let i = 0; i < 4; i++) {
      const cls = await s.eval(`document.querySelector('.bd').className`)
      if (cls.includes('variant-' + v)) break
      await s.eval(`(() => { const b = document.querySelectorAll('.bd-proto button')[1]; if (b) b.click(); return 1 })()`)
      await s.sleep(330)
    }
    const state = await s.eval(`(() => ({
      cls: document.querySelector('.bd').className,
      url: location.search,
      canvas: document.querySelectorAll('canvas').length,
      hit: !!document.querySelector('.bd-hit'),
      tools: document.querySelectorAll('.bd-tools').length,
      stageH: (document.querySelector('.bd-stagewrap') || {}).clientHeight || 0,
    }))()`)
    if (state.cls.includes('variant-' + v)) ok(`摆法 ${v} 切过去了（url「${state.url}」）`)
    else bad(`切到 ${v} 失败，现在的 class 是「${state.cls}」`)
    if (state.canvas === 2 && state.hit && state.tools === 1 && state.stageH > 300) {
      ok(`摆法 ${v} 下画布 / 收事件层 / 工具条都在（画布高 ${state.stageH}px）`)
    } else {
      bad(`摆法 ${v} 下白板缺件：${JSON.stringify(state)}`)
    }
  }
  // 切完摆法还能不能画 —— 这是最容易"切一下就画不出来"的地方
  const box = await s.eval(`(() => { const r = document.querySelector('.bd-hit').getBoundingClientRect(); return { x: r.left + 120, y: r.top + 140 } })()`)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 6; i++) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 12, y: box.y - i * 8, button: 'left', buttons: 1 })
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 72, y: box.y - 48, button: 'left', buttons: 0, clickCount: 1 })
  // 存盘是 700ms 防抖 + 写盘；等待给宽一点，否则偶发卡在边界上报「正在存…」
  await s.sleep(2400)
  const saved = await s.eval(`(() => { const e = document.querySelector('.bd-save'); return e ? e.textContent : null })()`)
  if (saved === '已存') ok('切过摆法之后照样能画、能存')
  else bad(`切过摆法之后画不出来了（状态「${saved}」）`)
}

console.log('\n[9] ★ 页面上不许有报错')
{
  /* 这一节是"笔点不动"那个 bug 的哨兵。
     那种 bug 的症状是"某个标识符没定义"，而且只在某个交互被触发时才炸 ——
     前面几节都在真的交互（画、双击、切摆法），所以错误都会被这里收上来。 */
  const real = pageErrors.filter((e) => !/favicon|Failed to load resource/i.test(e))
  if (!real.length) ok('整个流程跑下来，页面里没有任何 JS 报错')
  else {
    bad(`页面里有 ${real.length} 条报错：`)
    for (const e of real.slice(0, 6)) console.log('      ' + e)
    console.log('      ← 这种错往往就是"某个按钮点了没反应 / 笔点不动"的真正原因')
  }
}

console.log('\n' + '─'.repeat(56))
console.log(fails ? `  ${fails} 项失败` : '  全部通过')
ws.close()
process.exit(fails ? 1 : 0)
