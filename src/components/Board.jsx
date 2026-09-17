import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BoardCanvas from './BoardCanvas.jsx'
import WritingPad, { OcrSettings } from './WritingPad.jsx'
import InkToCard from './InkToCard.jsx'
import {
  Tex } from './Tex.jsx'
/* ⚠ drawStroke 在这里**不能省**。
   它原来住在 BoardCanvas.jsx 里，后来搬去了 lib/ink.js（为了让"导出给识别"
   也能用它）。搬的时候我只改了 import 列表，文件里 paintLive 还在调用它 ——
   于是按下的第一件事就是 `ReferenceError: drawStroke is not defined`，
   笔完全点不动，而且**只在按下时才炸**（模块加载时不报错，构建也不报错）。
   教训：删一个 import 之前，先确认这个标识符在同一文件里没人用；
   构建工具不会替你查这个（它只是个运行时才会炸的未定义变量）。 */
import { drawStroke, MIN_STEP_SCREEN } from '../lib/ink.js'
import { CARD_FONTS, CARD_MIN_H, DEFAULT_CARD_FONT, HL_COLOR, HL_WIDTH, fontCss, nextCardScale, newCard, newStroke, parseBoardDocument, serializeBoardDocument, textCardRect } from '../lib/board.js'
/* 点 / 几何 / 关系搬去了 geometry.js（2026-09-16 架构 review 的 C5）；
   板框的几何（成员包围盒 + 内边距 / 框选命中）2026-09-17 也进了那儿。 */
import { buildRelations, descendantsOf, fitView, frameBounds, membersInBox, simplifyPoints, strokeHitsCircle, strokeHitsRect, toFlat, toPoints } from '../lib/geometry.js'
/* 卡片「按内容量尺寸」那一套规矩（什么时候量得准、什么时候算稳定、门槛多少）搬去了
   card-fit.js —— 从前它锁在这个文件里，自检够不着（见那个文件的文件头）。 */
import { createCardFitter } from '../lib/card-fit.js'
/* 连接读法（reader / 墨迹块 / 形状判据 / 各种阈值）搬去了 links.js。
   `linkKey` = 一条连接在界面上的身份（你画的看那一笔、你连的看那条记录）。 */
import {
  createLinkReader, deriveChains, linkKey,
} from '../lib/links.js'
/* 选中这一族（框住的笔意味着什么 + 你对它说的那几句话）搬去了 selection.js：
   改词 / 反向 / 「不算连接」/ 回头路 / 留下板框 的规矩都在那儿，纯函数、有断言。 */
import {
  applyStrokeLink, clearCond, freezeFrameSelection, readSelection, removeStrokes, specCond, vetoCond,
} from '../lib/selection.js'
/* 板框 / 连接这两个概念的**动作**（留下 / 加进来 / 改标题 / 拆开 / 整体挪 / 删掉连接 /
   吸附到最近的卡片或板框）在 frames.js —— 和 selection.js 一个路子：纯函数、有断言。见 ADR-0001。 */
import { declareLink, dissolveFrame, removeLink, setFrameTitle, setLinkKind, snapNode, translateFrame } from '../lib/frames.js'
/* 关系的词表在 link-kinds.js（board.js 不再转发）。 */
import { ARROW_LINK, LINK_DELETE, LINK_KINDS, condCard, condInk, linkKind } from '../lib/link-kinds.js'
/* 视图映射（屏幕 = 世界 × s + t）只有一份实现，在 view.js 里 ——
   从前这句公式在这两个组件里被手抄 14 处、canvas 变换写两份、捏合还复制了一份
   （于是"导出的那份有自检、手指走的是复制品"）。现在浮层位置、canvas 变换、
   滚动/捏合/平移/居中全走这里。 */
import { applyViewTo, centerOn, clampViewScale, combinedScale, panBy, screenLenToWorld, screenToWorld, worldLenToScreen, worldToScreen, zoomAt, zoomBetween } from '../lib/view.js'
/* 撤销账本（一次手势 = 一步撤销）在 history.js —— 四条手势从前各自手记一次账、
   "算不算动过"四个判据（架构 review 候选 3）。现在只说 begin / during / end。 */
import { createHistory } from '../lib/history.js'
import { displayTex, snippetFor, toTex } from '../lib/formula.js'

/* 白板：打开就能画的那一屏。没有文件名要起、没有格式要学。
 *
 * 三条约定的取舍，写在这里，免得以后自己推翻自己：
 *
 * ① **笔是主角，键盘是配角。** 默认工具永远是笔。输入框只在你要写公式/文字时出现，
 *    出现即聚焦、Enter 收、Esc 走。
 * ② **关系不用你填。** 你画的位置就是关系（见 lib/board.js 的 buildRelations）。
 *    面板会明说是"推断的"，并告诉你怎样让它变成确定的：在两张卡之间画一条线。
 * ③ **一切都是纯文本。** 一张板 = 一个 JSON 文本文件，随时能读、能 Git、能救。
 *
 * ── 状态怎么管（这部分是踩过坑的）──
 * board 的唯一真相放在 boardRef 里，不是 useState。原因：撤销、拖动、擦除这类操作
 * 都要"基于当前值算出新值"，如果写在 setState(fn) 的 fn 里，fn 会在渲染期被调用，
 * 里面再去 setHistLen 之类就是"渲染期改状态"，React 会告警甚至死循环。
 * 所以：算出新板 → 写 ref → setState 触发重绘，副作用全在这一层做。
 *
 * ── 坐标只有一套基准：**画布容器**（.bd-stagewrap）的左上角 ──
 * 这是踩了三次才统一的一条。
 * view 的 tx/ty、命中测试、卡片摆放、fitView、缩放锚点，全部用"相对容器"的坐标，
 * 不混用 window 坐标。一旦混了，就差了"容器在页面里的位置"那一整块
 * （左边有侧栏 270px、上面有文件名那一行 46px），表现出来是：
 * 卡片整体偏出去、手写的线和公式卡对不上、内容跑到屏幕外看不见。
 * 规矩很简单：**任何 clientX/clientY 进这个文件，第一件事就是减掉容器的 rect。**
 */

const SAVE_DEBOUNCE_MS = 700
/* 写盘失败之后隔多久再试（见 flushSave）：宁可重试，也不能让「已存」撒谎。 */
const SAVE_RETRY_MS = 3000
/* "板安静多久才算安静"（公式卡重新量尺寸那个防抖）跟着那条政策搬去了
   `src/lib/card-fit.js` 的 `FIT_IDLE_MS`（2026-09-17 架构 review 候选 6）——
   这个文件里不再留一份。 */
/* 橡皮圈的半径：**屏幕像素**（约一个字宽）—— 屏幕上大小恒定，不跟着纸缩放走。
   ⚠ 名字里带单位：它以前叫 `ERASER_R`、注释写着"世界坐标半径"，而用法一直在 `÷ view.s`
     （世界半径）。**注释和名字都撒谎**，正是 ADR-0002 那类"单位的账没人管"的温床。
   世界半径一律用 `screenLenToWorld(ERASER_R_SCREEN, view.s)` 现算。 */
const ERASER_R_SCREEN = 14
/* UNDO_MAX / "一次手势算几步"整套账本搬去了 src/lib/history.js（2026-09-17 候选 3）——
   这个文件里不再留一份（曾经"另一条路忘了裁到 UNDO_MAX"是没有任何东西会响的）。 */
/* HL_COLOR / HL_WIDTH 从 lib/board.js 来（那边是"存储层归一化"用的同一对常量）。
   这个文件里**不再各留一份** —— 曾经两处各写了一份 #ffd43b / 16，
   改一处忘一处就是"荧光笔颜色改不动"或者"宽度对不上"的经典来源。 */

const COLORS = [
  { id: 'ink', v: '#1b1d22', name: '黑' },
  { id: 'red', v: '#d9480f', name: '红' },
  { id: 'blue', v: '#1c7ed6', name: '蓝' },
  { id: 'green', v: '#2f9e44', name: '绿' },
  { id: 'purple', v: '#7048e8', name: '紫' },
]
const WIDTHS = [1.6, 2.6, 4.2]
const VARIANTS = ['A', 'B', 'C']

/* ── 纸面：几种背景，用户自己挑 ──
 * 2026-09-16 用户：「现在白板背景是十字格子纸，可以改成纯白纸，或者说有几种类型的
 * 背景让用户去选择」。于是做成**四档可挑**，并且把默认从"十字格子"改成**纯白**
 * （他那句话的头半句就是"可以改成纯白纸"）。
 *
 * ★ 纸面存在 localStorage，**不进 board-*.md**。理由两条：
 *   ① 纸是"我习惯怎么看这张板"，不是这张板的内容 —— 用户心里只有一种纸，
 *      存进文件就变成"每张板各有一张纸"，切板时纸跟着跳，很吵；
 *   ② 板文件是自动存的（停笔 0.7 秒写盘），多一个字段就是多一处假 diff 的来源
 *      —— 这条纪律 README 里写过（见"压力保留两位小数"那一段）。
 * id 同时是 CSS 类名后缀（.paper-<id>），改 id 记得改 styles.css。 */
const PAPERS = [
  { id: 'plain', name: '纯白', hint: '一张干净的白纸，什么都不铺（默认）', tile: 0 },
  { id: 'grid', name: '方格', hint: '一格 32 世界像素的十字格子，画图对得齐', tile: 32 },
  { id: 'rule', name: '横线', hint: '只有横线，写一行对一行', tile: 32 },
  { id: 'dots', name: '点阵', hint: '一层小点，比格子安静', tile: 24 },
]
const DEFAULT_PAPER = 'plain'
const PAPER_KEY = 'studyhelper.paper'

/* 画出一条连接线之后，那排词在屏幕上停多久（毫秒）。
 * 3.5 秒的来历：比你抬笔看一眼再决定要长一点，又不至于一直挂在那儿碍事。
 * 指针停在那排词上时不会收（LinkChips 的 onPointerEnter）。 */
const LINK_PICK_MS = 3500

/* ── 纸面在屏幕上的几何：格距 + 原点 ──
 * ★ 用户 2026-09-16 的第二条：「平移的时候有一种背景不动字动的感觉，
 *   我要的是字就在背景上，字跟着背景一起动」。
 *   上一版把底纹当成"贴在屏幕上的纹理"（固定 32px 的 background-size），
 *   于是平移时墨迹在走、格线钉在屏幕上 —— 视觉上字就成了"浮"在纸上面的。
 *   现在按**世界坐标**算：
 *     格线在世界里周期是 tile（方格/横线 32、点阵 24）
 *     → 屏幕上的周期 = tile × 视图缩放 s
 *     → 原点就是视图平移 tx / ty
 *   两个数交给 CSS 的 background-size / background-position，底纹就和墨迹、卡片
 *   **用的是同一个变换**：平移、缩放、Ctrl+0 装回屏幕全都自动跟着走，不用各自特殊处理。
 *
 * 为什么取模：格线每 tile_s 就重复一次，不取模的话平移越远塞给浏览器的数越大
 * （几千几万像素既没必要也容易在小数上抖）。负数要补正 —— 负的
 * background-position 本身合法，但补正之后值更小、也不依赖浏览器怎么处理负数。
 *
 * 抽成纯函数（不碰 DOM）：`check-paper.js` 要按真实格距去选采样框，
 * 而且"格距 = 世界格距 × 缩放"这一条值得能一眼读懂。 */
function paperGeometry(view, paperId) {
  const p = PAPERS.find((x) => x.id === paperId) || PAPERS[0]
  const s = Number(view && view.s) > 0 ? Number(view.s) : 1
  const size = p.tile * s
  const mod = (v) => {
    const n = Number(v) || 0
    if (!(size > 0)) return 0
    return ((n % size) + size) % size
  }
  return {
    '--paper-s': String(s),
    '--paper-tile': size > 0 ? size.toFixed(3) + 'px' : '0px',
    '--paper-x': mod(view && view.tx).toFixed(2) + 'px',
    '--paper-y': mod(view && view.ty).toFixed(2) + 'px',
    /* 线宽也按缩放走（和笔迹一个道理：纸离得远线就细），夹在 0.8~2.4px
       —— 下限是"别细到看不见"，上限是"别粗成一道条纹"。
       ⚠ 这个数**算在这里**，不能写成 CSS 里的 `calc(var(--paper-s) * 1px)`：
         `--paper-s` 是设置在这层元素上的，自定义属性里的 var() 是在
         **声明它的那个元素**上就解析掉的 —— 写在 .bd 上会拿不到这个值、
         静默退回 1px（线宽永远不缩放，而且不报错）。 */
    '--paper-lw': Math.min(2.4, Math.max(0.8, s)).toFixed(2) + 'px',
  }
}

export default function Board({ file, initialText, reloadToken, onSave, flash, scale, onScale, onScaleReset, fullscreen, onToggleFullscreen }) {
  const [board, setBoard] = useState(() => load(initialText, file))
  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState(COLORS[0].v)
  const [width, setWidth] = useState(WIDTHS[1])
  const [selectedId, setSelectedId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [hist, setHist] = useState({ undo: 0, redo: 0 })
  const [variant, setVariant] = useState(readVariant)
  const [paper, setPaper] = useState(readPaper)
  const [panelOpen, setPanelOpen] = useState(true)
  const [eraserAt, setEraserAt] = useState(null)
  const [hoverEdge, setHoverEdge] = useState(null)
  /* 用笔写字时把鼠标光标收掉 —— 笔尖底下一直跟着一个十字，写字时很碍眼。
     但**不能简单粗暴地 cursor:none**：那样鼠标也会一起没光标，画布上就没法定位了。
     所以记着"最近一次是谁在操作"：笔 → 藏，鼠标 → 显示。
     penModeRef 是为了只在真的换了设备时才 setState —— 每次 pointermove 都 set 会白重渲染。 */
  const [penMode, setPenMode] = useState(false)
  const penModeRef = useRef(false)
  /* 笔杆键框选出来的那一组墨迹（存 id）。
     和卡片的 selectedId 是两码事：那个是单选一张卡，这个是多选一堆笔迹。 */
  const [inkSel, setInkSel] = useState(null) // Set<strokeId> | null
  const [lasso, setLasso] = useState(null) // 正在拖的那个框（世界坐标，已经规范化成 x0<x1 / y0<y1）
  const lassoRef = useRef(null)
  const inkMoveRef = useRef(null)
  /* 刚画完一条连接线时浮出来的那排词（见 applyLink / LinkChips）。
   * { strokeId, x, y, kind, dir }，x/y 是**屏幕坐标**（相对画布容器）。
   * 它是"可选的一步"：不点时 3.5 秒自己收走，连接已经成立、屏幕上照样有标记。 */
  const [linkPick, setLinkPick] = useState(null)
  const linkLeftRef = useRef(false) // 指针是不是停在那排词上（在上面就别自动收）
  const [size, setSize] = useState({ w: 0, h: 0 })
  /* 手写公式：写字板、设置弹层的开关。
     写字板是"另开一块地方写"，不是"圈住白板上的字去识别" —— 理由见 WritingPad.jsx 顶部。 */
  const [padOpen, setPadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /* 「从框选到卡片」：把圈住的那一块笔迹认成东西落成一张卡。
     mode='text' 认文字（文字卡 + 字体）、mode='formula' 认公式（公式卡）。
     和写字板是两条路：那条是"另开一块小板先写再认"（见 InkToCard.jsx 顶部）。 */
  const [inkMode, setInkMode] = useState(null) // null | 'text' | 'formula'
  /* 「∈ 条件」武装着的那条连接（null = 没武装）。一次性：点完目标就收（见 armCond）。 */
  const [condArm, setCondArm] = useState(null)
  /* 板框：正在改标题的那个（双击框上的名字）、选中的那个。
     和卡片的 selectedId / editingId 是同一个路子，只是对象是"框"（见 ADR-0001）。 */
  const [frameEditId, setFrameEditId] = useState(null)
  const [selectedFrameId, setSelectedFrameId] = useState(null)

  const wrapRef = useRef(null)
  const sceneRef = useRef(null)
  const liveRef = useRef(null)
  const boardRef = useRef(board)
  const pointersRef = useRef(new Map())
  const drawRef = useRef(null)
  const panRef = useRef(null)
  const pinchRef = useRef(null)
  const spaceRef = useRef(false)
  const saveTimer = useRef(null)
  const dirtyRef = useRef(false)
  const dragStartRef = useRef(null)
  /* 框选刚结束的那个框（世界坐标）。"留下板框"要用它找卡片成员 ——
     选中笔迹的包围盒不一样：你顺手圈进来、却没在上面写字的卡片会被漏掉（见 keepFrame）。 */
  const lastLassoRef = useRef(null)
  /* 板框整体拖动的起点：{ id, before }（before = 按下那一刻的板，松手时进撤销栈）。 */
  const frameDragRef = useRef(null)
  /* 箭头工具那一次划动：{ from: 世界点, to: 世界点 }。
     它是**一次性的手势**（画完就回笔、纸上不留墨）—— 见 ADR-0001。 */
  const arrowRef = useRef(null)

  boardRef.current = board
  dirtyRef.current = dirty

  /* ── 撤销账本 ──────────────────────────────────────────────────────────
     "一次手势 = 一步撤销"这套规矩整个在 `src/lib/history.js`（架构 review 候选 3）：
     裁到 UNDO_MAX / 清掉重做 / 报数从前在四条手势里各抄了一遍，而"这算不算动过"
     四个判据各写各的（还有一个手写的 `moved` 标记）。这里只接三样它拿不到的东西：
     板怎么读、怎么写、数数往哪儿报。 */
  const ledger = useMemo(
    () =>
      createHistory({
        get: () => boardRef.current,
        write: (next) => {
          boardRef.current = next
          setBoard(next)
          setDirty(true)
        },
        onCount: setHist,
      }),
    []
  )

  /* 唯一改板的入口。history=true 表示这一步值得撤销（画一笔、加卡片、删卡片）；
   false 表示是连续手势的中间状态（拖动、连续擦除），不该塞满撤销栈。 */
  const commit = useCallback(
    (next, history = true) => {
      if (history) ledger.step(next)
      else ledger.apply(next)
    },
    [ledger]
  )

  /* ── 卡片「按内容量尺寸」的接线 ────────────────────────────────────────────
     策略（量什么 / 什么时候量得准 / 什么时候算稳定 / 门槛多少）搬去了
     `src/lib/card-fit.js` —— 那三条踩过的坑（DOM 还没跟上上一次提交、两条轴都要稳、
     编辑态量不得）现在在 check-board.js 的 [6l] 里断言得到，不再只能靠真浏览器手工验。
     这里只做三件接线的事：
       · sample：把这张卡**同一瞬间**的 DOM 读数采出来（这个 module 唯一的 DOM 依赖）；
       · commit：把算好的 patch 写回板里（走下面这个 commit，不进撤销栈）；
       · report：把"这一趟量到了什么"写在 data-fit 上 —— 卡片为什么是这个尺寸，
         用眼睛看不出来，只能靠它（自检也读它）。
     `commit` 是 useCallback([])（身份稳定），所以这个 fitter 一个组件实例只建一次，
     排队状态也就跟着实例走。 */
  const fitter = useMemo(
    () =>
      createCardFitter({
        sample: (id, opts) => sampleCardForFit(id, opts),
        commit: (id, patch) =>
          commit((c) => ({ ...c, cards: c.cards.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), false),
        frame: (fn) => requestAnimationFrame(fn),
        later: (fn, ms) => setTimeout(fn, ms),
        clearLater: (h) => clearTimeout(h),
        /* "什么时候重量"这条政策需要的三样东西，只有这一层拿得到（架构 review 候选 6）：
           板怎么读、字体就绪的承诺、以及那个防抖定时器本身（定时器现在住 module 里）。 */
        read: () => boardRef.current,
        fontsReady: () => (typeof document !== 'undefined' && document.fonts && document.fonts.ready) || null,
        report: (card, info) => {
          const wrap = wrapRef.current
          const el = wrap ? wrap.querySelector('[data-card-id="' + card.id + '"]') : null
          if (el) el.dataset.fit = JSON.stringify(info)
        },
      }),
    [commit]
  )

  /* 把"这张卡现在长什么样"采下来交给 card-fit.js。
     采的都是**屏幕像素**，而且必须来自**同一瞬间**的布局：卡片的宽度和内容的高度
     要是来自不同的渲染帧，算出来的尺寸就是错的（那正是第 17 条那个坑）。 */
  function sampleCardForFit(id, opts = {}) {
    const cur = boardRef.current.cards.find((c) => c.id === id)
    if (!cur) return { state: 'gone' } // 卡片已经从板里没了
    const wrap = wrapRef.current
    const cardEl = wrap ? wrap.querySelector('[data-card-id="' + id + '"]') : null
    if (!cardEl) return { state: 'missing' } // 还没挂上，下一帧再来
    if (cardEl.classList.contains('editing')) return { state: 'wait' } // 编辑态量不得
    const el = cardEl.querySelector('.bd-card-body')
    if (!el) return { state: 'missing' }

    /* 内边距 + 边框（屏幕像素）：这个仓库全局是 `box-sizing: border-box`，
       卡片上写的 width/min-height **都把这一圈算在里面**，所以算尺寸时必须加上它 ——
       不加就正好少一整圈，宽度那条线上直接表现为**内容被裁掉**（实测 `E = mc²` 少了 c²）。
       ⚠ 2026-09-17 起卡片那一圈是 `outline`（styles.css 的 .bd-card），
         outline 不进布局 → 这里读到的 borderWidth 是 **0**，padX 就是纯内边距。
         还读它是因为这条换算对"圈"必须通用：哪天有人把 border 加回来，
         一个"屏幕像素"的量混进世界坐标的宽度里就会当场把内容挤窄（那正是"卡片底下
         一条恒粗黑线"的根子 —— 见 styles.css .bd-card 那段）。 */
    const cs = getComputedStyle(cardEl)
    const padX =
      parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
    const padY =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)

    const snap = {
      state: 'ok',
      card: cur,
      s: boardRef.current.view.s,
      domW: cardEl.getBoundingClientRect().width,
      bodyH: el.getBoundingClientRect().height,
      padX,
      padY,
    }
    if (opts.fitWidth) {
      /* 自然宽度：临时把宽度放开成 `max-content` 读一次（折行内容量不出自然宽），
         读完立刻还原 —— 同一帧里读回，屏幕上看不出来。 */
      const prev = el.style.width
      el.style.width = 'max-content'
      snap.naturalW = el.getBoundingClientRect().width
      el.style.width = prev
      /* 还要把"已经溢出的那部分"算进去：字体没就绪时 max-content 可能偏小，
         而溢出量（scrollWidth − clientWidth）任何情况下都准。两个取大的那个当需求。 */
      const tex = el.querySelector('.bd-tex')
      snap.spillPx = tex ? Math.max(0, tex.scrollWidth - tex.clientWidth) : 0
      snap.texClientW = tex ? tex.clientWidth : 0
    }
    return snap
  }

  /* 撤销 / 重做：账本的事（空栈时它自己返回 false，不抛、不改板）。 */
  const undo = useCallback(() => ledger.undo(), [ledger])

  const redo = useCallback(() => ledger.redo(), [ledger])

  /* 改视野。注意 pin 参数：
     - pin=true  你亲手平移/缩放了 → 记下来，下次打开照用（"我看到哪了"是你的意图）
     - pin=false 是程序自己适配的（打开时装进屏幕）→ 不记，下次重新算
     这样容器一变（换摆法、改字号、改窗口大小），自动适配的视野会自己跟过去，
     而你亲手定的那条只在你真的定过之后才生效。 */
  const setView = useCallback(
    (v, pin = true) => {
      commit(
        (cur) => ({ ...cur, viewPinned: pin ? true : cur.viewPinned, view: typeof v === 'function' ? v(cur.view) : v }),
        false
      )
    },
    [commit]
  )

  /* ── 换文件 / 点「重载」：整块重来。白板是"一节课一页"，不混着开 ──
     ⚠ 依赖里**不能**放 initialText。
       它是 App 塞进来的"最新内容"，每自动保存一次就会变一次字符串。
       一旦按它重跑，这个 effect 就会在每次保存之后把撤销账本清空 ——
       表现是"拖完东西按 Ctrl+Z 没反应、撤销按钮永远是灰的"，
       而且从代码上完全看不出毛病（这一条排查了一整轮才揪出来，
       中间还错怪了 pointerup 那几行）。
       真该重来的时候（换文件、点重载），App 会把 reloadToken 加一。
       initialText 照样读得到：effect 执行时拿到的就是那一刻的 props。 */
  useEffect(() => {
    const b = load(initialText, file)
    boardRef.current = b
    setBoard(b)
    setSelectedId(null)
    setEditingId(null)
    setDirty(false)
    /* 换了一份板 → 账本归零（从前是三行手写的：两个 ref 清空 + setHist）。 */
    ledger.reset()
    /* ★ 重开一张板时，把卡片过时的尺寸重新量一次（用户 2026-09-16：
       「公式板子周围留白太大」—— 一半是 KaTeX 的 1em 边距，另一半是 w/h 过时）。
       为什么非要在"每次打开"跑一趟：w/h 是**存进文件**的测量值，而它可能是在
       另一种渲染规则、另一种字体状态下量出来的，只改 CSS 收不掉它 ——
       min-height 就是 h，h 不收，式子仍旧飘在一个大空盒子里。
       规矩只有一条：**两条轴都按真实内容量，收到贴着内容为止**（原来还多一条
       "至少要盖住你圈的那块笔迹"，2026-09-16 用户明确说不要了：
       「不用盖住，就让框贴合公式和字就行」）。
       量稳了就不再写盘：连**两趟量出同一个数**（两条轴都要稳）才收手，重开板这一趟
       还额外带 1.5 世界像素的余量（`FIT_TOL_AUTO`）—— 所以不会每次打开都造一条假 diff。
       那一整套规矩和三个坑的来历都在 src/lib/card-fit.js 的文件头。
       ⚠ 空白卡（"双击写公式"/"双击写字"那个占位）不量 —— 还没有内容可量。 */
    /* ★ 换文件 / 点重载：账本（量尺寸的队列）清掉重来 + 排上所有公式卡 + 等字体补一趟 ——
       这三件事现在是一句话（`notify`），从前是这里三行、别处又抄一遍。 */
    fitter.notify({ reason: 'load' })
    // 视野没被你亲手定过 → 每次打开都重新适配一遍。
    // 这么做的原因见 lib/board.js 里 viewPinned 的说明：tx/ty 是相对容器的坐标，
    // 容器一变旧坐标就是错的，与其迁移不如"没定过就重算"。
    const raf = requestAnimationFrame(() => {
      const el = wrapRef.current
      if (!el) return
      if (!boardRef.current.viewPinned) {
        const f = fitView(boardRef.current, el.clientWidth, el.clientHeight, 70)
        commit((cur) => ({ ...cur, view: f }), false)
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [file, reloadToken, commit, ledger])

  // ── 量可用区域 ──
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  /* 退出编辑态（回车 / 取消 / Esc）时，把"插进来还没量过高度"的卡片量一次。
     编辑态量不得 —— 那时候卡片里装的是编辑器，量出来是编辑器的高度。 */
  useEffect(() => {
    fitter.notify({ reason: 'editing-ended' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  /* ★★ 板子安静下来之后，卡片自己重量一次尺寸（公式卡和文字卡都量）。
     这一条是用户 2026-09-16 第三次报的：「依旧神秘留白出现，这框不贴合公式」。
     上一版的根因是卡片高度里混了一份"盖住底下那块笔迹"，而笔迹是会被擦掉的；
     用户随后明确说不要"盖住"这套了（「不用盖住，就让框贴合公式和字就行」）。
     但"重量"这件事本身仍然需要：**尺寸是存进文件的测量值**，
     内容一改（双击改完式子/文字）它就过时了，而用户不会为此重开文件 ——
     实测那张卡 h=89，重开一次才被"载入时重量"收成 54。

     为什么不挂在"每一次 commit"上：画一笔、拖一下、平移缩放都是一次 commit，
     而它们跟尺寸无关，白量一趟要强制一次布局。这里盯的是
     `board.strokes` / `board.cards` 这两个**数组的引用**
     （commit 是纯函数式更新，视图变化不会换掉它们）—— 也就是说：
     **只有笔迹或卡片真的变了才排队**；防抖（"安静 400ms"）和"排完队要开跑"
     现在都在 `card-fit.js` 里（`FIT_IDLE_MS` + `notify`，2026-09-17 候选 6）——
     这里只报一句"板变了"，不再自己拿一个 setTimeout。

     ⚠ 正在编辑的那张会挂起来等（card-fit.js 的 'wait'）。 */
  useEffect(() => {
    fitter.notify({ reason: 'board-changed' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.strokes, board.cards])

  // ── 存盘 ──
  /* ★ 「已存」= **真的写进去了**，不是"我把它发出去了"（2026-09-17 修的）。
     原来这里是 `onSave(...)` 之后**立刻** `setDirty(false)` —— 而 onSave 是异步的
     （PUT /api/save），于是那个指示灯在请求还在飞的时候就亮了。
     两个后果，都咬过人：
       · 自检要等"真的落到盘了"这个时刻，界面上**根本没有**（它只能睡一个固定毫秒数 —— 
         check-link 那条 1/3 概率报红就是这么来的，见 README 第 38 条）；
       · 写失败时，"已存"已经亮过了（只有一句 toast 会闪）。
     现在：等 onSave 回话；失败就**保持"正在存…"**并过几秒重试（dirty 不清 → 灯不撒谎）。
     ★ 只在"盘上那份 == 现在这张板"时才清 dirty：await 期间你又画了一笔的话，
       那一笔还没写出去 —— 清了它就会永远停在"已存"里。 */
  const flushSave = useCallback(async () => {
    if (!dirtyRef.current) return false
    const text = serializeBoardDocument(boardRef.current)
    const r = await onSave(text)
    if (r && r.ok === false) {
      /* 没落地：保持 dirty，过一会儿再试（不重试的话，页面上会一直"正在存…"，
         而用户下一次编辑才可能再触发 —— 那期间的东西就悬着）。 */
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(flushSave, SAVE_RETRY_MS)
      return false
    }
    const now = serializeBoardDocument(boardRef.current)
    if (now === text) {
      setDirty(false)
    } else {
      /* await 期间你又改了：盘上那份已经不是最新的 —— 别清 dirty，也别让它悬着，
         按防抖再来一趟。 */
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
    }
    return true
  }, [onSave])

  useEffect(() => {
    if (!dirty) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(saveTimer.current)
  }, [dirty, board, flushSave])

  // 关页面/切标签时补一次，别丢掉最后那一笔
  useEffect(() => {
    const onHide = () => flushSave()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [flushSave])

  useEffect(() => {
    // 切文件前（组件卸载/换 file）把还没落盘的补上
    return () => {
      if (dirtyRef.current) onSave(serializeBoardDocument(boardRef.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  // ── 派生：关系和连线都从位置现算，不存进文件 ──
  const relations = useMemo(() => buildRelations(board), [board])
  const cardById = useMemo(() => new Map(board.cards.map((c) => [c.id, c])), [board.cards])
  /* 画出来的连接（见 lib/board.js 的 `createLinkReader`）。
     和 relations 一样**每次重算、不进文件** —— 你挪动卡片，连接自己跟着走。
     只有"你手动改过的那个词"存在笔迹上（stroke.link）。
     ★ 这里只认 reader 这一个入口：墨迹索引（以及它那一堆缓存）什么时候重建、
       排除集怎么算，都是 module 自己的事 —— 从前这一步要在组件里
       `useMemo(createInkIndex)` 再传给 `buildLinks`，**调用方得背着 module 的内部纪律**，
       而"固定块被清缓存而失效"那条严重 bug 就是从那儿漏的。 */
  const linkReader = useMemo(() => createLinkReader(), [])
  const links = useMemo(() => linkReader.read(board), [board, linkReader])
  const inkPairs = useMemo(() => {
    /* ★ 从 `links` 里派生，别再调一次 `inkedEdges(board)` ——
       那个函数内部就是 `buildLinks(board)`，等于每次 commit 白跑两遍
       （620 笔的板上实测一遍 40ms+，这笔账省下来正好抵掉墨迹块那部分开销）。 */
    const set = new Set()
    for (const l of links) set.add(l.a + '|' + l.b)
    return set
  }, [links])
  const linkByStroke = useMemo(
    () => new Map(links.flatMap((l) => (l.ids || [l.strokeId]).map((id) => [id, l]))),
    [links]
  )
  /* ── 框住的那些笔意味着什么 ───────────────────────────────────────────────
     `sel.link`（框里正好一条连接线 → 改词那排）、`sel.frame`（框住的正好是一个板框的笔 →
     拆开）、`sel.box`（那个虚线框）、`sel.strokes`（选中的笔迹对象）——
     这几件事从前是这里一堆 useMemo，现在收成 `readSelection` 一次读
     （规矩和来历见 src/lib/selection.js 的文件头）。
     判据都在那个 module 里：集合完全相等才算"这个框"、正好一条才算"这条线"。 */
  const sel = useMemo(() => readSelection(board, inkSel, links), [board, inkSel, links])
  const focusIds = useMemo(() => {
    if (!selectedId) return null
    const set = descendantsOf(relations, selectedId)
    const p = relations.parentOf.get(selectedId)
    if (p) set.add(p)
    return set
  }, [selectedId, relations])

  // ══════════════════ 指针：画 / 擦 / 平移 / 捏合 ══════════════════
  /* 把 clientX/clientY 换算成**相对画布容器**的坐标。
     这个文件里所有的屏幕坐标都必须过这一道 —— 见文件头"坐标只有一套基准"。 */
  const localPoint = useCallback((e) => {
    const rect = wrapRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const eraseAt = useCallback(
    (wp, history = true) => {
      commit((cur) => {
        const keep = cur.strokes.filter((s) => !strokeHitsCircle(s, wp.x, wp.y, screenLenToWorld(ERASER_R_SCREEN, cur.view.s)))
        return keep.length === cur.strokes.length ? cur : { ...cur, strokes: keep }
      }, history)
    },
    [commit]
  )

  /* 谁在操作？只在"换了设备"时才更新一次状态。
     笔悬停时 pointerType 也已经是 'pen'（不用等落笔），所以笔一靠近光标就没了
     —— 那正好是写字前最碍眼的时候。 */
  const trackPointerKind = useCallback((e) => {
    const isPen = e.pointerType === 'pen'
    if (isPen !== penModeRef.current) {
      penModeRef.current = isPen
      setPenMode(isPen)
    }
  }, [])

  /* 把框选中的那组墨迹删掉。一次删除 = 一步撤销（commit 默认记历史）。
     ⚠ 必须定义在下面那个键盘 useEffect **之前**：它的依赖数组里引用了这里。
       const 是有暂时性死区的，写在后面的话组件一渲染就
       "Cannot access 'xx' before initialization"，整页白屏、什么都不显示。
       （踩过一次：构建完全正常、vite 也不报错，只有浏览器控制台里能看到。） */
  const deleteInkSel = useCallback(() => {
    if (!inkSel || !inkSel.size) return
    const ids = inkSel
    commit((cur) => removeStrokes(cur, ids))
    setInkSel(null)
  }, [inkSel, commit])

  const onPointerDown = useCallback(
    (e) => {
      const el = wrapRef.current
      if (!el) return
      trackPointerKind(e)
      /* ★ 指针捕获必须设在**收到事件的那个元素自己**身上（这里是 .bd-hit）。
         第一版设在最外层的 .bd-stagewrap 上：于是 pointermove / pointerup 被
         重定向到那个 div，而监听器挂在 .bd-hit 上 —— 结果就是
         "按下去像是没反应、拖不动、松手什么都不发生"（.bd-hit 只收到 pointerdown）。
         这一条在写字板上也踩过一次（README 的坑 #7），是同一个错。
         记法：**捕获的对象和挂监听的对象必须是同一个元素。** */
      e.currentTarget.setPointerCapture?.(e.pointerId)
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

      // 双指 → 缩放；同时**作废已经起笔的那一笔**（写字时手掌误触非常常见）
      if (pointersRef.current.size === 2) {
        drawRef.current = null
        clearLive(liveRef)
        const [p1, p2] = [...pointersRef.current.values()]
        pinchRef.current = {
          d: Math.hypot(p2.x - p1.x, p2.y - p1.y),
          mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
          view: boardRef.current.view,
        }
        return
      }

      const lp = localPoint(e)
      const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)

      /* ⓪ 「∈ 条件」武装着 → 这一下不是画、不是选，是**指**：
         点到哪撮字就把"条件就是它"写在那条连接上（点到卡片那条路走 Card 的 onSelect，
         因为卡片自己收指针事件 —— 见下面 Card 的 onSelect）。
         没点到东西就说一句、**保持武装**（指着指着点偏了很正常，不用重新按一次）。
         ⚠ 这一步必须在"平移/框选/画/擦"之前 —— 武装着的时候不该落墨。 */
      if (condArm) {
        const R = 12 / (boardRef.current.view.s || 1) // 12 屏幕像素换算成世界像素
        const hit = [...boardRef.current.strokes].reverse().find((s) => strokeHitsCircle(s, wp.x, wp.y, R))
        if (hit) {
          pickCond(condArm, { strokeId: hit.id })
        } else {
          flash('这一点上没东西 —— 点一下那撮字，或者点一张卡（Esc 取消）', 'warn')
        }
        return
      }

      /* ★ 箭头工具（一次性的，见 ADR-0001）：这一下不是画墨，是"拉一条关系"。
         起点先记下来、拖动时画一条预览线（两端吸到谁就把谁圈一下），松手才写进 `links`。
         纸上**不留墨** —— 屏幕上那条箭头是应用画的（见 links.js 的 readDeclaredLinks）。 */
      if (tool === 'arrow') {
        arrowRef.current = { from: wp, to: wp }
        paintArrowLive(liveRef, boardRef.current, wp, wp, boardRef.current.view)
        return
      }

      // 中键 / 空格 / 手指 → 平移。手写笔永远只画画，这是 Surface 上最要紧的一条。
      if (e.button === 1 || spaceRef.current || e.pointerType === 'touch') {
        panRef.current = { lp, tx: boardRef.current.view.tx, ty: boardRef.current.view.ty }
        return
      }

      /* ① 笔杆侧键按着、或者工具条上选着「框选」→ 开始框选（OneNote 那个手感）。
         必须放在"擦"和"画"前面：按住笔杆键落笔时，不该在板上留下墨迹。
         ★ 为什么还留一个工具条上的「框选」：笔杆侧键只有那几支笔有。
           用鼠标的人、笔上没有侧键的人，原来根本选不中笔迹 ——
           "框住一块字再美化"这条路就对他们完全关着。 */
      if (tool === 'select' || isPenBarrel(e)) {
        const box = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y }
        lassoRef.current = { from: wp, box }
        setLasso(box)
        return
      }

      /* ② 已经选着一组墨迹、又正好按在它的框里 → 整组拖着走。 */
      if (
        sel.box &&
        tool !== 'eraser' &&
        wp.x >= sel.box.x0 && wp.x <= sel.box.x1 &&
        wp.y >= sel.box.y0 && wp.y <= sel.box.y1
      ) {
        // 把"选中那几条按下时的原样"存下来，拖动时拿它算偏移（不累加，见 onPointerMove）
        const origin = new Map()
        for (const s of boardRef.current.strokes) if (inkSel.has(s.id)) origin.set(s.id, s)
        /* 一次拖动 = 一步撤销：起点交给账本记（`moved` 那个手写标记没了 ——
           "动没动过"由 `end()` 按 `sameWithin` 判一次，见 history.js）。 */
        inkMoveRef.current = { from: wp, origin, g: ledger.begin() }
        return
      }

      /* ③ 按在别处 = 取消选中（和大多数软件一样）。
         放在画/擦前面，是为了"点空白"既取消选中、也照常落笔，不用点两次。
         ★ 卡片也要一起取消。原来这里只清 inkSel，**selectedId 一直留着** ——
           于是刚插进来的那张卡永远保持选中、右上角永远挂着一个 ×，
           用户 2026-09-16 报的「一直是右上角有 x，容易误删除」就是这么来的。
           选中这个东西只在"你正在动它"的时候才该亮着。 */
      if (inkSel) setInkSel(null)
      if (selectedId) setSelectedId(null)
      /* 板框的选中也一样：按在空白处取消。在框里写字不该把它取消 ——
         所以这一下只有在**没落在任何框的把手/内容上**时才走到（事件先被它们接走）。 */
      if (selectedFrameId) setSelectedFrameId(null)

      /* 会"擦"的两种情况：
         ① 工具条上选着橡皮；
         ② **笔的另一头**（橡皮端）—— 翻过来按就是橡皮，不用先去切工具。
            抬笔之后工具条上的选择不变，原来选着笔就还是笔。
            于是"写一笔 → 翻过来擦掉 → 翻回来接着写"中间一次点击都不用。
            这就是 OneNote 的手感，也是 Surface 上最省事的一条路。 */
      if (tool === 'eraser' || isPenEraser(e)) {
        eraseAt(wp)
        drawRef.current = { kind: 'erase' }
        return
      }

      if (tool === 'pen' || tool === 'highlighter') {
        const stroke = newStroke(
          tool,
          toFlat([{ x: wp.x, y: wp.y, p: e.pressure || 0.5 }]),
          tool === 'highlighter' ? { color: HL_COLOR, width: HL_WIDTH } : { color, width }
        )
        drawRef.current = { kind: 'ink', stroke, id: e.pointerId }
        paintLive(liveRef, stroke, boardRef.current.view)
      }
    },
    [tool, color, width, localPoint, eraseAt, trackPointerKind, sel.box, inkSel, selectedId, condArm, selectedFrameId, ledger]
  )
  const onPointerMove = useCallback(
    (e) => {
      trackPointerKind(e)

      /* 框选中：把矩形更新到当前点。始终规范化成 x0<x1 / y0<y1，
         这样从右下往左上反着拖也是同一个矩形，渲染时不用再判方向。 */
      if (lassoRef.current) {
        const lp = localPoint(e)
        const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)
        const a = lassoRef.current.from
        const box = {
          x0: Math.min(a.x, wp.x),
          y0: Math.min(a.y, wp.y),
          x1: Math.max(a.x, wp.x),
          y1: Math.max(a.y, wp.y),
        }
        lassoRef.current.box = box
        setLasso(box)
        return
      }

      /* 箭头工具拖着的时候：预览线跟着走（含"吸到谁"的圈）。 */
      if (arrowRef.current) {
        const lp = localPoint(e)
        const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)
        arrowRef.current.to = wp
        paintArrowLive(liveRef, boardRef.current, arrowRef.current.from, wp, boardRef.current.view)
        return
      }

      /* 拖着选中的那组墨迹走。
         ★ 每次都从"按下那一刻的原样"重新算偏移，**不是**累加每一帧的增量 ——
           累加会攒浮点误差，来回拖几次位置就飘了。 */
      if (inkMoveRef.current) {
        const lp = localPoint(e)
        const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)
        const mv = inkMoveRef.current
        const dx = wp.x - mv.from.x
        const dy = wp.y - mv.from.y
        /* 中途每一帧只改板、不记账（"这一下算不算一步"收尾时由账本判一次）。 */
        mv.g.during((cur) => ({
          ...cur,
          strokes: cur.strokes.map((s) => (mv.origin.has(s.id) ? shiftStroke(mv.origin.get(s.id), dx, dy) : s)),
        }))
        return
      }

      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      }

      // 捏合缩放
      if (pinchRef.current && pointersRef.current.size >= 2) {
        const [p1, p2] = [...pointersRef.current.values()]
        const d = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
        const st = pinchRef.current
        const rect = wrapRef.current.getBoundingClientRect()
        const k = st.d > 8 ? d / st.d : 1
        // 全部换算成"相对画布容器"的坐标（和 tx/ty 同一个基准）
        const cx0 = st.mid.x - rect.left
        const cy0 = st.mid.y - rect.top
        const cx1 = mid.x - rect.left
        const cy1 = mid.y - rect.top
        /* 锚点：开始时两指中点下的那个世界点，缩放后还要落在**现在的**中点下。
           两指中点会动 —— 所以走 `zoomBetween`（起点和落点是两个坐标），
           不是 `zoomAt`（锚点不动）。夹上下限也在 view.js 里，这里不再抄一份。 */
        setView(zoomBetween(st.view, clampViewScale(st.view.s * k), { x: cx0, y: cy0 }, { x: cx1, y: cy1 }))
        return
      }

      if (panRef.current) {
        const lp = localPoint(e)
        setView(panBy({ ...boardRef.current.view, tx: panRef.current.tx, ty: panRef.current.ty }, lp.x - panRef.current.lp.x, lp.y - panRef.current.lp.y))
        return
      }

      const lp = localPoint(e)
      const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)

      /* 在擦的两种情况：工具条上选着橡皮，或者这一笔是**用笔的另一头**起的。
         后者必须看 drawRef 而不是看工具 —— 用橡皮头的时候，工具条上可能还选着"笔"，
         只看工具的话，就只有按下那一点会被擦掉，拖过去是不擦的。 */
      if (tool === 'eraser' || (drawRef.current && drawRef.current.kind === 'erase')) {
        /* ⚠ 这里必须把 r 一起塞进去。
           screenToWorld 只给 {x, y}，而 .bd-eraser 的宽高是 `2 × r × s` ——
           少了 r 就成了 NaN，浏览器直接忽略 → 那个橡皮圈**一直画不出来**（原有的问题）。
           `r` 走**世界**半径（渲染时再乘回屏幕），于是圈在屏幕上恒定大小，
           和擦除判定用的是同一个半径 —— 两边都走 screenLenToWorld，别自己除。 */
        setEraserAt({ x: wp.x, y: wp.y, r: screenLenToWorld(ERASER_R_SCREEN, boardRef.current.view.s) })
        if (drawRef.current && drawRef.current.kind === 'erase') eraseAt(wp, false)
        return
      }

      const d = drawRef.current
      if (d && d.kind === 'ink' && d.id === e.pointerId) {
        /* ★ 必须取 getCoalescedEvents。Surface 的笔一秒能报 240+ 个位置，
           而 pointermove 一帧只给你最后一个 —— 不取的话快速书写的曲线
           会被削成折线（"写字有棱角"就是这么来的）。 */
        const ne = e.nativeEvent
        const evs = typeof ne.getCoalescedEvents === 'function' ? ne.getCoalescedEvents() : []
        const list = evs && evs.length ? evs : [ne]
        const rect = wrapRef.current.getBoundingClientRect()
        const s = boardRef.current.view.s
        let added = false
        for (const ev of list) {
          const w2 = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, boardRef.current.view)
          const n = d.stroke.points.length
          if (n >= 3) {
            const dx = w2.x - d.stroke.points[n - 3]
            const dy = w2.y - d.stroke.points[n - 2]
            /* 阈值按**屏幕**算：`MIN_STEP_SCREEN` 是屏幕像素，落点已经是世界坐标了，
               所以先换算回世界再比（放大后世界坐标的一步更小，不换算会把细节吃掉）。 */
            if (Math.hypot(dx, dy) < screenLenToWorld(MIN_STEP_SCREEN, s)) continue
          }
          d.stroke.points.push(w2.x, w2.y, ev.pressure > 0 ? ev.pressure : 0.5)
          added = true
        }
        if (added) paintLive(liveRef, d.stroke, boardRef.current.view)
      }
    },
    [tool, localPoint, setView, eraseAt, trackPointerKind, commit, ledger]
  )

  const onPointerUp = useCallback(
    (e) => {
      pointersRef.current.delete(e.pointerId)
      if (pointersRef.current.size < 2) pinchRef.current = null
      panRef.current = null

      /* ★ 箭头工具松手 = 这一步真的发生：两端吸到最近的卡片/板框，写进 `links`。
         一次性：画完回笔（见 ADR-0001 的候选 3）。 */
      if (arrowRef.current) {
        const a = arrowRef.current
        arrowRef.current = null
        clearLive(liveRef)
        finishArrow(a.from, a.to)
        return
      }

      /* 框选松手：把圈到的墨迹选上。
         用 lassoRef 里的 box 而不是 lasso 这个 state —— 两者在同一帧里可能差一步，
         松手这一刻要的是"最后画出来那个框"。 */
      if (lassoRef.current) {
        const box = lassoRef.current.box
        lassoRef.current = null
        setLasso(null)
        /* 记下这个框：「留下板框」要拿它找卡片成员（见 keepFrame 的说明）。 */
        lastLassoRef.current = box
        let ids = boardRef.current.strokes.filter((s) => strokeHitsRect(s, box)).map((s) => s.id)
        /* ★ 点一下那条线 = 选中它（"点线即选中"，2026-09-16 加）。
           以前改一个词得先**框住**那条线 —— 一条线本来就是一个点得中的东西，
           多一个框的手势是白费的。判据三条，都是为了让"点"不误伤：
             · 框小到几乎是一个点（**≤4 屏幕像素**见方）—— 拖框的行为一个字不变；
             · 框里没有别的笔迹；
             · 只认**已经算出来是连接**的那些笔（linkByStroke），
               所以点一下字不会把某一笔字选中。
           过一会儿那排词会在线上浮出来（.bd-inklink），和框住时看到的是同一个。
           ⚠ 这里的"小框"和下面那个命中半径**必须是同一套单位（屏幕像素）**：
             原来写的是"4 世界像素"，放大到 6 倍时 4 世界像素 = 24 屏幕像素 ——
             轻轻拖一下就成了"点"，行为跟手上的动作对不上（审查挑出来的）。 */
        const vs = boardRef.current.view.s
        if (!ids.length && worldLenToScreen(box.x1 - box.x0, vs) <= 4 && worldLenToScreen(box.y1 - box.y0, vs) <= 4) {
          const cx = (box.x0 + box.x1) / 2
          const cy = (box.y0 + box.y1) / 2
          const r = screenLenToWorld(10, boardRef.current.view.s)
          const hit = boardRef.current.strokes.find((s) => linkByStroke.has(s.id) && strokeHitsCircle(s, cx, cy, r))
          if (hit) ids = [hit.id]
        }
        setInkSel(ids.length ? new Set(ids) : null)
        /* 空框说一句人话。静默什么都不发生是最让人迷惑的 ——
           用户会以为"框选坏了"，而其实只是框小了/框到空白上了。 */
        if (!ids.length) flash('框里没有笔迹 —— 框大一点，或者框到字上', 'warn')
        return
      }

      /* 拖完松手：整次拖动记成一步撤销（中途那些帧都不记）。 */
      if (inkMoveRef.current) {
        const mv = inkMoveRef.current
        inkMoveRef.current = null
        mv.g.end()
        return
      }

      const d = drawRef.current
      if (!d) return
      // 只有"起笔的那支笔"抬起时才收笔（另一支笔抬起不该结束当前笔画）
      if (d.kind === 'ink' && d.id !== e.pointerId) return
      drawRef.current = null
      clearLive(liveRef)

      if (d.kind === 'ink') {
        const pts = toPoints(d.stroke.points)
        if (pts.length < 2) return
        // 太短的一笔（误触）丢掉，别在板上留个孤立墨点
        if (pathLength(pts) < 2.5) return
        const simple = simplifyPoints(pts, 0.6)
        const stroke = { ...d.stroke, points: toFlat(simple) }
        commit((cur) => ({ ...cur, strokes: [...cur.strokes, stroke] }))
        /* ★ 这一笔要是正好连上了两个东西，就在旁边浮出那排词。
           顺序要紧：先 commit（boardRef 里已经有这一笔了），再 offerLink ——
           offerLink 是拿**最新的板**去算连接的，早了就找不到自己这一笔。 */
        offerLink(stroke)
      } else if (d.kind === 'erase' && tool !== 'eraser') {
        /* 这一次是**笔的另一头**在擦，抬笔就把那个橡皮圈收掉。
           （工具是橡皮的时候不能收 —— 那个圈得一直跟着鼠标，当光标用。） */
        setEraserAt(null)
      }
    },
    [commit, tool, flash]
  )

  // ── 滚轮：缩放 / 横向平移 ──
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    function onWheel(e) {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const lp = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      if (e.ctrlKey || e.metaKey) {
        setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.01), lp.x, lp.y))
      } else if (e.shiftKey) {
        setView((v) => ({ ...v, tx: v.tx - e.deltaY }))
      } else {
        setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0016), lp.x, lp.y))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView])

  // ── 键盘 ──
  useEffect(() => {
    function inField(t) {
      const tag = (t && t.tagName) || ''
      return /^(INPUT|TEXTAREA)$/.test(tag) || (t && t.isContentEditable)
    }
    function onKey(e) {
      if (e.code === 'Space' && !inField(e.target)) {
        spaceRef.current = true
        e.preventDefault()
        return
      }
      if (inField(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        const el = wrapRef.current
        // 装回屏幕 = 程序适配，不是你定的视野 → pin=false，下次打开还会重新适配
        if (el) setView(fitView(boardRef.current, el.clientWidth, el.clientHeight, 70), false)
        return
      }
      /* 那排词浮着的时候：`1`~`5` 直接选一个（鼠标用户不用去点它），`Esc` 收走。
         放在这一串快捷键的最前面 —— 它是个"正在等你回一句"的临时界面，
         要有优先权，不然会被下面的字母键当工具切换吃掉。 */
      if (linkPick && /^[1-5]$/.test(e.key)) {
        const k = LINK_KINDS[Number(e.key) - 1]
        if (k) {
          e.preventDefault()
          applyLink(linkPick, k.id)
          return
        }
      }
      /* `0` = 删掉这条连接（和 1~5 同一排，手不用离开键盘）。 */
      if (linkPick && e.key === '0') {
        e.preventDefault()
        applyLink(linkPick, LINK_DELETE)
        return
      }
      if (linkPick && e.key === 'Escape') {
        setLinkPick(null)
        return
      }
      if (e.key === 'Escape') {
        /* 武装着「∈ 条件」时，Esc 先收掉它（不然你以为取消了、其实下一下点还是会指过去）。 */
        if (condArm) {
          setCondArm(null)
          flash('不收条件了', 'ok')
          return
        }
        /* 正在给板框改名 → Esc 先收编辑（别顺手把选中的东西也一起取消，
           那会让你觉得"我按一下 Esc，框也没了"）。 */
        if (frameEditId) {
          setFrameEditId(null)
          return
        }
        setSelectedId(null)
        setEditingId(null)
        setInkSel(null)
        setSelectedFrameId(null)
        return
      }
      /* 选中一个板框时，Delete 把那几样东西从框里**拿出来**（框还在、内容一个字不动）——
         它和"删内容"是两件事：想删内容得先框住内容本身。 */
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFrameId && !inkSel && !selectedId) {
        e.preventDefault()
        const f = (boardRef.current.frames || []).find((x) => x.id === selectedFrameId)
        if (f) {
          commit((cur) => dissolveFrame(cur, f.id))
          setSelectedFrameId(null)
          flash('拆开了 —— 里面的东西照旧留在板上', 'ok')
        }
        return
      }
      if (e.key === 'p' || e.key === 'P') return setTool('pen')
      if (e.key === 'e' || e.key === 'E') return setTool('eraser')
      // S = select：框选。挑 S 是因为它没被占（P 是笔、E 是橡皮、W 是写字板、Space 是平移）
      if (e.key === 's' || e.key === 'S') return setTool('select')
      /* A = arrow：箭头工具（一次性的，见 ADR-0001）。挑 A 是因为它没被占，
         而且"Arrow"这个词本身就带着它 —— 用笔的人不用跑去点栏上那颗按钮。 */
      if (e.key === 'a' || e.key === 'A') {
        setTool('arrow')
        flash('箭头工具：从一样东西划到另一样东西（画完自动回到笔）', 'ok')
        return
      }
      // W = write：写字板。挑 W 是因为它没被占（P 是笔、E 是橡皮、Space 是平移）
      if (e.key === 'w' || e.key === 'W') {
        setPadOpen((v) => !v)
        return
      }
      /* 框选着一组墨迹时，Delete / Backspace 删掉它们。
         用笔的时候不一定按得到键盘，所以画布上还浮着一个删除按钮兜着。 */
      if ((e.key === 'Delete' || e.key === 'Backspace') && inkSel) {
        e.preventDefault()
        deleteInkSel()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        /* ★ 固定的卡片不给删。它是"锁住"的语义，而 Delete 是最容易误按的一个键。
           （它平时选不中，所以正常路径下也走不到这儿；但关系面板里点一下名字
           是会选中的 —— 那条路得挡住。）想删就先点 📌 解开。 */
        const card0 = boardRef.current.cards.find((c) => c.id === selectedId)
        if (card0 && card0.locked === true) {
          flash('这张卡固定着，先点它左下角的 📌 解开再删', 'warn')
          return
        }
        commit((cur) => ({ ...cur, cards: cur.cards.filter((c) => c.id !== selectedId) }))
        setSelectedId(null)
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const d = e.key === 'ArrowRight' ? 1 : -1
        setVariantAndUrl(VARIANTS[(VARIANTS.indexOf(variant) + d + 3) % 3], setVariant)
      }
    }
    const onUp = (e) => {
      if (e.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
    }
  }, [undo, redo, setView, selectedId, commit, variant, inkSel, deleteInkSel, linkPick, linkByStroke, condArm, frameEditId, selectedFrameId])

  // ══════════════════ 卡片 ══════════════════
  const stageCenterWorld = useCallback(() => {
    const el = wrapRef.current
    if (!el) return { x: 0, y: 0 }
    return screenToWorld(el.clientWidth / 2, el.clientHeight / 2, boardRef.current.view)
  }, [])

  /* 手写识别的结果落到白板上。卡片放在视野中央，然后立刻打开编辑器：
     识别总会有认错的时候，直接让你改比"先放上去、再发现错了、再双击"少两步。

     ★ src 必须一起写上识别结果（原来这里是留空的 src: ''）——
       编辑态里编辑的是 **src**，而编辑态**只渲染那个输入框**（不渲染 tex 的公式）。
       留空 = 卡片里出现一个空框，刚认出来的式子在编辑态下**一个字都看不见**；
       更糟的是用户顺手按个回车，commitEdit 就把 `tex: toTex('')` 写进去，
       整张卡被清空成"双击写公式"。
       实测（2026-09-15）：插进去 tex 是对的，但编辑框 value 是 ""，按一次回车 → tex/src 全空。
       用户报的正是这个：「识别是对的，但放不到白板上，还弹出一个没法交互的弹窗」
       （那个"弹窗"就是卡片里的空输入框）。
       原来留空 src 的理由是"给手打的那串留个参照" —— 手写这条路没有"手打的那串"，
       留空没有任何参照价值，只有上面那一串坏处。 */
  function insertRecognized({ tex }) {
    const c = newCard('formula', stageCenterWorld().x, stageCenterWorld().y)
    commit((cur) => ({ ...cur, cards: [...cur.cards, { ...c, src: tex, tex }] }))
    setPadOpen(false)
    setSelectedId(c.id)
    setEditingId(c.id)
    /* ★ 写字板这条路上来的公式卡**也要量一次尺寸**：完全贴着式子。
       不量的话它就是默认的 260 宽：一行 `E = mc²` 只有 60 宽，居中之后左右全是空的
       （用户 2026-09-16 报的"识别公式留白依旧很多"，多半就是这张）。
       keepCenterX：卡片是以视野中心放上去的，收宽度要**从中间缩**，不然会往左跳。
       （排队自己就会下一帧开跑；这一次进编辑态量不着，退出编辑时那一趟才量得上。） */
    fitter.queue(c.id, { fitWidth: true, keepCenterX: true })
  }

  /* 换纸。**当场存**，不像板的内容那样等停笔 0.7 秒 ——
     它是"我习惯怎么看这张板"，跟板里画了什么没关系（理由见上面 PAPERS 那段）。
     写不进去（隐私模式下 localStorage 会抛）就算了：这一次照样生效，
     下次打开回到默认，而不是整个界面炸掉。 */
  function pickPaper(id) {
    if (!PAPERS.some((p) => p.id === id)) return
    setPaper(id)
    try {
      localStorage.setItem(PAPER_KEY, id)
    } catch {
      /* 存不了就只生效这一次 */
    }
  }

  /* 固定 / 解开一张卡（2026-09-16 用户：「给卡片加一个固定按钮用来防止误触」）。
   *
   * 「固定」= **这张卡不再收指针事件**（CSS 里的 .bd-card.locked）。
   * 于是它变成"纸的一部分"：
   *   · 用笔从它身上划过 = 在纸上写字（笔本来就让路，现在鼠标也一样）；
   *   · 鼠标/手指按上去 = 落在下面的收事件层上 —— 拖不动、也选不中；
   *   · 双击不进编辑态、× 和缩放柄也不出现（选中才会有，而它选不中）。
   * 只有角上那颗 📌 自己还收事件 —— 所以"钉死了拿不下来"不会发生。
   *
   * 为什么要它：用笔写字的时候手会蹭到卡片，一下就把它拖走了，或者点出一堆手柄；
   * 位置定好的公式卡本来就不该被碰。
   *
   * 存的字段是 `locked`（不是 pinned）—— 板文件里 `viewPinned` 已经占掉了
   * "pinned" 这个词（那个是"视角定住了、下次打开别自动适配"），两个混起来
   * 以后读代码的人一定会看错。序列化只在真的锁了的时候写这个字段（见 lib/board.js）。 */
  function toggleLock(id) {
    const c = boardRef.current.cards.find((x) => x.id === id)
    if (!c) return
    const locked = c.locked !== true
    commit((cur) => ({ ...cur, cards: cur.cards.map((x) => (x.id === id ? { ...x, locked } : x)) }))
    /* 锁上 → 顺手取消选中（不然手柄留在锁定的卡上，看着像还能动，其实点不动）；
       解开 → 顺手选中它，手柄立刻出来，接着拖就行。 */
    setSelectedId(locked ? null : id)
    flash(locked ? '固定住了：拖不动、双击也不会进编辑（点 📌 解开）' : '解开了，可以拖了', 'ok')
  }

  /* ── 箭头工具：一次划动 = 一条连接（见 ADR-0001）───────────────────────────
   *
   * 用户 2026-09-17：「现在在识别上箭头啊、墨迹块啊很可能达不到用户的需求，
   * 所以我需要的是**直接把这些功能交给用户**」。
   * 于是"一条连接从哪来"这件事换了个来源：从**猜**（形状/位置判据，实测 92:0）
   * 换成**宣告** —— 你选一次箭头工具、划一笔、松手定两头。
   *
   * ★ 一次性：画完自动回到笔。理由是他自己的用法 ——
   *   「往往两个板块画完之后只要连一笔，而不是很多个板块后慢慢链接」。
   * ★ 纸上不留墨：屏幕上那条箭头是应用画的（`readDeclaredLinks`），
   *   所以它两端贴着框/卡的边、框一动跟着动。
   * ⚠ 两头**都必须吸到东西**才算数：吸不到就说清楚是哪一头没吸上。
   *   （"允许一头悬空"还没做 —— 那要给记录存一个世界坐标点、再加一条"以后把那一头接上去"
   *     的交互，是独立的一刀；现在靠 40px 的吸附半径兜"停在东西前面一点"这种情况。） */
  function finishArrow(from, to) {
    const b = boardRef.current
    const na = snapNode(b, from)
    const nb = snapNode(b, to)
    if (!na || !nb) {
      const miss = !na && !nb ? '两头都没落在东西上' : !na ? '起点那一头没落在东西上' : '终点那一头没落在东西上'
      flash(`${miss} —— 画到卡片或板框上（离得近一点也算）`, 'warn')
      return
    }
    if (na.id === nb.id) {
      flash('两头是同一个东西 —— 一条连接要连两个不同的卡片/板框', 'warn')
      return
    }
    const next = declareLink(b, na.id, nb.id, ARROW_LINK)
    if (next === b) {
      flash('这两样之间已经有一条了 —— 点线上那颗词能改词、或者删掉', 'warn')
      return
    }
    commit(next)
    setTool('pen') // 一次性：画完回笔
    /* 顺手把那排词浮出来：想改成「推导/并列/等价」当场就能点（3.5 秒不点自己收走）。 */
    const hit = linkReader.read(next).find((l) => l.declared && l.a === na.id && l.b === nb.id)
    if (hit) {
      const { x, y } = linkPickAt(hit.mid)
      setLinkPick({ id: hit.id, declared: true, a: hit.a, b: hit.b, x, y, kind: hit.kind, dir: hit.dir })
    }
    const nm = (n) => (n.kind === 'frame' ? n.label : '卡片')
    flash(`连上了：${nm(na)} → ${nm(nb)}（因果；想改词点线上那颗词）`, 'ok')
  }

  /* ── 连接线上的那一步（可选）──
   * 2026-09-16 用户：「我要更便捷的显示出两者之间的主次、因果、并列等关系」
   * 「我操作的速度是很快的，我没有时间去逐步花很多时间操作这个表示关系的步骤」
   *
   * 所以这里的设计是**零步骤优先**：**你画的**那条线（两张卡之间）画完就成立；
   * **你连的**那条（箭头工具）连上就成立、屏幕上立刻有线有词。
   * 下面这个函数只做一件事：**让你随时用一下（或者不用）去改那一个词** ——
   * 画完 3.5 秒浮出来，不点就收走；以后想改，点线上那颗词 / 框住那条线还能再来一次。
   *
   * 为什么不用弹窗/必须点：你在想事情的时候，任何"必须先处理一下"的界面都是打断。
   * 为什么还要留这一个口子：五个词里只有「因果」是箭头工具的本意，
   * 要表达"推导"必须有一条一句话改掉的路。
   *
   * ★ 一条连接有两种来源，`0` 那颗「删掉这条连接」翻译成两件事：
   *   · **你连的**（`board.links` 里那条记录）→ 删掉记录；
   *   · **你画的**（一笔线连了两张卡）→ 删掉那一笔（线没了，关系自然也没了）。 */
  function applyLink(link, kind, opt = {}) {
    if (!link) return
    const b = boardRef.current
    if (link.declared) {
      const next = kind === LINK_DELETE ? removeLink(b, link.a, link.b) : setLinkKind(b, link.a, link.b, kind)
      if (next === b) return
      commit(next)
      setLinkPick(null)
      flash(kind === LINK_DELETE ? '删掉这条连接了（Ctrl+Z 能退回）' : `这条连接：${linkKind(kind).name}`, 'ok')
      return
    }
    /* 画出来的那一条：整条规矩（改词、反向、和"自动那一档"相同时不写字段）都在
       selection.js 的 `applyStrokeLink` 里，纯函数、有断言（check-board [6m]）。
       返回 null = 那个词不认识 —— 什么都不做，也不弹提示。 */
    if (kind === LINK_DELETE) {
      const ids = new Set(link.ids && link.ids.length ? link.ids : [link.strokeId])
      commit((cur) => removeStrokes(cur, ids))
      setLinkPick(null)
      setInkSel(null)
      flash('删掉这条线了 —— 关系跟着那一笔一起没了（Ctrl+Z 能退回）', 'ok')
      return
    }
    const next = applyStrokeLink(b, links, link.strokeId, kind, opt)
    if (!next) return
    commit(next)
    setLinkPick(null)
    flash(opt.reverse ? `方向反过来了：${linkKind(kind).name}` : `这条线：${linkKind(kind).name}`, 'ok')
  }

  /* 「又算回连接」（那道单向门的回头路）第二刀删掉了 ——
     它存在的理由是"形状判读会猜错"，而形状判读整族已经删掉（ADR-0001）。
     现在"这条连错了"只有一句：删掉这条连接（那排词里 `0` 那颗）。 */

  /* ── 「这个条件不算」/「条件就是它」 ────────────────────────────────────────
   * 条件本来是**位置送的**：写在那条线弧长中点旁边的字/卡自动成为它的条件。
   * 位置两头都不灵的时候就得有说法：
   *   · 读错了 → `noCond`（`cond:'none'`，否决权优先，不再往位置里读）；
   *   · 读不到（条件写在别处）→ `armCond` 武装一下、再点一下目标（卡片或那撮字），
   *     写 `cond:'card:<id>'` / `'ink:<笔 id>'`。
   * ★ 两个口子都要有回头路（`condBack`）：一句话说出口、重开之后就没路了，那还是单向门 ——
   *   和「不算连接」的「又算回连接」是同一个道理。
   * ⚠ 只说"那个不是条件"/"就是它"，不是"这一步不需要条件" —— 否决之后面板照实回到
   *   "缺条件"，补的办法还是老规矩：在中点旁边把该写的写上（或者指一个）。 */
  function noCond(link) {
    if (!link) return
    commit((cur) => vetoCond(cur, link))
    flash('这个条件不算了 —— 那撮字照旧留在板上（想改回来点 ↺）', 'ok')
  }

  function condBack(link) {
    if (!link) return
    commit((cur) => clearCond(cur, link))
    flash('又按位置读了（那条线中点旁边写什么就是什么）', 'ok')
  }

  /* 武装：「∈ 条件」按下之后，下一下点在哪张卡/哪撮字上，它就成了这条线的条件。
     一次性（点完就收）—— 不做成常驻模式，免得下次画东西时它还开着。 */
  function armCond(link) {
    if (!link) return
    setCondArm(link)
    flash('点一下要当条件的那张卡、或者那撮字（Esc 取消）', 'warn')
  }

  /* 真去说那句"条件就是它"。kind 由"点到了什么"决定（卡片 / 笔迹）。 */
  function pickCond(link, target) {
    const value = target && target.cardId ? condCard(target.cardId) : condInk(target && target.strokeId)
    if (!value) return false
    commit((cur) => specCond(cur, link, value))
    setCondArm(null)
    flash(target.cardId ? '这张卡就是它的条件了（点 ↺ 回到按位置读）' : '这撮字就是它的条件了（点 ↺ 回到按位置读）', 'ok')
    return true
  }

  /* ── 板框：留下 / 拆开 / 改标题 / 整体挪（见 ADR-0001、lib/frames.js）──────────
   * 从前这里叫"固定成一块"（`groups`）：**不可见**、只能装笔迹。现在它是**板框** ——
   * 有框线、有标题、成员可以是笔迹和卡片，还能整体拖动。
   * ★ 归属只在**你按「留下板框」的那一刻**判定：以后再往框里画一笔，它不会自己变成成员
   *   （那又变回"位置猜"，而这次的整个教训就是别猜）。想加就明说（frames.js 的 addToFrame）。
   * ★ 卡片成员靠**最后一次框选的矩形**找（卡片中心落在框里才算）——
   *   不能用"选中笔迹的包围盒"：你顺手圈进来的那张卡会被漏掉，
   *   而"板框里的东西形成一个整体"正是你要的那句话。 */
  function keepFrame() {
    const b = boardRef.current
    const ids = inkSel ? [...inkSel] : []
    if (!ids.length) {
      flash('先框住要归到一块的笔迹（笔杆侧键拖一圈，或者工具条上的「⬚ 框选」）', 'warn')
      return
    }
    const box = lastLassoRef.current || sel.box
    const cards = membersInBox(b, box).cards
    const { board: next, movedFrom } = freezeFrameSelection(b, ids, cards)
    commit(next)
    setInkSel(null)
    flash(
      movedFrom.length
        ? `留下板框了（${ids.length} 笔 + ${cards.length} 张卡）—— 其中几样原来在别的框里，已经挪过来了`
        : `留下板框了（${ids.length} 笔 + ${cards.length} 张卡）—— 拖框上那个名字能整体挪，双击能起名`,
      'ok'
    )
  }

  function dissolveFrameNow() {
    if (!sel.frame) return
    const id = sel.frame.id
    commit((cur) => dissolveFrame(cur, id))
    setInkSel(null)
    setSelectedFrameId((cur) => (cur === id ? null : cur))
    flash('拆开了 —— 里面的东西照旧留在板上', 'ok')
  }

  function renameFrame(frameId, title) {
    commit((cur) => setFrameTitle(cur, frameId, title))
  }

  /* 整体挪：挪的是**成员**（框线是成员的函数，跟着走）。
     一次拖动 = 一步撤销 —— 中途那些帧走账本的 `during`（不记账），
     松手时 `end()` 把"按下那一刻的板"补进撤销栈，判据是"和起点是不是同一个样"
     （从前这里是"两个数组还是不是同一个引用"，四个手势里唯一有 Ctrl+Z 断言的一条）。 */
  function frameDragStart(frameId) {
    frameDragRef.current = { id: frameId, g: ledger.begin() }
    setSelectedFrameId(frameId)
  }

  function frameDrag(frameId, dxScreen, dyScreen) {
    const st = frameDragRef.current
    if (!st || st.id !== frameId) return
    const k = boardRef.current.view.s || 1
    /* 屏幕位移 → 世界位移：走 view.js 那一处（别自己除 s）。 */
    st.g.during((cur) => translateFrame(cur, frameId, screenLenToWorld(dxScreen, k), screenLenToWorld(dyScreen, k)))
  }

  function frameDragEnd(frameId) {
    const st = frameDragRef.current
    frameDragRef.current = null
    if (!st || st.id !== frameId) return
    st.g.end()
  }

  /* 那排词放在哪：连接线的中点上、再往上让开一点 ——
     线中段常常写着你顺手写的条件（"仅当…"），压在上面会挡住它。
     ★ 还要**夹进画布范围**：浮出来的东西跑到屏幕外或压到底部工具条底下，
     用户就点不到了（缩放柄、美化按钮都栽过这一条，见 README 第 13 条）。 */
  function linkPickAt(midWorld) {
    const el = wrapRef.current
    const v = boardRef.current.view
    if (!el) return { x: 0, y: 0 }
    /* 世界点 → 屏幕点：走 view.js 那一处（从前这里是手推的 `midWorld.x * v.s + v.tx`
       —— 同一道映射，但绕过了唯一的那个 module，见 README 第 26 条/第 39 条）。 */
    const p = worldToScreen(midWorld, v)
    const x = p.x
    const y = p.y
    /* ⚠ 下面那三个边距是**屏幕**像素：它们管的是"那颗词别跑到屏幕外 / 别压到底部工具条底下"
       （工具条 z-index 20，见 README 第 13 条）。夹取政策还没收进 module（架构 review 候选 1
       的尾巴：`chipPlacement`），但它和上面那条映射是两件事，别再混在一行里手推。 */
    return {
      x: Math.min(Math.max(x, 130), Math.max(130, el.clientWidth - 130)),
      y: Math.min(Math.max(y, 96), Math.max(96, el.clientHeight - 60)),
    }
  }

  /* 刚画完一笔：如果它正好连上了两个东西，就把那排词浮出来。
     注意这时候连接**已经成立了**（buildLinks 从笔迹现算），浮词只是给你一次改的机会。 */
  function offerLink(stroke) {
    const hit = linkReader.read(boardRef.current).find((l) => l.strokeId === stroke.id)
    if (!hit) return
    const { x, y } = linkPickAt(hit.mid)
    setLinkPick({ strokeId: stroke.id, x, y, kind: hit.kind, dir: hit.dir })
  }

  /* 点那颗词（已经标过的连接上那个小标签）→ 再浮一次，方便改。 */
  function openLinkPick(link) {
    const { x, y } = linkPickAt(link.mid)
    setLinkPick({
      strokeId: link.strokeId,
      id: link.id,
      declared: !!link.declared,
      a: link.a,
      b: link.b,
      x,
      y,
      kind: link.kind,
      dir: link.dir,
    })
  }

  /* 3.5 秒不点就收走（指针停在那排词上就不收 —— 正在读的人别被打断）。 */
  useEffect(() => {
    if (!linkPick) return
    const t = setTimeout(() => {
      if (!linkLeftRef.current) setLinkPick(null)
    }, LINK_PICK_MS)
    return () => clearTimeout(t)
  }, [linkPick])

  /* 打开「从框选到卡片」。没有框住东西就直说 —— 这两个按钮在选区浮层上，
     理论上按得到就一定选着东西；但工具条上那个入口不保证。 */
  function openInkPanel(mode) {
    if (!(inkSel && inkSel.size)) {
      flash('先用「⬚ 框选」圈住要认的手写（或者按住笔杆键拖一个框）', 'warn')
      return
    }
    setInkMode(mode)
  }

  /* 排上量尺寸的头几趟（字体就绪那一趟、以及"排完队要开跑"）已经不在这里了 ——
     整套"什么时候重量"搬进了 `src/lib/card-fit.js` 的 `notify({ reason })`
     （2026-09-17 架构 review 候选 6）。这个文件只报"发生了什么"：
     load / board-changed / editing-ended，外加插入那张卡的定向 `queue`。
     ★ 那条坑还在原处记着：**排了队不叫它开跑就等于什么都没发生**，
       而现在没有哪条路能忘掉这一脚（`queue` 和 `notify` 内部都会 kick）。 */

  /* 识别结果落成一张卡（文字卡或公式卡）。
   *
   * ★ 落点 = 你圈的那块笔迹的左上角，宽度先按那块笔迹算（textCardRect，纯函数、有自检）；
   *   插进去之后立刻按**真实内容**量一次，收到贴着内容为止 —— 卡片**不去盖**那几笔手写
   *   （2026-09-16 用户定的：「不用盖住，就让框贴合公式和字就行」）。
   *   所以原来的手写会露在卡片周围：不想要它了，就勾面板上那个"顺便把原来的手写擦掉"。
   *
   * ★ 擦原笔迹是**可选**的（面板上那个勾），而且和"加卡片"合并成**一次 commit**：
   *   一次 Ctrl+Z 把两件事一起退回去。分开两次 commit 的话，
   *   用户按一次撤销只退了擦除、卡片还留着，看起来像"撤销坏了"。
   *
   * ★ 插完直接进编辑态：识别总会有认错的时候，直接让你改比"先放上去、再双击"少两步
   *   （和手写公式那条路同一个做法）。 */
  function insertFromInk({ mode, text, font, src, tex, erase }) {
    const isFormula = mode === 'formula'
    if (isFormula ? !String(src || '').trim() : !String(text || '').trim()) return
    const box = sel.box || { x0: 0, y0: 0, x1: 0, y1: 0 }
    /* 尺寸先按估算来（真实尺寸下一帧会量出来）。
       落点用你圈的左上角，宽度先按那块笔迹 —— 这只是"先摆上去"的初值。 */
    const rect = textCardRect(box, isFormula ? 'x' : text)
    const card = isFormula
      ? { ...newCard('formula', 0, 0), ...rect, src: String(src), tex: String(tex || '') }
      : { ...newCard('note', 0, 0), ...rect, text: String(text), font: font || DEFAULT_CARD_FONT }
    const kill = erase && inkSel && inkSel.size ? inkSel : null
    commit((cur) => ({
      ...cur,
      cards: [...cur.cards, card],
      strokes: kill ? cur.strokes.filter((s) => !kill.has(s.id)) : cur.strokes,
    }))
    setInkMode(null)
    setInkSel(null)
    setSelectedId(card.id)
    setEditingId(card.id)
    /* 卡片落进 DOM 之后按真实内容量一次尺寸（"留白太多"就是这一步治的）——
       两条轴都收，公式卡和文字卡一样（"就让框贴合公式和字"）。
       勾不勾"擦掉原笔迹"只影响**那几笔还在不在**，不再影响卡片多大。
       ★ 插完是进编辑态的，所以这一次量不着（编辑器不是内容）——
         排进队里，等退出编辑时那一趟（`notify('editing-ended')`）量。 */
    fitter.queue(card.id, { fitWidth: true })
    flash(
      (isFormula ? '公式卡放上去了' : '放上去了') +
        (erase ? '，原来那几笔已擦掉（Ctrl+Z 能退回）' : '，原来那几笔还留在板上（卡片不盖它）')
    )
  }

  /* 拖右下角放大缩小一张卡。手势的 move/up 挂在 window 上（见下面的说明）。 */
  function startResize(cardId, rectW, startX) {
    const c0 = boardRef.current.cards.find((x) => x.id === cardId)
    if (!c0) return
    const st = { id: cardId, rectW: rectW || c0.w, startX, scale: c0.scale || 1, w: c0.w }
    /* 一次缩放 = 一步撤销：起点交给账本（`moved` 那个手写标记没了）。 */
    const g = ledger.begin()

    const onMove = (e) => {
      const dx = e.clientX - st.startX
      /* 这道门留在原地：它管的是"这一下别污染手势"（1.5 屏幕像素的起手噪声），
         不是"算不算一步" —— 后者由账本的 `end()` 判（见 history.js）。 */
      if (Math.abs(dx) < 1.5) return
      const k = (st.rectW + dx) / st.rectW
      const next = nextCardScale({ w: st.w, scale: st.scale }, k)
      g.during((cur) => ({ ...cur, cards: cur.cards.map((x) => (x.id === st.id ? { ...x, scale: next } : x)) }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      g.end()
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  /* 板框要画成什么样：`{frame, box}` 一对一对地算出来（box = 成员包围盒 + 内边距）。
     算在这里、不写进数据 —— 框是**成员的函数**（见 frames.js 的文件头）。
     `box` 为空（成员都没了）的框不画：屏幕上绝不出现一个"围着空气的框"，
     它会在下一次 commit 的 pruneFrames / 存盘时被收掉。 */
  const framesToDraw = useMemo(() => {
    const out = []
    for (const f of board.frames || []) {
      const box = frameBounds(board, f)
      if (box) out.push({ frame: f, box })
    }
    return out
  }, [board])

  /* stageProps 里那些东西要一起传给画布：卡片层作为 children（同一个世界原点）。 */
  const stageProps = {
    sceneRef, liveRef, view: board.view, size,
    strokes: board.strokes, relations, cardById,
    cardsForInk: inkPairs, hoverEdge, eraserAt,
    links, selLink: sel.link, linkPick, onPickLink: openLinkPick, onApplyLink: applyLink,
    inkFrame: sel.frame, onKeepFrame: keepFrame, onDissolveFrame: dissolveFrameNow,
    /* 板框那一族（见 frames.js）：渲染要的是"框 + 框线矩形"，交互只有把手那三件事。 */
    frames: framesToDraw,
    frameEditId,
    selectedFrameId,
    onFrameSelect: setSelectedFrameId,
    onFrameDragStart: frameDragStart,
    onFrameDrag: frameDrag,
    onFrameDragEnd: frameDragEnd,
    onFrameTitle: renameFrame,
    onFrameEdit: setFrameEditId,
    onFrameEditClose: () => setFrameEditId(null),
    onLinkHover: (inside) => {
      linkLeftRef.current = inside
    },
    onPointerDown, onPointerMove, onPointerUp,
    lasso, inkBox: sel.box, onDeleteInk: deleteInkSel,
    onFormulaInk: () => openInkPanel('formula'),
    onBeautifyInk: () => openInkPanel('text'),
    /* 卡片层作为 children 传进画布组件 —— 它必须和两层 canvas 待在**同一个**
       .bd-stage 里面（同一个世界原点）。理由见 BoardCanvas 里那段说明。
       注意这里**不要再套一层带 translate / scale 的容器**：世界变换不靠 CSS，
       卡片自己算 left/top（同一个公式、同一个原点）。BoardCanvas 里那层 .bd-world
       只负责叠放（z-index 要高过收事件层，卡片才点得到），给它加变换就多做一次平移。 */
    children: (
      <>
        {board.cards.map((c) => (
          <Card
            key={c.id}
            card={c}
            selected={c.id === selectedId}
            dimmed={focusIds ? !focusIds.has(c.id) : false}
            editing={c.id === editingId}
            view={board.view}
            /* ★ 武装着「∈ 条件」时，点一张卡 = **指着它**（"这张卡就是那条线的条件"），
               而不是选中它 —— 卡片自己收指针事件，所以这条只能在这儿拦
               （笔迹那边是 onPointerDown 拦的，见上面 ⓪）。 */
            onSelect={() => {
              if (condArm) pickCond(condArm, { cardId: c.id })
              else {
                setSelectedId(c.id)
                /* 选中一张卡 = 板框不再是"当前这个"（两套选中不并存，免得 Delete 说不清删谁）。 */
                setSelectedFrameId(null)
              }
            }}
            onStartDrag={() => {
              const c0 = boardRef.current.cards.find((x) => x.id === c.id)
              /* 一次拖动 = 一步撤销：起点交给账本（"点了一下没拖"由 `end()` 判）。 */
              dragStartRef.current = c0 ? { id: c.id, x: c0.x, y: c0.y, g: ledger.begin() } : null
            }}
            onStartEdit={() => {
              setSelectedId(c.id)
              setEditingId(c.id)
            }}
            onCommit={(patch) => commit((cur) => ({ ...cur, cards: cur.cards.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) }))}
            onCloseEdit={() => setEditingId(null)}
            onDrag={(dxScreen, dyScreen) => {
              /* 中途每一帧只改板、不记账 —— 这一次拖动的那一步由 onDragEnd 的 `end()` 记。 */
              const g = dragStartRef.current && dragStartRef.current.g
              if (!g) return
              g.during((cur) => {
                // 屏幕位移 → 世界位移：除以**当前**缩放（不是按下那一刻的）——走 view.js 那一处
                const k = cur.view.s
                const dx = screenLenToWorld(dxScreen, k)
                const dy = screenLenToWorld(dyScreen, k)
                return { ...cur, cards: cur.cards.map((x) => (x.id === c.id ? { ...x, x: x.x + dx, y: x.y + dy } : x)) }
              })
            }}
            onDragEnd={() => {
              const st = dragStartRef.current
              dragStartRef.current = null
              if (!st) return
              /* "点了一下没拖"由账本判（收尾那版板和起点是不是同一个样，数字按 0.5
                 世界像素的余量比）—— 从前这里是 `|dx| < 0.5 && |dy| < 0.5`。 */
              st.g.end()
            }}
            /* ── 放大缩小（拖右下角那个柄）──
               ★ 手势的移动/松手**挂在 window 上**，不靠 setPointerCapture、也不靠
                 "指针还在手柄上"。两个理由，都是踩出来的：
                 ① 手柄只有 18px，鼠标拖两下就出去了，靠元素自己的 onPointerMove
                    会当场收不到事件（自检里实测：拖了 120px，倍率纹丝不动）；
                 ② 卡片本身会 stopPropagation，窗口级 + 捕获阶段最省事。
               这个手势和"拖动"是同一种东西：中途只改板不进撤销栈，
               松手时由账本补成**一步**撤销（见上面的 startResize）。 */
            onStartResize={(rectW, startX) => startResize(c.id, rectW, startX)}
            onToggleLock={() => toggleLock(c.id)}
            onDelete={() => {
              commit((cur) => ({ ...cur, cards: cur.cards.filter((x) => x.id !== c.id) }))
              setSelectedId(null)
            }}
          />
        ))}
      </>
    ),
  }

  const panel = (
    <RelationPanel      board={board}
      relations={relations}
      inkPairs={inkPairs}
      links={links}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onHoverEdge={setHoverEdge}
      /* 「这个条件不算」那颗 ✕ / 回头路 ↺ —— 面板是另一个组件，得把动作递进去
         （见 RelationPanel 的说明：它是纯展示，改板一律回到 Board 这边做）。 */
      onNoCond={noCond}
      onCondBack={condBack}
      /* 「∈ 条件」的入口放在**这一行**（不是框选浮层）：板上几条线走同一条走廊时
         "只框住其中一条"很不好框，而"缺条件"这件事本来就显示在那一行上 ——
         入口就在它旁边。`condArmId` 是正武装着的那条，用来把按钮点亮。 */
      onArmCond={armCond}
      condArmId={condArm ? linkKey(condArm) : null}
      /* 板框那一行（见 ADR-0001）：点一下 = 选中它 + 视野居到它身上。 */
      onFrameSelect={setSelectedFrameId}
      onFocusFrame={(id) => {
        const f = (boardRef.current.frames || []).find((x) => x.id === id)
        const el = wrapRef.current
        if (!f || !el) return
        const box = frameBounds(boardRef.current, f)
        if (!box) return
        setView(centerOn(boardRef.current.view, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, el.clientWidth, el.clientHeight))
      }}
      onFocus={(id) => {
        const el = wrapRef.current
        if (!el) return
        const c = cardById.get(id)
        /* 端点是墨迹块（不是卡片）时没有卡可居中 —— 退回到"这条连接的中点"，
           不然点了面板那一行什么都不动，看起来像坏了。 */
        const center = c
          ? { x: c.x + c.w / 2, y: c.y + c.h / 2 }
          : (links.find((l) => l.a === id || l.b === id) || {}).mid
        if (!center) return
        /* 缩放不变，只把这个世界点摆到容器正中 —— 就是 screenToWorld 的逆运算，
           收在 view.js 的 `centerOn` 里（原来这里是手写的一行）。 */
        setView(centerOn(boardRef.current.view, center, el.clientWidth, el.clientHeight))
      }}
    />
  )

  const toolbar = (
    <Toolbar
      tool={tool} setTool={setTool}
      color={color} setColor={setColor}
      width={width} setWidth={setWidth}
      paper={paper} onPaper={pickPaper}
      onWriteFormula={() => setPadOpen(true)}
      onBeautify={() => openInkPanel('text')}
      onUndo={undo} onRedo={redo}
      canUndo={hist.undo > 0} canRedo={hist.redo > 0}
      onFit={() => {
        const el = wrapRef.current
        // 装回屏幕 = 程序适配，不是你定的视野 → pin=false，下次打开还会重新适配
        if (el) setView(fitView(boardRef.current, el.clientWidth, el.clientHeight, 70), false)
      }}
      onZoom={(f) => {
        const el = wrapRef.current
        if (el) setView((v) => zoomAt(v, f, el.clientWidth / 2, el.clientHeight / 2))
      }}
      scale={scale}
      onScale={onScale}
      onScaleReset={onScaleReset}
      dirty={dirty}
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  )

  /* 用**笔**的时候，卡片整个让开指针事件（对应 CSS 里的 .bd.penink .bd-card）。
     笔的语义是"在纸上写"：笔尖落在卡片上应该写得出字，而不是把卡片拖走
     （用户 2026-09-16 报的「无法在卡片上写字」就是这一条）。
     鼠标不适用 —— 鼠标没法写字，而拖卡片 / 缩放 / 双击改内容对鼠标必须一直顺手。
     「⬚ 框选」是例外：切到它，卡片对所有设备都可交互，用笔的人靠它管理卡片。
     ★ 「→ 箭头」也是例外，而且**不分设备**：那一下要"从卡片上起手划出去"
       （起点常常落在卡片里），鼠标用户也得能划 —— 不然箭头工具对鼠标等于坏的。
       （画完自动回笔，所以卡片让路只是这一下的事。） */
  const penInk = tool === 'arrow' || (penMode && tool !== 'select')

  /* 纸面的类挂在**最外层 .bd 上**（不是 .bd-stagewrap）：
     写字板那块小板也要跟着换纸，而它是 .bd 的兄弟分支，不是 stagewrap 的孩子。
     挂在根上，一条 `.paper-grid .bd-stagewrap, .paper-grid .wp-padwrap` 就都管得住。 */
  return (
    <div className={'bd variant-' + variant + ' paper-' + paper + (fullscreen ? ' bd-fs' : '') + (penInk ? ' penink' : '') + (condArm ? ' condarm' : '')}>
      {/* ★ 指针种类在**捕获阶段**就记下来（挂在最外层，卡片上的事件也会先经过这里）。
          为什么不能只在 .bd-hit 上记：笔悬停到**卡片**上时，事件被卡片接走了，
          .bd-hit 上的监听收不到 —— 于是"上一次是笔"要等按下才知道，
          而那一下就变成拖卡片了。挂在最外层，悬停即生效。 */}
      <div
        className={'bd-stagewrap' + (penMode ? ' nocursor' : '')}
        ref={wrapRef}
        /* ★ 底纹的格距和原点由**这一层的视图**算出来（见 paperGeometry）。
           放在这里（而不是 CSS 里写死）是为了让格线和墨迹共用同一个变换：
           平移、缩放、装回屏幕时，两者一起动，纸上的字才像"写在纸上"。
           写在 .bd-stagewrap 上而不是 .bd 上：这几个变量只有底纹用得到，
           写字板那块小板是另一个坐标系（它不跟着视图走）。 */
        style={paperGeometry(board.view, paper)}
        onPointerMoveCapture={trackPointerKind}
        onPointerDownCapture={trackPointerKind}
      >
        {/* 画布、连线、卡片都在 BoardCanvas 里面 —— 它们必须是同一个世界原点。
            卡片通过 children 传进去，就是为了让"世界原点"这件事只有一个地方说话。 */}
        <BoardCanvas {...stageProps} />

        {board.cards.length === 0 && board.strokes.length === 0 && <Hint />}
      </div>

      {variant === 'B' ? (
        <>
          <div className="bd-floatbar">{toolbar}</div>
          {panelOpen && <div className="bd-drawer">{panel}</div>}
          <button className="bd-drawer-toggle" onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? '收起关系 ›' : '‹ 关系'}
          </button>
        </>
      ) : variant === 'C' ? (
        <div className="bd-csplit">
          <div className="bd-clist">{panel}</div>
          <div className="bd-cbar">{toolbar}</div>
        </div>
      ) : (
        <>
          <div className="bd-cbar">{toolbar}</div>
          <div className="bd-cpanel">{panel}</div>
        </>
      )}

      <VariantSwitcher variant={variant} setVariant={setVariant} />

      {padOpen && (
        <WritingPad
          onInsert={insertRecognized}
          onClose={() => setPadOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          flash={flash}
        />
      )}
      {settingsOpen && <OcrSettings onClose={() => setSettingsOpen(false)} flash={flash} onSaved={() => {}} />}
      {inkMode && (
        <InkToCard
          mode={inkMode}
          strokes={sel.strokes}
          onInsert={insertFromInk}
          onClose={() => setInkMode(null)}
          onOpenSettings={() => setSettingsOpen(true)}
          flash={flash}
        />
      )}
    </div>
  )
}

// ────────────────────────────── 卡片 ──────────────────────────────

function Card({ card, selected, dimmed, editing, view, onSelect, onStartEdit, onStartDrag, onCommit, onCloseEdit, onDrag, onDragEnd, onDelete, onStartResize, onToggleLock }) {
  const dragRef = useRef(null)
  const taRef = useRef(null)
  const [draft, setDraft] = useState('')
  const [draftFont, setDraftFont] = useState(DEFAULT_CARD_FONT)
  const isFormula = card.kind === 'formula'
  /* 固定（钉住）：这张卡不再收指针事件 —— 见下面 .bd-card.locked 和 pinCard 的说明。 */
  const locked = card.locked === true
  /* 卡片的"放大缩小"倍率（见 lib/board.js 的 nextCardScale）。
     一个数管全部：字号、内边距、圆角、宽高都乘它 ——
     只改宽高不把字号跟着变的话，卡片越拉越大、字还是那么小，看着像坏了。 */
  const k = Number(card.scale) > 0 ? Number(card.scale) : 1
  /* 这张卡在屏幕上唯一的倍率（世界 × s × k）—— 尺寸、字号、内边距、圆角全用它，
     而且它由 view.js 的 combinedScale 算（别在这里手写 `view.s * k`：那条口径
     以前手抄在三处，ADR-0002 那根黑线就是从这种手抄里长出来的）。 */
  const f = combinedScale(view.s, k)

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
      ? <div className="bd-note" style={{ fontFamily: fontCss(card.font) }}>{card.text}</div>
      : <div className="bd-card-empty">双击写字</div>
  }

  /* 卡片左上角的屏幕位置：世界 → 屏幕，走 `view.js` 那一道缝（只有一份实现）。
     ⚠ `worldToScreen` 返回 `{x, y}`，**不是** `{left, top}` —— 直接展开进 style
       卡片会没有 left/top、静默退回 CSS 定位（整版错位，自检 [6] 当场抓到过）。 */
  const at = worldToScreen({ x: card.x, y: card.y }, view)

  return (
    <div
      className={'bd-card' + (isFormula ? ' is-formula' : ' is-note') + (locked ? ' locked' : '') + (selected ? ' on' : '') + (dimmed ? ' dim' : '') + (editing ? ' editing' : '')}
      /* 这两条 dataset 是给自检看的（浏览器里看不到卡片数据，
         而"插进去的是不是文字卡、字体对不对"只有真 DOM 能证明）。
         和画布那三个 dataset.strokes/pts/flat 是同一个道理。
         data-card-locked 也一样：锁定是个**行为**，自检要能一眼读到它。 */
      data-card-kind={card.kind}
      data-card-font={card.kind === 'note' ? card.font || DEFAULT_CARD_FONT : undefined}
      data-card-locked={locked ? '1' : undefined}
      /* data-card-id 是给"插完量一下真实高度"用的（fitCardHeight 靠它找内容元素）。
         id 只在文件内唯一，DOM 里也够用。 */
      data-card-id={card.id}
      /* ★ 位置用 JS 算，不用 CSS transform。公式就是世界坐标那一个映射：
             屏幕 = 世界 * s + t
         四个数（left/top/width/字号缩放）一起算，缩放才能"整体一致地"变小 ——
         只缩 left/top 不缩字号，卡片会一边跑到正确位置、一边保持原来的大小。 */
      style={{
        /* 位置 = 世界 → 屏幕（点）；尺寸/字号/内边距 = **带倍率的世界长度**。
           两条映射都住在 view.js 的同一处：`f` 是这张卡唯一的倍率（世界 × s × k）。
           从前这里手写 6 遍 `view.s * k`，量尺寸那一趟和缩放柄各再抄一遍 ——
           而"那圈是屏幕像素、宽是世界像素"这件事就藏在这种手抄里（ADR-0002 的根子）。 */
        left: at.x,
        top: at.y,
        width: worldLenToScreen(card.w, f),
        minHeight: worldLenToScreen(card.h, f),
        /* 字号和内边距也按同一个倍率走，卡片才是"整体一致地"变大变小。
           只缩 left/top/width 而不缩字号，卡片会跑到正确的位置却保持原来的大小。
           CSS 里只有一个 --bd-card-scale，所以在这里乘好再写出去。 */
        '--bd-card-scale': f,
        /* 内边距从 10/12 收到 4/8（用户 2026-09-16：「边缘留白太多了」）。
           为什么不干脆给 0：字贴着边框线看着像画坏了，而且卡片一选中、
           边框一加粗就会压到字上。4px 是"看着贴、但不顶边"的那个数。 */
        padding: `${worldLenToScreen(4, f)}px ${worldLenToScreen(8, f)}px`,
        borderRadius: Math.max(3, worldLenToScreen(10, f)),
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
        onSelect()
        onStartDrag?.()
        dragRef.current = { x: e.clientX, y: e.clientY, moved: false }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (!d || editing || locked) return
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
        if (dragRef.current) onDragEnd()
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

      {/* 固定：**锁定之后整张卡只剩这一个能点**（它自己带 pointer-events: auto），
          所以"钉死了拿不下来"这件事不会发生。
          没锁的时候只在你选中它时出现 —— 和 × / 缩放柄同一个规矩：
          不选中时卡片上一个手柄都不该有（这条也是踩过的，见 README 第 14 条）。
          ⚠ 位置在**左下角**（.bd-card-pin 的 CSS）：左上角是"抓住卡片拖走"最顺手的
            那一点，放个按钮在那儿就等于把拖动变成点按钮 —— 这条真踩过，
            `check-ocr-browser` 的拖动断言当场变成"拖不动（0, 0）"。 */}
      {(locked || (selected && !editing)) && (
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
              const rectW = host ? host.getBoundingClientRect().width : worldLenToScreen(card.w, f)
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

// ────────────────────────────── 工具条 ──────────────────────────────

function Toolbar({ tool, setTool, color, setColor, width, setWidth, paper, onPaper, onWriteFormula, onBeautify, onUndo, onRedo, canUndo, canRedo, onFit, onZoom, scale, onScale, onScaleReset, dirty, fullscreen, onToggleFullscreen }) {
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
          onClick={() => {
            setTool('arrow')
            flash('箭头工具：从一样东西划到另一样东西（画完自动回到笔）', 'ok')
          }}
          title="箭头（A）：从一样东西划到另一样东西，松手就连上。一次性 —— 画完自动回到笔；纸上不留墨，那条线是应用画的"
        >
          → 箭头
        </button>
        {/* 框选（S）：拖一个矩形圈住笔迹。原来只有"笔杆侧键"这一条路，
            所以用鼠标、或者笔上没有侧键的人根本选不中笔迹 —— 认公式/美化也就无从谈起。 */}
        <button className={'bd-t' + (tool === 'select' ? ' on' : '')} data-tool="select" onClick={() => setTool('select')} title="框选（S）：拖一个框圈住要认的手写 —— 圈住之后框上方浮出「∑ 公式」「✨ 美化」「✕ 删除」。★ 用笔时卡片会给笔让路，想拖卡片 / 缩放 / 双击改字就切到这个工具">⬚ 框选</button>
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
      </div>

      <div className="bd-group">
        <button className="bd-t icon" onClick={onUndo} disabled={!canUndo} title="撤销 Ctrl+Z">↶</button>
        <button className="bd-t icon" onClick={onRedo} disabled={!canRedo} title="重做 Ctrl+Shift+Z">↷</button>
      </div>

      {/* 字号：**成对**的加减 + 当前百分比。
          为什么白板里也要有：白板模式下顶栏不渲染（白板用自己的工具条），
          原来只剩左栏那一个按钮 —— 而它写死了"只放大"。
          于是白板里没有"调小"的入口，用户看到的正是这个。
          注意别和右边那组搞混：那组是**画布缩放**（纸本身放大缩小），
          这组是**界面字号**（按钮和面板上的字大小）。 */}
      <div className="bd-group">
        <button className="bd-t icon" onClick={() => onScale(-0.05)} disabled={scale <= 0.9} title="界面字号小一点">A−</button>
        <button className="bd-t zoomish" onClick={onScaleReset} title={'当前 ' + Math.round((scale || 1) * 100) + '%，点一下回到 125%'}>
          {Math.round((scale || 1) * 100)}%
        </button>
        <button className="bd-t icon" onClick={() => onScale(0.05)} disabled={scale >= 2} title="界面字号大一点">A+</button>
      </div>

      {/* 纸面：四种纸直接**画在按钮上**（所点即所得，不用看名字猜）。
          为什么不做成下拉菜单：工具条上同类的东西（颜色、粗细）都是当场摆出来的，
          纸面是同一类选择，多一层展开只多一次点击。
          ⚠ 别和右边那组混：那个 `纸` 是**画布缩放**（把纸放大缩小），
            这里是**纸长什么样** —— 所以这里的标签写"背景"，两个字不一样。 */}
      <div className="bd-group">
        <span className="bd-zoomlabel">背景</span>
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

      <div className="bd-group right">
        <span className={'bd-save' + (dirty ? ' on' : '')}>{dirty ? '正在存…' : '已存'}</span>
        <span className="bd-zoomlabel" title="这两个是画布缩放：把整张纸放大缩小">纸</span>
        <button className="bd-t icon" onClick={() => onZoom(1 / 1.2)} title="画布缩小（纸变小）">−</button>
        <button className="bd-t icon" onClick={onFit} title="把所有内容装回屏幕（Ctrl+0）">⤢</button>
        <button className="bd-t icon" onClick={() => onZoom(1.2)} title="画布放大（纸变大）">＋</button>
        {/* 全屏：把两侧栏和顶栏全收掉，连浏览器那圈也一起收，只留一张纸（Esc 退出）。
            放在这组最右边是有意的 —— 它和"纸缩放"一样是"怎么看这块画布"的操作。 */}
        <button
          className={'bd-t' + (fullscreen ? ' on' : '')}
          onClick={onToggleFullscreen}
          title={fullscreen ? '退出全屏（Esc）' : '画布全屏：只留一张纸，四周什么都收起来'}
        >
          ⛶ {fullscreen ? '退出' : '全屏'}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────── 关系面板 ──────────────────────────────

function RelationPanel({ board, relations, links, inkPairs, selectedId, onSelect, onHoverEdge, onFocus, onNoCond, onCondBack, onArmCond, condArmId, onFrameSelect, onFocusFrame }) {
  const byId = new Map(board.cards.map((c) => [c.id, c]))
  const label = (c) => {
    if (!c) return '(没了)'
    /* 公式卡显示**渲染后的式子**（displayTex），不是手打的源码。
       理由：卡片上是好看的式子，列表里却是 "oint(B) dl = mu0 I_in"，
       同一张卡两个样子，你得在脑子里做一次映射才对得上。 */
    if (c.kind === 'formula') {
      const t = displayTex(c)
      return t ? t.slice(0, 30) : '(空公式)'
    }
    return (c.text || '(空便签)').slice(0, 24).replace(/\s+/g, ' ')
  }
  const roots = board.cards.filter((c) => !relations.parentOf.has(c.id))
  /* 两族连接（见 ADR-0001）：**你连的**（宣告的，`declared`）和**你画过的**（画出来的那一条线）。
     分开列而不是混在一起：前者删它 = 删一条记录，后者删它 = 擦掉那一笔 ——
     两句话不是一回事，混着说用户会以为"删了线关系还在"。 */
  const declared = links.filter((l) => l.declared)
  const drawn = links.filter((l) => !l.declared)
  /* 连接的两端可能是卡片、**墨迹块**（没成卡的字迹、手画的图）或者**板框**。
     后两种的名字都挂在链接对象上（aLabel/bLabel），不能去卡片表里找 —— 找不到就是"(没了)"。 */
  const endName = (l, k) => (l[k + 'Kind'] === 'card' ? label(byId.get(l[k])) : l[k + 'Label'] || (l[k + 'Kind'] === 'frame' ? '板框' : '墨迹块'))
  /* 链里的人名：端点可能是卡片，也可能是墨迹块 / 板框（名字在链接对象上）。 */
  const nameOf = (id, link) => {
    if (link && id === link.a && link.aKind !== 'card') return link.aLabel || (link.aKind === 'frame' ? '板框' : '墨迹块')
    if (link && id === link.b && link.bKind !== 'card') return link.bLabel || (link.bKind === 'frame' ? '板框' : '墨迹块')
    return label(byId.get(id))
  }
  const condName = (cond) => (cond.kind === 'ink' ? cond.label || '墨迹块' : label(byId.get(cond.id)))
  /* 条件那一族的几颗按钮（✕ / ↺ / ∈）—— **你画的和你的连的共用这一份**。
     从前只有"你画过的"那一行有它们：三个写入口只看 `link.strokeId`，而宣告的连接
     那个字段恒为 null —— 于是"∈ 条件"在那一节里根本不存在，你连的那条**永远指不了条件**
     （架构 review 候选 4；现在写入口按 `link.declared` 自己决定住哪，见 selection.js）。
     ✕ 是"位置读错了"那个口子，只对**画出来**的连接有意义（宣告的那种条件只能是你亲口说的），
     所以它在那一节里自然不会出现（`condManual` 只在你说过话时为真）。 */
  const condChips = (l) => (
    <>
      {l.cond && (
        <span
          className="bd-cond"
          title={l.condSpec ? '你亲手指的那个条件（点右边的 ↺ 回到按位置读）' : '写在这条线中点旁边的字（或那张卡）—— 位置决定它是不是条件'}
        >
          条件 {condName(l.cond)}
          {l.condSpec ? '（你指的）' : ''}
        </span>
      )}
      {l.condManual && !l.cond && (
        <span className="bd-cond-note" title="你说过：这个条件不算（位置读出来的那个作废）；点右边的 ↺ 改回来">
          条件不算
        </span>
      )}
      {(l.cond || l.condManual) && (
        <span
          className={'bd-cond-no' + (l.condManual ? ' back' : '')}
          role="button"
          data-cond-btn={l.condManual ? 'back' : 'no'}
          title={l.condManual ? '改回来：还是按位置读' : '这个条件不是给这条线的（位置读错了）'}
          onClick={(e) => {
            e.stopPropagation()
            if (l.condManual) onCondBack && onCondBack(l)
            else onNoCond && onNoCond(l)
          }}
        >
          {l.condManual ? '↺' : '✕'}
        </span>
      )}
      {/* 「∈ 条件」：这一行现在**没有条件显示**时给的口子（读不到、或者你刚否掉）——
          按一下它，再点一下要当条件的那张卡/那撮字。两种连接都有这条口子。 */}
      {!l.cond && (
        <span
          className={'bd-cond-no arm' + (condArmId === linkKey(l) ? ' on' : '')}
          role="button"
          data-arm-cond={linkKey(l)}
          title="指定条件：按一下，再点要当条件的那张卡或那撮字（Esc 取消）"
          onClick={(e) => {
            e.stopPropagation()
            onArmCond && onArmCond(l)
          }}
        >
          ∈
        </span>
      )}
    </>
  )
  /* 「推导链」（见 lib/board.js 的 deriveChains）：由推导连接串起来的 A→B→C，
     并标出**哪一步缺条件** —— 条件就是写在线中点旁边那几个字，不用你声明。 */
  const chains = deriveChains(links)

  return (
    <div className="bd-rel">
      <div className="bd-rel-head">
        <b>关系</b>
        <span className="dim small">按位置读出来的</span>
      </div>

      {board.cards.length === 0 && <div className="dim pad">这张板上还没有卡片。</div>}

      <div className="bd-tree">
        {roots.map((r) => (
          <TreeNode key={r.id} node={r} depth={0} relations={relations} byId={byId} label={label} selectedId={selectedId} onSelect={onSelect} onFocus={onFocus} />
        ))}
      </div>

      {/* ★ 板框：你亲手留下的那些整体（见 ADR-0001）。
          面板里也给一节的理由：板框常常把**离得很远**的东西收在一起，
          屏幕上不一定同时看得见，而"这一节跟哪几节连着"正是要对着看的东西。
          点一行 = 选中它（屏幕上那个框亮起来）+ 视野居中到它身上。 */}
      {(board.frames || []).length > 0 && (
        <div className="bd-frames-list">
          <div className="bd-rel-sub">板框（{board.frames.length} 个）</div>
          {board.frames.map((f) => {
            const mine = links.filter((l) => l.a === f.id || l.b === f.id)
            const nCard = (f.cards || []).length
            return (
              <button
                key={f.id}
                className="bd-frame-row"
                data-frame-row={f.id}
                onClick={() => {
                  onFrameSelect && onFrameSelect(f.id)
                  onFocusFrame && onFocusFrame(f.id)
                }}
                title="点一下：选中这个框（能整体拖、能起名）；在板上拖框上的名字也行"
              >
                <span className="bd-frame-name">▣ {f.title || '未命名'}</span>
                <span className="dim small">
                  {(f.ids || []).length} 笔{nCard ? ` · ${nCard} 卡` : ''}
                </span>
                {mine.length > 0 && <span className="bd-frame-links">{mine.length} 条连接</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* ★ 你亲手画出来的那些连接 —— 和上面的"按位置读出来的"分开列。
          为什么要单独一节：连线的两张卡常常离得很远（位置推断根本不会把它俩凑一对），
          而"我画过线"恰恰是最确定的一句话，它不该因为离得远就从面板上消失。 */}
      {links.length > 0 && (
        <div className="bd-links-list">
          {/* 你**连**的（宣告的）：那一笔没有留在板上，屏幕上那条箭头是应用画的。 */}
          {declared.length > 0 && (
            <>
              <div className="bd-rel-sub">你连的（{declared.length} 条）</div>
              {declared.map((l) => (
                <button
                  key={l.id}
                  className={'bd-link-row' + (l.dir ? ' dir' : '')}
                  data-link-declared={l.id}
                  onClick={() => onFocus(l.a)}
                  title={'你连的：' + l.name + '（点线上那颗词能改词 / 删掉这条连接 / ∈ 指一个条件）'}
                >
                  <span className="bd-link-kind" style={{ color: l.color, borderColor: l.color }}>
                    {l.name}
                    {l.dir ? (l.kind === 'cause' ? ' →' : ' ⇒') : ''}
                  </span>
                  <span className="bd-er">{endName(l, 'a')}</span>
                  <span className="dim">{l.dir ? '→' : '—'}</span>
                  <span className="bd-er">{endName(l, 'b')}</span>
                  {/* 你连的这条也能说条件 —— 只是它没有"位置读法"，所以只有 ∈ / ↺ 两种。 */}
                  {condChips(l)}
                </button>
              ))}
            </>
          )}
          {drawn.length > 0 && (
            <>
              <div className="bd-rel-sub">你画过的（{drawn.length} 条）</div>
              {drawn.map((l) => (
                <button
                  key={l.strokeId}
                  className={'bd-link-row' + (l.dir ? ' dir' : '')}
                  onClick={() => onFocus(l.a)}
                  title={l.manual ? '你点过词的：' + l.name : '你画的一条线，默认按「相关」读：' + l.name}
                >
                  <span className="bd-link-kind" style={{ color: l.color, borderColor: l.color }}>
                    {l.name}
                    {l.dir ? (l.kind === 'cause' ? ' →' : ' ⇒') : ''}
                  </span>
                  <span className="bd-er">{endName(l, 'a')}</span>
                  <span className="dim">{l.dir ? '→' : '—'}</span>
                  <span className="bd-er">{endName(l, 'b')}</span>
              {/* 「条件是位置送的」：线中点旁边那几个字 / 那张卡（见 lib/board.js 的 linkCondition）。
                  ★ 位置两头都不灵的时候有说法：
                     · 读错了 → 那颗 ✕ 是「这个条件不算」（`cond:'none'`）；
                     · 读不到（条件写在别处）→ 框住那条线，浮层上按「∈ 条件」再点一下目标
                       （`cond:'card:<id>'` / `'ink:<笔 id>'`）—— 那一行会写「（你指的）」。
                     · 旁边的 ↺ 是这两种说法的**回头路**（回到按位置读）。 */}
              {condChips(l)}
            </button>
          ))}
            </>
          )}
          <div className="dim small pad">
            你**连**的那些（上面一节）都写在文件里（`links`）；你**画**的那条线没点过词时
            按「相关」读、**不写文件** —— 点过词的那几条才记住。
          </div>
        </div>
      )}

      {/* ★ 推导链：把「推导」那几条串起来读成 A→B→C，并标出**哪一步缺条件**。
          条件不需要你声明 —— 写在那条线**中点旁边**的几个字就算
          （见 lib/board.js 的 linkCondition），所以"补条件"这件事就是
          "在线旁边把那句话写上"，写完这一节自己就更新了。 */}
      {chains.length > 0 && (
        <div className="bd-chain-list">
          <div className="bd-rel-sub">推导链（{chains.length} 条）</div>
          {chains.map((c, ci) => (
            <div key={'chain' + ci} className="bd-chain">
              <div className="bd-chain-node">{nameOf(c.start, c.steps[0].link)}</div>
              {c.steps.map((s, k) => (
                <div key={'st' + k} className="bd-chain-step">
                  <div className={'bd-chain-cond' + (s.missing ? ' miss' : '')}>
                    {s.missing ? '↓ 缺条件（在线中点旁边写几个字就行）' : '↓ 条件：' + condName(s.cond)}
                  </div>
                  <div className="bd-chain-node">{nameOf(s.to, s.link)}</div>
                </div>
              ))}
            </div>
          ))}
          <div className="dim small pad">
            「条件」= 写在那条连接线**中点旁边**的字（或那张卡）—— 位置说了算，不用你标。
          </div>
        </div>
      )}

      {relations.orphans.length > 0 && (
        <div className="bd-islands">
          <div className="bd-islands-head">
            有 <b>{relations.orphans.length}</b> 张还没跟谁连上
          </div>
          <div className="dim small">不一定错 —— 可能正是你还没想清楚"它属于哪一节"的地方。</div>
          {relations.orphans.map((id) => (
            <button key={id} className="bd-orphan" onClick={() => onFocus(id)}>
              {label(byId.get(id))}
            </button>
          ))}
        </div>
      )}

      <div className="bd-edges-list">
        <div className="bd-rel-sub">谁靠着谁（{relations.edges.length} 条）</div>
        {relations.edges.slice(0, 40).map((e) => {
          const inked = inkPairs.has(e.a + '|' + e.b) || inkPairs.has(e.b + '|' + e.a)
          return (
            <div
              key={e.a + e.b}
              className={'bd-edge-row' + (inked ? ' inked' : '')}
              onMouseEnter={() => onHoverEdge([e.a, e.b])}
              onMouseLeave={() => onHoverEdge(null)}
            >
              <span className={'bd-kind k-' + e.kind}>{e.kind === 'contain' ? '包含' : e.kind === 'overlap' ? '重叠' : '挨着'}</span>
              <span className="bd-er">{label(byId.get(e.a))}</span>
              <span className="dim">→</span>
              <span className="bd-er">{label(byId.get(e.b))}</span>
            </div>
          )
        })}
        {relations.edges.length === 0 && <div className="dim small pad">还没有靠在一起的卡片。</div>}
      </div>

      <div className="dim small pad">
        「包含 / 重叠 / 挨着」都是**按位置推断**的，不是你说过的。
        想让它确定下来，就用笔在两张卡之间画一条线。
      </div>
    </div>
  )
}

function TreeNode({ node, depth, relations, byId, label, selectedId, onSelect, onFocus }) {
  if (!node) return null
  const kids = relations.children.get(node.id) || []
  return (
    <div className="bd-node" style={{ marginLeft: depth * 12 }}>
      <button
        className={'bd-node-row' + (node.id === selectedId ? ' on' : '')}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => onFocus(node.id)}
        title="点一下选中 · 双击把它挪到屏幕中间"
      >
        <span className={'bd-dot ' + node.kind} />
        {label(node)}
      </button>
      {kids.map((k) => (
        <TreeNode key={k} node={byId.get(k)} depth={depth + 1} relations={relations} byId={byId} label={label} selectedId={selectedId} onSelect={onSelect} onFocus={onFocus} />
      ))}
    </div>
  )
}

// ────────────────────────────── 空板提示 ──────────────────────────────

function Hint() {
  return (
    <div className="bd-hint">
      <div className="bd-hint-t">拿笔直接画</div>
      <div className="bd-hint-s">
        写公式不用管格式：点工具条上的「✍ 手写公式」，在那块小板上把式子写一遍，
        它会认成排好的样子，再放到板上。
      </div>
      <div className="bd-hint-s dim">
        觉得自己字丑：点「⬚ 框选」把你写的字圈起来，再点「✨ 美化手写」——
        它会认成文字，用好看的字体排一张卡盖在原处（原笔迹不删，拖开就回来）。
      </div>
      <div className="bd-hint-s dim">
        笔尖写字，翻过来就是橡皮。触屏：两根手指拖 = 平移，捏 = 缩放。
      </div>
    </div>
  )
}

// ────────────────────────────── 变体切换 ──────────────────────────────

/* 三种摆法，`?variant=A/B/C` 或左右方向键切。
   A：工具条在顶、关系面板在右（默认）
   B：全屏画布，工具条和面板都做成浮层
   C：关系面板占左边一整列（表格式，适合复习时顺着念）
   这不是最终形态，是给你翻着挑的 —— 挑完我把落选的两套删掉。 */
function VariantSwitcher({ variant, setVariant }) {
  const names = { A: '工具条在顶 · 关系在右', B: '全屏画布 · 都做成浮层', C: '关系在左一整列' }
  // 默认收起。这东西是"翻着挑摆法"用的，摆法定了之后平时根本用不到，
  // 之前一直摊在屏幕底下、还压着工具条 —— 收成一个角标，要用再点开。
  const [open, setOpen] = useState(false)
  const prev = () => setVariantAndUrl(VARIANTS[(VARIANTS.indexOf(variant) + 2) % 3], setVariant)
  const next = () => setVariantAndUrl(VARIANTS[(VARIANTS.indexOf(variant) + 1) % 3], setVariant)

  if (!open) {
    return (
      <button
        className="bd-proto-mini"
        onClick={() => setOpen(true)}
        title={`布局摆法：${variant} — ${names[variant]}（点一下展开）`}
      >
        {variant}
      </button>
    )
  }

  return (
    <div className="bd-proto">
      <button onClick={prev} title="上一个摆法（←）">‹</button>
      <span className="bd-proto-t">
        <b>{variant}</b> — {names[variant]}
      </span>
      <button onClick={next} title="下一个摆法（→）">›</button>
      <button className="bd-proto-x" onClick={() => setOpen(false)} title="收起">⌄</button>
    </div>
  )
}

// ────────────────────────────── 小工具 ──────────────────────────────

function readVariant() {
  if (typeof window === 'undefined') return 'A'
  const m = /[?&]variant=([ABC])/i.exec(window.location.search)
  return m ? m[1].toUpperCase() : 'A'
}

/* 打开时用哪种纸：**地址栏 > 上次选的 > 默认纯白**。
   地址栏放在最前面是有用的：`?paper=grid` 能一次把纸定死，
   自检（scripts/check-paper.js）和"把这个链接发给同学"都靠它，
   而且它**不会**反过来把偏好写模糊 —— 只有点工具条上的按钮才写 localStorage。

   认不出的值一律退回默认 —— 手改地址栏、老版本存下的值是常事，
   读不出来就崩，或者留一个对不上的 id（CSS 类名也就对不上、纸变成"没有底纹"
   却显示成选中了某一档），比直接退回默认难查得多。 */
function readPaper() {
  if (typeof window === 'undefined') return DEFAULT_PAPER
  const m = /[?&]paper=([a-z]+)/i.exec(window.location.search)
  const fromUrl = m ? m[1].toLowerCase() : ''
  if (PAPERS.some((p) => p.id === fromUrl)) return fromUrl
  try {
    const saved = localStorage.getItem(PAPER_KEY)
    if (PAPERS.some((p) => p.id === saved)) return saved
  } catch {
    /* 隐私模式下读不了，用默认 */
  }
  return DEFAULT_PAPER
}

function setVariantAndUrl(v, setVariant) {
  setVariant(v)
  try {
    const u = new URL(window.location.href)
    u.searchParams.set('variant', v)
    window.history.replaceState(null, '', u.toString())
  } catch {
    /* 地址栏改不了就算了，变体本身已经切了 */
  }
}

function load(text, file) {
  const title = String(file || '').replace(/^board-/i, '').replace(/\.md$/i, '')
  return parseBoardDocument(text, title || '新白板')
}

function pathLength(pts) {
  let len = 0
  for (let i = 0; i + 1 < pts.length; i++) len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
  return len
}

/* 笔的"另一头"—— 橡皮端。
   把 Surface Pen 翻过来按在屏幕上时，Windows 给的事件是：
     pointerType === 'pen'，button === 5（PointerEvent 规范里 5 就是 eraser），
     buttons 里还会带上 32（= 1 << 5，同一个按钮的位）。
   笔杆上的侧键不是这个值（那是 1 / 2），所以不会把侧键误判成橡皮。
   ★ OneNote 的手感就靠这一条：不用去点工具条，翻过来就能擦。 */
function isPenEraser(e) {
  // 按位判（不是 === 32）：笔杆键和橡皮端有可能同时按着，那时 buttons 是 34
  return e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0)
}

/* 笔杆侧键（Surface Pen 上那个长条按钮）。
   按住它再用笔尖碰屏幕时，事件里 buttons 的 bit 1（值 2）是亮的。
   OneNote 拿它当"框选"用，这里跟着做：
   按住笔杆键拖一圈 → 圈到的墨迹被选中 → 可以直接拖着走，或者删掉。
   注意别和橡皮端混了：那个是 bit 5（32），两个都按住时 buttons = 34，
   所以一律按位判断、不做相等比较。 */
function isPenBarrel(e) {
  return e.pointerType === 'pen' && (e.buttons & 2) !== 0
}

/* ⚠ 这里原来有一份**本地**的 `strokeHitsRect`（和 geometry.js 那份逐字相同）——
   2026-09-17 架构 review 时删掉了：geometry.js 那份是"留下板框"在用的正本、
   而且被 check-board.js 断言着；本地这份**没有任何断言**，却是**框选**那条路在跑的。
   两份实现摆在一起，改一处漏一处就是"框选和板框判得不一样"，而屏幕上很难看出来。
   现在框选也走 geometry.js 那一个入口（见文件头的 import）。 */

/* 一组笔迹的包围盒搬去了 lib/board.js 的 `strokesBBox`（跟着"选中那一族"一起走的）。 */

/* 整笔平移。★ points 必须保持那个**扁平**数组格式（x, y, 压力 三连），
   这是这个项目的铁律 —— 见 lib/board.js 顶部的说明，
   内存里一旦换成对象数组，画布就会把一笔 10 个点读成 3 个。 */
function shiftStroke(stroke, dx, dy) {
  const pts = stroke.points
  const out = new Array(pts.length)
  for (let i = 0; i < pts.length; i += 3) {
    out[i] = pts[i] + dx
    out[i + 1] = pts[i + 1] + dy
    out[i + 2] = pts[i + 2]
  }
  return { ...stroke, points: out }
}

function clearLive(liveRef) {
  const cv = liveRef.current
  if (!cv) return
  const ctx = cv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cv.width, cv.height)
}

/* 正在画的那一笔只重画**它自己**，不重画整块板。
   ★ 这是"跟手"的关键：每帧重画全部笔迹的话，几百笔就开始掉帧，
     表现出来就是"笔尖过去半厘米了，线才跟上"。 */
function paintLive(liveRef, stroke, view) {
  const cv = liveRef.current
  if (!cv) return
  const dpr = Math.min(2.5, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
  const ctx = cv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cv.width, cv.height)
  applyViewTo(ctx, view, dpr)
  drawStroke(ctx, stroke)
}

/* 箭头工具的预览（见 ADR-0001）：一条线 + 两端吸到谁就把谁的框圈一下。
 * 为什么值得有预览：这个工具的全部意义是"我划的这一笔连的是哪两样东西" ——
 * 松手之前看不见"吸到谁了"，就只能靠猜（而那正是这一刀要消灭的东西）。
 * ★ 画在 live canvas 上、跟着视图变换走；线宽要**除以缩放**，
 *   屏幕上才是恒定的 2.4px（世界坐标里的线宽会被 ctx 的 scale 放大）。 */
function paintArrowLive(liveRef, board, from, to, view) {
  const cv = liveRef.current
  if (!cv) return
  const dpr = Math.min(2.5, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
  const ctx = cv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cv.width, cv.height)
  applyViewTo(ctx, view, dpr)
  const s = view && view.s ? view.s : 1
  const color = linkKind('cause').color
  ctx.save()
  ctx.strokeStyle = color
  /* 线宽/虚线都是**屏幕**像素（这块画布上叠着 applyViewTo 的 s），所以先换算回世界再设。 */
  ctx.lineWidth = screenLenToWorld(2.4, s)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  /* 吸到谁就圈谁：两头各圈一次（圈的是那个东西的框）。 */
  for (const p of [from, to]) {
    const n = snapNode(board, p)
    if (!n) continue
    ctx.setLineDash([screenLenToWorld(6, s), screenLenToWorld(4, s)])
    ctx.lineWidth = screenLenToWorld(2, s)
    ctx.strokeRect(n.box.x, n.box.y, n.box.w, n.box.h)
  }
  ctx.restore()
}
