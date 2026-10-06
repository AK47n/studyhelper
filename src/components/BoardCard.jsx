/* 板上那一张卡（2026-09-24 从 Board.jsx 搬出来）。
 *
 * ── 为什么分成两个组件 ────────────────────────────────────────────
 * CardItem 是**稳定外壳**（React.memo + useCallback 把回调钉住），
 * Card 才是真的那张卡。这一层的来龙去脉写在下面「一张卡的稳定外壳」那段
 * 注释里（2026-09-21 第九刀的性能修）：板上有 213 张卡时，视图每动一次，
 * 没有这一层就是 213 张卡连同 3 万个 DOM 节点全部重渲染。
 * ★ 外壳必须存在，不能用"给 Card 套 memo"代替 —— memo 只比 props，
 *   而 props 里那些内联箭头每帧都是新的，没有这一层它一个都拦不住。
 *
 * ⚠ 这个文件**不碰板的状态**：它只认传进来的 props 和"按 id 办事"的回调。
 * ⚠ 传进来的父级回调必须都是 useCallback 造的稳定引用（别在 render 里现写）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tex } from './Tex.jsx'
import { CARD_FONTS, CARD_PROVENANCE_KEYS, DEFAULT_CARD_FONT, fontCss, nextCardScale } from '../lib/board.js'
import { richHtml } from '../lib/rich.js'
import { displayTex, snippetFor, toTex } from '../lib/formula.js'
import { readFormula } from '../lib/calc.js'
import { combinedScale, worldLenToScreen } from '../lib/view.js'
import { ASK_MARK_GLYPH } from '../lib/answer-cards.js'
import { ASK_BUTTON } from '../lib/followup.js'
import { HW_BUTTON } from '../lib/homework.js'
import { linkKind } from '../lib/link-kinds.js'
import { snapNode } from '../lib/frames.js'
import { buildRelations } from '../lib/geometry.js'
import { translateShape } from '../lib/shape-object.js'
import { drawStroke } from '../lib/ink.js'
import BoardCanvas from './BoardCanvas.jsx'
import { Calc } from './BoardCalc.jsx'
import { DocBars } from './DocLayer.jsx'
import { parseBoardDocument } from '../lib/board.js'
import { applyViewTo, screenLenToWorld } from '../lib/view.js'

// ────────────────────────────── 卡片 ──────────────────────────────

/* ══════════ 一张卡的**稳定外壳**（2026-09-21 第九刀的性能修，见 README 第 58 条）══════════
 *
 * 为什么要有这一层（这是个纯性能外壳，不产生任何 DOM）：
 *   板上有 213 张卡时，缩放每改一次视图，Board 就重渲染一次。
 *   里面那些回调（`onSelect` / `onDrag` / `onStartResize` …）在 map 里是**内联箭头**，
 *   每一趟渲染都是**新函数** —— 于是 `React.memo` 一个都拦不住，
 *   213 张卡连同它们那 3 万个 DOM 节点全部重渲染 + 重新计算样式。
 *   （实测：视图里的 s 一变，卡片的 style 就要重算 —— 那正是 4 秒 layout 的来源。）
 *
 * 怎么解：把"内联箭头"换成**稳定的回调**。
 *   · 外壳自己用 `useCallback` 把每个回调包成稳定的（依赖只有 card.id / card 本身）；
 *   · 外壳收的是"按 id 办事"的**父级回调**（那些本来就是 useCallback 造的稳定引用）；
 *   · `React.memo` 的默认浅比较这时才真的能拦住 —— 卡片只在**它自己**变了时才重渲染。
 *
 * ★ 这一层必须存在、不能用"给 Card 套 memo"代替：`memo` 只比较 props，
 *   而 props 里那几个内联箭头每帧都是新的 —— 没有这一层把箭头稳定下来，
 *   memo 永远是"全都变了"，一个都拦不住。2026-09-21 第一版就是这么白改的。
 * ⚠ 所有传进来的父级回调都必须是 `useCallback`（或模块级函数）造的，别在 render 里现写。
 */
export const CardItem = React.memo(function CardItem({
  card,
  selected, dimmed, editing, inPick, askMarked,
  onSelectCard, onStartEditCard, onStartDragCard, onCommitCard, onCloseEditCard,
  onDragCard, onDragEndCard, onDeleteCard, onStartResizeCard, onToggleLockCard,
  onPickMove, onAskMarkCard,
}) {
  const id = card.id
  const onSelect = useCallback(() => onSelectCard(id), [onSelectCard, id])
  const onStartEdit = useCallback(() => onStartEditCard(id), [onStartEditCard, id])
  const onStartDrag = useCallback(() => onStartDragCard(card), [onStartDragCard, card])
  const onCommit = useCallback((patch) => onCommitCard(id, patch), [onCommitCard, id])
  const onCloseEdit = useCallback(() => onCloseEditCard(), [onCloseEditCard])
  const onDrag = useCallback((dx, dy) => onDragCard(id, dx, dy), [onDragCard, id])
  const onDragEnd = useCallback(() => onDragEndCard(), [onDragEndCard])
  const onDelete = useCallback(() => onDeleteCard(id), [onDeleteCard, id])
  const onStartResize = useCallback((rectW, startX) => onStartResizeCard(id, rectW, startX), [onStartResizeCard, id])
  const onToggleLock = useCallback(() => onToggleLockCard(id), [onToggleLockCard, id])
  const onAskMark = useCallback(() => onAskMarkCard(card), [onAskMarkCard, card])

  return (
    <Card
      card={card}
      selected={selected}
      dimmed={dimmed}
      editing={editing}
      inPick={inPick}
      askMarked={askMarked}
      onSelect={onSelect}
      onStartEdit={onStartEdit}
      onStartDrag={onStartDrag}
      onCommit={onCommit}
      onCloseEdit={onCloseEdit}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
      onDelete={onDelete}
      onStartResize={onStartResize}
      onToggleLock={onToggleLock}
      onPickMove={onPickMove}
      onAskMark={onAskMark}
    />
  )
})

function Card({ card, selected, dimmed, editing, inPick, onSelect, onStartEdit, onStartDrag, onCommit, onCloseEdit, onDrag, onDragEnd, onDelete, onStartResize, onToggleLock, onPickMove, onAskMark, askMarked }) {
  const dragRef = useRef(null)
  const taRef = useRef(null)
  const [draft, setDraft] = useState('')
  const [draftFont, setDraftFont] = useState(DEFAULT_CARD_FONT)
  const isFormula = card.kind === 'formula'

  /* 「这条式子能不能算」—— 见下面 `<Calc>` 那段。
     ★ 挂载后在 `useMemo` 里算一次就够：解析是纯函数，只有 src 变了才会不一样。
       别在 render 里直接调 —— 卡片每一次重渲染都要过一遍解析器，
       而卡片在视图变化时本来就可能被 framework 重画（见上面那层稳定外壳的说明）。 */
  const calc = useMemo(() => (isFormula && card.src ? readFormula(card.src) : null), [isFormula, card.src])
  const [calcOpen, setCalcOpen] = useState(false)
  const [calcVals, setCalcVals] = useState({})
  /* ★ 卡片不再被选中 ⇒ 把那个浮窗收掉。
     浮窗还挂在屏幕上、所属的那张卡却已经不在焦点里 —— 看着像它是谁的都分不清了。
     ⚠ 这里**不看 locked**：固定住的卡片也能是这个焦点（点不到整张卡，但按钮能点）。 */
  useEffect(() => {
    if (!selected) setCalcOpen(false)
  }, [selected])
  /* 固定（钉住）：这张卡不再收指针事件 —— 见下面 .bd-card.locked 和 pinCard 的说明。 */
  const locked = card.locked === true
  /* 卡片的"放大缩小"倍率（见 lib/board.js 的 nextCardScale）。
     一个数管全部：字号、内边距、圆角、宽高都乘它 ——
     只改宽高不把字号跟着变的话，卡片越拉越大、字还是那么小，看着像坏了。 */
  const k = Number(card.scale) > 0 ? Number(card.scale) : 1
  /* ★ 卡片自己的倍率 `ck` —— **只含卡自己的 k，不含视图 s**（2026-09-21 第九刀）。
     视图 s 那一份由外层 `.bd-cardworld` 的 transform 一次性给（见 README 第 58 条）。
     这样这张卡在缩放时**根本不需要重渲染**：它的 style 和视图无关。
     ⚠ 从前这里是 `combinedScale(view.s, k)`；`view` 依赖砍掉之后，
       拖缩放柄、改字号、写内容都还是照旧（那些改的是 card 自己的字段）。 */
  const ck = combinedScale(1, k)

  /* ⚠ 这个组件现在**收不到 `view`** —— 别把它加回来。
     它一旦依赖 view，213 张卡就会在每一次缩放时全部重渲染（4 秒 layout 就是这么来的）。 */

  useEffect(() => {
    if (!editing) return
    setDraft(isFormula ? card.src || '' : card.text || '')
    setDraftFont(card.font || DEFAULT_CARD_FONT)
    const raf = requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(raf)
  }, [editing, isFormula, card.src, card.text, card.font])

  function commitEdit() {
    if (isFormula) {
      /* ★ 空提交什么都不改。
         公式卡显示的是 tex，而编辑框里编辑的是 src ——
         一旦空串提交进来，下面这句 `tex: toTex(draft)` 会把 tex 清掉，
         整张卡变成"双击写公式"，而用户只是"想确认一下"。
         实测栽过一次（手写识别插入的卡片原来 src 是空的，一按回车就没了）。
         想清空有「删除」，想放弃有「取消」，所以这里把"空"当成"没有修改"。 */
      if (!draft.trim()) {
        onCloseEdit()
        return
      }
      onCommit({ src: draft, tex: toTex(draft) })
    } else {
      /* 文字卡不一样：这里**允许清空**（清空就是"这张卡不要了，但先留着框"）。
         但字体要一起提交 —— 用户可能只想换个字体，一个字都没动。 */
      onCommit({ text: draft, font: draftFont })
    }
    onCloseEdit()
  }

  let body
  if (editing) {
    body = (
      <div className="bd-card-edit" onPointerDown={(e) => e.stopPropagation()}>
        <textarea
          ref={taRef}
          value={draft}
          spellCheck={false}
          rows={1}
          /* 文字卡的编辑框里直接用它自己的字体写 —— 你在这儿选字体，
             看到的就该是那个字体的样子（而不是先保存、再看出效果）。 */
          style={isFormula ? undefined : { fontFamily: fontCss(draftFont) }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') {
              e.preventDefault()
              onCloseEdit()
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commitEdit()
            }
          }}
          placeholder={isFormula ? 'F = ma  ·  dS/dt  ·  sqrt(x^2+y^2)' : '一句话'}
        />
        {!isFormula && (
          <div className="bd-fonts">
            {CARD_FONTS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={'bd-font' + (draftFont === f.id ? ' on' : '')}
                style={{ fontFamily: f.css }}
                /* 不让按钮抢走焦点：在 textarea 里改字改到一半去点字体，
                   焦点一跳就没有光标了，回来还得再点一次输入框。 */
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setDraftFont(f.id)}
                title={f.note}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}
        {isFormula && (
          <div className="bd-mini-preview">
            {draft.trim() ? <Tex tex={toTex(draft)} block /> : <span className="dim small">上面写的会变成这样</span>}
          </div>
        )}
        {isFormula && (
          <div className="bd-snips">
            {SNIP_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  const el = taRef.current
                  const s = el ? el.selectionStart : draft.length
                  const t = el ? el.selectionEnd : draft.length
                  const ins = snippetFor(k, draft.slice(s, t))
                  setDraft(draft.slice(0, s) + ins + draft.slice(t))
                  const pos = s + ins.length
                  requestAnimationFrame(() => {
                    taRef.current?.focus()
                    taRef.current?.setSelectionRange(pos, pos)
                  })
                }}
              >
                {SNIP_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        <div className="bd-card-acts">
          <button className="mini" onClick={onCloseEdit}>取消</button>
          <button className="mini primary" onClick={commitEdit}>好了</button>
        </div>
      </div>
    )
  } else if (isFormula) {
    const tex = displayTex(card)
    body = tex ? <div className="bd-tex"><Tex tex={tex} block /></div> : <div className="bd-card-empty">双击写公式</div>
  } else {
    /* 文字卡按它自己选的字体渲染 —— "字变好看"就落在这一行上。
       字体是一串候选（见 board.js 的 CARD_FONTS），系统里装了哪个用哪个，
       一个字体文件都不下载。 */
    body = card.text
      ? card.rich
        ? /* 讲义卡（`rich: true`）：正文按"段落 + 列表 + 行内公式"排出来 ——
             讲老师讲解里那几条式子，必须排成式子学生才看得懂（见 rich.js 的文件头）。
             ⚠ 和量尺寸那一趟**共用 richHtml**：两边各拼一遍 DOM 的话，
               量出来的高度和真实渲染对不上，卡片就会互相压住。 */
          <div className="bd-note rich" style={{ fontFamily: fontCss(card.font) }} dangerouslySetInnerHTML={{ __html: richHtml(card.text) }} />
        : <div className="bd-note" style={{ fontFamily: fontCss(card.font) }}>{card.text}</div>
      : <div className="bd-card-empty">双击写字</div>
  }

  /* ★★ 卡片摆在世界坐标里（**不含视图**），视图变换由外层 `.bd-cardworld` 一层做完
     （2026-09-21 第九刀的性能修，见 README 第 58 条）。
     从前这里按 `屏幕 = 世界 * s + t` 算出 left/top，再把宽度、字号、内边距**逐张**
     乘上倍率 —— 于是**每一次缩放**都要改 213 张卡 × 每张 6 个属性，
     浏览器只能对这 3 万个 DOM 节点**全量重排**。实测用户那张 213 张卡的板：
     30 次滚轮花掉 7.4 秒，其中 **4.0 秒是纯 layout**（占 54%）。
     现在卡只写**世界坐标**（`left: card.x`）和它自己的倍率 `--bd-card-scale: k`，
     缩放只改容器那一行 transform → 浏览器走合成层，**一次 layout 都不用做**。
     ⚠ 上面那个"位置用 JS 算、不用 CSS transform"的老注释（2026-09-15 写的）
       担心的不是这件事：它担心的是**每张卡各写一次 translate**（那次是 14 处手抄）。
       现在只在**一个容器**上写一次，原点由 `transform-origin: 0 0` 钉死，
       和 canvas 的 `ctx.setTransform` 是同一条公式、同一个原点 —— 唯一的一份。
     判据：页面规模同样是 213 张卡时，30 次滚轮的 layout 必须掉到接近 0。 */
  return (
    <div
      className={'bd-card' + (isFormula ? ' is-formula' : ' is-note') + (locked ? ' locked' : '') + (selected ? ' on' : '') + (dimmed ? ' dim' : '') + (editing ? ' editing' : '')}
      /* 这两条 dataset 是给自检看的（浏览器里看不到卡片数据，
         而"插进去的是不是文字卡、字体对不对"只有真 DOM 能证明）。
         和画布那三个 dataset.strokes/pts/flat 是同一个道理。
         data-card-locked 也一样：锁定是个**行为**，自检要能一眼读到它。 */
      data-card-kind={card.kind}
      /* ★ 「这张卡是从哪儿来的」三个出处标记（提纲 / 做题须知 / 答案卡）——
         **从 `CARD_PROVENANCE` 那张清单展开**，不再一个个手写（2026-10-06 收拢）。
         出处是**独立字段**、不是 kind（见 placeDeckCards 那条注）。
         自检靠它们在屏幕上认出那几张（文件里靠 `sum: true` 那种字段）。
         ⚠ 属性名不能变（`data-card-sum` 等）—— `check-deck.js` 那些命中测试按它找。 */
      {...Object.fromEntries(CARD_PROVENANCE_KEYS.map((k) => [`data-card-${k}`, card[k] === true ? '1' : undefined]))}
      data-card-font={card.kind === 'note' ? card.font || DEFAULT_CARD_FONT : undefined}
      data-card-locked={locked ? '1' : undefined}
      /* data-card-id 是给"插完量一下真实高度"用的（fitCardHeight 靠它找内容元素）。
         id 只在文件内唯一，DOM 里也够用。 */
      data-card-id={card.id}
      /* ★ 位置和尺寸全是**世界坐标 / 世界长度**，一个 `view` 都不乘 ——
         这就是"缩放不再触发重排"的全部原因。视图那一份由 .bd-cardworld 统一给。
         卡自己的倍率 k（拖缩放柄改的那个）仍然留在卡上：它是**这张卡的身份**，
         不是视图状态，缩放时不该变。 */
      style={{
        left: card.x,
        top: card.y,
        width: card.w,
        minHeight: card.h,
        /* 卡自己的倍率（世界 × s × k 里的那个 k）。CSS 里只有一个 --bd-card-scale，
           字号、内边距、卡片内的空态提示都按它走 —— 卡片才是"整体一致地"变大变小。 */
        '--bd-card-scale': ck,
        /* 内边距从 10/12 收到 4/8（用户 2026-09-16：「边缘留白太多了」）。
           为什么不干脆给 0：字贴着边框线看着像画坏了，而且卡片一选中、
           边框一加粗就会压到字上。4px 是"看着贴、但不顶边"的那个数。 */
        padding: `${4 * ck}px ${8 * ck}px`,
        borderRadius: Math.max(3, 10 * ck),
        /* ★ 旋转（2026-09-21，用户要的「卡片都应该能够放大，旋转，这点类似 oneNote」）。
           绕**卡片自己的中心**转 —— `transform-origin` 显式写出来，不靠 CSS 默认值：
           `.bd-card` 哪天有人给它设了别的 origin（比如为了那个补正），
           旋转的轴就会悄悄跑到角上去（卡片会绕着角甩，而且看起来"像是我拖歪了"）。
           ⚠ 这条 transform **只管旋转**，绝不参与定位：位置还是上面那两行
             `left/top`（世界坐标）。README 第 3 条：同一个位移两处各表达一遍，
             就一定有一处会多加一次。
           ⚠ 没转过（`rot` 为 0/没有）时**一个字节的 style 都不写** ——
             和文件里那个字段同一条纪律（老卡片的 DOM 也纹丝不动）。 */
        ...(card.rot ? { transform: `rotate(${card.rot}rad)`, transformOrigin: '50% 50%' } : {}),
      }}
      onPointerDown={(e) => {
        /* ★ 固定住的卡片**什么都不接**：不选中、不拖动。
           CSS 那边已经给了 pointer-events: none（事件会落到下面的 .bd-hit，
           于是笔在这上面能写字、手指在这上面能平移），这里是第二道闸 ——
           万一以后有人给卡片加了个自己的可点区域，拖动的入口也不会漏。 */
        if (locked) return
        /* ★ 编辑态里**也能拖**，只要不是按在输入框/按钮上。
           原来这里是 `if (editing) return` —— 而"放到白板上"之后卡片就在编辑态，
           于是用户按它毫无反应，报的就是「卡片应该能够移动」（2026-09-16）。
           编辑器占的只是卡片中间那一块，四周的边留给人拖。 */
        if (editing && e.target.closest('textarea, button, input, .bd-snips')) return
        e.stopPropagation()
        /* ★★ 这张卡**在框住的那一块里** → 拖它 = 拖**整块**（2026-09-21）。
           为什么必须有这一条：卡片自己收指针事件（它比 .bd-hit 高一层），
           所以"按在卡片上"根本到不了 Board 里那个整组拖动的分支 ——
           不接这一条的话，症状是"框住字 + 卡，按着卡拖，只有卡动了"，
           屏幕上就是**拖散了**（和"只搬笔迹不搬卡片"是同一个错，换了个入口）。
           ⚠ 这里**不调用 onSelect()**：那会把焦点换成这张卡、整块选区当场散掉 ——
             而用户的意思明明是"动这一整块"。想单独动它就先点一下空白（取消选中）。 */
        if (inPick) {
          dragRef.current = { pick: true }
          e.currentTarget.setPointerCapture?.(e.pointerId)
          onPickMove?.(e, 'start')
          return
        }
        onSelect()
        onStartDrag?.()
        dragRef.current = { x: e.clientX, y: e.clientY, moved: false }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (!d || editing || locked) return
        /* 整块拖动那一条：坐标换算在 Board 那边（它才知道画布容器的原点）。 */
        if (d.pick) {
          onPickMove?.(e, 'move')
          return
        }
        /* 这里只报**屏幕位移**，换算成世界坐标由 Board 按当前缩放做 ——
           在这个闭包里读 view.s 会读到"按下那一刻"的缩放，
           缩放过一次之后拖动就会跑得比手指快/慢。 */
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) return
        d.x = e.clientX
        d.y = e.clientY
        d.moved = true
        onDrag(dx, dy)
      }}
      onPointerUp={() => {
        if (!dragRef.current) return
        /* 整块拖动那条路收尾：一次拖动 = 一步撤销（判"动没动过"由账本做）。 */
        if (dragRef.current.pick) onPickMove?.(null, 'end')
        else onDragEnd()
        dragRef.current = null
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        /* 固定的卡片双击也不进编辑态：用笔的时候双击太容易误触，
           而"我把它钉住了"这句话的意思就是"别动它"。
           想改内容就点一下 📌 解开 —— 那是个明确的动作。 */
        if (locked) return
        onStartEdit()
      }}
      title={
        locked
          ? '这张卡固定住了：拖不动、也不会误触（点左下角 📌 解开）'
          : '拖动挪位置 · 拖右下角放大缩小 · 双击改内容 · Delete 删掉 · 左下角 📌 固定住防误触（用笔时卡片让路，写在卡片上也画得出）'
      }
    >
      {/* 内容包一层：fitCardHeight 量的就是它的高度（量卡片自己等于量 min-height，
          永远量不出"其实只有一行字"）。这一层不参与任何布局计算，只是给量高度一个准星。 */}
      <div className="bd-card-body">{body}</div>

      {/* 「这条式子，代入数字算一算」那个浮窗。
          ⚠ 它挂在**卡片的 DOM 里面**：位置跟着卡片走（卡片被拖走它也跟着），
             不用另外去算"它在屏幕上的哪里" —— 和 .bd-card-pin 那一族同一条路。
          ⚠ 面板里的操作必须自己接住指针事件（见 `<Calc>` 的 onPointerDown）：
             否则按在输入框上就变成"开始拖这张卡"。 */}
      {calcOpen && calc && calc.ok && (
        <Calc
          parsed={calc}
          vals={calcVals}
          onVal={(k, v) => setCalcVals((m) => ({ ...m, [k]: v }))}
          onClose={() => setCalcOpen(false)}
        />
      )}

      {/* 固定：**锁定之后整张卡只剩这一个能点**（它自己带 pointer-events: auto），
          所以"钉死了拿不下来"这件事不会发生。
          没锁的时候只在你选中它时出现 —— 和 × / 缩放柄同一个规矩：
          不选中时卡片上一个手柄都不该有（这条也是踩过的，见 README 第 14 条）。
          ⚠ 位置在**左下角**（.bd-card-pin 的 CSS）：左上角是"抓住卡片拖走"最顺手的
            那一点，放个按钮在那儿就等于把拖动变成点按钮 —— 这条真踩过，
            `check-ocr-browser` 的拖动断言当场变成"拖不动（0, 0）"。 */}
      {(locked || (selected && !editing)) && (
        <>
          <button
            className={'bd-card-pin' + (locked ? ' on' : '')}
            /* 给自检用的钩子：这个按钮**点了会发生什么**（lock / unlock）。
               光看 📌 和 📍 两个 emoji 分不出状态，而"锁定/解锁"正是要断言的。 */
            data-card-pin={locked ? 'unlock' : 'lock'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onToggleLock?.()
            }}
            title={locked ? '解开：解开就又能拖了' : '固定住：拖不动、双击也不会进编辑（防误触）'}
          >
            {locked ? '📌' : '📍'}
          </button>
          {/* ★ 「◎ 问我圈的是哪一块」（ADR-0006）：只有「留到板上」留下的答案卡才有
              （卡片上那个 `ask` 字段就是为它存在的 —— 不然它是一堆没人读的字节）。
              点一下在板上亮出当时圈的那一块，再点收起。
              ⚠ 和 📌 一起出现在**左下角那一排**：那是锁定卡片上唯一还能点的一带
                （锁定之后整张卡只剩这几颗按钮收事件）。图标用 `data-card-ask` 报状态，
                和 `data-card-pin` 同一条规矩 —— emoji/字形分不出"亮着还是收着"。 */}
          {card.ask && (
            <button
              className={'bd-card-ask' + (askMarked ? ' on' : '')}
              data-card-ask={askMarked ? 'hide' : 'show'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onAskMark?.()
              }}
              title={
                askMarked
                  ? '收起那一圈（这张卡问的是第 ' + card.ask.page + ' 页上的一块）'
                  : '这张卡问的是第 ' + card.ask.page + ' 页上的哪一块 —— 点一下在板上亮出来'
              }
            >
              {ASK_MARK_GLYPH}
            </button>
          )}
          {/* 「这条式子，代入数字算一算」—— 只有公式卡、而且我真的读得懂它才有这一颗。
              ★ 放在**这一组**（而不是下面"选中且没锁"那一组）：
                课件整理推上来的公式卡**默认是固定住的**（见 README「固定」那条），
                摆到下面那一组的话，恰恰是**最需要它的那些卡没有这颗按钮**。 */}
          {calc && calc.ok && (
            <button
              className={'bd-card-calc' + (calcOpen ? ' on' : '')}
              /* 同样是给自检看的钩子：emoji / 字形分不出"开着还是关着"。 */
              data-card-calc={calcOpen ? 'close' : 'open'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setCalcOpen((v) => !v)
              }}
              title={calcOpen ? '收起' : '把数代进去算一算（这条式子我读得懂）'}
            >
              =
            </button>
          )}
        </>
      )}

      {selected && !editing && !locked && (
        <>
          <button
            className="bd-card-del"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="删掉这张（Ctrl+Z 能撤销）"
          >
            ×
          </button>
          {/* 缩放柄：拖它按比例放大缩小**整张卡**（字跟着一起变）。
              手势本身在 startResize 里（window 级监听）—— 这里只负责"按下"。
              手柄这么小，靠它自己的 onPointerMove 收后续事件是收不到的。 */}
          <div
            className="bd-card-resize"
            title="拖这里放大缩小：字会跟着一起变（双击卡片可以改内容）"
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              const host = e.currentTarget.closest('.bd-card')
              /* ⚠ `offsetWidth`（布局宽）而不是 `getBoundingClientRect().width`：
                 卡片转过之后后者是**斜着的外接框**，拖缩放柄的手感会跟着歪
                 （倍率算成"外接框 / 布局框"那个虚高的数）。见 sampleCardForFit 那段。
                 ★ 2026-09-21 起 `offsetWidth` 是**世界宽**（卡片按世界坐标摆，
                   视图由外层容器缩放）—— 这对这个手势是**更好**了：
                   倍率算出来和当前缩放无关，放大到 4 倍时拖柄的速度也还是 1:1。
                 ⚠ 兜底用 `card.w`（世界宽），不是 `worldLenToScreen(card.w, f)`：
                   后者会把当前缩放乘进去，和上面那个 offsetWidth 差一个 s。 */
              const rectW = host ? host.offsetWidth : card.w
              onStartResize?.(rectW, e.clientX)
            }}
          >
            ⤡
          </div>
        </>
      )}
    </div>
  )
}

const SNIP_KEYS = ['frac', 'sqrt', 'sup', 'sub', 'mu0', 'pi', 'cdot', 'int', 'sum', 'vec']
const SNIP_LABEL = { frac: 'a/b', sqrt: '√', sup: 'xⁿ', sub: 'xₙ', mu0: 'μ₀', pi: 'π', cdot: '·', int: '∫', sum: 'Σ', vec: '向量' }

/* Tex 搬去了 ./Tex.jsx（手写识别也要用它，留在这儿会绕出循环依赖）。 */

