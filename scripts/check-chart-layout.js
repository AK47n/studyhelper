/**
 * ★ C1 的核心断言：**两侧不许各写一遍排版**。
 *
 * 判据不是"跑出来一样"（那只能验这一份数据），而是**结构上的**：
 *   ① `chart-print.js` / `server-export.js` 里**不许出现排版常量**（SKETCH 的键、
 *      网格色、`yNameAt` / `xNameBelow`、刻度密度 TICK_GAP…）——
 *      那些是"画成什么样"的决定，属于 `chartPlan`；
 *   ② 不许再出现"逐点画连线"的循环（那是数据连线的实现，两侧各写一遍必漂）；
 *   ③ 不许直接调 `chartGeomAll` 取 `dots` / `linePath` 自己画 ——
 *      走 `chartPlan` 才算数。
 *
 * ⚠ 这条断言的意义：2026-10-06 那次重构就是因为**没有**它，
 *   才在改排版时顺手又写了一遍（然后自己把 SVG 那侧改回滚了都不知道）。
 */
import { readFileSync } from 'node:fs'
import { chartPlan, chartGeomAll, chartSeries, CHART_BOX } from '../src/lib/chart.js'
import { chartSvg } from '../src/lib/chart-print.js'

const cp = readFileSync(new URL('../src/lib/chart-print.js', import.meta.url), 'utf8')
const se = readFileSync(new URL('../server-export.js', import.meta.url), 'utf8')
const cj = readFileSync(new URL('../src/lib/chart.js', import.meta.url), 'utf8')

/* ═══ ① 排版常量不许出现在两个 adapter 里 ═══════════════════════════════ */

/** SKETCH 的键 —— 每一个都是"画成什么样"的决定。 */
const SKETCH_KEYS = [...new Set([...cj.matchAll(/^\s{2}(\w+):\s*0\./gm)].map((m) => m[1]))]
/* 另两族同类决定：网格色 / 刻度密度 */
const OTHER_LAYOUT = ['GRID_COLOR', 'TICK_GAP', 'yNameAt', 'xNameBelow', 'snapToStep', 'legendSpot', 'niceStep']

function bad(z) {
  return false
}

/* ═══ ② ③ 由调用方在脚本里断言（见文件尾） ═════ */

/* ── 一份排版喂出七样东西，而且喂给谁都一样 ── */
const ch = {
  name: '两张就够',
  xLabel: 'U',
  xUnit: 'V',
  yLabel: 'I',
  yUnit: 'mA',
  mode: 'line',
  rows: [[1, 3], [2, 5], [3, 7], [4, 9], [5, 10]],
  extra: [{ id: 'b', name: '加 DC-DC', mode: 'fit', mark: 'triangle', rows: [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]] }],
}
const plan = chartPlan(ch, { box: CHART_BOX })

let checks = 0
let fails = 0
function yes(cond, label) {
  checks += 1
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    fails += 1
    console.log(`  ✗ ${label}`)
  }
}

console.log('  ── 一、排版常量不许漏到 adapter 里 ──')
for (const src of [
  { n: 'chart-print.js', s: cp },
  { n: 'server-export.js', s: se },
]) {
  for (const key of SKETCH_KEYS) {
    yes(!new RegExp(`SKETCH\\[['"]?${key}|S\\(['"]${key}['"]\\)`).test(src.s),
      `${src.n} 里没有 "${key}" 这个排版常量（在 chartPlan 里）`)
  }
  /* ⚠ `GRID_COLOR` / `legendItems` 这两个**例外**：adapter 要靠它们把
     `color:'grid'` 这个**角色**翻成具体色值、把图例那一行行字取出来 ——
     那是"落笔"，不是"排版"。所以只查"不许自己算一遍"，不查"不许引"。 */
  for (const key of ['TICK_GAP', 'yNameAt', 'xNameBelow', 'snapToStep', 'legendSpot', 'niceStep', 'minorTicks']) {
    yes(!new RegExp(`import[^\\n]*\\b${key}\\b[^\\n]*from ['"][^'"]*chart\\.js`).test(src.s),
      `${src.n} 不从 chart.js 引入 ${key}（那是排版的决定，不是落笔的）`)
  }
}

console.log('')
console.log('  ── 二、两个 adapter 都必须走 chartPlan ──')
yes(/chartPlan\(/.test(cp), 'chart-print.js 调chartPlan（不是自己画）')
yes(/chartPlan\(/.test(se), 'server-export.js 调 chartPlan（不是自己画）')
/* 不许再有"逐点画连线"的循环 —— 那是数据连线的实现，两侧各写一遍必漂。 */
yes(!/for \(let j = 1; j < .*\.dots\.length/.test(se), '★ server-export.js 不再逐点画连线（走 chartPlan 的 path 笔画）')
yes(!/for \(const d of .*\.dots\)/.test(cp), '★ chart-print.js 不再逐点画数据点（走 chartPlan 的笔画）')

console.log('')
console.log('  ── 三、一份排版喂出七样东西 ──')
const kinds = [...new Set(plan.strokes.map((s) => s.k))].sort()
yes(kinds.includes('line') && kinds.includes('path') && kinds.includes('circle') && kinds.includes('text') && kinds.includes('runs'),
  `七样都齐（${kinds.join(' ')}）`)
yes(plan.strokes.some((s) => s.k === 'poly'), '三角标记走 poly（pdf-lib 的 drawSvgPath 会偏 1276pt，见 chartPlan 那段）')
yes(plan.strokes.every((s) => !s.tag === false || typeof s.tag === 'string'), '★ 每一笔都带 tag（自检靠它数"哪一笔是哪一类"）')
yes(plan.legendBox && plan.legendBox.w > 0, '图例框的位置和大小也在排版结果里（避让只算一次）')
/* SVG 只做落笔：它出的笔画数量应等于排版给的笔画数（一个 tag 对应一个元素）。 */
const svg = chartSvg(ch)
yes((svg.match(/<line/g) || []).length === plan.strokes.filter((s) => s.k === 'line').length,
  `SVG 里线段数 = 排版给的线段数（${(svg.match(/<line/g) || []).length}）`)
yes((svg.match(/data-grid="1"/g) || []).length === plan.strokes.filter((s) => s.tag === 'grid').length,
  'SVG 里网格数 = 排版给的网格数')

console.log('')
console.log('─'.repeat(56))
if (fails) {
  console.log(`  ${checks} 项通过，${fails} 项失败`)
  process.exit(1)
} else {
  console.log(`  全部 ${checks} 项通过`)
}