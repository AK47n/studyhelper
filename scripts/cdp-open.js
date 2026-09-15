/* 起一个带调试端口的 headless 浏览器，给 npm run check:browser /
 * check:board-browser 用。起完就退，后面的脚本自己去连调试端口。
 *
 * 用法：node scripts/cdp-open.js <调试端口> [窗口尺寸，如 1440,900]
 *
 * 为什么单独一个文件：原来 package.json 里那两条内联着
 *   start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ...
 * 绝对路径写死在 npm script 里，这台机器没装 Chrome 就一直起不来。
 * 现在浏览器由 scripts/lib/browser.js 决定（Edge 优先，认识 CHROME_PATH），
 * npm script 里不再出现任何绝对路径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { browserExe } from './lib/browser.js'

const port = Number(process.argv[2] || 9222)
const size = process.argv[3] || '1440,900'
const app = process.env.APP_URL || 'http://127.0.0.1:5177/'

// 端口上已经有人应答：说明浏览器还活着，别再起一个（会抢端口 / 报没意义的错）
const alive = await fetch(`http://127.0.0.1:${port}/json/version`)
  .then((r) => r.ok)
  .catch(() => false)
if (alive) {
  console.log(`  调试端口 ${port} 上已经有浏览器在跑了，直接用`)
  process.exit(0)
}

const exe = browserExe()
const profile = path.join(os.tmpdir(), `studyhelper-cdp-${port}`)
// 端口没人应答 = 上一个浏览器确实没了；清掉 profile 免得残留的锁文件拦着启动
try {
  fs.rmSync(profile, { recursive: true, force: true })
} catch {}

const proc = spawn(
  exe,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${size}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    app,
  ],
  { detached: true, stdio: 'ignore' }
)
proc.unref()
console.log(`  已起 ${path.basename(exe)}：调试端口 ${port}，窗口 ${size}，地址 ${app}`)
