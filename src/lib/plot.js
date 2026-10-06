/* 「这条式子画出来什么样」—— 给式子里的一个未知量扫一段区间，得到一串能画的点。
 *
 * ── 和 calc.js 的分工 ────────────────────────────────────────────────
 * calc.js 回答"代进去是多少"（一个量 → 一个数）；
 * 这个文件回答"它长什么样"（一个量扫过去 → 一串点）。
 * 采样这一步还是调 `evalFormula` —— 同一套内核算出来的东西，不会出现"算得对、画错了"。
 *
 * ── 三条硬规矩（和 calc.js 是同一套脾气）────────────────────────────
 * ① **宁可少画，不许画错。** 算不出值的点（开负数的平方、log 负数、1/0）一律留空，
 *    曲线在那里**断开**；绝不许把断开的两端连起来 —— 那会画出一条根本不存在的线。
 * ② **纯函数、零依赖**（只 import calc.js）：node 里直接断言得住（check-plot）。
 *    它不碰 DOM、不碰 React、不出网。画是后来的事，先把点算对。
 * ③ **不为一张图去问模型**：这是一台本机就能算完的事，出网既没必要也不该花钱。
 *
 * ── 它要解决的两个真问题 ────────────────────────────────────────────
 * 问题一：**默认画哪一段**。学生写 `sqrt(x)`，你不知道他想要 [-10,10] 还是 [0,5]，
 *   而 [-10,10] 上有一半是空的。`autoRange` 先粗扫一遍，挑出**这条式子算得出来的
 *   最长那一段** —— 于是 sqrt 直接给 [0,10]、log 直接给 (0,10]、tan 给 (-π/2, π/2)。
 *   这条比让用户自己填数字重要得多：他要的是"看一眼"，不是"设置坐标轴"。
 *
 * 问题二：**渐近线那道假竖线**。`1/x` 在 x=0 上下的两个采样点之间，
 *   严格按数据连线就是一条贯穿全图的竖线，而那条线**不是函数的图像**。
 *   同理 tan(x) 每隔 π 就来一条。判据见 `polylines` 里的 jump —— 用**分位数**
 *   定参考跨度，相邻两点差得离谱就断开。这样画出来的是一个一个孤立的分支，
 *   而不是一串钉子。
 */

import { evalFormula } from './calc.js'

/** 画图默认扫多密。320 段对一条 SVG 曲线来说够顺，又不会让路径长到拖慢缩放。 */
export const STEPS = 320

/**
 * 这条式子里的哪个符号当横轴。
 *
 * ★ 挑**第一个还没值的**那个：学生多半先填已知量，剩下那个就是他想看的变量。
 *   全都填过了就挑第一个 —— 那就等于"固定其它量，看这一个怎么变"。
 */
export function defaultPlotSym(vars, vals = {}) {
  const list = Array.isArray(vars) ? vars : []
  if (!list.length) return null
  const empty = (v) => {
    const s = vals[v]
    return s === undefined || s === null || (typeof s === 'string' && s.trim() === '')
  }
  return list.find(empty) || list[0]
}

/** 在一个 x 上求值；顺手把"缺谁的值"这种原因收下来。 */
function at(node, sym, x, values) {
  const r = evalFormula(node, { ...values, [sym]: x })
  return r.ok ? { ok: true, value: r.value } : { ok: false, why: r.why }
}

/**
 * 问题一：粗扫一遍，挑"这条式子算得出来的最长那一段"。
 *
 * @returns {{ok:true, from:number, to:number}|{ok:false, why:string}}
 */
export function autoRange(node, sym, values = {}, opts = {}) {
  if (!sym) return { ok: false, why: '这条式子里没有可以变的量（全是已知的数），画不出来' }
  const span = opts.span ?? 10
  const step = opts.step ?? 0.05
  const n = Math.max(8, Math.round((2 * span) / step))
  let best = null
  let cur = null
  let why = null
  for (let i = 0; i <= n; i += 1) {
    const x = -span + (i * 2 * span) / n
    const r = at(node, sym, x, values)
    if (r.ok) {
      if (cur) cur.b = x
      else cur = { a: x, b: x }
    } else {
      if (!why) why = r.why
      if (cur) {
        if (!best || cur.b - cur.a > best.b - best.a) best = cur
        cur = null
      }
    }
  }
  if (cur && (!best || cur.b - cur.a > best.b - best.a)) best = cur
  if (!best) return { ok: false, why: why || '这条式子画不出来' }
  if (!(best.b - best.a > (2 * span) / n)) {
    /* 只有孤零零一个点能算 —— 那不叫一段区间，画出来是一个点。 */
    return { ok: false, why: why || '这条式子几乎处处算不出来' }
  }
  return { ok: true, from: best.a, to: best.b }
}

/**
 * 扫一段区间 → 一串点。
 *
 * @returns {{ok:true, xs:number[], ys:(number|null)[], missing:number, why:string|null}}
 *   `ys[i] === null` = 这个 x 上这条式子没有值，画图时这里要断开。
 */
export function sampleCurve(node, sym, from, to, values = {}, steps = STEPS) {
  if (!sym) return { ok: false, why: '这条式子里没有可以变的量（全是已知的数），画不出来' }
  const x0 = Number(from)
  const x1 = Number(to)
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return { ok: false, why: '区间得是两个数' }
  if (x0 === x1) return { ok: false, why: '一头一尾不能是同一个数（区间得有宽度）' }
  const xs = []
  const ys = []
  let missing = 0
  let why = null
  for (let i = 0; i <= steps; i += 1) {
    const x = x0 + ((x1 - x0) * i) / steps
    const r = at(node, sym, x, values)
    xs.push(x)
    if (r.ok) {
      ys.push(r.value)
    } else {
      ys.push(null)
      missing += 1
      if (!why) why = r.why
    }
  }
  return { ok: true, xs, ys, missing, why }
}

/** 分位数。`sorted` 必须是**升序排过**的数组。 */
function quantile(sorted, p) {
  if (!sorted.length) return 0
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/**
 * 一串点 → 几条**可以连起来画**的折线。
 *
 * 两处断开：
 *  · `ys[i] === null`（这条式子在这个 x 上没值）—— 规矩①，必断。
 *  · 相邻两点差得离谱 —— 见文件头"问题二"，那条竖线不是函数图像。
 *    阈值用 **p5~p95 的跨度** 乘一个系数，而不是用 min~max：
 *    `exp(x)`、`x^100` 这些是真的那么陡，用 min/max 会把它们也切碎；
 *    而 `tan(x)`、`1/x` 的主体其实很平，只有奇点附近才会一跳 —— 正是分位数要抓的。
 *
 * @returns {{ok:true, lines:Array<Array<{x:number,y:number}>>, yr:[number,number], cuts:number, missing:number}
 *          |{ok:false, why:string}}
 *   `yr` = 建议的纵轴范围；`cuts` = 因为跳得太狠而断开的次数（界面上会说"有几处断开了"）。
 */
export function polylines(xs, ys, opts = {}) {
  const n = Math.min(xs.length, ys.length)
  const finite = []
  for (let i = 0; i < n; i += 1) if (ys[i] !== null && ys[i] !== undefined) finite.push(ys[i])
  if (finite.length < 2) return { ok: false, why: '这个区间上，这条式子最多就能算出一个点' }

  const sorted = finite.slice().sort((a, b) => a - b)
  const band = Math.max(quantile(sorted, 0.95) - quantile(sorted, 0.05), Number.MIN_VALUE)
  const jump = band * (opts.jump ?? 1.5)

  const lines = []
  let cur = []
  let cuts = 0
  for (let i = 0; i < n; i += 1) {
    const y = ys[i]
    if (y === null || y === undefined) {
      if (cur.length > 1) lines.push(cur)
      cur = []
      continue
    }
    if (cur.length && Math.abs(y - cur[cur.length - 1].y) > jump) {
      /* 断开，但**这个点自己还是有效的** —— 它是下一段的头，
         不是上一截飞出去的尾巴。所以 push 之后不清空而是重建。 */
      if (cur.length > 1) lines.push(cur)
      cur = []
      cuts += 1
    }
    cur.push({ x: xs[i], y })
  }
  if (cur.length > 1) lines.push(cur)
  if (!lines.length) return { ok: false, why: '这一段的点数不够，画不出线' }

  /* 纵轴范围：**只在留下来的那些点上量**。
     这样 1/x 被切掉 ±1e6 那两个尾巴之后，图不会被它们压成一条贴底的直线。 */
  let lo = Infinity
  let hi = -Infinity
  for (const ln of lines) for (const p of ln) {
    if (p.y < lo) lo = p.y
    if (p.y > hi) hi = p.y
  }
  if (!(hi > lo)) {
    /* 一条水平线的话，给它上下各留点空 —— 不然会糊在边框上，看着像坏了。 */
    const pad = Math.max(Math.abs(hi) * 0.5, 1)
    lo -= pad
    hi += pad
  } else {
    /* 上下各留 6%：曲线贴着边框不好看，顶点也读得出数。 */
    const p = (hi - lo) * 0.06
    lo -= p
    hi += p
  }
  let missing = 0
  for (let i = 0; i < n; i += 1) if (ys[i] === null || ys[i] === undefined) missing += 1
  return { ok: true, lines, yr: [lo, hi], cuts, missing }
}

// ──────────────────── 数据坐标 → 图上的位置 ────────────────────

/** 画布尺寸（viewBox 用）。**左边留 4、下边留 16** 是给那一圈刻度字的地方。 */
export const PLOT_BOX = { w: 268, h: 138, l: 4, r: 6, t: 6, b: 17 }

/**
 * 一个把 "式子里的数" 换成 "SVG 里的厘米" 的转换器。
 * ★ 它**纯算术**，不碰 DOM —— 组件拿它算出 <path d>，check-plot 也能直接断言。
 */
export function plotView(xr, yr, box = PLOT_BOX) {
  const iw = box.w - box.l - box.r
  const ih = box.h - box.t - box.b
  const [xa, xb] = xr
  const [ya, yb] = yr
  const sx = xb === xa ? 0 : iw / (xb - xa)
  const sy = yb === ya ? 0 : ih / (yb - ya)
  return {
    box,
    iw,
    ih,
    px: (x) => box.l + (x - xa) * sx,
    py: (y) => box.t + ih - (y - ya) * sy,
    ux: (p) => (sx === 0 ? xa : xa + (p - box.l) / sx),
    uy: (p) => (sy === 0 ? ya : ya + (box.t + ih - p) / sy),
  }
}

/** 一条折线 → `<path d>`。`M` 起笔、`L` 连线，中间不再断开。 */
export function lineToPath(pts, view) {
  let d = ''
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]
    d += (i === 0 ? 'M' : 'L') + view.px(p.x).toFixed(2) + ' ' + view.py(p.y).toFixed(2)
  }
  return d
}

/**
 * 刻度上的数字怎么印。
 * ★ 和图宽度打架的那一面交给它：一根 268 宽的图上，`-1.2345e-7` 这种会糊成一团，
 *   所以有效数字压到 3 位、超大超小的走科学计数法（用上标是为了省一半宽度）。
 */
export function fmtTick(n) {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e5 || abs < 1e-3) {
    return n
      .toExponential(2)
      .replace(/e([+-])(\d+)/, (_, s, d) => `e${s === '-' ? '-' : ''}${d}`)
      .replace(/\.00(?=e)/, '')
  }
  const s = String(Number(n.toPrecision(3)))
  return s.length > 7 ? Number(n).toExponential(1).replace('e+', 'e') : s
}

/**
 * 找离某个 x 最近的那个**有值**的点 —— 鼠标停在图上的时候要报数。
 * @returns {{x:number, y:number}|null}
 */
export function nearestPoint(lines, x) {
  let best = null
  for (const ln of lines) {
    for (const p of ln) {
      const d = Math.abs(p.x - x)
      if (!best || d < best.d) best = { d, p }
    }
  }
  return best ? best.p : null
}
