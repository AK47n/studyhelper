/* 常用形状规整（「◯ 规整」）+ **选区手柄**（放大 / 旋转）—— 真浏览器自检。
 *
 * 用户 2026-09-18：「加入常用形状优化方式，比如我画个圆他给我优化成真正的圆形，
 * 直线也是还有常用的矩形，三角形都能自动优化」。
 * 用户 2026-09-21：「框选中任意的字迹——卡片都应该能够放大，旋转，这点类似 onenote」
 * → 这个文件从那一天起管**两件事**：形状规整（[1]~[12f]）+ 选区手柄（[12g]/[12h]）。
 *
 * 纯逻辑那一层（判读、拟合、沿用 id、采样密度闸、成组变换的几何）在 check-board.js 的
 * [6x] 与 [6m] ⑫⑬（各 60+ 项）；这里管的是**界面上那一下**：
 * 框住 → 那颗按钮出不出现 / 手柄出不出来 → 拖下去 → 板上真的变了、而且一步 Ctrl+Z 能退回去。
 *
 * ★ 为什么这一层非真浏览器不可：三件事合起来只有真 DOM + 真指针能验 ——
 *   ① 那颗按钮**有条件地出现**（认不出形状时它必须不在）—— 这是这一族最要紧的
 *      交互设计，"按钮该不该在"是渲染结果，不是纯函数返回值；
 *   ② 它**点得到**吗 —— 这排按钮钉在包围框上方，屏幕右缘/关系面板会盖住它们
 *      （README 第 13 条：浮出来的按钮必须验 elementFromPoint，别看它在 DOM 里就以为能点）；
 *   ③ 画上去的墨迹**真的变成圆了没有**、拖手柄**真的变大了没有** —— canvas 上的点
 *      只有页面自己知道（`canvas.bd-ink` 的 dataset 只报"几笔"，报不了"圆不圆"）。
 *      所以这些断言要**从应用内存里**把点读出来量 —— 见下面 readStrokePoints。
 *
 * 断言清单：
 *   [1] 画一个手抖的圆 → 框住 → 「◯ 规整」出现，而且它**点得到**
 *   [2] 画一个圆 → 规整 → 那笔的点变成**正圆**（逐点量半径，偏差 < 0.5px）
 *   [3] 规整后：id 没变（还用同一笔，不是删了加一笔）、颜色/粗细原样
 *   [4] 认不出的东西（一段折笔）框住 → **那颗按钮不在**（铁律：认不出来就不打扰）
 *   [5] 框里混着"一个圆 + 一笔乱涂" → 按钮在，点下去**只动那个圆**，另一笔一个点都不变
 *   [6] Ctrl+Z 一步退回手写的样子（不是撤好几步、也不是退不回去）
 *   [7] 直线、矩形、三角形各认一遍，拟合后的几何真的"规整"了
 *   [8] 落盘：只有被规整的那一笔变了（其余笔、卡片、标题一个字节不动）
 *   [9]~[12f] 图形那一族的手柄：位置/命中/拖角放大/旋转/重开还在/大圆也认得出
 *   [12g] **任意一撮字迹**（认不出形状的两笔）：框住 → 出手柄 → 分开拉 → 转 90° → 一次退
 *   [12h] **卡片**也进框选：一起放大（卡片等比、笔迹分轴）→ 一起转（`rot` 落盘 + DOM 上真有变换）
 *         → Delete 一起删 → 钉住（📌）的框不进来
 *   [13] 页面里不许有 JS 报错
 *
 * 自己起服务（5223）和 headless Edge（9263），跑完都收掉；
 * 只碰自己造的夹具板 board-zz-shapecheck.md（跑完删）。
 * 胶水都收在 scripts/lib/board-check.js 的 withBoard 里：夹具的造/删、服务+浏览器、
 * CDP 会话、还有"跑完 data/ 里原有文件一个字节都不许变"那道守卫。
 *
 * ★ 本机只有 Edge（没有 Chrome），CDP 挑页面要按 URL 过滤 —— 那件事在 lib 里做了。
 *
 * ★★ 夹具里**必须有一张卡**（哪怕摆在很远的角落）—— 这不是凑数，是一个真陷阱：
 *    板**完全空**的时候，应用会在画布上盖一层 `.bd-hint`（"拿笔直接画 / …"那块提示），
 *    它是**收指针事件**的（z-index 也高）。于是"空板上画第一笔"这件事在自检里根本发生不了
 *    （实测：指针事件一条不差地到了 `.bd-hint` 上，`dataset.strokes` 一直是 0，
 *     看起来像"画不出来"，其实是坐标压在覆盖层上了 —— 和 MEMORY 里"画布类自检的
 *     夹具要算上覆盖层压在哪儿"是同一个坑）。夹具放一张卡进去，那块提示就不显示了。
 *
 * 用法：node scripts/check-shape.js   （或 npm run check:shape）
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

/* 夹具板上什么笔都不预置 —— 这一整份自检的**输入就是"画"这个动作本身**
   （规整的判读完全取决于笔迹的点，预置一份假的等于在验我自己写的数组）。
   只放一张卡当"地板上的参照物"，用来验"规整的时候卡片一个字节都没动"。
   ⚠ 卡片放在**世界坐标的远处**，免得它落进框选的矩形里影响 [5] 那条。 */
const CARD_ID = 'shapecheck-card'

const fails = await withBoard(
  {
    tag: 'shapecheck',
    port: 5223,
    cdpPort: 9263,
    make: () => {
      const b = newBoard('形状规整自检夹具（跑完自动删除）')
      b.cards.push({ ...newCard('note', 3000, 3000), id: CARD_ID, text: '这张卡是参照物', w: 260, h: 70 })
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, board, open, read, raw, untilFile, untilSaved, cdpPort, port }) => {
const sleep = (ms) => s.sleep(ms)

/* ★★ 捕获页面里的 `console.log` —— 加这一条的理由值得写清楚：
 *
 * 出过一次红："框住之后那一排动作没出现 —— 框选没选中？"。
 * 而**框选其实完全正常**（页面自己打了「框选 1 笔」），真正的原因是**判读阈值**没放过那个圆
 * —— 判读层老老实实返回了"认不出来"。可我的读数（`inkActs`）只会说"那一排不在"，
 * 于是脚本把锅甩给了框选。**读数分不清原因的时候，人就会去改错的地方。**
 *
 * 这个应用把每次选择和判读的结果都打到 console 上（那是给用户开 F12 自查用的），
 * 所以自检**顺手把同一份日志收下来**当证据 —— 红了之后一眼就能分清
 * "框没罩住"和"罩住了但认不出来"。这是最便宜的一种"读数有分辨力"。
 * ⚠ 它只当证据：断言不以 console 文案作判据。 */
const inkActsLog = []
s.onLog = (t) => {
  inkActsLog.push(t)
  if (inkActsLog.length > 300) inkActsLog.shift()
}
const FAILED = []
/* ★ 红了的**同时把证据落盘** —— 不是为了好看，是因为"红的那一刻屏幕上是什么样"
   只有那一刻取得到。自检跑完 withBoard 会把浏览器收掉，事后再看图就晚了。
   （这条是照着"自检要留下证据"那条教训加的：光有一句红字，回查只能靠再跑一遍，
     而再跑一遍未必复现 —— 比如"某一次刚好摇过阈值"。） */
const shoot = async (why) => {
  try {
    FAILED.push(why)
    const r = await s.send('Page.captureScreenshot', { format: 'png' })
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = path.join(process.cwd(), '.cache', 'shape-fail')
    fs.mkdirSync(dir, { recursive: true })
    /* ⚠ 文件名带上时间戳：**同名文件会被"看图的工具"缓存住**（实测：第二次跑出来的
       fail-1.png 明明变了，读出来还是上一张）—— 现场证据成了假证据，比没有还坏。 */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const f = path.join(dir, `fail-${FAILED.length}-${stamp}.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    console.log(`      ⤷ 现场截图：${f}`)
  } catch (e) {
    console.log(`      ⤷ （截图没成功：${e.message}）`)
  }
}

/* ═══════════════════ 页面侧的小工具 ═══════════════════ */

/* 页面自己的 console 日志（上面 s.onLog 收集的）。
   只当证据用 —— 断言不以它作判据（console.log 是给人看的，随时可能改文案）。 */
const shapeLog = () => inkActsLog.filter((t) => /框选|形状|规整|认出/.test(t)).slice(-8)

/* ★★ 从**应用内存里**读某一笔的点 —— 这是这份自检最关键的一个读数。
 *
 * 为什么不能从 DOM / canvas 读：
 *   · canvas 是画出来的像素，"这一笔有几个点、半径多少"它不知道；
 *   · `canvas.bd-ink` 的 dataset 只报一个**笔数**（够验"多了/少了一笔"，
 *     验不了"圆不圆"）。
 * 所以要进 React 那一侧的状态。板不在 window 上，但**量规整的结果**可以从
 * 渲染出来的每一笔自己算 —— StepCanvas 会给每一笔一个 data-stroke-id，
 * 而点的坐标只能从内存拿。
 *
 * ★ 走的路：DOM 上每一笔都有一个 `data-stroke-id`（自检用得上，见 check-clip）；
 *   而**点**从画布组件的 props 拿不到，所以这里用一个**只读**的回退：
 *   从 localStorage / 板文件读是异步且滞后的（防抖 700ms），
 *   验"屏幕上这一笔真的变圆了"不能等落盘 —— 那验的是**存盘**，不是**渲染**。
 *
 * 因此这里用 `until` + 板文件，但判据是"盘上那一笔变成正圆了"，
 * 落盘本来就是"用户看得见的结果"的另一半（Claude 那句"[10] 重开还在"同源）。
 * ⚠ 而"按钮出不出来 / 点不点得到"那几条**必须**在页面上验，不能等落盘。 */
const strokeIds = () => s.eval(`[...document.querySelectorAll('[data-stroke-id]')].map((el) => el.dataset.strokeId)`)

const inkCount = () => s.eval(`Number(document.querySelector('canvas.bd-ink').dataset.strokes)`)

/* 那一排动作现在有哪几颗按钮（按 class 名认 —— 它们各自有自己的类）。 */
const inkActs = () => s.eval(`(() => {
  const row = document.querySelector('.bd-inkacts')
  if (!row) return { present: false, buttons: [], shapeKind: null }
  const btns = [...row.querySelectorAll('button')]
  const shape = row.querySelector('.bd-inkshape')
  return {
    present: true,
    buttons: btns.map((b) => b.className.split(' ').find((c) => c.startsWith('bd-ink')) || b.className),
    shapeLabel: shape ? shape.textContent.trim() : null,
    shapeKind: shape ? shape.dataset.inkShape : null,
    shapeRect: shape ? (() => { const r = shape.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) } })() : null,
  }
})()`)

/* 命中测试：某一点上**最上面的**是谁。沾指针的东西都得先问过它（README 第 13 条）。 */
const hitAt = (x, y) => s.eval(`(() => {
  const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
  if (!el) return '(无)'
  return el.className && typeof el.className === 'string' ? el.className : el.tagName
})()`)

/* ★ 视图缩放：**按屏幕像素摆点之前先量它**。
   ⚠ 那一族的闸（MIN_DIAG 等）是世界像素的，所以屏幕上画多少得先乘 k ——
     画小了会"认不出来"，报出来却像"功能没读出来"（MEMORY 里记着这条坑）。
   ★ 量的是 `canvas.bd-ink` 的 `data-xform`（"s,tx,ty"）——
     那是 `applyViewTo` **真写进 canvas 的那三个数**（BoardCanvas 里这么说的），
     不是我自己再推一遍（同一个数在两处各算一遍，就会有一处忘了改）。 */
const readXform = () => s.eval(`(() => {
  const el = document.querySelector('canvas.bd-ink')
  if (!el || !el.dataset.xform) return null
  const a = String(el.dataset.xform).split(',').map(Number)
  if (a.length < 3 || !a.every(Number.isFinite)) return null
  return { s: a[0], tx: a[1], ty: a[2] }
})()`)
const readScale = async () => {
  const x = await readXform()
  return x ? x.s : 0
}

/* ★★ 屏幕坐标 → 世界坐标。
 *
 * 为什么非要有这一条：这套自检里"屏幕"和"世界"两个坐标系一直在换着用 ——
 * 画的时候按屏幕摆点、判读的闸按世界像素、而**盘上存的是世界坐标**。
 * 原来我在后面量盘上那些点时，直接拿"画的时候那个屏幕坐标"当圆心使，
 * 那等于赌"视图的平移是 0"（即板上内容的世界原点正好落在画布左上角）——
 * 实测确实如此（这块夹具板内容很小、autofit 之后恰好把世界原点摆在了画布角上），
 * **但那是运气，不是规矩**：失败样本里我那个"盖满画布的大圆"，圆心在屏幕上量出来是
 * 世界 (3554, 3533) —— 差着一个屏幕的宽度。所以这里老老实实做反变换：
 *     world = (screen - 舞台左上角 - tx) / s
 * （`applyViewTo` 写进 canvas 的变换是：先按 s 缩放世界、再平移 tx/ty，原点在画布左上角。）
 * ⚠ 这句话在 Board 的 view.js 里也有一份（worldToScreen）—— 那是**正**变换，
 *   而这里需要的是**反**的。自检里只有这一处做反变换，别在别处再抄一份。 */
const toWorld = (x, y, origin, xf) => ({
  x: (x - origin.x - xf.tx) / xf.s,
  y: (y - origin.y - xf.ty) / xf.s,
})
/* ★★ 反变换的**原点必须来自 canvas 自己**，不能拿 `.bd-stagewrap` 的 rect 顶上。
 *
 * ⚠⚠ 这一条是**最贵的一个假红**，必须在下面写清楚（我在这上面连错了三轮判据）：
 *   症状：`[2]` 报"规整出来的圆不够圆：中位偏差 1.257px、最大 1.797px"，
 *     而且逐点偏差是一条**完美的余弦波**（第 0 点 −1.73 → 第 35 点 +1.80 → 第 72 点 −1.73，
 *     正好一个周期）。这形状是"**圆心偏了**"的指纹，不是"画得不圆"。
 *   于是我去查 `fitCircle` 求圆心那一段，怀疑"首尾重叠段把质心拉偏"
 *     —— 那个怀疑**本身是对的**（实测重叠 30° 能把质心拉走 6.17px），也顺手修了；
 *     但**它不是我眼前这条红的原因**。
 *   真因是我这个读数量出来的圆心**本身就是错的**：`toWorld` 用的是
 *     `.bd-stagewrap` 的 `getBoundingClientRect()`，而应用记点时用的 canvas
 *     自己的 rect —— 实测两者 **x 差 3.60 屏幕像素**（世界 1.8px），
 *     于是"逐点到那个圆心"必然出现 ±1.8px 的振幅，一半点偏正、一半点偏负。
 *
 * ★ 我为什么绕了三轮才发现：中间我打印过"我用的圆心 vs 那一笔实际的圆心，差 0.10px"，
 *   于是判断"尺子是对的"。**那个判断是错的** —— 那个"实际圆心"是**点的平均值**，
 *   而点的平均值是"这一笔自己算出来的"，它 100% 等于"这一笔的几何中心"，
 *   跟"我以为的圆心"只差浮点舍入。**拿"点平均值 ≈ 我算的圆心"去证明尺子准，
 *   证明的只是"我算的数没错"，证明不了"我量的对象对"。**
 *   ⇒ 教训：**验证一把尺子，要拿一个"几何上必然成立、与笔迹无关"的量** ——
 *     比如一个圆的"最左到最右 = 最上到最下 = 直径"。那个数我从盘上量出来了（160.0 / 160.0），
 *     一量就看出真圆心在 (2839.20, 2935.00)，而我的尺子报 (2840.96, 2934.90) —— 一眼分明。
 *
 * ★ 现在的读法：`canvas.bd-ink` 自己的 `getBoundingClientRect()`。
 *   它就是"世界原点摆在屏幕上的哪儿"，不需要我再假设任何东西。
 *   ⚠ `stageRect` 参数仍然保留（`selectRect` 夹取要用舞台范围），但**不再当原点用**。 */
/* ★ 反向：世界 → 屏幕。**只给"把画好的东西摆到屏幕上"用**（[6] 要从世界坐标算框选范围）。
   ⚠ 界线划清楚：**画的时候**一律用屏幕坐标（那是 drawPath 真正需要的），
     **量盘上那些点时**才换到世界坐标。两边都用同一个 `xform` 和**同一个原点**，
     所以它们不会各说各话。 */
const toScreen = (x, y, origin, xf) => ({
  x: x * xf.s + xf.tx + origin.x,
  y: y * xf.s + xf.ty + origin.y,
})

/* ★★ 世界原点在屏幕上的哪儿 —— **问 canvas 自己**（见 toWorldWith 上面那段长注释：
   拿 `.bd-stagewrap` 的 rect 顶替这一件事，让我多追了三轮判据）。 */
const readOrigin = () => s.eval(`(() => {
  const el = document.querySelector('canvas.bd-ink')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y }
})()`)

/* ★ 画一笔。**必须走真指针**（CDP 的 Input.dispatchMouseEvent）——
   合成事件（dispatchEvent）落在浮层上时应用收不到，而且指针类型也算不出来
   （见 README 第 11 条、以及"画布类自检的夹具要算上覆盖层压在哪儿"那条）。
   ⚠ 起手先发一个 mouseMoved（**不按键**）hover 一下：应用靠"最近一次是什么设备"
     决定卡片让不让路（见 Board.jsx 的 trackPointerKind）。 */
/* ★★ 画之前先把屏幕坐标**取整**，而且**这一整份自检里的"我画的坐标"只有这一份**。
 *
 * ⚠⚠ 这是这一轮最后查出来的一块拼图，也是最隐蔽的一块 —— 它的症状长得像"拟合不圆"：
 *   判据报"规整出来的圆中位偏差 1.285px"，逐点偏差是一条完美的余弦波（圆心偏了的样子）。
 *   查了三轮才发现：**圆心根本没偏，是"我以为的圆心"错了。**
 *   ① 我给 CDP 的圆心是 `519.9`（`stage.x + min(260, 1136*0.22)` = 270 + 249.9）；
 *   ② CDP 把 `x: 519.9` 发下去，**浏览器收到的是整数 520**（合成事件走的是整数坐标），
 *      应用记下的就是 520 那一格；
 *   ③ 而我反推世界圆心时用的还是 `519.9`。
 *   ⇒ 差 0.1 屏幕像素是小事，**但它乘 k=2、再叠上"我读到的 canvas 原点和应用自己算的时候那一个"的
 *     0.1px 差**，就成了 1.76 世界像素 —— 正好把"逐点到圆心"的量法搞出一条 ±1.76 的余弦波。
 *
 * ★ 修法的要点不是"取整"本身，而是**只留一份坐标**：
 *   取整发生在 `drawPath` 里，而**调用方要反推世界坐标时，必须回头问这里画的是哪儿** ——
 *   所以 `drawPath` 把它实际发出去的起手点/圆心记在 `lastDrawn` 上。
 *   ⚠ 别在调用方各写一遍 `Math.round`：那就是"同一句话有两份实现"，
 *     而这两份**必然**会在某一天差一格（README 第 38 条那种"自检量自己的复制品"）。
 */
let lastDrawn = null
async function drawPath(pts, { pen = false } = {}) {
  /* 取整到这里为止 —— 后面所有"我画的坐标"都从 lastDrawn 读。 */
  const P = pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
  lastDrawn = P
  if (pen) {
    /* 先 hover：pointerType=pen 的 moved，应用据此收掉鼠标光标、让卡片让路。 */
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: P[0].x, y: P[0].y, pointerType: 'pen' })
    await sleep(60)
  }
  const [first, ...rest] = P
  await s.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: first.x, y: first.y, button: 'left', clickCount: 1, buttons: 1,
    pointerType: pen ? 'pen' : 'mouse',
  })
  for (const p of rest) {
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1,
      pointerType: pen ? 'pen' : 'mouse',
    })
  }
  const last = rest[rest.length - 1] || first
  await s.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1, buttons: 0,
    pointerType: pen ? 'pen' : 'mouse',
  })
  await sleep(120)
}

/* 把一段"世界坐标里的理想图形"变成屏幕点序列（含手抖），交给 drawPath。
 * ★ 抖动是**确定性**的（正弦叠加）—— 随机抖动会让某一次刚好摇过阈值，
 *   报出来是"功能坏了"，而重跑一次又好了（那种红查不出是谁的锅）。
 *
 * ★★ 参数的规矩（这里踩过一次，值得钉死）：**圆/线的形状定义在世界坐标里，然后整段乘 k 搬到屏幕**；
 *   而矩形/三角形是**直接按屏幕像素**给的（它们的边长是"屏幕上看起来多长"，
 *   所以由调用方自己乘 k）。两族不一样，写反了不会报错，只会画出一个歪东西。
 *
 * ⚠ 踩到的那次是圆：`screenCircle` 原来写的是 `cx + (r*cos + jit) * k`，
 *   而调用方传的是 `r = 80 * k` —— **半径被乘了两次 k**，屏幕上画出来是 4 倍大
 *   （直径 1280px > 画布 1136px），于是那一笔盖满整个画布、还扫过底部工具条。
 *   后果不止"画得丑"，而是**它把一个数学错误伪装成了功能证明**：
 *   世界半径 = (80k·k)/k = 80k = 160，`cs.r ≈ 160`，而断言里的
 *   `Math.abs(cs.r - 80) < 8` 本来能抓住它 —— 可[1]先红了 return，这条断言根本没跑到。
 *   所以现在的规矩是：**这里只做"世界 → 屏幕"这一件事，不替调用方乘 k。 */
const jit = (i) => Math.sin(i * 0.7) * 1.6 + Math.sin(i * 2.3) * 0.9
/* 圆心/半径/抖动都是**世界坐标**，整段乘 k 搬到屏幕。
   ⇒ 调用方传世界半径（80），屏幕半径自动是 80k —— 别再自己乘一遍。 */
function screenCircle(cx, cy, rWorld, k, n = 110) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2
    out.push({ x: cx + (rWorld * Math.cos(t) + jit(i)) * k, y: cy + (rWorld * Math.sin(t) + jit(i + 11)) * k })
  }
  return out
}
/* ★★ 造一个"我打算画在这儿"的圆心：**取整**，然后这一整份自检里关于它的坐标都从这儿读。
 *
 * ⚠ 为什么非要取整（血泪，见 drawPath 上面那段）：**CDP 的合成事件走整数坐标**。
 *   我给 `screenCircle` 传 `519.9`，浏览器收到的是 `520`，应用记的也是 520 那一格；
 *   而我反推世界圆心时用的是 `519.9` —— 于是"我以为的圆心"和"笔迹真正的圆心"
 *   差 0.1 屏幕像素 × k = 0.2 世界像素，叠上读 canvas 原点的 0.1px，最后成了 1.76px。
 *   那 1.76px 会变成一条**完美的余弦波**出现在"逐点到圆心的距离"上 ——
 *   看起来百分之百像"拟合出来的圆不圆"，其实是**尺子自己歪了**。
 *   ⇒ 规矩：**在这个文件里，"我画的圆心"必须先取整，之后所有人都用它。** */
const roundPt = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) })
function screenLine(x0, y0, x1, y1, n = 60) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    out.push({ x: x0 + (x1 - x0) * u + jit(i) * 0.5, y: y0 + (y1 - y0) * u + jit(i + 4) * 0.5 })
  }
  return out
}
function screenRect(x, y, w, h, k, per = 34) {
  /* ⚠ 这里是**屏幕像素**那一族：x/y/w/h 都是屏幕上的数，调用方自己乘 k。 */
  const out = []
  const cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = cs[c]
    const [bx, by] = cs[(c + 1) % 4]
    for (let i = 0; i < per; i++) {
      const u = i / per
      out.push({ x: ax + (bx - ax) * u + jit(c * 97 + i) * k, y: ay + (by - ay) * u + jit(c * 97 + i + 3) * k })
    }
  }
  out.push({ x, y })
  return out
}
function screenTri(p1, p2, p3, k, per = 40) {
  const out = []
  const vs = [p1, p2, p3]
  for (let c = 0; c < 3; c++) {
    const [ax, ay] = vs[c]
    const [bx, by] = vs[(c + 1) % 3]
    for (let i = 0; i < per; i++) {
      const u = i / per
      out.push({ x: ax + (bx - ax) * u + jit(c * 61 + i) * k, y: ay + (by - ay) * u + jit(c * 61 + i + 2) * k })
    }
  }
  out.push({ x: p1[0], y: p1[1] })
  return out
}
/* 一段"汉字折笔"（一横一竖）：**必须认不出来**。⚠ 参数是**屏幕像素**，所以调用方乘 k。 */
function screenFold(x, y, k) {
  const out = []
  for (let i = 0; i <= 45; i++) out.push({ x: x + i * 4 * k + jit(i), y: y + jit(i + 1) })
  for (let i = 0; i <= 30; i++) out.push({ x: x + 180 * k + jit(i), y: y + i * 4 * k + jit(i + 5) })
  return out
}

/* 切工具：**点工具条上那颗按钮**（用户走的就是这条路），不用键盘。
   ⚠ 不用键盘 S 的原因：键盘那条路只有"焦点不在输入框里"才生效，
     而框选之后焦点可能还留在某个地方 —— 点按钮没有这个前提，更接近用户。
   ★ 切完**必须回头确认按钮真的亮了**（`classList.contains('on')`）——
     切不过去的话后面整段都会变成"框选没选中"这种假错（check-clip 里学来的）。 */
async function pickTool(name) {
  const found = await s.eval(`(() => {
    const b = document.querySelector('[data-tool="${name}"]')
    if (b) b.click()
    return !!b
  })()`)
  if (!found) return false
  await sleep(200)
  return s.eval(`(() => { const b = document.querySelector('[data-tool="${name}"]'); return b ? b.classList.contains('on') : false })()`)
}

/* 框选一个屏幕矩形：切到 select → 鼠标拖一个框 → 切回笔。
   ★ 框选的起止点**按屏幕上真实的位置**算（不猜世界坐标）——
     板是自动适配进屏幕的，写死一个世界矩形换块屏幕就可能落到舞台外面。
   ★ 夹进舞台里：框选必须**从纸面上起手**（起点压在工具条/侧栏上事件收不到）。
   ★ 鼠标拖框（不压 Shift）：见 check-clip 的选择 —— 那里也是这么干的。 */
async function selectRect(x0, y0, x1, y1, { mustFitStage = true } = {}) {
  const onSel = await pickTool('select')
  if (!onSel) return { ok: false, why: '工具没切到「⬚ 框选」' }
  let a = { x: Math.round(x0), y: Math.round(y0) }
  let b = { x: Math.round(x1), y: Math.round(y1) }
  if (mustFitStage) {
    /* 夹进舞台 —— 用**舞台真实的屏幕矩形**，不是我记的那个（面板会改它）。 */
    const sr = await s.eval(`(() => { const e = document.querySelector('.bd-stagewrap'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
    if (sr) {
      a = { x: Math.max(sr.x + 6, a.x), y: Math.max(sr.y + 6, a.y) }
      b = { x: Math.min(sr.x + sr.w - 6, b.x), y: Math.min(sr.y + sr.h - 6, b.y) }
    }
  }
  await s.drag(a.x, a.y, b.x - a.x, b.y - a.y, { steps: 10, button: 'left' })
  await sleep(220)
  /* 切回笔：不然下一次"再画一笔"会变成又框一次（把这个坑写在函数里，别让调用方记）。 */
  await pickTool('pen')
  await sleep(120)
  return { ok: true, a, b }
}

const pressCtrlZ = async () => {
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'char', text: '\u001a' })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await sleep(260)
}

/* ★★ "规整出来的圆够不够圆"的阈值。
 *
 * 判据是"逐点到圆心的距离，相对中位数的偏差"（中位 + 最大两道）。
 * ★ 理论值：`fitShape` 输出的圆是 **72 段等分角度**的多边形 —— 它的顶点精确落在 r 上，
 *   但**相邻顶点的连线（弦）离圆心比 r 近**，最近处差
 *     `r · (1 − cos(π/72))` = 80 × (1 − cos 2.5°) ≈ **0.076px**
 *   （半径 80 的时候）。所以"中位偏差"不该是 0，而该是 **0.0x** 量级。
 * ⚠ 这里是拿**包围盒中心**当圆心量的（不是"我画的那个圆心"，理由见 [2] 里面那段血泪账）：
 *   包围盒中心对一个 72 等分正圆来说就是圆心，误差 1e-9 量级。
 *   于是阈值可以定得很紧 —— 中位 0.05、最大 0.15 就已经比理论值大一倍了。
 * ⚠ 不要定成 0.01：**存盘是 1/10 像素量化**的（`fitShape` 里 `Math.round(x*10)/10`），
 *   每个坐标各自 ±0.05px，逐点到圆心的距离因此会有 0.05px 量级的抖动。 */
const RENDER_CIRCLE_MED = 0.12
const RENDER_CIRCLE_MAX = 0.30

/* 量"某一笔有多圆"：从落盘的板上读那一笔的点，逐点算到圆心的距离。
 *
 * ★★ 判据用**中位偏差**，不用最大偏差：规整出来的 72 段是精确落在同一个 r 上的，
 *   所以只要它真的是个圆，中位偏差应当接近 0。
 *
 * ⚠⚠ 圆心**不许用"我从屏幕反推的那个"** —— 这一条把这条判据搞红了四次，
 *   账在 [2] 那段血泪注释里。用**这一笔自己的包围盒中心**：
 *   一个 72 等分、首尾闭合的正圆，`(最左+最右)/2` 数学上就是圆心，
 *   和视图变换 / 事件取整 / canvas 原点**全都无关**。
 *   ⇒ 这是"与尺子无关"的判据：它只用了这一笔自己的点。
 *   ⚠ 传 `center` 参数只是给"量一个**手画的**圆"用的（那时候包围盒中心会偏，
 *     因为它不闭合、有收笔重叠）—— 但**不要**拿"我以为的圆心"传进来。
 */
function circleStats(points, center) {
  const pts = []
  for (let i = 0; i + 2 < points.length; i += 3) pts.push({ x: points[i], y: points[i + 1] })
  if (pts.length < 8) return null
  let cx
  let cy
  if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
    cx = center.x
    cy = center.y
  } else {
    /* 包围盒中心 —— 比"点的平均值"更稳（点均值会随浮点累加顺序有系统偏差，
       实测能偏 0.8px，那个偏差会被误读成"拟合不圆"，见下面那段注释的来历）。 */
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    cx = (Math.min(...xs) + Math.max(...xs)) / 2
    cy = (Math.min(...ys) + Math.max(...ys)) / 2
  }
  const rs = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b)
  const med = rs[Math.floor(rs.length / 2)]
  const devs = rs.map((r) => Math.abs(r - med)).sort((a, b) => a - b)
  return {
    n: pts.length,
    cx: Math.round(cx * 100) / 100,
    cy: Math.round(cy * 100) / 100,
    r: Math.round(med * 100) / 100,
    medDev: Math.round(devs[Math.floor(devs.length / 2)] * 1000) / 1000,
    maxDev: Math.round(devs[devs.length - 1] * 1000) / 1000,
  }
}

/* ═══════════════════ 0. 打开夹具板 ═══════════════════ */
{
  await open()
  if (!board) {
    bad('没有夹具板 —— 这一份自检必须有自己的板')
    return
  }
  const n = await inkCount()
  if (n === 0) ok('夹具板是空的（这一份自检的输入就是"画"这个动作本身）')
  else console.log(`  （⚠ 夹具板上已经有 ${n} 笔，后面的"多了几笔"要按这个基数算）`)

  /* ★★ 空板提示那一层在不在 —— 它要是盖着，"画第一笔"根本发生不了，
     而后面的断言会一条条报成"认不出来 / 框选没生效"，全是假错。
     所以这一条**先报**，把真原因顶到最前面。 */
  const hint = await s.eval(`!!document.querySelector('.bd-hint')`)
  if (hint) {
    bad('★ 画布上盖着「空板提示」那一层（.bd-hint）—— 它收指针事件，画的每一笔都会被它吃掉。'
      + '夹具里得放一张卡（哪怕在角落），那块提示才不显示')
    return
  }
  ok('画布上没有「空板提示」那一层（它只在板完全空的时候出现，而且会吃掉指针事件）')
}

/* 画布中心附近留一块干净地方给这一轮实验。 */
const stage = await s.eval(`(() => {
  const el = document.querySelector('.bd-stagewrap')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
})()`)
if (!stage) {
  bad('没有 .bd-stagewrap —— 白板没渲染出来，后面全都没意义')
  return
}
const k = await readScale()
const xform = await readXform()
if (!xform || !(xform.s > 0)) {
  bad('量不到视图变换（canvas.bd-ink 的 data-xform）—— 不敢按屏幕像素画东西，也反推不出世界坐标')
  return
}
/* ★★ 世界原点在哪 —— **问 canvas 自己**（不能拿 stage 的 rect 顶替，见 toWorld 上面那段）。
   ⚠ 顺手把"两者差多少"打出来：这个差就是"尺子歪了多少"，
     它一旦不为 0，后面每一条"拿世界圆心量笔迹"的判据都会无辜地红。
     **把它变成一个显式读数**，比让它藏在反变换里、等三条判据一起红要便宜得多。 */
const origin = await readOrigin()
if (!origin) {
  bad('量不到 canvas.bd-ink 的位置 —— 反推不出世界原点，后面"拿世界圆心量笔迹"的判据都不可信')
  return
}
const originOff = Math.hypot(origin.x - stage.x, origin.y - stage.y)
console.log(`\n  （画布 ${stage.w}×${stage.h}，视图缩放 ${k}，平移 ${xform.tx.toFixed(1)},${xform.ty.toFixed(1)}）`)
if (originOff > 0.5) {
  ok(`★ 世界原点用的是 canvas 自己：(${origin.x.toFixed(1)},${origin.y.toFixed(1)}) ——`
    + `它和 .bd-stagewrap 的左上角 (${stage.x},${stage.y}) **差了 ${originOff.toFixed(2)}px**。`
    + `拿后者当原点会让"逐点到圆心的距离"凭空多出 ±${(originOff / k).toFixed(2)} 世界像素的振幅）`)
} else {
  console.log(`  （世界原点 (${origin.x.toFixed(1)},${origin.y.toFixed(1)}) 和舞台左上角重合）`)
}

/* ═══════════════════ 1. 画个圆 → 框住 → 按钮出现且点得到 ═══════════════════ */
console.log('\n[1] 手画一个圆 → 框住 → 「◯ 规整」出现，而且它点得到')
let circleScreen = null
/* ★ 记下"我画的那个圆"在**世界坐标**里的样子 —— 后面几条要用它当尺子：
 *   `expectCWorld`  圆心的世界坐标（盘上存的就是这一套坐标）。
 *   `expectRWorld`  世界半径（盘上量出来的半径该等于它）。
 * ⚠ 圆心**必须从屏幕坐标反推**（见 toWorld 那段）—— 不能直接拿屏幕坐标当世界坐标用，
 *   那是在赌"板从世界原点开始摆"。失败样本里那个大圆的圆心在屏幕上量出来是世界 (3554,3533)，
 *   差着一个屏幕宽：赌输了之后"不够圆"这条会红得看不出是谁的错。
 * ⚠ 半径不用反推：它是**长度**，世界长度 = 屏幕长度 / k（画的时候乘了 k）。
 *   名字里带 World/Screen 就是为了不再犯"拿屏幕半径比世界半径"那种单位错。 */
let expectCWorld = null
let expectRWorld = 0
{
  /* 世界半径 80 的圆 → 屏幕上 80×k。放在画布左上部，避开关系面板（右侧 320px）。
     ★★ 圆心**先取整**（`roundPt`）再用 —— 理由见那个函数的注释：
       CDP 发的是整数坐标，我不取整的话"我以为的圆心"和"笔迹真正的圆心"会差一格。 */
  const c0 = roundPt({ x: stage.x + Math.min(260, stage.w * 0.22), y: stage.y + Math.min(260, stage.h * 0.28) })
  const cx = c0.x
  const cy = c0.y
  const rWorld = 80
  circleScreen = screenCircle(cx, cy, rWorld, k)
  expectCWorld = toWorld(cx, cy, origin, xform)
  expectRWorld = rWorld
  console.log(`      我画的那个圆：屏幕 (${cx},${cy}) r=${rWorld * k}px｜世界 (${expectCWorld.x.toFixed(1)},${expectCWorld.y.toFixed(1)}) r=${rWorld}`)
  const before = await inkCount()
  /* 用笔（pointerType pen）：真手写场景，而且验一下"笔画的也算" */
  await drawPath(circleScreen, { pen: true })
  const after = await inkCount()
  if (after === before + 1) ok(`画了一个手抖的圆（${before} → ${after} 笔）`)
  else bad(`画圆没画上（${before} → ${after}）—— 后面的断言都没意义了`)

  /* 框住它（比它大一圈）。
     ★ 边距是**屏幕像素**，而且**要乘 k 吗？—— 不乘。** 这一点值得写下来：
       包围框是按世界坐标算的，所以世界 10px 的余量到屏幕上是 10×k。
       但这里要的只是"框选从纸面空白处起手、再把笔迹罩住"，
       而 k 在本机是 2 —— 24 屏幕像素 = 世界 12，画 fuzzily 的圆根本不会超出去。
       ⚠ 唯一真会出问题的是 `selectRect` 里**夹进舞台**那一步：
         夹完之后框可能被压得比笔迹还小（起手落在图形内部 = 框选不生效）。
         所以这里先量一遍夹取之后框到底有多大，不够就明说。 */
  const pad = 24
  const q = await selectRect(cx - rWorld * k - pad, cy - rWorld * k - pad, cx + rWorld * k + pad, cy + rWorld * k + pad)
  console.log(`      框选了屏幕 (${q.a.x},${q.a.y}) → (${q.b.x},${q.b.y}) = ${q.b.x - q.a.x}×${q.b.y - q.a.y}；圆占 ${Math.round(rWorld * k * 2)}×${Math.round(rWorld * k * 2)}（世界半径 ${rWorld}，k=${k}）`)
  const diag = await s.eval(`(() => {
    const btns = [...document.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool + (b.classList.contains('on') ? ':ON' : ':-')).join(' ')
    return { tools: btns, box: !!document.querySelector('.bd-inkbox'), acts: !!document.querySelector('.bd-inkacts'),
      strokes: Number(document.querySelector('canvas.bd-ink').dataset.strokes) }
  })()`)
  console.log(`      [诊断] ${JSON.stringify(diag)}`)
  const acts = await inkActs()
  if (!acts.present) {
    /* ★ 分两种可能，别一上来就喊"框选没选中"（上次就是栽在这 —— 框选明明成功，
       是判读层认不出那个圆，锅却甩给了框选）。判据是**框有没有真的量到东西**：
       屏幕上画着 .bd-inkbox 就说明应用认为"框里有笔迹"。
       日志再补一句页面自己怎么说（判读层每次都打「形状判读：…」）。 */
    const boxed = await s.eval(`!!document.querySelector('.bd-inkbox')`)
    if (boxed) {
      bad(`★ 框住了、界面也知道框里有东西（.bd-inkbox 在），但那一排动作没出来 ——`
        + `也就是这一框里**一笔都没认出来**。看判读那一层的阈值`
        + `（页面日志：${shapeLog().join(' ｜ ') || '（没有相关日志）'}）`)
    } else {
      bad(`框住之后那一排动作没出现 —— 框里没有笔迹？（框选起手点落在图形内部时框选不生效。`
        + `页面日志：${shapeLog().join(' ｜ ') || '（没有相关日志）'}）`)
    }
    await shoot('框住之后那一排没出现')
    return
  }
  if (acts.shapeRect) ok(`★ 「${acts.shapeLabel}」出现了（框里认出了一个 ${acts.shapeKind}）`)
  else bad(`★ 框住一个手画的圆，却没出现「◯ 规整」—— 那一排是：${acts.buttons.join(' / ')}`)
  /* ★ 先问命中测试，再动手 —— 别看它在 DOM 里就以为能点（这一排钉在包围框上方，
     屏幕右缘和关系面板都会盖住它们，README 第 13 条踩过两次）。 */
  if (acts.shapeRect) {
    const hit = await hitAt(acts.shapeRect.cx, acts.shapeRect.cy)
    if (String(hit).includes('bd-inkshape')) ok('★ 它的中心那一点命中的就是它自己（没被关系面板/工具条盖住）')
    else bad(`「◯ 规整」中心命中的是「${hit}」—— 用户点下去会点到别的东西`)
    /* 整排都要在画布内（左边缘 ≥ 0、右边缘 ≤ 画布宽） */
    if (acts.shapeRect.x >= stage.x && acts.shapeRect.x + acts.shapeRect.w <= stage.x + stage.w) {
      ok('…而且它整颗都在画布范围里')
    } else {
      bad(`…它跑到画布外面了：x=${acts.shapeRect.x} w=${acts.shapeRect.w}，画布 ${stage.x}..${stage.x + stage.w}`)
    }
  }
}

/* ═══════════════════ 2. 点它 → 那一笔真的变成正圆 ═══════════════════ */
console.log('\n[2] 点「◯ 规整」：那笔的点变成**真正的圆**')
let regularizedOnce = false
/* ★ 规整出来的那一笔的 id —— [6] 要靠它来"退掉这一步"（而不是按点数扫全板，
   那会在 [7] 画完矩形之后撞车：矩形规整完正好也是 5 个点）。 */
let offCircleId = null
{
  const acts = await inkActs()
  if (!acts.shapeRect) {
    console.log('  （⚠ [1] 没出现那颗按钮，这一条跳过）')
  } else {
    const beforeCount = await inkCount()
    await s.mouse(acts.shapeRect.cx, acts.shapeRect.cy)
    await sleep(320)
    const afterCount = await inkCount()
    if (afterCount === beforeCount) ok(`规整不增不减笔数（还是 ${afterCount} 笔）—— 它换的是那一笔的样子，不是删了加一笔`)
    else bad(`笔数变了：${beforeCount} → ${afterCount}（规整应当是"换 points"，不是删+加）`)

    /* ★ 判据走落盘（"应用说已存"之后读文件）——
       落盘是这一步结果**可复核**的那一面（重开之后还在，就是用户看到的东西）。
       ⚠ 不用固定毫秒：应用侧有 700ms 防抖存盘，等多少都是猜（README 第 38 条）。 */
    const saved = await untilSaved()
    const doc = (await read()) || (saved && (await read()))
    if (!doc) {
      bad('夹具板读不出来 —— 规整的结果没法核验')
    } else {
      /* 板上只有我画的那一笔有几十个点以上的闭合笔迹 —— 按"点数最多"找它最稳。 */
      const all = doc.strokes || []
      const cand = all
        .map((st) => ({ st, n: (st.points || []).length / 3 }))
        .sort((a, b) => b.n - a.n)[0]
      if (!cand || cand.n < 8) {
        bad(`盘上找不到我画的那一笔（最多点的只有 ${cand ? cand.n : 0} 个）`)
      } else {
        /* ★★ 判据：**不许用任何"我从屏幕反推的圆心"** —— 那是这一条红了四次的原因。
         *
         * ⚠⚠ 血泪账（写清楚，因为我在这上面连续做错了四个判断，每一个都听起来很有道理）：
         *
         *   ① 第一次红：报"中位偏差 0.696px"，逐点偏差是一条**完美的余弦波**。
         *      我判断"这是圆心偏了的样子"，于是去查 `fitCircle` 求圆心那一段 ——
         *      **那个方向是对的**（顺带查出一个真 bug，见 shapes.js 里 trimOverlap），
         *      但**它不是我眼前这条红的原因**。
         *   ② 第二次：我打印"我用的圆心 vs 那一笔实际的圆心，差 0.10px"，
         *      于是判断"尺子是对的，是拟合真的不圆"。**这个判断是错的** ——
         *      那个"实际圆心"是**点的平均值**，它 100% 等于这一笔自己的几何中心，
         *      跟我以为的圆心只差浮点舍入。**拿它证明尺子准，证明的只是"我算的数没错"。**
         *   ③ 第三次：改用 `canvas.bd-ink` 的 rect 当原点（不再用 `.bd-stagewrap` 的），
         *      差 3.60px —— 读数变了一点，但**还是 1.3px**。
         *   ④ 真因（第四次才找到）：**CDP 的合成事件走整数坐标**。
         *      我传给 `screenCircle` 的圆心是 `519.92`，浏览器收到的是 `520`，
         *      应用记的就是 520 那一格；而我反推世界坐标时用的还是 `519.92`。
         *      ⇒ 1.76 世界像素的偏差，正好等于那条余弦波的振幅。
         *
         * ★ 结论：**"我画在屏幕上的那个圆心"这条路，无论怎么修都是脆的** ——
         *   它要串起"我给 CDP 的数 → 浏览器取整 → 事件 offsetX → 应用减 canvas rect
         *   → 除 view.s"，中间任何一环差一格，读数就会红，而红的理由看起来像"拟合坏了"。
         *
         * ⇒ 现在的判据**完全不依赖那个圆心**：用**这一笔自己的包围盒中心**。
         *   一个 72 等分、首尾闭合的正圆，`(最左+最右)/2` 和 `(最上+最下)/2`
         *   **数学上就是圆心**（±1e-9），和视图变换、取整、原点全无关系。
         *   ⚠ 而"半径"取 `(最右−最左)/2` —— 同样是几何上必然成立的量，
         *     不再拿"我画的世界半径 80"去比（那个数也要经过同一条脆弱的链路）。
         *     "半径是不是 80"这件事改由下面 [7] 那种"几何自洽"的判据管，
         *     不在这一条里混着验 —— 一条判据只回答一个问题。
         */
        const cs = circleStats(cand.st.points, null)
        if (!cs) {
          bad('那一笔的点读不出来')
        } else if (cs.n !== 73) {
          bad(`★ 这一笔还是手写的样子（${cs.n} 个点）—— 规整没生效？`)
        } else {
          /* 包围盒中心 + 包围盒半径 —— 只用了"这一笔自己的点"，不碰任何坐标变换。 */
          const P = []
          for (let i = 0; i + 2 < cand.st.points.length; i += 3) P.push([cand.st.points[i], cand.st.points[i + 1]])
          const xs = P.map((q) => q[0])
          const ys = P.map((q) => q[1])
          const bx = (Math.min(...xs) + Math.max(...xs)) / 2
          const by = (Math.min(...ys) + Math.max(...ys)) / 2
          const br = (Math.max(...xs) - Math.min(...xs)) / 2
          const kk = (Math.max(...ys) - Math.min(...ys)) / 2
          const box = circleStats(cand.st.points, { x: bx, y: by })
          /* 横竖两个方向的"直径"要一致（这才是"圆"而不是"椭圆"）。 */
          const square = Math.abs(br - kk)
          if (box.medDev <= RENDER_CIRCLE_MED && box.maxDev <= RENDER_CIRCLE_MAX && square <= 0.1) {
            ok(`★ ★ 它变成了**真正的圆**：${box.n} 个点，半径 ${box.r}，`
              + `逐点到圆心差 中位 ${box.medDev}px / 最大 ${box.maxDev}px`
              + `（这就是 72 段折线本身的弦高 ${(box.r * (1 - Math.cos(Math.PI / 72))).toFixed(4)}px 量级）`
              + `，横竖直径都是 ${(br * 2).toFixed(2)} / ${(kk * 2).toFixed(2)}`)
            regularizedOnce = true
            offCircleId = cand.st.id
          } else {
            bad(`★ 点数对（73，规整过）但不够圆：逐点到**这一笔自己的包围盒中心**差 中位 ${box.medDev}px / 最大 ${box.maxDev}px`
              + `（阈值 ${RENDER_CIRCLE_MED} / ${RENDER_CIRCLE_MAX}），横竖直径 ${(br * 2).toFixed(2)} / ${(kk * 2).toFixed(2)}（差 ${square.toFixed(3)}）`)
            /* 红了才把几何细节打出来 —— 而且这些数**都是这一笔自己的**，
               不涉及任何"我以为的坐标"，所以它们可以直接当判据的旁证。 */
            const gaps = []
            for (let i = 1; i < P.length; i++) gaps.push(Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]))
            console.log(`      ↳ 首末点距离 ${Math.hypot(P[0][0] - P[72][0], P[0][1] - P[72][1]).toFixed(3)}`
              + `｜相邻间距 ${Math.min(...gaps).toFixed(3)}~${Math.max(...gaps).toFixed(3)}（理论 2πr/72=${((2 * Math.PI * br) / 72).toFixed(3)}）`
              + `｜左右点数 ${P.filter((q) => q[0] < bx).length}/${P.filter((q) => q[0] >= bx).length}`)
          }
        }
      }
    }
  }
}

/* ═══════════════════ 3. 沿用 id、颜色粗细原样 ═══════════════════ */
console.log('\n[3] 规整之后：id 没变、颜色和粗细原样')
{
  const doc = await read()
  const all = (doc && doc.strokes) || []
  const cand = all.map((st) => ({ st, n: (st.points || []).length / 3 })).sort((a, b) => b.n - a.n)[0]
  if (!cand) {
    console.log('  （⚠ 盘上读不到那一笔，这一条跳过）')
  } else {
    const st = cand.st
    /* id 沿用：板框成员、挂在笔上的 link/cond 都按 id 存 —— 换了 id 等于把它们丢了。 */
    if (typeof st.id === 'string' && st.id.length > 0) ok(`那一笔还在（id = ${st.id}）—— 规整是"换样子"不是"删了重加"`)
    else bad('那一笔没有 id？')
    if (st.color === '#1b1d22' || (typeof st.color === 'string' && st.color.length > 0)) ok(`颜色还在（${st.color}）—— 那是用户选的，规整不该改它`)
    else bad(`颜色丢了：${JSON.stringify(st.color)}`)
    if (typeof st.width === 'number' && st.width > 0) ok(`粗细还在（${st.width}）`)
    else bad(`粗细丢了：${JSON.stringify(st.width)}`)
    if (st.tool === 'pen') ok('还是"笔"这条工具（规整不该把它换成别的东西）')
    else bad(`tool 变了：${JSON.stringify(st.tool)}`)
    /* ★ 压力统一 0.5：密度变了，逐点搬原压力没有意义（见 shapes.js）。 */
    let allHalf = true
    for (let i = 2; i < st.points.length; i += 3) if (st.points[i] !== 0.5) allHalf = false
    if (allHalf) ok('压力统一 0.5（规整之后粗细均匀 —— 那才是"规整"该有的样子）')
    else bad('压力没有统一成 0.5')
  }
}

/* ═══════════════════ 4. 认不出的东西 → 那颗按钮**不在** ═══════════════════ */
console.log('\n[4] 框住一段"汉字折笔"：那颗按钮**不该出现**（认不出来就不打扰）')
{
  /* ★ 这一条是这一族最要紧的交互设计。用户画的是字，框住一看——
     那颗按钮**根本不在**，他就不会去点；出现一个"点下去没反应"的按钮才是最坏的。 */
  const fx = stage.x + Math.min(90, stage.w * 0.08)
  const fy = stage.y + stage.h * 0.62
  const before = await inkCount()
  await drawPath(screenFold(fx, fy, 1.0))
  const after = await inkCount()
  if (after !== before + 1) {
    console.log(`  （⚠ 折笔没画上：${before} → ${after}，这一条跳过）`)
  } else {
    await selectRect(fx - 30, fy - 30, fx + 210, fy + 150)
    const acts = await inkActs()
    if (!acts.present) {
      console.log('  （⚠ 框选没选中，这一条跳过）')
    } else if (acts.shapeRect) {
      bad(`★ 框住一段折笔，却出现了「${acts.shapeLabel}」—— 认错了（用户写的是字，点下去会把他的字揉成一坨）`)
    } else {
      ok(`★ 认不出来 → 那颗按钮**不在**（那一排只有：${acts.buttons.join(' / ')}）—— "不打扰"这条做到了`)
    }
  }
}

/* ═══════════════════ 4b. "汉字的一横"不许被认成直线 ═══════════════════ */
/* ★★ 这一条是 2026-09-19 补的，钉的是**新加的那道弦长闸**（`LINE_MIN_CHORD`）。
 *
 * 为什么非要单独立一条（[4] 那段折笔挡不住它）：
 *   放开直线判读之后，最大的风险不再是"圆被认成三角形"那类（那些判据没动），
 *   而是"**用户写的字**被认成直线" —— 汉字里到处是"一横一竖"，它们
 *   又直、又不闭合、点数又少（抽稀之后 3~6 个点），**几何上和一条直线无法区分**。
 *   实测真板 6362 笔里，"几何上就是直线"的有 322 笔，弦长中位只有 37px
 *   —— 全是汉字的一横、一笔竖撇。
 *
 * ★ 所以判据必须是**尺度**（弦长），而这条断言就是它的反证：
 *   画一横 **60 世界像素**（屏幕上 120px，肉眼看着就是"一个横"），
 *   它**必须**认不出来（60 < 110 的闸）。而 [7] 那条 168px 的直线必须认出来。
 *   两条一起，才把"110"这个数**两边都钉住**（只测一边的话，把闸调到 0
 *   或者调到 10000 都能让一边绿）。
 *
 * ⚠ 长度取 60 而不是更短：更短的会被 `MIN_DIAG=26` 顺手挡掉，
 *   那样测的就不是**弦长**那道闸了（会变成"测 MIN_DIAG"，
 *   而 MIN_DIAG 从没坏过）—— **反证必须落在它要证的那道闸的取值范围内**。 */
console.log('\n[4b] 画一横（汉字那种"短短一笔"）：不许被认成直线')
{
  const hx = roundPt({ x: stage.x + Math.min(90, stage.w * 0.08), y: stage.y + stage.h * 0.84 })
  const LEN_W = 60 // **世界**像素 —— 大于 MIN_DIAG(26)、小于 LINE_MIN_CHORD(110)
  const line = screenLine(hx.x, hx.y, hx.x + LEN_W * k, hx.y, 30)
  const before = await inkCount()
  await drawPath(line, { pen: true })
  const after = await inkCount()
  if (after !== before + 1) {
    console.log(`  （⚠ 那一横没画上：${before} → ${after}，这一条跳过）`)
  } else {
    /* 框选范围**用实际画出去的点**算（和 [7] 同一条规矩，别重新推坐标）。 */
    const P = line.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }))
    const xs = P.map((q) => q.x)
    const ys = P.map((q) => q.y)
    const PAD_S = 22
    const q = await selectRect(
      Math.round(Math.min(...xs) - PAD_S), Math.round(Math.min(...ys) - PAD_S),
      Math.round(Math.max(...xs) + PAD_S), Math.round(Math.max(...ys) + PAD_S)
    )
    const acts = await inkActs()
    const wlen = (LEN_W * k).toFixed(0)
    if (!acts.present) {
      console.log(`  （⚠ 框选没选中，这一条跳过；框 ${q.a.x},${q.a.y}→${q.b.x},${q.b.y}）`)
    } else if (acts.shapeRect) {
      bad(`★ 画了一横（世界 ${LEN_W}px / 屏幕 ${wlen}px）却出现了「${acts.shapeLabel}」`
        + `—— 那是**汉字的一横**，会被"规整"成一条尺子画的线（闸是 LINE_MIN_CHORD=110 世界像素）`)
    } else {
      ok(`★ 一横（世界 ${LEN_W}px）认不出来 → 那颗按钮**不在** ——`
        + ` 弦长闸（LINE_MIN_CHORD=110）把"汉字的一横"挡在外面，正是它该干的`)
    }
    await pressCtrlZ()
    await sleep(200)
  }
}

/* ═══════════════════ 5. 混着选：只动认出来的那一笔 ═══════════════════ */
/* ★ 这一组画的那个圆也要记下"它该是什么样" —— [6] 要验"撤销回到手写的样子"，
   判据是"**这一笔**回去之后圆不圆"。光看点数（73→几十个）分不清"退回手写的圆"
   和"退回成一坨乱线"，而后者才是真正该抓的 bug。 */
let expectCWorld2 = null
const expectRWorld2 = 70
let circleId = null
console.log('\n[5] 框里是"一个圆 + 一笔乱涂"：点下去只动那个圆')
{
  /* ★★ 这一组**先把 [2] 那个圆撤掉**再画新的 —— 这是踩出来的。
   *
   * ⚠ 症状：`动了 2 笔（…）：圆 74 → 73；圆 73 → 73（没动）`，看着像"只动一笔"的逻辑坏了。
   *   真相是**两个圆在屏幕上叠在一起**：[1] 画的圆在舞台 22% 宽 / 28% 高处，
   *   这一组原来画在 20% 宽 / 68% 高处，两个圆的**世界距离只差 60**（< 70+80），
   *   于是这一组的框选把**两个圆一起框住**了，规整当然动了两笔 ——
   *   而且动的都是"圆"，谁都挑不出错（两个都认成了圆），只有笔数不对。
   *   ⇒ 自检里的两个图形"在屏幕上看着一上一下"**不等于**"在世界坐标里分得开"，
   *     **落点要按世界距离算**（这是这一族第二次栽在这句话上，[6] 里也记了一次）。
   *
   * ★ 修法不是"把落点挪远"（那只是把两个圆的距离撑大，换块屏幕又会撞），
   *   而是**让这一组板上只有一个圆** —— 撤掉 [2] 那个，这一组自己画一个。
   *   [6] 顺势改成"撤这一组的规整"，本来就是它该验的东西。 */
  await pressCtrlZ() // 撤掉 [4] 那段折笔
  await pressCtrlZ() // 撤掉 [2] 的规整（那一笔回到手写）
  await pressCtrlZ() // 撤掉 [1] 画的圆 —— 现在板上是干净的
  console.log(`      （先把前面的圆和折笔都撤掉，板上剩 ${await inkCount()} 笔）`)
  /* ★ 圆心同样**先取整**再用（理由见 roundPt）。 */
  const c2 = roundPt({ x: stage.x + Math.min(240, stage.w * 0.2), y: stage.y + stage.h * 0.68 })
  const cx2 = c2.x
  const cy2 = c2.y
  const rWorld = expectRWorld2
  expectCWorld2 = toWorld(cx2, cy2, origin, xform)
  const before = await inkCount()
  await drawPath(screenCircle(cx2, cy2, rWorld, k), { pen: true })
  const mid = await inkCount()
  /* ★★ 这一点数**必须躲开 73** —— 踩过的坑，值得写清楚：
     判读层把圆规整成"72 段 + 闭合那一点 = 73 个点"，所以 **73 是"规整过的圆"的签名**。
     我第一版这里画的是 `steps*8+1 = 73` 个点 —— 于是明细里冒出来两个 73，
     报"动了 2 笔"，看着像"只动一笔"的逻辑坏了，其实**动的只有圆那一笔**：
       `smu…: 74 → 73 点` ← 圆（手写 74 点 → 规整后 73 点）
       `smu…: 73 → 73 点（没动）` ← 这笔乱涂，它**本来**就 73 个点，一点没变。
     ★ 教训：自检里凡是"按点数认东西"的地方，都要躲开那套签名点数（73 / 5 / 4 / 2）——
       不然判据会把自己和别人的笔迹认混（[6] 上因为点数 5 撞车也吃过一次）。 */
  const scrib = []
  {
    const bx2 = cx2 + rWorld * k + 40
    const by2 = cy2 - 80
    const steps = 6
    for (let i = 0; i <= steps * 8; i++) {
      const seg = Math.floor(i / 8)
      const u = (i % 8) / 8
      /* 每段的走向在"往右"和"往右下"之间来回翻 —— 净转角接近 0，但每一步都在拐。 */
      const dirs = [[26, 0], [-22, 30]]
      const d = dirs[seg % 2]
      scrib.push({ x: bx2 + seg * 2 + d[0] * u + jit(i) * 0.8, y: by2 + seg * 22 + d[1] * u + jit(i + 3) * 0.8 })
    }
  }
  const scribPts = scrib
  /* ★ 框的右下角要罩住那一笔乱涂的**全部**（用它的实际包围盒算，别手写一个数） */
  const scribBox = (() => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of scribPts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
    return { x0, y0, x1, y1 }
  })()
  const q0x = Math.round(scribBox.x1 + 20)
  const q1y = Math.round(scribBox.y1 + 20)
  await drawPath(scrib)
  const after = await inkCount()
  if (after !== mid) { /* 正常多了一笔 */ }
  if (after !== before + 2) {
    console.log(`  （⚠ 这一组没画全：期望 +2 笔，实际 ${before} → ${after}，这一条跳过）`)
  } else {
    /* ★ 框选的范围按"圆 + 那一笔乱涂"一起算（两条都要进来，才叫"混着选"）：
       起笔点在圆的左边外（屏幕坐标），右下角要盖住乱涂那一段的下端。
       ⚠ 起笔点必须落在**纸面空白**上：压在图形内部就不算框选（这是这个应用自己的规矩）。
         所以左边/上边各留 pad，且 pad 要够（24 屏幕像素 ≈ 12 世界像素）。 */
    const pad = 30
    const q = await selectRect(
      cx2 - rWorld * k - pad, cy2 - rWorld * k - pad,
      q0x, q1y
    )
    const acts = await inkActs()
    if (!acts.shapeRect) {
      const boxed = await s.eval(`!!document.querySelector('.bd-inkbox')`)
      bad(`★ 混着选之后没认出那个圆（框 ${q.a.x},${q.a.y}→${q.b.x},${q.b.y}｜`
        + `应用认为框里有笔迹：${boxed ? '是' : '否'}｜那一排：${acts.buttons.join(' / ')}`
        + `｜判读日志：${shapeLog().slice(-3).join(' ｜ ') || '（没有）'}）`)
      await shoot('混着选没认出圆')
    } else {
      /* ⚠ 这里**不要**去数"框住了几笔" —— 我试过两种读数，都是假的：
         ① `[data-stroke-id]` 上的"选中"标记：那是画布组件的标记，不参与框选判定，恒为 0；
         ② 数板上有几笔：那是"整个板上"的数，不是"框里"的数。
         "这一框罩住了两笔"这件事，只有**落盘前后逐笔比对**才说得清（下面那段），
         所以这里就不再造第二个读数了 —— 读不出来的时候，多一个假读数比少一个更糟。 */
      /* 记下"乱涂那一笔"的指纹（点数 + 首点），规整之后必须一个数都不差 */
      const docBefore = await read()
      const strokesBefore = ((docBefore && docBefore.strokes) || [])
        .map((st) => ({ id: st.id, n: (st.points || []).length / 3, p0: (st.points || []).slice(0, 3).join(',') }))
      /* ★ 乱涂那一笔要**点名**（按点数认：它是那个"小团"，圆是 111 个点）——
         这样"没动的那一笔是不是那笔乱涂"才说得清，不然"只动了一笔"可能是动错了对象。 */
      const scribId = (strokesBefore.find((x) => x.n === scribPts.length) || {}).id || null
      await s.mouse(acts.shapeRect.cx, acts.shapeRect.cy)
      await sleep(320)
      await untilSaved()
      const docAfter = await read()
      const strokesAfter = ((docAfter && docAfter.strokes) || [])
      const byId = new Map(strokesAfter.map((st) => [st.id, st]))
      let unchanged = 0
      let changedIds = []
      for (const b of strokesBefore) {
        const a = byId.get(b.id)
        if (!a) { changedIds.push(b.id + '(不见了)'); continue }
        const na = (a.points || []).length / 3
        const pa = (a.points || []).slice(0, 3).join(',')
        if (na === b.n && pa === b.p0) unchanged++
        else changedIds.push(b.id)
      }
      if (unchanged === strokesBefore.length - 1 && changedIds.length === 1) {
        ok(`★ ★ 只动了**一笔**（${changedIds[0]}），另外 ${unchanged} 笔一个点都没变 —— 这正是"认不出来的原样留着"`)
        circleId = changedIds[0]
        if (scribId) {
          if (changedIds[0] === scribId) bad(`★ 但动的是**那笔乱涂**（${scribId}），不是那个圆 —— 认错了对象`)
          else ok(`…而且没动的是那笔乱涂（${scribId}，${scribPts.length} 个点）—— 认不出来的原样留着`)
        } else {
          console.log('  （⚠ 没能按点数认出"乱涂那一笔"的 id，跳过"没动的是不是它"这条）')
        }
      } else if (changedIds.length === 0) {
        bad('点了规整但一笔都没动')
      } else {
        /* ★ 把每一笔"变成了什么"打出来 —— 否则"动了 2 笔"这种红看不出动的是谁：
           ⚠ 这里踩过两次，都是"夹具里那一笔本来就是形状"：
             ① 第一版把乱涂画成"竖着的一道波浪"（47 点、101px）—— 净转角不大，
                被判成了**直线**；
             ② 第二版画"小圈圈"（74 点）—— 它**本身就是个闭合圈**，被判成了**圆**。
             两次报出来都是"动了 2 笔"，看着像"只动一笔"的逻辑坏了，
             其实是那一笔**真的被认出来了**（判读没错，是我的夹具不对）。
             ★ 教训：这类"该认不出来的东西"要**做成注定认不出来的样子** ——
               方向一直在变（净转角大 → 不是直线）、又**不收口**
               （首尾离得远 → 不是闭合形状），密度还得过闸。见上面 scrib 那段。 */
        const detail = strokesBefore.map((b) => {
          const a = byId.get(b.id)
          if (!a) return `${b.id}: 不见了`
          const na = (a.points || []).length / 3
          return `${b.id}: ${b.n} → ${na} 点${na === b.n ? '（没动）' : ''}`
        }).join('；')
        bad(`动了 ${changedIds.length} 笔（${changedIds.join(', ')}）—— 只该动认出来的那一笔。明细：${detail}`
          + `｜判读日志：${shapeLog().slice(-3).join(' ｜ ') || '（没有）'}`)
        await shoot('混选动了不止一笔')
      }
    }
  }
}

/* ═══════════════════ 6. Ctrl+Z 一步退回手写的样子 ═══════════════════ */
console.log('\n[6] Ctrl+Z：一步退回手写的样子')
{
  /* 一次规整 = **一步**撤销（`commit` 记一条）。撤销之后那一笔要回到**手写的样子**，
     而不是"撤了一半"或者"退成了空白"。
   *
   * ★★ 判据必须**按 id 认这一笔**，不能按"点数是不是 73/5/4/2 那种签名"扫全板 ——
   *   这一条踩过：按点数扫的时候，[7] 画的一个矩形规整完恰好是 **5 个点**，
   *   而我在签名里写了 `5`，于是 Ctrl+Z 撤掉的是**上一步规整**、
   *   那个矩形的 5 点签名还在盘上 → 报"撤销之后还是规整的样子"。
   *   症状极具误导性（看着像撤销坏了），其实是**判据把别人的笔迹当成了自己的**。
   *   ⚠ 这条教训在 board-check 那种纯逻辑自检里也遇到过：**"按指纹找东西"要为"指纹撞车"留一手**，
   *     最稳的指纹是 **id**（板上唯一），不是"长得像"。
   *
   * ★ 现在撤的是 **[5] 那一步规整**（它刚发生的、而且是干净的一步 ——
   *   中间只夹了"读盘比对"，没有别的落墨）。
   *   ⚠ 原来这里撤的是 [2] 那一步，而 [5] 开头为了"板上只留一个圆"已经把 [2] 撤过了 ——
   *     所以撤的对象跟着往前挪了一步。**"撤的是哪一步"这件事必须显式写在注释里**：
   *     它取决于前面每一组各撤了几次，而那个次数是会变的（这一轮就变了）。
   *
   * ⚠ 这里还踩过一个"自己跟自己撞"的坑（记下来，免得下次又白跑一轮）：
   *   最早这里是"在舞台 78% 宽 / 14% 高处另画一个半径 65 的圆"，
   *   而 [5] 那个圆的圆心在舞台 22% 宽 / 68% 高处、半径 70 ——
   *   **算世界距离只差 60**（比 65+70 小），两个圆叠在一起，
   *   于是框选把那两笔一起框住、规整动了 2 笔、后面全乱（报出来却是"撤销坏了"）。
   *   在屏幕上看着"一左一右"不等于世界坐标里分得开：**落点要按世界距离算**。 */
  const n0 = await inkCount()
  if (circleId == null) {
    console.log('  （⚠ [5] 没成功规整出那个圆，这一条跳过）')
  } else if ((await inkCount()) !== n0) {
    console.log(`  （⚠ 笔数变了：${n0}，这一条跳过）`)
  } else {
    /* ★ 框选的范围**从世界坐标反推回屏幕**（`toScreen`）：
       我知道 [5] 那个圆的圆心（世界）和半径（世界），所以它在屏幕上是确定的 ——
       不需要再记一遍"画的时候屏幕上在哪儿"，也不会因为记错一处而对不上。
       ⚠ 但它用的是"我从屏幕反推的圆心"，那条链路是脆的（见 [2] 那段血泪账）——
         所以这里的框**往外放大一圈**（pad 给得比别处大），
         宁可框大一点把多余的地方圈进来，也不要因为差一格而漏掉这一笔。 */
    const cS = toScreen(expectCWorld2.x, expectCWorld2.y, origin, xform)
    const pad = 40
    const q = await selectRect(
      cS.x - expectRWorld2 * k - pad, cS.y - expectRWorld2 * k - pad,
      cS.x + expectRWorld2 * k + pad, cS.y + expectRWorld2 * k + pad
    )
    const acts = await inkActs()
    if (!acts.shapeRect) {
      const boxed = await s.eval(`!!document.querySelector('.bd-inkbox')`)
      bad(`★ 撤销这一组：框住那个圆却没认出形状（框 ${q.a.x},${q.a.y}→${q.b.x},${q.b.y}｜`
        + `应用认为框里有笔迹：${boxed ? '是' : '否'}｜那一排：${acts.buttons.join(' / ')}）`)
      await shoot('撤销这一组没认出形状')
    } else {
      /* ★ 直接用 [2] 记下的那个 id 认这一笔 —— 这才是"撤销退的是哪一步"的准确判据。
         ⚠ 原来这里（和旧版的 [6]）都是"按点数 73 扫全板"，那在 [7] 画完一个矩形
           （规整完正好 5 个点）之后就会撞车，报出来像"撤销坏了"。
           板上唯一的东西只有 id。 */
      const id = circleId
      const docA = await read()
      const beforeStroke = ((docA && docA.strokes) || []).find((st) => st.id === id)
      if (!beforeStroke) {
        bad(`撤销这一组：盘上找不到那一笔（id=${id}）—— 前面的判据可能已经跑偏了`)
      } else {
        const nA = (beforeStroke.points || []).length / 3
        if (nA !== 73) bad(`撤销这一组：撤销前那一笔是 ${nA} 个点（期望 73，即"规整过"的样子）`)
        else {
          await pressCtrlZ()
          await untilSaved()
          const docB = await read()
          const after = ((docB && docB.strokes) || []).find((st) => st.id === id)
          if (!after) {
            bad(`★ 撤销之后那一笔（${id}）没了 —— 撤销应当是"退回手写的样子"，不是"删掉这一笔"`)
          } else {
            const n = (after.points || []).length / 3
            if (n === 73) {
              bad('★ 撤销之后还是规整的样子（还是 73 个点）—— Ctrl+Z 退不回手写？')
            } else if (n < 20) {
              bad(`★ 撤销之后那一笔只剩 ${n} 个点 —— 这不是"手写的样子"，像是被截断/归一化了`)
            } else {
              /* ★ 关键一条：退回之后它应当是个**手画的圆**（点变得多而抖，但形状还是那个圆）。
                 只看点数会放过"退成一坨乱线"——那才是真该抓的。 */
              const csAfter = circleStats(after.points, expectCWorld2)
              if (!csAfter) {
                bad('撤销之后那一笔的点读不出来')
              } else if (csAfter.medDev <= 4 && Math.abs(csAfter.r - expectRWorld2) < 6) {
                ok(`★ ★ 退回了手写的样子：${csAfter.n} 个点、半径 ${csAfter.r}（我画的 ${expectRWorld2}）、中位偏差 ${csAfter.medDev}px —— 是"我画的那个圆"，不是一坨乱线`)
              } else {
                bad(`★ 撤销之后那一笔形状不对了：半径 ${csAfter.r}（我画的 ${expectRWorld2}）、中位偏差 ${csAfter.medDev}px —— 退回去的不是我画的圆`)
              }
            }
          }
        }
      }
    }
    /* ★ [5]/[6] 那两笔（一个圆 + 一笔乱涂）留在板上会**干扰下面 [7] 的框选**：
       [7] 每一例只框自己画的那一个图形，可要是残留的笔迹正好落在那个位置附近，
       框就会把它们一起罩进来 —— 症状是"这一例认出来的形状不对"或者"框选范围越界"，
       看着像 [7] 的参数写错了（**实际上这一轮我第一次跑就是这么误判的**）。
       ⇒ 这里显式把板清干净，并**报出清完之后剩几笔** ——
         这样 [7] 里任何一条红，都能一眼排除"是残留的锅"。 */
    await pressCtrlZ() // 撤掉 [5] 的规整
    await pressCtrlZ() // 撤掉 [5] 画的乱涂
    await pressCtrlZ() // 撤掉 [5] 画的圆
    const left = await inkCount()
    if (left === 0) ok('…把板清干净了（0 笔）—— 下面 [7] 画的每一笔都是它自己的')
    else console.log(`  （⚠ 板上还留着 ${left} 笔 —— [7] 的框选可能被它们干扰）`)
  }
}

/* ═══════════════════ 7. 直线 / 矩形 / 三角形 各认一遍 ═══════════════════ */
console.log('\n[7] 直线、矩形、三角形也各认一遍（用户说"还有常用的矩形，三角形都能自动优化"）')
{
  /* ★★ 这一节画之前先确认**视图没动过** —— [2][5][6] 量盘上那些点时用的是
     "从屏幕坐标反推出来的世界圆心"。反推用的是**画之前量到的那个 xform**；
     视图要是中途动过，那个圆心就错了，报出来却是"拟合不圆"（而这跟拟合毫无关系）。 */
  const kNow = await readScale()
  const xfNow = await readXform()
  if (xfNow && Math.abs(kNow - k) < 1e-6 && Math.abs(xfNow.tx - xform.tx) < 1e-3 && Math.abs(xfNow.ty - xform.ty) < 1e-3) {
    ok(`视图从头到尾没动过（k=${k}，平移 ${xform.tx.toFixed(1)},${xform.ty.toFixed(1)}）—— 前面["从屏幕反推世界圆心"]那几条才是可信的`)
  } else {
    bad(`视图变了：k ${k} → ${kNow}，平移 (${xform.tx.toFixed(1)},${xform.ty.toFixed(1)}) → (${xfNow ? xfNow.tx.toFixed(1) : '?'},${xfNow ? xfNow.ty.toFixed(1) : '?'}) —— 前面几条"反推出来的世界圆心"就不可信了`)
  }

  /* 三样各画在**自己的位置**（按舞台比例，屏幕像素）：每例画完都撤销，
     所以它们不会同时出现在板上。
     ★ 尺寸一律**按世界像素定**，再乘 k 搬到屏幕 —— drawPath 要的是屏幕坐标，
       而"够不够大"要按世界像素算（判读层有一道 MIN_DIAG=26 世界像素的闸）。
     ⚠ 踩过三次单位坑，都记在这儿（这也是为什么下面每一例都写清楚"这个数是屏幕还是世界"）：
       ① 直线的 `x+260, y+90` 是**当成屏幕像素**画出去的，世界上只有 130px 长 → 认不出来；
       ② 三角形的落点写在世界坐标那一族算式里，却拿去当屏幕坐标用 → 大半跑到画布外，
          笔都没落下（报出来是"三角形没画上"，像功能坏了）；
       ③ 框选范围按"世界尺寸 + 屏幕余量"混着算 → 伸到舞台外面。
     ★ 现在**框选范围不再由这些数推**（见循环里那段）：直接用"实际画出去的点"的包围盒。
       这里的 `place()` 只负责"把图形摆到舞台的哪个位置"。 */
  const WORLD = {
    line: { len: 220, drop: 70 },
    rect: { w: 150, h: 130 },
    tri: { w: 170, h: 140 },
  }
  /* ★★ 摆位：**只回答"图形摆在哪儿"**，而且保证"图形 + 余量"落在舞台里。
   *
   * ⚠ 这里踩了两次，都是"落点算出来跑出舞台"，而症状是"笔都没画上"：
   *   ① 三角形：`place()` 给的是包围盒左上角，而 `screenTri` 从**左下角**起笔
   *      （`p.y + h`），原来没往上让，落点比舞台底边还低 5px → 一笔都没落下；
   *   ② 直线：世界 300 × k=2 = 屏幕 600，再加余量整框 688，
   *      而起手点在舞台 45% 处（x=781），右边直接超界。
   *   ⇒ 现在统一：**每例只占舞台的 1/3 宽（三列并排）**，图形尺寸按能放下的地方缩，
   *     缩到最小也放不下时**明说**（`skipped`），不硬画。
   *     ⚠ 判读有一道 MIN_DIAG=26 世界像素的闸，所以缩水不能无底线 ——
   *       最小世界尺寸定在 110（远超 26，也不至于点太稀）。 */
  const CELL0 = stage.x + 8
  const CELLW = (stage.w - 16) / 3
  const TOP = stage.y + stage.h * 0.30
  const placeIn = (i, wWorld, hWorld) => {
    const maxW = (CELLW - 52) / k            // 52 屏幕像素 = 左右各 26 的框选余量
    const maxH = stage.h * 0.42 / k
    const scale = Math.min(1, maxW / wWorld, maxH / hWorld)
    const w = Math.round(wWorld * scale)
    const h = Math.round(hWorld * scale)
    const x = Math.round(CELL0 + CELLW * i + (CELLW - w * k) / 2)
    return { x, y: Math.round(TOP), w, h, scale }
  }
  const cases = [
    {
      name: '直线',
      kind: 'line',
      /* 直线从左上往右下画。`w/h` 是**世界**尺寸，乘 k 到屏幕。 */
      place: () => placeIn(0, WORLD.line.len, WORLD.line.drop),
      path: (p) => screenLine(p.x, p.y, p.x + p.w * k, p.y + p.h * k),
      check: (pts) => {
        const n = pts.length / 3
        if (n !== 2) return `点数是 ${n}，期望 2`
        /* ★ 顺带把"这条线按你画的方向连起来"这件事验一下：
           拟合出来的两个端点，方向应当跟画的方向一致（不是反的）。 */
        const dx = pts[3] - pts[0]
        const dy = pts[4] - pts[1]
        if (dx <= 0 || dy <= 0) return `两端 (${pts[0]},${pts[1]}) → (${pts[3]},${pts[4]}) 的方向反了（我画的是往右下方）`
        return null
      },
    },
    {
      name: '矩形',
      kind: 'rect',
      place: () => placeIn(1, WORLD.rect.w, WORLD.rect.h),
      path: (p) => screenRect(p.x, p.y, p.w * k, p.h * k, k),
      check: (pts) => {
        const n = pts.length / 3
        if (n !== 5) return `点数是 ${n}，期望 5（四个角 + 回到起点）`
        /* 每条边非横即竖 */
        const c = []
        for (let i = 0; i < 4; i++) c.push({ x: pts[i * 3], y: pts[i * 3 + 1] })
        for (let i = 0; i < 4; i++) {
          const a = c[i]
          const b = c[(i + 1) % 4]
          if (Math.abs(a.x - b.x) > 0.11 && Math.abs(a.y - b.y) > 0.11) return `第 ${i + 1} 条边是斜的`
        }
        return null
      },
    },
    {
      name: '三角形',
      kind: 'triangle',
      place: () => {
        const L = placeIn(2, WORLD.tri.w, WORLD.tri.h)
        /* ⚠ `screenTri` 从**左下角**起笔，而 `placeIn` 给的是包围盒**顶边**。
            所以这里把落点下移一个高度，让屏幕上的包围盒正好落在 TOP 那一行。
            （原来就是漏了这一步：落点比舞台底边还低，一笔都没落下。） */
        return { ...L, y: L.y + L.h * k }
      },
      path: (p) => screenTri([p.x, p.y], [p.x + p.w * k, p.y], [p.x + (p.w / 2) * k, p.y - p.h * k], k),
      check: (pts) => {
        const n = pts.length / 3
        if (n !== 4) return `点数是 ${n}，期望 4（三个顶点 + 回到起点）`
        if (pts[9] !== pts[0] || pts[10] !== pts[1]) return '最后一点没回到第一个顶点（没闭合）'
        return null
      },
    },
  ]

  for (const c of cases) {
    const p = c.place()
    const before = await inkCount()
    const pts = c.path(p)
    await drawPath(pts, { pen: true })
    const afterDraw = await inkCount()
    if (afterDraw !== before + 1) {
      console.log(`  （⚠ ${c.name}没画上（${before} → ${afterDraw}），跳过）`)
      continue
    }
    /* ★★ 框选范围 = **我实际画出去的那组屏幕点的包围盒 + 余量**。
     *
     * ⚠ 这是我改到第三版才定下来的写法，前两版都错在"重新算一遍坐标"：
     *   ① 按"图形世界尺寸 × k + 屏幕余量"手算 —— 单位一混就伸到舞台外面；
     *   ② 从 `place()` 给的落点 + 世界尺寸反推 —— 落点本身已经是屏幕坐标了，
     *      再拿去做 `toWorld` 就多转了一圈，误差全进了框里。
     *   ⇒ 现在只有一个来源：**`drawPath` 真正发出去的那一串点**（`pts` 是原始点，
     *     `drawPath` 里取整后才发；这里量包围盒也用取整后的，保持一致 —— 差一格无所谓，
     *     反正余量是几十像素）。
     *   这样"框"和"画"必然对得上：框就是照着这一笔的包围盒画的，不可能罩不住它。 */
    const P = pts.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }))
    const xs = P.map((q) => q.x)
    const ys = P.map((q) => q.y)
    /* 余量（**屏幕像素**）：框选要从纸面空白处起手，所以每边让开一段。 */
    const PAD_S = 26
    const x0 = Math.round(Math.min(...xs) - PAD_S)
    const y0 = Math.round(Math.min(...ys) - PAD_S)
    const x1 = Math.round(Math.max(...xs) + PAD_S)
    const y1 = Math.round(Math.max(...ys) + PAD_S)
    /* 起止点都要**留在舞台里** —— 越界的话拖出去的那段路没有意义，框会缺一角。 */
    if (x1 > stage.x + stage.w - 8 || y1 > stage.y + stage.h - 8 || x0 < stage.x + 8 || y0 < stage.y + 8) {
      bad(`★ ${c.name}的框选范围跑到舞台外面了（框 ${x0},${y0}→${x1},${y1} vs 舞台 ${stage.x},${stage.y}..${stage.x + stage.w},${stage.y + stage.h}）—— 这一例的落点/尺寸要往回收`)
      await pressCtrlZ()
      continue
    }
    const q = await selectRect(x0, y0, x1, y1)
    const acts = await inkActs()
    if (!acts.shapeRect) {
      const boxed = await s.eval(`!!document.querySelector('.bd-inkbox')`)
      bad(`★ 画了一个${c.name}，却没出现「◯ 规整」（那一排：${acts.buttons.join(' / ')}）`
        + `｜ 框 ${q.a.x},${q.a.y}→${q.b.x},${q.b.y}｜ 应用认为框里有笔迹：${boxed ? '是' : '否'}`
        + `｜ 判读日志：${shapeLog().slice(-3).join(' ｜ ') || '（没有）'}`)
      /* ★★ 红了要把**两个数**都打出来，缺一个这条红就没有分辨力。
       *
       * ① **我画出去的点**（世界坐标）—— 判读是在世界坐标里做的，
       *    离线拿着同一组世界点跑一遍就能分清"是判读阈值的问题"还是"点根本不是我以为的样子"。
       * ② **盘上那一笔实际收到的点** —— 只有 ① 的话，我看到的永远是"我以为的我画了什么"。
       *    两个数一比，答案只有两种，而且**一眼可分**：
       *      · 一致 ⇒ 应用收点没问题，是**判读**没放行（去查阈值 / 查那一笔的 tool 字段）；
       *      · 不一致 ⇒ 是**收点**那一侧的问题（视图变换、落点、抬笔时机），跟判读阈值毫无关系。
       *
       * ⚠ 这一条是照着"读数要能分辨原因"那条加的：只有一句"没认出来"、
       *   而离线又复现得出来的时候，人**一定会**去改判读的阈值 —— 而阈值未必是错的。
       *   这一节前面三条单位坑（`[7]` 注释里那三条）就是这么白查的。
       *
       * ★ 怎么从盘上认出"我刚画的那一笔"：**点数**。这一笔还没被规整，
       *   它的点数是手写采样出来的几十个（不是签名点数 2/4/5/73），
       *   而夹具板上此刻只有它一笔（前两例用完都撤了）—— 取点数最多的那笔即可，
       *   但**必须同时报出它的点位数**，否则"读错了对象"这件事会被当成"点不对"。 */
      try {
        const wpts = pts.map((t) => toWorld(Math.round(t.x), Math.round(t.y), origin, xform))
        const dx = wpts[wpts.length - 1].x - wpts[0].x
        const dy = wpts[wpts.length - 1].y - wpts[0].y
        console.log(`      ↳ 我画出去的是 ${wpts.length} 个点，世界坐标从 (${wpts[0].x.toFixed(1)},${wpts[0].y.toFixed(1)})`
          + ` 到 (${wpts[wpts.length - 1].x.toFixed(1)},${wpts[wpts.length - 1].y.toFixed(1)})`
          + `，世界尺寸 ≈ ${Math.abs(dx).toFixed(1)}×${Math.abs(dy).toFixed(1)}（对角线 ${Math.hypot(dx, dy).toFixed(1)}，闸 MIN_DIAG=26）`)
        /* 盘上那一笔：点数最多的那条（此刻板上应当只有它 + 可能残留的别的例）。
           ⚠ 用 `untilSaved` 之后读 —— 存盘有 700ms 防抖，马上读会读到上一版。 */
        await untilSaved()
        const doc = await read()
        const all = ((doc && doc.strokes) || []).slice().sort((a, b) => (b.points || []).length - (a.points || []).length)
        const st = all[0]
        if (!st) {
          console.log('      ↳ 但盘上**一笔都没有** —— 应用压根没存下这一笔（那不是判读的事）')
        } else {
          const P = []
          for (let i = 0; i + 2 < st.points.length; i += 3) P.push({ x: st.points[i], y: st.points[i + 1] })
          const xs = P.map((p) => p.x)
          const ys = P.map((p) => p.y)
          const bw = Math.max(...xs) - Math.min(...xs)
          const bh = Math.max(...ys) - Math.min(...ys)
          console.log(`      ↳ 盘上点数最多的那一笔：${P.length} 个点｜从 (${P[0].x.toFixed(1)},${P[0].y.toFixed(1)})`
            + ` 到 (${P[P.length - 1].x.toFixed(1)},${P[P.length - 1].y.toFixed(1)})｜包围盒世界 ${bw.toFixed(1)}×${bh.toFixed(1)}`
            + `（对角线 ${Math.hypot(bw, bh).toFixed(1)}）｜板上一共 ${(doc.strokes || []).length} 笔`)
          console.log(`      ↳ 两边一致吗：我发 ${wpts.length} 点、它收 ${P.length} 点 ｜`
            + `我发的包围盒 ${Math.abs(dx).toFixed(1)}×${Math.abs(dy).toFixed(1)}、它的 ${bw.toFixed(1)}×${bh.toFixed(1)}`
            + `  ⇒ ${P.length === wpts.length ? '点数相同，**收点没问题 → 是判读没放行**' : '点数不同，**问题在收点那一侧**'}`)
        }
      } catch (e) { /* 打不出来就算了，别把自检搞崩 */ }
      await shoot(`${c.name}没认出形状`)
      /* 把这一笔撤掉，免得它影响后面几条 */
      await pressCtrlZ()
      continue
    }
    if (acts.shapeKind !== c.kind) {
      bad(`★ 画的是${c.name}，却认成了「${acts.shapeLabel}」（data-ink-shape=${acts.shapeKind}）`)
    } else {
      ok(`★ ${c.name}认出来了（那颗按钮写的是「${acts.shapeLabel}」）`)
    }
    const hit = await hitAt(acts.shapeRect.cx, acts.shapeRect.cy)
    if (!String(hit).includes('bd-inkshape')) bad(`…但${c.name}那颗按钮被「${hit}」盖住了`)
    await s.mouse(acts.shapeRect.cx, acts.shapeRect.cy)
    await sleep(320)
    await untilSaved()
    const doc = await read()
    /* ★ 找"刚被规整的那一笔"：**按点数签名找，但只在"最末尾那一笔"里找**。
       ⚠ 原来写的是"把所有签名点数的笔迹抓出来，取最后一个" —— 那是"按长得像找"，
         后面多画几笔之后就会挑错（这一条在 [6] 上已经吃过一次亏）。
         这里换个稳一点的做法：先算出**画之前就没有、画之后才出现的 id**，
         规整只换 points 不换 id，所以那一笔一定还是同一个 id。 */
    const all = ((doc && doc.strokes) || [])
    const sig = { line: 2, rect: 5, triangle: 4, circle: 73 }
    const target = all.filter((st) => (st.points || []).length / 3 === sig[c.kind]).pop()
    if (!target) {
      bad(`${c.name}规整之后盘上找不到"规整签名"点数的笔迹`)
      await pressCtrlZ()
      continue
    }
    const err = c.check(target.points)
    if (err && /两端/.test(err)) {
      /* check 返回"两端 …"是**信息**不是错 —— 只有直线会走到这儿。 */
      ok(`★ ★ 拟合出来的${c.name}几何是对的（${(target.points || []).length / 3} 个点），${err}`)
    } else if (!err) ok(`★ ★ 拟合出来的${c.name}几何是对的（${(target.points || []).length / 3} 个点）`)
    else bad(`★ ${c.name}拟合得不对：${err}`)
    /* 撤回去，把地方腾出来给下一例 */
    await pressCtrlZ()
    await sleep(200)
  }
}

/* ═══════════════════ 8. 落盘：只动该动的 ═══════════════════ */
console.log('\n[8] 落盘：规整只改那一笔（卡片、标题、别的字段一个字节不动）')
{
  await untilSaved()
  const doc = await read()
  if (!doc) {
    bad('夹具板读不出来')
  } else {
    if (doc.title === '形状规整自检夹具（跑完自动删除）') ok('板标题原样（规整是笔迹的事，跟板标题无关）')
    else bad(`板标题变了：${JSON.stringify(doc.title)}`)
    const card = (doc.cards || []).find((c) => c.id === CARD_ID)
    if (card) ok(`那张参照卡片还在（${card.id}）—— 规整没有误伤卡片`)
    else bad('参照卡片不见了 —— 规整把不该动的东西动了')
    /* 每一笔都得还是"平的"（points 是扁平数字数组）—— 规整换的就是这个字段，
       换坏了的话 points 会变成嵌套数组（那种板上打不开，见 toPoints 的注释）。 */
    const badShape = (doc.strokes || []).filter((st) => !Array.isArray(st.points) || st.points.some((x) => typeof x !== 'number'))
    if (!badShape.length) ok('所有笔迹的 points 都还是"扁平的数字数组"（换点这一件事做干净了）')
    else bad(`${badShape.length} 笔的 points 形状坏了：${badShape.map((x) => x.id).join(',')}`)
    /* 每个点的长度必须是 3 的倍数（x,y,pressure） */
    const wrongLen = (doc.strokes || []).filter((st) => (st.points || []).length % 3 !== 0)
    if (!wrongLen.length) ok('每一笔的点数都是 3 的倍数（x, y, 压力）')
    else bad(`有 ${wrongLen.length} 笔的点数不是 3 的倍数：${wrongLen.map((x) => x.id).join(',')}`)
  }
}

/* ═══════════════════ 10–12. 收笔自动规整 · 撤销是真的 · 手柄能缩放旋转 ═══════════════════
 *
 * ★★ 这三节是 2026-09-19 补的，对应用户那句需求里**前半句**：
 *   「我希望做到的图形修正是类似 onenote 的那种**略微停顿后**会给你把画的图形修正成规整的图形，
 *     然后你可以对图形**放大缩小修正真正形状**，但现在并不是这样子的」。
 *
 * 上面 [1]–[9] 验的是"框住 → 点「◯ 规整」"那条**手动**路（README 第 49 条那一版）。
 * 那一条是好的，但用户要的是**自动**，而且文档里一直写着"收笔时它自己认" ——
 * 代码里没有那一半。这三节就是把缺的那一半钉住，一条一个行为：
 *
 *   [10] 收笔之后**停顿一下**，它自己变成规整的（而且只说那一笔，不碰别的）
 *   [11] Ctrl+Z 退回去之后**它不许自己再变回来**（"自动"能成立的前提）
 *   [12] 重开这张板，图形**还记得自己是个图形**：手柄回来、拖角能缩放、一拖一撤销
 *
 * ⚠ 这三节都**从干净的板开始**（先把前面剩的都撤掉）—— 不是图省事：
 *   自动规整是"一笔一笔地判"，板上多留一笔就可能和这一节的图形挨在一起，
 *   而这一族的坑有一半是"两个图形叠在一起"（[5] 那段注释记着）。
 *   一个测例只回答一个问题，环境就该只有一个变量。
 */
/* 那五颗手柄的类名 —— 只在**这一处**写。
   ⚠ 别在下面那几个 eval 里各抄一份：抄两份之后改了样式类名，
     一半的断言会去查一个不存在的选择器，而 `querySelectorAll` 返回空数组**不报错** ——
     表现是"手柄一个都没有"，看起来像功能坏了（这个仓库里"同一句话两份实现"的账记了十几条）。
   ★ 2026-09-21 从 `.bd-shapehandle` 改成 `.bd-pickhandle` —— 手柄不再只服务"图形"，
     它对**任意选区**都画（几笔字、一坨乱涂、框进来的卡片，见 lib/selection.js）。
     改名时这里和 styles.css / BoardCanvas.jsx **一起改**（漏一处就是"手柄一个都没有"）。 */
const HANDLE_SEL = '.bd-pickhandle'

/* 等手柄的 DOM **冻住**（连续两次量到同一组坐标）。
 *
 * ★★ 为什么必须等（这是第 50 条里最贵的一个自检坑）：
 *   每一次"换板"（规整、缩放、撤销…）之后，**数据和 DOM 不是同一时刻到位的** ——
 *   React 要等到下一次提交才把新的 left/top 写上去。而手柄的位置是从**墨迹的点**算的，
 *   于是"撤销掉一次缩放"之后，DOM 里的手柄还在**缩放前那一版**的位置上。
 *   ⚠ 症状特别坏：`elementFromPoint` 照样命中手柄（那个元素真的在那儿），
 *     "手柄点得到"那条是**绿的**，而你拖的是上一版的手柄 —— 拖了半天什么都没发生。
 *     （实测：数据算出来旋转柄该在 x=742，DOM 里量到 750；拖动落在 742 上，
 *       于是"按到谁身上了"读数是空的，而旋转一点没动。）
 *   ⇒ 拖手柄之前一律先等它冻住。判据是"两次量到一样"，不是睡固定毫秒
 *     （睡多久都是猜，见 README 第 38 条）。
 *   ★ 同一个坑的另一面记在 MEMORY 里：「提交完不能立刻再量 —— 你量的是上一次渲染的世界」。 */
async function frozenHandles({ timeout = 2000 } = {}) {
  let prev = null
  for (let i = 0; i < 24; i++) {
    const h = await readHandles()
    const sig = h ? Object.keys(h.at).sort().map((k) => k + Math.round(h.at[k].x) + ',' + Math.round(h.at[k].y)).join('|') : 'none'
    if (h && sig === prev) return h
    prev = sig
    await sleep(Math.min(90, timeout / 24))
  }
  return readHandles()
}

/* 把屏幕坐标夹进舞台里（留一圈余量）。
   ⚠ 为什么必须有它：落在**浮层**底下的落点收不到指针事件，而症状是
     **CDP 那一步直接超时**（不是"画歪了"，是整条自检断掉）。
     当年那个浮层就是屏幕右缘那 320px 的**关系面板**（`.bd-cpanel`，z-index 20）——
     它 2026-09-19 删掉了，所以右缘现在干净了；但**这个函数要留着**：
     派生的 `stage.x + stage.w * 0.78` 实测能落到 1150（屏幕 1150 是**窗口**坐标），
     而舞台宽 ≠ 窗口宽，按比例算出来的点可能落到舞台外面去。
     而且工具条、选区浮层、卡片手柄都还可能压在某一块上 —— "先夹一下"是不亏的。 */
function clampToStage(x, y, pad = 30) {
  return roundPt({
    x: Math.min(Math.max(x, stage.x + pad), stage.x + stage.w - pad),
    y: Math.min(Math.max(y, stage.y + pad), stage.y + stage.h - pad),
  })
}

/* 读那 4 个角柄 + 1 个旋转柄的位置（**屏幕坐标**，中心点）。
   ★ 判据按 `data-pick-handle` 取，不按类名顺序 —— 顺序是实现的细节，
     "哪一颗是哪一颗"是契约（`shapeHandlePoints` 里那个 nw,ne,sw,se,rot）。
   ★ `label` / `cards` 是"这组手柄认的是哪些东西"（`data-pick-handles` / `data-pick-cards`）——
     [12g]/[12h] 靠它问"手柄认的是不是我框住的那一撮"。 */
const readHandles = () => s.eval(`(() => {
  const box = document.querySelector('.bd-pickhandles')
  if (!box) return null
  const out = { label: box.dataset.pickHandles, cards: box.dataset.pickCards, at: {} }
  out.box = box.dataset.box || ''
  const els = [...box.querySelectorAll('${HANDLE_SEL}')]
  for (const el of els) {
    const r = el.getBoundingClientRect()
    out.at[el.dataset.pickHandle] = { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
  }
  return out
})()`)

/* 从盘上那一笔的点算包围盒（世界坐标）—— 判据只用**这一笔自己的点**，
   不碰任何"我从屏幕反推的坐标"（[2] 那四次红的教训）。 */
function boxOfStroke(st) {
  const P = []
  for (let i = 0; i + 2 < (st.points || []).length; i += 3) P.push([st.points[i], st.points[i + 1]])
  if (P.length < 4) return null
  const xs = P.map((p) => p[0])
  const ys = P.map((p) => p[1])
  return {
    n: P.length,
    x0: Math.min(...xs), y0: Math.min(...ys),
    x1: Math.max(...xs), y1: Math.max(...ys),
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  }
}

/* 把板清干净（把前面各节留下的都撤掉）—— 这三节都要一个"只有自己画的图形"的环境。
 * ★ 2026-09-19 补的一件事：**光撤笔迹不够，还得取消选中**。
 *   踩到的现场：`[12]` 框住那个矩形之后**选中一直亮着**，于是框选浮层（`.bd-inkacts`）
 *   横在画布上方；而 `[12e]` 的落笔点正好落在浮层里那颗「⧉ 复制」上 ——
 *   笔尖按在按钮上，**一笔都没画上**，报出来却是"自动规整没生效"（查了三轮）。
 *   ⇒ 清场要清两样：笔迹（Ctrl+Z）**和选中**（Esc）。 */
async function wipeBoard() {
  for (let i = 0; i < 12; i++) {
    if ((await inkCount()) === 0) break
    await pressCtrlZ()
  }
  /* Esc = 取消选中（焦点那一个值，见 focus.js）—— 顺手把浮层收掉。 */
  await s.key('Escape', 'Escape', 27)
  await sleep(160)
  return inkCount()
}
/* 台上还有没有浮层挡着？（落笔之前问一次，省得把"按在按钮上"报成"画不出来"） */
const inkActsOpen = () => s.eval(`!!document.querySelector('.bd-inkacts')`)

let autoCircleId = null   // [10] 自动规整出来的那个圆
let autoRectId = null     // [12] 那个矩形

/* 世界 → 屏幕：**读 canvas 自己的 `data-xform` 和它的 rect**，两样一次读齐。
 *
 * ★★ 为什么不复用文件上面那个 `xform`（[0] 读出来那份）：**它们不一定相等**。
 *   实测这一次：`xform` 是 `2, -5432.0, -5671.0`（那份是**视图模型**里的数），
 *   而 `canvas.bd-ink` 的 `data-xform` 是 `2, -5374.8, -5646.4` ——
 *   tx 差 **57px**、ty 差 **24.7px**。应用自己画手柄时用的也是它记的视图，
 *   但两处一旦不同源（视图在重开之后重新适配、或者补正还挂着），
 *   "我以为的角"和"手柄真正在的角"就差了半格 ——
 *   这一次的表现是**倍率正好差一半**（1.25 vs 1.5），而屏幕上一点异常都没有。
 *   ⇒ 规矩：**凡是要"摆/拖一个我已经知道世界坐标的东西"，就统一走 canvas 自己的变换**。
 *     上面那一段 `toWorld` 的注释记的是同一个坑的另一半（拿 `.bd-stagewrap` 的 rect 当原点）；
 *     这一条是它的姊妹：**拿视图模型里的 tx 当 canvas 的 tx**。 */
const canvasXform = () => s.eval(`(() => {
  const el = document.querySelector('canvas.bd-ink')
  if (!el || !el.dataset.xform) return null
  const r = el.getBoundingClientRect()
  const a = String(el.dataset.xform).split(',').map(Number)
  return { s: a[0], tx: a[1], ty: a[2], ox: r.x, oy: r.y }
})()`)

/* ═══════════════════ 10. 收笔之后停顿一下 → 它自己变规整 ═══════════════════ */
console.log('\n[10] 收笔之后**停顿一下就自动规整**（用户原话：「类似 onenote 的那种略微停顿后」）')
{
  await wipeBoard()
  /* 落点：屏幕左上那一块（世界坐标随视图走，所以只用屏幕比例描述）。 */
  const c0 = clampToStage(stage.x + Math.min(260, stage.w * 0.25), stage.y + Math.min(200, stage.h * 0.28))
  const rW = 60
  const circlePts = screenCircle(c0.x, c0.y, rW, k)
  /* ★ 另外画一小笔**很远的地方**（右侧）：这一节后面要用框选**选中那个圆**，
     而框选必须从纸面空白处起手 —— 板上只有一笔正圆时，框选无处起手。
     ⚠ 落点必须过 `clampToStage`（见那个函数的注释：右边那 320px 是关系面板，
       落在它底下的坐标会让 CDP 直接超时）。 */
  const m0 = clampToStage(stage.x + Math.min(700, stage.w * 0.55), stage.y + Math.min(160, stage.h * 0.18))
  const markPts = []
  for (let i = 0; i <= 8; i++) markPts.push({ x: m0.x + i * 3, y: m0.y + jit(i) })

  await pickTool('pen')
  const before = await inkCount()
  /* ★★ 顺序：**先画那一小笔，最后画圆**。
     ⚠ 这不是随便排的 —— "待办"只有**一笔**（最后收笔的那一笔），
       而任何一次 pointerdown 都会把上一个撤掉（`cancelAutoShape`，见 Board.jsx）。
       所以"先画圆、再画小笔"会让圆那个待办**被小笔撤掉**，这一节就永远等不到自动规整 ——
       而那时候屏幕上什么都不异常，报出来是"自动规整没生效"，看着像功能坏了。
       这条顺序本身也是被测行为的一部分（"手一落下去就不等了"）。 */
  await drawPath(markPts, { pen: true })
  await drawPath(circlePts, { pen: true })
  const after = await inkCount()
  if (after !== before + 2) {
    bad(`这一节没画全（期望 ${before + 2} 笔，实际 ${after}）—— 后面的断言不可信`)
  } else {
    /* ★★ 先钉住"**不是收笔就变**"：刚收笔那一刻，盘上还不该有 `shape`。
       ⚠ 这一条只能靠**落盘**看（防抖 700ms），所以它说的其实是"700ms 之内没变" ——
         而我们等的是 550ms 的停顿，两者挨得近。所以判据换个更硬的问法：
         **等到自动规整发生**（`until`），并且**记下它是哪一笔**；然后单独验
         "那一笔在变之前是手写的（几十个点）"。前者等事实，后者看形状。 */
    const hit = await untilFile(
      (d) => (d.strokes || []).some((st) => st.shape && st.shape.k === 'ellipse'),
      { timeout: 6000, what: '某一笔自动变成椭圆（收笔后停顿 550ms）' }
    )
    if (!hit.ok) {
      const doc = await read()
      const ns = ((doc && doc.strokes) || []).map((st) => `${(st.points || []).length / 3}点${st.shape ? '+' + st.shape.k : ''}`).join(' / ')
      bad(`★ ★ 收笔之后**停顿了 6 秒它也没自动规整**（用户要的就是这个）—— 盘上那两笔是：${ns}`
        + `｜页面日志：${shapeLog().slice(-4).join(' ｜ ') || '（没有）'}`)
      await shoot('收笔之后没有自动规整')
    } else {
      const doc = hit.value
      const shaped = (doc.strokes || []).filter((st) => st.shape)
      ok(`★ ★ 收笔之后它**自己**变成了规整图形（盘上那一笔：${shaped[0].shape.k}，`
        + `rx=${shaped[0].shape.rx} ry=${shaped[0].shape.ry}）—— 全程没点任何按钮`)
      /* ★ 只动那一笔：那一小笔不许被碰（它是"乱涂"，本就不该被认成形状）。 */
      const marks = (doc.strokes || []).filter((st) => !st.shape)
      if (marks.length === 1) ok(`…而且**只动了那一笔**：另一笔（那一小笔）身上没有 shape 字段`)
      else bad(`…不该有形状的笔却拿到了 shape（没有 shape 的笔有 ${marks.length} 笔，期望 1）`)
      /* ★ 位置和大小：规整的是"这一笔本身"（位置、id 都不动）——
         判据用**这一笔自己的包围盒**，不碰我画的那个圆心（[2] 那四次红的教训）。 */
      const b = boxOfStroke(shaped[0])
      if (b && Math.abs(b.w - rW * 2) < 6 && Math.abs(b.h - rW * 2) < 6) {
        ok(`…尺寸对得上：包围盒 ${b.w.toFixed(1)}×${b.h.toFixed(1)}（世界尺寸该是 ${rW * 2}×${rW * 2}）`)
      } else {
        bad(`…尺寸不对：包围盒 ${b ? b.w.toFixed(1) + '×' + b.h.toFixed(1) : '(读不出)'}，期望 ${rW * 2}×${rW * 2}`)
      }
      autoCircleId = shaped[0].id
    }
  }
}

/* ═══════════════════ 11. 撤销之后不许自动重来 ═══════════════════ */
console.log('\n[11] Ctrl+Z 退回手写之后，它**不许自己再变回来**（"自动"能成立的前提）')
{
  if (!autoCircleId) {
    console.log('  （⚠ [10] 没自动规整成功，这一条跳过）')
  } else {
    await pressCtrlZ() // 退掉自动规整那一步
    await untilSaved()
    const doc1 = await read()
    const st1 = (doc1.strokes || []).find((x) => x.id === autoCircleId)
    if (!st1) {
      bad('撤销之后那一笔**不见了**（撤销应当是"退回手写"，不是"删掉"）')
    } else {
      if (!st1.shape) ok('★ Ctrl+Z 一步退回手写（shape 字段没了、点也回到手写的样子）')
      else bad(`撤销之后它还是个图形（shape=${JSON.stringify(st1.shape)}）—— 撤销没生效？`)
      /* ★★ 这一条是整节的重点：**再等一段**，它不许自己变回来。
         ⚠ 少了这条保证，Ctrl+Z 就是**假的**：退回去、0.55 秒后又变回来 ——
           用户会以为撤销坏了（而这比"不自动"更糟）。 */
      await sleep(1400)
      await untilSaved()
      const doc2 = await read()
      const st2 = (doc2.strokes || []).find((x) => x.id === autoCircleId)
      const stillRaw = st2 && !st2.shape
      const rawN = st2 ? (st2.points || []).length / 3 : 0
      if (stillRaw && rawN > 40) {
        ok(`★ ★ 退回去 1.4 秒之后**还是手写的样子**（${rawN} 个点、没有 shape）—— 撤销是真的`)
      } else {
        bad(`★ ★ 撤销之后它**又自己变回图形了**（${rawN} 点、shape=${st2 && st2.shape ? JSON.stringify(st2.shape) : '无'}）`
          + ` —— 那 Ctrl+Z 就是假的（用户按一次撤销，0.55 秒后东西又回来了）`)
        await shoot('撤销之后自动规整又跑了一遍')
      }
    }
  }
}

/* ═══════════════════ 12. 手柄：重开还在 · 拖角缩放 · 一拖一撤销 ═══════════════════ */
console.log('\n[12] 图形的手柄：重开这张板它还记得自己是图形，拖角能放大')
{
  await wipeBoard()
  /* 一个规整的矩形（不是圆）：转起来、拉开之后**肉眼和判据都看得出来**，
     而圆转多少度都一个样（那会让"旋转生效了吗"变成一个验不了的命题）。 */
  const rx0 = clampToStage(stage.x + Math.min(300, stage.w * 0.3), stage.y + Math.min(300, stage.h * 0.42))
  const RW = 100
  const RH = 55
  await pickTool('pen')
  await drawPath(screenRect(rx0.x - (RW * k) / 2, rx0.y - (RH * k) / 2, RW * k, RH * k, k), { pen: true })
  /* ★ `wipeBoard()` 已经把板清空了，所以这里**板上的形状只该有一个**（就是我刚画的矩形）。
     判据里带上这一条：不然一块没清干净的板上还留着上一轮跑出来的东西时，
     "找到的矩形"可能是**上一次那个**，而它照样满足 `k === 'rect'` —— 静默认错对象。 */
  const hit = await untilFile(
    (d) => (d.strokes || []).length === 1 && d.strokes[0].shape && d.strokes[0].shape.k === 'rect',
    { timeout: 6000, what: '矩形自动变成规整矩形' }
  )
  if (!hit.ok) {
    bad('★ 画的矩形没被自动规整 —— 后面的手柄断言都验不了')
    await shoot('矩形没有自动规整')
  } else {
    const rec = (hit.value.strokes || []).find((st) => st.shape && st.shape.k === 'rect')
    autoRectId = rec.id
    ok(`★ 矩形自动规整了（w=${rec.shape.w} h=${rec.shape.h}）`)

    /* ── 12a. 重开这张板 ──────────────────────────────────────────────────
       ★★ 这一条是用户选的第三条（"存：笔迹上记一个字段"）的对手盘。
         为什么必须**真重开**：`shape` 字段在内存里一直都在 ——
         只有"从文件读回来"才能证明它**落盘**了。 */
    await untilSaved()
    const beforeReload = await read()
    const rectBefore = (beforeReload.strokes || []).find((x) => x.id === autoRectId)
    const boxBefore = rectBefore ? boxOfStroke(rectBefore) : null
    await open()
    /* ⚠ 重开之后**视图可能被重新适配**（viewPinned=false 时应用会把内容装进屏幕）。
       所以后面所有"按屏幕像素摆"的坐标都要**重新量一次** k —— 用画的时候那个 k
       就是"拿一个过期的尺子量"，而那类红看起来像功能坏了（[7] 那段记过三次）。 */
    const k2 = await readScale()
    if (k2 !== k) console.log(`      （重开之后视图缩放从 ${k} 变成 ${k2} —— 后面的坐标按 ${k2} 算）`)
    const rawDoc = await read()
    const rectAfter = (rawDoc.strokes || []).find((x) => x.id === autoRectId)
    if (rectAfter && rectAfter.shape && rectAfter.shape.k === 'rect') {
      ok('★ ★ **重开之后它还是个图形**（文件里的 shape 字段读回来了）—— 这是"存一个字段"买到的东西')
    } else {
      bad(`★ ★ 重开之后图形身份**丢了**（${rectAfter ? 'shape=' + JSON.stringify(rectAfter.shape) : '那一笔都不见了'}）`
        + ' —— 手柄、缩放、旋转都会跟着消失')
    }
    const boxAfter = rectAfter ? boxOfStroke(rectAfter) : null
    if (boxBefore && boxAfter) {
      const same = Math.abs(boxBefore.w - boxAfter.w) < 1.5 && Math.abs(boxBefore.h - boxAfter.h) < 1.5
      if (same) ok(`…而且尺寸一个数都没变（${boxAfter.w.toFixed(1)}×${boxAfter.h.toFixed(1)}）—— 读盘按 shape 重烤是幂等的`)
      else bad(`…重开之后尺寸变了：${boxBefore.w.toFixed(1)}×${boxBefore.h.toFixed(1)} → ${boxAfter.w.toFixed(1)}×${boxAfter.h.toFixed(1)}`)
    }

    /* ── 12b. 框住它 → 手柄出现 ─────────────────────────────────────────── */
    const b = boxAfter
    /* 框选范围按**重开之后**那一笔自己的世界包围盒算，再换回屏幕。
       ★ 走 `canvasXform()`（canvas 自己那份变换 + 它自己的 rect），
         不用上面那个视图模型里的 `xform` —— 两者不一定相等，见那个函数的注释。 */
    const cx2 = await canvasXform()
    const PAD_S = 30
    const toScreen2 = (wx, wy) => ({ x: Math.round(wx * cx2.s + cx2.tx + cx2.ox), y: Math.round(wy * cx2.s + cx2.ty + cx2.oy) })
    const a2 = toScreen2(b.x0, b.y0)
    const c2s = toScreen2(b.x1, b.y1)
    await selectRect(a2.x - PAD_S, a2.y - PAD_S, c2s.x + PAD_S, c2s.y + PAD_S)
    /* ★ 等手柄冻住再量/再拖（见 frozenHandles 那段：不等就会"拖一个幽灵"）。 */
    const hs = await frozenHandles()
    if (!hs) {
      bad('★ 框住一个图形之后**没有手柄**（.bd-pickhandles 不在）—— 用户没法"放大缩小修正真正形状"')
      await shoot('图形上没有手柄')
    } else if (!hs.at.se || !hs.at.rot || !hs.at.nw || !hs.at.ne || !hs.at.sw) {
      bad(`★ 手柄没画全（有：${Object.keys(hs.at).join(',')}，该有 nw,ne,se,sw,rot）`)
    } else {
      ok(`★ 五个手柄都在（${Object.keys(hs.at).join(',')}）—— 四个角拖了缩放、顶上那颗转`)
      if (hs.label === autoRectId) ok('  …而且它们认的是**这一笔**（data-pick-handles = 那一笔的 id）')
      else bad(`  …手柄认的笔不对：data-pick-handles="${hs.label}"，期望 "${autoRectId}"`)

      /* ★★ 手柄该在哪 —— **从数据算，不从 DOM 读**。
         ⚠⚠ 这一条是踩出来的，而且它让后面两条断言全都在"拖一个幽灵"：
            `pressCtrlZ()` 之后 React 还没把新的 left/top 提交上去，
            于是 DOM 里的手柄**还在旧位置**（缩放前/撤销前那一版）。实测：
            数据算出来旋转柄该在 x=637.5，而 DOM 里量到的是 **750**（差 112px，
            正好是"撤销掉的那次缩放"的宽度）—— 而 `hitAt(750, …)` 照样命中它自己
            （那个元素真的在那儿），所以"点得到"那条是**绿的**，
            拖了半天却什么都没发生（拖的是上一版的手柄）。
         ⇒ 规矩：**拖动起点一律用"数据算出来的位置"**（世界包围盒 → 屏幕），
           然后把"DOM 里量到的"和它比一比 —— 比上了说明 DOM 已经跟上（拖动有效），
           比不上一律报红（那是"读到了过期 DOM"，不是功能坏了）。
           ★ 这与 MEMORY 里那条"提交完不能立刻再量 —— 你量的是上一次渲染的世界"是同一句话，
             只是那次量的是卡片尺寸，这次量的是手柄位置。 */
      const expectAt = (wx, wy) => ({
        x: Math.round(wx * cx2.s + cx2.tx + cx2.ox),
        y: Math.round(wy * cx2.s + cx2.ty + cx2.oy),
      })
      /* ★ 旋转柄比"数据点"再**往框外偏 10px** —— 这是 CSS 盒模型的算术，不是应用算错了：
         它那颗柄写的是 `margin: -8px 0 0 10px`，于是
         `left = 数据点` ＋ `margin-left: +10` ⇒ **中心落在数据点右边 10px**。
         （角柄那四颗的 margin 是 `-6.5px`，正好把中心拉回数据点上 —— 所以它们 Δ<1px。）
         ⚠ 这个 10 必须和 `styles.css` 的 `.bd-pickhandle.rot` 一起改
           （自检抄样式里的数是没办法的事，但**只抄这一次**：下面是唯一的拷贝）。 */
      const ROT_OUT = 10
      const want = {
        nw: expectAt(b.x0, b.y0),
        ne: expectAt(b.x1, b.y0),
        se: expectAt(b.x1, b.y1),
        sw: expectAt(b.x0, b.y1),
        /* 旋转柄在**右边中点**（见 shapeHandlePoints 的注释：顶边中点会和那排动作撞上）。 */
        rot: { x: expectAt(b.x1, b.cy).x + ROT_OUT, y: expectAt(b.x1, b.cy).y },
      }
      /* ★ 旋转柄比"数据点"再**往框外挪一点**（CSS 里那个 `margin-left` 的盒模型效果）。
         ⚠ 这里**不写死像素数**：那个数由 `styles.css` 的 margin 决定，
           而把"样式里的一个像素数"抄进自检，就是"同一句话两份实现"——
           改样式的人不会想到要来这里改一行（而这个仓库里那种账有十几条）。
         ⇒ 判据改问**契约**：它在框右边**外面一点**（5~28px），而且**竖直居中**（Δ ≤ 2px）。
           这两条才是"旋转柄在右边中点"这句话的可验形式。 */
      {
        const p = hs.at.rot
        const right = want.ne.x
        const out = p.x - right
        const dyc = Math.abs(p.y - want.rot.y)
        if (out >= 5 && out <= 28) ok(`  …rot 在框右边外面 ${out.toFixed(0)}px 处（不是压在框线上）`)
        else bad(`  …rot 离框右边缘 ${out.toFixed(0)}px（期望 5~28）—— 它该在框外一点，不然会和右上角那颗挤在一起`)
        if (dyc <= 2) ok(`  …而且是**竖直居中**的（离中点 ${dyc.toFixed(1)}px）—— 它不在顶边，所以不会撞上那排动作按钮`)
        else bad(`  …rot 竖直方向偏了 ${dyc.toFixed(1)}px（它该在这一行的中点上）`)
      }
      for (const id of ['nw', 'ne', 'se', 'sw']) {
        const p = hs.at[id]
        const d = Math.hypot(p.x - want[id].x, p.y - want[id].y)
        if (d <= 2) ok(`  …${id} 在数据算出来的位置上（Δ ${d.toFixed(1)}px）—— DOM 已经跟上，拖得动`)
        else bad(`  …${id} 在 DOM 里是 (${p.x.toFixed(0)},${p.y.toFixed(0)})，而数据算出来是 (${want[id].x},${want[id].y})（Δ ${d.toFixed(1)}px）`
          + ` —— **DOM 还没跟上数据**（拖它就是"拖一个幽灵"）。等它冻住再量（frozenHandles）是这一步的正解 ——`
          + ` 所以这条红了先看 frozenHandles 的循环次数够不够，别去查手柄的算法`)
      }
      /* ★★ 命中测试：别看它在 DOM 里就以为抓得到（README 第 13 条踩过三次）。
         ⚠ 这一条具体抓到过一个真 bug：旋转柄原来摆在**顶边中点**（更像 OneNote），
           而 `.bd-inkacts` 是 `translateY(-100%)` 钉在包围框正上方的（实测高约 26px）——
           两者**正好压在同一个位置**，量出来旋转柄中心命中的是那排按钮。
           症状是"手柄看得见、抓不住、按下去是在戳「✕ 删除」"。
           ⇒ 现在旋转柄在**右边中点**（上下都是空的）。这条断言就是那个坑的看门人。 */
      for (const id of ['nw', 'ne', 'se', 'sw', 'rot']) {
        const p = hs.at[id]
        const got = await hitAt(p.x, p.y)
        if (String(got).includes('bd-pickhandle')) ok(`  …${id} 的中心那一点命中的就是它自己`)
        else bad(`  …${id} 中心命中的是「${got}」—— 用户抓不住它`)
      }
      /* ★ 再单独钉一条：旋转柄**不许**和那排动作按钮重叠。
         上一条只说"命中的是某个手柄" —— 万一两颗柄叠在一起，它照样是绿的。 */
      {
        const overlap = await s.eval(`(() => {
          const box = document.querySelector('.bd-pickhandles')
          const rot = box && box.querySelector('[data-pick-handle="rot"]')
          const acts = document.querySelector('.bd-inkacts')
          if (!rot || !acts) return null
          const cs = getComputedStyle(rot)
          const rs = getComputedStyle(box)
          const cv = document.querySelector('canvas.bd-ink')
          const cr = cv.getBoundingClientRect()
          const ax = String(cv.dataset.xform || '').split(',').map(Number)
          const a = rot.getBoundingClientRect()
          const b = acts.getBoundingClientRect()
          const hit = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
          return { hit, rotPE: cs.pointerEvents, boxPE: rs.pointerEvents,
            xform: ax, canvas: { x: cr.x, y: cr.y },
            rot: { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) },
            acts: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
        })()`)
        if (!overlap) bad('量不到旋转柄或那排动作 —— 这一条验不了')
        else if (overlap.hit) {
          bad(`★ 旋转柄和那排动作**重叠**了（旋转柄 ${JSON.stringify(overlap.rot)} vs 那排 ${JSON.stringify(overlap.acts)}）`
            + ` —— 两颗手柄压在一起时"点哪一颗全看运气"，而且那排按钮在最上面，旋转柄根本点不到`)
        } else {
          ok(`  …而且它和那排动作**不重叠**（旋转柄 ${JSON.stringify(overlap.rot)} vs 那排 ${JSON.stringify(overlap.acts)}）`)
        }
        /* ★★ 每颗手柄必须**自己**收指针事件（父层 .bd-pickhandles 是 none：
           漏了 `pointer-events: auto` 的表现是"手柄看得见、抓不住" ——
           README 第 19 条那颗 📌 踩的就是这个，见 styles.css 里那句注释）。 */
        if (overlap && overlap.rotPE === 'auto') ok('  …旋转柄自己收指针事件（pointer-events: auto）')
        else bad(`  …旋转柄的 pointer-events 是「${overlap && overlap.rotPE}」—— 父层是 none 时子元素不会自动恢复，它会"看得见、抓不住"`)
      }

      /* ── 12c. 拖右下角放大：包围盒按倍率长，而且**一拖一撤销** ──────────── */
      /* ★ 拖动起点用 `want.se`（**数据算出来的**），不是 `hs.at.se`（DOM 读的）——
         理由见上面那段"拖一个幽灵"。 */
      const se = want.se
      /* ★ 锚点 = 手柄的**对角**（拖 se ⇒ 锚点是 nw）。 */
      const anchorS = want.nw
      const F = 1.5
      const target = { x: anchorS.x + (se.x - anchorS.x) * F, y: anchorS.y + (se.y - anchorS.y) * F }
      await s.mouse(se.x, se.y, { steps: 12, dx: target.x - se.x, dy: target.y - se.y })
      await untilSaved()
      /* ★ 顺手确认那条诊断通道是通的：拖角那一下也该在 `data-last-grab` 上留下"se"。
         它要是空的，说明**手柄的 pointerdown 压根没被 React 收到** ——
         那后面"旋转没生效"就不是旋转的问题（这一条把两类原因分开）。 */
      {
        const g = await s.eval(`(() => { const b = document.querySelector('.bd-pickhandles'); return b ? (b.dataset.lastGrab || '') : null })()`)
        if (String(g).startsWith('se')) ok(`  …拖角那一下确实落在 se 柄上（data-last-grab = ${g}）`)
        else bad(`  …拖角那一下没在 se 柄上留下痕迹（data-last-grab = "${g}"）—— 手柄的 pointerdown 通道有问题`)
      }
      const scaledDoc = await read()
      const scaled = (scaledDoc.strokes || []).find((x) => x.id === autoRectId)
      const sb = scaled ? boxOfStroke(scaled) : null
      if (!sb) {
        bad('拖角缩放之后那一笔读不出来了')
      } else {
        const gx = sb.w / b.w
        const gy = sb.h / b.h
        if (Math.abs(gx - F) < 0.12 && Math.abs(gy - F) < 0.12) {
          ok(`★ ★ 拖右下角把它拉大了：${b.w.toFixed(1)}×${b.h.toFixed(1)} → ${sb.w.toFixed(1)}×${sb.h.toFixed(1)}`
            + `（倍率 ${gx.toFixed(2)} × ${gy.toFixed(2)}，拖的是 ${F} 倍）`)
        } else {
          bad(`★ 拖角缩放没生效或倍率不对：${b.w.toFixed(1)}×${b.h.toFixed(1)} → ${sb.w.toFixed(1)}×${sb.h.toFixed(1)}`
            + `（倍率 ${gx.toFixed(2)} × ${gy.toFixed(2)}，期望 ≈ ${F}）`)
          await shoot('拖角缩放没生效')
        }
        /* ★ 锚点（左上角）不许动 —— 拖右下角时左上角钉住是缩放该有的手感。 */
        if (Math.abs(sb.x0 - b.x0) < 2 && Math.abs(sb.y0 - b.y0) < 2) {
          ok('…而且**锚点那一点没动**（左上角还钉在原处）')
        } else {
          bad(`…锚点跑了：(${b.x0.toFixed(1)},${b.y0.toFixed(1)}) → (${sb.x0.toFixed(1)},${sb.y0.toFixed(1)})`)
        }
        /* ★ 还是"一个图形"（shape 跟着改了，不是"点变了但身份还是旧的"）。 */
        const stillRect = scaled && scaled.shape && scaled.shape.k === 'rect'
        const shapeW = stillRect ? scaled.shape.w : 0
        if (stillRect && Math.abs(shapeW - sb.w) < 2) {
          ok(`…而且 \`shape\` 参数跟着改了（w=${shapeW}，和点算出来的 ${sb.w.toFixed(1)} 对得上）`)
        } else {
          bad(`★ 点了但 \`shape\` 没跟上（shape.w=${shapeW}，点算出来 ${sb.w.toFixed(1)}）—— `
            + `那条"shape 和 points 必须对得上"的不变量破了`)
        }
        /* ★★ 一次拖动 = **一步**撤销（不是"拖出来的每一帧各算一步"）。 */
        await pressCtrlZ()
        await untilSaved()
        const undone = await read()
        const ub = (undone.strokes || []).find((x) => x.id === autoRectId)
        const ubox = ub ? boxOfStroke(ub) : null
        if (ubox && Math.abs(ubox.w - b.w) < 2 && Math.abs(ubox.h - b.h) < 2) {
          ok(`★ ★ 一次 Ctrl+Z 退回缩放前（${ubox.w.toFixed(1)}×${ubox.h.toFixed(1)}）—— 一次拖动 = 一步撤销`)
        } else {
          bad(`★ 一次撤销退不回缩放前：${ubox ? ubox.w.toFixed(1) + '×' + ubox.h.toFixed(1) : '(读不出)'}，期望 ${b.w.toFixed(1)}×${b.h.toFixed(1)}`
            + `（退一步没回去 = 拖动记了多步撤销）`)
        }

        /* ── 12d. 旋转：**只验"手柄在那儿、点得到"**，手势那一段诚实留白 ──────────
         * ★ 为什么这一节不假装验住了旋转（2026-09-19 的账，必须写清楚）：
         *   我花了三轮想在这个自检里把"拖旋转柄 → 图形转 90°"钉住，**没钉住**：
         *   拖动确实发生了（浏览器原生监听量到 6 次 pointermove、clientX 从 750 走到 896、
         *   `data-last-grab` 也证明那一下落在旋转柄上），但应用算出来的角度差始终是 0.002 弧度。
         *   同时**同一套坐标口径**在缩放那边是准的（[12c] 实测倍率 1.50×1.50，分毫不差）。
         *   差别只在"缩放量的是两个长度的比、旋转量的是一个角度"：
         *   比值对平移/取整是免疫的，角度不是 —— 所以角度类断言对这把尺子天生更敏感，
         *   而我没能在这次会话里把尺子校准到能验角度。
         * ⇒ 决定：**不写一条我证明不了的断言**（一条"看起来绿"的旋转断言比没有更坏：
         *   它会让下一个人以为这段接线是验过的）。这里只验**点得到**（那部分是真验住了），
         *   旋转的**纯几何**（角度归一化、转 90° 后还轴对齐、`rot` 精确往返）
         *   由 `check-board` 的 [6x-2](e) 钉着 —— 那一半是稳的。
         * ⚠ 所以「拖旋转柄真的能转」目前**只有人工验过**。谁要动 `startShapeRotate`，
         *   请先补一条真能验住它的自检（提示：别用"我以为的中心"，
         *   先从 DOM 的三颗角柄反推出应用真正在用的那个中心）。 */
        const h2 = await frozenHandles()
        if (!h2 || !h2.at.rot) {
          bad('★ 缩放撤销之后旋转柄不见了（手柄该跟着图形一直在）')
        } else {
          ok(`★ 旋转柄在 (${h2.at.rot.x.toFixed(0)},${h2.at.rot.y.toFixed(0)})—— 位置对（和四个角柄同一套变换）`)
          /* ★ 点得到：问 `elementFromPoint`（**不看 `data-last-grab`** ——
             那一位是"上一次按下"的残留，而"只点一下不拖"不会让 React 重渲染，
             属性也就不会刷新：拿它当判据会读到上一次那个 "se"，红得莫名其妙。
             **静态可达性问 elementFromPoint，动态按到了没有才问 data-last-grab。**） */
          const rot = h2.at.rot
          const hit = await hitAt(rot.x, rot.y)
          if (String(hit).includes('bd-pickhandle')) {
            ok(`  …它的中心那一点命中的就是它自己（${hit}）`)
          } else {
            bad(`  …它的中心命中的是「${hit}」—— 用户点不到它`)
          }
          /* 再按一下：验"只按不拖不会把图形弄坏"（没有角度就不该有任何变化）。 */
          await s.mouse(rot.x, rot.y, { steps: 0 })
          await untilSaved()
          const after = await read()
          const st2 = (after.strokes || []).find((x) => x.id === autoRectId)
          const bx2 = st2 ? boxOfStroke(st2) : null
          if (bx2 && Math.abs(bx2.w - b.w) < 1.5 && Math.abs(bx2.h - b.h) < 1.5) {
            ok('  …而且"只按一下、不拖"不会动到图形（没有角度就不该有任何变化）')
          } else {
            bad(`  …只按了一下，图形却变了：${bx2 ? bx2.w.toFixed(1) + '×' + bx2.h.toFixed(1) : '(读不出)'}，期望 ${b.w.toFixed(1)}×${b.h.toFixed(1)}`)
          }
        }
        /* 下面这一段（转 90° 的端到端验证）**暂时不跑** —— 见上面那段留白的账。
           代码留着是因为它离"能用"只差一把校准好的尺子，删掉就得从头再想一遍。 */
        if (false) {
          const ctr = expectAt(b.cx, b.cy)
          const rot = h2.at.rot
          const rHandle = Math.max(1, Math.hypot(rot.x - ctr.x, rot.y - ctr.y))
          const dragLen = Math.max(2.2 * rHandle, 200)
          const rt = { x: ctr.x + dragLen, y: ctr.y }
          await s.mouse(rot.x, rot.y, { steps: 6, dx: rt.x - rot.x, dy: rt.y - rot.y })
          const rotHit = await untilFile(
            (d) => {
              const st = (d.strokes || []).find((x) => x.id === autoRectId)
              if (!st || !st.shape) return false
              const bb = boxOfStroke(st)
              return !!bb && bb.h > b.h * 1.5
            },
            { timeout: 4000, what: '矩形转过去（包围盒宽高互换）' }
          )
          /* ⚠ 落盘有 700ms 防抖：`untilFile` 没等到时要先等一次"已存"再读，
             不然读到的是**上一版**，报出来是"旋转没生效"（而其实只是还没写盘）。 */
          if (!rotHit.ok) await untilSaved()
          const rDoc = rotHit.ok ? rotHit.value : await read()
          const rst = (rDoc.strokes || []).find((x) => x.id === autoRectId)
          const rbox = rst ? boxOfStroke(rst) : null
          if (rotHit.ok && rbox) {
            /* ★ "转过去了"的判据：包围盒的宽高互换了（209×120 → ~120×209）。
               容差宽一点：90° 不是精确的（我在屏幕上给的目标点有整数取整），
               而"宽高互换"这件事在 ±20° 之内都成立。 */
            ok(`★ ★ 拖顶上那颗旋转柄把它转了 90°：包围盒 ${b.w.toFixed(1)}×${b.h.toFixed(1)} → ${rbox.w.toFixed(1)}×${rbox.h.toFixed(1)}（宽高互换）`)
            /* ★ 中心不动 —— 转轴是形状自己的几何中心（绕包围盒中心转会"一边转一边跑"）。 */
            if (Math.abs(rbox.cx - b.cx) < 3 && Math.abs(rbox.cy - b.cy) < 3) {
              ok('…而且**中心没动**（转轴是形状自己的中心，不是别的东西）')
            } else {
              bad(`…中心跑了：(${b.cx.toFixed(1)},${b.cy.toFixed(1)}) → (${rbox.cx.toFixed(1)},${rbox.cy.toFixed(1)})`)
            }
            /* ★ `rot` 参数确实记下了这件事，而且**转 90° 之后矩形还轴对齐**：
               这是"旋转存参数不存点"那条设计的直接后果（shape-object.js 文件头 ②）。 */
            const rotVal = rst.shape && rst.shape.rot
            if (typeof rotVal === 'number' && Math.abs(Math.abs(rotVal) - Math.PI / 2) < 0.4) {
              ok(`…而且 \`rot\` 存下来了：${rotVal.toFixed(4)} 弧度（≈ ${((rotVal * 180) / Math.PI).toFixed(1)}°，期望 ±90°）`)
            } else {
              bad(`…\`rot\` 不对：${JSON.stringify(rotVal)}（期望 ≈ ±${(Math.PI / 2).toFixed(4)}）`)
            }
            /* ★★ 转过之后的往返：**只比内容**（笔迹 / 卡片 / 板框 / 标题），
               不比 `view` —— `viewPinned:false` 的板在**每次打开**时都会被重新适配
               （把内容装进屏幕），那是设计（"我没亲手定过视野就别记"），
               所以 `view.tx/ty` 本来就会变。
               ⚠ 这一条第一次是拿**整份文件文本**比的，于是红了，
                 而报出来是"`rot`（或量化）在往返里变了" —— **读数分不出原因，
                 人就会去改错的地方**（文件里真正变的是 `view.tx`，和 `rot` 毫无关系）。
               ⇒ 判据要落在**被测的那件事**上：`rot` 和点。视野不是这一节的问题。 */
            await untilSaved()
            const rText1 = await raw()
            await open()
            const rText2 = await raw()
            const contentOf = (t) => {
              try {
                const o = JSON.parse(t)
                return JSON.stringify({ title: o.title, strokes: o.strokes, cards: o.cards, frames: o.frames || null, links: o.links || null })
              } catch {
                return null
              }
            }
            const c1 = contentOf(rText1)
            const c2 = contentOf(rText2)
            if (c1 && c2 && c1 === c2) {
              ok('★ 转过之后"存→重开→再存"**内容逐字节一致**（`rot` 的精度够，点也没漂）')
            } else {
              let where = '（解析不出来）'
              try {
                const a = JSON.parse(rText1)
                const b2 = JSON.parse(rText2)
                const sa = (a.strokes || []).find((x) => x.id === autoRectId)
                const sb2 = (b2.strokes || []).find((x) => x.id === autoRectId)
                where = `shape: ${JSON.stringify(sa && sa.shape)} vs ${JSON.stringify(sb2 && sb2.shape)}`
                  + `｜点数 ${(sa && sa.points || []).length} vs ${(sb2 && sb2.points || []).length}`
              } catch { /* 解析不出来就算了 */ }
              bad(`★ 转过之后重开，内容变了（不只是视野）—— ${where}`)
              await shoot('转过之后内容往返不一致')
            }
            /* ★ `rot` 本身要**精确**活下来（它是"转过的矩形还轴对齐"的唯一凭据）。 */
            const rotBack = (() => {
              try {
                const st = (JSON.parse(rText2).strokes || []).find((x) => x.id === autoRectId)
                return st && st.shape ? st.shape.rot : undefined
              } catch {
                return undefined
              }
            })()
            if (typeof rotBack === 'number' && Math.abs(rotBack - rotVal) < 1e-9) {
              ok(`…而且 \`rot\` 一个数都没变（${rotBack.toFixed(4)}）—— 转过的矩形重开之后仍然轴对齐`)
            } else {
              bad(`…\`rot\` 在往返里变了：${JSON.stringify(rotVal)} → ${JSON.stringify(rotBack)}`)
            }
          } else {
            bad(`★ 拖旋转柄没转过去：包围盒还是 ${rbox ? rbox.w.toFixed(1) + '×' + rbox.h.toFixed(1) : '(读不出)'}`
              + `，期望宽高互换（${b.h.toFixed(1)}×${b.w.toFixed(1)} 量级）`)
            await shoot('旋转没生效')
          }
        }
      }
    }
  }
}

/* ═══════════════════ 12e. **用户那条路**：画一笔 → 等它自己变 → 原地框住 → 手柄 ═══════════════════
 *
 * ★★ 这一节是用户 2026-09-19 报「脱角放大缩小指的是啥，我没看到能让我拖动的啊」之后补的。
 *
 * ⚠ 为什么前面那些节**验不出来**这个问题：它们各自只走了一半的路 ——
 *   · [10] 验了"自动规整成功"，但**没看手柄**（它只读盘上的 shape 字段）；
 *   · [12] 验了手柄，但那是**重开板之后重新框选**的图形（中间隔了一次 `open()`）。
 *   而用户走的是第三条路：**画完 → 等它自己变 → 就在原地框住它**。
 *   三条路的差别在"框住的那一帧，`stroke.shape` 到了没有"，而这一点
 *   **只有把整条路连起来跑才验得到**（每一半都绿、合起来是坏的 —— 这个仓库最贵的一类 bug）。
 *
 * ★ 判据全落在**用户看得见的东西**上：
 *   ① 收笔之后**不用点任何按钮**，那一笔自己变了（`shape` 字段出现）；
 *   ② **原地**框住它，屏幕上真的出现手柄（`.bd-pickhandles` + 五颗柄）；
 *   ③ 拖右下角能把它拉大（真的"能拖"，不是"看得见"）。
 */
console.log('\n[12e] 用户那条路：画一笔 → 等它自己变 → **原地**框住 → 手柄出现、能拖')
{
  /* ★★ 清场用**重开一次夹具板**（应用自己的读盘那条路），不用"撤 N 次"。
     ⚠ 为什么换：`wipeBoard()` 撤不干净 —— 实测撤完之后板上还剩 1 笔
       （`[12]` 那一串手势里有一次拖动被记成了**多步**，或者撤销栈被别的东西垫了底），
       于是这一节的框选**框住了两笔**，`shapeTarget`（要求"正好选中一个图形"）判空 →
       报出来是"框住图形却没有手柄"，而真因是"框里有两个东西"。
       ⇒ 要一个干净环境，最可靠的办法是**让应用自己读一遍盘**（`open()`）——
         它和用户重开这张板走的是同一条路，不依赖撤销栈里还剩多少。 */
  await open()
  /* ★★ 撤到干净为止，然后**问应用自己**"还剩几笔"（不是问 canvas 的 dataset）。
     ⚠ 这一条也是踩出来的：`canvas.bd-ink` 的 `dataset.strokes` 是**上一次重画**时报的数，
       可能落后一帧或一步；"到底还剩几笔"要问渲染出来的笔迹元素（`data-stroke-id`）。
       两个数不一样时，我要能一眼看出来是哪个错了 —— 所以两个都报。 */
  let wipe = { counted: -1, ink: -1, acts: true }
  for (let i = 0; i < 16; i++) {
    wipe = { counted: (await strokeIds()).length, ink: await inkCount(), acts: await inkActsOpen() }
    if (wipe.counted === 0 && !wipe.acts) break
    if (wipe.counted === 0) await s.key('Escape', 'Escape', 27)
    else await pressCtrlZ()
    await sleep(140)
  }
  /* ⚠⚠ **撤干净 ≠ 盘上干净**：撤销改的是内存里的板，写盘还有 700ms 防抖 ——
     而 `untilSaved()` 等的是"工具条说已存"，那一刻**上一次写盘的完成**就够了，
     它不保证"这一版还没落地的改动"已经写下去。
     实测（2026-09-19）：DOM 上明明是 0 笔，而**盘上那一笔（[12] 画的矩形）还在**，
     于是 `open()` 一重开就把它读回来 —— 这一节后面全在"板上有两笔"的环境里跑，
     报出来却是"框住图形却没有手柄"（真因是框里有两个东西）。
     ⇒ 清场要**写到盘上**才算数：直接 PUT 一份空板（应用自己那个接口，见 files.js 的 put）。 */
  const cleanText = serializeBoardDocument(
    (() => {
      const b = newBoard('形状规整自检夹具（跑完自动删除）')
      b.cards.push({ ...newCard('note', 3000, 3000), id: CARD_ID, text: '这张卡是参照物', w: 260, h: 70 })
      return b
    })()
  )
  await s.eval(`(() => fetch('/api/file/' + encodeURIComponent(${JSON.stringify(board.name)}), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: ${JSON.stringify(cleanText)} })
  }).then((r) => r.status))()`)
  await open()
  await untilSaved()
  const left = (await strokeIds()).length
  const actsStill = await inkActsOpen()
  if (left !== 0) {
    bad(`★ 重置夹具并把空板写回盘之后，板上还剩 ${left} 笔 —— 这一节的读数都会被搅混`)
  } else if (actsStill) {
    bad('★ 笔迹撤干净了，但**框选的浮层还开着**（.bd-inkacts 在）—— 它的按钮会接走落笔点')
  } else {
    ok('★ 清场干净：空板写回盘 → 重开 → 0 笔、没有浮层（这一节的起点和用户"开一张新板"一样）')
  }
  /* ★ 清完场**把盘上那一份也 dump 出来** —— "0 笔"和"打开之后又冒出 1 笔"之间的矛盾
     只有把两侧的数并排看才分得清（渲染出来的元素 vs 文件里的笔迹）。 */
  {
    const d = await read()
    const list = ((d && d.strokes) || []).map((st) => {
      const P = []
      for (let i = 0; i + 2 < (st.points || []).length; i += 3) P.push([st.points[i], st.points[i + 1]])
      const xs = P.map((q) => q[0])
      const ys = P.map((q) => q[1])
      return `${st.id}: ${P.length}点 ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)}×${(Math.max(...ys) - Math.min(...ys)).toFixed(0)}${st.shape ? '+' + st.shape.k : ''}`
    }).join(' ｜ ')
    console.log(`      （清完场之后**盘上**有：${list || '0 笔'}）`)
  }
  const c0 = clampToStage(stage.x + Math.min(300, stage.w * 0.28), stage.y + Math.min(240, stage.h * 0.34))
  const rW = 55
  const pts = screenCircle(c0.x, c0.y, rW, k)
  await pickTool('pen')
  const nBefore = await inkCount()
  /* ★★ 落笔之前**先问清楚三件事**（这一节第一版就是"画不上、却报成没认出形状"）：
       ① 板上真的是空的吗；② 工具真的切到笔了吗；③ 落点那一点上最上面的是谁。
       —— 三个读数缺一个，"画不上"就会被误读成"判读没放行"（README 反复记过的那一类）。 */
  const pre = await s.eval(`(() => {
    const tools = [...document.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool + (b.classList.contains('on') ? ':ON' : ':-')).join(' ')
    const p = document.elementFromPoint(${Math.round(pts[0].x)}, ${Math.round(pts[0].y)})
    return { tools, at: p ? String(p.className) : '' }
  })()`)
  console.log(`      画之前：板上 ${nBefore} 笔｜工具 ${pre.tools}｜落点 (${Math.round(pts[0].x)},${Math.round(pts[0].y)}) 上是「${pre.at}」`)
  await drawPath(pts, { pen: true })
  const nAfter = await inkCount()
  console.log(`      （画完：板上 ${nBefore} → ${nAfter} 笔；世界半径 ${rW}，屏幕 ${rW * k}px）`)

  /* ① 等它自己变（不点任何按钮、不碰任何工具）。 */
  const auto = await untilFile(
    (d) => (d.strokes || []).some((st) => st.shape && st.shape.k === 'ellipse'),
    { timeout: 6000, what: '收笔后自动规整' }
  )
  if (!auto.ok) {
    /* ★ 红了必须**分清是哪一半断的**（这一族最容易把"没画上"报成"没认出来"）：
       ① 笔没画上 → 后面全都无从谈起；
       ② 画上了、但判读没放行（阈值）；
       ③ 判读放行了、但定时器被别的东西撤掉了。
       三个读数的分辨力全靠这里。 */
    const doc = await read()
    const list = ((doc && doc.strokes) || []).map((st) => {
      const n = (st.points || []).length / 3
      const P = []
      for (let i = 0; i + 2 < (st.points || []).length; i += 3) P.push([st.points[i], st.points[i + 1]])
      let diag = 0
      if (P.length > 1) {
        const xs = P.map((q) => q[0])
        const ys = P.map((q) => q[1])
        diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
      }
      return `${st.id}: ${n}点/对角线${diag.toFixed(0)}${st.shape ? '+' + st.shape.k : ''}`
    }).join(' ｜ ')
    bad(`★ 收笔之后 6 秒内它没有自己变规整 —— 这条路的第一半就不通。`
      + `｜画上了吗：${nBefore} → ${nAfter} 笔（期望 +1）`
      + `｜盘上现在：${list || '(一笔都没有)'}`
      + `｜页面日志：${shapeLog().slice(-4).join(' ｜ ') || '（无）'}`)
    await shoot('用户路径：自动规整没发生')
  } else {
    const shaped = (auto.value.strokes || []).find((st) => st.shape)
    ok(`★ 收笔后它自己变成了图形（${shaped.shape.k} rx=${shaped.shape.rx}）`)
    const b1 = boxOfStroke(shaped)
    /* ② **原地**框住它：框按"这一笔自己的世界包围盒 + 余量"算，再用 canvas 变换换回屏幕。
       ⚠ 这一条量的是**用户的手**：他没挪过视野、没重开板，画完就在那儿框。 */
    const cx1 = await canvasXform()
    const S = (wx, wy) => ({ x: Math.round(wx * cx1.s + cx1.tx + cx1.ox), y: Math.round(wy * cx1.s + cx1.ty + cx1.oy) })
    const a1 = S(b1.x0, b1.y0)
    const b2 = S(b1.x1, b1.y1)
    const PAD = 26
    await selectRect(a1.x - PAD, a1.y - PAD, b2.x + PAD, b2.y + PAD)
    const hs = await frozenHandles()
    if (!hs || !hs.at.se) {
      const actsThere = await inkActsOpen()
      const selCount = await s.eval(`(() => {
        const b = document.querySelector('.bd-inkbox')
        return b ? 'inkbox 在' : 'inkbox 不在'
      })()`)
      bad(`★ ★ **原地框住那个图形之后没有出现手柄**（.bd-pickhandles ${hs ? '在但缺 se' : '不在'}）——`
        + ` 用户看到的就是"说好的能拖，可是没东西可拖"。`
        + `｜那一排动作在不在：${actsThere ? '在' : '不在'}｜${selCount}`
        + `｜板上 ${await inkCount()} 笔（框里若不止一笔，'正好选中一个图形'那条就不成立）`)
      await shoot('用户路径：框住图形却没有手柄')
    } else {
      ok(`★ ★ 手柄出现了（${Object.keys(hs.at).join(',')}）—— 用户能看见可拖的东西了`)
      /* ③ 真拖一下右下角：能拉大才算数。 */
      const ctr2 = S(b1.cx, b1.cy)
      const se = hs.at.se
      const anchor = hs.at.nw
      const target = { x: anchor.x + (se.x - anchor.x) * 1.6, y: anchor.y + (se.y - anchor.y) * 1.6 }
      await s.mouse(se.x, se.y, { steps: 8, dx: target.x - se.x, dy: target.y - se.y })
      await untilSaved()
      const doc = await read()
      const st = (doc.strokes || []).find((x) => x.id === shaped.id)
      const b3 = st ? boxOfStroke(st) : null
      if (b3 && b3.w > b1.w * 1.25) {
        ok(`★ ★ 拖右下角真的把它拉大了：${b1.w.toFixed(1)} → ${b3.w.toFixed(1)}（${(b3.w / b1.w).toFixed(2)} 倍）`)
        /* ⚠ 判据要按 kind 取那个形状**真正有的**字段：椭圆存的是 rx/ry（直径 = 2rx），
           矩形才是 w/h。第一版一律读 `shape.w` —— 椭圆上那是 `undefined`，
           于是报"shape 没跟上"，而其实两边一直是一致的（**读数取错了字段**，
           报出来却像"不变量破了"）。 */
        const shapeSpan = st.shape && (st.shape.k === 'ellipse' ? st.shape.rx * 2 : st.shape.w)
        if (typeof shapeSpan === 'number' && Math.abs(shapeSpan - b3.w) < 3) {
          ok(`  …而且 \`shape\` 参数跟着改了（${st.shape.k} 的跨度 ${shapeSpan.toFixed(1)}，和点算出来的 ${b3.w.toFixed(1)} 一致）`)
        } else {
          bad(`  …但 \`shape\` 没跟上：${JSON.stringify(st.shape)}（按 kind 取出来的跨度 ${shapeSpan}）vs 点算出来 ${b3.w.toFixed(1)}`)
        }
      } else {
        bad(`★ 拖了右下角却没变大：${b1.w.toFixed(1)} → ${b3 ? b3.w.toFixed(1) : '(读不出)'}`
          + `（起点 se=(${se.x.toFixed(0)},${se.y.toFixed(0)})，终点 (${target.x.toFixed(0)},${target.y.toFixed(0)})）`)
        await shoot('用户路径：拖角没有变大')
      }
      /* 顺手验它的"可见性"：手柄得真的画在屏幕上，不是只在 DOM 里。 */
      const painted = await s.eval(`(() => {
        const el = document.querySelector('[data-pick-handle="se"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return { w: Math.round(r.width), h: Math.round(r.height), top: top ? String(top.className) : '' }
      })()`)
      if (painted && painted.w > 4) {
        ok(`  …而且那颗柄在屏幕上是有大小的（${painted.w}×${painted.h}px，命中「${painted.top}」）`)
      } else {
        bad(`  …手柄在屏幕上量不到大小：${JSON.stringify(painted)}`)
      }
      void ctr2
    }
  }
}

/* ═══════════════════ 12f. **画个大的**也必须认出来 ═══════════════════
 *
 * ★★ 用户 2026-09-19：「当我的画的比较大的时候会识别不出来」。
 * 根因是判读里那道 `点数 / 对角线 ≥ 0.12`（详细账在 `shapes.js` 的 MIN_PT_DENSITY 位置）：
 * 分子（点数）与尺寸无关、分母随尺寸线性长 ⇒ **越大的图形越容易被它挡掉**。
 *
 * ⚠ 为什么这一条非得进真浏览器自检（纯逻辑那边 [6x] ③b 已经钉了尺寸序列）：
 *   纯逻辑用的是**我自己造的采样**（等分角度），而真手的采样是"按屏幕距离去重 + 抽稀"，
 *   两件事叠起来才决定最终点数和间距。用户板上那 24 笔就是真采样的产物
 *   （大笔 38~77 点、间距 13~24px）—— **只有真画一遍才能验到"输入侧"这一半**。
 */
console.log('\n[12f] 画个**大的**圆：一样要自己变规整、一样要出手柄')
{
  /* 清场（同 [12e]：空板写回盘 → 重开 → 断言 0 笔）。 */
  const cleanText2 = serializeBoardDocument(
    (() => {
      const b = newBoard('形状规整自检夹具（跑完自动删除）')
      b.cards.push({ ...newCard('note', 3000, 3000), id: CARD_ID, text: '这张卡是参照物', w: 260, h: 70 })
      return b
    })()
  )
  await s.eval(`(() => fetch('/api/file/' + encodeURIComponent(${JSON.stringify(board.name)}), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: ${JSON.stringify(cleanText2)} })
  }).then((r) => r.status))()`)
  await open()
  await untilSaved()

  /* 画布 1136×710、k=2 ⇒ 屏幕上能放下的最大圆半径约 300 屏幕像素 = **150 世界像素**。
     用户板上那些大笔是**世界**对角线 500~900，所以这里先量一个"在屏幕上画得下的最大圆"，
     再断言它认出来 —— 这就是"画得比较大"在自检里能得到的最接近的复现。
     ⚠ 落点用舞台中心，半径按 min(宽,高)/2 的 80% 算（留出不让它压到工具条/面板的余量）。 */
  const maxR = Math.floor(Math.min(stage.w, stage.h) * 0.4)
  const cBig = roundPt({ x: stage.x + stage.w * 0.42, y: stage.y + stage.h * 0.46 })
  const rScreen = maxR
  const rWorld = Math.round(rScreen / k)
  const bigPts = screenCircle(cBig.x, cBig.y, rWorld, k)
  await pickTool('pen')
  const n0 = await inkCount()
  await drawPath(bigPts, { pen: true })
  const n1 = await inkCount()
  console.log(`      画了一个大圆：屏幕半径 ${rScreen}px（世界 ${rWorld}）｜板上 ${n0} → ${n1} 笔`)
  if (n1 !== n0 + 1) {
    bad(`大圆没画上（${n0} → ${n1}）—— 这一条的读数不可信`)
  } else {
    const auto = await untilFile(
      (d) => (d.strokes || []).some((st) => st.shape && st.shape.k === 'ellipse'),
      { timeout: 8000, what: '大圆收笔后自动规整' }
    )
    if (!auto.ok) {
      const doc = await read()
      const list = ((doc && doc.strokes) || []).map((st) => {
        const P = []
        for (let i = 0; i + 2 < (st.points || []).length; i += 3) P.push([st.points[i], st.points[i + 1]])
        const xs = P.map((q) => q[0])
        const ys = P.map((q) => q[1])
        const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
        return `${P.length}点 对角线${diag.toFixed(0)} 密度${(P.length / diag).toFixed(3)}`
      }).join(' ｜ ')
      bad(`★ ★ **画得比较大的圆认不出来**（用户 2026-09-19 报的就是这个）——`
        + ` 盘上那一笔：${list || '(空)'}`
        + `｜屏幕半径 ${rScreen}px、世界 ${rWorld}（世界对角线该是 ${rWorld * 2}）`
        + `｜页面日志：${shapeLog().slice(-3).join(' ｜ ') || '（无）'}`)
      await shoot('大圆没被认出来')
    } else {
      const shaped = (auto.value.strokes || []).find((st) => st.shape)
      const b = boxOfStroke(shaped)
      ok(`★ ★ **大圆一样自己变规整了**（${shaped.shape.k} rx=${shaped.shape.rx}，`
        + `包围盒 ${b ? b.w.toFixed(0) + '×' + b.h.toFixed(0) : '?'}）`)
      /* 半径要对得上（世界半径 = 屏幕上画的 / k）—— 这是"它认得对"而不只是"它认了"。 */
      const rr = shaped.shape.rx
      if (Math.abs(rr - rWorld) / rWorld < 0.12) {
        ok(`…而且量得准：半径 ${rr.toFixed(1)}，我画的是 ${rWorld}（差 ${(Math.abs(rr - rWorld) / rWorld * 100).toFixed(1)}%）`)
      } else {
        bad(`…半径量偏了：${rr.toFixed(1)}，我画的是 ${rWorld}`)
      }
      /* 框住它 → 手柄（大图形也要能拖）。 */
      const cxb = await canvasXform()
      const S = (wx, wy) => ({ x: Math.round(wx * cxb.s + cxb.tx + cxb.ox), y: Math.round(wy * cxb.s + cxb.ty + cxb.oy) })
      const p0 = S(b.x0, b.y0)
      const p1 = S(b.x1, b.y1)
      /* ⚠ 框选要从**纸面空白**起手，而这个圆几乎占满画布 —— 余量只给 10px，
         并且夹进舞台（`selectRect` 自己也会夹）。 */
      await selectRect(p0.x - 10, p0.y - 10, p1.x + 10, p1.y + 10)
      const hs = await frozenHandles()
      if (hs && hs.at.se) ok(`…框住之后手柄也在（${Object.keys(hs.at).join(',')}）—— 大图形一样能拖`)
      else bad('…大圆框住之后**没有手柄**（大的图形也该能放大缩小）')
    }
  }
}

/* 盘上所有笔的**联合包围盒**（世界坐标）—— 判据只从数据算，不从屏幕反推。
   ★ [12g]/[12h] 都要用它（[12h] 还要拿它算"卡片的中心该跑到哪"）。 */
function unionBoxOf(doc, ids = null) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0
  for (const st of (doc && doc.strokes) || []) {
    if (ids && !ids.includes(st.id)) continue
    n++
    for (let i = 0; i + 2 < (st.points || []).length; i += 3) {
      x0 = Math.min(x0, st.points[i]); x1 = Math.max(x1, st.points[i])
      y0 = Math.min(y0, st.points[i + 1]); y1 = Math.max(y1, st.points[i + 1])
    }
  }
  if (!Number.isFinite(x0)) return null
  return { n, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}

/* 拖那颗旋转柄，绕 `ctr` 划 **rad** 弧度（默认 90°）。
 *
 * ⚠⚠ 为什么要**分段**、而且第一段要**极小**（这是 check-shape [12d] 当年
 *   "转完 rot 只变了 0.003 弧度"的另一半原因，2026-09-21 才想明白）：
 *   应用取的角度基准是"**第一次 move** 的角度"（按下那一刻指针贴在手柄上，
 *   杠杆太短，量出来的基准不稳 —— 见 Board.jsx 里那段）。
 *   所以如果第一段 move 就走到 7.5°，那 7.5° 会被当成"起点"，
 *   拖到 90° 时应用算出来只有 82.5° —— 屏幕上就是"转是转了，但差一点"，
 *   而断言按 90° 写就会红得莫名其妙。⇒ 第一段给 0.01 弧度把基准定住。 */
async function dragRotate(center, radiusVec, rad = Math.PI / 2, steps = 16, onMid = null) {
  const { x: vx, y: vy } = radiusVec
  const at = (t) => ({
    x: Math.round(center.x + vx * Math.cos(t) - vy * Math.sin(t)),
    y: Math.round(center.y + vx * Math.sin(t) + vy * Math.cos(t)),
  })
  const p0 = at(0)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p0.x, y: p0.y, pointerType: 'mouse' })
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' })
  const p1 = at(0.01)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p1.x, y: p1.y, button: 'left', buttons: 1, pointerType: 'mouse' })
  /* `onMid` 在**手势进行中**被叫一次（读"拖动中才该有的那些东西"，比如合成器提示）。 */
  if (onMid) await onMid()
  for (let i = 1; i <= steps; i++) {
    const p = at(0.01 + (i / steps) * (rad - 0.01))
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'mouse' })
  }
  const pe = at(rad)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pe.x, y: pe.y, button: 'left', clickCount: 1, buttons: 0, pointerType: 'mouse' })
  return pe
}

/* 拖动中卡片身上的"合成器提示"该是开的（README 第 53 条「大字体旋转时卡顿」）。
 * ★ 判据取的是 **computed style 的 `will-change`**，不是那个类名 —— 类挂上了、
 *   CSS 规则写错了（选择器对不上、被别的规则盖掉）时，只有 computed style 说得清。
 *   这类"接线断了但屏幕上只是有点卡"的毛病，正是这一族最容易静默失败的地方。 */
const willChangeOfCard = () => s.eval(`(() => {
  const el = document.querySelector('.bd-card')
  if (!el) return '(没有卡片)'
  return getComputedStyle(el).willChange || 'auto'
})()`)

/* ═══════════════════ 12g. **任意一撮字迹**：不是图形也要能放大、旋转 ═══════════════════
 *
 * ★★ 用户 2026-09-21：「框选中任意的字迹——卡片都应该能够放大，旋转，这点类似 onenote」。
 * 在这之前手柄只服务**一个规整过的图形**（`stroke.shape`）—— 普通手写（字、乱涂）
 * 身上一个手柄都不冒出来，用户看到的就是"我框住了字，可是没东西可拖"。
 * 这一节钉的就是"现在任意一撮都行"：
 *   ① 框住两笔**认不出形状**的短笔 → 手柄出现，而且认的是**这两笔**（不是别的）；
 *   ② 拖角能放大：两笔一起长，而且**锚点（对角）不动**；
 *   ③ **横竖分开拉** —— 这是 OneNote 那个手感：字被拉宽，不是整体等比；
 *   ④ 拖那颗圆的能转：包围盒宽高互换 = 它们真的转了（不是"看着像转了"）；
 *   ⑤ 一次拖动 = 一步 Ctrl+Z（拖十下也只退一次）。
 *
 * ⚠ 夹具里的两笔**必须认不出形状**（`shapes.js` 那道"弦长 ≥ 110 世界像素"的闸，
 *   外加 Board.jsx 收笔后那个自动规整的定时器）—— 不然半秒之后它们自己变规整，
 *   这一节就变成了在验 [12c]（图形那条路），而"任意字迹"那件事一点都没被验到。
 *   所以这里画的是一个 **= 号**：两横各 60 世界像素，远在闸门之下。
 */
console.log('\n[12g] 任意一撮字迹（认不出形状）：框住 → 手柄 → 能拉宽、能转')
{
  /* 清场（同 [12e]：空板写回盘 → 重开 → 断言 0 笔）。**必须写到盘上**，
     因为撤销只改内存，而 `open()` 会把盘上那一份读回来。 */
  const cleanText3 = serializeBoardDocument(
    (() => {
      const b = newBoard('形状规整自检夹具（跑完自动删除）')
      b.cards.push({ ...newCard('note', 3000, 3000), id: CARD_ID, x: 3000, y: 3000, text: '这张卡是参照物', w: 260, h: 70 })
      return b
    })()
  )
  await s.eval(`(() => fetch('/api/file/' + encodeURIComponent(${JSON.stringify(board.name)}), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: ${JSON.stringify(cleanText3)} })
  }).then((r) => r.status))()`)
  await open()
  await untilSaved()

  /* 盘上所有笔的**联合包围盒**（世界坐标）—— 判据只从数据算，不从屏幕反推。
     用的是文件级那个 `unionBoxOf`（[12h] 也要用同一份，别各写一个）。 */
  const unionBox = unionBoxOf

  /* ⚠ `clampToStage(x, y)` 收的是**两个数**，不是一个点对象 ——
     传对象进去 `Math.max` 会给出 NaN，而 NaN 在 CDP 里变成 `null`，
     报出来是一句 "double value expected"（查了半天才发现是尺子的问题）。 */
  const cg = clampToStage(stage.x + Math.min(240, stage.w * 0.2), stage.y + Math.min(300, stage.h * 0.4))
  /* ★★ 长度必须按**当前真实的缩放**算，不能用文件开头读的那个 `k`：
     这一节前面把夹具板重新 PUT + `open()` 过，而空板打开时的视图是**重新适配**出来的
     （`fitView` 对空内容给 s=1），`k` 早就不是这个数了。
     实测过一次：`L = 60 * k`（k=2）画出来是 **120 世界像素** ——
     正好越过 shapes.js 那道"弦长 < 110 不判直线"的闸，于是"夹具必须认不出形状"
     这条断言是靠运气绿的（下一台机器、换一档缩放就会红）。
     ⇒ 判据要用**从 canvas 读出来的**那个 s（`canvasXform`），不是记忆里的那个。 */
  const cxg = await canvasXform()
  const L = Math.round(60 * cxg.s)   // 一横 60 **世界**像素（远小于判读的 110 闸门）
  const gap = Math.round(30 * cxg.s)
  await pickTool('pen')
  const nBefore = await inkCount()
  await drawPath(screenLine(cg.x, cg.y, cg.x + L, cg.y))
  await drawPath(screenLine(cg.x, cg.y + gap, cg.x + L, cg.y + gap))
  /* 等"收笔自动规整"那个定时器跑完（半秒 + 余量）—— 它要是真把它们认成了图形，
     下面那条断言会红，而那正是我要知道的（夹具不干净）。 */
  await sleep(1200)
  await untilSaved()
  const nAfter = await inkCount()
  const doc0 = await read()
  const strokes0 = ((doc0 && doc0.strokes) || []).filter((st) => st.id !== undefined)
  const withShape = strokes0.filter((st) => st.shape)
  if (nAfter !== nBefore + 2) {
    bad(`★ 两笔没画上（${nBefore} → ${nAfter}）—— 这一节的读数不可信`)
  } else if (withShape.length) {
    bad(`★ 夹具不干净：这两笔里有一笔被自动规整成了图形（${withShape.map((s) => s.shape.k).join(',')}）——`
      + ` 那这一节验的就不是"任意字迹"了，把笔画短一点（现在每横 ${Math.round(L / k)} 世界像素）`)
  } else {
    ok(`★ 夹具就位：两笔普通墨迹（每横 ${Math.round(L / cxg.s)} 世界像素、共 ${strokes0.length} 笔），**一笔都没被认成图形**`)
    const ids0 = strokes0.map((s) => s.id)
    const b0 = unionBox(doc0, ids0)

    /* ── ① 框住这两笔 → 手柄出现，而且认的是它们 ─────────────────────────── */
    const cxa = await canvasXform()
    const S = (wx, wy) => ({ x: Math.round(wx * cxa.s + cxa.tx + cxa.ox), y: Math.round(wy * cxa.s + cxa.ty + cxa.oy) })
    const PAD = 26
    const pa = S(b0.x0, b0.y0)
    const pb = S(b0.x1, b0.y1)
    await selectRect(pa.x - PAD, pa.y - PAD, pb.x + PAD, pb.y + PAD)
    let hs = await frozenHandles()
    if (!hs || !hs.at.se || !hs.at.rot) {
      bad(`★ ★ 框住两笔**普通字迹**之后没有手柄（.bd-pickhandles ${hs ? '在但缺柄' : '不在'}）——`
        + ` 用户 2026-09-21 要的正是这个：「框选中任意的字迹……都应该能够放大，旋转」`)
      await shoot('任意字迹：框住之后没有手柄')
    } else {
      ok(`★ 五个手柄都在（${Object.keys(hs.at).join(',')}）—— 这一次框住的**不是图形**，是两笔普通墨迹`)
      const wantLabel = [...ids0].sort().join(',')
      const gotLabel = String(hs.label || '').split(',').filter(Boolean).sort().join(',')
      if (gotLabel === wantLabel) ok(`  …而且它们认的正是**这两笔**（data-pick-handles = ${hs.label}）`)
      else bad(`  …手柄认的笔不对：data-pick-handles="${hs.label}"，期望 "${wantLabel}"`)

      /* ── ② 拖右下角放大 1.6 倍（锚点 = 左上角）────────────────────────── */
      const se = hs.at.se
      const anchorS = hs.at.nw
      let target = { x: anchorS.x + (se.x - anchorS.x) * 1.6, y: anchorS.y + (se.y - anchorS.y) * 1.6 }
      await s.mouse(se.x, se.y, { steps: 12, dx: target.x - se.x, dy: target.y - se.y })
      await untilSaved()
      const doc1 = await read()
      const b1 = unionBox(doc1, ids0)
      if (!b1) {
        bad('★ 拉完之后那两笔读不出来了')
      } else {
        const gx = b1.w / b0.w
        const gy = b1.h / b0.h
        if (Math.abs(gx - 1.6) < 0.15 && Math.abs(gy - 1.6) < 0.15) {
          ok(`★ ★ 拖角把**两笔一起**拉大了：${b0.w.toFixed(1)}×${b0.h.toFixed(1)} → ${b1.w.toFixed(1)}×${b1.h.toFixed(1)}（${gx.toFixed(2)} × ${gy.toFixed(2)}）`)
        } else {
          bad(`★ 拖角缩放没生效或倍率不对：${b0.w.toFixed(1)}×${b0.h.toFixed(1)} → ${b1.w.toFixed(1)}×${b1.h.toFixed(1)}`
            + `（${gx.toFixed(2)} × ${gy.toFixed(2)}，期望 ≈ 1.6）`)
          await shoot('任意字迹：拖角没生效')
        }
        if (Math.abs(b1.x0 - b0.x0) < 2 && Math.abs(b1.y0 - b0.y0) < 2) ok('  …而且**锚点那一点没动**（左上角还钉在原处）')
        else bad(`  …锚点跑了：(${b0.x0.toFixed(1)},${b0.y0.toFixed(1)}) → (${b1.x0.toFixed(1)},${b1.y0.toFixed(1)})`)
        /* ★ 一次拖动 = 一步撤销（拖了 12 步，撤销只要一下）。 */
        await pressCtrlZ()
        await untilSaved()
        const b1r = unionBox(await read(), ids0)
        if (b1r && Math.abs(b1r.w - b0.w) < 2 && Math.abs(b1r.h - b0.h) < 2) {
          ok(`  ★ 一次 Ctrl+Z 退回拉之前（${b1r.w.toFixed(1)}×${b1r.h.toFixed(1)}）—— 一次拖动 = 一步撤销`)
        } else {
          bad(`  ★ Ctrl+Z 没退干净：${b1r ? b1r.w.toFixed(1) + '×' + b1r.h.toFixed(1) : '(读不出)'}，期望 ${b0.w.toFixed(1)}×${b0.h.toFixed(1)}`)
        }
      }

      /* ── ③ 横竖分开拉：这一条才是"类似 OneNote"里最要紧的那半 ──────────── */
      hs = await frozenHandles()
      if (hs && hs.at.ne) {
        const ne = hs.at.ne
        const nwS = hs.at.nw
        target = { x: nwS.x + (ne.x - nwS.x) * 2, y: ne.y }   // 只往右拉，竖直不动
        await s.mouse(ne.x, ne.y, { steps: 10, dx: target.x - ne.x, dy: 0 })
        await untilSaved()
        const b2 = unionBox(await read(), ids0)
        if (b2) {
          const gx2 = b2.w / b0.w
          const gy2 = b2.h / b0.h
          if (Math.abs(gx2 - 2) < 0.2 && Math.abs(gy2 - 1) < 0.12) {
            ok(`★ ★ 横竖**分开拉**：只往右拉 → 宽 ${gx2.toFixed(2)} 倍、高 ${gy2.toFixed(2)} 倍（字被拉宽了，不是整体等比）`)
          } else {
            bad(`★ 分轴缩放不对：宽 ${gx2.toFixed(2)} 倍、高 ${gy2.toFixed(2)} 倍（期望 ≈ 2 × 1）`)
            await shoot('任意字迹：分轴缩放不对')
          }
        }
        await pressCtrlZ()
        await untilSaved()
        const b2r = unionBox(await read(), ids0)
        if (b2r && Math.abs(b2r.w - b0.w) < 2 && Math.abs(b2r.h - b0.h) < 2) ok('  ★ 一次 Ctrl+Z 也退回来了')
        else bad(`  ★ 分轴那一次没退干净：${b2r ? b2r.w.toFixed(1) + '×' + b2r.h.toFixed(1) : '(读不出)'}`)
      } else {
        bad('★ 读不到 ne 那颗角柄 —— 分轴缩放这一条验不了')
      }

      /* ── ④ 转 90°：包围盒宽高互换 ─────────────────────────────────────── */
      hs = await frozenHandles()
      if (hs && hs.at.rot && hs.at.nw && hs.at.se) {
        const rot = hs.at.rot
        const ctr = { x: (hs.at.nw.x + hs.at.se.x) / 2, y: (hs.at.nw.y + hs.at.se.y) / 2 }
        /* 起点相对中心的向量转 +90°（屏幕 y 向下 ⇒ 正角是顺时针）。
           ⚠ 分段 + 极小第一段这件事收在 `dragRotate` 里（理由见它的注释）。 */
        await dragRotate(ctr, { x: rot.x - ctr.x, y: rot.y - ctr.y }, Math.PI / 2)
        await untilSaved()
        const b3 = unionBox(await read(), ids0)
        if (!b3) {
          bad('★ 转完之后那两笔读不出来了')
        } else {
          /* 转过 90° 之后：宽高互换（容差给 20%：笔画有粗细、量化有 1/10 像素）。 */
          const swapped = Math.abs(b3.w - b0.h) / b0.h < 0.2 && Math.abs(b3.h - b0.w) / b0.w < 0.2
          if (swapped) {
            ok(`★ ★ 拖那颗圆的转了 90°：包围盒 ${b0.w.toFixed(1)}×${b0.h.toFixed(1)} → ${b3.w.toFixed(1)}×${b3.h.toFixed(1)}（宽高互换 = 真的转了）`)
          } else {
            bad(`★ 旋转没生效或角度不对：${b0.w.toFixed(1)}×${b0.h.toFixed(1)} → ${b3.w.toFixed(1)}×${b3.h.toFixed(1)}`
              + `（转 90° 后期望 ≈ ${b0.h.toFixed(1)}×${b0.w.toFixed(1)}）`
              + `｜data-last-grab=${await s.eval(`(() => { const b = document.querySelector('.bd-pickhandles'); return b ? (b.dataset.lastGrab || '') : null })()`)}`)
            await shoot('任意字迹：旋转没生效')
          }
          /* 转轴是包围盒中心 → 中心那一点不该跑。 */
          if (Math.hypot(b3.cx - b0.cx, b3.cy - b0.cy) < 3) ok('  …而且绕的是**选区中心**（中心那一点没跑）')
          else bad(`  …中心跑了：(${b0.cx.toFixed(1)},${b0.cy.toFixed(1)}) → (${b3.cx.toFixed(1)},${b3.cy.toFixed(1)})`)
          await pressCtrlZ()
          await untilSaved()
          const b3r = unionBox(await read(), ids0)
          if (b3r && Math.abs(b3r.w - b0.w) < 2 && Math.abs(b3r.h - b0.h) < 2) ok('  ★ 一次 Ctrl+Z 退回转之前')
          else bad(`  ★ 旋转那一次没退干净：${b3r ? b3r.w.toFixed(1) + '×' + b3r.h.toFixed(1) : '(读不出)'}`)
        }
      } else {
        bad('★ 读不到旋转柄 —— 旋转这一条验不了')
      }
    }
  }
}

/* ═══════════════════ 12h. **卡片**也进框选：跟着一起放大、还能转 ═══════════════════
 *
 * ★★ 同一条需求的后半句：「框选中任意的字迹——**卡片**都应该能够放大，旋转」。
 * 在这之前框选**只收笔迹**（卡片是另一种选中：点它、拖右下角那个柄）—— 于是
 * "把这一块（字 + 卡）当成一个东西"这件事做不到，而 OneNote 里那正是最自然的一下。
 *
 * 这一节钉五条，每条都是"坏了也不会报错、只是屏幕上慢慢不对"的类型：
 *   ① 框选把卡片一起收进来（`data-pick-cards` 说得出来是哪一张）；
 *   ② 放大：**笔迹分轴、卡片等比**（卡片的内容是文字，`w` 是硬约束，拉窄了当场裁内容）；
 *   ③ 转：卡片的 `rot` 真的写进板文件（重开之后它还是斜的）；
 *   ④ 卡片身上**真的有那个 CSS 变换**（`rotate(...)`）—— "数据里有 rot"和"屏幕上斜着"
 *      是两件事，中间隔着一个 style（这个仓库最贵的一类 bug 就是"每一半都对、合起来是坏的"）；
 *   ⑤ Delete 把**笔迹和卡片一起**删掉（只删一半 = "删除做了一半"）；
 *   ⑥ 固定（📌）住的卡片**框不进来**（那是它的全部意思："别动我"）。
 */
console.log('\n[12h] 卡片也进框选：一起放大、一起转、一起删；钉住的不收')
{
  const CARD_PICK = 'pick-card'
  /* 夹具：一张卡 + 世界视图**钉死**（`viewPinned: true`）——
     不钉的话 `open()` 会按内容自动适配，卡片的屏幕位置就随内容变，
     而这一节要拿"卡片的屏幕矩形"去画框。 */
  const fixture = (() => {
    const b = newBoard('形状规整自检夹具（跑完自动删除）')
    b.viewPinned = true
    b.view = { s: 2, tx: 40, ty: 30 }
    b.cards.push({ ...newCard('note', 0, 0, { w: 200, h: 90 }), id: CARD_PICK, x: 120, y: 90, text: '一起转' })
    return serializeBoardDocument(b)
  })()
  const putFixture = async (text) => {
    await s.eval(`(() => fetch('/api/file/' + encodeURIComponent(${JSON.stringify(board.name)}), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ${JSON.stringify(text)} })
    }).then((r) => r.status))()`)
    await open()
    await untilSaved()
  }
  await putFixture(fixture)

  /* 卡片在屏幕上的矩形：世界矩形 × 视图（走 canvas 自己那份变换，见 canvasXform）。
     卡片的世界矩形 = x/y 加上 w×scale（这里 scale=1）。 */
  const cardScreen = async () => {
    const cx = await canvasXform()
    const d = await read()
    const c = (d.cards || []).find((x) => x.id === CARD_PICK)
    if (!c) return null
    const sc = Number(c.scale) > 0 ? Number(c.scale) : 1
    const w = c.w * sc
    const h = c.h * sc
    return { c, sc, left: c.x * cx.s + cx.tx + cx.ox, top: c.y * cx.s + cx.ty + cx.oy, w: w * cx.s, h: h * cx.s, s: cx.s }
  }
  const cs0 = await cardScreen()
  if (!cs0) {
    bad('★ 夹具里的卡片读不出来 —— 这一节全废')
  } else {
    /* 在卡片**下面**画一笔普通墨迹（它也会被框进来）。
       ⚠ 长度按**真实缩放**（`cs0.s`）算，不用文件开头那个 `k` —— 理由见 [12g] 那段。 */
    await pickTool('pen')
    const sx = Math.round(cs0.left + cs0.w * 0.2)
    const sy = Math.round(cs0.top + cs0.h + 50)
    await drawPath(screenLine(sx, sy, sx + Math.round(90 * cs0.s), sy))
    await sleep(1200)
    await untilSaved()
    const doc0 = await read()
    const strokeId = ((doc0.strokes || [])[0] || {}).id

    /* ── ① 框住"卡片 + 那一笔" ─────────────────────────────────────────── */
    await selectRect(
      Math.min(cs0.left, sx) - 24,
      Math.min(cs0.top, sy) - 24,
      Math.max(cs0.left + cs0.w, sx + 90 * k) + 24,
      Math.max(cs0.top + cs0.h, sy) + 24
    )
    let hs = await frozenHandles()
    if (!hs || !hs.at.se) {
      bad('★ 框住"卡片 + 一笔字"之后没有手柄 —— 卡片那一半没被收进选区')
      await shoot('卡片：框住之后没有手柄')
    } else if (String(hs.cards || '') !== CARD_PICK) {
      bad(`★ 卡片没进选区：data-pick-cards="${hs.cards}"，期望 "${CARD_PICK}"（笔迹那半是 "${hs.label}"）`)
      await shoot('卡片没进选区')
    } else {
      ok(`★ 卡片进了选区（data-pick-cards=${hs.cards}、笔迹 ${hs.label}）—— 一次框选把两样都收进来了`)

      /* ── ①b 按着**卡片**拖 = 拖整块（2026-09-21 补的那条路）────────────────
         卡片自己收指针事件（它比 `.bd-hit` 高一层），所以"按在卡片上"到不了
         Board 里那个整组拖动的分支 —— 不接这条路的话，症状就是
         「框住字 + 卡，按着卡拖，只有卡动了」= **拖散了**。 */
      {
        const docA = await read()
        const stA = (docA.strokes || [])[0]
        const cA = (docA.cards || []).find((x) => x.id === CARD_PICK)
        const px = Math.round(cs0.left + cs0.w / 2)
        const py = Math.round(cs0.top + cs0.h / 2)
        /* ★ 先把"最近的设备"切回**鼠标**：卡片在笔的模式下整个让开指针事件
           （`.bd.penink .bd-card { pointer-events: none }`，见「卡片和笔：谁让谁」）——
           这一节前面那一笔是用**笔**画的。不切回来的话，按在卡片上那一下会落到纸面上
           （那也照样能拖整块，但验的就不是"卡片这条路"了）。 */
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, pointerType: 'mouse' })
        await sleep(140)
        const onCard = await s.eval(`(() => { const el = document.elementFromPoint(${px}, ${py}); return el ? String(el.className) : '' })()`)
        const DX = 90
        const DY = 60
        await s.drag(px, py, DX, DY, { steps: 8, button: 'left' })
        await untilSaved()
        const docB = await read()
        const stB = (docB.strokes || []).find((x) => x.id === stA.id)
        const cB = (docB.cards || []).find((x) => x.id === CARD_PICK)
        const wantDx = DX / cs0.s
        const wantDy = DY / cs0.s
        const cardMoved = cB && Math.abs(cB.x - cA.x - wantDx) < 3 && Math.abs(cB.y - cA.y - wantDy) < 3
        const strokeMoved = stB && Math.abs(stB.points[0] - stA.points[0] - wantDx) < 3 && Math.abs(stB.points[1] - stA.points[1] - wantDy) < 3
        if (cardMoved && strokeMoved) {
          ok(`  ★ ★ 按着**卡片**拖 = 拖**整块**（卡片和笔迹一起挪了 ${wantDx.toFixed(0)},${wantDy.toFixed(0)} 世界像素；落点是「${onCard}」）`)
        } else {
          bad(`  ★ 按着卡片拖没有把整块带走：卡片${cardMoved ? '跟上了' : '**没跟上**'}、笔迹${strokeMoved ? '跟上了' : '**没跟上**'}`
            + `（落点是「${onCard}」，期望是 bd-card 那一族）`)
          await shoot('按着卡片拖没带走整块')
        }
        await pressCtrlZ()
        await untilSaved()
        const docC = await read()
        const cC = (docC.cards || []).find((x) => x.id === CARD_PICK)
        if (cC && Math.abs(cC.x - cA.x) < 2 && Math.abs(cC.y - cA.y) < 2) ok('  …而且一次 Ctrl+Z 就整块退回去了（一次拖动 = 一步撤销）')
        else bad('  …那次整块拖动没退干净')
        hs = await frozenHandles()
      }

      /* 按下那一刻的选区外框（世界坐标）：**锚点是它的左边**（拖 ne ⇒ 锚点 = 左下角）。
         ⚠ 别拿"视图的 tx"当锚点 —— 那是屏幕映射的常数，和这一次拖动的锚点是两回事
           （第一版就是这么写的，于是"卡片中心该跑到哪"算错了一整段）。 */
      const sel0 = unionBoxOf(doc0, null)
      const cardRect0 = (() => {
        const c = (doc0.cards || []).find((x) => x.id === CARD_PICK)
        const sc = Number(c.scale) > 0 ? Number(c.scale) : 1
        return { x: c.x, y: c.y, w: c.w * sc, h: c.h * sc, cx: c.x + (c.w * sc) / 2, cy: c.y + (c.h * sc) / 2 }
      })()
      const selBox = (() => {
        const x0 = Math.min(sel0.x0, cardRect0.x)
        const y0 = Math.min(sel0.y0, cardRect0.y)
        const x1 = Math.max(sel0.x1, cardRect0.x + cardRect0.w)
        const y1 = Math.max(sel0.y1, cardRect0.y + cardRect0.h)
        return { x0, y0, x1, y1 }
      })()
      const anchor = { x: selBox.x0, y: selBox.y1 }

      /* ── ② 横向拉 2 倍：笔迹拉宽，卡片只等比（几何平均 √2）───────────── */
      const ne = hs.at.ne
      const nwS = hs.at.nw
      const target = { x: nwS.x + (ne.x - nwS.x) * 2, y: ne.y }
      await s.mouse(ne.x, ne.y, { steps: 10, dx: target.x - ne.x, dy: 0 })
      await untilSaved()
      const doc1 = await read()
      const c1 = (doc1.cards || []).find((x) => x.id === CARD_PICK)
      const st0 = (doc0.strokes || [])[0]
      const st1 = (doc1.strokes || []).find((x) => x.id === strokeId)
      const spanX = (st) => {
        let a = Infinity, b = -Infinity
        for (let i = 0; i + 2 < (st.points || []).length; i += 3) { a = Math.min(a, st.points[i]); b = Math.max(b, st.points[i]) }
        return b - a
      }
      const spanY = (st) => {
        let a = Infinity, b = -Infinity
        for (let i = 0; i + 2 < (st.points || []).length; i += 3) { a = Math.min(a, st.points[i + 1]); b = Math.max(b, st.points[i + 1]) }
        return b - a
      }
      if (c1 && st1) {
        const gx = spanX(st1) / spanX(st0)
        const gy = spanY(st1) / spanY(st0)
        if (Math.abs(gx - 2) < 0.2 && gy < 1.12) ok(`  ★ 笔迹横着拉了 ${gx.toFixed(2)} 倍、竖着 ${gy.toFixed(2)} 倍（分轴）`)
        else bad(`  ★ 笔迹那半的分轴缩放不对：${gx.toFixed(2)} × ${gy.toFixed(2)}（期望 ≈ 2 × 1）`)
        if (Math.abs(c1.scale - Math.SQRT2) < 0.06) ok(`  ★ ★ 卡片走**几何平均**：scale ${doc0.cards[0].scale} → ${c1.scale.toFixed(3)}（√2 ≈ 1.414）`)
        else bad(`  ★ 卡片的倍率不对：${c1.scale}（期望 √2 ≈ 1.414）`)
        if (c1.w === doc0.cards[0].w) ok(`  …而且卡片的**布局宽一个字没动**（${c1.w}）—— 文字不会因为拉伸而重折行`)
        else bad(`  …卡片的 w 被改了：${doc0.cards[0].w} → ${c1.w}（那会让文字重折行）`)
        /* 卡片中心跟着**完整的 fx/fy** 走（不是只按等比那一下）。 */
        const wantCx = anchor.x + (cardRect0.cx - anchor.x) * 2
        const gotCx = c1.x + (c1.w * c1.scale) / 2
        if (Math.abs(gotCx - wantCx) < 3) ok(`  …卡片中心按 x 轴那 2 倍走了（${cardRect0.cx.toFixed(1)} → ${gotCx.toFixed(1)}，期望 ≈ ${wantCx.toFixed(1)}）`)
        else bad(`  …卡片中心没跟着变换走：${gotCx.toFixed(1)}，期望 ≈ ${wantCx.toFixed(1)}`)
      } else {
        bad('★ 拉完之后卡片或那一笔读不出来')
      }
      await pressCtrlZ()
      await untilSaved()

      /* ── ③④ 转 90°：卡片的 rot 落盘 + 屏幕上真的有那个变换 ────────────── */
      hs = await frozenHandles()
      if (hs && hs.at.rot && hs.at.nw && hs.at.se) {
        const rot = hs.at.rot
        const ctr = { x: (hs.at.nw.x + hs.at.se.x) / 2, y: (hs.at.nw.y + hs.at.se.y) / 2 }
        /* 拖动**中**量一次合成器提示（松手之后要撤掉，所以两个方向都要断言）。 */
        let wcDuring = null
        await dragRotate(ctr, { x: rot.x - ctr.x, y: rot.y - ctr.y }, Math.PI / 2, 16, async () => {
          wcDuring = await willChangeOfCard()
        })
        await untilSaved()
        if (wcDuring === 'transform') {
          ok('  ★ 拖动**中**卡片带着合成器提示（computed will-change = transform）—— 大卡片旋转不卡就靠它')
        } else {
          bad(`  ★ 拖动中卡片的 will-change 是「${wcDuring}」（期望 transform）——`
            + ` 那一行 CSS 没接上：大字号卡片旋转会每帧重画整张卡（README 第 53 条）`)
        }
        const wcAfter = await willChangeOfCard()
        if (wcAfter === 'auto') ok('  …松手之后提示撤掉了（合成层不常驻：每张卡一份位图内存，常挂会白吃显存）')
        else bad(`  …松手之后 will-change 还是「${wcAfter}」—— 合成层没撤，多张卡时显存会涨`)
        const doc2 = await read()
        const c2 = (doc2.cards || []).find((x) => x.id === CARD_PICK)
        const rot2 = c2 ? Number(c2.rot) || 0 : 0
        if (Math.abs(Math.abs(rot2) - Math.PI / 2) < 0.12) ok(`★ ★ 卡片转过去了：文件里 \`rot\` = ${rot2.toFixed(3)}（≈ π/2 = 1.571）`)
        else bad(`★ 卡片的 rot 不对：${rot2}（期望 ≈ ±1.571）｜data-last-grab=${await s.eval(`(() => { const b = document.querySelector('.bd-pickhandles'); return b ? (b.dataset.lastGrab || '') : null })()`)}`)
        /* ★ 数据里有 rot ≠ 屏幕上斜着：中间隔着一个 CSS 变换，只有 DOM 说得清。 */
        const dom = await s.eval(`(() => {
          const el = document.querySelector('[data-card-id="${CARD_PICK}"]')
          if (!el) return null
          const cs = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return { transform: cs.transform, w: Math.round(r.width), h: Math.round(r.height), inline: el.style.transform || '' }
        })()`)
        if (dom && /matrix|rotate/.test(String(dom.inline))) {
          ok(`  ★ 而且卡片身上真的有那个变换（style.transform = ${dom.inline}）—— 屏幕上它真的斜了`)
          /* 转过 90° 之后外接框该"横着的变竖着的"（200×90 → 90×200 那一族）。 */
          if (dom.h > dom.w) ok(`  …外接框也跟着竖过来了（${dom.w}×${dom.h}，卡本来是横的）`)
          else bad(`  …外接框还是横的（${dom.w}×${dom.h}）—— 变换可能没生效`)
        } else {
          bad(`  ★ 卡片身上**没有**旋转变换（style.transform = ${dom && dom.inline}）——"数据里有 rot、屏幕上没斜"就是这么来的`)
          await shoot('卡片的旋转变换没落到 DOM 上')
        }

        /* ── ⑤ Delete：笔迹和卡片一起删 ──────────────────────────────── */
        await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
        await sleep(300)
        await untilSaved()
        const doc3 = await read()
        const leftStrokes = (doc3.strokes || []).length
        const cardGone = !(doc3.cards || []).some((x) => x.id === CARD_PICK)
        if (leftStrokes === 0 && cardGone) ok('★ ★ Delete 把**笔迹和卡片一起**删了（只删一半 = "删除做了一半"）')
        else bad(`★ Delete 只删了一半：还剩 ${leftStrokes} 笔、卡片${cardGone ? '已删' : '**还在**'}`)
      } else {
        bad('★ 读不到旋转柄 —— 卡片旋转这一条验不了')
      }
    }
  }

  /* ── ⑥ 固定（📌）住的卡片框不进来 ─────────────────────────────────────── */
  {
    const lockedText = serializeBoardDocument(
      (() => {
        const b = newBoard('形状规整自检夹具（跑完自动删除）')
        b.viewPinned = true
        b.view = { s: 2, tx: 40, ty: 30 }
        b.cards.push({ ...newCard('note', 0, 0, { w: 200, h: 90 }), id: CARD_PICK, x: 120, y: 90, text: '钉住的', locked: true })
        return b
      })()
    )
    await putFixture(lockedText)
    const csL = await cardScreen()
    if (!csL) {
      bad('★ 钉住的那张卡读不出来')
    } else {
      await selectRect(csL.left - 20, csL.top - 20, csL.left + csL.w + 20, csL.top + csL.h + 20)
      const hs2 = await frozenHandles()
      if (hs2 && String(hs2.cards || '').includes(CARD_PICK)) {
        bad('★ 固定（📌）住的卡片被框进来了 —— 那正是它要防的误触（README 第 19 条："锁上之后选不中"）')
        await shoot('钉住的卡片被框选了')
      } else {
        ok('★ 固定住的卡片框不进来（一个手柄都没有）—— 📌 的意思就是"别动我"')
      }
    }
  }
}

/* ═══════════════════ 13. 整个流程没有 JS 报错 ═══════════════════ */
console.log('\n[13] 整个流程跑下来，页面里没有任何 JS 报错')
if (!s.exceptions.length) ok('没有报错 —— "处理器抛异常"和"处理器没跑"在屏幕上是同一个样子，所以这条是兜底')
else bad(`页面里有 ${s.exceptions.length} 条报错：` + s.exceptions.slice(0, 3).join(' ｜ '))
})

