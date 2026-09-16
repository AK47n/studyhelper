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
 *   ctx.s           CDP 会话：send / eval / sleep / mouse / doubleClick / key / drag / penStroke
 *                   / exceptions（页面里的报错）/ errors()（滤掉 favicon 那种噪音）
 *   ctx.board       { name, title, path }，tag 为 null 时是 null
 *   ctx.open(opts)  导航到夹具并等它挂上；opts.settleMs 覆盖等待时长
 *   ctx.read(opts)  读夹具落盘的 JSON（opts.wait 毫秒，等自动存盘用）；读不出返回 null
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

/* 夹具板的名字只允许长这样：board- 前缀（应用才认它是板）+ zz- 标记（一眼看得出是自检造的）。
   ★ 清理只删得掉匹配这个名字的文件 —— 传错一个 tag 也不会删到用户的东西。 */
export const LEGAL_FIXTURE = /^board-zz-[A-Za-z0-9-]+\.md$/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ═══════════════════════ 用户数据守卫（纯函数，可单独断言）═══════════════════════
   守卫的判据是**内容哈希**，不是 mtime：应用写盘常常写出一样的内容
   （"差这么点就不写盘"那套规矩），拿 mtime 判会天天报假警。
   恢复用的是内存里那份原文 —— 只恢复"跑之前就存在、而且被改过"的文件，
   跑出来的新文件一个都不删（那可能是自检自己故意造的，见 check-default-mode）。 */

/** 拍一张 data/ 的快照：名字 → { hash, buf }。跑夹具之前拍。 */
export function snapshotData(dir = DATA) {
  const files = new Map()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { dir, files }
  }
  for (const n of names) {
    const p = path.join(dir, n)
    let buf = null
    try {
      if (!fs.statSync(p).isFile()) continue
      buf = fs.readFileSync(p)
    } catch {
      continue
    }
    files.set(n, { hash: crypto.createHash('sha256').update(buf).digest('hex'), buf })
  }
  return { dir, files }
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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.exceptions.push((d.exception?.description || d.text || '').split('\n').slice(0, 2).join(' | '))
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.exceptions.push('console.error：' + msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 160))
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

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
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

  async key(k, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
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
            read: ({ wait = 0 } = {}) => {
              if (wait) return sleep(wait).then(() => parseMaybe(fix.path))
              return parseMaybe(fix.path)
            },
            /* 现在为止，data/ 里原有文件有没有被改过（应当一直是空的） */
            drift: () => changedSince(before),
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
      const back = restoreChanged(before)
      bad(`★ 自检动了你的文件：${changed.join(' / ')}${back.length ? ' —— 已经按跑前的快照恢复回去了' : '（恢复失败，去 .cache 里找备份）'}`)
    } else {
      ok('data/ 里原有的文件一个字节都没动（你的板没被读、也没被写）')
    }
  }

  console.log('\n' + '─'.repeat(56))
  console.log(rep.fails ? `  ${rep.fails} 项失败（共 ${rep.checks} 项）` : `  全部通过（${rep.checks} 项）`)
  console.log('')
  process.exitCode = rep.fails ? 1 : 0
  return rep.fails
}

function parseMaybe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
