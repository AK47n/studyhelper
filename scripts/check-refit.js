/* 卡片「按内容量尺寸」的**行为**对手盘（真浏览器）。
 *
 * 两条它管、别的自检管不了的事：
 *   ① 载入时卡片贴合内容，**不为"盖住底下那几笔手写"撑大** ——
 *      夹具里那张卡的 h 故意写成 140、底下还压着一横笔：
 *      贴合之后卡高（≈36 世界像素）必须远矮于那一笔的下沿。
 *   ② 板子安静下来之后会**再量一次**：双击把式子改短 → 回车 → 卡片自己收小，
 *      而且收进盘里（治的是"w/h 是文件里存着的旧测量值"这件事）。
 *
 * 为什么值得单独一条：这两条以前**只有手工**验过 —— 对手盘留在被 gitignore 的
 * `.cache/refit-test.mjs` 里，而且它拿**用户那张** `data/board-新白板.md` 当夹具、
 * 跑完再按备份还原（红线上的事：自检碰了用户的数据）。
 * 2026-09-16 架构 review 的 N2 把它收成正式自检：夹具自己造、走 withBoard。
 * 分工：**量尺寸的策略**（'stale' 那一趟 / 两条轴都稳 / 编辑态不量 / 门槛 …）
 * 在 check-board.js 的 [6l] 里纯逻辑断言；这里管**接线** —— 真的挂上 DOM、
 * 真的提交、真的落盘。两边都绿，才说明"框贴合内容"这件事整体没坏。
 *
 * 用法：node scripts/check-refit.js   （或 npm run check:refit）
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, newStroke, serializeBoardDocument } from '../src/lib/board.js'

const CARD_ID = 'refit-a'
const INK_DROP = 250 // 那一横笔放在卡片顶往下多少世界像素（比贴合后的卡高得多）

const fails = await withBoard(
  {
    tag: 'refit',
    port: 5209,
    cdpPort: 9239,
    make: () => {
      const b = newBoard('量尺寸自检夹具（跑完自动删除）')
      const card = {
        ...newCard('formula', 300, 240, { w: 260, h: 140 }),
        id: CARD_ID,
        /* 故意用一张**两行高**的式子当起点：改成 `a=b` 之后宽高都要收
           （只用 `E = mc^2` 的话高度本来就不变，那条"高度也收"就断言不出来）。 */
        src: '\\frac{B}{B_0} = \\mu_r',
        tex: '\\frac{B}{B_0} = \\mu_r',
        h: 140, // ← 故意撑大：这正是"文件里存着的过时测量值"
      }
      b.cards.push(card)
      /* 卡片底下压一横笔（世界坐标）。上一版"盖住"那套会为它把卡撑到 ≈400 高；
         现在只按内容量 —— 所以它还顺便证明"不再盖了"。 */
      const y = card.y + INK_DROP
      b.strokes.push(
        newStroke('pen', [card.x + 30, y, 0.5, card.x + card.w / 2, y + 6, 0.5, card.x + card.w - 40, y, 0.5], { width: 3 })
      )
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, board, open, read }) => {
    const sleep = (ms) => s.sleep(ms)

    const readCard = () =>
      s.eval(`(() => {
        const el = document.querySelector('[data-card-id="${CARD_ID}"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          minH: Math.round(parseFloat(getComputedStyle(el).minHeight)),
          fit: el.dataset.fit || null,
        }
      })()`)

    /* 等"量尺寸那几趟"真的停下来（它在后台跑：下一帧 + 150ms 一趟，最多 12 趟）。
       判据用**渲染出来的高度连续两次一样** —— 不是等一个固定毫秒数。 */
    const settle = async (rounds = 12) => {
      let prev = null
      for (let i = 0; i < rounds; i++) {
        const c = await readCard()
        if (c && prev && c.h === prev.h && c.w === prev.w) return c
        prev = c
        await sleep(400)
      }
      return await readCard()
    }

    await open()
    const loaded = await settle()
    if (!loaded) {
      bad('夹具那张卡没渲染出来 —— 后面的断言都没意义了')
      return
    }

    /* 视图缩放从"屏幕宽 ÷ 世界宽"量出来（卡片倍率是 1）—— 别拿夹具里的世界坐标猜。 */
    const card0 = (await read()).cards.find((c) => c.id === CARD_ID)
    const view = loaded.w / card0.w

    console.log('\n[1] 载入：卡片贴合内容，不为"盖住底下那一横笔"撑大')
    {
      const inkBottom = card0.y + INK_DROP + 6 + 1.5 - card0.y // 那一笔下沿相对卡片顶（世界像素）
      const worldH = Math.round((loaded.h / view) * 10) / 10
      console.log(`      卡 ${loaded.w}×${loaded.h}px（折算 ${worldH} 世界像素高；视图 ${view.toFixed(3)}）`)
      console.log(`      夹具：卡顶往下 ${INK_DROP} 世界像素处压着一横笔（下沿 ≈ ${inkBottom} 世界像素）`)
      if (worldH < inkBottom - 20) ok(`卡片没有为笔迹撑大（卡高 ${worldH} < 那一笔的下沿 ${inkBottom}）`)
      else bad(`卡片还是被"盖住"撑大了：卡高 ${worldH}，笔迹下沿 ${inkBottom}`)
      if (worldH < 140 - 20) ok(`文件里那个过时的 h=140 已经被重量收掉了（→ ${worldH}）`)
      else bad(`过时的 h=140 没收掉：屏幕上折算出来 ${worldH}`)

      const disk = (await read()).cards.find((c) => c.id === CARD_ID)
      if (Math.abs(disk.h - worldH) <= 6) ok(`盘上也跟着收成 h=${disk.h}（不是只在屏幕上收）`)
      else bad(`盘上 h=${disk.h}，屏幕上折算出来却是 ${worldH}`)
      console.log(`      卡片自报的这一趟：${loaded.fit || '(没有 dataset.fit)'}`)
    }

    console.log('\n[2] 改完内容 → 板子安静下来自己再量一次（并且落盘）')
    {
      const cx = loaded.left + Math.round(loaded.w / 2)
      const cy = loaded.top + Math.round(loaded.h / 2)
      for (const [type, clickCount, buttons] of [['mousePressed', 2, 1], ['mouseReleased', 2, 0]]) {
        await s.send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', buttons, clickCount })
      }
      await sleep(400)
      const editing = await s.eval(`!!document.querySelector('.bd-card-edit textarea')`)
      if (editing) ok('双击进了编辑态')
      else bad('双击没进编辑态 —— 后面"改内容"那一条验不了')

      await s.key('a', 'KeyA', 65) // 注意：Ctrl+A 要带修饰键，用 send 直接发
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await s.send('Input.insertText', { text: 'a=b' })
      await sleep(250)
      await s.key('Enter', 'Enter', 13)
      /* 停笔 400ms 防抖 → 重量两趟 → 700ms 存盘；等"盘上真的变了"而不是等固定毫秒数。 */
      let disk2 = null
      for (let i = 0; i < 20; i++) {
        await sleep(400)
        disk2 = (await read()).cards.find((c) => c.id === CARD_ID)
        if (disk2 && /a=b|a = b/.test(String(disk2.tex || disk2.src)) && disk2.h < card0.h - 5) break
      }
      const after = await settle(6)
      const worldH2 = Math.round((after.h / view) * 10) / 10
      console.log(`      改完：卡 ${loaded.w}×${loaded.h}px → ${after.w}×${after.h}px（折算 ${worldH2} 世界像素高）；盘上 w=${disk2.w} h=${disk2.h} tex=${JSON.stringify(disk2.tex || disk2.src)}`)
      if (/a=b|a = b/.test(String(disk2.tex || disk2.src))) ok('式子真的改到了（a=b）')
      else bad('式子没改成，后面那条"重新贴合"没意义：' + JSON.stringify(disk2.tex || disk2.src))
      if (after.w < loaded.w - 5 && after.h < loaded.h - 5) ok(`卡片跟着内容收小了（${loaded.w}×${loaded.h} → ${after.w}×${after.h}）`)
      else bad(`卡片没跟着内容收：${loaded.w}×${loaded.h} → ${after.w}×${after.h}`)
      if (disk2.w < card0.w - 5 && disk2.h < card0.h - 5) ok(`盘上也收小了（w ${card0.w}→${disk2.w}，h ${card0.h}→${disk2.h}）`)
      else bad(`盘上没收小：w ${card0.w}→${disk2.w}，h ${card0.h}→${disk2.h}`)
      /* 最后一条是**跨层**的：屏幕上量到的和盘上写着的必须是同一个数
         （少了它，"屏幕收了但盘上没写"和"盘上写了但屏幕没跟"都会看起来是对的）。 */
      if (Math.abs(disk2.h - worldH2) <= 6) ok(`屏幕上量到的和盘上写的对得上（${worldH2} ≈ ${disk2.h}）`)
      else bad(`屏幕和盘上对不上：屏幕折算 ${worldH2}，盘上 h=${disk2.h}`)
    }

    console.log('\n[3] 页面里不许有 JS 报错')
    if (!s.errors().length) ok('整个流程跑下来，页面里没有任何 JS 报错')
    else bad(`页面里有 ${s.errors().length} 条报错：` + s.errors().slice(0, 3).join(' ｜ '))

    /* 夹具板的名字归 withBoard 管（跑完删）；这里只是把"它确实是自检自己造的"说清楚 */
    if (/board-zz-refit\.md$/.test(board.path)) ok('夹具板是自检自己造的：' + board.name)
  }
)

void fails
