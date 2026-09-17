/* 画出来的连接（关系）—— 真浏览器自检。
 *
 * 用户 2026-09-16：「更便捷的显示出两者之间的主次、因果、并列等关系」
 *              「我操作的速度是很快的，我没有时间去逐步花很多时间操作这个表示关系的步骤」
 * 纯逻辑那一层（形状怎么读、什么写进文件）在 check-board.js 的 [6d]；
 * 这里管**行为**，而且只能在这儿管：画线 → 浮词 → 点词 → 存盘 → 重开还在。
 *
 * 断言清单：
 *   [1] 拿**笔**从一张卡画到另一张卡 → 连接当场成立（不用点任何东西）+ 浮出那排词，
 *       而且自动读出来的是「相关」（直线）
 *   [2] 点「因果」→ 面板改词、屏幕上出现一颗词 + 一个箭头、文件里写上 link
 *   [3] elementFromPoint 证明那颗词**点得到**（这是"回头改"的唯一入口）
 *   [4] 点那颗词 → 浮词再来一次；按 `1` 选回「相关」→ **文件里的 link 字段消失**
 *       （选的就是自动那一档 = 回到自动，不写字节）
 *   [5] 框住那条线（真框选）→ 浮层里多出一排词，选「推导」→ 面板和文件都跟上
 *   [6] 画一条**带箭头**的线（一笔画成、末端回勾）→ 自动读成「因果」，
 *       而且**文件里没有 link 字段**（形状读出来的不存盘）
 *   [6b] 用**他本人画的箭头**（真实点列，两笔：一杆 + 一个 V 尖）→ 也读成「因果」，
 *       而且屏幕上**不叠合成箭头**（尖是他自己画的）；顺带验世界→屏幕的映射对得上
 *   [7] 在空白处乱画一笔 → 不算连接、也不浮词
 *   [8] 重开一次 → 你标过的那个词还在（存在笔迹上）
 *   [9] 「这条不算连接」：点它 → 不再是关系、文件里写 link:"none"、重开还在；
 *       再框住那一笔 → 浮层里「又算回连接」→ 点回去，文件里那个字段也去掉
 *
 * 自己起服务（5203）和 headless Edge（9233），跑完都收掉；
 * 只碰自己造的夹具板 board-zz-linkcheck.md（跑完删）。
 *
 * 用法：node scripts/check-link.js   （或 npm run check:link）
 */
import fs from 'node:fs'
import path from 'node:path'
import { withBoard } from './lib/board-check.js'
import { BOARD_PREFIX, newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'
import { toPoints } from '../src/lib/geometry.js'

/* ── 夹具板：两张文字卡、**一笔都没有**，而且是**上下摆**不是左右摆 ──
 * ★ 左右摆踩过：屏幕右边 ~330px 是关系面板（.bd-cpanel，覆盖在画布上面），
 *   而"装回屏幕"会把这两张卡居中，于是右边那张正好钻到面板底下。
 *   症状是"第二笔怎么画都不出墨"，报出来像"画不出来"，其实是**在面板上按的**
 *   （面板在 .bd-stagewrap 外面，捕获阶段的监听都收不到 pointerdown）。
 *   上下摆之后两张卡都落在画布中轴附近，离面板远远的。
 * 为什么板上一笔都没有：第 5 步要"框住那条线"，而浮层只在
 *   "框里正好一条连接线"时出现（inkSel.size === 1）—— 板上多一笔就测不到那条路了。
 * 夹具的造/删、"打开的就是夹具"、"跑完 data/ 原有文件一字节不变"都由 withBoard 管。 */
const fails = await withBoard(
  {
    tag: 'linkcheck',
    port: 5203,
    cdpPort: 9233,
    make: () => {
      const b = newBoard('连接自检夹具（跑完自动删除）')
      b.cards.push(
        { ...newCard('note', 500, 120), id: 'lk-a', text: '原因这一块', w: 220, h: 90 },
        { ...newCard('note', 500, 560), id: 'lk-b', text: '结果这一块', w: 220, h: 90 }
      )
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, board, open, read }) => {
/* ── 下面整段原来是顶层代码，挪进 withBoard 的回调里；缩进没动（少几百行假 diff）── */

const sleep = (ms) => s.sleep(ms)

/* 打开夹具板（应用从 ?file= 直接开，不再"进界面之后点左栏那一行"） */
await open()

/* 读板上的情况：面板里那节"你画过的"、浮词那排、屏幕上的词、以及卡片位置。 */
const readBoard = () => s.eval(`(() => {
  const rows = [...document.querySelectorAll('.bd-link-row')]
  const chips = document.querySelector('.bd-linkchips')
  const card = (id) => {
    const el = document.querySelector('.bd-card[data-card-id="' + id + '"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const pill = document.querySelector('.bd-linkpill')
  const pr = pill ? pill.getBoundingClientRect() : null
  return {
    count: rows.length,
    /* 词里带方向记号（「因果 →」），自检只关心词本身 —— 统一去掉箭头再比，
       不然每个断言都得把方向符号抄一遍（抄错了就是假红）。 */
    kinds: rows.map((r) => ((r.querySelector('.bd-link-kind') || {}).textContent || '').replace(/[→⇒]/g, '').trim()),
    chipsOpen: !!chips,
    chipsPick: chips ? chips.dataset.linkPick : null,
    chipsKinds: chips ? [...chips.querySelectorAll('.bd-linkchip')].map((b) => b.dataset.linkKind || 'rev') : [],
    chipsOn: chips ? (chips.querySelector('.bd-linkchip.on') || {}).dataset?.linkKind : null,
    pillText: pill ? pill.textContent.trim() : null,
    pillKind: pill ? pill.dataset.linkKind : null,
    pillCx: pr ? Math.round(pr.x + pr.width / 2) : null,
    pillCy: pr ? Math.round(pr.y + pr.height / 2) : null,
    arrows: document.querySelectorAll('[data-link-arrow]').length,
    pills: document.querySelectorAll('.bd-linkpill').length,
    ink: Number(document.querySelector('canvas.bd-ink').dataset.strokes),
    selLink: !!document.querySelector('[data-sel-link]'),
    selChips: [...document.querySelectorAll('[data-sel-link] .bd-linkchip')].map((b) => b.dataset.linkKind || 'rev'),
    /* 框住的笔里有"你说过不算连接"的那些 → 浮层里会给一条回头路 */
    inkNoLink: !!document.querySelector('[data-ink-nolink]'),
    /* 框选浮层（虚线框 + 那一排动作）在不在 */
    inkBox: !!document.querySelector('.bd-inkbox'),
    inkActs: !!document.querySelector('.bd-inkacts'),
    /* 推导链那一节（面板）：几条链、哪几步缺条件、每一步的条件写的是什么 */
    chainCount: document.querySelectorAll('.bd-chain').length,
    chainMissing: document.querySelectorAll('.bd-chain-cond.miss').length,
    chainConds: [...document.querySelectorAll('.bd-chain-cond')].map((e) => e.textContent.trim()),
    condRows: [...document.querySelectorAll('.bd-link-row .bd-cond')].map((e) => e.textContent.trim()),
    /* 「这个条件不算」那颗 ✕ / 回头路 ↺（见 check-link [12]）——
       ★ 按**行**看：夹具上有好几条连接，只有"推导"那一行会被否决，
         别的行照旧显示自己的条件（所以不能用"页面上还有没有 ✕"来判）。 */
    condNoCount: document.querySelectorAll('[data-cond-btn="no"]').length,
    condBackCount: document.querySelectorAll('[data-cond-btn="back"]').length,
    condRowInfo: rows.map((r) => ({
      kind: ((r.querySelector('.bd-link-kind') || {}).textContent || '').replace(/[→⇒]/g, '').trim(),
      cond: ((r.querySelector('.bd-cond') || {}).textContent || '').trim(),
      note: ((r.querySelector('.bd-cond-note') || {}).textContent || '').trim(),
      btn: (r.querySelector('[data-cond-btn]') || { dataset: {} }).dataset.condBtn || null,
    })),
    a: card('lk-a'),
    b: card('lk-b'),
    toast: ((document.querySelector('.toast') || {}).textContent || '').trim(),
  }
})()`)

/* 板文件里的 link 字段（等它自动存盘再读）。 */
async function fileLinks(ms = 1100) {
  await sleep(ms)
  try {
    const doc = await read()
    return doc.strokes.filter((x) => x.link).map((x) => x.link)
  } catch {
    return null
  }
}

const hitAt = (x, y) => s.eval(`(() => {
  const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
  if (!el) return '(无)'
  return el.className && typeof el.className === 'string' ? el.className : el.tagName
})()`)

/* 切工具：点工具条上那个按钮（真实用户路径）。
 * ⚠ 别用键盘 'S'/'P' 切：这条自检里键盘已经用在别处（数字键选词），
 *   而且"按了键但工具没换"会让后面整段全红，报出来却像"画不出来"。
 *   —— 这一条踩过：第一次跑 [5] 用 key('s') 切框选，[6] 就再也画不出墨了。 */
const pickTool = (label) => s.eval(`(() => {
  const b = [...document.querySelectorAll('.bd-tools .bd-t')].find((x) => x.textContent.includes(${JSON.stringify(label)}))
  if (!b) return false
  b.click()
  return true
})()`)

let st = await readBoard()
if (!st.a || !st.b) {
  bad('夹具的两张卡没渲染出来 —— 后面的断言都没意义了')
  return
}
console.log(`\n  （两张卡在屏幕上：A(${st.a.cx},${st.a.cy}) · B(${st.b.cx},${st.b.cy})）`)

/* ═════════════════ 1. 画一条线：连接当场成立 + 浮出那排词 ═════════════════ */
console.log('\n[1] 从一张卡画到另一张卡：连接当场成立，不用点任何东西')
{
  const from = { x: st.a.cx, y: st.a.cy }
  const to = { x: st.b.cx, y: st.b.cy }
  await s.penStroke(from, to, { steps: 10, hover: true })
  const now = await readBoard()
  if (now.count === 1) ok('面板里出现了 1 条"你画过的"连接')
  else bad(`面板里"你画过的"是 ${now.count} 条，应该是 1 条`)
  if (now.kinds[0] === '相关') ok('直线自动读成「相关」（无向）')
  else bad(`直线读成了「${now.kinds[0]}」，应该是「相关」`)
  if (now.chipsOpen) ok('那排词自己浮出来了（画完就有，不用去点什么）')
  else bad('画完之后没浮出那排词')
  if (now.chipsOn === 'rel') ok('浮出来的那排词里，"相关"是亮着的（= 它的判断）')
  else bad(`浮词里亮着的是 ${JSON.stringify(now.chipsOn)}，应该是 rel`)
  if (now.pillText === null && now.arrows === 0) ok('屏幕上**什么都没加**（默认那一档不加装饰：你画的那一笔就是它该有的样子）')
  else bad(`默认那一档却说画了东西：词=${now.pillText} 箭头=${now.arrows}`)
  if (now.ink === 1) ok('那一笔落在墨迹层里（是真的画了一笔，不是箭头之类）')
  else bad(`墨迹层里有 ${now.ink} 笔，应该是 1 笔`)
}

/* ═════════════════ 2. 点一个词 ═════════════════ */
console.log('\n[2] 点「因果」：面板改词、屏幕上出现词和箭头、文件里写上')
{
  const clicked = await s.eval(`(() => {
    const chips = document.querySelector('.bd-linkchips')
    if (!chips) return 'no-chips'
    const b = chips.querySelector('.bd-linkchip[data-link-kind="cause"]')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  if (clicked === 'ok') ok('点了「因果」')
  else bad(`点不到「因果」那颗词（${clicked}）`)
  await s.sleep(300)
  const now = await readBoard()
  if (now.kinds[0] === '因果') ok('面板里那一条改成了「因果」')
  else bad(`面板里还是「${now.kinds[0]}」`)
  if (now.pillText === '因果 →') ok('屏幕上多了一颗词「因果 →」')
  else bad(`屏幕上那颗词是 ${JSON.stringify(now.pillText)}`)
  if (now.arrows === 1) ok('还画了一个箭头（有方向的词才有）')
  else bad(`箭头画了 ${now.arrows} 个，应该是 1 个`)
  if (!now.chipsOpen) ok('点完那排词自己收走了（不留在屏幕上碍事）')
  else bad('点完那排词还挂着')
  const links = await fileLinks()
  if (links && links.join(',') === 'cause') ok('文件里这一笔写了 link: "cause"')
  else bad(`文件里的 link 不对：${JSON.stringify(links)}`)
}

/* ═════════════════ 3. 那颗词点得到 ═════════════════ */
console.log('\n[3] 那颗词**点得到**（回头改词的唯一入口）')
{
  const now = await readBoard()
  const hit = await hitAt(now.pillCx, now.pillCy)
  if (String(hit).includes('bd-linkpill')) ok(`词中心那一点命中的就是它自己（${hit}）`)
  else bad(`词中心命中的是「${hit}」—— 被别的东西盖住了，用户点不到`)
}

/* ═════════════════ 4. 选回"自动那一档" → 文件里的字段消失 ═════════════════ */
console.log('\n[4] 点那颗词 → 按 1 选回「相关」：回到自动，文件里那个字段消失')
{
  const before = await readBoard()
  await s.mouse(before.pillCx, before.pillCy)
  const opened = await readBoard()
  if (opened.chipsOpen) ok('点那颗词 → 那排词又出来了（可以改）')
  else bad('点那颗词没有重新浮出那排词')
  await s.key('1', 'Digit1', 49)
  const now = await readBoard()
  if (now.kinds[0] === '相关') ok('面板里回到「相关」')
  else bad(`面板里是「${now.kinds[0]}」`)
  if (now.pillText === null && now.arrows === 0) ok('屏幕上那颗词和箭头都撤了（回到默认的样子）')
  else bad(`屏幕上还留着：词=${now.pillText} 箭头=${now.arrows}`)
  const links = await fileLinks()
  if (links && links.length === 0) ok('文件里的 link 字段**没了**（选的就是自动那一档 → 不写字节）')
  else bad(`文件里还留着 ${JSON.stringify(links)} —— 会造假 diff`)
}

/* ═════════════════ 5. 框住那条线 → 浮层里再改一次 ═════════════════ */
console.log('\n[5] 框住那条线，在浮层里选「推导」')
{
  /* 切到框选（点工具条），从**空白处**起手往下拖一个框把线整个圈住。
     起点必须在空白上 —— 在卡片上按下会是拖卡片。
     ★ 框子的边一定要**离那条线有距离**：线正好压在框边上时，
       命中判定（strokeHitsRect）在边界上是说不清楚的 —— 第一次跑就是框边压着线，
       于是"框里一条笔迹都没有"，报出来却是"浮层里没有那排词"。
     ★ 尺寸都从**量到的卡片框**推出来，不写死方向：夹具换成横着摆也照样对。 */
  await pickTool('框选')
  await s.sleep(200)
  const st2 = await readBoard()
  const from = { x: st2.a.x - 70, y: st2.a.y - 60 }
  const to = { x: st2.b.x + st2.b.w + 70, y: st2.b.y + st2.b.h + 60 }
  await s.mouse(from.x, from.y, { steps: 8, dx: to.x - from.x, dy: to.y - from.y })
  const sel = await readBoard()
  if (sel.selLink) ok('框住了那条线：浮层里多出一排词')
  else bad('框住之后没看到那排词（浮层里没有 [data-sel-link]）')
  if (sel.selChips.includes('derive')) ok(`浮层里的词齐全：${sel.selChips.join(' · ')}`)
  else bad(`浮层里的词不对：${JSON.stringify(sel.selChips)}`)
  const picked = await s.eval(`(() => {
    const b = document.querySelector('[data-sel-link] .bd-linkchip[data-link-kind="derive"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  await s.sleep(300)
  const now = await readBoard()
  if (picked && now.kinds[0] === '推导') ok('选「推导」之后面板跟着改了')
  else bad(`点了「推导」，面板里却是「${now.kinds[0]}」`)
  const links = await fileLinks()
  if (links && links.join(',') === 'derive') ok('文件里改成 link: "derive"')
  else bad(`文件里的 link 不对：${JSON.stringify(links)}`)
  await pickTool('笔') // 切回笔：下面两条要画线
  await s.sleep(200)
  await s.key('Escape', 'Escape', 27)
}

/* ═════════════════ 6. 箭头工具：划一笔 = 一条连接（你宣告的） ═════════════════ */
console.log('\n[6] 箭头工具（A）：从一张卡划到另一张卡 —— 一条宣告的连接，画完自动回笔')
{
  /* 见 ADR-0001：连接不再从笔迹形状里猜（那一族 92:0），改由你**宣告**。
     这一节走的是那颗按钮 + 一次划动的完整真鼠标路径，钉四件事：
       · 栏上那颗按钮**点得到**（elementFromPoint —— 浮出来的东西被盖住是踩过的坑）；
       · 划完文件里出现 links 记录（kind=因果）、屏幕上出现"合成"的线 + 尖 + 那颗词；
       · **一次性**：画完工具回到笔（按钮高亮跟着回去）；
       · 那条记录改词走的是同一个口子（点那颗词 → 按 2 选「并列」）。 */
  const st6 = await readBoard()
  if (st6.count === 1) ok('开始这一步时有 1 条连接（就是你画的那一条）')
  else bad(`开始这一步时应该是 1 条连接，实际 ${st6.count}`)

  const toolBtn = await s.eval(`(() => {
    const b = document.querySelector('.bd-tools .bd-t[data-tool="arrow"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent.trim() }
  })()`)
  if (toolBtn) ok(`工具条上有那颗「${toolBtn.text}」按钮`)
  else bad('工具条上没有箭头工具那颗按钮')
  const toolHit = await hitAt(toolBtn.x, toolBtn.y)
  if (String(toolHit).includes('bd-t')) ok(`那颗按钮**点得到**（命中的是 ${toolHit}）`)
  else bad(`箭头按钮中心命中的是「${toolHit}」—— 用户点不到`)

  /* 用键盘 A 起手（用笔的人就是这么用的），再从 A 卡划到 B 卡。 */
  await s.key('a', 'KeyA', 65)
  const armed = await s.eval(`!!document.querySelector('.bd-tools .bd-t[data-tool="arrow"].on')`)
  if (armed) ok('按 A 之后箭头工具亮着（准备划）')
  else bad('按 A 没有切到箭头工具')

  const from = { x: st6.a.cx, y: st6.a.cy }
  const to = { x: st6.b.cx, y: st6.b.cy }
  await s.mouse(from.x, from.y, { steps: 10, dx: to.x - from.x, dy: to.y - from.y })
  await sleep(1200)

  const now = await readBoard()
  if (now.count === 2) ok('面板里多了一条（"你连的"那一条进了文件）')
  else bad(`划完应该是 2 条连接，实际 ${now.count}`)
  const doc6 = await read()
  const rec = (doc6.links || [])[0]
  if (rec && rec.kind === 'cause') ok(`文件里写着 ${JSON.stringify(rec)}（默认就是因果）`)
  else bad(`文件里的 links 不对：${JSON.stringify(doc6.links)}`)
  if (doc6.strokes.length === 1) ok('纸上**没有多出墨迹**（箭头工具不落墨，那条线是应用画的）')
  else bad(`墨迹多出来了：${doc6.strokes.length} 笔`)
  const drawn = await s.eval(`(() => ({
    line: !!document.querySelector('[data-link-line]'),
    arrow: document.querySelectorAll('[data-link-arrow]').length,
    pill: (document.querySelector('.bd-linkpill[data-link-pill]') || {}).textContent || null,
  }))()`)
  if (drawn.line && drawn.arrow >= 1 && drawn.pill === '因果 →') ok(`屏幕上：一条合成的线 + ${drawn.arrow} 个尖 + 那颗词「${drawn.pill}」`)
  else bad(`屏幕上没画全：${JSON.stringify(drawn)}`)
  const backToPen = await s.eval(`!!document.querySelector('.bd-tools .bd-t[data-tool="pen"].on')`)
  if (backToPen) ok('★ 一次性：画完自动回到笔（不用再点一下）')
  else bad('画完没有回到笔 —— "一次性"没做到')
  const chips = await s.eval(`!!document.querySelector('.bd-linkchips')`)
  if (chips) ok('那排词浮出来了（想改成推导/并列/等价当场就能点）')
  else bad('画完没有浮出那排词')

  /* 改词：按 4 = 「并列」（1=相关 2=因果 3=推导 **4=并列** 5=等价）——
     和上面那条"你画的"区分开：**你连的**那个词存在 links 记录里、**你画的**那个存在笔迹上。 */
  await s.key('4', 'Digit4', 52)
  await sleep(1200)
  const after = await readBoard()
  if (after.kinds.includes('并列')) ok('按 4 之后面板里是「并列」')
  else bad(`面板里是 ${JSON.stringify(after.kinds)}`)
  const doc6b = await read()
  if ((doc6b.links || [])[0] && doc6b.links[0].kind === 'para') ok('改完的词写进了那条记录（kind=para）')
  else bad(`记录里的词没改：${JSON.stringify(doc6b.links)}`)
}

/* ═════════════════ 6b. 箭头工具的两条护栏 ═════════════════ */
console.log('\n[6b] 箭头工具的护栏：没吸到东西 / 两头是同一个东西 —— 都不许留下记录')
{
  const st6b = await readBoard()
  await s.key('a', 'KeyA', 65)
  /* ① 空白处划一笔：两头都吸不到 → 不产生记录，而且要说一句人话 */
  const x = st6b.a.x - 260
  const y = Math.round((st6b.a.y + st6b.a.h + st6b.b.y) / 2)
  await s.mouse(x, y, { steps: 8, dx: 140, dy: 40 })
  await sleep(700)
  const after1 = await readBoard()
  if (after1.count === 2) ok('空白处划一笔：一条记录都没多（吸不到就不猜）')
  else bad(`空白处划一笔却多了记录（现在 ${after1.count} 条）`)
  if (/没落在东西上|画到卡片或板框/.test(after1.toast)) ok(`还给了一句人话：${after1.toast}`)
  else bad(`没有提示"没吸到"：${JSON.stringify(after1.toast)}`)
  const stillArrow = await s.eval(`!!document.querySelector('.bd-tools .bd-t[data-tool="arrow"].on')`)
  if (stillArrow) ok('没连上的那一次**不回笔**（你可以接着划，不用重新按 A）')
  else bad('没连上却把工具收回去了 —— 那会让人以为"按一下只能用一次"')

  /* ② 从一张卡划回它自己：同一个东西不算一条连接 */
  await s.mouse(st6b.a.cx, st6b.a.cy, { steps: 6, dx: 30, dy: 10 })
  await sleep(700)
  const after2 = await readBoard()
  if (after2.count === 2) ok('同一张卡里划一笔：也不算连接')
  else bad(`同一张卡里划一笔却多了记录（现在 ${after2.count} 条）`)
  await s.key('p', 'KeyP', 80)
  await s.key('Escape', 'Escape', 27)
}

/* ═════════════════ 7. 空白处的乱笔不算连接 ═════════════════ */
console.log('\n[7] 在空白处乱画一笔：不算连接，也不浮词')
{
  /* ★ 先把上一笔留下的那排词收掉再测。
     踩过：上一步也浮了词、3.5 秒才自己收走 —— 不等它收就画乱笔，
     看到的还是**上一步那排词**，报出来却是"乱画也浮词"。 */
  await s.key('Escape', 'Escape', 27)
  const st7 = await readBoard()
  if (!st7.chipsOpen) ok('先把上一步那排词收干净了（不然下面看到的是它）')
  else bad('那排词没收掉 —— 这一条没测准')
  if (st7.count === 2) ok(`开始这一步时有 ${st7.count} 条连接`)
  else bad(`开始这一步时应该是 2 条连接，实际 ${st7.count}`)
  /* 空白处：两张卡中间那一带的**侧面**（中轴上是那条连线）。 */
  const x = st7.a.cx + Math.round(st7.a.w * 0.75)
  const y = Math.round((st7.a.y + st7.a.h + st7.b.y) / 2)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'pen' })
  await sleep(120)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
  for (let i = 1; i <= 8; i++) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + i * 9, y: y + (i % 2 ? 14 : -14), button: 'left', buttons: 1, pointerType: 'pen' })
    await sleep(12)
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 72, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
  await sleep(300)
  const now = await readBoard()
  if (now.count === 2) ok('连接还是 2 条（乱笔没有变成关系）')
  else bad(`连接变成了 ${now.count} 条 —— 空白处的笔被当成连线了`)
  if (!now.chipsOpen) ok('也没有浮出那排词（不该打断你）')
  else bad('乱画一笔也浮出了那排词')
}

/* ═════════════════ 8. 重开：两种连接都活得下来 ═════════════════ */
console.log('\n[8] 重开一次：你点的词还在（画出来的那种存在笔迹上、连出来的那种存在记录里）')
{
  await open()
  const now = await readBoard()
  if (now.count === 2) ok('重开之后还是 2 条连接')
  else bad(`重开之后连接数变成 ${now.count}`)
  if (now.kinds.includes('推导')) ok('「你画的」那条上的词还在（存在那一笔的 link 字段里）')
  else bad(`"你画的"那条的词丢了：${JSON.stringify(now.kinds)}`)
  if (now.kinds.includes('并列')) ok('「你连的」那条上的词也还在（存在 links 记录里）')
  else bad(`"你连的"那条的词丢了：${JSON.stringify(now.kinds)}`)
  const doc = await read()
  if ((doc.links || []).length === 1) ok('文件里那条记录还在（重开读得回来）')
  else bad(`文件里的 links 不对：${JSON.stringify(doc.links)}`)
}

/* ═════════════════ 9. 「删掉这条连接」：两种来源，一个动作 ═════════════════ */
console.log('\n[9] 「删掉这条连接」（那排词里 `0` 那颗）：你连的删记录、你画的删那一笔')
{
  /* 这颗位置原来写着「不算连接」（那是给"猜错了"配的否决权）。第二刀把猜删掉之后，
     它换成了这个动作 —— 而一条连接有两种来源，所以同一个动作要翻译成两件事。 */
  const st9 = await readBoard()
  if (st9.count === 2) ok(`开始这一步时有 ${st9.count} 条连接`)
  else bad(`开始这一步时应该是 2 条连接，实际 ${st9.count}`)

  /* ① 你**连**的那条：点它那颗词 → 那排词 → 按 0 */
  const pill = await s.eval(`(() => {
    const p = document.querySelector('.bd-linkpill[data-link-pill]')
    if (!p) return null
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), id: p.getAttribute('data-link-pill') }
  })()`)
  if (pill) ok(`找到"你连的那条"那颗词（${pill.id}）`)
  else bad('屏幕上找不到"你连的那条"那颗词')
  await s.mouse(pill.x, pill.y)
  const opened = await readBoard()
  if (opened.chipsOpen) ok('点那颗词 → 那排词又浮出来了')
  else bad('点那颗词没有浮出那排词')
  const hasDelete = await s.eval(`!!document.querySelector('.bd-linkchips .bd-linkchip[data-link-kind="delete"]')`)
  if (hasDelete) ok('那排词里有一颗「删掉这条连接」（data-link-kind="delete"）')
  else bad('那排词里没有「删掉这条连接」那颗')
  await s.key('0', 'Digit0', 48)
  await sleep(1200)
  const after = await readBoard()
  if (after.count === 1) ok('删掉之后只剩 1 条（那条记录真的走了）')
  else bad(`删完还剩 ${after.count} 条`)
  const doc9 = await read()
  if (!doc9.links || doc9.links.length === 0) ok('文件里的 links 字段也没了（不留空壳）')
  else bad(`文件里还留着：${JSON.stringify(doc9.links)}`)
  const gone = await s.eval(`!document.querySelector('[data-link-line]') && !document.querySelector('.bd-linkpill[data-link-pill]')`)
  if (gone) ok('屏幕上那条线和那颗词一起消失了')
  else bad('删完了屏幕上还挂着那条连线')
  if (doc9.strokes.length === 1) ok('纸上那一笔一个字都没动（删的是记录，不是墨迹）')
  else bad(`墨迹被动了：${doc9.strokes.length} 笔`)

  /* ② 你**画**的那条：再画一条 A→B 的线 → 那排词 → 按 0 → 删的是**那一笔** */
  const st9b = await readBoard()
  const from = { x: st9b.a.cx - Math.round(st9b.a.w * 0.25), y: st9b.a.cy }
  const to = { x: st9b.b.cx + Math.round(st9b.b.w * 0.25), y: st9b.b.cy }
  await pickTool('笔')
  await s.sleep(150)
  await s.penStroke(from, to, { steps: 10, hover: true })
  const drew = await readBoard()
  if (drew.count === 2) ok('新画的这条也成了连接（2 条）')
  else bad(`画完应该是 2 条连接，实际 ${drew.count}`)
  if (drew.chipsOpen) ok('那排词浮出来了')
  else bad('没浮出那排词，后面点不到')
  const inkBefore = drew.ink
  await s.key('0', 'Digit0', 48)
  await sleep(1200)
  const del = await readBoard()
  if (del.count === 1) ok('这条不算连接了（回到 1 条）')
  else bad(`删完还剩 ${del.count} 条`)
  if (del.ink === inkBefore - 1) ok(`那一笔也从墨迹层里删掉了（${inkBefore} → ${del.ink}）—— "删掉这条连接"对画出来的那条就是删那一笔`)
  else bad(`墨迹层笔数不对：${inkBefore} → ${del.ink}`)
  const doc9b = await read()
  if (doc9b.strokes.length === 1) ok('文件里也只剩那一笔（画出来的那条不留记录、删了就是删了）')
  else bad(`文件里的笔数不对：${doc9b.strokes.length}`)
  /* 一步撤销能把它找回来（和别处一样：删是一条正常的撤销步） */
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await sleep(900)
  const undone = await readBoard()
  if (undone.count === 2) ok('Ctrl+Z 一步就把它找回来了（2 条）')
  else bad(`Ctrl+Z 之后是 ${undone.count} 条（应该 2 条）`)
}

/* ═════════════════ 10. 板框：留下 / 起名 / 整体挪 / 拆开 ═════════════════ */
console.log('\n[10] 板框（`frames`）：框住 → 留下板框 → 起名 → 整体挪 → 拆开')
{
  /* 见 ADR-0001：板框是"你亲手留下的一个整体"（从前的"固定成一块"长出了脸）。
     这一段走的是**真鼠标**的完整一条路，包括三件只有真 DOM 才验得了的事：
       · 顶栏那颗名字**点得到**（elementFromPoint）——浮出来的把手被盖住是踩过的坑；
       · 双击它就地改名、回车落盘；
       · 拖它 = **成员整体挪**（框线是成员的函数，跟着走）。 */
  /* ⚠ 这一段要读**文件**（不是屏幕），所以每处读之前都要给它自动存盘的时间：
     应用的自动存盘是"停手 0.7 秒后写盘"（README「别按 Ctrl+S」那一节）。 */
  const docBefore = await read({ wait: 900 })
  const pointsOf = (doc, ids) =>
    JSON.stringify(
      (doc.strokes || [])
        .filter((s) => ids.includes(s.id))
        .map((s) => [s.id, s.points.slice(0, 6)])
    )
  const allPoints = (doc) => JSON.stringify((doc.strokes || []).map((s) => [s.id, s.points.slice(0, 6)]))

  await pickTool('框选')
  await s.sleep(200)
  const st10 = await readBoard()
  const f10 = { x: st10.a.x - 70, y: st10.a.y - 60 }
  const t10 = { x: st10.a.x + st10.a.w + 70, y: st10.a.y + st10.a.h + 60 }
  await s.mouse(f10.x, f10.y, { steps: 8, dx: t10.x - f10.x, dy: t10.y - f10.y })
  const sel10 = await readBoard()
  if (sel10.inkBox && sel10.inkActs) ok('框住了东西（虚线框和那排动作都在）')
  else bad(`框选没选上东西（inkBox=${sel10.inkBox} inkActs=${sel10.inkActs}）—— 后面几条没意义`)

  const hasKeep = await s.eval(`!!document.querySelector('[data-ink-group="on"]')`)
  if (hasKeep) ok('浮层上有「▣ 留下板框」')
  else bad('浮层上没有「留下板框」那个按钮')
  /* ★ 不能只看"在不在 DOM 里"：浮出来的按钮被别的层盖住、或者跑到画布外面，
     在这套界面里都是踩过的坑（README 第 13 条）。命中测试说了算。 */
  const keepHit = await s.eval(`(() => {
    const b = document.querySelector('[data-ink-group="on"]')
    if (!b) return 'no-btn'
    const r = b.getBoundingClientRect()
    const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2))
    if (!el) return '(无)'
    return el === b || b.contains(el) ? 'self' : (el.className && typeof el.className === 'string' ? el.className : el.tagName)
  })()`)
  if (keepHit === 'self') ok('那颗按钮**真的点得到**（中心命中的是它自己）')
  else bad(`「留下板框」中心命中的是「${keepHit}」—— 用户点不到`)

  await s.eval(`(() => { const b = document.querySelector('[data-ink-group="on"]'); if (b) b.click() })()`)
  await sleep(1200)
  const doc1 = await read()
  const fr = Array.isArray(doc1.frames) ? doc1.frames[0] : null
  if (fr && fr.ids.length >= 2) ok(`文件里写下了 1 个板框（${fr.ids.length} 笔）`)
  else bad(`文件里的 frames 不对：${JSON.stringify(doc1.frames)}`)
  const memberIds = fr ? fr.ids : []

  /* 屏幕上出现框 + 那颗名字（它是唯一的把手） */
  const chip = await s.eval(`(() => {
    const t = document.querySelector('.bd-frame-t')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t.textContent.trim(), dim: t.classList.contains('dim') }
  })()`)
  if (chip) ok(`屏幕上出现板框的名字：${JSON.stringify(chip.text)}（还没起名时是灰的）`)
  else bad('屏幕上没有出现板框的名字（.bd-frame-t）')
  /* 框线要真的围着成员：量一下框的屏幕矩形，成员笔迹都在里面 */
  const around = await s.eval(`(() => {
    const f = document.querySelector('.bd-frame')
    if (!f) return null
    const r = f.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  if (around && around.w > 40 && around.h > 20) ok(`框线画出来了（${around.w}×${around.h} 屏幕像素）`)
  else bad(`框线看着不对：${JSON.stringify(around)}`)

  /* 双击把手 → 就地改名 → 回车落盘 */
  await s.doubleClick(chip.x, chip.y)
  const editing = await s.eval(`!!document.querySelector('.bd-frame-in')`)
  if (editing) ok('双击那颗名字 → 就地出现输入框')
  else bad('双击板框的名字没有出现输入框')
  await s.eval(`(() => {
    const el = document.querySelector('.bd-frame-in')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '这一节')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await s.key('Enter', 'Enter', 13)
  await sleep(1200)
  const doc2 = await read()
  if (doc2.frames && doc2.frames[0] && doc2.frames[0].title === '这一节') ok('标题写进文件了（`title: "这一节"`）')
  else bad(`文件里的标题不对：${JSON.stringify(doc2.frames && doc2.frames[0])}`)
  const chip2 = await s.eval(`(() => {
    const t = document.querySelector('.bd-frame-t')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t.textContent.trim() }
  })()`)
  if (chip2 && chip2.text.includes('这一节')) ok('屏幕上的名字跟着变了')
  else bad(`屏幕上的名字没变：${JSON.stringify(chip2)}`)

  /* 拖它 → **成员整体挪**（框线是成员的函数，自己跟着走）。
     ⚠ "拖前的位置"要在**这一刻**重新读一次文件：上面刚改过标题、而自动存盘是停手 0.7 秒后 ——
     拿 [10] 开头那份快照会比现在的文件少几笔（第一次跑就是栽在这儿：拖前的点里少了一笔）。 */
  const docPreDrag = await read({ wait: 900 })
  const ptsBefore = pointsOf(docPreDrag, memberIds)
  await s.mouse(chip2.x, chip2.y, { steps: 8, dx: 60, dy: 40 })
  await sleep(1200)
  const doc3 = await read()
  const ptsAfter = pointsOf(doc3, memberIds)
  if (memberIds.length && ptsAfter !== ptsBefore) ok('拖那颗名字：框里的笔迹整体挪了')
  else bad('拖了板框，成员一个都没动')
  const others = (doc3.strokes || []).filter((s) => !memberIds.includes(s.id))
  const othersBefore = (docBefore.strokes || []).filter((s) => !memberIds.includes(s.id))
  if (JSON.stringify(others.map((s) => s.id)) === JSON.stringify(othersBefore.map((s) => s.id)) && allPoints(doc3).length > 0) {
    ok('框外面的笔一笔都没动（只挪这个框里的东西）')
  } else {
    bad('拖板框把框外面的东西也动了（或者笔少了）')
  }
  /* 一次拖动 = 一步撤销 */
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await sleep(900)
  const doc4 = await read()
  if (pointsOf(doc4, memberIds) === ptsBefore) ok('Ctrl+Z 一步就把整次拖动退回去了（一次拖动 = 一步撤销）')
  else bad(`Ctrl+Z 之后位置没回到拖动前（拖前 ${ptsBefore.slice(0, 70)} / 撤销后 ${pointsOf(doc4, memberIds).slice(0, 70)}）`)

  /* 点那颗名字选中 → Delete 拆开（内容一个字都不动） */
  await s.mouse(chip2.x, chip2.y, { steps: 0 })
  await s.sleep(200)
  const selected = await s.eval(`!!document.querySelector('.bd-frame.on')`)
  if (selected) ok('点一下那颗名字 → 这个框被选中了')
  else bad('点了板框的名字，它没被选中')
  await s.key('Delete', 'Delete', 46)
  await sleep(1200)
  const doc5 = await read()
  if (!doc5.frames || doc5.frames.length === 0) ok('Delete 拆开了这个框（frames 字段消失）')
  else bad(`拆开之后 frames 还在：${JSON.stringify(doc5.frames)}`)
  if (allPoints(doc5) === allPoints(doc4)) ok('拆开只解散了框，内容一个字都没动')
  else bad('拆开的时候内容被改了（不该）')
  const noChip = await s.eval(`!document.querySelector('.bd-frame-t')`)
  if (noChip) ok('屏幕上那个框也没了')
  else bad('拆开之后屏幕上还挂着板框')
}

/* ═════════════════ 11. 条件从位置送 + 推导链 ═════════════════ */
console.log('\n[11] 条件从位置送：线中点旁边写几个字，面板上的"缺条件"就变成"条件：…"')
{
  /* 用户的原话：「条件是位置送的。线中点附近那几个字 / 那张卡，自动成为这条关系的条件
     —— 你本来就要写"仅当…"，不用再告诉它是谁的条件。」
     这一步走的正是那句话：链上那一步缺条件 → 在线中点旁边写两笔 → 它自己补上。 */
  const st8 = await readBoard()
  if (st8.chainCount === 1) ok('面板里读出了 1 条推导链（[5] 标的那条「推导」）')
  else bad(`推导链应该是 1 条，实际 ${st8.chainCount}（chainConds=${JSON.stringify(st8.chainConds)}）`)
  const before = await readBoard()
  const missBefore = before.chainMissing
  if (missBefore >= 0) ok(`现在有 ${missBefore} 步是"缺条件"（下一步把它补上）`)
  /* 在那条线的**中点**旁边写两个短笔 —— 尺寸要按**世界像素**算：
     条件要过"块的最小个头"（18 世界像素）和"中点在 64 世界像素之内"两条闸，
     而屏幕上看到的距离要乘/除视图缩放。缩放从"两张卡的屏幕距离 ÷ 世界距离"量出来
     （踩过：第一次按屏幕像素画 22px，视图一缩小就只剩 11 世界像素 → 个头不够、条件读不出来）。 */
  const fixture = await read()
  const ca = fixture.cards.find((c) => c.id === 'lk-a')
  const cb = fixture.cards.find((c) => c.id === 'lk-b')
  const wDist = Math.hypot(ca.x + ca.w / 2 - (cb.x + cb.w / 2), ca.y + ca.h / 2 - (cb.y + cb.h / 2))
  const sDist = Math.hypot(before.a.cx - before.b.cx, before.a.cy - before.b.cy)
  const scale = wDist > 0 ? sDist / wDist : 1
  const mx = Math.round((before.a.cx + before.b.cx) / 2)
  const my = Math.round((before.a.cy + before.b.cy) / 2)
  const wx = (n) => n * scale // 世界像素 → 屏幕像素
  await pickTool('笔')
  await s.sleep(150)
  /* 两条 30 世界像素的短笔（< INK_LINK_MIN_LEN 48，所以不会变成新连接），
     离中点 30 / 40 世界像素（< LINK_COND_RADIUS 64），彼此差 10 像素（< 24 → 聚成一块） */
  await s.penStroke({ x: mx - wx(15), y: my - wx(40) }, { x: mx + wx(15), y: my - wx(38) }, { steps: 4, hover: true })
  await s.penStroke({ x: mx - wx(14), y: my - wx(30) }, { x: mx + wx(16), y: my - wx(28) }, { steps: 4, hover: true })
  await s.key('Escape', 'Escape', 27) // 收掉可能浮出来的那排词，别挡住读数
  await s.sleep(500)
  const after = await readBoard()
  if (after.ink > before.ink) ok(`中点旁边真的写上了（墨迹层 ${before.ink} → ${after.ink}，缩放 ${scale.toFixed(2)}）`)
  else bad(`那两笔没写上（墨迹层 ${before.ink} → ${after.ink}）—— 后面的读数没意义`)
  if (after.chainMissing < missBefore || (missBefore === 0 && after.chainConds.length > 0)) {
    ok(`写完那几个字，"缺条件"少了（${missBefore} → ${after.chainMissing}）`)
  } else {
    bad(`在中点旁边写了字，条件没被读出来（missing ${missBefore} → ${after.chainMissing}，conds=${JSON.stringify(after.chainConds)}）`)
  }
  if (after.condRows.some((t) => /条件/.test(t))) ok(`「你画过的」那一行也挂上了条件（${after.condRows[0]}）`)
  else bad(`连接那一行没显示条件：${JSON.stringify(after.condRows)}`)
  if (after.count === before.count) ok('这两笔短笔没有变成新连接（够短 → 不进连接那套判据）')
  else bad(`短笔变成了连接：${before.count} → ${after.count}`)
  /* 条件**不写盘**：它是从位置读出来的，文件里一个字段都不该多 */
  const doc = await read()
  if (!JSON.stringify(doc).includes('"cond"')) ok('条件没写进文件（位置读出来的，随时能重算）')
  else bad('文件里出现了 cond 字段 —— 位置推断不该存盘')
}

/* ═════════════════ 12. 「这个条件不算」 ═════════════════ */
/* 用户 2026-09-16 那条小尾巴：「写在中点旁边的字算条件，但没法说'这个条件不是给这条线的'」。
 * 这一步就走那条路：面板连接那一行上的 ✕（位置读错了）→ 那句话作废 → 文件里写下来 →
 * 重开还在 → 旁边的 ↺ 改回来（一步正常的撤销，不是单向门）。
 * ★ 全用真鼠标，而且先问 elementFromPoint —— 它是一颗 18px 的小按钮，
 *   和「📌 点得到」那类断言同一个道理（README 第 11 条）。 */
console.log('\n[12] 「这个条件不算」：位置读错了，一句话作废（而且能改回来）')
{
  /* ★ 按**行**看：夹具上有 4 条连接，条件可能不止一条有；
     这一节只认「推导」那一行（[5] 标的那条，[11] 在中点旁边写了字）。 */
  const rowOf = (st) => (st.condRowInfo || []).find((r) => /推导/.test(r.kind)) || null
  const btnRect = (which) =>
    s.eval(`(() => {
      const rows = [...document.querySelectorAll('.bd-link-row')]
      const row = rows.find((x) => /推导/.test(((x.querySelector('.bd-link-kind') || {}).textContent || '')))
      const el = row && row.querySelector('[data-cond-btn="' + ${JSON.stringify(which)} + '"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
    })()`)

  const before = await readBoard()
  const row0 = rowOf(before)
  if (!row0 || row0.btn !== 'no') {
    bad('面板「推导」那一行上没有那颗 ✕ —— [11] 那一步没读出条件，这一节验不了')
  } else {
    ok(`「推导」那一行显示着条件、右边有一颗 ✕（${row0.cond}）`)
    if (row0.cond && !row0.note) ok('还没说过话 → 没有"你说过条件不算"那句，也没有 ↺')
    else bad('一上来就有那句痕迹 —— 板上有别人留下的 cond 字段')
    const miss0 = before.chainMissing

    const btn = await btnRect('no')
    const hit = await hitAt(btn.cx, btn.cy)
    if (String(hit).includes('bd-cond-no')) ok(`✕ 中心那一点命中的就是它自己（${btn.w}×${btn.h}）`)
    else bad(`✕ 中心命中的是「${hit}」—— 它被别的东西盖住了，用户点不到`)

    /* 真鼠标点一下 */
    await s.mouse(btn.cx, btn.cy)
    await s.sleep(500)
    const after = await readBoard()
    const row1 = rowOf(after)
    if (row1 && !row1.cond) ok('那条线的条件从面板上撤掉了（位置读出来的那个不算数了）')
    else bad(`条件还在：${JSON.stringify(row1)}`)
    if (row1 && /不算/.test(row1.note)) ok(`面板照实说"你说过条件不算"（${row1.note}）`)
    else bad(`没显示那句"你说过不算"：${JSON.stringify(row1)}`)
    if (row1 && row1.btn === 'back') ok('★ 同一颗位置变成了 ↺（回头路就在手边）')
    else bad('点完 ✕ 没出现 ↺ —— 那这句话就成了单向门')
    if (after.condBackCount === before.condBackCount + 1 && after.condNoCount === before.condNoCount - 1) {
      ok(`只有这一行的按钮翻了面（✕ ${before.condNoCount}→${after.condNoCount}，↺ ${before.condBackCount}→${after.condBackCount}）`)
    } else {
      bad(`别的行的按钮也动了：✕ ${before.condNoCount}→${after.condNoCount}，↺ ${before.condBackCount}→${after.condBackCount}`)
    }
    if (after.chainMissing > miss0) ok(`推导链那一步回到"缺条件"（${miss0} → ${after.chainMissing}）—— 你说的是"那撮字不是它的条件"`)
    else bad(`链上那一步没回到缺条件（${miss0} → ${after.chainMissing}）`)
    if (after.count === before.count) ok('否决条件没有多出/少掉连接')
    else bad(`连接数变了：${before.count} → ${after.count}`)

    /* 留一张图给人自己看一眼（"那句痕迹 + ↺"长什么样）—— 这一块没有像素自检，只能眼看 */
    {
      const clip = await s.eval(`(() => {
        const el = document.querySelector('.bd-rel')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          x: Math.max(0, Math.round(r.x - 4)), y: Math.max(0, Math.round(r.y - 4)),
          width: Math.round(r.width + 8), height: Math.min(520, Math.round(r.height + 8)), scale: 1,
        }
      })()`)
      if (clip) {
        const shot = await s.send('Page.captureScreenshot', { format: 'png', clip })
        fs.writeFileSync('.cache/cond-veto.png', Buffer.from(shot.data, 'base64'))
        console.log('     截图：.cache/cond-veto.png（关系面板那一块）')
      }
    }

    /* 落盘：那句话写在那一笔上（cond: "none"），重开还在 */
    const doc = await read({ wait: 1200 })
    const withCond = (doc.strokes || []).filter((x) => x.cond === 'none')
    if (withCond.length === 1) ok('文件里正好一笔写着 cond: "none"')
    else bad(`文件里的 cond 不对：${JSON.stringify((doc.strokes || []).map((x) => [x.id, x.cond]).filter((x) => x[1]))}`)

    await open()
    const reopened = await readBoard()
    const row2 = rowOf(reopened)
    if (row2 && row2.btn === 'back' && /不算/.test(row2.note)) ok('重开之后那句话还在（不是只活在这一屏）')
    else bad(`重开之后那句话丢了：${JSON.stringify(row2)}`)
    if (row2 && !row2.cond) ok('重开之后条件仍然不算')
    else bad(`重开之后条件又回来了：${JSON.stringify(row2 && row2.cond)}`)
    if (reopened.chainMissing > miss0) ok('重开之后链上那一步仍然缺条件')

    /* 回头路：点 ↺ → 又按位置读 */
    const back = await btnRect('back')
    if (!back) {
      bad('重开之后找不到 ↺（那这条回头路断了）')
    } else {
      const hit2 = await hitAt(back.cx, back.cy)
      if (String(hit2).includes('bd-cond-no')) ok('↺ 中心那一点命中的也是它自己')
      else bad(`↺ 中心命中的是「${hit2}」`)
      await s.mouse(back.cx, back.cy)
      await s.sleep(500)
      const restored = await readBoard()
      const row3 = rowOf(restored)
      if (row3 && /条件/.test(row3.cond)) ok(`改回来了：条件又按位置读出来了（${row3.cond}）`)
      else bad(`点了 ↺ 条件没回来：${JSON.stringify(row3)}`)
      if (row3 && row3.btn === 'no' && !row3.note) ok('↺ 收走了，那颗 ✕ 回到原位')
      else bad(`按钮没回到 ✕：${JSON.stringify(row3)}`)
      if (restored.chainMissing <= miss0) ok(`推导链那一步又不缺条件了（${restored.chainMissing}）`)
      else bad(`链上那一步还缺着：${restored.chainMissing}`)
      const doc2 = await read({ wait: 1200 })
      if (!JSON.stringify(doc2).includes('"cond"')) ok('文件里那个字段也没了（回头路清得干净）')
      else bad('文件里还留着 cond 字段')
    }
  }
}

/* ═════════════════ 13. 「条件就是它」 ═════════════════ */
/* 位置送的条件还有**读不到**的时候：条件写在别处（或者你后来把那几笔挪走了 ——
 * 那正是"位置送"的定义）。这时得能亲手指一个：那一行右边的 **∈** → 再点一下目标
 * （一撮字 / 一张卡）。存成 `cond: 'ink:<笔 id>'` / `'card:<卡 id>'`。
 * 入口为什么在**面板那一行**而不是框选浮层：板上几条线走同一条走廊时"只框住其中一条"
 * 很不好框，而"缺条件"本来就显示在那一行上（见 Board.jsx 的注释）。
 * ★ 全程真鼠标 + elementFromPoint：那颗 ∈ 是行内 span（那一行本身是 button），
 *   和「📌 点得到」那类断言同一个道理（README 第 11 条）。 */
console.log('\n[13] 「条件就是它」：位置读不到时，在那一行按 ∈ 再点一下目标')
{
  const rowInfo = async () =>
    (await readBoard()).condRowInfo.find((r) => /推导/.test(r.kind)) || null
  const armBtn = () =>
    s.eval(`(() => {
      const rows = [...document.querySelectorAll('.bd-link-row')]
      const row = rows.find((x) => /推导/.test(((x.querySelector('.bd-link-kind') || {}).textContent || '')))
      const el = row && row.querySelector('[data-arm-cond]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), strokeId: el.dataset.armCond }
    })()`)
  const condBtn = (which) =>
    s.eval(`(() => {
      const rows = [...document.querySelectorAll('.bd-link-row')]
      const row = rows.find((x) => /推导/.test(((x.querySelector('.bd-link-kind') || {}).textContent || '')))
      const el = row && row.querySelector('[data-cond-btn="' + ${JSON.stringify(which)} + '"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
    })()`)

  const start = await readBoard()
  const row0 = await rowInfo()
  if (!row0 || !row0.cond) {
    bad(`这一节要的前提不对（推导那一行现在没有条件显示）：${JSON.stringify(row0)}`)
  } else {
    ok(`推导那一行现在挂的是位置读出来的条件（${row0.cond}）`)
    /* ① 有条件时**不给** ∈（那一行已经有 ✕ 了，别挤三颗按钮） */
    if (!(await armBtn())) ok('这时候没有 ∈（有条件 → 给的是 ✕；设计如此，一行最多两颗按钮）')
    else bad('有条件时也摆了一颗 ∈ —— 那一行会挤三颗按钮')

    /* ② 先否决掉位置读错的那个 → 那一行变成"条件不算"，∈ 才出现 */
    const veto = await condBtn('no')
    if (!veto) {
      bad('找不到那颗 ✕')
    } else {
      await s.mouse(veto.cx, veto.cy)
      await s.sleep(450)
      const row1 = await rowInfo()
      if (row1 && /不算/.test(row1.note)) ok('否决成功（那一行显示"条件不算"）')
      else bad(`否决没生效：${JSON.stringify(row1)}`)

      /* ③ 按 ∈ → 武装：整块板换十字光标、按钮亮着、给一句人话 */
      const btn = await armBtn()
      if (!btn) {
        bad('否决之后那一行上还是没有 ∈ —— 那"指一个"这条路就没有入口')
      } else {
        const hit = await hitAt(btn.cx, btn.cy)
        if (String(hit).includes('bd-cond-no')) ok(`∈ 中心命中的就是它自己（${btn.w}×${btn.h}）`)
        else bad(`∈ 中心命中的是「${hit}」—— 用户点不到`)
        await s.mouse(btn.cx, btn.cy)
        await s.sleep(350)
        const armed = await s.eval(`(() => ({
          cls: (document.querySelector('.bd') || {}).className || '',
          on: !!document.querySelector('[data-arm-cond].on'),
          toast: ((document.querySelector('.toast') || {}).textContent || '').trim(),
        }))()`)
        if (/condarm/.test(armed.cls)) ok('武装上了（.bd.condarm —— 整块板换成十字光标）')
        else bad(`没武装：class=${armed.cls}`)
        if (armed.on) ok('那颗 ∈ 亮着（知道自己正指着谁）')
        else bad('∈ 没亮')
        if (/点一下/.test(armed.toast)) ok('给了一句人话：' + armed.toast)
        else bad('没提示怎么指：' + JSON.stringify(armed.toast))

        /* ④ Esc 先收掉武装（不然你以为取消了、其实下一下点还是会指过去） */
        await s.key('Escape', 'Escape', 27)
        await s.sleep(250)
        if (!(await s.eval("!!document.querySelector('.bd.condarm')"))) ok('Esc 收掉了武装')
        else bad('Esc 没收掉武装')
        await s.mouse(btn.cx, btn.cy)
        await s.sleep(300)

        /* ⑤ 点一下**那撮字**（[11] 写在中点旁边的那两笔）→ 它成了条件。
              （这一步验的是"指"这条路的接线：指谁都能写进去；指得对不对是用户的事。） */
        const fixture = await read()
        const ca = fixture.cards.find((c) => c.id === 'lk-a')
        const cb = fixture.cards.find((c) => c.id === 'lk-b')
        const now = await readBoard()
        const wDist = Math.hypot(ca.x + ca.w / 2 - (cb.x + cb.w / 2), ca.y + ca.h / 2 - (cb.y + cb.h / 2))
        const sDist = Math.hypot(now.a.cx - now.b.cx, now.a.cy - now.b.cy)
        const scale = wDist > 0 ? sDist / wDist : 1
        const mx = Math.round((now.a.cx + now.b.cx) / 2)
        const my = Math.round((now.a.cy + now.b.cy) / 2)
        await s.mouse(mx, my - Math.round(34 * scale)) // 那两笔短笔之间（世界 -34 换算到屏幕）
        await s.sleep(500)
        const pickedInk = await readBoard()
        const row2 = await rowInfo()
        if (row2 && /条件/.test(row2.cond) && /你指的/.test(row2.cond)) ok(`那一行写上了"（你指的）"：${row2.cond}`)
        else bad(`没写出"你指的"：${JSON.stringify(row2)}`)
        if (!(await s.eval("!!document.querySelector('.bd.condarm')"))) ok('指完就收（一次性，不会留着影响下一次画）')
        else bad('指完还武装着 —— 下次落笔会被它吃掉')
        const doc = await read({ wait: 1200 })
        const inkCond = (doc.strokes || []).map((x) => x.cond).filter((v) => typeof v === 'string' && v.startsWith('ink:'))
        if (inkCond.length === 1) ok('文件里写的是 ' + inkCond[0])
        else bad('文件里的 cond 不对：' + JSON.stringify((doc.strokes || []).map((x) => [x.id, x.cond]).filter((x) => x[1])))

        /* ⑥ 重开还在，然后 ↺ 回到按位置读 */
        await open()
        const row3 = await rowInfo()
        if (row3 && /你指的/.test(row3.cond) && row3.btn === 'back') ok('重开之后还是你指的那一个（而且 ↺ 在）')
        else bad(`重开之后丢了：${JSON.stringify(row3)}`)
        const back = await condBtn('back')
        if (!back) {
          bad('找不到 ↺')
        } else {
          await s.mouse(back.cx, back.cy)
          await s.sleep(450)
          const row4 = await rowInfo()
          if (row4 && /条件/.test(row4.cond) && !/你指的/.test(row4.cond)) ok(`↺ 回到按位置读了（${row4.cond}）`)
          else bad(`点了 ↺ 没回到按位置读：${JSON.stringify(row4)}`)
          const doc2 = await read({ wait: 1200 })
          if (!/"cond"/.test(JSON.stringify(doc2))) ok('文件里那个字段也清掉了')
          else bad('文件里还留着 cond')

          /* ⑦ 另一条路：点一张**卡**当条件（卡片自己收指针事件，所以那是另一段代码） */
          const veto2 = await condBtn('no')
          if (!veto2) {
            bad('第二步找不到那颗 ✕')
          } else {
            await s.mouse(veto2.cx, veto2.cy)
            await s.sleep(400)
            const btn2 = await armBtn()
            if (!btn2) {
              bad('第二次没找到 ∈')
            } else {
              await s.mouse(btn2.cx, btn2.cy)
              await s.sleep(300)
              const card = await s.eval(`(() => {
                const el = document.querySelector('.bd-card[data-card-id="lk-a"]')
                if (!el) return null
                const r = el.getBoundingClientRect()
                return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
              })()`)
              await s.mouse(card.cx, card.cy)
              await s.sleep(500)
              const pickedCard = await readBoard()
              const row5 = pickedCard.condRowInfo.find((r) => /推导/.test(r.kind))
              if (row5 && /你指的/.test(row5.cond)) ok(`点一张卡也能当条件：${row5.cond}`)
              else bad(`点卡片那条路没走通：${JSON.stringify(row5)}`)
              const doc3 = await read({ wait: 1200 })
              const cardCond = (doc3.strokes || []).map((x) => x.cond).filter((v) => typeof v === 'string' && v.startsWith('card:'))
              if (cardCond.length === 1 && /card:lk-a/.test(cardCond[0])) ok('文件里写的是 ' + cardCond[0])
              else bad('文件里的 cond 不对：' + JSON.stringify(cardCond))
              if (pickedCard.count === start.count) ok('"指一个条件"没有多出/少掉连接')
              else bad(`连接数变了：${start.count} → ${pickedCard.count}`)
              /* 收尾：把那句话清掉，别影响后面的收尾检查 */
              const back2 = await condBtn('back')
              if (back2) {
                await s.mouse(back2.cx, back2.cy)
                await s.sleep(400)
              }
            }
          }
        }
      }
    }
  }
  await s.key('Escape', 'Escape', 27)
}

/* ═════════════════ 14. 宣告的连接：屏幕上那条箭头是应用画的 ═════════════════ */
console.log('\n[14] 宣告的连接（`links`）：两端 + 一个词，线是应用合成的、跟着框走')
{
  /* 见 ADR-0001。这一节验的是**渲染那一半**（箭头工具是第二刀的事）：
     往夹具里写一条记录（两端 = 一个板框 + 一张卡）、重开，屏幕上必须出现：
       · 一条合成的线（`.bd-linkline`，圆角、带一点点弧度）；
       · 一个尖（自己画的那个尖不存在，所以这次是应用画的）；
       · 线上那颗词；
       · 面板里"你连的"和"板框（1 个）"两节。
     ★ 用"写进文件再重开"这条路，是因为第一刀还没有造它的界面入口 ——
       而这一段钉的正是"文件里写了，屏幕上就该有"。
     夹具是我们自己的（board-zz-linkcheck.md），改它不碰用户的数据。 */
  const doc = JSON.parse(fs.readFileSync(board.path, 'utf8'))
  const two = (doc.strokes || []).slice(0, 2).map((s) => s.id)
  doc.frames = [{ id: 'fr1', title: '第一节', ids: two }]
  doc.links = [{ from: 'fr1', to: 'lk-b', kind: 'cause' }]
  fs.writeFileSync(board.path, JSON.stringify(doc, null, 1) + '\n', 'utf8')
  await open()
  await s.sleep(400)

  const rendered = await s.eval(`(() => {
    const line = document.querySelector('[data-link-line]')
    /* ★ 尖要**按 id 找那一条**：板上还有别的（画出来的）连接也会画尖，
       不加这个限定的话，"有尖"这条断言可能被别人的尖喂饱（假绿）。 */
    const arrow = document.querySelector('[data-link-arrow="fr1|lk-b"]')
    const pill = document.querySelector('.bd-linkpill[data-link-pill]')
    const frame = document.querySelector('.bd-frame')
    const row = document.querySelector('[data-link-declared]')
    const frameRow = document.querySelector('[data-frame-row]')
    const d = line ? line.getAttribute('d') : null
    return {
      hasLine: !!line,
      curved: !!(d && d.includes('Q')),
      hasArrow: !!arrow,
      pill: pill ? pill.textContent.trim() : null,
      frameTitle: frame ? frame.getAttribute('data-frame-title') : null,
      declaredRow: row ? row.textContent.replace(/\\s+/g, ' ').trim() : null,
      frameRow: frameRow ? frameRow.textContent.replace(/\\s+/g, ' ').trim() : null,
    }
  })()`)
  if (rendered.hasLine) ok('屏幕上画出了那条合成的线（.bd-linkline）')
  else bad('屏幕上没有那条线 —— 宣告的连接没画出来')
  if (rendered.curved) ok('线是一点点弧（不是硬邦邦的直线段）')
  else bad(`线的路径看着不对：${rendered.curved}`)
  if (rendered.hasArrow) ok('尖是**应用画的**（你没有画过那一笔）')
  else bad('没有画出箭头尖')
  if (rendered.pill === '因果 →') ok('线上那颗词写着「因果 →」')
  else bad(`线上那颗词是 ${JSON.stringify(rendered.pill)}`)
  if (rendered.frameTitle === '第一节') ok('板框按成员算出了框线，名字用你起的标题')
  else bad(`板框没画出来 / 名字不对：${JSON.stringify(rendered.frameTitle)}`)
  if (rendered.declaredRow && rendered.declaredRow.includes('因果') && rendered.declaredRow.includes('第一节')) {
    ok(`面板「你连的」那一行读得懂：${rendered.declaredRow}`)
  } else {
    bad(`面板里「你连的」那一行不对：${JSON.stringify(rendered.declaredRow)}`)
  }
  if (rendered.frameRow && rendered.frameRow.includes('第一节')) ok(`面板「板框」那一行：${rendered.frameRow}`)
  else bad(`面板里没有板框那一行：${JSON.stringify(rendered.frameRow)}`)

  /* 把那张卡挪走 → 线自己跟着走（"箭头跟着板块动"这条只有真渲染才看得出来） */
  const before = await s.eval(`document.querySelector('[data-link-line]').getAttribute('d')`)
  const cardBox = await s.eval(`(() => {
    const el = document.querySelector('.bd-card[data-card-id="lk-b"]')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 8) }
  })()`)
  await s.mouse(cardBox.x, cardBox.y, { steps: 8, dx: 0, dy: -70 })
  await s.sleep(400)
  const after = await s.eval(`document.querySelector('[data-link-line]').getAttribute('d')`)
  if (before !== after) ok('把那张卡挪一下：那条线跟着变了（连接挂在两端上，不是一条死路径）')
  else bad('挪了卡片，那条线一动不动 —— 它被钉死在画出来的那一刻了')
}

/* ═════════════════ 15. 页面里不许有 JS 报错 ═════════════════ */
console.log('\n[15] 整个流程跑下来，页面里没有任何 JS 报错')
if (!s.exceptions.length) ok('没有报错 —— "处理器抛异常"和"处理器没跑"在屏幕上是同一个样子，所以这条是兜底')
else bad(`页面里有 ${s.exceptions.length} 条报错：` + s.exceptions.slice(0, 3).join(' ｜ '))
})
