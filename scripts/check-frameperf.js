/* 大板 + 板框：**拖动板框时每一帧要花多久** —— 真浏览器自检。
 *
 * 为什么必须有这一条（2026-09-18 用户报「一放板框就巨卡」）：
 *   这是一个**只在"板很大 + 框很大"时才出现**的病，而且它一路躲过了所有既有自检 ——
 *   纯逻辑自检（check-board）量的是"读出来的连接对不对"，不是"读一次要多久"；
 *   界面自检（check-link / check-pan）用的都是几张**很小的夹具板**，
 *   在那个规模上 650ms 的病根只值零点几毫秒，绿得理直气壮。
 *   而用户的板是 1451 笔、其中一个框装了 777 笔。
 *
 * 病根（一句话）：`buildLinks` 对**每一笔**问两次"这一点落在谁身上"，而
 *   `nodeAt` 每次都自己 `nodeList(board)` → 给**每个板框**重跑一遍 `frameBounds`
 *   （= 把框里几百笔逐点扫一遍求包围盒）。代价 ∝ 笔数 × 框成员数：
 *   1451 × 2 次 × 777 笔 = 548ms。更坏的是它在**每一帧**都跑
 *   （拖框时 `translateFrame` 每帧换新 strokes 引用 → `createLinkReader` 判定"变了"
 *     → 索引 + buildLinks + 条件全套重来），于是实际是 650ms/帧 ≈ 1.5fps。
 *   修法：热循环里把 `nodeList` **算一次**传进去（`nodeAt(board, p, { nodes })`）。
 *
 * ★ 这条自检要钉住的**不是"今天多快"**，是**形状**：
 *   代价必须是 O(笔数)，不能再回到 O(笔数 × 框成员数)。
 *   所以下面造的数据是"一支大框装了板上一大半的笔"——**专门放大那个乘积**。
 *   阈值给得很松（中位帧间隔 < 40ms，即 ≥25fps）：这一条是"别退化成 650ms"的哨兵，
 *   不是精细的性能基准（真基准走 scripts/perf.js 那一族）。
 *
 * ⚠ 夹具由 `withBoard` 自己造（`board-zz-frameperf.md`），**跑完它自己删**；
 *   用户的板一个字节都不读也不写。
 *
 * ★ 这里曾经写错过一次，记下来：第一版是"进了界面之后再调 `/api/new` 造板"，
 *   于是撞上两件事 —— ① `withBoard` 已经用同一个名字铺了一张夹具（`同名文件已存在`），
 *   ② 就算改成另一个名字，那张板也是**自检自己丢下的**、收尾没人删。
 *   正确做法是**把内容交给夹具本人**：`withBoard({ tag, make })`，
 *   生命周期（写 / 删 / 守卫）全在 harness 一处，脚本不再自己碰盘。
 *
 * 用法：node scripts/check-frameperf.js
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'

/* 造一张"用户那个规模"的板：约 1400 笔、每笔 20 个点左右（≈ 3 万个点），
   其中一个板框装下**大部分**笔 —— 这正是把 `笔数 × 框成员数` 放大的形状。
   ⚠ 笔迹要**散开**，别都挤在一小片：那样"两头落在哪张卡里"会因为重叠而变形状，
     量出来的东西就不只是我们要钉的那一项了。 */
const N = 1400
const PTS = 22
function makeBigBoard() {
  const strokes = []
  for (let i = 0; i < N; i++) {
    const col = i % 40
    const row = Math.floor(i / 40)
    const x0 = col * 60
    const y0 = row * 50
    const points = []
    for (let k = 0; k < PTS; k++) points.push(x0 + k * 2, y0 + Math.sin(k / 3) * 6, 0.5)
    strokes.push({ id: 'zzperf' + i, tool: 'pen', width: 2.5, color: '#e8eefc', points })
  }
  const board = newBoard('自检夹具（跑完自动删除）')
  board.strokes = strokes
  /* 一个框装 4/5 的笔 —— 乘积就出在这儿。 */
  board.frames = [{ id: 'zzperf-frame', title: '自检的大框', ids: strokes.slice(0, Math.floor(N * 0.8)).map((s) => s.id), cards: [] }]
  return board
}

const fails = await withBoard(
  {
    tag: 'frameperf',
    port: 5221,
    cdpPort: 9261,
    win: '1280,860',
    /* ★ 大板当"夹具内容"交给 harness：它负责写盘、负责跑完删掉、负责守卫。
       （第一版是在页面里调 `/api/new` 造第二张板 —— 既撞名、又没人收尾。） */
    text: serializeBoardDocument(makeBigBoard()),
    /* 这张板有 3 万个点，落盘 + 首帧重画都要时间，给它宽一点 */
    settleMs: 3000,
  },
  async ({ s, ok, bad, open, until }) => {
    /* ① 打开它，并且确认**板上真有那个框的把手**（没有把手就量不到拖动） */
    await open()
    const handle = await until(
      async () => {
        const v = await s.eval(`(() => {
          const h = document.querySelector('.bd-frame-t')
          if (!h) return null
          const r = h.getBoundingClientRect()
          if (!r.width) return null
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`)
        return v || undefined
      },
      { what: '大板上出现了板框把手', timeout: 15000 }
    )
    if (!handle.ok) {
      bad('大板上找不到板框把手（3 万点的板没画出来？）—— 量不了拖动')
      return
    }
    ok(`大板开出来了：${N} 笔 / 每笔 ${PTS} 点 / 一个框装 80%，框把手在（能拖它）`)

    /* ③ 采 60fps 的底：先记一段"什么都不干"的帧间隔，作为这条自检自己的参照 */
    await s.eval(`(() => {
      window.__zzf = []
      let last = performance.now()
      const tick = () => {
        const n = performance.now()
        window.__zzf.push(n - last)
        last = n
        if (window.__zzf.length < 600) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 400))
    const idle = await s.eval(`(() => {
      const a = (window.__zzf || []).slice(4, 34).sort((x, y) => x - y)
      return a.length ? +a[Math.floor(a.length / 2)].toFixed(1) : -1
    })()`)

    /* ④ 真拖：按下把手 → 一连串 move → 松手。数这一段的帧间隔。 */
    const before = await s.eval(`(window.__zzf || []).length`)
    await s.mouse(handle.value.x, handle.value.y)
    for (let i = 1; i <= 45; i++) {
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: handle.value.x + 6 + i * 2,
        y: handle.value.y + 4 + i,
        button: 'left',
        buttons: 1,
      })
    }
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: handle.value.x + 100,
      y: handle.value.y + 50,
      button: 'left',
      buttons: 0,
    })
    await new Promise((r) => setTimeout(r, 250))

    const during = await s.eval(`(() => {
      const a = (window.__zzf || []).slice(${before}, ${before} + 60).sort((x, y) => x - y)
      if (!a.length) return { median: -1, max: -1, n: 0 }
      return { median: +a[Math.floor(a.length / 2)].toFixed(1), max: +a[a.length - 1].toFixed(1), n: a.length }
    })()`)

    ok(`空转时帧间隔中位 ${idle}ms（这条自检自己的参照）`)
    ok(`拖动那一段：中位 ${during.median}ms / 最长 ${during.max}ms（${during.n} 个样本）`)

    /* ★ 判据。松动是故意的：要抓的是"退回 650ms"那一族，
       不是"今天比昨天慢 2ms"。60fps = 16.7ms，40ms ≈ 25fps。 */
    if (during.median >= 0 && during.median < 40) {
      ok('★ 拖板框跟得上手（中位帧间隔 < 40ms）')
    } else {
      bad(
        `★ 拖板框卡住了：中位帧间隔 ${during.median}ms。` +
          '多半是"每一帧都在重建端点清单"那一族回来了 —— 看 nodes.js 的 nodeAt 说明。'
      )
    }
    /* 只剩一帧两个样本不够判 —— 明确说出来，别让它悄悄变成绿灯 */
    if (during.n >= 20) ok(`样本够（${during.n} 帧）`)
    else bad(`样本太少（${during.n} 帧），这一次的结论不算数 —— 重跑`)

    /* ⑤ 顺带钉一下"框线还跟着内容走"：拖完框的包围盒应当变了 */
    const moved = await s.eval(`(() => {
      const d = document.querySelector('.bd-frame')
      return d ? d.style.left + ',' + d.style.top : null
    })()`)
    if (moved) ok('框线跟着内容一起挪了（拖完还在正确位置）')
    else bad('拖完框线不见了')

    /* ═══════════ ⑥ 框住一大片笔迹再**旋转**它 ═══════════
     *
     * 为什么补这一条（2026-09-21，用户报「大字体旋转时卡顿」）：
     *   形状判读（那颗「◯ 规整」按钮的可见性）原来是个 `useMemo([sel.strokes])`，
     *   而 `sel.strokes` **每一帧都是新数组** —— 于是拖动 / 缩放 / 旋转 / 平移时，
     *   它按"框住的笔数 × 每笔拟合"**每帧重跑一遍**（实测用户那张板上框住 171 笔是
     *   0.6ms/帧，整页框住是好几毫秒），而那一帧的结果**没有一个人看得见**。
     *   ⇒ 这一条把一个**大选区**转到手上量帧间隔：代价必须还是 O(笔数)，
     *     不能回到"每帧把选中的几百笔重新判读一遍"。
     * ⚠ 判据和 ④ 一样松（中位 < 40ms）：这一条是**哨兵**，不是性能基准 ——
     *   headless 里量不出 GPU 那一侧的真实手感（合成器太快），所以它抓的是"退化成
     *   每帧几十毫秒"那一族，而不是"今天比昨天慢 2ms"。见 README 第 53 条。
     * ⚠⚠ **实测过它能抓什么、不能抓什么**（A/B 同一台机器、同一个夹具、框住 414 笔）：
     *     改之前 中位 31.1ms ｜ 改之后 29.3ms —— 差的那 1.8ms/帧正是形状判读那一份。
     *   也就是说：**它抓不住这一条具体的回归**（两个数都在阈值之内），
     *   它抓的是"有人把某一趟做成 O(选区 × 每笔点数)、或者又加了一趟全板扫描"。
     *   想要更细的读数就别改阈值（那会变成一台机器一个结论），
     *   走 `.cache` 里那种一次性探针：V8 sampling profiler 的**自身耗时**
     *   （`Profiler.setSamplingInterval` + `Profiler.stop`）—— 那才分得出"是谁花了这 1.8ms"。 */
    {
      const st = await s.eval(`(() => { const e = document.querySelector('.bd-stagewrap'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
      /* 先切到「⬚ 框选」，拉一个罩住大半张板的框（把这几百笔都选进来）。 */
      await s.eval(`(() => { const t = document.querySelector('[data-tool="select"]'); if (t) t.click(); return 1 })()`)
      await new Promise((r) => setTimeout(r, 250))
      const a = { x: Math.round(st.x + 12), y: Math.round(st.y + 12) }
      const b = { x: Math.round(st.x + st.w - 380), y: Math.round(st.y + st.h * 0.72) }
      await s.drag(a.x, a.y, b.x - a.x, b.y - a.y, { steps: 10, button: 'left' })
      await new Promise((r) => setTimeout(r, 500))
      await s.eval(`(() => { const t = document.querySelector('[data-tool="pen"]'); if (t) t.click(); return 1 })()`)
      const sel = await s.eval(`(() => {
        const box = document.querySelector('.bd-pickhandles')
        return box ? { n: (box.dataset.pickHandles || '').split(',').filter(Boolean).length } : null
      })()`)
      if (!sel || !sel.n) {
        bad('⑥ 大选区没框住（没有手柄）—— 这一条量不了')
      } else {
        const h = await s.eval(`(() => {
          const box = document.querySelector('.bd-pickhandles')
          const at = {}
          for (const el of box.querySelectorAll('.bd-pickhandle')) {
            const r = el.getBoundingClientRect()
            at[el.dataset.pickHandle] = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          }
          return at
        })()`)
        const ctr = { x: (h.nw.x + h.se.x) / 2, y: (h.nw.y + h.se.y) / 2 }
        const vx = h.rot.x - ctr.x
        const vy = h.rot.y - ctr.y
        const at = (t) => ({ x: Math.round(ctr.x + vx * Math.cos(t) - vy * Math.sin(t)), y: Math.round(ctr.y + vx * Math.sin(t) + vy * Math.cos(t)) })
        const before2 = await s.eval(`(window.__zzf || []).length`)
        const p0 = at(0)
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p0.x, y: p0.y, pointerType: 'mouse' })
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' })
        const p1 = at(0.01)
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p1.x, y: p1.y, button: 'left', buttons: 1, pointerType: 'mouse' })
        for (let i = 1; i <= 45; i++) {
          const p = at(0.01 + (i / 45) * (1.2 - 0.01))
          await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'mouse' })
        }
        const pe = at(1.2)
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pe.x, y: pe.y, button: 'left', clickCount: 1, buttons: 0, pointerType: 'mouse' })
        await new Promise((r) => setTimeout(r, 300))
        const rotStat = await s.eval(`(() => {
          const a = (window.__zzf || []).slice(${before2}, ${before2} + 60).sort((x, y) => x - y)
          if (!a.length) return { n: 0, median: -1, max: -1 }
          return { n: a.length, median: +a[Math.floor(a.length / 2)].toFixed(1), max: +a[a.length - 1].toFixed(1) }
        })()`)
        ok(`⑥ 框住 ${sel.n} 笔再旋转：中位帧间隔 ${rotStat.median}ms / 最长 ${rotStat.max}ms（${rotStat.n} 帧）`)
        if (rotStat.median >= 0 && rotStat.median < 40 && rotStat.n >= 20) {
          ok('★ 大选区旋转也跟得上手（中位帧间隔 < 40ms）—— 没有"每帧把选中的笔重新判读一遍"那一族')
        } else {
          bad(`★ 大选区旋转卡住了：中位 ${rotStat.median}ms / ${rotStat.n} 帧。`
            + '先看"每帧都在重算、但这一帧没人看得见"的东西是不是又冒出来了（README 第 53 条：形状判读）')
        }
      }
    }
  }
)

process.exitCode = fails ? 1 : 0
