/* check-calc：让式子能算（`src/lib/calc.js`）的断言。
 *
 * ── 这个文件最想盯的三件事 ────────────────────────────────────────────
 * ① **隐式乘法**：手写 `F = ma` 是 F = m·a。这一层要是坏了，症状最阴 ——
 *    不是报错，是"算出来的数不对"。所以 `ma` / `2pi` / `(a+b)c` 各钉一条。
 * ② **`log` 是 lg**：课本和信号那几门课里 log 就是 log10。这条改坏了，
 *    学生对着差 2.3 倍的数怀疑人生。
 * ③ **除法含糊要报警**：`mu0 I / 2 pi r` 严格算是 ((μ₀I)/2)·π·r，
 *    而人想的是 μ₀I/(2πr)。这条回路BC保险公司I赔死者:I 赔付をゼロにする —
 *    它不报错（两种写法里有一种本来就是对的），但必须给提醒。
 *
 * 还有一类**反过来**的断言同样重要：`readFormula` 该拒绝的那些
 * （中文、`∫`、`×`、多个等号、未知函数 `f(x)`、括号不配对）——
 * 规矩是"宁可说算不了，不许算错"，所以"拒绝了"在这里是一条绿，不是红。
 *
 * 用法：node scripts/check-calc.js
 */
import { readFormula, evalFormula, varsOf, slashWarn, CONSTS, formatValue } from '../src/lib/calc.js'

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

/** 算一条式子 → 数字；算不了就把 why 带出来。 */
function num(src, values) {
  const r = readFormula(src)
  if (!r.ok) return { v: null, why: r.why }
  const e = evalFormula(r.node, values)
  return e.ok ? { v: e.value, why: null } : { v: null, why: e.why }
}
/** 浮点比较：相对误差够近就行（56 位浮点那点毛刺不算错）。 */
const near = (a, b) => a !== null && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9)
const eq = (src, want, label, values) => {
  const got = num(src, values)
  yes(near(got.v, want), `${label}：算出来 ${got.v}${near(got.v, want) ? '' : `（该是 ${want}${got.why ? '，它说：' + got.why : ''}）`}`)
}

console.log('')
console.log('  check-calc · 让式子能算')
console.log('  ' + '─'.repeat(46))

/* ── 一、四则与优先级 ── */
eq('2+3*4', 14, '先乘除后加减')
eq('(2+3)*4', 20, '括号优先')
eq('10-2-3', 5, '减法左结合（10-2-3 不是 10-(2-3)）')
eq('12/2/3', 2, '除法左结合')
eq('7%3', 1, '取余')

/* ── 二、幂：两个最容易错的约定 ── */
eq('2^3^2', 512, '幂右结合（2^3^2 = 2^9，不是 64）')
eq('-2^2', -4, '负号在幂外面（-2² 是 -4，不是 4）')
eq('(-2)^2', 4, '加了括号就是 (-2)²')
eq('2^-2', 0.25, '负指数')

/* ── 三、隐式乘法（手写式子的命根子）── */
eq('ma', 6, '两个字母挨着 = 相乘', { m: 2, a: 3 })
eq('2pi', Math.PI * 2, '数字贴变量名', {})
eq('(a+b)c', 20, '括号后面贴变量', { a: 2, b: 3, c: 4 })
eq('2(x+1)', 8, '数字后面贴括号', { x: 3 })
eq('(a+b)(c+d)', 21, '两个括号贴一起', { a: 1, b: 2, c: 3, d: 4 })
{
  const r = readFormula('ma')
  yes(r.ok && r.vars.join(',') === 'm,a', `隐式乘法拆出来的变量按出现顺序：${r.ok ? r.vars.join(',') : r.why}`)
}
{
  const r = readFormula('a+a')
  yes(r.ok && r.vars.length === 1, `同一个变量只列一次（去重）：${r.ok ? r.vars.join(',') : r.why}`)
}

/* ── 四、函数 ── */
eq('sqrt(x^2+y^2)', 5, '勾股数', { x: 3, y: 4 })
eq('sqrt(16)', 4, '开方')
eq('sin(pi/2)', 1, 'sin 与 pi')
eq('log(100)', 2, '★ log 是 lg（不是 ln）')
eq('log10(100)', 2, 'log10 同义')
eq('ln(e)', 1, 'ln 与自然常数')
eq('abs(-3)', 3, '绝对值')
eq('exp(0)', 1, 'exp')
{
  const r = readFormula('sin x')
  yes(!r.ok && /sin\(x\)/.test(r.why), `★ sin x 不许猜成 sin*x，还得说清该怎么改：「${r.ok ? '居然算过去了' : r.why}」`)
}
{
  /* `f(x)`：f 不是已知函数 ⇒ 按"变量 f 乘以后面那一坨"理解（摩擦力就叫 f，`f(θ)` 常常是 f·θ）。
     这一条钉的是"别自作主张把它当成函数调用去猜"。 */
  const r = readFormula('f(x)')
  yes(r.ok && r.vars.join(',') === 'f,x', `未知名字 + 括号 = 隐式乘法：vars=${r.ok ? r.vars.join(',') : r.why}`)
  eq('f(x)', 6, 'f(x) 当成 f·x', { f: 2, x: 3 })
}

/* ── 五、等式：等号左边是"要求谁" ── */
{
  const r = readFormula('F = ma')
  yes(r.ok && r.target === 'F', `F = ma 求的是 F：${r.ok ? r.target : r.why}`)
  yes(r.ok && r.vars.join(',') === 'm,a', '等号左边的量不进"要给值的清单"')
  eq('F = ma', 6, 'F = ma 代值', { m: 2, a: 3 })
}
{
  const r = readFormula('a+b = c')
  yes(!r.ok, `连等/左边不是单个量 → 不许算：${r.ok ? '居然算过去了' : r.why}`)
}
{
  const r = readFormula('a = b = c')
  yes(!r.ok, `多个等号不许算：${r.ok ? '居然算过去了' : r.why}`)
}

/* ── 六、常量 ── */
{
  yes(Math.abs(CONSTS.mu0 - 4 * Math.PI * 1e-7) < 1e-15, 'mu0 = 4π×10⁻⁷')
  eq('mu0 I / (2 pi r)', (CONSTS.mu0 * 2) / (2 * Math.PI * 0.1), '长直导线的磁场 B = mu0 I/(2 pi r)', { I: 2, r: 0.1 })
  const override = num('mu0', { mu0: 1 })
  yes(near(override.v, 1), '用户可以覆盖常量（mu0 给的是 1 就用 1）')
  yes(CONSTS.c === undefined && CONSTS.h === undefined && CONSTS.g === undefined, '★ 单字母 c / h / g 一律不内置（会和学生自己的变量撞）')
  yes(CONSTS.c0 === 299792458 && CONSTS.g0 > 9.8, '物理常数用多名店写法：c0 / g0')
}

/* ── 七、科学计数法 ── */
eq('2e-3', 0.002, '2e-3 是一个数（不是 2*e-3）')
eq('1.6e-19 * 2', 3.2e-19, '科学计数法参与运算')
eq('1e5', 100000, '1e5')

/* ── 八、除法含糊必须报警 ── */
{
  const r = readFormula('mu0 I / 2 pi r')
  yes(r.ok && r.warn === true, `★ mu0 I / 2 pi r 要提醒"给分母加括号"（危险形）：warn=${r.ok ? r.warn : r.why}`)
}
{
  const r = readFormula('mu0 I / (2 pi r)')
  yes(r.ok && r.warn === false, '加了括号就不报警')
}
{
  const r = readFormula('a*b/c')
  yes(r.ok && r.warn === false, '显式星号不报警（人家说清楚了）')
}
{
  const r = readFormula('2 pi r / 3')
  /* ((2·π·r)/3)：乘全在除的**左边**，优先级从左到右刚好等于人想的那种 —— 不报警。 */
  yes(r.ok && r.warn === false, '2 pi r / 3 不报警（乘法都落在除号左边，没有歧义）')
}
{
  const r = readFormula('(a/b)c')
  yes(slashWarn(r.node) === true, 'slashWarn 直接可用：(a/b)c 报警')
}

/* ── 九、该拒绝的那些（拒绝 = 绿）── */
const REJECT = [
  ['积分符号', '∫ x dx', '∫'],
  ['中文', '质量乘加速度', '中文'],
  ['乘号点', '2 · 3', '·'],
  ['空式子', '', '空'],
  ['只有等号', '=', '等号'],
  ['括号没合上', '(a+b', '括号'],
  ['多一个右括号', 'a+b)', '括号'],
  ['等号右边空', 'F =', '等号'],
  ['运算符孤零零', '* 3', '位置'],
  ['除以零得 NaN 的形状', 'sqrt(-1)', 'NaN|有限'],
]
for (const [label, src, want] of REJECT) {
  const r = readFormula(src)
  const e = r.ok ? evalFormula(r.node, {}) : null
  const rejected = !r.ok || (e && !e.ok)
  const why = r.ok ? e && e.why : r.why
  yes(rejected && String(why || '').length > 0, `${label}不许蒙，要报出人话：「${why}」`)
}
{
  const r = readFormula('1/0')
  yes(r.ok, '1/0 是 Infinity 不是错（数学上它有意义）')
  const e = evalFormula(r.node, {})
  yes(!e.ok, '但结果不是有限数 → 报出来，不给 Infinity')
}
{
  const r = readFormula('m a')
  const e = evalFormula(r.node, { m: 2 })
  yes(!e.ok && /a/.test(e.why), `缺值要指名道姓说缺谁：「${e.ok ? '' : e.why}」`)
}
{
  /* ⚠ **空字符串不是 0**：`Number('')` 等于 0 —— 要是走了这条路，
     "那个框还没填"会变成"那个量是 0"，结果照样算出来（而且不是 0），
     学生以为自己填了。这条钉的就是这个坑。 */
  const r = readFormula('F = ma')
  const e = evalFormula(r.node, { m: '', a: '' })
  yes(!e.ok && /m/.test(e.why), `空输入框 = 没给值（不许当成 0）：「${e.ok ? '它算出 ' + e.value : e.why}」`)
  const e2 = evalFormula(r.node, { m: 2, a: ' ' })
  yes(!e2.ok, '只填了一个也要说清楚缺谁')
  yes(evalFormula(r.node, { m: 'abc', a: 1 }).ok === false, '填了非数字要报错')
}

/* ── 十、结果的写法 ── */
{
  yes(formatValue(3.141592653589793) === '3.141592654' || /^3\.14/.test(formatValue(Math.PI)), `π 摆成能看的样子：${formatValue(Math.PI)}`)
  yes(formatValue(1.054571817e-34).includes('×10'), `普朗克常数不能打成 0.000000：${formatValue(1.054571817e-34)}`)
  yes(formatValue(6.02214076e23).includes('×10'), `阿伏伽德罗常数同样：${formatValue(6.02214076e23)}`)
  yes(formatValue(0) === '0', '零就写零')
  yes(formatValue(-2) === '-2', '负数带符号')
  yes(!formatValue(1 / 3).includes('e'), `1/3 不用科学计数法：${formatValue(1 / 3)}`)
}

/* ── 十一、从他板上抄下来的真家伙 ── */
{
  /* 电路板 / 大物实验里最常出现的那几个形状 */
  eq('m*g0*h', 19.6133, '重力势能（g0 是内置的重力加速度）', { m: 2, h: 1 })
  eq('(1/2)*m*v^2', 25, '动能', { m: 2, v: 5 })
  eq('q/(4*pi*eps0*r^2)', (CONSTS.qe / (4 * Math.PI * CONSTS.eps0 * 0.01)), '点电荷电场', { q: CONSTS.qe, r: 0.1 })
  eq('1/(2*pi*sqrt(L*C))', 1 / (2 * Math.PI * Math.sqrt(1e-3 * 1e-6)), 'LC 振荡频率', { L: 1e-3, C: 1e-6 })
  const hw = readFormula('1/(2*pi*sqrt(L*C))')
  yes(hw.ok && hw.warn === false, '这些真式子都不该报警（括号写全了）')
}

/* ── 十二、幂等 / 稳定性：同一条式子连算两次一模一样 ── */
{
  const a = num('sqrt(x^2+y^2)', { x: 3, y: 4 }).v
  const b = num('sqrt(x^2+y^2)', { x: 3, y: 4 }).v
  yes(a === b, '同一条式子连算两次一模一样（没有缓存、没有副作用）')
  const r1 = readFormula('F = ma')
  const r2 = readFormula('F = ma')
  yes(JSON.stringify(r1.vars) === JSON.stringify(r2.vars), '变量清单也稳定')
}

console.log('')
if (fails) {
  console.log(`  ${fails} 项失败 / 共 ${checks} 项`)
  console.log('')
  process.exitCode = 1
} else {
  console.log(`  全部通过（${checks} 项）`)
  console.log('')
}
