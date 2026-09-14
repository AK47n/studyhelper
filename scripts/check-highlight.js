// 着色逻辑验证：一层原文 → 一行 HTML，公式/引用/标题/字段有没有被正确认出来。
//   node scripts/check-highlight.js
import assert from 'node:assert'
import { highlightLine, buildLines, lineIndexAt, linePreview } from '../src/components/SourceEditor.jsx'

let pass = 0
const ok = (m) => {
  pass++
  console.log('  ✓ ' + m)
}
const eq = (a, b, m) => {
  assert.strictEqual(a, b, `${m}\n  期望: ${JSON.stringify(b)}\n  实际: ${JSON.stringify(a)}`)
  ok(m)
}

console.log('=== 标题层级 ===')
eq(highlightLine('# 大物 · 电磁学').kind, 'h1', '# → h1')
eq(highlightLine('## 一、场怎么算出来').kind, 'h2', '## → h2')
eq(highlightLine('### 更深一层').kind, 'h3', '### → h3')
eq(highlightLine('#### 四层').kind, 'h4', '#### → h4')
ok('标题 HTML 里带 hl-line-head 由组件加（highlightLine 只报 kind）')

console.log('\n=== 公式识别 ===')
{
  const r = highlightLine('- 公式 | $H = \\frac{B}{\\mu_0}$')
  eq((r.html.match(/hl-formula/g) || []).length, 1, '一对 $ 识别成 1 个公式')
  assert.ok(r.html.includes('\\frac{B}{\\mu_0}'), '公式内容原样保留（含反斜杠）')
  ok('公式内容含 LaTeX 反斜杠不被转义吃掉')
  assert.ok(!r.html.includes('unclosed'), '闭合的公式没有 unclosed 标记')
  ok('闭合公式不加 unclosed')
}
{
  const r = highlightLine('- 公式 | $H = \\frac{B}{\\mu_0')
  assert.ok(r.html.includes('unclosed'), '没写收尾 $ 要标 unclosed')
  ok('未闭合公式标 unclosed（用来提示"还没写完"）')
}

console.log('\n=== 引用识别 ===')
{
  const r = highlightLine('- 用到的量 | [[B]] [[mu0]] [[I]]')
  eq((r.html.match(/data-token="ref"/g) || []).length, 3, '一行里 3 个引用')
  assert.ok(!r.html.includes('unclosed'), '闭合引用不加 unclosed')
  ok('三个闭合引用都认出来')
}
{
  const r = highlightLine('- 用到的量 | [[B]] [[mu')
  const refs = (r.html.match(/data-token="ref"/g) || []).length
  eq(refs, 2, '正在输入的第二个引用也算一个 token')
  eq((r.html.match(/unclosed/g) || []).length, 1, '只有没写完的那个标 unclosed')
  ok('输入到一半的 [[mu 会被高亮成待补全')
}

console.log('\n=== XSS / HTML 转义 ===')
{
  const r = highlightLine('- 标题 | <script>alert(1)</script> & "引号"')
  assert.ok(!r.html.includes('<script'), '尖括号被转义，不会注入')
  assert.ok(r.html.includes('&lt;script&gt;'), '< 变成 &lt;')
  assert.ok(r.html.includes('&amp;'), '& 变成 &amp;')
  ok('危险字符全部转义')
}

console.log('\n=== 字段识别 ===')
for (const key of ['公式', '说的是', '用到的量', '题型', '易错', '注意', '方法', '定义']) {
  const r = highlightLine(`- ${key} | 内容`)
  eq(r.fieldKey, key, `- ${key} | 识别为字段`)
}
eq(highlightLine('- 随便什么 | 内容').fieldKey, null, '不是约定字段名就不当字段')
eq(highlightLine('## 四、量').fieldKey, null, '标题行不会被当字段')
ok('字段名只在 `- 字段名 | ...` 这种形态下才认定')

console.log('\n=== 公式里出现 | 和 [[ 不能误伤 ===')
{
  const r = highlightLine('- 公式 | $a | b$ 后面 [[B]]')
  eq((r.html.match(/hl-formula/g) || []).length, 1, '公式里的 | 不会切碎字段判断')
  eq((r.html.match(/data-token="ref"/g) || []).length, 1, '公式外的引用照常识别')
  ok('公式内的特殊字符不干扰公式外的引用识别')
}

console.log('\n=== 多行切分与光标→行映射 ===')
{
  const text = '# 标题\n- 第一行\n- 第二行\n  - 子行'
  const lines = buildLines(text)
  eq(lines.length, 4, '4 行切成 4 条')
  eq(lines[0].start, 0, '第一行起始偏移 0')
  // "# 标题" 是 4 个字符，加换行 → 第二行从 5 开始
  eq(lines[1].start, 5, '第二行起始偏移 = "# 标题".length(4) + 1 = 5')
  eq(lines[2].start, 5 + '- 第一行'.length + 1, '第三行偏移正确')
  eq(lineIndexAt(lines, 0), 0, '偏移 0 → 第 1 行')
  eq(lineIndexAt(lines, 5), 1, '偏移 5 → 第 2 行')
  eq(lineIndexAt(lines, lines[3].start + 2), 3, '子行内 → 第 4 行')
  ok('行偏移逐行累加正确（跳行功能依赖它）')
}

console.log('\n=== 行内公式预览 ===')
{
  const p = linePreview('- 公式 | $H = \\frac{B}{\\mu_0}$，其中 $B$ 是磁感应强度')
  eq(p.formulaCount, 2, '识别出 2 个公式')
  assert.ok(p.parts.some((x) => x.type === 'text' && x.text.includes('磁感应强度')), '文字部分保留')
  assert.ok(p.parts.filter((x) => x.type === 'math').every((x) => x.html), 'KaTeX 渲染成功')
  ok('多公式 + 混排文字都正确')
}
{
  const p = linePreview('- 说的是 | 没有公式的一行')
  eq(p.formulaCount, 0, '没公式的行 formulaCount = 0')
  ok('无公式行不会弹气泡')
}

console.log(`\n${pass} 项通过 ✓`)
