/* 探针 v6：**每一帧那几十毫秒的 Script 到底花在谁身上** —— V8 采样剖析器。
 *
 * 为什么用它（README 第 53 条 / check-frameperf 那段末尾就写着这个办法）：
 *   Layout / Script 这种总量只说"贵"，不说"是谁"；而"是谁"决定改哪儿。
 *   `Profiler.setSamplingInterval` 调到 100µs，拿回来的是**自身耗时**（self time），
 *   按函数聚合 —— 一眼就能看出是 React 重渲染、还是 KaTeX、还是画布重画。
 *
 * 采两种节奏：
 *   · 连滚（每帧一次）—— 对应 v4
 *   · 一串一串滚     —— 对应 v5（真人节奏）
 *
 * 用法：node scripts/perf-profile.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'

const SRC = path.join(import.meta.dirname, '..', 'data', '信号与系统', 'board-傅里叶级数.md')

const fails = await withBoard(
  { tag: 'perfprof', port: 5242, cdpPort: 9282, make: () => fs.readFileSync(SRC, 'utf8'), settleMs: 6000 },
  async ({ s, ok, open }) => {
    await open()
    await s.send('Profiler.enable')
    await s.send('Profiler.setSamplingInterval', { interval: 100 })

    const drive = async (kind) => {
      await s.sleep(700)
      await s.send('Profiler.start')
      if (kind === 'burst') {
        await s.eval(`(() => {
          const el = document.querySelector('.bd-stagewrap')
          let b = 0
          const next = () => {
            if (b >= 14) return
            b++
            for (let i = 0; i < 3; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: b < 7 ? -20 : 20, clientX: 700, clientY: 450, bubbles: true, cancelable: true }))
            setTimeout(next, 140)
          }
          next(); return 1
        })()`)
        await s.sleep(14 * 140 + 1200)
      } else {
        await s.eval(`(() => {
          const el = document.querySelector('.bd-stagewrap')
          let n = 0
          const tick = () => {
            if (n < 60) { n++; el.dispatchEvent(new WheelEvent('wheel', { deltaY: n < 30 ? -20 : 20, clientX: 700, clientY: 450, bubbles: true, cancelable: true })) }
            if (n < 61) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick); return 1
        })()`)
        await s.sleep(6000)
      }
      const { profile } = await s.send('Profiler.stop')
      return profile
    }

    /* 把 profile 折成 "自身耗时 top N"。timeDeltas[i] 是第 i 个样本到下一个的间隔（µs）。 */
    const top = (profile, n = 18) => {
      const byId = new Map(profile.nodes.map((x) => [x.id, x]))
      const self = new Map()
      const samples = profile.samples || []
      const deltas = profile.timeDeltas || []
      for (let i = 0; i < samples.length; i++) {
        const id = samples[i]
        self.set(id, (self.get(id) || 0) + (deltas[i] || 0))
      }
      const rows = []
      for (const [id, us] of self) {
        const nd = byId.get(id)
        if (!nd) continue
        const f = nd.callFrame
        const url = (f.url || '').split('/').pop().slice(0, 28)
        const name = (f.functionName || '(匿名)') + (f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : '')
        rows.push({ key: name + '  @' + url, ms: +(us / 1000).toFixed(1) })
      }
      const agg = new Map()
      for (const r of rows) agg.set(r.key, +(((agg.get(r.key) || 0) + r.ms)).toFixed(1))
      return [...agg].sort((a, b) => b[1] - a[1]).slice(0, n)
    }

    for (const kind of ['cadence', 'burst']) {
      const profile = await drive(kind)
      const total = +((profile.timeDeltas || []).reduce((a, b) => a + b, 0) / 1000).toFixed(0)
      console.log('')
      console.log('  ── ' + (kind === 'burst' ? '一串一串滚（真人节奏）' : '每帧一次滚轮（连滚）') + '：采样总时长 ' + total + 'ms ──')
      for (const [k, ms] of top(profile)) {
        console.log('    ' + String(ms).padStart(7) + 'ms  ' + k)
      }
    }
    ok('剖析完了')
  }
)
console.log('\nfails =', fails)
