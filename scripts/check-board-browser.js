/* 白板在**真浏览器**里的自检：用 CDP 连上系统浏览器（Edge，见 lib/browser.js），检查
 *  ① 打开就是白板（不是笔记），画布/卡片/连线都真的挂上了
 *  ② 公式卡片渲染成了数学（KaTeX）
 *  ③ 画一笔：合成指针事件 → 笔迹进数据 → 存盘请求发出去了
 *  ④ 落盘的是合法的白板文件（点的坐标必须全是数字）
 *  ⑤ 双击公式卡能编辑，写 dS/dt 就排成分式
 *  ⑥ ★ 墨迹和卡片对齐（这一条只有真浏览器能测，今天栽了三次）
 *  ⑦ 截图，自己也看一眼
 *  ⑧ 白板**只有一种布局**（画布占满 + 贴底工具条），而且照样画得出来、存得下去
 *
 * 为什么非要在真浏览器里跑：jsdom 没有真实尺寸、没有 canvas、没有指针事件 ——
 * 白板恰恰全靠这三样。单元测试（check-board.js）能保证"算得对"，
 * 只有这里能保证"真的画得出来、而且画在对的地方"。
 *
 * ★ 2026-09-16 起它**自足**了：自己起服务（5205）+ headless Edge（9235），
 *   夹具板从 ?file= 直接打开。从前它要求"5177 上已经有个 app 在跑、9223 上有个
 *   浏览器开着"（package.json 里那串 `cdp-open.js 9223 && timeout 5`），
 *   那是条没写出来的前提 —— 连错页面/连到旧进程时报的是"没找到白板"这种假错。
 *   胶水统一在 scripts/lib/board-check.js 的 withBoard 里。
 */
import fs from 'node:fs'
import { withBoard } from './lib/board-check.js'
import { buildSeedBoard } from '../src/seed-board.js'
import { serializeBoardDocument, newBoard, newCard } from '../src/lib/board.js'
/* 视图映射只有一份实现（src/lib/view.js）：自检和 app 走同一个 module ——
   这样"卡片 CSS 位置"和"canvas 变换"这两条路才算被同一个公式钉住。 */
import { worldToScreen } from '../src/lib/view.js'

const SHOT = process.env.SHOT_PATH || '.cache/board-shot.png'

/* ── 自检夹具：自己造一个白板文件，跑完删掉 ──────────────────────────────
   它中途会**真的画一笔、双击卡片改成 dS/dt** —— 也就是说它会改动自己打开的那个板。
   以前它指向 data/ 里一个手工留下的 board-test.md，两头都错（文件不在 → 整条跑不了；
   文件在 → 每跑一次就被改一次，卡片从 5 张掉到 3 张）。
   现在夹具由 withBoard 造、应用从 ?file= 直接开它，用户的板一个字节都不会被读。 */
const fails1 = await withBoard(
  {
    tag: 'check',
    port: 5205,
    cdpPort: 9235,
    make: () => {
      const seed = buildSeedBoard()
      seed.title = '自检夹具（跑完自动删除）'
      return serializeBoardDocument(seed)
    },
  },
  async ({ s, ok, bad, board, open, read, appUrl }) => {
/* ── 下面整段原来是顶层代码，挪进 withBoard 的回调里；缩进没动（少几百行假 diff）── */

const sleep = (ms) => s.sleep(ms)

/* 打开夹具板：应用从 ?file= 直接开（open 自己会导航 + 等它挂上）。 */
await open()

/* 在画布区里找一段**真的空白**（`.bd-hit` 命中的地方）。
 *
 * 为什么需要它：卡片是 DOM、会收指针事件（这是设计：**卡片能选中、空白能画**），
 * 所以"随便挑个坐标画一笔"这种写法是错的 —— 落点正好在一张卡上时，
 * 那一下是**拖卡片**，不是画线，于是后面所有"墨迹呢？"的断言一起红灯，
 * 报出来还像是白板坏了（2026-09-15 卡片层修好之后立刻撞上这一条）。
 *
 * 判据用 elementFromPoint，也就是**浏览器自己的命中测试** ——
 * 和用户手指按下去看到的是同一个答案，不靠猜坐标有没有踩到卡片。 */
async function findEmptyRun({ need = 200, rows = 7 } = {}) {
  const box = await s.eval(`(() => { const r = document.querySelector('.bd-hit').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  for (let k = 1; k <= rows; k++) {
    const y = Math.round(box.y + (box.h * k) / (rows + 1))
    const run = await s.eval(`(() => {
      const hit = document.querySelector('.bd-hit')
      const y = ${y}, x0 = ${Math.round(box.x + 6)}, x1 = ${Math.round(box.x + box.w - 6)}
      let cur = 0, best = null
      for (let x = x0; x <= x1; x += 6) {
        if (document.elementFromPoint(x, y) === hit) {
          cur += 6
          if (!best || cur > best.run) best = { run: cur, end: x }
        } else cur = 0
      }
      return best && best.run >= ${need} ? { y, x0: best.end - best.run + 6, x1: best.end, run: best.run } : null
    })()`)
    if (run) return run
  }
  return null
}

/* 在 y 这一行上找第一个**空白**的 x（卡片会收指针事件，画在卡片上就是拖卡片）。
   从 from 往 to 扫。找不到返回 null。 */
async function emptyXOnRow(y, from, to) {
  const step = to >= from ? 8 : -8
  return s.eval(`(() => {
    const hit = document.querySelector('.bd-hit')
    const y = ${Math.round(y)}
    for (let x = ${Math.round(from)}; ${step > 0 ? `x <= ${Math.round(to)}` : `x >= ${Math.round(to)}`}; x += ${step}) {
      if (document.elementFromPoint(x, y) === hit) return x
    }
    return null
  })()`)
}


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
      /* ★ 2026-09-19：右侧那块关系面板（.bd-cpanel）和三套摆法切换器（.bd-proto*）
         整块删掉了 —— 白板只剩一种样子。这里**反过来钉**：它们一个都不许再出现。
         （删掉一块压在画布上的浮层之后，最容易的失误就是某个角落还留着一份，
         而它照样点得到、照样挡住画布 —— 那正是当年 check-link [10] 抓过的病。） */
      panel: q('.bd-cpanel') + q('.bd-rel') + q('.bd-drawer') + q('.bd-clist') + q('.bd-csplit'),
      proto: q('.bd-proto') + q('.bd-proto-mini'),
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
  if (info.panel === 0) ok('右侧那块关系面板真的不在了（.bd-cpanel / .bd-rel / .bd-drawer / .bd-clist / .bd-csplit 一个都没有）')
  else bad(`画布上还压着 ${info.panel} 个关系面板的容器 —— 它删不干净，而它照样挡画布`)
  if (info.proto === 0) ok('摆法切换器也没了（A/B/C 三套跟着面板一起删）')
  else bad(`摆法切换器还在（${info.proto} 个）—— 面板没了，它已经切不动任何东西`)
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
  /* 挑一处**真的空白**画（见 findEmptyRun：卡片会收指针事件，落在卡上就是拖卡片） */
  const empty = await findEmptyRun({ need: 220 })
  if (!empty) {
    bad('画布区里找不到一段空白 —— 卡片把整块画布铺满了，后面画不了')
  } else {
    console.log(`      空白段：y=${empty.y}，x ${empty.x0}→${empty.x1}（${empty.run}px）`)
  }
  const y0 = empty ? empty.y : 0
  const x0 = empty ? empty.x0 + 20 : 0
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
  const list = await (await fetch(new URL('/api/list', appUrl))).json()
  /* ★ 读**页面上正开着的那个**文件，而不是"列表里第一个 board-*"。
     这两个不是一回事：data/ 里一张板都没有时，应用打开会自己补一张 board-新白板.md
     （App.jsx 的 ensureBoard），而它按字典序排在夹具前面 —— 于是这里会去读那张空板，
     报出「画的笔画是空的（指针事件没被收下）」，把人往白板代码上带（其实画得好好的）。 */
  const openName = (await s.eval(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)) || board.name
  const boardFile = (list.files || []).find((f) => f.name === openName)
  if (boardFile) ok('服务端能看到白板文件：' + boardFile.name)
  else bad('服务端列表里找不到正在看的 ' + openName + '（看到的板不在 data/ 里？）')
  if (boardFile) {
    const got = await (await fetch(new URL('/api/file/' + encodeURIComponent(boardFile.name), appUrl))).json()
    let parsed = null
    try {
      parsed = JSON.parse(got.text)
    } catch {
      bad('白板文件不是合法 JSON（打开会退化成空板）')
    }
    if (parsed) {
      if (Array.isArray(parsed.strokes)) ok(`文件里有 ${parsed.strokes.length} 笔（样板 4 + 刚画的 1）`)
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
  /* ★★ 用**真鼠标事件**双击，不要 `card.dispatchEvent(new MouseEvent('dblclick'))`。
     为什么（2026-09-15 用户报的「点不了，给我识别成写字了，在弹窗上乱涂乱画」）：
     合成事件是**直接投给卡片这个元素**的，它绕过浏览器的命中测试 ——
     于是"卡片被 .bd-hit（收事件层）整个盖住、按下去只会画墨"这种 bug
     能在这条自检里一路绿灯：双击进去了、输入框也在、断言全过，
     而用户那边一个字都点不进去。假绿灯比没有测试更糟。
     现在走 Input.dispatchMouseEvent：浏览器是真的在这一点上找最上面的元素，
     谁盖住了谁就现原形。同理，先看一眼 elementFromPoint 的答案。 */
  const cardPoint = await s.eval(`(() => {
    const card = document.querySelector('.bd-card.is-formula')
    if (!card) return null
    const r = card.getBoundingClientRect()
    const cx = Math.round((r.left + r.right) / 2)
    const cy = Math.round((r.top + r.bottom) / 2)
    const el = document.elementFromPoint(cx, cy)
    return {
      cx, cy,
      inside: !!(el && card.contains(el)),
      hit: el ? el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') : 'null',
    }
  })()`)
  if (!cardPoint) {
    bad('找不到公式卡')
  } else {
    if (cardPoint.inside) ok(`卡片中心那一点命中的就是卡片自己（${cardPoint.hit}）`)
    else bad(`卡片中心那一点命中的是 ${cardPoint.hit} —— 卡片被谁盖住了，用户点不到它`)
  }

  const inkBefore = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
  if (cardPoint) {
    for (const clickCount of [1, 2]) {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cardPoint.cx, y: cardPoint.cy, button: 'left', buttons: 1, clickCount })
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cardPoint.cx, y: cardPoint.cy, button: 'left', buttons: 0, clickCount })
    }
    await s.sleep(500)
    const inkAfter = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
    if (inkAfter === inkBefore) ok(`在卡片上点两下没落墨（还是 ${inkAfter} 笔）—— 卡片收得到事件`)
    else bad(`在卡片上点一下就在板上画了一笔（${inkBefore} → ${inkAfter}）—— 这一下被当成写字了`)
  }
  await s.sleep(300)
  const editing = await s.eval(`document.querySelectorAll('.bd-card.editing textarea').length`)
  if (editing === 1) ok('双击后出现了输入框')
  else bad(`双击没打开输入框（textarea 数 = ${editing}）`)
  /* 光"输入框在"不等于"点得进去"：光标必须真的落在它身上。
     上面那条合成事件的写法正是漏了这一层 —— 它在，但永远点不到。 */
  const focused = await s.eval(`(() => { const ta = document.querySelector('.bd-card.editing textarea'); return !!ta && document.activeElement === ta })()`)
  if (focused) ok('光标真的进到输入框里了（document.activeElement 就是它）')
  else bad('输入框在，但光标进不去 —— 用户打字也没用')

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
  /* ── ★ 数值版："两层坐标是同一套" ──
     2026-09-16 把视图映射收进 `src/lib/view.js` 时补的哨兵：
     canvas 记下的 `dataset.xform` 就是 app **真写进去**的那三个数（applyViewTo 返回的），
     拿它反推出视图，再用**同一个 module** 算一张卡该在屏幕的哪里，
     和它的 CSS left/top 比 —— 差超过 1px 就说明有人又手抄了一份映射
     （收口之前这句话被手抄了 14 处、canvas 变换写了两份、捏合还复制了一份）。
     为什么用 canvas 的 dataset 反推视图：视图本身没有别的 DOM 出口，
     而这三个数不是另算的，是 module 的返回值。 */
  const readAlign = () => s.eval(`(() => {
    const ink = document.querySelector('canvas.bd-ink')
    const card = document.querySelector('.bd-card')
    if (!ink || !card) return null
    return {
      xform: ink.dataset.xform,
      dpr: window.devicePixelRatio,
      id: card.dataset.cardId,
      left: parseFloat(card.style.left),
      top: parseFloat(card.style.top),
      /* ★ 2026-09-21：还要读**浏览器真正把它摆在哪**（相对舞台）。
         卡片那两行现在是世界坐标，屏幕位置在 .bd-cardworld 那一层 ——
         "module 算的 == 卡片 style.left"那条老判据在世界坐标下必然对不上。
         ⚠ 这段是**模板字符串里面**（外层是反引号）：注释里一个反引号都不能有，
           有就把模板字符串提前截断，报出来是"某个变量没定义"（我这次又踩了一次）。 */
      rel: (() => {
        const r = card.getBoundingClientRect()
        const s = document.querySelector('.bd-stagewrap').getBoundingClientRect()
        return { x: r.left - s.left, y: r.top - s.top }
      })(),
    }
  })()`)
  const checkAlign = async (tag) => {
    const a = await readAlign()
    if (!a || !a.xform) {
      bad(`${tag}：读不到 canvas 的 dataset.xform / 卡片`)
      return
    }
    const [xs, xtx, xty] = String(a.xform).split(',').map(Number)
    const view = { s: xs / a.dpr, tx: xtx / a.dpr, ty: xty / a.dpr }
    const doc = await read()
    const card = (doc.cards || []).find((c) => c.id === a.id)
    if (!card) {
      bad(`${tag}：DOM 里那张卡 ${a.id} 不在夹具文件里`)
      return
    }
    /* ★★ 判据（2026-09-21 第十一刀换过一次，原因值得记）：
       老判据比的是"module 算出的屏幕点" vs "卡片 style.left/top" —— 成立的前提是
       "卡片自己按屏幕坐标摆"（第九刀之前就是这样）。第九刀把卡片改成世界坐标渲染
       （`width/left` 都是世界像素，缩放交给 `.bd-cardworld` 那一层的 transform）之后，
       `style.left` 就是世界坐标，这个比较**必然对不上**（实测 177 vs 60）——
       而它红了没人看，正是那个性能回归溜过去的原因之一（README 第 58 条）。
       新判据把同一件事问得更直：**两层坐标不许分家**，那就分两半各自钉住 ——
         · 卡片自己那两行必须是**世界坐标**（一个 s 都不许乘进去）；
         · 浏览器**真正摆出来的屏幕位置**必须等于 module 算出的那个点
           （view 来自 canvas 的 `data-xform`，是墨迹那条独立的路）。
       两边都成立 ⇔ 只有一份映射，而且它和浏览器实际布局一致。 */
    const dWorld = Math.max(Math.abs(a.left - card.x), Math.abs(a.top - card.y))
    if (dWorld <= 1) {
      ok(`${tag}：卡片自己那两行是世界坐标（left/top ${a.left}/${a.top} ≈ 文件里的 ${card.x}/${card.y}）`)
    } else {
      bad(`${tag}：卡片自己那两行不是世界坐标（${a.left}/${a.top} vs 文件里的 ${card.x}/${card.y}）—— 有人把"世界 → 屏幕"抄了一份到卡片身上`)
    }
    const want = worldToScreen({ x: card.x, y: card.y }, view)
    const dx = Math.abs(want.x - a.rel.x)
    const dy = Math.abs(want.y - a.rel.y)
    if (dx <= 1.5 && dy <= 1.5) {
      ok(`${tag}：module 算出的屏幕点 = 浏览器实际摆出来的位置（Δ ${dx.toFixed(2)} / ${dy.toFixed(2)} px，视图 s=${view.s.toFixed(3)} tx=${view.tx.toFixed(1)}）`)
    } else {
      bad(`${tag}：module 算 ${JSON.stringify({ x: +want.x.toFixed(2), y: +want.y.toFixed(2) })} vs 浏览器实测 ${JSON.stringify({ x: +a.rel.x.toFixed(2), y: +a.rel.y.toFixed(2) })} —— 两层坐标分家了`)
    }
    return view
  }
  await checkAlign('刚打开')
  /* 换一个视图再验一次 —— 确保结论不只在某一个缩放下成立。
     ⚠ 工具条上 `A−`/`A+` 是**界面字号**，画布缩放是「纸」那一组（标题写着"画布缩小"）。
       按标题找，别按字符猜（第一次写成了 A−，视图根本没变，等于没验）。 */
  {
    const zoomed = await s.eval(`(() => {
      const b = [...document.querySelectorAll('.bd-tools .bd-t')].find((x) => /画布缩小/.test(x.title || ''))
      if (!b) return false
      b.click()
      return true
    })()`)
    if (zoomed) {
      await s.sleep(250)
      const v0 = await checkAlign('画布缩小一档之后')
      if (v0 && Math.abs(v0.s - 1) > 0.001) ok(`视图真的换了（s=${v0.s.toFixed(3)}）`)
      else bad('点了"画布缩小"但视图没变 —— 这一条等于没验')
    } else {
      bad('找不到工具条上的"画布缩小"按钮（按标题找的）')
    }
  }

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

  /* ★ 2026-09-21（第十一刀）：老判据是"卡片 style.left/top ≈ 实测相对容器" ——
     那是**屏幕坐标时代**的算法（那时卡片的 left 就是屏幕位置）。第九刀之后卡片的
     left/top 是**世界坐标**，实测位置是"世界 × `.bd-cardworld` 的 transform"，
     两者只在 s=1 且 tx=ty=0 时相等 —— 于是它必然红，而它红了没人看，
     正是那个性能回归溜过去的原因之一（README 第 58 条）。
     新的判据是**每一张卡都不许分家**，而且分两半各自钉住（比老判据更强：
     老判据只在第一张卡上量，且把两个坐标系混在一个等式里）：
       · 卡片自己那两行必须是世界坐标（等于夹具文件里的 x/y）；
       · 世界 → 屏幕那一份**只许有一处**：屏幕位置 = 世界 × 卡片容器那条 transform。 */
  const coord = await s.eval(`(() => {
    const cw = document.querySelector('.bd-cardworld')
    const m = /translate\\(\\s*([-\\d.eE]+)px[,\\s]+([-\\d.eE]+)px\\s*\\)\\s*scale\\(\\s*([-\\d.eE]+)\\s*\\)/.exec(cw ? cw.style.transform || '' : '')
    if (!m) return { err: '读不出 .bd-cardworld 的 transform：' + JSON.stringify(cw ? cw.style.transform : null) }
    const s = parseFloat(m[3]), tx = parseFloat(m[1]), ty = parseFloat(m[2])
    const wrap = document.querySelector('.bd-stagewrap').getBoundingClientRect()
    return {
      s, tx, ty,
      cards: [...document.querySelectorAll('.bd-card')].map((c) => {
        const r = c.getBoundingClientRect()
        const wx = parseFloat(c.style.left), wy = parseFloat(c.style.top)
        return {
          worldX: wx, worldY: wy,
          dx: r.left - (wrap.left + wx * s + tx),
          dy: r.top - (wrap.top + wy * s + ty),
        }
      }),
    }
  })()`)
  if (coord.err) {
    bad('卡片坐标基准量不了：' + coord.err)
  } else {
    const docAll = (await read()).cards || []
    const offWorld = coord.cards.filter((c) => {
      const d = docAll.find((x) => Math.abs(x.x - c.worldX) < 0.5 && Math.abs(x.y - c.worldY) < 0.5)
      return !d
    })
    if (!offWorld.length) {
      ok(`每一张卡自己那两行都是世界坐标（${coord.cards.length} 张，逐张和夹具文件里的 x/y 对上）`)
    } else {
      bad(`有 ${offWorld.length} 张卡自己那两行不是世界坐标：${JSON.stringify(offWorld.slice(0, 3))} —— 有人把"世界 → 屏幕"抄了一份到卡片身上`)
    }
    const offScreen = coord.cards.filter((c) => Math.abs(c.dx) > 1.5 || Math.abs(c.dy) > 1.5)
    if (!offScreen.length) {
      ok(`世界 → 屏幕只有一处：每张卡的实测位置 = 世界 × 卡片容器那条 transform（s=${coord.s.toFixed(3)} tx=${coord.tx.toFixed(1)}，${coord.cards.length} 张）`)
    } else {
      bad(`卡片实测位置和"世界 × 卡片容器 transform"对不上：${JSON.stringify(offScreen.slice(0, 3))} —— 两层坐标又分家了`)
    }
  }

  /* ★ 笔迹必须**画穿一张卡片**才能验对齐。
     第一版是在"左下角随便挑个空白处"画一笔，然后要求墨迹和卡片相交 ——
     这在样板板上碰巧成立（卡片多），在别的板上必然误报
     （明明两层坐标是对的，只是那笔离所有卡片都远）。
     现在改成：先挑一张卡，算它屏幕上的中心，然后横着画一条穿过去的线。
     这样"相交"是**强断言**：坐标轴一旦错位，线立刻不落在卡片上。

     ★ 起点必须是**空白**：卡片会收指针事件（设计如此：卡片能选中、空白能画），
       在卡片上按下那一下是拖卡片，一笔都不会落。所以起点在卡片左边沿往左找
       第一个 `.bd-hit` 命中的位置 —— 一旦按在空白上，指针捕获就归收事件层，
       后面横穿卡片那一段照样交给它（这正是"能画穿卡片"的实现方式）。 */
  const target = await s.eval(`(() => {
    const wrap = document.querySelector('.bd-stagewrap').getBoundingClientRect()
    const cards = [...document.querySelectorAll('.bd-card')]
    const c = cards.find(x => x.classList.contains('is-formula')) || cards[0]
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2), left: Math.round(r.left), box: [Math.round(r.left - wrap.left), Math.round(r.top - wrap.top), Math.round(r.right - wrap.left), Math.round(r.bottom - wrap.top)], n: cards.length }
  })()`)
  if (!target) {
    bad('一张卡片都没有，没法验对齐')
  } else {
    ok(`准备画穿这张卡：中心在屏幕 (${target.cx},${target.cy})，相对容器 ${JSON.stringify(target.box)}`)
    const y = target.cy
    const startX = await emptyXOnRow(y, target.left - 20, target.left - 260)
    if (startX == null) {
      bad(`这条 y=${y} 上卡片左边 260px 内找不到空白落笔点 —— 画不穿这张卡，这一节验不了`)
    } else {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y, button: 'left', buttons: 1, clickCount: 1 })
      for (let i = 1; i <= 24; i++) {
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + i * 10, y: y + Math.sin(i / 3) * 6, button: 'left', buttons: 1 })
      }
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 240, y, button: 'left', buttons: 0, clickCount: 1 })
      await s.sleep(1200)
    }
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

console.log('\n[8] 白板只剩一种布局：画布占满容器 + 工具条贴底，而且照样画得出来、存得下去')
{
  /* 2026-09-19 用户：「白板页面我觉得不需要右侧关系栏，可以删掉了」。
     面板删掉之后 A/B/C 三套摆法也就没有意义了（它们存在的唯一理由就是给面板找地方：
     右栏 / 抽屉 / 左列），于是 `?variant=` 和左右方向键一起收走。
     ★ 这一节因此改成钉两件事：
       · 「删干净了」的判据**不只是面板不在**（[1] 已经钉过）—— 当年那三套摆法是靠
         给 `.bd-stagewrap` 加 `margin-left` / 把工具条右移来让位的，**那些让位必须一起回来**，
         否则画布会莫名其妙窄 300px 而没有人抱怨（[1] 查不出这种事）。
         所以这里比的是**画布宽度 ≈ 容器宽度**。
       · 布局变了之后照样能画、能存（最容易坏的就是这个）。 */
  const layout = await s.eval(`(() => {
    const shell = document.querySelector('.bd-shell')
    const stage = document.querySelector('.bd-stagewrap')
    return {
      cls: document.querySelector('.bd').className,
      url: location.search,
      shellW: shell ? Math.round(shell.getBoundingClientRect().width) : 0,
      stageW: stage ? Math.round(stage.getBoundingClientRect().width) : 0,
      stageH: stage ? stage.clientHeight : 0,
      bar: !!document.querySelector('.bd-cbar'),
      canvas: document.querySelectorAll('canvas').length,
      hit: !!document.querySelector('.bd-hit'),
      tools: document.querySelectorAll('.bd-tools').length,
    }
  })()`)
  if (!/variant-/.test(layout.cls)) ok(`白板根节点上没有 variant- 了（「${layout.cls}」）`)
  else bad(`还有 variant- 的类：${layout.cls}`)
  if (!/variant=/.test(layout.url)) ok(`地址栏里也没有 ?variant= 了（「${layout.url || '(空)'}」）`)
  else bad(`地址栏还挂着 variant —— 那条路已经不存在了：${layout.url}`)
  if (layout.stageH > 300) ok(`画布有高度（${layout.stageH}px）`)
  else bad(`画布高度只有 ${layout.stageH}px —— 容器塌了`)
  if (layout.stageW >= layout.shellW - 2) {
    ok(`画布占满了容器（画布 ${layout.stageW}px / 容器 ${layout.shellW}px）—— 没有哪一段还让给面栏`)
  } else {
    bad(`画布只有 ${layout.stageW}px，容器有 ${layout.shellW}px —— 右边/左边还空着一段（摆法那套让位没清干净？）`)
  }
  if (layout.canvas === 2 && layout.hit && layout.tools === 1 && layout.bar) {
    ok('画布 / 收事件层 / 工具条都在')
  } else {
    bad(`白板缺件：${JSON.stringify(layout)}`)
  }

  // 改了布局之后还能不能画 —— 这是最容易"动一下就画不出来"的地方
  const empty2 = await findEmptyRun({ need: 140 })
  if (!empty2) {
    bad('画布区里找不到空白处可以画')
  } else {
    const point = { x: empty2.x0 + 20, y: empty2.y }
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 6; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + i * 12, y: point.y - i * 8, button: 'left', buttons: 1 })
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 72, y: point.y - 48, button: 'left', buttons: 0, clickCount: 1 })
  }
  // 存盘是 700ms 防抖 + 写盘；等待给宽一点，否则偶发卡在边界上报「正在存…」
  await s.sleep(2400)
  const saved = await s.eval(`(() => { const e = document.querySelector('.bd-save'); return e ? e.textContent : null })()`)
  if (saved === '已存') ok('画完之后照样能存')
  else bad(`画完之后存不下去（状态「${saved}」）`)
}

console.log('\n[9] ★ 页面上不许有报错')
{
  /* 这一节是"笔点不动"那个 bug 的哨兵。
     那种 bug 的症状是"某个标识符没定义"，而且只在某个交互被触发时才炸 ——
     前面几节都在真的交互（画、双击、切摆法），所以错误都会被这里收上来。 */
  const real = s.errors().filter((e) => !/favicon|Failed to load resource/i.test(e))
  if (!real.length) ok('整个流程跑下来，页面里没有任何 JS 报错')
  else {
    bad(`页面里有 ${real.length} 条报错：`)
    for (const e of real.slice(0, 6)) console.log('      ' + e)
    console.log('      ← 这种错往往就是"某个按钮点了没反应 / 笔点不动"的真正原因')
  }
}
})

/* ── 补交互死角①：板框标题被卡片压住也要点得到 ──────────────────────────────
   关系面板 2026-09-19 删掉之后，板框标题（.bd-frame-t）是选中/拖动/改名的**唯一把手**。
   但标题画在卡片下面（DOM 顺序：框先于卡片），一张卡压在标题条上就把它整个盖住 →
   这个框永久选不中、拖不动、改不了名。styles.css 里给 .bd-frame-t / .bd-frame-in
   加了 z-index:7（> 卡片的 auto），只抬这一颗、框线仍在卡片下面。
   这条自检造“一张卡压住标题”的场景，用 elementFromPoint + 真鼠标验证标题仍可点、点它真选中框。 */
const fails2 = await withBoard(
  {
    tag: 'frame-cover',
    port: 5207,
    cdpPort: 9237,
    make: () => {
      const b = newBoard('自检夹具：板框标题被卡片压住')
      /* A 是框的成员（决定框的位置）；B 故意压在框的左上角、盖住标题条，
         但不进框（不撑大框）。B 的覆盖区要大到容纳标题（标题在框顶边上方约 23px 屏幕处）。 */
      const A = newCard('formula', 400, 400, { w: 240, h: 100 })
      A.id = 'covA'; A.src = 'B = mu0 I / (2 pi r)'; A.tex = 'B = \\frac{\\mu_{0} I}{2 \\pi r}'
      const B = newCard('note', 300, 250, { w: 380, h: 200 })
      B.id = 'covB'; B.text = '这张卡故意压在板框标题上，用来复现「标题点不到」的死角'
      b.cards = [A, B]
      b.frames = [{ id: 'fcover', title: '这一节被压住', cards: ['covA'] }]
      b.view = { s: 1, tx: 0, ty: 0 }
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, open }) => {
    console.log('\n[frame-cover] 板框标题被卡片压住也要点得到')
    await open()
    const probe = await s.eval(`(() => {
      const t = document.querySelector('.bd-frame-t')
      if (!t) return { ok: false, why: 'no .bd-frame-t（框没渲染出标题把手）' }
      const r = t.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
      const cards = Array.prototype.slice.call(document.querySelectorAll('.bd-card'))
      const cover = cards.find(function (c) {
        const b = c.getBoundingClientRect()
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom
      })
      const top = document.elementFromPoint(cx, cy)
      const cls = top ? (typeof top.className === 'string' ? top.className : (top.className && top.className.baseVal) || '') : ''
      return {
        ok: true, cx: cx, cy: cy,
        coveredByCard: !!cover,
        topClass: cls,
        topIsTitle: !!(top && top.classList && top.classList.contains('bd-frame-t')),
      }
    })()`)
    if (!probe.ok) {
      bad('找不到板框标题把手（' + (probe.why || '') + '）')
    } else {
      if (probe.coveredByCard) ok('复现了「卡片压住标题」的场景（标题落在某张卡片的包围盒里）')
      else bad('夹具没造出"卡片压住标题"—— 死角条件没复现，这条断言没有意义')
      if (probe.topIsTitle) ok('标题被压住时仍是顶层元素（elementFromPoint 命中 .bd-frame-t，没被卡片抢走）')
      else bad('标题被卡片压住了：elementFromPoint 命中的是「' + probe.topClass + '」而不是 .bd-frame-t —— 框选不中 / 拖不动 / 改不了名')
      /* 真鼠标点一下标题：验证“点它真的选中框”，而不是穿透到下面的卡片。 */
      await s.mouse(probe.cx, probe.cy)
      await s.sleep(160)
      const sel = await s.eval(`(() => { const f = document.querySelector('.bd-frame.on'); return f ? (f.getAttribute('data-frame-id') || '') : '' })()`)
      if (sel) ok('真鼠标点标题 → 框被选中（.bd-frame.on，data-frame-id=' + sel + '）')
      else bad('真鼠标点标题没选中框（可能穿透到了卡片）')
    }
  },
)

const fails3 = await withBoard(
  {
    tag: 'link-cond',
    port: 5208,
    cdpPort: 9238,
    make: () => {
      const b = newBoard('自检夹具：连接线条件口子')
      const A = newCard('note', 200, 200, { w: 200, h: 100 })
      A.id = 'kA'; A.text = '甲'
      const B = newCard('note', 600, 400, { w: 200, h: 100 })
      B.id = 'kB'; B.text = '乙'
      /* 连接线必须用「带端点的那一笔」来表示（应用里唯一的表示法）：
         stroke 两头的点各自落进一张卡，buildLinks 就派生出一条 declared:false 的连接，
         带 ids:['lnk1']、strokeId:'lnk1' —— 框住这笔时 readSelection 才能从 linkMap
         里把它捞成 selLink，.bd-inklink 才会浮出来。手写 board.links=[{id:'rel1',...}]
         会被 normalizeLinks 丢掉 id/ids，而且宣告的连接 strokeId 为 null（links.js:754）——
         框选那一笔根本捞不到它。
         画的连接，cond 记在那一笔上（stroke.cond），不是 board.links[i].cond。
         ★ newCard 的 x/y 是**中心**（board.js:268 存的是左上角 = x-w/2），所以端点要落进
           卡中心才稳：甲中心 (200,200)、乙中心 (600,400)。 */
      const stroke = { id: 'lnk1', points: [200, 200, 0.5, 600, 400, 0.5], w: 3, color: '#888', tool: 'pen' }
      b.cards = [A, B]
      b.strokes = [stroke]
      b.view = { s: 1, tx: 0, ty: 0 }
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, open, untilFile }) => {
    console.log('\n[link-cond] 连接线浮层里的「不算 / 就是它 / 改回」三颗条件按钮')
    await open()
    const rect = await s.eval(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height } })()`)
    if (!rect || !rect.w) { bad('量不到画布位置（canvas 没找到）'); return }
    /* 先切到「⬚ 框选」工具：点工具条上 data-tool="select" 那颗。
       默认是画笔，不切的话拖出来的是一笔、不是框选（selLink 自然出不来）。 */
    const toolBtn = await s.eval(`(() => { const b = document.querySelector('[data-tool="select"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    if (!toolBtn) { bad('找不到「⬚ 框选」工具按钮（[data-tool="select"]）—— 没法切到框选工具'); return }
    await s.mouse(toolBtn.x, toolBtn.y)
    await s.sleep(200)
    /* 大框框住整块画布：夹具里只有这一笔墨迹，必然被框住 → 连接线浮层出现。 */
    const x0 = rect.left + 12, y0 = rect.top + 12, x1 = rect.left + rect.w - 12, y1 = rect.top + rect.h - 12
    await s.mouse(x0, y0, { steps: 6, dx: x1 - x0, dy: y1 - y0 })
    const probe = await s.eval(`(() => {
      const link = document.querySelector('.bd-inklink')
      const acts = document.querySelector('.bd-inkacts')
      const labels = link ? Array.prototype.map.call(link.querySelectorAll('button'), (b) => b.textContent.trim()) : []
      const actLabels = acts ? Array.prototype.map.call(acts.querySelectorAll('button'), (b) => b.textContent.trim()) : []
      return { hasLink: !!link, linkLabels: labels, hasActs: !!acts, actLabels: actLabels }
    })()`)
    if (!probe.hasLink) {
      bad('框住连接线后没出现 .bd-inklink 浮层（条件按钮没地方挂）')
      if (probe.hasActs) bad('  （但 .bd-inkacts 出现了 —— 框选生效，只是 selLink 没成立；当前选区动作：' + probe.actLabels.join('、') + '）')
      else bad('  （连 .bd-inkacts 都没有 —— 框选没生效，工具没切到框选？）')
      return
    }
    const want = ['不算', '就是它', '改回']
    const missing = want.filter((w) => !probe.linkLabels.includes(w))
    if (missing.length) bad('连接线浮层缺了条件按钮：' + missing.join('/') + '（当前：' + probe.linkLabels.join(',') + '）')
    else ok('连接线浮层出现三颗条件按钮（不算 / 就是它 / 改回）—— 从关系面板请回后的新家')

    const clickBtn = async (label) => {
      const pos = await s.eval(`(() => {
        const link = document.querySelector('.bd-inklink')
        if (!link) return null
        const b = Array.prototype.slice.call(link.querySelectorAll('button')).find((x) => x.textContent.trim() === ${JSON.stringify(label)})
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!pos) return false
      await s.mouse(pos.x, pos.y)
      return true
    }

    if (await clickBtn('不算')) {
      /* drawn 连接：cond 记在那一笔上（stroke.cond），不是 board.links。 */
      const r1 = await untilFile((d) => (d.strokes || []).some((s) => s.id === 'lnk1' && s.cond === 'none'), { what: '点击「不算」后 stroke[lnk1].cond=none', timeout: 6000 })
      if (r1.ok) ok('点「不算」→ 这一笔 cond=none（画出来的连接，条件记在笔上，写进了文件）')
      else bad('点「不算」后盘上 stroke[lnk1].cond 不是 none（按钮没接到 vetoCond）')
    } else bad('点不到「不算」按钮')

    if (await clickBtn('改回')) {
      const r2 = await untilFile((d) => { const s = (d.strokes || []).find((x) => x.id === 'lnk1'); return !s || !s.cond }, { what: '点击「改回」后 stroke[lnk1].cond 清空', timeout: 6000 })
      if (r2.ok) ok('点「改回」→ cond 清空（回到按位置读）')
      else bad('点「改回」后 stroke[lnk1].cond 还在（按钮没接到 clearCond）')
    } else bad('点不到「改回」按钮')
  },
)

process.exitCode = (fails1 || fails2 || fails3) ? 1 : 0
