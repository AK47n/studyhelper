import fs from 'node:fs'
import path from 'node:path'
import { parseDoc, renderTitle, displayBody, quantityRefsIn } from '../src/lib/parse.js'

const dir = 'data'
let bad = 0
/* 白板文件（board-*.md）内容是 JSON，不是笔记格式 —— 它不是笔记，别拿笔记的规矩考它。
   凡是遍历 data/*.md 的脚本都得跳过它，否则会报一条看着像"笔记坏了"的假故障。 */
const files = fs.readdirSync(dir).filter((x) => x.endsWith('.md') && !/^board-.*\.md$/i.test(x))
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8')
  const doc = parseDoc(text)
  console.log(`\n=== ${f} ===`)
  console.log(`节点 ${doc.nodes.length}，量 ${doc.quantityNodes.length}`)

  const walk = (n, d) => {
    const heat = doc.isQuantity.get(n.id) ? `  [${doc.refCount.get(n.id)} 处]` : ''
    console.log('  '.repeat(d) + '- ' + renderTitle(n) + heat)
    n.children.forEach((c) => walk(c, d + 1))
  }
  doc.root.children.forEach((c) => walk(c, 0))

  console.log('--- 被引次数 ---')
  const rows = doc.quantityNodes
    .map((n) => ({ name: (n.title || '').trim(), count: doc.refCount.get(n.id) || 0 }))
    .sort((a, b) => b.count - a.count)
  for (const r of rows) console.log(`  ${String(r.count).padStart(2)} 处  ${r.name}${r.count === 0 ? '   ← 孤岛' : ''}`)

  console.log('--- 量节点的说明文字是否解析出来 ---')
  for (const q of doc.quantityNodes.slice(0, 4)) {
    const body = displayBody(q).map((f) => f.text).join(' / ')
    console.log(`  ${renderTitle(q)} → ${body || '(空!)'}`)
    if (!body) bad++
  }

  const dangling = new Set()
  for (const n of doc.nodes) for (const t of quantityRefsIn(n)) if (!doc.resolveOne(t)) dangling.add(`[[${t}]] @L${n.line + 1}`)
  const sample = doc.nodes.find((n) => quantityRefsIn(n).length > 0)
  if (sample) console.log(`  「${renderTitle(sample)}」→ ${quantityRefsIn(sample).join(', ')}`)
  console.log(dangling.size ? '  ⚠ 悬空: ' + [...dangling].join(', ') : '  ✓ 没有悬空引用')
}
process.exit(bad ? 1 : 0)
