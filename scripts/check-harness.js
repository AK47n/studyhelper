/* 自检的**自检**：验 scripts/lib/board-check.js 这道门本身是真的。
 *
 * 为什么值得单独一条：withBoard 现在替 9 个真浏览器自检做四件事 ——
 * 造/删夹具板、起服务+浏览器、开 CDP 会话、守用户的数据。
 * 这四件事**坏掉的时候都不报错**：守卫不咬 = 用户板被悄悄改；夹具漏删 = data/ 里
 * 多一张板；抛异常没收干净 = 自检挂在那儿不动。绿的自检如果自己不可信，
 * 上面 9 条绿的就全是假的 —— 所以这里逐条钉住：
 *
 *   [1] 守卫（纯函数，拿临时目录试）：能发现被改的文件、能按快照恢复、
 *       **不碰**没改的文件、**不删**跑出来的新文件
 *   [2] 夹具名的闸门：名字不合规（不是 board-zz-*）时**直接拒绝**，一个文件都不写
 *   [3] ?file=<夹具> 真的打开了那张夹具（不是"列表里第一个"），
 *       而且打开夹具这条路**没有碰用户那张板**（drift 为空）
 *   [4] ?file= 指的文件不在列表里时：什么都不打开（绝不退回"列表里第一个"）
 *   [5] 跑完夹具板被删掉、没有 board-zz-* 残留
 *   [6] body 抛异常时照样收干净（夹具删了、端口放了、报红）
 *
 * 用法：npm run check:harness（要真浏览器，本机只有 Edge）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { withBoard, snapshotData, changedSince, restoreChanged, LEGAL_FIXTURE, DATA } from './lib/board-check.js'
import { newBoard, newCard, serializeBoardDocument } from '../src/lib/board.js'

let fails = 0
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => {
  fails++
  console.log('  \u2717 ' + m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

const USER_BOARD = path.join(DATA, 'board-新白板.md')
const userHashBefore = fs.existsSync(USER_BOARD) ? hashOf(USER_BOARD) : null

/* ═══════════════ 1. 守卫本身（纯函数，临时目录，不碰 data/）═══════════════ */
console.log('\n[1] 用户数据守卫：能发现被改的、能恢复、不碰没改的、不删新文件')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhelper-guard-'))
  const a = path.join(dir, 'board-甲.md')
  const b = path.join(dir, 'board-乙.md')
  fs.writeFileSync(a, '甲原来的内容\n', 'utf8')
  fs.writeFileSync(b, '乙原来的内容\n', 'utf8')

  const snap = snapshotData(dir)
  if (snap.files.size === 2) ok(`快照拍到 2 个文件（${[...snap.files.keys()].join(' / ')}）`)
  else bad(`快照只拍到 ${snap.files.size} 个文件`)

  const bBefore = fs.readFileSync(b)
  const bStat = fs.statSync(b).mtimeMs

  // ① 只改甲：守卫必须**只**报甲
  fs.writeFileSync(a, '甲被自检改坏了\n', 'utf8')
  // ② 新文件（自检自己造的）不算"原有文件被改"
  fs.writeFileSync(path.join(dir, 'board-zz-new.md'), '自检刚造的\n', 'utf8')
  let changed = changedSince(snap, dir)
  if (changed.length === 1 && changed[0] === 'board-甲.md') ok('改了一个原有文件 → 守卫正好报这一个（新文件不算）')
  else bad(`守卫报错了：${JSON.stringify(changed)}`)

  // ③ 恢复：内容回到原样，而且没改过的乙**一个字节都没被重写**
  const restored = restoreChanged(snap, dir)
  if (restored.length === 1 && fs.readFileSync(a, 'utf8') === '甲原来的内容\n') ok('按快照恢复了原文（甲）')
  else bad(`没恢复对：${JSON.stringify(restored)} → ${JSON.stringify(fs.readFileSync(a, 'utf8'))}`)
  if (fs.readFileSync(b).equals(bBefore) && fs.statSync(b).mtimeMs === bStat) ok('没被改过的乙没被碰（连 mtime 都没动）')
  else bad('恢复那一步把没改过的文件也重写了一遍')
  if (fs.existsSync(path.join(dir, 'board-zz-new.md'))) ok('新文件不被守卫删掉（删的是谁的，得由造它的人说）')
  else bad('守卫把跑出来的新文件删了')
  if (changedSince(snap, dir).length === 0) ok('恢复之后再查：一个都没变（守卫是幂等的）')
  else bad('恢复之后还报有文件被改')

  // ④ 原有文件被删掉时：报出来，但不炸
  fs.rmSync(b)
  changed = changedSince(snap, dir)
  if (changed.some((n) => n.includes('board-乙.md'))) ok('原有文件不见了也报得出来：' + changed.join(' / '))
  else bad('原有文件被删了却没报：' + JSON.stringify(changed))

  fs.rmSync(dir, { recursive: true, force: true })
}

/* ═══════════════ 2. 夹具名的闸门 ═══════════════ */
console.log('\n[2] 夹具名不合规时直接拒绝（一个文件都不写）')
{
  if (LEGAL_FIXTURE.test('board-zz-lockcheck.md') && !LEGAL_FIXTURE.test('board-新白板.md') && !LEGAL_FIXTURE.test('board-zz.md')) {
    ok('只有 board-zz-<标签>.md 算夹具板（用户的板 / 空标签都不算）')
  } else {
    bad('夹具名的判据不对：' + LEGAL_FIXTURE)
  }
  const before = fs.readdirSync(DATA)
  let threw = null
  try {
    await withBoard({ tag: '../新白板', port: 5211, cdpPort: 9251 }, async () => {})
  } catch (e) {
    threw = e
  }
  const after = fs.readdirSync(DATA)
  if (threw) ok('名字里带 ../ 的标签被当场拒绝：' + String(threw.message).slice(0, 40) + '…')
  else bad('非法标签没被拒绝 —— 那就是"删的是谁的"这个洞')
  if (before.join() === after.join()) ok('拒绝发生在写任何文件之前（data/ 清单没变）')
  else bad('data/ 清单变了：' + after.filter((n) => !before.includes(n)).join(' / '))
}

/* ═══════════════ 3~5. 真的开一次浏览器：?file= 只开夹具，用户板不碰 ═══════════════ */
console.log('\n[3] ?file=<夹具> 打开的就是夹具那张板（而且没碰用户那张）')
console.log('\n[4] ?file= 指的文件不在列表里：什么都不打开')
console.log('\n[5] 跑完夹具板被删掉，data/ 里没有 board-zz-* 残留')
let failsRun1 = 1
{
  const fixture = path.join(DATA, 'board-zz-harness.md')
  const b = newBoard('自检夹具（跑完自动删除）')
  b.cards.push({ ...newCard('note', 140, 140), id: 'harness-a', text: '夹具甲', w: 240, h: 70 })
  failsRun1 = await withBoard(
    { tag: 'harness', port: 5211, cdpPort: 9251, text: serializeBoardDocument(b) },
    async ({ s, ok, bad, board, open, drift, appUrl }) => {
      await open()

      const st = await s.eval(`(() => {
        const q = (x) => document.querySelector(x)
        return {
          file: ((q('.bd-file') || {}).textContent || '').trim(),
          title: document.title,
          card: !!q('.bd-card[data-card-id="harness-a"]'),
          cardText: ((q('.bd-card[data-card-id="harness-a"] .bd-card-body') || {}).textContent || '').trim(),
        }
      })()`)
      if (st.file === board.name) ok(`顶栏开的就是夹具（${st.file}）—— ?file= 生效，不是"列表里第一个"`)
      else bad(`打开的是「${st.file}」，期望 ${board.name} —— ?file= 没生效就把用户那张板读进来了`)
      if (st.card && st.cardText === '夹具甲') ok('夹具里的那张卡真的渲染出来了（证明读的是夹具的内容）')
      else bad(`夹具那张卡没渲染出来：card=${st.card} text=${JSON.stringify(st.cardText)}`)
      if (st.file !== 'board-新白板.md') ok('用户那张 board-新白板.md 从头到尾没被打开')
      else bad('打开的是用户的板 —— 这条正是要躲的事')

      const d = await drift()
      if (d.length === 0) ok('这时候 data/ 里原有文件一个都没变（drift 为空）')
      else bad('data/ 里有文件被改了：' + d.join(' / '))

      /* [4] 指名一个不存在的文件：应用应当**什么都不打开**。
         退回"列表里第一个"就等于又把用户的板读进来（那正是这一整块要躲的事）。 */
      await s.send('Page.navigate', { url: appUrl + '?file=board-zz-nope.md' })
      let seen = null
      for (let i = 0; i < 60; i++) {
        seen = await s
          .eval(`(() => {
            const q = (x) => document.querySelector(x)
            return {
              cover: !!q('.cover'),
              board: !!q('.bd-stagewrap'),
              note: !!q('.topbar'),
              file: ((q('.bd-file') || {}).textContent || '').trim(),
              toast: ((q('.toast') || {}).textContent || '').trim(),
              cur: ((q('.cur-name') || {}).textContent || '').trim(),
            }
          })()`)
          .catch(() => null)
        if (seen && !seen.cover && (seen.board || seen.note)) break
        await sleep(250)
      }
      await sleep(600)
      if (seen && !seen.board && !seen.file) ok('白板没有打开（没有 .bd-file）—— 没有退回"列表里第一个"')
      else bad(`?file= 找不到时还是打开了东西：${JSON.stringify(seen)}`)
      if (seen && /不在列表里/.test(seen.toast)) ok('而且给了一句人话：' + seen.toast)
      else bad('没读到"不在列表里"那句提示：' + JSON.stringify(seen && seen.toast))
      if (seen && !/board-新白板/.test(seen.cur)) ok('顶栏也没有变成用户那张板')
      else bad('退回打开了用户的板：' + JSON.stringify(seen && seen.cur))

      const d2 = await drift()
      if (d2.length === 0) ok('走完这两步，data/ 里原有文件还是一个都没变')
      else bad('data/ 里有文件被改了：' + d2.join(' / '))
    }
  )

  /* [5] 夹具的清理：withBoard 返回之后它必须没了 */
  if (!fs.existsSync(fixture)) ok('跑完夹具板被删掉了（' + path.basename(fixture) + '）')
  else bad('夹具板还在盘上：' + fixture)
  const left = fs.readdirSync(DATA).filter((n) => n.startsWith('board-zz-'))
  if (left.length === 0) ok('data/ 里没有 board-zz-* 残留')
  else bad('data/ 里还剩：' + left.join(' / '))
  if (!(await alive('http://127.0.0.1:5211/api/list'))) ok('服务收掉了（5211 放了）')
  else bad('服务还在 5211 上跑着')
  if (userHashBefore) {
    const now = fs.existsSync(USER_BOARD) ? hashOf(USER_BOARD) : '(不见了)'
    if (now === userHashBefore) ok('用户那张板的哈希和跑之前一模一样（' + userHashBefore.slice(0, 12) + '…）')
    else bad(`用户那张板被改了！${userHashBefore.slice(0, 12)}… → ${String(now).slice(0, 12)}…`)
  }
}

/* ═══════════════ 6. body 抛异常也要收干净 ═══════════════ */
console.log('\n[6] body 抛异常：照样删夹具、放端口、报红（下面这一次的 ✗ 是故意的）')
{
  const fixture = path.join(DATA, 'board-zz-harness-throw.md')
  const failsRun2 = await withBoard(
    { tag: 'harness-throw', port: 5212, cdpPort: 9252, text: serializeBoardDocument(newBoard('抛异常夹具')) },
    async () => {
      throw new Error('故意抛的：验"抛异常也收得干净"')
    }
  )
  if (failsRun2 >= 1) ok(`抛异常被收成了一次失败（fails=${failsRun2}）—— 不会挂在那儿不动`)
  else bad('body 抛异常却没报失败')
  if (!fs.existsSync(fixture)) ok('抛异常之后夹具板照样被删掉了')
  else bad('抛异常之后夹具板留在盘上：' + fixture)
  if (!(await alive('http://127.0.0.1:5212/api/list'))) ok('抛异常之后服务也收掉了（5212 放了）')
  else bad('服务还在 5212 上跑着')
}

/* ═══════════════ 收尾 ═══════════════ */
console.log('\n' + '─'.repeat(56))
console.log(fails ? `  ${fails} 项失败` : '  全部通过')
console.log('')
process.exitCode = fails || failsRun1 ? 1 : 0

async function alive(url) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 700)
  try {
    await fetch(url, { signal: ctl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}
