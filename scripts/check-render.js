// 端到端自检：对 data/ 里每份笔记做数据级体检，检查
//   ① 公式有没有真的被 KaTeX 渲染（renderMath.js，和界面同一套参数）
//   ② 引用是不是连上了（status-ref）还是悬空（status-dangling）
//   ③ 枢纽/孤岛的账（从 doc.refCount 算，不再看视图 —— 阅读视图 2026-09-19 砍掉了）
//   ④ 未闭合的 $
// 只读 data/ 和 src/，不碰服务。
// ★ 历史：这一版以前是把 Preview/ContextPanel 两个组件真的 mount 起来数 DOM 的；
//   阅读视图和右栏砍掉后组件没了，检查对象换成**数据本身** —— 界面怎么摆，
//   "公式排得出、引用连得上"这些事实不变。
import fs from 'node:fs'
import path from 'node:path'
import { parseDoc, extractRefs, hasOpenFormula } from '../src/lib/parse.js'
import { renderMathToHtml } from '../src/lib/renderMath.js'

const dir = path.join(process.cwd(), 'data')
/* ⚠ 白板文件也住在 data/ 里、后缀也是 .md（见 README「白板 → 数据长什么样」），
   但它的内容是 JSON，不是笔记格式。第一版没排除它，于是这个自检一打开
   board-*.md 就报"没有渲染出任何 KaTeX 公式" —— 一条假故障，
   而且看起来像笔记界面坏了。
   凡是"遍历 data/*.md"的脚本，都要先跳过 board- 开头的那批。 */
const BOARD_RE = /^board-.*\.md$/i
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !BOARD_RE.test(f))
const boards = fs.readdirSync(dir).filter((f) => BOARD_RE.test(f))
if (boards.length) console.log(`（跳过 ${boards.length} 个白板文件：${boards.join('、')}）`)
if (!files.length) {
  console.log('data/ 里没有笔记文件')
  process.exit(0)
}

let fails = 0
const fail = (msg) => {
  fails++
  console.log('  ✗ ' + msg)
}

/* 模板文件（data/模板*.md）里 【】 是留给用户填的空。
   悬空引用和零被引在模板里是**正常的**（还没填），不该当错误报——
   但也不能装作没看见，所以照常打印，只是归到"待填"里。 */
const isPlaceholder = (s) => /[【】]/.test(String(s || ''))

/* 抽一段文字里的行内公式（$...$，\$ 转义不算）。
   和界面上"着色层认公式"同一套边界 —— 数据里只有这一种公式形态。 */
function formulasOf(s) {
  const clean = String(s || '').replace(/\\\$/g, '')
  const out = []
  const re = /\$([^$]+)\$/g
  let m
  while ((m = re.exec(clean))) out.push(m[1])
  return out
}

for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8')
  const doc = parseDoc(text)
  console.log(`\n=== ${f} ===`)

  // ① 公式渲染（renderMathToHtml 排不出来回 null —— 和界面"宁可丑不可丢"同一行为）
  let katexOk = 0
  let katexBad = []
  for (const n of doc.nodes) {
    for (const latex of formulasOf(n.title + ' ' + n.body)) {
      if (renderMathToHtml(latex)) katexOk++
      else katexBad.push(`L${n.line + 1} $${latex.slice(0, 24)}…`)
    }
  }
  if (katexOk === 0 && katexBad.length === 0) console.log('  （这份笔记里没有公式）')
  else console.log(`  ✓ KaTeX 排出 ${katexOk} 个公式`)
  if (katexBad.length) fail(`${katexBad.length} 个公式排不出来: ${katexBad.slice(0, 3).join('；')}`)

  // ② 引用状态
  let refs = 0
  let dangling = 0
  let expectedTodo = 0
  for (const n of doc.nodes) {
    for (const r of extractRefs(n.body)) {
      refs++
      if (!doc.resolveOne(r)) {
        dangling++
        if (isPlaceholder(r)) expectedTodo++
      }
    }
  }
  if (dangling > 0 && dangling <= expectedTodo) {
    console.log(`  ✓ 引用标签 ${refs} 个；悬空 ${dangling} 处 = 模板里还没填的【】空位`)
  } else {
    console.log(`  ✓ 引用标签 ${refs} 个，其中悬空 ${dangling} 个`)
    if (dangling > 0) fail(`${dangling} 处引用指向了不存在的节点`)
  }

  // ③ 枢纽/孤岛的账（refCount 由 parseDoc 算，阅读视图没了它也照常成立）
  const realQty = doc.quantityNodes.filter((n) => !isPlaceholder(n.title))
  const hubs = realQty.filter((n) => (doc.refCount.get(n.id) || 0) > 0).length
  const islands = realQty.length - hubs
  console.log(`  ✓ 量节点 ${realQty.length} 个：被引用 ${hubs}，孤岛 ${islands}`)

  // ④ 未闭合的 $ 检查
  const unclosed = doc.nodes.filter((n) => hasOpenFormula(n.title + ' ' + n.body))
  if (unclosed.length) {
    fail(`${unclosed.length} 个节点的 $ 没配对（公式没写完）: L${unclosed.map((n) => n.line + 1).join(', L')}`)
  } else console.log('  ✓ 所有公式的 $ 都配对了')
}

console.log(fails ? `\n有 ${fails} 处问题` : '\n全部通过 ✓')
process.exit(fails ? 1 : 0)
