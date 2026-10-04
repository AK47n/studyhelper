/* 「作业辅导」的自检（**纯逻辑，不走浏览器**）。
 *
 * 这条路有四段，三段是纯的，全钉在这里：
 *   ① 学生那句"第 12 页第 3 题" → **要发哪几页**（`parseHomeworkAsk`）；
 *   ② 模型回的那段 JSON → 每道题的「答案 + 解析」（`parseHomework`）；
 *   ③ 板上那些讲义卡 → "这节课讲过的东西"（`collectKnowledge`）；
 *   ④ 提示词拼得对不对（`homeworkPrompt`：占位符填了没、空讲义那条退路在不在）；
 *   ⑦ 没有讲义那一段时，服务端读 multipart 不能崩（2026-09-22 用户报的
 *      "Cannot read properties of null (reading 'slice')" —— 就出在这一步）。
 *   ⑧ **追问**（2026-09-22 用户要的"学生不懂的话可以继续问答案哪里是为什么"）：
 *      `problemPreamble` 拼出来的那段话、`problemHistory` 摆的顺序，
 *      以及"服务端认不认 hwask"（那条路走岔了会把一句 LaTeX 当成老师的回答）。
 * 真正出网那一趟（`homework-read.js`：画图 + fetch）在浏览器里，
 * 归浏览器自检 —— 这里连 pdf.js 都不拉起（那个文件一 import 就拉）。
 *
 * ── 为什么这些断言值得写 ────────────────────────────────────────────────
 * 这一趟的产物是**答案**。答错了学生会照着背 —— 所以"哪几页"必须是对的
 * （页号错 = 拿别人的题当自己的）、"空壳"必须丢掉（一条 `answer` 空着的题
 * 看起来像"这道题答案是空的"）、"这节课的讲义"必须真的是这节课的
 * （混进另一门课的讲解，它就会用你没学过的符号去讲）。
 * ★ 追问那一段更甚：学生问的是"你刚才那一步为什么" —— 历史里那道题的答案
 *   只要**不在这道题**下面（串题了），老师就会拿另一道题的解法去解释这一道，
 *   而听起来毫无破绽（因为它确实在讲一道真实的题）。
 *
 * 用法：node scripts/check-homework.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOMEWORK_PROMPT, homeworkPrompt } from '../server-ocr.js'
import { docOrigin } from '../server-docs.js'
import {
  HW_KNOWLEDGE_MAX_CHARS,
  HW_MAX_PAGES,
  collectKnowledge,
  lessonSources,
  parseHomework,
  parseHomeworkAsk,
  problemHistory,
  problemLabel,
  problemPreamble,
} from '../src/lib/homework.js'
import { extractTextPart } from '../src/lib/multipart.js'
import { pageRects } from '../src/lib/docs.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let fails = 0
/* 过了几条也数着 —— README 和脚本头里写的条数得是**真数出来的**，
   手写一个"49 项"的话，加两条断言之后那句话就开始骗人了。 */
let passes = 0
const ok = (m) => {
  passes++
  console.log('  \u2713 ' + m)
}
const bad = (m) => {
  fails++
  console.log('  \u2717 ' + m)
}
const eq = (got, want, m) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) ok(m)
  else bad(`${m} —— 拿到 ${a}，期望 ${b}`)
}

console.log('\n① 学生说的"第几页第几题" → 要发哪几页')

eq(parseHomeworkAsk('第 12 页第 3 题').pages, [12], '「第 12 页第 3 题」→ 第 12 页')
eq(parseHomeworkAsk('12页3题').pages, [12], '「12页3题」（省掉"第"）→ 第 12 页')
eq(parseHomeworkAsk('第 12-13 页 第 3 题').pages, [12, 13], '「第 12-13 页」→ 两页都要发')
eq(parseHomeworkAsk('第12至14页第5题').pages, [12, 13, 14], '「第12至14页」→ 三页（正好到上限）')
eq(parseHomeworkAsk('P120 第 3 题').pages, [120], '「P120」→ 第 120 页')
eq(parseHomeworkAsk('p.7 第 2 题').pages, [7], '「p.7」→ 第 7 页')
eq(parseHomeworkAsk('第 １２ 页第 ３ 题').pages, [12], '全角数字也认（中文输入法下很常见）')
eq(parseHomeworkAsk('第 12 页 第 3、4 题').pages, [12], '题号写几个都不影响页数')

if (parseHomeworkAsk('第 3 题').error) ok('只说题号、不说页号 → 报错拦住（页号是本地非要知道的）')
else bad('没页号也放过去了 —— 那样会拿一页不知道哪一页的图去问题')
if (parseHomeworkAsk('').error) ok('空着 → 报错拦住')
else bad('空输入放过去了')
if (parseHomeworkAsk('第 1-9 页第 2 题').error) ok(`一次超过 ${HW_MAX_PAGES} 页 → 报错拦住（图是要花钱的）`)
else bad('页数超上限也放过去了')
if (parseHomeworkAsk('第 99 页第 1 题', { maxPage: 20 }).error) ok('页号越界 → 报错拦住（那份资料只有 20 页）')
else bad('越界页号放过去了')
const p3 = parseHomeworkAsk('第 12 页第 3 题')
if (p3.ask === '第 12 页第 3 题') ok('原话一个字不动地留着（要原样发给模型）')
else bad('原话被改坏了：' + p3.ask)
if (!parseHomeworkAsk('PPT 第 20 页第 1 题').pages.includes(0) && parseHomeworkAsk('PPT 第 20 页第 1 题').pages[0] === 20) {
  ok('「PPT」里的 P 不会被当成页码写法')
} else bad('「PPT」被读成了页码：' + JSON.stringify(parseHomeworkAsk('PPT 第 20 页第 1 题').pages))

console.log('\n② 模型回的 JSON → 每道题的「答案 + 解析」')

const good = JSON.stringify({
  problems: [
    { label: '第 3 题', page: 12, question: '一个物体质量 $m=2\\,\\text{kg}$…', answer: '$a=5\\,\\text{m/s}^2$', explain: '先看合外力……' },
    { label: '第 4 题', page: 12, question: '……', answer: 'B', explain: '这一步是……' },
  ],
})
eq(parseHomework(good).problems.length, 2, '正常 JSON → 两道题')
eq(parseHomework('```json\n' + good + '\n```').problems.length, 2, '整段被 ``` 包着也能收（模型老爱包）')
eq(parseHomework('好的，我看看：\n' + good + '\n希望有帮助！').problems.length, 2, '前后多一句人话也能抠出来')
eq(parseHomework(JSON.stringify({ items: [{ label: 'x', answer: 'y' }] })).problems.length, 1, '`items` 这种别名也认')
const empty = parseHomework(JSON.stringify({ problems: [{ label: '第 9 题', question: 'q', answer: '', explain: '' }] }))
eq(empty.problems.length, 0, '`answer` 和 `explain` 都空 = 空壳，丢掉')
eq(empty.dropped, 1, '丢掉的条数**报出来**（少拿到的东西不静默）')
const none = parseHomework(JSON.stringify({ problems: [] }))
if (!none.error && none.problems.length === 0) ok('空数组是**成功**的一种：模型照提示词说"这一页上没有你说的题"')
else bad('空数组被当成了失败：' + none.error)
if (parseHomework('我觉得这道题应该选 B，因为……').error) ok('回的是一段话（不是 JSON）→ 报错，不硬猜')
else bad('不是 JSON 也当成功了 —— 那会把一段话当成题目')
if (parseHomework('').error) ok('空回话 → 报错')
else bad('空回话放过去了')

console.log('\n③ 板上的讲义卡 → "这节课讲过的东西"')

/* 一份三页的资料，加几张卡。坐标系：页宽 720、每页 540 高、页间距 20。 */
const doc = {
  id: 'doc1',
  path: '.资料/大学物理 第 3 讲.pdf',
  title: '大学物理 第 3 讲',
  x: 0,
  y: 0,
  w: 720,
  pages: [
    [720, 540],
    [720, 540],
    [720, 540],
  ],
}
/* 不该进来的两种：手写笔记卡（没有 `rich`）、没钉住的公式卡（用户此刻在写的式子）。 */
const cards = [
  /* 第 1 页：讲解在右栏（x 大）、重点在左栏（x 小）—— 和 projectDeck 摆出来的位置一致。 */
  { id: 'c1', kind: 'note', rich: true, locked: true, text: '第一页讲解：牛顿第二定律说的是……', x: 764, y: 0, w: 400, h: 300 },
  { id: 'c2', kind: 'note', rich: true, locked: true, text: '第一页重点：合力决定加速度', x: -444, y: 0, w: 400, h: 120 },
  { id: 'c3', kind: 'formula', locked: true, src: 'F=ma', tex: 'F=ma', x: -200, y: 140, w: 120, h: 40 },
  /* 第 3 页（y = 1120）：讲解卡 */
  { id: 'c4', kind: 'note', rich: true, locked: true, text: '第三页讲解：摩擦力……', x: 764, y: 1120, w: 400, h: 300 },
  { id: 'c5', kind: 'note', rich: false, text: '我自己随手写的一句', x: 764, y: 200, w: 300, h: 60 },
  { id: 'c6', kind: 'formula', tex: 'x^2', x: -200, y: 300, w: 100, h: 40 },
  /* ★ 一张**飘在资料外面**的讲义卡（被拖远了 / 资料撤了卡还留着）。
     它照样算"这节课讲过的" —— 判据是卡的身份（`rich`），不是它的坐标；
     只是它归不进任何一份资料（`lessonSources` 里单独一项"不在这几份课件旁边"）。
     ⚠ 这一条是**故意**的：宁可从宽（多带一句上下文），也不要严到"我讲过的东西它不知道"。 */
  { id: 'c7', kind: 'note', rich: true, text: '飘在别处的一张讲解卡', x: 9000, y: 0, w: 400, h: 100 },
]
const know = collectKnowledge(cards, [doc])
eq(know.count, 5, '讲义 5 张（这份资料的 4 张 + 1 张飘在别处的）')
if (know.text.includes('第一页讲解') && know.text.includes('摩擦力')) ok('讲解正文进来了')
else bad('讲解正文没进来：' + know.text.slice(0, 120))
if (!know.text.includes('我自己随手写的一句')) ok('手写笔记卡**不进来**（那不是我讲过的东西）')
else bad('手写笔记卡混进来了')
if (know.text.includes('飘在别处的一张讲解卡')) ok('飘在资料外面的讲义卡照样带上（从宽：多一句上下文比少一句强）')
else bad('飘在别处的讲义卡被丢了 —— 那会变成"我讲过的东西它不知道"')
if (!know.text.includes('x^2')) ok('没钉住的公式卡不进来（那多半是你此刻正在写的式子）')
else bad('没钉住的公式卡混进来了')
if (know.text.includes('F=ma') && know.text.includes('$$')) ok('钉住的公式卡进来，并且包成 $$…$$（排得出来）')
else bad('公式卡没进来或者没包定界符')
if (know.text.includes('【第 1 页】') && know.text.includes('【第 3 页】')) ok('标了页号，而且第 3 页那张按位置判对了')
else bad('页号标错了：' + know.text.slice(0, 200))
/* 同一页里，右栏（讲解，x=764）要排在左栏（重点，x=-444）**前面** —— 先读讲解、再读提纲。 */
if (know.text.indexOf('第一页讲解') < know.text.indexOf('第一页重点')) ok('同一页：讲解排在重点前面（上课的顺序）')
else bad('同一页里重点排到了讲解前面')

const onlyDoc = collectKnowledge(cards, [doc], { path: '.资料/大学物理 第 3 讲.pdf' })
eq(onlyDoc.count, 4, '按"这一份"过滤时，这一份的 4 张全在（飘在别处的那张不算这一份的）')
const otherDoc = collectKnowledge(cards, [doc], { path: '.资料/没有这一份.pdf' })
eq(otherDoc.count, 0, '按另一份过滤 → 一张都不带（不能拿别的课的讲义去讲这道题）')

const many = []
for (let i = 0; i < 60; i += 1) many.push({ id: 'm' + i, kind: 'note', rich: true, locked: true, text: '第' + i + '段：' + 'x'.repeat(900), x: 764, y: i * 4, w: 400, h: 300 })
const cut = collectKnowledge(many, [])
if (cut.truncated > 0 && cut.chars <= HW_KNOWLEDGE_MAX_CHARS + 200) ok(`讲义太长时按上限截断，并报出丢了几张（丢了 ${cut.truncated} 张）`)
else bad('截断没生效或者没报数：' + JSON.stringify({ chars: cut.chars, truncated: cut.truncated }))

const src = lessonSources(cards, [doc])

/* ★ 答案卡不许混进"这节课讲过的东西"（2026-09-24，补交互死角②）。
   「留到板上」落下来的答案卡是一张 `rich: true` 的文字卡 —— 和讲解卡**长得一模一样**，
   而 `isLessonCard` 判"算不算知识"用的正是「note + rich」。不挡住的话，
   第 1 题的答案会被当成讲义喂给第 2 题（模型抄自己，而且一题一题攒下去）。
   出处是独立字段 `answer`（Board.jsx 的 keepAnswer 写上去的，和 sum/rules 同一套路）。 */
{
  const lesson = { id: 'L1', kind: 'note', rich: true, locked: true, text: '第 1 页讲解：安培环路定理', x: 764, y: 0, w: 400, h: 300 }
  /* 答案卡：rich 的文字卡 + `ask`（它问的是哪一页）+ `answer: true`。 */
  const ans = { id: 'A1', kind: 'note', rich: true, locked: true, text: '第 1 题答案：先取环路再代电流', x: 764, y: 620, w: 400, h: 200, ask: { doc: doc.path, page: 2 }, answer: true }
  const mix = [lesson, ans]
  const k = collectKnowledge(mix, [doc])
  if (k.text.includes('安培环路定理')) ok('讲义卡照旧进来（挡答案卡时没把讲义一起误伤）')
  else bad('讲义卡没进来 —— 排除答案卡的时候把讲义一起挡了')
  if (!k.text.includes('先取环路再代电流')) ok('★ 答案卡**不进来**（上一题的答案不该被当成"讲过的东西"喂给下一题）')
  else bad('★ 答案卡混进"这节课讲过的东西"了 —— 下一题会读到上一题的答案（模型抄自己）')
  eq(k.count, 1, '只算讲义那一张（答案卡排除在外）')
  const tot = lessonSources(mix, [doc]).reduce((n, x) => n + (x.count || 0), 0)
  eq(tot, 1, '"知识来源"那个下拉也不把答案卡算进去')
}

if (src.length === 2 && src[0].count === 4 && src[1].count === 1) ok('"知识来源"列得出来（这一份 4 张 + 一项"不在这几份课件旁边"的 1 张）')
else bad('lessonSources 不对：' + JSON.stringify(src))

console.log('\n③b ★ 整节课那两张卡排在最前面（2026-09-22：提纲 + 做题须知）')

/* ── 它补的是哪个洞 ────────────────────────────────────────────────────
 * 用户原话：「现在的老师做题无法吸纳一整节课的卡片因为太多了，但是有这个总结
 *   会不会好很多」。一节课几十张讲义卡发进去，真正"下一趟要用"的那几条口径
 *   被埋在各页的讲解里 —— 模型得自己去三十张卡里认哪几条是"整节课的规矩"。
 * 所以 `collectKnowledge` 现在按**粗到细**三段排：
 *   ① 【整节课】（整节课那两张，不属任何一页）→ ② 【第 N 页】重点/公式 → ③ 讲解。
 * ── 为什么要分成"整节课 / 逐页"两半、而不是一股脑按页排 ────────────────
 * 整节课那两张卡的出处字段是 `sum` / `rules`（**板层**的，见 doc-summary.js），
 * 而它们是**没有页号**的（`page: 0`）。按位置判的话，它们坐在第一页左边，
 * 会被算成"第 1 页的东西" —— 于是"整节课的规矩"在提示词里看起来像
 * "第 1 页讲的规矩"，模型会拿它去讲第 2 页的题（而那条规矩整节课都成立）。
 * ★ 所以这一节要钉住两件事：**它们在**、**它们在最前面**。
 * ⚠ 判据不许写死文案（"提纲"这两个字换一次这条就红）——
 *   用 `sum` / `rules` 那两个字段造的卡各一张，比"哪一句正文先出现"稳。
 * ── 为什么会"静默地不对" ─────────────────────────────────────────────
 * `isSummary` / `isRules`（doc-summary.js 那两个）吃的是**条目层**的 kind
 * （'summary' / 'rules'），而板上的卡 kind 是 'note' —— 拿它们判**永远为假**，
 * 一张也认不出来，而界面上一切正常（讲义照样发出去，只是那两张混在页里）。
 * 板这一侧必须问 `c.sum` / `c.rules`（这就是 homework.js 里
 * `isDeckLevelCard` 存在的理由）。 */
{
  const withDeck = [
    ...cards,
    /* 整节课那两张：`page` 缺失（板上的卡本来就不带页号），带的就是那两个出处字段。
       位置故意摆在第一页左边（和真实摆版一致）—— 判据必须**不看位置**也认得出它们。 */
    { id: 'sum1', kind: 'note', rich: true, locked: true, sum: true, text: '**骨架**\n- 力与运动 · 第 1-2 页\n\n**自测**\n- 为什么第一步要画受力图？', x: -444, y: -300, w: 400, h: 200 },
    { id: 'rls1', kind: 'note', rich: true, locked: true, rules: true, text: '**单位与符号**\n- 都用国际单位制\n\n**最容易错的**\n- 最后忘了写单位', x: -444, y: -80, w: 400, h: 120 },
  ]
  const k2 = collectKnowledge(withDeck, [doc])
  eq(k2.count, 7, '整节课那两张也算"这节课讲过的"（5 张逐页 + 2 张整节课）')
  const iDeck = k2.text.indexOf('【整节课】')
  const iPage = k2.text.indexOf('【第 1 页】')
  if (iDeck >= 0) ok('★ 有一段【整节课】（它们不属于任何一页 —— 标页号会让人以为只在那一页成立）')
  else bad('没有【整节课】那一段：' + k2.text.slice(0, 200))
  if (iDeck >= 0 && iPage > iDeck) ok('★ 【整节课】排在【第 N 页】**前面**（粗到细：先整节课的规矩、再逐页的重点、最后才是讲解）')
  else bad('【整节课】没排在最前面：' + JSON.stringify({ deck: iDeck, page: iPage }))
  /* ★ 两张卡**都**要在那一段里，而且各自带得出身份（提纲说形状、须知说口径）——
     只认 `sum` 漏掉 `rules` 的话，"做题须知"整张卡对模型来说是隐形的，
     而界面上看不出任何异常（那一张卡还在板上、还能看见）。 */
  if (k2.text.includes('**骨架**') && k2.text.includes('**单位与符号**')) ok('★ 提纲和做题须知**两张**都在【整节课】那一段里（各带各的出处字段）')
  else bad('整节课那两张没有都进来：' + k2.text.slice(0, 260))
  if (/<提纲>/.test(k2.text) && /<做题须知>/.test(k2.text)) ok('★ 两张各自标了名字（<提纲> / <做题须知>）—— 模型分得清哪段是形状、哪段是口径')
  else bad('整节课那两张没标名字（模型会把它们当成同一张卡的上下半）：' + k2.text.slice(0, 260))
  /* ⚠ 它们**不许**被算进任何一页：`【第 1 页】` 那一段里出现"骨架/单位与符号"
     就说明判据又滑回"按位置归页"了（那正是这一节要防的那个错）。 */
  const seg1 = k2.text.slice(k2.text.indexOf('【第 1 页】'), k2.text.indexOf('【第 3 页】') >= 0 ? k2.text.indexOf('【第 3 页】') : undefined)
  if (!/骨架/.test(seg1) && !/单位与符号/.test(seg1)) ok('★ 它们**没有**混进【第 1 页】那一段（按位置判就会犯这个错 —— 它们坐在第一页左边）')
  else bad('整节课的卡被算进第 1 页了：' + seg1.slice(0, 200))

  /* ── 预算：整节课那两张**先保**（`deckCap = cap * 0.4`）──────────────────
     用户那句话的诉求正是"让做题的那位先看到整节课的规矩" ——
     超预算时要是先把它们裁掉，这个功能就白做了。 */
  /* ⚠⚠ 这段夹具必须**照着板上的真实形状**造，否则验的是个不存在的东西。
     踩过四次，每次红的样子都像产品有问题：
     ① 80 张全放在 `y: i * 4`（挤在第 1 页里）→ 所有卡都落在第 1 页，
        `droppedPages` 记的是"**整页**被丢掉"，所以它永远是空的。
     ② 铺开了但预算太大（默认 24000）→ 差不多都装得下，一张没丢，还是空。
     ③ ★ **用了 `kind: 'explain'`** —— 那是**条目层**的 kind，板上的卡根本不是它。
        `Board.jsx` 的 `fresh` 只会写出 'note'（带 `rich: true`）或 'formula'，
        讲解卡 / 重点卡 / 答案卡 / 整节课那两张**全都是 note**。
        用 explain 造夹具 = 造了一张板上不可能存在的卡，验出来的结论也就不作数。
     ④ 结论：**板上的卡分不出"这节课哪一张是讲解"** —— `text` 是
        `title + '\n\n' + body`，讲解和重点在板上长得一模一样（都是 note + rich）。
     ⇒ 所以这段只验**板能验的那部分**：整节课那两张在超预算时保得住。
       「整页被丢要报出页号」是**讲解那一档**的规矩（`collectKnowledge` 的 explain 分支），
       而板上没有 explain 卡 → 那条改成直接喂 item 层的形状单独验（见下面 [③c]）。 */
  const bigDoc = {
    id: 'doc9',
    path: '.资料/八十页的讲义.pdf',
    title: '八十页的讲义',
    x: 0,
    y: 0,
    w: 720,
    pages: Array.from({ length: 40 }, () => [720, 540]),
  }
  const rect9 = pageRects(bigDoc)
  const huge = []
  for (let i = 0; i < 40; i += 1) huge.push({ id: 'h' + i, kind: 'note', rich: true, locked: true, text: '第 ' + (i + 1) + ' 页 · 讲解\n\n' + 'y'.repeat(900), x: 764, y: rect9[i].y, w: 400, h: 300 })
  const bigDeck = [
    { id: 'sum9', kind: 'note', rich: true, locked: true, sum: true, text: '**骨架**\n- 甲 · 第 1 页', x: -444, y: -300, w: 400, h: 100 },
    { id: 'rls9', kind: 'note', rich: true, locked: true, rules: true, text: '**口径**\n- 先画受力图', x: -444, y: -180, w: 400, h: 100 },
  ]
  /* 预算刻意压到 12000（默认是 24000）：① 的教训正是"装得下就什么都验不到"。 */
  const k3 = collectKnowledge([...huge, ...bigDeck], [bigDoc], { maxChars: 12000 })
  if (k3.text.includes('**骨架**') && k3.text.includes('**口径**')) ok('★ 讲义严重超预算时，整节课那两张**照样保得住**（它们排在最前面、有自己的份额）')
  else bad('超预算时整节课那两张被裁掉了（那这个功能就白做了）：' + k3.text.slice(0, 200))
  /* ★ 超预算这件事本身要报出来（`truncated`）—— 一条都不报的话，
     用户以为"整份讲义都发给它了"，而实际只发了一半。 */
  if (k3.truncated > 0) ok(`★ 装不下时**报得出丢了多少张**（truncated = ${k3.truncated}）—— 不报的话用户以为整份都发出去了`)
  else bad('装不下却一张都不报（这个数界面要用）：' + JSON.stringify({ chars: k3.chars, truncated: k3.truncated }))
}

/* ── ③c 「报得出哪几页丢了」这条：核一下它到底能不能被触发（2026-09-22）──────
 * ★ 结论先说：**触发不了**。板上的卡永远是 `note` 或 `formula`
 *   （`Board.jsx` 的 `fresh` 只有这两条出口），而 `isLessonCard` 也**只认这两种**
 *   （`homework.js` 312 行）—— 所以 `kind: 'explain'` 在进 `collectKnowledge` 之前
 *   就被筛掉了，那个往 `droppedPages` 里写的分支**永远走不到**。
 * 📌 这是一处**死代码**，但它**不是 bug**：`truncated` 那段尾注本来就备了退路
 *   （`droppedPages` 空时改说"有 N 张卡没带上"，见 homework.js 562 行），
 *   用户看到的话仍然是实话，只是"哪几页"这个精度拿不到。
 * ⚠ 所以这里**不再假装验它**（从前那两条断言必红、而且红得指错方向：
 *   看的人会以为是"页号没报出来"这个功能坏了，实际是那整条路都不可达）。
 *   改成守卫**当前真实的契约**：explain 形状会被筛掉 + 退路话说得对。
 * 💡 真要让"哪几页"这个精度回来，得先让板上的讲解卡带上出处字段
 *   （和 `sum`/`rules` 同一套做法），那是产品决定，不是自检能替它做的。 */
{
  const explDoc = {
    id: 'docE',
    path: '.资料/讲解版讲义.pdf',
    title: '讲解版讲义',
    x: 0,
    y: 0,
    w: 720,
    pages: Array.from({ length: 40 }, () => [720, 540]),
  }
  const er = pageRects(explDoc)
  const many = []
  for (let i = 0; i < 40; i += 1) {
    many.push({ id: 'x' + i, kind: 'explain', rich: true, locked: true, text: '第 ' + (i + 1) + ' 页 · 讲解\n\n' + 'y'.repeat(900), x: 764, y: er[i].y, w: 400, h: 300 })
  }
  const k4 = collectKnowledge(many, [explDoc], { maxChars: 12000 })
  /* ★ 契约①：`kind: 'explain'` 进不来（`isLessonCard` 只认 note/formula）。
     ⚠ 这条不是在"验一个不存在的输入"，而是在**钉住一个容易忘的事实**：
     有人哪天想给讲解卡加出处字段时，会先发现这里——省得他以为"改个 kind 就行"。 */
  eq(k4.count, 0, '★ `kind: \'explain\'` 的卡压根进不来（isLessonCard 只认 note / formula）—— 那个分支目前不可达')
  if (Array.isArray(k4.droppedPages)) ok('★ droppedPages 始终是个数组（界面上要读它，别某天变成 undefined）')
  else bad('droppedPages 不是数组：' + typeof k4.droppedPages)
  /* ★ 契约②：就算一条都没收上来，也**不许抛**（这条路的输入是板上的原始数据，
     手改板文件写出了什么怪形状都可能）。 */
  const weird = collectKnowledge([{ id: 'w', kind: 'explain', text: '', x: 0, y: 0 }], [], {})
  if (weird && typeof weird.text === 'string' && weird.count === 0) ok('★ 认不出的形状 → 干净地回一份空讲义（不抛、不返回 undefined）')
  else bad('怪形状把 collectKnowledge 弄崩了：' + JSON.stringify(weird))
  /* ★ 契约③：板卡（note + rich）装不下时，尾注要说**实话** —— 报得出张数，
     并且说清"上面是第 X~Y 页"（用户能自己判断要的题在不在里面）。 */
  const boardMany = []
  for (let i = 0; i < 40; i += 1) {
    boardMany.push({ id: 'b' + i, kind: 'note', rich: true, locked: true, text: '第 ' + (i + 1) + ' 页 · 重点\n\n' + 'y'.repeat(900), x: -444, y: er[i].y, w: 400, h: 300 })
  }
  const k5 = collectKnowledge(boardMany, [explDoc], { maxChars: 12000 })
  const tail = k5.text.slice(k5.text.indexOf('（这份讲义太长'))
  if (k5.truncated > 0 && /有 \d+ 张卡没带上|第 [\d、]+ 页的讲解没带上/.test(tail)) ok('★ 装不下时尾注报得出张数（或页号）—— 用户知道"还有内容没带上"')
  else bad('尾注没说实话：' + JSON.stringify({ truncated: k5.truncated, tail: tail.slice(0, 160) }))
  if (/上面是第 \d+~\d+ 页/.test(tail)) ok('★ 尾注说清了"上面是第几页到第几页"（用户能自己判断要的题在不在里面）')
  else bad('尾注没交代页区间：' + tail.slice(0, 160))
}

console.log('\n④ 提示词')

const ask = '第 12 页第 3 题'
const filled = homeworkPrompt(ask, know.text)
if (!/\{\{/.test(filled)) ok('提示词里的占位符全填了（漏一个模型就会看见 {{QUESTION}} 这种字样）')
else bad('还有没填的占位符：' + (filled.match(/\{\{[A-Z]+\}\}/g) || []).join(','))
if (filled.includes(ask)) ok('学生那句话进了提示词')
else bad('学生那句话没进提示词')
if (filled.includes('第一页讲解')) ok('这节课的讲义进了提示词')
else bad('讲义没进提示词')
const emptyKnow = homeworkPrompt(ask, '')
if (!emptyKnow.includes('第一页讲解') && /没给你这节课的讲义/.test(emptyKnow)) ok('没有讲义时**整段换成一句实话**（不是丢一段空的进去）')
else bad('空讲义那条退路不对')
for (const need of ['answer', 'explain', 'question', '说人话', 'LaTeX']) {
  if (HOMEWORK_PROMPT.includes(need)) ok(`提示词里有「${need}」这一条`)
  else bad(`提示词里少了「${need}」`)
}
if (!/\{\{/.test(HOMEWORK_PROMPT.replace('{{PICK}}', '').replace('{{KNOWLEDGE}}', ''))) ok('提示词模板本身只有那两个占位符')
else bad('提示词模板里有别的占位符')

console.log('\n④b 第二种选题法：他**圈住题号**（用户 2026-09-22 要的）')

/* 圈选题和打字说**共用同一个占位符**（`{{PICK}}`），但那一整段说法要换掉：
   打字版是"他告诉你要做哪几道题"，圈选版是"两张图：第一张整页带红框、第二张放大"。 */
const typed = homeworkPrompt('第 12 页第 3 题', '')
const pickedP = homeworkPrompt('', know.text, { picked: true })
if (!/\{\{/.test(pickedP)) ok('圈选题的占位符也全填了')
else bad('圈选题还有没填的占位符：' + (pickedP.match(/\{\{[A-Z]+\}\}/g) || []).join(','))
if (/红框/.test(pickedP) && /第一张/.test(pickedP) && /第二张/.test(pickedP)) {
  ok('圈选题说清了那两张图是什么（第一张整页带红框、第二张红框里放大）')
} else bad('圈选题没说清两张图 —— 模型会对着裁图讲整页')
if (/以红框里那一块为准/.test(pickedP)) ok('★ 明说了"题号以红框里那一块为准"（页上十几道题，不写这条它会自己挑一道）')
else bad('少了"以红框里那一块为准"那条')
if (!/红框/.test(typed) && /他告诉你要做哪几道题/.test(typed)) ok('打字版不提红框（两套说法真的换掉了，不是同一段）')
else bad('打字版和圈选版说的是同一段 —— {{PICK}} 没起作用')
if (homeworkPrompt('只做第 (2) 问', '', { picked: true }).includes('只做第 (2) 问')) ok('圈选题里那句补充说明也带上了')
else bad('圈选题把补充说明丢了')
if (pickedP.includes('第一页讲解')) ok('圈选题照样带上这节课的讲义')
else bad('圈选题没带讲义')
/* 空着那句话也不该出岔子：圈选题里"再说一句"本来就是可留空的。 */
if (!/\{\{/.test(homeworkPrompt('', '', { picked: true }))) ok('圈选题 + 空讲义 + 空补充说明：什么都不填也不出错')
else bad('三个都空的时候占位符没填干净')

console.log('\n⑤ 一边一份：服务端读的是同一个数')

/* ★ 为什么断言这个：`HW_MAX_PAGES` 是"一次最多几页"，前端按它发、服务端按它收。
   两边各写一个 3 的话，改一处就会出现"前端发 4 页、服务端只收 3 页"——
   而那种少一张图**不出声**（模型只会说"这一页上没看到第 3 题"）。 */
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
if (serverSrc.includes('HW_MAX_PAGES')) ok('server.js 用的是**同一个** HW_MAX_PAGES（不是自己写死一个 3）')
else bad('server.js 里没有 HW_MAX_PAGES —— 页数上限变成两处各写一份了')
if (/file' \+ i/.test(serverSrc)) ok('服务端按 file3…fileN 的顺序收第 2 页以后的图')
else bad('服务端没有收多页图的那一段')
const readSrc = fs.readFileSync(path.join(ROOT, 'src/lib/homework-read.js'), 'utf8')
if (/file' \+ \(i \+ 1\)/.test(readSrc)) ok('前端按同样的 file/file2/file3 命名发（两边名字对得上）')
else bad('前端发图用的字段名和服务端对不上')

console.log('\n⑥ 「这份是不是讲课的 PPT」')

/* 造一个临时资料库：`课件.pptx` + `课件.pdf`（PPT 转来的）、`教材.pdf`（手动放进去的）。 */
const tmp = path.join(ROOT, '.cache', 'hw-origin')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(path.join(tmp, '.资料'), { recursive: true })
fs.writeFileSync(path.join(tmp, '.资料', '课件.pptx'), 'x')
fs.writeFileSync(path.join(tmp, '.资料', '课件.pdf'), 'x')
fs.writeFileSync(path.join(tmp, '.资料', '教材.pdf'), 'x')
const a = await docOrigin(tmp, '.资料/课件.pdf')
const b = await docOrigin(tmp, '.资料/教材.pdf')
if (a.fromPpt === true && a.source === '课件.pptx') ok('旁边留着同名原件 → 认出"这是 PPT 转来的"（要提醒他作业在书上）')
else bad('PPT 转来的没认出来：' + JSON.stringify(a))
if (b.fromPpt === false) ok('旁边没有原件 → 不瞎猜（宁可不说，也不要猜错）')
else bad('把一份普通 PDF 说成了 PPT：' + JSON.stringify(b))
fs.rmSync(tmp, { recursive: true, force: true })

/* ── ⑦ "板上一张讲解卡都没有"那一趟不能崩（2026-09-22 用户报的错） ──────────
 * 用户原话："我想让他帮我做题，但是却报错"，面板上弹的是
 *   Cannot read properties of null (reading 'slice')
 * 根因：`knowledge` 这一段**前端在没讲义时根本不发**，而 `extractTextPart`
 * 对"没有这一段"回的是 **null**（不是空串，上面 ③ 那条用例钉着这个约定）；
 * server.js 里偏偏只有它没兜底 —— `null.slice(0, 60000)` 当场抛。
 *
 * ⚠ 为什么这条得钉在**这里**：上面 ③/④ 全是纯函数，`collectKnowledge(cards, [])`
 *   回的是 `{ text: '' }` —— 那种"空讲义"喂进 `homeworkPrompt` 一路没事。
 *   出事的是**再往上一层**：那个空串在 `homework-read.js` 里被 skip 掉、
 *   整段 multipart 里压根没有 `knowledge`。所以这里量的是**服务端读表单的那一步**：
 *   照着 server.js 的写法读一个不存在的字段，必须拿到 null，而且"兜底之后"是空串。 */
console.log('\n⑦ 没有讲义那一段时，服务端读表单不能崩')

/* 造一份**不带 knowledge** 的 multipart（就是"板上一张讲解卡都没有"时前端发的那个）。 */
const bd = '----shBoundaryHW0'
const mkForm = (texts) => {
  const parts = texts.map(
    (t) => '--' + bd + '\r\nContent-Disposition: form-data; name="' + t[0] + '"\r\n\r\n' + t[1] + '\r\n',
  )
  parts.push('--' + bd + '\r\nContent-Disposition: form-data; name="file"; filename="p1.png"\r\nContent-Type: image/png\r\n\r\n\u0001\u0002PNGDATA\r\n')
  parts.push('--' + bd + '--\r\n')
  return { body: Buffer.from(parts.join(''), 'utf8'), ct: 'multipart/form-data; boundary=' + bd }
}
const noKnow = mkForm([
  ['mode', 'homework'],
  ['question', '第 12 页第 3 题'],
])
eq(extractTextPart(noKnow.body, noKnow.ct, 'knowledge'), null, '没有这一段的表单 → extractTextPart 回 null（约定没变）')
/* ★ 正题：照着 server.js 那一行读，兜底之后必须是**空串**，不是 null、更不能抛。 */
let readThrow = ''
let readVal = '<<没读到>>'
try {
  readVal = (extractTextPart(noKnow.body, noKnow.ct, 'knowledge') || '').slice(0, 60000)
} catch (e) {
  readThrow = String((e && e.message) || e)
}
if (!readThrow) ok('★ "没有讲义"时兜底能读下去（不再抛 Cannot read properties of null）')
else bad('没有讲义那一段时读表单抛了：' + readThrow + ' —— 这就是用户看到的英文报错')
eq(readVal, '', '兜底的结果是**空串**（= 空讲义，不是错误）')

/* ★ 源码级的"同一个错别再犯第二次"：三个同族的读法必须都带兜底。
   把 server.js 里所有 `extractTextPart(...)` 后面**紧跟 `.方法(`** 的行找出来 ——
   那种写法一旦碰上 null 就炸。`=== '1'`、`Number(...)`、`|| ''` 都是安全的。 */
const danger = serverSrc
  .split('\n')
  .map((ln, i) => ({ ln, no: i + 1 }))
  .filter((o) => /extractTextPart\([^)]*\)\s*\.\w+\(/.test(o.ln))
if (danger.length === 0) ok('★ server.js 里再没有"直接在 extractTextPart 结果上点方法"的写法（那种活儿全得先兜底）')
else bad('server.js 还有没兜底就点方法的读法：' + danger.map((o) => o.no + ':' + o.ln.trim()).join(' | '))

console.log('\n⑧ 追问：老师刚给的答案得跟着一起发出去（不然学生一句"为什么"它不知道在问哪道题）')

/* 这道题就是 `parseHomework` 收出来的那个形状。 */
const probAsk = {
  label: '第 3 题',
  page: 12,
  question: '一辆车 3 小时行 180 千米，求平均速度。',
  answer: '60 千米/小时',
  explain: '速度 = 路程 ÷ 时间，所以 180 ÷ 3 = 60。',
}
/* ★ 判据是"那段话里**同时**有题号和答案" —— 断言别去 match 中文（这个仓库栽过），
   所以量的是**有没有拼进去**这件事本身，不是措辞。 */
const pre = problemPreamble(probAsk)
eq(pre.includes('第 3 题'), true, '题干那段话里带着题号（"哪一道题"说得清）')
eq(pre.includes('180 ÷ 3 = 60'), true, '★ 老师刚给的那段**解析**在里面 —— 学生问的正是"这里为什么"')
eq(pre.includes('60 千米/小时'), true, '答案在里面')
/* 空题：一个字都没有时回空串，调用方就不该问（不然发出去的是一句没头没尾的话）。 */
eq(problemPreamble({}), '', '空的题 → 空串（这条追问不该发出去）')
eq(problemPreamble(null), '', 'null 也不炸，回空串')

/* 没有题号就用页号兜底（模型偶尔不填 label，但那道题确实有页号）。 */
eq(problemLabel({ label: '第 3 题' }), '第 3 题', '有题号就用题号（原话，一个字不改）')
eq(problemLabel({ page: 12 }).includes('12'), true, '没题号 → 用页号兜底（"第 12 页那道题"）')
eq(problemLabel({}), '这道题', '连页号都没有 → "这道题"（总得有个能指的东西）')

/* ── 历史摆的顺序 ──────────────────────────────────────────────────────
   ★ 第一条**必须**是那段话（题 + 答案），而且角色是 **user** ——
     标成 assistant 的话，模型会"认领"一段它没写过的正文，然后顺着编下去
     （用户可以在两趟之间「↻ 再做一次」，那段答案根本不是它写的）。 */
const h0 = problemHistory(probAsk, [])
eq(h0.length, 1, '还没问过时：历史里就那一条（题 + 答案）')
eq(h0[0].role, 'user', '★ 那一条是**用户的**发言，不是 assistant（"我们贴上去的题"不该算它说的）')

const turns = [
  { role: 'user', text: '这一步为什么要除以 3？' },
  { role: 'assistant', text: '因为速度的定义就是路程除以时间。' },
]
const h1 = problemHistory(probAsk, turns)
eq(h1.length, 3, '问过一轮之后：那条题 + 我问的 + 它答的（三条，按时间顺序）')
eq(h1.map((t) => t.role), ['user', 'user', 'assistant'], '顺序是"题 → 学生的问题 → 老师的回答"')
eq(h1[2].text, '因为速度的定义就是路程除以时间。', '老师的回答原样在历史里（这次问的才有上下文）')

/* ★ 占位和空话**不发**：上游会把 `content: ''` 当成空消息（不报错，
   但模型看到的是一轮"自己什么都没说"的对话）。 */
const h2 = problemHistory(probAsk, [
  { role: 'user', text: '在飞的那一问' },
  { role: 'assistant', text: '', pending: true },
  { role: 'user', text: '' },
])
eq(h2.length, 2, '★ `pending` 的占位和空白的轮次都不发（上游会把空消息当真）')

console.log('\n⑨ 服务端那一侧：认不认 hwask（认错就把一句 LaTeX 当成老师的回答）')

/* ★ 这条是**源码扫描**，因为这道口的形状是"白名单漏一个值 = 静默走错路"：
   服务端那个 `if (mode === ...)` 不认 hwask 的话，回复里没有 `text`、只有 `latex`，
   而前端查 `body.mode !== 'hwask'` 时会逮住 —— 但**服务端自己的日志**里
   那一趟会显示成「手写识别 认出：」，看日志的人会以为这条路根本没进来过。 */
const modeGuards = (serverSrc.match(/mode === 'hwask'/g) || []).length
if (modeGuards >= 4) ok(`★ server.js 里认 hwask 的地方够全（${modeGuards} 处：mode 白名单 / 收图 / 历史 / 超时 / 回话分支）`)
else bad(`server.js 里只有 ${modeGuards} 处认 hwask —— 白名单漏一个值就会静默走岔（回 latex 而不是 text）`)

/* 回话分支那条**单独**查：它是"回 `text` 还是回 `latex`"的分水岭。
   ★ 怎么找它：`const who =` 前面紧挨着那个 `if (...)` 白名单 ——
     从那里向前切一段（`who` 的标签表里**也有** `mode === 'hwask'`，
     所以不能拿"这片区域里有没有 hwask"当判据，那会把标签表也算进去）。 */
const whoAt = serverSrc.indexOf('const who =')
const guard = whoAt >= 0 ? serverSrc.slice(Math.max(0, whoAt - 400), whoAt) : ''
if (/mode === 'hwask'/.test(guard)) ok('★ 回话分支的白名单里认 hwask（那一行决定回 `text` 还是回 `latex`）')
else bad("★ 回话分支没认 hwask —— 追问的回复会被塞进 latex 里回来，界面上显示成一句公式")

/* 提示词换没换：hwask 有自己的提示词（它是"接着讲"，不是"从头做题"）。 */
const { HWASK_PROMPT } = await import('../server-ocr.js')
eq(typeof HWASK_PROMPT, 'string', 'HWASK_PROMPT 导出来了（提示词换过，不是复用作业那一段）')
if (String(HWASK_PROMPT).length > 200) ok(`★ 追问的提示词是一段真提示词（${String(HWASK_PROMPT).length} 字）`)
else bad('HWASK_PROMPT 短得不像提示词 —— 检查它是不是被截断了')

console.log(fails ? `\n${fails} 项失败` : `\n全部通过（${passes} 项）`)
process.exitCode = fails ? 1 : 0
