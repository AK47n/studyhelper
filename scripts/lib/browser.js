/* 找浏览器 —— 只在这一个文件里决定，别的脚本别再各写一份绝对路径。
 *
 * 为什么要有这个文件：原来 9 个脚本各自写死
 *   'C:\Program Files\Google\Chrome\Application\chrome.exe'
 * 这台机器上根本没装 Chrome（只有 Edge），于是这些自检全是死的，
 * 报出来的却是"浏览器没起来"，把人往错的方向带。
 *
 * 查找顺序：
 *   1. 环境变量 CHROME_PATH —— 想临时指定别的浏览器（或指定一个 Chrome）就设它
 *   2. Edge   —— 系统自带，一定有。逐条路径试：
 *                · C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
 *                · C:\Program Files\Microsoft\Edge\Application\msedge.exe
 *   3. Chrome —— 装了就用（有的场景确实需要它，见下）
 *
 * 关于 Edge vs Chrome：diag-interact.js 原来注释说
 *   "Edge headless 下 CDP 合成的鼠标事件不会变成 pointer 事件"
 * 2026-09-15 在本机 Edge 153.0.4234.32 上实测，这句**不再成立**：
 *   合成 mousePressed/mouseMoved/mouseReleased 之后，
 *   canvas 上收到 pointerdown 1 次、pointermove 11 次，isTrusted=true，
 *   画布上确实留下了 12 个墨点。所以现在默认就优先用 Edge。
 *   真遇到"点了没反应"的怪事，再设 CHROME_PATH 指回 Chrome 对照一次。
 */
import fs from 'node:fs'

const CANDIDATES = [
  { kind: 'edge', paths: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ] },
  { kind: 'chrome', paths: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] },
]

/** 找得到就返回 { exe, kind, fromEnv }，找不到返回 null */
export function findBrowser() {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) {
      const kind = /msedge\.exe$/i.test(fromEnv) ? 'edge' : 'chrome'
      return { exe: fromEnv, kind, fromEnv: true }
    }
    console.error(`  设了 CHROME_PATH=${fromEnv}，但那个文件不存在`)
    process.exit(2)
  }
  for (const c of CANDIDATES) {
    for (const p of c.paths) {
      if (fs.existsSync(p)) return { exe: p, kind: c.kind, fromEnv: false }
    }
  }
  return null
}

/** 找不到就带着"我都找过哪些路径"退出 —— 别再说"浏览器没起来"那么含糊 */
export function requireBrowser() {
  const found = findBrowser()
  if (!found) {
    console.error('  找不到可用的浏览器。找过这些路径：')
    for (const c of CANDIDATES) for (const p of c.paths) console.error('    [' + c.kind + '] ' + p)
    console.error('  装一个 Edge 或 Chrome，或者设 CHROME_PATH 指向浏览器 exe。')
    process.exit(2)
  }
  return found
}

/** 只要 exe 路径的老用法 */
export function browserExe() {
  return requireBrowser().exe
}

/** 浏览器那份公共启动参数（各脚本再加自己的端口/窗口/地址） */
export function headlessArgs() {
  return ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars']
}
