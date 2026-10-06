/* 「34 张图 → 一页能打印的纸」。
 *
 * ── 用户真正要的是什么（2026-10-05 问出来的）───────────────────────
 * 他的实验报告是**手写在报告纸上**的，图则是打印出来、剪下来、贴上去。
 * 所以要的不是"一张好看的图"，而是：
 *   ① **一次给出全部 34 张**（不是 34 次对话、34 次下载）；
 *   ② **每张一样大、格式一样**（剪下来贴在纸上才齐整）；
 *   ③ **打印出来清楚** —— 黑白激光，线够粗、字够大、不要灰底。
 * 这三条里没有一条是"把图画得漂亮"，全在**排版和打印**上。
 *
 * ── 一份 SVG，两个用处 ──────────────────────────────────────────────
 * ★ `chartSvg()` 生成的那段字符串，**屏幕上的预览和打印页用的是同一份**
 *   （预览把它塞进一个 div，打印把它排进 A4 网格）。
 *   这意味着"你在屏幕上调好的那张"和"打出来的那张"必然是同一个东西 ——
 *   如果各画一遍，就会遇到"屏幕上好好的、打出来错位了"这种最难查的问题。
 *
 * ── 打印尺寸是怎么定的 ──────────────────────────────────────────────
 * A4 竖版 210×297mm，边距留 12mm → 可用 186×273mm。
 * 每格 58mm 宽、3 列，行高按图的比例（420:300）算出来是 41.4mm，加标题约 50mm
 * → 一页 5 行 = 15 张，34 张正好 3 页。
 * ⚠ 图里的字是用 **mm 反过来推**的：SVG 内部字号 13，缩放后约 1.8mm 高 ——
 *   那差不多是打印还能读清的下限。再小（像屏幕截图那种 9px）打出来就是一团灰。
 *   线宽 2 → 约 0.28mm，激光打印不会断。
 *
 * ── 规矩 ────────────────────────────────────────────────────────────
 * ① **纯函数**：图集进、HTML 字符串出，不碰 DOM、不读时间以外的外部状态
 *    （照 export-html.js 那条范式），于是 check-chart 在 node 里就能断言。
 * ② **黑白优先**：不用灰底、不靠颜色区分 —— 实验室那台打印机多半是黑白的。
 */

import { chartGeom, chartGeomAll, chartSeries, chartPlan, legendItems, CHART_BOX, SKETCH, GRID_COLOR } from './chart.js'
import { fmtFit } from './fit.js'
import { esc } from './inline.js'

/**
 * ★ 字体分三种角色（2026-10-05 照样张 PDF 里写的字体名定的）。
 *
 * 量他样张的 span 字体，得到的结论是：
 *   · 刻度数字  = `TimesNewRomanPSMT` 7pt  → **衬线**
 *   · 轴名      = `STIXGeneral-Italic` 9pt（变量）+ `TimesNewRoman` 9pt（单位）
 *   · 图例      = `SimSun` 7.6pt          → **宋体**，不是黑体
 *   · 图名      = `SimHei` 12.5pt（中文）+ `STIXGeneral-Italic` 12.5pt（变量）
 *
 * 之前我所有字都用黑体一种，所以贴出来的图"一眼不像"——
 * 衬线数字和黑体数字在报告纸上差别很明显。
 *
 * ⚠ 变量用斜体是**必须的**：`I − V 关系图` 里那个 I 该是斜的，不斜就像打字打错的。
 */
const FS = {
  tick: 'Times New Roman, Times, serif',
  axisVar: 'Times New Roman, Times, serif',
  legend: 'SimSun, Songti SC, serif',
  title: 'SimHei, Microsoft YaHei, sans-serif',
}

/** A4 竖版减去 12mm 页边，真正能用的那一块（mm）。 */
export const PAGE = { w: 186, h: 273 }

/** 一页能放下几张、每张该多大 —— 见 `pageLayout`。这几个数是"一张图怎么算看得清"。 */
export const FIT = {
  cap: 170, // 图宽的上限：再宽就要顶到纸边了
  minH: 48, // 图高的下限：再矮刻度就挤成一团，贴在报告上也读不出数
  head: 9, // 图名 + 下面那行拟合数字占的高度
  gap: 4, // 两张之间留的空（剪的时候下刀的地方）
}

/**
 * ★ 「这几张图，一页怎么排」—— **先定"要一页放下"，再倒推每张多大**。
 *
 * 为什么是这个方向而不是"每张固定多大"：用户要的是"一次实验的两三四个表格放在
 * **一页**里、上下排，好剪下来贴"。所以页数是**硬要求**，每张的大小是算出来的 ——
 * 两张图就该铺满纸宽（看得最清楚），四张就各自缩小一点，总之不分页。
 *
 * ⚠ 只有超出"每张还看得清"的极限时才分页：把六张挤在一页、每张 32mm 高，
 *   刻度会糊成一团 —— 那种图贴上去也是白贴。
 *
 * @param {number} total 一共几张
 * @returns {{pages:number[], mms:number[]}} 每页几张、每页里每张多宽
 */
export function pageLayout(total, opts = {}) {
  const ph = opts.pageH || PAGE.h
  const cap = opts.cap || FIT.cap
  const minH = opts.minH || FIT.minH
  const head = opts.head || FIT.head
  const gap = opts.gap || FIT.gap
  const aspect = (opts.box || CHART_BOX).h / (opts.box || CHART_BOX).w // 图高 = 图宽 × 这个

  /* 一页最多放几张：试到"每张再分就小于 minH"为止。 */
  let maxPer = 1
  for (let k = 1; k <= 64; k += 1) {
    const hImg = ph / k - head - gap
    if (hImg < minH) break
    maxPer = k
  }

  const n = Math.max(0, Math.floor(total) || 0)
  const pages = []
  for (let left = n; left > 0; left -= maxPer) pages.push(Math.min(maxPer, left))

  /* 每页**各自**算图宽：最后一页只剩两张时那两张就该画大一点，别跟着挤。 */
  const mms = pages.map((k) => {
    const w = (ph / k - head - gap) / aspect
    return Math.round(Math.min(cap, w))
  })
  return { pages, mms, maxPer }
}

/**
 * ★ 一个标记 → 一小段 SVG（空心，黑边白心）。
 *
 * 为什么要三种形状：两条曲线在**黑白**打印出来是一样的黑线，只有形状能分开
 * （见 `chart.js` 的 `MARKS`）。
 * @param {string} mark 'circle' | 'square' | 'triangle'
 * @param {number} cx @param {number} cy @param {number} r 外接圆半径
 */
function markSvg(mark, cx, cy, r, sw) {
  const a = `fill="#fff" stroke="#111" stroke-width="${sw}"`
  if (mark === 'square') {
    return `<rect data-mark="1" x="${(cx - r * 0.88).toFixed(1)}" y="${(cy - r * 0.88).toFixed(1)}" width="${(r * 1.76).toFixed(1)}" height="${(r * 1.76).toFixed(1)}" ${a}/>`
  }
  if (mark === 'triangle') {
    /* 正三角形：顶点朝上，外接圆半径同样是 r，视觉大小和圆一样。 */
    const pts = [
      [cx, cy - r * 1.15],
      [cx + r * 1.0, cy + r * 0.72],
      [cx - r * 1.0, cy + r * 0.72],
    ]
      .map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
      .join('L')
    return `<path data-mark="1" d="M${pts}Z" ${a}/>`
  }
  return `<circle data-mark="1" cx="${cx}" cy="${cy}" r="${r}" ${a}/>`
}

/** 坐标保留一位小数。★ 用**函数声明**而不是 `const` 箭头 ——
 *  `const` 版会 TDZ（定义在下面、调用在上面的 `chartSvg` 里）→ 整页白屏
 *  （MEMORY 里记着这个坑：依赖数组里写后面才定义的 const = TDZ）。 */
function r1(n) {
  return n.toFixed(1)
}

/** 线宽 / 字号保留三位 —— 全仓统一这两个口径。 */
function r3(n) {
  return n.toFixed(3)
}

/**
 * 一张图 → 一段 `<svg>` 字符串（**adapter**，2026-10-06 改）。
 *
 * ★ 这一层**只做落笔**：画什么、画在哪、多粗、多大、字体走哪个角色，
 * 全部是 `chart.js` 的 `chartPlan` 定的（那份排版只有一处实现，见那里的说明）。
 * ⚠⚠ **这里不许再出现任何排版决定。**
 * 以前这个函数和 `server-export.js` 的 `makeChartPdf` 各写了一遍整套排版
 * （网格 / 坐标轴 / 箭头 / 刻度 / 轴名 / 曲线 / 图例，七步一一对应），
 * 于是"改一处忘另一处"= **静默**不同步 —— 而它只在**打印出来**时看得见
 * （屏幕自检全绿）。2026-10-05 那一轮七个静默 bug 里**五个**是这么来的：
 * y 刻度全没画出来、竖排轴名压到刻度上、三角飞出页面、减号变方块、一行字三种字体。
 * ★ **要改排版，去改 `chartPlan`**，改完两侧一起变。
 *
 * @param {object} ch  { name, rows, xLabel, xUnit, yLabel, yUnit, mode, extra? }
 * @param {object} opts box（画布逻辑尺寸，默认 CHART_BOX）、mm（纸上的宽）
 */
export function chartSvg(ch, opts = {}) {
  const box = opts.box || CHART_BOX
  const wmm = opts.mm || FIT.cap
  const hmm = (wmm * box.h) / box.w

  /* ★ 排版只有一份实现（`chart.js` 的 `chartPlan`）—— 这一层只负责落笔。 */
  const plan = chartPlan(ch, { box })
  if (!plan) {
    return `<svg viewBox="0 0 ${box.w} ${box.h}" width="${wmm}mm" height="${hmm}mm"><text x="8" y="20" font-size="14">还没填数据</text></svg>`
  }

  const out = []
  out.push(`<svg viewBox="0 0 ${box.w} ${box.h}" width="${wmm}mm" height="${hmm}mm" xmlns="http://www.w3.org/2000/svg">`)

  /* 逐笔落笔。`data-<tag>` 是给自检用的（数得清"几个点、几根网格、几条坐标轴"）。
     ★ tag 由**排版层**给（`chartPlan`），adapter 原样带上，**不许自己推断
       「这一笔是哪一类」** —— 那是排版决定，猜就是决策漏出接缝。
       （踩过：第一版 adapter 按颜色猜，于是自检数不出坐标轴和刻度，红了 6 条。） */
  for (const s of plan.strokes) {
    const tg = s.tag ? ` data-${s.tag}="1"` : ''
    if (s.k === 'line') {
      const col = s.color === 'grid' ? GRID_COLOR : '#111'
      out.push(`<line${tg} x1="${r1(s.x1)}" y1="${r1(s.y1)}" x2="${r1(s.x2)}" y2="${r1(s.y2)}" stroke="${col}" stroke-width="${r3(s.w)}"/>`)
    } else if (s.k === 'path') {
      out.push(`<path${tg} d="${s.d}" fill="none" stroke="#111" stroke-width="${r3(s.w)}" stroke-linejoin="round"/>`)
    } else if (s.k === 'circle') {
      out.push(`<circle${tg} cx="${r1(s.cx)}" cy="${r1(s.cy)}" r="${r3(s.r)}" fill="${s.fill || '#fff'}" stroke="#111" stroke-width="${r3(s.w)}"/>`)
    } else if (s.k === 'rect') {
      /* ⚠ 白底那一块（`color:'none'`）不描边 —— 样张的图例就是一块白底，没有框线。 */
      const stroke = s.color === 'none' ? 'stroke="none"' : `stroke="#111" stroke-width="${r3(s.w)}"`
      out.push(`<rect${tg} x="${r1(s.x)}" y="${r1(s.y)}" width="${r1(s.hw)}" height="${r1(s.hh)}" fill="${s.fill || 'none'}" ${stroke}/>`)
    } else if (s.k === 'poly') {
      /* 三角标记：逐段线（`chartPlan` 特意这么给，见那里的说明）。 */
      const d = s.pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${r1(p[0])} ${r1(p[1])}`).join('') + (s.close ? 'Z' : '')
      out.push(`<path${tg} d="${d}" fill="none" stroke="#111" stroke-width="${r3(s.w)}" stroke-linejoin="round"/>`)
    } else if (s.k === 'text') {
      out.push(`<text${tg} x="${r1(s.x)}" y="${r1(s.y)}" font-size="${r3(s.size)}" text-anchor="${s.anchor}" fill="#111" font-family="${FS[s.role] || FS.tick}">${esc(s.s)}</text>`)
    } else if (s.k === 'runs') {
      /* 一行多段（轴名）：变量斜体 + 单位正体（样张 `I` 是斜的，`/ mA` 是正的）。
         ⚠ ` / ` 归在**单位那一段**里（`chartPlan` 的 `axisRuns` 就那么拼的）——
           它是分隔符不是文字，单独一段会让判据在两处写法不同。 */
      const inner = s.runs.map((run) => `<tspan font-style="${run.role === 'var' ? 'italic' : 'normal'}">${esc(run.s)}</tspan>`).join('')
      const rot = s.rot ? ` transform="rotate(${s.rot} ${r1(s.x)} ${r1(s.y)})"` : ''
      out.push(`<text${tg} x="${r1(s.x)}" y="${r1(s.y)}" font-size="${r3(s.size)}" text-anchor="${s.anchor}" fill="#111" font-family="${FS.axisVar}"${rot}>${inner}</text>`)
    }
  }

  out.push('</svg>')
  return out.join('')
}

/**
 * 图下面那一行小字：拟合出来的数。这是报告上真正要交的那几个数。
 *
 * ★ 两条以上都选了「拟合」时**每条一行**，前面带上曲线名 ——
 *   少报一条就等于那个实验白做（读者只看到一个斜率，不知道是哪组的）。
 *   只有一条时保持原来那一句（不重复名字），已出的纸不用重打。
 */
export function chartCaption(ch) {
  const ss = chartSeries(ch)
  if (!ss.length) return null
  const g = chartGeomAll(ss)
  if (!g) return null
  const lines = []
  for (const s of g.series) {
    if (s.mode !== 'fit') continue
    if (!s.fit) continue
    const f = fmtFit(s.fit.stats)
    const one = s.name ? `${s.name}　` : ''
    lines.push(`${one}斜率 ${f.slope}　截距 ${f.intercept}　r² ${f.r2}`)
  }
  if (!lines.length) return null
  return lines.join('\n')
}

/**
 * 图名 → HTML（**变量斜体 + 中文黑体**，照样张）。
 *
 * 样张 `I − V 关系图` 是这么排的：`I` 和 `V` 用 STIX 斜体（数学惯例，
 * 表示变量），`−` 正体，中文「关系图」黑体。写成一句话就是：
 * ★ **斜体是给变量（单个拉丁字母）的，中文和单位一律正体**。
 *
 * @param {string} name 图名，如 `两种充电情况下的 P − t 曲线`
 */
function capHtml(name) {
  const s = String(name == null ? '' : name)
  /* 变量 = 夹在中文/数字之间的**单个**拉丁字母（I、V、P、t）。
     ⚠ 只认单个字母：`DC-DC`、`P−V` 里连着的两个字母不算变量（那是量名）。 */
  const html = esc(s).replace(/([A-Za-z])(?![A-Za-z])/g, '<i>$1</i>')
  return `<div class="cap">${html || '未命名'}</div>`
}

/* 一张图在图集里排成"图名 + 图 + 那几个数"那一块。
   ★ 图名在图的**上方** —— 这是照着样张定的（2026-10-05）：他给的 PDF 里
     标题在距纸顶 38mm、最高那条刻度在 43mm —— 名字在图上面，不是下面。
     我们原来放在下面，是错的。 */
function cellHtml(ch, opts) {
  return (
    `<div class="cell">` +
    capHtml(ch.name) +
    `<div class="pic">${chartSvg(ch, opts)}</div>` +
    (chartCaption(ch) ? `<div class="num">${esc(chartCaption(ch))}</div>` : '') +
    `</div>`
  )
}

/**
 * 一整个图集 → 一份完整的打印页 HTML。
 *
 * @param {Array<object>} charts
 * @param {object} opts  title（页眉）/ cols（每行列数）/ rows（每页行数）/ mm（每张图宽）
 *   autoPrint  要不要"打开就弹打印框"（默认 true —— 那个按钮的意思就是"出纸"）。
 *              自检和**预览**传 false：它们要看的是 HTML 长什么样，不是要一张纸。
 * @returns {string} 一个完整的 HTML 文档（含 `@page` 和打印脚本）
 */
export function chartPrintHtml(charts, opts = {}) {
  const list = (Array.isArray(charts) ? charts : []).filter(Boolean)
  const title = opts.title || '实验图'
  /* ★ 上下排（单列），不是横着铺 —— 他要的是"剪下来贴"，一列下去一刀就剪开了。
     每张多大由 `pageLayout` 从"一页要放下几张"倒推出来。 */
  const layout = pageLayout(list.length, opts)

  let at = 0
  const pages = layout.pages.map((k, pi) => {
    const pg = list.slice(at, at + k)
    at += k
    const mm = layout.mms[pi]
    return (
      `<section class="pg${pi === layout.pages.length - 1 ? ' last' : ''}">` +
      `<div class="grid" style="grid-template-columns:${mm}mm">` +
      pg.map((ch) => cellHtml(ch, { mm })).join('') +
      `</div>` +
      `<div class="foot">${esc(title)}　第 ${pi + 1}/${layout.pages.length} 页</div>` +
      `</section>`
    )
  })
  if (!pages.length) pages.push(`<section class="pg last"><div class="grid" style="grid-template-columns:170mm"></div></section>`)

  const printJs =
    opts.autoPrint === false
      ? ''
      : `<script>
  /* 打开就弹打印框：他要的是"点一下就该出纸"，不是"先看看再找打印菜单"。
     ⚠ 用 onload 而不是立刻执行 —— SVG 里的字体得先量好，不然第一页会错版。 */
  window.addEventListener('load', function () {
    setTimeout(function () { try { window.print() } catch (e) {} }, 220)
  })
</script>`

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111;
    font-family: "Times New Roman", Times, SimSun, serif; }
  .pg { page-break-after: always; }
  .pg.last { page-break-after: auto; }
  /* 单列、居中：上下排，剪的时候一刀下去。 */
  .grid { display: grid; gap: ${FIT.gap}mm; justify-content: center; align-content: start; }
  .cell { break-inside: avoid; text-align: center; }
  .pic { line-height: 0; }
  /* 图名在图的**上方**（照他的样张）；字号 12.5pt —— 样张 PDF 里量到的就是 12.5。 */
  .cap { font-size: 12.5pt; margin: 0 0 1.6mm; font-family: SimHei, "Microsoft YaHei", sans-serif; }
  .cap i { font-family: "Times New Roman", Times, serif; }
  /* pre-line：两条以上都拟合时 chartCaption 用换行分开，CSS 不认这个换行就挤成一行。 */
  .num { font-size: 8pt; color: #444; margin-top: 0.6mm; font-family: "Times New Roman", Times, serif; white-space: pre-line; }
  .foot { font-size: 8pt; color: #888; text-align: center; margin-top: 4mm; }
  @media screen { .pg { border-bottom: 1px solid #ddd; padding-bottom: 4mm; margin-bottom: 4mm; } }
</style></head><body>
${pages.join('')}
${printJs}
</body></html>`
}
