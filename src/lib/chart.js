/* 「一串测量点 → 一张图」的几何。
 *
 * ── 它和 plot.js 的分工 ──────────────────────────────────────────────
 * plot.js 画的是**式子**（`x^2` 那种：给一个 x 就有一个 y，随便采样）；
 * 这里画的是**数据**（测了多少点就是多少点，点之外一概不画）。
 * 两者共用 `plotView` 那个坐标变换 —— 于是"屏幕上的预览"和"打印出来的那张"
 * 是**同一套几何**，只是画布尺寸不同。这条很重要：不然你调好的图打出来是另一个样子。
 *
 * ── 三条硬规矩（和 calc / fit / plot 同一套脾气）─────────────────────
 * ① **点之外不画**。拟合线**不外推**（只在测量区间里画），空白就留着空白。
 *    外推出来的那段线没有任何测量支持，贴在报告上就是一句假话。
 * ② **不猜数据**。粘贴进来的东西解析不出就报"第几行不像数"，
 *    绝不悄悄跳过一行继续画 —— 少一个点的图看着照样合理，而它已经错了。
 * ③ **纯函数、零依赖**（只 import plot/fit）：node 里直接断言得住（check-chart）。
 *
 * ── 一条容易做错的细节：连线**不排序** ──────────────────────────────
 * 磁滞回线、冷却曲线、李萨如图这些，点的顺序本身就是图形的一部分；
 * 按 x 排一遍，回线会变成一条往复的折线，图形整个变了。
 * 所以按**你给的顺序**连。（plot.js 那边不需要关心这个 —— 它是按 x 采样的。）
 */

import { plotView } from './plot.js'
import { linearFit } from './fit.js'

/**
 * 预览用的一块画布（打印页会用另一块尺寸和单位，但几何同一套）。
 *
 * ★ **每一个数都是从他的样张 PDF 里量出来的**（2026-10-05，`pymupdf` 读矢量坐标，
 *   不是眼估）。样张 A4 上三张图，逐项量：
 *
 *   样张绘图区 **330×112pt**（116.4×39.5mm）。左边距 34.8pt 拆两块：
 *   ```
 *   |<----------- 左边距 34.8pt ---------->|
 *   |<- y轴名 20.6pt ->|<-刻度数字 14.2pt ->|
 *   ```
 *   换算到本文件的绘图区宽 **282**（系数 282/330 = 0.855）：
 *
 *   | 位置     | 样张              | 本文件 |
 *   |----------|-------------------|--------|
 *   | 绘图区宽 | 330pt             | 272    |
 *   | 绘图区高 | 112pt（比例 .339）| 92     |
 *   | 左边距   | 34.8pt → 30        | **40**（见下）|
 *   | 下边距   | 26.5pt 到轴名基线 + 字高 | **30** |
 *   | 上边距   | 图名在图外（打印页单独一行）| 16 |
 *
 *   → 绘图区宽高比 **2.96:1**（272:92），对上样张 330:112 = 2.95。
 *   ⚠ 左边距我算错过三次（116 → 70 → 30 → 40）：照着系数换算得 30，
 *     可那是按**两位数**刻度算的 —— `800` 那种三位数一挡就把 y 轴名挤到刻度上。
 *     现在按最坏情况留足：`刻度数字宽 + 主刻度线 + 间隙 + 轴名字号`。
 *     **判据：y 轴名中心必须在刻度数字区左边**（`yNameAt` 的注释里写着）。
 *
 *   → 绘图区宽高比 **2.94:1**（我第一版拍的 2:1 是错的）。
 *   ⚠ 左边距我**写过两遍错的**：116（照着"标签列"直觉，样张的两倍多）、
 *     然后 70（还是宽）。对着上面那把尺子量才对 —— **30**。
 *
 * ⚠ 改这个会连带改 `pageLayout` 算出的每张尺寸、打印页、PDF 全都会跟着变 ——
 *   它们都从这一个宽高比推出来（这一处就是那个"唯一实现"）。
 */
export const CHART_BOX = { w: 320, h: 140, l: 40, r: 8, t: 16, b: 30 }

/**
 * 图例上该写哪几行。
 *
 * ★ 为什么这几句话值得写进代码：他的每张图上都有这两行。别人看这份报告时要能一眼
 *   分清"圈是量出来的、线是连出来的"，而不是猜。
 *
 * ── 一条曲线时（`ss.length === 1`）照他的写法 ──
 *   `实测数据点` / `逐点连线`（或 `拟合直线`）。
 *
 * ── 两条以上时改成「每条一行」──
 *   2026-10-05 他指出他那张 `两种充电情况下的 P − t 曲线` 上有**两条**曲线
 *   （直接充电 / 加 DC-DC）。那时候一张图只能画一条，那种对比图根本画不出来。
 *   两条以上时"实测数据点"这行就不够用了 —— 读者要知道的不是"这是点还是线"，
 *   而是**哪条是哪条**，所以每条曲线占一行，前面画它自己的标记形状。
 *   ⚠ 只要有任意一条是拟合，就补一行「拟合直线」—— 直线和折线在图上一眼能分，
 *     而"这条实线是拟合出来的"这件事读者未必猜得到。
 *
 * @param {object} ch 一张图（`chartSeries` 认得出 `extra` 就行）
 * @returns {Array<{kind:'dot'|'line'|'series', mark?:string, text:string}>}
 */
export function legendItems(ch) {
  const ss = chartSeries(ch)
  if (!ss.length) return []
  if (ss.length === 1) {
    const mode = ss[0].mode
    if (mode === 'fit') {
      return [
        { kind: 'dot', text: '实测数据点' },
        { kind: 'line', text: '拟合直线' },
      ]
    }
    if (mode === 'line') {
      return [
        { kind: 'dot', text: '实测数据点' },
        { kind: 'line', text: '逐点连线' },
      ]
    }
    return [{ kind: 'dot', text: '实测数据点' }]
  }
  const out = ss.map((s) => ({ kind: 'series', mark: s.mark, text: s.name || '（没起名）' }))
  if (ss.some((s) => s.mode === 'fit')) out.push({ kind: 'line', text: '拟合直线' })
  return out
}

/**
 * ★ 标记形状 —— 区分两条曲线靠它，**不靠颜色**。
 *
 * 为什么不靠颜色：他那台打印机是黑白的（`chart-print.js` 开头那条"黑白优先"），
 * 而且报告是手写的，图要剪下来贴 —— 打印出来两条线一样黑就分不出来了。
 * 空心圆 / 空心方 / 空心三角 是论文插图里区分序列的老办法，剪下来也认得出。
 */
export const MARKS = ['circle', 'square', 'triangle']

/** 第 n 条曲线默认用第 n 种标记（n 从 0 起，循环）。 */
export function markFor(n) {
  return MARKS[((n % MARKS.length) + MARKS.length) % MARKS.length]
}

/**
 * ★ 一张图 → 若干条曲线（**系列**）。
 *
 * ⚠⚠ 数据形状的关键约定：**第一条永远是图自己的 `rows`/`mode`**，
 *   第 2 条起才进 `ch.extra`。这样：
 *   · 已经存盘的那 34 份图**一个字节都不用改**就能打开（它们没有 `extra`）；
 *   · 只有一条曲线时，存的就是现在这些字段（`text` / `rows` / `mode`）——
 *     界面上"一个数据框"的老用法一点没变；
 *   · **不存在两份真相**：加第二条时不会把第一条的数据搬个地方，两边永远不漂。
 *
 * @param {object} ch { rows, mode, s0name?, s0mark?, extra?:Array }
 * @returns {Array<{name:string, rows:Array, mode:string, mark:string}>}
 */
export function chartSeries(ch) {
  const out = []
  if (ch && (ch.rows || []).length) {
    out.push({
      name: ch.s0name || '',
      rows: ch.rows,
      mode: ch.mode || 'dots',
      mark: ch.s0mark || MARKS[0],
      main: true,
    })
  }
  const ex = (ch && ch.extra) || []
  for (let i = 0; i < ex.length; i += 1) {
    const s = ex[i]
    if (!s || !(s.rows || []).length) continue
    out.push({ name: s.name || '', rows: s.rows, mode: s.mode || 'line', mark: s.mark || markFor(out.length), main: false })
  }
  return out
}

// ─────────────────── 一、把粘贴进来的一坨字读成数据 ───────────────────

/**
 * 一段粘贴过来的文字 → 数字对。
 *
 * 认的形状：每行一组，两个数之间用**空格 / 制表符 / 逗号 / 分号**隔开
 * （从 Excel 直接复制过来是制表符，从别处抄来多半是空格，随便哪种都行）。
 * 认得 `1.2` `-3` `1.2e-3` 这种写法。
 *
 * ⚠ 表头那一行（`U/V  I/mA`）**不是数据**，但也不该报成错 —— 悄悄跳掉，
 *   并在 `note` 里说一句（界面上会显示，看得见）。
 *
 * ★ 首列是序号那件事（Excel 三列：序号 / x / y）做一次判断：
 *   所有行都是 3 列、而且第一列正好是 1..n 递增 → 认它是序号，跳掉。
 *   ⚠ 这条是"宁可不做也不做错"的反面特例吗？不是 —— 判据很窄（必须严格 1..n），
 *   而且它会**写在 note 里让你看见**（发现它跳错了，你一眼就看得出来）。
 *
 * @returns {{ok:true, rows:Array<[number,number]>, skipped:number, note:string|null}
 *          |{ok:false, why:string}}
 */
export function parseTable(text) {
  const s = String(text == null ? '' : text)
  const lines = s.split(/\r?\n/)
  const raw = []
  let skipped = 0
  let header = null
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i].trim()
    if (!ln) continue
    const toks = ln.split(/[\s,;，；]+/).filter(Boolean)
    if (toks.length < 2) {
      /* 一行里凑不出两个数。和上面那种"不是数"一视同仁：
         已经读过数据了还冒出这么一行，就是不明不白 —— 退回，不跳过。 */
      if (raw.length > 0) return { ok: false, why: `第 ${i + 1} 行「${ln.slice(0, 20)}」只有 ${toks.length} 个数（每组要两个数）` }
      header = i + 1
      skipped += 1
      continue
    }
    const nums = toks.map((t) => Number(t.replace(/[，,]/g, '')))
    if (nums.some((n) => !Number.isFinite(n))) {
      /* 不是数的一行，要看它出现在哪儿：
         · **一个数据行都还没读到** → 那多半是表头（`U/V  I/mA`），跳掉、记一句 note；
         · **已经读到数据了** → 这是夹在中间的不明不白的一行，规矩②：整段退回、报在第几行。
           悄悄跳过的后果是"少了一个点的图"，而那个图看起来完全正常。 */
      if (raw.length === 0) {
        header = i + 1
        continue
      }
      return { ok: false, why: `第 ${i + 1} 行「${ln.slice(0, 20)}」不是两个数（把它删掉再试）` }
    }
    raw.push(nums)
  }
  if (!raw.length) return { ok: false, why: '还没填数据（一行一组，两个数用空格或逗号隔开）' }

  const cols = Math.max(...raw.map((r) => r.length))
  let start = 0
  const note = []
  if (header !== null) note.push(`第 ${header} 行不是数，当表头跳过了`)
  /* 首列是序号？ */
  let isSeq = cols >= 3 && raw.every((r) => r.length === cols)
  if (isSeq) {
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i][0] !== i + 1) {
        isSeq = false
        break
      }
    }
  }
  if (isSeq) {
    start = 1
    note.push('第一列看着是序号，我跳过了它')
  }
  if (cols > start + 2) note.push(`每行有 ${cols} 列，只取了第 ${start + 1}、${start + 2} 列`)

  const rows = raw.map((r) => [r[start], r[start + 1]])
  if (!rows.length) return { ok: false, why: '一个点都没读出来' }
  return { ok: true, rows, skipped, note: note.length ? note.join('；') : null }
}

// ─────────────────── 二、轴的范围与刻度 ───────────────────

/** 数据的最小/最大，两头各留一点空（点贴着边框不好看，也读不出数）。 */
export function chartExtent(rows, pad = 0.06) {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const [x, y] of rows) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (!Number.isFinite(x0)) return null
  const grow = (a, b) => {
    if (!(b > a)) {
      /* 全都挤在一个值上：给它上下各让开一点，不然除零会把图算没了。 */
      const p = Math.max(Math.abs(a) * 0.5, 1)
      return [a - p, b + p]
    }
    const p = (b - a) * pad
    return [a - p, b + p]
  }
  return { xr: grow(x0, x1), yr: grow(y0, y1) }
}

/**
 * ★ 把轴的范围**吸附到整刻度**上（2026-10-05，照样张）。
 *
 * 为什么必须这样 —— 看他的样张图①：
 *   数据 x 是 1…12，量出来的 xlim **恰好是 [0, 12]**；
 *   数据 y 是 43…76，ylim **恰好是 [40, 80]**。
 *   也就是说轴的两端都落在刻度线上，不多不少。
 * 我原来留 6% 的空 → xlim 变成 [0.34, 12.66]，于是最左那根刻度线（x=0）
 * 落在**绘图区外面**，图左边空出一道白，而"0"这个数字印在框外头 ——
 * 贴到报告上看着就是"轴画歪了"。
 *
 * ⚠ 吸附的方向是**只往外不往里**（floor / ceil）：数据最小是 1，轴不能收到 1 ——
 *   最左那个点会骑在轴线上。
 *
 * @param {[number,number]} r  原始范围
 * @param {number} step 刻度步长（由 `niceStep` 定）
 * @param {number} count 期望几格
 */
export function snapToStep(r, step, count = 5) {
  if (!(step > 0) || !(r[1] > r[0])) return r
  const lo = Math.floor(r[0] / step) * step
  const hi = Math.ceil(r[1] / step) * step
  /* 吸附完要还是一样宽（数据本来就正好在两格之间），退回原范围。 */
  if (!(hi > lo)) return r
  /* 步长太大导致吸附完空出一堆（count 给小了），把步长退回一格。 */
  if ((hi - lo) / step > count + 3) return [lo, lo + step]
  return [lo, hi]
}

/**
 * ★ 画图用的那些**线宽、字号、点径**（2026-10-05 全部从样张 PDF 量出来）。
 *
 * 为什么集中放这一个地方：之前这些数散在 SVG 和 PDF 两处各写一遍，
 * 改一边另一边就不动 —— 打印出来和屏幕上不一样，是最难查的那种毛病。
 *
 * ⚠ 全部表示成「**绘图区宽度的多少分之一**」，不是绝对值。
 *   因为屏幕预览（116mm）和打印（跟着页面宽度变）画布大小差好几倍，
 *   只有按比例缩，两边才长得一样。
 *
 * 量出来的对照（样张绘图区宽 330pt，当作 1.0）：
 *   数据线 0.77pt → 0.00233   （我原来是 2/420 = 0.0048，粗了一倍）
 *   轴线   0.72pt → 0.00218   （我原来 2/420）
 *   网格线 0.33pt → 0.0010    （原来根本没有）
 *   圆直径 4.2pt  → 0.01273   （我原来半径 4 = 直径 8/420 = 0.019，大了 1.5 倍）
 *   主刻度线长 3.7pt → 0.0112  （我原来 5/420）
 *   次刻度线长 1.85pt → 0.0056 （原来没有）
 *   刻度字号 7.0pt → 0.0212   （我原来 13/420 = 0.031，大了 1.45 倍）
 *   轴名字号 9.0pt → 0.0273   （我原来 14/420 = 0.033）
 *   图例字号 7.6pt → 0.0230   （我原来 12/420 = 0.029）
 *   标题字号 12.5pt → 0.0379  （我原来 11/420 = 0.026，小了 1.4 倍 —— 一眼就看出来）
 */
export const SKETCH = {
  dataLine: 0.00233, // 数据连线 / 拟合线
  axisLine: 0.00218, // 左右两条坐标轴
  gridLine: 0.001, // 淡灰网格
  dotR: 0.00636, // 圆半径（直径 0.0127）
  dotStroke: 0.00218, // 圆的描边
  tickMajor: 0.0112, // 主刻度线朝外长度
  tickMinor: 0.0056, // 次刻度线朝外长度
  arrow: 0.0133, // 坐标轴末端箭头的张开（样张量到 4.4pt）
  fsTick: 0.0212, // 刻度数字
  fsAxis: 0.0273, // 轴名
  fsLegend: 0.023, // 图例
  fsTitle: 0.0379, // 图名
  legendRow: 0.0494, // 图例行距（样张 16.3pt）
  legendPadX: 0.0156, // 图例文字离符号多远
  legendMark: 0.0303, // 图例里那段线/那个圈占多宽
  /* 轴名落位（样张量的，别再拍脑袋）：
     样张左边距 34.8pt 拆成「y轴名区 20.6pt（在刻度数字**左边**）+ 刻度数字区 14.2pt」，
     轴名中心 x=84pt 正好落在前一区里。⇒ `l × 20.6/34.8 ≈ l × 0.59`，
     我留了点余量取 **0.5**（0.59 会让字贴着刻度数字）。
     x 轴名基线在 258pt、绘图区底 231.47 ⇒ 低 26.5pt；绘图区高 112pt 对应 94 单位
     （系数 0.839）⇒ 26.5×0.839 = 22 单位 ⇒ `ih × 22/94 ≈ ih × 0.235`。
     ⚠⚠ 这两个是**相对量**（×左边距 / ×绘图区高），不是绝对单位 ——
        我第一版把 26.5pt 直接当"1.15 倍绘图区高"，算出 108 单位，
        轴名跑到图里面压着曲线；后来又把 yNameAt 设成 0.77，轴名压在刻度数字上
        （2026-10-05 两次都踩了）。判据：**轴名中心必须在刻度数字区左边**。 */
  yNameAt: 0.5, // y 轴名中心 x = 左边距 × 这个（须 < 1 - 刻度数字区占比）
  xNameBelow: 0.235, // x 轴名基线 = 绘图区底 + 绘图区高 × 这个
}

/** 网格线颜色 —— 样张量到 rgb(0.851,0.851,0.851)，是"能看见但不抢眼"的淡灰。 */
export const GRID_COLOR = '#d9d9d9'

/**
 * ★ 刻度之间隔多远（绘图区单位）—— 2026-10-05 从样张量的。
 *
 * 样张绘图区 330×112pt：x 上有 7 根刻度（0/2/4/6/8/10/12）、y 上有 5 根（40…80）。
 *   x 间隔 = 330/7 ≈ 47.1 → 换算到本文件的绘图区宽 282：**40.3**
 *   y 间隔 = 112/5 = 22.4 → 换算到本文件的绘图区高 96：**19.2**
 *
 * ⚠ 为什么写死这两个数、而不是写"每 62 单位一根"那种除数：
 *   密度必须跟着绘图区的实际宽高走。这两个数是**本文件这套画布**下的
 *   正确值；改 `CHART_BOX` 的宽高时它们要一起换算（比例不变就不动）。
 */
export const TICK_GAP = { x: 40.3, y: 19.2 }

/**
 * 刻度取"整"数：步长只取 1 / 2 / 5 × 10ⁿ 里最接近的那一个。
 * 为什么必须这样：0.37、0.74、1.11 这种刻度印在图上，读的人没法用它估数 ——
 * 坐标纸的意义就是让人能一眼读出中间那点是多少。
 */
export function niceStep(span, count = 5) {
  if (!(span > 0)) return 1
  const raw = span / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

/** 刻度上的数字印几位，由**步长**定 —— 于是同一根轴上各位数一样齐。 */
export function tickText(v, step) {
  if (v === 0) return '0'
  const dec = Math.max(0, -Math.floor(Math.log10(step)))
  let s = v.toFixed(Math.min(dec, 10))
  /* -0.0 这种要修掉，不然印出来是 "-0" */
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1)
  return s
}

/** 落在 [lo, hi] 里的那一串刻度值 + 它们印成什么。 */
export function axisTicks(lo, hi, count = 5) {
  const step = niceStep(hi - lo, count)
  const start = Math.ceil(lo / step - 1e-9)
  const out = []
  /* 用整数计数循环，别写 `v += step` —— 0.1 加十次不是 1.0。 */
  for (let i = 0; i <= count + 2; i += 1) {
    const v = (start + i) * step
    if (v > hi + step * 1e-9) break
    out.push({ v, text: tickText(v, step) })
  }
  return { step, ticks: out }
}

/**
 * ★ 次刻度（**不印数字**，只画短刻度线和网格线）—— 2026-10-05 照样张加的。
 *
 * 样张里网格线画在**每个半格**上：主刻度步长 2（x 上是 0/2/4…），网格线却在
 * 1/3/5/7… 也有。所以他的网格是"次刻度网格"，一格分两半。
 * 量出来的次刻度线长 1.85pt、主刻度 3.7pt —— 正好一半，这也对得上。
 *
 * ⚠ 为什么主刻度上**也**画网格线：样张的横竖网格线是连着的，主刻度那条
 *   被轴的黑线盖住了，所以看不出来。代码里两边都画，被盖住的那条自然看不见。
 *
 * @returns {number[]} 次刻度的值（从 lo 起、到 hi 止）
 */
export function minorTicks(lo, hi, step) {
  const out = []
  if (!(step > 0)) return out
  const half = step / 2
  /* 起点要保证「k*half」不落在主刻度上，否则网格和刻度线会重画两遍。 */
  const start = Math.ceil(lo / half - 1e-9)
  for (let i = 0; i <= 400; i += 1) {
    const v = (start + i) * half
    if (v > hi + half * 1e-9) break
    /* 差半个主刻度 = 主刻度本身，跳过（那条由主刻度负责）。 */
    const onMajor = Math.abs(v / step - Math.round(v / step)) < 1e-9
    if (!onMajor) out.push(v)
  }
  return out
}

// ─────────────────── 三、一张图的全部几何 ───────────────────

/**
 * ★ 图例往哪儿放 —— **不许压住曲线**（2026-10-05，用户明确要求的）。
 *
 * 他说的原话是"图例画里面没问题，只要不覆盖"。之前我固定放右上角，
 * 结果图②图③的图例正好盖在峰值那一段上 —— 数据被遮住了，那张图就废了。
 *
 * 做法：四个角各摆一次，数**压中几段**（点和连线都算），取最少那个。
 * ⚠ **连线也要算**：光数点会漏判 —— 一条从右上降到左下的曲线，
 *   点都在上边，左下角一个点都没有，可那条线正好从左下角穿过（图例盖上去照样遮住）。
 *   所以把折线按格采样成若干小段，任一段落进框内就算压住。
 * ⚠ 留一格余量（`pad`）：点/线擦着框边也算压到，不然视觉上还是挨着。
 *
 * @param {Array<{px:number,py:number}>|Array<Array<{px:number,py:number}>>} dots
 *   一条曲线的点，或**几条**曲线的点（`chartGeomAll().series[i].dots`）。
 * ⚠ 多条曲线时必须**每条都判** —— 只判第一条，图例会正好盖住第二条
 *   （2026-10-05 做对比图时踩到：两条 P−t 曲线，第一条在左上、第二条在右上，
 *   图例挑了左上，把第二条的起点遮住了）。
 * @param {{w:number,h:number}} box 图例框（绘图区/viewBox 坐标）
 * @param {{x:number,y:number,w:number,h:number}} area 绘图区
 * @param {{pad?:number}} opts
 * @returns {{x:number,y:number,k:string}} 图例框左上角 + 选了哪个角
 */
export function legendSpot(dots, box, area, opts = {}) {
  const pad = opts.pad == null ? 4 : opts.pad
  const x0 = area.x
  const y0 = area.y
  const x1 = area.x + area.w
  const y1 = area.y + area.h
  const cands = [
    { k: 'tr', x: x1 - box.w, y: y0 },
    { k: 'tl', x: x0, y: y0 },
    { k: 'br', x: x1 - box.w, y: y1 - box.h },
    { k: 'bl', x: x0, y: y1 - box.h },
  ]
  /* 传进来可能是一条曲线的点，也可能是几条 —— 统一成"几条"。 */
  const polys = (Array.isArray(dots) && dots.length && Array.isArray(dots[0]) ? dots : [dots || []]).filter((d) => d && d.length)
  if (!polys.length) return cands[0]

  const inBox = (px, py, c) => px >= c.x - pad && px <= c.x + box.w + pad && py >= c.y - pad && py <= c.y + box.h + pad
  /* 折线按 ~4 单位一段采样：比逐段做线段-矩形相交简单得多，够用。 */
  const STEP = 4
  let best = cands[0]
  let bestN = Infinity
  for (const c of cands) {
    let n = 0
    for (const dots of polys) {
      for (const d of dots) if (inBox(d.px, d.py, c)) n += 1
      for (let i = 1; i < dots.length; i += 1) {
        const a = dots[i - 1]
        const b = dots[i]
        const len = Math.hypot(b.px - a.px, b.py - a.py)
        const steps = Math.max(1, Math.ceil(len / STEP))
        let hit = false
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps
          if (inBox(a.px + (b.px - a.px) * t, a.py + (b.py - a.py) * t, c)) {
            hit = true
            break
          }
        }
        if (hit) n += 1
      }
    }
    /* 平手时按候选顺序定（右上优先）—— 免得同一张图每次刷新位置都在跳。 */
    if (n < bestN) {
      bestN = n
      best = c
    }
    if (n === 0) break
  }
  return best
}

/**
 * 数据 + 画布 → 图上每一个东西的位置。**一条**曲线的情形。
 *
 * @param {Array<[number,number]>} rows
 * @param {object} opts
 *   mode   'dots'(只画点) | 'line'(点之间连起来) | 'fit'(点 + 拟合直线)
 *   box    画布尺寸（见 CHART_BOX）
 * @returns {null|object} 见 `chartGeomAll`
 */
export function chartGeom(rows, opts = {}) {
  if (!(rows || []).length) return null
  return chartGeomAll([{ rows, mode: opts.mode || 'dots', mark: opts.mark || MARKS[0], name: '' }], opts)
}

/**
 * ★ 多条曲线 → 一张图（**共用同一套轴范围**）。
 *
 * 为什么轴范围要合起来算：两条曲线的量程往往差很多（比如 P−t 那张，直接充电到
 * 700mW、加 DC-DC 只有 400mW）。各画各的轴，两条线会**长得一模一样**，
 * 反而看不出差别 —— 那样这张对比图就白画了。合算之后"谁高谁低"才看得出来。
 *
 * 返回值里 `series[i]` 是每条曲线各自的点/线/拟合；顶层还留一份 `dots`/`linePath`/
 * `fit`（= 第一条），这样**只画一条的老调用点一行都不用改**。
 *
 * @param {Array<{rows:Array, mode?:string, mark?:string, name?:string}>} list
 * @param {object} opts { box }
 * @returns {null|{xr,yr,view,series,dots,linePath,fit,fitWhy,xt,yt,box,iw,ih}}
 */
export function chartGeomAll(list, opts = {}) {
  const ss = (Array.isArray(list) ? list : []).filter((s) => s && (s.rows || []).length)
  if (!ss.length) return null
  const all = []
  for (const s of ss) for (const r of s.rows) all.push(r)
  const ext = chartExtent(all)
  if (!ext) return null
  const box = opts.box || CHART_BOX
  const iw = box.w - box.l - box.r
  const ih = box.h - box.t - box.b

  /* 刻度密度：照样张量出来的比例 —— 样张绘图区 330×112pt 上，
     x 有 7 根刻度、y 有 5 根。也就是每 47.1pt 一根 x、每 22.4pt 一根 y。
     ⚠ 这里按**绘图区宽高**算，而不是写死除数（`iw/62` 那种）：
       画布大小在屏幕预览（116mm）和打印之间差好几倍，
       密度必须跟着绘图区的实际尺寸走，写死除数必然一边太稀一边太密。 */
  const nx = Math.max(3, Math.round(iw / TICK_GAP.x))
  const ny = Math.max(3, Math.round(ih / TICK_GAP.y))

  /* ★ 先按"数据范围 + 空"定步长，再把范围吸附到整刻度（见 `snapToStep` 的说明）。
     顺序不能反：先吸附的话步长会跟着变，刻度数量就飘了。
     ⚠ 那 6% 的空是给"点贴着边框不好看"留的，但**吸附之前**它会让上界越过
       整刻度：样张数据 x 是 1…12，留 6% → 12.66 → ceil 到 14，多出一格空白。
       所以这里用**原始数据范围**（pad=0）去定轴；只有吸附完仍然贴着点
       （数据没落在刻度上）时才由 `snapToStep` 自然留出一格 —— 那正是样张的 0。 */
  const rawX = chartExtent(all, 0).xr
  const rawY = chartExtent(all, 0).yr
  let xStep = niceStep(rawX[1] - rawX[0], nx)
  const xr = snapToStep(rawX, xStep, nx)
  let yStep = niceStep(rawY[1] - rawY[0], ny)
  const yr = snapToStep(rawY, yStep, ny)
  /* 吸附可能让跨度变了一点，刻度数跟着重算 —— 但步长不重选（重选会来回跳）。 */
  const xStep2 = niceStep(xr[1] - xr[0], nx)
  if (xStep2 !== xStep) xStep = xStep2
  const yStep2 = niceStep(yr[1] - yr[0], ny)
  if (yStep2 !== yStep) yStep = yStep2

  /* 坐标变换要按吸附后的范围重算 —— `plotView` 是一次性的，不能复用 ext 那次的。 */
  const view = plotView(xr, yr, box)
  const vx = (x) => view.px(x)
  const vy = (y) => view.py(y)

  const series = ss.map((s, i) => {
    const mode = s.mode || 'dots'
    const dots = s.rows.map(([x, y]) => ({ x, y, px: vx(x), py: vy(y) }))
    /* 连线：按**给的顺序**连，不按 x 排序（见文件头那条）。 */
    let linePath = ''
    if (mode !== 'dots' && dots.length > 1) {
      linePath = dots.map((d, k) => `${k === 0 ? 'M' : 'L'}${d.px.toFixed(2)} ${d.py.toFixed(2)}`).join('')
    }
    let fit = null
    let fitWhy = null
    if (mode === 'fit') {
      const f = linearFit(s.rows)
      if (f.ok) {
        /* ★ 拟合线**只在测量区间里画**：从最小 x 到最大 x，一步都不外推
           （规矩① —— 外面那段没有测量支持）。 */
        const xs = s.rows.map((r) => r[0])
        const a = Math.min(...xs)
        const b = Math.max(...xs)
        fit = {
          stats: f,
          /* 拟合线画到哪儿（viewBox 里的 x 区间）—— 顺手带上，PDF 那侧
             就不用再从 rows 里重算一遍最小/最大 x（两处算同一个东西早晚会漂）。 */
          x0: a,
          x1: b,
          path: `M${vx(a).toFixed(2)} ${vy(f.slope * a + f.intercept).toFixed(2)}L${vx(b).toFixed(2)} ${vy(f.slope * b + f.intercept).toFixed(2)}`,
        }
      } else {
        fitWhy = f.why
      }
    }
    return { name: s.name || '', mark: s.mark || markFor(i), mode, dots, linePath, fit, fitWhy }
  })

  const xt = { step: xStep, ticks: axisTicks(xr[0], xr[1], nx).ticks, minor: minorTicks(xr[0], xr[1], xStep) }
  const yt = { step: yStep, ticks: axisTicks(yr[0], yr[1], ny).ticks, minor: minorTicks(yr[0], yr[1], yStep) }
  const first = series[0]

  return {
    xr,
    yr,
    view,
    series,
    /* 顶层留一份"第一条"，只画一条的老调用点（server-export / 自检）不用改。 */
    dots: first.dots,
    linePath: first.linePath,
    fit: first.fit,
    fitWhy: first.fitWhy,
    xt,
    yt,
    box,
    iw,
    ih,
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★★ 排版：这张图上**要画哪些笔画** —— 只有这一份实现（2026-10-06）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 起因：`chartSvg`（SVG）和 `makeChartPdf`（pdf-lib）曾经把同一个"画一张图"
 * 的行为**各写一遍实现** —— 网格 / 坐标轴 / 箭头 / 刻度 / 轴名 / 曲线 / 图例，
 * 七步一一对应。改一处忘另一处 = **静默**不同步，而它们只在**打印出来**时
 * 才看得见（屏幕自检全绿）。2026-10-05 那一轮七个静默 bug 里**五个**是这么来的：
 *   · y 轴刻度数字一个都没画出来（几何全对，越界判断拿PDF 坐标比）
 *   · 竖排轴名压到刻度数字上（横向占位 1.6em，不是我以为的字高 0.72em）
 *   · 三角标记全跑到页面外（`drawSvgPath` 的 y 偏了一个恒定值）
 *   · `−` 变成方块（黑体子集没有这个字形）
 *   · 一行字要三种字体（中文走黑体、数字走衬线、变量走斜体）
 *
 *⇒ 这一层把「画什么、画在哪、多粗、多大」全算完，交给两个 **adapter**：
 *   · `svgAdapter`（`chart-print.js`）—— 把笔画画成 `<svg>`
 *   · `pdfAdapter`（`server-export.js`）—— 把同一批笔画画进 pdf-lib
 * 两侧**只做落笔**，一个决策都不许自己拿。
 *
 * ## 笔画长什么样（这是 adapter 唯一需要知道的事）
 *
 *   {k:'line', x1,y1,x2,y2, w, color, tag}       一条线
 *   {k:'path', d, w, color}折线（`d` 是 SVG path 那种 `M…L…`）
 *   {k:'circle', cx,cy,r, w, color, fill?, tag?}圆（描边 + 可选填充）
 *   {k:'rect', x,y,hw,hh, w, color, fill?, tag?} 矩形（`hw/hh` 是宽高，`w` 是描边宽）
 *   {k:'poly', pts:[[x,y]…], w, color, close?, tag?} 多边形（三角标记走这个 —— 见下）
 *   {k:'text', x,y, s, size, anchor, color, role, tag?, rot?}  一行字
 *   {k:'runs', x,y, runs:[{s,role}], size, anchor, color, rot?}  一行**多段**字
 *
 *   ⚠ `tag` 是**排版层**给这一笔起的名字（`axis` / `tick` / `arrow` / `grid` /
 *     `dot` / `mark` / `legend` …）。它不是给自检玩的 —— 自检要数"几根网格、
 *     几条坐标轴"，而那需要知道"哪一笔是哪一类"，**这是排版决定，不是落笔决定**。
 *     所以标记在**这里**打，adapter 原样带上。
 *     （2026-10-06 第一版 adapter 版没带 tag → 自检数不出坐标轴和刻度，红了 6 条。
 *     教训：把"这一笔是什么"交给 adapter 去猜，就是把决策漏出接缝。）
 *
 * ## 为什么三角是 `poly` 而不是 path
 *   pdf-lib 的 `drawSvgPath` 收的是它自己的坐标系，而本文件的图是拿 viewBox
 *   单位算的 —— 混用时三角的 y 会偏一个**恒定值**（实测 1276pt）而同一个 y 的
 *   圆画得完全对，看代码一点毛病看不出来。所以三角一律走 `poly`（逐段线），
 *   两个 adapter 都只需要"画 n 段线"，不会踩坐标系。
 *
 * ## `role`（字体角色）—— adapter 按它选字形，别自己判断
 *   `tick` 刻度数字（衬线）· `axisVar` 轴名（变量斜体 + 单位正体，拆成 runs）
 *   `legend` 图例（宋体）· `title` 图名（黑体/无衬线）
 *   ⚠ 一行字**可以有多段**（`runs`）：`斜率 1.98 ± 0.05` 里中文走黑体、
 *     `±` 和数字走衬线 —— 整串用一种字体会让另一部分变成**方块**。
 *
 * ## 坐标：全部是 **viewBox 单位**
 *   adapter 自己换算到自己的坐标系（SVG 用 1:1，PDF 要乘 K 并翻y）。
 *   ⚠ 所以**越界判断、图例避让、碰撞判定必须在这一层做完** ——
 *     拿 PDF 坐标去比会把每一个 y 刻度都跳掉（那正是 2026-10-05 的第一个 bug）。
 *
 * @param {object} ch和 `chartGeomAll` 收的是同一份（`{name, xLabel, xUnit, yLabel, yUnit, mode, extra}`）
 * @param {object} opts `box`（画布逻辑尺寸）
 * @returns {null|{box,iw,ih,strokes:Array,legendBox:null|{x,y,w,h},caption:Array}}
 */
export function chartPlan(ch, opts = {}) {
  const box = opts.box || CHART_BOX
  const ss = chartSeries(ch)
  const g = ss.length ? chartGeomAll(ss, { box }) : null
  if (!g) return null

  const { view, xt, yt, iw, ih } = g
  const S = (k) => SKETCH[k] * iw
  const fsTick = S('fsTick')
  const fsAxis = S('fsAxis')
  const fsLeg = S('fsLegend')
  const strokes = []
  /* 线的两种色：网格是淡灰，其余一律黑。adapter 只认这两个名字。 */
  const GRID = 'grid'
  const INK = 'ink'

  /* ── ① 网格：淡灰，画在**每个半格**上（样张量出来的，见 `minorTicks`） ── */
  const wGrid = S('gridLine')
  for (const v of yt.minor) strokes.push({ k: 'line', x1: box.l, y1: view.py(v), x2: box.l + iw, y2: view.py(v), w: wGrid, color: GRID, tag: 'grid' })
  for (const v of xt.minor) strokes.push({ k: 'line', x1: view.px(v), y1: box.t, x2: view.px(v), y2: box.t + ih, w: wGrid, color: GRID, tag: 'grid' })
  /* 主刻度那条也画 —— 会被坐标轴的黑线盖住，正好和外框连成一片。 */
  for (const t of yt.ticks) strokes.push({ k: 'line', x1: box.l, y1: view.py(t.v), x2: box.l + iw, y2: view.py(t.v), w: wGrid, color: GRID, tag: 'grid' })
  for (const t of xt.ticks) strokes.push({ k: 'line', x1: view.px(t.v), y1: box.t, x2: view.px(t.v), y2: box.t + ih, w: wGrid, color: GRID, tag: 'grid' })

  /* ── ② 坐标轴：只有左边和下边（样张就是两条，没有上边框和右边框） ── */
  const wAxis = S('axisLine')
  strokes.push({ k: 'line', x1: box.l, y1: box.t, x2: box.l, y2: box.t + ih, w: wAxis, color: INK, tag: 'axis' })
  strokes.push({ k: 'line', x1: box.l, y1: box.t + ih, x2: box.l + iw, y2: box.t + ih, w: wAxis, color: INK, tag: 'axis' })

  /* ── ③ 坐标轴末端的箭头（样张两个轴都有：一个向上、一个向右）──
     量出来张开 4.4pt、长 4.4pt。没有它那两根线看着就像"画到一半断了"。 */
  const aw = S('arrow')
  const ax1 = box.l + iw
  const ay1 = box.t
  strokes.push({ k: 'line', x1: ax1, y1: box.t + ih, x2: ax1 + aw, y2: box.t + ih, w: wAxis, color: INK, tag: 'arrow' })
  strokes.push({ k: 'line', x1: ax1 + aw, y1: box.t + ih - aw / 2, x2: ax1 + aw, y2: box.t + ih + aw / 2, w: wAxis, color: INK, tag: 'arrow' })
  strokes.push({ k: 'line', x1: box.l, y1: ay1, x2: box.l, y2: ay1 - aw, w: wAxis, color: INK, tag: 'arrow' })
  strokes.push({ k: 'line', x1: box.l - aw / 2, y1: ay1 - aw, x2: box.l + aw / 2, y2: ay1 - aw, w: wAxis, color: INK, tag: 'arrow' })

  /* ── ④ 刻度：主刻度朝外长、次刻度朝外短（样张 3.7pt / 1.85pt，正好一半）──
     ★ 越界判断在这一层做、而且**在 viewBox 坐标里做** —— 坐标轴范围吸附到整刻度，
       理论上每根都在框内，但浮点边界仍可能差那么一点。 */
  const tM = S('tickMajor')
  const tN = S('tickMinor')
  for (const v of yt.minor) strokes.push({ k: 'line', x1: box.l, y1: view.py(v), x2: box.l - tN, y2: view.py(v), w: wAxis, color: INK, tag: 'tick' })
  for (const v of xt.minor) strokes.push({ k: 'line', x1: view.px(v), y1: box.t + ih, x2: view.px(v), y2: box.t + ih + tN, w: wAxis, color: INK, tag: 'tick' })
  for (const t of yt.ticks) {
    const py = view.py(t.v)
    if (py < box.t - 1 || py > box.t + ih + 1) continue
    strokes.push({ k: 'line', x1: box.l, y1: py, x2: box.l - tM, y2: py, w: wAxis, color: INK, tag: 'tick' })
    /* 右对齐：文字右沿落在刻度线外沿往左 2 个单位处。
       ⚠ 底线的偏移 0.36em 是"Times 数字视觉居中"的经验值 —— 那是**排版**决定，
         不是 adapter 的事，所以在这里定死。 */
    strokes.push({ k: 'text', x: box.l - tM - 2, y: py + fsTick * 0.36, s: t.text, size: fsTick, anchor: 'end', color: INK, role: 'tick', tag: 'tick' })
  }
  for (const t of xt.ticks) {
    const px = view.px(t.v)
    if (px < box.l - 1 || px > box.l + iw + 1) continue
    strokes.push({ k: 'line', x1: px, y1: box.t + ih, x2: px, y2: box.t + ih + tM, w: wAxis, color: INK, tag: 'tick' })
    strokes.push({ k: 'text', x: px, y: box.t + ih + tM + fsTick * 1.25, s: t.text, size: fsTick, anchor: 'middle', color: INK, role: 'tick', tag: 'tick' })
  }

  /* ── ⑤ 轴名：**变量斜体 + 单位正体**（样张 `I` 是斜的，`/ mA` 是正的）──
     ★ y 轴名的 x **不是拍一个比例**，而是由「刻度数字区实际有多宽」反算出来的。
       写死比例会撞车：三位数刻度（`800`）比两位数宽一大截，左边距按两位数算好的话，
       y 轴名就压到刻度数字上（2026-10-05 连踩两次）。
       `textW` 由 adapter 传进来（SVG 量不准字体、按字符数估；PDF 用真字体量）——
       ⚠ 所以这一层的接口里**没有**"字宽"，只有"要往左让多少"：adapter 传一个量宽函数。 */
  const textW = opts.textW || ((s, size) => String(s).length * size * 0.62)
  let tickW = 0
  for (const t of yt.ticks) tickW = Math.max(tickW, textW(t.text, fsTick))
  const tickZone = tM + tickW + 2
  /* ⚠⚠ 1.7em 是**旋转之后**那一段的横向占位（实测：7.4pt 的 `P / mW` 旋转后
     span 宽 11.9pt = 1.61em，Times 的 ascender + descender 都算进去），
     不是字高 0.72em —— 用 0.72 只留了一半，y 轴名压在刻度数字上。
     判据：**y 轴名的右沿必须小于刻度数字的左沿**。 */
  const yNameX = Math.max(fsAxis * 0.85, box.l - tickZone - fsAxis * 0.85)
  const xNameY = box.t + ih + ih * SKETCH.xNameBelow
  /* 轴名拆成「变量（斜体）/ 单位（正体）」两段 —— 样张里那个 `I` 是斜体、`/ mA` 是正体。
     ⚠⚠ **` / ` 必须跟着单位那一段**（不能自己单独一段）：它是一个分隔符，不是一段文字，
        单独包起来会让「变量斜体 + / + 单位正体」这个判据在两处写法不同 ——
        自检那两条断言找的就是 `<tspan italic>U</tspan> / <tspan normal>V</tspan>`
        这个形状（第一版 adapter 把 ` / ` 单独一段，两条断言立刻红了）。 */
  const axisRuns = (label, unit) => {
    const runs = []
    if (label) runs.push({ s: label, role: 'var' })
    if (unit) runs.push({ s: (label ? ' / ' : '') + unit, role: 'unit' })
    return runs
  }
  if (ch.xLabel || ch.xUnit) {
    strokes.push({ k: 'runs', x: box.l + iw / 2, y: xNameY, runs: axisRuns(ch.xLabel, ch.xUnit), size: fsAxis, anchor: 'middle', color: INK, tag: 'axisName' })
  }
  if (ch.yLabel || ch.yUnit) {
    strokes.push({ k: 'runs', x: yNameX, y: box.t + ih / 2, runs: axisRuns(ch.yLabel, ch.yUnit), size: fsAxis, anchor: 'middle', color: INK, rot: -90, tag: 'axisName' })
  }

  /* ── ⑥ 连线 / 拟合线 / 数据点 —— **每条曲线各来一遍** ──
     规矩①：拟合线不外推，`chartGeomAll` 已经只给到测量区间。
     ⚠ 一条曲线时和以前逐字节一样（`series` 只有一个元素、标记是圆），
       所以已存的那些图打开/打印跟以前没有区别。 */
  const wLine = S('dataLine')
  const wDot = S('dotStroke')
  const rDot = S('dotR')
  for (const s of g.series) {
    if (s.linePath && s.mode !== 'fit') strokes.push({ k: 'path', d: s.linePath, w: wLine, color: INK, tag: 'series' })
    if (s.fit) strokes.push({ k: 'path', d: s.fit.path, w: wLine, color: INK, tag: 'series' })
    /* 点：白心黑边 —— 打出来是空心的，压在线上也看得见线（实心点会把线吃掉）。
     ⚠ `tag` 一律是 `'dot'`（**不论形状**）—— 自检要数的是"这一笔有几个实测点"，
       而圆/方/三角是**形状**那件事（分两样断言，见 check-chart 的 ⑤）。
       第一版给方点打了 `'mark'`，于是"数点"那条断言只数到圆点，方点和三角漏了
       —— 数据点漏数在自检里是"看起来正常"（少几个点照样出图）。 */
    for (const d of s.dots) strokes.push({ ...markPlan(s.mark, d.px, d.py, rDot, wDot, INK), tag: 'dot' })
  }

  /* ── ⑦ 图例：画在**图内**，但位置由 `legendSpot` 挑 —— 压到曲线就换个角。 ──
     ⚠ 白底是**不透明**的（样张就是白底）：半透明的话底下的曲线会透上来，
     而用户要的是"图例不许盖住数据"。所以它先落笔（在曲线之后），盖住的代价
     由 `legendSpot` 避让来避免，而不是靠透明。 */
  const legend = legendItems(ch)
  let legendBox = null
  if (legend.length) {
    const rowH = S('legendRow')
    const markW = S('legendMark')
    const padX = S('legendPadX')
    let tw = 0
    for (const it of legend) tw = Math.max(tw, textW(it.text, fsLeg))
    const lw = markW + padX + tw + fsLeg * 1.2
    const lh = legend.length * rowH + rowH * 0.5
    const area = { x: box.l, y: box.t, w: iw, h: ih }
    /* ⚠ 传**所有**曲线的点进去：只判第一条，图例会正好盖住第二条。 */
    const at = legendSpot(g.series.map((s) => s.dots), { w: lw, h: lh }, area)
    strokes.push({ k: 'rect', x: at.x, y: at.y, hw: lw, hh: lh, color: 'none', fill: '#fff', tag: 'legend' })
    legend.forEach((it, i) => {
      const cy = at.y + rowH * (i + 0.75)
      const cxs = at.x + markW * 0.5
      if (it.kind === 'series') {
        /* 一条曲线一行：它的标记形状 + 它的名字 + 两侧各半截连线。 */
        strokes.push({ ...markPlan(it.mark, cxs, cy, rDot, wDot, INK), tag: 'legend' })
        strokes.push({ k: 'line', x1: at.x, y1: cy, x2: at.x + markW * 0.28, y2: cy, w: wLine, color: INK, tag: 'legend' })
        strokes.push({ k: 'line', x1: cxs + markW * 0.22, y1: cy, x2: at.x + markW, y2: cy, w: wLine, color: INK, tag: 'legend' })
      } else if (it.kind === 'dot') {
        strokes.push({ k: 'circle', cx: cxs, cy, r: rDot, w: wDot, color: INK, fill: '#fff', tag: 'legend' })
      } else {
        strokes.push({ k: 'line', x1: cxs - markW * 0.32, y1: cy, x2: cxs + markW * 0.32, y2: cy, w: wLine, color: INK, tag: 'legend' })
      }
      strokes.push({ k: 'text', x: at.x + markW + padX, y: cy + fsLeg * 0.36, s: it.text, size: fsLeg, anchor: 'start', color: INK, role: 'legend', tag: 'legend' })
    })
    legendBox = { x: at.x, y: at.y, w: lw, h: lh }
  }

  return { box, iw, ih, strokes, legendBox }
}

/** 一个数据标记 → 那一笔（或那几笔）笔画。三角走 `poly`（见 `chartPlan` 那段说明）。 */
export function markPlan(mark, cx, cy, r, w, color) {
  /* ⚠ `rect` 上那圈描边的宽度字段也叫 `w` —— 而矩形的**宽**叫 `hw`。
     （第一版把矩形宽度写成 `w`、笔宽写成 `w0`，adapter 就得记两套字段名；
     现在统一：几何尺寸一律带前缀 `w/h`，线宽才是 `w`。） */
  if (mark === 'square') {
    return { k: 'rect', x: cx - r * 0.88, y: cy - r * 0.88, hw: r * 1.76, hh: r * 1.76, w, color }
  }
  if (mark === 'triangle') {
    const s = r * 1.15
    return { k: 'poly', pts: [[cx, cy + s], [cx + r, cy - r * 0.72], [cx - r, cy - r * 0.72]], w, color, close: true }
  }
  return { k: 'circle', cx, cy, r, w, color, fill: '#fff' }
}
