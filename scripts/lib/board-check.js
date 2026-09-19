/* 真浏览器自检的**一道门**：夹具板 + 服务 + 浏览器 + CDP 会话 + 用户板守卫。
 *
 * 为什么要有这个文件（2026-09-16 架构 review 的 C2）：
 *   9 个真浏览器自检各自抄了同一段胶水 —— CDP 会话 9 份、起浏览器 8 份、
 *   夹具板生命周期 6 份、退出清理 9 份。重复的不是几行代码，是**纪律**：
 *   每个脚本都得自己记得"造夹具、跑完删、别碰用户那张板"，
 *   而"别碰用户的板"当时只是一句**承诺**（README 里写着"跑完 git checkout 还原"）——
 *   因为应用打开时挑的是"列表里第一个 board-*.md"，而中文名排在 board-zz-* 前面
 *   （zh 排序里 新=xin < z），所以每次自检都会先把用户那张板读进来，
 *   冷字体缓存下应用还会按新规则重量卡片尺寸、写盘一次。
 *
 * 现在这三件事都是**结构**，不是纪律：
 *   · 夹具板由 withBoard 造、withBoard 删；而且删的时候**只认 board-zz-* 这个名字**
 *     （名字对不上一律不删 —— 见 LEGAL_FIXTURE，这条是"删的是谁的"那个坑的答案）。
 *   · 应用从 `?file=<夹具名>` 直接打开夹具（App.jsx 的首次加载），
 *     **根本不会去读用户那张板**；`?file=` 指的文件不在列表里就什么都不打开
 *     （绝不退回"列表里第一个"—— 那正是它要躲的东西）。
 *   · 跑前跑后对 data/ 里**跑之前就存在**的文件做哈希，谁被改了就从内存里恢复回去
 *     并且报红（见 snapshotData / changedSince / restoreChanged）。
 *
 * ── 用法（9 个自检都长这样）──────────────────────────────────────────────
 *   const fails = await withBoard({
 *     tag: 'lockcheck',            // 夹具板 = data/board-zz-lockcheck.md
 *     port: 5202, cdpPort: 9232,   // 自己一套端口，别跟别的自检串
 *     make: () => serializeBoardDocument(b),   // 或者 text: '...'
 *   }, async ({ s, ok, bad, board, open, read, after }) => {
 *     await open()                 // 导航到 ?file=<夹具> 并等它挂上（不再点左栏）
 *     ...断言...
 *   })
 *
 * ── interface（调用方要知道的就这些）────────────────────────────────────
 *   withBoard(spec, body) → Promise<fails>      跑完收干净、打印小结、设 process.exitCode
 *   spec.tag        夹具标签（必填，除非真的是"一张板都没有"那种场景 → 传 tag: null）
 *   spec.text/make  夹具内容（writeFileSync 的字符串 / 返回它的函数）
 *   spec.port       应用服务端口（默认 5177 —— 别用它，那边可能开着用户自己的服务）
 *   spec.cdpPort    浏览器调试端口
 *   spec.env        额外给 server.js 的环境变量（比如把识别服务指到假服务上）
 *   spec.window     '宽,高'（默认 1440,900）
 *   spec.profile    浏览器 profile 目录（默认放 os.tmpdir()）
 *   spec.settleMs   导航完再等多久（默认 2200，原来是各脚本写死 2500~2800）
 *   body(ctx)       断言写在这儿；抛异常也会被收下来（不会挂住不退出）
 *   ctx.s           CDP 会话：send / eval / sleep / mouse / hover / doubleClick / key / drag / penStroke
 *                   / exceptions（页面里的报错）/ errors()（滤掉 favicon 那种噪音）
 *   ctx.board       { name, title, path }，tag 为 null 时是 null
 *   ctx.open(opts)  导航到夹具并等它挂上；opts.settleMs 覆盖等待时长
 *   ctx.read()      读夹具落盘的 JSON（纯读，读不出返回 null）
 *   ctx.until(pred, { timeout, every, what }) → { ok, waited, value }
 *                   等到谓词为真（**不抛异常**）。时序判据只该用它，别读固定毫秒数 ——
 *                   为什么，见 ctx 里那段注释与 README 第 38 条
 *   ctx.untilFile(pred, opts)   until 的常用形状：等到夹具文件长成某个样子（谓词拿到板文档；
 *                               返回的 value 是**那时候的板文档**，不是谓词的返回值）
 *   ctx.untilSaved(opts)        until 的另一种常用形状：等到应用说「已存」（写盘落地了）——
 *                               读文件之前该等的那一下，代替从前的 `read({wait: N})`
 *   ctx.raw()       读夹具的原文（字符串）
 *   ctx.drift()     现在为止 data/ 里**原有**文件有没有被改过（返回被改的名字数组，应当为空）
 *   ctx.after(fn)   注册"浏览器杀掉之后"要跑的收尾（删自己跑出来的文件、还原配置、关假服务）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { browserExe, headlessArgs } from './browser.js'
import { waitForAppPage } from './cdp.js'
import { BOARD_PREFIX, newBoard, serializeBoardDocument } from '../../src/lib/board.js'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const DATA = path.join(ROOT, 'data')

/* ══════════ 服务端要哪些文件（临时目录自检的复制清单）══════════
 *
 * 「把服务复制到临时目录里跑」的自检（check-storage / check-export）需要先知道
 * **复制哪些文件**。这份清单从前是各脚本手写的 —— 于是 2026-09-18 加了
 * `server-export.js` 之后，`server.js` 多了一条 `import`，而两处手写清单
 * 都还停在旧的三个文件上。症状：临时目录里那一份服务**起不来**，
 * 报出来的话是 `Node.js v24.19.0` 加一堆空行 —— 看着像"Node 坏了"，
 * 其实是文件不齐。（同一个坑 check-export 已经踩过一次，然后 check-storage
 * 又踩着它躺了一次 —— 因为它俩抄的是同一份手写清单。）
 *
 * 所以这份清单**从 server.js 的 import 里推出来**，不手写：
 *   · 顶层 `.js`（`./server-ocr.js`）→ 服务端自己的模块，得复制
 *   · `./src/...` → `src/` 整个目录都会复制，不用单列
 *   · 裸包名（`node:fs` / `katex`）→ 不是文件，跳过（第三方依赖另说，见 katex 那条）
 * 加文件时忘了改这里，也不会有事 —— 它自己会跟着 import 走。
 *
 * ⚠ 只认**静态** `import ... from './x.js'`。动态 `import()` 推不出来，
 *   真加了就手工往 `extra` 里补。
 */
export function serverModules(entry = 'server.js', extra = []) {
  const seen = new Set(['package.json', ...extra])
  const queue = [entry]
  while (queue.length) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    let src = ''
    try {
      src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    } catch {
      continue
    }
    const re = /^import\s[^'"]*from\s*['"](\.[^'"]+)['"]/gm
    let m
    while ((m = re.exec(src))) {
      const spec = m[1]
      if (spec.startsWith('./src/') || spec.startsWith('../src/')) continue // src/ 整个复制
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      if (dep.startsWith('..')) continue
      queue.push(dep)
    }
  }
  return [...seen]
}

/* ══════════ katex 也要进临时目录（不然导出静默降级）══════════
 *
 * ★ 2026-09-18：`server-export.js` 用动态 `import('katex')`，**推不出来**（见上面 ⚠）。
 *   而它找不到时**故意不报错**（"没装 katex 也得能开"是那条底线），
 *   于是临时目录里所有公式都悄悄走"原文摆出来" —— 自检**全绿**，
 *   却在测一个用户手上根本不存在的丑状态。
 *
 * 所以拿目录**联接**（junction，Windows 上不要管理员权限）把真的 katex 挂进去。
 * 只挂这一个包，不挂整个 node_modules：导出真正用到的第三方依赖只有它。
 *
 * @returns {boolean} 挂上了没有（挂不上就退回降级路跑，调用方该在屏幕上说明）
 */
export function linkRuntimeDeps(tmpDir) {
  const from = path.join(ROOT, 'node_modules', 'katex')
  const to = path.join(tmpDir, 'node_modules', 'katex')
  if (!fs.existsSync(from)) return false
  try {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true })
    fs.symlinkSync(from, to, 'junction')
    return fs.existsSync(to)
  } catch {
    return false
  }
}

/* 夹具板的名字只允许长这样：board- 前缀（应用才认它是板）+ zz- 标记（一眼看得出是自检造的）。
   ★ 清理只删得掉匹配这个名字的文件 —— 传错一个 tag 也不会删到用户的东西。 */
export const LEGAL_FIXTURE = /^board-zz-[A-Za-z0-9-]+\.md$/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ═══════════════════════ 用户数据守卫（纯函数，可单独断言）═══════════════════════
   守卫的判据是**内容哈希**，不是 mtime：应用写盘常常写出一样的内容
   （"差这么点就不写盘"那套规矩），拿 mtime 判会天天报假警。
   恢复用的是内存里那份原文 —— 只恢复"跑之前就存在、而且被改过"的文件，
   跑出来的新文件一个都不删（那可能是自检自己故意造的，见 check-default-mode）。

   ★ 2026-09-17：`data/` 可以带层次了，所以这一族**必须递归**。
     从前它只 `readdirSync` 顶层 —— 用户的板一旦挪进 `data/大物/电磁学/`，
     守卫就会一声不吭地不再保护它（"跑了自检、你的东西被改了，而报告是绿的"）。
     递归的判据：跳过以 `.` 开头的（`.git` 不是笔记），剩下的文件和目录都算。 */

/** 递归列出 data/ 里所有文件的**相对路径**（跳过 `.` 开头的目录） */
export function listDataFiles(dir = DATA, prefix = '', out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) listDataFiles(path.join(dir, e.name), rel, out)
    else if (e.isFile()) out.push(rel)
  }
  return out
}

/** 拍一张 data/ 的快照：**相对路径** → { hash, buf, mtimeMs }。跑夹具之前拍。
 *
 * ★ 快照里**不收自检自己的夹具**（`board-zz-*`，见 LEGAL_FIXTURE）：
 *   这张快照的用途只有一个 —— "自检有没有动**你的**文件"，判据是
 *   `changedSince()` 报出来的名单。而夹具是自检造、自检删的，
 *   把它算进去就必然报一条假红。2026-09-18 就是这么踩的：
 *   `check:paper` 跑完红着脸说「自检动了你的文件：board-zz-papercheck.md（不见了）」——
 *   它报的是自检自己刚删掉的那个夹具。这种红比漏报更坏（狼来了）：
 *   真动了用户文件时，报出来的名单里会混着一条假的，看的人就分不清哪条是真的了。
 *
 *   ⚠ 只按**名字**排除（和清理用的是同一条 LEGAL_FIXTURE）。
 *     别改成"path 以 DATA 开头就跳过"之类 —— 那会把用户文件也一起放过。
 */
export function snapshotData(dir = DATA) {
  const files = new Map()
  for (const n of listDataFiles(dir)) {
    const base = n.split('/').pop()
    if (LEGAL_FIXTURE.test(base)) continue
    const p = path.join(dir, n)
    let buf = null
    let mtimeMs = 0
    try {
      buf = fs.readFileSync(p)
      mtimeMs = fs.statSync(p).mtimeMs
    } catch {
      continue
    }
    files.set(n, { hash: crypto.createHash('sha256').update(buf).digest('hex'), buf, mtimeMs })
  }
  return { dir, files, at: Date.now() }
}

/** 快照之后，这些**原有的**文件里谁的内容变了（返回名字数组；新文件不算）。 */
export function changedSince(snap, dir = snap.dir) {
  const out = []
  for (const [n, was] of snap.files) {
    let buf = null
    try {
      buf = fs.readFileSync(path.join(dir, n))
    } catch {
      out.push(n + '（不见了）')
      continue
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
    if (hash !== was.hash) out.push(n)
  }
  return out
}

/* ═══════════ 万一真的动了用户的文件：先把人那一版救下来，再谈恢复 ═══════════
 *
 * ★ 2026-09-18 踩到的：用户**正开着程序编辑那张板**，而自检也动了同一个文件。
 *   原来的收尾是 `restoreChanged(before)` —— 无条件按跑前快照写回去。
 *   那等于**把用户刚敲的字直接抹掉**，而且抹得干净（`fs.writeFileSync`，
 *   不进回收站、也没有第二份）。症状最阴的地方是：屏幕上什么都不报，
 *   自检只报一句"自检动了你的文件 —— 已经恢复回去了"，
 *   而"恢复回去了"听起来像好事，其实是我吃掉了人家的输入。
 *
 * 所以改成两步，顺序不能换：
 *   ① **先把"现在盘上这一版"另存**到 .cache/lost-found/（那才是用户最新的东西）
 *   ② 再按快照恢复
 * 恢复仍然是必要的：自检的纪律是"data/ 跑完必须哈希一致"。
 * 但恢复的**代价**不该由用户承担 —— 所以第①步是这条纪律的前提。
 *
 * ⚠ 只备份"原有的、被改过的"文件。新出现的文件（比如夹具）不归这里管，
 *   它们的清理在 withBoard 的 finally 里（按 board-zz-* 名字删）。
 */
const LOST_FOUND = path.join(ROOT, '.cache', 'lost-found')

/**
 * 把被改过的原有文件的**当前版本**先落一份到 .cache/lost-found/。
 * 返回 [{ name, saved }]。`name` 里的 `/` 换成 `__` 当文件名（避免子目录）。
 */
export function preserveChanged(snap, dir = snap.dir) {
  const done = []
  for (const n of changedSince(snap, dir)) {
    const missing = n.endsWith('（不见了）')
    const rel = missing ? n.replace('（不见了）', '') : n
    const src = path.join(dir, rel)
    try {
      if (!fs.existsSync(src)) continue
      fs.mkdirSync(LOST_FOUND, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const dest = path.join(LOST_FOUND, `${stamp}__${rel.replace(/[\\/]/g, '__')}`)
      fs.copyFileSync(src, dest)
      done.push({ name: rel, saved: dest })
    } catch {
      /* 存不下也要继续 —— 恢复那一步还在后面，不能因为备份失败就不收拾现场 */
    }
  }
  return done
}

/** 把被改过的原有文件按快照恢复回去，返回恢复过的名字数组。新文件不动。 */
export function restoreChanged(snap, dir = snap.dir) {
  const done = []
  for (const n of changedSince(snap, dir)) {
    if (n.endsWith('（不见了）')) continue
    const was = snap.files.get(n)
    try {
      fs.writeFileSync(path.join(dir, n), was.buf)
      done.push(n)
    } catch {}
  }
  return done
}

/* ═══════════════════════════ CDP 会话 ═══════════════════════════
   从前这段在 9 个脚本里各有一份（连注释都是抄的），而"真鼠标"那几条
   只有 check-lock / check-link 有 —— 抄出来的差异就是纪律的漏点。
   这里收成**所有脚本共用的一个**：谁要什么都在，不用再各写一份。

   internal seam：脚本平时只用 `ctx.s`，不自己 `new Session`；这一族留在这儿是给
   以后"不想走 withBoard、但想连一个现成页面"的自检兜底的。 */

export class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    /* 页面里的 JS 报错收下来。
       为什么要它：碰的几乎都是事件处理（拖动/缩放/指针捕获），
       "处理器抛了个异常"和"处理器压根没跑"在界面上长得一模一样 ——
       都是"点了没反应"。有了这个才不用靠猜。 */
    this.exceptions = []
    /* ★ 页面自己打的 console 日志（只收 `log`，不收 warn/error —— 那两个已经被
       exceptions 收走了）。为什么要留一份：**读数分不清原因的时候，人就会去改错的地方。**
       出过一次红："框住之后那一排动作没出现 —— 框选没选中？"，而框选其实完全正常，
       真正的因素是判读阈值没放过那个圆。自检顺手把应用自己打的日志收下来当**证据**，
       红了之后一眼就能分清"框没罩住"和"罩住了但认不出来"。
       ⚠ 它只当证据，别拿它当断言判据（console 文案是给人看的，随时会改）。 */
    this.logs = []
    this.onLog = null
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.exceptions.push((d.exception?.description || d.text || '').split('\n').slice(0, 2).join(' | '))
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const type = msg.params.type
        const text = (msg.params.args || [])
          .map((a) => (a && a.value != null ? String(a.value) : a && a.description ? String(a.description) : ''))
          .join(' ')
        if (type === 'error') {
          this.exceptions.push('console.error：' + text.slice(0, 160))
        } else if (type === 'log' && text) {
          this.logs.push(text)
          if (this.logs.length > 400) this.logs.shift()
          try {
            if (this.onLog) this.onLog(text)
          } catch {}
        }
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 20000)
    })
  }

  async eval(expr) {    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 出错')
    return r.result.value
  }

  /** 真鼠标：按下 → 若干次移动 → 松开。点一下就是 steps=0。 */
  async mouse(x, y, { steps = 0, dx = 0, dy = 0, button = 'left' } = {}) {
    const buttons = button === 'left' ? 1 : button === 'middle' ? 4 : 2
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button, buttons })
      await sleep(12)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button, buttons: 0 })
    await sleep(220)
  }

  /* ★ 悬停：只把指针移过去，**不按**（`mouse()` 是"按 + 松"，用来 hover 会顺手点一下）。
     为什么需要它：左栏文件行上那几个动作（导出 / 改名）是 `:hover` 才显示的 ——
     不 hover，"那颗按钮在不在、点不点得到"根本量不出来（实测拿到 rect 0×0）。
     ⚠ 判据仍然是 `elementFromPoint`：hover 过了也不等于它点得到（可能被别的层盖着）。 */
  async hover(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await sleep(160)
  }

  /* 双击：CDP 里靠 clickCount 表达（两次 pressed/released，第二次 clickCount=2）。
     ⚠ 别用元素上的 dispatchEvent('dblclick')：那绕过命中测试，
     证明不了"用户双击得到它"（README 第 11 条）。 */
  async doubleClick(x, y) {
    for (const clickCount of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount })
      await sleep(40)
    }
    await sleep(320)
  }

  /* 按一个键。
     ★ `char` 那一发是**必需**的，不是可选的（2026-09-17 拿五种发法实测出来的）：
       `<form method="dialog">` 的**隐式提交**是浏览器从键盘事件序列里派生的 ——
       只发 keyDown/keyUp 的话，`keydown` 到得了、`keypress` 和 `submit` 永远不来。
       症状极具迷惑性：字打进去了、页面上一点报错都没有，就是"回车没反应"。
       实测（check-ask 那条，五个变体各试一遍）：
         keyDown + keyUp             → {keydown:1, keypress:0, submit:0}  ✗
         rawKeyDown + keyUp          → {keydown:1, keypress:0, submit:0}  ✗
         rawKeyDown + char + keyUp   → {keydown:1, keypress:1, submit:1}  ✓
         keyDown + char + keyUp      → {keydown:1, keypress:1, submit:1}  ✓（用这个）
       所以：**任何键都补一发 `char`**，`char` 才是 keypress 的来源。
     ★ 但 `text` 不能乱给，CDP 只收**一个字符**：
       · **修饰键**（Shift / Control / Alt / Meta）给它 → 直接拒收
         （`Invalid 'text' parameter`）
       · **名字比一个字符长的任何键都一样被拒** —— `Escape` / `ArrowLeft` / `Tab` / `F5` …
         （唯一的例外是 `'\r'`：Enter 就得那么写。）
       踩过（2026-09-18，check-link 的 [5]）：原来判据是"是不是修饰键"，
       于是 `await s.key('Escape','Escape',27)` 把 `text:'Escape'` 送了出去 →
       CDP 当场报错 → **整条自检抛异常、后面 [6][7] 几十条断言全丢**，
       而屏幕上只有一句 `Invalid 'text' parameter`，看不出是哪个键干的。
     ⚠ 试过"只给单字符带 text"那条路 —— CDP 认键名，Enter 不带 text 就**不派发 char**，
         结果回车永远提交不了。所以判据是**"键名是不是一个字符"**（Enter 单独放行 \r），
       不是"是不是修饰键" —— 前者正好把 Enter 和修饰键都照顾到了。 */
  async key(k, code, vk) {
    /* 能给 text 的只有两种：Enter（CDP 要 '\r'）和**单字符**键名（'a' '2' '$'…）。
       其余（修饰键、Escape、Arrow*、Tab、F* …）只发 char、不带 text。
       ⚠ 别退回"按修饰键判"：那样 Escape 会被拒，整条自检挂掉。 */
    const text = k === 'Enter' ? '\r' : typeof k === 'string' && k.length === 1 ? k : null
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await this.send(
      'Input.dispatchKeyEvent',
      text == null
        ? { type: 'char', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
        : { type: 'char', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text, unmodifiedText: text }
    )
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await sleep(260)
  }

  /* 真鼠标拖：平移靠它。⚠ 不沾指针的东西用 eval 就够了，
     但"拖一下能不能推动视图"只有真事件能证明（README 第 11 条）。 */
  async drag(x0, y0, dx, dy, { steps = 8, button = 'middle' } = {}) {
    const buttons = button === 'middle' ? 4 : 1
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button, buttons, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps, button, buttons })
      await sleep(12)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button, buttons: 0 })
    await sleep(260)
  }

  /* 用**笔**画（pointerType: 'pen'）。
   * ★ 为什么必须是笔、不能是鼠标：卡片是 DOM、会收指针事件（鼠标按上去是**拖卡片**）。
   *   用笔时卡片让路（.bd.penink .bd-card），笔尖才能从卡片上写过去 ——
   *   而这正是用户的真实姿势（他就是要在两张卡之间画线）。
   * ★ 而且**先悬停一下**：应用靠"最近一次是什么设备"判断要不要加 .penink，
   *   直接按下去的话，那一下还是会被卡片接走（见 Board.jsx 的注释）。 */
  async penStroke(from, to, { steps = 10, hover = true } = {}) {
    if (hover) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'pen' })
      await sleep(140)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
      const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'pen' })
      await sleep(12)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
    await sleep(220)
  }

  sleep(ms) {
    return sleep(ms)
  }

  /** 页面里的报错，滤掉 favicon / 静态资源那种噪音 */
  errors() {
    return this.exceptions.filter((e) => !/favicon|Failed to load resource/i.test(e))
  }
}

/** 报数：和 9 个脚本原来那套一样的符号和小结 */
export function makeReporter() {
  const r = {
    fails: 0,
    checks: 0,
    ok(m) {
      r.checks++
      console.log('  \u2713 ' + m)
    },
    bad(m) {
      r.checks++
      r.fails++
      console.log('  \u2717 ' + m)
    },
  }
  return r
}

async function portAlive(url, ms = 700) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    await fetch(url, { signal: ctl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/* ═══════════════════════════ withBoard ═══════════════════════════ */

export async function withBoard(spec, body) {
  const {
    tag = null,
    text,
    make,
    port = 5177,
    cdpPort = 9223,
    env = {},
    window: win = '1440,900',
    profile,
    settleMs = 2200,
  } = spec || {}

  const appUrl = `http://127.0.0.1:${port}/`
  const cdpUrl = `http://127.0.0.1:${cdpPort}`
  const fix = tag
    ? { name: BOARD_PREFIX + 'zz-' + tag + '.md', title: BOARD_PREFIX + 'zz-' + tag, path: path.join(DATA, BOARD_PREFIX + 'zz-' + tag + '.md') }
    : null
  if (fix && !LEGAL_FIXTURE.test(fix.name)) {
    throw new Error(`夹具名必须是 board-zz-<标签>.md（收到 ${fix.name}）—— 这个名字是"跑完删得掉"的唯一凭据`)
  }
  const openUrl = fix ? appUrl + '?file=' + encodeURIComponent(fix.name) : appUrl

  const rep = makeReporter()
  const { ok, bad } = rep

  /* ★ **跑之前先看一眼：现在有没有人正在编辑？**（2026-09-18 加的）
   *
   * 起因：用户开着 studyhelper 编辑 `board-熵增加.md`，而自检也跑着。
   * 结果自检收尾把他刚敲的内容覆盖了。见下面 finally 里那段长说明
   * （结论是：**自检收尾从此不再写回任何用户文件**）。
   *
   * ⚠ 既然收尾已经不覆盖了，这里就**不该拦住自检** —— 用户基本上天天开着
   *   那个窗口，拦下来等于自检没法跑了。
   *   但"你正开着程序"这件事仍然值得说一声，因为：
   *     · 自检期间如果你的程序往同一个文件写，**报出来会是一堆假红**
   *       （像 2026-09-18 那天 check-link 报的"自检动了你的文件"）；
   *     · 反过来也一样：自检不会去改你的东西，但你也别在自检跑的时候
   *       指望那份板一动不动 —— 你自己程序存的盘也会让守卫看见"变了"。
   *   所以是**打印一句提醒**，不是抛异常。
   *   想让它闭嘴：`BOARD_CHECK_QUIET_BUSY=1`。
   */
  if (!process.env.BOARD_CHECK_QUIET_BUSY) {
    const busy = hotFiles()
    /* 5177 是用户平时双击开的那个（DEV 走 5178）。每个自检脚本用自己那套端口
       （5203/5204…），所以"5177/5178 有人听"是个干净信号。 */
    const appOpen = (await portAlive('http://127.0.0.1:5177/')) || (await portAlive('http://127.0.0.1:5178/'))
    if (appOpen || busy.length) {
      console.log('')
      console.log('  ⚠ 注意：' + (appOpen ? '5177 上有程序在听（你自己开着 studyhelper？）' : '') + (busy.length ? (appOpen ? '，而且' : '') + `这些文件刚被写过：${busy.join(' / ')}` : ''))
      console.log('    自检**不会**改你的文件，但它跑的时候你的程序要是也在存盘，')
      console.log('    下面的断言可能会因为"文件在我眼皮底下变了"而报假红。')
      console.log('    想安静跑就关掉那个窗口，或者设 BOARD_CHECK_QUIET_BUSY=1。')
      console.log('')
    }
  }

  /* ★ 顺序要紧：先拍快照，再写夹具。晚一步的话夹具自己会被算进"原有文件"。 */
  const before = snapshotData()
  if (fix) {
    fs.mkdirSync(DATA, { recursive: true })
    /* 没给内容就给一张**空板** —— 大多数自检要的只是"打开的是我自己的板"这件事。 */
    const content = text != null ? text : make ? make() : serializeBoardDocument(newBoard('自检夹具（跑完自动删除）'))
    fs.writeFileSync(fix.path, content, 'utf8')
  }

  const afterFns = []
  const serverLog = []
  let server = null
  let browser = null
  const kill = () => {
    for (const p of [browser, server]) {
      try {
        if (p && !p.killed) p.kill()
      } catch {}
    }
  }
  // 中途被强杀（Ctrl+C / 被上层杀进程树）也要收干净
  process.on('exit', kill)

  let s = null
  try {
    /* 端口上已经有东西在跑就直接停：那多半是上一次没收掉的僵尸服务，
       连上去会**对着旧版本的应用**跑自检 —— 绿得理直气壮，却什么都没验。 */
    if (await portAlive(appUrl + 'api/list')) {
      bad(`端口 ${port} 上已经有服务在跑了 —— 先把它关掉（自检会连着旧应用跑，结果不算数）`)
    } else if (await portAlive(cdpUrl + '/json/version')) {
      bad(`调试端口 ${cdpPort} 上已经有个浏览器了 —— 先关掉它（不然连的是别的页面）`)
    } else {
      server = spawn(process.execPath, ['server.js', '--no-auto-exit', '--no-open'], {
        cwd: ROOT,
        env: { ...process.env, STUDYHELPER_PORT: String(port), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      server.stdout.on('data', (d) => serverLog.push(String(d)))
      server.stderr.on('data', (d) => serverLog.push(String(d)))

      const profileDir = profile || path.join(os.tmpdir(), `studyhelper-${tag || 'check'}-${cdpPort}`)
      try {
        fs.rmSync(profileDir, { recursive: true, force: true })
      } catch {}
      browser = spawn(
        browserExe(),
        [...headlessArgs(), `--window-size=${win}`, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, openUrl],
        { stdio: 'ignore' }
      )

      let up = false
      for (let i = 0; i < 60; i++) {
        up = await portAlive(appUrl + 'api/list', 1000)
        if (up) break
        await sleep(200)
      }
      if (!up) {
        bad(`服务没起来（${appUrl}）`)
        if (serverLog.length) console.log('      服务输出：' + serverLog.join('').split('\n').slice(-4).join(' | '))
      } else {
        ok(`服务起来了：${appUrl}` + (fix ? `（夹具 ${fix.name}）` : ''))
        const page = await waitForAppPage(cdpUrl, { appUrl })
        if (!page) {
          bad(`等不到浏览器里的应用页（CDP ${cdpUrl}）`)
        } else {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true })
            ws.addEventListener('error', rej, { once: true })
          })
          s = new Session(ws)
          await s.send('Runtime.enable')
          await s.send('Page.enable')
          await s.send('Log.enable')

          /* 打开夹具板 = 导航 + 等它真的挂上。
             ★ 不再"进界面之后点左栏那一行"：应用从 ?file= 直接开，
               用户那张板根本不会被读进来（那是这一整块要躲开的事）。
             opts.params 是额外要挂在地址栏上的查询（比如 ?paper=dots ——
             那些走地址栏的开关必须和 ?file= 一起才不丢夹具）。 */
          const open = async ({ settle = settleMs, params = null } = {}) => {
            let url = openUrl
            if (params) {
              const u = new URL(openUrl)
              for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
              url = u.href
            }
            await s.send('Page.navigate', { url })
            const deadline = Date.now() + 25000
            let last = null
            while (Date.now() < deadline) {
              last = await s
                .eval(`(() => {
                  const q = (x) => document.querySelector(x)
                  return {
                    cover: !!q('.cover'),
                    ready: !!q('.bd-stagewrap') || !!q('.topbar'),
                    file: ((q('.bd-file') || {}).textContent || '').trim(),
                  }
                })()`)
                .catch(() => null)
              if (last && !last.cover && last.ready && (!fix || last.file === fix.name)) break
              await sleep(250)
            }
            await sleep(settle)
            if (fix) {
              const file = await s.eval(`((document.querySelector('.bd-file') || {}).textContent || '').trim()`)
              if (file === fix.name) console.log('  （夹具板：' + file + '）')
              else bad(`打开的不是夹具板（顶栏是「${file}」，期望 ${fix.name}）—— ?file= 那条路没生效？`)
            }
          }

          const ctx = {
            s,
            ok,
            bad,
            board: fix,
            appUrl,
            cdpUrl,
            port,
            open,
            raw: () => (fix ? fs.readFileSync(fix.path, 'utf8') : null),
            /* 读夹具落盘的内容（纯读）。**别再给它加 `wait` 那种"先睡再读"的选项** ——
               要等就用下面的 untilFile。 */
            read: () => parseMaybe(fix ? fix.path : null),
            /* ═══════════ 等到真的发生了 ═══════════
               真浏览器自检里**唯一**该用的时序判据。
               为什么要它：读一个固定毫秒数就是猜 —— 应用侧有 700ms 防抖存盘、静置 400ms 才重量
               尺寸、拟合最多跑 12 趟，机器一忙，同一份提交就有两种结果。
               check-link 那条 1/3 概率报红就是这么来的（README 第 38 条）：
               它 `sleep(300)` 之后重新导航，而防抖那一趟**有时**赶在导航前落了盘 ——
               于是 [9] 有时读到 1 笔、有时读到 2 笔。
               until 的判据是**事实**（夹具文件里的某个东西 / 页面上量到的某个数），不是时间。
               返回 { ok, waited, value } —— **不抛异常**：超时要由调用方报成一条 ✗，
               免得一次超时把后面几十条断言全带走。 */
            until: async (pred, { timeout = 6000, every = 80, what = '条件' } = {}) => {
              const t0 = Date.now()
              let value
              for (;;) {
                try {
                  value = await pred()
                } catch {
                  value = undefined
                }
                if (value) return { ok: true, waited: Date.now() - t0, value }
                if (Date.now() - t0 >= timeout) return { ok: false, waited: Date.now() - t0, value }
                await sleep(Math.min(every, Math.max(0, timeout - (Date.now() - t0))))
              }
            },
            /* until 的常用形状：**等到夹具文件长成某个样子**。
               谓词拿到的是解析好的板文档（解析不出来就当没到）。
               例：await untilFile((d) => d.strokes.length === 2, { what: '盘上多了一笔' })
               ★ 返回的 `value` 是**那时候的板文档**，不是谓词的返回值 ——
                 调用方通常要拿这份文档接着断言（`const doc = w.value || await read()`）。
                 自己绊过一次：把它当成"谓词返回的那张卡"用了，于是 doc.w 全是 undefined。 */
            untilFile: (pred, opts = {}) =>
              ctx.until(() => {
                const d = parseMaybe(fix ? fix.path : null)
                return d && pred(d) ? d : undefined
              }, { what: '夹具文件里的 ' + (opts.what || '条件'), ...opts }),
            /* 现在为止，data/ 里原有文件有没有被改过（应当一直是空的） */
            drift: () => changedSince(before),
            /* 等到**应用自己说"都写进去了"**（工具条那颗「已存」）。
               这是"读文件之前该等的那一下"的通用形状 —— 以前到处是 `read({wait: 1200})`：
               睡多久都是猜，而应用侧明明有一个诚实的时刻（2026-09-17 起它真的诚实了：
               Board.jsx 的 flushSave 要等写盘回来才清 dirty，见 README 第 38 条）。
               ⚠ 它是**页面事实**：那条自检得开着白板页（所有真浏览器自检都开着）。 */
            untilSaved: (opts = {}) =>
              ctx.until(async () => {
                const t = await s.eval(`(() => { const el = document.querySelector('.bd-save'); return el ? el.textContent.trim() : '' })()`)
                return t === '已存' ? t : undefined
              }, { what: '应用说「已存」（写盘真的落地了）', ...opts }),
            after: (fn) => afterFns.push(fn),
          }
          await body(ctx)
        }
      }
    }
  } catch (e) {
    /* ★ 断言里抛异常也要收下来：否则进程挂在这儿，报出来是"自检不动了"，
       而原因（比如夹具写错了）反而看不见。 */
    bad('自检自己抛了异常（下面这些断言没跑完）：' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '))
  } finally {
    kill()
    await sleep(150)
    /* 先删自己的夹具（名字只认 board-zz-*），再跑脚本注册的收尾，
       最后才查守卫 —— 顺序换了会把自检自己的文件算进"用户数据"。 */
    if (fix) {
      try {
        if (LEGAL_FIXTURE.test(fix.name)) fs.rmSync(fix.path, { force: true })
      } catch {}
    }
    for (const fn of afterFns.reverse()) {
      try {
        await fn()
      } catch (e) {
        bad('收尾那一步抛了异常：' + String(e && e.message))
      }
    }
    const changed = changedSince(before)
    if (changed.length) {
      /* ═══════════ 自检动了用户的文件：**不覆盖，报错 + 留证据** ═══════════
       *
       * ★ 2026-09-18 定下来的（这条路原来走错了两回）：
       *
       *   第一版：`restoreChanged(before)` —— 无条件按跑前快照写回去。
       *           后果：用户正开着程序编辑那张板，自检把**他刚敲的字**抹掉了。
       *           而报出来的话是"已经恢复回去了"，听起来像好事。
       *
       *   第二版：先 `preserveChanged` 另存，再恢复。
       *           好了一点（丢之前至少留了一份），但"覆盖"这件事还在 ——
       *           而且**应用内存里的状态和盘上不一致了**，用户下次一存又覆盖回来。
       *           "两边都在写同一个文件"无论怎么收尾都是坏的。
       *
       *   现在这版：**一个字节都不动**。因为想明白了 ——
       *     自检本来就不该碰用户文件。真碰了，那是**自检自己的 bug**，
       *     该做的是**让人看见**，不是悄悄把现场抹平（那叫掩盖）。
       *
       *   而且"恢复"本身就是自检里最危险的一行：它是 `fs.writeFileSync`，
       *   不进回收站、没有第二份、不弹确认。**用户的手稿不该由一条自检的收尾逻辑
       *   来决定去留。**
       *
       * ── 一个文件变了，是谁干的？────────────────────────────────────
       * ★ 2026-09-18 又踩了一下：用户开着程序在写 `board-熵增加.md`，
       *   于是守卫**每次都报红**，报的还是他**没做过**的事。
       *   这种红比"漏报"更坏 —— 久了就没人看告警了（狼来了）。
       *   判据：**跑之前它是热的吗**（`wasHot`）。
       *     凉 → 变热 = 自检的锅 → ✗
       *     热 → 那它本来就在动，跟你开着程序有关 → 只说一句（不算失败）
       *   两条判据都是**事实**（快照里记了 mtime），不是猜。
       */
      const hot = changed.filter((n) => !n.endsWith('（不见了）') && mtimeAfter(before, n))
      const external = hot.filter((n) => wasHot(before, n))
      const ours = changed.filter((n) => !external.includes(n))

      if (ours.length) {
        const kept = preserveChanged(before)
        bad(`★ 自检动了你的文件：${ours.join(' / ')}`)
        bad('  **没有帮你改回去** —— 这是故意的：自检不该碰你的笔记，碰了就是自检的错，')
        bad('  而且"按快照写回去"是一行 fs.writeFileSync（不进回收站、没有第二份、不弹确认），')
        bad('  用它决定你手稿的去留太危险。请自己打开看一下内容，需要的话 Ctrl+Z 或从 git 恢复。')
        if (kept.length) {
          bad(`  自检改动之后的版本已留证：.cache/lost-found/（${kept.map((k) => path.basename(k.saved)).join(' / ')}）`)
        } else {
          bad('  ⚠ 连留证都没成功（.cache/lost-found/ 写不进去？）—— 这个要查一下')
        }
      } else {
        /* 全都能用"跑之前它就是热的"解释掉 → 不是自检干的，别报成失败。 */
        ok(`data/ 里变了的文件都是**跑之前就在被写**的（${changed.join(' / ')}）—— 是你开着的程序存的盘，不是自检动的`)
      }
      if (external.length) {
        console.log(`  （提示：${external.join(' / ')} 跑之前就是热的，自检期间还在变 —— 你的程序在存盘）`)
      }
    } else {
      ok('data/ 里原有的文件一个字节都没动（你的板没被读、也没被写）')
    }
  }

  console.log('\n' + '─'.repeat(56))
  const total = rep.checks
  console.log(rep.fails ? `  ${rep.fails} 项失败（共 ${total} 项）` : `  全部通过（${total} 项）`)
  console.log('')
  process.exitCode = rep.fails ? 1 : 0
  return rep.fails
}

/**
 * 这个文件**在自检开始跑的那一刻**是不是热的（刚被人写过）。
 *
 * 用途：守卫分清"是自检改的"还是"是别人（你自己开着的程序）改的"。
 *   跑之前它是凉的 → 跑完变热了 = **自检的锅**，报 ✗。
 *   跑之前它就是热的 → 那它变了本来就在意料之中，报"提示"就够 ——
 *   否则用户天天开着程序，自检就天天红，红的还是他**没做过**的事，
 *   久了就没人看这些告警了（"狼来了"）。
 *
 * 阈值 15 秒：比 hotFiles 那个 10 秒稍宽，因为快照到"跑起来"之间还有几步。
 */
function wasHot(snap, rel) {
  const was = snap.files.get(rel)
  if (!was || !was.mtimeMs) return false
  return snap.at - was.mtimeMs < 15000
}

/** 这个文件在自检跑完的这一刻，mtime 是不是"刚刚"（像有别人在写）。 */
function mtimeAfter(snap, rel) {
  try {
    const st = fs.statSync(path.join(snap.dir, rel))
    return Date.now() - st.mtimeMs < 4000
  } catch {
    return false
  }
}

/**
 * data/ 里哪些文件"此刻像有人在写"（mtime 很新）。给"跑之前"用的闸。
 *
 * 阈值 10 秒：够宽（防抖存盘 700ms、拟合几趟、人手动保存的间隔都在里面），
 * 又够窄（不至于把"我昨晚改的"当成"现在有人在写"）。
 * 不递归子目录的话会漏掉分层放的板（`大物/电磁学/board-第一章.md`），所以递归。
 */
function hotFiles(dir = DATA, withinMs = 10000) {
  const out = []
  const walk = (d, prefix) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, rel)
      else if (e.isFile()) {
        try {
          if (Date.now() - fs.statSync(p).mtimeMs < withinMs) out.push(rel)
        } catch {}
      }
    }
  }
  walk(dir, '')
  return out
}

function parseMaybe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
