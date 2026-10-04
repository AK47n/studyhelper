/* 探针 v8：拟合器修好之后，**缩放时剩下的那笔钱花在哪**。
 *
 * 背景：perf-cadence 的读数（每帧一次滚轮 × 60 帧，用户那张 213 张卡的板）——
 *   闸开：  Layout 276 / Recalc 102 / Script 1671  帧 p50 33.3
 *   闸摘：  Layout 105 / Recalc 921 / Script 1066  帧 p50 50
 * 也就是说"卡片看得见"那一路还有 ~15ms/帧的 **RecalcStyle**。这份探针把它归因：
 *   [1] 基线（卡片看得见）
 *   [2] 关掉全局滚动条（卡片里有 127 个 overflow:auto 的盒子）
 *   [3] 再把卡片里的 overflow 全改 visible（几何也不同了 —— 只为归因）
 *   [4] 卡片层 display:none（= 现有那个手势闸的效果，标尺）
 * 全程把闸**手动摘掉**（`.bd.gesting .bd-cardworld{display:block}`），否则量的是闸。
 *
 * 用法：node scripts/perf-recalc.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

const SRC = path.join(import.meta.dirname, '..', 'data', '信号与系统', 'board-傅里叶级数.md')

/* ★ 量纲/规模对照：`PERF_SMALL=1` 换成一张只有 3 张卡的小板。
   用途：那块 RecalcStyle 要是**跟 DOM 规模成正比**（大板 930ms / 小板接近 0），
   就说明有东西在让整棵树失效（可追）；要是两边一样（常数），那是另一回事。 */
const SMALL = !!process.env.PERF_SMALL
const makeFixture = () => {
  if (!SMALL) return fs.readFileSync(SRC, 'utf8')
  const b = newBoard('性能小板')
  for (let i = 0; i < 3; i++) {
    b.cards.push({ ...newCard('formula', 100 + i * 240, 120, { w: 200, h: 60 }), id: 'small' + i, tex: 'E = mc^2', src: 'E = mc^2' })
  }
  return serializeBoardDocument(b)
}

const FLING = 60

const fails = await withBoard(
  { tag: 'perfrecalc', port: 5244, cdpPort: 9284, make: makeFixture, settleMs: SMALL ? 2500 : 6000 },
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

    const css = async (id, text) => {
      await s.eval(`(() => {
        let st = document.getElementById(${JSON.stringify(id)})
        if (!st) { st = document.createElement('style'); st.id = ${JSON.stringify(id)}; document.head.appendChild(st) }
        st.textContent = ${JSON.stringify(text)}
        return 1
      })()`)
    }
    const drop = async (id) => s.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (e) e.remove(); return 1 })()`)

    ok('卡片里的 overflow:auto 盒子 ' + JSON.stringify(await s.eval(`(() => {
      let n = 0
      for (const e of document.querySelectorAll('.bd-card *')) {
        const cs = getComputedStyle(e)
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') n++
      }
      return { auto: n }
    })()`)))

    const fling = async (label) => {
      await s.sleep(800)
      const m0 = await perfOf()
      await s.eval(`(() => {
        const el = document.querySelector('.bd-stagewrap')
        let sent = 0, last = performance.now()
        window.__zzf = []
        const tick = (t) => {
          window.__zzf.push(+(t - last).toFixed(2)); last = t
          if (sent < ${FLING}) { sent++; el.dispatchEvent(new WheelEvent('wheel', { deltaY: sent < ${FLING} / 2 ? -20 : 20, clientX: 700, clientY: 450, bubbles: true, cancelable: true })) }
          if (sent <= ${FLING}) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick); return 1
      })()`)
      await s.sleep(4500)
      const m1 = await perfOf()
      const r = await s.eval(`(() => {
        const a = (window.__zzf || []).slice(1, ${FLING + 1}).sort((x, y) => x - y)
        return { p50: a.length ? +a[Math.floor(a.length / 2)].toFixed(1) : -1, max: a.length ? a[a.length - 1] : -1, n: a.length }
      })()`)
      console.log(
        '  ' + label.padEnd(30) + ' 帧p50 ' + String(r.p50).padStart(6) + ' max ' + String(r.max).padStart(7) +
        ' | Layout ' + String(md(m0, m1, 'LayoutDuration')).padStart(5) +
        ' Recalc ' + String(md(m0, m1, 'RecalcStyleDuration')).padStart(5) +
        ' Script ' + String(md(m0, m1, 'ScriptDuration')).padStart(5) +
        ' Task ' + String(md(m0, m1, 'TaskDuration')).padStart(5)
      )
      return r
    }

    /* ★ 先把那个手势闸**摘掉**：下面量的是"卡片看得见"那一路。
       （不摘的话，每一趟都被 display:none 挡掉，量出来的永远是"藏起来有多快"。） */
    await css('zz-gate-off', '.bd.gesting .bd-cardworld { display: block !important; }')

    console.log('')
    console.log('  ── 每帧一次滚轮（闸摘掉、卡片看得见）──')
    /* ★ 先普查一遍"谁在改 DOM"：RecalcStyle 那 ~15ms/帧总得有人触发。
       按 属性名 / 目标元素 归类，别只数总数 —— 数总数看不出是"一个人改了三万次"
       还是"三万个人各改一次"。 */
    await s.eval(`(() => {
      window.__zzMut = { attr: {}, tag: {}, total: 0, styleDiff: {}, samples: [] }
      /* style 那条要**看新旧值的差**：1 万次 style 写里，究竟写的是哪个属性。
         只数次数分不出"写 transform"和"写 --s"（后者会让整棵子树重算样式）。 */
      const firstDiff = (a, b) => {
        const A = String(a || '').split(';').map((x) => x.trim()).filter(Boolean)
        const B = String(b || '').split(';').map((x) => x.trim()).filter(Boolean)
        const setA = new Set(A)
        for (const x of B) if (!setA.has(x)) return x.slice(0, 40)
        return '(只看得出被删掉的)'
      }
      window.__zzMutMO = new MutationObserver((recs) => {
        for (const r of recs) {
          window.__zzMut.total++
          const a = r.attributeName || '(childList)'
          window.__zzMut.attr[a] = (window.__zzMut.attr[a] || 0) + 1
          const el = r.target
          const key = el.tagName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.')
          window.__zzMut.tag[key] = (window.__zzMut.tag[key] || 0) + 1
          if (a === 'style') {
            const d = firstDiff(r.oldValue, el.getAttribute('style'))
            const k = key + '  →  ' + d
            window.__zzMut.styleDiff[k] = (window.__zzMut.styleDiff[k] || 0) + 1
            if (window.__zzMut.samples.length < 6 && !window.__zzMut.samples.some((x) => x.k === k)) {
              window.__zzMut.samples.push({ k, old: String(r.oldValue || '').slice(0, 90), now: String(el.getAttribute('style') || '').slice(0, 90) })
            }
          }
        }
      })
      window.__zzMutMO.observe(document.querySelector('.bd-stagewrap').parentNode, {
        subtree: true, attributes: true, childList: true, attributeOldValue: true,
      })
      return 1
    })()`)
    await fling('[1] 基线')
    const mut = await s.eval(`(() => {
      const m = window.__zzMut
      const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
      return {
        total: m.total, attr: top(m.attr, 6), tag: top(m.tag, 6), styleDiff: top(m.styleDiff, 8), samples: m.samples,
        inputs: [...document.querySelectorAll('input')].slice(0, 6).map((i) => i.outerHTML.slice(0, 110)),
      }
    })()`)
    console.log('      这一段里 DOM 变动 ' + mut.total + ' 次')
    console.log('      按属性：' + mut.attr.map(([k, v]) => k + '×' + v).join('  '))
    console.log('      按目标：' + mut.tag.map(([k, v]) => k + '×' + v).join('  '))
    console.log('      style 写的到底是哪个属性：')
    for (const [k, v] of mut.styleDiff) console.log('        ' + String(v).padStart(5) + '  ' + k)
    for (const sm of mut.samples) console.log('        · ' + sm.k + '\n            旧 ' + sm.old + '\n            新 ' + sm.now)
    console.log('      页面上的 input：')
    for (const x of mut.inputs) console.log('        · ' + x)

    await css('zz-sb', '::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }')
    await fling('[2] + 关掉全局滚动条')
    await css('zz-ovf', '.bd-card *, .bd-card { overflow: visible !important; }')
    await fling('[3] + 卡片里 overflow 全放开')
    await drop('zz-ovf')
    await drop('zz-sb')
    /* ⚠ [4] 必须**先把闸那条覆盖规则撤掉**再藏卡片：`.bd.gesting .bd-cardworld`
       的特异性高于 `.bd-cardworld`，两条都带 !important 时**闸那条永远赢** ——
       不撤的话 [4] 量到的还是"卡片可见"（第一版就是这么量的，读数 947ms 骗了我一轮）。 */
    await drop('zz-gate-off')
    await css('zz-hide', '.bd-cardworld { display: none !important; }')
    await fling('[4] 卡片层整个藏（标尺）')
    await drop('zz-hide')
    await css('zz-gate-off', '.bd.gesting .bd-cardworld { display: block !important; }')

    /* ★ [5] 怀疑：**诊断用的 data-\* 写在 3 万节点的祖先上**（`.bd-world` 的
       data-live-tx / data-drawn-tx …，每帧都在写）—— 属性一变，Blink 要重新匹配
       "属性选择器"（styles.css 里就有 `[data-view-follow]`），而那条规则的作用域
       是**整棵子树**。小板（3 张卡）量出来 Recalc 只有 22ms，大板 930ms ——
       正好是"按子树规模"的形状。
       验法：把 `dataset` 整个换成普通 JS 对象（写在内存里，不落到 DOM 上），
       别的什么都不改。Recalc 掉下去 = 就是它。 */
    await s.eval(`(() => {
      if (window.__zzRealDataset) return 1
      window.__zzRealDataset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'dataset')
      const store = new WeakMap()
      Object.defineProperty(HTMLElement.prototype, 'dataset', {
        configurable: true,
        get() { let m = store.get(this); if (!m) { m = {}; store.set(this, m) } return m },
      })
      return 1
    })()`)
    await fling('[5] dataset 写进内存（不落 DOM）')
    await s.eval(`(() => {
      const d = window.__zzRealDataset
      if (d) Object.defineProperty(HTMLElement.prototype, 'dataset', d)
      return 1
    })()`)
    await fling('[1] 恢复基线（可逆？）')

    ok('量完了')
  }
)
console.log('\nfails =', fails)
