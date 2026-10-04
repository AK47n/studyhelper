import React, { useCallback, useEffect, useRef, useState } from 'react'
import { readLookup } from '../lib/lookup.js'
import { lookupText } from '../lib/answer-cards.js'
import { richHtml } from '../lib/rich.js'
import { usageText } from '../lib/usage.js'

/* ── 速查小窗（2026-09-28）：上课突然不懂的那个词 ──────────────────────────
 *
 * 用户要的是："我在看课件/写笔记，突然不懂一个词，要有个地方马上告诉我"，
 * 并且明确了「既可以查我写的也可以查 ppt 上的」。
 *
 * ★★ 它为什么**不是**「页边追问」（AskBox）那个窗 ──────────────────────────
 *   AskBox 走的路是：框住一块 → 渲两张图 → 发过去 → 等一段讲解。**慢且贵**
 *   （一张图就几百 token，而且是一次 PDF 渲染的往返）。
 *   而"突然不懂一个词"这个动作的忍耐度只有三五秒 —— 超过就跟丢老师下一句了。
 *   ⇒ 速查**不发图**，纯文本进出（实测 1.7 秒、输出 70 来个 token）。
 *   它是另一回事，不该复用那个窗（复用会让"快"输给"重"）。
 *
 * ── 三条被选定的决定（都是用户挑的，别自己改回去）────────────────────────
 *   ① **默认浮着，看完就走**，板上不留痕 —— 除非你点「⬇ 留到板上」。
 *      和 AskBox 同一条哲学：**你不点它就不会动你的板**。
 *   ② **词是猜的**。中文没有空格，机器按标点切出来的东西常常不是词
 *      （点一下标题就得到一整句）。所以词放在**输入框**里 —— 它看得见、你也改得动；
 *      查之前还能改，查之后也能改了再查。
 *      ⚠ 别把这行改成"标签 + 值"那种只给看的显示：那等于假装自己分得准。
 *   ③ **查过的词记着**（lookup.js 的缓存）。上课最容易发生的是"第三次听到这个词，
 *      第三次忘了它" —— 缓存命中就是瞬间，也不用再花钱。
 *
 * ── 它和板的关系 ─────────────────────────────────────────────────────────
 *   这个窗**拿不到 board**（和 AskBox 同一条规矩，见 ADR-0006）：
 *   它只能交出一个"请把它留下"的**请求**（`onKeep`），落不落卡由外面那一层决定。
 */
export default function QuickLook({ at, seed, contextLabel, onClose, onKeep, flash }) {
  const say = (m, k) => flash && flash(m, k)
  const [draft, setDraft] = useState((seed && seed.term) || '')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')
  const [kept, setKept] = useState(false)
  const dragRef = useRef(null)
  const abortRef = useRef(null)
  const taRef = useRef(null)

  /* ── Esc 关窗：**挂在 document 的捕获阶段** ─────────────────────────────
   * 老坑（AskBox 2026-09-22 抓到并留下解法）：写在 textarea 的 onKeyDown 里的话，
   * 点过按钮之后焦点不在输入框上，Esc 就没反应了 —— 而"关掉浮着的东西"正是第一反应。
   * ★ 捕获阶段 + stopPropagation：抢在板上那个 window 监听（冒泡）之前，
   *   不然一下 Esc 会"既关窗、又把板上的焦点取消掉"。 */
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

  /* 关窗 / 卸载：掐掉在飞的那一次（拦不住已经发出去的，但至少别再等它）。 */
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

  const go = useCallback(
    async (term) => {
      const q = String(term || '').trim()
      if (!q) {
        say('先写个词', 'warn')
        return
      }
      setErr('')
      setBusy(true)
      const ctl = new AbortController()
      abortRef.current = ctl
      try {
        /* ★ `line` 带着 —— 它是让模型判断"到底在问哪个词"的依据
           （"变换"在那句话里是"傅里叶变换"，只给两个它能做的推断很少）。
           改了词之后就**不带**了：那时候该听新写的那个词，而不是旧的那句话。 */
        const got = await readLookup({
          term: q,
          line: q === (seed && seed.term) ? seed && seed.line : '',
          context: seed && seed.context,
          signal: ctl.signal,
        })
        /* ★ 模型挑出来的词通常比我们前端猜的准（见 server-ocr.js 的 LOOKUP_PROMPT 那段）⇒
           查回来之后把输入框回填成它 —— 用户一眼能看出认的是不是自己想问的那个。
           ⚠ 只在**有**的时候回填：模型漏了这一行是常事，回填空串等于把用户写的词抹了。 */
        if (got.term) setDraft(got.term)
        setRes(got)
      } catch (e) {
        if (e && e.name === 'AbortError') return
        setRes(null)
        setErr(String((e && e.message) || e))
      } finally {
        abortRef.current = null
        setBusy(false)
      }
    },
    [seed, say]
  )

  /* 开窗就查 —— 双击那个动作本身就是"我现在就想知道"，不该再让他点一下发送。
     ⚠ 只在**有词**的时候自动查：手动唤起（Ctrl+K）时 `seed.term` 是空的，
        那时候自动发是一次没头没脑的调用（那一族的规矩：别替他花这笔钱）。
     ⚠ 依赖写 `[]` + 闸门而不是 `[draft]`：输入框里改一个字就重新再查一次的话，
        打到一半会被自己的中间结果顶掉，而改完要按回车这一下本来就有明确的动作
        （按回车）—— 自动发送和手动发送要各管一段，别叠着来。 */
  const firstRef = useRef(false)
  useEffect(() => {
    if (firstRef.current) return
    firstRef.current = true
    if (!draft.trim()) {
      if (taRef.current) taRef.current.focus()
      return
    }
    /* 不 await、不 return：这是开窗那一下顺手做的事，
       它的结果走 `setRes`，让 effect 自己去等等于把整个窗的渲染押在一次网络上。 */
    go(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── 「⬇ 留到板上」：交出去的是一个**请求**，落不落由外面那一层定 ──────────
     ⚠ 内容那一半在这里**不拼**：「答案卡长得什么样」（多少字封顶、哪一段丢掉）
       只有 `answer-cards.js` 的 `lookupText` 一处说话 —— 在这里再拼一遍就是第二份，
       改那一份的时候这一份不会跟着改（仓里那条账：同一个矩形算两遍必错一处）。 */
  function keep() {
    if (!onKeep || !res) return
    const made = lookupText({ term: draft.trim(), say: res.say, eg: res.eg })
    if (!made) {
      say('这一条还是空的，没什么可留的', 'warn')
      return
    }
    if (onKeep({ term: draft.trim(), made }) !== false) setKept(true)
  }

  /* 回车再查、Shift+回车换行。
     ⚠ 别的键必须 stopPropagation：板上那些快捷键挂在 window 上，
       不拦住的话在这儿打一个 `e` 就切成橡皮了（这一族踩过的）。 */
  const onKeyDown = (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      go(draft)
    }
  }

  /* 拖标题栏挪窗。 */
  const where0 = useRef({ x: (at && at.x) || 0, y: (at && at.y) || 0 })
  const [drag, setDrag] = useState(null)
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

  const style = {
    left: Math.round(where0.current.x + ((drag && drag.dx) || 0)),
    top: Math.round(where0.current.y + ((drag && drag.dy) || 0)),
  }
  const near = (res && res.near) || []

  return (
    <div className="bd-look" style={style} data-look-term={draft} onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="bd-look-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadUp}
        title="拖这儿挪窗 · Esc 关掉"
      >
        <span className="bd-look-ico">🔍</span>
        <span className="bd-look-title">速查{contextLabel ? ' · ' + contextLabel : ''}</span>
        <button
          className="bd-look-x"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            if (onClose) onClose()
          }}
          title="关掉（不点「留到板上」的话，板上什么都不留）"
        >
          ✕
        </button>
      </div>

      {/* ★ 词在**输入框**里 —— 见文件头第 ② 条：它是猜出来的，要看得见也改得动。 */}
      <div className="bd-look-in">
        <input
          ref={taRef}
          className="bd-look-ta"
          value={draft}
          placeholder="要查哪个词？"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <button
          className="bd-look-go"
          onClick={() => go(draft)}
          disabled={busy || !draft.trim()}
          title={busy ? '正在查' : '查这个词（也能按回车）'}
        >
          {busy ? '…' : '查'}
        </button>
      </div>

      <div className="bd-look-body">
        {busy && !res && <div className="bd-look-dim">正在查「{draft}」…</div>}
        {!busy && !res && !err && <div className="bd-look-dim">打一个词，回车就查。</div>}

        {err && (
          <div className="bd-look-err">
            <span>{err}</span>
            <button className="bd-look-retry" onClick={() => go(draft)} title="再试一次">
              ↻ 再试
            </button>
          </div>
        )}

        {res && (
          <>
            {res.say ? (
              <div className="bd-look-say" dangerouslySetInnerHTML={{ __html: richHtml(res.say) }} />
            ) : null}
            {res.eg ? (
              <div className="bd-look-eg">
                <span className="bd-look-k">例</span>
                <span dangerouslySetInnerHTML={{ __html: richHtml(res.eg) }} />
              </div>
            ) : null}
            {near.length ? (
              /* ★ 相关词可以点 —— "接着该懂的那个词"点一下就有，
                 比让他重新打一遍字快得多（这也是这个窗存在的理由的一部分）。 */
              <div className="bd-look-near">
                <span className="bd-look-k">近</span>
                {near.map((w) => (
                  <button
                    key={w}
                    className="bd-look-chip"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDraft(w)
                      go(w)
                    }}
                    title="查这个词"
                  >
                    {w}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="bd-look-foot">
              {kept ? (
                <span className="bd-look-kept">✓ 已在板上</span>
              ) : (
                <button
                  className="bd-look-keep"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    keep()
                  }}
                  /* ⚠ 提「↶ 撤销」而不是只说 Ctrl+Z：Surface 上没键盘的时候
                     Ctrl+Z 这句话等于没说（工具条上那颗 ↶ 才是他点得到的那条）。 */
                  title="把它落成板上一张卡（贴错了点工具条「↶ 撤销」能退，键盘上按 Ctrl+Z 也行）"
                >
                  ⬇ 留到板上
                </button>
              )}
              {res.cached ? (
                <span className="bd-look-usage" title="这个词这门课查过 —— 这次没出网，也没花钱">
                  上次查过的
                </span>
              ) : usageText(res.usage) ? (
                <span className="bd-look-usage">{usageText(res.usage)}</span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
