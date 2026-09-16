import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CARD_FONTS, DEFAULT_CARD_FONT, fontCss } from '../lib/board.js'
import { cleanLatex, cleanText, describePayload, ocrStatus, recognizeHandwriting } from '../lib/ocr.js'
import { snippetFor, toTex } from '../lib/formula.js'
import { canRender, Tex } from './Tex.jsx'

/* 「从框选到卡片」：把你在白板上**圈住的那一块手写**认成东西，排成一张卡。
 *
 * 两种模式共用这一块界面（原来只认文字，2026-09-16 用户说"公式也该能框出来认"）：
 *   · mode='text'    → 认普通文字（照抄、保换行）→ 文字卡 + 挑字体  ← 浮层上叫「✨ 美化」
 *   · mode='formula' → 认公式（转成 LaTeX）      → 公式卡 + 可改的写法 ← 叫「∑ 公式」
 *
 * ── 和「✍ 手写公式」那块写字板是什么关系 ──
 * 写字板是"另开一张小板，先写再认"——认的是你**当场写的那一笔**。
 * 这里认的是**白板上已经写着的东西**：懒得重写一遍，或者那本来就是你的笔记/式子。
 * 两条路共用同一份识别设置和同一个本地代理；提示词与清洗规则各有一套（见 server-ocr.js）。
 *
 * ── 为什么可以就地取材 ──
 * 写字板那条路特意不圈白板上的字，理由是"白板上的字是你思考的痕迹"。
 * 这条路的诉求恰好相反：**已经写了一堆，想让它变整齐**。
 * 但底线一样：卡片落在你圈的那块笔迹正上方。
 * ★ 卡片**不去盖**那几笔手写（2026-09-16 用户定的：「不用盖住，
 *   就让框贴合公式和字就行」）：它只按认出来的内容定大小，所以你的手写会露在周围。
 *   不想要那几笔，就勾面板上那个"顺便把原来的手写擦掉"——
 *   而"随时能改回手写"这条没变：不勾擦除，笔迹一个字节都不会少。
 *
 * ── 会发什么出去，写在界面上 ──
 * "会发一张 320×180 的图"用的是描述函数（不是事后才知道）。
 * 发出去的是**这个框里的笔迹渲染成的图**，白板文件本身永远不上传。
 */
export default function InkToCard({ mode = 'text', strokes, onInsert, onClose, onOpenSettings, flash }) {
  const isFormula = mode === 'formula'
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [draft, setDraft] = useState('') // 文字模式 = 文字本身；公式模式 = 你随手写的那串（src）
  const [font, setFont] = useState(DEFAULT_CARD_FONT)
  const [erase, setErase] = useState(false)
  const [status, setStatus] = useState(null)

  const list = useMemo(() => (strokes || []).filter((s) => s && s.points && s.points.length >= 3), [strokes])
  const info = useMemo(() => (list.length ? describePayload(list) : null), [list])

  useEffect(() => {
    let alive = true
    ocrStatus().then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [])

  const doRecognize = useCallback(async () => {
    if (!list.length) {
      flash('框里没有笔迹', 'warn')
      return
    }
    setBusy(true)
    setResult(null)
    const r = await recognizeHandwriting(list, { mode: isFormula ? 'formula' : 'text' })
    setBusy(false)
    if (!r.ok) {
      setResult(r)
      return
    }
    if (isFormula) {
      const tex = cleanLatex(r.latex)
      if (!tex) {
        setResult({ ok: false, kind: 'empty', error: '没认出公式（写大一点、一次只写一个式子再试）' })
        return
      }
      setResult({ ...r, latex: tex })
      setDraft(tex)
    } else {
      const text = cleanText(r.text)
      if (!text) {
        setResult({ ok: false, kind: 'empty', error: '没认出内容（写大一点、笔画清楚一点再试）' })
        return
      }
      setResult({ ...r, text })
      setDraft(text)
    }
  }, [list, flash, isFormula])

  /* 打开就认一次。
     为什么值得自动跑：点「∑ 公式」/「✨ 美化」这个动作本身就是"我要认这一块"，
     再要求点一下「识别」是多余的一步。发出去的东西仍然只有这一个框里的笔迹，
     而且底部一直写着"会发多大的图"，不存在"偷偷发"。
     没配密钥时它当场回一句人话（而不是白等），下面那个「去设置」就在手边。 */
  useEffect(() => {
    doRecognize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const insert = useCallback(() => {
    const v = String(draft || '').trim()
    if (!v) {
      flash(isFormula ? '公式是空的' : '文字是空的', 'warn')
      return
    }
    if (isFormula) {
      if (!canRender(v)) {
        flash('这个写法渲染不出来，改两笔再放（上面红色那块就是它现在的样子）', 'warn')
        return
      }
      onInsert({ mode: 'formula', src: v, tex: toTex(v), erase })
    } else {
      onInsert({ mode: 'text', text: v, font, erase })
    }
  }, [draft, font, erase, onInsert, flash, isFormula])

  const simpletex = !!(status && status.provider === 'simpletex')
  /* ★ 防线：服务端报的"这家能干什么"里没有 `modes` = 5177 上跑的是**旧代码**
     （这个字段是这次改动才加的）。老服务端不认 mode、一律按公式认，
     于是「美化手写」会给你一串 LaTeX。与其让你拿到一堆反斜杠，不如现在就说清"重启一下"。
     （另一道防线在 lib/ocr.js 的 interpretOcrResponse：没有 mode:'text' 的回包一律不收。） */
  const staleServer = !!(status && (!status.providers || !status.providers[status.provider] || !status.providers[status.provider].modes))
  const errTitle = (k) =>
    k === 'no-key' ? '还没配密钥'
      : k === 'key' ? '密钥不对'
        : k === 'quota' ? '额度用完或被限流'
          : k === 'network' ? '连不上识别服务'
            : k === 'provider' ? '这家服务干不了这个'
              : k === 'stale' ? '本地服务是旧版'
                : k === 'empty' ? '没认出内容' : '识别失败'

  const renderable = isFormula ? canRender(draft.trim()) : true

  return (
    <div className="wp-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wp bp" role="dialog" aria-label={isFormula ? '识别公式' : '美化手写'}>
        <div className="wp-head">
          <b>{isFormula ? '识别这一块公式' : '美化手写'}</b>
          <span className="dim small">
            {isFormula ? '把圈住的笔迹认成一个式子，排成公式卡' : '认成文字，再用好看的字体排一张卡'}
          </span>
          <button className="wp-x" onClick={onClose} title="关掉">×</button>
        </div>

        {status && !status.configured && (
          <div className="wp-warn">
            还没配手写识别的密钥 → <button className="link" onClick={onOpenSettings}>去设置</button>
            （和「✍ 手写公式」用的是同一份设置）
          </div>
        )}
        {staleServer && (
          <div className="wp-warn">
            本地服务还是**旧版**（它没有"认普通文字"这条路，会按公式认）：
            先把 studyhelper 关掉再打开一次，然后重新点识别。
            <div className="dim small">
              只改了代码是不会生效的 —— 5177 上跑的是"启动那一刻加载的模块"。
              前端重新构建 + 刷新页面只换掉了页面那一半。
            </div>
          </div>
        )}
        {simpletex && !isFormula && (
          <div className="wp-warn">
            现在配的是 SimpleTex —— 它只认公式，认不了普通文字。
            <button className="link" onClick={onOpenSettings}>去设置</button> 换成 DeepSeek，或者改用「∑ 公式」。
          </div>
        )}

        <div className="bp-body">
          <div className="bp-src">
            <span className="dim small">圈住的这一块：</span>
            <b>{list.length} 笔</b>
            <span className="dim small">{info ? `会发一张 ${info.w}×${info.h} 的图` : '（没有笔迹）'}</span>
            {isFormula ? <span className="dim small">· 一次认一个式子</span> : null}
          </div>

          {busy && <div className="bp-busy">正在认…（写得多的时候要几秒）</div>}

          {result && !result.ok && (
            <div className={'wp-err kind-' + (result.kind || 'bad')}>
              <b>{errTitle(result.kind)}</b>
              <div>{result.error}</div>
              {result.kind === 'no-key' || result.kind === 'key' || result.kind === 'provider' ? (
                <button className="mini primary" onClick={onOpenSettings}>打开设置</button>
              ) : null}
              <div className="bp-acts">
                <button className="mini" onClick={doRecognize}>再认一次</button>
              </div>
            </div>
          )}

          {result && result.ok && (
            <div className="wp-res">
              <div className="wp-res-head">
                <b>认出来了</b>
                <span className="dim small">
                  {isFormula ? '不对就在下面改（这就是卡片里的写法）' : '不对就在下面改，改完再放上去'}
                </span>
              </div>

              {isFormula ? (
                <>
                  <div className="wp-preview">
                    {renderable ? <Tex tex={toTex(draft)} block /> : <span className="bd-tex-bad">{draft}</span>}
                  </div>
                  <input
                    className="wp-edit"
                    value={draft}
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') insert()
                    }}
                    title="识别的写法。改坏了上面会变红，红了就暂时放不上去"
                  />
                  <div className="bd-snips">
                    {SNIP_KEYS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => setDraft((cur) => cur + snippetFor(k, ''))}
                      >
                        {SNIP_LABEL[k]}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <textarea
                    className="wp-edit bp-text"
                    value={draft}
                    rows={4}
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    title="识别结果。可以随便改 —— 它就是要写进卡片里的文字"
                  />
                  <div className="bp-fonts">
                    <span className="dim small">用哪个字体</span>
                    {CARD_FONTS.map((f) => (
                      <button
                        key={f.id}
                        className={'bp-font' + (font === f.id ? ' on' : '')}
                        style={{ fontFamily: f.css }}
                        onClick={() => setFont(f.id)}
                        title={f.note}
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                  <div className="bp-preview" style={{ fontFamily: fontCss(font) }}>
                    {draft.trim() || '（认出来的字会以这个字体出现）'}
                  </div>
                </>
              )}

              <label className="bp-check">
                <input type="checkbox" checked={erase} onChange={(e) => setErase(e.target.checked)} />
                顺便把原来的手写擦掉（卡片只贴着认出来的字，不会盖住那几笔；Ctrl+Z 能撤销）
              </label>
              <div className="wp-res-acts">
                <span className="dim small">放上去之后还能双击进卡片继续改</span>
                <button className="btn primary" onClick={insert} disabled={!draft.trim() || !renderable}>
                  放到白板上
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="wp-foot dim small">
          识别要联网（**这个框里的笔迹**会发到识别服务）。白板文件本身不上传。
        </div>
      </div>
    </div>
  )
}

/* 公式这一排"随手写的符号"（和卡片编辑态里那排同一套写法：
   插进去的是能手打的 `mu0` / `sqrt(...)`，不是 LaTeX —— 面板和手写是同一套语法）。 */
const SNIP_KEYS = ['frac', 'sqrt', 'sup', 'sub', 'mu0', 'pi', 'cdot', 'int', 'sum', 'vec']
const SNIP_LABEL = { frac: 'a/b', sqrt: '√', sup: 'xⁿ', sub: 'xₙ', mu0: 'μ₀', pi: 'π', cdot: '·', int: '∫', sum: 'Σ', vec: '向量' }
