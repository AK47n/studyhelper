import React, { useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { MAX_ITEMS_TOTAL, groupBySection, pagesLabel, parsePageSpec } from '../lib/doc-cards.js'
import { DOC_STALE_HINT, forgetPage, readDeck } from '../lib/doc-read.js'
import { ocrStatus } from '../lib/ocr.js'

/* ────────────────────────── 课件整理 ──────────────────────────
 *
 * 「把这一节课件整理成知识点，贴到白板上」这个动作的**全部界面**，三个阶段一条线：
 *
 *   ① **挑页**：这一摞页面（上面标着你有没有写过东西）+ 一句页码区间输入。
 *      "整理哪些页"本来就是一句话的事（`1-5, 8, 12-20`），49 页的课件点 30 下太烦；
 *      点缩略图是给"就这几页"用的微调。两条路都通，选中的页高亮。
 *   ② **读**：边读边填。每页一块：左边是**发给模型的那张图**（和 DocPage 显示的是
 *      同一套渲染，只是档位不同），右边是机器提炼出来的几条，当页就能改。
 *      单页失败只影响那一页（「↻ 重读这一页」），随时能停
 *      —— 中止的是**后面的请求**，已经发出去的那几次拦不住（如实写着）。
 *   ③ **贴**：改完勾完点「贴到白板上」，卡片才真的落板。
 *      ⚠ 落板是**一步撤销**（Board.jsx 那边一次 commit）—— 贴歪了 Ctrl+Z 全退。
 *
 * ── 为什么要有这个窗口（不能直接贴）────────────────────────────────────
 * 和整板转录那条路同一个理由：**模型一定会读错一点**（数字、上下标、专有名词），
 * 而这一批卡片是要**当起点用**的 —— 起点错了，后面写的全跟着错。
 * 与其等你回到板上发现某张卡不对、再回头翻 PPT，不如在这里并排摆好看一眼。
 * 所以这里不追求"全自动"，追求的是**改一个字只要一下**。
 *
 * ── 几条从"坑"里来的规矩 ──────────────────────────────────────────────
 * ★ **进来的那一刻就发请求**（不等你点第二次）：等待从"盯着一个遮罩"变成
 *   "可以一边看图一边等"，和 TranscribeReview 第 3 步同一条手感。
 * ★ **一页一次调用**（doc-read.js）：失败只影响那一页、进度一页页地长、
 *   重试的粒度是一页。所以这个窗口里"页"就是天然的单元，不要按"批"显示。
 * ★ **没读出知识点的页不算错**：封面页、目录页、章节过渡页本来就没有知识点
 *   （模型回 `points: []`）。它们不该报红，只该显示"这页没有知识点"。
 * ★ **Esc / 点外面 = 先不收**：停掉还在等的请求，一个字都不写。
 */

const KATEX_OPTS = { throwOnError: false, displayMode: true, strict: false, trust: false }

/** 一条公式现排一次（和卡片显示**同一组参数** —— 免得"这里能排、贴上去变红字"）。 */
function texHtml(tex) {
  try {
    return katex.renderToString(String(tex || ''), KATEX_OPTS)
  } catch {
    return null
  }
}

export default function DeckReview({ doc, onCancel, onConfirm, defaultPages = null, onOpenSettings = null }) {
  const pageCount = doc && Array.isArray(doc.pages) ? doc.pages.length : 0
  const title = (doc && (doc.title || (doc.path || '').split('/').pop().replace(/\.pdf$/i, ''))) || '课件'

  const [phase, setPhase] = useState('pick') // pick | read | done
  const [prog, setProg] = useState({ done: 0, total: 0, failed: 0, cached: 0 })
  const [pages, setPages] = useState({}) // page -> { page,status,unit,items,error,kind,img,cached,parseFailed }
  const [del, setDel] = useState({}) // itemId -> true（删掉的）
  const [edit, setEdit] = useState({}) // itemId -> {title,body,tex}
  const [unitName, setUnitName] = useState({}) // unitId -> 改过的小节名
  const [rangeText, setRangeText] = useState('')
  /* 预选页：**只在打开那一刻算一次**（`useState` 的惰性初值）。
     `defaultPages` 是 Board 每次渲染新造的数组 —— 照着它同步的话，
     你在窗口里改过的选择会被下一次渲染悄悄抹掉。 */
  const [picked, setPicked] = useState(() => new Set((defaultPages || []).map(Number).filter((n) => n >= 1)))
  /* ★ **这一趟到底读了哪几页** —— 从按下「读这几页/全部」那一刻就定下来，之后不再变。
     为什么不复用下面那个 `picked`（挑页界面上选中的）：读数那一半全靠它 ——
     读的时候用户还能在挑页那一摞上点来点去，而"读的是哪几页"是既成事实。
     2026-09-22 自检当场抓到的就是这个：`picked` 被清空之后，`pages` 里明明有两页的结果，
     窗口里却一块都不显示（两边各说各的，还都不报错）。 */
  const [readPages, setReadPages] = useState(null)
  const [err, setErr] = useState(null)
  /* 这一条拦路的话是不是"配置问题"（没填密钥/换了家服务）——
     是的话在旁边摆一颗「去设置」，别让用户自己去找那颗按钮在哪。 */
  const [errConfig, setErrConfig] = useState(false)
  const abortRef = useRef(null)
  const shotsRef = useRef(new Map()) // page -> objectURL（收摊时统一 revoke）

  /* 一页读完 → 塞进表里（**按页号**存，所以回来晚的那一页不会打乱顺序）。
     ★ 这一趟真画出来的那张 blob 直接转成 objectURL 给 <img> 用 ——
       不再重画第二遍（校对看的图和发出去的图**是同一张**，一字不差）。
     ⚠ 缓存命中的那一页没有 img：那说明这一趟一个字节都没发，当然也没有图。
     ⚠⚠ 页号**统一成 number 当键**：`chosen` 里全是 number，而对象取键会给字符串 ——
       两边对不上的表现是"读完了、一条都没显示"（2026-09-22 自检当场抓到的就是这个）。 */
  const onPage = (info) => {
    const page = Number(info.page)
    const url = info.img ? URL.createObjectURL(info.img.blob) : null
    if (url) shotsRef.current.set(page, url)
    setPages((cur) => ({ ...cur, [page]: { ...info, page, url } }))
  }

  const stop = () => {
    if (abortRef.current) abortRef.current.abort()
    abortRef.current = null
  }

  /* 收摊：停掉还在等的请求，并把这一趟造出来的 objectURL 全放掉
     （不 revoke 的话，几十张 300KB 的图会一直占着内存到刷新页面）。 */
  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.abort()
      for (const url of shotsRef.current.values()) URL.revokeObjectURL(url)
      shotsRef.current.clear()
    },
    []
  )

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      stop()
      onCancel && onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel])

  /* 选中的页（去重、排序）。挑页阶段是手选 + 区间输入两路的并集。 */
  const chosen = useMemo(() => [...picked].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b), [picked, pageCount])
  /* 读/贴那两个阶段显示的是 `readPages`（既成事实）；挑页阶段才看 `picked`。 */
  const wantPages = readPages && readPages.length ? readPages : chosen

  const startRead = async (list) => {
    const want = (Array.isArray(list) && list.length ? list : chosen).slice()
    if (!want.length) {
      setErr('先挑几页 —— 点缩略图，或者在上面写「1-12」这样的区间。')
      return
    }
    /* ★ **先问一句"这条路通不通"，再一页一页地发。**
       为什么值得多这一次往返：49 页的课件要发 49 次，而"没配密钥/服务端是旧版/
       这家服务干不了这件事"这三种失败**每一页都会同样地发生** ——
       不问这一句，用户要看着进度条一页一页地失败到第 49 页，才知道自己没填 key。
       三件事在这一句里一次问清：开着吗（enabled）、配了吗（configured）、
       这家服务干得了这件事吗（modes 里有没有 doc）。 */
    let st = null
    try {
      st = await ocrStatus()
    } catch {
      /* 连不上本地服务：交给下面那一页一页的路去报（那种失败是网络问题，不是配置问题） */
    }
    if (st && st.ok) {
      if (st.enabled === false) {
        setErr('手写识别被关掉了 —— 整理课件走的是同一个识别服务，去「手写识别设置」里打开它。')
        setErrConfig(true)
        return
      }
      if (st.configured === false) {
        setErr('还没配识别服务的密钥 —— 这份课件发不出去。先去「手写识别设置」里填一个 DeepSeek 的 key（整板转录、结构整理用的是同一个）。')
        setErrConfig(true)
        return
      }
      const p = st.providers && st.providers[st.provider]
      if (p && Array.isArray(p.modes) && !p.modes.includes('doc')) {
        setErr(
          p.formulaOnly
            ? `${p.label || st.provider} 只认公式，课件整理要用 DeepSeek —— 去「手写识别设置」里换一家。`
            : `本地服务还是旧版：它不知道「课件整理」这个口。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后再点一次。`
        )
        setErrConfig(!!p.formulaOnly)
        return
      }
    }
    setErr(null)
    setErrConfig(false)
    setReadPages(want)
    setPhase('read')
    setPages({})
    setProg({ done: 0, total: want.length, failed: 0, cached: 0 })
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await readDeck({
        path: doc.path,
        pages: want,
        signal: ac.signal,
        onPage,
        onProgress: (p) => setProg(p),
      })
    } finally {
      abortRef.current = null
      setPhase((cur) => (cur === 'read' ? 'done' : cur))
    }
  }

  /* 「重读这一页」：先忘掉缓存（那颗按钮的意思就是"上次那个我不信"），再单独读它。
     ⚠ 只有这一页在飞，别的页一个字都不动 —— 那是"一页一次调用"挣来的。 */
  const reread = async (page) => {
    const n = Number(page)
    forgetPage(doc.path, n)
    /* ⚠ 键也是 number（见 onPage 那条）—— 删错了的表现是"点了重读，那一页没变"。 */
    setPages((cur) => {
      const next = { ...cur }
      delete next[n]
      return next
    })
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await readDeck({ path: doc.path, pages: [n], signal: ac.signal, onPage, concurrency: 1 })
    } finally {
      abortRef.current = null
    }
  }

  /* ── 把读到的页拼成小节（纯函数在 doc-cards.js：窗口和落卡认同一份） ──
     `unit` 取这一页**自己那一节**的名字（一页一次调用，所以最多一节；模型偶尔回两节时
     取第一节的名字，条目按各自的 sectionId 归位）。 */
  const list = useMemo(
    () =>
      Object.values(pages)
        .sort((a, b) => a.page - b.page)
        .map((p) => ({
          page: p.page,
          unit: (p.sections && p.sections[0] && p.sections[0].name) || '',
          items: p.items || [],
        })),
    [pages]
  )
  const { units, items } = useMemo(() => groupBySection(list), [list])

  /* 一条知识点在窗口里显示成什么（改过的用改过的）。 */
  const shown = (it) => {
    const e = edit[it.id]
    return e ? { ...it, ...e } : it
  }
  const kept = items.filter((it) => !del[it.id])
  const unitNameOf = (u) => (unitName[u.id] != null ? unitName[u.id] : u.name)
  const overCap = kept.length > MAX_ITEMS_TOTAL ? kept.length - MAX_ITEMS_TOTAL : 0

  const confirm = () => {
    const out = kept.slice(0, MAX_ITEMS_TOTAL).map((it) => {
      const s = shown(it)
      return {
        id: it.id,
        unitId: it.unitId,
        kind: s.kind,
        title: s.title,
        body: s.body,
        tex: s.tex || '',
        page: it.page,
      }
    })
    const outUnits = units
      .map((u) => ({ id: u.id, name: unitNameOf(u), pages: u.pages }))
      .filter((u) => out.some((i) => i.unitId === u.id))
    onConfirm && onConfirm({ pages: wantPages, units: outUnits, items: out })
  }

  const failed = Object.values(pages).filter((p) => p.status === 'error')
  const stopped = phase === 'done' && prog.done < prog.total
  const readTotal = prog.total || chosen.length
  /* 每一页的节名（诊断用 + 渲染用的是同一个值）—— 见下面 .dkr-unit 那一行。 */
  const unitTextOf = (mine) => {
    const uid = mine && mine.length ? mine[0].unitId : null
    const unit = uid ? units.find((u) => u.id === uid) : null
    return unit ? unitNameOf(unit) : ''
  }

  return (
    <div className="dkr-back" onPointerDown={(e) => e.target === e.currentTarget && (stop(), onCancel && onCancel())}>
      {/* 蹭 .wp 那一组样式（和转录校对同一个路子），宽度差异由 .dkr 覆盖。 */}
      <div className="wp dkr" role="dialog" aria-label="课件整理">
        <div className="wp-head">
          <b>课件整理 · {title}</b>
          <span className="dim small">
            {phase === 'pick'
              ? `这份资料一共 ${pageCount} 页 —— 挑一段，整理成知识点贴到白板上`
              : phase === 'read'
                ? `正在一页一页读（${prog.done}/${readTotal}）—— 读好的那页可以直接改`
                : `读完了（${prog.done}/${readTotal}${prog.cached ? `，其中 ${prog.cached} 页是上次读过的` : ''}）—— 改完点右下角贴到板上`}
          </span>
          {phase === 'read' && (
            <button className="mini" onClick={stop} title="中止**后面的**请求；已经发出去的那几次拦不住（服务端还在跑，那几次的钱也照花）">
              ■ 停止
            </button>
          )}
          <button className="wp-x" onClick={() => (stop(), onCancel && onCancel())} title="先不整理（Esc）">×</button>
        </div>

        {/* ── 挑页：一条区间输入 + 一摞缩略图 ── */}
        {phase === 'pick' && (
          <div className="dkr-pick">
            <div className="dkr-pickrow">
              <span className="dim small">整理哪几页：</span>
              <input
                className="dkr-range"
                placeholder={`比如 1-12、或 3,5,8-20（这份资料一共 ${pageCount} 页）`}
                value={rangeText}
                spellCheck={false}
                /* ★ 一边打一边就把选中改掉（不是等回车才生效）。
                   为什么：这一行和下面那一摞页码按钮**说的是同一件事**，
                   两处各存一份的话必然对不上 —— 用户打了「1-12」却看见缩略图上
                   亮的还是刚才点的那几页，然后按「读这几页」读的是哪一个？
                   （2026-09-22 自检就撞上了这个：清空之后打区间、按按钮，读的是空选中。）
                   现在只有一个真相：这一行打进去什么，选中就是什么。 */
                onChange={(e) => {
                  const v = e.target.value
                  setRangeText(v)
                  const got = parsePageSpec(v, { max: pageCount })
                  if (got.length) {
                    setPicked(new Set(got))
                    setErr(null)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  /* 回车 = 直接开读。`chosen` 此刻已经跟着上面那次 onChange 更新过了，
                     所以这里拿的就是"框里写的那个区间"（不用再 parse 一遍）。 */
                  const got = parsePageSpec(rangeText, { max: pageCount })
                  if (got.length) startRead(got)
                  else setErr('这个区间没看懂 —— 写成「1-12」或者「3,5,8-20」这样。')
                }}
              />
              <button
                className="mini"
                onClick={() => {
                  const got = parsePageSpec(rangeText, { max: pageCount })
                  if (got.length) startRead(got)
                  else setErr('这个区间没看懂 —— 写成「1-12」或者「3,5,8-20」这样。')
                }}
                disabled={!rangeText.trim()}
              >
                读这几页
              </button>
              <button className="mini" onClick={() => startRead(Array.from({ length: pageCount }, (_, i) => i + 1))} title={`全部 ${pageCount} 页（要读一会儿）`}>
                全部 {pageCount} 页
              </button>
              <span className="dim small">已选 {chosen.length} 页{chosen.length ? '：' + pagesLabel(chosen) : ''}</span>
              <button className="mini" onClick={() => setPicked(new Set())} disabled={!chosen.length}>清空</button>
            </div>
            <div className="dkr-pages">
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  className={'dkr-pg' + (picked.has(n) ? ' on' : '')}
                  onClick={() =>
                    setPicked((cur) => {
                      const next = new Set(cur)
                      if (next.has(n)) next.delete(n)
                      else next.add(n)
                      return next
                    })
                  }
                >
                  <span className="dkr-pg-n">{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {err && (
          <div className="dkr-warn">
            {err}
            {errConfig && onOpenSettings && (
              <button className="mini dkr-goset" onClick={onOpenSettings}>
                去「手写识别设置」
              </button>
            )}
          </div>
        )}
        {failed.length > 0 && (failed.some((f) => f.kind === 'stale') ? (
          <div className="dkr-warn">{DOC_STALE_HINT}</div>
        ) : (
          <div className="dkr-warn">
            有 {failed.length} 页没读出来（下面标红的那几页）。别的页照样读完了 —— 点那一页的「↻ 重读这一页」再试一次。
          </div>
        ))}
        {stopped && <div className="dkr-warn">停在第 {prog.done} 页 —— 已经读好的那几页照样能贴（想补读就再点一次整理）。</div>}
        {overCap > 0 && <div className="dkr-warn">知识点太多了（{kept.length} 条），一次最多贴 {MAX_ITEMS_TOTAL} 条 —— 后面 {overCap} 条这次不会贴上去。</div>}

        {/* ── 读 / 贴：一页一块 ── */}
        {phase !== 'pick' && (
          <div className="dkr-body">
            {wantPages
              .filter((n) => pages[n])
              .map((n) => {
                const p = pages[n]
                /* ★ 这一页的知识点取**分组之后**那一份（`items`），不是 `p.items`。
                   为什么：`unitId`（"这一页属于哪一节"）是 `groupBySection` 才编上的 ——
                   它得先看到"这一页的 unit 名 + 上一页的 unit 名"才知道两页是不是一节。
                   拿 `p.items` 去取 unitId 永远是 undefined，表现就是**小节名一个字都不显示**
                   （2026-09-22 自检抓到的第二处：数据里明明有 `du1:力与运动`，屏幕上没有）。
                   顺带：`items` 的顺序就是页序，所以这一页那几条在它里面是连续的一段。 */
                const mine = items.filter((it) => it.page === n)
                const unitText = unitTextOf(mine)
                /* "这页没有知识点"看的是**这一页原本读出来几条**（`p.items`）——
                   不能看 `mine`：那里面已经把被删掉的条目也算进去了，
                   而你删光一页的条目时，那一页不该冒出一句"这页没有知识点"。 */
                const rawCount = (p.items || []).length
                return (
                  <section className={'dkr-pgblk' + (p.status === 'error' ? ' bad' : '')} key={n}>
                    <div className="dkr-pgh">
                      <b>第 {n} 页</b>
                      {unitText ? <span className="dkr-unit">{unitText}</span> : null}
                      {p.cached ? <span className="trv-tag ok" title="这一页的内容没改过，直接用上次读的 —— 这次没有发请求">上次读的</span> : null}
                      {p.parseFailed ? <span className="trv-tag">没按格式回话</span> : null}
                      {p.status === 'ok' && !rawCount && !p.parseFailed ? <span className="dim small">这页没有知识点（封面/目录/过渡页？）</span> : null}
                      {p.status === 'error' ? <span className="dkr-err">{p.error}</span> : null}
                      <button className="mini dkr-retry" onClick={() => reread(n)} title="只重发这一页（绕开缓存）">↻ 重读这一页</button>
                    </div>
                    <div className="dkr-img">
                      {p.url ? (
                        <img src={p.url} alt={'第 ' + n + ' 页'} />
                      ) : (
                        <span className="dim small">{p.cached ? '（上次读的，这次没重画图）' : p.status === 'error' ? '（这页没读出来）' : '（没画出图）'}</span>
                      )}
                    </div>
                    <div className="dkr-items">
                      {mine.map((it) => {
                        const s = shown(it)
                        const gone = !!del[it.id]
                        return (
                          <div className={'dkr-item' + (gone ? ' off' : '')} key={it.id}>
                            <div className="dkr-itemrow">
                              <span className="dkr-kind">{it.kind === 'formula' ? '公式' : '知识点'}</span>
                              {it.kind === 'formula' ? (
                                <div className="dkr-texprev" dangerouslySetInnerHTML={{ __html: texHtml(s.tex) || `<span class="bd-tex-bad">${escapeHtml(s.tex)}</span>` }} />
                              ) : (
                                <input
                                  className="dkr-t"
                                  value={s.title}
                                  spellCheck={false}
                                  placeholder="（没有标题）"
                                  onChange={(e) => setEdit((c) => ({ ...c, [it.id]: { ...s, title: e.target.value } }))}
                                />
                              )}
                              <button
                                className="mini"
                                onClick={() => setDel((c) => ({ ...c, [it.id]: !gone }))}
                                title={gone ? '这条不要了？点一下收回来' : '这条不要贴到板上'}
                              >
                                {gone ? '↺ 收回' : '✕ 不要'}
                              </button>
                            </div>
                            {it.kind === 'formula' ? (
                              <input
                                className="dkr-tex"
                                value={s.tex}
                                spellCheck={false}
                                onChange={(e) => setEdit((c) => ({ ...c, [it.id]: { ...s, tex: e.target.value } }))}
                              />
                            ) : (
                              <textarea
                                className="dkr-b"
                                value={s.body}
                                spellCheck={false}
                                rows={Math.min(4, Math.max(2, Math.ceil([...String(s.body || '')].length / 42)))}
                                placeholder="（没有说明）"
                                onChange={(e) => setEdit((c) => ({ ...c, [it.id]: { ...s, body: e.target.value } }))}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            {phase === 'read' && prog.done < readTotal && (
              <section className="dkr-pgblk pending">
                <div className="dkr-pgh">
                  <b>正在读…</b>
                  <span className="dim small">还剩 {readTotal - prog.done} 页（{prog.done}/{readTotal}）</span>
                </div>
              </section>
            )}
          </div>
        )}

        <div className="wp-acts dkr-acts">
          <span className="dim small">
            {phase === 'pick' ? (
              '挑好页点「读这几页」—— 这一趟会把那几页的图发到识别服务（DeepSeek），一页一次'
            ) : (
              <>
                {kept.length} 条会贴到白板上（公式落成公式卡）
                {units.some((u) => unitNameOf(u)) ? `，分成 ${units.filter((u) => unitNameOf(u)).length} 个小节` : ''}
                {' —— 一条都不要了就点它的「✕ 不要」'}
              </>
            )}
          </span>
          <button className="mini" onClick={() => (stop(), onCancel && onCancel())}>先不整理</button>
          <button className="btn primary" disabled={phase === 'pick' || !kept.length} onClick={confirm} title={phase === 'pick' ? '先挑页、读一遍' : ''}>
            {phase === 'read' ? '读完了就贴（还剩 ' + Math.max(0, readTotal - prog.done) + ' 页）' : '贴到白板上'}
          </button>
        </div>
      </div>
    </div>
  )
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

