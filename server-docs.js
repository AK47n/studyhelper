// 资料上传：把 PDF / PPT 收进 data/.资料/，PPT 顺手转成 PDF。
//
// ── 为什么单独一个文件 ──
// server.js 的底线是"除了排版那一份（server-export.js），不碰第三方依赖"。
// 这一份只比它多一件事（PowerPoint 的 COM 转换），收在这边，server.js 里
// 只剩两个 import 和两小段路由 —— 那边的 handleApi 才不会越长越长。
//
// ── 为什么资料放在 data/.资料/（点开头）──
// 服务端列目录会跳过 `.` 开头的（本来是给 .git 之类留的），左栏不会多出
// 一层点不开的目录 —— 和导出的 `.导出/` 是同一条路。
// ⚠ 它**不进 Git**（.gitignore 里排掉了 data/.资料/）：这个仓库备份到的是
//   **公开**的 GitHub，课件不是该推上去的东西。板文件里只存文件名和页面
//   尺寸表（见 src/lib/docs.js），换电脑要自己拷这个目录。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
/* DOC_DIR / isDocPath 是前端也在用的同一份规矩（板文件里存的 path 长什么样），
   别在这儿再抄一遍 —— 那正是这个仓库反复演过的"三处各写一遍"的坑。 */
import { DOC_DIR } from './src/lib/docs.js'
import { cleanSegment } from './src/lib/paths.js'

export const DOC_MAX_BYTES = 300 * 1024 * 1024 // 一份课件 300MB 封顶

function docDirAbs(dataDir) {
  return path.join(dataDir, DOC_DIR)
}

/* ══════════ 同一份文件不重复收（2026-09-20）══════════
 *
 * 起因：「课件整理」现在**不必先把课件插到板上**（点那颗按钮直接选文件），于是
 * "同一份 PDF 选第二次"变成了家常便饭（今天整理 1-12 页，明天接着整理 13-20）。
 * 按文件名撞名往后排那条规矩在这条路上会连出两个问题：
 *   · `data/.资料/` 里堆一串 `xxx 2.pdf`、`xxx 3.pdf`（同一份课件存了五遍）；
 *   · **缓存全部落空** —— 读过的页要再花一次钱（doc-read 的缓存键是"路径 + 页号"）。
 * 所以先按**内容**找一遍：只有文件大小一样的候选才去算 sha256（通常零个或一个），
 * 找到就返回原来那份。它认的是字节，不是文件名 —— 改过名的同一份课件照样认得出。 */
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 盘上那份的 sha256（**流着算**，不整个读进来）：候选可能是一份几百 MB 的课件，
 *  为了比对再吃一份内存没有道理。读坏了当没找到（宁可多存一份，也不能把上传搞挂）。 */
const hashFile = (abs) =>
  new Promise((resolve) => {
    const h = crypto.createHash('sha256')
    const rs = fs.createReadStream(abs)
    rs.on('data', (c) => h.update(c))
    rs.on('end', () => resolve(h.digest('hex')))
    rs.on('error', () => resolve(null))
  })

async function findByContent(dir, ext, data) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return null /* 目录还不存在 = 一份都没收过 */
  }
  const want = sha256(data)
  for (const n of names) {
    if (!n.toLowerCase().endsWith(ext)) continue
    const abs = path.join(dir, n)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st || !st.isFile() || st.size !== data.length) continue
    if ((await hashFile(abs)) === want) return abs
  }
  return null
}

/* 后缀白名单（`saveUpload` 进关的那一道闸）。
 *  ★ 图片那条是为了"题目在书上，为一道题传一本 PDF 太费事"（2026-09-21）：
 *    一张截图/一张照片就是一页资料（走的路径和 PDF 完全同一条，见 docs.js）。 */
const DOC_EXTS = ['.pdf', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp']
/* 图片后缀不需要任何转换，收下来原样就是最终那一份。 */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
/* 新后缀 → 下发时的 Content-Type（`/api/doc/file` 要用；放在这儿而不是那儿，
   是因为"什么后缀算资料"这件事本来就该只有一处说了算）。 */
export const DOC_MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** 收一份上传：PDF / 图片原样落盘；PPT 存下原件并转出 PDF。
 *  返回 `{ path, title, converted, duplicate }` —— `duplicate: true` = 这一份**早就收过**，
 *  磁盘上没多出文件（界面上值得说一句"用它原来那份"）。 */
export async function saveUpload(dataDir, data, originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase()
  if (!DOC_EXTS.includes(ext)) {
    throw new Error('只认 PDF / PPT / PPTX / 图片（png、jpg、webp）文件（别的格式先转成 PDF 再插）')
  }
  const dir = docDirAbs(dataDir)
  await fsp.mkdir(dir, { recursive: true })
  const isImage = IMAGE_EXTS.includes(ext)
  /* 图片不需要任何加工：它就是最终那一份。要办转换的只有 PPT（见下面）。 */
  const needsConvert = ext === '.ppt' || ext === '.pptx'
  /* ★ 这一份收过没有 —— 收过就直接用它（见上面 findByContent 那一段）。
     ⚠ PPT 还要**转出来的那份 PDF 也在**才算数：转换失败那次原件已经被收掉了，
       万一只剩个原件，就当没找到，重新转一遍。图片和 PDF 没有这一步 ——
       收到什么就是什么。 */
  const same = await findByContent(dir, ext, data)
  if (same) {
    const known = path.basename(same, ext)
    if (!needsConvert || fs.existsSync(path.join(dir, known + '.pdf'))) {
      /* ★ 后缀要看**它本来的那一份**：图片重复上传交回的是那张图本身，
         写成 `.pdf` 的话资料就凭空多了一个不存在的文件名（渲染时 404）。
         只有走过 PPT 转换的那一条路才是 pdf。 */
      const keptExt = needsConvert ? '.pdf' : ext
      return { path: `${DOC_DIR}/${known}${keptExt}`, title: known, converted: needsConvert, duplicate: true }
    }
  }
  /* 名字来自用户自己的文件名：过一遍 cleanSegment（坏字符换 -），
     截到 60 字 —— 目录段的上限是 80（paths.js 的 MAX_SEGMENT），留点余量。 */
  const stem = (cleanSegment(String(originalName || '资料').replace(/\.(pdf|pptx|ppt|png|jpe?g|webp)$/i, '')) || '资料').slice(0, 60)
  /* 同名**不覆盖**（和导出同一条纪律：静默覆盖会吃掉上次的东西）。撞名往后排 ` 2`、` 3`… */
  let name = null
  for (let i = 1; i <= 99; i += 1) {
    const cand = i === 1 ? stem : `${stem} ${i}`
    if (!fs.existsSync(path.join(dir, cand + ext))) {
      name = cand
      break
    }
  }
  if (!name) throw new Error('同名资料太多（1..99 都占满了），先清一清 data/.资料/')

  /* PDF、图片：原样落盘（后缀也保留 —— 往后都按后缀认它是什么）。 */
  if (!needsConvert) {
    await fsp.writeFile(path.join(dir, name + ext), data)
    return { path: `${DOC_DIR}/${name}${ext}`, title: name, converted: false, duplicate: false }
  }

  /* PPT：原件留一份（以后还要改课件），转出来的 PDF 才是画布用的那份。
     ⚠ 转换失败时把这份**本次上传的**原件收掉 —— 留着只会让人以为"转好了"。 */
  const srcAbs = path.join(dir, name + ext)
  const outAbs = path.join(dir, name + '.pdf')
  await fsp.writeFile(srcAbs, data)
  try {
    await convertPptToPdf(srcAbs, outAbs)
  } catch (e) {
    await fsp.rm(srcAbs, { force: true })
    throw e
  }
  return { path: `${DOC_DIR}/${name}.pdf`, title: name, converted: true, duplicate: false }
}

/* PowerShell 字符串里套单引号的转义：'' 。（路径里有空格、中文、单引号都靠它） */
const psq = (s) => String(s).replace(/'/g, "''")

/**
 * 这份资料**是 PPT 转来的吗**（`{ fromPpt, source }`）。
 *
 * ── 谁要问这个、为什么 ─────────────────────────────────────────────────
 * 「作业辅导」那一趟。用户手上常常只有**讲课的 PPT**，而作业在**书上** ——
 * 他挑中一份 PPT 转来的资料去问作业时，界面要能说一句"这份是讲课的课件，
 * 作业多半不在这里，把作业所在的那份 PDF 也传上来"（用户 2026-09-22 的原话）。
 * 判据就在磁盘上：PPT 上传时**原件是特意留着的**（`saveUpload` 那段"以后还要改课件"），
 * 转出来的 PDF 和它同名同目录 —— 所以"旁边有没有同名原件"就是这份的来历。
 *
 * ★ 不认文件名里的"课件/讲稿"那种字样：那是猜，而猜错的表现是"该提醒的时候没提醒"
 *   （或者反过来，把一份教材说成 PPT）。磁盘上的原件是事实。
 * ⚠ 用户手动把 PDF 放进 `.资料/` 的话，旁边当然没有原件 —— 那就是 `fromPpt: false`，
 *   正好是对的（他不知道来历，我们也不该编一个）。
 */
export async function docOrigin(dataDir, relPath) {
  const name = path.basename(String(relPath || ''))
  if (!/\.pdf$/i.test(name)) return { fromPpt: false, source: '' }
  const stem = name.replace(/\.pdf$/i, '')
  const dir = docDirAbs(dataDir)
  for (const ext of ['.pptx', '.ppt']) {
    const abs = path.join(dir, stem + ext)
    const st = await fsp.stat(abs).catch(() => null)
    if (st && st.isFile()) return { fromPpt: true, source: stem + ext }
  }
  return { fromPpt: false, source: '' }
}

/* ══════════ 讲稿缓存：读过一次的页，在盘上也留一份（2026-09-23）══════════
 *
 * 起因：`doc-read.js` 那份缓存从前**只进 localStorage**。那意味着清一次浏览器数据、
 * 换个端口（localStorage 是按 origin 分的）、换台电脑，几十页的讲解就全没了 ——
 * 再整理一遍要再付一遍钱。★ 讲解是**花真钱换来的**，它该跟课件一起躺在 `data/` 里。
 *
 * 放在 `.资料/.已读/<课件名>/p<页号>.json`：
 *   · 点开头的目录不会被列进左栏（服务端列目录跳 `.` 开头，和 `.导出/` 同一条路）；
 *   · 它在 `data/.资料/` 里面，而那一层整个不进 Git —— 课件和它的讲稿都不该推公开仓库；
 *   · 换电脑时 `data/.资料/` 是要自己拷的（见文件头），**讲稿跟着一起走** ——
 *     那正是这一条的意义：钱花过一次，别只花在某一台机器上。
 *
 * ★ 为什么**一页一个文件**，不是整份一个文件：课件整理是**6 路并发**的，每读完一页
 *   就写一次 —— 整份"读出来、改一下、写回去"的话，六路会互相把别人那一页盖掉。
 *   一页一个文件就没有这回事（它们写的是不同的文件）。
 * ★ 口径（`flavor`，见 `DOC_FLAVOR`）**记在每个文件里**：换了提示词的回话格式，
 *   老稿自动不算数（和前端那条纪律同一个意思），而且不必删老文件。
 */
const READ_DIR = '.已读'

/** 一份课件的讲稿放在哪个目录（**只由课件路径算出来** —— 改名了就换目录，和"按内容认"
 *   那条不一样：这里认的是"哪一份课件"，不是"哪几个字节"）。 */
export function docReadDirAbs(dataDir, relPath) {
  const base = path.basename(String(relPath || ''))
  const stem = cleanSegment(base.replace(/\.[^.]+$/, '')) || '资料'
  return path.join(docDirAbs(dataDir), READ_DIR, stem)
}

/** 整份读出来（`{ pages: { "12": { text, at } } }`）。★ 只认**口径对得上**的那些页 ——
 *  口径变了的老稿留着不碍事（还能回滚），但不会被人当成"这一页已经讲过了"。
 *  ⚠ 目录不在 / 坏 JSON 一律当"一份都没有"：缓存不是正确性的一部分（和前端同一条纪律）。 */
export async function readDeckPages(dataDir, relPath, flavor) {
  const dir = docReadDirAbs(dataDir, relPath)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return { ok: true, pages: {} }
  }
  const pages = {}
  for (const n of names) {
    const m = /^p(\d+)\.json$/.exec(n)
    if (!m) continue
    try {
      const o = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'))
      if (o && o.flavor === flavor && typeof o.text === 'string' && o.text.trim()) {
        pages[m[1]] = { text: o.text, at: Number(o.at) || 0 }
      }
    } catch {
      /* 坏掉的那一份当没有 —— 宁可再花一次钱，也不能让一条坏记录占着位 */
    }
  }
  return { ok: true, pages }
}

/** 写完一页。并发安全（每页各写各的文件）。 */
export async function writeDeckPage(dataDir, relPath, page, flavor, text) {
  const n = Number(page)
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('页码不对：' + String(page))
  const dir = docReadDirAbs(dataDir, relPath)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `p${Math.floor(n)}.json`), JSON.stringify({ flavor, text, at: Date.now() }), 'utf8')
  return { ok: true }
}

/** 只忘掉**一页**（「重新读这一页」走这条：那颗按钮的意思是"上次那个我不信"）。
 *  ★ 同样只删 `p<数字>.json` —— 而且只删**指定页号**那一个文件。 */
export async function forgetDeckPage(dataDir, relPath, page) {
  const n = Number(page)
  if (!Number.isFinite(n) || n < 0 || n > 100000) return { ok: false, removed: 0 }
  const file = path.join(docReadDirAbs(dataDir, relPath), `p${Math.floor(n)}.json`)
  try {
    await fsp.unlink(file)
    return { ok: true, removed: 1 }
  } catch {
    return { ok: true, removed: 0 } // 本来就没有 = 已经忘了，不算错
  }
}

/** 「这一份课件的东西全忘掉」（换口径重来 / 用户按了重读）。
 *  ★★ **只删 `p<数字>.json`**，别的一概不动 —— 目录名是从课件名算出来的，
 *     万一哪天算错撞进别的目录，"递归删整个目录"就会删到不是我们的东西上
 *     （这个仓库为"删的是谁的"交过一次学费，见 README）。 */
export async function forgetDeckPages(dataDir, relPath) {
  const dir = docReadDirAbs(dataDir, relPath)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return { ok: true, removed: 0 }
  }
  let removed = 0
  for (const n of names) {
    if (!/^p\d+\.json$/.test(n)) continue
    await fsp.unlink(path.join(dir, n)).catch(() => {})
    removed += 1
  }
  return { ok: true, removed }
}

/**
 * 用 PowerPoint 的 COM 把 PPT 另存为 PDF（格式码 32 = ppSaveAsPDF）。
 * 只在本机装了 PowerPoint 时可行 —— 没装就回一句人话，不猜、不装替身。
 * ⚠ 超时**不杀** POWERPNT：用户可能自己开着 PowerPoint，kill 会连他的未保存
 *   文档一起带走。宁可慢，不可闯祸。
 */
export function convertPptToPdf(srcAbs, outAbs, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      '  $app = New-Object -ComObject PowerPoint.Application',
      `  $pres = $app.Presentations.Open('${psq(srcAbs)}', -1, 0, 0)`,
      `  $pres.SaveAs('${psq(outAbs)}', 32)`,
      '  $pres.Close()',
      '  $app.Quit()',
      "  Write-Output 'OK'",
      "} catch {",
      "  Write-Output ('ERR:' + $_.Exception.Message)",
      '}',
    ].join('\r\n')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('转 PDF 超时（3 分钟还没完）。文件太大的话，先在 PowerPoint 里手动「另存为 PDF」再插'))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('exit', () => {
      clearTimeout(timer)
      if (fs.existsSync(outAbs)) return resolve(outAbs)
      const m = /ERR:(.+)/.exec(out)
      if (m && /0x800401E3|MK_E_UNAVAILABLE|无法创建|Cannot create/i.test(m[1])) {
        reject(new Error('这台电脑没装 PowerPoint，转不了 PDF —— 先把 PPT 手动「另存为 PDF」，再插那个 PDF'))
      } else if (m) {
        reject(new Error('PowerPoint 转 PDF 失败：' + m[1].trim()))
      } else {
        reject(new Error('没转出 PDF（没装 PowerPoint？）—— 先把 PPT 手动「另存为 PDF」，再插那个 PDF'))
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error('起不了 PowerShell：' + String(e && e.message ? e.message : e)))
    })
  })
}
