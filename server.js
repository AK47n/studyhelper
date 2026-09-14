// studyhelper 本地服务：把 data/ 目录里的纯文本文件当成数据库用。
// 没有任何第三方依赖，只用 node 内置模块。Ctrl+C 关闭。
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const DEV = argv.includes('--dev')
const NO_OPEN = argv.includes('--no-open')
const PORT = Number(process.env.STUDYHELPER_PORT || (DEV ? 5178 : 5177))
const HOST = '127.0.0.1'

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

  return sendJson(res, 404, { error: '未知接口' })
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
      })
    }
  }

  // 页面路由回退
  if (!path.extname(rel)) {
    const base = DEV ? SRC_DIR : DIST_DIR
    const idx = path.join(base, 'index.html')
    const s = await statOf(idx)
    if (s) return send(res, 200, await fsp.readFile(idx), { 'Content-Type': MIME['.html'] })
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
  console.log('  关闭      Ctrl + C（或直接关掉这个黑窗口）')
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
