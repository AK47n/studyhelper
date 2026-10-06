/* check-plot-browser：白色这块浮窗在**真浏览器**里跑一遍。
 *
 * 为什么不只靠 check-plot（那条纯逻辑的）：那里证明了"算出来的点对"，
 * 证明不了"点真的画到了屏幕上、鼠标真的读得到数"。
 * 具体说，只有这里能验这五件事：
 *   ① 公式卡上那颗「=」点得到（它是 tooltip 之外最容易被卡层级盖住的东西）
 *   ② SVG 里的 `<path d>` 真的有内容、不是 NaN
 *   ③ 曲线**真的有起伏** —— 一条 NaN 全挂掉的 path 也"存在"，肉眼才分得出
 *   ④ 鼠标停在图上读出来的数和这条式子对得上（x² 在图 75% 处必须读到 ≈ x²）
 *   ⑤ 面板里的操作不会把卡片拖走（`onPointerDown` 那条 stopPropagation 要是漏了，
 *      按在输入框上就是"开始拖这张卡" —— 这条只能在真鼠标下复现）
 *   ⑥ `1/x` 那种有渐近线的式子，界面上真的提示了"按断开了画"
 *
 * 用法：node scripts/check-plot-browser.js
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'
import { toTex } from '../src/lib/formula.js'

/* 四张公式卡：一条完整的、一条振荡的、一条有渐近线的、一条有洞的。 */
const SRC = ['x^2', 'sin(x)', '1/x', 'sqrt(x)']

const fails = await withBoard(
  {
    tag: 'plotcheck',
    port: 5245,
    cdpPort: 9285,
    make: () => {
      const b = newBoard('自检夹具（跑完自动删除）')
      /* ⚠ `newCard` 只吃 w/h，**其它字段一概不进**（它返回的是一个写死的对象）。
         src 没给的话卡片是空的 —— 空的自然没有那颗「=」，报出来的话却像是按钮坏了。 */
      b.cards = SRC.map((src, i) => {
        const c = newCard('formula', 300 + (i % 2) * 460, 240 + Math.floor(i / 2) * 320, { w: 300, h: 120 })
        c.src = src
        c.tex = toTex(src)
        return c
      })
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, open, until }) => {
    await open()

    /* ── [1] 四张公式卡都挂上了 ── */
    const w1 = await until(
      async () => {
        const n = await s.eval(`document.querySelectorAll('.bd-card[data-card-kind="formula"]').length`)
        return n === SRC.length ? n : 0
      },
      { what: `${SRC.length} 张公式卡挂上来`, timeout: 10000 },
    )
    if (!w1.ok) {
      bad(`我没等到 ${SRC.length} 张公式卡（只看到 ${w1.value || 0} 张）`)
      return
    }
    ok(`${SRC.length} 张公式卡挂上来了`)

    const nth = (sel, i) => `document.querySelectorAll(${JSON.stringify(sel)})[${i}]`
    const rectOf = (sel, i) =>
      s.eval(`(() => { const el = ${nth(sel, i)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)

    /** 点哪张卡、打开它的「=」面板。每一步都用 elementFromPoint 验"点得到"。 */
    async function openPanel(i, want = 'x^2') {
      /* 先把可能开着的浮窗收掉（Esc = 收起，就在 <Calc> 的 onKeyDown 上）：
         它挂在卡片里、有 400px 高，会盖住下面那张卡 —— 那不是 bug 是布局，
         但它会让"点到第 i 张卡"这件事变得没有意义。 */
      await s.key('Escape')
      await s.sleep(200)
      const r = await rectOf(CardSel, i)
      if (!r || !r.w) {
        bad(`第 ${i + 1} 张卡拿不到尺寸（${want}）`)
        return false
      }
      const cx = Math.round(r.x + r.w / 2)
      const cy = Math.round(r.y + r.h / 2)
      /* ★ 判据收紧到"这一下必须落在**第 i 张**卡身上"：
         面板 `.bd-calc` 是**挂在卡片 DOM 里面**的（这是设计，位置才跟着卡片走），
         所以"命中链上有 .bd-card"这条太松 —— 落在上一张卡的面板上也算通过，
         于是这一下点的是别人的浮窗，报出来的却是"第 i 张卡点得到"。 */
      const onCard = await s.eval(
        `(() => { const card = ${nth(CardSel, i)}; const el = document.elementFromPoint(${cx}, ${cy}); return !!(card && el && (card === el || card.contains(el))) })()`,
      )
      if (!onCard) {
        bad(`第 ${i + 1} 张卡的中心点不到（${want}）—— 多半被上一张卡的浮窗盖住了`)
        return false
      }
      await s.mouse(cx, cy) // 单击 = 选中，不是拖（没有 move）
      const wb = await until(async () => {
        const n = await s.eval(`document.querySelectorAll('[data-card-calc]').length`)
        return n === 1 ? n : 0
      }, { what: '「=」按钮冒出来', timeout: 4000 })
      if (!wb.ok) {
        bad(`选中了但「=」按钮没出来（${want}）`)
        return false
      }
      const b = await rectOf('[data-card-calc]', 0)
      const bx = Math.round(b.x + b.w / 2)
      const by = Math.round(b.y + b.h / 2)
      const onBtn = await s.eval(
        `(() => { const el = document.elementFromPoint(${bx}, ${by}); return !!(el && el.closest('[data-card-calc]')) })()`,
      )
      if (!onBtn) {
        bad(`「=」那颗按钮点不到（${want}）`)
        return false
      }
      await s.mouse(bx, by)
      const wp = await until(async () => {
        const n = await s.eval(`document.querySelectorAll('[data-plot="1"]').length`)
        return n === 1 ? n : 0
      }, { what: '图画出来了', timeout: 4000 })
      if (!wp.ok) {
        bad(`面板开了但图没出来（${want}）`)
        return false
      }
      return true
    }

    const CardSel = '.bd-card[data-card-kind="formula"]'
    /* 卡片**现在**在哪 —— 最后要拿它和这一份对比，证明"这一通操作没把卡片拖走"。 */
    const posBefore = []
    for (let i = 0; i < SRC.length; i += 1) posBefore.push(await rectOf(CardSel, i))

    /* ── [2] 每打开一张卡，图上都要有一条真的曲线 ── */
    for (let i = 0; i < SRC.length; i += 1) {
      const src = SRC[i]
      if (!(await openPanel(i, src))) continue
      const d = await s.eval(`(() => { const p = document.querySelector('[data-plot-line="0"]'); return p ? p.getAttribute('d') : null })()`)
      if (!d) {
        bad(`${src}：图上没有任何一条 Path`)
        continue
      }
      if (/NaN|Infinity|undefined/.test(d)) {
        bad(`${src}：path 里有 NaN（整条 SVG 会静默消失）`)
        continue
      }
      const shapes = await s.eval(
        `(() => {
          const ps = [...document.querySelectorAll('[data-plot-line]')]
          let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, n = 0
          for (const p of ps) {
            const bb = p.getBBox()
            if (!bb.width && !bb.height) continue
            minY = Math.min(minY, bb.y); maxY = Math.max(maxY, bb.y + bb.height)
            minX = Math.min(minX, bb.x); maxX = Math.max(maxX, bb.x + bb.width)
            n += 1
          }
          return { n, minY, maxY, minX, maxX }
        })()`,
      )
      const spanY = shapes.maxY - shapes.minY
      const spanX = shapes.maxX - shapes.minX
      if (spanY < 8) {
        bad(`${src}：曲线几乎是平的（纵向只占 ${spanY.toFixed(1)}px）—— 多半是整条掉成了同一个值`)
        continue
      }
      if (spanX < 100) {
        bad(`${src}：曲线没铺开（横向只有 ${spanX.toFixed(1)}px）`)
        continue
      }
      ok(`${src}：画出了 ${shapes.n} 条线，占 ${spanX.toFixed(0)}×${spanY.toFixed(0)}px`)
    }

    /* ── [3] ★ 鼠标停在图中央，读出来的数必须和这条式子对得上 ── */
    if (await openPanel(0, 'x^2（读值）')) {
      const r = await rectOf('[data-plot="1"]', 0)
      const hx = Math.round(r.x + r.w * 0.75)
      const hy = Math.round(r.y + r.h * 0.5)
      await s.hover(hx, hy)
      const read = await until(async () => {
        const t = await s.eval(`(() => { const el = document.querySelector('[data-plot-read]'); return el ? el.textContent : null })()`)
        return t && /→/.test(t) ? t : 0
      }, { what: '鼠标读数出现', timeout: 4000 })
      if (!read.ok) {
        bad('鼠标停在图上没有读出数')
      } else {
        const [xs, ys] = read.value.split('→').map((t) => Number(t.trim()))
        const want = xs * xs
        const err = want === 0 ? Math.abs(ys) : Math.abs(ys - want) / Math.abs(want)
        if (err < 0.08) ok(`读到 x=${xs} 那里 y=${ys}，和 x² = ${want.toFixed(2)} 对得上`)
        else bad(`读到 x=${xs} → y=${ys}，但 x² 该是 ${want.toFixed(2)}（差 ${(err * 100).toFixed(0)}%）`)
      }
    }

    /* ── [5] 有渐近线的式子要说清楚"那是断开画的" ── */
    if (await openPanel(2, '1/x')) {
      const note = await s.eval(`(() => { const el = document.querySelector('[data-plot-note="cuts"]'); return el ? el.textContent : null })()`)
      if (note) ok(`1/x 明说了「${note.trim().slice(0, 14)}…」`)
      else bad('1/x 没有提示"那是断开画的"（渐近线会被看成一条竖线）')
    }

    /* ── [6] 手填一段区间：sqrt(x) 在负数那边要有"算不出来"的提示 ── */
    if (await openPanel(3, 'sqrt(x)')) {
      await s.eval(`(() => { const el = document.querySelector('[data-plot-from]'); el.focus(); el.select?.() })()`)
      for (const ch of ['-', '1', '0']) await s.key(ch)
      const wmiss = await until(async () => {
        const n = await s.eval(`document.querySelectorAll('[data-plot-note="missing"]').length`)
        return n === 1 ? n : 0
      }, { what: '「这一段算不出来」的提示', timeout: 5000 })
      if (wmiss.ok) {
        const t = await s.eval(`document.querySelector('[data-plot-note="missing"]').textContent.trim()`)
        ok(`手填 -10 之后它说「${t.slice(0, 22)}…」`)
      } else {
        bad('把区间改成 -10 起步，没有出现"算不出来"的提示')
      }
    }

    /* ── [7] 这一通点来点去，没有哪张卡被单独挪动过 ──
     *
     * ★ 判据是**卡片之间的相对位置**，不是"屏幕坐标没变"。为什么必须是相对的：
     *   聚焦面板里的输入框时，浏览器会**把这个框滚进视野**（面板朝下展开四百多像素，
     *   它常常在屏幕外很远的地方）—— 于是整个纸面滚一段，四张卡的屏幕坐标一起变。
     *   那是浏览器的善意（不然要填的框在屏幕外），而且它的副作用是一次**整体**平移。
     *   我们真正要抓的是"按在输入框上把**某一张**卡拖走了" ——
     *   那会改动这张卡和其它卡的相对位置，掩不到相对判据底下。
     *   （这条是实测撞出来的：绝对坐标那一版被一次正常的滚动判成失败，报了个假红。） */
    {
      const now = []
      for (let i = 0; i < SRC.length; i += 1) now.push(await rectOf(CardSel, i))
      let worst = 0
      const detail = []
      for (let i = 1; i < SRC.length; i += 1) {
        if (!now[i] || !now[0] || !posBefore[i] || !posBefore[0]) continue
        const dx0 = posBefore[i].x - posBefore[0].x
        const dy0 = posBefore[i].y - posBefore[0].y
        const dx1 = now[i].x - now[0].x
        const dy1 = now[i].y - now[0].y
        const d = Math.max(Math.abs(dx1 - dx0), Math.abs(dy1 - dy0))
        worst = Math.max(worst, d)
        if (d > 1) detail.push(`${SRC[i]} 挪了 ${d.toFixed(0)}px`)
      }
      if (worst <= 1) ok('这一通操作没有哪张卡被单独拖走（面板没偷走拖拽手势）')
      else bad(`有卡片相对别的位置变了：${detail.join('，')} —— 面板里的 stopPropagation 漏了`)
    }
  },
)

process.exitCode = fails ? 1 : 0
