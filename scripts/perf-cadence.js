/* 探针 v4：**按真实节奏**派滚轮 —— 每帧一次，而不是"同一帧里派 40 次"。
 *
 * 为什么要重写一版（2026-09-21，用户报"越修越卡"）：
 *   v1/v2/v3 都是 `for (i<40) el.dispatchEvent(wheel)` —— 40 次派发发生在**同一个任务**里，
 *   于是 React 只提交一次、`gesting` 只进出一次。它量的是"卡片层藏起来之后有多快"，
 *   却完全量不到"藏起来/放出来这个动作本身"要花多少。
 *   而真人的滚轮是**一帧一次**（60~120Hz），每一帧都是一次独立的 setView……
 *   于是"闸"的进出节奏和事件节奏绑在一起 —— **这件事根本没人量过**。
 *
 * 它同时采三样东西：
 *   · 帧间隔（p50/p90/max）：手感的直接读数
 *   · `.bd` 上 class 的变动次数 + 每次 gesting 停留了几帧：闸到底进出得多频繁
 *   · Layout / RecalcStyle / Script / Task 增量：钱花在哪
 *
 * 四组对照，一次跑完（同一张夹具板、同一个浏览器，尽量少变量）：
 *   [A] 现状           —— 闸开 + will-change
 *   [B] 闸摘掉         —— `.bd.gesting .bd-cardworld{display:block}`（= 修之前那版语义）
 *   [C] will-change 也摘掉
 *   [D] 卡片层永久藏   —— 标尺（layout 归零那一版）
 *
 * ⚠ 只**读**用户那张板来造夹具（board-zz-perfzoom.md），跑完 harness 自己删。
 * 用法：node scripts/perf-cadence.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'

const SRC = path.join(import.meta.dirname, '..', 'data', '信号与系统', 'board-傅里叶级数.md')

/* 一次"连滚"：n 帧，每帧派一次滚轮；前一半往里缩、后一半往回缩（视野别跑飞）。 */
const FLING = 60

const fails = await withBoard(
  { tag: 'perfzoom', port: 5240, cdpPort: 9280, make: () => fs.readFileSync(SRC, 'utf8'), settleMs: 6000 },
  async ({ s, ok, open }) => {
    await open()
    try { await s.send('Performance.enable') } catch {}

    ok('结构 ' + JSON.stringify(await s.eval(`(() => {
      const q = (x) => document.querySelectorAll(x).length
      const cw = document.querySelector('.bd-cardworld')
      return {
        cards: q('.bd-card'),
        cardworldNodes: cw ? cw.querySelectorAll('*').length : 0,
        bodyNodes: document.body.querySelectorAll('*').length,
      }
    })()`)))

    /* 帧记录 + class 变动记录 + 长任务，一次装好 */
    await s.eval(`(() => {
      window.__zzf = []
      window.__zzcls = []
      window.__zzlt = []
      window.__zzN = 0
      window.__zzDone = false
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__zzlt.push(Math.round(e.duration)) })
          .observe({ entryTypes: ['longtask'] })
      } catch (e) {}
      const bd = document.querySelector('.bd')
      new MutationObserver(() => {
        window.__zzcls.push(window.__zzf.length)
      }).observe(bd, { attributes: true, attributeFilter: ['class'] })
      return 1
    })()`)

    const perfOf = async () => {
      const m = await s.send('Performance.getMetrics')
      const map = {}
      for (const x of m.metrics) map[x.name] = x.value
      return map
    }
    const md = (a, b, k) => +((b[k] - a[k]) * 1000).toFixed(0)

    const injectCss = async (id, css) => {
      await s.eval(`(() => {
        let st = document.getElementById(${JSON.stringify(id)})
        if (!st) { st = document.createElement('style'); st.id = ${JSON.stringify(id)}; document.head.appendChild(st) }
        st.textContent = ${JSON.stringify(css)}
        return 1
      })()`)
    }
    const dropCss = async (id) => {
      await s.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (e) e.remove(); return 1 })()`)
    }

    /* ★ 每一帧派一次滚轮（真人节奏）。派发**同步**跑完 handler（dispatchEvent 是同步的），
       所以这一帧的开销全都记在它自己那一帧上。 */
    const fling = async (label) => {
      /* 先静置一会儿，让上一次的残留（闸的收尾、存盘防抖）落定 */
      await s.sleep(900)
      await s.eval(`(() => { window.__zzf = []; window.__zzcls = []; window.__zzlt = []; window.__zzDone = false; return 1 })()`)
      const m0 = await perfOf()
      await s.eval(`(() => {
        const el = document.querySelector('.bd-stagewrap')
        const N = ${FLING}
        let sent = 0
        let last = performance.now()
        const tick = (t) => {
          window.__zzf.push(+(t - last).toFixed(2)); last = t
          if (sent < N) {
            const d = sent < N / 2 ? -20 : 20
            sent++
            el.dispatchEvent(new WheelEvent('wheel', { deltaY: d, clientX: 700, clientY: 450, bubbles: true, cancelable: true }))
          }
          if (window.__zzf.length < N + 45) requestAnimationFrame(tick)
          else window.__zzDone = true
        }
        requestAnimationFrame(tick)
        return 1
      })()`)
      for (let i = 0; i < 120; i++) {
        if (await s.eval('window.__zzDone')) break
        await s.sleep(100)
      }
      const m1 = await perfOf()
      const r = await s.eval(`(() => {
        const f = window.__zzf || []
        const win = f.slice(1, ${FLING + 1}).sort((x, y) => x - y)
        const pick = (p) => (win.length ? +win[Math.floor(win.length * p)].toFixed(1) : -1)
        const cls = window.__zzcls || []
        /* 闸进出的次数：class 每变一次算一次；再用帧号算"每次停留多少帧" */
        const gaps = []
        for (let i = 1; i < cls.length; i++) gaps.push(cls[i] - cls[i - 1])
        const lt = window.__zzlt || []
        return {
          frames: f.length,
          p50: pick(0.5), p90: pick(0.9), max: win.length ? win[win.length - 1] : -1,
          over32: win.filter((x) => x > 32).length,
          clsChanges: cls.length,
          clsGapMedian: gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : -1,
          lt: lt.length, ltMax: lt.length ? Math.max.apply(null, lt) : 0,
        }
      })()`)
      console.log(
        '  ' + label.padEnd(26) +
        ' 帧p50 ' + String(r.p50).padStart(6) + '  p90 ' + String(r.p90).padStart(6) + '  max ' + String(r.max).padStart(7) +
        '  | >32ms ' + String(r.over32).padStart(3) +
        ' | class变 ' + String(r.clsChanges).padStart(3) + ' (间隔中位 ' + String(r.clsGapMedian).padStart(3) + ' 帧)' +
        ' | 长任务 ' + String(r.lt).padStart(2) + '(最长 ' + String(r.ltMax).padStart(4) + 'ms)' +
        ' | Layout ' + String(md(m0, m1, 'LayoutDuration')).padStart(5) + ' Recalc ' + String(md(m0, m1, 'RecalcStyleDuration')).padStart(5) +
        ' Script ' + String(md(m0, m1, 'ScriptDuration')).padStart(5)
      )
      return r
    }

    console.log('\n  ── 每帧一次滚轮（${FLING} 帧的连滚）──'.replace('${FLING}', String(FLING)))

    /* 空转基线：什么都不干时的帧间隔（headless 里这个数本身就可能不是 16.7） */
    await s.eval(`(() => { window.__zzf = []; window.__zzDone = false; let last = performance.now()
      const tick = (t) => { window.__zzf.push(+(t - last).toFixed(2)); last = t
        if (window.__zzf.length < 90) requestAnimationFrame(tick); else window.__zzDone = true }
      requestAnimationFrame(tick); return 1 })()`)
    for (let i = 0; i < 60; i++) { if (await s.eval('window.__zzDone')) break; await s.sleep(100) }
    console.log('  ' + '空转（无滚轮）'.padEnd(26) + ' ' + JSON.stringify(await s.eval(`(() => {
      const a = (window.__zzf || []).slice(3).sort((x, y) => x - y)
      return { p50: +a[Math.floor(a.length / 2)].toFixed(1), max: a[a.length - 1], n: a.length }
    })()`)))
    console.log('')

    await fling('[A] 现状（闸 + will-change）')
    await fling('[A] 现状（第二遍）')
    await injectCss('zz-off-gate', '.bd.gesting .bd-cardworld { display: block !important; }')
    await fling('[B] 闸摘掉（=修之前语义）')
    await fling('[B] 闸摘掉（第二遍）')
    await injectCss('zz-off-wc', '.bd-cardworld { will-change: auto !important; }')
    await fling('[C] 闸 + will-change 都摘')
    await dropCss('zz-off-gate')
    await dropCss('zz-off-wc')
    await injectCss('zz-hide', '.bd-cardworld { display: none !important; }')
    await fling('[D] 卡片层永久藏（标尺）')
    await dropCss('zz-hide')
    await fling('[A] 恢复现状（可逆？）')

    /* 闸进出到底有多频繁 —— 单独数一次，别和帧混在一起看 */
    await s.eval(`(() => { window.__zzcls = []; return 1 })()`)
    await s.eval(`(() => {
      const el = document.querySelector('.bd-stagewrap')
      let n = 0
      const tick = () => {
        if (n < 40) { n++; el.dispatchEvent(new WheelEvent('wheel', { deltaY: n < 20 ? -20 : 20, clientX: 700, clientY: 450, bubbles: true, cancelable: true })) }
        if (n < 41) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick); return 1
    })()`)
    await s.sleep(1500)
    const cls = await s.eval(`(() => {
      const c = window.__zzcls || []
      const gaps = []
      for (let i = 1; i < c.length; i++) gaps.push(c[i] - c[i - 1])
      return { changes: c.length, gaps: gaps.slice(0, 20) }
    })()`)
    ok('40 帧连滚期间 .bd 的 class 变了 ' + cls.changes + ' 次；间隔（帧）' + JSON.stringify(cls.gaps))
    ok('量完了')
  }
)
console.log('\nfails =', fails)
