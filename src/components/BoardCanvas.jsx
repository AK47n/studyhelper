import React, { useEffect, useRef } from 'react'
import { relationCurve } from '../lib/board.js'
import { drawStroke } from '../lib/ink.js'
/* 画布本体：两层 canvas（已提交的笔迹 / 正在画的那一笔）+ 一层 SVG（卡片之间的连线）。
 *
 * ── 为什么是两层 canvas ──
 * 正在画的时候每帧都要重画，而"已经画完的几百笔"重画一次要几毫秒。
 * 分成两层之后，画的过程中只清掉上面那薄薄一层（通常只有一笔），
 * 下面那层完全不动 —— 这是"跟手"和"卡"的分界线。
 *
 * ── 为什么 ink 是 canvas 而不是 SVG/DOM ──
 * 一节课几百笔、几万个点。SVG 里每个点都要变成一个 DOM 节点，缩放时浏览器
 * 还要重排，几百笔就开始掉帧。canvas 是一条路一笔画完，稳。
 * 卡片反过来（少、要放文字、要能点进去编辑），所以卡片用 DOM —— 各用各的长处。
 *
 * 坐标系：两者都用**世界坐标**，靠 ctx.setTransform 和 CSS 的 translate/scale
 * 映射到屏幕。视图变了只改变换，不动数据（见 lib/board.js 顶部的说明）。
 */
export default function BoardCanvas({
  sceneRef, liveRef, view, size, strokes, relations, cardById, cardsForInk,
  selectedId, hoverEdge, eraserAt, onPointerDown, onPointerMove, onPointerUp, children,
}) {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2.5, window.devicePixelRatio || 1)

  // ── 下面那层：已提交的笔迹 ──
  useEffect(() => {
    const cv = sceneRef.current
    if (!cv || !size.w || !size.h) return
    const ctx = cv.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of strokes) drawStroke(ctx, s)
    /* 把"这一层收到了什么"写在 DOM 上。
       为什么值得占一行代码：白板"画了看不见"的原因太多了（容器高度为 0、
       变换把内容推到屏幕外、dpr 没乘、笔迹为空……），光看画面全是"一片空白"。
       有这三个数，一眼就能分清是"没送进来"还是"送进来了没画出来"。
       scripts/check-board-browser.js 会读它们。 */
    cv.dataset.strokes = String(strokes.length)
    cv.dataset.pts = JSON.stringify(strokes.map((s) => (s && s.points ? s.points.length : -1)))
    cv.dataset.flat = JSON.stringify(
      strokes.map((s) => {
        const p = s && s.points
        if (!p) return 'none'
        if (typeof p[0] === 'object') return 'obj'
        return 'num'
      })
    )
    cv.dataset.xform = `${dpr * view.s},${dpr * view.tx},${dpr * view.ty}`
  }, [strokes, view, size.w, size.h, dpr, sceneRef])

  // ── 上面那层：正在画的那一笔（每次移动都重画，所以只放这一笔）──
  useEffect(() => {
    const cv = liveRef.current
    if (!cv || !size.w || !size.h) return
    const ctx = cv.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cv.width, cv.height)
  }, [size.w, size.h, liveRef])

  return (
    <div className="bd-stage" style={{ width: size.w, height: size.h }}>
      <canvas
        ref={sceneRef}
        className="bd-ink"
        width={Math.max(1, Math.round(size.w * dpr))}
        height={Math.max(1, Math.round(size.h * dpr))}
        style={{ width: size.w, height: size.h }}
      />

      {/* 卡片之间的连线。画在墨迹**上面**、卡片**下面**：
          这样线被卡片挡住两端，看起来是"连着卡片"而不是"穿过卡片"。 */}
      <svg
        className="bd-edges"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        style={{ width: size.w, height: size.h }}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
          {relations.edges.map((e) => {
            const a = cardById.get(e.a)
            const b = cardById.get(e.b)
            if (!a || !b) return null
            const inked = cardsForInk.has(e.a + '|' + e.b) || cardsForInk.has(e.b + '|' + e.a)
            const hot = hoverEdge && ((hoverEdge[0] === e.a && hoverEdge[1] === e.b) || (hoverEdge[0] === e.b && hoverEdge[1] === e.a))
            const { a: pa, b: pb, c } = relationCurve(a, b, e.kind === 'near' ? 0.1 : 0.2)
            const cls = 'bd-edge' + (inked ? ' inked' : '') + (hot ? ' hot' : '')
            // 描两遍：下面粗的当"白边"，让线在墨迹上也能看清（浅色笔画会把线吃掉）
            return (
              <path
                key={e.a + e.b}
                className={cls}
                d={`M ${pa.x} ${pa.y} Q ${c.x} ${c.y} ${pb.x} ${pb.y}`}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </g>
      </svg>

      {/* 卡片层（由父组件传进来）。
          ★ 它**不用** CSS transform 跟着视图走，而是每一张卡片自己按
            "屏幕 = 世界 * s + t" 算好 left/top/宽度再摆放 —— 和上面 canvas 的
            ctx.setTransform 用的是同一个公式、同一个原点（都是相对 .bd-stage）。
            为什么不用 transform（这是我踩了三次的地方）：
              绝对定位元素的 translate 是相对**它的包含块**算的，
              而 .bd-stagewrap 本身在页面里是偏的（左边有侧栏、上面有文件名那一行）。
              CSS 变换不认这件事，于是卡片整体多偏一个"容器在页面里的位置"，
              而且这个量随布局变化 —— 换摆法、改字号、窗口大小一变就又不齐。
              JS 算坐标就没有这个问题：偏移量直接来自 getBoundingClientRect。 */}
      {children}

      {/* 正在画、还没提交的那一笔 */}
      <canvas
        ref={liveRef}
        className="bd-live"
        width={Math.max(1, Math.round(size.w * dpr))}
        height={Math.max(1, Math.round(size.h * dpr))}
        style={{ width: size.w, height: size.h }}
      />

      {eraserAt && (
        <div
          className="bd-eraser"
          style={{
            left: eraserAt.x * view.s + view.tx,
            top: eraserAt.y * view.s + view.ty,
            width: 2 * eraserAt.r * view.s,
            height: 2 * eraserAt.r * view.s,
          }}
        />
      )}

      {selectedId && cardById.get(selectedId) && (
        <div
          className="bd-selbox"
          style={{
            left: cardById.get(selectedId).x * view.s + view.tx,
            top: cardById.get(selectedId).y * view.s + view.ty,
            width: cardById.get(selectedId).w * view.s,
            height: cardById.get(selectedId).h * view.s,
          }}
        />
      )}

      {/* 收事件的那一层放在最上面，盖住 canvas 和 svg。
          卡片（DOM）是它的兄弟、z-index 更高，所以点卡片不会被这层吃掉。 */}
      <div
        className="bd-hit"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      />
    </div>
  )
}

/* drawStroke / wFromPressure / MIN_STEP 都搬去了 lib/ink.js。
 *
 * 为什么必须搬：手写识别要把选中的笔迹渲染成 PNG 发出去，而那个模块
 * （lib/ocr.js）是纯 JS —— 它不该 import 一个 JSX 文件，否则 OCR 就变成
 * "必须跑 React 才能测"的东西。
 *
 * ⚠ 搬的时候留了副本，同时 Board.jsx 的 import 又被删掉了，于是出现
 *   `ReferenceError: drawStroke is not defined` —— 笔完全点不动。
 *   所以这里**不再保留任何副本**：同一个函数只有一个定义处，
 *   要用就来 import。宁可多一行 import，也不要两份实现（改一份忘一份，
 *   或者一份被删一份还在用，都是这种半夜排查的 bug）。 */
export { drawStroke, MIN_STEP, wFromPressure } from '../lib/ink.js'
