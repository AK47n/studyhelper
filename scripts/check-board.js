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
  fontCss, isBoardDocument, isBoardName, newBoard, newCard, linkId, newFrameId,
  newStroke, nextCardScale, normalizeFrames, normalizeLinks, parseBoardDocument, serializeBoardDocument, textCardRect,
  liveNodeIdFn, liveNodesOf,
} from '../src/lib/board.js'
/* 点 / 几何 / 关系搬去了 geometry.js（2026-09-16 架构 review 的 C5）；
   板框的几何（成员包围盒 + 内边距、框选命中）2026-09-17 也进了那儿。 */
import { NEAR_GAP, READABLE_FIT_S, buildRelations, cardBounds, cardVisualRect, descendantsOf, fitView, frameBounds, membersInBox, pointSegDist, relationCurve, simplifyPoints, strokeBounds, strokeHitsCircle, strokesBBox, toFlat, toPoints } from '../src/lib/geometry.js'
/* 板框 / 连接这两个概念**动作**（留下 / 加进来 / 改标题 / 拆开 / 连上 / 删掉）在 frames.js。 */
import {
  addToFrame, declareLink, dissolveFrame, frameById, frameMembers, frameOf, freezeFrame, linkOf,
  pruneFrames, removeLink, setFrameTitle, setLinkKind, takeOutOfFrame, translateFrame,
} from '../src/lib/frames.js'
/* 连接读法（reader / 你画出来的那条 / 你宣告的那条 / 墨迹块与条件）在 links.js。
   ⚠ 2026-09-17 第二刀把形状判据那一族（findTip / classifyLinkShape / gatherHeads / 接笔 /
     墨迹块当端点 + 三道闸）整个删掉了 —— 它在真笔迹上 92:0（ADR-0001），
     所以这里也不再 import 它们（[6d]/[6e]/[6f] 那几节跟着没了）。 */
import {
  INK_BLOCK_GAP, LINK_COND_RADIUS, createInkIndex, createLinkReader, deriveChains, inkBlocks, inkNodeAt, linkKey,
} from '../src/lib/links.js'
/* 关系的词表在 link-kinds.js（board.js 不再转发）。 */
import { COND_NONE, LINK_DELETE, condCard, condInk, parseCond } from '../src/lib/link-kinds.js'
/* 卡片「按内容量尺寸」那一套规矩搬去了 card-fit.js（2026-09-16）：DOM 读数是注入的，
   所以"提交完不能立刻再量"这类坑在这儿断言得到（见 [6l]）。 */
import { FIT_IDLE_MS, FIT_TOL_AUTO, createCardFitter, fitPass } from '../src/lib/card-fit.js'
/* 选中这一族（框住的笔意味着什么 + 改词/反向/否决/回头路/固定/拆开）搬去了 selection.js
   （2026-09-16）：纯函数、有断言（见 [6m]）。 */
import {
  applyStrokeLink, clearCond, freezeFrameSelection, pickBox, readSelection, removePick, specCond, transformPick, vetoCond,
} from '../src/lib/selection.js'
/* 板文件这一步（data/ 的读写 + 打开哪一个）搬去了 files.js（2026-09-16 C4）：
   "打开哪一个"是一个纯决定，于是那些入口情形在这儿断言得到（见 [6n]）。 */
import { SEED_BOARD_NAME, boardFileName, boardPath, createFileApi, nextBoardName, planStartup, splitTitlePath } from '../src/lib/files.js'
/* data/ 里的路径（2026-09-17 起有分层）全在 paths.js 一处：服务端收请求、写盘、
   前端摆树用的都是它 —— 所以那些"名字合法不合法、拆得对不对"的断言在这儿（[6q]）。 */
import {
  ancestors, baseName, buildFolderTree, isSafeSegment, isUnder, joinPath, layerNeeds, layerPath, levels,
  normalizeRel, parentPath, pathTitle, pruneTree, sanitizeRel, splitPath, uniqueRelName, isRenamed, MAX_DEPTH, MAX_SEGMENT,
} from '../src/lib/paths.js'
/* 视图映射搬去了 src/lib/view.js（2026-09-16）：自检从这里 import，和 app 走同一个 module。 */
import { applyViewTo, centerOn, clampViewScale, combinedScale, panBy, scaledRectToScreen, screenLenToWorld, screenToWorld, viewTransformAttr, worldLenToScreen, worldRectToScreen, worldToScreen, zoomAt, zoomBetween } from '../src/lib/view.js'
/* 撤销账本（一次手势 = 一步撤销）搬去了 history.js（2026-09-17 架构 review 候选 3）：
   四条手势从前各自记一次账、判据四个 —— 这里用假 adapter 断言整族（见 [6s]）。 */
import { MOVE_EPS, createHistory, sameWithin } from '../src/lib/history.js'
import { readFileSync } from 'node:fs'
import { ARROW_SNAP, CARD_HIT_PAD, COND_SEARCH, edgeDist, edgePointOf, nodeAt, nodeById, nodeList } from '../src/lib/nodes.js'
import { displayTex, snippetFor, toTex } from '../src/lib/formula.js'
/* "那颗词摆哪"（浮层锚点夹进可用区域）是一条屏幕像素的政策，单开一个文件
   （2026-09-17 收的候选 1 尾巴 `chipPlacement`）—— 见 [3]⑨。 */
import { CHIP_MARGIN_BOTTOM, CHIP_MARGIN_TOP, CHIP_MARGIN_X, chipPlacement } from '../src/lib/chip-placement.js'
/* 焦点仲裁（"现在焦点在谁身上"是一个值、按键该谁管是纯函数）在 focus.js ——
   那一节拿假 target 就能钉住整张表（见 [6t]）。 */
import {
  FOCUS_NONE, PAPER_SELECTOR, beginEdit, clearInkFocus, deleteIntent, editingCardId, editingFrameId, endEdit,
  escapeIntent, focusCard, focusCardId, focusFrame, focusFrameId, focusInk, focusInkCards, focusInkIds, isTextField, onPaper,
} from '../src/lib/focus.js'
/* 复制 / 粘贴（框住一块 → 装进剪贴板 → 落到任何一块板上）在 clipboard.js ——
   三条规矩（只装内容不装关系 / 落点用相对偏移 / 贴出来是新 id）见 [6w]。 */
import { CLIPBOARD_VERSION, copySelection, isPayload, pastePayload, payloadCount } from '../src/lib/clipboard.js'
/* 常用形状规整（画个圆 → 变成真正的圆）在 shapes.js ——
   "该认的必须认得 + 该拒的必须拒"两批一起钉，见 [6x]。 */
import { fitShape, recognizeShape, recognizeShapeObject, recognizeStrokes, regularizeStrokes, shapeLabel } from '../src/lib/shapes.js'
import {
  bakeShapePoints,
  normAngle,
  normalizeShape,
  oppositeCorner,
  rotateShape,
  retargetStroke,
  scaleShape,
  serializeShape,
  shapeAABB,
  shapeCenter,
  shapeHandlePoints,
  shapeName,
  translateShape,
} from '../src/lib/shape-object.js'

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

    /* ⑧ 长度与"每样东西自己的倍率"（2026-09-17 架构 review 的候选 1）：
          "卡片的屏幕尺寸 = 世界 × s × k"以前**手抄在三处**（卡片渲染 / 缩放柄兜底 / 量尺寸的 wantW），
          现在只有一处乘。这里钉住那个倍率本身、两个方向、以及"搬家不许改数"。 */
    {
      eq(combinedScale(2, 3), 6, '倍率：s × k（两个都算）')
      eq(combinedScale(2, 0), 2, '倍率：k=0 当成 1（脏数据不该把卡片乘没）')
      eq(combinedScale(2, NaN), 2, '倍率：k=NaN 当成 1')
      eq(combinedScale(NaN, NaN), 1, '倍率：都脏 → 1（一次脏输入不该把卡片乘没）')
      near(worldLenToScreen(4, 2.5), 10, 1e-9, '世界长度 → 屏幕长度：× 倍率')
      near(screenLenToWorld(10, 2.5), 4, 1e-9, '屏幕长度 → 世界长度：÷ 倍率（反方向也在一处）')
      near(screenLenToWorld(worldLenToScreen(37.5, 1.486), 1.486), 37.5, 1e-9, '长度往返：世界 → 屏幕 → 世界 回原值')
      /* 卡片的屏幕盒：宽高只跟倍率（和 worldRectToScreen 一样，位置那一条才带平移） */
      const vv = { s: 0.5, tx: 100, ty: 40 }
      const box2 = scaledRectToScreen({ x: 10, y: 20, w: 40, h: 30 }, combinedScale(vv.s, 2))
      near(box2.left, 10 * 1, 1e-9, '卡片盒：左 = 世界 x × (s×k)（平移由调用方按点加，别混进长度）')
      near(box2.width, 40 * 1, 1e-9, '卡片盒：宽 = 世界宽 × (s×k)')
      /* ★ 这条就是那个 bug 的形状：**量尺寸那一趟**和**渲染**算出来的屏幕宽度必须是同一个数
         （从前两边各写一遍乘法，ADR-0002 那根黑线就是从"两边各算"里长出来的）。 */
      const cardNow = { w: 141.7, h: 52.1, scale: 1.486 }
      const viewNow = { s: 1.451, tx: -1022, ty: 795.5 }
      near(
        worldLenToScreen(cardNow.w, combinedScale(viewNow.s, cardNow.scale)),
        cardNow.w * viewNow.s * cardNow.scale,
        1e-9,
        '卡片屏幕宽：一处乘出来的和"手写三个因子"完全一致（口径搬家不许改数）'
      )
    }

    /* ⑨ "那颗词摆哪"这条**屏幕政策**（2026-09-17 收的候选 1 尾巴 `chipPlacement`）：
          别跑出画布、别压到底部工具条底下（工具条 z-index 20，见 README 第 13 条）。
          ★ 搬家不许改数：下面拿从前写在 `Board.jsx` 里的那两行内联公式当"旧实现"，
          18 种情形逐一比 —— 收进 module 不是"顺手改改行为"。 */
    {
      const oldWay = (x, y, w, h) => ({
        x: Math.min(Math.max(x, 130), Math.max(130, w - 130)),
        y: Math.min(Math.max(y, 96), Math.max(96, h - 60)),
      })
      const area = { w: 1440, h: 700 }
      eq(chipPlacement({ x: 700, y: 300 }, area), { x: 700, y: 300 }, '摆在中间就是原样（不该乱动）')
      eq(chipPlacement({ x: 10, y: 10 }, area), { x: CHIP_MARGIN_X, y: CHIP_MARGIN_TOP }, '左上角出去 → 夹到下界（词不会跑出画布）')
      eq(chipPlacement({ x: 1430, y: 690 }, area), { x: 1440 - CHIP_MARGIN_X, y: 700 - CHIP_MARGIN_BOTTOM }, '右下角出去 → 夹到上界（不压底部工具条）')
      let same = true
      for (const [x, y] of [[-50, -50], [0, 0], [700, 350], [2000, 2000], [130, 96], [131, 97]]) {
        for (const a of [{ w: 1440, h: 700 }, { w: 200, h: 120 }, { w: 90, h: 40 }]) {
          const got = chipPlacement({ x, y }, a)
          const want = oldWay(x, y, a.w, a.h)
          if (got.x !== want.x || got.y !== want.y) same = false
        }
      }
      if (same) ok('★ 搬家不许改数：18 种情形和从前那两行内联公式**逐字一致**')
      else bad('chipPlacement 和从前那两行算出来的不一样（搬一次就改行为 = 白搬）')
      eq(
        chipPlacement({ x: 0, y: 0 }, { w: 90, h: 40 }, { marginX: 10, marginTop: 5, marginBottom: 5 }),
        { x: 10, y: 5 },
        '三个边距可以覆盖（界面大小变了只改这一处）'
      )
      eq(chipPlacement({ x: 0, y: 0 }, { w: 200, h: 120 }), { x: CHIP_MARGIN_X, y: CHIP_MARGIN_TOP }, '容器装不下两边边距 → 退回下界（不是负数，从前就是这样）')
    }
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

  /* ── ★ 卡片的 `rot`（2026-09-21：卡片能旋转了）─────────────────────────────
     和 `scale` / `font` / `locked` 那三个字段**同一条纪律**，逐条钉住：
       · 没转过 = 0 = **一个字节都不写**（老文件不许因为我们加了个功能就变脏）；
       · 转过就写，而且"存→读→再存"逐字节一致（不然每次开板一条假 diff）；
       · 认不出的值一律当 0（手改一个 `"abc"` 不该让卡片整个歪掉）。 */
  {
    const rot0 = parseBoardDocument(JSON.stringify({ cards: [{ kind: 'note', x: 0, y: 0, w: 200, h: 80, text: 'a' }] }))
    eq(rot0.cards[0].rot, 0, '没写 rot 的卡 → 0（默认不转）')
    eq(/"rot"/.test(serializeBoardDocument(rot0)), false, '★ 没转过的卡：文件里**没有** `rot` 这个字段（一个字节都不多）')
    const r90 = { ...rot0, cards: [{ ...rot0.cards[0], rot: Math.PI / 2 }] }
    const txt = serializeBoardDocument(r90)
    eq(/"rot"/.test(txt), true, '转过之后写进文件')
    const back2 = parseBoardDocument(txt)
    near(back2.cards[0].rot, Math.PI / 2, 1e-9, '  …读回来还是那个角')
    eq(serializeBoardDocument(back2) === txt, true, '  ★ 存→读→再存逐字节一致（不然每次开板一条假 diff）')
    /* 转一圈回来：`1e-17` 和 `-0` 都必须被 normAngle 清成 0（JSON 里 `-0` 是另一个字符串）。 */
    const spin = parseBoardDocument(JSON.stringify({ cards: [{ kind: 'note', w: 200, h: 80, rot: Math.PI * 2 + 1e-17 }] }))
    eq(spin.cards[0].rot === 0 && !Object.is(spin.cards[0].rot, -0), true, '★ 转一整圈（+浮点噪声）→ 精确回到 0，不是 1e-17、也不是 -0')
    const junk = parseBoardDocument(JSON.stringify({ cards: [{ kind: 'note', w: 200, h: 80, rot: 'abc' }] }))
    eq(junk.cards[0].rot, 0, '★ 手改文件写个 "abc" → 当 0（一个怪值不该让整张卡歪掉）')
  }
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

// ═════════════════════ 6d. 你画出来的连接（形状不再读） ═════════════════════
console.log('\n[6d] 你画出来的连接：一笔线、两头各落在一张卡里 —— 形状**不再读**')
{
  /* 2026-09-17 第二刀（ADR-0001）：**形状判据整族删掉了**。
     为什么：拿他三张真板量，判成"箭头"的 92 条笔迹里没有一条像箭头（直度中位 0.28、
     张开角中位 ~20° —— 那是汉字折笔的拐角），三张板读出来的连接都是 0 条。
     现在这条路上只剩一件事：**一笔线，两头各落在一张卡里**（免费路，ADR-0001 的候选 E）。
     这一节钉的就是"它还在、而且只剩它"：
       · 一条线连两张卡 → 1 条连接，「相关」（最弱那一档），不写文件；
       · 手动画成箭头形状的线 → **还是「相关」**（形状不读了，这是这一刀的回归哨兵）；
       · 两头不在两张卡里（空白处、同一张卡、一头是板框）→ 一条都没有；
       · 手动点过词 → 写进文件、读得回来。 */
  const straight = toFlat([{ x: 0, y: 0 }, { x: 60, y: 1 }, { x: 130, y: -1 }, { x: 200, y: 0 }])
  /* 一笔"箭头"（划到尖、回勾、甩到另一侧）—— 从前这会被读成「因果」。
     现在它只是一条线：形状不读了。留它在这里当哨兵。 */
  const arrowShape = toFlat([
    { x: 0, y: 0 }, { x: 70, y: 0 }, { x: 140, y: 0 }, { x: 200, y: 0 }, { x: 182, y: 9 }, { x: 204, y: -3 },
  ])

  const b = makeBoard()
  /* 两张卡离得开一点：**线要真的从一张卡进到另一张卡**（老坑：两端都落在第一张卡里，
     buildLinks 正确地返回 0 条，报出来却像"两笔连线 → 应该 2 条"）。 */
  b.cards = [
    { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 0, id: 'k1', text: 'A' },
    { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 0, id: 'k2', text: 'B' },
  ]
  b.strokes.push({ ...newStroke('pen', straight), id: 'link1', points: toFlat([{ x: 60, y: 40 }, { x: 300, y: 41 }, { x: 660, y: 40 }]) })
  b.strokes.push({
    ...newStroke('pen', arrowShape),
    id: 'link2',
    points: toFlat([{ x: 60, y: 40 }, { x: 300, y: 40 }, { x: 600, y: 40 }, { x: 580, y: 52 }, { x: 662, y: 38 }]),
  })

  const links = reader.read(b)
  eq(links.length, 2, '两笔连线 → 两条连接')
  eq([links[0].a, links[0].b], ['k1', 'k2'], '第一条连的是 k1 → k2')
  eq([links[0].kind, links[0].dir, links[0].manual, links[0].shape], ['rel', false, false, 'line'], '直线：相关、无向、不是你点的、形状=线')
  eq(links[1].kind, 'rel', '★ 手画成箭头形状的那一笔**也读成「相关」** —— 形状判据已经删掉了')
  eq([links[1].a, links[1].b], ['k1', 'k2'], '方向还是按你画的方向（第一点 → 最后一点）')
  eq(links[1].headInk, false, '没有"你自己画的尖"这回事了，有方向的词一律由应用补一个尖')

  /* ★ 只有**手动点过词**的才写进文件。上一步那两条都没点过 —— 文件里不许有 link。 */
  const s0 = serializeBoardDocument(b)
  if (!/"link"/.test(s0)) ok('没点过词的连接**不写进文件**（老文件零字节变化）')
  else bad('没点过词的连接被写进文件了')

  /* 手动点一个词：这次必须写，而且读得回来。 */
  b.strokes = b.strokes.map((x) => (x.id === 'link1' ? { ...x, link: 'derive' } : x))
  const back1 = parseBoardDocument(serializeBoardDocument(b), 'x')
  eq(back1.strokes.find((x) => x.id === 'link1').link, 'derive', '手动点的词读得回来')
  eq(reader.read(back1).find((l) => l.strokeId === 'link1').kind, 'derive', '手动点的词就是这条连接的词')
  eq(reader.read(back1).find((l) => l.strokeId === 'link1').manual, true, '它被认成"你点过的"')

  /* 手改文件写了个认不出的词（中文名、数字）：一律丢掉，回到默认那一档。 */
  const dirty = parseBoardDocument(
    JSON.stringify({ strokes: [{ id: 's1', tool: 'pen', points: straight, link: '因果' }], cards: [] }),
    'x'
  )
  eq(dirty.strokes[0].link, undefined, '文件里认不出的 link 值丢掉（不退回默认再写回去）')
  eq(parseBoardDocument(JSON.stringify({ strokes: [{ id: 's1', tool: 'pen', points: straight, link: 1 }], cards: [] }), 'x').strokes[0].link, undefined, '数字 1 也不算（只认那几个 id）')

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

  /* 两端落在**同一张卡**里不算连接（那是圈了一下自己）。 */
  const b6 = makeBoard()
  b6.cards = [{ ...newCard('note', 0, 0, { w: 400, h: 300 }), x: 0, y: 0, id: 'big', text: '大卡' }]
  b6.strokes = [{ ...newStroke('pen', straight), id: 'in1', points: toFlat([{ x: 20, y: 20 }, { x: 200, y: 20 }]) }]
  eq(reader.read(b6).length, 0, '两端在同一张卡里不算连接')

  /* ★ 两头不在**两张卡**里 = 不是连接（第二刀砍掉的那条路要真的没了）：
       空白处的两坨字迹之间画一条线 / 一头在板框上 —— 从前"墨迹块当端点"能把它们读成连接。 */
  {
    const empty = makeBoard()
    empty.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 200, y: 6 }])), id: 'e1' },
      { ...newStroke('pen', toFlat([{ x: 4, y: 2 }, { x: 10, y: 8 }])), id: 'e2' },
      { ...newStroke('pen', toFlat([{ x: 190, y: 2 }, { x: 196, y: 8 }])), id: 'e3' },
    ]
    eq(reader.read(empty).length, 0, '空白处两坨字迹之间画一条线 → **不再**是连接（墨迹块不当端点了）')
    const withFrame = makeBoard()
    withFrame.cards = [{ ...newCard('note', 0, 0, { w: 60, h: 40 }), x: 600, y: 0, id: 'k2' }]
    withFrame.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 30, y: 6 }])), id: 'f0' },
      { ...newStroke('pen', toFlat([{ x: 60, y: 40 }, { x: 660, y: 40 }])), id: 'lnk' },
    ]
    withFrame.frames = [{ id: 'fr1', title: '第一节', ids: ['f0'], cards: [] }]
    eq(reader.read(withFrame).length, 0, '一头在板框上一头在卡上 → 也不是连接（要连就用箭头工具宣告）')
  }
}

// ═════════════════════════ 6e. 用户真手画的箭头（已废弃） ═════════════════════════
/* 这一节原来是"拿用户本人的笔迹当夹具，钉住形状判据的阈值"（原 [6e]，20 项）。
 * 2026-09-17 第二刀把它整节删掉了 —— 不是因为断言写错，是因为**判据本身被否掉了**：
 * 同一批笔迹上它 92 条判成"箭头"、真箭头 0 条（直度中位 0.28、张开角中位 ~20°），
 * 详见 ADR-0001 和 git 历史里这一版之前那一版。
 * 夹具 `scripts/fixtures/hand-arrows.json` 留着：第二刀之后**它没有调用者了**，
 * 但它是"用户的手型"的唯一实测记录（杆 51~59px 笔直、两臂张开 107°）——
 * 以后要是有人想再试"读形状"，先看这份数据、再看 ADR-0001。 */

// ═════════════════════════ 6f. 墨迹块：只为「条件」而留 ═════════════════════════
console.log('\n[6f] 墨迹块：第二刀之后它只服务一件事 —— 认出"写在中点旁边的那撮字"')
{
  /* ⚠ 从前这一节叫「墨迹块当端点」（19 项：两块字迹之间画线、分数线、中段压墨、
     短线认不出……）。那一整条路连同三道闸都砍了（ADR-0001）。
     现在墨迹块只剩一个身份：**条件**（"写在这条线中点旁边的那几个字"）。
     所以这一节只钉"块还认得出来、认得稳，而且不再影响谁是端点"。 */
  const blob = (cx, cy, n = 3) => {
    const out = []
    for (let i = 0; i < n; i++) {
      const x = cx + i * 9
      out.push(toFlat([{ x, y: cy }, { x: x + 6, y: cy + 7 }]))
    }
    return out
  }
  const mk = (strokes, extra = {}) => {
    const b = makeBoard()
    b.strokes = strokes.map(([id, flat]) => ({ ...newStroke('pen', flat), id }))
    return { ...b, ...extra }
  }
  const A = blob(0, 0)
  const B = blob(500, 0)
  const put = () => [...A.map((f, i) => ['a' + i, f]), ...B.map((f, i) => ['b' + i, f])]

  /* ① 数得出几块、id 稳不稳、空白处没有块 */
  {
    const b = mk(put())
    eq(inkBlocks(b.strokes).length, 2, '两坨字迹 → 2 块（每坨内部 3 笔挨在一起）')
    const idx = createInkIndex(b.strokes)
    const n1 = inkNodeAt(idx, { x: 3, y: 3 })
    const n2 = inkNodeAt(idx, { x: 3, y: 3 })
    if (n1 && n2 && n1.id === n2.id) ok(`同一个点查两次 → 同一个块 id（${n1.id}）`)
    else bad('块 id 不稳定')
    eq(n1 && n1.ids.length, 3, '块的成员是那 3 笔')
    eq(inkNodeAt(idx, { x: 250, y: 250 }), null, '空白处没有块')
  }

  /* ② 太小的不算"一个东西"（INK_NODE_MIN_SIZE）：一个 2px 的点不是条件 */
  {
    const b = mk([['dot', toFlat([{ x: 0, y: 0 }, { x: 2, y: 1 }])]])
    eq(inkNodeAt(createInkIndex(b.strokes), { x: 1, y: 0 }), null, '一个 2px 的点不算"一个东西"（太小）')
    eq(inkBlocks(b.strokes).length, 1, '但它仍然算一块（"板上有几块"这个读数不筛大小）')
  }

  /* ③ ★ 回归哨兵：块**不再**让一条线变成连接（那是第二刀砍掉的"墨迹块当端点"） */
  {
    const b = mk([...put(), ['lnk', toFlat([{ x: 6, y: 3 }, { x: 506, y: 3 }])]])
    eq(reader.read(b).length, 0, '两块字迹之间画一条线 → 0 条连接（端点只认卡片了）')
  }

  /* ④ 但块仍然要能被**条件**认出来：两张卡之间有连接，中点旁边那一撮字成为它的条件 */
  {
    const cards = [
      { ...newCard('note', 0, 0, { w: 80, h: 40 }), x: 0, y: 0, id: 'k1' },
      { ...newCard('note', 0, 0, { w: 80, h: 40 }), x: 400, y: 0, id: 'k2' },
    ]
    const b = mk(
      [['lnk', toFlat([{ x: 40, y: 20 }, { x: 440, y: 20 }])], ...blob(230, -34).map((f, i) => ['c' + i, f])],
      { cards }
    )
    const l = reader.read(b)[0]
    if (l && l.cond && /墨迹块/.test(l.cond.label || '')) ok(`中点旁边那撮字成了条件：${l.cond.label}`)
    else bad(`条件没读出来：${JSON.stringify(l && l.cond)}`)
  }
}

// ═════════════════════════ 6g. 「这条不算连接」（已废弃） ═════════════════════════
/* 2026-09-17 第二刀删掉了「不算连接」（`stroke.link = 'none'`）和它那条回头路。
 * 理由：那个口子存在的唯一前提是"从形状/位置**猜**出来的连接会猜错"（实测过一条 121px 的
 * 手写竖笔正好跨过两坨字被读成连接）。形状判据整族删掉之后，**连接要么是你画的
 * （卡↔卡一条线）、要么是你宣告的**（箭头工具）—— 猜没了，否决权就没有对象。
 * 那个位置换成了「**删掉这条连接**」（那排词里 `0` 那颗，见 link-kinds.js 的 LINK_DELETE）：
 * 宣告的那种删记录（[6q] 钉着）、画出来的那种删掉那一笔（真浏览器那条自检钉着）。 */
// ═════════════════════ 6h. 固定成一块 / 拆开 ═════════════════════
console.log('\n[6h] 板框（`frames`）：你亲手留下的一个整体')
{
  /* 从前的"固定成一块"（`groups`）**长出了脸**：成员可以是笔迹**和卡片**、有标题、
     框线按成员包围盒现算。所以这一段同时钉三件事：
       · 板框必须真的在 **buildLinks** 里生效（2026-09-16 审查挑出来的严重 bug：
         固定块登记在 `owner` 上，而 `owner` 在 dropKey 变化时被清光）；
       · 老文件里的 `groups` 必须**就地升成板框**（不然用户打开旧板，"我固定过的那块"没了）；
       · 存盘的规矩一个字都不能松：真有框才写、死成员不留尸体、空框自己消失。 */
  const blob = (cx, cy) => [0, 1, 2].map((i) => toFlat([{ x: cx + i * 9, y: cy }, { x: cx + i * 9 + 6, y: cy + 7 }]))
  const mk = (frames) => {
    const b = makeBoard()
    b.strokes = [
      ...blob(0, 0).map((f, i) => ({ ...newStroke('pen', f), id: 'a' + i })),
      ...blob(30, 0).map((f, i) => ({ ...newStroke('pen', f), id: 'b' + i })),
    ]
    b.frames = frames
    return b
  }
  /* 两坨只差 6px（< INK_BLOCK_GAP）→ 自动聚成一块 */
  eq(inkBlocks(mk([]).strokes).length, 1, '两坨挨得近 → 自动聚成 1 块')

  const two = [
    { id: 'g1', ids: ['a0', 'a1', 'a2'], cards: [] },
    { id: 'g2', title: '第二块', ids: ['b0', 'b1', 'b2'], cards: [] },
  ]
  const b2 = mk(two)
  const blocks = inkBlocks(b2.strokes, { frames: b2.frames })
  eq(blocks.length, 2, '两块各自留下 → 2 块（这就是"拆开"）')
  eq(blocks.map((x) => x.id).sort(), ['frm:g1', 'frm:g2'], '板框的节点 id 用框 id（稳定、跨重开一样）')
  eq(blocks.filter((x) => x.fixed).length, 2, '两块都标着 fixed')
  eq(blocks.find((x) => x.id === 'frm:g2').label, '第二块', '有标题的板框：面板上就用你的话')
  eq(blocks.find((x) => x.id === 'frm:g1').label, '板框（3 笔）', '没标题的板框：说清楚它是一块板框')
  /* 留下板框之后端点认到的是**那一块**（不是自动并出来的大块） */
  const idx = createInkIndex(b2.strokes, b2.frames)
  eq(inkNodeAt(idx, { x: 3, y: 3 }).id, 'frm:g1', '落在第一坨上 → 拿到的是留下的那个框')
  eq(inkNodeAt(idx, { x: 33, y: 3 }).id, 'frm:g2', '落在第二坨上 → 另一个框')

  /* ① 板框必须在**条件那一趟**里生效（不能只直接问 inkNodeAt）——
     2026-09-16 审查挑出来的那个严重 bug（固定块登记在 `owner` 上、
     而 `owner` 被清光）在这一刀之后换了形状：板框现在只影响"中点旁边那撮字算不算一块"。
     所以这里拿**条件**来钉它：框住的字从此刻起是一块（id 用框 id、label 用你的标题），
     不许和旁边那坨并在一个自动块里。 */
  {
    const blobs = (cx) => [0, 1, 2].map((i) => [`${cx}_${i}`, toFlat([{ x: cx + i * 9, y: 0 }, { x: cx + i * 9 + 6, y: 7 }])])
    const mkB = (frames) => {
      const b = makeBoard()
      /* 两张卡之间一条线；线中点旁边放两坨字（0 那一坨被框住、600 那一坨没有） */
      b.cards = [
        { ...newCard('note', 0, 0, { w: 80, h: 40 }), x: -200, y: -20, id: 'ka' },
        { ...newCard('note', 0, 0, { w: 80, h: 40 }), x: 1200, y: -20, id: 'kb' },
      ]
      b.strokes = [
        ...blobs(0).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
        ...blobs(600).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
        { ...newStroke('pen', toFlat([{ x: -160, y: 0 }, { x: 1160, y: 0 }])), id: 'ln' },
      ]
      b.frames = frames
      return b
    }
    const idx = createInkIndex(mkB([]).strokes, [])
    const auto = inkNodeAt(idx, { x: 3, y: 3 })
    if (auto && /墨迹块/.test(auto.label)) ok(`不留框：那一撮字是自动聚出来的块（${auto.label}）`)
    else bad(`自动块不对：${JSON.stringify(auto)}`)

    const fixedB = mkB([{ id: 'gA', title: '左边这一节', ids: ['0_0', '0_1', '0_2'], cards: [] }])
    const idx2 = createInkIndex(fixedB.strokes, fixedB.frames)
    const node = inkNodeAt(idx2, { x: 3, y: 3 })
    eq(node && node.id, 'frm:gA', '留下框之后：那一撮字是你的板框（id 用框 id）')
    eq(node && node.label, '左边这一节', '名字就是你的标题')
    /* 复用索引再来一次（应用里就是复用）：结果必须和"新开一个 reader 从零算"**一模一样**。
       ⚠ 第一版这条是 `JSON.stringify(reader.read(b, idx2)) === JSON.stringify(reader.read(b, idx2))` ——
          **同一个表达式比自己，恒真**；而且 `read()` 的第二个参数是**被静默忽略**的旧签名
          （索引早就收进 reader 内部了）。一条永远不会红的断言比没有更坏：它占着位置看着像验过了。
          见 README 第 38 条。 */
    const freshReader = createLinkReader()
    eq(
      JSON.stringify(reader.read(fixedB)),
      JSON.stringify(freshReader.read(fixedB)),
      '复用索引算出来的连接，和"新开一个 reader 从零算"一模一样（缓存不改变答案）'
    )
  }

  /* ② 存盘：真有框才写这个字段；死成员不留尸体；空框自己消失 */
  const text = serializeBoardDocument(b2)
  const back = parseBoardDocument(text, 'x')
  eq(back.frames.length, 2, '板框存进文件了')
  eq(back.frames[0].ids, ['a0', 'a1', 'a2'], '成员原样')
  eq(back.frames[1].title, '第二块', '标题也存进去了')
  if (!/frames/.test(serializeBoardDocument(mk([])))) ok('没框过的板一个 frames 字段都不写（不造假 diff）')
  else bad('没框过的板里出现了 frames')
  if (!('title' in JSON.parse(serializeBoardDocument(mk([{ id: 'g1', ids: ['a0', 'a1', 'a2'], cards: [] }]))).frames[0])) {
    ok('没起过名字的框不写 title（同上：零字节）')
  } else bad('空标题的框写出了 title')
  const halfDead = JSON.parse(serializeBoardDocument({ ...b2, strokes: b2.strokes.filter((s) => s.id !== 'a1') }))
  eq(halfDead.frames[0].ids, ['a0', 'a2'], '擦掉一笔之后，框里那个死 id 不再写出去')
  const allDead = parseBoardDocument(
    serializeBoardDocument({ ...b2, strokes: b2.strokes.filter((s) => !s.id.startsWith('a')) }),
    'x'
  )
  eq(allDead.frames.map((f) => f.id), ['g2'], '一个框的成员被擦光 → 那个框自己消失（不留空壳）')

  /* 同一个成员不许进两个框（重复的一律丢掉，先写的赢） */
  const dup = parseBoardDocument(
    serializeBoardDocument({ ...b2, frames: [...two, { id: 'g3', ids: ['a0', 'a1', 'a2'], cards: [] }] }),
    'x'
  )
  eq(dup.frames.map((f) => f.id), ['g1', 'g2'], '同一笔不能同时属于两个框（后来那个丢掉）')

  /* ③ 卡片也能是成员（"让板框内的东西形成一个整体"）—— 卡片和笔迹各管一摊，互不挤占 */
  {
    const b = makeBoard()
    b.strokes = [...blob(0, 0).map((f, i) => ({ ...newStroke('pen', f), id: 'a' + i }))]
    const c = { ...newCard('note', 100, 100), id: 'n1' }
    b.cards = [c]
    const wrapped = parseBoardDocument(
      serializeBoardDocument({ ...b, frames: [{ id: 'f1', title: '这一节', ids: ['a0'], cards: ['n1'] }] }),
      'x'
    )
    eq([wrapped.frames[0].ids, wrapped.frames[0].cards], [['a0'], ['n1']], '卡片和笔迹都能当成员，存读往返一致')
    /* 卡片被删掉 → 那个成员不留尸体；笔迹还在，框还在 */
    const gone = parseBoardDocument(serializeBoardDocument({ ...wrapped, cards: [] }), 'x')
    eq([gone.frames.length, gone.frames[0].cards], [1, []], '卡片删了：框还在（笔迹还在），死卡片 id 不再写')
    /* 两样都没了 → 框消失 */
    eq(parseBoardDocument(serializeBoardDocument({ ...wrapped, cards: [], strokes: [] }), 'x').frames.length, 0, '笔迹和卡片都没了 → 框自己消失')
  }

  /* ④ 老文件里的 `groups`（"固定成一块"）**就地升成板框** —— 那个功能不是被删掉，是长出了脸 */
  {
    const legacy = JSON.stringify({
      title: '老板',
      strokes: mk([]).strokes,
      cards: [],
      groups: [{ id: 'gold', ids: ['a0', 'a1', 'a2'] }],
    })
    const up = parseBoardDocument(legacy, 'x')
    eq([up.frames.length, up.frames[0].id, up.frames[0].ids], [1, 'gold', ['a0', 'a1', 'a2']], '老 groups → 板框（id 和成员都不动）')
    const reread = parseBoardDocument(serializeBoardDocument(up), 'x')
    eq([reread.frames.length, reread.frames[0].ids], [1, ['a0', 'a1', 'a2']], '升完存回去还是那一块（往返一致）')
    if (!/groups/.test(serializeBoardDocument(up))) ok('升完之后文件里不再有 groups（一份真相）')
    else bad('升完之后还有 groups 字段')
    /* 新的 frames 优先：两个字段同时在（手改过的文件）时不看旧的 */
    const both = parseBoardDocument(JSON.stringify({ strokes: mk([]).strokes, frames: [{ id: 'gnew', ids: ['b0'] }], groups: [{ id: 'gold', ids: ['a0'] }] }), 'x')
    eq(both.frames.map((f) => f.id), ['gnew'], 'frames 和 groups 同时在 → 只认 frames')
  }

  /* ⑤ frames.js 的那些**动作**（界面调的就是它们）*/
  {
    const b = mk([{ id: 'g1', ids: ['a0', 'a1'], cards: [] }])
    /* 留下一个新框：原来装着这些笔的框**让位**（一个成员只属于一个框），被拿空的框消失 */
    const moved = freezeFrame(b, { ids: ['a1', 'a2'], cards: [] })
    eq(moved.frames.map((f) => f.ids), [['a0'], ['a1', 'a2']], '新框把这些笔从旧框里拿走（旧的还剩一笔就留着）')
    const empty = freezeFrame(b, { ids: ['a0', 'a1'], cards: [] })
    eq(empty.frames.length, 1, '旧框被拿空 → 直接消失（不留空壳）')
    eq(empty.frames[0].ids, ['a0', 'a1'], '新框拿到了成员')
    eq(freezeFrame(b, { ids: [], cards: [] }), b, '什么都没圈 → 原样返回（不动板）')

    /* 加进来 / 拿出去 / 拆开 / 改标题 */
    const f1 = b.frames[0].id
    eq(addToFrame(b, f1, { ids: ['b0'], cards: [] }).frames[0].ids, ['a0', 'a1', 'b0'], '明说"加进来" → 并进去')
    eq(takeOutOfFrame(b, { ids: ['a0'], cards: [] }).frames[0].ids, ['a1'], '拿出去 → 框里少一笔')
    eq(takeOutOfFrame(b, { ids: ['a0', 'a1'], cards: [] }).frames.length, 0, '拿空了 → 框消失')
    eq(setFrameTitle(b, f1, '  这一节  ').frames[0].title, '这一节', '改标题（顺手去掉首尾空白）')
    eq('title' in setFrameTitle(b, f1, '   ').frames[0], false, '标题清空 → 字段也去掉（零字节那条规矩）')
    eq(dissolveFrame(b, f1).frames.length, 0, '拆开 → 框没了（成员照旧留在板上）')
    eq(dissolveFrame(b, '不存在').frames.length, 1, '拆一个不存在的框 → 原样返回')

    /* 整体挪：挪的是**成员**（框线是成员包围盒的函数，跟着走） */
    const card = { ...newCard('note', 200, 200), id: 'n1' }
    const b3 = { ...b, cards: [card], frames: [{ id: 'f9', title: 'x', ids: ['a0'], cards: ['n1'] }] }
    const before = frameBounds(b3, b3.frames[0])
    const movedB = translateFrame(b3, 'f9', 40, 25)
    const after = frameBounds(movedB, movedB.frames[0])
    eq([after.x - before.x, after.y - before.y], [40, 25], '整体挪一下：框线跟着成员走（挪的就是成员）')
    eq([movedB.cards[0].x - card.x, movedB.cards[0].y - card.y], [40, 25], '框里的卡片也一起挪')
    eq(movedB.strokes.find((s) => s.id === 'a1').points[0], b3.strokes.find((s) => s.id === 'a1').points[0], '不在这个框里的笔一笔都不动')
    eq(translateFrame(b3, 'f9', 0, 0), b3, '没位移 → 原样返回')

    /* 成员被删掉之后：内存里那一道清理 */
    eq(frameOf(b3, 'a0').id, 'f9', 'frameOf：一笔属于哪个框')
    eq(frameOf(b3, 'n1').id, 'f9', 'frameOf：卡片也问同一个入口')
    eq(frameOf(b3, 'b1'), null, '不在任何框里 → null')
    eq(pruneFrames({ ...b3, strokes: b3.strokes.filter((s) => s.id !== 'a0') }).frames[0].ids, [], '拿走框里唯一的笔：卡片还在 → 框还在（成员只剩卡片）')
    eq(pruneFrames({ ...b3, strokes: b3.strokes.filter((s) => s.id !== 'a0'), cards: [] }).frames.length, 0, '成员都没了 → 内存里那个框也没了')
    eq(frameMembers(b3, b3.frames[0]).strokes.map((s) => s.id), ['a0'], 'frameMembers：框里的成员对象')
  }

  /* ⑥ 框线的几何：成员包围盒 + 一圈内边距；成员里有卡片也算进去 */
  {
    const b = mk([{ id: 'g1', ids: ['a0', 'a1', 'a2'], cards: [] }])
    const box = frameBounds(b, b.frames[0])
    /* 比的是**成员**的墨迹外框，不是全板的（板上还有另一坨 b0..b2 不属于这个框）。
       外框按 `strokeBounds` 算 —— 它把线宽/2 撑出去（2.5 的笔 = 1.25），
       框线要抱住**墨**，不是抱住点的中心线（粗荧光笔的边才不会露在框外）。 */
    const inner = strokesBBox(b.strokes.filter((s) => b.frames[0].ids.includes(s.id)))
    const pad = 14 + 2.5 / 2
    near(box.x, inner.x0 - pad, 0.01, '框线 = 成员墨迹外框 + 14 内边距（左边）')
    near(box.y, inner.y0 - pad, 0.01, '同上（上边）')
    near(box.w, inner.x1 - inner.x0 + pad * 2, 0.01, '宽度也对得上')
    const withCard = { ...b, cards: [{ ...newCard('note', 400, 400), id: 'n9' }], frames: [{ id: 'g1', ids: [], cards: ['n9'] }] }
    eq(frameBounds(withCard, withCard.frames[0]).w >= 80, true, '只有卡片成员也能算出框线（卡片也是内容）')
    eq(frameBounds(b, { id: 'gX', ids: [], cards: [] }), null, '空框算不出框线 → null（不该画一个围空气的框）')
  }
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

  /* ⑩ 「不算连接」那条回头路（按整条链清）第二刀删掉了：
     它的前提是"形状判读会猜错"，而形状判读整族已经删掉（ADR-0001）。
     这一段留着位置说明它去哪儿了 —— 想看原来那两条断言，看 git 历史里这一版之前那一版。 */
  {
    const b = makeBoard()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }])), id: 'p1' },
      { ...newStroke('pen', toFlat([{ x: 100, y: 0 }, { x: 200, y: 0 }])), id: 'p2' },
    ]
    /* 现在链上不再挂任何"说法" —— 一笔就是一笔（接笔那条路也跟着形状判据一起删了） */
    eq(b.strokes.length, 2, '板上的笔一笔不少（这里只留个占位的夹具）')
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

  /* ── ③ 一个成员只能进一个框（界面的「▣ 留下板框」调的就是 frames.js 的 freezeFrame）── */
  {
    const before = [
      { id: 'g1', ids: ['a', 'b'], cards: [] },
      { id: 'g2', ids: ['c', 'd'], cards: [] },
    ]
    const after = freezeFrame({ ...makeBoard(), frames: before }, { ids: ['b', 'c'] }).frames
    eq(after.map((g) => g.ids), [['a'], ['d'], ['b', 'c']], '新留下的框赢：别处只剩没被拿走的')
    const flat = after.flatMap((g) => g.ids)
    eq(new Set(flat).size, flat.length, '没有一笔同时属于两个框')
    eq(freezeFrame({ ...makeBoard(), frames: [{ id: 'g9', ids: ['x', 'y'], cards: [] }] }, { ids: ['x', 'y'] }).frames.length, 1, '整块重新留下 → 原来那个框消失（不留空壳）')
    /* 内存里守住了，文件才守得住：这一串操作之后往返仍然字节一致 */
    const b = makeBoard()
    b.strokes = ['x', 'y'].map((id) => ({ ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 20, y: 0 }])), id }))
    b.frames = freezeFrame({ ...b, frames: [{ id: 'g9', ids: ['x', 'y'], cards: [] }] }, { ids: ['x', 'y'] }).frames
    const t = serializeBoardDocument(b)
    if (serializeBoardDocument(parseBoardDocument(t, 'x')) === t) ok('留下板框之后：存→读→再存仍然字节一致')
    else bad('留下板框之后往返不一致')
  }
}

// ═════════════════════ 6k. 连接读法：跨 interface 的断言 ═════════════════════
console.log('\n[6k] 连接读法（`createLinkReader`）：调用方只认这一个入口')
{
  /* 这一节是 2026-09-16 把索引/缓存收进 module 之后**才写得出**的断言。
     从前调用方要自己 `createInkIndex(strokes, frames)` 再传给 `buildLinks`，
     于是"缓存该不该失效"变成了调用方的知识 —— 自检只能绕过 `buildLinks` 去问 `inkNodeAt`，
     而"板框（当年的固定块）被清缓存而整个失效"那条严重 bug 正是从这儿漏的。
     现在这些都能从**同一道 seam** 上问：复用 reader 的结果 == 新开一个 reader 的结果。 */
  const blob = (cx) => [0, 1, 2].map((i) => [`${cx}_${i}`, toFlat([{ x: cx + i * 9, y: 0 }, { x: cx + i * 9 + 6, y: 7 }])])
  const b = makeBoard()
  /* 夹具：两张卡之间一条线（第二刀之后**连接只认卡片**，所以那两坨字迹要摆在线中点旁边
     当"条件"，而不是当端点）。 */
  b.cards = [
    { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: -160, y: -20, id: 'ka' },
    { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 640, y: -20, id: 'kb' },
  ]
  b.strokes = [
    ...blob(0).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
    ...blob(600).map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
    { ...newStroke('pen', toFlat([{ x: -120, y: 0 }, { x: 700, y: 0 }])), id: 'ln' },
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

  /* ③ 板框改了（frames 换新引用）→ 它必须重新生效（就是那条严重 bug 的形状：
      登记在会被清掉的缓存上、于是"你说它是东西"没生效）。
      第二刀之后板框只影响**条件**那一趟，所以这里拿条件钉：
      线中点旁边那撮字被框住之后，条件读出来的应该是**你的板框**（id/label 都变）。 */
  {
    const b2 = makeBoard()
    b2.cards = [
      { ...newCard('note', 0, 0, { w: 80, h: 40 }), x: 0, y: 0, id: 'ka' },
      { ...newCard('note', 0, 0, { w: 80, h: 40 }), x: 400, y: 0, id: 'kb' },
    ]
    /* 中点旁边（240,-34 一撮字）：不改 frames 时它是自动聚出来的"墨迹块" */
    const near = [0, 1, 2].map((i) => [`n${i}`, toFlat([{ x: 230 + i * 9, y: -34 }, { x: 236 + i * 9, y: -27 }])])
    b2.strokes = [
      { ...newStroke('pen', toFlat([{ x: 40, y: 20 }, { x: 440, y: 20 }])), id: 'lk' },
      ...near.map(([id, flat]) => ({ ...newStroke('pen', flat), id })),
    ]
    const rd = createLinkReader()
    const autoCond = (rd.read(b2)[0] || {}).cond
    eq(autoCond && /墨迹块/.test(autoCond.label || ''), true, '不留框：条件是自动聚出来的那一撮字')
    const framed = { ...b2, frames: [{ id: 'gX', title: '这一小撮', ids: ['n0', 'n1', 'n2'], cards: [] }] }
    const withFixed = rd.read(framed)
    eq(JSON.stringify(withFixed), JSON.stringify(fresh().read(framed)), '改了板框之后：复用 reader = 新 reader')
    eq(withFixed[0] && withFixed[0].cond && withFixed[0].cond.id, 'frm:gX', '而且条件那一头确实是你的板框（没有因为复用缓存而失效）')
    eq(withFixed[0] && withFixed[0].cond && withFixed[0].cond.label, '这一小撮', '名字就是你的标题')
  }

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

  /* ⑩ ★ 「什么时候重量」这条政策只有一个入口（2026-09-17 架构 review 候选 6）：
     调用方（Board.jsx）只报一句"发生了什么"，剩下的三件事 —— 排上所有公式卡、
     等字体就绪补一趟、板安静 FIT_IDLE_MS 之后再量 —— 全在 module 里。
     从前它们在 Board.jsx 的**六个调用点**上（其中两行逐字抄了两遍）。 */
  {
    const board = {
      cards: [
        { id: 'f1', kind: 'formula', tex: 'a=b', w: 100, h: 40 },
        { id: 'f2', kind: 'formula', tex: '', w: 100, h: 40 },
        { id: 'n1', kind: 'note', text: '一段话', w: 200, h: 60 },
      ],
    }
    const timed = []
    const cleared = []
    let fontKicks = 0
    const { fitter, frames } = mkFitter({
      sample: () => mkSnap(mkCard()),
      read: () => board,
      /* 假的"字体就绪"：立刻 resolve（真的那个是 document.fonts.ready） */
      fontsReady: () => ({ then: (fn) => { fontKicks++; fn() } }),
      later: (fn, ms) => { timed.push({ fn, ms }); return timed.length },
      clearLater: (h) => cleared.push(h),
    })
    fitter.queue('old', { fitWidth: true }) // 上一张板留下的
    eq(fitter.size, 1, '先排一张（模拟上一张板留下的队）')
    fitter.notify({ reason: 'load' })
    eq(fitter.size, 1, "notify('load')：清队重来 → 队里只剩这张板上那个有内容的公式卡")
    eq(frames.length, 1, '  （排队自己排一帧；字体那一脚合进同一帧 —— 一次只跑一趟）')
    eq(fontKicks, 1, "notify('load') 会顺手等一次字体就绪（KaTeX 换上去宽度会变一次）")
    eq(timed.length, 0, "  （'load' 不防抖：换文件那一刻就该量）")

    fitter.notify({ reason: 'board-changed' })
    eq(timed.length, 1, "notify('board-changed')：**不立刻量**，先挂一个定时器（防抖）")
    eq(timed[0].ms, FIT_IDLE_MS, `  （等的是 FIT_IDLE_MS=${FIT_IDLE_MS}）`)
    const sizeBefore = fitter.size
    fitter.notify({ reason: 'board-changed' })
    eq(cleared.length, 1, '★ 再报一次：**上一个定时器被撤掉**（一整串连续操作只量最后一趟）')
    if (fitter.size === sizeBefore) ok('  （还没到点，队里没动静）')
    else bad('防抖期间不该排队')
    timed[timed.length - 1].fn()
    eq(fitter.size, 1, '定时器到点：才真的排上公式卡')
    eq(fontKicks, 2, '  （也补了字体那一脚）')

    const framesBefore = frames.length
    fitter.notify({ reason: 'editing-ended' })
    if (frames.length >= framesBefore) ok("notify('editing-ended')：不防抖、不等定时器（这一下本身就是'安静了'）")
    else bad("'editing-ended' 反而把帧撤了")
    eq(timed.length, 2, '  （没有再多一个定时器）')
    /* 换一个"没有帧在飞"的账本，才看得见它真的排了一帧（同一帧里的多次请求会被合并） */
    {
      const fresh = mkFitter({ sample: () => mkSnap(mkCard()) })
      fresh.fitter.notify({ reason: 'editing-ended' })
      eq(fresh.frames.length, 1, "  （它确实排了一帧 —— 编辑时挂起来的那张现在量得上）")
    }

    /* ★ 政策的家：这几个名字不该在 Board.jsx 里再出现（谁把它抄回去，这条当场红） */
    const boardSrc = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8')
    const left = ['REFIT_IDLE_MS', 'scheduleFits', 'queueFormulaRefits'].filter((w) => boardSrc.includes(w))
    if (!left.length) ok('★ Board.jsx 里没有这套时序的残留（防抖 / 开跑 / 排公式卡都在 card-fit.js 一处）')
    else bad(`Board.jsx 里还留着：${left.join(' / ')} —— 这条政策应该只有 card-fit.js 一处`)
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
    eq([r.count, r.empty, r.strokes.length, r.box, r.link, r.frame], [0, true, 0, null, null, null], '没框东西 → 全空（empty=true）')
  }

  /* ② 框住一笔普通墨迹：有 strokes 和 box，但"不是一条线、不是一块、没有否决" */
  {
    const b = makeBoard()
    b.strokes = [{ ...newStroke('pen', toFlat([{ x: 10, y: 10 }, { x: 40, y: 30 }])), id: 's1' }]
    const r = readSelection(b, new Set(['s1']), [])
    eq([r.count, r.strokes.length, r.link, r.frame], [1, 1, null, null], '普通一笔：有一条 box、其余都是空')
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

  /* ④ 「不算连接」那条回头路（`noLink`）第二刀删掉了 ——
     它的前提是"形状判读会猜错"，而形状判读整族已经删掉（ADR-0001）。
     现在那个位置是「删掉这条连接」：宣告的那种由 frames.js 的 removeLink 负责（[6q] 钉着），
     画出来的那种删掉那一笔（真浏览器那条自检钉着）。 */

  /* ⑤ 「框住的**正好是某个框的笔**」才算那个框：少一笔都不算（不然框一大片会顺手拆了某个框） */
  {
    const b = makeBoard()
    b.strokes = ['a', 'b', 'c'].map((id, i) => ({ ...newStroke('pen', toFlat([{ x: i * 10, y: 0 }, { x: i * 10 + 5, y: 5 }])), id }))
    b.frames = [{ id: 'g1', title: '这一节', ids: ['a', 'b'], cards: [] }]
    eq(readSelection(b, new Set(['a', 'b']), []).frame && readSelection(b, new Set(['a', 'b']), []).frame.id, 'g1', '正好框住一个框的笔 → 拿到那个框（浮层给「拆开这块」）')
    eq(readSelection(b, new Set(['a']), []).frame, null, '只框住框里的一笔 → 不算（少一笔都不算）')
    eq(readSelection(b, new Set(['a', 'b', 'c']), []).frame, null, '多框了一笔 → 也不算（不顺手拆）')
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

  /* ⑦⑧ 「不算连接」写在整条链上 / 那条回头路 —— 两节都跟着第二刀删掉了（ADR-0001）。
     这里只留一个哨兵：**接笔那条路也没了**（`chainOfStroke` 一起删的），
     所以"一条连接 = 一笔"现在是真的 —— 两笔首尾相接不再被当成一条线。 */
  {
    const b = makeBoard()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }])), id: 'q1' },
      { ...newStroke('pen', toFlat([{ x: 100, y: 0 }, { x: 200, y: 0 }])), id: 'q2' },
      { ...newStroke('pen', toFlat([{ x: 400, y: 0 }, { x: 460, y: 0 }])), id: 'other' },
    ]
    /* 卡片一只都没有 → 一笔都不是连接（端点只认卡片） */
    eq(reader.read(b).length, 0, '没有卡片的板上，几笔接在一起也不是连接（不再接笔、不再认墨迹块）')
    const next = applyStrokeLink(b, [], 'q1', 'cause')
    eq(next.strokes.find((s) => s.id === 'q1').link, 'cause', '改词只动那一笔（不再按"整条链"撒）')
    eq(next.strokes.find((s) => s.id === 'q2').link, undefined, '★ 接在它后面的那一笔一点没动')
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

  /* ⑪ 删 / 留下板框 / 拆开：三步都有"只动该动的"这条底线 */
  {
    const b = makeBoard()
    b.cards = [{ ...newCard('note', 0, 0, { w: 100, h: 60 }), id: 'kc' }]
    b.strokes = ['s1', 's2', 's3'].map((id, i) => ({ ...newStroke('pen', toFlat([{ x: i * 20, y: 0 }, { x: i * 20 + 8, y: 8 }])), id }))
    const del = removePick(b, new Set(['s2']))
    eq(del.strokes.map((s) => s.id), ['s1', 's3'], '删掉框住的那一笔，别的都在')
    eq(del.cards, b.cards, '卡片一个没动（同一个数组引用）')
    eq(removePick(b, new Set()), b, '没框东西 → 原样返回（不造新对象，免得白记一步撤销）')
    /* ★ 2026-09-21：卡片也归它删（框选把卡片一起框进来了，Delete 就该一起删）。
       分成两处的话，"框住 3 笔 + 1 张卡按 Delete"会只删一半。 */
    const delBoth = removePick(b, new Set(['s1']), new Set(['kc']))
    eq(delBoth.strokes.map((s) => s.id), ['s2', 's3'], '  ★ 笔迹和卡片一起删（笔那半边）')
    eq(delBoth.cards.length, 0, '  ★ …卡片那半边（只删框住的那张）')
    eq(removePick(b, new Set(), new Set(['kc'])).strokes.length, 3, '  …只删卡片时笔迹一笔不动')

    /* 先留下 {s1,s2}，再把 {s2,s3} 留成一个框：s2 只能属于一个框，
       所以它要从第一个框里被拿走，而且 movedFrom 要说得出"原来在哪"（提示语照实说）。 */
    const first = freezeFrameSelection(b, new Set(['s1', 's2']))
    eq(first.board.frames.length, 1, '第一次留下：多了一个框')
    eq(first.movedFrom.length, 0, '第一次留下：没有"从别的框挪过来"这回事')
    const second = freezeFrameSelection(first.board, new Set(['s2', 's3']))
    eq(second.movedFrom.length, 1, '第二个框和第一个重叠 → movedFrom 报出那个框（提示语要照实说）')
    const gs = second.board.frames
    eq(gs.filter((g) => g.ids.includes('s2')).length, 1, '★ 一笔只能属于一个框（s2 只在一个框里）')
    eq(gs.map((g) => [...g.ids].sort()).sort().join('|'), ['s1', 's2,s3'].sort().join('|'), '第一个框里只剩 s1，新框是 s2+s3')
    const dissolved = dissolveFrame(second.board, gs[0].id)
    eq(dissolved.frames.length, 1, '拆开一个框 → 只剩另一个')
    eq(dissolveFrame(b, null).frames.length, 0, '没有框可拆 → 原样返回')
  }

  /* ⑫ ★★ 卡片也进选区（2026-09-21）：「框选中任意的字迹——卡片都应该能够放大，旋转」。
     判据和「留下板框」「复制」当年那句一样（卡片**中心**落在框里才算）——
     现在它发生在**框选那一刻**，不再是回头再拿矩形算一遍。 */
  {
    const b = makeBoard()
    b.cards = [
      { ...newCard('note', 0, 0, { w: 100, h: 60 }), id: 'in', x: 20, y: 20 },
      { ...newCard('note', 0, 0, { w: 100, h: 60 }), id: 'out', x: 900, y: 900 },
    ]
    const r = readSelection(b, new Set(), [], ['in'])
    eq(r.cardIds, ['in'], '⑫ 框住的卡片进选区（`sel.cardIds`）')
    eq(r.cards.map((c) => c.id), ['in'], '  …而且拿到的是卡片对象（和 `strokes` 对称）')
    eq([r.count, r.countAll, r.empty], [0, 1, false], '  ★ 只框住一张卡也是"选着东西"（empty=false，count 仍然是**笔数** 0）')
    const both = readSelection(b, new Set(), [], ['in', 'out'])
    eq(both.countAll, 2, '  …两张卡：countAll 说得出"框里一共几样"')
    eq(readSelection(b, null, [], null).empty, true, '  （什么都没框 → empty=true，不是"空数组"）')
    eq(focusInk([], []), FOCUS_NONE, '  ★ 笔和卡都没有 → 空焦点（focusInk 两边都收）')
    eq(focusInkCards(focusInk(['s1'], ['k1'])), ['k1'], '  …焦点里卡片读得出来')
    eq(focusInkCards(focusInk(['s1'])), [], '  …没框卡片时是空数组（绝不是 undefined，调用方不用先判）')
    eq('cards' in focusInk(['s1']), false, '  ★ 没有卡片时**连字段都不写**（和板文件那些字段同一条纪律）')
    eq(deleteIntent(focusInk(['s1'], ['k1']), 'Delete', { tagName: 'CANVAS', closest: () => ({}) }), { kind: 'delete-ink', ids: ['s1'], cards: ['k1'] }, '  ★ Delete 把卡片一起报出去（不然"删除只做了一半"）')
  }

  /* ⑬ ★★ 选区缩放 / 旋转（`transformPick`）—— 用户 2026-09-21 要的那件事本身。
     纯几何在这里钉死；"手柄 → 手势 → 板"那条接线由 check:shape 的真浏览器那几节管。 */
  {
    const mkPickBoard = () => {
      const b = makeBoard()
      b.strokes = [
        { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }]), { width: 2 }), id: 'a' },
        { ...newStroke('pen', toFlat([{ x: 0, y: 50 }, { x: 100, y: 50 }]), { width: 2 }), id: 'b' },
        { ...newStroke('pen', toFlat([{ x: 500, y: 500 }, { x: 520, y: 520 }]), { width: 2 }), id: 'far' },
      ]
      b.cards = [{ ...newCard('note', 200, 0, { w: 100, h: 50 }), id: 'k1', x: 200, y: 0, text: '卡' }]
      return b
    }
    const boxOf = (bd, ids, cards) => pickBox(bd.strokes.filter((s) => ids.includes(s.id)), (bd.cards || []).filter((c) => cards.includes(c.id)))

    /* (a) 包围盒：笔迹的点 ∪ 卡片的**可视**外框（含倍率和旋转） */
    {
      const b = mkPickBoard()
      eq(boxOf(b, ['a', 'b'], []), { x0: 0, y0: 0, x1: 100, y1: 50 }, '(a) 两笔的包围盒')
      eq(boxOf(b, ['a'], ['k1']), { x0: 0, y0: 0, x1: 300, y1: 50 }, '  ★ 卡片也进包围盒（框住的东西由同一个框圈着）')
      b.cards[0] = { ...b.cards[0], scale: 2 }
      eq(boxOf(b, ['a'], ['k1']), { x0: 0, y0: 0, x1: 400, y1: 100 }, '  ★ 卡片的**倍率**算进去（不然框比卡片小一圈）')
      b.cards[0] = { ...b.cards[0], rot: Math.PI / 2 }
      const r = cardVisualRect(b.cards[0])
      eq([Math.round(r.w), Math.round(r.h)], [200, 100], '  …可视矩形（倍率乘过的布局框）')
      eq(Math.round(cardBounds(b.cards[0]).h), 200, '  ★ 转 90° 之后**外接框**高 200（关系/框线吃的是它）')
      /* 转过 90° 之后外接框是 x 250~350（中心 300,50 那一圈）——
         用它而不是"没转的那个矩形"，卡片才不会被露在选区外面。 */
      eq(boxOf(b, ['a'], ['k1']).x1, 350, '  …选区包围盒用的是外接框（转起来也不会把卡片露在框外）')
    }

    /* (b) 缩放：笔迹分轴、锚点不动；卡片等比 + 中心跟着走；不在选区的纹丝不动 */
    {
      const b = mkPickBoard()
      const next = transformPick(b, { ids: ['a', 'b'], cardIds: ['k1'] }, { scale: { fx: 2, fy: 1, anchor: { x: 0, y: 0 } } })
      const a = next.strokes.find((s) => s.id === 'a')
      eq([a.points[0], a.points[1], a.points[3], a.points[4]], [0, 0, 200, 0], '(b) 笔迹横向拉 2 倍（分轴：y 不动）')
      eq(a.width, 2.8, '  ★ 线宽跟着**几何平均**走并量化到 1/10（2 × √2 → 2.8）')
      eq(next.strokes.find((s) => s.id === 'far').points, b.strokes[2].points, '  ★ 框外的笔一个点都不动')
      const k = next.cards[0]
      const kr = cardVisualRect(k)
      eq(k.scale, Math.sqrt(2), '  ★ 卡片：倍率取**几何平均**（1 × √(2·1)）')
      eq([Math.round(kr.cx), Math.round(kr.cy)], [500, 25], '  ★ …而中心按完整的 fx/fy 走（x 也拉了两倍：250 → 500）')
      eq(b.cards[0].scale, 1, '  ★ 原 board 一个字节没动（纯函数）')
      /* ⚠ 卡片**不能**跟着 fx/fy 分轴变：它的内容是文字（w 是硬约束，写小了当场裁内容）。
         这一条断言就是"卡片只等比"那句话的对手盘。 */
      const w0 = b.cards[0].w
      eq(next.cards[0].w, w0, '  ★ 卡片的布局宽 `w` 不变（变的是倍率）—— 文字不会因为拉伸而重折行')

      /* 锚点是"那个角的对角"：它一个数都不许动。 */
      const b2 = mkPickBoard()
      const n2 = transformPick(b2, { ids: ['a', 'b'], cardIds: [] }, { scale: { fx: 3, fy: 3, anchor: { x: 0, y: 0 } } })
      const p0 = n2.strokes.find((s) => s.id === 'a').points
      eq([p0[0], p0[1]], [0, 0], '  ★ 锚点（拖右下角时左上角）不动')

      /* 拖到 0：倍率被**夹住**（剩 PICK_MIN_SPAN），不是"这一帧不算" —— 后者拖不回来。 */
      const b3 = mkPickBoard()
      const n3 = transformPick(b3, { ids: ['a', 'b'], cardIds: [] }, { scale: { fx: 0, fy: 0, anchor: { x: 0, y: 0 } } })
      const p3 = n3.strokes.find((s) => s.id === 'a').points
      const span = pickBox(n3.strokes.filter((s) => s.id !== 'far'), [])
      eq(span.x1 - span.x0 > 0 && span.y1 - span.y0 > 0, true, '  ★ 倍率 0 也不会把选区压成一点（夹到还剩 PICK_MIN_SPAN，才拖得回来）')
      eq(p3[0] === 0 && p3[3] <= 2.0001, true, '  …那一轴真的只剩 PICK_MIN_SPAN 那么大')
    }

    /* (c) 旋转：绕**选区包围盒中心**，笔迹和卡片一起转；没选中的不动 */
    {
      const b = mkPickBoard()
      const center = { x: 50, y: 25 }
      const b2 = { ...b, strokes: b.strokes.map((s) => (s.id === 'a' ? { ...s, points: toFlat([{ x: 0, y: 25 }, { x: 100, y: 25 }]) } : s)) }
      const next = transformPick(b2, { ids: ['a', 'b'], cardIds: ['k1'] }, { rotate: { d: Math.PI / 2, center } })
      const a = next.strokes.find((s) => s.id === 'a')
      eq([Math.round(a.points[0]), Math.round(a.points[1])], [50, -25], '(c) 一笔绕选区中心转 90°（左端 → 上端）')
      eq(a.points[3], 50, '  …另一端也落在同一条竖线上')
      eq(next.strokes.find((s) => s.id === 'far').points, b.strokes[2].points, '  ★ 框外的笔一个点都不动')
      const k = next.cards[0]
      eq(Math.abs(k.rot - Math.PI / 2) < 1e-9, true, '  ★ 卡片的 `rot` 加上了这个角（重开之后它还是斜的）')
      const r0 = cardVisualRect(b.cards[0])
      const r1 = cardVisualRect(k)
      /* 卡片中心也要绕着选区中心转 —— 只改 `rot` 不动位置的话，卡片会**原地自转**
         （这正是 shape-object.js 里 rotateShape 那个"绕别人的中心转"的错）。 */
      eq([Math.round(r1.cx), Math.round(r1.cy)], [Math.round(center.x - (r0.cy - center.y)), Math.round(center.y + (r0.cx - center.x))], '  ★ 卡片的位置也跟着绕中心转（不是原地自转）')
      eq(b.cards[0].rot || 0, 0, '  ★ 原 board 没被动过（纯函数）')
      /* 转过去再转回来：`rot` 精确回到 0（不许留 1e-17；也不许是 -0 —— JSON 里那是两个字符串）。
         ⚠ 内存里 `rot` 恒有（和 `scale` / `locked` / `font` 同一条：默认值在 normalizeCard 里补齐），
           "不写进文件"是 serializeBoardDocument 那一趟的事（见 [6y] 的落盘断言）。 */
      const back = transformPick(next, { ids: ['a', 'b'], cardIds: ['k1'] }, { rotate: { d: -Math.PI / 2, center } })
      eq(back.cards[0].rot === 0 && !Object.is(back.cards[0].rot, -0), true, '  ★ 转一圈回来 `rot` 精确归 0（不是 -0、也不是 1e-17）')
    }

    /* (d) 图形那一笔在缩放里必须走**参数**（不然"这是个圆"就改没了） */
    {
      const b = makeBoard()
      /* 夹具直接**造一个图形对象**（`retargetStroke` 是唯一入口）——
         不去走判读那一趟：这里要验的是变换，判读本身在 [6x] 有 64 项管着，
         走判读还会被"采样密度闸 / 太小的一笔不参与判定"那些规矩挡回来（那是另一件事）。 */
      const base = { ...newStroke('pen', toFlat([{ x: 0, y: 0 }, { x: 100, y: 0 }]), { width: 2 }), id: 'r1' }
      b.strokes = [retargetStroke(base, { k: 'rect', cx: 50, cy: 30, w: 100, h: 60 })]
      eq(!!b.strokes[0].shape, true, '(d) 夹具：这一笔是个矩形对象')
      {
        const scaled = transformPick(b, { ids: ['r1'], cardIds: [] }, { scale: { fx: 2, fy: 1, anchor: { x: 0, y: 0 } } })
        const s2 = scaled.strokes[0]
        eq(!!s2.shape, true, '  ★ 缩放之后它**还是那个图形**（手柄、旋转、重开都还在）')
        eq(Math.round(s2.shape.w), 200, '  …参数跟着变了（宽 100 → 200）')
        const pts = s2.points
        eq(Math.abs(pts[0] - 0) < 0.2 && Math.abs(pts[3] - 200) < 0.2, true, '  …而点是**从参数重烤**出来的（那条铁律：shape 和 points 任何时候都对得上）')
        const rot = transformPick(b, { ids: ['r1'], cardIds: [] }, { rotate: { d: Math.PI / 2, center: { x: 50, y: 30 } } })
        eq(!!rot.strokes[0].shape, true, '  ★ 转完之后也还是图形（`rot` 是参数，不是"把点转一遍"）')
        eq(Math.abs(rot.strokes[0].shape.rot - Math.PI / 2) < 1e-6, true, '  …`rot` 记下了这个角')
        eq(Math.abs(rot.strokes[0].shape.cx - 50) < 0.2 && Math.abs(rot.strokes[0].shape.cy - 30) < 0.2, true, '  ★ 绕它自己的中心转：中心不动')
        /* ★★ 绕**别处**转时中心必须跟着绕 —— 只改 `rot` 不动 cx/cy 的话，
           图形会原地自转，而它周围的手写老老实实转走了（2026-09-21 修的正是这一处）。 */
        /* 绕原点转 +90°：(50,30) → (-30,50)（正角是屏幕坐标里的顺时针，y 向下）。 */
        const rot2 = transformPick(b, { ids: ['r1'], cardIds: [] }, { rotate: { d: Math.PI / 2, center: { x: 0, y: 0 } } })
        eq(Math.abs(rot2.strokes[0].shape.cx + 30) < 0.2 && Math.abs(rot2.strokes[0].shape.cy - 50) < 0.2, true, '  ★★ 绕**别处**转时中心跟着走（只改 rot 的话图形会原地自转）')
        /* 转 90° 之后它仍然是个**轴对齐**的矩形（`rot` 是参数，所以"规整"这件事没被破坏）。 */
        eq(Math.abs(Math.abs(rot.strokes[0].shape.rot) - Math.PI / 2) < 1e-9, true, '  …而且仍然是精确的 90°（不是"把点转一遍"那种歪四边形）')
      }
    }
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
    /* 分层（2026-09-17）：建一层 / 移动各是一个接口，URL 也只在这一处。
       ★ get/put 传的是**整条相对路径**，所以编码要把 `/` 一起编成 `%2F` ——
         漏了就是"路径被当成两段"，服务端收到 `a/b` 之外的怪东西，
         症状和中文没编码一样：这张板打不开。 */
    const NESTED = '大物/电磁学/board-第一章.md'
    await api.get(NESTED)
    eq(calls[4].url, '/api/file/' + encodeURIComponent(NESTED), 'get 用**整条路径**编码（`/` 也要编成 %2F）')
    if (calls[4].url.includes('/api/file/大物')) bad('URL 里出现了裸路径 —— 没编码')
    else ok('嵌套路径的 URL 里没有裸中文 / 裸斜杠')
    await api.mkdir('大物/电磁学')
    eq([calls[5].url, JSON.parse(calls[5].init.body)], ['/api/mkdir', { path: '大物/电磁学' }], 'mkdir → POST /api/mkdir { path }')
    await api.move(NESTED, '大物')
    eq([calls[6].url, JSON.parse(calls[6].init.body)], ['/api/move', { from: NESTED, to: '大物' }], 'move → POST /api/move { from, to }')
    /* 服务端的错误要**原样透传**（调用方靠 r.error 决定弹什么） */
    const errApi = createFileApi({ fetch: () => Promise.resolve({ json: () => Promise.resolve({ error: '非法文件名' }) }) })
    eq((await errApi.create('x', 'y')).error, '非法文件名', '服务端回的错误原样透传（不吞、不改写）')
  }

  /* ⑦ 分层：用户在"这一课叫什么"里打一条路径 —— 这是分层唯一的入口，
     所以它必须容错（`大物\电磁学\第一章`、带 `.md`、两头空白都算数）。 */
  {
    eq(splitTitlePath('大物/电磁学/第一章'), { dir: '大物/电磁学', title: '第一章' }, '路径 → 层 + 名字')
    eq(splitTitlePath('  复变函数  '), { dir: '', title: '复变函数' }, '只写一个名字 → 建在根上（dir 空）')
    eq(splitTitlePath('大物/电磁学/第一章.md'), { dir: '大物/电磁学', title: '第一章' }, '结尾的 .md 不算名字的一部分')
    eq(splitTitlePath('大物\\电磁学\\第一章'), { dir: '大物/电磁学', title: '第一章' }, '反斜杠也认（Windows 上打顺手了）')
    eq(splitTitlePath('大物//电磁学/ /第一章'), { dir: '大物/电磁学', title: '第一章' }, '空段和空格段丢掉')
    eq(boardPath('大物/电磁学', '第一章'), '大物/电磁学/board-第一章.md', 'boardPath：层 + 标题 → 存到哪儿')
    eq(boardPath('', '第一章'), 'board-第一章.md', '根上就是老样子（前面不带斜杠）')
    if (isBoardName(boardPath('大物/电磁学', '第一章'))) ok('深处的板名 isBoardName 照样认得出（它只看最后一段）')
    else bad('深处的板名认不出来：' + boardPath('大物/电磁学', '第一章'))
    eq(nextBoardName(['大物/board-新白板.md'], '大物'), '大物/board-新白板 2.md', '撞名只管**同一层**：大物/新白板 被占 → 2')
    eq(nextBoardName(['board-新白板.md'], '大物'), '大物/board-新白板.md', '别的层的同名不算撞（不同层可以重名）')
  }

  /* ⑧ 分层以后"打开哪一个"照样成立：深处的板也是一张板，?file= 也认整条路径。 */
  {
    const DEEP = F('大物/电磁学/board-第一章.md')
    const p = planStartup({ files: [NOTE, DEEP] })
    eq([p.step, p.name], ['open', '大物/电磁学/board-第一章.md'], '一张板都没在根上时，深处的板照样是第一张板')
    eq(planStartup({ files: [NOTE, DEEP], want: DEEP.name }).step, 'open', '?file= 认整条相对路径')
    eq(planStartup({ files: [NOTE], want: DEEP.name }).step, 'none', '?file= 指了一条不在列表里的深路径 → 什么都不打开')
    eq(planStartup({ files: [NOTE, F('大物/电磁学/打卡.md')] }).step, 'create-board', '只有笔记（哪怕在深一层）→ 还是补一张空板')
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

// ═════════════════════ 6p. 「条件就是它」 ═════════════════════
/* 位置送的条件还有**读不到**的时候：条件写在别处、或者你后来把那几笔挪走了
 * （挪走就不算数了 —— 那正是"位置送"的定义）。这时得能亲手指一个：
 * `cond: 'card:<卡 id>'` / `'ink:<笔 id>'`。
 * 这一节钉的就是这条路的规矩：**你说过的话优先于位置**、指的东西没了就当没说过、
 * 死 id 不进文件（不留尸体）、回头路清得干净。
 * 端到端对手是 check:link 的 [13]（真浏览器：框住线 → 「∈ 条件」→ 点一下目标）。 */
console.log('\n[6p] 「条件就是它」（`cond: card:/ink:`）：位置读不到时，你亲手指一个')
{
  /* 一张板：两张卡 + 一条直线连接 + **离中点很远**的一撮字（位置读不到它）。 */
  const mk = () => {
    const b = makeBoard()
    b.cards = [
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 0, y: 0, id: 'k1', text: 'A' },
      { ...newCard('note', 0, 0, { w: 120, h: 80 }), x: 600, y: 0, id: 'k2', text: 'B' },
      { ...newCard('note', 0, 0, { w: 120, h: 60 }), x: 0, y: 400, id: 'k3', text: '仅当…（离得远）' },
    ]
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 60, y: 40 }, { x: 300, y: 40 }, { x: 660, y: 40 }])), id: 'lk' },
      /* 板角上那撮字：离这条线的中点 (360,40) 有 400 世界像素，位置永远读不到 */
      { ...newStroke('pen', toFlat([{ x: 40, y: 520 }, { x: 120, y: 520 }])), id: 'f1' },
      { ...newStroke('pen', toFlat([{ x: 40, y: 528 }, { x: 128, y: 528 }])), id: 'f2' },
      { ...newStroke('pen', toFlat([{ x: 40, y: 536 }, { x: 112, y: 536 }])), id: 'f3' },
    ]
    return b
  }

  /* ① 基线：位置读不到那撮字（离中点太远），所以这一步"缺条件" */
  {
    const b = mk()
    const l = reader.read(b)[0]
    eq(l.cond, null, '位置读不到（那撮字离中点 400 像素）—— 所以才有"指"这条路')
    eq(l.condManual, false, '没说过话 → condManual false')
    /* 把那条线标成"推导"，好让面板读成链（链上那一步会显示缺条件） */
    b.strokes = b.strokes.map((s) => (s.id === 'lk' ? { ...s, link: 'derive' } : s))
    const chains = deriveChains(reader.read(b))
    eq(chains[0].steps[0].missing, true, '推导链上那一步缺条件（下一步指一个给它）')
  }

  /* ② 指一撮字：就算它离中点十万八千里，也算数 */
  {
    const b = mk()
    const l = reader.read(b)[0]
    const next = specCond(b, l, condInk('f1'))
    const l2 = reader.read(next)[0]
    if (l2.cond && l2.cond.kind === 'ink') ok(`指了板角那撮字 → 它成了条件（${l2.cond.label}）`)
    else bad(`指了却没成条件：${JSON.stringify(l2.cond)}`)
    eq(l2.condSpec, { kind: 'ink', id: 'f1' }, 'condSpec 记住了"这是你指的、指的是谁"（面板据此写"（你指的）"）')
    eq(l2.condManual, true, 'condManual：你说过话（面板要给回头路）')
    eq(b.strokes.find((s) => s.id === 'lk').cond, undefined, '★ 原 board 没动（纯函数）')
    /* 链上那一步不再缺条件了 */
    const withDerive = { ...next, strokes: next.strokes.map((s) => (s.id === 'lk' ? { ...s, link: 'derive' } : s)) }
    eq(deriveChains(reader.read(withDerive))[0].steps[0].missing, false, '链上那一步补齐了')
  }

  /* ③ 指一张卡：直接认它（面板自己会去 board.cards 里取名字） */
  {
    const b = mk()
    const l = reader.read(b)[0]
    const next = specCond(b, l, condCard('k3'))
    const l2 = reader.read(next)[0]
    eq([l2.cond && l2.cond.kind, l2.cond && l2.cond.id], ['card', 'k3'], '指一张卡 → 条件就是那张卡')
    eq(l2.condSpec, { kind: 'card', id: 'k3' }, 'condSpec 记的是卡 id')
  }

  /* ④ 你说的话**压过**位置：中点旁边本来有字也算你说过的那个 */
  {
    const b = mk()
    /* 在中点旁边塞一撮字（位置本来会读它） */
    b.strokes.push(
      { ...newStroke('pen', toFlat([{ x: 352, y: 84 }, { x: 392, y: 84 }])), id: 'm1' },
      { ...newStroke('pen', toFlat([{ x: 352, y: 92 }, { x: 400, y: 92 }])), id: 'm2' },
      { ...newStroke('pen', toFlat([{ x: 352, y: 100 }, { x: 388, y: 100 }])), id: 'm3' }
    )
    const l0 = reader.read(b)[0]
    if (l0.cond && l0.cond.kind === 'ink') ok(`先把位置读到的那个也摆上（${l0.cond.label}）`)
    else bad('夹具没摆出"位置读得到"的情形')
    const next = specCond(b, l0, condCard('k3'))
    eq(reader.read(next)[0].cond.id, 'k3', '★ 你说过的话优先：位置读到的那个让位')
  }

  /* ⑤ 指的东西没了 → 当没说过（回到按位置读），而且**不进文件**（不留尸体） */
  {
    const b = mk()
    const l = reader.read(b)[0]
    /* 卡被删了 */
    const goneCard = specCond(b, l, condCard('k9'))
    eq(reader.read(goneCard)[0].cond, null, '指的卡不在板上 → 当没说过（回到按位置读）')
    eq(reader.read(goneCard)[0].condManual, false, '也不留"你说过"的痕迹')
    if (!/"cond"/.test(serializeBoardDocument(goneCard))) ok('死 id 不进文件（不留尸体）')
    else bad('文件里写了一个已经不存在的 id')
    /* 笔被擦了 */
    const goneInk = specCond(b, l, condInk('zzz'))
    eq(reader.read(goneInk)[0].cond, null, '指的笔不在板上 → 同样当没说过')
    /* 而且**存→读→再存**之后，那句话彻底消失（解析时也清死 id） */
    const round = parseBoardDocument(serializeBoardDocument(goneCard), 'x')
    eq(round.strokes.find((s) => s.id === 'lk').cond, undefined, '读回来时死 id 已经被清掉')
  }

  /* ⑥ 否决和指定**互相覆盖**（一个字段只能有一个值 —— 这就是把它们放在一个字段里的原因） */
  {
    const b = mk()
    const l = reader.read(b)[0]
    const vetoed = vetoCond(b, l)
    eq(reader.read(vetoed)[0].condManual, true, '先说不算 → condManual')
    const thenSpec = specCond(vetoed, reader.read(vetoed)[0], condCard('k3'))
    eq(reader.read(thenSpec)[0].cond.id, 'k3', '再指一个 → 指定赢了（不会"既不算、又是它"）')
    const thenVeto = vetoCond(thenSpec, reader.read(thenSpec)[0])
    eq(reader.read(thenVeto)[0].cond, null, '再说不算 → 又回到否决')
  }

  /* ⑦ 回头路：清掉那个字段 → 回到按位置读（整条链一起清） */
  {
    const b = mk()
    const l = reader.read(b)[0]
    const next = specCond(b, l, condCard('k3'))
    const l2 = reader.read(next)[0]
    const cleared = clearCond(next, l2)
    eq(reader.read(cleared)[0].cond, null, '清掉之后回到按位置读（那撮字在板角，所以读不到）')
    eq(reader.read(cleared)[0].condManual, false, '痕迹也没了')
    eq(clearCond(b, l), b, '本来就没说过话 → 原样返回（不造新对象）')
    /* 挂在链里**别的**笔上时，也要清得掉（按整条链清） */
    const onOther = specCond(b, { strokeId: 'lk', ids: ['lk'] }, condCard('k3'))
    const chained = { ...onOther, strokes: onOther.strokes.map((s) => ({ ...s })) }
    const link2 = { strokeId: 'lk', ids: ['lk', 'f1'] }
    eq(clearCond(chained, link2).strokes.find((s) => s.id === 'lk').cond, undefined, '按整条链清（链里那一笔的话也一起清掉）')
  }

  /* ⑧ ★ 宣告的连接（`links[i]`）：它**没有那一笔**，条件只能住在记录上 ——
     存储层一直读得出、写得出这个字段，可从前三个写入口只看 `link.strokeId`，
     那个字段恒为 null → "点一下 ∈ 条件"是个静默 no-op（架构 review 候选 4）。
     下面这一族钉的就是"两族走同一道缝、各自住在自己家里"。 */
  const mkDeclared = () => {
    const b = mk()
    /* 把那条画出来的线**拿走**，改成一条宣告的记录（你连的） */
    b.strokes = b.strokes.filter((s) => s.id !== 'lk')
    b.links = [{ from: 'k1', to: 'k2', kind: 'derive' }]
    return b
  }
  {
    const b = mkDeclared()
    const l = reader.read(b)[0]
    eq([l.declared, l.strokeId, l.cond], [true, null, null], '基线：宣告的连接没有笔、也没有条件（位置读法对它不成立）')
    eq(linkKey(l), linkId('k1', 'k2'), '★ 它在界面上的身份 = 那条记录（不是恒为 null 的 strokeId）')
    eq(linkKey(reader.read(mk())[0]), 'lk', '画出来的那种身份 = 那一笔（同一对卡之间两条线才分得开）')

    /* 指一张卡 → 写进**记录**（不是某一笔） */
    const next = specCond(b, l, condCard('k3'))
    const rec = next.links.find((r) => r.from === 'k1' && r.to === 'k2')
    eq(rec.cond, 'card:k3', '★ 指一个条件 → 写在 `links[i].cond` 上（从前没有 writer，点了没反应）')
    eq(next.strokes.filter((s) => s.cond).length, 0, '一笔都没被碰（宣告的连接没有笔可挂）')
    const l2 = reader.read(next)[0]
    eq([l2.cond && l2.cond.id, l2.condSpec, l2.condManual], ['k3', { kind: 'card', id: 'k3' }, true], '读回来：条件 + "（你指的）" + 回头路')
    /* 链上那一步不再缺条件 */
    eq(deriveChains(reader.read(next))[0].steps[0].missing, false, '推导链上那一步补齐了（和画出来的那种一个效果）')
    eq(JSON.stringify(b.links), JSON.stringify([{ from: 'k1', to: 'k2', kind: 'derive' }]), '★ 原 board 没动（纯函数）')

    /* 指一撮字也认 */
    const inkSpec = specCond(b, l, condInk('f1'))
    eq(reader.read(inkSpec)[0].cond.kind, 'ink', '指一撮字 → 同样写在记录上（`ink:<笔 id>`）')
    eq(inkSpec.strokes.filter((s) => s.cond).length, 0, '  （还是没碰任何一笔）')

    /* 只有**那一条**记录被改（记录身份 = 两端那一对） */
    const twoRecs = { ...b, links: [{ from: 'k1', to: 'k2', kind: 'derive' }, { from: 'k2', to: 'k3', kind: 'cause' }] }
    const lA = reader.read(twoRecs).find((x) => x.a === 'k1')
    const one = specCond(twoRecs, lA, condCard('k3'))
    eq(one.links.map((r) => r.cond).filter(Boolean).length, 1, '两条记录里只有指的那一条被改')
    eq(one.links[1].cond, undefined, '  （另一条一个字节都没多）')

    /* 否决 / 回头路：同一批函数，落在同一个字段上 */
    const vetoed = vetoCond(b, l)
    eq(vetoed.links[0].cond, 'none', '不说算（`vetoCond`）也写在记录上')
    eq(reader.read(vetoed)[0].condManual, true, '读回来 condManual（面板要给一颗 ↺）')
    const cleared = clearCond(next, l2)
    eq(cleared.links[0].cond, undefined, '回头路：清掉记录上的那个字段（回到"这条连接没有条件"）')
    eq(reader.read(cleared)[0].cond, null, '  （读回来确实没有条件了）')
    eq(clearCond(b, l), b, '本来就没说过话 → 原样返回（不造新对象）')

    /* 指的东西没了 → 当没说过，而且**不留尸体**（和画出来的那种同一条纪律） */
    const gone = specCond(b, l, condCard('k9'))
    eq(reader.read(gone)[0].cond, null, '指的卡不在板上 → 当没说过')
    eq(reader.read(gone)[0].condManual, false, '  （也不留"你说过"的痕迹）')
    if (!/"cond"/.test(serializeBoardDocument(gone))) ok('死 id 不进文件（links 记录上也不留尸体）')
    else bad('文件里的 links 记录上写了一个已经不存在的 id')
    const round = parseBoardDocument(serializeBoardDocument(next), 'x')
    const roundRec = round.links.find((r) => r.from === 'k1' && r.to === 'k2')
    eq(roundRec && roundRec.cond, 'card:k3', '存 → 读 → 再存：记录上的那个条件往返还在')
    eq(reader.read(round)[0].cond.id, 'k3', '  （读回来还是那张卡）')
  }

  /* ⑧ 存盘往返 + 形状不认的值丢掉 */
  {
    const b = mk()
    const l = reader.read(b)[0]
    const next = specCond(b, l, condInk('f1'))
    const text = serializeBoardDocument(next)
    if (/"cond":\s*"ink:f1"/.test(text)) ok('落盘写的是 cond: "ink:f1"')
    else bad('落盘不对：' + (text.match(/"cond":[^,}]*/) || ['(没有 cond)'])[0])
    const back = parseBoardDocument(text, 'x')
    eq(back.strokes.find((s) => s.id === 'lk').cond, 'ink:f1', '读得回来')
    eq(reader.read(back)[0].cond.kind, 'ink', '重开之后仍然是你指的那撮字')
    /* 手改出来的怪值：丢掉，回到按位置读 */
    const dirty = mk()
    dirty.strokes = dirty.strokes.map((s) => (s.id === 'lk' ? { ...s, cond: 'card' } : s))
    const dirtyBack = parseBoardDocument(serializeBoardDocument(dirty), 'x')
    eq(dirtyBack.strokes.find((s) => s.id === 'lk').cond, undefined, '"card"（少了 id）不算一个说法 → 丢掉')
    const dirty2 = mk()
    dirty2.strokes = dirty2.strokes.map((s) => (s.id === 'lk' ? { ...s, cond: 'yes' } : s))
    eq(parseCond('yes'), null, '认不出的值 parseCond 给 null（读的时候当没说过）')
    if (!/"cond"/.test(serializeBoardDocument(dirty2))) ok('认不出的值也不会被写回文件')
    else bad('认不出的值被写回去了')
  }
}

// ═════════════════════ 6q. 宣告的连接 ═════════════════════
console.log('\n[6q] 宣告的连接（`links`）：两端 + 一个词，屏幕上那条线是应用画的')
{
  /* 见 ADR-0001：连接不再从笔迹形状/位置里猜，而是你**宣告**出来的。
     这一节钉三件事：
       · 存法（有序端点对、死端点不留尸体、自己连自己不算、同一个对只留一条）；
       · 读法（两族合一：画出来的 + 宣告的，形状一样、`declared` 区分）；
       · 几何（两端贴在**框/卡的边**上，框一动线跟着动 —— 这就是"连接两个板块"）。 */
  const mkCards = () => {
    const b = makeBoard()
    b.cards = [
      { ...newCard('note', 0, 0, { w: 200, h: 100 }), x: 0, y: 0, id: 'ka' },
      { ...newCard('note', 0, 0, { w: 200, h: 100 }), x: 600, y: 0, id: 'kb' },
    ]
    return b
  }

  /* ① 存法 */
  {
    const b = declareLink(mkCards(), 'ka', 'kb', 'cause')
    eq(b.links.length, 1, '连上两端 → 多了一条记录')
    eq(b.links[0], { from: 'ka', to: 'kb', kind: 'cause' }, '记录就是两端 + 一个词（没有 id、没有坐标）')
    eq(linkId('ka', 'kb'), 'ka|kb', '身份 = 有序端点对')
    eq(declareLink(b, 'ka', 'kb', 'derive'), b, '同一个有序对再连一次 → 原样返回（先有的那条赢）')
    eq(declareLink(b, 'ka', 'ka').links.length, 1, '自己连自己不算')
    eq(declareLink(b, 'ka', '没有这个').links.length, 1, '端点不存在 → 不算')
    const rev = declareLink(b, 'kb', 'ka', 'cause')
    eq(rev.links.length, 2, '反过来是**另一条**关系（「因果」有方向）')
    eq(setLinkKind(b, 'ka', 'kb', 'equiv').links[0].kind, 'equiv', '换个词（点线上那颗词调的就是它）')
    eq(setLinkKind(b, 'ka', 'kb', '不认识的词').links[0].kind, 'cause', '认不出的词 → 原样返回（不猜）')
    eq(removeLink(b, 'ka', 'kb').links.length, 0, '删掉这条连接')
    eq(removeLink(b, 'ka', '没有的').links, b.links, '删一条不存在的 → 原样返回')
    eq(linkOf(b, 'ka', 'kb').kind, 'cause', 'linkOf：问某两端之间那条')

    /* 存盘：只在真有时才写；死端点不留尸体；往返一致 */
    const text = serializeBoardDocument(b)
    eq(JSON.parse(text).links, [{ from: 'ka', to: 'kb', kind: 'cause' }], '文件里就是这两端 + 这个词')
    eq(parseBoardDocument(text, 'x').links, b.links, '存→读一致')
    if (!/links/.test(serializeBoardDocument(mkCards()))) ok('没连过的板一个 links 字段都不写（不造假 diff）')
    else bad('没连过的板里出现了 links')
    const deadEnd = serializeBoardDocument({ ...b, cards: b.cards.filter((c) => c.id !== 'kb') })
    if (!/"links"/.test(deadEnd)) ok('端点没了 → 那条记录不再写出去（不留尸体）')
    else bad('端点没了还写着 links')
    /* 手改文件写坏的值：认不出的词退回箭头工具的本意（因果），重复的丢掉 */
    const dirty = parseBoardDocument(
      JSON.stringify({ ...JSON.parse(text), links: [{ from: 'ka', to: 'kb', kind: '因果' }, { from: 'ka', to: 'kb', kind: 'equiv' }] }),
      'x'
    )
    eq(dirty.links, [{ from: 'ka', to: 'kb', kind: 'cause' }], '认不出的词退回默认；同一个对只留一条')
  }

  /* ①b 板框也能当端点（"两个板块之间连一笔"）*/
  {
    const b = mkCards()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 200, y: 300 }, { x: 240, y: 306 }])), id: 'p1' },
      { ...newStroke('pen', toFlat([{ x: 250, y: 300 }, { x: 290, y: 306 }])), id: 'p2' },
    ]
    b.frames = [{ id: 'f1', title: '第一节', ids: ['p1', 'p2'], cards: ['ka'] }]
    const linked = declareLink(b, 'f1', 'kb', 'cause')
    eq(linked.links.length, 1, '一个板框可以连一张卡')
    eq(parseBoardDocument(serializeBoardDocument(linked), 'x').links[0].from, 'f1', '框当端点也存得住')
    /* 框散了 → 那条记录跟着作废（不留一条指向空气的箭头） */
    const gone = serializeBoardDocument({ ...linked, frames: [] })
    if (!/"links"/.test(gone)) ok('板框散了 → 挂在它身上的连接一起消失')
    else bad('板框散了那条连接还在')
  }

  /* ② 读法：两族合一（画出来的 + 宣告的），形状一样、`declared` 区分 */
  {
    const b = mkCards()
    const declared = reader.read(declareLink(b, 'ka', 'kb', 'cause'))
    eq(declared.length, 1, 'reader 读得出宣告的连接')
    const d = declared[0]
    eq([d.declared, d.strokeId, d.ids.length, d.manual, d.headInk], [true, null, 0, true, false], '它没有那一笔：declared=true、manual=true、尖由应用合成')
    eq([d.a, d.b, d.aKind, d.bKind], ['ka', 'kb', 'card', 'card'], '两端和它们的种类')
    eq([d.kind, d.dir, d.shape], ['cause', true, 'arrow'], '词从记录里来（不是读形状读出来的）')
    eq(d.id, 'ka|kb', '身份就是有序端点对（面板/React key 都用它）')
    /* 两族同时存在：一条画的 + 一条宣告的。
       画的那条必须**真的从一张卡里进到另一张卡里**（两头都在卡里 = 铁定是连接，不看形状）。 */
    const both = { ...b, strokes: [{ ...newStroke('pen', toFlat([{ x: 20, y: 50 }, { x: 780, y: 50 }])), id: 'ln' }] }
    const all = reader.read(declareLink(both, 'ka', 'kb', 'derive'))
    eq(all.length, 2, '画出来的那条 + 宣告的那条，两条都在')
    eq(all.filter((l) => l.declared).length, 1, '其中只有一条是宣告的')
    eq(all.filter((l) => !l.declared && l.strokeId === 'ln').length, 1, '另一条仍然是那一笔画出来的')
  }

  /* ③ 几何：两端贴在框/卡的**边**上（不是中心），而且框一动线跟着动 */
  {
    const b = declareLink(mkCards(), 'ka', 'kb', 'cause')
    const l = reader.read(b)[0]
    near(l.from.x, 200, 0.01, '起点贴在左边那张卡的右边上（x=200，不是中心 100）')
    near(l.from.y, 50, 0.01, '起点在竖直方向的中间')
    near(l.to.x, 594, 0.01, '尖停在右边那张卡的左边再让开 6px（600-6）')
    /* 把右边那张卡挪远 → 线自己跟着变长（这就是"箭头跟着板块走"） */
    const moved = { ...b, cards: b.cards.map((c) => (c.id === 'kb' ? { ...c, x: 900 } : c)) }
    const l2 = reader.read(moved)[0]
    near(l2.to.x, 894, 0.01, '卡一挪，尖跟着跑到新位置（连接是"两个板块之间"，不是一条死路径）')
    /* 那条线带一点点弧度（LINK_BOW 5%）：控制点在中点 + 法线方向让开 5% × 两端距离 */
    near(l.ctrl.y, 50 + (594 - 200) * 0.05, 0.01, '控制点让开 5%（"像画出来的一笔"，但仍是两点之间那条线）')
    near(l.mid.y, 50 + (594 - 200) * 0.05 * 0.5, 0.01, '词放在**曲线的**中点上（Q(0.5)），不是两端的中点')
    /* 尖的方向 = 末端切线（控制点 → 端点），不是两端连线 */
    const straight = (Math.atan2(l.to.y - l.from.y, l.to.x - l.from.x) * 180) / Math.PI
    near(Math.abs((l.angle * 180) / Math.PI - straight), 5.71, 0.05, '带弧度时尖比两端连线偏 5.7°（切线，不是连线）')
    /* 两端互换（反向宣告）→ 尖换一头 */
    const rev = reader.read(declareLink(mkCards(), 'kb', 'ka', 'cause'))[0]
    eq(Math.abs((rev.angle * 180) / Math.PI) > 90, true, '反过来宣告 → 尖在另一头（朝左）')
    eq(rev.a === 'kb' && rev.b === 'ka', true, '记录的方向也反过来了')
    /* 端点没了（内存里的中间态）→ 这一帧不画，绝不画一条指向空气的箭头 */
    eq(reader.read({ ...b, cards: b.cards.filter((c) => c.id !== 'kb') }).filter((x) => x.declared).length, 0, '端点没了 → 不画那条连接')
  }

  /* ④ 框选命中（"留下板框"圈到哪些东西）：笔迹碰着就算、卡片要中心落在框里 */
  {
    const b = mkCards()
    b.strokes = [
      { ...newStroke('pen', toFlat([{ x: 300, y: 300 }, { x: 320, y: 320 }])), id: 'in' },
      { ...newStroke('pen', toFlat([{ x: 900, y: 900 }, { x: 920, y: 920 }])), id: 'out' },
    ]
    const got = membersInBox(b, { x0: 250, y0: 250, x1: 400, y1: 400 })
    eq(got.ids, ['in'], '圈里的笔迹被圈到、圈外的不算')
    eq(got.cards, [], '卡片只是碰着一条边不算（中心得落在框里）')
    const got2 = membersInBox(b, { x0: -50, y0: -50, x1: 500, y1: 200 })
    eq(got2.cards, ['ka'], '卡片中心在框里 → 算')
    eq(membersInBox(b, null), { ids: [], cards: [] }, '没框 → 什么都圈不到（不是 undefined）')
  }
}

// ═════════════════════ 6r. 端点（nodes.js） ═════════════════════
console.log('\n[6r] 端点（`nodes.js`）：谁算端点、这一点落在谁身上、三个半径各是什么')
{
  /* 为什么单开一节（2026-09-17 架构 review 候选 2）：ADR-0001 把"谁是端点"定成核心一句话，
     可它被写在**五个地方**、三个半径各写各的。这一节钉的是那个 module 的接口，
     以及"三处判据必须一致"这条纪律（漏一处是静默失效，不是崩溃）。 */
  const b = makeBoard()
  b.cards = [
    { ...newCard('formula', 0, 0, { w: 100, h: 60 }), x: 0, y: 0, id: 'ka' },
    { ...newCard('formula', 0, 0, { w: 100, h: 60 }), x: 400, y: 0, id: 'kb' },
  ]
  /* 一个包住 ka 的板框（成员就是 ka）—— 用来验"进框时卡片优先于板框" */
  b.frames = [{ id: 'fa', title: '第一节', ids: [], cards: ['ka'] }]

  const { cards, frames } = nodeList(b)
  eq(cards.length, 2, '端点数：两张卡')
  eq(frames.length, 1, '端点数：一个板框')
  eq(frames[0].label, '第一节', '板框的显示名 = 你起的标题')
  eq(cards[0].label, '', '卡片的显示名是空的（屏上不写字）')
  {
    const b2 = { ...b, frames: [{ id: 'fb', ids: [], cards: [] }] }
    eq(nodeList(b2).frames.length, 0, '成员全没了的板框**不是**端点（绝不画指向空气的箭头）')
    eq(nodeById(b2, 'fb'), null, '按 id 取它也是 null')
  }

  /* 进框：卡片在前 → 卡片赢（它更具体：一张卡可以落在板框里） */
  eq(nodeAt(b, { x: 50, y: 30 })?.id, 'ka', '这一点落在谁身上：卡片优先于板框（这一点两个框都包着）')
  eq(nodeAt(b, { x: 50, y: 30 }, { kinds: ['frame'] })?.id, 'fa', '只要板框时，同样这一点就是那个框')
  eq(nodeAt(b, { x: 900, y: 900 }), null, '哪儿都不在框里、又不给半径 → null')
  /* 板框的包围盒会把卡包住，量"宽容/半径"的边界得用一张只有卡的板（不然框先接住） */
  const bare = { ...b, frames: [] }
  eq(nodeAt(bare, { x: 105, y: 30 }), null, '严格模式：卡框外 5px 还不算（不给 pad/radius）')
  eq(nodeAt(bare, { x: 105, y: 30 }, { pad: CARD_HIT_PAD })?.id, 'ka', `免费路：CARD_HIT_PAD=${CARD_HIT_PAD} 之内算碰到`)
  eq(nodeAt(bare, { x: 109, y: 30 }, { pad: CARD_HIT_PAD }), null, '超出这个宽容就不算（边界是硬的）')
  eq(nodeAt(bare, { x: 105, y: 30 }, { radius: ARROW_SNAP })?.id, 'ka', `吸附半径 ARROW_SNAP=${ARROW_SNAP}：离边 5px 也算吸上`)
  eq(nodeAt(bare, { x: 139, y: 30 }, { radius: ARROW_SNAP })?.id, 'ka', '离边 39px 还在吸附半径里')
  eq(nodeAt(bare, { x: 141, y: 30 }, { radius: ARROW_SNAP }), null, '离边 41px 就吸不上了')
  eq(nodeAt(bare, { x: 163, y: 30 }, { radius: COND_SEARCH })?.id, 'ka', `条件半径 COND_SEARCH=${COND_SEARCH} 比吸附宽（离边 63px 也算）`)
  eq(nodeAt(b, { x: 105, y: 30 }, { radius: ARROW_SNAP })?.id, 'fa', '板框也算端点：这一点在框的包围盒里 → 框接住')

  /* exclude（条件要跳过这条关系自己的两端）与 kinds */
  eq(nodeAt(b, { x: 0, y: 0 }, { exclude: ['ka'] })?.id, 'fa', 'exclude 跳过的那一个不算，退到下一个')
  eq(nodeAt(b, { x: 0, y: 0 }, { kinds: ['card'], exclude: ['ka'] }), null, '只找卡片 + 跳过它 → 没东西')
  eq(nodeAt(b, { x: 0, y: 0 }, { kinds: ['card'] })?.kind, 'card', 'kinds 只找卡片')

  /* ★ 这条是"一处判据"的硬判据：**点→框**那条公式在 module 里只有一份 */
  near(edgeDist({ x: 0, y: 0, w: 100, h: 60 }, { x: 110, y: 30 }), 10, 1e-9, '点到框边的距离：框外 10 → 10')
  eq(edgeDist({ x: 0, y: 0, w: 100, h: 60 }, { x: 50, y: 30 }), 0, '点在框里 → 0')
  near(edgeDist({ x: 0, y: 0, w: 100, h: 60 }, { x: 103, y: 64 }), 5, 1e-9, '斜着出去也按两条边算（3-4-5）')
  eq(JSON.stringify(edgePointOf({ x: 0, y: 0, w: 100, h: 60 }, { x: 300, y: 30 })), JSON.stringify({ x: 100, y: 30 }), '边点：正右方打在右边中点')
  eq(JSON.stringify(edgePointOf({ x: 0, y: 0, w: 100, h: 60 }, { x: 50, y: -300 })), JSON.stringify({ x: 50, y: 0 }), '边点：正上方打在上边中点')

  /* ★ 卡片转过之后的边点（2026-09-21）：箭头要**打在卡片的边上**。
     判据的对手盘是"拿 AABB 求边点"那条错路 —— 一张 100×60 的卡绕中心转 90° 之后
     外接框是 60×100，拿它去求"正右方"的边点会落在 x=130（卡片实际只到 80），
     屏幕上就是尖端停在离卡片还有 50px 的空中。 */
  {
    const rect = { x: 0, y: 0, w: 100, h: 60, cx: 50, cy: 30, rot: Math.PI / 2 }
    const p = edgePointOf(rect, { x: 300, y: 30 })
    near(p.x, 80, 0.01, '★ 转 90° 的卡：正右方的边点打在 80（半高 30 那一侧），不是外接框的 130')
    near(p.y, 30, 0.01, '  …竖直方向仍在中心')
    const q = edgePointOf(rect, { x: 50, y: -300 })
    near(q.y, -20, 0.01, '  …正上方的边点打在 −20（半宽 50 那一侧）')
    /* 没转时和从前**逐位一致**（老路径一个像素都不动）。 */
    eq(JSON.stringify(edgePointOf({ x: 0, y: 0, w: 100, h: 60, rot: 0 }, { x: 300, y: 30 })), JSON.stringify({ x: 100, y: 30 }), '  （rot=0 时和从前一模一样）')
    /* nodeList 交出来的卡片带着 `rect`（转过的那个）—— 渲染端就是靠它打准的。 */
    const turned = { ...b, cards: [{ ...b.cards[0], rot: Math.PI / 2 }, b.cards[1]] }
    const n0 = nodeList(turned).cards[0]
    near(n0.rect.rot, Math.PI / 2, 1e-9, '  …nodeList 给卡片带上没转的那个 rect（含 rot）')
    near(n0.box.w, 60, 0.01, '  …而 box 仍然是外接框（进框判定/关系吃它）')
  }

  /* ★★ "三处判据一致"：宣告 / 解析 / 写盘 对同一个死 id 必须说同一句话 */
  {
    const live = liveNodeIdFn(new Set(['ka']), new Set(['fa']))
    if (live('ka') && live('fa') && !live('死掉了')) ok('存活判据：卡片 / 板框都活，别的都不算')
    else bad('liveNodeIdFn 判错了')
    const ids = [...liveNodesOf(b)].sort().join(',')
    eq(ids, 'fa,ka,kb', 'liveNodesOf(board) = 卡片 + 板框（另一处调用的同一个判据）')
    /* 宣告：端点是死 id → 原样返回（不留半条记录） */
    eq(declareLink(b, 'ka', '死掉了'), b, '宣告：一头是死 id → 一个字节都不改')
    /* 解析 / 写盘：同一对 id 必须一起被丢掉（漏一处就是"内存里有、文件里没有"） */
    const withDead = { ...b, links: [{ from: 'ka', to: '死掉了', kind: 'cause' }, { from: 'ka', to: 'kb', kind: 'cause' }] }
    const parsed = parseBoardDocument(serializeBoardDocument(withDead), 'x')
    eq(parsed.links.length, 1, '写盘：死 id 那条不留尸体（只剩活着的那一对）')
    eq(parsed.links[0].from + '→' + parsed.links[0].to, 'ka→kb', '活下来的正是两端都活着的那条')
  }
}

// ═════════════════════ 6s. 撤销账本 ═════════════════════
console.log('\n[6s] 撤销账本（`history.js`）：一次手势 = 一步，判据只有"和起点同一个样"')
{
  /* 为什么单开一节（2026-09-17 架构 review 候选 3）：同一段账（裁到 UNDO_MAX / 清重做 /
     报数）从前在**四条手势**里各抄了一遍，而"这算不算动过"四个判据各写各的；
     四条里只有"拖板框"有 Ctrl+Z 断言 —— 另外三条忘了清重做、或者忘了裁，
     屏幕上没有任何东西会响。这个 module 不认识 React、也不认识"板"是什么，
     所以拿一对假 adapter 就能把整族钉住（真鼠标那半边在 check-link 的 [15]）。 */
  function fake(init, opts = {}) {
    const box = { cur: init, counts: [] }
    const led = createHistory({
      get: () => box.cur,
      write: (next) => {
        box.cur = next
      },
      onCount: (c) => box.counts.push(c),
      ...opts,
    })
    return { box, led }
  }

  /* ① "没动"的判据：数字按 eps（世界像素）比，别的精确比 */
  if (sameWithin({ a: 1 }, { a: 1.4 }, MOVE_EPS)) ok(`差 0.4（≤ MOVE_EPS=${MOVE_EPS} 世界像素）算没动`)
  else bad('eps 之内应该算"没动"')
  if (!sameWithin({ a: 1 }, { a: 1.6 }, MOVE_EPS)) ok('差 0.6 就是动了')
  else bad('eps 之外必须算"动了"')
  if (!sameWithin({ a: [1, 2] }, { a: [1, 2, 3] })) ok('数组变长了就是动了')
  else bad('数组长度不一样必须算"动了"')
  if (!sameWithin({ a: 'x' }, { a: 'y' })) ok('字符串 / 布尔精确比')
  else bad('字符串不该按"差不多"算')
  if (!sameWithin({ a: true }, { a: 1 })) ok('true 和 1 不是同一个样（不按 JS 的真值比）')
  else bad('类型不同必须算"动了"')
  if (sameWithin({ a: 1, b: undefined }, { a: 1 })) ok('`{ b: undefined }` 和"没有 b"是同一个样（板是 spread 出来的）')
  else bad('undefined 的键和缺键该算同一个样')
  if (!sameWithin({ a: 1 }, { a: 1, b: 2 })) ok('多出一个有值的键就是动了')
  else bad('多一个键必须算"动了"')

  /* ② 一步到位的改动（画一笔 / 删一张卡） */
  {
    const { box, led } = fake({ v: 1 })
    eq(led.step({ v: 2 }), true, 'step：改了板')
    eq(box.cur.v, 2, 'step：写进去了')
    eq(led.counts(), { undo: 1, redo: 0 }, 'step：记一步')
    eq(led.step((cur) => cur), false, 'step：返回同一个引用 → 什么都不做')
    eq(led.counts(), { undo: 1, redo: 0 }, '  （"什么都没发生"不占一步撤销）')
  }

  /* ③ 一次手势 = 一步（中途多少帧都只算一步） */
  {
    const { box, led } = fake({ v: 1 })
    const g = led.begin()
    g.during({ v: 1.2 })
    g.during({ v: 9 })
    eq(g.end(), true, '手势收尾：真的动了 → 记一步')
    eq(led.counts(), { undo: 1, redo: 0 }, '★ 中途两帧 + 收尾一次 → **只记一步**')
    led.undo()
    eq(box.cur.v, 1, '撤销回到"按下那一刻"那一版板')
    eq(led.counts(), { undo: 0, redo: 1 }, '撤销之后重做栈里有一步')
    led.redo()
    eq(box.cur.v, 9, '重做回到松手那一版')
    eq(led.counts(), { undo: 1, redo: 0 }, '重做之后又回到撤销栈里')
  }

  /* ④ 判"没动"的三种现场（从前是三个判据 / 一个手写标记） */
  {
    const { led } = fake({ cards: [{ id: 'a', x: 0, y: 0 }] })
    const g = led.begin()
    /* 点一下：拖动那条路照样会提交一版**新对象**，数字一个没变 */
    g.during((cur) => ({ ...cur, cards: cur.cards.map((c) => ({ ...c })) }))
    eq(g.end(), false, '点一下没拖（板重建了一版、数字一个没变）→ 不记一步')
    eq(led.counts().undo, 0, '  （撤销栈里没有空操作 —— 这就是从前那个 `moved` 标记在管的事）')
  }
  {
    const { led } = fake({ cards: [{ id: 'a', x: 0, y: 0 }] })
    const g = led.begin()
    g.during({ cards: [{ id: 'a', x: 0.3, y: -0.2 }] })
    eq(g.end(), false, `手抖 0.3 世界像素（≤ ${MOVE_EPS}）不算动过`)
    eq(led.counts().undo, 0, '  （从前的卡片拖动就是按 0.5 判的，现在只有这一处判）')
  }
  {
    const { led } = fake({ cards: [{ id: 'a', x: 0, y: 0 }] })
    const g = led.begin()
    g.during({ cards: [{ id: 'a', x: 50, y: 0 }] })
    g.during({ cards: [{ id: 'a', x: 0, y: 0 }] })
    eq(g.end(), false, '拖出去又拖回原点 → 不记（按了 Ctrl+Z 也什么都看不出来）')
  }
  {
    const { led } = fake({ v: 1 })
    const g = led.begin()
    g.during((cur) => cur)
    eq(g.end(), false, '一次手势里"每帧都返回同一个引用"→ 不记')
    eq(g.end(), false, '★ end 只算一次（连着调两次不会记两步）')
    eq(led.counts().undo, 0, '  （撤销栈还是空的）')
  }

  /* ⑤ 账本自己那两条纪律：裁到 max、新的一步清掉重做 */
  {
    const { box, led } = fake({ v: 0 }, { max: 3 })
    for (let i = 1; i <= 5; i++) led.step({ v: i })
    eq(led.counts().undo, 3, '账本裁到 max=3（最老的两步被丢掉）')
    led.undo()
    led.undo()
    led.undo()
    eq(box.cur.v, 2, '裁掉之后撤到底 = 第 3 步之前那一版（不是最初的 1）')
    eq(led.undo(), false, '空栈时再撤销：返回 false（不抛、不改板 —— 按钮靠 counts() 置灰）')
    eq(box.cur.v, 2, '  （板没被动过）')
    eq(led.redo(), true, '空撤销栈也不影响重做（还能往前）')
  }
  {
    const { led } = fake({ v: 0 })
    led.step({ v: 1 })
    led.step({ v: 2 })
    led.undo()
    eq(led.counts(), { undo: 1, redo: 1 }, '撤销一步 → 有一步可以重做')
    led.step({ v: 9 })
    eq(led.counts(), { undo: 2, redo: 0 }, '★ 新的一步把重做清掉（从前这条没有任何断言，忘了清也没人响）')
  }

  /* ⑥ 只改板、不记账（连续手势的中途 / 量尺寸那一趟）与换文件归零 */
  {
    const { box, led } = fake({ v: 0 })
    eq(led.apply({ v: 5 }), true, 'apply：只改板')
    eq(box.cur.v, 5, '  （写进去了）')
    eq(led.counts(), { undo: 0, redo: 0 }, 'apply：不记账')
    eq(led.apply((cur) => cur), false, 'apply：同一个引用 → 返回"没改"')
    led.step({ v: 6 })
    led.reset()
    eq(led.counts(), { undo: 0, redo: 0 }, 'reset：换了一份板 → 账本归零（两个栈都清）')
    eq(led.undo(), false, '归零之后没有东西可撤')
  }
}

// ═════════════════════ 6t. 焦点仲裁 ═════════════════════
console.log('\n[6t] 焦点仲裁（`focus.js`）：焦点是一个值、按键该谁管是纯函数')
{
  /* 为什么单开一节（2026-09-17 架构 review 候选 7）：焦点从前是四个 useState，
     "它们互斥"这条不变量**没有人写下来**（靠二十处 ad hoc 的 if），Delete 的含义是一个
     表达式 `selectedFrameId && !inkSel && !selectedId`，而"面板上的按键"和"纸面上的按键"
     只靠一条 `/^(INPUT|TEXTAREA)$/` 区分 —— 点一下关系面板里那一行再按 Backspace
     会把板框拆开（review 当场走到的那个 bug）。这一节钉住那个值、那些转移、和那张表。 */

  /* ① 一个值：不可能"同时选中两样"（互斥是**结构**，不是约定） */
  eq(FOCUS_NONE.kind, 'none', '空焦点')
  eq(focusCard('k1'), { kind: 'card', id: 'k1', editing: false }, '选中一张卡')
  eq(focusCard('k1', true), { kind: 'card', id: 'k1', editing: true }, '在编辑那张卡（编辑态挂在焦点上）')
  eq(focusFrame('f1'), { kind: 'frame', id: 'f1', editing: false }, '选中一个板框')
  eq(focusInk(['s1', 's2']), { kind: 'ink', ids: ['s1', 's2'] }, '框住两笔')
  eq(focusInk([]), FOCUS_NONE, '什么也没框住 → 空焦点（不是"空的墨迹选中"）')
  eq(focusCard(null), FOCUS_NONE, '给个 null 也是空焦点（调用方不用先判）')
  {
    const f = focusCard('k1', true)
    eq([focusCardId(f), focusFrameId(f), focusInkIds(f)], ['k1', null, null], '焦点在卡片上：板框 / 墨迹那两个问题都是 null')
    eq([editingCardId(f), editingFrameId(f)], ['k1', null], '  （编辑态也只属于卡片那一种）')
    const g = focusFrame('f9', true)
    eq([focusCardId(g), focusFrameId(g), editingFrameId(g)], [null, 'f9', 'f9'], '焦点在板框上：另外那几个问题都是 null')
  }

  /* ② 转移都是纯的（不动原值） */
  {
    const f = focusCard('k1')
    const e = beginEdit(f)
    eq([f.editing, e.editing], [false, true], 'beginEdit：原值没动、新值是编辑态')
    eq(endEdit(e), { kind: 'card', id: 'k1', editing: false }, 'endEdit：退出编辑、焦点留着')
    eq(clearInkFocus(focusInk(['s1'])), FOCUS_NONE, 'clearInkFocus：墨迹那一种清掉')
    eq(clearInkFocus(f), f, 'clearInkFocus：卡片那种**原样返回**（那几处从前就只清 inkSel，不改行为）')
  }

  /* ③ 假 target：模块只用 tagName / isContentEditable / closest 三样（所以这儿的断言是纯的） */
  const el = (tag, inside = false) => ({
    tagName: tag,
    isContentEditable: false,
    closest: (sel) => (inside && sel === PAPER_SELECTOR ? {} : null),
  })
  const fakePanel = el('BUTTON', false) // 关系面板里那一行 / 工具条上的按钮
  const fakeCanvas = el('CANVAS', true)
  const fakeBody = el('BODY', true)
  if (onPaper(fakeCanvas) && onPaper(fakeBody) && !onPaper(fakePanel)) ok('冲纸面还是冲面板：画布 / body 算纸面，面板上的按钮不算')
  else bad('onPaper 判错了')
  eq(onPaper(null), true, '  （没有 target：当成纸面）')
  if (isTextField(el('INPUT')) && !isTextField(fakeCanvas)) ok('输入框算"正在打字"（那些快捷键要放行）')
  else bad('isTextField 判错了')
  eq(onPaper({ tagName: 'INPUT', isContentEditable: false, closest: () => ({}) }), false, '  （输入框即使在画布里也不算纸面按键）')

  /* ④ ★ 删除那张表：Delete / Backspace → 该谁管、管什么 */
  {
    const k = (focus, key = 'Delete', target = fakeCanvas) => deleteIntent(focus, key, target)
    eq(k(FOCUS_NONE), { kind: 'none' }, '没选中任何东西 → 不管')
    eq(k(focusCard('k1')), { kind: 'delete-card', id: 'k1' }, '焦点在卡片上 → 删那张卡')
    eq(k(focusInk(['s1', 's2'])), { kind: 'delete-ink', ids: ['s1', 's2'] }, '焦点在一撮笔上 → 删那几笔')
    eq(k(focusFrame('f1')), { kind: 'dissolve-frame', id: 'f1' }, '焦点在板框上 → 拆开那个框（框还在、内容不动）')
    eq(k(focusCard('k1'), 'x'), { kind: 'none' }, '不是删除键 → 不管')
    /* ★★ 就是那个 bug：面板上的 Backspace 不该动板上的东西 */
    eq(k(focusFrame('f1'), 'Backspace', fakePanel), { kind: 'none' }, '★ 焦点在面板上（不是冲纸面）→ 一个字节都不动')
    eq(k(focusCard('k1'), 'Delete', fakePanel), { kind: 'none' }, '  （卡片同理：面板上的 Delete 不算）')
    eq(k(focusInk(['s1']), 'Backspace', fakeBody), { kind: 'delete-ink', ids: ['s1'] }, '  （body / 画布上的照样算）')
    /* ★ 互斥是结构："先看谁"不用再排先后（同一个键 + 同一个焦点只有一个答案） */
    eq(deleteIntent(focusFrame('f1'), 'Delete', fakeCanvas).kind, 'dissolve-frame', '同一个键在同一个焦点上只有一个答案（没有"三个分支各查一个子集"）')
  }

  /* ⑤ Esc：一次只收一层，顺序写在一处 */
  {
    const esc = (ui) => escapeIntent(ui).kind
    /* ⚠ 这里原来还有一条「武装着条件 → 先收武装」（'disarm-cond'）——
       它唯一的入口是关系面板，面板 2026-09-19 删掉了，focus.js 那一层也删了。 */
    eq(esc({ focus: focusFrame('f1', true) }), 'end-frame-edit', '正在给板框改名 → 先收编辑（别顺手把框也取消）')
    eq(esc({ focus: focusCard('k1') }), 'clear-focus', '选着一张卡 → 取消焦点')
    eq(esc({ focus: focusInk(['s1']) }), 'clear-focus', '框着一撮笔 → 取消焦点')
    eq(esc({ focus: FOCUS_NONE }), 'none', '什么都没有 → 不管（别 preventDefault 白吞按键）')
    eq(esc({ focus: FOCUS_NONE, linkPick: { strokeId: 's1' } }), 'dismiss-link', '浮着那排词 → 先收词')
  }

  /* ⑥ ★ 静态读一遍 Board.jsx：那五个 setState 不许回来（互斥靠结构，不靠二十处 if）。
     ⚠ 先把注释剥掉再找 —— 注释里提到这些名字是**好事**（讲历史），
       而"代码里又用回老状态"才是要挡的（第一次跑这条就栽在我自己写的注释上）。 */
  {
    const src = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const back = ['setSelectedId', 'setInkSel', 'setSelectedFrameId', 'setEditingId', 'setFrameEditId'].filter((w) => code.includes(w))
    if (!back.length) ok('★ Board.jsx 里没有那五个 setState 了（焦点只有一个值）')
    else bad(`Board.jsx 里又出现了：${back.join(' / ')} —— 焦点该只有 focus 一个值（见 focus.js）`)
    if (/const \[focus, setFocus\] = useState/.test(src)) ok('  （焦点就是 focus 那一个 useState）')
    else bad('Board.jsx 里找不到 focus 那个 useState')
  }
}

// ═════════════════════ 6q. data/ 里的路径（分层） ═════════════════════
/* 这一节钉的是**"什么名字能落到 data/ 里"**，以及"一串路径怎么摆成左栏那棵树"。
 * 为什么值得单独一节：分层存储真正的危险不是"显示错了"，而是**写错地方** ——
 * 一个没挡住的名字能跑到 data/ 外面去（`../../.ssh/authorized_keys` 那条老路）。
 * 所以判据分两半：
 *   ① 合法性：该拒的一个都不能放（穿越 / 绝对路径 / 盘符 / Windows 存不出来的字符）；
 *   ② 展开：该拆的对（parentPath / levels / isUnder），不然后端挡得住、前端还是会摆错。
 * 端到端对手是 `npm run check:storage`（真服务、真写盘，跑在临时目录里）。 */
console.log('\n[6u] data/ 里的路径（`paths.js`）：什么样的名字能落进 data/')
{
  /* ① 合法的 */
  eq(normalizeRel('board-x.md'), 'board-x.md', '老样子：根上一张板')
  eq(normalizeRel('大物/电磁学/board-第一章.md'), '大物/电磁学/board-第一章.md', '分层路径原样通过')
  eq(normalizeRel('大物\\电磁学\\board-1.md'), '大物/电磁学/board-1.md', '反斜杠归一成斜杠（浏览器/手打都可能是它）')
  eq(normalizeRel('a//b.md'), 'a/b.md', '空段丢掉（多打一个斜杠不算错）')
  eq(normalizeRel('大物/电磁学', { file: false }), '大物/电磁学', '{ file: false } 时最后一段可以不是 .md（目录）')
  eq(normalizeRel('大物/电磁学'), null, '不给 { file: false } 时，目录看着就是"没写 .md 的文件" → 拒')
  eq(normalizeRel('  board-x.md  '), 'board-x.md', '两头空白不算内容（整体 trim）')
  eq(normalizeRel('第一章 静电场.md'), '第一章 静电场.md', '名字里可以有空格（只要不在两头）')

  /* ② 该拒的（一个都不能放） */
  eq(normalizeRel('../evil.md'), null, '穿越：../ 一律拒')
  eq(normalizeRel('大物/../../evil.md'), null, '中间夹着的 .. 也拒')
  eq(normalizeRel('/etc/passwd.md'), null, '绝对路径拒')
  eq(normalizeRel('C:/Users/x.md'), null, 'Windows 盘符拒')
  eq(normalizeRel('a/b'), null, '文件必须以 .md 结尾（不然列表里混进别的格式）')
  eq(normalizeRel(''), null, '空路径拒')
  eq(normalizeRel(null), null, '不是字符串拒（服务端收的是 JSON，什么都可能传进来）')
  eq(normalizeRel('a/b:c.md'), null, '冒号拒（Windows 存不出来）')
  eq(normalizeRel('a/ *?.md'), null, '通配符拒')
  eq(normalizeRel('x'.repeat(90) + '.md'), null, `一段超过 ${MAX_SEGMENT} 个字拒`)
  eq(normalizeRel(Array(MAX_DEPTH + 5).fill('d').join('/') + '/x.md'), null, `超过 ${MAX_DEPTH} 层拒（左栏缩进会缩成一条缝）`)
  if (!isSafeSegment('..')) ok('isSafeSegment 认得 .. 不是一段合法名字')
  if (isSafeSegment(' a')) bad('isSafeSegment 放过了两头有空白的段（Windows 会把空白悄悄吃掉，名字就对不上了）')
  else ok('两头有空白的段拒（Windows 会悄悄吃掉空白，名字对不上）')

  /* ③ 修（只给"用户手打的名字"这一侧）：坏字符换 -、补 .md、但穿越**两个都不修** */
  eq(sanitizeRel('第一章?（上）'), '第一章-（上）.md', 'sanitize：坏字符换 `-`，没写 .md 就补上')
  eq(sanitizeRel('大物/电磁学/第一章'), '大物/电磁学/第一章.md', 'sanitize：路径照拆')
  eq(sanitizeRel('../../etc/passwd'), null, 'sanitize 遇到 .. 也是 null —— 修它等于**猜**用户想写到哪儿')
  eq(normalizeRel('../../etc/passwd'), null, '同一个名字走 normalize：一样拒（收请求那一侧更不许修）')

  /* ④ 拆 / 拼 —— 前端摆树全靠这几个，错了树就摆错 */
  eq(parentPath('大物/电磁学/board-1.md'), '大物/电磁学', 'parentPath')
  eq(parentPath('board-1.md'), '', '根上的文件 → 目录是空串（不是 "/"）')
  eq(baseName('大物/电磁学/board-1.md'), 'board-1.md', 'baseName')
  eq(pathTitle('大物/电磁学/board-1.md'), 'board-1', 'pathTitle：左栏那一行显示的字（不含 .md）')
  eq(splitPath('a/b/c.md'), ['a', 'b', 'c.md'], 'splitPath')
  eq(joinPath('a', 'b', 'c.md'), 'a/b/c.md', 'joinPath')
  eq(joinPath('', 'a.md'), 'a.md', 'joinPath 根上：不能拼出 /a.md（那样树里会多一个空名字的节点）')
  eq(levels('大物/电磁学'), ['大物', '大物/电磁学'], 'levels：一层层往下（目录用它来展开）')
  eq(levels('大物/电磁学/board-1.md'), ['大物', '大物/电磁学', '大物/电磁学/board-1.md'], 'levels 连自己那一层也算上')
  eq(ancestors('大物/电磁学/board-1.md'), ['大物', '大物/电磁学'], 'ancestors = levels(所在目录)：打开它时要展开哪几层')
  if (isUnder('大物/电磁学/board-1.md', '大物/电磁学')) ok('isUnder：文件在那一层里')
  else bad('isUnder 判错（它是拖拽/移动"不许挪进自己肚子里"那条闸）')
  if (isUnder('大物/电磁学/board-1.md', '大物/电磁')) bad('isUnder 把"前缀一样但不是一层"算成了包含')
  else ok('isUnder 不认前缀：`大物/电磁` 不是 `大物/电磁学` 的上一层')
  if (isUnder('a/b.md', '')) ok('根目录包含一切（拖回根上那条路）')
  else bad('isUnder 对空目录判错了')

  /* ⑤ 摆成树 + 剪枝：左栏两个模式各看各的，空目录留着（那是"等着往里放东西"的那一层） */
  {
    const files = ['board-示例.md', '大物/电磁学/board-第一章.md', '大物/电磁学/打卡.md', '大物/力学/board-1.md']
    const folders = ['大物', '大物/电磁学', '大物/力学', '空目录', '大物/电磁学/第三章']
    const tree = buildFolderTree(files, folders)
    eq(tree.path, '', '根节点的 path 是空串')
    eq(tree.files.map((f) => f.name), ['board-示例.md'], '根上的文件挂在根节点上')
    eq(tree.dirs.map((d) => d.name), ['大物', '空目录'], '第一层目录按名字排好（空目录也在）')
    const em = tree.dirs.find((d) => d.name === '大物').dirs.find((d) => d.name === '电磁学')
    eq(em.files.length, 2, '两层深的目录里：两张板/笔记都挂对了')
    const boardOnly = pruneTree(tree, (f) => isBoardName(f.name))
    const noteOnly = pruneTree(tree, (f) => !isBoardName(f.name))
    eq(boardOnly.files.length, 1, '白板模式：根上那张板留着')
    eq(noteOnly.files.length, 0, '笔记模式：根上那张板不显示')
    /* 空目录（`data/空目录/`）两个模式都留着 —— 那是"刚建出来、等着往里放东西"的那一层，
       剪掉它用户就没法把东西放进去了。判据是"它下面一个文件都没有"，不是"它曾经存在过"。 */
    eq(boardOnly.dirs.map((d) => d.name), ['大物', '空目录'], '白板模式：空目录留着')
    eq(noteOnly.dirs.map((d) => d.name), ['大物', '空目录'], '笔记模式：空目录也留着')
    const li = boardOnly.dirs.find((d) => d.name === '大物').dirs.find((d) => d.name === '力学')
    eq(li.files.map((f) => f.name), ['大物/力学/board-1.md'], '白板模式：有板的那一枝照常')
    const em2 = noteOnly.dirs.find((d) => d.name === '大物').dirs.find((d) => d.name === '电磁学')
    eq(em2.files.map((f) => f.name), ['大物/电磁学/打卡.md'], '笔记模式：同一层只剩那条笔记')
    if (!noteOnly.dirs.find((d) => d.name === '大物').dirs.find((d) => d.name === '力学')) {
      ok('笔记模式：整枝只有白板的目录消失（两个入口各看各的）')
    } else bad('笔记模式里还留着一枝只有白板的目录')
    eq(pruneTree(buildFolderTree([], ['a/b']), () => false).dirs.map((d) => d.name), ['a'], '一个文件都没有时，目录照旧摆出来（刚建出来那一层）')
  }

  /* ⑥ 探名字：撞名只算同一层 */
  eq(uniqueRelName([], 'a/b', 'board-x').name, 'a/b/board-x.md', 'uniqueRelName：第一候选')
  eq(uniqueRelName(['a/b/board-x.md'], 'a/b', 'board-x').i, 2, '撞了往后排')
  eq(uniqueRelName(Array.from({ length: 99 }, (_, i) => joinPath('a', i ? `board-x ${i + 1}.md` : 'board-x.md')), 'a', 'board-x'), null, '99 个全占 → null')

  /* ⑦ 改名改没改：**最后那一段**说了算。
   * ★ 为什么单拎出来量：改名对话框靠它决定"确定"亮不亮、点下去算不算数。
   *   判据一旦写成"整条路径比一比"，`大物/第一章` → `大物/第一章/x`（只换了归属、
   *   名字没动）就会被当成一次改名，然后**把一个文件挪走**。 */
  eq(isRenamed('a/board-1.md', 'a/board-2.md'), true, '改名：最后一段变了')
  eq(isRenamed('a/board-1.md', 'b/board-1.md'), false, '只是换了所在的那一层 → 不算改名（那是移动）')
  eq(isRenamed('a/board-1.md', 'a/board-1.md'), false, '原样交回来 → 没改')
  eq(isRenamed('a/board-1.md', 'a/board-1.md.md'), true, '补一个 .md 也算改了（别把它当"没动"悄悄吞掉）')

  /* ⑧ ★ "点出来的分层"：在**某一层里**新建（2026-09-18）。
   * 用户原话：**「现在的分层不是很人性化我还要自己输入上层的名字才能生成，
   * 你可以参考下 onenote 的分层规则这样靠点击来在分层下面建立新白板很人性化」**。
   *
   * 这一节的判据只有一句话：**"建到哪一层"由你点的那一行决定，不由输入框里的字符串决定。**
   * 所以断言分两半：
   *   · `layerPath` 拼出来的路径**不含**任何多余的段（打一段名字 = 多一层，不是多一个 `/`）；
   *     而且**根那一层不能拼出一个前导 `/`** —— 那会在左栏树里多出一个空名字的节点（[6u] ① 那个坑）。
   *   · `layerNeeds` 不许认错"这一层在不在"：判错的两种代价不对称 ——
   *     说"不在"（其实在）只是多发一次 mkdir（服务端对已存在的层回 existed，不算错），
   *     说"在"（其实不在）就是静默失败（点了「＋」什么都没发生）。
   * 端到端对手是 `check:sidetree` 那一段真浏览器（点目录行的「＋」→ 只在那一层落盘）。 */
  eq(layerPath('大物', '第一章'), '大物/第一章', 'layerPath：在这一层里 → 只多一段')
  eq(layerPath('大物/电磁学', '第一章'), '大物/电磁学/第一章', 'layerPath：深处再往下也是一段一段拼')
  eq(layerPath('', '第一章'), '第一章', '★ layerPath 在根上：**不能**拼出 `/第一章`（树里会多一个空名字的节点）')
  eq(layerPath(null, '第一章'), '第一章', 'layerPath 收 null（"没点过任何一层"= 根）也不出错')
  eq(layerPath('大物', '  第一章  '), '大物/第一章', 'layerPath 两头空白当没写（Windows 会悄悄吃掉空白，名字就对不上了）')
  eq(layerPath('大物', ''), '大物', '只写了层（没写名字）→ 就是这一层本身，不凭空多一段空的')
  /* 上一层的名字**只有点击这一个来源**：同一个"第一章"，点在根上和在"大物"里落的不是同一个地方 */
  eq(layerPath('', '第一章') === layerPath('大物', '第一章'), false, '★ 同样一段名字：点根上和点大物上落点不同（"哪一层"只由点击决定）')

  eq(layerNeeds('大物', []), true, 'layerNeeds：盘上一个目录都没有 → 这一层得先建出来')
  eq(layerNeeds('大物', ['大物']), false, 'layerNeeds：已经在清单里 → 不用再建（少发一次请求）')
  eq(layerNeeds('大物/电磁学', ['大物']), true, 'layerNeeds：**只看这个名字本身**在不在，不看它的前缀')
  eq(layerNeeds('', []), false, '根永远在（空路径不是"一层"，不需要建）')
  eq(layerNeeds(null, []), false, 'layerNeeds 收 null 也当根')
  /* ⚠ 这一条是那条"两种代价不对称"的判据：`folders` 里没有 → 说"要建"，
     而服务端对已存在的层**不算错**（回 existed）—— 所以宁可多问一次，也不能漏。 */
  eq(layerNeeds('大物', ['大物', '大物/电磁学']), false, 'layerNeeds 只看自己那一个名字，不被邻居干扰')
}

// ═════════════════════ 6w. 复制 / 粘贴 ═════════════════════
console.log('\n[6w] 复制 / 粘贴（`clipboard.js`）：只装内容不装关系、落点用相对偏移、贴出来是新 id')
{
  /* 为什么单开一节（2026-09-18 用户："框选后加入复制功能，能够黏贴在其他用户想要黏贴的画板上"）：
   * 这三个坑**都不会报错**，只会在另一块板上呈现一个说不通的状态：
   *   · 带过去的连接指向别人家的 id（那条线画在一个不存在的东西上）；
   *   · 存了绝对坐标 → 贴出来在屏幕外（看着像"粘贴没反应"）；
   *   · 沿用旧 id → 粘一次把原来那张卡改了（静默改数据）。
   * 所以这一节钉的就是这三条，以及"板框跟着走、连接不跟着走"那条分界。 */

  /* 一块有内容的板：两笔 + 一张卡，另外板上还有一个**没被选中**的东西
     （用来验"没选中的不许被带上"） */
  const mk = (x, y, id) => ({ ...newStroke('pen', [x, y, 0.5, x + 10, y + 10, 0.5]), id })
  const base = () => {
    const b = newBoard('源板')
    b.title = '源板'
    b.strokes = [mk(0, 0, 'sa'), mk(20, 30, 'sb'), mk(900, 900, 'sz')]
    b.cards = [
      { ...newCard('note', 0, 0, { w: 100, h: 40 }), id: 'ca', x: 0, y: -60 },
      { ...newCard('note', 0, 0, { w: 100, h: 40 }), id: 'cz', x: 900, y: 900 },
    ]
    return b
  }

  /* ① 复制不到东西 → null（**不是空 payload**：调用方要保持原剪贴板不动） */
  eq(copySelection(newBoard('空板'), [], {}), null, '什么都没框住 → null（别把原来的剪贴板清掉）')
  eq(copySelection(base(), ['不存在的 id'], {}), null, '框里的 id 板上一笔都没有 → 也是 null')

  /* ② 基本形状：只装被选中的那些，而且**原点归到内容左上角** */
  const p1 = copySelection(base(), ['sa', 'sb'], { cards: ['ca'] })
  eq(p1.v, CLIPBOARD_VERSION, '剪贴板带版本号（以后改了形状能认出"这份读不动"）')
  eq(p1.strokes.length, 2, '装了两笔')
  eq(p1.cards.length, 1, '装了跟着一起选的那张卡')
  eq(p1.strokes.some((s) => s.id === 'sz'), false, '★ 没选中的那笔**没有**被带上')
  eq(p1.cards.some((c) => c.id === 'cz'), false, '★ 没选中的那张卡也没有')
  eq(payloadCount(p1), { strokes: 2, cards: 1, frames: 0 }, 'payloadCount 数得对（提示语用它）')
  /* ★ 原点 = **全部被复制的东西**的左上角，卡片也算（这张卡在 y=-60，
     所以整块的 y0 是 -60 —— 卡片的框比笔迹更靠上）。
     ⚠ 一开头我在这里写错过：以为原点只看笔迹（y0=0），于是断言"第二笔还在 +30"，
       实测是 **90**（= 30 − (−60)）。**测试算错了，不是代码错了** ——
       而这条断言本身就是"同一个 offset 罩住笔和卡"的判据，算错原点等于没在验它。 */
  eq(p1.box.h, 100, '★ 剪贴板的包围盒罩住**笔和卡两样**（这里 y 从 −60 的卡顶到 +40 的笔底 = 100）')
  eq(p1.strokes[0].points[0], 0, '★ 笔迹按"选中内容的左上角"归零（存相对坐标，贴到哪儿都能原样摆）')
  eq(p1.strokes[0].points[1], 60, '…y 也一样（−60 那个卡顶成了原点，所以这一笔落在 +60）')
  eq(p1.strokes[1].points[0], 20, '…而且**笔之间的相对关系原样保留**（第二笔还在 +20 的位置）')
  eq(p1.strokes[1].points[1], 90, '…两笔的 30 那段落差一点没变（90 − 60 = 30）')
  eq(p1.cards[0].y, 0, '★ 卡片的 y 也用**同一个** offset 归零（不是各归各的）')
  eq(p1.cards[0].x, 0, '…x 同理')
  /* 同一个 offset 是关键：两样东西的相对位置不许变 */
  {
    const src = base()
    const dy0 = src.strokes[0].points[1] - src.cards[0].y
    const dy1 = p1.strokes[0].points[1] - p1.cards[0].y
    eq(dy1, dy0, '★ 卡片相对笔迹的位移**一点没变**（同一个 offset 同时作用在两样上）')
    eq(dy1, 60, '  （这一笔在卡片下面 60 —— 归零前后都是这个数）')
  }

  /* ③ 连接不跟着走，但**两端都在里面**的板框跟着走 */
  {
    const b = base()
    b.frames = [{ id: 'fr1', title: '这一节', ids: ['sa', 'sb'], cards: ['ca'] }]
    /* 板上还有一条指向框外的连接 —— 它不该被带（剪贴板里根本没有 links 这个字段） */
    const pc = copySelection(b, ['sa', 'sb'], { cards: ['ca'] })
    eq(pc.links, undefined, '★ 剪贴板里**没有 links** —— 连接的两端是 id，跨板之后指向的是别人家的东西')
    eq(pc.frames.length, 1, '★ 板框跟着走（"这一块是一个整体"是你亲手宣告的，属于内容）')
    eq(pc.frames[0].title, '这一节', '…连标题一起带（那是你要搬的那句话）')
  }
  {
    /* 框里只有一半成员 → 只带那一半（用户框了半个框，他要的是"这半个也是一个整体"） */
    const b = base()
    b.frames = [{ id: 'fr1', ids: ['sa', 'sb'], cards: ['ca'] }]
    const pc = copySelection(b, ['sa'], {})
    eq(pc.frames.length, 1, '只框住半个框 → 这个框**还是带上**（用户要的是"这半个也是整体"）')
    eq(pc.frames[0].ids, ['sa'], '…成员只留进来的那些（死引用在粘贴时会换名换掉）')
    eq(pc.frames[0].cards, [], '…没进来的卡片成员不给')
  }
  {
    /* 一个成员都没进来 → 这个框跟这次复制无关，别带 */
    const b = base()
    b.frames = [{ id: 'fr1', ids: ['sb'], cards: [] }]
    const pc = copySelection(b, ['sa'], {})
    eq(pc.frames.length, 0, '框里的成员一个都没被选 → 这个框**不带**（跟这次复制无关）')
  }

  /* ④ 指向框外的条件丢掉；不指别人的留着 */
  {
    const b = base()
    b.strokes = b.strokes.map((s) =>
      s.id === 'sa' ? { ...s, cond: 'card:cz' } : s.id === 'sb' ? { ...s, cond: 'card:ca' } : s
    )
    const pc = copySelection(b, ['sa', 'sb'], { cards: ['ca'] })
    const byId = new Map(pc.strokes.map((s) => [s.id, s]))
    eq(byId.get('sa').cond, undefined, '★ 指向**没被复制**的那张卡的条件丢掉（它指的是别人家的东西）')
    eq(byId.get('sb').cond, 'card:ca', '…指向**被一起复制**的卡片的条件留着（那份关系搬过去还成立）')
  }
  eq(copySelection({ ...base(), strokes: [{ ...mk(0, 0, 'sa'), cond: 'none' }] }, ['sa'], {}).strokes[0].cond, 'none',
    '★ `cond: none`（"这个条件不算"）**留着** —— 它说的是这一笔自己，不指别人')

  /* ⑤ 粘贴：新 id、落点以"你要放的地方"为中心、内部关系不变 */
  {
    const b = base()
    const res = pastePayload(b, p1, { world: { x: 500, y: 400 } })
    eq(b.strokes.length, 3, '源板没被改（纯函数：返回新的 board）')
    eq(res.board.strokes.length, 5, '贴完多了两笔')
    eq(res.board.cards.length, 3, '贴完多了一张卡')
    eq(res.board.strokes.filter((s) => s.id === 'sa').length, 1, '★ 原来那两笔还在（粘贴不是搬家）')
    eq(res.ids.length, 2, '返回新笔的 id（界面拿它设焦点）')
    eq(res.cards.length, 1, '返回新卡的 id')
    /* ★ 新 id：**这次新造出来的那几个**，一个旧 id 都不许是它。
       ⚠ 别写成"整块板上没有旧 id" —— 源板本来就有的那些（`sa`/`ca`…）当然还在，
         粘贴是**加东西**不是搬家。判据要落在 `res.ids` / `res.cards` 这两个清单上。 */
    const oldIds = new Set(['sa', 'sb', 'sz', 'ca', 'cz'])
    eq(res.ids.some((id) => oldIds.has(id)), false, '★ 新笔的 id 都是新的（不然粘一次会把原来那笔改了）')
    eq(res.cards.some((id) => oldIds.has(id)), false, '…新卡的 id 也都是新的')
    eq(res.board.strokes.filter((s) => oldIds.has(s.id)).length, 3, '…而源板原来那 3 笔**一个都没少**')
    eq(res.board.cards.filter((c) => oldIds.has(c.id)).length, 2, '…原来那 2 张卡也都在')
    const allIds = [...res.board.strokes.map((s) => s.id), ...res.board.cards.map((c) => c.id)]
    eq(new Set(allIds).size, allIds.length, '…整块板上 id 互不重复')
    /* 落点：内容中心 ≈ 你要放的那个世界点 */
    const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
    for (const s of res.board.strokes.filter((x) => res.ids.includes(x.id))) {
      for (let i = 0; i + 2 < s.points.length; i += 3) {
        box.x0 = Math.min(box.x0, s.points[i]); box.x1 = Math.max(box.x1, s.points[i])
        box.y0 = Math.min(box.y0, s.points[i + 1]); box.y1 = Math.max(box.y1, s.points[i + 1])
      }
    }
    const cx = (box.x0 + box.x1) / 2
    const cy = (box.y0 + box.y1) / 2
    if (Math.abs(cx - 500) < 60 && Math.abs(cy - 400) < 60) ok(`★ 落点以"你要放的地方"为中心（贴到 ${Math.round(cx)},${Math.round(cy)}，目标 500,400）`)
    else bad(`落点偏了：贴到了 ${Math.round(cx)},${Math.round(cy)}，目标 500,400`)
  }
  /* ★ 这一条是那个"看着像粘贴没反应"的坑：**不许**沿用原板的绝对坐标。
     源板的笔在 (0,0)，如果照搬，贴到 (5000,5000) 的时候它会留在 (0,0) ——
     离用户正看的地方几屏远。 */
  {
    const res = pastePayload(base(), p1, { world: { x: 5000, y: 5000 } })
    const s = res.board.strokes.find((x) => res.ids.includes(x.id))
    if (s.points[0] > 4000) ok('★ 落点跟着 world 走（不是照搬原板的绝对坐标 —— 那会贴到屏幕外）')
    else bad(`粘贴照搬了原坐标（落在 ${s.points[0]}）—— 用户会以为"粘贴没反应"`)
  }

  /* ⑥ 板框跨板之后成员换名换干净 */
  {
    const b = base()
    b.frames = [{ id: 'fr1', title: '这一节', ids: ['sa', 'sb'], cards: ['ca'] }]
    const pc = copySelection(b, ['sa', 'sb'], { cards: ['ca'] })
    const res = pastePayload(b, pc, { world: { x: 0, y: 0 } })
    eq(res.frames.length, 1, '板框跟着粘过来了')
    const nf = res.board.frames.find((f) => f.id === res.frames[0])
    eq(nf.title, '这一节', '…标题还在')
    eq(nf.id === 'fr1', false, '★ 框的 id 也是新的（两个板框共用一个 id 是静默的错位）')
    eq(nf.ids.every((id) => res.ids.includes(id)), true, '★ 成员 id 全部换成了**新造的那批**（换不掉的会变死引用）')
    eq(nf.cards.every((id) => res.cards.includes(id)), true, '…卡片成员同理')
    eq(nf.ids.length, 2, '两个笔迹成员都在')
  }

  /* ⑦ 条件的第二种说法在**笔上**：跨板之后 id 必须换成新的那一批 */
  {
    const b = base()
    b.strokes = b.strokes.map((s) => (s.id === 'sa' ? { ...s, cond: 'card:ca' } : s))
    const pc = copySelection(b, ['sa'], { cards: ['ca'] })
    const res = pastePayload(b, pc, { world: { x: 0, y: 0 } })
    const ns = res.board.strokes.find((s) => res.ids.includes(s.id))
    eq(ns.cond, 'card:' + res.cards[0], '★ "条件就是它"里的 id 换成了**新卡**的 id（照搬就是指向别人家）')
    /* ⚠ 判据必须是**整个 id 相等**，不能是"里面有没有出现过 `ca` 这个子串" ——
       新 id 是 `nmu…` 那种随机串，**碰巧带上 `ca` 两个字母**是常有的事
       （我第一版就是这么写的，于是断言红了，而代码其实是对的）。 */
    eq(String(ns.cond).startsWith('card:'), true, '…形状还是"指向一张卡"')
    eq(String(ns.cond).slice(5) === 'ca', false, '★ 它指的**不是**源板上那张旧卡（id 整个换了）')
    eq(res.cards.includes(String(ns.cond).slice(5)), true, '…而确实指向**这次贴出来的**那张新卡')
  }

  /* ⑧ 版本 / 形状对不上的 payload 一律当"读不动" */
  eq(isPayload(p1), true, '自己造出来的 payload 认得')
  eq(isPayload(null), false, 'null 读不动')
  eq(isPayload({}), false, '空对象读不动')
  eq(isPayload({ ...p1, v: 999 }), false, '★ 版本对不上 → 读不动（宁可不粘，也不粘出一团乱的）')
  eq(isPayload({ ...p1, strokes: 'nope' }), false, '形状不对（strokes 不是数组）→ 读不动')
  eq(isPayload({ v: CLIPBOARD_VERSION, strokes: [], cards: [], frames: [] }), false, '★ 空的也读不动（"有剪贴板但里面没东西"不是一种状态）')
  eq(pastePayload(base(), { v: 999, strokes: [{ id: 'x', points: [0, 0, 0.5] }], cards: [], frames: [] }, {}), null,
    '★ 版本对不上时 pastePayload 返回 null（调用方据此提示"重新复制一次"）')

  /* ⑨ payload 是**纯数据**（能过 JSON）—— 这是它能进 localStorage 的前提 */
  {
    const round = JSON.parse(JSON.stringify(p1))
    eq(isPayload(round), true, '★ 过了 JSON 一圈照样认（剪贴板要能存进 localStorage / 跨窗口）')
    const r2 = pastePayload(base(), round, { world: { x: 10, y: 20 } })
    if (r2 && r2.ids.length === 2) ok('…而且过了 JSON 之后贴出来还是对的')
    else bad('payload 过 JSON 之后贴不动了（说明里面有函数 / undefined 之类的非数据）')
  }

  /* ⑩ 贴到**空板**上（"另一块板"最干净的那种）：内容真的落进来了 */
  {
    const empty = newBoard('目标板')
    const res = pastePayload(empty, p1, { world: { x: 0, y: 0 } })
    eq(res.board.strokes.length, 2, '★ 贴到一张空板上：两笔都在')
    eq(res.board.cards.length, 1, '…卡片也在')
    eq(res.board.title, '目标板', '…而且没有把源板的标题带过来（标题是"哪块板"，不是内容）')
  }
}

// ═════════════════════ 6x. 常用形状规整（`shapes.js`）═════════════════════
console.log('\n[6x] 常用形状规整（`shapes.js`）：画个圆 → 变成真正的圆')
{
  /* 为什么单开一节（2026-09-18 用户："加入常用形状优化方式，比如我画个圆他给我优化成
   * 真正的圆形，直线也是还有常用的矩形，三角形都能自动优化"）：
   *
   * ★ 这一族和 ADR-0001 砍掉的"形状判读"是**两件不同的事**（那三处本质差别写在
   *   shapes.js 的文件头）。但那条教训（"阈值松了会 100% 误报"）照样适用 ——
   *   所以这一节钉的不是"能不能认出来"，而是**两件事**：
   *     ① 手抖的圆/矩形/三角/直线必须认得（认不出来 = 功能不存在）；
   *     ② 汉字折笔、随手乱画、开口弧、碎笔迹必须认不出（认错 = 功能有害）。
   *   两条**同时**成立才叫能用，只验一条是自欺欺人。
   *
   * ★ 只用手造的确定性样本（正弦抖动），不引入随机 —— 抖动幅度若随机，
   *   某一晚刚好摇到边界上就会红，而那种红查不出是代码变了还是种子变了。 */

  /* ── 造样本：拿极坐标 / 参数方程生成"人画的"点 ──────────────────────────
   * 抖动用**确定性的正弦**（不同频率叠加），模拟手腕的不稳；
   * 三段的周期互质，避免抖出一个看得见的规律。 */
  const jit = (i) => Math.sin(i * 0.7) * 1.6 + Math.sin(i * 2.3) * 0.9
  const mkStroke = (pts, extra) => ({ ...newStroke('pen', pts), ...extra })
  /* 点数要够（shapes.js 有两道采样密度闸：MIN_PTS=24 / 点数÷对角线 ≥ 0.12）——
     真手上画一个 r=80 的圆是两三百个点，这里取 160 已经比真笔疏。 */
  const circle = (cx, cy, r, n = 160, sweep = 1) => {
    const a = []
    const steps = Math.round(n * sweep)
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2 * sweep
      a.push(cx + r * Math.cos(t) + jit(i), cy + r * Math.sin(t) + jit(i + 11), 0.5)
    }
    return a
  }
  const ellipse = (cx, cy, rx, ry, n = 160) => {
    const a = []
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2
      a.push(cx + rx * Math.cos(t) + jit(i), cy + ry * Math.sin(t) + jit(i + 7), 0.5)
    }
    return a
  }
  const line = (x0, y0, x1, y1, n = 80) => {
    const a = []
    for (let i = 0; i <= n; i++) {
      const u = i / n
      /* 手画的直线总有一点点弯（这里给一点点弧度，但远小于 LINE_MAX_SAG） */
      a.push(x0 + (x1 - x0) * u + jit(i) * 0.5, y0 + (y1 - y0) * u + jit(i + 4) * 0.5, 0.5)
    }
    return a
  }
  const rect = (x, y, w, h, per = 40) => {
    const a = []
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    for (let c = 0; c < 4; c++) {
      const [ax, ay] = corners[c]
      const [bx, by] = corners[(c + 1) % 4]
      for (let i = 0; i < per; i++) {
        const u = i / per
        a.push(ax + (bx - ax) * u + jit(c * 97 + i), ay + (by - ay) * u + jit(c * 97 + i + 3), 0.5)
      }
    }
    a.push(x, y) // 闭合
    return a
  }
  const tri = (p1, p2, p3, per = 50) => {
    const a = []
    const vs = [p1, p2, p3]
    for (let c = 0; c < 3; c++) {
      const [ax, ay] = vs[c]
      const [bx, by] = vs[(c + 1) % 3]
      for (let i = 0; i < per; i++) {
        const u = i / per
        a.push(ax + (bx - ax) * u + jit(c * 61 + i), ay + (by - ay) * u + jit(c * 61 + i + 2), 0.5)
      }
    }
    a.push(p1[0], p1[1])
    return a
  }

  const recognize = (pts, extra) => recognizeShape(mkStroke(pts, extra))

  /* ── ① 该认的：四类常用形状 ─────────────────────────────────────────────
   * ⚠ 这些数都是**真跑出来的**，不是照抄的我以为的阈值 ——
   *   写断言之前先让 shapes.js 自己说，然后把那个结果钉住（钉的是"别退化"，不是"我心想的数"）。 */
  {
    const s = recognize(circle(400, 400, 80))
    eq(s && s.kind, 'circle', '★ 手抖的圆认成"圆"（用户原话第一句：我画个圆他给我优化成真正的圆形）')
    if (s && s.kind === 'circle') {
      if (Math.abs(s.r - 80) < 4) ok(`  …半径量得准（认成 ${s.r.toFixed(1)}，真值 80）`)
      else bad(`半径偏了：${s.r.toFixed(1)}，真值 80`)
      if (Math.hypot(s.cx - 400, s.cy - 400) < 4) ok(`  …圆心也准（偏 ${Math.hypot(s.cx - 400, s.cy - 400).toFixed(2)}px）`)
      else bad(`圆心偏了：(${s.cx.toFixed(1)},${s.cy.toFixed(1)})，真值 (400,400)`)
    }
  }
  eq(recognize(line(100, 300, 700, 340))?.kind, 'line', '★ 手抖的直线认成"直线"')
  eq(recognize(line(100, 300, 100, 800))?.kind, 'line', '…竖的直线也是直线')
  eq(recognize(rect(100, 100, 240, 160))?.kind, 'rect', '★ 手抖的矩形认成"矩形"')
  eq(recognize(rect(100, 100, 300, 90))?.kind, 'rect', '…细长的矩形也认（300×90）')
  eq(recognize(tri([120, 300], [360, 300], [250, 120]))?.kind, 'triangle', '★ 手抖的三角形认成"三角形"')
  eq(recognize(tri([120, 300], [360, 300], [120, 120]))?.kind, 'triangle', '…直角三角形也认')
  eq(recognize(ellipse(400, 400, 160, 80))?.kind, 'ellipse', '★ 明显的椭圆认成"椭圆"（2:1 那种，不是把圆硬掰成椭圆）')

  /* ★ "圆先于椭圆"是判读顺序里的一条：正圆不许被贴成椭圆（那是过拟合，多一个自由度）。 */
  {
    const s = recognize(circle(400, 400, 80))
    const s2 = recognize(ellipse(400, 400, 82, 78), {})
    eq(s?.kind, 'circle', '★ 正圆就是圆')
    /* 82:78 = 1.051，远在 ELLIPSE_MIN_RATIO(1.22) 之下 —— 必须还认成圆 */
    eq(s2?.kind === 'circle' || s2 === null, true, '★ 只差一点点的"椭圆"不许被当成椭圆（没到 1.22:1 就不算）')
  }

  /* ── ② 该拒的：真手写内容必须原样不动 ─────────────────────────────────────
   * 这一批比上面那批更重要 —— 上面漏一个只是"少认一个形状"，
   * 这里错一个就是"把用户写的字揉成了一坨"。 */
  {
    /* 汉字里的折笔（横折钩那种）：有直线段、也有明显的角，但不是几何图形 */
    const foldPts = []
    for (let i = 0; i <= 60; i++) foldPts.push(100 + i * 3 + jit(i), 200 + jit(i + 1), 0.5)
    for (let i = 0; i <= 40; i++) foldPts.push(280 + jit(i), 200 + i * 3 + jit(i + 5), 0.5)
    eq(recognize(foldPts), null, '★ 一横一竖（汉字折笔）**不许**认成矩形/三角形')

    /* 撇：一条带明显弯曲的笔画 */
    const pie = []
    for (let i = 0; i <= 80; i++) {
      const u = i / 80
      pie.push(300 - u * 120 + jit(i), 100 + u * 260 + Math.sin(u * Math.PI) * 40 + jit(i + 3), 0.5)
    }
    eq(recognize(pie), null, '★ 一撇（弯曲的长笔画）不许认成直线')

    /* C 形开口弧：绕了大半圈但是**没闭合** */
    const arc = []
    for (let i = 0; i <= 140; i++) arc.push(400 + 120 * Math.cos(i / 140 * Math.PI * 1.7) + jit(i), 400 + 120 * Math.sin(i / 140 * Math.PI * 1.7) + jit(i + 2), 0.5)
    eq(recognize(arc), null, '★ 开口的 C 形弧不许认成圆')

    /* 随手乱涂：点乱跳 */
    const scrib = []
    for (let i = 0; i <= 120; i++) {
      scrib.push(400 + Math.sin(i * 1.7) * 90 + jit(i), 400 + Math.cos(i * 2.9) * 90 + jit(i + 1), 0.5)
    }
    eq(recognize(scrib), null, '★ 随手乱涂不许认成任何形状')

    /* 波浪线：一直在小幅转向 */
    const wave = []
    for (let i = 0; i <= 140; i++) wave.push(100 + i * 4 + jit(i), 400 + Math.sin(i / 9) * 34 + jit(i + 2), 0.5)
    eq(recognize(wave), null, '★ 波浪线不许认成直线')

    /* 极短的一勾 */
    eq(recognize([300, 300, 0.5, 312, 316, 0.5, 308, 330, 0.5]), null, '★ 很短的一勾认不出来（MIN_DIAG 那道闸）')
  }

  /* ── ③ 两道采样密度闸（真板上量出来的，见 shapes.js 里那段注释）──────────────
   * ★ 这一条是**真板上 42 笔误判的直接产物**：那批是 12~19 点、20~30px 的碎笔迹，
   *   因为点太少、拟合毫无约束，全拿到 score = 1.000。
   *   画出来是一堆散点，没有一笔是图形 —— 所以"分数高"在这里完全不能信。 */
  {
    /* 造一条"看着像圆、但点很少"的 —— 它的拟合分很高，必须被 MIN_PTS 挡下 */
    const sparse = []
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2
      sparse.push(400 + 60 * Math.cos(t), 400 + 60 * Math.sin(t), 0.5)
    }
    eq(recognize(sparse), null, '★ ★ 只有 16 个点的"圆"必须拒 —— 点太少时拟合分虚高（真板上 42 笔误报就是这么来的）')
    eq(recognizeShape(mkStroke(sparse)), null, '…（认不出就是 null，不是"勉强低分认出来"——有否决权才敢开这个功能）')

    /* 点够多但**整个形状太小**：直径 18px 的圈。真值 diag = √(19.35²+19.04²) ≈ 27.2，
       刚好越过 MIN_DIAG=26 —— 所以它**会被认出来**，这是有意的：
       "小"本身不是错，26 那条线是"小于这个尺寸的形状，认错了人也看不见、
       而它更可能是字里的一个小圈"。所以这里钉的不是"小圈必须拒"，
       而是"**明显更小**的圈（直径 < 26）必须拒" —— 那才是那道闸本身。 */
    {
      const micro = []
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2
        micro.push(400 + 6 * Math.cos(t) + jit(i) * 0.2, 400 + 6 * Math.sin(t) + jit(i) * 0.2, 0.5)
      }
      eq(recognize(micro), null, '★ 直径 12px 的小圈拒掉（MIN_DIAG=26 —— 字里的小圈比它大得多）')
    }

    /* ── ③b ★★★ **大图形必须照样认出来**（用户 2026-09-19 报的「我画的比较大的时候会识别不出来」）
     *
     * 这一条钉的是一个**已经删掉的闸**：`点数 / 对角线 ≥ MIN_PT_DENSITY(0.12)`。
     * ⚠ 它为什么必然歧视大图形：分子（点数）几乎与尺寸无关（采点按**屏幕**距离去重、
     *   抽稀按**世界**绝对像素容差 ⇒ 留下几个点是"手抖了几个波峰"决定的），
     *   而分母（对角线）**线性增长** ⇒ 同一个圆画得越大，这个比值越小。
     *   它测的不是"信息够不够判断形状"，而是"你画得够不够小"。
     *
     * 实测（用户真板 24 笔）：认出来的小笔密度 **0.11~0.23**、认不出来的大笔 **0.07~0.13**；
     * 而**点间距**随尺寸同步变大（小笔 6~16px、大笔 13~24px）—— "稀"是采样的属性。
     *
     * ⇒ 现在的判据是：**同一个圆，越画越大也必须认得出来**（只要点数够 MIN_PTS=24）。
     *   下面这组夹具就是"按真手的采样率"造的：点数固定在 24~80 之间（和尺寸无关），
     *   半径从 60 一路长到 600 —— 旧闸下**后面几个全过不去**。
     * ★ 反证在紧邻的上面那两条（16 点的碎圆必须拒、直径 12px 的必须拒）——
     *   只放宽不设反证，就会变成"什么圆都认"。 */
    {
      const sizes = [
        [60, 40], [80, 34], [120, 40], [200, 40],
        [300, 48], [420, 52], [600, 56], [900, 60],
      ]
      let allBig = true
      const detail = []
      for (const [r, n] of sizes) {
        const pts = []
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * Math.PI * 2
          pts.push(3000 + r * Math.cos(t) + jit(i) * 1.2, 3000 + r * Math.sin(t) + jit(i + 7) * 1.2, 0.5)
        }
        const got = recognize(pts)
        const diag = 2 * r
        const dens = (n + 1) / diag
        detail.push(`r=${r}: ${got ? got.kind : '✗'}(密度 ${dens.toFixed(3)})`)
        if (!got || got.kind !== 'circle') allBig = false
      }
      eq(allBig, true,
        '★ ★ ★ **越画越大的圆也必须认得出来**（半径 60 → 900、点数和尺寸无关）——'
        + ' 「点数 ÷ 对角线」那道闸必然歧视大图形，就是用户报的"画的比较大时识别不出来"。'
        + ` 实测：${detail.join(' ｜ ')}`)
      /* ★ 顺手把"点数闸没被一起删掉"钉住：同样大的圆，点少到 20 个还是必须拒。 */
      {
        const few = []
        for (let i = 0; i < 20; i++) {
          const t = (i / 20) * Math.PI * 2
          few.push(3000 + 600 * Math.cos(t) + jit(i) * 1.2, 3000 + 600 * Math.sin(t) + jit(i + 7) * 1.2, 0.5)
        }
        eq(recognize(few), null, '…而**同一个大圆只给 20 个点**仍然要拒（MIN_PTS=24 才是"点够不够多"的负责人）')
      }
    }
    {
      /* ★ 而 27px 那个尺寸**是在里面的**：写下来，免得以后有人以为那道闸失灵了。 */
      const tiny = []
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2
        tiny.push(400 + 9 * Math.cos(t) + jit(i) * 0.3, 400 + 9 * Math.sin(t) + jit(i) * 0.3, 0.5)
      }
      const s = recognize(tiny)
      eq(s === null || s.kind === 'circle', true, '…直径 18px（diag≈27）在闸内侧：认成圆或认不出都行，但**不许**是别的形状')
    }
  }

  /* ── ④ 拟合：认出来的那一笔真的变成"规整的"了吗 ───────────────────────────── */
  {
    const c = recognize(circle(400, 400, 80))
    const pts = fitShape(mkStroke(circle(400, 400, 80)), c)
    eq(pts.length, 72 * 3 + 3, '★ 圆排成 72 段 + 重复第一点（72×3 个数字 + 闭合那一个点）')
    /* 每一个点到圆心的距离都该等于 r —— 这就是"真正的圆"那句话的判据 */
    let worst = 0
    for (let i = 0; i + 2 < pts.length; i += 3) {
      worst = Math.max(worst, Math.abs(Math.hypot(pts[i] - c.cx, pts[i + 1] - c.cy) - c.r))
    }
    if (worst < 0.15) ok(`★ 拟合出来的每个点到圆心都是同一个 r（最大偏差 ${worst.toFixed(3)}px）= "真正的圆"`)
    else bad(`不是正圆：最大半径偏差 ${worst.toFixed(3)}px`)
    /* 首尾相接：闭合的一笔要显式重复第一点（不然 canvas 的 stroke() 缺一小段） */
    eq(pts[0] === pts[pts.length - 3] && pts[1] === pts[pts.length - 2], true, '★ 闭合的那一笔**显式重复第一点**（stroke() 不会自动闭合）')
    /* 压力统一 0.5（密度变了，逐点搬原压力没有意义） */
    {
      let allHalf = true
      for (let i = 2; i < pts.length; i += 3) if (pts[i] !== 0.5) allHalf = false
      eq(allHalf, true, '★ 压力统一 0.5（规整之后粗细均匀 —— 那才是"规整"该有的样子）')
    }
  }
  {
    const raw = line(100, 300, 700, 340)
    const c = recognize(raw)
    const pts = fitShape(mkStroke(raw), c)
    eq(pts.length, 6, '★ 直线就是**两个点**（规整该让数据变干净，不是留两三百个点）')
    /* ★ 端点是**拟合出来的**、不是照抄输入的第一/最后一个点：
       真手起笔落笔那两下有抖动，取端点得把那一小段抖去掉（这就是"规整"的含义）
       —— 所以这里容差 2px，而不是要求严格相等。 */
    if (Math.hypot(pts[0] - 100, pts[1] - 300) < 2) ok(`…起点落在原笔的起点上（差 ${Math.hypot(pts[0] - 100, pts[1] - 300).toFixed(2)}px）`)
    else bad(`起点偏了：(${pts[0]},${pts[1]})，真值 (100,300)`)
    if (Math.hypot(pts[3] - 700, pts[4] - 340) < 2) ok(`…终点也是（差 ${Math.hypot(pts[3] - 700, pts[4] - 340).toFixed(2)}px）`)
    else bad(`终点偏了：(${pts[3]},${pts[4]})，真值 (700,340)`)
    /* 端点顺序不能反 —— 反了"从哪儿画到哪儿"就丢了（箭头方向那族会跟着坏） */
    eq(pts[0] < pts[3], true, '★ 端点顺序按**你画的方向**排（起在前、终在后 —— 排反了箭头会翻边）')
  }
  {
    const raw = rect(100, 100, 240, 160)
    const c = recognize(raw)
    const pts = fitShape(mkStroke(raw), c)
    eq(pts.length, 15, '★ 矩形是 5 个点（四个角 + 回到起点）')
    /* ★ 四条边必须**真的横平竖直**：相邻两角要么同 x、要么同 y。
       （规整之前那些角是歪的 —— 这条就是"矩形被抻直了"的判据。） */
    const corner = (i) => ({ x: pts[i * 3], y: pts[i * 3 + 1] })
    const cs4 = [corner(0), corner(1), corner(2), corner(3)]
    let square = true
    for (let i = 0; i < 4; i++) {
      const a = cs4[i]
      const b = cs4[(i + 1) % 4]
      /* 每一条边只能是"横的"或"竖的"，不许是斜的 */
      if (Math.abs(a.x - b.x) > 0.11 && Math.abs(a.y - b.y) > 0.11) square = false
    }
    eq(square, true, '★ 四个角横平竖直（每条边非横即竖，没有一条是斜的）')
    /* ★ 而"多大、在哪儿"是**从原笔量出来的**，不是把包围盒硬抄下来：
       我这条夹具的抖动让它量出来 97.5 / 244.9×164.7（真值 100 / 240×160）——
       这一点点出入正是"量出来"的证据（照抄包围盒的话会是精确的 100 / 240×160）。 */
    if (Math.abs(cs4[0].x - 100) < 4 && Math.abs(cs4[0].y - 100) < 4) {
      ok(`…左上角贴着原笔的位置（量到 ${cs4[0].x.toFixed(1)},${cs4[0].y.toFixed(1)}，真值 100,100）`)
    } else bad(`左上角偏太多：(${cs4[0].x.toFixed(1)},${cs4[0].y.toFixed(1)})`)
    const w = Math.abs(cs4[1].x - cs4[0].x)
    const h = Math.abs(cs4[2].y - cs4[1].y)
    if (Math.abs(w - 240) < 8 && Math.abs(h - 160) < 8) {
      ok(`…而宽高也是量出来的（${w.toFixed(1)}×${h.toFixed(1)}，真值 240×160）`)
    } else bad(`宽高偏太多：${w.toFixed(1)}×${h.toFixed(1)}`)
  }
  {
    const raw = tri([120, 300], [360, 300], [250, 120])
    const c = recognize(raw)
    const pts = fitShape(mkStroke(raw), c)
    eq(pts.length, 12, '★ 三角形是 4 个点（三个顶点 + 回到起点）')
    /* ★ 三个顶点**从原笔里取**，不是从包围盒推 —— 见 fitShape 那段注释 */
    eq(pts[9] === pts[0] && pts[10] === pts[1], true, '★ 最后一点回到第一个顶点（闭合）')
  }

  /* ── ⑤ `regularizeStrokes`：沿 id、保留字段、认不出的原样不动 ─────────────── */
  {
    const keep = mkStroke(circle(400, 400, 80), { id: 'keepme', color: '#f00', width: 5, link: { kind: 'cause' } })
    const b = mkStroke(line(0, 0, 300, 300), { id: 'b' })
    /* 这一笔是汉字折笔 —— 认不出来，**必须原样返回同一个对象** */
    const noisePts = []
    for (let i = 0; i <= 60; i++) noisePts.push(100 + i * 3 + jit(i), 200 + jit(i + 1), 0.5)
    const noise = mkStroke(noisePts, { id: 'noise' })

    const res = regularizeStrokes([keep, b, noise])
    eq(res.strokes.length, 3, '规整不增不减笔数')
    eq(res.changed.length, 2, '★ 认出来的两笔才有记录（认不出的不算"改了"）')
    const after = new Map(res.strokes.map((s) => [s.id, s]))
    eq(after.get('keepme').id, 'keepme', '★ **沿用 id**（板框成员存的就是 id，换 id 等于把这一笔踢出框）')
    eq(after.get('keepme').color, '#f00', '★ 颜色原样保留（那是用户选的，规整不该改它）')
    eq(after.get('keepme').width, 5, '…粗细也保留')
    eq(after.get('keepme').link?.kind, 'cause', '★ ★ 挂在笔上的连接**跟着走**（它住在这条 stroke 上 —— 换 id 就丢了）')
    eq(after.get('keepme').points === keep.points, false, '…而点确实换成规整的了')
    eq(after.get('noise') === noise, true, '★ ★ 认不出的那一笔**是同一个对象**（连引用都没变）—— 原样不动')
    eq(res.changed.map((c) => c.id).sort().join(','), 'b,keepme', '…改的是哪两笔，账上清清楚楚')
    eq(res.changed.every((c) => typeof c.label === 'string' && c.label.length > 0), true, '…每一条都带人话的名字（界面要用它拼提示语）')
  }
  /* 一个都认不出时，`changed` 必须是空数组（界面据此说"没看出形状"，而不是"规整了 0 笔"） */
  {
    const noisePts = []
    for (let i = 0; i <= 80; i++) noisePts.push(400 + Math.sin(i * 1.7) * 90 + jit(i), 400 + Math.cos(i * 2.9) * 90 + jit(i + 1), 0.5)
    /* ⚠ 判据要落在**传进去的那个对象**上，不能落在 `noisePts` 上 ——
       `newStroke` 会把扁平数组重建成一份新的，所以 identity 在造夹具那一步就已经换了。
       拿 `noisePts` 比会红，而那是**测试算错了**，不是代码错了（这个坑这一族踩过三次）。 */
    const src = mkStroke(noisePts, { id: 'x' })
    const res = regularizeStrokes([src])
    eq(res.changed.length, 0, '★ 一笔都没认出来 → changed 空（界面按这个说"没看出形状"，不是"规整了 0 笔"）')
    eq(res.strokes[0] === src, true, '…那一笔原样返回（同一个对象，连引用都没变）')
  }

  /* ── ⑥ `recognizeStrokes`（界面的那一层）：返回的是**每一笔各认一遍**的结果 ── */
  {
    const hits = recognizeStrokes([
      mkStroke(circle(400, 400, 80), { id: 'c1' }),
      mkStroke(line(0, 0, 300, 300), { id: 'l1' }),
      mkStroke([300, 300, 0.5, 312, 316, 0.5], { id: 'tiny1' }),
    ])
    eq(hits.length, 2, '★ 三笔里认出两笔（碎笔迹不算）')
    eq(hits.map((h) => h.id).join(','), 'c1,l1', '…而且带 id（界面要按 id 去换板上的那一笔）')
    eq(hits.map((h) => h.label).join(','), '圆,直线', '…带人话的名字（那颗按钮上写的就是它）')
    eq(hits.every((h) => h.shape && typeof h.shape === 'object'), true, '…以及判读结果本身（拟合要用）')
    /* ★★ 这一条是一次**真 bug** 换来的（2026-09-18）：
       界面上那颗按钮的 `data-ink-shape` 我写成了 `h.kind`，而 hit 的形状住在 `h.shape` 里 ——
       React 不报错，只会渲染成 `data-ink-shape=""`（看着像"属性没写"）。
       所以这里把 hit 的**字段名**钉死：形状在 `shape.kind`，人话在 `label`。 */
    eq(hits.map((h) => h.shape.kind).join(','), 'circle,line', '★ ★ 形状住在 `h.shape.kind`（不是 `h.kind`）—— 写错了不会报错，只会渲染出一个空属性')
    eq('kind' in hits[0], false, '…顶层**没有** kind 这个字段（免得以后有人以为有）')
    eq(recognizeStrokes([]).length, 0, '空框 → 没有结果（界面上那颗按钮就不该出现）')
    eq(recognizeStrokes(null).length, 0, 'null 也当空的（别让界面崩）')
  }

  /* ── ⑦ 荧光笔不算 ─────────────────────────────────────────────────────────
   * 高亮的横线看着也是一条直线（而且很直），但它的语义是"标出来"不是"画一条线" ——
   * 把它规整成一根细线等于把高亮删了。 */
  eq(recognizeShape(mkStroke(line(100, 300, 700, 320), { tool: 'highlighter' })), null,
    '★ 荧光笔画的横不许规整（它那一下是"标记"，不是"画一条线"）')

  /* ── ⑧ 判读的顺序与几何：几处"顺序错了就会错"的地方 ───────────────────────── */
  {
    /* ★ 圆先于椭圆：一个 1.05:1 的近圆，如果先试椭圆就会认成椭圆（多一个自由度的过拟合） */
    const near = []
    for (let i = 0; i <= 160; i++) {
      const t = (i / 160) * Math.PI * 2
      near.push(400 + 82 * Math.cos(t) + jit(i), 400 + 78 * Math.sin(t) + jit(i + 3), 0.5)
    }
    const s = recognize(near)
    eq(s === null || s.kind === 'circle', true, '★ 近圆（82:78）只能是"圆"或"认不出"，**不许**是椭圆（那是过拟合）')
  }
  {
    /* ★ 闭合的一笔要显式重复第一点 —— 检查真手上"多绕一小截"的那个圆也认得出 */
    const over = circle(400, 400, 80, 160, 1.1)
    const s = recognize(over)
    eq(s?.kind, 'circle', '★ 收笔时多绕一小截的圆照样认得（真手画圆就是这样，不是缺陷）')
  }
  {
    /* ★ 净转角 vs 累计转角：一条笔直的线上抖动全在噪声里，累计转角能到 200°+ 而净转角≈0。
       这里用**很直的线**验"净转角那个量是对的"（用累计转角的话这条会被拒）。 */
    eq(recognize(line(100, 300, 700, 300, 200))?.kind, 'line', '★ 很直的线认得出来 —— 抖动只进累计转角，不进净转角')
  }
  /* 形状名（界面拿它拼按钮上的字） */
  eq(shapeLabel('line'), '直线', 'shapeLabel：line → 直线')
  eq(shapeLabel('circle'), '圆', 'shapeLabel：circle → 圆')
  eq(shapeLabel('rect'), '矩形', 'shapeLabel：rect → 矩形')
  eq(shapeLabel('triangle'), '三角形', 'shapeLabel：triangle → 三角形')
  eq(shapeLabel('ellipse'), '椭圆', 'shapeLabel：ellipse → 椭圆')
  eq(shapeLabel('什么鬼'), '形状', '★ 不认识的词退回"形状"，不返回 undefined（不然按钮上会写"undefined"）')

  /* ── ⑨ **图形对象那一层**（`shape-object.js`，2026-09-19）────────────────────
   *
   * 用户 2026-09-19 的第二句话：「然后你可以对图形放大缩小修正真正形状」。
   * 上面那些验的是"认不认得出来"，这里验的是"认出来之后**它是不是一个东西**"：
   * 能不能缩放、能不能旋转、**重开一张板还在不在**。
   *
   * ★★ 这一节最要紧的一条断言是 **(a) 点必须从 shape 重烤得出来**。
   *   它是整个设计的地基（"shape 和 points 任何时候都对得上"）——
   *   地基塌了的表现是"拖一下手柄图形跳回原处"，而那是**静默**的。
   */
  console.log('\n  [6x-2] 图形对象：能缩放、能转、重开还在')
  {
    /* (a) 判读结果 → 对象 → 烤点：**同一个图形烤两次必须一模一样**。
       这一条听着像废话，但它钉的正是"不变量"：`normalizeStroke` 在**每一趟读盘**
       都会按 shape 重烤一遍点，所以只要"烤两次不一样"，用户每次打开这张板
       图形都会**悄悄变形**一点点（而且找不出是谁改的）。 */
    const obj = recognizeShapeObject(mkStroke(circle(400, 400, 80)))
    eq(!!obj, true, '(a) 一个圆 → 拿到图形对象（拿不到就没有手柄，见 shape-object 的文件头）')
    eq(obj && obj.k, 'ellipse', '  …圆的存储形态是**椭圆**（圆 = rx===ry 的椭圆，一种东西一个字段）')
    eq(obj && Math.abs(obj.rx - obj.ry) < 1e-9, true, '  …而且两个半轴精确相等（不许"差不多"——那会让它自称椭圆）')
    const b1 = bakeShapePoints(obj)
    const b2 = bakeShapePoints(normalizeShape(serializeShape(obj)))
    eq(b1.length, b2.length, '  ★ 烤出来的点数一致')
    eq(b1.every((v, i) => Math.abs(v - b2[i]) < 1e-9), true, '★ ★ **(a) 过一趟存盘再烤，一个数都不差**（这就是"shape 和 points 对得上"那条不变量）')
    /* ★★ (a) 的**保证**：从判读结果一路到"写进文件"，**每一个点都不许变**。
     *
     * ⚠ 这一条是踩出来的，而且是本轮最贵的一个静默 bug：第一版 `normalizeShape`
     *   **不量化参数**，而 `serializeShape` 量化 —— 于是：
     *     · 内存里那份参数是判读层的原样数（半径 80.08663260372299）；
     *     · 进文件的是量化过的（80.1）；
     *     · 读盘时 `normalizeStroke` 按 shape **重烤**点 → 烤出来比盘上那份多 0.1px。
     *   后果是"存→读→再存"不再逐字节一致（每次开板一条假 diff），
     *   屏幕上那一丁点看不出来，只有字节能抓住。
     *   ⇒ 现在的判据是**整条链一起验**（判读 → 对象 → 烤点 → 存 → 读回 → 再烤），
     *     而不是分别验每一步 —— 这个 bug 恰恰住在"两步之间"。
     */
    {
      const st0 = mkStroke(circle(400, 400, 80), { id: 'p1' })
      const obj0 = recognizeShapeObject(st0)
      const baked0 = bakeShapePoints(obj0)
      const bd0 = makeBoard()
      bd0.strokes = [retargetStroke(st0, obj0)]
      const back0 = parseBoardDocument(serializeBoardDocument(bd0)).strokes[0]
      eq(back0.points.length, baked0.length, '★ ★ **(a′) 判读 → 烤点 → 存 → 读回：点数一个不少**')
      eq(back0.points.every((v, i) => Math.abs(v - baked0[i]) < 1e-9), true, '★ ★ **(a′) 而且每一个坐标都一模一样**（差一点就是"每次开板图形悄悄变形"）')
      eq(
        serializeBoardDocument(parseBoardDocument(serializeBoardDocument(bd0))) === serializeBoardDocument(bd0),
        true,
        '★ ★ **(a″) 存→读→再存 逐字节一致**（这是"开一次板就留一条假 diff"的唯一判据）'
      )
    }

    /* (b) 圆的点签名：73 个（72 段 + 闭合那一点）。
       ⚠ 这个数**不是随便挑的** —— `check-shape` 那条真浏览器自检就是按它认东西的
         （见 README 第 49 条：73 / 5 / 4 / 2 是规整产物的签名）。改了它两处一起改。 */
    eq(b1.length / 3, 73, '(b) 半径 80 的圆 → 73 个点（72 段 + 闭合；`check-shape` 按这个签名认它）')
    /* ★ 段数**跟着半径长**：半径 600 的圆再用 72 段，弦高 0.57px，屏幕上看得出来是多边形。
       这不是"优化"，是"规整"这件事能不能成立（用户要的是"看起来是个真正的圆"）。
       ⚠ 判据**不写"半径 600 要有几个段"**（那是把一个中间量钉死，改公式就红）——
         钉的是那个**目的**：弦高（多边形和真圆的最大偏差）必须一直在容差之内。
         弦高 = r·(1 − cos(π/N))。 */
    {
      let worst = 0
      let worstAt = null
      for (const r of [20, 40, 80, 200, 600, 2000]) {
        const pts = bakeShapePoints({ k: 'ellipse', cx: 0, cy: 0, rx: r, ry: r })
        const N = (pts.length / 3 - 1)
        const chord = r * (1 - Math.cos(Math.PI / N))
        if (chord > worst) {
          worst = chord
          worstAt = r
        }
      }
      eq(worst <= 0.4, true, `  ★ 从半径 20 到 2000，弦高一直 ≤ 0.4 世界像素（最差 ${worst.toFixed(3)}px @ r=${worstAt}）—— 屏幕上看不出是折线`)
      eq(bakeShapePoints({ k: 'ellipse', cx: 0, cy: 0, rx: 600, ry: 600 }).length / 3 > 73, true, '  …半径 600 的圆确实比 72 段密')
    }
    const small = bakeShapePoints({ k: 'ellipse', cx: 0, cy: 0, rx: 12, ry: 12 })
    eq(small.length / 3, 73, '  …小圆不加密（下限 72：文件别为看不见的精度白胖）')

    /* (c) 端点/顶点那两族：矩形 5 点、三角形 4 点、直线 2 点（同样的签名家族）。 */
    eq(bakeShapePoints({ k: 'rect', cx: 0, cy: 0, w: 100, h: 60 }).length / 3, 5, '(c) 矩形 5 个点（四角 + 闭合）')
    eq(bakeShapePoints({ k: 'line', x1: 0, y1: 0, x2: 100, y2: 100 }).length / 3, 2, '  …直线 2 个点')
    {
      const t = recognizeShapeObject(mkStroke(tri([120, 300], [360, 300], [250, 120])))
      eq(!!t && t.k, 'triangle', '  ★ 三角形 → 对象（它的身份是**三个顶点**，不是包围盒）')
      if (t) {
        const tb = bakeShapePoints(t)
        eq(tb.length / 3, 4, '  …三角形 4 个点（三顶点 + 闭合）')
        /* ★ 顶点必须**就是判读层用的那三个**（`fitShape` 也是从原笔里取的那三个）。
           两套顶点 = 拖一下手柄图形就跳（shape-object.js 里 recognizeShapeObject 那段账）。 */
        const drawn = fitShape(mkStroke(tri([120, 300], [360, 300], [250, 120])), recognize(tri([120, 300], [360, 300], [250, 120])))
        let near = 0
        for (let i = 0; i + 2 < tb.length && i + 2 < drawn.length; i += 3) {
          if (Math.abs(tb[i] - drawn[i]) < 0.2 && Math.abs(tb[i + 1] - drawn[i + 1]) < 0.2) near++
        }
        eq(near >= 3, true, '★ ★ 对象里的顶点**就是屏幕上画出来那三个**（两套顶点会让图形拖一下就跳）')
      }
    }

    /* (d) 缩放：分轴 → 圆变椭圆、正方形变长方形。这正是"修正真正形状"那句话的意思。 */
    {
      const s0 = { k: 'ellipse', cx: 100, cy: 100, rx: 50, ry: 50 }
      const wide = scaleShape(s0, 2, 1, { x: 50, y: 50 })
      eq(Math.round(wide.rx), 100, '(d) 横向拉 2 倍 → rx 100')
      eq(Math.round(wide.ry), 50, '  …ry 不动（分轴缩放）')
      eq(shapeName(wide), '椭圆', '★ 圆拉扁之后它**就是椭圆**了（"修正真正形状"就是这件事，不是 bug）')
      const uni = scaleShape(s0, 3, 3, { x: 50, y: 50 })
      eq(shapeName(uni), '圆', '  …等比放大还是圆')
      eq(Math.round(uni.rx), 150, '  …倍率对（50→150）')
      /* ★ 锚点不动：锚点是"对面那个角"，它的坐标一个数都不许变。 */
      const anchored = scaleShape(s0, 4, 4, { x: 50, y: 50 })
      eq(Math.round(anchored.cx - anchored.rx), 50, '★ 锚点那一点不动（拖右下角时左上角钉住）')
      /* ★★ 拖到"比零还小"：倍率被**夹住**，图形不许消失。
         这是 shape-object.js 里那段"拖不回来"的账 —— 第一版返回 null，
         于是"拖到最小再往回拖"会先卡住再猛地跳回一个大尺寸。 */
      const tiny = scaleShape(s0, 0, 0, { x: 50, y: 50 })
      eq(!!tiny, true, '★ 倍率 0 也不许返回 null（那会让图形**消失**，而且拖不回来）')
      const neg = scaleShape(s0, -3, -3, { x: 50, y: 50 })
      eq(neg.rx > 0 && neg.ry > 0, true, '  …负倍率取正（翻面不做，不然手柄会跑到对角去）')
    }

    /* (e) 旋转：转的是**参数** `rot`，不是"把点转一遍"。
       ★ 为什么这件事必须这样：矩形一转，靠改点是回不到**轴对齐**的 ——
         而"轴对齐"正是"规整"的全部内容（shape-object.js 文件头 ②）。 */
    {
      const r0 = { k: 'rect', cx: 100, cy: 100, w: 120, h: 60 }
      const r90 = rotateShape(r0, Math.PI / 2)
      eq(Math.abs(r90.rot - Math.PI / 2) < 1e-6, true, '(e) 矩形转 90° → `rot` 记下这件事（不是把点转一遍）')
      /* ⚠ 精度：`rot` 走的是**弧度**，不是坐标那种 1/10 像素的量化。
         第一版按 6 位小数量化 → π/2 变成 1.570796，差 3.3e-7 ——
         而它让"转了 90° 的矩形**不再精确轴对齐**"（轴对齐正是"规整"的全部内容）。 */
      eq(Math.abs(r90.rot - Math.PI / 2) < 1e-9, true, '  ★ 而且精度到 1e-9（量化到 6 位会让它不再精确轴对齐）')
      const back = rotateShape(r90, -Math.PI / 2)
      eq(back.rot === 0 && !Object.is(back.rot, -0), true, '★ 转过去再转回来 → `rot` 精确回到 **0**（不是 -0：JSON 里那是两个不同的字符串）')
      /* 转 90° 之后包围盒应该**反过来**（宽高互换）—— 这是"点确实跟着转了"的证明。 */
      const box0 = shapeAABB(bakeShapePoints(r0))
      const box90 = shapeAABB(bakeShapePoints(r90))
      eq(Math.abs(box0.w - 120) < 0.2 && Math.abs(box0.h - 60) < 0.2, true, '  …转之前包围盒 120×60')
      eq(Math.abs(box90.w - 60) < 0.5 && Math.abs(box90.h - 120) < 0.5, true, '★ 转 90° 之后包围盒变成 60×120（点真的转了）')
      /* ★ 绕**形状自己的中心**转：中心那一点必须不动（绕包围盒中心转会"一边转一边跑"）。 */
      const c0 = shapeCenter(r0)
      const c1 = shapeCenter(r90)
      eq(Math.hypot(c0.x - c1.x, c0.y - c1.y) < 1e-9, true, '★ 转轴是形状自己的几何中心 —— 转多少圈中心都不动')
    }

    /* (f) 平移：翻遍所有 kind，一个都不许漏（漏一个就是"整组拖动之后它自己弹回原处"）。 */
    {
      const kinds = [
        { k: 'ellipse', cx: 10, cy: 20, rx: 30, ry: 20 },
        { k: 'rect', cx: 10, cy: 20, w: 30, h: 20 },
        { k: 'line', x1: 0, y1: 0, x2: 30, y2: 40 },
        recognizeShapeObject(mkStroke(tri([120, 300], [360, 300], [250, 120]))),
      ]
      let allMoved = true
      for (const sh of kinds) {
        const before = bakeShapePoints(sh)
        const after = bakeShapePoints(translateShape(sh, 7, 11))
        if (!before || !after || before.length !== after.length) { allMoved = false; continue }
        for (let i = 0; i + 2 < before.length; i += 3) {
          if (Math.abs(after[i] - (before[i] + 7)) > 1e-6 || Math.abs(after[i + 1] - (before[i + 1] + 11)) > 1e-6) allMoved = false
        }
      }
      eq(allMoved, true, '(f) 四种图形平移之后**每一个点都正好挪了 (7,11)**（三角形/直线搬的不是圆心，别漏）')
    }

    /* (g) 读盘那道闸：坏数据必须被丢掉，而不是变成一个"看不见的图形"。
       ⚠ 一个 NaN 点在 canvas 上的表现是**整笔不画** —— 静默消失，最难查。 */
    eq(normalizeShape(null), null, '(g) null → null')
    eq(normalizeShape({ k: 'star', cx: 0, cy: 0 }), null, '  ★ 不认识的 kind 丢掉（手改文件写个 star 不该造出一个图形）')
    eq(normalizeShape({ k: 'rect', cx: 0, cy: 0 }), null, '  ★ 缺 w/h 的矩形丢掉（拿它烤点会烤出 NaN）')
    eq(normalizeShape({ k: 'rect', cx: 0, cy: 0, w: 0, h: 100 }), null, '  ★ 零宽的矩形丢掉（缩放手柄会除零）')
    eq(normalizeShape({ k: 'line', x1: 0, y1: 0, x2: 0, y2: 0 }), null, '  ★ 零长度的直线丢掉（没有方向）')
    eq(normalizeShape({ k: 'triangle', t: [[0, 0], [10, 0], [20, 0]] }), null, '  ★ 三点共线（面积 0）丢掉')
    eq(normalizeShape({ k: 'ellipse', cx: 'x', cy: 0, rx: 10, ry: 10 }), null, '  ★ 坐标不是数的丢掉')

    /* (h) 写盘：**只在真有时写、而且短**。老文件一个字节都不多
       （和 link / cond / locked / font / scale 同一条规矩）。 */
    eq(serializeShape(null), null, '(h) 没有形状 → 写盘返回 null（调用方据此不写这个字段）')
    eq('rot' in serializeShape({ k: 'rect', cx: 0, cy: 0, w: 10, h: 10 }), false, '  ★ 没转过就不写 `rot`（凭空写个 0 出去就是给老文件造假 diff）')
    eq(serializeShape({ k: 'circle', cx: 1.23456, cy: 0, rx: 10, ry: 10 }).k, 'ellipse', '  …圆的存储形态一律是 ellipse')
    eq(serializeShape({ k: 'ellipse', cx: 1.23456, cy: 0, rx: 10, ry: 10 }).cx, 1.2, '  …坐标量化到 1/10 像素（不然文件里是一串 .123456789）')

    /* (i) `shapeName` 和 `shapeLabel` 必须说同一句话。
       ⚠ 它们住在两个 module 里（一个是判读层的 five-kind、一个是对象层的四类），
         今天它们一致是**巧合还是设计**必须由这条断言回答 —— 不一致的表现是
         "提示语说圆、按钮上写椭圆"，而两边各自看都对。 */
    eq(shapeName({ k: 'ellipse', cx: 0, cy: 0, rx: 40, ry: 40 }), shapeLabel('circle'), '(i) 正圆：对象层说"圆"，判读层也说"圆"')
    eq(shapeName({ k: 'ellipse', cx: 0, cy: 0, rx: 40, ry: 20 }), shapeLabel('ellipse'), '  …椭圆同理')
    eq(shapeName({ k: 'rect', cx: 0, cy: 0, w: 40, h: 20 }), shapeLabel('rect'), '  …矩形')
    eq(shapeName({ k: 'triangle', t: [[0, 0], [40, 0], [20, 30]] }), shapeLabel('triangle'), '  …三角形')
    eq(shapeName({ k: 'line', x1: 0, y1: 0, x2: 40, y2: 30 }), shapeLabel('line'), '  …直线')
  }

  /* ── ⑩ 图形的**存取往返**：存进文件、读回来、手柄还在 ────────────────────────
   *
   * 用户 2026-09-19 选的第三条是「存：笔迹上记一个字段」。这一节就是那条选择的对手盘。
   * ★ 两条判据缺一不可：
   *   · 存→读→**再存**，字节一致（不然每次开板都在 Git 里留一条假 diff）；
   *   · **没规整过的板一个字节都不多**（老文件不许因为加了新字段就变脏）。
   */
  console.log('\n  [6x-3] 图形落盘：重开还在，而没规整过的板一个字节都不多')
  {
    const shapeStroke = regularizeStrokes([mkStroke(circle(400, 400, 80), { id: 'sh1' })]).strokes[0]
    eq(!!shapeStroke.shape, true, '⑩ 规整过的笔上带着 `shape` 字段（重开之后手柄靠它回来）')
    const bd = makeBoard()
    bd.strokes = [shapeStroke]
    /* ⚠ `serializeBoardDocument` 返回的是**字符串**（JSON 文本），不是对象 ——
       这一行第一版写成 `doc.strokes[0]`，于是拿 `undefined` 去读属性。
       要对象就读回来一份（`parseBoardDocument` 本来就是它的对手盘）。 */
    const docText = serializeBoardDocument(bd)
    const doc = parseBoardDocument(docText)
    eq(!!doc.strokes[0].shape, true, '  ★ 写进了文件')
    eq(doc.strokes[0].shape.k, 'ellipse', '  …而且是短字段版（k/cx/cy/rx/ry）')

    /* ★ 读回来：点必须**从 shape 重烤**（那是唯一的真相，见 board.js 的 normalizeStroke）。 */
    const bs = doc.strokes.find((s) => s.id === 'sh1')
    eq(!!bs && !!bs.shape, true, '  ★ 读回来图形身份还在')
    eq(bs.points.length, shapeStroke.points.length, '  …点数一致')
    /* ★★ 再存一次必须**一个字节都不差** —— 不然"打开→什么都不改→存回去"就变脏了
       （README 的"每天一条假 diff"那一族）。 */
    const docText2 = serializeBoardDocument(doc)
    eq(docText2 === docText, true, '★ ★ 存→读→再存 **逐字节一致**（不然每次开板都在 Git 里留一条假 diff）')
    /* ★ 手柄要的那几样东西：包围盒、中心、四个角 + 旋转柄。
       `shapeTarget` 就是从 `shapeAABB(points)` 现算的（Board.jsx），所以这里验它算得出来。 */
    const box = shapeAABB(bs.points)
    const handles = shapeHandlePoints(box)
    eq(handles.length, 5, '  ★ 四个角柄 + 一个旋转柄')
    eq(handles.map((h) => h.id).join(','), 'nw,ne,se,sw,rot', '  …顺序固定（自检和界面都按它取）')
    eq(Math.abs(box.w - 160) < 2 && Math.abs(box.h - 160) < 2, true, '  ★ 包围盒就是那个圆（半径 80 → 160 见方）')
    for (const h of handles.slice(0, 4)) {
      const op = oppositeCorner(box, h.id)
      eq(Math.abs(op.x - h.x) > 1 && Math.abs(op.y - h.y) > 1, true, `  …${h.id} 的锚点在对面（拖它时那一点不动）`)
    }

    /* ★ 反证：**没规整过的板**多一个字段都没有。判据是"文件里根本没有 shape 这个键"，
       而不是"它的值是 undefined"（后者 JSON 里根本写不出来，是一条永远绿的断言）。
       ⚠ 判据要落在**文件文本**上（`'"shape"' in docText`），不是落在解析后的对象上 ——
         `JSON.parse` 之后"没有这个键"和"值是 undefined"分不开。 */
    const plain = makeBoard()
    plain.strokes = [mkStroke(circle(400, 400, 80), { id: 'raw1' })]
    const plainText = serializeBoardDocument(plain)
    eq(plainText.includes('"shape"'), false, '★ 手画的（没规整过的）那一笔**文件里连 shape 这个键都没有** —— 老板一个字节都不多')
    eq(plainText.includes('"lock'), false, '  …顺便：没锁过的板也没有 locked（同一条纪律的邻居）')

    /* ★ 坏数据：`shape` 是垃圾时**丢掉字段**，不是把整笔丢掉（那一笔的字还在！）。 */
    const junkDoc = parseBoardDocument(docText.replace('"k": "ellipse"', '"k": "star"'))
    eq(junkDoc.strokes.length, 1, '★ 手改文件把一个图形写成 `star` → **笔迹还在**（只是不再是图形）')
    eq('shape' in junkDoc.strokes[0], false, '  …那个字段被丢掉了（而不是让烤点烤出一堆 NaN）')
    eq(junkDoc.strokes[0].points.length > 0, true, '  …点原样留着（宁可退化成普通笔迹，也不丢用户的东西）')
    eq(serializeBoardDocument(junkDoc).includes('"shape"'), false, '  …再存出去时它也不会被写回来')

    /* ★★ 剪贴板：图形搬走时**参数必须跟着搬**（Board.jsx 的 shiftStroke / clipboard 两条路）。
       漏了它的症状是"复制一个圆、贴在别处，它弹回原位置" —— 因为读盘按 shape 重烤。
       这里直接验那个 module 的话（shiftStroke 是组件内部的，量不到），
       所以验的是**它依赖的那句话**：translateShape 之后再烤，点确实挪了。 */
    const moved = bakeShapePoints(translateShape(bs.shape, 250, -130))
    const movedBox = shapeAABB(moved)
    eq(Math.abs(movedBox.cx - (box.cx + 250)) < 0.5, true, '★ ★ 图形平移之后**烤出来的点也跟着挪**（只搬 points 不搬 shape = 贴出来弹回原处）')
    eq(Math.abs(movedBox.cy - (box.cy - 130)) < 0.5, true, '  …另一个轴同理')
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
