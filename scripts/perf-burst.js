/* 探针 v5：**真人的滚轮节奏是"一阵一阵"的**，不是每帧一次。
 *
 * 为什么必须量这一条（2026-09-21 用户："越修越卡"）：
 *   第十刀那个闸（`.bd.gesting .bd-cardworld{display:none}`）的收尾是
 *   **最后一个事件之后一帧**就把卡片放回来。而 v4 探针是"每帧都派一次"，
 *   于是闸在整个连滚里**一直开着**，看起来完美。
 *   真人的手不是这样的：滚轮/触摸板是一串**簇**（例如 3 个事件 8ms 内到齐，
 *   然后隔 100~200ms 再来一串）。每一串之间那一帧，闸就把 3 万个节点的卡片层
 *   **放回布局**，下一串再摘掉 —— 于是"摘/放"这个动作本身每 150ms 付一次钱，
 *   而那正是这个闸本来要省掉的那笔钱（全量子树重排）。
 *
 * 这一版量的就是它：一串一串地派，同时**每帧采样卡片层到底可不可见**，
 * 数"看不见卡的段落"有几段、可见不可见翻转了几次。
 *
 * 用法：node scripts/perf-burst.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'

const SRC = path.join(import.meta.dirname, '..', 'data', '信号与系统', 'board-傅里叶级数.md')

/* 一串 3 个事件、间隔 8ms；串与串之间 140ms；一共 14 串 ≈ 2.3 秒 —— 像人滚一下停一下。 */
const BURSTS = 14
const PER = 3
const GAP = 140

const fails = await withBoard(
  { tag: 'perfburst', port: 5241, cdpPort: 9281, make: () => fs.readFileSync(SRC, 'utf8'), settleMs: 6000 },
  async ({ s, ok, open }) => {
    await open()
    try { await s.send('Performance.enable') } catch {}

    const perfOf = async () => {
      const m = await s.send('Performance.getMetrics')
      const map = {}
      for (const x of m.metrics) map[x.name] = x.value
      return map
    }
    const md = (a, b, k) => +((b[k] - a[k]) * 1000).toFixed(0)

    /* 每帧采样：卡片层可不可见 + 帧间隔。翻转次数就是"闪"的次数。 */
    await s.eval(`(() => {
      window.__zz2 = { frames: [], vis: [], flips: 0, last: null, done: false, lt: [] }
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__zz2.lt.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] }) } catch (e) {}
      const cw = document.querySelector('.bd-cardworld')
      let last = performance.now()
      const tick = (t) => {
        const z = window.__zz2
        z.frames.push(+(t - last).toFixed(2)); last = t
        const vis = getComputedStyle(cw).display !== 'none'
        z.vis.push(vis ? 1 : 0)
        if (z.last !== null && z.last !== vis) z.flips++
        z.last = vis
        if (z.frames.length < 400) requestAnimationFrame(tick)
        else z.done = true
      }
      requestAnimationFrame(tick)
      return 1
    })()`)

    const bursts = async (label) => {
      await s.sleep(800)
      await s.eval(`(() => { window.__zz2.frames = []; window.__zz2.vis = []; window.__zz2.flips = 0; window.__zz2.lt = []; window.__zz2.last = null; return 1 })()`)
      const m0 = await perfOf()
      await s.eval(`(() => {
        const el = document.querySelector('.bd-stagewrap')
        const B = ${BURSTS}, P = ${PER}, GAP = ${GAP}
        let b = 0
        const send = () => {
          for (let i = 0; i < P; i++) {
            const d = b < B / 2 ? -20 : 20
            el.dispatchEvent(new WheelEvent('wheel', { deltaY: d, clientX: 700, clientY: 450, bubbles: true, cancelable: true }))
          }
        }
        const next = () => {
          if (b >= B) return
          b++
          send()
          setTimeout(next, GAP)
        }
        next()
        return 1
      })()`)
      await s.sleep(BURSTS * GAP + 1500)
      const m1 = await perfOf()
      const r = await s.eval(`(() => {
        const z = window.__zz2
        const span = z.vis.length
        /* "看不见卡的段落" = 连续的 0 有几段 */
        let runs = 0
        for (let i = 0; i < z.vis.length; i++) if (z.vis[i] === 0 && (i === 0 || z.vis[i - 1] === 1)) runs++
        const hiddenFrames = z.vis.filter((x) => x === 0).length
        const f = z.frames.slice(2).sort((x, y) => x - y)
        const lt = z.lt || []
        return {
          span, hiddenFrames, hiddenRuns: runs, flips: z.flips,
          p50: f.length ? +f[Math.floor(f.length / 2)].toFixed(1) : -1,
          p90: f.length ? +f[Math.floor(f.length * 0.9)].toFixed(1) : -1,
          lt: lt.length, ltMax: lt.length ? Math.max.apply(null, lt) : 0,
        }
      })()`)
      console.log(
        '  ' + label.padEnd(22) +
        ' 采样 ' + String(r.span).padStart(3) + ' 帧 | 卡片不可见 ' + String(r.hiddenFrames).padStart(3) + ' 帧 / ' + String(r.hiddenRuns).padStart(2) + ' 段' +
        ' | 可见性翻转 ' + String(r.flips).padStart(2) + ' 次' +
        ' | 帧p50 ' + String(r.p50).padStart(6) + ' p90 ' + String(r.p90).padStart(6) +
        ' | 长任务 ' + String(r.lt).padStart(3) + '(最长 ' + String(r.ltMax).padStart(4) + ')' +
        ' | Layout ' + String(md(m0, m1, 'LayoutDuration')).padStart(5) +
        ' Recalc ' + String(md(m0, m1, 'RecalcStyleDuration')).padStart(5) +
        ' Script ' + String(md(m0, m1, 'ScriptDuration')).padStart(5)
      )
      return r
    }

    console.log('')
    console.log('  ── 一串一串地滚（每串 ' + PER + ' 个事件，串间隔 ' + GAP + 'ms，共 ' + BURSTS + ' 串）──')
    const a1 = await bursts('[A] 现状（闸开）')
    const a2 = await bursts('[A] 现状（第二遍）')
    await s.eval(`(() => { const st = document.createElement('style'); st.id = 'zz-off'; st.textContent = '.bd.gesting .bd-cardworld { display: block !important; }'; document.head.appendChild(st); return 1 })()`)
    const b1 = await bursts('[B] 闸摘掉（=修之前）')
    await s.eval(`(() => { const e = document.getElementById('zz-off'); if (e) e.remove(); return 1 })()`)

    ok('闸开着时：卡片不可见 ' + a1.hiddenRuns + ' / ' + a2.hiddenRuns + ' 段，可见性翻转 ' + a1.flips + ' / ' + a2.flips + ' 次')
    ok('闸摘掉时：卡片不可见 ' + b1.hiddenRuns + ' 段（应当 0），翻转 ' + b1.flips + ' 次（应当 0）')
    ok('量完了')
  }
)
console.log('\nfails =', fails)
