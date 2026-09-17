/* 撤销账本：一次手势 = 一步撤销 —— 2026-09-17 架构 review 候选 3。
 *
 * 为什么要有这个 module：`commit` 本身够深，但它管不到"一次手势算几步撤销"。
 * 于是四条连续手势（挪笔迹 / 拖板框 / 缩放卡片 / 拖卡片）各自在收尾处手记一次账 ——
 * 后三行（裁到 UNDO_MAX / `redo = []` / 报数）四处一字不差，而"这算不算动过"四个判据
 * 各写各的（一个手写的 `moved` 标记 / 两个数组的引用 / |Δ| < 0.5 / |dx| < 1.5）。
 * 四条里只有"拖板框"有 Ctrl+Z 断言 —— 另外三条哪天忘了清重做、或者忘了裁掉最老的一步，
 * 屏幕上没有任何东西会响。
 *
 * 现在手势只说三句话：
 *     const g = ledger.begin()        // 起点：快照一次
 *     g.during((cur) => …)            // 中途每一帧：只改板、不记账
 *     g.end()                         // 收尾：真的动了才记**一步**（返回 true/false）
 * "没动"只剩一个判据：收尾时那版板和起点**是不是同一个样**（`sameWithin`，
 * 数字按 `MOVE_EPS` 世界像素比）。从前那个 `moved` 标记、数组引用、两个 |Δ| 阈值
 * 说的都是这件事，只是各说各的。
 *
 * ⚠ 两条如实记下的行为变化（"四个判据收成一个"的必然结果）：
 *   · 拖出去又拖回原点 → 现在**不记**一步（从前挪笔迹会记一步空操作）；
 *   · 全程不足 MOVE_EPS 世界像素 → 不记（和从前卡片那两条阈值一致）。
 *     缩放卡片自己那道 `|dx| < 1.5 屏幕像素` 的门留在原地：它管的是"这一下别污染手势"，
 *     不是"算不算一步"。
 *
 * 这个 module 不认识 React、也不认识"板"是什么：板从 `get` 进来、从 `write` 出去，
 * 数数从 `onCount` 出去。所以 check-board 的 [6s] 用一对假 adapter 就能把它整族断言一遍。
 */

export const UNDO_MAX = 60

/* 世界像素：小于这个的差别算"没动"（手抖 / 浮点噪声）。
   0.5 的来历：从前的卡片拖动就是按这个数判的（`|dx| < 0.5 && |dy| < 0.5`），
   而它同时小到"缩得再狠也看得见"—— 拿它当"没动"的门是安全的。 */
export const MOVE_EPS = 0.5

/* 两版板"看起来是不是同一个样"：数字按 eps 比，别的精确比。
   它是**唯一**的"没动"判据（`begin().end()` 用它），也是这一族唯一值得单独断言的东西。
   ⚠ 只比"有值"的键：板是 spread 出来的，`{ a: undefined }` 和"没有 a"是同一个意思
     （少了这条，一次 `{ ...cur, links: undefined }` 的搬运会被当成"动了"）。
   ⚠ 浮点坐标比的是**绝对差**，不是比例 —— 世界坐标里 0.5 就是 0.5，与缩放无关。 */
export function sameWithin(a, b, eps = MOVE_EPS) {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!sameWithin(a[k], b[k], eps)) return false
  }
  return true
}

/* 账本本体。
 *   get()            → 现在这一版板（唯一真相在调用方那边，通常是 boardRef）
 *   write(next)      → 把这一版写进去（写 ref + 触发重绘 + 标脏）
 *   onCount({undo, redo}) → 数数变了（调用方拿它去 setHist，按钮的置灰靠它）
 * 三个都是注入的 adapter —— 这也是"手势能纯逻辑断言"的前提。 */
export function createHistory({ get, write, onCount, max = UNDO_MAX, eps = MOVE_EPS, same = sameWithin }) {
  const undoStack = []
  const redoStack = []

  const report = () => {
    if (onCount) onCount({ undo: undoStack.length, redo: redoStack.length })
  }

  /* 记一步：塞进去、裁掉最老的、清掉重做。
     这三件事从前在四个手势里各抄了一遍 —— 现在只有这一处。 */
  function record(before) {
    undoStack.push(before)
    if (undoStack.length > max) undoStack.shift()
    redoStack.length = 0
    report()
  }

  /* 算出"下一版板"，但**不写**：调用方要的是 before / after / 有没有变。 */
  function compute(next) {
    const before = get()
    const after = typeof next === 'function' ? next(before) : next
    return { before, after, changed: after !== before }
  }

  /* 只改板、不记账（连续手势的中途，以及"这本来就不算一步"的改动，比如量尺寸）。
     返回"到底改没改"（`next` 返回同一个引用就是没改）。 */
  function apply(next) {
    const r = compute(next)
    if (r.changed) write(r.after)
    return r.changed
  }

  return {
    apply,

    /* 一步到位的改动（画一笔 / 加卡片 / 删卡片 / 改一个词）：改板 + 记一步。 */
    step(next) {
      const r = compute(next)
      if (!r.changed) return false
      write(r.after)
      record(r.before)
      return true
    },

    /* 一次连续手势：`begin` 之后只走 `during`，收尾 `end`。 */
    begin() {
      const before = get()
      let during = false
      let done = false
      return {
        during(next) {
          if (done) return during
          if (apply(next)) during = true
          return during
        },
        /* 真的动过才记一步。判据只有一条：收尾时那版板和起点是不是同一个样
           （连"中途动过又回到原点"也算没动 —— 那一步撤销按下去什么都不会变）。
           `end` 只算一次：连着调两次不会记两步（调用方那几处都靠"先清 ref 再调"
           来保证，但一层防御在这里更便宜）。 */
        end() {
          if (done) return false
          done = true
          if (!during) return false
          if (same(before, get(), eps)) return false
          record(before)
          return true
        },
      }
    },

    /* 撤销 / 重做。空栈时返回 false（不抛、不改板）—— 按钮那边靠 counts() 置灰。 */
    undo() {
      const prev = undoStack.pop()
      if (!prev) return false
      const now = get()
      write(prev)
      redoStack.push(now)
      report()
      return true
    },
    redo() {
      const next = redoStack.pop()
      if (!next) return false
      const now = get()
      write(next)
      undoStack.push(now)
      report()
      return true
    },

    /* 换了一份板（打开另一个文件 / 重载）→ 账本跟着归零。
       从前这一段是手写的三行（两个 ref 清空 + setHist({0,0})）。 */
    reset() {
      undoStack.length = 0
      redoStack.length = 0
      report()
    },

    counts() {
      return { undo: undoStack.length, redo: redoStack.length }
    },
  }
}
