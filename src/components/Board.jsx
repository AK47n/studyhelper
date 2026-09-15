import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BoardCanvas from './BoardCanvas.jsx'
import WritingPad, { OcrSettings } from './WritingPad.jsx'
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
  HL_COLOR, HL_WIDTH,
  buildRelations, descendantsOf, fitView, inkedEdges, newCard, newStroke, parseBoardDocument,
  screenToWorld, serializeBoardDocument, simplifyPoints, strokeHitsCircle, toFlat, toPoints, zoomAt,
} from '../lib/board.js'
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
  const [size, setSize] = useState({ w: 0, h: 0 })
  /* 手写公式：写字板、设置弹层的开关。
     写字板是"另开一块地方写"，不是"圈住白板上的字去识别" —— 理由见 WritingPad.jsx 顶部。 */
  const [padOpen, setPadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
  const inkPairs = useMemo(() => {
    const set = new Set()
    for (const e of inkedEdges(board)) set.add(e.a + '|' + e.b)
    return set
  }, [board])
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

      /* ① 笔杆侧键按着 → 开始框选（OneNote 那个手感）。
         必须放在"擦"和"画"前面：按住笔杆键落笔时，不该在板上留下墨迹。 */
      if (isPenBarrel(e)) {
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
         放在画/擦前面，是为了"点空白"既取消选中、也照常落笔，不用点两次。 */
      if (inkSel) setInkSel(null)

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
    [tool, color, width, localPoint, eraseAt, trackPointerKind, inkBox, inkSel]
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
        const s2 = Math.min(6, Math.max(0.15, st.view.s * k))
        const kk = s2 / st.view.s
        // 全部换算成"相对画布容器"的坐标（和 tx/ty 同一个基准）
        const cx0 = st.mid.x - rect.left
        const cy0 = st.mid.y - rect.top
        const cx1 = mid.x - rect.left
        const cy1 = mid.y - rect.top
        // 锚点：开始时两指中点下的那个世界点，缩放后还要落在**现在的**中点下
        setView({
          s: s2,
          tx: cx1 - (cx0 - st.view.tx) * kk,
          ty: cy1 - (cy0 - st.view.ty) * kk,
        })
        return
      }

      if (panRef.current) {
        const lp = localPoint(e)
        setView((v) => ({
          ...v,
          tx: panRef.current.tx + (lp.x - panRef.current.lp.x),
          ty: panRef.current.ty + (lp.y - panRef.current.lp.y),
        }))
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
        const ids = boardRef.current.strokes.filter((s) => strokeHitsRect(s, box)).map((s) => s.id)
        setInkSel(ids.length ? new Set(ids) : null)
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
        commit((cur) => ({ ...cur, strokes: [...cur.strokes, { ...d.stroke, points: toFlat(simple) }] }))
      } else if (d.kind === 'erase' && tool !== 'eraser') {
        /* 这一次是**笔的另一头**在擦，抬笔就把那个橡皮圈收掉。
           （工具是橡皮的时候不能收 —— 那个圈得一直跟着鼠标，当光标用。） */
        setEraserAt(null)
      }
    },
    [commit, tool]
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
      if (e.key === 'Escape') {
        setSelectedId(null)
        setEditingId(null)
        setInkSel(null)
        return
      }
      if (e.key === 'p' || e.key === 'P') return setTool('pen')
      if (e.key === 'e' || e.key === 'E') return setTool('eraser')
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
  }, [undo, redo, setView, selectedId, commit, variant, inkSel, deleteInkSel])

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
  }

  const stageProps = {
    sceneRef, liveRef, view: board.view, size,
    strokes: board.strokes, relations, cardById,
    cardsForInk: inkPairs, selectedId, hoverEdge, eraserAt,
    onPointerDown, onPointerMove, onPointerUp,
    lasso, inkBox, onDeleteInk: deleteInkSel,
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
    <RelationPanel
      board={board}
      relations={relations}
      inkPairs={inkPairs}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onHoverEdge={setHoverEdge}
      onFocus={(id) => {
        const c = cardById.get(id)
        const el = wrapRef.current
        if (!c || !el) return
        const v = boardRef.current.view
        setView({ ...v, tx: el.clientWidth / 2 - (c.x + c.w / 2) * v.s, ty: el.clientHeight / 2 - (c.y + c.h / 2) * v.s })
      }}
    />
  )

  const toolbar = (
    <Toolbar
      tool={tool} setTool={setTool}
      color={color} setColor={setColor}
      width={width} setWidth={setWidth}
      onWriteFormula={() => setPadOpen(true)}
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

  return (
    <div className={'bd variant-' + variant + (fullscreen ? ' bd-fs' : '')}>
      <div className={'bd-stagewrap' + (penMode ? ' nocursor' : '')} ref={wrapRef}>
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
    </div>
  )
}

// ────────────────────────────── 卡片 ──────────────────────────────

function Card({ card, selected, dimmed, editing, view, onSelect, onStartEdit, onStartDrag, onCommit, onCloseEdit, onDrag, onDragEnd, onDelete }) {
  const dragRef = useRef(null)
  const taRef = useRef(null)
  const [draft, setDraft] = useState('')
  const isFormula = card.kind === 'formula'

  useEffect(() => {
    if (!editing) return
    setDraft(isFormula ? card.src || '' : card.text || '')
    const raf = requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(raf)
  }, [editing, isFormula, card.src, card.text])

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
      onCommit({ text: draft })
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
    body = card.text ? <div className="bd-note">{card.text}</div> : <div className="bd-card-empty">双击写字</div>
  }

  return (
    <div
      className={'bd-card' + (isFormula ? ' is-formula' : ' is-note') + (selected ? ' on' : '') + (dimmed ? ' dim' : '') + (editing ? ' editing' : '')}
      /* ★ 位置用 JS 算，不用 CSS transform。公式就是世界坐标那一个映射：
             屏幕 = 世界 * s + t
         四个数（left/top/width/字号缩放）一起算，缩放才能"整体一致地"变小 ——
         只缩 left/top 不缩字号，卡片会一边跑到正确位置、一边保持原来的大小。 */
      style={{
        left: card.x * view.s + view.tx,
        top: card.y * view.s + view.ty,
        width: card.w * view.s,
        minHeight: card.h * view.s,
        /* 字号和内边距也按缩放走，卡片才是"整体一致地"变大变小。
           只缩 left/top/width 而不缩字号，卡片会跑到正确的位置却保持原来的大小。 */
        '--bd-card-scale': view.s,
        padding: `${10 * view.s}px ${12 * view.s}px`,
        borderRadius: Math.max(3, 10 * view.s),
      }}
      onPointerDown={(e) => {
        if (editing) return
        e.stopPropagation()
        onSelect()
        onStartDrag?.()
        dragRef.current = { x: e.clientX, y: e.clientY, moved: false }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (!d || editing) return
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
        onStartEdit()
      }}
      title="拖动挪位置 · 双击改内容 · Delete 删掉"
    >
      {body}
      {selected && !editing && (
        <button
          className="bd-card-del"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="删掉这张"
        >
          ×
        </button>
      )}
    </div>
  )
}

const SNIP_KEYS = ['frac', 'sqrt', 'sup', 'sub', 'mu0', 'pi', 'cdot', 'int', 'sum', 'vec']
const SNIP_LABEL = { frac: 'a/b', sqrt: '√', sup: 'xⁿ', sub: 'xₙ', mu0: 'μ₀', pi: 'π', cdot: '·', int: '∫', sum: 'Σ', vec: '向量' }

/* Tex 搬去了 ./Tex.jsx（手写识别也要用它，留在这儿会绕出循环依赖）。 */

// ────────────────────────────── 工具条 ──────────────────────────────

function Toolbar({ tool, setTool, color, setColor, width, setWidth, onWriteFormula, onUndo, onRedo, canUndo, canRedo, onFit, onZoom, scale, onScale, onScaleReset, dirty, fullscreen, onToggleFullscreen }) {
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

function RelationPanel({ board, relations, inkPairs, selectedId, onSelect, onHoverEdge, onFocus }) {
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
  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty)
  drawStroke(ctx, stroke)
}
