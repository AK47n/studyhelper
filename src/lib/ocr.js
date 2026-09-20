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
import { strokeBounds, toPoints } from './geometry.js'
import { drawStroke } from './ink.js'

/* 发送前把笔迹放大到这个高度。为什么不用原始大小：
   白板上写的字，屏幕上可能只有 40~80 像素高；识别模型对太小的输入效果明显变差。
   放到 ~160 像素高（不够就按比例放大）实测稳定得多，代价只是 PNG 大一点。 */
export const OCR_TARGET_H = 160
export const OCR_MIN_SCALE = 2
export const OCR_MAX_SCALE = 6
const OCR_PAD = 28 // 四周留白：贴着边写的公式，模型会因为缺上下文而认错

/* 单边最长多少像素（2026-09-19 加的）。
 *
 * 为什么必须有：`scale` 原来**只由高度定**（`targetH / h`），于是"又宽又扁"的一块
 * 会被放大成一张巨图。真板上实测过（`data/board-熵增加.md`，按板框优先分块之后）：
 * 一条 1893×447 的横条 → **7797×2011**（1600 万像素），而那一行字在世界上本来就有
 * 一百多像素高，再放大 4 倍只是变慢、变贵 —— 识别并不会更准。
 *
 * ⚠ 这条上限**只咬"宽扁"的输入**：长条板（`board-8.4`：1637×3286 → 0.8 倍）、
 * 整页板（`board-复变函数`：1665×1176 → 1.70 倍 → 2927 宽）算出来一个像素都不变。 */
export const OCR_MAX_DIM = 3000

/* "这一块该放大多少倍"——**只有这一处**（画图和"会发多大的图"那个体检都问它）。
   两道约束：① 高度奔着 targetH 去，夹在 minScale~maxScale；
   ② 结果不许超过单边 maxDim（见上面那段：宽扁的一块是这条存在的全部理由）。 */
export function ocrScaleFor(w, h, { targetH = OCR_TARGET_H, minScale = OCR_MIN_SCALE, maxScale = OCR_MAX_SCALE, maxDim = OCR_MAX_DIM } = {}) {
  const byH = Math.min(maxScale, Math.max(minScale, targetH / Math.max(1, h)))
  const fit = Math.min(maxDim / Math.max(1, w + OCR_PAD * 2), maxDim / Math.max(1, h + OCR_PAD * 2))
  return Math.max(0.05, Math.min(byH, fit))
}

/* ── 画成 PNG ──
   minScale/maxScale 可以被调用方覆盖：局部选区（一个公式/一行字）用默认的 2~6 倍
   是对的；**整板转录**不行 —— 一整块板可能有几千世界像素高，2 倍下限会把它撑成
   一万多像素的巨图（发不出去，模型也读不动）。那边要允许 <1 的缩小档。 */
export function strokesToPngBlob(
  strokes,
  { targetH = OCR_TARGET_H, minScale = OCR_MIN_SCALE, maxScale = OCR_MAX_SCALE, maxDim = OCR_MAX_DIM, overlays = null } = {}
) {
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
  /* 放大多少倍只问 `ocrScaleFor` 一处（高度 + 单边上限两道约束，见它的说明）。 */
  const scale = ocrScaleFor(w, h, { targetH, minScale, maxScale, maxDim })

  const cv = document.createElement('canvas')
  cv.width = Math.ceil((w + OCR_PAD * 2) * scale)
  cv.height = Math.ceil((h + OCR_PAD * 2) * scale)
  const ctx = cv.getContext('2d')

  // 白底：透明底在有些识别服务上会被当成黑图，识别结果直接崩
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, scale * (OCR_PAD - minX), scale * (OCR_PAD - minY))

  /* 板框脚手架（2026-09-19 晚）：整板转录时把用户圈的板框画成浅灰虚线、
     画在笔迹**下面**。为什么是浅灰 + 虚线：它是记号不是内容 ——
     画成黑实线，模型会把框线当成图的一部分去"抄"（提示词里也配了一句）。
     线宽和虚线段按 scale 折算，图放大多少倍它们都还是那么粗。
     出界的部分被画布自然裁掉（框不参与取景，见 board-note.js 的 frameRectsForBand）。 */
  if (Array.isArray(overlays) && overlays.length) {
    ctx.strokeStyle = '#c4c4c4'
    ctx.lineWidth = 2 / scale
    ctx.setLineDash([8 / scale, 6 / scale])
    for (const r of overlays) {
      if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) continue
      ctx.strokeRect(r.x, r.y, r.w, r.h)
    }
    ctx.setLineDash([])
  }

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

/* 服务端回话怎么理解。**抽成纯函数**，因为它必须在 node 里能被断言 ——
   这条链路上最容易出的错是"看着成功、其实走错了路"。

   ★ 为什么必须有 mode 这一道（2026-09-16 用户报的"美化手写依旧在认公式"）：
     改了 server.js / server-ocr.js 之后**不重启服务**，5177 上跑的还是老代码 ——
     老代码不认 mode 字段，于是它照样按公式认，回一个 { ok, latex }。
     前端要是照单全收，就会把一串 LaTeX 塞进文字卡（用户看到一堆反斜杠花括号），
     而且**不报任何错**。而这次的前端是新版、服务端是旧版，光看界面根本想不到。
     所以：认文字的成功回包里**必须**带 `mode:'text'`（新版服务端会回），
     没带就是"服务端没重启"，当场说清而不是把错东西写进卡片。 */
export function interpretOcrResponse(body, mode = 'formula') {
  if (!body || typeof body !== 'object') return { ok: false, kind: 'bad', error: '识别服务返回了看不懂的内容' }
  if (!body.ok) return { ok: false, kind: body.kind || 'bad', error: body.error || '识别失败' }
  const wanted = mode === 'text' || mode === 'board' || mode === 'structure' ? mode : null
  if (wanted && body.mode !== wanted) {
    return {
      ok: false,
      kind: 'stale',
      error: wanted === 'board'
        ? '本地服务还是旧版：它没收到"这次要整板转录"，回的是别的结果。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后重新点收拢。'
        : wanted === 'structure'
          ? '本地服务还是旧版：它不知道"结构整理"这个口（第 4 步新加的）。把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后重新收拢。'
          : '本地服务还是旧版：它没收到"这次要认文字"，回的是认公式的结果。'
            + '把 studyhelper 关掉再打开一次（或双击一次桌面开关：关→再开），然后重新点识别。',
    }
  }
  return { ok: true, latex: body.latex, text: body.text, conf: body.conf, note: body.note }
}

/* 结构整理（2026-09-19，ADR-0004 第 4 步）：**不看图的第二次调用**。
   输入是一整段纯文本（board-structure.js 的 buildStructureInput 拼的：
   行清单 + 每行的字 + 板上连过的关系 + 你自己的词），回来是一个 JSON 骨架。
   ⚠ 这一层**不解析**它 —— 落行校验是 board-structure.js 的纯函数（自检里断言得住）。
   和识别的成功回包一样要 `mode:'structure'` 回声：服务端没重启的话，它认不出这个口，
   回来的是别的东西 —— 那种"看着成功、其实走错路"的错必须当场说清。 */
export async function structureReading(input, opts = {}) {
  const text = String(input == null ? '' : input)
  if (!text.trim()) return { ok: false, kind: 'empty', error: '没有可整理的内容' }
  let res
  try {
    res = await fetch('/api/structure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
      signal: opts.signal,
    })
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, kind: 'cancel', error: '已取消' }
    return { ok: false, kind: 'network', error: '请求本地服务失败：' + (e && e.message) }
  }
  const body = await res.json().catch(() => null)
  if (!body) return { ok: false, kind: 'bad', error: `本地服务返回了看不懂的内容（HTTP ${res.status}）` }
  const parsed = interpretOcrResponse(body, 'structure')
  if (!parsed.ok) return parsed
  return { ...parsed, debug: body.debug || null }
}

/* 真正识别。返回 {ok, latex} 或 {ok, text}（看 opts.mode），失败给 {ok:false, kind, error}。
   kind：'no-key'（没配密钥）| 'key'（密钥不对/没权限）| 'quota'（额度用完）
        | 'network'（连不上）| 'empty'（没认出东西）| 'provider'（这家服务干不了这件事）
        | 'stale'（本地服务是旧版，没重启）| 'bad'（服务返回了看不懂的东西）
        | 'cancel'（**你自己按了取消**，不是出错 —— 调用方别把它当失败报）
   mode：'formula'（默认）| 'text'（认普通文字，白板的「美化手写」用）
   opts.signal：AbortSignal。取消只中止**等待**：已经发出去的那一次拦不住
        （服务端还在跑、钱也照花）—— 但「别再发下一块了」是立刻生效的。 */
export async function recognizeHandwriting(strokes, opts = {}) {
  const payload = await strokesToImagePayload(strokes, opts)
  if (!payload) return { ok: false, kind: 'empty', error: '没选中任何笔迹' }

  const fd = new FormData()
  fd.append('file', payload.blob, payload.name)
  if (opts.mode) fd.append('mode', opts.mode)
  /* ★ `lines` = **这一块的行清单**（ADR-0004 第 4 步）：整板转录时它拼进提示词，
     模型才知道"这一块从上到下有几行、该按 `L<行号>|` 回话"。
     ⚠ 2026-09-20 抓到的就是这一跳：调用方一直在传 `opts.lines`（App.jsx 的
       `plan[i].manifest` / `manifestText(p.lines)`），服务端也一直在读 `lines` 字段
       （server.js 的 extractTextPart），**中间这一行漏了** —— 于是服务端每次都退回
       老的 BOARD_PROMPT，模型自由发挥（真板上实测：一个 12 行的块被写成 16 个碎片、
       而且一个 `L` 前缀都没有）。后果不是"认出率低一点"，是整条第 4 步**在真跑的时候
       是死的**：`parseLineOutput` 判 followed=false → `items` 是 null →
       App.jsx 里"有 items 才跑结构整理"那个闸根本不开 → 草稿退回按块平铺。
       用户看到的原话就是「纯粹只是并列式的把我的笔记碎片化列了出来……象是纯粹的识别」。
     ⚠ 没有行清单（普通「✨ 美化」那种单块调用）**不要**发这个字段：服务端见不到它
       就走老提示词，行为可预测 —— 空字符串和"没有"在那边是同一件事，但少发一条更清楚。 */
  if (opts.lines) fd.append('lines', String(opts.lines))

  let res
  try {
    res = await fetch('/api/ocr', { method: 'POST', body: fd, signal: opts.signal })
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, kind: 'cancel', error: '已取消' }
    return { ok: false, kind: 'network', error: '请求本地服务失败：' + (e && e.message) }
  }
  const body = await res.json().catch(() => null)
  if (!body) return { ok: false, kind: 'bad', error: `识别服务返回了看不懂的内容（HTTP ${res.status}）` }
  const parsed = interpretOcrResponse(body, opts.mode)
  if (!parsed.ok) return parsed
  return {
    ...parsed,
    debug: { ...body.debug, sentSize: payload.size, sentScale: round2(payload.scale) },
  }
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

/* 认普通文字的结果怎么清。
   ⚠ 和 cleanLatex 是两回事，别合并 —— 公式那套会剥 `$`、认「最后一个冒号后面」，
      而笔记里到处是冒号和 `$`：拿公式的规则去清文字，会把用户写的一整行砍掉半句，
      而且**界面上看不出来**（卡片里就是少了一段字，你会以为是自己没写全）。
      服务端有一份一样的（server-ocr.js 的 cleanTextOutput），
      两边行为要一致：服务端兜"前端拿到的脏内容"，前端兜"写进卡片之前"。
      两份都很短，且 check-ocr-server.js 会断言两边一致。 */
export function cleanText(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  const fence = /```(?:text|markdown|md|plain|latex|tex)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()
  const pairs = [['"', '"'], ['“', '”'], ["'", "'"], ['「', '」'], ['『', '』']]
  for (const [a, b] of pairs) {
    if (s.length > 1 && s.startsWith(a) && s.endsWith(b) && !s.slice(1, -1).includes(b)) {
      s = s.slice(1, -1).trim()
      break
    }
  }
  // 句末的句号有半角也有全角（"这张图里没有文字。"）—— 和 server-ocr.js 那份一致
  if (/^(EMPTY|N\/A|无|没有文字|图片中没有文字|这张图.*没有(文字|内容))[.。]?$/i.test(s)) return ''
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
