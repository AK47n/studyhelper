/* check-doc-read：「课件整理」这条链路上**不联网、不开浏览器**的那一半。
 *
 * 这一条链路里最容易出错的不是"能不能发出去"，而是**收回来之后怎么摆**：
 *   · 模型回的话要收成知识点（parseDocExtract / normalizeDocExtract）——
 *     它多写一条、少写一个 page、把空壳塞进来，落下去就是板上多一张莫名其妙的卡；
 *   · 知识点要摆成卡片（projectDeck）—— 摆错的表现是**卡片互相压住**，
 *     而板上"压住"不像纸上有重叠的边，你得一张张拖开才知道；
 *   · "连着几页讲同一件事"要拼成一个小节（groupBySection）——
 *     拼错就是板上散出 8 张名字一样的小节卡。
 *
 * 这三件都是**纯函数**，所以在这里逐条断言；真浏览器那一半（渲染、出网、
 * 点按钮、落盘）由 check:doc 那一路盯着（它有自己的夹具 PDF）。
 *
 * 用法：node scripts/check-doc-read.js   （或 npm run check:doc-read）
 */
import {
  DOC_MAX_PER_BATCH,
  DOC_PAGE_CHARS_EST,
  MAX_ITEMS_PER_PAGE,
  MAX_ITEMS_TOTAL,
  buildBatches,
  cardText,
  groupBySection,
  normalizeDocExtract,
  pagesLabel,
  parseDocExtract,
  parsePageSpec,
  projectDeck,
  sectionHeading,
} from '../src/lib/doc-cards.js'
import { DOC_PROMPT } from '../server-ocr.js'

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
  points: [
    { kind: 'note', title: '定义', body: '把时域信号变成复频域信号，$s=\\sigma+j\\omega$。' },
    { kind: 'formula', tex: '$$F(s)=\\int_0^\\infty f(t)e^{-st}\\,dt$$' },
    { kind: 'note', title: '', body: '' },
  ],
})

console.log('\n[1] 模型回的话 → 知识点（parseDocExtract / normalizeDocExtract）')
{
  /* 模型爱干的三件事：包围栏、前后说两句人话、以及"多回一个"。 */
  eq(!!parseDocExtract('```json\n' + GOOD + '\n```'), true, '包在 ```json 围栏里也认')
  eq(!!parseDocExtract('好的，这一页的内容是：\n' + GOOD + '\n希望有帮助'), true, '前后有人话也认（抠第一个 { 到最后一个 }）')
  eq(parseDocExtract('这一页我看不清'), null, '没有 JSON → null（调用方报 parse 失败，不猜）')
  eq(parseDocExtract(''), null, '空回话 → null')
  eq(parseDocExtract('[1,2,3]'), null, '回了个数组 → null（要的是对象）')

  const r = normalizeDocExtract(GOOD, { pages: [5] })
  eq(r.items.length, 2, '两条真知识点收下了（**空壳那条被丢掉** —— 标题正文都空）')
  eq(r.dropped, 1, '丢掉的那条**报数**（不静默）')
  eq(r.sections.length, 1, '一个节')
  eq(r.sections[0].name, '拉普拉斯变换', '节名来自 unit')
  eq(r.sections[0].pages, [5], '节上记着它出自第 5 页')
  eq(r.items[0].page, 5, '每条知识点也挂着页号（板上要能看出它出自哪一页）')
  eq(r.items[0].kind, 'note', '第一条是文字卡')
  eq(r.items[1].kind, 'formula', '第二条是公式卡')
  eq(r.items[1].tex, 'F(s)=\\int_0^\\infty f(t)e^{-st}\\,dt', '★ 公式的 $ 定界符剥掉了（公式卡的 tex 不带定界符，和 formula.js 同一条规矩）')
  eq(r.items[1].title, '', '公式卡不带标题（卡里只有那条式子）')
  eq(r.ok, true, '收得动 → ok')

  /* 页码错了要多半能救回来：模型把 page 写成字符串、或者写了个不在这批里的页号。 */
  const rPage = normalizeDocExtract(
    { page: '5', unit: '甲', points: [{ kind: 'note', title: 't', body: 'b', page: '5' }] },
    { pages: [5, 6] }
  )
  eq(rPage.items[0].page, 5, 'page 是字符串 "5" 也认（模型经常这么回）')
  const rBadPage = normalizeDocExtract({ page: 999, points: [{ kind: 'note', title: 't', body: 'b' }] }, { pages: [7] })
  eq(rBadPage.items[0].page, 7, '★ 回了一个不在这批里的页号 → 落到这一批的页上（不能因此把内容丢了）')

  /* 一页最多 4 条：超了**丢掉并报数** —— 白板的空间是有限的资源。 */
  const many = { points: Array.from({ length: MAX_ITEMS_PER_PAGE + 3 }, (_, i) => ({ kind: 'note', title: '第' + i + '条', body: 'x' })) }
  const rMany = normalizeDocExtract(many, { pages: [1] })
  eq(rMany.items.length, MAX_ITEMS_PER_PAGE, `一页最多收 ${MAX_ITEMS_PER_PAGE} 条`)
  eq(rMany.dropped, 3, '超出的 3 条报数（用户该知道自己少拿到了什么）')

  /* 总量上限：49 页的课件真跑起来能回来两三百条，全贴上就不是"起点"了。 */
  const huge = { sections: [{ name: '一大节', items: Array.from({ length: 400 }, (_, i) => ({ kind: 'note', title: 't' + i, body: 'b' })) }] }
  const rHuge = normalizeDocExtract(huge, { pages: [1] })
  yes(rHuge.items.length <= MAX_ITEMS_TOTAL, `总条数被 ${MAX_ITEMS_TOTAL} 卡住（实际 ${rHuge.items.length}）`)
  yes(rHuge.dropped > 0, '超出的也报数了（' + rHuge.dropped + ' 条）')

  /* 第二档形状：模型偶尔"按页组织"（它自己觉得更自然）—— 那个形状信息一点不少，认它。 */
  const rAlt = normalizeDocExtract({ pages: [{ page: 3, unit: '乙', points: [{ kind: 'note', title: 'T', body: 'B' }] }] }, { pages: [3] })
  eq(rAlt.items.length, 1, '按页组织的形状也认（不为一个字段名把整批判失败）')
  eq(rAlt.sections[0].name, '乙', '那一档的 unit 也当节名用')

  /* 没写 unit 的一页：内容照样收下，只是没有节名（板上就不出那张小节卡）。 */
  const rNoUnit = normalizeDocExtract({ page: 2, points: [{ kind: 'note', title: 'T', body: 'B' }] }, { pages: [2] })
  eq(rNoUnit.items.length, 1, '没写 unit 照样收')
  eq(rNoUnit.sections[0].name, '', '节名是空串（**不硬凑"未命名"** —— 板上不出那张卡）')

  /* 真空页：`points: []` 是**合法答案**（封面、目录、过渡页），不是失败。 */
  const rEmpty = normalizeDocExtract('{"page":1,"points":[]}', { pages: [1] })
  eq(rEmpty.items.length, 0, '空页收成 0 条')
  eq(rEmpty.ok, true, '★ 空页是 ok（不是 parse 失败）—— 界面上不该报红')
  eq(rEmpty.dropped, 0, '空页不报"丢了几条"')

  /* 有名字但一条内容都没有的节：不留空壳，但**报数**（那一节模型什么都没读出来）。 */
  const rHollow = normalizeDocExtract({ sections: [{ name: '空节', items: [] }] }, { pages: [4] })
  eq(rHollow.sections.length, 0, '一条内容都没有的节不留空壳')
  yes(rHollow.notes.length > 0, '但报了一句（模型那一节什么都没读出来，用户该知道）')

  /* id 要接着编（跨批次不撞号），不然同一批卡片在 React 里会串。 */
  const a1 = normalizeDocExtract(GOOD, { pages: [5], startId: 0 })
  const a2 = normalizeDocExtract(GOOD, { pages: [6], startId: a1.nextId })
  const ids = [...a1.items, ...a2.items].map((x) => x.id)
  eq(new Set(ids).size, ids.length, '★ 两批之间的 id 不撞号（nextId 接得上）')
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
  eq(g.items.map((x) => x.unitId), ['du1', 'du1', 'du1', 'du2'], '★ 每条知识点都带 unitId（落卡要按节摆版）')
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

console.log('\n[4] 知识点 → 板上的卡片（projectDeck）')
{
  const sections = [{ id: 's1', name: '甲' }, { id: 's2', name: '乙' }]
  const items = [
    { id: 'a', sectionId: 's1', kind: 'note', title: 'A', body: 'aa' },
    { id: 'b', sectionId: 's1', kind: 'note', title: 'B', body: 'bb' },
    { id: 'c', sectionId: 's2', kind: 'note', title: 'C', body: 'cc' },
  ]
  const sizes = { a: { w: 300, h: 100 }, b: { w: 300, h: 100 }, c: { w: 300, h: 100 } }
  const plan = projectDeck({ sections, items, sizes, origin: { x: 1000, y: 200 }, columnH: 1500 })
  eq(plan.cards.length, 5, '两张小节卡 + 三张知识点卡')
  eq(plan.cards[0].heading, true, '第一节先摆小节卡')
  eq(plan.cards[0].text, '甲', '小节卡上写的是节名')
  eq(plan.cards[0].x, 1000, '从 origin 的 x 起摆')
  eq(plan.cards[1].x, 1000, '同一栏里 x 一样（栏是竖着长的）')
  yes(plan.cards[1].y > plan.cards[0].y, '第一条知识点在小节卡**下面**')
  yes(plan.cards[2].y > plan.cards[1].y, '同节的两条也从上到下排')
  eq(plan.skipped, 0, '三条都有尺寸 → 一条都没跳过')
  yes(plan.cards.every((c) => c.w > 0 && c.h > 0), '每张卡都有正的宽高（缺尺寸的不摆 —— 见下一条）')

  /* ★ 缺尺寸的条目**不摆**：按估的尺寸摆下去 = 卡片互相压住，而板上压住看不出来。 */
  const plan2 = projectDeck({ sections, items, sizes: { a: { w: 300, h: 100 }, c: { w: 300, h: 100 } }, origin: { x: 0, y: 0 } })
  eq(plan2.skipped, 1, '缺尺寸的那条被跳过并报数')
  yes(!plan2.cards.some((c) => c.itemId === 'b'), '它没有出现在卡片里（宁可少一张，也不要一张压住别人的卡）')

  /* 一栏超过 columnH 就开下一栏 —— 而且**新栏在第一栏右边**，不是接着往下堆。 */
  const tall = Array.from({ length: 8 }, (_, i) => ({ id: 't' + i, sectionId: 's1', kind: 'note', title: 'T' + i, body: 'x' }))
  const tallSizes = Object.fromEntries(tall.map((t) => [t.id, { w: 300, h: 300 }]))
  const plan3 = projectDeck({ sections: [{ id: 's1', name: '甲' }], items: tall, sizes: tallSizes, origin: { x: 0, y: 0 }, columnH: 1000 })
  const xs = [...new Set(plan3.cards.map((c) => c.x))].sort((a, b) => a - b)
  yes(xs.length >= 2, `摆成了 ${xs.length} 栏（一栏装不下就开下一栏）`)
  eq(xs[0], 0, '第一栏从 origin.x 起')
  yes(xs[1] > 300, '第二栏在第一栏**右边**（不是接着往下堆）')
  /* 同一栏里**不许重叠**：这是这个功能最容易出、也最难发现的一种错。 */
  const overlaps = []
  for (const col of xs) {
    const inCol = plan3.cards.filter((c) => c.x === col).sort((a, b) => a.y - b.y)
    for (let i = 1; i < inCol.length; i += 1) {
      if (inCol[i].y < inCol[i - 1].y + inCol[i - 1].h) overlaps.push([inCol[i - 1].itemId, inCol[i].itemId])
    }
  }
  eq(overlaps, [], '★ 同一栏里没有一张卡压住另一张')
  yes(plan3.bounds && plan3.bounds.h > 0 && plan3.bounds.w > 0, 'bounds 算得出来（给"贴完看到它们在哪儿"用）')

  /* ★ 小节卡**不许漂在栏底**（2026-09-22 自检在真浏览器里抓到的真 bug）：
     原来先 push 再判"这一栏放得下吗"，于是换栏之后小节卡留在上一栏底部、
     它下面那张卡去了新栏 —— 屏幕上多出一张孤零零的小节名。
     ⚠ 要逼出这一次换栏，栏高得让**第二条**放不进第一栏：
     两条 250 高、栏高 300 → 第一条和小节卡留在第一栏，第二条另起一栏
     （新栏顶上再摆一张小节卡，"接着上一栏的那一节"读得出来）。 */
  const tall2 = [{ id: 'b', sectionId: 's1', kind: 'note', title: 'B', body: '' }, { id: 'c', sectionId: 's1', kind: 'note', title: 'C', body: '' }]
  const sizes2 = { b: { w: 300, h: 250 }, c: { w: 300, h: 250 } }
  const p6 = projectDeck({ sections: [{ id: 's1', name: '甲' }], items: tall2, sizes: sizes2, origin: { x: 0, y: 0 }, columnH: 300 })
  const heads6 = p6.cards.filter((c) => c.heading)
  const b6 = p6.cards.find((c) => c.itemId === 'b')
  const c6 = p6.cards.find((c) => c.itemId === 'c')
  if (heads6.length === 2 && b6 && c6) {
    eq(heads6[0].x === b6.x, true, '★ 小节卡和它第一节的第一张卡在**同一栏**里（换栏要一起换）')
    yes(heads6[0].y < b6.y, '小节卡在它那节第一张卡**上面**')
    eq(c6.x > b6.x, true, '★ 第二条放不进第一栏 → 它去了**右边**新开的一栏（不是漂在下面）')
    eq(heads6[1].x === c6.x, true, '★ 新栏顶上又摆了一张小节卡（被切开的那一节读得出是同一节）')
    yes(heads6[1].y < c6.y, '新栏那张小节卡也在它那张卡上面')
  } else bad('换栏之后的小节卡不对：' + JSON.stringify(p6.cards.map((c) => [c.heading, c.itemId, c.x, c.y])))

  /* ★ 挂节的字段名认两个（`sectionId` 和 `unitId`）—— 2026-09-22 抓到的第三处真 bug：
     界面出来的是 unitId、落卡这一侧读的是 sectionId，于是每一条都落进 loose，
     小节名一个字都不上板（屏幕上只是"少了一张卡"，不报错）。 */
  const p7 = projectDeck({
    sections: [{ id: 's1', name: '甲' }],
    items: [{ id: 'a', unitId: 's1', kind: 'note', title: 'A', body: '' }],
    sizes: { a: { w: 300, h: 100 } },
    origin: { x: 0, y: 0 },
  })
  eq(p7.cards.filter((c) => c.heading).length, 1, '★ 只写 unitId（界面的叫法）也认得出它属于哪一节 —— 小节卡照样出')

  /* 公式卡带的是 src/tex（不是 text）—— 落卡那一侧靠这个分公式卡和文字卡。 */
  const plan4 = projectDeck({
    sections: [{ id: 's1', name: '' }],
    items: [{ id: 'f', sectionId: 's1', kind: 'formula', tex: 'a^2+b^2=c^2' }],
    sizes: { f: { w: 200, h: 60 } },
    origin: { x: 0, y: 0 },
  })
  eq(plan4.cards.length, 1, '没名字的节不出小节卡（只有那一条知识点）')
  eq(plan4.cards[0].tex, 'a^2+b^2=c^2', '公式卡带 tex')
  eq(plan4.cards[0].text, undefined, '公式卡**不带** text（带了两边会打架）')
  eq(sectionHeading({ name: '甲' }), '甲', 'sectionHeading 取节名')
  eq(sectionHeading({ name: '' }), '', '空节名 → 空串（调用方据此不出小节卡）')
  eq(sectionHeading(null), '', 'null 也不崩')

  /* 没有节归属的条目（手改过 items？）挂在最后，别丢。 */
  const plan5 = projectDeck({
    sections: [{ id: 's1', name: '甲' }],
    items: [{ id: 'a', sectionId: 's1', kind: 'note', title: 'A', body: '' }, { id: 'z', sectionId: 'nope', kind: 'note', title: 'Z', body: '' }],
    sizes: { a: { w: 200, h: 50 }, z: { w: 200, h: 50 } },
    origin: { x: 0, y: 0 },
  })
  eq(plan5.cards.filter((c) => !c.heading).length, 2, '没有节归属的那条也摆上去了（不丢内容）')
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
  eq(parsePageSpec('1-99999', { max: 49 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49], '超过页数的部分被夹住（不许点出第 99999 页）')
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

console.log('\n[7] 提示词里那几条"贴上去好不好用"的规矩还在（DOC_PROMPT）')
{
  /* 提示词和落卡是**两处**：这边改了、那边不认，表现是"少了几条"（不报错，最难查）。
     所以把"两处必须对齐"的那几点钉在这儿。 */
  yes(/unit/.test(DOC_PROMPT), '提示词里有 unit（groupBySection 认的就是它）')
  yes(/points/.test(DOC_PROMPT), '提示词里有 points（normalizeDocExtract 认的就是它）')
  yes(/kind.*formula/.test(DOC_PROMPT), '提示词里有 kind:formula（公式要落成公式卡）')
  yes(/0~4 条/.test(DOC_PROMPT), `提示词里写明了每页 0~4 条（和 MAX_ITEMS_PER_PAGE=${MAX_ITEMS_PER_PAGE} 对齐）`)
  yes(/page/.test(DOC_PROMPT), '提示词里有 page（页号要能回到原课件）')
  yes(/不要写这个字段/.test(DOC_PROMPT), '说清了"没换小节就不要写 unit"（不然每页都会重开一节）')
  yes(/LaTeX/.test(DOC_PROMPT), '公式要 LaTeX（公式卡排得出才有用）')
  yes(!/\$/.test(DOC_PROMPT.split('规则')[0]), '回话格式那一段里的 tex **不带 $ 定界符**（和 stripTexDelims 对齐）')
}

console.log('\n' + '─'.repeat(56))
if (fails) {
  console.log(`  ${checks} 项通过，${fails} 项失败`)
  process.exit(1)
} else {
  console.log(`  全部 ${checks} 项通过`)
}
