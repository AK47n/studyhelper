/* 服务端这一半的导出：**把笔记排成 HTML 的入口**。
 *
 * ── 为什么单开一个文件，而不是直接在 server.js 里调（2026-09-18）──────
 * `server.js` 的底线是「**没有任何第三方依赖，只用 node 内置模块**」。
 * 那条底线有实际意义：`node_modules` 没装、甚至整个删掉，双击那个 bat
 * 也照样得能打开、能看笔记、能画白板。
 *
 * 而"排公式"必须用 katex（和界面上是同一个，不然导出的公式和屏幕上的不一样）。
 * 所以那条依赖被**关在这个文件里**：
 *   · server.js 只 `import { exportNoteHtml } from './server-export.js'`
 *   · 这个文件负责把 katex 按 Node 能吃的形状拿出来，塞进 export-html 的注入点
 *
 * ── katex 怎么"按 Node 能吃的形状"拿出来 ────────────────────────────
 * 它是 CJS 包，但 `package.json` 里同时有 `exports` 映射。直接 `import katex from 'katex'`
 * 在 Node 里能行（Node 的 CJS 互操作）。**麻烦的是它找不到**：这个文件跑在
 * 项目根目录下，`node_modules` 就在旁边，所以找得到。
 * 真找不到（用户删了 node_modules）**不该让服务起不来** —— 那时候导出的公式
 * 会退到"原文摆出来"（`math-bad`），丑但能用。所以这里所有失败都吞掉、回 null。
 *
 * ★ 为什么不用 `createRequire`：`import katex from 'katex'` 在顶层会让
 *   **模块加载本身**失败（找不到包 = 整个文件 import 失败 = 服务起不来）。
 *   用动态 `import()` 包在 try 里，才是"加载不了也只是降级"。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportNoteHtml as renderExport } from './src/lib/export-html.js'

/* dist/assets 里是 KATEX_FONT_FAMILY 那些字体文件（vite 从 katex 包里拷出来的）。
   字体内联要用它，但**字体这块不在这里读** —— 它需要 fs，那是 server.js 的事
   （这个文件的职责只有"把 katex 接进来"）。 */

let katex = null
let tried = false

/** 懒加载 katex。失败就回 null —— 调用方走"公式原文摆出来"的降级路。 */
async function loadKatex() {
  if (tried) return katex
  tried = true
  try {
    const mod = await import('katex')
    katex = mod.default || mod
  } catch {
    /* 没装 katex：导出还能跑，公式不排。**不要让服务起不来**。 */
    katex = null
  }
  return katex
}

/** 让 server.js 在启动时"热身"一下：把 katex 提前加载好，
 *  这样第一次点导出不会因为动态 import 而多等一拍。
 *  ★ 但**等不到也不影响** —— 它只是个加速。 */
export function warmUp() {
  return loadKatex()
}

/* 排公式。参数必须和浏览器侧（lib/renderMath.js）**完全一致** ——
   不一致的下场是"自检说能排、导出来是红的"这种自相矛盾。 */
function renderMathToHtml(latex) {
  if (!katex) return null
  try {
    return katex.renderToString(String(latex ?? ''), {
      throwOnError: false,
      displayMode: false,
      output: 'html',
      strict: false,
      trust: false,
    })
  } catch {
    return null
  }
}

/**
 * 一条笔记的原文 → 一个完整的 HTML 文档字符串。
 *
 * @param {string} text     笔记原文
 * @param {object} opts     { title, fileName, at, fonts, fontCss }
 *                          fonts 由 server.js 读 dist/assets 得到（见 lib/fonts.js）
 */
export async function exportNoteHtml(text, opts = {}) {
  await loadKatex()
  /* ★ 把排公式的**能力**注进去（export-html 自己不 import katex /
     inline.js 也不 import katex —— 那两个文件服务端和浏览器共用）。
     这一句就是"服务端不依赖第三方"这条底线的接线处。 */
  return renderExport(text, { ...opts, renderMath: renderMathToHtml })
}

/* 保留一个路径常量给排查用：katex 包在哪儿（没装时是 undefined）。
   看得见比自己猜有用 —— "为什么公式没排出来"这个问题，
   有一半的答案是"katex 没找到"。 */
export function katexLocation() {
  try {
    return pathToFileURL(path.join(process.cwd(), 'node_modules/katex')).pathname
  } catch {
    return ''
  }
}

/* ══════════ 实验图 → PDF（2026-10-05）══════════
 *
 * 用户要的是「一次实验的两三四个表格放**一个 PDF**、**一页**、上下排」，
 * 打印出来剪了贴在手写的实验报告上。
 *
 * ★ 为什么在服务端做、而不是浏览器里下载一个文件：
 *   图名和轴名是**中文**，而 PDF 里写中文必须嵌字体。浏览器拿不到系统字体，
 *   要嵌就得先把它（9.7MB）下载下来 —— 那太荒唐。服务端读一次 simhei.ttf，
 *   用 fontkit 做**子集**（只把用到的那几十个字打包进去），出来的 PDF 才几十 KB。
 *
 * ★ 为什么是**矢量**而不是整页画成图片：激光打印矢量图边缘是实的，
 *   位图放大到 300dpi 会有毛边，而且文件大十倍。点、线、框、字都是画出来的。
 *
 * ⚠ 字体找不到时**报错**，不静默画出豆腐块 —— 一排方块打出来是废纸一张。
 */
import fsp2 from 'node:fs/promises'
import { pageLayout, FIT } from './src/lib/chart-print.js'
import { chartGeom, chartGeomAll, chartSeries, chartPlan, legendItems, CHART_BOX, SKETCH } from './src/lib/chart.js'

const MM = 72 / 25.4 // 1mm = 2.8346pt（PDF 的单位是 point）
const A4 = [595.28, 841.89]

let pdfMods = null
async function loadPdf() {
  if (pdfMods !== null) return pdfMods || null
  try {
    const [lib, fk] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')])
    pdfMods = { lib, fontkit: fk.default || fk }
  } catch {
    pdfMods = false
  }
  return pdfMods || null
}

/* 中文字体只找**单个 .ttf**（pdf-lib 吃不下 .ttc 那种字体集合）。
   缓存字节：9.7MB 每次读一遍太浪费，但也不必缓存 doc —— font 对象绑在 doc 上。 */
let fontBytesCache = null
async function getFontBytes() {
  if (fontBytesCache) return fontBytesCache
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:////////Windows'
  /* ⚠ `path` 是文件顶上那个（`node:path`）；`node:fs/promises` 身上**没有** path。 */
  const cands = ['simhei.ttf', 'simkai.ttf', 'simfang.ttf', 'msyh.ttf'].map((f) => path.join(win, 'Fonts', f))
  for (const p of cands) {
    try {
      const b = await fsp2.readFile(p)
      if (b && b.length > 200000) {
        fontBytesCache = b
        return b
      }
    } catch {}
  }
  return null
}

/**
 * ★ 三种字体的字节（2026-10-05，照样张 PDF 里写的字体名定的）。
 *
 * 量他样张的 span 字体，得到的是三种角色：
 *   · 刻度数字 / 单位 = `TimesNewRomanPSMT`（**衬线**）→ `times.ttf`
 *   · 变量（I/V/P/t） = `STIXGeneral-Italic`（斜体衬线）→ 用 `timesi.ttf` 顶，
 *     STIX 本身 Windows 上不一定有，而 Times 斜体在**任何**论文插图里都通用
 *   · 中文（图例宋体 / 图名黑体）= `SimSun` / `SimHei`
 *
 * ⚠ 之前只用了一个 SimHei，于是所有字都是黑体 —— 刻度数字也是黑体，
 *   和他样张那种 Times 衬线数字差得很远，一眼就看出来不是一套。
 * ⚠ 找不到任何一个就**回退到黑体**，绝不报错（少一种字形还能出图，
 *   报错就是一张纸都印不出来）。
 */
let serifBytesCache = null
let italicBytesCache = null
let songBytesCache = null
async function getSerifBytes() {
  if (serifBytesCache !== null) return serifBytesCache
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:////////Windows'
  for (const f of ['times.ttf', 'arial.ttf', 'cour.ttf']) {
    try {
      const b = await fsp2.readFile(path.join(win, 'Fonts', f))
      if (b && b.length > 100000) {
        serifBytesCache = b
        return b
      }
    } catch {}
  }
  serifBytesCache = false
  return false
}
async function getItalicBytes() {
  if (italicBytesCache !== null) return italicBytesCache
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:////////Windows'
  for (const f of ['timesi.ttf', 'ariali.ttf', 'couri.ttf']) {
    try {
      const b = await fsp2.readFile(path.join(win, 'Fonts', f))
      if (b && b.length > 100000) {
        italicBytesCache = b
        return b
      }
    } catch {}
  }
  italicBytesCache = false
  return false
}
/* 图例那几行中文，样张用的是宋体（SimSun）。⚠ simsun.ttc 是字体集合，
   pdf-lib 吃不下 → 只能退到 simsunb.ttf（它也是集合…），
   所以这里实际回退到黑体。字形差别很小，图例又不是量读数的地方。 */
async function getSongBytes() {
  if (songBytesCache !== null) return songBytesCache
  songBytesCache = false
  return false
}

/**
 * ★ 一个数据标记 → PDF 上的一个空心形状（圆 / 方 / 三角）。
 *
 * 为什么要三种：两条曲线在**黑白**打印出来是同一种黑线，只有形状能分开。
 * 和 `chart-print.js` 的 `markSvg` 是同一个判据、同一套顶点比例 ——
 * 屏幕上是三角，纸上也得是三角，否则预览和实物对不上。
 *
 * ⚠ 收 **pt**（`makeChartPdf` 里所有 `size`/`width` 都乘过 `K`）。
 * ⚠⚠ **三角必须用三条 `drawLine` 手画，不能用 `drawSvgPath`**（2026-10-05 踩过）：
 *   `drawSvgPath` 画出来的图元 y 坐标比传进去的大了一个**恒定偏移**（实测 +1276.6pt），
 *   整排三角全跑到页面外面去了 —— 而圆/方用 `drawCircle`/`drawRectangle` 一点事没有。
 *   同一个 `y` 值，圆画在对的地方、三角飞到天边，看代码完全看不出毛病。
 *   三条线自己算顶点就没有这个坑，还能保证顶点顺序和屏幕那份一致。
 */
function drawMark(page, mark, x, y, r, lw, color) {
  if (mark === 'square') {
    page.drawRectangle({ x: x - r * 0.88, y: y - r * 0.88, width: r * 1.76, height: r * 1.76, borderColor: color, borderWidth: lw })
    return
  }
  if (mark === 'triangle') {
    /* 顶点朝上：PDF 的 y 往上，所以"上"是 y 大的那个点。
       比例照 `markSvg`：高 1.15r、底边在 −0.72r、底边半宽 r。 */
    const top = { x, y: y + r * 1.15 }
    const bl = { x: x - r, y: y - r * 0.72 }
    const br = { x: x + r, y: y - r * 0.72 }
    page.drawLine({ start: top, end: bl, thickness: lw, color })
    page.drawLine({ start: bl, end: br, thickness: lw, color })
    page.drawLine({ start: br, end: top, thickness: lw, color })
    return
  }
  page.drawCircle({ x, y, size: r, borderColor: color, borderWidth: lw })
}

/**
 * @param {Array<object>} charts 图集（和界面上是同一份数据）
 * @returns {Promise<Uint8Array>} PDF 字节
 */
export async function makeChartPdf(charts, opts = {}) {
  const mods = await loadPdf()
  if (!mods) throw new Error('这台机器上没有 pdf-lib（node_modules 装了吗？）')
  const { PDFDocument, rgb, degrees } = mods.lib
  const bytes = await getFontBytes()
  if (!bytes) throw new Error('找不到中文字体（\\Windows\\Fonts\\simhei.ttf）—— 图名会变成一排方块，所以这里不画')

  const list = (Array.isArray(charts) ? charts : []).filter((c) => c && (c.rows || []).length)
  if (!list.length) throw new Error('还没有一张图有数据')

  const layout = pageLayout(list.length)
  const doc = await PDFDocument.create()
  doc.registerFontkit(mods.fontkit)
  const font = await doc.embedFont(bytes, { subset: true })
  /* 三种字体角色（见上面 `getSerifBytes` 那段）。⚠ 缺哪种就退回黑体，
     绝不在这里抛错 —— 少一种字形只是不像，抛错是一张纸都印不出来。 */
  const sb = await getSerifBytes()
  const ib = await getItalicBytes()
  const serif = sb ? await doc.embedFont(sb, { subset: true }) : font
  const italic = ib ? await doc.embedFont(ib, { subset: true }) : font
  const black = rgb(0, 0, 0)
  const gray = rgb(0.35, 0.35, 0.35)
  /* 网格那个淡灰：样张量到 rgb(0.851,0.851,0.851)。 */
  const gridGray = rgb(217 / 255, 217 / 255, 217 / 255)
  const title = opts.title || '实验图'

  let at = 0
  layout.pages.forEach((k, pi) => {
    const page = doc.addPage(A4)
    const Wmm = layout.mms[pi]
    const Hmm = Wmm * (CHART_BOX.h / CHART_BOX.w)
    const cellH = Hmm + FIT.head + FIT.gap
    const leftmm = (210 - Wmm) / 2

    for (let i = 0; i < k; i += 1) {
      const ch = list[at + i]
      /* ★ 图名在图的**上方** —— 这一格从 `12 + i*cellH` 开始，先让出 `head` 给图名，
         图本身从下面那条线开始（照他的样张：标题在 38mm、最高那条刻度在 43mm）。 */
      const topmm = 12 + i * cellH + FIT.head
      /* viewBox 坐标 → PDF 坐标。⚠ PDF 的 y 是**从下往上**的，所以要翻一次。 */
      const X = (vx) => (leftmm + vx * (Wmm / CHART_BOX.w)) * MM
      const Y = (vy) => (297 - topmm - vy * (Hmm / CHART_BOX.h)) * MM
      /* ⚠⚠ viewBox 单位 → **pt** 的换算（2026-10-05 踩过）。
         pdf-lib 的 `size`（字号）、`thickness`（线宽）、`drawCircle` 的 `size`（半径）
         收的都是 **pt**，而本文件的图是拿 viewBox 单位算的。
         漏乘这个系数 → 线粗 5 倍、字大 5 倍、点变成巨大的空心球。
         位置（x/y）用 X()/Y() 已经换过了；**只有尺寸**要走这里。 */
      const K = (Wmm / CHART_BOX.w) * MM
      const ss = chartSeries(ch)
      const g = ss.length ? chartGeomAll(ss) : null
      if (!g) continue
      const PX = (v) => X(g.view.px(v))
      const PY = (v) => Y(g.view.py(v))
      const u = (n) => (n * Wmm) / CHART_BOX.w // viewBox 单位 → mm
      const B = CHART_BOX
      /* ⚠ 线宽、刻度字号这些**图内的**尺寸现在都由 `chartPlan` 算好了（每笔自带 `w`），
         所以这里不再自己按 `SKETCH` 换算一遍 —— 那正是 2026-10-06 删掉的那份重复。
         图**外**的两样（拟合数字行、图名）不在 `chartPlan` 里，它们各自算自己的。 */
      const fsCap = SKETCH.fsTitle * g.iw // 图名字号（唯一还按比例算的，它不在 plot 里）
      const fsLeg = SKETCH.fsLegend * g.iw // 拟合数字那行的字号（同上）

      /* ═══════════════════════════════════════════════════════════════
       * ★ 把 `chartPlan` 给的那一批笔画 →画进 pdf-lib（**adapter**，2026-10-06）。
       * ═══════════════════════════════════════════════════════════════
       * 这一层**只做落笔**：画什么、画在哪、多粗、多大、字体哪个角色，
       * 全部是 `chart.js` 的 `chartPlan` 定的（那份排版只有一处实现）。
       * ⚠⚠ **这里不许再出现任何排版决定。** 以前这个文件和 `chart-print.js` 的
       *   `chartSvg` 各写了一遍整套排版（网格/坐标轴/箭头/刻度/轴名/曲线/图例，
       *   七步一一对应），于是"改一处忘另一处"= **静默**不同步 ——
       *   而它只在**打印出来**时看得见（屏幕自检全绿）。
       *   2026-10-05 那一轮七个静默 bug 里**五个**是这么来的：
       *   y 刻度全没画出来、竖排轴名压到刻度上、三角飞出页面、减号变方块、一行字三种字体。
       * ★ **要改排版，去改 `chartPlan`**，改完两侧一起变。
       *
       * ── 这一侧和 SVG 那侧不同的**只有三样**（都是"怎么落笔"，不是"画什么"）──
       *   ① 坐标要换算：viewBox 单位 → pt（乘 K），而且 **y 翻一次**（PDF 从下往上）；
       *   ② 文字宽度用**真字体**量（`widthOfTextAtSize`），SVG 那边量不准只能估 ——
       *      所以 `chartPlan` 收一个 `textW`（量宽函数），两侧各传自己那份；
       *   ③ 竖排那一段：SVG 转 90° 就完事，pdf-lib 要自己摆 `rotate(-90)` 的落点。
       */
      /* ★ 量宽函数：按这段文字**实际要走的那两个字形**量，而不是一律 Times。
         ·刻度数字（`tick`）→ 衬线 Times；
         · 图例（`legend`，中文）→ 黑体 —— ⚠ 用Times 量中文会**窄一截**，
           于是图例框按错的宽度画（实测比旧版窄 10.4pt，框都盖不住字）。
       这个宽度只用来算"框要多宽"和"y 轴名该往左让多少"（避开刻度数字），
       所以两处共用同一个函数。 */
      const measureW = (str, size) => {
        const s = String(str)
        const f = /[一-鿿]/.test(s) ? font : serif
        return f.widthOfTextAtSize(s, size * K) / K
      }
      const plan = chartPlan(ch, { box: CHART_BOX, textW: measureW })
      if (!plan) continue
      for (const st of plan.strokes) {
        const col = st.color === 'grid' ? gridGray : black
        const th = (st.w || 0) * K
        if (st.k === 'line') {
          page.drawLine({ start: { x: X(st.x1), y: Y(st.y1) }, end: { x: X(st.x2), y: Y(st.y2) }, thickness: th, color: col })
        } else if (st.k === 'poly') {
          /* 三角标记：逐段线。⚠⚠ **不许用 `drawSvgPath`** —— 它收的是pdf-lib 自己
             的坐标系，而这里的图是拿 viewBox 单位算的，混用时三角的 y 会偏一个
             **恒定值**（实测 1276pt）而同一个 y 的圆画得完全对，看代码一点毛病都看不出来
             （2026-10-05 踩过）。逐段线就没有这个问题。 */
          for (let i = 1; i < st.pts.length; i += 1) {
            page.drawLine({ start: { x: X(st.pts[i - 1][0]), y: Y(st.pts[i - 1][1]) }, end: { x: X(st.pts[i][0]), y: Y(st.pts[i][1]) }, thickness: th, color: col })
          }
          if (st.close && st.pts.length > 2) {
            const a = st.pts[st.pts.length - 1]
            const b = st.pts[0]
            page.drawLine({ start: { x: X(a[0]), y: Y(a[1]) }, end: { x: X(b[0]), y: Y(b[1]) }, thickness: th, color: col })
          }
        } else if (st.k === 'path') {
          /* 折线：`d` 是 `M x0 y0 L x1 y1 L x2 y2 …` 那种。一段一条线
           *（pdf-lib 没有"按 path 描边"这回事，所以要自己拆）。
           * ⚠⚠ 拆法只有一句：**n 个点 = n−1 段**，坐标数 = 2n，
           *   第 i 段（i 从 0 起）= `nums[2i], nums[2i+1] → nums[2i+2], nums[2i+3]`。
           *   我第一版写 `for (let i = 2; ...)` —— **漏掉了第一段**
           *   （曲线开头缺一截，不报错、PDF 照样出、屏幕上看不出来）。
           *   第二版边界又写成 `i + 3 <= nums.length`，22 个坐标只画 9 段（应 10）。
           *   ⇒ 正确写法：`i + 3 < nums.length`，i 从 **0** 起、步长 2。 */
          const nums = String(st.d).match(/-?[\d.]+/g).map(Number)
          for (let i = 0; i + 3 < nums.length; i += 2) {
            page.drawLine({ start: { x: X(nums[i]), y: Y(nums[i + 1]) }, end: { x: X(nums[i + 2]), y: Y(nums[i + 3]) }, thickness: th, color: col })
          }
        } else if (st.k === 'circle') {
          page.drawCircle({ x: X(st.cx), y: Y(st.cy), size: st.r * K, borderColor: col, borderWidth: th })
        } else if (st.k === 'rect') {
          if (st.color === 'none') {
            /* 白底那一块（图例底下）：只填不描。 */
            page.drawRectangle({ x: X(st.x), y: Y(st.y + st.hh), width: X(st.x + st.hw) - X(st.x), height: Y(st.y) - Y(st.y + st.hh), color: rgb(1, 1, 1), borderWidth: 0 })
          } else {
            page.drawRectangle({ x: X(st.x), y: Y(st.y + st.hh), width: X(st.x + st.hw) - X(st.x), height: Y(st.y) - Y(st.y + st.hh), borderColor: col, borderWidth: th })
          }
        } else if (st.k === 'text') {
          /* ⚠ 按**字形**选，不是按 role 硬编码：中文一律黑体
             （Times 没有汉字字形，塞进去是 `\x00` → 打印成方块，pdf-lib **不报错**）。
             2026-10-06 第一版 adapter 按 role 选，图例里出现纯英文名（`DC-DC`）
             时就又走回 Times 了 —— 判据应该是「这个字黑体有没有」。 */
          const fs = st.size * K
          const f = /[一-鿿]/.test(st.s) ? font : serif
          const w = f.widthOfTextAtSize(st.s, fs)
          const tx = st.anchor === 'end' ? X(st.x) - w : st.anchor === 'middle' ? X(st.x) - w / 2 : X(st.x)
          page.drawText(st.s, { x: tx, y: Y(st.y) - fs * 0.36, size: fs, font: f, color: col })
        } else if (st.k === 'runs') {
          /* ★ 一行多段（轴名：变量斜体 + 单位正体）。
             ⚠⚠ **旋转那一支的落点语义和横排不同**：`rotate(-90)` 之后 `drawText` 的
             `x,y` 是旋转**之后**的落点，文本从那里往 −y 展开（不是往 +x）。
             所以要让整段竖排文本落在「刻度左边 x = st.x..st.x+字高」这一条里，
             x 取**字高那一侧的边**，再把 −y 展开的那段用 off 摆平。
             ⚠ 旋转后横向占位是**1.6em**（实测：7.4pt 的 `P / mW` 旋转后 span 宽 11.9pt），
               不是字高 0.72em —— 用 0.72 只留了一半，y 轴名压在刻度数字上
               （实测重叠 1.8pt，而**加左边距治不好**：整段会跟着一起平移）。
             判据（钉死）：y 轴名 span 的 bbox.x1 必须小于刻度数字 span 的 bbox.x0。 */
          const fs = st.size * K
          if (!st.rot) {
            const faceOf = (run) => (run.role === 'var' ? italic : serif)
            let wsum = 0
            for (const run of st.runs) wsum += faceOf(run).widthOfTextAtSize(run.s, fs)
            let tx = X(st.x) - wsum / 2
            for (const run of st.runs) {
              const f = faceOf(run)
              page.drawText(run.s, { x: tx, y: Y(st.y), size: fs, font: f, color: col })
              tx += f.widthOfTextAtSize(run.s, fs)
            }
          } else {
            const faceOf = (run) => (run.role === 'var' ? italic : serif)
            let total = 0
            for (const run of st.runs) total += faceOf(run).widthOfTextAtSize(run.s, fs)
            const cx = X(st.x)
            const cy = Y(st.y)
            let off = total / 2
            for (const run of st.runs) {
              const f = faceOf(run)
              page.drawText(run.s, { x: cx, y: cy + off, size: fs, font: f, color: col, rotate: degrees(-90) })
              off -= f.widthOfTextAtSize(run.s, fs)
            }
          }
        }
      }
      /* ── ⑧ 图名在图的**上方**。变量斜体、中文黑体（照样张）。── */
      const cap = ch.name || ''
      if (cap) {
        /* 变量 = 夹在别的字之间的**单个**拉丁字母（I/V/P/t）。 */
        const parts = splitVars(cap)
        const faceOf = (p) => (p.ital ? italic : p.serif ? serif : font)
        let wsum = 0
        for (const p of parts) wsum += faceOf(p).widthOfTextAtSize(p.t, fsCap * K)
        let cx = X(B.w / 2) - wsum / 2
        for (const p of parts) {
          const f = faceOf(p)
          page.drawText(p.t, { x: cx, y: (297 - topmm + (fsCap * K) * 0.22) * MM, size: fsCap * K, font: f, color: black })
          cx += f.widthOfTextAtSize(p.t, fsCap * K)
        }
      }
      /* 拟合出来的那几个数放在图**下面**（图名已经占了上面，而且这几个数比图名次要）。
         ★ 两条以上都拟合就**每条一行**（下面那个 y 是往下的，所以行距要减）。
         ⚠⚠ 曲线名里可能有中文（「直接充电」「加热到 60 ℃」）—— **不能整行都用 Times**：
            Times 的子集里没有汉字，pdf-lib 会塞成空字符，印出来是一排方块
            （实测「室温」变成「□□」）。所以按 `splitVars` 拆开逐段挑字体：
            拉丁字母走斜体 Times，其余走黑体。 */
      const fitLines = []
      for (const s of g.series) {
        if (s.mode !== 'fit' || !s.fit) continue
        fitLines.push({ name: g.series.length > 1 ? s.name : '', f: s.fit.stats })
      }
      const fsNum = fsLeg * K * 0.8
      fitLines.forEach((fl, li) => {
        const ytxt = (297 - topmm - Hmm - 4 - li * 3.4) * MM
        /* ⚠⚠ 这行里有三种字体角色，**不能整段一种字体**：
             · 曲线名和「斜率/截距」是中文 → 黑体（Times 没汉字，塞进去是空字符 → 方块）
             · 数字、`±`、`.` → 衬线 Times（黑体这些字形齐全但和图上刻度不一套）
             · 名字里的单个拉丁字母（如 `60 ℃` 那个 ℃ 不算，`DC-DC` 也不算）→ 斜体
           之前我把整行都标成衬线，实测「斜率」直接变成两个方块。 */
        const parts = splitVars(fl.name ? fl.name + '　' : '').concat(fmtFitParts(fl.f))
        let wsum = 0
        for (const p of parts) wsum += (p.ital ? italic : p.serif ? serif : font).widthOfTextAtSize(p.t, fsNum)
        let tx = X(B.w / 2) - wsum / 2
        for (const p of parts) {
          const f = p.ital ? italic : p.serif ? serif : font
          page.drawText(p.t, { x: tx, y: ytxt, size: fsNum, font: f, color: gray })
          tx += f.widthOfTextAtSize(p.t, fsNum)
        }
      })
    }
    at += k

    const foot = `${title}　第 ${pi + 1}/${layout.pages.length} 页`
    page.drawText(foot, { x: 297.64 - font.widthOfTextAtSize(foot, 8) / 2, y: 6 * MM, size: 8, font, color: gray })
  })

  return await doc.save()
}

/**
 * 把图名拆成「变量（斜体）/ 其它（正体）」两段 —— 照样张：
 * `I − V 关系图` 里 `I`、`V` 是斜体，`−` 和中文是正体。
 *
 * ⚠ 只认**单个**拉丁字母：`DC-DC`、`P−V` 里连着的两个字母不算变量
 *   （那是量名的一部分，斜了反而不专业）。
 *
 * ⚠⚠ **减号 `−`(U+2212) 必须交给衬线字体画**（2026-10-05 实测踩到）：
 *   SimHei 的**子集**里没有这个码位，pdf-lib 会把它塞成 `\x00`
 *   —— 渲染出来是一个**空方块**，标题变成 `I □ V 关系图`。
 *   Times New Roman 有 U+2212（样张就是 Times/STIX 画的），所以凡是这个字符
 *   一律走 `serif`。同类要防的还有 `×`(U+00D7)、`±`(U+00B1)，
 *   统一在 `isSerifChar` 里列出来。
 *
 * @returns {Array<{t:string, ital:boolean, serif:boolean}>}
 */
function splitVars(name) {
  const s = String(name == null ? '' : name)
  const out = []
  let buf = ''
  let bufItal = false
  let bufSerif = false
  const flush = () => {
    if (buf) out.push({ t: buf, ital: bufItal, serif: bufSerif })
    buf = ''
  }
  for (const chx of s) {
    const isVar = /[A-Za-z]/.test(chx)
    const isSer = isSerifChar(chx)
    if (isVar === bufItal && isSer === bufSerif && buf) {
      buf += chx
    } else {
      flush()
      buf = chx
      bufItal = isVar
      bufSerif = isSer
    }
  }
  flush()
  return out
}

/** SimHei 子集里缺、但 Times 一定有的那些符号（见 `splitVars` 那条警告）。 */
function isSerifChar(ch) {
  return ch === '−' || ch === '×' || ch === '±' || ch === '÷' || ch === '·' || ch === '′' || ch === '″' || ch === '°' || ch === 'Ω'
}

/**
 * 图下面那行小字 —— **按字体角色切成几段**（不是一整串）。
 *
 * ⚠⚠ 为什么必须切（2026-10-05 踩了两次）：
 *   这一行里同时有中文（`斜率`/`截距`）和数字（`1.984 ± 0.012`）。
 *   · 整串用黑体 → 数字和图上刻度不是一套字体，一眼就不像；
 *   · 整串用 Times → **汉字塞不进子集，pdf-lib 写成空字符，印出来是一排方块**
 *     （实测「斜率 1.984」变成「□□ 1.984」）。
 *   所以：中文标签走黑体，数字和 `±` 走衬线。
 *   ⚠ `R^2` 用 ASCII 而不是 `r²` —— 上标 ² 在黑体子集里带不上（实测读回来是空的）。
 *     HTML 那份是浏览器渲染，`r²` 没问题，所以只在这一侧换写法。
 *
 * @returns {Array<{t:string, ital?:boolean, serif?:boolean}>}
 */
function fmtFitParts(f) {
  const u = f.slopeSE
  const exp = u > 0 ? Math.floor(Math.log10(u)) : 0
  const lead = u > 0 ? u / Math.pow(10, exp) : 0
  const d = u > 0 ? Math.max(0, lead < 3 ? -exp + 1 : -exp) : 0
  return [
    { t: '斜率 ' },
    { t: `${f.slope.toFixed(d)} ± ${u.toFixed(d)}`, serif: true },
    { t: '　截距 ' },
    { t: `${f.intercept.toFixed(d)} ± ${f.interceptSE.toFixed(d)}`, serif: true },
    { t: '　' },
    { t: `R^2 ${f.r2.toFixed(4)}`, serif: true },
  ]
}

/** 图下面那行小字，拼成一整串（自检和纯文本场合用）。 */
function fmtFitLine(f) {
  return fmtFitParts(f)
    .map((p) => p.t)
    .join('')
}
