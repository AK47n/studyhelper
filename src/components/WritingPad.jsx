import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { drawStroke, MIN_STEP } from '../lib/ink.js'
import { cleanLatex, describePayload, ocrSaveConfig, ocrStatus, ocrTest, recognizeHandwriting } from '../lib/ocr.js'
import { toFlat, toPoints } from '../lib/board.js'
import { canRender, Tex } from './Tex.jsx'

/* 手写公式的写字板。
 *
 * ── 为什么是"另开一块板"而不是"在白板上圈一块识别" ──
 * 白板上的字是你**思考的痕迹**：位置、大小、和别的东西的相对关系都有意义。
 * 如果识别后就地把它换成公式卡，你会失去"我当初是怎么写的"。
 * 所以识别发生在旁边一块专门的写字板上：写 → 看 → 满意了再放上去。
 * 代价是多一次点击，换来的是白板上的东西永远是你自己放上去的。
 *
 * ── 一次只认一个公式 ──
 * 识别服务是"一张图 → 一个 LaTeX"，多写几个公式它会串在一起。
 * 界面上直接写清楚这一点（"一次写一个"），比让你自己发现要好。
 *
 * ── 认错了怎么办 ──
 * 结果直接放在一个**可编辑的输入框**里，而不是直接变卡片。
 * 置信度低的时候还会明说"这次不太准"。识别是帮忙，不是替你做决定。
 */
export default function WritingPad({ onInsert, onClose, onOpenSettings, flash }) {
  const [strokes, setStrokes] = useState([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { ok, latex, conf, note, error, kind }
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  const wrapRef = useRef(null)
  const cvRef = useRef(null)
  const drawRef = useRef(null)
  /* 和画布那边同一个道理：用笔写的时候，别让十字光标跟在笔尖底下。
     鼠标照样显示 —— 不然鼠标就没法定位了。 */
  const [penMode, setPenMode] = useState(false)
  const penModeRef = useRef(false)

  // 打开时问一下配没配密钥 —— 没配的话第一步应该是去设置，而不是白写一遍
  useEffect(() => {
    let alive = true
    ocrStatus().then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // 重画写字板（笔迹都是这块板自己的局部坐标）
  useEffect(() => {
    const cv = cvRef.current
    if (!cv || !size.w || !size.h) return
    const dpr = Math.min(2.5, window.devicePixelRatio || 1)
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const ctx = cv.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (const s of strokes) drawStroke(ctx, s)
  }, [strokes, size])

  const local = useCallback((e) => {
    const r = wrapRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }, [])

  /* 谁在操作？只在真的换了设备时才 setState —— 每次 pointermove 都 set 会白重渲染。 */
  const trackPointerKind = useCallback((e) => {
    const isPen = e.pointerType === 'pen'
    if (isPen !== penModeRef.current) {
      penModeRef.current = isPen
      setPenMode(isPen)
    }
  }, [])

  const onDown = useCallback(
    (e) => {
      trackPointerKind(e)
      if (busy) return
      /* ★ 指针捕获要设在**收到事件的那个元素自己**身上（这里是 canvas）。
         第一版设在了外层的 .wp-padwrap 上：于是 pointermove / pointerup 全部
         被重定向到那个 div，而监听器挂在 canvas 上 —— 结果 back 就是
         "笔迹画出来了（live 重画生效），但一笔都没记下来"，
         界面永远停在「还没有笔迹」，而且**一个报错都没有**。
         表现和"画布坏了"一模一样，特别容易查错方向。 */
      e.currentTarget.setPointerCapture?.(e.pointerId)
      const p = local(e)
      drawRef.current = {
        id: e.pointerId,
        stroke: { tool: 'pen', color: '#1b1d22', width: 2.6, pressure: true, points: toFlat([{ x: p.x, y: p.y, p: e.pressure || 0.5 }]) },
      }
      const ctx = cvRef.current.getContext('2d')
      drawStroke(ctx, drawRef.current.stroke, { live: true })
    },
    [busy, local, trackPointerKind]
  )

  const onMove = useCallback(
    (e) => {
      trackPointerKind(e)
      const d = drawRef.current
      if (!d || d.id !== e.pointerId) return
      const ne = e.nativeEvent
      const evs = typeof ne.getCoalescedEvents === 'function' ? ne.getCoalescedEvents() : []
      const list = evs && evs.length ? evs : [ne]
      const r = wrapRef.current.getBoundingClientRect()
      let added = false
      for (const ev of list) {
        const x = ev.clientX - r.left
        const y = ev.clientY - r.top
        const n = d.stroke.points.length
        if (n >= 3 && Math.hypot(x - d.stroke.points[n - 3], y - d.stroke.points[n - 2]) < MIN_STEP) continue
        d.stroke.points.push(x, y, ev.pressure > 0 ? ev.pressure : 0.5)
        added = true
      }
      if (added) {
        // 只重画当前这一笔（和主画布一个套路：别为了跟手重画全部）
        const cv = cvRef.current
        const dpr = Math.min(2.5, window.devicePixelRatio || 1)
        const ctx = cv.getContext('2d')
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, cv.width, cv.height)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        for (const s of strokes) drawStroke(ctx, s)
        drawStroke(ctx, d.stroke)
      }
    },
    [strokes, trackPointerKind]
  )

  const onUp = useCallback(
    (e) => {
      const d = drawRef.current
      if (!d || d.id !== e.pointerId) return
      drawRef.current = null
      if (toPoints(d.stroke.points).length >= 2) setStrokes((cur) => [...cur, d.stroke])
    },
    []
  )

  const payloadInfo = useMemo(() => (strokes.length ? describePayload(strokes) : null), [strokes])

  const doRecognize = useCallback(async () => {
    if (!strokes.length) {
      flash('先写一个公式', 'warn')
      return
    }
    setBusy(true)
    setResult(null)
    const r = await recognizeHandwriting(strokes)
    setBusy(false)
    if (r.ok) {
      const tex = cleanLatex(r.latex)
      setResult({ ...r, latex: tex })
      setDraft(tex)
    } else {
      setResult(r)
      if (r.kind === 'no-key') {
        /* 没配密钥是最常见的第一步，直接把设置摊开，别让用户去找。
           ⚠ 但这个弹层和写字板是**同级**覆盖层（都是 .wp-back、都是 z-index:400），
             谁在上面只看 DOM 顺序 —— 设置是后渲染的，所以它会盖住写字板。
             所以：① 延时给够（原来 500ms 太急，"还没配密钥"这句提示刚出现就被盖住了，
             用户只看到一个突然蹦出来的设置窗口，不知道发生了什么）；
             ② 设置窗口里写清了"关掉这里就回到写字板"，免得以为刚写的笔迹丢了。 */
        setTimeout(() => onOpenSettings(), 1200)
      }
    }
  }, [strokes, flash, onOpenSettings])

  const insert = useCallback(() => {
    const tex = cleanLatex(draft)
    if (!tex) {
      flash('公式是空的', 'warn')
      return
    }
    onInsert({ tex })
  }, [draft, onInsert, flash])

  const previewTex = draft.trim()
  const renderable = useMemo(() => canRender(previewTex), [previewTex])

  return (
    <div className="wp-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wp" role="dialog" aria-label="手写公式">
        <div className="wp-head">
          <b>写公式</b>
          <span className="dim small">一次写一个。写完点「识别」</span>
          <button className="wp-x" onClick={onClose} title="关掉（Esc）">×</button>
        </div>

        {status && !status.configured && (
          <div className="wp-warn">
            还没配手写识别的密钥 → <button className="link" onClick={onOpenSettings}>去设置</button>
            （也可以先在这儿写，配好了再回来点识别）
          </div>
        )}

        <div className="wp-padwrap" ref={wrapRef}>
          <canvas
            ref={cvRef}
            className={'wp-pad' + (penMode ? ' nocursor' : '')}
            style={{ width: size.w, height: size.h }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          {!strokes.length && <div className="wp-hint">在这一块里写，写大一点识别更准</div>}
        </div>

        <div className="wp-acts">
          <button className="mini" onClick={() => { setStrokes([]); setResult(null); setDraft('') }} disabled={!strokes.length || busy}>
            清空
          </button>
          <button className="mini" onClick={() => setStrokes((c) => c.slice(0, -1))} disabled={!strokes.length || busy}>
            退一笔
          </button>
          <span className="dim small">
            {payloadInfo ? `${strokes.length} 笔 · 会发一张 ${payloadInfo.w}×${payloadInfo.h} 的图` : '还没有笔迹'}
          </span>
          <button className="btn primary" onClick={doRecognize} disabled={!strokes.length || busy}>
            {busy ? '识别中…' : '识别'}
          </button>
        </div>

        {result && !result.ok && (
          <div className={'wp-err kind-' + (result.kind || 'bad')}>
            <b>
              {result.kind === 'no-key' ? '还没配密钥' :
               result.kind === 'key' ? '密钥不对' :
               result.kind === 'quota' ? '额度用完或被限流' :
               result.kind === 'network' ? '连不上识别服务' :
               result.kind === 'empty' ? '没认出内容' : '识别失败'}
            </b>
            <div>{result.error}</div>
            {result.kind === 'no-key' || result.kind === 'key' ? (
              <button className="mini primary" onClick={onOpenSettings}>打开设置</button>
            ) : null}
            {result.kind === 'network' ? (
              <div className="dim small">写的东西还在，网络好了再点一次「识别」就行。</div>
            ) : null}
          </div>
        )}

        {result && result.ok && (
          <div className="wp-res">
            <div className="wp-res-head">
              <b>认出来了</b>
              {result.conf != null && (
                <span className={'wp-conf' + (result.conf < 0.6 ? ' low' : '')}>
                  置信度 {Math.round(result.conf * 100)}%
                </span>
              )}
              {result.note ? <span className="dim small">{result.note}</span> : null}
            </div>
            <div className="wp-preview">{renderable ? <Tex tex={previewTex} block /> : <span className="bd-tex-bad">{previewTex}</span>}</div>
            <input
              className="wp-edit"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') insert()
              }}
              title="认错了就在这儿改（这是 LaTeX，改坏了下面会红）"
            />
            <div className="wp-res-acts">
              <span className="dim small">放上去之后还能双击进卡片里继续改</span>
              <button className="btn primary" onClick={insert} disabled={!renderable}>
                放到白板上
              </button>
            </div>
          </div>
        )}

        <div className="wp-foot dim small">
          识别要联网（图会发到识别服务）。你的白板文件本身不上传。
        </div>
      </div>
    </div>
  )
}

/* ────────────────────────── 设置 ────────────────────────── */

export function OcrSettings({ onClose, onSaved, flash }) {
  const [status, setStatus] = useState(null)
  const [token, setToken] = useState('')
  const [provider, setProvider] = useState('deepseek')
  const [turbo, setTurbo] = useState(true)
  const [base, setBase] = useState('')
  const [dsBase, setDsBase] = useState('')
  const [model, setModel] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  useEffect(() => {
    ocrStatus().then((s) => {
      if (!s) return
      setStatus(s)
      setProvider(s.provider || 'deepseek')
      setTurbo(s.turbo !== false)
      setBase(s.base || '')
      setDsBase(s.dsBase || '')
      setModel(typeof s.model === 'string' ? s.model : '')
    })
  }, [])

  const save = useCallback(async () => {
    const patch = { provider, turbo }
    // 只在真的输了东西时才覆盖密钥 —— 否则"打开设置点保存"会把已存的密钥抹掉
    if (token.trim()) patch.token = token.trim()
    if (base.trim()) patch.base = base.trim().replace(/_turbo$/, '')
    if (dsBase.trim()) patch.dsBase = dsBase.trim()
    if (model.trim()) patch.model = model.trim()
    const r = await ocrSaveConfig(patch)
    if (!r || !r.ok) {
      flash((r && r.error) || '保存失败', 'err')
      return
    }
    setStatus(r)
    setToken('')
    onSaved?.(r)
    flash('存好了')
  }, [token, provider, turbo, base, dsBase, model, flash, onSaved])

  const doTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    const r = await ocrTest()
    setTesting(false)
    setTestResult(r)
  }, [])

  const info = (status && status.providers && status.providers[provider]) || {}

  return (
    <div className="wp-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wp wp-settings" role="dialog" aria-label="手写识别设置">
        <div className="wp-head">
          <b>手写识别设置</b>
          <span className="dim small">密钥只存在你自己电脑上</span>
          <button className="wp-x" onClick={onClose} title="关掉">×</button>
        </div>

        <div className="wp-body">
          <div className="wp-field">
            <label>用哪家识别</label>
            <div className="wp-providers">
              {Object.entries((status && status.providers) || {}).map(([key, p]) => (
                <label key={key} className={'wp-prov' + (provider === key ? ' on' : '')}>
                  <input type="radio" name="ocr-provider" checked={provider === key} onChange={() => setProvider(key)} />
                  <span>
                    <b>{key === 'deepseek' ? 'DeepSeek' : 'SimpleTex'}</b>
                    <span className="dim small"> {p.label ? p.label.replace(/^[^（]*/, '') : ''}</span>
                  </span>
                </label>
              ))}
            </div>
            {info.note ? <div className="dim small">{info.note}</div> : null}
          </div>

          <div className="wp-field">
            <label>密钥{info.needs ? `（${info.needs}）` : ''}</label>
            <input
              className="wp-edit"
              value={token}
              spellCheck={false}
              autoComplete="off"
              placeholder={status && status.configured ? `已经填过了（${status.tokenTail}）—— 想换就贴新的` : '把密钥粘进来'}
              onChange={(e) => setToken(e.target.value)}
            />
            <div className="dim small">
              {provider === 'deepseek'
                ? '就是 DeepSeek 那个 sk- 开头的 API Key，用你平时那个账号的就行。'
                : '识别服务给你的那一整串（UAT / APP），**原样**贴进来，我们不替你加前缀。'}
            </div>
          </div>

          {provider === 'simpletex' && (
            <div className="wp-field">
              <label className="wp-check">
                <input type="checkbox" checked={turbo} onChange={(e) => setTurbo(e.target.checked)} />
                用轻量模型（快，免费额度更多）
              </label>
              <div className="dim small">不勾就用标准模型：慢一点、准一点。两个模型的免费额度分开算。</div>
            </div>
          )}

          <button className="link" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? '收起高级' : '高级（换接口地址 / 改模型名）'}
          </button>
          {advanced && provider === 'deepseek' && (
            <>
              <div className="wp-field">
                <label>模型名</label>
                <input className="wp-edit" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
                <div className="dim small">
                  官方把模型名改过（旧的 <code>deepseek-v4-flash-vision-exp</code> 已下线）。
                  名字变了在这儿改，不用等改代码。
                </div>
              </div>
              <div className="wp-field">
                <label>接口地址</label>
                <input className="wp-edit" value={dsBase} spellCheck={false} onChange={(e) => setDsBase(e.target.value)} />
              </div>
            </>
          )}
          {advanced && provider === 'simpletex' && (
            <div className="wp-field">
              <label>接口地址</label>
              <input className="wp-edit" value={base} spellCheck={false} onChange={(e) => setBase(e.target.value)} />
              <div className="dim small">勾了轻量模型会在后面加 <code>_turbo</code>。</div>
            </div>
          )}

          <div className="wp-acts">
            <button className="mini" onClick={doTest} disabled={testing || !(status && status.configured)}>
              {testing ? '测试中…' : '测试一下'}
            </button>
            <span className="dim small">
              {(status && status.configured ? '已配置' : '还没配置') +
                (status && status.endpoint ? ` · 会打到 ${status.endpoint}` : '')}
            </span>
            <button className="btn primary" onClick={save}>保存</button>
          </div>

          {testResult && (
            <div className={'wp-err kind-' + (testResult.kind || 'ok') + (testResult.ok ? ' good' : '')}>
              {testResult.ok ? <b>通了</b> : <b>没通</b>}
              <div>{testResult.ok ? testResult.note : testResult.error}</div>
            </div>
          )}

          <div className="dim small">
            配置文件在 <code>{status && status.configHint}</code>，已经在 .gitignore 里 —— 不会被备份到 GitHub。
            换电脑要重新填一次。
          </div>

          {/* 这句是给"没配密钥 → 自动摊开设置"那条路准备的：
              设置盖住了写字板，用户第一反应是"我刚写的没了"。
              点这个窗口外面（或右上角 ×）就能回到写字板，笔迹一直在内存里。 */}
          <div className="dim small">关掉这里就回到写字板 —— 写好的笔迹还在，不用重写。</div>
        </div>
      </div>
    </div>
  )
}
