/* 默认打开哪一个 —— 用真浏览器盯住一条用户只会在意的规矩：
 *   data/ 里**一张白板都没有**时，打开应用必须是白板界面（并自动补一张空的），
 *   不能掉进笔记界面。
 *
 * 为什么值得单独一条自检：
 *   应用挑"列表里第一个 board-*.md"决定进哪个模式。这条链上任何一个环节坏掉
 *   （排序变了、补板撞名了、写盘失败还静默了），症状都一样 ——
 *   用户打开看到的是笔记，想画还得先点一下「白板」、再回答一个"这一课叫什么"的弹窗。
 *   2026-09-15 用户报的正是这个：板被删干净之后，打开直接进了笔记界面。
 *   check-board-browser 测不到它 —— 那个自检会自己造一张板，走的是"已经有板"那条路。
 *
 * 前提：data/ 里没有 board-*.md。有的话这个场景跑不出来，脚本会直接跳过，
 *       **不碰任何文件**（不会去删用户自己的板）。
 * 它自己起服务（5199）和 headless Edge（9229），跑完都收掉；中途补出来的空板也删掉 ——
 * 胶水在 scripts/lib/board-check.js 的 withBoard 里（这一条是唯一**不要夹具**的自检：
 * 它的场景就是"一张板都没有"，tag 传 null）。
 *
 * 用法：node scripts/check-default-mode.js    （或 npm run check:default）
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard, DATA } from './lib/board-check.js'
import { isBoardName } from '../src/lib/board.js'

const before = fs.readdirSync(DATA)
console.log('\n  data/ 现在有：' + before.join(' · '))

/* 有板就跳过 —— 这个场景的前提是"一张板都没有"。
   ★ 不能为了造场景去删/改用户的板。 */
if (before.some((n) => isBoardName(n))) {
  console.log('  data/ 里已经有白板了，跑不出"一张板都没有"这个场景 —— 跳过（什么都没动）\n')
  process.exit(0)
}

const fails = await withBoard({ tag: null, port: 5199, cdpPort: 9229 }, async ({ s, ok, bad, open, after }) => {
/* ── 下面整段原来是顶层代码，挪进 withBoard 的回调里；缩进没动（少几百行假 diff）── */

/* 只删**本次跑出来的**文件。绝不动跑之前就在 data/ 里的任何东西。
   ★ 注册给 after()：它在浏览器/服务被收掉之后才跑，那时候没人再往盘上写了。 */
after(() => {
  for (const n of fs.readdirSync(DATA)) {
    if (!before.includes(n)) {
      try {
        fs.rmSync(path.join(DATA, n), { force: true })
      } catch {}
    }
  }
})

/* 等界面稳定：载入中的遮罩没了，白板/笔记其中一个挂上了。 */
await open({ settle: 400 })

/* 顺便把出现过的 toast 收起来（"没有白板，先给你开了一张空的" 2 秒后就没了）——
   所以这里要**边等边收**，不能等稳稳当当之后再读一次。 */
const probe = `(() => {
  const q = (x) => document.querySelector(x)
  return {
    cover: !!q('.cover'),
    board: !!q('.bd-shell'),
    note: !!q('.topbar'),
    file: (q('.bd-file') || {}).textContent || '',
    toast: (q('.toast') || {}).textContent || '',
  }
})()`

let st = await s.eval(probe)
const toasts = new Set()
for (let i = 0; i < 14; i++) {
  st = await s.eval(probe)
  if (st.toast) toasts.add(st.toast)
  await s.sleep(200)
}

if (st.board) ok('打开就是白板界面（.bd-shell 在）')
else bad('打开不是白板界面（board=' + st.board + ' note=' + st.note + '）')
if (st.note) bad('反而渲染了笔记界面（.topbar 在）—— 这就是这条自检要拦的回归')
else ok('没有掉进笔记界面')

const added = fs.readdirSync(DATA).filter((n) => !before.includes(n))
console.log('  data/ 新出现：' + (added.join(' · ') || '(无)'))
const made = added.find((n) => isBoardName(n))
if (made) ok('自动补了一张板：' + made)
else bad('一张板都没补出来（用户下次打开还是笔记界面）')

if (made) {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(DATA, made), 'utf8'))
  } catch {}
  if (parsed && typeof parsed.version === 'number' && Array.isArray(parsed.cards) && Array.isArray(parsed.strokes)) {
    ok(`补出来的是一张合法空板（version ${parsed.version}，0 笔 0 卡）`)
  } else {
    bad('补出来的不是合法白板 JSON（打开会退化成空板）')
  }
  if (st.file.trim() === made) ok('顶栏显示的正是它：' + st.file.trim())
  else bad('顶栏显示的不是它：' + JSON.stringify(st.file))
}
if ([...toasts].some((t) => t.includes('没有白板'))) ok('给了提示：' + [...toasts][0])

/* 第二屏：现在 data/ 里有板了，刷新应该照旧进白板，而且不该再补一张。 */
await open({ settle: 600 })
const st2 = await s.eval(probe)
if (st2 && st2.board) ok('刷新后还是白板')
else bad('刷新后又不是白板了')
if (fs.readdirSync(DATA).some((n) => n.includes('新白板 2'))) bad('又补了一张（重名探测没生效）')
else ok('没有重复补板（重名探测生效）')
})
