// studyhelper 本地服务：把 data/ 目录里的纯文本文件当成数据库用。
// 没有任何第三方依赖，只用 node 内置模块。Ctrl+C 关闭。
//
// ── 关掉浏览器标签页 = 服务自己停（看这里）──
// 页面每 HEARTBEAT_MS 发一次 /api/heartbeat；只要心跳停了（标签页关了、
// 浏览器崩了、强杀了），超过 AUTO_EXIT_MS 就自己退出。这样你不用"先关服务"。
// 两条防误杀的规矩：
//   ① 从没收到过心跳时**永不退出** —— 于是命令行 curl、自检脚本、npm run dev 都不受影响；
//   ② 超时给得比较宽（15 秒），不跟"切标签、标签卡一下"较劲。
// 想要老行为（常驻不自动退）：--no-auto-exit，或环境变量 STUDYHELPER_AUTO_EXIT=0。
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { callProvider, loadConfig, publicStatus, saveConfig, testProvider } from './server-ocr.js'
import { extractFilePart, extractTextPart } from './src/lib/multipart.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const DEV = argv.includes('--dev')
const NO_OPEN = argv.includes('--no-open')
const PORT = Number(process.env.STUDYHELPER_PORT || (DEV ? 5178 : 5177))
const HOST = '127.0.0.1'

/* 自动退出：见文件头的说明。要关掉就用 --no-auto-exit 或 STUDYHELPER_AUTO_EXIT=0 */
const AUTO_EXIT = !argv.includes('--no-auto-exit') && process.env.STUDYHELPER_AUTO_EXIT !== '0'
const AUTO_EXIT_MS = Number(process.env.STUDYHELPER_AUTO_EXIT_MS || 15000) // 心跳断多久之后退出
const BYE_GRACE_MS = 2500 // 页面说"再见"后的宽限期（为了 F5 刷新不自杀）
const WATCH_TICK_MS = 2000 // 多久检查一次

let lastHeartbeat = 0 // 0 = 还从没收到过心跳 → 永不自动退出
let byeAt = 0 // 页面说了"再见"的时刻；宽限期结束还没心跳才真退
let shuttingDown = false

const DATA_DIR = path.join(__dirname, 'data')
const DIST_DIR = path.join(__dirname, 'dist')
const SRC_DIR = __dirname

const SAFE_NAME = /^[^\\/:*?"<>|]+\.md$/i

async function ensureData() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  })
  res.end(body)
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 8 * 1024 * 1024) throw new Error('文件太大（超过 8MB）')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// 二进制版本（手写识别要收 PNG）。和上面同一个体积上限。
async function readBodyBuffer(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('图片太大（超过 8MB）—— 白板上的笔迹不该有这个体积')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

// 原子写：先写临时文件再 rename，避免写一半断电留下坏文件
async function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid
  await fsp.writeFile(tmp, text, 'utf8')
  await fsp.rename(tmp, file)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

async function statOf(file) {
  try {
    const s = await fsp.stat(file)
    return s
  } catch {
    return null
  }
}

// 轮询式文件监视：把每个文件的 mtime 报给前端，前端发现变了就提示重载。
// 目的是让你可以用 VSCode 直接改 data/*.md，页面不打架。
const watchState = new Map()
async function snapshot() {
  const out = {}
  let names = []
  try {
    names = await fsp.readdir(DATA_DIR)
  } catch {
    return out
  }
  for (const n of names) {
    if (!SAFE_NAME.test(n)) continue
    const s = await statOf(path.join(DATA_DIR, n))
    if (s) out[n] = Math.floor(s.mtimeMs)
  }
  return out
}
async function tickWatch() {
  const snap = await snapshot()
  watchState.clear()
  for (const [k, v] of Object.entries(snap)) watchState.set(k, v)
}
setInterval(tickWatch, 700).unref?.()
tickWatch()

async function handleApi(req, res, url) {
  const p = url.pathname

  if (p === '/api/list' && req.method === 'GET') {
    /* 排序必须钉死：App 打开时载入列表里的第一个文件，
       而 localeCompare 的默认排序依赖运行环境的 ICU 数据——
       换个 Node 版本，"示例" 和 "zz · 模板" 谁在前就可能变，打开的文件也跟着变。 */
    const collator = new Intl.Collator('zh-Hans-CN', { usage: 'sort', numeric: true })
    const names = (await fsp.readdir(DATA_DIR).catch(() => []))
      .filter((n) => SAFE_NAME.test(n))
      .sort((a, b) => collator.compare(a, b))
    const files = []
    for (const n of names) {
      const s = await statOf(path.join(DATA_DIR, n))
      if (!s) continue
      const text = await fsp.readFile(path.join(DATA_DIR, n), 'utf8')
      const lines = text.split('\n')
      files.push({
        name: n,
        title: n.replace(/\.md$/i, ''),
        mtime: Math.floor(s.mtimeMs),
        size: s.size,
        nodes: lines.filter((l) => /^\s*-\s+\S/.test(l)).length,
      })
    }
    return sendJson(res, 200, { files, watch: Object.fromEntries(watchState) })
  }

  const m = p.match(/^\/api\/file\/(.+)$/)
  if (m) {
    const name = decodeURIComponent(m[1])
    if (!SAFE_NAME.test(name)) return sendJson(res, 400, { error: '非法文件名' })
    const file = path.join(DATA_DIR, name)

    if (req.method === 'GET') {
      const s = await statOf(file)
      if (!s) return sendJson(res, 404, { error: '文件不存在' })
      const text = await fsp.readFile(file, 'utf8')
      return sendJson(res, 200, { name, text, mtime: Math.floor(s.mtimeMs) })
    }

    if (req.method === 'PUT') {
      const body = await readBody(req)
      let text = body
      try {
        const j = JSON.parse(body)
        if (j && typeof j.text === 'string') text = j.text
      } catch {
        /* 直接当纯文本 */
      }
      await atomicWrite(file, text)
      const s = await statOf(file)
      return sendJson(res, 200, { ok: true, mtime: Math.floor(s.mtimeMs) })
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      const parsed = JSON.parse(body || '{}')
      const marker = parsed.marker || '\u0000NEW'
      const s = await statOf(file)
      if (!s) return sendJson(res, 404, { error: '文件不存在' })
      const text = await fsp.readFile(file, 'utf8')
      const merged = text.includes(marker) ? text.replace(marker, '') : text
      await atomicWrite(file, merged)
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 405, { error: '不支持的方法' })
  }

  if (p === '/api/new' && req.method === 'POST') {
    const body = await readBody(req)
    const parsed = JSON.parse(body || '{}')
    let name = String(parsed.name || '').trim()
    if (!name) return sendJson(res, 400, { error: '文件名不能为空' })
    if (!name.toLowerCase().endsWith('.md')) name += '.md'
    name = name.replace(/[\\/:*?"<>|]/g, '-')
    const file = path.join(DATA_DIR, name)
    if (fs.existsSync(file)) return sendJson(res, 409, { error: '同名文件已存在' })
    const text = typeof parsed.text === 'string' ? parsed.text : `# ${name.replace(/\.md$/i, '')}\n\n- 第一节\n  - \n`
    await atomicWrite(file, text)
    return sendJson(res, 200, { ok: true, name })
  }

  if (p === '/api/watch' && req.method === 'GET') {
    return sendJson(res, 200, { watch: Object.fromEntries(watchState) })
  }

  /* 页面活着的心跳。收到第一次之后，这项服务就"归"这个页面管了。
     心跳一律清掉 byeAt —— 页面回来了，之前那次告别作废。 */
  if (p === '/api/heartbeat' && (req.method === 'GET' || req.method === 'POST')) {
    lastHeartbeat = Date.now()
    byeAt = 0
    return sendJson(res, 200, { ok: true, autoExit: AUTO_EXIT, timeoutMs: AUTO_EXIT_MS })
  }

  /* 页面正在关（navigator.sendBeacon 发的）。不马上退，给 BYE_GRACE_MS 宽限：
     因为**按 F5 刷新也会触发 pagehide**，立刻退出就会把刷新中的页面弄死
     （实测会：页面重新加载的这几百毫秒里服务已经没了）。
     宽限期内收到心跳就作废；真关掉了，也就多活 2.5 秒。 */
  if (p === '/api/bye' && req.method === 'POST') {
    if (AUTO_EXIT && lastHeartbeat) {
      byeAt = Date.now()
      return sendJson(res, 200, { ok: true, bye: true })
    }
    return sendJson(res, 200, { ok: true, bye: false })
  }

  /* 自动退出这件事的内部状态。给排查用（也方便自检脚本断言）：
     看不清 lastHeartbeat / byeAt 的话，这类"什么时候退"的问题只能靠猜。 */
  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      autoExit: AUTO_EXIT,
      timeoutMs: AUTO_EXIT_MS,
      byeGraceMs: BYE_GRACE_MS,
      lastHeartbeat,
      byeAt,
      sinceHeartbeat: lastHeartbeat ? Date.now() - lastHeartbeat : null,
      shuttingDown,
    })
  }

  /* ─────────────── 手写识别 ───────────────
     密钥只存在 config/ocr.json（.gitignore 里排掉了），浏览器从来没见过它。
     这里只做四件事：报状态、存配置、体检、代理一次识别。
     真正的请求构造/错误分类在 server-ocr.js —— 那部分能用假服务整条测通。 */
  if (p === '/api/ocr/status' && req.method === 'GET') {
    const cfg = await loadConfig(__dirname)
    return sendJson(res, 200, { ok: true, ...publicStatus(cfg) })
  }

  if (p === '/api/ocr/config' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req)
    let patch = {}
    try {
      patch = JSON.parse(body || '{}')
    } catch {
      return sendJson(res, 400, { ok: false, error: '配置不是合法 JSON' })
    }
    // 只认我们知道的字段，别让前端随手塞东西进来
    const allow = ['enabled', 'provider', 'base', 'turbo', 'tokenHeader', 'token', 'dsBase', 'model']
    const clean = {}
    for (const k of allow) if (k in patch) clean[k] = patch[k]
    // 空字符串 = "我要清掉密钥"，这是合法操作，不能当成"没改"
    if (clean.token === '') clean.token = ''
    const cfg = await saveConfig(__dirname, clean)
    return sendJson(res, 200, { ok: true, ...publicStatus(cfg) })
  }

  if (p === '/api/ocr/test' && req.method === 'POST') {
    const cfg = await loadConfig(__dirname)
    const r = await testProvider(cfg)
    return sendJson(res, 200, r)
  }

  if (p === '/api/ocr' && req.method === 'POST') {
    const cfg = await loadConfig(__dirname)
    if (!cfg.enabled) return sendJson(res, 200, { ok: false, kind: 'no-key', error: '手写识别被关掉了（设置里可以打开）' })

    const raw = await readBodyBuffer(req)
    const part = extractFilePart(raw, req.headers['content-type'] || '')
    if (!part) {
      return sendJson(res, 200, {
        ok: false,
        kind: 'bad',
        error: '没收到图片（这里要的是 multipart/form-data，字段名 file）',
      })
    }
    const img = part.data
    /* 这一次认的是公式还是普通文字？字段是表单里的 mode（前端 FormData 里带的）。
       ★ 只认白名单里的两个值，别的一律当 formula —— 这个接口是给本机页面用的，
         但"参数没校验"从来不是好习惯。认不出来就走老路，行为可预测。 */
    const modeRaw = extractTextPart(raw, req.headers['content-type'] || '', 'mode')
    const mode = modeRaw === 'text' ? 'text' : 'formula'
    // 只收图片：这是个只给本机前端用的接口，但"顺手当文件上传器"这种事不该发生
    const magic = img.subarray(0, 4)
    const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47
    const isJpg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff
    if (!isPng && !isJpg) {
      return sendJson(res, 200, { ok: false, kind: 'bad', error: '收到的不是 PNG/JPEG 图片' })
    }

    const r = await callProvider(cfg, img, { mode })
    if (!r.ok) {
      console.log(`  [手写识别] 失败（${r.kind}）：${r.error}`)
      return sendJson(res, 200, { ok: false, kind: r.kind, error: r.error, httpStatus: r.httpStatus })
    }
    if (mode === 'text') {
      console.log(`  [手写美化] 认出文字：${String(r.text).slice(0, 70).replace(/\n/g, ' ⏎ ')}`)
      return sendJson(res, 200, {
        ok: true,
        mode,
        text: r.text,
        conf: r.conf,
        note: r.note || '',
        debug: { bytes: img.length, endpoint: cfg.provider === 'simpletex' ? (cfg.turbo ? 'turbo' : 'standard') : cfg.dsBase, requestId: r.requestId },
      })
    }
    console.log(`  [手写识别] 认出：${r.latex.slice(0, 70)}${r.conf != null ? '（置信度 ' + r.conf + '）' : ''}`)
    return sendJson(res, 200, {
      ok: true,
      mode,
      latex: r.latex,
      conf: r.conf,
      note: r.conf != null && r.conf < 0.6 ? '这次置信度偏低，多半得手动改两笔' : '',
      debug: { bytes: img.length, endpoint: cfg.turbo ? 'turbo' : 'standard', requestId: r.requestId },
    })
  }

  return sendJson(res, 404, { error: '未知接口' })
}

/* 从 multipart/form-data 里抠出那个文件。
 * 实现搬去了 src/lib/multipart.js —— 那里能在 node 里单独测（含二进制不被改写
 * 这条最关键的断言）。这里只留一个 import，别在这儿再抄一份。 */

/* 缓存策略。
 *
 * ⚠ 这里踩过一次：改了代码、`npm run build`、也确认服务端发的是新产物，
 *   但用户浏览器窗口里还是**几小时前的旧版**（工具条上少一个按钮、
 *   画布行为也不对），看起来像"功能没做"或者"画不了"。
 *   dist 里的 js/css 文件名是带内容哈希的，但 index.html 不是 ——
 *   浏览器照着旧的 index.html 去要旧的 js，而我们又把旧 js 缓存住了。
 *
 * 所以：**文字类资源一律 no-cache**（每次都回来问一句 ETag 变了没）。
 * 对本地单机服务来说，"回来问一句"就是同机一次内存查询，代价可以忽略；
 * 换来的是"改完刷新就生效"，不会再出现"明明改了却没有"。
 * 字体/图标是内容哈希命名的，可以放心长缓存。
 */
const CACHEABLE = new Set(['.woff', '.woff2', '.ttf', '.otf', '.png', '.jpg', '.svg', '.ico'])
function cacheHeaderFor(ext) {
  return CACHEABLE.has(ext) ? 'public, max-age=31536000, immutable' : 'no-cache'
}

async function serveStatic(req, res, url) {
  const roots = DEV ? [SRC_DIR] : [DIST_DIR]
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'

  // 生产模式下 index.html 在 dist/ 里
  for (const root of roots) {
    const file = path.join(root, rel)
    if (!file.startsWith(root)) continue
    const s = await statOf(file)
    if (s && s.isFile()) {
      const ext = path.extname(file).toLowerCase()
      return send(res, 200, await fsp.readFile(file), {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': cacheHeaderFor(ext),
      })
    }
  }

  // 页面路由回退
  if (!path.extname(rel)) {
    const base = DEV ? SRC_DIR : DIST_DIR
    const idx = path.join(base, 'index.html')
    const s = await statOf(idx)
    if (s) {
      return send(res, 200, await fsp.readFile(idx), {
        'Content-Type': MIME['.html'],
        'Cache-Control': 'no-cache',
      })
    }
  }

  return send(res, 404, 'not found: ' + rel, { 'Content-Type': 'text/plain; charset=utf-8' })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`)
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '')
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return await serveStatic(req, res, url)
  } catch (err) {
    console.error('[studyhelper] 请求出错:', err)
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) })
  }
})

await ensureData()

/* 收摊：先正常关（让在飞的请求写完），1.5 秒还没关干净就强退。
   强退是安全的：写文件走的是"先写临时文件再 rename"的原子写，
   所以最坏情况是这一秒的编辑没落盘，不会留下写坏的文件。 */
function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('')
  console.log(`  ${why} —— 服务自己停了。`)
  console.log('  数据都在 data/ 目录里，下次点桌面图标就回来。')
  console.log('')
  const force = setTimeout(() => process.exit(0), 1500)
  force.unref?.()
  server.close(() => {
    clearTimeout(force)
    process.exit(0)
  })
}

/* 心跳看门狗：只有"被页面认领过"（lastHeartbeat 非 0）才计时。
   从没收到过心跳 → 永不自动退出，于是命令行访问、自检脚本、npm run dev 都照常。 */
if (AUTO_EXIT) {
  setInterval(() => {
    if (!lastHeartbeat || shuttingDown) return
    // 页面明确说了"再见"：宽限 BYE_GRACE_MS 之后仍没心跳，才算真关掉
    if (byeAt && Date.now() - byeAt > BYE_GRACE_MS) {
      shutdown('浏览器标签页关了')
      return
    }
    // 兜底：标签页没打招呼就没了（浏览器崩了 / 被强杀）
    if (Date.now() - lastHeartbeat > AUTO_EXIT_MS) shutdown('浏览器标签页已经不在了')
  }, WATCH_TICK_MS).unref?.()
}

// Ctrl+C / 关黑窗口也走同一条收摊路径，输出一致
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try {
    process.on(sig, () => shutdown('收到关闭信号'))
  } catch {
    /* Windows 上有些信号注册不了，忽略 */
  }
}

// 端口被占：说明已经开着一个了，直接把浏览器指过去
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const target = DEV ? `http://localhost:5180/` : `http://${HOST}:${PORT}/`
    console.log(`\n  studyhelper 好像已经在跑了（端口 ${PORT} 被占用）。`)
    console.log(`  直接打开：${target}\n`)
    if (!NO_OPEN) openBrowser(target)
    process.exit(0)
  }
  console.error(err)
  process.exit(1)
})

server.listen(PORT, HOST, async () => {
  const target = DEV ? `http://localhost:5180/` : `http://${HOST}:${PORT}/`
  console.log('')
  console.log('  studyhelper 过手总结台')
  console.log('  ─────────────────────────────────────')
  console.log(`  数据目录  ${DATA_DIR}`)
  console.log(`  地址      ${target}`)
  if (AUTO_EXIT) {
    console.log('  自动关闭  关掉浏览器标签页就自动停（浏览器崩了的话最迟 ' + Math.round(AUTO_EXIT_MS / 1000) + ' 秒）')
  } else {
    console.log('  自动关闭  已关掉（--no-auto-exit）')
  }
  console.log('  手动关闭  Ctrl + C（或直接关掉这个黑窗口）')
  console.log('')
  if (!DEV && !NO_OPEN) openBrowser(target)
})

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    /* 打不开就算了，用户自己点链接 */
  }
}
