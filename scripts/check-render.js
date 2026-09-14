// 端到端自检：把整棵总结树在 Node 里渲染成 HTML，检查
//   ① 公式有没有真的被 KaTeX 渲染
//   ② 引用是不是连上了（status-ref）还是悬空（status-dangling）
//   ③ 枢纽/孤岛色标有没有出现
// 只读 data/ 和 src/，不碰服务。
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Preview from '../src/components/Preview.jsx'
import ContextPanel from '../src/components/ContextPanel.jsx'
import { parseDoc, extractRefs } from '../src/lib/parse.js'

const dir = path.join(process.cwd(), 'data')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
if (!files.length) {
  console.log('data/ 里没有 .md 文件')
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

for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8')
  const doc = parseDoc(text)
  console.log(`\n=== ${f} ===`)

  // ① 预览渲染
  let previewHtml = ''
  try {
    previewHtml = renderToStaticMarkup(React.createElement(Preview, { doc, selectedId: null, onSelect() {}, onRefTitle() {} }))
  } catch (e) {
    fail('Preview 渲染抛异常: ' + e.message)
    continue
  }
  if (!previewHtml.includes('class="katex"')) fail('预览里没有渲染出任何 KaTeX 公式')
  else console.log(`  ✓ 预览渲染成功，KaTeX 公式块 ${(previewHtml.match(/class="katex"/g) || []).length} 个`)

  // ② 引用状态
  const refs = (previewHtml.match(/class="ref[^"]*"/g) || []).length
  const dangling = (previewHtml.match(/class="ref dangling"/g) || []).length
  const expectedTodo = doc.nodes.reduce((a, n) => {
    for (const r of extractRefs(n.body)) if (isPlaceholder(r) && !doc.resolveOne(r)) a++
    return a
  }, 0)
  if (dangling > 0 && dangling <= expectedTodo) {
    console.log(`  ✓ 引用标签 ${refs} 个；悬空 ${dangling} 处 = 模板里还没填的【】空位`)
  } else {
    console.log(`  ✓ 引用标签 ${refs} 个，其中悬空 ${dangling} 个`)
    if (dangling > 0) fail(`${dangling} 处引用指向了不存在的节点`)
  }

  // ③ 色标（只数用户真正填过的量；还没替换的【】不算）
  const heat = (previewHtml.match(/badge heat/g) || []).length
  const island = (previewHtml.match(/badge island/g) || []).length
  const realQty = doc.quantityNodes.filter((n) => !isPlaceholder(n.title))
  console.log(`  ✓ 枢纽色标 ${heat} 个，孤岛标记 ${island} 个`)
  if (realQty.length > 0 && heat === 0) fail('有量节点，但一个枢纽色标都没有——连线没算出来')

  // ④ 未闭合的 $ 检查
  const unclosed = doc.nodes.filter((n) => {
    const s = (n.title + ' ' + n.body).replace(/\\\$/g, '')
    return (s.match(/\$/g) || []).length % 2 === 1
  })
  if (unclosed.length) {
    fail(`${unclosed.length} 个节点的 $ 没配对（公式没写完）: L${unclosed.map((n) => n.line + 1).join(', L')}`)
  } else console.log('  ✓ 所有公式的 $ 都配对了')

  // ⑤ 右侧面板：选一个填过的量节点，看反向索引
  const q =
    realQty.find((n) => (doc.refCount.get(n.id) || 0) > 0) || realQty[0] || doc.quantityNodes[0]
  if (q) {
    const filled = !isPlaceholder(q.title)
    let ctx = ''
    try {
      ctx = renderToStaticMarkup(
        React.createElement(ContextPanel, { doc, selectedId: q.id, onSelect() {}, onRefTitle() {}, onJumpLine() {} })
      )
    } catch (e) {
      fail('ContextPanel 渲染抛异常: ' + e.message)
    }
    const m = ctx.match(/被这些地方用到（(\d+)）/)
    console.log(`  ✓ 右侧面板选了「${q.title}」→ 被这些地方用到（${m ? m[1] : '?'}）`)
    if (filled && (doc.refCount.get(q.id) || 0) > 0 && (!m || m[1] === '0')) fail('反向索引没渲染出来')
  }
}

console.log(fails ? `\n有 ${fails} 处问题` : '\n全部通过 ✓')
process.exit(fails ? 1 : 0)
