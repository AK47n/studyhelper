/* 「导出一条笔记 → 一个能发出去的网页」—— **真服务、真写盘**的端到端自检。
 *
 * 为什么要有这一条（2026-09-18 起有了导出）：
 *   导出这件事的风险不在"排版好不好看"，在**发出去之后**才发现的那一类错：
 *   公式没排出来、引用点过去是空的、文件躺在别的地方、同名把上一份吃了。
 *   这些用眼睛看一个页面是看不出来的（页面长得都对），必须拿盘上的字节断言。
 *
 * ★ 跑在**临时目录**里（和 check-storage 同一个路子）：把 server.js / src/ / dist/
 *   复制出去，`data/` 从零开始。所以它**根本碰不到**你 data/ 里那份真笔记。
 *   —— 不是"跑完记得删"，是"从头到尾没连上"。这一条比"小心地删"可靠得多。
 *
 * ★ 但**内容**用的是真笔记：把用户那份 `示例 · 大物电磁学.md` **只读**复制进临时
 *   data/ 当素材（有真公式、真引用、真分层，拿自造的三行假笔记试不出问题）。
 *
 * 用法：node scripts/check-export.js   （或 npm run check:export）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, serverModules, linkRuntimeDeps } from './lib/board-check.js'
const PORT = Number(process.env.STUDYHELPER_EXPORT_PORT || 5189)
const BASE = `http://127.0.0.1:${PORT}`
/* 素材：用户那份真笔记（只读复制）。找不到就退回一个自带的小样 —— 自检不该
   因为"用户把示例删了"而红，那条笔记是示例，不是必需品。 */
const SAMPLE_REL = '示例 · 大物电磁学.md'
const NOTE = 'zz-导出夹具.md'

let checks = 0
let fails = 0
const ok = (m) => {
  checks++
  console.log('  \u2713 ' + m)
}
const bad = (m) => {
  checks++
  fails++
  console.log('  \u2717 ' + m)
}
const eq = (got, want, m) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) ok(`${m}  →  ${a}`)
  else bad(`${m}\n      实际 ${a}\n      期望 ${b}`)
}
const yes = (cond, m) => (cond ? ok(m) : bad(m))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (r) => r.json()
const get = (u) => fetch(BASE + u).then(j)
const post = (u, body) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j)

const TMP = path.join(os.tmpdir(), `studyhelper-export-${process.pid}`)
const DATA = path.join(TMP, 'data')

function setup() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(DATA, { recursive: true })
  /* ⚠ 这个清单**从 server.js 的 import 推出来**（lib/board-check.js 的 serverModules），
     不再手写。2026-09-18 手写过一次，加了 `server-export.js` 却忘了往这儿加，
     于是复制出去的那一份**起不来**，而报出来的话是 `Node.js v24.19.0` 加一堆空行 ——
     看着像"Node 坏了"，其实是文件根本不齐。推出来就不会再有这回事。 */
  for (const f of serverModules()) {
    fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f))
  }
  fs.cpSync(path.join(ROOT, 'src'), path.join(TMP, 'src'), { recursive: true })
  /* dist/ 里的 assets 是导出的**字体来源**（服务端从那儿读字体字节去内联）。
     没有它导出照样跑，只是公式字体不内联 —— 那不测也行，但测了更接近真环境。 */
  const assets = path.join(ROOT, 'dist', 'assets')
  if (fs.existsSync(assets)) {
    fs.mkdirSync(path.join(TMP, 'dist'), { recursive: true })
    fs.cpSync(assets, path.join(TMP, 'dist', 'assets'), { recursive: true })
  }
  linkKatex()
}

/* ═══════════ 把 katex 交给临时目录 ═══════════
 *
 * ★ 2026-09-18 踩过，而且踩得很隐蔽：上面那个复制清单里**没有 node_modules**，
 *   所以临时目录里 `import('katex')` 必然失败 → server-export.js 老老实实
 *   降级成"公式原文摆出来"。于是自检**全部通过**，却在测一个假的系统 ——
 *   它验的是"没装 katex 时的丑样子"，而用户手上是有 katex 的。
 *   更坑的是这个错看起来像"功能没做完"：盘上那份 HTML 里 19 个 `math-bad`、
 *   0 个 `katex`，而屏幕上什么都正常。
 *
 * 所以临时目录里必须有一条**真的**通往 katex 的路。
 * 但不能 `fs.cpSync(node_modules)`（4000+ 文件，几十秒，还可能撞上沙箱的
 * 批量删除限制）。Windows 上目录**联接**（junction）不需要管理员权限，
 * `fs.symlinkSync(..., 'junction')` 就能建，而且是指向真目录的活链接。
 *
 * ⚠ 只链 `node_modules/katex` 这**一个**包，不是整个 node_modules：
 *   导出真正用到的第三方依赖只有它（vite/react 那些是构建期的，跑不到服务端）。
 *   链一整个 node_modules 会让"服务端到底依赖了什么"这件事变得看不清。
 * ⚠ 建不出来（权限/文件系统不支持）**不算失败** —— 那就退回降级路径跑，
 *   只是要在屏幕上说清楚"这次没验公式"，别让人以为验过了。 */
let katexLinked = false
function linkKatex() {
  /* 实现搬去 lib/board-check.js 了（check-storage 那条也有同一个需要）——
     两处各写一份就是"同一句话有两份实现"，这个仓库的老坑。 */
  katexLinked = linkRuntimeDeps(TMP)
}

/* 夹具笔记：优先用用户那份真笔记（**只读**复制），拿不到就用自带的小样。
   小样也刻意带上三种记号（公式 / 引用 / 分层），不然测了个空。 */
const FALLBACK = `# zz 导出夹具

## 一、来一段公式

- 一块导体
  - 公式 | $E = mc^2$
  - 说的是 | 质量和能量是一回事
  - 用到的量 | [[B]] [[mu0]]

## 二、量

- [[B]] | 磁感应强度，T。
- [[mu0]] | 真空磁导率。
`

function writeFixture() {
  const src = path.join(ROOT, 'data', SAMPLE_REL)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DATA, NOTE))
    return `用户那份「${SAMPLE_REL}」（只读复制，原件没动）`
  }
  fs.writeFileSync(path.join(DATA, NOTE), FALLBACK, 'utf8')
  return '自带的小样（项目里没找到那份示例笔记）'
}

async function portBusy() {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 700)
    await fetch(BASE + '/api/list', { signal: ctl.signal })
    clearTimeout(t)
    return true
  } catch {
    return false
  }
}

console.log('\n[export] 导出一条笔记：真服务 + 真写盘（临时目录 ' + TMP + '）')
console.log('  你项目里的 data/ 从头到尾没被连上（这一条跑的是复制出去的那一份）\n')

setup()
const material = writeFixture()
console.log(`  素材：${material}`)
/* 这一行不是装饰：「公式排出来了」那条断言只有在 katex 真的能加载时才有意义。
   没链上就得**当面说**，不然失败信息会误导人去查排版代码。 */
console.log(
  katexLinked
    ? '  katex：已接进临时目录（公式按真本事排）'
    : '  ⚠ katex：**没接上**（node_modules/katex 找不到）—— 公式走降级路，那几条断言会红\n'
)

if (await portBusy()) {
  bad(`端口 ${PORT} 上已经有服务了 —— 先关掉它（不然验的是别的应用）`)
} else {
  const server = spawn(process.execPath, ['server.js', '--no-auto-exit', '--no-open'], {
    cwd: TMP,
    env: { ...process.env, STUDYHELPER_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  server.stdout.on('data', (d) => log.push(String(d)))
  server.stderr.on('data', (d) => log.push(String(d)))
  const kill = () => {
    try {
      if (!server.killed) server.kill()
    } catch {}
  }
  process.on('exit', kill)

  let up = false
  for (let i = 0; i < 60; i++) {
    if (await portBusy()) {
      up = true
      break
    }
    await sleep(200)
  }

  /* ★ 服务起不来时要把日志**整段**打出来。2026-09-18 踩过：原来只取最后 4 行，
     而 Node 的启动错误前几行是堆栈、最后几行常是空的 —— 于是屏幕上只有
     "Node.js v24.19.0"，像"Node 坏了"，其实第一行就写着 `Cannot find module`。 */
  const dumpLog = () => {
    const lines = log.join('').split('\n').filter((l) => l.trim() !== '')
    return lines.slice(0, 12).join(' | ') || '（服务没吐出任何东西）'
  }

  try {
    if (!up) {
      bad('服务没起来：' + dumpLog())
    } else {
      ok(`服务起来了（端口 ${PORT}）`)

      let html = ''
      let outRel = ''

      /* ① 导出一次，东西得真的落在盘上 */
      {
        const r = await post('/api/export', { name: NOTE, title: 'zz 导出夹具', fonts: '' })
        eq(r.ok, true, 'POST /api/export → ok')
        outRel = r.to || ''
        yes(/^\.导出\/.*\.html$/.test(outRel), `导出到 .导出/ 里（相对 data/ 的路径）：${outRel}`)
        const abs = path.join(DATA, ...outRel.split('/'))
        yes(fs.existsSync(abs), '盘上真的有这个文件')
        html = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
        yes(html.length > 500, `文件不是空的（${Math.round(html.length / 1024)} KB）`)
        /* ⚠ `r.bytes` 是**盘上的字节数**（UTF-8），而 `html.length` 是**字符数**
           （JS 字符串）。中文一个字 3 字节、算 1 个字符 —— 拿它俩直接比，
           中文越多的文档差得越远。要比就跟 `Buffer.byteLength` 比。 */
        const diskBytes = fs.existsSync(abs) ? fs.statSync(abs).size : 0
        eq(r.bytes, diskBytes, '报回来的体积和盘上一致（字节数，不是字符数）')
        yes(diskBytes > html.length, `中文占的字节比字符多（${diskBytes} 字节 / ${html.length} 字符）—— 所以上面那条必须比字节`)
      }

      /* ② 它是个**完整的** HTML 文档（能双击打开的那种），不是片段 */
      {
        yes(/^<!doctype html>/i.test(html.trim()), '开头是 <!doctype html>（是个完整文档，不是片段）')
        yes(html.includes('<meta charset="UTF-8">'), '带 UTF-8 声明（中文不乱码的前提）')
        yes(html.includes('name="viewport"'), '带 viewport（手机上不缩成一坨）')
        yes(html.trim().endsWith('</html>'), '结尾是 </html>（没被截断）')
      }

      /* ③ ★ 三样机器记号都**翻译**了 —— 这是导出存在的全部理由 */
      {
        /* 公式：KaTeX 会吐出 <span class="katex">，而原文里的 $ 不该原样留着 */
        const hasKatex = html.includes('class="katex"')
        yes(hasKatex, '★ 公式排出来了（文档里有 KaTeX 吐的节点）')
        /* ★ 降级路径会留下 `class="math-bad"`（公式原文摆出来）。**素材里一个都不该有** ——
           有的话说明"排不出来的路"被走了，而屏幕上看不出区别（这就是最难查的那种）。
           断言写成"0 个"而不是"可以用"，因为这一条正是为了抓"katex 没接上"。
           （真要让某条公式排不出来时，那应该是**另一个**专门的用例，不是这条。） */
        const mathBad = (html.match(/class="math-bad"/g) || []).length
        eq(mathBad, 0, '没有公式掉进降级路（一个 math-bad 都不该有）')
        const dollars = (html.match(/\$/g) || []).length
        yes(dollars <= 4, `原文里的 $ 记号基本都消化掉了（还剩 ${dollars} 个）`)
        yes(html.includes('class="math"'), '公式被包在 .math 里（和界面上那一套同一个类名）')

        /* 引用：应该变成**能点的锚点链接**，而不是 [[B]] 这两个方括号。
           ★ 这条是 2026-09-18 那个 bug 的守卫：当时 export-html.js 传给 inline 的
             对象里 `resolve` 根本没传、`anchorOf` 又是个 Map（不可调用），
             于是**每一个** [[B]] 都走了"断引用"分支 —— 屏幕上排版全对，
             发出去全是灰虚线、点不动。所以这里必须**同时**断言：
               ① 有链接  ② 链接指向的锚点真的在文档里  ③ 没有意外的歪引用 */
        const refLinks = [...html.matchAll(/<a class="ref" href="#([^"]+)"/g)].map((m) => m[1])
        yes(refLinks.length > 0, `★ [[引用]] 变成了能点的锚点链接（${refLinks.length} 处）`)
        /* ★ 光"变成链接"不够 —— 链接的**标签**也得是给人看的样子。
           2026-09-18 踩过：`exportNoteHtml` 没给 inline.js 传 `refLabel`，
           于是链接长得是 `<a class="ref" href="#n26">[[B]]</a>`：
           形状全对、点得动、自检绿 —— 但同学看到的是**一对中括号**。
           导出的本职就是把 `[[ ]]` 这种机器记号翻译成人话（见文件头），
           所以这里断言：链接里的字**不许**再带方括号。
           对照组：断引用**故意**留着记号（见 export-html.js 里那段说明），
           所以只查 `a.ref`，不查 `span.ref.dangling`。 */
        const refTexts = [...html.matchAll(/<a class="ref" href="#[^"]+">([^<]*)<\/a>/g)].map((m) => m[1])
        const bracketLabels = refTexts.filter((t) => t.includes('[[') || t.includes(']]'))
        eq(bracketLabels, [], '★ 引用链接的字面已摘掉 [[ ]]（发给同学的不该出现机器记号）')
        yes(refTexts.length > 0 && refTexts.every((t) => t.trim()), '引用链接都有可见文字（不是空标签）')
        const dangling = (html.match(/class="ref dangling"/g) || []).length
        /* 素材里那一节 `## 四、量` 定义了 B/mu0/I/r/F/q/v/Phi/t，正文引用全都指得到 —— 
           所以断引用应该是 **0**。有的话就是接线又断了。 */
        eq(dangling, 0, '没有断引用（素材里那些 [[B]] 都有定义节点）')
        const anchorIds = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
        const missing = [...new Set(refLinks)].filter((a) => !anchorIds.has(a))
        eq(missing, [], '每个引用链接的 #锚点 都在文档里（点过去有东西，不是空跳）')
        yes(html.includes('id="glossary"'), '底部有名词表（引用跳过去的目标之一）')

        /* 分层：## 变成真正的标题，缩进变成嵌套容器 */
        yes(/<h[2-6] class="sec-h"/.test(html), '★ `## 节` 变成了真正的标题元素')
        yes(html.includes('class="it-kids"'), '★ 缩进变成了嵌套容器（子节点真的在父节点里面）')
        yes(html.includes('class="it-title"'), '节点名字有自己的一行')
        yes(html.includes('class="it-fields"'), '字段（公式 / 说的是 / 用到的量…）排成了小块')
      }

      /* ④ 断网也能看：字体是内联的，不许有外部资源 */
      {
        yes(!/<link[^>]+href="https?:/i.test(html), '没有外部样式表（断网也长一个样）')
        yes(!/<script[^>]+src="https?:/i.test(html), '没有外部脚本（不靠别人的服务器）')
        yes(!/url\(['"]?https?:/i.test(html), 'CSS 里没有外部 url()（字体若嵌了就是 data:）')
        yes(html.includes('@media print'), '带打印样式（以后想存 PDF 就有基础了）')
        yes(html.includes('@media (max-width:600px)'), '带手机上那一套（窄屏缩进收窄、字号略小）')
      }

      /* ⑤ 内联字体：给了清单就得真的嵌进去 */
      {
        const r = await post('/api/export', {
          name: NOTE,
          title: 'zz 导出夹具',
          fonts: 'KaTeX_Main|KaTeX_Math|这是假的|../../etc/passwd',
        })
        eq(r.ok, true, '带字体清单再导一次 → ok')
        const abs = path.join(DATA, ...String(r.to).split('/'))
        const h2 = fs.readFileSync(abs, 'utf8')
        yes(h2.includes('data:font/woff2;base64,'), '★ 字体真的内联进去了（data:font/woff2;base64,…）')
        yes(!h2.includes('passwd'), '清单里塞的怪名字被挡掉了（只认 KaTeX_ 开头那一族）')
        const faces = (h2.match(/@font-face\{/g) || []).length
        yes(faces >= 2, `@font-face 声明了 ${faces} 条（两个族、含各自的变体）`)
        yes(h2.includes("font-family:'KaTeX_Main'"), '字体族名写对了（挂在 KaTeX_Main 上）')
        /* 内联之后文件会大很多，但那是"点开就能看"的价钱 */
        const kb2 = Math.round(h2.length / 1024)
        yes(kb2 > Math.round(html.length / 1024), `内联字体之后文件变大（${kb2} KB）—— 断网也能看的代价`)
      }

      /* ⑥ ★ 绝不覆盖：再导一次得**另起一个名字**，上一份一个字都不动 */
      {
        const before = fs.readdirSync(path.join(DATA, '.导出')).sort()
        const r = await post('/api/export', { name: NOTE, title: 'zz 导出夹具', fonts: '' })
        const after = fs.readdirSync(path.join(DATA, '.导出')).sort()
        eq(after.length, before.length + 1, '同名的导出往后排了（多出一个，不是覆盖）')
        yes(after.includes('zz-导出夹具 2.html'), `第二份叫「zz-导出夹具 2.html」：${after.join(' , ')}`)
        /* 第一份还在，而且**内容还是第一份的**（没被第二份的字节改掉） */
        const first = fs.readFileSync(path.join(DATA, '.导出', 'zz-导出夹具.html'), 'utf8')
        yes(first.length > 0 && first.includes('<!doctype html>'), '第一份导出还在、还是完整的')
      }

      /* ⑦ 导出的东西**不进左栏**（`.导出` 点开头，列表跳过它） */
      {
        const list = await get('/api/list')
        const names = list.files.map((f) => f.name)
        yes(!names.some((n) => n.includes('.导出')), '左栏列表里没有导出目录（. 开头被跳过）')
        yes(!list.folders.includes('.导出'), '目录列表里也没有它')
        yes(names.includes(NOTE), '夹具笔记自己还在列表里（只跳过导出，没跳过别的）')
      }

      /* ⑧ 找不到的笔记：得拒绝，不能凭空导出一份空的 */
      {
        const r = await post('/api/export', { name: 'zz-根本没有这份.md', fonts: '' })
        yes(!!r.error, '导一份不存在的笔记 → 报错，不是"导出成功但内容是空的"')
        eq(r.error, '这份笔记不在了（可能在别处改过名）', '那句错话说得清楚')
        const r2 = await post('/api/export', { name: '../../evil.md', fonts: '' })
        yes(!!r2.error, '名字里夹 `..` → 拒掉（不许跑到 data/ 外面）')
      }

      /* ⑨ ★ 「打开导出文件夹」这一条路收得很窄 —— 它能让本机开资源管理器，
             所以只能开导出目录，别处一律拒 */
      {
        const r = await post('/api/reveal', { path: '.导出' })
        eq(r.ok, true, 'POST /api/reveal {path:".导出"} → ok（这是用户找到文件的那条路）')
        yes(fs.existsSync(path.join(DATA, '.导出')), '导出目录真的在（第一次导出时就建出来了）')

        /* ⚠ 这条闸有**两道**，拒的理由不一样，得分清楚（2026-09-18 踩过）：
             ① `normalizeRel` 就过不去      → 400「非法路径」
             ② 过了校验、但不在导出目录里    → 403「只能打开导出目录」
           原来这里拿 `path:'.'` 去测第②道 —— 但 `.` 在第一道就被丢了（段是 `.` 就 skip，
           结果空 → null），所以它回的是「非法路径」。断言期望「只能打开导出目录」，
           于是**红的**，看着像闸坏了，其实闸好好的，是我拿错了钥匙。 */
        const bad1 = await post('/api/reveal', { path: '大物' })
        eq(bad1.error, '只能打开导出目录', '要开笔记目录 → 拒的那句话（过了校验、但不在导出目录里）')
        /* 根目录也一样过不了第②道（`data/` 自己就不是导出目录）。
           用 `.导出/..` 拼出来的「回到根」同样该被拒 —— 它在第②道被判掉。 */
        const bad0 = await post('/api/reveal', { path: '.' })
        eq(bad0.error, '非法路径', '要开 data/ 根 → 拒（`.` 在校验那一关就没了，走的是另一句话）')

        for (const [p, why] of [
          ['../../Windows', '`..` 修都不修'],
          ['C:/Windows', '盘符路径'],
          ['/etc', '以 / 开头'],
        ]) {
          const b = await post('/api/reveal', { path: p })
          eq(b.error, '非法路径', `要开 ${p} → 拒（${why}）`)
        }
        /* 子目录是允许的：以后按层分导出，得能开进去 */
        const sub = await post('/api/reveal', { path: '.导出/子层' })
        eq(sub.ok, true, '导出目录**里面**的子目录 → 允许（以后按层分导出要用）')
      }

      /* ⑩ 导出是**单向快照**：它读笔记、写 html，绝不反着来 */
      {
        const noteAbs = path.join(DATA, NOTE)
        const before = fs.readFileSync(noteAbs, 'utf8')
        await post('/api/export', { name: NOTE, fonts: '' })
        const after = fs.readFileSync(noteAbs, 'utf8')
        yes(before === after, '★ 导出之后原笔记**一个字节都没变**（单向快照，永不回写）')
        const mtimeList = await get('/api/list')
        const f = mtimeList.files.find((x) => x.name === NOTE)
        yes(!!f, '笔记还在列表里、mtime 没被搅乱')
      }

      /* ⑪ 分层里的笔记：导出跟着它走（同一层的 .导出 里），不是全堆在根上 */
      {
        const nested = '大物/电磁学/zz-分层笔记.md'
        await post('/api/new', { name: nested, text: '# 分层的一课\n\n- 一条\n  - 公式 | $a^2+b^2=c^2$\n' })
        const r = await post('/api/export', { name: nested, fonts: '' })
        eq(r.ok, true, '导一份在子层里的笔记 → ok')
        eq(r.to, '大物/电磁学/.导出/zz-分层笔记.html', '导出落在**它自己那一层的** .导出 里（跟着笔记走）')
        yes(fs.existsSync(path.join(DATA, '大物', '电磁学', '.导出', 'zz-分层笔记.html')), '盘上真的在那儿')
        eq(r.dir, '大物/电磁学/.导出', '报回来的目录也是那一层（"打开文件夹"要跳对地方）')
      }

      /* ⑫ 没有 JS 报错、没有 500 */
      {
        const errs = log.join('').split('\n').filter((l) => /请求出错|TypeError|ReferenceError|SyntaxError/.test(l))
        eq(errs.length, 0, '服务端日志里没有未捕获的错' + (errs.length ? '：' + errs.join(' | ') : ''))
      }
    }
  } finally {
    kill()
  }
}

console.log(`\n  合计 ${checks} 项，失败 ${fails} 项\n`)
if (fails) process.exitCode = 1
