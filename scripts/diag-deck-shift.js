/* diag-deck-shift：**课件整理的摆版**到底把卡片放在哪儿（没有断言，只把数打出来）。
 *
 * 跑：node scripts/diag-deck-shift.js    （或 npm run diag:deckshift）
 *
 * ── 它是为哪个 bug 留的 ───────────────────────────────────────────────────
 * 2026-09-22：`projectDeck` 的 `shift` 把**已经写进文件的空**又加了一遍 ——
 * 在一份整理过的课件上再点一次「课件整理」（默认全选，最常见的用法），
 * 第 2 页开始的讲解卡一页比一页低（+370、+740……），于是"第 7 页的讲解"
 * 贴在"第 5 页"旁边。症状**完全不报错**：文件里看着一切正常，
 * 只是滚下去以后卡片和页面对不上（正是用户当年报的那句话）。
 *
 * 修法：`projectDeck` 多一个 `existing` 入参（资料里已经写着的 `pageGaps`），
 * `shift` 只累加**增量**。这个探针把"第一次 / 第二次 / 忘了传 existing"三份位置
 * 并排打出来 —— 数字不一样就说明那条账又错了。
 * 回归断言在 `check:keep` 的 [E3]–[E6]（这个探针是给人看现场的，不替代它）。
 *
 * ⚠ 它不碰 data/、不出网、不开浏览器：夹具是现造的（三页 16:9，每页一张 900 高的讲解卡）。
 */
import { pageGapFor, projectDeck } from '../src/lib/doc-cards.js'

const PAGE_H = 540
const PAGE_W = 720
const DOC_GAP = 20

/** 按当前 pageGaps 算页面矩形 —— 口径照抄 docs.js 的 `pageRects`（不另算一套）。 */
function rectsOf(n, gaps) {
  const out = []
  let y = 0
  for (let i = 0; i < n; i += 1) {
    out.push({ x: 0, y, w: PAGE_W, h: PAGE_H })
    y += PAGE_H + DOC_GAP + (Number(gaps[i]) || 0)
  }
  return out
}

const sizes = new Map([
  ['e1', { w: 400, h: 900 }],
  ['e2', { w: 400, h: 900 }],
  ['e3', { w: 400, h: 900 }],
])
const pages = [1, 2, 3].map((n) => ({ page: n, items: [{ id: 'e' + n, kind: 'explain', title: '第 ' + n + ' 页', body: '…' }] }))

console.log('\n[1] 第一次整理（这份资料还没有 pageGaps）')
const first = projectDeck({ pages, sizes, rects: rectsOf(3, []) })
console.log('  卡片 y   =', first.cards.map((c) => c.y))
console.log('  pageGaps =', first.pageGaps)

const written = first.pageGaps.map((g) => Number(g) || 0)
const rects2 = rectsOf(3, written)
console.log('\n[2] 把那些空写进资料之后，页面自己的 y =', rects2.map((r) => r.y))

console.log('\n[3] 再整理一次**同一段页**（默认全选，内容一字不变）')
const second = projectDeck({ pages, sizes, rects: rects2, existing: written })
console.log('  卡片 y   =', second.cards.map((c) => c.y))
console.log('  和第一次的差 =', second.cards.map((c, i) => c.y - first.cards[i].y), '← 必须全是 0')

console.log('\n[4] 对照：**忘了传 `existing`** 会怎样（这就是那个 bug 的样子）')
const naive = projectDeck({ pages, sizes, rects: rects2 })
console.log('  卡片 y   =', naive.cards.map((c) => c.y))
console.log('  和第一次的差 =', naive.cards.map((c, i) => c.y - first.cards[i].y), '← 每页多一份上一页的空')

console.log('\n[5] `pageGapFor` 复算每一页的空 =', written.map(() => pageGapFor(900, PAGE_H)), '（和 [1] 的 pageGaps 应当一致）\n')
