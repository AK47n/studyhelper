/* 探针 v7：**拟合器是不是在空转**（stale → 下一帧再来 → stale → …）。
 *
 * 怀疑（2026-09-21）：
 *   card-fit.js 的 fitPass 第 101 行判"DOM 跟上没有"：
 *       wantW = worldLenToScreen(card.w, s × card.scale)   // = card.w × s × k（屏幕像素）
 *       domW  = cardEl.offsetWidth                          // 布局像素，**不含祖先 transform**
 *   而卡片的宽度写的就是 `width: card.w`（世界像素），祖先 `.bd-cardworld` 上有 scale(s)。
 *   ⇒ 只有 s×k ≈ 1 时两者才相等。开板时 fitView 会算出 s ≠ 1（213 张卡铺得很开），
 *     于是**每一张公式卡每一帧都是 'stale'** → `retryFrame` → 下一帧再来 → 永远不停。
 *   代价：每帧 213 次 querySelector + getComputedStyle + offsetWidth（fitWidth 那条还要
 *   写一次 style.width='max-content' 再读 = 写后读的强制布局）。
 *
 * 判据（全是页面事实，不猜）：
 *   ① 空转 1 秒里 data-fit 被改写多少次（拟合器每跑一趟每张卡写一次）
 *   ② data-fit 里 state 的分布（'stale' 就是它空转的铁证）
 *   ③ 当前视图 s
 *
 * 用法：node scripts/perf-fitloop.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'

const SRC = path.join(import.meta.dirname, '..', 'data', '信号与系统', 'board-傅里叶级数.md')

const fails = await withBoard(
  { tag: 'perffit', port: 5243, cdpPort: 9283, make: () => fs.readFileSync(SRC, 'utf8'), settleMs: 6000 },
  async ({ s, ok, open }) => {
    await open()
    try { await s.send('Performance.enable') } catch {}

    ok('视图 ' + JSON.stringify(await s.eval(`(() => {
      const cw = document.querySelector('.bd-cardworld')
      const m = /scale\\(([-0-9.]+)\\)/.exec(cw ? cw.style.transform : '')
      return { s: m ? Number(m[1]) : null, transform: cw ? cw.style.transform : null }
    })()`)))

    /* 静置：什么都不干，数 data-fit 被写了几次 */
    const idleWrites = async (ms, label) => {
      await s.eval(`(() => {
        window.__zzFit = 0
        if (!window.__zzMO) {
          window.__zzMO = new MutationObserver((recs) => { window.__zzFit += recs.length })
          window.__zzMO.observe(document.querySelector('.bd-stagewrap'), { subtree: true, attributes: true, attributeFilter: ['data-fit'] })
        }
        window.__zzFit = 0
        return 1
      })()`)
      await s.sleep(ms)
      const n = await s.eval('window.__zzFit')
      console.log('  ' + label.padEnd(28) + ' data-fit 改写 ' + String(n).padStart(6) + ' 次 / ' + ms + 'ms')
      return n
    }

    /* ★ 顺便数一下**存盘**：拟合器每提交一次尺寸 = 板变了 = 自动存盘一次。
       它要是慢速转个不停，屏幕上就是"文件一直在写"（磁盘 + 假 diff），
       而这跟"缩放卡不卡"是两件事，必须分开看。 */
    await s.eval(`(() => {
      window.__zzSave = 0
      if (!window.__zzFetch) {
        window.__zzFetch = window.fetch
        window.fetch = function (...a) {
          const u = String((a[0] && a[0].url) || a[0] || '')
          if (u.includes('/api/save')) window.__zzSave++
          return window.__zzFetch.apply(this, a)
        }
      }
      window.__zzSave = 0
      return 1
    })()`)

    const idle1 = await idleWrites(1000, '空转（无任何输入）')
    const idle2 = await idleWrites(1000, '空转（再来 1 秒）')
    const idle3 = await idleWrites(3000, '空转（再来 3 秒）')
    const idle4 = await idleWrites(5000, '空转（再来 5 秒）')
    const saves = await s.eval('window.__zzSave')
    console.log('  ' + '这 10 秒里 /api/save 被调了'.padEnd(24) + ' ' + saves + ' 次')

    /* data-fit 里 state 的分布 —— 'stale' = 量到"DOM 没跟上"，它下一帧还会再来 */
    const states = await s.eval(`(() => {
      const out = {}
      const sizes = []
      for (const el of document.querySelectorAll('[data-card-id]')) {
        let j = null
        try { j = JSON.parse(el.dataset.fit || 'null') } catch (e) {}
        const k = j ? j.state : '(没有 data-fit)'
        out[k] = (out[k] || 0) + 1
        if (j) sizes.push(j.state + ' need=' + j.need + ' w=' + j.w + ' h=' + j.h + ' tries=' + j.tries)
      }
      return { out, sample: sizes.slice(0, 6), cards: document.querySelectorAll('[data-card-id]').length }
    })()`)
    ok('data-fit 状态分布 ' + JSON.stringify(states.out) + '（共 ' + states.cards + ' 张卡）')
    for (const x of states.sample) console.log('      · ' + x)

    /* ★ 找出"每趟都在提交"的那张卡：隔 1.2 秒取两次快照，diff 出谁在动。
       它每次提交都会让"板变了"那条路把全队重新排上 —— 于是拟合器以 ~1 趟/秒
       永远转下去（实测 ~125 次 data-fit/秒）。 */
    const snapshot = () => s.eval(`(() => {
      const out = {}
      for (const el of document.querySelectorAll('[data-card-id]')) {
        let j = null
        try { j = JSON.parse(el.dataset.fit || 'null') } catch (e) {}
        if (j) out[el.dataset.cardId] = { st: j.state, need: j.need, w: j.w, h: j.h, tries: j.tries }
      }
      return out
    })()`)
    const a = await snapshot()
    await s.sleep(1200)
    const b = await snapshot()
    const moved = []
    for (const id of Object.keys(b)) {
      const x = a[id]
      const y = b[id]
      if (!x) continue
      if (x.w !== y.w || x.h !== y.h || x.st !== y.st) moved.push({ id, 前: x, 后: y })
    }
    console.log('      隔 1.2 秒：' + Object.keys(b).length + ' 张卡有读数，其中 ' + moved.length + ' 张在这一秒里变了')
    for (const m of moved.slice(0, 8)) console.log('      · ' + m.id + '  ' + JSON.stringify(m.前) + '  →  ' + JSON.stringify(m.后))

    /* 缩放一下再看：缩放本身不该把拟合器叫醒（视图变化和"板变了"是两回事） */
    await s.eval(`(() => {
      const el = document.querySelector('.bd-stagewrap')
      for (let i = 0; i < 5; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, clientX: 700, clientY: 450, bubbles: true, cancelable: true }))
      return 1
    })()`)
    await s.sleep(600)
    const idleZoom = await idleWrites(1000, '缩放几次之后的 1 秒')

    ok('空转 1 秒：' + idle1 + ' / ' + idle2 + ' 次；再 3 秒：' + idle3 + '；再 5 秒：' + idle4 + '；缩放后 1 秒：' + idleZoom + '；/api/save ' + saves + ' 次')
    if (idle1 > 500) ok('★ 拟合器确实在空转 —— 每帧都在量全板卡片（' + idle1 + ' 次/秒）')
    else if (idle4 > 0) ok('★ 拟合器基本安静了，但还有一条慢速尾巴：5 秒里 ' + idle4 + ' 次（存盘 ' + saves + ' 次）')
    else ok('拟合器完全安静（后 5 秒 0 次）—— 这个怀疑不成立')
    ok('量完了')
  }
)
console.log('\nfails =', fails)
