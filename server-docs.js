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
import { spawn } from 'node:child_process'
/* DOC_DIR / isDocPath 是前端也在用的同一份规矩（板文件里存的 path 长什么样），
   别在这儿再抄一遍 —— 那正是这个仓库反复演过的"三处各写一遍"的坑。 */
import { DOC_DIR } from './src/lib/docs.js'
import { cleanSegment } from './src/lib/paths.js'

export const DOC_MAX_BYTES = 300 * 1024 * 1024 // 一份课件 300MB 封顶

function docDirAbs(dataDir) {
  return path.join(dataDir, DOC_DIR)
}

/** 收一份上传：PDF 原样落盘；PPT 存下原件并转出 PDF。返回 { path, title, converted }。 */
export async function saveUpload(dataDir, data, originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase()
  if (!['.pdf', '.ppt', '.pptx'].includes(ext)) {
    throw new Error('只认 PDF / PPT / PPTX 文件（别的格式先转成 PDF 再插）')
  }
  const dir = docDirAbs(dataDir)
  await fsp.mkdir(dir, { recursive: true })
  /* 名字来自用户自己的文件名：过一遍 cleanSegment（坏字符换 -），
     截到 60 字 —— 目录段的上限是 80（paths.js 的 MAX_SEGMENT），留点余量。 */
  const stem = (cleanSegment(String(originalName || '资料').replace(/\.(pdf|pptx|ppt)$/i, '')) || '资料').slice(0, 60)
  /* 同名**不覆盖**（和导出同一条纪律：静默覆盖会吃掉上次的东西）。撞名往后排 ` 2`、` 3`… */
  let name = null
  for (let i = 1; i <= 99; i += 1) {
    const cand = i === 1 ? stem : `${stem} ${i}`
    if (!fs.existsSync(path.join(dir, cand + '.pdf'))) {
      name = cand
      break
    }
  }
  if (!name) throw new Error('同名资料太多（1..99 都占满了），先清一清 data/.资料/')

  if (ext === '.pdf') {
    await fsp.writeFile(path.join(dir, name + '.pdf'), data)
    return { path: `${DOC_DIR}/${name}.pdf`, title: name, converted: false }
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
  return { path: `${DOC_DIR}/${name}.pdf`, title: name, converted: true }
}

/* PowerShell 字符串里套单引号的转义：'' 。（路径里有空格、中文、单引号都靠它） */
const psq = (s) => String(s).replace(/'/g, "''")

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
