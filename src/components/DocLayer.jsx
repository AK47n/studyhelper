import React, { useEffect, useRef } from 'react'
import { pageRects } from '../lib/docs.js'
import { renderDocPage, targetPixelWidth } from '../lib/doc-pages.js'
import { worldToScreen } from '../lib/view.js'

/* ── 资料层：PDF 的页面铺在画布最底下（z-index 1），注释全部压在它上面 ──
 *
 * 为什么是**两层**结构（和卡片那层不一样）：
 *   · 外层 `.bd-doclayer` 挂 `data-view-follow` —— 手势进行中，Board 的补正
 *     （syncViewCorrection）会把"还差的那一帧"先贴在它身上，和墨迹/卡片同帧；
 *   · 内层 `.bd-docworld` 才带**基础**视图变换（translate + scale）。
 *     分开的原因：补正是"临时叠上去、追上后删掉"的过渡量，它假设元素平时
 *     **不带**自己的变换；而页面是位图，跟着视图缩放最省事的做法就是一层
 *     CSS 变换。两个需求各占一层，谁也不打架。
 *
 * 页面按世界坐标摆（pageRects 给矩形），容器一缩放它们就跟着走 ——
 * 数据里没有屏幕坐标（board.js 那条铁律）。
 *
 * ★ 整层 `pointer-events: none`：笔要**写在资料上**，落点必须穿到下面的
 *   .bd-hit。资料唯一的把手是 DocBars（住在卡片层里，那里收得到指针）。
 */

/* 视口外多少**屏幕像素**范围内也开始渲染（滚动时页面已经在，不白屏）。 */
const RENDER_MARGIN = 700

/* 这一页在不在"该画"的范围里（视口 + RENDER_MARGIN，屏幕坐标算）。 */
function pageVisible(rect, view, size, margin = RENDER_MARGIN) {
  const left = rect.x * view.s + view.tx
  const top = rect.y * view.s + view.ty
  const w = rect.w * view.s
  const h = rect.h * view.s
  return left + w > -margin && top + h > -margin && left < size.w + margin && top < size.h + margin
}

export default function DocLayer({ docs = [], view, size }) {
  /* ★ **页码**（2026-09-23）：每一页左上角标一个"第 N 页"，让人在板上认得出这是哪一页。
   *
   * 为什么需要：整份课件铺上来之后是一片白纸，**每张长得都一样** ——
   *   想找"刚才讲的那页"只能靠眼力数（第 12 张是哪个？）。
   *   而课件整理那个窗口里明明写着"第 7 页"，板上却对不上号。
   *
   * ★★ 它必须**抵消祖先的缩放** —— 这就是 `--bd-world-s` / `--ck-inv` 那一套
   *   （见 styles.css 里 `.bd-card-del` 那一大段，2026-09-21 为"手柄点不到"栽过）：
   *   页码住在 `.bd-docworld` 里，而那一层挂着 `scale(view.s)` ⇒ 不抵消的话，
   *   放大时页码跟着变大、缩小时小到看不清，**屏幕字号和缩放绑死**。
   *   抵消靠 `zoom: calc(1 / var(--bd-world-s))`：最终屏幕长度 = 长度 × s × (1/s) ✓，
   *   而**布局盒不变**（别改成把 1/s 乘进 width/height —— 那会让能点的区域跟着缩水）。
   *
   * ⚠ `--bd-world-s` 是 Board.jsx 写在**卡片层** `.bd-cardworld` 上的，资料层是
   *   另一棵子树，**继承不到** —— 所以这里得自己写一份（和那一份同一个数 `view.s`）。
   *   字体大小本来想乘 `var(--s)`（界面字号档），但那个变量同样不在这一层上；
   *   页码不需要跟界面字号走（它是给"认页"用的，恒定大小反而更好认），故写死。
   * ★ 兜底 1：万一没有这个变量（自检单独挂一层），`var(--bd-world-s, 1)` 不会塌成 0。 */
  const worldS = Number(view && view.s) || 1
  return (
    <div className="bd-doclayer" data-view-follow="1" data-docs={docs.length}>
      <div
        className="bd-docworld"
        style={{
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
          /* 给页码用（它住在这层里面，要拿它做倒数的抵消） */
          '--bd-world-s': String(worldS.toFixed(6)),
        }}
      >
        {/* ★★ 每一页拿到的只有**它自己那几个数**（visible / 该渲染多宽 / 屏幕盒），
            不是 `view` / `size` 那两个对象（2026-09-21 第九刀的性能修，README 第 58 条）。
            为什么：`view` 每一帧都是新对象，而这里要摆 49 页 ——
            传 view 的话 49 个 DocPage 每帧全部重渲染（React 对账 + 样式重算），
            而其中一大半在屏幕外、一个像素都不该动。
            拆成基本值之后 `DocPage` 用 `React.memo` 拦得住：
            屏幕外那些页的 props 一个都没变（visible=false、wantPix 相同）→ 直接跳过。
            ⚠ 别把 `view` / `size` 再传进 DocPage —— 那会让下面那层 memo 当场失效。 */}
        {docs.map((doc) =>
          pageRects(doc).map((rect, i) => {
            const dpr = typeof window === 'undefined' ? 1 : Math.min(2.5, window.devicePixelRatio || 1)
            const visible = pageVisible(rect, view, size)
            return (
              <DocPage
                key={doc.id + ':' + i}
                path={doc.path}
                index={i}
                rect={rect}
                visible={visible}
                /* 只有**可见**的页才需要算"该渲染多宽" —— 不可见时给 0，
                   于是它的 props 在这段缩放里是恒定的（0 就是 0）。 */
                wantPix={visible ? targetPixelWidth(rect.w, view.s, dpr) : 0}
              />
            )
          })
        )}
      </div>
    </div>
  )
}

/* ── 一页：白纸底 + 按需渲染出来的位图 ──
 *
 * 懒渲染的三条判据（都只在这一个组件里）：
 *   ① **可见**才渲染：视口（外扩 RENDER_MARGIN）之外的页是一张白纸 ——
 *     一份几百页的课件，谁也不会一次全画（worker 和显存都受不了）；
 *   ② **够清晰**才不重画：目标像素宽（世界宽 × 缩放 × dpr）和已渲染的差超过
 *     25% 才重画 —— 捏合缩放的每一帧都重画的话，页面会一直闪；
 *   ③ **滚出去就释放**：canvas 卸载、在飞的任务取消 —— 200 页翻完一遍，
 *     内存里只留着看过的那几页附近。
 *
 * ★★ 它收的是**基本值**（visible / wantPix / rect），不是 `view` / `size` 对象
 *   （2026-09-21 第九刀，见 README 第 58 条）—— 所以外面套得住 `React.memo`：
 *   屏幕外那些页在这一段缩放里 props 一个都没变 → React 直接跳过它们。
 *   49 页每次缩放全部重渲染的代价就是这么消掉的（实测那 700ms 里有一大块是它）。
 *   ⚠ 别再往参数表里加 `view` / `size` / 任何每帧新建的对象。
 */
const DocPage = React.memo(function DocPage({ path, index, rect, visible, wantPix }) {
  const canvasRef = useRef(null)
  /* 一页的渲染账本：画过多少像素宽（pix）、在飞的任务（task）、第几趟（seq）。 */
  const jobRef = useRef({ pix: 0, task: null, seq: 0 })
  const job = jobRef.current

  /* 滚出视口：取消在飞的任务、把"画过了"的账清掉 —— 回来时重画。 */
  useEffect(() => {
    if (visible) return
    if (job.task) {
      try {
        job.task.cancel()
      } catch {
        /* 已经画完的任务取消会抛 —— 忽略 */
      }
      job.task = null
    }
    job.pix = 0
  }, [visible, job])

  /* 该画而没画（或不够清晰）：排队画一趟。 */
  const stale = !job.pix || Math.abs(wantPix - job.pix) / job.pix > 0.25
  useEffect(() => {
    if (!visible || !stale || !wantPix) return
    const cv = canvasRef.current
    if (!cv) return
    const seq = (job.seq += 1)
    renderDocPage(path, index + 1, cv, wantPix, job)
      .then(() => {
        if (job.seq === seq) job.pix = cv.width
      })
      .catch(() => {
        /* 失败/被取消：账清零，下次视野一动再试。画不出来也只是白纸，
           不弹错 —— 翻页途中一个网络抖动不该变成一条警告。 */
        if (job.seq === seq) job.pix = 0
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, stale, wantPix, path, index])

  /* 卸载时把 worker 那边的任务停掉（换板/删资料的路上不留飞着的活）。 */
  useEffect(
    () => () => {
      if (jobRef.current.task) {
        try {
          jobRef.current.task.cancel()
        } catch {
          /* 已完成的任务取消会抛 —— 忽略 */
        }
      }
    },
    []
  )

  return (
    <div
      className="bd-docpage"
      data-doc-path={path}
      data-doc-page={index + 1}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      {visible && <canvas ref={canvasRef} />}
      {/* 页码角标（见 DocLayer 顶上那段说明）。
          ★ 只在**可见**时渲染：几十上百页各挂一个 DOM 是白给的开销，
            而不可见那些页一个像素都不显示。
          ★ 它**不吃指针**（CSS 里 pointer-events: none）—— 往页码上落笔照样是写字，
            资料层整层 none 那条规矩不能在这儿破个口子。 */}
      {visible && <span className="bd-docno">{index + 1}</span>}
    </div>
  )
})

/* ── 资料的把手条（住在卡片层 .bd-world 里，z6 > 收事件层 z5，点得到）──
 *
 * 四件事都从这条上做（和板框的标题把手一个路子）：
 *   · 拖它 → 整份资料一起挪（Board.jsx 的 docDrag*，一次拖动 = 一步撤销）；
 *   · **✧ 整理** → 把这一段页读成知识点贴到板上（课件整理，2026-09-22）；
 *   · ✕ → 把资料从板上移掉（PDF 文件还在 .资料/ 里，写过的注释也还留着）；
 *   · 条上写着文件名和页数，让人知道"这坨是什么"。
 * 页面本身不吃指针（DocLayer 整层 none），所以往页面上落笔永远是写字。
 */
export function DocBars({ docs = [], view, onDragStart, onDrag, onDragEnd, onDelete, onRead }) {
  return (
    <>
      {docs.map((doc) => (
        <DocBar
          key={doc.id}
          doc={doc}
          view={view}
          onDragStart={onDragStart}
          onDrag={onDrag}
          onDragEnd={onDragEnd}
          onDelete={onDelete}
          onRead={onRead}
        />
      ))}
    </>
  )
}

function DocBar({ doc, view, onDragStart, onDrag, onDragEnd, onDelete, onRead }) {
  const dragRef = useRef(null)
  const at = worldToScreen({ x: doc.x, y: doc.y }, view)
  const name = doc.title || doc.path.split('/').pop().replace(/\.pdf$/i, '')
  return (
    <div className="bd-docbar" data-doc-bar={doc.id} style={{ left: at.x, top: at.y }}>
      <button
        className="bd-docbar-t"
        title="拖动 = 整份资料一起挪 · ✕ = 从板上移掉（文件和注释都还在）"
        onPointerDown={(e) => {
          e.stopPropagation()
          if (onDragStart) onDragStart(doc.id)
          dragRef.current = { x: e.clientX, y: e.clientY }
          e.currentTarget.setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) return
          d.x = e.clientX
          d.y = e.clientY
          if (onDrag) onDrag(doc.id, dx, dy)
        }}
        onPointerUp={() => {
          if (dragRef.current && onDragEnd) onDragEnd(doc.id)
          dragRef.current = null
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span className="bd-docbar-ico">📄</span>
        <span className="bd-docbar-name">{name}</span>
        <span className="bd-docbar-n">{doc.pages.length} 页</span>
      </button>
      {/* 课件整理（2026-09-22）：**就整理我这一份**。板上挂了好几份课件时，
          这颗按钮就是"别猜哪一份"的答案（工具条那颗整理的是第一份）。 */}
      <button
        className="bd-docbar-r"
        title="课件整理：把这一份的某一段页读成知识点、贴到白板上"
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (onRead) onRead(doc.id)
        }}
      >
        ✧ 整理
      </button>
      <button
        className="bd-docbar-x"
        title="把这份资料从板上移掉（PDF 文件还在 data/.资料/ 里，写过的注释也留着）"
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (onDelete) onDelete(doc.id)
        }}
      >
        ✕
      </button>
    </div>
  )
}
