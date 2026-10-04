/* 「框选追问」：你在课件上圈住的那一块，**落在哪一页、页内什么位置**。
 *
 * ── 它在整条链路里的位置 ─────────────────────────────────────────────────
 *   你在课件页上框住一块（推出来的：`frameBounds` 是纯函数，见 geometry.js）
 *     → **这个文件**：读出"那是第几页、页内的哪个矩形"（纯函数，node 里断言得住）
 *     → doc-pages.js 画两张图（整页 + 红框 / 框里那一块放大）
 *     → server-ocr.js 的 mode:'ask'（带上一轮对话）
 *     → 页边那个问答小窗（AskBox.jsx，**不碰板**）
 *
 * ── 为什么这一层要单独存在 ───────────────────────────────────────────────
 * "这一块在哪一页"是**几何**，而它一旦算错，错法是安静的：
 *   页号错一页 → 模型拿着别的页回答，而且答得头头是道（用户看不出来）；
 *   矩形算错 → 红框画在图上别的地方，模型照着你**没圈**的地方讲。
 *   两种都不会报错。所以规矩收在这一个文件里，`check:ask` 在 node 里钉住它。
 *
 * ── 一条口径 ─────────────────────────────────────────────────────────────
 * 世界坐标的框 → 页内归一化矩形（0~1）。**页面矩形只有一份定义**
 * （docs.js 的 `pageRects`：x/y/w/pages/pageGaps 的函数），这里只消费它，
 * 自己绝不再算第二份 —— 两份各算一遍的账，这个仓库记了十几条。
 */
import { isDocPath, pageRects } from './docs.js'
/* 卡片占哪块地：**只有 geometry.js 那一份**（含倍率和旋转）。
   "圈住这张卡没有"和"这两样东西挨着不挨着"必须是同一个答案。 */
import { cardBounds } from './geometry.js'

/* 圈住的部分小到什么程度就算"什么都没圈"（世界像素）。
 * ★ 必须有：框选的判据是"碰着就算"，所以**点一下页面**也是一个零宽零高的框 ——
 *   拿它去问"这一页为什么"会得到一张只有一个点的裁图（模型看不见任何东西）。
 *   5 世界像素 ≈ 屏幕上 6px（缩放 1.25），比一个句号还小。 */
export const ASK_MIN_SPAN = 5

/* 页内归一化的**比例**门槛："小到什么程度就当没有"（0.005 ≈ 默认页宽 720 上的 3.6 像素）。
 * ★ 这一族只有这一个数 —— 圈出来的那一块（`findAskRegion`）和从板文件里读回来
 *   的那一份（`normalizeAsk`）用**同一个**：两份门槛的话，"存得出去、读不回来"
 *   或者反过来，而往返不一致正是这个仓库最忌讳的那类静默错。 */
export const ASK_MIN_FRAC = 0.005

/* 边界容差：圈到页面**外面**一点（压着页码、压着页边的公式）不算"不在这一页"。
 * 圈出去的部分会被夹回页内（模型看到的裁图就是页内那一块），
 * 但**中心落在页内**就够了 —— 不然"想把页边那一行连同外面的标注一起圈住"会直接失败。 */
export const ASK_EDGE_SLACK = 12

/* 圈住**一张卡**至少要压住它这么多（占框自己面积的比例）才算"我圈的就是这张卡"。
 * ★ 为什么要有：框选是个矩形，扫过卡片一角也算压着 —— 而那通常是"想圈页面、顺手扫到了
 *   旁边的讲解卡"，不是"我要问这张卡"。0.34 取自页面那一趟的同一个数（35%）。 */
export const ASK_CARD_MIN_COVER = 0.34

/* 圈在**页面上**至少要压住这么多（占框自己面积的比例）—— 只在"框的中心不在页内"时判。
 * ★ 为什么要有：覆盖率（`coverage`）的分母是"所有**页面**上的落点"，框压在旁边的
 *   讲解卡上那部分根本不算进去。于是"97% 在卡上、3% 蹭着页面一条边"的框在那一趟里
 *   是"100% 都在这一页" → 裁出来的是页面边上一条几像素宽的窄条，而模型照着它编
 *   （diag:askcard 量到过：圈住讲解卡 → 问的是"第 2 页右边 6 像素宽的一条边"）。
 * ⚠ 中心落在页内时不判（"只圈到页边那一角"是正经用法，见 A4）。 */
export const ASK_PAGE_MIN_COVER = 0.05

/** 读一个坐标：**认不出就是 NaN**，不要 `|| 0`。
 *  ⚠ 这里不能兜底成 0：`{x0: undefined, y0: undefined}` 兜成 `{0,0}` 之后，
 *    一个空框会变成一个"落在原点、宽高为 0"的合法框，然后一路走到裁图那一步
 *    （裁出一张 0×0 的图，而模型照着它编）。NaN 会老老实实被下面的判据挡掉。 */
const num = (v) => (v == null || v === '' ? NaN : Number(v))

/** 把 `{x0,y0,x1,y1}` 规范化（x0<x1、y0<y1；反着拖也是同一个框）。四个数都得成立。 */
export function normBox(box) {
  if (!box) return null
  const x0 = num(box.x0)
  const y0 = num(box.y0)
  const x1 = num(box.x1)
  const y1 = num(box.y1)
  if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) return null
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }
}

/** 一个框和一张页面矩形的**重叠面积**（没重叠 = 0）。 */
export function overlapArea(box, rect) {
  if (!box || !rect) return 0
  const w = Math.min(box.x1, rect.x + rect.w) - Math.max(box.x0, rect.x)
  const h = Math.min(box.y1, rect.y + rect.h) - Math.max(box.y0, rect.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** 世界矩形 → 这一页的**页内归一化坐标**（0~1，左上角是原点）。
 *  ★ 为什么归一化而不是存像素：PDF 的页面尺寸（点数）和板上的世界宽度是两套单位，
 *    而"这一块在页面的哪个位置"是**与尺寸无关**的一件事 —— 归一化之后
 *    换多少 zoom、板上的资料拖到哪儿、以后按别的像素宽渲染，那个框都还在原地。 */
export function regionInPage(box, rect) {
  const b = normBox(box)
  if (!b || !rect || !(rect.w > 0) || !(rect.h > 0)) return null
  return {
    x: (b.x0 - rect.x) / rect.w,
    y: (b.y0 - rect.y) / rect.h,
    w: (b.x1 - b.x0) / rect.w,
    h: (b.y1 - b.y0) / rect.h,
  }
}

/** 页内归一化矩形 → 这一页上的世界矩形（`regionInPage` 的逆运算，画红框时用）。
 *  夹进页内：圈出去的那一点不该在图上画到页面外面去。
 *  ⚠ 四个数里有认不出的（NaN / undefined）就返回 **null** —— 不返回一个 NaN 的框。
 *    2026-09-22 就是这么栽的：卡片上那个 `region` 有一阵是**数组**形式，
 *    而这里读的是 `.x/.y` → 全 NaN → 屏幕上那一圈高亮缩成一个 4×4 的小点，
 *    而**一句报错都没有**（`Math.min(1, Math.max(0, NaN))` 还是 NaN，DOM 照画不误）。
 *    现在内存里只允许一种形状（`{x,y,w,h}`，见 `normalizeAsk`）。 */
export function regionToWorld(region, rect) {
  if (!region || !rect) return null
  const nums = [region.x, region.y, region.w, region.h].map((v) => num(v))
  if (!nums.every((n) => Number.isFinite(n))) return null
  const cx = (v) => Math.min(1, Math.max(0, num(v)))
  const x = cx(region.x)
  const y = cx(region.y)
  const w = Math.min(1 - x, Math.max(0, num(region.w)))
  const h = Math.min(1 - y, Math.max(0, num(region.h)))
  return { x0: rect.x + x * rect.w, y0: rect.y + y * rect.h, x1: rect.x + (x + w) * rect.w, y1: rect.y + (y + h) * rect.h }
}

/** 卡片上那份"它讲的是第几页"（`ask`） —— 认不出就是 null，不硬凑。
 *  ★ 为什么卡片要带这个：课件整理落下来的**讲解卡**摆在页面**旁边**（右栏，见
 *    doc-cards.js 的 sideColumns），它不在页面上 —— 圈住它的时候下面那一趟几何
 *    必然算不出页号。而"这张卡讲的是第几页"是卡片出生时就知道的事实。 */
export const askOfCard = (c) => (c && typeof c === 'object' ? normalizeAsk(c.ask) : null)

/** 卡片的 `ask.doc`（资料路径）→ 板上那一份资料。
 *  ⚠ **没有路径、而板上只有一份资料**时才猜它 —— 从前的老卡没写 `doc`（那时只有一份
 *    课件的情形），不猜的话它们会集体变成"问不出来"。给了路径就必须对上：
 *    猜错一份资料 = 模型拿着别的课件回答，而且答得头头是道（这一族最忌讳的静默错）。 */
export function docForPath(docs, path) {
  const list = docs || []
  if (!list.length) return null
  if (path) {
    const hit = list.find((x) => x && x.path === path)
    return hit || null
  }
  return list.length === 1 ? list[0] : null
}

/** 一张卡占的地（`{x,y,w,h}`，世界坐标）。认不出 / 零面积 = null。 */
const cardRect = (c) => {
  const r = cardBounds(c)
  if (!r || !(r.w > 0) || !(r.h > 0)) return null
  return { x: r.x, y: r.y, w: r.w, h: r.h }
}

/**
 * 这一块（世界坐标的框）落在哪一页上。
 *
 * 三趟，顺序就是优先级：
 *   ⓪ 框的**中心**落在一张知道页码的卡上 → 问那张卡在讲的那一页（整页，或它记的那一块）；
 *   ① 框压在课件页面上 → 问的就是那一块（页内矩形 = 你圈的那个位置）；
 *   ② 上面两条都不成立、但框压住了某张卡 → 问那张卡在讲的那一页。
 *   ★ ⓪ 为什么在页面之前：见函数里那段（只蹭着页面一条边会裁出一条窄条）。
 *
 * @param {object} arg
 *   · box   `{x0,y0,x1,y1}` —— 你圈住的那一块（世界坐标）
 *   · docs  板上的资料（`board.docs`）
 *   · cards 板上的卡片（`board.cards`）—— 只走第 ② 条路，页内那一趟用不着
 *   · rectsOf(doc) → [{x,y,w,h}] —— 可注入的页面矩形（默认 docs.js 的 pageRects）。
 *           自检靠它钉住那几条分支；调用方**不该**传别的实现（两份矩形口径 = 静默错位）。
 * @returns {{doc, page, rect, box, region, coverage, clamped, cardId?, fromCard?} | null}
 *   `page`     页号（1 起）
 *   `region`   页内归一化矩形（0~1）
 *   `coverage` 你圈的那一块有多大比例落在这一页上（0~1）—— 跨了两页时它决定选谁
 *   `clamped`  圈出去过（区域被夹回页内）
 *   `cardId`   第 ② 条路才有的：靠哪张卡认出的这一页（`fromCard: true`）
 *   null = 认不出在讲哪一页（没课件 / 圈到页面之间的缝里 / 框太小）
 */
export function findAskRegion({ box, docs = [], cards = [], rectsOf = pageRects, minSpan = ASK_MIN_SPAN, slack = ASK_EDGE_SLACK } = {}) {
  const b = normBox(box)
  if (!b) return null
  /* 太小的框不算 —— 判据和框选那边一致的思路：点一下不该被当成"我圈了东西"。
     ⚠ 容差是 `minSpan - 1e-3` 而不是 `minSpan`：框选的坐标是**一位小数**量化的
     （`selection.js` 的 q1），"正好 5 像素"那个框在浮点里可能是 4.999999999 ——
     拿它跟 5 比就成了"点得刚刚好反而不算"（自检 A6 当场抓到的）。
     1e-3 比 q1 的量化步长（0.1）小两个数量级，所以它只吃掉浮点噪声，
     不会把"真的只有 4.9 像素的框"放进来。 */
  if (b.x1 - b.x0 < minSpan - 1e-3 || b.y1 - b.y0 < minSpan - 1e-3) return null
  const area = (b.x1 - b.x0) * (b.y1 - b.y0)
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  if (!(area > 0)) return null

  /* ══ 卡片那一趟：圈住的是**卡片**（讲解卡 / 答案卡都在页面**旁边**）════════
   * ★ 用户 2026-09-22：「问这里依旧无法框选 ppt 与解说卡片」。
   *   课件整理落下来的讲解卡摆在页面右栏（doc-cards.js 的 sideColumns），它压根不压在
   *   页面上 —— 光靠下面那趟几何认不出页号，按钮就永远灰着（用户看到的就是"圈了卡片，
   *   问这里不理我"）。所以：圈住一张**知道自己讲的是第几页**的卡 = 圈住它在讲的那一页。
   *   ⚠ `needCenter` = 只要"框的**中心**落在这张卡上"的那种（见下面 ① 那条理由）。 */
  const pickCard = (needCenter) => {
    let out = null
    for (const c of cards || []) {
      const a = askOfCard(c)
      if (!a) continue
      const r = cardRect(c)
      if (!r) continue
      const hit = overlapArea(b, r)
      if (!(hit > 0)) continue
      const inside = cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h
      /* 和页面那一趟同一个形状的两条判据：中心落在卡上，或者压住卡相当一部分。 */
      if (needCenter ? !inside : !inside && hit < area * ASK_CARD_MIN_COVER) continue
      if (!out || hit > out.hit) out = { card: c, ask: a, hit }
    }
    return out
  }
  /** 由一张卡造出结果（**只有这一处**）。认不出（资料不在板上 / 页号越界）→ null。 */
  const fromCard = (pick) => {
    if (!pick) return null
    const doc = docForPath(docs, pick.ask.doc)
    if (!doc) return null
    const rect = (rectsOf(doc) || [])[pick.ask.page - 1]
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null
    /* 页内那一块：**卡上记着的**那一份（「留到板上」留下的卡有），没有就整页 ——
       讲解卡是"讲这一页"，它没有被圈过哪一块，那就问整页。 */
    const region = normalizeRegion(pick.ask.region || { x: 0, y: 0, w: 1, h: 1 }, { minFrac: ASK_MIN_FRAC })
    if (!region) return null
    return { doc, page: pick.ask.page, rect, box: b, region, coverage: 1, clamped: false, cardId: pick.card.id, fromCard: true }
  }
  const cardHit = () => fromCard(pickCard(false))

  /* ① ★ 框的**中心**落在某张卡上 → **那张卡说了算**，在页面那一趟之前就返回。
     ⚠ 顺序不能倒：只蹭着页面一条边的框在那一趟里也算"命中"（覆盖率的分母只有页面，
        框压在旁边的讲解卡上那部分根本不算进去），于是裁出来的是页面边上**一条几像素宽
        的窄条** —— 模型照着它编，而用户以为自己问的是整页（探针 diag:askcard 当场量到的：
        圈住讲解卡 → 问的是"第 2 页右边一条 6 像素宽的边"）。中心落在卡上说明
        "我圈的就是这张卡"，那就问它在讲的那一页。 */
  const centered = fromCard(pickCard(true))
  if (centered) return centered

  /* ══ 第一趟：这个框在每一页上压了多少 ══
   * ★ 为什么要先算一遍"所有页"：两块地的比例必须拿**总重叠面积**当分母，
   *   不能拿框自己的面积 —— 框跨在两页之间的那道缝上时，缝既不属于这一页也不属于
   *   那一页，算进去会让"两边各压一半"变成"两边各 46%"（自检 A3 就是这么抓到的）。 */
  const lands = []
  let union = 0
  for (const doc of docs || []) {
    if (!doc) continue
    const rects = rectsOf(doc) || []
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i]
      if (!r || !(r.w > 0) || !(r.h > 0)) continue
      const hit = overlapArea(b, r)
      if (!(hit > 0)) continue
      /* 圈出去一点也算（见 ASK_EDGE_SLACK）：判据是"**框的中心**落在这一页上"，
         或者"相当一部分框压在这一页上"。两个条件各自成立就够 ——
         前者管"只圈到页边那一角"，后者管"框很大、跨着两页但主要在左边那页"。
         ⚠ 容差只在**框确实压到了这一页**的时候才算（上面那道闸已经保证了）：
           不然一个正好圈在两页之间那道缝里的框会两边都"中心在页内"，
           于是它拿一个空框去问（自检 A5 抓到的就是这个）。 */
      const inside = cx >= r.x - slack && cx <= r.x + r.w + slack && cy >= r.y - slack && cy <= r.y + r.h + slack
      lands.push({ doc, page: i + 1, rect: r, hit, inside })
      union += hit
    }
  }
  if (!lands.length || !(union > 0)) return cardHit()

  /* ══ 第二趟：选哪一页 ══
   * ① 中心落在页面上的（含容差）**优先** —— 那是"我圈的就是这一页"；
   * ② 都没有就选压得最多的那一页（手滑扫到下一页时，压得多的才是本意）；
   * ③ 两块地一样多时选靠前的那一页（先写的先赢，可预测）。 */
  const at = (l) => l.hit / union
  /* 占**框自己**多大一块（和 `at` 不是一回事：`at` 的分母只有页面）。 */
  const ofBox = (l) => l.hit / area
  let best = null
  for (const l of lands) {
    /* ⚠ "中心在页内"之外的那条路（光凭覆盖率）**还**要求真的压住页面相当一块 ——
       见 ASK_PAGE_MIN_COVER：不然一条边就算"整块都在这一页"。 */
    const good = l.inside || (at(l) >= 0.35 && ofBox(l) >= ASK_PAGE_MIN_COVER)
    if (!good) continue
    if (!best) {
      best = l
      continue
    }
    const better =
      (l.inside && !best.inside) ||
      (l.inside === best.inside && at(l) > at(best) + 1e-9)
    if (better) best = l
  }
  if (!best) return cardHit()

  const region = regionInPage(b, best.rect)
  if (!region || !(region.w > 0) || !(region.h > 0)) return cardHit()
  /* 夹回页内（圈出去的那一点不在图上画、也不裁）—— **夹之前**先记下越没越界，
     界面拿 `clamped` 说一句"圈到页面外面了，按页内的那一块问"。 */
  const eps = 1e-6
  const clamped = region.x < -eps || region.y < -eps || region.x + region.w > 1 + eps || region.y + region.h > 1 + eps
  const clean = normalizeRegion(region, { minFrac: ASK_MIN_FRAC })
  if (!clean) return cardHit()
  return { doc: best.doc, page: best.page, rect: best.rect, box: b, region: clean, coverage: at(best), clamped }
}

/** 归一化矩形（可能是 JSON 里读回来的、0~1 之外的怪值）→ 干净的那一份。
 *
 *  `minFrac` 是"小到什么程度就当没有"的门槛，默认 0.03（3%）**只有一个调用方用**：
 *  手写的、外来的那一份（自己拼一个 `{x,y,w,h}` 递进来）。这一族自己的两条路 ——
 *  圈出来的那一块、从板文件读回来的那一份 —— 都显式给 `ASK_MIN_FRAC`（0.005）。
 *  ★ 为什么"从文件读回来"不该用 3%（这里原来写的是 3%，理由是"手改文件写了个 1% 的框，
 *    裁出来只有几个像素，模型看不见任何东西却会照着自己编"）：
 *    那个危险属于**问出去**的那一趟（框会被裁成图发给模型）。而卡片上那个 `ask.region`
 *    只用来在屏幕上画一圈高亮 —— 框小就是圈小，**没有任何东西被裁出去**。
 *    拿 3% 去卡它，代价是"圈一个小符号问出来的那张卡，重开板之后 ◎ 就没了"，
 *    而且顺手破坏了往返一致（写出去 2% 的框，读回来被丢掉 = 存→读→再存 变了）。
 *  共同的那条规矩不变：**认不出的丢掉，不硬凑**（越界的夹住，读不出的丢掉）。 */
export function normalizeRegion(raw, { minFrac = 0.03 } = {}) {
  if (raw == null) return null
  /* 数组形式也认（`[x, y, w, h]`）—— 以后要把它写进板文件的话少一层括号。 */
  const v = Array.isArray(raw)
    ? { x: raw[0], y: raw[1], w: raw[2], h: raw[3] }
    : typeof raw === 'object'
      ? raw
      : null
  if (!v) return null
  const nums = [v.x, v.y, v.w, v.h].map((n) => Number(n))
  if (!nums.every((n) => Number.isFinite(n))) return null
  const [x, y, w, h] = nums
  const cl = (n) => Math.min(1, Math.max(0, n))
  const out = { x: cl(x), y: cl(y), w: Math.min(1 - cl(x), Math.max(0, w)), h: Math.min(1 - cl(y), Math.max(0, h)) }
  /* 零宽/零高的框没有意义（裁出来是一条线）—— `minFrac` 是"至少看得见一点东西"
     的下限，两个调用方各给一个数（见文件头那段）。 */
  const lo = Math.min(1, Math.max(0.001, Number(minFrac) || 0.03))
  if (out.w < lo || out.h < lo) return null
  return out
}

/** 这一页上"圈住的是哪一块"给人看的说法（小窗标题、提示语里用）。
 *  ⚠ 报的是**位置**（左/中/右 + 上/中/下），不报字号、不猜内容 ——
 *    猜内容会猜错（这时候还没问模型），而位置是算得出来的事实。 */
export function regionLabel(region) {
  const r = normalizeRegion(region)
  if (!r) return ''
  const mid = (a, b) => a + b / 2
  const mx = mid(r.x, r.w)
  const my = mid(r.y, r.h)
  const col = mx < 1 / 3 ? '左' : mx > 2 / 3 ? '右' : '中'
  const row = my < 1 / 3 ? '上' : my > 2 / 3 ? '下' : '中'
  /* ★ 正中间写成"正中间"，不写"中中间"（第一版就是这么拼出来的，
     读起来像结巴）。别的组合照常拼：上左、下右、上中…… */
  if (col === '中' && row === '中') return '正中间那一块'
  if (col === '中') return row + '边那一块'
  if (row === '中') return col + '边那一块'
  return row + col + '那一块'
}

/* ══════════════════ 这个事实**存进板文件**时长什么样（卡片的 `ask`）══════════════════
 *
 * 「留到板上」那条路（ADR-0006）把一轮问答落成一张卡，卡上要记着
 * **"我当时圈的是哪一块"** —— 不记的话，一周后回来只看到页边一张卡片，
 * 不知道它讲的是页面上的哪个符号。记的就是这个文件一直在算的那件事：
 * 哪一份课件、第几页、页内哪个矩形。
 *
 * ── 三条规矩 ────────────────────────────────────────────────────────────
 * ① **`page` 是必要条件**（1 起）：连第几页都说不出，这个字段就没有意义 ——
 *    整个丢掉，不是写半个空壳出去；
 * ② `doc` / `region` 认不出就**不写那个键**（`doc` 必须是合法的资料路径，
 *    `region` 走 `normalizeRegion`）—— 和 `locked` / `rich` 同一条：
 *    认不出的东西不硬凑，也不留尸体；
 * ③ **进关和出关同一个规范形**：`serializeAsk(x)` 出来的东西，`normalizeAsk`
 *    读回去必须一模一样（存→读→再存 字节一致）。所以出关那一步是
 *    "**先量化、再按读盘的规矩验一遍**"—— 写得出去、读不回来的东西一个都不留
 *    （和 `serializeBoardDocument` 里 `isStrokePointsOK` 那道闸同一个道理）。
 *
 * ⚠ `doc` 存的是**路径**不是资料的 id：id 是这次会话新造的，把资料从板上移掉、
 *   再插一次就换了；而路径是那个 PDF 文件的身份 —— 重开这张板、甚至换一台机器，
 *   它仍然指着同一份东西。找不到那份资料时的表现是界面说一句人话（见 ◎ 那颗按钮），
 *   不是这个字段自己消失。
 *
 * ⚠⚠ **内存里只有一种 region 形状：`{x, y, w, h}`**（和 `findAskRegion` 交出来的一样）。
 *   板文件里存的是**紧凑的数组** `[x,y,w,h]`（少一层括号），由 `serializeAsk` 转 ——
 *   但 `normalizeAsk` 交回来的**永远是对象**。
 *   2026-09-22 在这儿栽过一次：有一阵内存里留着数组，于是"点 ◎ 亮出那一块"那条路
 *   读 `region.x` 拿到 `undefined` → 一圈高亮缩成一个 4×4 的点，**而且不报错**
 *   （和 README 里 `strokesBBox` 那个 `{x0,y0,x1,y1}` vs `{x,y,w,h}` 是同一个形状的坑）。 */
export function normalizeAsk(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const page = Math.trunc(Number(raw.page))
  if (!Number.isFinite(page) || page < 1) return null
  const doc = isDocPath(raw.doc) ? String(raw.doc).trim() : ''
  const region = normalizeRegion(raw.region, { minFrac: ASK_MIN_FRAC })
  return {
    ...(doc ? { doc } : {}),
    page,
    ...(region ? { region } : {}),
  }
}

/** 出关：写进板文件的那一份。
 *  `region` 写成**数组** `[x,y,w,h]`（页内 0~1，4 位小数 —— 1e-4 页宽 ≈ 0.07 世界像素）。 */
export function serializeAsk(raw) {
  const a = normalizeAsk(raw)
  if (!a) return null
  const r4 = (n) => Math.round(n * 10000) / 10000
  /* 量化之后再验一次（规矩 ③）：量到最后一位可能把框顶出页外，那时读回来会被夹一下 ——
     夹过的那一份和写出去的那一份对不上。宁可**现在**就按夹完的写。 */
  const b = normalizeAsk({ ...a, ...(a.region ? { region: [a.region.x, a.region.y, a.region.w, a.region.h].map(r4) } : {}) })
  if (!b) return null
  return {
    ...(b.doc ? { doc: b.doc } : {}),
    page: b.page,
    ...(b.region ? { region: [b.region.x, b.region.y, b.region.w, b.region.h].map(r4) } : {}),
  }
}
