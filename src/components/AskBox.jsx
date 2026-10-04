import React, { useCallback, useEffect, useRef, useState } from 'react'
import { buildAskImages } from '../lib/ask-images.js'
import { ASK_STALE_HINT } from '../lib/followup.js'
import { regionLabel } from '../lib/ask-region.js'
import { KEEP_BUTTON, KEPT_LABEL, askThreadText } from '../lib/answer-cards.js'
import { richHtml } from '../lib/rich.js'
import { usageText } from '../lib/usage.js'

/* ── 页边的问答小窗：框住课件上哪一块，就问那一块"为什么" ──────────────────
 *
 * 用户 2026-09-22 的原话：
 *   「现在的痛点在于即使有讲解仍然有没理解的地方，而现在的好处在于 pdf/ppt 已经上传，
 *     ai 知道，加一个可以在页边快速追问这页里面哪个地方是为什么，或者说更加智能一点
 *     直接用框选，框中的地方是有疑问的地方并且可以询问这是为什么」。
 *
 * ── 三条被明确选定的决定（都是用户挑的，别自己改回去）────────────────────
 *   ① **答案浮在页边**：读完关掉就没了，板上不留卡片 —— 除非你按「⬇ 留到板上」
 *      （2026-09-22 加的，见 ADR-0006：这个小窗**还是拿不到 board**，
 *      它只能交出一个"把这一轮留下"的**请求**，落卡由 Board 那一层做）。
 *   ② **能接着追问**：一轮小窗里可以问第二句，每次都带着前面几轮（`history`）。
 *      真正的痛点就是"听了一遍还是不懂"，而那时候人往往已经知道该问什么了。
 *   ③ **每次发两张图**：整页（红框标出你圈的位置）+ 框里那一块放大（ask-images.js）。
 *
 * ── 「留到板上」那颗按钮挂在哪、留下的是什么 ──────────────────────────────
 *   挂在**每一条回答下面**，位置就是"留到这儿"的意思：留下的是**从第一问到这一轮**
 *   的整段问答（第二答常常写着"上面那个符号"，只留最后一答同样看不懂）。
 *   点过的那一条变成「✓ 已在板上」，**窗不收** —— 留下是往板上加一样东西，
 *   不是"这段对话结束了"（人常常留下第一条、接着问第二条）。
 *
 * ── 为什么两张图**只造一次** ─────────────────────────────────────────────
 * 追问的是同一块地方，图一个字都不会变。每次追问都重渲染一遍 PDF 是白花的钱和时间
 * （而且 pdf.js 那条渲染链偶发卡死，少走一次就少一分风险）。所以：
 * 小窗一开就造好两张图，之后每一轮复用 —— 换页 / 换一块地方才会重造。
 *
 * ── 它为什么不是一张"卡片" ───────────────────────────────────────────────
 * 卡片是板上的东西（要摆版、要量尺寸、要存盘、要能被框选和撤销）。
 * 这个窗是**看的方式**，和「询问框」「公式架」同一族：浮着、关掉就走、不写进板文件。
 */
export default function AskBox({ anchor, target, onClose, onKeep, flash }) {
  const { doc, page, region, rect } = target || {}
  const say = (m, k) => flash && flash(m, k)
  /* 上一轮对话：[{ role:'user'|'assistant', text }]。**只在这个组件里**活着 ——
     关掉小窗就散（没点「留到板上」的那些就是这个命）。 */
  const [turns, setTurns] = useState([])
  /* 哪几条回答已经被「留到板上」留过了（下标 = `turns` 里的下标）。
     只在这个窗里记着：**再点一次不会又落一张**（想再要一张就关窗重新问 ——
     那时候是一次明确的动作）。 */
  const [kept, setKept] = useState(() => new Set())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /* 图造好了没有（第一次要等 PDF 渲染，几百毫秒到几秒）。 */
  const [shots, setShots] = useState(null)
  const [shotErr, setShotErr] = useState('')
  const [err, setErr] = useState('')
  /* 拖动：只记"相对按下那一刻挪了多少"（屏幕像素）。位置本身是外面算的
     （anchor）+ 这个偏移 —— 关掉重开一定回到选区旁边，不会飘到上次拖去的地方。 */
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  const abortRef = useRef(null)
  const listRef = useRef(null)
  const taRef = useRef(null)

  /* ── 造图：小窗一开就造一次。换页 / 换矩形会重造（重开小窗就是一次重造）。 ── */
  const reg = region || null
  useEffect(() => {
    let alive = true
    setShots(null)
    setShotErr('')
    if (!doc || !doc.path || !reg) return () => {}
    buildAskImages({ path: doc.path, page, region: reg })
      .then((r) => {
        if (alive) setShots(r)
      })
      .catch((e) => {
        if (alive) setShotErr(String((e && e.message) || e))
      })
    return () => {
      alive = false
    }
  }, [doc && doc.path, page, reg && reg.x, reg && reg.y, reg && reg.w, reg && reg.h])

  /* ── Esc 关窗：**挂在 document 的捕获阶段**，不是那个输入框上 ──────────────
   * ⚠ 2026-09-22 自检抓到的真 bug（「作业辅导」那个窗是同一天同一个形状）：
   *   Esc 原来只写在 textarea 的 onKeyDown 里，而"点过「问」"之后焦点落在
   *   **那颗按钮**上 —— 于是按 Esc 一点反应都没有。而"关掉浮着的东西"正是
   *   用户的第一反应（README 第 5 条那一族的近亲）。
   * ★ 捕获阶段 + stopPropagation：抢在板上那个 `window` 监听（**冒泡**）之前 ——
   *   不然按一下 Esc 会"既关掉小窗、又把板上的焦点取消掉"，两件事一起发生。
   *   原来这里写的是"放它上去、由板上那族收"，那条只在**焦点在输入框里**时成立。
   * ⚠ 只认 Escape：别的键一概不拦（板上那些单键快捷键要照常能用）。 */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (onClose) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /* 关窗 / 卸载：把在飞的那一次请求掐掉。
     ⚠ 掐掉的只是**等待**：已经发出去的那一次拦不住（服务端还在跑、钱也照花）——
       界面上那句提示语如实这么说。 */
  useEffect(
    () => () => {
      try {
        abortRef.current && abortRef.current.abort()
      } catch {
        /* 无所谓 */
      }
    },
    []
  )

  /* 新内容进来滚到底：答案是"接着上面说"的，不滚等于看不到。 */
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, busy])

  /* 第一句替用户填好 —— 但他可以改。**不自动发**：
     自动发的话，"我只是想问问"会变成一次不想要的调用（要花钱）。 */
  useEffect(() => {
    setDraft('这里为什么是这样？')
    if (taRef.current) taRef.current.focus()
  }, [doc && doc.path, page])

  const ask = useCallback(
    async (question) => {
      const q = String(question || '').trim()
      if (!q || busy) return
      if (!shots) {
        say(shotErr ? '这一页的图没造出来：' + shotErr : '还在画这一页的图，稍等一下', 'warn')
        return
      }
      const base = turns
      setErr('')
      setTurns([...base, { role: 'user', text: q }, { role: 'assistant', text: '', pending: true }])
      setDraft('')
      setBusy(true)
      const ctl = new AbortController()
      abortRef.current = ctl
      try {
        /* ★ 每一次追问都**重新发那两张图**：服务端不留会话状态（见 server-ocr.js 那段），
           而"接着问"必须让模型重新看到那一块东西 —— 否则第二问就成了空口回答。
           代价是"接着问"也要重新付一次图片的钱；换来的是**没有状态可错**。 */
        const fd = new FormData()
        fd.append('file', shots.page, `ask-page-${page}.jpg`)
        fd.append('file2', shots.crop, `ask-crop-${page}.jpg`)
        fd.append('mode', 'ask')
        fd.append('page', String(page))
        fd.append('question', q)
        /* 交给服务端的历史：**上一轮之前那些完整的轮次**（我问的 + 它答的），
           按时间顺序；还没答完的占位（pending）和空消息不发。
           ⚠ 这一次问的那句话**不走这里** —— 它在 `question` 字段里，服务端会把它
             和那两张图拼进**第 0 条**消息（见 server-ocr.js 那段"拼出来的形状"）。 */
        const hist = base.filter((t) => !t.pending && String(t.text || '').trim()).map((t) => ({ role: t.role, text: t.text }))
        if (hist.length) fd.append('history', JSON.stringify(hist))
        const res = await fetch('/api/ocr', { method: 'POST', body: fd, signal: ctl.signal })
        const body = await res.json().catch(() => null)
        if (!body) throw new Error(`本地服务返回了看不懂的内容（HTTP ${res.status}）`)
        if (!body.ok) throw new Error(body.kind === 'stale' ? ASK_STALE_HINT : body.error || '这次没问出来')
        /* ★ 回声校验（和「美化手写」「课件整理」同一条防线）：服务端没重启的话，
           它不认 mode:'ask'，会**按公式认**并把结果塞在 latex 里回来 ——
           不查这一条就会把一句别的东西当成老师的回答显示出来，而且不报任何错
           （2026-09-16「美化手写依旧在认公式」那个 bug 的形状）。 */
        if (body.mode !== 'ask') throw new Error(ASK_STALE_HINT)
        const text = String(body.text || '').trim()
        if (!text) throw new Error('模型没回内容（它可能以为这一块没什么可讲的）')
        /* 这一答的用量跟着这一条回答走（`body.usage` 是服务端从上游 usage 读出来的）——
           换页、重开窗就跟着散，和这一轮问答是一条命。 */
        setTurns([...base, { role: 'user', text: q }, { role: 'assistant', text, usage: body.usage || null }])
      } catch (e) {
        const cancelled = e && e.name === 'AbortError'
        /* 取消**不是**失败：把那个"正在想"的占位收掉，对话回到问之前的样子。 */
        setTurns(cancelled ? base : [...base, { role: 'user', text: q }])
        if (!cancelled) setErr(String((e && e.message) || e))
      } finally {
        abortRef.current = null
        setBusy(false)
      }
    },
    [busy, shots, shotErr, turns, page]
  )

  /* ── 「⬇ 留到板上」（ADR-0006）：把"到这一轮为止"的整段问答交给 Board 落成一张卡 ────
   * ★ 这个组件**还是拿不到 board**：它交出去的只是"哪一份、第几页、哪一块、什么内容"
   *   这一个**请求**（`onKeep`），落不落、落在哪儿由 Board 的 `keepAnswer` 决定 ——
   *   所以"答案会不会污染我的板"这句话的回答仍然是"**你不点它就不会**"。
   * ⚠ 交出去的是**页内归一化矩形**（`reg`），不是世界矩形：卡片存的、以及以后
   *   ◎ 那颗按钮画高亮用的都是它（"这一块在页面的哪个位置"是这一页自己的事）。
   * ⚠ 返回 false = 没落成（课件不在板上了、量不出尺寸、这一页没了……）——
   *   Board 那边已经说过一句人话了，这里**什么都不做**：不标"已留下"，也不把话吞掉。 */
  function keep(upto) {
    if (!onKeep || !doc || !doc.path) return
    const made = askThreadText(turns, upto)
    if (!made) {
      say('这一条还是空的，没什么可留的', 'warn')
      return
    }
    if (onKeep({ docPath: doc.path, page, region: reg, made }) !== false) setKept((cur) => new Set(cur).add(upto))
  }

  /* 回车发、Shift+回车换行。
   * ⚠ 别的键必须 `stopPropagation`：板上那些快捷键挂在 **window** 上，
     不拦住的话在这儿打一个 `e` 就切成橡皮了（「询问框」那一族踩过同样的坑）。
   * ★ **Esc 不在这里管** —— 它由上面那个 document 捕获监听收走。
     写在这儿的话就漏掉了"焦点不在输入框上"的那一半（点过「问」之后正是那样）。 */
  const onKeyDown = (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      ask(draft)
    }
  }

  /* 拖标题栏挪窗（指针捕获；拖动期间不让板上收到这些事件）。 */
  const onHeadDown = (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, dx: (drag && drag.dx) || 0, dy: (drag && drag.dy) || 0 }
  }
  const onHeadMove = (e) => {
    const d = dragRef.current
    if (!d) return
    setDrag({ dx: d.dx + (e.clientX - d.x), dy: d.dy + (e.clientY - d.y) })
  }
  const onHeadUp = () => {
    dragRef.current = null
  }

  const ox = (drag && drag.dx) || 0
  const oy = (drag && drag.dy) || 0
  const style = { left: Math.round(((anchor && anchor.x) || 0) + ox), top: Math.round(((anchor && anchor.y) || 0) + oy) }
  /* 标题上那句人话（"上左那一块"）走 ask-region.js 的那一份 —— 和自检断言的是同一个函数。 */
  const where = rect ? regionLabel(region) : ''

  return (
    <div className="bd-ask" style={style} data-ask-page={page} onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="bd-ask-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadUp}
        title="拖这里可以挪这个小窗（关掉再框选，位置会回到选区旁边）"
      >
        <span className="bd-ask-ico">？</span>
        <span className="bd-ask-title">
          第 {page} 页{where ? ' · ' + where : ''}
        </span>
        <button
          className="bd-ask-x"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            if (onClose) onClose()
          }}
          title="关掉（没点「留到板上」的那些就散了，也不写进文件）"
        >
          ✕
        </button>
      </div>

      <div className="bd-ask-list" ref={listRef}>
        {!turns.length && !busy && (
          <div className="bd-ask-empty">
            {shotErr
              ? '这一页的图没造出来：' + shotErr
              : shots
                ? '红框里那一块就是你圈的地方。问吧 —— 比如「这一步为什么能这么换」「这个符号是什么意思」。'
                : '正在画这一页的图…'}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div className="bd-ask-me" key={'u' + i}>
              {t.text}
            </div>
          ) : t.pending ? (
            <div className="bd-ask-say pending" key={'p' + i}>
              正在想…
            </div>
          ) : (
            /* 老师的回答按讲义那一套排（rich.js）：段落、`- ` 列表、行内/独立公式。
               和卡片那边**共用同一份渲染**（`richHtml`）—— 两套各拼一遍的话，
               公式在窗里排不出来，而回答里一定夹着式子。 */
            <React.Fragment key={'a' + i}>
              <div className="bd-ask-say" dangerouslySetInnerHTML={{ __html: richHtml(t.text) }} />
              {/* 「⬇ 留到板上」：挂在**每一条回答下面**，位置就是"留到这儿"的意思。 */}
              <div className="bd-ask-keeprow">
                {kept.has(i) ? (
                  <span className="bd-ask-kept">{KEPT_LABEL}</span>
                ) : (
                  <button
                    className="bd-ask-keep"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      keep(i)
                    }}
                    title="把到这一轮为止的问答落成板上一张卡（贴在这一页右边；Ctrl+Z 能退）"
                  >
                    {KEEP_BUTTON}
                  </button>
                )}
                {/* ★ 这一答花了多少（2026-09-22 加的）。**每一条各自一份**：
                    接着问的那几轮要重发那两张图，而"重发到底贵不贵"是这一行在回答的事
                    （前缀缓存命中之后，第 2 轮起它们只按命中价走 —— 数在这里看得见）。 */}
                {usageText(t.usage) ? <span className="bd-ask-usage">{usageText(t.usage)}</span> : null}
              </div>
            </React.Fragment>
          )
        )}
        {err && (
          <div className="bd-ask-err">
            <span>{err}</span>
            <button className="bd-ask-retry" onClick={() => ask(lastUser(turns) || draft)} title="把刚才那一问再发一次">
              ↻ 再试一次
            </button>
          </div>
        )}
      </div>

      <div className="bd-ask-in">
        <textarea
          ref={taRef}
          className="bd-ask-ta"
          rows={2}
          value={draft}
          placeholder="问这一块为什么（回车发送，Shift+回车换行）"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <div className="bd-ask-btns">
          {busy ? (
            <button
              className="bd-ask-btn"
              onClick={() => {
                try {
                  abortRef.current && abortRef.current.abort()
                } catch {
                  /* 无所谓 */
                }
              }}
              title="不等了（已经发出去的那一次拦不住，钱照花）"
            >
              ■ 停止
            </button>
          ) : (
            <button
              className="bd-ask-btn primary"
              onClick={() => ask(draft)}
              disabled={!draft.trim() || !shots}
              title="问它（也能按回车）"
            >
              问
            </button>
          )}
        </div>
      </div>
      <div className="bd-ask-foot">
        {shots
          ? `每次问都发两张图：这一页 ${shots.pageInfo.w}×${shots.pageInfo.h}（红框标出你圈的地方）+ 那一块放大到 ${shots.cropInfo.w}×${shots.cropInfo.h}`
          : ''}
      </div>
    </div>
  )
}

/* 最后一条用户消息（"再试一次"要重发的是它）。 */
function lastUser(turns) {
  for (let i = (turns || []).length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'user') return turns[i].text
  }
  return ''
}
