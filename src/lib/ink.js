/* 手写笔迹怎么变成像素。
 *
 * 抽出来单独一个文件，是因为它有两拨用户：
 *   ① 白板的画布（BoardCanvas.jsx，React）
 *   ② 手写识别的"把选中的笔迹渲染成 PNG 发给识别服务"（lib/ocr.js，纯 JS）
 * 如果这段留在 BoardCanvas.jsx 里，② 就得 import 一个 JSX 模块 ——
 * 于是 OCR 变成一个"必须跑 React 才能测"的东西，自检也跟着难做。
 *
 * ⚠ 这个文件**不许 import React、不许碰 DOM**（只用传进来的 ctx）。
 */
import { toPoints } from './geometry.js'

/* 采样步长：**屏幕（CSS）像素** —— 相邻两点比这个还近就不记（防手抖刷点）。
   ⚠ 单位写在名字里，因为两个调用方各自在自己的空间里比：
     · WritingPad 直接在 CSS px 里比（它的画布只叠 dpr，没有缩放）；
     · 白板的落点已经换成世界坐标了，所以要先 `screenLenToWorld(MIN_STEP_SCREEN, view.s)`
       再比 —— 少这一步，放大之后"世界坐标的一小步"在屏幕上其实很大，细节会被吃掉。
   从前这里的注释写的是"世界坐标像素"（错的，白板那边一直在除 s），名字也没带单位。 */
export const MIN_STEP_SCREEN = 0.7

/* 荧光笔的透明度 —— **只在这一处定义**（落笔 0.34 / 正在画 0.22）。
   ⚠ 自检要 import 它，不许抄一份：抄一份的结果是"自检断言自己那份复制品"，
     应用哪天改了这里，那份自检照样绿（README 第 38 条）。 */
export const HL_ALPHA = 0.34
export const HL_ALPHA_LIVE = 0.22

/* 荧光笔**怎么画**：一条路径、只描一次，透明度只叠一次。
 *
 * ★ 单独抽成一个导出函数，是为了让自检能跨**同一道 seam**：
 *   check-highlighter 把这个函数（`paintHighlight.toString()`）送进页面去画，
 *   而不是照着它再抄一份 —— 从前那个自检抄了算法、还把 alpha/宽度写死，
 *   于是它量的是自己的复制品（README 第 38 条）。
 *   ⚠ 它只认两个模块常量（HL_ALPHA / HL_ALPHA_LIVE）和传进来的 width ——
 *     送进页面时要**一并带上那两个名字**（自检里就是那么干的）。
 *   ⚠ 这个函数不许 import React、不许碰 DOM（只用传进来的 ctx），见文件头。 */
export function paintHighlight(ctx, pts, { live = false, width = 16 } = {}) {
  ctx.globalAlpha = live ? HL_ALPHA_LIVE : HL_ALPHA
  ctx.lineWidth = Math.max(2, Number(width) || 16)
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 1) {
    // 点一下也要留一道记号（一个点画不出线，用极短的一条）
    ctx.lineTo(pts[0].x + 0.1, pts[0].y)
  } else {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  }
  ctx.stroke()
  ctx.globalAlpha = 1
}

/* 一笔怎么画出来。
 *
 * ★ 宽度跟着压力走，但**不能直接用压力当宽度**：Surface 报上来的压力
 *   常常是 0.1 起步、满值不到 1，直接用会细得像头发丝。
 *   所以映射成 [0.55, 1.35] 倍：轻按细一点、重按粗一点，
 *   但永远在"看得清"的范围里。没有压感的设备（鼠标、手指）走 1.0 倍。
 *
 * ★ 每段单独画，而不是一条 path 走到底：宽度不同没法用一条 path。
 *   代价是接缝可能有一点点，所以每段都带 round cap，
 *   圆头会互相咬住，接缝在 1px 上下、看不出来。
 *
 * ★ 必须过 toPoints：它会把点规范化成 [{x,y,p}]，扁平数组和对象数组都认。
 *   直接按 p[0]/p[1]/p[2] 读扁平数组看着更快，但一旦有对象数组混进来
 *   （比如刚解析出来的数据），一笔 10 个点会被读成 3 个、画出来长度是 0 ——
 *   屏幕上什么都没有，而所有数字看着都正常。这个坑踩过，查了很久。
 */
export function drawStroke(ctx, s, { live = false } = {}) {
  const pts = toPoints(s && s.points)
  const n = pts.length
  if (n < 1) return
  const isHi = s.tool === 'highlighter'

  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  /* ── 荧光笔：**合成一条路径，只描一次** ──
     ★ 这是"效果不均匀"的根因。
     早先不分工具，所有笔迹都是"逐段 beginPath + stroke"，
     而且带圆头 —— 荧光笔是半透明的（`HL_ALPHA`），
     段与段在圆头处重叠，透明色叠加两次就变深，于是整条记号深浅斑驳，
     看起来像荧光笔质量差，其实是画法的问题。
     现在荧光笔走这条路：一条 path、一次 stroke、宽度恒定、透明度只叠一次。
     代价是它没法做"压感变粗"—— 而荧光笔本来也不该有压感（它是马克笔）。
     ★ 真正的画法在 `paintHighlight` 里（导出给自检跨同一道 seam 用），这里只负责分流。 */
  if (isHi) {
    paintHighlight(ctx, pts, { live, width: s.width })
    return
  }

  /* ── 笔：逐段画，宽度跟着压力走 ──
     为什么还是逐段：每段线宽不同，一条 path 表达不了。
     代价是接缝处可能有一点点，但**笔是不透明的**，
     相邻圆头互相咬住不会叠出深色，所以不会有荧光笔那种斑驳。 */
  const usePressure = s.pressure !== false
  ctx.globalAlpha = live ? 0.85 : 1

  if (n === 1) {
    // 一个点也要看得见（笔尖点一下就是一坨墨水，不是什么都没有）
    const w = s.width * (usePressure ? wFromPressure(pts[0].p) : 1)
    ctx.beginPath()
    ctx.arc(pts[0].x, pts[0].y, Math.max(0.6, w / 2), 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
    return
  }

  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const pa = usePressure ? wFromPressure(a.p) : 1
    const pb = usePressure ? wFromPressure(b.p) : 1
    ctx.lineWidth = Math.max(0.4, (s.width * (pa + pb)) / 2)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

export function wFromPressure(p) {
  const v = Number(p)
  if (!Number.isFinite(v) || v <= 0) return 1
  return 0.55 + Math.min(1, v) * 0.8
}
