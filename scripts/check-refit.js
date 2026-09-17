/* 卡片「按内容量尺寸」的**行为**对手盘（真浏览器）。
 *
 * 三条它管、别的自检管不了的事：
 *   ① 载入时卡片贴合内容，**不为"盖住底下那几笔手写"撑大** ——
 *      夹具里那张卡的 h 故意写成 140、底下还压着一横笔：
 *      贴合之后卡高（≈36 世界像素）必须远矮于那一笔的下沿。
 *   ② 板子安静下来之后会**再量一次**：双击把式子改短 → 回车 → 卡片自己收小，
 *      而且收进盘里（治的是"w/h 是文件里存着的旧测量值"这件事）。
 *   ③ ★ 往小缩放时卡片不许把内容挤到溢出（2026-09-17 加的）。
 *      "贴合内容"这件事只在**量尺那一档缩放**上被量过一次，而卡片会被缩到别的档：
 *      谁把"屏幕像素的量"（边框、固定像素的圈）混进世界像素的 w 里，
 *      越往小缩内容盒就越窄，`overflow-x: auto` 当场换来一条 12px 的滚动条 ——
 *      用户看到的是「卡片底下一条恒粗黑线」，而**这一整套真浏览器自检都看不见它**
 *      （它们带着 --hide-scrollbars）。所以第 ③ 条的判据是**几何**，不是"看不看得见"。
 *
 * 为什么值得单独一条：这三条以前**只有手工**验过 —— 对手盘留在被 gitignore 的
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
  async ({ s, ok, bad, board, open, read, untilFile }) => {
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
      /* 停笔 400ms 防抖 → 重量两趟 → 700ms 存盘；等的是**盘上真的变了**这个事实，
         不是"睡 20 次 × 400ms"。判据现在走那道门上的 ctx.untilFile（见 board-check.js，
         为什么别猜毫秒数：README 第 38 条）。 */
      const wDisk2 = await untilFile(
        (d) => {
          const c = (d.cards || []).find((x) => x.id === CARD_ID)
          return c && /a=b|a = b/.test(String(c.tex || c.src)) && c.h < card0.h - 5 ? c : undefined
        },
        { timeout: 9000, what: '盘上那张卡改成 a=b 而且收小了' }
      )
      if (!wDisk2.ok) bad(`等了 ${wDisk2.waited}ms，盘上那张卡一直没改成 a=b 且收小 —— 下面几条都要拿它当真`)
      /* ⚠ untilFile 的 value 是**那时候的板文档**（不是谓词返回的那个卡片）—— 自己绊过一次。 */
      const disk2 = ((wDisk2.value || (await read())) || { cards: [] }).cards.find((c) => c.id === CARD_ID)
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

    console.log('\n[3] ★ 往小缩放：卡片不许把内容挤到溢出（"缩小画布时卡片底下一根恒粗黑线"那一族）')
    /* 为什么单独一条（2026-09-17 用户报的「公式卡片下面在我缩小画布的时候有一条恒粗黑线」）：
       卡片那一圈如果是 **border**，它就是"屏幕像素"，而卡片的 `w` 是"世界像素" ——
       量尺寸时被读进 padX 除了一次 s、渲染时却不跟着缩（字号/内边距/圆角都跟着缩），
       于是越往小缩，内容盒比内容窄 `边框总宽 × (1 − s/s0)`（s0 = 上次量尺寸那一档）。
       `.bd-tex` 是 `overflow-x: auto`（溢出一点都不放过），全局那条
       `::-webkit-scrollbar { height: 12px }` 又不跟缩放走 —— 屏幕上就是一根恒粗黑线，
       还白占 12px 布局高度。现在卡片那圈是 `outline`（不进布局），缺口恒为 0。

       ★★ 判据必须是**几何**（`scrollWidth > clientWidth`、以及"卡片给内容留的位置够不够"），
          绝不能是"看不看得见"：自检的浏览器带着 `--hide-scrollbars`
          （scripts/lib/browser.js 的 headlessArgs）—— 滚动条类的东西在这儿天生看不见，
          同一份夹具带上那个参数，溢出照样是 1~2px 而横条恒为 0。
          那根黑线就是这么从这一整套真浏览器自检底下溜过去的。
       ★ 缩放必须**真的变小**（读 canvas 记下的变换反推），否则"什么都没发生"也会绿。 */
    const readFit = () =>
      s.eval(`(() => {
        const card = document.querySelector('[data-card-id="${CARD_ID}"]')
        if (!card) return null
        const cs = getComputedStyle(card)
        const body = card.querySelector('.bd-card-body')
        const tex = card.querySelector('.bd-tex')
        /* 内容的**自然宽度**：用应用自己那一招（临时放开成 max-content，同一帧里读回）。 */
        const prev = body.style.width
        body.style.width = 'max-content'
        const natW = body.getBoundingClientRect().width
        body.style.width = prev
        const ink = document.querySelector('canvas.bd-ink')
        const xf = ((ink && ink.dataset.xform) || '').split(',').map(Number)
        return {
          s: xf[0] / devicePixelRatio,
          cardW: card.getBoundingClientRect().width,
          padX:
            parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
            parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth),
          natW,
          spill: tex ? tex.scrollWidth - tex.clientWidth : 0,
          barH: tex ? tex.offsetHeight - tex.clientHeight : 0,
        }
      })()`)

    /* 点工具条上那颗按钮 —— 用**真鼠标**，顺带证明"缩小画布"这个入口真的点得到
       （合成 click 只能证明处理器写得对）。 */
    const clickZoom = async (titlePrefix) => {
      const box = await s.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith(${JSON.stringify(titlePrefix)}))
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!box) return false
      await s.mouse(box.x, box.y)
      return true
    }

    {
      const steps = []
      const first = await readFit()
      if (!first) {
        bad('缩放那一趟读不到夹具那张卡 —— 后面的断言都没意义了')
      } else {
        for (let i = 0; i < 6; i++) {
          if (!(await clickZoom('画布缩小'))) {
            bad('工具条上找不到「画布缩小」那颗按钮')
            break
          }
          await sleep(500)
          const r = await readFit()
          if (r) steps.push(r)
        }
        /* 再往大缩两档回来一点：溢出这门账**两个方向**都要算
           （只往小缩的话，"宽度永远多给一点"那种错会漏掉）。 */
        for (let i = 0; i < 2; i++) {
          if (!(await clickZoom('画布放大'))) break
          await sleep(500)
          const r = await readFit()
          if (r) steps.push(r)
        }

        console.log('      缩放     卡宽    内容自然宽  内边距边框  给内容留的位子  溢出  横条占高')
        for (const r of steps) {
          console.log(
            '      ' + r.s.toFixed(3).padEnd(9) + r.cardW.toFixed(1).padEnd(8) + r.natW.toFixed(1).padEnd(12) +
            r.padX.toFixed(1).padEnd(12) + (r.cardW - r.padX).toFixed(1).padEnd(16) + String(r.spill).padEnd(6) + r.barH
          )
        }

        /* ★ 缩放必须真的变小过 —— 判据取**扫过的最小那一档**（后面那两档是缩回来的，
           拿最后一档比就是自己骗自己："什么都没发生"也会绿）。 */
        const minS = Math.min(...steps.map((r) => r.s))
        if (first.s > 0 && minS <= first.s * 0.45) ok(`缩放真的缩下去了（${first.s.toFixed(3)} → 最小 ${minS.toFixed(3)} = 量尺那一档的 ${((minS / first.s) * 100).toFixed(0)}%）`)
        else bad(`缩放没真的变小（${first.s.toFixed(3)} → 最小 ${Number.isFinite(minS) ? minS.toFixed(3) : '(没读到)'}）—— "什么都没发生"也会绿，这条必须先成立`)

        /* ① 根上的性质：卡片给内容留的位置**永远不许比内容窄**。
              留窄了就是"屏幕像素的圈混进了世界像素的宽"（那根黑线的根）。 */
        const tight = steps.filter((r) => r.natW > r.cardW - r.padX + 0.5)
        if (!tight.length) ok(`每一档缩放都给内容留够了位子（${steps.length} 档，最紧的一档还多 ${Math.min(...steps.map((r) => (r.cardW - r.padX) - r.natW)).toFixed(2)}px）`)
        else bad(
          `${tight.length}/${steps.length} 档缩放把内容挤窄了：` +
          tight.map((r) => `s=${r.s.toFixed(3)} 缺 ${(r.natW - (r.cardW - r.padX)).toFixed(2)}px`).join('；') +
          ' —— 缺口 = 圈的总宽 × (1 − s/s0)：别让"屏幕像素的圈"再参与布局（见 styles.css 的 .bd-card）'
        )

        /* ② 看得见的后果：内容溢出（真浏览器里就是那根恒粗黑线）。
              ⚠ 自检带 --hide-scrollbars，所以这里断言的是**几何**，不是"有没有条"。 */
        const spilled = steps.filter((r) => r.spill > 0)
        if (!spilled.length) ok(`每一档缩放都不溢出（scrollWidth ≤ clientWidth）—— 换到不带 --hide-scrollbars 的浏览器里也不会冒那条黑线`)
        else bad(
          `${spilled.length}/${steps.length} 档缩放溢出了：` +
          spilled.map((r) => `s=${r.s.toFixed(3)} 溢出 ${r.spill}px`).join('；') +
          ' —— `overflow-x: auto` 会把它变成一条 12px 的滚动条（还占 12px 撑高卡片）'
        )

        const barred = steps.filter((r) => r.barH > 0)
        if (!barred.length) ok('没有一档缩放出现横向滚动条占高（offsetHeight == clientHeight）')
        /* 这条在本机自检里**弱**：--hide-scrollbars 让滚动条不占位。留着是为了
           谁哪天把这个参数去掉（或换浏览器）时它还能说话 —— 上面那条几何断言才是主判据。 */
        else bad(`有 ${barred.length} 档出现了横向滚动条占高：` + barred.map((r) => `s=${r.s.toFixed(3)} 占 ${r.barH}px`).join('；'))
      }
    }

    console.log('\n[4] 页面里不许有 JS 报错')
    if (!s.errors().length) ok('整个流程跑下来，页面里没有任何 JS 报错')
    else bad(`页面里有 ${s.errors().length} 条报错：` + s.errors().slice(0, 3).join(' ｜ '))

    /* 夹具板的名字归 withBoard 管（跑完删）；这里只是把"它确实是自检自己造的"说清楚 */
    if (/board-zz-refit\.md$/.test(board.path)) ok('夹具板是自检自己造的：' + board.name)
  }
)

void fails
