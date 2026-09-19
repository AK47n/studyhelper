/* 平移取证的**精确**量法：在"墨迹换上那一版新变换"的一瞬间，卡片对不对得上。
 *
 * ── 它比 `check:pan` 强在哪（也为什么要单独留一个工具）──────────────────────
 * 用户 2026-09-18 报的「移动画布的时候卡片和板框会相对于字产生相对滑动」，
 * 是**两条路各自去够同一个视野、到达时间不同**造成的。那一段"差"可能活不过一帧，
 * 所以：
 *   · 按固定节奏采样（每片之间 await 一次往返）**采不到它** —— React 每次都追得上；
 *   · "两点间距"那类判据对**平移不敏感**，整块多挪一步照样绿。
 * 这里的量法绕开这两件事：
 *   ① 用 `Emulation.setCPUThrottlingRate` 把 React 的 commit 拖慢（默认 20×），
 *      把"差"那一段从"不到一帧"拉宽到看得见；
 *   ② 用 `MutationObserver` 盯 `canvas.bd-ink` 的 `data-xform` ——
 *      那是墨迹**换上**新变换的一瞬间，浏览器紧接着就要画这一帧。
 *      在这一下把卡片的 `getBoundingClientRect` 和墨迹的 `s/t` 一起读出来。
 *   判据：`卡片实到 == 舞台原点 + 卡片世界x × s_ink + t_ink`。
 *
 * ── 两个"量错了"的坑（都是探针自己的错，别重犯）──────────────────────────
 *   · **别用 rAF 采样**：那里读到的 `dataset.xform` 可能还是上一次 effect 写的
 *     （新的一趟还没跑），于是报出一个**根本不会被画出来**的假差。
 *     我为此查了两轮，量到 6px / 10px 全是假的。
 *   · **反推卡片世界坐标别忘了除以 s**：`世界x = (rect − stageX − t) / s`。
 *     漏了它整张表是一个恒定的 −146px 的假差，看着像天大的 bug。
 *
 * 跑：node scripts/diag-pan-frame.js [throttleRate]   （npm run diag:pan）
 * 正常结果：**最大偏差 0.000px**（实测 20× / 40× 都一样）。
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

const RATE = Number(process.argv[2] || 20)

const CARDS = [
  { x: 400, y: 300, w: 260, h: 90, text: '甲' },
  { x: 1300, y: 1100, w: 260, h: 90, text: '乙' },
]
const doc = (() => {
  const b = newBoard('降速逐帧夹具')
  for (const c of CARDS) {
    const card = newCard('note', c.x + c.w / 2, c.y + c.h / 2, { w: c.w, h: c.h, text: c.text })
    card.x = c.x
    card.y = c.y
    b.cards.push(card)
  }
  return b
})()

const DX = 240
const DY = 160
const PIECES = 40

await withBoard(
  { tag: 'panframe3', port: 5219, cdpPort: 9249, text: serializeBoardDocument(doc) },
  async ({ s, ok, bad, open }) => {
    await open()
    const ev = (e) => s.eval(e)

    /* 降速：让每一帧里 React 只来得及做一点点事 —— 这就是用户那只 240Hz 的笔
       每一帧都在制造的局面（只是这里把它放大到看得见）。 */
    await s.send('Emulation.setCPUThrottlingRate', { rate: RATE })
    console.log(`\n  CPU 降速 ${RATE}×（React 的 commit 被拖慢，差那一小段就看得见了）`)
    await s.sleep(300)

    await ev(`(() => {
      window.__f = []
      const cv = document.querySelector('canvas.bd-ink')
      const card0 = document.querySelector('.bd-card')
      const w = () => document.querySelector('.bd-world')
      /* ★★ 采样的时刻是关键：**在 canvas 的变换被写下去的那一瞬间**取数。
         为什么非得是这一刻：那一瞬间正是"墨迹要用新变换画、卡片要用新 left/top 摆"
         的开始，而浏览器紧接着就会绘制这一帧 —— 所以这一刻两组东西对不对得上，
         就是**这一帧画出来是什么样**。
         拿 rAF 回调去采是不行的：那里读到的 dataset.xform 可能还是上一次 effect
         写的（新的一趟还没跑），于是会报出一个**根本不会被画出来**的假差
         （我为此浪费了两轮，量到 6px / 10px 全是探针自己的错）。
         ★ MutationObserver 的回调在微任务里跑，此时 React 的同步提交已经做完、
         浏览器的样式重算还没发生 —— 正是"画之前"那一刻。 */
      new MutationObserver(() => {
        const [sc, tx, ty] = (cv.dataset.xform || '1,0,0').split(',').map(Number)
        const dpr = cv.width / parseFloat(cv.style.width || cv.width)
        const world = w()
        const st = document.querySelector('.bd-stagewrap').getBoundingClientRect()
        const r = card0.getBoundingClientRect()
        window.__f.push({
          inkTx: +(tx / dpr).toFixed(3),
          inkS: +(sc / dpr).toFixed(6),
          /* 卡片**实际**屏幕 x（含它自己那条补正和 stage 的原点） */
          cardRectX: +r.left.toFixed(3),
          stageX: +st.left.toFixed(3),
          corrTx: (() => { const m = /translate\\(\\s*([-\\d.eE]+)px/.exec(world.style.transform || ''); return m ? +m[1] : null })(),
          liveTx: parseFloat(world.dataset.liveTx),
          drawnTx: parseFloat(world.dataset.drawnTx),
        })
      }).observe(cv, { attributes: true, attributeFilter: ['data-xform'] })
      window.__pp = {
        spot() {
          const hit = document.querySelector('.bd-hit')
          const r = hit.getBoundingClientRect()
          const boxes = [...document.querySelectorAll('.bd-card')].map((c) => c.getBoundingClientRect())
          const inside = (x, y) => boxes.some((b) => x >= b.left - 8 && x <= b.right + 8 && y >= b.top - 8 && y <= b.bottom + 8)
          for (const fy of [0.25, 0.4, 0.55, 0.7, 0.85]) {
            for (const fx of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
              const x = Math.round(r.left + r.width * fx)
              const y = Math.round(r.top + r.height * fy)
              if (inside(x, y)) continue
              if (document.elementsFromPoint(x, y)[0] !== hit) continue
              return { x, y }
            }
          }
          return null
        },
      }
      return true
    })()`)

    const spot = await ev(`window.__pp.spot()`)
    await s.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: spot.x, y: spot.y, button: 'middle', buttons: 4, clickCount: 1,
    })
    for (let i = 1; i <= PIECES; i++) {
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(spot.x + (DX * i) / PIECES),
        y: Math.round(spot.y + (DY * i) / PIECES),
        button: 'middle', buttons: 4,
      })
    }
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: spot.x + DX, y: spot.y + DY, button: 'middle', buttons: 0,
    })
    await s.sleep(500)
    const frames = await ev(`window.__f`)

    /* ★★★ 判据：**在墨迹写上新变换的那一瞬间，卡片必须和它落在同一个位置。**
       卡片该在哪儿 = 舞台原点 + 卡片世界 x × s_ink + t_ink。
       卡片的**世界 x** 从它自己的读数反推（`cardX0` = 第一次静止时的
       rect − stageX − inkTx，此时 s = 1 且没有补正），这样不用知道夹具的坐标系
       也不用管卡片自己的内边距 —— 第一版就是在这儿算错的（差了个恒定的 −146px）。 */
    const f0 = frames[0]
    if (!f0) {
      bad('一帧都没采到 —— MutationObserver 没被触发（canvas 没重画？）')
    } else {
      console.log('\n  首帧原始读数：' + JSON.stringify(f0))
      console.log('  末帧原始读数：' + JSON.stringify(frames[frames.length - 1]))
      /* ⚠ 别忘了除以 s：`cardRectX = stageX + 世界x × s + t` ⇒ 世界x = (rect − stageX − t) / s。
         第一版漏了那个除法，反推出 244（真值 400），于是整张表全是恒定的 95px 假差。 */
      const worldXOfCard = (f0.cardRectX - f0.stageX - f0.inkTx) / f0.inkS
      console.log(`\n  卡片的世界 x（反推）= ${worldXOfCard.toFixed(2)}；共采样 ${frames.length} 次"刚写上变换"的时刻`)
      console.log('\n     inkTx      inkS     卡片应到    卡片实到     差')
      const errs = []
      for (const f of frames) {
        const want = f.stageX + worldXOfCard * f.inkS + f.inkTx
        const d = f.cardRectX - want
        errs.push({ d, f })
      }
      for (const e of errs.slice(0, 60)) {
        const f = e.f
        console.log(
          `  ${String(f.inkTx).padStart(9)}  ${String(f.inkS).padStart(7)}  ${want2(f).padStart(10)}  ${String(f.cardRectX).padStart(10)}  ${String(e.d.toFixed(3)).padStart(7)}`
        )
      }
      const worst = errs.reduce((m, e) => Math.max(m, Math.abs(e.d)), 0)
      console.log(`\n  最大偏差 ${worst.toFixed(3)}px`)
      if (worst <= 1) ok(`墨迹每写上一次新变换，卡片就正好落在同一个位置（${frames.length} 次，最大差 ${worst.toFixed(3)}px）`)
      else bad(`卡片和墨迹在"画出来那一刻"对不上：最大 ${worst.toFixed(3)}px —— 这就是"相对滑动"`)

      const badInv = frames.filter((f) => f.corrTx !== null && Math.abs(f.corrTx - (f.liveTx - f.drawnTx)) > 0.001)
      if (!badInv.length) ok(`补正的量始终等于"还差多少"（${frames.filter((f) => f.corrTx !== null).length}/${frames.length} 次挂着补正）`)
      else bad(`补正量算错：${JSON.stringify(badInv.slice(0, 3))}`)
    }
  }
)

function want2(f) {
  const wx = (f.cardRectX - f.stageX - f.inkTx) / f.inkS
  return (f.stageX + wx * f.inkS + f.inkTx).toFixed(3)
}
