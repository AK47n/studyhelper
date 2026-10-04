/* 板周围那一圈界面：公式架 / 工具条 / 空板提示（2026-09-24 从 Board.jsx 搬出来）。
 *
 * 这三样是一伙的：都是"贴在板边上、不参与板的内容"的壳子 ——
 * 它们收的是"现在选了什么笔 / 纸 / 要不要开架"，往外吐的是"用户点了什么"。
 *
 * ⚠ 纸面和笔的那些选项在 lib/skin.js（Board.jsx 也要用，所以不在任何一个组件里）。
 * ⚠ 工具条是**浮在画布上**的：卡片"装回屏幕"那一套要扣掉它占的高度
 *   （见 README「手柄点不到」那一节）—— 别把它改成画布里的一层。
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tex } from './Tex.jsx'
import BoardCanvas from './BoardCanvas.jsx'
import { DocBars } from './DocLayer.jsx'
import { ASK_BUTTON } from '../lib/followup.js'
import { HW_BUTTON } from '../lib/homework.js'
import { shelfItems } from '../lib/formula-shelf.js'
import { COLORS, WIDTHS, PAPERS } from '../lib/skin.js'
// ────────────────────────────── 公式架 ──────────────────────────────

/* 一条随手可取用的公式横条（用户 2026-09-20 要的那件事）。
 *
 * 两种取用法都在**同一串指针事件**里，判据只有一条"动了没有"：
 *   按下 → 松手，中间没动过 = **点**（放到视野中心）；
 *   按下 → 拖出 4px 再松手 = **拖**（落在松手的地方）。
 * 为什么不拆成 onClick + onDragStart：HTML5 那套拖放和这个应用的指针世界
 * （指针种类、指针捕获、笔）是两套东西，混用会多出一堆"笔拖不动"的怪事；
 * 而这一个组件里两种动作本来就是同一件事的两半。
 *
 * ⚠ 4px 是**手指/笔也会抖**的那个量级：太小会把"点一下"误判成拖，
 *   太大则"想拖一点点"没反应。和别处的手势阈值同类（见 README 的"手势"那条）。
 * ⚠ 拖的时候那张跟着指针走的"影子"要 `pointer-events: none` ——
 *   否则它自己会接走 pointerup，松手落在影子卡上就丢失了（那种 bug 的表现是
 *   "拖了半天，一松手什么都没发生"）。 */
const SHELF_DRAG_PX = 4

export function FormulaShelf({ items, onUse, onDrop, onClose }) {
  const pressRef = useRef(null)
  const [dragAt, setDragAt] = useState(null)

  const down = (e, item) => {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    pressRef.current = { item, x0: e.clientX, y0: e.clientY, moved: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 捕获不到也能用（事件照样冒泡到这一格上）—— 别为它崩 */
    }
  }
  const move = (e) => {
    const p = pressRef.current
    if (!p) return
    if (!p.moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < SHELF_DRAG_PX) return
    p.moved = true
    setDragAt({ item: p.item, x: e.clientX, y: e.clientY })
  }
  const up = (e) => {
    const p = pressRef.current
    pressRef.current = null
    setDragAt(null)
    if (!p) return
    if (p.moved) onDrop(p.item, e.clientX, e.clientY)
    else onUse(p.item)
  }

  return (
    <div className="bd-shelf" data-shelf="1">
      <div className="bd-shelf-h">
        <span className="bd-shelf-title">∑ 公式架</span>
        <span className="bd-shelf-note">
          这张板上认过的公式都在这儿（同一条公式只占一格）· <b>点</b>一下放到眼前 · <b>拖</b>到板上指哪放哪
        </span>
        <button className="bd-shelf-x" onClick={onClose} title="收起（F）">
          ×
        </button>
      </div>
      <div className="bd-shelf-row">
        {items.map((it) => (
          <button
            key={it.key}
            className={'bd-shelf-chip' + (dragAt && dragAt.item.key === it.key ? ' on' : '')}
            data-shelf-chip="1"
            data-shelf-tex={it.tex || it.src}
            title={(it.src || it.tex) + (it.count > 1 ? `\n（板上有 ${it.count} 处）` : '')}
            onPointerDown={(e) => down(e, it)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
              pressRef.current = null
              setDragAt(null)
            }}
          >
            <Tex tex={it.tex || it.src} />
            {it.count > 1 && <span className="bd-shelf-n">×{it.count}</span>}
          </button>
        ))}
      </div>
      {dragAt &&
        /* ★ 影子卡必须**挂到 body 上**（portal），不能留在架子里面。
           2026-09-20 用户报的「拖动过程的可视化不要突然出现在末尾」就是这条：
           `.bd-shelf` 有 `backdrop-filter`（毛玻璃），而**带 filter / backdrop-filter
           的元素会成为 `position: fixed` 后代的包含块** —— 于是 `left/top` 写的是
           视口坐标，画出来却是"架子左上角 + 视口坐标"，整张影子卡跑到视口外面
           （实测偏离指针 (297, 537) = 架子自己的位置 + 那 14px 偏移）。
           症状极像"功能没做"：拖的时候屏幕上什么都没有，一松手卡片才在落点冒出来。
           实测数据与做法见 `.cache/probe-ghost.mjs`（探针已删，结论在 check:shelf 的断言里）。 */
        createPortal(
          <div className="bd-shelf-ghost" style={{ left: dragAt.x + 14, top: dragAt.y + 15 }}>
            <Tex tex={dragAt.item.tex || dragAt.item.src} />
          </div>,
          document.body
        )}
    </div>
  )
}

// ────────────────────────────── 工具条 ──────────────────────────────

/* ⚠ `onPickArrow` 是**切到箭头工具**的唯一入口（按 A 那一条路也走它）——
   别在这里自己写 `setTool('arrow')`：那一句提示（`flash`）只有 Board 拿得到，
   在这里写一遍就是 2026-09-24 修掉的那个 `ReferenceError`。

   ── 「⋯ 更多」菜单（2026-09-26 收纳）──────────────────────────────
   为什么收：1440 宽的笔记本（最常见的那一档）上工具条挤成两行，
   每多一行就从画布底下啃 34px（见 styles.css .bd-tools 那段警告）。
   收进去的是**低频**的那几样：出网四件套（插入 PDF / 课件整理 / 作业辅导 /
   收成笔记 —— 一次课点不了几回）、界面字号、背景纸、画布缩放、全屏。
   留在条上的是"手上"的那几样：五种工具、颜色粗细、认一族（手写公式 /
   美化手写 / 问这里 / 公式架）、撤销重做粘贴。

   ⚠ 三条实现纪律（都有自检钉着）：
   ① 菜单弹层**常驻 DOM**（closed 态只是 display:none）—— 自检脚本里
     `elem.click()` 这条路在隐藏元素上照样触发 React 的 onClick
     （check-paper 的四种纸、check-board-browser 的"画布缩小"都靠它，不用改）。
   ② 但**真鼠标**那几处（check-deck 的课件整理、check-gather / check-ocr-browser
     的收成笔记 —— `elementFromPoint` 必须命中按钮自己）必须先点开菜单再量坐标。
     菜单开着时那些按钮是真的可见可点的，所以脚本只加了"先点 ⋯"这一步。
   ③ 弹层用 `position: absolute` 挂在这一组里 —— **别用 fixed**：
     `.bd-tools` 有 `backdrop-filter`（毛玻璃），fixed 后代的包含块会被它劫持
     （公式架影子卡那个坑，见上面 FormulaShelf 里的长注释）。 */
export function Toolbar({ tool, setTool, onPickArrow, color, setColor, width, setWidth, paper, onPaper, onWriteFormula, onBeautify, onAsk, onLook, onGather, onInsertDoc, docBusy, deckBusy, docs = [], onReadDeck, onHomework, onUnlockAll, onResetGestures, onPaste, onUndo, onRedo, canUndo, canRedo, onFit, onZoom, scale, onScale, onScaleReset, dirty, fullscreen, onToggleFullscreen, shelfOpen, shelfCount, onToggleShelf, onHelp }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef(null)

  /* 点外面收 + Esc 收。两条都走**捕获阶段**：
     · pointerdown 捕获才能抢在画布"点空白清选区"这类处理之前把菜单收掉（只收菜单，不影响别人）；
     · keydown 捕获 + stopPropagation：Esc 这一下**只**收菜单 ——
       不拦的话 Board 的 Esc 处理器会同时跑（把你正选着的东西一起清了）。 */
  useEffect(() => {
    if (!moreOpen) return
    const down = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false)
    }
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMoreOpen(false)
      }
    }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [moreOpen])

  const busy = docBusy || deckBusy

  return (
    <div className="bd-tools">
      <div className="bd-group">
        <button className={'bd-t' + (tool === 'pen' ? ' on' : '')} data-tool="pen" onClick={() => setTool('pen')} title="笔（P）：手写笔默认就是这个">
          ✎ 笔
        </button>
        <button className={'bd-t' + (tool === 'highlighter' ? ' on' : '')} data-tool="highlighter" onClick={() => setTool('highlighter')} title="荧光笔：盖在字上做记号">
          ▬ 荧光
        </button>
        <button className={'bd-t' + (tool === 'eraser' ? ' on' : '')} data-tool="eraser" onClick={() => setTool('eraser')} title="橡皮（E）：碰到哪一笔就擦掉整笔">
          ◻ 橡皮
        </button>
        {/* 箭头（A）：从一样东西划到另一样东西，松手就连上（见 ADR-0001）。
            一次性的 —— 画完自己回到笔，因为"两个板块之间连一笔"通常就是一笔。
            它**不落墨**：屏幕上那条箭头是应用画的（贴着框/卡的边、跟着它们走）。 */}
        <button
          className={'bd-t' + (tool === 'arrow' ? ' on' : '')}
          data-tool="arrow"
          onClick={() => onPickArrow()}
          title="箭头（A）：从一样东西划到另一样东西，松手就连上。一次性 —— 画完自动回到笔；纸上不留墨，那条线是应用画的"
        >
          → 箭头
        </button>
        {/* 框选（S）：拖一个矩形圈住一块地方。原来只有"笔杆侧键"这一条路，
            所以用鼠标、或者笔上没有侧键的人根本选不中笔迹 —— 认公式/美化也就无从谈起。
            ⚠ 说明里**别再写"圈住要认的手写"**（2026-09-21 改）：圈住这块地方既能认自己的
              手写，也能对着课件上的那一块「？问这里」问为什么 —— 后一条要圈的就是**课件**
              （用户原话：「我框选的肯定是 ppt 上的一部分…不可能框选我自己的字迹」）。
              按老说明写，用户会以为这个工具是给手写用的、跟课件无关。 */}
        <button className={'bd-t' + (tool === 'select' ? ' on' : '')} data-tool="select" onClick={() => setTool('select')} title="框选（S）：拖一个框圈住一块地方。圈住之后浮出「∑ 公式」「✨ 美化」「✕ 删除」；圈的是**课件**上你不懂的那一块时，还能点「？ 问这里」问为什么（不用先写字）。★ 用笔时卡片会给笔让路，想拖卡片 / 缩放 / 双击改字就切到这个工具">⬚ 框选</button>
      </div>

      <div className="bd-group">
        {COLORS.map((c) => (
          <button
            key={c.id}
            className={'bd-swatch' + (color === c.v && tool !== 'highlighter' ? ' on' : '')}
            style={{ background: c.v }}
            onClick={() => {
              setColor(c.v)
              if (tool === 'eraser' || tool === 'highlighter') setTool('pen')
            }}
            title={c.name}
          />
        ))}
        {WIDTHS.map((w, i) => (
          <button key={w} className={'bd-w' + (width === w ? ' on' : '')} onClick={() => setWidth(w)} title={'粗细 ' + (i + 1)}>
            <span style={{ height: Math.max(1, w - 1), width: 18 - i * 4 }} />
          </button>
        ))}
      </div>

      <div className="bd-group">
        {/* 「∑ 公式」「▤ 便签」两个入口收掉了 —— 现在只留手写公式。
            卡片本身的渲染和编辑都还在，所以已经存下来的卡片不会坏，只是不能再新建。 */}
        <button className="bd-t" onClick={onWriteFormula} title="手写一个公式，认出来变成好看的式子（也可以用键盘打）">
          ✍ 手写公式
        </button>
        {/* 字写得不好看就走这条：框住你写的字 → 认成文字 → 用好看的字体排成一张卡。
            和「手写公式」并列放，因为它们是同一件事的两半：一个认式子，一个认字。
            ★ 没框选时**不做成灰的**：灰按钮点不动、也不教人下一步该干什么，
              而这条路的入口恰恰是"先用框选圈住字"这件反直觉的事。
              可点 + 当场提示「先用「⬚ 框选」圈住要认的手写」才是最省事的说明书。
            ★ 框住之后浮层上还会多一个「∑ 公式」——已经写在板上的式子不用重抄一遍。 */}
        <button className="bd-t" onClick={onBeautify} title="美化手写：先框住你写的字（点「⬚ 框选」拖一个框，或按住笔杆键拖），再点这里">
          ✨ 美化手写
        </button>
        {/* ★ 框选追问（2026-09-22）：圈住课件上不懂的那一块 → 问它为什么。
            为什么工具条上也要有一颗：选区浮层那颗按钮**要先把东西圈住**才出现，
            而"这个功能在哪"是第一次用的人最先问的问题（用户原话就是这个诉求）。
            和「✨ 美化手写」一样**不做成灰的**：可点 + 当场说清下一步，
            比一颗点不动的灰按钮省事得多（那条理由见上面「美化手写」的注释）。
            ⚠ 它的产出**不落在板上**（答案浮在页边）—— 所以 title 里必须说清楚，
              否则用户会以为点了会多一张卡（`check:ask` 里也钉着"板上一个字节都不变"）。 */}
        {/* ★★ 「🔍 速查」（2026-09-28）：上课突然不懂的那个词。
            ⚠ 为什么工具条上**必须**有一颗 —— 用户的原话是「surface 没键盘的时候
              怎么摁这些快捷键」：Ctrl+K 对平板/纯笔的用户是**不存在的路**，
              为了查一个词去接外接键盘，正是他当初反对「⧉ 粘贴」要 Ctrl+V 时
              说的那句话。这和 `onPaste` 是同一个场景的第二次。
            ⚠ 位置紧挨着「？ 问这里」：它们是一对 ——
              「问这里」是"这一块**为什么**"，「速查」是"这**一个词**是什么意思"。
            ⚠ 它**不做成灰的**（和「？ 问这里」同一条理由）：点开来就能打字，
              查不查得到是点了之后的事，灰着反而会骗人。
            ⚠ 课件上的词还有两条更快的路：**双击**那个字、或者用手指/笔**按住不放** ——
              这颗按钮是"要自己打一个词"时的入口（比如写笔记时突然想到的那个）。 */}
        <button
          className="bd-t"
          data-tool="look"
          onClick={onLook}
          title="速查：查一个词是什么意思（不用键盘 —— 这是 Ctrl+K 的替代品）。也可以直接双击/按住课件上的那个字；查完浮在旁边，点「⬇ 留到板上」才会往板上加东西"
        >
          🔍 速查
        </button>
        <button className="bd-t" data-tool="ask" onClick={onAsk} title={`${ASK_BUTTON}：圈住课件页上你不懂的那一块（比如某一步、某个符号），问它「这是为什么」—— 答案浮在页边，**不会**往板上加东西`}>
          {ASK_BUTTON}
        </button>
        {/* 公式架（2026-09-20）：这张板上**认过一次**的公式收成一条随手可取用的横条 ——
            一次课里同一个公式要写好几遍，不用重抄、也不用重新框选识别。
            用户原话：「让已经识别一次的公式卡放置在某个便于去用的地方……因为一次课
            往往会多次用到同样的公式」。架子**由板上的公式卡推出来**，不新增任何存盘字段。 */}
        <button
          className={'bd-t' + (shelfOpen ? ' on' : '')}
          data-tool="shelf"
          onClick={onToggleShelf}
          title={
            shelfCount
              ? `公式架（F）：这张板上认过的 ${shelfCount} 条公式 —— 点一下放到眼前，拖到板上指哪放哪`
              : '公式架（F）：这张板上还没有认过的公式 —— 先「✍ 手写公式」认一个，或者框住手写点「∑ 公式」'
          }
        >
          ∑ 公式架{shelfCount ? ` ${shelfCount}` : ''}
        </button>
      </div>

      {/* 撤销/重做/粘贴这一组（编辑动作一族）。⚠ 位置是量出来的，不是挑的：
          1440 那档窗口（视口 1406~1426）第一行就快满了，这组再往左放一颗按钮
          都可能把后面的组挤下一行 —— 详细的数据表在 git 历史里
          （2026-09-23 加「⧉ 粘贴」时量的 `.cache/probe-cbar5.mjs` 那一套）。
          2026-09-26 收纳之后第一行短了一大截，这组站稳在第一行；
          **将来再加按钮还是先量**，别凭"和谁挨着好看"决定。 */}
      <div className="bd-group">
        <button className="bd-t icon" onClick={onUndo} disabled={!canUndo} title="撤销 Ctrl+Z">↶</button>
        <button className="bd-t icon" onClick={onRedo} disabled={!canRedo} title="重做 Ctrl+Shift+Z">↷</button>
        {/* ★★ 「⧉ 粘贴」（2026-09-23，用户报的 Surface 场景）。
            用户原话：「加一个方便黏贴的，现在复制框选即可复制，但是黏贴需要 ctrl+v，
            这对于 surface 来说要去接一个外置键盘才方便，我们不希望额外引入这个键盘，
            采用其他方式比如价格按钮」。
            ⇒ 复制那条路**本来就有按钮**（选区浮层那颗「⧉ 复制」），
              缺的是**粘的那一半** —— 而粘恰恰是最需要按钮的那一半：
              剪贴板是 **localStorage**（跨窗口、跨板都活着），
              所以"在**另一块板**上把刚才带走的那块贴回来"这条路本来就靠键盘，
              而它正是当初做这个功能的目的（2026-09-18 用户原话：
              「框选后加入复制功能，能够黏贴在其他用户想要黏贴的画板上」）。
            ★ 另一处入口在**选区浮层**里、紧挨着「⧉ 复制」（BoardCanvas 那颗）——
              那一处是"刚复制完手还在原地"时最顺手的；两颗都走同一个 `pasteSel`。
            ★ 它**不做成灰的**（和「？ 问这里」「✨ 美化手写」同一条理由）：
              剪贴板里有没有东西只有点的那一刻才知道（localStorage 是**跨窗口**的，
              用户可能刚在另一个窗口复制的）—— 灰着反而会骗人。
              没东西时 `pasteSel` 会当场说清"先框住一块东西复制"。
            ★ 不需要"当前工具"那种选中态：粘贴是**一次性动作**，点完就完。 */}
        <button
          className="bd-t"
          data-tool="paste"
          onClick={onPaste}
          title="粘贴：把刚才复制（或框住点「⧉ 复制」）的那一块贴到**你现在看着的地方** —— 不用按 Ctrl+V，笔和 Surface 上都点得到"
        >
          ⧉ 粘贴
        </button>
      </div>

      {/* 右端这一组：全屏 + 帮助 + 「⋯ 更多」。存盘状态挪进菜单（它不挡手，也不值得常占一格）。 */}
      <div className="bd-group right">
        <span className={'bd-save' + (dirty ? ' on' : '')}>{dirty ? '正在存…' : '已存'}</span>
        {/* ★★ 「⛶ 全屏」（2026-09-28 用户点名：「把全屏按钮拿出来，全屏是常用按钮」）。
            它原来住在「⋯ 更多」的「看这块板」那一行 —— 那一行是"一次课点不了几回的"
            收纳逻辑，可全屏恰恰相反：上课**每块板都要进一次**（尤其 Surface，
            窗口 chrome 一收，写字的地方立刻多出一圈）。收进去的那颗等于没有。
            · icon 一颗（⛶），选中态用 `on`：全屏中再点一下就是退出；
            · title 里留着「Esc 也能退」—— 键盘用户两条路都通，触摸用户有这颗按钮。 */}
        <button
          className={'bd-t icon' + (fullscreen ? ' on' : '')}
          data-tool="fullscreen"
          onClick={onToggleFullscreen}
          title={fullscreen ? '退出全屏（Esc）' : '画布全屏：只留一张纸，四周什么都收起来（Esc 也能退）'}
        >
          ⛶
        </button>
        {/* 「?」帮助（2026-09-26）：手势、快捷键、"想做什么 → 点哪里"，一浮层说清。
            为什么要有它：这应用一大半的本事写在按钮的 **title 悬浮提示**里，
            而 Surface 的笔/手指**没有 hover** —— 那些说明等于不存在。
            （空板提示也指了这一颗：第一次用的人至少知道去哪找。） */}
        <button className="bd-t icon" data-tool="help" onClick={onHelp} title="帮助：手势、快捷键、想做的事在哪个按钮上">
          ?
        </button>
        {/* 「⋯ 更多」：出网四件套 + 看板（缩放）+ 界面（字号/背景）都住这儿。
            ⚠ 全屏不在了（2026-09-28 挪出去常驻，用户点名它是常用按钮）。
            实现纪律见这个文件顶上「更多菜单」那三条（常驻 DOM / 真点要先开 / 别用 fixed）。 */}
        <div className="bd-morewrap" ref={moreRef}>
          <button
            className={'bd-t' + (moreOpen ? ' on' : '') + (busy ? ' busy' : '')}
            data-tool="more"
            onClick={() => setMoreOpen((v) => !v)}
            title={busy ? '更多（有一件事正在跑：' + busy + '）' : '更多：插入 PDF/PPT、课件整理、作业辅导、收成笔记、画布缩放、字号、背景（全屏挪到旁边那颗 ⛶ 了）'}
          >
            ⋯
          </button>
          <div className={'bd-more-pop' + (moreOpen ? ' open' : '')}>
            <div className="bd-more-h">出网 · 一次课点不了几回的</div>
            {/* ⚠ busy 的文案原来显示在按钮上（按钮被顶宽、整排挪动 ——
                check-deck 为这个量过两次坐标）。现在收进菜单，按钮只显示文字本身，
                busy 那句话写进菜单项：菜单开着的人看得见，条上不晃。 */}
            <button className="bd-t" data-tool="doc" disabled={!!docBusy} onClick={onInsertDoc}
              title="插入 PDF/PPT（很长的课件也行）：铺在画布上，直接用笔在上面写注释、圈重点、认公式">
              {docBusy ? docBusy : '📄 插入 PDF/PPT'}
            </button>
            {/* 课件整理：老师逐页讲这份 PDF/PPT。板上一份都没有时点它**直接开选文件那个框**。 */}
            <button className="bd-t" data-tool="deckread" disabled={!!deckBusy} onClick={onReadDeck}
              title={deckBusy ? '正在收这份课件（上传 + 读页数）…' : docs.length ? '课件整理：老师逐页讲这份 PDF/PPT —— 讲解贴每页右边、重点和公式贴左边（先挑页，再一页一页讲）' : '课件整理：选一份 PDF/PPT → 它铺到板上 → 老师逐页讲（讲解在右、重点和公式在左），挑一段页就行'}>
              {deckBusy || '✧ 课件整理'}
            </button>
            {/* 作业辅导：作业通常在书上，这个入口问清"哪一份 PDF、第几页第几题"，
                每题一份答案 + 说人话的解析。产出只在窗里，**不往板上写**。 */}
            <button className="bd-t" data-tool="homework" onClick={onHomework}
              title="作业辅导：选作业在哪一份 PDF（通常是书上那几页）→ 写「第 12 页第 3 题」→ 每题一份答案 + 说人话的解析。会顺手带上板上这节课的讲解；答案只在窗里，**不往板上写**">
              {HW_BUTTON}
            </button>
            {/* 收拢成笔记：卡片/板框/连接拣成草稿 + 整板手写转录成文字。
                没配识别密钥时转录会失败，但**不拦路**：照样收卡片，提示说清原因。 */}
            <button className="bd-t" data-tool="gather" onClick={() => onGather()}
              title="收拢成笔记：卡片/板框/连接拣成草稿 + 整板手写由机器转录成文字（有手写时要几十秒；没配识别密钥就只收卡片）">
              ▤ 收成笔记
            </button>
            <div className="bd-more-h">看这块板</div>
            {/* 🔓 全部解开：课件整理贴的讲义卡一律先钉住（Board.jsx 贴卡那条 ★★），
                一节课能钉一两百张 —— 一颗颗 📌 点回去不现实。这颗一次全开。 */}
            <button className="bd-t" data-tool="unlockall" onClick={onUnlockAll}
              title="把钉住的讲义卡全部解开（课件整理贴的卡默认定住，这颗一次全开；要单独钉哪张就点它左下角的 📌）">
              🔓 全部解开
            </button>
            {/* ⟲ 恢复操作：手势没收尾（切窗口/系统弹窗/手掌误触）时，之后落笔全被吞 ——
                写不出字、按不动卡、选区清不掉。这颗一次清空，**不动板上的内容**。 */}
            <button className="bd-t" data-tool="resetgestures" onClick={onResetGestures}
              title="写不出字 / 按不动卡 / 选区一直清不掉的时候点它：把手势和选中全部清空（板上的一笔一划和卡片位置都不会动），不用刷新页面">
              ⟲ 恢复操作
            </button>
            <div className="bd-more-row">
              <span className="bd-more-label" title="画布缩放：把整张纸放大缩小">纸</span>
              <button className="bd-t icon" onClick={() => onZoom(1 / 1.2)} title="画布缩小（纸变小）">−</button>
              <button className="bd-t icon" onClick={onFit} title="把所有内容装回屏幕（Ctrl+0）">⤢</button>
              <button className="bd-t icon" onClick={() => onZoom(1.2)} title="画布放大（纸变大）">＋</button>
            </div>
            <div className="bd-more-h">界面</div>
            <div className="bd-more-row">
              <span className="bd-more-label">字号</span>
              <button className="bd-t icon" onClick={() => onScale(-0.05)} disabled={scale <= 0.9} title="界面字号小一点">A−</button>
              <button className="bd-t zoomish" onClick={onScaleReset} title={'当前 ' + Math.round((scale || 1) * 100) + '%，点一下回到默认大小'}>
                {Math.round((scale || 1) * 100)}%
              </button>
              <button className="bd-t icon" onClick={() => onScale(0.05)} disabled={scale >= 2} title="界面字号大一点">A+</button>
            </div>
            {/* 纸面：四种纸直接**画在按钮上**（所点即所得）。
                ⚠ 别和上面那行混：那个 `纸` 是**画布缩放**（把纸放大缩小），
                  这里是**纸长什么样** —— 标签写"背景"，两个字不一样。 */}
            <div className="bd-more-row">
              <span className="bd-more-label">背景</span>
              {PAPERS.map((p) => (
                <button
                  key={p.id}
                  data-paper={p.id}
                  className={'bd-paper p-' + p.id + (paper === p.id ? ' on' : '')}
                  onClick={() => onPaper(p.id)}
                  title={'纸面 · ' + p.name + '：' + p.hint}
                  aria-label={'纸面：' + p.name}
                  aria-pressed={paper === p.id}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


// ────────────────────────────── 空板提示 ──────────────────────────────

/* 空板提示（2026-09-26 重写）。
 *
 * 原来是三段长句 —— 写给"肯读字的人"，但第一次打开的人要的是**扫一眼就知道下一步**。
 * 现在是四行「一句话说清一件事」，每行 = 粗体的"想做什么" + 箭头后那一步；
 * 更全的（手势、快捷键、每个功能在哪个按钮上）指给工具条右下角的「?」——
 * 那颗按钮就是为"Surface 上没有悬浮提示"补的说明书。
 *
 * ⚠ 根类名 `.bd-hint` 别改：check-shape 靠它判断"空板提示盖没盖着画布"
 *   （它收指针事件，夹具板必须放一张卡让它消失 —— 那条断言先报，
 *    不然后面的失败全是假错）。 */
export function Hint() {
  return (
    <div className="bd-hint">
      <div className="bd-hint-t">拿笔直接画</div>
      <div className="bd-hint-list">
        <div className="bd-hint-item"><b>✍ 写公式</b><span>点「✍ 手写公式」，照样子写一遍，它就认</span></div>
        <div className="bd-hint-item"><b>✨ 字丑</b><span>「⬚ 框选」圈住你写的字 → 点「✨ 美化手写」</span></div>
        <div className="bd-hint-item"><b>？ 不懂</b><span>「⬚ 框选」圈住课件那一块 → 点「？ 问这里」</span></div>
        <div className="bd-hint-item"><b>✋ 手势</b><span>笔尖写字，翻过来是橡皮 · 一根手指拖 = 平移，两根手指捏 = 缩放</span></div>
      </div>
      <div className="bd-hint-more">手势、快捷键、每个功能在哪个按钮上 —— 点工具条右下角的「<b>?</b>」</div>
    </div>
  )
}
