/* check-chart：实验图那条线（数据 → 图 → 打印）的断言。
 *
 * ── 这个文件要盯的四件事 ────────────────────────────────────────────
 * ① **拟合的数要对**：斜率、截距、R²、不确定度 —— 用一组**已知答案**的数据钉住
 *    （y = 2x + 1 加一点噪声，斜率必须回到 2 附近）。这几个数会印在图上交给老师，
 *    错了比没有更糟。
 * ② **不许给假数**：两个点、x 全一样、数据里夹了 NaN —— 一律拒绝（规矩①）。
 *    两个点连出来的线 R² 恒为 1，看着"完美贴合"，其实什么都没说明。
 * ③ **拟合线不外推**：它必须只画在测量区间里。外推那段没有测量支持，
 *    贴在报告上就是一句假话。
 * ④ **打印页的排版是对的**：34 张 → 3 页、每页 15 格、每格都有图和图名，
 *    而且**每张图的 SVG 是真的有内容**（不是空壳）。
 *
 * 用法：node scripts/check-chart.js
 */
import { linearFit, fmtFit } from '../src/lib/fit.js'
import { parseTable, chartExtent, niceStep, axisTicks, chartGeom, chartGeomAll, chartSeries, markFor, legendItems, legendSpot, minorTicks, snapToStep, CHART_BOX, SKETCH } from '../src/lib/chart.js'
import { chartSvg, chartPrintHtml, chartCaption, pageLayout, FIT, PAGE } from '../src/lib/chart-print.js'

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
const near = (a, b, tol) => Math.abs(a - b) <= tol

console.log('')
console.log('  check-chart · 实验图（数据 → 图 → 打印）')
console.log('  ' + '─'.repeat(46))

/* ── 一、读数据 ── */
console.log('\n  一、把粘贴进来的一坨字读成数据')
{
  const r = parseTable('1 2\n2 4\n3 6')
  yes(r.ok && r.rows.length === 3 && r.rows[1][1] === 4, '空格分隔：一行一组')
}
{
  const r = parseTable('1,2\n2,4\n3,6')
  yes(r.ok && r.rows.length === 3, '逗号分隔也认')
}
{
  /* 从 Excel 复制出来是制表符，而且常常带表头。 */
  const r = parseTable('U/V\tI/mA\n1.0\t2.0\n2.0\t4.0\n3.0\t6.0')
  yes(r.ok && r.rows.length === 3 && /表头/.test(r.note || ''), `带表头：读进 3 组，并且明说了「${r.ok ? r.note : '-'}」`)
}
{
  /* 三列且首列是 1..n：认它是序号。⚠ 这条判得很窄（必须严格 1 到 n），
     而且它会写在 note 里 —— 跳错了看得见。 */
  const r = parseTable('1\t1.0\t2.0\n2\t2.0\t4.0\n3\t3.0\t6.0')
  yes(r.ok && r.rows[0][0] === 1.0 && r.rows[0][1] === 2.0, `首列是序号就跳过（${r.ok ? r.note : '-'}）`)
}
{
  yes(!parseTable('1 2\n这不是数据\n3 6').ok, '数据中间夹了不明不白的一行 → 整段退回，不悄悄跳过')
  yes(!parseTable('').ok, '空的 → 报错')
  yes(!parseTable('只有一行字').ok, '压根不是数据 → 报错（不画一个空图）')
}

/* ── 二、拟合的数 ── */
console.log('\n  二、拟合出来的数')
{
  /* y = 2x + 1，加一点噪声。手算可得 slope ≈ 1.99、intercept ≈ 1.02。 */
  const pts = [
    [1, 3.1],
    [2, 4.9],
    [3, 7.2],
    [4, 8.8],
    [5, 11.1],
    [6, 13.0],
  ]
  const f = linearFit(pts)
  yes(f.ok && near(f.slope, 2, 0.06), `斜率 ≈ 2（实测 ${f.ok ? f.slope.toFixed(4) : '-'}）`)
  yes(f.ok && near(f.intercept, 1, 0.35), `截距 ≈ 1（实测 ${f.ok ? f.intercept.toFixed(4) : '-'}）`)
  yes(f.ok && f.r2 > 0.99, `r² 很高（${f.ok ? f.r2.toFixed(5) : '-'}）`)
  yes(f.ok && f.slopeSE > 0 && f.slopeSE < 0.3, `斜率的不确定度是个合理的小数（${f.ok ? f.slopeSE.toFixed(4) : '-'}）`)
  /* 完全贴合的数据：不确定度必须是 0（不是 NaN，也不是"看着很精确"的假小数）。 */
  const perfect = linearFit([[1, 3], [2, 5], [3, 7], [4, 9]])
  yes(perfect.ok && perfect.slopeSE === 0 && near(perfect.r2, 1, 1e-12), '完美贴合时 u=0、r²=1（不是 NaN）')
}
{
  /* ★ 拒绝的那几种 —— 每一条都是"给了就是假数" */
  const two = linearFit([[1, 2], [2, 4]])
  yes(!two.ok, `两点不给拟合：${two.ok ? '它居然给了' : two.why}`)
  const flat = linearFit([[3, 1], [3, 2], [3, 3]])
  yes(!flat.ok, `x 全一样不给：${flat.ok ? '它居然给了' : flat.why}`)
  const nan = linearFit([[1, 2], [2, NaN], [3, 4]])
  yes(!nan.ok, `数据里有 NaN 不给：${nan.ok ? '它居然给了' : nan.why}`)
}
{
  /* 报告上那一行字的写法：中心值要和不确定度**对齐到同一位小数**。 */
  const f = linearFit([[1, 2.05], [2, 4.02], [3, 5.98], [4, 8.01]])
  const s = fmtFit(f)
  const [a, da] = s.slope.split('±').map((t) => t.trim())
  const da1 = a.split('.')[1] || ''
  const da2 = da.split('.')[1] || ''
  yes(da1.length === da2.length, `小数位对齐：${s.slope}（左边 ${da1.length} 位、右边 ${da2.length} 位）`)
  yes(/^r²/.test('r²') && s.r2.length <= 6, `r² 印得短：${s.r2}`)
}

/* ── 三、刻度与几何 ── */
console.log('\n  三、轴与刻度')
{
  yes(niceStep(10, 5) === 2, '跨度 10 分 5 格 → 步长 2')
  yes(niceStep(1, 5) === 0.2, '跨度 1 分 5 格 → 步长 0.2')
  yes(niceStep(230, 5) === 50, '跨度 230 → 步长 50（只取 1/2/5×10ⁿ）')
  const t = axisTicks(0, 10)
  yes(t.ticks.length >= 5 && t.ticks.every((x) => Math.abs(x.v / t.step - Math.round(x.v / t.step)) < 1e-9), `刻度都落在步长上（${t.ticks.map((x) => x.text).join(' ')}）`)
  yes(!t.ticks.some((x) => /\d\.\d{5,}/.test(x.text)), '刻度上的数字没有 0.30000000000004 这种脏尾巴')
}
{
  const ext = chartExtent([[1, 2], [3, 4]])
  yes(ext.xr[0] < 1 && ext.xr[1] > 3, '轴两头留了空（点不贴边框）')
  const same = chartExtent([[5, 5], [5, 5]])
  yes(same.yr[1] > same.yr[0], '所有点都一样时纵轴也不能是 0 高（否则除零、整图消失）')
}
{
  /* ★ 轴范围要吸附到**整刻度**上（2026-10-05 照样张量的）。
     样张图①：数据 x 1…12 → xlim 恰好 [0,12]；数据 y 43…76 → ylim 恰好 [40,80]。
     不吸附的话最左那根刻度线落在绘图区外面，图左边空一道白。 */
  yes(snapToStep([0.34, 12.66], 2)[0] === 0, '范围 0.34…12.66 吸附到步长 2 → 下端 0')
  yes(snapToStep([43, 76], 10)[0] === 40 && snapToStep([43, 76], 10)[1] === 80, '范围 43…76 吸附到步长 10 → [40, 80]（和样张量出来的一致）')
  yes(snapToStep([43, 76], 10)[0] <= 43, '吸附只往外不往里（点不能骑在轴线上）')
  /* 次刻度 = 半格，且不与主刻度重合（否则同一根线画两遍） */
  const mn = minorTicks(0, 12, 2)
  yes(mn.length === 6 && mn.join(',') === '1,3,5,7,9,11', `步长 2 的次刻度是半格（${mn.join(' ')}）`)
  yes(!mn.some((v) => v % 2 === 0), '次刻度不含主刻度的位置（0/2/4… 不重复出现）')
}

/* ── ★ 四、拟合线不许外推 ── */
console.log('\n  四、拟合线不许外推')
{
  const rows = [
    [1, 3.05],
    [2, 4.95],
    [3, 7.1],
    [4, 8.9],
    [5, 11.05],
  ]
  const g = chartGeom(rows, { mode: 'fit' })
  yes(!!g && !!g.fit, '拟合做出来了')
  if (g && g.fit) {
    /* path 是 `M x1 y1 L x2 y2`：两端的 x 必须正好是测量区间的最小/最大。 */
    const m = /^M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)$/.exec(g.fit.path)
    yes(!!m, `拟合线的形状合法：${g.fit.path.slice(0, 40)}`)
    if (m) {
      const xa = g.view.ux(Number(m[1]))
      const xb = g.view.ux(Number(m[3]))
      yes(near(xa, 1, 0.02) && near(xb, 5, 0.02), `线只画在测量区间里：[${xa.toFixed(2)}, ${xb.toFixed(2)}]，不是整个轴 [${g.xr[0].toFixed(2)}, ${g.xr[1].toFixed(2)}]`)
    }
  }
}
{
  /* 连线不排序：磁滞回线那种"回头"的数据，顺序就是图形的一部分。 */
  const loop = [
    [0, 0],
    [1, 1],
    [2, 0.5],
    [1, -1],
    [0, -0.5],
  ]
  const g = chartGeom(loop, { mode: 'line' })
  const line = chartGeom([...loop].sort((a, b) => a[0] - b[0]), { mode: 'line' })
  yes(g.linePath !== line.linePath, '按给的顺序连，不按 x 重排（磁滞回线不能重排）')
}

/* ── 五、SVG 与打印页 ── */
console.log('\n  五、SVG 与打印页')
{
  const ch = { name: '伏安特性', rows: [[1, 3], [2, 4.9], [3, 7.2], [4, 8.8]], xLabel: 'U', xUnit: 'V', yLabel: 'I', yUnit: 'mA', mode: 'fit' }
  const svg = chartSvg(ch)
  yes(svg.startsWith('<svg') && svg.includes('</svg>'), '生成的是一段完整的 SVG')
  yes(!/NaN|undefined/.test(svg), 'SVG 里没有 NaN（否则整块静默消失）')
  /* ⚠ 数 `data-dot` 而不是 `<circle>` —— 图例里也有一个圈，混着数就永远差一个。 */
  yes((svg.match(/data-dot/g) || []).length === 4, `4 个点就是 4 个圈（实测 ${(svg.match(/data-dot/g) || []).length}）`)
  /* ⚠ 轴名现在是「变量斜体 + 单位正体」两段 tspan（照样张：样张里那个 `I`
     是 STIX 斜体、`/ mA` 是正体 Times），所以**不能**再找连续的 `U / V` ——
     标签中间隔着 `</tspan><tspan>`。分开断言，别为了迁就断言把排版改回去。
     ⚠⚠ 2026-10-06：` / ` 归在**单位那一段里**（` / V`），不再是单独一段。
       排版搬进 `chartPlan` 之后第一版把它单独包了一个 tspan，于是这两条立刻红了
       —— 那是写法变了、意思没变，所以改断言（`chartPlan` 的 `axisRuns` 那里有注）。 */
  yes(svg.includes('<tspan font-style="italic">U</tspan><tspan font-style="normal"> / V</tspan>'), 'x 轴名 = 变量 U（斜体）+ / + 单位 V（正体）')
  yes(svg.includes('<tspan font-style="italic">I</tspan><tspan font-style="normal"> / mA</tspan>'), 'y 轴名 = 变量 I（斜体）+ 单位 mA（正体）')
  yes(/font-style="italic"/.test(svg), '轴名里的变量是斜体（样张就是斜的）')
  yes(svg.includes('mm"'), '尺寸是 mm，不是 px —— 打印才准')
  const cap = chartCaption(ch)
  yes(!!cap && /斜率/.test(cap) && /r²/.test(cap), `图下面带了那几个数：${cap}`)
}
{
  const ch = { name: '空图', rows: [], mode: 'dots' }
  yes(chartSvg(ch).includes('还没填数据'), '没数据的图给一句明白话，不是一块空白')
}
/* ── ★ 五之二、样张里那几样「以前根本没有」的东西（2026-10-05）──
   这几条是照着他那份《多功能太阳能电池特性》PDF 量出来补上的：
   淡灰网格、坐标轴末端箭头、主/次刻度、图例不压曲线。 */
{
  const ch = { name: 'a', rows: [[1, 3], [2, 4.9], [3, 7.2], [4, 8.8], [5, 10.5]], xLabel: 'x', yLabel: 'y', mode: 'line' }
  const svg = chartSvg(ch)
  /* 淡灰网格：样张是 rgb(0.851,0.851,0.851) = #d9d9d9 */
  yes(svg.includes('#d9d9d9'), '网格是极淡的灰 #d9d9d9（样张量到的色，黑白打印机上才不抢眼）')
  yes((svg.match(/data-grid="1"/g) || []).length > 8, `网格线横竖都有（${(svg.match(/data-grid="1"/g) || []).length} 条）`)
  /* 坐标轴末端箭头：样张 y 轴顶端一个向上的、x 轴右端一个向右的 */
  yes((svg.match(/data-arrow="1"/g) || []).length === 4, '两条坐标轴末端都有箭头（样张：y 向上、x 向右）')
  /* 次刻度线：样张主刻度 3.7pt、次刻度 1.85pt（正好一半），朝外。
     ⚠ 别用正则去数属性顺序 —— SVG 属性顺序一变正则就假红。直接问几何函数。 */
  const gg = chartGeom([[1, 3], [2, 4.9], [3, 7.2], [4, 8.8], [5, 10.5]], { mode: 'line' })
  yes(gg.xt.minor.length >= 2 && gg.yt.minor.length >= 2, `两个轴都有次刻度（x ${gg.xt.minor.length} 根、y ${gg.yt.minor.length} 根）`)
  yes(
    gg.yt.minor.every((v) => {
      const k = v / (gg.yt.step / 2)
      return Math.abs(k - Math.round(k)) < 1e-9
    }),
    '次刻度正好落在半格上（样张：网格线画在每个半格）',
  )
  /* 主刻度长、次刻度短 —— 样张量到 3.7pt vs 1.85pt。 */
  yes(SKETCH.tickMinor * 2 === SKETCH.tickMajor || Math.abs(SKETCH.tickMinor * 2 - SKETCH.tickMajor) < 1e-9, '次刻度线长是主刻度的一半（样张 1.85 vs 3.7pt）')
  yes((svg.match(/data-grid="1"/g) || []).length > 8, `网格线横竖都有（${(svg.match(/data-grid="1"/g) || []).length} 条）`)
  /* 坐标轴只有两条线，没有上下右边框（样张就是两条） */
  yes((svg.match(/data-axis="1"/g) || []).length === 2, '坐标轴只有左、下两条（样张没有上边框和右边框）')
  /* 衬线字：样张刻度数字是 Times */
  yes(/font-family="Times New Roman/.test(svg), '刻度数字用衬线（样张是 Times New Roman，不是黑体）')
}
{
  /* ★ 图例不许压住曲线 —— 用户原话「图例画里面没问题，只要不覆盖」。 */
  const area = { x: CHART_BOX.l, y: CHART_BOX.t, w: CHART_BOX.w - CHART_BOX.l - CHART_BOX.r, h: CHART_BOX.h - CHART_BOX.t - CHART_BOX.b }
  const lb = { w: 120, h: 44 }
  const hits = (g, c) => g.dots.filter((d) => d.px >= c.x && d.px <= c.x + lb.w && d.py >= c.y && d.py <= c.y + lb.h).length
  /* 上升曲线 → 数据压在**左边**，右边空着 → 图例该去右上。 */
  const up = chartGeom([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]], { mode: 'line' })
  const atUp = legendSpot(up.dots, lb, area)
  yes(hits(up, atUp) === 0, `上升曲线 → 图例去了不压数据的那一角（${atUp.k}）`)
  /* 下降曲线 → 数据压在**右上**，图例必须躲开（改之前这里正好盖住峰值）。 */
  const dn = chartGeom([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]], { mode: 'line' })
  const atDn = legendSpot(dn.dots, lb, area)
  yes(hits(dn, atDn) === 0, `下降曲线 → 图例躲开右上（落到 ${atDn.k}，压住 ${hits(dn, atDn)} 个点）`)
  /* 四个角里挑最空的那个 —— 同一个角不能既是最优又压着数据。 */
  const cands = ['tl', 'tr', 'bl', 'br'].map((k) => ({ k, n: hits(dn, { x: k[1] === 'l' ? area.x : area.x + area.w - lb.w, y: k[0] === 't' ? area.y : area.y + area.h - lb.h }) }))
  yes(atDn.n === undefined || hits(dn, atDn) <= Math.min(...cands.map((c) => c.n)), `挑的是压点最少的角（四角分别压 ${cands.map((c) => c.n).join('/')} 个点）`)
}
/* ── ★ 五之二、一页怎么排（他点名要"一次实验的两三四个、一页、上下排"）── */
{
  const L2 = pageLayout(2)
  yes(L2.pages.length === 1 && L2.mms[0] === FIT.cap, `2 张 → 1 页，而且铺满纸宽（${L2.mms[0]}mm）`)
  const L4 = pageLayout(4)
  yes(L4.pages.length === 1 && L4.mms[0] < FIT.cap, `4 张 → 仍是一页（每张缩到 ${L4.mms[0]}mm）—— 这是他要的`)
  const L34 = pageLayout(34)
  yes(L34.pages.length === Math.ceil(34 / L34.maxPer), `34 张 → ${L34.pages.length} 页（每页 ${L34.maxPer} 张）`)
  /* 每张的高度必须还看得清（贴上去读不出数的图等于没贴）。 */
  const aspect = CHART_BOX.h / CHART_BOX.w
  const worst = Math.min(...L34.mms.map((w) => w * aspect))
  yes(worst >= FIT.minH, `每张图高 ${worst.toFixed(0)}mm，没低于可读下限 ${FIT.minH}mm`)
  /* 页高不许溢出：一页放 k 张，总高必须装得进 A4。 */
  let over = 0
  L34.pages.forEach((k, i) => {
    const h = k * (L34.mms[i] * aspect + FIT.head + FIT.gap)
    if (h > PAGE.h + 1) over += 1
  })
  yes(over === 0, '每一页的高度都没超出 A4（不会印出第二张空白纸）')
  /* 最后一页只剩两张时，那两张要画大一点 —— 别跟着前面的挤。 */
  const L6 = pageLayout(6)
  yes(L6.mms[L6.mms.length - 1] > L6.mms[0], `最后一页只剩 ${L6.pages[L6.pages.length - 1]} 张，图反而更大（${L6.mms[L6.mms.length - 1]}mm > ${L6.mms[0]}mm）`)
}
{
  const charts = []
  for (let i = 0; i < 4; i += 1) {
    charts.push({ name: `图 ${i + 1}`, rows: [[1, 2], [2, 4.1], [3, 5.9], [4, 8.2]], xLabel: 'x', yLabel: 'y', mode: 'fit' })
  }
  const html = chartPrintHtml(charts, { title: '声速测量' })
  yes((html.match(/class="pg/g) || []).length === 1, '一次实验的 4 张 → 一页（他要的就是一页）')
  yes((html.match(/class="cell"/g) || []).length === 4, '4 张一张都不少')
  yes((html.match(/<svg/g) || []).length === 4, '每张都有自己的 SVG')
  yes(html.includes('A4 portrait'), '页面尺寸钉死 A4 竖版')
  yes(html.includes('window.print'), '打开就弹打印框（他要的是"点一下就出纸"）')
  yes(/第 1\/1 页/.test(html), '页脚写着第几页')
  /* ★ 图名在图的**上方** —— 照着他的样张（标题 38mm、最高刻度 43mm）。 */
  const capAt = html.indexOf('class="cap"')
  const svgAt = html.indexOf('<svg')
  yes(capAt > 0 && svgAt > capAt, '图名在图的上面（不是下面 —— 原来是错的）')
  /* ★ 图例：他那张样张每张图上都有图例（这一组是拟合，所以是"拟合直线"）。 */
  yes(html.includes('实测数据点') && html.includes('拟合直线'), '拟合模式的图例写「实测数据点 / 拟合直线」')
  const lineHtml = chartPrintHtml([{ name: 'a', rows: [[1, 1], [2, 2], [3, 3]], mode: 'line' }])
  yes(lineHtml.includes('逐点连线'), '连线模式的图例写「逐点连线」—— 和他样张上一模一样的字样')
  const dotHtml = chartPrintHtml([{ name: 'a', rows: [[1, 1], [2, 2], [3, 3]], mode: 'dots' }])
  yes(!dotHtml.includes('逐点连线'), '只画点的时候不写"逐点连线"（没连就别那么说）')
  /* 上下排 = 只有一列。三列那种横着铺的他剪不动。 */
  const cols = (html.match(/grid-template-columns:(\d+)mm/g) || []).map((s) => s.replace(/\D/g, ''))
  yes(cols.every((c) => Number(c) > 60), `单列排（每列 ${cols[0]}mm 宽），不是横着铺三列`)
  /* 打印机上多半是黑白的：不许靠颜色区分，也不许有灰底（灰底打出来糊成一片）。
     ⚠ 别写成"没有 #f 开头的颜色" —— #fff（纯白）正好被它误判成浅灰。 */
  const bgs = [...html.matchAll(/background:\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => m[1].toLowerCase())
  yes(
    bgs.length > 0 && bgs.every((c) => c === '#fff' || c === '#ffffff'),
    `底色全是纯白（实测 ${[...new Set(bgs)].join(' ') || '没有'}）`,
  )
}
{
  /* 图名里带尖括号也不能把 HTML 打坏。 */
  const html = chartPrintHtml([{ name: '<script>x</script>', rows: [[1, 1], [2, 2], [3, 3]], mode: 'dots' }])
  yes(!html.includes('<script>x</script>'), '图名里的尖括号被转义了（不会打出一个能执行的标签）')
}

/* ══════════════ 一张图画几条曲线（2026-10-05 加）══════════════
   起因：他那张 `两种充电情况下的 P − t 曲线` 上有**两条**曲线
   （直接充电 / 加 DC-DC），之前一张图只能画一条，那种对比图画不出来。 */
{
  const one = { name: 'a', mode: 'line', rows: [[1, 1], [2, 2], [3, 3]] }

  /* ① 老文件没有 `extra` 时，行为和以前**完全一样**（这是 34 份已存图的保证）。 */
  const ss1 = chartSeries(one)
  yes(ss1.length === 1 && ss1[0].mark === 'circle' && ss1[0].mode === 'line', '没有 extra 的老图 = 一条曲线、圆标记、画法照旧')
  yes(legendItems(one).length === 2, '一条曲线时图例还是那两行（实测数据点 / 逐点连线）')

  /* ② 两份数据合成一张图。 */
  const two = {
    name: '两种充电情况下的 P − t 曲线',
    mode: 'line',
    s0name: '直接充电',
    rows: [[0, 120], [1, 400], [2, 600], [3, 700]],
    extra: [{ name: '加 DC-DC 转换', mode: 'line', mark: 'square', rows: [[0, 110], [1, 330], [2, 450], [3, 500]] }],
  }
  const ss2 = chartSeries(two)
  yes(ss2.length === 2, '两条曲线都在（`extra` 那条没被丢掉）')
  yes(ss2[0].name === '直接充电' && ss2[1].name === '加 DC-DC 转换', '两条都带着自己的名字（图例要写它）')
  yes(ss2[0].mark === 'circle' && ss2[1].mark === 'square', '标记形状按条数分派，不重样')

  /* ③ ★ 轴范围必须**合起来**算 —— 这是多系列最容易做错的一处。
     两条曲线量程差很多时，各画各的轴会长得一模一样，"谁高谁低"就看不出来了。 */
  const g2 = chartGeomAll(ss2)
  const allY = ss2.flatMap((s) => s.rows.map((r) => r[1]))
  yes(g2.yr[0] <= Math.min(...allY) && g2.yr[1] >= Math.max(...allY), `轴范围罩住了**所有**曲线的点（y 轴 ${g2.yr.join('..')}，数据 ${Math.min(...allY)}..${Math.max(...allY)}）`)
  const onlySecond = chartGeomAll([ss2[1]])
  yes(onlySecond.yr[1] < g2.yr[1], '只画第二条的话轴会更窄 —— 说明合算是真的在合算，不是碰巧一样')
  /* 所有点都必须落在框内（吸附之后也不能有点骑到边框上）。 */
  const out = g2.series.flatMap((s) => s.dots).filter((d) => d.px < g2.box.l - 0.01 || d.px > g2.box.l + g2.iw + 0.01 || d.py < g2.box.t - 0.01 || d.py > g2.box.t + g2.ih + 0.01)
  yes(out.length === 0, `两条曲线的点都落在框内（跑出去 ${out.length} 个）`)

  /* ④ 图例：两条以上时每条一行（写名字），不再写"实测数据点/逐点连线"。 */
  const lg = legendItems(two)
  yes(lg.length === 2 && lg[0].text === '直接充电' && lg[1].text === '加 DC-DC 转换', '图例每条曲线一行，写的都是名字')
  yes(lg[0].kind === 'series' && lg[0].mark === 'circle' && lg[1].mark === 'square', '图例那行带自己的标记形状（和图上那套一致）')
  /* 有任何一条是拟合，就补一行「拟合直线」—— 直线和折线一眼分得开，
     但"这条实线是拟合出来的"读者未必猜得到。 */
  const mixFit = { ...two, mode: 'fit', extra: [{ ...two.extra[0], mode: 'fit' }] }
  const lf = legendItems(mixFit)
  yes(lf.some((i) => i.text === '拟合直线'), '有曲线选了拟合 → 图例补一行「拟合直线」')
  yes(lf.length === 3, `两条都拟合时图例是 3 行（实测 ${lf.length} 行）`)

  /* ⑤ SVG：两条线两套标记都画出来了。 */
  const svg2 = chartSvg(two)
  yes((svg2.match(/data-series="1"/g) || []).length >= 2, '两条曲线的线都画出来了')
  yes(svg2.includes('<circle data-dot="1"') && svg2.includes('<rect data-dot="1"'), '圆点和方点都画出来了（黑白打印靠形状区分）')
  yes(svg2.includes('直接充电') && svg2.includes('加 DC-DC 转换'), '图例里写着两条曲线的名字')
  /* 一条曲线时**不许**出现方块/三角（别把标记形状漏成默认值）。 */
  const svg1 = chartSvg(one)
  yes(!svg1.includes('<rect data-dot="1"') && !svg1.includes('data-mark="1"'), '一条曲线时只有圆点，没有别的形状混进来')

  /* ⑥ 拟合数字：两条都拟合时每条一行，且**带上名字**（少报一条那个实验就白做了）。 */
  const cap2 = chartCaption(mixFit)
  yes(cap2 && cap2.split('\n').length === 2, `两条都拟合 → 下面报两行（实测 ${cap2 ? cap2.split('\n').length : 0} 行）`)
  yes(cap2 && cap2.includes('直接充电') && cap2.includes('斜率'), '拟合那几行带曲线名 + 斜率')
  yes(chartCaption(one) === null, '没选拟合时不报那几行')

  /* ⑦ 每条曲线的画法各自独立（第一张连线、第二张拟合 是常见组合）。 */
  const mixed = chartSeries({ ...two, mode: 'line', extra: [{ ...two.extra[0], mode: 'fit' }] })
  yes(mixed[0].mode === 'line' && mixed[1].mode === 'fit', '每条曲线的画法各自独立（一条连线、一条拟合）')
  const gm = chartGeomAll(mixed)
  yes(!!gm.series[0].linePath, '连线那条有线')
  yes(!!gm.series[1].fit, '拟合那条出了斜率')
  /* 拟合线不外推：两端就是它自己那组的测量区间。 */
  const xs1 = mixed[1].rows.map((r) => r[0])
  yes(gm.series[1].fit.x0 === Math.min(...xs1) && gm.series[1].fit.x1 === Math.max(...xs1), '拟合线只画在测量区间里（不外推）')

  /* ⑧ ★ 图例避让要判**所有**曲线的点 —— 只判第一条，图例会正好盖住第二条。
     这份数据是特意造的：第一条从左上到右上再落到左下（它自己占上边 + 左下），
     第二条**只在左下**。于是"只判第一条"会挑左下（那里它自己没有点），
     而那里正是第二条 —— 图例盖上去，第二条曲线整段被遮住。
     实测：只判 → 压第二条 1 个点；判全部 → 换到右上，压 0 个。 */
  const twoTop = {
    name: 'x',
    mode: 'line',
    rows: [[1, 9], [2, 9.5], [3, 1]],
    extra: [{ name: 'y', mode: 'line', rows: [[1, 1.2], [2, 1.4], [3, 1.6]] }],
  }
  const gTop = chartGeomAll(chartSeries(twoTop))
  const area2 = { x: gTop.box.l, y: gTop.box.t, w: gTop.iw, h: gTop.ih }
  const lb2 = { w: 120, h: 60 }
  const at2 = legendSpot(gTop.series.map((s) => s.dots), lb2, area2)
  const hitAll = (c) => gTop.series.flatMap((s) => s.dots).filter((d) => d.px >= c.x - 4 && d.px <= c.x + lb2.w + 4 && d.py >= c.y - 4 && d.py <= c.y + lb2.h + 4).length
  yes(hitAll(at2) === 0, `两条一起判 → 图例不压任何曲线（压住 ${hitAll(at2)} 个点，选了${at2.k}）`)
  /* 反证：只判第一条就会挑错角、压住第二条。这条是让上面那条有牙的前提。 */
  const atOnlyFirst = legendSpot(gTop.series[0].dots, lb2, area2)
  const hitSecondOnly = gTop.series[1].dots.filter((d) => d.px >= atOnlyFirst.x - 4 && d.px <= atOnlyFirst.x + lb2.w + 4 && d.py >= atOnlyFirst.y - 4 && d.py <= atOnlyFirst.y + lb2.h + 4).length
  yes(hitSecondOnly > 0, `只判第一条就会压住第二条（压 ${hitSecondOnly} 个，选了${atOnlyFirst.k}）—— 所以必须判全部`)

  /* ⑨ 第三条：标记自动往后排，不和前两条重样。 */
  const three = chartSeries({
    ...two,
    extra: [...two.extra, { name: '第三条', mode: 'line', rows: [[0, 100], [1, 300], [2, 400]] }],
  })
  const ms = three.map((s) => s.mark)
  yes(ms.length === 3 && new Set(ms).size === 3, `三条曲线的标记互不重复（${ms.join(' ')}）`)
  yes(markFor(0) === 'circle' && markFor(1) === 'square' && markFor(2) === 'triangle', '标记按 圆→方→三角 排（黑白打印的老办法）')
  /* 没写 mark 时自动补一个，不该两个都是圆。 */
  const auto = chartSeries({ ...two, extra: [{ name: '没写形状', mode: 'line', rows: [[1, 1], [2, 2]] }] })
  yes(auto[0].mark !== auto[1].mark, '没写标记的那条会自动补一个，不和第一条撞形状')

  /* ⑩ 空的那条不算数（有 extra 但里面没数据 → 还是一条曲线）。 */
  const withEmpty = chartSeries({ ...two, extra: [two.extra[0], { name: '空的', mode: 'line', text: '', rows: [] }] })
  yes(withEmpty.length === 2, 'extra 里没数据的那条不进图（否则图例会多一行空名字）')
  yes(chartSeries({ name: '全空', mode: 'line', text: '', rows: [] }).length === 0, '一张都没填 → 没有曲线（界面提示还没填数据）')
}

console.log('')
if (fails) {
  console.log(`  ${fails} 项失败 / 共 ${checks} 条断言`)
  process.exitCode = 1
} else {
  console.log(`  全部通过（${checks} 条断言）`)
}
