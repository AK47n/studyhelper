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
 *   FOCUS_NONE · focusCard(id, editing?) · focusFrame(id, editing?) · focusInk(ids, cards?, box?)
 *   focusCardId(f) / focusFrameId(f) / focusInkIds(f) / focusInkCards(f) / focusInkBox(f) / editingCardId(f) / editingFrameId(f)
 *   beginEdit(f) / endEdit(f) / clearInkFocus(f, box?)
 *   isTextField(t) · PAPER_SELECTOR · onPaper(t, selector?)
 *   deleteIntent(focus, key, target, opts?) → { kind: 'none' | 'delete-card' | 'delete-ink' | 'dissolve-frame', … }
 *   escapeIntent({ focus, linkPick }) → { kind: 'none' | 'dismiss-link' |
 *                                         'end-frame-edit' | 'clear-focus' }
 * ⚠ 这里**不认识 React、也不认识板**：焦点是普通对象，target 只用到 `tagName` /
 *   `isContentEditable` / `closest()` 三样 —— 所以 `check-board` 的 [6t] 拿假 target 就能钉住整张表。
 */

/* ── 焦点值（一个记录，只有一种 kind）─────────────────────────────────────────
 * kind: 'none' | 'card' | 'frame' | 'ink'
 *   card / frame 带 `editing`（在就地改内容 / 改标题）
 *   ink 带 `ids`（框住的那几笔），可能还带 `cards`（**框住的卡片**）
 * ★ 没有"同时选中一张卡和一个板框"这种状态 —— 这正是这一刀要买的东西。
 *
 * ★★ 2026-09-21：`ink` 这个 kind 里多了 `cards` —— 框选现在会把**中心落在框里的卡片**
 *   一起框进来（用户的说法：「框选中任意的字迹——卡片都应该能够放大，旋转」）。
 *   为什么不新开一个 kind：**框住的那一撮东西仍然只有一种**（一次框选的产物），
 *   它不是"另外选中了一张卡"（那种互斥正是这个 module 要挡的）。
 *   为什么卡片**可以不写**（空数组时整个字段不出现）：和板文件里那些字段同一条纪律 ——
 *   "没有卡片"是绝大多数框选的状态，写一个 `cards: []` 出去只会让 deep-equal 断言
 *   和 UI 状态多一份噪音。读的那一侧一律走 `focusInkCards()`，拿到的是 `[]` 而不是 undefined。 */
export const FOCUS_NONE = Object.freeze({ kind: 'none' })

export const focusCard = (id, editing = false) => (id ? { kind: 'card', id, editing: !!editing } : FOCUS_NONE)
export const focusFrame = (id, editing = false) => (id ? { kind: 'frame', id, editing: !!editing } : FOCUS_NONE)
/* `box` = 这一次框选的那个矩形（世界坐标 `{x0,y0,x1,y1}`）。
 *
 * ★★ 2026-09-21：**框里空着也要留得下这个框**。
 *   用户原话：「我框选的肯定是 ppt 上的一部分或者解说卡片啊，我不可能框选我自己的字迹，
 *   但是他要求必须框选字迹，这个就有问题了」。
 *   根子就在这儿：框选的产物从前只有 `ids`（笔的 id），而"框里没有笔"被表达成
 *   `FOCUS_NONE` —— 那个**矩形**就跟着丢了。于是"圈住课件上的一块"这件事
 *   在系统里**根本无处表达**（框是真的拖了，可记录里一点痕都不剩），
 *   「？问这里」也就只能退回去要求"你得先框到字"。
 *   ⇒ 让这个矩形能自己立住：`focusInk([], [], box)` 是一个**合法的焦点**
 *     （kind 仍是 `ink`，只是 `ids` 空着）—— 它说的是"我圈了这一块地方"。
 *     一旦框里真有笔 / 卡片，`ids` / `cards` 照旧填上，行为一个字不变。
 *
 * ⚠ 为什么不做成第五种 kind（比如 `region`）：屏幕上的虚线框、整组拖动、手柄、
 *   删除、复制粘贴那一整套全是按 `kind === 'ink'` 认亲的（见下面 deleteIntent）。
 *   新开一种 kind = 把那一整套的判据全改一遍，而"圈了一块地方"和"圈住一撮东西"
 *   本来就是**同一件事**（只是那撮东西可能是空集）。少改一处判据就少一个静默错。
 * ⚠ 空框 + 空笔的旧写法 `focusInk([], [])` 仍然回 FOCUS_NONE（没给 box 就是"什么都没发生"）——
 *   这个函数有好几处调用方拿它当"清空"用，不能反过来。 */
export const focusInk = (ids, cards = [], box = null) => {
  const list = [...(ids || [])].filter(Boolean)
  const clist = [...(cards || [])].filter(Boolean)
  const b = normFocusBox(box)
  if (!list.length && !clist.length) return b ? { kind: 'ink', ids: [], box: b } : FOCUS_NONE
  return {
    kind: 'ink',
    ids: list,
    ...(clist.length ? { cards: clist } : {}),
    ...(b ? { box: b } : {}),
  }
}

/** 焦点里那个框：认得出就用，认不出就当没有（**不硬凑半个空壳**，和板文件那些字段同一条）。
 *  ⚠ 形状只认 `{x0,y0,x1,y1}` 四个数齐 —— 这个仓库里"框"有两种形状
 *    （另一种是 `{x,y,w,h}`），认错了不会崩，只会得到一个空的答案（踩过两次）。 */
function normFocusBox(box) {
  if (!box) return null
  const n = [box.x0, box.y0, box.x1, box.y1].map(Number)
  if (!n.every((v) => Number.isFinite(v))) return null
  return { x0: n[0], y0: n[1], x1: n[2], y1: n[3] }
}

/* 读：把那个值翻译成界面各处要问的那几个问题（每个问题都只有一个答案）。 */
export const focusCardId = (f) => (f && f.kind === 'card' ? f.id : null)
export const focusFrameId = (f) => (f && f.kind === 'frame' ? f.id : null)
export const focusInkIds = (f) => (f && f.kind === 'ink' ? f.ids : null)
/* 框里那些**卡片**的 id（没框卡片时是空数组，绝不是 undefined —— 调用方不用先判）。 */
export const focusInkCards = (f) => (f && f.kind === 'ink' ? f.cards || [] : [])
/** 焦点里那个"我圈了哪一块"的矩形（`{x0,y0,x1,y1}` 世界坐标；没有就是 null）。
 *  ★ 和 `focusInkIds` 的区别正是这一刀的要害：**框里有笔才有 ids，而框本身永远有**。 */
export const focusInkBox = (f) => (f && f.kind === 'ink' ? f.box || null : null)
export const editingCardId = (f) => (f && f.kind === 'card' && f.editing ? f.id : null)
export const editingFrameId = (f) => (f && f.kind === 'frame' && f.editing ? f.id : null)

/* 转移（纯函数，不动原记录）。 */
/** 就地改内容 / 改标题（只对当前那样东西有意义 —— 别的东西身上的编辑态不存在）。 */
export const beginEdit = (f) => (f && (f.kind === 'card' || f.kind === 'frame') ? { ...f, editing: true } : FOCUS_NONE)
/** 退出编辑（焦点**留着** —— Esc 第一下收编辑、第二下才取消选中）。 */
export const endEdit = (f) => (f && f.editing ? { ...f, editing: false } : f || FOCUS_NONE)
/** 只清"框住的墨迹"那一种（有几处从前就只清 inkSel，卡片 / 板框的选中留着 —— 不改行为）。
 *
 *  ⚠ 2026-09-21：给了 `box` 就是"**这一次框选发生了**，只是框里没笔"——
 *    那时要留下一个"只有框"的焦点，而不是清空（理由见 `focusInk` 那段）。
 *    不给 `box` 的调用方一个都没改：它们的语义就是"取消失焦"，拿到的是 FOCUS_NONE。
 *
 *  ⚠⚠ 2026-09-22 修一个**只看得见第一次**的 bug（用户报的「问这里依旧无法框选
 *    ppt 与解说卡片」）：原来写成 `if (f && f.kind === 'ink') return focusInk([], [], box)`，
 *    也就是**只有当焦点本来就是 ink** 时才留框。而用户最自然的那一次操作 ——
 *    打开板 → 切「⬚ 框选」 → 圈住课件上一块（**一筆都不圈**）—— 焦点本来是 `none`，
 *    于是框当场被丢掉，`sel.box` 是 null，「？问这里」永远是灰的。
 *    ⇒ 判据改成"**这次框选发生了没有**"（box 在不在），不是"焦点原来是什么"。
 *  ★ 为什么自检没抓到：`check-followup-browser` 的 [4′] 前面 [4] 先框住过一笔
 *    （焦点已经是 ink）—— 它是"沾了上一次的光"。**第一次空框**这条路从来没被走过。 */
export const clearInkFocus = (f, box = null) => {
  /* 卡片 / 板框那两种**原样返回**（哪怕给了框）—— 那几处从前就只清 inkSel。
     ⚠ 这条顺序不能倒：下面"box 在就留框"是**框选松手**那条路专用的，
        而 `setFocus(clearInkFocus)`（不给框）那几处的语义是"别的东西别动"。 */
  const k = f && f.kind
  if (k === 'card' || k === 'frame') return f
  /* box 在 = 这次框选真的发生了 → 留下一个"只有框"的 ink 焦点。
     ⚠ 交给 `focusInk`：认不出的框（NaN / 半截）它自己会退回 FOCUS_NONE，
       这里不另判一遍（两份判据就是"存得出去、读不回来"那一类错）。 */
  if (box) return focusInk([], [], box)
  return FOCUS_NONE
}

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
  /* ★ 框住的那些东西一起删（笔迹 + 顺手框进来的卡片，2026-09-21）。
     卡片那半只在**真有**时才写（没有卡片时连字段都不出现，和 focusInk 同一条纪律）——
     少了它，框住"几笔字 + 一张卡"按 Delete 会只删掉字，
     而屏幕上看起来就是"删除只做了一半"（卡片还杵在原地）。 */
  if (f.kind === 'ink') {
    /* ⚠ 只有框、框里什么都没有（2026-09-21 起合法：圈住课件上的一块去追问）→ 没东西可删。
       少了这一句，Delete 会变成 `{kind:'delete-ink', ids: []}` —— 一个"要删零样东西"
       的意图，而删除那一段对空数组**不一定**当成没事（它可能拿它去记一步撤销，
       于是账本上多出一步什么都不干的撤销）。 */
    if (!f.ids.length && !(f.cards || []).length) return { kind: 'none' }
    const out = { kind: 'delete-ink', ids: f.ids.slice() }
    if (f.cards && f.cards.length) out.cards = f.cards.slice()
    return out
  }
  if (f.kind === 'frame') return { kind: 'dissolve-frame', id: f.id }
  if (f.kind === 'card') return { kind: 'delete-card', id: f.id }
  return { kind: 'none' }
}

/* ── 按键：Esc ───────────────────────────────────────────────────────────
 * "一次只收一层"，顺序写在这里（从前散在 Board.jsx 的一串 if 里）：
 *   浮着的那排词 → 板框改名 → 取消焦点。
 * ★ Esc 是**全局**的（只有 Delete 那一族要区分纸面 / 浮层）。
 * ⚠ 这里原来还有一层「∈ 条件」的武装（`ui.condArm` → 'disarm-cond'）——
 *   它唯一的入口是关系面板，面板 2026-09-19 删掉了，这一层跟着走。
 *   把"指条件"请回来时这一层也要回来，而且必须排在"收词"**后面**（词更靠外一层）。 */
export function escapeIntent(ui = {}) {
  const f = ui.focus || FOCUS_NONE
  if (ui.linkPick) return { kind: 'dismiss-link' }
  if (f.kind === 'frame' && f.editing) return { kind: 'end-frame-edit' }
  return f.kind === 'none' ? { kind: 'none' } : { kind: 'clear-focus' }
}
