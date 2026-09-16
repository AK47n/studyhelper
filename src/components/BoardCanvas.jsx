import React, { useEffect, useRef } from 'react'
import { relationCurve } from '../lib/board.js'
/* 关系的词表在 link-kinds.js（board.js 不再转发）。 */
import { LINK_KINDS, LINK_NONE } from '../lib/link-kinds.js'
import { applyViewTo, viewTransformAttr, worldRectToScreen, worldToScreen } from '../lib/view.js'
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
  lasso, inkBox, onDeleteInk, onBeautifyInk, onFormulaInk, inkGroup = null, onFreezeInk, onDissolveInk,
  links = [], selLink = null, linkPick = null, onPickLink, onApplyLink, onLinkHover,
  inkNoLink = false, onClearNoLink,
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
            ...worldToScreen(eraserAt, view),
            width: 2 * eraserAt.r * view.s,
            height: 2 * eraserAt.r * view.s,
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
            {/* 固定 / 拆开一块（见 lib/board.js 的 normalizeGroups）。
                自动聚类会把挨得近的两坨并成一块 —— 后果虽然轻（"多连了一个"），
                但你得有地方纠正它：框住一块 → 固定成一块（写进 groups）。
                固定之后它永远是独立的一块；两块各自固定 = 把它们**拆开**。 */}
            {inkGroup ? (
              <button
                className="bd-inkgroup"
                data-ink-group="off"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onDissolveInk?.()
                }}
                title="拆开：把这一块恢复成「按邻近自动聚」（它就不再是固定的一块了）"
              >
                ⧉ 拆开这块
              </button>
            ) : (
              <button
                className="bd-inkgroup"
                data-ink-group="on"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onFreezeInk?.()
                }}
                title="固定成一块：圈住的这些笔以后永远是独立的一块（旁边那坨再近也不并起来）"
              >
                ⧉ 固定成一块
              </button>
            )}
            {/* ★ 框住的**正好是一条连接线**时，多给一排词。
                这是"事后改词"的路：画完那 3.5 秒没点、或者后来改主意了，
                框住那条线就能再改一次 —— 不用把线擦掉重画。
                （框选本来就是这条路：圈住东西 → 框上方浮出能对它做的事。） */}
            {selLink && (
              <span className="bd-inklink" data-sel-link={selLink.strokeId}>
                {LINK_KINDS.map((k) => (
                  <button
                    key={k.id}
                    className={'bd-linkchip' + (k.id === selLink.kind ? ' on' : '')}
                    data-link-kind={k.id}
                    style={k.id === selLink.kind ? { background: k.color, borderColor: k.color, color: '#fff' } : { color: k.color, borderColor: k.color }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onApplyLink?.(selLink.strokeId, k.id)
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
                      onApplyLink?.(selLink.strokeId, selLink.kind, { reverse: true })
                    }}
                    title="方向反一下"
                  >
                    ⇄
                  </button>
                )}
                {/* 「这条不算连接」：自动读出来的关系会读错（一条长竖笔正好跨过两坨字）。
                    没有这个口子的话，猜错了只能擦掉那一笔重画 —— 那就成了"猜错还锁死"。 */}
                <button
                  className="bd-linkchip none"
                  data-link-kind={LINK_NONE}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onApplyLink?.(selLink.strokeId, LINK_NONE)
                  }}
                  title="它其实不是连接：记在那一笔上，以后不再读成关系（Ctrl+Z 能退回）"
                >
                  不算连接
                </button>
              </span>
            )}
            {/* 框住的笔里有"你说过不算连接"的 → 给一条回头路。
                那句话点下去之后，唯一的另一条路是 Ctrl+Z；重开之后连它也没了。 */}
            {inkNoLink && (
              <span className="bd-inklink" data-ink-nolink="1">
                <button
                  className="bd-linkchip"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClearNoLink?.()
                  }}
                  title="去掉「不算连接」，让它按形状重新判"
                >
                  又算回连接
                </button>
              </span>
            )}
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
          {links
            .filter((l) => l.dir && !l.headInk)
            .map((l) => {
              const { x: ax, y: ay } = worldToScreen(l.to, view)
              const r = 10
              const a1 = l.angle + Math.PI - 0.5
              const a2 = l.angle + Math.PI + 0.5
              return (
                <path
                  key={'ah' + l.strokeId}
                  data-link-arrow={l.strokeId}
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
                key={'pill' + l.strokeId}
                className="bd-linkpill"
                data-link-kind={l.kind}
                data-link-stroke={l.strokeId}
                style={{ left: mx, top: my, color: l.color, borderColor: l.color }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onPickLink?.(l)
                }}
                title={l.manual ? '你标过的关系：点一下可以改' : '按笔迹形状读出来的：点一下可以改'}
              >
                {l.name}
                {l.dir ? ' →' : ''}
              </button>
            )
          })}
        {linkPick && (
          <LinkChips
            at={linkPick}
            onPick={(kind) => onApplyLink?.(linkPick.strokeId, kind)}
            onReverse={() => onApplyLink?.(linkPick.strokeId, linkPick.kind, { reverse: true })}
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
      data-link-pick={at.strokeId}
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
          title="方向反一下：把这一笔的起止倒过来（渲染出来一模一样，只是箭头换一边）"
        >
          ⇄
        </button>
      )}
      <button
        className="bd-linkchip none"
        data-link-kind={LINK_NONE}
        onClick={(e) => {
          e.stopPropagation()
          onPick(LINK_NONE)
        }}
        title="它其实不是连接（按 0）：记在那一笔上，以后不再读成关系"
      >
        不算连接
      </button>
      <span className="bd-linkchips-x">不点也行</span>
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
