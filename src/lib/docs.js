/* 白板上的「资料」：一份 PDF（或转成 PDF 的 PPT）铺在画布上，注释照常写。
 *
 * ── 它是什么、不是什么 ─────────────────────────────────────────────────
 * 一份资料 = 一个 `docs` 数组里的节点：**指向 `data/.资料/` 里一个 .pdf（或一张图片）的引用**
 * + 摆在世界坐标的哪个位置（x/y/w）。每一页按 PDF 本来的宽高比排成一竖条，
 * 页面矩形**是 `x/y/w/pages` 的函数**（pageRects），不单独存坐标 ——
 * 和板框"框线是成员的函数"是同一条设计纪律：只有一份真相，其余现算。
 *
 * 注释（笔迹、卡片、连接）对资料**一无所知**：它们本来就都存世界坐标、
 * 画在资料层上面（.bd-ink 是 z8，资料层是 z1）。所以"在 PDF 上写公式、圈重点"
 * 不需要任何新机制 —— 需要的只是"把页面摆对地方"。
 *
 * ── 为什么 PDF 本体不进板文件 ─────────────────────────────────────────
 * 板文件是**纯文本 JSON**（README 的立仓之本：能 diff、能 Git、能手改）。
 * 几十 MB 的二进制塞进去，这三条全毁。所以 PDF 存在 `data/.资料/`（服务端
 * `/api/doc/upload` 写进去），板文件里只存文件名和页面尺寸表。
 * ★ 目录名带点：服务端列目录跳过 `.` 开头的（和 `.导出` 同一条路），
 *   左栏不会多出一层点不开的目录。
 *
 * ── 为什么 pages 要存进文件 ───────────────────────────────────────────
 * 页面的**宽高比**是 PDF 的属性，理论上每次打开都能重新量。但量它要先拉起
 * pdf.js、解析整个文件头 —— 打开一张板就干这个，慢而且没必要。
 * 插入那次量好了存下来（每页 [pw, ph]，PDF 点数），以后只靠它摆页面。
 * 板文件里多这几十字节，换来"打开零等待"。
 */

/** 资料文件放在 data/ 下哪个目录（点开头 = 左栏不显示，见文件头）。 */
export const DOC_DIR = '.资料'

/** 相邻两页之间留多少世界像素（页与页之间一条细缝，读起来像真正的"下一页"）。 */
export const DOC_PAGE_GAP = 20

/** 新插入资料的默认世界宽度（px）。720 ≈ 在 100% 缩放下占半屏多，够读、不霸板。 */
export const DOC_DEFAULT_W = 720

/** 资料节点 id 的前缀（卡片 f/n、笔迹 s、板框 fr，资料就轮到 doc）。 */
export const DOC_ID_PREFIX = 'doc'

/** 一份资料可以是**两种东西**：一份 PDF（多页、矢量）或一张**图片**（截图/拍照，一图就是一页）。
 *  ★ 图片这条是 2026-09-21 为用户那句"为了做几道题传一本 PDF 太费事"开的。
 *    题目常常只要一张图就够：截图、手机拍一道题、从电子书里裁一小块。
 *    而一张图在这里走的**完全是 PDF 那条路** —— 一样是 docs 里的一个节点、
 *    一样靠 pages 表定尺寸、一样能被圈起来问、一样进追问 / 作业辅导 / 课件整理。
 *    区别只有一处：`renderDocPage` 里那条 branch（见 doc-pages.js）。
 *  ⚠ 别为图新开一种节点：**多一种形状 = 每个读它的地方都要再问一句"你是不是图"** ——
 *    那正是最难受的一类账。 */
const DOC_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']

/** 后缀（小写带点：`.pdf` / `.png`；认不出就给 `''`）。后缀的大小写是认的。 */
export function docExtOf(p) {
  const s = String(p == null ? '' : p)
  const i = s.lastIndexOf('.')
  return i < 0 ? '' : s.slice(i).toLowerCase()
}

/** 这一份是不是**图片**资料（一张截图 / 一张照片 = 一页）。
 *  它就是"这一份资料不是 PDF" —— 渲染层只有这一处需要知道两者的区别。 */
export function isImageDoc(p) {
  return DOC_IMAGE_EXTS.includes(docExtOf(p))
}

/** 这一串是不是一个合法的资料引用：`.资料/<文件名>.pdf` 或 `.资料/<文件名>.png`，就两层，多一层都不要。
 *  ⚠ 它同时是**服务端的安检查**（`/api/doc/file` 的路径闸）—— 放开的后缀必须在这张白名单里，
 *    别的地方不许再认一遍。 */
export function isDocPath(p) {
  const s = String(p == null ? '' : p)
  if (!s.startsWith(DOC_DIR + '/')) return false
  const segs = s.split('/')
  if (segs.length !== 2) return false
  if (!segs[1] || /[/\\]/.test(segs[1])) return false
  const ext = docExtOf(segs[1])
  return ext === '.pdf' || DOC_IMAGE_EXTS.includes(ext)
}

/** 缺 id 时的兜底（板文件里不该发生 —— 我们插进去的都带 id；手改文件删了就补一个）。 */
function fallbackId() {
  return DOC_ID_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 一页的**世界高度**：资料世界宽 × 那页的宽高比。 */
export function pageWorldH(doc, pw, ph) {
  const w = Number(doc && doc.w) > 0 ? Number(doc.w) : DOC_DEFAULT_W
  const pwN = Number(pw) > 0 ? Number(pw) : 1
  const phN = Number(ph) > 0 ? Number(ph) : 1
  return (w * phN) / pwN
}

/** 一页后面**额外**留多少（世界像素）。板文件里那些手写/老版本的值都从这儿过一道。
 *  ★ `pageGaps` 是给"老师讲解"那一版用的：一页的讲解常常比这一页还高，那就把**下面
 *    那一页推开**，让"页面 + 它两侧的讲解"永远对齐（见 doc-cards.js 的 projectDeck）。
 *    没有这个字段的板（老文件、没整理过的资料）行为和以前**一模一样**。 */
export function extraPageGap(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(20000, Math.round(n)) : 0
}

/** 一份资料的每一页摆在世界坐标的哪里：[{x,y,w,h}, ...]（页序不变）。
 *  ★ 这是 x/y/w/pages/pageGaps 的**唯一**算处 —— 渲染、fitView、拖动命中的"这份资料多大"
 *    全从这儿拿，谁都不许自己再算一份（同一个矩形两处各算一遍的账，这个仓库记了十几条）。 */
export function pageRects(doc) {
  if (!doc || !Array.isArray(doc.pages)) return []
  const x = Number(doc.x) || 0
  const w = Number(doc.w) > 0 ? Number(doc.w) : DOC_DEFAULT_W
  const gaps = Array.isArray(doc.pageGaps) ? doc.pageGaps : []
  const out = []
  let y = Number(doc.y) || 0
  for (let i = 0; i < doc.pages.length; i += 1) {
    const [pw, ph] = doc.pages[i]
    const h = pageWorldH(doc, pw, ph)
    out.push({ x, y, w, h })
    y += h + DOC_PAGE_GAP + extraPageGap(gaps[i])
  }
  return out
}

/** 一份资料的包围盒（世界坐标 {x,y,w,h}）—— fitView 用它把资料装进屏幕。 */
export function docBounds(doc) {
  const rects = pageRects(doc)
  if (!rects.length) return null
  const first = rects[0]
  const last = rects[rects.length - 1]
  return { x: first.x, y: first.y, w: first.w, h: last.y + last.h - first.y }
}

/** 读盘归一：手改文件、老版本、传输截断，什么怪值都可能进来 —— 挡在这一层。 */
export function normalizeDoc(d) {
  if (!d || typeof d !== 'object') return null
  const path = typeof d.path === 'string' ? d.path.trim() : ''
  if (!isDocPath(path)) return null
  /* 每页 [pw, ph] 必须是正数（宽高比才算得出来）；一页都没剩的资料是空壳，不要。 */
  const pages = (Array.isArray(d.pages) ? d.pages : [])
    .map((p) => {
      const a = Array.isArray(p) ? Number(p[0]) : NaN
      const b = Array.isArray(p) ? Number(p[1]) : NaN
      return Number.isFinite(a) && Number.isFinite(b) && a > 1 && b > 1 ? [a, b] : null
    })
    .filter(Boolean)
  if (!pages.length) return null
  const w = Number(d.w)
  /* 每一页后面额外留的空（"老师讲解"整理的产物，见 `extraPageGap`）：
     全 0 / 长度对不上就当没有 —— 这个字段**只在真有时才写进板文件**，
     所以老文件和没整理过的资料一个字节都不变。 */
  const rawGaps = []
  {
    /* ⚠ 别写成 `.map(...)`：`projectDeck` 交回来的是个**稀疏数组**（只有整理过的那几页有值），
       map 会把空洞原样带过去，写进文件就成了 `[null, 370]` —— 难看而且下次读回来还得再兜一次。 */
    const src = Array.isArray(d.pageGaps) ? d.pageGaps : []
    for (let i = 0; i < pages.length; i += 1) rawGaps.push(extraPageGap(src[i]))
  }
  const gaps = rawGaps.some((g) => g > 0) ? rawGaps : null
  return {
    id: typeof d.id === 'string' && d.id ? d.id : fallbackId(),
    path,
    /* 标题是给人看的（页眉那条把手上写的名字）。空标题不写、渲染时退回文件名。 */
    ...(typeof d.title === 'string' && d.title.trim() ? { title: d.title.trim() } : {}),
    x: Number.isFinite(Number(d.x)) ? Number(d.x) : 0,
    y: Number.isFinite(Number(d.y)) ? Number(d.y) : 0,
    /* 宽度有上下限：太窄读不了，太宽霸板（和卡片 CARD_MAX_W 同一条理由）。 */
    w: Math.min(4000, Math.max(80, Number.isFinite(w) && w > 0 ? w : DOC_DEFAULT_W)),
    pages,
    ...(gaps ? { pageGaps: gaps } : {}),
  }
}

export function normalizeDocs(raw) {
  const out = []
  const seen = new Set()
  for (const d of Array.isArray(raw) ? raw : []) {
    const n = normalizeDoc(d)
    if (!n || seen.has(n.path)) continue
    /* 同一份 PDF 挂两份没有意义（引用同一个文件、页面尺寸也一样）—— 先来的赢。 */
    seen.add(n.path)
    out.push(n)
  }
  return out
}

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/** 出关（写进板文件）的形状。和进关同一个 normalizeDoc —— "存→读→再存"字节一致。 */
export function serializeDoc(d) {
  const n = normalizeDoc(d)
  if (!n) return null
  return {
    id: n.id,
    path: n.path,
    ...(n.title ? { title: n.title } : {}),
    x: r1(n.x),
    y: r1(n.y),
    w: r1(n.w),
    pages: n.pages.map(([a, b]) => [r2(a), r2(b)]),
    /* 末尾那串 0 不写：最后一页后面留多少没人看得见（那是"下一页"的地）。
       于是"没整理过"的资料在这里少一个字段，和以前写出来的一模一样。 */
    ...(n.pageGaps && n.pageGaps.slice(0, -1).some((g) => g > 0) ? { pageGaps: n.pageGaps.map((g) => r1(g)) } : {}),
  }
}
