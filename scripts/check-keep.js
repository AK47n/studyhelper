/* check-keep：**「留到板上」**那条路上的纯逻辑（不出网、不开浏览器）。
 *
 * 它管的是 2026-09-22 加的那件事（完整设计见 **ADR-0006**）：
 * 追问 / 作业里的某一轮问答 → 课件页边的一**张答案卡**。
 * 这里钉的都是"错了不会报错、只会安静出错"的那几件：
 *
 *   [A] **卡片的 `ask` 字段**（「这一问落在课件的哪一块」）——
 *       认不出的值硬凑进文件的话，读回来是一个指向别处的框；
 *       而"写得出去、读不回来"会让"存→读→再存"不一致（这个仓库最忌讳的假 diff）。
 *   [B] **板文件往返**：没有问过的卡一个字节都不多。
 *   [C] **留下的是什么**（answer-cards.js）：追问留哪几轮、题号题干答案解析的次序、
 *       太长要**报数**而不是静默截断。
 *   [D] **摆哪儿**（doc-cards.js 的 columnOccupancy / planAnswerCard）：
 *       答案接在讲解下面、空栏从页顶起、这一页该多留多少空。
 *   [E] **两条路同住一栏**：先留答案再整理课件，讲解**不许压在**答案卡上；
 *       以及 2026-09-22 修的那个"再整理一次，卡片一页比一页低"的回归。
 *   [F] **`pageGaps` 涨了 → 后面那些页上的卡片要跟着挪**（2026-09-23 修的
 *       「问这里后印上板子会让原本与ppt对齐的卡片错位」）。验收标准是
 *       "每张卡相对自己页顶的偏移一个字节都没变"。
 *
 * 跑：node scripts/check-keep.js   （或 npm run check:keep）
 * 真浏览器那一段（真点那颗按钮 → 板文件里真多一张卡 → Ctrl+Z 退得掉）在
 * check-followup-browser.js 与 check-homework-browser.js 里。
 *
 * ⚠ 这里 import 的全是纯函数：doc-cards.js / ask-region.js / answer-cards.js / board.js。
 *   一个会拉起 pdf.js 的都不许进来（"能被断言的住这边、要浏览器的住那边"）。
 */
import { parseBoardDocument, serializeBoardDocument, newBoard, newCard } from '../src/lib/board.js'
import { readFileSync } from 'node:fs'
import { ASK_MIN_FRAC, normalizeAsk, regionToWorld, serializeAsk } from '../src/lib/ask-region.js'
import {
  ANSWER_KIND,
  KEEP_BUTTON,
  KEPT_LABEL,
  MAX_ASK_A,
  MAX_ANSWER_TITLE,
  answerItem,
  askThreadText,
  homeworkText,
} from '../src/lib/answer-cards.js'
import { CARD_GAP_Y, ORIGIN_GAP, SIDE_W, columnOccupancy, pageGapDeltas, pageGapFor, planAnswerCard, projectDeck, shiftLaterPageCards } from '../src/lib/doc-cards.js'

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
const yes = (v, m) => (v ? ok(m) : bad(m))
const no = (v, m) => (!v ? ok(m) : bad(m))

/* ── 一份三页的夹具资料（页面全是 16:9，算术一眼看得清）────────────────────
   页面矩形**照 docs.js 的规矩摆**（页距 = 页高 + DOC_PAGE_GAP=20），
   不自己另算一套 —— 那样自检就和真跑的那条路分叉了。 */
const PX = 100
const PY = 200
const PW = 720
const PH = 540
const PGAP = 20
const RECTS = [0, 1, 2].map((i) => ({ x: PX, y: PY + i * (PH + PGAP), w: PW, h: PH }))
const RIGHT_X = PX + PW + ORIGIN_GAP
const LEFT_BAND = [PX - ORIGIN_GAP - SIDE_W, PX - ORIGIN_GAP]
/** 按当前 pageGaps 算页面矩形（和 docs.js 的 pageRects 同一条累加规矩）。 */
const rectsWith = (gaps) => {
  const out = []
  let y = PY
  for (let i = 0; i < 3; i += 1) {
    out.push({ x: PX, y, w: PW, h: PH })
    y += PH + PGAP + (Number(gaps[i]) || 0)
  }
  return out
}

console.log('\n[A] 卡片的 `ask` 字段：这一问落在课件的哪一块（ask-region.js）')

{
  const good = { doc: '.资料/普通物理.pdf', page: 2, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }
  eq(normalizeAsk(good), good, 'A1 正常的一份原样读出来（页码 / 页内矩形 / 哪一份课件）')
  eq(normalizeAsk({ ...good, page: '3' }), { ...good, page: 3 }, 'A2 页码是字符串 "3" 也认（手改文件常见）')
  eq(normalizeAsk({ ...good, page: 2.9 }), good, 'A3 页码取整（2.9 → 2，不写一个带小数的页号进文件）')
  /* ★ 内存里只有一种 region 形状：对象 `{x,y,w,h}`（和 findAskRegion 交出来的一样）——
     文件里那个数组形式在这儿转过来。两三种形状混着用的话，总有一处读 `.x` 读到 undefined，
     而屏幕上只是"高亮缩成一个点"，不报错（2026-09-22 真实栽过，见 regionToWorld 那段注释）。 */
  eq(normalizeAsk({ page: 2, region: [0.1, 0.2, 0.3, 0.4] }), { page: 2, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    'A3b★ 文件里的数组形式读回来**一定是对象**（少一层括号只活在文件里）')
  eq(serializeAsk({ page: 2, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }).region, [0.1, 0.2, 0.3, 0.4],
    'A3c 写出去的是紧凑数组（[x,y,w,h]，板文件里那种）')

  no(normalizeAsk(null), 'A4 没有这个字段 → null（不硬凑）')
  no(normalizeAsk({}), 'A5 空对象 → null')
  no(normalizeAsk({ page: 0 }), 'A6 页码 0 → null（页号是 1 起的）')
  no(normalizeAsk({ page: -3 }), 'A7 负页号 → null')
  no(normalizeAsk({ page: 'x' }), 'A8 页码认不出 → null')
  no(normalizeAsk([]), 'A9 数组不是这个字段的形状 → null')
  eq(normalizeAsk({ page: 2, region: [0, 0, 0.001, 0.001] }), { page: 2 },
    'A10★ 框**小到看不见**（宽高 < ' + ASK_MIN_FRAC + '）→ 丢掉**那个键**，页码照旧留着（出处还是记着的）')

  eq(normalizeAsk({ page: 2, doc: '某本书.pdf' }), { page: 2 }, 'A11 不是资料路径的 doc → 只留页码，**不写半个空键**')
  eq(normalizeAsk({ page: 2, doc: '.资料/x.docx' }), { page: 2 }, 'A12 不是 PDF 的路径同样丢掉（判据只有 docs.js 的 isDocPath 那一份）')
  eq(normalizeAsk({ page: 2, doc: '.资料/x.PDF' }), { doc: '.资料/x.PDF', page: 2 },
    'A12b 后缀大小写**是认的**（isDocPath 用的 `/\.pdf$/i`）—— 这条只是把那份判据钉在这儿，别自己另写一套')
  eq(normalizeAsk({ page: 2, region: null }), { page: 2 },
    'A10b 打字问作业那条路没有 region（`region: null`）→ 只记页码，别的什么都不写')
  eq(normalizeAsk({ page: 2, region: 'x' }), { page: 2 }, 'A13 region 认不出 → 只留页码')
  /* ⚠ 这里的期望值是**算出来的**（`1 - 0.9`），不是 0.1：夹那一步是浮点减法，
     写死 0.1 就成了"断言一个计算机给不出的数"。量化到 4 位是**出关**那一步的事（A14b）。 */
  eq(normalizeAsk({ page: 2, region: [0.9, 0.9, 0.2, 0.2] }), { page: 2, region: { x: 0.9, y: 0.9, w: 1 - 0.9, h: 1 - 0.9 } },
    'A14 框顶出页外 → 夹回页内（夹完还够大就留着）')
  eq(serializeAsk({ page: 2, region: [0.9, 0.9, 0.2, 0.2] }).region, [0.9, 0.9, 0.1, 0.1],
    'A14b 同一个框写进文件时是干净的 0.1（夹出来的浮点尾巴由出关那一步量化掉）')
  eq(normalizeAsk({ page: 2, region: [1.5, 0, 0.2, 0.2] }), { page: 2 }, 'A15 整个框在页面外 → 夹成零宽 → 丢掉')

  /* ★ NaN 不许变成一圈"画在原点、4×4"的高亮（那正是 2026-09-22 那个静默错的样子）。 */
  no(regionToWorld(normalizeAsk({ page: 2 }).region, RECTS[1]), 'A15b 没有 region → regionToWorld 老实说 null，不返回一个 NaN 的框')
  no(regionToWorld({ x: NaN, y: 0, w: 0.1, h: 0.1 }, RECTS[1]), 'A15c 四个数里有一个认不出 → null（NaN 画出来是一个缩成点的高亮，不报错）')
  yes(regionToWorld({ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, RECTS[1]), 'A15d 正常的框照旧算得出来')

  /* ★ 出关和进关**同一个规范形**：这是"存→读→再存 字节一致"的地基。 */
  const messy = { doc: '.资料/普通物理.pdf', page: 3, region: [0.123456, 0.2, 0.30001, 0.4] }
  const s1 = serializeAsk(messy)
  eq(s1, { doc: '.资料/普通物理.pdf', page: 3, region: [0.1235, 0.2, 0.3, 0.4] }, 'A16 出关量化到 4 位小数（1e-4 页宽 ≈ 0.07 世界像素，够了）')
  eq(serializeAsk(s1), s1, 'A17★ 幂等：写出去的那一份再写一次，一个字节都不变')
  eq(serializeAsk(normalizeAsk(s1)), s1, 'A18★ 写得出去的一定读得回来（读回来再写一遍，一个字节都不差）')
  no(serializeAsk({ page: 0 }), 'A19 出关也守着同一条闸：页码不合法就不写')
}

console.log('\n[B] 板文件往返：问过的卡带着出处，没问过的一个字节都不多')

{
  const mk = () => {
    const b = newBoard('夹具')
    b.docs = [{ id: 'doc1', path: '.资料/普通物理.pdf', x: 100, y: 200, w: 720, pages: [[720, 540], [720, 540]] }]
    return b
  }
  const withAsk = { ...newCard('note', 0, 0), x: 10, y: 20, w: 400, h: 300, text: '问\n\n答', rich: true, ask: { doc: '.资料/普通物理.pdf', page: 2, region: [0.1, 0.2, 0.3, 0.4] } }
  const plain = { ...newCard('note', 0, 0), x: 10, y: 420, w: 400, h: 300, text: '手写的卡' }
  const b1 = mk()
  b1.cards = [withAsk, plain]
  const t1 = serializeBoardDocument(b1)
  yes(/"ask"/.test(t1), 'B1 带出处的卡：文件里写着一个 `ask`')
  const back = parseBoardDocument(t1)
  eq(back.cards[0].ask, { doc: '.资料/普通物理.pdf', page: 2, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    'B2 读回来是同一份（页码 + 页内矩形 + 哪一份课件）；文件里是数组、内存里是对象')
  eq(back.cards[1].ask, null, 'B3 没问过的卡读回来是 null（不写、也不兜一个空壳）')
  eq(serializeBoardDocument(back), t1, 'B4★ 存→读→再存**逐字节一致**（那个字段不会自己长出来 / 掉下去）')

  const t2 = serializeBoardDocument({ ...b1, cards: [plain] })
  no(/"ask"/.test(t2), 'B5★ 一张问过的卡都没有 → 文件里连 `ask` 这三个字母都不出现（老文件一个字节都不多）')

  /* 手改文件写了半个字段：认不出就丢，别硬凑。 */
  const hand = t1.replace('"page": 2', '"page": 0')
  eq(parseBoardDocument(hand).cards[0].ask, null, 'B6★ 手改文件把页号写成 0 → 读回来就是"没有出处"，不是 `{page:0}`')
  const hand2 = t1.replace('"doc": ".资料/普通物理.pdf"', '"doc": "某本书.pdf"')
  eq(parseBoardDocument(hand2).cards[0].ask, { page: 2, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    'B7 手改成一个不是资料路径的 doc → 那个键没了，页码和框照旧')
}

console.log('\n[C] 留下的是什么（answer-cards.js）')

{
  const u1 = { role: 'user', text: '这里为什么是这样？' }
  const a1 = { role: 'assistant', text: '因为 $F=ma$。' }
  const u2 = { role: 'user', text: '那这一步为什么成立？' }
  const a2 = { role: 'assistant', text: '因为牛顿第二定律。' }

  eq(askThreadText([u1, a1]), { title: '这里为什么是这样？', body: '因为 $F=ma$。', clipped: false },
    'C1 一轮问答 → 标题是**你问的那句话**、正文是答案（标题和正文合成一张卡）')
  eq(askThreadText([u1, a1, u2, a2], 3), { title: '这里为什么是这样？', body: '因为 $F=ma$。\n\n那这一步为什么成立？\n\n因为牛顿第二定律。', clipped: false },
    'C2★ 留"到这一轮为止"：接着问的第二轮连**上一轮**一起带上（第二答常常写着"上面那个符号"）')
  eq(askThreadText([u1, a1, u2, a2], 1), { title: '这里为什么是这样？', body: '因为 $F=ma$。', clipped: false },
    'C3 按钮挂在哪一条回答下面，就留到那一条（第一轮那颗不会把第二轮捎上）')
  no(askThreadText([]), 'C4 空对话 → null')
  no(askThreadText([u1]), 'C5 只问了、还没答 → null（不能留一张只有问题的卡）')
  no(askThreadText([u1, { role: 'assistant', text: '', pending: true }]), 'C6 "正在想…"那个占位不算一条回答')
  no(askThreadText([u1, { role: 'assistant', text: '   ' }]), 'C7 空白的回答（模型没回内容）→ null')

  const longQ = { role: 'user', text: '为什么'.repeat(60) }
  const longA = { role: 'assistant', text: '答'.repeat(MAX_ASK_A + 50) }
  const long = askThreadText([longQ, longA])
  eq([...long.title].length, MAX_ANSWER_TITLE, 'C8 太长的问题当标题 → 截到 ' + MAX_ANSWER_TITLE + ' 字（标题撑长了卡片就是一条横幅）')
  yes(long.clipped, 'C9★ 截断要**报数**（`clipped`）—— 静默少字和"模型没讲完"分不出来')

  eq(askThreadText([{ role: 'user', text: '  这里  为什么  \r\n是这样？  ' }, { role: 'assistant', text: '因为  \u3000A。' }]),
    { title: '这里 为什么 是这样？', body: '因为 A。', clipped: false },
    'C10 换行和多余空白压掉（一个字节都不删，只动"看着一样"的空白）')

  const p = { label: '第 12 页第 3 题', page: 12, question: '一物体从静止下落……', answer: '$v=gt$', explain: '从定义出发。' }
  eq(homeworkText(p), { title: '第 12 页第 3 题', body: '一物体从静止下落……\n\n答案：$v=gt$\n\n解析：从定义出发。', clipped: false },
    'C11★ 一道题 → 题号（标题）+ 题干 + 答案 + 解析（"答案：C"孤零零一张卡，一周后没有任何意义）')
  eq(homeworkText({ page: 7, answer: 'A' }).title, '第 7 页那一道', 'C12 模型没给题号 → 退回"第 N 页那一道"（不编一个题号）')
  eq(homeworkText({ label: '第 1 题', answer: 'A', question: '第一段\n\n第二段' }).body, '第一段\n\n第二段\n\n答案：A',
    'C13 题干里的分段留着（卡片是 pre-wrap，空行就是段落）')
  no(homeworkText({ label: '第 1 题' }), 'C14 题号之外什么都没有 → null')
  no(homeworkText(null), 'C15 不是对象 → null')
  yes(homeworkText({ label: 'x'.repeat(200), answer: 'A' }).clipped, 'C16 题号太长也报数')

  eq(answerItem('keep1', { title: 'T', body: 'B' }), { id: 'keep1', kind: ANSWER_KIND, title: 'T', body: 'B' },
    'C17 交出来的是摆版认的那个条目（kind = ' + ANSWER_KIND + '，正文按讲义渲染）')
  no(answerItem('keep1', { title: 'T', body: '   ' }), 'C18 空正文 → null（不落一张空卡）')
  yes(KEEP_BUTTON && KEPT_LABEL && KEEP_BUTTON !== KEPT_LABEL, 'C19 两颗按钮上的字是两句不同的话（自检按它找按钮，两处共用一份）')
}

console.log('\n[D] 摆哪儿：这一栏占到哪儿了 + 这张卡接在谁下面（doc-cards.js）')

{
  eq(columnOccupancy({ rects: RECTS, cards: [] }), [{ left: null, right: null }, { left: null, right: null }, { left: null, right: null }],
    'D1 空板：两栏都空着（**null 不是 0** —— 资料的 y 可以是负的，0 会被读成"页顶之上还有东西"）')

  const explain = { id: 'c1', kind: 'note', x: RIGHT_X, y: RECTS[0].y, w: SIDE_W, h: 900 }
  eq(columnOccupancy({ rects: RECTS, cards: [explain] })[0], { left: null, right: RECTS[0].y + 900 },
    'D2 右栏那张讲解卡 → 这一栏占到它的底边')

  const wide = { id: 'c2', kind: 'formula', x: LEFT_BAND[0] + SIDE_W - 200, y: RECTS[0].y + 40, w: 200, h: 60 }
  eq(columnOccupancy({ rects: RECTS, cards: [wide] })[0].left, RECTS[0].y + 100,
    'D3 左栏的公式卡是**右对齐**的（左边缘不齐）—— 按中心判栏，两种卡都认')

  const floating = { id: 'c3', kind: 'note', x: PX + 100, y: RECTS[0].y + 100, w: 200, h: 100 }
  eq(columnOccupancy({ rects: RECTS, cards: [floating] })[0], { left: null, right: null },
    'D4 浮在**页面上**的卡不占任何一栏（它挡不住谁，也不该被当成"这一栏有东西"）')

  const onP2 = { id: 'c4', kind: 'note', x: RIGHT_X, y: RECTS[1].y + 30, w: SIDE_W, h: 200 }
  const occ = columnOccupancy({ rects: RECTS, cards: [onP2] })
  eq([occ[0], occ[2]], [{ left: null, right: null }, { left: null, right: null }], 'D5 第 2 页的卡只算第 2 页的账')
  eq(occ[1].right, RECTS[1].y + 230, 'D5b 那一页的右栏占到它的底边')

  const inGap = { id: 'c5', kind: 'note', x: RIGHT_X, y: RECTS[0].y + PH + 10, w: SIDE_W, h: 50 }
  eq(columnOccupancy({ rects: RECTS, cards: [inGap] })[1].right, inGap.y + 50,
    'D6 卡片落在两页之间那道缝里 → 算**下面那一页**的（和 homework.js 的 spotOfCard 同一条读法）')

  eq(pageGapFor(PH, PH), 0, 'D7 这一页装得下 → 一个字节的额外空都不留（假 diff 的来源就是这里）')
  eq(pageGapFor(900, PH), 370, 'D8 900 高的一页 → 后面多留 370（900 + 30 - (540 + 20)）')
  eq(pageGapFor(PH + 20, PH), 30, 'D9 只冒头一点点 → 只留那一点（+ 30 的缝）')

  eq(planAnswerCard({ rects: RECTS, page: 2, cards: [], w: SIDE_W, h: 300 }), { x: RIGHT_X, y: RECTS[1].y, w: SIDE_W, h: 300, pageGap: 0 },
    'D10 空栏 → 从**页顶**起，贴在右栏（和讲解同一栏、同一个 x）')
  /* ⚠ 期望值是 18 而不是 0：这张卡比页面**多冒出去 8 像素**（1008+300 = 1308 > 760+540），
     而"冒出去"就要把下一页推开一点点（8 + PAGE_PUSH 30 - DOC_PAGE_GAP 20 = 18）——
     和讲解卡是同一条账（`pageGapFor`）。 */
  eq(planAnswerCard({ rects: RECTS, page: 2, cards: [explain, onP2], w: SIDE_W, h: 300 }),
    { x: RIGHT_X, y: RECTS[1].y + 230 + CARD_GAP_Y, w: SIDE_W, h: 300, pageGap: 18 },
    'D11★ 那一栏已经有东西 → 接在它**下面**留一道缝（不是压在它身上）')
  eq(planAnswerCard({ rects: RECTS, page: 1, cards: [explain], w: SIDE_W, h: 300 }).pageGap, 688,
    'D12 卡片挂到页面外面去了 → 把**下一页推开**（1218 + 30 - 560 = 688）')
  no(planAnswerCard({ rects: RECTS, page: 9, cards: [], w: SIDE_W, h: 300 }), 'D13 页号对不上 → null（让调用方说一句人话，别落一张飘着的卡）')
}

console.log('\n[E] 两条路同住一栏：讲解不许压在答案卡上；再整理一次不许一页比一页低')

{
  const sizes = new Map([
    ['e1', { w: SIDE_W, h: 900 }],
    ['e2', { w: SIDE_W, h: 900 }],
  ])
  const pages = [
    { page: 1, items: [{ id: 'e1', kind: 'explain', title: 'T1', body: 'B1' }] },
    { page: 2, items: [{ id: 'e2', kind: 'explain', title: 'T2', body: 'B2' }] },
  ]

  /* ① 先留了一张答案卡（右栏，900 高） */
  const kept = { id: 'n1', kind: 'note', x: RIGHT_X, y: RECTS[0].y, w: SIDE_W, h: 900, ask: { page: 1 } }
  const occ = columnOccupancy({ rects: RECTS, cards: [kept] })
  const alone = projectDeck({ pages: [pages[0]], sizes, rects: RECTS })
  const withOcc = projectDeck({ pages: [pages[0]], sizes, rects: RECTS, occupied: occ })
  eq(alone.cards[0].y, RECTS[0].y, 'E1 不传 occupied = 老行为：讲解从页顶起（会正正压在答案卡上 —— 而"压住"在板上看不出来）')
  eq(withOcc.cards[0].y, RECTS[0].y + 900 + CARD_GAP_Y, 'E2★ 传了 occupied：讲解接在答案卡下面（先留答案、再整理这一页，两张卡不打架）')

  /* ② 那个"再整理一次一页比一页低"的回归（2026-09-22 修） */
  const first = projectDeck({ pages, sizes, rects: RECTS })
  eq(first.cards.map((c) => c.y), [RECTS[0].y, RECTS[1].y + 370], 'E3 第一次整理：第 2 页的卡片落在"第 1 页的讲解把它推下去"之后（+370）')
  const written = first.pageGaps.map((g) => Number(g) || 0)
  const second = projectDeck({ pages, sizes, rects: rectsWith(written), existing: written })
  eq(second.cards.map((c) => c.y), first.cards.map((c) => c.y),
    'E4★★ 同一份资料**再整理一次**（默认全选，最常见的用法）：卡片落在**一模一样**的地方')
  eq(second.pageGaps, first.pageGaps, 'E5 空也只涨不缩：这一次算出来的和上一次同一个数')
  const naive = projectDeck({ pages, sizes, rects: rectsWith(written) })
  eq(naive.cards[1].y, RECTS[1].y + 370 + 370,
    'E6 `existing` 不传就会**加两遍**（1130 + 370 = 1500）—— 这就是那个参数存在的理由，别把它删了')

  /* ③ 一次 commit 的那条账：卡片和 pageGaps 一起报出去 */
  const plan = planAnswerCard({ rects: RECTS, page: 1, cards: [], w: SIDE_W, h: 300 })
  eq([plan.y, plan.pageGap], [RECTS[0].y, 0], 'E7 装得下时 pageGap 是 0（写不写这一页的空，由调用方"只涨不缩"并进去）')
}

console.log('\n[F] 某页的 pageGaps 涨了 → 后面那些页上的卡片要跟着挪（2026-09-23 用户报的「印上板子就错位」）')

{
  /* ══ ①★ 先把用户那张板的**真数**钉住 —— 整个修复就是这条链子推出来的，
     改版时它一旦失准，下面那些就都没意义了。
     来源：`data/热力学与统计物理/board-近独立粒子地最概然分布.md`
       · `pageGaps[36] = 238`（第 37 页 —— 全板唯一的非零值）；
       · 页高 540（720×540 的 PPT），DOC_PAGE_GAP = 20。 */
  eq(pageGapFor(768, PH), 238,
    'F1★ 第 37 页现装的那笔空 = 238（讲解卡 768 高撑出来的）—— 和他文件里那个 pageGaps[36] 对上')
  /* 在第 37 页「留到板上」：答案卡接在讲解卡下面（768 + CARD_GAP_Y 18 = 786 起），
     假设它高 400 ⇒ 这一页该留 `pageGapFor(786 + 400, 540)` = 656。
     而 `planAnswerCard` 那边是 `max(238, 656)` —— 所以是**涨**，不是"取一个中间值"。 */
  eq(pageGapFor(786 + 400, PH), 656, 'F2★ 贴完答案卡这一页要留 656（786 + 400 + 30 − 560）')
  const REAL_DELTA = 656 - 238
  eq(REAL_DELTA, 418,
    'F3★ 增量 = 418 —— 第 38 页被推下去 418px，而它那 5 张卡原来**一个都不动**（用户看到的就是这个）')

  /* ══ ② `pageGapDeltas`：只留正的、下标和 pageGaps 对齐、**稠密**（length = 页数） */
  eq(pageGapDeltas([0, 100, 0, 50], [0, 0, 0, 0]), [0, 100, 0, 50],
    'F4 下标 = 页号 - 1，和 pageGaps 本身对齐')
  eq(pageGapDeltas([0, 100, 0, 50], [0, 0, 0, 0]).length, 4,
    'F5★ **稠密**：length 就是页数（稀疏数组的 length 不等于页数，"第 3 页该挪多少"就算不出来了 —— 第一版就栽在这）')
  eq(pageGapDeltas([0, 50], [0, 100]), [0, 0],
    'F6 只涨不缩：缩回去不算"多占了空"（地占下了就留着，退回去的不是这一次涨的）')
  eq(pageGapDeltas([7], []), [7], 'F7 老文件没有 pageGaps（`[]`）→ 全算涨（第一次整理就是这一档）')

  /* ══ ③★★ 真正的验收标准：挪完之后**每张卡相对自己页顶的偏移一个字节都不变** ——
     那就是用户说的"和 ppt 对齐"。这条比"挪了多少像素"更接近他要的东西。 */
  const DOC = '.资料/甲.pdf'
  const WAS = [238, 0, 0]
  const oldRects = rectsWith(WAS)
  const cards = [
    { id: 'p1', x: RIGHT_X, y: oldRects[0].y, w: SIDE_W, h: 768, ask: { doc: DOC, page: 1 } },
    { id: 'p2', x: RIGHT_X, y: oldRects[1].y, w: SIDE_W, h: 400, ask: { doc: DOC, page: 2 } },
    { id: 'p3', x: LEFT_BAND[0], y: oldRects[2].y + 30, w: 200, h: 60, ask: { doc: DOC, page: 3 } },
    { id: 'x1', x: 0, y: 0, w: 100, h: 100 }, // 没有 ask（用户自己手放的卡）
    { id: 'x2', x: 0, y: 0, w: 100, h: 100, ask: { doc: '.资料/乙.pdf', page: 2 } }, // 别的资料
  ]
  const NEXT = [238 + REAL_DELTA, 0, 0]
  const res = shiftLaterPageCards({ cards, docPath: DOC, deltas: pageGapDeltas(NEXT, WAS) })
  const newRects = rectsWith(NEXT)
  const off = (c, rects) => Math.round(c.y - rects[c.ask.page - 1].y)
  eq(res.moved, 2, 'F8★ 挪了 2 张（第 2、3 页那两张）—— 第 1 页自己没被推，所以它那张不动')
  eq(res.cards.map((c) => c.y), [cards[0].y, cards[1].y + REAL_DELTA, cards[2].y + REAL_DELTA, 0, 0],
    'F9★ 挪的量就是那 418（两张都挪 418 —— 它们在第 1 页**后面**）')
  eq([off(res.cards[1], newRects), off(res.cards[2], newRects)], [off(cards[1], oldRects), off(cards[2], oldRects)],
    'F10★★ 挪完之后**相对自己页顶的偏移一个字节都没变** —— 这才是"还和 ppt 对齐"')
  eq(res.cards[3], cards[3], 'F11 没有 ask 的卡不动（已知边界：它没声明自己是哪一页的，推了反而错）')
  eq(res.cards[4], cards[4], 'F12 别的资料的卡不动（`ask.doc` 认的是**精确相等**，改名/换目录就认不出 → 宁可不挪）')

  /* ══ ④ 挪多少是**按页累加**的：一次操作里可能好几页都涨了（课件整理一批好几页） */
  const three = [
    { id: 'a', y: 0, ask: { doc: DOC, page: 1 } },
    { id: 'b', y: 0, ask: { doc: DOC, page: 2 } },
    { id: 'c', y: 0, ask: { doc: DOC, page: 3 } },
  ]
  const cum = shiftLaterPageCards({ cards: three, docPath: DOC, deltas: pageGapDeltas([100, 50, 0], [0, 0, 0]) })
  eq(cum.cards.map((c) => c.y), [0, 100, 150],
    'F13★ 前缀和：第 2 页挪 100、第 3 页挪 100+50 —— 不是"一律挪第一个增量"')

  /* ══ ⑤★ 卡落在**比 deltas 还靠后**的页上 → 挪**全部累计量**，不是 0
     （只涨了第 1 页、卡却在第 9 页：它一样被整笔推下去了）——
     第一版这里把"前缀和查不到"当成"没涨"，于是第 3 页以后的卡一张都没动。 */
  const beyond = shiftLaterPageCards({ cards: [{ id: 'z', y: 10, ask: { doc: DOC, page: 9 } }], docPath: DOC, deltas: [418] })
  eq(beyond.cards[0].y, 10 + 418, 'F14★ 卡在比 deltas 更靠后的页上 → 挪**全部**累计量（只涨了第 1 页也一样：它被推下去了）')

  /* ══ ⑥ 没动就**原样返回同一个数组**：调用方拿它判断"要不要跟用户说一声" */
  const same = [{ id: 'a', y: 5, ask: { doc: DOC, page: 2 } }]
  const none = shiftLaterPageCards({ cards: same, docPath: DOC, deltas: [] })
  yes(none.cards === same && none.moved === 0, 'F15 没有增量 → 原样返回**同一个数组**（别让"引用变了"被当成"真有东西动了"）')
  const zero = shiftLaterPageCards({ cards: same, docPath: DOC, deltas: [0, 0, 0] })
  yes(zero.cards === same && zero.moved === 0, 'F16 全 0 的 deltas 也一样（没涨就是没涨）')
  const noPath = shiftLaterPageCards({ cards: same, docPath: '', deltas: [100] })
  yes(noPath.cards === same && noPath.moved === 0, 'F17 没给资料路径 → 一个字节都不动（宁可不挪，也不"猜着挪"）')

  /* ══ ⑦**源码扫描**：接线有没有真的接上。
     这一族最阴的失败方式是"函数写得对、**没人调**"—— 本仓库栽过一模一样的
     （`allCards` 算出来了位置、flash 里也说了，就是没进 commit，界面上一切正常）。
     判据：`Board.jsx` 里**每一个写 `pageGaps` 的地方**，附近都得有一次
     `shiftLaterPageCards` 调用 —— 写空和挪卡是同一条不变量，缺一半就是这次的 bug。
     ⚠ 这是"附近"（±900 字），不是语法分析：够用，而且将来多一处写入时它会红，
     那时候回来看这条扫描、把新那处也补上。
     ⚠ 判据别写成"调了几次"：`>=` 会放过"新增一处写 pageGaps 却忘了挪"，
        而"恰好 2 次"又会被一次无关的重构弄红 —— 逐个写入点查附近才是对的那条。 */
  const boardSrc = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8')
  const WRITE = /pageGaps: keep/g
  const sites = [...boardSrc.matchAll(WRITE)].map((m) => m.index)
  eq(sites.length, 2, 'F18 写 pageGaps 的地方正好两处（`keepAnswer` / `placeDeckCards`）—— 多一处就回来补这条扫描')
  for (let i = 0; i < sites.length; i += 1) {
    const at = sites[i]
    const near = boardSrc.slice(Math.max(0, at - 900), at + 900)
    yes(/shiftLaterPageCards\(/.test(near), `F19.${i + 1}★ 第 ${i + 1} 处写 pageGaps 的地方**真的调了** shiftLaterPageCards（写空不挪卡 = 用户报的那个错位）`)
  }

  /* ══ ⑧★★ **整条链子**按用户那页的真数跑一遍（不是只测 `shiftLaterPageCards`）。
     上面 ③ 是"我喂给它一个 418"，这一节是"**那个 418 是 `planAnswerCard` 算出来的**" ——
     测的是调用方那几行算式（`max(was, plan.pageGap)`、增量、前缀和），
     它们写错的话函数再对也没用。判据仍然是"每张卡相对自己页顶的偏移不变"。 */
  {
    const D2 = '.资料/丙.pdf'
    const was = [238, 0, 0]
    const r0 = rectsWith(was)
    /* 板上的现状：第 1 页右栏一张 768 高的讲解（就是那笔 238 的来历），
       第 2、3 页各一张卡（**它们才是会被推下去的**）。 */
    const live = [
      { id: 'q1', x: RIGHT_X, y: r0[0].y, w: SIDE_W, h: 768, ask: { doc: D2, page: 1 } },
      { id: 'q2', x: RIGHT_X, y: r0[1].y, w: SIDE_W, h: 300, ask: { doc: D2, page: 2 } },
      { id: 'q3', x: RIGHT_X, y: r0[2].y + 40, w: SIDE_W, h: 300, ask: { doc: D2, page: 3 } },
    ]
    /* 调用方那几行（和 `Board.jsx` 的 `keepAnswer` 逐句对齐） */
    const plan = planAnswerCard({ rects: r0, page: 1, cards: live, w: SIDE_W, h: 400 })
    const keepAt = Math.max(was[0], Number(plan.pageGap) || 0)
    const d = []
    if (keepAt - was[0] > 0) d[0] = keepAt - was[0]
    eq([plan.y - r0[0].y, keepAt, d[0]], [786, 656, 418],
      'F20★★ 链子对上了：答案卡落在页顶 +786，这一页该留 656，增量 418（和用户那张板算出来的一模一样）')
    const r1 = rectsWith([keepAt, 0, 0])
    const after = shiftLaterPageCards({ cards: live, docPath: D2, deltas: d })
    const offOf = (c, rects) => Math.round(c.y - rects[c.ask.page - 1].y)
    eq(after.cards.map((c) => offOf(c, r1)), live.map((c) => offOf(c, r0)),
      'F21★★ 整条链子跑完，**每张卡相对自己页顶的偏移一张都没变** —— 这就是用户要的"还和 ppt 对齐"')
  }
}

console.log(
  fails
    ? `\n${fails} 项失败（共 ${checks} 条断言）`
    : `\n全部通过（${checks} 条断言）—— 纯逻辑这一半没问题；真点那颗按钮要写盘、要能 Ctrl+Z 退掉，看 npm run check:followup-browser / check:homework-browser`
)
process.exitCode = fails ? 1 : 0
