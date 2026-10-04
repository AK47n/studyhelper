/* 「作业辅导」要出网的那一半：把作业的那几页画成图、连同这节课的讲义发出去、
 * 把回话收成题目。**这个文件要在浏览器里跑**（要 canvas；pdf.js 走 doc-pages.js，用到才拉），
 * 所以自检碰不到它 —— 能断言的那半在 `homework.js`（纯的）。
 *
 * ── 一次问几页 ──────────────────────────────────────────────────────────
 * `pages` 是**要渲染的那几页**（已经由 `parseHomeworkAsk` 读出来并夹过上限，见那边）。
 * 一页一张图，顺序就是页序 —— 而"哪张图是哪一页"不用另外告诉模型：
 * **页码画在图上**（每张图上方那条白带，和「框选追问」同一种画法）。
 * ★ 为什么不让模型"按顺序自己数"：它看不见我们的字段名，只看得见 content 里那几段，
 *   而"第几张图是第几页"一旦说错，答案就会挂到别的题上（学生看不出来）。
 *
 * ── 为什么复用「课件整理」那套渲染参数 ──────────────────────────────────
 * 1440 宽 / JPEG 0.85 / 单页 30 秒超时 —— 那三个数是给"一页纸上的字要看清"定的档，
 * 作业页是同一类东西（教材扫描、习题页）。各定一套的话，两边的代价不一样，
 * 而"为什么这边糊一点"将无从查起。见 doc-read.js 里那三个常量的说明。
 *
 * ── 两条和「框选追问」同源的防线 ────────────────────────────────────────
 *   · **回声校验**：`body.mode !== 'homework'` = 本地服务还是旧版（它不认这个口，
 *     按公式认去了）—— 不查这一条就会把一句 LaTeX 当成答案显示出来，且不报错；
 *   · **错误照实说**：这一趟要给出去的是"答案"，说错了学生会照着背。
 *     所以"没答出来"永远是一条看得见的话，不静默、不兜底成一个空题目。
 */
import { labelHeightOf } from './ask-geometry.js'
/* ★ 圈选题（用户 2026-09-22 要的第二种选法）要的那两张图**就是「框选追问」那两张** ——
   "整页 + 红框标出你圈的地方" + "红框里那一块放大"。所以直接借它的 `buildAskImages`：
   红框画多大、裁图放大到多少、整页要多少像素，那一整套只有一份实现。
   各抄一遍的话，两边会慢慢长成两个样子（而"红框没画在图上"这种事，看代码看不出来）。 */
import { buildAskImages } from './ask-images.js'
import { DOC_JPEG_Q, DOC_PAGE_PX, DOC_RENDER_TIMEOUT } from './doc-read.js'
import { renderDocPageBlob } from './doc-pages.js'
import { HW_STALE_HINT, parseHomework, problemHistory } from './homework.js'

/* 一页画多宽 / JPEG 质量 / 单页超时：**从「课件整理」那边拿**（见文件头）。 */
export const HW_PAGE_PX = DOC_PAGE_PX
export const HW_JPEG_Q = DOC_JPEG_Q
export const HW_RENDER_TIMEOUT = DOC_RENDER_TIMEOUT

function newCanvas(w, h) {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(w))
  cv.height = Math.max(1, Math.round(h))
  return cv
}

function toBlob(cv, type, quality) {
  return new Promise((res, rej) => {
    try {
      cv.toBlob((b) => (b ? res(b) : rej(new Error('这一页画不出图来'))), type, quality)
    } catch (e) {
      /* 跨域污染的 canvas 在 toBlob 这一步才抛（SecurityError）。本机服务发的 PDF 是同源的
         （`/api/doc/file/...`），正常走不到 —— 真走到了要说人话。 */
      rej(new Error('这一页的图取不出来（canvas 被跨域污染了？）：' + String((e && e.message) || e)))
    }
  })
}

/* 位图 → 可 drawImage 的图（和 ask-images.js 同一条：优先 createImageBitmap）。 */
async function blobToImage(blob) {
  if (typeof createImageBitmap === 'function') return await createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  const img = await new Promise((res, rej) => {
    const el = new Image()
    el.onload = () => res(el)
    el.onerror = () => rej(new Error('这张图读不回来'))
    el.src = url
  })
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return img
}

/** 一页 → 带页码白带的图（白带在上方，写着"第 N 页"）。 */
async function drawPage(path, page, timeoutMs) {
  const made = await renderDocPageBlob(path, page, HW_PAGE_PX, { type: 'image/png', timeoutMs })
  const src = await blobToImage(made.blob)
  const lh = labelHeightOf(made.w)
  const cv = newCanvas(made.w, made.h + lh)
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.drawImage(src, 0, lh)
  /* ★ 页码**画在图上**：模型看不见我们的字段名（提示词第一句就是"页码写在每张图的上方"）。 */
  ctx.fillStyle = '#111'
  ctx.font = `600 ${Math.round(lh * 0.6)}px "Segoe UI", "Microsoft YaHei", sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(`第 ${page} 页`, Math.round(lh * 0.4), lh / 2)
  const blob = await toBlob(cv, 'image/jpeg', HW_JPEG_Q)
  return { page, blob, w: cv.width, h: cv.height }
}

/**
 * 把作业的那几页画成图。**顺序 = 页序**（调用方按这个顺序塞进 `file`、`file2`…）。
 * 一页画不出来就抛 —— 宁可整趟不成，也不发一趟"少了一页"的请求
 * （少一页的表现是"这一页上的题它说找不到"，比直接报错更难查）。
 */
export async function buildHomeworkImages({ path, pages = [], timeoutMs = HW_RENDER_TIMEOUT, onStep } = {}) {
  const out = []
  for (const page of pages) {
    if (onStep) onStep(`正在画第 ${page} 页…`)
    out.push(await drawPage(path, page, timeoutMs))
  }
  return out
}

/**
 * 问这一趟：画图 → 出网 → 收题。
 *
 * ── 两种"选题"入口，出网这一层只在**发哪几张图**上分岔 ────────────────────
 *   · **打字说**（`region` 为空）：一页一张图（`file`、`file2`…），顺序 = 页序，
 *     页码画在每张图上方；提示词里带着他那句话（"第 12 页第 3 题"）。
 *   · **框住题号**（`region` 给的是页内归一化矩形）：两张图 ——
 *     第一张整页（**红框**标出他圈的那一块）、第二张红框里放大，
 *     再带一个 `picked=1`（提示词的说法跟着换，见 server-ocr.js 的 `homeworkPickBlock`）。
 *     这一趟**一定只有一页**：框本身就把页号定死了。
 *
 * @param {object} arg
 *   · path       作业所在资料的路径（`.资料/xxx.pdf`）
 *   · pages      哪几页（1 起，已夹过上限）
 *   · ask        学生说的那句话（**原样**发给模型 —— 题号不解析，见 homework.js 文件头）
 *   · knowledge  这节课的讲义（`collectKnowledge(...).text`，可能为空）
 *   · region     他**框住的那一块**（页内归一化矩形，`ask-region.js` 给的）——
 *                给了就是"圈选题"，那时候 `pages` 只取第一个
 *   · signal     AbortSignal
 *   · onStep(text)  进度（"正在画第 2 页…"、"正在让老师做…"）
 * @returns {{ problems, dropped, error, pages, images, picked, note, shots }}
 *   `error` 非空 = 这一趟没成（画图失败 / 网络 / 服务端旧版 / 回话不是 JSON）。
 *   ★ 「回了个空数组」**不是** error：那是模型照提示词回的"这一页上没看到第 X 题"，
 *     界面要把 `explain` 里那句话显示出来 —— 所以它走 `problems`（空数组）+ 无 error。
 *   ★★ `shots`（2026-09-22 加的）是**这一趟画出来的那几张页图**（`[{blob,page}]`）。
 *     留着它就是为了**追问**：学生对着答案接着问时，老师必须还看得见那道题
 *     （见 `askProblemFollowup`）。不还的话，每一轮追问都要把这几页**重画一遍** ——
 *     一条 1440px 的页图要几百毫秒，一节课问五六轮就是白白多等好几秒，
 *     而画出来的东西**一模一样**。代价是这几张 blob 会一直挂在内存里，
 *     直到窗里重发一趟（`run` 用新的一批替掉）或窗关掉（整个对象没了）。
 *     `blob` 是**只读**的（`FormData.append` 不会动它），所以复用是安全的。
 */
export async function askHomework({ path, pages = [], ask = '', knowledge = '', region = null, signal, onStep } = {}) {
  const picked = !!(region && Number(pages[0]) > 0)
  const want = picked ? [Number(pages[0])] : [...pages]
  const out = { problems: [], dropped: 0, error: '', pages: want, images: 0, picked, note: '', shots: null }
  if (!path) {
    out.error = '没说要问哪一份资料'
    return out
  }
  if (!want.length) {
    out.error = picked ? '没说要问哪一页' : '没说要问哪一页'
    return out
  }
  let shots
  try {
    if (picked) {
      if (onStep) onStep(`正在画第 ${want[0]} 页…`)
      /* ★ 这一趟复用「框选追问」那两张图（见文件头那个 import 的说明）。
         ⚠ 它**抛错**而不是返回 `{error}`（那边是 AskBox 直接 catch 的写法），
           所以这里必须包起来 —— 漏了的话整趟会带着一个未捕获的 promise 静默失败。 */
      const made = await buildAskImages({ path, page: want[0], region })
      shots = [{ blob: made.page, page: want[0] }, { blob: made.crop, page: want[0] }]
    } else {
      shots = await buildHomeworkImages({ path, pages: want, onStep })
    }
  } catch (e) {
    out.error = picked ? '这一页的图造不出来：' + String((e && e.message) || e) : '这几页画不出图来：' + String((e && e.message) || e)
    return out
  }
  if (!shots.length) {
    out.error = '这几页画不出图来'
    return out
  }
  out.images = shots.length
  out.shots = shots

  if (onStep) onStep('正在让老师做这道题…')
  const fd = new FormData()
  shots.forEach((s, i) => fd.append(i === 0 ? 'file' : 'file' + (i + 1), s.blob, `hw-p${s.page}.jpg`))
  fd.append('mode', 'homework')
  fd.append('question', String(ask || ''))
  /* 讲义可能有一两万字 —— 空串也发（服务端那一段会自动换成"这次没给你讲义"）。 */
  if (knowledge) fd.append('knowledge', knowledge)
  /* 圈选题：告诉服务端"那两张图是整页 + 红框里放大"（提示词的说法跟着换）。
     值只认 '1'（服务端那边也是这么判的）。 */
  if (picked) fd.append('picked', '1')
  let res
  try {
    res = await fetch('/api/ocr', { method: 'POST', body: fd, signal })
  } catch (e) {
    if (e && e.name === 'AbortError') {
      out.error = '已取消'
      return out
    }
    out.error = '请求本地服务失败：' + String((e && e.message) || e)
    return out
  }
  const body = await res.json().catch(() => null)
  if (!body) {
    out.error = `本地服务返回了看不懂的内容（HTTP ${res.status}）`
    return out
  }
  if (!body.ok) {
    out.error = body.kind === 'stale' ? HW_STALE_HINT : body.error || '这一趟没问出来'
    return out
  }
  /* ★ 回声校验（和「美化手写」「课件整理」「框选追问」同一条防线）：
     服务端没重启的话它不认 mode:'homework'，会**按公式认**并把结果塞在 latex 里回来 ——
     不查这一条就会把一句 LaTeX 当成答案显示出来，而且不报任何错
     （2026-09-16「美化手写依旧在认公式」那个 bug 的形状）。 */
  if (body.mode !== 'homework') {
    out.error = HW_STALE_HINT
    return out
  }
  const parsed = parseHomework(body.text)
  out.problems = parsed.problems
  out.dropped = parsed.dropped
  out.error = parsed.error
  out.note = body.note || ''
  out.debug = body.debug || null
  return out
}

/**
 * 追问：学生对着**老师刚给的那段答案**接着问（"这一步为什么要除以 m"）。
 *
 * ── 这一趟和 `askHomework` 差在哪儿 ──────────────────────────────────────
 *   · **不再画图**：那几页页图上一趟就画好了（`askHomework` 的 `shots`），
 *     这一趟把它们**原样再发一次** —— 学生问的是答案里某一步，老师必须还看得见题。
 *     重画一遍的代价是白等几百毫秒，而画出来的是同一张图（见 `askHomework` 的注释）。
 *   · **带上对话**：`history` 是"这道题 + 老师给的答案 + 前面问过的几轮"
 *     （`problemHistory` 拼的，纯逻辑在 homework.js，那边测得着）。
 *     ★ 有了它，老师才知道"这一步"指的是哪一步 —— 没有历史的话，
 *       一个凭空冒出来的"为什么除以 m"它连是哪道题都不知道。
 *   · `mode` 换成 `hwask`（服务端的提示词跟着换：见 server-ocr.js 的 `HWASK_PROMPT`）。
 *
 * @param {object} arg
 *   · shots     **上一趟画好的那几张页图**（`askHomework` 的返回值里的 `shots`）。
 *               没有它这一趟就发不出去 —— 报错说人话，不去偷偷重画。
 *   · problem   这道题（`result.problems[i]`）：题目 + 老师给的答案 + 解析
 *   · turns     这道题下面**已经问过的**几轮（`[{role,text}]`，`pending` 的会被丢掉）
 *   · question  这一次问的那句话（学生打的）
 *   · signal / onStep  同 `askHomework`
 * @returns {{ text, error, note, debug }}
 *   追问的回复是**一段话**（不是题目数组）—— 失败时 `text` 为空、`error` 有人话。
 */
export async function askProblemFollowup({ shots = [], problem = null, turns = [], question = '', signal, onStep } = {}) {
  const out = { text: '', error: '', note: '', debug: null }
  const q = String(question || '').trim()
  if (!q) {
    out.error = '还没写要问的话'
    return out
  }
  /* ⚠ 这一趟**必须**有页图：没有的话提示词里的"上面那几页"就是空话，
     模型只能凭历史里那段文字瞎讲。宁可明说"这一趟发不出去"，也不发一趟空口请求。 */
  const imgs = (Array.isArray(shots) ? shots : []).filter((s) => s && s.blob)
  if (!imgs.length) {
    out.error = '这一趟找不到作业页的图 —— 把这道题重新做一遍再来追问'
    return out
  }
  if (onStep) onStep('正在问老师…')
  const fd = new FormData()
  imgs.forEach((s, i) => fd.append(i === 0 ? 'file' : 'file' + (i + 1), s.blob, `hw-p${s.page}.jpg`))
  fd.append('mode', 'hwask')
  /* `question` 装的是**这一次问的那句话**（和框选追问同一个字段）。
     ⚠ 服务端把它拼在**最后一条** user 消息里，不拼进第 0 条 ——
       拼进第 0 条会把前缀缓存打断（那几页图要按全价重算，见 server-ocr.js 那段）。 */
  fd.append('question', q)
  const history = problemHistory(problem, turns)
  if (history.length) fd.append('history', JSON.stringify(history))
  let res
  try {
    res = await fetch('/api/ocr', { method: 'POST', body: fd, signal })
  } catch (e) {
    if (e && e.name === 'AbortError') {
      out.error = '已取消'
      return out
    }
    out.error = '请求本地服务失败：' + String((e && e.message) || e)
    return out
  }
  const body = await res.json().catch(() => null)
  if (!body) {
    out.error = `本地服务返回了看不懂的内容（HTTP ${res.status}）`
    return out
  }
  if (!body.ok) {
    out.error = body.kind === 'stale' ? HW_STALE_HINT : body.error || '这一趟没问出来'
    return out
  }
  /* 回声校验：本地服务没重启的话它不认 `mode:'hwask'`，**按公式认**，
     结果塞在 `latex` 里回来 —— 不查这一条就会把一句 LaTeX 当成老师的回答显示出来
     （2026-09-16「美化手写依旧在认公式」那个 bug 的形状）。
     ★★ 服务端那边的白名单（server.js 里那个 `if (mode === ...)`）如果不认 hwask，
        它也会走这条路回来（`latex` 而非 `text`）—— 两道闸拦的是同一个形状。 */
  if (body.mode !== 'hwask') {
    out.error = HW_STALE_HINT
    return out
  }
  out.text = String(body.text || '').trim()
  out.note = body.note || ''
  out.debug = body.debug || null
  if (!out.text) out.error = '老师这一趟没说什么（可能觉得这一点没什么可讲的）'
  return out
}
