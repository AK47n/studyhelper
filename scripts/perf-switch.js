/* 探针：点「白板 / 笔记」那两个入口，界面到底卡多久、钱花在哪。
 *
 * 用户原话（2026-10-01）：「点笔记与点白板这个切换时间好长，跟卡了一下感觉得要 1，2 秒钟了」。
 * 这个脚本不修任何东西，只把一次切换拆成几份读数：
 *   · latency  —— 从"点下去"到"界面真的换过去了"（rAF 里量，就是人感觉到的那一下）
 *   · longtask —— 期间 + 之后主线程上超过 50ms 的任务
 *   · resource —— 期间 / 之后发出去的 /api 请求各自花了多久（网络 + 存盘那一份）
 *   · profile  —— CPU 采样：自耗最多的前几个函数（谁在霸着线程）
 *
 * 用法：node scripts/perf-switch.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'

/* 拿**用户自己最大那张板**当夹具内容 —— 要量的就是"他的板有多慢"，
   用一张小样板会量出一片绿，然后什么都没修着。 */
const SRC = path.join(import.meta.dirname, '..', 'data', '模电', 'board-1.md')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** CPU profile → 自耗 top N（按 sample 数） */
function topSelf(profile, n = 12) {
  const byId = new Map()
  for (const nd of profile.nodes) byId.set(nd.id, nd)
  const self = new Map()
  for (const id of profile.samples) self.set(id, (self.get(id) || 0) + 1)
  const total = profile.samples.length || 1
  const rows = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, c]) => {
      const nd = byId.get(id) || {}
      const f = nd.callFrame || {}
      const url = String(f.url || '')
      return `${((c / total) * 100).toFixed(1)}%  ${f.functionName || '(匿名)'}  @${url.split('/').pop()}:${f.lineNumber}`
    })
  return { rows, total }
}

await withBoard(
  { tag: 'switch', port: 5241, cdpPort: 9281, make: () => fs.readFileSync(SRC, 'utf8'), settleMs: 12000 },
  async ({ s, ok, open }) => {
    await open()
    await s.send('Performance.enable').catch(() => {})

    ok('起点（白板）' + JSON.stringify(await s.eval(`(() => {
      const q = (x) => document.querySelectorAll(x).length
      return { cards: q('.bd-card'), bodyNodes: document.body.querySelectorAll('*').length }
    })()`)))
    if (s.exceptions && s.exceptions.length) {
      console.log('  页面异常：' + JSON.stringify(s.exceptions.slice(0, 3), null, 1).slice(0, 1200))
      console.log('  body: ' + String(await s.eval('document.body.innerHTML.slice(0,300)')))
    }

    await s.eval(`(() => {
      window.__lt = []
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)) })
          .observe({ entryTypes: ['longtask'] })
      } catch (e) {}
      window.__res = []
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') {
              window.__res.push([decodeURIComponent(e.name.replace(location.origin, '')), Math.round(e.duration), e.transferSize || 0])
            }
          }
        }).observe({ entryTypes: ['resource'] })
      } catch (e) {}

      window.__switch = (label, wantSel) => new Promise((res) => {
        const want = Array.prototype.find.call(document.querySelectorAll('.modes .mode'), (b) => (b.textContent || '').indexOf(label) >= 0)
        if (!want) return res({ err: '找不到「' + label + '」按钮' })
        window.__lt.length = 0
        window.__res.length = 0
        const t0 = performance.now()
        want.click()
        const tick = () => {
          const on = document.querySelector('.modes .mode.on')
          if (on && (on.textContent || '').indexOf(label) >= 0 && document.querySelector(wantSel)) {
            return res({ ms: Math.round(performance.now() - t0), lt: window.__lt.slice(), res: window.__res.slice() })
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      return 1
    })()`)

    const dump = (tag, r) => {
      console.log(`\n  [${tag}] 界面换过去 ${r.ms} ms`)
      if (r.lt.length) console.log(`      切换期间长任务：${r.lt.join(', ')} ms`)
      if (r.res.length) console.log(`      请求：${r.res.map((x) => x[0].replace('/api/file/', '') + ' ' + x[1] + 'ms/' + Math.round(x[2] / 1024) + 'KB').join(' | ')}`)
    }

    /* Performance 累计计数器：看钱花在 Layout / RecalcStyle / Script 哪一头 */
    const perfOf = async () => {
      const m = await s.send('Performance.getMetrics')
      const map = {}
      for (const x of m.metrics) map[x.name] = x.value
      return map
    }
    const perfDelta = (a, b) => {
      const keys = ['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount']
      const out = {}
      for (const k of keys) out[k] = Math.round(((b[k] || 0) - (a[k] || 0)) * 1000) / 1000
      return out
    }

    const steps = [
      ['笔记', '.center .topbar'],
      ['白板', '.bd-stagewrap'],
      ['笔记', '.center .topbar'],
    ]

    for (let i = 0; i < steps.length; i++) {
      const [label, sel] = steps[i]
      const p0 = await perfOf()
      const r = await s.eval(`window.__switch(${JSON.stringify(label)}, ${JSON.stringify(sel)})`)
      dump(i + 1 + ' 点「' + label + '」', r)
      await sleep(1500)
      console.log('      计数器增量：' + JSON.stringify(perfDelta(p0, await perfOf())))
      const tail = await s.eval(`(() => {
        const l = window.__lt.slice(); const rr = window.__res.slice()
        window.__lt.length = 0; window.__res.length = 0
        return { l, rr }
      })()`)
      if (tail.l.length) console.log(`      余震(1.5s)长任务：${tail.l.join(', ')} ms`)
      if (tail.rr.length) console.log(`      余震请求：${tail.rr.map((x) => x[0].replace('/api/file/', '') + ' ' + x[1] + 'ms/' + Math.round(x[2] / 1024) + 'KB').join(' | ')}`)
      if (label === '笔记') {
        /* ★ 两层总高必须相等 —— 这是编辑区那条底线（scripts/tail-compare.js 盯的） */
        console.log('      两层高度：' + JSON.stringify(await s.eval(`(() => {
          const inner = document.querySelector('.hl-inner')
          const ta = document.querySelector('textarea.raw')
          if (!inner || !ta) return { err: 'DOM 不全' }
          const cs = getComputedStyle(ta)
          const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
          return {
            hlInnerH: Math.round(inner.getBoundingClientRect().height),
            taContentH: Math.round(ta.scrollHeight - pad),
            diff: Math.round(inner.getBoundingClientRect().height - (ta.scrollHeight - pad)),
          }
        })()`)))
        console.log('      行高对账：' + JSON.stringify(await s.eval(`(() => {
          const ta = document.querySelector('textarea.raw')
          const inner = document.querySelector('.hl-inner')
          if (!ta || !inner) return { err: 'DOM 不全' }
          const cs = getComputedStyle(ta)
          const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
          const rows = ta.value.split('\\n').length
          const ls = document.querySelectorAll('.hl-line')
          const first = ls[0], last = ls[ls.length - 1]
          const hlLineH = (last.getBoundingClientRect().top - first.getBoundingClientRect().top) /
                          (Number(last.dataset.i) - Number(first.dataset.i))
          const mir = document.createElement('div')
          mir.className = 'hl-chunk text'
          mir.textContent = '\\n'.repeat(1000)
          inner.appendChild(mir)
          const mirH = mir.getBoundingClientRect().height
          mir.remove()
          return {
            行数: rows,
            着色层每行: +hlLineH.toFixed(4),
            镜像每行: +(mirH / 1001).toFixed(4),
            textarea每行: +((ta.scrollHeight - pad) / rows).toFixed(4),
            taScrollH: ta.scrollHeight,
            fontSize: cs.fontSize, lineHeight: cs.lineHeight,
          }
        })()`)))
        console.log('      分块：' + JSON.stringify(await s.eval(`(() => {
          const all = document.querySelectorAll('.hl-chunk')
          const txt = document.querySelectorAll('.hl-chunk.text')
          return { chunks: all.length, 排原文的块: txt.length, 空占位块: all.length - txt.length }
        })()`)))
        /* textarea 自己排这 5 万行要多久 —— 区分"着色层还在排"和"textarea 本来就慢" */
        console.log('      textarea 排版：' + JSON.stringify(await s.eval(`(() => {
          const src = document.querySelector('textarea.raw')
          if (!src) return { err: '没有 textarea' }
          const cs = getComputedStyle(src)
          const ta = document.createElement('textarea')
          ta.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + src.clientWidth +
            'px;font-size:' + cs.fontSize + ';font-family:' + cs.fontFamily +
            ';line-height:' + cs.lineHeight + ';white-space:pre-wrap;word-break:' + cs.wordBreak +
            ';overflow-wrap:' + cs.overflowWrap + ';padding:' + cs.padding + ';border:0;letter-spacing:normal;'
          ta.value = src.value
          document.body.appendChild(ta)
          const t0 = performance.now()
          const h = ta.scrollHeight
          const dt = performance.now() - t0
          ta.remove()
          return { ms: Math.round(dt), h, chars: src.value.length }
        })()`)))
        console.log('      笔记侧 DOM：' + JSON.stringify(await s.eval(`(() => {
          const q = (x) => document.querySelectorAll(x).length
          return { hlLines: q('.hl-line'), hlSpans: q('.hl-inner span'), bodyNodes: document.body.querySelectorAll('*').length }
        })()`)))
      }
    }

    /* ── CPU profile：再切一次笔记，全程采样 ── */
    console.log('\n  ── CPU 采样（再切一次「笔记」，采到切换后 3 秒）──')
    await s.send('Profiler.enable').catch(() => {})
    await s.send('Profiler.setSamplingInterval', { interval: 300 }).catch(() => {})
    await s.send('Profiler.start').catch(() => {})
    const r = await s.eval(`window.__switch('笔记', '.center .topbar')`)
    await sleep(3000)
    const { profile } = await s.send('Profiler.stop')
    dump('profile', r)
    const t = topSelf(profile)
    console.log(`      采样总数 ${t.total}`)
    for (const row of t.rows) console.log('      ' + row)

    return 0
  }
)
