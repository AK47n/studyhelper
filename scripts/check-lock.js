/* 卡片的「固定」（防误触）—— 真浏览器自检。
 *
 * 用户 2026-09-16：「给卡片加一个固定按钮用来防止误触」。
 * 纯逻辑那一层（字段读写、什么时候写出去）在 check-board.js 的 [6c]；
 * 这里管的是**行为**，而且只能在这儿管 ——
 * 锁定 = 整张卡 pointer-events: none、只留角上那颗 📌 自己 auto，
 * 这种"命中测试"级别的东西，`dispatchEvent` 合成事件**证明不了**
 * （合成事件直接投给元素，绕过浏览器的命中测试 —— README 第 11 条踩过这个坑）。
 * 所以下面每一条都是**真鼠标/真键盘**，而且先问 elementFromPoint 才动手。
 *
 * 断言清单：
 *   [1] 选中一张卡 → 出现 📌，而且它**点得到**（elementFromPoint）
 *   [2] 点 📌 → 卡片 locked、× 和缩放柄都收起来、📌 还在（这是唯一的回头路）
 *   [3] 锁定后：CSS 上真的 pointer-events: none，📌 还是 auto
 *   [4] 锁定后：点它不会选中它（它已经是"纸的一部分"）
 *   [5] 锁定后：拖它 → 位置纹丝不动
 *   [6] 锁定后：双击 → 不进编辑态（没有输入框）
 *   [7] 锁定后：在它上面画一笔 → 墨迹照画（还画在它上面），卡片照样不动
 *   [8] 锁定后：点它选不中、按 Delete 也删不掉
 *       （从前那条路是"关系面板里点一下名字能选中它" —— 面板 2026-09-19 删掉了，
 *        但那道闸**留着**：它挡的是"以后又冒出一条能选中它的路"。）
 *   [9] 解开 → 手柄回来，拖得动了
 *   [10] 文件里只有那张卡带 "locked": true（别的卡不多这个字段）
 *   [11] 重开一次 → 它还是锁着的
 *   [12] 放大画布之后角上那颗 × 的布局盒还是 22×22、屏幕上大小恒定、且点得到
 *        （用户报的「点击白板删除按钮没有用」的回归闸）
 *
 * 自己起服务（5202）和 headless Edge（9232），跑完都收掉；
 * 只碰自己造的夹具板 board-zz-lockcheck.md（跑完删）。
 * 胶水都收在 scripts/lib/board-check.js 的 withBoard 里：夹具的造/删、服务+浏览器、
 * CDP 会话、还有"跑完 data/ 里原有文件一个字节都不许变"那道守卫。
 *
 * 用法：node scripts/check-lock.js   （或 npm run check:lock）
 */
import { withBoard } from './lib/board-check.js'
import { BOARD_PREFIX, newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

/* 夹具：两张**文字卡**（我自己造的，**不动用户自己那张板**）。
   为什么不用样板板：样板里第一张是公式卡，而"这张卡上写的是什么"在公式卡上
   跟 DOM 里的文字对不上（KaTeX 排出来的式子）—— 夹具的文字要**可预测**。
   （更早的版本还要在关系面板里按文字找那一行，面板 2026-09-19 删掉了。）
   两张卡隔得远，第 6 步"在锁定的卡上画一笔"不会碰到另一张。 */
const CARD_A = 'lockcheck-a'
const TEXT_A = '固定自检甲的卡片'

const fails = await withBoard(
  {
    tag: 'lockcheck',
    port: 5202,
    cdpPort: 9232,
    make: () => {
      const b = newBoard('固定自检夹具（跑完自动删除）')
      const a = { ...newCard('note', 120, 120), id: CARD_A, text: TEXT_A, w: 260, h: 70 }
      const c = { ...newCard('note', 620, 120), id: 'lockcheck-b', text: '固定自检乙的卡片', w: 260, h: 70 }
      b.cards.push(a, c)
      return serializeBoardDocument(b)
    },
  },
  async ({ s, ok, bad, board, open, read, untilFile }) => {
/* ── 下面整段原来是顶层代码，挪进 withBoard 的回调里；缩进没动（少几百行假 diff）── */

const sleep = (ms) => s.sleep(ms)

/* 打开夹具板。★ 从前是"等界面挂上，再从左边栏点夹具那一行" —— 因为应用打开的是
   列表里第一个 board-*.md，而用户那张中文名的板排在前头。
   现在应用从 ?file= 直接开夹具（withBoard 里带的），用户那张板根本不会被读到。 */
{
  await open()
  if (!board) bad('没有夹具板 —— 这一份自检必须有自己的板')
}

/* 页面侧的读卡器：位置、锁定、以及那几个手柄在不在。
   位置读的是 inline style 的 left/top（卡片是按"屏幕 = 世界 × s + t"自己算的），
   拖动前后比它最直接。 */
const readCard = (id) => s.eval(`(() => {
  const el = document.querySelector('.bd-card[data-card-id="' + ${JSON.stringify(id)} + '"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const pin = el.querySelector('.bd-card-pin')
  const pr = pin ? pin.getBoundingClientRect() : null
  return {
    left: parseFloat(el.style.left), top: parseFloat(el.style.top),
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
    pinCx: pr ? Math.round(pr.x + pr.width / 2) : null,
    pinCy: pr ? Math.round(pr.y + pr.height / 2) : null,
    locked: el.classList.contains('locked'),
    on: el.classList.contains('on'),
    pe: getComputedStyle(el).pointerEvents,
    pinPe: pin ? getComputedStyle(pin).pointerEvents : null,
    pinAct: pin ? pin.dataset.cardPin : null,
    hasDel: !!el.querySelector('.bd-card-del'),
    hasResize: !!el.querySelector('.bd-card-resize'),
    editingBox: !!el.querySelector('textarea'),
    text: ((el.querySelector('.bd-card-body') || {}).textContent || '').trim().slice(0, 12),
  }
})()`)

/* 命中测试：某一点上**最上面的**是谁。沾指针的东西都得先问过它。 */
const hitAt = (x, y) => s.eval(`(() => {
  const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
  if (!el) return '(无)'
  return el.className && typeof el.className === 'string' ? el.className : el.tagName
})()`)

const first = await s.eval(`(() => {
  const el = document.querySelector('.bd-card[data-card-id="${CARD_A}"]')
  return el ? el.dataset.cardId : null
})()`)
if (!first) {
  bad('夹具里那张卡没渲染出来 —— 后面的断言都没意义了')
  return
}
console.log(`\n  （拿这张卡做实验：${first}）`)

/* ═════════════════ 1. 选中 → 出现 📌，而且点得到 ═════════════════ */
console.log('\n[1] 选中一张卡，左上角出现「固定」按钮')
let c0 = null
{
  c0 = await readCard(first)
  await s.mouse(c0.cx, c0.cy)
  const c = await readCard(first)
  if (c.on) ok('真鼠标点一下卡片 → 选中了')
  else bad('点卡片没选中（卡片收不到指针事件？）')
  if (c.pinCx) ok(`📌 出现了（在 ${c.pinCx},${c.pinCy}）`)
  else bad('选中了却没出现 📌 —— 固定按钮没渲染')
  if (c.pinAct === 'lock') ok('它是"按下会锁上"那个状态（data-card-pin="lock"）')
  else bad(`📌 的状态不对：data-card-pin=${JSON.stringify(c.pinAct)}`)
  if (!c.locked) ok('这时候还没锁定')
  else bad('一上来就锁着？')
  /* ★ 先问命中测试，再动手 —— 手柄这么小，点偏了就是"点了没反应"这种假错。 */
  if (c.pinCx) {
    const hit = await hitAt(c.pinCx, c.pinCy)
    if (String(hit).includes('bd-card-pin')) ok('📌 中心那一点命中的就是它自己（不是被别人盖住）')
    else bad(`📌 中心命中的是「${hit}」—— 按钮被别的东西盖住了，用户点不到`)
  }
}

/* ═════════════════ 1b. 左上角必须还是"抓卡片"的地方 ═════════════════ */
/* 为什么专门钉这一条：📌 一开始就放在**左上角**，于是"从左上角按住拖卡片"
 * 变成了"按了一个按钮" —— check-ocr-browser 里那条拖动断言（它正是从
 * 左上角 +8/+4 按下去的）当场变成「拖不动或挪得太少（0, 0）」。
 * 四个角是有分工的，写在这里免得以后又把按钮搬回去：
 *   左上 = 抓（拖动）· 右上 = × · 右下 = 缩放柄 · 左下 = 📌 */
console.log('\n[1b] 左上角还是"抓卡片拖走"的地方（📌 没占住它）')
{
  const before = await readCard(first)
  const hit = await hitAt(before.x + 8, before.y + 4)
  if (!String(hit).includes('bd-card-pin')) ok(`左上角 (left+8, top+4) 命中的是「${hit}」—— 不是 📌`)
  else bad('左上角被 📌 占住了 —— 那是抓卡片拖走最顺手的点，用户在那儿按下去会变成点按钮')
  await s.mouse(before.x + 8, before.y + 4, { steps: 8, dx: 60, dy: -50 })
  const after = await readCard(first)
  if (Math.abs(after.left - before.left) > 20 && Math.abs(after.top - before.top) > 20) {
    ok(`从左上角拖得动（${before.left},${before.top} → ${after.left},${after.top}）`)
  } else {
    bad(`从左上角拖不动（left/top 还是 ${after.left},${after.top}）`)
  }
}

/* ═════════════════ 2. 点 📌 → 锁上 ═════════════════ */
console.log('\n[2] 点一下它：卡片锁上')
{
  const before = await readCard(first)
  await s.mouse(before.pinCx, before.pinCy)
  const c = await readCard(first)
  if (c.locked) ok('卡片变成"固定"状态（.locked）')
  else bad('点了 📌 但卡片没锁上')
  if (c.pinAct === 'unlock') ok('📌 变成"再点一下解开"（data-card-pin="unlock"）')
  else bad(`📌 的状态没跟着变：${JSON.stringify(c.pinAct)}`)
  if (!c.hasDel && !c.hasResize) ok('× 和缩放柄都收起来了（锁定之后不该有能动的入口）')
  else bad(`锁定了还留着手柄：×=${c.hasDel} 缩放柄=${c.hasResize}`)
  if (!c.on) ok('同时取消了选中（手柄不会留在锁定的卡上）')
  else bad('锁定之后卡片还是选中态')
}

/* ═════════════════ 3. CSS 契约：卡片 none、📌 auto ═════════════════ */
console.log('\n[3] 锁定的做法：整张卡不收指针事件，只留 📌')
{
  const c = await readCard(first)
  if (c.pe === 'none') ok('卡片自己的 pointer-events = none（变成"纸的一部分"）')
  else bad(`卡片的 pointer-events 是 ${c.pe} —— 那它还是会抢指针事件`)
  if (c.pinPe === 'auto') ok('📌 自己的 pointer-events = auto（唯一的回头路，必须点得到）')
  else bad(`📌 的 pointer-events 是 ${c.pinPe} —— 那样就"钉死了拿不下来"了`)
}

/* ═════════════════ 4. 点它不选中；拖它不动 ═════════════════ */
console.log('\n[4] 锁定后：点它、拖它，卡片纹丝不动')
{
  const before = await readCard(first)
  const hit = await hitAt(before.cx, before.cy)
  if (String(hit).includes('bd-hit')) ok('卡片身上那一点命中的是收事件层（.bd-hit）—— 指针落在"纸上"了')
  else bad(`卡片身上那一点命中的是「${hit}」—— 卡片还在抢指针事件`)

  const mid = await readCard(first)
  await s.mouse(mid.cx, mid.cy, { steps: 8, dx: 70, dy: 40 })
  const after = await readCard(first)
  if (Math.abs(after.left - before.left) < 0.5 && Math.abs(after.top - before.top) < 0.5) {
    ok(`拖了 (70, 40)，卡片一步没动（left/top 还是 ${after.left}, ${after.top}）`)
  } else {
    bad(`拖了 (70, 40) 之后卡片被挪走了：${before.left},${before.top} → ${after.left},${after.top}`)
  }
  if (!after.on) ok('也没有被选中')
  else bad('拖这一下把它选中了')
}

/* ═════════════════ 5. 双击不进编辑态 ═════════════════ */
console.log('\n[5] 锁定后：双击也不会进编辑态')
{
  const c = await readCard(first)
  await s.doubleClick(c.cx, c.cy)
  const after = await readCard(first)
  if (!after.editingBox) ok('双击之后没有出现输入框（"钉住了"就是钉住了）')
  else bad('锁定的卡片被双击进了编辑态')
  if (!after.on) ok('也没有顺手把它选中')
  else bad('双击把它选中了')
}

/* ═════════════════ 6. 在它上面画一笔 ═════════════════ */
console.log('\n[6] 锁定后：在它上面写字照样写得出来（墨迹画在卡片上面）')
{
  const inkBefore = await s.eval(`Number(document.querySelector('canvas.bd-ink').dataset.strokes)`)
  const c = await readCard(first)
  await s.mouse(c.cx - 20, c.cy, { steps: 10, dx: 46, dy: 0 })
  const inkAfter = await s.eval(`Number(document.querySelector('canvas.bd-ink').dataset.strokes)`)
  if (inkAfter > inkBefore) ok(`在卡片上画出了一笔（${inkBefore} → ${inkAfter}）—— 它真的变成纸了`)
  else bad(`在卡片上没画出东西（${inkBefore} → ${inkAfter}）—— 这一下被卡片吃掉了`)
  const after = await readCard(first)
  if (Math.abs(after.left - c.left) < 0.5 && Math.abs(after.top - c.top) < 0.5) ok('画这一笔也没把卡片挪走')
  else bad('画这一笔把卡片挪了 —— 用笔时卡片还是抢了指针')
}

/* ═════════════════ 7. 锁定之后：选不中它，也就删不掉 ═════════════════ */
/* 锁定 = 整张卡 pointer-events: none、只留 📌 自己 auto，所以**画布上任一条路
   都选不中它**，Delete 自然也就轮不到它。
   ★ 从前这里测的是另一条路：关系面板里点一下名字是能选中它的（那行是个 button），
     于是 Board.jsx 里得专门为"选中的卡固定着"补一句提示 —— 那条路 2026-09-19
     随着面板一起删掉了。但**那扇闸留着**（`deleteIntent` 那一支），
     因为"选不中"是 CSS 的 pointer-events 保证的，不是类型保证的：
     哪天再冒出一条能选中它的路，Delete 就该在那儿被拦住。
   这一节因此直接钉结果：点它 → 落点是纸面、它没被选中；按 Delete → 卡片还在。 */
console.log('\n[7] 锁定的卡：点它落不到卡片上、也选不中；按 Delete 删不掉')
{
  const c = await readCard(first)
  const hitEl = await hitAt(c.cx, c.cy)
  if (String(hitEl).includes('bd-hit')) ok(`卡片正中间那一点命中的是纸面（${hitEl}）—— 它真的让开了指针事件`)
  else console.log(`  （⚠ 卡片中心命中的是「${hitEl}」—— 记一下）`)
  await s.mouse(c.cx, c.cy)
  await sleep(260)
  const sel = await readCard(first)
  if (!sel.on) ok('点它之后也没被选中 —— 那 Delete 就轮不到它')
  else bad('点一下就把锁定的卡选中了 —— 那 Delete 就危险了')
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await sleep(400)
  const after = await readCard(first)
  if (after) ok('按了 Delete，卡片还在 —— 锁定的卡不会被键盘删掉')
  else bad('按 Delete 把锁定的卡片删掉了')
}

/* ═════════════════ 8. 解开 → 又能拖了 ═════════════════ */
console.log('\n[8] 点 📌 解开：手柄回来，拖得动了')
{
  const before = await readCard(first)
  await s.mouse(before.pinCx, before.pinCy)
  const unlocked = await readCard(first)
  if (!unlocked.locked) ok('解开了（.locked 没了）')
  else bad('点了 📌 但没解开 —— 那就是"钉死了拿不下来"')
  if (unlocked.on && unlocked.hasDel && unlocked.hasResize) ok('顺手选中它，× 和缩放柄都回来了')
  else bad(`解开之后手柄没回来：选中=${unlocked.on} ×=${unlocked.hasDel} 缩放柄=${unlocked.hasResize}`)

  const mid = await readCard(first)
  await s.mouse(mid.cx, mid.cy, { steps: 8, dx: 70, dy: 40 })
  const after = await readCard(first)
  const moved = Math.abs(after.left - mid.left) > 20 || Math.abs(after.top - mid.top) > 20
  if (moved) ok(`拖得动了（${mid.left},${mid.top} → ${after.left},${after.top}）`)
  else bad('解开了还是拖不动 —— 那"解开"是假的')
}

/* ═════════════════ 9. 文件里怎么写的 ═════════════════ */
console.log('\n[9] 落盘：只有那张卡带 locked，别的卡不多这个字段')
{
  /* 先重新锁上，再看文件（前面第 8 步解开了）。
     ★ 等的是"盘上真的出现 locked: true"这个事实，不是 1200ms 这个数字 ——
       固定毫秒数是在猜（见 README 第 38 条：那条 1/3 概率报红就是猜出来的）。 */
  const c = await readCard(first)
  await s.mouse(c.pinCx, c.pinCy)
  const wLock = await untilFile((d) => (d.cards || []).some((x) => x.id === first && x.locked === true), {
    what: '盘上那张卡真的写上了 locked: true',
  })
  if (!wLock.ok) bad(`等了 ${wLock.waited}ms，盘上一直没出现 locked: true`)
  const doc = wLock.value || (await read())
  if (!doc) bad('夹具板读不出来（落盘那一步没写成？）')
  if (doc) {
    const withLock = doc.cards.filter((x) => x.locked === true)
    if (withLock.length === 1 && withLock[0].id === first) ok('文件里正好一张卡是 locked: true，就是这张')
    else bad(`文件里的 locked 不对：${JSON.stringify(doc.cards.map((x) => [x.id, x.locked]))}`)
    const others = doc.cards.filter((x) => x.id !== first)
    if (others.every((x) => !('locked' in x))) ok(`别的 ${others.length} 张卡**没有** locked 这个字段（不写 false，不造假 diff）`)
    else bad('没锁的卡也被写上了 locked 字段')
  }
}

/* ═════════════════ 10. 重开还在 ═════════════════ */
console.log('\n[10] 重开一次：它还是锁着的')
{
  /* 重开 = 再导航一次到 ?file=<夹具> —— 还是直接开夹具那张板
     （从前这儿得"重开之后再从左栏点一次夹具"，因为应用开的是列表里第一个）。 */
  await open()
  const c = await readCard(first)
  if (!c) {
    bad(`重开并切回夹具之后，卡片 ${first} 不在 DOM 里 —— 这一条没验成`)
  } else {
    if (c.locked) ok('重新打开之后它还是固定着的（状态存在板文件里）')
    else bad('重开之后锁定丢了')
    if (c.pinCx) ok(`📌 仍然在（${c.pinCx},${c.pinCy}），能解开`)
    else bad('重开之后 📌 不见了')
  }
}

/* ═════════════════ 11. ★ 手柄不随画布缩放放大（2026-09-21 用户报的）═════════════
 *
 * 用户原话：「点击白板删除按钮没有用」。
 *
 * 病根不在"点了没反应"，而在**那颗 × 跑到画布外面去了**：
 *   卡片上那几颗手柄（× / 缩放柄 / 📌）的宽高和贴边偏移写的是卡内长度，
 *   而卡片活在 `.bd-cardworld` 那一层里，那层挂着 `transform: scale(s)`
 *   （s = 视图缩放）。于是写死的 `22px` 在屏幕上变成 `22×s`、
 *   "贴边往外露 10px"变成 `10×s`。
 *   `.bd-stagewrap` 是 `overflow: hidden` —— 露在外面的那一块被裁掉，
 *   而"卡片边缘之外"落点是画布/工具条，于是它既看不见也点不到。
 *
 * ★ 为什么这一条**必须**在这里（真浏览器 + 真鼠标）：
 *   "某颗按钮点不点得到"只有浏览器的命中测试说了算。`dispatchEvent` 合成事件
 *   直接投给元素、绕过命中测试 —— 用它测，这个 bug 会一路绿灯（README 第 11 条）。
 *
 * ★ 判据特意用 **`offsetWidth`（布局宽）而不是 getBoundingClientRect**：
 *   这里是"尺寸有没有被缩放污染"的唯一读数，两条断言各管一半：
 *     · 放大前后**相等** → 尺寸没被祖先那把 scale 乘过；
 *     · 而且**等于 22**（它本来的数）→ 补偿缩放没有偷偷算进尺寸里。
 *   只比"相等"是不够的：两边一起错成 7 也相等（第一版就是这样，
 *   把 1/s 乘进 width，屏幕上恒定但布局盒缩到 7×7 —— 能点的区域跟着缩水）。
 *   现在的修法是 `zoom: 1/s`：它缩放的是渲染，**不改布局盒**，22 永远是 22。
 *   （`getBoundingClientRect` 是含变换的视觉宽，两种写法下都会变，分不出来。）
 *
 * ⚠ 这一步会缩放画布。它在整个脚本的最末尾（后面只剩"有没有 JS 报错"），
 *   而且**跑完把视图装回屏幕**（Ctrl+0 那条路就是 fitView）——
 *   不给后面的断言留"上一节改过的状态"（README：那种前提是颗雷）。 */
console.log('\n[11] ★ 角上那几颗手柄的尺寸不随画布缩放变大（× 得一直点得到）')
{
  /* 先把卡解开并选中（前两节把它锁上又重开过）。 */
  const st0 = await readCard(first)
  if (st0 && st0.locked && st0.pinCx) {
    await s.mouse(st0.pinCx, st0.pinCy)
    await sleep(300)
  }
  let sc = await readCard(first)
  if (!sc.on && sc.cx) {
    await s.mouse(sc.cx, sc.cy)
    await sleep(300)
    sc = await readCard(first)
  }

  /* 量"手柄的布局尺寸"和"它在画布里的可见比例 + 命中"。
     ⚠ 整个表达式在模板字符串里：注释里一个反引号都不能有。 */
  const probeHandles = () => s.eval(`(() => {
    const card = document.querySelector('.bd-card[data-card-id=' + ${JSON.stringify(JSON.stringify(first))} + ']')
    if (!card) return null
    const st = document.querySelector('.bd-stagewrap').getBoundingClientRect()
    const world = document.querySelector('.bd-cardworld')
    const m = /scale\\(([-\\d.]+)\\)/.exec(world ? (world.style.transform || '') : '')
    const out = { viewScale: m ? parseFloat(m[1]) : null, handles: [] }
    for (const [name, sel] of [['del', '.bd-card-del'], ['resize', '.bd-card-resize'], ['pin', '.bd-card-pin']]) {
      const el = card.querySelector(sel)
      if (!el) { out.handles.push({ name, present: false }); continue }
      const r = el.getBoundingClientRect()
      const cx = Math.round((r.left + r.right) / 2), cy = Math.round((r.top + r.bottom) / 2)
      const hit = document.elementFromPoint(cx, cy)
      const visW = Math.max(0, Math.min(r.right, st.right) - Math.max(r.left, st.left))
      const visH = Math.max(0, Math.min(r.bottom, st.bottom) - Math.max(r.top, st.top))
      out.handles.push({
        name, present: true,
        layoutW: el.offsetWidth, layoutH: el.offsetHeight,
        screenW: Math.round(r.width),
        visPct: r.width && r.height ? Math.round((visW * visH) / (r.width * r.height) * 100) : 0,
        hitSelf: hit === el,
        hit: hit ? String(hit.className || hit.tagName) : 'null',
      })
    }
    return out
  })()`)

  const z0 = await probeHandles()
  if (!z0) {
    bad('读不到夹具那张卡 —— 这一节没验成')
  } else {
    const del0 = z0.handles.find((x) => x.name === 'del')
    if (del0 && del0.present) {
      if (del0.hitSelf && del0.visPct >= 99) ok(`默认缩放（s=${z0.viewScale}）下 × 100% 可见且点得到`)
      else bad(`默认缩放下 × 就点不到（可见 ${del0.visPct}%，命中 ${del0.hit}）`)
    }

    /* ── 放大两档画布：手柄的**布局宽**必须纹丝不动 ── */
    for (let i = 0; i < 4; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: -120 })
      await sleep(140)
    }
    await sleep(400)
    /* 缩放之后卡片可能被挪出视野 —— 重新选中它，好让手柄在 DOM 里 */
    const back = await s.eval(`(() => {
      const card = document.querySelector('.bd-card[data-card-id=' + ${JSON.stringify(JSON.stringify(first))} + ']')
      if (!card) return null
      const r = card.getBoundingClientRect()
      return { cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2), w: Math.round(r.width) }
    })()`)
    if (back) { await s.mouse(back.cx, back.cy); await sleep(320) }

    const z1 = await probeHandles()
    const del1 = z1 && z1.handles.find((x) => x.name === 'del')
    if (!z1 || !del1 || !del1.present) {
      bad(`放大之后 × 不在 DOM 里（这一节的断言没跑到）`)
    } else {
      if (z1.viewScale > z0.viewScale + 0.4) {
        ok(`画布真的放大了（s ${z0.viewScale} → ${z1.viewScale}）`)
      } else {
        bad(`滚了 4 下滚轮画布没放大（s 还是 ${z1.viewScale}）—— 这一节的前提没成立`)
      }
      /* ★ 核心断言：**布局盒**不随缩放涨。
         它必须是"这颗按钮在这儿、多大"的唯一答案 —— 屏幕上恒定但布局盒被缩掉
         （第一版把 1/s 乘进 width 就是这个样子，实测 s=3.1 时 offsetWidth 只剩 7）
         等于把"能点的区域"和"看着的圆"拆成两个数，框选/贴边全按那个错的算。 */
      if (del1.layoutW === del0.layoutW && del1.layoutH === del0.layoutH) {
        ok(`× 的**布局**尺寸没被缩放乘过（${del0.layoutW}×${del0.layoutH} → ${del1.layoutW}×${del1.layoutH}）`)
      } else {
        bad(`× 的布局尺寸随画布缩放变了（${del0.layoutW}×${del0.layoutH} → ${del1.layoutW}×${del1.layoutH}）—— 尺寸得只在一个地方说，不能一半在布局盒、一半在补偿缩放`)
      }
      /* ★ 布局盒还得是那颗按钮本来的大小（22×22）。
         单比 z0/z1 相等是不够的：两边一起错成 7 也相等。 */
      if (del1.layoutW === 22 && del1.layoutH === 22) {
        ok(`× 的布局盒就是 22×22（没有被任何补偿缩放改小）`)
      } else {
        bad(`× 的布局盒量出来是 ${del1.layoutW}×${del1.layoutH}，不是 22×22 —— 补偿缩放被算进了尺寸里`)
      }
      /* ★ 屏幕尺寸也应当恒定（这正是"恒定的手柄"该有的样子）。 */
      if (Math.abs(del1.screenW - del0.screenW) <= 2) {
        ok(`× 的**屏幕**尺寸也恒定（${del0.screenW}px → ${del1.screenW}px）`)
      } else {
        bad(`× 的屏幕尺寸随缩放变了（${del0.screenW}px → ${del1.screenW}px）—— 手柄应该是一颗固定大小的按钮`)
      }
      /* ★ 缩放之后它照样得点得到（这是用户报的那件事本身）。 */
      if (del1.hitSelf && del1.visPct >= 99) {
        ok(`放大之后 × 仍然 100% 可见、点得到（可见 ${del1.visPct}%）`)
      } else {
        bad(`放大之后 × 点不到（可见 ${del1.visPct}%，命中 ${del1.hit}）—— 用户报的就是这个`)
      }
    }

    /* 收尾：把视图装回屏幕，别给后面留"我改过的状态"。
       ⚠ ⤢ 那颗按钮没有 data 钩子（它只是个 `.bd-t.icon`），所以按 title 找 ——
         自检里按文案找元素是脆的，所以**找不到就跳过**（收尾失败不该报红：
         这一节要断言的东西上面已经断言完了）。 */
    const fitted = await s.eval(`(() => {
      const b = [...document.querySelectorAll('.bd-tools .bd-t')].find((x) => /装回屏幕/.test(x.title || ''))
      if (!b) return false
      b.click()
      return true
    })()`)
    await sleep(400)
    if (fitted) ok('收尾：点了「⤢ 装回屏幕」，视图复位（不给后面的节留我改过的状态）')
    else console.log('  （提示：没找到「⤢ 装回屏幕」那颗按钮，视图停在放大状态 —— 本节后面只剩报错检查）')
  }
}

/* ═════════════════ 12. 页面里不许有 JS 报错 ═════════════════ */
console.log('\n[12] 整个流程跑下来，页面里没有任何 JS 报错')
if (!s.exceptions.length) ok('没有报错 —— "处理器抛异常"和"处理器没跑"在屏幕上是同一个样子，所以这条是兜底')
else bad(`页面里有 ${s.exceptions.length} 条报错：` + s.exceptions.slice(0, 3).join(' ｜ '))
})
