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
import { isImageDoc } from './docs.js'

/* ── pdf.js 是**用到才拉**的（2026-09-24）─────────────────────────────────
 *
 * 它编译进主包是 1.28 MB 里的绝大部分，而"打开一块板"这件事根本用不到它 ——
 * 只有真的要显示/读一份 PDF 才需要。所以这里不写在文件头顶上，
 * 改成第一次要用的时候 `await import(...)`。
 *
 * ★ 拉一次就够：worker 地址（`GlobalWorkerOptions.workerSrc`）是**全局的**，
 *   设一遍即可；`loadPdfjs` 把那个 Promise 存住，第二个人拿到的是同一份。
 * ★ 拉挂了要**允许下次重试**（和下面 `getDoc` 那条 catch 同一个理由）：
 *   缓存着一个烂 Promise，等于"这台机器上 PDF 永远打不开，除非刷新页面"。
 */
let pdfjsPromise = null

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      /* 库和 worker 地址两件事互不依赖 —— 一起等，别串行两次往返。 */
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })()
    pdfjsPromise.catch(() => {
      pdfjsPromise = null
    })
  }
  return pdfjsPromise
}

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
    p = loadPdfjs().then(({ getDocument }) => getDocument({ url: docFileUrl(path), isEvalSupported: false }).promise)
    /* 拉挂了就把缓存清掉：下一次（用户重试/换网络）是真的重新打开，不是拿到同一个烂 Promise。 */
    p.catch(() => opened.delete(path))
    opened.set(path, p)
  }
  return p
}

/** 把这份 PDF 的解析缓存丢掉 —— 下一次 `getDoc` 会**重新开一份**（新的 worker 文档）。
 *
 *  ★ 为什么要它（2026-09-20 踩的）：pdf.js 那条渲染链**偶发卡死** —— 一次
 *    `page.render()` 的 promise 永远不 settle，界面上就是"正在一页一页讲（3/49）"
 *    停在那儿：不报错、不发请求、点「■ 停止」也停不下来（那一下只能拦住后面的页），
 *    只能刷新页面。实测这一天撞了三次（一次停在第 4 页、一次停在 0/3）。
 *    卡死的原因在 pdf.js 内部（worker 或它的渲染队列），外面看不见也没法取消 ——
 *    但**换一份文档重来**是有效的：所以 `doc-read.js` 给每一页的渲染加了超时，
 *    超了就把这里清掉、重开一次再试。 */
export function dropDoc(path) {
  const p = opened.get(path)
  opened.delete(path)
  try {
    p && p.then((doc) => doc && doc.destroy && doc.destroy())
  } catch {
    /* 销毁失败无所谓：我们要的只是"下一次重新开" */
  }
}

/* ══════════ 图片那一半（2026-09-21）══════════════════════════════════════
 *
 * 一份资料未必是 PDF —— 截图、手机上拍一道题，进来都是一张图。
 * 两者的区别只有"这一页的像素从哪儿来"：PDF 交给 pdf.js 渲染，图片解码后 drawImage。
 *
 * ★★ 这条分岔**只发生在这个文件里**（`readDocInfo` / `renderDocPage` 那两处）：
 *    屏幕上的资料层、框选追问、作业辅导、课件整理，全都是只认这一对函数拿像素的 ——
 *    所以它们一个字都不用改，图片资料天生就能被圈起来问、能当作业那份书。
 *    这正是当初"怎么把一页变成 canvas"收在一个文件里的用处；
 *    要是在那些地方各判一次"是不是图"，那才是真的埋雷（漏一处就是一个打不开的窗）。
 */
const images = new Map() // path -> Promise<ImageBitmap | HTMLImageElement>

/** 资料那张图（解码好的，能直接 drawImage）。同一份只解码一次。 */
export function loadImageDoc(path) {
  let p = images.get(path)
  if (!p) {
    p = (async () => {
      const res = await fetch(docFileUrl(path))
      if (!res.ok) throw new Error('这份资料读不出来（' + res.status + '）')
      const blob = await res.blob()
      if (typeof createImageBitmap === 'function') return await createImageBitmap(blob)
      const url = URL.createObjectURL(blob)
      try {
        return await new Promise((resolve, reject) => {
          const el = new Image()
          el.onload = () => resolve(el)
          el.onerror = () => reject(new Error('这张图读不回来'))
          el.src = url
        })
      } finally {
        URL.revokeObjectURL(url)
      }
    })()
    /* 读坏了就把缓存清掉：下一次（重试 / 换网络）是真去读，不是拿到同一个烂 Promise。
       和上面 `getDoc` 那条 catch 是同一个理由。 */
    p.catch(() => images.delete(path))
    images.set(path, p)
  }
  return p
}

/** 一份资料的基本信息：每一页的 [宽, 高]（PDF 点数 scale=1 的视口 / 图片的原始像素）。
 *  插入那次调它，结果存进板文件（docs.js 的 `pages` 字段）—— 以后打开不再量。 */
export async function readDocInfo(path) {
  if (isImageDoc(path)) {
    const img = await loadImageDoc(path)
    /* 图片就**一页**，页面的宽高比就是它自己的宽高 —— 往下摆版那一套（docs.js 的 pageRects）
       根本不问这一份是图还是 PDF，也不需要问。 */
    return { numPages: 1, pages: [[Math.max(1, img.width || 1), Math.max(1, img.height || 1)]] }
  }
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

/** 一个 pdf.js 的 `page` → canvas。**这是"一页怎么变成像素"的唯一一处**：
 *  尺寸按 `pixelW` 反推缩放、先铺白底、渲染任务挂到 `holder` 上（要能取消）。
 *  显示那一趟（屏幕上翻页）和预览那一趟（还没上传的那一份）都调它 ——
 *  各写一份的话，总有一处的图和另一处差一点（白底、页数夹取、卡住时取消不了）。 */
async function drawPdfPage(page, canvas, pixelW, holder = null) {
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
  /* 图片那一条路：**整张图就是那一页**（`pageNum` 只能是 1；万一有人传了别的数，
     当第 1 页画 —— 犯不着为一个数让整页白屏）。 */
  if (isImageDoc(path)) {
    const img = await loadImageDoc(path)
    const want = Number(pixelW) > 0 ? Number(pixelW) : MIN_PIX_W
    const srcW = Math.max(1, img.width || 1)
    const srcH = Math.max(1, img.height || 1)
    canvas.width = Math.max(1, Math.round(srcW * (want / srcW)))
    canvas.height = Math.max(1, Math.round(srcH * (want / srcW)))
    const ctx = canvas.getContext('2d')
    /* 先铺白：PNG 可能是透明的，而它要被编码成 JPEG 发给模型 ——
       透明地方不铺白的话，模型看到的图是一片黑。 */
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return
  }
  const doc = await getDoc(path)
  const page = await doc.getPage(pageNum)
  await drawPdfPage(page, canvas, pixelW, holder)
}

/* ══════════ 还没上传的那一份：抽页之前的预览（2026-09-21）════════════════
 *
 * 用户 2026-09-21 的原话：「页数可能由于封面没有被计算在内从而有些许偏差……
 *   应该有个预览功能能够让用户确认这是不是他需要的这一页」。
 * 他写"第 322 页"，可 PDF 的第 322 页常常**不是**书上印的第 322 页（封面、前言
 * 没算进页码）。所以在抽出来之前，得让他**先看见那几页**。
 *
 * ★ 为什么不能复用 `getDoc(path)`：那一份是按**服务端路径**开的，而预览这一刻
 *   文件还在他手里 —— 路径都还没有（`data/.资料/` 里根本没这份东西）。
 *   所以这里从**字节**开一份：给 `ArrayBuffer` / `Uint8Array` 都行。
 * ★ 画法仍然只有一份（上面的 `drawPdfPage`）—— 预览不必自己去算缩放和白底。
 * ★ 用完必须 `close()`：这是**额外开的一份文档**（和屏幕上那份并存），
 *   几百页的书开两份不是小数。
 */
export async function openLocalThumbs(data) {
  const { getDocument } = await loadPdfjs()
  /* ⚠ 拷一份字节给它：pdf.js 会把拿到的 buffer 当自己的地盘（可能 detach），
     而同一份字节 pdf-lib 那边还要拿去抽页 —— 两边共享一个 buffer 的那天，
     就是"抽出来的页怎么是空的"那一天。 */
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0))
  const doc = await getDocument({ data: bytes, isEvalSupported: false }).promise
  return {
    count: doc.numPages,
    /** 把第 n 页（1 起，越界夹到首尾）画到 canvas 上。 */
    async draw(pageNum, canvas, pixelW, holder = null) {
      const n = Math.min(Math.max(1, Math.round(Number(pageNum) || 1)), doc.numPages)
      const page = await doc.getPage(n)
      await drawPdfPage(page, canvas, pixelW, holder)
    },
    close() {
      try {
        doc.destroy && doc.destroy()
      } catch {
        /* 关不掉就算了：要的只是"这份文档别再占着" */
      }
    },
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
 *  借用页面上那张共用画布的话，下一次渲染会当场把上一个人在编码的图擦掉。
 *
 *  ★ `timeoutMs`（2026-09-20 加的）：pdf.js 那条渲染链**偶发卡死** —— `page.render()`
 *    的 promise 永远不 settle，界面上就是"正在一页一页讲（3/49）"停在那儿，
 *    不报错、不发请求、点「■ 停止」也停不下来（那一下只能拦住后面还没发的页）。
 *    超时之后**先丢文档、再重来一次**（`dropDoc` + 新文档），还是不行就把这一页
 *    当失败报出去 —— 至少比"永远转圈"强，而且用户能点「↻ 重讲这一页」。 */
export async function renderDocPageBlob(path, pageNum, pixelW, { type = 'image/png', quality, timeoutMs = 0 } = {}) {
  const once = async () => {
    const cv = document.createElement('canvas')
    await renderDocPage(path, pageNum, cv, pixelW)
    const blob = await new Promise((res) => (quality != null ? cv.toBlob(res, type, quality) : cv.toBlob(res, type)))
    if (!blob) throw new Error('这一页画不出图来')
    return { blob, w: cv.width, h: cv.height }
  }
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0
  if (!limit) return once()
  const timed = (ms) =>
    new Promise((_, rej) => {
      setTimeout(() => rej(new Error(`这一页画了 ${Math.round(ms / 1000)} 秒还没画完（渲染卡住了）`)), ms)
    })
  try {
    return await Promise.race([once(), timed(limit)])
  } catch (e) {
    /* 卡住的那一次已经没救了（它的 promise 永远不 settle）—— 把文档丢掉重开一份再试。
       ⚠ 这里**不 await** 第一次的那个 promise：它永远不会结束。 */
    dropDoc(path)
    return await Promise.race([once(), timed(limit)])
  }
}

/* ══════════ 页面上的**文字**（2026-09-28：给「速查」用）════════════════════
 *
 * 「上课突然不懂一个词」那条路要能在课件上点到那个词 —— 可资料层是 canvas 画的，
 * 屏幕上一个个字都是像素，**没有东西能"选中"**（整层 `pointer-events:none`
 * 是为了让笔写得上资料，那条铁律不能破）。
 * 好在 pdf.js 另有一套：`getTextContent()` 直接给**带坐标的文字**，不依赖渲染，
 * 连 worker 那边都不用再画一遍 —— 用的还是 `getDoc` 那份同一个文档。
 *
 * ★ 坐标一律**归一化**（相对这一页宽高的 0~1），两个理由：
 *   ① 板上不存屏幕坐标是铁律（board.js 那条），将来过一道手就脏了；
 *   ② 调用方手上是"点在页面的哪个相对位置"，两边用同一个说法最省事，
 *      也不用把 viewport 的大小传出去再乘回来。
 *
 * ⚠⚠ y 轴要**翻过来**：pdf.js 给的是 PDF 坐标（y 朝上，原点在左下），
 *    而界面习惯 0 在顶。翻错的表现很隐蔽 —— 点的明明是标题，取到的却是正文。
 *
 * ⚠ 图片资料（手机拍的题、截图）**没有文字这一层** —— 返回 `null`，
 *   不是空数组。这两者不一样：空数组 = "这一页确实没有字"，
 *   `null` = "这份资料天生就没有字可取"（调用方该给的是另一句话）。
 */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** 第 n 页有哪些字、都在哪儿。 */
export async function pageTextItems(path, pageNum) {
  if (isImageDoc(path)) return null
  const doc = await getDoc(path)
  const n = Math.min(Math.max(1, Math.round(Number(pageNum) || 1)), doc.numPages)
  const page = await doc.getPage(n)
  const vp = page.getViewport({ scale: 1 })
  const vw = Number(vp.width) || 1
  const vh = Number(vp.height) || 1
  const tc = await page.getTextContent()
  const out = []
  for (const it of tc.items || []) {
    const str = String((it && it.str) || '')
    /* 空串的那个 item pdf.js 也会给（它记的不是字，是一次字体切换的位置）——
       它参与不了"点到了哪个字"，留着还会把命中算错。 */
    if (!str.trim()) continue
    const m = it.transform || []
    const x = Number(m[4]) || 0
    const size = Math.abs(Number(m[3]) || 0)
    /* ⚠ `m[5]` 是**基线**的 y（PDF 里 y 朝上）⇒ 它是这一行的**底**，顶 = 底 + 字号。
       当成左上角 y 的话，整行判定会往上挪一个字高。
       为了让"点在标题上"别判成正文，上下各留一点量（见 below padding）。 */
    const bottom = Number(m[5]) || 0
    const w = Number(it.width) || 0
    const pad = size * 0.25
    out.push({
      str,
      x0: clamp01(x / vw),
      x1: clamp01((x + w) / vw),
      y0: clamp01(1 - (bottom + size + pad) / vh),
      y1: clamp01(1 - (bottom - pad) / vh),
    })
  }
  return out
}
