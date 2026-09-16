import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BoardCanvas from './BoardCanvas.jsx'
import WritingPad, { OcrSettings } from './WritingPad.jsx'
import InkToCard from './InkToCard.jsx'
import { Tex } from './Tex.jsx'
/* ⚠ drawStroke 在这里**不能省**。
   它原来住在 BoardCanvas.jsx 里，后来搬去了 lib/ink.js（为了让"导出给识别"
   也能用它）。搬的时候我只改了 import 列表，文件里 paintLive 还在调用它 ——
   于是按下的第一件事就是 `ReferenceError: drawStroke is not defined`，
   笔完全点不动，而且**只在按下时才炸**（模块加载时不报错，构建也不报错）。
   教训：删一个 import 之前，先确认这个标识符在同一文件里没人用；
   构建工具不会替你查这个（它只是个运行时才会炸的未定义变量）。 */
import { drawStroke, MIN_STEP } from '../lib/ink.js'
import {
  CARD_FONTS, CARD_MIN_H, DEFAULT_CARD_FONT, HL_COLOR, HL_WIDTH, LINK_KINDS, LINK_NONE, autoLinkKind, buildLinks, cardHeightFromContent, cardWidthFromContent, fontCss, isLinkKind, linkKind, nextCardScale,
  buildRelations, createInkIndex, deriveChains, chainOfStroke, descendantsOf, freezeGroup, fitView, newCard, newStroke, parseBoardDocument,
  serializeBoardDocument, simplifyPoints, strokeHitsCircle, textCardRect, toFlat, toPoints,
} from '../lib/board.js'
/* 视图映射（屏幕 = 世界 × s + t）只有一份实现，在 view.js 里 ——
   从前这句公式在这两个组件里被手抄 14 处、canvas 变换写两份、捏合还复制了一份
   （于是"导出的那份有自检、手指走的是复制品"）。现在浮层位置、canvas 变换、
   滚动/捏合/平移/居中全走这里。 */
import { applyViewTo, centerOn, clampViewScale, panBy, screenToWorld, worldToScreen, zoomAt, zoomBetween } from '../lib/view.js'
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
/* 笔停下来多久之后，公式卡重新量一次尺寸（见下面那个 effect）。
   取 400ms 的用意：它比"存盘 700ms"短，所以屏幕上先贴合、再落盘；
   又比一次连续擦除/画一笔的节奏长，所以一整串手势只量一趟。 */
const REFIT_IDLE_MS = 400
const ERASER_R = 14 // 世界坐标半径，约一个字宽
const UNDO_MAX = 60
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

/* 把一笔的扁平点数组整个倒过来（[x,y,p] 三个一组）。
 * 用途：连接的"方向"就是"第一点 → 最后一点"，所以反向 = 把点倒过来。
 * 渲染出来一模一样（同一条路径），所以这是一次**纯语义**的操作，
 * 不用为方向单开一个字段 —— 也不会有"方向和笔迹对不上"的可能。 */
function reverseFlat(flat) {
  const out = []
  for (let i = flat.length - 3; i >= 0; i -= 3) out.push(flat[i], flat[i + 1], flat[i + 2])
  return out
}

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

  const wrapRef = useRef(null)
  const sceneRef = useRef(null)
  const liveRef = useRef(null)
  const boardRef = useRef(board)
  const undoRef = useRef([])
  const redoRef = useRef([])
  const pointersRef = useRef(new Map())
  const drawRef = useRef(null)
  const panRef = useRef(null)
  const pinchRef = useRef(null)
  const spaceRef = useRef(false)
  const saveTimer = useRef(null)
  const dirtyRef = useRef(false)
  const dragStartRef = useRef(null)
  const pendingFitRef = useRef(new Map())

  boardRef.current = board
  dirtyRef.current = dirty

  /* 唯一改板的入口。history=true 表示这一步值得撤销（画一笔、加卡片、删卡片）；
   false 表示是连续手势的中间状态（拖动、连续擦除），不该塞满撤销栈。 */
  const commit = useCallback((next, history = true) => {
    const prev = boardRef.current
    const value = typeof next === 'function' ? next(prev) : next
    if (value === prev) return
    boardRef.current = value
    if (history) {
      undoRef.current.push(prev)
      if (undoRef.current.length > UNDO_MAX) undoRef.current.shift()
      redoRef.current = []
    }
    setBoard(value)
    setHist({ undo: undoRef.current.length, redo: redoRef.current.length })
    setDirty(true)
  }, [])

  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (!prev) return
    redoRef.current.push(boardRef.current)
    boardRef.current = prev
    setBoard(prev)
    setHist({ undo: undoRef.current.length, redo: redoRef.current.length })
    setDirty(true)
  }, [])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    undoRef.current.push(boardRef.current)
    boardRef.current = next
    setBoard(next)
    setHist({ undo: undoRef.current.length, redo: redoRef.current.length })
    setDirty(true)
  }, [])

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
       一旦按它重跑，这个 effect 就会在每次保存之后把 undoRef 清空 ——
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
    undoRef.current = []
    redoRef.current = []
    setHist({ undo: 0, redo: 0 })
    /* ★ 重开一张板时，把卡片过时的尺寸重新量一次（用户 2026-09-16：
       「公式板子周围留白太大」—— 一半是 KaTeX 的 1em 边距，另一半是 w/h 过时）。
       为什么非要在"每次打开"跑一趟：w/h 是**存进文件**的测量值，而它可能是在
       另一种渲染规则、另一种字体状态下量出来的，只改 CSS 收不掉它 ——
       min-height 就是 h，h 不收，式子仍旧飘在一个大空盒子里。
       规矩只有一条：**两条轴都按真实内容量，收到贴着内容为止**（原来还多一条
       "至少要盖住你圈的那块笔迹"，2026-09-16 用户明确说不要了：
       「不用盖住，就让框贴合公式和字就行」）。
       量稳了就不再写盘：fitCardSize 要"连续两趟量出同一个数"才收手，重开板这一趟
       还额外带 1.5 世界像素的余量（见下面 opts.tol 那段）—— 所以不会每次打开都造一条假 diff。
       ⚠ 空白卡（"双击写公式"/"双击写字"那个占位）不量 —— 还没有内容可量。 */
    pendingFitRef.current.clear()
    queueFormulaRefits(b)
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
  }, [file, reloadToken, commit])

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
    scheduleFits()
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
     **只有笔迹或卡片真的变了才排队**，而且按 REFIT_IDLE_MS 防抖，
     一整串连续操作只量最后一趟。

     ⚠ 正在编辑的那张会挂起来等（fitCardSize 里的 'wait'）。 */
  useEffect(() => {
    const t = setTimeout(() => queueFormulaRefits(boardRef.current), REFIT_IDLE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.strokes, board.cards])

  // ── 存盘 ──
  const flushSave = useCallback(() => {
    if (!dirtyRef.current) return
    onSave(serializeBoardDocument(boardRef.current))
    setDirty(false)
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
  /* 画出来的连接（见 lib/board.js 的 buildLinks）。
     和 relations 一样**每次重算、不进文件** —— 你挪动卡片，连接自己跟着走。
     只有"你手动改过的那个词"存在笔迹上（stroke.link）。
     ★ 墨迹索引只依赖 `board.strokes`，按它缓存：拖卡片时 strokes 引用没变，
       那一坨（建索引 + 聚块 + flood fill）就不用重来 —— 否则拖一下卡就是几十毫秒。 */
  const inkIndex = useMemo(() => createInkIndex(board.strokes, board.groups), [board.strokes, board.groups])
  const links = useMemo(() => buildLinks(board, inkIndex), [board, inkIndex])
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
  /* 框选里如果**正好只有一条连接线**，就在框上那条浮层里多给一排词 ——
     这是"事后改词"的入口（画完那 3.5 秒没点、或者改主意了）。 */
  const selLink = useMemo(() => {
    if (!inkSel || inkSel.size !== 1) return null
    for (const id of inkSel) return linkByStroke.get(id) || null
    return null
  }, [inkSel, linkByStroke])
  /* 框住的笔里有没有"你说过不算连接"的（见 LINK_NONE）——
     有就给它一条回头路（不然那句话是单向门：点完只能 Ctrl+Z，重开之后就没路可走了）。 */
  const inkNoLink = useMemo(() => {
    if (!inkSel || !inkSel.size) return false
    for (const id of inkSel) {
      const s = board.strokes.find((x) => x.id === id)
      if (s && s.link === LINK_NONE) return true
    }
    return false
  }, [inkSel, board.strokes])
  /* 框住的这些笔**正好就是**某一块固定块吗？（是的话浮层上给「拆开这块」）
     判据用"集合完全相等"：少一笔都不算 —— 不然框一大片会把某块顺手拆了。 */
  const inkGroup = useMemo(() => {
    if (!inkSel || !inkSel.size) return null
    for (const g of board.groups || []) {
      if (g.ids.length !== inkSel.size) continue
      if (g.ids.every((id) => inkSel.has(id))) return g
    }
    return null
  }, [inkSel, board.groups])
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
        const keep = cur.strokes.filter((s) => !strokeHitsCircle(s, wp.x, wp.y, ERASER_R / cur.view.s))
        return keep.length === cur.strokes.length ? cur : { ...cur, strokes: keep }
      }, history)
    },
    [commit]
  )

  /* 选中的那组墨迹的包围盒（世界坐标）。
     渲染那个虚线框、以及判断"这一下是不是按在选区里"，都用它。只在真有选中时才算。 */
  const inkBox =
    inkSel && inkSel.size ? strokesBBox(board.strokes.filter((s) => inkSel.has(s.id))) : null
  /* 选中的**笔迹对象**（不只是 id）。美化要拿它们渲染成图发出去。 */
  const inkStrokes = useMemo(
    () => (inkSel && inkSel.size ? board.strokes.filter((s) => inkSel.has(s.id)) : []),
    [inkSel, board.strokes]
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
    commit((cur) => ({ ...cur, strokes: cur.strokes.filter((s) => !ids.has(s.id)) }))
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
        inkBox &&
        tool !== 'eraser' &&
        wp.x >= inkBox.x0 && wp.x <= inkBox.x1 &&
        wp.y >= inkBox.y0 && wp.y <= inkBox.y1
      ) {
        // 把"选中那几条按下时的原样"存下来，拖动时拿它算偏移（不累加，见 onPointerMove）
        const origin = new Map()
        for (const s of boardRef.current.strokes) if (inkSel.has(s.id)) origin.set(s.id, s)
        inkMoveRef.current = { from: wp, origin, moved: false }
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
    [tool, color, width, localPoint, eraseAt, trackPointerKind, inkBox, inkSel, selectedId]
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

      /* 拖着选中的那组墨迹走。
         ★ 每次都从"按下那一刻的原样"重新算偏移，**不是**累加每一帧的增量 ——
           累加会攒浮点误差，来回拖几次位置就飘了。 */
      if (inkMoveRef.current) {
        const lp = localPoint(e)
        const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)
        const mv = inkMoveRef.current
        const dx = wp.x - mv.from.x
        const dy = wp.y - mv.from.y
        if (dx || dy) mv.moved = true // 给松手时用：点一下没拖的话，不该往撤销栈里塞东西
        commit(
          (cur) => ({
            ...cur,
            strokes: cur.strokes.map((s) => (mv.origin.has(s.id) ? shiftStroke(mv.origin.get(s.id), dx, dy) : s)),
          }),
          false
        )
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
           screenToWorld 只给 {x, y}，而 .bd-eraser 的宽高是 2 * eraserAt.r * view.s ——
           少了 r 就成了 NaN，浏览器直接忽略 → 那个橡皮圈**一直画不出来**（原有的问题）。
           除以 view.s 是因为 r 走世界坐标、渲染时又乘回去，于是圈在屏幕上恒定大小，
           和擦除判定用的是同一个半径。 */
        setEraserAt({ x: wp.x, y: wp.y, r: ERASER_R / boardRef.current.view.s })
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
            // 阈值按屏幕算：放大后世界坐标的一步更小，不除 s 会把细节吃掉
            if (Math.hypot(dx, dy) < MIN_STEP / s) continue
          }
          d.stroke.points.push(w2.x, w2.y, ev.pressure > 0 ? ev.pressure : 0.5)
          added = true
        }
        if (added) paintLive(liveRef, d.stroke, boardRef.current.view)
      }
    },
    [tool, localPoint, setView, eraseAt, trackPointerKind, commit]
  )

  const onPointerUp = useCallback(
    (e) => {
      pointersRef.current.delete(e.pointerId)
      if (pointersRef.current.size < 2) pinchRef.current = null
      panRef.current = null

      /* 框选松手：把圈到的墨迹选上。
         用 lassoRef 里的 box 而不是 lasso 这个 state —— 两者在同一帧里可能差一步，
         松手这一刻要的是"最后画出来那个框"。 */
      if (lassoRef.current) {
        const box = lassoRef.current.box
        lassoRef.current = null
        setLasso(null)
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
        if (!ids.length && (box.x1 - box.x0) * vs <= 4 && (box.y1 - box.y0) * vs <= 4) {
          const cx = (box.x0 + box.x1) / 2
          const cy = (box.y0 + box.y1) / 2
          const r = 10 / boardRef.current.view.s
          const hit = boardRef.current.strokes.find((s) => linkByStroke.has(s.id) && strokeHitsCircle(s, cx, cy, r))
          if (hit) ids = [hit.id]
        }
        setInkSel(ids.length ? new Set(ids) : null)
        /* 空框说一句人话。静默什么都不发生是最让人迷惑的 ——
           用户会以为"框选坏了"，而其实只是框小了/框到空白上了。 */
        if (!ids.length) flash('框里没有笔迹 —— 框大一点，或者框到字上', 'warn')
        return
      }

      /* 拖完松手：把整次拖动记成一步撤销（中途那些帧都不记）。 */
      if (inkMoveRef.current) {
        const mv = inkMoveRef.current
        inkMoveRef.current = null
        const now = boardRef.current.strokes
        /* 用拖动过程中打的 moved 标记，不去逐条比对坐标 ——
           比对那版看着更"严谨"，实际不可靠。 */
        if (mv.moved) {
          undoRef.current.push({ ...boardRef.current, strokes: now.map((s) => mv.origin.get(s.id) || s) })
          if (undoRef.current.length > UNDO_MAX) undoRef.current.shift()
          redoRef.current = []
          setHist({ undo: undoRef.current.length, redo: redoRef.current.length })
        }
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
          applyLink(linkPick.strokeId, k.id)
          return
        }
      }
      /* `0` = 这条不算连接（和 1~5 同一排，手不用离开键盘）。 */
      if (linkPick && e.key === '0') {
        e.preventDefault()
        applyLink(linkPick.strokeId, LINK_NONE)
        return
      }
      if (linkPick && e.key === 'Escape') {
        setLinkPick(null)
        return
      }
      if (e.key === 'Escape') {
        setSelectedId(null)
        setEditingId(null)
        setInkSel(null)
        return
      }
      if (e.key === 'p' || e.key === 'P') return setTool('pen')
      if (e.key === 'e' || e.key === 'E') return setTool('eraser')
      // S = select：框选。挑 S 是因为它没被占（P 是笔、E 是橡皮、W 是写字板、Space 是平移）
      if (e.key === 's' || e.key === 'S') return setTool('select')
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
        const sel = boardRef.current.cards.find((c) => c.id === selectedId)
        if (sel && sel.locked === true) {
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
  }, [undo, redo, setView, selectedId, commit, variant, inkSel, deleteInkSel, linkPick, linkByStroke])

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
       keepCenterX：卡片是以视野中心放上去的，收宽度要**从中间缩**，不然会往左跳。 */
    pendingFitRef.current.set(c.id, { fitWidth: true, keepCenterX: true })
    scheduleFits()
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

  /* ── 连接线上的那一步（可选）──
   * 2026-09-16 用户：「我要更便捷的显示出两者之间的主次、因果、并列等关系」
   * 「我操作的速度是很快的，我没有时间去逐步花很多时间操作这个表示关系的步骤」
   *
   * 所以这里的设计是**零步骤优先**：一条连接 = 你画的那一笔（形状决定类型，见
   * lib/board.js 的 buildLinks / classifyLinkShape），画完就成立、屏幕上立刻有标记。
   * 下面这几个函数只做一件事：**让你随时用一下（或者不用）去改那一个词** ——
   * 画完 3.5 秒浮出来，不点就收走；以后想改，框住那条线还能再浮一次。
   *
   * 为什么不用弹窗/必须点：你在想事情的时候，任何"必须先处理一下"的界面都是打断。
   * 为什么还要留这一个口子：形状读不出箭头的手型是真实存在的（比如分两笔画），
   * 那就必须有一条"一句话改回来"的路，否则猜错了只能重画。
   */
  function applyLink(strokeId, kind, opt = {}) {
    /* ★ 「不算连接」：你说了它不是连接 —— 存在**这一笔**上（`link: 'none'`），
       buildLinks 见到就跳过（见 lib/board.js 的 LINK_NONE）。
       为什么必须有这条路：自动读出来的连接会读错（一条长竖笔正好跨过两坨字），
       在那之前认错了只能擦掉那一笔重画 —— 那就成了"猜错还锁死"。
       它是**一步正常的撤销**（Ctrl+Z 就回来了），不是不可逆的标记。 */
    if (kind === LINK_NONE) {
      const known = linkByStroke.get(strokeId)
      const ids = new Set(known ? known.ids : [strokeId])
      commit((cur) => ({
        ...cur,
        strokes: cur.strokes.map((st) => (ids.has(st.id) ? { ...st, link: LINK_NONE } : st)),
      }))
      setLinkPick(null)
      setInkSel(null)
      flash('这条不算连接了（框住它还能恢复；Ctrl+Z 也能）', 'ok')
      return
    }
    if (!isLinkKind(kind)) return
    commit((cur) => ({
      ...cur,
      strokes: cur.strokes.map((st) => {
        if (st.id !== strokeId) return st
        /* ⇄ 反向 = 把这笔的点**倒过来**。
           倒过来渲染出来一模一样（都是同一条路径），但"第一点 → 最后一点"变了 ——
           箭头方向就是靠这个表达的，所以不用另存一个方向字段。 */
        const points = opt.reverse ? reverseFlat(st.points) : st.points
        /* ★ auto 取**连接这一层**读出来的那个（buildLinks 的结果），不是单看这一笔：
           用户的箭头常常是"一杆 + 一个 V 尖"两笔画的 —— 单看那根杆永远是"相关"，
           只有连接层知道旁边那个尖是它的。所以选"因果"时不能写进文件（写进去就是噪音，
           而且以后擦掉尖它也不会自己回来）。
           ⇄ 反向时形状变了（回勾跑到另一头去），这时退回单笔判断。 */
        const known = linkByStroke.get(strokeId)
        const auto = !opt.reverse && known ? known.auto : autoLinkKind({ ...st, points })
        const next = { ...st, points }
        /* ★ 选的就是"形状自动读出来那一档" → **不写这个字段**（回到自动）。
           于是文件里只有"你特意改过的"那几个词：一条没动过的连接是零字节，
           老文件也不会因为我们加了这个功能而变脏。 */
        if (kind === auto) delete next.link
        else next.link = kind
        return next
      }),
    }))
    setLinkPick(null)
    flash(opt.reverse ? `方向反过来了：${linkKind(kind).name}` : `这条线：${linkKind(kind).name}`, 'ok')
  }

  /* 把选中的那几笔从"不算连接"改回来：去掉 `link: 'none'` → 回到按形状自动判。
     这是那道单向门的回头路（见 applyLink 里的 LINK_NONE）。
     ★ 要按**整条链**清（`chainOfStroke`），不能只清框住的那一笔：
     `link:'none'` 当初是写在整条链上的，链里还剩一笔 none，buildLinks 仍然整条跳过 ——
     用户点了按钮却什么都没发生（审查挑出来的）。 */
  function clearNoLink() {
    if (!inkSel || !inkSel.size) return
    const board0 = boardRef.current
    const ids = new Set()
    for (const id of inkSel) for (const cid of chainOfStroke(board0, id)) ids.add(cid)
    commit((cur) => ({
      ...cur,
      strokes: cur.strokes.map((st) => {
        if (!ids.has(st.id) || st.link !== LINK_NONE) return st
        const next = { ...st }
        delete next.link
        return next
      }),
    }))
    setInkSel(null)
    flash('又算回连接了（按形状重新判）', 'ok')
  }

  /* ── 固定 / 拆开一块（见 lib/board.js 的 normalizeGroups）──
   * 自动聚类会把挨得近的两坨并成一块。后果虽然轻（"多连了一个"，绝不改你的字），
   * 但**你得有地方纠正它** —— 这里就是：框住一块 → 固定成一块（写进 `groups`）。
   * 两块各自固定 = 把它们**拆开**（自动聚类再也不会把它们并起来）。
   * 只在你说过时才写这个字段：没固定过的板一个字节都不多。 */
  function freezeInkGroup() {
    if (!inkSel || !inkSel.size) return
    const ids = [...inkSel]
    /* `freezeGroup` 会把这几笔从别的组里拿走（一笔只能属于一个组）——
       不这么干的话，界面能造出"内存里重叠、文件里只认一笔"的状态，下次打开分组悄悄变。 */
    const taken = (boardRef.current.groups || []).filter((g) => g.ids.some((id) => inkSel.has(id)))
    commit((cur) => ({ ...cur, groups: freezeGroup(cur.groups, ids) }))
    flash(
      taken.length
        ? `固定成一块了（${ids.length} 笔）—— 其中几笔原来在别的块里，已经挪过来了`
        : `固定成一块了（${ids.length} 笔）—— 它以后永远是独立的一块，按 ⧉ 拆开`,
      'ok'
    )
  }

  function dissolveInkGroup() {
    if (!inkGroup) return
    const gid = inkGroup.id
    commit((cur) => ({ ...cur, groups: (cur.groups || []).filter((g) => g.id !== gid) }))
    setInkSel(null)
    flash('拆开了 —— 这一块又回到"按邻近自动聚"', 'ok')
  }

  /* 那排词放在哪：连接线的中点上、再往上让开一点 ——
     线中段常常写着你顺手写的条件（"仅当…"），压在上面会挡住它。
     ★ 还要**夹进画布范围**：浮出来的东西跑到屏幕外或压到底部工具条底下，
     用户就点不到了（缩放柄、美化按钮都栽过这一条，见 README 第 13 条）。 */
  function linkPickAt(midWorld) {
    const el = wrapRef.current
    const v = boardRef.current.view
    if (!el) return { x: 0, y: 0 }
    const x = midWorld.x * v.s + v.tx
    const y = midWorld.y * v.s + v.ty
    return {
      x: Math.min(Math.max(x, 130), Math.max(130, el.clientWidth - 130)),
      y: Math.min(Math.max(y, 96), Math.max(96, el.clientHeight - 60)),
    }
  }

  /* 刚画完一笔：如果它正好连上了两个东西，就把那排词浮出来。
     注意这时候连接**已经成立了**（buildLinks 从笔迹现算），浮词只是给你一次改的机会。 */
  function offerLink(stroke) {
    const hit = buildLinks(boardRef.current).find((l) => l.strokeId === stroke.id)
    if (!hit) return
    const { x, y } = linkPickAt(hit.mid)
    setLinkPick({ strokeId: stroke.id, x, y, kind: hit.kind, dir: hit.dir })
  }

  /* 点那颗词（已经标过的连接上那个小标签）→ 再浮一次，方便改。 */
  function openLinkPick(link) {
    const { x, y } = linkPickAt(link.mid)
    setLinkPick({ strokeId: link.strokeId, x, y, kind: link.kind, dir: link.dir })
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

  /* ★ 卡片尺寸**按真实内容量一次**。
   *
   * 为什么必须有这一步：`textCardRect` 只能按字数估，估出来的尺寸不是多了就是少了；
   * 而公式卡连估都估不了（分式、根号差别很大）。多出来的部分就是用户报的"留白太多"——
   * 一行字的卡下面空一大截（高度），一行短公式左右全是空的（宽度）。
   *
   * 两条轴都量，而且都是"贴合内容"这**一条**规矩（2026-09-16 用户定下来的：
   * 「不用盖住，就让框贴合公式和字就行」）：
   *   · **高度**量的是内容（`.bd-card-body`）——卡片的 min-height 就是 h，
   *     量卡片自己等于量自己，永远量不出"其实只有一行字"。
   *   · **宽度**量的是内容的**自然宽度**：临时把宽度放开成 `max-content` 读一次
   *     （折行内容量不出自然宽）。公式是一行不折行的，它自己多宽就是多宽；
   *     文字卡的自然宽 = 最长那一行（识别结果保住了你写的换行），
   *     超过 `TEXT_CARD_MAX_W` 才折行。
   *   （上一版还多一条"至少要盖住你圈的那块笔迹"，那套 2026-09-16 拆掉了 ——
   *     它会让卡片永远比内容大一块，看起来就是"框不贴合"。）
   *
   * ★ **编辑态不能量。** 那时候卡片里装的是编辑器（输入框 + KaTeX 预览 + 一排符号按钮），
   *   量出来是编辑器的尺寸 —— 实测把 h 写成了 204，是真正内容的好几倍。
   *   所以编辑态就把它挂在 pendingFitRef 里，等退出编辑（回车/取消/点别处）再量。
   *
   * opts.keepCenterX：从**中间**收宽度（写字板那条路是"以视野中心"放上去的，
   * 不收中间的话卡片会往左跳）。默认按左上角收（圈选那条路钉在笔迹左上角）。
   * 返回 'done' / 'missing' / 'wait'，见 runPendingFits。
   */
  function fitCardSize(cardId, opts = {}, attempt = 0) {
    const wrap = wrapRef.current
    const cur = boardRef.current.cards.find((c) => c.id === cardId)
    if (!wrap || !cur) return 'done' // 卡片已经没了，当量过了
    const cardEl = wrap.querySelector('[data-card-id="' + cardId + '"]')
    const el = cardEl ? cardEl.querySelector('.bd-card-body') : null
    if (!el) return 'missing' // 还没挂上，让调用方下一帧再来
    if (cardEl.classList.contains('editing')) return 'wait' // 编辑态量不得，挂着

    const s = boardRef.current.view.s
    const scale = cur.scale || 1
    /* 内边距 + 边框（屏幕像素）：这个仓库全局是 `box-sizing: border-box`，
       卡片上写的 width/min-height **都把这一圈算在里面**，所以算尺寸时必须加上它 ——
       不加就正好少一整圈，宽度那条线上直接表现为内容被裁掉。 */
    const cs = getComputedStyle(cardEl)
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)

    /* ★★ 先确认 DOM 上这张卡的宽度**已经是数据里的宽度**，再动尺子。
       为什么：宽度那一条改完要等 React 重渲染，而"量尺寸"可能在同一帧里被叫第二次
       （scheduleFits 有几处调用点）—— 那时候量到的是**上一次渲染的世界**：
       宽度还是旧的，文字就还是折成旧行数，高度会被算错并钉死（实测：钉在 94.4，
       而正确值是 66，且不会再自己好）。所以对不上就返回 'stale'，下一帧再来。
       高度不一样没关系 —— 写的是 min-height，布局尺寸只由宽度决定。 */
    const wantW = cur.w * s * scale
    if (Math.abs(cardEl.getBoundingClientRect().width - wantW) > 1) return 'stale'

    const nextH = cardHeightFromContent(el.getBoundingClientRect().height, { s, scale, padPx: padY })
    opts.measuredH = nextH // 高度需求，留给外面判断"这一趟稳定了没有"
    opts.measured = nextH

    let nextW = cur.w
    if (opts.fitWidth) {
      const prev = el.style.width
      el.style.width = 'max-content'
      const natural = el.getBoundingClientRect().width
      el.style.width = prev
      /* 还要把"已经溢出的那部分"算进去：字体没就绪时 max-content 可能偏小，
         而溢出量（scrollWidth − clientWidth）任何情况下都准。两个取大的那个当需求。 */
      const tex = el.querySelector('.bd-tex')
      const spilled = tex ? Math.max(0, tex.scrollWidth - tex.clientWidth) : 0
      const needPx = Math.max(natural, spilled ? (tex ? tex.clientWidth : 0) + spilled : 0)
      opts.measured = needPx // 宽度需求（那才是会被裁的那一轴）
      nextW = cardWidthFromContent(needPx, { s, scale, padPx: padX })
    }

    /* "差这么点就不写盘"的门槛。默认 0.6（一次性的拟合，量多准写多准）。
       ★ 自动重量那一趟（开板 / 板子安静下来）传 1.5，理由不是精度，
         而是**别每次打开都改一遍文件**：差 1~2 个世界像素肉眼看不出，
         而内容是文字度量，KaTeX 的字体换进来前后能量出 1px 上下的差别。
         实测（2026-09-16）：同一张卡冷启动开一次 h=34.1、热一点开一次 34.9，
         每次打开都写一次盘 —— 那正是 README 反复念叨的"每天一条假 diff、
         然后你学会忽略 diff"的开端。留 1.5 的余量，两种度量都落进"不用改"里。 */
    const tol = opts.tol || 0.6
    /* 把"这一趟量到了什么"写在 DOM 上 —— 和画布那几个 dataset.strokes/pts/flat 一个道理：
       "卡片为什么是这个尺寸"用眼睛看是看不出来的，而这类问题只有这里能查
       （量到的宽度、第几趟、算出来的宽高）。自检会读它。
       ★ 写在"要不要提交"的判断**之前**：不然"量了但觉得不用改"的那一趟不留痕迹，
         而这正是最需要看的一种状态（"它到底量到几？"）。
       实测就是靠它查明白的：文字卡那一趟 need=281.3、h=94.4、tries=0 —— 一眼看出
       高度是**按换行前的窄宽度**算的，而"两趟才收敛"这件事没发生。 */
    if (cardEl) {
      cardEl.dataset.fit = JSON.stringify({
        need: Math.round((opts.measured || 0) * 10) / 10,
        tries: opts.tries || 0,
        w: nextW,
        h: nextH,
      })
    }
    if (Math.abs(nextH - cur.h) < tol && Math.abs(nextW - cur.w) < tol) return 'done'
    commit(
      (c) => ({
        ...c,
        cards: c.cards.map((x) =>
          x.id === cardId
            ? {
                ...x,
                w: nextW,
                h: nextH,
                /* keepCenterX：写字板那条路是"以中心"把卡片放在视野里的 ——
                   宽度一收，要让它**从中间缩**，不然卡片会突然往左跳一截。
                   「框选」那条路是钉在笔迹左上角的，收宽度时左上角不能动。 */
                x: opts.keepCenterX ? x.x + (cur.w - nextW) / 2 : x.x,
              }
            : x
        ),
      }),
      false
    )
    return 'done'
  }

  /* KaTeX 用的是自带字体（dist/assets 里的 woff2）。公式卡的**宽度要在字体就绪之后量**：
     字体没上时量到的是兜底字体的宽度（实测 58 vs 真正的 76，差 30%），
     而宽度写的是 `width`（硬约束）—— 卡片会把 `E = mc²` 的 `c²` 当场裁掉。
     ⚠ 试过两道"等字体"的闸，都不可靠：
       · `document.fonts.ready` —— 那张卡渲染**触发**的字体加载，可能在它 resolve 之后才开始；
       · `document.fonts.check('1em KaTeX_Main')` —— 对"还没注册/没加载"的自定义家族，
         它会当成系统字体返回 true（规范如此），所以闸门形同虚设。
     所以改成**不猜**：多量几趟（每 150ms 一趟，最多 12 趟），
     连续两趟量出同一个数才算准 —— 字体换上去会让宽度变一次，那一次必然被抓住。 */

  /* 认出来还没量过尺寸的卡（cardId → 量的选项 + 量到第几趟了）。
     摘掉的条件：连续两趟量出的需求一样**而且两条轴都一样**（稳定了），
     或者量满 12 趟，或者这张卡没了。

     ★★ "同一帧里连量两趟"必须挡住，否则会量到一个**还没更新完的 DOM**：
       实测（2026-09-16，文字卡）：scheduleFits 被几处同时叫，两个 rAF 在同一帧里
       先后跑 —— 第一趟提交了新的宽度（w 220 → 299），第二趟在**同一毫秒**又量了一次
       （dom 还是 220 宽），于是它看到的还是"折成三行"的内容，把高度钉在 94.4；
       而宽度那一趟已经相等了 → 判成"稳定" → 收工。屏幕上就是"卡片比字高出一行"，
       而且**永远不会自己好**（除非重开文件）。所以：量之前先看 DOM 的宽度对不对得上
       （'stale' → 下一帧再来），并且稳定性要**两条轴都稳**才算数。
       记法：**提交完不能立刻再量 —— 你量的是上一次渲染的世界。** */
  const FIT_MAX_TRIES = 12
  function runPendingFits() {
    let retryFrame = false
    let tryLater = false
    for (const [id, opts] of [...pendingFitRef.current]) {
      const state = fitCardSize(id, opts)
      if (state === 'missing' || state === 'stale') {
        retryFrame = true // 还没挂上 / DOM 还没跟上上一次提交 —— 下一帧再来
        continue
      }
      if (state === 'wait') continue // 编辑态，等 editingId 一变再来

      const stableH = opts.lastNeedH != null && opts.measuredH != null && Math.abs(opts.measuredH - opts.lastNeedH) < 1
      const stableW = opts.lastNeed != null && opts.measured != null && Math.abs(opts.measured - opts.lastNeed) < 1
      opts.lastNeed = opts.measured
      opts.lastNeedH = opts.measuredH
      opts.tries = (opts.tries || 0) + 1
      if ((stableH && stableW) || opts.tries >= FIT_MAX_TRIES) {
        pendingFitRef.current.delete(id)
        continue
      }
      pendingFitRef.current.set(id, opts)
      tryLater = true
    }
    if (retryFrame) requestAnimationFrame(() => runPendingFits())
    if (tryLater) setTimeout(() => runPendingFits(), 150)
  }

  /* 排上量尺寸的头几趟：下一帧、以及字体就绪时（editingId 变化时也会来一趟，见那个 effect）。 */
  function scheduleFits() {
    requestAnimationFrame(() => runPendingFits())
    const fonts = typeof document !== 'undefined' ? document.fonts : null
    if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
      fonts.ready.then(() => requestAnimationFrame(() => runPendingFits()))
    }
  }

  /* 把这张板上所有**有内容的公式卡**排进"重新量一次"的队里。
     两个调用点共用这一份规矩：换文件/重载那一趟（先 clear 再排）、
     以及板子安静下来之后那一趟（见上面那个 effect）。写成一处的理由很实在 ——
     这两处一旦各写一份，"量什么、门槛多少"就会慢慢不一样。

     ⚠ **只管公式卡，便签/文字卡不在这里自动收。**
       刚认出来的文字卡照样贴合内容（那一刻由 insertFromInk 排一次量尺寸，
       公式卡和文字卡一视同仁）；但"每次开板/板子一静就自动收"这件事只给公式卡做，
       因为便签卡在这个应用里有个**容器**身份：关系面板那条「公式卡整个落在便签里
       → 包含（这公式属于这一节）」就是靠"便签比自己的字大一圈"成立的 ——
       实测（2026-09-16）把便签也一起自动收之后，样板板的 3 条连线当场变成 0 条，
       关系推理整块塌掉。你要更紧凑的便签，拖右下角那个柄就把它收小。
     ⚠ 已经排在队里的不覆盖：刚插进来的那张可能带着自己的选项
       （比如 keepCenterX，写字板那条路要从中间收宽度），覆盖掉就会往左跳。
     ⚠ 空白卡（"双击写公式"/"双击写字"那个占位）不排 —— 还没有内容可量。
     ⚠ `scheduleFits()` 由这里自己叫 —— 排了队不开跑，就等于什么都没发生，
       而且屏幕上完全看不出来（第一版就是这样：卡片纹丝不动，
       量尺寸那几趟一趟都没跑）。 */
  function queueFormulaRefits(b) {
    if (!b) return
    for (const c of b.cards || []) {
      if (c.kind !== 'formula') continue
      if (!String(c.tex || c.src || '').trim()) continue
      if (pendingFitRef.current.has(c.id)) continue
      pendingFitRef.current.set(c.id, { fitWidth: true, tol: 1.5 })
    }
    scheduleFits()
  }

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
    const box = inkBox || { x0: 0, y0: 0, x1: 0, y1: 0 }
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
         挂进 pendingFitRef，等退出编辑时由 runPendingFits 量。 */
    pendingFitRef.current.set(card.id, { fitWidth: true })
    scheduleFits()
    flash(
      (isFormula ? '公式卡放上去了' : '放上去了') +
        (erase ? '，原来那几笔已擦掉（Ctrl+Z 能退回）' : '，原来那几笔还留在板上（卡片不盖它）')
    )
  }

  /* 拖右下角放大缩小一张卡。手势的 move/up 挂在 window 上（见下面的说明）。 */
  function startResize(cardId, rectW, startX) {
    const c0 = boardRef.current.cards.find((x) => x.id === cardId)
    if (!c0) return
    const st = { id: cardId, rectW: rectW || c0.w, startX, scale: c0.scale || 1, w: c0.w, moved: false }

    const onMove = (e) => {
      const dx = e.clientX - st.startX
      if (Math.abs(dx) < 1.5) return
      st.moved = true
      const k = (st.rectW + dx) / st.rectW
      const next = nextCardScale({ w: st.w, scale: st.scale }, k)
      commit((cur) => ({ ...cur, cards: cur.cards.map((x) => (x.id === st.id ? { ...x, scale: next } : x)) }), false)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      if (!st.moved) return
      // 一次缩放 = 一步撤销（和拖动同一个做法：把"按下那一刻"补进栈）
      const before = {
        ...boardRef.current,
        cards: boardRef.current.cards.map((x) => (x.id === st.id ? { ...x, scale: st.scale } : x)),
      }
      undoRef.current.push(before)
      if (undoRef.current.length > UNDO_MAX) undoRef.current.shift()
      redoRef.current = []
      setHist({ undo: undoRef.current.length, redo: redoRef.current.length })
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  /* stageProps 里那些东西要一起传给画布：卡片层作为 children（同一个世界原点）。 */
  const stageProps = {
    sceneRef, liveRef, view: board.view, size,
    strokes: board.strokes, relations, cardById,
    cardsForInk: inkPairs, hoverEdge, eraserAt,
    links, selLink, linkPick, onPickLink: openLinkPick, onApplyLink: applyLink,
    inkNoLink, onClearNoLink: clearNoLink, inkGroup, onFreezeInk: freezeInkGroup, onDissolveInk: dissolveInkGroup,
    onLinkHover: (inside) => {
      linkLeftRef.current = inside
    },
    onPointerDown, onPointerMove, onPointerUp,
    lasso, inkBox, onDeleteInk: deleteInkSel,
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
            onSelect={() => setSelectedId(c.id)}
            onStartDrag={() => {
              const c0 = boardRef.current.cards.find((x) => x.id === c.id)
              dragStartRef.current = c0 ? { id: c.id, x: c0.x, y: c0.y } : null
            }}
            onStartEdit={() => {
              setSelectedId(c.id)
              setEditingId(c.id)
            }}
            onCommit={(patch) => commit((cur) => ({ ...cur, cards: cur.cards.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) }))}
            onCloseEdit={() => setEditingId(null)}
            onDrag={(dxScreen, dyScreen) =>
              commit(
                (cur) => {
                  // 屏幕位移 → 世界位移：除以**当前**缩放（不是按下那一刻的）
                  const k = cur.view.s
                  const dx = dxScreen / k
                  const dy = dyScreen / k
                  return { ...cur, cards: cur.cards.map((x) => (x.id === c.id ? { ...x, x: x.x + dx, y: x.y + dy } : x)) }
                },
                false
              )
            }
            onDragEnd={() => {
              const st = dragStartRef.current
              dragStartRef.current = null
              if (!st) return
              const now = boardRef.current.cards.find((x) => x.id === st.id)
              if (!now || (Math.abs(now.x - st.x) < 0.5 && Math.abs(now.y - st.y) < 0.5)) return
              // 一次拖动 = 一次撤销：把"拖动前的位置"补进栈（中途那些步不记）
              const before = {
                ...boardRef.current,
                cards: boardRef.current.cards.map((x) => (x.id === st.id ? { ...x, x: st.x, y: st.y } : x)),
              }
              undoRef.current.push(before)
              if (undoRef.current.length > UNDO_MAX) undoRef.current.shift()
              redoRef.current = []
              setHist({ undo: undoRef.current.length, redo: redoRef.current.length })
            }}
            /* ── 放大缩小（拖右下角那个柄）──
               ★ 手势的移动/松手**挂在 window 上**，不靠 setPointerCapture、也不靠
                 "指针还在手柄上"。两个理由，都是踩出来的：
                 ① 手柄只有 18px，鼠标拖两下就出去了，靠元素自己的 onPointerMove
                    会当场收不到事件（自检里实测：拖了 120px，倍率纹丝不动）；
                 ② 卡片本身会 stopPropagation，窗口级 + 捕获阶段最省事。
               这个手势和"拖动"是同一种东西：中途 commit(..., false) 不进撤销栈，
               松手时把"按下那一刻的倍率"补成**一步**撤销。 */
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
     「⬚ 框选」是例外：切到它，卡片对所有设备都可交互，用笔的人靠它管理卡片。 */
  const penInk = penMode && tool !== 'select'

  /* 纸面的类挂在**最外层 .bd 上**（不是 .bd-stagewrap）：
     写字板那块小板也要跟着换纸，而它是 .bd 的兄弟分支，不是 stagewrap 的孩子。
     挂在根上，一条 `.paper-grid .bd-stagewrap, .paper-grid .wp-padwrap` 就都管得住。 */
  return (
    <div className={'bd variant-' + variant + ' paper-' + paper + (fullscreen ? ' bd-fs' : '') + (penInk ? ' penink' : '')}>
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
          strokes={inkStrokes}
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
        /* 位置 = 世界 → 屏幕（只跟视图缩放走）；
           宽高/字号 = 再乘"这张卡自己的倍率 k" —— 两件事，别混。
           ⚠ `worldToScreen` 返回的是 `{x, y}`，不是 `{left, top}` ——
             直接展开进 style 的话卡片会**没有 left/top**（静默退回 CSS 定位，整版错位）。 */
        left: at.x,
        top: at.y,
        width: card.w * view.s * k,
        minHeight: card.h * view.s * k,
        /* 字号和内边距也按缩放走，卡片才是"整体一致地"变大变小。
           只缩 left/top/width 而不缩字号，卡片会跑到正确的位置却保持原来的大小。
           倍率有两种：view.s 是"这张纸的缩放"（大家共享），k 是"这张卡自己的放大缩小"。
           CSS 里只有一个 --bd-card-scale，所以在这里乘好再写出去。 */
        '--bd-card-scale': view.s * k,
        /* 内边距从 10/12 收到 4/8（用户 2026-09-16：「边缘留白太多了」）。
           为什么不干脆给 0：字贴着边框线看着像画坏了，而且卡片一选中、
           边框一加粗就会压到字上。4px 是"看着贴、但不顶边"的那个数。 */
        padding: `${4 * view.s * k}px ${8 * view.s * k}px`,
        borderRadius: Math.max(3, 10 * view.s * k),
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
              const rectW = host ? host.getBoundingClientRect().width : card.w * view.s * k
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
        <button className={'bd-t' + (tool === 'pen' ? ' on' : '')} onClick={() => setTool('pen')} title="笔（P）：手写笔默认就是这个">
          ✎ 笔
        </button>
        <button className={'bd-t' + (tool === 'highlighter' ? ' on' : '')} onClick={() => setTool('highlighter')} title="荧光笔：盖在字上做记号">
          ▬ 荧光
        </button>
        <button className={'bd-t' + (tool === 'eraser' ? ' on' : '')} onClick={() => setTool('eraser')} title="橡皮（E）：碰到哪一笔就擦掉整笔">
          ◻ 橡皮
        </button>
        {/* 框选（S）：拖一个矩形圈住笔迹。原来只有"笔杆侧键"这一条路，
            所以用鼠标、或者笔上没有侧键的人根本选不中笔迹 —— 认公式/美化也就无从谈起。 */}
        <button className={'bd-t' + (tool === 'select' ? ' on' : '')} onClick={() => setTool('select')} title="框选（S）：拖一个框圈住要认的手写 —— 圈住之后框上方浮出「∑ 公式」「✨ 美化」「✕ 删除」。★ 用笔时卡片会给笔让路，想拖卡片 / 缩放 / 双击改字就切到这个工具">⬚ 框选</button>
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

function RelationPanel({ board, relations, links, inkPairs, selectedId, onSelect, onHoverEdge, onFocus }) {
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
  /* 连接的两端可能不是卡片，而是**墨迹块**（没成卡的字迹、手画的图，见 lib/board.js）。
     那种端点的名字在链接对象上（aLabel/bLabel），不能去卡片表里找 —— 找不到就是"(没了)"。 */
  const endName = (l, k) => (l[k + 'Kind'] === 'ink' ? l[k + 'Label'] || '墨迹块' : label(byId.get(l[k])))
  /* 链里的人名：端点可能是卡片，也可能是墨迹块（名字在链接对象上）。 */
  const nameOf = (id, link) => {
    if (link && id === link.a && link.aKind === 'ink') return link.aLabel || '墨迹块'
    if (link && id === link.b && link.bKind === 'ink') return link.bLabel || '墨迹块'
    return label(byId.get(id))
  }
  const condName = (cond) => (cond.kind === 'ink' ? cond.label || '墨迹块' : label(byId.get(cond.id)))
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

      {/* ★ 你亲手画出来的那些连接 —— 和上面的"按位置读出来的"分开列。
          为什么要单独一节：连线的两张卡常常离得很远（位置推断根本不会把它俩凑一对），
          而"我画过线"恰恰是最确定的一句话，它不该因为离得远就从面板上消失。 */}
      {links.length > 0 && (
        <div className="bd-links-list">
          <div className="bd-rel-sub">你画过的（{links.length} 条）</div>
          {links.map((l) => (
            <button
              key={l.strokeId}
              className={'bd-link-row' + (l.dir ? ' dir' : '')}
              onClick={() => onFocus(l.a)}
              title={l.manual ? '你标过的：' + l.name : '按笔迹形状读出来的：' + l.name}
            >
              <span className="bd-link-kind" style={{ color: l.color, borderColor: l.color }}>
                {l.name}
                {l.dir ? (l.kind === 'cause' ? ' →' : ' ⇒') : ''}
              </span>
              <span className="bd-er">{endName(l, 'a')}</span>
              <span className="dim">{l.dir ? '→' : '—'}</span>
              <span className="bd-er">{endName(l, 'b')}</span>
              {/* 「条件是位置送的」：线中点旁边那几个字 / 那张卡（见 lib/board.js 的 linkCondition）。 */}
              {l.cond && <span className="bd-cond" title="写在这条线中点旁边的字（或那张卡）—— 位置决定它是不是条件">条件 {condName(l.cond)}</span>}
            </button>
          ))}
          <div className="dim small pad">
            形状读出来的（直线=相关、带箭头=因果）**不写进文件**；
            你点过词的那几条才会记住。
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

/* 一笔有没有"碰到"这个矩形（都是世界坐标）。
   判定用碰着就算 —— 只要有任意一个点落在框里，这一笔就算被圈住了。
   比"整笔必须完全落在里面"符合直觉得多：手写时很少有人能一笔不越界地圈住东西，
   按"完全包含"来判，用户会觉得"我明明框住了它却没选上"。 */
function strokeHitsRect(stroke, r) {
  for (const p of toPoints(stroke.points)) {
    if (p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1) return true
  }
  return false
}

/* 一组笔迹的包围盒（世界坐标）。选中之后画那个虚线框要用它。 */
function strokesBBox(strokes) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of strokes) {
    for (const p of toPoints(s.points)) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null
}

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
