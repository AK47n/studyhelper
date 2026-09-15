import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FormulaBar from './components/FormulaBar.jsx'
import Preview from './components/Preview.jsx'
import ContextPanel from './components/ContextPanel.jsx'
import SourceEditor from './components/SourceEditor.jsx'
import { parseDoc, renderTitle, cleanName } from './lib/parse.js'
import { normalizeMarkers, useFormulaEditing } from './lib/useFormulaEditing.js'
import { SEED_NAME, SEED_TEXT } from './seed.js'

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
  const [pendingJump, setPendingJump] = useState(null) // 从阅读视图切回编辑后要跳到的行

  const taRef = useRef(null)
  const jumpRef = useRef(null)

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
        await api.create(SEED_NAME, SEED_TEXT)
        list = await api.list()
      }
      setFiles(list.files || [])
      if (list.files && list.files.length) await open(list.files[0].name)
      setBusy(false)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function open(name, { force = false } = {}) {
    if (!force && dirty && !confirm('当前文件有没保存的改动，切换会丢掉。继续？')) return
    const r = await api.get(name)
    if (r.error) return flash(r.error, 'err')
    setCurrent(name)
    const shown = String(r.text ?? '')
    if (deriveTimer.current) clearTimeout(deriveTimer.current)
    setText(shown)
    setDerivedText(shown) // 换文件立即生效，不用等防抖
    if (taRef.current) taRef.current.value = shown
    setDiskMtime(r.mtime || 0)
    setDirty(false)
    setSelectedId(null)
    requestAnimationFrame(() => taRef.current && taRef.current.focus())
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

  async function newFile() {
    const name = prompt('新文件叫什么？（一节课 / 一周一个文件都行）', '大物 · 电磁学')
    if (!name) return
    const r = await api.create(name, `# ${name.replace(/\.md$/i, '')}\n\n- \n`)
    if (r.error) return flash(r.error, 'err')
    const list = await api.list()
    setFiles(list.files || [])
    await open(r.name, { force: true })
    flash('建好了：' + r.name)
  }

  // ---- Ctrl+S 保存 / Ctrl+Shift+加号减号 调字号 ----
  useEffect(() => {
    function onKey(e) {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key
      if (k === 's' || k === 'S') {
        e.preventDefault()
        save()
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
  }, [current, text])

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
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="logo">sh</div>
          <div>
            <div className="bname">studyhelper</div>
            <div className="btag">过手总结台</div>
          </div>
        </div>

        <div className="side-sec">
          <div className="side-title">
            我的总结
            <button className="mini" onClick={newFile}>
              ＋ 新建
            </button>
          </div>
          <div className="filelist">
            {files.map((f) => (
              <button
                key={f.name}
                className={'filerow' + (f.name === current ? ' on' : '')}
                onClick={() => open(f.name)}
                title={f.name}
              >
                <span className="fname">{f.title}</span>
                <span className="fmeta">{f.nodes} 节点</span>
              </button>
            ))}
            {files.length === 0 && <div className="dim pad">还没有文件</div>}
          </div>
        </div>

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

        <div className="side-foot">
          <div className="dim small">数据在 data/ 目录，纯文本</div>
          <button className="side-zoom" onClick={() => bumpScale(SCALE_STEP)} title="字太小？点这里放大">
            字太小 →
          </button>
        </div>
      </aside>

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

      {busy && <div className="cover">载入中…</div>}
      {toast && <div className={'toast ' + toast.kind}>{toast.msg}</div>}
    </div>
  )
}
