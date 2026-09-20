/* 课件整理：把资料的一段页读成文字（发图、收话），**不碰白板**。
 *
 * ── 这一层管什么 ────────────────────────────────────────────────────────
 *   · 哪几页要读（`buildBatches`：分批，纯函数、自检里断言得住）；
 *   · 把每一页渲染成位图（`doc-pages.js` 的 renderDocPageBlob —— 和显示用的是
 *     同一个 pdf.js worker 文档、同一套渲染，只是参数换了一组）；
 *   · 一页一次调用 `/api/ocr`（mode:'doc'），**几页并行**（`DOC_CONCURRENCY`）；
 *   · 收回来的一段话交给 `doc-cards.js` 的 normalizeDocExtract —— 这里不解析 JSON；
 *   · 认过的页记在本地缓存里（同一份 PDF 同一页不重复花钱）。
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

/* 一页渲染成多宽（像素）才够模型看清。
 * 1440 ≈ 4:3 的 PPT（720×540 点）放 2 倍 —— 正文字号在图上约 24px，这个档位够用了；
 * 再大只是变慢变贵（OCR_MAX_DIM 那条教训同源：放大到看不清的东西只会更贵，不会更准）。
 * ⚠ 这是**固定档位**，不跟视图缩放走：你在屏幕上缩到 40% 再点整理，发出去的图
 *   照样是这个大小（跟视图走的话，缩得越小发出去的越糊）。 */
export const DOC_PAGE_PX = 1440
/* JPEG 质量：课件是"文字 + 图形"，0.85 在 1440 宽下约 150~350KB 一页 ——
   本地服务 8MB 的请求上限足够宽裕，文字边缘也不会糊。 */
export const DOC_JPEG_Q = 0.85
/* 同时发几路。3 路是"快"和"别把额度和本机打爆"之间的那个数：
   49 页串行要十几分钟，3 路两分钟左右。 */
export const DOC_CONCURRENCY = 3
/* 缓存的提示词口径。**改了 DOC_PROMPT 的回话格式就要改它**（见文件头）。 */
export const DOC_FLAVOR = 'doc/points-1'
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

function cachePut(path, page, text) {
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

/** 忘掉这一页读过的（「重新读这一页」用：那颗按钮的意思就是"上次那个我不信"）。 */
export function forgetPage(path, page) {
  memCache.delete(cacheKey(path, page))
  try {
    localStorage.removeItem(cacheKey(path, page))
  } catch {
    /* 无所谓 */
  }
}

/* ══════════════════ 出网 ══════════════════ */

/* 让模型回话带 `mode:'doc'` —— 和别的那几趟同一条防线（见 ocr.js 的 interpretOcrResponse）：
   改了 server.js 之后**不重启服务**，5177 上跑的还是老代码，它不认 mode:'doc'，
   于是按公式认、回一个 { ok, latex }。前端要是不查这一条，就会把一句 LaTeX 当成
   课件内容写进卡片，而且**不报任何错** —— 那正是 2026-09-16「美化手写依旧在认公式」
   那个 bug 的形状。 */
export const DOC_STALE_HINT =
  '本地服务还是旧版：它不知道「课件整理」这个口。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后再点一次整理。'

/** 读一页：出网 + 缓存。返回 { page, text, cached } 或 { page, error, kind, img }。
 *  `img` 只在这一趟真画了图时给（缓存命中时不画，省一次渲染）。 */
async function onePage(path, page, signal) {
  const cached = cacheGet(path, page)
  if (cached != null) return { page, text: cached, cached: true, img: null }

  let made
  try {
    made = await renderDocPageBlob(path, page, DOC_PAGE_PX, { type: 'image/jpeg', quality: DOC_JPEG_Q })
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
  if (!body.ok) return { page, error: body.error || '这一页没读出来', kind: body.kind || 'bad' }
  if (body.mode !== 'doc') return { page, error: DOC_STALE_HINT, kind: 'stale', img: made }
  const text = String(body.text || '')
  if (!text.trim()) return { page, error: '这一页没读出内容（模型只回了一句解释？）', kind: 'empty', img: made }
  cachePut(path, page, text)
  return { page, text, cached: false, img: made }
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
 *                   { page, status:'ok'|'error', cached, text, error, kind, img,
 *                     items, sections, dropped, notes, parseFailed }
 *   · onProgress({ done, total, failed, cached, page })
 *   · concurrency  默认 DOC_CONCURRENCY
 * @returns {Promise<{ pages, pagesDone, pending, items, sections, failed, dropped, notes }>}
 *   `items` —— **一批一页地** normalize 出来的（模型给的就是一页的 JSON），
 *   id 在整趟里连续编，不会撞号。
 */
export async function readDeck({ path, pages = [], signal, onPage, onProgress, concurrency = DOC_CONCURRENCY } = {}) {
  const list = [...new Set((pages || []).map((n) => Number(n)).filter((n) => n > 0))].sort((a, b) => a - b)
  const acc = { pages: list, pagesDone: [], pending: [], items: [], sections: [], failed: [], dropped: 0, notes: [] }
  if (!list.length || !path) {
    if (onProgress) onProgress({ done: 0, total: 0, failed: 0, cached: 0, page: 0 })
    return acc
  }

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
    seen.add(info.page)
    if (info.cached) cachedCount += 1
    if (onPage) onPage(out)
    if (onProgress) onProgress({ done: seen.size, total: list.length, failed: acc.failed.length, cached: cachedCount, page: info.page })
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
