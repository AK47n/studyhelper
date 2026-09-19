/* 应用自己的询问框（从前是浏览器的 `prompt`/`confirm`）—— 真浏览器自检。
 *
 * 为什么要有这一条（2026-09-17）：
 *   用户给的截图里，点「＋ 分层」弹出来的是**浏览器**那个框 ——
 *   顶上写着 `127.0.0.1:5177 显示` 和一排系统按钮，还**把整个界面盖住**：
 *   正在整理的那棵树一点都看不见，而这里问的偏偏就是"放进哪一层"。
 *   换成自己画的之后，新出现的风险有两类，纯逻辑自检都碰不到：
 *     ① 它其实是**原生**弹窗（换个皮就交差）—— 那种"点了没反应"，headless 里
 *        会被当成"没有框"静默跳过，报出来还是绿的；
 *     ② 自己画的框**挡住 / 吃掉**了底层交互（比如整层遮罩把树的点击全拦了）。
 *
 * ★ 它造的那一层叫 `zz-ask`（一眼看得出是自检造的），跑完整棵删掉 ——
 *   名字闸：`data/zz-ask` 这个名字对不上就一个都不删。
 *   用户 `data/` 里的东西一个字节都不动（withBoard 的守卫会报红）。
 *
 * 用法：node scripts/check-ask.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA, withBoard } from './lib/board-check.js'

const NEWFOLDER = 'zz-ask 新建的' /* ④ 靠回车建出来的那一层（夹具板在根上，所以也落在根上） */

const fails = await withBoard(
  { tag: 'ask', port: 5214, cdpPort: 9254 },
  async ({ s, ok, bad, open, after, until }) => {
    /* 收尾：把自检造出来的那一层删掉。
       ★ **只有这一条会往盘上写东西**（④ 回车建出来的 `zz-ask 新建的`；
         夹具板本身由 withBoard 按 board-zz-* 的名字闸删）。
         所以这里的名字闸就是"只删 `NEWFOLDER` 这一个名字"，
         对不上就什么都不删 —— 宁可留个垃圾，也不能因为"路径拼错了"去动用户的东西
         （这就是 README 里"先问删的是谁的"那个坑）。
       ⚠ 顺带把"取消不许交字"那条留下的 `zz-不该被建出来` 也清掉（正常它不该存在）。 */
    after(() => {
      for (const name of [NEWFOLDER, 'zz-不该被建出来']) {
        const target = path.join(DATA, name)
        if (path.basename(target) !== name || !fs.existsSync(target)) continue
        const st = fs.statSync(target)
        if (!st.isDirectory()) continue /* 只删目录，不碰任何文件 */
        try {
          fs.rmSync(target, { recursive: true, force: true })
        } catch {}
      }
    })

    /* ① 页面在被自检碰之前，得先确认"没有开着任何询问框" ——
       不然下面那些"打开了吗"的断言是在说上一屏留下的东西。 */
    await open()
    const 无框 = await s.eval(`!!document.querySelector('.askwrap')`)
    if (!无框) ok('打开页面时没有询问框挡着（它是按需出现的，不是常驻浮层）')
    else bad('一进来就有一个询问框摆在那儿')

    /* ② 张开耳朵听**原生弹窗**。哪怕将来某个分支改回 `prompt()`，
       也要在这里报红 —— 不能让它悄悄溜过去（headless 里原生弹窗会让整页卡住）。 */
    await s.eval(`(() => {
      window.__askDiag = { dialogs: 0, native: 0 }
      window.alert = () => { window.__askDiag.native++ }
      window.confirm = () => { window.__askDiag.native++; return true }
      window.prompt = () => { window.__askDiag.native++; return null }
      return true
    })()`)

    /* ③ 点「＋ 分层」→ 必须出现**我们自己的**那个框，而且文案是那条 spec 的。
       这正是截图里那一幕：从前这里弹的是浏览器的框。 */
    /* ⚠ clickByText **点完了**（它名字里那个 click 是真的），调用方别再补一下 ——
       补了就是双击：第二下落在刚弹出来的框上，正好把它关掉，
       而报出来却是"自己的框没出现"（2026-09-17 在这里白绕过一圈）。 */
    const clickByText = async (sel, text) => {
      const p = await s.eval(`(() => {
        for (const b of document.querySelectorAll(${JSON.stringify(sel)})) {
          if (b.textContent.includes(${JSON.stringify(text)})) {
            const r = b.getBoundingClientRect()
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          }
        }
        return null
      })()`)
      if (!p) return null
      await s.mouse(p.x, p.y)
      return p
    }

    const btn = await clickByText('.side-sec .side-title button', '分层')
    if (!btn) bad('左栏顶上那颗「＋ 分层」找不到了')
    else {
      const up = await until(
        async () => {
          const v = await s.eval(`(() => {
            const b = document.querySelector('.askwrap .ask')
            if (!b) return null
            return { title: (b.querySelector('.ask-title') || {}).textContent || '', focused: document.activeElement === b.querySelector('.ask-input') }
          })()`)
          return v && v.title ? v : undefined
        },
        { what: '自己的询问框弹出来了' }
      )
      if (up.ok) ok('点「＋ 分层」→ 弹的是**应用自己的**框（' + up.value.title + '）')
      else bad('点了「＋ 分层」，自己的框没出现：' + JSON.stringify(await s.eval(`!!document.querySelector('.askwrap')`)))
      if (up.ok && up.value.focused) ok('输入框自动聚焦（不用再点一下才能打字）')
      else if (up.ok) bad('输入框没拿到焦点 —— 得先点一下才能打字')
      /* 它长什么样：深色、圆角、有那颗主按钮 —— 至少确认这三样不是空的 */
      const look = await s.eval(`(() => {
        const b = document.querySelector('.askwrap .ask')
        if (!b) return null
        const cs = getComputedStyle(b)
        const prim = b.querySelector('.btn.primary')
        return { bg: cs.backgroundColor, radius: cs.borderRadius, primary: prim ? prim.textContent.trim() : null }
      })()`)
      if (look && look.primary) ok('框里有确定按钮（写着「' + look.primary + '」）')
      else bad('框里没有确定按钮：' + JSON.stringify(look))
      /* 关掉它，不然后面全被它拦着。★ 这里走**真鼠标点「取消」**，不走 eval 里的 .click()：
         "点取消会不会把打好的字交出去"是真 bug 的温床（取消键在 form 里天生是提交键），
         而那件事只有真鼠标 + 真命中测试才试得出来。 */
      const cancelAt = await s.eval(`(() => {
        const c = document.querySelector('.askwrap .btn')
        if (!c) return null
        const r = c.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      /* 先把光标放进输入框、打两个字 —— 让"取消会不会顺手把它交出去"这条有东西可交 */
      if (cancelAt) {
        await s.eval(`(() => { const i = document.querySelector('.askwrap .ask-input'); if (i) { i.focus(); i.select() } return true })()`)
        await s.send('Input.insertText', { text: 'zz-不该被建出来' })
        await s.mouse(cancelAt.x, cancelAt.y)
      }
      const gone = await until(
        async () => (!(await s.eval(`!!document.querySelector('.askwrap')`)) ? 'gone' : undefined),
        { what: '点取消把框关掉了' }
      )
      if (gone.ok) ok('真鼠标点「取消」→ 框关掉了')
      else bad('点了取消，框还赖着不走（坐标：' + JSON.stringify(cancelAt) + '）')
      /* ★ 取消 = 什么都没做。就算输入框里有字，也**不许**建出来：
         `<form method="dialog">` 里那个取消键天生是"提交键"，
         少了 submitter 那道判据，点取消会把它当"确定"用。 */
      await s.sleep(700)
      const leek = await s.eval(`fetch('/api/list').then((r) => r.json()).then((d) => d.folders)`)
      if (!(leek || []).includes('zz-不该被建出来')) ok('取消之后盘上没多出"zz-不该被建出来"（框里打的字没被顺手交出去）')
      else bad('点的是取消，却把输入框里的字当成结果建出来了：' + JSON.stringify(leek))
    }

    /* ④ 真打一个字、真按回车 → 这一层真的建出来。
       这里走的就是截图那条路，只是把浏览器弹窗换成了自己的框。
       ★ 落点要说清楚：框里那一格**预填了"当前所在的层 + /"**（这是有意的 ——
         一边看树一边打名字，接着往下写就行）。这次打开的是根上的夹具板
         （`board-zz-ask.md`），`parentPath` 给出来是空串，所以预填是空的，
         建出来的就是根上那一层 `zz-ask 新建的`。
         换一张在 `大物/电磁学/` 里的板来跑，预填就会是 `大物/电磁学/`。
         ⚠ 断言得跟着"预填"走：一开始我按 `zz-ask/zz-ask 新建的` 写，
           结果测试一直报"盘上没多出那一层"，而东西其实建对了 ——
           报出来的话还特别像功能坏了。 */
    const FIRST = 'zz-ask 新建的'
    const WANT = NEWFOLDER
    if (btn) {
      await s.mouse(btn.x, btn.y)
      await until(async () => ((await s.eval(`!!document.querySelector('.askwrap .ask-input')`)) ? 'up' : undefined), { what: '框又弹出来了' })
      const prefilled = await s.eval(`(document.querySelector('.askwrap .ask-input')||{}).value`)
      await s.eval(`(() => { const i = document.querySelector('.askwrap .ask-input'); i.focus(); i.select(); return true })()`)
      await s.send('Input.insertText', { text: FIRST })
      const shown = await s.eval(`(document.querySelector('.askwrap .ask-input')||{}).value`)
      await s.key('Enter', 'Enter', 13)
      const built = await until(
        async () => {
          const l = await s.eval(`fetch('/api/list').then((r) => r.json()).then((d) => d.folders)`)
          return l && l.includes(WANT) ? l : undefined
        },
        { what: '盘上真的多出那一层' }
      )
      if (built.ok) ok(`打字（${JSON.stringify(shown)}，预填是 ${JSON.stringify(prefilled)}）+ 回车 → 盘上真的建出那一层（${WANT}）`)
      else bad(`回车之后盘上没多出 ${WANT}：` + JSON.stringify(await s.eval(`fetch('/api/list').then((r) => r.json()).then((d) => d.folders)`)))
      const closed = await until(
        async () => (!(await s.eval(`!!document.querySelector('.askwrap')`)) ? 'gone' : undefined),
        { what: '框自己关上了' }
      )
      if (closed.ok) ok('回车之后框自己关上了（不用再点一下）')
      else bad('回车之后框还开着')
    }

    /* ⑤ 空着按确定 = 不行（按钮灰着），而且**不会**建出一个空名字的层；
       而且框得在**它该在的地方**（这条是 margin:0 那个坑的对手盘）。 */
    if (btn) {
      /* ★ 这里必须**重新找一次按钮坐标**，不能用 ③ 开始时量好的那个：
         `withBoard` 的 open() 之后应用还会按字体度量重排一次卡片、左栏的位置会动，
         而"＋ 分层"这种小按钮一旦挪了几像素，合成点击就落到旁边 ——
         框弹不出来，报出来却是"框弹不出来，量不到它的位置"（像功能坏了）。
         每个小节开头重新量，是比"记住一个坐标"更耐久的姿势。 */
      const again = await s.eval(`(() => {
        for (const b of document.querySelectorAll('.side-sec .side-title button')) {
          if (b.textContent.includes('分层')) { const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
        }
        return null
      })()`)
      await s.mouse((again || btn).x, (again || btn).y)
      const up2 = await until(async () => ((await s.eval(`!!document.querySelector('.askwrap .ask-input')`)) ? 'up' : undefined), { what: '框弹出来了' })
      const geo = await s.eval(`(() => {
        const d = document.querySelector('dialog.ask')
        const i = document.querySelector('.askwrap .ask-input')
        const prim = document.querySelector('.askwrap .btn.primary')
        if (!d) return null
        const r = d.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
        const at = document.elementFromPoint(cx, cy)
        /* 输入框和确定按钮的中心点，以及那一点上**真正是谁** ——
           合成点击严格按这个判命中，"量到的位置"和"点得到的控件"必须是同一个。 */
        const hit = (e) => { if (!e) return null; const q = e.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), top: (document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) || {}).className || null } }
        return {
          viewport: [innerWidth, innerHeight],
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          topAtCentre: at ? (at.className || at.tagName) : null,
          input: hit(i),
          primary: hit(prim),
          disabled: prim ? prim.disabled : null,
        }
      })()`)
      if (!up2.ok || !geo) bad('框弹不出来，量不到它的位置')
      else {
        /* ★ 框必须落在**视口中间那一带**。从前 `.ask { margin: 0 }` 把 dialog 那个
           "靠 auto margin 居中"的定位钉死在左上角：rect 变成 left:0、top:250。
           这个判据不挑审美，只问"它是不是在你正看着的地方"。 */
        const [vw, vh] = geo.viewport
        const [l, t, w, h] = geo.rect
        const ccx = l + w / 2, ccy = t + h / 2
        if (Math.abs(ccx - vw / 2) < vw * 0.12 && Math.abs(ccy - vh / 2) < vh * 0.2) {
          ok(`框开在正中间（中心 ${Math.round(ccx)},${Math.round(ccy)}，视口 ${vw}×${vh}）`)
        } else {
          bad(`框没开在中间：中心 ${Math.round(ccx)},${Math.round(ccy)}，视口 ${vw}×${vh}，rect ${JSON.stringify(geo.rect)}（.ask 上写了 margin: 0？）`)
        }
        /* 量到的那一点上，必须就是那个控件本人 —— 否则"点它"会点到别处去 */
        if (geo.primary && /btn primary/.test(geo.primary.top || '')) ok('「确定」量到的位置和点得到的控件是同一个人（合成点击不会点空）')
        else bad('「确定」的位置和命中对不上，点它会落空：' + JSON.stringify(geo.primary))
        if (geo.input && /ask-input/.test(geo.input.top || '')) ok('输入框量到的位置和命中也是同一个人')
        else bad('输入框的位置和命中对不上：' + JSON.stringify(geo.input))
        if (geo.disabled === true) ok('空着的时候「确定」是灰的（"回车没反应"看得出来）')
        else bad('空着也能按确定：' + JSON.stringify(geo.disabled))

        /* 真鼠标点「确定」→ 空名字不许建出东西来。
           （之前这里量到的坐标是错的，点下去落到框外面、把框关掉，
             而"框关了"看起来很像"确定生效了" —— 所以这条要盯的是**盘上**。） */
        const before = await s.eval(`fetch('/api/list').then((r) => r.json()).then((d) => d.folders)`)
        await s.mouse(geo.primary.x, geo.primary.y)
        await s.sleep(600)
        const after = await s.eval(`fetch('/api/list').then((r) => r.json()).then((d) => d.folders)`)
        const added = (after || []).filter((f) => !(before || []).includes(f))
        if (!added.length) ok('空名字按「确定」什么都没建（盘上没多出任何东西）')
        else bad('空名字居然建出来了：' + JSON.stringify(added))
        const stillUp = await s.eval(`!!document.querySelector('.askwrap .ask-input')`)
        if (stillUp) ok('而且框还开着（灰按钮按不动，不是"点了没反应"）')
        else bad('空着按确定把框关掉了 —— 那用户会以为"建成功了"')
      }
      /* 收尾：把框关掉，别让后面被它拦着 */
      const closeAt = await s.eval(`(() => {
        const c = document.querySelector('.askwrap .btn')
        if (!c) return null
        const r = c.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (closeAt) await s.mouse(closeAt.x, closeAt.y)
      await until(async () => (!(await s.eval(`!!document.querySelector('.askwrap')`)) ? 'gone' : undefined), { what: '框关掉了' })
    }

    /* ⑥ 它长的是**深色**那一套，不是浏览器弹窗那种系统白。
       这不是审美判断题 —— 原生 prompt 的背景拿的是系统主题色，
       自己画的这个拿的是应用的主题色；两者底色不一样，这是"真的换掉了"的判据之一。
       （量底色得把框开着量，所以这条要先开一次。） */
    const again2 = await s.eval(`(() => {
      for (const b of document.querySelectorAll('.side-sec .side-title button')) {
        if (b.textContent.includes('分层')) { const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
      }
      return null
    })()`)
    await s.mouse((again2 || btn).x, (again2 || btn).y)
    const up3 = await until(async () => ((await s.eval(`!!document.querySelector('.askwrap .ask')`)) ? 'up' : undefined), { what: '框' })
    if (!up3.ok) bad('要量底色时框没开起来（坐标 ' + JSON.stringify(again2 || btn) + '）')
    const look2 = await s.eval(`(() => {
      const b = document.querySelector('.askwrap .ask')
      if (!b) return null
      const cs = getComputedStyle(b)
      return { bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow }
    })()`)
    if (!look2) bad('框不见了，量不到底色')
    else {
      const rgb = /^rgba?\((\d+), *(\d+), *(\d+)/.exec(look2.bg || '')
      const luma = rgb ? (Number(rgb[1]) * 299 + Number(rgb[2]) * 587 + Number(rgb[3]) * 114) / 1000 : null
      if (luma != null && luma < 90) ok('框自己是深色的（' + look2.bg + '）—— 跟这个工具一套，不是浏览器那种系统白')
      else bad('框的底色不是深色：' + look2.bg)
    }
    /* 遮罩是**淡**的：这里问的是"放进哪一层"，回答时得看得见左栏那棵树。
       所以不能是原生弹窗那种把界面糊死的不透明底。 */
    const veil = await s.eval(`(() => {
      const w = document.querySelector('.askwrap')
      if (!w) return null
      const cs = getComputedStyle(w)
      const m = /rgba?\\((\\d+), *(\\d+), *(\\d+)(?:, *([\\d.]+))?\\)/.exec(cs.backgroundColor)
      return { bg: cs.backgroundColor, alpha: m ? (m[4] == null ? 1 : Number(m[4])) : null }
    })()`)
    if (veil && veil.alpha != null && veil.alpha <= 0.5) ok('遮罩是淡的（alpha ' + veil.alpha + '）—— 底下的树还看得见，正好回答"放进哪一层"')
    else bad('遮罩把界面糊死了：' + JSON.stringify(veil))
    /* 关掉，别影响后面 */
    {
      const c = await s.eval(`(() => {
        const b = document.querySelector('.askwrap .btn')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (c) await s.mouse(c.x, c.y)
      await until(async () => (!(await s.eval(`!!document.querySelector('.askwrap')`)) ? 'gone' : undefined), { what: '框' })
    }

    /* ⑦ ★ Esc 要能取消（2026-09-21 修的 bug，钉住它别再回来）。
     *
     * 病根值得写在这儿：这个框是 `<dialog open>`（**非模态**），
     * 而"Esc 关闭"是 **`showModal()`（模态）**的默认行为 —— 非模态的 Esc 什么都不做。
     * 于是用户按 Esc 以为取消了，框还开着（`.askwrap` 是一层透明遮罩、盖住整页）；
     * 紧接着点「＋ 分层」→ 那一下落在遮罩上 → 把旧框取消掉、新框根本没开，
     * 屏幕上就是**「点了没反应」**。用户 2026-09-21 报的「新增分层体验太垃圾了」
     * 里就有这一条，而它长得完全不像 bug。
     * ⚠ 顺带钉住"Esc 之后遮罩也没了"：光把 `<dialog>` 关掉不够 ——
     *   遮罩还在的话，下一次点击照样被它吞掉（这正是上面那个症状）。 */
    {
      const again3 = await s.eval(`(() => {
        for (const b of document.querySelectorAll('.side-sec .side-title button')) {
          if (b.textContent.includes('分层')) { const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
        }
        return null
      })()`)
      await s.mouse((again3 || btn).x, (again3 || btn).y)
      const up4 = await until(async () => ((await s.eval(`!!document.querySelector('.askwrap .ask')`)) ? 'up' : undefined), { what: '框' })
      if (!up4.ok) bad('要验 Esc 时框没开起来')
      else {
        await s.key('Escape', 'Escape', 27)
        const gone = await until(
          async () => (!(await s.eval(`!!document.querySelector('.askwrap')`)) ? 'gone' : undefined),
          { what: 'Esc 之后框和遮罩一起消失' }
        )
        if (gone.ok) ok('★ Esc 能取消（框和遮罩一起收掉）—— 非模态 dialog 的 Esc 不会自己关，是这里自己接的')
        else bad('按 Esc 关不掉：遮罩还在的话，下一次点击会被它吞掉（用户看到的是"点了没反应"）')
      }
    }

    /* ⑧ 全程不该有原生弹窗被调起来 */
    const diag = await s.eval(`window.__askDiag`)
    if (diag && diag.native === 0) ok('全程没有调起任何原生 alert/confirm/prompt（自己的框才是唯一那个框）')
    else bad('有原生弹窗被调起来了：' + JSON.stringify(diag))

    /* ⑨ 页面上不该有任何报错 */
    const errs = s.errors()
    if (!errs.length) ok('页面里没有 JS 报错')
    else bad('页面报错：' + errs.join(' | '))
  }
)

process.exitCode = fails ? 1 : 0
