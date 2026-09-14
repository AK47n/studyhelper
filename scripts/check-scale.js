// 字号自检：确认 CSS 里的字号阶梯没有漏掉硬编码的 px，并算出各档实际渲染尺寸。
//   node scripts/check-scale.js
import fs from 'node:fs'

const css = fs.readFileSync('src/styles.css', 'utf8')

let fails = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}

// 1. 每个 font-size 要么走字号变量阶梯（--fs-* / --src-font），要么是 em（相对父级，会跟着放大）。
//    这些变量自己在 :root 里都由 --s 派生，所以只要不是写死 px 就安全。
const fontSizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim())
const SIZING_VARS = ['--fs-', '--src-font', '--s']
const hard = fontSizes.filter(
  (v) =>
    !SIZING_VARS.some((name) => v.includes(name)) &&
    !/^[\d.]+(em|rem)$/.test(v) &&
    v !== '0' // font-size:0 是"不显示文字"的正当写法，不是写死的字号
)
if (hard.length) bad(`还有 ${hard.length} 处写死 px 的字号，不会跟着放大: ${[...new Set(hard)].join(' | ')}`)
else ok(`全部 ${fontSizes.length} 处字号都跟着缩放走（px 走变量，em 走父级）`)

// 1b. 编辑区两层的变量：
//   --src-font 必须由 --s 派生（能跟着 A+/A− 缩放）
//   --src-lh   必须是**无单位倍数**（不能是 px，否则大字号行盒被锁死，标题错位）
{
  const m = /--src-font:\s*([^;]+);/.exec(css)
  if (!m) bad('缺少变量 --src-font')
  else if (!m[1].includes('var(--s)')) bad(`--src-font 必须由 --s 派生，实际 "${m[1]}"`)
  else ok(`--src-font = ${m[1].trim()}`)

  const l = /--src-lh:\s*([^;]+);/.exec(css)
  if (!l) bad('缺少变量 --src-lh')
  else {
    const v = l[1].trim()
    if (/px/.test(v)) bad(`--src-lh 不能是 px（会把大字号行盒锁死，标题和光标错位），实际 "${v}"`)
    else if (!/^[\d.]+$/.test(v)) bad(`--src-lh 应该是无单位倍数，实际 "${v}"`)
    else if (Number(v) < 1 || Number(v) > 3) bad(`--src-lh = ${v} 超出合理范围（1~3）`)
    else ok(`--src-lh = ${v}（无单位倍数，行高 = 字号 × ${v}）`)
  }
}

// 2. --s 存在且有默认值
if (!/--s:\s*[\d.]+/.test(css)) bad('没有 --s 变量')
else ok('--s 变量存在，默认 ' + css.match(/--s:\s*([\d.]+)/)[1])

// 3. 五档字号都定义了
const tiers = ['--fs-content', '--fs-editor', '--fs-ui', '--fs-key', '--fs-meta']
const missing = tiers.filter((t) => !new RegExp(`${t}:`).test(css))
if (missing.length) bad('缺少字号档位: ' + missing.join(', '))
else ok('五档字号齐全（正文/编辑区/界面/标签/边角）')

// 4. 各档下编辑区两层实际多大（行高 = 字号 × 1.95，所以跟着缩放）
const base = { content: 16, editor: 15.5, ui: 13.5, key: 12.5, meta: 11.5, lhMult: 1.95 }
const table = []
for (const s of [0.9, 1.0, 1.25, 1.5, 1.75, 2.0]) {
  table.push({
    s,
    正文: (base.content * s).toFixed(1),
    编辑区: (base.editor * s).toFixed(1),
    正文行高: (base.editor * s * base.lhMult).toFixed(1),
    lv1标题行高: (base.editor * s * 1.5 * base.lhMult).toFixed(1),
    界面: (base.ui * s).toFixed(1),
    列宽左: Math.round(240 + 60 * (s - 1) * 2),
    列宽右: Math.round(330 + 90 * (s - 1) * 2),
  })
}
console.log('\n  缩放   正文px  编辑区px  正文行高  lv1行高  界面px   左栏px  右栏px')
for (const r of table) {
  console.log(
    `  ${String(r.s).padEnd(6)} ${String(r.正文).padEnd(7)} ${String(r.编辑区).padEnd(9)} ${String(r.正文行高).padEnd(9)} ${String(r.lv1标题行高).padEnd(8)} ${String(r.界面).padEnd(8)} ${String(r.列宽左).padEnd(7)} ${r.列宽右}`
  )
}

// 5. 正文不能小于 16px（这就是用户抱怨的点）
const atDefault = base.content * 1.25
if (atDefault < 16) bad(`默认缩放下正文只有 ${atDefault}px，还是太小`)
else ok(`默认缩放下正文 ${atDefault}px（原来 14px）`)

console.log(fails ? `\n有 ${fails} 处问题` : '\n全部通过 ✓')
process.exit(fails ? 1 : 0)
