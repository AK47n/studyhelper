// 编辑区自检（新架构：单一滚动容器 + 两层叠放）
//
// 这套检查只盯"结构上必须成立"的事，因为踩过的坑全都是结构性的：
//   1. textarea 只有一个字号 → 着色层绝不能给某一行改字号（否则两层总高不同，整篇越往下越错）
//   2. 两层排版参数必须逐字相同（否则折行点不同）
//   3. textarea 自己不能滚动（否则要同步 translateY，而那个同步在渲染层不可靠）
//   4. 原生光标必须藏掉（自绘光标接管）
//   5. 行底色必须按视觉行重复铺（折行的第二行会跑出色块）
//
// 运行期（真浏览器）的断言在 scripts/tail-compare.js 和 scripts/caret-final.js。
//   node scripts/check-align.js
import fs from 'node:fs'

const css = fs.readFileSync('src/styles.css', 'utf8')
const jsx = fs.readFileSync('src/components/SourceEditor.jsx', 'utf8')

let fails = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  fails++
  console.log('  ✗ ' + m)
}

function indexRules(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '')
  const map = new Map()
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(clean))) {
    const decls = {}
    for (const part of m[2].split(';')) {
      const j = part.indexOf(':')
      if (j === -1) continue
      decls[part.slice(0, j).trim()] = part.slice(j + 1).trim()
    }
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      map.set(sel, { ...(map.get(sel) || {}), ...decls })
    }
  }
  return map
}

const cssClean = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rules = indexRules(css)
const declsOf = (s) => rules.get(s) || null

// 只在"注释外"的代码里找关键字 —— 注释里会提到这些名字来解释为什么不能这么做
const jsxCode = jsx
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join('\n')

// ── 1. 单一滚动容器
console.log('=== 单一滚动容器（不要有第二个滚动层）===')
const scrollRule = declsOf('.srcscroll')
const rawRule = declsOf('.raw')
if (!scrollRule) bad('找不到 .srcscroll')
else {
  if (!String(scrollRule['overflow-y'] || '').includes('auto')) bad('.srcscroll 应该是滚动容器（overflow-y: auto）')
  else ok('.srcscroll 是滚动容器')
  if (scrollRule['position'] !== 'relative') bad('.srcscroll 需要 position: relative 作为定位基准')
  else ok('.srcscroll position: relative')
}
if (!rawRule) bad('找不到 .raw')
else if (!String(rawRule['overflow'] || '').includes('hidden')) {
  bad(`.raw 不能自己滚动（当前 overflow: ${rawRule['overflow']}）—— 否则又要同步 translateY，而那个同步在渲染层不可靠`)
} else ok('.raw overflow: hidden（自己不滚动）')
if (/translateY/.test(jsxCode)) {
  bad('SourceEditor.jsx 的代码里还有 translateY —— 新架构不需要滚动同步，确认没有残留')
} else ok('没有滚动同步的 translateY（共用一个滚动容器，不需要）')

// ── 2. 两层排版参数必须同在一个规则块里
console.log('\n=== 两层排版参数（必须写在同一规则块里）===')
const sharedBlock = /\.raw,\s*\n?\.hl-inner\s*\{([^}]*)\}/.exec(cssClean)
if (!sharedBlock) bad('找不到 ".raw, .hl-inner" 共享规则块')
else {
  const shared = {}
  for (const part of sharedBlock[1].split(';')) {
    const j = part.indexOf(':')
    if (j === -1) continue
    shared[part.slice(0, j).trim()] = part.slice(j + 1).trim()
  }
  const REQUIRED = [
    ['position', 'absolute'],
    ['padding', null],
    ['font-family', null],
    ['font-size', null],
    ['line-height', null],
    ['letter-spacing', 'normal'],
    ['word-spacing', 'normal'],
    ['tab-size', '4'],
    ['white-space', 'pre-wrap'],
    ['overflow-wrap', 'break-word'],
    ['box-sizing', 'border-box'],
  ]
  for (const [prop, expect] of REQUIRED) {
    const v = shared[prop]
    if (v === undefined) bad(`共享块里缺少 ${prop}`)
    else if (expect && v !== expect) bad(`${prop} 应为 "${expect}"，实际 "${v}"`)
    else ok(`${prop}: ${v}`)
  }
  const lhv = String(shared['line-height'] || '')
  if (/px/.test(lhv)) bad(`行高不能是 px（textarea 会把大字号行盒锁死），实际 "${lhv}"`)
  else if (!lhv.includes('var(--src-lh)')) bad(`行高必须用 var(--src-lh)，实际 "${lhv}"`)
  else ok('行高用无单位变量 var(--src-lh)')
}

// ── 3. 着色层绝不能改字号（整篇错位的根因）
console.log('\n=== 着色层不得修改字号（根因防线）===')
const headRules = [...cssClean.matchAll(/\.hl-line\.head[^{]*\{[^}]*\}/g)].map((m) => m[0])
const sizeRules = headRules.filter((r) => /font-size\s*:/.test(r))
if (sizeRules.length) {
  bad(
    `.hl-line.head* 里出现了 font-size —— textarea 只有单一字号，改了它两层总高就不同，整篇越往下越错：\n       ${sizeRules[0].slice(0, 90)}`
  )
} else ok('.hl-line.head* 没有改字号（标题只用字重/颜色/色带区分）')
// 只在"注释外"的代码里找
if (/HEAD_SCALE/.test(jsxCode)) {
  bad('SourceEditor.jsx 的代码里出现了 HEAD_SCALE —— 不要再加回来')
} else ok('SourceEditor.jsx 代码里没有字号倍率表')
if (/fontScale/.test(jsxCode)) bad('SourceEditor.jsx 的代码里还有 fontScale 的用法')
else ok('代码里没有 fontScale 的用法')

// ── 4. 折行行为
console.log('\n=== 折行行为（最容易翻车的地方）===')
const hll = declsOf('.hl-line')
if (!hll) bad('找不到 .hl-line')
else {
  if (hll['height'] !== undefined) bad('.hl-line 用了固定 height —— 折行的行会溢出到下一行')
  else if (hll['min-height']) ok(`.hl-line min-height: ${hll['min-height']}（折行的行可自然变高）`)
  else bad('.hl-line 既没有 height 也没有 min-height')
  if (hll['box-sizing'] !== 'content-box') bad(`.hl-line 必须 content-box，实际 "${hll['box-sizing']}"`)
  else ok('box-sizing: content-box（文字可用宽度与 textarea 相等）')
}

// ── 5. 自绘光标
console.log('\n=== 自绘光标 ===')
if (!/className=\{'caret/.test(jsx)) bad('没有自绘光标的渲染逻辑')
else ok('有自绘光标渲染')
if (!/measureCaretX/.test(jsx) || !/createRange/.test(jsx)) {
  bad('光标定位没有用 Range 量真实字形 —— 别用宽度推算（推算过两次，都错了）')
} else ok('光标位置用 Range 量真实字形（零假设）')
if (!/\.caret\s*\{/.test(cssClean)) bad('缺少 .caret 样式')
else ok('.caret 样式存在')
if (!/\.srcscroll\s+\.raw\s*\{[^}]*caret-color:\s*transparent/.test(cssClean)) {
  bad('忘了藏原生光标（.srcscroll .raw { caret-color: transparent }），会看到两根光标')
} else ok('原生光标已隐藏')
if (!/@keyframes\s+caret-blink/.test(cssClean)) bad('缺少 caret-blink 闪烁动画')
else ok('有闪烁动画')
{
  const caretRules = [...cssClean.matchAll(/\.caret\b[^{]*\{/g)].map((m) => m[0].trim())
  const suspicious = caretRules.filter((r) => !/^\.caret(\s*\{|\.on)/.test(r) && !r.includes('.srcscroll'))
  if (suspicious.length) bad(`.caret 被别的组件复用了: ${suspicious.join(' / ')}`)
  else ok('.caret 只用于自绘光标')
}

// ── 6. 行底色必须按视觉行重复铺
console.log('\n=== 行底色铺法 ===')
const active = declsOf('.hl-line.active')
if (!active) bad('找不到 .hl-line.active')
else if (active['background-color']) {
  bad('.hl-line.active 用了 background-color —— 折行的第二行会跑到色块外，必须用 repeating-linear-gradient')
} else if (!String(active['background-image'] || '').includes('repeating-linear-gradient')) {
  bad(`.hl-line.active 的底色必须用 repeating-linear-gradient，实际 "${active['background-image']}"`)
} else ok('.hl-line.active 用 repeating-linear-gradient')

// ── 7. 样式与组件对得上
console.log('\n=== 样式与组件 ===')
for (const c of ['hl-inner', 'hl-line', 'hl-formula', 'hl-ref', 'line-preview', 'srcscroll', 'srcwrap']) {
  if (!css.includes('.' + c)) bad(`缺少样式 .${c}`)
  else if (!jsx.includes(c)) bad(`SourceEditor.jsx 里没有用到 ${c}`)
  else ok(`${c}`)
}
if (jsx.includes('data-token="ref"') && jsx.includes('data-token="formula"')) ok('引用/公式都打了 data-token')
else bad('缺少 data-token 标记')

console.log(fails ? `\n有 ${fails} 处问题` : '\n全部通过 ✓')
process.exit(fails ? 1 : 0)
