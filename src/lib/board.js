/* 白板的数据模型：一张板长什么样、怎么读写、卡片多大。
 * （点 / 几何 / 「关系怎么算出来」搬去了 geometry.js —— 见那个文件的文件头。）
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

/* 关系的词表（LINK_KINDS / isLinkKind…）搬去了 link-kinds.js；
   连接那一族的实现搬去了 links.js；点 / 几何 / 关系搬去了 geometry.js；
   「板框 / 连接」这些**动作**在 frames.js。
   board.js 只剩**数据模型**：一张板长什么样、怎么读写、卡片多大。
   这里只用得到 geometry 的一件：**toFlat**（所有入口都把点收敛成扁平数组）。
   （视图映射在 view.js —— 那个现在由 geometry.js 的 fitView 用，这边用不着了：
     读盘时的缩放归一是本地那个 clampScale。） */
import { ARROW_LINK, COND_NONE, isLinkKind, parseCond } from './link-kinds.js'
import { normalizeShape, serializeShape, bakeShapePoints, normAngle } from './shape-object.js'
import { toFlat } from './geometry.js'
/* 只借一个"最后一截是什么" —— data/ 里的路径从 2026-09-17 起可以带层
   （`大物/电磁学/board-第一章.md`），拆路径这件事只在 paths.js 里有一份。 */
import { baseName } from './paths.js'

export const BOARD_VERSION = 4
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
     宽度那条线上直接表现为**内容被裁掉**（实测 `E = mc²` 少了 18px 的 `c²`）。
   ⚠ 2026-09-17 起卡片那一圈（styles.css 的 .bd-card）是 `outline`：它**不进布局**，
     所以调用方读到的 borderWidth 是 0、padPx 就是纯内边距。这条换算不跟着改（它要通用）——
     但谁把 border 加回来，就得知道"屏幕像素的边框 + 世界像素的宽度"这个组合本身就是错的：
     那正是「缩小画布时卡片底下一条恒粗黑线」的根子（见 styles.css 的 .bd-card 那段）。 */
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

let idSeq = 0

/* id 只需要在**一个文件内**唯一（关系图是本文件内算的）。
   故意带上时间戳：两个设备各画一块，Git 合并时不会撞 id。 */
export function newId(prefix = 'x') {
  idSeq += 1
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`
}

/* 板框的 id 前缀（`fr`）—— 只在这里定义一处：读盘补一个、新建一个，都得是同一个形状。
   卡片是 `f…`（formula）/ `n…`（note）、笔迹是 `s…`，所以 `fr` 一眼能认出来是框。 */
export const newFrameId = () => newId('fr')

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
    /* 板框（你框选之后亲手留下的一块，见 normalizeFrames）：成员是笔迹 + 卡片。
       以前这里叫 `groups`（"固定成一块"）—— 那是个没长脸的版本（不可见、不能装卡片），
       现在升成板框；老文件的 `groups` 在解析时就地升上来。 */
    frames: [],
    /* 连接（你宣告的那条关系，见 ADR-0001 与 normalizeLinks）：两端 + 一个词。
       形状/位置猜出来的连接**不存**，所以这个字段里只有你亲口说过的话。 */
    links: [],
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

/* ═══════════ 板框：你亲手留下的一块（`frames`） ═══════════
 *
 * 框选之后按「▣ 留下板框」，圈住的东西从**那一刻**起属于它（笔迹和卡片都算）。
 * 存的是**成员 id**，不是矩形 —— 框线按成员的包围盒现算（`geometry.js` 的 `frameBounds`），
 * 所以内容一挪，框自己跟着走；成员全没了，框自己消失。
 * ★ 为什么是成员、不是矩形：框必须是**内容的函数**。再存一份平行的 x/y/w/h 的话，
 *   内容一动框就飘，"形成一个整体"当场变假（ADR-0001 里被否掉的候选 5）。
 * ★ 为什么框不叫"卡片"：卡片的宽高是**按它的内容量出来的**（card-fit.js），
 *   框的尺寸是**成员包围盒**的函数 —— 两套尺寸语义混进一个名字里会互相推（候选 6）。
 *
 * 三条规矩（和从前那个 `groups` 一模一样，只是换了名字、长了外延）：
 *   ① 一个成员**最多属于一个框**（重复的、指向已经擦掉的 id 一律丢掉）；
 *   ② 成员全被擦光的框自己消失，不留空壳；
 *   ③ 只在真有板框时才写这个字段 —— 没框过的板一个字节都不多。
 * 老文件里的 `groups`（"固定成一块"）在解析时**就地升成板框**（没有标题、没有卡片成员），
 * 于是那个功能不是被删掉，而是长出了脸。
 *
 * 「留下板框 / 拆开 / 改标题 / 整体拖动」这些**动作**在 frames.js；
 * 这里只管**长什么样、怎么读写**（和 normalizeGroups 当年待在同一层）。 */
export function normalizeFrames(raw, { strokeIds, cardIds } = {}) {
  const liveS = strokeIds instanceof Set ? strokeIds : new Set()
  const liveC = cardIds instanceof Set ? cardIds : new Set()
  const out = []
  const usedS = new Set()
  const usedC = new Set()
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f !== 'object') continue
    const ids = (Array.isArray(f.ids) ? f.ids : []).filter((id) => typeof id === 'string' && liveS.has(id) && !usedS.has(id))
    const cards = (Array.isArray(f.cards) ? f.cards : []).filter((id) => typeof id === 'string' && liveC.has(id) && !usedC.has(id))
    if (!ids.length && !cards.length) continue
    for (const id of ids) usedS.add(id)
    for (const id of cards) usedC.add(id)
    out.push({
      id: typeof f.id === 'string' && f.id ? f.id : newFrameId(),
      /* 标题是给你自己看的（"这一节是什么"）。空标题**不写这个字段** ——
         没起过名字的框和没框过的板一样，不该多出字节。 */
      ...(typeof f.title === 'string' && f.title.trim() ? { title: f.title.trim() } : {}),
      ids,
      cards,
    })
  }
  return out
}

/* ═══════════ 连接：你宣告的那条关系（`links`） ═══════════
 *
 * 一条记录 = 两端 + 一个词（见 link-kinds.js 的 `LINK_KINDS`）。两端是**卡片或板框**的 id。
 * ★ `from` / `to` 是**有序**的：「因果」有方向，A→B 和 B→A 是两条不同的关系。
 * ★ 不存 id：一条记录的身份就是它的有序端点对（`linkId`），文件里少一个会撞、要维护的字段。
 * ★ 不存几何：屏幕上那条箭头是**合成**的（两端贴着框/卡的边，中间一条规整的线 + 一个尖）——
 *   框一动箭头跟着动，这才是"连接两个板块"。存一条手画的路径反而会把箭头钉死在原地。
 * ★ 条件记在**这条记录**上（宣告的连接没有"那一笔"可挂）：词表和笔迹上那个 `cond` 同一套。
 *
 * 三条规矩：
 *   ① 两端都得**还在板上**（卡删了、框散了 → 这条记录消失，不留尸体）；
 *   ② 自己连自己不算；同一个有序端点对只留一条（先写的赢）；
 *   ③ 认不出的词退回箭头工具的本意（`ARROW_LINK` = 「因果」），不猜成别的。 */
export const linkId = (from, to) => `${from}|${to}`

/* ═══════════ 端点（板上能当连接两端的东西）的**存活判据** ═══════════
 *
 * 一个 id 还活着 = 卡片里有 或 板框里有。**只在这一处实现**（2026-09-17 架构 review 候选 2）。
 *
 * 为什么值得单拎出来：这条纪律写在三个地方 —— 解析时过滤死 id（normalizeLinks）、
 * 写盘时再过滤一遍（serializeBoardDocument）、宣告时校验（frames.js 的 declareLink）。
 * 三处各写一遍，漏改一处不是崩溃而是**静默**：内存里画着、文件里没了（或反过来），
 * 而 ADR-0001 那条"死 id 不留尸体"的纪律会在**那一步**悄悄失效。
 *
 * 收成一个"给集合"的形状，是因为解析中途还没有一张完整的 board：
 *   const live = liveNodeIdFn(cardIdSet, frameIdSet)   →   live(id)
 * 有 board 的调用方用 liveNodesOf(board) 拿那个集合。
 */
export function liveNodeIdFn(cardIds, frameIds) {
  const cards = cardIds instanceof Set ? cardIds : new Set(cardIds || [])
  const frames = frameIds instanceof Set ? frameIds : new Set(frameIds || [])
  return (id) => cards.has(id) || frames.has(id)
}

/** 这张板上所有端点的 id（卡片 + 板框）。 */
export function liveNodesOf(board) {
  const ids = new Set()
  for (const c of (board && board.cards) || []) ids.add(c.id)
  for (const f of (board && board.frames) || []) ids.add(f.id)
  return ids
}

export function normalizeLinks(raw, { cardIds, frameIds } = {}) {
  const live = liveNodeIdFn(cardIds, frameIds)
  const out = []
  const seen = new Set()
  for (const l of Array.isArray(raw) ? raw : []) {
    if (!l || typeof l !== 'object') continue
    const from = typeof l.from === 'string' ? l.from : ''
    const to = typeof l.to === 'string' ? l.to : ''
    if (!live(from) || !live(to) || from === to) continue
    const key = linkId(from, to)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      from,
      to,
      kind: isLinkKind(l.kind) ? l.kind : ARROW_LINK,
      ...(parseCond(l.cond) ? { cond: l.cond } : {}),
    })
  }
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

/* 是不是一个**板文件名**。只看**最后一段**：`大物/电磁学/board-第一章.md` 也是一张板
 * （data/ 里可以分层了 —— 分层只改它存在哪，不改"什么算一张板"这条口径）。 */
export function isBoardName(name) {
  return new RegExp(`^${BOARD_PREFIX}.*\\.md$`, 'i').test(baseName(name))
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
  /* 板框（"这一坨就是我说的那一块"）：成员被擦掉的、重复的一律丢掉。
     必须**在 strokes / cards 之后**做 —— 要看得出哪些 id 还活着。
     ★ 老文件里的 `groups`（"固定成一块"）就地升成板框 —— 那个功能不是被删掉，是长出了脸
       （没标题、没卡片成员）。升完只认 `frames`：一块地方只留一份真相。 */
  b.frames = normalizeFrames(Array.isArray(raw.frames) ? raw.frames : raw.groups, {
    strokeIds: new Set(b.strokes.map((s) => s.id)),
    cardIds: new Set(b.cards.map((c) => c.id)),
  })
  /* 连接（见 ADR-0001）：两端必须**都还在板上** —— 卡删了、框散了，这条记录就作废。 */
  b.links = normalizeLinks(raw.links, {
    cardIds: new Set(b.cards.map((c) => c.id)),
    frameIds: new Set(b.frames.map((f) => f.id)),
  })
  /* 「条件就是这个」（`cond: 'card:x'` / `'ink:y'`）指的东西可能已经没了
     （卡删了、那笔擦了）—— 那句话作废，不留尸体（和板框同一条规矩）。
     笔迹上、连接记录上各有一处，用的是同一套判据。 */
  {
    const liveCards = new Set(b.cards.map((c) => c.id))
    const liveStrokes = new Set(b.strokes.map((s) => s.id))
    const aliveCond = (v) => {
      const spec = parseCond(v)
      if (!spec || spec.kind === 'none') return !!spec
      return spec.kind === 'card' ? liveCards.has(spec.id) : liveStrokes.has(spec.id)
    }
    b.strokes = b.strokes.map((s) => {
      if (!s.cond || aliveCond(s.cond)) return s
      const next = { ...s }
      delete next.cond
      return next
    })
    b.links = b.links.map((l) => {
      if (!l.cond || aliveCond(l.cond)) return l
      const next = { ...l }
      delete next.cond
      return next
    })
  }
  return b
}

const clampScale = (s) => (Number.isFinite(s) && s > 0.05 && s < 20 ? s : 0)

function normalizeStroke(s) {
  if (!s || typeof s !== 'object') return null
  const pts = toFlat(s.points) // ★ 一律归成扁平数组，见下方说明
  if (!isStrokePointsOK(pts)) return null
  const tool = s.tool === 'highlighter' ? 'highlighter' : 'pen'
  /* ★★ 图形的身份：先归一化一次，**算出来的点才是真相**。
   *
   * 规矩（和 shape-object.js 文件头那条铁律是同一句）：**`shape` 和 `points`
   * 任何时候都必须对得上**。而"对得上"这件事不能靠"存的时候记得两边一起写"
   * ——那种纪律一定会漏（手改文件、旧版本、哪天多一条写入路径都会漏）。
   * 所以在**读盘这一步**就把不变量立起来：有 `shape` 就按它重烤一遍点。
   *
   * ⚠ 为什么要重烤而不是"信文件里那些点"：一个图形的位置/大小/旋转**只有
   *   `shape` 说了算**（那是它的全部参数）。文件里那份 points 是**导出物**，
   *   就像板框的框线是成员的函数一样 —— 两份都当真，就会出现
   *   "拖一下手柄，图形跳回文件里那个旧位置"这种一次性的错位。
   * ⚠ 重烤的代价是"手改文件里的 points 对图形不起作用了"（改 shape 才有效）——
   *   这是**要的**：手改一堆 72 个点去挪一个圆本来就没人做得到。 */
  const shape = normalizeShape(s.shape)
  const baked = shape ? bakeShapePoints(shape) : null
  const finalPts = baked && baked.length >= 6 ? baked : pts
  if (!isStrokePointsOK(finalPts)) return null
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
    /* 连线的词（见 link-kinds.js 的 LINK_KINDS）。
       ★ 认不出的值一律**丢掉**（不退回默认再写回去）—— 手改文件写个 "因果"、
         "Cause"、或者别的版本的 id，都不该让这一笔变成"手动标过 rel"。
       ★ 而且这里**不补默认值**：绝大多数笔迹没有这个字段（也永远不该有），
         补一个 `link: 'rel'` 出去就等于给整本板子造一次假 diff。 */
    ...(isLinkKind(s.link) ? { link: s.link } : {}),
    /* 条件那一族（见 link-kinds.js 的 parseCond）：`'none'`（这个条件不算）/
       `'card:<id>'` / `'ink:<id>'`（条件就是它）。位置送的条件本身**不存盘**
       （随时能重算），只有你亲口说的那三种值才写。
       ★ 规矩和上面 link 那条一样：**形状不认的一律丢掉**（手改文件写个 "yes" 不该
         变成一个说法）、**不补默认值**（没说过这句话的板一个字节都不多）。
       ★ 指的东西后来没了 → 这个字段在解析的最后一步被清掉（那里看得到所有 id）。 */
    ...(parseCond(s.cond) ? { cond: s.cond } : {}),
    /* 「这一笔是个**图形**」（规整过的圆/矩形/三角形/直线，见 shape-object.js）。
       ★ 它和 link / cond 是同一条纪律，一个字都不改：
         · **形状不认的一律丢掉**（`normalizeShape` 就是那道闸 —— 手改文件写个
           `{k:"star"}`、或者写了个半截的 `{k:"rect",cx:12}`，都不该变成一个图形）；
         · **不补默认值**（没规整过的笔一个字节都不多，老文件在 Git 里纹丝不动）。
       ★ 为什么它必须**存**（而不是像"关系"那样每次现算）：规整完的笔迹在文件里
         和一条普通笔迹长得一模一样（就是一堆点），现算是**算不回来**的 ——
         打开时没有任何线索说明"这是个圆"，于是手柄、缩放、旋转全没了。
         `check-shape` 的 [10] 钉着这一条（重开之后手柄还在）。 */
    ...(shape ? { shape } : {}),
    points: finalPts,
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
    /* 旋转（弧度，绕卡片自己的中心）。默认 0 = 没转过。
       ★ 归一化用的是 shape-object.js 的 `normAngle`（全仓库只有那一份）：把角度归到
         (−π, π] 并清掉浮点噪声与 `-0` —— 不然"转一圈回来"会在文件里留一个 `rot: 1e-17`。
       ★ 认不出的值（NaN / 字符串 / null）一律当 0：这里退的不是"默认样式"，
         而是一个会让卡片整个歪掉的变换，挡在这一层最省事（和 scale 同一条理由）。 */
    rot: normAngle(c.rot),
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
  /* ★ 先算出"这次真的会写进文件的笔"：后面板框的"哪一笔还活着"必须看**这一批**，
     不是内存里那一批 —— 两批不一样时（内存里有一笔写不出去的垃圾笔迹），
     板框会引用一个文件里根本没有的 id，读回来时又被 normalizeFrames 丢掉，
     于是"存→读→再存"不再一致（模糊测试在旧的 groups 上逮到的就是这一条）。 */
  const kept = (board.strokes || [])
    /* ★ 出关也要过"这一笔能不能进文件"那道闸（`isStrokePointsOK`）——
       写得出去、读不回来的东西一个都不留。判据和 normalizeStroke 是同一份。 */
    .map((s) => ({ s, flat: toFlat(s.points) }))
    .filter((it) => isStrokePointsOK(it.flat))
  const strokeIds = new Set(kept.map((it) => it.s.id))
  const liveCards = new Set((board.cards || []).map((c) => c.id))
  /* 条件那一族（`'none'` / `'card:<id>'` / `'ink:<id>'`）：只有形状认得出、
     而且指的东西**还在这一批要写出去的东西里**才写 —— 死 id 不留尸体（和板框同一条规矩）。 */
  const condToWrite = (v) => {
    const spec = parseCond(v)
    if (!spec) return null
    if (spec.kind === 'none') return COND_NONE
    if (spec.kind === 'card') return liveCards.has(spec.id) ? v : null
    return strokeIds.has(spec.id) ? v : null
  }
  const strokes = kept
    .map(({ s, flat }) => ({
      id: s.id,
      tool: s.tool,
      color: s.color,
      width: round(s.width, 1),
      pressure: s.pressure !== false,
      /* 连线的词：**只有你手动点过那排词才写**。
         没点过的连接按最弱那一档读（「相关」，见 DEFAULT_LINK），不写字节日志 ——
         老文件、没改过的文件在 Git 里纹丝不动。 */
      ...(isLinkKind(s.link) ? { link: s.link } : {}),
      /* 条件那一族同理，只在你说过时才写；**指的东西还在**才写（死 id 不留尸体 ——
         和板框一样。判据必须按"这一批真会写出去的卡/笔"算，和上面那段同一个道理）。 */
      ...(condToWrite(s.cond) ? { cond: condToWrite(s.cond) } : {}),
      /* 图形的身份（见 normalizeStroke 里那一段）。**只在真有时写** ——
         没规整过的板一个字节都不多；写的是短字段版（`serializeShape`），
         而且它自己也会过一遍 `normalizeShape`（出关和进关同一个出口）。 */
      ...(serializeShape(s.shape) ? { shape: serializeShape(s.shape) } : {}),
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
      /* ★ 旋转（`rot`，弧度）：和 `scale` 同一条纪律 —— **只在真转过时才写**。
         没转过 = 0 = 不写，老文件一个字节都不动；`-0` / 1e-17 那种浮点噪声
         由 normAngle 清掉（它连"转一圈回来"的 1e-17 都归零，见 [6] 的往返断言）。
         ⚠ 写出去的就是 `normAngle` 的那个数（9 位小数量化）—— 出关和进关同一个规范形，
           所以"打开 → 存回"逐字节一致，不会每次开板都留一条假 diff。 */
      ...(normAngle(c.rot) ? { rot: normAngle(c.rot) } : {}),
      /* 固定（钉住）也只在**真的固定**时才写。默认不固定 = 不写这个字段，
         理由同上：老文件不该因为我们加了个功能就在 Git 里整块变脏。
         （"不固定"是绝大多数卡片的状态，写 `locked: false` 出去就是纯噪音。） */
      ...(c.locked === true ? { locked: true } : {}),
    })),
    /* 板框（见 normalizeFrames）：**只在真有框时才写** —— 老文件、没框过的板一个字节都不多。
       写之前把"已经不在板上的成员"滤掉（这个会话里刚擦掉的那些）：文件里不留尸体。
       判据必须按"这一批真会写出去的笔"算（`kept`），不是内存里那一批 —— 两边不一样时
       框会引用一个文件里根本没有的 id，读回来又被丢掉，"存→读→再存"就不一致了
       （模糊测试当年在 groups 上逮到的就是这一条）。
       为了让老文件的 diff 最小，它们排在最后（新字段追加在尾部）。 */
    ...(() => {
      const liveS = new Set(strokes.map((s) => s.id))
      const liveC = new Set((board.cards || []).map((c) => c.id))
      const takenS = new Set()
      const takenC = new Set()
      const fs = []
      for (const f of board.frames || []) {
        /* ★ 顺手去重：一个成员只能属于一个框（先写的那个赢）—— 和读盘时的
           normalizeFrames 同一套规矩。frames.js 的动作已经不会造出重叠了，
           但"内存里的状态"和"文件里的状态"必须是同一个，不然读回来会悄悄变一个样。 */
        const ids = (f.ids || []).filter((id) => liveS.has(id) && !takenS.has(id))
        const cards = (f.cards || []).filter((id) => liveC.has(id) && !takenC.has(id))
        if (!ids.length && !cards.length) continue
        for (const id of ids) takenS.add(id)
        for (const id of cards) takenC.add(id)
        fs.push({
          id: f.id,
          ...(f.title ? { title: f.title } : {}),
          ids,
          ...(cards.length ? { cards } : {}),
        })
      }
      return fs.length ? { frames: fs } : {}
    })(),
    /* 连接（见 ADR-0001 与 normalizeLinks）：只有你宣告过才有这个字段；
       两端**都还在这一批要写出去的东西里**才写 —— 死 id 不留尸体（和板框同一条规矩）。 */
    ...(() => {
      /* 和解析那一趟**同一个**存活判据（liveNodeIdFn）—— 三处各写一遍就是静默失效的入口。 */
      const live = liveNodeIdFn(new Set((board.cards || []).map((c) => c.id)), new Set((board.frames || []).map((f) => f.id)))
      const seen = new Set()
      const ls = []
      for (const l of board.links || []) {
        if (!l || !live(l.from) || !live(l.to) || l.from === l.to) continue
        const key = linkId(l.from, l.to)
        if (seen.has(key)) continue
        seen.add(key)
        ls.push({
          from: l.from,
          to: l.to,
          kind: isLinkKind(l.kind) ? l.kind : ARROW_LINK,
          ...(condToWrite(l.cond) ? { cond: condToWrite(l.cond) } : {}),
        })
      }
      return ls.length ? { links: ls } : {}
    })(),
  }
  return JSON.stringify(out, null, 1) + '\n'
}

function round(n, digits) {
  const f = 10 ** digits
  return Math.round((Number(n) || 0) * f) / f
}
