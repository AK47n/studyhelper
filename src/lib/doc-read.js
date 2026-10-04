/* 课件整理：把资料的一段页读成文字（发图、收话），**不碰白板**。
 *
 * ── 这一层管什么 ────────────────────────────────────────────────────────
 *   · 哪几页要读（`buildBatches`：分批，纯函数、自检里断言得住）；
 *   · 把每一页渲染成位图（`doc-pages.js` 的 renderDocPageBlob —— 和显示用的是
 *     同一个 pdf.js worker 文档、同一套渲染，只是参数换了一组）；
 *   · 一页一次调用 `/api/ocr`（mode:'doc'），**几页并行**（`DOC_CONCURRENCY`）；
 *   · 收回来的一段话交给 `doc-cards.js` 的 normalizeDocExtract —— 这里不解析 JSON；
 *   · 认过的页记在本地缓存里（同一份 PDF 同一页不重复花钱）；
 *   · **第二趟**：逐页都讲完之后，再把"讲过的内容"压成一份摘要发去 `/api/doc/summary`
 *     （`readSummary`，一份课件一次）—— 那一次产出的是**整节课的提纲**，
 *     解析在 `doc-summary.js` 的 normalizeSummary。
 *
 * ── 为什么一页一次调用，而不是"整批一次发几张图" ──────────────────────
 * 一页一次有三个好处，都是真跑起来最要紧的三件事：
 *   ① **失败只影响那一页**（一张图挂了、模型对那一页回了废话，别的页照样读出来）；
 *   ② **进度能一页一页地长**（50 页的课件要跑两分钟左右，看得见进度才等得下去）；
 *   ③ **重试的粒度是一页**（哪一页读砸了就重读哪一页，不用把 50 页重发一遍）。
 * 代价是调用次数多（49 页 = 49 次）——所以默认并行 3 路，并且**逐页落进缓存**。
 *
 * ── 缓存 ───────────────────────────────────────────────────────────────
 * 键 = 提示词口径 + 资料路径 + 页号。
 * ★ 和 ocr-cache.js 那条纪律一样：**改了 DOC_PROMPT 的回话格式就要换 DOC_FLAVOR**，
 *   否则改好之后再读一次会**原样命中那份老稿**，屏幕上看起来跟没改一样。
 * ★ 只存"读成功的那一页"，失败的不进 —— 一次网络抖动不该被记成"这一页就是空的"。
 * ★ 存不下 / 坏 JSON 一律**静默当没有**（缓存不是正确性的一部分）。
 */
import { renderDocPageBlob } from './doc-pages.js'
import { buildBatches, normalizeDocExtract } from './doc-cards.js'
import { addUsage } from './usage.js'

/* 一页渲染成多宽（像素）才够模型看清。
 * 1440 ≈ 4:3 的 PPT（720×540 点）放 2 倍 —— 正文字号在图上约 24px，这个档位够用了；
 * 再大只是变慢变贵（OCR_MAX_DIM 那条教训同源：放大到看不清的东西只会更贵，不会更准）。
 * ⚠ 这是**固定档位**，不跟视图缩放走：你在屏幕上缩到 40% 再点整理，发出去的图
 *   照样是这个大小（跟视图走的话，缩得越小发出去的越糊）。 */
export const DOC_PAGE_PX = 1440
/* 一页渲染多久算"卡住了"（毫秒）。
 * ★ 为什么必须有这个数（2026-09-20 撞了三次）：pdf.js 的 `page.render()` 偶发
 *   永远不 settle —— 界面上是"正在一页一页讲（3/49）"停在那儿，不报错、不发请求、
 *   点「■ 停止」也停不下来（那一下只能拦住后面还没发的页），只能刷新页面。
 *   超时之后 `renderDocPageBlob` 会**丢掉文档重开一份再试一次**（那才是有效的），
 *   两次都不行就把这一页当失败报出来 —— 用户看到"没讲出来 + ↻ 重讲这一页"，
 *   而不是一个永远转圈的进度。 */
export const DOC_RENDER_TIMEOUT = 30000
/* JPEG 质量：课件是"文字 + 图形"，0.85 在 1440 宽下约 150~350KB 一页 ——
   本地服务 8MB 的请求上限足够宽裕，文字边缘也不会糊。 */
export const DOC_JPEG_Q = 0.85
/* 同时发几路。**默认值**（界面上那个「同时发几路」覆盖它，见下）。
 *
 * ★ 2026-09-22 从 3 提到 6（实测之后）：这一趟的墙钟时间**只由并发决定** ——
 *   一次调用的用时实测在 **0.45 秒 ~ 16.4 秒**之间（同一页、同一张图、同一句提示词，
 *   差别全在 thinking 上），所以 49 页串行是十几分钟、3 路两分钟左右、6 路再省一半。
 *   而"打包多页发一次"**省不到东西**：图片和输出的 token 一个不少，省的只有那份提示词，
 *   而提示词本来就命中缓存（见 README「省钱」那一节）—— 能动的只有这个数。
 * ★ 代价如实说：**「■ 停止」拦不住已经发出去的那几次**（那几次的钱照花）——
 *   并发越高，"按下停止那一刻已经花掉的钱"越多。所以它是个可调的旋钮，
 *   数住在设置里（`server-ocr.js` 的 `docConcurrency`）。 */
export const DOC_CONCURRENCY = 6
/* 缓存的提示词口径。**改了 DOC_PROMPT 的回话格式就要改它**（见文件头）。
 * ⚠ 2026-09-20 从 `doc/points-1` 换成 `doc/lecture-1`：产出从"知识点卡"换成了
 *   "老师讲解"（讲解 + 重点 + 公式），回话格式整个变了。
 * ⚠ 2026-09-20 又换成 `doc/lecture-2`：讲解里开始要求**写 LaTeX 式子**（`$…$` / `$$…$$`）、
 *   并且明说要"讲人话"。这两条改的是**正文的写法**，也是回话格式的一部分 ——
 *   不换口径的话，重跑会原样命中上一版那份老稿（text 里没有 `$`，界面上看着跟没改一样）。
 *   ★ 一句话：**凡是"提示词要它怎么写"变了，这个号就得动**。 */
export const DOC_FLAVOR = 'doc/lecture-2'
const CACHE_PREFIX = 'sh.docread.'
const CACHE_MAX = 400 // 条（一页一条）

/* ══════════════════ 分批 ══════════════════
 *
 * ★ 分批那几行**住在 doc-cards.js**（`buildBatches` / `DOC_MAX_PER_BATCH`）——
 *   它们是纯的，而那个文件能在 node 里被 import（这个文件一 import 就拉起 pdf.js，
 *   于是自检碰不到）。这里只把它转出来，方便调用方从一个地方拿全。
 *   为什么要有分批这件事：见 doc-cards.js 那一段的说明。 */
export { DOC_MAX_PER_BATCH, buildBatches, DOC_BATCH_CHARS } from './doc-cards.js'

/** 一页在图上大约多大（base64 字符数）—— 给界面上"这一趟会发多少"用，纯估算。 */
export const DOC_PAGE_BYTES_EST = 250 * 1024

/* ══════════════════ 缓存 ══════════════════ */

const memCache = new Map()

const cacheKey = (path, page) => CACHE_PREFIX + DOC_FLAVOR + '|' + path + '|' + page

function cacheGet(path, page) {
  const k = cacheKey(path, page)
  if (memCache.has(k)) return memCache.get(k)
  try {
    const raw = localStorage.getItem(k)
    if (raw == null) return null
    const v = JSON.parse(raw)
    const text = v && typeof v.text === 'string' ? v.text : null
    if (text == null) return null
    memCache.set(k, text)
    return text
  } catch {
    /* 隐私模式 / 坏 JSON / 存不下：一律当没有（缓存不是正确性的一部分） */
    return null
  }
}

/* ── 盘上那一层（2026-09-23 加）─────────────────────────────────────────────
 *
 * 起因：缓存从前**只进 localStorage**。清一次浏览器数据、换个端口（它是按 origin
 * 分的）、换台电脑 —— 几十页的讲解就全没了，再整理一遍要再付一遍钱。
 * ★ 讲解是**花真钱换来的**，它该跟课件一起躺在 `data/.资料/.已读/` 里：
 *   那个目录换电脑时本来就要自己拷（课件在那儿），讲稿跟着一起走。
 *
 * ★ 三层，读的顺序是 **内存 → localStorage → 盘上**：
 *     内存 = 这个窗口里最快的一层；localStorage = 关掉浏览器还在；
 *     盘上 = 换电脑 / 清了数据 / 换了浏览器都还在（**唯一跟着课件走的那一份**）。
 * ★ 盘上那份是**整份一次拉、逐页写**：拉一次（一个请求）省得每页都问一遍，
 *   写是**一页一个文件**（课件整理是 6 路并发的，整份读改写会互相盖掉 —— 见
 *   server-docs.js 的「讲稿缓存」那一节）。
 * ⚠ 三层全都**静默失败**：拉不到、写不进、坏 JSON，一律当"这一层没有"。
 *   缓存不是正确性的一部分 —— 它只决定"这一页要不要再花一次钱"。 */
const diskLoaded = new Set()

/** 把盘上那一整份灌进本地两层。**一份资料只拉一次**（一趟整理里没必要拉第二遍）。 */
async function diskLoad(path) {
  if (!path || diskLoaded.has(path)) return
  diskLoaded.add(path)
  try {
    const r = await fetch(`/api/docread?path=${encodeURIComponent(path)}&flavor=${encodeURIComponent(DOC_FLAVOR)}`)
    if (!r.ok) return
    const j = await r.json()
    const pages = (j && j.pages) || {}
    for (const k of Object.keys(pages)) {
      const t = pages[k] && pages[k].text
      if (typeof t === 'string' && t.trim()) localPut(path, Number(k), t)
    }
  } catch {
    /* 拉不到就算了 —— 内存和 localStorage 那两层还在 */
  }
}

/** 只写本地两层（内存 + localStorage）。 */
function localPut(path, page, text) {
  memCache.set(cacheKey(path, page), text)
  try {
    localStorage.setItem(cacheKey(path, page), JSON.stringify({ text, at: Date.now() }))
    /* 超量就丢最老的那一批。key 前缀是我们自己的，不会碰别人的东西。 */
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const kk = localStorage.key(i)
      if (kk && kk.startsWith(CACHE_PREFIX)) keys.push(kk)
    }
    if (keys.length > CACHE_MAX) for (const kk of keys.slice(0, keys.length - CACHE_MAX)) localStorage.removeItem(kk)
  } catch {
    /* 存不下就算了 —— 内存那份还在 */
  }
}

/** 三层都写（读成功一页之后调它）。盘上那份写不进不报错 —— 只是下次可能要多花一次钱。 */
async function cachePut(path, page, text) {
  localPut(path, page, text)
  try {
    await fetch(`/api/docread?path=${encodeURIComponent(path)}&page=${Number(page)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flavor: DOC_FLAVOR, text }),
    })
  } catch {
    /* 无所谓 */
  }
}

/** 这一页**还留着上一份吗**（界面用它决定要不要给「⤓ 用上次那份」那颗按钮）。
 *  ★ 查的是**内存 + localStorage** 那两层 —— 盘上那份在 `readDeck` 开头就被 `diskLoad`
 *    灌进来了，所以只要这一趟整理跑过，盘上那份也查得到。
 *  ⚠ 它**不查网络**：渲染时不能 await，而"有没有"这个问题的答案在开读那一刻就定了。 */
export function hasDeckPage(path, page) {
  return cacheGet(path, page) != null
}

/** 忘掉这一页读过的（「重新读这一页」用：那颗按钮的意思就是"上次那个我不信"）。
 *  ★ 盘上那份**也要删**：不删的话，这次重读万一失败，下次打开会把那份"你不信"的老稿
 *    原样读回来 —— 而它看起来跟新读的一模一样（静默用旧稿，最难受的那种）。 */
export function forgetPage(path, page) {
  memCache.delete(cacheKey(path, page))
  try {
    localStorage.removeItem(cacheKey(path, page))
  } catch {
    /* 无所谓 */
  }
  fetch(`/api/docread?path=${encodeURIComponent(path)}&page=${Number(page)}`, { method: 'DELETE' }).catch(() => {})
}

/* ══════════ 这一份资料**已经讲过哪几页** ══════════
 *
 * 「打开整理窗口时**别默认选中讲过的那些页**」要这个数（2026-09-30，用户原话）。
 *
 * ★ 它是从**讲稿缓存的键**里反推出来的，不另开一份记录：
 *   讲稿存在哪儿，"讲过没有"这件事就该记在哪儿。另存一份的话两处迟早对不上 ——
 *   最难受的那种是"讲稿清了、标记还留着"，于是那一页既拿不出稿子、又不肯重讲，
 *   两边都够不着，而且**不报错**。
 */

/** 只扫**本地两层**（内存 + localStorage）—— 同步就有，首屏那一帧就要用它。
 *  ⚠ 盘上那一份**不在这里**（要一个往返）：想要三层齐全请用 `deckDonePages`。 */
export function donePagesLocal(path) {
  const out = new Set()
  if (!path) return out
  const head = CACHE_PREFIX + DOC_FLAVOR + '|' + String(path) + '|'
  const take = (k) => {
    if (!k || !k.startsWith(head)) return
    const n = Number(k.slice(head.length))
    if (Number.isFinite(n) && n >= 1) out.add(n)
  }
  for (const k of memCache.keys()) take(k)
  try {
    for (let i = 0; i < localStorage.length; i += 1) take(localStorage.key(i))
  } catch {
    /* 隐私模式：内存那份还在 */
  }
  return out
}

/** 三层（内存 + localStorage + **盘上**）—— 盘上那份要拉一次，所以它是 async。
 *  ⚠ 必须在 `forgetDeck` **之前**调：清过之后这里就是空的了（"讲过"这件事也就跟着没了）。 */
export async function deckDonePages(path) {
  await diskLoad(path)
  return donePagesLocal(path)
}

/** 忘掉**这一份资料**读过的每一页（换了一版提示词口径、或者要重读整份时用）。
 *  ★ 给了 `pages` 就**只忘这几页**（「讲这几页」= 重读这几页）——
 *    别的页的讲稿是**花真钱买来的**，不该被这一趟顺手带走。
 *    ⚠ 2026-09-30 从前是"一打开窗口就把整份清掉"，代价是：
 *      ① 打开看一眼就退出，几十页的讲稿（连盘上那份）一起没了；
 *      ② 于是"哪些页讲过"也一起没了 —— 下一次打开默认又全选，等于白改。
 *  ★ 为什么要它：缓存是按**路径 + 页号**存的，而页面位图用的是**同一个路径**——
 *    自检之间（签出旧代码、换了夹具）撞在同一份夹具路径上时，上一趟的稿子会原样
 *    被读回来，于是"这一页到底发没发请求"不由这一趟的代码决定（check-deck 就这么
 *    红过一次，同一份代码跑两遍一红一绿）。清一次，那一页就真的重读。
 *  ★ 提纲那一份缓存（`SUM_CACHE_PREFIX`）**也一起清**：它的输入就是逐页那些内容，
 *    "这一份课件的东西全忘掉"如果漏了它，改完提示词重来一遍会贴上**上一版**的提纲，
 *    而屏幕上看着"提纲没变"—— 那正是这个函数要防的那一类错。
 *  ★ 盘上那一份（`.资料/.已读/`）**也一起清**，理由和上面一模一样：漏了它，
 *    "这一份课件的东西全忘掉"就还剩一份在盘上，下次打开原样读回来。
 *    ⚠ 它是 async —— 调用方（DeckReview 那个 useEffect）不 await，
 *      那是故意的：清缓存不该挡住界面。写不进去也只报个 catch，不打断人。
 *  ⚠ 只清几页时**不动提纲那份缓存**（`SUM_CACHE_PREFIX`）：那趟的键里带着页集合，
 *     而"重读第 3 页"不会让"按 1,2,3 算出来的提纲"变成错的 —— 清了反而白花一次钱。 */
export async function forgetDeck(path, pages) {
  /* ── 只清这几页 ── */
  const list = Array.isArray(pages) ? [...new Set(pages.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 1))] : null
  if (list) {
    /* ⚠ 一个页号都没有 = **一次都别清**（绝不能退化成"整份清"）：
       调用方传了个空数组就把几十页花钱买来的讲稿删光，那是最坏的一种误会。 */
    if (!list.length) return
    for (const n of list) {
      memCache.delete(cacheKey(path, n))
      try {
        localStorage.removeItem(cacheKey(path, n))
      } catch {
        /* 无所谓 */
      }
    }
    try {
      await fetch(`/api/docread?path=${encodeURIComponent(path)}&pages=${list.join(',')}`, { method: 'DELETE' })
    } catch {
      /* 无所谓 */
    }
    return
  }
  /* ── 整份都不要 ── */
  const head = CACHE_PREFIX + DOC_FLAVOR + '|' + String(path) + '|'
  /* ⚠ 提纲那一份的键里带**页集合**（有无数种），所以按**前缀**扫 ——
     只删某一个具体键的话，"改完提示词重来一遍贴上上一版提纲"这件事就还在
     （而且它偏偏不报错）。 */
  const sumHead = sumKeyHead(path)
  for (const k of [...memCache.keys()]) if (k.startsWith(head) || k.startsWith(sumHead)) memCache.delete(k)
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const kk = localStorage.key(i)
      if (kk && (kk.startsWith(head) || kk.startsWith(sumHead))) keys.push(kk)
    }
    for (const kk of keys) localStorage.removeItem(kk)
  } catch {
    /* 无所谓 */
  }
  /* 盘上那份：只删 `p<数字>.json`（服务端那边也只删这一类，见 server-docs.js）。 */
  try {
    await fetch(`/api/docread?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  } catch {
    /* 无所谓 */
  }
  /* ★ 清过一次就**允许再拉一次** —— 不然 `diskLoaded` 还记着"这份拉过了"，
     下一趟整理就不会再去盘上取（而盘上那份恰恰已经没了）。 */
  diskLoaded.delete(path)
}

/* ══════════════════ 整份课件的提纲（第二趟） ══════════════════
 *
 * ★ 缓存键**不是** "路径 + 页号" —— 这一趟一份课件只有一次，键 = 路径。
 *   ⚠ 它**没进 `DOC_FLAVOR`**：那个数管的是"逐页回话的形状"（一页的 JSON），
 *     而提纲的输入是**那一份逐页结果的摘要**，它的口径由 `SUMMARY_PROMPT` 决定。
 *     把两者绑在一个号上会得到一个假的因果：改逐页提示词会顺带把提纲缓存作废
 *     （不亏，但读不出为什么）；反过来改提纲提示词忘了动 `DOC_FLAVOR` 就会
 *     一直命中老提纲。所以这里单独一个号，改 SUMMARY_PROMPT 就动它。
 * ★ **存的是"算过这一次"这件事实**（不是"输入是什么"）：同一份课件、**同一批页**、
 *   同一套提示词，结果就是同一个 —— 这和多页之间怎么并、哪些条目被删过**无关**
 *   （提纲是拿"你讲过的内容"写的，不是拿你删剩的）。
 *   ★★ 但 **"同一批页"必须真的进键**：提纲的内容是"你讲过的这几页"长出来的，
 *     换一批页（先读 1、3 再读 1、2）就是**另一份东西**。
 *     第一版把键写成"路径 + flavor"、把页集合漏在外面，后果是：
 *     先读 1、3 存下一份，再读 1、2 时**直接命中那份旧的、一个请求都不发** ——
 *     屏幕上显示的是"上 3 页的提纲"，而用户以为它总结的是刚讲的那两页。
 *     这种错在界面上**看不出任何异常**（有内容、不报错、也不说它是旧的）。
 *     所以页集合按**排序去重后**拼进键（`1,2` 和 `2,1` 是同一件事）。
 *
 * ── 2026-09-22 加的第二张卡：**做题须知** ────────────────────────────────
 * `readSummary` 多了一个 `kind`（`'docsum'` / `'rules'`），**同一份输入发两个 kind**。
 * ★ 为什么复用这一个函数、不另写一个 `readRules`：输入、缓存机制、错误话术、
 *   `stale` 那条防线**全都是同一套**；另写一份就是把这些抄一遍，
 *   而"改了一处忘了一处"的表现是**静默的**（须知那一份用着老的键、命中旧的缓存）。
 * ★ 缓存键必须带上 kind：两张卡的**输入长得一模一样**（同一份摘要），
 *   键里不带 kind 的话先算的那张会把后算的那张盖掉 —— 界面上会显示
 *   "须知 = 提纲的六段"，而且**不报错**（正是上面那条"页集合漏出键"的同一种形状）。 */
export const SUM_FLAVOR = 'docsum/outline-1'
/* 「做题须知」那一个号（独立于提纲的 —— 改 RULES_PROMPT 就动它，不会连累提纲的缓存）。 */
export const RULES_FLAVOR = 'rules/brief-1'
const SUM_CACHE_PREFIX = 'sh.docsum.'

/** 两张整节课的卡（`kind` 的那两个合法值）。
 *  ⚠ 别处写 `kind === 'rules'` 字面量之前先看这里 —— 它是**服务端 mode 名**
 *    和**前端 kind 名**共用的那一个字符串。 */
export const SUM_KINDS = ['docsum', 'rules']

/** 这一趟的缓存键：路径 + 那一趟读的页（排序去重）+ **是哪一张卡** + 口径号。 */
function sumKeyOf(path, pages, kind = 'docsum') {
  const set = [...new Set((pages || []).map(Number).filter((n) => n > 0))].sort((a, b) => a - b)
  const flavor = kind === 'rules' ? RULES_FLAVOR : SUM_FLAVOR
  return SUM_CACHE_PREFIX + String(path) + '|' + (set.length ? set.join(',') : '-') + '|' + flavor
}

/** 前缀（`forgetDeck` / `forgetSummary` 要用它做"这一份课件的全清"——
 *  页集合有无数种，只能按前缀扫）。
 *  ★ 前缀**不含 kind**（两张卡共用 `sh.docsum.` 这个头）：于是"重新生成"那一颗
 *    按钮顺手把两张都清了 —— 那正是要的（点它的人意思是"这次算出来的我不信"）。 */
function sumKeyHead(path) {
  return SUM_CACHE_PREFIX + String(path) + '|'
}

function sumCacheGet(path, pages, kind) {
  const k = sumKeyOf(path, pages, kind)
  if (memCache.has(k)) return memCache.get(k)
  try {
    const raw = localStorage.getItem(k)
    if (raw == null) return null
    const v = JSON.parse(raw)
    const text = v && typeof v.text === 'string' ? v.text : null
    if (text == null) return null
    memCache.set(k, text)
    return text
  } catch {
    return null
  }
}

function sumCachePut(path, pages, kind, text) {
  const k = sumKeyOf(path, pages, kind)
  memCache.set(k, text)
  try {
    localStorage.setItem(k, JSON.stringify({ text, at: Date.now() }))
  } catch {
    /* 存不下就算了 —— 内存那份还在（和逐页那条同一个规矩） */
  }
}

/** 忘掉这一份课件算出来的提纲和须知（「↻ 重新生成」用）。
 *  ⚠ 键里有页集合和 kind（有无数种），所以这里按**前缀**扫着删 ——
 *    删的是这一份课件的**两张卡的全部缓存**（见 sumKeyHead 那条注）。 */
export function forgetSummary(path) {
  const head = sumKeyHead(path)
  for (const k of [...memCache.keys()]) if (k.startsWith(head)) memCache.delete(k)
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const kk = localStorage.key(i)
      if (kk && kk.startsWith(head)) keys.push(kk)
    }
    for (const kk of keys) localStorage.removeItem(kk)
  } catch {
    /* 无所谓 */
  }
}

/**
 * 整节课那一层的卡（**一节课一次调用**）：提纲 / 做题须知。
 *
 * @param {object} arg
 *   · path      资料路径（缓存键的一半）
 *   · pages     **这一趟读了哪几页**（键的另一半，见 sumKeyOf 那条注）——
 *               换一批页就是另一份提纲，不能命中旧的。
 *   · kind      `'docsum'`（默认，提纲）/ `'rules'`（做题须知）——
 *               ★ 两张卡的输入**一模一样**，键里**必须**带上它（见 SUM_FLAVOR 上面那段）。
 *   · input     `summaryInput` 拼好的那份摘要（**唯一**的输入 —— 没有图，见 SUMMARY_PROMPT）
 *   · signal    AbortSignal
 *   · force     true = 绕开缓存（「↻ 重新生成」）
 * @returns {{ ok, text, cached, usage, error, kind, stale, mode }}
 *   `stale` = 本地服务是旧版（不认这个口）—— 和逐页那条 `DOC_STALE_HINT` 同一件事。
 *   ⚠ **这一趟失败不是错误**：逐页那些卡片照样贴得上去。调用方要把它当成"这次没生成"，
 *     而不是"整理失败"（用户点的是整理，这两张只是附带的）。
 */
export async function readSummary({ path, pages, kind = 'docsum', input = '', signal, force = false } = {}) {
  const want = kind === 'rules' ? 'rules' : 'docsum'
  const out = { ok: false, text: '', cached: false, usage: null, error: '', kind: '', stale: false, mode: '' }
  if (!String(path || '').trim() || !String(input || '').trim()) {
    out.error = '没有可整理的内容'
    out.kind = 'empty'
    return out
  }
  if (!force) {
    const hit = sumCacheGet(path, pages, want)
    if (hit != null) return { ...out, ok: true, text: hit, cached: true, mode: want }
  }
  const fd = new FormData()
  fd.append('input', String(input))
  /* ⚠ 这个字段是服务端分"要哪一张"的依据（server.js 那一段）。
     老前端不带它 —— 服务端认不出就落到 docsum，那条路一直能用。 */
  if (want === 'rules') fd.append('kind', 'rules')
  let res
  try {
    res = await fetch('/api/doc/summary', { method: 'POST', body: fd, signal })
  } catch (e) {
    if (e && e.name === 'AbortError') return { ...out, error: '已取消', kind: 'cancel' }
    return { ...out, error: '连不上本地服务：' + String((e && e.message) || e), kind: 'network' }
  }
  const body = await res.json().catch(() => null)
  if (!body) return { ...out, error: `本地服务返回了看不懂的内容（HTTP ${res.status}）`, kind: 'bad' }
  const usage = body.usage || null
  if (!body.ok) return { ...out, error: body.error || '这次没生成', kind: body.kind || 'bad', usage }
  /* ★ 和逐页那条同一条防线：服务端不认这个口时**什么都不回 mode**（老路由 404 →
     上面那个 !body 接住；但要是它命中了别的分支、回了 mode:'formula' 之类，
     我们就会把一句 LaTeX 当成提纲贴上去，而**不报任何错**）。
     ★ 这里比的是**这一趟要的那个 mode**（`want`）而不是写死 `'docsum'`：
       须知那一趟要是只查 `'docsum'`，一个只认提纲的老服务会被当成"对"的，
       然后把提纲的六段贴成"做题须知" —— 而且不报错。 */
  if (body.mode !== want) {
    return { ...out, error: want === 'rules' ? RULES_STALE_HINT : SUM_STALE_HINT, kind: 'stale', stale: true, usage }
  }
  const text = String(body.text || '').trim()
  if (!text) return { ...out, error: want === 'rules' ? '模型没回须知内容' : '模型没回提纲内容', kind: 'empty', usage }
  sumCachePut(path, pages, want, text)
  return { ok: true, text, cached: false, usage, error: '', kind: '', mode: want }
}

export const SUM_STALE_HINT =
  '本地服务还是旧版：它不知道「课件提纲」这个口。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后再点一次。'

export const RULES_STALE_HINT =
  '本地服务还是旧版：它不知道「做题须知」这个口。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后再点一次。'

/* ══════════════════ 出网 ══════════════════ */

/* 让模型回话带 `mode:'doc'` —— 和别的那几趟同一条防线（见 ocr.js 的 interpretOcrResponse）：
   改了 server.js 之后**不重启服务**，5177 上跑的还是老代码，它不认 mode:'doc'，
   于是按公式认、回一个 { ok, latex }。前端要是不查这一条，就会把一句 LaTeX 当成
   课件内容写进卡片，而且**不报任何错** —— 那正是 2026-09-16「美化手写依旧在认公式」
   那个 bug 的形状。 */
export const DOC_STALE_HINT =
  '本地服务还是旧版：它不知道「课件整理」这个口。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后再点一次整理。'

/** 读一页：出网 + 缓存。返回 { page, text, cached, usage } 或 { page, error, kind, img }。
 *  `img` 只在这一趟真画了图时给（缓存命中时不画，省一次渲染）。
 *  `usage` 是**这一页花了多少**（服务端从上游 usage 读出来的那份；
 *  缓存命中的那一页没出网，给 null —— "没花"和"花了 0"是两句不同的话）。 */
async function onePage(path, page, signal) {
  const cached = cacheGet(path, page)
  if (cached != null) return { page, text: cached, cached: true, img: null, usage: null }

  let made
  try {
    made = await renderDocPageBlob(path, page, DOC_PAGE_PX, {
      type: 'image/jpeg',
      quality: DOC_JPEG_Q,
      /* 卡住的话这里面会丢掉文档重开一次（见 doc-pages.js 的那段说明） */
      timeoutMs: DOC_RENDER_TIMEOUT,
    })
  } catch (e) {
    return { page, error: '这一页画不出图来：' + String((e && e.message) || e), kind: 'render' }
  }

  const fd = new FormData()
  fd.append('file', made.blob, `page-${page}.jpg`)
  fd.append('mode', 'doc')
  fd.append('page', String(page))
  let res
  try {
    res = await fetch('/api/ocr', { method: 'POST', body: fd, signal })
  } catch (e) {
    if (e && e.name === 'AbortError') return { page, error: '已取消', kind: 'cancel' }
    return { page, error: '请求本地服务失败：' + (e && e.message), kind: 'network' }
  }
  const body = await res.json().catch(() => null)
  if (!body) return { page, error: `本地服务返回了看不懂的内容（HTTP ${res.status}）`, kind: 'bad' }
  /* ★ 用量的读法：**失败的调用也花了钱**，所以下面每一条路都把它带上 ——
     "这一趟花了多少"要是只算成功的那几页，账就是假的。 */
  const usage = body.usage || null
  if (!body.ok) return { page, error: body.error || '这一页没读出来', kind: body.kind || 'bad', usage }
  if (body.mode !== 'doc') return { page, error: DOC_STALE_HINT, kind: 'stale', img: made, usage }
  const text = String(body.text || '')
  if (!text.trim()) return { page, error: '这一页没读出内容（模型只回了一句解释？）', kind: 'empty', img: made, usage }
  await cachePut(path, page, text)
  return { page, text, cached: false, img: made, usage }
}

/* ══════════════════ 主入口 ══════════════════ */

/**
 * 读一份资料的若干页 → 知识点（边读边回报，随时可停）。
 *
 * @param {object} arg
 *   · path     资料路径（`.资料/xxx.pdf`）
 *   · pages    要读的页号（1 起；这里还会去重排序，但**该读几页由调用方定**）
 *   · signal   AbortSignal。⚠ 中止的是**后面的请求**：已经发出去的那几次拦不住
 *              （服务端还在跑、那几次的钱也照花）—— 和整板转录那条一样，界面上如实写。
 *   · onPage(info)  一页读完了（成功或失败都叫一次）：
 *                   { page, status:'ok'|'error', cached, text, error, kind, img, usage,
 *                     items, sections, dropped, notes, parseFailed }
 *   · onProgress({ done, total, failed, cached, page, usage })
 *                   `usage` = **到这一刻为止累计**花了多少（见 src/lib/usage.js）
 *   · concurrency  默认 DOC_CONCURRENCY；界面上那个「同时发几路」从这儿传进来
 * @returns {Promise<{ pages, pagesDone, pending, items, sections, failed, dropped, notes, usage }>}
 *   `items` —— **一批一页地** normalize 出来的（模型给的就是一页的 JSON），
 *   id 在整趟里连续编，不会撞号。
 */
export async function readDeck({ path, pages = [], signal, onPage, onProgress, concurrency = DOC_CONCURRENCY } = {}) {
  const list = [...new Set((pages || []).map((n) => Number(n)).filter((n) => n > 0))].sort((a, b) => a - b)
  /* `usage` = 这一趟累计花了多少（缓存命中的页不出网、不计入 —— 它是 null 起步的加总，
     见 usage.js 那条"读不到和是 0 是两句不同的话"）。 */
  const acc = { pages: list, pagesDone: [], pending: [], items: [], sections: [], failed: [], dropped: 0, notes: [], usage: null }
  if (!list.length || !path) {
    if (onProgress) onProgress({ done: 0, total: 0, failed: 0, cached: 0, page: 0, usage: null })
    return acc
  }

  /* ★ 开读之前先把盘上那一层灌进来（`data/.资料/.已读/`）—— 换电脑、清了浏览器数据
     之后，那些页**不用再花一次钱**就靠这一下。拉不到就当没有（见 diskLoad 那段）。 */
  await diskLoad(path)

  let idSeq = 0
  let cachedCount = 0
  const seen = new Set()
  const emit = (info) => {
    /* 一页一次 normalize：模型回的是一页的 JSON（{page, unit, points}），
       所以每一页各自成节。连着几页写同一个 unit 时由界面并成一组
       （DeckReview 的 groupBySection，纯函数）。 */
    const norm = info.text ? normalizeDocExtract(info.text, { pages: [info.page], startId: idSeq }) : null
    if (norm) idSeq = norm.nextId
    const out = {
      ...info,
      status: info.error ? 'error' : 'ok',
      items: (norm && norm.items) || [],
      sections: (norm && norm.sections) || [],
      dropped: (norm && norm.dropped) || 0,
      notes: (norm && norm.notes) || [],
      /* 有回话、但一个字的知识点都没收出来 → 多半是它没按 JSON 回（真·空页会回
         `points: []`，那种情况 norm.ok 是 true）。这一条决定界面上要不要提示"重读这一页"。 */
      parseFailed: !!info.text && !!norm && !norm.ok && !(norm.items || []).length,
    }
    if (out.status === 'ok') {
      acc.items.push(...out.items)
      acc.sections.push(...out.sections)
    } else {
      acc.failed.push({ page: info.page, error: info.error, kind: info.kind })
    }
    acc.dropped += out.dropped
    acc.notes.push(...out.notes)
    /* 用量**逐页累加**（失败的页也加 —— 它花了钱）。 */
    acc.usage = addUsage(acc.usage, info.usage)
    seen.add(info.page)
    if (info.cached) cachedCount += 1
    if (onPage) onPage(out)
    if (onProgress)
      onProgress({ done: seen.size, total: list.length, failed: acc.failed.length, cached: cachedCount, page: info.page, usage: acc.usage })
  }

  /* 并发闸门的是"同时在飞的请求数"（不是批次）：一个共享游标最简单也最准。
     ⚠ JS 是单线程的，`cursor++` 这一对读写之间没有 await —— 不会有两路拿到同一页。 */
  let cursor = 0
  const take = () => (cursor < list.length ? list[cursor++] : null)
  const threads = Math.max(1, Math.min(Number(concurrency) || 1, list.length))
  const worker = async () => {
    for (;;) {
      if (signal && signal.aborted) return
      const page = take()
      if (page == null) return
      let r
      try {
        r = await onePage(path, page, signal)
      } catch (e) {
        r = { page, error: String((e && e.message) || e), kind: 'bad' }
      }
      /* 取消**不是**失败：那一页连同后面没轮到的页一起进 pending，不记成"读砸了"。 */
      if (r.kind === 'cancel') return
      emit(r)
    }
  }

  if (onProgress) onProgress({ done: 0, total: list.length, failed: 0, cached: 0, page: 0 })
  await Promise.all(Array.from({ length: threads }, worker))

  acc.pagesDone = [...seen].sort((a, b) => a - b)
  acc.pending = list.filter((p) => !seen.has(p))
  return acc
}
