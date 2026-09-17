/* 焦点仲裁：**"现在焦点在谁身上"是一个值，按键该谁管是一个纯函数**。
 * （2026-09-17 架构 review 候选 7 —— 七条里唯一一条"要动大手术"的。）
 *
 * 为什么要有这个 module：白板从前把焦点散在**四个 useState** 上
 * （`selectedId` / `inkSel` / `selectedFrameId` / `editingId` / `frameEditId`），
 * 而"它们互斥"这条不变量**没有人写下来** —— 它靠二十处 ad hoc 的 if 维持：
 * 选卡片要清板框（`Board.jsx`)、选板框要清卡片、点空白清三个、Esc 清另一个子集……
 * 漏一处不会崩，只会**说不清**：Delete 的含义曾经是一个表达式
 * `selectedFrameId && !inkSel && !selectedId`，而三个删除分支各查**不同的子集**。
 * 更硬的一条：`Delete` 只在"不是 INPUT/TEXTAREA"时才拦 —— 关系面板里那些行是 `<button>`，
 * 于是"点一下面板里那一行（它顺手选中了板框）再按 Backspace"会被当成**纸面上**的删除：
 * 板框当场被拆开，而 `preventDefault()` 还顺手把浏览器的后退吞了。
 *
 * 现在：
 *   · 焦点是**一个记录**，互斥是**结构**的（一个记录只有一种 kind，不可能"同时选中两样"）；
 *   · 转移都是这里的纯函数（`focusCard` / `focusFrame` / `focusInk` / `beginEdit` / `endEdit` / …）；
 *   · "这一下该谁管"是这里的两个纯函数：`deleteIntent`（删除 / 拆开）与 `escapeIntent`（Esc），
 *     外加"这一下是冲纸面还是冲面板"的 `onPaper`。
 *
 * interface：
 *   FOCUS_NONE · focusCard(id, editing?) · focusFrame(id, editing?) · focusInk(ids)
 *   focusCardId(f) / focusFrameId(f) / focusInkIds(f) / editingCardId(f) / editingFrameId(f)
 *   beginEdit(f) / endEdit(f) / clearInkFocus(f)
 *   isTextField(t) · PAPER_SELECTOR · onPaper(t, selector?)
 *   deleteIntent(focus, key, target, opts?) → { kind: 'none' | 'delete-card' | 'delete-ink' | 'dissolve-frame', … }
 *   escapeIntent({ focus, linkPick, condArm }) → { kind: 'none' | 'dismiss-link' | 'disarm-cond' |
 *                                                  'end-frame-edit' | 'clear-focus' }
 * ⚠ 这里**不认识 React、也不认识板**：焦点是普通对象，target 只用到 `tagName` /
 *   `isContentEditable` / `closest()` 三样 —— 所以 `check-board` 的 [6t] 拿假 target 就能钉住整张表。
 */

/* ── 焦点值（一个记录，只有一种 kind）─────────────────────────────────────────
 * kind: 'none' | 'card' | 'frame' | 'ink'
 *   card / frame 带 `editing`（在就地改内容 / 改标题）
 *   ink 带 `ids`（框住的那几笔）
 * ★ 没有"同时选中一张卡和一个板框"这种状态 —— 这正是这一刀要买的东西。 */
export const FOCUS_NONE = Object.freeze({ kind: 'none' })

export const focusCard = (id, editing = false) => (id ? { kind: 'card', id, editing: !!editing } : FOCUS_NONE)
export const focusFrame = (id, editing = false) => (id ? { kind: 'frame', id, editing: !!editing } : FOCUS_NONE)
export const focusInk = (ids) => {
  const list = [...(ids || [])].filter(Boolean)
  return list.length ? { kind: 'ink', ids: list } : FOCUS_NONE
}

/* 读：把那个值翻译成界面各处要问的那几个问题（每个问题都只有一个答案）。 */
export const focusCardId = (f) => (f && f.kind === 'card' ? f.id : null)
export const focusFrameId = (f) => (f && f.kind === 'frame' ? f.id : null)
export const focusInkIds = (f) => (f && f.kind === 'ink' ? f.ids : null)
export const editingCardId = (f) => (f && f.kind === 'card' && f.editing ? f.id : null)
export const editingFrameId = (f) => (f && f.kind === 'frame' && f.editing ? f.id : null)

/* 转移（纯函数，不动原记录）。 */
/** 就地改内容 / 改标题（只对当前那样东西有意义 —— 别的东西身上的编辑态不存在）。 */
export const beginEdit = (f) => (f && (f.kind === 'card' || f.kind === 'frame') ? { ...f, editing: true } : FOCUS_NONE)
/** 退出编辑（焦点**留着** —— Esc 第一下收编辑、第二下才取消选中）。 */
export const endEdit = (f) => (f && f.editing ? { ...f, editing: false } : f || FOCUS_NONE)
/** 只清"框住的墨迹"那一种（有几处从前就只清 inkSel，卡片 / 板框的选中留着 —— 不改行为）。 */
export const clearInkFocus = (f) => (f && f.kind === 'ink' ? FOCUS_NONE : f || FOCUS_NONE)

/* ── "这一下是冲纸面还是冲面板" ──────────────────────────────────────────────
 * 判据：事件目标在**画布容器**里，或者压根没有焦点（body / html）→ 冲纸面；
 * 输入框 / 可编辑元素 / 别处（工具条、关系面板、左栏）→ 不算纸面。
 * ⚠ 从前这条判据是 `/^(INPUT|TEXTAREA)$/` 一条 tag 正则 —— 面板上的 `<button>` 不是
 *   input，于是"面板上的 Backspace"被当成了纸面上的删除（review 当场走到的那个 bug）。
 * ⚠ `.bd-stagewrap` 由调用方给（默认那个选择器写在这儿，因为它是这条政策的一部分）。 */
export const PAPER_SELECTOR = '.bd-stagewrap'

export function isTextField(t) {
  if (!t) return false
  const tag = t.tagName || ''
  return /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || t.isContentEditable === true
}

export function onPaper(t, selector = PAPER_SELECTOR) {
  if (!t) return true
  const tag = t.tagName || ''
  if (tag === 'BODY' || tag === 'HTML') return true
  if (isTextField(t)) return false
  return typeof t.closest === 'function' ? !!t.closest(selector) : false
}

/* ── 按键：删除 / 拆开 ─────────────────────────────────────────────────────
 * `deleteIntent(focus, key, target, opts)` → 这一下**该谁管、管什么**：
 *   · 不是 Delete/Backspace → { kind: 'none' }
 *   · 不是**冲纸面**的那一下 → { kind: 'none' }  ← 面板 / 工具条上的按键不算（那正是那个 bug）
 *   · 焦点在框住的墨迹上 → 删那几笔（{ kind: 'delete-ink', ids }）
 *   · 焦点在板框上 → 拆开那个框（{ kind: 'dissolve-frame', id }）—— 框还在、内容一个字不动
 *   · 焦点在卡片上 → 删那张卡（{ kind: 'delete-card', id }）
 * ★ "先看谁"这件事现在写在**类型**里：一个记录只有一种 kind，所以不可能出现
 *   "板框和墨迹同时选着，Delete 该听谁的" —— 那种事从前由三个分支的**先后**决定。 */
export function deleteIntent(focus, key, target, opts = {}) {
  if (key !== 'Delete' && key !== 'Backspace') return { kind: 'none' }
  if (!onPaper(target, opts.paperSelector)) return { kind: 'none' }
  const f = focus || FOCUS_NONE
  if (f.kind === 'ink') return { kind: 'delete-ink', ids: f.ids.slice() }
  if (f.kind === 'frame') return { kind: 'dissolve-frame', id: f.id }
  if (f.kind === 'card') return { kind: 'delete-card', id: f.id }
  return { kind: 'none' }
}

/* ── 按键：Esc ───────────────────────────────────────────────────────────
 * "一次只收一层"，顺序写在这里（从前散在 Board.jsx 的一串 if 里）：
 *   浮着的那排词 → 武装着的「∈ 条件」→ 板框改名 → 取消焦点。
 * ★ Esc 是**全局**的：在面板上按 Esc 也该收掉武装（只有 Delete 那一族要区分纸面 / 面板）。 */
export function escapeIntent(ui = {}) {
  const f = ui.focus || FOCUS_NONE
  if (ui.linkPick) return { kind: 'dismiss-link' }
  if (ui.condArm) return { kind: 'disarm-cond' }
  if (f.kind === 'frame' && f.editing) return { kind: 'end-frame-edit' }
  return f.kind === 'none' ? { kind: 'none' } : { kind: 'clear-focus' }
}
