import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { askHomework, askProblemFollowup } from '../lib/homework-read.js'
import { HW_MAX_PAGES, HW_NO_LESSON_HINT, collectKnowledge, parseHomeworkAsk } from '../lib/homework.js'
import { KEEP_BUTTON, KEPT_LABEL, homeworkText } from '../lib/answer-cards.js'
import { richHtml } from '../lib/rich.js'

/* ── 作业辅导那个窗口（2026-09-22）────────────────────────────────────────
 *
 * 用户 2026-09-22 的原话：
 *   「用户会明确告知作业在哪里，通常来说都在书上。那么如果说我上传的是讲的 ppt，
 *     那么这个时候就还需要提醒我：我要把作业所在的那个 PDF 也传上来。然后我会告诉你
 *     具体的是哪几道题（第几页第几题），然后可以结合本节课的知识，这样能够对这道题
 *     做出更准确的回答。然后每道题要有答案也要有解析，解析的时候说人话。」
 * 后来他又补了一句关键的：「它不一定要以卡片的这么形式呈现，但是要能够解决我前面说的
 * 这个问题」—— 所以这个窗**自己不往板上写任何东西**（和「框选追问」的 AskBox 同一族：
 * 浮着、关掉就散、不写进板文件）。
 * ★ 2026-09-22 补的「⬇ 留到板上」（ADR-0006）：**你不点它就不会**写 ——
 *   这个组件交出去的只是一个"把这道题留下"的**请求**（`onKeep`），
 *   落成什么卡、摆在哪一页旁边由 Board 的 `keepAnswer` 决定。
 *   要写在板上、又不想留整道题，那还是自己用笔写。
 *
 * ── 窗里就三件事，按用户说的顺序 ────────────────────────────────────────
 *   ① **作业在哪一份里**：板上那几份资料 + 「传一份作业的 PDF…」。
 *      ★ 选中的是 PPT 转来的那份时，窗里冒出一条提醒（见下面 `pptHint`）——
 *        这正是用户点名要的那句话："你要把作业所在的那个 PDF 也传上来"；
 *   ② **做哪几道题**：他写"第 12 页第 3 题"。这句话**原样**发给模型（题号不解析），
 *      本地只从中读出**页号**（要渲染哪几页、页号写错了当场拦住）；
 *   ③ **这节课讲过什么**：板上那些讲义卡自动带上（`collectKnowledge`）。
 *      一份课件一份来源，板上有两份时才让他挑。
 *
 * ── 为什么答案和解析都走 `richHtml` ────────────────────────────────────
 * 和讲解卡、追问小窗同一个渲染（rich.js）：段落、`- ` 列表、`$…$` 式子。
 * 解析里一定夹着式子，排不出来等于白给 —— 而三处各拼一遍 DOM 的话，
 * 总有一处的公式长成另一个样子（这个仓库为"同一件事两份实现"栽过好几次）。
 */
export default function HomeworkBox({ docs = [], cards = [], docPath = '', target = null, onDoc, onClearTarget, onPickFile, onClose, onKeep, uploadBusy = '', flash }) {
  const say = (m, k) => flash && flash(m, k)
  /* 选中哪一份：窗里的 `docPath` 优先，没有就用板上第一份（打开就能用，少点一下）。 */
  const cur = docPath || (docs[0] && docs[0].path) || ''
  const doc = docs.find((d) => d.path === cur) || null
  const maxPage = doc && Array.isArray(doc.pages) ? doc.pages.length : 0

  const [ask, setAsk] = useState('')
  /* 这节课的知识从哪一份课件的讲义来（'' = 板上所有讲义卡都带上）。 */
  const [knowPath, setKnowPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  const [origin, setOrigin] = useState(null)
  /* 哪几道题已经被「留到板上」留过了（下标 = `result.problems` 里的下标）——
     同一个窗里再点一次不会又落一张。 */
  const [keptProbs, setKeptProbs] = useState(() => new Set())
  /* ── 追问（2026-09-22）────────────────────────────────────────────────
   * 学生对着**老师刚给的答案**接着问（"这一步为什么要除以 m"）。
   * 按题存：`{ [题目下标]: [{role:'user'|'assistant', text, pending?, error?}] }`。
   *   · `role: 'user'` = 学生问的那句；`'assistant'` = 老师答的那段；
   *   · `pending` = 还在飞（界面上显示"老师正在想…"），**不发进 history**（没有正文）；
   *   · `error` = 这一轮没成（界面上显示那句话 + 一个「↻ 重问」，不改 role）。
   * ★ 用下标当键，和 `keptProbs` 同一条 —— 「↻ 再做一次」会换掉整批题，
   *   那时候下标就不指同一道题了，所以 `run()` 里**一起清空**（见那边）。
   * ⚠ 这和「框选追问」的 AskBox 是**两套**：那边的历史挂在窗上（一个窗一个会话），
   *   这边**一题一份**（同一个窗里，第 3 题的追问不该串到第 5 题的回答里）。 */
  const [askTurns, setAskTurns] = useState(() => ({}))
  /* 每道题下面那个输入框里正在打的字（同上，按下标存）。 */
  const [askDraft, setAskDraft] = useState(() => ({}))
  /* 哪一道题的追问在飞（同时只允许一问：追问是接着同一个上下文说的，
     并发两问会让两条回复都基于"还没有后一问"的历史 —— 看起来就是答非所问）。 */
  const [asking, setAsking] = useState(-1)
  const followAbortRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  const abortRef = useRef(null)
  const taRef = useRef(null)

  /* 这一份是不是**讲课的 PPT** 转来的 —— 是的话要提醒他"作业在书上"（用户点名要的那句）。
   * ⚠ 判据在服务端（`/api/doc/origin`：同目录有没有留下同名原件），**不是**猜文件名：
   *   猜错的表现是"该提醒的时候没提醒"。查不到就什么都不说（不编一条）。 */
  useEffect(() => {
    let alive = true
    setOrigin(null)
    if (!cur) return () => {}
    fetch('/api/doc/origin?path=' + encodeURIComponent(cur))
      .then((r) => r.json())
      .then((d) => {
        if (alive && d && d.ok) setOrigin(d)
      })
      .catch(() => {
        /* 问不到就不提醒 —— 这条提示是锦上添花，不该因为它坏了挡住正事 */
      })
    return () => {
      alive = false
    }
  }, [cur])

  /* ── Esc 关窗：**挂在 document 的捕获阶段**，而不是那个输入框上 ──────────
   * ⚠ 2026-09-22 自检抓到的真 bug：Esc 原来只写在 textarea 的 onKeyDown 里，
   *   而"点过「开始做」"之后焦点落在**那颗按钮**上 —— 于是按 Esc 一点反应都没有。
   *   而"关掉浮着的东西"正是用户的第一反应（AskBox 那一族同源的那条注释）。
   * ★ 捕获阶段 + stopPropagation：抢在板上那个 `window` 监听（冒泡）**之前** ——
   *   不然按一下 Esc 会"既关掉这个窗、又把板上的选中取消掉"，两件事一起发生。
   * ⚠ 只认 Escape：别的键一概不拦，板上那些单键快捷键（P/E/S/A…）要照常能用。 */
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

  /* 关窗 / 卸载：把在飞的那一次请求掐掉（⚠ 掐掉的只是**等待**：已经发出去的那一次
     拦不住，服务端还在跑、钱也照花 —— 界面上那句提示语如实这么说）。 */
  useEffect(
    () => () => {
      try {
        abortRef.current && abortRef.current.abort()
      } catch {
        /* 无所谓 */
      }
      try {
        followAbortRef.current && followAbortRef.current.abort()
      } catch {
        /* 无所谓 */
      }
    },
    []
  )

  /* 这节课的知识（纯函数，板一变就重算）。 */
  const know = useMemo(() => collectKnowledge(cards, docs, { path: knowPath }), [cards, docs, knowPath])
  const sources = know.sources || []
  /* ── 两个"当前值"，都是**算出来的**，不各存一份 state ────────────────────
   * `useRegion`：他这次是**框住题号**进来的吗。三个条件都成立才算：
   *   ① 有框选目标；② 目标那一份**就是现在选中的这一份**（他中途换了资料，那个框就作废了）；
   *   ③ 页号有效。
   *   ⚠ ② 是必须的：`region` 是**相对某一页**的归一化矩形，换一份资料之后
   *     它指的地方完全变了一个意思 —— 拿着旧框去新书上比划，答案会挂到别的题上。
   * `pagesNow`：这一趟要翻哪几页（圈选题里就是框住的那一页）。 */
  const useRegion = !!(target && target.doc && target.doc.path === cur && Number(target.page) > 0)
  const spec = useMemo(() => parseHomeworkAsk(ask, { maxPage }), [ask, maxPage])
  /* 题号那一句读出来是什么。★ 圈选题**不校验**：页号由框定死，那个输入框只是
     "要不要再说一句"，留空是常态（留空不是错）。 */
  const specErr = useRegion ? '' : ask.trim() ? spec.error : ''
  const pagesNow = useMemo(() => (useRegion ? [Number(target.page)] : spec.pages), [useRegion, target, spec])

  const run = useCallback(async () => {
    if (busy) return
    if (!useRegion && spec.error) {
      say(spec.error, 'warn')
      if (taRef.current) taRef.current.focus()
      return
    }
    if (!cur) {
      say('先说清楚作业在哪一份里 —— 板上的资料里挑一份，或者「📄 传一份作业的 PDF…」', 'warn')
      return
    }
    setErr('')
    setResult(null)
    /* 重做一遍 = 新的一批题：上一批"已留下"的标记跟着作废（板上的卡照旧留着）。 */
    setKeptProbs(new Set())
    /* ★ 追问也一样作废 —— 它按**下标**挂在题上，而新的一批里第 3 道题
       多半不是刚才那一道。留着的话，学生会在另一道题下面看见他问第 3 道题的话
       （而那个"老师答"同样是另一道题的）。 */
    setAskTurns({})
    setAskDraft({})
    setAsking(-1)
    try {
      followAbortRef.current && followAbortRef.current.abort()
    } catch {
      /* 无所谓 */
    }
    followAbortRef.current = null
    setBusy(true)
    setStep('')
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      const r = await askHomework({
        path: cur,
        pages: pagesNow,
        ask: ask.trim(),
        knowledge: know.text,
        region: useRegion ? target.region : null,
        signal: ctl.signal,
        onStep: (t) => setStep(t),
      })
      if (r.error) {
        setErr(r.error)
        return
      }
      setResult(r)
      if (!r.problems.length) say('这一趟一道题都没做出来 —— 看看下面那句话说了什么', 'warn')
    } finally {
      abortRef.current = null
      setBusy(false)
      setStep('')
    }
  }, [busy, ask, cur, know.text, useRegion, target, pagesNow, spec.error])

  /* ── 「⬇ 留到板上」（ADR-0006）：把这一道题（题号 + 题干 + 答案 + 解析）交给 Board ────
   * ★ 这个窗**还是拿不到 board**：交出去的只是"哪一份、第几页、哪一块、什么内容"，
   *   落不落、落在哪儿由 Board 的 `keepAnswer` 决定。
   *
   * ⚠ **落哪一页**：优先用模型报的那一页（`p.page`，它在答案里也写着），
   *   但要用本地的事实（这份资料有几页）验一遍 —— 模型报一个不存在的页号时，
   *   退到"这一趟真翻过的那一页"。不这么兜的话，用户会得到一句
   *   "第 99 页在这份课件里找不到"，而那张卡**永远留不下来**（按钮点了没结果）。
   *   卡片内容里的题号是模型原话，一个字都不改（照抄题号是防串题的唯一手段）。
   * ⚠ 圈题进来的（`useRegion`）才有 `region`：那是"你圈的那一块"，
   *   打字问的那些没有可记的位置，但页码仍然记着。 */
  function keepProblem(i) {
    if (!onKeep || !cur || !result) return
    const p = result.problems[i]
    if (!p) return
    const made = homeworkText(p)
    if (!made) {
      say('这一道题是空的，没什么可留的', 'warn')
      return
    }
    const want = Math.trunc(Number(p.page))
    const page = want > 0 && want <= maxPage ? want : pagesNow[0] || 0
    const inBox = useRegion && Number(target.page) === page
    if (onKeep({ docPath: cur, page, region: inBox ? target.region : null, made }) !== false) {
      setKeptProbs((cur2) => new Set(cur2).add(i))
    }
  }

  /* ── 追问（2026-09-22，用户原话：「对于问到的答案再加一个追问的功能，学生不懂的话
   *    可以继续问答案哪里是为什么」）────────────────────────────────────────
   *
   * 学生点某道题下面的「💬 继续问」，打一句话（"这一步为什么除以 m"），
   * 老师**接着那道题的答案**讲。
   *
   * ★ 三样东西一起发出去（都在 `askProblemFollowup` 里）：
   *   ① 上一趟画好的那几页页图（`result.shots`，**不重画** —— 见 homework-read.js）；
   *   ② 这道题（题干 + 老师给的答案 + 解析）+ 前面问过的几轮（`problemHistory` 拼的）；
   *   ③ 这一次问的那句话。
   * ★ 为什么必须带 ①②：老师看不见题、也不知道自己刚才写了什么的话，
   *   一句"为什么"它只能凭常识瞎讲 —— 而那是"学生照着背"的东西。
   * ⚠ 单独一个 `asking` 状态：追问是**接着同一段上下文**说的，两问并发时
   *   后一问基于的历史里还没有前一问的回答（两边都从同一个 `turns` 出发），
   *   看起来就是"答非所问"。所以一次只允许一问（别的题的按钮这时候也禁着，
   *   但那不是限制 —— 他一次也只想问一件事）。
   */
  const askFollowup = useCallback(
    async (i) => {
      if (asking >= 0 || busy || !result) return
      const p = result.problems[i]
      if (!p) return
      const q = String(askDraft[i] || '').trim()
      if (!q) {
        say('先写一句你哪里没看懂', 'warn')
        return
      }
      const shots = result.shots || null
      if (!shots || !shots.length) {
        /* 图上没了就别发了 —— 老师看不见题的话，这一问只会得到一段泛泛而谈。
           （正常走不到：`result` 有，`shots` 就有。） */
        say('这一趟找不到作业页的图 —— 把这道题重新做一遍再来追问', 'warn')
        return
      }
      const before = Array.isArray(askTurns[i]) ? askTurns[i] : []
      /* 先把学生那句挂上去（+ 一个"在飞"的占位），再发 —— 这样请求在飞的时候
         学生能看见自己刚问的话，而不是一片空白。 */
      const withQ = [...before, { role: 'user', text: q }, { role: 'assistant', text: '', pending: true }]
      setAskTurns((m) => ({ ...m, [i]: withQ }))
      setAskDraft((m) => ({ ...m, [i]: '' }))
      setAsking(i)
      const ctl = new AbortController()
      followAbortRef.current = ctl
      try {
        const r = await askProblemFollowup({
          shots,
          problem: p,
          /* ★ `turns` 给的是**问这一句之前**的那几轮（`before`），不含刚挂上去的这一问 ——
             `problemHistory` 会把它拼成 `history`，而"这一次问的"由 `question` 单独带
             （服务端把它摆在最后一条 user 消息里，见那边那段"别拼进第 0 条"）。 */
          turns: before,
          question: q,
          signal: ctl.signal,
        })
        setAskTurns((m) => {
          const list = Array.isArray(m[i]) ? m[i].slice() : []
          /* 把尾巴上那条 `pending` 换成结果（下标从后往前找 —— 这中间不会再有人动它，
             但按内容找比按下标写死稳）。 */
          let at = -1
          for (let k = list.length - 1; k >= 0; k -= 1) {
            if (list[k] && list[k].pending) {
              at = k
              break
            }
          }
          const done = r.error
            ? { role: 'assistant', text: r.text || '', error: r.error }
            : { role: 'assistant', text: r.text, note: r.note || '' }
          if (at >= 0) list[at] = done
          else list.push(done)
          return { ...m, [i]: list }
        })
      } finally {
        followAbortRef.current = null
        setAsking(-1)
      }
    },
    [asking, busy, result, askDraft, askTurns]
  )

  /* 学生把刚问的那句撤回来（"我打错了，不问了"）：只对**最后一次**没成的追问有用 ——
     答好了的那几轮不动（那是老师说过的话，撤回它等于篡改对话）。 */
  const dropLastTurn = useCallback((i) => {
    setAskTurns((m) => {
      const list = Array.isArray(m[i]) ? m[i].slice() : []
      const last = list[list.length - 1]
      if (!last || last.pending || !last.error) return m
      /* 连同它前面那句学生问的话一起撤（成对出现的东西成对消失）。 */
      if (list.length >= 2 && list[list.length - 2].role === 'user') list.splice(list.length - 2, 2)
      else list.pop()
      return { ...m, [i]: list }
    })
  }, [])

  /* 回车发、Shift+回车换行。
   * ⚠ 别的键必须 `stopPropagation`：板上那些快捷键挂在 **window** 上，
     不拦住的话在这儿打一个 `e` 就切成橡皮了（「询问框」那一族踩过同样的坑）。
   * ★ **Esc 不在这里管** —— 它由上面那个 document 捕获监听收走。
     写在这儿的话就漏掉了"焦点不在输入框上"的那一半（点过按钮之后正是那样），
     而"按 Esc 关掉浮窗"是用户的第一反应。 */
  const onKeyDown = (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      run()
    }
  }

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
  const style = { transform: `translate(${Math.round(ox)}px, ${Math.round(oy)}px)` }
  const pptHint = !!(origin && origin.fromPpt)

  return (
    <div className="bd-hw" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="bd-hw-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadUp}
        title="拖这里可以挪这个窗（关掉再开，位置回到右上角）"
      >
        <span className="bd-hw-ico">✎</span>
        <span className="bd-hw-title">作业辅导</span>
        <button
          className="bd-hw-x"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            if (onClose) onClose()
          }}
          title="关掉（答案不留在板上，也不写进文件）"
        >
          ✕
        </button>
      </div>

      <div className="bd-hw-body">
        {/* ── ① 作业在哪一份里 ── */}
        <div className="bd-hw-sec">
          <div className="bd-hw-lbl">作业在哪一份里？</div>
          {docs.length > 0 && (
            <div className="bd-hw-docs">
              {docs.map((d) => (
                <button
                  key={d.path}
                  className={'bd-hw-doc' + (d.path === cur ? ' on' : '')}
                  onClick={() => onDoc && onDoc(d.path)}
                  title={d.path}
                >
                  {String(d.title || d.path).replace(/^\.资料\//, '')}
                  <span className="bd-hw-pages">{Array.isArray(d.pages) ? d.pages.length : 0} 页</span>
                </button>
              ))}
            </div>
          )}
          <button className="bd-hw-btn ghost" onClick={onPickFile} disabled={busy || !!uploadBusy} title="PDF / PPT 都行：收进 data/.资料/，并且铺到板上（不用了就从资料条上 ✕ 掉）">
            {uploadBusy || '📄 传一份作业的 PDF…'}
          </button>
          {pptHint && (
            /* ★ 用户点名要的那句话（见文件头）。他挑中的是**讲课的 PPT**，
               而作业在书上 —— 这时候不说，他会拿一份没有作业的课件去问题，
               然后得到一句"这一页上没看到第 3 题"。 */
            <div className="bd-hw-warn">
              这一份看着是<b>讲课用的 PPT</b>（「{String(origin.source || '').replace(/^\.资料\//, '')}」转成 PDF 的）。
              作业一般在书上 —— 如果作业不在这一份里，点上面那颗按钮，把<b>作业所在的那份 PDF</b> 也传上来。
            </div>
          )}
          {!cur && <div className="bd-hw-warn">板上一份资料都没有 —— 先传一份（作业在哪本书/哪份练习册上，就传那一份）。</div>}
        </div>

        {/* ── ② 做哪几道题 ──
             ★ 两种选法（用户 2026-09-22 要的第二种：「选题目允许靠用户圈住题号来实现」）：
               · **圈**：他在板上把题号框住了 → 这里只显示"你圈的是第 N 页上那一块"，
                 输入框退成"补充一句（可留空）"；页号不用写（框本身把它定死了）；
               · **打**：没框住东西 → 照旧写"第 12 页第 3 题"，页码一定要有。 */}
        <div className="bd-hw-sec">
          <div className="bd-hw-lbl">{useRegion ? '你要做的那道题' : '做哪几道题？'}</div>
          {useRegion && (
            <div className="bd-hw-picked">
              <span className="bd-hw-pickmark">红框</span>
              你圈的是<b>第 {target.page} 页</b>上那一块 —— 发给老师的两张图就是"整页（红框标出你圈的地方）+ 那一块放大"。
              <button className="bd-hw-link" onClick={() => onClearTarget && onClearTarget()} title="改成自己写页码和题号">
                改用打字
              </button>
            </div>
          )}
          <textarea
            ref={taRef}
            className="bd-hw-ta"
            rows={2}
            value={ask}
            placeholder={
              useRegion
                ? '要不要再说一句？（可留空）比如「只做第 (2) 问」'
                : '比如「第 12 页第 3 题」——页码一定要有（要说清去翻哪一页）'
            }
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <div className={'bd-hw-read' + (specErr ? ' bad' : '')}>
            {specErr
              ? specErr
              : useRegion
                ? `要翻的是第 ${pagesNow.join('、')} 页（你圈的那一页）`
                : spec.pages.length
                  ? `会翻到第 ${spec.pages.join('、')} 页${spec.pages.length > 1 ? `（一次最多 ${HW_MAX_PAGES} 页）` : ''}`
                  : `一次最多翻 ${HW_MAX_PAGES} 页 —— 一页一张图，都发给模型看`}
          </div>
        </div>

        {/* ── ③ 这节课讲过什么（自动带上） ── */}
        <div className="bd-hw-sec">
          <div className="bd-hw-lbl">结合这节课的知识</div>
          {know.count ? (
            <>
              <div className="bd-hw-know">
                会带上板上 <b>{know.count}</b> 张讲解卡（约 {know.chars} 字）
                {know.truncated ? `，还有 ${know.truncated} 张没带上（太长了）` : ''}
              </div>
              {sources.length > 1 && (
                <select
                  className="bd-hw-select"
                  value={knowPath}
                  onChange={(e) => setKnowPath(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <option value="">板上所有课件的讲义（{know.sources.reduce((n, s) => n + s.count, 0)} 张卡）</option>
                  {sources.map((s) => (
                    <option key={s.path || 'x'} value={s.path}>
                      {String(s.title || s.path).replace(/^\.资料\//, '')}（{s.count} 张卡）
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <div className="bd-hw-none">{HW_NO_LESSON_HINT}</div>
          )}
        </div>

        {/* ── 结果 ── */}
        {(result || err || busy) && (
          <div className="bd-hw-sec bd-hw-out">
            {busy && (
              <div className="bd-hw-busy">
                {step || '正在做…'}
                <button
                  className="bd-hw-stop"
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
              </div>
            )}
            {err && (
              <div className="bd-hw-err">
                <span>{err}</span>
                <button className="bd-hw-retry" onClick={run} title="把这一趟再发一次">
                  ↻ 再试一次
                </button>
              </div>
            )}
            {result && !err && (
              <>
                {result.dropped > 0 && <div className="bd-hw-drop">有 {result.dropped} 条空壳丢掉了（模型只占了个位、没写内容）</div>}
                {!result.problems.length && (
                  <div className="bd-hw-empty">
                    这一趟一道题都没做出来 —— 模型多半觉得这一页上没有你说的那道题。换个写法（页号 + 题号）再试一次，
                    或者先把这一页的图传清楚一点。
                  </div>
                )}
                {result.problems.map((p, i) => (
                  <div className="bd-hw-prob" key={'p' + i}>
                    <div className="bd-hw-probhead">
                      <span className="bd-hw-no">{p.label}</span>
                      {p.page > 0 && <span className="bd-hw-pg">第 {p.page} 页</span>}
                    </div>
                    {p.question && <div className="bd-hw-q" dangerouslySetInnerHTML={{ __html: richHtml(p.question) }} />}
                    {p.answer && (
                      <div className="bd-hw-ans">
                        <div className="bd-hw-tag">答案</div>
                        <div className="bd-hw-rich" dangerouslySetInnerHTML={{ __html: richHtml(p.answer) }} />
                      </div>
                    )}
                    {p.explain && (
                      <div className="bd-hw-exp">
                        <div className="bd-hw-tag">解析</div>
                        <div className="bd-hw-rich" dangerouslySetInnerHTML={{ __html: richHtml(p.explain) }} />
                      </div>
                    )}
                    {/* 「⬇ 留到板上」：这道题（题号 + 题干 + 答案 + 解析）落成页边一张卡。 */}
                    <div className="bd-hw-keeprow">
                      {keptProbs.has(i) ? (
                        <span className="bd-hw-kept">{KEPT_LABEL}</span>
                      ) : (
                        <button
                          className="bd-hw-keep"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            keepProblem(i)
                          }}
                          title="把这道题（题干 + 答案 + 解析）落成板上一张卡（贴在第 N 页右边；Ctrl+Z 能退）"
                        >
                          {KEEP_BUTTON}
                        </button>
                      )}
                    </div>

                    {/* ── 追问：没看懂就接着问（2026-09-22）──────────────
                         ★ 入口就在**这道题下面**（用户要的："每道题下面一个「继续问」"）——
                           一次只问这一道，不串题。 */}
                    <div className="bd-hw-ask">
                      {(askTurns[i] || []).length > 0 && (
                        <div className="bd-hw-turns">
                          {(askTurns[i] || []).map((t, k) => (
                            <div
                              className={'bd-hw-turn' + (t.role === 'user' ? ' me' : '')}
                              key={'t' + k}
                            >
                              {t.role === 'user' ? (
                                <>
                                  <span className="bd-hw-who">我问</span>
                                  <div className="bd-hw-said">{t.text}</div>
                                </>
                              ) : t.pending ? (
                                <div className="bd-hw-thinking">老师正在想…</div>
                              ) : t.error ? (
                                <div className="bd-hw-terr">
                                  <span>{t.error}</span>
                                  <button
                                    className="bd-hw-link"
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      dropLastTurn(i)
                                    }}
                                    title="把这一问撤掉，改一句再问"
                                  >
                                    撤回这一问
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <span className="bd-hw-who">老师</span>
                                  <div
                                    className="bd-hw-rich"
                                    dangerouslySetInnerHTML={{ __html: richHtml(t.text) }}
                                  />
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="bd-hw-askrow">
                        <textarea
                          className="bd-hw-ta sm"
                          rows={1}
                          value={askDraft[i] || ''}
                          placeholder="哪儿没看懂？比如「这一步为什么除以 m」"
                          onChange={(e) => setAskDraft((m) => ({ ...m, [i]: e.target.value }))}
                          onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            /* 板上那些单键快捷键挂在 window 上 —— 不拦住的话在这儿打一个
                               `e` 就切成橡皮了（和上面那个大输入框同一条坑）。 */
                            e.stopPropagation()
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              askFollowup(i)
                            }
                          }}
                          disabled={asking >= 0 || busy}
                        />
                        <button
                          className="bd-hw-btn primary sm"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            askFollowup(i)
                          }}
                          disabled={asking >= 0 || busy || !String(askDraft[i] || '').trim()}
                          title="接着这道题的答案问（老师还看得见题，也看得见它自己刚写的答案）"
                        >
                          {asking === i ? '在问…' : '💬 继续问'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div className="bd-hw-foot">
        <button className="bd-hw-btn primary" onClick={run} disabled={busy || !cur} title="把这几页发给老师，每题要一份答案和解析">
          {busy ? '正在做…' : result ? '↻ 再做一次' : '开始做'}
        </button>
        <span className="bd-hw-hint">
          答案不会自己上板 —— 有用的那几道点「{KEEP_BUTTON}」；没看懂就在那道题下面「💬 继续问」
        </span>
      </div>
    </div>
  )
}
