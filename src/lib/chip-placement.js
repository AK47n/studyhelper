/* 那颗词摆在哪：连接线中点浮出来的那排词 / 浮层的锚点 —— **一条政策**，
 * 和视图映射（`view.js`）是两件事。
 *
 * 为什么单开一个文件（2026-09-17 架构 review 候选 1 的尾巴，它把这件东西叫 `chipPlacement`）：
 *   候选 1 把"屏幕 = 世界 × s + t"和长度的口径收进 `view.js` 之后，`linkPickAt` 里还剩
 *   三个**屏幕**边距（130 / 96 / 60）夹在那个函数里 —— 它们说的其实是
 *   "这颗词别跑到画布外面、也别压到底部工具条底下（工具条 z-index 20，见 README 第 13 条）"。
 *   那是一句**界面政策**，不是映射：映射只回答"世界点在哪"，政策回答"摆在那儿行不行"。
 *   从前它和映射写在同一行里手推，于是"改了工具条高度要去哪儿改"没有答案。
 *
 * interface：
 *   chipPlacement(p, area, opts) → { x, y }
 *     p    屏幕点（相对**画布容器**左上角；用 view.js 的 worldToScreen 算出来）
 *     area { w, h } 画布容器的大小（`el.clientWidth / clientHeight`）
 *     opts 三个边距可覆盖（默认就是下面那三个常量）
 *   ⚠ 一律**屏幕**像素（所以它们不跟着画布缩放走）—— 名字里带单位。
 *     容器比"两边边距加起来"还窄的时候，夹出来的就是那个下界（和从前一模一样）。
 */

/* 词的左/右边距：那排词最宽的时候约 260px（5 个词 + 间距 + 内边距），
   取一半 —— 这样"夹进来"之后它整个还在屏幕里，而不是只把**中点**夹进来。
   130 是量出来的：`check-link` 那几条词（相关/因果/推导/并列/等价 + 删掉）排一排的宽度。 */
export const CHIP_MARGIN_X = 130
/* 上边距：让开顶上那两条（文件名那一行 + 工具条），词不至于贴着它们。
   96 是实测它们的总高再加一点余量。 */
export const CHIP_MARGIN_TOP = 96
/* 下边距：让开底部工具条（它 z-index 20，压在画布上面）。60 是它的高度 + 余量。
   ⚠ 这两个数**跟着界面走**：动了顶栏/工具条的高度，就来改这里 —— 只有这一处。 */
export const CHIP_MARGIN_BOTTOM = 60

export function chipPlacement(p, area, opts = {}) {
  const w = Number(area && area.w) || 0
  const h = Number(area && area.h) || 0
  const mx = opts.marginX != null ? opts.marginX : CHIP_MARGIN_X
  const mt = opts.marginTop != null ? opts.marginTop : CHIP_MARGIN_TOP
  const mb = opts.marginBottom != null ? opts.marginBottom : CHIP_MARGIN_BOTTOM
  /* 两个上界都取 `Math.max(下界, …)`：容器小到装不下两边边距时，退回下界而不是负数
     （从前就是这么写的 —— 搬过来时一个字没改）。 */
  return {
    x: Math.min(Math.max(p.x, mx), Math.max(mx, w - mx)),
    y: Math.min(Math.max(p.y, mt), Math.max(mt, h - mb)),
  }
}
