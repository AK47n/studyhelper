/* 白板的数据模型 + 几何 + 「关系怎么算出来」。
 *
 * 这里刻意**不碰任何 DOM 和 canvas**：输入是纯数据（点数组、卡片框），
 * 输出也是纯数据（框、最近邻、父节点）。理由是这一层最容易"看起来对、
 * 实际错"（吸附吸错人、孤岛数错、缩放后锚点飘），而且错了没法靠肉眼发现。
 * 抽出来之后 scripts/check-board.js 能在 node 里直接跑断言。
 *
 * ── 坐标系只有一套：世界坐标（world）──
 * 笔迹的点、卡片的位置，全都存世界坐标。视图有 s（缩放）和 tx/ty（平移），
 * 屏幕坐标 = 世界坐标 * s + t。于是：缩放平移**不改一个字节的数据**，
 * 只改你自己的视图；换个缩放再打开，画的东西还在原地。
 *
 * 坑（已经踩过）：别把屏幕坐标存进文件。一旦存了，"上次在哪里看的"
 * 就变成了数据的一部分，改缩放等于改内容，撤销栈、Git 备份全跟着脏。
 */

/* 视图映射（屏幕 = 世界 × s + t）在 `./view.js` 里 —— 只有那一份实现。
   这里只用得到两件：`clampViewScale`（读盘时归一化缩放）和 `centerOn`（fitView 摆内容）。 */
import { centerOn, clampViewScale } from './view.js'
/* 关系的词表（LINK_KINDS / LINK_NONE / isLinkKind…）搬去了 link-kinds.js；
   连接那一族的实现搬去了 links.js。board.js 只剩数据模型 + 几何 + 关系推断。 */
import { LINK_NONE, isLinkKind } from './link-kinds.js'

export const BOARD_VERSION = 3
export const BOARD_PREFIX = 'board-' // 白板文件都叫 board-xxx.md（内容其实是 JSON，见下）
export const CARD_KINDS = ['formula', 'note']
/* 新卡片的默认框。
   ⚠ `h` 在这个应用里是**最小高度**，不是"内容该多高"：
     · 一张便签可以被你故意开得很大 —— 它是"装住别的卡"的容器。
       样板板就靠一个 520×420 的便签演示「包含」（见 seed-board.js 的注释）。
     · 所以**不会**按内容自动把卡片缩扁 —— 那会把容器用法和关系推理一起弄坏
       （自检里"2 个包含 + 1 个挨着"那条会当场变红）。
   这里只把**新建时的起点**定得贴着内容：公式卡一行字大约 32 世界像素，
   原来的 96 会让新卡下面空一大截（用户 2026-09-16 报的"留白太多"）。
   识别/美化**插进来的**那张卡会再按真实内容量一次（Board.jsx 的 fitCardHeight）。 */
export const DEFAULT_CARD_SIZE = { w: 260, h: 44 }
export const CARD_MIN_H = 20 // 世界像素：比这更矮的框连一行字都放不下

/* ── 文字卡的字体（"字变好看"就靠这一张表）──
 *
 * 只用**系统里已经装了的**字体，一个字节都不下载 —— 这个工具的底线是
 * "数据在你硬盘上、白板永不上传"，为了好看去联网拉一个字体包，就把这条破了。
 * 所以每个预设是一串**候选**：装了第一个就用第一个（霞鹜文楷是开源的，
 * 谁自己装了就自动优先用上），没装就退到系统自带的那个，最差退到 serif/sans-serif。
 *
 * 默认是楷体（kai）：它的笔画带手写的笔势，但每个字都规规矩矩 ——
 * 这正是"我写的丑字"和"好看的字"之间最短的那一步。
 * 换成黑体虽然也整齐，但那是"打印体"，和你写的东西没关系了。 */
export const CARD_FONTS = [
  { id: 'kai', name: '楷体', css: '"LXGW WenKai", "霞鹜文楷", "KaiTi", "楷体", "STKaiti", serif', note: '最像手写，但每一笔都规矩' },
  { id: 'song', name: '宋体', css: '"Source Han Serif SC", "Noto Serif CJK SC", "SimSun", "宋体", serif', note: '横细竖粗，像印出来的书' },
  { id: 'hei', name: '黑体', css: '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Sans CJK SC", sans-serif', note: '笔画一样粗，最清楚' },
  { id: 'yuan', name: '圆体', css: '"YouYuan", "幼圆", "Yuanti SC", "Hiragino Maru Gothic ProN", sans-serif', note: '圆头圆脑，没那么严肃' },
]
export const CARD_FONT_IDS = CARD_FONTS.map((f) => f.id)
export const DEFAULT_CARD_FONT = 'kai'

export function fontCss(id) {
  const f = CARD_FONTS.find((x) => x.id === id)
  return (f || CARD_FONTS[0]).css
}

/* ── 卡片的"放大缩小" ──
 *
 * 一张卡有两个尺寸概念，别混：
 *   · `w`/`h` —— **布局尺寸**（世界坐标）。决定文字在哪里折行、卡片占多大地方。
 *   · `scale` —— **倍率**（默认 1）。字号、内边距、圆角、宽高**一起**乘它。
 * 拖右下角改的是 `scale`，不是 w/h —— 因为用户要的是"整张卡放大"，
 * 而字号是写死在 CSS 里的（`15px * --s * --bd-card-scale`）：
 * 只把 w/h 改大、字号不动的话，卡片会越拉越大、字还是那么小，看着像坏了。
 * 乘同一个 k 也保证了**折行位置不变**（宽和字号同比例变），放大后版式一模一样。
 *
 * 上下限两头都有理由：太小了框不住一个字；太大了那张卡能把整块板盖住，
 * 而白板是画关系的地方，一张卡吃掉整屏就没法用了。 */
export const DEFAULT_CARD_SCALE = 1
export const CARD_MIN_SCALE = 0.5
export const CARD_MAX_SCALE = 4
export const CARD_MIN_W = 80 // 世界像素：再小就连一个字都放不下
export const CARD_MAX_W = 2000 // 世界像素：再大就是"一张卡盖满整块板"

export function clampCardScale(k) {
  const n = Number(k)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CARD_SCALE
  return Math.min(CARD_MAX_SCALE, Math.max(CARD_MIN_SCALE, n))
}

/* 拖右下角时算"新的倍率应该是多少"。
   传进来的是**相对按下那一刻的倍数**（k=1 表示没动），返回夹好的绝对 scale。
   ★ 夹两个东西：倍率本身（0.5~4），以及"乘完之后的**世界宽度**"（80~2000 像素）。
     只夹倍率是不够的：一张本来就 1500 宽的卡乘 4 就是 6000 —— 铺满整块板、
     甚至跑到屏幕外面，而白板是画关系的地方，一张卡吃掉整屏就没法用了。
     反过来一张 120 宽的窄卡乘 0.5 只剩 60，连一个字都放不下。
   ⚠ 别写成 `Math.max(raw, Math.min(raw, cap))` 那种形状 —— 那等于没夹
     （外层那个 max 会把刚压下去的值又抬回来）。下限和上限各算一次，再夹 raw。 */
export function nextCardScale(card, k) {
  const s0 = clampCardScale(card && card.scale)
  const w0 = Number(card && card.w) > 0 ? Number(card.w) : DEFAULT_CARD_SIZE.w
  const raw = s0 * (Number(k) > 0 ? Number(k) : 1)
  const lo = Math.max(CARD_MIN_SCALE, CARD_MIN_W / w0)
  const hi = Math.min(CARD_MAX_SCALE, CARD_MAX_W / w0)
  // lo > hi 只会出现在 w0 荒谬的时候（手改文件写了个 1 像素宽）；那种情况下听宽度上限的
  if (lo > hi) return hi
  return Math.min(hi, Math.max(lo, raw))
}

/* ── 文字卡摆在哪儿、多大 ──
 *
 * 这一段是纯几何，所以放在这一层（能被 check-board.js 钉住），不写在 JSX 里。
 *
 * ★ 落点 = 你圈的那块笔迹的左上角。**卡片不去盖那几笔**（2026-09-16 用户明确要的：
 *   「不用盖住，就让框贴合公式和字就行」）—— 上一版是"卡片底色不透明、正好把丑字盖住"，
 *   于是卡片的宽高里混进了一份"至少要有你圈的那块那么大"；笔迹一被擦掉、
 *   或者你只是想让它收一收，那份尺寸就变成一片莫名其妙的留白。
 *   现在两件事分开：卡片只管**贴合自己的内容**；不想要那几笔手写了，
 *   面板上那个勾（"顺便把原来的手写擦掉"）就是唯一的说法。
 *
 * ★ 字号按卡片里的 15px（见 styles.css 的 .bd-card）估，一行装得下几个字。
 *   用 [...str] 而不是 str.length 数字符：中文没事，但 emoji / 生僻字在
 *   JS 里是**两个 UTF-16 单位**，按 .length 数会把它算成两个字 —— 行长估多一倍、
 *   卡片高度就差一截。这种错很小，但它会让"估的行数"和"真的行数"永远对不上。 */
export const TEXT_CARD_MIN_W = 220
export const TEXT_CARD_MAX_W = 560
/* 一行按 24 世界像素、上下内边距共 14 估。
   这两个数跟着 styles.css 里卡片的行高和内边距走（行高 1.5 × 字号 15 ≈ 22，取 24 留点余量；
   内边距是 4px × 视图缩放，两头加起来约 9 —— 取 14 是保守的，宁可略高也别压到字）。
   估完还会在**插进去之后**量一次真实高度（Board.jsx 的 fitCardHeight），
   所以这里只要不离谱就行，不用精确。 */
export const TEXT_CARD_LINE_H = 24
export const TEXT_CARD_PAD_Y = 14

export function textCardRect(box, text) {
  const bw = Math.max(1, Number(box && box.x1) - Number(box && box.x0))
  /* 宽度先按"你圈的那块有多宽"来 —— 它是"这段字排多宽"的信号；
     插进去之后 fitCardSize 会按**真实自然宽度**再收一次（公式卡和文字卡现在都收）。 */
  const w = Math.round(Math.min(TEXT_CARD_MAX_W, Math.max(TEXT_CARD_MIN_W, bw)))
  const perLine = Math.max(4, Math.floor((w - 24) / 15))
  let lines = 0
  for (const para of String(text == null ? '' : text).split('\n')) {
    lines += Math.max(1, Math.ceil([...para].length / perLine))
  }
  // 高度只按**内容**估：不再拿圈的那块笔迹当下限（那是"盖住"那套留下的东西）
  const h = Math.max(lines * TEXT_CARD_LINE_H + TEXT_CARD_PAD_Y, CARD_MIN_H)
  return {
    x: Math.round(Number(box && box.x0) || 0),
    y: Math.round(Number(box && box.y0) || 0),
    w,
    h: Math.min(1600, h),
  }
}

/* 内容渲染出来多高 → 卡片的 h 该是多少（世界坐标）。
   传进来的 px 是**内容**（.bd-card-body）的高度，`padPx` 是这张卡上下内边距 + 边框
   （屏幕像素，从 computed style 读），除以视图缩放和卡片倍率就是世界高度。
   ★ 为什么量内容、而不是量卡片自己：卡片的 min-height 就是 h ——
     量卡片等于量它自己，96 的卡量出来永远还是 96，底下的空白永远消不掉。
     内容高度只跟宽度和字号有关、跟 h 无关，所以这个换算不会来回振荡
     （振荡就会每存一次盘都造一条假 diff）。
   ★ `padPx` 必须加上：这个仓库全局是 `box-sizing: border-box`，
     卡片上写的 `width/height/min-height` **都把内边距和边框算在里面**。
     不加的话，算出来的数会比内容真正需要的小一整圈 ——
     宽度那条线上直接表现为**内容被裁掉**（实测 `E = mc²` 少了 18px 的 `c²`）。 */
export function cardHeightFromContent(px, { s = 1, scale = 1, padPx = 0 } = {}) {
  const k = (Number(s) || 1) * (Number(scale) || 1)
  const h = ((Number(px) || 0) + (Number(padPx) || 0)) / (k > 0 ? k : 1)
  return Math.max(CARD_MIN_H, Math.ceil(h * 10) / 10)
}

/* 内容的自然宽度 → 卡片的 w（**公式卡和文字卡都量**）。
   公式是一行不折行的，它自己有多宽就是多宽；文字卡的自然宽度 = **最长那一行**
   （识别结果保住了你写的换行，所以不会变成一长条），超过 TEXT_CARD_MAX_W 才折行。 */
export const CARD_FIT_MIN_W = 60 // 世界像素：再窄的公式卡看着像一条缝
export function cardWidthFromContent(px, { s = 1, scale = 1, padPx = 0 } = {}) {
  const k = (Number(s) || 1) * (Number(scale) || 1)
  // 内容需要 px → 卡片要有 px + 左右内边距/边框（border-box，见上面 cardHeightFromContent 的说明）
  const w = ((Number(px) || 0) + (Number(padPx) || 0)) / (k > 0 ? k : 1)
  /* ⚠ 宽度**向上取整**（高度那边无所谓，因为写的是 min-height）。
       · 高度写的是 `min-height` —— 内容比它高，卡片自己会长，量小了不会出事；
       · 宽度写的是 `width`（硬约束）—— 量小了内容**当场被裁掉**。
     实测就是这么裁了一次：`E = mc²` 的 `c²` 直接不见（差 18px = 内边距 + 边框）。
     所以宁可多 0.1 个世界像素，也不能少。 */
  const rounded = Math.ceil(w * 10) / 10
  return Math.min(CARD_MAX_W, Math.max(CARD_FIT_MIN_W, rounded))
}

/* 荧光笔：颜色和宽度都**钉死**，不给用户选。
   为什么不做成"可选颜色"：荧光笔的语义是"在已有的字上叠一层记号"，
   不是"用另一种颜色写字"。颜色一变，那层半透明的黄底就不成立了
   （红色荧光笔盖在黑字上，字就读不清了）。宽度同理 —— 马克笔只有一种笔头。
   这两个常量被"存储层归一化"和"渲染层"共用，所以只能有一处定义。 */
export const HL_COLOR = '#ffd43b'
export const HL_WIDTH = 16

/* 关系判定的距离阈值，单位是**世界坐标像素**。
   为什么是 26：这是"手画的时候看起来连着、但其实没碰到"的典型间距。
   调大 → 会把无关的卡片连起来（误连比漏连更讨厌，因为它看起来像你说过的话）。 */
export const NEAR_GAP = 26
export const CONTAIN_RATIO = 1.4 // 大框包住小框：面积比超过这个数才算"包含"，否则算"重叠"

let idSeq = 0

/* id 只需要在**一个文件内**唯一（关系图是本文件内算的）。
   故意带上时间戳：两个设备各画一块，Git 合并时不会撞 id。 */
export function newId(prefix = 'x') {
  idSeq += 1
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`
}

// ─────────────────────────── 新建 / 解析 / 序列化 ───────────────────────────

export function newBoard(title = '新白板') {
  return {
    title: String(title || '新白板').replace(/\.md$/i, ''),
    version: BOARD_VERSION,
    view: { s: 1, tx: 0, ty: 0 },
    /* viewPinned：这条视野是**你亲手平移/缩放定的**吗？
       false（默认）= 打开时自动把所有内容装进屏幕；true = 老老实实用存下来的那条。
       为什么要这个东西：tx/ty 是**相对画布容器**的坐标（见 Board.jsx 顶部），
       容器一变（换摆法、改界面字号、窗口大小变了），旧坐标就是个错的位置。
       与其猜"要不要迁移"，不如只在你真的自己动过视图之后才记住它 ——
       没动过就一直自动适配，永远不会因为容器变了而错位。 */
    viewPinned: false,
    strokes: [],
    cards: [],
    // 「圈起来的范围」：暂时不做，先留字段，免得以后加字段要改版本号
    groups: [],
  }
}

export function newCard(kind, x, y, extra = {}) {
  const size = extra.w && extra.h ? { w: extra.w, h: extra.h } : { ...DEFAULT_CARD_SIZE }
  return {
    id: newId(kind === 'formula' ? 'f' : 'n'),
    kind: CARD_KINDS.includes(kind) ? kind : 'note',
    x: Math.round(x - size.w / 2), // 传进来的 x/y 是"我要放的中心"，存的是左上角
    y: Math.round(y - size.h / 2),
    w: size.w,
    h: size.h,
    src: '', // 公式卡片：你随手写的那串（就是文件里存的东西）
    tex: '', // 上面那串渲染用的样子（改烂了随时能从 src 重算）
    text: '', // 便签/文字卡片：一句话
    font: DEFAULT_CARD_FONT, // 文字卡的字体预设（见 CARD_FONTS）；公式卡用不到
    scale: DEFAULT_CARD_SCALE, // 放大缩小倍率（见 nextCardScale）；1 = 原样
  }
}

export function newStroke(tool, points, brush = {}) {
  const isHi = tool === 'highlighter'
  return {
    id: newId('s'),
    tool: isHi ? 'highlighter' : 'pen',
    color: isHi ? HL_COLOR : brush.color || '#1b1d22',
    // 荧光笔的宽度不给默认值兜底 —— 直接用 HL_WIDTH。
    // 漏了这一步的话，调用方忘了传 brush.width 就会得到 2.5 的"荧光笔"，
    // 画出来是一条细得看不出是荧光笔的线（我自己的样板就这么中过一次）。
    width: isHi ? HL_WIDTH : Number(brush.width) || 2.5,
    pressure: isHi ? false : brush.pressure !== false,
    points: Array.isArray(points) ? points.slice() : [],
  }
}

/* 把一组笔**固定成一块**：返回新的 `groups`（界面只负责调它）。
 * 一笔只能属于一个组（见 normalizeGroups），所以这里先把这些笔从别的组里**拿走** ——
 * 新选的这块更具体，它赢；被拿空的组直接消失（不留空壳）。
 * 为什么要放进 lib：不这么干的话，界面能造出"内存里两笔重叠、文件里只认一笔"的状态，
 * 于是**存→读→再存不一致**（下次打开分组悄悄变了）—— 模糊测试逮到过。 */
export function freezeGroup(groups, ids) {
  const set = new Set(ids)
  const out = []
  for (const g of groups || []) {
    const keep = (g.ids || []).filter((id) => !set.has(id))
    if (keep.length) out.push({ ...g, ids: keep })
  }
  out.push({ id: newId('g'), ids: [...set] })
  return out
}

/* 一笔的点**够不够格进文件** —— 读和写**只有这一份判据**。
 * `normalizeStroke` 用它决定"读不读得回来"，`serializeBoardDocument` 用它决定"写不写出去"。
 * 两边各写一份的话，一定会出现"写得出去、读不回来"的文件：
 * 模糊测试当场逮到过 —— 一个只有一个点的笔迹被写进文件，下次打开却被丢掉，
 * 于是文件里攒下读不回来的垃圾、而且"存→读→再存"不再字节一致。
 * （应用自己产生不了这种笔迹：落笔那一下有 2.5px 的闸、抽稀后至少留两点。
 *   但别的入口、手改过的文件、以后的新代码都可能产生，所以出关也拦一道。） */
export function isStrokePointsOK(flat) {
  return toFlat(flat).length >= 6 // 两个点 × (x, y, p)
}

/* ═══════════ 显式分组：「这一坨就是我说的那一块」 ═══════════
 *
 * 自动聚类（见下面"墨迹块"那一节）会把挨得近的两坨并成一块 —— 后果虽然轻
 * （"多连了一个"，绝不改你的字），但**你没地方纠正它**。这里就是那个地方：
 * 框住一块 → 固定成一块（写进 `groups`）。固定之后：
 *   ① 它**永远是独立的一块**（旁边那坨再近也不并）；
 *   ② 两块各自固定 = 把它们**拆开**（自动聚类再也不会把它们并起来）；
 *   ③ 块 id 变成 `grp:<组 id>` —— 稳定、跨重开还是同一个。
 * 存盘**只在真有固定块时才写**这个字段：没固定过的板一个字节都不多。
 *
 * 规矩：一笔**最多属于一个给组**（重复的、指向已经擦掉的笔的 id 一律丢掉；
 * 成员全被擦光的组自己消失，不留空壳——不然文件里会攒一堆尸体）。 */
export function normalizeGroups(raw, strokeIds) {
  const out = []
  const used = new Set()
  for (const g of Array.isArray(raw) ? raw : []) {
    if (!g || typeof g !== 'object') continue
    const ids = (Array.isArray(g.ids) ? g.ids : []).filter(
      (id) => typeof id === 'string' && strokeIds.has(id) && !used.has(id)
    )
    if (!ids.length) continue
    for (const id of ids) used.add(id)
    out.push({ id: typeof g.id === 'string' && g.id ? g.id : newId('g'), ids })
  }
  return out
}

export function isBoardName(name) {
  return new RegExp(`^${BOARD_PREFIX}.*\\.md$`, 'i').test(String(name || ''))
}

export function isBoardDocument(text) {
  const t = String(text || '').trim()
  if (!t.startsWith('{')) return false
  try {
    const o = JSON.parse(t)
    return !!o && Array.isArray(o.strokes)
  } catch {
    return false
  }
}

export function parseBoardDocument(text, fallbackTitle = '新白板') {
  let raw = null
  try {
    raw = JSON.parse(String(text || ''))
  } catch {
    return newBoard(fallbackTitle)
  }
  if (!raw || typeof raw !== 'object') return newBoard(fallbackTitle)

  const b = newBoard(raw.title || fallbackTitle)
  b.version = BOARD_VERSION
  const v = raw.view || {}
  b.view = {
    s: clampScale(Number(v.s)) || 1,
    tx: Number(v.tx) || 0,
    ty: Number(v.ty) || 0,
  }
  b.viewPinned = raw.viewPinned === true
  b.strokes = (Array.isArray(raw.strokes) ? raw.strokes : []).map(normalizeStroke).filter(Boolean)
  b.cards = (Array.isArray(raw.cards) ? raw.cards : []).map(normalizeCard).filter(Boolean)
  /* 显式分组（"这一坨就是我说的那一块"）：成员被擦掉的、重复的一律丢掉。
     必须**在 strokes 之后**做 —— 要看得出哪些 id 还活着。 */
  b.groups = normalizeGroups(raw.groups, new Set(b.strokes.map((s) => s.id)))
  return b
}

const clampScale = (s) => (Number.isFinite(s) && s > 0.05 && s < 20 ? s : 0)

function normalizeStroke(s) {
  if (!s || typeof s !== 'object') return null
  const pts = toFlat(s.points) // ★ 一律归成扁平数组，见下方说明
  if (!isStrokePointsOK(pts)) return null
  const tool = s.tool === 'highlighter' ? 'highlighter' : 'pen'
  return {
    id: typeof s.id === 'string' && s.id ? s.id : newId('s'),
    tool,
    // 荧光笔固定用荧光黄：它是一次"叠在字上做记号"的动作，
    // 不是一种可选颜色（见 HL_COLOR 的说明）
    color: tool === 'highlighter' ? HL_COLOR : typeof s.color === 'string' ? s.color : '#1b1d22',
    /* ★ 荧光笔的宽度也钉死，**不保留**文件里写的值。
       为什么这里比"保持原样"更狠：荧光笔是马克笔，只有一种笔头；
       而文件里那些 2.5 / 4 的宽度不是用户选的，是早先代码里
       `Number(brush.width) || 2.5` 这个兜底漏出来的默认值。
       留着它们，用户会看到"有的荧光笔粗、有的细"，而且找不到原因。 */
    width: tool === 'highlighter' ? HL_WIDTH : Number(s.width) > 0 ? Number(s.width) : 2.5,
    /* ★ 荧光笔**永远不吃压力**。
       荧光笔是马克笔：笔迹是一道**宽度恒定**的带子。
       早先的代码把 pressure 当成通用属性，于是荧光笔也逐点改线宽 ——
       写起来一下粗一下细，看起来像"效果不均匀"，其实是 bug。
       这一条放在归一化里，所以**老文件里的笔迹下次打开也会自动修好**
       （不用你去把画过的荧光笔重描一遍）。 */
    pressure: tool === 'highlighter' ? false : s.pressure !== false,
    /* 连线的类型（见上面 LINK_KINDS）。
       ★ 认不出的值一律**丢掉**（不退回默认再写回去）—— 手改文件写个 "因果"、
         "Cause"、或者别的版本的 id，都不该让这一笔变成"手动标过 rel"；
         丢掉之后它就回到"按形状自动判"，屏幕上的表现是对的。
       ★ 而且这里**不补默认值**：绝大多数笔迹没有这个字段（也永远不该有），
         补一个 `link: 'rel'` 出去就等于给整本板子造一次假 diff。
       ★ `'none'`（"这条不算连接"）要原样保留 —— 它是你明确说过的一句话，
         丢了它，下次打开那条假连接就自己回来了。 */
    ...(isLinkKind(s.link) || s.link === LINK_NONE ? { link: s.link } : {}),
    points: pts,
  }
}

/* ⚠ 内存里的点**必须**是扁平数组（[x,y,p, x,y,p, ...]）。
   这一条是踩出来的，而且是最贵的一个坑：
     parseBoardDocument 一开始把点规范化成了**对象数组** [{x,y,p}]，
     而画布、抽稀、包围盒这些读点的地方按扁平数组读下标 0/1/2 ——
     于是一笔 10 个点的线被读成"3 个点"，画出来只有 0 长度，屏幕上什么都没有。
     更气人的是：文件内容是好的、控制台的数字看着也"对"（3 笔），
     只是画布上一片空白，怎么查都像渲染的问题。
   所以：**所有入口都用 toFlat 收敛成扁平数组**，读点的地方统一用 toPoints
   （它两种都认，是给"万一有对象混进来"兜底的，不是给主力路径用的）。 */

function normalizeCard(c) {
  if (!c || typeof c !== 'object') return null
  const kind = CARD_KINDS.includes(c.kind) ? c.kind : 'note'
  const w = Number(c.w) > 40 ? Number(c.w) : DEFAULT_CARD_SIZE.w
  /* 高度：比 CARD_MIN_H 还小的值（手改文件写了个 1）当没写。
     阈值必须跟 CARD_MIN_H 对齐 —— 早先写死 32，而识别插进来的小卡片
     高度可能只有 30 出头，那样每存一次盘就被抬回默认值（假 diff 又来了）。 */
  const h = Number(c.h) >= CARD_MIN_H ? Number(c.h) : DEFAULT_CARD_SIZE.h
  const src = typeof c.src === 'string' ? c.src : ''
  const tex = typeof c.tex === 'string' ? c.tex : ''
  return {
    id: typeof c.id === 'string' && c.id ? c.id : newId(kind === 'formula' ? 'f' : 'n'),
    kind,
    x: Number(c.x) || 0,
    y: Number(c.y) || 0,
    w,
    h,
    /* 早期版本的手写识别只写 tex、故意把 src 留空（当时的理由是"给手打的那串留个参照"）。
       但**编辑态编辑的就是 src** —— 空 src 等于"双击进卡片看到一个空输入框"，
       而这正是「识别是对的，但放不到白板上」那个 bug 的另一半。
       所以读盘时就地补齐：公式卡有 tex 没 src，就把 src 当成 tex。
       只补公式卡、只在 src 真的空的时候补 —— 手打过的 src 一个字都不动。 */
    src: kind === 'formula' && !src.trim() && tex.trim() ? tex : src,
    tex,
    text: typeof c.text === 'string' ? c.text : '',
    /* 字体：认不出的 id 一律退回默认，不写进文件的东西也不该让渲染层拿到 undefined。
       （"改一个不认识的值就把整张卡的样式搞崩"这类事，在这一层挡掉最省事。） */
    font: CARD_FONT_IDS.includes(c.font) ? c.font : DEFAULT_CARD_FONT,
    /* 倍率：认不出的值（负数、NaN、字符串）一律退回 1。
       "手改一个怪值就把卡片的字号搞成 0"这种事故，挡在这一层最省事。 */
    scale: clampCardScale(c.scale),
    /* 固定（钉住）：**只有真的是 true 才算固定**。
       认 "true" / 1 这种字符串和数字是不行的 —— 手改文件写个 "false"
       会变成"固定的"，而用户以为自己是解开。严格判 true，别的一律当没固定。 */
    locked: c.locked === true,
  }
}

/* 存的文件要能被人和 Git 看懂一点：坐标保留一位小数，压力保留两位。
   一位小数够不够？线条宽度 2.5px，1/10 像素的误差肉眼看不出；
   但能让一个大板的文件小 30% 左右，diff 也干净得多。

   为什么压力要两位：压力决定线条粗细，0.63 → 0.6 的差别看不见，**但它要能往返**。
   压缩到一位时，"打开文件 → 什么都不改 → 存回去"会和原文不一样，
   于是 Git 每次都报一次假 diff，而你会慢慢学会忽略 diff —— 那比不备份更糟。
   宁可一个点多两个字节，也不要每天一条假改动。 */
export function serializeBoardDocument(board) {
  /* ★ 先算出"这次真的会写进文件的笔"：后面 groups 的"哪一笔还活着"必须看**这一批**，
     不是内存里那一批 —— 两批不一样时（内存里有一笔写不出去的垃圾笔迹），
     groups 会引用一个文件里根本没有的 id，读回来时又被 normalizeGroups 丢掉，
     于是"存→读→再存"不再一致（模糊测试逮到的就是这一条）。 */
  const strokes = (board.strokes || [])
    /* ★ 出关也要过"这一笔能不能进文件"那道闸（`isStrokePointsOK`）——
       写得出去、读不回来的东西一个都不留。判据和 normalizeStroke 是同一份。 */
    .map((s) => ({ s, flat: toFlat(s.points) }))
    .filter((it) => isStrokePointsOK(it.flat))
    .map(({ s, flat }) => ({
      id: s.id,
      tool: s.tool,
      color: s.color,
      width: round(s.width, 1),
      pressure: s.pressure !== false,
      /* 连线的类型：**只有你手动标过才写**。
         形状读出来的（直线 = 相关、带箭头 = 因果）不写 —— 那是从点算出来的，
         随时能重算；写出去反而会和笔迹对不上（后来把箭头擦掉、补一笔直线，
         文件里那个"因果"就成了谎话）。老文件里没有这个字段，所以往返仍然字节级一致。
         `'none'`（"这条不算连接"）同样只在你说过时才写。 */
      ...(isLinkKind(s.link) || s.link === LINK_NONE ? { link: s.link } : {}),
      // ★ 必须过 toFlat，不能直接 Array.from 遍历。
      //   内存里的点有可能是**对象数组**（parseBoardDocument 规范化出来的就是），
      //   直接遍历再用 Number(n) 读，每个点都会变成 0 —— 又一次静默毁数据。
      //   序列化是"出关"的地方，出关一律走同一个出口，不指望调用方守规矩。
      points: flat.map((n) => round(n, 2)),
    }))
  const out = {
    title: board.title,
    version: BOARD_VERSION,
    viewPinned: board.viewPinned === true,
    view: {
      s: round(board.view && board.view.s ? board.view.s : 1, 3),
      tx: round(board.view && board.view.tx ? board.view.tx : 0, 1),
      ty: round(board.view && board.view.ty ? board.view.ty : 0, 1),
    },
    strokes,
    cards: (board.cards || []).map((c) => ({
      id: c.id,
      kind: c.kind,
      x: round(c.x, 1),
      y: round(c.y, 1),
      w: round(c.w, 1),
      h: round(c.h, 1),
      src: c.src || '',
      tex: c.tex || '',
      text: c.text || '',
      /* ★ 只有**非默认字体**才写这个字段。
         为什么这么抠：老白板文件里一张卡都没有 font，如果无脑写出去，
         用户一打开软件、什么都没改，所有板文件在 Git 里全部变成"已修改" ——
         这正是"每天一条假 diff、然后你学会忽略 diff"的开端（见下面 round 那段）。
         默认值不写 = 老文件一个字节都不动，往返仍然字节级一致。
         条件里**不带 kind**：读盘时任何 kind 都会归一化出 font，
         序列化要跟着同一个判据走，否则"手改过 font 的公式卡"每存一次都变一次。 */
      ...(c.font && c.font !== DEFAULT_CARD_FONT ? { font: c.font } : {}),
      /* 同理：倍率是 1（原样）就不写。老文件里一张卡都没有这个字段，
         凭空写出去会让所有老板文件在 Git 里变成"已修改"。 */
      ...(c.scale && clampCardScale(c.scale) !== DEFAULT_CARD_SCALE ? { scale: round(clampCardScale(c.scale), 3) } : {}),
      /* 固定（钉住）也只在**真的固定**时才写。默认不固定 = 不写这个字段，
         理由同上：老文件不该因为我们加了个功能就在 Git 里整块变脏。
         （"不固定"是绝大多数卡片的状态，写 `locked: false` 出去就是纯噪音。） */
      ...(c.locked === true ? { locked: true } : {}),
    })),
    /* 显式分组（你框住一块说"它就是一块"，见 normalizeGroups）：
       **只在你固定过的时候才写** —— 老文件、没固定过的板一个字节都不多。
       写之前把"已经不在板上的笔"滤掉（这个会话里刚擦掉的那些）：文件里不留尸体。
       为了让老文件的 diff 最小，它排在最后（新字段追加在尾部）。 */
    ...(() => {
      const live = new Set(strokes.map((s) => s.id))
      const taken = new Set()
      const gs = []
      for (const g of board.groups || []) {
        /* ★ 顺手去重：一笔只能属于一个组（先写的那个赢）——
           和读盘时的 normalizeGroups 同一套规矩。界面已经不会造出重叠了
           （`freezeGroup` 会先把它从别的组里拿走），但"内存里的状态"和
           "文件里的状态"必须是同一个 —— 不然出现重叠时，文件在读回来之后
           会悄悄变一个样（审查挑出来的那条）。 */
        const ids = (g.ids || []).filter((id) => live.has(id) && !taken.has(id))
        if (!ids.length) continue
        for (const id of ids) taken.add(id)
        gs.push({ id: g.id, ids })
      }
      return gs.length ? { groups: gs } : {}
    })(),
  }
  return JSON.stringify(out, null, 1) + '\n'
}

function round(n, digits) {
  const f = 10 ** digits
  return Math.round((Number(n) || 0) * f) / f
}

// ─────────────────────────────── 点的读写 ───────────────────────────────
/* 点存成一个**扁平的 number 数组** [x0,y0,p0, x1,y1,p1, ...]，不是 [{x,y,p}]。
   原因很实在：一个 60 点的笔画，对象形式在 JSON 里是 ~1800 字节，
   扁平数组是 ~400 字节。一节课画几百笔，差的是一整个数量级的文件大小。
   代价是读写都要经过 toPoints/点数 这两个函数——所以别在别处手搓下标。

   ⚠ 这一对函数**必须互相容错**，这是踩过的坑：
   toFlat 写出的是扁平数组，但原先的 toPoints 只认对象数组，
   于是「读进来的 → 原样再存一次」这一步会把 120 个点全变成 0。
   而且不报错、文件看着还是好的——纯粹的静默毁数据。
   所以：两边都接受两种形状。做法是先把输入规范化成对象数组，再统一出口。*/

export function toPoints(raw) {
  return toObjPoints(raw)
}

export function toFlat(points) {
  const pts = toObjPoints(points)
  const out = new Array(pts.length * 3)
  for (let i = 0; i < pts.length; i++) {
    out[i * 3] = pts[i].x
    out[i * 3 + 1] = pts[i].y
    out[i * 3 + 2] = pts[i].p
  }
  return out
}

function toObjPoints(raw) {
  const out = []
  if (!Array.isArray(raw)) return out
  // 扁平数组：[x, y, p, x, y, p, ...]
  if (typeof raw[0] === 'number') {
    for (let i = 0; i + 1 < raw.length; i += 3) {
      const x = Number(raw[i])
      const y = Number(raw[i + 1])
      const p = Number(raw[i + 2])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      out.push({ x, y, p: Number.isFinite(p) && p > 0 ? p : 0.5 })
    }
    return out
  }
  // 对象数组：[{x, y, p}, ...]
  for (const pt of raw) {
    if (!pt || typeof pt !== 'object') continue
    const x = Number(pt.x)
    const y = Number(pt.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const p = Number(pt.p)
    out.push({ x, y, p: Number.isFinite(p) && p > 0 ? p : 0.5 })
  }
  return out
}

// ─────────────────────────────── 几何 ───────────────────────────────

export function strokeBounds(stroke) {
  const pts = toPoints(stroke && stroke.points)
  if (!pts.length) return null
  let minX = pts[0].x
  let maxX = pts[0].x
  let minY = pts[0].y
  let maxY = pts[0].y
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const w = stroke && stroke.tool === 'highlighter' ? Number(stroke.width) || 14 : Number(stroke.width) || 2.5
  const pad = w / 2
  return { x: minX - pad, y: minY - pad, w: maxX - minX + w, h: maxY - minY + w }
}

export function cardBounds(c) {
  return { x: c.x, y: c.y, w: c.w, h: c.h }
}

export function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

export function rectsOverlap(a, b, gap = 0) {
  return (
    a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h
  )
}

export function pointInRect(pt, r, gap = 0) {
  return pt.x >= r.x - gap && pt.x <= r.x + r.w + gap && pt.y >= r.y - gap && pt.y <= r.y + r.h + gap
}

export function rectDist(a, b) {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)))
  return Math.hypot(dx, dy)
}

export function boundsOfAll(items, boundsFn) {
  let box = null
  for (const it of items || []) {
    const b = boundsFn(it)
    if (!b) continue
    box = box ? unionRect(box, b) : { ...b }
  }
  return box
}

export function unionRect(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/* 点到线段的距离。擦除、命中测试、"这一笔是从哪张卡出发的"都靠它。 */
export function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

/* 笔画有没有挨到某个圆（橡皮/命中）。直接遍历线段，不做空间索引——
   一节课的笔画量（几百笔、每笔几十点）线性扫一遍是微秒级，
   加索引只会多一处能错的地方。真到了卡顿再按 bounds 先筛。 */
export function strokeHitsCircle(stroke, cx, cy, radius, extra = 0) {
  const pts = toPoints(stroke && stroke.points)
  if (!pts.length) return false
  const r = radius + extra + (Number(stroke.width) || 2.5) / 2
  if (pts.length === 1) return Math.hypot(pts[0].x - cx, pts[0].y - cy) <= r
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pointSegDist(cx, cy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= r) return true
  }
  return false
}

/* 点抽稀：道格拉斯—普克。
   为什么必须在保存前跑：Surface 的笔 + getCoalescedEvents 一秒钟能给 240 个点，
   一笔签名就是几十个点。不抽稀的话，一节课的文件几兆，打开要等、Git 每次全量 diff。
   容差 0.6 世界像素：小于半像素的抖动在 100% 缩放下本来就看不见，
   放大到 400% 才可能看出一点点棱角——划算。

   ★ 两个"抽不干净"的坑，都是实测出来的：

   ① **必须先按存盘精度去重。** 两个几乎重合的点（坐标 0 和 0.01）会造出一条
      零长度的线段，而"点到零长度线段的距离"退化成点到点的距离，数值上一点不小，
      于是这段噪声永远超过容差、永远删不掉。手写笔画里这种点满地都是，
      结果是文件比不抽稀还难看。先去重（阈值 0.03 < 存盘精度 0.1）再抽。
   ② 端点必须原样保留。下面第一个断言就是钉这个，不然每存一次笔画都在慢慢缩。

   去重会把坐标对齐到 1/10 像素 —— 这和存盘精度一致，所以**不算丢精度**。 */
export function simplifyPoints(points, tol = 0.6) {
  const pts = dedupePoints(points || [])
  const n = pts.length
  if (n <= 2) return pts
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [i0, i1] = stack.pop()
    if (i1 - i0 < 2) continue
    let maxD = -1
    let idx = -1
    const a = pts[i0]
    const b = pts[i1]
    for (let i = i0 + 1; i < i1; i++) {
      const d = pointSegDist(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1
      stack.push([i0, idx], [idx, i1])
    }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i])
  return out
}

const Q = 10 // 存盘精度：1/10 像素。去重阈值也按这个来（见上）

function dedupePoints(points) {
  const out = []
  for (const p of points) {
    const x = Math.round(p.x * Q) / Q
    const y = Math.round(p.y * Q) / Q
    const last = out[out.length - 1]
    if (last && last.x === x && last.y === y) {
      // 同步一下压力：重合的点里最后的压力更接近"你此刻的力道"
      last.p = p.p
      continue
    }
    out.push({ x, y, p: p.p })
  }
  return out
}

/* 视图映射（屏幕 = 世界 × s + t）整体搬去了 `src/lib/view.js` —— 2026-09-16。
   为什么搬：这条公式以前被手抄 14 处、canvas 变换写了两份、捏合还复制了一份
   导出逻辑，而**导出那份有自检、手指走的是复制品**。现在口径只在一个文件里，
   调用方（Board.jsx / BoardCanvas.jsx / 自检）都从 view.js 取。
   `fitView` 留在这里：它要算"内容包围盒"，属于板的几何，不属于视图映射。 */

// ─────────────────────── 关系：就近归属 / 枢纽 / 孤岛 ───────────────────────
/* 「关系」不是让你填的字段，是**从你画的位置里读出来的**。
 *
 * 判定的顺序（从强到弱）：
 *   ① 包含 —— 一张卡整个落在另一张卡里面（面积差得够多）。这是最强的意图：
 *      "这公式属于这一节"。
 *   ② 重叠 —— 框搭在一起。算相关，父节点给先画的那张（稳定，不会因为拖动而翻来覆去）。
 *   ③ 挨着 —— 框之间空着但在 NEAR_GAP 以内。手画的人就是这样表达的：
 *      写个名字，旁边写公式，中间不连线。
 *   ④ 都没有 —— 孤岛。**孤岛不是错误**，是"这块我还没想清楚它跟谁有关"，
 *      正是最值得停一下的地方（沿用旧版的这个说法）。
 *
 * 为什么不用"你必须在中间画一条线"：那又变成要你学一套规矩了。
 * 位置本身就是关系，这也是白板比大纲强的地方。
 */
export function buildRelations(board) {
  const cards = (board && board.cards) || []
  const boxes = cards.map((c) => ({ id: c.id, r: cardBounds(c), area: c.w * c.h, seq: cards.indexOf(c) }))
  const edges = []
  const parentOf = new Map()
  const children = new Map()

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i]
      const B = boxes[j]
      const d = rectDist(A.r, B.r)
      const overlap = rectsOverlap(A.r, B.r)
      if (!overlap && d > NEAR_GAP) continue

      let kind = overlap ? 'overlap' : 'near'
      let parent = null
      let child = null
      if (overlap) {
        const big = A.area >= B.area ? A : B
        const small = A.area >= B.area ? B : A
        if (big.area / Math.max(1, small.area) >= CONTAIN_RATIO) {
          kind = 'contain'
          parent = big.id
          child = small.id
        } else {
          // 差不多大又叠着：算相关；父节点给先画的，保证拖来拖去结果不变
          parent = A.seq < B.seq ? A.id : B.id
          child = parent === A.id ? B.id : A.id
        }
      } else {
        parent = A.seq < B.seq ? A.id : B.id
        child = parent === A.id ? B.id : A.id
      }
      edges.push({ a: A.id, b: B.id, kind, dist: Math.round(d * 10) / 10 })
      // 只记最强的那条父边：一张卡两个父，大纲就画不出来了
      if (!parentOf.has(child)) parentOf.set(child, parent)
      if (!children.has(parent)) children.set(parent, [])
      const list = children.get(parent)
      if (!list.includes(child)) list.push(child)
    }
  }

  const degree = new Map()
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) || 0) + 1)
    degree.set(e.b, (degree.get(e.b) || 0) + 1)
  }
  const orphans = cards.filter((c) => !degree.get(c.id)).map((c) => c.id)
  const hubs = [...degree.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 6)
    .map(([id]) => id)

  return { edges, parentOf, children, degree, orphans, hubs }
}

/* 一张卡的全部后代（含自己）。用来给"这一节"整体上色/整体挪动。 */
export function descendantsOf(relations, id) {
  const out = new Set([id])
  const walk = (cur) => {
    for (const k of relations.children.get(cur) || []) {
      if (out.has(k)) continue
      out.add(k)
      walk(k)
    }
  }
  walk(id)
  return out
}

/* 连线怎么画：从 A 中心到 B 中心，控制点按垂直方向推开一点，
   让它看起来像"一条弧"而不是生硬的直线。距离越远弧越平。 */
export function relationCurve(ra, rb, bow = 0.18) {
  const a = rectCenter(ra)
  const b = rectCenter(rb)
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const cx = mx - (dy / len) * len * bow
  const cy = my + (dx / len) * len * bow
  return { a, b, c: { x: cx, y: cy } }
}

/* 兜底视口：把所有内容都装进 screenW×screenH，四周留 pad。
   打开一个从没看过的大板时，不这么做就会"打开是一片空白"，
   用户以为内容丢了。

   ★ 缩放下限 READABLE_FIT_S = 0.55 —— 这是实测加的：
     在 758×426 的窗口里（笔记本分屏、或者浏览器窗口拖小了），
     "全部装进去"会算出 0.37 倍，卡片上的公式小到看不清。
     装不下就装不下，宁可让你**平移着看**，也不能把板缩成蚂蚁。
     （Ctrl+0 是"装回屏幕"，会走这里；想真的看到全部内容就用它，然后自己放大。） */
export const READABLE_FIT_S = 0.55
export function fitView(board, screenW, screenH, pad = 60) {
  const box = boundsOfAll(
    [...((board && board.strokes) || [])],
    strokeBounds
  )
  const cbox = boundsOfAll((board && board.cards) || [], cardBounds)
  const all = box && cbox ? unionRect(box, cbox) : box || cbox
  if (!all || all.w <= 0 || all.h <= 0) return { s: 1, tx: screenW / 2, ty: screenH / 2 }
  const raw = Math.min((screenW - pad * 2) / all.w, (screenH - pad * 2) / all.h)
  const s = clampViewScale(Math.max(READABLE_FIT_S, Math.min(raw, 2)))
  /* 把内容包围盒的中心摆进容器中心 —— 和"聚焦到一张卡"是同一件事，走同一个函数。 */
  return centerOn({ s, tx: 0, ty: 0 }, { x: all.x + all.w / 2, y: all.y + all.h / 2 }, screenW, screenH)
}

/* `inkedEdges(board)` 删掉了（2026-09-16）。它只是 `buildLinks` 的一行**薄壳**
 * （老接口，只要 a/b/strokeId），而 deletion test 的答案很清楚：删掉它，复杂度并没有
 * 散到调用方去 —— 关系面板要的那份"哪两张卡之间有笔迹"直接从 `links` 派生就行
 * （Board.jsx 早就是这么干的）。留着它只会多一个能绕过 `createLinkReader()` 的入口。 */

