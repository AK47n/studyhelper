/* 白板数据层 + 公式转化的自检（纯 node，不开浏览器、不起服务）。
 *
 * 这一层为什么值得写自检：它坏起来是"静默错"。吸附吸错一张卡、孤岛数错一个、
 * 公式转化把 mu_0 越改越长——在屏幕上看着都挺正常，等你复习的时候才发现
 * 关系和当初想的不一样。所以这里断言的都是**不变量**，不是"跑通就行"。
 *
 * 跑：npm run check:board
 */
import {
  NEAR_GAP, READABLE_FIT_S, buildRelations, descendantsOf, fitView, inkedEdges, isBoardDocument, newBoard,
  newCard, newStroke, parseBoardDocument, pointSegDist, relationCurve, screenToWorld,
  serializeBoardDocument, simplifyPoints, strokeBounds, strokeHitsCircle, toFlat, toPoints,
  worldToScreen, zoomAt,
} from '../src/lib/board.js'
import { displayTex, snippetFor, toTex } from '../src/lib/formula.js'

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
  const ink = inkedEdges(b)
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
