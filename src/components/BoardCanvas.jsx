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

/* 框选那个包围框往外让出的量（**屏幕像素**，不是世界坐标）。
   给在屏幕这边是为了让留白看起来一样宽 —— 放世界坐标里的话，
   画布一缩放，留白就跟着一起胀缩，选中状态看起来忽胖忽瘦。 */
const INK_PAD = 6
export default function BoardCanvas({
  sceneRef, liveRef, view, size, strokes, relations, cardById, cardsForInk,
  selectedId, hoverEdge, eraserAt, onPointerDown, onPointerMove, onPointerUp,
  lasso, inkBox, onDeleteInk, children,
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
              JS 算坐标就没有这个问题：偏移量直接来自 getBoundingClientRect。

          ★★ 但外面**必须**再套一层 .bd-world —— 它只管叠放（z-index），不管坐标。
             不加这一层的话，卡片是 z-index:auto 的定位元素，而 .bd-hit 是 z-index:5：
             按 CSS 的绘制顺序，**正 z-index 的元素排在所有 z-index:auto 的定位元素后面**
             （也就是更上面），于是 .bd-hit 把卡片整个盖住 ——
             "点卡片" = 在板上落笔，卡片里那个输入框一个字都点不进去。
             2026-09-15 用户报的「点不了，给我识别成写字了，在弹窗上乱涂乱画」
             就是这一条：放上去的卡片进编辑态，但鼠标点上去只会画墨。
             自检当时测不到它：check-board-browser 用 dispatchEvent 合成 dblclick
             （直接投给卡片，**绕过命中测试**），所以"卡片点得到"这条一直是假的绿灯。
             现在那条自检改成用真鼠标点了 —— 见 scripts/check-board-browser.js 第 [5] 节。
             记法：**沾指针的东西，只有真鼠标事件能证明它点得到。** */}
      <div className="bd-world">{children}</div>

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

      {/* 笔杆键拖出来的框选矩形（世界坐标 → 屏幕坐标） */}
      {lasso && (
        <div
          className="bd-lasso"
          style={{
            left: lasso.x0 * view.s + view.tx,
            top: lasso.y0 * view.s + view.ty,
            width: Math.max(1, (lasso.x1 - lasso.x0) * view.s),
            height: Math.max(1, (lasso.y1 - lasso.y0) * view.s),
          }}
        />
      )}

      {/* 框选出来的那组墨迹：一个虚线包围框 + 一个删除按钮。
          用笔的人不一定腾得出手按 Delete 键，所以删除必须放在手边。
          按钮靠 transform 把"右下角"对齐到包围框的右上角，这样位置自动跟着框走，
          不用去量按钮自己的宽高（按钮宽度会随界面字号变）。 */}
      {inkBox && (
        <>
          <div
            className="bd-inkbox"
            style={{
              left: inkBox.x0 * view.s + view.tx - INK_PAD,
              top: inkBox.y0 * view.s + view.ty - INK_PAD,
              width: (inkBox.x1 - inkBox.x0) * view.s + INK_PAD * 2,
              height: (inkBox.y1 - inkBox.y0) * view.s + INK_PAD * 2,
            }}
          />
          <button
            className="bd-inkdel"
            style={{
              left: inkBox.x1 * view.s + view.tx + INK_PAD,
              top: inkBox.y0 * view.s + view.ty - INK_PAD,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDeleteInk()
            }}
            title="删掉选中的这几笔（也可以按 Delete）"
          >
            ✕ 删除
          </button>
        </>
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
