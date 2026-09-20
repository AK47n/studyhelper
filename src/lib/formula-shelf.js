/* ═══════════ 公式架：这张板上已经"认过一次"的公式，收成一条随手可取用的架子 ═══════════
 *
 * 用户 2026-09-20 的原话：
 *   「加个功能让已经识别一次的公式卡放置在某个便于去用的地方，白板的其他地方要用到
 *     这个公式卡的时候便于直接使用，因为一次课往往会多次用到同样的公式」
 *
 * 三条规矩（都是"不新增状态"推出来的）：
 *   ① **只汇总这张板上已有的公式卡** —— 架子是**推出来的**，不是另存一份库。
 *      于是它永远不可能和板对不上，也不需要"同步 / 清理 / 过期"这类动作，
 *      板文件更是一个字节都不加（ADR-0001 那条纪律照旧）。
 *   ② **按公式去重**：同一条式子写在板上三个地方 = 架子上一格（角标 ×3）。
 *      架子回答的是"这条公式我用过没有"，不是"板上有几张卡" ——
 *      后者在上一条规矩下本来就是板自己的事。
 *   ③ **顺序跟板面一致**（先上后下、再左后右，和草稿那边的 `byPosition` 同一个规矩）：
 *      你要找的多半是刚写下的那条，而"按最近用过"要额外存状态（不值）。
 *
 * ⚠ **认不出来的不上架**（`tex` 和 `src` 都空 = 一张空卡）：空卡放上去只占地方。
 * ⚠ 去重的键是 **`tex`**（渲染用的那串），不是"渲染出来像不像"：
 *   `\frac{a}{b}` 和 `a/b` 是两个写法、也是两条式子，不该被合并 ——
 *   合并的判据一旦变成"看起来一样"，就得引入规范化规则（那是另一个坑）。
 */

/* 两行算不算"同一行"：沿用草稿那边 40px 的宽容度（上下差这一点算并排，按左右排）。 */
export const SHELF_POS_TOL = 40

/* 卡片列表 → 架子上的格子。
 * 返回的每一格：{ key, tex, src, count, ids, x, y }
 *   · `key`  去重用的那串（React 的 key 也用它 —— 按构造就唯一）
 *   · `count` 这条公式在板上有几处（角标）
 *   · `x, y` 第一处那张卡的**中心**（给排序和自检看） */
export function shelfItems(cards) {
  const out = []
  const at = new Map()
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.kind !== 'formula') continue
    const tex = String(c.tex || '').trim()
    const src = String(c.src || '').trim()
    if (!tex && !src) continue
    const key = tex || src
    const cx = (Number(c.x) || 0) + (Number(c.w) || 0) / 2
    const cy = (Number(c.y) || 0) + (Number(c.h) || 0) / 2
    const hit = at.get(key)
    if (hit) {
      hit.count += 1
      hit.ids.push(c.id)
      continue
    }
    const item = { key, tex, src, count: 1, ids: [c.id], x: cx, y: cy }
    at.set(key, item)
    out.push(item)
  }
  return out.sort((a, b) => (Math.abs(a.y - b.y) > SHELF_POS_TOL ? a.y - b.y : a.x - b.x))
}
