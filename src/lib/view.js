/* ═══════════ 视图映射：屏幕 = 世界 × s + t ═══════════
 *
 * 板子上**只有一个**坐标公式：屏幕 = 世界 × s + t（`t` 是相对画布容器的平移，
 * 单位是屏幕像素）。世界 → 屏幕有三种落地方式，全都在这个文件里：
 *   · DOM 浮层（卡片、虚线框、词条排）→ `worldToScreen(pt, view)`
 *   · canvas → `applyViewTo(ctx, view, dpr)`
 *   · SVG `<g>` → `viewTransformAttr(view)`
 * 反算（指针落点 → 世界）走 `screenToWorld`；视图本身怎么变（缩放/平移/居中）
 * 也在这里：`zoomAt` `zoomBetween` `panBy` `centerOn` `clampViewScale`。
 *
 * ★ 为什么值得独立成一个 module（2026-09-16 收的口）：
 *   这条公式以前被**手抄 14 处**（BoardCanvas.jsx 12、Board.jsx 2），canvas 变换
 *   写了两份（BoardCanvas.jsx:41 与 Board.jsx:2413），捏合缩放还把 `clampViewScale`
 *   和"以锚点缩放"的前馈公式各又抄了一遍 —— 于是出现最糟的一种局面：
 *   **导出的 `zoomAt`/`clampViewScale` 有自检，而真手指走的是那份复制品。**
 *   收进这里之后，"谁 round / dpr 怎么叠 / 锚点怎么跟"只在这一个文件里，
 *   而且测试和手指跨的是同一道缝。
 *
 * ★ 一条口径规矩：**这里一律纯浮点，不 round。**
 *   `Math.round` 是"写进 DOM/CSS"那一步的事。早 round 会让 canvas 和 CSS 两条路
 *   各错一点，累积起来就是"看着有点歪"—— 那正是这类 bug 最难发现的样子。
 *
 * ★ 视图的形状：`{ s, tx, ty }`。所有函数都**不改入参**，返回新的视图对象
 *   （调用方大多在 React 的 `setView((v) => …)` 里用）。
 */

export const VIEW_SCALE_MIN = 0.15
export const VIEW_SCALE_MAX = 6

/* 缩放的上下限。兜底成 1（而不是 0）：`Number(s) || 1` 让 NaN/0/空串都退回 1，
   否则一次脏输入就会把整张板缩成看不见。 */
export function clampViewScale(s) {
  const n = Number(s) || 1
  return Math.min(VIEW_SCALE_MAX, Math.max(VIEW_SCALE_MIN, n))
}

/* 世界点 → 屏幕点（相对画布容器）。返回浮点，别在这里 round。 */
export function worldToScreen(pt, view) {
  return { x: pt.x * view.s + view.tx, y: pt.y * view.s + view.ty }
}

/* 世界矩形 → 绝对定位用的 CSS 盒子：`{left, top, width, height}`。
 * `pad` 是"每边往外让多少屏幕像素"（虚线选框比真实笔迹范围大一圈那种）。
 * 为什么要它：`left/top` 是**映射**、`width/height` 是**长度 × s**，
 * 手写时这两件事混在一行里，很容易一边乘了 s、另一边忘了 —— 收在这里就不会。 */
export function worldRectToScreen(rect, view, pad = 0) {
  const p = worldToScreen({ x: rect.x0, y: rect.y0 }, view)
  return {
    left: p.x - pad,
    top: p.y - pad,
    width: (rect.x1 - rect.x0) * view.s + pad * 2,
    height: (rect.y1 - rect.y0) * view.s + pad * 2,
  }
}

/* 屏幕点（相对画布容器）→ 世界点。指针落点全都走它。 */
export function screenToWorld(x, y, view) {
  return { x: (x - view.tx) / view.s, y: (y - view.ty) / view.s }
}

/* 把视图变换压进 canvas。`dpr` 必须乘进去 —— 只给 CSS 那层乘 dpr 的话，
   墨迹会比卡片"糊一点、偏一点"（两层坐标分家的经典症状）。
   返回**实际写进去**的那三个数，给"自检要看 canvas 变换"的地方直接用。 */
export function applyViewTo(ctx, view, dpr) {
  const s = dpr * view.s
  const tx = dpr * view.tx
  const ty = dpr * view.ty
  ctx.setTransform(s, 0, 0, s, tx, ty)
  return { s, tx, ty }
}

/* SVG 那一层的等价物（`<g transform="…">`）——和上面两个是同一个公式的第三种写法。 */
export function viewTransformAttr(view) {
  return `translate(${view.tx} ${view.ty}) scale(${view.s})`
}

/* 以 `fromScreen` 底下那个世界点为基准缩放，并让它落回 `toScreen` 底下。
 *
 * 一个函数吃下三种手势：滚轮/按钮缩放（`from === to`）、捏合（两指中点会动，
 * 所以 from ≠ to）、以及"先算好倍数"的调用方（`nextScale` 直接给绝对缩放）。
 * 为什么参数是**两个屏幕点**而不是"一个锚点 + 一个位移"：捏合时基准点和落点
 * 是先后测到的两个坐标，摆成两个参数才不会有中间状态。 */
export function zoomBetween(view, nextScale, fromScreen, toScreen) {
  const s = clampViewScale(nextScale)
  const k = s / view.s
  return {
    s,
    tx: toScreen.x - (fromScreen.x - view.tx) * k,
    ty: toScreen.y - (fromScreen.y - view.ty) * k,
  }
}

/* 光标/按钮缩放：锚点不动，所以 from === to。 */
export function zoomAt(view, factor, screenX, screenY) {
  const at = { x: screenX, y: screenY }
  return zoomBetween(view, view.s * factor, at, at)
}

/* 平移（屏幕像素）。`dx/dy` 是**屏幕**位移，不是世界位移 ——
   手指拖多远、板子就走多远，和缩放无关。 */
export function panBy(view, dx, dy) {
  return { ...view, tx: view.tx + dx, ty: view.ty + dy }
}

/* 把某个世界点摆到容器的正中间（"聚焦到这张卡""打开时把内容装进屏幕"）。
   缩放不变，只算平移 —— 就是 `screenToWorld` 的逆运算。 */
export function centerOn(view, worldPt, screenW, screenH) {
  return {
    ...view,
    tx: screenW / 2 - worldPt.x * view.s,
    ty: screenH / 2 - worldPt.y * view.s,
  }
}

/* ═══════════ 长度、以及"每样东西自己的倍率" ═══════════
 *
 * 上面那几条收的是**点与矩形**；下面这几条收的是**长度**（半径、最小步长、内边距、
 * 线宽、指针位移……）和**倍率**。
 *
 * ★ 为什么单开这几条（2026-09-17 架构 review 的候选 1，ADR-0002 的邻居）：
 *   "卡片的屏幕尺寸 = 世界 × s × 卡自己的 k" 这条被**手抄过三处** ——
 *   卡片渲染（Board.jsx 的 Card）、缩放柄的兜底分支、量尺寸那一趟的 wantW（card-fit.js）。
 *   而 view.js 只认 s、不认 k，于是"卡片这条路不走 view.js"成了惯例：
 *   屏幕像素的量（那圈边）顺势混进了世界坐标的宽，长出了 ADR-0002 那根恒粗黑线。
 *   **一个倍率只有一处乘，口径才算真的一处。**
 *
 * ★ 这几条都是纯函数（不改入参、**不 round** —— round 是写进 DOM/CSS 那一步的事，见文件头）。
 * ★ `factor` 一律是 combinedScale(...) 出来的那个倍率；不跟缩放走的量**不要**进这里。
 */
export function combinedScale(s, k) {
  const a = Number(s) || 1
  const b = Number(k) || 1
  return a * b
}

/* 世界长度 → 屏幕长度。 */
export function worldLenToScreen(len, factor) {
  return (Number(len) || 0) * (Number(factor) || 1)
}

/* 屏幕长度 → 世界长度（反方向：指针位移、橡皮半径、命中容差都该走它）。 */
export function screenLenToWorld(len, factor) {
  const f = Number(factor) || 1
  return (Number(len) || 0) / (f > 0 ? f : 1)
}

/* 世界矩形 → 屏幕盒，带倍率（卡片那条路用它）。
   `pad` 与 worldRectToScreen 一样是"每边往外让多少屏幕像素"。 */
export function scaledRectToScreen(rect, factor, pad = 0) {
  const f = Number(factor) || 1
  return {
    left: (Number(rect && rect.x) || 0) * f - pad,
    top: (Number(rect && rect.y) || 0) * f - pad,
    width: (Number(rect && rect.w) || 0) * f + pad * 2,
    height: (Number(rect && rect.h) || 0) * f + pad * 2,
  }
}
