/* 「框选追问」的两张图**怎么算**（纯函数，node 里断言得住）。
 *
 * ⚠ 为什么不和渲染那一半住在一起（`ask-images.js`）：那个文件一 import 就拉起 pdf.js
 *   （`doc-pages.js` 的 `?url` 那两条 vite 语法 node 读不了），于是任何想在 node 里
 *   断言的脚本连碰都碰不到它。规矩是仓库里那条老的（见 doc-cards.js 的分批函数、
 *   doc-read.js 的文件头）：**能被断言的纯函数住一个 node 碰得到的文件**，
 *   真正要浏览器的那一半（canvas、pdf.js）住另一个。
 *
 * 这里错一件的代价都是**安静的**：
 *   · 页内矩形换错 → 红框画在你没圈的地方，模型照着你**没圈**的地方讲；
 *   · 裁图该多大算错 → 模型看不清那个小符号，于是编一个解释（比不回答糟）。
 * 两种都不会报错，所以规矩收在一处、`check:askfollow` 在 node 里钉着。
 */

/** 整页渲染成多宽（像素）。和「课件整理」同一档（doc-read.js 的 DOC_PAGE_PX = 1440）——
 *  同一种图、同一个模型，没有理由用两个数。 */
export const ASK_PAGE_PX = 1440
/** 裁图放大到多宽就够读了：900 宽的一行字在视觉模型眼里很清楚。
 *  再大只是变贵（源图就那么大，放大不会变清楚）。 */
export const ASK_CROP_PX = 900
/** 裁图源宽到这个数就不必再放大了（再放只是把源像素摊开，变糊不变清楚）。 */
export const ASK_CROP_MIN_SRC = 480
/** 裁图最多放大几倍。超过这个数就只是糊 —— 真需要更清楚得**重渲染一页更大的**。 */
export const ASK_CROP_MAX_ZOOM = 3
/** 重渲染**之后**允许的放大上限。
 *  ★ 为什么重渲染之后可以放宽：这时候源像素是**真的**变多了（整页按 3200 宽重画过，
 *    不是插值放出来的），所以多放两倍得到的是细节而不是马赛克。
 *  ⚠ 没有这一档的话，"圈一个小符号"那条路会走进死胡同：重渲染到上限之后
 *    （`ASK_RENDER_MAX_W`）源宽可能仍然只有 80px，卡在 ×3 就只剩 240 宽 ——
 *    比不重渲染好不了多少，而多花了一次渲染的钱。 */
export const ASK_CROP_MAX_ZOOM_HI = 8
/** 重渲染的上限（像素宽）：再大一页 JPEG 会顶到服务端的请求体上限。
 *  3200 ≈ 1440 的 2.2 倍，已经够把一个小符号放到看清。 */
export const ASK_RENDER_MAX_W = 3200
/* JPEG 质量：课件是"文字 + 图形"，0.85 和「课件整理」同一档
   （doc-read.js 的 DOC_JPEG_Q：文字边缘不糊、一页 150~350KB）。 */
export const ASK_JPEG_Q = 0.85
/** 单页渲染多久算"卡住了"（毫秒）—— 和「课件整理」同一档理由（doc-pages.js 那段）。 */
export const ASK_RENDER_TIMEOUT = 30000

/** 顶上那条"第 N 页"的白带占多高（像素）。按页宽的一个比例 ——
 *  写死像素的话，重渲染成 3200 宽时那行字会小得看不见。 */
export const labelHeightOf = (w) => Math.max(28, Math.round((Number(w) || ASK_PAGE_PX) * 0.032))

/** 页内归一化矩形（0~1）→ 那张位图上的**像素矩形**。
 *  `labelH` 是顶上那条页码白带占了多高 —— 版面整体被它往下推了，红框和裁图都得跟着让
 *  （不让的话红框会比真实位置高一条，而模型会照着那个偏了的框讲）。
 *  ⚠ 结果已经夹在位图范围里：越界的矩形画不出东西，裁出来是空白。 */
export function pixelRectOf(region, imgW, imgH, labelH = 0) {
  const W = Math.max(1, Number(imgW) || 1)
  const H = Math.max(1, (Number(imgH) || 1) - (Number(labelH) || 0))
  const r = region || {}
  const cx = Math.min(1, Math.max(0, Number(r.x) || 0))
  const cy = Math.min(1, Math.max(0, Number(r.y) || 0))
  const cw = Math.min(1 - cx, Math.max(0, Number(r.w) || 0))
  const ch = Math.min(1 - cy, Math.max(0, Number(r.h) || 0))
  return {
    x: Math.round(cx * W),
    y: Math.round((Number(labelH) || 0) + cy * H),
    w: Math.max(1, Math.round(cw * W)),
    h: Math.max(1, Math.round(ch * H)),
  }
}

/**
 * 裁图该画多大、要不要先重渲染一页更大的。
 *
 * ★ 为什么要有"重渲染"这条路：圈住一个小符号时，它在 1440 宽的整页图上可能只有
 *   30 像素宽 —— 放大 3 倍也只有 90 像素，模型照样看不清。这时候唯一的办法是
 *   把整页按**更大的像素宽**重画一遍（源像素真的变多了，不是插值放出来的）。
 *   代价是慢一点、贵一点，所以只在真的看不清时才走。
 *
 * @param {object} arg
 *   · srcW     现在这张位图的像素宽
 *   · rect     要裁的那一块（源位图坐标系，`pixelRectOf` 给的）
 *   · srcPageW 现在这张位图是**按多宽渲染**出来的（重渲染时按它算倍数）
 *   · want / minSrc / maxZoom / maxRenderW  见上面那几个常量
 * @returns {{w, h, zoom, rerender, renderW}}
 *   `rerender === true` → 调用方**先按 `renderW` 重新渲染这一页**，再重算 rect 去裁。
 */
export function planCropImage({
  srcW,
  rect,
  srcPageW = ASK_PAGE_PX,
  want = ASK_CROP_PX,
  minSrc = ASK_CROP_MIN_SRC,
  maxZoom = ASK_CROP_MAX_ZOOM,
  maxRenderW = ASK_RENDER_MAX_W,
} = {}) {
  const rw = Math.max(1, Number(rect && rect.w) || 1)
  const rh = Math.max(1, Number(rect && rect.h) || 1)
  const target = Math.max(240, Number(want) || ASK_CROP_PX)
  /* 源像素不够（裁出来那条边太短）→ 按比例把**整页**渲染大一点。
     `minSrc / rw` 就是"至少要把这一块放大到多少倍才够看"。 */
  const base = Number(srcW) > 0 ? Number(srcW) : Number(srcPageW) || ASK_PAGE_PX
  const wantW = rw >= minSrc ? base : Math.ceil(base * (minSrc / rw))
  const renderW = Math.min(maxRenderW, Math.max(Number(srcPageW) || ASK_PAGE_PX, wantW))
  const rerender = renderW > base + 1
  /* ★ 放大上限分两档：这一版整页是不是已经**按更大的像素宽重画过**（`srcPageW > 1440`）。
     重画过 → 源像素是真的，可以多放两倍（`ASK_CROP_MAX_ZOOM_HI`）；
     没重画 → 老实按 3 倍封顶（再放就是糊）。 */
  const hiZoom = Number(srcPageW) > ASK_PAGE_PX + 1 ? ASK_CROP_MAX_ZOOM_HI : maxZoom
  const zoom = Math.min(hiZoom, Math.max(1, target / rw))
  return {
    w: Math.max(1, Math.round(rw * zoom)),
    h: Math.max(1, Math.round(rh * zoom)),
    zoom: Math.round(zoom * 100) / 100,
    rerender,
    renderW,
  }
}

/** 在（整页那张）位图上画一圈"你圈住的就是这里"的红框。
 *  ★ 为什么画在**像素**上而不是用文字告诉模型坐标：视觉模型对"左上角 (0.31, 0.44)"
 *    这种说法基本无感，但它**看得见**一个红框。
 *  ⚠ 只画在整页那张上：裁图里本来就只剩这一块东西，再画框等于给它镶边。 */
export function strokeRegionRect(ctx, rect) {
  const x = Number(rect && rect.x) || 0
  const y = Number(rect && rect.y) || 0
  const w = Math.max(1, Number(rect && rect.w) || 1)
  const h = Math.max(1, Number(rect && rect.h) || 1)
  const lw = Math.max(3, Math.round(Math.min(w, h) * 0.06))
  ctx.save()
  /* 两道：先一圈半透明白（深色课件上也看得见），再一圈实心红。
     只画一道红的话，红笔迹、红色标题栏那种地方框就"消失"了。 */
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = lw + 4
  ctx.strokeRect(x, y, w, h)
  ctx.strokeStyle = '#e03131'
  ctx.lineWidth = lw
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}
