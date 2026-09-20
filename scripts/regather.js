/* ═══════════ 重跑「▤ 收成笔记」：拿一张**真板**走一遍完整链路 ═══════════
 *
 * 它和应用里手点一遍完全同路：真浏览器 → 真本地服务 → 真识别服务（**花真钱**）→
 * 转录校对 → 结构整理 → 落盘覆盖那份草稿。区别只有一个：手点是你在点，这里是脚本在点。
 *
 * 跑：npm run regather -- --board=大物/电磁感应/board-8.2.md --yes
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────
 * 这条链路上出的错，绝大多数**只有拿真板跑一遍才看得见**（README 第 23 条那一族：
 * "自动判定的 bug 只出现在更脏的输入上"）。而"再点一次"对人是几十秒的等待 + 一次额度，
 * 于是查一个问题常常卡在"我懒得再跑一遍"。自检（check:ocr-browser）用的是夹具板 +
 * 假识别服务，**验不了真模型到底回什么** —— 这一条补的就是那个缺口。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 *   ① **默认不写盘**：不给 `--yes` 就只跑到校对弹层为止（把认到的字打出来给你看），
 *      绝不覆盖你的笔记。覆盖这件事必须是你明说的。
 *   ② **覆盖之前先留一份**：旧的那份挪进 `.cache/lost-found/`（和自检那条纪律同一个地方），
 *      文件名带时间戳。写文件不进回收站，这一步是唯一后悔药。
 *   ③ **认错一块就停**：任何一块没认出来 → 关掉弹层、一个字都不写。
 *      半份草稿比没有草稿更坏（你会以为那就是全部）。
 *
 * ⚠ 它**不碰板文件**（只读）；也不动你的 config —— 用的就是你配好的那份密钥。
 * ⚠ 它连的是自己的端口（默认 5211/9271），和你开着的那个应用互不打扰。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, Session } from './lib/board-check.js'
import { browserExe, headlessArgs } from './lib/browser.js'
import { waitForAppPage } from './lib/cdp.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 参数 ───────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
const arg = (name, def = '') => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : def
}
const BOARD = arg('board', '大物/电磁感应/board-8.2.md').replace(/\\/g, '/')
/* 默认端口挑的是**没被任何自检占着**的一对（自检的清单：5199~5233 / 9229~9271）。
   占重了的话，撞上的那条自检会红着脸说"调试端口上已经有个浏览器了"，
   而看起来像是它自己坏了 —— 2026-09-20 就是这么互相绊了一跤（check:doc 用的 9271）。 */
const PORT = Number(arg('port', '5241'))
const CDP = Number(arg('cdp', '9281'))
const YES = argv.includes('--yes')
const KEEP = argv.includes('--keep') // 跑完不关浏览器（想自己接手看那个页面时用）
/* `--shots`：把**发给识别服务的那两张图**抠出来存到 .cache/shots/。
   用途是校对：那两张图就是模型看到的全部 —— 图上没有的它也认不出来，
   读不准的时候拿它当裁判（比对着板文件里的笔迹坐标猜可靠得多）。 */
const SHOTS = argv.includes('--shots')

const boardPath = path.join(ROOT, 'data', BOARD)
const boardDir = path.dirname(boardPath)
const appUrl = `http://127.0.0.1:${PORT}/`
const cdpUrl = `http://127.0.0.1:${CDP}`

if (!fs.existsSync(boardPath)) {
  console.error(`找不到板：${boardPath}`)
  process.exit(2)
}
if (!fs.existsSync(path.join(ROOT, 'config', 'ocr.json'))) {
  console.error('没有 config/ocr.json —— 这条工具要用你自己的识别密钥（和应用里一样）。')
  process.exit(2)
}
/* 板名 = 文件名去掉 `board-` 前缀和后缀（和 App 里 `boardTitleOf` 同一条规矩）。 */
const stem = path.basename(boardPath).replace(/\.md$/i, '').replace(/^board-/, '')
const notePath = path.join(boardDir, stem + ' · 笔记.md')

console.log(`  板：${BOARD}`)
console.log(`  会覆盖：${path.relative(ROOT, notePath)}`)
console.log(YES ? '  （--yes：真的会覆盖；旧的那份先挪进 .cache/lost-found/）' : '  （没给 --yes：只跑到校对弹层，**不写盘**）')

/* ── 起服务 + 浏览器 ────────────────────────────────────────────────── */
let server = null
let browser = null
let ws = null
const serverLog = []
const kill = () => {
  for (const p of [browser, server]) {
    try {
      if (p && !p.killed) p.kill()
    } catch {}
  }
}
process.on('exit', kill)
process.on('SIGINT', () => {
  kill()
  process.exit(130)
})

try {
  const alive = await fetch(appUrl + 'api/list').then(() => true).catch(() => false)
  if (alive) throw new Error(`端口 ${PORT} 上已经有服务在跑 —— 换一个 --port`)
  const cdpAlive = await fetch(cdpUrl + '/json/version').then(() => true).catch(() => false)
  if (cdpAlive) throw new Error(`调试端口 ${CDP} 上已经有浏览器 —— 换一个 --cdp`)

  server = spawn(process.execPath, ['server.js', '--no-auto-exit', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, STUDYHELPER_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => serverLog.push(String(d)))
  server.stderr.on('data', (d) => serverLog.push(String(d)))

  /* ★ profile 目录**不每次清**：它装着应用自己的 OCR 缓存（localStorage，按内容哈希）——
     清掉就等于"同样的板每跑一次都重新花一次钱"。想强制重认加 `--fresh`。
     （缓存键里带着 flavor，换了契约那份老稿不会被当成新的读，见 App.jsx 的 BAND_FLAVOR。） */
  const profileDir = path.join(os.tmpdir(), `studyhelper-regather-${CDP}`)
  if (argv.includes('--fresh')) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {}
  }
  const url = appUrl + '?file=' + encodeURIComponent(BOARD)
  browser = spawn(browserExe(), [...headlessArgs(), '--window-size=1440,900', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profileDir}`, url], { stdio: 'ignore' })

  let up = false
  for (let i = 0; i < 60; i++) {
    up = await fetch(appUrl + 'api/list').then(() => true).catch(() => false)
    if (up) break
    await sleep(250)
  }
  if (!up) throw new Error('服务没起来：\n' + serverLog.join('').split('\n').slice(-6).join('\n'))

  const page = await waitForAppPage(cdpUrl, { appUrl })
  if (!page) throw new Error('等不到浏览器里的应用页')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const s = new Session(ws)
  await s.send('Runtime.enable')
  await s.send('Page.enable')
  await s.send('Log.enable')

  /* 等应用把这张板挂上（顶栏那行会写着文件名）。 */
  const until = async (pred, { timeout = 10000, every = 200, what = '条件' } = {}) => {
    const t0 = Date.now()
    let value
    for (;;) {
      try {
        value = await pred()
      } catch {
        value = undefined
      }
      if (value) return { ok: true, value, waited: Date.now() - t0 }
      if (Date.now() - t0 >= timeout) return { ok: false, value, waited: Date.now() - t0, what }
      await sleep(every)
    }
  }
  const mounted = await until(
    () => s.eval(`(() => { const f = (document.querySelector('.bd-file') || {}).textContent || ''; return f.trim() === ${JSON.stringify(BOARD)} ? f.trim() : null })()`),
    { timeout: 30000, every: 250, what: '板挂上' }
  )
  if (!mounted.ok) throw new Error(`?file= 没把这张板打开（顶栏看到的是「${await s.eval(`((document.querySelector('.bd-file')||{}).textContent||'').trim()`)}」）`)
  console.log(`  板打开了：${BOARD}`)

  /* ── 点「▤ 收成笔记」→ 名字框回车 ─────────────────────────────────── */
  const btn = await s.eval(`(() => {
    const b = document.querySelector('[data-tool="gather"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!btn) throw new Error('找不到「▤ 收成笔记」那颗按钮（界面变了吗？）')
  await s.mouse(btn.x, btn.y)
  const askName = await until(
    () => s.eval(`(() => { const d = document.querySelector('.ask-input'); return d ? String(d.value || '') : null })()`),
    { timeout: 10000, what: '名字框' }
  )
  if (!askName.ok) throw new Error('名字框没弹出来')
  console.log(`  名字预填：${askName.value}`)
  await s.key('Enter', 'Enter', 13)

  /* ── 等转录（一块一块认）─────────────────────────────────────────────
     一边等一边把"这一块认得怎么样"打出来 —— 认字那趟的覆盖率是**唯一**能提前
     看出"模型有没有按行回话"的地方（没按行回话 → 第二趟整节不参与）。 */
  console.log('  正在识别（真模型，一块几十秒）…')
  const t0 = Date.now()
  let lastLine = ''
  const review = await until(
    async () => {
      const r = await s.eval(`(() => {
        const root = document.querySelector('.trv')
        if (!root) return null
        const bands = [...root.querySelectorAll('.trv-band')]
        return {
          n: bands.length,
          pend: bands.filter((b) => b.getAttribute('data-pending') === '1').length,
          cov: bands.map((b) => { const c = b.querySelector('.trv-cov'); return c ? c.textContent.trim() : '' }),
          /* 标着「上次认的」= 这一块这次没花钱（内容哈希命中缓存）。 */
          cached: bands.map((b) => [...b.querySelectorAll('.trv-tag')].some((t) => /上次认的/.test(t.textContent))),
          texts: bands.map((b) => { const t = b.querySelector('textarea'); return t ? t.value : '' }),
          errs: bands.map((b) => { const e = b.querySelector('.trv-err'); return e ? e.textContent.trim() : '' }),
        }
      })()`)
      if (!r) return null
      const line = `    ${r.n - r.pend}/${r.n} 块认完 · ${Math.round((Date.now() - t0) / 1000)}s`
      if (line !== lastLine) {
        console.log(line)
        lastLine = line
      }
      return r.pend === 0 && r.n > 0 ? r : null
    },
    { timeout: 15 * 60 * 1000, every: 1500, what: '所有块认完' }
  )
  if (!review.ok) throw new Error('识别超时（15 分钟）')
  const rv = review.value
  const failed = rv.errs.map((e, i) => [i, e]).filter(([, e]) => e)
  console.log('  ── 转录结果 ──')
  rv.cov.forEach((c, i) => console.log(`    第 ${i + 1} 块：${c || '（没报）'}${rv.cached[i] ? '（上次认的，这块没花钱）' : ''}`))
  /* `--shots`：把每一块的原图抠出来（校对时的裁判）。一次取一张 ——
     一次全取回来是几 MB 的 base64，CDP 那条消息会难产。 */
  if (SHOTS) {
    const dir = path.join(ROOT, '.cache', 'shots')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < rv.n; i++) {
      const src = await s.eval(`(() => { const im = document.querySelectorAll('.trv-img img')[${i}]; return im ? String(im.getAttribute('src') || '') : '' })()`)
      const m = /^data:image\/png;base64,(.+)$/.exec(String(src))
      if (!m) {
        console.log(`  第 ${i + 1} 块的图没取到`)
        continue
      }
      const file = path.join(dir, `${stem}-block${i + 1}.png`)
      fs.writeFileSync(file, Buffer.from(m[1], 'base64'))
      console.log(`  图：${path.relative(ROOT, file)}（${Math.round(fs.statSync(file).size / 1024)} KB）`)
    }
  }

  if (failed.length) {
    /* 纪律③：认错一块就停 —— 半份草稿比没有更坏。 */
    console.log('  ✗ 有块没认出来，**一个字都不写**：')
    for (const [i, e] of failed) console.log(`    第 ${i + 1} 块：${e}`)
    await s.key('Escape', 'Escape', 27)
    throw new Error('已中止（盘上什么都没变）')
  }

  if (!YES) {
    console.log('  （没给 --yes）认到的字：')
    rv.texts.forEach((t, i) => console.log(`  ── 第 ${i + 1} 块 ──\n${t}\n`))
    await s.key('Escape', 'Escape', 27)
    console.log('  到此为止，**没写盘**。想真覆盖就加 --yes 再跑一次。')
  } else {
    /* ── 覆盖之前先留一份 ────────────────────────────────────────────── */
    if (fs.existsSync(notePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const kept = path.join(ROOT, '.cache', 'lost-found', `${stamp}__${path.basename(boardDir)}__${path.basename(notePath)}`)
      fs.mkdirSync(path.dirname(kept), { recursive: true })
      fs.copyFileSync(notePath, kept)
      console.log(`  旧的那份先留了一份：${path.relative(ROOT, kept)}`)
    }
    const before = fs.existsSync(notePath) ? fs.statSync(notePath).mtimeMs : 0

    /* ── 校对完了 → 第二趟（结构整理）→ 撞名问话 → 落盘 ──────────────── */
    const okBtn = await s.eval(`(() => {
      const b = [...document.querySelectorAll('.trv .wp-acts button')].find((x) => /校对完了/.test(x.textContent))
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (!okBtn) throw new Error('找不到「校对完了」那颗按钮')
    await s.mouse(okBtn.x, okBtn.y)
    console.log('  结构整理那一趟（纯文本，几秒到几十秒）…')

    /* 落盘路上可能撞上"已经有一条笔记了"那条问话 —— 点「覆盖它」。 */
    const done = await until(
      async () => {
        const ask = await s.eval(`(() => {
          const d = document.querySelector('.ask')
          if (!d || !d.querySelector('.ask-choices')) return null
          const b = [...d.querySelectorAll('.ask-choice')].find((x) => ((x.querySelector('b') || {}).textContent || '').includes('覆盖'))
          if (!b) return null
          const r = b.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`)
        if (ask) {
          console.log('  撞名了 → 点「覆盖它」')
          await s.mouse(ask.x, ask.y)
          return null
        }
        try {
          return fs.statSync(notePath).mtimeMs > before ? fs.readFileSync(notePath, 'utf8') : null
        } catch {
          return null
        }
      },
      { timeout: 4 * 60 * 1000, every: 800, what: '草稿落盘' }
    )
    if (!done.ok) throw new Error('等不到草稿落盘（4 分钟）')

    const md = done.value
    console.log('  ── 落盘的草稿 ──────────────────────────────────────────')
    console.log(md.split('\n').map((l) => '  ' + l).join('\n'))
    const says = md.split('\n').filter((l) => l.includes('〔机器整理〕')).length
    console.log(`  ────────────────────────────────────────────────────────`)
    console.log(`  小节 ${(md.match(/^## /gm) || []).length} 个 · 机器整理 ${says} 段 · 一共 ${md.length} 字`)
    const errs = s.errors()
    if (errs.length) console.log('  ⚠ 页面里有 JS 报错：' + errs.slice(0, 3).join(' | '))
  }
} catch (e) {
  console.error('  ✗ ' + ((e && e.message) || e))
  process.exitCode = 1
} finally {
  kill()
  /* 浏览器/服务的日志里有用的那几行直接打出来（识别失败的真原因常常只在这儿）。 */
  const log = serverLog.join('')
  const tail = log.split('\n').filter((l) => /\[手写识别\]|\[整板转录\]|\[结构整理\]|失败/.test(l)).slice(-8)
  if (tail.length) {
    console.log('  ── 服务端日志 ──')
    for (const l of tail) console.log('    ' + l.trim())
  }
  if (KEEP) console.log('  （--keep：浏览器和服务的收尾交给你自己）')
}
