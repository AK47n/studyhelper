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
import { CONFIG_KEYS, callProvider, loadConfig, lookupInput, parseAskHistory, publicStatus, saveConfig, secondImagePart, testProvider } from './server-ocr.js'
import { extractFilePart, extractFilePartNamed, extractTextPart } from './src/lib/multipart.js'
/* 资料（PDF/PPT 上传、PPT→PDF 转换、"这份是不是 PPT 转来的"）：依赖和 COM 那点事收在 server-docs.js。 */
import { DOC_MAX_BYTES, DOC_MIME, docOrigin, forgetDeckPage, forgetDeckPages, readDeckPages, saveUpload, writeDeckPage } from './server-docs.js'
/* 板文件里资料 path 的形状（`.资料/xxx.pdf` / `.资料/xxx.png`）—— 前端用的同一份规矩。 */
import { docExtOf, isDocPath } from './src/lib/docs.js'
/* 「作业辅导」一次最多问几页 —— **那个数住在前端那份纯口径里**（src/lib/homework.js），
   server.js 和窗口读的是同一个。在这儿另写一个 3 的话，改一处就会出现
   "前端发 4 页、服务端只收 3 页"这种不出声的少一张图。 */
import { HW_MAX_PAGES } from './src/lib/homework.js'
/* 导出：**依赖被关在 server-export.js 里**（那个文件才 import katex）。
   server.js 自己的底线是"没有任何第三方依赖"，别在这儿直接 import 排版模块。 */
import { exportNoteHtml, makeChartPdf, warmUp as warmUpExport } from './server-export.js'
import { collectFontFiles } from './src/lib/fonts.js'
import {
  EXPORT_DIR,
  MAX_DEPTH,
  baseName,
  compareRelPaths,
  exportPathFor,
  isUnder,
  normalizeRel,
  parentPath,
  pathTitle,
  sanitizeRel,
  uniqueRelName,
} from './src/lib/paths.js'

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

/* 导出文档里的字体栈。**和界面里那一套分开**：
 * 界面用的是深色的 UI 字体栈（Segoe UI 那种），而导出文档是给"读一篇文章"用的
 * —— 中文优先用楷体/霞鹜文楷（有笔势、但每个字都规矩），退到系统黑体。
 * 公式那一栈交给 KaTeX 的名字 + 衬线兜底（内联进来的字体就挂在 KaTeX_Main 这些名字上）。 */
const EXPORT_BODY_FAMILY =
  "'LXGW WenKai', '霞鹜文楷', 'KaiTi', '楷体', 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"
const KATEX_FONT_FAMILY = "'KaTeX_Main', 'Times New Roman', 'Songti SC', serif"

/* 把 `目录` 和 `短名` 拼成一条相对路径（只在服务端拼**盘上读到的**名字时用）。
 * ⚠ 前端不要有第二个"拼路径"的实现 —— 那个在 paths.js 的 joinPath 里。 */
function joinRels(dir, name) {
  return dir ? dir + '/' + name : name
}

/* ── data/ 里的名字（2026-09-17 起带分层）──────────────────────────────────
 * 从前这里只有一条正则 `SAFE_NAME` —— 因为文件是**平**的，一个名字就是全部。
 * 现在文件可以放进子目录（`data/大物/电磁学/board-第一章.md`），于是"什么叫一个
 * 合法路径"必须在**三处**同时成立（收请求、拼绝对路径、列目录），而三份各写一遍
 * 正是这个仓库演过两次的坑。所以规矩搬进了 `src/lib/paths.js`（前端也用它），
 * 这里只剩两个动作：**归一化**（不合法就 400）和**拼绝对路径再复核一次**。
 * 两道闸是故意的：第一道管"什么名字算合法"，第二道管"拼出来的路径跑没跑出 data/"。 */
function resolveInData(rel) {
  const root = path.resolve(DATA_DIR)
  const abs = path.resolve(root, rel)
  return abs === root || abs.startsWith(root + path.sep) ? abs : null
}

/* data/ 底下所有 `.md` 文件（**递归**）+ 所有目录，名字都是相对 data/ 的路径。
 * ★ 跳过以 `.` 开头的：`.git` 之类不是"我的笔记"，一次列表几千个对象也没意义。
 *   ⚠ **导出的目录（`.导出`）就是靠这一条不出现的**（见 paths.js 的 EXPORT_DIR）。
 *     那里全是 `.html`，左栏不认；不加点的话会在树里露出一层点开什么都没有的目录。
 *     所以这一条不是"顺手跳过"，是"导出那个功能依赖它"——别顺手删掉。
 * ★ 目录名不合法（外来的怪名字）就**整枝跳过**，不报错 —— 那是别人的目录，
 *   不是我们的数据，硬塞进列表只会让左栏出现一行点不开的东西。 */
async function walkData(dir = DATA_DIR, prefix = '', out = { files: [], folders: [] }, depth = 0) {
  if (depth > MAX_DEPTH) return out
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      const d = normalizeRel(rel, { file: false })
      if (!d) continue
      out.folders.push(d)
      await walkData(path.join(dir, e.name), d, out, depth + 1)
    } else if (e.isFile()) {
      const f = normalizeRel(rel)
      if (f) out.files.push(f)
    }
  }
  return out
}

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

/* `decodeURIComponent` 遇到坏转义（`%zz`）会**抛**，抛进 handleApi 就是 500 ——
   而那本来就该是一句 400。解不出来就把原样串交回去，让 normalizeRel 去拒它。 */
function safeDecode(s) {
  try {
    return decodeURIComponent(String(s))
  } catch {
    return String(s)
  }
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

// 二进制版本（手写识别要收 PNG；资料上传收 PDF/PPT —— 上限和报错的话各给各的）。
async function readBodyBuffer(req, limit = 8 * 1024 * 1024, tooBig = '图片太大（超过 8MB）—— 白板上的笔迹不该有这个体积') {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error(tooBig)
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
  const { files: names } = await walkData()
  for (const n of names) {
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
/* ⚠ 用变量存着这个定时器，而不是 `setInterval(...)` 一扔了之：
   删东西那一步要**先停掉它**（见 /api/delete 里那段），不然它会拿着
   "删除发生之前"读到的目录清单把刚删掉的文件又塞回 watch 快照里。 */
let watchTimer = setInterval(tickWatch, WATCH_TICK_MS)
watchTimer.unref?.()
tickWatch()

/* ── 把一样东西送进**回收站**（2026-09-21，给 /api/delete 用）────────────────
 *
 * 为什么要单独写一个函数：这段代码里有四件事都是"踩过才知道"的 ——
 *   ① `fs.rmSync` **不进回收站**，删错了就永久没了。这个仓库在 config/ 上
 *      已经吃过一次同样的亏（README 那条"清理逻辑先问'删的是谁的'"）。
 *   ② node 里**没有**跨平台的回收站 API，所以只能借系统那一套：
 *      Windows 上用 Shell.Application 的 COM（PowerShell 的
 *      Microsoft.VisualBasic 那条要 `Add-Type` 编译，node 里没有）。
 *   ③ COM 那条路**报错的方式很阴**：`MoveHere` 失败（回收站被禁用、网络盘、
 *      或者路径太长）时**不一定抛**，可能只是"什么都没发生" ——
 *      所以不能只看它有没有抛，得**回头确认源路径真的没了**。
 *      只看异常的话，症状是"界面说删好了、文件还在盘上"，用户下次打开又看见它。
 *   ④ 参数必须用**绝对路径**，而且 COM 对反斜杠敏感（`/` 有时不认）。
 *   返回 true = 已经进回收站；false = **东西还在原地**（调用方必须拒绝这次删除）。
 */
async function recycle(abs) {
  /* ★ 先确认"它本来在"：不在的话这次调用什么都没干，不能回 true。
     谁会在意这个 —— 万一以后有人把 /api/delete 里那道 404 挪走，
     回 true 就成了"界面说删掉了、其实那东西从来没存在过"，
     而这两件事在用户眼里分不出（都是"界面上没了"），
     等哪天它又冒出来，就完全解释不清了。 */
  if (!fs.existsSync(abs)) return false
  const target = path.resolve(abs).replace(/\//g, '\\')
  if (process.platform === 'win32') {
    /* 单引号里只做两处转义（`'` 变 `''`）—— 路径里出现单引号是合法的
       （Windows 文件名允许它），不转义就会把整段 PowerShell 弄坏。 */
    const ps = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p='${target.replace(/'/g, "''")}';` +
        `try{$sh=New-Object -ComObject Shell.Application;` +
        `$it=$sh.Namespace(0).ParseName($p);` +
        `if($it){$it.InvokeVerb('delete')}}catch{}`,
    ]
    await new Promise((resolve) => {
      let done = false
      const fin = () => {
        if (!done) {
          done = true
          resolve()
        }
      }
      try {
        const ch = spawn('powershell.exe', ps, { windowsHide: true, stdio: 'ignore' })
        ch.on('close', fin)
        ch.on('error', fin)
        /* 超时兜底：COM 偶尔会卡在弹窗上（比如"这个文件正在使用"）——
           卡住时**不能**当成删成功，所以只是放弃等待（下面还会回头确认盘上）。 */
        setTimeout(fin, 15000)
      } catch {
        fin()
      }
    })
  } else if (process.platform === 'darwin') {
    await runQuiet('osascript', ['-e', `tell application "Finder" to delete POSIX file "${target}"`])
  } else {
    /* Linux 没有统一的回收站命令（gio / trash-cli 都可能没装）——
       试一遍，不行就老实回 false（**不退化成 rm**：宁可删不掉）。 */
    const okGio = await runQuiet('gio', ['trash', target])
    if (!okGio) await runQuiet('trash-put', [target])
  }
  /* ★ 判据只有一个：**源路径还在不在**。不看返回码、不看异常、不看上面那条命令
     说了什么 —— "它到底走没走"才是这件事的全部（④）。 */
  return !fs.existsSync(abs)
}

/** 跑一个命令、只关心"起没起来 + 退出码是不是 0"（不抓输出、不抛）。 */
function runQuiet(cmd, args) {
  return new Promise((resolve) => {
    let done = false
    const fin = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const ch = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
      ch.on('error', () => fin(false))
      ch.on('close', (code) => fin(code === 0))
      setTimeout(() => fin(false), 15000)
    } catch {
      fin(false)
    }
  })
}

async function handleApi(req, res, url) {
  const p = url.pathname

  if (p === '/api/list' && req.method === 'GET') {
    /* 递归列 data/：`files[].name` 是**相对 data/ 的路径**（根上的老文件里没有 `/`），
       `folders` 是同一套口径的目录列表。左栏那棵树由前端按这两样拼（paths.js 的
       buildFolderTree）—— 服务端只负责"盘上有什么"，不负责"怎么摆"。
       ★ 排序必须钉死：App 打开时载入列表里的第一个文件，而 localeCompare 的默认
         排序依赖运行环境的 ICU 数据 —— 换个 Node 版本，"示例"和"zz · 模板"谁在前
         就可能变，打开的文件也跟着变。比较器在 paths.js 里（自检里能断言）。 */
    const { files: names, folders } = await walkData()
    names.sort(compareRelPaths)
    folders.sort(compareRelPaths)
    const files = []
    for (const n of names) {
      const s = await statOf(path.join(DATA_DIR, n))
      if (!s) continue
      const text = await fsp.readFile(path.join(DATA_DIR, n), 'utf8')
      const lines = text.split('\n')
      files.push({
        name: n,
        title: pathTitle(n),
        folder: parentPath(n),
        mtime: Math.floor(s.mtimeMs),
        size: s.size,
        nodes: lines.filter((l) => /^\s*-\s+\S/.test(l)).length,
      })
    }
    return sendJson(res, 200, { files, folders, watch: Object.fromEntries(watchState) })
  }

  const m = p.match(/^\/api\/file\/(.+)$/)
  if (m) {
    const name = normalizeRel(safeDecode(m[1]))
    const file = name && resolveInData(name)
    if (!file) return sendJson(res, 400, { error: '非法文件名' })

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
    /* ★ 这里用 sanitizeRel 而不是 normalizeRel：名字是**用户手打的**，
       打错一个字符就弹"文件名非法"太刻薄（坏字符换成 `-`、没写 `.md` 就补上）。
       穿越（`..` / 绝对路径 / 盘符）仍然一律拒 —— 那不是"打错"，是"想跑到 data/ 外面"，
       所以**修也不修**（回一句话比猜他要写到哪儿安全）。 */
    const rawWant = String(parsed.name == null ? '' : parsed.name).trim()
    const name = sanitizeRel(rawWant)
    if (!name) {
      return sendJson(res, 400, {
        error: rawWant ? '这个路径不能用（一段里不许有 `..`，也不许跑到 data/ 外面）' : '文件名不能为空',
      })
    }
    const file = resolveInData(name)
    if (!file) return sendJson(res, 400, { error: '非法路径' })
    if (fs.existsSync(file)) {
      /* `code` 是给**前端判断**用的机器信号（2026-09-19）：撞名之后要给用户三条路
         （覆盖 / 换个名字 / 算了），而"是不是撞名"不能靠匹配那句人话 ——
         那句话随时会为了更像人话而改，字面匹配迟早失配，失配的表现是
         **"点了覆盖却什么都没发生"**（前端以为是别的错误，走了报错那条路）。 */
      return sendJson(res, 409, { error: '同名文件已存在', code: 'exists', name })
    }
    // 分层存储：写之前先把这一层目录建出来（`大物/电磁学/第一章` 直接就能用）
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const text = typeof parsed.text === 'string' ? parsed.text : `# ${pathTitle(name)}\n\n- 第一节\n  - \n`
    await atomicWrite(file, text)
    return sendJson(res, 200, { ok: true, name })
  }

  /* 建一层目录（左栏的「＋ 文件夹」/ 打路径建板时用得上）。
     已经存在不算错 —— 用户要的是"这一层在"，不是"必须由我建出来"。 */
  if (p === '/api/mkdir' && req.method === 'POST') {
    const body = await readBody(req)
    const parsed = JSON.parse(body || '{}')
    const rel = sanitizeRel(parsed.path, { file: false })
    if (!rel) return sendJson(res, 400, { error: '这一层叫什么？' })
    const abs = resolveInData(rel)
    if (!abs) return sendJson(res, 400, { error: '非法路径' })
    const existed = fs.existsSync(abs)
    if (!existed) await fsp.mkdir(abs, { recursive: true })
    return sendJson(res, 200, { ok: true, path: rel, existed })
  }

  /* 改名 / 换一层（左栏拖一下、或者"移到…"手打一个路径）。
   * `to` 是一个**已经存在的目录**时，就挪进去、名字不动（拖到某一层就是这个形状）。
   * 两条必须拒的：
   *   ① 目标已经存在 —— 覆盖会**静默吃掉**一个文件，而用户以为自己在整理；
   *   ② 把一层挪进它自己（或它的子孙）—— 那是把整棵子树塞进自己肚子里，
   *      Windows 上会留下一个打不开的目录。 */
  if (p === '/api/move' && req.method === 'POST') {
    const body = await readBody(req)
    const parsed = JSON.parse(body || '{}')
    const from = normalizeRel(parsed.from, { file: false })
    const fromAbs = from && resolveInData(from)
    if (!fromAbs || !fs.existsSync(fromAbs)) return sendJson(res, 404, { error: '要移动的东西不在了' })
    const isDir = fs.statSync(fromAbs).isDirectory()

    const rawTo = String(parsed.to == null ? '' : parsed.to).trim()
    const toAsDir = normalizeRel(rawTo, { file: false })
    const toAbsAsDir = toAsDir && resolveInData(toAsDir)
    const intoExistingDir = !!(toAbsAsDir && fs.existsSync(toAbsAsDir) && fs.statSync(toAbsAsDir).isDirectory())

    const to = intoExistingDir ? baseName(from) : null
    const target = intoExistingDir ? normalizeRel(toAsDir + '/' + to, { file: !isDir }) : normalizeRel(rawTo, { file: !isDir })
    const targetAbs = target && resolveInData(target)
    if (!target || !targetAbs) return sendJson(res, 400, { error: '移到哪儿？（要写一个路径）' })
    if (target === from) return sendJson(res, 200, { ok: true, from, to: target, moved: false })
    if (isDir && (target === from || target.startsWith(from + '/'))) {
      return sendJson(res, 400, { error: '不能把这一层挪进它自己里面' })
    }
    if (fs.existsSync(targetAbs)) return sendJson(res, 409, { error: '那边已经有个同名的了' })
    await fsp.mkdir(path.dirname(targetAbs), { recursive: true })
    await fsp.rename(fromAbs, targetAbs)
    return sendJson(res, 200, { ok: true, from, to: target, moved: true })
  }

  /* ── 删掉一个文件 / 一整层（左栏行尾那颗「删除」，2026-09-21）──────────────
   *
   * 用户要的是"整理的时候能把不要的丢掉"（分层能建出来，就得能拆掉 ——
   * 只建不拆的话，分错的那一层永远挂在树里）。
   *
   * ── 三道闸，缺一条都可能吃掉不该吃的东西 ────────────────────────────────
   *   ① `normalizeRel` + `resolveInData`：和别的接口同一套（穿越 / 绝对路径 /
   *      盘符一律拒）。**别在这儿另写一条正则**。
   *   ② **根目录不能删**：`rel === ''` 是"整个 data/"—— `resolveInData('')`
   *      会把 DATA_DIR 原样还回来，不挡的话一次请求就把用户所有笔记删了。
   *      这是这个接口最危险的一格，所以它单独写一条、写在最前面。
   *   ③ **`.` 开头的拒**：`normalizeRel` 放它过去（它对点开头的名字没有意见），
   *      但 `data/.资料` 是资料的存储目录、`.导出` 是导出产物、`.git` 是版本库 ——
   *      它们**不出现在左栏里**，所以左栏永远没有理由请求删它们。
   *      这一条挡的是"手写一个请求"和"以后有人往左栏加了点开头的行"。
   *
   * ── 空目录 vs 带东西的目录 ──────────────────────────────────────────────
   *   目录里还有东西时必须显式带 `force: true`，不然回 409 附上"里面有几个"。
   *   为什么要这个中间态：左栏的「删除」是**一颗行尾小按钮**，手指滑过去点一下的代价
   *   极低；而"删掉一整层"可能一次带走几十张板。让调用方先把数量说出来、用户点头，
   *   比一个点了就递归的路要安全得多（`/api/list` 的 `nodes` 字段前端本来就有，
   *   报个数不用多绕一趟）。
   *
   * ── 为什么走**回收站**而不是 `fs.rmSync` ────────────────────────────────
   *   `rmSync` **不进回收站**，删错了就是永久没了（这个仓库在 config/ 上已经吃过一次
   *   同样的亏，见 README）。删文件、删目录都不难，但"手滑"恰恰是删东西最常见的姿势
   *   —— 所以这里宁可麻烦一点。Windows 上唯一的办法是 Shell.Application 的 COM
   *   （PowerShell 的 Microsoft.VisualBasic 那条要 Add-Type 编译，node 里没有）。
   *
   * ⚠ **送不进回收站就拒绝，绝不退化成 `fs.rm`**：「删了个寂寞」是烦人，
   *   而"以为进了回收站、其实永久删了"是不可逆的。宁可回一句"这个删不了，
   *   请去资源管理器里删"，让用户知道东西还在。 */
  if (p === '/api/delete' && req.method === 'POST') {
    const body = await readBody(req)
    let parsed = {}
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      return sendJson(res, 400, { error: '请求不是合法 JSON' })
    }
    const rawWant = String(parsed.path == null ? '' : parsed.path).trim().replace(/\\/g, '/')
    const force = parsed.force === true

    if (!rawWant) return sendJson(res, 400, { error: '删哪一个？（路径不能为空）' })
    /* ★ 闸②：根目录。放在 normalizeRel **之前** —— 它归一化之后会把两侧的空段丢掉，
       `'/'` 和 `''` 到这里长得一样，而这两个都该拒。 */
    if (rawWant.replace(/^\/+|\/+$/g, '') === '') {
      return sendJson(res, 400, { error: 'data/ 这一层不能删（那是所有笔记的家）' })
    }
    /* 目录不带 `.md`、文件带 —— 由最后一段是不是 `.md` 自己说，调用方不用多传一个字段。 */
    const file = /\.md$/i.test(rawWant)
    const rel = normalizeRel(rawWant, { file })
    if (!rel) return sendJson(res, 400, { error: '这个路径不能用' })
    /* ★ 闸③：点开头的东西不在左栏里，左栏就没有理由请求删它 */
    if (rel.split('/').some((seg) => seg.startsWith('.'))) {
      return sendJson(res, 403, { error: '这个删不了（它以 . 开头，不是左栏里的东西）' })
    }
    const abs = resolveInData(rel)
    if (!abs) return sendJson(res, 400, { error: '非法路径' })
    let st = null
    try {
      st = await fsp.stat(abs)
    } catch {
      st = null
    }
    if (!st) return sendJson(res, 404, { error: '这个东西已经不在了（可能在别处删过了）' })

    const isDir = st.isDirectory()
    let inside = 0
    if (isDir) {
      /* 递归数一遍里面有几样东西（文件和目录都算）。带东西又没 `force` 就回 409 ——
         `count` / `samples` 是给前端"问一句"用的（和 /api/new 撞名回 `code:'exists'`
         一条道理：人话随时会改，机器判据不能靠字面匹配）。 */
      const walk = async (d) => {
        let ents = []
        try {
          ents = await fsp.readdir(d, { withFileTypes: true })
        } catch {
          return 0
        }
        let n = 0
        for (const e of ents) {
          if (e.name.startsWith('.')) continue
          n += 1
          if (e.isDirectory()) n += await walk(path.join(d, e.name))
        }
        return n
      }
      inside = await walk(abs)
      if (inside > 0 && !force) {
        let samples = []
        try {
          samples = (await fsp.readdir(abs)).filter((n) => !n.startsWith('.')).slice(0, 6)
        } catch {
          samples = []
        }
        return sendJson(res, 409, { error: '这一层里还有东西', code: 'not-empty', path: rel, count: inside, samples })
      }
    }

    /* 写盘之前先取消挂起 —— 删完要立刻把列表和 watch 快照对齐，
       不然左栏那一行可能还留着（`/api/watch` 也说它还在），点一下就是 404。 */
    clearInterval(watchTimer)
    let stashed = true
    try {
      stashed = await recycle(abs)
    } catch {
      stashed = false
    } finally {
      watchTimer = setInterval(tickWatch, WATCH_TICK_MS)
      watchTimer.unref?.()
      await tickWatch()
    }
    if (!stashed) {
      return sendJson(res, 500, {
        error: '删不了这个（回收站不收：可能是网络盘、或者盘上没启用回收站）—— 东西还在原地，请去资源管理器里删',
        code: 'no-recycle',
      })
    }
    return sendJson(res, 200, { ok: true, path: rel, dir: isDir, count: inside })
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

  /* ─────────────── 导出（把笔记变成能发出去的一个网页）───────────────
   *
   * 用户要的是"把笔记发给同学 / 发到网上"。笔记里的 `$…$`、`[[B]]`、缩进
   * **只有这个程序认得**，所以导出不是复制文件，是翻译（见 lib/export-html.js）。
   *
   * 这一半只做两件事：**读原文** + **按浏览器给的字体清单把字体字节读出来**。
   * 真正的排版在 export-html.js（纯函数、能在 node 里断言）。
   *
   * ★ 字体清单为什么由**浏览器**发过来：挑字体要 canvas 量（见 lib/fonts.js），
   *   服务端没有 canvas。所以浏览器先量好"要用哪几种字体"，随请求带上来；
   *   这里只负责 `listFiles / readFile`，不猜。清单缺了/是空的也照样导 ——
   *   公式退到系统衬线体，丑一点但能看（宁可丑，不可丢）。
   */
  if (p === '/api/export' && req.method === 'POST') {
    const body = await readBody(req)
    let parsed = {}
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      return sendJson(res, 400, { error: '请求不是合法 JSON' })
    }
    const name = normalizeRel(parsed.name)
    const file = name && resolveInData(name)
    if (!file) return sendJson(res, 400, { error: '非法文件名' })
    const s = await statOf(file)
    if (!s) return sendJson(res, 404, { error: '这份笔记不在了（可能在别处改过名）' })

    const text = await fsp.readFile(file, 'utf8')

    /* 要嵌哪几种公式字体：**浏览器量的**（它读 document.fonts 那本账，见 lib/fonts.js）。
       收成一行 `KaTeX_Main|KaTeX_Math`，服务端只认白名单里的名字 ——
       别让请求体指挥我们去读任意文件。 */
    const wanted = new Set(
      String(parsed.fonts || '')
        .split('|')
        .map((x) => x.trim())
        .filter((x) => /^KaTeX_[A-Za-z0-9]+$/.test(x))
    )
    let fonts = {}
    if (wanted.size) {
      const assetDir = path.join(DIST_DIR, 'assets')
      fonts = collectFontFiles(wanted, {
        listFiles: () => {
          try {
            return fs.readdirSync(assetDir)
          } catch {
            return []
          }
        },
        readFile: (n) => fs.readFileSync(path.join(assetDir, n)),
      })
    }

    /* 导出文件写在**源所在那一层的 `.导出/`** 里（见 paths.js 的 EXPORT_DIR）。
       用户 2026-09-17 定的：桌面不加文件夹，文件跟着笔记走、跟着 Git 一起备份。 */
    const want = exportPathFor(name)
    const wantAbs = resolveInData(want)
    if (!wantAbs) return sendJson(res, 400, { error: '算不出导出到哪儿' })

    /* ★ **绝不覆盖**：已经有了就往后排 `名字 2.html`。
       静默覆盖会吃掉上一份导出，而用户以为"我更新了"——那和"每天一条假 diff"
       是同一类病（见 board.js 的 round 那段注释）。 */
    let target = want
    if (fs.existsSync(wantAbs)) {
      const taken = []
      const dirAbs = path.dirname(wantAbs)
      try {
        for (const n of fs.readdirSync(dirAbs)) taken.push(joinRels(parentPath(want), n))
      } catch {
        /* 读不到目录就当没有重名的 */
      }
      const uniq = uniqueRelName(taken, parentPath(want), baseName(want).replace(/\.html$/i, ''), '.html')
      if (!uniq) return sendJson(res, 409, { error: '同名的导出文件太多（1..99 都占满了），先清一清' })
      target = uniq.name
    }
    const targetAbs = resolveInData(target)
    if (!targetAbs) return sendJson(res, 400, { error: '非法导出路径' })

    /* ★ 这个函数是 async 的（它要去拿 katex —— 见 server-export.js）。
       忘了 await 会把 Promise 当成字符串写进文件，**盘上会留下 "[object Promise]"**，
       而用户只会看到"导出来是个空白页"。 */
    const html = await exportNoteHtml(text, {
      title: parsed.title || pathTitle(name),
      fileName: name,
      at: new Date(),
      fonts,
      fontCss: { katex: KATEX_FONT_FAMILY, body: EXPORT_BODY_FAMILY },
    })

    await fsp.mkdir(path.dirname(targetAbs), { recursive: true })
    await atomicWrite(targetAbs, html)

    console.log(`  [导出] ${name} → ${target}（${Math.round(Buffer.byteLength(html) / 1024)} KB，内联 ${Object.keys(fonts).length} 个公式字体）`)
    return sendJson(res, 200, {
      ok: true,
      from: name,
      to: target,
      dir: parentPath(target),
      bytes: Buffer.byteLength(html),
      fonts: Object.keys(fonts),
    })
  }

  /* ─────────────── 在资源管理器里打开一个文件夹 ───────────────
   *
   * 为什么需要它：用户 2026-09-17 明确说"你得告诉我我在哪里找到存放导出的文件夹"。
   * 光在提示里写一串路径是不够的 —— 他得自己去翻。这里让提示里那条路径**能点**，
   * 点一下资源管理器就跳过去。
   *
   * ⚠ 这是"让一个网页指挥本机打开文件夹"，是个**很危险的能力**，所以门收得很窄：
   *   ① 只认 `.导出` 目录本身，以及它里面（含子目录）的路径 —— 别的一律拒。
   *      于是它开不出 `C:\Windows`，也开不出用户的 `桌面`。
   *   ② 路径必须过 `normalizeRel`（不许 `..`、不许绝对路径、不许盘符）。
   *   ③ 只**打开**（`explorer <dir>`），绝不执行、不传别的参数。
   *   —— 出口只有一个（就是这里），所以只可能在"这里"出错，不会散在各处。
   *
   * ★ 为什么不做成"点开那个 html 文件"：那是把文件交给默认程序去 open，
   *   等于"让网页启动任意程序"。打开一个**文件夹**（而且限制在导出目录里）
   *   是最小够用的能力，多一步都不给。
   */
  if (p === '/api/reveal' && req.method === 'POST') {
    const body = await readBody(req)
    let parsed = {}
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      return sendJson(res, 400, { error: '请求不是合法 JSON' })
    }
    const rel = normalizeRel(parsed.path, { file: false })
    if (!rel) return sendJson(res, 400, { error: '非法路径' })
    /* 只在导出目录里：`rel` 自己就是它，或者它在它下面 */
    const inside = rel === EXPORT_DIR || isUnder(rel, EXPORT_DIR)
    if (!inside) return sendJson(res, 403, { error: '只能打开导出目录' })
    const abs = resolveInData(rel)
    if (!abs) return sendJson(res, 400, { error: '非法路径' })

    /* 目录还不存在（一次都没导出过）：**建出来再开** ——
       用户的意图是"我要看看导出在哪"，给他一个空目录正是他想看的答案。
       （而且第一份导出迟早会用到它，提前建没有副作用。） */
    try {
      await fsp.mkdir(abs, { recursive: true })
    } catch (e) {
      return sendJson(res, 500, { error: '建不出这个目录：' + String(e && e.message ? e.message : e) })
    }

    try {
      /* Windows: `explorer <路径>`。⚠ explorer 的返回码不可信（成功也可能回 1），
         所以**不看返回码**，只看 spawn 起没起来 —— 拿返回码判会误报失败。 */
      if (process.platform === 'win32') {
        spawn('explorer', [abs], { detached: true, stdio: 'ignore' }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', [abs], { detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref()
      }
    } catch (e) {
      return sendJson(res, 500, { error: '打不开资源管理器：' + String(e && e.message ? e.message : e) })
    }
    return sendJson(res, 200, { ok: true, path: rel, abs })
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
    // 只认我们知道的字段，别让前端随手塞东西进来。
    // ⚠ 那份名单在 server-ocr.js 里（`CONFIG_KEYS`）—— **不要在这儿另抄一份**：
    //   抄一份的下场是"设置面板里新加的字段存不进去"，而且静默（`boardModel` 就丢过一次）。
    const clean = {}
    for (const k of CONFIG_KEYS) if (k in patch) clean[k] = patch[k]
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

  /* 结构整理（2026-09-19，ADR-0004 第 4 步）：**不看图的第二次调用**。
     收一段纯文本（行清单 + 每行的字 + 你自己的词），回一个 JSON 骨架。
     ★ 和 /api/ocr 分开是**故意的**：那个口的契约是"一张图 → 一段字"，
       这里一张图都没有 —— 混在一起会让人以为"结构也是从图上认出来的"。
     ⚠ 这一层**不解析、不校验**它回的 JSON：落行校验是纯函数
       （src/lib/board-structure.js），在自检里断言得住；在这儿再解析一遍
       等于把同一份规矩写两处（这个仓库为"同一句话两份实现"栽过两次）。 */
  if (p === '/api/structure' && req.method === 'POST') {
    const cfg = await loadConfig(__dirname)
    if (!cfg.enabled) return sendJson(res, 200, { ok: false, kind: 'no-key', error: '手写识别被关掉了（设置里可以打开）' })
    const body = await readBody(req)
    let input = ''
    try {
      input = String(JSON.parse(body || '{}').input || '')
    } catch {
      return sendJson(res, 400, { ok: false, kind: 'bad', error: '结构整理的请求不是合法 JSON' })
    }
    if (!input.trim()) return sendJson(res, 200, { ok: false, kind: 'bad', error: '结构整理的输入是空的' })
    /* 上限：这个口是给本机页面用的，但"顺手当代理"不该发生（行清单撑死几 KB）。 */
    if (input.length > 200000) return sendJson(res, 200, { ok: false, kind: 'bad', error: '结构整理的输入太大了' })

    const r = await callProvider(cfg, null, { mode: 'structure', input, timeoutMs: 60000 })
    if (!r.ok) {
      console.log(`  [结构整理] 失败（${r.kind}）：${r.error}`)
      return sendJson(res, 200, { ok: false, kind: r.kind, error: r.error, httpStatus: r.httpStatus })
    }
    console.log(`  [结构整理] 回了 ${String(r.text).length} 个字的骨架（输入 ${input.length} 字）`)
    return sendJson(res, 200, {
      ok: true,
      mode: 'structure',
      text: r.text,
      note: r.note || '',
      debug: { chars: input.length, endpoint: cfg.provider === 'simpletex' ? 'simpletex' : cfg.dsBase },
    })
  }

  /* ─────────── 课件提纲 + 做题须知：讲完之后，把整节课串成两张卡 ───────────
     收一段**纯文本**（逐页讲过的内容压成的那份摘要：小节 + 每页的标题/重点/式子），
     回一段 JSON。**两张卡共用这一条路和这一份输入**，靠表单里的 `kind` 分：
       · `kind` 空 / `'docsum'` → 提纲（骨架/脉络/必记/易错/核心式子/自测）；
       · `kind` = `'rules'`     → 做题须知（单位与符号 / 口径 / 最容易错的）。
     ★ 为什么是**同一条路**而不是各开一条：两者的输入**一模一样**（同一份摘要）、
       错误话术、日志形状、debug 字段全都一样；各开一条就是同一段代码抄两遍，
       而"改了一处忘了另一处"在服务端这一类路上是最贵的（它没有编译期检查）。
       前端那边也是**一次摘要、连着发两个 kind**（见 doc-read.js 的 readSummary）。
     ★ 和 /api/structure 同一个形状（**纯文本、不发图**），理由也是同一条：
       这一趟的定义就是"只能拿前面讲过的东西整理"，所以它和"看一眼图"是两件事，
       混进 /api/ocr（那个口的契约是"一张图 → 一段字"）会让人以为提纲是看着图写的。
     ⚠ 这一层**不解析、不校验**它回的 JSON：解析和文案在纯函数里
       （src/lib/doc-summary.js 的 normalizeSummary / normalizeRules），自检里断言得住。 */
  if (p === '/api/doc/summary' && req.method === 'POST') {
    const cfg = await loadConfig(__dirname)
    if (!cfg.enabled) return sendJson(res, 200, { ok: false, kind: 'no-key', error: '手写识别被关掉了（设置里可以打开）' })
    const body = await readBodyBuffer(req)
    const ct = req.headers['content-type'] || ''
    /* ⚠ 这一趟是**文字**，不是文件 —— 前端发的是 multipart 里的一个 `input` 字段
       （见 src/lib/doc-read.js 的 readSummary：`fd.append('input', ...)`）。
       千万别写成读 JSON 正文：那会让每一次请求都回「不是合法 JSON」，
       而界面上看起来就像"提纲这个功能没做"（2026-09-22 自检当场抓到的就是这个）。
       ★ `|| ''` 兜底：`extractTextPart` 对**没有这一段**的表单回 `null`（见 multipart.js）。 */
    const input = (extractTextPart(body, ct, 'input') || '').slice(0, 60000)
    if (!input.trim()) return sendJson(res, 200, { ok: false, kind: 'bad', error: '课件提纲的输入是空的（先让老师把这几页讲一遍）' })
    /* 要哪一张卡。**认不出的值落到 docsum**（老前端不带这个字段 —— 那时候只有提纲）。
       ⚠ 别写成"认不出就报错"：老前端、老缓存全是这个形状，那样会把一直能用的路拦掉。 */
    const wantRules = (extractTextPart(body, ct, 'kind') || '').trim() === 'rules'
    const mode = wantRules ? 'rules' : 'docsum'
    const label = wantRules ? '做题须知' : '课件提纲'

    const r = await callProvider(cfg, null, { mode, input, timeoutMs: 90000 })
    if (!r.ok) {
      console.log(`  [${label}] 失败（${r.kind}）：${r.error}`)
      return sendJson(res, 200, { ok: false, kind: r.kind, error: r.error, httpStatus: r.httpStatus })
    }
    console.log(
      `  [${label}] 回了 ${String(r.text).length} 个字（输入 ${input.length} 字）` +
        (r.usage ? `（输入 ${r.usage.prompt}/命中 ${r.usage.cached}，输出 ${r.usage.completion}/思考 ${r.usage.reasoning}）` : '')
    )
    return sendJson(res, 200, {
      ok: true,
      mode,
      text: r.text,
      note: r.note || '',
      usage: r.usage || null,
      debug: { chars: input.length, endpoint: cfg.provider === 'simpletex' ? 'simpletex' : cfg.dsBase, requestId: r.requestId },
    })
  }

  /* ─────────── 速查（2026-09-28）：上课突然不懂的那个词 ───────────
     收**纯文本**、回**纯文本**，**不发图** —— 这一趟从头到尾就围着一件事：快。

     为什么单开一个口而不塞进 /api/ocr：那个口的契约是"一张图 → 一段字"，
     开头的收图检查会因为"没收到图片"把你挡回来；而速查恰恰是**没有图**的一趟 ——
     不贴图既是它能做到秒级的原因，也是它几乎不花钱的原因（见 MODE_LIMITS.lookup 那一格）。
     ⇒ 和 /api/doc/summary 同一个形状（都是"纯文本进、纯文本出"），那一整段理由照搬。

     三个字段（都是普通的 multipart 文本字段，不是文件）：
       · `term`    —— 要查的那个词（可能是猜的，也可能是一整句）；
       · `line`    —— 它周围的整句话（模型靠它判断到底问的是哪个词）；
       · `context` —— 这是哪门课哪一章（同一个词在不同课里不是一回事）。
     ⚠ `term` 空的时候**直接说没有词**，不要留到模型那儿 —— 那样会花一次调用
        换回一句"你没说是哪个词"。 */
  if (p === '/api/lookup' && req.method === 'POST') {
    const cfg = await loadConfig(__dirname)
    if (!cfg.enabled) return sendJson(res, 200, { ok: false, kind: 'no-key', error: '手写识别被关掉了（设置里可以打开）' })
    const body = await readBodyBuffer(req)
    const ct = req.headers['content-type'] || ''
    const term = (extractTextPart(body, ct, 'term') || '').trim().slice(0, 300)
    if (!term) return sendJson(res, 200, { ok: false, kind: 'bad', error: '没有要查的词（速查要先给一个词）' })
    const line = (extractTextPart(body, ct, 'line') || '').slice(0, 2000)
    const context = (extractTextPart(body, ct, 'context') || '').slice(0, 500)
    /* ★ 超时给 20 秒（对照：课件提纲给 90 秒）。这一趟 thinking 是关掉的、
       输出也只有四行，正常一两秒就回来了；给长了没有意义 ——
       超过二十秒的答案，学生早就把目光移回黑板上了。 */
    const r = await callProvider(cfg, null, { mode: 'lookup', input: lookupInput({ term, line, context }), timeoutMs: 20000 })
    if (!r.ok) {
      console.log(`  [速查] 失败（${r.kind}）：${r.error}`)
      return sendJson(res, 200, { ok: false, kind: r.kind, error: r.error, httpStatus: r.httpStatus })
    }
    console.log(
      `  [速查] ${term} → ${String(r.text).length} 个字` +
        (r.usage ? `（输入 ${r.usage.prompt}/命中 ${r.usage.cached}，输出 ${r.usage.completion}/思考 ${r.usage.reasoning}）` : '')
    )
    return sendJson(res, 200, {
      ok: true,
      mode: 'lookup',
      text: r.text,
      note: r.note || '',
      usage: r.usage || null,
      debug: { endpoint: cfg.provider === 'simpletex' ? 'simpletex' : cfg.dsBase, requestId: r.requestId },
    })
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
    const ct = req.headers['content-type'] || ''
    /* 这一次认的是公式还是普通文字还是**整板转录**还是**课件整理**还是**框选追问**
       还是**作业辅导**？字段是表单里的 mode。
       ★ 只认白名单里的那几个值，别的一律当 formula —— 这个接口是给本机页面用的，
         但"参数没校验"从来不是好习惯。认不出来就走老路，行为可预测。
       ⚠ 它要在**收图之前**读出来：作业辅导多发的那几张图，只有那一趟才收（见下）。 */
    const modeRaw = extractTextPart(raw, ct, 'mode')
    const mode =
      modeRaw === 'text'
        ? 'text'
        : modeRaw === 'board'
          ? 'board'
          : modeRaw === 'doc'
            ? 'doc'
            : modeRaw === 'ask'
              ? 'ask'
              : modeRaw === 'homework'
                ? 'homework'
                : modeRaw === 'hwask'
                  ? 'hwask'
                  : 'formula'
    /* 第二张图：两条路都会给 ——
       · 框选追问：框里那一块放大（字段名 `file2`，顺序和提示词里说好的一一对应）；
       · 作业辅导：作业的**第二页**。
       服务端从不猜"哪个是哪个"：顺序就是契约（ASK_PROMPT / HOMEWORK_PROMPT 里都写着）。 */
    const img2Part = secondImagePart(raw, ct)
    const img2 = img2Part ? img2Part.data : null
    /* 作业辅导的第 3 页起（`file3`…`fileN`，N = HW_MAX_PAGES —— 那个数只有一处）。
       ★ 只在那一条路上收：别的一趟多收几张图没有意义，而"顺手多收"会让一次请求的
         体积不受控 —— 这个口只给本机页面用，但口子就是口子。
       ★ 作业**追问**（hwask）也要这几页：学生问"答案里那一步为什么"，
         老师必须还看得见题才能答（见 server-ocr.js 的 HWASK_PROMPT 那段）。
         它和作业辅导发的是**同一批图**，所以走同一条白名单。 */
    const extra = []
    if (mode === 'homework' || mode === 'hwask') {
      for (let i = 3; i <= HW_MAX_PAGES; i += 1) {
        const p = extractFilePartNamed(raw, ct, 'file' + i)
        if (p) extra.push(p.data)
      }
    }
    /* 只收图片：这是个只给本机前端用的接口，但"顺手当文件上传器"这种事不该发生。
       ⚠ **每一张都要过这一关**（原来只查第一张）：作业辅导的第 2、3 页走的是同一批
         字段名，只查第一张等于给自己留了一个后门。 */
    const images = [img, img2, ...extra].filter(Boolean)
    for (const bytes of images) {
      const magic = bytes.subarray(0, 4)
      const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47
      const isJpg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff
      if (!isPng && !isJpg) {
        return sendJson(res, 200, { ok: false, kind: 'bad', error: '收到的不是 PNG/JPEG 图片' })
      }
    }

    /* 整板转录的图大（一整块板）、模型要读的东西多，30 秒常不够 —— 给它 120 秒。
       课件整理也是一页图、输出还长（一页几条知识点 + LaTeX），给 90 秒。
       `lines`（2026-09-19，第 4 步）：第一趟"按行抄"要把**行清单**拼进提示词。
       它是一条文字字段，和 mode 一样从 multipart 里读；没有它就走老的 BOARD_PROMPT。
       `page`（2026-09-22）：课件整理要**页码** —— 它落在提示词里（"这一页是第 N 页"），
       模型据此把每条知识点挂到页上。别的一律不读这个字段。 */
    const linesRaw = extractTextPart(raw, ct, 'lines')
    const pageRaw = Number(extractTextPart(raw, ct, 'page')) || 0
    /* 框选追问那两个字段（2026-09-22）：`question` 是学生这一次问的那句话，
       `history` 是小窗里**前面几轮**的对话（JSON 字符串）。两个都只有那一趟读。
       ⚠ 解析/夹取在 server-ocr.js 的 `parseAskHistory` —— 那是唯一一处
         "浏览器来的内容直接进提示词"的地方，规矩收在那里才测得着。
       ★ 作业辅导也用 `question`：那里面装的是**学生说的那句话**（"第 12 页第 3 题"），
         两趟的语义是同一条（"用户说的那句话"），所以共用一个字段是对的。 */
    const questionRaw = extractTextPart(raw, ct, 'question') || ''
    const historyRaw = extractTextPart(raw, ct, 'history') || ''
    /* ★ 读「前面几轮」的**两趟**：框选追问，和作业追问（hwask）——
       后者要把"第一趟的题目 + 老师给的答案"接到对话里（见 server-ocr.js 的 HWASK_PROMPT）。
       作业辅导那一趟本身不带历史（它是第一趟），所以它不在这一行里。 */
    const history = mode === 'ask' || mode === 'hwask' ? parseAskHistory(historyRaw) : []
    /* 作业辅导的**讲义**（这节课讲过的东西，由 src/lib/homework.js 的 collectKnowledge
       拼好再发过来；板上一张讲义卡都没有时它是空串）。字段名 `knowledge`，只有那一趟读。
       ⚠ 夹一刀上限：这是"浏览器来的内容直接进提示词"的第二个地方（第一个是 history）——
         一份讲义撑死几万字，而"不发上限"等于把这个口变成一台免费的翻译机。
       ★★ 必须带 `|| ''` 兜底（2026-09-22 用户"想让他帮我做题，但是却报错"）：
         `extractTextPart` 对**没有这一段**的表单回 `null`（见 src/lib/multipart.js），
         而板上一张讲解卡都没有时前端**根本不发这一段** ——
         `null.slice(...)` 当场抛 "Cannot read properties of null (reading 'slice')"，
         那串英文就这么原样弹在作业辅导面板上。
         缺一段 = 空讲义，不是错误：和上面 question / history 两条同一条规矩。 */
    const knowledgeRaw =
      mode === 'homework' ? (extractTextPart(raw, ct, 'knowledge') || '').slice(0, 60000) : ''
    /* 作业辅导的另一种选题法（2026-09-22，用户要的"圈住题号"）：`picked=1` =
       他是**用框把题圈住的**。那时候发过来的两张图是"整页（红框标出他圈的地方）+
       红框里放大"（和「框选追问」同一套，连画的都是同一份代码），
       提示词里那段说法也跟着换（见 server-ocr.js 的 `homeworkPickBlock`）。
       ★ 值只认 `'1'`：和 mode 一样，认不出来的当没有 —— 老前端不传这个字段时
         走的还是"打字说第几页第几题"那条路，行为可预测。 */
    const picked = mode === 'homework' && extractTextPart(raw, ct, 'picked') === '1'
    /* 追问没有多轮的**服务端**状态：每一次请求自带全部上下文（图 + 对话）。
       超时给 90 秒：它要读两张图、还要写一段 120~300 字的回答 ——
       和课件整理一个档（那个也是一页一图 + 一段长回话）。
       ★ 作业辅导给 120 秒：它一次最多三页图、还要一段讲义，回话又是**每题**一段解析
         （一道大题 600 字，几道题就是两三千字）—— 90 秒不够稳。
       ★ 作业追问（hwask）也给它 120 秒：它同样要读那几页图，历史里还压着第一趟
         那几道题的答案 —— 按 90 秒那档会时不时在"想得久一点"的时候被掐掉。 */
    const timeoutMs =
      mode === 'board' || mode === 'homework' || mode === 'hwask'
        ? 120000
        : mode === 'doc' || mode === 'ask'
          ? 90000
          : 30000
    const r = await callProvider(cfg, img, {
      mode,
      timeoutMs,
      lines: linesRaw || '',
      page: pageRaw,
      question: questionRaw,
      history,
      image2: img2,
      /* 一页一张图那两趟（作业辅导 / 作业追问）走这个数组；
         框选追问那两张走 image/image2。
         归一在 server-ocr.js 的 `imgs` 一处（那边才是"这一趟发了几张"的家）。 */
      images,
      input: knowledgeRaw,
      picked,
    })
    if (!r.ok) {
      console.log(`  [手写识别] 失败（${r.kind}）：${r.error}`)
      return sendJson(res, 200, { ok: false, kind: r.kind, error: r.error, httpStatus: r.httpStatus })
    }
    if (
      mode === 'text' ||
      mode === 'board' ||
      mode === 'doc' ||
      mode === 'ask' ||
      mode === 'homework' ||
      mode === 'hwask'
    ) {
      const who =
        mode === 'board'
          ? '整板转录'
          : mode === 'doc'
            ? '课件整理'
            : mode === 'ask'
              ? '框选追问'
              : mode === 'homework'
                ? '作业辅导'
                : mode === 'hwask'
                  ? '作业追问'
                  : '手写美化'
      console.log(
        `  [${who}]${mode === 'doc' ? `（第 ${pageRaw} 页）` : ''}${
          mode === 'homework' ? `（${images.length} 页图 + ${knowledgeRaw.length} 字讲义）` : ''
        }${
          mode === 'hwask'
            ? `（${images.length} 页图 + 前面 ${history.length} 条对话）`
            : ''
        }${r.usage ? `（输入 ${r.usage.prompt}/命中 ${r.usage.cached}，输出 ${r.usage.completion}/思考 ${r.usage.reasoning}）` : ''} 回了：${String(r.text).slice(0, 70).replace(/\n/g, ' ⏎ ')}`
      )
      return sendJson(res, 200, {
        ok: true,
        mode,
        text: r.text,
        conf: r.conf,
        note: r.note || '',
        /* ★ 这一趟花了多少（2026-09-22 加的）：服务端从上游 usage 读出来再转给界面 ——
           `usageOf` 那一段解释了为什么非要有这个数（在这之前整个仓库一次都没读过它，
           于是"改了之后是不是更省了"只能靠感觉）。读不出来是 null，不是零账。 */
        usage: r.usage || null,
        debug: {
          /* 每张图各自的字节数和**一共发了几张** —— 框选追问那条自检要读它
             （"第二张裁图到底有没有发出去"只有这里说得清），
             作业辅导那条自检读的是同一个数（"三页是不是都发出去了"）。 */
          bytes: img.length,
          bytes2: img2 ? img2.length : 0,
          images: images.length,
          turns: history.length,
          knowledge: knowledgeRaw.length,
          endpoint: cfg.provider === 'simpletex' ? (cfg.turbo ? 'turbo' : 'standard') : cfg.dsBase,
          requestId: r.requestId,
        },
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

  /* ─────────────── 资料：PDF/PPT 的上传与下发 ───────────────
     板上插一份课件 = 上传到这里（PDF 直存，PPT 转成 PDF），存进 data/.资料/
     （点开头 → 左栏不显示；.gitignore 排掉 → 公开的 GitHub 备份里没有课件）。
     板文件里只存 `{ path, pages }` —— 见 src/lib/docs.js。 */
  if (p === '/api/doc/upload' && req.method === 'POST') {
    const raw = await readBodyBuffer(req, DOC_MAX_BYTES, '文件太大（超过 300MB）—— 那么大的课件先压缩一下')
    const part = extractFilePart(raw, req.headers['content-type'] || '')
    if (!part || !part.filename) {
      return sendJson(res, 400, { error: '没收到文件（这里要的是 multipart/form-data，字段名 file）' })
    }
    try {
      const r = await saveUpload(DATA_DIR, part.data, part.filename)
      console.log(`  [资料] ${part.filename} → ${r.path}${r.converted ? '（PPT 已转成 PDF）' : ''}（${Math.round(part.data.length / 1024)} KB）`)
      return sendJson(res, 200, { ok: true, ...r })
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  }

  /* 这份资料**是 PPT 转来的吗**（`GET /api/doc/origin?path=.资料/xxx.pdf`）。
     `data/.资料/` 里留着同名原件（`xxx.pptx`）就是 —— PPT 上传时原件是特意留下的
     （见 server-docs.js 那段"以后还要改课件"）。
     ★ 谁要问这个：**作业辅导**。用户手上常常只有讲课的 PPT，而作业在书上 ——
       他挑中一份 PPT 转来的资料时，界面要能说那句"这份是讲课的课件，作业多半在书上，
       把作业所在的 PDF 也传上来"（见 HomeworkBox.jsx）。不知道来历就说不出这句话。 */
  if (p === '/api/doc/origin' && req.method === 'GET') {
    const rel = safeDecode(url.searchParams.get('path') || '')
    if (!isDocPath(rel)) return sendJson(res, 400, { error: '非法资料路径' })
    return sendJson(res, 200, { ok: true, ...(await docOrigin(DATA_DIR, rel)) })
  }

  /* ── 讲稿缓存（2026-09-23）：课件整理读出来的每一页，在盘上也留一份 ──
        `data/.资料/.已读/<课件名>/p<页号>.json`。为什么要有它、以及三条纪律，
        全在 server-docs.js 的「讲稿缓存」那一节（改之前先看那边）。

        GET    ?path=…&flavor=…        → 整份 `{ pages: { "12": { text, at } } }`
        PUT    ?path=…&page=12         → 写这一页（body 是 JSON `{ flavor, text }`）
        DELETE ?path=…                 → 这一份课件的讲稿全忘掉（换口径重来 / 按了重读）
        DELETE ?path=…&pages=1,2,3     → **只**忘这几页（「讲这几页」= 重读这几页；
                                          别的页的讲稿是花真钱买来的，不该被顺手带走）

     ★ 前端那份 localStorage **还在**，也不是重复：它是"这个窗口里最快的一层"，
       盘上这份是"清了浏览器数据、换了电脑之后还认得"的那一层。读的顺序是
       内存 → localStorage → 盘上（见 doc-read.js 的 cacheGet）。
     ⚠ 路径那道闸和别的资料接口一样硬：只认 `isDocPath`（`.资料/xxx.pdf|png…`），
       落哪儿由服务端算出来 —— 客户端**给不了**一个目录名。 */
  if (p === '/api/docread' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE')) {
    const rel = safeDecode(url.searchParams.get('path') || '')
    if (!isDocPath(rel)) return sendJson(res, 400, { error: '非法资料路径' })
    if (req.method === 'GET') {
      const flavor = String(url.searchParams.get('flavor') || '')
      if (!flavor) return sendJson(res, 400, { error: '缺 flavor（提示词口径）—— 不知道口径就没法判断哪些老稿还算数' })
      return sendJson(res, 200, { ok: true, ...(await readDeckPages(DATA_DIR, rel, flavor)) })
    }
    if (req.method === 'PUT') {
      const page = Number(url.searchParams.get('page'))
      if (!Number.isFinite(page) || page < 1) return sendJson(res, 400, { error: '页码不对' })
      let o = null
      try {
        o = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return sendJson(res, 400, { error: '讲稿不是合法 JSON' })
      }
      const flavor = String((o && o.flavor) || '')
      const text = String((o && o.text) || '')
      if (!flavor || !text.trim()) return sendJson(res, 400, { error: '缺 flavor 或正文（空讲稿不值得存）' })
      /* 一页讲稿撑死几 KB，给个宽松的口子挡"顺手当代理"就够。 */
      if (text.length > 200000) return sendJson(res, 400, { error: '这一页的讲稿太大了' })
      try {
        await writeDeckPage(DATA_DIR, rel, page, flavor, text)
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        return sendJson(res, 400, { error: String(e && e.message ? e.message : e) })
      }
    }
    /* DELETE：带 `pages=1,2,3` 就只忘这几页（「讲这几页」= 重读这几页）；
       带 `page` 就只忘那一页（「重新读这一页」）；都不带才整份忘掉。
       ⚠ 三者都只删 `p<数字>.json`（见 server-docs.js 那条"删的是谁的"）。
       ⚠ `pages` 拿不到一个合法页号时**一律当"没给"**（不能退化成整份清 ——
          那会把几十页花钱买来的讲稿删光，而调用方只是页码写错了）。 */
    const many = url.searchParams.get('pages')
    if (many != null && many !== '') {
      const nums = String(many)
        .split(',')
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isFinite(n) && n >= 1)
      if (nums.length) {
        let removed = 0
        for (const n of nums) removed += ((await forgetDeckPage(DATA_DIR, rel, n)) || {}).removed || 0
        return sendJson(res, 200, { ok: true, removed })
      }
    }
    const one = url.searchParams.get('page')
    if (one != null && one !== '') {
      return sendJson(res, 200, { ok: true, ...(await forgetDeckPage(DATA_DIR, rel, one)) })
    }
    return sendJson(res, 200, { ok: true, ...(await forgetDeckPages(DATA_DIR, rel)) })
  }

  /* 下发资料本体：pdf.js 按这个地址拉整份 PDF 来渲染页面，图片资料则是那张图本身。
     路径只认 `.资料/xxx.pdf|png|jpg…`（isDocPath + resolveInData 两道闸，跟别的接口一样硬）。
     ★ Content-Type 照后缀给（表在 server-docs.js 的 DOC_MIME）：pdf.js 认的是 `application/pdf`，
       图片则必须**照它自己的类型发** —— 一张 PNG 被说成 PDF，`<img>` 是加载不出来的，
       而资料层那一趟取图正好是 `<img>` 在取。 */
  const dm = p.match(/^\/api\/doc\/file\/(.+)$/)
  if (dm && req.method === 'GET') {
    const rel = safeDecode(dm[1])
    if (!isDocPath(rel)) return sendJson(res, 400, { error: '非法资料路径' })
    const abs = resolveInData(rel)
    if (!abs) return sendJson(res, 400, { error: '非法资料路径' })
    const s = await statOf(abs)
    if (!s) return sendJson(res, 404, { error: '这份资料不在了（可能被移走或删掉了）' })
    return send(res, 200, await fsp.readFile(abs), {
      'Content-Type': DOC_MIME[docExtOf(rel)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
  }

  /* ── 实验图（2026-10-05）─────────────────────────────────────────────
     一次实验报告要几十张图，那些图**不是板的一部分**（板是一节课的笔记），
     所以它们自己一个文件：`data/.图表/<图集名>.json`。
     整份读写（不是一页一个文件）—— 一份就是一次报告，一次讲完一起存，
     不存在"两个人同时改一半"那种事（那才是讲稿要拆成一页一文件的原因）。
     ⚠ 名字不许带路径分隔符：`safeName` 那道闸是"别让它写到 data/ 外面去"。 */
  if (p === '/api/charts') {
    const dir = path.join(DATA_DIR, '.图表')
    if (req.method === 'GET') {
      const rel = String(url.searchParams.get('name') || '')
      if (!rel) {
        /* 没给名字 = 只要一份"存过哪些"的清单，顺便把**最近改过**的那个放第一个
           （打开窗口时默认接着上次的那个继续）。 */
        let names = []
        try {
          names = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => ({
              n: f.slice(0, -5),
              t: (() => {
                try {
                  return fs.statSync(path.join(dir, f)).mtimeMs
                } catch {
                  return 0
                }
              })(),
            }))
            .sort((a, b) => b.t - a.t)
            .map((x) => x.n)
        } catch {
          names = [] // 目录还不存在 = 一份都没存过，那不是错误
        }
        return sendJson(res, 200, { ok: true, names, last: names[0] || '' })
      }
      if (!safeName(rel)) return sendJson(res, 400, { error: '图集名里有不能用的字符（别带斜杠）' })
      try {
        const t = fs.readFileSync(path.join(dir, rel + '.json'), 'utf8')
        return sendJson(res, 200, { ok: true, data: JSON.parse(t) })
      } catch {
        /* 读不出来（还没有 / 坏了）不是错误 —— 窗口那边会当成"从头开始"。 */
        return sendJson(res, 200, { ok: true, data: null })
      }
    }
    /* 出 PDF：这几张图 → 一页 A4（上下排），下载下来直接打印。
       ⚠ 依赖（pdf-lib + 字体）关在 server-export.js 里 —— server.js 本身仍然零依赖。
       ⚠⚠ **必须排在存盘那个 POST 前面**：存盘那支看的是"有 name、有 charts"就存，
          它先吃掉的话 `as=pdf` 永远走不到 —— 症状是"下载下来的是一个 {ok:true}"。 */
    if (req.method === 'POST' && String(url.searchParams.get('as') || '') === 'pdf') {
      const rel = String(url.searchParams.get('name') || '').trim()
      let o = null
      try {
        o = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return sendJson(res, 400, { error: '不是合法 JSON' })
      }
      const charts = o && Array.isArray(o.charts) ? o.charts : null
      if (!charts) return sendJson(res, 400, { error: '没有图' })
      try {
        const bytes = await makeChartPdf(charts, { title: rel || '实验图' })
        /* ⚠ 文件名是中文：`Content-Disposition` 得用 RFC 5987 那套编码，
           直接把中文塞进去，浏览器会存成一个乱七八糟的名字（或者干脆叫 download.pdf）。 */
        const fn = encodeURIComponent((rel || '实验图') + '.pdf')
        return send(res, 200, Buffer.from(bytes), {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="chart.pdf"; filename*=UTF-8''${fn}`,
          'Cache-Control': 'no-store',
        })
      } catch (e) {
        return sendJson(res, 400, { error: String(e && e.message ? e.message : e) })
      }
    }
    if (req.method === 'POST') {
      const rel = String(url.searchParams.get('name') || '').trim()
      if (!rel) return sendJson(res, 400, { error: '还没给这份图集起名字' })
      if (!safeName(rel)) return sendJson(res, 400, { error: '图集名里有不能用的字符（别带斜杠）' })
      let o = null
      try {
        o = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return sendJson(res, 400, { error: '这份图集不是合法 JSON' })
      }
      const charts = o && Array.isArray(o.charts) ? o.charts : null
      if (!charts) return sendJson(res, 400, { error: '没有图（charts 不是数组）' })
      /* 几十张图、每张几十个点，撑死几百 KB；给个宽松的口子挡"拿它当网盘"就够。 */
      const text = JSON.stringify({ charts })
      if (text.length > 4000000) return sendJson(res, 400, { error: '这份图集太大了' })
      try {
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(path.join(dir, rel + '.json'), text, 'utf8')
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        return sendJson(res, 400, { error: String(e && e.message ? e.message : e) })
      }
    }
  }

  return sendJson(res, 404, { error: '未知接口' })
}

/** 图集名：只许一个文件名该有的样子 —— 不许跑出 `data/.图表/` 这个目录。 */
function safeName(n) {
  const s = String(n || '').trim()
  if (!s || s.length > 80) return false
  if (s.includes('..') || /[\\/:*?"<>|]/.test(s)) return false
  return s === path.basename(s)
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

/* 先把导出的公式渲染器热起来（去拿 katex）。**不 await** ——
   它只是个加速：拿不到（node_modules 被删了）也不影响启动，
   那种情况下导出的公式会退成"原文摆出来"，丑但能用。 */
warmUpExport()

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
