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
  return (
    <div className="bd-doclayer" data-view-follow="1" data-docs={docs.length}>
      <div
        className="bd-docworld"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}
      >
        {docs.map((doc) =>
          pageRects(doc).map((rect, i) => (
            <DocPage key={doc.id + ':' + i} doc={doc} index={i} rect={rect} view={view} size={size} />
          ))
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
 */
function DocPage({ doc, index, rect, view, size }) {
  const canvasRef = useRef(null)
  /* 一页的渲染账本：画过多少像素宽（pix）、在飞的任务（task）、第几趟（seq）。 */
  const jobRef = useRef({ pix: 0, task: null, seq: 0 })
  const visible = pageVisible(rect, view, size)
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2.5, window.devicePixelRatio || 1)
  const wantPix = targetPixelWidth(rect.w, view.s, dpr)
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
    if (!visible || !stale) return
    const cv = canvasRef.current
    if (!cv) return
    const seq = (job.seq += 1)
    renderDocPage(doc.path, index + 1, cv, wantPix, job)
      .then(() => {
        if (job.seq === seq) job.pix = cv.width
      })
      .catch(() => {
        /* 失败/被取消：账清零，下次视野一动再试。画不出来也只是白纸，
           不弹错 —— 翻页途中一个网络抖动不该变成一条警告。 */
        if (job.seq === seq) job.pix = 0
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, stale, wantPix, doc.path, index])

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
      data-doc-path={doc.path}
      data-doc-page={index + 1}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      {visible && <canvas ref={canvasRef} />}
    </div>
  )
}

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
