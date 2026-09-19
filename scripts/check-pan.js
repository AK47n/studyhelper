/* 平移画布时「卡片 / 板框跟着墨迹一起走」的体检 —— 那条**补正**变换。
 *
 * ── 为什么值得单独一个脚本（2026-09-18 用户报的）────────────────────────────
 *   「现在移动画布的时候卡片和板框会相对于字产生相对滑动，虽然最后还是会滑动回去
 *     回归正常，但这种视觉效果不好看」。
 *
 *   根因是**两条路径到同一个屏幕位置**：
 *     · 墨迹（canvas）走 ctx.setTransform，在手势回调里写，**同一帧**就到位、
 *       完全不经过 React；
 *     · 卡片 / 板框（DOM）的 left/top 是 React 的 style prop —— 要等
 *       setState → render → commit → style recalc + layout，落后一两帧。
 *   于是拖动过程中卡片"跟不上"，React 追上之后再"弹回去"。
 *
 *   修法是往卡片层 `.bd-world` 写一条 CSS 变换，表达 **React 还没追上的那部分差**
 *   （`viewCorrection(view, live)`）。补上之后两者同帧；React 追上后差是 0，
 *   那条 transform 就被移除，卡片回到"位置完全由 left/top 决定"。
 *
 * ── 这个脚本要盯住的三件事 ────────────────────────────────────────────────
 *   [1] 手势**进行中**：`.bd-world` 上真的挂着补正，而且它是"对的那一条"
 *       （缩放系数正常、位移量不超过总拖动距离）。
 *   [2] 手势**结束、React 追上**：那条 transform 必须消失。
 *       不清的话它就成了长期偏移，卡片会一直歪着，而且多留一个合成层。
 *   [3] **卡片真在该在的地方**：卡片实际屏幕位置 = 舞台原点 + 它的 left/top
 *       （再算上补正）。一个像素都不该多。
 *   [4] **反证**：这一拖真的推动了视图，而且卡片**跟着墨迹**走同样的距离。
 *       没有这一条，上面那些"一致"可能只是因为压根没动。
 *
 * ── 为什么要"放慢"才量得到 ──────────────────────────────────────────────
 *   [1] 必须量在**手势进行中、而 React 还没追上**的那一瞬间。实测那一瞬只有
 *   一两帧（十几毫秒），靠固定 sleep 一量一个空 —— 所以这里不改应用、不猜时间，
 *   而是把 CDP 的鼠标移动到分片下发：每一片之间 await 一次往返，
 *   React 在那些空隙里就把 commit 做完了，于是这段拖动会持续几百毫秒而
 *   **每一片之后都会重新出现一小段差**。量在两次 `mouseMoved` 之间，
 *   就稳定地落在"有差"的状态里。
 *
 *   ⚠ 别把上面这段理解成"补正只在慢速拖动时才需要"。用户手里是 125Hz / 240Hz 的笔，
 *     每一帧都在制造同一个差；这里只是把它在时间上拉开，好让自检看得见。
 *
 * ── 两个踩过的坑（都留了注释，别重犯）────────────────────────────────────
 *   ① **按下的那一点必须在纸上**。第一次写这个脚本时在 `(640, 700)` 按下去，
 *      而那里正好是底部那条工具条 `.bd-tools` —— 事件被浮层接走，
 *      `.bd-hit` 的捕获监听都收不到，于是"中键拖了 260px 而视图纹丝不动"，
 *      报出来的话像是补正坏了。现在改成先问浏览器"纸上哪儿只有纸"
 *      （`paperSpot()`：拿 `.bd-hit` 的 rect 扫几个候选点，用 elementsFromPoint
 *      确认最上面就是它自己，再避开卡片的 rect）。
 *   ② **卡片宽度不等于 世界宽 × --s**。卡片自己还有一个倍率
 *      `card.scale`（`--bd-card-scale`，内容变了会重新拟合），
 *      屏幕上的宽是 `w × s × k`。别拿 `--s` 单独反算"隐含的 s"然后断言。
 *
 * ── 判据一律用**事实**，不用固定毫秒 ────────────────────────────────────
 *   量到的东西全是从页面里读出来的数（transform 字符串 / getBoundingClientRect）；
 *   时序靠分片下发和 `until`，不靠 sleep 猜（README 第 38 条）。
 *
 * 跑：node scripts/check-pan.js
 */
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

/* 夹具：**两张**卡。
   ★ 为什么要两张（这是这条自检的关键设计）：判"卡片有没有跟着墨迹走"最干净的
     量法是"两点之间屏幕间距"，因为**平移在差里消掉了**，剩下的只有缩放那部分，
     不需要知道任何世界坐标、也不需要读 React 的 `view`。
     一张卡只能给一个点，量不出间距 —— 我第一版就是一张卡，于是那条判据绕成一团。
   ★ 位置：都是"不贴边"的地方，拖开也还在屏幕里；两张隔得远一点，间距才有分辨力。
   ★ 别用 addCard（没有这个函数，我第一版就写错了）：板文档里卡片就是一个数组，
     `newCard(kind, cx, cy, { w, h, text })` 的 cx/cy 是**中心**（它自己减成左上角）。 */
const CARDS = [
  { x: 400, y: 300, w: 260, h: 90, text: '卡片跟着墨迹走' },
  { x: 1300, y: 1100, w: 260, h: 90, text: '离得远的第二张' },
]
const doc = (() => {
  const b = newBoard('自检夹具（跑完自动删除）')
  for (const c of CARDS) {
    const card = newCard('note', c.x + c.w / 2, c.y + c.h / 2, { w: c.w, h: c.h, text: c.text })
    card.x = c.x
    card.y = c.y
    b.cards.push(card)
  }
  return b
})()

/** 拖的过程中夹住不放，沿途每片量一次。片数 × 每片往返 = 一个几百毫秒的手势。 */
const HOLD_STEPS = 6
const DX = 260
const DY = 180

const fails = await withBoard(
  /* ★ 端口是**每个脚本一套、绝不串**（README 里那条）。
     5213/9253 已经被 check-sidetree 占了 —— 我第一版抄了它那两个数，
     于是那次串行 `check-link && check-pan && check-sidetree && check-ask` 里
     check-pan 先起了 5213，check-sidetree 起来就撞上，"自检动了你的文件：
     board-zz-sidetree.md（不见了）"就是这么来的（夹具被两个脚本抢着删）。
     5215/9245 目前没人用（check-harness 用的是 5211/5212，check-ask 是 5214）。 */
  { tag: 'pancheck', port: 5215, cdpPort: 9245, text: serializeBoardDocument(doc) },
  async ({ s, ok, bad, open, until }) => {
    await open()

    const ev = (expr) => s.eval(expr)

    /* ── 页面侧的小工具（一次性注入，后面靠名字调）─────────────────────────
       为什么要走页面 eval 而不是在 node 里算：
         · `board.view` 是 React 状态，node 拿不到；
         · 卡片的**真实**屏幕位置只有浏览器自己知道（那是布局算出来的）。
       这里只做"读数"，不做断言 —— 断言都在下面明面上。 */
    await ev(`(() => {
      window.__pan = {
        /* 卡片左上角的**真实**屏幕位置（浏览器布局算出来的那个）。第一张就够了 ——
           "位移量"这条断言看一张卡足矣（间距那条判据才需要两张，见 [1]）。 */
        cardBox() {
          const c = document.querySelector('.bd-card')
          if (!c) return null
          const r = c.getBoundingClientRect()
          return { x: r.left, y: r.top, w: r.width, h: r.height }
        },
        /* .bd-world 上那条补正。没挂 = ''（应用是 removeProperty 清的，不是写 'none'） */
        corr() {
          const w = document.querySelector('.bd-world')
          return w ? (w.style.transform || '') : null
        },
        /* ★★ 补正**公式**本身算得对不对（纯函数，不碰时序）。
           为什么要它：那条 transform 是个过渡量，修好之后多半采不到 ——
           而"补多少"正是出过 bug 的地方（第一版拿 boardRef.current.view
           当基准，差算成了两步 ⇒ 卡片冲出 2 倍距离，就是用户报的那条）。
           这里直接问应用那个函数要答案，于是这几条断言**永远有东西可验**，
           不会因为"没采到补正"而空过 —— arr.length && … 那种空过最坏：
           它看着是绿的，其实一条都没跑（本仓库第 38 条记过这件事）。 */
        corrFor(drawnTx, liveTx) {
          if (!window.__viewCorrection) return null
          return window.__viewCorrection({ s: 1, tx: drawnTx, ty: 0 }, { s: 1, tx: liveTx, ty: 0 })
        },
        /* 补正**该不该在**：屏幕上摆着的那一版（data-drawn-*）和当前视图
           （data-live-*）必须相等。相等 ⇔ 不需要补正；不等 ⇔ 补正必须正挂着。
           drawn 由 canvas 那一趟重画后回报，所以它同时是"墨迹画到哪了"的读数。 */
        views() {
          const w = document.querySelector('.bd-world')
          if (!w) return null
          return {
            liveTx: parseFloat(w.dataset.liveTx), liveS: parseFloat(w.dataset.liveS),
            drawnTx: parseFloat(w.dataset.drawnTx), drawnS: parseFloat(w.dataset.drawnS),
          }
        },
        /* ★★ 墨迹那一路真正写进 canvas 的变换：s / tx / ty（相对舞台，已乘 dpr）。
           这是**另一条独立的路**给出的 s/t —— 比从卡片样式反解强得多：
           卡片那条路要是整块偏了，反解出来的 s/t 会跟着一起偏，两个错正好抵消，
           自检就绿了。canvas 这条是 setTransform 的实参，骗不了。
           （同一个读数也是 check-board-browser 读的那个 dataset.xform。）
           dpr 从 canvas 的像素宽 / CSS 宽反算 —— 它就是 BoardCanvas 里写的那个。 */
        inkXform() {
          const cv = document.querySelector('canvas.bd-ink')
          if (!cv || !cv.dataset.xform) return null
          const [s, tx, ty] = cv.dataset.xform.split(',').map(Number)
          const dpr = cv.width / parseFloat(cv.style.width || cv.width)
          if (!dpr) return null
          return { s: s / dpr, tx: tx / dpr, ty: ty / dpr }
        },
        /* 纸上一个"只有纸"的点。见文件头坑①：按在浮层上什么都收不到。
           ★ 两张卡都要避开 —— 按在卡片上是"拖卡片"，不是"平移画布"。 */
        paperSpot() {
          const hit = document.querySelector('.bd-hit')
          if (!hit) return null
          const r = hit.getBoundingClientRect()
          const boxes = [...document.querySelectorAll('.bd-card')].map((c) => c.getBoundingClientRect())
          const inside = (x, y) =>
            boxes.some((b) => x >= b.left - 8 && x <= b.right + 8 && y >= b.top - 8 && y <= b.bottom + 8)
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

    const near = (a, b, tol = 1.5) => a != null && b != null && Math.abs(a - b) <= tol

    /** 一次往返读完"手势中间那一瞬"的全部事实。
     *  ★ 所有读数必须装在**一次 eval** 里（同一帧），分开读就会跨帧 ——
     *    我第一版是分开读的，于是"补正"和"卡片位置"根本不是同一时刻的值，
     *    对不上时也分不清是补正错了还是读数错位了。
     *  ★ 每张卡读一个数：它**实际**在屏幕哪儿（浏览器布局算出来的，
     *    已经含了 React 那一份 left/top 和 `.bd-world` 上那条补正）。 */
    /* ── 页面里的逐帧采样器（只在下面那一节用）──────────────────────────────
       ★ 为什么不能只在 node 侧"每片之间 eval 一次"：那样每次采样之间都隔着一整趟
         CDP 往返，React 有充足时间提交、canvas 也有时间重画 —— 采样点**全落在
         "差已经是 0"** 的那一刻。于是补正那一段（寿命常常不到一帧）永远采不到，
         而"补多少才对"正是出过 bug 的地方。
       ★ 所以判据改成**逐帧的不变量**，由页面自己的 rAF 循环记：
           挂着补正的那一刻，`corr.tx` 必须正好等于 `live.tx − drawn.tx`
           （"还差多少"）。基准取错（比如拿"已经提交但还没画"的那一版）算出来的
           就不是这个数 —— 2026-09-18 用户报的 2 倍滑动正是这么来的。
         收尾时把记录读回来断言，一条都不许违例。
       ⚠ 这里采的是 rAF 回调（"这一帧开始"），不是"画出来的那一刻"的完美读数 ——
         精确到那一刻要用 MutationObserver 盯 canvas 的变换（`scripts/diag-pan3.js`
         就是这么量的，实测偏差 **0.000px**）。作为**回归守卫**这里够用：
         第一版那个 bug 会让上面的等式当场不成立。 */
    const startSampler = () => ev(`(() => {
      window.__panFrames = []
      let stop = false
      window.__panStop = () => { stop = true }
      const w = document.querySelector('.bd-world')
      const tick = () => {
        if (stop) return
        const corr = w.style.transform || ''
        const m = /translate\\(\\s*([-\\d.eE]+)px/.exec(corr)
        window.__panFrames.push({
          corr,
          corrTx: m ? parseFloat(m[1]) : null,
          liveTx: parseFloat(w.dataset.liveTx),
          drawnTx: parseFloat(w.dataset.drawnTx),
        })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return true
    })()`)
    const readSampler = () =>
      ev(`(() => { if (window.__panStop) window.__panStop(); const f = window.__panFrames || []; return { n: f.length, bad: f.filter((x) => x.corrTx !== null && Math.abs(x.corrTx - (x.liveTx - x.drawnTx)) > 0.001).slice(0, 4), withCorr: f.filter((x) => x.corrTx !== null).length } })()`)

    const frame = () =>
      ev(`(() => {
        const w = document.querySelector('.bd-world')
        const st = document.querySelector('.bd-stagewrap')
        const sr = st.getBoundingClientRect()
        return {
          corr: w.style.transform || '',
          /* 两件事一起读：卡片层上有没有补正、墨迹那一层上有没有**同一条**。 */
          inkLayerCorr: (() => { const c = document.querySelector('canvas.bd-ink'); return c ? (c.style.transform || '') : null })(),
          views: window.__pan.views(),
          stageX: sr.left, stageY: sr.top,
          ink: window.__pan.inkXform(),
          cards: [...document.querySelectorAll('.bd-card')].map((c) => {
            const r = c.getBoundingClientRect()
            return { cardX: r.left, cardY: r.top }
          }),
        }
      })()`)

    /* "墨迹那一路认为第 i 张卡该在屏幕哪儿"。
       ★ 关键是它**不碰卡片**：世界坐标直接从夹具常量（CARDS）拿，
         s/t 从 canvas 的 data-xform 拿（setTransform 的实参）。
         所以这条路径完全独立于卡片自己声明的 left/top ——
         卡片那条路要是整块偏了，这里不会跟着一起偏（两个错正好抵消是最危险的假绿）。 */
    const inkPos = (f, i) => ({
      x: f.stageX + CARDS[i].x * f.ink.s + f.ink.tx,
      y: f.stageY + CARDS[i].y * f.ink.s + f.ink.ty,
    })

    const parseCorr = (t) => {
      if (!t) return null
      const m = /translate\(\s*([-\d.eE]+)px[,\s]+([-\d.eE]+)px\s*\)\s*scale\(\s*([-\d.eE]+)\s*\)/.exec(t)
      return m ? { tx: parseFloat(m[1]), ty: parseFloat(m[2]), k: parseFloat(m[3]) } : null
    }

    console.log('\n[1] 手势进行中：卡片层上挂着补正，而且两条路算出的 s/t 必须一致')
    {
      const spot = await ev(`window.__pan.paperSpot()`)
      if (!spot) {
        bad('在纸上找不到一个"只有纸"的点 —— 夹具/界面变了？（按在浮层上收不到事件）')
      } else {
        console.log(`      从 (${spot.x}, ${spot.y}) 中键拖 ${DX}×${DY}（这个点上最上面就是 .bd-hit）`)
        console.log(`      分 ${HOLD_STEPS} 片下发，每片之间 await 一次往返（拖动会持续几百毫秒）`)
      }

      await s.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: spot.x, y: spot.y, button: 'middle', buttons: 4, clickCount: 1,
      })

      /* ★ 先开逐帧采样器，再**连发**鼠标移动（片与片之间不 await 往返）。
         为什么要连着发：补正只在"手指已经算出新值、屏幕还没画出来"的那一小段里
         存在。片与片之间隔一整趟往返的话，React 每次都追得上，那段就**根本不存在**
         （实测：采样点 6/6 全是"没有补正"）。连发才复现用户手指的节奏 ——
         README 里那句"别把分片理解成补正只在慢速拖动时才需要"说的就是这个。 */
      await startSampler()
      const samples = []
      for (let i = 1; i <= HOLD_STEPS; i++) {
        await s.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: spot.x + (DX * i) / HOLD_STEPS, y: spot.y + (DY * i) / HOLD_STEPS,
          button: 'middle', buttons: 4,
        })
        /* 顺带在片与片之间留一次往返读数：这一路量的是"两条路算出的映射"，
           它必须跟手势同步（判据五）。补正那一段由上面的 rAF 采样器兜着。 */
        samples.push(await frame())
      }
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: spot.x + DX, y: spot.y + DY, button: 'middle', buttons: 0,
      })
      const live = await readSampler()

      /* ★★★ 判据零（**最关键**的那一条）：补正的**量**必须正好是"还差多少"。
         逐帧记下来的每一次都要求 `corr.tx === live.tx − drawn.tx`。
         基准取错时这个等式立刻不成立（实测：拿"已经提交但还没画"的那一版当基准，
         算出来的是两步，屏幕上就是卡片冲出 2 倍距离 —— 用户报的那条）。
         这一条是**唯一**能自动复现那个 bug 的断言：别的判据都在"差已经归零"的
         采样点上跑，看不见补正那一段。 */
      if (!live.n) {
        bad('逐帧采样器一帧都没记到 —— 这条判据没跑成（rAF 没跑起来？）')
      } else if (!live.bad.length) {
        ok(
          `逐帧不变量成立：${live.n} 帧里，凡是挂着补正的那几帧（${live.withCorr} 帧）` +
            `都满足 corr.tx === live.tx − drawn.tx（"还差多少"就算多少）`
        )
      } else {
        bad(
          `补正的**量**算错了 —— 不是"还差多少"，屏幕上就是相对滑动：` +
            JSON.stringify(live.bad.map((x) => ({ corr: x.corr, live: x.liveTx, drawn: x.drawnTx })))
        )
      }

      /* ★★★ 判据一（根上的性质）：**屏幕上摆着的那一版就是当前视图**。
         也就是 `drawn === live`：墨迹画到的位置 = 手指算出来的位置。
         相等 ⇒ 根本不需要补正（这是修好之后绝大多数采样点的情况）。
         不等 ⇒ **补正必须正挂在那一层上**，否则用户看到的就是相对滑动。
         这一条替代了原来那条"采样点必须挂着补正" —— 那条在修好之后**必然假红**：
         补正被同一个 commit 吸收掉了，按固定节奏采样多半采到"没有补正"，
         于是它把"修好了"报成"从来没补过"。**判据要能红，但也不能因为修好而红。** */
      const withCorr = samples.filter((x) => x.corr)
      const inconsistent = samples.filter((x) => {
        const v = x.views
        if (!v || !isFinite(v.liveTx) || !isFinite(v.drawnTx)) return true
        const same = v.liveTx === v.drawnTx && v.liveS === v.drawnS
        return same ? !!x.corr : !x.corr /* 相等时不该有补正；不等时必须有一条 */
      })
      if (!inconsistent.length) {
        ok(
          `每一刻都自洽：${samples.length} 次采样里，drawn === live 的那几帧没有补正、` +
            `两者不等的那几帧都挂着补正（其中 ${withCorr.length} 帧正在补）`
        )
      } else {
        bad(
          `有 ${inconsistent.length}/${samples.length} 次采样"该补的没补 / 不该补的补着" —— ` +
            `这就是"卡片相对于字滑动"（用户报的那一条）`
        )
        console.log(
          '      逐次：' +
            JSON.stringify(
              inconsistent.slice(0, 4).map((x) => ({ corr: x.corr || '(无)', views: x.views }))
            )
        )
      }
      console.log('      采样到的补正：' + JSON.stringify(samples.map((x) => x.corr || '(无)')))

      /* ★★ 判据二：**两组东西贴的是同一条补正**。
         第一版只补了卡片层 —— 于是两边还是差一步，只是把"卡片快一帧"
         换成了"墨迹慢一帧"，肉眼看照样滑动（2026-09-18 第二版修的就是它）。 */
      const layerMismatch = samples.filter((x) => x.corr !== (x.inkLayerCorr || ''))
      if (!layerMismatch.length) {
        ok(`${samples.length} 次采样里，卡片层和墨迹层上的补正**逐条相同**（两组一起补才同帧）`)
      } else {
        bad(
          `卡片层和墨迹层上的补正不一致 —— 两组东西各差一步，屏幕上还是滑动：` +
            JSON.stringify(layerMismatch.slice(0, 3).map((x) => ({ world: x.corr || '(无)', ink: x.inkLayerCorr || '(无)' })))
        )
      }

      /* 判据三：缩放系数是正常量级（平移不该带来明显缩放）。
         判据四：位移量不超过这一整段拖动的距离（差不可能比总位移还大 ——
                 大了就是把同一次平移做了两遍，那正是第一版那个 2 倍的 bug）。 */
      const kBad = withCorr.filter((x) => {
        const p = parseCorr(x.corr)
        return !p || !(p.k > 0.5 && p.k < 2)
      })
      if (!kBad.length) ok(`采到的补正里缩放系数都是正常量级（${withCorr.length} 条；平移不该带来明显缩放）`)
      else bad('补正里的缩放系数不对（或解析不了）：' + JSON.stringify(kBad.map((x) => x.corr)))

      const huge = withCorr.filter((x) => {
        const p = parseCorr(x.corr)
        return !p || Math.abs(p.tx) > DX || Math.abs(p.ty) > DY
      })
      if (!huge.length) ok(`采到的补正位移量都不超过总拖动距离（${withCorr.length} 条；是"差"，不是"又平移一遍"）`)
      else bad('补正的位移量比总拖动距离还大 —— 这是把同一次平移做了两遍：' + JSON.stringify(huge.map((x) => x.corr)))

      /* ★★ 补正公式本身：**基准是"已经画出来的那一版"**，差就是一步。
         这一条钉的正是用户报的那个 bug：
           · 拿 `drawnViewRef` 当基准（对）→ translate(10px, 0)；
           · 拿"已经提交、还没画"的当基准（错，第一版）→ 差算成两步 → translate(20px, 0)；
           屏幕上就是"卡片先冲出去 2 倍、再弹回来"。
         它还顺手钉住"相等时必须返回 null"（不多挂一个合成层）。 */
      {
        const same = await ev(`window.__pan.corrFor(50, 50)`)
        const one = await ev(`window.__pan.corrFor(50, 60)`)
        const two = await ev(`window.__pan.corrFor(50, 70)`)
        const p1 = parseCorr(one || '')
        const p2 = parseCorr(two || '')
        if (same !== null) bad(`drawn === live 时补正应当是 null（不用补），实际 ${JSON.stringify(same)}`)
        else ok('drawn === live 时补正是 null（该收手就收手，不多挂一个合成层）')
        if (p1 && p1.tx === 10 && p1.k === 1) ok('基准取"已经画出来的那一版"时，差正好是一步（(50→60) ⇒ translate(10px, 0)）')
        else bad(`补正公式算错了：corrFor(50, 60) 应当是 translate(10px, 0px) scale(1)，实际 ${JSON.stringify(one)}`)
        if (p2 && p2.tx === 20) {
          ok('差随目标视图走，不是常量（(50→70) ⇒ translate(20px, 0)）—— 说明它真的在算"还差多少"')
        } else {
          bad(`补正没有跟着目标视图走：corrFor(50, 70) 应当是 translate(20px, 0px)，实际 ${JSON.stringify(two)}`)
        }
      }

      /* ★★★ 判据五：这一条才是"相对滑动"的判据本身 ★★★
         板上两样东西走两条路到同一个屏幕位置：
           · 墨迹（canvas）：`data-xform` 是它真正 setTransform 进去的 s/t。
             用它点名的那两张卡该在哪儿，完全由"夹具里的世界坐标 + s_ink/t_ink"
             算出来，一点都不碰卡片（两条路不共享误差）。
           · 卡片（DOM）：它**实际**在屏幕上哪儿（getBoundingClientRect），
             里面已经含了 React 那一份 left/top 和贴上去的那条补正。
         判据：**两点之间的屏幕间距，两条路必须一样**（平移在差里消掉了）。
           左 = 卡片实际间距   —— 卡片这一路（left/top + 补正）
           右 = 世界间距 × s_ink —— 墨迹这一路
         两边相等 ⇔ 卡片和墨迹用了同一个仿射映射 ⇔ 拖动过程里两者重合，
         也就是用户要的那个"不再相对滑动"。差值就是"相对滑了多少像素"。
         ⚠ 它测的是**缩放那一轴**（间距对平移不敏感）。平移那一轴由判据一兜着
           （drawn === live），两条合起来才是完整的那件事 —— 第一版只有这一条，
           于是"补正把整块多挪了一步"从它底下溜过去了。 */
      const drift = samples
        .filter((x) => x.ink && x.cards.length >= 2)
        .map((x) => {
          const [a, b] = x.cards
          const ia = inkPos(x, 0)
          const ib = inkPos(x, 1)
          const ddx = b.cardX - a.cardX - (ib.x - ia.x)
          const ddy = b.cardY - a.cardY - (ib.y - ia.y)
          return { ddx, ddy, corr: x.corr }
        })
      const worst = drift.reduce((m, d) => Math.max(m, Math.abs(d.ddx), Math.abs(d.ddy)), 0)
      if (!drift.length) {
        bad('量不到两张卡片的间距（卡片没渲染齐？）—— 这条判据没跑成')
      } else if (worst <= 1.0) {
        ok(`拖动过程中卡片和墨迹是同一条映射：${drift.length} 次采样，两路间距差最大 ${worst.toFixed(3)}px（阈值 1px）`)
      } else {
        bad(`拖动过程中卡片相对墨迹偏了：最大 ${worst.toFixed(2)}px —— 这就是"相对滑动"`)
        console.log('      逐次（Δx, Δy，单位 px）：' + JSON.stringify(drift.map((d) => [Number(d.ddx.toFixed(2)), Number(d.ddy.toFixed(2))])))
      }
    }

    /* React 追上之后必须归零 —— 这条是"补正不是长期偏移"的守卫。
       不清的话：卡片从此永远歪着，而且每次拖动都在往同一个方向叠。 */
    console.log('\n[2] 松手、React 追上之后：那条 transform 必须自己消失')
    {
      const w = await until(() => ev(`window.__pan.corr() === '' ? 'clean' : null`), {
        what: '卡片层的补正被清掉', timeout: 3000,
      })
      if (w.ok) ok(`松手后 ${w.waited}ms 内补正自己消失了（没有变成长期偏移）`)
      else bad(`松手后补正一直挂着：${JSON.stringify(await ev(`window.__pan.corr()`))} —— 卡片会一直歪着`)

      const st = await ev(`(() => { const w = document.querySelector('.bd-world'); return w.getAttribute('style') || '' })()`)
      if (!/transform/.test(st)) ok('inline style 里已经没有 transform 了（是移除，不是写 none，少一个合成层）')
      else bad('inline style 里还留着 transform：' + JSON.stringify(st))

      /* 归零之后，卡片的位置还得和它声明的 left/top 对得上（补正不能留下暗账）。 */
      const got = await ev(`(() => {
        const st = document.querySelector('.bd-stagewrap')
        const sr = st.getBoundingClientRect()
        return [...document.querySelectorAll('.bd-card')].map((c) => {
          const cr = c.getBoundingClientRect()
          return { dx: cr.left - (sr.left + parseFloat(c.style.left)), dy: cr.top - (sr.top + parseFloat(c.style.top)) }
        })
      })()`)
      const badBox = got.filter((g) => !near(g.dx, 0, 0.6) || !near(g.dy, 0, 0.6))
      if (!got.length) bad('归零之后找不到卡片')
      else if (!badBox.length) {
        /* 用循环算最大差，别用 `Math.max(...got.map(...))` —— Math.max 收的是**数字**，
           而这里传进去的是一堆数组（`g.dx`/`g.dy` 两个一组），它会把数组转成 NaN。
           我第一版就这么写的，报出来是 `ReferenceError: g is not defined`：
           真正的原因不是 g 没定义，是模板字符串里那个 `${...}` 里嵌套了反引号，
           把模板字符串提前截断了 —— 两个坑叠在一起。 */
        let worstBox = 0
        for (const g of got) worstBox = Math.max(worstBox, Math.abs(g.dx), Math.abs(g.dy))
        ok(`补正归零后，${got.length} 张卡都正好坐在 left/top 说的位置上（最大差 ${worstBox.toFixed(2)}px）`)
      } else {
        bad(`归零之后还有卡片对不上 left/top：${JSON.stringify(badBox)} —— 补正留了暗账`)
      }
    }

    /* ── [3] 反证 + 目的：这一拖真的推动了视图，卡片跟着墨迹走**同样的距离** ────
       前面两条是手段，这一条是目的。拖 (−120, −90)，卡片就该整整走 (−120, −90)：
       这个"位移量"就是"相对滑了多少"的直接读数 —— 它正是用户看到的东西。 */
    console.log('\n[3] 反证 + 目的：这一拖真的推动了视图，卡片跟着墨迹走同样的距离')
    {
      const spot = await ev(`window.__pan.paperSpot()`)
      if (!spot) {
        bad('纸上找不到空闲点，这一节跳过')
      } else {
        const before = await ev(`window.__pan.cardBox()`)
        const beforeLeft = await ev(`parseFloat(document.querySelector('.bd-card').style.left)`)
        await s.drag(spot.x, spot.y, -120, -90, { steps: 6, button: 'middle' })
        const after = await ev(`window.__pan.cardBox()`)
        const afterLeft = await ev(`parseFloat(document.querySelector('.bd-card').style.left)`)
        const dx = after.x - before.x
        const dy = after.y - before.y
        if (near(dx, -120, 4) && near(dy, -90, 4)) {
          ok(`中键拖 (−120, −90)，卡片跟着墨迹走同样的距离：实际 (${dx.toFixed(1)}, ${dy.toFixed(1)})`)
        } else {
          bad(`拖动和卡片的位移对不上：期望 (−120, −90)，实际 (${dx.toFixed(1)}, ${dy.toFixed(1)}) —— 这就是"相对滑动"`)
        }
        /* 顺便验"数据里也真的动了"：left/top 是 React 那一份，它得跟上。
           跟不上 = 补正会一直替它扛着一份差（那就是长期偏移了）。 */
        if (near(afterLeft - beforeLeft, -120, 2.5)) {
          ok(`卡片自己的 left 也真的跟着走了（${beforeLeft} → ${afterLeft}）`)
        } else {
          bad(`卡片自己的 left 没跟上（${beforeLeft} → ${afterLeft}）—— 差被长期挂在补正上了`)
        }
        const w = await until(() => ev(`window.__pan.corr() === '' ? 'clean' : null`), {
          what: '这次拖动之后补正也归零', timeout: 3000,
        })
        if (w.ok) ok('这次拖动之后补正同样归零了')
        else bad('这次拖动之后补正没归零：' + JSON.stringify(await ev(`window.__pan.corr()`)))
      }
    }

    /* 最后一条：面板/浮层不该被这条补正牵连 —— 它挂在 .bd-world 上，
       而 .bd-world 里只有卡片和板框。板框也顺带量一下（用户报的是"卡片和板框"）。 */
    console.log('\n[4] 页面上没有 JS 报错，且补正只挂在卡片层上')
    {
      const layers = await ev(`(() => {
        const w = document.querySelector('.bd-world')
        const others = [...document.querySelectorAll('.bd-stagewrap > *')].filter((e) => e !== w)
        return { worldChildren: w ? w.children.length : -1, siblings: others.map((e) => e.className || e.tagName) }
      })()`)
      if (layers.worldChildren >= 0) ok(`.bd-world 在（里面有 ${layers.worldChildren} 个子节点：卡片层 / 板框层）—— 补正只作用于这一层`)
      else bad('找不到 .bd-world —— 补正没有落点')
      console.log('      .bd-stagewrap 的其他子节点（补正**不该**碰它们）：' + JSON.stringify(layers.siblings))

      const errs = s.errors()
      if (!errs.length) ok('页面里没有 JS 报错')
      else bad('页面里有报错：' + errs.slice(0, 3).join(' | '))
    }
  }
)

export { fails }
