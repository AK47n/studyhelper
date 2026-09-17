/* 卡片「按内容量尺寸」—— 量什么、什么时候量得准、什么时候算稳定。
 *
 * 为什么单开一个 module（2026-09-16 架构 review 的 N2）：
 *   README 第 15/16/17 条那三个真坑，全在 Board.jsx 的 `fitCardSize` / `runPendingFits` /
 *   `queueFormulaRefits` 里 —— 而它们是**没导出**的闭包，于是自检里只有 board.js 那两行
 *   换算（`cardHeightFromContent` / `cardWidthFromContent`）有断言，真正出过事的三条规矩
 *   一条都钉不住：
 *     ① **量之前 DOM 的宽度必须已经等于数据里的宽度**（对不上就 'stale'，下一帧再来）——
 *        不然同一帧里量第二趟，量到的是上一次渲染的世界，高度会被钉死（实测钉在 94.4，
 *        正确值 66），而且重开文件才好（错值已经存进盘了）。
 *     ② **稳定性要两条轴都稳**才算数 —— 只比宽度的话，"宽度不变、高度还在收敛"那一趟
 *        会被误判成收敛，直接收工。
 *     ③ **编辑态量不得** —— 那时候卡片里装的是编辑器（输入框 + KaTeX 预览 + 一排符号
 *        按钮），量出来是编辑器的尺寸（实测把 h 写成 204，是真正内容的好几倍）。
 *   这一族从前只能靠真浏览器手工验（唯一完整对手盘长期留在被 gitignore 的
 *   `.cache/refit-test.mjs` 里，而且它拿用户那张板当夹具）。
 *
 *   现在：**DOM 读数 / 提交 / 帧调度都是注入的适配器**，策略本身是纯的 ——
 *   上面三条第一次能在 `check-board.js` 的 [6l] 里断言（假 sample、假时钟、假板），
 *   而"接线对不对"由 `check:refit`（真浏览器 + 自己的夹具板）管。
 *
 * interface：
 *   fitPass(sample, opts)                     量一趟（纯函数）
 *     sample —— 调用方采好的**同一瞬间**的读数（见下），或者 { state: 'missing' | 'gone' | 'wait' }
 *        { state: 'ok', card, s, domW, bodyH, padX, padY, naturalW?, spillPx?, texClientW? }
 *        · card      这张卡现在的数据（要用它的 w / h / scale / x）
 *        · s         视图缩放（屏幕 = 世界 × s + t 里的 s）
 *        · domW      卡片现在的**屏幕宽度** —— 动尺子之前先拿它和数据里那个宽度对一次
 *        · bodyH     **内容**（.bd-card-body）的屏幕高度，不是卡片自己的
 *                    （卡片的 min-height 就是 h，量它等于量自己）
 *        · padX/padY 这张卡左右/上下的内边距 + 边框（屏幕像素，从 computed style 读）
 *        · naturalW  内容的**自然宽度**（临时放开成 max-content 量的）
 *        · spillPx / texClientW  溢出量（scrollWidth − clientWidth）和它当时的 clientWidth
 *        opts.fitWidth=false 时不量宽度，后三个可以不给。
 *     → { state: 'gone' | 'missing' | 'wait' | 'stale' | 'done' | 'commit', w, h, need, needH, patch? }
 *       'commit' 时 patch 就是要写进那张卡的字段（含 keepCenterX 那一下的 x）
 *   createCardFitter({ sample, commit, frame, later, report, maxTries })
 *     · sample(cardId, { fitWidth }) → 上面的 sample（**唯一的 DOM 依赖**）
 *     · commit(cardId, patch)        → 把尺寸写进板（Board.jsx 走它那个 commit）
 *     · frame(fn) / later(fn, ms)    → 下一帧 / 稍后再来一趟（注入，好在自检里把握节奏）
 *     · report(card, info)           → 诊断：把这一趟量到了什么记在 data-fit 上（自检读它）
 *     → { queue, queueFormulaRefits, kick, clear, run, size }
 */

import { cardHeightFromContent, cardWidthFromContent } from './board.js'
import { combinedScale, worldLenToScreen } from './view.js'

/* 门槛与节奏 —— 只在**这一处**定，别在调用方写死。
   · ONCE：一次性拟合（刚插进来那张卡），量多准写多准。
   · AUTO：自动重量（开板 / 板子安静下来）。★ 1.5 这个数不是精度问题，是**别每次打开
     都改一遍文件**：差 1~2 个世界像素肉眼看不出，而内容是文字度量，KaTeX 的字体换进来
     前后能量出 1px 上下的差别（实测同一张卡冷启动 34.1、热一点 34.9）。不留余量就是
     "每天一条假 diff、然后你学会忽略 diff"的开端。
   · STABLE_EPS：连续两趟量出的需求差多少算"同一个数"。
   · MAX_TRIES：一条卡最多量几趟（字体加载完毕之前可能一直不稳，得有个头）。 */
export const FIT_TOL_ONCE = 0.6
export const FIT_TOL_AUTO = 1.5
export const FIT_STABLE_EPS = 1
export const FIT_MAX_TRIES = 12
export const FIT_LATER_MS = 150
/* DOM 上的宽度和数据里的宽度差多少算"还没跟上"（屏幕像素）。
   高度不一样没关系 —— 写的是 min-height，布局尺寸只由宽度决定。 */
export const FIT_STALE_PX = 1

/** 量一趟（纯函数）。sample 见文件头；opts: { fitWidth, tol, keepCenterX } */
export function fitPass(sample, opts = {}) {
  const state = sample && sample.state
  if (state === 'gone') return { state: 'gone' }
  if (state === 'wait') return { state: 'wait' }
  if (state !== 'ok') return { state: 'missing' }

  const card = sample.card
  if (!card) return { state: 'gone' }
  const s = Number(sample.s) || 1
  const scale = Number(card.scale) || 1

  /* ★★ 坑 ①：先确认 DOM 上这张卡的宽度**已经是数据里的宽度**，再动尺子。
     宽度那一条改完要等 React 重渲染，而"量尺寸"可能在同一帧里被叫第二次
     （几处调用点都会排上 rAF）—— 那时候量到的是**上一次渲染的世界**：
     宽度还是旧的，文字就还是折成旧行数，高度会被算错并钉死。
     对不上就返回 'stale'，下一帧再来。
     （同族的记法：**提交完不能立刻再量 —— 你量的是上一次渲染的世界。**） */
  /* 这张卡的屏幕宽度 —— 走 view.js 那条"带倍率的世界长度"，
     别在这里手写 `card.w * s * scale`（渲染那一处也是同一个调用，口径只有一处）。 */
  const wantW = worldLenToScreen(card.w, combinedScale(s, scale))
  const domW = Number(sample.domW) || 0
  if (Math.abs(domW - wantW) > FIT_STALE_PX) return { state: 'stale', wantW, domW }

  /* 高度：内容多高 + 上下内边距边框，除以（视图缩放 × 卡片倍率）→ 世界坐标的 h。 */
  const h = cardHeightFromContent(sample.bodyH, { s, scale, padPx: sample.padY })

  let w = card.w
  let need = h
  if (opts.fitWidth) {
    /* 宽度取"自然宽度"和"当前宽度 + 溢出量"里大的那个：
       字体没就绪时 max-content 可能偏小，而溢出量（scrollWidth − clientWidth）任何情况下都准。 */
    const spill = Number(sample.spillPx) || 0
    const needPx = Math.max(Number(sample.naturalW) || 0, spill ? (Number(sample.texClientW) || 0) + spill : 0)
    w = cardWidthFromContent(needPx, { s, scale, padPx: sample.padX })
    need = needPx
  }

  const tol = opts.tol != null ? opts.tol : FIT_TOL_ONCE
  const patch = Math.abs(h - card.h) < tol && Math.abs(w - card.w) < tol ? null : { w, h }
  /* keepCenterX：写字板那条路是"以视野中心"把卡片放上去的 —— 宽度一收，要让它
     **从中间缩**，不然卡片会突然往左跳一截。「框选」那条路钉在笔迹左上角，左上角不能动。 */
  if (patch && opts.keepCenterX) patch.x = card.x + (card.w - w) / 2

  return { state: patch ? 'commit' : 'done', w, h, need, needH: h, patch }
}

/* 量尺寸的队列 + 稳定性/重试策略。所有外部动作（读 DOM、提交、调度）都是注入的。 */
export function createCardFitter({ sample, commit, frame, later, report, maxTries = FIT_MAX_TRIES } = {}) {
  const pending = new Map()
  let framePending = false

  const run = () => {
    let retryFrame = false
    let tryLater = false
    for (const [id, opts] of [...pending]) {
      const snap = sample(id, { fitWidth: !!opts.fitWidth })
      const r = fitPass(snap, opts)
      /* 诊断先写：不然"量了但觉得不用改"的那一趟不留痕迹，而那正是最需要看的状态
         （实测就是靠 data-fit 看明白第 17 条那个坑的：need=281.3、h=94.4、tries=0）。 */
      if (report && snap && snap.card) {
        report(snap.card, {
          need: Math.round((r.need || 0) * 10) / 10,
          tries: opts.tries || 0,
          w: r.w,
          h: r.h,
          state: r.state,
        })
      }
      if (r.state === 'gone') {
        pending.delete(id) // 卡片已经从板里没了：别再找了
        continue
      }
      if (r.state === 'missing' || r.state === 'stale') {
        retryFrame = true // 还没挂上 / DOM 还没跟上上一次提交 —— 下一帧再来
        continue
      }
      if (r.state === 'wait') continue // 编辑态，等 editingId 一变再来（那时候调用方会 kick）

      if (r.state === 'commit') commit(id, r.patch)

      /* ★★ 坑 ②：稳定性要**两条轴都稳**才算数。
         只比宽度的话，"宽度不变、高度还在收敛"那一趟会被误判成收敛。 */
      const stableH = opts.lastNeedH != null && Math.abs(r.needH - opts.lastNeedH) < FIT_STABLE_EPS
      const stableW = opts.lastNeed != null && Math.abs(r.need - opts.lastNeed) < FIT_STABLE_EPS
      opts.lastNeed = r.need
      opts.lastNeedH = r.needH
      opts.tries = (opts.tries || 0) + 1
      if ((stableH && stableW) || opts.tries >= maxTries) {
        pending.delete(id)
        continue
      }
      pending.set(id, opts)
      tryLater = true
    }
    if (retryFrame) kick()
    if (tryLater) later(kick, FIT_LATER_MS)
  }

  /* 下一帧跑一趟（**合并**同一次里的多次请求：几处调用点在同一个 tick 里排队时，
     原来会排上好几个 rAF —— 同一帧里连跑两趟正是坑 ① 的现场）。 */
  function kick() {
    if (framePending) return
    framePending = true
    frame(() => {
      framePending = false
      run()
    })
  }

  /* ★ 排队**自己就会开跑**：排了队不叫 scheduleFits 就等于什么都没发生，而且屏幕上
     完全看不出来（第一版就是这样：卡片纹丝不动，量尺寸那几趟一趟都没跑）。
     已经在队里的**不覆盖** —— 刚插进来那张可能带着自己的选项（比如 keepCenterX）。 */
  function queue(id, opts = {}) {
    if (!pending.has(id)) pending.set(id, { ...opts })
    kick()
  }

  /* 把这张板上所有**有内容的公式卡**排进"重新量一次"的队里。两个调用点共用这一份规矩：
     换文件/重载那一趟（先 clear 再排）、以及板子安静下来之后那一趟（防抖 400ms）。
     ⚠ **只管公式卡，便签/文字卡不在这里自动收**：便签在这个应用里有个"容器"身份
       （关系面板那条「公式卡整个落在便签里 → 包含」就是靠"便签比自己的字大一圈"成立的）——
       实测把便签也一起自动收之后，样板板的 3 条连线当场变成 0 条，关系推理整块塌掉。
       刚认出来的文字卡照样贴合内容（那一刻由插入路径排一次量尺寸）。
     ⚠ 空白卡（"双击写公式"/"双击写字"那个占位）不排 —— 还没有内容可量。 */
  function queueFormulaRefits(board) {
    if (!board) return
    for (const c of board.cards || []) {
      if (c.kind !== 'formula') continue
      if (!String(c.tex || c.src || '').trim()) continue
      if (pending.has(c.id)) continue
      pending.set(c.id, { fitWidth: true, tol: FIT_TOL_AUTO })
    }
    kick()
  }

  /** 全清（换文件/重载时用） */
  function clear() {
    pending.clear()
  }

  return { queue, queueFormulaRefits, kick, clear, run, get size() { return pending.size } }
}
