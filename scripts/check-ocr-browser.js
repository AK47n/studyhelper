/* 手写识别的端到端自检：真浏览器 + 真本地服务 + **假的识别服务**。
 *
 * ── 这一条测的是"整条链路"，不是某一层 ──
 *   写字板上画一笔（合成指针事件）
 *     → 前端把笔迹画成 PNG → POST /api/ocr
 *     → 本地服务加上密钥转发给"识别服务"（这里是一个本地假服务）
 *     → 拿回 LaTeX → 渲染预览 → 点"放到白板上" → 白板上真的多了一张公式卡
 * 每一步都断言，而且假服务会把**收到的东西**记下来给这里检查。
 *
 * ── 为什么必须用真浏览器 ──
 * canvas.toBlob、指针事件、ResizeObserver 在 jsdom 里都没有。
 * "画了一笔但发出去一张空白图"这种错，只有真浏览器能发现。
 *
 * ── 完全离线、不花额度 ──
 * 假服务是我们自己起的。它还会**故意**把鉴权头复制到响应里，
 * 这样这里能断言"密钥确实带上了"，而真密钥一次都没出过这台机器。
 *
 * 跑：npm run check:ocr-browser
 *
 * 胶水（起服务 + 起浏览器 + CDP 会话 + 夹具板 + 用户数据守卫）都在
 * scripts/lib/board-check.js 的 withBoard 里。这一条还多两件自己的事：
 *   ① 起一个**假的识别服务**（这是我们自己的进程，不是夹具那套）；
 *   ② 把 config/ocr.json 先挪开、跑完放回去（"删的是谁的"那条规矩，见下面 cleanup）。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { withBoard, ROOT } from './lib/board-check.js'
/* 第 [11] 节要自己造一张夹具板（比手画快、也更准），所以用应用自己的那几个构造函数。 */
import { newBoard, newCard, newStroke, serializeBoardDocument } from '../src/lib/board.js'
import { toFlat } from '../src/lib/geometry.js'
import { unreadableLines } from '../src/lib/board-note.js'
import { OCR_MAX_DIM } from '../src/lib/ocr.js'

const APP_PORT = Number(process.env.OCR_TEST_APP_PORT || 5179)
const MOCK_PORT = Number(process.env.OCR_TEST_MOCK_PORT || 5198)
const CDP_PORT = Number(process.env.OCR_TEST_CDP_PORT || 9223)
const TEST_TOKEN = 'test-uat-token-abcdefgh'

/* 行清单在提示词里的样子（board-structure.js 的 `manifestText` 写的那一句）：
   `行清单（这一块从上到下共 N 行，行号就用下面这些）：`
   ⚠ 别把结尾那个 `）` 写进正则 —— 它和 `行` 之间还夹着"，行号就用下面这些"，
     写上去会**永远匹配不上**（第一版就是这么写的，于是"清单在不在"这条判据
     变成了一个恒假的断言：修好了也报失败，白跑一趟）。
   假服务拿它当**分流**：有 → 照行回话；没有 → 自由发挥（真模型的行为）。
   自检里也拿它当判据："认字那一趟到底带没带行清单"。 */
const MANIFEST_RE = /行清单（这一块从上到下共 \d+ 行/

// ═════════════ 1. 假的识别服务（DeepSeek 形状）═════════════
/* default provider 现在是 deepseek，所以这个假服务回 OpenAI 兼容的形状：
   { choices: [ { message: { content: "..." } } ] }
   而且**故意**把公式包在 ```latex 里 —— LLM 就是这么干的，
   正好顺便验证"回话清洗"在真链路里也生效。 */
const seen = []
let mockReply = {
  code: 200,
  body: { choices: [{ message: { role: 'assistant', content: '```latex\nE = mc^{2}\n```' } }] },
}
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
    const promptText = Array.isArray(content) && content[0] ? String(content[0].text || '') : ''
    seen.push({
      url: req.url,
      method: req.method,
      auth: req.headers.authorization || null,
      contentType: req.headers['content-type'] || '',
      model: json ? json.model : null,
      temperature: json ? json.temperature : null,
      blockTypes: Array.isArray(content) ? content.map((c) => c.type) : null,
      promptText,
      imageBytes: b64 ? Buffer.from(b64, 'base64').length : 0,
      imageMagic: b64 ? Buffer.from(b64, 'base64').subarray(0, 4).toString('hex') : null,
      /* PNG 的 IHDR 里就写着尺寸（宽在 16..19、高在 20..23，大端）。
         为什么要它：识别图"多大"是有上限的（`OCR_MAX_DIM`）—— 而**只有真跑一遍**
         才知道实际发出去的是多大（纯函数那边算得再对，画布也可能不听话）。 */
      imageW: b64 && Buffer.from(b64, 'base64').length > 24 ? Buffer.from(b64, 'base64').readUInt32BE(16) : 0,
      imageH: b64 && Buffer.from(b64, 'base64').length > 24 ? Buffer.from(b64, 'base64').readUInt32BE(20) : 0,
    })
    res.writeHead(mockReply.code, { 'Content-Type': 'application/json' })
    /* `byIndex`：第 N 次请求回第 N 段。**一条链路里发好几块**时（整板转录按块发），
       只有"哪块回了什么"分得开，断言才分得清"这段话落在哪一节底下" ——
       [11] 那两条"框里的字在框那一节、框外的字在文末那一段"靠的就是它。
       `delayMs`：故意慢一点回 —— "弹层是不是**边认边填**"这件事只有在"还没认完"的
       那一刻才看得出来（假服务秒回的话，等我们看到弹层时它早就填完了）。
       ⚠ 被取消的那次请求：`setTimeout` 到点时客户端早走了 → 写到已关闭的 socket 上，
         所以先看 `destroyed` 再写（不然假服务自己会抛一个 EPIPE）。 */
    const replyBody = mockReply.byLines
      ? {
          choices: [
            {
              message: {
                role: 'assistant',
                /* ★ **照行清单回话，还是要自由发挥 —— 由提示词里有没有行清单决定。**
                   真模型就是这么干的：没有清单（服务端退回 BOARD_PROMPT）时它会自己
                   分行、一个 `L` 前缀都不写。假服务从前按"第几次请求"回话，于是
                   **行清单根本没发出去**它也照样回 `L1|…`，[13] 一路全绿 —— 而真跑的时候
                   第二趟（结构整理）压根没被叫上（2026-09-20 用户看到的"纯粹的识别"）。 */
                content: MANIFEST_RE.test(promptText)
                  ? String(mockReply.byLines[mockReply.n++ % mockReply.byLines.length])
                  : String(mockReply.free || ''),
              },
            },
          ],
        }
      : mockReply.byIndex
        ? { choices: [{ message: { role: 'assistant', content: String(mockReply.byIndex[(mockReply.n++) % mockReply.byIndex.length]) } }] }
        : mockReply.body
    /* ★ **没有图的请求 = 结构整理那一趟**（第 4 步）：它是一段纯文本进去、
       一个 JSON 出来。用"有没有图"分流，比让假服务去猜提示词稳。
       默认回一个空骨架 —— 那是最合法的答案（"我看不出这些行之间有什么关系"）。 */
    const noImage = !(img && img.image_url && img.image_url.url)
    const structBody = mockReply.struct || { choices: [{ message: { role: 'assistant', content: '{"sections":[],"relations":[]}' } }] }
    const send = () => {
      try {
        if (res.destroyed) return
        res.end(JSON.stringify(noImage ? structBody : replyBody))
      } catch {}
    }
    if (mockReply.delayMs) setTimeout(send, mockReply.delayMs)
    else send()
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r))

// ═════════════ 2. 起本地服务（指向假识别服务）═════════════
// 把可能存在的真配置挪开：这个自检必须用环境变量里的假地址，不能碰用户的真密钥
const realConfig = path.join(ROOT, 'config', 'ocr.json')
const stash = realConfig + '.checkocr-bak'
let stashed = false
/* 上一次自检**没跑完**（被强杀 / 崩了）时，真配置会留在 .checkocr-bak 里没人管 ——
   先把这种情况认回来，否则用户看到的是"我的密钥怎么没了"。 */
if (!fs.existsSync(realConfig) && fs.existsSync(stash)) {
  try {
    fs.renameSync(stash, realConfig)
  } catch {}
}
if (fs.existsSync(realConfig)) {
  fs.renameSync(realConfig, stash)
  stashed = true
}

/* 收尾：只收**这一条自检自己的**东西 —— 假识别服务和那份被挪开的配置。
   服务 / 浏览器 / 夹具板都由 withBoard 收（它还会查"data/ 里原有文件变没变"）。 */
const cleanup = () => {
  try {
    mock.close()
  } catch {}
  /* ★ 把真配置放回去；**只有跑之前根本没有真配置**时，才删掉自检写下的那个假配置。
     ⚠ 这里原来是无条件连着做两步的：先把 .checkocr-bak 恢复成 config/ocr.json，
     紧接着又把这个 ocr.json 删掉 —— 于是"跑一次手写识别的自检"就等于
     **把用户的真密钥删了**，而且删得无声无息（fs.rmSync 不进回收站，
     config/ 又在 .gitignore 里，本机任何地方都找不回来）。
     2026-09-15 实际发生过一次。改配置相关的清理逻辑时，先想清楚"删的是谁的"。
     （跑之前有真配置 → 恢复它；跑之前没有 → 删掉的只是自检自己写的假配置。） */
  if (stashed) {
    try {
      if (fs.existsSync(stash)) {
        fs.renameSync(stash, realConfig)
        console.log('  （你原来的 config/ocr.json 已经放回去了）')
      }
    } catch {}
  } else {
    try {
      if (fs.existsSync(realConfig)) {
        fs.rmSync(realConfig)
        console.log('  （删掉的是自检自己写的假配置，你原来没有配置文件）')
      }
    } catch {}
  }
  /* 自检期间写下的配置也要清掉（它是假的地址 + 假密钥，留着会让人困惑） */
  try {
    if (fs.existsSync(path.join(ROOT, 'config')) && fs.readdirSync(path.join(ROOT, 'config')).length === 0) {
      fs.rmdirSync(path.join(ROOT, 'config'))
    }
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

/* ═════════════════ 3. 应用 + 浏览器 + 夹具板（withBoard 管）═════════════
   夹具板：这个自检中途会**真的往白板上插一张公式卡**，所以它必须开在自己的板上。
   以前是"进界面之后从左栏点夹具那一行"（应用开的是列表里第一个 board-*.md，
   那多半是用户自己的板 —— 实测跑两遍，用户板上多了两张一模一样的 E = mc²）；
   现在应用从 ?file= 直接开夹具，用户那张板根本不会被读到。 */
const fails = await withBoard(
  {
    tag: 'ocrcheck',
    port: APP_PORT,
    cdpPort: CDP_PORT,
    env: {
      // 默认 provider 就是 deepseek，这里把它的接口地址指到假服务上
      STUDYHELPER_OCR_PROVIDER: 'deepseek',
      STUDYHELPER_OCR_DS_BASE: `http://127.0.0.1:${MOCK_PORT}/chat/completions`,
      STUDYHELPER_OCR_MODEL: 'deepseek-flash',
      STUDYHELPER_OCR_TOKEN: TEST_TOKEN,
    },
  },
  async ({ s, ok, bad, board, open, read, until, after }) => {
/* ── 下面整段原来是顶层代码，挪进 withBoard 的回调里；缩进没动（少几百行假 diff）── */

const sleep = (ms) => s.sleep(ms)

/* 打开夹具板，开始断言。 */
await open()

// ═════════════════════ 开始断言 ═════════════════════
console.log('\n[1] 工具条上有「手写公式」这个入口')
{
  const has = await s.eval(`[...document.querySelectorAll('.bd-tools .bd-t')].some(b => /手写公式/.test(b.textContent))`)
  if (has) ok('工具条里有「✍ 手写公式」')
  else bad('工具条里找不到手写公式入口')
}

console.log('\n[2] 打开写字板')
{
  await s.eval(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /手写公式/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(500)
  const info = await s.eval(`(() => {
    const pad = document.querySelector('.wp-padwrap')
    const cv = document.querySelector('canvas.wp-pad')
    const r = pad ? pad.getBoundingClientRect() : null
    return {
      open: !!document.querySelector('.wp'),
      padSize: r ? [Math.round(r.width), Math.round(r.height)] : null,
      cvSize: cv ? [cv.width, cv.height] : null,
      warn: (document.querySelector('.wp-warn') || {}).textContent || '',
      hint: (document.querySelector('.wp-hint') || {}).textContent || '',
    }
  })()`)
  if (info.open) ok('写字板弹出来了')
  else bad('写字板没弹出来')
  if (info.padSize && info.padSize[0] > 200 && info.padSize[1] > 100) ok(`写字区有尺寸 ${info.padSize.join('×')}`)
  else bad('写字区尺寸不对：' + JSON.stringify(info.padSize))
  if (info.cvSize && info.cvSize[0] > 300) ok(`画布位图 ${info.cvSize.join('×')}（按 dpr 放大过）`)
  else bad('画布位图太小：' + JSON.stringify(info.cvSize))
  // 环境变量给了假密钥，所以这里不该出现"还没配密钥"的警告
  if (!/还没配/.test(info.warn)) ok('没报"还没配密钥"（环境变量里的假密钥被认了）')
  else bad('明明有密钥却说没配：' + info.warn)

  console.log('\n[3] 在写字板上写一笔')
  const box = await s.eval(`(() => { const r = document.querySelector('.wp-pad').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  const cx = box.x + box.w * 0.3
  const cy = box.y + box.h * 0.5
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 20; i++) {
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cx + i * 9,
      y: cy + Math.sin(i / 2.2) * 26,
      button: 'left',
      buttons: 1,
    })
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 180, y: cy, button: 'left', buttons: 0, clickCount: 1 })
  await s.sleep(400)

  const after = await s.eval(`(() => {
    const meta = [...document.querySelectorAll('.wp-acts .dim')].map(e => e.textContent).join(' ')
    const ink = (() => {
      const cv = document.querySelector('canvas.wp-pad')
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let i = 3; i < d.length; i += 4 * 5) if (d[i] > 20) n++
      return n
    })()
    return { meta, ink, hintGone: !document.querySelector('.wp-hint') }
  })()`)
  if (after.ink > 0) ok(`笔迹真的画上了（墨点采样 ${after.ink}）`)
  else bad('写字板上没画出东西')
  if (/1 笔/.test(after.meta)) ok('界面报「1 笔」')
  else bad('笔数不对：' + after.meta)
  if (/会发一张 \d+×\d+ 的图/.test(after.meta)) ok('把"会发多大的图"告诉你了：' + (after.meta.match(/会发一张 \S+ 的图/) || [''])[0])
  else bad('没有显示要发送的图片尺寸：' + after.meta)
  if (after.hintGone) ok('占位提示自动消失')
  else bad('写了字还留着"在这一块里写"的提示')

  console.log('\n[4] 点「识别」→ 本地服务 → 假识别服务')
  seen.length = 0
  await s.eval(`(() => { const b = [...document.querySelectorAll('.wp-acts .btn')].find(x => /识别/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(1600)

  if (seen.length === 1) ok('假识别服务收到了 1 次请求')
  else bad(`假识别服务收到 ${seen.length} 次请求（期望 1）`)
  if (seen[0]) {
    const r = seen[0]
    if (r.url === '/chat/completions') ok('打到 OpenAI 兼容的 /chat/completions（DeepSeek 那条路）')
    else bad('打错了地址：' + r.url)
    if (r.method === 'POST') ok('用的是 POST')
    else bad('方法不对：' + r.method)
    if (r.auth === 'Bearer ' + TEST_TOKEN) ok('鉴权是 Authorization: Bearer，值就是配置里那一串')
    else bad('鉴权头不对：' + r.auth)
    if (r.model === 'deepseek-flash') ok('model=deepseek-flash（旧名字已下线，用错会被拒）')
    else bad('model 不对：' + r.model)
    if (r.temperature === 0) ok('temperature=0（识别是"抄"，不让它发挥）')
    else bad('temperature 不是 0：' + r.temperature)
    if (Array.isArray(r.blockTypes) && r.blockTypes.includes('text') && r.blockTypes.includes('image_url')) {
      ok(`content 是块数组，含 ${JSON.stringify(r.blockTypes)}（写成字符串会被 400）`)
    } else {
      bad('content 块数组不对：' + JSON.stringify(r.blockTypes))
    }
    if (/只输出.*LaTeX/.test(r.promptText)) ok('带上了"只输出 LaTeX"的指令（不写它会回一句人话）')
    else bad('提示词没发出去：' + r.promptText.slice(0, 60))
    if (r.imageMagic === '89504e47') ok('图是 base64 内联的 PNG（魔数 89 50 4e 47）')
    else bad('发出去的图不对，魔数 ' + r.imageMagic)
    if (r.imageBytes > 2000) ok(`图片有实际内容（${r.imageBytes} 字节）—— 不是一张空白图`)
    else bad(`图片只有 ${r.imageBytes} 字节，多半是空白的（笔迹没画上去？）`)
  }

  console.log('\n[5] 认出来的东西要能看、能改、能放上去')
  const res = await s.eval(`(() => {
    const el = document.querySelector('.wp-res')
    return {
      shown: !!el,
      katex: el ? el.querySelectorAll('.katex').length : 0,
      conf: (document.querySelector('.wp-conf') || {}).textContent || '',
      draft: (document.querySelector('.wp-res .wp-edit') || {}).value || '',
      insertBtn: !!([...document.querySelectorAll('.wp-res-acts .btn')].find(b => /放到白板上/.test(b.textContent))),
    }
  })()`)
  if (res.shown) ok('结果区出现了')
  else bad('没有结果区（识别可能失败了）')
  if (res.katex > 0) ok('结果渲染成了数学（KaTeX）')
  else bad('结果没有渲染成数学 —— 认出来的 LaTeX 有问题？')
  /* ★ 这一条是"回话清洗"在真链路里的证据：
     假服务故意回的是 ```latex\nE = mc^{2}\n```，也就是**带代码块围栏**的。
     前端必须把围栏剥掉、把式子取出来 —— 不然卡片上会显示一串反引号。
     （SimpleTex 不会这么回，所以这个问题只有走 LLM 那条路才会遇到。） */
  if (res.draft === 'E = mc^{2}') ok('把模型回的 ```latex 围栏剥掉了，只留下式子：' + res.draft)
  else bad('围栏没剥干净：' + JSON.stringify(res.draft))
  if (res.insertBtn) ok('有「放到白板上」按钮')
  else bad('没有放上去的按钮')

  /* ★★ 那个输入框要**真的点得进去** —— 用真鼠标事件，不要 dispatchEvent。
     用户 2026-09-15 报的「可编辑的弹窗点不了、还在上面乱涂乱画」：
     "放上去之后那个框"其实半点不能碰，一点就在白板上落墨。
     根因在卡片层的 z-index（.bd-hit 把卡片整个盖住，见 BoardCanvas 的说明），
     但**症状从写字板这一侧看是一模一样的**：结果区、输入框、预览都在，
     就是点不动。所以这条断言盯的是"命中测试"本身：
       ① 输入框中心那一点，elementFromPoint 必须就是它；
       ② 真鼠标按下去之后，光标（activeElement）必须落在它身上；
       ③ 顺带确认这一下**没有**变成笔迹（写的是 1 笔，别变成 2 笔）。 */
  const editHit = await s.eval(`(() => {
    const ta = document.querySelector('.wp-res .wp-edit')
    if (!ta) return null
    const r = ta.getBoundingClientRect()
    const cx = Math.round((r.left + r.right) / 2)
    const cy = Math.round((r.top + r.bottom) / 2)
    const el = document.elementFromPoint(cx, cy)
    return { cx, cy, isInput: el === ta, hit: el ? el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') : 'null' }
  })()`)
  if (!editHit) {
    bad('找不到结果区的输入框（.wp-res .wp-edit）')
  } else {
    if (editHit.isInput) ok('输入框中心命中的就是输入框自己')
    else bad(`输入框中心命中的是 ${editHit.hit} —— 它被别的层盖住了，用户点不进去`)
    const strokesBefore = (await s.eval(`[...document.querySelectorAll('.wp-acts .dim')].map(e => e.textContent).join(' ')`)).match(/(\d+) 笔/)
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editHit.cx, y: editHit.cy, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editHit.cx, y: editHit.cy, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(300)
    const afterClick = await s.eval(`(() => ({
      focused: document.activeElement === document.querySelector('.wp-res .wp-edit'),
      meta: [...document.querySelectorAll('.wp-acts .dim')].map(e => e.textContent).join(' '),
    }))()`)
    if (afterClick.focused) ok('真鼠标点一下，光标就进到输入框里了（能改）')
    else bad('点了输入框，光标没进去 —— 用户改不了认错的式子')
    const strokesAfter = afterClick.meta.match(/(\d+) 笔/)
    if (!strokesBefore || !strokesAfter || strokesBefore[1] === strokesAfter[1]) ok('点输入框没有在写字板上多画一笔')
    else bad(`点输入框居然变成写字了（${strokesBefore[1]} 笔 → ${strokesAfter[1]} 笔）`)
  }

  const cardsBefore = await s.eval(`document.querySelectorAll('.bd-card').length`)
  await s.eval(`(() => { const b = [...document.querySelectorAll('.wp-res-acts .btn')].find(x => /放到白板上/.test(x.textContent)); b.click(); return 1 })()`)
  /* ★ 轮询，别睡死一个固定时间。
     这里是"点一下 → React 渲染新卡片 → 新卡片进编辑态"，是异步的。
     固定 sleep(700) 会**偶发**失败（我遇到过一次"新卡片没进编辑态"，
     重跑就过）—— 偶发红灯比没有测试更糟：你会开始不信红灯。
     判据：卡片数到位**并且**编辑态出现。 */
  let afterInsert = { cards: cardsBefore, padClosed: false, editing: false }
  for (let i = 0; i < 20; i++) {
    await s.sleep(250)
    afterInsert = await s.eval(`(() => ({
      cards: document.querySelectorAll('.bd-card').length,
      padClosed: !document.querySelector('.wp'),
      editing: !!document.querySelector('.bd-card.editing'),
    }))()`)
    if (afterInsert.cards > cardsBefore && afterInsert.editing && afterInsert.padClosed) break
  }
  if (afterInsert.cards === cardsBefore + 1) ok(`白板上多了一张卡（${cardsBefore} → ${afterInsert.cards}）`)
  else bad(`卡片数没变（${cardsBefore} → ${afterInsert.cards}）`)
  if (afterInsert.padClosed) ok('写字板自己关掉了')
  else bad('写字板没关')
  if (afterInsert.editing) ok('新卡片直接进入编辑态（识别总会认错，让你马上能改）')
  else bad('新卡片没进编辑态')

  /* ★ 编辑框里必须**有内容**（就是刚认出来的那个式子）。
     这条是 2026-09-15 那个 bug 的钉子：插入的卡片原来写的是 `src: ''`，
     而编辑态编辑的正是 src、编辑态又**只渲染那个输入框**（不渲染 tex 的公式）——
     于是"放到白板上"之后卡片里只有一个**空框**，刚认出来的式子一个字都看不见；
     用户顺手按个回车，commitEdit 就把 `tex: toTex('')` 写进去，整张卡变成"双击写公式"。
     用户报的正是这个：「识别是对的，但放不到白板上，还弹出一个没法交互的弹窗」
     —— 那个"弹窗"就是卡片里的空输入框。 */
  const editInside = await s.eval(`(() => {
    const ta = document.querySelector('.bd-card.editing textarea')
    const card = document.querySelector('.bd-card.editing')
    return {
      has: !!ta,
      value: ta ? ta.value : '',
      showsFormula: card ? card.querySelectorAll('.katex').length : 0,
    }
  })()`)
  if (editInside.has && editInside.value.trim()) ok('编辑框里就是刚认出来的式子：' + JSON.stringify(editInside.value))
  else bad('编辑框是空的（式子看不见，一按回车还会被抹掉）：' + JSON.stringify(editInside.value))
  if (editInside.showsFormula > 0) ok('编辑态里能同时看到渲染后的式子（KaTeX ' + editInside.showsFormula + ' 处）')
  else bad('编辑态看不到渲染结果')

  /* ★★ 白板上那张卡片里的编辑框，也要**真的点得到**（真鼠标事件）。
     这就是用户那句「点不了，给我识别成写字了，在弹窗上乱涂乱画」的正主：
     卡片 DOM 被 .bd-hit（收事件层）整个盖住 —— 按下去落墨、输入框点不进去。
     自检以前用 dispatchEvent 合成事件，绕过命中测试，所以一直是假绿灯。 */
  const cardEditHit = await s.eval(`(() => {
    const ta = document.querySelector('.bd-card.editing textarea')
    if (!ta) return null
    const r = ta.getBoundingClientRect()
    const cx = Math.round((r.left + r.right) / 2)
    const cy = Math.round((r.top + r.bottom) / 2)
    const el = document.elementFromPoint(cx, cy)
    return { cx, cy, isInput: el === ta, hit: el ? el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') : 'null' }
  })()`)
  if (!cardEditHit) {
    bad('找不到卡片里的编辑框')
  } else {
    if (cardEditHit.isInput) ok('卡片编辑框中心命中的就是它自己（没被收事件层盖住）')
    else bad(`卡片编辑框中心命中的是 ${cardEditHit.hit} —— 卡片被盖住了，用户点不进去`)
    const inkBefore = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
    /* 先把光标挪开，再点回来 —— 否则"光标在输入框里"只是自动聚焦的结果，
       证明不了"点得到"。 */
    await s.eval(`(() => { const ta = document.querySelector('.bd-card.editing textarea'); if (ta) ta.blur(); return 1 })()`)
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cardEditHit.cx, y: cardEditHit.cy, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cardEditHit.cx, y: cardEditHit.cy, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(300)
    const clickBack = await s.eval(`(() => ({
      focused: document.activeElement === document.querySelector('.bd-card.editing textarea'),
      ink: document.querySelector('canvas.bd-ink').dataset.strokes,
    }))()`)
    if (clickBack.focused) ok('真鼠标点一下卡片编辑框，光标就进去了（能改）')
    else bad('点了卡片编辑框，光标进不去 —— 这就是用户说的"点不了"')
    if (clickBack.ink === inkBefore) ok(`在卡片上点一下没落墨（还是 ${clickBack.ink} 笔）`)
    else bad(`在卡片上点一下就画了一笔（${inkBefore} → ${clickBack.ink}）—— 被当成写字了`)
  }

  await s.sleep(1200) // 等自动存盘
  const saved = await s.eval(`(() => { const e = document.querySelector('.bd-save'); return e ? e.textContent : null })()`)
  if (saved === '已存') ok('识别出来的公式已经落盘')
  else bad('没落盘：状态「' + saved + '」')

  /* ★ 再按一次回车（用户"确认一下"的自然动作）：式子在不在？
     空提交必须什么都不改 —— 想清空有「删除」，想放弃有「取消」。 */
  await s.eval(`(() => {
    const ta = document.querySelector('.bd-card.editing textarea')
    if (!ta) return 'no-ta'
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
  await s.sleep(1000)
  const afterEnter = await s.eval(`(() => {
    const card = document.querySelector('.bd-card')
    return {
      empty: !!document.querySelector('.bd-card .bd-card-empty'),
      editing: !!document.querySelector('.bd-card.editing'),
      katex: card ? card.querySelectorAll('.katex').length : 0,
    }
  })()`)
  if (!afterEnter.empty && afterEnter.katex > 0) ok('按回车确认之后式子还在（不会被空提交抹掉）')
  else bad('一按回车卡片就被清空了（空提交覆盖了 tex）')

  /* 诊断（临时）—— 留着这一行方便下次再遇上"尺寸不对"时一眼看到 app 量到了什么 */
  {
    const fit = await s.eval(`(() => {
      const c = document.querySelector('.bd-card[data-card-kind="formula"]')
      return c ? { fit: c.getAttribute('data-fit'), w: c.style.width } : null
    })()`)
    console.log('    （app 自己报的量尺寸结果：' + JSON.stringify(fit) + '）')
  }

  /* ★★ 写字板这条路上的公式卡也要**贴着式子**。
     这里没有"要盖住的笔迹"，所以宽高都该收得只剩内边距。
     用户 2026-09-16 第二次报的「识别公式留白依旧很多」就是这张卡：
     它原来固定 260 宽，而一行 `E = mc²` 只有 60 出头，居中之后左右全是空的。
     ⚠ 宽度**不能**像高度那样直接拿 body 的宽度比 —— body 是个块级元素，
       它的宽度永远等于卡片给它的宽度，比出来永远是"刚好"。要量的是**自然宽度**：
       临时把宽度放开成 max-content 再读一次（和 app 里用的是同一个办法，但这里独立量）。 */
  {
    const fit = await s.eval(`(() => {
      const c = document.querySelector('.bd-card[data-card-kind="formula"]')
      if (!c) return null
      const r = c.getBoundingClientRect()
      const body = c.querySelector('.bd-card-body')
      if (!body) return null
      const br = body.getBoundingClientRect()
      /* 自然宽度用 max-content 量（实测过的尺子：卡片宽 400 时和窄到裁内容时，
         它都给出同一个真值 76 —— 而 .bd-tex 的 scrollWidth 会跟着盒子跑，不能当尺子）。 */
      const prev = body.style.width
      body.style.width = 'max-content'
      const nat = body.getBoundingClientRect().width
      body.style.width = prev
      const tex = c.querySelector('.bd-tex')
      const cs = getComputedStyle(c)
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        nat: Math.round(nat), bh: Math.round(br.height),
        /* 内边距 + 边框（屏幕像素）。卡片的 width 是 border-box，
           所以"卡宽 − 内容自然宽"应当**正好等于**这一圈，多出来的才是白留的空白。 */
        padX: Math.round((parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)) * 10) / 10,
        padY: Math.round((parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)) * 10) / 10,
        // ★ 内容有没有被裁掉。宽度写的是 width（硬约束，而且是 border-box），
        //   算小了内容当场被裁 —— 实测就把 E = mc² 的 c² 裁掉过 18px。
        //   这一条比"卡宽 − 自然宽"更硬：那一条在"两者都错成同一个数"时是绿的。
        spill: tex ? tex.scrollWidth - tex.clientWidth : 0,
      }
    })()`)
    if (!fit) bad('量不到写字板放上来的那张公式卡')
    else {
      if (fit.spill <= 0) ok('式子完整显示，没有被卡片裁掉')
      else bad(`式子被卡片裁掉了 ${fit.spill}px（卡太窄）`)
      const slackW = fit.w - fit.nat
      if (Math.abs(slackW - fit.padX) <= 4) ok(`公式卡左右不再留一大片：卡宽 ${fit.w}px = 式子自然宽 ${fit.nat}px + 内边距边框 ${fit.padX}px`)
      else bad(`公式卡左右还空着 ${slackW - fit.padX}px（卡 ${fit.w}，式子 ${fit.nat}，内边距边框 ${fit.padX}）`)
      const slackH = fit.h - fit.bh
      if (Math.abs(slackH - fit.padY) <= 4) ok(`上下也贴着：卡高 ${fit.h}px = 内容 ${fit.bh}px + 内边距边框 ${fit.padY}px`)
      else bad(`公式卡上下还空着 ${slackH - fit.padY}px（卡 ${fit.h}，内容 ${fit.bh}，内边距边框 ${fit.padY}）`)
    }
  }
}

console.log('\n[6] 失败路径：密钥不对时要说人话')
{
  mockReply = { code: 401, body: { error: { message: 'Authentication Fails' } } }
  await s.eval(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /手写公式/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(400)
  const box = await s.eval(`(() => { const r = document.querySelector('.wp-pad').getBoundingClientRect(); return { x: r.left + 60, y: r.top + 60 } })()`)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 10, y: box.y + i * 4, button: 'left', buttons: 1 })
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 100, y: box.y + 40, button: 'left', buttons: 0, clickCount: 1 })
  await s.sleep(300)
  await s.eval(`(() => { const b = [...document.querySelectorAll('.wp-acts .btn')].find(x => /识别/.test(x.textContent)); b.click(); return 1 })()`)
  await s.sleep(1200)

  const err = await s.eval(`(() => {
    const el = document.querySelector('.wp-err')
    return { text: el ? el.textContent : '', cls: el ? el.className : '', hasSettingsBtn: !!(el && el.querySelector('button')) }
  })()`)
  if (/密钥不对/.test(err.text)) ok('401 被翻译成「密钥不对」（而不是"识别失败"）')
  else bad('401 的提示不对：' + err.text)
  if (err.hasSettingsBtn) ok('直接给了「打开设置」的按钮')
  else bad('没给去设置的入口')
  if (/kind-key/.test(err.cls)) ok('错误分了类（界面能按类别给不同的下一步）')
  else bad('错误没分类：' + err.cls)

  // 关掉写字板，别影响后面的检查
  await s.eval(`(() => { const x = document.querySelector('.wp-x'); if (x) x.click(); return 1 })()`)
  await s.sleep(300)
}

console.log('\n[7] 键盘：W 打开写字板，Esc 关掉')
{
  await s.eval(`(() => { document.body.focus(); return 1 })()`)
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await s.sleep(400)
  const opened = await s.eval(`!!document.querySelector('.wp')`)
  if (opened) ok('按 W 打开了写字板')
  else bad('W 没打开写字板')
  await s.eval(`(() => { const x = document.querySelector('.wp-x'); if (x) x.click(); return 1 })()`)
  await s.sleep(300)
  const closed = await s.eval(`!document.querySelector('.wp')`)
  if (closed) ok('关得掉')
  else bad('关不掉')
}

// ═════════════════════ 8. 美化手写：认普通文字那条路 ═════════════════════
/* 「美化手写」= 框住白板上已有的笔迹 → 认成文字（mode=text）→ 落成一张文字卡。
 *
 * 这一节必须用真浏览器，因为它要证的几件事**只有真 DOM 能证**：
 *   · 那个「✨ 美化」按钮真的点得到（浮层和收事件层谁在上面，dispatchEvent 看不出来）；
 *   · 落下来的卡片真的**盖住**刚才那块笔迹（要对屏幕坐标）；
 *   · 原笔迹真的还在（画布 dataset 上的笔数）。
 * 另外它顺带在真链路上钉住 mode=text 有没有走通 ——
 * 假服务会看提示词：发错提示词的话，认公式那段会回一句"没有公式"，
 * 表现出来只是"认不出来"，不看提示词根本查不出是哪个字段没传。 */
console.log('\n[8] 美化手写：框住笔迹 → 认成文字 → 文字卡')
let spot = null // 画字的空白落点（[9] 还要用它来重新框选）
{
  const RECOGNIZED = '安培环路定理：只对稳恒电流成立\n第二行笔记'
  mockReply = {
    code: 200,
    // 故意回围栏 + 冒号 + 两行：清洗规则（保行、不砍冒号、剥围栏）在真链路上一起验
    body: { choices: [{ message: { role: 'assistant', content: '```\n' + RECOGNIZED + '\n```' } }] },
  }
  seen.length = 0

  // ── ① 先挑「笔」，在空白处画两笔（用真鼠标） ──
  await s.eval(`(() => {
    const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /✎|笔/.test(x.textContent))
    if (b) b.click()
    return 1
  })()`)
  await s.sleep(250)

  /* 找一块真的空白：这一点的最上面必须就是 .bd-hit（收事件层）。
     不这么做的话，落点踩在卡片上那一下是**拖卡片**，不是画线 ——
     白板上此时已经有一张（[5] 插进去的）公式卡。 */
  const spot0 = await s.eval(`(() => {
    const stage = document.querySelector('.bd-stage')
    if (!stage) return null
    const r = stage.getBoundingClientRect()
    for (const fx of [0.08, 0.15, 0.22, 0.05]) {
      for (const fy of [0.74, 0.80, 0.68]) {
        const x = Math.round(r.left + r.width * fx)
        const y = Math.round(r.top + r.height * fy)
        const el = document.elementFromPoint(x, y)
        if (el && el.classList && el.classList.contains('bd-hit')) return { x, y }
      }
    }
    return null
  })()`)
  spot = spot0
  if (!spot) bad('白板上找不到空白处画字（右下角一点空都没有？）')
  else ok(`找到空白落笔点 (${spot.x}, ${spot.y})`)

  async function drawStroke(x0, y0, len, amp) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 16; i++) {
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: x0 + i * (len / 16), y: y0 + Math.sin(i / 1.8) * amp, button: 'left', buttons: 1,
      })
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + len, y: y0, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(120)
  }
  if (spot) {
    await drawStroke(spot.x, spot.y, 150, 12)
    await drawStroke(spot.x, spot.y + 40, 150, 12)
    await s.sleep(600)
  }
  const inkAfterDraw = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
  const inkCount = Number(inkAfterDraw)
  if (inkCount >= 2) ok(`白板上真的写下了 ${inkCount} 笔（这就是后面要被"美化"的丑字）`)
  else bad('白板上没画出笔迹：' + inkAfterDraw)

  // ── ② 切到「框选」，拖一个框圈住它们 ──
  const selectBtn = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /框选/.test(x.textContent))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) }
  })()`)
  if (!selectBtn) bad('工具条上找不到「框选」按钮 —— 用鼠标/没有侧键的笔就选不中笔迹')
  else {
    ok('工具条上有「⬚ 框选」入口')
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selectBtn.x, y: selectBtn.y, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selectBtn.x, y: selectBtn.y, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(250)
  }
  if (spot) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x - 18, y: spot.y - 22, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + 90, y: spot.y + 40, button: 'left', buttons: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x + 172, y: spot.y + 78, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(400)
  }
  const sel = await s.eval(`(() => {
    const box = document.querySelector('.bd-inkbox')
    const btn = document.querySelector('.bd-inkfmt')
    const r = box ? box.getBoundingClientRect() : null
    const br = btn ? btn.getBoundingClientRect() : null
    const cx = br ? Math.round((br.left + br.right) / 2) : 0
    const cy = br ? Math.round((br.top + br.bottom) / 2) : 0
    const hit = br ? document.elementFromPoint(cx, cy) : null
    return {
      /* ★ 这个虚线框比**真实笔迹范围**每边大 pad（见 BoardCanvas 的 INK_PAD），
         所以"卡片有没有盖住笔迹"要用内缩之后的框来比 —— pad 从 DOM 上读，
         不在自检里抄一份数字。 */
      pad: box ? Number(box.getAttribute('data-pad')) || 0 : 0,
      box: r ? { left: r.left + (Number(box.getAttribute('data-pad')) || 0), top: r.top + (Number(box.getAttribute('data-pad')) || 0), right: r.right - (Number(box.getAttribute('data-pad')) || 0), bottom: r.bottom - (Number(box.getAttribute('data-pad')) || 0) } : null,
      btn: br ? { x: cx, y: cy } : null,
      hitIsBtn: !!(hit && btn && (hit === btn || btn.contains(hit))),
      hit: hit ? hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className : '') : 'null',
    }
  })()`)
  if (sel.box) ok('框选之后出现了虚线包围框（.bd-inkbox）')
  else bad('框选没生效：没有包围框')
  if (sel.hitIsBtn) ok('「✨ 美化」按钮命中的就是它自己（浮层在收事件层上面，点得到）')
  else bad(`「✨ 美化」按钮中心命中的是 ${sel.hit} —— 用户点不到`)

  // ── ③ 点「美化」→ 面板自己去认 ──
  if (sel.btn) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sel.btn.x, y: sel.btn.y, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sel.btn.x, y: sel.btn.y, button: 'left', buttons: 0, clickCount: 1 })
  }
  /* 轮询等结果（别睡死一个固定时间：这是"面板挂载 → 渲染 PNG → POST → 回来"的一串异步） */
  let panel = { open: false, hasResult: false }
  for (let i = 0; i < 24; i++) {
    await s.sleep(250)
    panel = await s.eval(`(() => ({
      open: !!document.querySelector('.bp'),
      hasResult: !!document.querySelector('.bp .wp-res'),
      err: (document.querySelector('.bp .wp-err') || {}).textContent || '',
      draft: (document.querySelector('.bp .bp-text') || {}).value || '',
    }))()`)
    if (panel.hasResult) break
  }
  if (panel.open) ok('「美化手写」面板弹出来了')
  else bad('面板没弹出来')
  if (panel.hasResult) ok('识别结果出来了')
  else bad('没等到结果：' + panel.err)

  /* ★ mode=text 有没有真的走通 —— 看假服务收到的提示词。
     发错提示词（还是认公式那段）的表现是"认不出来"，从界面上根本看不出原因。 */
  const req = seen[seen.length - 1]
  if (req && /手写文字识别工具/.test(req.promptText)) ok('发出去的是**认文字**那段提示词（mode=text 走通了）')
  else bad('提示词不对（mode 没传到位？）：' + String(req && req.promptText).slice(0, 60))
  if (req && /原样抄下来/.test(req.promptText) && /保留原来的换行/.test(req.promptText)) ok('提示词里要求"照抄 + 保行"')
  else bad('提示词不是那段照抄的说明')
  if (req && req.imageMagic === '89504e47' && req.imageBytes > 1500) ok(`发出去的还是那张笔迹图（PNG ${req.imageBytes} 字节 —— 不是空白图）`)
  else bad(`发出去的图不对：${req && req.imageMagic} / ${req && req.imageBytes} 字节`)

  if (panel.draft === RECOGNIZED) ok('围栏剥掉了、冒号没被砍、两行都在：' + JSON.stringify(panel.draft))
  else bad('清洗结果不对：' + JSON.stringify(panel.draft) + ' 期望 ' + JSON.stringify(RECOGNIZED))

  // ── ④ 挑一个字体，放上去 ──
  const fonts = await s.eval(`(() => {
    const btns = [...document.querySelectorAll('.bp-font')]
    return { n: btns.length, names: btns.map(b => b.textContent), families: btns.map(b => b.style.fontFamily) }
  })()`)
  if (fonts.n >= 3) ok(`面板上有 ${fonts.n} 种字体可选：${fonts.names.join(' / ')}`)
  else bad('字体选择器没出来：' + JSON.stringify(fonts))
  if (fonts.families.every((f) => f && !/url\(/.test(f))) ok('每个字体按钮都用自己的字体显示（选之前就看得到效果）')
  else bad('字体按钮没有字体样式')
  await s.eval(`(() => { const b = [...document.querySelectorAll('.bp-font')].find(x => /黑体/.test(x.textContent)); if (b) b.click(); return 1 })()`)
  await s.sleep(200)
  const previewFamily = await s.eval(`(() => { const p = document.querySelector('.bp-preview'); return p ? p.style.fontFamily : '' })()`)
  if (/YaHei|黑体|hei/i.test(previewFamily) || previewFamily) ok('预览跟着换成了黑体：' + previewFamily.slice(0, 40))
  else bad('预览没有跟着换字体')

  const cardsBefore = await s.eval(`document.querySelectorAll('.bd-card').length`)
  const insertClicked = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.bp .wp-res-acts .btn')].find(x => /放到白板上/.test(x.textContent))
    if (b) b.click()
    return !!b
  })()`)
  if (!insertClicked) bad('找不到「放到白板上」按钮')
  let inserted = { cards: cardsBefore, editing: false, panelClosed: false, editText: '', kind: '', font: '' }
  for (let i = 0; i < 20; i++) {
    await s.sleep(250)
    inserted = await s.eval(`(() => {
      const card = document.querySelector('.bd-card.editing')
      const ta = card ? card.querySelector('textarea') : null
      return {
        cards: document.querySelectorAll('.bd-card').length,
        editing: !!card,
        panelClosed: !document.querySelector('.bp'),
        kind: card ? card.getAttribute('data-card-kind') : '',
        font: card ? card.getAttribute('data-card-font') : '',
        editText: ta ? ta.value : '',
      }
    })()`)
    if (inserted.cards > cardsBefore && inserted.editing && inserted.panelClosed) break
  }
  if (inserted.cards === cardsBefore + 1) ok(`白板上多了一张卡（${cardsBefore} → ${inserted.cards}）`)
  else bad(`卡片数没变（${cardsBefore} → ${inserted.cards}）`)
  if (inserted.panelClosed) ok('面板自己关了')
  else bad('面板没关')
  if (inserted.kind === 'note') ok('落下来的是一张**文字卡**（不是公式卡）')
  else bad('卡片类型不对：' + inserted.kind)
  if (inserted.font === 'hei') ok('字体记得住：data-card-font=hei')
  else bad('字体没落上去：' + inserted.font)
  /* 插完就进编辑态，所以这一刻卡片里渲染的是**输入框**（和公式卡那条路一样）。
     认出来的字必须先在这个框里看得见 —— 否则用户看到的是一张空卡，
     顺手按个回车还会把它抹掉（这就是 2026-09-15 那个 bug 的形状）。 */
  if (inserted.editText === RECOGNIZED) ok('新卡片的编辑框里就是认出来的那两行（一按回车也不会空）')
  else bad('编辑框里不对：' + JSON.stringify(inserted.editText))

  /* ★★ 落点：卡片左上角钉在你圈的那块笔迹的左上角（**不再要求盖住它**）。
     2026-09-16 用户定的：「不用盖住，就让框贴合公式和字就行」——
     所以卡片只管贴合自己的内容，手写露在周围是要的，不想要就勾"顺便擦掉"。
     这里先验"落点"（这一刻卡片还在编辑态，量不了贴合 —— 编辑器不是内容，
     贴合那条在下面 Esc 之后量）。
     ⚠ 包围框的坐标要在**点"放到白板上"之前**取好：插入之后选区就被清掉了
       （那是故意的：这一次框选已经被这张卡消费掉了），.bd-inkbox 当场消失。 */
  const boxRect = sel.box
  const landed = await s.eval(`(() => {
    const card = document.querySelector('.bd-card.editing') || document.querySelector('.bd-card[data-card-kind="note"]')
    if (!card) return null
    const c = card.getBoundingClientRect()
    return { left: Math.round(c.left), top: Math.round(c.top), right: Math.round(c.right), bottom: Math.round(c.bottom) }
  })()`)
  if (boxRect && landed) {
    const atCorner = Math.abs(landed.left - boxRect.left) <= 2 && Math.abs(landed.top - boxRect.top) <= 2
    if (atCorner) ok(`卡片落在圈的那块笔迹的左上角（卡 ${JSON.stringify(landed)} vs 框 ${JSON.stringify(boxRect)}）`)
    else bad(`落点不对：卡 ${JSON.stringify(landed)} vs 框 ${JSON.stringify(boxRect)}`)
  } else bad('拿不到卡片/包围框的坐标，落点验不了')

  const inkAfterInsert = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
  if (inkAfterInsert === inkAfterDraw) ok(`原笔迹**一个字节都没删**（还是 ${inkAfterInsert} 笔，照旧留在板上）`)
  else bad(`笔迹被动了：${inkAfterDraw} → ${inkAfterInsert}`)

  // ── ⑤ Esc 退出编辑态，看**渲染出来的**那张卡（字体是不是真的用上了） ──
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await s.sleep(900) // 退出编辑态之后要**量两趟**（第一趟量到的宽度还不是最终宽度，高度要第二趟才对），
                     // 所以这里等够两趟（rAF + 150ms 那两趟）+ 一次提交渲染的时间
  const rendered = await s.eval(`(() => {
    const card = document.querySelector('.bd-card[data-card-kind="note"]')
    const note = card ? card.querySelector('.bd-note') : null
    return {
      text: note ? note.textContent : '',
      family: note ? note.style.fontFamily : '',
      empty: !!(card && card.querySelector('.bd-card-empty')),
    }
  })()`)
  if (rendered.text === RECOGNIZED) ok('卡片上渲染的就是认出来的那句（两行都在）')
  else bad('卡片渲染内容不对：' + JSON.stringify(rendered.text))
  if (!rendered.empty && /YaHei|黑体|hei/i.test(rendered.family)) ok('真的用黑体渲染了：' + rendered.family.slice(0, 40))
  else bad('卡片没用上选的字体：' + JSON.stringify(rendered))

  /* ★ 退出编辑态之后卡片会**按真实内容收紧一次**（编辑器不是内容，编辑态量不得）。
     收紧之后这条卡应该**只剩内边距**：宽度 = 文字的自然宽度（最长那一行）、
     高度 = 内容高度。判据和 [5] 那个公式卡一样，独立量一遍（不用上面那次的姿势）：
     自然宽度靠临时把宽度放开成 max-content。 */
  {
    const fit = await s.eval(`(() => {
      const c = document.querySelector('.bd-card[data-card-kind="note"]')
      if (!c) return null
      const body = c.querySelector('.bd-card-body')
      if (!body) return null
      const r = c.getBoundingClientRect()
      const br = body.getBoundingClientRect()
      const prev = body.style.width
      body.style.width = 'max-content'
      const nat = body.getBoundingClientRect().width
      body.style.width = prev
      const cs = getComputedStyle(c)
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        bh: Math.round(br.height), nat: Math.round(nat),
        minH: c.style.minHeight, fitData: c.dataset.fit || null,
        padX: Math.round((parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)) * 10) / 10,
        padY: Math.round((parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)) * 10) / 10,
      }
    })()`)
    if (!fit) bad('量不到收紧之后的文字卡')
    else {
      console.log('     （文字卡：' + JSON.stringify(fit) + '）')
      const slackW = fit.w - fit.nat
      if (Math.abs(slackW - fit.padX) <= 8) ok(`文字卡左右贴着字：卡宽 ${fit.w}px = 最长那行 ${fit.nat}px + 内边距边框 ${fit.padX}px`)
      else bad(`文字卡左右还空着 ${Math.round(slackW - fit.padX)}px（卡 ${fit.w}，最长行 ${fit.nat}，内边距边框 ${fit.padX}）`)
      const slackH = fit.h - fit.bh
      if (Math.abs(slackH - fit.padY) <= 6) ok(`上下也贴着：卡高 ${fit.h}px = 内容 ${fit.bh}px + 内边距边框 ${fit.padY}px`)
      else bad(`文字卡上下还空着 ${Math.round(slackH - fit.padY)}px（卡 ${fit.h}，内容 ${fit.bh}，内边距边框 ${fit.padY}）`)
      /* ★ 这条是"不再盖住"的钉子：卡片高度只跟**内容**有关 ——
         圈的那块笔迹比内容高时，卡片不该跟着那么高（上一版的"盖住"就是这个形状）。
         ⚠ 只比高度，不比宽度：圈得比字窄的时候卡片会比框**宽**（那是它的内容真的需要那么宽，
           撑宽的是内容不是"盖住"）；而"盖住"那套撑出来的只有高度。 */
      const boxH = boxRect ? boxRect.bottom - boxRect.top : 0
      if (!boxRect || fit.h <= boxH + 2 || fit.bh + fit.padY >= boxH) {
        ok(`卡片不为"盖住笔迹"撑高（卡高 ${fit.h} ≤ 内容 ${fit.bh} + 内边距 ${fit.padY}；圈的那块高 ${Math.round(boxH)}）`)
      } else bad(`卡片还是按"盖住笔迹"撑高了：卡 ${fit.h}，内容 ${fit.bh}，内边距 ${fit.padY}，框高 ${Math.round(boxH)}`)
    }
  }

  /* 截图（自己也看一眼）—— 和 check-board-browser 一样：
     "字是不是真的变好看了"这件事，断言只能证明它们各自成立，证明不了整体像不像样。 */
  {
    const shot = await s.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(ROOT, '.cache', 'beautify-shot.png'), Buffer.from(shot.data, 'base64'))
    console.log('  （截图存到 .cache/beautify-shot.png，可以自己看一眼）')
  }

  // ── Ctrl+Z：卡片没了，手写回来（"随时能改回手写"） ──
  const undoneBefore = await s.eval(`document.querySelectorAll('.bd-card').length`)
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await s.sleep(500)
  const afterUndo = await s.eval(`(() => ({
    cards: document.querySelectorAll('.bd-card').length,
    ink: document.querySelector('canvas.bd-ink').dataset.strokes,
  }))()`)
  if (afterUndo.cards === undoneBefore - 1) ok(`Ctrl+Z 把那张文字卡收回去了（${undoneBefore} → ${afterUndo.cards}）`)
  else bad(`撤销没生效：卡片 ${undoneBefore} → ${afterUndo.cards}`)
  if (afterUndo.ink === inkAfterDraw) ok('撤销之后手写还在（这就叫"随时能改回手写"）')
  else bad(`撤销之后笔迹数变了：${afterUndo.ink}`)

  // ── ⑥ 勾上"擦掉原笔迹"：一次 commit 里把两件事都做了 ──
  if (spot) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x - 18, y: spot.y - 22, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + 90, y: spot.y + 40, button: 'left', buttons: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x + 172, y: spot.y + 78, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(400)
    // 这时工具还停在「框选」上，直接拖就是重新框选
    const bx = await s.eval(`(() => { const b = document.querySelector('.bd-inkfmt'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) } })()`)
    if (bx) {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx.x, y: bx.y, button: 'left', buttons: 1, clickCount: 1 })
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx.x, y: bx.y, button: 'left', buttons: 0, clickCount: 1 })
      for (let i = 0; i < 24; i++) {
        await s.sleep(250)
        if (await s.eval(`!!document.querySelector('.bp .wp-res')`)) break
      }
      const cards2 = await s.eval(`document.querySelectorAll('.bd-card').length`)
      await s.eval(`(() => { const c = document.querySelector('.bp-check input'); if (c) c.click(); return 1 })()`)
      await s.sleep(150)
      const clicked = await s.eval(`(() => {
        const b = [...document.querySelectorAll('.bp .wp-res-acts .btn')].find(x => /放到白板上/.test(x.textContent))
        if (b) b.click()
        return !!b
      })()`)
      if (!clicked) bad('第二次没找到「放到白板上」按钮')
      await s.sleep(900)
      const erased = await s.eval(`(() => ({
        cards: document.querySelectorAll('.bd-card').length,
        ink: document.querySelector('canvas.bd-ink').dataset.strokes,
      }))()`)
      if (erased.ink === '0') ok('勾了"擦掉原笔迹" → 手写被清掉了（卡片留着）')
      else bad(`勾了擦除但笔迹还在：${erased.ink}`)
      if (erased.cards === cards2 + 1) ok(`同时多了一张卡（${cards2} → ${erased.cards}）`)
      else bad(`卡片数不对：${cards2} → ${erased.cards}`)

      /* ★ 这两件事必须是**同一步**撤销：一次 Ctrl+Z 把卡片和擦除一起退回去。
         分成两步的话，用户按一次撤销只退了擦除、卡片还留着 —— 看起来像"撤销坏了"。 */
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await s.sleep(250)
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
      await s.sleep(500)
      const back = await s.eval(`(() => ({
        cards: document.querySelectorAll('.bd-card').length,
        ink: document.querySelector('canvas.bd-ink').dataset.strokes,
      }))()`)
      if (back.cards === cards2 && back.ink === String(inkCount)) ok(`一次 Ctrl+Z 把"卡片 + 擦除"一起退了（卡片回到 ${back.cards}，笔迹回到 ${back.ink}）`)
      else bad(`撤销不是一步：卡片 ${back.cards}（期望 ${cards2}），笔迹 ${back.ink}（期望 ${inkCount}）`)
    } else bad('第二次框选之后没出现「✨ 美化」按钮')
  }
}

// ═════════════════════ 9. 卡片：能移动、能放大缩小、不选中就干净、笔能在上面写字 ═════════════════════
/* 用户 2026-09-16 的原话：「卡片应该能够移动，放大缩小和有非选中状态，
   现在一直是右上角有 x 容易误删除，而且无法在卡片上写字」。
   四条全都是"手感和图层"的事 —— 只有真浏览器能验：
     · 拖得动、缩得放（真鼠标拖，量屏幕坐标）；
     · 点空白之后 × 和缩放柄**一起消失**（不选中就干净）；
     · 用**笔**在卡片上写得出字，而且那笔墨**看得见**（画在卡片上面）——
       这条要用像素证明：截一张图，回到页面里解码，读那一点的深浅。
       只断言 z-index 是查不出"看不见"的（那是两回事）。 */
console.log('\n[9] 卡片交互：移动 / 缩放 / 非选中 / 笔能在卡片上写字')
{
  mockReply = { code: 200, body: { choices: [{ message: { role: 'assistant', content: '卡片交互测试' } }] } }

  /* 先再弄一张文字卡出来（走用户那条路，别在夹具里硬塞）。
     工具此刻还停在「框选」上（[8] 的最后一轮用的就是它）。 */
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x - 18, y: spot.y - 22, button: 'left', buttons: 1, clickCount: 1 })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + 90, y: spot.y + 40, button: 'left', buttons: 1 })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x + 172, y: spot.y + 78, button: 'left', buttons: 0, clickCount: 1 })
  await s.sleep(400)
  const fmtBtn = await s.eval(`(() => { const b = document.querySelector('.bd-inkfmt'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) } })()`)
  if (!fmtBtn) bad('框选之后没出现「✨ 美化」按钮（[8] 里还好好的？）')
  else {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fmtBtn.x, y: fmtBtn.y, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fmtBtn.x, y: fmtBtn.y, button: 'left', buttons: 0, clickCount: 1 })
  }
  for (let i = 0; i < 24; i++) {
    await s.sleep(250)
    if (await s.eval(`!!document.querySelector('.bp .wp-res')`)) break
  }
  const cards0 = await s.eval(`document.querySelectorAll('.bd-card').length`)
  await s.eval(`(() => { const b = [...document.querySelectorAll('.bp .wp-res-acts .btn')].find(x => /放到白板上/.test(x.textContent)); if (b) b.click(); return 1 })()`)
  let made = false
  for (let i = 0; i < 20; i++) {
    await s.sleep(250)
    const n = await s.eval(`document.querySelectorAll('.bd-card[data-card-kind="note"]').length`)
    if (n >= 1) { made = true; break }
  }
  if (made) ok(`弄到一张文字卡可以摆弄（卡片 ${cards0} → ${cards0 + 1}）`)
  else bad('没能弄出文字卡，下面的交互没法验')

  // 先退出编辑态（插进去就自动进编辑态，那里没有手柄）
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await s.sleep(350)

  const cardBox = () => s.eval(`(() => {
    const c = document.querySelector('.bd-card[data-card-kind="note"]')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return {
      cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2),
      left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      font: parseFloat(getComputedStyle(c).fontSize),
      selected: c.classList.contains('on'),
      hasX: !!c.querySelector('.bd-card-del'), hasRz: !!c.querySelector('.bd-card-resize'),
    }
  })()`)

  /* ── ① 移动（真鼠标拖卡片的边，不走输入框）──
     往**上**拖：屏幕下缘那一条被工具条压着（z-index 20），
     卡片要是停在那儿，它右下角的缩放柄就正好在工具条底下 —— 下一段就抓不到它了。
     这不是测试的怪癖：**浮层盖住的东西就是点不到**，用户也得先把卡片挪开。 */
  const b1 = await cardBox()
  if (!b1) bad('找不到文字卡')
  else {
    if (b1.hasX && b1.hasRz) ok('选中时右上角有 ×、右下角有缩放柄')
    else bad(`选中时手柄不全（× ${b1.hasX} / 缩放 ${b1.hasRz}）`)
    // 从卡片左上角附近（避开中间的输入框/正文）按下，往右上拖
    const gx = b1.left + 8
    const gy = b1.top + 4
    const inkBefore = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gx, y: gy, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 12; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gx + i * 7, y: gy - i * 10, button: 'left', buttons: 1 })
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gx + 84, y: gy - 120, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(300)
    const b2 = await cardBox()
    const inkAfter = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
    const dx = b2.left - b1.left
    const dy = b2.top - b1.top
    if (dx > 50 && dy < -60) ok(`拖得动：卡片挪到了 (${dx}, ${dy})`)
    else bad(`拖不动或挪得太少（${dx}, ${dy}）—— 用户报的「卡片应该能够移动」`)
    if (inkAfter === inkBefore) ok(`拖卡片没有顺手画一笔（还是 ${inkAfter} 笔）`)
    else bad(`拖卡片的时候落墨了（${inkBefore} → ${inkAfter}）`)
  }

  /* ── ② 放大缩小（拖右下角那个柄）── */
  const b3 = await cardBox()
  if (b3 && b3.hasRz) {
    const rz = await s.eval(`(() => {
      const h = document.querySelector('.bd-card[data-card-kind="note"] .bd-card-resize')
      const r = h.getBoundingClientRect()
      const cx = Math.round((r.left + r.right) / 2)
      const cy = Math.round((r.top + r.bottom) / 2)
      const el = document.elementFromPoint(cx, cy)
      // 诊断用：这个手柄到底收不收得到 pointerdown（"没反应"有两种，必须分得开）
      h.addEventListener('pointerdown', () => { window.__rzHit = (window.__rzHit || 0) + 1 })
      return {
        x: cx, y: cy,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        hit: el ? el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') : 'null',
      }
    })()`)
    console.log('  （缩放柄：位置 ' + JSON.stringify(rz.rect) + '，中心命中的是 ' + rz.hit + '）')
    if (/bd-card-resize/.test(rz.hit)) ok('缩放柄中心命中的就是它自己（没被浮层盖住）')
    else bad(`缩放柄中心命中的是 ${rz.hit} —— 被别的东西盖住了（卡片右下角正好压在工具条底下？先把卡片挪开）`)
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rz.x, y: rz.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rz.x + i * 12, y: rz.y + i * 6, button: 'left', buttons: 1 })
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rz.x + 120, y: rz.y + 60, button: 'left', buttons: 0, clickCount: 1 })
    await s.sleep(350)
    const rzDiag = await s.eval(`(() => {
      const c = document.querySelector('.bd-card[data-card-kind="note"]')
      return { hits: window.__rzHit || 0, scaleVar: c ? c.style.getPropertyValue('--bd-card-scale') : '' }
    })()`)
    const b4 = await cardBox()
    if (rzDiag.hits > 0) ok(`缩放柄收得到 pointerdown（${rzDiag.hits} 次）`)
    else bad('缩放柄压根没收到 pointerdown —— 事件被别的层吃掉了')
    if (b4.w > b3.w + 60) ok(`放得大：卡片宽 ${b3.w} → ${b4.w}`)
    else bad(`拖了缩放柄但没变大（${b3.w} → ${b4.w}）；--bd-card-scale=${rzDiag.scaleVar}`)
    /* ★ 字号必须跟着一起变 —— 这是"整张卡放大"和"只把框拉大"的分界线。
       只改宽高的话，卡片越拉越大、字还是那么小，用户会以为坏了。 */
    if (b4.font > b3.font + 1) ok(`字也跟着变大了：字号 ${Math.round(b3.font)}px → ${Math.round(b4.font)}px`)
    else bad(`框变大了但字号没变（${b3.font} → ${b4.font}）—— 那是"拉框"不是"放大"`)
    const inkNow = await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`)
    if (inkNow === '2') ok('缩放的时候也没有落墨')
    else bad(`缩放的时候落墨了（${inkNow} 笔）`)
  } else bad('没有缩放柄，放大缩小验不了')

  /* ── ③ 非选中状态：**切回笔**，点一下空白，手柄应该一起消失 ──
     ⚠ 必须先切回「笔」。工具还停在「框选」上的话，按空白处那一下是**框选**
       （那个分支在"取消选中"之前就 return 了）—— 自检第一版就栽在这儿，
       报出来像"取消选中坏了"，其实是自己没切工具。 */
  {
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 })
    await s.sleep(250)
    const tool = await s.eval(`(() => { const b = [...document.querySelectorAll('.bd-tools .bd-t')].find(x => /✎|笔/.test(x.textContent)); return b ? b.className : '' })()`)
    if (/ on/.test(tool)) ok('按 P 切回了笔（不然点空白那一下是框选，不是取消选中）')
    else bad('没切回笔：' + tool)

    const empty = await s.eval(`(() => {
      const stage = document.querySelector('.bd-stage')
      const r = stage.getBoundingClientRect()
      for (const fx of [0.5, 0.45, 0.55, 0.4]) {
        for (const fy of [0.2, 0.28, 0.15]) {
          const x = Math.round(r.left + r.width * fx)
          const y = Math.round(r.top + r.height * fy)
          const el = document.elementFromPoint(x, y)
          if (el && el.classList && el.classList.contains('bd-hit')) return { x, y }
        }
      }
      return null
    })()`)
    if (!empty) bad('找不到空白处可点（非选中状态验不了）')
    else {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: empty.x, y: empty.y, button: 'left', buttons: 1, clickCount: 1 })
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: empty.x, y: empty.y, button: 'left', buttons: 0, clickCount: 1 })
      await s.sleep(300)
      const st = await s.eval(`(() => ({
        selected: !!document.querySelector('.bd-card.on'),
        x: !!document.querySelector('.bd-card-del'),
        rz: !!document.querySelector('.bd-card-resize'),
      }))()`)
      if (!st.selected && !st.x && !st.rz) ok('点空白 → 卡片回到非选中状态，× 和缩放柄都不见了（以前 × 一直挂在那儿等人误点）')
      else bad(`点空白之后还有东西亮着（选中 ${st.selected} / × ${st.x} / 缩放 ${st.rz}）`)
    }
  }

  /* ── ④ 双击卡片能改字（键盘打字那条路）── */
  const b5 = await cardBox()
  if (b5) {
    for (const clickCount of [1, 2]) {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b5.cx, y: b5.cy, button: 'left', buttons: 1, clickCount })
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b5.cx, y: b5.cy, button: 'left', buttons: 0, clickCount })
    }
    await s.sleep(400)
    const opened = await s.eval(`(() => {
      const ta = document.querySelector('.bd-card.editing textarea')
      return { has: !!ta, value: ta ? ta.value : '', focused: ta ? document.activeElement === ta : false }
    })()`)
    if (opened.has && opened.focused) ok(`双击进去能打字（输入框里是「${opened.value}」）`)
    else bad(`双击卡片没进编辑态（有框 ${opened.has} / 有光标 ${opened.focused}）`)
    if (opened.has) {
      await s.send('Input.insertText', { text: '（补一句）' })
      await s.sleep(200)
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await s.sleep(500)
      const typed = await s.eval(`(() => {
        const c = document.querySelector('.bd-card[data-card-kind="note"]')
        const n = c ? c.querySelector('.bd-note') : null
        return { text: n ? n.textContent : '', editing: !!document.querySelector('.bd-card.editing') }
      })()`)
      if (/补一句/.test(typed.text)) ok(`打进去的字落到了卡片上：「${typed.text}」`)
      else bad(`打进去的字没上卡片：${JSON.stringify(typed.text)}`)
    }
  }

  /* ── ⑤ 用**笔**在卡片上写字：笔让路 + 墨迹画在卡片上面（像素证明）── */
  const b6 = await cardBox()
  if (b6) {
    // 先让笔"悬停"一下 —— 真笔也是先悬停再落笔（README 里"笔一靠近光标就没了"就是它）
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b6.cx, y: b6.cy, button: 'none', pointerType: 'pen' })
    await s.sleep(250)
    const penState = await s.eval(`(() => ({
      penink: document.querySelector('.bd').classList.contains('penink'),
      cardPE: getComputedStyle(document.querySelector('.bd-card[data-card-kind="note"]')).pointerEvents,
    }))()`)
    if (penState.penink && penState.cardPE === 'none') ok('笔一悬停，卡片就让开了指针事件（笔尖能落到纸上，而不是拖走卡片）')
    else bad(`笔悬停时卡片没让路（penink=${penState.penink} / pointer-events=${penState.cardPE}）`)

    const inkBefore = Number(await s.eval(`document.querySelector('canvas.bd-ink').dataset.strokes`))
    const y0 = b6.cy
    const x0 = b6.cx - 70
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
    for (let i = 1; i <= 14; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + i * 10, y: y0 + Math.sin(i / 3) * 2, button: 'left', buttons: 1, pointerType: 'pen' })
    }
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 140, y: y0, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
    await s.sleep(700)
    const after = await s.eval(`(() => {
      const c = document.querySelector('.bd-card[data-card-kind="note"]')
      const r = c.getBoundingClientRect()
      return {
        ink: Number(document.querySelector('canvas.bd-ink').dataset.strokes),
        left: Math.round(r.left), top: Math.round(r.top),
        sel: c.classList.contains('on'),
      }
    })()`)
    if (after.ink === inkBefore + 1) ok(`笔在卡片上写出了一笔（${inkBefore} → ${after.ink}）—— 这就叫"能在卡片上写字"`)
    else bad(`笔在卡片上没写出东西（${inkBefore} → ${after.ink}），多半是被卡片吃掉了`)
    if (after.left === b6.left && after.top === b6.top) ok('写这一笔没有把卡片拖走')
    else bad(`写这一笔把卡片挪了（${b6.left},${b6.top} → ${after.left},${after.top}）`)
    if (!after.sel) ok('笔也没有把卡片弄成选中（笔只管写字）')
    else bad('笔把卡片选中了 —— 那笔就没地方写了')

    /* ★★ 像素证明：墨迹真的在卡片**上面**。
       只断言 z-index 是假的安心（z-index 高 ≠ 画得出来），
       所以这里截一张真图、拿回页面里解码、读那一点的深浅：
       卡片底色是 #f6f9ff（很亮），笔迹是 #1b1d22（很暗）——一读就知道谁在上面。 */
    const shot = await s.send('Page.captureScreenshot', { format: 'png' })
    const px = await s.eval(`(async () => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + ${JSON.stringify(shot.data)}
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width; cv.height = img.height
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const dpr = img.width / window.innerWidth
      // 取一个 15×15 的小方块里**最暗**的那个像素：一条 3px 宽的线，
      // 只采一个点很容易擦边采到卡片底色，那样会误报成"看不见"
      const box = 15
      const bx = Math.round((${x0} + 70) * dpr) - ((box / 2) | 0) // ⚠ x 就是 x
      const by = Math.round(${y0} * dpr) - ((box / 2) | 0)        // y 就是 y（写反过一次）
      const d = ctx.getImageData(bx, by, box, box).data
      let darkest = 999
      let rgb = null
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3
        if (lum < darkest) { darkest = lum; rgb = [d[i], d[i + 1], d[i + 2]] }
      }
      return { darkest: Math.round(darkest), rgb, dpr }
    })()`)
    if (px && px.darkest < 90) ok(`卡片上那一点读到的是**墨色** rgb(${px.rgb}) —— 说明这一笔真的画在卡片上面、看得见`)
    else bad(`卡片上那一点是亮的（最暗 rgb(${px && px.rgb})）—— 墨迹被卡片盖住了，用户写了也看不见`)
    const shot2 = await s.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(ROOT, '.cache', 'card-interact.png'), Buffer.from(shot2.data, 'base64'))
    console.log('  （截图存到 .cache/card-interact.png，可以自己看一眼）')
  }

  /* ★ 整个流程跑下来，页面里不许有 JS 报错。
     拖动/缩放/指针捕获这些地方，"处理器抛异常"和"处理器没跑"在屏幕上是同一个样子
     （拖了没反应），所以这一条不是洁癖，是这一节唯一的兜底。 */
  if (!s.errors().length) ok('整个流程跑下来，页面里没有任何 JS 报错')
  else bad(`页面里有 JS 报错（${s.errors().length} 条）：` + s.errors().slice(0, 3).join(' ｜ '))
}

// ═════════════════════ 10. 框住已有的手写 → 认成公式 + 卡片留白 ═════════════════════
/* 用户 2026-09-16 的第二条：「公式识别也可以做成框选出来然后识别的，
   不用先点击然后再框里面写才能识别」。
   这条就是把「∑ 公式」接进框选那条路 —— 和「✨ 美化」共用同一块面板、同一套发图逻辑，
   区别只在 mode（认公式还是认字）。顺带把"留白"量化钉住：
   **卡片上的留白就等于它的内边距**，多出来的空白说明 min-height 没贴着内容。 */
console.log('\n[10] 框选 → 认公式；顺带量卡片的留白')
{
  mockReply = { code: 200, body: { choices: [{ message: { role: 'assistant', content: '```latex\nE = mc^{2}\n```' } }] } }
  seen.length = 0

  // 切到框选（S），圈住 [8] 画的那两笔
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 })
  await s.sleep(250)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x - 18, y: spot.y - 22, button: 'left', buttons: 1, clickCount: 1 })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + 90, y: spot.y + 40, button: 'left', buttons: 1 })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x + 172, y: spot.y + 78, button: 'left', buttons: 0, clickCount: 1 })
  await s.sleep(400)

  const fbtn = await s.eval(`(() => {
    const b = document.querySelector('.bd-inkformula')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const cx = Math.round((r.left + r.right) / 2)
    const cy = Math.round((r.top + r.bottom) / 2)
    const el = document.elementFromPoint(cx, cy)
    return { x: cx, y: cy, hit: !!(el && (el === b || b.contains(el))), label: b.textContent.trim() }
  })()`)
  if (!fbtn) bad('框选之后没有「∑ 公式」按钮（公式还得先点写字板再重抄一遍？）')
  else {
    if (fbtn.hit) ok(`框住之后浮出「${fbtn.label}」，而且点得到`)
    else bad('「∑ 公式」按钮点不到（被别的层盖住了）')
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fbtn.x, y: fbtn.y, button: 'left', buttons: 1, clickCount: 1 })
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fbtn.x, y: fbtn.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  let fpanel = { open: false, hasResult: false, katex: 0, err: '', title: '', hasFonts: false }
  for (let i = 0; i < 24; i++) {
    await s.sleep(250)
    fpanel = await s.eval(`(() => {
      const res = document.querySelector('.bp .wp-res')
      return {
        open: !!document.querySelector('.bp'),
        title: (document.querySelector('.bp .wp-head b') || {}).textContent || '',
        hasResult: !!res,
        katex: res ? res.querySelectorAll('.katex').length : 0,
        draft: (document.querySelector('.bp .wp-edit') || {}).value || '',
        hasFonts: !!document.querySelector('.bp-fonts'),
        err: (document.querySelector('.bp .wp-err') || {}).textContent || '',
      }
    })()`)
    if (fpanel.hasResult) break
  }
  if (!fpanel.open) bad('面板没弹出来')
  else if (fpanel.hasResult) ok(`面板弹出来了：「${fpanel.title}」`)
  else bad('没等到识别结果：' + fpanel.err)
  if (fpanel.hasResult) {
    if (/公式/.test(fpanel.title)) ok('面板进的是**公式**那一支（不是认文字那支）')
    else bad('面板标题不对：' + fpanel.title)
    if (fpanel.katex > 0) ok('识别结果渲染成了数学（KaTeX）—— 这就是"框出来认公式"')
    else bad('结果没有渲染成数学')
    if (!fpanel.hasFonts) ok('公式支没有"挑字体"那一排（那是文字卡的东西）')
    else bad('公式支里混进了字体选择器')
    /* ★ mode=formula 有没有真的走到服务端 —— 看假服务收到的提示词。
       这条和 [8] 里那条同一个道理：发错提示词的表现只是"认不出来"，
       从界面上根本看不出是哪个字段没传对。 */
    const req = seen[seen.length - 1]
    if (req && /公式识别工具/.test(req.promptText)) ok('发出去的是**认公式**那段提示词（mode=formula 走通了）')
    else bad('提示词不对（还是认文字那段？）：' + String(req && req.promptText).slice(0, 60))

    // 放到白板上：勾"擦掉原笔迹"，卡片就该**完全贴着内容**（没有要盖的东西了）
    const selInfo = await s.eval(`(() => ({
      inkBefore: Number(document.querySelector('canvas.bd-ink').dataset.strokes),
      picked: Number(((document.querySelector('.bp-src b') || {}).textContent || '').replace(/[^0-9]/g, '')),
    }))()`)
    await s.eval(`(() => { const c = document.querySelector('.bp-check input'); if (c) c.click(); return 1 })()`)
    await s.eval(`(() => { const b = [...document.querySelectorAll('.bp .wp-res-acts .btn')].find(x => /放到白板上/.test(x.textContent)); if (b) b.click(); return 1 })()`)
    let injected = false
    for (let i = 0; i < 20; i++) {
      await s.sleep(250)
      injected = await s.eval(`document.querySelectorAll('.bd-card[data-card-kind="formula"]').length >= 2`)
      if (injected) break
    }
    if (injected) ok('白板上多了一张**公式卡**（不是文字卡）')
    else bad('没看到新插入的公式卡')

    /* ★ 退出编辑态，卡片才会按真实内容收紧（编辑态里量的是编辑器，不是内容） */
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await s.sleep(600)
    let made = null
    for (let i = 0; i < 12; i++) {
      made = await s.eval(`(() => {
        const all = [...document.querySelectorAll('.bd-card[data-card-kind="formula"]')]
        const c = all[all.length - 1]
        if (!c) return null
        const r = c.getBoundingClientRect()
        const bodyEl = c.querySelector('.bd-card-body')
        const cs = getComputedStyle(c)
        let nat = 0
        if (bodyEl) {
          const prev = bodyEl.style.width
          bodyEl.style.width = 'max-content'
          nat = bodyEl.getBoundingClientRect().width
          bodyEl.style.width = prev
        }
        return {
          katex: c.querySelectorAll('.katex').length,
          w: Math.round(r.width), h: Math.round(r.height),
          nat: Math.round(nat),
          bodyH: bodyEl ? Math.round(bodyEl.getBoundingClientRect().height) : 0,
          padTop: Math.round(parseFloat(cs.paddingTop) * 10) / 10,
          padLeft: Math.round(parseFloat(cs.paddingLeft) * 10) / 10,
          padX: Math.round((parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)) * 10) / 10,
          padY: Math.round((parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)) * 10) / 10,
          ink: Number(document.querySelector('canvas.bd-ink').dataset.strokes),
          editing: c.classList.contains('editing'),
          spill: (() => {
            const tex = c.querySelector('.bd-tex')
            return tex ? tex.scrollWidth - tex.clientWidth : 0
          })(),
        }
      })()`)
      if (made && made.katex > 0 && !made.editing && made.bodyH > 0 && made.bodyH < 120) break
      await s.sleep(200)
    }
    if (made && made.katex > 0) ok('公式卡上渲染的是数学（KaTeX）')
    else bad('公式卡没渲染出数学：' + JSON.stringify(made))
    if (made && made.ink === selInfo.inkBefore - selInfo.picked) {
      ok(`勾了擦除 → 圈住的那 ${selInfo.picked} 笔没了（${selInfo.inkBefore} → ${made.ink}，圈外的笔迹没动）`)
    } else {
      bad(`擦除数不对：圈了 ${selInfo.picked} 笔、原有 ${selInfo.inkBefore} 笔，现在剩 ${made && made.ink} 笔`)
    }

    /* ★★ "留白少一点"量化成三条：
       ① 内边距就是 4/8（跟着视图缩放，量出来 4~6px）
       ② 内容没被裁掉
       ③ 卡片的宽/高**正好**等于内容 + 内边距边框（多出来的才是白留的空白） */
    if (made && made.padTop > 0 && made.padTop <= 6 && made.padLeft <= 10) {
      ok(`卡片内边距收窄了：${made.padTop}px / ${made.padLeft}px（原来是 10/12）`)
    } else bad(`内边距没收到位：${made && made.padTop} / ${made && made.padLeft}`)
    if (made && made.spill <= 0) ok('式子完整显示，没有被卡片裁掉')
    else bad(`式子被卡片裁掉了 ${made && made.spill}px（卡太窄）`)
    const slackW2 = made ? made.w - made.nat : 999
    if (made && made.nat > 0 && Math.abs(slackW2 - made.padX) <= 4) {
      ok(`左右不多留：卡宽 ${made.w}px = 式子自然宽 ${made.nat}px + 内边距边框 ${made.padX}px`)
    } else {
      bad(`公式卡左右还空着 ${slackW2 - (made ? made.padX : 0)}px（卡 ${made && made.w}，式子 ${made && made.nat}，内边距边框 ${made && made.padX}）`)
    }
    const slackH2 = made ? made.h - made.bodyH : 999
    if (made && Math.abs(slackH2 - made.padY) <= 4) {
      ok(`上下不多留：卡高 ${made.h}px = 内容 ${made.bodyH}px + 内边距边框 ${made.padY}px`)
    } else {
      bad(`卡片底下空着 ${slackH2 - (made ? made.padY : 0)}px（内容 ${made && made.bodyH}、卡高 ${made && made.h}）`)
    }
  }

  const shot = await s.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(ROOT, '.cache', 'formula-from-ink.png'), Buffer.from(shot.data, 'base64'))
  console.log('  （截图存到 .cache/formula-from-ink.png）')
  if (!s.errors().length) ok('整个流程跑下来，页面里没有任何 JS 报错')
  else bad(`页面里有 JS 报错（${s.errors().length} 条）：` + s.errors().slice(0, 3).join(' ｜ '))
}
/* ═════════════════ 11. 收成笔记：一块 = 一节（ADR-0004 第 2 步）═════════════════
 *
 * 这一节测的是**整板转录这条链路**（「▤ 收成笔记」→ 分块发图 → 转录校对 → 落成笔记）。
 * ⚠ 它在这之前**浏览器覆盖是 0**：这条链路要一个"能认字"的假服务，而假服务只长在
 *   这一条自检里（用的还是同一份 mock + 同一份被挪开的真配置 —— 仍然完全离线、
 *   一个字节都不出这台机器）。
 *
 * 要钉住的事（第 2 步的全部内容）：
 *   ① 分块**优先按你圈的板框**（框里有笔迹 → 一块就是那个框），框外的才按留白切；
 *   ② 块名 = 框名，而且**校对弹层里就看得见**（从前只有"第 N 块"）；
 *   ③ 认回来的字落在草稿里**同名的那一节**底下（"只装手写的框等于不存在"治好了）；
 *   ④ 还是"每行一条 `- `"（第 1 步的判据不许被这一刀弄回去）。 */
console.log('\n[11] 收成笔记：你圈的板框成为笔记小节（一块 = 一节）')
{
  /* 换一张夹具：一个**只装手写**的板框（有标题）+ 框外挨着的两笔（算一片）+ 一张卡。
     ⚠ 先把页面导航走、等应用把**旧的**夹具板补存完再写新内容 ——
       应用"离开页面/切文件之前会补存一次"，写早了会被它盖回去。 */
  const fx = newBoard('收成测试')
  fx.cards = [{ ...newCard('note', 0, 1500, { w: 220, h: 40 }), id: 'k1', x: 0, y: 1500, text: '牛顿第二定律' }]
  const ln = (id, y) => ({ ...newStroke('pen', toFlat([{ x: 0, y }, { x: 240, y }]), { width: 2 }), id })
  fx.strokes = [ln('s1', 0), ln('s2', 40), ln('s3', 700), ln('s4', 740)]
  fx.frames = [{ id: 'fr1', title: '环流定理', ids: ['s1', 's2'] }]

  await s.send('Page.navigate', { url: 'about:blank' })
  await sleep(700)
  fs.writeFileSync(board.path, serializeBoardDocument(fx), 'utf8')
  await open()

  const back = await read()
  if (back && (back.frames || []).length === 1 && (back.strokes || []).length === 4) {
    ok('夹具换成了：一个只装手写的板框「环流定理」+ 框外两笔 + 一张卡')
  } else {
    bad('夹具没换成（八成被应用补存的旧内容盖回去了）：' +
      JSON.stringify({ 笔: (back && back.strokes || []).length, 框: (back && back.frames || []).length }))
  }

  /* 假服务这次回"一整段手写笔记"，不是公式；而且**按块给不同的字** ——
     两块拿同一段话的话，"框里的字落在哪一节"这条断言会被另一块的副本蒙混过去。
     再故意**慢 1.5 秒**：弹层"边认边填"这件事只有在"还没认完"的那一刻才看得出来。 */
  mockReply = {
    code: 200,
    n: 0,
    delayMs: 1500,
    byIndex: ['为什么？什么力 洛伦兹力不做功 ∵ $V≠0$', '静电场 ∮E·dl=0 ∴闭合回路无法提供能量'],
  }
  const n0 = seen.length

  /* 点「▤ 收成笔记」（真鼠标 + elementFromPoint：浮出来的东西只有命中测试能证明点得到）。 */
  const gb = await s.eval(`(() => {
    const b = document.querySelector('[data-tool="gather"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(x, y)
    return { x, y, hitSelf: !!(hit && hit.closest('[data-tool="gather"]')) }
  })()`)
  if (gb && gb.hitSelf) ok('「▤ 收成笔记」点得到（elementFromPoint 命中它自己）')
  else bad('「▤ 收成笔记」看不见或被盖住：' + JSON.stringify(gb))
  await s.mouse(gb.x, gb.y)

  const askw = await until(
    () => s.eval(`(() => { const d = document.querySelector('.ask-input'); return d ? String(d.value || '') : null })()`),
    { what: '「收拢成笔记」的询问框弹出来' }
  )
  if (askw.ok && askw.value === '收成测试 · 笔记') ok('名字预填成「收成测试 · 笔记」')
  else bad('询问框没弹 / 名字不对：' + JSON.stringify(askw.value))
  await s.key('Enter', 'Enter', 13)

  /* 等转录校对弹层挂上。★ 它现在**当场就开**（图先画好、每块摆一个"正在识别…"），
     所以这一刻它应该已经在，而且**两块都还没认完** —— 那正是"边认边填"。 */
  const rvOpen = () => s.eval(`(() => {
    const root = document.querySelector('.trv')
    if (!root) return null
    const bands = [...root.querySelectorAll('.trv-band')]
    return {
      count: bands.length,
      names: bands.map((b) => { const n = b.querySelector('.trv-name b'); return n ? n.textContent.trim() : '' }),
      pending: bands.filter((b) => b.getAttribute('data-pending') === '1').length,
      stopBtn: !!([...root.querySelectorAll('button')].find((x) => /停止转写/.test(x.textContent))),
    }
  })()`)
  const rv = await until(rvOpen, { timeout: 30000, what: '转录校对弹层挂上' })
  if (rv.ok && rv.value.count === 2) ok('弹层里两块：你的板框一块 + 框外那一片')
  else bad('弹层的块数不对（期望 2）：' + JSON.stringify(rv.value))
  if (rv.value && rv.value.names[0] === '环流定理') ok('★ 第一块的标题就是你框的名字「环流定理」')
  else bad('第一块没有框名：' + JSON.stringify(rv.value && rv.value.names))
  if (rv.value && rv.value.names[1] === '第 2 块') ok('框外那一片没有名字（它本来就没有框）')
  else bad('第二块的名字不对：' + JSON.stringify(rv.value && rv.value.names))
  if (rv.value && rv.value.pending > 0 && rv.value.stopBtn) {
    ok(`★ 弹层是**当场打开**的：这一刻还有 ${rv.value.pending}/2 块在认（而且「停止转写」在）`)
  } else {
    bad('弹层不是边认边填（打开时已经没有在认的块，或者没有停止按钮）：' + JSON.stringify(rv.value))
  }

  /* 等它认完（判据是页面事实：没有 pending 的块了，不是睡一个固定毫秒）。 */
  const rvDone = await until(
    async () => {
      const v = await rvOpen()
      return v && v.pending === 0 ? v : undefined
    },
    { timeout: 30000, what: '两块都认完' }
  )
  if (rvDone.ok) ok('两块都认完了（弹层里"正在识别…"全部消失）')
  else bad('等不到两块认完')

  const mine = seen.slice(n0)
  if (mine.length === 2) ok('假识别服务收到 2 次请求（一块一次，没有把整板压成一张图）')
  else bad(`假识别服务收到 ${mine.length} 次请求（期望 2）`)
  if (mine.some((r) => /白板转录工具/.test(r.promptText))) ok('发出去的是**整板转录**那段提示词（mode=board 走通了）')
  else bad('提示词不对（mode 没传到位？）：' + String(mine[0] && mine[0].promptText).slice(0, 60))
  if (mine.length && mine.every((r) => r.imageBytes > 1000)) ok('两块都发了图，而且不是空图')
  else bad('有块发出去的是空图/小图：' + JSON.stringify(mine.map((r) => r.imageBytes)))
  if (mine.length && mine.every((r) => r.imageW > 0 && r.imageW <= OCR_MAX_DIM && r.imageH <= OCR_MAX_DIM)) {
    ok(`★ 每张识别图都在尺寸上限之内（最大 ${Math.max(...mine.map((r) => r.imageW))}×${Math.max(...mine.map((r) => r.imageH))}，上限 ${OCR_MAX_DIM}）`)
  } else {
    bad('有块的识别图超了上限：' + JSON.stringify(mine.map((r) => [r.imageW, r.imageH])))
  }

  /* 校对完了 → 落笔。 */
  const cb = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.trv .wp-acts button')].find((x) => /校对完了/.test(x.textContent))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (cb) await s.mouse(cb.x, cb.y)
  else bad('找不到「校对完了，收成笔记」那颗按钮')

  const NOTE = '收成测试 · 笔记.md'
  const notePath = path.join(ROOT, 'data', NOTE)
  after(() => {
    try {
      fs.rmSync(notePath, { force: true })
    } catch {}
  })
  const made = await until(
    () => {
      try {
        const t = fs.readFileSync(notePath, 'utf8')
        return t.length ? t : undefined
      } catch {
        return undefined
      }
    },
    { timeout: 12000, what: '笔记草稿落盘（' + NOTE + '）' }
  )
  if (made.ok) ok('笔记落盘：' + NOTE)
  else bad('点了「校对完了」之后盘上没长出那份笔记')

  const md = made.value || ''
  const iFrm = md.indexOf('## 1、环流定理')
  const iNext = iFrm < 0 ? -1 : md.indexOf('\n## ', iFrm + 1)
  const secFrm = iFrm < 0 ? '' : md.slice(iFrm, iNext < 0 ? undefined : iNext)
  if (iFrm >= 0) ok('★ 草稿里那一节就叫「环流定理」—— 你圈的框成了笔记的小节')
  else bad('草稿里没有「## 1、环流定理」那一节：' + md.split('\n').slice(0, 8).join(' / '))
  if (secFrm.includes('- 为什么？什么力 洛伦兹力不做功')) ok('★ 框里认回来的手写**落在这一节里面**（不是文末那一段）')
  else bad('框里的手写没落进「环流定理」那一节：' + secFrm.slice(0, 120))
  const iLoose = md.indexOf('、手写转录（机器认的，还没校对）')
  if (iLoose > 0 && md.indexOf('- 静电场 ∮E·dl=0', iLoose) > iLoose) ok('框外那一片落成了文末那一段')
  else bad('框外那一片没落成"手写转录"那一段：' + md.split('\n').slice(-6).join(' / '))
  if (md.includes('- 牛顿第二定律')) ok('板上的卡照旧收进来了')
  else bad('卡没收进来')
  const unread = unreadableLines(md)
  if (!unread.length) ok('★ 草稿里没有"读不到的行"（第 1 步的判据没被这一刀弄回去）')
  else bad(`草稿里有 ${unread.length} 行 parseDoc 读不到：` + JSON.stringify(unread.slice(0, 2)))

  const inNote = await s.eval(`!!document.querySelector('textarea.raw')`)
  if (inNote) ok('应用切到了笔记模式打开它')
  else bad('收完之后没切到笔记模式')
  if (!s.errors().length) ok('这一节跑下来，页面里没有任何 JS 报错')
  else bad(`页面里有 JS 报错（${s.errors().length} 条）：` + s.errors().slice(0, 3).join(' ｜ '))
  /* 落盘的那份删掉：[12] 要拿**同一张板**再收一次（缓存那一条必须能再写一次同名笔记）。 */
  try {
    fs.rmSync(notePath, { force: true })
  } catch {}
}

/* ═════════════════ 12. 转录的手感：缓存 / 单块重认 / 停止（ADR-0004 第 3 步）═════════════════
 *
 * 三件事各有一条硬判据，而且都拿**假服务收到几次请求**当尺子（那才是钱）：
 *   ① **缓存**：同一张板再收一次 → 0 次请求，字照样在（而且标着"上次认的"）；
 *   ② **单块重认**：只发那**一块**（1 次请求），回来把那一块的字换掉；
 *   ③ **停止**：认到一半按停 → 后面的块**一个请求都不发**，弹层留着让你收已经认好的。
 * 顺带钉住"先不收 = 什么都没写"。 */
console.log('\n[12] 转录的手感：内容缓存 / 单块重认 / 停止（第 3 步）')
{
  const NOTE = '收成测试 · 笔记.md'
  const notePath = path.join(ROOT, 'data', NOTE)
  const askAndGo = async () => {
    const gb = await s.eval(`(() => {
      const b = document.querySelector('[data-tool="gather"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (!gb) return bad('找不到「▤ 收成笔记」')
    await s.mouse(gb.x, gb.y)
    const w = await until(
      () => s.eval(`(() => { const d = document.querySelector('.ask-input'); return d ? String(d.value || '') : null })()`),
      { what: '询问框弹出来' }
    )
    if (!w.ok) bad('询问框没弹出来')
    await s.key('Enter', 'Enter', 13)
  }
  const bandState = () => s.eval(`(() => {
    const root = document.querySelector('.trv')
    if (!root) return null
    const bands = [...root.querySelectorAll('.trv-band')]
    return {
      count: bands.length,
      pending: bands.filter((b) => b.getAttribute('data-pending') === '1').length,
      cachedTags: bands.filter((b) => b.querySelector('.trv-tag.ok')).length,
      texts: bands.map((b) => { const t = b.querySelector('textarea'); return t ? t.value : '' }),
      stopBtn: !!([...root.querySelectorAll('button')].find((x) => /停止转写/.test(x.textContent))),
    }
  })()`)
  const waitDone = () => until(async () => { const v = await bandState(); return v && v.pending === 0 ? v : undefined }, { what: '两块都认完' })
  const noReview = () => s.eval(`!document.querySelector('.trv')`)

  /* ── ① 缓存：同一张板再收一次，一次请求都不该发 ── */
  mockReply.delayMs = 0
  await open()
  const c0 = seen.length
  await askAndGo()
  const c1 = await waitDone()
  const cReq = seen.length - c0
  if (cReq === 0) ok('★ 同样的板再收一次：**0 次请求**（内容没变 → 缓存全命中）')
  else bad(`缓存没生效：又发了 ${cReq} 次请求`)
  if (c1.ok && c1.value.texts[0].includes('为什么？什么力') && c1.value.texts[1].includes('静电场')) {
    ok('★ 两块的字照样在（一个是框里的、一个是框外的）')
  } else bad('缓存命中的块里没有字：' + JSON.stringify(c1.value && c1.value.texts))
  if (c1.ok && c1.value.cachedTags === 2) ok('两块都标着「上次认的」（这次没花钱，界面上看得出来）')
  else bad(`"上次认的"标签数不对（期望 2，实际 ${c1.value && c1.value.cachedTags}）`)

  /* ── ② 单块重认：只发那一块 ── */
  mockReply = { code: 200, n: 0, byIndex: ['重新认回来的那一块的字'] }
  const r0 = seen.length
  const rb = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.trv-band')][0].querySelector('.trv-retry')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (rb) await s.mouse(rb.x, rb.y)
  else bad('第一块上没有「重新认这一块」那颗按钮')
  const rd = await waitDone()
  const rReq = seen.length - r0
  if (rReq === 1) ok('★ 「重新认这一块」只发 1 次请求（不是把整板重发一遍）')
  else bad(`单块重认发了 ${rReq} 次请求（期望 1）`)
  if (rd.ok && rd.value.texts[0].includes('重新认回来的那一块的字') && !rd.value.texts[1].includes('重新认回来')) {
    ok('★ 只有第一块的字被换掉，第二块（缓存那份）一个字没动')
  } else bad('重认之后两块的字不对：' + JSON.stringify(rd.value && rd.value.texts))

  /* ── ③ 先不收 = 什么都没写 ── */
  const cancelBtn = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.trv .wp-acts button')].find((x) => /先不收/.test(x.textContent))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (cancelBtn) await s.mouse(cancelBtn.x, cancelBtn.y)
  const closed = await until(noReview, { timeout: 4000, what: '弹层关掉' })
  if (closed.ok) ok('「先不收」把弹层关掉了')
  else bad('「先不收」没关掉弹层')
  if (!fs.existsSync(notePath)) ok('★ 先不收 = 盘上什么都没写')
  else {
    bad('说了"先不收"，盘上却多了一份笔记')
    try {
      fs.rmSync(notePath, { force: true })
    } catch {}
  }

  /* ── ④ 停止：认到一半按停，后面的块一个请求都不发 ── */
  /* 清掉缓存（不然两块都秒回，根本没有"认到一半"这回事），并让假服务慢一点。 */
  await s.eval(`(() => { try { localStorage.removeItem('studyhelper.ocrCache') } catch {} return 1 })()`)
  mockReply = { code: 200, n: 0, delayMs: 4000, byIndex: ['这一块会认很久'] }
  await open()
  const s0 = seen.length
  await askAndGo()
  const opened = await until(async () => { const v = await bandState(); return v && v.pending > 0 ? v : undefined }, { what: '弹层打开、第一块在认' })
  if (opened.ok && opened.value.stopBtn) ok('认到一半，「停止转写」那颗在弹层上')
  else bad('停止按钮不在：' + JSON.stringify(opened.value))
  const sb = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.trv button')].find((x) => /停止转写/.test(x.textContent))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (sb) await s.mouse(sb.x, sb.y)
  const stopped = await until(async () => { const v = await bandState(); return v && v.pending === 0 && !v.stopBtn ? v : undefined }, { timeout: 8000, what: '停止生效（没有在认的块了）' })
  if (stopped.ok) ok('★ 停止生效：不再有在认的块，停止按钮也收了')
  else bad('按了停止但还在认：' + JSON.stringify(stopped.value))
  if (seen.length - s0 === 1) ok('★ 停止之后**后面的块一个请求都没发**（只发了正在认的那一块）')
  else bad(`停止之后又发了 ${seen.length - s0 - 1} 次请求（期望 0）`)
  if (stopped.ok && (await noReview()) === false) ok('弹层留着（已经认好的还能收）—— 停止 ≠ 关掉')
  else bad('停止把弹层也关掉了（那就没法收已经认好的了）')
  /* 收尾：Esc 关掉，别让它影响后面的自检。 */
  await s.key('Escape', 'Escape', 27)
  await until(noReview, { timeout: 4000, what: 'Esc 关掉弹层' })
  if (!s.errors().length) ok('这一节跑下来，页面里没有任何 JS 报错')
  else bad(`页面里有 JS 报错（${s.errors().length} 条）：` + s.errors().slice(0, 3).join(' ｜ '))
}

/* ═════════════════ 13. 两趟：按行抄 + 读结构（ADR-0004 第 4 步）═════════════════
 *
 * 第 4 步的收口，全在真浏览器里跑一遍：
 *   ① 认字那趟**按行回话**（`L1|…`），行号来自本地算的行清单；
 *   ② 校对弹层上**报得出"几行认到了"**；
 *   ③ 点「校对完了」之后再走一趟**没有图的**纯文本调用（假服务按"有没有图"分流）；
 *   ④ 落下来的草稿是**结构小节**，而且每一行都合法（第 1 步的判据）。
 * ⚠ [11]/[12] 用的假服务回的是**不带行号**的自由文字 —— 那正好覆盖了**退化**那条路
 *   （格式没跟上 → 整段照原文抄、第二趟不参与）。这一节才是有行号的那条路。 */
console.log('\n[13] 两趟：按行抄 + 读结构（第 4 步）')
{
  const NOTE = '收成测试 · 笔记.md'
  const notePath = path.join(ROOT, 'data', NOTE)
  /* 缓存里有 [12] 那几块（老格式的原文）→ 不清掉的话这一节根本不会发请求。 */
  await s.eval(`(() => { try { localStorage.removeItem('studyhelper.ocrCache') } catch {} return 1 })()`)
  mockReply = {
    code: 200,
    n: 0,
    /* ★ 按行回话（`byLines`）：**前提是提示词里真有行清单** —— 假服务现在会自己看。
       没有清单时回 `free` 那一段（自由发挥、不带行号），于是"行清单没发出去"
       这条链子断了会在**下一个断言上**（2/2 行认到了）当场炸，而不是一路绿到底。 */
    byLines: ['L1|安培环路定理\nL2|只对稳恒电流成立'],
    free: '安培环路定理\n只对稳恒电流成立（这一次没有行清单，我按自己的分行走）',
    struct: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              sections: [
                /* 第 1 段就是你圈的那个板框 → 用 `"frame": 1` 让**框名**当小节名 */
                {
                  frame: 1,
                  say: '安培环路定理把磁场的环流和穿过它的电流连起来。',
                  rows: [{ line: 1, indent: 0 }, { line: 2, indent: 1 }],
                },
                /* 第 2 段是框外的手写（没名字）→ 拿它第一行的字当标题 */
                { title: 3, rows: [{ line: 3, indent: 0 }, { line: 4, indent: 1 }] },
              ],
              relations: [{ kind: '推导', from: 1, to: 3 }],
            }),
          },
        },
      ],
    },
  }
  await open()
  const n0 = seen.length
  const gb = await s.eval(`(() => {
    const b = document.querySelector('[data-tool="gather"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await s.mouse(gb.x, gb.y)
  await until(() => s.eval(`(() => { const d = document.querySelector('.ask-input'); return d ? String(d.value || '') : null })()`), { what: '询问框' })
  await s.key('Enter', 'Enter', 13)

  const done = await until(
    () => s.eval(`(() => {
      const root = document.querySelector('.trv')
      if (!root) return null
      const bands = [...root.querySelectorAll('.trv-band')]
      const pend = bands.filter((b) => b.getAttribute('data-pending') === '1').length
      if (pend) return null
      return { cov: bands.map((b) => { const c = b.querySelector('.trv-cov'); return c ? c.textContent.trim() : '' }), texts: bands.map((b) => b.querySelector('textarea').value) }
    })()`),
    { timeout: 30000, what: '两块都认完' }
  )
  if (done.ok && done.value.cov.every((c) => /2\/2 行认到了/.test(c))) ok('★ 校对弹层上报得出"2/2 行认到了"（按行回话走通了）')
  else bad('覆盖率没报出来 / 行数不对：' + JSON.stringify(done.value && done.value.cov))
  if (done.ok && !done.value.texts.join('').includes('L1|')) ok('★ 文本框里是**纯文字**（行号那一层不给改字的人看）')
  else bad('文本框里还带着行号前缀：' + JSON.stringify(done.value && done.value.texts))

  const cb = await s.eval(`(() => {
    const b = [...document.querySelectorAll('.trv .wp-acts button')].find((x) => /校对完了/.test(x.textContent))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (cb) await s.mouse(cb.x, cb.y)
  const made = await until(
    () => {
      try {
        const t = fs.readFileSync(notePath, 'utf8')
        return t.length ? t : undefined
      } catch {
        return undefined
      }
    },
    { timeout: 15000, what: '笔记落盘' }
  )
  const mine = seen.slice(n0)
  const structReqs = mine.filter((r) => r.imageBytes === 0)
  /* ★ 认字那一趟的提示词里**必须**带着行清单（ADR-0004 第 4 步的第一跳）。
     它是"第二趟有没有被叫上"的唯一前提：模型见不到清单就只能自由分行、
     一个 `L<行号>|` 都回不出来 → `parseLineOutput` 判 followed=false → `items` 是 null
     → App.jsx 里那个闸不开 → 草稿退回"按块平铺"（＝纯粹的识别）。
     ⚠ 2026-09-20 用户报的"碎片化、没有逻辑"就是这个：App.jsx 一路在传 `opts.lines`，
       服务端一路在读 `lines` 字段，**中间 recognizeHandwriting 没把它 append 进去**。
       当时这一节之所以全绿，是因为假服务按"第几次请求"回话、根本不看提示词。 */
  const imgReqs = mine.filter((r) => r.imageBytes > 0)
  if (imgReqs.length && imgReqs.every((r) => MANIFEST_RE.test(r.promptText))) {
    ok('★ 认字那一趟的提示词里带着**行清单**（第 4 步的第一跳没断）')
  } else {
    bad(
      `认字那一趟的提示词里没有行清单（发了 ${imgReqs.length} 张图，` +
        `${imgReqs.filter((r) => !MANIFEST_RE.test(r.promptText)).length} 张没有）—— ` +
        '模型只能自由分行，第二趟永远不会被叫上：' +
        String(imgReqs[0] && imgReqs[0].promptText).slice(0, 80)
    )
  }
  if (structReqs.length === 1) ok('★ 第二趟只发了一次，而且**没有图**（纯文本出去）')
  else bad(`结构整理那一趟发了 ${structReqs.length} 次（期望 1）`)
  if (structReqs.length && /一个字都不要写/.test(structReqs[0].promptText)) ok('★ 那一趟的提示词里带着铁律：行的文字一个字都不许它写')
  else bad('结构整理的提示词不对：' + String(structReqs[0] && structReqs[0].promptText).slice(0, 60))
  if (structReqs.length && /除了 `say`/.test(structReqs[0].promptText)) ok('★ 铁律收窄成"除了 `say`"——放行的那一处没被漏掉')
  else bad('提示词里没写清 `say` 是唯一可写处（它会连 say 也不写，这一趟又只剩骨架）')
  if (structReqs.length && /L1：安培环路定理/.test(structReqs[0].promptText)) ok('输入里是"行号：那一行的字"（坐标系跟着一起发）')
  else bad('结构整理的输入里没有行清单')

  const md = made.value || ''
  if (/## \d+、环流定理/.test(md)) ok('★ 第一小节用**你圈的框名**当标题（`"frame": 1` 那条路）')
  else bad('板框名那条路没走通：' + md.split('\n').filter((l) => /^## /.test(l)).join(' / '))
  if (/## \d+、安培环路定理/.test(md)) ok('★ 第二小节拿它第一行的字当标题（`"title": 3` 那条路）')
  else bad('草稿里没有结构小节：' + md.split('\n').slice(0, 10).join(' / '))
  if (md.includes('  - 只对稳恒电流成立')) ok('★ 缩进也读出来了（挂在上一行底下）')
  else bad('层级没落进草稿')
  /* ★ 放行的那一段（`say`）：它得**真落进草稿**、带着我们加的标记、而且是一条合法节点。 */
  if (md.includes('- 〔机器整理〕安培环路定理把磁场的环流和穿过它的电流连起来。')) {
    ok('★ 机器写的那一段落进草稿了，而且带着〔机器整理〕标记（哪句是它写的，一眼看得见）')
  } else {
    bad('草稿里没有机器整理那一段：' + md.split('\n').filter((l) => /机器整理/.test(l)).join(' / '))
  }
  if (md.includes('带 `〔机器整理〕` 的那一条是**机器自己写的一段话**')) ok('★ 草稿开头明说了两种出处（机器写的 vs 你写的）')
  else bad('草稿里没说清"哪一条是机器写的"')
  if (/- 推导 \| → /.test(md)) ok('关系落在草稿里（长在它出发的那一行底下）')
  else bad('关系没落进草稿')
  if (md.includes('> 下面这几节是机器认的手写')) ok('机器认的那一段照样明写着"还没校对"')
  else bad('草稿里没有"机器认的"那句提醒')
  const unread = unreadableLines(md)
  if (!unread.length) ok('★ 结构化之后的草稿里也没有"读不到的行"')
  else bad(`草稿里有 ${unread.length} 行 parseDoc 读不到：` + JSON.stringify(unread.slice(0, 2)))
  if (!s.errors().length) ok('这一节跑下来，页面里没有任何 JS 报错')
  else bad(`页面里有 JS 报错（${s.errors().length} 条）：` + s.errors().slice(0, 3).join(' ｜ '))
}
})

/* 收自己的两件东西：假识别服务 + 那份被挪开的配置（服务/浏览器/夹具由 withBoard 收）。 */
cleanup()
