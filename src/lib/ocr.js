/* 手写公式识别：把笔迹变成 LaTeX。
 *
 * ── 这条链路长什么样 ──
 *   白板上写的笔迹（世界坐标）
 *     → 算出包围盒、按需要放大 → 画到一张离屏 canvas → PNG
 *     → POST /api/ocr（**我们自己的本地服务**）→ 服务带上密钥转发给识别服务
 *     → 拿回 LaTeX → 放进公式卡的 tex 字段（src 留着你写的那串）
 *
 * ── 为什么必须绕一手本地服务 ──
 *   ① 密钥不能进浏览器。页面里能读到的密钥 = 任何一段脚本都能读到的密钥。
 *   ② 浏览器的跨域限制：识别服务不会给我们发 CORS 头，直接 fetch 会被拦。
 *   ③ 服务端可以顺手做限流、缓存、日志，浏览器这边只有一条干净接口。
 *
 * ── 为什么"识别失败"和"没配密钥"要分开报 ──
 *   这两种情况的下一步完全不同：一个去设置里填密钥，一个是网络/额度问题。
 *   混成一句"识别失败"的话，用户会去改错的东西。
 */
import { strokeBounds, toPoints } from './board.js'
import { drawStroke } from './ink.js'

/* 发送前把笔迹放大到这个高度。为什么不用原始大小：
   白板上写的字，屏幕上可能只有 40~80 像素高；识别模型对太小的输入效果明显变差。
   放到 ~160 像素高（不够就按比例放大）实测稳定得多，代价只是 PNG 大一点。 */
export const OCR_TARGET_H = 160
export const OCR_MIN_SCALE = 2
export const OCR_MAX_SCALE = 6
const OCR_PAD = 28 // 四周留白：贴着边写的公式，模型会因为缺上下文而认错

/* ── 画成 PNG ── */
export function strokesToPngBlob(strokes, { targetH = OCR_TARGET_H } = {}) {
  const list = (strokes || []).filter((s) => s && s.points && s.points.length >= 3)
  if (!list.length) return null

  // 把所有笔迹的框合起来
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of list) {
    const b = strokeBounds(s)
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  if (!Number.isFinite(minX)) return null

  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  const scale = Math.min(OCR_MAX_SCALE, Math.max(OCR_MIN_SCALE, targetH / h))

  const cv = document.createElement('canvas')
  cv.width = Math.ceil((w + OCR_PAD * 2) * scale)
  cv.height = Math.ceil((h + OCR_PAD * 2) * scale)
  const ctx = cv.getContext('2d')

  // 白底：透明底在有些识别服务上会被当成黑图，识别结果直接崩
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, scale * (OCR_PAD - minX), scale * (OCR_PAD - minY))

  for (const s of list) {
    /* 一律用黑笔发过去。白板上你可能是用红笔/荧光笔写的，但识别模型见过的
       训练数据以黑笔为主；颜色对识别没有任何帮助，只会多一种失败方式。 */
    drawStroke(ctx, { ...s, color: '#000000', tool: 'pen', pressure: s.pressure, width: Math.max(2, Number(s.width) || 2.5) })
  }
  ctx.restore()
  return { canvas: cv, scale, w: cv.width, h: cv.height }
}

/* 发给服务端时用什么格式。
   优先 PNG（无损、识别服务都认）；万一这个浏览器画不出 PNG 就退 JPEG。 */
export async function strokesToImagePayload(strokes, opts) {
  const made = strokesToPngBlob(strokes, opts)
  if (!made) return null
  const blob = await new Promise((res) => made.canvas.toBlob(res, 'image/png'))
  if (!blob) {
    const jpeg = await new Promise((res) => made.canvas.toBlob(res, 'image/jpeg', 0.92))
    if (!jpeg) return null
    return { blob: jpeg, name: 'ink.jpg', size: [made.w, made.h], scale: made.scale }
  }
  return { blob, name: 'ink.png', size: [made.w, made.h], scale: made.scale }
}

/* ── 和本地服务说话 ── */

export async function ocrStatus() {
  const r = await fetch('/api/ocr/status').then((x) => x.json()).catch(() => null)
  if (!r) return { ok: false, error: '连不上本地服务' }
  return r
}

export async function ocrSaveConfig(cfg) {
  const r = await fetch('/api/ocr/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }).then((x) => x.json()).catch(() => null)
  return r || { ok: false, error: '连不上本地服务' }
}

export async function ocrTest() {
  const r = await fetch('/api/ocr/test', { method: 'POST' }).then((x) => x.json()).catch(() => null)
  return r || { ok: false, error: '连不上本地服务' }
}

/* 真正识别。返回 {ok, latex, conf} 或 {ok:false, kind, error}。
   kind：'no-key'（没配密钥）| 'key'（密钥不对/没权限）| 'quota'（额度用完）
        | 'network'（连不上）| 'empty'（没认出东西）| 'bad'（服务返回了看不懂的东西） */
export async function recognizeHandwriting(strokes, opts = {}) {
  const payload = await strokesToImagePayload(strokes, opts)
  if (!payload) return { ok: false, kind: 'empty', error: '没选中任何笔迹' }

  const fd = new FormData()
  fd.append('file', payload.blob, payload.name)
  if (opts.mode) fd.append('mode', opts.mode)

  let res
  try {
    res = await fetch('/api/ocr', { method: 'POST', body: fd })
  } catch (e) {
    return { ok: false, kind: 'network', error: '请求本地服务失败：' + (e && e.message) }
  }
  const body = await res.json().catch(() => null)
  if (!body) return { ok: false, kind: 'bad', error: `识别服务返回了看不懂的内容（HTTP ${res.status}）` }
  if (!body.ok) return { ok: false, kind: body.kind || 'bad', error: body.error || '识别失败' }
  return { ok: true, latex: body.latex, conf: body.conf, note: body.note, debug: { ...body.debug, sentSize: payload.size, sentScale: round2(payload.scale) } }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100

/* ── 输出怎么摆 ── */
/* 识别出来的 LaTeX 只当 tex（显示），src（你写的那串）留着你原来的东西 ——
   这样"改回去"随时都行。见 lib/formula.js 的 displayTex。
   有些服务会连 $ $ 一起返回，剥掉：我们的 tex 字段不带定界符。 */
export function cleanLatex(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) s = s.slice(2, -2).trim()
  else if (s.startsWith('$') && s.endsWith('$') && s.length > 2) s = s.slice(1, -1).trim()
  // \[ \] 和 \( \) 也剥掉（不同服务的习惯不一样）
  s = s.replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '').trim()
  return s
}

/* 识别的 LaTeX 能不能渲染？不能就别写进卡片（宁可让你看到原文，也别给一张空卡）。
   用 KaTeX 试渲染一次，和卡片显示走的是同一条路。 */
export function latexRenderable(katex, tex) {
  if (!tex) return false
  try {
    katex.renderToString(tex, { throwOnError: true, strict: false, trust: false })
    return true
  } catch {
    return false
  }
}

/* 给"把笔迹发出去"这件事做个体检：不发网络请求，只回报会发多大的图。
   用在设置面板里 —— 用户点"测试"之前能先看到"会发多大一张图"。 */
export function describePayload(strokes, opts) {
  const made = strokesToPngBlob(strokes, opts)
  if (!made) return null
  return { w: made.w, h: made.h, scale: round2(made.scale), points: (strokes || []).reduce((n, s) => n + toPoints(s.points).length, 0) }
}
