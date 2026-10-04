import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { katexHtml } from '../lib/renderMath.js'
import BoardCanvas from './BoardCanvas.jsx'
import { Card, CardItem } from './BoardCard.jsx'
import { FormulaShelf, Hint, Toolbar } from './BoardBar.jsx'
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
/* 笔和纸长什么样（颜色 / 粗细 / 纸面）在 lib/skin.js —— Board.jsx 和工具条那一排
   按钮都要用，所以两头都不许自己留一份。 */
import { COLORS, DEFAULT_PAPER, PAPERS, PAPER_KEY, SHELF_KEY, WIDTHS } from '../lib/skin.js'
import { CARD_FONTS, CARD_MIN_H, DEFAULT_CARD_FONT, HL_COLOR, HL_WIDTH, fontCss, newId, nextCardScale, newCard, newStroke, parseBoardDocument, serializeBoardDocument, textCardRect } from '../lib/board.js'
/* 资料（铺在画布上的 PDF/PPT，见 docs.js 的文件头）：常量与几何在那边只有一份；
   页面的拉取/渲染在 doc-pages.js；两层界面在 DocLayer.jsx。 */
import { DOC_DEFAULT_W, DOC_ID_PREFIX, pageRects } from '../lib/docs.js'
/* ⚠ `pageTextItems`（只有速查在用）也在这儿：同一份 PDF 的打开/缓存只有一处记账
   （doc-pages.js 的 getDoc），谁再自己 require 一次 pdf.js 都会多一本冷却不了的日志。 */
import { pageTextItems, readDocInfo } from '../lib/doc-pages.js'
import { pickWord } from '../lib/doc-words.js'
import { richHtml } from '../lib/rich.js'
import { DocBars } from './DocLayer.jsx'
import DeckReview from './DeckReview.jsx'
import BoardHelp from './BoardHelp.jsx'
/* 框选追问（2026-09-22）：页边那个问答小窗。**不碰板** —— 见 AskBox.jsx 的文件头。 */
import AskBox from './AskBox.jsx'
/* 速查（2026-09-28）：上课突然不懂的那个词。**同一条规矩：不碰板** ——
   见 QuickLook.jsx 的文件头；它和 AskBox 的区别是"快"，不是"能不能改我的板"。 */
import QuickLook from './QuickLook.jsx'
/* 作业辅导（2026-09-22）：说清作业在哪一份 PDF、报"第几页第几题"，每题要一份
   「答案 + 说人话的解析」。**同样不碰板** —— 见 HomeworkBox.jsx 的文件头。
   ⚠ 它和「课件整理」是两件事：整理是老师讲他的（一页一遍、贴到板上），
     辅导是老师做**你的**题（你点哪几道就哪几道，答案浮在窗里、板上一个字节不动）。 */
import HomeworkBox from './HomeworkBox.jsx'
/* 「这本书有几百页，我只要那几页」—— 问页码的小窗（2026-09-21）。
   ⚠ 它是浮层那一族的新成员（回车 / Esc 关），所以这两个键不许漏到画布上去。 */
import DocPagePicker from './DocPagePicker.jsx'
/* 「只抽这几页」：一本几百页的书，做几道题用不着整本传（来龙去脉写在 doc-slice.js）。 */
import { SLICE_ASK_MIN, openLocalPdf, sliceFileName } from '../lib/doc-slice.js'
/* 作业辅导那颗按钮上的字、以及"本地服务没重启"那句提示 —— 都只有一处（homework.js）。 */
import { HW_BUTTON } from '../lib/homework.js'
/* 课件整理（2026-09-22 立；2026-09-20 换成"老师讲解"）：把资料的每一页交给模型讲一遍，
   讲解贴右边、重点和公式贴左边。
   ⚠ 这个文件里**不解析模型的话、也不摆版** —— 那两件事在 doc-cards.js（纯函数、有自检）；
     渲染那一趟在 doc-read.js。这里只做三件本地的事：量尺寸、摆版、写盘。 */
import { SIDE_W, cardText, columnOccupancy, makeMeasureHost, measureDeck, pageGapDeltas, pagesLabel, planAnswerCard, projectDeck, shiftLaterPageCards } from '../lib/doc-cards.js'
/* 整节课那一层（提纲 + 做题须知）那一半：判据（`isDeckLevel` / `SUMMARY_KIND` / `RULES_KIND`）
   和它们自己的摆位（`placeDeckCard` —— 两张**共用同一个摆位函数**，一上一下排开）。
   **它们不在 doc-cards.js 里** —— 那一份是"一页一课"的，整节课那两张是"一节课一张卡"，
   两件事的字段、文案、摆位没有交集（见 doc-summary.js 的文件头）。
   ⚠ 分半的判据永远用 `isDeckLevel`，别在这里写 `kind === 'summary'` / `kind === 'rules'`
     字面量（那两个是**条目层**的 kind；而且散开的字面量会让"再加一张整节课的卡"
     必须改好几处 —— 漏掉一处的后果见下面 `placeDeckCards` 那段注释）。 */
import { RULES_KIND, SUMMARY_KIND, isDeckLevel, placeDeckCard } from '../lib/doc-summary.js'
/* 框选追问（2026-09-22）：你圈的那一块**落在课件的哪一页、页内哪个位置**（纯函数，
   `check:ask` 在 node 里钉着它）。渲染那两张图在 ask-images.js，界面在 AskBox.jsx。
   `normalizeAsk` / `serializeAsk` 是**存进板文件**的那个字段（卡片的 `ask`，见 ADR-0006）。 */
import { docForPath, findAskRegion, normBox, normalizeAsk, regionToWorld } from '../lib/ask-region.js'
/* 「留到板上」（ADR-0006）：追问 / 作业里那一轮问答 → 一张卡的内容。
   正文那一半住在 answer-cards.js（两个窗各自调 `askThreadText` / `homeworkText`），
   这一层只要 `answerItem`（它把内容包成量尺寸 / 摆版认的那个条目）。 */
import { ASK_MARK_GLYPH, answerItem } from '../lib/answer-cards.js'
/* 点 / 几何 / 关系搬去了 geometry.js（2026-09-16 架构 review 的 C5）；
   板框的几何（成员包围盒 + 内边距 / 框选命中）2026-09-17 也进了那儿。 */
import { buildRelations, descendantsOf, fitView, fitViewIn, frameBounds, membersInBox, simplifyPoints, strokeBounds, strokeHitsCircle, toFlat, toPoints } from '../lib/geometry.js'
/* 卡片「按内容量尺寸」那一套规矩（什么时候量得准、什么时候算稳定、门槛多少）搬去了
   card-fit.js —— 从前它锁在这个文件里，自检够不着（见那个文件的文件头）。 */
import { createCardFitter } from '../lib/card-fit.js'
/* 连接读法（reader / 墨迹块 / 形状判据 / 各种阈值）搬去了 links.js。 */
import { createLinkReader } from '../lib/links.js'
/* 选中这一族（框住的笔意味着什么 + 你对它说的那几句话）搬去了 selection.js：
   改词 / 反向 / 留下板框 / **整块缩放旋转** 的规矩都在那儿，
   纯函数、有断言（`transformPick` 是"把框住的这一撮东西当一个整体动一下"的唯一入口）。
   ⚠ 「这个条件不算 / 条件就是它」那三个写入口（`vetoCond` / `specCond` / `clearCond`）
     还躺在那个 module 里，但**界面入口已经没有了** —— 它们唯一的脸就是关系面板，
     而那块面板删掉了（见文件末尾「关系面板删掉了」那段）。 */
import {
  applyStrokeLink, clearCond, freezeFrameSelection, readSelection, removePick, specCond, transformPick, vetoCond,
} from '../lib/selection.js'
/* 板框 / 连接这两个概念的**动作**（留下 / 加进来 / 改标题 / 拆开 / 整体挪 / 删掉连接 /
   吸附到最近的卡片或板框）在 frames.js —— 和 selection.js 一个路子：纯函数、有断言。见 ADR-0001。 */
import { declareLink, dissolveFrame, removeLink, setFrameTitle, setLinkKind, snapNode, translateFrame } from '../lib/frames.js'
/* 关系的词表在 link-kinds.js（board.js 不再转发）。 */
import { ARROW_LINK, LINK_DELETE, LINK_KINDS, linkKind } from '../lib/link-kinds.js'
/* 「？问这里」那颗按钮上的字、以及"本地服务没重启"那句提示 —— 都只有一处（followup.js）。
   ⚠ 文件名叫 followup 不叫 ask：`ask` 那个名字被「询问框」占了（App.jsx 的 Ask、check:ask）。 */
import { ASK_BUTTON } from '../lib/followup.js'
/* 视图映射（屏幕 = 世界 × s + t）只有一份实现，在 view.js 里 ——
   从前这句公式在这两个组件里被手抄 14 处、canvas 变换写两份、捏合还复制了一份
   （于是"导出的那份有自检、手指走的是复制品"）。现在浮层位置、canvas 变换、
   滚动/捏合/平移/居中全走这里。 */
import { applyViewTo, clampViewScale, combinedScale, panBy, screenLenToWorld, screenToWorld, viewCorrection, worldLenToScreen, worldToScreen, zoomAt, zoomBetween } from '../lib/view.js'
/* 撤销账本（一次手势 = 一步撤销）在 history.js —— 四条手势从前各自手记一次账、
   "算不算动过"四个判据（架构 review 候选 3）。现在只说 begin / during / end。 */
import { createHistory } from '../lib/history.js'
import { displayTex, snippetFor, toTex } from '../lib/formula.js'
/* 公式架（2026-09-20）：这张板上**已经认过一次**的公式收成一条随手可取用的架子。
   它是**推出来的**（由板上的公式卡汇总、按公式去重），不新增任何存盘字段 —— 规矩在
   lib/formula-shelf.js 的文件头，用户原话也在那儿。 */
import { shelfItems } from '../lib/formula-shelf.js'
/* "那颗词摆哪"（浮层锚点别跑出画布、别压到底部工具条）是一条**屏幕像素的政策**，
   单独一个文件 —— 和上面那条映射是两件事（2026-09-17 架构 review 候选 1 的尾巴）。 */
import { chipPlacement } from '../lib/chip-placement.js'
/* 焦点仲裁（"现在焦点在谁身上"是一个值、按键该谁管是纯函数）在 focus.js 里 ——
   从前它是四个 useState + 二十处 ad hoc 的互斥 if + 一串按键 if（候选 7）。 */
import {
  FOCUS_NONE, clearInkFocus, deleteIntent, editingCardId, editingFrameId, endEdit, escapeIntent,
  focusCard, focusCardId, focusFrame, focusFrameId, focusInk, focusInkCards, focusInkBox, focusInkIds, isTextField,
} from '../lib/focus.js'
/* 复制 / 粘贴（框住一块 → 装进剪贴板 → 落到**任何一块板**上）在 clipboard.js：
   "只装内容不装关系"、"落点用相对偏移"、"粘贴出来一律是新 id" 三条规矩都在那儿，纯函数、有断言。 */
import { copySelection, isPayload, pastePayload, payloadCount } from '../lib/clipboard.js'
/* 常用形状规整（画个圆 → 变成真正的圆）在 shapes.js —— 纯几何，不碰界面。
   ★ 它和 ADR-0001 砍掉的"形状判读"是什么关系，写在那个文件的**第一段注释**里，
     动手改之前先看那一段（那里也写着这条功能的铁律：宁可认不出来，也不许认错）。 */
import { recognizeStrokes, regularizeStrokes } from '../lib/shapes.js'
/* 图形对象那一族（"认出来之后怎么缩放/旋转/重开还在"）——
   和上面 `shapes.js` 是两件事，见那个 module 的文件头。
   ★ 2026-09-21 之后这里只剩**问句**：`shapeName`（形状的人话名字）、
     `oppositeCorner`（拖一个角时不动的是哪一个点）、`translateShape`（整体平移一笔）。
     "怎么变"（`scaleShape` / `rotateShape` / `retargetStroke`）整个搬进了
     selection.js 的 `transformPick` —— 因为现在**任意一撮笔迹和卡片**都能变，
     而变换的规矩只该有一份（两份的话，图形那一份迟早和这一份对不上）。 */
import { oppositeCorner, shapeName, translateShape } from '../lib/shape-object.js'

/* 剪贴板在 localStorage 里的键名。**跨窗口靠的就是它** ——
   改这个名字等于"另一个开着的白板页读不到你刚复制的东西"，所以要改就连文档一起改。 */
const CLIP_KEY = 'studyhelper.clip.v1'

/* 白板：打开就能画的那一屏。没有文件名要起、没有格式要学。
 *
 * 三条约定的取舍，写在这里，免得以后自己推翻自己：
 *
 * ① **笔是主角，键盘是配角。** 默认工具永远是笔。输入框只在你要写公式/文字时出现，
 *    出现即聚焦、Enter 收、Esc 走。
 * ② **关系不用你填。** 你画的位置就是关系（见 lib/board.js 的 buildRelations）。
 *    想让它是确定的，就在两张卡之间画一条线 —— 位置猜出来的只是猜测，那条线是你说的话。
 *    （从前有一块右侧面板把这些逐条列出来，2026-09-19 整块删掉了。）
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
/* 「板安静多久才算安静」——给**那颗「◯ 规整」按钮的判读**用的（不是量尺寸那一条：
   量尺寸的安静判据在 `card-fit.js` 的 `FIT_IDLE_MS`）。
   为什么单有一个数：形状判读是 O(框住的笔数 × 每笔拟合)，而它在拖动中每一帧都会
   白跑一遍（见下面 `shapeHits` 那一段）。240ms 的取法：比"手停下来的感觉"略短，
   又明显长于两次 pointermove 的间隔（60fps 是 16.7ms），所以拖动中它永远不会触发。 */
const SHAPE_SETTLE_MS = 240
/* 「手势算停了没有」—— 缩放/平移期间卡片层收起来（`.bd.gesting`），停手多久之后放回来。
   取 200ms 的**实测依据**（2026-09-21 第十一刀，用户："越修越卡"）：
   · 真人的滚轮/触摸板是**一阵一阵**的：实测一串 3 个事件挤在 16ms 内、隔 140ms 再来一串。
     原来是"最后一个事件之后一帧"就放回来 → 每一串之间卡片闪一下、下一串再收走
     （实测 2 秒里收放 10~11 次），而"收/放"本身要全量重排一次 —— 净收益是负的
     （Layout 总量 1298ms vs 闸摘掉 1294ms），换来的只有屏幕上闪。
   · 200ms > 一串滚轮的间隔（140ms）→ 连着滚时它一直收着，那笔钱才真的省下来；
     又短到人不会觉得"卡片卡住了"。
   ⚠ 别把它调成"一帧"或 0：那就是"每串之间闪一次"那个病。
   ⚠ 也别调到半秒以上：手势停了卡片还不回来，看起来像丢了东西。 */
const GEST_LINGER_MS = 200
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

/* 画出一条连接线之后，那排词在屏幕上停多久（毫秒）。
 * 3.5 秒的来历：比你抬笔看一眼再决定要长一点，又不至于一直挂在那儿碍事。
 * 指针停在那排词上时不会收（LinkChips 的 onPointerEnter）。 */
const LINK_PICK_MS = 3500

/* ── 触屏上"按住不放" = 查这个词（Surface 没键盘时的那条路，2026-09-28）──────
 * 600ms 的来历：明显长于"点一下"（触屏上一记 tap 是 100ms 上下），
 *   又短于"让人觉得它在卡"（超过一秒手指就开始怀疑了）。
 * ⚠ 这两个常量**不要写在 Board 组件里**：它们必须和 `armPress` 一样是常量，
 *   而写在组件里每渲染一次就新建一个对象/值 —— 定时器读到的是拿一次性的问题
 *   还好说，真正的问题是它们会漏进依赖数组，而"每帧重绑手势"正是最难查的那一类错。 */
const LOOK_PRESS_MS = 600
/* 手在这 600ms 里允许挪动的范围（px）。手指按住是会抖的，一点余量都不给的话
 * 这个手势等于没有 —— 但也不能太宽，否则"按住拖一下"（平移/框选）会被误判成长按。 */
const LOOK_PRESS_SLOP = 10

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

export default function Board({ file, initialText, reloadToken, onSave, flash, scale, onScale, onScaleReset, fullscreen, onToggleFullscreen, onGatherNote }) {
  const [board, setBoard] = useState(() => load(initialText, file))
  const [tool, setTool] = useState('pen')
  /* 「?」帮助浮层（2026-09-26）。不进板文件、不进 localStorage —— 开着看一眼就关的东西。 */
  const [helpOpen, setHelpOpen] = useState(false)
  const [color, setColor] = useState(COLORS[0].v)
  const [width, setWidth] = useState(WIDTHS[1])
  /* ── 焦点：**一个值**（2026-09-17 架构 review 候选 7）────────────────────────
     从前是四个 useState（`selectedId` / `inkSel` / `selectedFrameId` / `editingId` /
     `frameEditId`），而"它们互斥"这条不变量没人写下来 —— 靠二十处 ad hoc 的 if 维持
     （"选卡片要清板框""选板框要清卡片""点空白清三个""Esc 清另一个子集"…），
     Delete 的含义甚至是一个表达式 `selectedFrameId && !inkSel && !selectedId`。
     现在互斥是**结构**的：一个记录只有一种 kind（`src/lib/focus.js`）。
     下面五行是"读"那一侧 —— 界面各处照旧问这几个名字，行为一个字没改。 */
  const [focus, setFocus] = useState(FOCUS_NONE)
  const selectedId = focusCardId(focus)
  const selectedFrameId = focusFrameId(focus)
  const editingId = editingCardId(focus)
  const frameEditId = editingFrameId(focus)
  const inkSel = useMemo(() => {
    const ids = focusInkIds(focus)
    return ids ? new Set(ids) : null
  }, [focus])
  const [dirty, setDirty] = useState(false)
  const [hist, setHist] = useState({ undo: 0, redo: 0 })
  const [paper, setPaper] = useState(readPaper)
  /* 公式架开着还是收着。和纸面同一条理由：**这是"我习惯怎么看这张板"**，
     不是这张板的内容 —— 所以存 localStorage，不进 board-*.md（默认收起）。 */
  const [shelfOpen, setShelfOpen] = useState(readShelfOpen)
  const [eraserAt, setEraserAt] = useState(null)
  /* 用笔写字时把鼠标光标收掉 —— 笔尖底下一直跟着一个十字，写字时很碍眼。
     但**不能简单粗暴地 cursor:none**：那样鼠标也会一起没光标，画布上就没法定位了。
     所以记着"最近一次是谁在操作"：笔 → 藏，鼠标 → 显示。
     penModeRef 是为了只在真的换了设备时才 setState —— 每次 pointermove 都 set 会白重渲染。 */
  const [penMode, setPenMode] = useState(false)
  const penModeRef = useRef(false)
  const [lasso, setLasso] = useState(null) // 正在拖的那个框（世界坐标，已经规范化成 x0<x1 / y0<y1）
  /* ★ 正在"整体缩放 / 旋转"（手指按在选区手柄上）。它只影响**怎么画**，不影响数据：
     给卡片挂一个合成器提示（`.bd.xforming .bd-card`，见 styles.css 那一段）——
     卡片不带提示时，`transform` 每变一次都要**重新光栅化整张卡**，
     而大字号公式卡（KaTeX 一大坨 span + 一圈模糊阴影）面积大、画起来贵，
     转起来就是一顿一顿的。见 README 第 53 条。 */
  const [xforming, setXforming] = useState(false)
  /* ★★ 手势进行中（2026-09-21 第十刀；第十一刀改成"停手 200ms 才放回来"）——
     缩放/平移/捏合那一小段时间里，把卡片层整个从**布局**里摘出去
     （`.bd.gesting .bd-cardworld`，见 styles.css 那一段）。
     为什么非做不可、以及"停手 200ms"这个口径是怎么量出来的：
     见下面 `markGesticulating` 顶上那一段（那里有实测数字）。
     一句话：卡片可见那一路，60 帧连滚要花 930ms 的样式失效 + 155ms 的布局；
     摘掉之后分别掉到 ~100ms / ~20ms。代价是手势期间看不见卡片。 */
  const [gesting, setGesting] = useState(false)
  const gestingRef = useRef(false)
  const gestTimerRef = useRef(null)
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
  /* 工具条那一层（`.bd-cbar`）。只用来量它浮在画布上占了多高 ——
     "装回屏幕"得把那一段从可用高度里扣掉，见 fitForView。 */
  const cbarRef = useRef(null)
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
  /* ⚠ 这里原来有一个 `lastLassoRef`（"框选刚结束的那个框"）——
     「留下板框」和「复制」靠它现算"这次框选圈到了哪几张卡"。
     2026-09-21 删掉了：卡片现在**自己就进选区**（`sel.cardIds`，见 focus.js 的
     `focusInk(ids, cards)`），所以"框住了什么"只有一份答案，不用再拿一个矩形回头去猜。
     它当年还踩过一个真 bug（README 第 48 条 / 自检抓到的那条）：
     那个 ref 写下去之后**没有任何地方清它**，于是"框住 → Esc → Ctrl+C"
     会复制出上一次框住的那张卡。现在 Esc 一按，卡片跟着选区一起没了。 */
  /* 板框整体拖动的起点：{ id, before }（before = 按下那一刻的板，松手时进撤销栈）。 */
  const frameDragRef = useRef(null)
  /* 剪贴板的内存镜像（跨窗口那份在 localStorage，见 CLIP_KEY）。
     为什么两处都放：localStorage 可能被禁用 / 配额满（隐私模式），
     那种时候**本次会话内**复制粘贴还得能用 —— 这里就是那个兜底。 */
  const clipboardRef = useRef(null)
  /* 箭头工具那一次划动：{ from: 世界点, to: 世界点 }。
     它是**一次性的手势**（画完就回笔、纸上不留墨）—— 见 ADR-0001。 */
  const arrowRef = useRef(null)
  /* ★ 手势里"最新算出来"的视图（2026-09-18，修用户报的"卡片相对滑动"）。
     为什么不能只用 React 的 `view`：那个值是**上一次渲染时**的，而手势每一帧
     都算出了更新的。
     有了它，`syncViewCorrection()` 就能在手势回调里**同步**把差值补上去。
     一致性：每次 setView 都跟着更新它（见 `setView`）。 */
  const liveViewRef = useRef(null)
  /* ★★ 补正的**基准** = "两层**已经画出来**的那一版视图"（2026-09-18 第二版）。
     屏幕上真正被画出来的那一帧里，墨迹用的是哪个视图？**最近一次 canvas 重绘用的那个**
     （`BoardCanvas` 画完之后把它写在这里）。补正表达的就是"从这一版到 live 还差多少"，
     所以基准必须是它，不能是别的两个候选 —— 三个值各差一步，用错就是把偏差翻倍：
       · `liveViewRef`   —— 手指刚算出来的（最新，还没画）
       · `drawnViewRef`  —— **画出来了的**（基准，正确）
       · `boardRef.current.view` —— 提交了但**还没重渲染**的（第一版用的就是它：
         算出来的差多算了整整一步 pointermove，而 React 紧接着用新视图重渲染卡片，
         于是那一份差在屏幕上被**做了两遍** ⇒ 卡片冲出 2 倍的距离，下一帧才收回去。
         取证：`node scripts/diag-pan.js` —— 判据是**绝对位置**；
         `check:pan` 原来那条"两点间距"对平移不敏感，所以看不见这个错。）
       · `board.view`     —— React 这一趟渲染用的（和 drawnViewRef 只差"画没画完"）
     它在 `BoardCanvas` 把墨迹画完之后、由那个 layout effect 更新（**绘制之前**），
     所以"补正 + 新位置"叠在一起的那一帧一次都不会被画出来。 */
  const drawnViewRef = useRef(null)
  /* 上一次写进 DOM 的那条补正串（含 `null` = 没有补正）。
     为什么记它：`syncViewCorrection` 每次提交都被叫一次，而绝大多数提交
     （选中、改内容、量尺寸……）跟视图无关 —— 没有这道闸的话，每一趟都要
     querySelector + 又写又删 transform，白制造样式重算（平移时每帧都跑）。 */
  const corrRef = useRef(null)
  /* 上一次写进 DOM 的那四个诊断数（见 syncViewCorrection）。
     同一条规矩：它们写在 `.bd-world` 上，而 `.bd-world` 是**整棵卡片子树的祖先**
     —— 每帧无条件写 4 个 dataset，等于每帧让浏览器把子树里所有"属性选择器"
     重匹配一遍（板上有 3 万节点时这笔钱看得见）。值没变就一个字节都不写。 */
  const diagRef = useRef(null)

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
  /* ★★ 量尺寸自己写的那次板变化，**不算"板变了"**（2026-09-21 第十一刀）。
     为什么非要有这个 ref：`commit` 会换掉 `board.cards` 的引用，而下面那条
     "板安静下来自己再量一次"的 effect 盯的正是这个引用 —— 于是量尺寸每提交一次
     就把**全队公式卡重新排上一遍**。一张收敛慢的卡（实测用户那张板上有一张每趟
     缩 2px、要十来趟）就足以让它变成一台不停转的机器：每次提交 → 400ms 防抖 →
     125 张卡全量一遍 → 又提交 → 再来。实测空转 5 秒 523 次 data-fit（≈ 每秒一整趟）。
     判据是"这次板变化是不是我自己写的"：是就咽下不排。
     ⚠ 用户在编辑器里改完内容那条路不受影响 —— 那条走 `editing-ended` 和
       **用户自己**的 commit（不经过这个计数器）。 */
  const fitWriteRef = useRef(0)
  const fitter = useMemo(
    () =>
      createCardFitter({
        sample: (id, opts) => sampleCardForFit(id, opts),
        commit: (id, patch) => {
          fitWriteRef.current++
          commit((c) => ({ ...c, cards: c.cards.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), false)
        },
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
     采的都是**世界像素**，而且必须来自**同一瞬间**的布局：卡片的宽度和内容的高度
     要是来自不同的渲染帧，算出来的尺寸就是错的（那正是第 17 条那个坑）。

     ★★ 为什么是世界像素（2026-09-21 第十一刀，用户那句"越修越卡"）：
       卡片自从按世界坐标渲染（`width: card.w`，缩放交给 `.bd-cardworld` 那一层
       transform），这里读到的就**已经是**世界像素 —— `offsetWidth` / `offsetHeight`
       是**布局值，不受祖先 transform 影响**（这正是不用 getBoundingClientRect 的原因，
       见下面那条）。
       而 card-fit.js 当时还在按"屏幕像素"折（`card.w × s`）—— 两边只在 s=1 时相等，
       别的档位每张卡每帧都判 'stale'，于是拟合器每帧把全板卡片重量一遍（实测用户那张板
       空转 1 秒 2625 次）。所以：**这里采什么档，card-fit.js 就按什么档判**，
       现在的口径是"世界像素进、世界像素出"，`s` 不许出现在这一族里。 */
  function sampleCardForFit(id, opts = {}) {
    const cur = boardRef.current.cards.find((c) => c.id === id)
    if (!cur) return { state: 'gone' } // 卡片已经从板里没了
    const wrap = wrapRef.current
    const cardEl = wrap ? wrap.querySelector('[data-card-id="' + id + '"]') : null
    if (!cardEl) return { state: 'missing' } // 还没挂上，下一帧再来
    if (cardEl.classList.contains('editing')) return { state: 'wait' } // 编辑态量不得
    const el = cardEl.querySelector('.bd-card-body')
    if (!el) return { state: 'missing' } // 还没挂上，下一帧再来
    /* ★ 卡片**不在布局里**就量不得（2026-09-21 第十一刀）：手势期间整个卡片层是
       `display:none`（`.bd.gesting`），这时候 offsetWidth 是 0 —— 量它只会得到
       "DOM 没跟上"（'stale'）而白烧重试次数，最后把这张卡判成 'gave-up'。
       卡片回来的时候 `markGesticulating` 那条定时器会补一趟 kick()。 */
    if (cardEl.offsetWidth === 0 && Number(cur.w) > 0) return { state: 'wait' }

    /* 内边距 + 边框（世界像素）：这个仓库全局是 `box-sizing: border-box`，
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
      /* ★★ 量的是**布局尺寸**（offsetWidth/offsetHeight），不是 `getBoundingClientRect()`。
         2026-09-21 卡片能旋转之后这一条变成硬要求：`getBoundingClientRect()` 返回的是
         **变换之后**的外接框 —— 一张转过 30° 的卡，量出来的宽高是它斜着那个大框，
         于是 fitPass 会拿这个虚高的数去改 `w`/`h`（卡片会越转越胖，而且**存进文件**）。
         `offsetWidth/offsetHeight` 是布局值，和 transform 无关（四舍五入到整数，
         而 fitPass 的门槛是 1.5 世界像素，够用）。
         ⚠ 它同时也**不带视图缩放** —— 这就是为什么这一族全是世界像素。 */
      domW: cardEl.offsetWidth,
      bodyH: el.offsetHeight,
      padX,
      padY,
    }
    if (opts.fitWidth) {
      /* 自然宽度：临时把宽度放开成 `max-content` 读一次（折行内容量不出自然宽），
         读完立刻还原 —— 同一帧里读回，屏幕上看不出来。 */
      const prev = el.style.width
      el.style.width = 'max-content'
      snap.naturalW = el.offsetWidth
      el.style.width = prev
      /* 还要把"已经溢出的那部分"算进去：字体没就绪时 max-content 可能偏小，
         而溢出量（scrollWidth − clientWidth）任何情况下都准。两个取大的那个当需求。 */
      const tex = el.querySelector('.bd-tex')
      snap.spillPx = tex ? Math.max(0, tex.scrollWidth - tex.clientWidth) : 0
      snap.texClientW = tex ? tex.clientWidth : 0
    }
    return snap
  }

  /* ── 撤销 / 重做：账本的事（空栈时它自己返回 false，不抛、不改板）。 ─────────
   *
   * ★★ 撤销外面**多包了一层**，只有一件事要做：让"收笔自动规整"记住
   *    "这一步是你退掉的，别再自动做一遍"（见下面 `runAutoShape` 那段的长注释）。
   *    ⚠ 判据必须在**退掉的那一刻**读，不能在渲染之后读：
   *      退掉之后 `boardRef` 立刻是旧版，而 React 的重渲染晚一步；
   *      等到 effect 里再比，"哪一笔是被退掉的"就看不出来了
   *      （板已经变回旧版，和"用户自己画成那样"长得一模一样）。
   *    ★ 只记**形状消失/变了**的那些笔：判据是"退之前有 shape、退之后没有了"。
   *      按住 Ctrl+Z 连退好几步时，每一步都各自记自己的 —— 不需要"撤销了几步"这个数
   *      （那个数在这里没有意义，而且账本也不报）。 */
  const suppressAutoRef = useRef(new Set())
  const snapshotShapes = () => {
    const m = new Map()
    for (const s of boardRef.current.strokes) if (s.shape) m.set(s.id, s.shape)
    return m
  }
  const noteUnshaped = (before) => {
    for (const [id, shape] of before) {
      const cur = boardRef.current.strokes.find((s) => s.id === id)
      if (!cur || !cur.shape) {
        suppressAutoRef.current.add(id)
        continue
      }
      /* 形状还在、但**参数变了**也记一笔：那是"用户把某一步退掉了"的另一种样子
         （比如规整之后又拖动/缩放过，退一步回的是上一个尺寸）。 */
      if (cur.shape !== shape) suppressAutoRef.current.add(id)
    }
  }
  const undo = useCallback(() => {
    const before = snapshotShapes()
    const r = ledger.undo()
    noteUnshaped(before)
    return r
  }, [ledger])

  const redo = useCallback(() => {
    /* 重做**不用**记：重做回来的是"你之前接受过的那一版"，
       而它身上带着 shape（账本存的是整个板对象）—— 恢复原样正好是对的。 */
    return ledger.redo()
  }, [ledger])

  /* 改视野。注意 pin 参数：
     - pin=true  你亲手平移/缩放了 → 记下来，下次打开照用（"我看到哪了"是你的意图）
     - pin=false 是程序自己适配的（打开时装进屏幕）→ 不记，下次重新算
     这样容器一变（换摆法、改字号、改窗口大小），自动适配的视野会自己跟过去，
     而你亲手定的那条只在你真的定过之后才生效。 */
  /* ★ 把"还差多少"同步补上去（2026-09-18，修"卡片和板框相对于字滑动"）。
   *
   * ── 屏幕上为什么会有"差" ──────────────────────────────────────────────
   * 同一个视野，板上有**两组**东西各自去够它，到达时间不一样：
   *   · 墨迹 / 连线（canvas + SVG `<g>`）：`ctx.setTransform` / `transform` 属性，
   *     **上一次 effect 那一趟**画的；
   *   · 卡片 / 板框（DOM）：`left/top` 由 React 的 style prop 给，要等
   *     setState → render → commit → style recalc + layout，**再晚一步**。
   * 手势每动一下，两组各差一步 —— 那就是用户看到的相对滑动。
   *
   * ── 补的是什么 ────────────────────────────────────────────────────────
   * 一个 CSS 变换，把**还没画出来**的那部分差（`live` 相对 `drawn`）贴在
   * **两组东西共同的那些层**上：`.bd-world`（卡片 + 板框）、两层 canvas（墨迹）、
   * 两层 SVG（连线 / 词 / 尖）。于是这一帧里所有东西都落在 `live` 上，
   * 等 React 和 canvas 各自追上来，差变成 0、属性被移除。
   *
   * ★★ 为什么**墨迹也要贴**（第一版只贴了 `.bd-world`，那是半截修法）：
   *   只补卡片那一半的话，两边还是差一步 —— 只是把"卡片快一帧"换成了"墨迹慢一帧"，
   *   肉眼看还是滑动。**把 `drawn` 当基准、两组一起补，它们才真的同帧。**
   *   （这也是为什么基准不能是 `boardRef.current.view`：那个值是 commit 里同步改的，
   *    比"画出来了的"多走一步，拿它当基准等于把差算成两步 —— 卡片冲出 2 倍距离。
   *    详见 `drawnViewRef` 那段和 `node scripts/diag-pan.js`。）
   *
   * 为什么必须在这里同步写、不能放进 useEffect：
   *   effect 是在 commit **之后**跑的，那时如果 canvas 已经重画完、差就是 0 了 ——
   *   补正什么都补不到。要补就得在"新值已经算出来、屏幕上还是旧的"这一刻补，
   *   也就是**手势回调里**。收尾那一半在 `BoardCanvas` 画完之后（它调 `onViewDrawn`）。
   *
   * 谁来收尾：canvas 用新视野重画完（同一个 commit 里，绘制之前），差自然变成 0，
   *   那时会把这条 transform 清掉（不写 'none'，直接移除，少留一个合成层）。
   *   所以它是**过渡量**，不是一个长期偏移。
   *   ⚠ 别把它改成"直接把 live 的 tx/ty 写上去" —— 那才是老注释警告的
   *     "把同一次平移做两遍"，东西会整体偏掉。这里表达的是**两者的差**。
   *
   * ⚠ 贴在这些层上的是**位置**，不是"它们自己声明的变换"：canvas 内部那份
   *   `setTransform` 归 `applyViewTo` 管，两边互不干扰（外层的 CSS 变换是给
   *   "还没重画的那一版位图"补位）。缩放时它会把位图拉伸一下 —— 那一帧本来就是
   *   过渡帧，下一帧就重画好了。 */
  const worldRef = useRef(null)

  /* 把补正那个**纯函数**挂到 window 上（诊断 / 自检用，和 `canvas.dataset.xform`
     同一族）。为什么需要：补正是个过渡量，修好之后寿命常常不到一帧，
     按固定节奏采样**采不到**它 —— 于是"补多少才对"这件事在浏览器里没法断言，
     而它正是出过 bug 的地方（基准取错 ⇒ 差算成两步 ⇒ 卡片冲出 2 倍距离）。
     自检拿它直接验公式：`corrFor(50, 60)` 必须是 `translate(10px, 0px) scale(1)`。 */
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__viewCorrection = viewCorrection
    return () => {
      delete window.__viewCorrection
    }
  }, [])

  /* 把这几个"跟着视野走"的层收成一份：`.bd-world`（卡片 + 板框）用 ref，
     其余（两层 canvas + 两层 SVG）用 `data-view-follow` 找 —— 它们在
     BoardCanvas 里声明自己，这里不用再维护一张平行的 ref 清单
     （清单一定会漏，而漏掉的那一层就是继续滑动的那一层）。

     ── ★★ 找一遍就记住（2026-09-25）──────────────────────────────────────
     `syncViewCorrection` 每帧要它两次（手势里一次、墨迹画完一次），
     而 `querySelectorAll` 是在**整个舞台子树**（大板 3 万节点）里跑属性选择器 ——
     探针实测 70ms / 60 帧，是优化之后剩下最大的一笔单项 JS。
     这几层是**声明在那儿就不动**的（BoardCanvas 三层 + DocLayer 一层），
     所以查一次存起来；什么时候失效由下面那个 MutationObserver 说了算
     （层被挂载/替换/卸载 → 缓存作废），另外每一趟都验一遍"还在文档里"。
     ⚠ 失效那条路必须留着：缓存要是认不出"新来了一层"，新层就吃不到补正
       —— 而"漏掉的那一层"正是这一族最怕的那个错。 */
  const followCacheRef = useRef(null)
  const viewFollowNodes = useCallback(() => {
    const out = []
    if (worldRef.current) out.push(worldRef.current)
    const stage = wrapRef.current
    if (!stage) return out
    let nodes = followCacheRef.current
    if (!nodes || nodes.some((n) => !n.isConnected)) {
      nodes = [...stage.querySelectorAll('[data-view-follow]')]
      followCacheRef.current = nodes
    }
    out.push(...nodes)
    return out
  }, [])

  /* 上面那份缓存的失效闸：舞台里**结构**一变（层挂上来、摘掉、换掉）就作废。
     ⚠ 只听 childList —— 补正自己写的是 style，不会反过来把缓存冲掉
       （那样每帧都失效，缓存就白做了）。 */
  useEffect(() => {
    const stage = wrapRef.current
    if (!stage || typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => {
      followCacheRef.current = null
    })
    mo.observe(stage, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  /* ══════════ 手势降级：卡片层"收起来"，屏幕刷新率归操作 ══════════
   *
   * 谁调它：**每一次视图变化**（setView）。连着滚就是一直续期，
   * 停手 GEST_LINGER_MS 之后才把卡片放出来。
   *
   * 为什么非做不可（实测，用户那张 213 张卡 / 3 万节点的板）：
   *   卡片层已经改成"世界坐标 + 一层 transform"，语义上确实不用重排 ——
   *   但 Chromium 仍然要为**变换的元素树**走一趟几何遍历 + 样式失效：
   *   实测 60 帧连滚，卡片可见那一路 RecalcStyle 941ms（帧中位 50ms）；
   *   把这一层 `display:none` 掉，掉到 35ms（帧中位 **16.7ms，满帧**）。
   *   （探针 `npm run perf:cost` 的 [1]/[4] 两组，以及 `perf:zoom`。）
   *   代价是手势期间**看不见卡片**（白板上是课件、墨迹、连线）——
   *   这是拿"看得见卡"换"手感"，用户 2026-09-21 报的就是手感（"放大缩小的时候有点卡"）。
   *
   * ★★ 为什么是"停手 200ms"而不是"最后那个事件之后一帧"（2026-09-21 第十一刀）：
   *   原来这里走的是"等真正的屏幕刷新"（rAF 之间隔 ≥6ms 就放出来）—— 实际效果是
   *   **最后一个事件之后一帧**就把 3 万个节点放回布局。而真人的滚轮/触摸板是
   *   **一阵一阵**的（实测节奏：3 个事件挤在 16ms 内，隔 140ms 再来一串）：
   *   每一串之间那一帧卡片就"啪"地回来、下一串再收走 —— 于是缩放时卡片**一闪一闪**，
   *   而"收/放"这个动作本身又要全量重排一次（那正是这个闸本来要省掉的那笔钱）。
   *   实测：一串一串地滚 2 秒，卡片收放 **10~11 次**（可见性翻转 20 次），
   *   而 Layout 总量和"闸摘掉"几乎一样（1298ms vs 1294ms）——
   *   也就是说旧口径下这个闸**一点钱都没省下**，只换来屏幕上闪。
   *   判据改成"停手 200ms"之后：连着滚 → 全程收着（省下那笔钱）；
   *   停手 → 200ms 后放回来一次（不闪）。
   *   ⚠ 200ms 这个数：比一串滚轮的间隔（实测 140ms）长，比"我以为你停手了"的手感短。
   *
   * ⚠ 放回来之后要**补一趟量尺寸**：手势期间卡片不在布局里，`offsetWidth` 是 0，
   *   拟合器那一趟只能判 'wait'（见 sampleCardForFit 里那条）—— 卡片回来了才有得量。
   */
  const markGesticulating = useCallback(() => {
    if (!gestingRef.current) {
      gestingRef.current = true
      setGesting(true)
    }
    if (gestTimerRef.current) clearTimeout(gestTimerRef.current)
    gestTimerRef.current = setTimeout(() => {
      gestTimerRef.current = null
      gestingRef.current = false
      setGesting(false)
      /* 卡片回到布局里了 —— 手势期间量不得的那几张现在量得上。 */
      fitter.kick()
    }, GEST_LINGER_MS)
  }, [fitter])

  /* 卸载时把那个定时器撤掉（换板 / 关页的路上不留活着的定时器）。
     ⚠ 定时器是 setTimeout 不是 rAF：后台标签页里 rAF 会停，卡片层就会一直藏着
       （屏幕上像"卡片没了"）。setTimeout 在后台只是被降频到 ~1s —— 照样会放回来。 */
  useEffect(
    () => () => {
      if (gestTimerRef.current) clearTimeout(gestTimerRef.current)
    },
    []
  )

  /* ★★ 补正唯一的入口：**算多少、写到哪儿**。
     · 基准（drawn）= 屏幕上**已经画出来了**的那一版视图（见 `drawnViewRef`）；
     · 目标（live） = 手指刚算出来的那一版；
     · 差写成一条 CSS 变换，贴到**所有跟着视野走的层**上（`viewFollowNodes`）。
     两个调用时机：
       · 手势回调里（`setView`）—— 在"新值算出来了、屏幕上还是旧的"这一刻同步补上；
       · canvas 按新视野重画完之后（`onViewDrawn`）—— 差变成 0，属性被撤掉。
     ⚠ 定义顺序要紧：下面 `setView` / `onViewDrawn` / `clearViewCorrection`
       都引用它，而 `const` 在初始化之前是 **TDZ** —— 提前引用会在挂载时当场
       `ReferenceError: Cannot access '…' before initialization`，整个白板白屏
       （2026-09-18 真踩了一次）。这一族的先后必须是：本函数 → onViewDrawn →
       clearViewCorrection → setView。 */
  const syncViewCorrection = useCallback(() => {
    const live = liveViewRef.current
    /* 基准 = 已经画出来的那一版。没画过（首帧）就退回"已提交的那一版"，
        那只是为了别算出 null 来 —— 首帧上两者本来就是同一个数。 */
    const drawn = drawnViewRef.current || boardRef.current.view
    const tf = live && drawn ? viewCorrection(drawn, live) : null
    /* ★ 把这两个数写在 DOM 上（诊断用，和 `canvas.dataset.xform` 同一族）。
       为什么值得占两行：补正是个**过渡量**（寿命常常不到一帧），
       自检按固定节奏去采样多半采到"没有补正"，于是"补正对不对"这件事
       根本断言不到 —— 而它正是用户报的那条 bug。
       有 `data-drawn-tx` 就能**反过来验**：屏幕上摆着的那一版（drawn）
       必须等于当前视图（live）；两者不等就说明补正该在而没在。
       2026-09-18：这一族数字是"把补正做成可观测"的唯一办法，别删。 */
    const w = worldRef.current
    if (w) {
      /* ★ 只在**真的变了**的时候写（2026-09-25）：这四个数是给自检看的，
         而写在 `.bd-world` 上就等于每次都让整棵子树重匹配属性选择器。
         手势里它们每帧都变（照写），别的时候大多数帧根本没变（不写）。 */
      const lt = String(live ? live.tx : '')
      const ls = String(live ? live.s : '')
      const dt = String(drawn ? drawn.tx : '')
      const ds = String(drawn ? drawn.s : '')
      const prev = diagRef.current
      if (!prev || prev.lt !== lt) w.dataset.liveTx = lt
      if (!prev || prev.ls !== ls) w.dataset.liveS = ls
      if (!prev || prev.dt !== dt) w.dataset.drawnTx = dt
      if (!prev || prev.ds !== ds) w.dataset.drawnS = ds
      diagRef.current = { lt, ls, dt, ds }
    }
    /* 只在**真的变了**的时候动 DOM（见 corrRef 的说明）。 */
    if (corrRef.current === tf) return
    corrRef.current = tf
    for (const el of viewFollowNodes()) {
      if (tf) el.style.transform = tf
      else el.style.removeProperty('transform')
    }
  }, [viewFollowNodes])

  /* ★★ 补正的收尾：`BoardCanvas` 把墨迹按新视野画完之后叫这一下
     （它在自己的 layout effect 里画，**浏览器绘制之前**）。
     此刻"画出来了的"就是这一版，差变成 0 → 所有层上的属性被移除，
     一切回到"位置完全由 left/top 和 canvas 变换决定"的常态。

     ⚠ `liveViewRef` 也要跟着落到这一版：不然下次手势里 `syncViewCorrection`
       会拿"上一轮的目标"当基准重算一遍，白补一次。
     ⚠ 必须由 canvas 那一趟来叫，**不能**在 Board 自己的 effect 里猜"React 已经
       提交了所以卡片到位了" —— 卡片确实到位了，可墨迹还是旧的，两边照样差一步。 */
  const onViewDrawn = useCallback(
    (view) => {
      drawnViewRef.current = view
      liveViewRef.current = view
      syncViewCorrection()
    },
    [syncViewCorrection]
  )

  /* 把补正**清掉**，并把基准认到当前这一版。
     ★ 为什么用笔之前必须清：`paintLive` 是按**屏幕坐标**反算世界坐标再画的，
       而那一层 canvas 上正挂着一条非单位的 CSS 变换 —— 笔迹会整体画歪一个
       "还差的量"。写字和"看板子怎么动"是两件事，写字这条路宁可不要补正。
     ★ 为什么清得掉：按下笔的那一刻 `boardRef.current.view` **就是**屏幕上
       已经画出来的那一版（手势刚结束、或者本来就没在动），所以差是 0。
       清完之后两层 canvas 的变换都是单位阵，和 `paintLive` 的假设一致。 */
  const clearViewCorrection = useCallback(() => {
    onViewDrawn(boardRef.current.view)
  }, [onViewDrawn])

  /* 改视野。注意 pin 参数：
     - pin=true  你亲手平移/缩放了 → 记下来，下次打开照用（"我看到哪了"是你的意图）
     - pin=false 是程序自己适配的（打开时装进屏幕）→ 不记，下次重新算
     这样容器一变（换摆法、改字号、改窗口大小），自动适配的视野会自己跟过去，
     而你亲手定的那条只在你真的定过之后才生效。 */
  const setView = useCallback(
    (v, pin = true) => {
      const next = typeof v === 'function' ? v(boardRef.current.view) : v
      /* 先记下"要去的视图"再提交：`commit` 内部是函数式更新，等它跑的时候
         已经不好拿到这个值了。补正用的就是这个和**已经画出来的那一版**的差。 */
      liveViewRef.current = next
      /* ★ 视图一动 = 手势开始（滚轮/捏合/平移全走这里）—— 把卡片层收起来，
         屏幕刷新率全归这一件事（见上面「手势降级」那一段）。
         ⚠ 放在 `syncViewCorrection` **之前**：先让 DOM 少掉一大块，再谈补正。 */
      markGesticulating()
      syncViewCorrection()
      commit(
        (cur) => ({ ...cur, viewPinned: pin ? true : cur.viewPinned, view: typeof v === 'function' ? v(cur.view) : v }),
        false
      )
    },
    [commit, syncViewCorrection, markGesticulating]
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
    /* 换了一份板 → 焦点整块归零（从前只清 selectedId / editingId，上一张板留下的
       "框选中 / 墨迹选中"会跟着过来 —— 换成焦点值之后顺手没了，这是这一刀买到的）。 */
    setFocus(FOCUS_NONE)
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
        /* ★ 也要按字号档折算（见上面那段说明）：不然字号档一大，
           "开窗就是卡片探出画布、右边那颗 × 点不到"。
           ⚠ 这里读的是**渲染期的 `scale`**，而 use 在 raf 里 ——
             字号档是 App 级状态、开板那一刻不会同时在变，不存在读到旧值的窗口。
             真撞上了，下一帧重装/改窗口也会按新 `--s` 纠回来。 */
        commit((cur) => ({ ...cur, view: fitForView(el.clientWidth, el.clientHeight) }), false)
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

     ⚠ 正在编辑的那张会挂起来等（card-fit.js 的 'wait'）。
     ⚠ 量尺寸**自己**写的那次变化要跳过（`fitWriteRef`）—— 不然它会把自己重新排上，
       于是一张收敛慢的卡就能让全板永远在量（见那个 ref 上面的一段）。 */
  useEffect(() => {
    if (fitWriteRef.current > 0) {
      fitWriteRef.current = 0
      return
    }
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
     拆开）、`sel.box`（那个虚线框 —— 现在把框进来的卡片也圈住）、`sel.strokes` / `sel.cards`（选中的那些东西）——
     这几件事从前是这里一堆 useMemo，现在收成 `readSelection` 一次读
     （规矩和来历见 src/lib/selection.js 的文件头）。
     判据都在那个 module 里：集合完全相等才算"这个框"、正好一条才算"这条线"。 */
  const inkCards = useMemo(() => focusInkCards(focus), [focus])
  /* ★ `inkBox` 是"我圈了哪一块地方"的那个矩形 —— 框里没笔时它是**唯一**留着这件事的东西
     （见 focus.js 的 `focusInk` 与 selection.js 的 `box`）。 */
  const inkBox = useMemo(() => focusInkBox(focus), [focus])
  const sel = useMemo(() => readSelection(board, inkSel, links, inkCards, inkBox), [board, inkSel, links, inkCards, inkBox])
  /* 框住的卡片（一个 Set，给"整体拖动"那条路用）。和 `inkSel` 一个形状，
     所以下面"整组拖着走"那一段两半写起来是对称的。 */
  const cardSel = useMemo(() => new Set(sel.cardIds), [sel.cardIds])

  /* ══════════════════ 框选追问：你圈的那一块落在课件的哪一页 ══════════════════
   *
   * 用户 2026-09-22：「现在的痛点在于即使有讲解仍然有没理解的地方……直接用框选，
   * 框中的地方是有疑问的地方并且可以询问这是为什么」。
   *
   * ★ "这一块在第几页"**必须**由几何算出来，不能让用户选页号 ——
   *   他圈的就是他看不懂的地方，让他再去说一遍"这是第 7 页"是多余的动作，
   *   而且会说错。规矩在 `ask-region.js`（纯函数，`check:ask` 钉着）。
   * ★ 为什么在这里算、而不是在 AskBox 里算：AskBox 是**不碰板**的（它连 board 都
   *   拿不到），而"哪一页"要用 board.docs + 选区几何。分工和 shapeHits 一样：
   *   **判断住在 Board，界面只显示**。
   *
   * ═══ 2026-09-21 修正：圈住的是课件，不是自己的字迹 ═══════════════════════
   * 用户原话：「我框选的肯定是 ppt 上的一部分或者解说卡片啊，我不可能框选我自己的字迹，
   * 但是他要求必须框选字迹，这个就有问题了」。
   *
   * 一针见血。这条链路从「框选」那套机制里借了**选区**（`sel`），而选区的主语一直是
   * **笔迹**（`readSelection` 的 `ids` 就是笔的 id）：于是"框里有没有笔"变成了
   * "能不能问"的隐含前提，而追问要问的恰恰是**课件上那一块**——
   * 用户圈的是 PPT 里那个他看不懂的符号，跟他自己写没写字毫无关系。
   * 症状很具体：圈住课件空白处（或者整页扫一下）→ 什么都框不到 → `strokesBBox` 是
   * null → 按钮灰着 → 点了一下说「框里没有课件页面」，而那句话是**错的**
   * （圈里明明就是课件）。
   *
   * ⇒ 判据改成"**框有多大**"，不是"框里有多少笔"：
   *   几何取**框选那个矩形本身**（`sel.box`，就是屏幕上画出来的那个虚线框）。
   *   圈住课件 = 有矩形 = 能问；圈住的地方正好压着课件页 = 问得到。
   *   笔迹和卡片都**不再是必要条件**（有也照常，矩形会把它们圈进去）。
   *   ⚠ 用 `sel.box` 而不是 `strokesBBox`：两者在"框里只有卡片"时就不一样了
   *     （`pickBox` 把卡片的可视外接框也并进来，而卡片是能放大旋转的）。
   *     这一处**只能有一份** "我圈的是哪一块" 的答案 —— 屏幕上那个虚线框画的就是
   *     `sel.box`（见下面传给 BoardCanvas 的 `inkBox`），拿别的形状去问，
   *     问出来的地方和用户看到的那一圈会对不上。
   */
  const askRegion = useMemo(() => {
    const docs = board.docs || []
    /* 板上没有课件 → 这件事无从谈起（按钮会是灰的）。这一步先挡掉，
       免得每一帧都去扫一遍页面矩形。 */
    if (!docs.length) return null
    /* ⚠ 判据是**框本身的尺寸**，不是 `sel.ids.length`。
       `sel.box` 同时是"框选"和"整组拖着走"共用的那个框（`pickBox`），
       所以它天然就是"我圈的那一块"。null = 没框选过 / 框是空的。 */
    const norm = sel.box ? normBox({ x0: sel.box.x0, y0: sel.box.y0, x1: sel.box.x1, y1: sel.box.y1 }) : null
    if (!norm) return null
    /* ⚠ `cards` 也要给它：讲解卡摆在页面**旁边**（不压在页面上），圈住它时只有
       "卡上写着它在讲第几页"这条路能认出来（ask-region.js 的第 ② 条路）。 */
    return findAskRegion({ box: norm, docs, cards: board.cards })
  }, [board.docs, board.cards, sel.box])

  /* 小窗开着时的状态：圈的是哪一页 / 页内哪一块 / 出生时摆在屏幕哪儿。
     ⚠ anchor 是**开窗那一刻**算的屏幕坐标（像素），之后不再跟着视野走 ——
       小窗是"浮在看板上的一张纸条"，跟手指一起跑反而看不清（见 AskBox 的文件头）。 */
  const [ask, setAsk] = useState(null)

  /* ══════════════════ 速查（2026-09-28）：上课突然不懂的那个词 ══════════════════
   *
   * 用户原话："学生上课时可能突然需要知道一个词是什么意思，那么他需要询问有地方
   *   快速的帮他解决"，并且点明了要"既可以查我写的也可以查 ppt 上的"。
   *
   * ── ★ 为什么在这**一层**接线（不像作业那个窗几乎自己管自己）────────────────
   *   从课件上挑出那个字需要两样只有 Board 手上有、拿不到就**无从算起**的东西：
   *     ① 铺在画布上的那几份资料和它们的页面矩形（`board.docs` + `pageRects`）；
   *     ② 当前视野（`view`），用来把"屏幕上点了一下"翻译成"第几页的第几个字"。
   *   ⇒ QuickLook 于是可以很薄：只管显示和发请求，和监督 AskBox 一样**碰不到板**
   *     （ADR-0006）。"答案会不会污染我的板"这件事在这一族里从来没有例外。
   *
   * ── 两条进来的路，各对应他点明的半个需求 ──────────────────────────────────
   *   ① **双击课件上的字** → `pageTextItems` 取出带坐标的字、`pickWord` 挑一个候选。
   *      这条路是"查 ppt 上的"。
   *   ② **Ctrl+K 手打** → 这条路是"查我写的"。为什么手写那半个只能是手打：
   *      纸上的字在被识别成卡片之前，在画布上就是一撮**笔迹**（xy 点串），
   *      机器读不出它是什么词 —— 要读得先付一次识别的钱，而那恰好违背这个功能
   *      "三秒内"的立意。所以这条路他自己打，而写了一手的笔记可以以"上下文"带过去。
   */
  const [look, setLook] = useState(null)
  /* ⚠ Ctrl+K 那个挂在 window 上的监听要读"现在开没开"，但不能把 `look` 放进
     依赖数组（窗开着的每一秒 `look` 都在变：改一个词就得重新绑一次监听）。
     用 ref 镜像一份，和下面 `toggleShelfRef` 同一条路。 */
  const lookRef = useRef(null)
  const toggleLookRef = useRef(null)
  useEffect(() => {
    lookRef.current = look
  }, [look])

  /* "这门课叫什么" —— 它同时是给模型的语境、也是缓存的那一半键。
     ⚠ 判据是**资料所在的那一层目录**（`data/信号与系统/lec3.md` → `信号与系统`），
       不是文件名：一门课有一打的笔记，用 "lec3" 当键的话每一份都会错过上一次的缓存，
       而"同一个词反复查"正是这个功能最该省下的那笔钱（见 lookup.js 文件头）。 */
  const lookContext = useMemo(() => {
    const parts = String(file || '').replace(/\\/g, '/').split('/').filter(Boolean)
    const base = (parts.pop() || '').replace(/\.md$/i, '')
    const dir = parts.pop() || ''
    return dir || base
  }, [file])

  /* 世界坐标 → 落在哪份资料的哪一页、页内的归一化位置。
     ⚠ 几何一律走 `pageRects`（docs.js 里只有那一份），这里不再自己推一遍 ——
       "页面摆在哪"已经有了唯一答案，再推一遍就是两处各算一遍（必错其一）。 */
  function docPointAt(world) {
    for (const d of boardRef.current.docs || []) {
      const rects = pageRects(d)
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects[i]
        if (!(world.x >= r.x && world.x <= r.x + r.w)) continue
        if (!(world.y >= r.y && world.y <= r.y + r.h)) continue
        return { doc: d, page: i + 1, x: r.w ? (world.x - r.x) / r.w : 0, y: r.h ? (world.y - r.y) / r.h : 0 }
      }
    }
    return null
  }

  /* 开窗。（`cx/cy` 是**客户端坐标**，没有值时摆在视野上半部分 —— Ctrl+K 用的那一路。）
     ⚠ 位置用**屏幕坐标**、不用世界坐标：它是"浮着瞄一眼"的东西，
       平移/缩放不该把它带走（这一族和公式架、询问框同一条规矩，
       而"板上不存屏幕坐标"那条规定说的是**卡片**，不是这种看完就走的浮层）。
     ⚠ 最后交给 `chipPlacement` 夹回视野内 —— 浮出来的东西跑到屏幕外、
       或者压在底部工具条底下，用户就点不到了（缩放柄、连接词那一族踩过好几遍的坑）。 */
  const openLook = useCallback(
    (seed, cx, cy) => {
      const el = wrapRef.current
      const w = (el && el.clientWidth) || 800
      const h = (el && el.clientHeight) || 600
      const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0 }
      const raw = cx == null ? { x: w / 2 - 170, y: Math.round(h * 0.16) } : { x: cx - rect.left + 16, y: cy - rect.top + 18 }
      setLook({
        /* ★ `key` 带上词和时间：**换一个词 = 换一个窗**。不换的话输入框里那段字、
           已经查回来的那几条会跟着搬到新词下面 —— 那正是最难查的一类错
           （界面把它当成"上一次的续集"，而用户要的是一次新的查）。 */
        key: `${Date.now()}:${(seed && seed.term) || ''}`,
        seed: { term: '', line: '', context: lookContext, ...(seed || {}) },
        at: chipPlacement(raw, { w, h }),
        doc: (seed && seed.doc) || null,
      })
    },
    [lookContext]
  )

  /* Ctrl+K：开着就收走（同一个键管开关），没开就带上"此刻可能想要的那个词"。
     ⚠ 预填的判据是他**此刻高亮的那几个字**（window.getSelection），不是去猜哪张卡 ——
       选区是他自己说出来的"就是这个"；而"此刻该问哪张卡上的哪个词"没有依据可猜
       （仓里那条规矩：猜的东西必须摆明让他改，不能假装自己知道）。 */
  const toggleLook = useCallback(
    (cx, cy) => {
      if (lookRef.current) {
        setLook(null)
        return
      }
      let picked = ''
      try {
        const s = typeof window.getSelection === 'function' ? window.getSelection() : null
        picked = String((s && s.toString()) || '').trim().slice(0, 40)
      } catch {
        picked = ''
      }
      openLook(picked ? { term: picked } : {}, cx, cy)
    },
    [openLook]
  )
  toggleLookRef.current = toggleLook

  /* ★ 从"屏幕上这一点"挑出一个词 —— **双击**和**长按**共用这一份（2026-09-28）。
     抽出来的理由：两条路做的是同一件事，各写一份的话"这一页读不出来怎么办"
     这种判断迟早只改一处（这个仓库那条账：同一个东西两处实现必错其一）。
     返回 null 表示"这儿挑不出词" —— 双击/长按在课件空白处、或者这一页是张扫描图
     （图片资料，`pageTextItems` 返回 null）时都是这个结果，那种情况**一律不给反应**：
     弹出一个空窗会让人以为自己点中了什么。 */
  async function lookWordAt(clientX, clientY) {
    const el = wrapRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const world = screenToWorld(clientX - rect.left, clientY - rect.top, boardRef.current.view)
    const hit = docPointAt(world)
    if (!hit) return null
    let items = null
    try {
      items = await pageTextItems(hit.doc.path, hit.page)
    } catch {
      items = null /* 这一页读不出来（坏 PDF / 扫描页）时当"这儿没有字"，不是一个崩溃 */
    }
    if (!items || !items.length) return null
    const got = pickWord(items, hit.x, hit.y)
    if (!got || !got.term) return null
    return { term: got.term, line: got.line, doc: { path: hit.doc.path, page: hit.page } }
  }

  /* 双击课件上的字 → 速查。
     ⚠ 挂在 `.bd-stagewrap`（画布最外层）上，而不是塞进 DocLayer 里面：资料那一整层
       是 `pointer-events: none`（笔要能写在 PPT 上，这是这个应用立身的那一条），
       指针事件只能从下面这一层收。
     ⚠⚠ 而且必须是 **Capture**（这个结果是实测出来的，不是猜的，2026-09-28）：
       第一下按下去就已经生成一个选区了，而选区的**手柄正好垫在鼠标底下**
       ⇒ 第二下按的是手柄（`dblclick` 的 target 是 `.bd-pickhandle`），
       而手柄上挂着 `stopPropagation`（BoardCanvas 里那句"双击别落到纸上"）——
       写在冒泡阶段的话这个事件**永远到不了这里**，而界面上唯一看得见的是
       工具条那句「框太小了」，谁也想不到是双击这条路断在这儿。
       捕获阶段是从外面往里走 ⇒ 手柄那句拦不住它。
     ⚠ 也正是这一条让上面那个 `closest(...)` 车闸成为必需：捕获阶段什么都看得见，
       于是"双击一张卡"也会被它看见 —— 那些有 owner 的东西得自己让开（见下面）。
     ⚠ **只在真的挑出一个词的时候才开窗**：双击在课件空白处、或者这一页是张扫描图
       （图片资料，`pageTextItems` 返回 null）时一律不给反应 ——
       弹出一个空窗会让人以为自己点中了什么。
     ⚠ 笔还握在手上时（`tool !== 'select'`）不开窗：双击会顺手留下两撮墨点，
       而他多半只是想把笔挪一下。那时候给一句人话，把正确的手势教给他。 */
  async function onStageDoubleClick(e) {
    /* ★★ 双击**已经有别人在管的东西不算**：双击一张卡是"改这张卡的字"、
       双击板框上那个名字是"给这一节起名" —— 它们都自带 handler，
       这里不能顺手再开一个窗（卡片摆在课件页面上的时候，一次双击会变成两件事）。
       ⚠ **手柄不在这份名单里**，这一点是刻意的：框选工具下第一下按下去就会生成一个零宽选区，
       而它的手柄正好垫在鼠标底下 ⇒ 第二下按到的就是手柄（实测：target 是 `.bd-pickhandle`）。
       手柄只是"别让双击取消选中"，它并不拥有双击这件事 ——
       把它算进来的人，第一次"双击课件上的字"就永远叫不出来。 */
    const t = e.target
    if (t && t.closest && t.closest('.bd-card, .bd-docbar, .bd-frame-t')) return
    const got = await lookWordAt(e.clientX, e.clientY)
    if (!got) return
    if (tool !== 'select') {
      flash('查词：先点工具条上的「⬚ 框选」，再双击课件上的字（握着笔的时候双击会在纸上留下两个墨点）', 'ok')
      return
    }
    openLook(got, e.clientX, e.clientY)
  }

  /* ── ★★ 没有键盘的那半边（2026-09-28，用户问的原话：「surface 没键盘的时候
     怎么摁这些快捷键」）────────────────────────────────────────────────────
     原先那两条进来的路**都要键盘、或者要手快**：
       · Ctrl+K —— 平板上没有 Ctrl，为了它去接一个外接键盘，正是用户不想做的事
         （他的老规矩见 BoardBar 里「⧉ 粘贴」那条注释）；
       · 双击 —— 触屏上确实能用，但浏览器认"双击"的判据是**两次点击落在半秒之内**，
         手指和笔做不到那么准，而老师已经在讲下一句了。
     ⇒ 补一条**按住不放**：手指或笔停在课件那个词上别动，就当他要查这个。
       这是触屏上唯一不要求"又快又准"的输入，也最接近课堂上的真实动作
       （愣了一下、手指就停在那个词上了）。
     ⚠ 只对 touch / pen 启用：鼠标那边双击和 Ctrl+K 都好好的，
       给鼠标加长按只会让"按住拖一下"多出一个误触源。
     ⚠ 手指一动就把定时器掐了：平移画布、框选、翻页划动，全都长得像"按下 + 移动"，
       所以"没动"是长按判据的一部分。
     ⚠ 取词仍然走上面那个 `lookWordAt` —— 手势各不相同，怎么挑词只有一处说话。 */
  const pressRef = useRef(null)
  function cancelPress() {
    const p = pressRef.current
    pressRef.current = null
    if (p && p.timer) clearTimeout(p.timer)
  }
  async function pressLook(x, y) {
    const got = await lookWordAt(x, y)
    if (!got) return
    openLook(got, x, y)
  }
  function armPress(e) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
    if (tool !== 'select') return
    const t = e.target
    if (t && t.closest && t.closest('.bd-card, .bd-docbar, .bd-frame-t')) return
    cancelPress()
    const x = e.clientX
    const y = e.clientY
    const timer = setTimeout(() => {
      pressRef.current = null
      pressLook(x, y)
    }, LOOK_PRESS_MS)
    pressRef.current = { x, y, timer }
  }
  /* ⚠ 一律走**捕获阶段** —— 手柄、卡片上的 `stopPropagation` 会把手势掐死在半路上
     （双击那条就是这样断过一次的，上面那段就是当时的现场记录）。 */
  const onStagePointerDownCapture = (e) => {
    trackPointerKind(e)
    armPress(e)
  }
  const onStagePointerMoveCapture = (e) => {
    trackPointerKind(e)
    const p = pressRef.current
    if (!p) return
    /* 动了就不算"按住"。10px 是留给手抖的：没人能在触屏上一动不动，
       而 600ms 里偏个两三个像素是常事。 */
    if (Math.abs(e.clientX - p.x) > LOOK_PRESS_SLOP || Math.abs(e.clientY - p.y) > LOOK_PRESS_SLOP) cancelPress()
  }

  /* 「⬇ 留到板上」的兑现：
     · 这个词是**从课件上双击来的** ⇒ 贴到那一页旁边，走 `keepAnswer`
       （这一页多占的那点空、后面那些页要跟着挪，全是那一套，同一件事只有一处代码）；
     · 是 **Ctrl+K 手打的** ⇒ 板上没有它对应的一页，"贴在那页旁边"这句话说不出来
       （"旁边"要有东西才叫旁边），那就摆在**视野中央** —— 和手写识别落成卡片同一个地方。
     ⚠ 下面这一段看着像把 keepAnswer 抄了一遍，其实只有"摆在哪"这件事是新的：
       量尺寸（`measureDeck` + `deckCardNodes` + `richHtml` + `SIDE_W`）、
       卡上的字（`cardText`）、包成它认的那个条目（`answerItem`）都是同一个函数，
       刻意不去动 keepAnswer 里那套 pageGaps / shiftLaterPageCards ——
       它没有一页可对齐，硬塞一个 `at` 参数进去会把它搅成两种语义混在一个函数里。 */
  function keepQuick({ made, doc } = {}) {
    if (doc && doc.path && Number(doc.page) > 0) {
      return keepAnswer({ docPath: doc.path, page: Number(doc.page), made, from: 'look' })
    }
    const item = answerItem('keep1', made)
    if (!item) {
      flash('这一条是空的，没什么可留的', 'warn')
      return false
    }
    const host = makeMeasureHost(wrapRef.current)
    let sized
    try {
      sized = measureDeck({
        items: [item],
        renderTex: deckCardNodes,
        renderRich: richHtml,
        host,
        s: boardRef.current.view.s || 1,
        fixedW: SIDE_W,
      })
    } finally {
      if (host.parentNode) host.parentNode.removeChild(host)
    }
    const sz = sized.sizes.get(item.id)
    if (!sz) {
      flash('这张卡量不出尺寸（公式排不出来？）—— 没能贴上去，换个问法再试', 'warn')
      return false
    }
    const c = stageCenterWorld()
    const fresh = {
      ...newCard('note', 0, 0),
      x: Math.round(c.x - sz.w / 2),
      y: Math.round(c.y - sz.h / 2),
      w: sz.w,
      h: sz.h,
      text: cardText(item),
      rich: true,
      answer: true,
    }
    commit((cur) => ({ ...cur, cards: [...cur.cards, fresh] }))
    fitter.queue(fresh.id, { fitWidth: false })
    flash('留在板上了：摆在你正看着的这一屏中央 —— 点「↶ 撤销」（或 Ctrl+Z）能退，拖到哪儿随你', 'ok')
    return true
  }

  /* 板变了之后，小窗指着的那一页 / 那一块可能已经没了（换了板、把课件移掉了、
     删了资料）。这时候**自己收掉**，而不是让一个指着空气的窗留着。
     判据：拿出生时那份页内矩形（region）反算世界矩形，再看它还在不在同一页上 ——
     这样连"课件被拖走了"也认得出（矩形不重合了，说明它指的是别处）。 */
  const askSig = board.docs && board.docs.length ? board.docs.map((d) => d.id + ':' + d.x + ':' + d.y).join(',') : ''
  useEffect(() => {
    if (!ask) return
    const d = (boardRef.current.docs || []).find((x) => x.id === ask.docId)
    const rects = d ? pageRects(d) : []
    const r = rects[ask.page - 1]
    if (!r) {
      setAsk(null)
      flash('那一页已经从板上移走了，追问的小窗收起来了', 'warn')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askSig, ask && ask.docId, ask && ask.page])

  /** 开窗：把"圈住的这一块"变成一个可以追问的对象。
   *  三种"不能问"各自给一句人话 —— 「点了没反应」是这一族最糟的失败方式。 */
  function openAsk() {
    /* ⚠ 判据是"**圈过了没有**"（`sel.box`），不是"圈到笔了没有"（`sel.ids`）——
       见上面 askRegion 那段 2026-09-21 的修正：追问圈的是**课件**。 */
    if (!sel.box) {
      flash('先框住课件上你不懂的那一块（点「⬚ 框选」拖一个框，或者按住笔杆键拖）', 'warn')
      return
    }
    if (!(boardRef.current.docs || []).length) {
      flash('这块板上还没有课件 —— 追问问的是课件上的哪一块，先「📄 插入 PDF/PPT」', 'warn')
      return
    }
    const hit = askRegion
    if (!hit) {
      flash('框里没有课件页面 —— 追问要圈在课件的页面上，或者圈住某一页旁边的讲解卡（问的就是它在讲的那一页）', 'warn')
      return
    }
    /* 圈住的是卡片、不是页面本身 → 说清楚问的是哪一页（不然小窗突然讲起别的东西）。 */
    if (hit.fromCard) flash(`圈住的是讲解卡 —— 按它讲的**第 ${hit.page} 页**来问`, 'ok')
    /* 摆放：选区块**右边**、顶边对齐。右边放不下（贴着窗口右缘）就翻到左边。
       上下按画布高度夹住 —— 小窗比选区高多了，不夹的话它下半截会被底部工具条盖住
       （那一带是 z-index 20，而按钮"看得见点不到"这个坑这个仓库踩过三次）。 */
    const el = wrapRef.current
    const v = boardRef.current.view
    const at = worldToScreen({ x: hit.box.x1, y: hit.box.y0 }, v)
    const W = 366
    const H = 460
    const vw = el ? el.clientWidth : 900
    const vh = el ? el.clientHeight : 600
    const gap = 14
    const left = at.x + gap + W <= vw - 8 ? at.x + gap : Math.max(8, at.x - gap - W)
    const top = Math.max(8, Math.min(at.y, vh - H - 96))
    setAsk({
      docId: hit.doc.id,
      doc: hit.doc,
      page: hit.page,
      /* 页内归一化矩形（0~1）—— **存它而不是世界矩形**：世界矩形要跟着资料走，
         而"这一块在页面的哪个位置"是这一页自己的事（ask-region.js 那条口径）。 */
      region: hit.region,
      box: hit.box,
      clipped: hit.clamped,
      anchor: { x: left, top },
    })
    if (hit.clamped) flash('圈到页面外面了 —— 按页内的那一块问', 'ok')
  }

  /** 圈住的这一块**落在课件的第几页**（0 = 不在任何一页上）—— 按钮的灰不灰看它。 */
  const askPage = askRegion ? askRegion.page : 0
  /* 小窗开着时画在板上的那一圈高亮：**世界矩形**现算（跟着视野走）。
     ⚠ 不能用 `ask.box`（那是开窗那一刻的）—— 平移之后它会留在原地，
       而小窗讲的是活的那一块地方。 */
  const askMark = useMemo(() => {
    if (!ask) return null
    const rects = (board.docs || []).filter((d) => d.id === ask.docId).flatMap((d) => pageRects(d))
    const r = rects[ask.page - 1]
    if (!r) return null
    const box = regionToWorld(ask.region, r)
    return box ? { box, page: ask.page } : null
  }, [ask, board.docs])

  /* ── 「留到板上」留下的卡：点它左下角那颗 ◎，把"我当时圈的是哪一块"亮出来 ─────────
   * 卡片上的 `ask` 字段（ADR-0006 决定 ③）就是为这一下存在的 —— 不然它是一堆没人读的字节。
   * 高亮的画法和追问那一圈**共用**（`.bd-askmark` / BoardCanvas 的 `askRegionBox`）：
   * 两套画法会长成两个样子，而"框画歪了"这种事只能靠眼睛发现。
   * ★ 判据：**点一下亮、再点收起**（不做"过几秒自己消失"）——
   *   用笔的人腾不出手去追一个会自己跑掉的东西。 */
  const [keptMark, setKeptMark] = useState(null) // { cardId, docPath, page, region } | null
  const keptBox = useMemo(() => {
    if (!keptMark) return null
    const live = (board.cards || []).some((c) => c.id === keptMark.cardId)
    if (!live) return null
    const docs = board.docs || []
    /* "卡上那份 `ask.doc` 指的是板上哪一份资料"只有 ask-region.js 那一份判据。 */
    const d = docForPath(docs, keptMark.docPath)
    const r = d ? pageRects(d)[keptMark.page - 1] : null
    if (!r) return null
    const box = regionToWorld(keptMark.region, r)
    return box ? { box, page: keptMark.page } : null
  }, [keptMark, board.cards, board.docs])

  /** 卡片上那颗 ◎：亮出 / 收起"这张卡问的是哪一块"。三种亮不出来各自给一句人话。 */
  function toggleAskMark(card) {
    const a = card && card.ask
    if (!a) return
    if (keptMark && keptMark.cardId === card.id) {
      setKeptMark(null)
      return
    }
    if (!a.region) {
      flash('这张卡没记下圈的是哪一块（当时圈得太小了）—— 它记着的是第 ' + a.page + ' 页', 'warn')
      return
    }
    const docs = boardRef.current.docs || []
    const d = a.doc ? docs.find((x) => x.path === a.doc) : docs.length === 1 ? docs[0] : null
    if (!d) {
      flash('这张卡问的那份课件已经不在板上了 —— 位置还在卡片里记着，课件铺回来就看得见', 'warn')
      return
    }
    if (!pageRects(d)[a.page - 1]) {
      flash(`这张卡问的是第 ${a.page} 页，那份课件里没有这一页了`, 'warn')
      return
    }
    setKeptMark({ cardId: card.id, docPath: d.path, page: a.page, region: a.region })
  }

  /* ── 框住的笔里，有哪些是"能规整的形状" ────────────────────────────────────
   * 用户 2026-09-18：「加入常用形状优化方式，比如我画个圆他给我优化成真正的圆形，
   * 直线也是还有常用的矩形，三角形都能自动优化」。
   *
   * ★ 它算的是"这一撮笔里能不能认出一个形状"，**不是**"替用户决定这一撮是什么" ——
   *   判读规则（顺序、阈值、什么时候宁可认不出来）整个在 shapes.js。
   *   这里只做一件事：把结果递给界面，让「◯ 规整」那颗按钮**有结果才出现**。
   *
   * ★★ 2026-09-21：**它不再跟着每一帧重算了**（用户报「大字体旋转时卡顿」时查出来的）。
   *   为什么原来会每帧重算：判读的依赖写的是 `sel.strokes`，而那个数组**每一帧都是新的**
   *   （`readSelection` 每次 filter 一遍）—— 拖动、缩放、旋转、平移、擦除……
   *   只要板变了它就重跑一遍。代价是 O(框住的笔数 × 每笔拟合)：
   *   实测（用户那张 1451 笔的板、框住 171 笔）光 `pointSegDist` 就是 **0.6ms/帧**，
   *   整页框住时是好几毫秒 —— 而**这一帧算出来的东西没有一个人看得见**
   *   （手在拖，不在点那颗按钮）。
   *   ⇒ 改成两个触发点：
   *     · **选区换了**（`sel.ids` 变了）→ 立刻算一次 —— 框住一个圆，按钮马上出来；
   *     · **板安静下来**（`SETTLE_MS` 里没有新的改动）→ 再算一次 —— 覆盖"拖动改了几何、
   *       缩放把一个形状拉得认得出/认不出"这些情况。
   *   ⚠ 用"多久没有新改动"而不是"手势开始/结束"标记：抬手、平移、擦除、撤销、缩放卡片……
   *     入口一双手数不完，而"安静"是它们**共同的性质**（`card-fit.js` 的
   *     `board-changed` 那条政策也是这么判的，只是那边还管着量尺寸）。
   *   ⚠ `selRef` 是**必须**的：定时器回调里要拿"那一刻的选区"，而闭包里的 `sel`
   *     是排这一次定时器时的那个（早过期了）。 */
  const [shapeHits, setShapeHits] = useState([])
  const selRef = useRef(sel)
  selRef.current = sel
  const selKey = sel.ids.join('|')
  useEffect(() => {
    setShapeHits(recognizeStrokes(selRef.current.strokes))
  }, [selKey])
  useEffect(() => {
    const t = setTimeout(() => setShapeHits(recognizeStrokes(selRef.current.strokes)), SHAPE_SETTLE_MS)
    return () => clearTimeout(t)
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

  /* 把框选中的那些东西删掉（笔迹 + 顺带框进来的卡片）。一次删除 = 一步撤销。
     ★ 2026-09-21：卡片也归它删 —— 分成两处的话，"框住 3 笔 + 1 张卡按 Delete"
       会只删一半，而屏幕上看起来就是"删除做了一半"（卡片还杵在原地）。
     ⚠ 必须定义在下面那个键盘 useEffect **之前**：它的依赖数组里引用了这里。
       const 是有暂时性死区的，写在后面的话组件一渲染就
       "Cannot access 'xx' before initialization"，整页白屏、什么都不显示。
       （踩过一次：构建完全正常、vite 也不报错，只有浏览器控制台里能看到。） */
  const deleteInkSel = useCallback(() => {
    const ids = inkSel ? new Set(inkSel) : new Set()
    const cards = new Set(sel.cardIds)
    if (!ids.size && !cards.size) return
    commit((cur) => removePick(cur, ids, cards))
    setFocus(FOCUS_NONE)
  }, [inkSel, sel.cardIds, commit])

  /* ── 规整形状：把框住的那些笔里**认得出来的**换成规整的一笔 ─────────────────
   *
   * ★★ 两条要点，都是这一族设计里最要紧的：
   *
   * ① **认不出来的原样留着，不是整块失败。**
   *    框里常常是"一个圆 + 旁边两笔小注释"。用户点「◯ 规整」的意思是
   *    "把这儿画的形状弄整齐"，不是"我认为这三笔全是形状"。
   *    所以只有认出来的那几笔被换掉，其余一个字节都不动。
   *    （这一点和 ADR-0001 砍掉的那一族**正好相反** —— 那一族要么整个写进文件、
   *      要么整个不写；这里每一笔各判各的、各换各的。）
   *
   * ② **一次点击 = 一步撤销。**
   *    `commit` 默认记历史，而规整是"把 N 笔的 points 一起换掉"这样一个数据替换 ——
   *    撤销的时候 N 笔一起回退，不是撤 N 次。用户按一下 Ctrl+Z 就回到手写的样子。
   *
   * ★ 沿用 id（见 shapes.js 的 regularizeStrokes）：板框成员、挂在笔上的
   *   link / cond 都跟着走，不会因为"规整一下"就被踢出框、丢掉连接。
   * ★ 认不出来时**不报错、不弹提示**，只是把话说清楚（"这几笔没看出形状"）——
   *   用户画的是字，那他本来就点错了按钮，告诉他一句就够了。 */
  const regularizeInkSel = useCallback(() => {
    const b = boardRef.current
    const ids = inkSel ? new Set(inkSel) : new Set()
    if (!ids.size) {
      flash('先框住要规整的图形（笔杆侧键拖一圈，或者工具条上的「⬚ 框选」）', 'warn')
      return
    }
    const { strokes, changed } = regularizeStrokes(b.strokes.filter((s) => ids.has(s.id)))
    if (!changed.length) {
      flash('框住的这几笔没看出形状 —— 圆、直线、矩形、三角形才认（认不出来就不动它）', 'warn')
      return
    }
    /* 只换那几笔：其余笔迹**连引用都不变**（下面这个 map 里没碰到的直接返回原对象）。 */
    const byId = new Map()
    for (const s of strokes) byId.set(s.id, s)
    commit((cur) => ({ ...cur, strokes: cur.strokes.map((s) => byId.get(s.id) || s) }))
    /* 规整完**焦点留着**：你可能想接着再规整同一块里的另一笔，
       也可能想马上 Ctrl+Z 看看对不对 —— 两种都要求这一撮还选着。
       （对比「留下板框」：那个动作之后焦点要清，因为它把这一坨变成了别的东西。） */
    const names = [...new Set(changed.map((c) => c.label))]
    flash(`规整了 ${changed.length} 笔：${names.join('、')}（Ctrl+Z 能退回手写的样子）`, 'ok')
  }, [inkSel, commit, flash])

/* ══════════════════ 收笔之后**停顿一下就自动规整**（OneNote 那个手感）══════════════════
   *
   * 用户 2026-09-19：「我希望做到的图形修正是类似 onenote 的那种**略微停顿后**会给你
   * 把画的图形修正成规整的图形，然后你可以对图形放大缩小修正真正形状，
   * 但现在并不是这样子的」。上一版只有"框住 → 点「◯ 规整」"那条手动路
   * （README 第 49 条），而文档里写的是"收笔时它自己认" —— **文档和代码不一致**，
   * 这一段就是把缺的那一半补上。
   *
   * ── 三条设计要点，每条都是拿这个仓库自己的教训换的 ────────────────────────
   *
   * ★① **停顿 0.55 秒**（`AUTO_SHAPE_MS`），不是"收笔立刻变"。
   *    OneNote 也是这个手感，而它在这里**还有第二个理由**：`shapes.js` 的判读
   *    是"宁可认不出来，也不许认错"，它吃的点已经是抽稀过的（真板中位 6 点）。
   *    停顿让我们可以**把这一笔留给你看完再动** —— 写连笔字时笔是不停的，
   *    每一笔收笔都紧跟着下一笔的落笔，于是"停顿"自然而然地只发生在
   *    **你确实画完了一个图形、正在看它**的那一刻。
   *
   * ★② **只有一笔会被自动规整：最后收的那一笔。**
   *    第 ① 条那个"写字时笔不停"的假设不是百分之百成立（写完一个字会停一下
   *    想事情），所以再加一道**结构**上的闸：定时器只有**一个**，
   *    下一笔一落下就把上一个撤掉（见 `cancelAutoShape`，挂在 pointerdown 上）。
   *    于是"停笔想事情"永远不会攒出一批待办 —— 最多只有**刚刚那一笔**在等。
   *    这一条比任何阈值都管用：**误判的暴露面被压到"你正在看的那一笔"**。
   *
   * ★③ **误判的回头路是一步 Ctrl+Z**，而且**退掉之后不再自动重来**
   *    （`suppressAutoRef`，见 `undo` 上面那段）。这一条是"自动"这件事能成立的
   *    前提：`shapes.js` 开头写得很清楚 —— 形状判读和 ADR-0001 砍掉的那一族
   *    唯一的区别就是**错了看得出来**、而且**一步能退**。自动之后"看得出来"这一条
   *    更要紧（屏幕上多一句会消失的提示语），"一步能退"由这一条钉住。
   *    ⚠ 少了"退掉之后不再重来"，Ctrl+Z 就变成**假的**：退回去、0.55 秒后又变回来。
   *      那比不自动更糟 —— 用户会以为撤销坏了。
   *
   * ⚠ **不碰正在编辑的东西、也不碰别人的笔**：判读只吃刚收的那一笔（`recognizeShape`
   *   内部还有五道闸）。框选、拖卡片、切工具、关页面都不受影响 ——
   *   它们各自会把那个定时器撤掉（`cancelAutoShape` 挂在 pointerdown 上）。
   * ⚠ **`AUTO_SHAPE_MIN_DIAG` 不是多余的**：`recognizeShape` 自己有一道
   *   `MIN_DIAG = 26`，但那是在**抽稀之后**算的。这里先按抽稀前的点粗算一遍，
   *   是为了让"一个笔画短横"在**调度**那一层就被挡掉，连定时器都不排
   *   （一秒里画十笔，就少排十次判读）。
   *   ★ 它和 `shapes.js` 的 `MIN_DIAG` **必须一样**（自检里有一条对着比）：
   *     不一样的话，会出现"排了定时器、判读又把它挡掉"这种白跑的中间地带 ——
   *     不报错，只是白白多跑一趟，而且调参的人会以为自己改的是同一道闸。
   */
  const AUTO_SHAPE_MS = 550
  const AUTO_SHAPE_MIN_DIAG = 26

  /* 唯一那个待办：{ id, timer }。 */
  const autoShapeRef = useRef(null)

  const cancelAutoShape = useCallback(() => {
    const cur = autoShapeRef.current
    if (cur && cur.timer) clearTimeout(cur.timer)
    autoShapeRef.current = null
  }, [])

  const runAutoShape = useCallback(
    (id) => {
      autoShapeRef.current = null
      const stroke = boardRef.current.strokes.find((s) => s.id === id)
      /* 这一笔没了（被你擦掉 / 撤销掉了）→ 什么都不做。 */
      if (!stroke) return
      /* 它已经是个图形了（比如你手点过「◯ 规整」）→ 不重复劳动。 */
      if (stroke.shape) return
      /* ★ 你正在就地改一张卡（双击进去了）→ 不许在背后动板。
         ⚠ 这一条挡的是一个真的会很难受的场景：写完一个圈 → 550ms 内双击进卡片改字 →
         定时器到点、`commit` 换掉板 → React 重渲染那一层 → **输入框失焦**，
         而你正在打字。窗口只有半秒，但"打着字突然跳出去"是最容易让人以为程序坏了的那种。
         （判据用**焦点那个值**，不是"DOM 里有没有 input" —— 焦点是唯一那个值，见 focus.js。） */
      if (focus && focus.editing) return
      /* 你刚刚亲手退掉过这一笔的自动规整 → 听你的，不再来一次。 */
      if (suppressAutoRef.current.has(id)) return
      const { strokes, shapeObjects } = regularizeStrokes([stroke])
      const hit = shapeObjects.find((o) => o.id === id)
      const next = strokes.find((s) => s.id === id)
      /* 认不出来 → **什么都不做**（`shapes.js` 那条铁律：宁可认不出来，也不许认错）。
         注意这里**连提示语都不给**：写字的时候每一笔都弹一句"这不是形状"是骚扰。 */
      if (!hit || !next || !next.shape) return
      /* 只换这一笔，其余笔迹**连引用都不变**。一次自动规整 = 一步撤销（commit 默认记）。 */
      commit((cur) => ({ ...cur, strokes: cur.strokes.map((s) => (s.id === id ? next : s)) }))
      flash(`认出来了：${shapeName(hit.shape)} —— 拖角放大缩小、顶上那颗转它（Ctrl+Z 退回手写）`, 'ok')
    },
    [commit, flash, focus]
  )

  /* 收笔之后叫它。⚠ 判据要**保守**：只排给"够大、不是荧光笔"的一笔。 */
  const scheduleAutoShape = useCallback(
    (stroke) => {
      cancelAutoShape()
      if (!stroke) return
      if (stroke.tool === 'highlighter') return
      /* 抽稀前的粗筛（见上面那段）：世界像素的对角线够大才值得判读。 */
      const flat = stroke.points || []
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (let i = 0; i + 2 < flat.length; i += 3) {
        if (flat[i] < x0) x0 = flat[i]
        if (flat[i] > x1) x1 = flat[i]
        if (flat[i + 1] < y0) y0 = flat[i + 1]
        if (flat[i + 1] > y1) y1 = flat[i + 1]
      }
      if (!(Math.hypot(x1 - x0, y1 - y0) >= AUTO_SHAPE_MIN_DIAG)) return
      const timer = setTimeout(() => runAutoShape(stroke.id), AUTO_SHAPE_MS)
      autoShapeRef.current = { id: stroke.id, timer }
    },
    [AUTO_SHAPE_MS, cancelAutoShape, runAutoShape]
  )

  /* 组件卸载（切板 / 关页面）时把定时器收掉 —— 不然它会在一个已经没了的组件里
     去动一张已经换掉的板。`clearTimeout` 是幂等的，多叫一次没有代价。 */
  useEffect(() => cancelAutoShape, [cancelAutoShape])

  /* ── 选区手柄：缩放 / 旋转（`selection.js` 的 `transformPick` 那一族的界面这一半）──
   *
   * 用户 2026-09-19：「你可以对图形放大缩小修正真正形状」→ 那时手柄**只在"框住的
   * 正好是一个规整过的图形"**时出现（`stroke.shape`，见 shape-object.js）。
   * 用户 2026-09-21：「框选中任意的字迹——卡片都应该能够放大，旋转，这点类似 onenote」
   * → 手柄对**任意选区**都出现：几笔字、一坨乱涂、以及**框进来的卡片**，都算"一个东西"。
   *
   * ★★ 两个手势都走 `transformPick` 这**唯一**一个入口，而且**每一帧都从"按下那一刻的板"
   *    重算**（`start` 那个快照）。两条理由，都是这一族的老账：
   *    · 累加那条路没有自愈能力（一帧算成 0，加多少次还是 0），而且会把浮点误差和
   *      1/10 像素的量化误差一帧一帧攒起来 —— 拖十下图形就糊了；
   *    · 谁都别自己改 points：那会在"点"和"shape"之间造出第二份真相，
   *      而下一帧的渲染和包围盒读的都是 points —— 一旦不同步，手柄会从一个地方
   *      跳到另一个地方（静默的，没有报错）。
   *
   * ★ 拖角缩放：**锚点是那个角的对角**（拖右下角 → 左上角不动，和拖卡片缩放同一个手感）。
   *   分轴算倍率（横一根、竖一根）—— 这正是"圆拉成椭圆 / 手写字被拉宽"的来源，是**要的**
   *   （OneNote 也是这样；卡片只能等比，理由见 selection.js 那段）。
   * ⚠ 倍率的分母必须是**按下那一刻**框的跨度，不是每帧重算的框：
   *   每帧重算会变成"倍率的倍率"，拖两下手感就炸了。
   *
   * ★ 转：绕**选区包围框的中心**。角度取"第一次 move 的角度 → 现在的角度"的**绝对差**，
   *   不是一帧一帧的增量（同一条"没有自愈能力"的账）。单个图形在手时，绕包围盒中心转
   *   和绕它自己的几何中心转是同一个点吗？—— 矩形/椭圆是（它对称），
   *   三角形不是（重心 ≠ 包围盒中心），代价是"框住一个三角形转它"的转轴比从前偏一点点。
   *   取包围盒中心是有意的：**选区的转轴必须是那个虚线框的中心**，
   *   不然"转一下"的时候框会绕着别处跑（多个东西一起选时尤其明显）。
   */
  const pickTarget = useMemo(() => {
    const box = sel.box
    if (!box) return null
    const cx = (box.x0 + box.x1) / 2
    const cy = (box.y0 + box.y1) / 2
    /* `ids` / `cardIds` 一起带出去：手势每一帧要把它们原样交给 `transformPick`。 */
    return { ids: sel.ids, cardIds: sel.cardIds, box: { ...box, cx, cy } }
  }, [sel.box, sel.ids, sel.cardIds])

  function startPickScale(corner) {
    const t = pickTarget
    if (!t) return
    /* ★ 按下那一刻的那一份板 —— 手势每一帧都从它重算（见上面那段）。 */
    const start = boardRef.current
    const pick = { ids: t.ids, cardIds: t.cardIds }
    const box = t.box
    const anchor = oppositeCorner(box, corner)
    /* ★★ 分母是**框的两个跨度**，不是"从锚点到 box.x1/y1 的距离"。
       为什么写这一条（2026-09-21，新自检 [12g] 当场抓到的**老 bug**）：
       原来写的是 `Math.abs(box.x1 - anchor.x)` / `Math.abs(box.y1 - anchor.y)` ——
       那两行只在拖 **se**（锚点 = nw）时等于框的宽高。换一颗柄就崩：
         · ne（锚点 = 左下角）：`|box.y1 − anchor.y|` = **0** → 被 `Math.max(1, …)`
           兜成 1 → 倍率 = "指针离锚点的**世界像素数**"，拖 30px 就是 30 倍；
         · nw（锚点 = 右下角）：两轴都是 0 → 两轴都成了"像素数"；
         · sw：只有横轴那一半崩。
       为什么从前没人发现：`check:shape` 的 [12c] **只拖过 se** 那一颗
       （夹具是"拖右下角放大 1.5 倍"），而屏幕上"拖右上角它会暴涨"看起来像
       "我手抖了" —— 静默、且只在四分之三的角上发生。
       几何上正确的写法：倍率 = 指针现在离锚点多远 ÷ **被拖的那颗柄**离锚点多远，
       而"那颗柄离锚点"在横轴/竖轴上**恒等于框的宽/高**（对角关系）。 */
    const w0 = Math.max(1, Math.abs(box.x1 - box.x0))
    const h0 = Math.max(1, Math.abs(box.y1 - box.y0))
    const g = ledger.begin()
    setXforming(true)
    const onMove = (e) => {
      const rect = wrapRef.current.getBoundingClientRect()
      const wp = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, boardRef.current.view)
      /* 倍率 = 指针现在离锚点多远 / 按下那一刻多远。**带符号** ——
         指针拖过锚点另一边 = 翻面（镜像），右角能一路拖到左边去（OneNote 手感，
         用户 2026-09-19 明确要的；从前取绝对值，拖过锚点就"反方向弹回去"）。
         夹取（保符号、剩 PICK_MIN_SPAN）在 selection.js 的 clampToSpan 里。 */
      const fx = (wp.x - anchor.x) / w0
      const fy = (wp.y - anchor.y) / h0
      g.during(() => transformPick(start, pick, { scale: { fx, fy, anchor } }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      setXforming(false)
      g.end()
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  /* ── 转一整个选区 ───────────────────────────────────────────────────────
   * ★★ 结构和上面那个缩放**一模一样**，这不是巧合：拖角缩放是验过的
   *   （`check:shape` [12c] 实测倍率 1.50×1.50），所以旋转沿用它的每一处口径 ——
   *   同一个 `wrapRef` 取 rect、同一个 `screenToWorld`、同一个 `ledger.begin/during/end`、
   *   同样把 move/up 挂在 window 上、同样每帧从**按下那一刻的板**重算。
   *   **同一个组件里两段手势用两套口径，一定会有一套是错的**
   *   （"同一句话两份实现"的账这个仓库记了十几条）。
   *
   * ★ 角度用"**第一次 move 的角** → 现在的角"的**绝对差**，不是一帧一帧的增量：
   *   增量那条路没有自愈能力（一帧算成 0，0 加多少次还是 0），
   *   而绝对差每帧都从**起始形状**重算，一帧算错不影响下一帧。
   *
   * ⚠ 起手的角度基准取"**第一次 move**"而不是"pointerdown"：
   *   按下那一刻指针就贴在手柄上（离中心只有十几像素），那个角度的**杠杆太短** ——
   *   位置差一个像素、角度就差好几度，而那个误差会原样留在整段旋转里。
   *   第一次 move 时指针已经离开手柄、离中心更远，量出来的基准稳得多。
   *   代价是"按下不动、直接松手"不会转（指针没动，本来也没有可转的角度）。
   *
   * ⚠⚠ 转轴 = **选区包围框的中心**（`pickTarget.box` 的 cx/cy），不是"选中那样东西自己的
   *   几何中心"：选多个东西（或者一个字迹块 + 一张卡）时，转轴只能是那一个框的中心 ——
   *   绕其中某一个的中心转，屏幕上就是"框绕着别处甩"。
   *   单个图形在手时的行为变化（三角形那一种，重心 ≠ 框中心）是**故意**的，
   *   理由同上：用户看到的是那个虚线框。
   * ⚠ `check:shape` 的 [12d] 从前**没能端到端验住这一段**（rot 只变了 0.003 弧度）；
   *   2026-09-21 起 [12i]/[12j] 拿"任意一撮字迹"和"卡片"分别验它 ——
   *   动这一段之前先看那两条里记的读数（`data-last-grab` / `data-rot-steps`）。 */
  function startPickRotate() {
    const t = pickTarget
    if (!t) return
    const start = boardRef.current
    const pick = { ids: t.ids, cardIds: t.cardIds }
    const center = { x: t.box.cx, y: t.box.cy }
    const rect = wrapRef.current.getBoundingClientRect()
    const angleAt = (e) => {
      const wp = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, boardRef.current.view)
      return Math.atan2(wp.y - center.y, wp.x - center.x)
    }
    const g = ledger.begin()
    setXforming(true)
    let a0 = null
    const onMove = (e) => {
      const a = angleAt(e)
      if (a0 == null) {
        a0 = a
        return
      }
      const d = a - a0
      if (Math.abs(d) < 1e-4) return
      g.during(() => transformPick(start, pick, { rotate: { d, center } }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      setXforming(false)
      g.end()
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  /* ── 整组拖动（"框住的那一坨东西"一起挪）──────────────────────────────────
   *
   * 三个入口都走这里，**一件事只有一份实现**：
   *   · 按在选区的空白处（`.bd-hit` 的 pointerdown）；
   *   · 按在**选区里的那张卡片**上（卡片自己收指针事件 —— 见下面 `inPick`）。
   * 后一条是 2026-09-21 补的：不接它的话，"框住字 + 卡，按着卡拖"只有卡动，
   * 屏幕上就是**拖散了**（和"只搬笔迹不搬卡片"是同一个错，只是换了个入口）。
   *
   * ★ 每一帧都从"按下那一刻的原样"算偏移，**不是**累加每一帧的增量 ——
   *   累加会把浮点误差和 1/10 像素的量化误差一路攒起来，来回拖几次位置就飘了。
   * ★ 中途每一帧只改板、不记账；"这一下算不算一步"收尾时由账本判一次。 */
  const beginPickMove = useCallback(
    (wp) => {
      const origin = new Map()
      for (const s of boardRef.current.strokes) if (inkSel.has(s.id)) origin.set(s.id, s)
      /* ★ 卡片也要一起搬：框住的是"这一坨东西"，只搬笔迹 = 屏幕上"拖散了"。 */
      const originCards = new Map()
      for (const c of boardRef.current.cards) if (cardSel.has(c.id)) originCards.set(c.id, c)
      inkMoveRef.current = { from: wp, origin, originCards, g: ledger.begin() }
    },
    [inkSel, cardSel, ledger]
  )

  const movePickTo = useCallback((wp) => {
    const mv = inkMoveRef.current
    if (!mv) return
    const dx = wp.x - mv.from.x
    const dy = wp.y - mv.from.y
    mv.g.during((cur) => ({
      ...cur,
      strokes: cur.strokes.map((s) => (mv.origin.has(s.id) ? shiftStroke(mv.origin.get(s.id), dx, dy) : s)),
      cards: mv.originCards.size
        ? cur.cards.map((c) => (mv.originCards.has(c.id) ? shiftCard(mv.originCards.get(c.id), dx, dy) : c))
        : cur.cards,
    }))
  }, [])

  const endPickMove = useCallback(() => {
    const mv = inkMoveRef.current
    if (!mv) return
    inkMoveRef.current = null
    mv.g.end()
  }, [])

  /* 卡片那条路送进来的是**事件**（它拿不到"相对画布容器"的坐标，那是 Board 的账）——
     这里统一换算成世界坐标，再交给同一个 `movePickTo`。 */
  const pickMoveFromCard = useCallback(
    (e, phase) => {
      if (phase === 'end') {
        endPickMove()
        return
      }
      const lp = localPoint(e)
      const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)
      if (phase === 'start') beginPickMove(wp)
      else movePickTo(wp)
    },
    [localPoint, beginPickMove, movePickTo, endPickMove]
  )

  /* ── 复制 / 粘贴（见 lib/clipboard.js 的三条规矩）────────────────────────────
   *
   * ★ **剪贴板是一份模块级的内存 + localStorage 的镜像**，不是 `navigator.clipboard`。
   *   为什么不用系统剪贴板：`navigator.clipboard.write` 要 HTTPS + 用户手势，
   *   而这个应用跑在 `http://127.0.0.1:5177`（本机 HTTP）—— 写会直接被拒。
   *   而这里要复制的是**这个应用自己的东西**（笔迹的点、卡片的框），
   *   本来也不是"粘到别的软件里"用的，所以自己存一份更合适。
   *   存 localStorage 是为了**跨窗口**：用户开两个白板页（或者复制完关了再打开）
   *   照样能粘 —— 那正是"贴到别的板上"最常见的走法。
   *   ⚠ 键名一起改动要连带改掉：它是"另一个窗口也能读到"的唯一凭据。 */
  function readClipboard() {
    try {
      const raw = localStorage.getItem(CLIP_KEY)
      if (!raw) return null
      const p = JSON.parse(raw)
      return isPayload(p) ? p : null
    } catch {
      return null // 存储被禁用 / 内容坏了 —— 当"没有剪贴板"，别让整页崩
    }
  }

  /* 复制：框住的笔 + 框进来的卡片。
     ★ 2026-09-21：这两样现在都是**焦点自带的**（`inkSel` + `sel.cardIds`），
       不再靠"最后一次框选那个矩形"去找卡片 ——
       那条路（`lastLassoRef`）踩过一个真 bug（2026-09-18 自检抓到的）：
       它只在框选成功那一下被写下，之后**没有任何地方清它**，
       于是"框住一块 → 按 Esc 取消选中 → 再按 Ctrl+C"会拿**上一次的矩形**
       去找卡片，复制出"0 笔 + 那一张卡"（用户明明已经取消了）。
       现在"框住了什么"只有一份答案（焦点），Esc 一按它连同卡片一起没了。 */
  const copySel = useCallback(() => {
    const b = boardRef.current
    const ids = inkSel ? new Set(inkSel) : new Set()
    const cards = sel.cardIds
    const payload = copySelection(b, ids, { cards, frame: sel.frame })
    if (!payload) {
      flash('先框住要复制的东西（笔杆侧键拖一圈，或者工具条上的「⬚ 框选」）', 'warn')
      return
    }
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(payload))
    } catch {
      /* 存不进去（隐私模式 / 配额满了）也不该失败：本次会话里还能粘
         —— 下面那份内存里的就是给这种情况兜底的。 */
    }
    clipboardRef.current = payload
    const n = payloadCount(payload)
    flash(`复制了 ${n.strokes} 笔${n.cards ? ` + ${n.cards} 张卡` : ''}${n.frames ? `（含 ${n.frames} 个板框）` : ''} —— 切到别的板按 Ctrl+V 贴上`, 'ok')
  }, [inkSel, sel.cardIds, sel.frame])

  /* 粘贴：落点默认是**视野中心**（"贴在我正看着的地方"）。
     为什么不是鼠标位置：键盘触发的那一下没有鼠标位置，
     而"看着哪儿就贴哪儿"这两种触发方式下都成立 —— 鼠标用户挪一下地图也一样。 */
  const pasteSel = useCallback(() => {
    const payload = clipboardRef.current || readClipboard()
    if (!payload) {
      flash('剪贴板里什么都没有 —— 先框住一块东西按 Ctrl+C', 'warn')
      return
    }
    const el = wrapRef.current
    /* 视野中心的世界坐标：屏幕中心 → 世界（走 view.js 那一处，别自己反算）。 */
    const cx = el ? el.clientWidth / 2 : 0
    const cy = el ? el.clientHeight / 2 : 0
    const w = screenToWorld(cx, cy, boardRef.current.view)
    const res = pastePayload(boardRef.current, payload, { world: w })
    if (!res) {
      flash('剪贴板里的东西读不出来（可能是别的版本留下的）—— 重新复制一次', 'warn')
      return
    }
    commit(res.board)
    /* 贴完把焦点放在**新贴出来的这些东西**上（笔迹 + 卡片）：
       ① 用户能立刻拖走 / 再删掉 / 再缩放旋转，不用重新框一遍；
       ② 而且"再按一次 Ctrl+C"复制的就是刚贴的这份（符合直觉：
          我贴了两次之后想再贴一次，复制的那一份不该变）。
       ★ 2026-09-21：卡片也一起选中 —— 焦点那一种 kind 现在装得下两样
         （见 focus.js 的 `focusInk(ids, cards)`）。 */
    setFocus(focusInk(res.ids, res.cards))
    const n = payloadCount(payload)
    flash(`粘贴了 ${n.strokes} 笔${n.cards ? ` + ${n.cards} 张卡` : ''}${payload.from ? `（从《${payload.from}》复制）` : ''}`, 'ok')
  }, [commit])

  const onPointerDown = useCallback(
    (e) => {
      const el = wrapRef.current
      if (!el) return
      trackPointerKind(e)
      /* ★★ 纸面上**任何**一次按下都作废"收笔自动规整"那个待办（见 scheduleAutoShape）。
         为什么挂在这里而不是"挂在新的一笔收笔时"：
           · 你下一笔落在哪儿都算 —— 画、擦、框选、拖卡片、按那颗按钮，全都是一次"我在动了"；
           · 它把"停笔想事情"和"我正在画"分开：停笔时那一笔在等（等你看它一眼），
             手一落下去就不等了。
         ⚠ 放在 `useCallback` 的最前面：下面每一条分支都有 `return`，
           写在中间就会被某些分支跳过 —— 那种漏是静默的（定时器照旧在跑）。 */
      cancelAutoShape()
      /* ★ 指针捕获必须设在**收到事件的那个元素自己**身上（这里是 .bd-hit）。
         第一版设在最外层的 .bd-stagewrap 上：于是 pointermove / pointerup 被
         重定向到那个 div，而监听器挂在 .bd-hit 上 —— 结果就是
         "按下去像是没反应、拖不动、松手什么都不发生"（.bd-hit 只收到 pointerdown）。
         这一条在写字板上也踩过一次（README 的坑 #7），是同一个错。
         记法：**捕获的对象和挂监听的对象必须是同一个元素。** */
      e.currentTarget.setPointerCapture?.(e.pointerId)
      /* ★ 僵尸指针自愈（2026-09-30，上课时用户被"写不了字、拖不动卡、选区清不掉"
         卡住）：触屏/笔/触控板有一次手势被系统半路抢走（手掌误触、Edge 手势接管、
         长按弹菜单）时，pointerup / pointercancel 可能一条都不来 ——
         这条记录就**永远留在 Map 里**，size 从此 >= 1。下一次正常落笔恰好凑成
         "双指"进了下面的捏合分支：笔画作废、按下全被吞 —— 写不出字、按不动卡、
         连"点空白清选区"都走不到（它在这个分支后面），整个白板看起来就是死的。
         自愈判据：**10 秒前"按下"的指针不可能还按着**（正常落笔一两秒内必然松手），
         down 的时候顺手把超时的老条目清掉，世界就恢复正常了。
         （每个条目记下按下的时刻 `t`；move 更新坐标时也刷新它。） */
      const nowT = Date.now()
      for (const [pid, pp] of pointersRef.current) {
        if (nowT - (pp.t || 0) > 10000) pointersRef.current.delete(pid)
      }
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, t: nowT })

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
      /* ★ 落点要按**屏幕上的实际位置**算，所以先把补正清掉（2026-09-18）：
         平移刚结束时那几层可能正挂着一条过渡变换，而 `localPoint` / `paintLive`
         的口径是"没有变换的舞台" —— 带着变换落笔，第一笔会整体歪一个"还差的量"。
         清掉之后差是 0（屏幕上本来就已经对齐了），两层 canvas 的变换都是单位阵。
         ⚠ 这一句必须在下面**所有**用 `wp` 的分支之前：擦、框选、箭头、画都吃这个落点。 */
      clearViewCorrection()
      const wp = screenToWorld(lp.x, lp.y, boardRef.current.view)

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

      /* ② 已经选着一组东西、又正好按在它的框里 → 整组拖着走（笔迹**和卡片**一起）。 */
      if (
        sel.box &&
        tool !== 'eraser' &&
        wp.x >= sel.box.x0 && wp.x <= sel.box.x1 &&
        wp.y >= sel.box.y0 && wp.y <= sel.box.y1
      ) {
        /* 一次拖动 = 一步撤销：起点交给账本记（`moved` 那个手写标记没了 ——
           "动没动过"由 `end()` 按 `sameWithin` 判一次，见 history.js）。 */
        beginPickMove(wp)
        return
      }

      /* ③ 按在别处 = 取消选中（和大多数软件一样）。
         放在画/擦前面，是为了"点空白"既取消选中、也照常落笔，不用点两次。
         ★ 卡片也要一起取消。原来这里只清 inkSel，**selectedId 一直留着** ——
           于是刚插进来的那张卡永远保持选中、右上角永远挂着一个 ×，
           用户 2026-09-16 报的「一直是右上角有 x，容易误删除」就是这么来的。
           选中这个东西只在"你正在动它"的时候才该亮着。
         ★ 现在焦点是一个值 —— 这一下就是"整个取消"，不用再逐个清
           （从前是三行、"清三个"，漏一个就是"Delete 说不清删谁"，见 focus.js）。 */
      if (focus.kind !== 'none') setFocus(FOCUS_NONE)

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
    [tool, color, width, localPoint, eraseAt, trackPointerKind, sel.box, cardSel, inkSel, selectedId, selectedFrameId, ledger, clearViewCorrection]
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

      /* 拖着选中的那组东西走（笔迹 + 卡片）—— 换算和那三件事都在 `movePickTo` 里，
         两个入口（按空白 / 按选区里的卡片）共用同一份实现。 */
      if (inkMoveRef.current) {
        const lp = localPoint(e)
        movePickTo(screenToWorld(lp.x, lp.y, boardRef.current.view))
        return
      }

      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, t: Date.now() })
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
    [tool, localPoint, setView, eraseAt, trackPointerKind, commit, ledger, cancelAutoShape]
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

      /* 框选松手：把圈到的东西选上 —— **笔迹 + 中心落在框里的卡片**。
         用 lassoRef 里的 box 而不是 lasso 这个 state —— 两者在同一帧里可能差一步，
         松手这一刻要的是"最后画出来那个框"。
         ★ 卡片的判据走 geometry.js 的 `membersInBox`（和「留下板框」「复制」同一句
           话：卡片**中心**落在框里才算）—— 三处各判各的话，
           "我圈住了什么"在三个功能里会给出三个答案。
         ★ 2026-09-21 起卡片也进选区（用户要的「框选中任意的字迹——卡片都应该能够放大，
           旋转」）—— 所以 `lastLassoRef` 那道"卡片靠最后一次框选的矩形找"的补丁
           跟着退休了：选区和那一次框选现在是同一份东西。 */
      if (lassoRef.current) {
        const box = lassoRef.current.box
        lassoRef.current = null
        setLasso(null)
        const hit = membersInBox(boardRef.current, box)
        let ids = hit.ids
        /* ★ 固定（📌）住的卡片**框不进来** —— 那是它的全部意思：「别动我」。
           README 第 19 条那句"锁上之后选不中"说的就是这一条：
           卡片的 pointer-events:none 挡住了鼠标，但框选是**另一条**入口
           （它按坐标算，不问卡片收不收事件）。漏了这一句的后果很实在：
           框一大片按 Delete 会把钉住的卡一起删掉。 */
        const locked = new Set(boardRef.current.cards.filter((c) => c.locked === true).map((c) => c.id))
        const cards = hit.cards.filter((id) => !locked.has(id))
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
        if (
          !ids.length &&
          !cards.length &&
          worldLenToScreen(box.x1 - box.x0, vs) <= 4 &&
          worldLenToScreen(box.y1 - box.y0, vs) <= 4
        ) {
          const cx = (box.x0 + box.x1) / 2
          const cy = (box.y0 + box.y1) / 2
          const r = screenLenToWorld(10, boardRef.current.view.s)
          const one = boardRef.current.strokes.find((s) => linkByStroke.has(s.id) && strokeHitsCircle(s, cx, cy, r))
          if (one) ids = [one.id]
        }
        /* 框住了 → 焦点变成"这一撮东西"（笔迹 + 卡片）；框空了 → 只取消墨迹那一种
           （板框的选中留着，和从前一样）。
           ⚠ `pickBox` 会把这次框选的矩形交给空选区（2026-09-21，见下面那条注释）——
              所以"框里没有笔"不再等于"这次框选没发生"。 */
        setFocus((f) => (ids.length || cards.length ? focusInk(ids, cards) : clearInkFocus(f, box)))
        /* 空框说一句人话。静默什么都不发生是最让人迷惑的 ——
           用户会以为"框选坏了"，而其实只是框小了/框到空白上了。
           ★ 2026-09-21 改口径：从前这句是「框里没有笔迹 —— 框大一点，或者框到字上」，
             把"框到字上"说成了框选的**唯一**用处。而圈住课件上的一块去「？问这里」
             本来就不需要框到任何字（用户投诉的正是这一点）。所以只在"框太小"
             这一种情况下提醒，别的东西一概不唠叨 —— 圈在课件上是**合法的**用途。 */
        if (!ids.length && !cards.length) {
          const tiny = worldLenToScreen(box.x1 - box.x0, vs) <= 4 && worldLenToScreen(box.y1 - box.y0, vs) <= 4
          if (tiny) flash('框太小了 —— 按住拖一个框，圈住你要处理的那一块', 'warn')
        }
        return
      }

      /* 拖完松手：整次拖动记成一步撤销（中途那些帧都不记）。 */
      if (inkMoveRef.current) {
        endPickMove()
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
        /* ★★ 收笔之后**停顿一下就自动规整**（OneNote 那个手感）——
           排在 commit 后面：定时器回调要能在 boardRef 里找到这一笔。
           它自己会撤掉上一个待办（只有最后一笔在等，见 scheduleAutoShape 那段）。 */
        scheduleAutoShape(stroke)
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
    [commit, tool, flash, scheduleAutoShape]
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
  /* ★ 箭头工具**只有一个入口实现**（2026-09-24）：按 A 和点工具条上那颗按钮都走它。
     从前工具条那颗自己写了一遍"切工具 + 说一句提示"，而它在那个组件里**拿不到 `flash`**
     —— `flash` 是 App 传下来的 prop，不是随手可用的全局函数（2026-09-17 加那颗按钮时
     就这么写下了，一直是个 `ReferenceError`：工具照样切了，只是那句话出不来，
     而且报错只落在控制台里，界面上看不出事）。
     合成一个 `pickArrow` 之后，两个入口说的也是同一句话 —— 改词只改一处。 */
  const pickArrow = useCallback(() => {
    setTool('arrow')
    flash('箭头工具：从一样东西划到另一样东西（画完自动回到笔）', 'ok')
  }, [flash])

  useEffect(() => {
    /* "在输入框里打字"这条判据住在 focus.js（它和"冲纸面还是冲面板"是姊妹条 ——
       从前这里是一条 `/^(INPUT|TEXTAREA)$/`，而面板上的 `<button>` 不算 input，
       于是面板上的 Backspace 被当成了纸面上的删除，见 focus.js 的文件头）。 */
    const inField = isTextField
    function onKey(e) {
      if (e.code === 'Space' && !inField(e.target)) {
        spaceRef.current = true
        e.preventDefault()
        return
      }
      /* ★☆ 速查 Ctrl+K（2026-09-28）：上课突然不懂的那个词。
         ⚠⚠ 必须排在 `inField` 那道闸**之前**，这一点是刻意的，不是漏了：
           这个功能最常见的用法恰恰是"我正写着笔记 / 改着卡片，突然想问一个词" ——
           闸在前面的话，正在打字的时候按 Ctrl+K 会毫无反应，而那正是最要用它的时刻。
           （上面那些带 mod 的分支不受影响：`inField` 挡的是单个字母键的工具切换，
            比如在这里打一个 `e` 不能把工具切成橡皮。）
         ⚠ 走 ref 而不是闭包里的函数：`toggleLook` 每次渲染都是新对象，写进依赖数组
           就会每改一个词重新绑一次 window 监听（和上面 `toggleShelfRef` 同一条路）。 */
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        if (toggleLookRef.current) toggleLookRef.current()
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
      /* ★ 复制 / 粘贴（2026-09-18）。放在 `mod` 那一串里、**在"面板/输入框"那道闸之后** ——
         `inField` 已经在上面 return 掉了，所以卡片里正在编辑的那段文字
         走的是**浏览器自己的**复制粘贴（那才是用户要的），我们绝不抢。
         ⚠ 不判 `onPaper`：复制粘贴是**全局**的（不像 Delete 那样"面板上的不算"）——
           用户点了一下关系面板里的名字，一样该能复制板上框住的东西。 */
      if (mod && (e.key === 'c' || e.key === 'C')) {
        /* 有真的选中文字时让浏览器自己来（比如用户拖亮了一段名字想复制）——
           抢过来会让他"复制了别的东西"，而屏幕上一点提示都没有。 */
        const picked = typeof window.getSelection === 'function' ? window.getSelection() : null
        if (picked && String(picked).length) return
        e.preventDefault()
        copySel()
        return
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        pasteSel()
        return
      }
      /* ★ 规整形状（2026-09-18）：Ctrl+Shift+S。
         为什么是它：「S」已经单独给了框选工具（见下面那行），
         加 Shift 得到一个"和框选是一路、但不是同一件事"的键 ——
         规整的前提本来就是"先框住"，脑子里那条线接得上。
         ⚠ 必须排在下面 `if (e.key === 's')` **之前**，而且必须带 mod 判据：
           不然 Shift+S 会被下面那句吃掉，变成"切到框选工具"（什么都不会发生，
           而用户以为规整过了 —— 这种"静默地什么都没做"最难查）。 */
      if (mod && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        regularizeInkSel()
        return
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        // 装回屏幕 = 程序适配，不是你定的视野 → pin=false，下次打开还会重新适配
        fitToScreen()
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
      if (e.key === 'Escape') {
        /* ★「一次只收一层」这个顺序住在 `focus.js` 的 `escapeIntent` 里（候选 7）：
           浮着的那排词 → 板框改名 → 取消焦点。
           （Esc 是**全局**的：在浮层按钮上按 Esc 也该收走 —— 只有删除那一族要分纸面/浮层。） */
        const it = escapeIntent({ focus, linkPick })
        if (it.kind === 'none') return
        e.preventDefault()
        if (it.kind === 'dismiss-link') return setLinkPick(null)
        if (it.kind === 'end-frame-edit') return setFocus(endEdit)
        setFocus(FOCUS_NONE)
        return
      }
      /* ★ 删除 / 拆开："该谁管、管什么"整个在 `focus.js` 的 `deleteIntent` 里 ——
         焦点是一个值，所以"先看谁"写在**类型**里（从前是三个分支各查一个子集，
         而且不区分纸面和浮层：点一下浮层里那一行再按 Backspace 会把板框拆开，
         `preventDefault` 还顺手吞掉浏览器的后退 —— review 当场走到的那个 bug。
         当年最常踩的就是关系面板那一行，它现在已经整块删掉了）。 */
      const del = deleteIntent(focus, e.key, e.target)
      if (del.kind === 'dissolve-frame') {
        e.preventDefault()
        const f = (boardRef.current.frames || []).find((x) => x.id === del.id)
        if (f) {
          commit((cur) => dissolveFrame(cur, f.id))
          setFocus(FOCUS_NONE)
          flash('拆开了 —— 里面的东西照旧留在板上', 'ok')
        }
        return
      }
      if (del.kind === 'delete-ink') {
        e.preventDefault()
        deleteInkSel()
        return
      }
      if (del.kind === 'delete-card') {
        e.preventDefault()
        /* ★ 固定的卡片不给删。它是"锁住"的语义，而 Delete 是最容易误按的一个键。
           （它平时选不中，所以正常路径下也走不到这儿 —— 留这道闸是因为"选不中"
           是 CSS 的 pointer-events 保证的，不是类型保证的。）想删就先点 📌 解开。 */
        const card0 = boardRef.current.cards.find((c) => c.id === del.id)
        if (card0 && card0.locked === true) {
          flash('这张卡固定着，先点它左下角的 📌 解开再删', 'warn')
          return
        }
        commit((cur) => ({ ...cur, cards: cur.cards.filter((c) => c.id !== del.id) }))
        setFocus(FOCUS_NONE)
        return
      }
      if (e.key === 'p' || e.key === 'P') return setTool('pen')
      if (e.key === 'e' || e.key === 'E') return setTool('eraser')
      // S = select：框选。挑 S 是因为它没被占（P 是笔、E 是橡皮、W 是写字板、Space 是平移）
      if (e.key === 's' || e.key === 'S') return setTool('select')
      /* A = arrow：箭头工具（一次性的，见 ADR-0001）。挑 A 是因为它没被占，
         而且"Arrow"这个词本身就带着它 —— 用笔的人不用跑去点栏上那颗按钮。 */
      if (e.key === 'a' || e.key === 'A') return pickArrow()
      // W = write：写字板。挑 W 是因为它没被占（P 是笔、E 是橡皮、Space 是平移）
      if (e.key === 'w' || e.key === 'W') {
        setPadOpen((v) => !v)
        return
      }
      /* F = 公式架（Formula shelf）。挑 F 是因为它没被占，而"公式"两个字都带 f。
         ⚠ **必须排掉 mod**：Ctrl+F 是浏览器自己的"查找"，抢过来就是"我想查个字，
         架子却蹦出来了"。上面那些带 mod 的分支各自 return，但 Ctrl+F 不在其中 ——
         所以这一条得自己判，不然它会漏下来撞上。 */
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        toggleShelfRef.current()
        return
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
  /* 依赖里那个 `focus` 就是这一刀的收成：从前这里是 selectedId / inkSel / frameEditId /
     selectedFrameId 四个 —— 四个里漏一个，"按键读到的是旧的焦点"（删错东西）。
     `copySel` / `pasteSel` 也必须进来：它们闭包住 `inkSel` / `sel`，
     漏了就会"框住了新的一撮、Ctrl+C 复制的还是上一撮"。 */
  }, [undo, redo, setView, focus, commit, deleteInkSel, linkPick, linkByStroke, copySel, pasteSel, regularizeInkSel, pickArrow, flash])

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
    setFocus(focusCard(c.id, true))
    /* ★ 写字板这条路上来的公式卡**也要量一次尺寸**：完全贴着式子。
       不量的话它就是默认的 260 宽：一行 `E = mc²` 只有 60 宽，居中之后左右全是空的
       （用户 2026-09-16 报的"识别公式留白依旧很多"，多半就是这张）。
       keepCenterX：卡片是以视野中心放上去的，收宽度要**从中间缩**，不然会往左跳。
       （排队自己就会下一帧开跑；这一次进编辑态量不着，退出编辑时那一趟才量得上。） */
    fitter.queue(c.id, { fitWidth: true, keepCenterX: true })
  }

  /* ══════════ 公式架：这条板上"认过一次"的公式，随手再放一张（2026-09-20）══════════
   *
   * 用户的原话是「一次课往往会多次用到同样的公式」——所以取用必须只有**一下**：
   *   点一格 → 放到**视野中心**（和粘贴同一条规矩：「贴在我正看着的地方」）；
   *   拖一格 → 落在**松手的地方**（指哪放哪）。
   *
   * ★ 放下来的是**一张独立的新卡**（各自可改可删）——用户选的就是这一条。
   *   它和原来那张唯一的联系是"内容来自它"，而且这个联系**一个字都不存**
   *   （没有"同源"字段、没有联动）：那种联动要一整套同步规则，
   *   而推导里每一处用到的公式本来就该各写各的。
   * ★ 其余照抄 `insertRecognized` 那三步（那是"卡片落到板上"的既有形状）：
   *   ① `commit` 一次 = **一步撤销**（不用为它单开一条账）；
   *   ② 落下就**选中**（能立刻拖走 / 缩放手柄就在手边）；
   *   ③ `fitter` 量一次尺寸 —— 不量的话卡是默认 260 宽，一行短式子会左右一片空白。 */
  const shelf = useMemo(() => shelfItems(board.cards), [board.cards])

  const insertFromShelf = useCallback(
    (item, world) => {
      if (!item) return
      const at = world && Number.isFinite(world.x) && Number.isFinite(world.y) ? world : stageCenterWorld()
      const c = newCard('formula', at.x, at.y)
      /* `src` 一起写上（同 `insertRecognized` 那条 ⚠）：编辑态里编辑的是 src，
         只填 tex 的话双击进去是个空框，顺手一个回车就把这张卡清空了。 */
      commit((cur) => ({ ...cur, cards: [...cur.cards, { ...c, src: item.src || item.tex, tex: item.tex || item.src }] }))
      /* ★ 只**选中**，不**进编辑态**（`focusCard(id, true)` 才是编辑）。
         差别不是好看不好看：进编辑态的卡里是个 `<textarea>`，而键盘那道闸是
         "在输入框里打字就不抢按键"（focus.js 的 isTextField）——
         于是放下来之后 **Ctrl+Z 会被输入框吃掉**（撤销不动板上那张卡），
         接着点别处也只是"退出编辑"，看起来就是"点了没反应"。
         取用的语义是"把这条已经认过的公式放到这儿" —— 没有字要改。
         （这条是探针查出来的：`.cache/probe-shelf.mjs` 里那张卡的 activeElement
          是 TEXTAREA，见那一轮的 Ctr+Z 断言为什么红。） */
      setFocus(focusCard(c.id))
      fitter.queue(c.id, { fitWidth: true, keepCenterX: true })
    },
    [commit, fitter, stageCenterWorld]
  )

  /* 从架子上拖出来的那一格，松手时落在哪（`item` 由架子那一层交过来 ——
   * "点了还是拖了"是**指针自己的事**，记在 FormulaShelf 里，这一层只管落点）。
   * ★ 松手落在**画布外面**（工具条上、或窗口外）→ 退回视野中心：
   *   在看不见的地方放一张卡，比"没放成"更让人摸不着头脑。 */
  function dropFromShelf(item, clientX, clientY) {
    const el = wrapRef.current
    let world = null
    if (el) {
      const r = el.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        world = screenToWorld(clientX - r.left, clientY - r.top, boardRef.current.view)
      }
    }
    insertFromShelf(item, world)
  }

  /* 开合公式架。★ 架子空的时候**不做成灰按钮**（和「✨ 美化手写」同一条规矩：
   * 灰按钮点不动、也不教人下一步该干什么）—— 点得动，回一句"先认一个"。 */
  function toggleShelf() {
    if (!shelf.length) {
      flash('公式架上还空着 —— 先「✍ 手写公式」认一个，或者框住手写点「∑ 公式」', 'warn')
      return
    }
    setShelfOpen((v) => {
      const next = !v
      try {
        localStorage.setItem(SHELF_KEY, next ? '1' : '0')
      } catch {
        /* 存不了就只生效这一次（和纸面那条一样） */
      }
      return next
    })
  }

  /* 按键那边要叫到"**当前这一版**的 toggleShelf"（它闭包住 shelf.length）——
     和 `boardRef` / `selRef` 同一个形状：渲染时把最新的那个存进 ref，
     按键处理器（那个 effect 只注册一次）永远拿到最新的那一个。
     ⚠ 别图省事把 toggleShelf 塞进 effect 的依赖里：它是每次渲染都新建的普通函数，
       那样等于每渲染一次就注销 + 重挂一次 window 监听（这个文件里已经有三个了）。 */
  const toggleShelfRef = useRef(null)
  toggleShelfRef.current = toggleShelf

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
    setFocus(locked ? FOCUS_NONE : focusCard(id))
    flash(locked ? '固定住了：拖不动、双击也不会进编辑（点 📌 解开）' : '解开了，可以拖了', 'ok')
  }

  /* 「全部解开」一颗（2026-09-30，上课时用户被 196 张钉住的讲义卡堵住）：
   * 课件整理贴上来的卡**一律先钉住**（见下面贴卡那条 ★★），一节课贴下来一两百张，
   * 每张左下角一颗 📌 —— 想挪版面的人一颗颗点回去不现实，整块板看起来就像"卡死了"。
   * 这颗把**所有** `locked: true` 一次解开；写 `locked: false` 是安全的
   * （序列化只在真的锁了的时候才写这个字段，见 lib/board.js —— 落盘还是干净的）。
   * 对称的"全部固定"故意不做：钉住是贴卡的默认，想钉哪张点哪张的 📌。 */
  function unlockAllCards() {
    const n = boardRef.current.cards.filter((x) => x.locked === true).length
    if (!n) {
      flash('没有钉住的卡', 'ok')
      return
    }
    commit((cur) => ({ ...cur, cards: cur.cards.map((x) => (x.locked === true ? { ...x, locked: false } : x)) }))
    flash('解开了 ' + n + ' 张钉住的卡 —— 现在都能拖了；要重新钉住哪张就点它左下角的 📌', 'ok')
  }

  /* 「⟲ 恢复操作」一颗（2026-09-30，和上面那颗同一天、同一个症状）：
   * 一次手势**没收尾**的时候，它的状态就留在那些 ref 里（按下、平移、捏合、框选、箭头、
   * 整块拖动各有一份）。只要有一份没收，下一次落笔就可能走进"还在上一次手势里"那条路 ——
   * 用户眼里就是：写不出字、按不动卡、选区一直清不掉，**整个白板像死了**。
   * 什么时候会没收尾：切窗口（Alt+Tab）、系统弹窗、手掌误触、笔尖离开屏幕太快 ——
   * 这些时候浏览器常常**一个 pointerup / pointercancel 都不给**。
   *
   * 这一颗就是那个明确的"重新开始"：**把手势状态全部清空 + 取消选中 + 擦掉没画完的那一笔**。
   * 它**不动板上的内容**（一笔一划、卡片位置一个字节都不改），所以点了不会有损失 ——
   * 这也是它比"刷新页面"好的地方：刷新要等重新加载，而写了一半的稿子还在。
   * ⚠ 和 10 秒自愈（见 onPointerDown 那条注）是两道闸，不是重复：
   *   自愈是"下一次落笔时顺手清理"（得等一次落笔），这一颗是"我现在就要好"。 */
  function resetGestures() {
    pointersRef.current.clear()
    pinchRef.current = null
    panRef.current = null
    drawRef.current = null
    lassoRef.current = null
    arrowRef.current = null
    inkMoveRef.current = null
    setLasso(null)
    clearLive(liveRef)
    setFocus(FOCUS_NONE)
    flash('已经把手势和选中都清掉了 —— 板上的东西一个字节都没动', 'ok')
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
      commit((cur) => removePick(cur, ids))
      setLinkPick(null)
      setFocus(clearInkFocus)
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

  /* ── 「这个条件不算」/「条件就是它」：界面入口没有了（2026-09-19）─────────────
   * 条件本来是**位置送的**：写在那条线弧长中点旁边的字/卡自动成为它的条件
   * （读法在 `links.js` 的 `linkCondition` —— **纯数据那一半一个字没动**）。
   * 位置两头都不灵的时候从前有说法：读错了按 ✕（写 `cond:'none'`）、读不到按 ∈
   * 再点一下目标（写 `cond:'card:<id>'` / `'ink:<笔 id>'`），外加一颗 ↺ 当回头路。
   * ★ 这三个写入口唯一的家是**关系面板**，而那块面板整块删掉了（用户：「不需要右侧
   *   关系栏，可以删掉了」，栏里独有的操作一起不要）—— 于是 `selection.js` 的
   *   `vetoCond` / `specCond` / `clearCond` 现在**没有界面入口**了。
   *   数据层留着：老文件里已经写下的 `stroke.cond` 照旧读得出来，只是没有地方显示、
   *   也没有地方写。`readBoard` / `deriveChains` 这类读法一个字节没改。
   * ⚠ 要把它们请回来，别只把面板那段 JSX 抄回来 —— 那三颗按钮得先有个新家
   *   （框住那条线时 `.bd-inkacts` 那排动作是现成的口子），而且**必须配回头路**
   *   （一句话说出口、重开之后就没路，那是单向门）。
   */

  /* 连接线浮层（`.bd-inklink`）上这三颗按钮的处理器：把 `selection.js` 里
     `vetoCond` / `specCond` / `clearCond` 三个纯函数接回界面（关系面板 2026-09-19 删了，
     这是它们的新家）。三个都走 `commit` —— 一句话说出去、按一下 Ctrl+Z 能退回。 */
  function applyVetoCond(link) {
    if (!link) return
    const b = boardRef.current
    const next = vetoCond(b, link)
    if (next === b) return
    commit(next)
    flash('这条连接：条件不算了（Ctrl+Z 能退回）', 'ok')
  }
  function applySpecCond(link) {
    if (!link) return
    const cards = (sel.cards || []).filter((c) => c && c.id)
    const inks = (sel.strokes || []).filter((s) => s.id && s.id !== link.strokeId)
    const targets = [...cards, ...inks]
    if (targets.length !== 1) {
      flash('先框住要当条件的那一张卡（或那一笔），再点「就是它」', 'warn')
      return
    }
    const t = targets[0]
    const value = cards.includes(t) ? `card:${t.id}` : `ink:${t.id}`
    const b = boardRef.current
    const next = specCond(b, link, value)
    if (next === b) return
    commit(next)
    flash(`条件指定为${cards.includes(t) ? '那张卡' : '那一笔'}，按位置读不再生效（Ctrl+Z 能退回）`, 'ok')
  }
  function applyClearCond(link) {
    if (!link) return
    const b = boardRef.current
    const next = clearCond(b, link)
    if (next === b) return
    commit(next)
    flash('这条连接：回到按位置读条件（Ctrl+Z 能退回）', 'ok')
  }

  /* ── 板框：留下 / 拆开 / 改标题 / 整体挪（见 ADR-0001、lib/frames.js）──────────
   * 从前这里叫"固定成一块"（`groups`）：**不可见**、只能装笔迹。现在它是**板框** ——
   * 有框线、有标题、成员可以是笔迹和卡片，还能整体拖动。
   * ★ 归属只在**你按「留下板框」的那一刻**判定：以后再往框里画一笔，它不会自己变成成员
   *   （那又变回"位置猜"，而这次的整个教训就是别猜）。想加就明说（frames.js 的 addToFrame）。
   * ★ 卡片成员就是**框住那些卡片**（`sel.cardIds`）—— 2026-09-21 之前它靠"最后一次
   *   框选的矩形"现算（`lastLassoRef` + `membersInBox`），因为卡片那时不进选区。
   *   现在两者是同一份东西：一次框选框住了什么，复制 / 留下板框 / 缩放旋转
   *   说的是同一句话（各判各的话，三个功能会给出三个答案）。
   *   ⚠ 判据仍然是"卡片**中心**落在框里"（`membersInBox` 那句话），
   *     只是它现在发生在**框选那一刻**，不再是回头再算一遍。 */
  function keepFrame() {
    const b = boardRef.current
    const ids = inkSel ? [...inkSel] : []
    const cards = sel.cardIds
    if (!ids.length && !cards.length) {
      flash('先框住要归到一块的东西（笔杆侧键拖一圈，或者工具条上的「⬚ 框选」）', 'warn')
      return
    }
    const { board: next, movedFrom } = freezeFrameSelection(b, ids, cards)
    commit(next)
    setFocus(clearInkFocus)
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
    /* 拆的就是当前焦点那个框 → 焦点跟着归零（"别的选中留着"在这里没有意义：
       焦点只能有一种 kind，那个框就是它）。 */
    setFocus(FOCUS_NONE)
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
    setFocus(focusFrame(frameId))
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

  /* ══════════════════ 资料：插入 / 拖动 / 移除 ══════════════════
   * 一份 PDF/PPT 铺在画布最底下（DocLayer，z1），注释照常写 ——
   * 笔迹/卡片本来就存世界坐标、画在资料层上面，这里不需要任何新机制。
   *
   * 上传走 `/api/doc/upload`（服务端把 PPT 转成 PDF、存进 data/.资料/）；
   * 拿到路径后 pdf.js 量一次每页尺寸（readDocInfo）存进板文件 ——
   * 以后打开只靠这张尺寸表摆页面，不再解析 PDF。
   */
  const docInputRef = useRef(null)
  /* 这个文件框**这次是给谁用的**：'insert' = 铺到板上当资料；'deck' = 只收进 data/.资料/，
     直接整理成知识点。一个框两个用途，所以意图要在点它**之前**记下来 ——
     `change` 事件里读不出用户点的是哪一颗按钮。 */
  const docIntentRef = useRef('insert')
  /* 非空 = 正在上传/转换/量页面（`who` 决定这句话显示在哪颗按钮上）。 */
  const [docBusy, setDocBusy] = useState(null)
  /* 「要不要只抽这几页」那个小窗开着没有（`null` = 没在问，`total` = 这份有多少页）。
     ★ **一个 Promise 桥**：选文件那趟是异步的，而"用户写了哪几页"要从窗里回来 ——
       本文件里凡是"等用户回一句"的浮层都是这个形状（各写一套的话，一定会有一处忘记关窗）。
       开窗的那个是 `askDocPages`、收话的是 `answerDocPages`。 */
  const [sliceAsk, setSliceAsk] = useState(null)
  const sliceResolveRef = useRef(null)
  /* 刚才那一份是不是**抽出来的**（`maybeSlicePdf` 里置位）：抽出来的那几页就是要
     做题的，所以那句提示得换一套说法 —— 告诉他"圈住题号就能交给老师"，
     而不是"拖顶上的条子挪位置"（他根本不打算挪）。 */
  const slicedRef = useRef(false)

  /** 弹那个小窗，等到用户回了话：回的是页码数组（`[]` = 整本都要、`null` = 算了）。 */
  function askDocPages(ask) {
    return new Promise((resolve) => {
      sliceResolveRef.current = resolve
      setSliceAsk(ask)
    })
  }

  /** 那个小窗交回话（`pages = null` 就是他在框上按了 ✕ / Esc）。 */
  function answerDocPages(pages) {
    const r = sliceResolveRef.current
    sliceResolveRef.current = null
    setSliceAsk(null)
    if (r) r(pages)
  }
  /* 正在整理哪一份课件（非空 = 那个窗口开着）。见下面「课件整理」那一节。
     ⚠ 它**不一定在板上** —— 「直接选文件」那条路给的是一个临时对象（见 readDeckFromFile）。 */
  const [deckFor, setDeckFor] = useState(null)
  /* 作业辅导那个窗口开着没有；`hwDoc` = 窗里选中的是**哪一份**（'' = 板上第一份）；
     `hwTarget` = 这一次是从**框住的那一块**进来的（非空 = {docId, doc, page, region}）。
     见下面「作业辅导」那一节。 */
  const [hwOpen, setHwOpen] = useState(false)
  const [hwDoc, setHwDoc] = useState('')
  const [hwTarget, setHwTarget] = useState(null)

  function pickDocFile(intent) {
    docIntentRef.current = intent
    if (docInputRef.current) docInputRef.current.click()
  }

  /** 收这份之前先看一眼：**这本书有多厚**？够厚的话问他一句"只要这几页吗"。
   *
   *  ★ 三条入口（插入 / 课件整理 / 作业辅导）共用这一处 —— 上传本来就只有
   *    `receiveDoc` 一条路，抽页跟着住在那儿，就不会出现"作业那条路没抽成"这种事。
   *
   *  ⚠ **读不出页数就当它不厚**，原样整本传：部分教材 PDF 是加密/损坏的，
   *    那不该变成一道墙 —— 抽页是给抽得动的那一份准备的便利，不是必经的步骤。
   *  ⚠ `null` = 他在那个框里按了「算了」（整个插入取消，由调用方收摊）。 */
  async function maybeSlicePdf(f, who) {
    if (!f || !/\.pdf$/i.test(f.name || '')) return f
    let pdf = null
    try {
      pdf = await openLocalPdf(f)
    } catch {
      return f /* 读不动：整本传，别拦着他 */
    }
    if (!pdf || !Number.isFinite(pdf.count) || pdf.count < SLICE_ASK_MIN) return f
    setDocBusy({ who, text: '等你说是哪几页…' })
    let pages = null
    try {
      /* ★ 连缩略图那台机器一起递进去：他要"先看一眼是不是这几页"（书上的页码
         和 PDF 的页码常常差一点 —— 封面没算进去）。机器**由那个窗自己**在要画
         第一张时才开，这里不替他开。 */
      pages = await askDocPages({ name: f.name, total: pdf.count, preview: pdf.thumbs })
    } finally {
      /* ⚠ 窗关了就必须把那份 pdf.js 文档放掉：它是**额外**开的一份
         （和屏幕翻页那份并存），一本几百页的书开两份不是小数。 */
      pdf.close()
    }
    if (!pages) return null
    if (!pages.length) return f /* 他要整本 */
    setDocBusy({ who, text: `正在抽 ${pages.length} 页…` })
    const blob = await pdf.slice(pages)
    slicedRef.current = true
    /* ★ 名字里带着页数范围：同一本书抽三段，盘上是三份各有名字的资料，
       回头不会再错认成"这一份怎么只有三页"。 */
    return new File([blob], sliceFileName(f.name, pages), { type: 'application/pdf' })
  }

  /** 收一份课件（PDF/PPT/图片）：上传（服务端把 PPT 转成 PDF）+ 量每一页的尺寸。**不碰板**。
   *  两条路共用：插到板上做资料（`insertDocFile`）、直接整理（`readDeckFromFile`）。
   *  ★ 同一个文件服务端按内容认得住（server-docs.js 的 findByContent）：收过就返回
   *    原来那份（`up.duplicate`），于是缓存、页码、"这是哪一份"全都还对得上。
   *  ⚠ 返回 `null` = 他在"抽哪几页"那个框上按了「算了」（没人收拾键盘/flash，他自己知道的）。 */
  async function receiveDoc(f, who) {
    setDocBusy({ who, text: '正在上传…' })
    try {
      slicedRef.current = false
      const src = await maybeSlicePdf(f, who)
      if (!src) return null
      const fd = new FormData()
      fd.append('file', src)
      const up = await fetch('/api/doc/upload', { method: 'POST', body: fd }).then((r) => r.json())
      if (!up || up.ok === false) throw new Error((up && up.error) || '服务端没回话')
      setDocBusy({ who, text: '正在读页面…' })
      const info = await readDocInfo(up.path)
      return { up, info }
    } finally {
      setDocBusy(null)
    }
  }

  async function insertDocFile(f) {
    if (!f) return
    try {
      const got = await receiveDoc(f, 'insert')
      /* 他在"抽哪几页"那个框上按了「算了」—— 什么都不做（也不骂人：他自己按的）。 */
      if (!got) return
      const { up, info } = got
      /* ★ 抽出来的那几页是**为做题**才挑的 —— 那句话就要顺着说下去：
         "圈住题号 → 做这道题"，而不是"拖条子挪位置"（他根本不打算挪）。
         整本放上来的仍旧说老那一句。 */
      const sliced = slicedRef.current
      /* 板上**已经有这一份**（服务端按内容认出来是同一个文件）：不再摆第二份 ——
         引用同一个 PDF 的两份资料没有意义（docs.js 的 normalizeDocs 也是这么判的），
         而且用户多半只是又点了一次「插入」。 */
      if ((boardRef.current.docs || []).some((d) => d.path === up.path)) {
        flash('这份课件已经在板上了 —— 直接拖它顶上的把手挪位置就行', 'ok')
        return
      }
      /* 摆放：当前视野正中（第一页顶边对准视野上三分之一处），用户再拖。
         宽度用默认 720 世界像素 —— 够读、不霸板（见 docs.js 的 DOC_DEFAULT_W）。 */
      const el = wrapRef.current
      const v = boardRef.current.view
      const at = screenToWorld((el ? el.clientWidth : 800) / 2, (el ? el.clientHeight : 600) / 3, v)
      const doc = {
        id: newId(DOC_ID_PREFIX),
        path: up.path,
        ...(up.title ? { title: up.title } : {}),
        x: Math.round(at.x - DOC_DEFAULT_W / 2),
        y: Math.round(at.y),
        w: DOC_DEFAULT_W,
        pages: info.pages,
      }
      commit((cur) => ({ ...cur, docs: [...(cur.docs || []), doc] }))
      flash(
        sliced
          ? `放好了（${info.pages.length} 页）：圈住题号 → 点浮层上「✎ 做这道题」。页码从头算起，第 1 页就是你要的那一页`
          : `放好了（${info.pages.length} 页）：直接用笔在上面写，拖顶上的条子挪位置`,
        'ok'
      )
    } catch (e) {
      flash('插入失败：' + String(e && e.message ? e.message : e), 'warn')
    }
  }

  /* 整份资料拖动：和板框同一套账（ledger.begin/during/end，一次拖动 = 一步撤销）。 */
  const docDragRef = useRef(null)

  function docDragStart(id) {
    docDragRef.current = { id, g: ledger.begin() }
  }

  function docDrag(id, dxScreen, dyScreen) {
    const st = docDragRef.current
    if (!st || st.id !== id) return
    st.g.during((cur) => {
      const k = cur.view.s || 1
      const dx = screenLenToWorld(dxScreen, k)
      const dy = screenLenToWorld(dyScreen, k)
      return { ...cur, docs: cur.docs.map((x) => (x.id === id ? { ...x, x: x.x + dx, y: x.y + dy } : x)) }
    })
  }

  function docDragEnd(id) {
    const st = docDragRef.current
    docDragRef.current = null
    if (!st || st.id !== id) return
    st.g.end()
  }

  function docRemove(id) {
    commit((cur) => ({ ...cur, docs: cur.docs.filter((x) => x.id !== id) }))
    flash('资料移掉了：PDF 文件还在 data/.资料/ 里，写过的注释也留在板上', 'ok')
  }

  /* ══════════════════ 课件整理：老师逐页讲，讲解贴到那一页旁边 ══════════════════
   *
   * 用户 2026-09-22 要的：「整理出来这个 pdf/ppt 这节课的内容……贴到白板上，
   * 这样就能让学生不从一个空的白板开始，而是从一个**已经有知识的内容**开始」。
   * 2026-09-20 他又把那句话收窄了：「这样子得出来的这些东西只能说是"可以读"但是完全
   * 无法自行理解……我们的目的是让这样整理 pdf/PPT 后学生能够在摆脱老师的情况下仍然
   * 能够学习。所以说这样子，我们 ppt 与 pdf 正常显示，但由你来扮演老师，在每一页的
   * 右侧和左侧都可以进行详细的说明与讲解，标注重点之类的」。
   * 所以现在**课件页在中间，老师的话在两边**：右栏讲解、左栏重点和公式。
   *
   * 三件事，各有各的家：
   *   · 读（渲染页面 + 出网 + 缓存）—— `doc-read.js`；
   *   · 认（模型的话 → 讲解/重点/公式）和摆（→ 世界坐标）—— `doc-cards.js`（纯函数）；
   *   · **这个文件只做本地这三下**：量尺寸、写进板、把尺寸交给 fitter。
   *
   * ★ 摆在哪：**贴着每一页**（`pageRects` 给的页面矩形，左右各一栏，见 doc-cards.js 的
   *   `sideColumns` / `projectDeck`）。为什么不摆在资料上面/中间：那会盖住你正要看的课件页。
   * ★ **课件必须在板上**：这一版的讲解是"贴着页"的，页面上不了板就没有"旁边"可言
   *   —— 所以「直接选文件」那条路现在也把课件铺到板上（见 readDeckFromFile）。
   * ★ 一次 commit 写进去：**一步撤销**把整批卡片全退掉（和"擦原笔迹 + 加卡片"同一条规矩）。
   * ★ 量尺寸要用**当前视图缩放**：卡片的屏幕尺寸 = 世界 × s × k，而"内容折成几行"
   *   只有那个尺寸下才准（和 fitCardSize 量的是同一个东西，见 doc-cards.js 那一节）。
   */
  /** 「这一份在不在板上、是哪一条」—— **只有这一处说了算**（摆卡片和窗口的预选都用它）。
   *  先按 id 找（板上那份）；找不到再按 path 找 —— 用户选的正好是板上已经有的同一份 PDF 时，
   *  服务端按内容认、返回的是同一个路径（见 server-docs.js 的 findByContent），
   *  那就该当成"就是板上那一份"：卡片贴着它摆、预选也跟着框走。
   *  ⚠ 认不出来 = 这份只在 `.资料/` 里（"直接选文件"那条路）—— 卡片落视野中心。 */
  function boardDocOf(d) {
    if (!d) return null
    return (boardRef.current.docs || []).find((x) => x.id === d.id || x.path === d.path) || null
  }

  /** 课件整理 · **直接选文件**那条路：把文件收进 `data/.资料/`、**铺到板上**，然后开窗。
   *  ★ 为什么这一版一定要铺到板上（2026-09-20 改）：讲解是"贴着每一页"摆的
   *    （右栏讲解、左栏重点和公式），页面上不了板就没有"旁边"可言。
   *    上一版是知识点卡排在资料右边，所以那会儿可以不铺 —— 产出换了，这条跟着换。
   *  ★ 板上已经有这一份（服务端按内容认得出来）就**不再摆第二份**，直接用它。
   *  ⚠ 同一份文件再选一次**不会**在 `.资料/` 里多存一份，于是缓存照样命中：
   *    讲过的页不会再花一次钱（doc-read 的缓存键是"路径 + 页号"）。 */
  async function readDeckFromFile(f) {
    if (!f) return
    try {
      const got = await receiveDoc(f, 'deck')
      if (!got) return /* 「算了」—— 同上 */
      const { up, info } = got
      let doc = (boardRef.current.docs || []).find((x) => x.path === up.path) || null
      if (doc) {
        flash(`这份课件已经在板上了（${info.pages.length} 页）—— 直接用` + (up.duplicate ? '它原来那份' : ''), 'ok')
      } else {
        /* 摆放：当前视野正中（第一页顶边对准视野上三分之一处），和「📄 插入 PDF/PPT」同一条规矩。
           ★ 左右各留一栏的空（SIDE_W + 间距 + 一点余量）：不这样的话，第一次开窗时
             左栏会被挤到视野外面去，用户以为没贴。 */
        const el = wrapRef.current
        const v = boardRef.current.view
        const at = screenToWorld((el ? el.clientWidth : 800) / 2, (el ? el.clientHeight : 600) / 3, v)
        doc = {
          id: newId(DOC_ID_PREFIX),
          path: up.path,
          ...(up.title ? { title: up.title } : {}),
          x: Math.round(at.x - DOC_DEFAULT_W / 2),
          y: Math.round(at.y),
          w: DOC_DEFAULT_W,
          pages: info.pages,
        }
        commit((cur) => ({ ...cur, docs: [...(cur.docs || []), doc] }))
        flash(`课件放好了（${info.pages.length} 页）—— 挑一段，让老师逐页讲`, 'ok')
      }
      setDeckFor(doc)
    } catch (e) {
      flash('收这份课件失败：' + String(e && e.message ? e.message : e), 'warn')
    }
  }

  /* ══════════════════ 作业辅导：你报"第几页第几题"，每题给一份答案 + 解析 ══════════════════
   *
   * 用户 2026-09-22 要的（原话抄在 HomeworkBox.jsx 的文件头）：
   *   · 作业**通常在书上** —— 所以要挑"作业所在的那一份 PDF"，
   *     而他手上常常只有讲课的 PPT（挑错时要提醒他补传，窗口里那条 `pptHint` 管这事）；
   *   · 报"第几页第几题"，**结合本节课的知识**（板上那些讲解卡）答得更准；
   *   · 每题一份**答案 + 解析**，解析说人话。
   * ★ 这个入口只做**一件本地的活**：把作业那份收进来（上传 + 铺到板上）。
   *   出网、解析回话、那个窗口都在别处（homework-read.js / homework.js / HomeworkBox.jsx）——
   *   和「课件整理」同一条分工：Board 只管"板上多了一样东西"。
   * ★ **铺到板上是用户选的**（2026-09-22 问他"作业 PDF 要不要铺到板上"，他选"也铺到板上"）：
   *   作业是要**做**的，铺上去才能在书上圈题、写过程；不用了从资料条上 ✕ 掉。
   */
  async function readHomeworkFromFile(f) {
    if (!f) return
    try {
      const got = await receiveDoc(f, 'homework')
      if (!got) return /* 「算了」—— 同上 */
      const { up, info } = got
      const onBoard = (boardRef.current.docs || []).find((x) => x.path === up.path) || null
      if (onBoard) {
        flash(`这份已经在板上了（${info.pages.length} 页）—— 就用它` + (up.duplicate ? '原来那份' : ''), 'ok')
      } else {
        /* 摆放：和「📄 插入 PDF/PPT」同一条规矩（视野正中，第一页顶边对准上三分之一处）。 */
        const el = wrapRef.current
        const v = boardRef.current.view
        const at = screenToWorld((el ? el.clientWidth : 800) / 2, (el ? el.clientHeight : 600) / 3, v)
        const doc = {
          id: newId(DOC_ID_PREFIX),
          path: up.path,
          ...(up.title ? { title: up.title } : {}),
          x: Math.round(at.x - DOC_DEFAULT_W / 2),
          y: Math.round(at.y),
          w: DOC_DEFAULT_W,
          pages: info.pages,
        }
        commit((cur) => ({ ...cur, docs: [...(cur.docs || []), doc] }))
        flash(`作业放好了（${info.pages.length} 页）—— 在窗口里写「第几页第几题」`, 'ok')
      }
      setHwDoc(up.path)
      setHwTarget(null)
      setHwOpen(true)
    } catch (e) {
      flash('收这份作业失败：' + String(e && e.message ? e.message : e), 'warn')
    }
  }

  /** 开「作业辅导」那个窗。**两条入口走同一个动作**（工具条那颗 + 选区浮层那颗）——
   *  和「？问这里」同一条纪律：**判断只写一处**，两条入口各写一份的话，
   *  "什么情况下能圈题"一定会有一处漏掉（这个仓库为"同一句话两份实现"栽过两次）。
   *
   *  ★ 你**框住了课件页上的一块**（多半就是题号）就带着它进去：那时候"做哪道题"
   *    由那个框说了算，窗里连页码都不用写 —— 用户 2026-09-22 要的第二种选法
   *    （「选题目允许靠用户圈住题号来实现」）。
   *  ★ 没框住东西（或者框里没有课件页面）就开一个空窗，靠打字说"第 12 页第 3 题"。
   *    ⚠ 这里**不拦**"框里没有课件"那一种：那个框对打字那条路毫无影响，
   *      为了它把窗拦下来，用户还得先去取消框选才能问 —— 那才是添乱。 */
  function openHomework() {
    const hit = askRegion
    if (hit) {
      setHwDoc(hit.doc.path)
      setHwTarget({ docId: hit.doc.id, doc: hit.doc, page: hit.page, region: hit.region })
    } else {
      setHwTarget(null)
    }
    setHwOpen(true)
  }

  function deckCardNodes(tex) {
    /* 公式卡在板上长这样（Board.jsx 的 Card 里是 `<Tex tex block />`）——
       量尺寸必须用**同一个形状**，不然量出来的是另一种排版。 */
    const span = document.createElement('span')
    span.className = 'bd-tex-in'
    /* ★ 走 `renderMath.js` 那一份（全仓只有它调 katex，且带缓存 ——
       同一批讲义反复量尺寸不会把同一个式子排上几十遍）。 */
    const html = katexHtml(tex, { throwOnError: false, displayMode: true, strict: false, trust: false })
    if (html == null) return null
    span.innerHTML = html
    return span
  }

  /** 把老师讲解贴到板上（**贴着每一页**：右栏讲解、左栏重点和公式）。
   *  返回**到底贴上去没有** —— 调用方拿它决定要不要说一句
   *  （"量不出来"那条路上如果只 return，用户看到的是"点了没反应"）。 */
  function placeDeckCards({ items, pages }) {
    if (!items || !items.length) return false
    /* ★ 这一版**必须贴在页面上**（右栏讲解、左栏重点，都靠页面矩形定位）——
       资料不在板上就没有"旁边"可言。理论上走不到这里（开窗前一定先把课件铺上），
       但宁可说一句也不要点完没反应。 */
    const d = boardDocOf(deckFor)
    if (!d) {
      flash('这份课件不在板上 —— 先把它铺到板上，讲解才有地方贴', 'warn')
      return false
    }
    const rects = pageRects(d)
    /* ⚠ 量尺寸的台子挂在**板容器**里（不是 document.body）：卡片字号里的 `--s`
       由板容器定，挂错了地方量出来的高度会比板上真实的大一截，
       紧接着摆的那张卡就会压在它身上（见 doc-cards.js 的 makeMeasureHost）。 */
    const host = makeMeasureHost(wrapRef.current)
    let made
    try {
      made = measureDeck({
        items,
        renderTex: deckCardNodes,
        /* 讲义卡的正文渲染：**和 Card 那一侧同一个 richHtml**（见 rich.js）。 */
        renderRich: richHtml,
        host,
        s: boardRef.current.view.s || 1,
        /* ★ 文字卡**固定一栏宽**（SIDE_W）：讲解是几段话，按内容量会成一条又宽又矮的横幅。 */
        fixedW: SIDE_W,
      })
    } finally {
      if (host.parentNode) host.parentNode.removeChild(host)
    }
    if (made.missing) flash(`有 ${made.missing} 条量不出尺寸（多半是公式排不出来），这一次没贴它们`, 'warn')
    const sized = items.filter((it) => made.sizes.has(it.id))
    if (!sized.length) return false

    /* ★★ 两半：**整节课那一层**（提纲 + 须知，一份各一张，落在第一页左边）
       和**逐页那些**（落在每页两侧）。
       为什么必须在这里分开：`projectDeck` 的循环是**严格按页走的**（它靠 `rects[n-1]` 定位，
       靠 `pageGaps` 推下一页），而它们**没有页号**（`page: 0`/`sectionId: null`）——
       混进去就是两个后果：① 它们被归到 `page: 0` 那一组，`rects[-1]` 取不到，
       `noRect` 里多一个 `0`，然后 flash 里冒出一句"有 1 页在板上找不到位置（页号对不上？）"
       ——一句**没有指任何人**的错；② 就算给它们一个页号凑进去，它们也会把那页的
       `pageGaps` 算高一截，把后面所有页往下推（而它们自己不占那个位置）。
       ⚠ 判据用 `isDeckLevel`（住在 doc-summary.js），**不要在这里写 `kind === 'summary'`**：
         那种字面量散开之后，"加一种没有页号的卡"就得改好几处 —— 而漏掉一处的表现
         正是上面那两种（一个是没指任何人的 flash、一个是整版往下错）。 */
    const deckLevel = sized.filter((it) => isDeckLevel(it))
    const onPage = sized.filter((it) => !isDeckLevel(it))

    /* ★★ 「整节课那两张先站住第一页左栏」——在摆逐页那些卡**之前**先把这一栏让出来。
       为什么非让不可：整节课那两张和逐页那些卡**不是一起摆的**（前者走 placeDeckCard、
       后者走 projectDeck），而两者都可能落在"第一页左栏、从页顶起"这同一块地上 ——
       逐页的左栏从 `occupied` 起摆，而 `occupied` 是从**板上现有的卡**算的，
       里面**没有**这些还没落地的卡。于是第一页的重点卡和它们正正压在一起。
       用户那边这**看不出来**（要一张张拖开才知道自己少看了一张）。
       ⇒ 顺序反过来：先把它们量好、占位写进 `occupied`，再交给 projectDeck。
          `pageGaps` 照旧不含它们（铁律②：整节课那两张不把任何一页往下推）—— 这里只动
          "这一栏从哪儿开始摆"，不动"这一页占多高"。
       ★ 两张之间也靠同一个机制排开（后一张从**前一张的底边**起），
         所以它们不会自己叠在一起 —— 见上面那个 for 里 `usedDeck` 那段。

       ⚠ 占位算的是**整条左栏横带**的高度，不是"提纲自己的宽那块地"：
         左栏那几张是**右对齐到资料左边**的（`x = r.x - gap - sz.w`），
         所以它们的**左边缘**随各自宽度浮动 —— 只按提纲真正的宽去占，
         一张更宽的重点卡照样会伸到提纲左边、和它叠上。
         这条横带一占，谁摆进来都压不着。 */
    const occupied = columnOccupancy({ rects, cards: boardRef.current.cards || [] })
    /* ── 整节课那两张：**一张接一张**占住第一页左栏 ──────────────────────────
       ★ 顺序由**条目表里的先后**定（DeckReview 的 `confirm` 就是把提纲放前面、须知放后面）——
         这里不自己排序：摆版的顺序和界面上看到的顺序、以及交给模型读的顺序是**同一个**，
         三处各排一遍必然有一处不一样（而"须知在提纲上面"这种不一致没人会去查）。
       ★ 两张共用 `placeDeckCard`：第一张从 `occupied` 起、第二张从**第一张的底边**起 ——
         "我怎么知道我是第几张"这件事被折成"调用方把 `used` 抬上去"，函数本身不用知道。
       ⚠ 只动 `[0]`（第一页）：整节课那两张只占第一页，别的页一个字节都不该被动。
       ⚠ `rects[0]` 可能没有（一页都没铺），那时 `spot` 也必然是 null。 */
    const deckCards = []
    const usedDeck = []
    for (const it of deckLevel) {
      const sz = made.sizes.get(it.id)
      const spot = sz
        ? placeDeckCard({ rects, used: occupied[0] ? occupied[0].left : null, w: sz.w, h: sz.h })
        : null
      if (!spot) {
        flash(`这一块${it.kind === RULES_KIND ? '做题须知' : '提纲'}在板上找不到第一页（课件没铺好？）—— 这一块没贴`, 'warn')
        continue
      }
      deckCards.push(it)
      usedDeck.push({
        /* ⚠ 这个 `kind` 是**条目层**的（`SUMMARY_KIND` / `RULES_KIND`），不是板层的 ——
           它只用来让下面 `fresh` 认出"这一张要打 `sum: true` / `rules: true`"。
           它**不会**原样写进板文件（`newCard` 会把板层的 kind 定成 'note'）。 */
        span: { ...spot, side: 'left', page: 0, kind: it.kind, itemId: it.id, text: cardText(it) },
      })
      /* ★ 占位：把"第一页左栏占到哪儿了"这个数**抬到这一张的底边**。
         整节课那两张贴在资料左边、从页顶起，和左栏的卡片是同一条横带
         （都右对齐到资料左边缘），所以它们的底边就是左栏新的起点。 */
      if (rects[0] && occupied[0]) {
        const had = occupied[0].left
        occupied[0].left = Math.max(had == null ? -Infinity : had, spot.y + spot.h)
      }
    }

    /* 按页分组（摆版按页走：一页一个"讲台"）。 */
    const byPage = new Map()
    for (const it of onPage) {
      const n = Number(it.page) || 0
      if (!byPage.has(n)) byPage.set(n, [])
      byPage.get(n).push(it)
    }
    const plan = projectDeck({
      pages: [...byPage].map(([page, list]) => ({ page, items: list })),
      sizes: made.sizes,
      rects,
      /* ★ 这一页两栏里**已经有的东西**（「留到板上」留下的答案卡、你自己拖过去的卡，
         以及**刚刚占住第一页左栏的那些整节课的卡**）—— 讲解接在它们下面，不许压上去
         （`columnOccupancy` 那一段说了为什么）。 */
      occupied,
      /* ★ 资料里**已经写着的**空：`rects` 里已经含着它们，shift 只能累加增量 ——
         不传的话，在整理过的课件上再整理一次，第 2 页开始的卡片会一页比一页低
         （见 projectDeck 的 `existing` 那一段）。 */
      existing: d.pageGaps,
    })
    /* ⚠ `deckCards` 是**条目表**里那几张（`deckLevel` 里量得出尺寸的那些），
       `usedDeck` 才是它们的落点。两者一一对应（上面那个 for 同时 push 的）。 */
    const allCards = [...plan.cards, ...usedDeck.map((u) => u.span)]
    if (!allCards.length) return false
    if (plan.noRect.length) flash(`有 ${plan.noRect.length} 页在板上找不到位置（页号对不上？），那几页的讲解没贴`, 'warn')

    /* ★★ 贴上去的卡片**一律先钉住**（`locked: true`）——
       用户 2026-09-22：「这些解说的卡片生成后默认状态应该是定住的，用户要移动再解开」。
       理由就在这条功能的用法里：整理完是**照着课件往下读**，而用笔的人手会一直蹭到屏幕，
       位置定好的讲义卡一蹭就被拖走（或者点出一堆手柄），一节课下来版面全乱。
       钉住之后卡片变成"纸的一部分"：拖不动、双击不进编辑、📌 也选不中
       （框选会跳过 `locked`，见上面框选那一段），但**笔照样能在它上面写字**
       （墨迹层本来就画在卡片上面）—— 那正是"一边读讲解一边在旁边推公式"。
       要动它：卡片**左下角那颗 📌** 一直亮着（锁定的卡只剩它能点），点一下就解开。
       ⚠ 它写进文件的是 `locked: true` —— 这是**有意的**，不是漏了个默认值：
         素材卡的"钉住"是这条功能的产物，重开这张板得还是钉住的。
         代价：同一段页再整理一次，老卡片的 `locked` 不会被这次的行为覆盖（它们已经钉着了）。 */
    /* ⚠ 贴的是 **`allCards`**，不是 `plan.cards` ——
       `plan.cards` 只有逐页那些（`projectDeck` 的产出），整节课那两张在 `usedDeck` 里。
       第一版这里写的是 `plan.cards.map(...)`，后果是：`allCards` 只用来做"一条都没有"的判空，
       提纲那一张**算出来了位置、也进了 flash 那句话，但从来没被 commit** ——
       文件里没有它（屏幕上也没有），而界面上一切正常（不报错、右下角还写着"提纲在第一页左边"）。
       ★ 这正是这一节自检要抓的那一类错："说了会贴，但没贴"。 */
    const fresh = allCards.map((c) => {
      /* ★ 卡上记一句"**我讲的是第几页**"（`ask: { doc, page }`）。
         ⚠ 这不是多余的字节：讲解卡摆在页面**旁边**，不压在页面上 ——
            没有它，「？问这里」在圈住讲解卡时认不出该问哪一页，那颗按钮永远是灰的
            （用户 2026-09-22 报的「问这里依旧无法框选解说卡片」就是这一条）。
            规矩（认不出的不硬凑、形状只有一种）在 ask-region.js 的 `normalizeAsk`。
         ★ 整节课那两张**没有 `page`**（它们不属于任何一页）→ `from` 是 null，
           于是它们**不带 `ask`**。「圈住整节课的提纲 → 问这里」这件事在语义上就说不通
           （问哪一页？），而 ask-region 那条路本来就是按页找的 —— 不给它们 ask 是对的，
           不是漏了。 */
      const from = c.page ? { ask: { doc: d.path, page: c.page } } : null
      return c.tex
        ? { ...newCard('formula', 0, 0), x: c.x, y: c.y, w: c.w, h: c.h, src: c.src, tex: c.tex, locked: true, ...from }
        : /* 讲义卡（讲解 / 重点 / 整节课的提纲 / 做题须知，以及「留到板上」那张答案卡）：
             正文里有 `$…$` 的式子要排出来（`rich: true`）。
             ⚠ `contentAt` 不在这一条路上 —— 它算的是**要往板上写多少空**，
               而这里的 `plan.pageGaps` 只由 `projectDeck` 报（整节课那两张不在其中）。
             ★★ **整节课那两张在板上的 `kind` 仍是 `'note'`（不是 `'summary'`/`'rules'`）**——
               这一条是有讲究的，别"顺手改对"：
               · `Board` 的 `kind`（`CARD_KINDS`）管的是**画成什么形状**（公式 or 文字），
                 只有两种；它们就是文字卡，画法一个字都不差。
               · 加第三种要动 `newCard` 的白名单、`Card` 的分支、`board.js` 的
                 normalize —— 而它们**一个**渲染分支都用不上（`ink` 那条路已经是
                 "出处写在**另一个字段**上，不动 kind"的先例，见 CONTEXT.md）。
               · 所以出处记在 `sum: true` / `rules: true` 这两个**独立字段**上
                 （和 `ask` / `rich` 平级）：要认"这是整节课的提纲"就查 `sum`，
                 要认"这是做题须知"就查 `rules`，而不是查 kind。
                 ★ 两个字段而不是一个"是整节课的东西"：两者的**去处不同** ——
                   `homework.js` 的 `collectKnowledge` 会把它们分两段摆，
                   而 `spotOfCard` 用同一个判据把它们都钉成 `page: 0`。
               ⚠ 判据仍然走 `isDeckLevel` / `isSummary` / `isRules`（doc-summary.js）——
                 别在别处写 `kind === 'summary'` 字面量（那两份东西是**条目层**的 kind）。 */
          { ...newCard('note', 0, 0), x: c.x, y: c.y, w: c.w, h: c.h, text: c.text, rich: true, locked: true, ...(c.kind === SUMMARY_KIND ? { sum: true } : c.kind === RULES_KIND ? { rules: true } : null), ...from }
    })
    /* ★ 卡片和"每页多占的那点空"**一次 commit 写进去**：两者是一件事 ——
       讲解把这一页撑高了，下一页就得往下挪（`projectDeck` 算出来的 pageGaps）。
       分两次写的话，中间那一帧卡片和页面对不上（看着像贴歪了）。
       ★★ 而且这一批里**只要有哪一页的空涨了，它后面那些页上「已经在板上」的卡片
          也得跟着挪**（2026-09-23，和 `keepAnswer` 那条同一个不变量）。
          这一条在"分次整理"时最要命 —— 用户那张板就是先整理了 24~30 页、
          后来又整理 37/38 页：后整理的那一页只要比页面高，下面已经摆好的讲解卡
          当场全错位，而文件里看不出来（`pageGaps` 只记了"多高"，
          没记"谁因此被推下去"）。判据和挪法都在 `shiftLaterPageCards`。 */
    let shiftedMoved = 0
    commit((cur) => {
      const keep = Array.isArray(d.pageGaps) ? d.pageGaps.slice() : []
      for (let i = 0; i < plan.pageGaps.length; i += 1) {
        const g = Number(plan.pageGaps[i]) || 0
        if (g > 0) keep[i] = Math.max(Number(keep[i]) || 0, g) // **只涨不缩**：地占下了就留着
      }
      const shifted = shiftLaterPageCards({ cards: cur.cards || [], docPath: d.path, deltas: pageGapDeltas(keep, d.pageGaps) })
      shiftedMoved = shifted.moved
      return {
        ...cur,
        docs: (cur.docs || []).map((x) => (x.id === d.id && keep.some((v) => v > 0) ? { ...x, pageGaps: keep } : x)),
        cards: [...shifted.cards, ...fresh],
      }
    })
    /* 落进 DOM 之后**再让 fitter 量一趟**（它量的是同一套数，所以通常一次就收敛）——
       这是"卡片贴合内容"那条规矩的第二道保险：万一我这边的换算差了半像素，
       它会收拢到卡片自己算出来的那个数，而不是把一个错值永远留在文件里。
       ⚠ `fitWidth: false`：宽度是我按一栏宽钉死的（SIDE_W），别再让它收一遍 ——
         那会把讲解卡拉成一条 1200 宽的长条。 */
    for (const c of fresh) fitter.queue(c.id, { fitWidth: false })

    /* 贴完**把视野挪到第一页**："讲好了"那句话是不够的 —— 卡片落在几十页之外时，
       你看不见它们，会以为没贴上去（用户报过这一类）。缩放一个字节不改（只平移），
       把**你整理的第一页**摆到偏左偏上的位置：左边那栏重点、右边那栏讲解都进视野。
       ⚠ 用 `plan.rects`（已经加过"前面那些页多占的空"）—— 用原来的 y 会偏上一大截。
       ★ 有提纲那一张时**更要把左边让出来**：它就在第一页左边那一片，
         而 `0.42` 那个位置本来就是"左边那栏也在视野里"。提纲比左栏那几张宽不了多少
         （同一栏宽），所以这个数不用为它单独调 —— 它落在同一片视野里。 */
    const el = wrapRef.current
    const nums = (pages || []).map(Number).filter((n) => n > 0).sort((x, y) => x - y)
    const finalRects = plan.rects || rects
    const anchor = (nums.length && finalRects[nums[0] - 1]) || finalRects[0] || null
    if (el && anchor) {
      const v = boardRef.current.view
      const at = worldToScreen({ x: anchor.x, y: anchor.y }, v)
      setView((cur) => ({ ...cur, tx: cur.tx + el.clientWidth * 0.42 - at.x, ty: cur.ty + el.clientHeight * 0.22 - at.y }))
    }
    /* ★ 这句话里必须带上"**钉住了**"那半句：卡片被钉住是一件**看不出来**的事
       （屏幕上只是"拖不动"），不提前说的话，用户想挪那一栏时只会觉得"卡片坏了"。
       📌 在哪也一起说 —— 锁定的卡只剩那颗按钮能点，找不到它就真的动不了。
       ★ 整节课那两张要**单独点名 + 说清它在哪**：它们不在"每页旁边"那一族的任何一处，
         只说"贴好了"的话，人会往每页旁边找，找不到那一块。
       ★ 两张**分开说**（不是一句"整节课的东西也贴了"）：提纲和须知是两样不同的东西，
         用户找的时候是按名字找的。只有一张时也只说那一张（别说了一样不存在的贴上去）。 */
    const deckNames = deckCards.map((it) => (it.kind === RULES_KIND ? '做题须知' : '提纲'))
    const deckWords = deckNames.length ? `整节课的${deckNames.join('和')}贴在**第一页左边**（${deckNames.length} 块）。` : ''
    flash(
      `老师讲完了：${pagesLabel(pages || [])} —— 讲解贴在每页右边、重点和公式贴在左边（${fresh.length} 张卡）。` +
        deckWords +
        '都**钉住了**（手蹭上去不会把它拖走）：想挪就点卡片左下角那颗 📌 解开。Ctrl+Z 能整批退掉',
      'ok'
    )
    return true
  }

  /* ══════════════════ 「留到板上」：追问 / 作业的答案落成页边的一张卡 ══════════════════
   *
   * 用户 2026-09-22：「把答案留住：追问 / 作业的答案关掉就散」。
   * 完整的设计（五条决定 + 被否掉的替代方案）在 **ADR-0006**；这里只说接线。
   *
   * ── 两个窗和这一层的分工 ────────────────────────────────────────────────
   *   · `AskBox` / `HomeworkBox`：**还是不碰板**（它们拿不到 board）。
   *     它们能做的只有一件事：`onKeep({...})` —— "把这一轮问答留下"这个**请求**。
   *     落成什么卡、摆哪儿、写不写盘，全在这一层决定。所以
   *     "答案会不会污染我的板"这个问题，答案仍然是"**你不点它就不会**"。
   *   · 内容那一半走 `answer-cards.js`（纯函数），几何那一半走 `planAnswerCard`。
   *   · 这里只做四件事：量尺寸、算位置、一次 commit、把话说清楚。
   *
   * ── 为什么是**同步**返回 true/false ─────────────────────────────────────
   * 量尺寸这条链（`measureDeck`）本来就是同步的，而调用方（那两颗按钮）要立刻知道
   * "到底留下了没有"才能把按钮变成「✓ 已在板上」。做成 Promise 的话，
   * 按钮会有一小段"点了没反应"的时间 —— 那正是这一族最糟的失败方式。
   *
   * @param {object} arg
   *   · docPath 这一问是针对**哪一份资料**（`AskBox` / `HomeworkBox` 手上的那一份）
   *   · page    落在第几页（1 起）
   *   · region  页内归一化矩形（圈出来的才有；打字问作业时没有）
   *   · made    `answer-cards.js` 拼好的 `{title, body, clipped}`，或者它的原料
   *   · from    'ask' | 'homework' —— 只用来把 flash 那句话说得准一点
   */
  function keepAnswer({ docPath = '', page = 0, region = null, made = null, from = 'ask' } = {}) {
    const list = boardRef.current.docs || []
    const d = list.find((x) => x.path === docPath) || null
    /* 资料不在板上就贴不了（"旁边"要有东西才叫旁边）—— 说一句人话，别点完没反应。 */
    if (!d) {
      flash('这份课件不在板上 —— 「留到板上」是贴在它那一页旁边的，先把课件铺回来', 'warn')
      return false
    }
    const rects = pageRects(d)
    const n = Math.trunc(Number(page))
    if (!(n > 0) || !rects[n - 1]) {
      flash(`第 ${n || '?'} 页在这份课件里找不到 —— 这张卡没能留下`, 'warn')
      return false
    }
    const item = answerItem('keep1', made)
    if (!item) {
      flash('这一条是空的，没什么可留的', 'warn')
      return false
    }
    /* 量尺寸：**和课件整理同一套**（`measureDeck` + 同一个 richHtml），
       ⚠ 而且文字卡按**一栏宽**量（`fixedW: SIDE_W`）—— 它和讲解卡是同一栏里的两块，
         宽度不一样会看着像两栏。 */
    const host = makeMeasureHost(wrapRef.current)
    let sized
    try {
      sized = measureDeck({
        items: [item],
        renderTex: deckCardNodes,
        renderRich: richHtml,
        host,
        s: boardRef.current.view.s || 1,
        fixedW: SIDE_W,
      })
    } finally {
      if (host.parentNode) host.parentNode.removeChild(host)
    }
    const sz = sized.sizes.get(item.id)
    if (!sz) {
      flash('这张卡量不出尺寸（公式排不出来？）—— 没能贴上去，换个问法再试', 'warn')
      return false
    }
    const plan = planAnswerCard({ rects, page: n, cards: boardRef.current.cards || [], w: sz.w, h: sz.h })
    if (!plan) {
      flash('这一页在板上找不到位置 —— 这张卡没能留下', 'warn')
      return false
    }
    /* 「这一问落在课件的哪一块」（`ask`）：`doc` 存**路径**（不是资料 id —— id 换个会话
       就变了，路径才是那个 PDF 的身份）。认不出就写 `{page}` 甚至整个不写，
       由 ask-region.js 的 normalizeAsk 决定（同一份判据读盘也用）。 */
    const ask = normalizeAsk({ doc: d.path, page: n, region })
    const fresh = {
      ...newCard('note', 0, 0),
      x: plan.x,
      y: plan.y,
      w: plan.w,
      h: plan.h,
      /* ★ 卡上的字必须**和量尺寸那一趟同一份**（`cardText`，doc-cards.js）——
         这里自己拼一遍的话，高度和真实渲染对不上，卡片就会和旁边那张互相压住，
         而"压住"在板上是看不出来的。 */
      text: cardText(item),
      /* 讲义卡：正文里的 `$…$` 要排出来（和讲解卡同一套渲染）。 */
      rich: true,
      /* ★ 出处：**这是一张答案卡**，不是课件整理贴上去的讲解。
         板层 kind 只有 note/formula，所以出处记在独立字段上（和 `sum`/`rules` 同一套路）——
         `homework.js` 的 `isLessonCard` 靠它把答案卡挡在"这节课的知识"外面，
         否则上一题的答案会被当成讲义喂给下一题。 */
      answer: true,
      ...(ask ? { ask } : {}),
    }
    /* ★★ 卡片和"这一页多占的那点空"**一次 commit** —— 和 `placeDeckCards` 同一条账：
       分两次写的话，中间那一帧卡片和页面对不上。`pageGaps` 只涨不缩（地占下了就留着）。
       ★★ 而**这一页的空一旦涨了，它后面那些页上的卡片必须跟着挪**（2026-09-23 用户报的
          「问这里后印上板子会让原本与ppt对齐的卡片错位」）。
          `pageGaps[n-1]` 一写大，`pageRects` 就把第 n 页后面**每一页**推下去，
          而那些页上的卡片是绝对坐标、谁都不会动 —— 页面走了、卡片留在原地。
          用他真板算过：第 37 页那边要涨 418，第 38 页连着它那 5 张卡当场错位。
          ⇒ `shiftLaterPageCards` 把那些卡按**同样的增量**挪一遍（判据是卡片自己
             `ask.page`，见那个函数的说明）。这一笔必须和 `pageGaps`、和这张新卡
             **在同一个 commit 里**，否则中间那一帧就是错的版面。 */
    const was = Math.max(0, Number((Array.isArray(d.pageGaps) ? d.pageGaps : [])[n - 1]) || 0)
    const gap = Math.max(was, Number(plan.pageGap) || 0)
    const delta = gap - was
    /* 交给 `shiftLaterPageCards` 的"涨了多少"：**只有这一页**涨了（这一笔只动第 n 页）。 */
    const deltas = []
    if (delta > 0) deltas[n - 1] = delta
    /* ⚠ `moved` 是在 commit 的**回调**里拿到的（它读的是 `cur.cards`，那一刻的板），
       而 `commit` 是同步的 —— 所以回调返回之后这个变量一定已经填好了，
       下面那句 flash 读得到。别把它改成"commit 之前先算一遍"：那等于读两次板，
       两份读数之间只要有人动一下就会分叉（这个仓库记过十几条这样的账）。 */
    let shiftedMoved = 0
    commit((cur) => {
      const shifted = shiftLaterPageCards({ cards: cur.cards || [], docPath: d.path, deltas })
      shiftedMoved = shifted.moved
      return {
        ...cur,
        docs: (cur.docs || []).map((x) => {
          if (x.id !== d.id) return x
          if (!(gap > 0)) return x
          const keep = Array.isArray(x.pageGaps) ? x.pageGaps.slice() : []
          keep[n - 1] = gap
          return { ...x, pageGaps: keep }
        }),
        cards: [...shifted.cards, fresh],
      }
    })
    fitter.queue(fresh.id, { fitWidth: false })
    /* 落进视野这件事**不用管**：这张卡就贴在你正看着的那一页旁边（追问和作业都是从
       那一页上圈出来的），视野一动反而会把你甩到别处去。 */
    flash(
      `留在板上了：第 ${n} 页右边那一栏（${from === 'homework' ? '这道题' : '这段问答'}成了板上的一张卡）。` +
        (made && made.clipped ? '⚠ 内容太长，后面一段没留下。' : '') +
        /* ★ 挪了别的卡就要说一声（只在这时候说）：不说的话，用户会觉得"我贴一张卡，
           下面的东西怎么自己跑了" —— 而那是**对的**行为，得让他知道是为什么。 */
        (shiftedMoved ? `（这一页比原来高了 ${delta}，后面那 ${shiftedMoved} 张卡跟着往下让了 —— 它们还贴着自己那一页）` : '') +
        '不想要了 Ctrl+Z 退掉；想钉住就选中它点 📌',
      'ok'
    )
    return true
  }

  /* 那排词放在哪：连接线的中点上、再往上让开一点 ——
     线中段常常写着你顺手写的条件（"仅当…"），压在上面会挡住它。
     ★ 还要**夹进画布范围**：浮出来的东西跑到屏幕外或压到底部工具条底下，
     用户就点不到了（缩放柄、美化按钮都栽过这一条，见 README 第 13 条）。 */
  function linkPickAt(midWorld) {
    const el = wrapRef.current
    if (!el) return { x: 0, y: 0 }
    /* 两件事，各自一个家：
       · 世界点 → 屏幕点走 `view.js`（从前这里手推 `midWorld.x * v.s + v.tx`，见第 26/39 条）；
       · "别跑到屏幕外 / 别压到底部工具条底下"走 `chip-placement.js` 的 `chipPlacement`
         （那三个边距是**屏幕**像素、跟着界面走 —— 架构 review 候选 1 的尾巴，2026-09-17 收）。 */
    return chipPlacement(worldToScreen(midWorld, boardRef.current.view), { w: el.clientWidth, h: el.clientHeight })
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
   *
   * ★ 擦原笔迹**默认就擦**（2026-09-22 用户改的：「美化字迹与公式卡默认是放置时都是
   *   自动擦除原有字迹的」）：内容已经抄进卡片、卡片又不盖它，那几笔就是废墨。
   *   想留着原笔迹，面板上那个勾去掉即可（`erase` 从那边来，默认 true 在 InkToCard.jsx）。
   *
   * ★ 擦除和"加卡片"合并成**一次 commit**：一次 Ctrl+Z 把两件事一起退回去。
   *   分开两次 commit 的话，用户按一次撤销只退了擦除、卡片还留着，看起来像"撤销坏了"。
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
    setFocus(focusCard(card.id, true))
    /* 卡片落进 DOM 之后按真实内容量一次尺寸（"留白太多"就是这一步治的）——
       两条轴都收，公式卡和文字卡一样（"就让框贴合公式和字"）。
       擦不擦原笔迹只影响**那几笔还在不在**，不影响卡片多大。
       ★ 插完是进编辑态的，所以这一次量不着（编辑器不是内容）——
         排进队里，等退出编辑时那一趟（`notify('editing-ended')`）量。 */
    fitter.queue(card.id, { fitWidth: true })
    /* 那句话里必须说清"那几笔去哪了"：默认擦掉之后，用户回头想找原来写的字时
       得知道是**这次操作收走的**（而不是"我的字被吃了一张卡"）—— Ctrl+Z 能退。 */
    flash(
      (isFormula ? '公式卡放上去了' : '放上去了') +
        (erase ? '，原来那几笔已擦掉（Ctrl+Z 能退回）' : '，原来那几笔留着（卡片不盖它）')
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

  /* ★★ 卡片层那一层的**基础视图变换**（2026-09-21 第九刀，见 README 第 58 条）。
     卡片现在按世界坐标摆（`left: card.x`），把"世界 → 屏幕"这一份**只写一次**，
     写在装它们的那一层上。公式和 canvas 的 `ctx.setTransform`、
     SVG 的 `viewTransformAttr`、资料层的 `.bd-docworld` 是同一条：
     `translate(tx, ty) scale(s)`，原点 `0 0`。
     ⚠ 别在这里 round（view.js 那条口径：round 是写进 DOM/CSS 那一步的事，
       而这一步就是那一步 —— 但 4 位小数足够，浮点尾巴会让浏览器以为"变了"）。
     ⚠ 它**不含补正**：补正在外面的 `.bd-world` 上（那是"还没重画的那一版"的差），
       两层各表达各的，叠起来正好是屏幕上的最终位置。 */
  const cardWorldStyle = useMemo(() => {
    const v = board.view
    const s = Number(v && v.s) || 1
    const tx = Number(v && v.tx) || 0
    const ty = Number(v && v.ty) || 0
    return {
      transform: `translate(${tx.toFixed(4)}px, ${ty.toFixed(4)}px) scale(${s.toFixed(6)})`,
      transformOrigin: '0 0',
      /* ★★ 把**这一层的缩放**报给 CSS（2026-09-21，修「点白板删除按钮没有用」）。
       *
       * 为什么需要它：卡片上那几颗手柄（× / 缩放柄 / 📌 / ◎）的宽高和贴边偏移
       * 写的是**卡内长度**，而这个祖先的 `scale(s)` 会把它们一起放大 ——
       * 于是"往外越界 10px"在屏幕上变成 `10×s` px。卡片靠到画布边缘时，
       * 越界的那一块落到 `.bd-stagewrap` 的 `overflow: hidden` 外面，
       * 被裁掉之后**一颗像素都点不到**（`elementFromPoint` 回 null）。
       *
       * ⚠ 我第一版把它当成"卡片自己的倍率 `--bd-card-scale`"来修 —— 错了。
       *   `--bd-card-scale` 是 `combinedScale(1, k)`，只含卡自己的 k（默认 1），
       *   而真正放大手柄的是**这一层**的视图缩放 s。实测（卡片贴画布右边沿）：
       *     界面字号档 1.6 → × 可见 95%，缩放柄/📌 落到工具条底下
       *     界面字号档 2.0 → × 可见 **0%**，点上去 elementFromPoint 是 null
       *   （字号档之所以牵动它，是因为 `--s` 会把卡片里的字号撑大 → 卡片变宽 →
       *    右边缘越过画布 → 手柄跟着出界。s 本身由 fitView 定，两件事一起作用。）
       *
       * 送到 CSS 之后，`:root` 那边 `.bd-card-del` 一族把尺寸和偏移都乘 `1/它`，
       * 手柄的**屏幕大小和贴边量就和缩放无关**了。 */
      '--bd-world-s': String(s.toFixed(6)),
    }
  }, [board.view])

  /* ★★ "装回屏幕"要按**界面字号档**折算一下（2026-09-21，用户报「点击白板删除按钮没有用」的第二半）。
   *
   * 为什么：`fitView` 算的是**世界坐标**该缩多少倍，而卡片实际有多大是世界长度 × 字号档
   * （卡里的字号是 `calc(15px * var(--s) * --bd-card-scale)`，`--s` 一调大卡片就撑宽）。
   * 于是"装回屏幕"把世界宽度装进屏幕宽度之后，屏幕上还要再乘一份 `--s` ——
   * 字号档越大，卡片越探出画布。实测（卡片贴画布右边沿、窗口 900×620、字号档 2.0）：
   *   卡片屏幕宽 440，右边缘 896 > 画布右边界 866，出界 30px。
   * 而卡片右边缘之外正是 × 待的地方（`right: -10px`），`.bd-stagewrap` 又是 overflow: hidden ——
   * 那颗 × 就这样被裁掉，屏幕上看着还在，点下去 elementFromPoint 回 null。
   *
   * 修法（两条，缺一个都还是点不到）：
   *   ① 可用宽度按 `--s` 折回去（传 `w / s`）—— 卡片才不会探出**左右**。
   *   ② 可用高度里**扣掉工具条真正占的那一块** —— 卡片才不会探到**底下**。
   *      工具条（`.bd-cbar`）是 `position: absolute` **浮**在画布上的
   *      （见 styles.css / Board.jsx 的渲染结构），`.bd-stagewrap` 的 clientHeight
   *      里**含**它盖住的那一段。实测（窗口 900×620）：
   *        字号 0.95 → 工具条 107px，画布 437px
   *        字号 1.6  → 工具条 222px，画布 392px（换行了）
   *        字号 2.0  → 工具条 254px，画布 **377px 里被盖掉 266px**
   *      字号越大工具条越会换行、越往上涨，而画布高度不变 ——
   *      于是"装回屏幕"把内容居中的那一块，几乎整块压在工具条底下。
   *   ⚠ 工具条高度是**量的**（barRef.current.offsetHeight），不是猜的常量：
   *     它随 `--s` 和窗口宽度换行变化，写死一个数下次加按钮就错。
   *   ⚠ `--s` 和工具条高度都不进 `fitView`（那是个纯几何函数，够不着 DOM，也不该够着）——
   *     在这里折成"世界坐标下的可用区域"再传进去，`fitView` 的口径一个字不用改。
   *   ⚠ 只影响"装回屏幕"这一类**程序适配**；你自己滚轮定的视野（viewPinned）照旧原样保留。 */
  const fitForView = useCallback((w, h) => {
    const s = Number(scale) > 0 ? Number(scale) : 1
    const barW = (cbarRef.current && cbarRef.current.offsetWidth) || 0
    const barH = (cbarRef.current && cbarRef.current.offsetHeight) || 0
    /* ★★ 传的是"**能用的那一块**"，不是"把 screenH 改小"。
       ⚠ 只把高度改小是**修不好**的：那只是让内容缩得更小，而 `fitView` 仍把它
         居中到**整个容器**的一半处 —— 内容照样压在工具条底下
         （实测：卡片顶部越出画布 119px、被工具条压住 139px）。
         要挪的是**居中的那一点**，所以这里传的是可用区域矩形，
         由 `fitViewIn` 负责"在它里面居中"。 */
    return fitViewIn(boardRef.current, {
      x: 0,
      y: 0,
      w: (barW > 0 ? Math.min(w, barW) : w) / s,
      h: Math.max(120, h - barH) / s,
    }, 70)
  }, [scale])

  /* 工具条那颗「⤢ 装回屏幕」和 Ctrl+0 都走这里。 */
  const fitToScreen = useCallback(() => {
    const el = wrapRef.current
    if (el) setView(fitForView(el.clientWidth, el.clientHeight), false)
  }, [fitForView, setView])

  /* ── 卡片那批**稳定回调**（2026-09-21 第九刀，见 CardItem 顶上那段）──
  /* ── 卡片那批**稳定回调**（2026-09-21 第九刀，见 CardItem 顶上那段）──
     ⚠ 每一个都必须是 `useCallback`，而且只依赖"真正会变的东西"（账本 / ref / setState）。
       一旦在里面读到 `board` / `view` / `selectedId`，依赖就会每帧换新，
       CardItem 的 memo 立刻失效 —— **213 张卡又全部重渲染**（就是这一刀要修的病）。
       所以这些函数只做"按 id 办事"，需要的最新板一律走 `boardRef.current`。 */
  const cardSelect = useCallback((id) => setFocus(focusCard(id)), [])
  const cardStartEdit = useCallback((id) => setFocus(focusCard(id, true)), [])
  const cardStartDrag = useCallback((card) => {
    const c0 = card ? boardRef.current.cards.find((x) => x.id === card.id) : null
    /* 一次拖动 = 一步撤销：起点交给账本（"点了一下没拖"由 `end()` 判）。 */
    dragStartRef.current = c0 ? { id: c0.id, x: c0.x, y: c0.y, g: ledger.begin() } : null
  }, [ledger])
  const cardCommit = useCallback((id, patch) => {
    commit((cur) => ({ ...cur, cards: cur.cards.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
  }, [])
  const cardCloseEdit = useCallback(() => setFocus(endEdit), [])
  const cardDrag = useCallback((id, dxScreen, dyScreen) => {
    /* 中途每一帧只改板、不记账 —— 这一次拖动的那一步由 dragEnd 的 `end()` 记。 */
    const g = dragStartRef.current && dragStartRef.current.g
    if (!g) return
    g.during((cur) => {
      /* 屏幕位移 → 世界位移：除以**当前**缩放（不是按下那一刻的）——走 view.js 那一处。
         ⚠ 这里读 `cur.view.s` 是对的：cur 就是**这一帧最新的板**。 */
      const k = cur.view.s
      const dx = screenLenToWorld(dxScreen, k)
      const dy = screenLenToWorld(dyScreen, k)
      return { ...cur, cards: cur.cards.map((x) => (x.id === id ? { ...x, x: x.x + dx, y: x.y + dy } : x)) }
    })
  }, [])
  const cardDragEnd = useCallback(() => {
    const st = dragStartRef.current
    dragStartRef.current = null
    if (!st) return
    /* "点了一下没拖"由账本判（收尾那版板和起点是不是同一个样，数字按 0.5
       世界像素的余量比）—— 从前这里是 `|dx| < 0.5 && |dy| < 0.5`。 */
    st.g.end()
  }, [])
  const cardDelete = useCallback((id) => {
    commit((cur) => ({ ...cur, cards: cur.cards.filter((x) => x.id !== id) }))
    setFocus(FOCUS_NONE)
  }, [])
  /* ── 放大缩小（拖右下角那个柄）──
     ★ 手势的移动/松手**挂在 window 上**，不靠 setPointerCapture、也不靠
       "指针还在手柄上"。两个理由，都是踩出来的：
       ① 手柄只有 18px，鼠标拖两下就出去了，靠元素自己的 onPointerMove
          会当场收不到事件（自检里实测：拖了 120px，倍率纹丝不动）；
       ② 卡片本身会 stopPropagation，窗口级 + 捕获阶段最省事。
     这个手势和"拖动"是同一种东西：中途只改板不进撤销栈，
     松手时由账本补成**一步**撤销（见 startResize）。 */
  const cardStartResize = useCallback((id, rectW, startX) => startResize(id, rectW, startX), [])
  const cardToggleLock = useCallback((id) => toggleLock(id), [])
  /* 「◎ 问我圈的是哪一块」：亮着的那一张才显示 `hide`（见 Card 里那段）。 */
  const cardAskMark = useCallback((card) => toggleAskMark(card), [])

  /* stageProps 里那些东西要一起传给画布：卡片层作为 children（同一个世界原点）。 */
  const stageProps = {
    sceneRef, liveRef, view: board.view, size,
    /* 卡片/板框那一层的容器 ref。给它写"补正"（见 syncViewCorrection）——
       手势里 React 还没把新的 left/top 提交上去时，先靠它把卡片贴到正确位置。 */
    worldRef,
    /* ★ 墨迹画完之后由它回报"画出来了的是哪一版视图"——补正以那个为基准。
       ⚠ 不能省：省了补正就没有基准（`drawnViewRef` 永远是 null），
         而那**不会报错**，只会退回"整块不补" —— 屏幕上看就是滑动照旧。 */
    onViewDrawn,
    strokes: board.strokes, relations, cardById,
    cardsForInk: inkPairs, eraserAt,
    links, selLink: sel.link, linkPick, onPickLink: openLinkPick, onApplyLink: applyLink,
    onVetoCond: applyVetoCond, onSpecCond: applySpecCond, onClearCond: applyClearCond,
    /* 框选追问：`askPage` 决定「？问这里」那颗按钮亮不亮，`askRegionBox` 是
       小窗开着时画在板上的那一圈高亮（世界坐标）。见上面那两段。
       ★ `onHomeworkInk` 是「✎ 做这道题」那颗（作业辅导的第二个入口）——
         和工具条那颗**同一个函数**。 */
    askPage, onAskInk: openAsk, askRegionBox: askMark || keptBox,
    onHomeworkInk: openHomework,
    inkFrame: sel.frame, onKeepFrame: keepFrame, onDissolveFrame: dissolveFrameNow,
    /* 板框那一族（见 frames.js）：渲染要的是"框 + 框线矩形"，交互只有把手那三件事。 */
    frames: framesToDraw,
    /* 资料那一族（见 docs.js / DocLayer.jsx）：页面层在画布底下，把手条在卡片层。 */
    docs: board.docs,
    frameEditId,
    selectedFrameId,
    onFrameSelect: (id) => setFocus(focusFrame(id)),
    onFrameDragStart: frameDragStart,
    onFrameDrag: frameDrag,
    onFrameDragEnd: frameDragEnd,
    onFrameTitle: renameFrame,
    onFrameEdit: (id) => setFocus(focusFrame(id, true)),
    onFrameEditClose: () => setFocus(endEdit),
    onLinkHover: (inside) => {
      linkLeftRef.current = inside
    },
    onPointerDown, onPointerMove, onPointerUp,
    lasso, inkBox: sel.box, inkHasStrokes: sel.ids.length > 0, onDeleteInk: deleteInkSel, onCopyInk: copySel,
    /* ★ 「⧉ 粘贴」的**第二处入口**（2026-09-23，BoardCanvas 里紧挨着「⧉ 复制」）。
       和工具条那颗、以及 Ctrl+V 走的是**同一个 `pasteSel`** —— 三处各写一份的话，
       "贴到哪儿"（视野中心）那套算法迟早会分叉，而分叉了没人看得出来。
       ★ 为什么要在浮层里也放一颗：复制那条路的按钮本来就在这儿（复制完
         选区还框着、浮层还在眼前），所以"复制完顺手贴一下"最顺的位置是这儿。
         工具条那颗管的是**另一块板**（切过去之后浮层根本不出现）。 */
    onPasteInk: pasteSel,
    /* 「◯ 规整」：`shapeHits` 是**有没有结果**（有才出现那颗按钮），
       `onRegularizeInk` 是点下去真做的事。两个一起递进去 ——
       按钮该不该出现这件事的价值判断在 shapes.js，画布那边只管显示。 */
    shapeHits, onRegularizeInk: regularizeInkSel,
    /* 选区手柄（见 lib/selection.js 的 `transformPick`）：`pickTarget` 对**任意选区**
       都非空（几笔字、一坨乱涂、框进来的卡片都算），两个回调是"拖角缩放"和"转"。 */
    pickTarget, onPickScale: startPickScale, onPickRotate: startPickRotate,
    onFormulaInk: () => openInkPanel('formula'),
    onBeautifyInk: () => openInkPanel('text'),
    /* 卡片层作为 children 传进画布组件 —— 它必须和两层 canvas 待在**同一个**
       .bd-stage 里面（同一个世界原点）。理由见 BoardCanvas 里那段说明。
       注意这里**不要再套一层带 translate / scale 的容器**：世界变换不靠 CSS，
       卡片自己算 left/top（同一个公式、同一个原点）。BoardCanvas 里那层 .bd-world
       只负责叠放（z-index 要高过收事件层，卡片才点得到），给它加变换就多做一次平移。 */
    children: (
      <>
        {/* 资料的把手条：住在卡片层（z6 > 收事件层 z5）里才点得到 ——
            页面本身不吃指针（DocLayer 整层 none），只有这条收拖动和移除。 */}
        <DocBars
          docs={board.docs}
          view={board.view}
          onDragStart={docDragStart}
          onDrag={docDrag}
          onDragEnd={docDragEnd}
          onDelete={docRemove}
          /* 「✧ 整理」= 就整理我这一份（板上挂了几份课件时才需要选）。 */
          onRead={(id) => {
            const d = (boardRef.current.docs || []).find((x) => x.id === id)
            if (d) setDeckFor(d)
          }}
        />
        {/* ★★ 卡片层：**世界坐标 + 一层视图变换**（2026-09-21 第九刀的性能修，
            见 README 第 58 条）。
            从前卡片按 `屏幕 = 世界 × s + t` 逐张算 left/top，缩放时 213 张卡
            每张改 6 个属性 → 浏览器对 3 万个 DOM 节点全量重排
            （实测用户的板：30 次滚轮 7.4 秒，其中 4.0 秒纯 layout）。
            现在卡只写**世界坐标**，视图变换在这一层做一次 ——
            缩放时只有这一行 transform 变，浏览器走合成层，**一次 layout 都不做**。
            这和外层 `.bd-world`（吃补正）、资料层那两层（`.bd-doclayer` 吃补正
            + `.bd-docworld` 带基础变换）是**同一个套路**：基础变换和自己的补正
            各占一层，谁也不覆盖谁。
            ⚠ `transform-origin: 0 0` 必须有 —— 那条公式是以原点推的。
            ⚠ 这一层只管**坐标**，不管叠放：z-index 那件事还是 `.bd-world` 的
              （卡片要压过 .bd-hit(5)，见 BoardCanvas 里那一大段）。 */}
        <div className="bd-cardworld" data-card-world="1" style={cardWorldStyle}>
          {board.cards.map((c) => (
            <CardItem
              key={c.id}
              card={c}
              selected={c.id === selectedId}
              /* ★ 这张卡**在框住的那一块里**吗 —— 在的话，拖它 = 拖整块（见 Card 的 onPointerDown）。
                 判据就是当前选区里的卡片集合（`cardSel`），和"框选收了谁"是同一份。 */
              inPick={cardSel.has(c.id)}
              dimmed={focusIds ? !focusIds.has(c.id) : false}
              editing={c.id === editingId}
              askMarked={!!keptMark && keptMark.cardId === c.id}
              /* ⚠ 下面这一批必须是**稳定引用**（useCallback 造的，见上面那段）——
                 现写内联箭头的话，213 张卡每次缩放全部重渲染，memo 白加。
                 也**不再传 `view`**：传了同样会全员重渲染（见 Card 顶上那段说明）。 */
              onSelectCard={cardSelect}
              onStartEditCard={cardStartEdit}
              onStartDragCard={cardStartDrag}
              onCommitCard={cardCommit}
              onCloseEditCard={cardCloseEdit}
              onDragCard={cardDrag}
              onDragEndCard={cardDragEnd}
              onDeleteCard={cardDelete}
              onStartResizeCard={cardStartResize}
              onToggleLockCard={cardToggleLock}
              onAskMarkCard={cardAskMark}
              onPickMove={pickMoveFromCard}
            />
          ))}
        </div>
      </>
    ),
  }

  const toolbar = (
<Toolbar
            tool={tool} setTool={setTool} onPickArrow={pickArrow}
      color={color} setColor={setColor}
      width={width} setWidth={setWidth}
      paper={paper} onPaper={pickPaper}
      onWriteFormula={() => setPadOpen(true)}
      onBeautify={() => openInkPanel('text')}
      /* 框选追问：板上的入口就这一颗（选区浮层上还有一颗，见 BoardCanvas）。
         ⚠ 它走的是同一条 `openAsk` —— 两条入口各写一份判断的话，
           "什么情况下能问"一定会有一处漏掉（这个仓库为"同一句话两份实现"栽过两次）。 */
      onAsk={openAsk}
      /* 🔍 速查：**Ctrl+K 的那半个，留给没有键盘的时候**（2026-09-28，Surface 场景）。
         ⚠ 走的是同一个 `toggleLook` —— 两处各写一份的话，"手工唤起时不替他预填一个词"
           这种约定迟早只改一边（「⧉ 粘贴」和 Ctrl+V 当初就是照这个规矩做的）。
         ⚠★ 这里要**包一层**，不能直接 `onLook={toggleLook}`：JSX 的 onClick 会把
           **事件对象**当第一个参数送进来，`toggleLook(cx, cy)` 于是拿那个 event
           当横坐标去算位置 ⇒ 算出 NaN。而工具条这条路本来就没有"点在哪儿"这回事
           （它的按钮不在画布上），该摆在默认位置 —— 所以明确地什么都不传。
           这类错的症状极难查：窗其实开了，只是位置不对（表现为"点了没反应"）。
         ⚠ 它 `useCallback` 包着 ⇒ 引用稳定，工具条那颗按钮不会每次重渲染都换一个 props。 */
      onLook={() => toggleLook()}
      shelfOpen={shelfOpen}
      shelfCount={shelf.length}
      onToggleShelf={toggleShelf}
      /* 收拢成笔记：把**当前这块活板**（boardRef，不是打开时的那份原文 ——
         上面刚认出来的一张卡也要算数）递给 App，草稿和建文件都在那边。 */
      onGather={() => onGatherNote && onGatherNote(boardRef.current)}
      /* ⧉ 粘贴：工具条那颗。**和 Ctrl+V 走的是同一个 `pasteSel`** ——
         两条路各写一份的话，"贴到哪儿"（视野中心）那套算法迟早会分叉。
         ★ 这就是给 Surface / 笔用户补的那一半：复制本来就有按钮（选区浮层），
           而粘贴时手里什么都没有、浮层不出现，只有工具条能放它。 */
      onPaste={pasteSel}
      onInsertDoc={() => pickDocFile('insert')}
      docBusy={docBusy && docBusy.who === 'insert' ? docBusy.text : null}
      deckBusy={docBusy && docBusy.who === 'deck' ? docBusy.text : null}
      docs={board.docs || []}
      /* 课件整理：打开那个窗口（挑页 → 一页一页读 → 校对 → 贴到板上）。
         · 板上有课件 → 整理**第一份**（想整理另一份就从它的资料条上进 / 或者窗口里
           「📄 换一份文件…」）—— 资料条上那颗「✧ 整理」是"就整理我这一份"的意思；
         · 板上一份都没有 → **直接开选文件那个框**（2026-09-20）。不逼用户先把几十页
           铺到板上才有资格整理 —— 那条路见 `readDeckFromFile`。 */
      onReadDeck={() => {
        const list = boardRef.current.docs || []
        if (!list.length) {
          pickDocFile('deck')
          return
        }
        setDeckFor(list[0])
      }}
      /* 作业辅导：开那个窗口。**板上没有资料也照样开** —— 窗口里会让他传一份
         （和「课件整理」那条"没有课件就直接开选文件框"是同一个意思；只是这边
         可以慢慢来：先挑是哪一份、再写做哪几题、要不要带上这节课的讲义）。
         ★ 两条入口（工具条 + 选区浮层）走的是**同一个** `openHomework` ——
           你正框着题号的话，它顺手把那一块带进窗里。 */
      onHomework={openHomework}
      /* 「🔓 全部解开」：见 unlockAllCards 那条注 —— 196 张钉住的讲义卡一次全开。 */
      onUnlockAll={unlockAllCards}
      /* 「⟲ 恢复操作」：见 resetGestures 那条注 —— 手势没收尾时用它，不用刷新页面。 */
      onResetGestures={resetGestures}
      onUndo={undo} onRedo={redo}
      canUndo={hist.undo > 0} canRedo={hist.redo > 0}
      onFit={fitToScreen}
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
      onHelp={() => setHelpOpen(true)}
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
    <div className={'bd paper-' + paper + (fullscreen ? ' bd-fs' : '') + (penInk ? ' penink' : '') + (xforming ? ' xforming' : '') + (gesting ? ' gesting' : '')}>
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
        /* ⚠ 这三个都走**捕获阶段**：① 指针种类要看得见卡片上的停留（原有的）；
           ② 触屏长按要在任何 `stopPropagation` 之前就能起步。 */
        onPointerMoveCapture={onStagePointerMoveCapture}
        onPointerDownCapture={onStagePointerDownCapture}
        onPointerUpCapture={cancelPress}
        onPointerCancelCapture={cancelPress}
        /* 双击课件上的字 → 速查。为什么挂在这一层、为什么是 **Capture**，
           见 `onStageDoubleClick` 上面那两段（★ 那条是实测抓出来的）。 */
        onDoubleClickCapture={onStageDoubleClick}
      >
        {/* 画布、连线、卡片都在 BoardCanvas 里面 —— 它们必须是同一个世界原点。
            卡片通过 children 传进去，就是为了让"世界原点"这件事只有一个地方说话。 */}
        <BoardCanvas {...stageProps} />

        {board.cards.length === 0 && board.strokes.length === 0 && !(board.docs && board.docs.length) && <Hint />}
      </div>

      {/* 工具条贴在画布底部。**不再有右侧那一栏**（见文件末尾「关系面板删掉了」）——
          画布从左边栏一直铺到窗口右缘。
          ⚠ `cbarRef` 是给"装回屏幕"量它占了多高的（见 fitForView）：
            它是 absolute 浮在画布上的，画布的 clientHeight 里含它盖住的那一段。 */}
      <div className="bd-cbar" ref={cbarRef}>
        {/* 公式架摆工具条**上面**（同一条容器，往上长）—— 它和工具条是一路的：
            都是"随手拿一件东西"，而不是画布上的内容。 */}
        {shelfOpen && shelf.length > 0 && (
          <FormulaShelf items={shelf} onUse={(item) => insertFromShelf(item)} onDrop={dropFromShelf} onClose={() => setShelfOpen(false)} />
        )}
        {toolbar}
      </div>

      {/* ★ 框选追问的那个小窗（2026-09-22）：浮在页边。
          ⚠ 它挂在这里（`.bd` 里、`.bd-stagewrap` 的**兄弟**），不是画布里面 ——
            画布那一层 overflow: hidden，挂进去会被裁掉半截；而且它是"看的方式"，
            不是纸上的内容（和不进板文件的询问框、公式架同一族）。
          ⚠ `key` 带上页号和那一块矩形：**换一块地方问 = 换一个小窗** ——
            不换的话 `turns` 会跟着搬过去，于是"第 3 页那一段的追问"会被贴到
            第 9 页的答案下面（对话和它讲的那一块必须同生共死）。
          ★ `onKeep` 是「留到板上」（ADR-0006）：小窗**还是不碰板** ——
            它只能发一个"把这一轮留下"的请求，落成什么卡、摆哪儿、写不写盘
            全在 `keepAnswer` 那一层。所以"答案会不会污染我的板"这句话的回答
            仍然是"**你不点它就不会**"（`check:followup-browser` 盯着这一条）。 */}
      {/* 「?」帮助浮层：手势 / 快捷键 / 功能入口对照（工具条右下角那颗「?」开的）。
          和询问框同族：不进板文件，关了就没了。 */}
      {helpOpen && <BoardHelp onClose={() => setHelpOpen(false)} />}

      {ask && ask.doc && (
        <AskBox
          key={`ask:${ask.page}:${Math.round(ask.region.x * 1000)}:${Math.round(ask.region.y * 1000)}`}
          anchor={ask.anchor}
          target={{ doc: ask.doc, page: ask.page, region: ask.region, rect: ask.box }}
          onKeep={(p) => keepAnswer({ ...p, from: 'ask' })}
          onClose={() => setAsk(null)}
          flash={flash}
        />
      )}

      {/* 速查那个小窗（2026-09-28）：上课突然不懂的那个词。
          ⚠ 同样挂在 `.bd` 里、`.bd-stagewrap` 的**兄弟**位置 ——
            画布那一层 overflow: hidden，挂进去会被裁掉半截；而且它是"看的方式"，
            不是纸上的内容（和公式架、询问框、作业窗同一族：不进板文件，关了就没了）。
          ⚠ `onKeep` 交出去的仍然只是**请求**：`keepQuick` 决定落成什么卡、摆在哪儿，
            所以"我查个词会不会污染我的板"的回答仍然是"**你不点『留到板上』就不会**"。 */}
      {look && (
        <QuickLook
          key={look.key}
          at={look.at}
          seed={look.seed}
          contextLabel={lookContext}
          onKeep={(p) => keepQuick({ ...p, doc: look.doc })}
          onClose={() => setLook(null)}
          flash={flash}
        />
      )}

      {/* 资料的文件选择器：藏在根上，工具条那几颗按钮点它 ——
          「📄 插入 PDF/PPT」、「✧ 课件整理」（板上没有课件时直接走这条路），
          以及「✎ 作业辅导」窗口里那颗「📄 传一份作业的 PDF…」。
          ⚠ 谁点的由 `docIntentRef` 记着（change 事件里读不出这个）。
          选完立刻清 value —— 同一个文件连选两次才两次都会触发 onChange。
          ★ **图片也收**（png/jpg/webp）：题目常常只要一张截图/一张照片就够，
            犯不着为三道题传一本几百页的书 —— 图片进来就是一页资料，
            书上该有的本事（圈起来问、当作业那份书）它全都有。 */}
      <input
        ref={docInputRef}
        type="file"
        accept=".pdf,.ppt,.pptx,.png,.jpg,.jpeg,.webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files && e.target.files[0]
          e.target.value = ''
          const intent = docIntentRef.current
          docIntentRef.current = 'insert'
          if (intent === 'deck') readDeckFromFile(f)
          else if (intent === 'homework') readHomeworkFromFile(f)
          else insertDocFile(f)
        }}
      />

      {/* 「这本书有几百页，我只要那几页」那个小窗（2026-09-21）：只在进来的是一份
          够厚的 PDF 时弹出（见 `maybeSlicePdf`）；三个出口都长在 DocPagePicker 里。
          ★ `preview` 是**画缩略图那台机器**（`pdf.thumbs`，见 doc-slice.js）：
            书上的页码和 PDF 的页码差一点是常事，他得能先看一眼再定。 */}
      {sliceAsk && (
        <DocPagePicker
          name={sliceAsk.name}
          total={sliceAsk.total}
          preview={sliceAsk.preview}
          onPick={answerDocPages}
          onCancel={() => answerDocPages(null)}
        />
      )}

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
      {/* 课件整理那个窗口（2026-09-22）：挑页 → 一页一页读 → 校对 → 贴。
          ⚠ 它**自己发请求、自己停**（doc-read.js），Board 这边只在最后收货：
            「确认」回调一到，就量尺寸、摆版、一次 commit 写进板。 */}
      {deckFor && (
        <DeckReview
          /* ★ `key` = 这一份课件的 id：窗口里「📄 换一份文件…」换的是 doc，
             没有这个 key 的话，新那份会**接着上一份的状态**（读过的页、挑中的区间）
             往下跑 —— 那正是最难查的一类错（两处各说各的，还都不报错）。 */
          key={deckFor.id}
          doc={deckFor}
          /* 预选：**只有这份在板上**时才看"你正框着哪几页" ——
             选文件收进来的那份画面上根本没有，拿一个看不见的矩形去框它没有意义。 */
          defaultPages={defaultDeckPages(deckFor, boardDocOf(deckFor) ? sel : null)}
          onOpenSettings={() => setSettingsOpen(true)}
          onPickFile={() => pickDocFile('deck')}
          onCancel={() => setDeckFor(null)}
          onConfirm={(payload) => {
            setDeckFor(null)
            if (!placeDeckCards(payload)) flash('这几条没量出尺寸（公式排不出来？），一张都没贴上去 —— 换个写法再试，或者先贴文字那几条', 'warn')
          }}
        />
      )}
      {/* 作业辅导那个窗口（2026-09-22）：挑作业在哪一份 → 写"第几页第几题" → 每题一份答案 + 解析。
          ⚠ 它和 `AskBox` 一样**没有 onCommit 这种东西** —— 组件拿不到"往板上写"的口子，
            所以"答案会不会污染我的板"这个问题在结构上就不存在（不是靠自觉）。
            ★ `onKeep` 是「留到板上」（ADR-0006）：它交出来的只是一个**请求**
              （哪一份、第几页、哪一块、什么内容），落不落、落在哪儿由 `keepAnswer` 决定。
          ⚠ 挂在 `.bd` 里、`.bd-stagewrap` 的**兄弟**位置：画布那一层 overflow: hidden，
            挂进去会被裁掉半截；而且它是"看的方式"，不是纸上的内容（和询问框、公式架同一族）。 */}
      {hwOpen && (
        <HomeworkBox
          docs={board.docs || []}
          cards={board.cards}
          docPath={hwDoc}
          target={hwTarget}
          /* 换一份资料 = 那个框作废：`region` 是**相对某一页**的归一化矩形，
             换一本书之后它指的地方完全变了一个意思（见 HomeworkBox 里那段）。 */
          onDoc={(p) => {
            setHwDoc(p)
            setHwTarget(null)
          }}
          onClearTarget={() => setHwTarget(null)}
          onPickFile={() => pickDocFile('homework')}
          onKeep={(p) => keepAnswer({ ...p, from: 'homework' })}
          onClose={() => setHwOpen(false)}
          uploadBusy={docBusy && docBusy.who === 'homework' ? docBusy.text : ''}
          flash={flash}
        />
      )}
    </div>
  )
}

/* 「打开整理窗口时预选哪几页」：
 *   · 如果你正**框着资料上的某一页**（框和那一页的矩形明显相交）→ 就是那几页。
 *     "这几页我看不懂，整理一下"是这个功能最常见的用法，少点几下；
 *   · 否则**全部页**（用户原话里"往往是几十页这个数量级"，默认从头读）。
 * 预选只是**初值** —— 窗口里随时能改（点缩略图，或者写一个区间）。
 * ⚠ 这个函数住在 Board 这一层（不在 DeckReview 里），因为"框住了什么"只有 Board 知道。 */
function defaultDeckPages(doc, sel) {
  const rects = pageRects(doc)
  if (!rects.length) return []
  const box = sel && sel.box
  if (box && Number(box.x1) > Number(box.x0)) {
    const hit = rects
      .map((r, i) => ({ i: i + 1, r }))
      .filter(({ r }) => r.x < box.x1 && r.x + r.w > box.x0 && r.y < box.y1 && r.y + r.h > box.y0)
      .map(({ i }) => i)
    if (hit.length) return hit
  }
  return rects.map((_, i) => i + 1)
}

// ─────────────── 关系面板：整块删掉了（2026-09-19，用户说不要右边那一栏）───────────────
/*
 * 用户：「白板页面我觉得不需要右侧关系栏，可以删掉了」—— 连栏里独有的那几个操作一起不要。
 * 删掉的是**界面**：卡片树 / 板框列表 / 「你连的」「你画过的」两节 / 推导链 / 谁靠着谁，
 * 以及只有它一个入口的三件事（条件否决 ✕、回头路 ↺、「∈ 指一个条件」）。
 *
 * 留下来的是**读法**：`relations`（buildRelations）还在 —— 画布上"谁靠着谁"那层浅色线
 * （BoardCanvas 里的 `relations.edges`）用它，不是只有面板在用。
 * `links` / `deriveChains` / `linkCondition` 也一个字没改，只是没有地方显示了。
 *
 * ⚠ 要把面板请回来，先想清楚三件事：
 *   ① 它是**浮层**（旧的 `.bd-cpanel`：宽 320、right:14、z-index 20），压在画布上 ——
 *      选区那排动作 `.bd-inkacts` 的夹取要扣掉它，落点也要躲开屏幕右缘那 320px，
 *      不然合成点击会打到面板上（README 第 13/38 条）。删了之后画布是整个宽度，
 *      那两条夹取公式反而变简单了。
 *   ② 「条件不算 / 条件就是它」那几颗按钮**必须配回头路**（↺）—— 单向门比没有更坏。
 *   ③ 那些按钮的命中测试要单独验（行本身是 button、按钮是行内的 span）——
 *      旧自检 check-link 的 [12]/[13] 就是这么写的，删掉之前它一直是绿的。
 */

// ─────────────── 变体切换：也删了（三种摆法本来就是"翻着挑"的临时形态）───────────────
/* A / B / C 三套摆法存在的唯一理由是**给关系面板找地方**（右栏 / 抽屉 / 左列）。
   面板没了，它们就没有意义了 —— 用户说"删掉"，所以连 `?variant=` 和左右方向键都收走，
   白板只剩一种样子：画布占满，工具条贴底。 */

// ────────────────────────────── 小工具 ──────────────────────────────

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

/* 公式架开着没有？读不出来就当收起（隐私模式 / 第一次用）。 */
function readShelfOpen() {
  try {
    return localStorage.getItem(SHELF_KEY) === '1'
  } catch {
    return false
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

/* 一组笔迹的包围盒搬去了 lib/geometry.js 的 `strokesBBox`（跟着"选中那一族"一起走的）。 */

/* 整笔平移。★ points 必须保持那个**扁平**数组格式（x, y, 压力 三连），
   这是这个项目的铁律 —— 见 lib/board.js 顶部的说明，
   内存里一旦换成对象数组，画布就会把一笔 10 个点读成 3 个。
   ★ 图形那一笔（`shape`）的参数**必须一起搬**，而且要用同一个 module 的那句话：
     读盘时点会被 `shape` **重烤一遍**（board.js 的 normalizeStroke 里那条不变量），
     所以"只搬点、不搬 shape"的结果是**这一块自己弹回原处**。
     症状和剪贴板那条一模一样（复制/粘贴、整组拖动都会中）——
     而笔迹的点、包围盒、状态栏全都是对的，又是一条静默故障。 */
function shiftStroke(stroke, dx, dy) {
  const pts = stroke.points
  const out = new Array(pts.length)
  for (let i = 0; i < pts.length; i += 3) {
    out[i] = pts[i] + dx
    out[i + 1] = pts[i + 1] + dy
    out[i + 2] = pts[i + 2]
  }
  const next = { ...stroke, points: out }
  if (stroke.shape) {
    const sh = translateShape(stroke.shape, dx, dy)
    if (sh) next.shape = sh
    else delete next.shape
  }
  return next
}

/* 整张卡平移（框住一坨东西整体拖走时要跟着走）。
 * ★ 只改 `x/y` —— 倍率和旋转都是"这张卡自己长什么样"，平移一个像素都不该碰它们
 *   （`rot` 还是那个 `rot`，卡片照样是斜的，只是挪了个地方）。 */
function shiftCard(card, dx, dy) {
  return { ...card, x: card.x + dx, y: card.y + dy }
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
