/* check-homework-browser：「作业辅导」那条链路的端到端（真浏览器 + 真本地服务 + 假识别服务）。
 *
 * 纯逻辑那一半在 check-homework.js（49 条断言，node 里跑，连 pdf.js 都不拉起）。
 * 这一条盯的是**只有真跑一遍才看得见**的那几件事：
 *   [1] 「✎ 作业辅导」在工具条上、点得到（真鼠标 + elementFromPoint，不是 eval 里 .click()）；
 *   [2] 点它 → 浮出那个窗，**没有遮罩**（它不是弹层），而且**板上一个字节都不变**；
 *   [3] 窗里三件事都在：哪一份 / 哪几题 / "这节课的知识"统计（夹具的 2 张讲义卡，
 *       那张手写卡不算）；
 *   [4] 页号写错**当场拦住**（夹具只有 2 页，写第 12 页 → 那行字报错，按钮点不动）；
 *   [5] ★ 点「开始做」→ 发出去的包里：**mode=homework**、一页一张图（JPEG）、
 *       提示词里带着**学生那句话**和**这节课的讲义**（"第一页讲解"那几个字）；
 *   [6] 回话按题显示：题号 / 题干 / **答案** / **解析**，而且答案里的 `$…$` **排出来了**（.katex）；
 *   [7] 空壳（`answer` 和 `explain` 都空的那条）**丢掉并且报数**；
 *   [8] ★ 写"第 1-2 页"再问一次 → 发出去的是**两张图**（多页那条路只有这里验得到）；
 *   [9] Esc / ✕ 关得掉；页面上没有 JS 报错。
 *
 * ── 这个功能为什么值得端到端盯一遍 ──────────────────────────────────────
 * 它的产物是**答案**。上面 [5]~[8] 里任何一条错了（图少一张、提示词里没带讲义、
 * 页号读错），界面上都**照样显示得有模有样** —— 一句报错都没有，
 * 而学生会把那个答案当成自己那道题的答案背下来。
 *
 * ── 假识别服务 ─────────────────────────────────────────────────────────
 * DeepSeek 的形状（OpenAI 兼容）。它把**收到的东西**记下来给这里查：
 * 几张图、图是不是 JPEG、提示词里有没有那句话和那段讲义、温度是多少。
 * 回话是一段**作业辅导该有的 JSON**（两道题，其中一道是空壳 —— 顺手验"空壳要丢掉并报数"）。
 *
 * 它自己起服务（5239）和 headless Edge（9279），跑完都收掉；夹具板 board-zz-homework.md
 * 和夹具 PDF .资料/zz-homework-smoke.pdf 都自造自删；用户那张板一个字节都不动（守卫盯着）。
 * ⚠ 端口是**挑空**的（各脚本自己一套，别串）：5238/9278 是 diag-followup 的、
 *   5206 是 check-zoom 的服务端口 —— 第一版这三个都撞上了，撞了就会"起不来"或者
 *   连到别人的页面上去（报出来的话是"工具条上找不到那颗按钮"，看着像功能没做）。
 *
 * 用法：node scripts/check-homework-browser.js   （或 npm run check:homework-browser）
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { withBoard, DATA, ROOT } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'
import { HW_BUTTON, HW_INK_BUTTON } from '../src/lib/homework.js'
import { KEEP_BUTTON } from '../src/lib/answer-cards.js'

/* 假识别服务用 5200（不是 5206 —— 那个是 check-zoom 的应用端口）。 */
const MOCK_PORT = Number(process.env.HOMEWORK_TEST_MOCK_PORT || 5200)
const TEST_TOKEN = 'sk-homework-test-0123456789'

const FIX_PDF = path.join(DATA, '.资料', 'zz-homework-smoke.pdf')
const FIX_NAME = '.资料/zz-homework-smoke.pdf'
/* 第二份夹具：模拟"作业所在的那本书"（用户在窗里现传上来的那一份）。 */
const ZZ_BOOK_PDF = path.join(DATA, '.资料', 'zz-homework-book.pdf')

/* ── 把用户自己的识别配置挪开（和 check-deck / check-followup 同一条规矩）──
 * `loadConfig` 只在**没有** config/ocr.json 时才读环境变量，所以自检必须先把它挪开。
 * ⚠ 那个文件在 .gitignore 里：**弄丢就找不回来**（里面是密钥），
 *   所以收尾那一段无条件放回去；上一次没跑完留下的备份**改名留着不删**。 */
const realConfig = path.join(ROOT, 'config', 'ocr.json')
const stash = realConfig + '.checkhomework-bak'
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
  } catch (e) {
    console.log('  ⚠ 放回 config/ocr.json 失败：' + String(e && e.message) + ' —— 备份在 ' + stash)
  }
}

stashConfig()

/* ── 夹具 PDF：两页，每页一个页码大字（"第 2 页那张图对不对"看得见）──
   手写 PDF 字节，不引第三方（和 check-followup / check-deck 同一个路子）。 */
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
    const stream = `0.95 0.95 0.95 rg 40 40 640 460 re f 0.15 0.15 0.15 rg BT /F1 36 Tf 60 420 Td (Exercise page ${i + 1}) Tj ET`
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

/* ── 假识别服务：记账 + 回一段"作业辅导该有的 JSON" ──
 * 两道题 + 一条**空壳**（`answer` 和 `explain` 都空）——
 * 空壳那条是故意的：界面要把它丢掉**并且说一句**（"少拿到的东西不静默"）。 */
const seen = []
const REPLY = JSON.stringify({
  problems: [
    {
      label: '第 3 题',
      page: 2,
      question: '一个物体质量 $m=2\\,\\text{kg}$，合外力 $F=10\\,\\text{N}$，求它的加速度。',
      answer: '$a=5\\,\\text{m/s}^2$',
      explain: '先看这道题给了什么：质量 $m$ 和合外力 $F$，要的是加速度 $a$。\n\n牛顿第二定律说 $F=ma$ —— 两边同时除以 $m$ 就得到 $a=F/m$。代进去：$10/2=5$。',
    },
    { label: '第 4 题', page: 2, question: '（这一条是占位的空壳）', answer: '', explain: '' },
  ],
})

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
    /* 所有消息的文字拼在一起（追问那一节要看"题面和回答到底有没有进对话"——
       它们不在第 0 条里，而在后面那几条 history 里，所以只看第 0 条是看不到的）。 */
    const joined = msgs
      .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => String(c.text || '')).join('\n') : ''))
      .join('\n')
    const sizes = imgs.map((c) => {
      const b64 = String((c.image_url && c.image_url.url) || '').replace(/^data:image\/\w+;base64,/, '')
      const buf = Buffer.from(b64, 'base64')
      return { bytes: buf.length, jpeg: buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff }
    })
    seen.push({
      url: req.url,
      model: json ? json.model : null,
      temperature: json ? json.temperature : null,
      messages: msgs.length,
      images: sizes.length,
      imgBytes: sizes.map((s) => s.bytes),
      imgJpeg: sizes.map((s) => s.jpeg),
      promptText,
      joined,
    })
    try {
      if (res.destroyed) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      /* ★ 追问那一趟要回一段**人话**（不是题目 JSON）—— 它是"接着讲"，不是"再做一遍题"。
         怎么知道这一趟是追问：看提示词。作业辅导那段第一句是"陪着学生做作业"，
         追问那段是"学生对着你刚才给的答案接着说"（见 server-ocr.js 的 HWASK_PROMPT）。
         ⚠ 用提示词判、不用别的：假服务收到的是一个 JSON body，里面**没有** mode 字段
           （mode 是浏览器发给本地服务的表单字段，转成上游请求时就没了）——
           所以"这一趟是哪一条路"只能从提示词认，这和真模型看到的东西一致。 */
      const isFollow = /还有一处没懂/.test(promptText)
      const content = isFollow
        ? '因为速度的定义就是"路程除以时间"，所以要除以 3 小时。\\n\\n换个说法：$v=s/t$ —— 已知路程 $s=180$ 千米、时间 $t=3$ 小时，把 $t$ 挪到分母上就是除。'
        : REPLY
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    } catch {}
  })
})

const mockUp = await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r(true)))
if (!mockUp) console.log('  ⚠ 假识别服务没起来（端口 ' + MOCK_PORT + '）')

/* ── 夹具板：一份两页的资料摆在 (0,0)，宽 600；旁边两张讲义卡 + 一张手写卡 ──
   页面高 = 600 × 540/720 = 450，页距 DOC_PAGE_GAP=20 → 第二页从 y=470 起。
   ⚠ PDF 本体**必须真的写进 data/.资料/**：这一趟要现场把那一页渲染成图，
     pdf.js 拿不到这个文件就是 404 —— 而界面上那句"这几页画不出图来"看起来
     很像渲染坏了，其实是夹具没铺。 */
const DOC_W = 600
function makeBoard() {
  fs.mkdirSync(path.dirname(FIX_PDF), { recursive: true })
  fs.writeFileSync(FIX_PDF, buildPdf(2))
  /* 第二份（"那本书"）：窗里那个「📄 传一份作业的 PDF…」要真有东西可选。
     ★ 它**不写进夹具板** —— 它就该是"用户现传上来的"，由那一段自己铺上去。 */
  fs.writeFileSync(ZZ_BOOK_PDF, buildPdf(2))
  const b = newBoard('homework 自检夹具（跑完自动删除）')
  b.docs = [{ id: 'doczzhw1', path: FIX_NAME, title: '作业冒烟讲义', x: 0, y: 0, w: DOC_W, pages: [[720, 540], [720, 540]] }]
  /* ⚠ 卡片**直接写字面量**，别用 `newCard(kind, x, y, extra)` ——
     那个工厂只认 extra 里的 w/h，`text` / `rich` / `locked` 一个都不带
     （见 board.js 的 newCard）。第一版就是那么写的，症状是**夹具卡片全是空的**，
     于是"这节课的知识"统计成 0 张 —— 看起来像功能坏了，其实是夹具没造出来。
     （读盘那一趟会补默认，缺的字段没关系。） */
  b.cards = [
    /* 两张讲义卡（课件整理贴上去的那种：`rich` + 钉住）—— 右栏讲解、左栏重点。 */
    { id: 'zzhwc1', kind: 'note', x: DOC_W + 44, y: 0, w: 300, h: 220, text: '第一页讲解：这是夹具里的讲解，讲的是牛顿第二定律。', rich: true, locked: true },
    { id: 'zzhwc2', kind: 'note', x: -344, y: 0, w: 300, h: 100, text: '第一页重点：合力决定加速度。', rich: true, locked: true },
    /* 一张手写卡：**不该**被当成"这节课讲过的"。 */
    { id: 'zzhwc3', kind: 'note', x: DOC_W + 44, y: 320, w: 240, h: 60, text: '我自己随手写的（不该被带上）' },
  ]
  return serializeBoardDocument(b)
}

const fails = await withBoard(
  {
    tag: 'homework',
    port: 5239,
    cdpPort: 9279,
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
  async ({ s, ok, bad, open, raw, after, until }) => {
    after(() => {
      restoreConfig()
      try {
        mock.close()
      } catch {}
      try {
        if (fs.existsSync(FIX_PDF)) fs.rmSync(FIX_PDF, { force: true })
      } catch {}
      try {
        /* ⚠ 只删**这两个夹具名**：动手之前先确认名字对得上 ——
           "删的是谁的"那个坑的答案就是这句（宁可留个垃圾，也不能删用户的东西）。 */
        for (const f of [ZZ_BOOK_PDF]) {
          if (path.basename(f).startsWith('zz-homework-') && fs.existsSync(f)) fs.rmSync(f, { force: true })
        }
      } catch {}
    })

    await open()

    /* ── 找按钮 / 量命中：一律真鼠标 + elementFromPoint ──────────────────
       这个仓库在这上面栽过好几次（卡片 / 美化 / 复制都是"看得见点不到"）。
       ⚠ 量之前先 `scrollIntoView`：这个窗是浮在画布上的一个面板，题目一长，
         靠下的那颗按钮就落在窗的滚动区外面 —— 那时量出来的坐标**在视口之外**，
         `elementFromPoint` 给回来的是 null，报出来的现象是"按钮点不到"
         （2026-09-22 「留到板上」那颗第一次跑就是这么红的）。
        滚动只是**准备**，命中照样用真鼠标 + elementFromPoint 验。
       ⚠ 这段注释活在**模板字符串里面**：这儿不许出现反引号（会把模板当场截断，
         报的是 "SyntaxError: missing ) after argument list"）。 */
    const rectOfText = (sel, text) =>
      s.eval(`(() => {
        for (const b of document.querySelectorAll(${JSON.stringify(sel)})) {
          if (b.textContent.includes(${JSON.stringify(text)})) {
            b.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            const r = b.getBoundingClientRect()
            const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
            const at = document.elementFromPoint(cx, cy)
            return { x: cx, y: cy, hit: at ? (at.className || at.tagName) : null, disabled: !!b.disabled }
          }
        }
        return null
      })()`)

    const clickAt = async (p) => {
      if (!p) return false
      await s.mouse(p.x, p.y)
      return true
    }
    /* 焦点给输入框，再用 CDP 的 insertText 打字（真输入法那条路，不是自己派 input 事件）。 */
    const typeInto = async (sel, text) => {
      const p = await s.eval(`(() => {
        const t = document.querySelector(${JSON.stringify(sel)})
        if (!t) return null
        const r = t.getBoundingClientRect()
        return { x: Math.round(r.left + 24), y: Math.round(r.top + 12) }
      })()`)
      if (!p) return false
      await s.mouse(p.x, p.y)
      await s.sleep(120)
      /* 先全选（Ctrl+A）再打 —— 第二次进来是**换一句话**，不是往后接。 */
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await s.send('Input.insertText', { text })
      await s.sleep(200)
      return true
    }
    const readHint = () => s.eval(`(() => { const el = document.querySelector('.bd-hw-read'); return el ? el.textContent.trim() : null })()`)

    /* ── [1] 工具条上那颗按钮：在、点得到、不是灰的 ── */
    const topBtn = await rectOfText('.bd-tools .bd-t', HW_BUTTON)
    if (!topBtn) bad(`工具条上找不到「${HW_BUTTON}」那颗按钮`)
    else {
      ok(`工具条上有「${HW_BUTTON}」（${topBtn.x},${topBtn.y}）`)
      if (/bd-t/.test(topBtn.hit || '')) ok('它量到的位置和命中是同一个人（真鼠标点得到）')
      else bad('按钮的位置和命中对不上，点它会落空：' + JSON.stringify(topBtn))
      if (!topBtn.disabled) ok('板上没有资料时它也**不是灰的**（点了窗里会让他传一份）')
      else bad('一颗资料都没有时它是灰的 —— 用户会以为功能坏了')
    }

    /* ── [2] 点它 → 浮出那个窗（不是弹层、没有遮罩） ── */
    const before = raw()
    if (topBtn) {
      await clickAt(topBtn)
      const up = await until(
        async () => {
          const v = await s.eval(`(() => {
            const b = document.querySelector('.bd-hw')
            if (!b) return null
            const r = b.getBoundingClientRect()
            const cs = getComputedStyle(b)
            return {
              rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
              z: cs.zIndex,
              labels: [...b.querySelectorAll('.bd-hw-lbl')].map((x) => x.textContent.trim()),
              docs: [...b.querySelectorAll('.bd-hw-doc')].map((x) => x.textContent.trim()),
              checked: [...b.querySelectorAll('.bd-hw-doc.on')].map((x) => x.textContent.trim()),
              know: (b.querySelector('.bd-hw-know') || {}).textContent || '',
            }
          })()`)
          return v || undefined
        },
        { what: '作业辅导那个窗' }
      )
      if (up.ok) ok(`点它 → 浮出那个窗（位置 ${up.value.rect.join(',')}，z-index ${up.value.z}）`)
      else bad('点了「作业辅导」，窗没出现')
      if (up.ok) {
        const outside = await s.eval(`(() => {
          const b = document.querySelector('.bd-hw')
          const r = b.getBoundingClientRect()
          const x = Math.max(4, r.left - 40), y = Math.round(r.top + r.height / 2)
          const at = document.elementFromPoint(x, y)
          return { cls: at ? (at.className || at.tagName) : null }
        })()`)
        if (!/bd-hw/.test(String(outside.cls))) ok('窗外面那一点仍然是底下的画布（**没有遮罩** —— 它不是弹层）')
        else bad('窗盖住了整屏：' + JSON.stringify(outside))

        /* ── [3] 三件事都在 ── */
        const L = up.value.labels.join(' | ')
        if (/作业在哪一份/.test(L) && /做哪几道题/.test(L) && /结合这节课的知识/.test(L)) ok('窗里三件事都在：哪一份 / 哪几题 / 这节课的知识')
        else bad('窗里少了哪一件：' + L)
        if (up.value.docs.length === 1 && up.value.checked.length === 1) ok('夹具那份资料列出来了，而且是选中态（打开就能用，少点一下）')
        else bad('资料没列出来或者没预选：' + JSON.stringify({ docs: up.value.docs, checked: up.value.checked }))
        /* ★ 2 张讲义卡，**手写卡不算** —— 这条盯的是"这节课讲过的是什么"那个判据。 */
        if (/2\s*张讲解卡/.test(up.value.know)) ok('★ "这节课的知识"统计对：2 张讲义卡（那张手写卡不算）')
        else bad('讲义统计不对（期望 2 张）：' + JSON.stringify(up.value.know))
      }
    }

    /* ── [4] 页号写错当场拦住 ── */
    if (await typeInto('.bd-hw-ta', '第 12 页第 3 题')) {
      const hint = await readHint()
      if (hint && /只有 2 页/.test(hint)) ok('页号越界当场拦住：「' + hint.slice(0, 40) + '…」')
      else bad('页号越界没拦住（夹具只有 2 页，写了第 12 页）：' + JSON.stringify(hint))
    } else bad('找不到那个输入框（.bd-hw-ta）')

    /* ── [5] 写对了 → 那行字说会翻到第 2 页 ── */
    if (await typeInto('.bd-hw-ta', '第 2 页第 3 题')) {
      const hint = await readHint()
      if (hint && /会翻到第 2 页/.test(hint)) ok('写对了那行字就变成「' + hint + '」')
      else bad('提示语没跟上：' + JSON.stringify(hint))
    }

    /* ── [6] 点「开始做」→ 假服务收到什么 ── */
    const n0 = seen.length
    const goBtn = await rectOfText('.bd-hw-foot .bd-hw-btn', '开始做')
    if (!goBtn) bad('找不到「开始做」那颗按钮')
    else {
      if (/bd-hw-btn/.test(goBtn.hit || '')) ok('「开始做」量到的位置和命中是同一个人')
      else bad('「开始做」点不到：' + JSON.stringify(goBtn))
      await clickAt(goBtn)
      /* ⚠ 这一趟要**现场把那一页渲染成 1440 宽的图**（冷启动 pdf.js worker 就要一两秒），
         再等假服务回话 —— 6 秒（until 的默认）不够，给 25 秒。 */
      const got = await until(async () => (seen.length > n0 ? seen[seen.length - 1] : undefined), { what: '假服务收到请求', timeout: 25000 })
      if (!got.ok) {
        /* 没收到就把窗口里的状态打出来 —— 不然只有一句"没收到"，
           而真正的原因（渲染失败 / 报错 / 按钮还是灰的）就在那个窗里。 */
        const dbg = await s.eval(`(() => {
          const b = document.querySelector('.bd-hw')
          if (!b) return { win: false }
          const t = (sel) => { const el = b.querySelector(sel); return el ? el.textContent.trim() : '' }
          return { win: true, err: t('.bd-hw-err'), busy: t('.bd-hw-busy'), btn: t('.bd-hw-foot .bd-hw-btn'), body: t('.bd-hw-body').slice(0, 240) }
        })()`)
        bad('点了「开始做」，假识别服务一个请求都没收到 —— 窗口里是这样：' + JSON.stringify(dbg))
      } else {
        const req = got.value
        if (req.images === 1) ok('发出去的是**一页一张图**（这次只问了第 2 页）')
        else bad('图的数量不对：' + req.images)
        if (req.imgJpeg.every(Boolean)) ok(`那张图是 JPEG（${req.imgBytes.join('/')} 字节）`)
        else bad('发出去的不是 JPEG：' + JSON.stringify(req.imgJpeg))
        if (req.promptText.includes('陪着学生做作业')) ok('走的是**作业辅导**那段提示词（不是认公式那条路）')
        else bad('提示词不像作业辅导那一段：' + req.promptText.slice(0, 80))
        if (req.promptText.includes('第 2 页第 3 题')) ok('学生那句话原样进了提示词')
        else bad('提示词里没有学生那句话')
        if (req.promptText.includes('这是夹具里的讲解')) ok('★ 这节课的讲义进了提示词（讲解卡的文字）')
        else bad('讲义没进提示词 —— "结合本节课的知识"这条就落空了')
        if (req.promptText.includes('我自己随手写的')) bad('那张**手写卡**也被当成本节课的知识发过去了')
        else ok('手写卡没被当成本节课的知识（判据是卡的身份，不是"板上有字就算"）')
        if (req.temperature === 0.3) ok('温度是 0.3（解析要"说人话"，0 会写成教辅书腔）')
        else bad('温度不对：' + req.temperature)
      }
    }

    /* ── [7] 回话按题显示：题号 / 题干 / 答案 / 解析，公式排出来了 ── */
    const shown = await until(
      async () => {
        const v = await s.eval(`(() => {
          const probs = document.querySelectorAll('.bd-hw-prob')
          if (!probs.length) return null
          const p0 = probs[0]
          const txt = (sel) => { const el = p0.querySelector(sel); return el ? el.textContent.trim() : '' }
          return {
            n: probs.length,
            no: txt('.bd-hw-no'),
            page: txt('.bd-hw-pg'),
            q: txt('.bd-hw-q'),
            ans: txt('.bd-hw-ans'),
            exp: txt('.bd-hw-exp'),
            ansKatex: p0.querySelectorAll('.bd-hw-ans .katex').length,
            expKatex: p0.querySelectorAll('.bd-hw-exp .katex').length,
            tags: [...p0.querySelectorAll('.bd-hw-tag')].map((x) => x.textContent.trim()),
            drop: (document.querySelector('.bd-hw-drop') || {}).textContent || '',
          }
        })()`)
        return v || undefined
      },
      { what: '窗口里的题目', timeout: 25000 }
    )
    if (!shown.ok) {
      const dbg = await s.eval(`(() => {
        const b = document.querySelector('.bd-hw')
        if (!b) return { win: false }
        const t = (sel) => { const el = b.querySelector(sel); return el ? el.textContent.trim() : '' }
        return { win: true, err: t('.bd-hw-err'), busy: t('.bd-hw-busy'), body: t('.bd-hw-body').slice(0, 240) }
      })()`)
      bad('点完了，窗口里一道题都没显示出来 —— 窗口里是这样：' + JSON.stringify(dbg))
    } else {
      const v = shown.value
      ok(`★ 窗口里显示了 ${v.n} 道题（空壳那条被丢掉了）`)
      if (v.no === '第 3 题' && /第 2 页/.test(v.page)) ok('题号和页码都显示出来了（' + v.no + ' · ' + v.page + '）')
      else bad('题号/页码不对：' + JSON.stringify({ no: v.no, page: v.page }))
      if (/质量/.test(v.q)) ok('★ 题干照抄出来了（防串题靠的就是它）')
      else bad('题干没显示出来：' + JSON.stringify(v.q))
      if (/答案/.test(v.tags.join('')) && /解析/.test(v.tags.join(''))) ok('答案和解析**各带一个标签**（这两样必须一眼分得开）')
      else bad('答案/解析的标签没出来：' + JSON.stringify(v.tags))
      if (/a=5/.test(v.ans) || /5/.test(v.ans)) ok('答案显示出来了')
      else bad('答案没显示：' + JSON.stringify(v.ans))
      if (v.ansKatex > 0 && v.expKatex > 0) ok(`★ 答案和解析里的公式**排出来了**（KaTeX ${v.ansKatex}+${v.expKatex} 处），不是原样的 $…$`)
      else bad(`公式没排出来（ans katex=${v.ansKatex}, exp katex=${v.expKatex}）—— 学生看到的就是一堆 $ 和反斜杠`)
      if (/空壳/.test(v.drop)) ok('★ 空壳那条**丢掉了并且说了出来**：「' + v.drop.trim() + '」')
      else bad('空壳丢掉了但没报数（"少拿到的东西不静默"）：' + JSON.stringify(v.drop))
    }

    /* ── [8] 多页：写"第 1-2 页"再问一次 → 应该是**两张图** ── */
    if (await typeInto('.bd-hw-ta', '第 1-2 页第 3 题')) {
      const n1 = seen.length
      const again = await rectOfText('.bd-hw-foot .bd-hw-btn', '再做一次')
      if (!again) bad('问完一次之后找不到「↻ 再做一次」那颗按钮')
      else {
        await clickAt(again)
        const got2 = await until(async () => (seen.length > n1 ? seen[seen.length - 1] : undefined), { what: '第二次请求', timeout: 25000 })
        if (!got2.ok) bad('第二次问，假识别服务没收到请求')
        else if (got2.value.images === 2) ok('★ 写"第 1-2 页"发出去的是**两张图**（多页那条路只有这里验得到）')
        else bad('多页没发两张图：' + got2.value.images)
      }
    }

    /* ── [9] 板上一个字节都不变 + Esc 关得掉 + 没有报错 ── */
    const afterText = raw()
    if (afterText === before) ok('★ 全程**板上一个字节都没变**（答案浮在窗里，不动板上的东西）')
    else bad('板被改了 —— 这个功能的定义就是"不往板上写"')

    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    const closed = await until(async () => (await s.eval(`!document.querySelector('.bd-hw')`)) === true, { what: '窗关掉' })
    if (closed.ok) ok('Esc 关得掉（关掉之后板上什么都不留）')
    else bad('Esc 关不掉那个窗')

    /* ── [10] 第二种选题法：**框住题号**（用户 2026-09-22 要的）────────────
       在课件第 2 页上画一小笔当"题号"，框住它 → 浮层上出现「✎ 做这道题」→
       点它 → 窗里自带"你圈的是第 2 页上那一块" → 点开始做 → 发出去的必须是
       **两张图**（整页带红框 + 红框里放大），提示词换成圈选那套说法。
       ★ 这一条只有真跑一遍才验得到：纯逻辑那一半只测了提示词的两种说法，
         "红框到底有没有画在图上、两张图有没有都发出去"它看不见。 */
    const pageRect = await s.eval(`(() => {
      const els = [...document.querySelectorAll('.bd-docpage')]
      const e = els.find((x) => x.getAttribute('data-doc-page') === '2')
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })()`)
    if (!pageRect) bad('板上看不到第 2 页（.bd-docpage[data-doc-page="2"]）—— 夹具的课件没铺上？')
    else {
      /* ① 在页面上画一小笔（当作"题号"）。⚠ 圈选只认**笔迹**（sel.ids），
            所以这一步不能省 —— 光拖一个空框，选区是空的。 */
      await s.drag(Math.round(pageRect.left + pageRect.w * 0.3), Math.round(pageRect.top + pageRect.h * 0.3), 40, 6, { steps: 6, button: 'left' })
      await until(
        async () => ((await s.eval(`(() => { const c = document.querySelector('canvas.bd-ink'); return c ? Number(c.getAttribute('data-strokes') || 0) : 0 })()`)) > 0 ? 'ok' : undefined),
        { what: '画上去的那一笔进了画布' }
      )
      /* ② 切「⬚ 框选」，把那一小笔圈住。 */
      await s.eval(`(() => { const b = document.querySelector('.bd-tools [data-tool="select"]'); if (b) b.click(); return true })()`)
      await s.sleep(200)
      await s.drag(
        Math.round(pageRect.left + pageRect.w * 0.2),
        Math.round(pageRect.top + pageRect.h * 0.2),
        Math.round(pageRect.w * 0.3),
        Math.round(pageRect.h * 0.25),
        { steps: 8, button: 'left' }
      )
      const boxed = await until(async () => ((await s.eval(`!!document.querySelector('.bd-inkbox')`)) ? 'ok' : undefined), { what: '框选的包围框' })
      if (!boxed.ok) bad('框选没生效 —— 圈选那条路无从谈起')
      else {
        const hwBtn = await rectOfText('.bd-inkacts button[data-tool="hwink"]', HW_INK_BUTTON)
        if (!hwBtn) bad(`选区浮层上没有「${HW_INK_BUTTON}」`)
        else {
          ok(`框住课件页上的一块之后，浮层上出现了「${HW_INK_BUTTON}」`)
          if (!hwBtn.disabled) ok('这一块落在课件页面上 → 那颗按钮是**亮的**（和「？问这里」共用 askPage）')
          else bad('框在课件页面上，按钮却是灰的：' + JSON.stringify(hwBtn))
          if (/bd-inkhw/.test(hwBtn.hit || '')) ok('它量到的位置和命中是同一个人（真鼠标点得到）')
          else bad('浮层上那颗按钮的位置和命中对不上：' + JSON.stringify(hwBtn))

          /* ③ 点它 → 窗里自带"你圈的是第 N 页上那一块" */
          const n2 = seen.length
          await clickAt(hwBtn)
          const tk = await until(
            async () => {
              const v = await s.eval(`(() => {
                const b = document.querySelector('.bd-hw')
                if (!b) return null
                const p = b.querySelector('.bd-hw-picked')
                const ta = b.querySelector('.bd-hw-ta')
                return { picked: p ? p.textContent.trim() : '', ph: ta ? ta.placeholder : '', onDoc: (b.querySelector('.bd-hw-doc.on') || {}).textContent || '' }
              })()`)
              return v && v.picked ? v : undefined
            },
            { what: '窗里出现"你圈的是第 N 页"' }
          )
          if (tk.ok) ok('★ 窗里自带了圈选：' + tk.value.picked.replace(/\s+/g, ' ').slice(0, 60) + '…')
          else bad('点了「' + HW_INK_BUTTON + '」，窗里没出现圈选那行字')
          if (tk.ok && /可留空/.test(tk.value.ph || '')) ok('输入框退成"要不要再说一句（可留空）"（圈选题里页号不用写）')
          else if (tk.ok) bad('输入框的提示语没跟着换：' + JSON.stringify(tk.value.ph))

          /* ④ 点开始做 → 两张图 + 圈选那套提示词 */
          const go2 = await rectOfText('.bd-hw-foot .bd-hw-btn', '开始做')
          if (!go2) bad('圈选之后找不到「开始做」那颗按钮')
          else {
            await clickAt(go2)
            const got3 = await until(async () => (seen.length > n2 ? seen[seen.length - 1] : undefined), { what: '圈选题的请求', timeout: 25000 })
            if (!got3.ok) bad('圈选题点了「开始做」，假识别服务没收到请求')
            else {
              if (got3.value.images === 2) ok('★ 圈选题发出去的是**两张图**（整页带红框 + 红框里放大）')
              else bad('圈选题的图数不对（期望 2）：' + got3.value.images)
              if (got3.value.imgJpeg.every(Boolean)) ok('两张都是 JPEG（' + got3.value.imgBytes.join('/') + ' 字节）')
              else bad('圈选题发出去的不是 JPEG：' + JSON.stringify(got3.value.imgJpeg))
              if (/红框/.test(got3.value.promptText) && /第一张/.test(got3.value.promptText)) ok('★ 提示词换成了圈选那套说法（"第一张整页、红框里就是他圈的那块"）')
              else bad('提示词没换成圈选那套：' + got3.value.promptText.slice(0, 120))
              if (/以红框里那一块为准/.test(got3.value.promptText)) ok('提示词明说了"题号以红框里那一块为准"（防它自己在页上另挑一道）')
              else bad('提示词少了"以红框里那一块为准"那条 —— 页上十几道题，它会挑错的')
              if (/这是夹具里的讲解/.test(got3.value.promptText)) ok('圈选题照样带上了这节课的讲义')
              else bad('圈选题没带讲义')
              /* ★ 结果要真的**换成新一轮的**：`run()` 在发请求**之前**就把旧结果清掉了
                 （`setResult(null)`），所以"请求已发出 + 不忙 + 有题"这三条同时成立，
                 看到的一定是这一轮的结果（不然就是上一次那份留在屏幕上 —— 假绿）。 */
              const idle2 = await until(
                async () => {
                  const v = await s.eval(`(() => {
                    const b = document.querySelector('.bd-hw')
                    if (!b) return null
                    return { busy: !!b.querySelector('.bd-hw-busy'), n: b.querySelectorAll('.bd-hw-prob').length }
                  })()`)
                  return v && !v.busy && v.n > 0 ? v : undefined
                },
                { what: '圈选题的结果落定', timeout: 20000 }
              )
              if (idle2.ok) ok(`圈选题的答案照样显示出来了（${idle2.value.n} 道题，答案 + 解析都在）`)
              else bad('圈选题做完之后窗口里没有题目')
            }
          }
        }
      }
    }

    /* ── [10b] ★ 「⬇ 留到板上」（2026-09-22，ADR-0006）：作业的答案也留得住 ──
       追问那边同款在 check-followup-browser 的 [9]–[12]（连 Ctrl+Z 那一步一起）。
       这里只验**作业这条路特有**的几样：卡上是"题号 + 题干 + 答案 + 解析"、
       落的是**这道题那一页**、以及圈题进来的那条**带着 region**。
       ⚠ 放在传 PDF 那一段**之前**：那一段之后板上会多一份资料，起点就变了。 */
    const hwPre = raw()
    const hwCards = (JSON.parse(hwPre).cards || []).length
    const hwKeep = await s.eval(`(() => {
      const list = [...document.querySelectorAll('.bd-hw-keep')]
      if (!list.length) return { n: 0 }
      const b = list[0]
      /* ⚠ 先滚进视野再量（题目一长，这颗按钮会落在窗的滚动区外面 ——
         那时 elementFromPoint 给回来的是 null，现象是"按钮点不到"）。
         这条规矩和上面 rectOfText 里那句是同一条。 */
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = b.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
      const at = document.elementFromPoint(cx, cy)
      return { n: list.length, x: cx, y: cy, hit: at ? (at.className || at.tagName) : null }
    })()`)
    if (!hwKeep || !hwKeep.n) bad('每道题下面应该有一颗「' + KEEP_BUTTON + '」—— 现在一颗都没有')
    else {
      ok(`每道题下面都有一颗「${KEEP_BUTTON}」（${hwKeep.n} 道题 → ${hwKeep.n} 颗）`)
      if (/bd-hw-keep/.test(hwKeep.hit || '')) ok('它量到的位置和命中是同一个人（真鼠标点得到）')
      else bad('那颗按钮点不到：' + JSON.stringify(hwKeep))
      await s.mouse(hwKeep.x, hwKeep.y)
      const hwGrew = await until(async () => {
        const t = raw()
        return t && t !== hwPre ? t : undefined
      }, { timeout: 8000, what: '点了「留到板上」之后板文件变了（它就是要写盘）' })
      if (!hwGrew.ok) bad('点了「留到板上」板文件一点没变 —— 那道题没落下去')
      else {
        const d2 = JSON.parse(hwGrew.value)
        const all = d2.cards || []
        if (all.length === hwCards + 1) ok(`板上多了一张卡（${hwCards} → ${all.length}），**只多一张**`)
        else bad(`多出来 ${all.length - hwCards} 张卡（期望 1）`)
        const c = all[hwCards] || {}
        const txt = String(c.text || '')
        if (/第 3 题/.test(txt) && /一个物体质量/.test(txt)) ok('★ 卡上有**题号和题干**（题干照抄是防串题的唯一手段）')
        else bad('卡上缺了题号或题干：' + JSON.stringify(txt.slice(0, 80)))
        if (/答案：/.test(txt) && /解析：/.test(txt)) ok('★ 答案和解析都在卡上（各自带前缀，一眼分得开）')
        else bad('卡上缺了答案或解析：' + JSON.stringify(txt.slice(0, 120)))
        if (/牛顿第二定律/.test(txt)) ok('解析那一段也在（说人话的那段话跟着上了板）')
        else bad('解析的正文没上去')
        if (c.rich === true) ok('卡是**讲义卡**（`rich: true`）—— 里面的 $a=5\\,\\text{m/s}^2$ 要排出来')
        else bad('这张卡没带 `rich` —— 公式会显示成生 LaTeX')
        if (c.ask && c.ask.page === 2) ok('★ 落在**这道题那一页**（第 2 页 —— 圈题把页号定死了）')
        else bad('`ask.page` 不对：' + JSON.stringify(c.ask))
        if (c.ask && Array.isArray(c.ask.region) && c.ask.region.length === 4) ok('圈题进来的那条**带着 region**（你圈的那一块，文件里是 [x,y,w,h]）')
        else bad('圈题这条没带上 region：' + JSON.stringify(c.ask))
        /* 贴的位置：第 2 页右边那一栏。夹具第 1 页的右栏已经有两张卡（y=0 和 y=320），
           而**第 2 页那一栏是空的** → 从页顶起：x = 600+44 = 644，y = 450+20 = 470。 */
        if (c.x === DOC_W + 44 && c.y === 470) ok(`★ 贴在第 2 页右边那一栏（x=${c.x}, y=${c.y}）`)
        else bad(`贴歪了：拿到 x=${c.x} y=${c.y}，期望 x=${DOC_W + 44} y=470`)
        const keptTxt = await s.eval(`(() => { const e = document.querySelector('.bd-hw-kept'); return e ? e.textContent.trim() : '' })()`)
        if (keptTxt.includes('已在板上')) ok('点过的那道题变成「' + keptTxt + '」（再点不会又落一张）')
        else bad('按钮没变成"已留下"：' + JSON.stringify(keptTxt))
      }
    }

    /* ── [10] 窗里那颗「📄 传一份作业的 PDF…」──
       这是用户最主要的动作（他原话：「我要把作业所在的那个 PDF 也传上来」）。
       ★ CDP 把文件选择器**拦下来**、再从浏览器那一侧把文件塞进那个框 ——
         往页面里塞一个 File 再派 change 是证明不了"按钮真接上了文件框"这件事的
         （按钮压根没接线，那种写法照样绿。和 check-deck 同一条理由）。
       ⚠ 这一段之后**板上会多一份资料**，那是**用户选的**（2026-09-22 问他
         "作业 PDF 要不要铺到板上"，他选"也铺到板上"）—— 所以上面那条
         "板上一个字节不变"必须在它**之前**断言完。 */
    const beforeUp = raw()
    const reopen = await rectOfText('.bd-tools .bd-t', HW_BUTTON)
    await clickAt(reopen)
    await until(async () => (await s.eval(`!!document.querySelector('.bd-hw')`)) === true, { what: '窗又开出来' })

    let chooser = null
    s.onEvent = (m, p) => {
      if (m === 'Page.fileChooserOpened') chooser = p
    }
    await s.send('DOM.enable')
    await s.send('Page.setInterceptFileChooserDialog', { enabled: true })

    const pickBtn = await rectOfText('.bd-hw-btn', '传一份作业的 PDF')
    if (!pickBtn) bad('窗里找不到「传一份作业的 PDF…」那颗按钮')
    else {
      await clickAt(pickBtn)
      const asked = await until(async () => chooser || undefined, { timeout: 8000, what: '弹出选文件那个框' })
      if (!asked.ok) bad('点了「传一份作业的 PDF…」，选文件那个框没开')
      else {
        ok('★ 点它 → 真开的是**选文件那个框**')
        if (chooser && chooser.backendNodeId) {
          await s.send('DOM.setFileInputFiles', { files: [ZZ_BOOK_PDF], backendNodeId: chooser.backendNodeId })
          const two = await until(
            async () => {
              const v = await s.eval(`(() => {
                const b = document.querySelector('.bd-hw')
                if (!b) return null
                const docs = [...b.querySelectorAll('.bd-hw-doc')]
                const on = b.querySelector('.bd-hw-doc.on')
                return docs.length >= 2 && on ? { n: docs.length, on: on.textContent.trim() } : null
              })()`)
              return v || undefined
            },
            { timeout: 30000, what: '窗里出现两份资料' }
          )
          if (two.ok) ok(`传完窗里变成 ${two.value.n} 份资料，而且选中了刚传的那一份（${two.value.on.replace(/\s+/g, ' ')}）`)
          else bad('传完了窗里没多出那一份')
          /* ⚠ 要**等它落盘**：应用保存有防抖（"正在存…"→"已存"），
             窗口里显示出来 ≠ 文件里已经有了 —— 上来就读 `raw()` 会读到上一版。 */
          const saved = await until(async () => (raw().includes('zz-homework-book') ? raw() : undefined), { timeout: 15000, what: '板上落了这份资料' })
          if (saved.ok && saved.value !== beforeUp) {
            ok('★ 传上来这份**铺到了板上**（用户选的就是"也铺到板上"）—— 能在书上直接圈题')
          } else bad('传完了板上没多出那份资料' + (saved.ok ? '（内容没变）' : '（等了 15 秒也没落盘）'))
        } else bad('拿不到文件框的句柄，文件塞不进去')
      }
    }

    /* ── [11] "板上一张讲解卡都没有"时也必须能做完（2026-09-22 用户报的错）──
       用户原话："我想让他帮我做题，但是却报错"，面板上弹的是那句英文
       `Cannot read properties of null (reading 'slice')`。

       根因：`knowledge` 这一段**前端在没讲义时根本不发**（`collectKnowledge` 回空串 →
       `homework-read.js` skip 掉那一段），而服务端的 `extractTextPart` 对"没有这一段"
       回的是 **null**（不是空串）—— server.js 里偏偏只有它没兜底，`null.slice(...)` 当场抛。

       ★ 上面 [3]~[10] 全都在**有讲义**的板上跑（夹具板故意带两张讲解卡），
         所以那一路永远盖不到这个 bug —— 这就是为什么必须单独加这一段：
         把它造出来（**把板上的卡全撤掉**）再走一遍完整的"开始做"。
       撤卡靠 CDP：夹具板是自检自己造的，删掉的也只是自检自己那些卡。 */
    {
      /* ① 把板上的卡片全删掉（只剩那份资料）→ 窗里那句就变成"一张讲解卡都没有"。
         ⚠ 夹具那两张讲解卡是 `locked: true`，而 `.bd-card-del`（×）**只在
            "选中 + 没锁"的时候才渲染**（Board.jsx 的 `selected && !editing && !locked`）——
            直接找 `.bd-card-del` 一张也点不到。所以每张卡要走真动作三步：
            点它选中 → 点左下角 📌 解锁 → 再点 ×。全程真鼠标（这个仓库的老规矩：
            看得见 ≠ 点得到，命中一律用 elementFromPoint 验）。
         ⚠ 这段注释活在**模板字符串里面**：这儿不许出现反引号。 */
      const rectOfCard = (i) =>
        s.eval(`(() => {
          const c = document.querySelectorAll('.bd-card')[${i}]
          if (!c) return null
          const r = c.getBoundingClientRect()
          const pin = c.querySelector('.bd-card-pin')
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), hasPin: !!pin }
        })()`)
      const rectOfPin = (i) =>
        s.eval(`(() => {
          const c = document.querySelectorAll('.bd-card')[${i}]
          if (!c) return null
          const p = c.querySelector('.bd-card-pin')
          if (!p) return null
          const r = p.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`)
      const rectOfDel = (i) =>
        s.eval(`(() => {
          const c = document.querySelectorAll('.bd-card')[${i}]
          if (!c) return null
          const d = c.querySelector('.bd-card-del')
          if (!d) return null
          const r = d.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`)

      /* ⚠ 失败的真因（第一次跑红在这）：上一节 [10] 在页面上**框住了一块**，
         那个选区还挂着；这一下点击落在卡片上，但真正抢走它的是那个残留的框 /
         工具刚切过来的第一下。两条一起做：
           ① 点一下**远处的空白**，让上一次的选区归零；
           ② 确保工具是 `select`（要拖卡片 / 缩放 / 改字就得是它 ——
              切 `pen` 反而"卡片给笔让路"，选不中）。 */
      await s.eval(`(() => {
        const b = document.querySelector('.bd-tools [data-tool="select"]')
        if (b) b.click()
        return true
      })()`)
      await s.sleep(200)
      await s.mouse(60, 60)
      await s.sleep(250)
      /* ①' 那个作业窗还开着（[10] 传完 PDF 之后一直在），它**浮在画布上** ——
          卡片中心那一块很可能被窗盖住，点在窗上了。先按 Esc 关掉它。 */
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await until(async () => (await s.eval(`!document.querySelector('.bd-hw')`)) === true, { what: '把作业窗关掉（好点到底下的卡片）' })
      /* ①'' 看一眼卡片中心那一点上到底是谁 —— 命中测试先问，再动手
           （"点了没反应"十有八九是被谁盖住了）。 */
      {
        const probe = await s.eval(`(() => {
          const c = document.querySelector('.bd-card')
          if (!c) return null
          const r = c.getBoundingClientRect()
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
          const hit = document.elementFromPoint(cx, cy)
          return { cx, cy, hit: hit ? String(hit.className || hit.tagName) : null, vw: window.innerWidth, vh: window.innerHeight }
        })()`)
        if (probe && probe.cx > 0 && probe.cy > 0 && probe.cx < probe.vw && probe.cy < probe.vh) {
          ok(`卡片中心在视口里（${probe.cx},${probe.cy}）—— 那一点上是「${probe.hit}」`)
        } else bad('卡片中心不在视口里：' + JSON.stringify(probe))
      }

      let removed = 0
      for (let pass = 0; pass < 8; pass += 1) {
        const n = await s.eval(`document.querySelectorAll('.bd-card').length`)
        if (!n) break
        const c = await rectOfCard(0)
        if (!c) break
        await clickAt(c)
        await s.sleep(180)
        /* 锁着的先解锁：点一下 📌（`data-card-pin` 会从 lock 变 unlock）。 */
        let st = await s.eval(`(() => { const e = document.querySelector('.bd-card'); return e ? { locked: e.classList.contains('locked'), on: e.classList.contains('on') } : null })()`)
        if (st && !st.on) {
          /* 还没选中：再点一次（工具刚切过来，第一下可能只是把焦点还给画布）。 */
          await clickAt(c)
          await s.sleep(180)
          st = await s.eval(`(() => { const e = document.querySelector('.bd-card'); return e ? { locked: e.classList.contains('locked'), on: e.classList.contains('on') } : null })()`)
        }
        if (st && st.locked) {
          const pin = await rectOfPin(0)
          if (pin) {
            await clickAt(pin)
            await s.sleep(180)
          }
        }
        const d = await rectOfDel(0)
        if (!d) {
          const dbg = await s.eval(`(() => { const e = document.querySelector('.bd-card'); return { locked: e ? e.classList.contains('locked') : null, on: e ? e.classList.contains('on') : null, hasDel: e ? !!e.querySelector('.bd-card-del') : null } })()`)
          bad('卡上没出现 × 按钮，撤不掉：' + JSON.stringify(dbg))
          break
        }
        await clickAt(d)
        await s.sleep(180)
        const after = await s.eval(`document.querySelectorAll('.bd-card').length`)
        if (after >= n) {
          bad('点了 × 卡片数没减（' + n + ' → ' + after + '）—— 撤卡循环卡住了')
          break
        }
        removed += 1
      }
      const gone = await s.eval(`document.querySelectorAll('.bd-card').length`)
      if (gone === 0) ok(`★ 板上的卡撤干净了（删了 ${removed} 张，现在 0 张 —— 这就是"一张讲解卡都没有"的板）`)
      else bad(`卡没撤干净，还剩 ${gone} 张 —— 这一段的前提不成立`)

      if (gone === 0) {
        /* ② 重新把那个窗开出来 —— 卡撤掉之前它被 Esc 关掉了（为了点得到底下的卡片）。
             这一开，里面那句就该变成"板上一张讲解卡都没有"。 */
        const reopen2 = await rectOfText('.bd-tools .bd-t', HW_BUTTON)
        if (!reopen2) bad('找不到「' + HW_BUTTON + '」那颗按钮，窗开不出来')
        else {
          await clickAt(reopen2)
          await until(async () => (await s.eval(`!!document.querySelector('.bd-hw')`)) === true, { what: '作业窗又开出来' })
        }
        const none = await until(
          async () =>
            (await s.eval(
              `(() => { const e = document.querySelector('.bd-hw-none'); return e ? e.textContent.trim() : '' })()`
            )) || undefined,
          { timeout: 8000, what: '窗里出现"板上一张讲解卡都没有"' }
        )
        if (none.ok) ok('★ 窗里说「' + none.value + '」—— 正是用户截图里那一幕')
        else bad('撤了卡，窗里却没换成"没有讲解卡"那句话')

        /* ③ 写一道题、点开始做 → **必须收到请求**（有请求 = 服务端没在 slice 上崩）。 */
        const n2 = seen.length
        await typeInto('.bd-hw-ta', '第 1 页第 3 题')
        const go3 = await rectOfText('.bd-hw-foot .bd-hw-btn', '开始做')
        if (!go3) bad('没有讲义时不给出「开始做」那颗按钮')
        else {
          await clickAt(go3)
          const got3 = await until(async () => (seen.length > n2 ? seen[seen.length - 1] : undefined), { timeout: 25000, what: '没有讲义时也该收到请求' })
          if (!got3.ok) {
            const dbg = await s.eval(`(() => {
              const b = document.querySelector('.bd-hw')
              if (!b) return { win: false }
              const t = (sel) => { const el = b.querySelector(sel); return el ? el.textContent.trim() : '' }
              return { win: true, err: t('.bd-hw-err'), busy: t('.bd-hw-busy') }
            })()`)
            bad('★ 没有讲义时点「开始做」收不到请求 —— 窗口里是这样：' + JSON.stringify(dbg))
          } else {
            ok('★★ 没有讲义时照样把题发出去了（服务端没在 slice 上崩）—— 这就是用户报的那个 bug 的现场')
            if (/陪着学生做作业/.test(got3.value.promptText)) ok('走的还是作业辅导那段提示词')
            else bad('提示词不对：' + got3.value.promptText.slice(0, 80))
            if (/没给你这节课的讲义/.test(got3.value.promptText)) ok('★ 提示词里换成那句实话"没给你这节课的讲义"（空讲义那条退路）')
            else bad('没有讲义时提示词里少了那句实话')
            if (!/夹具里的讲解/.test(got3.value.promptText)) ok('板上撤掉的那些讲解**确实没跟过去**（撤了就是撤了）')
            else bad('讲解卡撤掉了，讲义却还在提示词里')
          }
          /* ④ 最后再确认一次：窗口里**没有**那串英文报错。 */
          const errTxt = await s.eval(`(() => { const e = document.querySelector('.bd-hw-err'); return e ? e.textContent.trim() : '' })()`)
          if (!/Cannot read properties of null/.test(errTxt)) ok('★ 窗口里没有那句 `Cannot read properties of null`（用户看到的那串英文没了）')
          else bad('窗里还是那串英文：' + JSON.stringify(errTxt))
        }
      }
    }

    /* ── [12] ★ 追问（2026-09-22 用户要的："学生不懂的话可以继续问答案哪里是为什么"）──
       用户原话：「对于问到的答案再加一个追问的功能，学生不懂的话可以继续问答案哪里是为什么」，
       入口他定的是「每道题下面一个「继续问」」。

       ★ 这一条要验的是**那一趟请求长什么样** —— 追问和"再做一次"长得几乎一样，
         只有三处不一样，而三处里错了任何一处都会"看起来在答、其实答的不是这道题"：
           ① 服务端收到的是 `mode=hwask`（不是 homework）—— 提示词跟着换；
           ② 那几页页图**又发了一遍**（老师必须还看得见题）；
           ③ `history` 里压着**这道题的题面 + 老师刚给的答案**（否则一句"为什么除以 m"
              它连是哪道题都不知道）。
       ⚠ 前面 [11] 把板上的卡全撤了、还发了一趟没有讲义的题 —— 那一步之后
         `result` 是**没有讲义那一趟**的（"第 1 页第 3 题"），假服务回的还是同一个 REPLY
         （两道题），所以 `.bd-hw-prob` 照样在，[12] 接着用没有问题。
       ★ 进这一节之前窗是**开着的**（[11] ③ 刚点完开始做），不用重新开。 */
    {
      /* 先等这一趟落定（[11] 那一趟可能还在飞）。 */
      const settled = await until(
        async () => {
          const v = await s.eval(`(() => {
            const b = document.querySelector('.bd-hw')
            if (!b) return null
            return { busy: !!b.querySelector('.bd-hw-busy'), n: b.querySelectorAll('.bd-hw-prob').length }
          })()`)
          return v && !v.busy && v.n > 0 ? v : undefined
        },
        { what: '题目落定（好开始追问）', timeout: 25000 }
      )
      if (!settled.ok) bad('窗口里没有题目，追问无从谈起 —— [11] 那一趟没落下结果？')
      else {
        /* ① 每道题下面都有一颗「💬 继续问」——用户点名的入口。 */
        const askBtns = await s.eval(`(() => {
          const probs = [...document.querySelectorAll('.bd-hw-prob')]
          const out = probs.map((p) => {
            const row = p.querySelector('.bd-hw-askrow')
            const ta = row ? row.querySelector('.bd-hw-ta.sm') : null
            const btn = row ? row.querySelector('.bd-hw-btn.primary') : null
            return { hasRow: !!row, hasTa: !!ta, btn: btn ? btn.textContent.trim() : '' }
          })
          return { n: probs.length, rows: out }
        })()`)
        if (askBtns.n && askBtns.rows.every((r) => r.hasRow && r.hasTa && r.btn.includes('继续问')))
          ok(`★ 每道题下面都有「💬 继续问」+ 一个输入框（${askBtns.n} 道题 → ${askBtns.n} 套）`)
        else bad('追问的入口没铺齐：' + JSON.stringify(askBtns))

        /* ② 在第 1 道题下面写一句"为什么"，点「继续问」。 */
        const put = await s.eval(`(() => {
          const row = document.querySelector('.bd-hw-prob .bd-hw-askrow')
          if (!row) return null
          const ta = row.querySelector('.bd-hw-ta.sm')
          const btn = row.querySelector('.bd-hw-btn.primary')
          if (!ta || !btn) return null
          ta.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          const rt = ta.getBoundingClientRect(), rb = btn.getBoundingClientRect()
          const hitT = document.elementFromPoint(Math.round(rt.left + 24), Math.round(rt.top + rt.height / 2))
          const hitB = document.elementFromPoint(Math.round(rb.left + rb.width / 2), Math.round(rb.top + rb.height / 2))
          return {
            ta: { x: Math.round(rt.left + 24), y: Math.round(rt.top + rt.height / 2) },
            btn: { x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + rb.height / 2) },
            hitT: hitT ? (hitT.className || hitT.tagName) : null,
            hitB: hitB ? (hitB.className || hitB.tagName) : null,
            btnDisabled: !!btn.disabled,
          }
        })()`)
        if (!put) bad('找不到第 1 道题下面那个追问输入框 / 按钮')
        else {
          if (put.btnDisabled) ok('输入框还空着时，「继续问」**是灰的**（没话说的时候点不动，少一次白跑）')
          else bad('输入框空着，「继续问」就是亮的 —— 点了会发一趟没有问题的请求')
          /* ★ 先写话：点进输入框 → 用量子打字进一句话。
             输入框空着时按钮是灰的，所以"先打字"是必须的一步（不是可选）。 */
          await s.mouse(put.ta.x, put.ta.y)
          await s.sleep(140)
          await s.send('Input.insertText', { text: '这一步为什么要除以 3？' })
          await s.sleep(220)
          /* 打完字之后按钮该亮了（空输入框那颗是灰的）。 */
          const lit = await s.eval(`(() => {
            const btn = document.querySelector('.bd-hw-prob .bd-hw-askrow .bd-hw-btn.primary')
            return btn ? !btn.disabled : null
          })()`)
          if (lit === true) ok('写了字之后「继续问」亮了（不是一颗死按钮）')
          else bad('写了字之后「继续问」还是灰的 —— 点不动')

          const n3 = seen.length
          await s.mouse(put.btn.x, put.btn.y)
          const got = await until(async () => (seen.length > n3 ? seen[seen.length - 1] : undefined), { timeout: 25000, what: '追问那一趟的请求' })
          if (!got.ok) {
            const dbg = await s.eval(`(() => {
              const b = document.querySelector('.bd-hw')
              const t = (sel) => { const el = b ? b.querySelector(sel) : null; return el ? el.textContent.trim() : '' }
              return { win: !!b, err: t('.bd-hw-err'), ask: t('.bd-hw-ask') }
            })()`)
            bad('点了「继续问」，假识别服务没收到请求 —— 窗里是这样：' + JSON.stringify(dbg))
          } else {
            const req = got.value
            /* ★★ 三处差异，逐一验。 */
            if (req.promptText.includes('还有一处没懂')) ok('★ 走的是**追问**那段提示词（不是作业辅导那一段）')
            else bad('提示词不像追问那一段：' + req.promptText.slice(0, 100))
            if (req.images >= 1) ok(`★ 那几页页图**又发了一遍**（${req.images} 张）—— 老师必须还看得见题`)
            else bad('追问没带页图 —— 一句"为什么"它会空口瞎讲')
            /* history 的条数：题面那段 + 这一次问的。服务端拼的是
               [0] 图+提示词，后面按时间跟历史，**最后一条是这一次问的**
               → messages 至少是 1（首条）+ 1（题面）+ 1（这一次问的）。 */
            if (req.messages >= 3) ok(`★ 对话拼出来了（${req.messages} 条 messages：图+提示词 → 题面 → 这次问的）`)
            else bad('messages 太少了（' + req.messages + ' 条）—— history 没带上，它不知道在问哪道题')
            /* ★ 题面那段话里要有**老师刚给的解析**（"为什么"的对象）。
               假服务把整段 messages 拼起来看最直观。 */
            const joined = String(req.joined || '')
            if (/牛顿第二定律/.test(joined)) ok('★ 老师刚给的那段**解析**在对话里（学生问的"这一步"指得着东西了）')
            else bad('对话里没有老师刚给的那段解析 —— 那句"为什么"是悬空的：' + joined.slice(0, 160))
            if (/为什么要除以 3/.test(joined)) ok('学生这次问的那句话在对话里（而且是**最后一条**）')
            else bad('对话里没有学生这次问的话')

            /* ★★ 最后看**屏幕上**：那一问和那一答得挂在**第 1 道题下面**，
               而且答案要真排出来（不是一片"老师正在想…"停在屏幕上）。
               ⚠ 这条不能省：上面几条只看"请求发对了"，而"发对了但界面上
                 什么都没显示"是一种真实存在过的坏法（状态没落到 `askTurns` 上）。 */
            const shown2 = await until(
              async () => {
                const v = await s.eval(`(() => {
                  const p0 = document.querySelector('.bd-hw-prob')
                  if (!p0) return null
                  const turns = [...p0.querySelectorAll('.bd-hw-turn')]
                  const me = turns.find((t) => t.classList.contains('me'))
                  const others = turns.filter((t) => !t.classList.contains('me'))
                  const katex = p0.querySelectorAll('.bd-hw-turn .katex').length
                  const thinking = !!p0.querySelector('.bd-hw-thinking')
                  return {
                    turns: turns.length,
                    me: me ? me.textContent.trim() : '',
                    ans: others.length ? others[others.length - 1].textContent.trim() : '',
                    katex,
                    thinking,
                  }
                })()`)
                return v && v.turns >= 2 && !v.thinking && v.ans ? v : undefined
              },
              { what: '追问的一问一答显示出来', timeout: 20000 }
            )
            if (shown2.ok) {
              const v = shown2.value
              ok(`★ 那一问一答挂在了第 1 道题下面（${v.turns} 轮）`)
              if (/为什么要除以 3/.test(v.me)) ok('★ 学生问的那句显示出来了（他知道自己问了什么）')
              else bad('学生问的那句没显示：' + JSON.stringify(v.me))
              if (/速度/.test(v.ans)) ok('★ 老师的回答显示出来了（接着答案讲的那段）')
              else bad('老师的回答没显示出来：' + JSON.stringify(v.ans).slice(0, 120))
              if (v.katex > 0) ok(`★ 回答里的公式**排出来了**（KaTeX ${v.katex} 处）—— 和答案、解析同一套渲染`)
              else bad('追问的回答里公式没排出来（学生看到的是一堆 $ 和反斜杠）')
            } else {
              const dbg2 = await s.eval(`(() => {
                const p0 = document.querySelector('.bd-hw-prob')
                const t = (sel) => { const el = p0 ? p0.querySelector(sel) : null; return el ? el.textContent.trim() : '' }
                return { turns: p0 ? p0.querySelectorAll('.bd-hw-turn').length : 0, think: t('.bd-hw-thinking'), terr: t('.bd-hw-terr') }
              })()`)
              bad('追问发出去了，但屏幕上没出现一问一答：' + JSON.stringify(dbg2))
            }

            /* ★ 追问**不会**把这块题弄丢：`.bd-hw-prob` 还是那些（不是重做了一遍），
               而且板上的字节一个都没动 —— 追问是窗里的事，和板无关。 */
            const nowProbs = await s.eval(`document.querySelectorAll('.bd-hw-prob').length`)
            if (nowProbs === settled.value.n) ok(`追问没有把题目弄丢（还是 ${nowProbs} 道）`)
            else bad(`追问之后题数变了：${settled.value.n} → ${nowProbs}`)
          }
        }
      }
    }

    const errs = s.errors ? s.errors() : []
    if (!errs.length) ok('页面上没有 JS 报错')
    else bad('页面报错了：' + errs.slice(0, 3).map((e) => String(e && e.message ? e.message : e)).join(' / '))
  }
)

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exitCode = fails ? 1 : 0
