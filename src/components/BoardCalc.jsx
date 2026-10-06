/* 「这条式子，代入数字算一算」+「把它画出来」—— 卡片上那个浮窗的两半。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * BoardCard.jsx 已经快 600 行了，而这两块浮窗是**自成一体的**：它们不碰板的任何状态，
 * 只吃一条解析好的式子（`parsed`）和一组数值（`vals`）。拆出来之后 BoardCard 只保留
 * "把按钮摆在哪、什么时候出现"，具体画什么留在这儿 —— 和
 * BoardCard / BoardBar / BoardCanvas 那次拆分的同一条道理。
 *
 * ── 三条老规矩 ────────────────────────────────────────────────────
 * ① **不出网**：式子本来就在板上，加减乘除画图本机全能算。
 *    为一个乘法去问一次模型，钱花得没道理，而且它答错了更难被发现。
 *   算法全住在 `lib/calc.js` 和 `lib/plot.js`（`check-calc` / `check-plot` 盯着）。
 * ② **宁可不给，不许给错的**：缺值指名道姓说缺谁；算不出来的地方曲线断开、
 *    不硬拉一条假的竖线过去。学生对着错数能改一晚上。
 * ③ **所有 `data-calc-*` / `data-plot-*` 都是给自检看的钩子**：
 *    屏幕上的数和路径**只有真 DOM 才读得到**（和 data-card-kind / data-card-pin
 *    同一条规矩 —— emoji 和字形分不出"开着还是关着"）。
 */
import React, { useMemo, useState } from 'react'
import { evalFormula, formatValue } from '../lib/calc.js'
import {
  autoRange,
  defaultPlotSym,
  fmtTick,
  lineToPath,
  nearestPoint,
  plotView,
  polylines,
  sampleCurve,
  PLOT_BOX,
} from '../lib/plot.js'

/** 「这条式子，代入数字算一算」—— 面板的上半截。 */
export function Calc({ parsed, vals, onVal, onClose }) {
  const out = evalFormula(parsed.node, vals)
  return (
    <div
      className="bd-calc"
      data-calc-panel="1"
      /* ⚠ 这一条不能少：不接住的话，按在输入框上就变成"开始拖这张卡"。 */
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="bd-calc-head">
        {parsed.target ? (
          <>
            算 <b>{parsed.target}</b>
          </>
        ) : (
          '算这个式子'
        )}
        <button className="bd-calc-x" data-calc-close="1" onClick={onClose} title="收起">
          ×
        </button>
      </div>
      {parsed.vars.length ? (
        <div className="bd-calc-vars">
          {parsed.vars.map((v) => (
            <label key={v} className="bd-calc-var" data-calc-var={v}>
              <span>{v}</span>
              <input
                value={vals[v] ?? ''}
                inputMode="decimal"
                spellCheck={false}
                placeholder="?"
                onChange={(e) => onVal(v, e.target.value)}
              />
            </label>
          ))}
        </div>
      ) : (
        <div className="bd-calc-note">这条式子全是已知的量，直接就能算</div>
      )}
      <div className={'bd-calc-out' + (out.ok ? '' : ' wait')} data-calc-out={out.ok ? 'ok' : 'wait'}>
        {out.ok ? '= ' + formatValue(out.value) : out.why}
      </div>

      {/* 下半截：把这条式子画出来。有且只有一个式子可看时才出现。 */}
      <Plot parsed={parsed} vals={vals} />

      {parsed.warn && (
        <div className="bd-calc-warn" data-calc-warn="1">
          现在是按优先级算的：<code>/</code> 后面挨着的那些不一定在分母上 —— 想让它们都在，给它加个括号
        </div>
      )}
    </div>
  )
}

/* ─────────────── 下半截：给这条式子画条曲线 ───────────────
 *
 * ★ **默认就把图画出来**，不用再点一下。学生按那个「=」是想看东西的，
 *   再让他去"设置横轴范围"等于没给。
 *   范围由 `autoRange` 自动挑（这条式子算得出来的最长那一段）——
 *   `sqrt(x)` 自己避开负半轴、`log(x)` 自己避开 x≤0、`1/sqrt(LC)` 自己避开 L=0。
 *   两个框是**留空的**，占位字给的就是自动挑出来的那两个数 —— 看得见、改得动。
 *
 * ★ 横轴挑谁看 `defaultPlotSym`：优先那个**还没填值**的量 ——
 *   `F = ma` 里你已经把 a 填上 9.8 了，那么想看的自然是 F 随 m 怎么变。
 */
function Plot({ parsed, vals }) {
  const vars = parsed.vars || []
  /* ⚠ `sym` 记在 state 里（用户选过就认选过的），但**每次 render 都要回头验一遍它还在不在**
     那条式子可能已经改了（卡片内容变了、vars 换了），留着一个不在 vars 里的符号会让
     `autoRange` 拿它当自变量却没有值 → 图直接空掉。不在了就退回 `defaultPlotSym`。 */
  const [sym, setSym] = useState(null)
  const [range, setRange] = useState({ from: '', to: '' })
  const [hover, setHover] = useState(null)

  const cur = vars.includes(sym) ? sym : defaultPlotSym(vars, vals)
  if (!cur) return null // 全是常量的式子没有东西可变，这一段整个不出现

  const ar = autoRange(parsed.node, cur, vals)
  const fromRaw = range.from.trim()
  const toRaw = range.to.trim()
  /* 两个框都空 = 用自动挑的那一段；**填了一头就用一头** ——
     另一半仍旧跟着自动值走（不会突然变成一个不知所云的 0）。 */
  const x0 = fromRaw === '' ? (ar.ok ? ar.from : -10) : Number(fromRaw)
  const x1 = toRaw === '' ? (ar.ok ? ar.to : 10) : Number(toRaw)

  const s = sampleCurve(parsed.node, cur, x0, x1, vals)
  const p = s.ok ? polylines(s.xs, s.ys) : null
  const why = !s.ok ? s.why : p && !p.ok ? p.why : null

  return (
    <div className="bd-plot" data-plot-box="1">
      <div className="bd-plot-bar">
        {vars.length > 1 ? (
          <select
            className="bd-plot-sym"
            value={cur}
            data-plot-sym={cur}
            onChange={(e) => setSym(e.target.value)}
            title="画谁跟着变"
          >
            {vars.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <b className="bd-plot-sym-static">{cur}</b>
        )}
        <span>从</span>
        <input
          className="bd-plot-end"
          data-plot-from="1"
          value={range.from}
          placeholder={String(x0)}
          inputMode="decimal"
          spellCheck={false}
          onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
        />
        <span>到</span>
        <input
          className="bd-plot-end"
          data-plot-to="1"
          value={range.to}
          placeholder={String(x1)}
          inputMode="decimal"
          spellCheck={false}
          onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
        />
      </div>

      {p && p.ok ? (
        <>
          <Canvas p={p} x0={x0} x1={x1} hover={hover} setHover={setHover} />
          {p.missing > 0 && (
            <div className="bd-plot-note" data-plot-note="missing">
              这一段上有 {p.missing} 个地方这条式子算不出来（比如负数开平方），曲线在那里断开了
            </div>
          )}
          {p.cuts > 0 && p.missing === 0 && (
            <div className="bd-plot-note" data-plot-note="cuts">
              有 {p.cuts} 处跳得太厉害，按断开了画（那是渐近线之类的地方，不是连续的）
            </div>
          )}
        </>
      ) : (
        <div className="bd-plot-note" data-plot-note="err">
          {why || '画不出来'}
        </div>
      )}
    </div>
  )
}

/**
 * 那块真正的图。**纯 SVG**（不用 canvas）：
 * ① 它是矢量，卡片被缩放时线不会糊；
 * ② 曲线就是几条 `<path d>`，自检直接在 DOM 里读得很清楚。
 */
function Canvas({ p, x0, x1, hover, setHover }) {
  const view = useMemo(() => plotView([x0, x1], p.yr), [x0, x1, p.yr[0], p.yr[1]])
  const paths = useMemo(() => p.lines.map((ln) => lineToPath(ln, view)), [p, view])
  const B = PLOT_BOX
  const ih = B.h - B.t - B.b
  /* 零线：只有当 0 真的在视野里才画 —— 满图都是正的还画一条边线是在骗人。 */
  const zy = p.yr[0] <= 0 && p.yr[1] >= 0 ? view.py(0) : null
  const zx = Math.min(x0, x1) <= 0 && Math.max(x0, x1) >= 0 ? view.px(0) : null

  return (
    <svg
      className="bd-plot-svg"
      data-plot="1"
      viewBox={`0 0 ${B.w} ${B.h}`}
      width={B.w}
      height={B.h}
      /* 鼠标停在图上就读那一点的数 —— 一张图最有用的就是这个。
         ⚠ 用 `getBoundingClientRect` 归一化再换算：面板有一层 `zoom` 抵消卡片缩放，
            rect.width 是**缩放后**的真实宽度，这么一除正好把它也算进去了。 */
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        if (!r.width) return
        const vbX = ((e.clientX - r.left) / r.width) * B.w
        const q = nearestPoint(p.lines, view.ux(vbX))
        setHover(q)
      }}
      onPointerLeave={() => setHover(null)}
    >
      <rect x={B.l} y={B.t} width={B.w - B.l - B.r} height={ih} rx="3" fill="#fcfcf9" stroke="#e5e8ee" />
      {zy !== null && <line className="bd-plot-axis" x1={B.l} x2={B.l + view.iw} y1={zy} y2={zy} />}
      {zx !== null && <line className="bd-plot-axis" x1={zx} x2={zx} y1={B.t} y2={B.t + ih} />}
      {paths.map((d, i) => (
        <path key={i} className="bd-plot-curve" d={d} data-plot-line={i} />
      ))}
      {/* 刻度：x 的两头压在图底下、y 的两头贴在图里面。
          208px 宽的地方放不下第三个数，所以只印边界 —— 中间的值靠鼠标读。 */}
      <text className="bd-plot-tick" x={B.l + 2} y={B.h - 4}>
        {fmtTick(x0)}
      </text>
      <text className="bd-plot-tick" x={B.w - B.r - 2} y={B.h - 4} textAnchor="end">
        {fmtTick(x1)}
      </text>
      <text className="bd-plot-tick" x={B.l + 3} y={B.t + 10}>
        {fmtTick(p.yr[1])}
      </text>
      <text className="bd-plot-tick" x={B.l + 3} y={B.t + ih - 3}>
        {fmtTick(p.yr[0])}
      </text>
      {hover && (
        <>
          <line
            className="bd-plot-cross"
            x1={view.px(hover.x)}
            x2={view.px(hover.x)}
            y1={B.t}
            y2={B.t + ih}
          />
          <circle className="bd-plot-dot" cx={view.px(hover.x)} cy={view.py(hover.y)} r="3" />
          <text className="bd-plot-read" x={B.w - B.r - 3} y={B.t + 10} textAnchor="end" data-plot-read="1">
            {fmtTick(hover.x)} → {fmtTick(hover.y)}
          </text>
        </>
      )}
    </svg>
  )
}
