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

    /* ── [2b] 工具条上那颗「⧉ 粘贴」（2026-09-23，用户报的 Surface 场景）────
       ★ 用户原话：「加一个方便黏贴的，现在复制框选即可复制，但是黏贴需要 ctrl+v，
         这对于 surface 来说要去接一个外置键盘才方便，我们不希望额外引入这个键盘，
         采用其他方式比如价格按钮」。
       ⇒ 上一节 [2] 走的正是**那条不满意的路**（Ctrl+V，得敲键盘）。
         这一节要走**用户真正要的那条**：**一个键都不按**，只点界面上那颗按钮。
         ⚠ 所以这里**不许出现任何键盘事件** —— 混进一个 Ctrl+V，
           这条判据证明的还是键盘那条路（那正是它要修的毛病）。

       三件事，缺一不可：
         ① 那颗按钮**在**、**点得到**（本仓库的"点不到"栽过两次：浮层/工具条压住）；
         ② 点下去**真的贴上**了 —— 而且和 Ctrl+V 是**同一颗东西**（同一句话、同一个落点）；
         ③ ★ 加这颗按钮**没有吃掉画布**（工具条换行那条线，见下面 why）。

       ★★ 为什么 ③ 要写在这儿：工具条是 `flex-wrap`，**每多一行就从画布底下
          啃掉 34px**（styles.css 里 .bd-tools 那段警告，2026-09-20 加「∑ 公式架」
          时压过一条线、把 check-ocr-browser 的落笔点算到了工具条上）。
          ★ 这颗按钮**第一版就放错过**（2026-09-23）：先按"和复制挨着"的直觉
            贴在左边那组，看着挺对 —— 直到把**同一颗按钮搬进每一组**量了一遍
            （`.cache/probe-cbar5.mjs`），才看出真相：

              视口   工具条宽   摘掉后   组0    组1    组2    组3~组6
              1246    988      109px    =      =      =      =
              1386   1128      109px    =      =      =      =
              1406   1148       75px   +34    +34    +34     =
              1426   1168       75px   +34    +34    +34     =
              1466   1208       75px    =      =      =      =
              1886   1628       77px    =      =      =      =

            ⇒ **组0/组1/组2 在 1440 那档窗口会多啃一行**，而 1440 正是最常见的
              笔记本宽度。最后落在**组3**（撤销/重做那组）—— 量过的每个宽度都白拿。

          ⇒ 判据就是**差值**（见下）：它对"又换了一行"有分辨力，而且真换行了
            会明确报出啃掉多少像素。
          ⚠ 这一条**红不代表粘贴坏了**：它管的是"工具条有没有多啃一行画布"。
            真红了先跑 `.cache/probe-cbar5.mjs` 看该挪到哪一组，
            再确认 `check-ocr-browser` 的落笔点有没有跟着挪。
          ⚠ 量不到按钮/工具条时**明说跳过**，别拿 null 去比 ——
            那样报出来是"工具条是 nullpx"，看着像按钮坏了，其实是这一节没跑成。 */
    console.log('\n[2b] 工具条上那颗「⧉ 粘贴」：不碰键盘也贴得上，而且没吃掉画布')
    {
      /* ── ③ ★ 加这颗按钮**没有吃掉画布** ──────────────────────────────
         判据 = **把这颗按钮藏起来，工具条会不会变矮**：
           变矮 = 它的宽度就是压出那一行的最后一根稻草（真吃了画布，报出差值）；
           不变 = 它塞得进现有的行里，白拿。

         ★★ 为什么用**差值**、而不是记一个固定高度基线：
            基线跟着视口宽 / 字号档 / 字体渲染走 —— 连 `--window-size=1440,900`
            在 headless 下实测视口都只有 **1406×729**（浏览器自己占掉一圈），
            写死一个数换台机器就红。而**差值**是自证的：同一页、同一瞬间、
            唯一的差别就是这一颗按钮在不在。这样"基线是多少"永远不会过期。

         ★ 三个宽度各有分工，不是凑数：
             1406 —— 实测的**刀刃**（组0/1/2 在这里会多啃一行）；
             1466 —— 刀刃另一侧（同一颗按钮在这里又不啃了）；
             1886 —— 宽屏（工具条只有 2 行，最宽松的样子）。
           ⚠ 只测这三个。再多的尺寸只会多出"哪天改个字号就红"的地方，
             而这条判据要守的是**换行**这一件事。 */
      const PROBE_W = [
        [1406, 729, '刀刃那一档（实测 组0/1/2 会在这里多啃一行）'],
        [1466, 789, '刀刃另一侧'],
        [1886, 909, '宽屏，最宽松'],
      ]
      const barDiff = async (w, h) => {
        await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
        /* 等一次重排（尺寸改了不一定立刻反映到 getBoundingClientRect）。 */
        await until(async () => (await ev(`!!document.querySelector('.bd-tools [data-tool="paste"]')`)) ? 1 : undefined, { timeout: 3000 })
        await s.sleep(200)
        /* ★ 藏 / 量 / 还 全在**一个同步块**里：JS 单线程，同步块中途 React 插不进来，
           所以不会出现"藏了一半被重渲染收回去"的中间态。 */
        return ev(`(() => {
          const t = document.querySelector('.bd-tools')
          const p = t && t.querySelector('[data-tool="paste"]')
          if (!t || !p) return null
          const hh = () => Math.round(t.getBoundingClientRect().height)
          const hWith = hh()
          p.style.display = 'none'
          const hWithout = hh()
          p.style.display = ''
          return { hWith, hWithout, restored: hh() }
        })()`)
      }
      for (const [w, h, why] of PROBE_W) {
        const r = await barDiff(w, h)
        if (!r) {
          console.log(`      （${w}px 下量不到工具条或粘贴按钮 —— 这一档跳过了）`)
          continue
        }
        /* 先守一道"这一趟真在量东西"的闸：高度得是个像样的正数。
           没有它的话，"工具条根本没渲染出来"（高度 0）会让差值也变成 0 而蒙混过关。 */
        if (!(r.hWith > 40)) {
          bad(`${w}px 下工具条高度只有 ${r.hWith}px —— 不像真的排出来了，这一档的差值不算数`)
          continue
        }
        const cost = r.hWith - r.hWithout
        if (cost === 0) {
          ok(`${w}px（${why}）下藏掉「⧉ 粘贴」工具条**一点都不矮**（${r.hWith}px → ${r.hWithout}px）—— 它没吃掉画布`)
        } else {
          bad(`${w}px（${why}）下藏掉「⧉ 粘贴」工具条从 ${r.hWith}px 掉到 ${r.hWithout}px —— 这颗按钮多啃了 ${cost}px 画布，换一组放（见 .cache/probe-cbar5.mjs）`)
        }
      }
      await s.send('Emulation.clearDeviceMetricsOverride')
      await s.sleep(200)

      /* ── ① 按钮在、点得到 ────────────────────────────────────────────
         ★ 量**工具条上**那一颗（`[data-tool="paste"]`），不是选区浮层里有没有。
         命中测试必须用 `elementFromPoint`（合成事件绕过命中测试 —— 本仓库
         那个"点删除按钮没有用"的 bug 就是这么一路绿灯的）。 */
      const pb = await ev(`(() => {
        const b = document.querySelector('.bd-tools [data-tool="paste"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
        const e = document.elementFromPoint(cx, cy)
        return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), txt: (b.textContent || '').trim(), hit: e ? (e.className || e.tagName) : null, self: e === b || (e && e.closest ? e.closest('[data-tool="paste"]') === b : false) }
      })()`)
      if (!pb) {
        bad('工具条上找不到「⧉ 粘贴」那颗按钮（`[data-tool="paste"]`）—— Surface 用户还是只能敲 Ctrl+V')
      } else {
        if (pb.txt === '⧉ 粘贴') ok(`工具条上那颗按钮上写着「${pb.txt}」（用户能找到它）`)
        else bad(`按钮上的字是 ${JSON.stringify(pb.txt)}，期望「⧉ 粘贴」`)
        if (pb.self) ok(`「⧉ 粘贴」在 (${pb.x}, ${pb.y}) **点得到**（${pb.w}×${pb.h}，最上面就是它自己）`)
        else bad(`「⧉ 粘贴」点不到 —— 那个位置最上面是 ${JSON.stringify(pb.hit)}（有东西压着它）`)

        /* ── ② 点下去真的贴上，而且和 Ctrl+V 同一条路 ────────────────────
           ★★ 判据要和 [2] 逐字对齐 —— 同一个落点规矩、同一句话。
             对不齐的话"两条路各写一份"就会悄悄分叉（这正是 onPaste={pasteSel}
             那个接线要防的事）：界面说"粘贴了…"、盘上多出东西，两条都得成立。
           ★ 起点不假设 —— **读盘上板 B 现在有几张卡**（[2] 粘过一次，所以这里应当
             是 1）。不赌 [2] 的结果：它失败时这张卡数就不一样，而这颗按钮的判据
             是"点一下**多了一整块**"，不是"最后是几张"。
         ★★ 两条判据都要，各自有分辨力、别合并：
             · 盘上笔数（读文件）—— "真的落盘了"；
             · 界面上卡数（读 DOM）—— "屏幕上也立刻看得见"。
           只判盘上会漏掉"贴了但没重绘"；只判界面会漏掉"重绘了但没写盘"。 */
        const readB = () => {
          try {
            return JSON.parse(fs.readFileSync(B_PATH, 'utf8'))
          } catch {
            return null
          }
        }
        const diskBefore = readB()
        const before = await ev(`window.__clip.cards().length`)
        const rawBefore = await ev(`window.__clip.raw()`)
        const strokesBefore = diskBefore ? diskBefore.strokes.length : null
        console.log(`      点之前：盘上 ${strokesBefore == null ? '(读不到)' : strokesBefore} 笔、界面上 ${before} 张卡`)
        /* 真鼠标点（不是 `b.click()`）—— 要验的是"手指/笔点得动"这件事本身。
           ★ dispatchMouseEvent 的**按下/抬起两发**才算一次点击；
             直接 `elem.click()` 走的是 DOM 合成事件、**绕过命中测试**，
             而那恰恰是本仓库"按钮点不到"的病灶（那个 bug 就这样一路绿灯过）。 */
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pb.x, y: pb.y, button: 'left', buttons: 1, clickCount: 1 })
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pb.x, y: pb.y, button: 'left', buttons: 0, clickCount: 1 })
        await s.sleep(400)
        const after = await ev(`window.__clip.cards().length`)
        const toastP = await ev(`window.__clip.toast()`)
        if (after === before + 1) {
          ok(`**只用鼠标点那颗按钮**，板 B 上从 ${before} 张卡变成 ${after} 张 —— 一个键都没按就贴上了`)
        } else {
          bad(`点了「⧉ 粘贴」之后卡数是 ${after}（点之前 ${before}），期望 ${before + 1} —— 按钮没接上 pasteSel？`)
        }
        /* ★ 真的落盘（贴出来的笔数比点之前多 2 —— 就是上面复制的那两笔）。 */
        if (strokesBefore == null) {
          console.log('      （盘上读不到板 B —— 落盘那条跳过了）')
        } else {
          const afterDisk = await until(async () => {
            const d = readB()
            return d && d.strokes.length === strokesBefore + 2 ? d : undefined
          }, { what: '点按钮之后板 B 盘上多了两笔', timeout: 6000 })
          if (afterDisk.ok) ok(`点按钮贴的东西落盘了：板 B 盘上从 ${strokesBefore} 笔变成 ${afterDisk.value.strokes.length} 笔`)
          else bad(`点按钮之后板 B 盘上没有多出那两笔（点之前 ${strokesBefore} 笔）—— 只重绘了没写盘？`)
        }
        console.log(`      界面说：${toastP || '(没说话)'}`)
        /* ★ 和 [2] 那句**同一个词**（"粘贴了"）—— 两条路是同一颗东西的证据。 */
        if (/粘贴了/.test(toastP)) ok(`界面说的是"${toastP}" —— 和按 Ctrl+V 时**同一句话**（两条路确实共用 pasteSel）`)
        else bad(`点按钮之后界面没有说"粘贴了…"（实际说：${JSON.stringify(toastP)}）—— 和 Ctrl+V 那条路分叉了`)

        /* ★ 贴出来的东西照样落在**视野里**（落点规矩对两条路都要成立）。 */
        const vis2 = await ev(`window.__clip.onScreen()`)
        if (vis2 && vis2.n >= 1 && vis2.n === vis2.visible) {
          ok(`点按钮贴出来的东西也落在**视野里**（${vis2.visible}/${vis2.n} 在舞台矩形内）—— 和 Ctrl+V 同一个落点规矩`)
        } else {
          bad(`点按钮贴出来的东西不在视野里：${JSON.stringify(vis2)} —— 两条路的落点算法分叉了`)
        }

        /* ★ 剪贴板**没被点坏**（点一下只该多一块东西，不该改写剪贴板本身）。 */
        const rawAfter2 = await ev(`window.__clip.raw()`)
        if (rawAfter2 && rawAfter2 === rawBefore) ok('点「⧉ 粘贴」没有改写剪贴板本身（还能接着往下一块板贴）')
        else bad('点「⧉ 粘贴」把剪贴板改写了 —— 第二次粘贴就贴不出原来的东西了')
      }

      /* ── ④ 第二处入口：**选区浮层**里那颗「⧉ 粘贴」（紧挨着「⧉ 复制」）────
         ★ 为什么要验第二处：工具条那颗管的是"**切到另一块板**"（那时没有选区、
           浮层根本不出现）；而"刚复制完、手还在原地"那种场景，最顺的是浮层里
           这一颗。两处 + Ctrl+V 共用**同一个 `pasteSel`**（见 Board.jsx 的接线），
           所以三处的"贴到哪儿"不会分叉。
         ★ 此刻浮层**应当正开着** —— 上一步 `pasteSel` 把焦点放在了刚贴出来的
           东西上（这是它的既定行为，见 Board.jsx `pasteSel` 末尾那次 setFocus）。
           所以不用另造一次框选，直接验就行。
           ⚠ 反过来说：**找不到它时要分清是哪一种**（浮层没开 / 按钮没接上）——
             混成一句话报出来会指错方向。
         ⚠ 判据和工具条那颗同一套：在不在、`elementFromPoint` 命中不命中。 */
      const ob = await ev(`(() => {
        const acts = document.querySelector('.bd-inkacts')
        const b = document.querySelector('.bd-inkacts .bd-inkpaste')
        if (!b) return { actsOpen: !!acts }
        const r = b.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
        const e = document.elementFromPoint(cx, cy)
        return {
          actsOpen: true, x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height),
          txt: (b.textContent || '').trim(),
          hit: e ? (e.className || e.tagName) : null,
          self: e === b || (e && e.closest ? e.closest('.bd-inkpaste') === b : false),
        }
      })()`)
      if (!ob || !ob.actsOpen) {
        bad('贴完东西之后选区浮层没开着 —— 这一节验不到浮层那颗「⧉ 粘贴」（`pasteSel` 应当把焦点放在刚贴出来的东西上）')
      } else if (ob.txt === undefined) {
        bad('选区浮层开着，但里面没有「⧉ 粘贴」（`.bd-inkpaste`）—— 第二处入口没接上')
      } else {
        if (ob.txt === '⧉ 粘贴') ok(`选区浮层里也有一颗「${ob.txt}」（紧挨着「⧉ 复制」—— 复制完顺手就能贴）`)
        else bad(`浮层里那颗按钮的字是 ${JSON.stringify(ob.txt)}，期望「⧉ 粘贴」`)
        if (ob.self) ok(`浮层里的「⧉ 粘贴」在 (${ob.x}, ${ob.y}) **点得到**（${ob.w}×${ob.h}，最上面就是它自己）`)
        else bad(`浮层里的「⧉ 粘贴」点不到 —— 那个位置最上面是 ${JSON.stringify(ob.hit)}`)
        /* ★ 点它一下，板上要多出一整块 —— 证明这颗也真的接上了（不是个摆设）。 */
        const n0 = await ev(`window.__clip.cards().length`)
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ob.x, y: ob.y, button: 'left', buttons: 1, clickCount: 1 })
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ob.x, y: ob.y, button: 'left', buttons: 0, clickCount: 1 })
        await s.sleep(400)
        const n1 = await ev(`window.__clip.cards().length`)
        const t1 = await ev(`window.__clip.toast()`)
        if (n1 === n0 + 1) ok(`点浮层里那颗「⧉ 粘贴」也贴上了（卡数 ${n0} → ${n1}）—— 两处入口真的都通`)
        else bad(`点浮层里那颗「⧉ 粘贴」之后卡数是 ${n1}（点之前 ${n0}），期望 ${n0 + 1} —— 浮层那颗没接上 pasteSel？`)
        if (/粘贴了/.test(t1)) ok(`浮层那颗说的话也是"粘贴了…"（${t1}）—— 三处（工具条 / 浮层 / Ctrl+V）共用同一句话`)
        else bad(`点浮层那颗之后界面没有说"粘贴了…"（实际说：${JSON.stringify(t1)}）`)
      }
    }

    /* ── [3] Ctrl+Z：粘贴是一步撤销 ───────────────────────────────────────
       ★★ 这一步的起点是**自己造出来的**，不依赖上一步剩下的状态（[2] 贴了一份、
          [2b] 又贴了一份）。原来的写法是"等板 B 盘上回到 0 笔" —— 那假定
          "此刻板 B 上正好只有一份贴进来的东西"，而 [2b] 一加进来这个前提就没了：
          板 B 变成两份，Ctrl+Z 只退得掉一份，报出来是"还有 2 笔"（**假红**）。
          ⇒ 退回去那一步真正管的事只有一件：**"贴一次 → 撤一次 → 干净"**。
            所以这里自己造局面：**先等板安静下来**（应用说「已存」）→ 记下此刻
            盘上的笔数 n0 → Ctrl+V（"+2"）→ Ctrl+Z（应当退回 n0）。

          ★★ 为什么开头要等「已存」、而且**不许等"恰好等于 n0+2"**（第一次就是栽在这儿）：
            自动保存是**防抖 + 合并**的 —— 盘上不会出现中间态。
            实测：进来时盘上 4 笔（[2b] 刚点完那一下还没落盘），Ctrl+V 之后
            内存是 8、一次防抖写盘直接从 **4 跳到 8**，于是"等盘上变成 6"永远等不到，
            报出来是"Ctrl+V 没多出两笔"—— 而 Ctrl+V 其实好好儿的（**假红**，
            还指错了方向：会让人去查粘贴，其实是存档节奏）。
            ⇒ 两条一起改：① 量基准前先等「已存」，盘上数和内存就对上了；
                       ② 判"变大了"用**严格大于**，别钉一个中间值。
            而"撤回 n0"这条能钉死 —— 它回到的是**刚才亲眼见过的**那个值，
            不是中途某个没人写过的数。

          ⚠ 为什么不用 Ctrl+Shift+Z 那条（重做）来收尾：这条要验的是"粘贴进撤销栈"，
            不是重做；多走一步只会多一个失败面。
          ⚠ 也别拿"板 B 是空的"当收尾判据 —— 那是[2]时代留下的巧合，
            夹具板改成非空的那天它就静默失效了（本仓库那条"断言的前提若是上一节
            留下的状态，就是颗雷"）。 */
    console.log('\n[3] Ctrl+Z：一次粘贴 = 一步撤销')
    {
      const readB3 = () => {
        try {
          return JSON.parse(fs.readFileSync(B_PATH, 'utf8'))
        } catch {
          return null
        }
      }
      /* ★ 先把板等安静：`.bd-save` 说「已存」= 写盘真的落地了。
         不等这一步，下面量到的 n0 会是"上一节还没落盘的旧数"，
         而后面的判据全建在一个过期的基准上。 */
      const quiet = await untilSaved({ timeout: 10000 })
      if (!quiet.ok) console.log('      （板一直没说「已存」—— 还是接着量，但基准可能偏旧）')

      /* 先看起点。读不到就明说跳过（别让"读不到"冒充"撤销坏了"）。 */
      const b0 = readB3()
      if (!b0) {
        bad('读不到板 B 的文件 —— 这一节没法验（不是撤销坏了，是夹具没落盘）')
      } else {
        const n0 = b0.strokes.length
        await CTRL_V()
        /* ★ 等盘上**严格变大**（不是等于 n0+2）：存档是防抖合并的，中间值不会出现。 */
        const added = await until(async () => {
          const d = readB3()
          return d && d.strokes.length > n0 ? d : undefined
        }, { what: 'Ctrl+V 之后盘上变多了（造撤销判据的起点）', timeout: 8000 })
        if (!added.ok) {
          bad(`Ctrl+V 之后盘上还是 ${n0} 笔（没变多）—— 撤销判据的起点没造出来`)
        } else {
          const n1 = added.value.strokes.length
          /* 现在撤一步：应当**正好退回 n0**（回到刚刚亲眼见过的那一版）。 */
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
            const d = readB3()
            return d && d.strokes.length === n0 ? d : undefined
          }, { what: 'Ctrl+Z 之后盘上退回贴之前那个数', timeout: 8000 })
          if (gone.ok) ok(`Ctrl+Z 把**这一次**粘贴整块收回去了（盘上从 ${n1} 笔退回 ${n0} 笔）—— 一次粘贴确实是一步`)
          else {
            const d = readB3() || {}
            bad(`Ctrl+Z 之后盘上是 ${(d.strokes || []).length} 笔，期望退回 ${n0} 笔（贴之前那版）—— 粘贴没进撤销栈，或者没退干净`)
          }
        }
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
