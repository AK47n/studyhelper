/* 公式架的**真浏览器**体检 —— 用户原话（2026-09-20）：
 *
 *   「加个功能让已经识别一次的公式卡放置在某个便于去用的地方，白板的其他地方要用到
 *     这个公式卡的时候便于直接使用，因为一次课往往会多次用到同样的公式」
 *
 * 纯逻辑那一半在 check-board 的 [19]（谁上架 / 怎么去重 / 什么顺序），
 * 这个脚本验的是**接上去之后还成立吗** —— 而这一半只有真浏览器能验：
 *   · 「点一下放到眼前」和「拖到板上指哪放哪」是**两种指针手势**，
 *     判据只有"手指/笔动了没有"（4px）——合成事件绕不过去，也证明不了"用户做得出来"；
 *   · 拖的时候那张影子卡如果接走了 pointerup，症状是"拖了半天一松手什么都没发生"——
 *     这条只有真拖一遍才看得见（`pointer-events: none` 是它的解药）；
 *   · 架子是**推出来的**（板上有哪些公式卡），所以"删掉一张卡、架子跟着少一格"
 *     必须真的删一次才算数。
 *
 * ── 这个脚本要盯住的六件事 ────────────────────────────────────────────────
 *   [1] 工具条上那颗「∑ 公式架」看得见、点得到；**默认收起**。
 *   [2] 点开之后：**同一条公式只占一格**（两处 → 一格 + ×2），顺序跟板面一致。
 *   [3] 点一格 → 板上多一张**独立的新卡**：tex 一样、id 是新的、落在**眼前**（视野中心附近）、
 *       而且**当场选中**（能接着拖走）。
 *   [4] Ctrl+Z **一步**撤回（复用"一次手势 = 一步撤销"那条账，不为它单开一条）。
 *   [5] 拖一格到画布另一处 → 落在**松手的地方**（不是视野中心）。
 *   [6] 把公式卡删掉 → 架子**跟着变**（它是推出来的）；空的时候点按钮**不打开**，
 *       而是回一句人话（和「✨ 美化手写」同一条规矩：不做成灰按钮）。
 *
 * 跑：npm run check:shelf
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

/* ── 夹具 ─────────────────────────────────────────────────────────────────
   三条公式、其中**两条一模一样**（正是"一次课里同一个公式写好几遍"的样子），
   外加一张文字卡（它**不该**上架）。
   ⚠ 卡片上下摊开：架子按板面顺序排，摊开了顺序才是确定的、可断言的。
   ⚠ 名字必须是 board-zz-*（withBoard 造、withBoard 删，见 LEGAL_FIXTURE）。 */
const F1 = '\\oint \\vec{B}\\cdot d\\vec{l} = \\mu_0 I'
const F2 = 'E = mc^2'

const fixture = (() => {
  const b = newBoard('自检夹具（公式架，跑完自动删除）')
  const add = (kind, cy, extra) => {
    const c = newCard(kind, 200, cy, { w: 220, h: 56 })
    Object.assign(c, extra)
    b.cards.push(c)
    return c
  }
  add('formula', 100, { src: F1, tex: F1 })
  add('formula', 400, { src: F1, tex: F1 }) // 同一条，写在别处
  add('formula', 700, { src: F2, tex: F2 })
  add('note', 1000, { text: '文字卡不上架' })
  return b
})()

const fails = await withBoard(
  /* 端口一套独占的（现役清单见 check-clip.js 顶部那段）。别跟别的自检串。 */
  { tag: 'shelf', port: 5227, cdpPort: 9267, text: serializeBoardDocument(fixture) },
  async ({ s, ok, bad, open, until, untilSaved, read }) => {
    const ev = (x) => s.eval(x)

    /* ── 页面侧读数：只读数，断言在下面明面上 ───────────────────────────── */
    const injectReader = () =>
      ev(`(() => {
      window.__shelf = {
        /* 架子在不在、有几格、每格写的是什么、角标写的是什么 */
        shelf() {
          const el = document.querySelector('.bd-shelf')
          if (!el) return null
          const chips = [...el.querySelectorAll('[data-shelf-chip]')]
          return {
            n: chips.length,
            tex: chips.map((c) => c.getAttribute('data-shelf-tex') || ''),
            badge: chips.map((c) => { const b = c.querySelector('.bd-shelf-n'); return b ? b.textContent.trim() : '' }),
            box: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })(),
          }
        },
        /* 工具条那颗按钮的位置（要真点它） */
        btn() {
          const b = document.querySelector('[data-tool="shelf"]')
          if (!b) return null
          const r = b.getBoundingClientRect()
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
          return {
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
            label: (b.textContent || '').trim(),
            hitSelf: !!(hit && hit.closest('[data-tool="shelf"]')),
          }
        },
        /* 第 i 格的中心（要真点/真拖它） */
        chip(i) {
          const c = document.querySelectorAll('[data-shelf-chip]')[i]
          if (!c) return null
          const r = c.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        },
        /* 卡片的**屏幕**矩形（"落点在不在眼前"只能拿屏幕说话）+ 舞台矩形 */
        cards() {
          const st = document.querySelector('.bd-stagewrap')
          const sr = st ? st.getBoundingClientRect() : null
          return {
            n: document.querySelectorAll('.bd-card').length,
            sel: document.querySelectorAll('.bd-card.on').length,
            stage: sr ? { cx: Math.round(sr.left + sr.width / 2), cy: Math.round(sr.top + sr.height / 2), left: Math.round(sr.left), top: Math.round(sr.top), right: Math.round(sr.right), bottom: Math.round(sr.bottom) } : null,
            list: [...document.querySelectorAll('.bd-card')].map((c) => {
              const r = c.getBoundingClientRect()
              return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }
            }),
          }
        },
        /* 提示条说了什么（"空着"那句人话的证据） */
        toast() { const t = document.querySelector('.toast-msg'); return t ? t.textContent.trim() : '' },
      }
      return true
    })()`)

    await open()
    await injectReader()

    /* ── [1] 入口在、默认收起 ───────────────────────────────────────────── */
    const b0 = await until(() => ev(`window.__shelf.btn()`), { what: '「∑ 公式架」那颗按钮' })
    if (b0.ok && b0.value && b0.value.hitSelf) ok(`「∑ 公式架」点得到（${b0.value.label}）`)
    else bad('「∑ 公式架」看不见 / 被别的层盖住了：' + JSON.stringify(b0.value))
    if (b0.value && /2/.test(b0.value.label)) ok('★ 按钮上直接写着这张板上有几条公式（2）')
    else bad('按钮上没报条数：' + JSON.stringify(b0.value && b0.value.label))
    if ((await ev(`window.__shelf.shelf()`)) === null) ok('★ 默认**收起**（不点它就不占画布）')
    else bad('架子默认就开着 —— 它会白白吃掉一条画布高度')

    /* ── [2] 点开：同一条公式只占一格 ───────────────────────────────────── */
    await s.mouse(b0.value.x, b0.value.y)
    const sh = await until(() => ev(`window.__shelf.shelf()`), { what: '架子展开' })
    if (sh.ok) ok('点一下展开了')
    else bad('点了没展开')
    const shv = sh.value || { n: 0, tex: [], badge: [] }
    if (shv.n === 2) ok('★ 三条公式卡 → **两格**（同一条公式只占一格）')
    else bad(`格子数不对：${shv.n}（期望 2）`)
    if (shv.badge[0] === '×2') ok('★ 重复的那条带着 ×2 角标')
    else bad('角标不对：' + JSON.stringify(shv.badge))
    /* 顺序跟板面一致：第一条（y=100）在前。 */
    if (shv.tex[0] === F1 && shv.tex[1] === F2) ok('★ 顺序跟板面一致（上面的在前）')
    else bad('顺序不对：' + JSON.stringify(shv.tex))
    if (!shv.tex.some((t) => /文字卡/.test(t))) ok('文字卡不上架')
    else bad('文字卡跑到架子上去了')

    /* ★ F 键开合 —— 但 **Ctrl+F 不许被抢**（那是浏览器自己的"查找"）。
       两条一起验：不按 mod 的 F 要能开合；带 mod 的 F 不能把架子关掉。 */
    await s.key('f', 'KeyF', 70)
    const byKey = await until(() => ev(`window.__shelf.shelf() === null`), { timeout: 2000, what: 'F 把架子收起来' })
    if (byKey.ok) ok('★ 按 F 能开合（不用去点工具条）')
    else bad('按 F 没反应')
    await s.key('f', 'KeyF', 70)
    await until(() => ev(`window.__shelf.shelf() !== null`), { timeout: 2000, what: '再按 F 展开' })
    const pressCtrlF = async () => {
      const mod = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 }
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...mod })
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 })
      await s.send('Input.dispatchKeyEvent', { type: 'char', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2, text: 'f', unmodifiedText: 'f' })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...mod, modifiers: 0 })
      await s.sleep(300)
    }
    await pressCtrlF()
    if ((await ev(`window.__shelf.shelf()`)) !== null) ok('★ Ctrl+F 没被抢（架子没被它关掉）—— 那是浏览器自己的"查找"')
    else bad('Ctrl+F 把架子关了 —— 抢了浏览器自己的查找')

    /* 存一张截图：架子的**长相**（格子、角标、和工具条的关系）只有看一眼才知道对不对。
       位置跟着别的自检的惯例走（.cache/ 下，名字写明是什么）。 */
    await s.sleep(200)
    const shot = await s.send('Page.captureScreenshot', { format: 'png' })
    const fs = await import('node:fs')
    const path = await import('node:path')
    const shotPath = path.join(process.cwd(), '.cache', 'shelf-shot.png')
    fs.mkdirSync(path.dirname(shotPath), { recursive: true })
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    ok('截图存到 .cache/shelf-shot.png（架子的长相，可以自己看一眼）')

    /* ── [3] 点一格 → 眼前多一张独立的新卡 ─────────────────────────────── */
    const before = read()
    const idsBefore = new Set(before.cards.map((c) => c.id))
    const c0 = await ev(`window.__shelf.chip(0)`)
    await s.mouse(c0.x, c0.y)
    const added = await until(() => {
      const d = read()
      return d && d.cards.length === before.cards.length + 1 ? d : undefined
    }, { what: '板上多了一张卡（存盘落地）' })
    if (added.ok) ok('★ 点一格 → 板上真的多了一张卡')
    else bad('点了没多出卡来')
    const fresh = added.ok ? added.value.cards.find((c) => !idsBefore.has(c.id)) : null
    if (fresh && fresh.tex === F1) ok('★ 新卡的式子就是那条公式（tex 一字不差）')
    else bad('新卡的 tex 不对：' + JSON.stringify(fresh && fresh.tex))
    if (fresh && fresh.kind === 'formula') ok('是一张**公式卡**（不是便签）')
    else bad('放下来的不是公式卡：' + JSON.stringify(fresh && fresh.kind))
    const seen = await until(() => {
      const st = ev(`window.__shelf.cards()`)
      return st
    }, { what: '读数' })
    const cs = await ev(`window.__shelf.cards()`)
    if (cs.sel === 1) ok('★ 放下来就**选中**了（能接着拖走 / 缩放手柄就在手边）')
    else bad(`选中数不对：${cs.sel}`)
    const last = cs.list[cs.list.length - 1]
    /* x 判得紧、y 判得松：`fitter` 随后按宽度量一次尺寸，`keepCenterX` 保住横向中心，
       而高度变了 y 中心会跟着挪半个差值 —— 那不是"没落在眼前"，是卡片自己在收边。 */
    if (Math.abs(last.cx - cs.stage.cx) < 30) ok(`★ 落在**眼前**（横向离舞台中心 ${Math.abs(last.cx - cs.stage.cx)}px）`)
    else bad(`落点偏了：卡中心 x=${last.cx}，舞台中心 x=${cs.stage.cx}`)
    if (Math.abs(last.cy - cs.stage.cy) < 140) ok('纵向也在舞台中心一带')
    else bad(`纵向落点偏了：卡中心 y=${last.cy}，舞台中心 y=${cs.stage.cy}`)

    /* ── [4] Ctrl+Z 一步撤回 ────────────────────────────────────────────── */
    const pressCtrlZ = async () => {
      const mod = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 }
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...mod })
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
      await s.send('Input.dispatchKeyEvent', { type: 'char', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2, text: 'z', unmodifiedText: 'z' })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...mod, modifiers: 0 })
      await s.sleep(300)
    }
    await pressCtrlZ()
    const undone = await until(() => {
      const d = read()
      return d && d.cards.length === before.cards.length ? d : undefined
    }, { what: '撤销之后卡回去了' })
    if (undone.ok) ok('★ Ctrl+Z **一步**就退回去了（一次取用 = 一步撤销）')
    else bad('撤销没退掉这张卡')

    /* ── [5] 拖一格 → 落在松手的地方 ───────────────────────────────────── */
    const cs2 = await ev(`window.__shelf.cards()`)
    const c1 = await ev(`window.__shelf.chip(1)`)
    /* 落点挑舞台里**偏左下**一处：离中心远一点，"跟着鼠标走"才和"落在中心"分得开。 */
    const dropX = cs2.stage.left + Math.round((cs2.stage.right - cs2.stage.left) * 0.3)
    const dropY = cs2.stage.top + Math.round((cs2.stage.bottom - cs2.stage.top) * 0.65)
    const n1 = read().cards.length
    /* ★ 先把指针**移**到格子上（hover，不是 mouse —— 那个是"按+松"，
       会先把这张卡插一遍：于是文件里的张数从 n1 直接跳到 n1+2，
       "等它变成 n1+1"这条断言永远等不到。第一版就是这么红的）。 */
    await s.hover(c1.x, c1.y)
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c1.x, y: c1.y, button: 'left', clickCount: 1, buttons: 1 })
    /* 中间走几步（真拖是一串 move；一步跳过去在某些实现里会被当成"没动过"）。
       ★ 每一步都验一次**影子卡在不在指针底下** —— 拖动过程的可视化就这一样东西，
         而它上一版整张被画到了视口外面（`.bd-shelf` 的 `backdrop-filter` 让
         `position: fixed` 以架子为基准），用户看到的是"拖的时候什么都没有、
         一松手卡片才冒出来"。**这条断言就是为那次报的**（2026-09-20 用户原话：
         「拖动过程做的可视化不要突然出现在末尾」）。 */
    let ghostOk = 0
    let ghostSeen = 0
    let ghostWorst = 0
    for (let i = 1; i <= 6; i++) {
      const x = Math.round(c1.x + ((dropX - c1.x) * i) / 6)
      const y = Math.round(c1.y + ((dropY - c1.y) * i) / 6)
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x, y })
      await s.sleep(40)
      const g = await ev(`(() => {
        const el = document.querySelector('.bd-shelf-ghost')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { dx: Math.round(r.left - ${x}), dy: Math.round(r.top - ${y}), out: r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight }
      })()`)
      if (g) {
        ghostSeen += 1
        /* 影子跟着指针（右下各偏 14/15px 是设计：别让它压在指尖/笔尖底下） */
        if (!g.out && Math.abs(g.dx - 14) <= 8 && Math.abs(g.dy - 15) <= 8) ghostOk += 1
        ghostWorst = Math.max(ghostWorst, Math.abs(g.dx - 14) + Math.abs(g.dy - 15))
      }
      /* 拖到一半存一张截图（"拖起来是什么样"只有看一眼才知道对不对）。 */
      if (i === 4) {
        const shotDrag = await s.send('Page.captureScreenshot', { format: 'png' })
        const fsD = await import('node:fs')
        const pathD = await import('node:path')
        const p = pathD.join(process.cwd(), '.cache', 'shelf-drag-shot.png')
        fsD.mkdirSync(pathD.dirname(p), { recursive: true })
        fsD.writeFileSync(p, Buffer.from(shotDrag.data, 'base64'))
      }
    }
    if (ghostSeen === 6 && ghostOk === 6) {
      ok('★ 拖动过程中**影子卡一直跟在指针底下**（6 步全对，右下各偏 14/15px）· 截图 .cache/shelf-drag-shot.png')
    } else {
      bad(`拖动时的影子卡不对：6 步里只有 ${ghostSeen} 步画出来了、${ghostOk} 步在指针那儿（最大偏离 ${ghostWorst}px）—— 整张跑到视口外也是这样`)
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dropX, y: dropY, button: 'left', clickCount: 1, buttons: 0 })
    const ghostGone = await until(() => ev(`document.querySelector('.bd-shelf-ghost') === null`), { timeout: 2000, what: '松手之后影子卡收掉' })
    if (ghostGone.ok) ok('松手之后影子卡收掉了（不会留一张挂在屏幕上）')
    else bad('松手之后影子卡还挂在那儿')
    const dragged = await until(() => {
      const d = read()
      return d && d.cards.length >= n1 + 1 ? d : undefined
    }, { what: '拖出来的那张卡落盘' })
    if (dragged.ok) ok('★ 拖着松手 → 板上多了一张卡（影子卡没把 pointerup 吃掉）')
    else bad('拖了没放下 —— 多半是影子卡接走了 pointerup')
    await untilSaved()
    const cs3 = await ev(`window.__shelf.cards()`)
    const dropped = cs3.list[cs3.list.length - 1]
    if (Math.abs(dropped.cx - dropX) < 30) ok(`★ 落在**松手的地方**（横向差 ${Math.abs(dropped.cx - dropX)}px，而不是回到中心）`)
    else bad(`落点不对：卡中心 x=${dropped.cx}，松手处 x=${dropX}`)
    if (Math.abs(dropped.cx - cs3.stage.cx) > 60) ok('★ 而且确实**不是**视野中心（两种取用法分得开）')
    else bad('拖到别处的结果和"点一下"一样 —— 两种手势没分开')

    /* ── [6] 架子是推出来的：删卡 → 跟着变；空了 → 点按钮只回一句话 ──────
     * ★ 两件必须做对的事（第一版两条都踩了，症状都很难看）：
     *   ① **只点"点得到"的卡**：卡片中心可能被底部那条架子盖住，
     *      那时 elementFromPoint 命中的是架子 —— 而架子上是**取用**格子，
     *      一"点"就又多插一张卡（第一版就是这么把 ×2 变成 ×3 的）；
     *   ② 每删一张都**重新读一次 DOM**（顺序会变），不要拿一个下标循环删。 */
    const clickableFormula = () =>
      ev(`(() => {
        for (const c of document.querySelectorAll('.bd-card.is-formula')) {
          const r = c.getBoundingClientRect()
          const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
          const hit = document.elementFromPoint(x, y)
          if (hit && hit.closest('.bd-card') === c) return { x, y }
        }
        return null
      })()`)
    const deleteFormulasUntil = async (pred, what, max = 10) => {
      for (let k = 0; k < max; k++) {
        if (pred(read())) return true
        const pt = await clickableFormula()
        if (!pt) return pred(read())
        await s.mouse(pt.x, pt.y)
        await s.sleep(160)
        await s.key('Delete', 'Delete', 46)
        /* ★ 删完要**等应用说「已存」**再读盘（防抖 700ms）：不等的话最后一次断言
           读到的是还没落盘的那一版 —— 症状是"明明删干净了，却报还剩一张"。
           （这是本仓库那条老规矩：读文件之前该等的那一下，用 untilSaved，不睡固定毫秒。） */
        await untilSaved({ timeout: 4000 })
        await s.sleep(80)
      }
      return pred(read())
    }

    /* 先把架子上那条 ×2 的两张卡删掉 → 那一格整格消失，只剩 1 格。 */
    const noF1 = await deleteFormulasUntil((d) => d && d.cards.filter((c) => c.tex === F1).length === 0, '那条公式的卡都删干净')
    if (noF1) ok('把那两张一模一样的卡删干净了')
    else bad('没能把那条公式的卡删干净：' + JSON.stringify(read().cards.map((c) => c.tex)))
    const sh2 = await ev(`window.__shelf.shelf()`)
    if (sh2 && sh2.n === 1 && sh2.tex[0] === F2) ok('★ 删掉那两张卡 → 架子上那一格**跟着消失**（它是推出来的，不是另存的库）')
    else bad('删了卡架子没跟着变：' + JSON.stringify(sh2))
    /* 再把最后一条也删掉 → 架子空了、自己收起来；这时点按钮只回一句人话。 */
    const none = await deleteFormulasUntil((d) => d && d.cards.every((c) => c.kind !== 'formula'), '公式卡都删干净')
    if (none) ok('公式卡一张不剩了')
    else bad('还剩着公式卡：' + JSON.stringify(read().cards.filter((c) => c.kind === 'formula').map((c) => c.tex)))
    const gone = await until(() => ev(`window.__shelf.shelf() === null`), { timeout: 4000, what: '架子自己收起来' })
    if (gone.ok) ok('★ 一条公式都不剩 → 架子自己收起来（空横条没有意义）')
    else bad('空架子还挂在那儿')
    const b1 = await ev(`window.__shelf.btn()`)
    if (b1 && !/\d/.test(b1.label)) ok('按钮上的条数跟着变没了')
    else bad('按钮还写着条数：' + JSON.stringify(b1 && b1.label))
    await s.mouse(b1.x, b1.y)
    await s.sleep(300)
    const t = await ev(`window.__shelf.toast()`)
    if (/空着/.test(t)) ok('★ 空的时候点它 → 回一句人话（"先认一个"），而不是弹一个空架子')
    else bad('空架子点了没说法：' + JSON.stringify(t))
    if ((await ev(`window.__shelf.shelf()`)) === null) ok('点了也不打开（没有空横条）')
    else bad('空架子还是被打开了')

    if (!s.errors().length) ok('这一节跑下来，页面里没有任何 JS 报错')
    else bad(`页面里有 JS 报错（${s.errors().length} 条）：` + s.errors().slice(0, 3).join(' ｜ '))
  }
)

export default fails
