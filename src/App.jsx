import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FormulaBar from './components/FormulaBar.jsx'
import Preview from './components/Preview.jsx'
import ContextPanel from './components/ContextPanel.jsx'
import SourceEditor from './components/SourceEditor.jsx'
import Board from './components/Board.jsx'
import { isBoardName, newBoard, serializeBoardDocument } from './lib/board.js'
import { parseDoc, renderTitle, cleanName } from './lib/parse.js'
import { normalizeMarkers, useFormulaEditing } from './lib/useFormulaEditing.js'
import { SEED_NAME, SEED_TEXT } from './seed.js'
import { buildSeedBoard } from './seed-board.js'

const api = {
  list: () => fetch('/api/list').then((r) => r.json()),
  get: (name) => fetch('/api/file/' + encodeURIComponent(name)).then((r) => r.json()),
  put: (name, text) =>
    fetch('/api/file/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => r.json()),
  create: (name, text) =>
    fetch('/api/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text }),
    }).then((r) => r.json()),
}

/* 白板的新建得先问一下"这一课叫什么" —— 板子里有标题，
   文件名只是给人看的（Git、列表）。两步都做，看着才不别扭。 */
async function createBoard({ prompt, flash, refresh }) {
  const raw = prompt('这一课叫什么？（写"大物 · 电磁学"就行）', '')
  if (!raw || !raw.trim()) return null
  const title = raw.trim().replace(/\.md$/i, '')
  const r = await api.create('board-' + title + '.md', serializeBoardDocument(newBoard(title)))
  if (r.error) {
    flash(r.error, 'err')
    return null
  }
  await refresh()
  return r.name
}

/* 一张白板都没有的时候，直接开一张**空**的，别退回笔记界面。
   ── 为什么不能退：白板是这个工具的入口（左栏第一个按钮、README 第一段），
      列表里没有板就不给板 = 把入口锁上了。用户真正的遭遇：
      data/ 里板被删干净、只剩笔记，打开就进笔记界面；
      想画还得先点一下「白板」，再回答一个"这一课叫什么"的弹窗。
   ── 为什么是空白板而不是样板板：样板是"第一次装这个工具"的见面礼，
      只在 data/ 完全为空时给（见 createSeedBoard 的调用处）；
      用户已经把板删干净了，说明他要自己从头来，再塞一张示例进去是添乱。
   ── 为什么名字要在这里先探一遍：服务端 /api/new 撞名直接回 409，
      不探就是静默失败（结果还是进笔记界面，症状和没修一样）。 */
async function ensureBoard({ files, refresh, flash }) {
  const taken = new Set((files || []).map((f) => f.name))
  let name = ''
  for (let i = 1; i <= 99 && !name; i += 1) {
    const cand = i === 1 ? 'board-新白板.md' : `board-新白板 ${i}.md`
    if (!taken.has(cand)) name = cand
  }
  if (!name) return null
  const r = await api.create(name, serializeBoardDocument(newBoard('新白板')))
  if (r.error) {
    flash(r.error, 'err')
    return null
  }
  await refresh()
  return r.name
}

/* 第一次打开"一张白板都没有"的时候，先放一张样板进去。
   理由是"关系靠位置"这件事必须看见一次才懂 —— 空板配一句说明，人是不会照做的。 */
async function createSeedBoard({ refresh, flash }) {
  const r = await api.create('board-示例 · 大物电磁学.md', serializeBoardDocument(buildSeedBoard()))
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

const clampScale = (v) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100))

function readScale() {
  try {
    const s = Number(localStorage.getItem(SCALE_KEY))
    return Number.isFinite(s) && s > 0 ? clampScale(s) : SCALE_DEFAULT
  } catch {
    return SCALE_DEFAULT
  }
}

export default function App() {
  const [files, setFiles] = useState([])
  const [current, setCurrent] = useState(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [toast, setToast] = useState(null)
  const [busy, setBusy] = useState(true)
  const [diskMtime, setDiskMtime] = useState(0)
  const [view, setView] = useState('edit') // 'edit' 直接编辑（已渲染的样子） | 'read' 整屏阅读
  const [focusMode, setFocusMode] = useState(false)
  const [diag, setDiag] = useState(false) // 对齐诊断：两层分别染色，重合处为紫色
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

  const taRef = useRef(null)
  const jumpRef = useRef(null)
  // 白板那边自己管存盘（它是自动存的），这里只留最后一次要落盘的内容
  const boardTextRef = useRef('')

  const isBoard = isBoardName(current)
  const boardFiles = useMemo(() => files.filter((f) => isBoardName(f.name)), [files])
  const noteFiles = useMemo(() => files.filter((f) => !isBoardName(f.name)), [files])

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

  const flash = useCallback((msg, kind = 'ok') => {
    setToast({ msg, kind, at: Date.now() })
    setTimeout(() => setToast((t) => (t && Date.now() - t.at >= 1900 ? null : t)), 2000)
  }, [])

  // ---- 首次加载 ----
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
      if (list.files.length === 0) {
        // 全新的用户：先给一张白板样板 + 一份笔记样板。
        // 白板在前，因为它才是入口（见下方"打开哪一个"的说明）。
        await createSeedBoard({ refresh: async () => {}, flash })
        await api.create(SEED_NAME, SEED_TEXT)
        list = await api.list()
      }
      setFiles(list.files || [])
      if (list.files && list.files.length) {
        /* ?file=<名字> —— **自检用的入口**：直接从 URL 打开指定的那一张板。
           ★ 为什么不走下面那条"列表里第一个"：自检要打开的是它自己造的夹具板，
             而列表第一个常常是用户自己那张（中文名在 zh 排序里排在 board-zz-* 前面），
             于是应用会先把用户的板读进来、冷字体缓存下还会重量卡片尺寸再写回去一次 ——
             每次自检都动一下用户的数据（README 自检那一节记着这条）。
             从这里进，用户那张板根本不会被读到。
           ★ 找不到就**什么都不打开**（只给一句话）：自检要躲的正是"退回列表里第一个"，
             退回等于把上面这条又踩一遍。这个参数不是给用户的功能，不用兜底到好看。
           ★ 名字只跟 /api/list 里的名字比，绝不当路径用（服务端另有 SAFE_NAME 那道闸）。 */
        const want = new URLSearchParams(window.location.search).get('file')
        if (want) {
          const hit = list.files.find((f) => f.name === want)
          if (hit) await open(hit.name, { force: true })
          else flash('?file= 说的那个文件不在列表里：' + want, 'err')
        } else {
          // 打开哪一个？优先白板 —— 这是"打开就能画"的默认入口。
          // 排序在服务端钉死了（见 server.js 的 /api/list），所以这里的结果是稳定的。
          const firstBoard = list.files.find((f) => isBoardName(f.name))
          if (firstBoard) {
            await open(firstBoard.name)
          } else {
            /* 一张板都没有（笔记还在、板被删干净了）。
               ★ 这里以前是直接打开第一个笔记 —— 用户看到的就是"怎么打开是笔记界面"。
               现在：补一张空板再进去；真的建不出来（名字探完了 / 写盘失败）才退回笔记。 */
            const made = await ensureBoard({ files: list.files, refresh: refreshList, flash })
            await open(made || list.files[0].name, { force: true })
            if (made) flash('没有白板，先给你开了一张空的：' + made)
          }
        }
      }
      setBusy(false)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function open(name, { force = false } = {}) {
    if (!force && !isBoardName(name) && dirty && !confirm('当前文件有没保存的改动，切换会丢掉。继续？')) return
    const r = await api.get(name)
    if (r.error) return flash(r.error, 'err')
    setCurrent(name)
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

  async function refreshList() {
    const list = await api.list().catch(() => null)
    if (list && list.files) setFiles(list.files)
  }

  // 白板：它自己决定什么时候存，我们只负责写盘 + 回个时间戳
  async function saveBoardText(t) {
    if (!current) return
    boardTextRef.current = t
    const r = await api.put(current, t)
    if (r.error) return flash(r.error, 'err')
    setDiskMtime(r.mtime || 0)
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
    const list = await api.list()
    setFiles(list.files || [])
  }

  async function newNote() {
    const name = prompt('新笔记叫什么？（一节课 / 一周一个文件都行）', '大物 · 电磁学')
    if (!name) return
    const r = await api.create(name, `# ${name.replace(/\.md$/i, '')}\n\n- \n`)
    if (r.error) return flash(r.error, 'err')
    await refreshList()
    await open(r.name, { force: true })
    flash('建好了：' + r.name)
  }

  async function newBoardFile() {
    const name = await createBoard({ prompt, flash, refresh: refreshList })
    if (!name) return
    await open(name, { force: true })
    flash('新白板：画吧')
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
          <div className="side-title">
            {isBoard ? '我的一课一页' : '我的总结笔记'}
            <button className="mini" onClick={isBoard ? newBoardFile : newNote}>
              ＋ 新建
            </button>
          </div>
          <div className="filelist">
            {(isBoard ? boardFiles : noteFiles).map((f) => (
              <button
                key={f.name}
                className={'filerow' + (f.name === current ? ' on' : '')}
                onClick={() => open(f.name)}
                title={f.name}
              >
                <span className="fname">{f.title}</span>
                <span className="fmeta">{isBoard ? '白板' : f.nodes + ' 节点'}</span>
              </button>
            ))}
            {(isBoard ? boardFiles : noteFiles).length === 0 && (
              <div className="dim pad">{isBoard ? '还没有白板，点「＋ 新建」' : '还没有笔记'}</div>
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
            <span className="dim small">自动保存 · 手写笔直接画 · 两根手指平移缩放</span>
          </div>
          <Board
            key={current}
            file={current}
            initialText={boardTextRef.current}
            reloadToken={boardReload}
            onSave={saveBoardText}
            flash={flash}
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
              <button className={view === 'read' ? 'on' : ''} onClick={() => setView('read')} title="整屏只读，方便通读">
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
              <>
                <button className="btn ghost" onClick={() => setFocusMode((v) => !v)} title="只亮着光标那一行，其余压暗">
                  {focusMode ? '专注：开' : '专注'}
                </button>
                <button
                  className={'btn ghost' + (diag ? ' primary' : '')}
                  onClick={() => setDiag((v) => !v)}
                  title="诊断对齐：着色层染蓝、编辑框染红，重合处是紫色。字应该是紫色"
                >
                  {diag ? '诊断：开' : '诊断'}
                </button>
              </>
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

          <aside className="right">
            <ContextPanel
              doc={doc}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id)
                const n = doc.nodes.find((x) => x.id === id)
                if (n) jumpToLine(n.line)
              }}
              onRefTitle={onRefTitle}
              onJumpLine={jumpToLine}
            />
          </aside>
        </>
      )}

      {busy && <div className="cover">载入中…</div>}
      {toast && <div className={'toast ' + toast.kind}>{toast.msg}</div>}
    </div>
  )
}
