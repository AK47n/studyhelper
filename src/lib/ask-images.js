/* 「框选追问」要发给模型的两张图：**整页（红框标出你圈的位置）+ 框里那一块放大**。
 *
 * ── 为什么要两张（2026-09-22 定的）───────────────────────────────────────
 * 一张不够，两张各有各的用处：
 *   · **整页**：模型要知道"这一页在讲什么"——上下文。只给裁图它会答得离谱，
 *     而「为什么」恰恰是最需要上下文的问题（这一步为什么成立，答案常常在上一段）；
 *   · **裁图放大**：框里常常是小字、下标、一个符号。整页缩到 1440 宽之后，
 *     那一小块可能只有几十个像素 —— 模型根本看不清你圈的是哪个字母。
 * 所以每次调用发两张：先整页（带红框），再裁图（放大到看得清）。
 * ⚠ 裁图是从**同一张整页位图**上裁的（不再单独渲染一遍 PDF）：两次渲染同一页
 *   会拿到两张可能对不齐的图（缩放取了整），红框和裁图就对不上了。
 *
 * ── 这一层只剩"怎么画" ──────────────────────────────────────────────────
 * 尺寸怎么算、框该多大、要不要重渲染一页更大的 —— 全在 `ask-geometry.js`
 * （纯函数，node 里断言得住）。它要用 canvas 画，所以只能装
 * canvas 那点事：**能被断言的住那边，要浏览器的住这边**（仓库里那条老规矩）。
 */
import { renderDocPageBlob } from './doc-pages.js'
import {
  ASK_CROP_PX,
  ASK_JPEG_Q,
  ASK_PAGE_PX,
  ASK_RENDER_MAX_W,
  ASK_RENDER_TIMEOUT,
  labelHeightOf,
  pixelRectOf,
  planCropImage,
  strokeRegionRect,
} from './ask-geometry.js'

/* 这几个常量从这里转出去，调用方（AskBox）只认一个地方拿全。 */
export { ASK_CROP_PX, ASK_JPEG_Q, ASK_PAGE_PX, ASK_RENDER_MAX_W, ASK_RENDER_TIMEOUT, labelHeightOf, pixelRectOf, planCropImage, strokeRegionRect }

/* ── 造图（只有浏览器里跑得了）────────────────────────────────────────── */

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
      /* 跨域污染的 canvas 在 toBlob 这一步才抛（SecurityError）。
         本机服务发的 PDF 是同源的（`/api/doc/file/...`），正常走不到这里 ——
         真走到了要说人话，而不是丢一个 "SecurityError" 给用户。 */
      rej(new Error('这一页的图取不出来（canvas 被跨域污染了？）：' + String((e && e.message) || e)))
    }
  })
}

/* 位图 → 可 drawImage 的图。优先 createImageBitmap（比"造 <img> 等 onload"
   少一次 blob URL 往返）。 */
async function blobToImage(blob) {
  if (typeof createImageBitmap === 'function') return await createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  const img = await new Promise((res, rej) => {
    const el = new Image()
    el.onload = () => res(el)
    el.onerror = () => rej(new Error('这张图读不回来'))
    el.src = url
  })
  /* 图已经解码进内存，URL 可以放掉（图片元素自己留着那份解码结果）。 */
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return img
}

/** 一页 → 带页码白带的整页 canvas（红框由调用方决定什么时候画）。 */
async function drawPage(path, page, renderW, timeoutMs) {
  const made = await renderDocPageBlob(path, page, renderW, { type: 'image/png', timeoutMs })
  const src = await blobToImage(made.blob)
  const lh = labelHeightOf(made.w)
  const cv = newCanvas(made.w, made.h + lh)
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.drawImage(src, 0, lh)
  /* 页码写在**图上**：模型看不见我们的字段名（server-ocr.js 为「课件整理」写过
     同一件事），而它要能说"这一页"。 */
  ctx.fillStyle = '#111'
  ctx.font = `600 ${Math.round(lh * 0.6)}px "Segoe UI", "Microsoft YaHei", sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(`第 ${page} 页`, Math.round(lh * 0.4), lh / 2)
  return { cv, labelH: lh, srcW: made.w, srcH: made.h }
}

/**
 * 这一趟要发出去的两张图。**唯一的入口** —— 调用方（AskBox）不该自己拼。
 *
 * @param {object} arg
 *   · path    资料路径（`.资料/xxx.pdf`）
 *   · page    页号（1 起）
 *   · region  页内归一化矩形（`ask-region.js` 给的）
 * @returns {{page: Blob, crop: Blob, pageInfo, cropInfo, rect, rendered}}
 *   任意一步失败都抛 —— 调用方把错误显示在小窗里（带一颗「再试一次」）。
 */
export async function buildAskImages({ path, page, region, timeoutMs = ASK_RENDER_TIMEOUT } = {}) {
  const first = await drawPage(path, page, ASK_PAGE_PX, timeoutMs)
  let rect = pixelRectOf(region, first.srcW, first.srcH, first.labelH)
  let plan = planCropImage({ srcW: first.srcW, rect, srcPageW: ASK_PAGE_PX })
  let pageCv = first.cv
  let rendered = { renderW: ASK_PAGE_PX, rerendered: false }

  if (plan.rerender) {
    /* 看不清 → 整页重画一遍更大的（见 `planCropImage` 那段）。重画之后**红框和
       裁图的位置都要重算**：页码白带的高度跟着页宽变，版面整体也往下推了。 */
    const big = await drawPage(path, page, plan.renderW, timeoutMs)
    rect = pixelRectOf(region, big.srcW, big.srcH, big.labelH)
    plan = planCropImage({ srcW: big.srcW, rect, srcPageW: plan.renderW })
    pageCv = big.cv
    rendered = { renderW: plan.renderW, rerendered: true }
  }

  /* 红框画在**最后那一版**整页图上（重渲染之后才画，位置才是对的）。 */
  strokeRegionRect(pageCv.getContext('2d'), rect)
  const pageBlob = await toBlob(pageCv, 'image/jpeg', ASK_JPEG_Q)

  const src = await blobToImage(pageBlob)
  const cropCv = newCanvas(plan.w, plan.h)
  const cctx = cropCv.getContext('2d')
  cctx.fillStyle = '#fff'
  cctx.fillRect(0, 0, cropCv.width, cropCv.height)
  cctx.imageSmoothingEnabled = true
  cctx.imageSmoothingQuality = 'high'
  cctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, cropCv.width, cropCv.height)
  const cropBlob = await toBlob(cropCv, 'image/jpeg', ASK_JPEG_Q)

  return {
    page: pageBlob,
    crop: cropBlob,
    pageInfo: { w: pageCv.width, h: pageCv.height, bytes: pageBlob.size },
    cropInfo: { w: cropCv.width, h: cropCv.height, bytes: cropBlob.size, zoom: plan.zoom, srcW: rect.w, srcH: rect.h },
    rect,
    rendered,
  }
}
