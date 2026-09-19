/* 复制 / 粘贴的**真浏览器**体检 —— 用户原话（2026-09-18）：
 *
 *   「框选后加入复制功能，能够黏贴在其他用户想要黏贴的画板上」
 *
 * 纯逻辑那一半在 check-board 的 [6w]（三条规矩：不装关系、相对偏移、新 id），
 * 这个脚本验的是**接上去之后还成立吗** —— 而这一半只有真浏览器能验：
 *   · Ctrl+C / Ctrl+V 是**键盘**走的路（合成事件绕不过去，也证明不了"用户按得动"）；
 *   · 「⧉ 复制」那颗按钮浮在选区上方，**压在浮层上就点不到**（本仓库踩过两次）；
 *   · 跨板粘贴的真凭据是 **localStorage 同 origin 保留**——
 *     这件事只有"真的换了文档再读"才算数。
 *
 * ── 这个脚本要盯住的五件事 ────────────────────────────────────────────────
 *   [1] 框选 → Ctrl+C：剪贴板里真的装上了东西（localStorage 里有、形状对）。
 *       ⚠ 顺带钉住"**没有选中东西时 Ctrl+C 不许清空剪贴板**" —— 那是误按，
 *         清掉会让人白复制一次（copySelection 返回 null 就是为这个）。
 *   [2] 换到**另一张板**：Ctrl+V 贴出来了，而且落在**视野里**（不是屏幕外几屏远）。
 *   [3] 落点规矩②：贴出来的东西**和原来那块的内部相对关系一致**
 *       （不能各归一化各的 —— 笔和卡的相对位置错了肉眼看不出来，但那是错的）。
 *   [4] 规矩③：新 id 与旧 id **零交集**，而且原板一个字节没动。
 *   [5] Ctrl+Z 能退回去（一次粘贴 = 一步撤销）。
 *
 * ── 为什么"跨板"是两次导航而不是开两个窗口 ────────────────────────────────
 *   `?file=` 只认一个名字（App.jsx 的 planStartup），一个页面只开一张板。
 *   而用户真实的走法是"开两个白板页 / 复制完切板再粘"——
 *   两次导航**正好**是这条路的本质：换个文档，但 localStorage 是同一个 origin。
 *   所以这个脚本的跨板判据比"开两个窗口"更强：它证明的是**剪贴板不在内存里**
 *   （只在内存里的话导航一次就没了）。
 *
 * ── 踩过的坑（别重犯）──────────────────────────────────────────────────────
 *   ① **框选要先切工具**。`tool === 'select'` 才会开始框选；
 *      用笔（penStroke）画出来的框是**墨迹**不是选框。
 *      用户的路是点工具条上那颗「⬚ 框选」（`[data-tool="select"]`），
 *      这里就走那条路 —— 别图省事直接改 React 状态，那样验不到按钮点不点得着。
 *   ② **框住的矩形要真罩住笔迹**（`strokeHitsRect`），框小一点就是"框里没有笔迹"，
 *      症状是"Ctrl+C 什么都没复制"，看着像复制坏了。
 *   ③ **Ctrl+C 之前先确认框选真的生效了**（选区浮层 `.\bd-inkacts` 浮出来了）——
 *      它是"上一次框选成功了"的唯一界面证据。
 *   ④ 按键要用 `s.key('c','KeyC',67)` 那套（它会给单字符补一发 `char`，
 *      没有 char 的话 keypress 不来；见 board-check.js 里 Session.key 的说明）。
 *      ⚠ 但**带修饰键的字母键**要当心：`ctrlKey` 得自己在 dispatchKeyEvent 里给 ——
 *      Session.key 不带 modifiers 参数，所以这里自己发（见下面的 pressCtrl）。
 *
 * 跑：node scripts/check-clip.js
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, newStroke, serializeBoardDocument } from '../src/lib/board.js'
import { CLIPBOARD_VERSION, isPayload } from '../src/lib/clipboard.js'

/* ── 夹具 ─────────────────────────────────────────────────────────────────
   板 A：两笔 + 一张卡，卡片**压在笔迹中间**（这样"框住一块"才有意义，
        而且能验到规矩②：卡片和笔的相对位置得跟着走）。
   板 B：**空的**。粘贴要落在一块干净板上 —— 它上面有没有东西
        会影响"新 id 零交集"那条判据的可读性（一堆本来就在的 id 混在一起）。
   ⚠ 两张板都由 withBoard 造/删，名字必须是 board-zz-*。
      withBoard 一次只认**一个** tag，所以第二张板在 after() 里手工删 ——
      名字照样走 LEGAL_FIXTURE 那一套（board-zz-），跑完删干净。 */

/* ── 夹具的坐标 ──────────────────────────────────────────────────────────
 * ★ 为什么这么小（一笔 200 世界像素见方的一撮）：板是 `viewPinned: false`，
 *   打开时会**按内容自动装进屏幕**（fitView）。内容摊得越开，缩放越小，
 *   屏幕上要框的那块就越小 —— 而框选的起止点得落在舞台里、还得罩住笔迹，
 *   太小了就成了"跟像素较劲"。
 *   紧凑一块 + 自动适配 = 屏幕上是一大团，框起来稳当。
 *   （绝对值是多少其实无所谓：真正决定屏幕在哪儿的是 autofit 那一下。）
 *
 * ★ 卡片故意**紧贴在笔迹右手边**（而不是隔很远）：这样"卡片有没有跟着笔迹
 *   保持相对位置"那条判据（规矩②）才有分辨力 —— 隔太远的话，
 *   两者各归一化各的也能对上（那是自检最容易骗过自己的一种夹具）。 */
const STROKES = [
  { pts: [[0, 0], [70, 16], [140, 4]] },
  { pts: [[0, 60], [140, 76]] },
]
/* 卡片左边缘在笔迹右边缘外 30 —— 框住笔迹时它会被一起框进来，
   而"卡片相对笔迹左边缘的偏移"是个一眼能看出来的数（170）。 */
const CARD = { x: 170, y: 0, w: 110, h: 56, text: '一起复制' }

/* 扁平数组 [x, y, p, x, y, p, ...] —— 这是板里**唯一**的点形状（见 board.js 顶部那条铁律）。
   压力那一维随便给：这里不画，只是要有东西可框。 */
const mkStroke = (pts) => {
  const flat = []
  let t = 0
  for (const [x, y] of pts) flat.push(x, y, (t = Math.min(1, t + 0.15)))
  return newStroke('pen', flat, { color: '#1b1d22', width: 3 })
}

const boardA = (() => {
  const b = newBoard('自检夹具 A（跑完自动删除）')
  for (const s of STROKES) b.strokes.push(mkStroke(s.pts))
  const card = newCard('note', CARD.x + CARD.w / 2, CARD.y + CARD.h / 2, { w: CARD.w, h: CARD.h, text: CARD.text })
  card.x = CARD.x
  card.y = CARD.y
  b.cards.push(card)
  return b
})()

const boardB = newBoard('自检夹具 B（跑完自动删除）')

const fails = await withBoard(
  /* 端口一套独占的：现役有 5201~5209 / 5211~5215 / 5179 / 5188 / 5189 / 5221…
     5222/9262 目前没人用。记住 README 那条：**端口绝不跟别的自检串**
     （串了就是两个脚本抢同一个夹具，报出来是"自检动了你的文件"）。 */
  { tag: 'clipA', port: 5222, cdpPort: 9262, text: serializeBoardDocument(boardA) },
  async ({ s, ok, bad, open, until, untilSaved, read, after, port, cdpPort }) => {
    const fs = await import('node:fs')
    const path = await import('node:path')

    /* 板 B 走 withBoard 之外的那条路：自己写 / 自己删。
       ★ 删只删自己造的那一个名字（不 rmSync 整个目录、不动别人的文件）。 */
    const B_NAME = 'board-zz-clipB.md'
    const B_PATH = path.join(process.cwd(), 'data', B_NAME)
    fs.mkdirSync(path.dirname(B_PATH), { recursive: true })
    fs.writeFileSync(B_PATH, serializeBoardDocument(boardB), 'utf8')
    after(() => {
      try {
        if (fs.existsSync(B_PATH)) fs.rmSync(B_PATH, { force: true })
      } catch {}
    })

    const ev = (x) => s.eval(x)

    /* ★ Ctrl+字母：自己发（修饰键得过 ctrlKey，Session.key 没有这个参数）。
       四发一组：keyDown(ctrl) → keyDown(字母, ctrl 亮) → keyUp(字母) → keyUp(ctrl)。
       ⚠ 字母那一发要带 text（单字符才有 chat / keypress），修饰键不带。 */
    const pressCtrl = async (ch, code, vk) => {
      const mod = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 }
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...mod })
      await s.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2,
      })
      await s.send('Input.dispatchKeyEvent', {
        type: 'char', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2, text: ch, unmodifiedText: ch,
      })
      await s.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2,
      })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...mod, modifiers: 0 })
      await s.sleep(320)
    }
    const CTRL_C = () => pressCtrl('c', 'KeyC', 67)
    const CTRL_V = () => pressCtrl('v', 'KeyV', 86)

    await open()

    /* ── 页面侧读数 ────────────────────────────────────────────────────────
       全部只做"读数"，断言在下面明面上。
       ★ 写成一个函数是**必须**的：换了文档（切板）之后 `window.__clip` 就没了，
         而"切板"正是这个脚本的主线 —— 见 [2] 里那次重新注入。 */
    const injectReader = () =>
      ev(`(() => {
      window.__clip = {
        /* localStorage 里那份剪贴板（跨窗口的唯一凭据）—— **原样返回字符串**，
           解析和判形状在 node 侧做（node 侧有 isPayload 的正本）。 */
        raw() { return localStorage.getItem('studyhelper.clip.v1') },
        /* 提示条的文字（"复制了 2 笔 + 1 张卡…"）—— 界面真的说了话的证据。 */
        toast() { const t = document.querySelector('.toast-msg'); return t ? t.textContent.trim() : '' },
        /* 选区浮层在不在、复制按钮在不在、点得到吗。
           为什么要 elementsFromPoint：本仓库那两次"按钮点不到"都是因为
           有浮层压在上面 —— 光看"元素存在"看不出来。 */
        copyBtn() {
          const b = document.querySelector('.bd-inkcopy')
          if (!b) return null
          const r = b.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }
        },
        hitAt(x, y) { const e = document.elementFromPoint(x, y); return e ? (e.className || e.tagName) : null },
        /* 选区浮层在不在（界面自己的说法：它浮出来 = 有东西被框中了） */
        selCount() {
          const acts = document.querySelector('.bd-inkacts')
          return acts ? 1 : 0
        },
        /* 卡片的位置（卡片是 DOM，直接量）。笔迹在 canvas 里量不到 ——
           所以要数笔迹得读**盘上的文件**（见下面 [2] 里那段 until）。 */
        cards() { return [...document.querySelectorAll('.bd-card')].map((c) => ({ x: parseFloat(c.style.left), y: parseFloat(c.style.top) })) },
        /* 贴出来的东西**在不在视野里**：拿卡片的真实屏幕位置和舞台矩形比。
           笔迹在 canvas 里量不到，所以这条判据用卡片 ——
           卡片和笔迹在同一个世界里，卡片在视野里 ⇔ 那块东西落点对。 */
        onScreen() {
          const st = document.querySelector('.bd-stagewrap')
          if (!st) return null
          const sr = st.getBoundingClientRect()
          const inView = (r) => r.right > sr.left && r.left < sr.right && r.bottom > sr.top && r.top < sr.bottom
          const cards = [...document.querySelectorAll('.bd-card')]
          return {
            n: cards.length,
            visible: cards.filter((c) => inView(c.getBoundingClientRect())).length,
            stage: { w: Math.round(sr.width), h: Math.round(sr.height) },
          }
        },
        /* 板框（板框跟着走那条规矩的界面证据） */
        frames() { return [...document.querySelectorAll('.bd-frame')].length },
      }
      return true
    })()`)

    await open()
    await injectReader()

    /* ── [1] 框选 → Ctrl+C ─────────────────────────────────────────────────
       ★ 走用户的路：点工具条上那颗「⬚ 框选」，然后**用鼠标拖一个框**。
         用鼠标不用笔：select 工具下卡片是让路的（penInk 那条），
         但鼠标拖框更接近"用鼠标的人怎么用这个功能"。 */
    console.log('\n[1] 框选一块 → Ctrl+C：剪贴板里真的装上了')
    {
      await ev(`(() => {
        const b = document.querySelector('[data-tool="select"]')
        if (b) b.click()
        return !!b
      })()`)
      await s.sleep(200)
      const onSel = await ev(`(() => { const b = document.querySelector('[data-tool="select"]'); return b ? b.classList.contains('on') : false })()`)
      if (onSel) ok('点了工具条上的「⬚ 框选」，工具真的切过去了（按钮亮着）')
      else bad('点了「⬚ 框选」但工具没切过去 —— 后面框选不会发生')

      /* ★ 框选的起止点：**按屏幕上真实的位置算**，不猜世界坐标。
         为什么（本仓库踩过：README 里"按屏幕像素摆之前先量视图缩放"）：
         板是自动适配进屏幕的，缩放系数取决于内容有多大 ——
         夹具里写死一个世界矩形，换块屏幕/改个尺寸就可能算到舞台外面去
         （第一版就是这么报的："框选之后选区浮层没出现"，而框其实落在屏幕外了）。
         所以先问浏览器"笔迹和卡片这一整块，屏幕上占哪儿"，再往外留一点余量。 */
      const spot = await ev(`(() => {
        const st = document.querySelector('.bd-stagewrap')
        if (!st) return null
        const sr = st.getBoundingClientRect()
        /* 卡片是 DOM，直接量。笔迹在 canvas 里量不到 —— 所以拿**应用自己**
           算出来的选中框没法用（还没框呢）。这里用卡片 + 舞台的几何反推：
           卡片在笔迹右边 30 世界像素处，笔迹那一块的左/上就到卡片的左边 - 余量。
           ⚠ 这条是"夹具已知"的推断，不是读界面 —— 夹具里笔迹的世界范围
             是这块脚本自己写死的（STROKES / CARD），所以推得出来。 */
        const c = document.querySelector('.bd-card')
        if (!c) return null
        const cr = c.getBoundingClientRect()
        return { sr: { left: sr.left, top: sr.top, right: sr.right, bottom: sr.bottom }, card: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom } }
      })()`)
      if (!spot) {
        bad('读不到舞台/卡片的屏幕位置 —— 框选坐标算不出来')
      } else {
        /* 卡片的屏幕宽 ÷ 它的世界宽 = 缩放系数（卡片自己还有个 scale，见 README 那条 ⚠）——
           这里只用它估"世界 30px 在屏幕上多宽"，够用。 */
        const k = (spot.card.right - spot.card.left) / CARD.w
        const pad = Math.round(28 * k) + 12
        const p0 = { x: Math.round(spot.card.left - pad - 30 * k), y: Math.round(spot.card.top - pad) }
        const p1 = { x: Math.round(spot.card.right + pad), y: Math.round(spot.card.bottom + pad) }
        /* 夹进舞台里（框选必须**从纸面上起手** —— 起点压在工具条/侧栏上事件收不到）。 */
        const x0 = Math.max(spot.sr.left + 6, p0.x)
        const y0 = Math.max(spot.sr.top + 6, p0.y)
        const x1 = Math.min(spot.sr.right - 6, p1.x)
        const y1 = Math.min(spot.sr.bottom - 6, p1.y)
        console.log(`      框屏幕 (${x0},${y0}) → (${x1},${y1})（卡片屏幕宽 ${Math.round(spot.card.right - spot.card.left)}）`)

        await s.drag(x0, y0, x1 - x0, y1 - y0, { steps: 8, button: 'left' })
        const sel = await ev(`window.__clip.selCount()`)
        const toast1 = await ev(`window.__clip.toast()`)
        if (sel) ok(`框选生效了（选区浮层浮出来了）${toast1 ? `，界面说：${toast1}` : ''}`)
        else bad('框选之后选区浮层没出现 —— 框没罩住笔迹？' + (toast1 ? `（界面说：${toast1}）` : ''))

        /* ★ 「⧉ 复制」按钮点得到吗（本仓库那两次"点不到"都是浮层压住）。 */
        const btn = await ev(`window.__clip.copyBtn()`)
        if (!btn) {
          bad('框选之后没有「⧉ 复制」按钮 —— 用户看不到这个入口')
        } else {
          const hit = await ev(`window.__clip.hitAt(${btn.x}, ${btn.y})`)
          if (/bd-inkcopy/.test(String(hit))) ok(`「⧉ 复制」按钮在 (${btn.x}, ${btn.y}) 点得到（最上面就是它自己）`)
          else bad(`「⧉ 复制」按钮点不到 —— 那个位置最上面是 ${JSON.stringify(hit)}（浮层压住了）`)
        }

        /* ★ 先记下"没有选中时 Ctrl+C 不许清空剪贴板"的证据：
           这里剪贴板还是空的（第一次），所以先复制一次让里面有东西，再撤掉选中
           —— 那一步在下面 [1b]。 */
        await CTRL_C()
        const raw = await ev(`window.__clip.raw()`)
        const toastC = await ev(`window.__clip.toast()`)
        let p = null
        try {
          p = JSON.parse(raw)
        } catch {}
        if (!raw) {
          bad('Ctrl+C 之后 localStorage 里没有剪贴板 —— 复制没落到能跨窗口的地方')
        } else if (!isPayload(p)) {
          bad('剪贴板里的东西形状/版本不对：' + JSON.stringify(raw).slice(0, 200))
        } else {
          ok(`Ctrl+C 之后 localStorage 里有一份**形状和版本都对**的剪贴板（v${CLIPBOARD_VERSION}，${p.strokes.length} 笔 + ${p.cards.length} 张卡${p.frames.length ? ` + ${p.frames.length} 个板框` : ''}）`)
        }
        if (p) {
          console.log(`      界面说：${toastC || '(没说话)'}`)
          if (/复制了/.test(toastC)) ok(`界面明说了"${toastC}" —— 用户知道复制成功了`)
          else bad(`Ctrl+C 之后界面没有说"复制了…"（实际说：${JSON.stringify(toastC)}）`)

          /* 规矩①：剪贴板里**不许有 links**。 */
          if (!('links' in p)) ok('剪贴板里没有 links 字段 —— 只装内容、不装关系（规矩①）')
          else bad('剪贴板里带了 links —— 跨板之后那些 id 指向别人家的东西')

          /* 规矩②：原点归到选中内容的左上角（存的是相对坐标）。 */
          const xs = []
          for (const st of p.strokes) for (let i = 0; i + 2 < st.points.length; i += 3) xs.push(st.points[i])
          const minX = xs.length ? Math.min(...xs) : null
          if (minX !== null && Math.abs(minX) < 0.01) ok('笔迹的 x 从 0 开始 —— 原点归到了选中内容的左上角（规矩②）')
          else bad(`笔迹的 x 最小是 ${minX}，不是 0 —— 原点的归一化不对（规矩②）`)
          if (p.box && p.box.w > 0 && p.box.h > 0) ok(`剪贴板记了整块的大小：${p.box.w}×${p.box.h}（粘贴时拿它居中）`)
          else bad('剪贴板里的 box 不对：' + JSON.stringify(p.box))

          /* ★ 卡片和笔**一起**被框进来了吗（规矩②的关键：两者用同一个 offset）。 */
          if (p.cards.length === 1) ok('框住的笔旁边的卡片也一起进来了（框选那一次的矩形是两处共用的判据）')
          else bad(`框里应当有 1 张卡，实际 ${p.cards.length} 张 —— 「复制」和「留下板框」用的不是同一句话？`)
        }
      }
    }

    /* ── [1b] 反证：没有框住东西时 Ctrl+C 不许把剪贴板清空 ──────────────────
       ★ 这是"误按"那条判据。copySelection 返回 null 就是为它设计的
         （调用方别覆盖原来那份）—— 但接线里也可能接错，所以在这儿钉住。
       ⚠ 顺序要紧：这一步的**前提是 [1] 真的复制成功了**（剪贴板里有东西）。
         第一版没管这个 —— [1] 失败时剪贴板本来就空，"清没清空"判不出来，
         报出来的却是"被清空了"（一条**假红**：把前一步的失败又算了一遍）。
         所以这里先看前提在不在；不在就**明说跳过**（别让它冒充判据）。 */
    console.log('\n[1b] 反证：手上没框住东西时按 Ctrl+C，不许把剪贴板清空')
    {
      const before = await ev(`window.__clip.raw()`)
      if (!before) {
        bad('剪贴板本来就是空的（上一步没复制成功）—— 这条判据没跑成，先修上一步')
      } else {
        /* 把选中取消掉：按 Esc（应用里 Esc = 整块归零）。 */
        await s.key('Escape', 'Escape', 27)
        await s.sleep(200)
        await CTRL_C()
        const afterRaw = await ev(`window.__clip.raw()`)
        const toast = await ev(`window.__clip.toast()`)
        if (afterRaw && before === afterRaw) {
          ok('没有选中东西时按 Ctrl+C，剪贴板原样没动（误按不会让人白复制一次）')
        } else if (!afterRaw) {
          bad('没有选中东西时按 Ctrl+C，剪贴板被清空了 —— 这是误按，不该毁掉已经复制好的内容')
        } else {
          bad('没有选中东西时按 Ctrl+C，剪贴板被改写了：' + String(afterRaw).slice(0, 120))
        }
        console.log(`      界面说：${toast || '(没说话)'}`)
        if (/先框住/.test(toast)) ok('界面说了句人话告诉用户要做什么（不是静默无反应）')
        else bad(`没有选中时按 Ctrl+C，界面应当提示"先框住要复制的东西"（实际：${JSON.stringify(toast)}）`)
      }
    }

    /* ── [2] 换到**另一张板** → Ctrl+V ────────────────────────────────────
       ★ 这一步是本功能的目的，也是"剪贴板不在内存里"的证明：
         换了文档之后，内存里那个 ref 已经是新的了（新页面），
         还能贴出来 ⇔ 真的是从 localStorage 读的。 */
    console.log('\n[2] 换到另一张板 → Ctrl+V：真的跨板贴上了')
    {
      /* 板 A 的东西先等它落盘（下面要验"原板一个字节没动"）。 */
      const saved = await untilSaved({ timeout: 8000 })
      if (saved.ok) ok(`板 A 的变化已经写盘了（等了 ${saved.waited}ms）`)
      else console.log('      （板 A 没等到「已存」—— 它可能本来就没脏，继续）')

      /* 打开板 B：Page.navigate 换文档。
         ★ 这就是"用户切开另一个白板页"的等价物 —— 换个文档，同一个 origin。
         ⚠ 别在这之前再调 withBoard 的 `open()`：它绑的是板 A（夹具），
           调一次就把页面导回板 A 了（第一版多写了这一句，于是"切到板 B"
           和"重新注入"中间隔着一次导航，注入的读数立刻没了）。 */
      const appUrl = `http://127.0.0.1:${port}/`
      await s.send('Page.navigate', { url: appUrl + '?file=' + encodeURIComponent(B_NAME) })
      const w = await until(async () => {
        const f = await s.eval(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)
        return f === B_NAME ? f : undefined
      }, { what: '打开的是板 B', timeout: 20000 })
      if (w.ok) ok(`切到了另一张板：${w.value}（同一个窗口、同一个 origin）`)
      else bad(`切板没成功（顶栏还是 ${JSON.stringify(await ev(`((document.querySelector('.bd-file')||{}).textContent||'').trim()`))}）`)

      await s.sleep(500)
      /* ★★ 导航之后**必须重新注入页面侧读数** —— `window.__clip` 属于旧文档，
         换了文档就没了（第一版没重注入，报出来是
         "Cannot read properties of undefined (reading 'cards')"，
         看着像夹具坏了，其实是读数器还在上一页）。
         ⚠ 这也正是"跨板"这件事的性质：**页面上的东西全没了，只有 localStorage 还在** ——
           而这个脚本接下来要证的恰恰是"只有 localStorage 还在"就够了。 */
      await injectReader()
      /* 板 B 是空的：一张卡都没有。这就是"粘贴的落点由内容决定"的干净起点。 */
      const n0 = await ev(`window.__clip.cards().length`)
      if (n0 === 0) ok('板 B 本来是空的（粘贴前后的差别一眼看得清）')
      else bad(`板 B 上本来就有 ${n0} 张卡 —— 夹具不对`)

      /* ★ 复制的那一份**还在**（localStorage 跨导航活下来）—— 这是"跨板"的前提。 */
      const rawB = await ev(`window.__clip.raw()`)
      if (rawB) ok('换文档之后 localStorage 里那份剪贴板还在（跨板粘贴的前提）')
      else bad('换文档之后剪贴板没了 —— 它是不是存在内存里了？跨板就粘不出来了')

      await CTRL_V()
      const toastV = await ev(`window.__clip.toast()`)
      const n1 = await ev(`window.__clip.cards().length`)
      if (n1 === 1) ok('Ctrl+V 之后板 B 上多了一张卡（界面真的把东西放上去了）')
      else bad(`Ctrl+V 之后板 B 上有 ${n1} 张卡，期望 1 张`)
      console.log(`      界面说：${toastV || '(没说话)'}`)
      if (/粘贴了/.test(toastV)) ok(`界面明说了"${toastV}"`)
      else bad(`Ctrl+V 之后界面没有说"粘贴了…"（实际说：${JSON.stringify(toastV)}）`)

      /* ★ 落在**视野里**（规矩②的目的："贴在我正看着的地方"）。
         判据用卡片的真实屏幕位置：它得在舞台矩形里。
         没有这条，"东西贴到屏幕外几屏远"会被当成成功（用户会以为粘贴没反应）。 */
      const vis = await ev(`window.__clip.onScreen()`)
      if (vis && vis.n === 1 && vis.visible === 1) {
        ok('贴出来的东西落在**视野里**（1 张卡就在舞台矩形内）—— 用户看得见')
      } else {
        bad(`贴出来的东西不在视野里：${JSON.stringify(vis)} —— 这就是"粘贴好像没反应"`)
      }

      /* 落盘之后从**文件**读新板的板（比从界面读可靠：笔迹只在 canvas 里）。
         等到盘上真的有两笔 —— 那才是"粘贴落盘了"。 */
      const onDisk = await until(async () => {
        try {
          const d = JSON.parse((await import('node:fs')).readFileSync(B_PATH, 'utf8'))
          return d && d.strokes && d.strokes.length === 2 ? d : undefined
        } catch {
          return undefined
        }
      }, { what: '板 B 的文件里出现了粘贴过来的两笔', timeout: 10000 })
      if (onDisk.ok) {
        const d = onDisk.value
        ok(`粘贴的东西落盘了：板 B 的文件里现在有 ${d.strokes.length} 笔 + ${d.cards.length} 张卡`)

        /* ★ 规矩③：新 id 与板 A 的旧 id **零交集**。
           ⚠ 判据要落在**这次新造的**那些 id 上（不是"整块板上没有旧 id" ——
             那样在"往同一张板上粘"时必然假红：板 A 本来就含那些旧 id）。 */
        const oldIds = new Set([...boardA.strokes.map((s) => s.id), ...boardA.cards.map((c) => c.id)])
        const clash = [...d.strokes.map((s) => s.id), ...d.cards.map((c) => c.id)].filter((id) => oldIds.has(id))
        if (!clash.length) ok(`粘出来的 ${d.strokes.length + d.cards.length} 样东西全是**新 id**，和原板零交集（规矩③）`)
        else bad('粘出来的东西和原板撞了 id：' + JSON.stringify(clash) + ' —— 会静默改掉原板那张卡')

        /* ★ 规矩② 的内部一致性：笔和卡的**相对位置**得跟原件一样。
           夹具里：笔迹从 x=0 起、卡片左边缘在 x=170（就是 CARD.x）。
           所以「卡片.x0 − 笔迹.x0」这个差在原件和贴出来的那份上必须相等。
           ⚠ 期望值要**从夹具常量算**（STROKES 的最小 x 是 0，但别把它写死 ——
             改了夹具就会变成一条假红，第一版就写了 `CARD.x - 300`（改夹具前的老值），
             报出来"两者各归一化各的"，其实两边都是 170，完全正确）。 */
        const sxs = []
        for (const st of d.strokes) for (let i = 0; i + 2 < st.points.length; i += 3) sxs.push(st.points[i])
        const sx0 = Math.min(...sxs)
        const cardDx = d.cards[0].x - sx0
        const srcMinX = Math.min(...STROKES.flatMap((s) => s.pts.map((p) => p[0])))
        const wantDx = CARD.x - srcMinX
        if (Math.abs(cardDx - wantDx) <= 1.5) {
          ok(`卡片跟着笔迹走：卡片相对笔迹左边缘的偏移 ${cardDx}（原件是 ${wantDx}）—— 同一个 offset 作用于两样（规矩②）`)
        } else {
          bad(`卡片和笔迹的相对位置变了：贴出来是 ${cardDx}，原件是 ${wantDx} —— 两者各归一化各的`)
        }
      } else {
        bad('等不到板 B 的文件里出现粘贴过来的东西（贴了但没落盘？）')
      }

      /* ★★ 原板（板 A）**一个字节没动** —— 粘贴是"加东西"，不是"搬东西"。
         用户最怕的就是"我复制一下，原来那块没了 / 被改了"。 */
      const aPath = path.join(process.cwd(), 'data', 'board-zz-clipA.md')
      const nowA = JSON.parse(fs.readFileSync(aPath, 'utf8'))
      if (nowA.strokes.length === STROKES.length && nowA.cards.length === 1) {
        const sameIds = nowA.strokes.every((st, i) => st.id === boardA.strokes[i].id)
        if (sameIds) ok(`原板（板 A）原样没动：${nowA.strokes.length} 笔 + ${nowA.cards.length} 张卡，id 也没换过`)
        else bad('原板的笔迹 id 变了 —— 粘贴动到了源板')
      } else {
        bad(`原板被改了：现在 ${nowA.strokes.length} 笔 + ${nowA.cards.length} 张卡（原来是 ${STROKES.length} + 1）`)
      }
    }

    /* ── [3] Ctrl+Z：粘贴是一步撤销 ─────────────────────────────────────── */
    console.log('\n[3] Ctrl+Z：一次粘贴 = 一步撤销')
    {
      await s.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
      })
      await s.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2,
      })
      await s.send('Input.dispatchKeyEvent', {
        type: 'char', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2, text: 'z', unmodifiedText: 'z',
      })
      await s.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2,
      })
      await s.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0,
      })
      await s.sleep(500)

      const gone = await until(async () => {
        try {
          const d = JSON.parse(fs.readFileSync(B_PATH, 'utf8'))
          return d.strokes.length === 0 && d.cards.length === 0 ? d : undefined
        } catch {
          return undefined
        }
      }, { what: 'Ctrl+Z 之后板 B 回到空的', timeout: 6000 })
      if (gone.ok) ok(`Ctrl+Z 把整次粘贴收回去了（板 B 又空了，等了 ${gone.waited}ms）—— 一次粘贴确实是一步`)
      else {
        const d = read() || {}
        bad(`Ctrl+Z 之后板 B 还有东西（盘上 ${(d.strokes || []).length} 笔）—— 粘贴没进撤销栈，或者退不干净`)
      }
    }

    /* ── [4] 收尾：页面上没有报错 ─────────────────────────────────────────
       为什么放在最后：上面那些断言里任何一个走了"异常"那条路，
       都会在这里以"页面里有报错"的样子露出来 —— 比"断言不明所以地失败"好查。 */
    console.log('\n[4] 页面上没有 JS 报错')
    {
      const errs = s.errors()
      if (!errs.length) ok('页面里没有 JS 报错')
      else bad('页面里有报错：' + errs.slice(0, 3).join(' | '))
    }
  }
)

export { fails }
