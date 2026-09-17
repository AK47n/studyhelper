import React, { useEffect, useRef, useState } from 'react'
import { relationCurve } from '../lib/geometry.js'
/* 关系的词表在 link-kinds.js（board.js 不再转发）。 */
import { LINK_DELETE, LINK_KINDS } from '../lib/link-kinds.js'
import { applyViewTo, viewTransformAttr, worldLenToScreen, worldRectToScreen, worldToScreen } from '../lib/view.js'
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
  hoverEdge, eraserAt, onPointerDown, onPointerMove, onPointerUp,
  lasso, inkBox, onDeleteInk, onBeautifyInk, onFormulaInk, inkFrame = null, onKeepFrame, onDissolveFrame,
  links = [], selLink = null, linkPick = null, onPickLink, onApplyLink, onLinkHover,
  /* 板框（见 ADR-0001）：`frames` 是 [{frame, box}]（box 是按成员现算的框线，世界坐标）。 */
  frames = [], frameEditId = null, selectedFrameId = null,
  onFrameSelect, onFrameDragStart, onFrameDrag, onFrameDragEnd, onFrameEdit, onFrameTitle, onFrameEditClose,
  children,
}) {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2.5, window.devicePixelRatio || 1)

  // ── 下面那层：已提交的笔迹 ──
  useEffect(() => {
    const cv = sceneRef.current
    if (!cv || !size.w || !size.h) return
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
        <g transform={viewTransformAttr(view)}>
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
      <div className="bd-world">
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
          {/* 三个动作摆在**一条横排**里、钉在包围框上方（translateY(-100%)）。
              ★ 原来是各自绝对定位的：删除在右上角、美化在**左下角的外面**。
                自检当场抓到美化那个点不到 —— 它落在屏幕下半部分，
                而底部工具条（z-index 20）横在那一带，用户按下去只是在戳工具条。
                教训和「卡片点不到」那次一样：**浮出来的按钮必须验 elementFromPoint**，
                而且别把它放在"可能被别的东西占着"的地方（屏幕下缘就是那种地方）。
              横排还顺手解决了另一件事：几个按钮永远不会互相重叠
              （各自绝对定位时，选框一窄就会叠在一起）。
              ★ 「∑ 公式」和「✨ 美化」是同一件事的两半：认式子、认字。
                用户 2026-09-16 说"公式也该能框出来认，不用先在写字板里重写一遍"。 */}
          <div
            className="bd-inkacts"
            style={(() => {
              const box = worldRectToScreen(inkBox, view, INK_PAD)
              return { left: box.left, top: box.top }
            })()}
          >
            <button
              className="bd-inkformula"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onFormulaInk()
              }}
              title="识别公式：把圈住的这一块认成一个式子，排成公式卡（一次认一个）"
            >
              ∑ 公式
            </button>
            <button
              className="bd-inkfmt"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onBeautifyInk()
              }}
              title="美化手写：把这一块认成文字，用好看的字体排成一张卡（原笔迹保留）"
            >
              ✨ 美化
            </button>
            <button
              className="bd-inkdel"
              onPointerDown={(e) => e.stopPropagation()}
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
                onPointerDown={(e) => e.stopPropagation()}
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
                onPointerDown={(e) => e.stopPropagation()}
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
                    onPointerDown={(e) => e.stopPropagation()}
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
                    onPointerDown={(e) => e.stopPropagation()}
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
                  onPointerDown={(e) => e.stopPropagation()}
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
      <div className="bd-linklayer">
        <svg className="bd-linksvg" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
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
                onPointerDown={(e) => e.stopPropagation()}
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
function LinkChips({ at, onPick, onReverse, onHover }) {
  return (
    <div
      className="bd-linkchips"
      data-link-pick={at.id || at.strokeId}
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => e.stopPropagation()}
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
          onPointerDown={(e) => e.stopPropagation()}
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
