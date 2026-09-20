/* ═══════════ 行清单：板上有哪几行、每行在第几层（ADR-0004 第 4 步）═══════════
 *
 * 为什么要有它：识别那一趟（看图）只能"抄"，而"逻辑"（谁属于谁、谁推出谁）
 * 让视觉模型去猜是它最弱的一环。所以把**坐标**先在本地说清楚：
 * 一行一行编号、连同位置一起交给第二趟（纯文本），模型要说的每一句都必须
 * **引用某个行号** —— 引不出来就丢掉（见 board-structure.js）。
 *
 * ── 阈值是量出来的，不是拍的（2026-09-19，全部真板 4429 个相邻笔空隙）──
 *   ≤3px   81.8%      ← 同一行里笔挨着笔（汉字笔画、公式符号）
 *   3~8    11.8%
 *   8~15    3.2%
 *   15~25   0.7%   ┐
 *   25~40   0.8%   │ 这一段只有 2.3%，而它对应的正是"换行"：
 *   40~60   0.8%   │ 六张板一共 ~140 个 ≥15 的空隙 ≈ 每张 23 行，和板面高度对得上
 *   60~90   0.6%   ┘
 *   ≥90     0.3%
 * 所以 **LINE_GAP = 25**：落在 15~90 这条几乎没人的空谷里，两边都留了余量。
 *
 * ⚠ **失败模式是"退化"，不是"编造"**（ADR 原文）：阈值偏小 → 一行被切成两行
 *   （草稿里多一条），偏大 → 两行并成一行（少一条）。认出来的**字**一个都不会变，
 *   变的只是"怎么分行"—— 而分行最后还要过第二趟和人的眼。
 *
 * ⚠ **左边缘只给事实，不给"缩进层级"**（2026-09-19 量过之后改的，见 ADR-0004）：
 *   真板上每行起笔的 x 是**连续铺开**的（六张板 113 行：相对中位左边缘 p75 = 44px、
 *   p90 = 195px、max = 413px），并没有"几撮"那么干净。第一版按最左那行当基线量化成
 *   0/1/2 层，结果 **55.8% 的行被判成"缩进两层"** —— 只因为最左那一行是个孤例。
 *   所以这里只给 `x0Rel`（相对**中位**左边缘的像素数，可以是负的：那一行比大多数行还靠左），
 *   **判断留给第二趟**（它有文字内容可看）。这一条按 ADR 的说法属于
 *   "兜底与交叉验证，不当主路"。
 * ⚠ 行间竖直空隙**不用给**：块边界本来就是按大留白切的（`splitByBands` 的 minGap 90），
 *   所以一块之内已经不存在"大空隙"了 —— 实测块内行间空隙 max 就是 89px，没有信息量。
 */
import { strokeBounds } from './geometry.js'

/* 相邻笔（按中心 y 排好）中心差超过它就换行。理由见文件头那张直方图。 */
export const LINE_GAP = 25

/* 一块笔迹 → 行清单。返回的每一行：
 *   { id:'L3', n:3, ids:[笔 id…], x0, x1, y, h, x0Rel }
 * `id` 是**块内**编号（L1、L2…）—— 发给识别那一趟的就是它，好念、好对。
 * 整板唯一的编号由 board-structure.js 拼（跨块时前缀一下），不在这儿操心。 */
export function buildLines(strokes, { gap = LINE_GAP } = {}) {
  const boxes = []
  for (const s of Array.isArray(strokes) ? strokes : []) {
    if (!s || !Array.isArray(s.points) || s.points.length < 6) continue
    const b = strokeBounds(s)
    if (!b) continue
    boxes.push({ id: s.id, cy: b.y + b.h / 2, x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h })
  }
  if (!boxes.length) return []
  boxes.sort((a, b) => a.cy - b.cy)

  const rows = []
  let cur = null
  for (const it of boxes) {
    /* ★ 判据是"和**上一笔**的中心差"，不是"和这一行的平均中心差"：
       平均会随着并进来的笔慢慢漂走，一行写着写着就被它自己带跑了。 */
    if (!cur || it.cy - cur.lastCy > gap) {
      cur = { ids: [], x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, lastCy: it.cy }
      rows.push(cur)
    }
    cur.lastCy = it.cy
    cur.ids.push(it.id)
    if (it.x0 < cur.x0) cur.x0 = it.x0
    if (it.x1 > cur.x1) cur.x1 = it.x1
    if (it.y0 < cur.y0) cur.y0 = it.y0
    if (it.y1 > cur.y1) cur.y1 = it.y1
  }

  /* 基线取**中位数**，不是最靠左那一行：真板上最左常常是个孤例（一行贴着左边写的
     公式、或者一条划到边上的线），拿它当 0 会让别的行全体"看起来缩进了两层"。 */
  const xs = rows.map((r) => r.x0).sort((a, b) => a - b)
  const mid = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2
  return rows.map((r, i) => ({
    id: 'L' + (i + 1),
    n: i + 1,
    ids: r.ids,
    x0: r.x0,
    x1: r.x1,
    y: r.y0,
    h: r.y1 - r.y0,
    /* 一个**事实**：这一行比这块里大多数行靠右（正）还是靠左（负）多少像素。 */
    x0Rel: Math.round(r.x0 - mid),
  }))
}

/* 一块的笔迹按行清单分组（识别那一趟要"这一行是哪几笔"时用）。
   返回 Map<行 id, 笔数组> —— 顺序跟着行清单走。 */
export function groupByLines(strokes, lines) {
  const out = new Map()
  const byId = new Map()
  for (const s of Array.isArray(strokes) ? strokes : []) if (s && s.id) byId.set(s.id, s)
  for (const ln of Array.isArray(lines) ? lines : []) {
    out.set(ln.id, (ln.ids || []).map((id) => byId.get(id)).filter(Boolean))
  }
  return out
}
