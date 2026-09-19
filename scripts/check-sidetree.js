/* 左栏那棵树（data/ 的分层）—— 真浏览器自检。
 *
 * 为什么要有这一条：分层存储改的全是**看得见的**东西 ——
 *   左栏从"一串文件"变成"一棵树"、缩进要真的表示层级、目录能折起来、
 *   一行能拖到另一层上去、一行能就地改名。这些在 `check-board`（纯逻辑，[6u]）和
 *   `check-storage`（真服务，真写盘）里都验不到：那两条都看不见界面。
 *
 * ★ 它自己造的那一层叫 `zz-sidetree`（名字带 zz-，一眼看得出是自检造的），
 *   跑完**整棵删掉**；深处那张板叫 `board-zz-sidetree-deep.md`，自检里会被**就地改名**
 *   成 `board-zz-sidetree-renamed.md`、再被拖到根上 —— 所以那三个位置都要收，
 *   收之前一律过 `LEGAL_FIXTURE` 这个名字闸（"删的是谁的"那个判据）。
 *   用户 `data/` 里原有的东西一个字节都不动（withBoard 的守卫会报红）。
 *   ★ ⑧ 那一节（"点出来的分层"）还会再造两张板，它们的名字也在同一个闸下面。
 *
 * ⚠ 拖拽那一段用的是**合成的 DragEvent**，不是 CDP 的真拖放：CDP 没有
 *   HTML5 拖放事件（`Input.dispatchDragEvent` 要 intercept，和真手指那条路不是一回事）。
 *   所以它验的是**我们的接线**（落点判断、发出去的 to 是什么），不是浏览器的拖放实现。
 *   真手指怎么拖，得你自己拖一下 —— 这条注释就是那件事的收条。
 *
 * ★ 2026-09-18 起，**"从界面上点"这条路变成可自检的了**（⑧）。
 *   从前做不到，是因为它要回答一个**浏览器 prompt**（headless 里没法打字）——
 *   那时候的注释原话是"为什么不从界面上点：那条路要回答一个 prompt"。
 *   现在是应用自己的询问框（`check:ask` 那一族），`Input.insertText` 打得进去，
 *   所以这里可以直接走用户真正走的那条路：**点目录行的「＋」→ 打字 → 回车**。
 *   前面几节仍然用 `/api/new` 直接把夹具喂进去 —— 那几节要验的是树本身（缩进 / 折叠 / 拖放），
 *   和"怎么建出来的"无关，少绕一圈。
 *
 * 用法：node scripts/check-sidetree.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { LEGAL_FIXTURE, DATA, withBoard } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'

const MINE = 'zz-sidetree'
const DEEP = `${MINE}/大物/电磁学/board-zz-sidetree-deep.md`
/* ⑧ 造的那两张板（点「＋」点出来的）—— 名字同样带 zz-，收尾按同一个名字闸删 */
const MADE_BOARD = `${MINE}/大物/board-zz-sidetree-click.md`
const MADE_LAYER = `${MINE}/大物/zz-sidetree-click层`
/* 造出来的那张板的内容：一张空板（名字里带 zz- 是为了跑完能按名字闸删掉） */
const SEED = serializeBoardDocument(newBoard('自检的一层'))

const fails = await withBoard(
  { tag: 'sidetree', port: 5213, cdpPort: 9253 },
  async ({ s, ok, bad, open, after, until }) => {
    /* 收尾：只删我自己造的那一层，和那张"被改名 + 被拖到根上"的板。
       ★ 删文件之前过一遍 LEGAL_FIXTURE —— 万一名字不是我造的那个，就不删。
       ⚠ ⑧ 建出来的东西都在 `zz-sidetree/` 里面（那一层整个 rmSync 就一并收掉了），
         唯一的例外是它中途可能把某一张板打开着（`?file=` 还是那张夹具）——
         夹具本身由 withBoard 按名字闸删。 */
    after(() => {
      try {
        fs.rmSync(path.join(DATA, MINE), { recursive: true, force: true })
      } catch {}
      for (const base of [path.basename(DEEP), 'board-zz-sidetree-renamed.md']) {
        try {
          if (LEGAL_FIXTURE.test(base)) fs.rmSync(path.join(DATA, base), { force: true })
        } catch {}
      }
    })

    await open()

    /* ① 用**应用自己的接口**造一层带层次的板（大物/电磁学/board-…）——
       为什么不从界面上点：那条路要回答一个 prompt，headless 里没法打字。
       接口这条路的端到端对手是 `npm run check:storage`，这里只是把界面喂饱。 */
    const made = await s.eval(`fetch('/api/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ${JSON.stringify(DEEP)}, text: ${JSON.stringify(SEED)} }),
    }).then((r) => r.json())`)
    if (made && made.ok) ok('造好了一层带层次的板：' + DEEP)
    else bad('造不出来（/api/new）：' + JSON.stringify(made))

    await open({ settle: 1200 })

    /* ② 树摆出来了：目录行 + 缩进**真的**表示层级（缩进读的是算出来的 padding-left）
     * ★ `path` 是这一行在树里的**完整路径**（目录行渲染时写在 `title` 属性上）——
     *   所有"找某一行"的断言都按它认，不按 `name` 认。
     *   为什么（2026-09-18 踩的）：用户自己的 `data/` 里**也有一个 `大物`**，
     *   按名字找就会命中他那一行（depth 0），报出来却是"缩进不对"，
     *   看着像分层坏了 —— 其实是自检认错了行。 */
    const rows = () =>
      s.eval(`(() => {
        const out = []
        for (const el of document.querySelectorAll('.filelist .folderrow, .filelist .filerow')) {
          /* 名字那一格在**就地改名**时会变成输入框（同一个位置、不同的元素），
             所以两种都读 —— 否则"改着名的那一行"会以名字为空的样子出现，
             断言会报成"那一行不见了"。 */
          const cell = el.querySelector('.fname') || el.querySelector('.renameinput')
          const name = (cell || {}).value != null ? cell.value : ((cell || {}).textContent || '')
          const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
          out.push({
            dir: el.classList.contains('folderrow'),
            name,
            path: el.getAttribute('title') || name,
            depth: Math.round((pad - 6) / 12),
          })
        }
        return out
      })()`)

    let list = await rows()
    /* 按**完整路径**找行。目录行 / 文件行都算，所以调用处传的是树里的路径。 */
    const find = (p) => list.find((r) => r.path === p)
    const DALU = `${MINE}/大物`
    const DENG = `${MINE}/大物/电磁学`
    if (find(MINE)) ok(`左栏出现了那一层：${MINE}`)
    else bad(`左栏没有 ${MINE}（树没摆出来？）：` + JSON.stringify(list))
    if (find(DALU) && find(DALU).depth === 1) ok('第二层缩进 1 档（12px）')
    else bad('「' + DALU + '」的缩进不对：' + JSON.stringify(find(DALU)))
    if (find(DENG) && find(DENG).depth === 2) ok('第三层缩进 2 档 —— 缩进真的是层级')
    else bad('「' + DENG + '」的缩进不对：' + JSON.stringify(find(DENG)))
    if (find(DEEP) && find(DEEP).depth === 3) {
      ok('深处的板摆在自己的那一层里（缩进 3 档）')
    } else bad('那张板没摆对：' + JSON.stringify(find(DEEP)))

    /* ③ 默认全展开：第一次打开（localStorage 里什么都没有）就该看得见里面的东西 */
    const stored = await s.eval(`localStorage.getItem('studyhelper.tree')`)
    if (stored === null) ok('还没动过展开状态 → localStorage 里是空的（默认全展开）')
    else bad('一进来就写死了展开状态：' + stored)

    /* ④ 点一下目录行 → 折起来；再点一下 → 展开（真鼠标点，不是 dispatchEvent）
       ⚠ 定位按 `title` 属性里的**完整路径**（`DENG`），不按名字 ——
         用户自己也可能有一层叫「电磁学」。 */
    const box = await s.eval(`(() => {
      for (const el of document.querySelectorAll('.filelist .folderrow')) {
        if (el.getAttribute('title') === ${JSON.stringify(DENG)}) {
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2), caret: el.querySelector('.caret').textContent }
        }
      }
      return null
    })()`)
    if (!box) bad('找不到「' + DENG + '」那一行，点不了')
    else {
      if (box.caret === '▾') ok('展开着的时候箭头是 ▾')
      else bad('箭头不对：' + box.caret)
      await s.mouse(box.x, box.y)
      list = await rows()
      if (!find(DEEP)) ok('点一下 → 折起来了（里面那张板不见了）')
      else bad('点了没折起来')
      const caret2 = await s.eval(`(() => {
        for (const el of document.querySelectorAll('.filelist .folderrow')) {
          if (el.getAttribute('title') === ${JSON.stringify(DENG)}) return el.querySelector('.caret').textContent
        }
        return ''
      })()`)
      if (caret2 === '▸') ok('折起来之后箭头是 ▸')
      else bad('折起来之后箭头没变：' + caret2)
      const stored2 = await s.eval(`localStorage.getItem('studyhelper.tree')`)
      /* 记的是**展开着**的那几层，所以折起来的那一层应当"不在名单里"、别的都还在 */
      if (stored2 && !stored2.includes('电磁学') && stored2.includes('大物')) {
        ok('折起来这件事记在 localStorage 里（那一层不在"展开名单"里，别的还在）')
      } else bad('折叠状态没记住：' + stored2)
      await s.mouse(box.x, box.y)
      list = await rows()
      if (find(DEEP)) ok('再点一下 → 又展开了')
      else bad('点第二下没展开')
    }

    /* ④′ 改名分两步验（**顺序**是有讲究的，见下面每条的理由）：
     *   (a) 点**名字那一格** → 必须**打开**那张板（2026-09-21 起的规矩：整行随便点都打开）。
     *       为什么这一条必须最先做：它是这次改动的全部理由 —— 用户原话
     *       「现在点白板的时候经常点到重命名很难受就打不开白板」。名字那一格是
     *       `flex: 1`、占一行里绝大部分宽度，想打开时手指就落在那里。
     *       ⚠ 这里**必须真的点到名字上**（`elementFromPoint` 命中的就是它）——
     *         "点了名字没进改名"这句话只有真鼠标才证明得了。
     *   (b) 点行尾那颗「改名」（`data-act="rename"`）→ 就地变成输入框 → 打字 → 回车落盘。
     *       为什么必须有这一条：改名是唯一一个"盘上的文件名变了、而打开着的那个 current
     *       也得跟着变"的操作 —— 不跟着改，下一次自动保存会拿着旧名字在 data/ 里
     *       凭空重建一份（用户就会看到两张板）。这一串纯逻辑自检验不到，
     *       check-storage 只能验到服务端那一侧。
     *   ⚠ (a) 会把夹具换成深处那张板（点名字 = 打开），(b) 又改的是**同一条**的名字，
     *     所以 (a)(b) 中间要回到夹具（`open()`），不然 ⑤ 打开的就是另一张了。 */
    const NEWNAME = 'board-zz-sidetree-renamed'
    {
      /* ── (a) 点名字那一格 = 打开 ───────────────────────────────── */
      const nameBox = await s.eval(`(() => {
        for (const el of document.querySelectorAll('.filelist .filerow')) {
          const cell = el.querySelector('.fname')
          if (cell && cell.textContent === 'board-zz-sidetree-deep') {
            /* ★ 先把它**滚进视野**（2026-09-21 修）：
               这一行在树的最深处，而左栏是可滚动的一列 —— 板一多，它就落到
               滚动条下面、被底部那一栏（.side-foot，"数据在 data/ 目录"那一块）盖住。
               实测点上去命中的是那一栏，而报出来是"点了名字没变成输入框"，
               看着像改名坏了。真用户会先滚一下，自检也得滚。
               ⚠ 判据仍然是 elementFromPoint（下面那条断言）——
                 "rect 在那儿"不等于"点得到"。
               ⚠⚠ 这个 eval 字符串是**模板字面量**：注释里不许出现反引号
                 （写了就把字符串截断了，报出来是一句 xxx is not defined，
                  而位置看着完全无关 —— 我在这里真踩了一次）。 */
            cell.scrollIntoView({ block: 'center' })
            const r = cell.getBoundingClientRect()
            const p = { x: Math.round(r.left + 18), y: Math.round(r.top + r.height / 2) }
            const hit = document.elementFromPoint(p.x, p.y)
            return { ...p, hit: hit ? String(hit.className) : null }
          }
        }
        return null
      })()`)
      if (!nameBox) bad('找不到那一行的名字，打不开也改不了名')
      else {
        if (String(nameBox.hit).includes('fname')) ok('滚进视野之后，名字那一格真的点得到（elementFromPoint 命中的就是它）')
        else bad(`名字那一格点不到：那一点上是「${nameBox.hit}」（滚了还是被别的东西盖着？）`)
        await s.mouse(nameBox.x, nameBox.y)
        const opened = await until(async () => {
          const f = await s.eval(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)
          return f === DEEP ? f : undefined
        }, { what: '点名字那一格 → 打开了那张深处的板' })
        if (opened.ok) ok('★ 点名字那一格 = **打开**（不再进改名框）：顶栏 = ' + opened.value)
        else {
          bad(
            '点名字那一格没打开那张板 —— 顶栏是：' +
              (await s.eval(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)) +
              '，改名框在不在：' + JSON.stringify(await s.eval(`!!document.querySelector('.filelist .renameinput')`))
          )
        }
        await open({ settle: 1200 }) // 回到夹具，好让 (b) 改的是同一条、⑤ 打开的也是那一条
      }

      /* ── (b) 点行尾那颗「改名」= 就地改名 ──────────────────────── */
      /* 先 hover 那一行：动作区是 `:hover` 才显示的（文件行），
         不 hover 拿到的是 0×0 的 rect —— 量出来只会报"点不到"。 */
      const rowBox = await s.eval(`(() => {
        for (const el of document.querySelectorAll('.filelist .filerow')) {
          const cell = el.querySelector('.fname')
          if (cell && cell.textContent === 'board-zz-sidetree-deep') {
            cell.scrollIntoView({ block: 'center' })
            const r = el.getBoundingClientRect()
            return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
          }
        }
        return null
      })()`)
      if (!rowBox) bad('找不到那一行，点不到它行尾的「改名」')
      else {
        await s.hover(rowBox.x, rowBox.y)
        /* 找那颗按钮**按 `data-act="rename"` 认**，不按"第几颗按钮 / 文字是不是改名"——
           名字那一格也可能叫"改名"（板文件就叫得出来），位置判据会在长出新按钮之后失效。
           ⚠ 判据还是 elementFromPoint：hover 过了也证明不了它点得到。 */
        const btn = await s.eval(`(() => {
          for (const el of document.querySelectorAll('.filelist .filerow')) {
            const cell = el.querySelector('.fname')
            if (!cell || cell.textContent !== 'board-zz-sidetree-deep') continue
            const b = el.querySelector('[data-act="rename"]')
            if (!b) return { missing: true }
            const r = b.getBoundingClientRect()
            const p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
            const hit = document.elementFromPoint(p.x, p.y)
            return { ...p, hit: hit ? String(hit.className) : null, same: hit === b }
          }
          return null
        })()`)
        if (!btn) bad('找不到那一行（行尾的「改名」也就无从谈起）')
        else if (btn.missing) bad('行尾没有「改名」这颗按钮 —— 名字那一格已经不是改名的入口了，它没了就等于没法改名')
        else {
          if (btn.w > 0 && btn.h > 0 && btn.same) {
            ok(`行尾那颗「改名」**看得见、点得到**（${btn.w}×${btn.h}，elementFromPoint 命中的就是它）`)
          } else {
            bad(`行尾那颗「改名」点不到：rect ${btn.w}×${btn.h}，那一点上是「${btn.hit}」`)
          }
          await s.mouse(btn.x, btn.y)
          const inputUp = await until(
            async () => {
              const v = await s.eval(`(document.querySelector('.filelist .renameinput') || {}).value`)
              return v === 'board-zz-sidetree-deep' ? v : undefined
            },
            { what: '点「改名」之后名字那一格变成了输入框' }
          )
          if (inputUp.ok) ok('点行尾「改名」→ 就地变成输入框（预填现在的名字）')
          else bad('点了「改名」没变成输入框：' + JSON.stringify(await s.eval(`!!document.querySelector('.renameinput')`)))

          /* 键盘打字：走 CDP 的 insertText（真输入法那条路），不是自己派 input 事件 ——
             后者等于把 value 塞进去，证明不了"用户打得进去" */
          await s.eval(`(() => { const i = document.querySelector('.renameinput'); i.focus(); i.select(); return true })()`)
          await s.send('Input.insertText', { text: NEWNAME })
          await s.key('Enter', 'Enter', 13)
          const done = await until(
            async () => {
              const l = await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.files.map((f) => f.name))`)
              return l && l.some((n) => n.endsWith(NEWNAME + '.md')) && !l.some((n) => n.endsWith(path.basename(DEEP))) ? l : undefined
            },
            { what: '盘上的名字真的换了' }
          )
          if (done.ok) ok('回车 → 盘上真改了名（' + path.basename(DEEP) + ' → ' + NEWNAME + '.md）')
          else bad('改完盘上还是老名字：' + JSON.stringify(await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.files.map((f) => f.name))`)))
          if (fs.existsSync(path.join(DATA, MINE, '大物', '电磁学', path.basename(DEEP)))) {
            bad('★ 旧名字的文件又长回来了 —— 那次自动保存拿的是旧路径')
          } else ok('旧名字没长回来（改名没有变成"又多一份"）')
          /* 改完那一行还应该在同一层（改名不动位置）。
             按**完整路径**认（`NEWNAME` 是光名字，得拼上它所在的层）——
             `isRenamed` 只看最后一段，所以这一条正是"改名不换层"的判据。 */
          const after = await rows()
          const moved = after.find((r) => r.path === `${MINE}/大物/电磁学/${NEWNAME}.md`)
          if (moved && moved.depth === 3) ok('改完还在原来那一层（改名不换归属）')
          else bad('改完那一行的位置不对：' + JSON.stringify(moved))
        }
      }
    }

    /* ⑤ 点**缩进那一块空白**（既不是名字、也不是行尾按钮）→ 也要打开它。
       ★ 这一条和 ④′(a) 是一对：合起来说明"整行随便点都打开"。
         名字那一格和空白都算，只有行尾那几颗按钮不是（它们各有各的动作）。 */
    const hit = await s.eval(`(() => {
      for (const el of document.querySelectorAll('.filelist .filerow')) {
        const cell = el.querySelector('.fname')
        if (cell && cell.textContent === ${JSON.stringify(NEWNAME)}) {
          const r = el.getBoundingClientRect()
          const cellR = cell.getBoundingClientRect()
          /* 点**名字右边那一段空白**（fmeta 和名字之间），离名字格远一点 ——
             这一下要证明的是"不是在名字上也能打开"。
             算出来顺手把几何报回去，红的时候一眼看得出坐标是错的还是点击无效。 */
          const x = Math.round(Math.min(cellR.right + 8, r.right - 40))
          return { x, y: Math.round(r.top + r.height / 2), row: [Math.round(r.left), Math.round(r.right)], cell: [Math.round(cellR.left), Math.round(cellR.right)] }
        }
      }
      return null
    })()`)
    if (!hit) {
      bad('找不到那张板那一行 —— 左栏现在是：' + JSON.stringify(await rows()))
    } else {
      await s.mouse(hit.x, hit.y)
      const w = await until(async () => {
        const f = await s.eval(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)
        return f === MINE + '/大物/电磁学/' + NEWNAME + '.md' ? f : undefined
      }, { what: '顶栏换成了那张深处的板' })
      if (w.ok) {
        ok('点行尾那一块空白 → 打开它（顶栏 = ' + w.value + '）')
      } else {
        const now = await s.eval(`((document.querySelector('.bd-file')||{}).textContent||'').trim()`)
        bad(`点开之后顶栏还是：${now}（点的是 x=${hit.x}, y=${hit.y}；行 ${JSON.stringify(hit.row)}，名字格 ${JSON.stringify(hit.cell)}）`)
      }
    }

    /* ⑥ 拖一行到某一层上 = 挪进去（合成 DragEvent，见文件头那段说明）。
       这里把那张板从 `zz-sidetree/大物/电磁学/` 拖到**顶部那一行**（= 根目录）。
       ⚠ 拖起的那一行按**完整路径**认（深度那一张），不按裸名字 ——
         根上还站着一张 `board-zz-sidetree-renamed.md`（withBoard 的夹具）。 */
    const dragged = await s.eval(`(() => {
      const row = [...document.querySelectorAll('.filelist .filerow')]
        .find((el) => el.getAttribute('title') === ${JSON.stringify(`${MINE}/大物/电磁学/${NEWNAME}.md`)})
      const title = document.querySelector('.side-sec .side-title')
      if (!row || !title) return 'no-node'
      const dt = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      title.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      title.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    if (dragged !== 'sent') bad('拖放那一套没发出去：' + dragged)
    else {
      const w = await until(
        async () => {
          const r = await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.files.map((f) => f.name))`)
          return r && r.some((n) => n === NEWNAME + '.md') ? r : undefined
        },
        { what: '那张板落到了根上（列表里出现它的新路径）' }
      )
      if (w.ok) ok('拖到顶部那一行 → 挪回根目录（列表里现在是 ' + NEWNAME + '.md）')
      else bad('拖完它没动：' + JSON.stringify(await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.files.map((f) => f.name))`)))
      /* 移动的是**那一张板**，不是它所在的层 —— 空的目录要留在原地
         （不然用户拖动一个文件，会连带把整理好的目录结构吃掉） */
      if (fs.existsSync(path.join(DATA, MINE, '大物', '电磁学'))) ok('原来那几层目录还在（移动只挪了那一张板）')
      else bad('原来那几层目录没了 —— 那是一次"移动文件"变了一条路径的消失')
      /* 拖动之后左栏该自己刷新（不然用户拖完看着像没生效）。
         拖到根上之后它的完整路径就是裸名字（`path` 在根上是 `title` = 名字）。 */
      const back = await until(
        async () => {
          const l = await rows()
          return l.some((r) => r.path === `${NEWNAME}.md` && r.depth === 0) ? l : undefined
        },
        { what: '左栏里那一行挪到了根上' }
      )
      if (back.ok) ok('左栏跟着刷新了（那一行现在缩进 0）')
      else bad('左栏没刷新：' + JSON.stringify(await rows()))
    }

    /* ⑧ ★ "点出来的分层"：在**某一层里**点一下就建（2026-09-18 用户要的那件事）。
     *
     * 用户原话：**「现在的分层不是很人性化我还要自己输入上层的名字才能生成，
     * 你可以参考下 onenote 的分层规则这样靠点击来在分层下面建立新白板很人性化」**。
     *
     * 这一节要走的路就是**用户真正走的那条**：点目录行上那颗「＋」→ 打字 → 回车。
     * 所以它同时钉住三件事（缺一样这条功能就还是"人不够人性化"）：
     *   ① **那颗「＋」看得见、点得到** —— 它从前的毛病不是"没有"，是**要鼠标划过去才出现**
     *      （`display: none`），于是看起来像没有这个功能。所以第一条判据是"它的
     *      可见性不是 none / opacity 不是 0"，**在没碰过鼠标的状态下**量。
     *   ② 框里那行字说出了**建到哪一层**（"建到 zz-sidetree/大物"）——
     *      点了之后只看见一个空输入框的话，下一个问题就是"它建到哪儿去了？"。
     *   ③ **真的落到那一层里**（不是根上，也不是"当前打开的那张板所在的那一层"）。
     *      这是这一节的核心：`/api/list` 里必须出现 `zz-sidetree/大物/board-….md`。
     *      ⚠ 判据必须落在**盘上**，不能只看左栏刷新 —— 只看界面的话，
     *        "建到根上了但树摆错了"和"建对了"长得一模一样。
     *   ④ 顺手再验一下「▣」= 在这一层里**再开一层**（两颗按钮管两件事，别合并）。
     *
     * ── ★ 为什么这一节的定位是"**按路径定行**"而不是"按名字定行"（2026-09-18 踩的）──
     * 用户自己的 `data/` 里**也有一个叫「大物」的层**（他平时在用它整理大物课）。
     * 第一版这里写的是"找到 `.fname` 文字等于 `大物` 的那一行"，于是**点中的是用户
     * 那一行**（depth 0），建出来的东西落在用户的 `大物/` 里（`大物/zz-sidetree-click层`），
     * 而断言要的是我们夹具的 `zz-sidetree/大物`。
     * 更糟的是这个错**看着像功能坏了**：报出来是"框里没写建到哪一层""预填了东西"，
     * 其实是**点错了行**。而那两个建到用户文件夹里的东西，虽然是个空目录 + 一张垃圾板，
     * 也已经是"自检动了用户的东西"。
     * 所以这里的规矩是：**行按"它在树里的完整路径"认**，而且这个路径必须是
     * `MINE/…`（我们自己造的那一层底下）。名字一样不算数 —— `大物` 在 `data/` 里
     * 可以是用户的，在 `zz-sidetree/` 底下才是我们的。
     *
     * ── ★ 还有一条："用户正开着应用"这件事会**把行挪走**（同一天踩的）──
     * 自检算好了一颗按钮的坐标、点下去之前，如果用户那边正存盘、树跟着刷新/折展，
     * 同一个坐标底下就换成别的按钮了（实测：点到了文件行那颗「＋」，于是弹出的框
     * 是 `new-board` 的，而 hit-test 那一刻明明是目录行那颗 —— 两次量之间树动过）。
     * 这不怪用户，也不该靠"请用户关掉窗口"来保证正确性：**每一步"量坐标 → 点"
     * 之间必须自己确认"这一行还是我要的那一行"**，判据就是它还在 `MINE/` 底下。
     */
    {
      /* 按**完整路径**认行：`rowBox('zz-sidetree/大物')` 只会命中我们夹具底下那一行。
         ★ 为什么不能按名字认 —— 见上面那段"为什么这一节的定位是按路径定行"。
         返回里带上 `path` 和那一行**当时**的文本，方便报红时说清楚点到了谁。 */
      const rowBox = async (full) =>
        s.eval(`(() => {
          for (const el of document.querySelectorAll('.filelist .folderrow')) {
            const c = el.querySelector('.fname')
            if (!c) continue
            const t = c.textContent || ''
            /* 行上的 title 属性就是它在树里的**完整路径**（渲染时写进去的）——
               用它比"靠缩进/父子关系拼路径"可靠：后者要把祖先一路读回来。 */
            if (el.getAttribute('title') !== ${JSON.stringify(full)}) continue
            const r = el.getBoundingClientRect()
            return {
              path: el.getAttribute('title'), name: t,
              row: [Math.round(r.left), Math.round(r.right)],
              x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2),
            }
          }
          return null
        })()`)

      const DAC = `${MINE}/大物`
      const dalu = await rowBox(DAC)
      if (!dalu) {
        bad('找不到「' + DAC + '」那一行 —— 左栏现在是：' + JSON.stringify(await rows()))
      } else {
        /* ① 那颗「＋白板」**现在就该看得见**（没有 hover、没有动过鼠标）。
           ⚠ 这条是这一节的灵魂：改成"划过才出现"就是回到用户抱怨的那个状态。
             量的是 computed style —— 判"真的画出来了"，不是判"我们写了什么类名"。
           ★ 2026-09-21：两颗按钮从符号（`＋` / `▣`）改成了**词**（`＋白板` / `＋分层`）——
             用户原话是「新增白板，新增分层体验…太垃圾了」，而那两个符号
             "长得一样显眼又都看不懂"（`▣` 尤其：它是"框"的意思，和"分层"毫无关系）。
             主路径「＋白板」常显；「＋分层」和「改名」**飘在它左边**（hover 才出现，
             绝对定位、不占流），因为三个词常显会把目录名挤成省略号（实测）。
             所以这里读的是**两颗都还在 DOM 里**，而常显那一条只看「＋白板」。 */
        const btn = await s.eval(`(() => {
          for (const el of document.querySelectorAll('.filelist .folderrow')) {
            const c = el.querySelector('.fname')
            if (!c || el.getAttribute('title') !== ${JSON.stringify(DAC)}) continue
            const plus = [...el.querySelectorAll('.rowbtn.plus')].find((b) => (b.textContent || '').trim() === '＋白板')
            if (!plus) return { none: true }
            const rowacts = el.querySelector('.rowacts')
            const csp = getComputedStyle(plus)
            const csr = rowacts ? getComputedStyle(rowacts) : null
            const r = plus.getBoundingClientRect()
            const rare = el.querySelector('.rare')
            const rr = rare ? rare.getBoundingClientRect() : null
            const prim = el.querySelector('.rowacts .rowbtn.plus')
            const pr = prim ? prim.getBoundingClientRect() : null
            return {
              actsDisplay: csr ? csr.display : null,
              op: csp.opacity, vis: csp.visibility, disp: csp.display,
              w: Math.round(r.width), h: Math.round(r.height),
              plus: (plus.textContent || '').trim(),
              labels: [...el.querySelectorAll('.rowbtn.plus')].map((b) => (b.textContent || '').trim()),
              rareDisplay: rare ? getComputedStyle(rare).display : null,
              overlaps: rr && pr ? !(rr.right <= pr.left + 0.5 || rr.left >= pr.right - 0.5) : null,
              x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
            }
          }
          return null
        })()`)
        if (!btn || btn.none) bad('「' + DAC + '」那一行上没有「＋白板」')
        else {
          if (btn.actsDisplay !== 'none' && btn.vis !== 'hidden' && Number(btn.op) > 0 && btn.w > 0) {
            ok(`目录行的「＋白板」**没碰鼠标就看得见**（display ${btn.actsDisplay} / opacity ${btn.op} / ${btn.w}×${btn.h}）`)
          } else {
            bad(`目录行的「＋白板」是藏着的（没 hover 就看不见）—— 用户抱怨的正是这一点：${JSON.stringify(btn)}`)
          }
          if (btn.labels.join(',') === '＋白板,＋分层') ok('目录行上是**两颗**：「＋白板」在这一层新建白板、「＋分层」在这一层再开一层')
          else bad('目录行上那两颗按钮不对：' + JSON.stringify(btn.labels))
          if (btn.rareDisplay === 'none' && btn.overlaps === false) {
            ok('  …而「＋分层」飘在它左边、没 hover 时收着（三个词常显会把目录名挤成省略号）')
          } else {
            bad('  …「＋分层」那两颗粒子的位置/收起态不对：' + JSON.stringify({ rareDisplay: btn.rareDisplay, overlaps: btn.overlaps }))
          }

          /* ② 点「＋」→ 弹的是**应用自己的**框，而且是"在这一层里新建白板"那条问话 */
          await s.mouse(btn.x, btn.y)
          const up = await until(
            async () => {
              const v = await s.eval(`(() => {
                const b = document.querySelector('.askwrap .ask')
                if (!b) return null
                const f = document.querySelector('.askwrap .ask-input')
                return {
                  title: (b.querySelector('.ask-title') || {}).textContent || '',
                  where: (b.querySelector('.ask-where') || {}).textContent || '',
                  hint: (b.querySelector('.ask-hint') || {}).textContent || '',
                  focused: document.activeElement === f,
                  value: f ? f.value : null,
                }
              })()`)
              return v && v.title ? v : undefined
            },
            { what: '询问框弹出来了' }
          )
          if (!up.ok) {
            bad('点了「＋」没弹出询问框：' + JSON.stringify(await s.eval(`!!document.querySelector('.askwrap')`)))
          } else {
            const v = up.value
            ok('点「＋」→ 弹的是应用自己的框（' + v.title + '）')
            /* ★ 这一行字是"点出来的分层"和"打出来的分层"全部的区别所在 */
            if (v.where.includes(MINE) && v.where.includes('大物')) {
              ok('框里写明了建到哪一层（' + v.where.trim() + '）—— 不用用户再打一遍上一层')
            } else {
              bad('框里那行"建到哪一层"不对（应当是 ' + MINE + '/大物）：' + JSON.stringify(v.where))
            }
            if (/名字/.test(v.hint) && v.focused) ok('底下的说明只问"这一段名字"，而且输入框自动聚焦')
            else bad('说明或聚焦不对：' + JSON.stringify({ hint: v.hint, focused: v.focused }))
            /* 预填必须是**空的**：这一段就是名字，上一层已经在上面那行字里说了 */
            if (v.value === '') ok('输入框是空的（上一层已经由你点的那一行定了，不用预填路径）')
            else bad('输入框预填了东西 —— 那会把"上一层"又变成要打的东西：' + JSON.stringify(v.value))

            /* ③ 打字 + 回车 → **落到 大物 那一层里**
               ⚠ 走 CDP 的 insertText（真输入法那条路），不是自己派 input 事件。
               ★ 打的是**光名字**（`zz-sidetree-click`），**不带 `board-` 前缀**：
                 用户在这个框里写的是"这张板叫什么"，文件名那个 `board-` 前缀是应用
                 自己加的（`boardPath`）。第一版这里打了 `board-zz-sidetree-click`，
                 于是建出来叫 `board-board-zz-sidetree-click.md` —— **双重前缀**，
                 而这恰恰是"名字这一层只该有一处说得清"的反面教材：
                 前缀该不该加、加在哪，只有 `boardPath` 一处说了算，用户不用管。 */
            await s.eval(`(() => { const i = document.querySelector('.askwrap .ask-input'); i.focus(); i.select(); return true })()`)
            await s.send('Input.insertText', { text: 'zz-sidetree-click' })
            await s.key('Enter', 'Enter', 13)
            const landed = await until(
              async () => {
                const l = await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.files.map((f) => f.name))`)
                return l && l.includes(MADE_BOARD) ? l : undefined
              },
              { what: '盘上真的多出那一张板，而且就在 大物 那一层里' }
            )
            if (landed.ok) {
              ok('点「＋」+ 打字 + 回车 → 盘上多出 ' + MADE_BOARD + '（**在那一层里**，不在根上）')
            } else {
              bad(
                '板没落到 ' + MADE_BOARD + '。盘上现在：' +
                  JSON.stringify(await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.files.map((f) => f.name))`))
              )
            }
            /* **反证**：根上不许出现同名的那一张 —— 没有这一条，"建到根上"也会是绿的
               （根上那张叫 `board-zz-sidetree-click.md`，名字和深处这张不一样）。
               ★ 也不许落到**用户自己的** `大物/` 里去（2026-09-18 真的发生过：
                 点错了行，于是这张垃圾板建进了用户的文件夹 —— 见本节开头那段）。
                 所以反证查的不只是"根上"，而是"**凡是不在 MINE/ 底下的都算泄漏**"。 */
            const leak = await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) =>
              d.files.map((f) => f.name).filter((n) => n.endsWith('board-zz-sidetree-click.md') && !n.startsWith(${JSON.stringify(MINE)} + '/')))`)
            if (!leak.length) ok('没有跑到夹具那一层外面去（"点了哪一层"真的生效了，不是一律建在根上）')
            else bad('★ 建到夹具外面去了：' + JSON.stringify(leak) + ' —— 点的那一行没起作用')
            /* 左栏得自己刷新（新建完看不见那一行 = 用户以为没建成）。
               按**完整路径**认那一行，不按裸名字（`board-zz-sidetree-click` 这名字
               在根上可能也有一张 —— 那正说明它建错了地方）。 */
            const shownNow = await until(
              async () => {
                const l = await rows()
                return l.some((r) => r.path === MADE_BOARD) ? l : undefined
              },
              { what: '左栏里出现了刚建的那一张' }
            )
            if (shownNow.ok) ok('左栏跟着刷新了（刚建的那一张在树里看得见）')
            else bad('左栏没刷新：' + JSON.stringify(await rows()))
            /* ③′ 它建完会**打开**新建的那一张（"建好并打开"）——
               没打开的话用户还得自己去树里找，那一步白省了 */
            const opened = await s.eval(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)
            if (opened === MADE_BOARD) ok('建完顺手打开了它（顶栏 = ' + opened + '）')
            else bad('建完没打开它，顶栏是：' + opened)
          }

          /* ④ 「＋分层」= 在这一层里**再开一层**（和「＋白板」是两件事，别合并）。
             它建完**不打开任何文件**（层不是文件）—— 所以判据只落盘上。
             ★ 2026-09-21：这颗现在是**飘着**的（hover 才出现，见 styles.css 的 `.rare`），
               所以自检必须**先真的把鼠标移上去**再量位置 —— 不 hover 时它的 rect 是 0×0，
               点下去会落到别的地方，而报出来是"点了没弹框"，看着像功能坏了。
             ⚠ 而且量完还要用 elementFromPoint 确认那一点上就是它
               （README 第 13 条：浮出来的东西只有它能证明点得到）。 */
          const rowPt2 = await s.eval(`(() => {
            for (const el of document.querySelectorAll('.filelist .folderrow')) {
              if (el.getAttribute('title') !== ${JSON.stringify(DAC)}) continue
              const r = el.getBoundingClientRect()
              return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }
            }
            return null
          })()`)
          const box2 = rowPt2 && (await (async () => {
            await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowPt2.x, y: rowPt2.y, pointerType: 'mouse' })
            await new Promise((r) => setTimeout(r, 220))
            return s.eval(`(() => {
              for (const el of document.querySelectorAll('.filelist .folderrow')) {
                if (el.getAttribute('title') !== ${JSON.stringify(DAC)}) continue
                const b = [...el.querySelectorAll('.rowbtn.plus')].find((x) => (x.textContent || '').trim() === '＋分层')
                if (!b) return null
                const r = b.getBoundingClientRect()
                if (!r.width) return { zero: true }
                const x = Math.round(r.left + r.width / 2)
                const y = Math.round(r.top + r.height / 2)
                const hit = document.elementFromPoint(x, y)
                return { x, y, w: Math.round(r.width), hit: hit ? String(hit.className) : null }
              }
              return null
            })()`)
          })())
          if (!box2 || box2.zero) bad('「' + DAC + '」那一行上找不到「＋分层」（hover 之后也没有？）')
          else {
            if (String(box2.hit).includes('rowbtn')) ok(`悬停这一行之后，「＋分层」真的点得到（${box2.w}px 宽，命中的就是它）`)
            else bad(`「＋分层」那一点上命中的是「${box2.hit}」—— 看得见、抓不住`)
            await s.mouse(box2.x, box2.y)
            const up2 = await until(
              async () => ((await s.eval(`!!document.querySelector('.askwrap .ask-input')`)) ? 'up' : undefined),
              { what: '「＋分层」的框弹出来了' }
            )
            if (!up2.ok) bad('点了「＋分层」没弹出询问框')
            else {
              const t2 = await s.eval(`(() => {
                const b = document.querySelector('.askwrap .ask')
                const chips = [...b.querySelectorAll('.ask-layer')].map((x) => x.textContent.trim())
                const on = b.querySelector('.ask-layer.on')
                return {
                  title: (b.querySelector('.ask-title') || {}).textContent || '',
                  where: (b.querySelector('.ask-where') || {}).textContent || '',
                  chips,
                  picked: on ? on.textContent.trim() : null,
                }
              })()`)
              if (t2.where.includes(MINE) && t2.where.includes('大物')) ok('「＋分层」问的是"在 ' + DAC + ' 里再开一层"（' + t2.title + '）')
              else bad('「＋分层」那行"建到哪一层"不对：' + JSON.stringify(t2))
              /* ★ 层选择器：那一排按钮里，**点的那一行**应当是选中的那一颗，
                 而且「根目录」永远在（"放到根上"也是一次点击，不用把路径删空）。 */
              if (t2.chips.length >= 2 && t2.chips[0] === '根目录' && t2.picked === DAC) {
                ok(`框里那一排层：默认选中「${t2.picked}」（= 你点的那一行），最左边那颗永远是「根目录」`)
              } else {
                bad('层选择器不对：' + JSON.stringify(t2))
              }
              await s.eval(`(() => { const i = document.querySelector('.askwrap .ask-input'); i.focus(); i.select(); return true })()`)
              await s.send('Input.insertText', { text: 'zz-sidetree-click层' })
              await s.key('Enter', 'Enter', 13)
              const mklayer = await until(
                async () => {
                  const l = await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.folders)`)
                  return l && l.includes(MADE_LAYER) ? l : undefined
                },
                { what: '盘上真的多出那一层' }
              )
              if (mklayer.ok) ok('点「▣」+ 打字 + 回车 → 盘上多出 ' + MADE_LAYER + '（也在那一层里）')
              else bad('「▣」没建出那一层：' + JSON.stringify(await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) => d.folders)`)))
              /* 和上面那张板同一个反证：凡是不在 MINE/ 底下的都算泄漏
                 （2026-09-18 真的漏进过用户的 `大物/` 里）。 */
              const leak2 = await s.eval(`fetch('/api/list').then((x) => x.json()).then((d) =>
                d.folders.filter((f) => f.endsWith('zz-sidetree-click层') && !f.startsWith(${JSON.stringify(MINE)} + '/')))`)
              if (!leak2.length) ok('也没跑到夹具那一层外面去（位置由点的那一行定）')
              else bad('★ 那一层跑到了夹具外面：' + JSON.stringify(leak2) + ' —— 点的那一行没起作用')
            }
          }
        }
      }
    }

    /* ⑨ 页面上不该有任何报错 */
    const errs = s.errors()
    if (!errs.length) ok('页面里没有 JS 报错')
    else bad('页面报错：' + errs.join(' | '))
  }
)

process.exitCode = fails ? 1 : 0
