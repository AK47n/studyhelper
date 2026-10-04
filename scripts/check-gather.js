// check-gather：「▤ 收成笔记」的端到端 —— 真浏览器里点工具条那颗 →
// 弹应用自己的框 → 回车 → 盘上多出一份笔记草稿 → 应用切到笔记模式打开它。
// 顺带钉住"双视图已砍、右栏已砍"两条界面事实（笔记模式的两栏长相），
// 以及**撞名时那条三选一的问话**（覆盖 / 换个名字 / 算了，2026-09-19）。
// 夹具板 board-zz-gather.md 自造自删；生成的笔记在 ctx.after 里删；用户文件有哈希守卫。
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'
import { unreadableLines } from '../src/lib/board-note.js'

const NOTE_NAME = '收拢测试 · 笔记.md'
const NOTE_PATH = path.join(process.cwd(), 'data', NOTE_NAME)

await withBoard(
  {
    tag: 'gather',
    port: 5233,
    cdpPort: 9266,
    make: () => {
      const b = newBoard('收拢测试')
      const f = newCard('formula', 200, 100)
      f.src = 'E = mc^2'
      f.tex = 'E = mc^2'
      const t = newCard('note', 200, 300)
      t.text = '牛顿第二定律：F = ma'
      b.cards = [f, t]
      b.frames = [{ id: 'frzzgather1', title: '第一块', ids: [], cards: [f.id] }]
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, board, open, until, after }) => {
    await open()

    // [1] 工具条上那颗按钮看得见、点得到
    // ⚠ 它 2026-09-26 收进了「⋯ 更多」菜单 —— elementFromPoint 只有菜单开着才命中，
    //   所以先点开菜单（菜单常驻 DOM，eval click 永远有效；check-deck 同款前置）。
    await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && !m.classList.contains('on')) m.click(); return 1 })()`)
    await s.sleep(150)
    const btn = await s.eval(`(() => {
      const b = document.querySelector('[data-tool="gather"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               hit: hit ? (hit.closest('[data-tool="gather"]') ? true : (hit.textContent || '').slice(0, 12)) : null }
    })()`)
    if (btn && btn.hit === true) ok(`「▤ 收成笔记」点得到（${btn.x},${btn.y}，elementFromPoint 命中它自己）`)
    else bad('「▤ 收成笔记」看不见或被别的层盖住：' + JSON.stringify(btn))

    // [2] 点它 → 弹的是应用自己的框（note-from-board），预填「收拢测试 · 笔记」
    await s.mouse(btn.x, btn.y)
    const askw = await until(async () => {
      return await s.eval(`(() => {
        const d = document.querySelector('.ask')
        if (!d) return null
        return { id: d.getAttribute('data-ask') || (d.closest('[data-ask]') || {}).getAttribute?.('data-ask') || '',
                 title: (document.querySelector('.ask-title') || {}).textContent || '',
                 val: (document.querySelector('.ask-input') || {}).value || '' }
      })()`)
    }, { what: '询问框（note-from-board）弹出来' })
    if (askw.ok && /收拢成笔记|note-from-board/.test(askw.value.title + (askw.value.id || ''))) {
      ok('弹的是应用自己的框「收拢成笔记」')
    } else bad('点完没弹框 / 弹错了：' + JSON.stringify(askw.value))
    if (askw.value && askw.value.val === '收拢测试 · 笔记') ok('名字预填成「收拢测试 · 笔记」')
    else bad('名字预填不对：' + JSON.stringify(askw.value && askw.value.val))

    // [3] 回车提交 → 盘上多出那份笔记，应用切到笔记模式
    await s.key('Enter', 'Enter', 13)
    let md = ''
    const made = await until(() => {
      try {
        md = fs.readFileSync(NOTE_PATH, 'utf8')
        return md.length > 0
      } catch {
        return false
      }
    }, { timeout: 8000, what: '笔记草稿落盘（' + NOTE_NAME + '）' })
    if (made.ok) ok('草稿落盘：' + NOTE_NAME)
    else bad('回车之后盘上没有长出那份笔记')

    if (md) {
      const wants = [
        ['# 收拢测试 · 收拢草稿', '标题'],
        ['## 1、第一块', '板框变成小节'],
        ['- 公式 | $E = mc^2$', '公式卡 → 公式行'],
        ['- 牛顿第二定律：F = ma', '文字卡 → 一条'],
        ['> 从白板「收拢测试」收拢', '出处说明'],
      ]
      for (const [needle, what] of wants) {
        if (md.includes(needle)) ok(`草稿里有${what}（${needle.slice(0, 18)}…）`)
        else bad(`草稿里缺${what}：应有「${needle}」`)
      }
      if (!md.includes('还有 0 笔手写')) ok('没有手写时不写"还有 0 笔"那种废话')
      else bad('草稿里出现"还有 0 笔手写"')
      /* ADR-0004 第 1 步的判据：草稿里**读不到的行必须是 0**。
         读不到的行在阅读页签和导出里是不存在的（真草稿量过 32 行），
         而屏幕上一点异常都没有 —— 所以它得有一条断言钉着，别等哪天又长回来。 */
      const unread = unreadableLines(md)
      if (unread.length === 0) ok('草稿里没有"读不到的行"（阅读页签和导出都看得见它）')
      else bad(`草稿里有 ${unread.length} 行 parseDoc 读不到：` + JSON.stringify(unread.slice(0, 2)))
      after(() => {
        try {
          fs.rmSync(NOTE_PATH, { force: true })
        } catch {}
      })
    }

    // [4] 应用此刻应该已经切到笔记模式：编辑区在、右栏和双视图不在
    const ui = await until(async () => {
      return await s.eval(`(() => {
        const q = (x) => document.querySelector(x)
        return { ta: !!q('textarea.raw'), aside: !!q('aside.right'), tabs: !!q('.viewtabs'),
                 fbar: !!q('.fbar'), fbarTabs: !!q('.fbar-tabs') }
      })()`)
    }, { what: '笔记模式挂上（textarea 出现）' })
    if (ui.value && ui.value.ta) {
      ok('切到了笔记模式，编辑区在')
      if (!ui.value.aside) ok('右栏没有了（两栏）')
      else bad('右栏还在 —— 说好砍掉的')
      // 「编辑/阅读」页签一度砍掉又恢复（公式需要渲染视图）；右栏不回来
      const readTab = await s.eval(`[...document.querySelectorAll('.viewtabs button')].some(b => b.textContent.includes('阅读'))`)
      if (readTab) ok('「编辑/阅读」页签在（收拢出的公式有地方好看地看）')
      else bad('找不到「阅读」页签')
      if (!ui.value.fbarTabs) ok('公式条默认收起（页签不常驻）')
      else bad('公式条页签还在常驻')
    } else bad('回车之后没切到笔记模式（textarea 没出现）')

    /* ═════════════════════ 5. 撞名：问一句，三条路（2026-09-19）═════════════════════
     * 从前撞名只 flash 一句"同名文件已存在"：用户既不能覆盖也不能改名，只能自己想一个
     * 名字、把整个流程再走一遍。而从白板收拢的草稿默认叫「<板名> · 笔记」——**撞名是常态**。
     * 这一节把三条路各走一遍（真浏览器、真文件）：
     *   ① 换个名字 → 新文件出现，**原来那份一个字节没动**（先往里写一句"哨兵"验它）；
     *   ② 覆盖 → 原来那份**被换掉了**（哨兵没了）；
     *   ③ 那条问话的样子：三颗按钮、**第一条是"换个名字"**（回车走的那条不会弄丢东西）。 */
    const NOTE2 = '收拢测试 · 笔记 2.md'
    const NOTE2_PATH = path.join(process.cwd(), 'data', NOTE2)
    after(() => {
      try {
        fs.rmSync(NOTE2_PATH, { force: true })
      } catch {}
    })

    // 回白板，并往那份已有笔记里写一句哨兵（覆盖没覆盖，看它还在不在）
    await open()
    const SENTINEL = '# 哨兵：这份是**原来**的那一份\n'
    fs.writeFileSync(NOTE_PATH, SENTINEL, 'utf8')

    const gatherAgain = async () => {
      /* 「▤ 收成笔记」在「⋯ 更多」菜单里 —— 先开菜单再量坐标（见上面 [1] 的说明）。 */
      await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && !m.classList.contains('on')) m.click(); return 1 })()`)
      await s.sleep(150)
      const btn = await s.eval(`(() => {
        const b = document.querySelector('[data-tool="gather"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!btn) return bad('找不到「▤ 收成笔记」')
      await s.mouse(btn.x, btn.y)
      const w = await until(
        () => s.eval(`(() => { const d = document.querySelector('.ask-input'); return d ? String(d.value || '') : null })()`),
        { what: '询问框（note-from-board）' }
      )
      if (!w.ok) bad('询问框没弹出来')
      await s.key('Enter', 'Enter', 13)
    }
    const overwriteAsk = () =>
      s.eval(`(() => {
        const d = document.querySelector('.ask')
        if (!d || !d.querySelector('.ask-choices')) return null
        return {
          title: (d.querySelector('.ask-title') || {}).textContent || '',
          note: (d.querySelector('.ask-note') || {}).textContent || '',
          btns: [...d.querySelectorAll('.ask-choice')].map((b) => (b.querySelector('b') || {}).textContent || ''),
        }
      })()`)
    const clickChoice = async (label) => {
      const pt = await s.eval(`(() => {
        const b = [...document.querySelectorAll('.ask-choice')].find((x) => ((x.querySelector('b') || {}).textContent || '') === ${JSON.stringify(label)})
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!pt) return bad('点不到「' + label + '」那颗按钮')
      await s.mouse(pt.x, pt.y)
    }

    /* ① 换个名字 */
    await gatherAgain()
    const ask1 = await until(overwriteAsk, { what: '「已经有一条笔记了」那颗问话' })
    if (ask1.ok) ok('★ 撞名的时候**问了用户**（不再是闷头报一句错）')
    else bad('撞名没问用户：' + JSON.stringify(ask1.value))
    if (ask1.value && ask1.value.btns[0] === '换个名字') ok('★ 第一条是「换个名字」（回车走它 —— 不会弄丢东西的那条永远排最前）')
    else bad('选项顺序不对：' + JSON.stringify(ask1.value && ask1.value.btns))
    if (ask1.value && /收拢测试 · 笔记\.md/.test(ask1.value.note) && /节点/.test(ask1.value.note)) {
      ok('问话里写清了**要覆盖的是哪一份**（文件名 + 几个节点）：' + ask1.value.note.slice(0, 40))
    } else bad('没说清要覆盖哪一份：' + JSON.stringify(ask1.value && ask1.value.note))
    await clickChoice('换个名字')
    const renamed = await until(
      () => s.eval(`(() => { const d = document.querySelector('.ask-input'); return d ? String(d.value || '') : null })()`),
      { what: '换个名字之后的问话' }
    )
    if (renamed.ok && renamed.value === '收拢测试 · 笔记 2') ok('★ 换名字那条**替你填好了不撞名的那个**（只要回车）')
    else bad('预填的名字不对：' + JSON.stringify(renamed.value))
    await s.key('Enter', 'Enter', 13)
    const madeTwo = await until(() => fs.existsSync(NOTE2_PATH), { timeout: 8000, what: '第二份笔记落盘' })
    if (madeTwo.ok) ok('换名字之后建出了：' + NOTE2)
    else bad('换了名字也没建出来')
    if (fs.readFileSync(NOTE_PATH, 'utf8') === SENTINEL) ok('★ 原来那一份**一个字节没动**（换名字不会弄丢东西）')
    else bad('说了"换个名字"，原来那份却被改了')

    /* ② 覆盖 */
    await open()
    await gatherAgain()
    const ask2 = await until(overwriteAsk, { what: '第二次的撞名问话' })
    if (ask2.ok) ok('同一句问话又出现了（每次都问，不记住上次的选择）')
    await clickChoice('覆盖它')
    const overwritten = await until(
      () => {
        try {
          return fs.readFileSync(NOTE_PATH, 'utf8') !== SENTINEL
        } catch {
          return false
        }
      },
      { timeout: 8000, what: '原来那份被覆盖' }
    )
    if (overwritten.ok) ok('★ 选了「覆盖它」→ 原来那份的内容被换掉了（哨兵没了）')
    else bad('选了覆盖，文件却没变')
    if (fs.readFileSync(NOTE_PATH, 'utf8').includes('收拢草稿')) ok('覆盖上去的正是这份草稿')
    else bad('覆盖之后的内容不对')
    if (fs.existsSync(NOTE2_PATH)) ok('另一份（换名字建出来的）没被牵连')
    else bad('覆盖把另一份也弄没了')

    // [6] 页面里没有 JS 报错
    await s.sleep(400)
    const errs = s.errors()
    if (!errs.length) ok('页面里没有 JS 报错')
    else bad('页面有报错：' + errs.slice(0, 3).join(' | '))
  }
)
