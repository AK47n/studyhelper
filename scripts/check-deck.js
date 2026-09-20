/* check-deck：**课件整理**这条链路的端到端（2026-09-22）。
 *
 * 真浏览器里从头走一遍，每一步都盯一件用户真正在意的事：
 *   [1] 工具条上那颗「✧ 课件整理」看得见、点得到；
 *   [2] 点它 → 弹出**它自己**的窗口（不是浏览器的 prompt），上面写着这份资料有几页；
 *   [3] 挑页 → 读：一页一页地问假识别服务（**每页带对了页码**），边读边往窗口里填；
 *   [4] 没读出来的那一页只影响那一页，别的页照样读完（"一页一次调用"挣来的东西）；
 *   [5] 点「贴到白板上」→ 卡片**落进文件**（这一步是这条链路的终点，前面全绿都不算）；
 *   [6] 落的是真卡片：文字卡带文字、公式卡带 tex、标题那一条不丢；
 *   [7] 关了窗口重开一次 → 第二趟一页都不发（缓存命中）—— 一件事不该花两次钱；
 *   [8] 贴完之后**笔照常在资料上写**（这个功能的用法就是"看着课件写"）。
 *
 * 假识别服务：DeepSeek 的形状（OpenAI 兼容），回的话由**提示词里的页码**决定 ——
 * 真模型也是这么被问的（server-ocr.js 把"这一页是第 N 页"拼进提示词）。
 * ⚠ 假服务按"第几次请求"回话是不够的：那样"页码有没有发对"根本没被验到。
 *
 * 它自己起服务（5236）和 headless Edge（9276），跑完都收掉；夹具板 board-zz-deckcheck.md
 * 和夹具 PDF .资料/zz-deck-smoke.pdf 都自造自删；用户那张板一个字节都不动（守卫照常盯着）。
 *
 * 用法：node scripts/check-deck.js   （或 npm run check:deck）
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { withBoard, DATA, ROOT } from './lib/board-check.js'
import { newBoard, serializeBoardDocument } from '../src/lib/board.js'

const MOCK_PORT = Number(process.env.DECK_TEST_MOCK_PORT || 5199)
const TEST_TOKEN = 'sk-deck-test-0123456789'

const FIX_PDF = path.join(DATA, '.资料', 'zz-deck-smoke.pdf')
const FIX_NAME = '.资料/zz-deck-smoke.pdf'

/* ── 把用户自己的识别配置挪开 ──────────────────────────────────────────
 * `loadConfig` 只在**没有** config/ocr.json 时才读环境变量（那个设计是对的：
 * 界面里存过的东西不该被环境变量默默覆盖）。所以自检要先把那份文件挪开，
 * 跑完放回 —— 和 check-ocr-browser.js 同一条规矩，连备份后缀都跟它一样，
 * 免得两份自检撞在一起时互相踩（那一节写得很细，见那边的注释）。
 * ⚠ 这个文件在 .gitignore 里：**弄丢就找不回来**（里面是你的密钥），
 *   所以收尾那一段必须无条件把它放回去。 */
const realConfig = path.join(ROOT, 'config', 'ocr.json')
const stash = realConfig + '.checkdeck-bak'
let stashed = false

function stashConfig() {
  try {
    if (fs.existsSync(realConfig)) {
      if (fs.existsSync(stash)) fs.rmSync(stash) // 上次没收干净（崩过）—— 以这次为准
      fs.renameSync(realConfig, stash)
      stashed = true
    }
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

/* ── 夹具 PDF：三页，每页一个页码大字（pdf.js 画得出来就够）──
   手写 PDF 字节，不引第三方（和 check-doc.js 那份同一个路子）。 */
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
    const stream = `0.9 0.9 0.9 rg 40 40 640 460 re f 0.2 0.2 0.2 rg BT /F1 72 Tf 300 250 Td (P${i + 1}) Tj ET`
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

/* ── 假识别服务回的"知识点"：一页一段，**按提示词里的页码**挑 ──
   三页刻意做成三档：第 1 页有正文、第 2 页有公式、第 3 页是空页（封面/过渡页那种）。 */
const PER_PAGE = {
  1: { page: 1, unit: '力与运动', points: [{ kind: 'note', title: '受力分析', body: '先画受力图，再定正方向。' }] },
  2: { page: 2, unit: '', points: [{ kind: 'formula', tex: 'F=ma' }, { kind: 'note', title: '适用条件', body: '惯性系里才成立。' }] },
  3: { page: 3, points: [] },
}

/* 假服务：记下每一次请求（提示词、图多大、认的哪一页），按页码回话。 */
let mockCode = 200
let mockDelayMs = 0
let forceFailPage = 0
const seen = []
const mock = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    let json = null
    try {
      json = JSON.parse(raw.toString('utf8'))
    } catch {}
    const content = json && json.messages && json.messages[0] && json.messages[0].content
    const img = Array.isArray(content) ? content.find((c) => c.type === 'image_url') : null
    const b64 = img && img.image_url && img.image_url.url ? String(img.image_url.url).replace(/^data:image\/\w+;base64,/, '') : ''
    const buf = b64 ? Buffer.from(b64, 'base64') : null
    const promptText = Array.isArray(content) && content[0] ? String(content[0].text || '') : ''
    const m = /第 (\d+) 页/.exec(promptText)
    const page = m ? Number(m[1]) : 0
    seen.push({
      page,
      model: json ? json.model : null,
      temperature: json ? json.temperature : null,
      tokens: json && json.max_tokens ? json.max_tokens : null,
      imageBytes: buf ? buf.length : 0,
      /* JPEG（FFD8FF）—— 课件整理发的是 JPEG（几页一并发的话体积会爆） */
      imageJpeg: !!buf && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
      imageW: buf && buf.length > 4 ? buf.readUInt16BE(0) : 0,
    })
    const send = () => {
      try {
        if (res.destroyed) return
        if (mockCode !== 200) {
          res.writeHead(mockCode, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: '假的失败' } }))
        }
        const body =
          forceFailPage && page === forceFailPage
            ? { choices: [{ message: { role: 'assistant', content: '这一页我看不清。' } }] }
            : { choices: [{ message: { role: 'assistant', content: JSON.stringify(PER_PAGE[page] || { page, points: [] }) } }] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      } catch {}
    }
    if (mockDelayMs) setTimeout(send, mockDelayMs)
    else send()
  })
})

const mockUp = await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r(true)))

/* ── 夹具板：一份三页的资料摆在 (0,0)，宽 720 ── */
function makeBoard() {
  const b = newBoard('deck 自检夹具（跑完自动删除）')
  b.docs = [{ id: 'doczzdeck1', path: FIX_NAME, title: '冒烟课件', x: 0, y: 0, w: 720, pages: [[720, 540], [720, 540], [720, 540]] }]
  return serializeBoardDocument(b)
}

/* 窗口里那几个读数（每次问一遍，够用又不啰嗦） */
const DKR = `(() => {
  const back = document.querySelector('.dkr-back')
  if (!back) return { open: false }
  const items = [...document.querySelectorAll('.dkr-item')]
  const blocks = [...document.querySelectorAll('.dkr-pgblk')]
  return {
    open: true,
    head: (document.querySelector('.dkr .wp-head') || {}).textContent || '',
    pickRows: document.querySelectorAll('.dkr-pg').length,
    picked: document.querySelectorAll('.dkr-pg.on').length,
    blocks: blocks.length,
    unit: (document.querySelector('.dkr-unit') || {}).textContent || '',
    items: items.map((el) => ({
      kind: (el.querySelector('.dkr-kind') || {}).textContent || '',
      title: el.querySelector('.dkr-t') ? el.querySelector('.dkr-t').value : '',
      body: el.querySelector('.dkr-b') ? el.querySelector('.dkr-b').value : '',
      tex: el.querySelector('.dkr-tex') ? el.querySelector('.dkr-tex').value : '',
      off: el.classList.contains('off'),
      rendered: !!el.querySelector('.dkr-texprev .katex'),
    })),
    warns: [...document.querySelectorAll('.dkr-warn')].map((x) => x.textContent),
    emptyPages: [...document.querySelectorAll('.dkr-pgblk')].filter((b) => /没有知识点/.test(b.textContent)).length,
    acts: (document.querySelector('.dkr-acts') || {}).textContent || '',
  }
})()`

const fails = await withBoard(
  {
    tag: 'deckcheck',
    port: 5236,
    cdpPort: 9276,
    make: makeBoard,
    env: {
      STUDYHELPER_OCR_ENABLED: '1',
      STUDYHELPER_OCR_PROVIDER: 'deepseek',
      STUDYHELPER_OCR_DS_BASE: `http://127.0.0.1:${MOCK_PORT}/chat/completions`,
      STUDYHELPER_OCR_MODEL: 'deepseek-flash',
      STUDYHELPER_OCR_TOKEN: TEST_TOKEN,
    },
  },
  async ({ s, ok, bad, open, until, untilFile, after }) => {
    fs.mkdirSync(path.dirname(FIX_PDF), { recursive: true })
    fs.writeFileSync(FIX_PDF, buildPdf(3))
    after(() => {
      try {
        fs.rmSync(FIX_PDF, { force: true })
      } catch {}
    })

    await open()

    /* 等资料层挂上（后面点按钮要有它） */
    await until(async () => ((await s.eval(`!!document.querySelector('.bd-docbar')`)) ? 1 : undefined), { timeout: 10000, what: '资料条出现' })

    console.log('\n[1] 工具条上那颗「✧ 课件整理」看得见、点得到')
    const btn = await s.eval(`(() => {
      const b = document.querySelector('[data-tool="deckread"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2)
      const cy = Math.round(r.top + r.height / 2)
      const hit = document.elementFromPoint(cx, cy)
      return { x: cx, y: cy, text: b.textContent, hitSelf: !!(hit && hit.closest('[data-tool="deckread"]')) }
    })()`)
    if (!btn) bad('工具条上没有「✧ 课件整理」（data-tool="deckread"）')
    else {
      ok(`按钮在（"${btn.text.trim()}"）`)
      if (btn.hitSelf) ok(`elementFromPoint 命中它自己（${btn.x},${btn.y}）—— 没被别的层盖住`)
      else bad('按钮被别的层盖住了（点下去不会开窗口）')
    }

    console.log('\n[2] 点它 → 弹的是它自己的窗口，上面写着这份资料一共几页')
    await s.mouse(btn.x, btn.y)
    const opened = await until(async () => {
      const r = await s.eval(DKR)
      return r.open ? r : undefined
    }, { timeout: 8000, what: '课件整理窗口弹出来' })
    if (!opened.ok) {
      bad('点了按钮没弹窗口（等到 ' + opened.waited + 'ms）')
      console.log('  （页面报错：' + (s.errors().length ? s.errors().slice(0, 2).join(' ｜ ') : '无') + '）')
      return
    }
    const d0 = opened.value
    ok('窗口弹出来了（.dkr-back）')
    if (/冒烟课件/.test(d0.head)) ok('标题里写着是哪一份课件：' + d0.head.replace(/\s+/g, ' ').slice(0, 40))
    else bad('标题里没写课件名：' + d0.head)
    if (d0.pickRows === 3) ok('挑页那一摞是 3 格（这份资料 3 页）')
    else bad('挑页格子数不对：' + d0.pickRows)
    if (d0.picked === 3) ok('★ 默认**全选**（"往往是几十页这个数量级"，默认从头读，用户可以改）')
    else bad('默认没全选：' + d0.picked)

    /* 挑页：清空 → 用区间输入挑 1-2（**顺便验区间这条路**，它才是几十页时真正用得到的那条） */
    await s.eval(`[...document.querySelectorAll('.dkr-pickrow .mini')].find(b => b.textContent.includes('清空')).click()`)
    const cleared = await until(async () => {
      const r = await s.eval(DKR)
      return r.picked === 0 ? r : undefined
    }, { timeout: 3000, what: '清空选中' })
    if (cleared.ok) ok('「清空」把选中清掉了')
    else bad('清空没生效')

    /* 窗口里那几个动作用的：把区间填进去（**并且等界面真接收了**再往下走）。 */
    const parseSpec = (spec) => {
      const out = new Set()
      for (const c of String(spec).split(/[\s,，、;；]+/)) {
        const m = /^(\d+)\s*(?:[-~—–至到]\s*(\d+))?$/.exec(c)
        if (!m) continue
        const a = Number(m[1])
        const b = m[2] ? Number(m[2]) : a
        for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) out.add(i)
      }
      return out.size
    }
    const setRange = async (v) => {
      await s.eval(`(() => {
        const inp = document.querySelector('.dkr-range')
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, ${JSON.stringify(String(v))})
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      /* ★ 等"这一行真被接收了"再往下走：React 的 onChange 是异步提交的，
         紧跟着读 DOM 会读到上一次渲染的世界 —— 自检前面就栽在这儿：
         区间设成 2-3，界面还停在上一段的 1,3，于是读的是错的页、断言全歪。
         判据用界面上那句「已选 N 页」（它由选中集算出来，改没改一看就知道）。
         ⚠ 选择器要挑**那一句**：`.dkr-pickrow .dim` 会先命中"整理哪几页："那个 span
           （它也是 .dim），于是永远读不到"已选"——一句话都匹配不上，
           而表现是"区间没被接收"（自检自己的选择器写歪了）。 */
      const want = parseSpec(v)
      if (!want) return true
      const got = await until(async () => {
        const t = await s.eval(`(document.querySelector('.dkr-pickrow .dim.small:not(:first-child)') || {}).textContent || ''`)
        const m = /已选 (\d+) 页/.exec(t)
        return m && Number(m[1]) === want ? m[1] : undefined
      }, { timeout: 4000, what: `选中变成 ${want} 页` })
      if (!got.ok) bad(`区间「${v}」没被界面接收（要 ${want} 页）—— 那行字是：` + (await s.eval(`[...document.querySelectorAll('.dkr-pickrow .dim')].map(e => e.textContent).join(' ｜ ')`)))
      return got.ok
    }
    const clickRead = () => s.eval(`[...document.querySelectorAll('.dkr-pickrow .mini')].find(b => b.textContent.includes('读这几页')).click()`)

    console.log('\n[2b] ★ 先问一句"这条路通不通"，再一页一页地发（别让 49 页去撞同一堵墙）')
    /* 把本地服务的密钥清掉（假的，跑完恢复）→ 点「读这几页」→
       必须在**一个请求都没发**的前提下就拦住，并且说清下一步。 */
    {
      const before = seen.length
      const put = await s.eval(`fetch('/api/ocr/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: '' }) }).then(r => r.json())`)
      if (!put || put.ok === false) bad('清密钥失败（这一节验不了）：' + JSON.stringify(put))
      await setRange('1-2')
      await clickRead()
      const blocked = await until(async () => {
        const r = await s.eval(`(() => {
          const w = document.querySelector('.dkr-warn')
          return w ? { text: w.textContent, set: !!w.querySelector('.dkr-goset'), blocks: document.querySelectorAll('.dkr-pgblk').length } : null
        })()`)
        return r && /密钥/.test(r.text) ? r : undefined
      }, { timeout: 6000, what: '窗口把"没配密钥"说出来' })
      if (blocked.ok) ok('没配密钥 → 窗口当场说清（' + blocked.value.text.replace(/\s+/g, ' ').slice(0, 34) + '…）')
      else bad('没配密钥时没说清，窗口里是：' + JSON.stringify(await s.eval(`(document.querySelector('.dkr-warn')||{}).textContent || '(没有那句话)'`)))
      if (blocked.ok && blocked.value.set) ok('★ 那句话旁边就有「去设置」那颗按钮（用户不用自己去找）')
      else bad('没有「去设置」的入口')
      if (seen.length === before) ok('★ 一个请求都没发出去（49 页不会去撞同一堵墙）')
      else bad('还是发了 ' + (seen.length - before) + ' 个请求')
      if (blocked.ok && blocked.value.blocks === 0) ok('窗口留在挑页那一屏（没有进"一页一块"那个空壳）')
      else bad('窗口进了读数那一屏：' + JSON.stringify(blocked.value && blocked.value.blocks))
      const back = await s.eval(`fetch('/api/ocr/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ${JSON.stringify(TEST_TOKEN)} }) }).then(r => r.json())`)
      if (!back || back.ok === false) bad('把假密钥写回去失败 —— 后面的段落会跟着失败：' + JSON.stringify(back))
      /* 那句拦路的话要能自己消掉（下一次点「读这几页」就不该再挂着它）。
         ★ 这里读 **1、3**（不是 1-2）：第 3 页是夹具里的"空页"，读它一个知识点都不出，
           但它占掉一次请求 —— 正好让下面那一节读的 1、2 里**第 2 页还是没读过的**，
           于是那一节两次请求都是真发的（不然验的是缓存）。 */
      await setRange('1,3')
      await clickRead()
      const gone = await until(async () => ((await s.eval(`!!document.querySelector('.dkr-warn')`)) ? undefined : 1), { timeout: 6000, what: '拦路那句话消失' })
      if (gone.ok) ok('配好了再点 → 那句话自己消失（不粘着）')
      else bad('那句话还挂着')
      /* 已经读进来了，回挑页那一屏、按下面的正式流程重来一遍 */
      await s.eval(`[...document.querySelectorAll('.dkr-acts .mini')].find(b => b.textContent.includes('先不整理')).click()`)
      await until(async () => ((await s.eval(`!document.querySelector('.dkr-back')`)) ? 1 : undefined), { timeout: 4000, what: '窗口关掉' })
      /* ⚠ 窗口关了之后**不要再动里面那几个控件**：React 的提交是异步的，
         那一次 setState 会落到**下一个**窗口的头上（表现是"下一个窗口的默认选中
         莫名其妙变成了上一次那个区间"）。要设区间就等窗口重新开出来再设。 */
    }
    await s.mouse(btn.x, btn.y)
    await until(async () => ((await s.eval(`!!document.querySelector('.dkr-back')`)) ? 1 : undefined), { timeout: 6000, what: '窗口重开' })

    console.log('\n[3] 读：一页一页地问，**每页带对了页码**，边读边往窗口里填')
    /* ★ [2b] 已经真读过 1、2、3 三页（"配好了就能读"那一步），所以这一节读 1、2 时
       **第 1 页命中缓存、一个请求都不发** —— 这一节因此只验得到"第 2 页真发了请求"。
       这正是该有的样子（同一页不花两次钱），所以断言按它写：
       第 2 页必须真发一次、页码必须是 2；第 1 页走缓存、界面上标着「上次读的」。
       夹具的分布：第 1 页 = 文字知识点 + 小节名；第 2 页 = 一条公式 + 一条文字。 */
    await setRange('1-2')
    /* 清账的时机**必须在点下去之前**：写在 await 之后的话，回来的那些会被算到
       "上一节发了几次"里去（这一节那两条断言就是靠它算的）。 */
    seen.length = 0
    mockDelayMs = 250 // 慢一点回，"边读边填"才看得出来（真模型也要几秒）
    await clickRead()
    const filled = await until(async () => {
      const r = await s.eval(DKR)
      return r.blocks >= 2 && r.items.length >= 2 ? r : undefined
    }, { timeout: 15000, what: '两页都读出来了' })
    if (!filled.ok) {
      bad('两页没读出来（等到 ' + filled.waited + 'ms）')
      const dbg = await s.eval(DKR)
      console.log('  （窗口里：' + JSON.stringify(dbg).slice(0, 400) + '）')
      const txt = await s.eval(`(() => { const el = document.querySelector('.dkr'); return el ? el.innerText.replace(/\\n+/g, ' | ').slice(0, 700) : '(窗口不在了)' })()`)
      console.log('  （窗口文字：' + txt + '）')
      console.log('  （假服务收到：' + JSON.stringify(seen.map((x) => x.page)) + '）')
      console.log('  （页面报错：' + (s.errors().length ? s.errors().slice(0, 2).join(' ｜ ') : '无') + '）')
      return
    }
    ok(`两页都读了，窗口里有 ${filled.value.items.length} 条知识点（${filled.value.blocks} 块）`)
    const asked = seen.map((x) => x.page).filter((n) => n > 0)
    /* 这一节读 1、2：第 1 页在 [2b] 里读过了（缓存），所以**只有第 2 页该发请求**。 */
    if (asked.length === 1 && asked[0] === 2) ok('★ 真发出去的只有第 2 页、而且页码就是 2（页码发对了 —— 它靠这个回话）')
    else bad('发出去的页码不对：' + JSON.stringify(seen.map((x) => x.page)))
    if (asked.length === 1) ok('★ **一页一次调用**（一页 = 一次请求，不是打包发一次）')
    else bad('调用次数不对：' + asked.length)
    const cachedTag1 = await s.eval(`document.querySelectorAll('.trv-tag.ok').length`)
    if (cachedTag1 === 1) ok('第 1 页标着「上次读的」（缓存命中 —— 同一页没花第二次钱）')
    else bad('「上次读的」标签数不对：' + cachedTag1)
    /* ⚠ 这几条判据的**前提是"真发了请求"**：空数组上 every() 恒真，
       不设这道门的话，"一个请求都没发"会被读成"发的是 JPEG"（假绿，最难查）。 */
    const allJpeg = seen.length > 0 && seen.every((x) => x.imageJpeg)
    if (allJpeg) ok('发的是 JPEG（课件的页面位图）')
    else bad('发出去的不是 JPEG / 没发：' + JSON.stringify(seen.map((x) => x.imageJpeg)))
    const bigEnough = seen.length > 0 && seen.every((x) => x.imageBytes > 2000)
    if (bigEnough) ok(`图有实在的内容（${seen.map((x) => Math.round(x.imageBytes / 1024) + 'KB').join('、')}）`)
    else bad('图太小了 / 没发（页面没渲染出来？）：' + JSON.stringify(seen.map((x) => x.imageBytes)))
    const coldTemp = seen.length > 0 && seen.every((x) => x.temperature === 0)
    if (coldTemp) ok('temperature=0（整理是"读"不是"创作"）')
    else bad('temperature 不是 0：' + JSON.stringify(seen.map((x) => x.temperature)))

    const d1 = filled.value
    const note = d1.items.find((x) => x.kind === '知识点')
    const formula = d1.items.find((x) => x.kind === '公式')
    if (note && /受力分析/.test(note.title) && /先画受力图/.test(note.body)) ok('文字知识点连标题带正文都填进来了')
    else bad('文字知识点不对：' + JSON.stringify(note))
    if (formula && formula.tex === 'F=ma') ok('公式那条落在**公式**那一栏里（tex 原样）')
    else bad('公式那条不对：' + JSON.stringify(formula))
    if (formula && formula.rendered) ok('公式在窗口里**排出来了**（KaTeX 真渲染，不是一串反斜杠）')
    else bad('公式没排出来（.dkr-texprev 里没有 .katex）')
    /* 小节名显示在"带 unit 的那一页"那一行（unit 空 = 还在上一节里，这是提示词的契约）。
       夹具里只有第 1 页带 unit（"力与运动"），所以这一节读 1、2 时它该出现。 */
    const unitShown = await s.eval(`(() => ({
      units: [...document.querySelectorAll('.dkr-unit')].map(e => e.textContent),
      blocks: [...document.querySelectorAll('.dkr-pgblk')].map(b => ((b.querySelector('.dkr-pgh') || {}).textContent || '').slice(0, 16)),
      picked: [...document.querySelectorAll('.dkr-pg.on')].map(b => b.textContent),
      selected: [...document.querySelectorAll('.dkr-pickrow .dim')].map(e => e.textContent).join(' ｜ '),
    }))()`)
    if (unitShown.units.includes('力与运动')) ok('★ 带 unit 的那一页把小节名显示出来了（' + JSON.stringify(unitShown.units) + '）')
    else bad('小节名没显示：' + JSON.stringify(unitShown))
    /* 这条断言要放在贴完之后才有意义，所以先记下来 */
    if (/会贴到白板上/.test(d1.acts)) ok('右下角报得出这一趟会贴几条：' + d1.acts.replace(/\s+/g, ' ').slice(0, 50))
    else bad('右下角没说会贴几条：' + d1.acts)

    console.log('\n[4] 一页失败只影响那一页（"一页一次调用"挣来的东西）')
    {
      mockDelayMs = 0
      forceFailPage = 1
      seen.length = 0
      /* 用「↻ 重读这一页」重读第 1 页：模型回一句人话（没有 JSON）→ 这一页标红，第 2 页一个字不动 */
      await s.eval(`[...document.querySelectorAll('.dkr-pgblk')].find(b => /第 1 页/.test(b.textContent)).querySelector('.dkr-retry').click()`)
      const retried = await until(async () => {
        const r = await s.eval(DKR)
        const bad1 = [...r.warns].some((w) => /没读出来|没按格式/.test(w))
        return bad1 || r.items.length < 2 ? r : undefined
      }, { timeout: 8000, what: '第 1 页被标出来' })
      const d2 = retried.value || (await s.eval(DKR))
      const blk1 = await s.eval(`(() => {
        const b = [...document.querySelectorAll('.dkr-pgblk')].find(x => /第 1 页/.test(x.textContent))
        return b ? { bad: b.classList.contains('bad'), text: b.textContent.replace(/\\s+/g, ' ').slice(0, 160) } : null
      })()`)
      /* 两条路都算"标出来了"：请求失败（.bad，那一块标红）和"有回话但没按 JSON 回"
         （`.trv-tag` 写着「没按格式回话」）—— 后者正是"模型回了一句人话"的样子。 */
      const tagged = blk1 && /没按格式回话/.test(blk1.text)
      if (blk1 && (blk1.bad || tagged)) ok('第 1 页那一块标出来了（' + (blk1.bad ? '标红' : '「没按格式回话」标签') + '）')
      else bad('第 1 页没被标出来：' + JSON.stringify(blk1))
      const still2 = d2.items.filter((x) => x.kind === '公式' && x.tex === 'F=ma').length
      if (still2 === 1) ok('★ 第 2 页的公式**一个字没动**（失败没有连坐 —— 这正是"一页一次"的意义）')
      else bad('第 2 页的内容受影响了：' + JSON.stringify(d2.items.map((x) => x.tex)))
      if (seen.length === 1 && seen[0].page === 1) ok('只重发了第 1 页（一次请求，别的页没重发）')
      else bad('重读发出去的请求不对：' + JSON.stringify(seen.map((x) => x.page)))
      forceFailPage = 0
      /* 再重读一次 → 这次回正常内容，标红消失（"↻ 重读这一页"这条路是通的） */
      await s.eval(`[...document.querySelectorAll('.dkr-pgblk')].find(b => /第 1 页/.test(b.textContent)).querySelector('.dkr-retry').click()`)
      const healed = await until(async () => {
        const b = await s.eval(`(() => {
          const el = [...document.querySelectorAll('.dkr-pgblk')].find(x => /第 1 页/.test(x.textContent))
          return el ? el.classList.contains('bad') : null
        })()`)
        return b === false ? 1 : undefined
      }, { timeout: 8000, what: '第 1 页重读成功' })
      if (healed.ok) ok('再点一次「↻ 重读这一页」→ 读回来了（标红消失）')
      else bad('重读没救回来（一直红着）')
    }

    console.log('\n[5] 点「贴到白板上」→ 卡片落进文件（这条链路的终点）')
    await s.eval(`[...document.querySelectorAll('.dkr-acts .btn')].find(b => b.textContent.includes('贴到白板上')).click()`)
    const wrote = await untilFile((d) => d.cards && d.cards.length >= 3, { timeout: 10000, what: '卡片落进板文件' })
    if (!wrote.ok) {
      bad('点了「贴到白板上」，文件里的卡片没多出来（等到 ' + wrote.waited + 'ms）')
      const dbg = await s.eval(DKR)
      console.log('  （窗口还开着吗：' + dbg.open + '，条数：' + (dbg.items || []).length + '）')
      return
    }
    const cards = wrote.value.cards
    ok(`卡片落进文件了（一共 ${cards.length} 张）`)
    const notes = cards.filter((c) => c.kind === 'note')
    const forms = cards.filter((c) => c.kind === 'formula')
    if (notes.some((c) => /受力分析/.test(c.text || '') && /先画受力图/.test(c.text || ''))) ok('文字卡里是"标题 + 正文"（中间空一行）')
    else bad('文字卡的内容不对：' + JSON.stringify(notes.map((c) => c.text)))
    if (forms.length === 1 && forms[0].tex === 'F=ma') ok('公式落成了**公式卡**（tex=F=ma）')
    else bad('公式卡不对：' + JSON.stringify(forms.map((c) => [c.tex, c.src])))
    if (notes.some((c) => (c.text || '').includes('力与运动'))) ok('★ 带 unit 的那一页在板上落出了一行小节名（课件的骨架看得见）')
    else bad('小节名没落下来：' + JSON.stringify(notes.map((c) => (c.text || '').slice(0, 12))))
    if (cards.every((c) => c.w > 20 && c.h > 10)) ok('每张卡都有量出来的宽高（不是默认的 260×44）')
    else bad('有卡片的宽高不对：' + JSON.stringify(cards.map((c) => [c.w, c.h])))
    /* 摆版的硬要求：同一栏里不许压住。这里直接验"两两不重叠"（它们是网格摆的）。 */
    const ov = []
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = cards[i]
        const b = cards[j]
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) ov.push([a.id, b.id])
      }
    }
    if (!ov.length) ok('★ 没有一张卡压住另一张（摆版的硬要求）')
    else bad('有卡片互相压住：' + JSON.stringify(ov))
    const minX = Math.min(...cards.map((c) => c.x))
    if (minX >= 720) ok(`★ 卡片摆在**资料右边**（最左 ${minX} ≥ 资料右边缘 720）—— 不盖住你正在看的课件页`)
    else bad('卡片压到资料上了（最左 ' + minX + '）')
    if (!(await s.eval(`!!document.querySelector('.dkr-back')`))) ok('窗口自己关掉了（贴完不需要你再点一次）')
    else bad('贴完窗口还开着')

    console.log('\n[6] 贴上去的卡片在屏幕上真的画出来了（DOM + 内容）')
    /* ★ 断言是**对账**：文件里几张卡，屏幕上就得有几张 ——
       "文件里有、界面上没有"是这条链路最糟的一种错（存了但你看不见），
       而它偏偏不会报任何错。测量用的那张藏卡（.bd-card 挂在屏幕外）如果在，
       这里也会对不上账（多出来一张），所以它顺带钉住了"量完必须收摊"。 */
    const drawn = await until(async () => {
      const r = await s.eval(`(() => {
        const el = document.querySelector('[data-deck-measure]')
        const els = [...document.querySelectorAll('.bd-card')]
        return {
          measureLeft: el ? el.children.length : 0,
          cards: els.map((e) => ({
            kind: e.dataset.cardKind,
            text: (e.querySelector('.bd-note') || {}).textContent || '',
            tex: !!e.querySelector('.bd-tex .katex'),
            w: Math.round(e.getBoundingClientRect().width),
            h: Math.round(e.getBoundingClientRect().height),
            id: e.dataset.cardId,
          })),
        }
      })()`)
      return r && r.cards.length >= 3 ? r : undefined
    }, { timeout: 10000, what: '新卡片上屏' })
    if (!drawn.ok) {
      bad('卡片没上屏（文件里有、界面上没有）')
      const dbg = await s.eval(`(() => ({
        cards: document.querySelectorAll('.bd-card').length,
        measure: !!document.querySelector('[data-deck-measure]'),
        world: document.querySelectorAll('.bd-world .bd-card').length,
        save: (document.querySelector('.bd-save') || {}).textContent || '',
      }))()`)
      console.log('  （现场：' + JSON.stringify(dbg) + '）')
      console.log('  （页面报错：' + (s.errors().length ? s.errors().slice(0, 2).join(' ｜ ') : '无') + '）')
    } else {
      const els = drawn.value.cards
      ok(`屏幕上有 ${els.length} 张卡（文件里 ${cards.length} 张）`)
      if (els.length === cards.length) ok('★ 文件里的卡片和屏幕上的**一一对上**（没有"存了但看不见"的）')
      else bad(`屏幕上的张数（${els.length}）和文件里（${cards.length}）对不上`)
      if (drawn.value.measureLeft === 0) ok('量尺寸那张藏卡收摊了（没留在 DOM 里当第 N 张卡）')
      else bad('屏幕外那张测量用的卡还在 DOM 里：' + drawn.value.measureLeft)
      if (els.some((e) => e.tex)) ok('公式卡在板上也**排出来了**（KaTeX 渲染出了 .katex）')
      else bad('屏幕上的公式卡没渲染出公式')
      if (els.every((e) => e.w > 20 && e.h > 10)) ok(`每张卡都有实在的尺寸（${els.map((e) => e.w + '×' + e.h).join('、')}）`)
      else bad('有卡片尺寸不对：' + JSON.stringify(els.map((e) => [e.w, e.h])))
      if (els.some((e) => e.kind === 'note' && /力与运动/.test(e.text))) ok('小节名那张卡也在屏幕上')
      else bad('小节名那张卡没上屏：' + JSON.stringify(els.filter((e) => e.kind === 'note').map((e) => e.text.slice(0, 14))))
    }

    console.log('\n[7] 再读同一段页（2）：**一页都不发**（缓存命中，不花第二次钱）')
    {
      seen.length = 0
      await s.mouse(btn.x, btn.y)
      await until(async () => ((await s.eval(`!!document.querySelector('.dkr-back')`)) ? 1 : undefined), { timeout: 6000, what: '窗口再开一次' })
      /* ★ 只读 **第 2 页**：它在 [3] 里刚读过（[4] 重读的是第 1 页，没动它）。
         于是这一次**一个请求都不该发**，而且那一页该标着「上次读的」。 */
      await setRange('2')
      await clickRead()
      const done = await until(async () => {
        const r = await s.eval(DKR)
        return r.items.length >= 2 ? r : undefined
      }, { timeout: 8000, what: '第二趟读完' })
      if (done.ok) ok('第二趟照样读出了内容（界面路径没坏）')
      else bad('第二趟没读出内容')
      if (seen.length === 0) ok('★ 一个请求都没发（这一页在缓存里）—— 同一件事不花两次钱')
      else bad('第二趟又发了 ' + seen.length + ' 个请求（缓存没命中）')
      const tag = await s.eval(`document.querySelectorAll('.trv-tag.ok').length`)
      if (tag === 1) ok('那一页标着「上次读的」—— 没花钱这件事界面上看得见')
      else bad('「上次读的」标签数不对：' + tag)
      const closed = await until(async () => {
        await s.eval(`[...document.querySelectorAll('.dkr-acts .mini')].find(b => b.textContent.includes('先不整理')).click()`)
        return (await s.eval(`!document.querySelector('.dkr-back')`)) ? 1 : undefined
      }, { timeout: 4000, what: '窗口关掉' })
      if (closed.ok) ok('「先不整理」把窗口关掉了（一个字都没写）')
      else bad('「先不整理」没关掉窗口')
    }

    console.log('\n[8] 贴完之后笔照常在资料上写（这个功能的用法就是"看着课件写"）')
    {
      const spot = await s.eval(`(() => {
        const pg = document.querySelector('.bd-docpage')
        if (!pg) return null
        const r = pg.getBoundingClientRect()
        return { x: Math.round(r.left + r.width * 0.25), y: Math.round(r.top + r.height * 0.7) }
      })()`)
      if (spot) {
        const before = await s.eval(`Number((document.querySelector('canvas.bd-ink') || { dataset: {} }).dataset.strokes || 0)`)
        await s.penStroke({ x: spot.x, y: spot.y }, { x: spot.x + 90, y: spot.y - 30 })
        const after = await until(async () => {
          const n = await s.eval(`Number((document.querySelector('canvas.bd-ink') || { dataset: {} }).dataset.strokes || 0)`)
          return n > before ? n : undefined
        }, { timeout: 4000, what: '墨迹多了一笔' })
        if (after.ok) ok(`在课件页上写出了一笔（${before} → ${after.value}）—— 新卡片没把它挡住`)
        else bad('写不上去了（新贴的卡片挡住了？）')
      } else bad('找不到资料页来落笔')
    }

    console.log('\n[9] 整个流程跑下来，页面里没有 JS 报错')
    const errs = s.errors()
    if (!errs.length) ok('没有报错')
    else bad(`页面里有 ${errs.length} 条报错：` + errs.slice(0, 3).join(' ｜ '))
  }
)

mock.close()
restoreConfig()
if (!mockUp) console.log('  （假识别服务没起得来 —— 上面的失败多半是它引起的）')
process.exitCode = fails ? 1 : 0



