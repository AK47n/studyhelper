/* check-rich：讲义卡正文（`rich: true`）那一层渲染的断言。
 *
 * ── 为什么单开一个脚本 ──────────────────────────────────────────────────
 * 这条链上最容易坏、而且坏了**不报错**的一类，是"模型写的式子没排出来"：
 * 卡片照样有字、照样存盘、自检照样绿 —— 学生看到的却是 `\frac{1}{\sqrt{…}}`
 * 这一串 LaTeX 源码，而**没人会因此报错**。
 *
 * 2026-09-23 用户报的「board4.1 第 33 页讲解卡公式没显示出来」正是这个：
 * 式子写在**句子中间**（`…先看幅度：$$…$$ 这时的频率轴…`），而当时只有
 * "整行是 `$$…$$`"那一支认得它，行内那一支把 `$$` 当成两个空的行内公式。
 * 根子和"为什么只有一份 `splitDisplay`"都在 `src/lib/rich.js`。
 *
 * ── 判据为什么写成"不许有裸的 `$$`" ────────────────────────────────────
 * 卡上出现 `$$` 只有两种可能：式子没排出来，或者模型少写了一半。
 * 前一种是 bug（这次这个），后一种**必须**原样留着（宁可丑，不可丢）——
 * 所以下面把它俩分开断言：该排的一律不许剩 `$$`，排不了的必须一个字不少。
 *
 * 用法：node scripts/check-rich.js   （或 npm run check:rich）
 */
import { readFileSync } from 'node:fs'
import { richHtml } from '../src/lib/rich.js'

let fails = 0
let checks = 0
const ok = (m) => {
  checks += 1
  console.log('  ✓ ' + m)
}
const bad = (m) => {
  fails += 1
  console.log('  ✗ ' + m)
}
const yes = (cond, label) => (cond ? ok(label) : bad(label))

/* 去掉标签之后"学生实际看到的那串字"。裸 `$$`、LaTeX 源码都在这儿才看得出来。 */
const visible = (html) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const hasMath = (html) => html.includes('katex')

/* ── 一句真的从板上抄下来的讲解（board-4-1 第 33 页那张卡，2026-09-23 那个 bug 的现场）── */
const P33 =
  '这一页拿一个具体例子把频谱读“活”。设 $a=1$、$\\omega_0=2\\pi$，信号单位是 V。' +
  '先看幅度：$$|X(j\\omega_0)|=\\frac{1}{\\sqrt{1+4\\pi^2}}\\approx 0.157\\ \\text{V/(rad}\\cdot\\text{Hz)}$$ ' +
  '这时的频率轴是角频率 $\\omega$，所以 0.157 是“每 rad/s”的密度。'

console.log('\n[1] ★ 句子中间的 `$$…$$`（用户报的那一条）')
{
  const html = richHtml(P33)
  yes(hasMath(html), '排出了 KaTeX（式子没被当成纯文本）')
  yes(!visible(html).includes('$$'), '★ 学生看不到裸的 `$$`')
  yes(!visible(html).includes('\\frac'), '★ 学生看不到 LaTeX 源码（`\\frac` 那串）')
  /* 切开之后是"前半句 | 式子 | 后半句"三段 —— 句子没被吃掉 */
  const segs = html.split('<div class="bd-rich-tex">')
  yes(segs.length === 2, '式子单独成了一段（前后两句各自成段）')
  yes(visible(segs[0]).includes('先看幅度'), '前半句还在（"先看幅度："）')
  yes(visible(segs[1]).includes('这时的频率轴'), '后半句还在（没被并进式子那段）')
}

console.log('\n[2] 整行 / 列表项 / 行内：三种写法都得排出来')
{
  const line = richHtml('$$E=mc^2$$')
  yes(hasMath(line) && !visible(line).includes('$$'), '整行 `$$…$$` → 摆开的式子')

  /* 提纲卡的"核心式子"就是这个形状（doc-summary.js 拼的 `- $$式子$$ —— 说明`） */
  const li = richHtml('- $$F_{k_{\\text{输出}}}=F_{k_{\\text{输入}}}\\times H_k$$ —— 逐点相乘')
  yes(hasMath(li), '列表项里的 `$$…$$` → 排成式子（从前整条都是源码）')
  yes(!visible(li).includes('$$'), '列表项里也没有裸的 `$$`')
  yes(li.startsWith('<ul class="bd-rich-ul"><li>'), '★ 式子**留在 `<li>` 里**（说明才跟得住）')
  yes(visible(li).includes('—— 逐点相乘'), '说明还在同一条列表项里')

  const inline = richHtml('一个复指数 $e^{j\\omega_0 t}$ 就代表一个频率')
  yes(hasMath(inline) && !visible(inline).includes('$'), '行内 `$…$` → 行内公式')
}

console.log('\n[3] 排不了的：宁可丑，不可丢')
{
  const half = richHtml('这一句只写了 $$\\frac12 就没了')
  yes(visible(half).includes('$$\\frac12'), '★ 少了半边 `$$` → 原文一个字不少地留在卡上')
  const empty = richHtml('$$$$')
  yes(visible(empty).length > 0, '空式子（`$$$$`）不会把整张卡渲染成空')
  const broken = richHtml('这是 $\\frac{$ 半截式子')
  yes(visible(broken).length > 0, '排不出来的式子 → 原样摆着，不吞')
}

console.log('\n[4] `$` 的转义：写美金不该变成公式')
{
  const money = richHtml('价格 \\$5 和 \\$6，不用 LaTeX 时就别用 $')
  yes(!hasMath(money), '★ `\\$` 不算公式开头（卡上不会冒出半个公式）')
  yes(visible(money).includes('$5') && visible(money).includes('$6'), '★ `$5` / `$6` 一个不少地显示成美金')
}

console.log('\n[5] `**…**` 粗体：提纲卡那几个小标题靠它（doc-summary.js 拼的正文）')
{
  const head = richHtml('**核心式子**')
  yes(head.includes('<strong>核心式子</strong>'), '★ `**小标题**` → 粗体（卡上不显示星号）')
  yes(!visible(head).includes('*'), '★ 那两个星号不出现在卡上')
  /* 段落里夹着粗体（一段人话里强调一个词）也要认 */
  const mid = richHtml('这一步**最关键**：把两边同时除以 $2\\pi$')
  yes(mid.includes('<strong>最关键</strong>'), '句子中间的 `**…**` 也认')
  yes(hasMath(mid), '同一句里的式子照排（粗体没把公式吃掉）')
  /* 列表项里 */
  const li = richHtml('- **必记** 周期信号的频谱是离散的')
  yes(li.includes('<strong>必记</strong>'), '列表项里的 `**…**` 也认')
  /* 只写了一半：不许把星号吞掉 */
  const half = richHtml('这一句只写了 **一半')
  yes(visible(half).includes('**一半'), '★ 只写了一半 → 星号原样留着（不吞）')
}

console.log('\n[6] 一张真卡的整篇（标题 + 段落 + 列表 + 式子）')
{
  const card = [
    '第 33 页 · 讲解',
    '',
    P33,
    '',
    '相位在 $\\omega_0$ 处是 $$\\varphi(j\\omega_0)=-\\arctan(2\\pi)\\approx -81^\\circ$$ 意思是逆时针。',
    '',
    '- 频谱值是密度，不是振幅',
    '- 角频率换 Hz 要除以 $2\\pi$',
  ].join('\n')
  const html = richHtml(card)
  yes(!visible(html).includes('$$'), '整篇渲染完没有裸的 `$$`')
  yes((html.match(/class="katex/g) || []).length >= 4, '式子全排出来了（行内 + 摆开的都算）')
  yes(html.includes('<ul class="bd-rich-ul">'), '重点那两条还是列表')
  yes(visible(html).includes('第 33 页 · 讲解'), '标题那一行还在')
}

console.log('\n[7] 源码扫描：不许再长出"只认整行"的那一支')
{
  const src = readFileSync(new URL('../src/lib/rich.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  /* 这一条是 2026-09-23 那个 bug 的形状：`^\$\$` 只在"整行"时命中，
     句子中间的 `$$…$$` 就漏去行内那一支，被当成两个空公式。 */
  yes(!/\^\$\$/.test(code), '★ rich.js 里没有 `^\\$\\$` 那种"只认整行"的正则（防复发）')
  yes(/function splitDisplay/.test(code), '★ 找配对 `$$` 只有 `splitDisplay` 一处')
  yes((code.match(/splitDisplay/g) || []).length >= 3, '★ 段落和行内两条路都走它（不是各写一份）')
}

console.log('\n' + '─'.repeat(56))
if (fails) {
  console.log(`  ${checks} 项通过，${fails} 项失败`)
  process.exit(1)
} else {
  console.log(`  全部 ${checks} 项通过`)
}
