import React, { useEffect, useMemo, useRef, useState } from 'react'
import { katexHtml } from '../lib/renderMath.js'
import { MAX_ITEMS_TOTAL, groupBySection, pagesLabel, parsePageSpec } from '../lib/doc-cards.js'
/* ⚠ 这里只 import **真正用到的**那几样（`SUMMARY_KIND` / `RULES_KIND` 用来给条目标签；
 *  `normalizeSummary` / `normalizeRules` 是两张卡各自的归一；`summaryInput` 是它们共用的输入）。
 *  `isSummary` / `isDeckLevel` / `SUMMARY_TITLE` / `RULES_TITLE` **这个窗口用不上**：
 *  它们要么是落卡那边（Board.jsx）的判据、要么是卡上的标题 ——
 *  窗口里两块自己的标题写在 `deckBlock` 的调用点上（'这一节课的提纲' / '做题须知'）。
 *  `vite build` 不会因为多 import 一个就报错（tree-shake 会带走），
 *  但读的人会以为这里也在用它们 —— 而"以为在用"正是下一次改错的开头。 */
import { RULES_KIND, SUMMARY_KIND, normalizeRules, normalizeSummary, summaryInput } from '../lib/doc-summary.js'
import { DOC_STALE_HINT, deckDonePages, donePagesLocal, forgetDeck, forgetPage, forgetSummary, hasDeckPage, readDeck, readSummary } from '../lib/doc-read.js'
import { ocrStatus } from '../lib/ocr.js'
import { addUsage, usageText } from '../lib/usage.js'

/* ────────────────────────── 课件整理 ──────────────────────────
 *
 * 「让老师把这一节课件逐页讲一遍，讲解贴到那一页旁边」这个动作的**全部界面**，
 * 三个阶段一条线：
 *
 *   ① **挑页**：这一摞页面（上面标着你有没有写过东西）+ 一句页码区间输入。
 *      "讲哪些页"本来就是一句话的事（`1-5, 8, 12-20`），49 页的课件点 30 下太烦；
 *      点缩略图是给"就这几页"用的微调。两条路都通，选中的页高亮。
 *   ② **讲**：边讲边填。每页一块：左边是**发给模型的那张图**（和 DocPage 显示的是
 *      同一套渲染，只是档位不同），右边是老师讲的话（讲解 + 重点 + 公式），当页就能改。
 *      单页失败只影响那一页（「↻ 重讲这一页」），随时能停
 *      —— 中止的是**后面的请求**，已经发出去的那几次拦不住（如实写着）。
 *   ③ **贴**：改完勾完点「贴到白板上」，卡片才真的落板：
 *      **讲解贴这一页右边、重点和公式贴左边**（doc-cards.js 的 projectDeck）；
 *      **整节课那两张（提纲、做题须知）贴在第一页左边**（doc-summary.js 的 placeDeckCard）。
 *      ⚠ 落板是**一步撤销**（Board.jsx 那边一次 commit）—— 贴歪了 Ctrl+Z 全退。
 *
 * ── 整节课那一层的两张卡（2026-09-22 加的）──────────────────────────────
 * 用户原话之一：「讲解 ppt 最后给一个总结，这个总结你自己想想该怎么写包含什么比较好，
 *   现在只是讲解每一页」。前两趟都是"一页一课"，学生合上课件之后手里没有线的另一头；
 * 提纲就是那一头。
 * 用户原话之二（同一天，把它变成了**两张卡**）：「我需要这个总结一方面用于自己看，
 *   还有一方面我在思考现在的老师做题无法吸纳一整节课的卡片因为太多了，
 *   但是有这个总结会不会好很多」——于是又多了「做题须知」（口径，给做题那一趟看）。
 * 两样的分工和"为什么必须分开"写在 doc-summary.js 的 RULES_KIND 那一段里。
 * 接口上的事实（改这块之前必须知道）：
 *   · 它们是**第二趟调用**（`readSummary`，一份课件一次），所以在 `read` 那一屏跑完
 *     逐页之后才发起 —— 输入就是逐页的产出（`summaryInput` 拼的摘要）；
 *   · **两张卡共用那一份摘要**（同一个 `input`、连着发两个 `kind`）—— 不是重读一遍课件；
 *   · 它们**失败不算整理失败**：逐页那些卡片照样贴得上去，这里只是"这次没生成"；
 *   · 它们在界面上**没有"第几页"**（`page: 0`），所以不进任何一页那一块，
 *     各自单独一块贴在最后，而且**那一块的显示不能靠 `items.filter(page === n)`** ——
 *     那种写法会让它一块都不显示（`wantPages` 里根本没有 0）。
 *
 * ── `doc` 是从哪来的（两路）────────────────────────────────────────────
 *   · **板上的资料**（工具条那颗按钮 / 资料条上的「✧ 整理」）；
 *   · **用户直接选的文件**（板上没有课件时，那颗按钮开的就是选文件那个框）——
 *     2026-09-20 起这条路也**把课件铺到板上**：讲解是贴着每一页摆的，页上不了板就没地方贴。
 *   两条路在这个窗口里长得一模一样（挑页 → 讲 → 贴）：窗口只管"讲"，
 *   摆在哪儿是 Board 的事（`placeDeckCards`），这里一个字都不掺和。
 *   「📄 换一份文件…」= 请 Board 再走一趟第二路（换完这个窗口整个重开，状态不带过去）。
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
 * ★ **讲不出东西的页不算错**：封面页、目录页、章节过渡页本来就没得讲
 *   （模型回空串）。它们不该报红，只该显示"这页没什么可讲的"。
 * ★ **Esc / 点外面 = 先不收**：停掉还在等的请求，一个字都不写。
 */

const KATEX_OPTS = { throwOnError: false, displayMode: true, strict: false, trust: false }

/** 一条公式现排一次（和卡片显示**同一组参数** —— 免得"这里能排、贴上去变红字"）。
 *  ★ 走 `renderMath.js` 那一份（带缓存：翻回已经看过的那一页，式子不用重排）。 */
function texHtml(tex) {
  return katexHtml(String(tex || ''), KATEX_OPTS)
}

/* ★ 默认选中里**剔掉已经讲过的页**（2026-09-30，用户原话：「讲解ppt的时候不要默认选中已经讲过的页」）。
 *
 * 病根：从前默认就是"这一份的每一页"（`defaultDeckPages` 全选）—— 于是第二次打开
 * 同一个课件整理窗口，上次讲过的那 20 页照样亮着，点下去就再付一遍钱。
 * 讲过的页本来就有稿子（内存 / localStorage / 盘上三层，见 doc-read.js），
 * 默认再选一遍等于把已经买过的东西买第二次。
 *
 * ⚠ 剔完**一个不剩**就原样退回（整份都讲过的时候）：那种情况下"打开窗口一片空白"
 *   比"全选"更难懂 —— 全不选的话用户连"它是不是坏了"都分不清；而他已经讲过整份，
 *   这时候全选也不会让他多花冤枉钱之外的东西（想重讲哪一页自己点上去就行）。 */
function dropDonePages(base, done) {
  if (!done || !done.size) return base
  const next = new Set([...base].filter((n) => !done.has(n)))
  return next.size ? next : base
}

/** 两个集合是不是同一个（用来判断"用户有没有自己动过选择"）。 */
function sameSet(a, b) {
  if (!a || !b || a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export default function DeckReview({ doc, onCancel, onConfirm, defaultPages = null, onOpenSettings = null, onPickFile = null }) {
  const pageCount = doc && Array.isArray(doc.pages) ? doc.pages.length : 0
  const title = (doc && (doc.title || (doc.path || '').split('/').pop().replace(/\.pdf$/i, ''))) || '课件'

  const [phase, setPhase] = useState('pick') // pick | read | done
  const [prog, setProg] = useState({ done: 0, total: 0, failed: 0, cached: 0, usage: null })
  const [pages, setPages] = useState({}) // page -> { page,status,unit,items,error,kind,img,cached,parseFailed }
  const [del, setDel] = useState({}) // itemId -> true（删掉的）
  const [edit, setEdit] = useState({}) // itemId -> {title,body,tex}
  const [unitName, setUnitName] = useState({}) // unitId -> 改过的小节名
  const [rangeText, setRangeText] = useState('')
  /* 这一份资料**已经讲过哪几页**（挑页那一屏拿它剔掉默认选中、也拿它说那句话）。
     ★ 先给本地两层那份（同步就有，首屏那一帧就要用），下面那个 effect 再把
       **盘上**那份补进来 —— 盘上那份要一个往返，等它回来的工夫用户可能已经动过手了。 */
  const [donePages, setDonePages] = useState(() => donePagesLocal(doc.path))
  /* 预选页：**只在打开那一刻算一次**（`useState` 的惰性初值）。
     `defaultPages` 是 Board 每次渲染新造的数组 —— 照着它同步的话，
     你在窗口里改过的选择会被下一次渲染悄悄抹掉。
     ★ 算完就**剔掉讲过的那些页**（`dropDonePages`）—— 见它上面那条注。 */
  const pickedFirst = useRef(null)
  const [picked, setPicked] = useState(() => {
    const base = new Set((defaultPages || []).map(Number).filter((n) => n >= 1))
    const got = dropDonePages(base, donePages)
    pickedFirst.current = got
    return got
  })
  /* ★ **这一趟到底读了哪几页** —— 从按下「读这几页/全部」那一刻就定下来，之后不再变。
     为什么不复用下面那个 `picked`（挑页界面上选中的）：读数那一半全靠它 ——
     读的时候用户还能在挑页那一摞上点来点去，而"读的是哪几页"是既成事实。
     2026-09-22 自检当场抓到的就是这个：`picked` 被清空之后，`pages` 里明明有两页的结果，
     窗口里却一块都不显示（两边各说各的，还都不报错）。 */
  const [readPages, setReadPages] = useState(null)
  /* ── 整节课那两张卡（2026-09-22）：和下面那个请求的三种状态 ──
     `sum` = 提纲，`rls` = 做题须知。每个都是
     null 还没生成 / {status:'run'} 正在生成 / {status:'ok', items} / {status:'error', error, kind}
     ★ 它们**不放进 `pages`**（那张表是按页号做键的，它们没有页号）。
     ★ 它们**都可改可删**，改动的存法和逐页那些条目一样走全局的 `edit` / `del` ——
       所以 `del[item.id]` 就是「✕ 不要」，不用为它们单开一套状态。
     ★ 两个 state 而不是一个数组：两块的标题、提示语、错误话术都不一样，
       合成一个数组之后每处渲染都要再按 kind 分一次（那是"判两遍"）。
     ⚠ 但**请求那一段是共用的**（`genSummary` 收了 `kind`）——
       两条一模一样的 fetch 逻辑抄两遍，改一处忘一处是**静默**的（见 doc-read.js）。 */
  const [sum, setSum] = useState(null)
  const [rls, setRls] = useState(null)
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

  /* ── 退出这道闸（2026-09-23）──────────────────────────────────────────────
   * 用户原话：**「只要我课件整理的时候不小心点到旁边直接就退出了太烦了白花钱」**。
   *
   * 病根：这个窗口的关闭口有三个 —— 点旁边那片暗底（`.dkr-back` 的
   * `onPointerDown`）、按 Esc、点右上角那个 ×／「先不整理」。三个都**直接
   * `onCancel()`**，而 `onCancel` 在 Board 那边就是 `setDeckFor(null)`：
   * 窗口整个卸载，读过的几十页**连同已经花掉的钱**一起没了，而且不可逆
   * （再点一次「课件整理」是从头再读一遍，钱再花一遍）。
   * 而 `.dkr` 是 `min(1200px, 97vw)` × `max-height: 94vh` —— 屏幕上只剩
   * **一条窄边**是暗底，鼠标奔着别的按钮去的时候极容易蹭到，这就是"不小心"。
   *
   * ★ 判据：**"有没有已经花掉的东西"决定要不要拦。**
   *   · 还没开读（`phase === 'pick'` 且一张结果都没有）→ 什么都没有，直接走，
   *     **不打扰**（这时候取消是零成本，弹框只是碍事）。
   *   · 开读过、或已经有结果/正在读 → **必须问一句**。默认停在"继续整理"上：
   *     误点的代价是"再点一次继续"，而错的代价是"钱白花 + 几十页白读"——
   *     两者不对称，默认就该偏贵的那一边。
   *
   * ⚠ 为什么用 `window.confirm` 而不是 App 那个 `ask()`：
   *   那个 `ask` 活在 App 的作用域里（`Board` 都没拿到它，只有 `treeCtx` 那一路）。
   *   要用它得把回调从 App 一路穿到 Board 再穿进这个组件，而这里要的只是一句
   *   **同步的是/否** —— 为它开一条跨三层的 prop 通道不划算。
   *   `window.confirm` 是**同步**的，也正合这道闸的性子：它拦在事件处理器里，
   *   必须当场拿到答案才能决定要不要 `onCancel()`。
   *
   * ⚠ 判据要**算成"值不值得拦"**，别只看 `phase`：读完之后 `phase` 还是 'read'，
   *   但那时用户可能已经把几十条都删光、只想退出 —— 那种情况下拦他也没意义，
   *   不过"已经花过钱"这件事仍然成立（钱花在读上，不在留了几条上），
   *   所以这里**不**按 kept 的数量放宽：花了就是花了，问一句是应该的。 */
  const hasPaidWork = phase !== 'pick' || Object.keys(pages).length > 0 || prog.done > 0
  const leave = () => {
    if (hasPaidWork && !window.confirm('这就退出「课件整理」？\n\n已经讲过的内容不会留在板上 —— 再进来要从头讲一遍（会再花一次钱）。')) return
    stop()
    onCancel && onCancel()
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
      /* ★ Esc 也走 `leave()`（那道闸）—— 它和"点旁边"是**同一个误触**：
         Esc 就在手指边上，而这条路上已经有几十页花钱读来的东西。 */
      leave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, hasPaidWork])

  /* 打开（或换了一份文件重开）就把光标放进"整理哪几页"那一行 ——
     这条路最常见的用法就是用户那句「我告诉你是需要第几页到第几页」，
     那么窗口一出来就该能直接打字（打 `1-12` 回车就走），不该再点一下输入框。
     ⚠ 只在挑页那一屏做：读数那一屏根本没有这一行；窗口是靠 key 换的（见 Board.jsx），
       所以这里 `[phase]` 不会有"回到挑页"那一趟。
     ⚠⚠ **这里从前还要顺手 `forgetDeck` 清掉整份讲稿缓存**（2026-09-30 撤掉）：
       那一下会把几十页花真钱买来的讲稿（连盘上 `data/.资料/.已读/` 那份）一起删掉 ——
       哪怕你只是打开看一眼就退出。更要命的是"哪些页讲过"也跟着没了，
       于是下一次打开还是全选（这次改的"别默认选讲过的"就白改了）。
       ★ 现在改成**开读的时候只忘这一趟挑中的那几页**（见 `startRead`）——
         "讲这几页"那颗按钮的字面意思保住了，别的页的稿子不动。 */
  const rangeRef = useRef(null)
  useEffect(() => {
    if (phase !== 'pick') return
    rangeRef.current?.focus()
  }, [phase, doc.path])

  /* 盘上那一层讲稿（换电脑 / 清了浏览器数据之后唯一还在的那份）也要算进"讲过哪些页" ——
     它比本地两层晚一个往返，所以单独一趟补。
     ⚠ 用户**已经自己改过选择就一个字都不动**：等这一趟回来的工夫里，他完全可能
       已经点了缩略图或者写了区间 —— 那是他自己的意思，不能拿盘上那份盖回去。 */
  useEffect(() => {
    if (!doc.path) return
    let alive = true
    const apply = async () => {
      const got = await deckDonePages(doc.path).catch(() => null)
      if (!alive || !got || !got.size) return
      setDonePages(got)
      /* ⚠ 用户**已经自己改过选择就一个字都不动**：这一趟回来得晚，
         那工夫里他完全可能已经点了缩略图或者写了区间 —— 那是他自己的意思。 */
      setPicked((cur) => (sameSet(cur, pickedFirst.current) ? dropDonePages(cur, got) : cur))
    }
    /* ★ 看**四眼**（立刻、0.5s、1s、1.5s），而不是只看一眼：
       上一趟的读还在飞的时候（讲完就马上关窗口、再开一个），最后那几页的稿子
       比这个窗口**晚一帧**才落进缓存 —— 只看第一眼会以为"那几页还没讲过"，
       于是默认还是全选（用户眼里就是"改了跟没改一样"）。
       ⚠ 看见一次就够（幂等）：`apply` 每次都是"拿全集剔一遍"，不是累加。
       ⚠ 1.5 秒之后不再看：那时用户早就在挑页了，再改他的选择就是捣乱。 */
    apply()
    let n = 0
    const timer = setInterval(() => {
      n += 1
      if (n > 3) {
        clearInterval(timer)
        return
      }
      apply()
    }, 500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [doc.path])

  /* 选中的页（去重、排序）。挑页阶段是手选 + 区间输入两路的并集。 */
  const chosen = useMemo(() => [...picked].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b), [picked, pageCount])
  /* 读/贴那两个阶段显示的是 `readPages`（既成事实）；挑页阶段才看 `picked`。 */
  const wantPages = readPages && readPages.length ? readPages : chosen
  /* ── 挑页那一屏要说的那句"讲过的页没默认选" ──
     ★ 为什么非说不可：默认从"全部"变成"一部分"，用户第一反应是"它是不是漏了"，
       不说一句就成了"猜谜"。而这句话顺手把"要重讲就点上去"也交待了。
     ⚠ 整份都讲过（剔完一个不剩、于是原样全选）时换个说法 ——
       那时再说"没默认选"就是**假话**（它们明明都选着）。 */
  const doneHere = useMemo(() => [...donePages].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b), [donePages, pageCount])
  const doneKept = useMemo(() => doneHere.filter((n) => picked.has(n)), [doneHere, picked])
  const doneHint = !doneHere.length
    ? ''
    : doneKept.length
      ? `这份课件 ${doneHere.length} 页上次**都**讲过了 —— 要重讲哪一页就点上去（稿子还在的话旁边有「⤓ 用上次那份」）`
      : `上次讲过的 ${doneHere.length} 页（${pagesLabel(doneHere)}）这次没默认选 —— 要重讲就点上去`

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
    /* ★「讲这几页」= **重读这几页**：先忘掉它们上一份讲稿，再一页一页地发。
       ⚠ **只忘这几页**（`forgetDeck` 传了页号就只清这几页）—— 别的页的讲稿是花真钱
         买来的，不该被这一趟顺手带走（2026-09-30：从前是"打开窗口就整份清掉"，
         于是打开看一眼就退出也会把几十页的稿子连同盘上那份一起删掉）。
       ⚠ **必须等它清完再往下走**（`await`）：不等的话，下面那一趟开读时老稿还在，
         命中缓存 → 屏幕上显示"上次讲的"，而用户按的是"讲这几页" —— 点了却没讲。 */
    await forgetDeck(doc.path, want)
    setReadPages(want)
    setPhase('read')
    setPages({})
    /* 重讲一遍 = 整节课那两张也得重算（它们的输入就是这次讲的东西）。
       ★ 两张一起清 —— 半清会留下"提纲是新的、须知是旧的"那种说不清的状态。 */
    setSum(null)
    setRls(null)
    setProg({ done: 0, total: want.length, failed: 0, cached: 0, usage: null })
    const ac = new AbortController()
    abortRef.current = ac
    /* ★ **这一趟读到的页，顺手在这里收一份。**
       为什么不能直接让 `genSummary` 去读 `items`：`items` 是由 `pages` 这个 state
       算出来的，而 `startRead` 这个函数体是**发起这一次读之前**那次渲染的闭包 ——
       等 `await readDeck` 回来时，闭包里的 `items` 还是**开读之前那一份**（空的）。
       于是 `genSummary` 会拿着空摘要去发第二趟，或者干脆在"没讲出东西来"那道闸上
       直接被挡回来 —— 屏幕上表现为"提纲那一栏一直报没讲出东西"，
       而逐页那几十张卡全都好好的（2026-09-22 自检当场抓到的就是这个）。
       自己收一份就没有这个时序问题：`onPage` 是同步回调，收到就是真收到了。 */
    const fresh = new Map()
    const onPageFresh = (info) => {
      const page = Number(info.page)
      /* ⚠ 判据是 `status === 'ok'`（readDeck 那边的口径），不是"没有 error 字段" ——
         失败那一页也带着 items/sections（都是空数组），混进来会让提纲把"没读到"
         当成"读到了、没内容"，两句话在屏幕上长得一样但含义差很远。 */
      if (info.status === 'ok') {
        fresh.set(page, {
          page,
          unit: (info.sections && info.sections[0] && info.sections[0].name) || '',
          items: info.items || [],
        })
      }
      onPage(info)
    }
    try {
      await readDeck({
        path: doc.path,
        pages: want,
        signal: ac.signal,
        onPage: onPageFresh,
        onProgress: (p) => setProg(p),
        /* ★ 同时发几路：**由设置里的那个数说了算**（服务端从 /api/ocr/status 发过来）。
           读不到（老服务端、连不上）就交给 readDeck 的默认值 —— 少一个旋钮不该让整趟跑不动。 */
        concurrency: st && Number(st.docConcurrency) > 0 ? Number(st.docConcurrency) : undefined,
      })
    } finally {
      abortRef.current = null
      setPhase((cur) => (cur === 'read' ? 'done' : cur))
    }
    /* ★ 第二趟（提纲 + 须知）在这里发起 —— **逐页都跑完/停下之后**。
       为什么不放在 `onProgress` 里倒数到 0 的时候：那一条会在"最后一页回来"
       和"这一趟真的结束了"之间留缝，而这一趟的输入正是 `pages` 那张表 ——
       得等它落定（`await readDeck` 回来）才拿得到完整的一份。
       ★ 输入用**上面刚收的那一份 `fresh`**（这一趟真读到的），不是 `items`：
         `items` 是这次渲染之前的闭包快照，在这儿拿它只会拿到开读之前那份（见上面那条注）。
         小节名在这儿现编一遍（`groupBySection`，和 `items` 那条走的是同一个函数）。
       ★ `both: true` = **两张卡一起要**（提纲 + 须知）—— 这是"整理一遍"的默认行为：
         用户点的是"把这一节课整理出来"，而做题那一趟要读的正是那两张。
         它们是**共用同一份输入**的两次调用（见 genSummary 那条注），所以不重复读课件。
       ⚠ **不等它**（没有 await）：它慢一点或者挂了，都不该让"贴到白板上"卡住。
         所以这个调用是**故意悬着**的 —— `.catch` 兜住任何意外，
         里面自己的错误处理走 `setSum` / `setRls`。 */
    const freshList = [...fresh.values()].sort((a, b) => a.page - b.page)
    const onErr = (e) => {
      const err = { status: 'error', error: String((e && e.message) || e), kind: 'bad' }
      setSum(err)
      setRls(err)
    }
    genSummary({ list: freshList, both: true }).catch(onErr)
  }

  /* ⚠ 一次只允许一趟在飞（这个 ref 就是那道闸）：两趟同时在飞的话，后回来的那份
     会**盖住先回来的** —— 而两份的输入不一样（一份是你删过的），
     屏幕上看到的是哪一份就说不清了。`genSummary` / `oneDeck` 都问它。 */
  const sumRef = useRef(null)

  /* 「重读这一页」：先忘掉缓存（那颗按钮的意思就是"上次那个我不信"），再单独读它。
     ⚠ 只有这一页在飞，别的页一个字都不动 —— 那是"一页一次调用"挣来的。
     ★ `forget: false` 那一路是 2026-09-23 加的「⤓ 用上次那份」：
       和重讲的**唯一区别就是不清缓存** —— 于是那一页命中缓存就**不花钱**
       （没命中就跟重讲一样照付，行为不会更差）。
       ⚠ 两路共用这一个函数是**故意的**（"一处实现"）：各写一份的话，
         "哪一路会清缓存"迟早分叉，而分叉了屏幕上一点都看不出来。 */
  const reread = async (page, { forget = true } = {}) => {
    const n = Number(page)
    if (forget) {
      forgetPage(doc.path, n)
      /* ⚠ 键也是 number（见 onPage 那条）—— 删错了的表现是"点了重读，那一页没变"。 */
      setPages((cur) => {
        const next = { ...cur }
        delete next[n]
        return next
      })
    }
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

  /* ── 第二趟：整节课那两张卡（**定义在这儿**，不是别处）───────────────────
   *
   * ⚠ **位置是有讲究的**：它读 `items` / `units`，而那两份是上面那两行 `useMemo`
   *   算出来的 —— 这个函数定义在它们**上面**的话，`items` 还在 TDZ 里，
   *   第一次调用当场 `Cannot access 'items' before initialization`。
   *   而这行错**只在真的发起第二趟时才报**（首屏、挑页、逐页都对），
   *   所以测试不点「贴到白板上」就永远看不见它。
   *
   * ★ **在逐页都跑完之后**发起（`startRead` 那个 `finally` 后面），
   *   而且**不阻塞"贴到白板上"**：这一趟是附带的（用户点的是整理），
   *   它慢一点、或者挂了，都不该让已经讲好的那几十页卡在那儿。
   *
   * ★ 输入是 `summaryInput(items, ...)` —— 逐页那些条目压成的一份摘要。
   *   ⚠ 用 `items`（过了 `groupBySection` 的那一份）而不是 `pages`：
   *     小节名要 `groupBySection` 才编得上（和下面 `unitTextOf` 是同一条）。
   *   ★★ **两张卡共用这一份输入**：同一个 `built.text` 发两次，只是 `kind` 不同。
   *     所以"多一张须知"的代价只有输出那一侧的钱（不是重读一遍课件）。
   *
   * ★ `force` = 「↻ 重新生成」：那颗按钮的意思是"上次那个我不信"，
   *   和「↻ 重讲这一页」一个手感 —— 所以要先 `forgetSummary`
   *   （它按前缀清，**两张卡的缓存一起清** —— 那正是点它的人的意思）。
   *
   * ⚠ 一次只允许一趟在飞（`sumRef` 那个闸）：两趟同时在飞的话，后回来的那份
   *   会把先回来的**盖住**，而屏幕上看到的是哪一份就说不清了。
   *   ★ 两张卡是**串行**的（`await` 完提纲再发须知）：共用一个闸，而且省一次
   *     并发请求 —— 它们反正不阻塞"贴到白板上"，先出来一张就先显示一张。 */
  const genSummary = async ({ force = false, list: passed, both = false } = {}) => {
    if (sumRef.current) return
    /* ⚠ `list` 可以由调用方**现给**一份（`startRead` 收的那一份：闭包里的 `items`
       在那一刻还是旧快照，见 startRead 里那条注）。没给才退回 `items` ——
       「↻ 重新生成」那颗按钮走的就是这一路（那时 `items` 早已落定）。 */
    const src = passed && passed.length ? passed : items
    const { units: us, items: its } = passed && passed.length ? groupBySection(src) : { units, items: src }
    const built = summaryInput(its, { units: us, readPages: wantPages })
    if (!built.text.trim() || !its.length) {
      const err = { status: 'error', error: '这一趟没讲出东西来 —— 提纲是从讲过的那几页里长出来的', kind: 'empty' }
      setSum(err)
      if (both) setRls(err)
      return
    }
    if (force) forgetSummary(doc.path)
    /* 一张一趟：先提纲，再（如果 both）须知。串行 —— 见上面那条注。 */
    await oneDeck({ kind: 'docsum', set: setSum, input: built.text, pages: src.map((x) => x.page), force })
    if (!both) return
    await oneDeck({ kind: 'rules', set: setRls, input: built.text, pages: src.map((x) => x.page), force })
  }

  /* 单张卡那一趟：发请求 → 收货 → 归一。**提纲和须知走的是同一段代码**。
   * ★ 唯一的差别是「用哪个归一函数」和「错了怎么说」—— 那两样按 `kind` 分。
   * ⚠ 别把它展开成两份：这两趟的输入、缓存键形状、`stale` 防线、用量并入
   *   **全都一样**，抄一遍之后改一处忘一处的表现是**静默的**。 */
  const oneDeck = async ({ kind, set, input, pages: pg, force }) => {
    set({ status: 'run' })
    const ac = new AbortController()
    abortRef.current = ac
    sumRef.current = ac
    const label = kind === 'rules' ? '做题须知' : '提纲'
    try {
      /* ⚠ `pg` 是缓存的另一半键：这一趟的内容是"你讲过的这几页"长出来的，
         换一批页（先读 1、3 再读 1、2）就是另一份东西，不能命中旧的。
         `force` 那条路（「↻ 重新生成」）走 `forgetSummary` 按前缀全清（两张一起）。 */
      const got = await readSummary({ path: doc.path, pages: pg, kind, input, signal: ac.signal, force })
      if (!got.ok) {
        set({ status: 'error', error: got.error, kind: got.kind, stale: got.stale })
        return
      }
      const norm = kind === 'rules' ? normalizeRules(got.text) : normalizeSummary(got.text)
      if (!norm.ok) {
        set({ status: 'error', error: `模型回的格式没看懂（这次没生成${label}）`, kind: 'format' })
        return
      }
      /* 用量并进进度那一行：它们是**另外的调用**，但那笔钱是这一趟花掉的。 */
      if (got.usage) setProg((cur) => ({ ...cur, usage: addUsage(cur.usage, got.usage) }))
      set({ status: 'ok', items: norm.items, cached: !!got.cached, dropped: norm.dropped })
    } catch (e) {
      if (e && e.name === 'AbortError') return
      set({ status: 'error', error: String((e && e.message) || e), kind: 'bad' })
    } finally {
      sumRef.current = null
      if (abortRef.current === ac) abortRef.current = null
    }
  }

  /* 一条知识点在窗口里显示成什么（改过的用改过的）。 */
  const shown = (it) => {
    const e = edit[it.id]
    return e ? { ...it, ...e } : it
  }
  const kept = items.filter((it) => !del[it.id])
  /* 整节课那两张（各 0 条或 1 条）。**不要在渲染里现算** —— 它要看 `del`，
     而 `del` 变一次就得重算一次，写在渲染里等于每帧一个小 map。 */
  const sumItems = (sum && sum.status === 'ok' ? sum.items : []) || []
  const sumKept = sumItems.filter((it) => !del[it.id])
  const rlsItems = (rls && rls.status === 'ok' ? rls.items : []) || []
  const rlsKept = rlsItems.filter((it) => !del[it.id])
  const deckKept = sumKept.length + rlsKept.length
  const unitNameOf = (u) => (unitName[u.id] != null ? unitName[u.id] : u.name)
  const overCap = kept.length + deckKept > MAX_ITEMS_TOTAL ? kept.length + deckKept - MAX_ITEMS_TOTAL : 0

  const confirm = () => {
    /* ★ 整节课那两张**排在最前面**（提纲在前、须知在后）：它们是"整件事的地图"，
       摆版时也是它们先占位（第一页左栏，一张接一张）—— 两块内容按同一个顺序交出去，
       读这份代码的人不用去猜"到底哪个先落地"（Board.jsx 那两侧都不关心顺序，但人关心）。
       ★ 顺序和 `isDeckLevel` 那两张的**语义顺序**一致：先形状（提纲）再口径（须知）。 */
    const all = [...sumKept, ...rlsKept, ...kept]
    const out = all.slice(0, MAX_ITEMS_TOTAL).map((it) => {
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
  /* 这一趟真花了多少（累计到此刻，含失败的页）—— 读不到就是空串，那一行不出现。 */
  const usageLine = usageText(prog.usage)
  /* 每一页的节名（诊断用 + 渲染用的是同一个值）—— 见下面 .dkr-unit 那一行。 */
  const unitTextOf = (mine) => {
    const uid = mine && mine.length ? mine[0].unitId : null
    const unit = uid ? units.find((u) => u.id === uid) : null
    return unit ? unitNameOf(unit) : ''
  }

  /* ── 整节课那张卡的**那一块**（提纲 / 须知共用这一段渲染）─────────────────
   * ★ 为什么不写成两个 <section> 各一份 JSX：两块除了**标题、提示语、retry 那颗按钮的
   *   调用参数**之外一模一样（状态三态、缓存标签、超上限标签、可改可删的条目）。
   *   抄两份之后"改了提纲那块忘了须知那块"的表现是**看不出来的**
   *   （两块长得像，缺的那一样只有仔细比才发现），而这是这个窗口里最容易犯的错。
   * ⚠ 它没有页号（`page: 0`），所以**不能**放进上面那个 `wantPages.map` 循环里 ——
   *   那个循环是按页号走的，`wantPages` 里根本没有 0，混进去等于一块都不显示（静默失效）。
   * ★ `data-summary` / `data-rules` 是给自检看的口子（和 `.dkr-pgblk` 的 `data-page`
   *   一个路子）：一块卡在 DOM 上有没有、收了几段，从外面只有这里读得出来。
   * ★ 三种状态各一句话：在生成 / 没生成（可以再点一次）/ 生成了。
   *   **"没生成"不是错误** —— 逐页那些卡片照样贴得上去，所以不摆成红色的警告，
   *   只在标题旁边小小地写一句（用户没点它就该有一条，点了没拿到就再点一次）。
   *
   * @param {string} kind  'docsum'（提纲）/ 'rules'（须知）
   * @param {string} label 那一块的标题
   * @param {object} st    那个 state（`sum` / `rls`）
   * @param {string} tag   条目标签上的字（'提纲' / '须知'）
   * @param {string} hint  "它是什么"那一句（没生成时显示）
   * @param {string} testId `data-*` 那个口子的值（'1'） */
  const deckBlock = ({ kind, label, st, tag, hint, testId }) => {
    const list = (st && st.status === 'ok' ? st.items : []) || []
    return (
      <section
        className={'dkr-pgblk dkr-sum' + (st && st.status === 'error' ? ' bad' : '')}
        {...(kind === 'rules' ? { 'data-rules': testId } : { 'data-summary': testId })}
      >
        <div className="dkr-pgh">
          <b>{label}</b>
          <span className="dkr-unit">整份课件一张卡 · 贴在第一页左边</span>
          {st && st.status === 'run' ? <span className="dim small">{kind === 'rules' ? '正在把这一节课的规矩收起来…' : '正在把这一节课串起来…'}</span> : null}
          {st && st.status === 'ok' && st.cached ? (
            <span className="trv-tag ok" title="这一份课件没改过，直接用上次那份 —— 这次没有发请求">上次生成的</span>
          ) : null}
          {st && st.status === 'ok' && st.dropped ? (
            <span className="trv-tag" title="模型多写了几条，超出上限的没要">{`丢了 ${st.dropped} 条超上限的`}</span>
          ) : null}
          {st && st.status === 'error' ? <span className="dkr-err">{st.error}</span> : null}
          <button
            className="mini dkr-retry"
            onClick={() => genSummary({ force: true, kind })}
            disabled={!!sumRef.current || !items.length || (st && st.status === 'run')}
            title="再生成一份（绕开缓存，会再花一次调用）"
          >
            ↻ {st && st.status === 'ok' ? `重新生成${tag}` : `生成${tag}`}
          </button>
        </div>
        {st && st.status === 'ok' ? (
          <div className="dkr-sumone">
            {list.map((it) => {
              const s = shown(it)
              const gone = !!del[it.id]
              return (
                <div className={'dkr-item' + (gone ? ' off' : '')} key={it.id} data-deck-item="1" data-deck-kind={kind}>
                  <div className="dkr-itemrow">
                    <span className="dkr-kind">{tag}</span>
                    <input
                      className="dkr-t"
                      value={s.title}
                      spellCheck={false}
                      onChange={(e) => setEdit((c) => ({ ...c, [it.id]: { ...s, title: e.target.value } }))}
                    />
                    <button className="mini" onClick={() => setDel((c) => ({ ...c, [it.id]: !gone }))} title={gone ? '这条不要了？点一下收回来' : '这条不要贴到板上'}>
                      {gone ? '↺ 收回' : '✕ 不要'}
                    </button>
                  </div>
                  {/* ⚠ 这一份是多段结构（提纲六段 / 须知三段），行数比讲解多得多 ——
                      按**这一条正文的行数**给高度，别用讲解那张"按字数折行"的算法
                      （那个 max 4 行，会把大半份藏在滚动条后面）。
                      ★ 上限 14 行：两块加起来最多 22 行，窗口本来就要滚一份长内容。 */}
                  <textarea
                    className="dkr-b"
                    value={s.body}
                    spellCheck={false}
                    rows={Math.max(5, Math.min(14, String(s.body || '').split('\n').length + 1))}
                    placeholder="（没有内容）"
                    onChange={(e) => setEdit((c) => ({ ...c, [it.id]: { ...s, body: e.target.value } }))}
                  />
                </div>
              )
            })}
          </div>
        ) : null}
        {/* 生成中/没生成时那一格空着会显得像坏了 —— 写一句"它是什么"，
            顺便说清"没生成也不影响上面那些"。 */}
        {!st || st.status !== 'ok' ? (
          <div className="dkr-sumhint dim small">
            {hint}{items.length ? '它没生成也不影响上面那些卡片贴到板上。' : ''}
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <div className="dkr-back" onPointerDown={(e) => e.target === e.currentTarget && leave()}>
      {/* 蹭 .wp 那一组样式（和转录校对同一个路子），宽度差异由 .dkr 覆盖。 */}
      <div className="wp dkr" role="dialog" aria-label="课件整理">
        <div className="wp-head">
          <b>课件整理 · {title}</b>
          <span className="dim small">
            {phase === 'pick'
              ? `这份资料一共 ${pageCount} 页 —— 挑一段，让老师逐页讲（讲解贴右边、重点和公式贴左边），讲完再给一份整节课的提纲`
              : phase === 'read'
                ? `正在一页一页讲（${prog.done}/${readTotal}）—— 讲好的那页可以直接改`
                : `讲完了（${prog.done}/${readTotal}${prog.cached ? `，其中 ${prog.cached} 页是上次讲过的` : ''}）—— 改完点右下角贴到板上`}
          </span>
          {/* ★ 这一趟花了多少（2026-09-22 加的）：在这之前它是一笔看不见的账 ——
              什么时候花的、缓存命中多少、thinking 占了多少，界面上一个字都没有。
              把它摆在进度旁边，是为了让"省不省"当场看得见（数从服务端的 usage 来）。 */}
          {usageLine ? (
            <span className="dkr-usage" title="这一趟真花掉的 token（识别服务回的数，含失败的那几页；缓存命中的页没出网、不计入）">
              {usageLine}
            </span>
          ) : null}
          {phase === 'read' && (
            <button className="mini" onClick={stop} title="中止**后面的**请求；已经发出去的那几次拦不住（服务端还在跑，那几次的钱也照花）">
              ■ 停止
            </button>
          )}
          <button className="wp-x" onClick={leave} title="先不整理（Esc）">×</button>
        </div>

        {/* ── 挑页：一条区间输入 + 一摞缩略图 ── */}
        {phase === 'pick' && (
          <div className="dkr-pick">
            <div className="dkr-pickrow">
              <span className="dim small">讲哪几页：</span>
              <input
                className="dkr-range"
                ref={rangeRef}
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
                讲这几页
              </button>
              <button className="mini" onClick={() => startRead(Array.from({ length: pageCount }, (_, i) => i + 1))} title={`全部 ${pageCount} 页（要讲一会儿）`}>
                全部 {pageCount} 页
              </button>
              <span className="dim small">已选 {chosen.length} 页{chosen.length ? '：' + pagesLabel(chosen) : ''}</span>
              {doneHint ? (
                /* `data-done` 是给自检看的口子（和 `.dkr-pgblk` 的 data-page 一个路子）：
                   "它认为讲过哪几页"这件事只在 React 里，DOM 上看不见。 */
                <span className="dim small dkr-donehint" data-done={doneHere.join(',')} title="默认不选讲过的页：那份讲稿还在（不花钱就能用）—— 想再讲一遍就自己把它点上">
                  {doneHint}
                </span>
              ) : null}
              <button className="mini" onClick={() => setPicked(new Set())} disabled={!chosen.length}>清空</button>
              {/* 换一份课件：讲的不一定是板上那份。
                  ⚠ 换的是 Board 那边的 `deckFor`，这个窗口会**整个重开**
                    （`key` = 课件 id，见 Board.jsx 那一段）—— 所以这里不自己清状态。 */}
              {onPickFile && (
                <button className="mini dkr-pickfile" onClick={onPickFile} title="讲另一份课件：选一个 PDF/PPT（会铺到板上，讲解才贴得到它旁边）">
                  📄 换一份文件…
                </button>
              )}
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
            有 {failed.length} 页没讲出来（下面标红的那几页）。别的页照样讲完了 —— 点那一页的「↻ 重讲这一页」再试一次。
          </div>
        ))}
        {stopped && <div className="dkr-warn">停在第 {prog.done} 页 —— 已经讲好的那几页照样能贴（想补讲就再点一次整理）。</div>}
        {overCap > 0 && <div className="dkr-warn">内容太多了（{kept.length} 条），一次最多贴 {MAX_ITEMS_TOTAL} 条 —— 后面 {overCap} 条这次不会贴上去。</div>}

        {/* ── 讲 / 贴：一页一块 ── */}
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
                /* "这页没什么可讲的"看的是**这一页原本讲出来几条**（`p.items`）——
                   不能看 `mine`：那里面已经把被删掉的条目也算进去了，
                   而你删光一页的条目时，那一页不该冒出一句"这页没什么可讲的"。 */
                const rawCount = (p.items || []).length
                /* `data-page` 是给自检看的口子（和 `.bd-docpage` 的 data-doc-page、
                   `.bd-inkask` 的 data-ink-ask 一个路子）：`key` 只活在 React 里，
                   不会落到 DOM 上，所以"屏幕上是哪几页"从外面读不出来。
                   有了它，check-deck [7] 才能把"这一页标了"和"这一页真出过网"对上账。 */
                return (
                  <section className={'dkr-pgblk' + (p.status === 'error' ? ' bad' : '')} key={n} data-page={n}>
                    <div className="dkr-pgh">
                      <b>第 {n} 页</b>
                      {unitText ? <span className="dkr-unit">{unitText}</span> : null}
                      {p.cached ? <span className="trv-tag ok" title="这一页的内容没改过，直接用上次讲的 —— 这次没有发请求">上次讲的</span> : null}
                      {p.parseFailed ? <span className="trv-tag">没按格式回话</span> : null}
                      {p.status === 'ok' && !rawCount && !p.parseFailed ? <span className="dim small">这页没什么可讲的（封面/目录/过渡页？）</span> : null}
                      {p.status === 'error' ? <span className="dkr-err">{p.error}</span> : null}
                      <button className="mini dkr-retry" onClick={() => reread(n)} title="只重发这一页（**绕开缓存**，所以这一下要花钱）">↻ 重讲这一页</button>
                      {hasDeckPage(doc.path, n) ? (
                        /* ★ 这一颗只在**还留着上一份**时才出现：它是"把上次讲的那份拿回来"，
                           不花钱（命中缓存就不出网）。没有旧稿时不显示 —— 显示了却是付费重跑，
                           那是在骗人。 */
                        <button className="mini dkr-reuse" onClick={() => reread(n, { forget: false })} title="这一页上次讲过 —— 把那份拿回来（不出网，不花钱）">⤓ 用上次那份</button>
                      ) : null}
                    </div>
                    <div className="dkr-img">
                      {p.url ? (
                        <img src={p.url} alt={'第 ' + n + ' 页'} />
                      ) : (
                        <span className="dim small">{p.cached ? '（上次讲的，这次没重画图）' : p.status === 'error' ? '（这页没讲出来）' : '（没画出图）'}</span>
                      )}
                    </div>
                    <div className="dkr-items">
                      {mine.map((it) => {
                        const s = shown(it)
                        const gone = !!del[it.id]
                        return (
                          <div className={'dkr-item' + (gone ? ' off' : '')} key={it.id}>
                            <div className="dkr-itemrow">
                              {/* 三种：讲解（右边那张）、重点（左边那张）、公式（左边一条一张）。
                                  ⚠ 提纲那一条**走不到这里**（它不在 `items` 里、没有页号）——
                                    这一行只是兜底：认不出的 kind 显示成"重点"比显示成空白好
                                    （那也是原来那条 `=== 'formula' ? … : '重点'` 的老行为）。 */}
                              <span className="dkr-kind">{it.kind === 'formula' ? '公式' : it.kind === 'explain' ? '讲解' : it.kind === SUMMARY_KIND ? '提纲' : it.kind === RULES_KIND ? '须知' : '重点'}</span>
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
                  <b>正在讲…</b>
                  <span className="dim small">还剩 {readTotal - prog.done} 页（{prog.done}/{readTotal}）</span>
                </div>
              </section>
            )}

            {/* ── 整节课那两张卡（2026-09-22）────────────────────────────────
                ⚠ 它们**各自单独一块**，不在上面那个 `wantPages.map` 里 —— 那个循环是按页号
                  走的，而它们没有页号（`page: 0`），混进去等于一块都不显示（静默失效）。
                ★ 两块都走上面那个 `deckBlock`（同一段渲染）—— 见它那段注释里"为什么不抄两份"。
                ★ 顺序：**先提纲（形状）再须知（口径）** —— 和 `confirm` 里交出去的顺序、
                  以及 Board.jsx 摆版的顺序是**同一个**（上中下三层都按同一个顺序，人才好读）。
                  两块各自有 `data-summary` / `data-rules` 口子，自检各认各的。 */}
            {phase !== 'pick' && (sum || rls || items.length > 0) && (
              <>
                {deckBlock({
                  kind: 'docsum',
                  label: '这一节课的提纲',
                  st: sum,
                  tag: '提纲',
                  testId: '1',
                  hint: '把这一节课串成一块：骨架（分几节、各讲什么）、脉络、跨页的必记、易错、整节课绕不开的式子，以及几个自测问题。',
                })}
                {deckBlock({
                  kind: 'rules',
                  label: '做题须知',
                  st: rls,
                  tag: '须知',
                  testId: '1',
                  hint: '给"拿这节课去做题"用的那几条：用哪套单位、符号怎么写，动手前按什么顺序、答案什么格式，以及最容易写错的那一步。',
                })}
              </>
            )}
          </div>
        )}

        <div className="wp-acts dkr-acts">
          <span className="dim small">
            {phase === 'pick' ? (
              '挑好页点「讲这几页」—— 这一趟会把那几页的图发给识别服务（DeepSeek），一页一次，让老师逐页讲'
            ) : (
              <>
                {kept.length + deckKept} 条会贴到白板上：讲解在每页右边，重点和公式在左边
                {deckKept ? `，整节课的${[sumKept.length ? '提纲' : '', rlsKept.length ? '做题须知' : ''].filter(Boolean).join('和')}在第一页左边` : ''}
                {units.some((u) => unitNameOf(u)) ? `（分成 ${units.filter((u) => unitNameOf(u)).length} 个小节）` : ''}
                {' —— 一条都不要了就点它的「✕ 不要」'}
              </>
            )}
          </span>
          <button className="mini" onClick={leave}>先不整理</button>
          {/* ⚠ 可贴的条件**不能只看 `kept.length`**：用户可能把逐页那些全删了、
           *   只想要整节课那两张（那正是一个合理的用法）—— 只看 `kept` 那颗按钮会灰着。
           *   `deckKept` 已经把提纲和须知一起算进来了。 */}
          <button
            className="btn primary"
            disabled={phase === 'pick' || !(kept.length || deckKept)}
            onClick={confirm}
            title={phase === 'pick' ? '先挑页、让老师讲一遍' : ''}
          >
            {phase === 'read' ? '讲完了就贴（还剩 ' + Math.max(0, readTotal - prog.done) + ' 页）' : '贴到白板上'}
          </button>
        </div>
      </div>
    </div>
  )
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

