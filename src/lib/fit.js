/* 「这堆测量点，那条直线是什么」—— 最小二乘。
 *
 * ── 它回答什么 ──────────────────────────────────────────────────────
 * 物理实验报告里最常见的一件事：测了一串 (x, y)，要画一条最贴合的直线，
 * 然后从这条线上读出**斜率**（它往往是那个要交的物理量 —— 电阻、g、普朗克常数…），
 * 再给这个斜率一个**不确定度**。
 * 逐差法能算斜率，但给不出不确定度，也更算不出 R² —— 而这两样恰恰是报告里
 * 老师要看的。这个文件把它们一次给全。
 *
 * ── 三条硬规矩（和 calc.js / plot.js 同一套脾气）────────────────────
 * ① **宁可不给，不许给错的**。点数不够（<3）、x 全挤在一个值上、数据里有 NaN
 *    —— 一律返回 `{ok:false, why}`，一个字都不编。
 *    学生对着一条假的拟合线能改一晚上，而且"看着很合理"那种错最难发现。
 * ② **纯函数、零依赖、不出网**：node 里直接断言得住（check-chart）。
 *    这是本机算术，问模型既没必要也不该花钱 —— 它算错了我们还更难发现。
 * ③ **给"剩下多少个点"留口子**：后面可能要接加权拟合、过原点拟合；
 *    但**先把这一个做对**，别一次堆一堆用不上的选项（那叫"看得见用不了"）。
 */

/**
 * 一维最小二乘拟合 `y = a·x + b`。
 *
 * @param {Array<[number, number]>} pts 测量点
 * @returns {{ok:true, n, slope, intercept, r2, syx, slopeSE, interceptSE, xbar, ybar, sxx}
 *          |{ok:false, why:string}}
 *
 * 几个名字的意思（实验报告上就是这么写的）：
 *   slope / intercept  斜率 a、截距 b
 *   r2                 决定系数，1 是完全贴合
 *   syx                **残差标准偏差**：点们离这条线的典型距离
 *   slopeSE            斜率的**标准不确定度** u(a) —— 报告上写 a ± u(a) 的那个 u
 *   interceptSE        截距的标准不确定度 u(b)
 *
 * ⚠ `slopeSE` 只在**误差主要落在 y 上、而且各点误差差不多大**时才成立
 *   （这是实验课的默认前提：x 是自变量、读数的误差在 y 上）。
 *   真要讲究（x 也有误差、各点精度不同）得用加权或者正交回归 ——
 *   那是另一套东西，这里**不做**，也不假装做了。
 */
export function linearFit(pts) {
  const rows = []
  for (const p of Array.isArray(pts) ? pts : []) {
    const x = Number(p && p[0])
    const y = Number(p && p[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, why: '数据里有不是数的东西' }
    rows.push([x, y])
  }
  if (rows.length < 3) {
    /* ★ 两个点"能"连一条线，但那条线没有统计意义：残差永远是 0，
       R² 永远是 1，不确定度根本算不出来（除以 n-2 = 0）。
       给出来就是一个"看着很精确"的假数 —— 规矩①，不给。 */
    return { ok: false, why: '至少要 3 个点才谈得上拟合（两个点连出来的线没有不确定度可言）' }
  }

  let sx = 0
  let sy = 0
  for (const [x, y] of rows) {
    sx += x
    sy += y
  }
  const n = rows.length
  const xbar = sx / n
  const ybar = sy / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [x, y] of rows) {
    const dx = x - xbar
    const dy = y - ybar
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  if (!(sxx > 0)) {
    /* x 全都一样 → 这条"直线"是竖直的，斜率是无穷大。竖直的不是函数，画不了。 */
    return { ok: false, why: '这些点的横坐标全都一样，定不出一条斜线' }
  }

  const slope = sxy / sxx
  const intercept = ybar - slope * xbar

  /* 残差平方和 SSE 与总平方和 SST。R² = 1 - SSE/SST。
     ⚠ SST = 0（y 也全都一样）时 R² 是 0/0 —— 那种数据是一条水平线，
     说"完全贴合"和"完全不贴合"都不对，所以给 1（水平线确实被自己解释完了）
     并且下面 syx 会是 0，读数的人一眼看得出"这组数据没有变化"。 */
  let sse = 0
  for (const [x, y] of rows) {
    const r = y - (slope * x + intercept)
    sse += r * r
  }
  const r2 = syy > 0 ? 1 - sse / syy : 1

  const dof = n - 2
  const syx = Math.sqrt(sse / dof)
  const slopeSE = syx / Math.sqrt(sxx)
  const interceptSE = syx * Math.sqrt(1 / n + (xbar * xbar) / sxx)

  return {
    ok: true,
    n,
    slope,
    intercept,
    r2,
    syx,
    slopeSE,
    interceptSE,
    xbar,
    ybar,
    sxx,
  }
}

/**
 * 把拟合结果摆成报告上那一行字：`a = 2.34 ± 0.05`，`r² = 0.9987`。
 *
 * ★ 不确定度**只留一位有效数字**（两位在特殊情况下才用），
 *   而且**中心值要跟着不确定度对齐到同一位小数** ——
 *   写 `2.341 ± 0.05` 是错的（要么 2.34±0.05，要么 2.341±0.050？不，后者是多余精度）。
 *   这是实验课上真会扣分的细节，机器顺手做对，人就少操一份心。
 */
export function fmtFit(f) {
  const u = f.slopeSE
  /* ★ 不确定度留几位有效数字，看它的**首位**是几：1、2 开头留两位，3 以后留一位
     （实验课的老规矩 —— 只留一位的话，1.2 进位成 1 就等于把精度砍掉了 40%）。
     再由它反推出"中心值该写到小数点后第几位"，两边的小数位必须一样。 */
  const exp = u > 0 ? Math.floor(Math.log10(u)) : 0
  const lead = u > 0 ? u / Math.pow(10, exp) : 0
  const digits = u > 0 ? Math.max(0, (lead < 3 ? -exp + 1 : -exp)) : 0
  const a = f.slope.toFixed(digits)
  const da = u.toFixed(digits)
  return {
    slope: `${a} ± ${da}`,
    intercept: `${f.intercept.toFixed(digits)} ± ${f.interceptSE.toFixed(digits)}`,
    r2: f.r2.toFixed(4),
  }
}
