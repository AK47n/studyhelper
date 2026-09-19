/* data/ 的分层存储 —— **真服务、真写盘**的端到端自检。
 *
 * 为什么要有这一条（2026-09-17 起 `data/` 可以带层）：
 *   `check-board` 的 [6u] 钉的是"路径怎么拆怎么拼"（纯逻辑），但分层真正的风险不在那儿 ——
 *   在**服务端到底把文件写到哪儿了**。一个没挡住的名字能跑到 `data/` 外面去，
 *   而这类错在纯逻辑自检里看不出来：`normalizeRel` 拒了，不代表 `/api/file/` 那条路
 *   真的用了它（`SAFE_NAME` 当年就是"看起来在管，其实两处各写一遍"）。
 *
 * ★ 跑在**临时目录**里：把 server.js / server-ocr.js / package.json / src/ 复制出去，
 *   `data/` 从零开始。所以它**根本碰不到**你 `data/` 里的板 —— 不是"跑完记得删"，
 *   是"从头到尾没连上"（对比 check-default-mode：那条要的就是你那个空 data/，
 *   所以它只能跳过或者小心地造/删）。
 *
 * 用法：node scripts/check-storage.js   （或 npm run check:storage）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT as ROOT_DIR, serverModules, linkRuntimeDeps } from './lib/board-check.js'

const ROOT = ROOT_DIR
const PORT = Number(process.env.STUDYHELPER_CHECK_PORT || 5188)
const BASE = `http://127.0.0.1:${PORT}`
const NESTED = '大物/电磁学/board-第一章.md'

let checks = 0
let fails = 0
const ok = (m) => {
  checks++
  console.log('  \u2713 ' + m)
}
const bad = (m) => {
  checks++
  fails++
  console.log('  \u2717 ' + m)
}
const eq = (got, want, m) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) ok(`${m}  →  ${a}`)
  else bad(`${m}\n      实际 ${a}\n      期望 ${b}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (r) => r.json()
const get = (u) => fetch(BASE + u).then(j)
const post = (u, body) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j)
const put = (u, body) => fetch(BASE + u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j)
const fileUrl = (name) => '/api/file/' + encodeURIComponent(name)

/* 临时目录：复制跑得起来的最小一份（不带 dist —— 这些断言只走 /api/*）
 * ⚠ 复制清单**从 server.js 的 import 推出来**，不手写 ——
 *   2026-09-18 手写那份漏了 `server-export.js`，于是这份自检跑不起来，
 *   报的话像"Node 坏了"。详见 lib/board-check.js 的 serverModules。 */
const TMP = path.join(os.tmpdir(), `studyhelper-storage-${process.pid}`)
const DATA = path.join(TMP, 'data')
function setup() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(DATA, { recursive: true })
  for (const f of serverModules()) {
    fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f))
  }
  fs.cpSync(path.join(ROOT, 'src'), path.join(TMP, 'src'), { recursive: true })
  /* katex 也挂进去：服务启动时会 warmUpExport()（提前加载 katex），
     虽然这一条不测公式，但**环境要跟真的一样** —— 不然"服务起得来"这件事
     是在一个比真实情况更宽松的条件下证出来的。 */
  linkRuntimeDeps(TMP)
}

async function portBusy() {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 700)
    await fetch(BASE + '/api/list', { signal: ctl.signal })
    clearTimeout(t)
    return true
  } catch {
    return false
  }
}

console.log('\n[storage] data/ 的分层：真服务 + 真写盘（临时目录 ' + TMP + '）')
console.log('  你项目里的 data/ 从头到尾没被连上（这一条跑的是复制出去的那一份）\n')

setup()
if (await portBusy()) {
  bad(`端口 ${PORT} 上已经有服务了 —— 先关掉它（不然验的是别的应用）`)
} else {
  const server = spawn(process.execPath, ['server.js', '--no-auto-exit', '--no-open'], {
    cwd: TMP,
    env: { ...process.env, STUDYHELPER_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  server.stdout.on('data', (d) => log.push(String(d)))
  server.stderr.on('data', (d) => log.push(String(d)))
  const kill = () => {
    try {
      if (!server.killed) server.kill()
    } catch {}
  }
  process.on('exit', kill)

  let up = false
  for (let i = 0; i < 60; i++) {
    if (await portBusy()) {
      up = true
      break
    }
    await sleep(200)
  }

  /* ★ 服务起不来时要把日志**整段开头**打出来。原来是 `.slice(-4)`（最后 4 行）——
     而 Node 的启动错误前几行才是 `Cannot find module`，最后几行常是空行，
     于是屏幕上只剩 "Node.js v24.19.0"，像"Node 坏了"。
     2026-09-18 就是这么被误导了一轮：真因是复制清单漏了 server-export.js。 */
  const dumpLog = () => {
    const lines = log.join('').split('\n').filter((l) => l.trim() !== '')
    return lines.slice(0, 12).join(' | ') || '（服务没吐出任何东西）'
  }

  try {
    if (!up) {
      bad('服务没起来：' + dumpLog())
    } else {
      ok(`服务起来了（端口 ${PORT}）`)

      /* ① 空 data/ */
      {
        const r = await get('/api/list')
        eq([r.files.length, r.folders.length], [0, 0], '空 data/ → 文件 0 个、目录 0 个')
      }

      /* ② 打一条带层次的路径建板：中间那两层目录**自动建出来** */
      {
        const r = await post('/api/new', { name: NESTED, text: '{"strokes":[],"cards":[]}' })
        eq(r.ok, true, 'POST /api/new 一条带层次的路径 → 建好')
        if (fs.existsSync(path.join(DATA, '大物', '电磁学', 'board-第一章.md'))) ok('盘上真的是 data/大物/电磁学/board-第一章.md（中间两层自动建出来）')
        else bad('盘上没有这个文件 —— 服务端没把中间那几层建出来')
        const list = await get('/api/list')
        const f = list.files[0] || {}
        eq(f.name, NESTED, 'list 里 name 是**整条相对路径**')
        eq(f.folder, '大物/电磁学', 'list 里 folder 是它所在的那一层')
        eq(f.title, 'board-第一章', 'title 只剩最后一段（左栏那一行显示的字）')
        eq(list.folders, ['大物', '大物/电磁学'], '目录列表两层都报出来了（顺序钉死：浅的在前）')
      }

      /* ③ 读写走整条路径（中文 + 斜杠都要编码，漏一个就是 404） */
      {
        const r = await put(fileUrl(NESTED), { text: '{"strokes":[],"cards":[{"id":"k1"}],"title":"改过"}' })
        eq(r.ok, true, 'PUT 整条路径（编码过的）→ 写得进去')
        const g = await get(fileUrl(NESTED))
        if (String(g.text).includes('改过')) ok('GET 读回来是刚写进去的内容')
        else bad('读回来的不是刚写的：' + String(g.text).slice(0, 60))
      }

      /* ④ 穿越：这是分层存储唯一的**危险**那一面 */
      {
        eq((await get('/api/file/..%2F..%2Fpackage.json')).error, '非法文件名', 'GET ../../package.json → 400（不许往上跑）')
        eq((await get('/api/file/%2Fetc%2Fpasswd.md')).error, '非法文件名', 'GET 绝对路径 → 400')
        eq((await post('/api/new', { name: '../../evil.md', text: 'x' })).error, '这个路径不能用（一段里不许有 `..`，也不许跑到 data/ 外面）', 'POST /api/new ../../evil.md → 400（`..` 连修都不修：那是"想跑出去"，不是"打错字"）')
        if (!fs.existsSync(path.join(TMP, 'evil.md')) && !fs.existsSync(path.join(os.tmpdir(), 'evil.md'))) {
          ok('临时目录和它的上一层都没有多出 evil.md（挡在"写盘"之前）')
        } else bad('★ 有文件被写到 data/ 外面去了 —— 这条必须修')
        eq((await put(fileUrl('大物/../../x.md'), { text: 'x' })).ok, undefined, 'PUT 里夹着 .. → 不 ok')
        const list = await get('/api/list')
        eq(list.files.length, 1, '折腾完这一圈，列表里还是只有那一个文件')
      }

      /* ⑤ 建一层（左栏那个「＋ 分层」） */
      {
        const a = await post('/api/mkdir', { path: '电路/第一章' })
        eq([a.ok, a.path, a.existed], [true, '电路/第一章', false], '建两层目录 → ok，existed=false')
        const b = await post('/api/mkdir', { path: '电路/第一章' })
        eq(b.existed, true, '再建一次 → existed=true（不是错误：用户要的是"这一层在"）')
        const list = await get('/api/list')
        if (list.folders.includes('电路/第一章')) ok('空目录也出现在 folders 里（左栏要能把它摆出来，等着往里放东西）')
        else bad('新建的空目录没出现在列表里：' + JSON.stringify(list.folders))
      }

      /* ⑥ 移动：拖到某一层上（`to` 是个目录 → 挪进去、名字不动） */
      {
        const r = await post('/api/move', { from: NESTED, to: '电路/第一章' })
        eq([r.ok, r.to], [true, '电路/第一章/board-第一章.md'], '拖到一层上 → 挪进去，名字不变')
        if (!fs.existsSync(path.join(DATA, '大物', '电磁学', 'board-第一章.md'))) ok('原来那个位置已经不在了（是移动，不是复制）')
        else bad('移动之后原文件还在 —— 那是复制，data/ 里会多出僵尸')
        const list = await get('/api/list')
        eq(list.files[0].name, '电路/第一章/board-第一章.md', '列表跟着变（同一份相对路径口径）')
      }

      /* ⑦ 改名（`to` 是一条完整路径） */
      {
        const r = await post('/api/move', { from: '电路/第一章/board-第一章.md', to: '电路/第一章/board-静电场.md' })
        eq([r.ok, r.to], [true, '电路/第一章/board-静电场.md'], '写完整路径 → 改名')
      }

      /* ⑦′ 界面上那个"就地改名"发出来的形状：**同一条路径上的另一个最后一段**。
       * 为什么单拎出来量：改名对话框只让改名字，于是它拼出来的永远是
       * `parent(旧) + 新名字.md` —— 这一形状必须服务端认，而且原文件必须消失
       * （否则界面上就是"改个名多出一份"）。 */
      {
        const r = await post('/api/move', { from: '电路/第一章/board-静电场.md', to: '电路/第一章/board-高斯定理.md' })
        eq([r.ok, r.to], [true, '电路/第一章/board-高斯定理.md'], '就地改名（同一层、只换最后一段）→ ok')
        if (!fs.existsSync(path.join(DATA, '电路', '第一章', 'board-静电场.md'))) ok('旧名字那边已经不在了（是改名，不是又存了一份）')
        else bad('改完名旧文件还在 —— 用户会看到两张板')
        const list = await get('/api/list')
        eq(list.files.filter((f) => f.folder === '电路/第一章').length, 1, '那一层里还是 1 个文件（改名不加不减）')
      }

      /* ⑦″ 改名撞到一个已经存在的名字 → 拒（**绝不静默覆盖**那条从"改名"这条路上也得成立）。
       * 先自己把"撞名"那一张造出来 —— 别指望后面的 ⑧ 顺手造，
       * 断言之间的隐含顺序正是"改一行就集体变红"的根源。 */
      {
        await post('/api/new', { name: '电路/第一章/board-撞名.md', text: '{"strokes":[],"cards":[]}' })
        const r = await post('/api/move', { from: '电路/第一章/board-高斯定理.md', to: '电路/第一章/board-撞名.md' })
        eq(r.error, '那边已经有个同名的了', '改成隔壁已经有的名字 → 409（这是"改错名"最常见的那一下）')
        /* ⚠ GET 单文件回的字段是 `text`，没有 `ok`（`ok` 是写那几条的）——
           原来这里断言 `g.ok`，等于断言"这个字段存在"，永远红。
           要问的是"那张板还在不在"，那就看读回来有没有内容。 */
        const g = await get(fileUrl('电路/第一章/board-高斯定理.md'))
        if (String(g.text || '').includes('strokes')) ok('被拒之后原来那张还在、内容也在（改名失败不吞文件）')
        else bad('改名被拒之后那张板读不回来了：' + JSON.stringify(g).slice(0, 80))
      }

      /* ⑧ 两条必须拒的：挪进自己肚子里 / 目标已存在 */
      {
        eq((await post('/api/move', { from: '电路', to: '电路/第一章' })).error, '不能把这一层挪进它自己里面', '把一层挪进它自己 → 400')
        /* "撞名"那一张已经由 ⑦″ 造出来了 —— 这一步要的是"目的路径真的存在"，
           不是"这一步顺手把它造出来"（断言之间的隐含顺序正是集体变红的根源） */
        const r = await post('/api/move', { from: '电路/第一章/board-高斯定理.md', to: '电路/第一章/board-撞名.md' })
        if (!r.error) bad('往一个已存在的路径上挪：居然成功了（会静默吃掉另一个文件）')
        else ok('目标已存在 → 拒绝（' + r.error + '）')
        const back = await get(fileUrl('电路/第一章/board-撞名.md'))
        if (String(back.text).includes('strokes')) ok('原来那个文件一个字节都没被动（拒绝是真的拒绝，不是"先覆盖再报错"）')
        else bad('被拒绝的那次移动还是把目标改掉了')
        eq((await post('/api/move', { from: '电路/第一章/没有这个.md', to: '电路/第一章/x.md' })).error, '要移动的东西不在了', '挪一个不存在的东西 → 404 那句话')
      }

      /* ⑨ 藏起来的目录不进列表（`.git` 之类不是"我的笔记"） */
      {
        await post('/api/mkdir', { path: '.scratch' })
        const list = await get('/api/list')
        if (!list.folders.some((d) => d.startsWith('.'))) ok('以 . 开头的目录不进列表（.git 那种不是笔记）')
        else bad('列表里出现了隐藏目录：' + JSON.stringify(list.folders))
      }

      /* ⑩ 名字不干净的（用户手打）要被修成能落盘的，而不是静默失败 */
      {
        const r = await post('/api/new', { name: '第一章?（上）', text: '# x' })
        eq([r.ok, r.name], [true, '第一章-（上）.md'], '名字里的坏字符换成 `-`，没写 .md 就补上')
        if (fs.existsSync(path.join(DATA, '第一章-（上）.md'))) ok('修过的名字真的落盘了（不是"回了个 ok 其实没写"）')
        else bad('回了 ok，盘上却没有这个文件')
      }
    }
  } catch (e) {
    bad('自检自己抛了异常：' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '))
  } finally {
    kill()
    await sleep(150)
    /* 临时目录整棵删掉。它下面**只有**这一趟跑出来的东西（setup 时刚清过），
       所以这里删的是自己造的 —— "删的是谁的"那个判据在这儿成立。 */
    try {
      fs.rmSync(TMP, { recursive: true, force: true })
    } catch (e) {
      console.log('      （临时目录没删掉：' + TMP + '）')
    }
  }
}

console.log('\n' + '─'.repeat(56))
console.log(fails ? `  ${fails} 项失败（共 ${checks} 项）` : `  全部 ${checks} 项通过`)
console.log('')
process.exitCode = fails ? 1 : 0
