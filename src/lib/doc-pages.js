/* 资料的页面渲染（pdf.js 的那点接线，全收在这一个文件里）。
 *
 * ── 为什么这一层单独存在 ───────────────────────────────────────────────
 * DocLayer（组件）管"每页摆哪儿、什么时候该画"；这个 module 管"怎么把 PDF
 * 的第 n 页画到一块 canvas 上"。两件事分开的理由：
 *   · pdf.js 的 worker、文档缓存、渲染取消都是**有状态的机器**，
 *     组件里散着写的话，卸载/换文件/快速缩放这几条路上一定会漏收拾；
 *   · 以后别的地方要用页面位图（比如导出），也从这儿拿。
 *
 * ── worker ─────────────────────────────────────────────────────────────
 * pdf.js 解析 PDF 在 worker 线程里跑（不卡笔迹那一帧）。vite 的 `?url` import
 * 会把 worker 文件按内容哈希拷进 dist 并给出地址 —— 开发（dev）和生产（dist）
 * 两条路都通，不用任何环境判断。
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

/* 资料文件的 URL。★ 路径**整体**编码（%2F）—— 和 files.js 的 /api/file 同一条规矩：
   相对路径里的 `/` 是分隔符，服务端 decode 之后再拆；一段一段编码反而会漏。 */
export function docFileUrl(relPath) {
  return '/api/doc/file/' + encodeURIComponent(String(relPath || ''))
}

/* 同一份 PDF 的解析结果缓存住：插入时量尺寸、渲染时画页面，走的都是同一个 worker 文档。 */
const opened = new Map() // path -> Promise<PDFDocumentProxy>

function getDoc(path) {
  let p = opened.get(path)
  if (!p) {
    p = getDocument({ url: docFileUrl(path), isEvalSupported: false }).promise
    /* 拉挂了就把缓存清掉：下一次（用户重试/换网络）是真的重新打开，不是拿到同一个烂 Promise。 */
    p.catch(() => opened.delete(path))
    opened.set(path, p)
  }
  return p
}

/** 一份资料的基本信息：每一页的 [宽, 高]（PDF 点数，scale=1 的视口）。
 *  插入那次调它，结果存进板文件（docs.js 的 `pages` 字段）—— 以后打开不再量。 */
export async function readDocInfo(path) {
  const doc = await getDoc(path)
  const pages = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    pages.push([vp.width, vp.height])
  }
  return { numPages: doc.numPages, pages }
}

/* 单页渲染的像素宽上下限：太小看不清字，太大一块 canvas 就是几十 MB 显存。 */
const MIN_PIX_W = 240
const MAX_PIX_W = 2600

/** 这一页该按多宽（像素）渲染才够当前看：世界宽 × 视图缩放 × dpr，夹进上下限。 */
export function targetPixelWidth(worldW, viewS, dpr) {
  const raw = (Number(worldW) || 0) * (Number(viewS) || 1) * (Number(dpr) || 1)
  return Math.min(MAX_PIX_W, Math.max(MIN_PIX_W, Math.round(raw)))
}

/**
 * 把一份资料的第 n 页（1 起）画到 canvas 上。
 * @param {object} holder 可选：渲染中途 `holder.task` 会指向这次的任务，
 *   调用方卸载/换页时 `holder.task.cancel()` 能立刻停（不占 worker）。
 */
export async function renderDocPage(path, pageNum, canvas, pixelW, holder = null) {
  const doc = await getDoc(path)
  const page = await doc.getPage(pageNum)
  const vp1 = page.getViewport({ scale: 1 })
  const scale = (Number(pixelW) > 0 ? Number(pixelW) : MIN_PIX_W) / vp1.width
  const vp = page.getViewport({ scale })
  canvas.width = Math.max(1, Math.round(vp.width))
  canvas.height = Math.max(1, Math.round(vp.height))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const task = page.render({ canvasContext: ctx, viewport: vp })
  if (holder) holder.task = task
  try {
    await task.promise
  } finally {
    if (holder && holder.task === task) holder.task = null
  }
}

/* ═══════════ 「课件整理」用的那一页位图（2026-09-22）═══════════
 *
 * 同一份 PDF、同一个 worker 文档、同一套渲染 —— 只是**另一组参数**：
 *   · 显示要的是"够当前视图清晰"（跟着缩放和 dpr 走，夹在 240~2600）；
 *   · 整理要的是"模型看得清"（固定档位，和你在屏幕上缩到多大无关 ——
 *     不然"缩放 40% 的时候点的整理"发出去的图会糊得认不出）。
 * 所以参数从调用方给，`renderDocPage` 一行都不用改 —— 那正是它当初
 * 写成"像素宽由调用方定"的用处（文件头第 8 行那句"以后别的地方要用页面位图"）。
 */

/** 一页画成 JPEG/PNG blob。**每次都新造一张 canvas**：它要被异步编码成 blob，
 *  借用页面上那张共用画布的话，下一次渲染会当场把上一个人在编码的图擦掉。 */
export async function renderDocPageBlob(path, pageNum, pixelW, { type = 'image/png', quality } = {}) {
  const cv = document.createElement('canvas')
  await renderDocPage(path, pageNum, cv, pixelW)
  const blob = await new Promise((res) => (quality != null ? cv.toBlob(res, type, quality) : cv.toBlob(res, type)))
  if (!blob) throw new Error('这一页画不出图来')
  return { blob, w: cv.width, h: cv.height }
}
