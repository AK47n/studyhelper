/* 清掉 dist/ 里**没人再引**的旧包（2026-09-24）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * `vite.config.js` 里 `emptyOutDir: false` 是**故意的**（那句注释写着：这台机器上
 * 一次删超过 50 个文件会先被拦下来问一句，而 dist/assets 里正好躺着 62 个字体文件，
 * 于是每次构建都红）。代价是每构建一次就多留一套带 hash 的产物 ——
 * 攒到 2026-09-24 是 344 个文件 216 MB，其中 282 个（214 MB）**当前这版一个都不引**。
 *
 * ── 判据："当前这版引不引" ──────────────────────────────────────────
 * 从 `dist/index.html` 出发，顺着它引用的 js / css，**再顺着那些文件里写着的
 * `/assets/…` 地址**（worker 的地址就是这样被引用的 —— 它不在 html 里），
 * 反复走到不再新增为止。走不到的，就是旧包。
 * ★ 注意别反过来看"修改时间"：字体每次构建都重新落盘（名字一样、mtime 是新的），
 *   按 mtime 删会把正在用的字体删掉。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node scripts/clean-dist.js          干跑：只报"会删哪些、多大"，一个字节不动
 *   node scripts/clean-dist.js --yes    真删
 * ⚠ 删的全是**能重新构建出来**的东西（`npm run build`）。它不碰 `src/` 和 `data/`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const ASSETS = path.join(DIST, 'assets')
const YES = process.argv.includes('--yes')

const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('dist/index.html 都不在 —— 先 `npm run build`，没什么可清的。')
  process.exit(0)
}

/* ── 1) 从 index.html 出发，顺着引用走到收敛 ─────────────────────── */
const keep = new Set()
const queue = [path.join(DIST, 'index.html')]
const seen = new Set(queue)

while (queue.length) {
  const f = queue.shift()
  const text = fs.readFileSync(f, 'utf8')
  /* ⚠ js 里引分包和 worker 用的是**相对路径**（`import("./pdf-xxxx.js")`），
     css/html 里才是 `assets/…` —— 两种写法都要认，漏了前者会把
     "第一次打开 PDF 才下载的那一块"当成旧包删掉（页面上要等到你插一份资料才发现）。 */
  for (const m of text.matchAll(/(?:assets|\.)\/([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/g)) {
    const name = m[1]
    if (keep.has(name)) continue
    keep.add(name)
    const abs = path.join(ASSETS, name)
    /* 只顺着"文本文件"再往下走（css / js / html）—— 字体和 worker 里没有引用。 */
    if (fs.existsSync(abs) && /\.(js|mjs|css|html)$/.test(name) && !seen.has(abs)) {
      seen.add(abs)
      queue.push(abs)
    }
  }
}

if (!keep.size) {
  console.log('index.html 里一个 assets 都没引 —— 不删（这不像一个正常的 dist/）。')
  process.exit(1)
}

/* ── 2) 走不到的就是旧的 ────────────────────────────────────────── */
const all = fs.readdirSync(ASSETS)
const stale = []
let bytes = 0
for (const n of all) {
  if (keep.has(n)) continue
  const st = fs.statSync(path.join(ASSETS, n))
  bytes += st.size
  stale.push(n)
}

console.log(`dist/assets 共 ${all.length} 个文件，当前这版引着 ${keep.size} 个`)
console.log(`走不到的（旧包）：${stale.length} 个，${mb(bytes)}`)
if (!stale.length) {
  console.log('没有要清的。')
  process.exit(0)
}

const byExt = {}
for (const n of stale) {
  const e = path.extname(n).slice(1) || '(无后缀)'
  byExt[e] = (byExt[e] || 0) + 1
}
console.log('  按后缀：' + Object.entries(byExt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '))

if (!YES) {
  console.log('\n这是**干跑**。真要删就加 --yes：')
  console.log('  node scripts/clean-dist.js --yes')
  if (stale.length <= 20) console.log('\n会删：\n  ' + stale.join('\n  '))
  else console.log(`\n会删（前 10 个）：\n  ${stale.slice(0, 10).join('\n  ')}\n  …（${stale.length - 10} 个）`)
  process.exit(0)
}

/* ⚠ 只删 dist/assets 下"走不到"的那些；index.html 和被引的那一套一个都不碰。 */
let done = 0
const failed = []
for (const n of stale) {
  try {
    fs.unlinkSync(path.join(ASSETS, n))
    done += 1
  } catch (e) {
    failed.push(n + '（' + e.code + '）')
  }
}
console.log(`\n删了 ${done} 个，腾出 ${mb(bytes)}`)
if (failed.length) console.log('删不掉的（中文名 / 被占用？）：\n  ' + failed.join('\n  '))
const left = fs.readdirSync(ASSETS)
let leftBytes = 0
for (const n of left) leftBytes += fs.statSync(path.join(ASSETS, n)).size
console.log(`dist/assets 现在剩 ${left.length} 个，${mb(leftBytes)}`)
