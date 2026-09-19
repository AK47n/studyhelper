/* 规整之后的那个图形 —— 它**是一个东西**，不是"一堆碰巧摆得很正的像素"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 这个文件和 `shapes.js` 是**两件事**，先说清楚（改之前必须看）：
 *
 *   `shapes.js`  回答**"你画的这是什么形状"** —— 判读（认圆/方/三角/直线）、
 *                阈值、什么时候宁可认不出来。它是"看一眼"的学问。
 *   `shape-object.js`（本文件）回答**"认出来之后这个东西怎么动"** ——
 *                把那个形状变成一个**可以缩放、可以旋转、重开还在**的对象。
 *
 * 为什么会需要第二个文件：`shapes.js` 把形状**烤成了点**（圆 72 段、矩形 4 角）。
 * 烤成点之后它就是普通笔迹了 —— 拖角缩放没有对象可改，只能去改它的**点**；
 * 而"改点"这条路有三个绕不过去的坑（每一个都会静默地把图形弄坏）：
 *
 *   ① **一根筋放大**：把点乘一个倍率，椭圆看上去还是椭圆、圆看上去还是圆 ——
 *      这一条其实没问题。真正的坑是**分轴**：只改 `points` 而不知道"这是个圆"，
 *      就没法回答"横向拉 2 倍之后它还算不算圆"（OneNote 的答案是"变成椭圆"）。
 *      要知道这件事，就得记住 `kind`。
 *   ② **旋转一个 72 边形**：把圆的 72 个点一起转，屏幕上还是那个圆（圆是对称的），
 *      但**矩形一转就不轴对齐了**，而"轴对齐"正是"规整"的全部内容 ——
 *      改点这条路会让旋转后的矩形变成一个歪的四边形，它没法再吸附回轴对齐。
 *      所以旋转必须是**参数**（`rot`），不是"把点转一遍"。
 *   ③ **重开一张板**：`shapes.js` 规整完的东西在文件里和普通笔迹**长得一模一样**
 *      （就是一堆点）。打开时没有任何线索说明"这是个圆" —— 于是手柄、缩放、旋转
 *      全都消失，图形退化成"一堆摆得很正的点"。用户 2026-09-19 明确要的是
 *      「重开之后它还得是个图形」。
 *
 * ⇒ 所以形状要**记在笔迹上**（`stroke.shape`），而且记的是**几何参数**，不是点：
 *      `{ k: 'circle', cx, cy, rx, ry, rot }`
 *   点是**算出来的**（`bakeShapePoints`），任何时候都可以重算 ——
 *   这就是"尺寸不是第二份真相"那条规矩（同 ADR-0001 里板框的框线）。
 *
 * ★★ 一条铁律：**`shape` 字段和 `points` 必须任何时候都对得上。**
 *   做法不是"记得两边一起改"（那种纪律一定会漏），而是**只有一条路**：
 *   谁都别直接改 `points` —— 改 `shape`，然后 `bakeShapePoints` 重新烤一遍
 *   （`retargetStroke` 是唯一的入口）。这样"对不上"这件事在结构上就不可能发生。
 *
 * ★ 和 ADR-0001 的关系（和 `shapes.js` 的文件头同一条）：规整不猜任何**含义**。
 *   ADR-0001 砍掉的是"从形状里猜关系"（92 条判成箭头、真的 0 条）。
 *   这里做的是"你画了个圈、我把它画圆，然后你能拉大它" —— 全程没有语义判断。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── interface ─────────────────────────────────────────────────────────────
 *   SHAPE_KINDS
 *   normalizeShape(v)                    → null | shape（读盘 / 手改文件那道闸）
 *   serializeShape(s)                    → null | 短字段版（写盘用；老文件不多一字节）
 *   normAngle(a)                         → 角度归一到 (−π, π]（卡片 rot 也用这一份）
 *   shapeFromRecognized(recog)           → null | shape（`shapes.js` 判读的结果 → 对象）
 *   bakeShapePoints(shape)               → 扁平数组 [x,y,p,…]
 *   retargetStroke(stroke, shape)        → 新笔迹（points 重烤、shape 换掉、id 保留）
 *   shapeCenter(shape) / shapeAABB(points) / shapeHandlePoints(points, view)
 *   translateShape(shape, dx, dy)
 *   scaleShape(shape, fx, fy, anchor)
 *   rotateShape(shape, deltaRad, center?)
 *
 * 纯函数：不碰 DOM、不碰 React、不读时间、不 import board.js（避免环形依赖 ——
 * `board.js` 要 import 这里做读盘归一化，所以这里**不能**反过来 import 它）。
 */

import { toPoints } from './geometry.js'

/* 形状只有这五种 —— 和 `shapes.js` 的 `recognizeShape` 返回值一一对应。
   多出来的 "ellipse" 不是"另一种圆"：**圆就是 rx === ry 的椭圆**。
   判读层分两档是为了"同分时优先选更克制的解释"（见 shapes.js 的 fitCircle），
   而**存储**层不需要这个区分：一个 `rx === ry` 的椭圆本来就是个圆。
   分开存的话，缩放之后还要回答"现在还算圆吗"——那是一份会过期的判断。 */
export const SHAPE_KINDS = ['circle', 'ellipse', 'rect', 'triangle', 'line']

const isNum = (v) => Number.isFinite(Number(v))
const num = (v) => (isNum(v) ? Number(v) : 0)

/* 点数：一个圆/椭圆烤成多少段。
 *
 * ★ 为什么要**按半径**给，而不是像 `shapes.js` 那样固定 72：
 *   72 段对一个半径 80 的圆很够（弦高 = r(1−cos(π/72)) ≈ 0.076px，看不见），
 *   但同一个 72 段被拉成半径 600 之后弦高变成 0.57px，屏幕上**看得出来是多边形**；
 *   而"规整"这件事的全部意义就是"它看起来是个真正的圆"。
 *   所以：**段数跟着尺寸长**，下限 72（小圆不必更密，文件也别白胖），上限 360。
 * ★ 判据用的是"弦高 ≤ ~0.4 世界像素"—— 和 NOISE_FLOOR 同一个量级：
 *   比手抖还小的多边形，谁也看不出来。 */
const ARC_SEG_BASE = 72
const ARC_SEG_MAX = 360
const ARC_CHORD_TOL = 0.4
export function arcSegments(radius) {
  const r = Math.abs(num(radius))
  if (!(r > 0)) return ARC_SEG_BASE
  /* 弦高 = r(1 − cos(π/N)) ≈ r·π²/(2N²) ≤ tol ⇒ N ≥ π·sqrt(r/(2·tol)) */
  const need = Math.PI * Math.sqrt(r / (2 * ARC_CHORD_TOL))
  return Math.max(ARC_SEG_BASE, Math.min(ARC_SEG_MAX, Math.ceil(need)))
}

/* ── 读盘那道闸 ──────────────────────────────────────────────────────────
 * 和 `board.js` 的 `normalizeStroke` 里 link / cond 那两条**同一个纪律**：
 *   · 形状不认的一律**丢掉**（手改文件写个 `{k:"star"}` 不该变成一个形状）；
 *   · 缺关键量的丢掉（`w` 是个字符串、`cx` 是 NaN —— 烤出来会是 NaN 点，
 *     而 NaN 点在 canvas 上的表现是"这一笔整个不画"，静默消失）；
 *   · **不补默认值**（没规整过的笔一个字节都不多，见 serializeShape）。
 * ★ 归一化的输出是**规范形**：圆/椭圆一律带 rx/ry/rot；矩形只有 cx/cy/w/h/rot；
 *   三角形另外带 t（三个顶点，**绝对世界坐标**）。见文件头 ①②③ 那段。
 *
 * ★ `normAngle` 也**导出**了（2026-09-21）：卡片的 `rot` 用的是同一个归一化 ——
 *   "角度归到 (−π, π] + 清掉 1e-17 量级的浮点噪声 + 清掉 -0"这件事
 *   全仓库只有这一份实现（两份的话，`-0` 和 `0` 那种假 diff 一定会在其中一份里复活）。
 *
 * ★★ 归一化**同时把参数量化到 1/10 像素** —— 这不是为了文件好看，是那条不变量
 *    （"shape 和 points 任何时候都对得上"）的必要条件。说清楚为什么：
 *
 *   点和参数互相推导（点 = f(参数)），所以 f 的输入动一点点，"同一趟算出来的点"
 *   就动一点点。而**存盘那一步会量化**（参数进文件是 1/10 像素）——
 *   于是"内存里那份没量化的参数"和"盘上那份量化过的参数"烤出来的点**不一样**。
 *   实测：半径 80.0353111712883 的圆存盘变成 80.0，逐点差 **0.1px**（23 个点）。
 *   后果正是那条不变量被破坏：每次打开一张板，图形都悄悄变形一点点，
 *   而且"存→读→再存"不再逐字节一致（每次开板留一条假 diff）。
 *   ⇒ 修法：**让参数一开始就是规范的**（造出来那一刻就量化），
 *     之后内存和盘上是同一组数，f 的输入永远不变。
 *     量化误差 ≤0.05px —— 比存盘本身那 1/10 的精度还小，屏幕上完全看不见。
 *
 * ⚠ 三角形的顶点本来就是量化过的数（它们是从**抽稀后的原笔迹点**里取的，
 *   而那几个点在收笔时已经过了 `fitShape` 的 1/10 取整），所以对三角形这一步近乎恒等 ——
 *   不会出现"顶点被挪了 0.05px 于是和屏幕上那一笔对不上"。
 */
const q1 = (x) => Math.round(num(x) * 10) / 10

export function normalizeShape(v) {
  if (!v || typeof v !== 'object') return null
  const k = v.k
  if (k === 'circle' || k === 'ellipse') {
    if (!isNum(v.cx) || !isNum(v.cy)) return null
    const rx = Math.abs(num(v.rx))
    const ry = Math.abs(num(v.ry))
    if (!(rx > 0.5) || !(ry > 0.5)) return null
    return { k: 'ellipse', cx: q1(v.cx), cy: q1(v.cy), rx: q1(rx), ry: q1(ry), rot: normAngle(v.rot) }
  }
  if (k === 'rect') {
    if (!isNum(v.cx) || !isNum(v.cy)) return null
    const w = Math.abs(num(v.w))
    const h = Math.abs(num(v.h))
    if (!(w > 1) || !(h > 1)) return null
    return { k: 'rect', cx: q1(v.cx), cy: q1(v.cy), w: q1(w), h: q1(h), rot: normAngle(v.rot) }
  }
  if (k === 'triangle') {
    const t = Array.isArray(v.t) ? v.t : null
    if (!t || t.length !== 3) return null
    const pts = t.map((p) => (Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]) ? [q1(p[0]), q1(p[1])] : null))
    if (pts.some((p) => !p)) return null
    /* 退化三角形（三点共线 / 重合）：一个没有面积的"三角形"没有意义，
       而且它的包围盒是零高 —— 手柄会摞在一起、缩放会除零。 */
    const [a, b, c] = pts
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2
    if (!(area > 1)) return null
    return { k: 'triangle', t: pts }
  }
  if (k === 'line') {
    if (!isNum(v.x1) || !isNum(v.y1) || !isNum(v.x2) || !isNum(v.y2)) return null
    /* 零长度的"直线"= 一个点。它没有方向，缩放手柄也没有意义。 */
    if (Math.hypot(num(v.x2) - num(v.x1), num(v.y2) - num(v.y1)) < 1) return null
    return { k: 'line', x1: q1(v.x1), y1: q1(v.y1), x2: q1(v.x2), y2: q1(v.y2) }
  }
  return null
}

/* 角度：一律归到 (−π, π]。**为什么要归一化**：不归的话每次旋转都往文件里
   加一个 2π —— 转十圈之后 `rot` 是 62.83，而屏幕上和 0 一模一样。
   那是"每天一条假 diff"的又一个来源（见 README 第 16 条那一族）。
 *
 * ⚠⚠ **精度必须比"坐标的 1/10 像素"高得多，这一条踩过**：
 *   第一版把 `rot` 也量化到 6 位小数（和坐标那个 q1 一个路子），于是
 *   `rotateShape(rect, π/2)` 出来的 `rot` 是 **1.570796**，而 π/2 是 1.5707963…
 *   —— 差 3.3e-7 弧度。听着小得可笑，但它乘上"图形的尺寸"就是**像素**：
 *   一个 1200px 宽的矩形，角上的点因此偏 **0.0004px**（无所谓）；
 *   可它让"转过 90° 的矩形**不再精确轴对齐**"——而轴对齐正是"规整"的全部内容
 *   （把转了 90° 的矩形再转 −90°，你应该拿回一个**正的**矩形，而不是一个差 3e-7 的歪四边形）。
 *   ⇒ 角度用 9 位小数：1e-9 弧度在 1e4 像素的尺度上也只有 1e-5 像素，
 *     而"转一圈回来"那个 1e-17 量级的浮点噪声照样被归零。
 * ⚠ `-0` 也要清掉：`rotateShape(r90, -π/2)` 会得到 `-0`，而 JSON 里
 *   `-0` 和 `0` 是**两个不同的字符串**（`"-0"` vs `"0"`）—— 又是一条假 diff。 */
export function normAngle(a) {
  let x = num(a)
  if (!Number.isFinite(x)) return 0
  const TAU = Math.PI * 2
  x = x % TAU
  if (x > Math.PI) x -= TAU
  if (x <= -Math.PI) x += TAU
  /* 浮点噪声：转一圈回来可能是 1e-17。当成 0 —— 不然"转了又转回原样"
     在文件里还是会写一个 `rot: 1e-17` 出去。 */
  if (Math.abs(x) < 1e-9) return 0
  const r = Math.round(x * 1e9) / 1e9
  return r === 0 ? 0 : r
}

/* ── 判读结果 → 对象 ────────────────────────────────────────────────────
 * 入参是 `shapes.js` 的 `recognizeShape` 返回值（见那个文件头的 interface）。
 * ★ 圆的两种判读结果（`circle` 带 r / `ellipse` 带 rx,ry）在这里**合并成一种** ——
 *   理由见 SHAPE_KINDS 上面那段：圆就是 rx === ry 的椭圆。
 * ★ 三角形：判读层给的 `box` 是包围盒，但**顶点**才是它的身份
 *   （`fitShape` 也是从原笔迹里取三个角，见 shapes.js 里那段"尊重原笔"）。
 *   所以这里直接从判读结果里搬顶点；搬不到就**放弃**这个形状
 *   （宁可不给手柄，也不要造一个"和屏幕上那一笔长得不一样"的对象 ——
 *    那会让拖一下手柄图形就跳一下）。 */
export function shapeFromRecognized(recog) {
  if (!recog || typeof recog !== 'object') return null
  const k = recog.kind
  if (k === 'circle' || k === 'ellipse') {
    const rx = k === 'circle' ? Math.abs(num(recog.r)) : Math.abs(num(recog.rx))
    const ry = k === 'circle' ? Math.abs(num(recog.r)) : Math.abs(num(recog.ry))
    return normalizeShape({ k: 'ellipse', cx: recog.cx, cy: recog.cy, rx, ry, rot: 0 })
  }
  if (k === 'rect') {
    const b = recog.box
    if (!b) return null
    return normalizeShape({ k: 'rect', cx: num(b.x) + num(b.w) / 2, cy: num(b.y) + num(b.h) / 2, w: num(b.w), h: num(b.h), rot: 0 })
  }
  if (k === 'triangle') {
    const vs = recog.verts || recog.vertices
    if (!Array.isArray(vs) || vs.length !== 3) return null
    return normalizeShape({ k: 'triangle', t: vs.map((p) => [num(p && p.x), num(p && p.y)]) })
  }
  if (k === 'line') {
    if (!recog.a || !recog.b) return null
    return normalizeShape({ k: 'line', x1: recog.a.x, y1: recog.a.y, x2: recog.b.x, y2: recog.b.y })
  }
  return null
}

/* ── 写盘：**短字段**，而且只在真有时写 ──────────────────────────────────
 * 和 link / cond / locked / font / scale 那五个字段**同一条规矩**
 * （README「数据长什么样」）：老文件、没规整过的板，一个字节都不多。
 * ★ 字段名短是有理由的：它是**每一笔**都可能带的字段，而一节课的板上有几百笔 ——
 *   `"kind":"triangle"` 和 `"k":"triangle"` 在一张 200 个形状的板上是几 KB。
 *   板文件是给人看得懂 + 进 Git 的。
 * ★ **这里不再量化**（第一版又量化了一遍，是重复劳动而且是隐患）：
 *   归一化那一步已经把参数量化到 1/10 像素了（见 normalizeShape 那段长注释），
 *   而 `serializeShape` 的第一句就是 `normalizeShape` —— 出口和入口是同一个规范形。
 *   在这里再 round 一次只会有两个后果：① 同一个量在两处各量化一遍（两份实现）；
 *   ② 哪天两处的精度不一样，就会出现"内存里 A、盘上 B"的静默分裂。
 * ★ `rot` 只在**真转过**时才写：没转过就是 0，写一个 `rot: 0` 出去
 *   等于给老文件造一次假 diff（和 font / scale / locked 同一条纪律）。 */
export function serializeShape(s) {
  const n = normalizeShape(s)
  if (!n) return null
  if (n.k === 'ellipse') {
    const out = { k: 'ellipse', cx: n.cx, cy: n.cy, rx: n.rx, ry: n.ry }
    if (n.rot) out.rot = n.rot
    return out
  }
  if (n.k === 'rect') {
    const out = { k: 'rect', cx: n.cx, cy: n.cy, w: n.w, h: n.h }
    if (n.rot) out.rot = n.rot
    return out
  }
  if (n.k === 'triangle') return { k: 'triangle', t: n.t.map((p) => [p[0], p[1]]) }
  return { k: 'line', x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 }
}

/* ── 烤点：形状 → 扁平点数组 ────────────────────────────────────────────
 * 压力一律 0.5（和 `shapes.js` 的 `fitShape` 同一条理由：规整形态是几何产物，
 * 没有手压信息；硬套原来的压力只会让线宽忽粗忽细）。
 * ★ 闭合的形状要**显式重复第一点**（canvas 的 stroke() 不会自动闭合路径）——
 *   少这一点，屏幕上圆会缺一小段，而"缺一小段"看起来像 bug，不像设计。
 * ★ 坐标量化到 1/10 像素：和存盘同一个精度，于是"屏幕上这一笔"和"盘上这一笔"
 *   是同一组数（不然点一下手柄，文件里就悄悄变了一批小数）。 */
export function bakeShapePoints(shape) {
  const s = normalizeShape(shape)
  if (!s) return null
  const out = []
  const push = (x, y) => out.push(q1(x), q1(y), 0.5)

  if (s.k === 'line') {
    push(s.x1, s.y1)
    push(s.x2, s.y2)
    return out
  }
  if (s.k === 'rect') {
    const c = Math.cos(s.rot)
    const si = Math.sin(s.rot)
    const hw = s.w / 2
    const hh = s.h / 2
    /* 四个角按 `rot` 转（rot = 0 时就是轴对齐的矩形）。顺序是一个环。 */
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    for (const [x, y] of corners) push(s.cx + x * c - y * si, s.cy + x * si + y * c)
    push(s.cx + -hw * c - -hh * si, s.cy + -hw * si + -hh * c) // 闭合回第一点
    return out
  }
  if (s.k === 'triangle') {
    for (const p of s.t) push(p[0], p[1])
    push(s.t[0][0], s.t[0][1]) // 闭合
    return out
  }
  if (s.k === 'ellipse') {
    const N = arcSegments(Math.max(s.rx, s.ry))
    const c = Math.cos(s.rot)
    const si = Math.sin(s.rot)
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2
      const x = s.rx * Math.cos(t)
      const y = s.ry * Math.sin(t)
      push(s.cx + x * c - y * si, s.cy + x * si + y * c)
    }
    push(s.cx + s.rx * c, s.cy + s.rx * si) // 闭合（rot = 0 时就是 cx+rx, cy）
    return out
  }
  return null
}

/* ★★ **唯一的入口**：形状变了 → 重烤点。
 *   谁都别自己改 `stroke.points`（见文件头那条铁律）。
 *   沿用原来的 id / tool / color / width / pressure / link / cond ——
 *   这一整段和 `regularizeStrokes` 里那条注释是同一个道理（规整是同一笔的更好版本）。 */
export function retargetStroke(stroke, shape) {
  const pts = bakeShapePoints(shape)
  if (!pts || pts.length < 6) return stroke
  return { ...stroke, shape: normalizeShape(shape) || undefined, points: pts }
}

/* ── 包围盒 / 手柄位置 ──────────────────────────────────────────────────
 * ★ 手柄画在**点的包围盒**上，不是"形状自己声明的框"——
 *   旋转过的矩形，它的点包围盒比矩形本身大（四个角转出去那一圈）。
 *   用点包围盒的好处是**和"选中墨迹"的那个框是同一个框**
 *   （`.bd-inkbox` 也是按点算的），于是手柄永远贴着用户看到的那个虚线框，
 *   不会出现"框在那儿、手柄在旁边"这种两个矩形各算一遍的老毛病
 *   （README 第 15/16 条、ADR-0002 都是这一类账）。 */
export function shapeAABB(points) {
  const pts = toPoints(points)
  if (!pts.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

/* 形状的"转轴"—— 旋转绕它转。
 * ★ 用**几何中心**，不是包围盒中心：旋转过的矩形绕包围盒中心转，
 *   那个点会随着角度**漂移**（包围盒本身在变），表现为"转起来一边转一边跑"。
 *   几何中心是形状自己的属性，转多少圈它都不动。 */
export function shapeCenter(shape) {
  const s = normalizeShape(shape)
  if (!s) return null
  if (s.k === 'line') return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }
  if (s.k === 'triangle') {
    return { x: (s.t[0][0] + s.t[1][0] + s.t[2][0]) / 3, y: (s.t[0][1] + s.t[1][1] + s.t[2][1]) / 3 }
  }
  return { x: s.cx, y: s.cy }
}

/* ── 三个变换 ───────────────────────────────────────────────────────────
 * 都是"形状进、形状出"，纯函数。缩放/旋转**不做**"点的重算"那一步 ——
 * 调用方拿结果去过 `retargetStroke`（那才是唯一的入口）。 */

export function translateShape(shape, dx, dy) {
  const s = normalizeShape(shape)
  if (!s) return null
  const d = [num(dx), num(dy)]
  if (s.k === 'line') return { ...s, x1: s.x1 + d[0], y1: s.y1 + d[1], x2: s.x2 + d[0], y2: s.y2 + d[1] }
  if (s.k === 'triangle') return { ...s, t: s.t.map((p) => [p[0] + d[0], p[1] + d[1]]) }
  return { ...s, cx: s.cx + d[0], cy: s.cy + d[1] }
}

/* 缩放。`anchor` 是**不动的那个点**（拖哪个角，对角就是锚点）。
 *
 * ★★ 缩放会**改变形状的身份**，这条规矩要写下来：
 *   · 分轴缩放（fx ≠ fy）圆**变成椭圆**、正方形**变长方形** —— 这是对的，
 *     也正是"对图形放大缩小修正真正形状"这句需求的意思（OneNote 就是这样）。
 *   · 等比缩放形状不变。
 *   · 矩形/三角形/直线：顶点跟着走，形状类别不变。
 * ★ 返回值**仍然是同一个 kind 家族**（圆那一族永远返回 ellipse）——
 *   因为存储层只有一个椭圆（见 SHAPE_KINDS 那段），"还是不是正圆"是**算出来的**
 *   （`rx === ry`），不是存下来的第二个真相。
 *
 * ★★ 倍率**必须夹**，而且夹的是倍率本身、不是"算完发现太小就返回 null"。
 *   ⚠ 这是本文件里最容易写错的一处，说清楚为什么：
 *     第一版写的是"缩得太小 → 返回 null（放弃这一帧）"。看上去很安全，实际是一个
 *     **拖不回来**的陷阱：拖到最小那一刻，图形停在最后一次合法的尺寸上；
 *     而用户继续往对角拖（以为"再拖小一点"）时，**指针离锚点的距离还在变小**——
 *     等他往回拖，倍率要从"那个已经没有意义的小数"重新长回来，
 *     于是图形会**先卡住、再突然跳回一个大尺寸**。屏幕上就是"拖坏了"。
 *   ⇒ 正确做法：把倍率**夹在**"形状还剩 MIN_SPAN 这么大"的范围里。
 *     夹了之后倍率永远不会小到让图形消失，往回拖就是**连续地长回来**。
 *     代价是"拖到最小之后指针再走一段它不动" —— 那是对的，它已经到底了。
 * ⚠ 负倍率（把图形翻过去）：不许。`normalizeShape` 把尺寸取绝对值，
 *   于是翻过去和翻过来在屏幕上一样 —— 但**手柄会跑到对角**，看起来像功能坏了。
 *   所以倍率一律取正（`Math.abs`），"翻面"这件事这个版本不做。 */
const MIN_SPAN = 1
export function scaleShape(shape, fx, fy, anchor) {
  const s = normalizeShape(shape)
  if (!s) return null
  const ax = num(anchor && anchor.x)
  const ay = num(anchor && anchor.y)
  const gx = clampFactor(fx)
  const gy = clampFactor(fy)
  const S = (x, y) => [ax + (x - ax) * gx, ay + (y - ay) * gy]

  if (s.k === 'line') {
    const a = S(s.x1, s.y1)
    const b = S(s.x2, s.y2)
    return normalizeShape({ k: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1] })
  }
  if (s.k === 'triangle') {
    /* 三角形夹的是它的**两个跨度**（面积的平方根量级）：三角形退化之后
       `normalizeShape` 会按面积那道闸把它丢掉 —— 那一丢就是"图形消失"。
       所以在算倍率之前先把跨度夹住。 */
    const bb = aabbOfPoints(s.t)
    const ggx = clampToSpan(gx, bb.w)
    const ggy = clampToSpan(gy, bb.h)
    const T = (x, y) => [ax + (x - ax) * ggx, ay + (y - ay) * ggy]
    return normalizeShape({ k: 'triangle', t: s.t.map((p) => T(p[0], p[1])) })
  }
  const c = S(s.cx, s.cy)
  if (s.k === 'rect') {
    return normalizeShape({
      k: 'rect',
      cx: c[0],
      cy: c[1],
      w: Math.max(MIN_SPAN, s.w * clampToSpan(gx, s.w)),
      h: Math.max(MIN_SPAN, s.h * clampToSpan(gy, s.h)),
      rot: s.rot,
    })
  }
  return normalizeShape({
    k: 'ellipse',
    cx: c[0],
    cy: c[1],
    rx: Math.max(MIN_SPAN / 2, s.rx * clampToSpan(gx, s.rx * 2)),
    ry: Math.max(MIN_SPAN / 2, s.ry * clampToSpan(gy, s.ry * 2)),
    rot: s.rot,
  })
}
function aabbOfPoints(pts) {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
/** 倍率夹到"这一轴还剩至少 MIN_SPAN"为止（见上面那段"拖不回来"的账）。 */
function clampToSpan(f, span) {
  const lo = Number.isFinite(span) && span > 0 ? MIN_SPAN / span : 0.02
  return Math.max(lo, Math.abs(num(f)) || lo)
}
function clampFactor(f) {
  const v = Math.abs(num(f))
  if (!Number.isFinite(v) || v === 0) return 1
  /* 上限 50 倍：再大就是"屏幕外的一个巨型图形"（点云会到几万个点），
     而那既不是用户想做的事，也不好在文件里收拾。 */
  return Math.min(50, Math.max(0.001, v))
}

/* 旋转。`deltaRad` 是**增量**，绕 `center`（默认它自己的几何中心）。
 *
 * ★★ 2026-09-21 修了一处**只在"绕别人的中心转"时才露头**的错，说清楚它原来错在哪：
 *   矩形/椭圆/圆这一族转的是**参数** `rot`（文件头 ② 那条：靠改点回不到轴对齐），
 *   而参数里还有 `cx/cy` —— **转轴不是它自己的时候，中心也得跟着绕**。
 *   第一版只改 `rot`、不动 `cx/cy`，于是"把一张选区的旋转当成整组绕中心转"时，
 *   图形会**原地自转**（位置一点点都不挪），而它周围的手写却老老实实绕着中心转走了 ——
 *   屏幕上就是"框住一块转一下，里面的矩形留在原地"。
 *   单图形那一条路看不出来：那里传进来的 `center` 就是它自己的中心（`shapeCenter`），
 *   绕自己转当然不用挪 —— 所以这个错在只有"单个图形"的年代**不存在**，
 *   是"成组变换"（selection.js 的 `transformPick`）把它暴露出来的。
 *   ⇒ 正确写法：先按点那一族的公式算出**中心的新位置**，再把整个图形平移到那儿。
 *     `R_G(c) = c + (R_G(c) − c)`，所以就是"绕自己转 + 平移那一小段"，
 *     和自己中心的情形（位移恰好是 0）**逐位一致** —— 老调用方一个像素都不动。 */
export function rotateShape(shape, deltaRad, center) {
  const s = normalizeShape(shape)
  if (!s) return null
  const d = num(deltaRad)
  if (!d) return s
  const c = center || shapeCenter(s)
  const cs = Math.cos(d)
  const sn = Math.sin(d)
  const R = (x, y) => [c.x + (x - c.x) * cs - (y - c.y) * sn, c.y + (x - c.x) * sn + (y - c.y) * cs]

  if (s.k === 'line') {
    const a = R(s.x1, s.y1)
    const b = R(s.x2, s.y2)
    return normalizeShape({ k: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1] })
  }
  if (s.k === 'triangle') return normalizeShape({ k: 'triangle', t: s.t.map((p) => R(p[0], p[1])) })
  /* 圆/椭圆/矩形：转的是**参数** `rot`，不是点（文件头 ②）—— 但中心要跟着挪（见上面那段）。 */
  const nc = R(s.cx, s.cy)
  return normalizeShape({ ...s, cx: nc[0], cy: nc[1], rot: normAngle(s.rot + d) })
}

/* 手柄画在哪：四个角 + 一个旋转柄。 * 入参是世界包围盒（`shapeAABB` 的结果），出参是**世界坐标**的点 ——
 * 换屏幕是 `view.js` 的事（"视图映射只有一处"，见 CONTEXT.md）。
 * ⚠ 顺序就是数组的顺序：0..3 是四个角（左上、右上、右下、左下），4 是旋转柄。
 *   自检和界面都按这个顺序取，别在别处再排一次。
 *   （原来还导出了一个 `SHAPE_CORNERS` 名字数组，2026-09-19 删掉了 ——
 *     没有任何调用方用它，而"没人用的导出"会让下一个人以为那是契约的一部分。）
 *
 * ★★ 旋转柄摆在**右边中点**，不是"顶边中点"（2026-09-19 挪过来的，理由是量出来的）：
 *   选中一块墨迹时，`.bd-inkacts`（那排「∑ 公式 / ✨ 美化 / ◯ 规整 / ⧉ 复制 / ✕ 删除」）
 *   是 `translateY(-100%)` **钉在包围框正上方**的，实测高约 26 屏幕像素 ——
 *   而"顶边中点"离框只有 26px（CSS 里那个 `margin-top: -26px`），于是**两者正好压在同一个位置**：
 *   `elementFromPoint` 量出来旋转柄中心命中的是那排按钮。
 *   （症状和 README 第 13 条那一族一模一样：**手柄看得见、抓不住、按下去是在戳按钮**。）
 *   ⇒ 换到右边中点：那一带的上下都是空的（角柄在四个**角**上，角柄在 y = y0/y1，
 *     而旋转柄在 y = 中心 —— 竖直方向差半个框高，谁也压不着谁）。
 * ⚠ 代价是"图形紧贴屏幕右缘时它会被关系面板（浮层、z-index 20）盖住"——
 *   这是**已知且接受**的（和角柄被底部工具条盖住同一条规矩），
 *   自检里那条 `elementFromPoint` 断言就是为了让这件事**看得见**，不是假装它不存在。 */
export function shapeHandlePoints(box) {
  if (!box) return []
  return [
    { id: 'nw', x: box.x0, y: box.y0 },
    { id: 'ne', x: box.x1, y: box.y0 },
    { id: 'se', x: box.x1, y: box.y1 },
    { id: 'sw', x: box.x0, y: box.y1 },
    { id: 'rot', x: box.x1, y: box.cy },
  ]
}

/* 每个角对应的**锚点**（拖这个角时不动的那一点）—— 对角。
 * ★ 单独一个函数、不写在界面里：这条映射在"缩放手势"和"光标提示"两处都要用，
 *   写两遍就会有一天只改一处（那种账这个仓库记了十几条）。 */
export function oppositeCorner(box, id) {
  if (!box) return null
  if (id === 'nw') return { x: box.x1, y: box.y1 }
  if (id === 'ne') return { x: box.x0, y: box.y1 }
  if (id === 'se') return { x: box.x0, y: box.y0 }
  if (id === 'sw') return { x: box.x1, y: box.y0 }
  return { x: box.cx, y: box.cy }
}

/* 形状的人话名字 —— **借用 `shapes.js` 的 `shapeLabel` 会造出环形依赖** * （shapes.js 那边要拿这里的 `shapeFromRecognized`），所以这里只做一次映射。
 * ⚠ 两边必须说同一句话：`check-shape` 里有一条断言把这两个函数对着比。 */
export function shapeName(shape) {
  const s = normalizeShape(shape)
  if (!s) return '形状'
  if (s.k === 'line') return '直线'
  if (s.k === 'rect') return '矩形'
  if (s.k === 'triangle') return '三角形'
  /* ⚠ 比的是"两个半轴一样不一样"，**不能写 `rx === ry`**：
     判读层给的正圆两个数本来是同一个（`fitCircle` 的 r），但用户拖一下角、
     或者过一次存盘的 1/10 取整，它们就可能差一个 1e-15 —— 那时它会自称"椭圆"，
     而屏幕上明明还是个圆。"这算不算圆"是量出来的，不是猜的。 */
  return Math.abs(s.rx - s.ry) < 1e-6 ? '圆' : '椭圆'
}
