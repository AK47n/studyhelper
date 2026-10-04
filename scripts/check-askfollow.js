/* check-askfollow：**框选追问**那条路上的纯逻辑（不出网、不开浏览器）。
 *
 * 名字为什么不是 `check-ask`：那个已经给了「应用自己的询问框」（App.jsx 的 Ask）。
 * 这里说的是**追问**（圈住课件上不懂的一块 → 问为什么），两条完全不同的东西。
 *
 * 这里钉的是几件"错了不会报错、只会安静答错"的事：
 *   [A] **这一块在哪一页**（ask-region.js）—— 页号错一页，模型会拿着别的页
 *       头头是道地回答；矩形算错，红框会画在你没圈的地方。
 *   [B] **裁图该画多大、要不要重渲染一页更大的**（ask-geometry.js 的 planCropImage）
 *       —— 判错的表现是"模型看不清那个符号，于是编一个解释"。
 *   [C] **发出去的到底是什么**：提示词里有没有页码和问题、两张图能不能拆开、
 *       多轮对话有没有夹干净。
 *
 * 跑：node scripts/check-askfollow.js   （或 npm run check:askfollow）
 * 真浏览器那一段（两张图真的发出去、板上一个字节都不变）在 check-followup-browser.js。
 *
 * ⚠ 这里 import 的是 **ask-geometry.js**，不是 ask-images.js —— 后者一 import 就拉起
 *   pdf.js（`?url` 那两条 vite 语法 node 读不了），自检连碰都碰不到它。
 *   "能被断言的纯函数住那边、要浏览器的住这边"是仓库里那条老规矩。
 */
import {
  ASK_MIN_SPAN,
  docForPath,
  findAskRegion,
  normBox,
  normalizeRegion,
  overlapArea,
  regionInPage,
  regionLabel,
  regionToWorld,
} from '../src/lib/ask-region.js'
import { ASK_CROP_PX, ASK_PAGE_PX, ASK_RENDER_MAX_W, labelHeightOf, pixelRectOf, planCropImage } from '../src/lib/ask-geometry.js'
import { askPrompt, askQuestion, parseAskHistory, stripFence } from '../server-ocr.js'
import { extractFilePartNamed } from '../src/lib/multipart.js'
import { ASK_BUTTON, ASK_STALE_HINT } from '../src/lib/followup.js'

let fails = 0
let checks = 0
const ok = (m) => {
  checks++
  console.log('  \u2713 ' + m)
}
const bad = (m) => {
  checks++
  fails++
  console.log('  \u2717 ' + m)
}
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(`${m}（拿到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`))
const near = (a, b, eps, m) => (Math.abs(a - b) <= eps ? ok(m) : bad(`${m}（拿到 ${a}，期望 ${b}±${eps}）`))
const yes = (v, m) => (v ? ok(m) : bad(m))
const no = (v, m) => (!v ? ok(m) : bad(m))

/* ── 一份三页的夹具资料（页面按 docs.js 的规矩摆：页距 = 页高 + DOC_PAGE_GAP=20）──
   三种页面各占一样：A4 竖版、16:9 横版、再来一张 A4 —— 免得"只有一种宽高比"的夹具
   让某条换算恰好蒙对。 */
const PAGE_GAP = 20
const DOC = {
  id: 'docask1',
  path: '.资料/追问夹具.pdf',
  x: 100,
  y: 200,
  w: 720,
  pages: [
    [595, 842], // 第 1 页：竖版，高 = 720*842/595 ≈ 1018.99
    [720, 540], // 第 2 页：横版，高 = 540
    [595, 842], // 第 3 页
  ],
}
const H1 = (720 * 842) / 595
const H2 = 540
const R1 = { x: 100, y: 200, w: 720, h: H1 }
const R2 = { x: 100, y: 200 + H1 + PAGE_GAP, w: 720, h: H2 }
const R3 = { x: 100, y: 200 + H1 + PAGE_GAP + H2 + PAGE_GAP, w: 720, h: H1 }
const DOCS = [DOC]
const find = (box, docs = DOCS) => findAskRegion({ box, docs })

console.log('\n[A] 这一块在哪一页（ask-region.js）')

/* A1. 最基础的一件事：框落在第 2 页中间 → 页号、页内矩形 */
{
  const box = { x0: 100 + 360, y0: R2.y + 270 - 50, x1: 100 + 360 + 120, y1: R2.y + 270 + 50 }
  const hit = find(box)
  yes(hit, 'A1 框在第 2 页上 → 找得到')
  if (hit) {
    eq(hit.page, 2, 'A1 页号 = 2')
    near(hit.region.x, 360 / 720, 1e-6, 'A1 页内 x 归一化（0.5）')
    near(hit.region.w, 120 / 720, 1e-6, 'A1 页内宽归一化')
    near(hit.coverage, 1, 1e-6, 'A1 整块都在这一页上 → coverage = 1')
    no(hit.clamped, 'A1 没圈出页面 → clamped = false')
  }
}

/* A2. 反着拖（x0>x1）也是同一个框 —— 框选四个方向都能拖 */
{
  const a = find({ x0: 300, y0: R2.y + 100, x1: 500, y1: R2.y + 200 })
  const b = find({ x0: 500, y0: R2.y + 200, x1: 300, y1: R2.y + 100 })
  yes(
    a && b && a.page === b.page && Math.abs(a.region.x - b.region.x) < 1e-9 && Math.abs(a.region.h - b.region.h) < 1e-9,
    'A2 反着拖出来的框和正着拖一模一样'
  )
}

/* A3. 跨两页的框：压得多的那一页赢（"框选时手滑扫到下一页"的常见样子） */
{
  const box = { x0: 300, y0: R2.y + R2.h - 60, x1: 500, y1: R2.y + R2.h + 200 } // 60 在第 2 页、200 在第 3 页
  const hit = find(box)
  yes(hit && hit.page === 3, 'A3 跨页时选**压得最多**的那一页（这里第 3 页压得多）')
  /* ★ 分母是**两块地的总面积**（60+180=240），不是框的面积（260）—— 框跨在两页
     之间的那道缝上时，缝不属于任何一页，算进去会让"三比一"变成"三比一减一点"
     （自检当场抓到的：0.69 对 0.75）。 */
  if (hit) near(hit.coverage, 180 / 240, 0.01, 'A3 coverage = 落在这一页的比例（分母只算压在页面上的那部分）')
}
{
  const box = { x0: 300, y0: R2.y + R2.h - 200, x1: 500, y1: R2.y + R2.h + 40 }
  const hit = find(box)
  yes(hit && hit.page === 2, 'A3b 反过来压得少的那一页不算（还是第 2 页）')
}

/* A4. 只圈到页边那一角 / 稍微圈出去一点：中心在页内就算（ASK_EDGE_SLACK 的用处） */
{
  const box = { x0: 100 - 8, y0: R2.y + 10, x1: 100 + 90, y1: R2.y + 90 }
  const hit = find(box)
  yes(hit && hit.page === 2, 'A4 框压着页面左边缘（圈出去 8px）→ 仍然算这一页')
  if (hit) {
    yes(hit.clamped, 'A4 圈出去过 → clamped = true（界面会提示"按页内那一块问"）')
    near(hit.region.x, 0, 1e-9, 'A4 页内 x 夹到 0（不画到页面外面）')
  }
}

/* A5. 页面之间的缝 / 离课件很远的空白：**不猜**（返回 null，界面会给一句人话）
   ★ "缝"这一条不只是一种情况：那个框**一页都没压到**（两页都没碰着）时不算 ——
     12 像素的容差只在"确实压到了这一页"时才算数，不然一个正好落在缝里的框
     会两边都"中心在页内"，拿一张只有缝的图去问。 */
{
  const gapY = R1.y + R1.h + PAGE_GAP / 2
  no(find({ x0: 300, y0: gapY - 8, x1: 500, y1: gapY + 8 }), 'A5 圈在两页之间的缝里（一页都没压到）→ 不算任何一页')
  no(find({ x0: 0, y0: 0, x1: 60, y1: 60 }), 'A5 圈在离课件很远的空白上 → 不算')
  /* 但**压到了下一页**时，中间那道缝不再是问题（A3 那条路）。 */
  yes(find({ x0: 300, y0: gapY - 8, x1: 500, y1: R3.y + 60 }), 'A5 压到第 3 页了 → 就算第 3 页（缝只是"圈出去了一点"）')
}

/* A6. 太小的框：点一下就落笔也是一个框，那种"框"不该被当成一次追问 */
{
  const tiny = { x0: 300, y0: R2.y + 100, x1: 300 + ASK_MIN_SPAN - 1, y1: R2.y + 100 + ASK_MIN_SPAN - 1 }
  no(find(tiny), `A6 小于 ${ASK_MIN_SPAN} 世界像素的框不算（点一下不该问出话来）`)
  /* 刚好到线：**算**。坐标是从浮点里来的（R2.y 本身是 720*842/595 算出来的），
     所以这里给 0.5 的余量 —— 拿"刚好 5.000000"去卡一条浮点判据只会得到一个
     永远在边缘抖的断言，而它想说的其实是"门槛附近要算"（原来的 1e-6 就是这么抖的）。 */
  const just = { x0: 300, y0: R2.y + 100, x1: 300 + ASK_MIN_SPAN + 0.5, y1: R2.y + 100 + ASK_MIN_SPAN + 0.5 }
  yes(find(just), `A6 到了 ${ASK_MIN_SPAN} 像素就算（门槛附近是算的，不是不算）`)
}

/* A7. 怪值一律挡掉（**不是**"兜底成 0"）—— 兜底会让一个空框变成"原点上的一个小框" */
{
  no(normBox(null), 'A7 normBox(null) = null')
  no(normBox({}), 'A7 四个数都缺 → null（不是 {0,0,0,0}）')
  no(normBox({ x0: 'a', y0: 1, x1: 2, y1: 3 }), 'A7 有一个数读不出来 → null')
  no(find({ x0: NaN, y0: 1, x1: 100, y1: 100 }), 'A7 框里有 NaN → 不算任何一页')
  no(findAskRegion({ box: { x0: 1, y0: 1, x1: 99, y1: 99 }, docs: null }), 'A7 板上没有资料 → null')
  no(findAskRegion({ box: { x0: 1, y0: 1, x1: 99, y1: 99 }, docs: [{ id: 'x', pages: [] }] }), 'A7 资料没有页 → null')
}

/* A8. 归一化矩形（region）的进出口：0~1 之外夹住，太小的丢掉 */
{
  eq(normalizeRegion({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'A8 正常值原样通过')
  eq(normalizeRegion([0.1, 0.2, 0.3, 0.4]), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'A8 数组写法也认')
  no(normalizeRegion({ x: 0.1, y: 0.1, w: 0.01, h: 0.5 }), 'A8 只有 1% 宽的一条 → null（裁出来是条线）')
  no(normalizeRegion({ x: 'a', y: 0, w: 0.5, h: 0.5 }), 'A8 认不出的值 → null')
  /* ★ 负起点是**夹**不是丢：框选的判据是"碰着就算"，所以框压出页面外是常事
     （想把页边那一行连同外面的标注一起圈住）。夹住 = 按页内那一块问，
     丢掉 = 用户点了没反应 —— 前者才是对的（自检 A4 那条同一件事）。 */
  eq(normalizeRegion({ x: -0.5, y: 0, w: 0.8, h: 0.5 }), { x: 0, y: 0, w: 0.8, h: 0.5 }, 'A8 负起点被夹到 0（不是丢掉）')
  const cl = normalizeRegion({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })
  yes(cl && cl.w <= 0.1 + 1e-9 && cl.h <= 0.1 + 1e-9, 'A8 顶到右下角时宽高被夹住（不越界）')
}

/* A9. regionInPage / regionToWorld 是一对逆运算（红框和裁图都靠这一对） */
{
  const box = { x0: 250, y0: R2.y + 120, x1: 470, y1: R2.y + 300 }
  const r = regionInPage(box, R2)
  const back = regionToWorld(r, R2)
  near(back.x0, 250, 0.001, 'A9 regionToWorld(regionInPage(box)) 的 x0 回到原处')
  near(back.y1, R2.y + 300, 0.001, 'A9 的 y1 回到原处')
  near(overlapArea(box, R2), 220 * 180, 0.01, 'A9 overlapArea = 220×180')
  eq(overlapArea({ x0: 0, y0: 0, x1: 1, y1: 1 }, R2), 0, 'A9 完全不重叠时面积是 0')
}

/* A10. 位置说法（小窗标题上那句"上左那一块"） */
{
  eq(regionLabel({ x: 0.05, y: 0.05, w: 0.2, h: 0.1 }), '上左那一块', 'A10 左上角的块')
  eq(regionLabel({ x: 0.7, y: 0.8, w: 0.2, h: 0.15 }), '下右那一块', 'A10 右下角的块')
  eq(regionLabel({ x: 0.4, y: 0.45, w: 0.2, h: 0.1 }), '正中间那一块', 'A10 正中间那一块（不是"中中间"）')
  eq(regionLabel({ x: 0.4, y: 0.05, w: 0.2, h: 0.1 }), '上边那一块', 'A10 横向居中、偏上的块')
  eq(regionLabel({ x: 0.05, y: 0.45, w: 0.2, h: 0.1 }), '左边那一块', 'A10 纵向居中、偏左的块')
  eq(regionLabel(null), '', 'A10 没有矩形时是空串（标题上就不带这一截）')
}

/* A11. 第 1 页 / 第 3 页也要对（只验第 2 页的话，"页号 = 下标 + 1"写错也看不出来） */
{
  const p1 = find({ x0: 300, y0: R1.y + 100, x1: 420, y1: R1.y + 200 })
  const p3 = find({ x0: 300, y0: R3.y + 100, x1: 420, y1: R3.y + 200 })
  yes(p1 && p1.page === 1, 'A11 第 1 页上的框 → page = 1')
  yes(p3 && p3.page === 3, 'A11 第 3 页上的框 → page = 3')
  /* 同一块地方在第 1 页和第 3 页上算出来的归一化矩形必须一模一样
     （两页尺寸相同）—— 这一条能抓住"用了绝对 y 而不是页内相对 y"那种错。 */
  yes(p1 && p3 && Math.abs(p1.region.y - p3.region.y) < 1e-9, 'A11 两页同样位置 → 归一化矩形相同（用的是页内相对坐标）')
}

/* A12. ★ 圈住**卡片**（2026-09-22 用户报的「问这里依旧无法框选解说卡片」）
   课件整理落下来的讲解卡摆在页面**旁边**（右栏，`sideColumns`），它压根不压在页面上 ——
   所以"框落在哪一页"那一趟必然返回 null，按钮永远灰着。第二条路是**卡片自己记的页码**。 */
{
  const CARD = {
    id: 'cz1',
    kind: 'note',
    x: R2.x + R2.w + 44, // doc-cards.js 的 sideColumns：页面右边缘 + ORIGIN_GAP
    y: R2.y,
    w: 400,
    h: 300,
    text: '第 2 页 · 讲解',
    locked: true, // 课件整理贴上去的默认是钉住的
    ask: { doc: DOC.path, page: 2 },
  }
  /* 一张离页面很远的卡（同一份资料的第 3 页）：拿它试"框很大、只压住卡一点点"那种。 */
  const FAR = { ...CARD, id: 'cz5', x: 3000, ask: { doc: DOC.path, page: 3 } }
  const inCard = { x0: CARD.x + 20, y0: CARD.y + 20, x1: CARD.x + 300, y1: CARD.y + 200 }
  const hit = findAskRegion({ box: inCard, docs: DOCS, cards: [CARD] })
  yes(hit && hit.page === 2, 'A12 圈住讲解卡 → 认出它讲的**第 2 页**（从前这里返回 null，按钮灰着）')
  if (hit) {
    yes(hit.fromCard === true && hit.cardId === 'cz1', 'A12 ★ 标着"靠卡片认出来的"（页面那一趟没参与）')
    eq(hit.region, { x: 0, y: 0, w: 1, h: 1 }, 'A12 讲解卡没被圈过哪一块 → 问**整页**')
    no(hit.clamped, 'A12 不是"圈出页面" → clamped = false')
  }
  /* 「留到板上」留下的卡带着 `region` → 问的是**当初圈的那块**，不是整页。 */
  const kept = { ...CARD, id: 'cz2', ask: { doc: DOC.path, page: 2, region: [0.1, 0.2, 0.3, 0.4] } }
  const kh = findAskRegion({ box: inCard, docs: DOCS, cards: [kept] })
  eq(kh && kh.region, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'A12 卡上记着那一块 → 问那一块（不是整页）')

  /* ★ 框压在页面上时**不许被卡片抢走**：那一趟说的才是"你圈的那一块"。 */
  const onPage = { x0: 300, y0: R2.y + 100, x1: 500, y1: R2.y + 200 }
  const ph = findAskRegion({ box: onPage, docs: DOCS, cards: [CARD] })
  yes(ph && ph.page === 2 && !ph.fromCard, 'A12 ★ 框压在页面上（中心也在页面上）→ 走页面那一趟（卡片不抢）')
  /* ★★ 只蹭着页面一条边、中心落在卡上 → **卡片说了算**。
     ⚠ 这一条最要紧：页面那一趟的覆盖率分母里没有卡片，这种框在它那儿是"整块都在第 2 页"，
        裁出来的是页面右边一条 6 像素宽的窄条 —— 模型照着那条边编，而用户以为自己问的是整页
        （diag:askcard 当场量到的）。中心落在卡上 = "我圈的就是这张卡"。 */
  const graze = { x0: R2.x + R2.w - 6, y0: CARD.y + 20, x1: CARD.x + 300, y1: CARD.y + 200 }
  const gh = findAskRegion({ box: graze, docs: DOCS, cards: [CARD] })
  yes(gh && gh.fromCard && gh.page === 2, 'A12 ★★ 只蹭着页面一条边、中心在卡上 → 走卡片那一趟')
  if (gh) {
    eq(gh.region, { x: 0, y: 0, w: 1, h: 1 }, 'A12 ★★ 这时问的是**整页**（不是页面边上那条窄条）')
    no(gh.clamped, 'A12 ★★ 没有被"夹"过（夹出来的窄条正是这一条要挡掉的东西）')
  }

  /* 认不出的三种，一律**不猜**（问错课件是这一族最糟的错，因为它不报错）： */
  no(findAskRegion({ box: inCard, docs: DOCS, cards: [{ ...CARD, id: 'cz3', ask: null }] }), 'A12 卡上没记页码（自己写的笔记）→ 不猜')
  /* ★★ 中心落在一张**没有页码**的卡上、只蹭着页面一条边 → 两边都不算。
     ⚠ 这一条挡的是"裁出一条窄条"：卡片那一趟认不出页码，页面那一趟只蹭到 3%。 */
  no(
    findAskRegion({ box: graze, docs: DOCS, cards: [{ ...CARD, id: 'cz6', ask: null }] }),
    'A12 ★★ 只蹭着页面一条边、中心在**没记页码**的卡上 → 不算（不裁那条窄边）'
  )
  no(
    findAskRegion({ box: inCard, docs: DOCS, cards: [{ ...CARD, id: 'cz4', ask: { doc: '.资料/别的.pdf', page: 2 } }] }),
    'A12 卡上那份资料**不在板上** → 不猜成别的那份'
  )
  no(find(inCard), 'A12 不传 cards 的老调用方：行为一个字节没变（还是 null）')
  /* 只是扫到卡片一角（想圈页面、顺手蹭到旁边的讲解卡）→ 不算"我圈的是这张卡"。 */
  no(
    findAskRegion({ box: { x0: CARD.x + 360, y0: CARD.y + 10, x1: CARD.x + 500, y1: CARD.y + 260 }, docs: DOCS, cards: [CARD] }),
    'A12 只扫到卡片一角（压住不到三分之一、中心也不在卡上）→ 不算'
  )
  /* 框很大但**中心落在卡上** → 那就是"我圈的是它"（和页面那一趟同一个形状的两条判据）。 */
  const wide = findAskRegion({
    box: { x0: FAR.x - 1200, y0: FAR.y - 900, x1: FAR.x + 1900, y1: FAR.y + 1000 },
    docs: DOCS,
    cards: [FAR],
  })
  yes(wide && wide.page === 3 && wide.fromCard, 'A12 框很大、只压住卡一点点，但中心在卡上 → 算（问第 3 页）')
  /* 资料路径 → 板上那一份：没写路径且只有一份资料时才猜，给了就必须对上。 */
  eq(docForPath(DOCS, DOC.path), DOC, 'A12 docForPath：给了路径 → 对上那一份')
  eq(docForPath(DOCS, ''), DOC, 'A12 docForPath：老卡没写路径、板上只有一份 → 猜它')
  no(docForPath([DOC, { ...DOC, id: 'x2', path: '.资料/第二份.pdf' }], ''), 'A12 docForPath：板上有两份又没写路径 → 不猜')
}

console.log('\n[B] 两张图怎么造（ask-images.js 的纯函数）')

/* B1. 页内归一化矩形 → 像素矩形（页码白带要把版面整体推下去） */
{
  const lh = labelHeightOf(ASK_PAGE_PX)
  yes(lh >= 28, `B1 页码白带高度 = ${lh}px（至少 28）`)
  const r = pixelRectOf({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1440, 1080, lh)
  eq([r.x, r.w], [360, 720], 'B1 x / 宽 = 归一化值 × 位图宽')
  near(r.y, lh + 0.5 * (1080 - lh), 1, 'B1 y 从页码白带**下面**起算（不然红框会高一条）')
  near(r.h, 0.25 * (1080 - lh), 1, 'B1 高按"白带下面那部分"算')
  const z = pixelRectOf({ x: 2, y: -1, w: 0.5, h: 0.5 }, 1440, 1080, lh)
  yes(z.x === 1440 && z.y === lh && z.w >= 1 && z.h >= 1, 'B1 越界的矩形被夹在位图里（不画到外面）')
}

/* B2. 裁图：源够清楚就只放大到目标宽 */
{
  const plan = planCropImage({ srcW: 1440, rect: { x: 100, y: 100, w: 600, h: 300 }, srcPageW: 1440 })
  eq(plan.rerender, false, 'B2 源宽够（600px 的块）→ 不重渲染')
  eq(plan.w, ASK_CROP_PX, `B2 放到目标宽 ${ASK_CROP_PX}`)
  eq(plan.h, 450, 'B2 高按同一比例（不拉伸变形）')
  near(plan.zoom, ASK_CROP_PX / 600, 0.01, 'B2 放大倍数 = 目标宽 / 源宽')
}

/* B3. 那一块很小 → **重渲染一页更大的**（"模型看不清小符号"那条路的唯一解） */
{
  const plan = planCropImage({ srcW: 1440, rect: { x: 900, y: 400, w: 36, h: 20 }, srcPageW: 1440 })
  eq(plan.rerender, true, 'B3 那块只有 36px 宽 → 要重渲染一页更大的')
  yes(plan.renderW > 1440, `B3 重渲染宽 ${plan.renderW} > 1440`)
  yes(plan.renderW <= ASK_RENDER_MAX_W, `B3 重渲染不超过上限 ${ASK_RENDER_MAX_W}（一页 JPEG 会顶到请求体上限）`)
  /* 重渲染之后**要用新尺寸再算一遍**（调用方就是这么做的）—— 不能再要求重渲染，
     而且这时候允许放大到更高一档（源像素是真的，见 ASK_CROP_MAX_ZOOM_HI）。 */
  const plan2 = planCropImage({ srcW: plan.renderW, rect: { x: 1, y: 1, w: (36 * plan.renderW) / 1440, h: (20 * plan.renderW) / 1440 }, srcPageW: plan.renderW })
  eq(plan2.rerender, false, 'B3 重渲染之后不再要求重渲染（不会无限套娃）')
  yes(plan2.w >= 400, `B3 重渲染后裁图宽 ${plan2.w} ≥ 400（够看清了 —— 不然那一趟重渲染白花）`)
}

/* B4. 极端：1 像素的块也不许崩、不许无限放大；本来就很大的一块不许再放大 */
{
  const plan = planCropImage({ srcW: 1440, rect: { x: 0, y: 0, w: 1, h: 1 }, srcPageW: 1440 })
  yes(Number.isFinite(plan.w) && plan.w > 0 && plan.renderW <= ASK_RENDER_MAX_W, `B4 1px 的框也能算出合理计划（w=${plan.w}, renderW=${plan.renderW}）`)
  const big = planCropImage({ srcW: 1440, rect: { x: 0, y: 0, w: 1400, h: 1000 }, srcPageW: 1440 })
  eq([big.w, big.zoom], [1400, 1], 'B4 本来就很大的块不放大（×1，别把它弄糊）')
}

console.log('\n[C] 发出去的是什么（提示词、两张图、多轮对话）')

/* C1. 提示词把页码填上了；**"他问的那一句"不在提示词里，它是单独一条消息**
 *     （2026-09-22 改的：为了前缀缓存命中，见 server-ocr.js 的 askPrompt 那段）。
 *     ⚠ 这一条**不能删**：它守的是"模型收得到这一问"这件事 ——
 *        换了个地方放，就得在新地方钉住（C1b）。 */
{
  const p = askPrompt(7)
  yes(p.includes('第 7 页'), 'C1 页码进了提示词')
  /* ★ 反面断言：这一问**必须不在**提示词里 —— 它一旦回到提示词末尾（也就是图片之前），
     每一轮追问的公共前缀就在那儿断掉，两张图又要按未命中重付一遍。 */
  no(p.includes('这一步为什么能这么换？'), 'C1 ★ 他问的那一句**不在**提示词里（在的话前缀会在图片之前断掉）')
  no(p.includes('{{'), 'C1 没有剩下的占位符')
  yes(p.includes('第一张') && p.includes('第二张'), 'C1 说清了两张图的顺序（不说清它会对着裁图讲整页）')
  yes(p.includes('红框'), 'C1 说清了红框就是"你圈的地方"')
  yes(p.includes('编造'), 'C1 有"不许编造"那条（猜出来的解释比不回答糟）')
  yes(p.includes('看不清'), 'C1 有"看不清就说看不清"')
  const p2 = askPrompt(0)
  yes(p2.includes('这一页') && !p2.includes('{{'), 'C1 没给页码时也不留占位符')
}

/* C1b. 那一问确实发得出去（换了个家，不是丢了）—— 见 `askQuestion` */
{
  eq(askQuestion('这一步为什么能这么换？'), '这一步为什么能这么换？', 'C1b 他问的那一句原样发出去')
  eq(askQuestion('  两边留白  '), '两边留白', 'C1b 两头的空白去掉')
  yes(askQuestion('').length > 0, 'C1b 什么都没写时给一句实话，而不是发一条空消息（空 content 会被上游拒）')
  yes(askQuestion(null).length > 0, 'C1b null 也兜得住')
}

/* C2. 多轮对话的清洗：坏 JSON 当没有、超长截断、认不出的 role 丢掉 */
{
  eq(parseAskHistory(''), [], 'C2 空字符串 → 空对话')
  eq(parseAskHistory('{坏 JSON'), [], 'C2 坏 JSON → **当没有**（辅助的东西坏了不许拖垮主流程）')
  eq(parseAskHistory('{"a":1}'), [], 'C2 不是数组 → 空')
  const h = parseAskHistory(
    JSON.stringify([
      { role: 'user', text: '为什么' },
      { role: 'assistant', text: '因为…' },
      { role: 'system', text: '删掉我' },
      { role: 'user', text: '  ' },
    ])
  )
  eq(h, [{ role: 'user', text: '为什么' }, { role: 'assistant', text: '因为…' }], 'C2 只留 user / assistant，空消息丢掉')
  eq(parseAskHistory(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: 'q' + i })))).length, 12, 'C2 最多带 12 条（不让人把一次调用顶爆）')
  yes(parseAskHistory(JSON.stringify([{ role: 'user', text: 'x'.repeat(9000) }]))[0].text.length <= 4001, 'C2 超长的那条被截断')
  eq(parseAskHistory([{ role: 'user', content: '用 content 字段也认' }]), [{ role: 'user', text: '用 content 字段也认' }], 'C2 content 字段也认')
}

/* C3. 回话剥壳：整段 ``` 围栏剥掉，正文里的围栏不许动 */
{
  eq(stripFence('```\n因为 $F=ma$\n```'), '因为 $F=ma$', 'C3 整段包着围栏 → 剥掉')
  eq(stripFence('```markdown\n因为\n```'), '因为', 'C3 带语言标记的围栏也剥')
  eq(stripFence('因为 $F=ma$'), '因为 $F=ma$', 'C3 没有围栏就一个字不动')
  const inner = '先看这段：\n```\ncode\n```\n就懂了'
  eq(stripFence(inner), inner, 'C3 正文中间的围栏是内容，不许剥（只剥整段外面那一层）')
}

/* C4. multipart 里按名字取第二张图（file2）—— 找得到、找不到给 null、二进制不被改写 */
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe])
  const { body, contentType } = buildFixtureMultipart([
    { name: 'file', filename: 'a.jpg', type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) },
    { name: 'mode', data: 'ask' },
    { name: 'file2', filename: 'b.jpg', type: 'image/jpeg', data: png },
    { name: 'question', data: '为什么' },
  ])
  const two = extractFilePartNamed(body, contentType, 'file2')
  yes(two && Buffer.compare(two.data, png) === 0, 'C4 按名字取到了 file2，而且**字节一模一样**（没被当字符串读坏）')
  no(extractFilePartNamed(body, contentType, 'file3'), 'C4 没有那个名字 → null（调用方退回单图，不报错）')
  /* 两张图都在同一个请求里时，"第一个文件"仍然是第一张 —— 服务端靠这个顺序说话
     （第一张整页、第二张裁图，见 ASK_PROMPT）。 */
  const one = extractFirstFile(body, contentType)
  yes(one && one.data[0] === 0xff && one.data[1] === 0xd8, 'C4 第一个文件仍然是第一张图（顺序没被 file2 打乱）')
}

/* C5. 那两句"只有一处"的话（按钮上的字、本地服务旧版时的提示） */
{
  yes(ASK_BUTTON.includes('问'), 'C5 按钮上的字里有"问"（自检靠它找按钮）')
  yes(/关掉再打开|重启/.test(ASK_STALE_HINT), 'C5 stale 提示说清了该怎么办（重启服务）')
  yes(/框选追问/.test(ASK_STALE_HINT), 'C5 提示里点名了是哪个功能没认出来')
}

/* 最小的 multipart 拼装（只给 C4 用）——**故意不 import 生产那份 `buildMultipart`**：
   那一个是"我们发给上游"用的，这一条要验的是"浏览器发给我们的"那一段能不能拆开。
   两边共用一个函数的话，"拆"这一半就永远遇不到真实形状的 body。 */
function buildFixtureMultipart(fields) {
  const b = '----askcheck7f3a'
  const parts = []
  for (const f of fields) {
    let head = `--${b}\r\nContent-Disposition: form-data; name="${f.name}"`
    if (f.filename) head += `; filename="${f.filename}"`
    head += '\r\n'
    if (f.filename || f.type) head += `Content-Type: ${f.type || 'application/octet-stream'}\r\n`
    head += '\r\n'
    parts.push(Buffer.from(head, 'utf8'))
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8'))
    parts.push(Buffer.from('\r\n', 'utf8'))
  }
  parts.push(Buffer.from(`--${b}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` }
}

/* "第一个文件部分"的最小实现（只给 C4 那条顺序断言用）。 */
function extractFirstFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  if (!m) return null
  const bBuf = Buffer.from('--' + (m[1] || m[2]).trim(), 'utf8')
  let pos = buf.indexOf(bBuf)
  while (pos >= 0) {
    const headEnd = buf.indexOf('\r\n\r\n', pos + bBuf.length)
    if (headEnd < 0) return null
    const header = buf.subarray(pos + bBuf.length, headEnd).toString('utf8')
    const dataStart = headEnd + 4
    const next = buf.indexOf(bBuf, dataStart)
    if (next < 0) return null
    let dataEnd = next
    if (buf[dataEnd - 2] === 0x0d && buf[dataEnd - 1] === 0x0a) dataEnd -= 2
    if (/filename="/.test(header)) return { data: buf.subarray(dataStart, dataEnd) }
    pos = next
  }
  return null
}

console.log(
  fails
    ? `\n${fails} 项失败（共 ${checks} 条断言）`
    : `\n全部通过（${checks} 条断言）—— 纯逻辑这一半没问题；两张图真的发出去、板上不变，看 npm run check:followup-browser`
)
process.exitCode = fails ? 1 : 0
