import React, { useEffect, useMemo, useRef, useState } from 'react'
import { pagesLabel, parsePageSpec, formatPageSpec } from '../lib/doc-cards.js'

/* ── 「这本书有几百页，只要这几页」那个小窗（2026-09-21）────────────────────
 *
 * 用户的原话：「题目在书上，但是这个书非常的长，我感觉要是为了做当中的几道题
 * 传上来一整个 pdf 有点太费事」。
 * 后来他又补了关键的一句（同一天）：「页数可能由于封面没有被计算在内从而有
 * 些许偏差……应该有个预览功能能够让用户确认这是不是他需要的这一页」。
 *
 * ── 所以这个窗做两件事 ────────────────────────────────────────────────────
 *   ① **报页码**（一句话的事，快）：`322-323`、`12,15` 都认；
 *   ② **看一眼再定**（封面/前言没算进页码时，PDF 的第 322 页常常不是书上印的
 *      第 322 页）：把那几页画成缩略图，点一下放大到能看清书上的页码。
 *      ★ 偏差"不会太多"是用户自己说的 —— 所以配的是**挪一页**（◀ ▶）和
 *        "旁边那一页"这两颗一按就到的键，不是让他重新去翻三百页。
 *
 * ── 三个出口（差一个都不行）───────────────────────────────────────────────
 *   ① **只放这几页** —— 他要的就是这个（写字 → 看一眼 → 抽出来）；
 *   ② **整本都要** —— 不能因为多了一个框就挡住老路。一句不动手的话也要能走：
 *      也有人就是想把整本书摆在板上翻；
 *   ③ **算了（✕ / Esc）** —— 选错文件那一刻要有后退路，**不许变成了"必须传一本"**。
 *
 * ── 为什么默认点亮在输入框里 ──────────────────────────────────────────────
 *   打开这个框的那一刻，他心里已经有页码了（题目就在书上第几页）——
 *   让他直接打，别再点一下。和「课件整理」挑页那一行是同一条习惯。
 *
 * ── 轻声提醒一句 ──────────────────────────────────────────────────────────
 *   抽出来的那份是**独立的一份**：页码从头算起，所以往后报题号写"第 1 页第 3 题"
 *   就行 —— 不用再记它在原书第几页（这句话写在框里，不打哑谜）。
 *
 * ★ 这个窗**不认识 pdf.js 也不认识 pdf-lib**：画缩略图那台机器由外面递进来
 *   （`preview()`，见 doc-slice.js 的 `thumbs()`），它只管"第几页画到哪块 canvas 上"。
 *   这样"怎么把一页变成像素"仍然只有 doc-pages.js 一处。
 */
export default function DocPagePicker({ name = '', total = 0, preview = null, onPick, onCancel }) {
  const [spec, setSpec] = useState('')
  const inputRef = useRef(null)
  /* 正在放大的那一页（0 = 没在放大）。 */
  const [zoom, setZoom] = useState(0)
  const [thumber, setThumber] = useState(null)
  /* ★ 页码怎么读**只有一份**（`parsePageSpec`）：课件整理挑页那一处也用它，
     所以"3-5"这种写法在两个地方一定是同一个意思 —— 各写一份的话，
     总有一处认不出别人认得出的写法。 */
  const pages = useMemo(() => parsePageSpec(spec, { max: total }), [spec, total])
  const bad = !!spec.trim() && !pages.length

  useEffect(() => {
    /* 打开就落在输入框里：`autoFocus` 在 pointerdown 已经被 Board 停掉的那条路上
       不一定生效（而且下一次打开是新的 DOM）。你自己 focus 一次，最稳。 */
    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  /* 缩略图那台机器：第一次要画的时候才开（一本几百页的书，开一份 pdf.js 文档
     不是小数 —— 心里有页码、一眼不看的人不该替它付这一份）。 */
  useEffect(() => {
    let alive = true
    if (!preview) return () => {}
    Promise.resolve()
      .then(preview)
      .then((t) => {
        if (alive) setThumber(t || null)
      })
      .catch(() => {
        /* 画不出缩略图也照样能抽页 —— 预览是让人安心的，不是必经的步骤 */
      })
    return () => {
      alive = false
    }
  }, [preview])

  /* Esc **先收放大**、再收整个窗：放大那一层开着的时候按 Esc，他要的是"看完了"，
     不是"算了不传了"（一口气把窗也关掉，等于把他打的那几个字一起扔了）。 */
  useEffect(() => {
    if (!zoom) return () => {}
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setZoom(0)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [zoom])

  function go() {
    if (pages.length) onPick(pages)
  }

  /** 整段往前/往后挪一页（`delta` = ±1）。
   *  ★ 挪完**写回输入框**（`formatPageSpec`）：输入框是这一件事唯一的实情，
   *    另存一个"挪了几页"的话，输入框和预览会各说一套 —— 那是迟早要出的错。 */
  function shift(delta) {
    const moved = pages.map((n) => n + delta)
    if (moved.some((n) => n < 1 || n > total)) return
    setSpec(formatPageSpec(moved))
  }

  const canBack = pages.length > 0 && pages[0] > 1
  const canFwd = pages.length > 0 && pages[pages.length - 1] < total
  /* 只挑了一页时，把**旁边那一页**也摆出来：偏差常常就差这一页，
     点一下就换过去，比"擦掉重打一个数"快得多。多页的时候旁边是哪一页说不清，
     那种情况靠上面那两颗挪一页。 */
  const nearPrev = pages.length === 1 && pages[0] > 1 ? pages[0] - 1 : 0
  const nearNext = pages.length === 1 && pages[0] < total ? pages[0] + 1 : 0
  /* 一次最多摆 8 张缩略图：挑了 30 页也别把窗撑成一面墙（挪一页照样整段挪）。 */
  const shown = pages.slice(0, 8)
  const restCount = pages.length - shown.length

  return (
    <div className="bd-slice" data-ask="doc-pages" onPointerDown={(e) => e.stopPropagation()}>
      <div className="bd-slice-head">
        <span className="bd-slice-ico">📄</span>
        <span className="bd-slice-title" title={name}>
          这份有 {total} 页
        </span>
        <button className="bd-slice-x" onClick={onCancel} title="算了，不传了">
          ✕
        </button>
      </div>
      <div className="bd-slice-body">
        <div className="bd-slice-lbl">做哪几页上的题？（就放这几页上去）</div>
        <input
          ref={inputRef}
          className="bd-slice-in"
          value={spec}
          placeholder="比如 320-322 或 12,15"
          onChange={(e) => setSpec(e.target.value)}
          onKeyDown={(e) => {
            /* ⚠ Esc / Enter **不许漏下去**：Board 那份全局 Esc 会把板上的焦点清掉
               （而在打字的人看来，命令就在他眼前）。 */
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              go()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
        />
        <div className={bad ? 'bd-slice-hint bad' : 'bd-slice-hint'}>
          {bad
            ? `这几个数认不出来 —— 这份一共 ${total} 页`
            : pages.length
              ? `放上去的是 ${pagesLabel(pages)}，页码从头算起（第 1 页就是你要的那一页）`
              : '留空（或直接按「整本都要」）= 整本都放上去'}
        </div>

        {/* ── 预览：先看见那几页，再决定放不放 ──
            ★ 书上的页码和 PDF 的页码常常差一点（封面没算进去），
              所以这里给的是"看一眼 + 挪一页"，不是让他自己猜。 */}
        {pages.length > 0 && (
          <div className="bd-slice-prev" data-slice-preview={pages.length}>
            <div className="bd-slice-prevhead">
              <span>先看看是不是这几页</span>
              <span className="bd-slice-prevacts">
                <button
                  className="bd-slice-mini"
                  data-slice-shift="-1"
                  disabled={!canBack}
                  onClick={() => shift(-1)}
                  title={pages.length > 1 ? '整段往前挪一页' : '往前挪一页'}
                >
                  ◀
                </button>
                <button
                  className="bd-slice-mini"
                  data-slice-shift="1"
                  disabled={!canFwd}
                  onClick={() => shift(1)}
                  title={pages.length > 1 ? '整段往后挪一页' : '往后挪一页'}
                >
                  ▶
                </button>
              </span>
            </div>
            <div className="bd-slice-thumbs">
              {nearPrev > 0 && (
                <PageThumb
                  thumber={thumber}
                  page={nearPrev}
                  near
                  label={`第 ${nearPrev} 页`}
                  tip={`是不是这一页？（书上的页码常常比这个数差一点）点它就用第 ${nearPrev} 页`}
                  onOpen={() => setZoom(nearPrev)}
                  onUse={() => setSpec(String(nearPrev))}
                />
              )}
              {shown.map((n) => (
                <PageThumb
                  key={n}
                  thumber={thumber}
                  page={n}
                  label={`第 ${n} 页`}
                  tip="放大看清楚（能看清书角上印的页码）"
                  onOpen={() => setZoom(n)}
                />
              ))}
              {nearNext > 0 && (
                <PageThumb
                  thumber={thumber}
                  page={nearNext}
                  near
                  label={`第 ${nearNext} 页`}
                  tip={`是不是这一页？（书上的页码常常比这个数差一点）点它就用第 ${nearNext} 页`}
                  onOpen={() => setZoom(nearNext)}
                  onUse={() => setSpec(String(nearNext))}
                />
              )}
            </div>
            {restCount > 0 && <div className="bd-slice-prevmore">还有 {restCount} 页没画出来（一样会放上去）</div>}
          </div>
        )}

        <div className="bd-slice-acts">
          <button className="bd-slice-btn ghost" onClick={() => onPick([])}>
            整本都要
          </button>
          <button className="bd-slice-btn primary" disabled={!pages.length} onClick={go}>
            只放这几页
          </button>
        </div>
      </div>

      {/* 放大那一层：缩略图上看不清书角印的页码，得看得见才算"确认过"。 */}
      {zoom > 0 && (
        <div className="bd-slice-zoom" data-slice-zoom={zoom} onPointerDown={(e) => e.stopPropagation()} onClick={() => setZoom(0)}>
          <div className="bd-slice-zoominner" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <div className="bd-slice-zoomhead">
              <span>第 {zoom} 页</span>
              <button className="bd-slice-x" onClick={() => setZoom(0)} title="收回去（Esc 也行）">
                ✕
              </button>
            </div>
            <PageThumb thumber={thumber} page={zoom} big label="" tip="" />
            <div className="bd-slice-zoomacts">
              {pages.length === 1 && pages[0] !== zoom && (
                <button
                  className="bd-slice-btn primary"
                  onClick={() => {
                    setSpec(String(zoom))
                    setZoom(0)
                  }}
                >
                  就用第 {zoom} 页
                </button>
              )}
              <button className="bd-slice-btn ghost" onClick={() => setZoom(0)}>
                收回去
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── 一张缩略图 ──────────────────────────────────────────────────────────
 * ★ 画法**不在这里**：`thumber.draw(page, canvas, pixelW)` 是 doc-pages.js 那一台
 *   机器（屏幕上翻页用的是同一套像素规矩 —— 白底、按 pixelW 反推缩放）。
 * ⚠ 卸载时要 `task.cancel()`：换页/关窗那一下如果不取消，pdf.js 会继续把那一页
 *   画完（几百页的书里，那是白白的几十毫秒和一块显存）。
 */
function PageThumb({ thumber, page, near = false, big = false, label = '', tip = '', onOpen, onUse }) {
  const ref = useRef(null)
  const [state, setState] = useState('wait') // wait | ok | bad
  /* 缩略图按屏幕像素给够（乘 dpr），放大那一层给到能读字。 */
  const pixelW = big ? ZOOM_PX : THUMB_PX

  useEffect(() => {
    const cv = ref.current
    if (!cv || !thumber || !(page > 0)) return () => {}
    let alive = true
    const holder = {}
    setState('wait')
    Promise.resolve()
      .then(() => thumber.draw(page, cv, pixelW, holder))
      .then(() => {
        if (alive) setState('ok')
      })
      .catch(() => {
        /* 画不出来就画不出来：告诉他这一页没图，别把整个窗弄坏 */
        if (alive) setState('bad')
      })
    return () => {
      alive = false
      try {
        holder.task && holder.task.cancel()
      } catch {
        /* 取消不了无所谓 */
      }
    }
  }, [thumber, page, pixelW])

  const cls = ['bd-slice-thumb', near ? 'near' : '', big ? 'big' : ''].filter(Boolean).join(' ')
  return (
    <button
      className={cls}
      data-thumb-page={page}
      data-thumb-state={state}
      title={tip || label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        /* ★ 旁边那一页：点它=换过去（他要的就是"差了一页"这一下）；
           选中的那一页：点它=放大（先看清，再决定）。 */
        if (near && onUse) onUse()
        else if (onOpen) onOpen()
      }}
    >
      <canvas ref={ref} />
      {state === 'bad' && <span className="bd-slice-thumbbad">这一页画不出来</span>}
      {label ? <span className="bd-slice-thumblbl">{label}</span> : null}
    </button>
  )
}

/* 缩略图的像素宽（缩略图显示成 108 CSS px，乘 dpr 让它不发虚）。
   放大的那一层给到能读清书角页码的宽度。 */
const THUMB_PX = Math.round(108 * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
const ZOOM_PX = 1100
