import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { relationCurve } from '../lib/geometry.js'
/* 关系的词表在 link-kinds.js（board.js 不再转发）。 */
import { LINK_DELETE, LINK_KINDS } from '../lib/link-kinds.js'
import { applyViewTo, viewTransformAttr, worldLenToScreen, worldRectToScreen, worldToScreen } from '../lib/view.js'
import { drawStroke } from '../lib/ink.js'
import { shapeHandlePoints } from '../lib/shape-object.js'
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

/* 选区动作那排（.bd-inkacts）两边各留的呼吸（**屏幕像素**）——
   和 `.bd-cbar` 的 left: 12 一个量级（那个数在 styles.css 里）。
   ★ 2026-09-19：这里原来还有 `INKACTS_PANEL_W = 320` / `INKACTS_PANEL_RIGHT = 14`
     一对常量，用来扣掉压在图右边的**关系面板**。面板整块删掉了，画布现在从左边栏
     一直铺到窗口右缘 —— 于是"可用宽度就是 size.w"，那一对常量和它们那一串
     分支判断（全屏 / 摆法 C / 面板收起来了）一起删掉。
     ⚠ 以后 **再往浮动的东西上摆按钮**（面板、抽屉、侧栏），别忘了回来扣它那一段宽度：
     浮层 z-index 一高，按钮就是"看得见、点不到"（README 第 13 条踩过三次）。 */
const INKACTS_GAP = 12

export default function BoardCanvas({
  sceneRef, liveRef, view, size, strokes, relations, cardById, cardsForInk,
  eraserAt, onPointerDown, onPointerMove, onPointerUp,
  lasso, inkBox, inkHasStrokes = false, onDeleteInk, onBeautifyInk, onFormulaInk, onCopyInk, inkFrame = null, onKeepFrame, onDissolveFrame,
  /* 常用形状规整（见 lib/shapes.js）：`shapeHits` 是"框住的笔里认出哪些形状"，
     非空才显示「◯ 规整」那颗 —— 「认不出来就不出现」是这一族的铁律，
     而判"认不认得出"的地方在 shapes.js，这里只消费结果。 */
  shapeHits = [], onRegularizeInk,
  /* ★★ 选区手柄（见 lib/selection.js 的 `transformPick`）：`pickTarget` 对**任意选区**
     都非空（`{ ids, cardIds, box }`，box 是世界包围盒 —— 笔迹和框进来的卡片合起来那个），
     有它才画那 4 个角柄 + 1 个旋转柄。
     用户 2026-09-19：「你可以对图形放大缩小修正真正形状」→ 那时它只在"框住的正好是
     一个规整过的图形"时出现；2026-09-21：「框选中任意的字迹——卡片都应该能够放大，
     旋转，这点类似 onenote」→ 现在几笔字、一坨乱涂、框进来的卡片都算"一个东西"。
     ⚠ 判"框住了什么、框有多大"的地方在 `Board.jsx` + `selection.js`，这里只消费结果 ——
       和上面 `shapeHits` 同一条分工：**价值判断住在 lib / Board，画布只管画**。
     ⚠ 手柄**必须验 elementFromPoint**（README 第 13 条踩过三次：卡片 / 美化 / 复制）：
       它们钉在包围框四角上，屏幕右缘和关系面板（z-index 20）会盖住右边那两个。 */
  pickTarget = null, onPickScale, onPickRotate,
  links = [], selLink = null, linkPick = null, onPickLink, onApplyLink, onLinkHover,
  /* 板框（见 ADR-0001）：`frames` 是 [{frame, box}]（box 是按成员现算的框线，世界坐标）。 */
  frames = [], frameEditId = null, selectedFrameId = null,
  onFrameSelect, onFrameDragStart, onFrameDrag, onFrameDragEnd, onFrameEdit, onFrameTitle, onFrameEditClose,
  /* 卡片那一层（.bd-world）的容器。外面（Board.jsx）会在手势里直接给它写一条
     "补正"变换 —— 为什么需要、为什么必须同步写，见 Board.jsx 的 syncViewCorrection。 */
  worldRef,
  /* ★ 墨迹画完之后叫这一下（把"画出来了的那一版视图"交给外面）。
     为什么非得由**这里**来叫：补正的基准是"屏幕上**画出来了**的那一版"，
     而"画完了"这件事只有这里知道。在外面猜"React 提交完就等于画完了"是错的 ——
     提交之后卡片确实到位了，可墨迹还是上一版，两边照样差一步（第一版就是这么半截修的）。
     ⚠ 它必须由下面的 **layout** effect 来叫（绘制之前），不能等 passive effect ——
       那样"补正 + 新位置叠在一起"的那一帧会被真画出来，就是用户看到的滑动。 */
  onViewDrawn,
  children,
}) {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2.5, window.devicePixelRatio || 1)

  /* 选区那排动作（.bd-inkacts）自己的 DOM —— 量它有多宽，用来把它夹在画布内。
     为什么要量实际宽度：那一排的宽度取决于**有哪几颗按钮**（框住的东西是不是板框、
     以后还会不会再加），写死一个数就会"加一颗按钮又点不到"。
     ⚠ 宽度只能在挂上之后才量得到，所以量到就 setState 一次逼一次重渲染 ——
       不这么做的话，第一次渲染量到的是 0，那一帧的 left 还是没夹住的旧值，
       而这排浮层出现之后 React 不一定会再渲染（症状是"夹取有时灵有时不灵"）。 */
  const [inkActsW, setInkActsW] = useState(0)
  const inkActsRef = (el) => {
    if (!el) return
    const w = el.offsetWidth
    setInkActsW((prev) => (prev === w ? prev : w))
  }

  // ── 下面那层：已提交的笔迹 ──
  /* ★ 是 `useLayoutEffect`，不是 `useEffect`：canvas 的 `setTransform` 和 DOM 的
     `left/top` 必须在**同一帧绘制之前**都到位，否则两组东西各差一步（见文件头那段）。
     `useEffect` 在浏览器画完之后才跑，那一帧的墨迹就是旧的 —— 这正是"相对滑动"的一半。 */
  useLayoutEffect(() => {
    const cv = sceneRef.current
    /* 这一趟画完就把"画出来了的那一版"报给外面：补正以它为基准。
       ⚠ 放在 `return` **之前**不行 —— 没画（尺寸还是 0）就别说"画好了"，
         否则补正会以为屏幕上已经是新视野了。 */
    const done = () => {
      if (onViewDrawn) onViewDrawn(view)
    }
    if (!cv || !size.w || !size.h) {
      done()
      return
    }
    const ctx = cv.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cv.width, cv.height)
    const xform = applyViewTo(ctx, view, dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of strokes) drawStroke(ctx, s)
    /* 把"这一层收到了什么"写在 DOM 上。
       为什么值得占一行代码：白板"画了看不见"的原因太多了（容器高度为 0、
       变换把内容推到屏幕外、dpr 没乘、笔迹为空……），光看画面全是"一片空白"。
       有这三个数，一眼就能分清是"没送进来"还是"送进来了没画出来"。
       scripts/check-board-browser.js 会读它们。
       ★ 这三个数是 `applyViewTo` **返回的**（就是真写进 canvas 的那三个），
         不是这里再算一遍 —— 免得诊断数字和实际变换各说各话。 */
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
    cv.dataset.xform = `${xform.s},${xform.tx},${xform.ty}`
    done()
  }, [strokes, view, size.w, size.h, dpr, sceneRef, onViewDrawn])

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
      {/* ★ `data-view-follow` = "这一层的位子由视野决定，补正也贴在它身上"
          （Board.jsx 的 `syncViewCorrection` 按这个属性找它们）。
          两层 canvas（墨迹）和两层 SVG（连线 / 词 / 尖）都要有 ——
          只补卡片那一半的话，两边还是差一步，只是把"卡片快一帧"换成"墨迹慢一帧"，
          肉眼看还是滑动（见 Board.jsx 那段说明）。

          这些层都是**铺满整个舞台**的位图/矢量，所以给它们挂 CSS 变换是安全的：
            · 尺寸和原点没变，只是把"还没重画的那一版"先挪到位；
            · 下一帧重画出来，变换就被撤掉，不会攒下偏移。
          ⚠ 用笔写字的时候例外：那时 `paintLive` 要按屏幕坐标反算世界坐标，
            挂着一个非单位变换会把落点算歪 —— 所以**按下笔的那一刻会先把补正清掉**
            （Board.jsx 的 `onPointerDown`，`clearViewCorrection`）。 */}
      <canvas
        ref={sceneRef}
        className="bd-ink"
        data-view-follow="1"
        width={Math.max(1, Math.round(size.w * dpr))}
        height={Math.max(1, Math.round(size.h * dpr))}
        style={{ width: size.w, height: size.h }}
      />

      {/* 卡片之间的连线。画在墨迹**上面**、卡片**下面**：
          这样线被卡片挡住两端，看起来是"连着卡片"而不是"穿过卡片"。 */}
      <svg
        className="bd-edges"
        data-view-follow="1"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        style={{ width: size.w, height: size.h }}
      >
        <g transform={viewTransformAttr(view)}>
          {relations.edges.map((e) => {
            const a = cardById.get(e.a)
            const b = cardById.get(e.b)
            if (!a || !b) return null
            const inked = cardsForInk.has(e.a + '|' + e.b) || cardsForInk.has(e.b + '|' + e.a)
            /* ⚠ 这里原来还有一个 `hot`（悬停时把那一条加亮）—— 它的唯一触发者是
               关系面板里那些行的 mouseenter，面板删掉之后它没有触发者了（2026-09-19）。 */
            const { a: pa, b: pb, c } = relationCurve(a, b, e.kind === 'near' ? 0.1 : 0.2)
            const cls = 'bd-edge' + (inked ? ' inked' : '')
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
      <div className="bd-world" ref={worldRef}>
        {/* ── 板框：你亲手留下的一个整体（见 ADR-0001、frames.js）──
            ★ 它在卡片**下面**：框是"这一块区域的记号"，不该盖住里面的内容。
              实现靠的是 DOM 顺序（同一层里先画的在下面）—— 不靠 z-index 数值，
              免得和"卡片要压过 .bd-hit(5)"那条规矩打架（见 .bd-world 那段说明）。
            ★ 只有顶上那颗标题小按钮收指针事件：那是这个框唯一的把手
              （拖动 = 挪整个框、双击 = 改名）。框线本身不吃事件 ——
              不然你在框里写字、框卡片的时候会一直被它挡着。 */}
        <div className="bd-framelayer">
          {frames.map((it) => (
            <Frame
              key={it.frame.id}
              frame={it.frame}
              box={it.box}
              view={view}
              editing={it.frame.id === frameEditId}
              selected={it.frame.id === selectedFrameId}
              onSelect={() => onFrameSelect?.(it.frame.id)}
              onStartDrag={() => onFrameDragStart?.(it.frame.id)}
              onDrag={(dx, dy) => onFrameDrag?.(it.frame.id, dx, dy)}
              onDragEnd={() => onFrameDragEnd?.(it.frame.id)}
              onEdit={() => onFrameEdit?.(it.frame.id)}
              onTitle={(t) => onFrameTitle?.(it.frame.id, t)}
              onCloseEdit={() => onFrameEditClose?.()}
            />
          ))}
        </div>
        {children}
      </div>

      {/* 正在画、还没提交的那一笔 */}
      <canvas
        ref={liveRef}
        className="bd-live"
        data-view-follow="1"
        width={Math.max(1, Math.round(size.w * dpr))}
        height={Math.max(1, Math.round(size.h * dpr))}
        style={{ width: size.w, height: size.h }}
      />

      {eraserAt && (
        <div
          className="bd-eraser"
          style={{
            ...worldToScreen(eraserAt, view),
            /* 圈的半径是世界坐标（`eraseAt` 那边用 screenLenToWorld 算的），
               这里乘回屏幕 —— 走 view.js 那一处，别自己乘 s。 */
            width: worldLenToScreen(2 * eraserAt.r, view.s),
            height: worldLenToScreen(2 * eraserAt.r, view.s),
          }}
        />
      )}

      {/* 笔杆键拖出来的框选矩形（世界坐标 → 屏幕坐标） */}
      {lasso && (
        <div
          className="bd-lasso"
          style={(() => {
            const box = worldRectToScreen(lasso, view)
            return { ...box, width: Math.max(1, box.width), height: Math.max(1, box.height) }
          })()}
        />
      )}

      {/* 框选出来的那组墨迹：一个虚线包围框 + 「美化」和「删除」两个按钮。
          用笔的人不一定腾得出手按 Delete 键，也不一定够得到工具条，
          所以这两个动作必须放在手边。
          删除按钮靠 transform 把"右下角"对齐到包围框的右上角，这样位置自动跟着框走，
          不用去量按钮自己的宽高（按钮宽度会随界面字号变）。
          「美化」放在包围框**左下角下面**：它是这条路上最主要的动作（字丑才来框的），
          而右上角已经被删除占了；放下面也不会和右上角那个撞在一起。 */}
      {inkBox && (
        <>
          <div
            className="bd-inkbox"
            /* data-pad 就是上面那个 INK_PAD：这个虚线框比**真实笔迹范围**每边大出这么多。
               自检要判断"卡片有没有盖住笔迹"就得把这一圈让出去，
               而它不该在自检里再抄一份数字（抄一份就是两处会各自变的常量）。 */
            data-pad={INK_PAD}
            style={worldRectToScreen(inkBox, view, INK_PAD)}
          />
          {/* 四个动作摆在**一条横排**里、钉在包围框上方（translateY(-100%)）。
              ★ 原来是各自绝对定位的：删除在右上角、美化在**左下角的外面**。
                自检当场抓到美化那个点不到 —— 它落在屏幕下半部分，
                而底部工具条（z-index 20）横在那一带，用户按下去只是在戳工具条。
                教训和「卡片点不到」那次一样：**浮出来的按钮必须验 elementFromPoint**，
                而且别把它放在"可能被别的东西占着"的地方（屏幕下缘就是那种地方）。
              横排还顺手解决了另一件事：几个按钮永远不会互相重叠
              （各自绝对定位时，选框一窄就会叠在一起）。
              ★ 「∑ 公式」和「✨ 美化」是同一件事的两半：认式子、认字。
                用户 2026-09-16 说"公式也该能框出来认，不用先在写字板里重写一遍"。
              ★★ 横排**要夹在画布宽度里**（2026-09-18 加「⧉ 复制」时暴露的）：
                这一排是"从选区左边缘往右展开"的，所以选区块越靠右、排得越长，
                右端就越可能伸出画布。
                症状是**左边那几颗点不到**（右边那几颗把它们顶出去了）。
                这里按可用宽度反推一个 left：整排装得下就贴选区左边缘，
                装不下就往左挪，保证**最右边那一段**一定在画布内。
                （量宽度用 offsetWidth —— 它就是这一排的实际占宽，含 gap。）

                ★ 可用宽度**就是** size.w：关系面板（那是块压在画布上的 320px 浮层）
                  2026-09-19 整块删掉了，白板从头到尾只有两列（左栏 + 画布），
                  所以 size.w 就是画布真正的宽度，两边各留一点呼吸即可。
                  ⚠ 那段"扣掉面板"的分支（全屏 / 面板收起来了 / 摆法 C）跟着一起删了 ——
                  历史上 check-link 的 [10] 抓到过"框住右边一块时「▣ 留下板框」的中心
                  命中到了面板里的一行"，那件事的前提已经不存在了。 */}
          <div
            className="bd-inkacts"
            ref={inkActsRef}
            style={(() => {
              const box = worldRectToScreen(inkBox, view, INK_PAD)
              const w = inkActsW || 0
              const avail = (size && size.w ? size.w : 0) - INKACTS_GAP * 2
              const maxLeft = Math.max(INKACTS_GAP, avail)
              let left = box.left
              if (w && left + w > maxLeft) left = maxLeft - w
              return { left: Math.max(INKACTS_GAP, left), top: box.top }
            })()}
          >
            {/* ★ 这三颗只在**框里有笔迹**时出现（`inkHasStrokes`）。
                2026-09-21 起卡片也能被框进来 —— 只框住一张卡时，
                "认公式 / 美化 / 规整"三种都无从谈起（点下去只会得到一句"先框住一块手写"）。
                一排按钮里摆着三颗必然失败的，是比"少一颗"更糟的界面。
                （虚线框、手柄、删除、复制、留下板框照旧都在。） */}
            {inkHasStrokes && (
              <button
                className="bd-inkformula"
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => {
                  e.stopPropagation()
                  onFormulaInk()
                }}
                title="识别公式：把圈住的这一块认成一个式子，排成公式卡（一次认一个）"
              >
                ∑ 公式
              </button>
            )}
            {inkHasStrokes && (
              <button
                className="bd-inkfmt"
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => {
                  e.stopPropagation()
                  onBeautifyInk()
                }}
                title="美化手写：把这一块认成文字，用好看的字体排成一张卡（原笔迹保留）"
              >
                ✨ 美化
              </button>
            )}
            {/* ★★ 规整形状（2026-09-18，用户原话："我画个圆他给我优化成真正的圆形，
                直线也是还有常用的矩形，三角形都能自动优化"）。
                ★ 它是**条件出现**的：框里一笔形状都没认出来时，这颗按钮**不在**。
                  那是这一族最重要的交互设计 —— 按钮出现 = "我看出来这儿有形状"，
                  没看成就不打扰（画的是字的人不会看到一个点下去没反应的按钮）。
                ★ 为什么排在「美化」和「复制」之间：左半排都是"给这一块**换一副样子**"
                  （ fórmulas / 美化 / 规整），右半排是"把它带走 / 干掉"。它属于左边那族。
                ★ 长得和邻居不一样（描边、不填色）是有意的：它不产生新东西
                  （不像公式卡、文字卡），只是把**你原来画的**那一笔弄直、弄圆。
                  实心按钮会让人以为"这儿会多/少一样东西"，描边说的才是实话。 */}
            {inkHasStrokes && shapeHits.length > 0 && (
              <button
                className="bd-inkshape"
                /* ⚠ `h.shape.kind` 而**不是** `h.kind` —— recognizeStrokes 返回的是
                   `{ id, shape, label }`，形状本身住在 `shape` 里（label 是给人看的名字）。
                   写成 `h.kind` 不会报错，只会得到一个空字符串属性 ——
                   而那正是自检要读的那个数（`data-ink-shape=""` 看着像"属性没写"）。 */
                data-ink-shape={shapeHits.map((h) => (h.shape && h.shape.kind) || '').join(',')}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => {
                  e.stopPropagation()
                  onRegularizeInk?.()
                }}
                title={
                  `规整形状：把认出来的这几笔换成规整的（${[...new Set(shapeHits.map((h) => h.label))].join('、')}）`
                  + ' —— 认不出来的那几笔原样不动，Ctrl+Z 能退回手写的样子'
                }
              >
                ◯ 规整{shapeHits.length > 1 ? ` ${shapeHits.length}` : ` ${shapeHits[0].label}`}
              </button>
            )}
            {/* ★ 复制（2026-09-18）。放在「美化」和「删除」之间：
                它不是"改造这一块"，而是"把这一块带走"—— 和右边那个删除一样是
                对整块的操作，但它比删除安全，所以排在删除**前面**（误按的代价差很多）。
                也按 Ctrl+C，那才是熟练用户走的路；这颗按钮是给笔用户和
                "不知道有快捷键"的人留的（用户原话："框选后加入复制功能"）。 */}
            <button
              className="bd-inkcopy"
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
              onClick={(e) => {
                e.stopPropagation()
                onCopyInk?.()
              }}
              title="复制这一块（也能按 Ctrl+C）—— 切到别的白板按 Ctrl+V 贴上去"
            >
              ⧉ 复制
            </button>
            <button
              className="bd-inkdel"
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
              onClick={(e) => {
                e.stopPropagation()
                onDeleteInk()
              }}
              title="删掉选中的这几笔（也可以按 Delete）"
            >
              ✕ 删除
            </button>
            {/* ★ 框住的**正好是一个板框里的笔**时，按钮变成「拆开这个框」。
                一个成员只能属于一个框（见 frames.js），所以"两块各自留下 = 把它们拆开"
                这条老规矩原样成立 —— 只是现在它有脸了。 */}
            {inkFrame ? (
              <button
                className="bd-inkgroup"
                data-ink-group="off"
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => {
                  e.stopPropagation()
                  onDissolveFrame?.()
                }}
                title="拆开这个框：里面的东西照旧留在板上（这个框不再是一个整体）"
              >
                ▣ 拆开这个框
              </button>
            ) : (
              <button
                className="bd-inkgroup"
                data-ink-group="on"
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => {
                  e.stopPropagation()
                  onKeepFrame?.()
                }}
                title="留下板框：圈住的这些东西从这一刻起是一个整体（可以整体拖动、起个名字）"
              >
                ▣ 留下板框
              </button>
            )}
            {/* ★ 框住的**正好是一条连接线**时，多给一排词。
                这是"事后改词"的路：画完那 3.5 秒没点、或者后来改主意了，
                框住那条线就能再改一次 —— 不用把线擦掉重画。
                （框选本来就是这条路：圈住东西 → 框上方浮出能对它做的事。） */}
            {selLink && (
              <span className="bd-inklink" data-sel-link={selLink.strokeId || selLink.id}>
                {LINK_KINDS.map((k) => (
                  <button
                    key={k.id}
                    className={'bd-linkchip' + (k.id === selLink.kind ? ' on' : '')}
                    data-link-kind={k.id}
                    style={k.id === selLink.kind ? { background: k.color, borderColor: k.color, color: '#fff' } : { color: k.color, borderColor: k.color }}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                    onClick={(e) => {
                      e.stopPropagation()
                      onApplyLink?.(selLink, k.id)
                    }}
                    title={k.hint}
                  >
                    {k.name}
                    {k.dir ? ' →' : ''}
                  </button>
                ))}
                {selLink.dir && (
                  <button
                    className="bd-linkchip rev"
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                    onClick={(e) => {
                      e.stopPropagation()
                      onApplyLink?.(selLink, selLink.kind, { reverse: true })
                    }}
                    title="方向反一下"
                  >
                    ⇄
                  </button>
                )}
                {/* 「删掉这条连接」（2026-09-17 第二刀，见 ADR-0001）：
                    它顶掉了从前那个「不算连接」。框住那条线 = "我就是要动这一条"，
                    所以这颗按钮在这儿比在别处都顺手。 */}
                <button
                  className="bd-linkchip none"
                  data-link-kind={LINK_DELETE}
                  onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onApplyLink?.(selLink, LINK_DELETE)
                  }}
                  title="删掉这条连接：你连的删那条记录、你画的删掉那一笔（Ctrl+Z 能退回）"
                >
                  删掉这条连接
                </button>
              </span>
            )}
            {/* 「又算回连接」那一块第二刀删掉了（ADR-0001）：它的前提是"形状判读会猜错"，
                而形状判读整族已经删掉。现在"这条连错了"只有一句话：那排词里 `0` 那颗
                「删掉这条连接」。 */}
          </div>
        </>
      )}

      {/* ★★ 选区手柄（2026-09-21 起对**任意选区**都画）：四个角柄拖了缩放、右边中点那颗转。
          `pickTarget` 一非空就有 —— 几笔字、一坨乱涂、框进来的卡片都算"一个东西"
          （见 lib/selection.js 的 `transformPick`）。
          ⚠ `inkHasStrokes` 是给「∑ 公式 / ✨ 美化 / ◯ 规整」那三颗按钮用的：
            框里**一笔字迹都没有**（只框住了一张卡）时它们没有意义，
            画出来只会得到一句"先框住一块手写"。 */}
      {pickTarget && (
        <PickHandles target={pickTarget} view={view} onScale={onPickScale} onRotate={onPickRotate} />
      )}

      {/* ★ 这里原来还有一个"选中卡片"的蓝色虚线框（.bd-selbox），2026-09-16 删掉了。
          两个理由，第二个才是决定性的：
            ① 卡片自己被选中时已经是**实线蓝边 + 一圈光晕**（.bd-card.on），
               再套一个虚线框是重复的装饰；
            ② 它算错了 —— 那个框只乘了画布缩放 view.s、**漏了卡片自己的倍率**
               （卡片的宽高是 w * view.s * k，k 是"这张卡自己放大缩小了多少"）。
               实测这张卡 scale=4：卡片 190px 宽，虚线框只有 47.5px，缩在左上角，
               看着就是"卡片角上莫名多了个蓝框"（用户 2026-09-16 报的
               「蓝色虚线框不美观」就是这个）。倍率不是 1 的卡全都会错，
               而拖右下角放大正是这个应用的主要操作之一。
          记法：**同一个矩形在两处各算一遍，就一定会有一处忘了乘别的东西。** */}

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

      {/* ── 画出来的连接：一颗词 +（有方向的）一个箭头 ──
       * 用户 2026-09-16：「更便捷的显示出两者之间的主次、因果、并列」。
       *
       * ★ 只有**标过词**的连接才画标记（`kind !== 'rel'`，或者你手动选了"相关"）。
       *   默认那一档什么都不加：你画的那一笔本来就是它该有的样子，
       *   我们不该在你的手迹上再描一遍（描了反而像"这线有两根"）。
       * ★ **自己画过尖的不再合成箭头**（`l.headInk`）：实测他的箭头是"杆一直画到尖上、
       *   V 尖是单独一笔"，屏幕上那个尖已经在那儿了 —— 再叠一个合成的小箭头，
       *   看起来就是"一支箭上长了两个头"（而且位置会落在杆的末端、压在 V 里面）。
       * ★ 这一层在**墨迹上面**（z-index 10，见 CSS）：标记被笔迹盖住就白做了。
       *   命中：只有那颗词收指针事件，箭头是 pointer-events: none ——
       *   不然画一笔穿过线的时候会被它挡一下。 */}
      <div className="bd-linklayer" data-view-follow="1">
        <svg
          className="bd-linksvg"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          /* ★ 这两个读数是给自检看的，和 `canvas.bd-ink` 的 `data-strokes` 同一条路：
             关系面板删掉（2026-09-19）之后，"这一刻板上有几条连接、分别是什么词"
             就**没有别的地方可读了** —— 画布上默认那一档「相关」连词都不画，
             数屏幕上的词等于在数"哪几条被标过词"，不是"有几条连接"。
             让渲染这一层如实报出它拿到了什么，比让自检去猜可靠得多。
             ⚠ 顺序就是 `links` 的顺序：自检按下标比 kinds[0] 的那些断言靠它；
               放的是**词的名字**（「因果」），不是 kind id —— 自检比的是人话。 */
          data-links={links.length}
          data-link-kinds={links.map((l) => l.name).join(',')}
        >
          {/* ★ 宣告的连接：**那条线是应用画的**（见 ADR-0001）。
              你划的那一笔只是"指了哪两样东西"，屏幕上这条规整的线 + 那个尖才是关系的样子 ——
              两端贴在框/卡的边上、位置每次现算，所以框一动它就跟着走。
              （画出来的连接不走这儿：那条线本来就是你的墨迹，不该再被描一遍。） */}
          {links
            .filter((l) => l.declared)
            .map((l) => {
              const a = worldToScreen(l.from, view)
              const b = worldToScreen(l.to, view)
              const c = worldToScreen(l.ctrl || { x: (l.from.x + l.to.x) / 2, y: (l.from.y + l.to.y) / 2 }, view)
              return (
                <path
                  key={'ln' + l.id}
                  data-link-line={l.id}
                  d={`M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`}
                  fill="none"
                  stroke={l.color}
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              )
            })}
          {links
            .filter((l) => l.dir && !l.headInk)
            .map((l) => {
              const { x: ax, y: ay } = worldToScreen(l.to, view)
              const r = 10
              const a1 = l.angle + Math.PI - 0.5
              const a2 = l.angle + Math.PI + 0.5
              return (
                <path
                  key={'ah' + (l.id || l.strokeId)}
                  /* 宣告的连接没有 `strokeId`（null）—— React 会把 null 的属性整个删掉，
                     于是这个尖在 DOM 里就没法被选中（自检和"哪一个尖"都要它）。 */
                  data-link-arrow={l.declared ? l.id : l.strokeId}
                  d={`M ${ax + r * Math.cos(a1)} ${ay + r * Math.sin(a1)} L ${ax} ${ay} L ${ax + r * Math.cos(a2)} ${ay + r * Math.sin(a2)}`}
                  fill="none"
                  stroke={l.color}
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )
            })}
        </svg>
        {links
          .filter((l) => l.kind !== 'rel' || l.manual)
          .map((l) => {
            /* 词放在线的**旁边**（沿法线让开 16px），不是正中间 ——
               线的中段常常写着你顺手写的条件（"仅当…"），压上去就挡住了。 */
            const at = worldToScreen(l.mid, view)
            const mx = at.x + -Math.sin(l.angle) * 16
            const my = at.y + Math.cos(l.angle) * 16
            return (
              <button
                key={'pill' + (l.id || l.strokeId)}
                className="bd-linkpill"
                data-link-kind={l.kind}
                data-link-stroke={l.strokeId || undefined}
                /* 宣告的连接那颗词：自检和"删掉这条连接"都靠它认出来（`strokeId` 是 null）。 */
                data-link-pill={l.declared ? l.id : undefined}
                style={{ left: mx, top: my, color: l.color, borderColor: l.color }}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => {
                  e.stopPropagation()
                  onPickLink?.(l)
                }}
                title={l.declared ? '你连的关系：点一下可以改词 / 删掉' : l.manual ? '你点过词的关系：点一下可以改' : '你画的一条线（默认「相关」）：点一下可以改'}
              >
                {l.name}
                {l.dir ? ' →' : ''}
              </button>
            )
          })}
        {linkPick && (
          <LinkChips
            at={linkPick}
            onPick={(kind) => onApplyLink?.(linkPick, kind)}
            onReverse={() => onApplyLink?.(linkPick, linkPick.kind, { reverse: true })}
            onHover={onLinkHover}
          />
        )}
      </div>
    </div>
  )
}

/* 画完一条连接之后浮出来的那排词（见 Board.jsx 的 offerLink）。
 * 它是**可选**的一步：不点也什么都有（连接早成立了，形状也读出来了），
 * 点了就是把那个词钉成你要的。3.5 秒不点自己收走，指针停在上面就不收。
 * 键盘 1~5 也能选（Board.jsx 的 onKey 里），鼠标用户不用去点这一小排。 */
function LinkChips({ at, onPick, onReverse, onHover }) {  return (
    <div
      className="bd-linkchips"
      data-link-pick={at.id || at.strokeId}
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      onPointerEnter={() => onHover?.(true)}
      onPointerLeave={() => onHover?.(false)}
    >
      <span className="bd-linkchips-t">这条线是</span>
      {LINK_KINDS.map((k, i) => (
        <button
          key={k.id}
          className={'bd-linkchip' + (k.id === at.kind ? ' on' : '')}
          data-link-kind={k.id}
          style={k.id === at.kind ? { background: k.color, borderColor: k.color, color: '#fff' } : { color: k.color, borderColor: k.color }}
          onClick={(e) => {
            e.stopPropagation()
            onPick(k.id)
          }}
          title={`${k.hint}（按 ${i + 1}）`}
        >
          {k.name}
          {k.dir ? ' →' : ''}
        </button>
      ))}
      {at.dir && (
        <button
          className="bd-linkchip rev"
          data-link-rev="1"
          onClick={(e) => {
            e.stopPropagation()
            onReverse()
          }}
          title={at.declared ? '方向反一下：把两端对调（箭头换一边）' : '方向反一下：把这一笔的起止倒过来（渲染出来一模一样，只是箭头换一边）'}
        >
          ⇄
        </button>
      )}
      {/* `0` 那颗：**删掉这条连接**（2026-09-17 第二刀）。
          它顶掉了从前那个「不算连接」—— 那个口子是给"猜错了"配的否决权，
          而形状判读整族已经删掉了；这颗位置本来就在手边。 */}
      <button
        className="bd-linkchip none"
        data-link-kind={LINK_DELETE}
        onClick={(e) => {
          e.stopPropagation()
          onPick(LINK_DELETE)
        }}
        title="删掉这条连接（按 0）：你连的那条删记录，你画的那条删掉那一笔 —— 都能 Ctrl+Z 退回"
      >
        删掉这条连接
      </button>
      <span className="bd-linkchips-x">不点也行</span>
    </div>
  )
}

/* ── 选区的四个角柄 + 一个旋转柄（见 lib/selection.js 的 `transformPick`）──
 *
 * 用户 2026-09-19：「你可以对图形放大缩小修正真正形状」——手柄是这件事的**入口**：
 * 没有它，规整出来的图形就只是"一堆摆得很正的点"，只能擦掉重画。
 * 用户 2026-09-21：「框选中任意的字迹——卡片都应该能够放大，旋转，这点类似 onenote」
 * ——所以它不再只服务图形：**框住什么就画在什么上**（几笔字、一坨乱涂、卡片）。
 *
 * ★ 位置全部由 `shapeHandlePoints(box)` 给（世界坐标），这里只做"世界 → 屏幕"。
 *   ⚠ box 是**选区的包围盒**（`pickBox`：笔迹的点 ∪ 卡片的可视外框），
 *     这样它和 `.bd-inkbox`（选中那圈虚线）是同一个框，手柄永远贴着它。
 *     两个矩形各算一遍是这个仓库记了十几条的账（README 第 15/16 条、ADR-0002）。
 *
 * ★ 尺寸是**屏幕像素**、不跟缩放走（和卡片四角那几颗手柄同一个规矩）：
 *   跟缩放走的话，缩到 33% 时手柄只有 6px，抓不住。见 ADR-0002 那条"往卡片上再加
 *   任何量之前先问它跟不跟缩放走" —— 手柄属于"不跟"的那一类。
 *
 * ★★ 为什么这里**不自己挂 window 上的 move/up**：
 *   手势整个在 `Board.jsx`（缩放的锚点、旋转的中心、账本 begin/during/end 都在那儿）。
 *   这里只报"你按的是哪一颗"（`data-pick-handle`），一件事只有一份实现。
 *   ⚠ `onPointerDown` 必须 `stopPropagation`：不然这一下会落到下面的 `.bd-hit` 上，
 *     变成"在选区上又落一笔墨"（卡片那几个手柄也是这么办的）。
 *   ⚠ **不要 setPointerCapture**：捕获之后 move/up 全被重定向到这个 14px 的小方块上，
 *     而 Board 那边的监听器挂在 window 上 —— 拖动会时灵时不灵（README 坑 #7 是同一个错）。
 *   ⚠ 名字里的 `data-pick-*` 是**自检的钩子**（`check-shape` 的 [12c]/[12i]/[12j]
 *     靠它问"按下去到底有没有到这颗柄上"）。它从前叫 `data-shape-handle` ——
 *     改名是因为手柄已经不只服务图形了；改的时候**自检和样式一起改**，
 *     不然"看得见、抓不住"这种错会静默地回来。 */
function PickHandles({ target, view, onScale, onRotate }) {
  if (!target) return null
  const pts = shapeHandlePoints(target.box)
  /* 每个柄自己的类（data 属性给自检用，类名给样子用）—— 旋转柄长得和角柄不一样，
     它是圆的、摆在右边中点（见 shapeHandlePoints 的注释）。 */
  return (
    <div
      className="bd-pickhandles"
      /* `data-pick-handles` 报**这一撮是哪些东西**（笔迹 id，逗号分隔）——
         自检要问的第一个问题是"手柄认的是不是我框住的那一撮"。
         卡片不列进来：笔迹 id 才是能和夹具对上的那个读数（卡片另有一条断言）。 */
      data-pick-handles={target.ids.join(',')}
      data-pick-cards={target.cardIds.join(',')}
      data-last-grab={grabLog.current}
    >
      {pts.map((h) => {
        const at = worldToScreen({ x: h.x, y: h.y }, view)
        const rot = h.id === 'rot'
        return (
          <button
            key={h.id}
            type="button"
            className={'bd-pickhandle' + (rot ? ' rot' : '')}
            data-pick-handle={h.id}
            style={{ left: Math.round(at.x), top: Math.round(at.y) }}
            title={
              rot
                ? '转一下选中的这一块（绕选区中心）—— 手写和卡片一起转'
                : '拖这个角放大缩小（对角那一点不动）—— 横竖分开拉，字会被拉宽、圆会变成椭圆；卡片只等比放大'
            }
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              /* ★ 把"刚才按的是哪一颗"记在 DOM 上（`data-last-grab`）。
                 手柄点不到是这一族最容易踩的坑（README 第 13 条踩过三次），
                 而那时候自检要问的第一个问题是"按下去到底有没有到这颗柄上"。
                 记在 DOM 上而不是 `console.log`：自检那套 console 收集**不是每个脚本都开着**的
                 （`check-shape` 只收它注册之后打的日志），而 DOM 属性任何自检都读得到。 */
              grabLog.current = h.id + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)
              if (rot) onRotate?.()
              else onScale?.(h.id)
            }}
            /* 双击别落到纸上（在选区上双击会取消选中，手柄跟着消失、拖到一半没了）。 */
            onDoubleClick={(e) => e.stopPropagation()}
          />
        )
      })}
    </div>
  )
}

/* 「刚才按的是哪一颗手柄」—— 只给自检当证据用（见上面那段）。
   用普通对象而不是 state：它不该触发重渲染（那是"诊断"，不是"状态"）。
   ★ 为什么值得留在生产代码里：`pointerdown` 到底有没有落到那颗小按钮上，
     是这一族最容易踩的坑（README 第 13 条踩过三次），而"按到谁身上了"这件事
     **只有 DOM 说得清** —— 屏幕上看，"没按到"和"按到了但手势没算"一模一样。 */
const grabLog = { current: '' }

/* ── 一个板框（见 ADR-0001、frames.js）──
 *
 * 框线是**算出来的**：成员的包围盒 + 一圈内边距（geometry.js 的 `frameBounds`），
 * 所以内容一挪、框自己跟着走。这就是"框必须是内容的函数"那句设计的落地 ——
 * 也因此它**没有缩放手柄**（尺寸不是第二份真相）。
 *
 * ★ 把手只有顶上那颗标题小按钮，三件事都从它入手：
 *     · 点一下 → 选中这个框（面板里那一行跟着亮）
 *     · 拖它   → 整个框（连同里面的笔迹和卡片）一起挪（frames.js 的 translateFrame）
 *     · 双击它 → 就地改标题（"这一节是什么"）
 *   框线本身**不吃指针事件**（.bd-framelayer 的 pointer-events: none + 这里只给按钮 auto）：
 *   不然你在框里写字、框卡片的时候会一直撞在框线上。
 *   为什么不把标题放在框**里面**：框里是内容的地盘（你随时会往里写东西），
 *   标题压在内容上就永远在挡路；挂在框线上方一点点，两边都清楚。 */
function Frame({ frame, box, view, editing, selected, onSelect, onStartDrag, onDrag, onDragEnd, onEdit, onTitle, onCloseEdit }) {
  const dragRef = useRef(null)
  const inRef = useRef(null)
  const [draft, setDraft] = useState('')
  const at = worldToScreen({ x: box.x, y: box.y }, view)

  useEffect(() => {
    if (!editing) return
    setDraft(frame.title || '')
    const raf = requestAnimationFrame(() => {
      const el = inRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(raf)
  }, [editing, frame.title])

  function commit() {
    if (onTitle) onTitle(draft.trim())
    if (onCloseEdit) onCloseEdit()
  }

  const title = (frame.title || '').trim()
  return (
    <div
      className={'bd-frame' + (selected ? ' on' : '')}
      /* dataset 是给自检看的：框线是算出来的，"这个框围着谁、多大"只有真 DOM 能证明。 */
      data-frame-id={frame.id}
      data-frame-title={title}
      style={{
        left: at.x,
        top: at.y,
        width: Math.max(1, worldLenToScreen(box.w, view.s)),
        height: Math.max(1, worldLenToScreen(box.h, view.s)),
      }}
    >
      {editing ? (
        <input
          ref={inRef}
          className="bd-frame-in"
          value={draft}
          spellCheck={false}
          placeholder="这一节是什么"
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            /* 卡片那边一样的规矩：别让打字触发板上的快捷键（P/E/S… 会切工具）。 */
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (onCloseEdit) onCloseEdit()
            }
          }}
        />
      ) : (
        <button
          className={'bd-frame-t' + (title ? '' : ' dim')}
          data-frame-handle={frame.id}
          title="拖动 = 整个框一起挪 · 双击 = 起个名字（这一节是什么）"
          onPointerDown={(e) => {
            e.stopPropagation()
            if (onSelect) onSelect()
            if (onStartDrag) onStartDrag()
            dragRef.current = { x: e.clientX, y: e.clientY, moved: false }
            e.currentTarget.setPointerCapture?.(e.pointerId)
          }}
          onPointerMove={(e) => {
            const d = dragRef.current
            if (!d) return
            /* 只报**屏幕位移**，换算成世界坐标由 Board 按当前缩放做 ——
               在这个闭包里读 view.s 会读到"按下那一刻"的缩放（卡片拖动踩过这条）。 */
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) return
            d.x = e.clientX
            d.y = e.clientY
            d.moved = true
            if (onDrag) onDrag(dx, dy)
          }}
          onPointerUp={() => {
            if (dragRef.current && onDragEnd) onDragEnd()
            dragRef.current = null
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (onEdit) onEdit()
          }}
        >
          <span className="bd-frame-ico">▣</span>
          {title || '未命名'}
        </button>
      )}
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
export { drawStroke, MIN_STEP_SCREEN, wFromPressure } from '../lib/ink.js'
