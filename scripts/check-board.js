/* 白板数据层 + 公式转化的自检（纯 node，不开浏览器、不起服务）。
 *
 * 这一层为什么值得写自检：它坏起来是"静默错"。吸附吸错一张卡、孤岛数错一个、
 * 公式转化把 mu_0 越改越长——在屏幕上看着都挺正常，等你复习的时候才发现
 * 关系和当初想的不一样。所以这里断言的都是**不变量**，不是"跑通就行"。
 *
 * 跑：npm run check:board
 */
import {
  CARD_FONTS, CARD_FONT_IDS, CARD_FIT_MIN_W, CARD_MAX_SCALE, CARD_MAX_W, CARD_MIN_H,
  CARD_MIN_SCALE, CARD_MIN_W, DEFAULT_CARD_FONT, DEFAULT_CARD_SCALE, DEFAULT_CARD_SIZE, TEXT_CARD_MAX_W,
  TEXT_CARD_LINE_H, TEXT_CARD_MIN_W, TEXT_CARD_PAD_Y, cardHeightFromContent, cardWidthFromContent, clampCardScale,
  freezeGroup, fontCss, isBoardDocument, isBoardName, newBoard, newCard,
  newStroke, nextCardScale, parseBoardDocument, serializeBoardDocument, textCardRect,
} from '../src/lib/board.js'
/* 点 / 几何 / 关系搬去了 geometry.js（2026-09-16 架构 review 的 C5）。 */
import { NEAR_GAP, READABLE_FIT_S, buildRelations, descendantsOf, fitView, pointSegDist, relationCurve, simplifyPoints, strokeBounds, strokeHitsCircle, toFlat, toPoints } from '../src/lib/geometry.js'
/* 连接读法（reader / 墨迹块 / 形状判据 / 各种阈值）搬去了 links.js。 */
import {
  TIP_MAX_ANGLE, createLinkReader, classifyLinkShape, chainOfStroke, deriveChains, findTip,
  inkBlocks, inkNodeAt, createInkIndex, readArrowHead, tipNearEnd,
} from '../src/lib/links.js'
/* 关系的词表在 link-kinds.js（board.js 不再转发）。 */
import { COND_NONE, LINK_NONE } from '../src/lib/link-kinds.js'
/* 卡片「按内容量尺寸」那一套规矩搬去了 card-fit.js（2026-09-16）：DOM 读数是注入的，
   所以"提交完不能立刻再量"这类坑在这儿断言得到（见 [6l]）。 */
import { FIT_TOL_AUTO, createCardFitter, fitPass } from '../src/lib/card-fit.js'
/* 选中这一族（框住的笔意味着什么 + 改词/反向/否决/回头路/固定/拆开）搬去了 selection.js
   （2026-09-16）：纯函数、有断言（见 [6m]）。 */
import {
  applyStrokeLink, clearNoLinkMarks, dissolveGroup, freezeSelection, readSelection, removeStrokes,
} from '../src/lib/selection.js'
/* 板文件这一步（data/ 的读写 + 打开哪一个）搬去了 files.js（2026-09-16 C4）：
   "打开哪一个"是一个纯决定，于是那些入口情形在这儿断言得到（见 [6n]）。 */
import { SEED_BOARD_NAME, boardFileName, createFileApi, nextBoardName, planStartup } from '../src/lib/files.js'
/* 视图映射搬去了 src/lib/view.js（2026-09-16）：自检从这里 import，和 app 走同一个 module。 */
import { applyViewTo, centerOn, clampViewScale, panBy, screenToWorld, viewTransformAttr, worldRectToScreen, worldToScreen, zoomAt, zoomBetween } from '../src/lib/view.js'
import { readFileSync } from 'node:fs'
import { displayTex, snippetFor, toTex } from '../src/lib/formula.js'

/* 连接那一层只从这个入口进（module 自己的 internal seam 另说）——见 board.js 的注释。 */
const reader = createLinkReader()

let fails = 0
let checks = 0
const bad = (msg) => {
  fails++
  console.log('  ✗ ' + msg)
}
const ok = (msg) => {
  checks++
  console.log('  ✓ ' + msg)
}
function eq(got, want, label) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(`${label}  →  ${g}`)
  else bad(`${label}\n      实际 ${g}\n      期望 ${w}`)
}
function near(got, want, tol, label) {
  if (Math.abs(got - want) <= tol) ok(`${label}  →  ${round(got)}（容差 ${tol}）`)
  else bad(`${label}：实际 ${round(got)}，期望 ${want} ± ${tol}`)
}
const round = (n) => Math.round(n * 1000) / 1000

function makeBoard() {
  return newBoard('测试 · 电磁学')
}

// ═════════════════════ 1. 点的读写（扁平数组） ═════════════════════
console.log('\n[1] 点：扁平数组读写')
{
  const pts = [
    { x: 1, y: 2, p: 0.5 },
    { x: 3, y: 4, p: null },
    { x: 5, y: 6, p: 0.9 },
  ]
  const flat = toFlat(pts)
  eq(flat, [1, 2, 0.5, 3, 4, 0.5, 5, 6, 0.9], '写出扁平数组（压力缺省 0.5）')
  eq(toPoints(flat).length, 3, '读回来还是 3 个点')
  eq(toPoints(flat)[2].p, 0.9, '压力没丢')
  // 尾部残缺不能崩也不能造出假点（写入过程被打断的半个数）
  eq(toPoints([1, 2, 0.5, 3]).length, 1, '残缺尾巴丢掉，不造半个点')
  eq(toPoints(null), [], 'null 给空数组')
  eq(toPoints([NaN, 2, 0.5, 3, 4, 0.5]).length, 1, 'NaN 点丢掉')

  /* ★ 这一条是那个"静默毁数据"的哨兵：
     toFlat 写出去的是扁平数组，而 toPoints 第一版只认对象数组 —— 于是
     「读进来的点 → 原样再存一次」会把每一个点都变成 0，不报错、文件看着还是好的。
     现在两边都认两种形状，这条断言就是钉它。 */
  eq(toFlat(toPoints(toFlat(pts))), flat, '扁平数组 → 点 → 扁平数组，逐个数一致（再来一遍也不会变 0）')
  eq(toFlat(toPoints([[1, 2, 0.5]])).length, 0, '嵌套数组不是我们的形状：整体丢掉，不崩也不造假点')
  eq(toFlat(toPoints(pts)), flat, 'toFlat 也吃对象数组（同一份数据两种写法结果相同）')

  /* ★ 解析出来的笔画，点**必须**是扁平的数字数组。
     这一条钉的是最贵的一个 bug：parseBoardDocument 一度把点规范化成对象数组，
     而画布/抽稀/包围盒都按扁平数组读下标 0/1/2 —— 一笔 10 个点被读成 3 个，
     画出来长度是 0，**屏幕上什么都没有**，但文件内容、状态栏数字全都正常。
     查了很久才发现是"内存里的形状"和"读的人以为的形状"不一致。 */
  const parsed = parseBoardDocument(
    JSON.stringify({ strokes: [{ tool: 'pen', points: [0, 0, 0.5, 10, 10, 0.5, 20, 0, 0.5] }] }),
    'x'
  )
  const sp = parsed.strokes[0].points
  if (Array.isArray(sp) && typeof sp[0] === 'number' && sp.length === 9) {
    ok('解析出来的点是扁平数字数组（画布读得懂）')
  } else {
    bad(`解析出来的点形状不对：${JSON.stringify(sp).slice(0, 60)} —— 画布会把它读成 ${Math.ceil(sp.length / 3)} 个点`)
  }
}

// ═════════════════════ 1b. 各种入口的形状必须一致 ═════════════════════
/* 这一节是"同一个坑的不同入口"的看门人：只要是"点数组"进出数据层的地方，
   形状就得是扁平数字。谁改坏了这里，画布上就是一片空白、而且不报错。 */
console.log('\n[1b] 点的形状：所有入口都必须是扁平数字数组')
{
  const NUM = (arr, label) => {
    if (!Array.isArray(arr)) return bad(`${label}：不是数组`)
    if (arr.some((v) => typeof v !== 'number')) bad(`${label}：里面有非数字（${typeof arr[0]}）—— 会被读成 ${Math.ceil(arr.length / 3)} 个点`)
    else ok(`${label}：${arr.length} 个数 = ${arr.length / 3} 个点`)
  }
  NUM(newStroke('pen', toFlat([{ x: 1, y: 2, p: 0.5 }, { x: 3, y: 4, p: 0.5 }])).points, 'newStroke 造出来的')
  NUM(toFlat(simplifyPoints([{ x: 0, y: 0, p: .5 }, { x: 9, y: 9, p: .5 }], 0.6)), 'simplifyPoints 过一遍 toFlat 之后')
  /* simplifyPoints 进出都是**对象数组** —— 它是算法，不是存储层；
     画布调用它的地方必须 toPoints(...) 进、toFlat(...) 出。
     这条断言就是提醒这件事（写成"它的返回值能直接喂 toFlat"）。 */
  const b = newBoard('t')
  b.strokes.push(newStroke('pen', toFlat([{ x: 0, y: 0, p: .5 }, { x: 5, y: 5, p: .5 }])))
  const round = parseBoardDocument(serializeBoardDocument(b), 'x')
  NUM(round.strokes[0].points, '存一轮再读回来的')
  // 而且读回来的点要能被"读点的人"正确理解：10 个点不能被读成 3 个
  const many = []
  for (let i = 0; i < 10; i++) many.push({ x: i * 5, y: i * 3, p: 0.5 })
  const b2 = newBoard('t')
  b2.strokes.push(newStroke('pen', toFlat(many)))
  const r2 = parseBoardDocument(serializeBoardDocument(b2), 'x')
  eq(toPoints(r2.strokes[0].points).length, 10, '10 个点的笔画，读回来还是 10 个点')
}

// ═════════════════════ 2. 点抽稀 ═════════════════════
console.log('\n[2] 抽稀：端点必须在，冗余点必须少')
{
  // 一条直线上密得离谱的点：应该被抽成两个端点
  const line = []
  for (let i = 0; i <= 100; i++) line.push({ x: i, y: 0, p: 0.5 })
  const s1 = simplifyPoints(line, 0.6)
  eq(s1.length, 2, '100 点直线 → 2 点')
  eq([s1[0].x, s1[s1.length - 1].x], [0, 100], '端点原样保留')

  // 一个拐得很厉害的 L 形：拐角必须留下，不然线会被"拉直"
  const L = [
    { x: 0, y: 0, p: 0.5 },
    { x: 10, y: 0, p: 0.5 },
    { x: 20, y: 0, p: 0.5 },
    { x: 20, y: 10, p: 0.5 },
    { x: 20, y: 20, p: 0.5 },
  ]
  const s2 = simplifyPoints(L, 0.6)
  if (s2.some((p) => p.x === 20 && p.y === 0)) ok('L 形的拐角留下了（线不会被拉直）')
  else bad('L 形拐角被抽掉了，笔画会变形')

  // 抖动的直线（真实笔迹的样子）：应该也塌成一条线，而不是留一堆锯齿
  const noisyLine = []
  for (let i = 0; i <= 50; i++) noisyLine.push({ x: i * 2, y: Math.sin(i * 1.7) * 0.2, p: 0.5 })
  eq(simplifyPoints(noisyLine, 0.6).length, 2, '抖动的直线 → 2 点（锯齿被吃掉）')

  // 抽稀不能改变端点的坐标（否则每次保存笔画都在慢慢漂移）
  const noisy = []
  for (let i = 0; i < 50; i++) noisy.push({ x: i + Math.sin(i) * 0.3, y: Math.cos(i) * 0.3, p: 0.5 })
  const s3 = simplifyPoints(noisy, 0.6)
  eq([s3[0].x, s3[0].y], [noisy[0].x, noisy[0].y], '噪声笔画的起点不漂')
  const s3b = simplifyPoints(s3, 0.6)
  eq([s3b[0].x, s3b[0].y, s3b.length], [s3[0].x, s3[0].y, s3.length], '已经抽过的再抽一次不变（幂等）')
  if (s3.length < noisy.length) ok(`点数确实降下来了：${noisy.length} → ${s3.length}`)
  else bad('抽稀没生效')

  /* ★ 重合点必须先去掉：两个几乎同位置的点会造出一条**零长度线段**，
     "点到零长度线段的距离"退化成点到点距离、数值一点不小，
     于是这段噪声永远超过容差、永远删不掉。手写笔画里这种点满地都是。
     注意去重阈值（0.03）比存盘精度（0.1）小：坐标 100 和 100.01 算同一个点，
     100 和 100.5 是两个点 —— 所以下面这组数据去重后剩 2 个、
     100 个抖动点那条（[2] 开头）才能整条塌成 2 点。 */
  const dup = []
  for (let i = 0; i < 40; i++) dup.push({ x: 0.01 * (i % 2), y: 0, p: 0.5 })
  const dupOut = simplifyPoints(dup, 0.6)
  eq(dupOut.length, 1, '40 个几乎重合的点 → 1 点（不会被零长度线段卡住）')
  // 去掉重合点之后，抽稀该照常把"直线上多出来的点"删掉：不该因为去重而少删
  eq(simplifyPoints([{ x: 0, y: 0, p: .5 }, { x: 0, y: 0.001, p: .5 }, { x: 50, y: 0, p: .5 }], 0.6).length, 2, '去重之后照常抽稀')

  eq(simplifyPoints([], 0.6), [], '空输入不崩')
  eq(simplifyPoints([{ x: 1, y: 1, p: 0.5 }], 0.6).length, 1, '单点原样')
}

// ═════════════════════ 2b. 荧光笔：不吃压力、颜色宽度钉死 ═════════════════════
/* 这一节钉的是"荧光笔效果不均匀"那个 bug。
   症状看起来像"笔刷质量差"：一道记号深浅斑驳。根因有两个，都是代码问题：
     ① 荧光笔也逐点改线宽（pressure 被当成通用属性）→ 一下粗一下细；
     ② 半透明的笔画逐段 stroke，圆头处重叠 → 透明色叠两次就变深。
   这里管的是 ①（存储层能管的那一半）：归一化之后，荧光笔必须
   pressure=false、固定颜色、固定宽度 —— 这样**老文件里的荧光笔
   下次打开也会自动修好**，不用用户把画过的记号重描一遍。 */
console.log('\n[2b] 荧光笔：不吃压力、颜色和宽度钉死')
{
  const b = newBoard('t')
  // 模拟"老文件里的荧光笔"：pressure 是 true、颜色和宽度都被改过
  b.strokes.push({
    id: 'old-hl',
    tool: 'highlighter',
    color: '#ff0000',
    width: 4,
    pressure: true,
    points: toFlat([{ x: 0, y: 0, p: 0.2 }, { x: 100, y: 0, p: 0.9 }]),
  })
  const round = parseBoardDocument(serializeBoardDocument(b), 'x')
  const hl = round.strokes[0]
  eq(hl.pressure, false, '老文件里的荧光笔读回来 pressure=false（自动修好，不用重描）')
  eq(hl.color, '#ffd43b', '颜色被拉回荧光黄')
  eq(hl.width, 16, '宽度被拉回 HL_WIDTH（马克笔只有一种笔头）')

  // 笔不能被误伤：它仍然吃压力
  const b2 = newBoard('t')
  b2.strokes.push(newStroke('pen', toFlat([{ x: 0, y: 0, p: 0.3 }, { x: 50, y: 0, p: 0.9 }]), { width: 3 }))
  const r2 = parseBoardDocument(serializeBoardDocument(b2), 'x')
  eq(r2.strokes[0].pressure, true, '笔仍然吃压力（只钉荧光笔，别把笔一起改了）')
  eq(r2.strokes[0].color, '#1b1d22', '笔的颜色不受影响')

  // 荧光笔的框要按**实际宽度**算，否则橡皮判定会用错宽度
  const hb = strokeBounds({ tool: 'highlighter', color: '#ffd43b', width: 16, pressure: false, points: toFlat([{ x: 0, y: 0, p: 0.5 }, { x: 100, y: 0, p: 0.5 }]) })
  near(hb.h, 16, 1e-9, '荧光笔的包围盒高度 = 线宽')
  if (strokeHitsCircle({ tool: 'highlighter', width: 16, points: toFlat([{ x: 0, y: 0, p: 0.5 }, { x: 100, y: 0, p: 0.5 }]) }, 50, 6, 2)) {
    ok('橡皮能擦到荧光笔的边缘（半宽以内都算命中）')
  } else {
    bad('橡皮擦不到荧光笔 —— 命中判定没算线宽')
  }

  // 样板里那笔荧光笔也得合规，否则新用户第一眼看到的就是坏的
  const { buildSeedBoard } = await import('../src/seed-board.js')
  const seed = parseBoardDocument(serializeBoardDocument(buildSeedBoard()), 'x')
  const seedHl = seed.strokes.filter((s) => s.tool === 'highlighter')
  if (!seedHl.length) bad('样板里一笔荧光笔都没有 —— 那用户看不到这个工具长什么样')
  else if (seedHl.every((s) => s.pressure === false && s.color === '#ffd43b' && s.width === 16)) {
    ok(`样板里那 ${seedHl.length} 笔荧光笔都合规（pressure=false、颜色宽度对）`)
  } else {
    bad('样板里的荧光笔不合规：' + JSON.stringify(seedHl.map((s) => [s.pressure, s.color, s.width])))
  }
}

// ═════════════════════ 3. 几何 ═════════════════════
console.log('\n[3] 几何：距离 / 命中 / 视图变换')
{
  near(pointSegDist(0, 5, -10, 0, 10, 0), 5, 1e-9, '点到线段：正上方垂直距离')
  near(pointSegDist(20, 0, -10, 0, 10, 0), 10, 1e-9, '点到线段：落在延长线上取端点距离')

  const s = newStroke('pen', toFlat([
    { x: 0, y: 0, p: 0.5 }, { x: 100, y: 0, p: 0.5 },
  ]), { width: 2 })
  if (strokeHitsCircle(s, 50, 1, 3)) ok('笔画命中：圆压在线上')
  else bad('笔画命中失败（擦除会擦不掉）')
  if (!strokeHitsCircle(s, 50, 40, 3)) ok('笔画未命中：圆离得远')
  else bad('离得远也判命中（擦除会误伤）')

  const b = strokeBounds(s)
  near(b.x, -1, 1e-9, '笔画的框含线宽')
  near(b.w, 102, 1e-9, '笔画的框宽度 = 长度 + 线宽')

  // 视图：屏幕 ↔ 世界 必须是互逆的
  const view = { s: 1.7, tx: -320.5, ty: 88.25 }
  const back = screenToWorld(412, 233, view)
  const fwd = worldToScreen(back, view)
  near(fwd.x, 412, 1e-9, '屏幕→世界→屏幕 横坐标回到原地')
  near(fwd.y, 233, 1e-9, '屏幕→世界→屏幕 纵坐标回到原地')

  // 缩放锚点：光标底下的那个世界点，缩放后必须还在光标底下
  const before = screenToWorld(500, 300, view)
  const zoomed = zoomAt(view, 1.25, 500, 300)
  const after = screenToWorld(500, 300, zoomed)
  near(after.x, before.x, 1e-6, '滚轮缩放：光标下的世界点不跑')
  near(after.y, before.y, 1e-6, '滚轮缩放：光标下的世界点不跑（纵向）')

  /* ── 视图映射 module（src/lib/view.js）自己的断言 ──
     2026-09-16 把它从"手抄 14 处"收成一个 module 时补的：这里钉的是
     **口径**（纯浮点、谁 round、dpr 怎么叠、捏合的锚点怎么跟）。 */
  {
    /* ① 纯浮点：非整格的视图也不能被悄悄 round —— 早 round 是"看着有点歪"的根源 */
    const v = { s: 0.643, tx: 12.4, ty: 174.8 }
    const p = worldToScreen({ x: 367.5, y: 337.5 }, v)
    near(p.x, 367.5 * 0.643 + 12.4, 1e-9, '映射是纯浮点（不 round）')
    near(p.y, 337.5 * 0.643 + 174.8, 1e-9, '映射是纯浮点（不 round，纵向）')

    /* ② 世界矩形 → CSS 盒子：位置是映射、宽高是"长度 × s"，两条轴都要对 */
    const box = worldRectToScreen({ x0: 10, y0: 20, x1: 110, y1: 70 }, v, 7)
    near(box.left, 10 * v.s + v.tx - 7, 1e-9, '矩形左边界 = 映射 − pad')
    near(box.width, 100 * v.s + 14, 1e-9, '矩形宽 = 世界宽 × s + 2×pad')

    /* ③ clamp：NaN / 0 / 空 都退回 1，且夹在 [0.15, 6] */
    eq(clampViewScale(NaN), 1, 'clamp：NaN → 1（一次脏输入不该把板缩没）')
    eq(clampViewScale(0), 1, 'clamp：0 → 1')
    eq(clampViewScale(99), 6, 'clamp：上限 6')
    eq(clampViewScale(0.01), 0.15, 'clamp：下限 0.15')

    /* ④ 捏合：锚点会动 —— 开始时两指中点下的世界点，要落在**现在的**中点下 */
    const v0 = { s: 1, tx: 0, ty: 0 }
    const from = { x: 100, y: 100 }
    const to = { x: 160, y: 130 }
    const worldUnderFrom = screenToWorld(from.x, from.y, v0)
    const pinched = zoomBetween(v0, 2, from, to)
    const whereItLanded = worldToScreen(worldUnderFrom, pinched)
    near(whereItLanded.x, to.x, 1e-9, '捏合：开始时锚点下的世界点落到**新的**中点（横）')
    near(whereItLanded.y, to.y, 1e-9, '捏合：开始时锚点下的世界点落到**新的**中点（纵）')
    /* zoomAt 是 zoomBetween 的特例（锚点不动）—— 两条手势走同一个公式 */
    eq(JSON.stringify(zoomAt(v0, 2, 100, 100)), JSON.stringify(zoomBetween(v0, 2, from, from)), 'zoomAt ≡ zoomBetween(同一个锚点)')

    /* ⑤ 平移：屏幕位移原样加到 t 上，和缩放无关 */
    const panned = panBy({ s: 3, tx: 5, ty: 6 }, -70, 45)
    eq([panned.s, panned.tx, panned.ty], [3, -65, 51], '平移：屏幕位移原样加到 tx/ty')

    /* ⑥ 居中：容器中心那个屏幕点映回去就是它 */
    const centered = centerOn({ s: 2, tx: 0, ty: 0 }, { x: 33, y: -12 }, 800, 600)
    const back2 = screenToWorld(400, 300, centered)
    near(back2.x, 33, 1e-9, 'centerOn：容器中心映回去就是那个世界点（横）')
    near(back2.y, -12, 1e-9, 'centerOn：容器中心映回去就是那个世界点（纵）')

    /* ⑦ canvas 变换：dpr 必须乘进去，返回的三个数就是写进去的那三个 */
    const calls = []
    const fakeCtx = { setTransform: (...a) => calls.push(a) }
    const nums = applyViewTo(fakeCtx, { s: 1.5, tx: 10, ty: -4 }, 2)
    eq(nums, { s: 3, tx: 20, ty: -8 }, 'applyViewTo 返回实际写进去的三个数')
    eq(calls[0], [3, 0, 0, 3, 20, -8], 'applyViewTo：setTransform(dpr×s, …)（dpr 乘进去了）')
    eq(viewTransformAttr({ s: 1.5, tx: 10, ty: -8.5 }), 'translate(10 -8.5) scale(1.5)', 'SVG 变换和 canvas 变换同源')
  }
}

// ═════════════════════ 4. 关系推理 ═════════════════════
console.log('\n[4] 关系：包含 / 重叠 / 挨着 / 孤岛')
{
  // ① 包含：大卡里套一张小卡
  const b1 = makeBoard()
  b1.cards = [
    { ...newCard('note', 0, 0, { w: 500, h: 400 }), x: 0, y: 0, id: 'big' },
    { ...newCard('formula', 0, 0, { w: 200, h: 80 }), x: 150, y: 150, id: 'small' },
  ]
  const r1 = buildRelations(b1)
  eq(r1.parentOf.get('small'), 'big', '包含：小的挂到大的底下')
  eq(r1.edges.length, 1, '包含：只产生一条边')
  eq(r1.orphans, [], '包含：都不算孤岛')

  // ② 挨着：不重叠、间隔在 NEAR_GAP 之内
  const b2 = makeBoard()
  b2.cards = [
    { ...newCard('formula', 0, 0, { w: 200, h: 80 }), x: 0, y: 0, id: 'c1' },
    { ...newCard('formula', 0, 0, { w: 200, h: 80 }), x: 200 + NEAR_GAP - 4, y: 0, id: 'c2' },
  ]
  const r2 = buildRelations(b2)
  eq(r2.edges.length, 1, `挨着（间隔 ${NEAR_GAP - 4}px）：算一条关系`)
  eq(r2.parentOf.get('c2'), 'c1', '挨着：先画的当父节点')
  eq(r2.edges[0].kind, 'near', '挨着：标成 near（面板上要说清是推断的）')

  // ③ 太远：各自孤岛
  const b3 = makeBoard()
  b3.cards = [
    { ...newCard('formula', 0, 0), x: 0, y: 0, id: 'f1' },
    { ...newCard('formula', 0, 0), x: 0, y: 900, id: 'f2' },
  ]
  const r3 = buildRelations(b3)
  eq(r3.edges.length, 0, '离得远：不瞎连')
  eq(r3.orphans.slice().sort(), ['f1', 'f2'], '离得远：两个都是孤岛')

  // ④ 父节点跟着"谁先画"，不跟着遍历顺序随机
  const b4 = makeBoard()
  b4.cards = [
    { ...newCard('formula', 0, 0, { w: 200, h: 80 }), x: 200 + NEAR_GAP - 4, y: 0, id: 'd2' },
    { ...newCard('formula', 0, 0, { w: 200, h: 80 }), x: 0, y: 0, id: 'd1' },
  ]
  const r4 = buildRelations(b4)
  eq(r4.parentOf.get('d1'), 'd2', '卡片顺序反过来：父节点跟着"谁先画"走，不随机')

  // ⑤ 度数 / 枢纽
  const b5 = makeBoard()
  b5.cards = [
    { ...newCard('note', 0, 0, { w: 300, h: 200 }), x: 0, y: 0, id: 'hub' },
    { ...newCard('formula', 0, 0, { w: 160, h: 60 }), x: 60, y: 40, id: 'k1' },
    { ...newCard('formula', 0, 0, { w: 160, h: 60 }), x: 60, y: 120, id: 'k2' },
  ]
  const r5 = buildRelations(b5)
  eq(r5.hubs[0], 'hub', '枢纽：度数最高的排第一')
  eq(r5.degree.get('hub'), 2, '枢纽：度数是 2')
  eq([...descendantsOf(r5, 'hub')].sort(), ['hub', 'k1', 'k2'], '后代：连自己带两个孩子')

  // ⑥ 关系图不能有环（有环的话后代遍历会转不出来）
  const b6 = makeBoard()
  b6.cards = [
    { ...newCard('note', 0, 0, { w: 200, h: 200 }), x: 0, y: 0, id: 't1' },
    { ...newCard('note', 0, 0, { w: 200, h: 200 }), x: 10, y: 10, id: 't2' },
    { ...newCard('note', 0, 0, { w: 200, h: 200 }), x: 20, y: 20, id: 't3' },
  ]
  const r6 = buildRelations(b6)
  let cyclic = false
  for (const id of ['t1', 't2', 't3']) {
    const chain = new Set()
    let cur = id
    while (cur) {
      if (chain.has(cur)) {
        cyclic = true
        break
      }
      chain.add(cur)
      cur = r6.parentOf.get(cur)
    }
  }
  if (!cyclic) ok('三张互相重叠的卡：父链不出现环')
  else bad('父链出现环（大纲会无限展开）')

  // ⑦ 连线的曲线：端点就是两个框的中心
  const cv = relationCurve({ x: 0, y: 0, w: 100, h: 100 }, { x: 400, y: 0, w: 100, h: 100 })
  eq(cv.a, { x: 50, y: 50 }, '连线起点 = A 的中心')
  eq(cv.b, { x: 450, y: 50 }, '连线终点 = B 的中心')
  if (Math.abs(cv.c.y - 50) > 1) ok('连线控制点被推开了（是弧不是直线）')
  else bad('控制点没推开，退化成了直线')
}

// ═════════════════════ 5. 画了线的关系 ═════════════════════
console.log('\n[5] 画了线的关系（ink）')
{
  const b = makeBoard()
  b.cards = [
    { ...newCard('formula', 0, 0, { w: 200, h: 80 }), x: 0, y: 0, id: 'k1' },
    { ...newCard('formula', 0, 0, { w: 200, h: 80 }), x: 600, y: 0, id: 'k2' },
  ]
  // 一笔从 k1 里出发、落到 k2 里 —— 这是"我亲手连的线"
  b.strokes.push(newStroke('pen', toFlat([
    { x: 100, y: 40, p: 0.5 }, { x: 400, y: 300, p: 0.5 }, { x: 700, y: 40, p: 0.5 },
  ])))
  // 一笔在空白处乱画 —— 不该被当成关系
  b.strokes.push(newStroke('pen', toFlat([
    { x: 300, y: 700, p: 0.5 }, { x: 380, y: 760, p: 0.5 },
  ])))
  /* 「你画过的那些」= `reader.read()` 的结果本身（`inkedEdges` 那个薄壳删掉了，
     关系面板要的那份直接从 links 派生）。 */
  const ink = reader.read(b)
  eq(ink.length, 1, '只有起点终点都在卡里的那笔算连线')
  eq([ink[0].a, ink[0].b], ['k1', 'k2'], '连的是 k1 → k2')
}

// ═════════════════════ 6. 文件往返 ═════════════════════
console.log('\n[6] 存取：round-trip 不能丢东西')
{
  const b = makeBoard()
  b.cards = [
    { ...newCard('formula', 100, 100), id: 'f1', src: 'B = mu0 I / (2 pi r)', tex: 'B = \\frac{\\mu_{0} I}{2 \\pi r}' },
    { ...newCard('note', 400, 100), id: 'n1', text: '安培环路定理' },
  ]
  // 笔画要够"弯"才经得起抽稀：振幅小的正弦在容差 0.6 之下会被整条拉直，
  // 那样这个用例测的就成了"点还在不在"，而不是"往返丢没丢"。
  const pts = []
  for (let i = 0; i < 120; i++) pts.push({ x: Math.sin(i / 6) * 90 + 200, y: Math.sin(i / 3) * 70 + i * 2, p: 0.3 + (i % 10) / 15 })
  b.strokes.push(newStroke('pen', toFlat(pts), { width: 3, color: '#d9480f' }))
  /* 荧光笔要**合规**才能参与往返测试：它的颜色和宽度会被归一化钉死
     （见 [2b]），所以造数据时就得按那个形状造 ——
     否则"存进去 16、读回来还是 16"这条断言测的是错的期望。 */
  b.strokes.push(newStroke('highlighter', toFlat(pts.slice(0, 40)), { width: 16 }))
  b.view = { s: 1.414, tx: -123.4, ty: 56.7 }

  const text = serializeBoardDocument(b)
  const back = parseBoardDocument(text, '兜底')
  eq(back.title, b.title, '标题回来了')
  eq(back.strokes.length, 2, '两笔都回来了')
  eq(back.cards.length, 2, '两张卡都回来了')
  eq(back.cards[0].src, 'B = mu0 I / (2 pi r)', '公式卡片的原文回来了（一个字不改）')
  eq(back.cards[1].text, '安培环路定理', '便签文字回来了')

  /* ★ 老文件的地雷：早期版本的手写识别只写 tex、src 留空。
     而卡片编辑态编辑的是 src —— 空 src 就是"双击进去一个空输入框"，
     用户按回车还会把式子抹掉（就是「识别是对的但放不到白板上」那个 bug）。
     所以读盘时要把这种卡的 src 就地补成 tex。 */
  {
    const legacy = JSON.parse(serializeBoardDocument(b))
    legacy.cards[0].src = ''
    legacy.cards[0].tex = 'E = mc^{2}'
    const fixed = parseBoardDocument(JSON.stringify(legacy))
    eq(fixed.cards[0].src, 'E = mc^{2}', '老文件里 src 空的公式卡：读盘时用 tex 补齐（双击进去看得见式子）')
    // 手打过的 src 一个字不能动
    const handwritten = JSON.parse(serializeBoardDocument(b))
    handwritten.cards[0].src = 'B = mu0 I / (2 pi r)'
    eq(parseBoardDocument(JSON.stringify(handwritten)).cards[0].src, 'B = mu0 I / (2 pi r)', '手打过的 src 不动')
    // 便签卡没有 src 这回事，别凭空给它造一个
    const noteOnly = JSON.parse(serializeBoardDocument(b))
    noteOnly.cards[1].src = ''
    noteOnly.cards[1].tex = '不该被搬进来'
    eq(parseBoardDocument(JSON.stringify(noteOnly)).cards[1].src, '', '便签卡不会被塞进 tex')
  }
  eq(back.strokes[1].tool, 'highlighter', '荧光笔的工具名回来了')
  eq(back.strokes[1].width, 16, '线宽回来了')
  near(back.view.s, 1.414, 0.001, '视图缩放回来了')
  near(back.view.tx, -123.4, 0.05, '视图平移回来了')

  // 坐标容差：存的时候保留两位小数，所以往返误差 ≤ 0.005
  const a0 = toPoints(back.strokes[0].points)
  near(a0[5].x, pts[5].x, 0.005, '第 6 个点的横坐标误差在 1/100 像素内')
  near(a0[5].p, pts[5].p, 0.005, '压力误差同样在 1/100 内（粗细不会跳）')

  /* ★ 存→读→再存必须字节级一致。
     不一致就意味着"打开文件、什么都不改、存回去"会造出一条假 diff，
     而人会慢慢学会忽略 diff —— 那比不备份更糟。
     这条断言抓到过一个真 bug：parse 出来的点是对象数组，
     序列化却按扁平数组读，于是每个点都变成 0。 */
  const again = serializeBoardDocument(back)
  if (again === text) ok('存→读→再存 字节级一致（Git 里不会每天假 diff）')
  else bad('两次序列化不一致，自动保存会在 Git 里造假 diff')

  if (isBoardDocument(text)) ok('认得出这是白板文件')
  else bad('白板文件没被认出来（会当成笔记，一打开就乱）')
  if (!isBoardDocument('# 大物 · 电磁学\n\n- 安培环路定理\n')) ok('笔记文件不会被误认成白板')
  else bad('笔记被误认成白板（旧笔记一打开就空了）')

  // 坏文件不能崩：给一张空板，让用户至少能继续画
  const broken = parseBoardDocument('{ 这不是合法 json', '坏板')
  eq(broken.strokes, [], '坏文件 → 空板（不抛错）')
  eq(broken.title, '坏板', '坏文件 → 用兜底标题')
  eq(parseBoardDocument('', '空').cards, [], '空文件 → 空板')

  // 各种脏数据都得被挡在门外
  const dirty = parseBoardDocument(JSON.stringify({
    strokes: [{ points: [1, 2, 0.5, 3, 4, 0.5], width: -5 }, { points: [1, 2] }, null, 'x'],
    cards: [{ kind: '胡说', w: 1, h: 1 }, null, { kind: 'formula', x: 'abc' }],
    view: { s: -3 },
  }), '脏')
  eq(dirty.strokes.length, 1, '只有 2 个点的笔画被丢掉，负线宽被修正')
  if (dirty.strokes[0].width > 0) ok('负线宽被修正成正数')
  else bad('负线宽留着，画的时候会看不见')
  eq(dirty.cards.length, 2, 'null 卡片丢掉，认不出的 kind 归成便签')
  eq(dirty.cards[0].w, 260, '尺寸太小的框被拉回默认值（不然框里什么都放不下）')
  near(dirty.view.s, 1, 1e-9, '非法的缩放被拉回 1')
}

// ═════════════════════ 6b. 文字卡：字体和落点 ═════════════════════
/* 「美化手写」那一步的产物是一张**文字卡**（kind=note + 一个字体预设）。
   这里钉三件事，全是"坏了也不报错、只是在屏幕上慢慢不对"的类型：
     ① 字体表里不能有网络字体（白板不上传这条底线，也包括不为好看去联网拉字体）；
     ② 默认字体**不写进文件**（否则所有老板文件在 Git 里凭空变脏）；
     ③ 卡片落点必须钉在那块笔迹的**左上角**、宽度跟着它 ——
        这是"卡片盖住丑字、拖开就变回手写"的全部机制，偏一点就露馅。 */
console.log('\n[6b] 文字卡：字体和落点')
{
  if (CARD_FONTS.length >= 3) ok(`字体预设 ${CARD_FONTS.length} 种：${CARD_FONTS.map((f) => f.name).join(' / ')}`)
  else bad('字体预设太少，用户没得挑')
  if (CARD_FONTS.every((f) => f.id && f.name && f.css && !/url\(|@font-face|https?:/.test(f.css))) {
    ok('每一项都是纯 CSS 候选串（系统里有哪个用哪个，不下载任何字体）')
  } else bad('字体表里混进了网络字体 —— 那就破"不联网"这条底线了')
  if (CARD_FONT_IDS.includes(DEFAULT_CARD_FONT)) ok('默认字体在表里')
  else bad('默认字体不在表里，渲染层会拿不到它')
  eq(fontCss('这个字体不存在'), fontCss(DEFAULT_CARD_FONT), '认不出的字体 id → 退回默认（不是 undefined）')
  eq(newCard('note', 0, 0).font, DEFAULT_CARD_FONT, '新建的文字卡带默认字体')

  // ── 老文件：没有 font 字段 ──
  const b0 = makeBoard()
  b0.cards.push({ ...newCard('note', 100, 100), id: 'n1', text: '安培环路定理' })
  delete b0.cards[0].font
  const s0 = serializeBoardDocument(b0)
  if (!/"font"/.test(s0)) ok('默认字体**不写进文件**（老板文件打开一次不会整块变成"已修改"）')
  else bad('默认字体被写进文件了 —— 所有老板文件会在 Git 里凭空变脏')
  const r0 = parseBoardDocument(s0, 'x')
  eq(r0.cards[0].font, DEFAULT_CARD_FONT, '老板文件（没这个字段）读进来也有默认字体')
  if (serializeBoardDocument(r0) === s0) ok('老板文件：存→读→再存 字节级一致（不会造假 diff）')
  else bad('老板文件往返不一致')

  // ── 选了非默认字体 ──
  const b1 = makeBoard()
  b1.cards.push({ ...newCard('note', 100, 100), id: 'n1', text: '安培环路定理', font: 'hei' })
  const s1 = serializeBoardDocument(b1)
  if (/"font": "hei"/.test(s1)) ok('选了非默认字体 → 写进文件（这样重新打开还记得住）')
  else bad('非默认字体没写进文件，重新打开会变回楷体')
  const r1 = parseBoardDocument(s1, 'x')
  eq(r1.cards[0].font, 'hei', '读回来还是黑体')
  if (serializeBoardDocument(r1) === s1) ok('非默认字体往返也字节级一致')
  else bad('非默认字体往返不一致')
  const dirtyFont = parseBoardDocument(
    JSON.stringify({ strokes: [], cards: [{ kind: 'note', text: 'x', font: 'Comic Sans MS' }] }),
    'x'
  )
  eq(dirtyFont.cards[0].font, DEFAULT_CARD_FONT, '文件里手改出一个不认识的字体 id → 退回默认（渲染层拿不到脏值）')

  /* ── 落点：卡片的左上角钉在那块笔迹的左上角（但**不负责盖住它**）──
     卡片只管贴合自己的内容；"盖住"那套 2026-09-16 按用户要求拆掉了
     （「不用盖住，就让框贴合公式和字就行」）。 */
  const box = { x0: 120, y0: 80, x1: 420, y1: 180 } // 300 × 100
  const one = textCardRect(box, '安培环路定理')
  eq([one.x, one.y], [120, 80], '左上角钉在圈的那块笔迹的左上角（落点，不是"盖住"）')
  eq(one.w, 300, '宽度先跟着那块笔迹走（插进去之后按真实自然宽再收一次）')
  eq(textCardRect({ x0: 0, y0: 0, x1: 40, y1: 30 }, '字').w, TEXT_CARD_MIN_W, '框很小 → 宽度有下限（不然窄得放不下一个字）')
  eq(textCardRect({ x0: 0, y0: 0, x1: 5000, y1: 40 }, '字').w, TEXT_CARD_MAX_W, '框特别宽 → 有上限（一行拉太长没法读）')
  /* ★ 这一条是"不再盖住"的钉子：圈一个很高很空的框，卡片也不该跟着变高 ——
     高度只按**内容**估。上一版这里会等价于"至少和那块笔迹一样高"。 */
  const tallBox = { x0: 0, y0: 0, x1: 300, y1: 900 }
  eq(textCardRect(tallBox, '一行字').h, textCardRect({ x0: 0, y0: 0, x1: 300, y1: 20 }, '一行字').h,
    '圈得再高也不影响卡片高度（高度只跟内容有关，不再撑大去盖那块笔迹）')

  const longText = '字'.repeat(160)
  const long = textCardRect(box, longText)
  if (long.h > one.h) ok(`文字多 → 卡片自己长高（${one.h} → ${long.h}）`)
  else bad('文字多了高度不变，字会溢出卡片外面')
  const narrow = { x0: 0, y0: 0, x1: 40, y1: 30 }
  if (textCardRect(narrow, longText).h > long.h) ok('框窄 → 行数更多、卡片更高（排版估算是跟着宽度算的）')
  else bad('宽度没参与高度估算')
  eq(textCardRect(box, '第一行\n第二行').h, 2 * TEXT_CARD_LINE_H + TEXT_CARD_PAD_Y, '换行被算成两行（卡片不会把两行挤成一行）')
  /* emoji / 生僻字在 JS 里是**两个 UTF-16 单位**。按 .length 数会把它当成两个字，
     行长估多一倍 —— 卡片高度就和真的行数对不上（字压在边框上）。
     窄框（宽 220 → 每行 13 个字）下这个差别一眼能看出来：52 vs 78。 */
  eq(textCardRect(narrow, '🙂'.repeat(13)).h, textCardRect(narrow, '字'.repeat(13)).h, 'emoji 也按一个字算（不是两个）')
  eq(textCardRect(box, '').h, one.h, '空文字不崩，高度按一行算')

  /* ── 放大缩小（拖右下角那个柄）──
     倍率是**一个数管全部**：字号、内边距、宽高一起乘它。
     只改宽高不把字号跟着变的话，卡片越拉越大、字还是那么小（看着像坏了），
     所以这里钉的其实是"那个数怎么算"。 */
  const base = newCard('note', 0, 0, { w: 260, h: 96 })
  eq(base.scale, DEFAULT_CARD_SCALE, '新建的卡片倍率是 1（原样）')
  near(nextCardScale(base, 1), 1, 1e-9, '没拖动 → 倍率不变')
  near(nextCardScale(base, 2), 2, 1e-9, '拖到两倍宽 → 倍率 2（字跟着一起变）')
  eq(nextCardScale(base, 0.001), CARD_MIN_SCALE, '往小拖到底 → 夹在倍率下限')
  eq(nextCardScale(base, 1000), CARD_MAX_SCALE, '往大拖到底 → 夹在倍率上限')
  /* ★ 这两条是"世界宽度"那一层夹：只夹倍率的话，宽卡片乘 4 能铺满整块板 */
  {
    const wideK = nextCardScale({ w: 1500, scale: 1 }, 4)
    if (wideK * 1500 <= CARD_MAX_W + 1e-6) ok(`本来就很宽的卡也夹住了（1500 × ${round(wideK)} = ${round(wideK * 1500)} ≤ ${CARD_MAX_W}）`)
    else bad(`宽卡乘出来后 ${round(wideK * 1500)} 宽，超过了上限 ${CARD_MAX_W}`)
    const tinyK = nextCardScale({ w: 120, scale: 1 }, 0.5)
    if (tinyK * 120 >= CARD_MIN_W - 1e-6) ok(`窄卡不会缩到看不见（120 × ${round(tinyK)} = ${round(tinyK * 120)} ≥ ${CARD_MIN_W}）`)
    else bad(`窄卡缩成了 ${round(tinyK * 120)} 宽，比下限还小`)
  }
  eq(clampCardScale(0), DEFAULT_CARD_SCALE, '倍率 0 → 退回 1（0 就是"整张卡看不见"）')
  eq(clampCardScale(-3), DEFAULT_CARD_SCALE, '负倍率 → 退回 1')
  eq(clampCardScale(NaN), DEFAULT_CARD_SCALE, 'NaN → 退回 1，不崩')
  eq(clampCardScale('两倍'), DEFAULT_CARD_SCALE, '字符串 → 退回 1')

  // 存取：默认不写（老板文件不能凭空变脏）、非默认要写、脏值要退回
  const bs = makeBoard()
  bs.cards.push({ ...newCard('note', 100, 100), id: 's1', text: '放大过的便签' })
  const ts1 = serializeBoardDocument(bs)
  if (!/"scale"/.test(ts1)) ok('倍率 1（原样）**不写进文件**（老板文件不会凭空变成"已修改"）')
  else bad('默认倍率被写进文件了')
  bs.cards[0].scale = 2.5
  const ts2 = serializeBoardDocument(bs)
  if (/"scale": 2.5/.test(ts2)) ok('放大过的卡片写进文件（重新打开还是大的）')
  else bad('倍率没写进文件，重新打开会变回原样')
  eq(parseBoardDocument(ts2, 'x').cards[0].scale, 2.5, '读回来还是 2.5')
  if (serializeBoardDocument(parseBoardDocument(ts2, 'x')) === ts2) ok('倍率往返字节级一致')
  else bad('倍率往返不一致（会在 Git 里造假 diff）')
  eq(
    parseBoardDocument(JSON.stringify({ strokes: [], cards: [{ kind: 'note', text: 'x', scale: -3 }] }), 'x').cards[0].scale,
    DEFAULT_CARD_SCALE,
    '文件里手改出负数倍率 → 退回 1（渲染层拿不到脏值）'
  )

  /* ── 高度贴着内容（"留白太多"治的就是这条）──
     内容渲染多高 → h 该是多少：除以视图缩放和卡片倍率，再夹上限。
     ★ 量的是**内容**（.bd-card-body），不是卡片自己 —— 卡片的 min-height 就是 h，
       量它等于量自己，96 的卡量出来永远还是 96，底下的空白永远消不掉。 */
  near(cardHeightFromContent(44, { s: 1.1, scale: 1 }), 40, 0.05, '内容 44px ÷ 视图缩放 1.1 → h = 40 世界像素')
  near(cardHeightFromContent(44, { s: 1.1, scale: 2 }), 20, 0.05, '卡片自己放大 2 倍 → 折算回的世界高度减半（倍率也算进去）')
  eq(cardHeightFromContent(3, { s: 1 }), CARD_MIN_H, '内容再矮也有下限（不然卡片成一条线）')
  eq(cardHeightFromContent(300, { s: 1 }), 300, '内容多高 → h 就是多少（不再有"至少要盖住笔迹"那种下限）')
  eq(cardHeightFromContent(0, { s: 1 }), CARD_MIN_H, '量不到（0）也不崩，退回下限')
  eq(cardHeightFromContent(44, { s: 0 }), 44, 's 还是 0（容器还没量出来）也不会除以 0')
  {
    const h1 = cardHeightFromContent(57.3, { s: 1.117, scale: 1 })
    const h2 = cardHeightFromContent(h1 * 1.117, { s: 1.117, scale: 1 })
    near(h2, h1, 0.05, '量一遍写回去、再量一遍还是同一个数（不会来回振荡 —— 振荡就是每存一次盘造一条假 diff）')
  }
  // 新默认值：贴着内容，不再是"一行字下面空一大截"的那种框
  eq(DEFAULT_CARD_SIZE.h, 44, '新卡片的默认高度贴着内容（原来是 96）')
  eq(TEXT_CARD_PAD_Y, 14, '文字卡高度的上下留白估算收到 14（原来 26）')
  /* ⚠ 这两条是一对：h 的"当没写"阈值必须跟 CARD_MIN_H 对齐。
     识别插进来的卡可能只有 30 出头，阈值要是还写死 32，它们每次存盘都会被抬回默认值。 */
  eq(
    parseBoardDocument(JSON.stringify({ strokes: [], cards: [{ kind: 'note', text: 'x', h: 30 }] }), 'x').cards[0].h,
    30,
    'h=30 的小卡片读回来还是 30（阈值和 CARD_MIN_H 对齐，不会被抬回默认值）'
  )
  eq(
    parseBoardDocument(JSON.stringify({ strokes: [], cards: [{ kind: 'note', text: 'x', h: 3 }] }), 'x').cards[0].h,
    DEFAULT_CARD_SIZE.h,
    'h=3 这种荒谬值当没写 → 默认值'
  )

  /* ── 宽度：**公式卡和文字卡都量**（"就让框贴合公式和字"）──
     用户 2026-09-16 第二次报"识别公式留白依旧很多"，说的就是这一轴：
     公式卡一直是 260 宽，一行 `E = mc²` 只有 60 出头，居中之后左右全是空的。
     文字卡的自然宽度也量了（= 最长那一行）—— 识别结果保住了你写的换行，
     所以不会变成一长条；超过 TEXT_CARD_MAX_W 才折行。 */
  near(cardWidthFromContent(88, { s: 1.1, scale: 1 }), 80, 0.05, '公式自然宽 88px ÷ 视图缩放 1.1 → w = 80 世界像素')
  eq(cardWidthFromContent(5, { s: 1 }), CARD_FIT_MIN_W, '再窄的公式也有下限（不然卡片看着像一条缝）')
  eq(cardWidthFromContent(99999, { s: 1 }), CARD_MAX_W, '很长的公式卡在上限（不然能拉到屏幕外面）')
  eq(cardWidthFromContent(80, { s: 1 }), 80, '没有"至少盖住笔迹"那种下限了：内容多宽就是多宽')
  eq(cardWidthFromContent(0, { s: 1 }), CARD_FIT_MIN_W, '量不到（0）也不崩，退回下限')
  /* ★★ 内边距/边框也要算进去（全局 `box-sizing: border-box`）。
     这一条钉的是一个真踩过的 bug：卡片上写的 `width` 是 **border-box**，
     内容实际拿到的是 `width − 内边距 − 边框`。算尺寸时忘了加这一圈，
     内容就被**当场裁掉** —— 实测 `E = mc²` 的 `c²` 直接不见了（差 18px）。
     讽刺的是当时那两条"卡宽 − 自然宽"的断言还是**绿的**：两边都错在同一个数上。 */
  near(cardWidthFromContent(76, { s: 1, scale: 1, padPx: 18 }), 94, 0.05, '内容需要 76px + 内边距边框 18px → 卡片 94px（border-box）')
  near(cardHeightFromContent(63, { s: 1, scale: 1, padPx: 10 }), 73, 0.05, '内容 63px + 上下内边距边框 10px → 卡片 73px')
  near(cardWidthFromContent(76.31, { s: 1 }), 76.4, 0.001, '宽度向上取整到 0.1（宽度是硬约束，宁可大一点也不能裁内容）')
  /* 文字卡的宽度下限仍然明显大于公式卡：一段话收成 60 宽会一行一个字。 */
  if (TEXT_CARD_MIN_W > CARD_FIT_MIN_W) {
    ok(`公式卡可以收到 ${CARD_FIT_MIN_W}，文字卡仍有 ${TEXT_CARD_MIN_W} 的下限 —— 一段话不会被收成一条缝`)
  } else bad('文字卡的宽度下限不该比公式卡还小')
}

// ═════════════════════ 6c. 卡片的「固定」（locked） ═════════════════════
/* 用户 2026-09-16：「给卡片加一个固定按钮用来防止误触」。
   纯逻辑这一层管两件事：字段怎么读、什么时候写。
   行为（拖不动/双击不进去/📌 还点得到）在 check-lock.js 里用真浏览器钉。 */
console.log('\n[6c] 卡片的「固定」（locked）')
{
  eq(newCard('formula', 0, 0).locked, undefined, '新建的卡没有 locked 字段（默认就是不固定）')

  const b = makeBoard()
  b.cards.push({ ...newCard('note', 100, 100), id: 'n1', text: '安培环路定理', locked: true })
  const s = serializeBoardDocument(b)
  if (/"locked": true/.test(s)) ok('固定住了 → 写进文件（重开还记得住）')
  else bad('固定没写进文件，重开会自己解开')

  const r = parseBoardDocument(s, 'x')
  eq(r.cards[0].locked, true, '读回来还是固定着的')
  if (serializeBoardDocument(r) === s) ok('固定往返字节级一致（不造假 diff）')
  else bad('固定往返不一致')

  /* ★ 没固定的卡**不许写这个字段**。理由和 font / scale 完全一样：
     老文件里一张卡都没有 locked，凭空写出去 = 用户一打开软件，
     所有老板文件在 Git 里整块变成"已修改"。 */
  const b2 = makeBoard()
  b2.cards.push({ ...newCard('note', 100, 100), id: 'n1', text: 'x' })
  const s2 = serializeBoardDocument(b2)
  if (!/"locked"/.test(s2)) ok('没固定的卡不写这个字段（老板文件打开一次不会整块变脏）')
  else bad('没固定的卡也写了 locked —— 所有老板文件会在 Git 里凭空变脏')
  eq(parseBoardDocument(s2, 'x').cards[0].locked, false, '老文件（没这个字段）读进来是"不固定"')

  /* 手改文件写个 "false" / 1 / 0 —— 只认真正的 true。
     认字符串的话，"locked": "false" 会把卡片变成锁死的，而用户以为自己是解开。 */
  const weird = parseBoardDocument(
    JSON.stringify({ strokes: [], cards: [{ kind: 'note', text: 'x', locked: 'false' }, { kind: 'note', text: 'y', locked: 1 }] }),
    'x'
  )
  eq(weird.cards.map((c) => c.locked), [false, false], '手改出来的 "false" / 1 都不算固定（只认真正的 true）')
  eq(parseBoardDocument(JSON.stringify({ strokes: [], cards: [{ kind: 'note', text: 'z', locked: true }] }), 'x').cards[0].locked, true, '真的 true 才算固定')
}

// ═════════════════════ 6d. 画出来的连接（形状读类型 / 只有手动过的才存） ═════════════════════
/* 用户 2026-09-16：「更便捷的显示出两者之间的主次、因果、并列」+
 * 「我没时间去逐步操作这个表示关系的步骤」+「连接的不只是卡片」。
 * 纯逻辑这一层管三件事：形状怎么读、连上了谁、什么该写进文件。
 * 行为（浮词、点词、框选改词、箭头画在哪）在 check-link.js 里用真浏览器钉。 */
console.log('\n[6d] 画出来的连接：形状读类型，只有手动标过的才写进文件')
{
  const straight = toFlat([{ x: 0, y: 0 }, { x: 60, y: 1 }, { x: 130, y: -1 }, { x: 200, y: 0 }])
  /* 一笔画的箭头：划到尖(200,0) → 回勾(182,9) → 甩到另一侧(204,-3)。
     注意**最后这一点的投影比尖还远** —— 这正是把第一版判据打死的那种形状
     （那时候"末尾"是按投影最远的点切的，于是整个箭头都被当成"前面"了）。 */
  const arrow = toFlat([
    { x: 0, y: 0 }, { x: 70, y: 0 }, { x: 140, y: 0 }, { x: 200, y: 0 }, { x: 182, y: 9 }, { x: 204, y: -3 },
  ])
  /* 弧形（往下鼓 40）：投影一路递增、不回勾 —— 它是线，不是箭头。
     这一条是"别把弧线认成箭头"的哨兵。 */
  const arcPts = []
  for (let i = 0; i <= 20; i++) {
    const x = (200 * i) / 20
    arcPts.push({ x, y: (40 * 4 * x * (200 - x)) / (200 * 200) })
  }
  const arc = toFlat(arcPts)
  const elbow = toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 200, y: 80 }])

  eq(classifyLinkShape(straight), 'line', '一笔直线 → 线')
  eq(classifyLinkShape(arrow), 'arrow', '一笔带箭头的（末端回勾）→ 箭头')
  eq(classifyLinkShape(arc), 'line', '弧形不算箭头（它不回勾）')
  eq(classifyLinkShape(elbow), 'line', '折线（拐个弯）也不算箭头')
  eq(classifyLinkShape(toFlat([{ x: 0, y: 0 }, { x: 10, y: 3 }])), 'line', '太短的一笔不猜（当线）')

  const b = makeBoard()
  /* 两张卡离得开一点：**线要真的从一张卡进到另一张卡**。
     第一版把两张卡摆成 0..200 / 600..800，而线只有 0→200 长 ——
     两个端点都落在第一张卡里，于是 buildLinks 正确地返回了 0 条，
     报出来却是"两笔连线 → 两条连接 实际 0"。夹具错，不是代码错。 */
  b.cards = [
    { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 0, id: 'k1', text: 'A' },
    { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 0, id: 'k2', text: 'B' },
  ]
  const s1 = newStroke('pen', straight)
  b.strokes.push({ ...s1, id: 'link1', points: toFlat([{ x: 60, y: 40 }, { x: 300, y: 41 }, { x: 660, y: 40 }]) })
  const s2 = newStroke('pen', arrow)
  b.strokes.push({ ...s2, id: 'link2', points: toFlat([
    { x: 60, y: 40 }, { x: 300, y: 40 }, { x: 600, y: 40 }, { x: 580, y: 52 }, { x: 662, y: 38 },
  ]) })

  const links = reader.read(b)
  eq(links.length, 2, '两笔连线 → 两条连接')
  eq([links[0].a, links[0].b], ['k1', 'k2'], '第一条连的是 k1 → k2')
  eq(links[0].kind, 'rel', '直线读成"相关"')
  eq(links[0].dir, false, '"相关"没有方向')
  eq(links[1].kind, 'cause', '带箭头那笔读成"因果"')
  eq(links[1].dir, true, '"因果"有方向（方向 = 你画的方向）')
  eq(links[1].manual, false, '形状读出来的不算"你标过"')

  /* ★ 只有**手动标过**的才写进文件。上一步那两条都是形状读的 —— 文件里不许有 link。 */
  const s0 = serializeBoardDocument(b)
  if (!/"link"/.test(s0)) ok('形状读出来的类型**不写进文件**（老文件、没动过的文件零字节变化）')
  else bad('形状读出来的类型被写进文件了 —— 会和笔迹对不上（擦掉箭头文件里还留着"因果"）')

  /* 手动标一个：改一个"自动读不出来的"词，这次必须写。 */
  b.strokes = b.strokes.map((x) => (x.id === 'link1' ? { ...x, link: 'derive' } : x))
  const back1 = parseBoardDocument(serializeBoardDocument(b), 'x')
  eq(back1.strokes.find((x) => x.id === 'link1').link, 'derive', '手动标的词读得回来')
  eq(reader.read(back1).find((l) => l.strokeId === 'link1').kind, 'derive', '手动标的词压过形状读出来的')
  eq(reader.read(back1).find((l) => l.strokeId === 'link1').manual, true, '它被认成"你标过的"')

  /* ★ 标回"形状自动读出来那一档"（直线标回 rel）时，字段该**消失**、不是写个 link: "rel"。
     这条规矩的实现落在 UI 那边（Board.jsx 的 applyLink —— 只有它知道"自动读出来的是什么"），
     所以由真浏览器那条自检钉（check-link.js 会去查文件里有没有 link 字段）。
     纯逻辑这一层只钉"手动标的写出去、认不出的丢掉"。 */

  /* 手改文件写了个认不出的词（中文名、大小写、别的版本的 id）：一律丢掉、回到自动。 */
  const dirty = parseBoardDocument(
    JSON.stringify({ strokes: [{ id: 's1', tool: 'pen', points: straight, link: '因果' }], cards: [] }),
    'x'
  )
  eq(dirty.strokes[0].link, undefined, '文件里认不出的 link 值丢掉（不退回默认再写回去）')
  const dirty2 = parseBoardDocument(
    JSON.stringify({ strokes: [{ id: 's1', tool: 'pen', points: straight, link: 1 }], cards: [] }),
    'x'
  )
  eq(dirty2.strokes[0].link, undefined, '数字 1 也不算（只认那几个 id）')

  /* 荧光笔跳过：它是"在字上做记号"，一划一大片，端点很容易正好落在两张卡里。 */
  const b4 = makeBoard()
  b4.cards = b.cards
  b4.strokes = [{ ...newStroke('highlighter', straight), id: 'hl1' }]
  b4.strokes[0].points = straight
  eq(reader.read(b4).length, 0, '荧光笔不算连接（记号 ≠ 关系）')

  /* 方向：把点倒过来，a/b 就换了 —— 箭头方向就是这么表达的（渲染出来一模一样）。 */
  const b5 = parseBoardDocument(serializeBoardDocument(b), 'x')
  const flip = (flat) => {
    const out = []
    for (let i = flat.length - 3; i >= 0; i -= 3) out.push(flat[i], flat[i + 1], flat[i + 2])
    return out
  }
  const rev = { ...b5, strokes: b5.strokes.map((x) => (x.id === 'link2' ? { ...x, points: flip(x.points) } : x)) }
  const l5 = reader.read(rev).find((l) => l.strokeId === 'link2')
  eq([l5.a, l5.b], ['k2', 'k1'], '把这一笔的点倒过来 → 方向反过来（k1→k2 变成 k2→k1）')

  /* 连线两端落在**同一张卡**里不算连接（那是圈了一下自己）。 */
  const b6 = makeBoard()
  b6.cards = [{ ...newCard('note', 0, 0, { w: 400, h: 300 }), x: 0, y: 0, id: 'big', text: '大卡' }]
  b6.strokes = [{ ...newStroke('pen', straight), id: 'in1', points: toFlat([{ x: 20, y: 20 }, { x: 200, y: 20 }]) }]
  eq(reader.read(b6).length, 0, '两端在同一张卡里不算连接')
}

// ═════════════════════════ 6e. 用户真手画的箭头 ═════════════════════════
console.log('\n[6e] 真手画箭头：拿用户本人的笔迹当夹具（scripts/fixtures/hand-arrows.json）')
{
  /* 这一节存在的唯一理由：**形状判据不能凭空定阈值**。
     用户 2026-09-16 把两张手画箭头的截图发来，scripts/extract-hand-arrows.py
     把墨迹细化成骨架、解出"杆 / 两个臂"的中心线，并按纸的横线反推出缩放 ——
     于是这里跑的是他的真实笔迹，不是我想象中的箭头。
     他两张图量出来的共同点：张开角 105~107°、臂长 51~59 世界像素、
     **杆的墨迹一直画到尖上**（V 的顶点和杆的末端重叠）。
     他画箭头的方式是**两笔**：一杆一笔、V 尖一笔。 */
  const fix = JSON.parse(readFileSync(new URL('./fixtures/hand-arrows.json', import.meta.url), 'utf8'))
  eq(fix.images.length, 2, '夹具里有两张图（长杆箭头 / 短粗箭头）')

  for (const img of fix.images) {
    const role = Object.fromEntries(img.strokes.map((s) => [s.role, toPoints(s.points)]))
    const shaft = role.shaft
    const barbA = role.barbA
    const barbB = role.barbB
    const tipPt = shaft[shaft.length - 1]
    const tailPt = shaft[0]
    const V = barbA.slice().reverse().concat(barbB)

    /* ── 判据本身 ── */
    eq(classifyLinkShape(shaft), 'line', `${img.key}：光一根杆 → 线（它自己是直的）`)
    const tip1 = findTip(shaft)
    const tipOne = findTip(shaft.concat(barbA))
    if (tipOne && tipOne.open <= TIP_MAX_ANGLE && tipNearEnd(tipOne)) {
      ok(`${img.key}：一整笔（杆+臂）读出了尖，张开 ${round(tipOne.open)}°、两边弧长 ${round(tipOne.back)}/${round(tipOne.fwd)}`)
    } else {
      bad(`${img.key}：一整笔没读出尖（${JSON.stringify(tipOne)}）`)
    }
    const head = readArrowHead(V)
    if (head) ok(`${img.key}：单独那个 V 认成了箭头尖（臂长 ${round(head.arm)} 世界像素，张开 ${round(findTip(V).open)}°）`)
    else bad(`${img.key}：单独一个 V 没认出来（这是"两笔画的箭头"那条路能不能走通的关键）`)

    /* ── 摆到板上：两张卡，尖指着第二张（离它 20px，**没有碰到**）── */
    const mkBoard = (strokes) => {
      const b = makeBoard()
      const w = 220
      const h = 90
      b.cards = [
        { ...newCard('note', 0, 0, { w, h }), x: tailPt.x - w + 20, y: tailPt.y - h / 2, id: 'k1', text: 'A' },
        { ...newCard('note', 0, 0, { w, h }), x: tipPt.x + 20, y: tipPt.y - h / 2, id: 'k2', text: 'B' },
      ]
      b.strokes = strokes.map(([id, pts]) => ({ ...newStroke('pen', toFlat(pts)), id }))
      return b
    }
    const cases = [
      ['一笔画成（杆 + 臂连在一起）', [['s1', shaft.concat(barbA)]], true],
      ['两笔：杆 ｜ V 尖', [['s1', shaft], ['s2', V]], true],
      ['两笔：杆 ｜ V 尖（尖朝另一头画）', [['s1', shaft], ['s2', barbB.slice().reverse().concat(barbA)]], true],
      ['三笔：杆 ｜ 臂A ｜ 臂B（每笔一撇）', [['s1', shaft], ['s2', barbA], ['s3', barbB]], true],
      ['只有一根杆（没有尖）', [['s1', shaft]], false],
    ]
    for (const [name, strokes, want] of cases) {
      const b = mkBoard(strokes)
      const links = reader.read(b)
      const l = links.find((x) => x.a === 'k1' && x.b === 'k2')
      if (want) {
        if (!l) {
          bad(`${img.key}·${name}：没连上（应该是 k1 → k2）`)
          continue
        }
        eq([l.a, l.b, l.kind, l.shape, l.headInk], ['k1', 'k2', 'cause', 'arrow', true],
          `${img.key}·${name}：k1→k2、读成因果、尖是你画的（不再合成箭头）`)
        near(Math.hypot(l.tip.x - tipPt.x, l.tip.y - tipPt.y), 0, 6, `${img.key}·${name}：尖的位置对得上他画的尖`)
      } else if (links.length === 0) {
        ok(`${img.key}·${name}：不成立连接（没有尖 → 不靠"指着谁"连）`)
      } else {
        bad(`${img.key}·${name}：不该有连接，却出来 ${links.length} 条`)
      }
    }
  }

  /* ── 反例：别把别的东西认成箭头 ── */
  /* L 形：拐弯 90°，但尖在**正中间** —— 它是一条折线式的连接，不是箭头。 */
  const elbowBig = toFlat([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 400, y: 200 }])
  const te = findTip(elbowBig)
  if (te && !tipNearEnd(te)) ok('L 形折线的拐角虽然够尖，但它**不挨着任何一头** → 不当箭头')
  else bad(`L 形折线被判成了箭头尖（${JSON.stringify(te)}）`)
  /* "两根从同一点拉出去的线"：各自都是长线，不该被接成一根。 */
  const b7 = makeBoard()
  b7.cards = [
    { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 0, id: 'k1' },
    { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: -300, id: 'k2' },
    { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 300, id: 'k3' },
  ]
  b7.strokes = [
    { ...newStroke('pen', toFlat([{ x: 60, y: 40 }, { x: 660, y: -260 }])), id: 'fan1' },
    { ...newStroke('pen', toFlat([{ x: 60, y: 40 }, { x: 660, y: 340 }])), id: 'fan2' },
  ]
  const fan = reader.read(b7)
  eq(fan.length, 2, '从同一点拉出去的两根线：各算各的（没被接成一根）')
  eq(fan.map((l) => l.a + '→' + l.b).sort(), ['k1→k2', 'k1→k3'], '两根的目标都对')
}

// ═════════════════════════ 6f. 墨迹块当端点（没成卡的字迹 / 手画的图） ═════════════════════════
console.log('\n[6f] 墨迹块：没成卡的字迹、手画的图也能当连接的端点')
{
  /* 用户 2026-09-16 的原话：「连接的不只是卡片，可能还有我没转化成卡片的字迹，
     我自己手绘的图」。这一节里的阈值全是拿他板上 439 笔量的（README 第 22 条）：
     笔画长度中位 26px、99% 不到 146px；"长 ≥120px 且中段是空白"的只有个位数笔。
     所以这三道闸（够长 + 中段空白 + 两头不同节点）非常保守。 */
  const blob = (cx, cy, n = 3) => {
    /* 一坨"字迹"：n 根短笔，彼此 3~9px（他板上"每笔到别的笔"的最近距离中位 4.3px） */
    const out = []
    for (let i = 0; i < n; i++) {
      const x = cx + i * 9
      out.push(toFlat([{ x, y: cy }, { x: x + 6, y: cy + 7 }]))
    }
    return out
  }
  const mk = (strokes, cards = []) => {
    const b = makeBoard()
    b.cards = cards
    b.strokes = strokes.map(([id, flat]) => ({ ...newStroke('pen', flat), id }))
    return b
  }
  const line = (id, from, to) => [id, toFlat([from, to])]
  const A = blob(0, 0)
  const B = blob(500, 0)
  const put = (skip = null) => [
    ...A.map((f, i) => ['a' + i, f]),
    ...B.map((f, i) => ['b' + i, f]),
    ...(skip ? [] : []),
  ]

  /* ── ① 两块字迹之间画一条直线：这就是"连到没成卡的字迹上" ── */
  {
    const b = mk([...put(), line('lnk', { x: 6, y: 3 }, { x: 506, y: 3 })])
    const ls = reader.read(b)
    eq(ls.length, 1, '两块字迹之间画一条线 → 出来 1 条连接')
    if (ls.length === 1) {
      eq([ls[0].aKind, ls[0].bKind], ['ink', 'ink'], '两端都算"墨迹块"（不是卡片）')
      eq(ls[0].kind, 'rel', '直线 → 读成"相关"（最弱的那一档，猜错也不误导）')
      if (/墨迹块/.test(ls[0].aLabel) && /墨迹块/.test(ls[0].bLabel)) {
        ok(`面板上有名字：${ls[0].aLabel} → ${ls[0].bLabel}`)
      } else {
        bad(`墨迹块的 label 不对：${JSON.stringify([ls[0].aLabel, ls[0].bLabel])}`)
      }
      if (ls[0].a !== ls[0].b) ok('两端是两块，不是同一块')
      else bad('两端算成了同一块')
    }
  }

  /* ── ② 同一坨字迹内部：字里的一横，两头落在同一块里 → 不算连接 ── */
  {
    const b = mk([...put(), line('lnk', { x: 2, y: 1 }, { x: 26, y: 8 })])
    eq(reader.read(b).length, 0, '同一块内部的一笔（字里的一横）不算连接')
  }

  /* ── ③ 公式的分数线：够长，但中段上下就是分子分母（贴着一堆墨）→ 不算连接 ── */
  {
    const frac = [
      ['num', toFlat([{ x: 500, y: -14 }, { x: 540, y: -14 }])],
      ['den', toFlat([{ x: 500, y: 16 }, { x: 540, y: 16 }])],
      ['bar', toFlat([{ x: 496, y: 1 }, { x: 544, y: 1 }])], // 48px 的分数线
      ['side', toFlat([{ x: 560, y: 0 }, { x: 574, y: 6 }])],
    ]
    const b = mk([...put(), ...frac])
    eq(reader.read(b).length, 0, '分数线中段贴着分子/分母 → 中段不是空白 → 不算连接')
  }

  /* ── ④ 一条长线的中段**穿过**另一坨墨 → 不算连接（中段那一段必须空） ── */
  {
    const mid = blob(250, -6)
    const b = mk([...put(), ...mid.map((f, i) => ['m' + i, f]), line('lnk', { x: 6, y: 3 }, { x: 506, y: 3 })])
    eq(reader.read(b).length, 0, '长线的中段压着别的墨 → 不算连接')
  }

  /* ── ⑤ 卡片 → 字迹：一头卡一头块 ── */
  {
    const card = { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: -320, y: -30, id: 'k1', text: '公式卡' }
    const b = mk([...A.map((f, i) => ['a' + i, f]), line('lnk', { x: -260, y: 3 }, { x: 20, y: 3 })], [card])
    const ls = reader.read(b)
    eq(ls.length, 1, '从卡片画一条线到字迹上 → 出来 1 条连接')
    if (ls.length === 1) eq([ls[0].a, ls[0].aKind, ls[0].bKind], ['k1', 'card', 'ink'], '一头是卡片、一头是墨迹块')
  }

  /* ── ⑥ 卡片↔卡片那条路**不受这三道闸约束**（它铁定是连接，不能被我改坏） ── */
  {
    const k1 = { ...newCard('note', 0, 0, { w: 60, h: 40 }), x: 0, y: 0, id: 'k1' }
    const k2 = { ...newCard('note', 0, 0, { w: 60, h: 40 }), x: 100, y: 0, id: 'k2' }
    const b = mk([line('short', { x: 30, y: 20 }, { x: 100, y: 20 })], [k1, k2])
    const ls = reader.read(b)
    eq(ls.length, 1, '两张卡之间的**短线**（比 INK_LINK_MIN_LEN 还短）照样算连接')
    if (ls.length === 1) eq([ls[0].a, ls[0].b], ['k1', 'k2'], '方向按你画的方向')
  }

  /* ── ⑦ 已知代价（钉住这个取舍）：两块挨得近 + 线画得短 → 认不出来 ──
     中段采样点（弧长 30%~70%）会落进端点那块墨的 INK_LINK_MID_GAP(18px) 里。
     要连就得把线画长一点（跨过空白）。这是"宁可漏、不误判"的代价 ——
     ⚠ 中段阈值从 18 降到 12 会让它认出来，但同时会在**真板**上多出一条假连接
     （实测 2026-09-16：一条 121px 的手写竖笔被读成"卡→字迹"）—— 所以保持 18。
     以后要放宽，先看这条、再拿真板量一遍。 */
  {
    const near2 = blob(70, 0)
    const b = mk([
      ...A.map((f, i) => ['a' + i, f]),
      ...near2.map((f, i) => ['b' + i, f]),
      line('lnk', { x: 10, y: 3 }, { x: 60, y: 3 }), // 50px：够长（≥48），但中段还是贴着两头的墨
    ])
    const ls = reader.read(b)
    if (ls.length === 0) ok('两块贴着、线又画得短 → 认不出（已记在案的代价：把线画长一点就认）')
    else bad(`短距离的两块之间不该出连接，却出了 ${ls.length} 条`)
  }

  /* ── ⑧ 块本身：数得出几块、id 稳不稳 ── */
  {
    const b = mk(put())
    const blocks = inkBlocks(b.strokes)
    eq(blocks.length, 2, '两坨字迹 → 2 块（每坨内部 3 笔挨在一起）')
    const idx = createInkIndex(b.strokes)
    const n1 = inkNodeAt(idx, { x: 3, y: 3 })
    const n2 = inkNodeAt(idx, { x: 3, y: 3 })
    if (n1 && n2 && n1.id === n2.id) ok(`同一个点查两次 → 同一个块 id（${n1.id}）`)
    else bad('块 id 不稳定')
    if (n1 && n1.ids.length === 3) ok('块的成员是那 3 笔')
    else bad(`块的成员数不对：${n1 && n1.ids.length}`)
    eq(inkNodeAt(idx, { x: 250, y: 250 }), null, '空白处没有块')
  }

  /* ── ⑨ 真手画箭头指着"一坨字迹"（他的实际用法）── */
  {
    const fix = JSON.parse(readFileSync(new URL('./fixtures/hand-arrows.json', import.meta.url), 'utf8'))
    const img = fix.images[0]
    const role = Object.fromEntries(img.strokes.map((s) => [s.role, toPoints(s.points)]))
    const shaft = role.shaft
    const tail = shaft[0]
    const tipPt = shaft[shaft.length - 1]
    const V = role.barbA.slice().reverse().concat(role.barbB)
    /* 尾巴那一头放一坨字迹；尖外面 18px 再放一坨（箭头指着它，但没碰到） */
    const da = (dx, dy) => ({ x: dx, y: dy })
    const blobs = [
      ...blob(tail.x - 6, tail.y - 3).map((f, i) => ['a' + i, f]),
      ...blob(tipPt.x + 18, tipPt.y - 3).map((f, i) => ['b' + i, f]),
    ]
    const b = mk([...blobs, ['sh', toFlat(shaft)], ['v1', toFlat(role.barbA)], ['v2', toFlat(role.barbB)]])
    const ls = reader.read(b)
    eq(ls.length, 1, '真手画箭头（杆 + 两撇）指着字迹 → 出来 1 条连接')
    if (ls.length === 1) {
      eq([ls[0].aKind, ls[0].bKind, ls[0].kind, ls[0].shape, ls[0].headInk], ['ink', 'ink', 'cause', 'arrow', true],
        '读成"因果"、尖是你自己画的（不再合成箭头）')
      if (ls[0].a !== ls[0].b) ok('尾巴那坨和尖指的那坨是两块')
      else bad('箭头把两坨认成了同一块')
    }
  }
}

// ═════════════════════════ 6g. 「这条不算连接」 ═════════════════════════
console.log('\n[6g] 「不算连接」：自动读错了要有一条一键改回来的路')
{
  /* 为什么要有这一节：形状/位置自动读出来的连接**会读错**（实测：一条 121px 的手写竖笔
     正好跨过两坨字就被读成了连接）。在那之前认错了只能擦掉那一笔重画 ——
     "猜错还锁死"正是这套设计最怕的事。所以：`stroke.link = 'none'` = 你说了它不是连接。 */
  const blob = (cx, cy) => [0, 1, 2].map((i) => toFlat([{ x: cx + i * 9, y: cy }, { x: cx + i * 9 + 6, y: cy + 7 }]))
  const strokes = [
    ...blob(0, 0).map((f, i) => ['a' + i, f]),
    ...blob(500, 0).map((f, i) => ['b' + i, f]),
    ['lnk', toFlat([{ x: 6, y: 3 }, { x: 506, y: 3 }])],
  ]
  const build = (link) => {
    const b = makeBoard()
    b.strokes = strokes.map(([id, flat]) => {
      const st = { ...newStroke('pen', flat), id }
      if (id === 'lnk' && link) st.link = link
      return st
    })
    return b
  }
  eq(reader.read(build(null)).length, 1, '先确认这条线本来是会被读成连接的')
  eq(reader.read(build(LINK_NONE)).length, 0, '标了「不算连接」→ 不再读成连接')
  eq(reader.read(build('cause')).length, 1, '标成「因果」当然还是连接（这两个不是一回事）')

  /* 存盘：这句话要活得下去（不然重开之后那条假连接自己回来了） */
  const text = serializeBoardDocument(build(LINK_NONE))
  if (/"link":\s*"none"/.test(text)) ok('存盘里写着 link: "none"')
  else bad('「不算连接」没写进文件 —— 重开就丢了')
  const back = parseBoardDocument(text, 'x')
  eq(reader.read(back).length, 0, '读回来还是"不算连接"')
  eq(back.strokes.find((s) => s.id === 'lnk').link, LINK_NONE, '字段原样保留')
  /* 只有你说过的那一笔有这个字段：别的笔、以及没标过的板，一个字节都不多 */
  const plain = serializeBoardDocument(build(null))
  if (!/link/.test(plain)) ok('没标过的板一个 link 字段都不写（不造假 diff）')
  else bad('没标过的板里出现了 link 字段')
}
// ═════════════════════ 6h. 固定成一块 / 拆开 ═════════════════════
console.log('\n[6h] 框选固化（`groups`）：自动聚错了，得有地方纠正它')
{
  /* 自动聚类会把挨得近的两坨并成一块。后果虽然轻（"多连了一个"），
     但你没地方纠正它就很难受 —— 这个功能就是那个地方：
     框住一块 → 固定成一块；两块各自固定 = 把它们拆开。 */
  const blob = (cx, cy) => [0, 1, 2].map((i) => toFlat([{ x: cx + i * 9, y: cy }, { x: cx + i * 9 + 6, y: cy + 7 }]))
  const mk = (groups) => {
    const b = makeBoard()
    b.strokes = [
      ...blob(0, 0).map((f, i) => ({ ...newStroke('pen', f), id: 'a' + i })),
      ...blob(30, 0).map((f, i) => ({ ...newStroke('pen', f), id: 'b' + i })),
    ]
    b.groups = groups
    return b
  }
  /* 两坨只差 6px（< INK_BLOCK_GAP）→ 自动聚成一块 */
  eq(inkBlocks(mk([]).strokes).length, 1, '两坨挨得近 → 自动聚成 1 块')

  const fixed = [
    { id: 'g1', ids: ['a0', 'a1', 'a2'] },
    { id: 'g2', ids: ['b0', 'b1', 'b2'] },
  ]
  const b2 = mk(fixed)
  const blocks = inkBlocks(b2.strokes, { groups: b2.groups })
  eq(blocks.length, 2, '两块各自固定 → 2 块（这就是"拆开"）')
  eq(blocks.map((x) => x.id).sort(), ['grp:g1', 'grp:g2'], '固定块的 id 用组 id（稳定、跨重开一样）')
  eq(blocks.filter((x) => x.fixed).length, 2, '两块都标着 fixed')
  if (/固定/.test(blocks[0].label)) ok(`面板上有名字：${blocks[0].label}`)
  else bad(`固定块的 label 不对：${blocks[0].label}`)
  /* 固定之后端点认到的是**那一块**（不是自动并出来的大块） */
  const idx = createInkIndex(b2.strokes, b2.groups)
  eq(inkNodeAt(idx, { x: 3, y: 3 }).id, 'grp:g1', '落在第一坨上 → 拿到的是固定的那一块')
  eq(inkNodeAt(idx, { x: 33, y: 3 }).id, 'grp:g2', '落在第二坨上 → 另一块')

  /* ① 固定块必须在 **buildLinks** 里生效（不能只直接问 inkNodeAt）——
     2026-09-16 审查挑出来的严重 bug：固定块登记在 `owner` 上，而 `owner` 在 dropKey
     变化时被清掉（dropKey 初始是 undefined，第一次 buildLinks 就清光），
     于是"固定反而丢连接、把相隔很远的两坨固定成一块还会凭空造出连接"。
     自检当时只直接问了 inkNodeAt，所以两条都漏过了。 */
  {
    const blobs = (cx) => [0, 1, 2].map((i) => [`${cx}_${i}`, toFlat([{ x: cx + i * 9, y: 0 }, { x: cx + i * 9 + 6, y: 7 }])])
    const mkB = (groups) => {
      const b = makeBoard()
      b.strokes = [
        ...blobs(0).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
        ...blobs(600).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
        { ...newStroke('pen', toFlat([{ x: 12, y: 3 }, { x: 612, y: 3 }])), id: 'ln' },
      ]
      b.groups = groups
      return b
    }
    /* 干净板：两头都是自动聚出来的块 */
    const l0 = reader.read(mkB([]))[0]
    eq([l0 && l0.aKind, l0 && l0.bKind], ['ink', 'ink'], '不固定时：两头都是自动聚出来的墨迹块')

    /* 固定第一坨 → **buildLinks 必须还给出这条连接**，而且那一头是「固定的块」 */
    const fixed = mkB([{ id: 'gA', ids: ['0_0', '0_1', '0_2'] }])
    const idx = createInkIndex(fixed.strokes, fixed.groups)
    const l1 = reader.read(fixed, idx)[0] // ← 走应用真实路径（复用记忆化的索引）
    if (l1) {
      eq(l1.a, 'grp:gA', '固定之后：那一头是固定的块（id 用组 id）')
      if (/固定/.test(l1.aLabel || '')) ok(`名字也对：${l1.aLabel}`)
      else bad(`固定块的名字不对：${l1.aLabel}`)
      eq(l1.bKind, 'ink', '另一头还是自动聚的块')
    } else {
      bad('固定一坨之后连接没了 —— 固定块在 buildLinks 里失效了（owner 被清掉那个 bug）')
    }
    /* 复用同一个索引再来一次（应用里就是复用），结果必须一样 */
    eq(JSON.stringify(reader.read(fixed, idx)), JSON.stringify(reader.read(fixed, idx)), '复用索引连算两次结果一致')

    /* 把**相隔很远的两坨固定成一块**：线两头落在同一个节点里 → 不该成连接。
       （这条 bug 的表现是"凭空造出一条连接"：索引被清之后两头各算成一块自动块。） */
    const one = mkB([{ id: 'gAll', ids: ['0_0', '0_1', '0_2', '600_0', '600_1', '600_2'] }])
    eq(reader.read(one, createInkIndex(one.strokes, one.groups)).length, 0, '两坨固定成一块之后：线两头是同一个节点 → 不算连接')
  }

  /* 存盘：只在真有固定块时才写这个字段；成员被擦掉的那些不留尸体 */
  const text = serializeBoardDocument(b2)
  const back = parseBoardDocument(text, 'x')
  eq(back.groups.length, 2, '固定块存进文件了')
  eq(back.groups[0].ids, ['a0', 'a1', 'a2'], '成员原样')
  const noGroups = serializeBoardDocument(mk([]))
  if (!/groups/.test(noGroups)) ok('没固定过的板一个 groups 字段都不写（不造假 diff）')
  else bad('没固定过的板里出现了 groups')
  const halfDead = serializeBoardDocument({ ...b2, strokes: b2.strokes.filter((s) => s.id !== 'a1') })
  const hd = JSON.parse(halfDead)
  eq(hd.groups[0].ids, ['a0', 'a2'], '擦掉一笔之后，组里那个死 id 不再写出去')
  const allDead = parseBoardDocument(
    serializeBoardDocument({ ...b2, strokes: b2.strokes.filter((s) => !s.id.startsWith('a')) }),
    'x'
  )
  eq(allDead.groups.map((g) => g.id), ['g2'], '一块的成员被擦光 → 那个组自己消失（不留空壳）')

  /* 同一笔不许进两个组（重复的 id 一律丢掉） */
  const dup = parseBoardDocument(
    serializeBoardDocument({ ...b2, groups: [...fixed, { id: 'g3', ids: ['a0', 'a1', 'a2'] }] }),
    'x'
  )
  eq(dup.groups.map((g) => g.id), ['g1', 'g2'], '同一笔不能同时属于两个组（后来那个丢掉）')
}

// ═════════════════════ 6i. 条件从位置送 + 推导链 ═════════════════════
console.log('\n[6i] 条件从位置送（线中点旁边那几个字）+ 推导链读成链')
{
  /* 用户的原话：「条件是位置送的。线中点附近那几个字 / 那张卡，自动成为这条关系的条件
     —— 你本来就要写"仅当…"，不用再告诉它是谁的条件。」 */
  const A = { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 0, y: 0, id: 'ka', text: '式子A' }
  const B = { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 400, y: 0, id: 'kb', text: '式子B' }
  /* 两行短笔（条件）：给个 (cx,cy)，摆成一小坨 —— 个头要过 INK_NODE_MIN_SIZE */
  const condStrokes = (cx, cy, idp) => [
    [`${idp}1`, toFlat([{ x: cx, y: cy }, { x: cx + 10, y: cy + 6 }])],
    [`${idp}2`, toFlat([{ x: cx + 14, y: cy }, { x: cx + 24, y: cy + 7 }])],
    [`${idp}3`, toFlat([{ x: cx, y: cy + 12 }, { x: cx + 22, y: cy + 14 }])],
  ]
  const mk = (extra = [], cards = [A, B]) => {
    const b = makeBoard()
    b.cards = cards
    b.strokes = [
      ['ln', toFlat([{ x: 60, y: 30 }, { x: 460, y: 30 }])], // 卡 A → 卡 B 的一条直线
      ...extra,
    ].map(([id, flat]) => ({ ...newStroke('pen', flat), id }))
    return b
  }
  const mid = { x: 260, y: 30 } // 那条线的弧长中点

  eq(reader.read(mk()).length, 1, '先确认这条线是连接')
  eq(reader.read(mk())[0].cond, null, '线中点旁边什么都没有 → 没有条件')

  /* ① 中点旁边写几个字 → 它们就是条件 */
  {
    const b = mk(condStrokes(mid.x - 12, mid.y - 34, 'c'))
    const l = reader.read(b)[0]
    if (l.cond && l.cond.kind === 'ink' && l.cond.ids.length === 3) {
      ok(`线中点旁边那 3 笔成了条件：${l.cond.label}`)
    } else {
      bad(`条件没读出来：${JSON.stringify(l.cond)}`)
    }
    eq(l.cond && l.cond.kind, 'ink', '条件的 kind 是墨迹块')
  }

  /* ② 同样的字摆在**端点**旁边（不在中点）→ 不算条件 */
  {
    const b = mk(condStrokes(370, 44, 'c')) // 离中点 110px 以上，但离 B 那端很近
    const l = reader.read(b)[0]
    eq(l.cond, null, '字摆在端点旁边（不是中点）→ 不算条件')
  }

  /* ③ 中点旁边放一张卡 → 卡片优先（那是"明写的条件"） */
  {
    const C = { ...newCard('note', 0, 0, { w: 90, h: 40 }), x: 215, y: -60, id: 'kc', text: '仅当…' }
    const b = mk([], [A, B, C])
    const l = reader.read(b)[0]
    eq(l.cond && l.cond.kind, 'card', '线中点旁边那张卡才是条件')
    eq(l.cond && l.cond.id, 'kc', '条件指向那张卡')
  }

  /* ④ 一撮 2px 的小墨点不算条件（和墨迹块同一条"最小个头"闸） */
  {
    const b = mk([['p', toFlat([{ x: mid.x, y: mid.y - 30 }, { x: mid.x + 1.5, y: mid.y - 30 }])]])
    eq(reader.read(b)[0].cond, null, '一个 2px 的点不算条件')
  }

  /* ⑤ 推导链：A —推导→ B —推导→ C，中间那步缺条件 */
  {
    const C = { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 800, y: 0, id: 'kc', text: '式子C' }
    const b = makeBoard()
    b.cards = [A, B, C]
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 60, y: 30 }, { x: 460, y: 30 }])), id: 'l1', link: 'derive' },
      { ...newStroke('pen', toFlat([{ x: 460, y: 30 }, { x: 860, y: 30 }])), id: 'l2', link: 'derive' },
      ...condStrokes(250, -4, 'c').map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
    ]
    const links = reader.read(b)
    eq(links.length, 2, '两条推导都成立')
    const chains = deriveChains(links)
    eq(chains.length, 1, '读成 1 条链')
    eq(chains[0].steps.map((s) => s.from + '→' + s.to), ['ka→kb', 'kb→kc'], '链的顺序是 A→B→C')
    eq(chains[0].missing, 1, '标出"有一步缺条件"')
    eq(chains[0].steps[0].missing, false, '第一步有条件（中点旁边那 3 笔）')
    eq(chains[0].steps[1].missing, true, '第二步缺条件')

    /* 因果那条不算推导链（链只认"推导"）：把 A→B 标成因果，链就该从 B 开始 */
    const b2 = { ...b, strokes: b.strokes.map((s) => (s.id === 'l1' ? { ...s, link: 'cause' } : s)) }
    const ch2 = deriveChains(reader.read(b2))
    eq(ch2.map((c) => c.steps.map((s) => s.from + '→' + s.to).join(',')), ['kb→kc'], '标成「因果」的那条不进推导链（链从 B 开始）')
  }

  /* ⑦ 条件不能是**别的连接线**（审查挑出来的）：两条卡片连线交叉时，
     交叉的那条线会被读成对方的条件，于是"缺条件"被无关的线掩盖。 */
  {
    const dense = (x0, y0, x1, y1, n = 24) =>
      toFlat(Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1) })))
    const b = makeBoard()
    b.cards = [
      { ...newCard('note', 0, 0, { w: 80, h: 50 }), x: 0, y: 0, id: 'k1' },
      { ...newCard('note', 0, 0, { w: 80, h: 50 }), x: 400, y: 0, id: 'k2' },
      { ...newCard('note', 0, 0, { w: 80, h: 50 }), x: 400, y: 400, id: 'k3' },
      { ...newCard('note', 0, 0, { w: 80, h: 50 }), x: 0, y: 400, id: 'k4' },
    ]
    b.strokes = [
      { ...newStroke('pen', dense(40, 25, 440, 425)), id: 'l1' }, // 左上 → 右下（卡↔卡）
      { ...newStroke('pen', dense(40, 425, 440, 25)), id: 'l2' }, // 左下 → 右上（交叉）
    ]
    const ls = reader.read(b)
    eq(ls.length, 2, '两条交叉的卡片连线都成立')
    const cross = ls.filter((l) => l.cond && l.cond.kind === 'ink' && l.cond.ids.includes('l2'))
    const cross2 = ls.filter((l) => l.cond && l.cond.kind === 'ink' && l.cond.ids.includes('l1'))
    eq(cross.length + cross2.length, 0, '别的连接线不会被当成条件（两条线互相都不算）')
  }

  /* ⑧ 端点卡离中点更近时，真正写在中点旁边的"条件卡"仍然要读出来 */
  {
    /* 线 (60,120)→(60,200)：中点 (60,160)。两张**端点卡**各离中点 20px、条件卡 k3 离 40px ——
       旧代码"只看最近一张卡"会挑到端点卡、然后**整体放弃卡片分支**，
       于是真正写在中点旁边那张 k3 被漏掉（审查挑出来的）。 */
    const b = makeBoard()
    b.strokes = [{ ...newStroke('pen', toFlat([{ x: 60, y: 120 }, { x: 60, y: 200 }])), id: 'ln' }]
    b.cards = [
      { ...newCard('note', 0, 0, { w: 80, h: 50 }), x: 0, y: 90, id: 'k1' },
      { ...newCard('note', 0, 0, { w: 80, h: 50 }), x: 20, y: 180, id: 'k2' },
      { ...newCard('note', 0, 0, { w: 80, h: 40 }), x: 100, y: 150, id: 'k3' },
    ]
    const l = reader.read(b)[0]
    if (l && l.cond && l.cond.id === 'k3') ok('两张端点卡都比它近，中点旁边 40px 那张条件卡照样读出来')
    else bad(`条件卡被漏掉了：cond=${JSON.stringify(l && l.cond)}`)
  }

  /* ⑨ 分叉要每条路都走；太长要标记（不能静默截断） */
  {
    const mkL = (pairs) => pairs.map(([a, bb]) => ({ a, b: bb, kind: 'derive', cond: null, strokeId: a + bb }))
    const fork = deriveChains(mkL([['A', 'B'], ['B', 'C'], ['B', 'D']]))
    const flat = fork.map((c) => c.steps.map((s) => s.from + '→' + s.to).join(',')).sort()
    eq(flat, ['A→B,B→C', 'A→B,B→D'], '分叉的每条路都成链（B→D 不再消失）')
    const long = mkL([['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']])
    const cut = deriveChains(long, 2)
    eq(cut[0].steps.length, 2, '超过上限就截断到上限')
    eq(cut[0].truncated, true, '截断了要标出来（面板才不会假装"就这么多"）')
    eq(deriveChains(mkL([['A', 'A']])).length, 0, '自环不算链（a===b 没有意义）')
  }

  /* ⑩ 「又算回连接」要按**整条链**清：link:'none' 当初写在整条链上 */
  {
    const b = makeBoard()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }])), id: 'p1', link: 'none' },
      { ...newStroke('pen', toFlat([{ x: 100, y: 0 }, { x: 200, y: 0 }])), id: 'p2', link: 'none' },
      { ...newStroke('pen', toFlat([{ x: 400, y: 0 }, { x: 460, y: 0 }])), id: 'other' },
    ]
    const chain = chainOfStroke(b, 'p1')
    eq(chain.sort(), ['p1', 'p2'], 'chainOfStroke：点到链里任意一笔，都给回整条链')
    eq(chainOfStroke(b, 'other'), ['other'], '不在任何链里的笔：给回它自己')
  }

  /* ⑥ 分叉与成环都不能把面板卡死 */  {
    const C = { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 800, y: 0, id: 'kc' }
    const D = { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 800, y: 300, id: 'kd' }
    const mkLinks = (pairs) => pairs.map(([a, bb]) => ({ a, b: bb, kind: 'derive', cond: null, strokeId: a + bb }))
    const fork = deriveChains(mkLinks([['ka', 'kb'], ['ka', 'kc']]))
    eq(fork.length, 2, '一个节点分两条 → 两条链（不硬凑成一条）')
    const cyc = deriveChains(mkLinks([['ka', 'kb'], ['kb', 'ka']]))
    if (cyc.length >= 1 && cyc.every((c) => c.steps.length <= 24)) ok('成环也不会转不出来（走过的节点不再走）')
    else bad(`成环的链不对：${JSON.stringify(cyc)}`)
    eq(deriveChains(mkLinks([])).length, 0, '没有推导连接 → 一条链都没有')
    void C
    void D
  }
}

// ═════════════════════ 6j. 三条"查出来的 bug"的回归闸 ═════════════════════
console.log('\n[6j] 回归闸：缓存不许串味 · 写得出去就必须读得回来 · 一笔只能进一个组')
{
  /* 这一节全是 2026-09-16 用对抗性探针（随机板 + 不变量 + 新旧版本对照）查出来的，
     每条都曾经真的错。放常驻自检里，免得以后又退化。 */

  /* ── ① 缓存必须按排除集隔离 ──
     同一个索引、同一个点，用**不同的排除集**问两次，各自必须尊重自己的排除集。
     修之前：第二次会读到第一次算出来的节点（缓存把结果固定住了）——
     表现是"条件"里混进这条线自己、同一块拿到两个不同的 id。 */
  {
    const dense = (x1, y, x2, step = 16) => {
      const pts = []
      for (let x = x1; x <= x2; x += step) pts.push({ x, y })
      pts.push({ x: x2, y })
      return toFlat(pts)
    }
    const b = makeBoard()
    b.strokes = [
      { ...newStroke('pen', dense(60, 30, 560)), id: 'line1' }, // 密集采样 → 会贴住下面的块
      { ...newStroke('pen', dense(290, 48, 320, 10)), id: 'cd1' },
      { ...newStroke('pen', dense(290, 56, 322, 10)), id: 'cd2' },
    ]
    const idx = createInkIndex(b.strokes, [])
    const iLine = idx.byId.get('line1')
    const at = { x: 300, y: 52 }
    const a = inkNodeAt(idx, at, 12, 24, new Set([iLine]))
    const c = inkNodeAt(idx, at, 12, 24, null)
    const d = inkNodeAt(idx, at, 12, 24, new Set([iLine]))
    eq(!!(a && a.ids.includes('line1')), false, '带排除集的那次不含 line1')
    eq(!!(c && c.ids.includes('line1')), true, '不排除的那次算进了 line1（说明它真的贴着）')
    eq(!!(d && d.ids.includes('line1')), false, '再排除那次**没有**读到"不排除"那份缓存（不串味）')
  }

  /* ── ② 写得出去就必须读得回来 ──
     一个只有一个点的笔迹：serialize 不该把它写进文件（写进去也会在读的时候丢掉，
     于是文件里攒垃圾、而且"存→读→再存"不再字节一致）。 */
  {
    const b = makeBoard()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 40, y: 0 }])), id: 'ok1' },
      { ...newStroke('pen', toFlat([{ x: 10, y: 10 }])), id: 'junk' }, // 一个点
    ]
    const text = serializeBoardDocument(b)
    if (!text.includes('"junk"')) ok('一个点的笔迹不会被写进文件（写出去也读不回来）')
    else bad('一个点的笔迹被写进文件了 —— 存→读→再存会不一致')
    const back = parseBoardDocument(text, 'x')
    eq(back.strokes.length, 1, '读回来只剩能读的那一笔')
    if (serializeBoardDocument(back) === text) ok('存→读→再存字节一致')
    else bad('存→读→再存不一致（文件里留下了读不回来的东西）')
  }

  /* ── ③ 一笔只能进一个组（界面的"⧉ 固定成一块"调的就是 freezeGroup）── */
  {
    const before = [
      { id: 'g1', ids: ['a', 'b'] },
      { id: 'g2', ids: ['c', 'd'] },
    ]
    const after = freezeGroup(before, ['b', 'c'])
    eq(after.map((g) => g.ids), [['a'], ['d'], ['b', 'c']], '新固定的一块赢：别处只剩没被拿走的')
    const flat = after.flatMap((g) => g.ids)
    eq(new Set(flat).size, flat.length, '没有一笔同时属于两块')
    eq(freezeGroup([{ id: 'g9', ids: ['x', 'y'] }], ['x', 'y']).length, 1, '整块重新固定 → 原来那个组消失（不留空壳）')
    /* 内存里守住了，文件才守得住：这一串操作之后往返仍然字节一致 */
    const b = makeBoard()
    b.strokes = ['x', 'y'].map((id) => ({ ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 20, y: 0 }])), id }))
    b.groups = freezeGroup([{ id: 'g9', ids: ['x', 'y'] }], ['x', 'y'])
    const t = serializeBoardDocument(b)
    if (serializeBoardDocument(parseBoardDocument(t, 'x')) === t) ok('固定之后：存→读→再存仍然字节一致')
    else bad('固定之后往返不一致')
  }
}

// ═════════════════════ 6k. 连接读法：跨 interface 的断言 ═════════════════════
console.log('\n[6k] 连接读法（`createLinkReader`）：调用方只认这一个入口')
{
  /* 这一节是 2026-09-16 把索引/缓存收进 module 之后**才写得出**的断言。
     从前调用方要自己 `createInkIndex(strokes, groups)` 再传给 `buildLinks`，
     于是"缓存该不该失效"变成了调用方的知识 —— 自检只能绕过 `buildLinks` 去问 `inkNodeAt`，
     而"固定块被清缓存而整个失效"那条严重 bug 正是从这儿漏的。
     现在这些都能从**同一道 seam** 上问：复用 reader 的结果 == 新开一个 reader 的结果。 */
  const blob = (cx) => [0, 1, 2].map((i) => [`${cx}_${i}`, toFlat([{ x: cx + i * 9, y: 0 }, { x: cx + i * 9 + 6, y: 7 }])])
  const b = makeBoard()
  b.cards = [{ ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 0, y: 0, id: 'ka' }]
  b.strokes = [
    ...blob(0).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
    ...blob(600).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
    { ...newStroke('pen', toFlat([{ x: 12, y: 3 }, { x: 612, y: 3 }])), id: 'ln' },
  ]
  const reused = createLinkReader()
  const fresh = () => createLinkReader()

  eq(reused.read(b).length, 1, 'reader 读出一条连接')
  eq(JSON.stringify(reused.read(b)), JSON.stringify(reused.read(b)), '同一个板连读两次结果一致（幂等）')

  /* ① 拖一张卡（board 换了、strokes/groups 引用没换）→ 复用 reader 必须和新 reader 一样 */
  const moved = { ...b, cards: b.cards.map((c) => ({ ...c, x: c.x + 37, y: c.y - 21 })) }
  eq(
    JSON.stringify(reused.read(moved)),
    JSON.stringify(fresh().read(moved)),
    '拖卡片之后：复用 reader 的结果 = 新 reader 的结果（缓存不会吐旧结果）'
  )

  /* ② 板上多一笔（strokes 换新引用）→ 同上 */
  const added = {
    ...b,
    strokes: [...b.strokes, { ...newStroke('pen', toFlat([{ x: 300, y: 300 }, { x: 380, y: 320 }])), id: 'extra' }],
  }
  eq(
    JSON.stringify(reused.read(added)),
    JSON.stringify(fresh().read(added)),
    '板上多一笔之后：复用 reader 的结果 = 新 reader 的结果'
  )

  /* ③ 固定块改了（groups 换新引用）→ 固定块必须重新生效（就是那条严重 bug 的形状）。
     用 `moved` 那块板：卡片已经移开，线的起点落在**墨迹块**里，所以固定它之后那一头
     应该变成「固定的块」。（在没移开的板上，起点在卡片里 —— 卡片优先，读出来是 ka，
     那是**对**的，第一版断言在这里写错了。） */
  const fixed = { ...moved, groups: [{ id: 'gX', ids: ['0_0', '0_1', '0_2'] }] }
  const withFixed = reused.read(fixed)
  eq(JSON.stringify(withFixed), JSON.stringify(fresh().read(fixed)), '改了固定块之后：复用 reader = 新 reader')
  eq(withFixed[0] && withFixed[0].a, 'grp:gX', '而且那一头确实是「固定的块」（没有因为复用缓存而失效）')

  /* ④ 两个 reader 互不干扰 */
  const other = createLinkReader()
  eq(other.read(b).length, reused.read(b).length, '另一个 reader 自己算自己的')
}

// ═════════════════════ 6l. 卡片量尺寸 ═════════════════════
/* 这一节钉的是 README 第 15/16/17 条那三个坑 —— 从前它们锁在 Board.jsx 的闭包里，
 * 自检够不着，只能靠真浏览器手工验（对手盘长期留在被 gitignore 的 .cache/refit-test.mjs）。
 * 现在 DOM 读数 / 提交 / 帧调度都是**注入的适配器**，策略本身是纯的，于是：
 *   · 这里（纯逻辑）：三个坑本身 —— stale 那一趟 / 两条轴都稳 / 编辑态不量 / 门槛 / 排队规矩；
 *   · `npm run check:refit`（真浏览器）：接线对不对 —— 真的挂 DOM、真的提交、真的落盘。
 * 两边都绿，"框贴合内容"这件事才算整体没坏。 */
console.log('\n[6l] 卡片量尺寸（`createCardFitter`）：DOM 读数是注入的，策略是纯的')
{
  const mkCard = (over = {}) => ({ id: 'c1', kind: 'formula', x: 100, y: 100, w: 220, h: 90, scale: 1, ...over })
  const mkSnap = (cur, over = {}) => ({
    state: 'ok', card: cur, s: 1, domW: cur.w, bodyH: cur.h, padX: 0, padY: 0,
    naturalW: cur.w, spillPx: 0, texClientW: 0, ...over,
  })
  /* 假的调度器：帧回调收在数组里，由这里决定什么时候跑。
     `quiet()` 把已排上的帧丢掉，`pass()` 直接跑**一趟**（`run` 是 module 的公开入口）——
     这样"跑了几趟、每趟看到什么"是确定的，而 frames 数组只用来断言"排了几帧"。
     （kick 会再压一层 wrapper，所以别拿"shift 一次"当"跑一趟"。） */
  const mkFitter = (deps = {}) => {
    const frames = []
    const patches = []
    const fitter = createCardFitter({
      commit: (id, p) => patches.push({ id, ...p }),
      frame: (fn) => frames.push(fn),
      later: (fn) => frames.push(fn),
      report: () => {},
      ...deps,
    })
    return { fitter, frames, patches, quiet: () => { frames.length = 0 }, pass: () => fitter.run() }
  }

  /* ① 三种"量不得"的状态：卡片没挂上 / 已经从板里没了 / 正在编辑 */
  eq(fitPass(null).state, 'missing', '还没挂上 → missing（下一帧再来）')
  eq(fitPass({ state: 'gone' }).state, 'gone', '卡片已经从板里没了 → gone（出队，别再找）')
  eq(fitPass({ state: 'wait' }).state, 'wait', '正在编辑 → wait（量到的是编辑器，不是内容）')

  /* ② 坑（第 17 条前半）：**量之前 DOM 的宽度必须已经等于数据里的宽度** */
  {
    const card = mkCard()
    const r = fitPass(mkSnap(card, { domW: card.w - 3 }), { fitWidth: true })
    eq(r.state, 'stale', 'DOM 宽度还没跟上数据宽度 → stale（下一帧再来）')
    eq(r.patch, undefined, 'stale 那一趟**不许**提交（提交了就是把上一次渲染的世界钉进文件）')
    near(r.wantW, 220, 0.01, '顺便说清"应该多宽"（诊断用：wantW 220）')
    eq(fitPass(mkSnap(card), { fitWidth: true }).state, 'done', '宽度对得上、内容也一样 → done（不用改）')
  }

  /* ③ 坑（第 17 条后半）：**提交完不能立刻再量** —— 同一帧第二趟读到的是旧 DOM。
     DOM 固定成"永远报 220 宽"（模拟还没重渲染），而数据里已经是 299：
     只要它敢提交第二次，高度就会被按旧的窄宽度钉死（实测 94.4，正确值 66）。 */
  {
    let cur = mkCard({ w: 220, h: 90 })
    const { fitter, patches, quiet, pass } = mkFitter({
      sample: () => mkSnap(cur, { domW: 220, bodyH: 94, naturalW: 299 }),
      commit: (id, p) => {
        patches.push({ id, ...p })
        cur = { ...cur, ...p }
      },
    })
    fitter.queue('c1', { fitWidth: true })
    quiet()
    pass()
    pass()
    pass()
    eq(patches.length, 1, '连量三趟只提交了一次（第一趟之后 DOM 没跟上 → 第二、三趟都 stale）')
    near(patches[0].w, 299, 0.5, '第一趟按内容的自然宽提交 299')
    near(patches[0].h, 94, 0.5, '高度也提交了（94 —— 这一趟的宽度是对的，所以 94 才是对的值）')
    eq(fitter.size, 1, 'stale 那一趟**不把卡从队里摘掉**（下一帧还要再来）')
  }

  /* ④ 坑（第 17 条）：稳定性要**两条轴都稳**才算数。
     宽度一直不变、高度还在收敛 —— 只比宽度的话第二趟就误判成"稳定"收工了。 */
  {
    let bodyH = 94
    const { fitter, quiet, pass } = mkFitter({
      sample: () => mkSnap(mkCard({ w: 299, h: 60 }), { bodyH, naturalW: 299 }),
    })
    fitter.queue('c1', { fitWidth: true })
    quiet()
    pass() // 第 1 趟：h 94
    bodyH = 90
    pass() // 第 2 趟：宽度没变、高度变了
    eq(fitter.size, 1, '宽度不变、高度还在收敛 → 不许判"稳定"（只比宽度会在这里收工）')
    bodyH = 80
    pass() // 第 3 趟：还在收敛
    eq(fitter.size, 1, '还在收敛 → 继续量')
    pass() // 第 4 趟：两条轴都没变
    eq(fitter.size, 0, '两条轴都稳了才收工')
  }

  /* ⑤ 门槛：1.5（自动重量）不写盘，0.6（一次性拟合）写 —— 这条治的是"每天一条假 diff" */
  {
    const s = mkSnap(mkCard({ w: 100, h: 50 }), { bodyH: 50.8, naturalW: 100.8 })
    eq(fitPass(s, { fitWidth: true, tol: FIT_TOL_AUTO }).state, 'done', '自动重量：差 0.8 世界像素 → 不写盘（KaTeX 字体换入前后就差这么点）')
    const once = fitPass(s, { fitWidth: true })
    eq(once.state, 'commit', '一次性拟合：同一个差值 → 写（刚插进来那张要贴紧）')
    eq(once.patch && once.patch.h, 50.8, '要写的就是量到的那个数')
  }

  /* ⑥ 内边距 + 边框必须算进去（border-box：写 width 就是连这一圈一起写） */
  {
    const r = fitPass(mkSnap(mkCard({ w: 260, h: 40 }), { bodyH: 63, padY: 10, naturalW: 76, padX: 18 }), { fitWidth: true })
    near(r.patch.w, 94, 0.05, '内容 76px + 左右内边距边框 18px → 卡宽 94（不加就当场裁内容）')
    near(r.patch.h, 73, 0.05, '内容 63px + 上下内边距边框 10px → 卡高 73')
  }

  /* ⑦ keepCenterX：写字板那条路要以中心缩宽度（不然卡片会往左跳） */
  {
    const c = mkCard({ x: 100, w: 220, h: 90 })
    near(fitPass(mkSnap(c, { naturalW: 100 }), { fitWidth: true, keepCenterX: true }).patch.x, 160, 0.01, 'keepCenterX：x 补一半（100 → 160）')
    eq(fitPass(mkSnap(c, { naturalW: 100 }), { fitWidth: true }).patch.x, undefined, '默认按左上角收：不动 x（圈选那条路钉在笔迹左上角）')
  }

  /* ⑧ 排队规矩：只排有内容的公式卡；**排队自己就开跑**；同一次里多次排队只跑一趟 */
  {
    const { fitter, frames } = mkFitter({ sample: () => mkSnap(mkCard()) })
    fitter.queueFormulaRefits({
      cards: [
        { id: 'f1', kind: 'formula', tex: 'a=b', w: 100, h: 40 },
        { id: 'f2', kind: 'formula', src: '', tex: '', w: 100, h: 40 },
        { id: 'n1', kind: 'note', text: '一段话', w: 200, h: 60 },
      ],
    })
    eq(fitter.size, 1, '只排有内容的公式卡（空白卡和便签都不排）')
    eq(frames.length, 1, '排完队**自己就开跑**（"排了队不叫它"= 什么都没发生，第一版就是那样）')
    fitter.queue('f9', { fitWidth: true })
    eq(frames.length, 1, '同一次里的第二次排队不会又排一帧（同一帧连跑两趟正是坑 ③ 的现场）')
  }

  /* ⑨ 兜底：一直不稳也有个头；卡片没了立刻出队（不然 rAF 空转） */
  {
    let n = 0
    const { fitter, pass } = mkFitter({
      maxTries: 3,
      sample: () => mkSnap(mkCard({ w: 299, h: 50 }), { bodyH: 50 + n++, naturalW: 299 }),
    })
    fitter.queue('c1', { fitWidth: true })
    for (let i = 0; i < 5 && fitter.size; i++) pass()
    eq(fitter.size, 0, '一直量不稳也有头：最多 maxTries 趟就放它走（不会永远下一帧再来）')
    const gone = mkFitter({ sample: () => ({ state: 'gone' }) })
    gone.fitter.queue('c1', {})
    gone.quiet()
    gone.pass()
    eq(gone.fitter.size, 0, '卡片已经从板里没了 → 立刻出队')
    eq(gone.frames.length, 0, '也不会再排下一帧（空转的 rAF 就是这么来的）')
  }
}

// ═════════════════════ 6m. 选中那一族 ═════════════════════
/* 这一节钉的是"框住一笔之后能干什么"——从前散在 Board.jsx 的 5 个 useMemo + 6 个处理器 +
 * BoardCanvas 的 3 段条件渲染里，全是踩过坑的规矩却没有一条在纯逻辑里钉得住：
 * 「不算连接」要写在整条链上（只清框住那一笔 = 点了按钮没反应）、
 * 选的词和形状自动读出来的一样就**不写字段**（没动过的连接是零字节）、
 * ⇄ 反向 = 把点倒过来、框住"正好一整块"才算那一块、固定时要把笔从别的块里拿走。
 * 现在它们在 src/lib/selection.js 里，纯函数 —— 这一节就是它们的断言。 */
console.log('\n[6m] 选中这一族（`selection.js`）：框住的笔意味着什么 + 你对它说的那几句话')
{
  /* 一张板：两张卡 + 一条直线连接（k1 → k2）。返回 {board, links, id} */
  const mkConnected = () => {
    const b = makeBoard()
    b.cards = [
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 0, id: 'k1', text: 'A' },
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 0, id: 'k2', text: 'B' },
    ]
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 60, y: 40 }, { x: 300, y: 41 }, { x: 660, y: 40 }])), id: 'lk' },
    ]
    return b
  }

  /* ① 什么都没框：五个读数都要给"空"，而不是 undefined（浮层靠它决定画不画） */
  {
    const b = mkConnected()
    const r = readSelection(b, null, reader.read(b))
    eq([r.count, r.empty, r.strokes.length, r.box, r.link, r.noLink, r.group], [0, true, 0, null, null, false, null], '没框东西 → 全空（empty=true）')
  }

  /* ② 框住一笔普通墨迹：有 strokes 和 box，但"不是一条线、不是一块、没有否决" */
  {
    const b = makeBoard()
    b.strokes = [{ ...newStroke('pen', toFlat([{ x: 10, y: 10 }, { x: 40, y: 30 }])), id: 's1' }]
    const r = readSelection(b, new Set(['s1']), [])
    eq([r.count, r.strokes.length, r.link, r.noLink, r.group], [1, 1, null, false, null], '普通一笔：有一条 box、其余都是空')
    eq(r.box, { x0: 10, y0: 10, x1: 40, y1: 30 }, 'box 就是这一笔的包围盒（世界坐标、不撑线宽）')
  }

  /* ③ 「框里正好**一条**连接线」才算 selLink —— 两条就不是"这条线"了（该让用户框窄点） */
  {
    const b = mkConnected()
    /* 第二对卡 + 第二条线（离第一对远远的，各自都是一条正经连接）——
       ⚠ 别把第二条线摆在卡的外面：那样它连不上任何东西，`reader.read` 只给回 1 条，
       报出来是"夹具里真的有两连接 实际 1"（夹具错，不是代码错）。 */
    b.cards.push(
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 300, id: 'k3', text: 'C' },
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 300, id: 'k4', text: 'D' }
    )
    b.strokes.push({ ...newStroke('pen', toFlat([{ x: 60, y: 340 }, { x: 300, y: 341 }, { x: 660, y: 340 }])), id: 'lk2' })
    const links = reader.read(b)
    eq(links.length, 2, '夹具里真的有两连接')
    const one = readSelection(b, new Set(['lk']), links)
    eq(one.link && one.link.strokeId, 'lk', '框里正好一条线 → 拿到那条（改词那排的入口）')
    const two = readSelection(b, new Set(['lk', 'lk2']), links)
    eq(two.link, null, '框里两条线 → **不给**"这条线"（不替用户挑一条）')
  }

  /* ④ 有「不算连接」就给回头路；没有就不给 */
  {
    const b = mkConnected()
    b.strokes.push({ ...newStroke('pen', toFlat([{ x: 60, y: 240 }, { x: 660, y: 240 }])), id: 'no' , link: LINK_NONE })
    eq(readSelection(b, new Set(['no']), []).noLink, true, '框住标过"不算连接"的笔 → noLink')
    eq(readSelection(b, new Set(['lk']), []).noLink, false, '普通笔 → 不给回头路')
    eq(readSelection(b, new Set(['no', 'lk']), []).noLink, true, '一框多笔里有一笔是 → 也给（不然点不到）')
  }

  /* ⑤ 「框住的**正好是一整块**」才算那一块：少一笔都不算（不然框一大片会顺手拆了某块） */
  {
    const b = makeBoard()
    b.strokes = ['a', 'b', 'c'].map((id, i) => ({ ...newStroke('pen', toFlat([{ x: i * 10, y: 0 }, { x: i * 10 + 5, y: 5 }])), id }))
    b.groups = [{ id: 'g1', ids: ['a', 'b'] }]
    eq(readSelection(b, new Set(['a', 'b']), []).group && readSelection(b, new Set(['a', 'b']), []).group.id, 'g1', '正好框住一块 → 拿到那一块（浮层给「拆开这块」）')
    eq(readSelection(b, new Set(['a']), []).group, null, '只框住一块里的一笔 → 不算（少一笔都不算）')
    eq(readSelection(b, new Set(['a', 'b', 'c']), []).group, null, '多框了一笔 → 也不算（不顺手拆）')
  }

  /* ⑥ 改词：选的和形状自动读出来的一样 → **不写字段**（一条没动过的连接是零字节） */
  {
    const b = mkConnected()
    const links = reader.read(b)
    eq(links[0].kind, 'rel', '夹具那条直线自动读成"相关"')
    const same = applyStrokeLink(b, links, 'lk', 'rel')
    eq(same.strokes.find((s) => s.id === 'lk').link, undefined, '选的就是自动那一档 → 不写 link（等于回到自动）')
    const other = applyStrokeLink(b, links, 'lk', 'cause')
    eq(other.strokes.find((s) => s.id === 'lk').link, 'cause', '选了别的词 → 写进去')
    eq(b.strokes.find((s) => s.id === 'lk').link, undefined, '★ 原 board 一个字节没动（纯函数）')
    eq(other.strokes.length, b.strokes.length, '别的笔一个不多一个不少')
  }

  /* ⑦ 「不算连接」写在**整条链**上（那条链可能是几笔接起来的） */
  {
    const b = makeBoard()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }])), id: 'q1' },
      { ...newStroke('pen', toFlat([{ x: 100, y: 0 }, { x: 200, y: 0 }])), id: 'q2' },
      { ...newStroke('pen', toFlat([{ x: 400, y: 0 }, { x: 460, y: 0 }])), id: 'other' },
    ]
    eq(chainOfStroke(b, 'q1').sort(), ['q1', 'q2'], '夹具里这两笔是一条链')
    /* 假装连接层认出来的是整条链（`ids` 就是链上那几笔） */
    const links = [{ strokeId: 'q1', ids: ['q1', 'q2'], kind: 'rel', auto: 'rel', dir: false }]
    const next = applyStrokeLink(b, links, 'q1', LINK_NONE)
    eq([next.strokes.find((s) => s.id === 'q1').link, next.strokes.find((s) => s.id === 'q2').link], [LINK_NONE, LINK_NONE], '「不算连接」写在整条链上（不是只写框住那一笔）')
    eq(next.strokes.find((s) => s.id === 'other').link, undefined, '链外的笔不动')
  }

  /* ⑧ 回头路：按整条链清（只清框住那一笔的回归闸） */
  {
    const b = makeBoard()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }])), id: 'q1', link: LINK_NONE },
      { ...newStroke('pen', toFlat([{ x: 100, y: 0 }, { x: 200, y: 0 }])), id: 'q2', link: LINK_NONE },
      { ...newStroke('pen', toFlat([{ x: 400, y: 0 }, { x: 460, y: 0 }])), id: 'keep' },
    ]
    const before = b.strokes[2]
    const next = clearNoLinkMarks(b, new Set(['q1']))
    eq([next.strokes[0].link, next.strokes[1].link], [undefined, undefined], '只框链里一笔，整条链的 none 都清掉（不然 buildLinks 仍然整条跳过）')
    eq(next.strokes[2], before, '没标过的笔原样返回（同一个对象引用，不做无谓的重建）')
    eq(b.strokes[0].link, LINK_NONE, '★ 原 board 没动')
  }

  /* ⑨ ⇄ 反向 = 把点倒过来；而且反向之后**退回单笔判断**（连接层那个 auto 是给没反向的） */
  {
    const b = mkConnected()
    const links = reader.read(b)
    const before = b.strokes[0].points.slice()
    const rev = applyStrokeLink(b, links, 'lk', links[0].kind, { reverse: true })
    const after = rev.strokes[0].points
    eq(after.length, before.length, '点还是那些点（三个一组，不多不少）')
    eq(after.slice(0, 3), before.slice(-3), '第一个点变成了原来的最后一个点（方向反了）')
    eq(after.slice(-3), before.slice(0, 3), '最后一个点变成了原来的第一个点')
    /* 反向时形状变了（回勾跑到另一头）→ 用 autoLinkKind 单笔重判，而不是连接层那个 auto */
    eq(rev.strokes[0].link, undefined, '反向之后"相关"仍然是自动那一档 → 还是不写字段')
    eq(b.strokes[0].points, before, '★ 原 board 的点没被倒过来')
  }

  /* ⑩ 不认识的词 → null（什么都没改，调用方也别弹提示） */
  {
    const b = mkConnected()
    eq(applyStrokeLink(b, reader.read(b), 'lk', 'nonsense'), null, '词不认识 → null（不许猜、不许退回默认再写回去）')
    eq(applyStrokeLink(b, reader.read(b), '不存在的一笔', 'cause').strokes.length, b.strokes.length, '笔不存在也不会炸（照常返回一张板）')
  }

  /* ⑪ 删 / 固定 / 拆开：三步都有"只动该动的"这条底线 */
  {
    const b = makeBoard()
    b.cards = [{ ...newCard('note', 0, 0, { w: 100, h: 60 }), id: 'kc' }]
    b.strokes = ['s1', 's2', 's3'].map((id, i) => ({ ...newStroke('pen', toFlat([{ x: i * 20, y: 0 }, { x: i * 20 + 8, y: 8 }])), id }))
    const del = removeStrokes(b, new Set(['s2']))
    eq(del.strokes.map((s) => s.id), ['s1', 's3'], '删掉框住的那一笔，别的都在')
    eq(del.cards, b.cards, '卡片一个没动（同一个数组引用）')
    eq(removeStrokes(b, new Set()), b, '没框东西 → 原样返回（不造新对象，免得白记一步撤销）')

    /* 先固定 {s1,s2}，再把 {s2,s3} 固定成一块：s2 只能属于一个组，
       所以它要从第一块里被拿走，而且 movedFrom 要说得出"原来在哪"（提示语照实说）。 */
    const first = freezeSelection(b, new Set(['s1', 's2']))
    eq(first.board.groups.length, 1, '第一次固定：多了一块')
    eq(first.movedFrom.length, 0, '第一次固定：没有"从别的块挪过来"这回事')
    const second = freezeSelection(first.board, new Set(['s2', 's3']))
    eq(second.movedFrom.length, 1, '第二次固定和第一块重叠 → movedFrom 报出那一块（提示语要照实说）')
    const gs = second.board.groups
    eq(gs.filter((g) => g.ids.includes('s2')).length, 1, '★ 一笔只能属于一个组（s2 只在一个块里）')
    eq(gs.map((g) => [...g.ids].sort()).sort().join('|'), ['s1', 's2,s3'].sort().join('|'), '第一块里只剩 s1，新块是 s2+s3')
    const dissolved = dissolveGroup(second.board, gs[0].id)
    eq(dissolved.groups.length, 1, '拆开一块 → 只剩另一块')
    eq(dissolveGroup(b, null), b, '没有块可拆 → 原样返回')
  }
}

// ═════════════════════ 6n. 板文件这一步 ═════════════════════
/* 这一节钉的是**应用的入口行为**：data/ 里那些文件怎么读写、以及"打开哪一个"。
 * 从前那串判断住在 App.jsx 的首次加载里（四层分支），只有真浏览器跑得出来 ——
 * "一张板都没有时必须进白板"那条自检（check:default）要的前提本机永远不成立
 * （有用户的板），2026-09-16 验它得把整个仓库复制到临时目录、把 data/ 留空。
 * 现在它是一个**纯决定** `planStartup({ files, want })`，每种情形在这儿都能摆出来。
 * 端到端对手仍然是 `npm run check:default`（它跑真应用 + 真服务）。 */
console.log('\n[6n] 板文件这一步（`files.js`）：data/ 怎么读写 + 打开哪一个')
{
  const F = (name, extra = {}) => ({ name, title: name.replace(/\.md$/i, ''), nodes: 0, mtime: 0, size: 0, ...extra })
  const NOTE = F('大物 · 电磁学.md')
  const BOARD = F('board-新白板.md')

  /* ① 一个文件都没有 → 先放样板（板 + 笔记），调用方重新问一次 */
  {
    const p = planStartup({ files: [] })
    eq(p.step, 'seed', 'data/ 一个文件都没有 → 先放样板（不是白屏、也不是笔记界面）')
    eq(planStartup({ files: [], want: 'board-x.md' }).step, 'seed', '连 ?file= 也拦不住"先放样板"（这时列表还是空的）')
    if (isBoardName(SEED_BOARD_NAME)) ok(`样板板的名字是一张板：${SEED_BOARD_NAME}`)
    else bad(`样板板的名字不像板：${SEED_BOARD_NAME}`)
  }

  /* ② 有板 → 打开列表里第一张板（排序由服务端钉死），不 force（要走"没保存"那道闸） */
  {
    const p = planStartup({ files: [NOTE, BOARD, F('board-电磁学.md')] })
    eq([p.step, p.name, p.force], ['open', 'board-新白板.md', false], '有板 → 打开列表里第一张板')
    eq(p.name, planStartup({ files: [NOTE, BOARD] }).name, '选择只看列表顺序，不挑名字（服务端钉死了排序）')
  }

  /* ③ `?file=` 只认那一个：在列表里就打开（force），不在就**什么都不打开** */
  {
    const files = [NOTE, BOARD]
    const hit = planStartup({ files, want: BOARD.name })
    eq([hit.step, hit.name, hit.force], ['open', 'board-新白板.md', true], '?file= 指到的那张 → 打开它')
    const miss = planStartup({ files, want: 'board-zz-nope.md' })
    eq([miss.step, miss.want], ['none', 'board-zz-nope.md'], '?file= 指了个不存在的 → 什么都不打开（绝不退回列表第一个）')
    eq(planStartup({ files, want: NOTE.name }).name, NOTE.name, '?file= 也可以指名一个笔记（不限于板）')
  }

  /* ④ 一张板都没有（笔记还在）→ 补一张空的，名字先探好（撞名往后排） */
  {
    const p = planStartup({ files: [NOTE, F('zz · 模板（复制这个来写新的一课）.md')] })
    eq([p.step, p.name], ['create-board', 'board-新白板.md'], '只剩笔记 → 补一张空板（不是退回笔记界面）')
    eq(nextBoardName(['board-新白板.md']), 'board-新白板 2.md', '撞名往后排：新白板 2')
    eq(nextBoardName(['board-新白板.md', 'board-新白板 2.md']), 'board-新白板 3.md', '再撞就 3')
    const many = Array.from({ length: 99 }, (_, i) => (i === 0 ? 'board-新白板.md' : `board-新白板 ${i + 1}.md`))
    eq(nextBoardName(many), null, '探到 99 就放弃（返回 null，调用方自己决定怎么办）')
    /* ★ 这一条顺便说明 planStartup 里那个"名字探不出来"的兜底其实**到不了**：
       候选名全都长得像板，所以"99 个都被占"就意味着列表里**有板** —— 走的是"打开第一张板"。
       （兜底留在那儿是为了前缀万一变了不返回坏名字，不是一条正常路径。） */
    const allTaken = many.map((n) => F(n))
    eq(planStartup({ files: [NOTE, ...allTaken] }).step, 'open', '99 个候选名全被占 → 说明列表里有板，走"打开第一张板"')
    eq(planStartup({ files: [NOTE, ...allTaken] }).name, 'board-新白板.md', '开的就是列表里第一张板（不是退回笔记）')
  }

  /* ⑤ 新板的文件名：标题 → `board-<标题>.md`（去 .md、去两头空白） */
  {
    eq(boardFileName('大物 · 电磁学'), 'board-大物 · 电磁学.md', '标题 → board-<标题>.md')
    eq(boardFileName('大物.md'), 'board-大物.md', '标题里带的 .md 不要重复加')
    eq(boardFileName('  复变函数  '), 'board-复变函数.md', '两头空白去掉')
    if (isBoardName(boardFileName('x'))) ok('造出来的名字应用认得出是板（isBoardName）')
    else bad('造出来的名字不是板名：' + boardFileName('x'))
  }

  /* ⑥ data/ 怎么读写：URL 只有这一处，而且文件名**必须编码**
     （中文 / `·` / 空格 / 括号在板文件名里很常见，漏了 encodeURIComponent 就是 404，
     症状是"这张板打不开"，看着像文件坏了）。 */
  {
    const calls = []
    const fake = (url, init) => {
      calls.push({ url, init })
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
    }
    const api = createFileApi({ fetch: fake })
    const NAME = 'board-复变函数 （1）.md'
    await api.list()
    eq(calls[0].url, '/api/list', 'list → /api/list')
    await api.get(NAME)
    eq(calls[1].url, '/api/file/' + encodeURIComponent(NAME), 'get → /api/file/<文件名>，而且**编码过**')
    if (/[\u4e00-\u9fa5]/.test(calls[1].url)) bad('URL 里直接出现了中文 —— 没编码，中文名一取就 404')
    else ok('URL 里没有裸中文（编码过了：' + calls[1].url.slice(0, 28) + '…）')
    await api.put(NAME, 'hello')
    eq([calls[2].init.method, calls[2].init.headers['Content-Type']], ['PUT', 'application/json'], 'put → PUT + JSON')
    eq(JSON.parse(calls[2].init.body), { text: 'hello' }, 'put 的 body 是 { text }')
    await api.create('board-a.md', '# a')
    eq([calls[3].url, calls[3].init.method], ['/api/new', 'POST'], 'create → POST /api/new')
    eq(JSON.parse(calls[3].init.body), { name: 'board-a.md', text: '# a' }, 'create 的 body 是 { name, text }')
    /* 服务端的错误要**原样透传**（调用方靠 r.error 决定弹什么） */
    const errApi = createFileApi({ fetch: () => Promise.resolve({ json: () => Promise.resolve({ error: '非法文件名' }) }) })
    eq((await errApi.create('x', 'y')).error, '非法文件名', '服务端回的错误原样透传（不吞、不改写）')
  }
}

// ═════════════════════ 6o. 「这个条件不算」 ═════════════════════
/* 条件本来是**位置送的**（写在线弧长中点旁边那几个字/那张卡）。位置会读错，
 * 而这个口子就是"你说了不算"：写在那条链上任意一笔的 `cond: 'none'`，
 * 读连接时**否决权优先**。规矩和前两个手动口子一模一样：
 *   ① 只在你说过时才写字段（没说过 → 文件一个字节都不多）；
 *   ② 值只认那一个字面值（手改出来的别的值一律丢掉 = 回到按位置读）；
 *   ③ 必须有一条回头路（清掉字段），而且是一步正常的撤销。
 * 端到端对手是 check:link 的 [13]（真浏览器：面板上那颗 ✕ / ↺）。 */
console.log('\n[6o] 「这个条件不算」（`COND_NONE`）：位置读错了要能一句话作废')
{
  /* 一条连接 + 中点旁边一撮字：夹具要让"条件"真的被读出来（不然否决也没什么可否决的）。 */
  const mk = () => {
    const b = makeBoard()
    b.cards = [
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 0, id: 'k1', text: 'A' },
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 0, id: 'k2', text: 'B' },
    ]
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 60, y: 40 }, { x: 300, y: 40 }, { x: 660, y: 40 }])), id: 'lk' },
      /* 中点 (360,40) 旁边那几个字（3 笔一撮，够大） */
      { ...newStroke('pen', toFlat([{ x: 352, y: 84 }, { x: 392, y: 84 }])), id: 'c1' },
      { ...newStroke('pen', toFlat([{ x: 352, y: 92 }, { x: 400, y: 92 }])), id: 'c2' },
      { ...newStroke('pen', toFlat([{ x: 352, y: 100 }, { x: 388, y: 100 }])), id: 'c3' },
    ]
    return b
  }

  /* 基线：不否决时，条件从位置读出来 */
  {
    const l0 = reader.read(mk())[0]
    if (l0 && l0.cond && l0.cond.kind === 'ink') ok(`条件从位置读出来了（${l0.cond.label}）—— 否决才有东西可否决`)
    else bad(`夹具没读出条件，后面几条没意义：${JSON.stringify(l0 && l0.cond)}`)
    eq(l0 && l0.condManual, false, '没说过话的板：condManual 是 false')
  }

  /* ① 否决之后：cond 作废，但仍留下"你说过"的痕迹（面板要据此给回头路） */
  {
    const b = mk()
    b.strokes = b.strokes.map((s) => (s.id === 'lk' ? { ...s, cond: COND_NONE } : s))
    const l = reader.read(b)[0]
    eq(l.cond, null, '★ 你说过不算 → 位置读出来的那个作废（cond = null）')
    eq(l.condManual, true, '而且记得"这是你说过的话"（condManual）')
    /* 挂在**别的笔**上不算数：那句话是给这条链说的（和手动改词同一个口径）。 */
    const b2 = mk()
    b2.strokes = b2.strokes.map((s) => (s.id === 'c1' ? { ...s, cond: COND_NONE } : s))
    if (reader.read(b2)[0].cond) ok('别的一笔（不在那条链上）标了也不算数 —— 它只对那条链生效')
    else bad('链外一笔的 cond 把别人的条件否决了')
  }

  /* ② 否决只影响那条线：别的连接照旧按位置读 */
  {
    const b = mk()
    b.cards.push(
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 300, id: 'k3', text: 'C' },
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 300, id: 'k4', text: 'D' }
    )
    b.strokes = b.strokes.map((s) => (s.id === 'lk' ? { ...s, cond: COND_NONE } : s))
    b.strokes.push(
      { ...newStroke('pen', toFlat([{ x: 60, y: 340 }, { x: 300, y: 340 }, { x: 660, y: 340 }])), id: 'lk2' },
      { ...newStroke('pen', toFlat([{ x: 352, y: 384 }, { x: 392, y: 384 }])), id: 'd1' },
      { ...newStroke('pen', toFlat([{ x: 352, y: 392 }, { x: 400, y: 392 }])), id: 'd2' },
      { ...newStroke('pen', toFlat([{ x: 352, y: 400 }, { x: 388, y: 400 }])), id: 'd3' }
    )
    const links = reader.read(b)
    const vetoed = links.find((l) => l.strokeId === 'lk')
    const other = links.find((l) => l.strokeId === 'lk2')
    eq(vetoed.cond, null, '被否决的那条：没有条件')
    if (other && other.cond) ok('另一条线照旧按位置读出了条件（否决不是全局开关）')
    else bad(`另一条线的条件被连累了：${JSON.stringify(other && other.cond)}`)
  }

  /* ③ 推导链那一步会回到"缺条件"（不是"不需要条件"）—— 面板据此照实催你补 */
  {
    const b = mk()
    b.strokes = b.strokes.map((s) => (s.id === 'lk' ? { ...s, link: 'derive', cond: COND_NONE } : s))
    const chains = deriveChains(reader.read(b))
    eq(chains.length, 1, '标成"推导"之后读出一条链')
    eq(chains[0].steps[0].missing, true, '★ 否决之后那一步**缺条件**（你说的是"那撮字不是它的条件"）')
    eq(chains[0].steps[0].cond, null, '链上那一步的条件是空的')
  }

  /* ④ 存盘：只在你说过时才写；不认识的值丢掉（回到按位置读） */
  {
    const b = mk()
    b.strokes = b.strokes.map((s) => (s.id === 'lk' ? { ...s, cond: COND_NONE } : s))
    const text = serializeBoardDocument(b)
    if (/"cond":\s*"none"/.test(text)) ok('落盘写了 cond: "none"')
    else bad('落盘没写 cond —— 重开之后那句话就丢了')
    const back = parseBoardDocument(text, 'x')
    eq(back.strokes.find((s) => s.id === 'lk').cond, COND_NONE, '读得回来')
    eq(reader.read(back)[0].cond, null, '重开之后仍然"不算"（否决是存在笔迹上的）')
    /* 回头路：清掉字段 → 又按位置读 */
    const cleared = {
      ...back,
      strokes: back.strokes.map((s) => {
        if (s.id !== 'lk') return s
        const next = { ...s }
        delete next.cond
        return next
      }),
    }
    if (reader.read(cleared)[0].cond) ok('清掉那句话 → 条件又按位置读出来了（回头路是通的）')
    else bad('清掉之后条件没回来 —— 那这条回头路是假的')

    /* 没说过话的板：文件里不该出现这个字段（零字节） */
    if (!/"cond"/.test(serializeBoardDocument(mk()))) ok('没说过话的板一个字节都不多（没有 cond 字段）')
    else bad('没说过话的板也被写上了 cond 字段')

    /* 手改出来的怪值：一律丢掉，回到按位置读（不认它、也不写回去） */
    const dirty = mk()
    dirty.strokes = dirty.strokes.map((s) => (s.id === 'lk' ? { ...s, cond: 'xxx' } : s))
    const dirtyBack = parseBoardDocument(serializeBoardDocument(dirty), 'x')
    eq(dirtyBack.strokes.find((s) => s.id === 'lk').cond, undefined, '不认识的值丢掉（手改文件不会把它变成一个说法）')
    if (reader.read(dirtyBack)[0].cond) ok('丢掉之后它回到"按位置读"（屏幕上的表现是对的）')
    else bad('丢掉怪值之后条件没回来')
  }
}

// ═════════════════════ 7. 装进视口 ═════════════════════
console.log('\n[7] 打开时把所有内容装进屏幕')
{
  const b = makeBoard()
  b.cards = [
    { ...newCard('note', 0, 0, { w: 200, h: 100 }), x: -800, y: -500, id: 'a' },
    { ...newCard('note', 0, 0, { w: 200, h: 100 }), x: 800, y: 500, id: 'b' },
  ]
  // 大屏幕：应该真的把内容都装进去
  const v = fitView(b, 1600, 1000, 60)
  const corners = [
    { x: -800, y: -500 }, { x: -600, y: -400 },
    { x: 800, y: 500 }, { x: 1000, y: 600 },
  ]
  let inside = true
  for (const p of corners) {
    const sc = worldToScreen(p, v)
    if (sc.x < -0.5 || sc.x > 1600.5 || sc.y < -0.5 || sc.y > 1000.5) inside = false
  }
  if (inside) ok('大屏幕上所有角点都落在屏幕里（打开不是一片空白）')
  else bad('有内容落在屏幕外（打开会看着像丢了东西）')

  /* ★ 小窗口下必须有缩放下限。
     实测：758×426 的窗口里"全部装进去"会算出 0.37 倍，
     卡片上的公式小到看不清 —— 那还不如让你平移着看。
     这条断言就是钉住"宁可装不下，也不能缩成蚂蚁"。 */
  const small = fitView(b, 500, 420, 60)
  if (small.s >= READABLE_FIT_S - 1e-9) ok(`小窗口下缩放不低于 ${READABLE_FIT_S}（实际 ${round(small.s)}），不会缩成蚂蚁`)
  else bad(`小窗口下缩到了 ${round(small.s)}，公式会看不清`)

  const empty = fitView(makeBoard(), 1200, 800)
  eq([empty.s, Math.round(empty.tx), Math.round(empty.ty)], [1, 600, 400], '空板的兜底视图 = 屏幕中心')
}

// ═════════════════════ 8. 公式转化 ═════════════════════
console.log('\n[8] 公式：随手写 → 好看')
{
  const cases = [
    ['F = ma', 'F = ma'],
    ['mu0', '\\mu_{0}'],
    ['epsilon0', '\\epsilon_{0}'],
    ['B = mu0 I / (2 pi r)', 'B = \\frac{\\mu_{0} I}{2 \\pi r}'],
    ['dS/dt', '\\frac{dS}{dt}'],
    ['sqrt(x^2 + y^2)', '\\sqrt{x^{2} + y^{2}}'],
    ['2 pi r', '2 \\pi r'],
    ['a * b', 'a \\cdot b'],
    ['int( f(x) ) d x', '\\int( f(x) ) d x'],
    ['theta^2', '\\theta^{2}'],
    ['x^-1', 'x^{-1}'],
    ['v = dx/dt', 'v = \\frac{dx}{dt}'],
    ['omega t', '\\omega t'],
    ['lambda', '\\lambda'],
    ['sin(theta)', '\\sin(\\theta)'],
    /* ★ 下面这几条是**实测出来的"会静默吃内容"的形状**，一条一条钉住。
       根源都是同一个：反读分式的操作数时把"一个原子"的边界认错了 ——
       分子少一项、或者从下标中间切开。屏幕上看着还是个公式，
       只有你自己知道原来写的那个 I 不见了。这类错最难发现，所以必须有断言。 */
    ['mu0 I / 2', '\\frac{\\mu_{0} I}{2}'], // 分子是「连写的乘积」
    ['C = epsilon0 A / d', 'C = \\frac{\\epsilon_{0} A}{d}'],
    ['mu_0 I / (2 pi r)', '\\frac{\\mu_{0} I}{2 \\pi r}'], // 带下标的量当分子
    ['x^2/y', '\\frac{x^{2}}{y}'], // 带上标的量当分子
    ['a - b / 2', 'a - \\frac{b}{2}'], // 减号不能被当成"连写"的一部分
    ['1/2 pi r', '\\frac{1}{2 \\pi r}'], // 分母是「2 pi r」而不是「2」
    /* ★ 单位不能排成分式。`N/A^2` 读作"牛顿每平方安培"，是一个单位，
       不是"N 除以 A 的平方"。量纲式子和分式长得一模一样但读法不同，
       排错了比不排更糟 —— 屏幕上看着挺像回事，其实你写的东西被改了意思。 */
    ['N/A^2', 'N/A^{2}'],
    ['km/h', 'km/h'],
    ['mu0 = 4 pi * 10^-7 N/A^2', '\\mu_{0} = 4 \\pi \\cdot 10^{-7} N/A^{2}'],
    ['10^-7', '10^{-7}'], // 负指数：以前会被吃成 "10^-"
    /* 代价，说明白：`m/V` 这种"小写量 / 大写量"会被当成单位（m 每 V）而不排分式。
       这是**故意的取舍** —— 排错意思比排得不那么好看严重得多，
       而且斜杠本来就是对的写法。想排成分式就写成 m/(V)。 */
    ['rho = m/V', '\\rho = m/V'],
    ['rho = m/(V)', '\\rho = \\frac{m}{V}'],
    // 短路保护：括号块本身带斜杠，一动就会把括号切碎
    ['1/(2/x)', '1/(2/x)'],
    ['a/(b/c)', 'a/(b/c)'],
  ]
  for (const [src, want] of cases) {
    const got = toTex(src)
    if (got === want) ok(`${JSON.stringify(src)} → ${JSON.stringify(got)}`)
    else bad(`${JSON.stringify(src)}\n      实际 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`)
  }

  // ★ 幂等：这是整个函数的生命线。不幂等就只能"存的时候调一次"，
  //   于是任何一次重排都可能悄悄改坏内容。
  const idem = [
    'F = ma', 'mu0', 'B = mu0 I / (2 pi r)', 'dS/dt', 'sqrt(x^2 + y^2)', 'x^-1',
    '\\frac{a}{b}', '\\mu_0', '\\sqrt{x}', 'I_{\\text{内}}', 'a^{2} + b_{1}',
    '\\int_0^1 f(x) dx', 'sum', 'vec(B)', '1/2', 'c^2',
    // 单位、负指数、括号里带斜杠：都是"排错了也看不出来"的高危形状
    'N/A^2', 'km/h', '10^-7', '1/(2/x)', 'q = 9.8 m/s^2',
  ]
  let idemBad = 0
  for (const src of idem) {
    const once = toTex(src)
    const twice = toTex(once)
    if (once !== twice) {
      idemBad++
      bad(`不幂等：${JSON.stringify(src)}\n      一次 ${JSON.stringify(once)}\n      两次 ${JSON.stringify(twice)}`)
    }
  }
  if (!idemBad) ok(`幂等：${idem.length} 个用例转化两次 = 一次`)

  // ★ 不吞内容：认不出来的字符必须原样活着。宁可丑，不可丢。
  //   判据取"多重集包含"：把 LaTeX 的噪声（反斜杠、大括号、^_、以及 \frac 这类
  //   命令名本身）剥掉之后，**你写的每一个字符都要在结果里出现，且次数不少于你写的**。
  //   为什么不用"逐位相同"：??/?? 会合法地变成 \frac{??}{??}（多了 4 个命令字母、
  //   顺序也变了），逐位比会误报。这里要防的是"内容消失"，不是"内容长了"。
  const keep = [
    '中文也要留着',
    'x ≈ y',
    'a ≠ b',
    'f(x) = { x, x>0',
    '??/??',
    '∑ 手打进去的符号',
    '\\unknowncmd{x}',
    'a & b # c',
    'P(A|B) = 0.5',
  ]
  const stripTex = (s) =>
    s
      .replace(/\\[a-zA-Z]+/g, '') // 命令名本身不算你的内容
      .replace(/[\\{}^_$]/g, '') // 排版符号
      .replace(/[/\s]/g, '') // 斜杠和空格是运算符：分式把它换成 \frac，位置变了但没丢
  let lost = 0
  for (const src of keep) {
    const got = toTex(src)
    const pool = stripTex(got).split('')
    let miss = ''
    for (const ch of stripTex(src)) {
      const k = pool.indexOf(ch)
      if (k < 0) miss += ch
      else pool.splice(k, 1)
    }
    if (miss) {
      lost++
      bad(`吞内容：${JSON.stringify(src)} → ${JSON.stringify(got)}   丢了 ${JSON.stringify(miss)}`)
    }
  }
  if (!lost) ok(`不吞内容：${keep.length} 个怪输入里每个字符都还在`)

  // 空输入和纯空白
  eq(toTex(''), '', '空串 → 空')
  eq(toTex('   '), '', '纯空白 → 空')
  eq(toTex(null), '', 'null → 空')

  // 卡片显示：有 tex 用 tex，没有就现算
  eq(displayTex({ src: 'mu0', tex: '' }), '\\mu_{0}', '没有 tex 就拿 src 现算')
  eq(displayTex({ src: 'mu0', tex: '\\mu_{0}' }), '\\mu_{0}', '有 tex 就用 tex')
  eq(displayTex(null), '', '没有卡片 → 空')

  // 符号面板插进去的东西，必须是"用户自己也能手打出来的写法"
  const snip = ['frac', 'sqrt', 'sup', 'sub', 'vec', 'int', 'sum', 'pi', 'mu0', 'cdot']
  let snipBad = 0
  for (const k of snip) {
    const s = snippetFor(k)
    if (!s || /\\/.test(s)) {
      snipBad++
      bad(`面板插入的东西带 LaTeX 反斜杠（你自己看不懂也改不了）：${k} → ${JSON.stringify(s)}`)
    }
  }
  if (!snipBad) ok(`符号面板：${snip.length} 个插入片段都是可手打的写法`)
  eq(snippetFor('sqrt', 'x^2'), 'sqrt(x^2)', '选中内容再点 √ → 包起来')
}

// ═════════════════════ 9. 样板板 ═════════════════════
/* 样板是"关系靠位置"这件事唯一的现场演示。它要是坏了、或者关系跟说的不一样，
   新用户看到的第一个画面就是错的 —— 所以它也在自检范围内。 */
console.log('\n[9] 样板板：三张卡的关系必须和注释里说的一致')
{
  const { buildSeedBoard } = await import('../src/seed-board.js')
  const b = buildSeedBoard()
  const text = serializeBoardDocument(b)
  const back = parseBoardDocument(text, 'x')
  eq(back.cards.length, 5, '样板有 5 张卡')
  eq(back.strokes.length, 4, '样板有 4 笔手写（3 笔笔迹 + 1 笔荧光笔）')
  if (serializeBoardDocument(back) === text) ok('样板存→读→再存一致')
  else bad('样板往返不一致（一打开就会写一次假 diff）')

  const rel = buildRelations(back)
  const kinds = rel.edges.map((e) => e.kind).sort()
  eq(kinds, ['contain', 'contain', 'near'], '关系：2 个包含 + 1 个挨着（演示三种规则）')
  eq(rel.orphans.length, 1, '有 1 张孤岛卡（演示"孤岛不是错误"）')

  // 样板里每张公式卡的显示必须能渲染：tex 有就用 tex，没有也从 src 算得出来
  for (const c of back.cards) {
    if (c.kind !== 'formula') continue
    const t = displayTex(c)
    if (t && t.trim()) ok(`样板公式「${c.src.slice(0, 24)}」有可渲染的式子`)
    else bad(`样板公式「${c.src}」渲染不出来`)
  }
}

// ═════════════════════ 结果 ═════════════════════
console.log('\n' + '─'.repeat(56))
if (fails) {
  console.log(`  ${checks} 项通过，${fails} 项失败`)
  process.exit(1)
} else {
  console.log(`  全部 ${checks} 项通过`)
}
