import React, { useEffect, useRef, useState } from 'react'

/* ────────────────────────── 转录校对 ──────────────────────────
 *
 * 整板转录（「▤ 收成笔记」）认完之后的**人机接手点**（2026-09-19 晚）。
 *
 * 为什么要有它：识别准确率永远到不了 100%，校对效率才是真正的瓶颈 ——
 * 从前转录稿直接进草稿，用户得**打开笔记 → 滚到手写转录一节 → 猜哪句对不上
 * → 切回白板看原字**，四步里有三步是找对照。现在把对照摆到脸上：
 *   左边 = 发给识别的那张原板图（和模型看到的一模一样，用 strokesToPngBlob
 *          再画一遍，不是截图 —— 所以"图上没有的"它也认不出来）；
 *   右边 = 机器认的稿，直接改。
 * 一块一行，从上到下就是板的阅读顺序。改完「收成笔记」，改的东西
 * 就是草稿里"手写转录"那一段。
 *
 * ★ 2026-09-19 第 3 步（手感）之后，这个弹层是**边认边填**的：
 *   · 它**当场**就打开（每块的图一开始就在），正在认的那块摆一个"正在识别…"，
 *     认完一块填一块 —— 等待从"盯着遮罩"变成"可以一边看原图一边等"；
 *   · 每块右下角有「重新认这一块」（只重发这一块，**绕开缓存**）；
 *   · 认字中随时能「停止」（中止后面的请求 —— 已经发出去的那一次拦不住，如实写着）；
 *   · 缓存命中的块标着「上次认的」，一眼看得出这次没花钱。
 *
 * 为什么放 App 这一层而不是 Board：转录发生在 gatherNote（App.jsx）里。
 */

export default function TranscribeReview({
  bands,
  ocrFail,
  streaming = false,
  confirming = false,
  vocab = [],
  useVocab = true,
  onToggleVocab,
  onRetry,
  onStop,
  onConfirm,
  onCancel,
}) {
  /* texts 是**本地草稿**：打字不回写 bands（bands 里那份是机器认的原文）。
     但 bands 会在两件事上被换掉 —— **边认边填**（某一块刚认完）和**重新认这一块**。
     两件事都只该动**那一块**的字，你在别的块里敲进去的东西一个字都不许动，
     所以同步按 `rev` 走：哪一块的 rev 变了，就只覆盖那一块。 */
  const [texts, setTexts] = useState(() => (bands || []).map((b) => (b && b.text) || ''))
  const revs = useRef((bands || []).map((b) => (b && b.rev) || 0))
  const bodyRef = useRef(null)

  useEffect(() => {
    const next = (bands || []).map((b) => (b && b.rev) || 0)
    setTexts((cur) => cur.map((t, i) => (next[i] !== revs.current[i] ? String((bands[i] && bands[i].text) || '') : t)))
    revs.current = next
  }, [bands])

  /* 进来就把第一块的字框对好焦：这个界面的全部意义就是"改字"。
     ⚠ 第一块还在认的时候（_pending_）没有可改的东西，等它认完再聚焦 —— 那时候
       `bands` 会换一次，这个 effect 跟着再跑。 */
  useEffect(() => {
    const t = setTimeout(() => {
      const first = bodyRef.current && bodyRef.current.querySelector('textarea:not([disabled])')
      if (first) first.focus()
    }, 60)
    return () => clearTimeout(t)
  }, [streaming])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel && onCancel()
      }
    }
    /* 捕获段拦：App/Board 那边的 Esc 各管各的，别让它们抢这一个键。 */
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  if (!Array.isArray(bands) || !bands.length) return null

  const done = (bands || []).filter((b) => b && !b.pending).length

  return (
    <div className="trv-back" onPointerDown={(e) => e.target === e.currentTarget && onCancel && onCancel()}>
      {/* 同时挂 wp 类：wp-head / btn / mini 那一组样式都写在 .wp 底下，直接蹭；
          宽度等差异由下面的 .trv 覆盖（它在 styles.css 里排在 .wp 后面）。 */}
      <div className="wp trv" role="dialog" aria-label="转录校对">
        <div className="wp-head">
          <b>转录校对</b>
          <span className="dim small">
            {streaming
              ? `正在一块一块认（${done}/${bands.length}）—— 已经认好的那块可以直接改`
              : '左边是发给识别的原板，右边是机器认的 —— 认错直接在框里改'}
          </span>
          {streaming && onStop && (
            <button
              className="mini"
              onClick={onStop}
              title="中止**后面的**请求；已经发出去的那一次拦不住（服务端还在跑，那一次的钱也照花）"
            >
              ■ 停止转写
            </button>
          )}
          <button className="wp-x" onClick={onCancel} title="先不收了（Esc）">×</button>
        </div>

        {ocrFail && (
          <div className="trv-warn">
            转录只完成了一部分（{ocrFail}）。没认出的那块摆在下面，空着 —— 会认的字自己照图补进去就行。
          </div>
        )}
        {confirming && (
          <div className="trv-warn ok">
            正在读结构（第二趟：把这一行行的字读成"哪几行是一节、谁挂在谁下面"）… 出网的是**纯文字**，几秒钟。
          </div>
        )}

        <div className="trv-body" ref={bodyRef}>
          {bands.map((b, i) => (
            <section className={'trv-band' + (b && b.pending ? ' on' : '')} key={i} data-pending={b && b.pending ? '1' : '0'}>
              {/* 块名：一块 = 你圈的一个板框（2026-09-19 第 2 步）。
                  从前这里只有"第 N 块"，你得自己对图猜"这是哪一节"；
                  框名摆在这儿之后，校对的人一眼知道自己在改哪一节，
                  而且**它最后就是草稿里那一节的名字**。 */}
              <div className="trv-name">
                <b>{b && b.name ? b.name : `第 ${i + 1} 块`}</b>
                <span className="dim small">{b && b.frameId ? '你圈的板框' : '框外的手写'}</span>
                {/* 这一块认得怎么样：**报数**（几行、漏了哪几行、有几句没按格式回）。 */}
                {b && !b.pending && b.coverage && <span className="trv-cov">{b.coverage}</span>}
                {b && b.pending && <span className="trv-tag">正在识别…</span>}
                {b && !b.pending && b.cached && <span className="trv-tag ok" title="这一块的内容没改过，直接用上次认的 —— 这次没有发请求">上次认的</span>}
                {!b?.pending && onRetry && (
                  <button className="mini trv-retry" onClick={() => onRetry(i)} title="只重发这一块（绕开缓存）">
                    ↻ 重新认这一块
                  </button>
                )}
              </div>
              <div className="trv-img" title="这张图就是发给识别服务的那张 —— 图上没有的它也认不出来">
                {b && b.img ? <img src={b.img} alt={(b && b.name) || '第 ' + (i + 1) + ' 块原板'} /> : <span className="dim small">（这块的图没画出来）</span>}
              </div>
              <textarea
                className="trv-edit"
                value={texts[i]}
                spellCheck={false}
                disabled={!!(b && b.pending)}
                placeholder={
                  b && b.pending
                    ? '正在识别这一块…（图已经在这儿了，着急可以先照着图看）'
                    : b && b.error
                      ? '这块没认出来（' + b.error + '）—— 会认的字自己补进来，或者右上角「重新认这一块」'
                      : '机器认的原文，认错的直接改'
                }
                onChange={(e) => {
                  const v = e.target.value
                  setTexts((cur) => cur.map((t, j) => (j === i ? v : t)))
                }}
              />
            </section>
          ))}
        </div>

        <div className="wp-acts trv-acts">
          <span className="dim small">
            {vocab.length ? (
              <label className="trv-vocab" title="这些词出自你自己的笔记（同层的优先）。它们只会跟着**第二趟**（读结构，纯文字）发出去 —— 不带也能收。">
                <input type="checkbox" checked={!!useVocab} onChange={(e) => onToggleVocab && onToggleVocab(e.target.checked)} />
                带上我自己的 {vocab.length} 个词
              </label>
            ) : null}
            改的东西就是草稿里"手写转录"那一段；不想要某块就把它的框清空
          </span>
          <button className="mini" onClick={onCancel} disabled={confirming}>先不收</button>
          <button
            className="btn primary"
            disabled={streaming || confirming}
            title={streaming ? '还在认 —— 想现在收就点「停止转写」' : ''}
            onClick={() => onConfirm && onConfirm(texts)}
          >
            {confirming ? '正在读结构…' : streaming ? '正在认…' : '校对完了，收成笔记'}
          </button>
        </div>
      </div>
    </div>
  )
}
