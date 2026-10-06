/* 「实验图」那个窗口：34 张图一次管完，最后一页打印出来剪了贴。
 *
 * ── 它为什么是这个形状（2026-10-05 问出来的）───────────────────────
 * 用户的实验报告**手写在报告纸上**，图打印出来剪下去贴。他现在是一张一张让 AI 画，
 * 三十四张就是三十四次对话、三十四次下载，而且每张大小还不一样。
 * 所以这里要的从来不是"把一条曲线画好看"，是三件事：
 *   ① **一次管 34 张**（左边那一列就是干这个的）；
 *   ② **每张格式一样**（同一套几何、同一套刻度、同一个尺寸 —— 见 chart-print.js）；
 *   ③ **一键出一页纸**（底下那颗「打印」）。
 *
 * ── 三条老规矩 ──────────────────────────────────────────────────────
 * ① **不出网**：数据是你的、算术是本机的。为一个最小二乘去问模型，
 *    既没道理又要花钱，而且它算错了我们更难发现。
 * ② **不猜数据**：粘贴进来的东西解析不出就**明说是第几行**，绝不跳过继续画
 *    （少一个点的图看着完全正常 —— 那才是最坏的一种错）。
 * ③ **预览 = 打印**：预览那段 SVG 就是打印页里那一段（同一个 `chartSvg`），
 *    所以"屏幕上调好的"和"打出来的"是一个东西。
 *
 * ⚠ 它**不碰板**：和 HomeworkBox / AskBox 同一族（拿不到 board）。
 *   图集是自己的文件（`data/.图表/<名字>.json`），不是板的一部分 ——
 *   一次实验报告的图和一节课的笔记，本来就不是一回事。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseTable, chartGeomAll, chartSeries, markFor, MARKS } from '../lib/chart.js'
import { chartSvg, chartPrintHtml, chartCaption } from '../lib/chart-print.js'

/* ★ 三种画法，**每张图自己选**（这条是他 2026-10-05 点出来的）：
   "直线要不要拟合，得看是哪一个实验" —— 有的实验要看曲线的形状（I−V、P−V 这类
   特性曲线，连起来就够了），有的实验是要从这条线上读出一个数（求电阻、求 g，
   那就得拟合，并且要那个不确定度）。**没有哪一种该被定成默认**：
   · 新建一张图时，沿用**这一份里上一张**的画法（一次实验通常是一种）；
   · 每张都能单独改 —— 前两张连线、第三张拟合也完全可以；
   · 左列会标出每张用的是哪种，几十张里也能一眼看出哪几张是拟合。 */
const MODES = [
  { v: 'line', t: '连线', hint: '实测点之间按顺序连起来（看曲线形状：特性曲线、冷却曲线、光谱）' },
  { v: 'fit', t: '拟合', hint: '点 + 一条最贴合的直线，给你斜率和不确定度（要"一个数"的实验：测电阻、测 g）' },
  { v: 'dots', t: '点', hint: '只画实测点，不连线也不拟合' },
]
const MODE_LABEL = { line: '连线', fit: '拟合', dots: '点' }

/* 三种标记在界面上的写法（形状和图上那一套一一对应，见 chart.js 的 `MARKS`）。 */
const MARK_GLYPH = { circle: '○', square: '□', triangle: '△' }
const MARK_TITLE = {
  circle: '空心圆（第一条曲线默认用它）',
  square: '空心方',
  triangle: '空心三角',
}

/**
 * ★ 一张空图的样子。
 *
 * ⚠⚠ `extra` 是**第 2 条及以后**的曲线；第一条永远是图自己的 `rows`/`mode`/`text`。
 *   这样已存的那 34 份图一个字节都不用改就能打开，只有一条的老用法也一点没变
 *   （详见 `chart.js` 的 `chartSeries`）。`s0name`/`s0mark` 只在有第二条时才用得上。
 */
function newChart(i) {
  return {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: '图 ' + (i + 1),
    xLabel: '',
    xUnit: '',
    yLabel: '',
    yUnit: '',
    mode: 'line',
    rows: [],
    text: '', // 数据框里的原文（`rows` 是从它解析出来的，不另立真相）
    s0name: '', // 第一条曲线的名字（两条以上时图例才用）
    extra: [], // 第 2 条起：{ id, name, mode, mark, text, rows }
  }
}

/** 第 n 条附加曲线（第 1 条传 1）。 */
function newExtra(n, mode) {
  return {
    id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: '',
    mode: mode || 'line',
    mark: markFor(n),
    text: '',
    rows: [],
  }
}

export default function ChartBox({ onClose, flash }) {
  const [name, setName] = useState('实验图')
  const [charts, setCharts] = useState(() => [newChart(0)])
  const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [savedAt, setSavedAt] = useState('')
  const [names, setNames] = useState([])

  const cur = charts[sel] || charts[0] || null
  const parsed = useMemo(() => (cur ? parseTable(cur.text) : { ok: false, why: '' }), [cur && cur.text])
  /* 第 2 条起每条的解析结果。⚠ 依赖用 `map` 出来的长度 + 各自 text ——
     直接把数组放依赖里每次渲染都是新引用，会让这个 effect 永远重跑。 */
  const extraText = cur && cur.extra ? cur.extra.map((e) => e.text).join(String.fromCharCode(10)) : ''
  const parsedExtra = useMemo(
    () => (cur && cur.extra ? cur.extra.map((e) => parseTable(e.text)) : []),
    [extraText]
  )

  /* 解析出来就写回 `rows`：图永远画"读得懂的那份"，读不懂就报出来、不画。 */
  useEffect(() => {
    if (!cur) return
    const rows = parsed.ok ? parsed.rows : []
    const ex = (cur.extra || []).map((e, i) => {
      const p = parsedExtra[i]
      const r = p && p.ok ? p.rows : []
      return { ...e, rows: r }
    })
    const sameMain = rows.length === cur.rows.length && rows.every((r, i) => cur.rows[i] && r[0] === cur.rows[i][0] && r[1] === cur.rows[i][1])
    const sameEx =
      ex.length === (cur.extra || []).length &&
      ex.every((e, i) => {
        const o = cur.extra[i]
        return e.rows.length === (o.rows || []).length && e.rows.every((r, k) => o.rows[k] && r[0] === o.rows[k][0] && r[1] === o.rows[k][1])
      })
    if (sameMain && sameEx) return
    setCharts((cs) => cs.map((c, i) => (i === sel ? { ...c, rows, extra: ex } : c)))
  }, [parsed, parsedExtra, sel])

  const set = useCallback((patch) => {
    setCharts((cs) => cs.map((c, i) => (i === sel ? { ...c, ...patch } : c)))
  }, [sel])

  /** 改第 2 条（或更后一条）曲线上的一个字段。`k` 是它在 `extra` 里的下标。 */
  const setExtra = useCallback(
    (k, patch) => {
      setCharts((cs) =>
        cs.map((c, i) => (i === sel ? { ...c, extra: (c.extra || []).map((e, j) => (j === k ? { ...e, ...patch } : e)) } : c))
      )
    },
    [sel]
  )

  const addExtra = useCallback(() => {
    setCharts((cs) =>
      cs.map((c, i) => {
        if (i !== sel) return c
        const ex = c.extra || []
        /* 沿用第一条的画法（一次实验通常是一种），标记按条数自动往后排。 */
        return { ...c, extra: [...ex, newExtra(ex.length + 1, c.mode)] }
      })
    )
  }, [sel])

  const delExtra = useCallback(
    (k) => {
      setCharts((cs) => cs.map((c, i) => (i === sel ? { ...c, extra: (c.extra || []).filter((_, j) => j !== k) } : c)))
    },
    [sel]
  )

  const geom = useMemo(() => {
    const ss = chartSeries(cur)
    return ss.length ? chartGeomAll(ss) : null
  }, [cur])

  /* ── 存盘：图集是自己的文件 ── */
  const api = async (url, init) => {
    const r = await fetch(url, init)
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.ok === false) throw new Error(j.error || '请求没成（' + r.status + '）')
    return j
  }
  /**
   * ★ 存/发之前把一份图整成"该有的样子"。
   *
   * 丢掉 `rows`（它是从 `text` 解析出来的，存两份就会漂 —— 改了原文、rows 还是旧的，
   * 打开时 effect 又按新原文重算，两边对不上）。`extra` 里每条同样只留 `text`。
   * 顺带补上老文件缺的 `extra: []`，免得渲染时到处判空。
   */
  const forWire = useCallback(
    (list) =>
      list.map((c) => {
        const o = { ...c, rows: undefined, extra: (c.extra || []).map((e) => ({ ...e, rows: undefined })) }
        if (!o.extra.length) o.extra = undefined
        return o
      }),
    []
  )
  const loadNames = useCallback(async () => {
    try {
      const j = await api('/api/charts')
      setNames(j.names || [])
      return j.last || ''
    } catch {
      return ''
    }
  }, [])
  useEffect(() => {
    loadNames().then((last) => {
      if (!last) return
      setName(last)
      api('/api/charts?name=' + encodeURIComponent(last))
        .then((j) => {
          if (j.data && Array.isArray(j.data.charts) && j.data.charts.length) {
            setCharts(j.data.charts.map((c, i) => ({ ...newChart(i), ...c })))
            setSel(0)
            setSavedAt('已载入')
          }
        })
        .catch(() => {})
    })
  }, [loadNames])

  const save = async () => {
    setErr('')
    setBusy('save')
    try {
      await api('/api/charts?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* ★ 存**原文**（`text`），`rows` 不存 —— 它是从原文解析出来的，
           存两份就会漂（改了原文、rows 还是旧的）。打开时由 effect 重新解析。 */
        body: JSON.stringify({ charts: forWire(charts) }),
      })
      setSavedAt('已存')
      setNames((ns) => (ns.includes(name) ? ns : [...ns, name]))
      flash?.('存好了', 'ok')
    } catch (e) {
      setErr(String(e.message || e))
    } finally {
      setBusy('')
    }
  }

  /* ── 拍照 / 选图 → 把它读成数据 ──────────────────────────────────
   * ★ 它只是**帮你把数据打进来**，不是替你决定数据：读出来就填进那个框，
   *   你核一遍再画图。认不清的地方模型写 `?`，`parseTable` 会指名道姓报第几行 ——
   *   那条报错比一个错数字便宜得多（画错的图看着完全正常，贴上去才发现）。 */
  const fileRef = useRef(null)
  const [shotBusy, setShotBusy] = useState('')
  const readShot = async (f) => {
    setErr('')
    setShotBusy('在读这张照片…')
    try {
      const fd = new FormData()
      fd.append('file', f, 'table.jpg')
      fd.append('mode', 'datatable')
      const r = await fetch('/api/ocr', { method: 'POST', body: fd })
      const b = await r.json().catch(() => null)
      if (!b) throw new Error(`本地服务回了个看不懂的东西（HTTP ${r.status}）`)
      if (!b.ok) throw new Error(b.error || '没读出来')
      /* ★ 回声校验（和 AskBox 那条同一条防线）：服务端还是旧的那份时它不认这个 mode，
         会**按公式认**并把结果塞在 latex 里回来 —— 不查这一条，就会把一句别的
         东西当成数据填进去，而且一声不响（2026-09-16 那个 bug 的形状）。 */
      if (b.mode !== 'datatable') throw new Error('服务端还是旧的那份（重启一下再试）')
      const t = String(b.text || '').trim()
      if (!t || t === 'EMPTY') throw new Error('这张照片里没看出有表格')
      set({ text: t })
      flash?.('读出来了 —— 核对一下再画图', 'ok')
    } catch (e) {
      setErr(String(e.message || e))
    } finally {
      setShotBusy('')
    }
  }

  /* ── 下载 PDF：一次实验那几张图 → 一页 A4（上下排）───────────────── */
  /** 有数据的图（★ 判据走 `chartSeries`：只有第二条有数据也算，不能漏掉）。 */
  const withData = useCallback((list) => list.filter((c) => chartSeries(c).length > 0), [])
  const dl = async () => {
    setErr('')
    setBusy('pdf')
    try {
      const r = await fetch('/api/charts?as=pdf&name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* ⚠ 发**带 rows 的**那份（服务端要直接画，不重新解析）——
           和存盘那份（只留 text）不是同一份，别搞混。 */
        body: JSON.stringify({ charts: withData(charts) }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `出 PDF 失败（HTTP ${r.status}）`)
      }
      const blob = await r.blob()
      const u = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = u
      a.download = (name || '实验图') + '.pdf'
      a.click()
      setTimeout(() => URL.revokeObjectURL(u), 5000)
      flash?.('PDF 出来了，去打印', 'ok')
    } catch (e) {
      setErr(String(e.message || e))
    } finally {
      setBusy('')
    }
  }

  /* ── 打印：把整个图集生成一页纸，交给浏览器的打印框 ── */
  const print = () => {
    const list = withData(charts)
    if (!list.length) {
      setErr('还没有一张图有数据')
      return
    }
    setErr('')
    const html = chartPrintHtml(list, { title: name, cols: 3, rows: 5 })
    const w = window.open('', '_blank')
    if (!w) {
      setErr('浏览器把新窗口拦了 —— 允许弹出窗口再来一次')
      return
    }
    w.document.write(html)
    w.document.close()
  }

  return (
    <div className="chbox" data-chartbox="1">
      <div className="ch-panel">
        <div className="ch-head">
          <span className="ch-title">实验图</span>
          <input
            className="ch-name"
            value={name}
            data-chart-set="1"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            title="这一份图集叫什么（存成 data/.图表/<这个名字>.json）"
          />
          {names.length > 0 && (
            <select
              className="ch-names"
              value=""
              onChange={(e) => {
                const n = e.target.value
                if (!n) return
                setName(n)
                api('/api/charts?name=' + encodeURIComponent(n))
                  .then((j) => {
                    if (j.data && Array.isArray(j.data.charts)) {
                      setCharts(j.data.charts.map((c, i) => ({ ...newChart(i), ...c })))
                      setSel(0)
                    }
                  })
                  .catch((e) => setErr(String(e.message || e)))
              }}
              title="换一份已经存过的"
            >
              <option value="">换一份…</option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
          <span className="ch-saved" data-chart-saved="1">
            {savedAt}
          </span>
          <button className="ch-x" data-chart-close="1" onClick={onClose} title="关掉">
            ×
          </button>
        </div>

        <div className="ch-body">
          {/* 左边：这一份里所有的图。34 张全在这儿，一次看得到。 */}
          <div className="ch-list" data-chart-list="1">
            {charts.map((c, i) => (
              <div
                key={c.id}
                className={'ch-item' + (i === sel ? ' on' : '')}
                data-chart-item={i}
                onClick={() => setSel(i)}
                title={c.name}
              >
                <span className="ch-item-n">{c.name || '未命名'}</span>
                <span className="ch-item-r">
                  <span className="ch-item-m" data-chart-item-mode={c.mode}>
                    {MODE_LABEL[c.mode] || c.mode}
                  </span>
                  {/* ★ 两条以上时标出「几条」—— 几十张里一眼看出哪张是对比图。 */}
                  {chartSeries(c).length > 1 ? (
                    <span className="ch-item-s" data-chart-item-ns={chartSeries(c).length} title="这张图里有几条曲线">
                      {chartSeries(c).length} 条
                    </span>
                  ) : null}
                  <span className="ch-item-p">{chartSeries(c).length ? c.rows.length + ' 点' : '空'}</span>
                </span>
              </div>
            ))}
            <button
              className="ch-add"
              data-chart-add="1"
              onClick={() => {
                setCharts((cs) => {
                  const c = newChart(cs.length)
                  const prev = cs[cs.length - 1]
                  if (prev && prev.mode) c.mode = prev.mode // ★ 沿用上一张的画法（一次实验通常是一种）
                  return [...cs, c]
                })
                setSel(charts.length)
              }}
            >
              + 加一张
            </button>
          </div>

          {/* 右边：当前这张 */}
          {cur && (
            <div className="ch-main">
              <div className="ch-row">
                <input
                  className="ch-fn"
                  value={cur.name}
                  data-chart-name="1"
                  spellCheck={false}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="图名"
                />
                <span className="ch-lab">横轴</span>
                <input className="ch-ax" value={cur.xLabel} onChange={(e) => set({ xLabel: e.target.value })} placeholder="U" />
                <input className="ch-un" value={cur.xUnit} onChange={(e) => set({ xUnit: e.target.value })} placeholder="V" />
                <span className="ch-lab">纵轴</span>
                <input className="ch-ax" value={cur.yLabel} onChange={(e) => set({ yLabel: e.target.value })} placeholder="I" />
                <input className="ch-un" value={cur.yUnit} onChange={(e) => set({ yUnit: e.target.value })} placeholder="mA" />
                <div className="ch-modes">
                  {MODES.map((m) => (
                    <button
                      key={m.v}
                      className={'ch-mode' + (cur.mode === m.v ? ' on' : '')}
                      data-chart-mode={m.v}
                      title={m.hint}
                      onClick={() => set({ mode: m.v })}
                    >
                      {m.t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ch-edit">
                <div className="ch-data">
                  {/* 拍照/选图：实验记录本拍下来直接读成数据（识别只帮录入，不替你定）。 */}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files && e.target.files[0]
                      e.target.value = '' // 清空：不然选同一张第二次不触发
                      if (f) readShot(f)
                    }}
                  />
                  <button
                    className="ch-shot"
                    data-chart-shot="1"
                    disabled={!!shotBusy}
                    onClick={() => fileRef.current && fileRef.current.click()}
                    title="把实验记录本上那张表拍下来（或选一张照片）→ 读出数据、填进下面这个框，核对一下就行"
                  >
                    {shotBusy || '📷 拍照 / 选图 → 读出数据'}
                  </button>

                  {/* ★ 只有一条时这个「曲线名」行是空的；一旦加了第二条，它就变成
                      图例上写的那两个字。**不提前要求你起名** —— 一个人做实验的图
                      根本不需要名字，多一个必填框就多一步烦心事。 */}
                  <div className="ch-srow">
                    <span className="ch-smark" title={MARK_TITLE[MARKS[0]]}>
                      {MARK_GLYPH[MARKS[0]]}
                    </span>
                    <input
                      className="ch-sname"
                      data-chart-s0name="1"
                      value={cur.s0name || ''}
                      spellCheck={false}
                      placeholder="这条曲线叫什么（两条以上才用得上，比如「直接充电」）"
                      onChange={(e) => set({ s0name: e.target.value })}
                    />
                  </div>

                  <textarea
                    className="ch-ta"
                    data-chart-data="1"
                    value={cur.text}
                    spellCheck={false}
                    placeholder={'一行一组，两个数用空格或逗号隔开\n（从 Excel 直接复制过来也行）\n\n1.0  2.1\n2.0  4.0\n3.0  5.9'}
                    onChange={(e) => set({ text: e.target.value })}
                  />
                  <div className="ch-hint">
                    {parsed.ok ? (
                      <>
                        读到 <b>{parsed.rows.length}</b> 组
                        {parsed.note ? <span className="ch-note">{parsed.note}</span> : null}
                      </>
                    ) : (
                      <span className="ch-bad" data-chart-err="1">
                        {parsed.why}
                      </span>
                    )}
                  </div>

                  {/* ── 第 2 条及以后的曲线 ──
                      2026-10-05 他指出有一张 `两种充电情况下的 P − t 曲线` 上有两条，
                      之前一张图只能画一条，那种对比图根本画不出来。 */}
                  {(cur.extra || []).map((e, k) => {
                    const p = parsedExtra[k]
                    return (
                      <div className="ch-extra" key={e.id} data-chart-extra={k}>
                        <div className="ch-srow">
                          <button
                            className="ch-smark btn"
                            data-chart-mark={e.mark}
                            title={'标记形状：' + MARK_TITLE[e.mark] + '（黑白打印靠它区分曲线）'}
                            onClick={() => {
                              /* 点一下换下一种 —— 顺序就是 `MARKS` 那个圈，
                                 免得为区分曲线去找一个小菜单。 */
                              const i = MARKS.indexOf(e.mark)
                              setExtra(k, { mark: MARKS[(i + 1) % MARKS.length] })
                            }}
                          >
                            {MARK_GLYPH[e.mark] || MARK_GLYPH.circle}
                          </button>
                          <input
                            className="ch-sname"
                            data-chart-ename={k}
                            value={e.name || ''}
                            spellCheck={false}
                            placeholder={'第 ' + (k + 2) + ' 条曲线的名字（图例上写它）'}
                            onChange={(ev) => setExtra(k, { name: ev.target.value })}
                          />
                          <div className="ch-modes sm">
                            {MODES.map((m) => (
                              <button
                                key={m.v}
                                className={'ch-mode' + (e.mode === m.v ? ' on' : '')}
                                data-chart-emode={k + '-' + m.v}
                                title={m.hint}
                                onClick={() => setExtra(k, { mode: m.v })}
                              >
                                {m.t}
                              </button>
                            ))}
                          </div>
                          <button
                            className="ch-sdel"
                            data-chart-edel={k}
                            title="删掉这一条"
                            onClick={() => delExtra(k)}
                          >
                            ×
                          </button>
                        </div>
                        <textarea
                          className="ch-ta sm"
                          data-chart-edata={k}
                          value={e.text || ''}
                          spellCheck={false}
                          placeholder={'第 ' + (k + 2) + ' 条的数据（同样一行一组两个数）'}
                          onChange={(ev) => setExtra(k, { text: ev.target.value })}
                        />
                        <div className="ch-hint">
                          {p && p.ok ? (
                            <>
                              读到 <b>{p.rows.length}</b> 组
                              {p.note ? <span className="ch-note">{p.note}</span> : null}
                            </>
                          ) : (
                            <span className="ch-bad" data-chart-eerr={k}>
                              {p ? p.why : '还没填数据'}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  <button className="ch-addextra" data-chart-addextra="1" onClick={addExtra} title="在同一张图上再画一条（比如把「直接充电」和「加 DC-DC」放一起比）">
                    + 在这张图上再画一条
                  </button>
                </div>
                <div className="ch-view">
                  {/* ★ 预览就是打印页里那一张 —— 同一个 `chartSvg`、同一套几何、
                      同一个画法，只是屏幕上放大一倍（116mm : 58mm）方便看。
                      所以"你在这儿调好的"和"打出来的"必然是同一个东西。 */}
                  <div
                    className="ch-pic"
                    data-chart-pic="1"
                    dangerouslySetInnerHTML={{ __html: chartSvg(cur, { mm: 116 }) }}
                  />
                  <div className="ch-num" data-chart-num="1">
                    {chartCaption(cur) ||
                      /* 没算出数的时候说清楚为什么。⚠ 多条时得**逐条**看 ——
                         第一条拟合失败不代表第二条也失败，只报一条会误导。 */
                      (geom && geom.series.some((s) => s.mode === 'fit' && !s.fit)
                        ? geom.series
                            .filter((s) => s.mode === 'fit' && s.fitWhy)
                            .map((s) => (s.name ? s.name + '：' : '') + s.fitWhy)
                            .join('；')
                        : geom && geom.series.some((s) => s.mode === 'fit')
                          ? '填上数据就出斜率和不确定度'
                          : '')}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="ch-foot">
          {err && <span className="ch-err">{err}</span>}
          <span className="ch-tip">一次实验这几张 → 一页 A4，上下排</span>
          <button className="ch-btn" data-chart-save="1" onClick={save} disabled={busy === 'save'}>
            {busy === 'save' ? '存着…' : '存盘'}
          </button>
          <button className="ch-btn" data-chart-download="1" onClick={dl} disabled={busy === 'pdf'}>
            {busy === 'pdf' ? '出着…' : '下载 PDF'}
          </button>
          <button className="ch-btn main" data-chart-print="1" onClick={print}>
            直接打印
          </button>
        </div>
      </div>
    </div>
  )
}
