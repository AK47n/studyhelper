/* check-doc-read：「课件整理」这条链路上**不联网、不开浏览器**的那一半。
 *
 * 这一条链路里最容易出错的不是"能不能发出去"，而是**收回来之后怎么摆**：
 *   · 模型回的话要收成"讲解 + 重点 + 公式"（parseDocExtract / normalizeDocExtract）——
 *     它多写一条、少写一个 page、把空壳塞进来，落下去就是板上多一张莫名其妙的卡；
 *   · 讲解要摆成**贴着每一页**的两栏（projectDeck）：讲解在右、重点和公式在左 ——
 *     摆错的表现是"卡片和页面对不上"或者**卡片互相压住**，
 *     而板上"压住"不像纸上有重叠的边，你得一张张拖开才知道；
 *   · 一页的讲解比页面还高时，要把**下一页推开**（pageGaps）——
 *     不推的话滚下去就是"第 7 页的讲解挨着第 5 页"（用户 2026-09-20 当场指出来的）。
 *
 * 这三件都是**纯函数**，所以在这里逐条断言；真浏览器那一半（渲染、出网、
 * 点按钮、落盘）由 check:deck 那一路盯着（它有自己的夹具 PDF）。
 *
 * 用法：node scripts/check-doc-read.js   （或 npm run check:doc-read）
 */
import { readFileSync } from 'node:fs'
import {
  DOC_MAX_PER_BATCH,
  DOC_PAGE_CHARS_EST,
  MAX_FORMULAS,
  MAX_ITEMS_PER_PAGE,
  MAX_ITEMS_TOTAL,
  MAX_POINTS,
  ORIGIN_GAP,
  SIDE_W,
  buildBatches,
  cardText,
  formulaList,
  groupBySection,
  normalizeDocExtract,
  pagesLabel,
  parseDocExtract,
  parsePageSpec,
  pointLines,
  projectDeck,
  stripTexDelims,
} from '../src/lib/doc-cards.js'
import { DOC_PAGE_GAP, normalizeDoc, pageRects, serializeDoc } from '../src/lib/docs.js'
/* ★ 缓存键那两个纯函数（2026-10-06 加）。
 *   在此之前 `scripts/` 里**零处**引 `doc-read.js` —— 而这一族出过两次静默错
 *   （页集合漏在键外、键里不带 kind），两次都只有靠真浏览器自检撞出来。
 *   键的形状是纯函数，能直接断言，就不该只靠"跑一遍看看对不对"。 */
import { cacheKey, sumKeyOf, sumKeyHead, SUM_KINDS } from '../src/lib/doc-read.js'
/* 整节课的提纲那一半 —— 它和逐页那一套**是两个文件**（见 doc-summary.js 的文件头），
   所以这里也分两处 import，一眼看得出哪几条断言在盯哪一边。 */
import {
  MAX_MUST,
  MAX_PITFALLS,
  MAX_SECTIONS,
  SUMMARY_PARTS,
  isSummary,
  normalizeSummary,
  placeSummaryCard,
  summaryInput,
} from '../src/lib/doc-summary.js'
import { addUsage, hitRate, sumUsage, tokenText, usageText } from '../src/lib/usage.js'
import { DOC_PROMPT, SUMMARY_PROMPT } from '../server-ocr.js'

let fails = 0
let checks = 0
const ok = (m) => {
  checks += 1
  console.log('  ✓ ' + m)
}
const bad = (m) => {
  fails += 1
  console.log('  ✗ ' + m)
}
const eq = (got, want, label) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) ok(`${label}  →  ${a}`)
  else bad(`${label}\n      实际 ${a}\n      期望 ${b}`)
}
const yes = (cond, label) => (cond ? ok(label) : bad(label))

/* ── 一段真的像模型会回的课件 JSON（真跑起来它长这样）── */
const GOOD = JSON.stringify({
  page: 5,
  unit: '拉普拉斯变换',
  explain: '这一页把时域和复频域接上：与其在时间轴上解微分方程，不如换到 $s$ 平面上做代数。',
  points: ['把时域信号变成 $s$ 域信号', '微分方程变成代数方程'],
  formulas: ['$$F(s)=\\int_0^\\infty f(t)e^{-st}\\,dt$$'],
})

console.log('\n[1] 模型回的话 → 讲解 / 重点 / 公式（parseDocExtract / normalizeDocExtract）')
{
  /* 模型爱干的三件事：包围栏、前后说两句人话、以及"多回一个"。 */
  eq(!!parseDocExtract('```json\n' + GOOD + '\n```'), true, '包在 ```json 围栏里也认')
  eq(!!parseDocExtract('好的，这一页的内容是：\n' + GOOD + '\n希望有帮助'), true, '前后有人话也认（抠第一个 { 到最后一个 }）')
  eq(parseDocExtract('这一页我看不清'), null, '没有 JSON → null（调用方报 parse 失败，不猜）')
  eq(parseDocExtract(''), null, '空回话 → null')
  eq(parseDocExtract('[1,2,3]'), null, '回了个数组 → null（要的是对象）')

  const r = normalizeDocExtract(GOOD, { pages: [5] })
  eq(r.items.map((x) => x.kind), ['explain', 'points', 'formula'], '一页收成三样：讲解、重点、公式')
  eq(r.items[0].title, '拉普拉斯变换（第 5 页）', '讲解卡的标题 = 小节名 + 页号（换小节的那一页才有名字）')
  eq(r.items[0].body.startsWith('这一页把时域和复频域接上'), true, '讲解正文原样收下（里面那几个 $ 一个字都不动）')
  eq(r.items[1].title, '第 5 页 · 重点', '重点卡的标题 = 页号 · 重点')
  eq(r.items[1].body, '- 把时域信号变成 $s$ 域信号\n- 微分方程变成代数方程', '重点收成 `- ` 列表（一行一条，公式符号照留）')
  eq(r.items[2].tex, 'F(s)=\\int_0^\\infty f(t)e^{-st}\\,dt', '★ 公式的 $ 定界符剥掉了（公式卡的 tex 不带定界符，和 formula.js 同一条规矩）')
  eq(r.items[2].title, '', '公式卡不带标题（卡里只有那条式子）')
  eq(r.items.every((x) => x.page === 5), true, '三条都挂着页号（板上要能看出它出自哪一页）')
  eq(r.sections.length, 1, '一个节')
  eq(r.sections[0].name, '拉普拉斯变换', '节名来自 unit')
  eq(r.sections[0].pages, [5], '节上记着它出自第 5 页')
  eq(r.ok, true, '收得动 → ok')

  /* 没写 unit 的那一页：标题退回"第 N 页 · 讲解"，内容照样收下。 */
  const rNoUnit = normalizeDocExtract({ page: 2, explain: '这一页在讲概念。', points: ['甲'] }, { pages: [2] })
  eq(rNoUnit.items[0].title, '第 2 页 · 讲解', '没写 unit → 标题退回"第 N 页 · 讲解"')
  eq(rNoUnit.sections[0].name, '', '节名是空串（**不硬凑"未命名"**）')

  /* 页码错了要多半能救回来：模型把 page 写成字符串、或者写了个不在这批里的页号。 */
  const rPage = normalizeDocExtract({ page: '5', unit: '甲', explain: 'x' }, { pages: [5, 6] })
  eq(rPage.items[0].page, 5, 'page 是字符串 "5" 也认（模型经常这么回）')
  const rBadPage = normalizeDocExtract({ page: 999, explain: 'x' }, { pages: [7] })
  eq(rBadPage.items[0].page, 7, '★ 回了一个不在这批里的页号 → 落到这一批的页上（不能因此把内容丢了）')

  /* 第二档形状：模型偶尔"把好几页塞在一个回包里" —— 那个形状信息一点不少，认它。 */
  const rAlt = normalizeDocExtract(
    { pages: [{ page: 3, unit: '乙', explain: '讲第三页' }, { page: 4, explain: '讲第四页' }] },
    { pages: [3, 4] }
  )
  eq(rAlt.items.length, 2, '按页组织的形状也认（不为一个字段名把整批判失败）')
  eq(rAlt.items.map((x) => x.page), [3, 4], '两页各归各的页号')
  eq(rAlt.sections[0].name, '乙', '那一档的 unit 也当节名用')
  eq(rAlt.sections.length, 1, '第二页没写 unit → 沿用上一节（不重开一节）')

  /* 上限：重点 ≤6 条、公式 ≤4 条、一页 ≤6 件、总量 ≤400。 */
  const many = { page: 1, explain: '讲一讲这一页。', points: Array.from({ length: MAX_POINTS + 3 }, (_, i) => '第' + i + '条') }
  const rMany = normalizeDocExtract(many, { pages: [1] })
  eq(rMany.items.length, 2, `重点再多也只出一张卡（收成 ${MAX_POINTS} 条以内的一栏文字）`)
  eq([...rMany.items[1].body.matchAll(/^- /gm)].length, MAX_POINTS, `重点那一栏最多 ${MAX_POINTS} 条`)
  const form = { page: 1, formulas: Array.from({ length: MAX_FORMULAS + 3 }, (_, i) => 'x_' + i) }
  eq(normalizeDocExtract(form, { pages: [1] }).items.length, MAX_FORMULAS, `公式最多 ${MAX_FORMULAS} 条`)
  const huge = { pages: Array.from({ length: MAX_ITEMS_TOTAL + 20 }, (_, i) => ({ page: i + 1, explain: 'x' })) }
  const rHuge = normalizeDocExtract(huge, { pages: Array.from({ length: MAX_ITEMS_TOTAL + 20 }, (_, i) => i + 1) })
  yes(rHuge.items.length <= MAX_ITEMS_TOTAL, `总条数被 ${MAX_ITEMS_TOTAL} 卡住（实际 ${rHuge.items.length}）`)
  yes(rHuge.dropped > 0, '超出的也报数了（' + rHuge.dropped + ' 条）')
  yes(MAX_ITEMS_PER_PAGE >= 2 + MAX_FORMULAS, `每页上限（${MAX_ITEMS_PER_PAGE}）装得下"讲解 + 重点 + ${MAX_FORMULAS} 条公式"`)

  /* 真空页：封面、目录、过渡页本来就是"没什么可讲" —— 不出卡，也**不算失败**。 */
  const rEmpty = normalizeDocExtract('{"page":1,"explain":"","points":[]}', { pages: [1] })
  eq(rEmpty.items.length, 0, '空页收成 0 条')
  eq(rEmpty.ok, true, '★ 空页是 ok（不是 parse 失败）—— 界面上不该报红')
  eq(rEmpty.dropped, 0, '空页不报"丢了几条"')
  yes(rEmpty.notes.some((n) => /没有可讲的内容/.test(n)), '但记了一句"这页没有可讲的内容"（窗口里显示它）')

  /* 有名字但一条内容都没有的节：不留空壳，但**报数**。 */
  const rHollow = normalizeDocExtract({ pages: [{ page: 4, unit: '空节' }] }, { pages: [4] })
  eq(rHollow.sections.length, 0, '一条内容都没有的节不留空壳')
  yes(rHollow.notes.length > 0, '但报了一句（模型那一节什么都没讲，用户该知道）')

  /* id 要接着编（跨批次不撞号），不然同一批卡片在 React 里会串。 */
  const a1 = normalizeDocExtract(GOOD, { pages: [5], startId: 0 })
  const a2 = normalizeDocExtract(GOOD, { pages: [6], startId: a1.nextId })
  const ids = [...a1.items, ...a2.items].map((x) => x.id)
  eq(new Set(ids).size, ids.length, '★ 两批之间的 id 不撞号（nextId 接得上）')
}

console.log('\n[1b] 两个小工具：重点行 / 公式清单 / 剥定界符')
{
  eq(pointLines(['甲', { title: '乙' }, '', null]), '- 甲\n- 乙', '重点是字符串数组：每行加 `- `，空壳丢掉')
  eq(pointLines('就一条'), '- 就一条', '只给一条字符串也认')
  eq(formulaList(['a', { tex: 'b' }, '']), ['a', 'b'], '公式收成 tex 数组（字符串或 {tex} 都认）')
  eq(stripTexDelims('$$x^2$$'), 'x^2', '$$ 定界符剥掉')
  eq(stripTexDelims('$x^2$'), 'x^2', '$ 定界符剥掉')
  eq(stripTexDelims('\\[x^2\\]'), 'x^2', '\\[ \\] 也剥')
  eq(stripTexDelims('x^2'), 'x^2', '本来就没有定界符 → 原样')
}

console.log('\n[2] 标题 + 正文合成一张卡（cardText）')
{
  eq(cardText({ title: '定义', body: '一句话' }), '定义\n\n一句话', '标题和正文之间空一行（板上 pre-wrap，空行就是段落）')
  eq(cardText({ title: '只有标题', body: '' }), '只有标题', '只有标题就只写标题')
  eq(cardText({ title: '', body: '只有正文' }), '只有正文', '只有正文就只写正文')
  eq(cardText({ title: '  定义  ', body: '  一句话  ' }), '定义\n\n一句话', '两头的空白收掉')
  eq(cardText({ title: '定义', body: 'a\r\nb\u3000c' }), '定义\n\na\nb c', 'CRLF 归一、全角空格当半角（只做"看着一样"的清洗）')
}

console.log('\n[3] 连着几页讲同一件事 → 一个小节（groupBySection）')
{
  const g = groupBySection([
    { page: 1, unit: '第一节', items: [{ id: 'i1' }] },
    { page: 2, unit: '', items: [{ id: 'i2' }] }, // 空 = 还在上一节
    { page: 3, unit: '第一节', items: [{ id: 'i3' }] }, // 名字一样 → 还是同一节
    { page: 4, unit: '第二节', items: [{ id: 'i4' }] },
  ])
  eq(g.units.length, 2, '四页拼成两节')
  eq(g.units[0].pages, [1, 2, 3], '空 unit 和同名 unit 都并进上一节（名字在换小节那一页才写）')
  eq(g.units[1].pages, [4], '换了名字就开新的一节')
  eq(g.items.map((x) => x.unitId), ['du1', 'du1', 'du1', 'du2'], '★ 每条内容都带 unitId（窗口按它显示小节）')
  eq(g.items.length, 4, '一条都不丢')

  const g2 = groupBySection([
    { page: 9, unit: '', items: [{ id: 'x' }] },
    { page: 10, unit: '乙', items: [] },
  ])
  eq(g2.units.length, 2, '第一页就没名字 → 开一个无名节（**不把后面的名字追认给它**）')
  eq(g2.units[0].name, '', '无名节的名字是空串')
  eq(g2.units[1].name, '乙', '第二页的名字归它自己')
  eq(groupBySection([]).units.length, 0, '空输入不崩')
}

console.log('\n[4] 讲解 → 板上的卡片：贴着每一页的两栏（projectDeck）')
{
  /* 三页的资料，每页 720×540，页间距 20（和 docs.js 的 DOC_PAGE_GAP 对齐） */
  const rects = [0, 1, 2].map((i) => ({ x: 100, y: 200 + i * (540 + DOC_PAGE_GAP), w: 720, h: 540 }))
  const items = [
    { id: 'e2', kind: 'explain', title: '第 2 页 · 讲解', body: '讲第二页' },
    { id: 'p2', kind: 'points', title: '第 2 页 · 重点', body: '- 甲\n- 乙' },
    { id: 'f2', kind: 'formula', tex: 'x=1' },
    { id: 'e3', kind: 'explain', title: '第 3 页 · 讲解', body: '讲第三页' },
  ]
  const sizes = { e2: { w: SIDE_W, h: 400 }, p2: { w: SIDE_W, h: 200 }, f2: { w: 160, h: 40 }, e3: { w: SIDE_W, h: 400 } }
  const plan = projectDeck({
    pages: [{ page: 2, items: items.slice(0, 3) }, { page: 3, items: items.slice(3) }],
    sizes,
    rects,
  })
  eq(plan.cards.length, 4, '四条内容 → 四张卡')
  const e2 = plan.cards.find((c) => c.itemId === 'e2')
  const p2 = plan.cards.find((c) => c.itemId === 'p2')
  const f2 = plan.cards.find((c) => c.itemId === 'f2')
  eq(e2.side, 'right', '讲解在**右**边')
  eq(e2.x, rects[1].x + rects[1].w + ORIGIN_GAP, '讲解卡的 x = 资料右边缘 + 缝')
  eq([p2.side, f2.side], ['left', 'left'], '重点和公式在**左**边')
  eq(p2.x, rects[1].x - ORIGIN_GAP - SIDE_W, '重点卡右对齐到资料左边缘')
  eq(f2.x, rects[1].x - ORIGIN_GAP - 160, '★ 宽公式往**左**长（右边缘贴住资料，不啃页面）')
  eq([e2.y, p2.y, f2.y], [rects[1].y, rects[1].y, rects[1].y + 200 + 18], '两栏都从**页顶**开始，同栏里从上往下排')
  eq(plan.cards.find((c) => c.itemId === 'e3').y, rects[2].y, '★ 下一页也从**它自己的页顶**开始（不跟着上一栏往下流）')
  eq(plan.skipped, 0, '四条都有尺寸 → 一条都没跳过')
  yes(plan.cards.every((c) => c.w > 0 && c.h > 0), '每张卡都有正的宽高')

  /* ★ 讲解比页面还高 → 把下一页**推开**（pageGaps + 返回加过空的 rects）。 */
  const tall = { e2: { w: SIDE_W, h: 900 }, p2: { w: SIDE_W, h: 200 }, f2: { w: 160, h: 40 }, e3: { w: SIDE_W, h: 100 } }
  const planTall = projectDeck({
    pages: [{ page: 2, items: items.slice(0, 3) }, { page: 3, items: items.slice(3) }],
    sizes: tall,
    rects,
  })
  yes(planTall.pageGaps[1] > 0, `讲解比页面高 → 第 2 页后面留空 ${planTall.pageGaps[1]}（把第 3 页推开）`)
  eq(planTall.pageGaps[0], undefined, '第 1 页没整理过 → 不留空（不动老版面的一个字节）')
  eq(planTall.rects[2].y, rects[2].y + planTall.pageGaps[1], '★ 返回的 rects 是**加过空之后**的位置（挪视野要用它）')
  const e3t = planTall.cards.find((c) => c.itemId === 'e3')
  eq(e3t.y, planTall.rects[2].y, '★ 第 3 页的卡也跟着它被推开后的页顶（卡和页面永远对齐）')
  yes(e3t.y >= planTall.cards.find((c) => c.itemId === 'e2').y + tall.e2.h, '★ 两块地**不重叠**（被推开的意义）')

  /* 讲解没比页面高 → 一个字节都不推。 */
  const short = { e2: { w: SIDE_W, h: 100 }, p2: { w: SIDE_W, h: 100 }, f2: { w: 160, h: 40 }, e3: { w: SIDE_W, h: 100 } }
  const planShort = projectDeck({
    pages: [{ page: 2, items: items.slice(0, 3) }, { page: 3, items: items.slice(3) }],
    sizes: short,
    rects,
  })
  yes(!planShort.pageGaps.some((g) => g > 0), '一行都装得下 → 不留空（版面还是原来那样）')
  eq(planShort.rects[2].y, rects[2].y, '页面位置一个字节没动')

  /* ★ 缺尺寸的条目不摆：按估的尺寸摆下去 = 卡片互相压住，而板上压住看不出来。 */
  const plan2 = projectDeck({
    pages: [{ page: 2, items: items.slice(0, 3) }],
    sizes: { e2: { w: SIDE_W, h: 400 }, f2: { w: 160, h: 40 } },
    rects,
  })
  eq(plan2.skipped, 1, '缺尺寸的那条被跳过并报数')
  yes(!plan2.cards.some((c) => c.itemId === 'p2'), '它没有出现在卡片里（宁可少一张，也不要一张压住别人的卡）')

  /* 页号在资料里找不到（对不上/越界）→ 报出来，别猜一个位置摆下去。 */
  const plan3 = projectDeck({ pages: [{ page: 99, items: [items[0]] }], sizes, rects })
  eq(plan3.cards.length, 0, '页号越界 → 一张都不摆')
  eq(plan3.noRect, [99], '★ 但把那一页报出来（界面上说一句"那几页的讲解没贴"）')

  /* 公式卡带的是 src/tex（不是 text）—— 落卡那一侧靠这个分公式卡和文字卡。 */
  eq(f2.tex, 'x=1', '公式卡带 tex')
  eq(f2.text, undefined, '公式卡**不带** text（带了两边会打架）')
  yes(typeof e2.text === 'string' && e2.text.includes('讲第二页'), '讲义卡带 text（标题 + 正文拼好的一段）')

  /* 同栏里不许重叠（这是这个功能最容易出、也最难发现的一种错）。 */
  const many = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'points', title: '第 2 页 · 重点', body: '- x' }))
  const manySizes = Object.fromEntries(many.map((m) => [m.id, { w: SIDE_W, h: 220 }]))
  const plan4 = projectDeck({ pages: [{ page: 2, items: many }], sizes: manySizes, rects })
  const col = plan4.cards.filter((c) => c.side === 'left').sort((a, b) => a.y - b.y)
  const overlaps = []
  for (let i = 1; i < col.length; i += 1) if (col[i].y < col[i - 1].y + col[i - 1].h) overlaps.push([col[i - 1].itemId, col[i].itemId])
  eq(overlaps, [], '★ 同一栏里没有一张卡压住另一张')
  yes(plan4.bounds && plan4.bounds.h > 0 && plan4.bounds.w > 0, 'bounds 算得出来（给"贴完看到它们在哪儿"用）')
}

console.log('\n[4b] 资料的"每页多占的空"（docs.js 的 pageGaps）往返得住')
{
  const doc = normalizeDoc({ path: '.资料/甲.pdf', pages: [[720, 540], [720, 540], [720, 540]], pageGaps: [, 370] })
  eq(doc.pageGaps, [0, 370, 0], '稀疏数组归一成"每页一个数"（不许把 null 写进板文件）')
  eq(pageRects(doc)[2].y, 2 * (540 + DOC_PAGE_GAP) + 370, '★ 第三页被第 2 页多占的空推下去了')
  eq(serializeDoc(doc).pageGaps, [0, 370, 0], '写盘时原样写出（读→存一致）')
  const plain = normalizeDoc({ path: '.资料/乙.pdf', pages: [[720, 540]] })
  eq(plain.pageGaps, undefined, '没有空的资料不带这个字段')
  eq(serializeDoc(plain).pageGaps, undefined, '★ 老文件/没整理过的资料写出来一个字节都不多（不留假 diff）')
  const trail = normalizeDoc({ path: '.资料/丙.pdf', pages: [[720, 540], [720, 540]], pageGaps: [100, 0] })
  eq(serializeDoc(trail).pageGaps, [100, 0], '末尾那个 0 留着（长度和页数对齐，读回来才知道哪一页有）')
  eq(pageRects(trail)[1].y, 540 + DOC_PAGE_GAP + 100, '第一页后面的空照样生效')
}

console.log('\n[5] 页码的说法与解析（pagesLabel / parsePageSpec）')
{
  eq(pagesLabel([1, 2, 3, 5, 7, 8, 9]), '第 1-3、5、7-9 页', '连着的页合成区间')
  eq(pagesLabel([9, 5, 6, 5]), '第 5-6、9 页', '乱序、重复的页先进统一遍再合成')
  eq(pagesLabel([]), '', '空 → 空串')
  eq(pagesLabel([3]), '第 3 页', '一页就是"第 3 页"')

  eq(parsePageSpec('1-5', { max: 49 }), [1, 2, 3, 4, 5], '区间')
  eq(parsePageSpec('1-5, 8, 10-12', { max: 49 }), [1, 2, 3, 4, 5, 8, 10, 11, 12], '逗号分开的混合写法')
  eq(parsePageSpec('3、5，7', { max: 49 }), [3, 5, 7], '顿号和全角逗号也当分隔符（中文输入法下这是常态）')
  eq(parsePageSpec('5-3', { max: 49 }), [3, 4, 5], '写反了也认（3 到 5）')
  eq(parsePageSpec('1-99999', { max: 49 }), Array.from({ length: 49 }, (_, i) => i + 1), '超过页数的部分被夹住（不许点出第 99999 页）')
  eq(parsePageSpec('abc', { max: 49 }), [], '看不懂的 → 空（界面提示"这个区间没看懂"，不瞎猜）')
  eq(parsePageSpec('', { max: 49 }), [], '空输入 → 空')
  eq(parsePageSpec('1-999999', { max: 0 }), [], '★ 手滑打一个超长区间 → 直接不认（不然展开几十万个数会把界面卡死）')
}

console.log('\n[6] 分批（buildBatches）—— 只按页数分会让长图那一批顶爆体积上限')
{
  eq(buildBatches([1, 2, 3, 4, 5, 6, 7, 8, 9]), [[1, 2, 3, 4], [5, 6, 7, 8], [9]], `一批最多 ${DOC_MAX_PER_BATCH} 页`)
  eq(buildBatches([]), [], '空的 → 没有批次')
  eq(buildBatches([0, -1, 'x', 3]), [[3]], '不是正数的页号一律丢掉（不许点到第 0 页）')
  /* ★ 体积那条线**独立**于页数：长图（竖版讲义扫出来的一页）一份就顶两页，
     所以把上限收紧到"两页就超"时，必须自己分家 —— 不然那一批发出去会被服务端拒掉。 */
  const byLen = buildBatches([1, 2, 3], { maxChars: DOC_PAGE_CHARS_EST * 2 })
  eq(byLen, [[1, 2], [3]], '★ 按合计字符数分批（不问页数）—— 长图那一批不会顶爆 8MB')
  const byLen2 = buildBatches([1, 2, 3], { maxChars: 1 })
  eq(byLen2, [[1], [2], [3]], '上限收到 1 → 一页一批')
  const all = buildBatches(Array.from({ length: 49 }, (_, i) => i + 1))
  eq(all.flat().length, 49, '49 页的课件一页都不丢')
  eq(all.flat().join(','), Array.from({ length: 49 }, (_, i) => i + 1).join(','), '页序不变')
}

console.log('\n[7] 提示词里那几条"讲出来好不好用"的规矩还在（DOC_PROMPT）')
{
  /* 提示词和收纳那一侧是**两处**：这边改了、那边不认，表现是"少了几样"（不报错，最难查）。
     所以把"两处必须对齐"的那几点钉在这儿。 */
  yes(/unit/.test(DOC_PROMPT), '提示词里有 unit（groupBySection 认的就是它）')
  yes(/"explain"/.test(DOC_PROMPT), '提示词里有 explain（讲解卡认的就是它）')
  yes(/"points"/.test(DOC_PROMPT), '提示词里有 points（重点卡认的就是它）')
  yes(/"formulas"/.test(DOC_PROMPT), '提示词里有 formulas（公式卡认的就是它）')
  yes(/page/.test(DOC_PROMPT), '提示词里有 page（页号要能回到原课件）')
  yes(/不要写这个字段/.test(DOC_PROMPT), '说清了"没换小节就不要写 unit"（不然每页都会重开一节）')
  yes(/LaTeX/.test(DOC_PROMPT), '公式要 LaTeX（公式卡排得出才有用）')
  yes(/250~400/.test(DOC_PROMPT), '讲解写明了长度（250~400 字 —— 太长会把版面撑开）')
  /* ★ 讲人话 + 式子要排出来：这两条是用户 2026-09-20 亲口提的，
     掉了的话模型会退回"堆辞藻"和"把式子写成生 LaTeX"。 */
  yes(/讲人话/.test(DOC_PROMPT), '★ 提示词里写着"讲人话"（用户明确要的）')
  yes(/\$…\$|一对 \$|\\\$/.test(DOC_PROMPT), '★ 提示词里说了行内公式用一对 $ 包起来（讲义卡按这个渲染）')
  yes(/\\text/.test(DOC_PROMPT), '提示词里说了式子里的中文要 \\text{} 包起来（不然排出来是斜体乱码）')
}

console.log('\n[8] 用量（src/lib/usage.js）—— 界面上"这一趟花了多少"那一行全靠它')
{
  /* 这一份是**纯**的，所以能在这儿一条条钉住。它要守住的是三件事：
     ① 加总要对（界面上那个数是逐页累加出来的）；
     ② **"读不到"不许变成"是 0"** —— 上游没回 usage 时是 null，不是一笔零账；
     ③ 数怎么念（token 是六位数起步，逐位读没有意义）。 */
  const a = { prompt: 1000, completion: 200, cached: 800, miss: 200, reasoning: 150, total: 1200 }
  const b = { prompt: 500, completion: 100, cached: 0, miss: 500, reasoning: 0, total: 600 }
  eq(addUsage(a, b), { prompt: 1500, completion: 300, cached: 800, miss: 700, reasoning: 150, total: 1800 }, '两笔逐字段相加')
  eq(addUsage(null, b), b, '一边是 null（那一页没出网）→ 等于另一笔')
  eq(addUsage(null, null), null, '★ 两笔都没有 → **null**，不是零账（"没读到"和"是 0"是两句不同的话）')
  eq(addUsage(undefined, {}), { prompt: 0, completion: 0, cached: 0, miss: 0, reasoning: 0, total: 0 }, '坏形状当零笔（不许 NaN 漏出去）')
  eq(sumUsage([]), null, '空数组 → null')
  eq(sumUsage([a, null, b]).prompt, 1500, '一串里夹着 null 也不影响（缓存命中的那几页就是 null）')
  eq(sumUsage([{ prompt: 1 }, { prompt: 2 }]).miss, 0, '缺的字段按 0 算，但整笔不是 null')

  eq(hitRate({ prompt: 1000, cached: 800 }), 0.8, '命中率 = cached / prompt')
  eq(hitRate({ prompt: 0, cached: 0 }), null, '没有输入 → null（不是 0%）')
  eq(hitRate(null), null, 'null → null')
  eq(hitRate({ prompt: 100, cached: 999 }), 1, '夹在 0~1（上游偶尔给怪数）')

  eq(tokenText(999), '999', '一万以下照原样')
  eq(tokenText(10000), '1.0万', '一万以上按"万"念一位小数')
  eq(tokenText(123456), '12.3万', '六位数也这么念')
  eq(tokenText(NaN), '0', '坏数不崩')

  /* 那一行字：这是用户真正看到的东西，形状也钉住。 */
  eq(usageText(a), '输入 1000（命中 80%） · 输出 200（其中思考 150）', '一行字：输入（命中率）+ 输出（其中思考）')
  eq(usageText({ prompt: 100, completion: 50, cached: 0, miss: 100, reasoning: 0 }), '输入 100 · 输出 50', '没有命中、没有思考时那两截都不写')
  eq(usageText({ prompt: 0, completion: 0 }), '', '★ 假账（全 0）→ 空串：那一行宁可不出现')
  eq(usageText(null), '', 'null → 空串')
}

console.log('\n[9] 整节课的提纲：模型那段话 → 一块卡（normalizeSummary）')
{
  /* ★ 这一节盯的是"提纲"这条第二趟的收纳：模型回的是六段 JSON，
     而我们要的是**一块卡**。四处最容易出错、且出错**不报错**的地方：
       ① 段名和卡上显示的段名对不上（屏幕上少一段，没人报错）；
       ② 式子没被收进正文（学生看到的是"核心式子：- "这种空行）；
       ③ 空的段还硬拼出一个标题（卡上出现"**易错**"下面一行都没有）；
       ④ 回了一段人话（不是 JSON）→ 必须走 blank，**不许**把那段人话当成提纲贴上去。 */
  const good = JSON.stringify({
    sections: [
      { name: '复指数', pages: '3-6', about: '为什么用复指数表示频率' },
      { name: '傅里叶级数', pages: '7-12', about: '把周期信号拆成频率分量' },
    ],
    flow: ['先立复指数这套语言，再拿它把周期信号拆开'],
    must: ['周期信号的频谱是离散的'],
    pitfalls: ['把基频和角频率搞混'],
    formulas: [{ tex: 'e^{j\\omega_0 t}', note: '单位频率分量' }],
    check: ['为什么周期信号的频谱是离散的？'],
  })
  const n = normalizeSummary(good)
  yes(n.ok, '★ 一整段规范的回话 → ok')
  eq(n.items.length, 1, '★ 收到**一块**提纲（不是六条 —— 分段是卡里的正文，不是六张卡）')
  eq(n.items[0].kind, 'summary', 'kind 是 summary（落卡那一侧靠它分流）')
  eq(n.items[0].page, 0, '★ page = 0：它不属于任何一页（摆版不许按页找它）')
  eq(n.items[0].sectionId, null, 'sectionId = null：它不属于任何一节')
  /* 六段的小标题都要出现在正文里 —— 屏幕上少一段 = 学生少读一段，而没人会报错。 */
  for (const short of ['骨架', '脉络', '必记', '易错', '核心式子', '自测']) {
    yes(n.items[0].body.includes(`**${short}**`), `正文里有「${short}」那一小段`)
  }
  yes(n.items[0].body.includes('第 3-6 页'), '骨架那一段带着页号（学生按它回原课件）')
  yes(n.items[0].body.includes('$$e^{j\\omega_0 t}$$'), '★ 核心式子写进正文了，而且是 `$$…$$`（richHtml 才排得出）')
  yes(n.items[0].body.includes('—— 单位频率分量'), '式子的说明跟在后面')

  /* ③ 空的段**不许**出现在卡上：只有"必记"有内容时，别的那几段连标题都不该有。 */
  const only = normalizeSummary(JSON.stringify({ must: ['只有这一条'] }))
  yes(only.ok, '只有一段有内容 → 也算 ok（缺什么就不写什么）')
  yes(only.items[0].body.includes('**必记**'), '有内容那一段在')
  yes(!only.items[0].body.includes('**骨架**') && !only.items[0].body.includes('**易错**'), '★ 空段**连标题都不出现**（不许拼出一个空壳标题）')

  /* ④ 回了一段人话（不是 JSON）：blank，**不是**把那段话当提纲。 */
  const prose = normalizeSummary('这节课主要讲了复指数和傅里叶级数，重点是……')
  yes(!prose.ok && prose.blank, '★ 回了一段人话 → blank（不当成提纲贴上去）')
  eq(prose.items.length, 0, 'blank 时一条都不产出')
  const fenced = normalizeSummary('```json\n' + good + '\n```')
  yes(fenced.ok, '★ 整段被 ``` 包着 → 先剥壳再认（模型老爱包）')
  eq(fenced.items.length, 1, '剥壳之后照样收到一块')
  eq(normalizeSummary('').blank, true, '空串 → blank')
  eq(normalizeSummary('{}').blank, true, '{} → blank（六个段一个都没有）')
  eq(normalizeSummary(null).blank, true, 'null → blank（不抛错）')

  /* 上限：超了的条数**要报出来**（"丢了东西"和"本来就没有"是两句不同的话）。 */
  const many = normalizeSummary(JSON.stringify({ must: Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 条`) }))
  eq(many.items[0].body.split('\n').filter((l) => l.startsWith('- ')).length, MAX_MUST, `必记夹在 ${MAX_MUST} 条`)
  yes(many.dropped > 0, '★ 超上限的条数报在 dropped 里（不是静默丢掉）')
}

console.log('\n[10] 提纲摆哪儿（placeSummaryCard）—— 第一页左边，而且**不推任何一页**')
{
  const rects = [{ x: 0, y: 0, w: 720, h: 540 }, { x: 0, y: 560, w: 720, h: 540 }]
  const spot = placeSummaryCard({ rects, used: null, w: SIDE_W, h: 300 })
  eq(spot.x, -SIDE_W - ORIGIN_GAP, '★ 贴着第一页左边（往左长，不啃页面）')
  eq(spot.y, 0, '空栏（used=null）→ 从第一页页顶起')
  eq(Object.keys(spot).sort(), ['h', 'w', 'x', 'y'], '★ 只回一个矩形 —— **没有 pageGap 这个字段**（提纲不把任何一页往下推）')

  /* 第一页左栏已经有东西（先贴过一张答案卡，`columnOccupancy` 会给一个底边的 y）
     → 接在它下面，不许压上去。 */
  const used = placeSummaryCard({ rects, used: 200, w: SIDE_W, h: 300 })
  yes(used.y > 200, '★ 第一页左栏已经有东西（used=200）→ 接在它下面（不压上去）')
  eq(placeSummaryCard({ rects: [], used: null, w: SIDE_W, h: 300 }), null, '课件不在板上（没有第一页）→ null')
  /* ⚠ 只有第二页有矩形也不该崩：判据取的是 rects[0]。 */
  eq(placeSummaryCard({ rects: [null, rects[1]], used: null, w: SIDE_W, h: 300 }), null, '第一页的矩形是空 → null（不把第二页当成第一页）')
  /* ⚠ `used` 是 0 这个值：**不能用 `used ? … : …` 判**（资料的 y 可以是负的，
     "0 = 栏顶还空着"和"0 = 已经有东西占到 0"必须分得开）。 */
  eq(placeSummaryCard({ rects, used: 0, w: SIDE_W, h: 300 }).y, 18, '★ used=0 走"已经占到 0"那条路（不是"空栏"）—— 0 是个真值')
}

console.log('\n[11] 交给提纲那一趟的输入（summaryInput）')
{
  /* ★ 这一节盯的是"提纲那一趟看到了什么"。它**只**该看到摘要，不该看到讲解全文 ——
     这不是省钱的优化，是那条"不许引入新事实"的护栏的**物理实现**：
     模型手里没有的东西，它编不出来。 */
  const items = [
    { kind: 'explain', title: '复指数（第 3 页）', body: '很长很长的一段讲解'.repeat(200), page: 3 },
    { kind: 'points', title: '第 3 页 · 重点', body: '- 复指数表示频率\n- 实部是余弦', page: 3 },
    { kind: 'formula', title: '', body: '', tex: 'e^{j\\omega t}', page: 3 },
    { kind: 'points', title: '第 4 页 · 重点', body: '- 频谱离散', page: 4 },
  ]
  const got = summaryInput(items, { units: [{ name: '复指数', pages: [3, 4] }], readPages: [3, 4] })
  yes(/第 3~4 页/.test(got.text), '抬头写了讲过的页区间')
  yes(/复指数：第 3、4 页/.test(got.text), '★ 小节名和它的页一起给了（骨架最靠得住的依据）')
  yes(/第 3 页/.test(got.text) && /复指数表示频率/.test(got.text), '每页的重点进去了')
  /* 式子：`formula` 那一条的 tex 被包成 `$…$` 写进去（**只包一层**）。
     ⚠ 判据里那个 `\\` 是**正则里的反斜杠**：tex 原文是 `e^{j\omega t}`，
       而 `new RegExp` 的字符串里要写 `\\\\omega` 才配得上 —— 别在断言里 match 中文
       （这条纪律的另一半），但反斜杠这处必须按正则走，不能按 `includes` 走。 */
  yes(/\$e\^\{j\\omega t\}\$/.test(got.text), '式子进去了（包成 $…$）')
  yes(!got.text.includes('很长很长的一段讲解'), '★ **讲解全文没有进去** —— 只给重点和式子（护栏靠这个立住）')
  yes(got.text.length < 1000, `整份摘要很短（实际 ${got.text.length} 字）—— 一节课的提纲不用重发一遍课件`)

  /* 截断：上限要比**摘要本身**还小才会触发（上面那份只有一百多字）——
     所以这里的上限是 40，不是 200（写成 200 的话它压根没超，"没截断"是真的，
     红的是**断言**：我一开始把上限设得比内容还大，于是这条永远不可能绿）。 */
  const cut = summaryInput(items, { readPages: [3, 4], maxChar: 40 })
  eq(cut.truncated, true, '超上限 → truncated 标出来')
  yes(cut.text.length <= 200, '夹住了上限（截断之后那几句提示也算在里面）')
  yes(/只给到了前一部分/.test(cut.text), '★ 截断了就**明说**（不许悄悄发半份，模型会以为课件就这么长）')
  const empty = summaryInput([], {})
  yes(!/undefined|NaN/.test(empty.text), '没内容时那份摘要也不出怪字')
}

console.log('\n[12] 提纲的提示词里那几条护栏还在（SUMMARY_PROMPT）')
{
  const p = SUMMARY_PROMPT
  yes(/只.{0,4}能看到下面这份内容|只能看到/.test(p), '★ 说清了"你只能看到这份内容"（护栏的第一句）')
  yes(/没出现过的东西，一个字都不许写/.test(p), '★ 铁律：不许引入这份内容之外的东西')
  yes(/"sections"/.test(p) && /"flow"/.test(p) && /"must"/.test(p), 'JSON 形状里的三段在（normalizeSummary 认的就是它们）')
  yes(/"pitfalls"/.test(p) && /"formulas"/.test(p) && /"check"/.test(p), '另外三段也在（易错 / 核心式子 / 自测）')
  yes(new RegExp(`最多 ${MAX_SECTIONS} 条`).test(p), `骨架的条数写在提示词里（${MAX_SECTIONS}）`)
  yes(new RegExp(`最多 ${MAX_MUST} 条`).test(p), `必记的条数写在提示词里（${MAX_MUST}）`)
  yes(new RegExp(`最多 ${MAX_PITFALLS} 条`).test(p), `易错的条数写在提示词里（${MAX_PITFALLS}）`)
  yes(/0~5 条/.test(p), '核心式子给了条数区间（0~5）')
  yes(/3~5 个问题/.test(p), '自测给了条数区间（3~5）')
  yes(/不要写答案/.test(p), '★ 自测**不要答案**（那是给学生自查的）')
  yes(/不带 \$ 定界符/.test(p), 'formulas 的 tex 不带 $（和 formulaList 那条一致）')
  /* ★ 这一条是"提纲不许退化成总结"的判据：那个词一出现，模型就会开始复述每一页。 */
  yes(/不许写"本节课介绍了/.test(p) || /本课件/.test(p), '★ 明说了不许写成"本节课介绍了…"那种总结腔')
  yes(!/^写一份总结/.test(p), '★ 提示词不是"写总结"的口径（CONTEXT.md 里那个词是留给别处的）')
}

console.log('\n[13] ★ 源码扫描：提纲那一半不许碰"一页一课"的账')
{
  /* ★★ 这一节是**为将来的人**写的，不是为现在这段代码。
   *
   * 提纲和逐页共用**一条**落卡的路（`placeDeckCards`），但它们的账是分开的：
   * 逐页靠 `pageGaps` 把下一页往下推，而提纲**不许推**（它不属于任何一页）。
   * 将来最可能有人做的事是："既然提纲也是卡，顺手让它也报个 pageGap 吧" ——
   * 那个改动**不会报任何错**：`projectDeck` 会照单全收，多出来的那点空只是让
   * 某几页往下挪了一点点，屏幕上看起来像"本来就这样"（正是 pageGaps 那个
   * "加了两遍"的老 bug 的同一形状）。所以用一条源码扫描把这条界线钉住。
   *
   * ⚠ 扫描**只针对 doc-summary.js**（那一半的家）：判据散在别处就没意义了 ——
   *   要守的就是"这一半里不许出现这个词"。 */
  const src = readFileSync(new URL('../src/lib/doc-summary.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  yes(!/pageGaps/.test(code), '★ doc-summary.js 的**代码**里没有 pageGaps（提纲不推任何一页 —— 铁律②）')
  yes(/placeSummaryCard/.test(code), '摆位函数 still here（placeSummaryCard）')
  /* 判据必须住在这一半（落卡那边靠 `isSummary` 分流，不写 kind 字面量）。 */
  yes(/export function isSummary/.test(code), '判据 isSummary 住在这儿')
  yes(/export const TEXT_KINDS/.test(code), '★ "哪些 kind 算讲义卡"这张表也住在这儿（加第四种只改这一处）')
  const cards = readFileSync(new URL('../src/lib/doc-cards.js', import.meta.url), 'utf8')
  yes(/TEXT_KINDS/.test(cards), '★ doc-cards.js 是**引**那张表，不是自己再列一遍')
  /* 单方向：doc-summary 不许引 doc-cards（引了就成环，vite 会炸但 node 自检不一定）。 */
  yes(!/from '\.\/doc-cards\.js'/.test(code), '★ doc-summary.js 不引 doc-cards.js（单方向，不成环）')
}

/* ══════════════ 缓存键：键的**形状**本身就是判据（2026-10-06 加）══════════════
 *
 * 这一段每一条都对着一个**真踩过的坑**，不是"跑一遍看着对"。
 * 这一族两次静默错的共同点：**键算错了，而界面有内容、不报错、也不说它是旧的** ——
 *   ① 页集合漏在键外（`doc-read.js` 那段长注释记着：先读 1、3 再读 1、2，
 *      直接命中那份旧的 ⇒ "屏幕上显示的是上 3 页的提纲"）；
 *   ② 键里不带 kind（须知显示成提纲的六段）。
 * 两次都只能靠真浏览器自检撞出来，因为键此前是**私有的** ——
 * 而"哪些页集合算同一份"是一个**纯函数问题**，本来就该能直接断言。
 */
{
  const P = '大物/电磁学/board-8.md'
  const P2 = '大物/电磁学/board-9.md'

  /* ── ① 逐页那一趟：路径 + 页号 ── */
  yes(cacheKey(P, 1) !== cacheKey(P, 2), '逐页：同一份课件的两页是两个键（否则第二页永远命中第一页）')
  yes(cacheKey(P, 1) !== cacheKey(P2, 1), '逐页：两份课件的同一页是两个键')
  yes(cacheKey(P, 1).includes(P), '逐页：键里带路径（认的是"哪一份课件"，不是"哪一页"）')
  yes(cacheKey(P, 1).endsWith('|1'), '逐页：页号在键的末尾（换页 = 换键）')

  /* ── ② 整节课那两张：页集合必须进键（历史 bug ①）── */
  const kA = sumKeyOf(P, [1, 2, 3])
  const kB = sumKeyOf(P, [1, 3, 2])
  yes(kA === kB, '整节课：页集合**排序去重**后算同一个键（1,2,3 和 1,3,2 是同一件事）')
  yes(sumKeyOf(P, [1, 2]) !== sumKeyOf(P, [1, 2, 3]), '★ 整节课：换一批页 → 换键（**页集合漏出键外时这里会红**，那正是 2026-09 的那个 bug）')
  yes(sumKeyOf(P, [1, 2]).includes('1,2'), '整节课：键里看得见是哪几页（不是只留个数）')
  yes(sumKeyOf(P, [1, 1, 2]) === sumKeyOf(P, [1, 2]), '整节课：重复的页算同一批（去重）')
  yes(sumKeyOf(P, [0, -1, 2]) === sumKeyOf(P, [2]), '整节课：0 和负页号不算页（页号 1 起）')

  /* ── ③ kind 必须进键（历史 bug ②）── */
  yes(sumKeyOf(P, [1, 2], 'docsum') !== sumKeyOf(P, [1, 2], 'rules'), '★ 整节课：提纲和须知是两个键（**漏了它，须知就显示成提纲的六段**）')
  yes(SUM_KINDS.includes('docsum') && SUM_KINDS.includes('rules'), '整节课：两张卡的名字是那一个模块常量（别处不写裸字符串）')

  /* ── ④ 路径要进键（否则清一份会误伤别的一份）── */
  yes(sumKeyOf(P, [1, 2]) !== sumKeyOf(P2, [1, 2]), '整节课：两份课件的两个键不同')

  /* ── ⑤ 「重新生成」按前缀清：清这一份 = 这两份课件互不误伤 ── */
  yes(sumKeyHead(P).startsWith(sumKeyHead(P2)) === false, '前缀：两份课件的前缀不同（清 A 不会删到 B）')
  yes(sumKeyOf(P, [1, 2], 'rules').startsWith(sumKeyHead(P)), '★ 前缀：须知那条键也归这一份（前缀**不含 kind** ⇒「↻ 重新生成」把两张都清了，这是要的）')
  yes(sumKeyOf(P2, [1], 'rules').startsWith(sumKeyHead(P)) === false, '前缀：B 的键不在A 的前缀里')
  /* 页号非法 / 空页集合也要算得出一个键（不许抛）—— 清缓存那条路会遍历它们。 */
  yes(typeof sumKeyOf(P, []) === 'string' && sumKeyOf(P, []).length > 0, '整节课：空页集合也算得出键（不抛）')
}

console.log('\n' + '─'.repeat(56))
if (fails) {
  console.log(`  ${checks} 项通过，${fails} 项失败`)
  process.exit(1)
} else {
  console.log(`  全部 ${checks} 项通过`)
}
