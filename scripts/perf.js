// 性能自检：每次按键都会重跑这些函数，太慢就会打字卡顿。
//   node scripts/perf.js
import fs from 'node:fs'
import path from 'node:path'
import katex from 'katex'
import { parseDoc } from '../src/lib/parse.js'

const dir = 'data'
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
let base = fs.readFileSync(path.join(dir, files[0]), 'utf8')

// 造一个"一学期规模"的压力样本：把样板重复 30 遍
const big = Array.from({ length: 30 }, (_, i) => base.replace(/^# /m, `# 第${i + 1}章 `)).join('\n\n')

const cases = [
  { name: '小（1 节课，' + files[0] + '）', text: base },
  { name: '大（30 节重复）', text: big },
]

function bench(label, fn, n = 60) {
  fn() // 预热
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n
  console.log(`  ${label.padEnd(28)} ${ms.toFixed(2)} ms/次`)
  return ms
}

console.log('=== parseDoc（树 + 连线 + 索引）===')
const parseTimes = []
for (const c of cases) {
  console.log(`\n  ${c.name}  (${c.text.length} 字符, ${c.text.split('\n').length} 行)`)
  parseTimes.push(bench('parseDoc', () => parseDoc(c.text)))
}

console.log('\n=== KaTeX 渲染（预览里每个公式一次）===')
const formulas = [...base.matchAll(/\$([^$\n]+)\$/g)].map((m) => m[1])
console.log(`  样本里有 ${formulas.length} 个行内公式`)
const katexMs = bench('renderToString', () => {
  for (const f of formulas) katex.renderToString(f, { throwOnError: false, output: 'html' })
}, 20)
console.log(`  → 单个公式约 ${(katexMs / formulas.length).toFixed(3)} ms`)

console.log('\n=== 结论 ===')
const budget = 16 // 60fps 一帧的预算
const est = parseTimes[0] + katexMs
console.log(`  一次按键触发：parseDoc ${parseTimes[0].toFixed(2)}ms + KaTeX ${katexMs.toFixed(2)}ms ≈ ${est.toFixed(2)}ms`)
if (est > budget) {
  console.log(`  ⚠ 超过一帧预算（${budget}ms）→ KaTeX 那一部分必须防抖`)
} else {
  console.log(`  ✓ 在一帧预算内（${budget}ms），可以不防抖`)
}
console.log(`  大文件下 parseDoc 是 ${parseTimes[1].toFixed(2)}ms（${(parseTimes[1] / Math.max(parseTimes[0], 0.001)).toFixed(1)}× 小文件）`)
process.exit(0)
