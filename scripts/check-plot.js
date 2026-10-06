/* check-plot：给式子画图（`src/lib/plot.js`）的断言。
 *
 * ── 这个文件要盯的三件事 ────────────────────────────────────────────
 * ① **不许画出不存在的线。** 这是画图这条路上唯一会"悄悄骗人"的地方：
 *    `1/x` 在 x=0 处没有值，`tan(x)` 隔 π 就没有值 —— 把这些断点直接连起来，
 *    图上会出现一道贯穿全图的竖线，而那条线不是任何函数的图像。
 *    学生对着它读出来的数是假的。所以 ① 是全文件最硬的一条。
 * ② **自动选的区间要真的能画**：`sqrt(x)` 必须自己避开负半轴，
 *    `log(x)` 必须避开 x≤0，`f = 1/sqrt(LC)` 里的 L 也一样。
 *    这条要是坏了，"看一眼"这个动作就变成"先去设置坐标轴"，功能等于没了。
 * ③ **水平线不能压成 0 高**（除零会算出 NaN，整张图消失）。
 *
 * 用法：node scripts/check-plot.js
 */
import { readFormula } from '../src/lib/calc.js'
import {
  autoRange,
  sampleCurve,
  polylines,
  plotView,
  lineToPath,
  defaultPlotSym,
  nearestPoint,
  fmtTick,
  PLOT_BOX,
  STEPS,
} from '../src/lib/plot.js'

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
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 1e-6)

/** 式子 → 一幅图的全部数据。画不出来就把原因带回来。 */
function curve(src, values = {}, range) {
  const r = readFormula(src)
  if (!r.ok) return { ok: false, why: r.why }
  const sym = defaultPlotSym(r.vars, values)
  if (!sym) return { ok: false, why: '这条式子没有可变的量' }
  /* ⚠ 手填的区间要包成和 autoRange 一样的形状 —— 统一在这里补 `ok`，
     省得每条断言自己记得。 */
  const rg = range ? { ok: true, from: range.from, to: range.to } : autoRange(r.node, sym, values)
  if (!rg.ok) return rg
  const s = sampleCurve(r.node, sym, rg.from, rg.to, values)
  const p = polylines(s.xs, s.ys)
  if (!p.ok) return p
  return { ok: true, sym, from: rg.from, to: rg.to, sample: s, plot: p, auto: !range }
}
const at = (src, x, values) => {
  const r = readFormula(src)
  return r.ok ? r.node : null
}

console.log('')
console.log('  check-plot · 给式子画图')
console.log('  ' + '─'.repeat(46))

/* ── 一、横轴挑谁 ── */
console.log('\n  一、横轴挑谁')
{
  yes(defaultPlotSym(['m', 'a'], { a: 9.8 }) === 'm', '先挑还没值的那个（F=ma 里 a 填了就画 m）')
  yes(defaultPlotSym(['w', 't'], {}) === 'w', '都没填就挑第一个')
  yes(defaultPlotSym([], {}) === null, '没有量就返回 null（界面据此不显示画图那一段）')
  yes(defaultPlotSym(['m', 'a'], { m: '', a: 2 }) === 'm', '空字符串也算"还没填"')
}

/* ── 二、自动区间：挑"算得出来的最长那一段" ── */
console.log('\n  二、自动区间')
{
  const c = curve('sqrt(x)')
  yes(c.ok && near(c.from, 0) && near(c.to, 10), `sqrt(x) 自己避开负半轴：[${c.ok ? c.from + ', ' + c.to : c.why}]`)
}
{
  const c = curve('ln(x)')
  yes(c.ok && c.from > 0 && c.from < 0.2 && near(c.to, 10), `ln(x) 从正数开始：[${c.ok ? c.from + ', ' + c.to : c.why}]`)
}
{
  const c = curve('log(x)')
  yes(c.ok && c.from > 0, `log 是 lg、同样避开 x≤0：[${c.ok ? c.from + ', ' + c.to : c.why}]`)
}
{
  /* 谐振频率：L 不能为负也不会为 0（分母上）。 */
  const c = curve('1/(2*pi*sqrt(L*C))', { C: 1e-6 })
  yes(c.ok && c.from > 0 && c.sym === 'L', `1/(2π√(LC)) 挑 L 当横轴且避开 0：[${c.ok ? c.from + ', ' + c.to : c.why}]`)
}
{
  const c = curve('x^2')
  yes(c.ok && near(c.from, -10) && near(c.to, 10), '整条都算得出来就用默认那一段 [-10, 10]')
}
{
  const c = curve('sin(w t)', { w: 2 })
  yes(c.ok && c.sym === 't', 'sin(wt) 里 w 有值、横轴是 t')
}
{
  const r = readFormula('5')
  const sym = defaultPlotSym(r.vars, {})
  yes(sym === null && !autoRange(r.node, sym, {}).ok, '没有变量的式子画不出来（有守卫，不会去找 sym=null）')
}

/* ── 三、采样 ── */
console.log('\n  三、采样')
{
  const r = readFormula('sin(x)')
  const s = sampleCurve(r.node, 'x', 0, Math.PI * 2, {}, 200)
  yes(s.ok && s.xs.length === 201, `扫 200 段得到 201 个点（实际 ${s.ok ? s.xs.length : '-'}）`)
  yes(s.ok && near(s.ys[0], 0, 1e-12), 'sin(0) = 0')
  yes(s.ok && near(s.ys[50], 1, 1e-12), 'sin(π/2) = 1')
  yes(s.ok && near(s.ys[150], -1, 1e-12), 'sin(3π/2) = -1')
}
{
  const r = readFormula('x')
  yes(!sampleCurve(r.node, 'x', 3, 3, {}).ok, '一头一尾同一个数 → 报错，不画')
  yes(!sampleCurve(r.node, 'x', 'abc', 5, {}).ok, '区间给的不是数 → 报错')
}
{
  /* 缺值要说人话，而不是悄悄画一条全空的线。 */
  const r = readFormula('F = m a')
  const s = sampleCurve(r.node, 'm', 0, 1, {}, 4)
  yes(s.ok && s.missing === 5 && /a/.test(s.why || ''), `另一个量没给值时指名道姓：${s.ok ? s.why : '-'}`)
}

/* ── ★ 四、不许画出不存在的线（全文件最硬的一条）── */
console.log('\n  四、断点必须断开')
{
  const c = curve('1/x', {}, { from: -10, to: 10 })
  yes(c.ok, '1/x 在 [-10,10] 上没崩')
  if (c.ok) {
    let cross = 0
    for (const ln of c.plot.lines) {
      for (let i = 1; i < ln.length; i += 1) {
        if (ln[i - 1].x < 0 && ln[i].x > 0) cross += 1
      }
    }
    yes(cross === 0, `1/x 没有线段跨过 x=0（实测 ${cross} 条，必须是 0）`)
  }
}
{
  const c = curve('tan(x)', {}, { from: -10, to: 10 })
  yes(c.ok && c.plot.lines.length >= 5, `tan(x) 被切成 ${c.ok ? c.plot.lines.length : '-'} 段（[-10,10] 上有 6 个极点）`)
  if (c.ok) {
    let maxAbs = 0
    for (const ln of c.plot.lines) for (const p of ln) maxAbs = Math.max(maxAbs, Math.abs(p.y))
    yes(maxAbs < 100, `奇点旁边那些飞出去的值被切掉了（剩下的最大 |y| = ${maxAbs.toFixed(1)}）`)
    const jumpy = c.plot.cuts > 0
    yes(jumpy, `cuts = ${c.plot.cuts}（>0 说明真的因为"跳得太狠"断过）`)
  }
}
{
  const c = curve('sqrt(x)', {}, { from: -10, to: 10 })
  /* 321 个点里 x<0 的那 160 个没值（x=0 本身是有值的）。 */
  yes(c.ok && c.plot.missing === 160, `sqrt(x) 手填 [-10,10]：${c.ok ? c.plot.missing : '-'} 个点没值`)
  if (c.ok) {
    const minX = Math.min(...c.plot.lines.map((l) => l[0].x))
    yes(minX >= 0, `负半轴全被丢干净了（最小 x = ${minX}）`)
  }
}
{
  const c = curve('sqrt(x)', {}, { from: -10, to: -1 })
  yes(!c.ok, `整段都算不出来时老老实实报错（${c.ok ? '居然画出来了' : c.plot ? c.plot.why : c.why}）`)
}
{
  /* 正常式子不许被误伤切成好几段。 */
  for (const src of ['sin(x)', 'x^2', 'sqrt(x)', 'ln(x)', 'exp(-x^2)']) {
    const c = curve(src)
    yes(c.ok && c.plot.lines.length === 1 && c.plot.cuts === 0, `${src} 是一条完整的线（没被误切）`)
  }
}

/* ── 五、纵轴范围 ── */
console.log('\n  五、纵轴范围')
{
  const c = curve('5')
  /* 没有变量 → curve() 返回 false，这里只验 polylines 那一层：水平线不能是 0 高。 */
  const r = readFormula('5*(x/x)')
  const s = sampleCurve(r.node, 'x', 1, 5, {}, 8)
  const p = polylines(s.xs, s.ys)
  yes(p.ok && p.yr[1] > p.yr[0], `一条水平线也要有上下留白（yr = ${p.ok ? p.yr.map((n) => n.toFixed(2)).join(', ') : '-'}）`)
}
{
  const c = curve('sin(x)')
  yes(c.ok && c.plot.yr[0] < -1 && c.plot.yr[1] > 1, 'sin 的纵轴把 ±1 完整包住了（上下各留了一点点）')
}
{
  const c = curve('1/x', {}, { from: -10, to: 10 })
  const values = c.ok ? c.plot.lines.flat().map((p) => p.y) : []
  yes(values.every(Number.isFinite), '留下的点里没有 NaN / Infinity')
}

/* ── 六、数 → 像素 ── */
console.log('\n  六、数 → 像素')
{
  const v = plotView([0, 10], [0, 1])
  const w = PLOT_BOX.w - PLOT_BOX.l - PLOT_BOX.r
  const h = PLOT_BOX.h - PLOT_BOX.t - PLOT_BOX.b
  yes(near(v.px(0), PLOT_BOX.l), 'x 的下界落在图的左边缘')
  yes(near(v.px(10), PLOT_BOX.l + w), 'x 的上界落在图的右边缘')
  yes(near(v.px(5), PLOT_BOX.l + w / 2), '中间那个 x 落在正中间')
  /* ★ y 是反的：图上的"上"是数大的一头。这条反了曲线会上下颠倒。 */
  yes(near(v.py(0), PLOT_BOX.t + h), 'y 的下界落在图的**底边**')
  yes(near(v.py(1), PLOT_BOX.t), 'y 的上界落在图的**顶边**')
  yes(near(v.ux(v.px(7)), 7) && near(v.uy(v.py(0.25)), 0.25), 'px/py 反过来算得回原数（鼠标读值靠它）')
}
{
  const c = curve('x^2')
  const v = plotView([c.from, c.to], c.plot.yr)
  const d = lineToPath(c.plot.lines[0], v)
  yes(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/.test(d), `path 的形状合法（M 起笔、后面 L 连线，共 ${c.plot.lines[0].length} 个点）`)
  yes(!/NaN|Infinity/.test(d), 'path 里没有 NaN（否则整个 SVG 静默消失）')
}

/* ── 七、刻度上的数字 ── */
console.log('\n  七、刻度数量印刷厂')
{
  yes(fmtTick(0) === '0', '0 印成 0')
  yes(fmtTick(12345).length <= 7, `12345 印得短：${fmtTick(12345)}`)
  yes(/e23/.test(fmtTick(6.022e23)), `阿伏伽德罗常数走科学计数法：${fmtTick(6.022e23)}`)
  yes(/e-19/.test(fmtTick(1.6e-19)), `元电荷同理：${fmtTick(1.6e-19)}`)
  yes(fmtTick(9.80665).length <= 7, `小数压到三位有效数字：${fmtTick(9.80665)}`)
}

/* ── 八、鼠标读值 ── */
console.log('\n  八、鼠标读值')
{
  const c = curve('x^2')
  const p = nearestPoint(c.plot.lines, 3)
  yes(p !== null && Math.abs(p.x - 3) < 0.05 && near(p.y, 9, 0.4), `x=3 处读到 y ≈ ${p ? p.y.toFixed(2) : '-'}（x² 该是 9）`)
  const far = nearestPoint(c.plot.lines, 9999)
  yes(far !== null && far.x === c.to, '鼠标拉到区间外就读端点（不会读到 undefined）')
}

console.log('')
if (fails) {
  console.log(`  ${fails} 项失败 / 共 ${checks} 条断言`)
  process.exitCode = 1
} else {
  console.log(`  全部通过（${checks} 条断言）`)
}
