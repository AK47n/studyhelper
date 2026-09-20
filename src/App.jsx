import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FormulaBar from './components/FormulaBar.jsx'
import Preview from './components/Preview.jsx'
import SourceEditor from './components/SourceEditor.jsx'
import Board from './components/Board.jsx'
import { isBoardName, newBoard, serializeBoardDocument } from './lib/board.js'
import { parseDoc, renderTitle, cleanName } from './lib/parse.js'
import { draftNoteFromBoard, frameRectsForBand, splitByBlocks } from './lib/board-note.js'
/* 转录结果的本地缓存（第 3 步）：键按**内容**算，同一块没改过就不再花一次钱。 */
import { blockKey, browserStore, makeOcrCache } from './lib/ocr-cache.js'
/* 第 4 步：行清单（本地几何）+ 两趟之间的那套契约（只许引用行号）。 */
import { buildLines } from './lib/ink-lines.js'
import {
  buildStructureInput, coverageNote, flatSection, manifestText, parseLineOutput, parseStructureOutput, plainText,
  relines, renderStructuredNote,
} from './lib/board-structure.js'
import { isSameLayer, pickVocab } from './lib/note-vocab.js'
import { recognizeHandwriting, structureReading, strokesToPngBlob } from './lib/ocr.js'
import TranscribeReview from './components/TranscribeReview.jsx'
import { normalizeMarkers, useFormulaEditing } from './lib/useFormulaEditing.js'
import { SEED_NAME, SEED_TEXT } from './seed.js'
import { buildSeedBoard } from './seed-board.js'
/* 板文件这一步（data/ 的读写 + **打开哪一个**）收进了 src/lib/files.js：
   URL 只有那一处、首次加载那串分支是一个**纯决定**（planStartup），
   于是每种入口情形都能在 check-board [6n] 里断言，不用真浏览器。 */
import { SEED_BOARD_NAME, boardPath, createFileApi, planStartup, splitTitlePath } from './lib/files.js'
/* data/ 里的路径（分层）：拆 / 拼 / 摆成左栏那棵树 —— 规矩在 paths.js 里，这里只用。
   ⚠ 一条都不能手写：`'a' + '/' + b` 这种看着没事，但根目录那一层拼出来是 `/b`，
     树里就多出一个空名字的节点（真踩过）。 */
import { ancestors, baseName, buildFolderTree, EXPORT_DIR, isRenamed, joinPath, layerNeeds, levels, parentPath, pathTitle, pruneTree, uniqueRelName } from './lib/paths.js'
/* 「这份笔记用到了哪几种公式字体」—— 读浏览器那本账（document.fonts），
   服务端没有 canvas 量不了。量不出来就空着，导出照做（见 lib/fonts.js）。 */
import { detectLoadedFamilies } from './lib/fonts.js'

const api = createFileApi()

/* ── 询问框长什么样（一个值）──────────────────────────────────────────
 * 从前这里一律用浏览器自带的 `prompt()`：它长得像"某个网站想问你一句话"，
 * 顶上还顶着 `127.0.0.1:5177 显示` 和一排系统按钮 —— 和这个工具完全不是一套东西，
 * 而且它**挡住整个界面**：正在改的那棵树、刚画的那张板，全被一块白板盖住。
 *
 * 所以规矩只有一条：**问什么、预填什么、说什么话，都写在这张表里**；
 * `askBox(...)` 只负责把它变成一次 Promise（等用户回了话再往下走）。
 * 这样"加一个新的询问框"= 往这张表里加一条，不用再摆一层 JSX。
 *
 * 形状说明：
 *   id      给自检用的（`[data-ask="mk-folder"]` 能在真浏览器里点到它）
 *   title   问的那句话（比如"新建一层"）
 *   where   **"建到哪一层"那一行字**，由一个函数给（你点的那一行算出来的）——
 *           这是 2026-09-18 加的。起因是用户那句话：
 *           「现在的分层不是很人性化我还要自己输入上层的名字才能生成」。
 *           点的那一下已经把"哪一层"说清楚了，框里就不该再让他写一遍；
 *           但**得写出来**（"建到 大物/电磁学"，空的写"根目录"）——
 *           不写的话，就是"我点了一下，它建到哪儿去了？"（比多打一段名字更糟）。
 *   hint    底下那行灰字（说清打了斜杠会怎样、空着会怎样）
 *   label   输入框上面的小标题；prefix 是那一段**钉住不许改**的前缀
 *   value   预填（前缀之后的正文）；placeholder 是空的时候的灰字
 *   ok      确定那颗按钮上的字（写清楚"按下会发生什么"比"确定"好）
 *   danger  确定是破坏性的（红底）—— 目前只有"丢掉改动"
 *   rows    多行文本框（写说明那种长内容用）
 */
/* 应用自己的询问框（从前是浏览器的 prompt/confirm）。
   表里是**数据**，不是 JSX —— 加一句问话就加一条，别在 JSX 里再长一个弹窗出来。
   ── `required: true` 是"空着就不许交"：确定那颗按钮会灰掉，回车也会没反应，
      让"你得先写点什么"看得出来。除了下面那条"丢掉改动"（它本来就没有输入框），
      每一条都该是 required —— 一个没名字的板 / 层 / 笔记建不出来，也没处放。
      2026-09-17 踩的坑：一开始漏写了 required，于是 `canOk` 永远是 true，
      "空着按确定"照样提交，只是建出来的东西名字是空的（原地消失，没人知道为什么）。 */
const ASK = {
  /* ── "新建"这一族（2026-09-21 重做）──────────────────────────────────────
   * 用户原话：**「优化新增白板，新增分层体验，你自己看看现在太垃圾了」**。
   * 照着看一眼，当时是这个样子（截图 + DOM 读数都在 .cache/side/）：
   *   · 顶栏「＋ 白板」弹出的框里，**路径是预填在名字框里的**（`大物/电磁感应/`），
   *     而框里**没有"建到哪一层"那一行** —— 用户看到的是一串已经打好的字，
   *     得自己猜到"接着往后写才是名字"；更糟的是想把板放到别处就得把这一串删掉重打。
   *   · 顶栏「＋ 分层」问的是**完整路径**，预填同上 —— "分层"这件事又变回打字。
   *   · 上一版给"点出来的那条路"（`here-*`）配了"建到 X"那一行，但那只有目录行上
   *     那两颗看不懂的小图标（`＋` / `▣`）走得通。
   * ⇒ 现在两条路合成一条：**层永远看得见、点得到**（下面 `.ask-layers` 那一排），
   *   名字框里**只有名字**。想一次往下开几层的熟手照样可以打 `电磁学/第一章`
   *   （它和选中的那一层**叠加**：点的是起点、打的是往下走几格）—— 那条路一个字没删，
   *   只是不再是**唯一**的一条。
   * ⚠ `here-board` / `here-folder` 两条问话**删掉了**：它们和上面这两条的区别只剩
   *   "上一层由谁决定"，而层选择器把这件事变成了看得见的一排按钮 ——
   *   同一句话不用再有两份（这个仓库里那种账记了十几条）。 */
  'new-board': {
    title: '新建白板',
    hint: '名字里带 / 可以一次往下开几层（比如 电磁学/第一章）。',
    label: '这张板叫什么',
    ok: '建好并打开',
    where: true,
    required: true,
  },
  'new-note': {
    title: '新建笔记',
    hint: '名字里带 / 可以一次往下开几层（比如 电磁学/第一周）。',
    label: '这条笔记叫什么',
    ok: '建好并打开',
    where: true,
    required: true,
  },
  /* 「收拢成笔记」（2026-09-19 晚，方向 B）：从白板生成草稿，这一条只问"叫什么、放哪层"。
     层的初值 = 那张板所在的层（板和它的结论页待在一起最好找）。 */
  'note-from-board': {
    title: '收拢成笔记',
    hint: '把白板上认出来的卡片/板框/连接拣成一份草稿。名字里带 / 可以换一层放。',
    label: '这份笔记叫什么',
    ok: '生成并打开',
    where: true,
    required: true,
  },
  'new-folder': {
    title: '新建一层',
    hint: '只写这一层的名字；想一次往下开几层就写 电磁学/第一章。',
    label: '这一层叫什么',
    ok: '建出来',
    where: true,
    required: true,
  },
  'move-to': {
    title: '移到哪儿',
    hint: '写完整路径（改名也在这儿）。目标已经有东西的话会拒绝，绝不覆盖。',
    label: '完整路径',
    ok: '移过去',
    required: true,
  },
  /* 「这个名字已经有一条笔记了」（2026-09-19）。
     ── 为什么要有它：从前撞名只 flash 一句"同名文件已存在"，用户既不能覆盖也不能改名 ——
        只能自己**再想一个名字**、把整个流程（包括已经花掉的转录）再走一遍。
        而从白板收拢的草稿，默认名字永远是「<板名> · 笔记」—— 撞名是**常态**，不是意外。
     ── 三条路：覆盖 / 换个名字 / 算了。**默认不覆盖**（回车 = 换个名字那条）：
        覆盖是把已有那条的内容换掉，而"换个名字"永远不会弄丢任何东西。
     ── 它是**选择**型的问话（`choices`），没有输入框、也不问"建到哪一层"。
     ── board 不走这条：白板是**你亲手画的东西**，撞名只报错，不给覆盖的机会
        （和「移动」那条一样：宁可让你换个名字，也不给一个能一键抹掉手写痕迹的按钮）。 */
  'note-overwrite': {
    title: '这个名字已经有一条笔记了',
    hint: '覆盖 = 那条笔记的内容被这份草稿换掉（换掉就找不回来了）。换个名字则两边都在。',
    label: null,
    /* 把"要覆盖的是哪一份"摆出来（文件路径 + 几个节点 + 多大 + 什么时候改过）——
       比一句"同名文件已存在"可判断得多。内容由调用方通过 `ask(..., { extra })` 给。 */
    note: true,
    choices: [
      { id: 'rename', label: '换个名字', hint: '会替你填一个不撞名的（原样的名字后面加 2）' },
      { id: 'overwrite', label: '覆盖它', hint: '那条笔记的内容就没了', danger: true },
      { id: 'cancel', label: '算了，先不写' },
    ],
  },
  'board-titled': {
    title: '这一课叫什么',
    hint: '文件名会跟着它一起定下来。',
    label: '标题',
    ok: '写进板子里',
    required: true,
  },
  'loose-changes': {
    title: '当前文件有没保存的改动',
    hint: '现在切走，那些改动就丢了（这张板是自动存的，笔记要按 Ctrl+S）。',
    label: null,
    ok: '丢掉并切走',
    cancel: '留着别切',
    danger: true,
  },
}

  /* 白板的新建得先问一下"这一课叫什么" —— 板子里有标题，
   文件名只是给人看的（Git、列表）。两步都做，看着才不别扭。
 * ★ 分层就藏在这个问题的答案里（2026-09-17）：打 `大物/电磁学/第一章` 就存到
   `data/大物/电磁学/board-第一章.md`，中间那几层目录自动建出来；
   只打一个名字，就放进**当前这张板所在的那一层**（我在这层整理，新的一张也放这儿），
   没打开任何板时就是根上。空着的那一格预填成当前层 + `/`，打字接着往下写就行。
 * `ask` 是 App 里那个应用自己的询问框（见 ASK 那张表）—— **别在这儿退回 `prompt`**：
   它是同步的，而且一弹出来整棵树都被盖住。
 * ★ `title` 传了就**不再解释一遍**那个答案：`here-board` 那条路（点出来的）已经问过
   "这一段"了，上一层由**你点的那一行**决定 —— 再 `splitTitlePath` 一次是同一个决定算两遍，
   而"哪一层"这件事这个仓库总共只该有一处说得清。 */
async function createBoard({ ask, flash, refresh, dir = '', where = '', title = null, layers = null }) {
  let d = dir
  let t = title
  if (t == null) {
    /* ★ 名字框里**只有名字**（2026-09-21）。原来这里把"当前层 + /"预填进输入框，
       于是用户看到的是一串已经打好的路径，得自己猜"接着往后写才是名字"——
       而"建到哪一层"是**框里那一排可点的层**（`where` 是初值、`layers` 是可选项）。
       想一次往下开几层的熟手照样可以在名字里打 `/`（`splitTitlePath` 一个字没改）。 */
    const raw = await ask('new-board', { where, layers })
    if (!raw) return null
    const parsed = splitTitlePath(raw)
    d = parsed.dir
    t = parsed.title
  }
  if (!t) return null
  const r = await api.create(boardPath(d, t), serializeBoardDocument(newBoard(t)))
  if (r.error) {
    flash(r.error, 'err')
    return null
  }
  await refresh()
  return r.name
}

/* 补一张**空**板（一张板都没有的时候，别退回笔记界面）。
   ── 为什么不能退：白板是这个工具的入口（左栏第一个按钮、README 第一段），
      列表里没有板就不给板 = 把入口锁上了。用户真正的遭遇：
      data/ 里板被删干净、只剩笔记，打开就进笔记界面；
      想画还得先点一下「白板」，再回答一个"这一课叫什么"的弹窗。
   ── 为什么是空白板而不是样板板：样板是"第一次装这个工具"的见面礼，
      只在 data/ 完全为空时给（见 createSeedBoard 的调用处）；
      用户已经把板删干净了，说明他要自己从头来，再塞一张示例进去是添乱。
   ── 名字由 files.js 的 nextBoardName 探好（撞名往后排）——
      服务端 /api/new 撞名直接回 409，不探就是静默失败（结果还是进笔记界面）。 */
async function makeBoard(name, { refresh, flash }) {
  const r = await api.create(name, serializeBoardDocument(newBoard('新白板')))
  if (r.error) {
    flash(r.error, 'err')
    return null
  }
  await refresh()
  return r.name
}

/* 第一次打开"data/ 一个文件都没有"的时候，先放一张样板进去。
   理由是"关系靠位置"这件事必须看见一次才懂 —— 空板配一句说明，人是不会照做的。 */
async function createSeedBoard({ refresh, flash }) {
  const r = await api.create(SEED_BOARD_NAME, serializeBoardDocument(buildSeedBoard()))
  if (r.error) {
    flash(r.error, 'err')
    return null
  }
  await refresh()
  return r.name
}

// 字号缩放：整个界面由 CSS 变量 --s 驱动，这里只负责改它 + 记住你调到了多少
const SCALE_MIN = 0.9
const SCALE_MAX = 2.0
const SCALE_STEP = 0.05
const SCALE_DEFAULT = 1.25
const SCALE_KEY = 'studyhelper.scale'
/* 左栏哪几层展开着。同样是"我怎么看"，存 localStorage，不进板文件。 */
const TREE_KEY = 'studyhelper.tree'

/* ── 整板转录那一条的参数（2026-09-19，第 3 步之后收在这里）──────────────
 * 为什么提成模块常量：**缓存键要用 flavor，请求要用同一套参数** —— 两处各写一份
 * 迟早漂移（"缓存命中了但发出去的参数不一样"是最难查的那种）。
 * `targetH: 2000` 是"整板一条"的档：块里的字要够大，识别准确率才立得住
 * （小选区认公式走的是另一套：targetH 160 / 2~6 倍）。 */
const BAND_OPTS = { mode: 'board', targetH: 2000, minScale: 0.8, maxScale: 4 }
/* `lines-N` = 按行抄那一套契约（第 4 步）：**换了契约就要换 flavor** ——
   不然上一次按老格式认回来的缓存会被当成新格式读，行号全对不上。
   ⚠ `lines-1` → `lines-2`（2026-09-20）：`lines-1` 那段时间里**行清单根本没发出去**
   （见 lib/ocr.js 里那段说明），缓存里躺着的是"模型自由分行、一个 L 前缀都没有"的
   老稿；不换 flavor 的话，修好之后再收一次会**原样命中那份老稿**，
   屏幕上看起来跟没修一样（而且不会花一次钱去发现这件事）。 */
const BAND_FLAVOR = 'board/lines-2/2000/0.8-4'
/* 这几种失败**不是"这一块没认出来"，是整条链路没通** —— 一块一块地撞墙没有意义，
   该停下来说清楚（"没配密钥 / 服务端是旧版 / 这家服务干不了这活"）。 */
const FATAL_OCR_KINDS = new Set(['no-key', 'key', 'stale', 'provider'])

const clampScale = (v) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100))

function readExpanded() {
  try {
    const raw = localStorage.getItem(TREE_KEY)
    if (!raw) return null // 从没动过 → 全展开（见下面的 isOpen）
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [])
  } catch {
    return null
  }
}

function readScale() {
  try {
    const s = Number(localStorage.getItem(SCALE_KEY))
    return Number.isFinite(s) && s > 0 ? clampScale(s) : SCALE_DEFAULT
  } catch {
    return SCALE_DEFAULT
  }
}

/* 应用自己的询问框（= 从前那些 `prompt()` 的替身）。
 *
 * 为什么要自己画一个：浏览器那个弹窗①顶着一行"127.0.0.1:5177 显示"和系统按钮，
 * 看着像"某个网站在问你话"；②**挡住整个界面**，正在整理的那棵树一点都看不见了。
 * 而这里问的几乎都是"这东西放进哪一层"—— 恰恰**需要看着那棵树**才好回答。
 *
 * 三件事想清楚了：
 *   · **挂载时抓一次初始值**（`useState(() => spec.value ?? '')`）。不这么写就得给
 *     input 加 `key` 或者用 effect 去同步 defaultValue —— 那两样都会在打字的时候把光标顶跑。
 *   · 确定键 = 这个框自己的表单提交（`<form onSubmit>`）——
 *     于是"回车等于点确定"是浏览器给的，不用自己拦 keydown（也就不用处理输入法）。
 *   · 点背景 = 取消，但**点框本身不取消**（`e.target === e.currentTarget`）——
 *     不然手一抖点在框边上，刚打的字全没了。Esc 是浏览器的 `<dialog>` 默认行为。
 */
function Ask({ spec, value, multiline, where, layers, extra, onDone }) {
  const [v, setV] = useState(() => (value == null ? '' : String(value)))
  /* ★ 建到哪一层：**看得见、点得到**（2026-09-21）。
     初值 = 调用方说的那一层（顶栏 = 你现在所在的那一层，目录行的「＋」= 你点的那一行）。
     用户点一下右边某一颗就换过去 —— "分层"这件事不再需要把父层的名字**再打一遍**
     （README 第 54 条记的就是这件事：打错的不是名字，是"我以为我在那一层"）。
     最左边那颗永远是「根目录」，所以"放到根上"也是一次点击，不用把路径删空。 */
  const [layer, setLayer] = useState(() => (where == null ? '' : String(where)))
  /* 确定那颗按钮自己 —— 只为"这一下提交是它按的吗"留个凭据（见下面 onSubmit 的注释） */
  const okRef = useRef(null)
  /* 空着就不让按（按钮灰着）—— 让"回车没反应"这件事看得出来 */
  const canOk = !spec.required || v.trim() !== ''
  /* 交出去的是"选中的那一层 + 你打的名字"（拼成一条路径，调用方那条 `splitTitlePath`
     一个字都不用改）。你打的 `/` 仍然算数：点的是起点、打的是往下走几格。 */
  const submit = (raw) => onDone(raw == null ? null : joinPath(layer, raw))
  const pickable = spec.where && Array.isArray(layers) && layers.length > 0
  return (
    <div className="askwrap" onClick={(e) => e.target === e.currentTarget && onDone(null)}>
      <dialog
        className="ask"
        open
        aria-label={spec.title}
        /* ★ Esc = 取消（2026-09-21 修的 bug）。
           ⚠ 原来这里连一行处理器都没有，注释还写着"Esc 是浏览器的 `<dialog>` 默认行为" ——
             那是**模态**（`showModal()`）才有的行为；这个框是 `<dialog open>`（非模态），
             **Esc 什么都不做**。于是：按 Esc 以为取消了，框还在；紧接着点「＋ 分层」，
             那一下落在遮罩上 → 把旧框取消掉、新框根本没开 —— 用户看到的是
             **「点了没反应」**（我照着看一眼时第一次就是这么被骗的：以为按钮坏了）。
           ⚠ `stopPropagation`：不让它漏到白板那一层的全局按键上（那边 Esc = 取消选中）。 */
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          onDone(null)
        }}
      >
        <form
          method="dialog"
          onSubmit={(e) => {
            /* ⚠ 只认"确定"那一下。`<form method="dialog">` 的**隐式提交**是好的
               （回车能提交、Esc 靠 `<dialog>` 自己关），但它也让**取消按钮**变成提交按钮 ——
               不加这个判据的话，点"取消"会走进 onDone(raw)，
               把用户刚打的字当结果交出去（名字照样建出来）。
               症状是"我点的是取消，它却建了" —— 而界面一点异常都看不出来。 */
            e.preventDefault()
            if (e.nativeEvent.submitter !== okRef.current) return
            if (canOk) submit(v)
          }}
        >
          <div className="ask-title">{spec.title}</div>
          {/* "建到哪一层" —— 一排**能点的**层（2026-09-21 从"一句只读的话"改成这个）。
              ⚠ 它必须**看得见**：点了「＋」之后只看见一个空输入框，下一个问题就是
                "它建到哪儿去了？"（比多打一段名字更糟）。 */}
          {spec.where && (
            <div className="ask-where">
              {pickable ? (
                <>
                  <span className="aw-label">建到哪一层</span>
                  <span className="ask-layers">
                    <button
                      type="button"
                      className={'ask-layer' + (layer === '' ? ' on' : '')}
                      onClick={() => setLayer('')}
                      title="放到最外面那一层"
                    >
                      根目录
                    </button>
                    {layers.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={'ask-layer' + (layer === p ? ' on' : '')}
                        onClick={() => setLayer(p)}
                        title={'放到「' + p + '」这一层里'}
                      >
                        {p}
                      </button>
                    ))}
                  </span>
                </>
              ) : (
                <>
                  建到 <b>{where || '根目录'}</b>
                  <span className="aw-why">（就是你点的那一行{where ? '' : '：根上'}）</span>
                </>
              )}
            </div>
          )}
          {spec.hint && <div className="ask-hint">{spec.hint}</div>}
          {/* 「要覆盖的那一份长什么样」——一个文件路径 + 几个数，比"同名文件已存在"可判断得多 */}
          {spec.note && extra && <div className="ask-note">{extra}</div>}
          {/* ── 选择型的问话（2026-09-19，`spec.choices`）─────────────────────
              没有输入框、也不问"建到哪一层"：`onDone` 交回去的是**选项的 id**
              （和别的问话一样是个字符串，调用方照样 `if (!raw) return` 判取消）。
              ⚠ 选项按数组顺序画，**第一条是默认的那条**（回车走它）——
                所以"不会弄丢东西"的那条永远排在前面（见 note-overwrite）。 */}
          {Array.isArray(spec.choices) && (
            <div className="ask-choices">
              {spec.choices.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  autoFocus={i === 0}
                  className={'ask-choice' + (c.danger ? ' danger' : '')}
                  onClick={() => onDone(c.id)}
                >
                  <b>{c.label}</b>
                  {c.hint && <span className="ac-hint">{c.hint}</span>}
                </button>
              ))}
            </div>
          )}
          {!Array.isArray(spec.choices) && spec.label && <div className="ask-label">{spec.label}</div>}
          {!Array.isArray(spec.choices) && (
            <div className="ask-field">
              {spec.prefix && <span className="ask-prefix">{spec.prefix}</span>}
              {multiline ? (
                <textarea
                  className="ask-textarea"
                  value={v}
                  rows={4}
                  autoFocus
                  spellCheck={false}
                  onChange={(e) => setV(e.target.value)}
                />
              ) : (
                <input
                  className="ask-input"
                  value={v}
                  autoFocus
                  spellCheck={false}
                  placeholder={spec.placeholder || ''}
                  onChange={(e) => setV(e.target.value)}
                />
              )}
            </div>
          )}
          <div className="ask-acts">
            {!Array.isArray(spec.choices) && (
              <button type="button" className="btn" onClick={() => onDone(null)}>
                {spec.cancel || '取消'}
              </button>
            )}
            {!Array.isArray(spec.choices) && (
              <button ref={okRef} type="submit" className={'btn primary' + (spec.danger ? ' danger' : '')} disabled={!canOk}>
                {spec.ok || '好'}
              </button>
            )}
          </div>
        </form>
      </dialog>
    </div>
  )
}

/* 左栏那一棵树（目录套目录，递归渲染）。
 *
 * 为什么值得单写一个组件：从前左栏是一个 flat 列表 —— 因为 `data/` 从前是**平的**。
 * 现在文件可以放进子目录（大物 / 电磁学 / 第一章），于是"列表"变成了"树"，
 * 而树必须能递归、能展开、能往里拖东西，这三件事挤在 App 的 render 里会看不清。
 *
 * 五条已经想清楚的口径：
 *   · **缩进 = 层数 × 12px**（写死在这个组件里，别处不再算缩进）；
 *   · 目录行上的「＋」是"**在这一层**新建"（不是"新建在根上"）—— 分层存储里
 *     "在哪儿建"就是全部的意思，点错了位置等于没分层；
 *   · 文件名那一行左边的「＋」是"**放进这一层**"：这一行本来就有归属（目录里 / 根上），
 *     点了就只问名字、不问路径 —— 想挑别的地方，用「新建」或拖。
 *     ⚠ 它只在目录里出现：根上那一行的名字按钮已经在做同一件事（`newBoardFile('')`），
 *       再来一颗就是同一句话有两份实现。
 *   · **改名就在行上改**（点名字那一格 → 变成输入框，回车/失焦生效、Esc 取消）——
 *     拖是"换归属"，打字是"换名字"，两件事不再挤在同一个 prompt 里；
 *   · 拖拽的落点是**目录行**和顶部那一行（= 根）；文件行只做拖起（`draggable`），
 *     不做落点（把一张板拖到另一张板上没有含义）。
 *
 * ── 目录行上那颗「＋」为什么**常显**（2026-09-18 改的）────────────────────
 * 用户原话：**「现在的分层不是很人性化我还要自己输入上层的名字才能生成，
 * 你可以参考下 onenote 的分层规则这样靠点击来在分层下面建立新白板很人性化」**。
 * 「＋」本来就在（点了只问名字、不问路径 —— 这一点一直是对的），问题在**它只在
 * 鼠标划过这一行时才出现**，而且右边还挨着「⤳」，两颗符号长得一样显眼。
 * 于是"我想在大物里建一张板"这件事，看起来仍然只有"打一条带斜杠的路径"一条路。
 * 现在：**目录行上的动作区常显**（`data-where="here"`，样式只放给这一种行）。
 * 为什么常显是对的那一个 —— 藏起来的理由是"一行里塞满图标就不像树了"，
 * 但那一条是给**文件行**说的（文件行的动作多、而且"打开"才是它常做的事）；
 * 目录行的「＋」是**唯一那个说得出"建到哪一层"的入口**，而"哪一层"正是分层里
 * 最容易点错、也最需要被看见的一件 —— 藏起来等于用户不知道能往那儿建。
 */
function TreeRows({ node, depth, ctx }) {
  const {
    isOpen, toggleDir, open, current, isBoard, dropDir, setDropDir,
    onDragStart, onDragOverDir, onDropDir, newBoardHere, newFolderIn,
    canRename, renaming, doRename, sayWhyNot, startRename, openWithGuard, exportNote, justMade,
  } = ctx
  const pad = { paddingLeft: 6 + depth * 12 }
  /* 改名的动作（文件行行尾、目录行行尾两颗按钮都走它）—— 各写一遍的话，
     "白板能不能在这儿改名"那个判断就会有好几份，迟早只改一处。 */
  const renameAct = (p) => (canRename ? startRename(p) : sayWhyNot(p))
  /* ★ 刚建出来的那一层：把它的那一行**滚进视野**（2026-09-21）。
     为什么用 ref 回调而不是 effect：这一行是"这一趟渲染里才出现的"，
     而 effect 挂在 TreeRows 上会为**每一行**跑一遍；ref 回调只在挂载时跑一次，
     语义正好是"这一行刚长出来"。闪一下的样式在 CSS（`.folderrow.justmade`）。 */
  const revealRef = (path) => (el) => {
    if (!el || !justMade || justMade.path !== path) return
    el.scrollIntoView({ block: 'nearest' })
  }
  /* 名字那一格。**就地改**：点一下变成输入框，不用先去回答一个弹窗。
     输入框在的地方就是这一行本身，改完还看得见它在树里的哪一格 ——
     这是 prompt 做不到的（弹窗盖住整棵树，改完得抬头找它在哪）。
     ★ 名字那一格**不再是**改名的入口，它是**打开**的一部分（2026-09-21 改的）。
       为什么改：名字那一格是 `flex: 1`，占一行里绝大部分宽度 —— 想打开一张板时
       手指落在那儿是最自然的，于是**经常开成改名框**（用户原话：
       「现在点白板的时候经常点到重命名很难受就打不开白板」）。原来是
       "点名字 = 改名、点行尾空白 = 打开"（2026-09-17 定的，当时治的是反过来的病：
       改名挂在整行上，鼠标根本没有"打开"这条路）。
       现在：**整行随便点都打开**（名字、空白、缩进都算），改名走行尾那颗
       「改名」按钮 —— 它常显、写在按钮上、键盘也 Tab 得到。
       取舍说清楚：打开是每秒都在做的事，**一次点击就得成**；改名是一件
       特意去做的事，多给它一颗按钮不算负担，而"点名字竟然进了编辑态"
       是实打实的难受。 */
  const NameCell = ({ f }) =>
    renaming === f.name ? (
      <input
        className="renameinput"
        defaultValue={f.title || baseName(f.name)}
        autoFocus
        spellCheck={false}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') doRename(f.name, e.currentTarget.value)
          else if (e.key === 'Escape') doRename(f.name, null) // null = 不干了
        }}
        onBlur={(e) => doRename(f.name, e.currentTarget.value)}
      />
    ) : (
      /* 纯展示：不加 onClick（点了就冒泡给整行的"打开"）、也不挂 title ——
         名字长了由 CSS 出省略号，完整路径看行上的 `title`（整行那一层）。 */
      <span className="fname">{f.title || baseName(f.name)}</span>
    )

  return (
    <>
      {node.dirs.map((d) => {
        const unfolded = isOpen(d.path)
        return (
          <div key={'d:' + d.path} className="treegroup">
            <div
              /* ★ `justmade` 是"刚建出来的那一层"（见 settleNewLayer）：
                 它滚进视野、并且闪一下 —— 不然"点了回车，界面上什么都没变"。 */
              className={'folderrow' + (dropDir === d.path ? ' drop' : '') + (justMade && justMade.path === d.path ? ' justmade' : '')}
              ref={revealRef(d.path)}
              style={pad}
              title={d.path}
              role="button"
              tabIndex={0}
              draggable
              /* 这一行是"点出来的分层"那条路的落点 —— 见上面那段长说明。
                 样式只认这个属性，不认"第几个孩子"那种位置判据。 */
              data-where="here"
              onDragStart={(e) => onDragStart(e, d.path)}
              onDragOver={(e) => onDragOverDir(e, d.path)}
              onDragLeave={() => setDropDir(null)}
              onDrop={(e) => onDropDir(e, d.path)}
              onClick={() => toggleDir(d.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') toggleDir(d.path)
              }}
            >
              <span className="caret">{unfolded ? '▾' : '▸'}</span>
              {/* 目录这一格点了是**折起来**（不是改名）—— 它是"这一层"的标题，
                  每天点十次的都是它。改名走行尾那颗 ⤳。 */}
              <span className="fname">{d.name}</span>
              <span className="fmeta">{countIn(d)}</span>
              <span className="rowacts">
                {/* ★ 两颗「＋」管的是两件事，别合并：
                      「＋白板」= 在这一层里**放一张板**（每一天都在做的事）；
                      「＋分层」= 在这一层里**再开一层**（开课、开章的时候做一次）。
                    ⚠ 2026-09-21 之前它们是光秃秃的 `＋` 和 `▣` —— 用户的原话是
                      「新增白板，新增分层体验…太垃圾了」。两颗符号**长得一样显眼、
                      又都看不懂**（`▣` 尤其：它是"框"的意思，和"分层"毫无关系），
                      只能靠 hover 才知道谁是谁。现在直接写出来。
                    ★ 常显的只有「＋白板」（主路径）；「＋分层」和「改名」飘在它**左边**，
                      鼠标上来才出现 —— 实测三个词常显会把目录名挤成省略号
                      （"热力学与统计物理" → "热力学与统计…"），而**飘着**的那两颗
                      不占流、不挤名字，也不会让「＋白板」在 hover 时**跳一下**
                      （会跳的按钮 = 瞄不准 = 点到隔壁那颗）。见 styles.css 的 `.rare`。
                    ⚠ 文件行上那颗「＋」不带这两颗的任何一颗：那一行自己就有归属，
                      位置不由它决定（它是"放进我所在的这一层"）。 */}
                <button
                  className="rowbtn plus"
                  title={'在「' + d.path + '」这一层里新建白板'}
                  onClick={(e) => {
                    e.stopPropagation()
                    /* ★ 走 `newBoardHere`（= `new-board` 那条问话 + 这一层当起点）——
                       上一层就是**你刚点的这一行**，名字框里只有名字。
                       ⚠ 这条曾经漏改过（两次都在同一处）：只把"新建一层"接上了、
                       `＋` 还留着老的那一句，于是"点了「＋」却弹出打路径的框"——
                       而 `check:sidetree` 报出来是"预填了东西"，看着像界面的小毛病。 */
                    newBoardHere(d.path)
                  }}
                >
                  ＋白板
                </button>
                <span className="rare">
                  <button
                    className="rowbtn plus"
                    title={'在「' + d.path + '」这一层里再新建一层'}
                    onClick={(e) => {
                      e.stopPropagation()
                      newFolderIn(d.path)
                    }}
                  >
                    ＋分层
                  </button>
                  <button
                    className="rowbtn rename"
                    data-act="rename"
                    title="改名 / 移到别处"
                    onClick={(e) => {
                      e.stopPropagation()
                      renameAct(d.path)
                    }}
                  >
                    改名
                  </button>
                </span>
              </span>
            </div>
            {unfolded && <TreeRows node={d} depth={depth + 1} ctx={ctx} />}
          </div>
        )
      })}
      {node.files.map((f) => (
        <div
          key={'f:' + f.name}
          className={'filerow' + (f.name === current ? ' on' : '')}
          style={pad}
          title={f.name}
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(e) => onDragStart(e, f.name)}
          /* ★ 整行 = **打开**（2026-09-21 起连名字那一格也算）——
             这是最常做的那件事，所以它得是"点到哪儿都成"。见 NameCell 上面那段说明。
             ⚠ 行尾那几个动作按钮不算：它们自己 `stopPropagation`，这里再挡一道 ——
               万一以后有人加一颗忘了写，点那颗按钮不会顺手把文件也打开。 */
          onClick={(e) => {
            if (e.target.closest && e.target.closest('.rowacts')) return
            openWithGuard(f.name)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') openWithGuard(f.name)
          }}
        >
          {depth > 0 && (
            <button
              className="rowbtn plus"
              title={'在「' + parentPath(f.name) + '」这层新建'}
              onClick={(e) => {
                e.stopPropagation()
                newBoardFile(parentPath(f.name))
              }}
            >
              ＋
            </button>
          )}
          <NameCell f={f} />
          <span className="fmeta">{isBoard ? '白板' : (f.nodes || 0) + ' 节点'}</span>
          <span className="rowacts">
            {/* 导出：**只在笔记这一边出现**（白板这一轮还不能导，见 README 的说明）。
                为什么放在行尾的小按钮里、而不是全局一颗：和改名同理 ——
                "导出哪一份"在树里本来就看得见，全局按钮还得先回答"哪一份"。 */}
            {!isBoard && (
              <button
                className="rowbtn exp"
                title={'导出成一个网页，好发给别人（放 ' + EXPORT_DIR + ' 里）'}
                onClick={(e) => {
                  e.stopPropagation()
                  exportNote(f.name)
                }}
              >
                导出
              </button>
            )}
            {/* ★ 改名就是这一颗（2026-09-21）。它**常显**（划过这一行就看得见）：
                名字那一格已经不是改名的入口了，这个动作要是还藏着，
                就等于"改名的路得先猜到"（2026-09-18 那颗「＋」踩过同一个坑）。
                `data-act="rename"` 只给自检用（check:sidetree 按它认这颗按钮，
                不按"第几颗 / 文字是不是改名"—— 位置判据会在长出新按钮之后失效）。 */}
            <button
              className="rowbtn"
              data-act="rename"
              title="改名 / 移到别处"
              onClick={(e) => {
                e.stopPropagation()
                renameAct(f.name)
              }}
            >
              改名
            </button>
          </span>
        </div>
      ))}
    </>
  )
}

/* 这一层底下（含自己）有几样东西 —— 目录行右边那个数字 */
function countIn(node) {
  return node.files.length + node.dirs.reduce((n, d) => n + countIn(d), 0)
}

export default function App() {
  const [files, setFiles] = useState([])
  /* `data/` 里的目录（相对路径，和 files[].name 同一套口径）。左栏那棵树 = 这两个拼出来。 */
  const [folders, setFolders] = useState([])
  /* 哪几层是展开的。`null` = **从没动过** → 全展开：第一次打开就看见自己分的那几层，
     比"一片折起来的箭头"友好；动过一次之后就是你上次留下的样子。
     存 localStorage —— 这是"我怎么看这个目录"，不是笔记内容，不该进任何 .md
     （和纸面存档一条道理）。 */
  const [expanded, setExpanded] = useState(readExpanded)
  const [dropDir, setDropDir] = useState(null) // 正被拖到哪一层上（高亮用）
  /* 正被就地改名的**那一条**（相对路径；null = 没人改名）。
     一个值，不是"每一行自己一个编辑态" —— 同时只可能改一个名字，
     存成每行一份就会出现"改着这个、点了那个、两个输入框都在" */
  const [renaming, setRenaming] = useState(null)
  /* 应用自己的询问框（一个值）：`{ id, spec, value, multiline, resolve }`。
     为什么不用 useState 存一个"回调"再单独存文案：resolve 必须和这一次问话绑在一起，
     分两个 state 就会出现"框还开着，但它等的是上一次那件事"。 */
  const [askState, setAskState] = useState(null)
  const [current, setCurrent] = useState(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [toast, setToast] = useState(null)
  const [busy, setBusy] = useState(true)
  /* 遮罩上那句话。整板转录要几十秒，"载入中…"三个字撑不住那么长的等待 ——
     得说清"在干什么、要多久"，不然用户以为卡死了。 */
  const [busyMsg, setBusyMsg] = useState('')
  /* 转录校对（2026-09-19 晚）：整板转录完**先不落笔**，把"每块的原板图 + 机器认的稿"
     摆进 TranscribeReview 让人改完再收。null = 没在校对。
     放 App 这一层：转录发生在 gatherNote（这里），busy 遮罩也在这层。 */
  const [transReview, setTransReview] = useState(null)
  /* 停止转录用的把手（第 3 步）：弹层上那颗「停止」按它，它 abort 掉**还在等的那一次**，
     并把"别再发下一块了"立刻生效。校对弹层关掉时清空（见 confirmTransReview / onCancel）。 */
  const cancelRef = useRef(null)
  const [diskMtime, setDiskMtime] = useState(0)
  /* 「编辑 / 阅读」双视图：2026-09-19 晚一度砍掉，同日又请回来 —— 两度反转，把账记全：
     砍的时候它看着像"同一份内容两种摆法"；但「收成笔记」上线后草稿里全是公式，
     而编辑区是**逐像素对齐的源码层**（两层错一像素就是灾难，见 SourceEditor 顶部，
     标题连字号都不能变），公式只有光标那一行渲染成气泡。用户原话：
     「整理出来的公式都没有美观的显示都还是编辑状态的」—— 阅读视图是公式
     唯一"好看的脸"。砍掉的只有右栏和诊断，这两个不回来。 */
  const [view, setView] = useState('edit') // 'edit' 直接编辑（已渲染的样子） | 'read' 整屏阅读
  const [focusMode, setFocusMode] = useState(false)
  /* 对齐诊断不再有界面入口（它本来是开发者的排查工具，长在顶栏上是"臃肿"的一部分）。
     内部还开着：localStorage 塞 `sh.diag=1` 再刷新即可（对齐排查的 diag-* 脚本走这条路）。 */
  const [diag] = useState(() => {
    try {
      return localStorage.getItem('sh.diag') === '1'
    } catch {
      return false
    }
  })
  const [scale, setScale] = useState(readScale)
  // 画布全屏：把左侧栏、顶栏、关系面板全收掉，只留一张纸。
  // 它和"浏览器全屏"是联动的 —— 所以点一下连地址栏那圈也一起收掉，
  // 这才是 OneNote 那种"满屏只剩页面"的感觉。
  const [boardFs, setBoardFs] = useState(false)
  /* "换文件 / 重载"的计数器。
     ★ 为什么不靠 initialText 让 Board 判断"内容换没换"：那个 prop 每自动保存一次
       就会变一次，Board 一旦按它重跑初始化就会把撤销栈清空
       （拖完东西按 Ctrl+Z 没反应、撤销按钮一直是灰的）。
       所以"要换内容了"这件事，用一个只在真换的时候才动的计数器来说。 */
  const [boardReload, setBoardReload] = useState(0)
  const [pendingJump, setPendingJump] = useState(null) // 从阅读视图切回编辑后要跳到的行
  /* 刚建出来的那一层（`{ path, at }`）：左栏那一行会**滚进视野并闪一下**，
     2.2 秒后自己清掉（见 `settleNewLayer`）。为什么需要它：新层可能长在
     折起来的、或者滚动条下面的地方 —— 点完看不到任何变化，用户只能自己去找，
     那和"点了没反应"在体验上是同一件事。 */
  const [justMade, setJustMade] = useState(null)

  const taRef = useRef(null)
  const jumpRef = useRef(null)
  // 白板那边自己管存盘（它是自动存的），这里只留最后一次要落盘的内容
  const boardTextRef = useRef('')

  const isBoard = isBoardName(current)
  const boardFiles = useMemo(() => files.filter((f) => isBoardName(f.name)), [files])
  const noteFiles = useMemo(() => files.filter((f) => !isBoardName(f.name)), [files])
  /* 左栏那棵树：先把**所有**文件 + 目录摆成树（结构只跟路径有关，跟模式无关），
     再按当前模式剪枝 —— 白板模式里"只有笔记"的枝整枝消失（两个入口各看各的）。 */
  const tree = useMemo(() => buildFolderTree(files, folders), [files, folders])
  const shown = useMemo(
    () => pruneTree(tree, isBoard ? (f) => isBoardName(f.name) : (f) => !isBoardName(f.name)),
    [tree, isBoard]
  )
  const isEmpty = !shown.dirs.length && !shown.files.length

  // 展开状态：记住它（下次打开还是这个样子）。`null`（没动过）不写盘 ——
  // 写了就等于"我把每一层都手工展开过"，下次再建新的一层就不会自动展开了。
  useEffect(() => {
    if (!expanded) return
    try {
      localStorage.setItem(TREE_KEY, JSON.stringify([...expanded]))
    } catch {
      /* 存不了就算了 */
    }
  }, [expanded])

  /* 某一层现在展开着吗。`expanded === null` 表示用户还没动过 → 全展开。 */
  const isOpen = useCallback(
    (p) => (expanded ? expanded.has(p) : true),
    [expanded]
  )

  /* 展开某一层（连带它上面的每一层）—— 建完东西 / 打开一张深处的板时用，
     不然"新建成功"了却看不见那一行，看着像没建成。
     ⚠ 默认全展开时（`expanded === null`）本来就是展开的，直接原样返回 ——
       这时候要是"物化"成一份 Set，等于替用户把每一层都点开了，之后就再也不会自动展开新层。 */
  const expandTo = useCallback(
    (p) => {
      const add = p == null ? [] : levels(String(p))
      if (!add.length) return
      setExpanded((prev) => {
        if (!prev) return prev
        const next = new Set(prev)
        let changed = false
        for (const d of add) {
          if (!next.has(d)) {
            next.add(d)
            changed = true
          }
        }
        return changed ? next : prev // 没变就别换引用（省一次整棵树的 diff）
      })
    },
    []
  )

  const toggleDir = useCallback(
    (p) => {
      setExpanded((prev) => {
        // 第一次动手：先把"当前这份目录清单"物化成 Set（= 现在这个样子），再翻这一层
        const next = new Set(prev || folders)
        if (next.has(p)) next.delete(p)
        else next.add(p)
        return next
      })
    },
    [folders]
  )

  // 打字时 text 立刻更新（编辑区/着色层要跟手），但解析整棵树 + 重渲染预览
  // 会随文件变大而变贵（实测：1 节课 0.1ms，30 节课 1.5ms，之后还有 DOM 开销），
  // 所以派生的那部分延后 90ms 再算。见 scripts/perf.js。
  // 保存不受影响：保存永远读 textarea 的当前值。
  const [derivedText, setDerivedText] = useState('')
  const deriveTimer = useRef(null)
  const setTextNow = useCallback((val) => {
    setText(val)
    if (deriveTimer.current) clearTimeout(deriveTimer.current)
    deriveTimer.current = setTimeout(() => setDerivedText(val), 90)
  }, [])

  // 派生结果：预览和右侧面板都用它
  const doc = useMemo(() => parseDoc(normalizeMarkers(derivedText)), [derivedText])

  // 字号：写进 CSS 变量 + 记住
  useEffect(() => {
    document.documentElement.style.setProperty('--s', String(scale))
    try {
      localStorage.setItem(SCALE_KEY, String(scale))
    } catch {
      /* 存不了就算了 */
    }
  }, [scale])

  const bumpScale = useCallback((d) => setScale((s) => clampScale(s + d)), [])

  /* 画布全屏。两件事一起做：
       ① 界面这边把左侧栏、顶栏、关系面板收掉（靠 .app.fs / .bd-fs 那几条样式）；
       ② 请求**真正的浏览器全屏** —— 不然地址栏、标签栏还在，"彻底"就无从谈起。
     为什么监听 fullscreenchange 而不自己记状态：用户按 Esc 或 F11 退出时，
     浏览器不会来通知这个按钮，只能靠这个事件把状态跟上，
     否则按钮会一直显示"退出全屏"，点了也退不出来。 */
  useEffect(() => {
    const onCh = () => setBoardFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onCh)
    return () => document.removeEventListener('fullscreenchange', onCh)
  }, [])

  const toggleBoardFs = useCallback(() => {
    if (document.fullscreenElement) {
      const p = document.exitFullscreen?.()
      if (p && p.catch) p.catch(() => {})
      setBoardFs(false) // 兜底：万一事件没来，状态也别卡在"全屏"
      return
    }
    // 已经处于"只收界面"的降级状态（浏览器没让全屏），再点一下就是退出
    if (boardFs) {
      setBoardFs(false)
      return
    }
    const p = document.documentElement.requestFullscreen?.()
    if (p && p.catch) {
      // 全屏被拒（权限 / 策略 / 不是用户手势）时退化成"只收界面"：
      // 至少画布是铺满的 —— 总比点了没反应强
      p.catch(() => setBoardFs(true))
    } else {
      setBoardFs(true) // 浏览器压根不支持全屏 API
    }
  }, [boardFs])

  /* 降级模式下（浏览器不给全屏，比如页面被嵌在别的容器里）Esc 是不会自己生效的，
     这里自己接一下 —— 不然会卡在全屏里出不来，只能去点那个按钮。
     真·浏览器全屏时不用管：Esc 浏览器自己处理，处理完 fire fullscreenchange，
     上面那个监听会把状态收回来。 */
  useEffect(() => {
    if (!boardFs) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) setBoardFs(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [boardFs])

  // 从阅读视图切回编辑后，把待跳的行补上（编辑器这时才挂载完）
  useEffect(() => {
    if (view !== 'edit' || pendingJump == null) return
    const line = pendingJump
    setPendingJump(null)
    const t = setTimeout(() => jumpRef.current && jumpRef.current(line), 0)
    return () => clearTimeout(t)
  }, [view, pendingJump])

  const editing = useFormulaEditing({
    textareaRef: taRef,
    nodes: doc.nodes,
    onEdit: () => setDirty(true),
  })

  /* 说一句话（2 秒后自己消失）。
   * `act` 是可选的一颗动作按钮 —— 2026-09-18 加的，就为了导出那件事：
   *   用户明确要求"你得告诉我我在哪里找到存放导出的文件夹"。光在提示里写一串
   *   中文路径不够 —— 他还得自己去翻。所以提示里直接给一条**能点的**东西，
   *   点一下资源管理器就跳过去。
   * ★ 动作按钮一存在，这条提示就**不再自动消失**（`hold`）：
   *   要让人有机会点。没动作的还是老规矩，2 秒走人，不打扰。 */
  const flash = useCallback((msg, kind = 'ok', act = null) => {
    setToast({ msg, kind, act, at: Date.now() })
    if (act) return // 带动作的不自动关（用户得有时间点它）
    setTimeout(() => setToast((t) => (t && Date.now() - t.at >= 1900 ? null : t)), 2000)
  }, [])

  /* 问一句话，等用户回话。**"取消"和"空着按了确定"都回 null** —— 调用方只判 `if (!raw) return`
     就够，不用记住"哪个算取消"（原生 prompt 把这两件事混成了一个 undefined，那是对的）。
   * ⚠ 一次只能开一个：后问的那个把前一个 resolve 成 null，不然前一个的 await 永远不返回。
   * `where` 是"建到哪一层"（只有 `here-*` 那两条问话会写出来）—— 它是**你点的那一行**，
     不是输入框里的内容。见 ASK 表里 where 的说明。 */
  const ask = useCallback((id, { value = '', multiline = false, where = '', layers = null, extra = '' } = {}) => {
    const spec = ASK[id]
    if (!spec) return Promise.resolve(null) // 名字写错了也得让调用方拿到 null，不能挂住
    setAskState((prev) => {
      if (prev) prev.resolve(null)
      return { spec, value, multiline, where, layers, extra, resolve: null, id }
    })
    return new Promise((resolve) => {
      setAskState((prev) => (prev && prev.id === id ? { ...prev, resolve } : prev))
    })
  }, [])

  const closeAsk = useCallback((raw) => {
    setAskState((prev) => {
      if (!prev) return null
      prev.resolve(raw == null || !String(raw).trim() ? null : String(raw).trim())
      return null
    })
  }, [])

  // ---- 首次加载 ----
  /* 打开哪一个？这一整串判断是 src/lib/files.js 的 `planStartup`（**纯函数、有断言**）：
   * 空目录先放样板、`?file=` 指名只认那一个、否则列表里第一张板、一张板都没有就补一张空的。
   * 这里只负责照它说的做（建文件 / 打开 / 说一句话）。
   * ⚠ `?file=<名字>` 是**自检用的入口**：自检直接从 URL 打开自己造的夹具板，
   *   于是用户那张板根本不会被读到（从前"进界面之后点左栏那一行"，
   *   而应用在挂界面**之前**就已经把用户的板读进来、冷字体缓存下还会写回去一次）。 */
  useEffect(() => {
    let alive = true
    ;(async () => {
      let list = await api.list().catch(() => null)
      if (!alive) return
      if (!list || !list.files) {
        setBusy(false)
        flash('连不上本地服务，检查跑 studyhelper 的那个黑窗口', 'err')
        return
      }
      const want = new URLSearchParams(window.location.search).get('file')
      let plan = planStartup({ files: list.files, want })
      if (plan.step === 'seed') {
        // 全新的用户：先给一张白板样板 + 一份笔记样板。
        // 白板在前，因为它才是入口（见 planStartup 里"打开哪一个"的说明）。
        await createSeedBoard({ refresh: async () => {}, flash })
        await api.create(SEED_NAME, SEED_TEXT)
        list = await api.list()
        if (!alive) return
        plan = planStartup({ files: (list && list.files) || [], want })
      }
      setFiles((list && list.files) || [])
      setFolders((list && Array.isArray(list.folders) ? list.folders : []))
      if (plan.step === 'open') {
        await open(plan.name, { force: plan.force })
      } else if (plan.step === 'none') {
        // `?file=` 指了个不存在的：什么都不打开（绝不退回"列表里第一个"）
        if (want) flash('?file= 说的那个文件不在列表里：' + want, 'err')
      } else if (plan.step === 'create-board') {
        /* 一张板都没有（笔记还在、板被删干净了）。
           ★ 这里以前是直接打开第一个笔记 —— 用户看到的就是"怎么打开是笔记界面"。
           现在：补一张空板再进去；真的建不出来（写盘失败）才退回列表里第一个。 */
        const made = await makeBoard(plan.name, { refresh: refreshList, flash })
        /* 建不出来（写盘失败）就退回列表里第一个 —— 至少不是白屏。
           ⚠ 退回的是**列表里第一个**，不是刚探出来的那个名字：那个文件根本没建出来，
             拿它去 open 只会得到一句"文件不存在"。 */
        const fallback = (list && list.files && list.files[0] && list.files[0].name) || plan.name
        await open(made || fallback, { force: true })
        if (made) flash('没有白板，先给你开了一张空的：' + made)
      }
      setBusy(false)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 打开一个文件。
   * ★ `open` 只**开**，不问 —— 问话是另一件事，也是另一个 async 函数。
   *   为什么要拆开（2026-09-17）：原来这里夹着一句 `confirm('当前文件有没保存的改动…')`，
   *   它是**同步**的，于是"用应用自己的框去问"这条路根本走不通（自己的框要 await）。
   *   现在：`openWithGuard` 先问一句（自己的框），说"留着别切"就什么都不做。
   *   ⚠ `open()` 自己不再做这个守卫 —— 挂载时的 `?file=`、`ensureBoard`、
   *     "刚建完就打开"这些路都该**直接开**（那会儿的 dirty 是上一份文件的，问了也是错问）。 */
  async function openWithGuard(name) {
    if (!isBoardName(name) && dirty) {
      const yes = await ask('loose-changes')
      if (!yes) return
    }
    await open(name)
  }

  async function open(name, { force = false } = {}) {
    const r = await api.get(name)
    if (r.error) return flash(r.error, 'err')
    setCurrent(name)
    expandTo(parentPath(name)) // 打开一张埋在好几层里的板，左栏得跟着展开到它那一层
    const shown = String(r.text ?? '')
    // 白板的原文由 Board 自己解析、自己存（它是自动存的），
    // 这里只把原文交给它，别顺手塞进 textarea 的那套状态里
    boardTextRef.current = shown
    if (deriveTimer.current) clearTimeout(deriveTimer.current)
    setText(shown)
    setDerivedText(shown)
    if (taRef.current) taRef.current.value = shown
    setDiskMtime(r.mtime || 0)
    setDirty(false)
    setSelectedId(null)
    setBoardReload((x) => x + 1) // 告诉 Board：内容换了（换文件、或点了「重载」）
    requestAnimationFrame(() => taRef.current && taRef.current.focus())
  }

  /* 列表 + 目录一起收。**只有这一处**改这两个 state —— `files` 和 `folders` 是同一棵树
     的两半，分开收就会出现"文件挪到了新层，树还是旧的"（看着像移动没生效）。 */
  function applyList(list) {
    setFiles((list && list.files) || [])
    setFolders((list && Array.isArray(list.folders) ? list.folders : []))
  }

  async function refreshList() {
    applyList(await api.list().catch(() => null))
  }

  // 白板：它自己决定什么时候存，我们只负责写盘 + 回个时间戳
  /* ★ 回一个**判决**（{ ok, mtime } / { ok: false, error }）：白板那边靠它决定
     那个「已存」能不能亮（见 Board.jsx 的 flushSave 与 README 第 38 条）。
     以前这里什么都不回，于是"发出去了"和"写进去了"在白板看来是同一件事。 */
  async function saveBoardText(t) {
    if (!current) return { ok: false, error: '还没有打开任何文件' }
    boardTextRef.current = t
    const r = await api.put(current, t)
    if (r.error) {
      flash(r.error, 'err')
      return { ok: false, error: r.error }
    }
    setDiskMtime(r.mtime || 0)
    return { ok: true, mtime: r.mtime || 0 }
  }

  async function save() {
    if (!current) return
    const val = taRef.current ? taRef.current.value : text
    const r = await api.put(current, val)
    if (r.error) return flash(r.error, 'err')
    if (deriveTimer.current) clearTimeout(deriveTimer.current)
    setText(val)
    setDerivedText(val)
    setDiskMtime(r.mtime || 0)
    setDirty(false)
    flash('已存到 ' + current)
    applyList(await api.list())
  }

  /* ── 导出一条笔记 → 一个能发出去的单文件网页 ──────────────────────────
   *
   * 用户要的是"把笔记发给同学、或者发到网上"。笔记里 `$…$`、`[[B]]`、缩进
   * 只有这个程序认得，所以导出不是复制文件，是翻译（见 lib/export-html.js）。
   *
   * 三件事按顺序：
   *   ① 如果正开着这份、而且有没保存的改动 → **先存**。不然导出去的是旧版，
   *      而用户以为自己刚写的东西在里面（这是"每天一条假 diff"那一族病）。
   *   ② 用浏览器量出"这份笔记用到了哪几种公式字体"（服务端没有 canvas）。
   *      量不出来就是空串 —— 导出照做，公式退到系统衬线体（宁可丑，不可丢）。
   *   ③ 告诉服务端去写，然后弹一条**能点的**提示：点一下跳进那个文件夹。
   *      （用户明确要求："你得告诉我我在哪里找到存放导出的文件夹"。）
   */
  async function exportNote(name) {
    if (!name) return
    // ① 正开着这一份、且有改动 → 先落盘
    if (current === name && dirty) {
      const val = taRef.current ? taRef.current.value : text
      const saved = await api.put(name, val)
      if (saved.error) return flash(saved.error, 'err')
      setDiskMtime(saved.mtime || 0)
      setDirty(false)
    }

    // ② 量字体（读浏览器那本账，见 lib/fonts.js）。它失败不该拦住导出。
    setBusy(true)
    let fontList = ''
    try {
      const fams = await detectLoadedFamilies()
      fontList = fams.join('|')
    } catch {
      fontList = ''
    }

    // ③ 让服务端写
    const r = await api.exportNote(name, { title: pathTitle(name), fonts: fontList })
    setBusy(false)
    if (r.error) return flash(r.error, 'err')

    const kb = Math.max(1, Math.round((r.bytes || 0) / 1024))
    flash(`导出好了：${r.to}（${kb} KB）`, 'ok', {
      label: '打开文件夹',
      run: () => revealExport(r.dir),
    })
    return r
  }

  /* 在资源管理器里打开导出目录。服务端只认 `.导出`，别处开不了（见 server.js）。 */
  async function revealExport(dir = EXPORT_DIR) {
    const r = await api.reveal(dir)
    if (r.error) return flash(r.error, 'err')
    flash('已打开：' + (r.path || dir))
    return r
  }

  /* ── 建一个**新**文件；撞名的时候问一句（2026-09-19）────────────────────────
   * 从前撞名只 flash 一句"同名文件已存在"，用户既不能覆盖也不能改名 ——
   * 只能自己再想一个名字、把整个流程（包括已经花掉的转录）再走一遍。
   * 而从白板收拢的草稿默认就叫「<板名> · 笔记」—— **撞名是常态，不是意外**。
   *
   * 判据是服务端回的 `code:'exists'`，**不是匹配那句人话**（人话会为"更像人话"而改，
   * 字面匹配失配的表现是"点了覆盖却什么都没发生"）。
   * 返回：{ ok, name, overwritten } ｜ { cancelled: true } ｜ { error }
   * `onRename(撞名的那个名字)` 由调用方给 —— 只有它知道该拿什么当默认名字。 */
  async function createNewFile(name, text, { onRename = null } = {}) {
    let target = name
    for (;;) {
      const r = await api.create(target, text)
      if (!r || !r.error) return { ok: true, name: (r && r.name) || target, overwritten: false }
      if (r.code !== 'exists') return { error: r.error }
      const choice = await ask('note-overwrite', { extra: noteFileInfo(target) })
      if (choice === 'overwrite') {
        const w = await api.put(target, text)
        return w && w.error ? { error: w.error } : { ok: true, name: target, overwritten: true }
      }
      if (choice !== 'rename') return { cancelled: true }
      const next = onRename ? await onRename(target) : null
      if (!next) return { cancelled: true }
      target = next
    }
  }

  /* 「要覆盖的那一份长什么样」：一行字，比"同名文件已存在"可判断得多。
     数是从 `/api/list` 那份清单里来的（它就是左栏那颗列表的同一份数据）。 */
  function noteFileInfo(name) {
    const f = (files || []).find((x) => x && x.name === name)
    if (!f) return `已有的那一份：${name}`
    const kb = f.size ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : ''
    const when = f.mtime ? new Date(f.mtime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
    return ['已有的那一份：' + name, f.nodes ? `${f.nodes} 个节点` : '', kb, when ? when + ' 改过' : ''].filter(Boolean).join(' ｜ ')
  }

  /* 给"换个名字"用：在这条笔记所在的那一层里找一个不撞名的（原样的名字后面加 2、3…）。
     用的是 paths.js 的 `uniqueRelName` —— 和"补一张空板"那条路同一个函数。
     ⚠ 回的是**填进输入框的那一串**（带层、**不带 `.md`**）：那个框里从来只有名字，
       后缀是流程自己补的（第一次问名字那条路也一样）。 */
  const suggestFreeName = (name) => {
    const taken = (files || []).map((f) => f && f.name).filter(Boolean)
    const dir = parentPath(name)
    const stem = baseName(name).replace(/\.md$/i, '')
    const uniq = uniqueRelName(taken, dir, stem, '.md')
    return uniq ? joinPath(dir, uniq.stem) : null
  }

  async function newNote() {
    /* 和「＋ 白板」同一条规矩（2026-09-21）：名字框里只有名字，层由**框里那一排**选，
       初值 = 你现在所在的这一层。 */
    const here = parentPath(current || '')
    const raw = await ask('new-note', { where: here, layers: folders })
    if (!raw) return
    const { dir, title } = splitTitlePath(raw)
    if (!title) return
    const name = joinPath(dir, title + '.md')
    /* 撞名就问一句（和「收成笔记」同一条路）—— ＋ 笔记也是手打名字，重名同样会碰上。 */
    const made = await createNewFile(name, `# ${title}\n\n- \n`, {
      onRename: async (taken) => {
        const sug = suggestFreeName(taken) || taken
        const again = await ask('new-note', { value: sug, where: parentPath(sug), layers: folders })
        if (!again) return null
        const parsed = splitTitlePath(again)
        return parsed.title ? joinPath(parsed.dir, parsed.title + '.md') : null
      },
    })
    if (made.cancelled) return
    if (made.error) return flash(made.error, 'err')
    await refreshList()
    await open(made.name, { force: true })
    flash((made.overwritten ? '覆盖了：' : '建好了：') + made.name)
  }

  /* ── 收拢成笔记（2026-09-19 晚，方向 B：白板为主、笔记为辅）──────────
   * 白板是"算"的地方，笔记是"算完留下的结论"。这一步把板上已经提纯的东西
   * （认成卡片的公式/文字、亲手圈的板框、亲口连的箭头）拣成一份草稿，
   * 人接手改成自己的话 —— 笔记从此不用从零打字。
   *
   * ★ 裸手写**不再被丢下**：有手写时先做一次**整板转录**（分成几块、每块单独发），
   *   认完先进**转录校对**（原板图和转录稿并排），改完才落笔。
   *
   * ★ 2026-09-19 第 3 步（手感，ADR-0004 第 3 步）：
   *   ① **弹层立刻打开**：图当场画好，每块先摆一个"等待识别"，认完一块填一块 ——
   *      等待从"盯着遮罩几十秒"变成"可以一边看原图一边等"；
   *   ② 认过的块按**内容哈希**缓存（lib/ocr-cache.js）：改一笔再收一次，
   *      没动过的块**秒回、不再花钱**；
   *   ③ 每块能**单独重认**（从前第一块失败会把整趟带走，后面全不认）；
   *   ④ 随时能**停止**（中止后面的请求。⚠ 已经发出去的那一次拦不住 ——
   *      服务端还在跑、钱也照花，这一条如实写在按钮上）。
   *
   * 草稿怎么拣：src/lib/board-note.js（一个纯函数，自检直接喂板文件文本）。 */
  async function gatherNote(board) {
    const strokes = (board && Array.isArray(board.strokes) ? board.strokes : []).filter(
      (s) => s && s.points && s.points.length >= 3
    )

    /* 先问名字（快），确认了才花那几十秒去转录 —— 取消了就不该花钱。 */
    const here = parentPath(current || '')
    const def = ((board && board.title) || baseName(current || '')).trim() + ' · 笔记'
    const raw = await ask('note-from-board', { value: def, where: here, layers: folders })
    if (!raw) return

    const ink = strokes.filter((s) => s.tool !== 'highlighter')
    if (!ink.length) {
      /* 没有裸手写：没有转录这回事，直接收卡片（老路，一个字没变）。 */
      await writeDraft(board, raw, [], '')
      return
    }

    /* 一块 = 一个板框（第 2 步）；框外的按竖直大留白切。
       图**当场全部画好**：一是弹层立刻能开（左边那张图从第一秒就在，
       人可以先照着图读），二是缓存键和发出去的图用的是同一份笔迹，不会两处漂移。 */
    const blocks = splitByBlocks(ink, board, { maxBands: 4 })
    /* **你自己的词**（第 4 步的"结合我的笔记"）：从同层的笔记里抽，只读本机的 .md。
       它只喂**第二趟**（结构整理）—— 那一趟在弹层上看得见、关得掉；
       喂第一趟（认字）要等设置里有一个"还没发出去就能关"的开关，记在 ADR 的"还没做"里。 */
    const vocab = await sameLayerVocab(board)
    /* ★ 第 4 步：本地先算好每一块的**行清单**，它同时喂给两趟 ——
         认字那趟把它拼进提示词（模型按 `L<行号>|文字` 回话），
         结构整理那趟拿它当坐标系（每条结论都必须引用行号）。
       图也当场画好：一是弹层立刻能开，二是缓存键和发出去的图用同一份笔迹。 */
    const plan = blocks.map((blk) => {
      const lines = buildLines(blk.strokes)
      const overlays = frameRectsForBand(blk.strokes, board)
      const made = strokesToPngBlob(blk.strokes, { ...BAND_OPTS, overlays })
      return {
        name: blk.name,
        frameId: blk.frameId,
        strokes: blk.strokes,
        overlays,
        lines,
        manifest: manifestText(lines),
        img: made ? made.canvas.toDataURL('image/png') : '',
      }
    })
    const parts = plan.map((b) => ({
      name: b.name,
      frameId: b.frameId,
      strokes: b.strokes,
      overlays: b.overlays,
      lines: b.lines,
      img: b.img,
      text: '',
      items: null, // 按行认回来时：每一段文字对应哪几行（改完的字靠它挂回去）
      coverage: '',
      error: '',
      pending: true,
      cached: false,
      rev: 0,
    }))
    const cache = makeOcrCache(browserStore())
    const ac = new AbortController()
    cancelRef.current = () => ac.abort()
    setTransReview({ board, raw, bands: parts, ocrFail: '', streaming: true, vocab, useVocab: !!vocab.length })

    let ocrFail = ''
    let anyText = false
    try {
      for (let i = 0; i < parts.length; i++) {
        if (ac.signal.aborted) break
        const key = blockKey(parts[i].strokes, { flavor: BAND_FLAVOR })
        const hit = cache.get(key)
        if (hit) {
          /* 这一块没动过：直接用上次认的（**不再发请求、不再花钱**）。
             缓存的原文带着 `L<行号>|` 前缀 —— 照样要过一遍解析，两趟的坐标才对得上。 */
          patchBand(i, { ...readBack(hit.text, parts[i].lines.length), pending: false, error: '', cached: true })
          anyText = true
          continue
        }
        const r = await recognizeHandwriting(parts[i].strokes, {
          ...BAND_OPTS,
          overlays: parts[i].overlays,
          lines: plan[i].manifest,
          signal: ac.signal,
        })
        if (r.kind === 'cancel') break
        if (r.ok && r.text) {
          cache.set(key, r.text)
          patchBand(i, { ...readBack(r.text, parts[i].lines.length), pending: false, error: '', cached: false })
          anyText = true
        } else {
          ocrFail = r.error || '没认出内容'
          /* 这几种不是"这一块没认出来"，是**整条链路没通**（没配密钥 / 服务端是旧版 /
             这家服务干不了这活）。一块都还没认到的时候，别拿一屏空框子拦人 ——
             关掉弹层，走"先收卡片"的老路，并把人话原样报出来。 */
          if (FATAL_OCR_KINDS.has(r.kind) && !anyText) {
            cancelRef.current = null
            setTransReview(null)
            await writeDraft(board, raw, [], ocrFail, null)
            return
          }
          patchBand(i, { pending: false, error: ocrFail })
          if (FATAL_OCR_KINDS.has(r.kind)) {
            /* 链路不通，但已经有内容了：剩下的别再一块一块撞墙，直接全部标上原因。 */
            for (let j = i + 1; j < parts.length; j++) patchBand(j, { pending: false, error: ocrFail })
            break
          }
        }
      }
    } finally {
      cancelRef.current = null
      /* 收尾：**还在认的块要有个交代** —— 停止（或被打断）之后它们不该摆着一个
         空框子装作"机器认了个空的"，所以给它们一句人话（缓存/认好的块一个字不动）。 */
      setTransReview((rv) =>
        rv
          ? {
              ...rv,
              streaming: false,
              ocrFail,
              bands: rv.bands.map((b) => (b.pending ? { ...b, pending: false, error: b.error || ocrFail || '已停止' } : b)),
            }
          : rv
      )
    }
  }

  /* 识别回来的原文 → 给校对界面用的那一份。
     `L<行号>|文字` 是**契约**（第二趟要靠行号），但不该让改字的人盯着它看：
     格式跟上了 → 文本框里只放纯文字，行号单独存着（改完 `relines` 挂回去）；
     没跟上 → 整段照原样摆出来（**退化成"照原文抄"**，不是编一个结构出来）。 */
  function readBack(raw, lineCount) {
    const parsed = parseLineOutput(raw, lineCount)
    const note = coverageNote(parsed, lineCount)
    if (!parsed.followed) {
      return { text: String(raw || '').trim(), items: null, coverage: note + '（没按行回话，这一块退回整段抄）' }
    }
    return { text: plainText(parsed.items), items: parsed.items, coverage: note }
  }

  /* 弹层里改过的字：只覆盖**这一块**（别的地方你敲进去的东西一个字都不许动）。 */
  const patchBand = useCallback((i, next) => {
    setTransReview((rv) => {
      if (!rv || !rv.bands[i]) return rv
      return { ...rv, bands: rv.bands.map((b, j) => (j === i ? { ...b, ...next, rev: (b.rev || 0) + 1 } : b)) }
    })
  }, [])

  /* 单块重认：只重发这一块，而且**绕开缓存** —— 这颗按钮的意思就是"上次那个我不信"。 */
  async function retryBlock(i) {
    const rv = transReview
    if (!rv || !rv.bands[i]) return
    const p = rv.bands[i]
    if (p.pending || !p.strokes) return
    const ac = new AbortController()
    cancelRef.current = () => ac.abort()
    patchBand(i, { pending: true, error: '' })
    try {
      const r = await recognizeHandwriting(p.strokes, {
        ...BAND_OPTS,
        overlays: p.overlays,
        lines: manifestText(p.lines || []),
        signal: ac.signal,
      })
      if (r.kind === 'cancel') {
        patchBand(i, { pending: false })
        return
      }
      if (r.ok && r.text) {
        makeOcrCache(browserStore()).set(blockKey(p.strokes, { flavor: BAND_FLAVOR }), r.text)
        patchBand(i, { ...readBack(r.text, (p.lines || []).length), pending: false, error: '', cached: false })
      } else {
        patchBand(i, { pending: false, error: r.error || '没认出内容' })
      }
    } finally {
      cancelRef.current = null
    }
  }

  /* 停止转录（弹层上那颗）。**中止的是"后面的请求"**：已经发出去的那一次拦不住，
     服务端还在跑、钱也照花 —— 按钮上如实写着（见 TranscribeReview）。 */
  function stopTranscribe() {
    if (cancelRef.current) cancelRef.current()
  }

  /* 校对完（或放弃校对）之后真正落笔的那一步。
     `blocks` 是**校对后的那块手写**，一块一条：`{ name, frameId, text, items, error }` ——
     `frameId` 说得出它属于哪个板框，`items`（按行认回来时）让改过的字还能挂回原来的行号。
     `structured` 是**结构整理那一趟**的产物（没有就是 null → 草稿走按块平铺的老路）。
     `ocrFail` 原样带给提示语。 */
  async function writeDraft(board, raw, blocks, ocrFail, structured = null) {
    const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && (b.text || b.error))
    const draft = draftNoteFromBoard(board, { when: new Date().toLocaleDateString('zh-CN'), blocks: list, structured })
    if (!draft || !draft.md) {
      flash('板上还没有收得动的东西：框选手写 → 「✨ 美化」成卡片，再来收拢', 'warn')
      return
    }
    const { dir, title } = splitTitlePath(raw)
    if (!title) return
    const name = joinPath(dir, title + '.md')
    /* 撞名就问一句（覆盖 / 换个名字 / 算了）—— 从白板收拢的草稿默认叫「<板名> · 笔记」，
       撞名是常态，不是意外。
       ★「换个名字」那条把**同一句问话再问一遍**，但预填的是**不撞名的那个**
         （`suggestFreeName`）：于是这条路的成本是"回车一下"，不是"自己想一个名字"。 */
    const made = await createNewFile(name, draft.md, {
      onRename: async (taken) => {
        const sug = suggestFreeName(taken) || taken
        const again = await ask('note-from-board', { value: sug, where: parentPath(sug), layers: folders })
        if (!again) return null
        const parsed = splitTitlePath(again)
        return parsed.title ? joinPath(parsed.dir, parsed.title + '.md') : null
      },
    })
    if (made.cancelled) {
      /* 「算了」也要有回音（"点了没反应"是这里最糟的结果）——顺带告诉他代价不大：
         认过的块按内容缓存着，再点一次不会重新花一次钱。 */
      flash('没收成笔记（认过的块有缓存，再点一次不用重新花钱）')
      return
    }
    if (made.error) return flash(made.error, 'err')
    await refreshList()
    await open(made.name, { force: true })
    const got = list.filter((b) => b.text).length
    /* 「覆盖了原来那份」要看得见 —— 那是不可逆的一步，事后至少得知道你刚才做的是哪一件。 */
    const over = made.overwritten ? '（覆盖了原来那份）' : ''
    if (got) {
      flash(
        ocrFail
          ? `转录只完成了一部分（${ocrFail}）；已认到的 ${got} 块都在草稿里${over}，记得校对`
          : `收好了：${draft.cards} 张卡 + ${got} 块手写转录${draft.frames ? `（${draft.frames} 个板框成了小节）` : ''}${over}。转录是机器认的，记得对照原板校对`,
        ocrFail ? 'warn' : 'ok'
      )
    } else if (ocrFail) {
      flash(`手写转录没成（${ocrFail}）；先收了 ${draft.cards} 张卡${over}`, 'warn')
    } else if (draft.strokesLeft > 0) {
      flash(`收好了 ${draft.cards} 张卡${over}；还有 ${draft.strokesLeft} 笔手写没进来（想收的先美化成卡片）`)
    } else {
      flash(`收好了 ${draft.cards} 张卡`)
    }
    /* ★ "第二趟（结构整理）没被叫上"这件事**必须说出来**：它的症状是草稿看上去
       "只有并列、没有逻辑"，而屏幕上一点异常都没有 —— 人只会以为"这机器不懂我的笔记"。
       真因只有一个：认字那趟没按 `L<行号>|` 回话（`items` 是 null）→ 上面那个闸不开。
       ⚠ 它排在"收好了：…"后面（顶掉那句是有意的：这一条更说明问题），
         而**排在"读不到的行"前面** —— 那一条永远最重要，谁都不许盖它。 */
    const gotText = list.filter((b) => b.text)
    if (gotText.length && !list.some((b) => b.items && b.items.length)) {
      flash('这一板手写没按行回话（模型没给行号）—— 结构整理没参与，草稿是照原文平铺的。再收一次，或者就在草稿里手动分节', 'warn')
    }
    /* ⚠ 读不到的行**必须永远是 0**（ADR-0004 第 1 步的判据）：那些行只活在原始编辑框里，
       阅读页签和导出里**不存在**，而屏幕上一点异常都没有。它不该发生，
       所以一旦发生就得报出来（上面那句 flash 被它顶掉是有意的：这条更重要）。 */
    if (draft.unreadable > 0) {
      flash(`⚠ 草稿里有 ${draft.unreadable} 行没落进笔记格式（阅读页签和导出会看不见它们）`, 'warn')
    }
  }

  /* ── 结构整理那一趟（第 4 步）────────────────────────────────────────────
   * 只在**真有按行认回来的块**时才跑：输入是整板的行清单 + 每行的字 +（可选的）你的词，
   * 输出是一个只引用行号的 JSON 骨架。任何一步不成就回 null → 草稿退回"按块平铺"。
   * ★ 这一趟**出网**（纯文本，比看图那趟便宜得多），所以弹层上要看得见、关得掉。 */
  async function structureBlocks(board, blocks) {
    const usable = (Array.isArray(blocks) ? blocks : []).filter(
      (b) => Array.isArray(b.items) && b.items.length && Array.isArray(b.lines) && b.lines.length
    )
    if (!usable.length) return null
    const { text, rows } = buildStructureInput({
      title: (board && board.title) || '',
      blocks: usable.map((b) => ({ name: b.name, frameId: b.frameId, lines: b.lines, items: b.items })),
      vocab: transReview && transReview.useVocab ? transReview.vocab || [] : [],
      links: declaredLinkHints(board),
    })
    const r = await structureReading(text)
    if (!r.ok) return { error: r.error || '结构整理没成' }
    const parsed = parseStructureOutput(r.text, rows)
    if (!parsed.ok) return { error: parsed.error || '结构整理回的不是结构化内容' }
    /* 没被摆进任何一节的行 → 平铺进最后一节（宁可丑，不可丢）。 */
    const leftoverRows = (parsed.unplaced || []).map((id) => rows.find((x) => x.id === id)).filter(Boolean)
    const rendered = renderStructuredNote(parsed, rows)
    if (leftoverRows.length) rendered.leftover = [flatSection(leftoverRows)]
    return { ...rendered, dropped: parsed.dropped, vocabUsed: (transReview && transReview.vocab || []).length }
  }

  /* 板上"你宣告过/画过"的连接，给结构整理当参考（只报名字，不给它当判据）。 */
  function declaredLinkHints(board) {
    try {
      const cards = (board && board.cards) || []
      const byId = new Map(cards.map((c) => [c.id, c]))
      const frames = (board && board.frames) || []
      const nameOf = (id) => {
        const c = byId.get(id)
        if (c) return String((c.kind === 'formula' ? c.src || c.tex : c.text) || '').replace(/\s+/g, ' ').trim().slice(0, 24) || '一张卡'
        const f = frames.find((x) => x.id === id)
        return (f && f.title) || '一块'
      }
      return ((board && board.links) || []).slice(0, 20).map((l) => ({ from: nameOf(l.from), to: nameOf(l.to), kind: linkKind(l.kind).name }))
    } catch {
      return []
    }
  }

  /* 从**同层的笔记**里取你自己的词（第 4 步的"结合我的笔记"）。
     只读本机上的 .md（不联网）；读不到就回空 —— 词表是提示，缺了整条链路照跑。 */
  async function sameLayerVocab(board) {
    try {
      const lst = await api.list()
      const files = (Array.isArray(lst && lst.files) ? lst.files : [])
        .map((f) => (typeof f === 'string' ? f : f && (f.path || f.name)))
        .filter(Boolean)
      const here = current || ''
      const names = files
        .filter((f) => !/board-/.test(baseName(f)) && /\.md$/.test(f) && isSameLayer(here, f))
        .slice(0, 8)
      const notes = []
      for (const f of names) {
        const g = await api.get(f).catch(() => null)
        if (g && typeof g.text === 'string' && !g.error) notes.push({ path: f, text: g.text, near: true })
      }
      return pickVocab(notes)
    } catch {
      return []
    }
  }

  async function confirmTransReview(texts) {
    const rv = transReview
    if (!rv) return
    stopTranscribe() // 还有块在认就先把后面的停掉（弹层已经收了，再填也没地方去）
    cancelRef.current = null
    /* 清空 = 不要那一块；空白块不进草稿（和"模型回 EMPTY"一个待遇）。
       ★ 块的身份（`name` / `frameId`）跟着交下去 —— 草稿靠 frameId 把字放回
         **同名的那一节**底下（第 2 步）。
       ★ 改过的字用 `relines` **挂回原来的行号**（结构整理那一趟只认行号）。
         行数对不上（你加了一行/删了一行）→ `items: null` = 这一块退化成整段。 */
    const blocks = (Array.isArray(rv.bands) ? rv.bands : [])
      .map((b, i) => {
        const text = String((Array.isArray(texts) ? texts[i] : '') || '')
        return {
          name: (b && b.name) || '',
          frameId: (b && b.frameId) || null,
          lines: (b && b.lines) || [],
          text: text.trim(),
          items: b && b.items ? relines(text, b.items) : null,
          error: (b && b.error) || '',
        }
      })
      .filter((b) => b.text || b.error)

    /* 第二趟：读结构。它要几秒、而且**弹层先别关**（不然屏幕上什么反馈都没有）。 */
    let structured = null
    let structErr = ''
    if (blocks.some((b) => b.items && b.items.length)) {
      setTransReview({ ...rv, bands: rv.bands, streaming: false, confirming: true })
      try {
        structured = await structureBlocks(rv.board, blocks)
        if (structured && structured.error) {
          structErr = structured.error
          structured = null
        }
      } catch (e) {
        structErr = (e && e.message) || '结构整理出错了'
        structured = null
      }
    }
    setTransReview(null)
    await writeDraft(rv.board, rv.raw, blocks, rv.ocrFail, structured)
    if (structErr) flash(`结构没读出来（${structErr}）—— 草稿照旧按块收着，一个字没丢`, 'warn')
  }

  /* 新建一"层"（目录）。★ 2026-09-21 之前它问的是**完整路径**（预填"当前那一层 + /"），
     于是"分层"这件事又变回打字 —— 而现在层是**框里那一排可点的按钮**，
     名字框里只有新那一层的名字。想一次往下开几层照样可以打 `电磁学/第一章`。
   * ⚠ 这条和目录行上的「＋分层」现在是**同一条**（都走 `newIn`）：区别只剩"初值"
     （顶栏 = 你现在所在的这一层，目录行 = 你点的那一行）。 */
  async function newFolder() {
    await newIn(parentPath(current || ''), 'new-folder')
  }

  /* ── "点出来的"那条路（2026-09-18）────────────────────────────────────
   * 用户原话：**「现在的分层不是很人性化我还要自己输入上层的名字才能生成，
   * 你可以参考下 onenote 的分层规则这样靠点击来在分层下面建立新白板很人性化」**。
   *
   * ★ 2026-09-21：这条路和顶栏那两颗**合成了一条** —— 问话是同一句
   *   （`new-board` / `new-folder`，框里都有一排**可点的层**），区别只剩"初值"：
   *     顶栏 = 你现在所在的那一层；目录行那颗 = **你点的那一行**。
   *   `here-board` / `here-folder` 两条问话因此删掉了（同一句话不用有两份）。
   *
   *   `askId`  问的是哪条问话（`new-board` / `new-folder`）—— 决定"建出来之后打开吗"
   *   `where`  **你点的那一行**（`''` = 根）。它是层选择器的**初值**：
   *            想换一层就点那排里的另一颗，不用把名字删掉重打。
   *
   * ⚠ 为什么这里要自己处理"上一层不存在"：`/api/new` 撞名直接回 409、**不会**顺手建目录；
   *   而左栏里看得见的那一行，盘上**一定**有（树是从 `/api/list` 的 folders 摆出来的），
   *   所以正常走不到那一步 —— 但"目标那一层恰好没建出来"（比如 `?file=` 指着深处一张板、
   *   文件夹清单还没回来）的代价是"点了「＋」什么都没发生"，那比多一次 mkdir 难受得多。
   *   `layerNeeds` 判"要不要补"，`/api/mkdir` 对已存在的层不算错（回 existed）。 */
  async function newIn(dir, askId) {
    const where = dir == null ? '' : String(dir)
    const raw = await ask(askId, { where, layers: folders })
    if (!raw) return
    const segSegs = splitTitlePath(raw)
    /* ⚠ **别在这里再拼一次 `where`**（2026-09-21 踩的）：
       `Ask` 交出来的已经是"**选中的那一层 + 你打的名字**"（层选择器就是在那儿拼的），
       这里再 `joinPath(where, …)` 一次 → 路径被套了两遍：
       实测在「zz-sidetree/大物」里点「＋」输入 `board-x`，
       建出来落在 `zz-sidetree/大物/zz-sidetree/大物/board-x.md`（**凭空多出两层**）。
       ⇒ 用户还是可以在这一个框里再往下写几层（`电磁学/第一章`）：那是"一次建多层"，
         和选中的那一层**叠加**，叠加发生在 `Ask` 那一处（点的是起点、打的是往下走几格）。 */
    const want = segSegs.dir
    if (layerNeeds(want, folders)) {
      const mk = await api.mkdir(want)
      if (mk.error) return flash(mk.error, 'err')
    }
    if (!segSegs.title) {
      /* `电磁学/` 这种（只写了层、没写名字）：层建出来了，到此为止 ——
         但**得让用户看见**（不然"我回车了，什么都没发生"）。 */
      if (want) await settleNewLayer(want)
      return
    }
    if (askId === 'new-folder') {
      const r = await api.mkdir(joinPath(want, segSegs.title))
      if (r.error) return flash(r.error, 'err')
      await settleNewLayer(r.path)
      return
    }
    const name = await createBoard({ ask, flash, refresh: refreshList, dir: want, title: segSegs.title })
    if (!name) return
    await open(name, { force: true })
    flash('新白板：画吧')
  }

  /* 建完一层之后的收尾：刷新 → 展开 → **滚到它、闪一下**（2026-09-21）。
   * ★ 为什么要闪：原来只 flash 一句"建好了这一层：大物/电磁学"，而左栏是一棵树 ——
   *   新那一层可能出现在**看不见的地方**（滚动条下面、或者折着的分支里）。
   *   用户点完看到界面上什么都没变，只能自己去找（这就是"点了没反应"的另一种样子）。 */
  async function settleNewLayer(path) {
    await refreshList()
    expandTo(path)
    setJustMade({ path, at: Date.now() })
    flash('建好了这一层：' + path)
    setTimeout(() => setJustMade((j) => (j && j.path === path ? null : j)), 2200)
  }

  /** 目录行上那颗「＋白板」：在**这一层里**放一张新板（层 = 你点的那一行） */
  const newBoardHere = (dir) => newIn(dir, 'new-board')
  /** 目录行上那颗「＋分层」：在**这一层里**再开一层（位置同上） */
  const newFolderIn = (dir) => newIn(dir, 'new-folder')

  /* `dir` 传 `null` = "当前文件所在的那一层"（顶栏那颗「＋ 白板」按这个走）。
     ★ 2026-09-21：名字框里**不再预填路径** —— 层由框里那一排可点的按钮选，
       初值就是这里算出来的 `where`（= 你现在所在的那一层）。 */
  async function newBoardFile(dir = null) {
    const where = dir != null ? dir : parentPath(current || '')
    const name = await createBoard({ ask, flash, refresh: refreshList, dir: where, where, layers: folders })
    if (!name) return
    await open(name, { force: true })
    flash('新白板：画吧')
  }

  /* 改名 / 换一层。服务端那边有"目标已存在就拒绝"的闸 ——
     拖拽和这里都走它，绝不静默覆盖掉另一个文件。
   * ⚠ 这不是界面上那个"改名"（那是行上就地改，见 startRename / doRename）：
     这一条是**统一的服务端入口**（左栏那颗 ⤳ 的第二个功能、拖拽失败时的兜底），
     它知道"打开着的那张被挪走了，`current` 得跟着改"——那份知识只能有一处。 */
  async function relocate(from, to) {
    const r = await api.move(from, to)
    if (r.error) {
      flash(r.error, 'err')
      return null
    }
    await refreshList()
    if (current === from) {
      /* 打开的那张被挪了：`current` 得跟着改，不然下一次自动保存会拿着旧路径写，
         在 data/ 里凭空重建一份出来（而且用户看不见）。 */
      setCurrent(r.to)
      boardTextRef.current = text
    }
    expandTo(parentPath(r.to))
    return r.to
  }

  /* ★ 改名**只做一件事**：换最后那一段。分层靠拖拽和「移到别处」，
     所以这里永远不需要用户打一条路径，也就永远不会打错一条路径。
     （从前那个"写完整路径"的 prompt 是改名、移动、打字三件事挤在一个框里 ——
       拖拽有了之后，那个框只剩"改名"这一件事，那就别让它假装是别的。） */
  async function doRename(from, raw) {
    if (renaming !== from) return // 已经处理过了（blur 会跟着 Enter 再来一次）
    setRenaming(null)
    if (raw == null) return // Esc：不干了
    const want = String(raw).trim()
    if (!want) return flash('名字不能为空', 'err')
    const to = joinPath(parentPath(from), want + '.md')
    if (!isRenamed(from, to)) {
      /* 只改了大小写 / 什么都没改：界面上看不出变化，但盘上可能是真改了名
         （Windows 不区分大小写，须走一次服务端），所以还是发出去。 */
      if (to !== from) await relocate(from, to)
      return
    }
    const done = await relocate(from, to)
    if (done) flash('改好了：' + baseName(done))
  }

  /* 改名的入口。**只有白板能在这儿改名**：笔记的名字就是它的路径，
     而路径是笔记用来互相引用的东西（`[[大物/电磁学/…]]`），
     在这儿悄悄换掉等于**背着一堆引用改名**，那件事该是一趟单独的整理，
     不该藏在左栏的一个双击里。所以笔记改名走那一套：改名 + 更新引用，一起做。 */
  const canRename = !!current && isBoardName(current)
  const sayWhyNot = () => flash('笔记改名要连引用一起改，先开「笔记」那一栏来做', 'warn')

  async function startRename(p) {
    if (!canRename) return sayWhyNot(p)
    expandTo(p) // 埋在折起来的层里？先展开它自己那一行
    setRenaming(p)
    /* 正好在打开的那张上动刀：改完 `current` 跟着变，下一次自动保存才写对地方。
       （文本内容一个字不动 —— 改名就是改名。） */
  }

  /* ── 拖动：把一行拖到某一层上就是"挪进去" ──
     目标层允许是 `''`（根）。服务端还会再挡两道（不许挪进自己肚子里、目标已存在就拒），
     这里只做"看起来该不该动"的那点判断，别把服务端的闸抄一份过来。 */
  const dragRef = useRef(null)
  const foldersSet = useMemo(() => new Set(folders), [folders])

  function onDragStart(e, from) {
    dragRef.current = from
    try {
      e.dataTransfer.setData('text/plain', from)
      e.dataTransfer.effectAllowed = 'move'
    } catch {
      /* 有些环境不让写 dataTransfer，靠 dragRef 也能走完 */
    }
  }

  function onDragOverDir(e, dir) {
    if (dragRef.current == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropDir((prev) => (prev === dir ? prev : dir))
  }

  async function onDropDir(e, dir) {
    e.preventDefault()
    const from = dragRef.current
    dragRef.current = null
    setDropDir(null)
    if (!from || parentPath(from) === dir) return
    if (from === dir || (foldersSet.has(from) && dir.startsWith(from + '/'))) return
    /* 走 relocate：它才是那个知道"打开着的被挪了、current 要跟着改"的地方。
       （原来这里把那段抄了一份 —— 抄漏一次就是"拖完再画一笔，凭空多出一个文件"） */
    await relocate(from, joinPath(dir, baseName(from)))
    expandTo(dir)
    flash('已移到 ' + (dir || '根目录'))
  }

  // ---- Ctrl+S 保存 / Ctrl+Shift+加号减号 调字号 ----
  useEffect(() => {
    function onKey(e) {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key
      if (k === 's' || k === 'S') {
        e.preventDefault()
        // 白板是自动存的，别抢它的 Ctrl+S（它自己也没绑）
        if (!isBoard) save()
        return
      }
      if (e.shiftKey && (k === '=' || k === '+' || k === 'Add')) {
        e.preventDefault()
        bumpScale(SCALE_STEP)
      } else if (e.shiftKey && (k === '-' || k === '_' || k === 'Subtract')) {
        e.preventDefault()
        bumpScale(-SCALE_STEP)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, text, isBoard])

  // ---- 让服务知道"页面还在"：关掉标签页 = 服务自己停 ----
  // 服务端只认心跳。心跳停了（标签页关了、浏览器崩了、被强杀）就自己退出，
  // 于是你不用"先关服务"再关浏览器。
  // 这里刻意**不**在标签页切到后台时停心跳：切标签不等于关页面，
  // 把服务停掉会让你切回来时看到一个死页面。
  useEffect(() => {
    // 刚打开时先报一次到，避免"服务在页面加载期间就以为自己没人管了"
    const beat = () => {
      fetch('/api/heartbeat', { method: 'POST' }).catch(() => {})
    }
    beat()
    const t = setInterval(beat, 5000)

    // 正在关页面：用 sendBeacon 立刻通知，不用等服务端那 15 秒超时。
    // 为什么要 beacon：普通 fetch 在页面卸载时会被取消，来不及发出去。
    const bye = () => {
      try {
        navigator.sendBeacon('/api/bye')
      } catch {
        /* 发不出去也没关系，服务端还有心跳超时兜底 */
      }
    }
    window.addEventListener('pagehide', bye)
    window.addEventListener('beforeunload', bye)

    return () => {
      clearInterval(t)
      window.removeEventListener('pagehide', bye)
      window.removeEventListener('beforeunload', bye)
    }
  }, [])

  // ---- 磁盘被外部改动的检测 ----
  useEffect(() => {
    const t = setInterval(async () => {
      if (!current) return
      const r = await fetch('/api/watch').then((x) => x.json()).catch(() => null)
      if (!r || !r.watch) return
      const m = r.watch[current]
      if (m && diskMtime && m > diskMtime && !dirty) {
        flash('这个文件在磁盘上被改过了（VSCode？），点「重载」看最新', 'warn')
      }
    }, 2500)
    return () => clearInterval(t)
  }, [current, diskMtime, dirty])

  function jumpToLine(line) {
    // 在阅读视图里点节点时，要先切回编辑视图，等编辑器挂上了再跳
    setPendingJump(line)
    if (view !== 'edit') setView('edit')
    else if (jumpRef.current) jumpRef.current(line)
  }

  function onRefTitle(title) {
    const target = doc.resolveOne(title)
    if (target) {
      setSelectedId(target.id)
      jumpToLine(target.line)
    } else {
      flash(`「${title}」还没有定义节点——去「量」那一支补一个`, 'warn')
    }
  }

  const hubs = useMemo(
    () =>
      doc.quantityNodes
        .filter((n) => (doc.refCount.get(n.id) || 0) > 0)
        .sort((a, b) => (doc.refCount.get(b.id) || 0) - (doc.refCount.get(a.id) || 0))
        .slice(0, 6),
    [doc]
  )
  const islandCount = doc.quantityNodes.filter((n) => (doc.refCount.get(n.id) || 0) === 0).length

  /* 树要用到的一堆东西打成一包（TreeRows 是递归的，一层层传 props 会有十几行）。
     放这儿而不是 useMemo：里面每一个都是本组件这次渲染里的函数/值，
     包一层 useMemo 只会让"哪一份才是最新的"多一个可能。 */
  const treeCtx = {
    isOpen,
    toggleDir,
    open,
    openWithGuard,
    current,
    isBoard,
    dropDir,
    setDropDir,
    onDragStart,
    onDragOverDir,
    onDropDir,
    newBoardHere,
    newFolderIn,
    canRename,
    renaming,
    startRename,
    doRename,
    sayWhyNot,
    exportNote,
    justMade,
  }

  return (
    <div className={'app' + (isBoard ? ' board-mode' : '') + (boardFs ? ' fs' : '')}>
      <aside className="side">
        <div className="brand">
          <div className="logo">sh</div>
          <div>
            <div className="bname">studyhelper</div>
            <div className="btag">过手总结台</div>
          </div>
        </div>

        {/* 两个入口：白板是"打开就能画"的那一个，笔记是"整理成树"的那一个。
            刻意把白板放第一个 —— 以前这里只有笔记，于是工具长成了一个
            "要精通 Markdown 的老师才用得动"的备课器，那不是我最初要的东西。 */}
        <div className="modes">
          <button
            className={'mode' + (isBoard ? ' on' : '')}
            onClick={() => boardFiles[0] ? open(boardFiles[0].name) : newBoardFile()}
            title="白板：手一画，关系自己出来"
          >
            ✎ 白板
          </button>
          <button
            className={'mode' + (!isBoard ? ' on' : '')}
            onClick={() => noteFiles[0] ? open(noteFiles[0].name) : newNote()}
            title="笔记：量 — 公式 — 关系 的树（适合最后通一遍）"
          >
            ▤ 笔记
          </button>
        </div>

        <div className="side-sec">
          {/* 这一行本身就是**根目录**的放置目标：把一行拖到这儿 = 挪回根上。
              一个目录里没有"上层"可以拖，所以根上必须有这么一块地方。 */}
          <div
            className={'side-title' + (dropDir === '' ? ' drop' : '')}
            onDragOver={(e) => onDragOverDir(e, '')}
            onDragLeave={() => setDropDir(null)}
            onDrop={(e) => onDropDir(e, '')}
          >
            <span className="title-label">{isBoard ? '我的一课一页' : '我的总结笔记'}</span>
            {/* 白板这一行右边只有"新建"：改名在**行上**（点名字那一格就地改）——
                这里再放一个全局的「改名」按钮，就得先回答"改哪一个"，
                而"哪一个"在树里本来就看得见。笔记不用在这儿改名（见 canRename，
                它要连引用一起改，是另一趟整理）。 */}
            <span className="title-acts">
              <button className="mini" onClick={() => (isBoard ? newBoardFile() : newNote())} title={'新建一张' + (isBoard ? '白板' : '笔记') + '（名字里带 / 就是分层）'}>
                ＋ {isBoard ? '白板' : '笔记'}
              </button>
              {/* ★ 顶栏这一颗 = 在**根目录**里开一层。
                  换纸那一次（2026-09-18）之后，"在这一层里开一层"这件事落到了
                  目录行的「▣」上 —— 那一颗更准（你点的那一行就是位置），
                  所以这一颗不再假装"在某一层里"：它明说是根，想往深处开就去点那一行。
                  留着它是因为根上必须先有第一层 —— 不然新用户没法开头。 */}
              <button className="mini" onClick={newFolder} title="在根目录里新建一层（想开在某一层里面，就去点那一行的「▣」）">
                ＋ 分层
              </button>
            </span>
          </div>
          <div className="filelist">
            <TreeRows node={shown} depth={0} ctx={treeCtx} />
            {isEmpty && (
              <div className="dim pad">{isBoard ? '还没有白板，点「＋ 白板」' : '还没有笔记'}</div>
            )}
          </div>
        </div>

        {!isBoard && (
          <div className="side-sec">
            <div className="side-title">枢纽（被引最多）</div>
            {hubs.map((n) => (
              <button key={n.id} className="hubrow" onClick={() => setSelectedId(n.id)}>
                <span className="hub-name">{cleanName(renderTitle(n))}</span>
                <span className={'heatbar h' + Math.min(doc.refCount.get(n.id) || 0, 5)}>
                  {'▮'.repeat(Math.min(doc.refCount.get(n.id) || 0, 5))}
                </span>
              </button>
            ))}
            {hubs.length === 0 && <div className="dim pad">还没有连线</div>}
            {islandCount > 0 && (
              <div className="island-note">
                有 <b>{islandCount}</b> 个量没人用到（孤岛）
              </div>
            )}
          </div>
        )}

        <div className="side-foot">
          {/* ★ 这一行就是用户问的那个问题的答案（2026-09-18）：
              「我在哪里找到存放导出的文件夹」。点一下资源管理器直接跳过去。
              为什么不写成一串路径文字：一串 `C:\Users\…\data\.导出` 他得自己
              一段段去翻，而这里是**能点的**。常驻在这儿 = 不用靠记忆。 */}
          {!isBoard && (
            <button className="side-export" onClick={() => revealExport(EXPORT_DIR)} title={'在资源管理器里打开导出目录（' + EXPORT_DIR + '）'}>
              <span className="se-ico">↗</span>
              <span className="se-txt">
                导出的网页在 <code>{EXPORT_DIR}</code>
              </span>
            </button>
          )}
          <div className="dim small">数据在 data/ 目录，纯文本</div>
          {/* ★ 这个开关必须是**双向**的。
              原来它写死"字太小 →"、只会放大 —— 而白板模式下顶栏不渲染
              （白板用自己的工具条），于是白板里根本找不到"调小"的入口，
              只有这一个只会变大的按钮。用户看到的正是这个。
              现在按当前字号决定箭头方向：比默认小就提示放大，比默认大就提示缩小，
              正好在默认值上就两端都给。 */}
          <div className="side-zoom-row">
            {scale > SCALE_DEFAULT ? (
              <button className="side-zoom" onClick={() => bumpScale(-SCALE_STEP)} title="字太大了？点这里缩小">
                ← 字太大
              </button>
            ) : null}
            {scale < SCALE_DEFAULT ? (
              <button className="side-zoom" onClick={() => bumpScale(SCALE_STEP)} title="字太小？点这里放大">
                字太小 →
              </button>
            ) : null}
            {scale === SCALE_DEFAULT ? (
              <>
                <button className="side-zoom" onClick={() => bumpScale(-SCALE_STEP)} title="缩小字号">
                  ← 小
                </button>
                <button className="side-zoom" onClick={() => bumpScale(SCALE_STEP)} title="放大字号">
                  大 →
                </button>
              </>
            ) : null}
            <button
              className="side-zoom-val"
              onClick={() => setScale(SCALE_DEFAULT)}
              title={'当前 ' + Math.round(scale * 100) + '%，点一下回到默认 ' + Math.round(SCALE_DEFAULT * 100) + '%'}
            >
              {Math.round(scale * 100)}%
            </button>
          </div>
        </div>
      </aside>

      {isBoard ? (
        /* ★ 必须**包一层**再放进网格。
           .bd-topline 和 Board 是两个兄弟元素：只给 .bd 指定 grid-column:2/row:1 的话，
           网格的自动放置会把 topline 丢进**第 2 行**，于是第一行只剩白板、
           第二行被 topline 占掉 —— 表现就是"白板高度莫名少了一半"。
           包一层之后，这一层占住 (1,2)，两个孩子在它里面纵向排。 */
        <div className="bd-shell">
          {/* 白板自己有一套工具条，但"现在开的是哪个文件"必须一眼看见 ——
              不然画了半天不知道画在哪张板上（有五张板的时候非常要命）。 */}
          <div className="bd-topline">
            <span className="bd-file">{current || '（没有打开白板）'}</span>
            <span className="dim small">自动保存 · 手写笔直接画 · 手指拖平移、两根手指捏合缩放</span>
          </div>
          <Board
            key={current}
            file={current}
            initialText={boardTextRef.current}
            reloadToken={boardReload}
            onSave={saveBoardText}
            flash={flash}
            /* 「收拢成笔记」：Board 手里才有活板（boardRef），App 手里只有文件原文。
               点工具条那颗时 Board 把**当前板对象**递上来，草稿在 App 这边生成
               （要弹询问框、要建文件、要切模式 —— 这些都是 App 的事）。 */
            onGatherNote={gatherNote}
            /* 界面字号：白板模式顶栏不渲染，所以调字号的入口得进白板工具条，
               否则白板里就只能靠左栏那一个（而且那一个原来只会放大）。 */
            scale={scale}
            onScale={bumpScale}
            onScaleReset={() => setScale(SCALE_DEFAULT)}
            fullscreen={boardFs}
            onToggleFullscreen={toggleBoardFs}
          />
        </div>
      ) : (
        <>
          <main className="center">
            <div className="topbar">
          <div className="cur-name">
            {current || '（没有打开文件）'}
            {dirty && <span className="dot-dirty" title="有没保存的改动">●</span>}
          </div>
          <div className="top-actions">
            <div className="viewtabs">
              <button className={view === 'edit' ? 'on' : ''} onClick={() => setView('edit')} title="直接改原文，看到的是渲染后的样子">
                编辑
              </button>
              <button className={view === 'read' ? 'on' : ''} onClick={() => setView('read')} title="整屏只读：公式排出来、结构摆开 —— 看笔记用这个">
                阅读
              </button>
            </div>
            <div className="zoom" title="调整整个界面的字号（也可以 Ctrl+Shift+加号 / 减号）">
              <button className="mini" onClick={() => bumpScale(-SCALE_STEP)} disabled={scale <= SCALE_MIN}>
                A−
              </button>
              <button
                className="zoom-val"
                onClick={() => setScale(SCALE_DEFAULT)}
                title="点一下回到 125%"
              >
                {Math.round(scale * 100)}%
              </button>
              <button className="mini" onClick={() => bumpScale(SCALE_STEP)} disabled={scale >= SCALE_MAX}>
                A+
              </button>
            </div>
            {view === 'edit' && (
              <button className="btn ghost" onClick={() => setFocusMode((v) => !v)} title="只亮着光标那一行，其余压暗">
                {focusMode ? '专注：开' : '专注'}
              </button>
            )}
            <button className={'btn' + (dirty ? ' primary' : '')} onClick={save} disabled={!current}>
              保存 <kbd>Ctrl+S</kbd>
            </button>
            <button className="btn" onClick={() => open(current, { force: true })} disabled={!current}>
              重载
            </button>
          </div>
        </div>

        {view === 'edit' ? (
          <>
            <FormulaBar editing={editing} />
            <div className={'rawwrap' + (focusMode ? ' focus' : '')}>
              <SourceEditor
                text={text}
                textareaRef={taRef}
                editing={editing}
                onEdit={(val) => {
                  setTextNow(val)
                  setDirty(true)
                }}
                onSelectNode={setSelectedId}
                onRefTitle={onRefTitle}
                jumpRef={jumpRef}
                fontSizePx={scale}
                diag={diag}
              />
            </div>
          </>
        ) : (
          <div className="prevwrap big">
            <div className="prevbar">
              <span>阅读 · 渲染后的结构</span>
              <span className="dim small">
                {doc.nodes.length} 个节点 · {doc.quantityNodes.length} 个量 · 点任一节点去编辑它
              </span>
            </div>
            <Preview
              doc={doc}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id)
                const n = doc.nodes.find((x) => x.id === id)
                if (n) jumpToLine(n.line) // 点节点直接带去编辑那一行
              }}
              onRefTitle={onRefTitle}
            />
          </div>
        )}
      </main>
    </>
  )}

      {busy && <div className="cover">{busyMsg || '载入中…'}</div>}
      {/* 转录校对（TranscribeReview）：盖在一切上面（z 420 > busy 的 100），
          传送门是 setTransReview —— gatherNote 转录完打开，confirmTransReview 收尾。 */}
      {transReview && (
        <TranscribeReview
          bands={transReview.bands}
          ocrFail={transReview.ocrFail}
          streaming={!!transReview.streaming}
          confirming={!!transReview.confirming}
          vocab={transReview.vocab || []}
          useVocab={!!transReview.useVocab}
          onToggleVocab={(v) => setTransReview((rv) => (rv ? { ...rv, useVocab: !!v } : rv))}
          onRetry={retryBlock}
          onStop={stopTranscribe}
          onConfirm={confirmTransReview}
          onCancel={() => {
            /* 「先不收」/ Esc / 点外面：**先把还在等的请求停掉**再关 ——
               不然它认完之后还会回来改一个已经关掉的弹层的状态（白花钱还看不见）。 */
            stopTranscribe()
            cancelRef.current = null
            setTransReview(null)
          }}
        />
      )}
      {/* 询问框（从前是浏览器的 prompt）：`ask()` 把它打开，它 resolve 回去再往下走。
          挂在最后 = 压在所有东西上面（它自带的一层遮罩也是这么来的）。 */}
      {askState && (
        <Ask
          key={askState.id + ':' + askState.value + ':' + askState.where + ':' + (askState.extra || '')}
          spec={askState.spec}
          value={askState.value}
          multiline={askState.multiline}
          where={askState.where}
          layers={askState.layers}
          extra={askState.extra}
          onDone={closeAsk}
        />
      )}
      {toast && (
        <div className={'toast ' + toast.kind}>
          <span className="toast-msg">{toast.msg}</span>
          {/* 带动作的提示**不会自己消失**（见 flash 的说明）——
              要让人有机会点那颗按钮。点完就关掉，免得留着一个已经做过的事。 */}
          {toast.act && (
            <button
              className="toast-act"
              onClick={() => {
                const run = toast.act.run
                setToast(null)
                run && run()
              }}
            >
              {toast.act.label}
            </button>
          )}
          {toast.act && (
            <button className="toast-x" onClick={() => setToast(null)} title="知道了">
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}
