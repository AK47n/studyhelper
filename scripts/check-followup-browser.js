/* check-followup-browser：**框选追问**那条链路的端到端（真浏览器 + 真本地服务 + 假识别服务）。
 *
 * 纯逻辑那一半在 check-askfollow.js（84 条断言，node 里跑）。这一条盯的是**只有真跑一遍
 * 才看得见**的那几件事：
 *   [1] 「？问这里」在工具条上、点得到（真鼠标 + elementFromPoint，不是 eval 里 .click()）；
 *   [2] 它**在有课件页面的框里是亮的、在别的框里是灰的**（灰的时候 title 要说清下一步）；
 *   [3] 点它 → 页边浮出小窗（**不是**弹层、没有遮罩、位置在选区旁边）；
 *   [4] 点「问」→ 发出去的包里**两张图**（整页 + 裁图）、`mode=ask`、
 *       提示词里有页码和问题、第一张图上真的有红框（从像素里验，不从代码里猜）；
 *   [5] ★ **不点「留到板上」就一个字节都不变**（这个功能的定义是"答案浮在页边"，
 *       要留在板上得你**自己按**那颗按钮 —— ADR-0006）；
 *   [6] 接着问第二句 → 带上第一轮（`history` 里问过的两句都在）；窗里两条都看得见；
 *   [7] Esc / ✕ 关得掉，而且关掉之后**板上那一圈高亮也没了**；
 *   [8] 页面上没有 JS 报错。
 *   [9]–[12] ★ 「⬇ 留到板上」（2026-09-22，ADR-0006）：板文件里真多**一张**卡
 *       （整段问答 + `rich` + `ask` 那三个字段）、贴在第 2 页右边那一栏、
 *       按钮变成「✓ 已在板上」、窗不收；卡片上那颗「◎」能把当时圈的那一块亮出来；
 *       **Ctrl+Z 一步**退回去（板文件回到一个字节都不差原来那份）。
 *
 * ── 假识别服务 ─────────────────────────────────────────────────────────
 * DeepSeek 的形状（OpenAI 兼容）。它把**收到的东西**记下来给这里查：
 * 几张图、提示词里有没有"第 N 页"和那句话、多轮带了几条。
 * 回话是一个固定的人话段（夹着 `$F=ma$` —— 回答里的式子要能排出来）。
 *
 * 它自己起服务（5237）和 headless Edge（9277），跑完都收掉；夹具板 board-zz-followup.md
 * 和夹具 PDF .资料/zz-followup-smoke.pdf 都自造自删；用户那张板一个字节都不动（守卫盯着）。
 *
 * 用法：node scripts/check-followup-browser.js   （或 npm run check:followup-browser）
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { withBoard, DATA, ROOT } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'
import { ASK_BUTTON } from '../src/lib/followup.js'
import { KEEP_BUTTON } from '../src/lib/answer-cards.js'

const MOCK_PORT = Number(process.env.FOLLOWUP_TEST_MOCK_PORT || 5204)
const TEST_TOKEN = 'sk-followup-test-0123456789'

const FIX_PDF = path.join(DATA, '.资料', 'zz-followup-smoke.pdf')
const FIX_NAME = '.资料/zz-followup-smoke.pdf'

/* ── 把用户自己的识别配置挪开（和 check-deck / check-ocr-browser 同一条规矩）──
 * `loadConfig` 只在**没有** config/ocr.json 时才读环境变量，所以自检必须先把它挪开。
 * ⚠ 这个文件在 .gitignore 里：**弄丢就找不回来**（里面是密钥），
 *   所以收尾那一段无条件放回去；上一次没跑完留下的备份**改名留着不删**
 *   （2026-09-20 真的丢过一次，见 check-deck.js 那一段的完整说明）。 */
const realConfig = path.join(ROOT, 'config', 'ocr.json')
const stash = realConfig + '.checkfollowup-bak'
let stashed = false

function stashConfig() {
  try {
    if (!fs.existsSync(realConfig)) return
    if (fs.existsSync(stash)) {
      const keep = stash + '.' + new Date().toISOString().replace(/[:.]/g, '-')
      try {
        fs.renameSync(stash, keep)
        console.log('  （上次没跑完留下的备份留着没删：config/' + path.basename(keep) + '）')
      } catch {}
    }
    fs.renameSync(realConfig, stash)
    stashed = true
  } catch (e) {
    console.log('  （挪 config/ocr.json 失败：' + String(e && e.message) + '）')
  }
}

function restoreConfig() {
  try {
    if (fs.existsSync(stash)) {
      fs.renameSync(stash, realConfig)
      console.log('  （你原来的 config/ocr.json 已经放回去了）')
    } else if (stashed) {
      console.log('  ⚠ 备份不见了 —— config/ocr.json 可能没放回去，去 config/ 里看一眼')
    }
    for (const n of fs.readdirSync(path.join(ROOT, 'config'))) {
      if (/^ocr\.json\.checkfollowup-bak\./.test(n)) {
        console.log('  ⚠ config/' + n + ' 是**更早一次**留下的备份 —— 里面可能是你的真密钥，')
        console.log('    确认一下 config/ocr.json 里那个 key 对不对，不对就把这份改名回去。')
      }
    }
  } catch (e) {
    console.log('  ⚠ 放回 config/ocr.json 失败：' + String(e && e.message) + ' —— 备份在 ' + stash)
  }
}

stashConfig()

/* ── 夹具 PDF：两页，每页一个页码大字 + 一个深色方块（红框画在上面看得见）──
   手写 PDF 字节，不引第三方（和 check-deck.js 那份同一个路子）。 */
function buildPdf(n) {
  const objs = []
  const firstPage = 4
  const kids = []
  for (let i = 0; i < n; i++) kids.push(`${firstPage + 2 * i} 0 R`)
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < n; i++) {
    const pno = firstPage + 2 * i
    const cno = pno + 1
    objs[pno] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 540] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cno} 0 R >>`
    /* 左下角一个深色方块：裁图那一块要有点东西，"红框画上去了"才验得出来。 */
    const stream = `0.9 0.9 0.9 rg 40 40 640 460 re f 0.15 0.15 0.15 rg 60 60 120 90 re f BT /F1 48 Tf 300 250 Td (P${i + 1}) Tj ET`
    objs[cno] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  }
  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out))
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefAt = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'utf8')
}

/* ── 假识别服务：记账 + 回一段人话 ── */
const seen = []
let mockCode = 200
const REPLY = '这里用的是牛顿第二定律：合外力决定加速度，写成 $F=ma$。\n\n注意它只在惯性系里成立 —— 换个参考系就得补惯性力。'
const mock = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let json = null
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {}
    const msgs = (json && json.messages) || []
    const first = (msgs[0] && msgs[0].content) || []
    const imgs = Array.isArray(first) ? first.filter((c) => c.type === 'image_url') : []
    const promptText = Array.isArray(first) && first[0] ? String(first[0].text || '') : ''
    const sizes = imgs.map((c) => {
      const b64 = String((c.image_url && c.image_url.url) || '').replace(/^data:image\/\w+;base64,/, '')
      const buf = Buffer.from(b64, 'base64')
      return { bytes: buf.length, jpeg: buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, buf }
    })
    seen.push({
      url: req.url,
      model: json ? json.model : null,
      temperature: json ? json.temperature : null,
      images: sizes.length,
      imgBytes: sizes.map((s) => s.bytes),
      imgJpeg: sizes.map((s) => s.jpeg),
      /* 第二张（裁图）的像素宽度：JPEG 要扫 SOF 段才拿得到，
         这里只留前 512 字节给下面那个 helper 去读。 */
      img2Head: sizes[1] ? sizes[1].buf.subarray(0, 4096) : null,
      img1Head: sizes[0] ? sizes[0].buf.subarray(0, 4096) : null,
      promptText,
      messages: msgs.length,
      roles: msgs.map((m) => m.role),
      /* 每一条的 content 是什么形状（`S:长度` / `A:块数`）——
         这条是 2026-09-22 查"看不见的差异"时加的，留着很便宜：
         `{role,text}` 直接拼进 messages 就会变成 `undefined` 那种 bug，
         只有把**上游真收到的形状**打出来才看得见。 */
      contentKinds: msgs.map((m) => (typeof m.content === 'string' ? 'S:' + m.content.length : Array.isArray(m.content) ? 'A:' + m.content.length : String(typeof m.content))),
      /* ⚠ 收 user 条的时候要**如实记下 content 是什么形状**（数组 / 字符串 / 别的）——
         2026-09-22 在这里栽过：服务端把 `{role, text}` 直接拼进 messages，
         于是上游收到的是"没有 content 的 assistant 消息"（模型看到一条空话），
         而自检当时查的是我们自己的字段，绿得很。判据必须落在**上游真收到的东西**上。 */
      userShapes: msgs.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? 'text' : Array.isArray(m.content) ? 'blocks:' + m.content.length : String(typeof m.content))),
      userTexts: msgs.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content),
      assistantTexts: msgs.filter((m) => m.role === 'assistant').map((m) => String(m.content)),
      hasPageLine: /第 \d+ 页/.test(promptText),
      pageInPrompt: (() => {
        const m = /第 (\d+) 页/.exec(promptText)
        return m ? Number(m[1]) : 0
      })(),
    })
    const send = () => {
      try {
        if (res.destroyed) return
        if (mockCode !== 200) {
          res.writeHead(mockCode, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: '假的失败' } }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: REPLY } }] }))
      } catch {}
    }
    send()
  })
})

const mockUp = await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r(true)))
if (!mockUp) console.log('  ⚠ 假识别服务没起来（端口 ' + MOCK_PORT + '）')

/* ── 夹具板：一份两页的资料摆在 (0,0)，宽 600 ──
   页面高 = 600 × 540/720 = 450，页距 DOC_PAGE_GAP=20。
   ⚠ PDF 本体**必须真的写进 data/.资料/**：追问要现场渲染一页出来（整页 + 裁图），
     pdf.js 拿不到这个文件就 404 —— 而界面上那句"这一页的图没造出来"看起来
     很像渲染坏了，其实是夹具没铺（第一版就是这么踩的）。 */
const DOC_W = 600
const PAGE_H = (DOC_W * 540) / 720
function makeBoard() {
  fs.mkdirSync(path.dirname(FIX_PDF), { recursive: true })
  fs.writeFileSync(FIX_PDF, buildPdf(2))
  const b = newBoard('followup 自检夹具（跑完自动删除）')
  b.docs = [{ id: 'doczzfu1', path: FIX_NAME, title: '追问冒烟课件', x: 0, y: 0, w: DOC_W, pages: [[720, 540], [720, 540]] }]
  return serializeBoardDocument(b)
}

/* 从 JPEG 字节里读宽高（扫 SOF 段）——"发出去的图到底多大"只信字节。 */
function jpegSize(buf) {
  if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    /* SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 —— 都带尺寸 */
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

const fails = await withBoard(
  {
    tag: 'followup',
    port: 5237,
    cdpPort: 9277,
    make: makeBoard,
    /* 指向假识别服务 + 一个假密钥（真密钥一次都没出过这台机器） */
    env: {
      STUDYHELPER_OCR_PROVIDER: 'deepseek',
      STUDYHELPER_OCR_DS_BASE: `http://127.0.0.1:${MOCK_PORT}/chat/completions`,
      STUDYHELPER_OCR_MODEL: 'deepseek-flash',
      STUDYHELPER_OCR_TOKEN: TEST_TOKEN,
    },
    settleMs: 2600,
  },
  async ({ s, ok, bad, open, raw, after, until, drift }) => {
    after(() => {
      restoreConfig()
      try {
        if (fs.existsSync(FIX_PDF)) fs.rmSync(FIX_PDF, { force: true })
      } catch {}
    })

    await open()

    /* ── 找按钮 / 量命中：一律真鼠标 + elementFromPoint ──────────────────
       这个仓库在这上面栽过三次（卡片 / 美化 / 复制都是"看得见点不到"），
       所以凡是浮出来的按钮，都要验"它量到的那一点上真的是它"。 */
    const rectOfText = (sel, text) =>
      s.eval(`(() => {
        for (const b of document.querySelectorAll(${JSON.stringify(sel)})) {
          if (b.textContent.includes(${JSON.stringify(text)})) {
            const r = b.getBoundingClientRect()
            const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
            const at = document.elementFromPoint(cx, cy)
            return { x: cx, y: cy, hit: at ? (at.className || at.tagName) : null, disabled: !!b.disabled, title: b.title || '' }
          }
        }
        return null
      })()`)

    const clickAt = async (p) => {
      if (!p) return false
      await s.mouse(p.x, p.y)
      return true
    }

    /* ── [1] 工具条上那颗按钮：在、点得到 ── */
    const topBtn = await rectOfText('.bd-tools .bd-t', ASK_BUTTON)
    if (!topBtn) bad(`工具条上找不到「${ASK_BUTTON}」那颗按钮`)
    else {
      ok(`工具条上有「${ASK_BUTTON}」（${topBtn.x},${topBtn.y}）`)
      if (/bd-t/.test(topBtn.hit || '')) ok('它量到的位置和命中是同一个人（真鼠标点得到）')
      else bad('按钮的位置和命中对不上，点它会落空：' + JSON.stringify(topBtn))
      /* ★ 工具条那颗**不做成灰的**（和「美化手写」同一条理由）：
         可点 + 当场说清下一步，比一颗点不动的灰按钮省事。 */
      if (!topBtn.disabled) ok('没框住东西时它**不是灰的**（点了会给一句下一步，而不是"点了没反应"）')
      else bad('没框住东西时那颗按钮是灰的 —— 用户会以为功能坏了')
    }

    /* ── [2] 没框东西就点它 → 一句人话，不开窗 ── */
    if (topBtn) {
      await clickAt(topBtn)
      const said = await until(
        async () => {
          const t = await s.eval(`(() => { const el = document.querySelector('.toast .toast-msg'); return el ? el.textContent.trim() : '' })()`)
          return t ? t : undefined
        },
        { timeout: 3000, what: '提示语' }
      )
      const opened = await s.eval(`!!document.querySelector('.bd-ask')`)
      if (!opened) ok('没框东西时点它**不开窗**' + (said.ok ? `，而是说了一句：${said.value}` : '（但也没看到提示语）'))
      else bad('什么都没框就开出了追问小窗 —— 它没有可问的那一块')
    }

    /* ── [3] 在**第 2 页**上画一笔，框住它 ──────────────────────────────
       用鼠标（不是笔）画：这个自检不测"笔让路卡片"那条，鼠标更省事。
       画在第 2 页中间那一带，好让"这一块在第几页"这条断言有意义。 */
    const pageRect = await s.eval(`(() => {
      const els = [...document.querySelectorAll('.bd-docpage')]
      const e = els.find((x) => x.getAttribute('data-doc-page') === '2')
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })()`)
    if (!pageRect) {
      bad('板上看不到第 2 页（.bd-docpage[data-doc-page="2"]）—— 夹具的课件没铺上？')
      return
    }
    ok(`夹具课件第 2 页在屏幕上 ${Math.round(pageRect.left)},${Math.round(pageRect.top)} ${Math.round(pageRect.w)}×${Math.round(pageRect.h)}`)
    /* 在页面中间偏上画一条横线（用鼠标拖一个小笔画）。 */
    const lineY = Math.round(pageRect.top + pageRect.h * 0.35)
    await s.drag(Math.round(pageRect.left + pageRect.w * 0.3), lineY, Math.round(pageRect.w * 0.28), 8, { steps: 10, button: 'left' })
    const strokeOK = await until(
      async () => {
        const n = await s.eval(`(() => { const c = document.querySelector('canvas.bd-ink'); return c ? Number(c.getAttribute('data-strokes') || 0) : 0 })()`)
        return n > 0 ? n : undefined
      },
      { what: '画上去的那一笔进了画布' }
    )
    if (strokeOK.ok) ok('在第 2 页上画了一笔（画布报了 ' + strokeOK.value + ' 笔）')
    else bad('画了一笔但画布上没有笔迹（拖的是空白？）')

    /* ── [4] 切「⬚ 框选」，框住那一笔 → 浮层上出现「？问这里」并且**是亮的** ── */
    await s.eval(`(() => { const b = document.querySelector('.bd-tools [data-tool="select"]'); if (b) b.click(); return true })()`)
    await s.sleep(200)
    /* 框住刚才那一笔：**框要比那一笔大一圈**（笔迹是一条横线，拖出来的框得把它整条圈住）。
       落在第 2 页上（那一笔就在第 2 页），所以下面"页号 = 2"这条才有意义。 */
    await s.drag(
      Math.round(pageRect.left + pageRect.w * 0.15),
      Math.round(pageRect.top + pageRect.h * 0.2),
      Math.round(pageRect.w * 0.55),
      Math.round(pageRect.h * 0.35),
      { steps: 8, button: 'left' }
    )
    const boxed = await until(
      async () => ((await s.eval(`!!document.querySelector('.bd-inkbox')`)) ? 'ok' : undefined),
      { what: '框选的包围框' }
    )
    if (boxed.ok) ok('框选生效（出现了 .bd-inkbox）')
    else bad('框选没生效 —— 后面那些断言都无从谈起')

    /* ★★ 2026-09-22 记一笔：这个 bug 就是下面 [5] 那条断言抓出来的 ——
       `strokesBBox` 交回来的是 `{x0,y0,x1,y1}`，而 Board 里按 `{x,y,w,h}` 读了
       （`x1/y1` 成了 undefined → `normBox` 判它不合法 → **按钮永远是灰的**），
       而纯逻辑自检全绿（它喂的是手写的框）。所以这里必须盯一次
       "框选包围框"和"追问高亮框"**是不是同一块地方**（见 [5]）。 */

    const askBtn = await rectOfText('.bd-inkacts button[data-tool="askink"]', ASK_BUTTON)
    if (!askBtn) bad(`选区浮层上没有「${ASK_BUTTON}」`)
    else {
      ok(`框住课件页上的一块之后，浮层上出现了「${ASK_BUTTON}」`)
      if (!askBtn.disabled) ok('★ 这一块落在课件页面上 → 按钮是**亮的**（data-ink-ask 报出了页号）')
      else bad('框在课件页面上，按钮却是灰的：' + JSON.stringify(askBtn))
      if (/bd-inkask/.test(askBtn.hit || '')) ok('它的位置和命中是同一个人（真鼠标点得到）')
      else bad('浮层上那颗按钮的位置和命中对不上：' + JSON.stringify(askBtn))
      const pageAttr = await s.eval(`(() => { const b = document.querySelector('.bd-inkask'); return b ? Number(b.getAttribute('data-ink-ask') || 0) : -1 })()`)
      if (pageAttr === 2) ok('★ 它算出来的是**第 2 页**（几何算的，不是让用户选页号）')
      else bad('页号算错了：data-ink-ask = ' + pageAttr + '（期望 2）')
    }

    /* ── [4′] ★★ 「框里没有笔」也必须能问（2026-09-21 用户报的 bug）──────────
       用户原话：「我框选的肯定是 ppt 上的一部分或者解说卡片啊，我不可能框选我自己的字迹，
       但是他要求必须框选字迹，这个就有问题了」。
       根子：`askRegion` 从 `sel.strokes`（**选中的笔**）算包围盒，而"框里没有笔"被表达成
       `FOCUS_NONE` —— 那个**矩形**跟着丢了。于是圈住课件空白处去点它，会被回一句
       「框里没有课件页面」，而那句话是**错的**（圈里明明就是课件）。
       这一节就盯这一件事：**一筆都不框，只圈课件** → 按钮照样亮、窗照样开、页号照样对。
       ⚠ 必须圈在**第 2 页上没有笔**的那一带：上面那笔在第 2 页偏上，所以这一节圈**下半页**。 */
    {
      const bare = await s.eval(`(() => {
        const els = [...document.querySelectorAll('.bd-docpage')]
        const e = els.find((x) => x.getAttribute('data-doc-page') === '2')
        if (!e) return null
        const r = e.getBoundingClientRect()
        return { left: r.left, top: r.top, w: r.width, h: r.height }
      })()`)
      if (!bare) bad('看不到第 2 页 —— [4′] 无从谈起')
      else {
        /* 先清掉上一次的选区（[4] 里框住过那一笔）：点一下空白，让焦点归零。 */
        await s.eval(`(() => { const b = document.querySelector('.bd-tools [data-tool="select"]'); if (b) b.click(); return true })()`)
        await s.sleep(150)
        /* 圈**下半页**（那一带没有笔 —— 上面那笔在 0.35 处）。 */
        await s.drag(
          Math.round(bare.left + bare.w * 0.15),
          Math.round(bare.top + bare.h * 0.62),
          Math.round(bare.w * 0.6),
          Math.round(bare.h * 0.28),
          { steps: 8, button: 'left' }
        )
        await s.sleep(250)
        /* ① 框选本身生效了（.bd-inkbox 是屏幕上那个虚线框 —— 它现在**不靠笔**也画得出来） */
        const boxOn = await s.eval(`!!document.querySelector('.bd-inkbox')`)
        if (boxOn) ok('★★ 圈的是**课件空白处**（一筆都没有）→ 框选照样生效（.bd-inkbox 在）')
        else bad('★ 框里没有笔，连虚线框都画不出来 —— "我圈了哪一块"这件事丢了')

        /* ② 浮层上那颗「？问这里」**亮着** */
        const bareBtn = await rectOfText('.bd-inkacts button[data-tool="askink"]', ASK_BUTTON)
        if (!bareBtn) bad(`★ 圈课件空白处时，浮层上**没有**出现「${ASK_BUTTON}」`)
        else {
          if (!bareBtn.disabled) ok('★★ 框里一筆都没有，那颗「？问这里」仍然是**亮的**（这一条就是那个 bug 的判据）')
          else bad('★ 框里没笔 → 按钮是灰的 —— 这正是用户报的「必须框选字迹」：' + JSON.stringify(bareBtn))
          const barePage = await s.eval(`(() => { const b = document.querySelector('.bd-inkask'); return b ? Number(b.getAttribute('data-ink-ask') || 0) : -1 })()`)
          if (barePage === 2) ok('★ 一筆不框也照样算出**第 2 页**（几何说了算，不是"圈到笔"说了算）')
          else bad('★ 没框到笔时页号算错了：data-ink-ask = ' + barePage + '（期望 2）')

          /* ③ 点它 → 窗真的开出来，而且指的是第 2 页 */
          await clickAt(bareBtn)
          const opened = await until(
            async () => {
              const v = await s.eval(`(() => { const b = document.querySelector('.bd-ask'); return b ? Number(b.getAttribute('data-ask-page') || 0) : 0 })()`)
              return v || undefined
            },
            { what: '没框到笔也要能开窗' }
          )
          if (opened.ok && opened.value === 2) ok('★★ 点它 → 小窗开出来了，指的是第 2 页（框里一筆没有也走得通）')
          else bad('★ 没框到笔时点「？问这里」没开出窗 / 页号不对：' + JSON.stringify(opened))
          /* 关掉，后面的节要干净的状态 */
          await s.key('Escape', 'Escape', 27)
          await s.sleep(200)
        }
      }
    }

    /* ── [5] 点它 → 页边浮出小窗（不是弹层、没有遮罩） ──
       ⚠ 这里**重新取一次**按钮坐标，不复用 [4] 那份：`rectOfText` 是现查的，
         而 [4′] 动过选区（它圈的是另一块地方）—— 复用旧坐标会点在空处，
         报出来的却是"点了没开出窗"这种假红。 */
    const before = raw()
    const askBtn2 = await rectOfText('.bd-inkacts button[data-tool="askink"]', ASK_BUTTON)
    if (askBtn2) {
      await clickAt(askBtn2)
      const up = await until(
        async () => {
          const v = await s.eval(`(() => {
            const b = document.querySelector('.bd-ask')
            if (!b) return null
            const r = b.getBoundingClientRect()
            const cs = getComputedStyle(b)
            return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], z: cs.zIndex, page: Number(b.getAttribute('data-ask-page') || 0), marks: document.querySelectorAll('.bd-askmark').length }
          })()`)
          return v || undefined
        },
        { what: '追问小窗' }
      )
      if (up.ok) ok(`点它 → 页边浮出小窗（第 ${up.value.page} 页 · 位置 ${up.value.rect.join(',')}）`)
      else bad('点了「？问这里」，小窗没出现')
      if (up.ok) {
        /* 它是"浮着的一张纸条"，不是必须回应的弹层：**没有遮罩**。
           判据：小窗区域之外的那一点上不该是小窗的祖先/遮罩。 */
        const outside = await s.eval(`(() => {
          const b = document.querySelector('.bd-ask')
          const r = b.getBoundingClientRect()
          const x = Math.max(4, r.left - 30), y = Math.round(r.top + r.height / 2)
          const at = document.elementFromPoint(x, y)
          return { cls: at ? (at.className || at.tagName) : null }
        })()`)
        if (!/bd-ask/.test(String(outside.cls))) ok('小窗外面那一点仍然是底下的画布（**没有遮罩** —— 它不是弹层）')
        else bad('小窗盖住了整屏：' + JSON.stringify(outside))
        if (up.value.marks === 1) ok('★ 板上画出了"正在问这一块"的那圈高亮（.bd-askmark）')
        else bad('没看到那一圈高亮：' + up.value.marks)
        /* ★★ 那一圈高亮必须**就在你圈的那一块上** —— 这条盯的是坐标那一族
           （世界矩形 → 屏幕、页内归一化矩形 → 世界矩形）里任何一处读错形状：
           错了之后高亮会跑到别的地方去，而**界面上一句报错都没有**。
           判据用"两个框的中心对得上"（不是像素级相等）：框选那个多让了一圈 INK_PAD，
           尺寸本来就差几个像素，但中心是同一处。 */
        const marks = await s.eval(`(() => {
          const a = document.querySelector('.bd-inkbox')
          const b = document.querySelector('.bd-askmark')
          if (!a || !b) return null
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
          return {
            a: [Math.round(ra.left + ra.width / 2), Math.round(ra.top + ra.height / 2)],
            b: [Math.round(rb.left + rb.width / 2), Math.round(rb.top + rb.height / 2)],
            size: [Math.round(rb.width), Math.round(rb.height)],
          }
        })()`)
        if (marks && Math.abs(marks.a[0] - marks.b[0]) <= 10 && Math.abs(marks.a[1] - marks.b[1]) <= 10) {
          ok(`★ 高亮框和你圈的那一块是同一处（中心 ${marks.b.join(',')}，尺寸 ${marks.size.join('×')}）`)
        } else {
          bad('高亮框不在你圈的地方 —— 世界矩形 / 页内矩形有一条算错了：' + JSON.stringify(marks))
        }
      }
    }

    /* ── [6] 点「问」→ 两张图、mode=ask、提示词带页码和问题 ── */
    const askNow = async (text) => {
      /* ① 先等**这一问可以问**：两张图造好了、上一问也答完了
         （图没好或者还在等回答时，那颗按钮不在 —— 显示的是「停止」）。 */
      const ready = await until(
        async () => {
          const v = await s.eval(`(() => {
            const b = document.querySelector('.bd-ask-btn.primary')
            const busy = !!document.querySelector('.bd-ask-say.pending')
            return { has: !!b, busy }
          })()`)
          return v && v.has && !v.busy ? v : undefined
        },
        { timeout: 25000, what: '这一问可以问了（图造好了、上一问也答完了）' }
      )
      if (!ready.ok) {
        const st = await s.eval(
          `(() => ({ primary: !!document.querySelector('.bd-ask-btn.primary'), pending: !!document.querySelector('.bd-ask-say.pending'), foot: (document.querySelector('.bd-ask-foot') || {}).textContent || '', empty: (document.querySelector('.bd-ask-empty') || {}).textContent || '' }))()`
        )
        bad('「问」一直按不了：' + JSON.stringify(st))
        return { dead: true }
      }
      /* ② **先把字打进去**再等按钮变亮 —— 「问」在输入框是空的时候是灰的（有意的：
         空着按下去只会得到一句"问点什么"）。第一版先等按钮再打字，于是第二问
         永远等不到（上一问把输入框清空了），报出来却像"灰着点不动"。 */
      await s.eval(`(() => { const t = document.querySelector('.bd-ask-ta'); if (t) { t.focus(); t.select() } return true })()`)
      if (text != null) await s.send('Input.insertText', { text })
      const lit = await until(
        async () => {
          const v = await s.eval(`(() => {
            const b = document.querySelector('.bd-ask-btn.primary')
            return b ? { disabled: !!b.disabled, draft: (document.querySelector('.bd-ask-ta') || {}).value || '' } : null
          })()`)
          return v && v.disabled === false ? v : undefined
        },
        { timeout: 5000, what: '「问」因为输入框有字而变亮' }
      )
      if (!lit.ok) {
        bad('打了字「问」还是灰的：' + JSON.stringify(await s.eval(`(document.querySelector('.bd-ask-ta')||{}).value`)))
        return { dead: true }
      }
      const p = await s.eval(`(() => {
        const b = document.querySelector('.bd-ask-btn.primary')
        if (!b) return null
        const r = b.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
        const at = document.elementFromPoint(cx, cy)
        return { x: cx, y: cy, hit: at ? (at.className || at.tagName) : null, disabled: !!b.disabled }
      })()`)
      if (!p) return null
      await s.mouse(p.x, p.y)
      return p
    }

    const firstQ = '这一步为什么能这么换？'
    const sent1 = await askNow(firstQ)
    if (!sent1) bad('找不到「问」那颗按钮')
    else if (sent1.disabled) bad('「问」是灰的（图还没造好？）：' + JSON.stringify(sent1))
    else {
      if (/bd-ask-btn/.test(sent1.hit || '')) ok('「问」量到的位置和命中是同一个人')
      else bad('「问」点不到：' + JSON.stringify(sent1))
      const answered = await until(async () => (seen.length >= 1 ? seen[0] : undefined), { timeout: 15000, what: '假识别服务收到请求' })
      if (!answered.ok) bad('点了「问」，假识别服务一次请求都没收到')
      else {
        const req = answered.value
        ok(`假识别服务收到了请求（${req.url}，model=${req.model}，temperature=${req.temperature}）`)
        if (req.images === 2) ok('★ 发出去的是**两张图**（整页 + 框里那一块放大）')
        else bad(`发出去的图有 ${req.images} 张（期望 2）`)
        if (req.imgJpeg.every(Boolean)) ok('两张都是 JPEG（' + req.imgBytes.map((n) => Math.round(n / 1024) + 'KB').join(' / ') + '）')
        else bad('有图不是 JPEG：' + JSON.stringify(req.imgJpeg))
        const s1 = jpegSize(req.img1Head)
        const s2 = jpegSize(req.img2Head)
        if (s1 && s1.w >= 1000) ok(`第一张（整页）是 ${s1.w}×${s1.h} —— 整页那一版`)
        else bad('第一张不像整页：' + JSON.stringify(s1))
        if (s2 && s2.w >= 200) ok(`第二张（裁图）是 ${s2.w}×${s2.h} —— 放大过的那一块`)
        else bad('第二张不像放大过的裁图：' + JSON.stringify(s2))
        if (req.hasPageLine && req.pageInPrompt === 2) ok('★ 提示词里写着「第 2 页」（模型据此知道讲的是哪一页）')
        else bad('提示词里的页码不对：' + req.pageInPrompt)
        /* ★★ 2026-09-22 起：那一问**不在提示词里**，它是**最后一条独立消息** ——
             为的是让第 0 条消息在每一轮里一模一样（`[提示词 + 两张图]`），
             前缀缓存才命得中（见 server-ocr.js 的 `askPrompt` 那段：从前那一问排在
             图片**之前**，于是每一轮那两张图都按未命中重付一遍）。
           所以这一条查两件事：提示词里**没有**它、消息里**有**它。
           ⚠ 别把它改回"提示词里带着我问的那句话"—— 那正是要修掉的那个形状。 */
        if (!req.promptText.includes(firstQ)) ok('★ 那一问**不在**提示词里（在的话前缀会在图片之前断掉）')
        else bad('那一问又回到提示词里了：' + JSON.stringify(req.promptText.slice(-60)))
        if (req.messages === 2 && req.userTexts.length === 1 && req.userTexts[0] === firstQ) {
          ok('第一问两条消息：图与说明 + **他问的那一句**')
        } else bad('第一问的消息形状不对：' + req.messages + ' 条 / ' + JSON.stringify(req.userTexts))
      }
      const shown = await until(
        async () => {
          const t = await s.eval(`(() => { const e = document.querySelector('.bd-ask-say'); return e ? e.textContent.trim() : '' })()`)
          return t ? t : undefined
        },
        { timeout: 10000, what: '答案显示在小窗里' }
      )
      if (shown.ok && /牛顿第二定律/.test(shown.value)) ok('答案显示在小窗里了（' + shown.value.slice(0, 24) + '…）')
      else bad('小窗里没显示答案：' + JSON.stringify(shown.value))
      /* ★ 回答里的 `$F=ma$` 要**排出来**（讲义那一套渲染）—— 生 LaTeX 学生看不懂。 */
      const tex = await s.eval(`(() => { const e = document.querySelector('.bd-ask-say .katex'); return e ? e.textContent.trim() : '' })()`)
      if (tex) ok('★ 回答里的公式排出来了（KaTeX：' + tex.slice(0, 20) + '）')
      else bad('回答里的 $F=ma$ 没被渲染（还是生 LaTeX？）')
    }

    /* ── [7] 接着问第二句 → 带上第一轮 ── */
    const secondQ = '那非惯性系里要怎么补？'
    const sent2 = await askNow(secondQ)
    if (!sent2) bad('第二问找不到「问」')
    else {
      const two = await until(async () => (seen.length >= 2 ? seen[1] : undefined), { timeout: 15000, what: '第二问的请求' })
      if (!two.ok) bad('第二问没发出去')
      else {
        const r2 = two.value
        ok(`接着问第二句发出去了（消息 ${r2.messages} 条）`)
        /* ★★ 多轮的形状（2026-09-22 改成"原样接着长"，**这里读反过一次，把正确的写死在这儿**）：
              [0] user      = 两张图 + 那段提示词（**每一轮都一模一样**，不带问题）
              [1] user      = 上一轮我问的那句
              [2] assistant = 上一轮老师答的那句
              [3] user      = **这一次问的那句话**
           ★ 为什么是"接在后面"而不是"塞进第 0 条"：第 1 轮留下的缓存前缀单元是
             `[提示词 + 两张图 + 第一问]`，第 2 轮**完整匹配**它 → 提示词和那两张图全按命中价走。
             官方「Context Caching」文档的 Example 1 就是这个形状（`A+B` → `A+B+C`）。
           ⚠ 第一版断言写的是 `[user, assistant, user]`（"先图、再问、再答"），
             于是一直报"顺序不对"—— 而**代码是对的**。当时是靠一个一次性的探针
             （单独起服务、只打这一段）才看清的：**读反的时候别改代码，先把真数据打出来**。 */
        if (r2.messages === 4) ok('★ 第二问是"第一问原样接着长"（4 条：图与说明 + 上一轮的问答 + 这一问）')
        else bad('第二问的消息条数不对：' + r2.messages + '（' + JSON.stringify(r2.roles) + '）')
        if (r2.roles.join(',') === 'user,user,assistant,user') {
          ok('顺序是 user(图 + 说明) → user(上一轮我问的) → assistant(上一轮它答的) → user(这一问)')
        } else bad('多轮的顺序不对：' + JSON.stringify(r2.roles))
        /* ★★ 这一次的判据是**量出来的**（2026-09-22 在这里来回栽了三次）：
             上游收到的四条里，只有第 1、3 条是**纯文字**的 user 条
             （第 0 条是块数组，不算），按顺序就是 —— **上一轮的问、这一次的问**。
           ⚠ 教训：这一条我改了三次断言，每次都在"猜顺序"。最后是靠把
             `roles` + `contentKinds`（每条 content 是字符串还是块数组、多长）
             打出来才定住的 —— **看不见的差异就别猜，先量**。 */
        if (r2.userTexts.length === 2 && r2.userTexts[0] === firstQ && r2.userTexts[1] === secondQ) {
          ok('历史里带着上一轮问的那句，最后一条是这一问（' + r2.userTexts[0].slice(0, 14) + '… / ' + r2.userTexts[1].slice(0, 10) + '…）')
        } else bad('user 那两条不对：' + JSON.stringify(r2.userTexts))
        /* ★ 每条消息都得**有内容**：`{role, text}` 那种"我们自己顺手写的字段"直接拼进
           messages 就是一条空消息（上游不报错、模型看到的是空白）。
           所以这里盯的是**上游真收到的形状**，不是我们自己的字段。 */
        if (r2.userShapes[0] === 'blocks:3' && r2.userShapes.slice(1).every((x) => x === 'text')) {
          ok('每条消息都带着内容（第 0 条是"图 + 文字"三块，后面是纯文字）')
        } else bad('有消息没有内容（把 {role,text} 直接拼进 messages 了？）：' + JSON.stringify(r2.userShapes))
        if (r2.assistantTexts.every((t) => t && t !== 'undefined' && t.trim())) ok('assistant 那一条也带着内容')
        else bad('assistant 那条是空的：' + JSON.stringify(r2.assistantTexts))
        if (r2.assistantTexts.some((t) => t.includes('牛顿第二定律'))) ok('上一轮的回答也在历史里（它知道自己刚才说过什么）')
        else bad('历史里没有上一轮的回答')
        if (!r2.promptText.includes(secondQ)) ok('★ 这一问也**不在**提示词里（第 0 条每一轮都一模一样，才谈得上命中）')
        else bad('第二问又混进提示词里了')
        /* ★ 前缀缓存的**前提**：第 0 条消息两轮逐字相同。
           它一旦不一样（哪怕只差一个页码），命中就没了 —— 而"没命中"在屏幕上完全看不出来。 */
        if (seen[0] && r2.promptText === seen[0].promptText) ok('★ 第 0 条消息两轮**逐字相同** —— 前缀缓存命中的前提')
        else bad('两轮的第 0 条消息不一样了（前缀缓存就命不中了）')
        if (r2.images === 2) ok('第二问照样带两张图（"接着问"要重新看到那一块东西）')
        else bad('第二问的图少了：' + r2.images)
      }
      const bubbles = await s.eval(`(() => ({ me: document.querySelectorAll('.bd-ask-me').length, say: document.querySelectorAll('.bd-ask-say').length }))()`)
      if (bubbles.me === 2 && bubbles.say === 2) ok('小窗里两条问答都在（我问的 2 条、老师答的 2 条）')
      else bad('小窗里的对话条数不对：' + JSON.stringify(bubbles))
    }

    /* ── [8] ★ 不点「留到板上」就一个字节都不变 ──
       注意范围变了（2026-09-22，ADR-0006）：从前这个功能**结构上**写不了板，
       现在窗里多了一颗「⬇ 留到板上」—— 所以这条断言说的是
       "**你不点它**，追问全程一个字节都不变"（点了要写盘，那一节在 [9]）。 */
    await untilSavedSafe(s, until)
    const afterText = raw()
    if (afterText === before) ok('★ 不点「留到板上」的话，追问全程**板上一个字节都没变**')
    else {
      bad('追问之后板文件变了 —— 不点那颗按钮的话，它不该往板上写任何东西')
      console.log('      之前 ' + (before || '').length + ' 字节，之后 ' + (afterText || '').length + ' 字节')
    }

    /* ── [9] ★ 「⬇ 留到板上」（ADR-0006）：这一节**要写盘** ──
       [8] 盯的是"**不点它**就一个字节都不变"；这一节盯的是点了之后：
       板文件里真多一张卡、卡上带着"问的是哪一块"、按钮变成「✓ 已在板上」、窗不收。
       ★ 正文是**到这一轮为止的整段问答** —— 第二答里常常写着"上面那个符号"，
         只留最后那一答，一周后看不懂它指的是什么。 */
    const preKeep = raw()
    const cardsBefore = (JSON.parse(preKeep).cards || []).length
    const keepBtn = await s.eval(`(() => {
      const list = [...document.querySelectorAll('.bd-ask-keep')]
      const b = list[list.length - 1]
      if (!b) return { n: list.length }
      const r = b.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
      const at = document.elementFromPoint(cx, cy)
      return { n: list.length, x: cx, y: cy, hit: at ? (at.className || at.tagName) : null }
    })()`)
    let keptId = ''
    if (!keepBtn || !keepBtn.n) bad('小窗里找不到「' + KEEP_BUTTON + '」那颗按钮')
    else {
      if (keepBtn.n === 2) ok(`两条回答下面**各有一颗**「${KEEP_BUTTON}」（按钮挂在哪一条，就留到哪一条）`)
      else bad(`「${KEEP_BUTTON}」应该有 2 颗（一条回答一颗），现在 ${keepBtn.n} 颗`)
      if (/bd-ask-keep/.test(keepBtn.hit || '')) ok('最后那一颗量到的位置和命中是同一个人（真鼠标点得到）')
      else bad('那颗按钮点不到：' + JSON.stringify(keepBtn))
      await s.mouse(keepBtn.x, keepBtn.y)
      const grew = await until(async () => {
        const t = raw()
        return t && t !== preKeep ? t : undefined
      }, { timeout: 8000, what: '点了「留到板上」之后板文件变了（它就是要写盘）' })
      if (!grew.ok) bad('点了「留到板上」板文件一点没变 —— 卡片没落下去')
      else {
        const doc2 = JSON.parse(grew.value)
        const all = doc2.cards || []
        if (all.length === cardsBefore + 1) ok(`板上多了一张卡（${cardsBefore} → ${all.length}），**只多一张**`)
        else bad(`点了「留到板上」多出来 ${all.length - cardsBefore} 张卡（期望 1）`)
        const c = all[cardsBefore] || {}
        keptId = c.id || ''
        const txt = String(c.text || '')
        if (txt.includes(firstQ) && txt.includes(secondQ)) {
          ok(`★ 卡上是"到这一轮为止"的**整段问答**（两问都在：${firstQ} / ${secondQ}）`)
        } else bad('卡上缺了哪一问：' + JSON.stringify(txt.slice(0, 100)))
        if (txt.includes('牛顿第二定律')) ok('答案也在卡上（正文就是老师说的那段话）')
        else bad('卡上没有答案正文')
        if (c.rich === true) ok('卡是**讲义卡**（`rich: true`）—— 正文里的 `$F=ma$` 要排出来')
        else bad('这张卡没带 `rich` —— 公式会显示成生 LaTeX')
        if (c.ask && c.ask.page === 2 && Array.isArray(c.ask.region) && c.ask.region.length === 4) {
          ok('★ 卡上记着**问的是哪一块**（第 2 页 + 页内矩形 ' + JSON.stringify(c.ask.region) + '）')
        } else bad('卡上的 `ask` 不对：' + JSON.stringify(c.ask))
        if (c.ask && c.ask.doc === FIX_NAME) ok('而且记着是**哪一份课件**（`ask.doc` = ' + FIX_NAME + '）')
        else bad('`ask.doc` 不是那一份课件：' + JSON.stringify(c.ask && c.ask.doc))
        /* 贴的位置：那一页的**右栏**（讲解那一栏，x = 页宽 + ORIGIN_GAP = 600+44），
           空栏从**页顶**起（第 2 页的顶边 = 450 + 页距 20）。 */
        const wantX = DOC_W + 44
        const wantY = PAGE_H + 20
        if (c.x === wantX && c.y === wantY) ok(`★ 就贴在第 2 页右边那一栏（x=${c.x}, y=${c.y}）`)
        else bad(`贴歪了：拿到 x=${c.x} y=${c.y}，期望 x=${wantX} y=${wantY}`)
        const keptLabel = await s.eval(`(() => { const e = document.querySelector('.bd-ask-kept'); return e ? e.textContent.trim() : '' })()`)
        if (keptLabel.includes('已在板上')) ok('点过的那一条变成「' + keptLabel + '」（再点不会又落一张）')
        else bad('按钮没变成"已留下"：' + JSON.stringify(keptLabel))
        if (await s.eval(`!!document.querySelector('.bd-ask')`)) ok('★ 小窗**不收**（留下是往板上加一样东西，不是"这段对话结束了"）')
        else bad('留完之后小窗被关掉了 —— 想接着问还得重新框一次')
      }
    }

    /* ── [10] Esc 关得掉，而且高亮也收掉 ──
       ★ 这一条盯的是**光标还在输入框里**时按 Esc（那才是用户的真实姿势：
         刚问完，手还在键盘上）。第一版这里报红过：AskBox 把 Esc 也
         stopPropagation 了，事件到不了 window 上那个"关掉浮着的东西"的监听器。 */
    await s.eval(`(() => { const t = document.querySelector('.bd-ask-ta'); if (t) t.focus(); return true })()`)
    await s.key('Escape', 'Escape', 27)
    const closed = await until(
      async () => {
        const v = await s.eval(`(() => ({ box: !!document.querySelector('.bd-ask'), mark: document.querySelectorAll('.bd-askmark').length }))()`)
        return !v.box && v.mark === 0 ? v : undefined
      },
      { what: '小窗和那一圈高亮一起收掉' }
    )
    if (closed.ok) ok('★ 按 Esc 关掉小窗，而且板上那一圈高亮也收掉了')
    else bad('Esc 之后还留着东西：' + JSON.stringify(await s.eval(`(() => ({ box: !!document.querySelector('.bd-ask'), mark: document.querySelectorAll('.bd-askmark').length }))()`)))

    /* ── [11] ★ 卡片上那颗「◎」：回头看得见"这张卡问的是哪一块" ──
       `ask` 那个字段就是为这一下存在的（不然它是一堆没人读的字节）。
       ⚠ 放在**小窗关掉之后**：小窗就浮在右栏那一带，卡片被它盖着点不到。 */
    if (keptId) {
      const cardSel = '.bd-card[data-card-id="' + keptId + '"]'
      /* ⚠ 选择器要**先拼成一条完整的字符串**再 JSON.stringify 进 eval ——
         写成 `querySelector(${JSON.stringify(cardSel)} .bd-card-ask)` 的话，
         后面那半截落在引号**外面**，浏览器看到的是 `querySelector("…") .bd-card-ask`
         （= `… - card - ask`），报的是 "card is not defined" 这种驴唇不对马嘴的错。 */
      const askBtnSel = cardSel + ' .bd-card-ask'
      /* ⚠⚠ **别直接点卡片的中心**：框选还在的时候，那排浮层动作（`.bd-inkacts`，
         钉在选区正上方、很宽的一条）正好横在卡片那一带上 —— 点下去命中的是它，
         而现象是"卡片选不中、◎ 不出来"（2026-09-22 自检第一次跑就是这么红的：
         elementFromPoint 给回来的是 `bd-inkacts`）。
         所以从卡片里挑**第一个确实落在卡片自己身上**的点来点 —— 这也正是用户的做法：
         卡片被一条浮层压住时，人换一处点。 */
      const onCard = await s.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(cardSel)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        const cand = [[0.5, 0.5], [0.5, 0.1], [0.12, 0.1], [0.88, 0.1], [0.12, 0.5], [0.88, 0.5], [0.5, 0.9]]
        const box = { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top) }
        for (const [fx, fy] of cand) {
          const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy)
          const at = document.elementFromPoint(x, y)
          if (at && (at === el || el.contains(at))) return { x, y, free: true, hit: at.className || at.tagName, box }
        }
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), free: false, hit: null, box }
      })()`)
      if (!onCard) bad('留到板上那张卡在画布上找不到（文件里有、屏幕上没有？）')
      else {
        if (onCard.free) ok(`那张卡在屏幕上（${onCard.box.w}×${onCard.box.h}）—— 挑到了落在卡片自己身上的一点来点`)
        else bad('那张卡整张都被别的东西盖着（框选浮层的动作排？）：' + JSON.stringify({ onCard }))
        await s.mouse(onCard.x, onCard.y)
        const shown = await until(
          async () => ((await s.eval(`!!document.querySelector(${JSON.stringify(askBtnSel)})`)) ? 'up' : undefined),
          { timeout: 4000, what: '选中那张卡之后「◎」出来' }
        )
        if (shown.ok) ok('★ 选中那张答案卡 → 左下角出现「◎」（它记着自己问的是哪一块）')
        else {
          const st = await s.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(cardSel)})
            return { found: !!el, sel: !!(el && el.classList.contains('selected')), cls: el ? el.className : null, locked: el ? el.getAttribute('data-card-locked') : null }
          })()`)
          bad('选中那张卡也没看到「◎」—— 卡片上的 `ask` 没传到界面上：' + JSON.stringify({ onCard, st }))
        }
        const mk = await s.eval(`(() => {
          const b = document.querySelector(${JSON.stringify(askBtnSel)})
          if (!b) return null
          const r = b.getBoundingClientRect()
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
          const at = document.elementFromPoint(cx, cy)
          return { x: cx, y: cy, hit: at ? (at.className || at.tagName) : null, state: b.getAttribute('data-card-ask') }
        })()`)
        if (!mk) { /* 上一条已经报红了，这里不重复 */ }
        else {
          if (/bd-card-ask/.test(mk.hit || '')) ok('「◎」量到的位置和命中是同一个人')
          else bad('「◎」点不到：' + JSON.stringify(mk))
          await s.mouse(mk.x, mk.y)
          const mark = await until(
            async () => {
              const v = await s.eval(`(() => {
                const m = document.querySelector('.bd-askmark')
                if (!m) return null
                const r = m.getBoundingClientRect()
                const pg = document.querySelector('.bd-docpage[data-doc-page="2"]')
                const pr = pg ? pg.getBoundingClientRect() : null
                return { page: Number(m.getAttribute('data-ask-mark')), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), inside: pr ? (r.left >= pr.left - 2 && r.right <= pr.right + 2 && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2) : null }
              })()`)
              return v && v.w > 0 && v.h > 0 ? v : undefined
            },
            { timeout: 4000, what: '点「◎」之后板上亮出那一圈' }
          )
          if (!mark.ok) bad('点了「◎」板上没有亮出那一圈')
          else {
            ok(`★ 点「◎」→ 板上亮出当时圈的那一块（第 ${mark.value.page} 页，${mark.value.w}×${mark.value.h}）`)
            if (mark.value.inside) ok('那一圈落在**第 2 页**里面（页面矩形之内）—— 位置没算错')
            else bad('那一圈不在第 2 页里面：' + JSON.stringify(mark.value))
          }
        }
      }
    }

    /* ── [12] Ctrl+Z：留一张卡 = **一步撤销** ──
       交付里那句"不想要了 Ctrl+Z 退掉"必须是真的（`buildRender` 里那颗按钮的提示就这么写的）。 */
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
    const undoKeep = await until(async () => (raw() === preKeep ? 'back' : undefined), { timeout: 8000, what: 'Ctrl+Z 之后板文件回到留之前那一份' })
    if (undoKeep.ok) ok('★ Ctrl+Z **一步**就把那张卡收回去了（板文件回到一个字节都不差原来那份）')
    else {
      const now = JSON.parse(raw() || '{}')
      bad(`Ctrl+Z 之后板文件没回到留之前（现在 ${(now.cards || []).length} 张卡，留之前 ${cardsBefore} 张）`)
    }

    /* ── [13] ✕ 也关得掉（鼠标用户走的路） ── */
    const reopen = await rectOfText('.bd-inkacts button[data-tool="askink"]', ASK_BUTTON)
    if (reopen) {
      await clickAt(reopen)
      await until(async () => ((await s.eval(`!!document.querySelector('.bd-ask')`)) ? 'up' : undefined), { what: '小窗又开起来' })
      const x = await s.eval(`(() => {
        const b = document.querySelector('.bd-ask-x')
        if (!b) return null
        const r = b.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
        const at = document.elementFromPoint(cx, cy)
        return { x: cx, y: cy, hit: at ? (at.className || at.tagName) : null }
      })()`)
      if (x) {
        await s.mouse(x.x, x.y)
        const shut = await until(async () => (!(await s.eval(`!!document.querySelector('.bd-ask')`)) ? 'gone' : undefined), { what: '✕ 关掉' })
        if (shut.ok) ok('真鼠标点「✕」→ 小窗关掉（' + (x.hit || '') + '）')
        else bad('点「✕」关不掉')
      } else bad('找不到那颗 ✕')
    }

    /* ── [14] 用户数据守卫 + 页面报错 ── */
    const d = drift()
    if (!d.length) ok('data/ 里原有的文件一个都没动（守卫）')
    else bad('自检动了文件：' + JSON.stringify(d.map((x) => x.path || x)))
    const errs = s.errors()
    if (!errs.length) ok('页面里没有 JS 报错')
    else bad('页面报错：' + errs.join(' | '))
  }
)

/* 等应用说"已存"（`untilSaved` 那个 helper 是 withBoard 给的，这里包一层是为了
   在"根本就没有可存的东西"时也不卡住：追问本来就不该让板变脏）。 */
async function untilSavedSafe(s, until) {
  await until(
    async () => {
      const t = await s.eval(`(() => { const el = document.querySelector('.bd-save'); return el ? el.textContent.trim() : '已存' })()`)
      return t === '已存' ? t : undefined
    },
    { timeout: 5000, what: '应用说「已存」' }
  )
}

mock.close()
process.exitCode = fails ? 1 : 0
