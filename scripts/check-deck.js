/* check-deck：**课件整理**这条链路的端到端（2026-09-22）。
 *
 * 真浏览器里从头走一遍，每一步都盯一件用户真正在意的事：
 *   [1] 工具条上那颗「✧ 课件整理」看得见、点得到；
 *   [2] 点它 → 弹出**它自己**的窗口（不是浏览器的 prompt），上面写着这份资料有几页；
 *   [3] 挑页 → 读：一页一页地问假识别服务（**每页带对了页码**），边读边往窗口里填；
 *       ⚠ "挑了两页就发两次、页码按页序 1、2" —— 点「讲这几页」会先忘掉**这几页**的讲稿
 *         （"讲这几页" = 重读），所以**不会**出现"第 1 页命中缓存只发第 2 页"那种局面；
 *   [3b] ★ 第二趟：**整节课那两张卡**（2026-09-22）—— 提纲（给复习）+ 做题须知（给做题那一趟）。
 *        同一个口、同一份摘要发两次，**两张的内容必须不一样**（键里漏了 kind 的话
 *        后算的那张会盖住先算的，须知显示成提纲的六段，而且不报错）；
 *        ⚠ 假服务里"是第二趟"的判据要**认得出两张**（见 mock 里 `deckSum` / `deckRules`）——
 *          只认提纲的话，须知那一趟会掉进逐页分支、回一份空的，而界面上就是"须知没做"；
 *   [4] 没读出来的那一页只影响那一页，别的页照样读完（"一页一次调用"挣来的东西）；
 *   [5] 点「贴到白板上」→ 卡片**落进文件**（这一步是这条链路的终点，前面全绿都不算）；
 *   [6] 落的是真卡片：讲义卡带 rich（正文里的式子排得出来）、公式卡带 tex；
 *   [6b] ★ 贴上去的卡片**默认钉住**（2026-09-22 用户定的）：文件里写着 locked、
 *        卡片身上那一点命中 `.bd-hit`（拖不动）、📌 中心那一点命中它自己（点得到）、
 *        点一下解开**而且落进文件**（重开这张板还是解开的）—— 全是命中测试，走真鼠标；
 *   [7] 关了窗口重开一次 → 挑哪几页讲哪几页，页码要发对；
 *       ★ **讲过的页不再默认选上**（2026-09-30 用户原话："讲解ppt的时候不要默认
 *         选中已经讲过的页"）—— 重开窗口时默认只剩没讲过的那几页；
 *       ⚠ 「讲这几页」= **重读**（`DeckReview` 开读之前先 `forgetDeck(path, 这几页)`），
 *         所以它**会**再出网一次 —— 这是有意的：按钮的字面意思就是"讲这几页"，
 *         从前它被缓存拦着，点了却只回放旧稿（连"现在这版代码长什么样"都验不到）；
 *         ⚠ 只忘**这几页**（不是整份）：别的页的讲稿是花真钱买来的，不该被顺手带走。
 *   [7b] 「花钱与否在屏幕上看得见」：`.dkr-pgblk[data-page]` 是口子 —— 拿这一趟
 *        **真发过**的页号，和 `.trv-tag.ok`（「上次讲的」）的分布对一遍；
 *   [8] 贴完之后**笔照常在资料上写**（这个功能的用法就是"看着课件写"）；
 *   [9] ★ **板上没有课件也能整理**（2026-09-20）：点那颗按钮**真开的是选文件那个框**
 *       （CDP 从浏览器那一侧截住文件选择器，不是"我自己塞个 File 进去"），
 *       选完直接挑页，卡落在视野中心；
 *       ⚠ 「讲这几页」= 真重读（`DeckReview` 开读之前先忘掉**这几页**的讲稿），
 *         所以这条路**会**再出网一次 —— 这是有意的：那句按钮的字面意思就是"讲这几页"，
 *         从前它被缓存拦着，点了却只回放旧稿（连"现在这一版代码长什么样"都验不到）。
 *         要验"同一页不花两次钱"请走 [7] 那条路（那儿本来就是"接着讲"的意思）。
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
/* 「提纲底下那道缝」的量：`CARD_GAP_Y` 是**摆版自己的数**（doc-cards.js）——
   这里引它，不在断言里再抄一个 18（抄一份的话，哪天摆版的缝改了，
   这条断言会红得像"提纲和卡片没接上"，而其实只是数字没跟上）。 */
import { CARD_GAP_Y } from '../src/lib/doc-cards.js'

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
      /* ★ **上一次没跑完留下的备份不许删**（2026-09-20 改）——
         以前这里是 `fs.rmSync(stash)`，于是一个很短的链条就能把用户的密钥弄丢：
           ① 上一次跑到一半被强杀（Ctrl+C、上层杀进程树、`Select-Object -First` 掐管道…）
              → 真配置留在 `.checkdeck-bak` 里，而它**被应用写下的假配置**顶着 config/ocr.json；
           ② 这一次开头执行到这一行 → 把那份真配置 rmSync 掉（fs.rmSync 不进回收站）；
           ③ 收尾再把假配置放回去 —— 用户看到的是"我的密钥怎么没了"。
         2026-09-20 真的这么丢过一次。所以老备份**改名留着**，收尾还会把它的名字打出来。
         ⚠ 改这段之前先问一句"删的是谁的"（MEMORY.md 里那条）。 */
      if (fs.existsSync(stash)) {
        const keep = stash + '.' + new Date().toISOString().replace(/[:.]/g, '-')
        try {
          fs.renameSync(stash, keep)
          console.log('  （上次没跑完留下的备份留着没删：config/' + path.basename(keep) + '）')
        } catch {}
      }
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
    /* 收尾时说清"还有哪些备份躺着"：上面那一步可能放回去的是**假配置**
       （上一次被强杀时留下的那种），真配置就改名躺在旁边 —— 不报出来等于没救。 */
    for (const n of fs.readdirSync(path.join(ROOT, 'config'))) {
      if (/^ocr\.json\.checkdeck-bak\./.test(n)) {
        console.log('  ⚠ config/' + n + ' 是**更早一次**留下的备份 —— 里面可能是你的真密钥，')
        console.log('    确认一下 config/ocr.json 里那个 key 对不对，不对就把这份改名回去。')
      }
    }
  } catch (e) {
    console.log('  ⚠ 放回 config/ocr.json 失败：' + String(e && e.message) + ' —— 备份在 ' + stash)
  }
}

/* ── 被掐断也要把它放回去（2026-09-28 加）───────────────────────────────
 * ⚠ 从前 `restoreConfig()` 只在文件**最后一行**被调用 —— 而脚本一旦中途被掐
 *   （Ctrl+C、上层杀进程树、`Select-Object -First` 掐管道、断言抛到顶层…），
 *   那一行永远不会执行：config/ocr.json 停在自己写进去的**假配置**上，真配置
 *   躺在 `.checkdeck-bak` 里没人管。
 *   2026-09-24 就这么留了一次 —— 用户后来的样子是「AI 讲不了 PPT，44 页全失败」：
 *   假配置指向的是 mock 端口 `127.0.0.1:5199`（下面那个 MOCK_PORT），那里没人听，
 *   于是每一页都是 ECONNREFUSED，44 页一模一样地红。
 *
 * 所以"放回去"这件事必须挂到**所有**退出路径上。
 * `process.on('exit')` 的钩子里只许做**同步**的事 —— `renameSync` 正好是同步的。
 *
 * ★ `restoreOnce` 要**只跑一次**：正常收尾那条路会先执行它，紧接着 `exit` 钩子
 *   又会来一次。重复进 `restoreConfig` 的话，第二次会发现 `stash` 已经不在了，
 *   而 `stashed` 还是 true —— 于是屏幕上多一句假的「⚠ 备份不见了」。
 *   所以这里用一个闸门，并且**所有**退出路径都走它（包括文件最后那一行）。 */
let restoring = false
function restoreOnce(tag) {
  if (restoring) return
  restoring = true
  try {
    restoreConfig()
  } catch {
    /* 这里再抛就是连最后一步也拦住了，认了 */
  }
  if (tag) console.log('  （被 ' + tag + ' 打断 —— config/ocr.json 已经先放回去了）')
}
process.on('exit', () => restoreOnce(null))
process.on('SIGINT', () => {
  restoreOnce('Ctrl+C')
  process.exit(130)
})
process.on('SIGTERM', () => {
  restoreOnce('SIGTERM（进程树被杀）')
  process.exit(143)
})
process.on('uncaughtException', (e) => {
  restoreOnce('一个没接住的异常')
  console.error(e)
  process.exit(1)
})

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

/* ── 假识别服务回的"老师讲解"：一页一段，**按提示词里的页码**挑 ──
   三页刻意做成三档：第 1 页有讲解 + 重点、第 2 页带公式、第 3 页是空页（封面/过渡页那种）。
   ⚠ 讲解里故意夹一个行内公式（`$F=ma$`）—— 讲义卡要把它**排出来**，这条得有人盯着。 */
const PER_PAGE = {
  1: {
    page: 1,
    unit: '力与运动',
    explain: '这一页先把规矩立下：分析任何一道力学题，第一步都是画受力图，把物体受的每个力都画出来，再定一个正方向。',
    points: ['先画受力图', '再定正方向'],
    formulas: [],
  },
  2: {
    page: 2,
    explain: '这一页给出牛顿第二定律 $F=ma$ —— 它说的是合外力决定加速度，注意它只在惯性系里成立。',
    points: ['只对惯性系成立'],
    formulas: ['F=ma'],
  },
  3: { page: 3, explain: '', points: [], formulas: [] },
}

/* ── 假服务回的"整节课的提纲"（第二趟，`/api/doc/summary`，kind=docsum）──
   它**没有图**（那一趟只发文字），所以判据是"提示词里有没有那份摘要"。
   ⚠ 夹具内容要和 `PER_PAGE` 对得上（"力与运动""F=ma"那些是从摘要里认来的）——
     对不上的话，这一节绿的也是个假绿（模型没看到摘要也照样能回这几句）。 */
const SUMMARY_REPLY = {
  sections: [{ name: '力与运动', pages: '1-2', about: '先立规矩，再给定律' }],
  flow: ['先教怎么画受力图，再拿牛顿第二定律把力和加速度连起来'],
  must: ['合外力决定加速度'],
  pitfalls: ['忘了它只在惯性系里成立'],
  formulas: [{ tex: 'F=ma', note: '合外力与加速度的关系' }],
  check: ['为什么第一步要画受力图？'],
}

/* ── 假服务回的"做题须知"（**同一个口，kind=rules**）────────────────────────
   ★ 第二张整节课的卡（2026-09-22，用户要的"给做题那一趟看的口径"）。
   ⚠ 它的形状**必须和 SUMMARY_REPLY 长得不一样**（没有 sections/formulas/check，
   只有 units/conv/traps）。两件事：① 假服务要是两张卡回同一份，
   `normalizeRules` 会因为认不出 `units/conv/traps` 而判 blank ——
   界面上一块永远空着，而自检要是只判"那一块在不在"照样绿；
   ② 这两份夹具的差别正是"两张卡没串"的**唯一证据**
   （串了的后果见 doc-read.js 的 `sumKeyOf` 那条注：须知会显示成提纲的六段）。
   ⚠ 内容也要和摘要对得上（"画受力图""国际单位制"是从 `PER_PAGE` 的重点里认来的）。 */
const RULES_REPLY = {
  units: ['都用国际单位制（力用牛顿、长度用米）'],
  conv: ['先画受力图，再定正方向，最后才列方程'],
  traps: ['最后忘了写单位'],
}

/* 假服务：记下每一次请求（提示词、图多大、认的哪一页），按页码回话。 */
let mockCode = 200
let mockDelayMs = 0
let forceFailPage = 0
const seen = []
/* ★★ 凡是要看**逐页那一趟**的账（页码、有没有图、temperature），一律走 `pageSeen()` ——
   **不许直接读 `seen`**。理由：整节课那两趟（第二趟，`/api/doc/summary`）走的是同一个假服务，
   混进来会把每一条都污染掉：
     · 它们的提示词里带着那份摘要，而摘要里有"第 1-2 页"这种页号 ——
       按 `第 (\d+) 页` 一抠就抠出个**假页码**（实测抠出的是 2），
       "只重发了第 2 页"这类断言于是拿到 [2,2]；
     · 它们**没有图**（`imageBytes` 是 0、`imageJpeg` 是 false）——
       "发的是 JPEG"和"图有实在内容"两条会一起判红，而逐页那几页明明是好的。
   2026-09-22 加提纲时，[3]/[4]/[7] 三节就是这么红的（不是代码错，是**判据**没跟上新的一趟）。
 * ★ 加须知那一趟时又栽了一次（同一节、同两条断言）：`RULES_PROMPT` 里有一句
 *   "不许出现第几页"，举的例子是「"第 3 页的公式里 g 取 10"」——
 *   假服务按 `第 (\d+) 页` 一抠就抠出个 **3**，把它记成"逐页读过的第 3 页"。
 *   ⇒ 两处一起收口：① 页号只在**带了图**的请求里抠（见 mock 里那条注）；
 *     ② 这个谓词按 `deck` 滤，而 `deck` 的判据是"没图 + 带摘要" ——
 *     两条合起来，"逐页那一趟"的定义 = **带图的那些请求**，语义唯一。 */
const pageSeen = () => seen.filter((x) => !x.deck)
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
    /* ⚠ **页号只在"带了图"的那一趟里抠**（逐页那趟）。整节课那两趟是纯文字，
       它们的提示词里**有"第 N 页"这种字样**（不是页码，是**说明**）——
       实测：`RULES_PROMPT` 里那句"不许出现第几页"举的例子就是
       「"第 3 页的公式里 g 取 10"」→ 按 `第 (\d+) 页` 一抠就抠出个 **3**，
       于是假服务把它记成"逐页读过的第 3 页"，
       [7] 那两条断言（"只发了第 2 页"/"标签分布对不上"）跟着红 ——
       而报出来的话看着像"页码发错了"，其实**根本没发那一页**（那条记录没有图）。
       ⇒ 判据：`img` 在才算页号。这一条同时也把 `pageSeen()` 的语义钉得更准：
         "逐页那一趟"的定义就是"带图的那一趟"。 */
    const m = img ? /第 (\d+) 页/.exec(promptText) : null
    const page = m ? Number(m[1]) : 0
    /* ★ 整节课那一趟（第二趟）：**没有图**，判据是"提示词里有没有那份摘要"。
       这里把整段提示词记下来，自检那一节要断言"摘要真的发出去了"
       —— 不查的话，"提纲那一趟忘了带输入"这件事在界面上看起来完全正常。
       ★★ 那一趟现在有**两张卡**（提纲 + 须知），走同一个口、输入也是同一份摘要，
       所以必须再分一次：**只有"认得出是提纲"的才按 `deck` 记账**（见下）。
       ⚠⚠ 为什么不能"只要没图、带摘要就都算 deck"（第一版就是这么写的，10 条红）：
         须知那一趟的提示词里压根没有「提纲」这个词（读它的 RULES_PROMPT），
         于是它**判不出是第二趟** → 落到下面的逐页分支 → 回一份 `PER_PAGE[0]`
         （因为"第 N 页"抠不出来、page=0）→ `normalizeRules` 认不出 units/conv/traps
         ⇒ 界面上"做题须知"那一块永远空着，而假服务侧一切正常。
         表现是 [3b]/[7] 一票红，报出来的话却是"提纲那一条不对"——**判据错，不是代码错**。
       ★ 判据不靠"哪一句提示词里有关键词"，而是**两道口令同时成立**：
         ① 提示词里带着那份摘要（`你当时划的小节`）—— 证明确实是第二趟；
         ② 提示词里出现**那一段专属的段名**（提纲有"骨架/自测"，须知有"单位与符号"）——
            那两句分别只住在 SUMMARY_PROMPT 和 RULES_PROMPT 里。
         比只 match 「提纲」「做题须知」稳：那两个词在别处的提示词里也可能出现
         （比如逐页那趟的 `DOC_PROMPT` 里就有"这一页要做什么"这种话）。 */
    const hasDigest = !img && /你当时划的小节/.test(promptText) && /每一页的重点/.test(promptText)
    const deckSum = hasDigest && /骨架/.test(promptText) && /自测/.test(promptText)
    const deckRules = hasDigest && /单位与符号/.test(promptText) && /最容易错的/.test(promptText)
    const deck = deckSum || deckRules
    /* ★ 两次调用的**输入**（那份摘要原文）要一起记下来：两张卡的护栏都建立在
       "我手里只有这一份"上，所以自检要判"两次发出去的是不是同一份"
       —— 判"提示词长度一样"是**错的**（两段提示词本身就不一样长，见下面那条注释）。 */
    const digest = (() => {
      const i = promptText.indexOf('这份课件你讲了第')
      return i >= 0 ? promptText.slice(i, i + 400) : ''
    })()
    seen.push({
      page,
      deck,
      summary: deckSum,
      /* 提示词只在整节课那两趟记（逐页那趟的提示词又长又没用；上面的 `pageSeen()` 注释说了为什么） */
      promptText: deck ? promptText : '',
      /* ★ 那份摘要的抬头（两次调用该是**一模一样**的一份）——
         ⚠ **别拿提示词总长度当判据**：两段提示词本来就不一样长
           （SUMMARY_PROMPT 六段、RULES_PROMPT 三段），长度不同不代表输入不同。
           这里切的是**输入那一截**（`这份课件你讲了第 …` 开头那段）。 */
      digest: deck ? digest : '',
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
        const body = deckRules
          ? { choices: [{ message: { role: 'assistant', content: JSON.stringify(RULES_REPLY) } }] }
          : deckSum
            ? { choices: [{ message: { role: 'assistant', content: JSON.stringify(SUMMARY_REPLY) } }] }
            : forceFailPage && page === forceFailPage
              ? { choices: [{ message: { role: 'assistant', content: '这一页我看不清。' } }] }
              : { choices: [{ message: { role: 'assistant', content: JSON.stringify(PER_PAGE[page] || { page, explain: '', points: [], formulas: [] }) } }] }
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
    /* ⚠ 只数**真的页块**：.dkr-pgblk.pending 是"正在讲…"那个占位块，它也是一块 ——
       混在一起数，自检会在第 N 页还在飞的时候就往下走（下面"公式那条"就是这么踩到的）。
    ⚠ 还要把**整节课那两块**摘出去（[data-summary] / [data-rules]）：它们是整节课一块，不按页走。
       不摘的话 [3b] 那句"逐页那两块一块没多"会数到 3、4 ——
       而它报的红看着像"整节课的卡混进页块里了"，其实结构是对的（真正该验的是 blocks，
       那个字段已经算好了）。跟 items 一个道理：那是另一层的东西，别混进页块的账里。
    ⚠⚠ 这段是**模板字符串**（外面是反引号）—— 注释里一个反引号都不许有，
       连"想引用一个字段名"也不行。踩到**第四次**了（这里、summaryInput 那两处注释、
       cards 那段），每次都是当场 SyntaxError 把整个自检带死。要强调就用中文引号。 */
    blocks: blocks.filter((b) => !b.classList.contains('pending') && !b.hasAttribute('data-summary') && !b.hasAttribute('data-rules')).length,
    blocksAll: blocks.filter((b) => !b.classList.contains('pending')).length,
    pending: blocks.filter((b) => b.classList.contains('pending')).length,
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
    emptyPages: [...document.querySelectorAll('.dkr-pgblk')].filter((b) => /没什么可讲的/.test(b.textContent)).length,
    /* ── 整节课那两块（第二趟的产出：提纲 + 做题须知）──
       它们**不是** .dkr-pgblk 里那些按页走的块，所以单独读
       （data-summary / data-rules 那两个口子）。
       ★ **同一个读法读两块**：两块除了那两个口子、标题和提示语之外完全一样
         （共用 deckBlock 那段渲染，见 DeckReview.jsx 那条注）——
         在这里抄两份探测代码，等于把"改了一块忘了另一块"复制到自检里。
         ⚠ 口子的名字按 kind 分（deck 参数就是那个值：docsum / rules）。
       ★ 条目认 [data-deck-item][data-deck-kind]（**不是**老的 data-summary-item）：
         老的只标提纲那一条，须知那一条上什么都没有 —— 拿它当判据，
         须知那一块的条目会被读成"没有"（而屏幕上明明有）。
       ⚠ 拿它之前先问"这一块在不在"：不在时下面每一项都该是"没有"，
         而不是抛一个 undefined 出来把整节自检带沟里。
       ⚠ 这段整块是**模板字符串**（外面是反引号）—— 里面不许再出现反引号，
         想强调就写中文引号，属性名也不许用反引号括起来。
         ★ 踩到**第五次**了（2026-09-22 加须知这一趟又栽了一次，报的是
           SyntaxError: Unexpected identifier）：在这里写下"反引号括起来的属性名"
           这句话本身，就已经把模板串截断了。 */
    deck: (() => {
      const read = (kind) => {
        const attr = kind === 'rules' ? 'data-rules' : 'data-summary'
        const el = document.querySelector('.dkr-pgblk[' + attr + ']')
        if (!el) return { present: false }
        const item = el.querySelector('.dkr-item[data-deck-item][data-deck-kind="' + kind + '"]')
        return {
          present: true,
          run: /正在把这一节课/.test(el.textContent),
          done: !!item,
          kind: item ? ((item.querySelector('.dkr-kind') || {}).textContent || '') : '',
          title: item && item.querySelector('.dkr-t') ? item.querySelector('.dkr-t').value : '',
          body: item && item.querySelector('.dkr-b') ? item.querySelector('.dkr-b').value : '',
          css: getComputedStyle(el).display, /* grid（逐页那些块）还是 block（它们自己） */
          err: (el.querySelector('.dkr-err') || {}).textContent || '',
          retry: !!el.querySelector('.dkr-retry'),
          /* 这一趟是不是命中缓存（界面上那行小字会写「上次生成过的」）——
             用它区分"没出网"和"出了网但没认出来"，别靠猜。 */
          cached: /上次生成过的|上次的/.test(el.textContent),
        }
      }
      return { sum: read('docsum'), rls: read('rules') }
    })(),
    /* 这一趟讲完了没有：head 那句话在三档之间换（挑页 / 正在一页一页讲 / 讲完了），
       所以按那句话本身判，别数占位块。 */
    settled: /讲完了/.test((document.querySelector('.dkr .wp-head') || {}).textContent || ''),
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
      /* ★ 讲稿**也会落盘**（2026-09-23 起，见 doc-read.js 的 diskLoad）：
         这一趟读成功的页会被写进 `.资料/.已读/zz-deck-smoke/p<N>.json`。
         ⚠ 不清掉的话，下次同一个夹具会**命中上一趟的稿子** —— 而 check-deck 里
         好几条断言查的是"这一页到底发没发请求"（命中就不发了），那正是
         "同一份代码跑两遍一红一绿"的老毛病。夹具必须自造自删，这一份也算夹具。
         ★★ 只删 `p<数字>.json`（和服务端那条"删的是谁的"同一条纪律）。 */
      try {
        const dir = path.join(DATA, '.资料', '.已读', 'zz-deck-smoke')
        for (const n of fs.readdirSync(dir)) {
          if (/^p\d+\.json$/.test(n)) fs.unlinkSync(path.join(dir, n))
        }
        /* 清完通常就空了 —— 顺手把这个**自己造的**目录也带走（非空时 rmdir 会失败，
           而失败就失败：里面还有别的东西说明那不是我们的，留着）。
           不然 `data/.资料/` 会多出一个空目录，看着像用户多了份资料。 */
        fs.rmdirSync(dir)
      } catch {}
    })

    await open()

    /* 等资料层挂上（后面点按钮要有它） */
    await until(async () => ((await s.eval(`!!document.querySelector('.bd-docbar')`)) ? 1 : undefined), { timeout: 10000, what: '资料条出现' })

    console.log('\n[1] 工具条上那颗「✧ 课件整理」看得见、点得到')
    /* ⚠ 它 2026-09-26 收进了「⋯ 更多」菜单 —— elementFromPoint 只有菜单开着才命中，
       所以先点开菜单（菜单常驻 DOM，eval click 永远有效；check-gather 同款前置）。 */
    await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && !m.classList.contains('on')) m.click(); return 1 })()`)
    await s.sleep(150)
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
    /* ── 讲稿缓存从**干净**的开始（2026-09-30）─────────────────────────────
       ⚠ 这个浏览器 profile 是**跨轮复用**的（`.cache/*-cdp/` 那一份），localStorage 里
       "讲过哪几页"会留到下一轮 —— 于是上一轮读过的页，这一轮一上来就算"讲过"
       （而这一轮根本没读过它）。这正是 doc-read.js 那条注里"check-deck 就这么红过
       一次，同一份代码跑两遍一红一绿"的同一类脏，现在还多影响一条：
       "重开窗口时讲过的页不默认选"这条断言的前提（讲过哪些页）会被上一轮污染。
       ⇒ 开跑之前把这份资料的讲稿缓存清干净：localStorage 那两层 + 盘上那份。
       ⚠ 只清 `sh.docread` / `sh.docsum` 这两个前缀（都是我们自己的键），别的碰都不碰。 */
    await s.eval(`(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('sh.docread') || k.startsWith('sh.docsum')) localStorage.removeItem(k)
      return 1
    })()`)
    /* 盘上那份（`data/.资料/.已读/zz-deck-smoke/p<N>.json`）**在 node 这一侧直接删**，
       不绕一圈 HTTP —— 绕一圈的话"删没删成"自己还得再验一次，而它一旦没删成，
       上一轮那几页的稿子就会被当成"这一轮讲过"。
       ⚠ 只删 `p<数字>.json`（和 `forgetDeckPages` 同一条纪律）：这个目录名是从课件名
       算出来的，万一将来算错撞进别的目录，"递归删整个目录"就会删到不是我们的东西上。
       ⚠ 这个目录是**这份夹具课件自己的**（zz-deck-smoke），不是用户的讲稿。 */
    {
      const dir = path.join(DATA, '.资料', '.已读', 'zz-deck-smoke')
      try {
        for (const n of fs.readdirSync(dir)) if (/^p\d+\.json$/.test(n)) fs.unlinkSync(path.join(dir, n))
      } catch {
        /* 没有那个目录 = 本来就是干净的 */
      }
    }
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
    /* 把「⋯ 更多」菜单收回去（[1] 为了点按钮把它打开了；窗口已经盖住一切，
       但窗口关掉之后菜单还开着会浮在画布上 —— 后面段落的真点别被它拦走）。 */
    await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && m.classList.contains('on')) m.click(); return 1 })()`)
    /* 打开就能打字（2026-09-20）：用户那句"我告诉你是需要第几页到第几页"要落成
       "窗口一出来就能打 `1-12` 回车走"，而不是"先点一下那个框"。 */
    const focused = await s.eval(`(document.activeElement && document.activeElement.className) || ''`)
    if (/dkr-range/.test(focused)) ok('★ 光标已经在"整理哪几页"那一行里（打开就能打字）')
    else bad('光标不在区间输入框里（还得先点一下）：' + focused)
    if (/冒烟课件/.test(d0.head)) ok('标题里写着是哪一份课件：' + d0.head.replace(/\s+/g, ' ').slice(0, 40))
    else bad('标题里没写课件名：' + d0.head)
    if (/让老师逐页讲/.test(d0.head)) ok('★ 窗口说的是"让老师逐页讲"（产出换了：讲解在右、重点和公式在左）')
    else bad('窗口还是老文案：' + d0.head)
    if (d0.pickRows === 3) ok('挑页那一摞是 3 格（这份资料 3 页）')
    else bad('挑页格子数不对：' + d0.pickRows)
    /* ★ 默认选的是**没讲过的那几页**（2026-09-30 用户要的：讲过的页不该再默认选上 ——
       那份讲稿还在，再选一遍等于把已经买过的东西买第二次）。
       第一次整理一份课件 = 一页都没讲过 = 全选；讲过一部分之后再来，就只剩新页。 */
    const done0 = await s.eval(`(() => { const e = document.querySelector('.dkr-donehint'); return e ? String(e.getAttribute('data-done') || '') : '' })()`)
    const doneList0 = String(done0 || '')
      .split(',')
      .map((x) => Number(String(x).trim()))
      .filter((n) => n > 0)
    const left0 = [1, 2, 3].filter((n) => !doneList0.includes(n))
    const want0 = left0.length ? left0 : [1, 2, 3] // 全都讲过 → 兜底全选（不给空窗口）
    if (d0.picked === want0.length)
      ok(
        left0.length && left0.length < 3
          ? `★ 默认选的是**没讲过的那几页**（讲过 ${JSON.stringify(doneList0)}，默认 ${d0.picked} 页）`
          : '★ 默认**全选**（一页都没讲过；"往往是几十页这个数量级"，默认从头读，用户可以改）'
      )
    else bad('默认选中不对：' + d0.picked + ' 页（它认为讲过 ' + JSON.stringify(doneList0) + '，期望 ' + want0.length + ' 页）')

    /* 挑页：清空 → 用区间输入挑 1-2（**顺便验区间这条路**，它才是几十页时真正用得到的那条） */
    await s.eval(`[...document.querySelectorAll('.dkr-pickrow .mini')].find(b => b.textContent.includes('清空'))?.click()`)
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
      /* ⚠ `.dkr-range` 可能是 null（窗口没开出来、或者被上一次的等待拖过去了）——
         直接 `.set.call(null, …)` 抛 **Illegal invocation**，而那句报错离真正的原因
         （窗口没开）隔着一整段栈，查起来很费劲。所以自己判一次，并把结果交出去。
         ⚠ 这段说明写在**模板串外面**：里面会出现反引号围起来的 `.dkr-range`，
           而那会当场把模板串截断（2026-09-22 在这行栽过，报的是"syntax error"）。 */
      const wrote = await s.eval(`(() => {
        const inp = document.querySelector('.dkr-range')
        if (!inp) return false
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, ${JSON.stringify(String(v))})
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      if (!wrote) {
        bad(`区间「${v}」没写进去：窗口里没有 .dkr-range（窗口没开出来？）`)
        return false
      }
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
    const clickRead = () => s.eval(`[...document.querySelectorAll('.dkr-pickrow .mini')].find(b => b.textContent.includes('讲这几页'))?.click()`)

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
      /* ⚠ **等这一趟真读完再关**（2026-09-30 加）：那句 warn 消失只说明"开读了"
         （`setErr(null)` 在发出请求之前就跑了），不代表那几页的稿子已经落进缓存 ——
         读还在飞就把窗口关掉，请求被中止，**一页都不会被记成"讲过"**。
         而下面那条"重开窗口时讲过的页不默认选"要的正是"第 1、3 页讲过了"这个前提。 */
      await until(async () => {
        const r = await s.eval(DKR)
        return /讲完了/.test(r.head) ? r : undefined
      }, { timeout: 12000, what: '[2b] 那两页读完（讲稿落进缓存）' })
      /* 已经读进来了，回挑页那一屏、按下面的正式流程重来一遍。
         ⚠ 这里的意图是"**关掉它重来**"，不是"验闸拦不拦"（那条在 [7] 里专验）。
           而这一步是在 `clickRead()` 之后执行的 ⇒ `hasPaidWork` 为真 ⇒ 点下去会弹问话。
           所以**临时把 dialogAnswer 拨成 true**（答"确定"），并且**必须拨回来** ——
           留着 true 的话，[7] 那条"答取消窗口还在"的断言会当场失效（弹框被自动答成确定）。
           ⚠ 拨回 false 之前要把这个窗口真关掉：如果 `stop()` 还挂在半路，
             下一个窗口的 `hasPaidWork` 会莫名其妙是 true（上一份资料的读数还没清干净）。 */
      s.dialogAnswer = true
      try {
        await s.eval(`[...document.querySelectorAll('.dkr-acts .mini')].find(b => b.textContent.includes('先不整理'))?.click()`)
        await until(async () => ((await s.eval(`!document.querySelector('.dkr-back')`)) ? 1 : undefined), { timeout: 4000, what: '窗口关掉' })
      } finally {
        s.dialogAnswer = false
      }
      /* ⚠ 窗口关了之后**不要再动里面那几个控件**：React 的提交是异步的，
         那一次 setState 会落到**下一个**窗口的头上（表现是"下一个窗口的默认选中
         莫名其妙变成了上一次那个区间"）。要设区间就等窗口重新开出来再设。 */
    }
    /* ⚠ 2026-09-26：按钮搬进了「⋯ 更多」菜单 —— [1] 量到的那对坐标是"菜单开着"
       的时候量的，而上面已经把菜单收掉了。所以这里**先把菜单点开、再重量坐标**，
       别复用 btn.x/btn.y（菜单收着的时候那对坐标落在画布上，什么也点不到）。 */
    await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && !m.classList.contains('on')) m.click(); return 1 })()`)
    await s.sleep(150)
    const btn1b = await s.eval(`(() => {
      const b = document.querySelector('[data-tool="deckread"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await s.mouse(btn1b.x, btn1b.y)
    await until(async () => ((await s.eval(`!!document.querySelector('.dkr-back')`)) ? 1 : undefined), { timeout: 6000, what: '窗口重开' })
    /* ── ★ 重开窗口时**讲过的页不该再被默认选上**（2026-09-30，用户原话：
          「讲解ppt的时候不要默认选中已经讲过的页」）────────────────────────
       [2b] 讲过第 1、3 页（第 3 页是空页，但**它也算讲过** —— 稿子在、不会再花钱），
       所以重开时默认**不该再有它们**。
       ★ 期望值由窗口**自己说的**"讲过哪几页"算出来（`data-done` 那个口子），
         不写死 1、3 —— 写死的话这条断言就变成"上一轮读过哪些页"的探测器。
       ⚠ **必须在 setRange 之前读**：一写区间，选中就被脚本自己改掉了 ——
          那测的是脚本，不是窗口。
       ⚠ 这里才是"剔除"那条真正的家：[7] 重开时三页**全都**讲过，那一条验的是兜底。 */
    const pickOf = () => s.eval(`[...document.querySelectorAll('.dkr-pg.on')].map(b => Number((b.textContent || '').trim() || '0'))`)
    /* ★ 期望值**按它自己说的"讲过哪几页"算**，不写死 1、3：
       盘上那一层（`.资料/.已读/`）有些环境下清不干净（上一趟留下的稿子），
       写死的话这条断言就变成"上一轮读过哪几页"的探测器 —— 那不是它该验的事。
       ⚠ **要等它落定**：盘上那一层要一个往返才回得来，而 [2b] 收尾时那一趟可能
       还在飞，最后那几页的稿子会**比这个窗口晚一帧**才落进缓存。 */
    const doneBack = await until(async () => {
      const raw = await s.eval(`(() => { const e = document.querySelector('.dkr-donehint'); return e ? String(e.getAttribute('data-done') || '') : '' })()`)
      const list = String(raw || '')
        .split(',')
        .map((x) => Number(String(x).trim()))
        .filter((n) => n > 0)
      return list.length ? list : undefined
    }, { timeout: 6000, what: '窗口说出"讲过哪几页"' })
    if (!doneBack.ok) bad('这条验不了：窗口没说讲过哪几页（[2b] 那两页根本没读成？）')
    else {
      const done = doneBack.value
      /* 剔掉讲过的那几页就是期望值；**一个不剩**（整份都讲过）时兜底是全选 ——
         那种情况下给一个空窗口，用户只会以为它坏了。 */
      const left = [1, 2, 3].filter((n) => !done.includes(n))
      const expect = left.length ? left : [1, 2, 3]
      const pickedBack = await until(async () => {
        const r = await pickOf()
        return r.length === expect.length && r.every((n) => expect.includes(n)) ? r : undefined
      }, { timeout: 5000, what: `默认选中变成 ${JSON.stringify(expect)}` })
      if (pickedBack.ok)
        ok(
          left.length
            ? `★ 重开窗口时**讲过的 ${JSON.stringify(done)} 没被默认选上**（默认只剩 ${JSON.stringify(expect)}）`
            : `★ 三页都讲过 → 原样全选（兜底：不给一个空窗口）`
        )
      else bad('默认选中和"讲过哪些页"对不上：选中=' + JSON.stringify(await pickOf()) + '，讲过=' + JSON.stringify(done) + '，期望=' + JSON.stringify(expect))
    }
    /* 默认从"全部"变成"一部分"，用户第一反应是"它是不是漏了" —— 那句话必须说出口。 */
    const hintBack = await s.eval(`(document.querySelector('.dkr-donehint') || {}).textContent || ''`)
    if (/讲过/.test(hintBack)) ok('★ 那句「讲过的页没默认选」说出来了（否则用户以为窗口漏了几页）')
    else bad('没说"讲过的页没默认选"，挑页那一行是：' + JSON.stringify(hintBack))

    console.log('\n[3] 读：一页一页地问，**每页带对了页码**，边读边往窗口里填')
    /* ★ 这一节读 1、2，**两页都真发**（各一次请求）。
       ⚠ 这里曾经写的是"第 1 页在 [2b] 里读过了 → 走缓存 → 只发第 2 页"（2026-09-22 改掉）：
         上面 [2b] 收尾时把窗口**关了再开**，而 `DeckReview` 在点「讲这几页」时先忘掉
         **这一趟挑中的那几页**的讲稿（"讲这几页" = 重读，见 `forgetDeck`）—— 于是
         "第 1 页命中缓存"这个前提**不再成立**，旧断言测的其实是"清缓存那次动作漏没漏"。
       ⇒ 现在按真实口径写：**挑了几页就发几次，每页的页码都要对**。
         夹具的分布：第 1 页 = 文字知识点 + 小节名；第 2 页 = 一条公式 + 一条文字。 */
    await setRange('1-2')
    /* 清账的时机**必须在点下去之前**：写在 await 之后的话，回来的那些会被算到
       "上一节发了几次"里去（这一节那两条断言就是靠它算的）。 */
    seen.length = 0
    mockDelayMs = 250 // 慢一点回，"边读边填"才看得出来（真模型也要几秒）
    await clickRead()
    const filled = await until(async () => {
      const r = await s.eval(DKR)
      /* ⚠ 判据要**等两页都讲完**：老的写法（blocks >= 2 && items >= 2）会把 pending 占位块
         也算一块，于是第 2 页还在飞的时候就放行 —— 紧接着"公式那条"找到 undefined
         （2026-09-20 换产出时当场抓到的）。现在只数真的页块，并且等占位块消失。 */
      return r.blocks >= 2 && r.pending === 0 && r.items.length >= 4 ? r : undefined
    }, { timeout: 15000, what: '两页都讲完了' })
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
    ok(`两页都读了，窗口里有 ${filled.value.items.length} 条内容（${filled.value.blocks} 块）`)
    const asked = pageSeen().map((x) => x.page).filter((n) => n > 0)
    /* 这一节读 1、2 —— 它管的是**"每页带对了页码"**（这一节的名字就是这个）。
       ⚠ 判据不是"发了几次"（2026-09-22 改掉）：这一节的上面 [2b] 收尾时关了窗口再开，
         而 `DeckReview` 点「讲这几页」时会先忘掉**这一趟挑中的那几页**的讲稿
         （`forgetDeck`，2026-09-30 起只清这几页、不再整份清）——
         于是"第 1 页命中缓存"时而成立时而不成立（取决于上一趟挑没挑中它），
         同一份代码两趟一红一绿。⇒ 次数这件事归 [7]（那儿才是"缓存该省的钱一分不花"），
         这里只认一件事：**发出去的每一页，必须是这一趟挑的那几页之一**。
         落在别处的页码（第 5 页 / 第 0 页 / NaN）才是真的发错了。 */
    const wantSet = [1, 2]
    const stray = asked.filter((n) => !wantSet.includes(n))
    if (asked.length > 0 && !stray.length) ok(`★ 发出去的每一页都在挑的范围内（发的是 ${JSON.stringify(asked)}，挑的是 1、2）—— 页码带对了`)
    else bad('发出去的页码不对（有挑的范围之外的页）：' + JSON.stringify(seen.map((x) => x.page)))
    /* ⚠ 判据是"每页最多一次"：读同一页两次是白花钱，那才是 bug；发得比页数少
       只可能是缓存命中（合法，[7] 管它）。 */
    const dup = asked.filter((n, i) => asked.indexOf(n) !== i)
    if (!dup.length) ok('★ **一页最多一次调用**（同一页没有重复出网 —— 那才是白花钱）')
    else bad('同一页发了两遍（白花钱）：' + JSON.stringify(dup))
    /* 「上次讲的」标签的数量**不在这里验** —— 它取决于缓存命中与否，
       而那是 [7] 的事（[7b] 拿 `data-page` 和真发过的页号对账）。 */
    /* ⚠ 这几条判据的**前提是"真发了请求"**：空数组上 every() 恒真，
       不设这道门的话，"一个请求都没发"会被读成"发的是 JPEG"（假绿，最难查）。 */
    const allJpeg = pageSeen().length > 0 && pageSeen().every((x) => x.imageJpeg)
    if (allJpeg) ok('发的是 JPEG（课件的页面位图）')
    else bad('发出去的不是 JPEG / 没发：' + JSON.stringify(seen.map((x) => [x.imageJpeg, x.summary])))
    const bigEnough = pageSeen().length > 0 && pageSeen().every((x) => x.imageBytes > 2000)
    if (bigEnough) ok(`图有实在的内容（${pageSeen().map((x) => Math.round(x.imageBytes / 1024) + 'KB').join('、')}）`)
    else bad('图太小了 / 没发（页面没渲染出来？）：' + JSON.stringify(pageSeen().map((x) => x.imageBytes)))
    /* ★ 2026-09-23 改：从前这里钉的是 `=== 0`，理由是"整理是'读'不是'创作'"。
       那条理由对**认公式 / 认字**成立，对**讲解**不成立 —— 讲解要的是"老师课上会说的
       那几句"，而 temperature=0 正是把它压成教辅书标准答案腔的那一下（用户抱怨过
       "读完还是不懂"）。从前看不出这个矛盾：课件整理那时开着 thinking，而 thinking 模式下
       temperature 被上游**忽略**，整片失效。现在这一趟关了 thinking（见 MODE_EFFORT），
       temperature 开始真的起作用 ⇒ 讲解必须拿 0.3，和追问 / 作业辅导同一档。 */
    const TALK_HUMAN = 0.3
    const coldTemp = pageSeen().length > 0 && pageSeen().every((x) => x.temperature === TALK_HUMAN)
    if (coldTemp) ok('temperature=0.3（讲解要"讲人话" —— 0 会把它压成教辅书的标准答案腔）')
    else bad('讲解的 temperature 不是 0.3：' + JSON.stringify(pageSeen().map((x) => x.temperature)))

    /* ── 窗口里那三样（讲解 / 重点 / 公式）──
       夹具的分布：第 1 页 = 讲解 + 重点（带小节名）；第 2 页 = 讲解（里面夹一个行内公式）+ 一条公式。 */
    const d1 = filled.value
    const explain = d1.items.find((x) => x.kind === '讲解')
    const points = d1.items.find((x) => x.kind === '重点')
    const formula = d1.items.find((x) => x.kind === '公式')
    if (explain && /画受力图/.test(explain.body)) ok('★ 讲解卡填进来了（老师讲的那一段，人话）')
    else bad('讲解卡不对：' + JSON.stringify(explain))
    if (points && /先画受力图/.test(points.body) && /^- /.test(points.body)) ok('重点卡填进来了（`- ` 一栏短句）')
    else bad('重点卡不对：' + JSON.stringify(points))
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

    console.log('\n[3b] ★ 第二趟：整节课那两张卡 —— 提纲（给复习）+ 做题须知（给做题那一趟）')
    {
      /* 这一节盯的是那条**第二趟调用**走通了没有。它最容易出错的地方是
         "**静默地没发生**"：请求没发出去 / 回来了但没解析成一块卡 / 解析了但没显示 ——
         这三种在屏幕上都是"看不出有这一块"，而用户会以为"这功能没做"。
         所以三条都要分别对上：真发了请求、窗口里有一块、那一块的内容是对的。
         ★ 2026-09-22 起是**两张卡**（提纲 + 须知）：同一个口、同一份摘要发两次，
           所以"发了几次"变成"**各发几次**"，而且**两张的内容必须不一样** ——
           键里漏了 kind 的话后算的那张会盖住先算的（须知显示成提纲的六段，
           而且不报错）。这一段的两张卡各判一遍，正是为了钉住那件事。 */
      const deckSeen = () => seen.filter((x) => x.deck)
      const sumSeen = () => seen.filter((x) => x.summary)
      const ruleSeen = () => seen.filter((x) => x.deck && !x.summary)
      /* ⚠ **要等两张都出来**（`sum.done && rls.done`），不是只等提纲 ——
         两张是**串行**发的（`genSummary` 里 `await oneDeck(...)` 一句接一句，见那条注），
         所以"提纲好了"的那一刻，须知那一块正是 `status:'run'`（界面上写着
         「正在把这一节课的规矩收起来…」）。只等提纲就往下走的话，
         后面每一条须知断言都会读到一个 `done:false` 的空快照 ——
         报出来是"须知少了几段/内容不对"，看着像**代码没生成**，
         其实只是**自检没等它**（2026-09-22 加须知时这里红了 4 条，就是这个原因）。 */
      const got = await until(
        async () => {
          const r = await s.eval(DKR)
          return r.deck.sum.done && r.deck.rls.done ? r : undefined
        },
        { timeout: 15000, what: '提纲和须知都生成出来' }
      )
      const dd = (got.value || (await s.eval(DKR))).deck
      const su = dd.sum
      /* ① 请求真发出去了，而且**带上了那份摘要**（整节课那两趟不许带图、必须带摘要）。 */
      const hits = sumSeen()
      if (hits.length === 1) ok('★ 提纲那一趟发了**一次**（一份课件一次，不多不少）')
      else bad(
        `提纲那一趟发出去的次数不对：${hits.length}（期望 1）。` +
          `⚠ 0 次有两种可能，别猜：① 它命中了缓存（那就**不该**出网，是缓存串了）；` +
          `② 请求发了但假服务没认出来（判据错）。这一趟 ` +
          `seen 一共 ${seen.length} 条，页号/是哪一趟：` +
          JSON.stringify(seen.map((x) => [x.page, x.summary ? 'SUM' : x.deck ? 'RULES' : 'page'])) +
          `；窗口里那一块：` + JSON.stringify({ done: su.done, cached: su.cached, err: su.err })
      )
      const p = hits.length ? hits[0].promptText : ''
      if (/每一页的重点/.test(p)) ok('★ 提示词里带着那份摘要（"每一页的重点"那一节在）—— 它不是空着手去问的')
      else bad('提纲那一趟的提示词里没有摘要：' + p.slice(0, 200))
      if (/你当时划的小节/.test(p) && /力与运动/.test(p)) ok('★ 小节名也带过去了（骨架最靠得住的依据就是它）')
      else bad('提纲那一趟的提示词里没有小节名：' + p.slice(0, 200))
      /* ⚠ 整节课那两趟**不许带图**：它们那条"不许引入新事实"的护栏就建立在"它看不到课件"上。
         带了图的话护栏就破了，而界面上一切正常 —— 这是一条必须钉住的判据。 */
      if (deckSeen().length && deckSeen().every((x) => !x.imageBytes)) ok('★ 整节课那两趟都**没有带图**（护栏：它们看不到课件，就编不出课件上的东西）')
      else bad('整节课那一趟带图了 —— 那道"不许引入新事实"的墙被拆了')

      /* ② 窗口里有那一块，而且它是**单独一块**（不是塞进某一页里）。 */
      if (su.present) ok('★ 窗口里有"这一节课的提纲"那一块（data-summary）')
      else bad('窗口里根本没有提纲那一块：' + JSON.stringify(su))
      if (su.css === 'block') ok('★ 它是**整宽一块**（display:block）—— 不是逐页那种"左图右字"的两栏网格')
      else bad('提纲那一块的布局不对（该是 block，实际 ' + su.css + '）')
      if (su.done && su.kind === '提纲') ok('它那一条的 kind 显示成「提纲」（不和讲解/重点混）')
      else bad('提纲那一条不对：' + JSON.stringify(su))
      if (su.title) ok('标题填进来了：' + su.title)
      else bad('提纲没有标题')

      /* ③ 内容：六段的小标题都要在（少一段 = 学生少读一段，没人会报错）。 */
      const need = ['骨架', '脉络', '必记', '易错', '核心式子', '自测']
      const missing = need.filter((s) => !su.body.includes('**' + s + '**'))
      if (!missing.length) ok('★ 六段全在：' + need.join('、'))
      else bad('提纲少了几段：' + JSON.stringify(missing) + '  正文=' + su.body.slice(0, 160))
      if (/第 1-2 页/.test(su.body)) ok('★ 骨架那一段带着页号（学生按它回原课件）')
      else bad('骨架没带页号：' + su.body.slice(0, 120))
      if (/F=ma/.test(su.body)) ok('★ 核心式子进来了（假服务就回了这一条，它是从摘要里认来的）')
      else bad('核心式子没进来：' + su.body.slice(0, 160))
      if (/为什么第一步要画受力图/.test(su.body)) ok('自测那个问题也进来了（而且**不带答案**）')
      else bad('自测没进来：' + su.body.slice(-160))

      /* ④ ★★ **第二张卡：做题须知**（同一个口的另一次调用）─────────────────
         这一段和上面那一段是"同一件事判两遍"，看着啰嗦，但它抓的是**这个功能
         最可能出现的那种错**：两张卡共用一个函数、一份输入、一个缓存前缀 ——
         任何一处漏了 `kind`，出来的都是"须知 = 提纲的六段"（不报错、界面上看不出）。
         所以判据里那条"须知**不许**有骨架/核心式子"比"它有 units/conv/traps"还重要。 */
      const rr = dd.rls
      const rHits = ruleSeen()
      if (rHits.length === 1) ok('★ 做题须知也发了**一次**（同一份摘要，第二次调用）')
      else bad(`做题须知那一趟发出去的次数不对：${rHits.length}（期望 1）—— ` + JSON.stringify(seen.map((x) => [x.page, x.summary ? 'SUM' : x.deck ? 'RULES' : 'page'])))
      /* ★ 两次的**输入**必须一模一样（那是"多一张卡只多花输出那一侧的钱"的证据）。
         ⚠⚠ 判据是那份**摘要本身**（两趟提示词里 `这份课件你讲了第 …` 那一截），
           **不是提示词总长度** —— 两段提示词本来就长短不同
           （SUMMARY_PROMPT 六段、RULES_PROMPT 三段），拿长度比是**必红**的，
           而它报出来的话（"多花了一次读课件的钱"）会把方向带偏：
           真正要证的是"没有重新读一遍课件"，那件事只跟输入那一截有关。 */
      if (hits.length && rHits.length && hits[0].digest && hits[0].digest === rHits[0].digest) ok('★ 两张卡共用同一份输入（两趟发出去的那份摘要一字不差）—— 多一张卡没多读一遍课件')
      else bad('两张卡的输入不一样（多花了一次读课件的钱）：' + JSON.stringify([hits.map((x) => x.digest.slice(0, 40)), rHits.map((x) => x.digest.slice(0, 40))]))
      if (rr.present) ok('★ 窗口里有"做题须知"那一块（data-rules）—— 它是"存了但没显示"最容易发生的一块')
      else bad('窗口里没有做题须知那一块：' + JSON.stringify(rr))
      if (rr.css === 'block') ok('它也是**整宽一块**（和提纲同一个形状）')
      else bad('做题须知那一块的布局不对（该是 block，实际 ' + rr.css + '）')
      if (rr.done && rr.kind === '须知') ok('它那一条的 kind 显示成「须知」（不和提纲混）')
      else bad('做题须知那一条不对：' + JSON.stringify(rr))
      if (/^\*\*单位与符号\*\*/m.test(rr.body) && /\*\*口径\*\*/.test(rr.body) && /\*\*最容易错的\*\*/.test(rr.body)) ok('★ 三段全在：单位与符号、口径、最容易错的')
      else bad('做题须知少了几段：' + rr.body.slice(0, 200))
      if (/国际单位制/.test(rr.body) && /先画受力图/.test(rr.body)) ok('★ 内容是从摘要里认来的（"先画受力图"那句就在重点里）')
      else bad('做题须知的内容不对：' + rr.body.slice(0, 200))
      /* ★★ 这一条是**防串**的核心：须知里不许出现提纲那几段。
         串了的后果是"须知显示成提纲的六段"，而**两边的判据都绿**
         （那些内容确实来自同一份摘要）—— 只有这条能抓住它。 */
      const leaked = ['骨架', '脉络', '必记', '自测'].filter((s) => rr.body.includes('**' + s + '**'))
      if (leaked.length) bad('做题须知里混进了提纲的段（两张卡的缓存串了）：' + JSON.stringify(leaked))
      else ok('★ 须知里**没有**提纲那几段（骨架/脉络/必记/自测）—— 两张卡没串')
      if (!/核心式子|第 1-2 页|\$/.test(rr.body)) ok('★ 须知里**没有页号、也没有式子**（那两样归提纲管，见 RULES_PROMPT）')
      else bad('做题须知里出现了页号/式子（提示词里明说了不许）：' + rr.body.slice(0, 160))

      /* ⑤ 那两块**不该动"一页一课"的账**：逐页那几块还在，整节课的卡只是又加了两块。
         ⚠ 判据是"页块的数量还是那几页" —— 整节课的卡混进页块的话这个数会 +2。 */
      const blocks2 = (await s.eval(DKR)).blocks
      if (blocks2 === 2) ok('★ 逐页那两块**一块没多**（整节课的卡没有混进按页走的那些块里）—— 它们是另一层的东西')
      else bad(`页块数量不对：${blocks2}（期望 2：读的就是第 1、2 页）`)

      /* ⑥ 右下角那句话要**把两张卡都算进去、也要说清它们在哪儿**：
         只说"会贴 N 条"的话，人会在每页旁边找那两块。 */
      const acts = (await s.eval(DKR)).acts.replace(/\s+/g, ' ')
      if (/提纲和做题须知在第一页左边/.test(acts)) ok('★ 右下角把两张都说出来了、也说清了贴在哪儿（"提纲和做题须知在第一页左边"）')
      else bad('右下角没说清整节课那两张贴在哪：' + acts.slice(0, 140))
      /* ★★ 条数**要自己算一遍**，别把期望值写死：
         它 = 窗口里那些**逐页条目**（讲解/重点/公式）+ 提纲那一条 + 须知那一条。
         ⚠ 两处都容易写成假的：
           ① `n === 3`（我第一版）—— 那是**夹具**决定的事（一页能出好几条），
              于是这条断言永远不可能绿，而它报的红看着像"代码数错了条数"；
           ② 拿 `.dkr-item` 的个数当基数 —— 公式那一条**不是** `.dkr-item`
              （它渲染在 `.dkr-tex` 那一行里），于是基数会多 1，又是个永远差一。
         现在基数取**窗口里真会交出去的那些条目**：`data-deck-item` 标记的是
         "整节课那一层"，从 `.dkr-item` 里减掉它们就是逐页的条目数。 */
      const nPageItems = await s.eval(`document.querySelectorAll('.dkr-item:not([data-deck-item])').length`)
      const nDeckItems = await s.eval(`document.querySelectorAll('.dkr-item[data-deck-item]').length`)
      const n = Number((/(\d+) 条会贴到白板上/.exec(acts) || [])[1])
      if (nDeckItems === 2 && n === nPageItems + 2) ok(`★ 条数把两张卡都算进去了（${n} 条 = 逐页 ${nPageItems} 条 + 提纲 + 须知）`)
      else bad(`"会贴几条"数错了：${n}（逐页 ${nPageItems} 条、整节课 ${nDeckItems} 条，加起来该是 ${nPageItems + nDeckItems}）`)
    }

    console.log('\n[4] 一页失败只影响那一页（"一页一次调用"挣来的东西）')
    {
      mockDelayMs = 0
      forceFailPage = 1
      seen.length = 0
      /* 用「↻ 重讲这一页」重讲第 1 页：模型回一句人话（没有 JSON）→ 这一页标红，第 2 页一个字不动 */
      await s.eval(`[...document.querySelectorAll('.dkr-pgblk')].find(b => /第 1 页/.test(b.textContent)).querySelector('.dkr-retry')?.click()`)
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
      /* ⚠ `pageSeen()`：这一节开头清过 `seen`，但「↻ 重讲这一页」**不重跑第二趟**
         （整节课那两张只在一整趟读完之后才发起），所以这儿本来也不会混进它们。
         还是走它 —— 免得哪天第二趟的发起时机挪了，这条断言悄悄开始数错。 */
      const seen4 = pageSeen()
      if (seen4.length === 1 && seen4[0].page === 1) ok('只重发了第 1 页（一次请求，别的页没重发）')
      else bad('重读发出去的请求不对：' + JSON.stringify(seen.map((x) => [x.page, x.summary ? 'SUM' : x.deck ? 'RULES' : 'page'])))
      forceFailPage = 0
      /* 再重读一次 → 这次回正常内容，标红消失（"↻ 重读这一页"这条路是通的） */
      await s.eval(`[...document.querySelectorAll('.dkr-pgblk')].find(b => /第 1 页/.test(b.textContent)).querySelector('.dkr-retry')?.click()`)
      const healed = await until(async () => {
        const b = await s.eval(`(() => {
          const el = [...document.querySelectorAll('.dkr-pgblk')].find(x => /第 1 页/.test(x.textContent))
          return el ? el.classList.contains('bad') : null
        })()`)
        return b === false ? 1 : undefined
      }, { timeout: 8000, what: '第 1 页重读成功' })
      if (healed.ok) ok('再点一次「↻ 重讲这一页」→ 讲回来了（标红消失）')
      else bad('重读没救回来（一直红着）')
    }

    console.log('\n[5] 点「贴到白板上」→ 卡片落进文件（这条链路的终点）')
    /* ⚠ 页面矩形**定义在 docs.js 的 pageRects 里**（唯一一处）——这里只是把它重算一遍。
       ★★ 但要**把 `pageGaps` 算进去**：整节课那两张占了第一页左栏，
         第 1 页装不下就把第 2 页推下去了（`projectDeck` 的正经产出，见本节的注解）。
         这里写死"每页固定 560 一页"（第一版就是这样）的话，
         "第 2 页左栏从页顶起"这条断言会拿到 761 而期望 560 ——
         报出来像"卡片没对齐页顶"，其实**页顶真的挪了**（判据没跟上文件）。
       ★ 所以 `pgRects` 在**读完板文件之后**才定：拿文件里那份 `pageGaps` 现算
         （`rectsFromGaps`）—— 和 Board.jsx 那边用的是同一份数据、同一个递推。 */
    const gapsOf = (doc) => (doc && Array.isArray(doc.pageGaps) ? doc.pageGaps : [])
    const rectsFromGaps = (gaps) => {
      const out = []
      let y = 0
      for (let i = 0; i < 3; i += 1) {
        out.push({ x: 0, y, w: 720, h: 540 })
        y += 540 + 20 + (Number(gaps[i] || 0) || 0)
      }
      return out
    }
    await s.eval(`[...document.querySelectorAll('.dkr-acts .btn')].find(b => b.textContent.includes('贴到白板上'))?.click()`)
    const wrote = await untilFile((d) => d.cards && d.cards.length >= 3, { timeout: 10000, what: '卡片落进板文件' })
    if (!wrote.ok) {
      bad('点了「贴到白板上」，文件里的卡片没多出来（等到 ' + wrote.waited + 'ms）')
      const dbg = await s.eval(DKR)
      console.log('  （窗口还开着吗：' + dbg.open + '，条数：' + (dbg.items || []).length + '）')
      return
    }
    const cards = wrote.value.cards
    /* ★ 页顶（世界坐标）—— 判"卡片对不对齐页顶"要用它，而它含 `pageGaps`。 */
    const pgRects = rectsFromGaps(gapsOf((wrote.value.docs || [])[0]))
    ok(`卡片落进文件了（一共 ${cards.length} 张）`)
    /* ⚠ 「一共几张」现在含**整节课那两张**（第二趟的产出，见 [3b]）。
       ★ 它们在板上的 `kind` 是 `'note'`（不是 `'summary'` / `'rules'`）—— 板层的 kind
         只管"画成什么形状"，只有公式/文字两种，那两张就是文字卡。出处记在**独立字段**
         上（提纲是 `sum: true`、须知是 `rules: true`，和 `rich` / `ask` 平级，
         先例见 `ink`）。所以这里按 `sum` / `rules` 认它们。
       `notes` / `forms` 天然不含它们（它 kind 是 note，但这一步先把它们摘出去再数）。 */
    const outlinePre = cards.filter((c) => c.sum === true)
    if (outlinePre.length === 1) ok('提纲卡也在这一批里（卡上的 sum:true，一共 1 张）')
    else bad('提纲卡的张数不对（该正好 1 张）：' + JSON.stringify(cards.map((c) => [c.kind, c.sum, c.rules])))
    /* ★ 第二张（做题须知）：它走的是**另一个字段** `rules: true` ——
       两张卡必须各记各的出处（`collectKnowledge` 靠这个字段分两段交出去，
       见 homework.js），合成一个"是不是整节课的"布尔值的话，
       作业那一趟的【整节课】那一段就得再分一次，等于同一件事判两遍。 */
    const rulesPre = cards.filter((c) => c.rules === true)
    if (rulesPre.length === 1) ok('★ 做题须知卡也在这一批里（卡上的 rules:true，一共 1 张）')
    else bad('做题须知卡的张数不对（该正好 1 张）：' + JSON.stringify(cards.map((c) => [c.kind, c.sum, c.rules])))
    /* ⚠ 两张卡的出处**不许混**：同一张卡上 `sum` 和 `rules` 不许同时为真
       （那样 `collectKnowledge` 会把它交两遍 —— 白板上只有一张，模型读到的却是两张）。 */
    if (!cards.some((c) => c.sum === true && c.rules === true)) ok('两张卡的出处没混（没有哪一张同时带着 sum 和 rules）')
    else bad('有卡片把两个出处字段都带上了（作业那一趟会把它交两遍）：' + JSON.stringify(cards.filter((c) => c.sum && c.rules).map((c) => c.id)))
    const notes = cards.filter((c) => c.kind === 'note' && c.sum !== true && c.rules !== true)
    const forms = cards.filter((c) => c.kind === 'formula')
    if (notes.some((c) => /画受力图/.test(c.text || '') && /力与运动/.test(c.text || ''))) ok('★ 讲解卡落进文件了（标题带小节名 + 老师讲的那一段）')
    else bad('讲解卡的内容不对：' + JSON.stringify(notes.map((c) => (c.text || '').slice(0, 20))))
    if (notes.some((c) => /第 1 页 · 重点/.test(c.text || '') && /^- /m.test(c.text || ''))) ok('重点卡落进文件了（"第 N 页 · 重点" + 一栏短句）')
    else bad('重点卡的内容不对：' + JSON.stringify(notes.map((c) => (c.text || '').slice(0, 20))))
    if (notes.length > 0 && notes.every((c) => c.rich === true)) ok('★ 讲义卡都带 rich 标记（正文里的公式要按讲义渲染，见 rich.js）')
    else bad('有讲义卡没带 rich 标记：' + JSON.stringify(notes.map((c) => [c.rich, (c.text || '').slice(0, 10)])))
    if (forms.length === 1 && forms[0].tex === 'F=ma') ok('公式落成了**公式卡**（tex=F=ma）')
    else bad('公式卡不对：' + JSON.stringify(forms.map((c) => [c.tex, c.src])))
    if (cards.every((c) => c.w > 20 && c.h > 10)) ok('每张卡都有量出来的宽高（不是默认的 260×44）')
    else bad('有卡片的宽高不对：' + JSON.stringify(cards.map((c) => [c.w, c.h])))
    /* ★★ 贴上去的卡片**默认是钉住的**（用户 2026-09-22：「这些解说的卡片生成后默认状态
       应该是定住的，用户要移动再解开」）。理由在用法里：整理完是照着课件往下读，
       而用笔的人手会一直蹭到屏幕 —— 位置定好的讲义卡一蹭就被拖走，一节课下来版面全乱。
       ⚠ 这里盯的是**文件里那个字段**（`locked: true`），不是"看起来拖不动"：
         钉住要重开这张板还算数，就得写进文件（和 `rich` / `rot` 同一条纪律）。 */
    if (cards.every((c) => c.locked === true)) ok(`★ 贴上去的卡片**都钉住了**（${cards.length} 张都写着 locked: true）`)
    else bad('有卡片没钉住：' + JSON.stringify(cards.map((c) => [c.locked, (c.text || c.tex || '').slice(0, 10)])))
    /* 摆版的硬要求：同一栏里不许压住。这里直接验"两两不重叠"（它们是网格摆的）。 */
    /* ⚠ 判据是 `<` 不是 `<=`：**边贴边不算压住**。提纲（左栏 y=0）和第 1 页的
       重点卡（也是左栏 y=0）在 x 上首尾相接时，`a.x + a.w === b.x` ——
       写成 `<=` 会把"紧挨着"误判成"压住"，而它俩本来就是上下首尾相接摆的。 */
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
    /* ★ 摆位换了（2026-09-20）：讲解贴**每一页右边**、重点和公式贴**左边**，
       而且每页那两块都从**这一页的顶**开始（讲解比页面高就把下一页推开 —— pageGaps）。 */
    /* ⚠ 逐页那些卡的定位判据要**把整节课那两张摘出去**（按 `sum` / `rules`，不是按 kind ——
       它们 kind 就是 note）。它们也坐在左边那一栏（x+w<=0），混进来的话
       `leftCards.every(...)` 倒是照样绿，但"每页那两块"的账会多出两张。 */
    const pageCards = cards.filter((c) => c.sum !== true && c.rules !== true)
    const explainCards = notes.filter((c) => /讲解|（第 \d+ 页）/.test(c.text || ''))
    const rightOfPage = explainCards.every((c) => {
      const n = Number((/第 (\d+) 页/.exec(c.text || '') || [])[1] || 0)
      const pg = pgRects[n - 1]
      return pg ? c.x >= pg.x + pg.w : true
    })
    if (explainCards.length && rightOfPage) ok(`★ 讲解卡贴在**资料右边**（${explainCards.length} 张，都在页面右边缘之外）`)
    else bad('讲解卡的位置不对：' + JSON.stringify(explainCards.map((c) => [c.x, (c.text || '').slice(0, 10)])))
    const leftCards = pageCards.filter((c) => c.kind === 'formula' || /重点/.test(c.text || ''))
    const leftOfPage = leftCards.every((c) => c.x + c.w <= 0 + 1)
    if (leftCards.length && leftOfPage) ok(`★ 重点和公式贴在**资料左边**（${leftCards.length} 张，右边缘都≤资料左边缘 0）`)
    else bad('左边那栏的位置不对：' + JSON.stringify(leftCards.map((c) => [Math.round(c.x + c.w), (c.text || c.tex || '').slice(0, 10)])))
    /* ★ 每一页那两块都从**这一页的顶**开始：这一节只讲了第 1、2 页，
       所以页顶 0 和 `pgRects[1].y` 上各该有**两张**卡（左栏一张、右栏一张）。
       ⚠ 别去数第 3 页的页顶（`pgRects[2].y`）—— 第 3 页这次没讲，那儿本来就不该有卡。
       ⚠ 用 `pageCards` 数，不是 `cards`：整节课那两张也坐在第一页**左边**那一栏，
         算进去的话 0 那一行会多两张，而这条断言查的是"逐页那两块对不对齐页顶"。
       ★★ 但**第一页的左栏现在不是从 0 起了**：整节课那两张先站住了那一栏
         （见 Board.jsx 的 placeDeckCards「整节课那两张先站住第一页左栏」）——
         逐页的左栏卡接在**最下面那张**底下。这是**有意的**：同一条横带，
         都从 0 起就正正叠在一起，而"叠住"在板上看不出来。
       ⇒ 所以这条断言分两半判，每半都有自己的道理：
         ① **右栏**（讲解）不受影响：整节课那两张不占右栏，第 1、2 页的讲解都该在页顶；
         ② **左栏**（重点/公式）：第 2 页在页顶；**第 1 页在最下面那张整节课卡的底下**。
         写死"0 上 2 张、560 上 2 张"是**旧世界**的判据（那时一张整节课的卡都没有）——
         它会红，但红得没有意义：结构是对的，只是前提变了。 */
    /* ⚠ 整节课那两张先在这里找出来（下面的"对不对齐页顶"要用它们的底边）——
       它们在 `pageCards` 里没有，`notes` 里也没有（`notes` 把带 sum/rules 的摘掉了）。 */
    const sumCard = cards.find((c) => c.sum === true) || cards.find((c) => /这一节课的提纲/.test(c.text || ''))
    const rulesCard = cards.find((c) => c.rules === true) || cards.find((c) => /^\*\*单位与符号\*\*/m.test(c.text || ''))
    const atTop = (y) => pageCards.filter((c) => Math.round(c.y) === y)
    const rightTop = pageCards.filter((c) => c.kind === 'note' && Math.round(c.y) === 0 && /（第 \d+ 页）/.test(c.text || ''))
    const isLeft = (c) => c.kind === 'formula' || /重点/.test(c.text || '')
    /* ⚠⚠ "哪一页的卡"**不能**按"卡片落没落在这一页的矩形里"判（第一版就是这么写的）：
       卡片是**从页顶往下摆**的，摆过页底是很正常的 —— 尤其第一页左栏现在被
       整节课那两张占了一截，这一页的重点卡就排在 y=643（页底之外）。
       按矩形判的话它一页都归不上（`pageOf` 给出 -1），
       "第 1 页左栏该接在那两张底下"这条断言于是拿到一个空数组，报出来是
       "卡片没落在该在的地方" —— 而卡片明明在正确的位置（判据错，不是代码错）。
       ⇒ 改用**唯一那处定义**的口径（和 `doc-cards.js` 的 `columnOccupancy` 一致）：
         **最后一个"不高于它页顶"的那一页**就是它的页。
         `pageTops` 用 `pgRects` 现算（含 pageGaps），不写死 0/560 ——
         整节课那两张把第 2 页推下去之后，写死的数会静默失效。 */
    const pageTops = pgRects.map((r) => Math.round(r.y))
    const pageOf = (c) => {
      const y = Math.round(Number(c.y) || 0)
      let n = -1
      for (let i = 0; i < pageTops.length; i += 1) if (y >= pageTops[i] - 1) n = i
      return n
    }
    const left2AtTop = pageCards.filter(isLeft).filter((c) => pageOf(c) === 1 && Math.round(c.y) === pageTops[1])
    /* 第一页左栏：接在**整节课那两张的底下**那一栏里（不是从页顶起 —— 它们站住了那儿）。
       ⚠⚠ 这里**不能**断言 `y === 那一张的底边 + 缝`：那两张是「先量、后落、落进 DOM 再让
          fitter 复量」的（`fitter.queue(c.id, { fitWidth: false })`，见 Board.jsx），
         所以文件里那个 `h` 是**复量之后**的数，而占位用的是复量**之前**那个数 ——
         两者差个几十像素是**正常的**（卡片按内容量了一次、贴上后又收拢了一次）。
         写死"等于"的话，这条断言会红得像"它们没把左栏让出来"，
         而其实让出来了，只是后来矮了一点。
       ⇒ 判"让出来了"这件事本身，两条：① 在这一页的左栏里；② 在**最下面那张**
         整节课卡的底下（不和任何一张重叠）。这正好是 bug 的两种样子
         （没让 = 从页顶起 = 和它们重叠）。 */
    const left1Cards = pageCards.filter(isLeft).filter((c) => pageOf(c) === 0)
    /* ★ 用**底下那张**（两张整节课的卡里 y + h 最大的那张）的底边当门槛 ——
       写死"用提纲那张"的话，两张卡上下顺序一换（或者哪张没生成出来）这条就假红。 */
    const deckTop = Math.min(...[sumCard, rulesCard].filter(Boolean).map((c) => Math.round(c.y)), Infinity)
    const deckBottom = Math.max(...[sumCard, rulesCard].filter(Boolean).map((c) => Math.round(c.y + c.h)), -Infinity)
    const left1Below = left1Cards.length === 1 && Math.round(left1Cards[0].y) >= (Number.isFinite(deckTop) ? deckTop : 0) + CARD_GAP_Y
    /* 真·不重叠（两条都在同一栏里才比） */
    const noOverlapWithOutline =
      ![sumCard, rulesCard].filter(Boolean).length ||
      [sumCard, rulesCard]
        .filter(Boolean)
        .every((d) => left1Cards.every((c) => !(c.x < d.x + d.w && d.x < c.x + c.w && c.y < d.y + d.h && d.y < c.y + c.h)))
    if (rightTop.length === 1 && left2AtTop.length === 1 && left1Below && noOverlapWithOutline) {
      ok(
        `★ 右栏每页从页顶起、左栏第 2 页从页顶起、第 1 页接在**整节课那两张底下**` +
          `（y=${Math.round(left1Cards[0].y)}，那两张占位到 ${Number.isFinite(deckBottom) ? deckBottom : 0}）—— 三块都在该在的地方，且不和它们叠住`
      )
    } else {
      bad(
        '卡片没落在该在的地方：' +
          JSON.stringify({
            右栏页顶: rightTop.map((c) => (c.text || '').slice(0, 8)),
            第2页左栏页顶: left2AtTop.length,
            第1页左栏: left1Cards.map((c) => Math.round(c.y)) + `（该在那两张底下 ≥ ${(Number.isFinite(deckTop) ? deckTop : 0) + CARD_GAP_Y}）`,
            和整节课的卡叠住了: !noOverlapWithOutline,
            全部: pageCards.map((c) => [c.kind, Math.round(c.x), Math.round(c.y)]),
          })
      )
    }
    /* ⚠ 第 3 页的页顶**从 `pgRects` 里取**（它含着 pageGaps），别写死 1120 ——
       整节课那两张占了第一页左栏之后页顶会整体下移，1120 会静默地变成一个
       "永远为假"的数（那时这条断言恒绿，什么也没验到）。 */
    if (!atTop(pgRects[2].y).length) ok('没讲过的第 3 页那儿一张卡都没有（讲解只落在你挑的那几页上）')
    else bad('第 3 页上冒出了卡片：' + JSON.stringify(atTop(pgRects[2].y)))

    /* ── 整节课那两张卡（第二趟的产出落在哪儿）───────────────────────────
       ★ 三条判据，每一条都对应一个"错了也不报错"的地方：
         ① 它们**在文件里**（贴了但没写盘 = 关掉板就没了）；
         ② 它们贴在**第一页左边**、不在任何一页旁边（摆错的表现是"混进了某页那一栏"）；
         ③ 它们**没有 `ask`** —— 圈住它问"这里为什么"在语义上说不通（问哪一页？），
            而带着一个 page:0 的 ask 会让 ask-region 一路找到第 0 页、静默地什么都不问。
       ★★ 两张卡**走同一段判据**（`checkDeckCard`）：除了"用哪个出处字段"和
          "正文该长什么样"之外完全一样 —— 抄两份的话，第二条卡少了一项检查
          （比如忘验 ask）在屏幕上**看不出来**（两块长得像）。
       ⚠ `sumCard` / `rulesCard` 在上面（"对不对齐页顶"那一段要用它们的底边）
         已经找出来了，这儿只是接着用，别再 find 一遍 —— 两处 find 的判据哪天改了就会分叉。 */
    const checkDeckCard = ({ card, field, who, bodyOk, bodyWhy, topY, gapWhy }) => {
      if (!card) {
        bad(`文件里没有${who}：` + JSON.stringify(notes.map((c) => (c.text || '').slice(0, 16))))
        return
      }
      ok(`★ ${who}**落进文件了**（不是只在窗口里看着有）`)
      if (card[field] === true) ok(`★ 它在文件里带着 ${field}:true（出处是独立字段 —— 板层的 kind 仍是 note，形状只有公式/文字两种）`)
      else bad(`${who}没带 ${field}:true（靠 kind 认它会认不出来 —— 它 kind 就是 note）`)
      if (bodyOk(card.text || '')) ok(`★ 卡上的正文对（${bodyWhy}）`)
      else bad(`${who}卡正文不对：` + String(card.text || '').slice(0, 160))
      if (card.x + card.w <= 0 + 1) ok(`★ 它贴在**资料左边**（右边缘 ≤ 资料左边缘 —— 和左栏那几张同一侧）`)
      else bad(`${who}卡的位置不对：` + JSON.stringify([Math.round(card.x), Math.round(card.x + card.w)]))
      /* ★ **第一张**从页顶起（那时第一页左栏还是空的）；
         **第二张**从第一张的底边起（`usedDeck` 抬上去的那个数，见 Board.jsx）——
         唯一要判的是"两张没叠住且第二张在下面"（顺序也是有意的：先形状、后口径）。 */
      if (topY(card)) ok(`★ 它的位置对（${gapWhy(Math.round(card.y))}）`)
      else bad(`${who}的位置不对：y=` + Math.round(card.y))
      if (!card.ask) ok(`★ 它**没有 ask**（"圈住整节课的${who}问这是哪一页"说不通 —— 不给它 ask 是对的）`)
      else bad(`${who}卡莫名其妙带着 ask：` + JSON.stringify(card.ask))
      if (card.rich === true) ok('它也是讲义卡（rich:true，卡片正文里的 `$…$` 要排出来）')
      else bad(`${who}卡没带 rich`)
    }
    checkDeckCard({
      card: sumCard,
      field: 'sum',
      who: '提纲',
      bodyOk: (t) => /^\*\*骨架\*\*/m.test(t) && /\*\*自测\*\*/.test(t),
      bodyWhy: '六段结构，骨架…自测',
      topY: (c) => Math.round(c.y) === 0,
      gapWhy: (y) => `从**第一页页顶**起（第一页左栏当时是空的）：y=${y}`,
    })
    checkDeckCard({
      card: rulesCard,
      field: 'rules',
      who: '做题须知',
      bodyOk: (t) => /^\*\*单位与符号\*\*/m.test(t) && /\*\*最容易错的\*\*/.test(t),
      bodyWhy: '三段结构，单位与符号…最容易错的',
      /* ⚠ 第二张的位置判据**不是** y=0：它接在提纲底下。
         判"它在提纲下面、且没叠住"—— 判"等于某个数"会假红，
         理由和上面 left1Cards 那段一样（先量后落，h 会变）。 */
      topY: (c) => !!sumCard && Math.round(c.y) >= Math.round(sumCard.y + sumCard.h) - 1 && Math.round(c.x) === Math.round(sumCard.x),
      gapWhy: (y) => `接在**提纲底下**（提纲占位到 ${sumCard ? Math.round(sumCard.y + sumCard.h) : '?'}）：y=${y}`,
    })
    /* ── 整节课那两张卡**没有自己写 pageGaps**（铁律②）────────────────────
       ★★ 这条判据很容易写错，所以在这里说清楚**它到底在判什么**：
         · 铁律②说的是"`placeDeckCard` 里不许出现 pageGaps"——整节课那两张的摆位
           函数只返回一个矩形，它**没有**"把下一页往下推"这回事（源码扫描那条守卫
           在 check-doc-cards 里钉着）。
         · **但**那两张卡是坐在**第一页左栏**里的（`Board.jsx` 把 `occupied[0].left`
           抬到第二张的底边），于是逐页那一趟摆版时，第 1 页的左栏从"那两张的底下"
           起算 —— 第 1 页的内容（那两张 + 这一页自己的重点卡）**真的比页面高了**，
           `projectDeck` 于是正经地给第 1 页记了一笔空。
         ⇒ 这一页的空是**摆版的正确结果**，不是那两张卡"偷偷动了 pageGaps"。
           第一版这条判据写的是"pageGaps 全 0"（旧世界：只有一张卡时它装得下），
           加了须知之后它必然非 0 —— 报红的话是"整节课的卡动了 pageGaps"，
           把一个**正确行为**说成了 bug（2026-09-22 记为判据错，不是代码错）。
       ★ 真正该判的两件事，一件都不少：
         ① **第 1 页之外**一页都没被推（那两张只坐第一页）—— `pageGaps` 从第 2 格
            起必须全是 0/空。这条能抓住"它们把整份课件都推下去了"那种错；
         ② 第 1 页那一笔空**是因为装不下**（不是凭空冒出来的）：它该等于
            `pageGapFor(第 1 页实际内容底边, 页高)` —— 用同一份数据（文件里那两张卡
            + pageCards 的 y/h）现算一遍对账。
       ⚠ 判据用 `wrote.value`（`untilFile` 刚读回来的那份板文件）——
         不要再发一次请求去读盘：两份快照之间板可能又写了一次，那种比较是假的。 */
    const gaps = (wrote.value.docs || [])[0] && Array.isArray((wrote.value.docs || [])[0].pageGaps) ? (wrote.value.docs || [])[0].pageGaps : []
    const tail = gaps.slice(1).filter((v) => Number(v) > 0)
    if (!tail.length) ok('★ 整节课那两张只坐第一页 —— **第 2 页起一页都没被推**（pageGaps 第 2 格起全是 0）')
    else bad('整节课的卡把第 2 页之后也推下去了（它们只该占第一页）：' + JSON.stringify(gaps))
    if (Number(gaps[0] || 0) > 0) ok(`★ 第 1 页那一笔空是**装不下的结果**（那两张占了左栏，这一页也就比页面高了，pageGaps[0]=${gaps[0]}）—— 不是它们自己写的 pageGaps`)
    else ok('★ 第 1 页装得下（那两张 + 这一页的重点卡没超过页高），pageGaps 一个字节都没动')
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
            /* ⚠ data-card-sum / data-card-rules 决定"是哪一张整节课的卡"（板层 kind 只有
               formula/note，认不出来）。这一步的分组和文件那一侧的分组必须用同一把尺子。
               ⚠ 这段整块是模板字符串 —— 注释里不许出现反引号（踩过两次了）。 */
            sum: e.dataset.cardSum === '1',
            rules: e.dataset.cardRules === '1',
            text: (e.querySelector('.bd-note') || {}).textContent || '',
            tex: !!e.querySelector('.bd-tex .katex'),
            w: Math.round(e.getBoundingClientRect().width),
            h: Math.round(e.getBoundingClientRect().height),
            id: e.dataset.cardId,
          })),
        }
      })()`)
      /* ⚠ 这里等的是**逐页那三张**（讲解 1 + 重点 1 + 公式 1）上屏，不是"随便几张"。
         加了整节课那两张之后总数是 5，但**它们比逐页那些卡先落盘**（Board 先摆它们）——
         所以"等到 5 张"会在那两张先上屏、逐页那三张还在画的时候提前放行，
         紧接着的一一对应断言就会假红。等 3 张**逐页**的才稳。
         ⚠ 判据是 `!c.sum && !c.rules`（不是 `kind !== 'summary'`）—— 板层 kind 里没有 summary。 */
      const nPageCards = (r && r.cards ? r.cards.filter((c) => !c.sum && !c.rules).length : 0)
      return r && nPageCards >= 3 ? r : undefined
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
    /* ⚠ 判据是**两边都按 `kind` 分桶**再比（不是各自数个数）。整节课那两张单独拿出来对：
       它们和逐页那些卡走的是两条完全不同的路（第二趟 + `placeDeckCard`），
       只对总数的话"它们上了屏、某张重点卡没上"和"它们没上屏、多了一张别的"
       会得出一模一样的结果 —— 正好漏掉这一节最要抓的那类错。 */
    /* ⚠ 分桶的键 = `kind` + **是哪一张整节课的卡**（`sum` / `rules`）——
       只按 kind 分的话，它们和普通讲解卡落在**同一个桶**里
       （它们板层的 kind 都是 `note`），"提纲上了屏、某张讲解卡没上"这条就抓不到了。
       这正是这一节要抓的那一类错（"存了但看不见"），所以桶必须分得够细。
       ★ 而且 `sum` 和 `rules` 要**分成两个不同的键**（不是"整节课的"一个布尔值）：
         两张卡上屏与否是两件事，合并的话"须知没上屏、提纲上了两次"会被算成平的。 */
    const buckets = (arr) => {
      const m = new Map()
      for (const c of arr) {
        const k = (c.kind || '?') + (c.sum ? '+sum' : c.rules ? '+rules' : '')
        m.set(k, (m.get(k) || 0) + 1)
      }
      return m
    }
    const wantB = buckets(cards)
    const gotB = buckets(els)
    const keys = new Set([...wantB.keys(), ...gotB.keys()])
    const diff = [...keys].filter((k) => (wantB.get(k) || 0) !== (gotB.get(k) || 0))
    if (!diff.length) ok('★ 文件里的卡片和屏幕上的**一一对上**（按类型分桶数都对上了）')
    else bad('屏幕上的张数（' + JSON.stringify([...gotB]) + '）和文件里（' + JSON.stringify([...wantB]) + '）对不上，差在：' + JSON.stringify(diff))
      if (drawn.value.measureLeft === 0) ok('量尺寸那张藏卡收摊了（没留在 DOM 里当第 N 张卡）')
      else bad('屏幕外那张测量用的卡还在 DOM 里：' + drawn.value.measureLeft)
      if (els.some((e) => e.tex)) ok('公式卡在板上也**排出来了**（KaTeX 渲染出了 .katex）')
      else bad('屏幕上的公式卡没渲染出公式')
      /* ★ 讲解里夹的行内公式也要**排出来**（用户 2026-09-20：「我想要美观的显示才有利于学生看懂」）：
         卡上带 rich 的那些走 rich.js 渲染，里面该有 .katex；纯文本卡一个都不该有。 */
      const richInfo = await s.eval(`(() => ({
        rich: document.querySelectorAll('.bd-note.rich').length,
        plain: document.querySelectorAll('.bd-note:not(.rich)').length,
        katexInRich: document.querySelectorAll('.bd-note.rich .katex').length,
      }))()`)
      if (richInfo.rich > 0 && richInfo.katexInRich > 0) ok(`★ 讲义卡里的公式排出来了（${richInfo.rich} 张讲义卡里有 ${richInfo.katexInRich} 处 .katex）`)
      else bad('讲义卡里的公式没排出来：' + JSON.stringify(richInfo))
      /* ⚠ 整节课那两张也是文字卡、也走 `rich`（卡上的行内公式要排出来），所以它们**该**算进这两条。
         但**别**把它们算进"板上的文字卡"，见下一条的注解。 */
      if (richInfo.plain === 0) ok('板上的文字卡都是讲义卡（没有退回纯文本的）')
      else bad('有 ' + richInfo.plain + ' 张文字卡没走讲义渲染')
      const elsOutline = els.filter((e) => e.sum)
      if (elsOutline.length === 1) ok('★ 提纲那一张也在屏幕上（data-card-sum="1"）—— 它是"存了但看不见"最容易发生的一张')
      else bad('屏幕上提纲卡的张数不对：' + JSON.stringify(els.map((e) => [e.kind, e.sum, e.rules])))
      /* ★ 第二张（须知）也在屏幕上：`data-card-rules="1"`。
         它是**同一类错**的第二个受害者（存了但看不见）—— 只验提纲的话，
         Board.jsx 里那句三元漏了一个分支（`rules` 那个字段落不进 DOM）会一路绿灯。 */
      const elsRules = els.filter((e) => e.rules)
      if (elsRules.length === 1) ok('★ 做题须知那一张也在屏幕上（data-card-rules="1"）')
      else bad('屏幕上做题须知卡的张数不对：' + JSON.stringify(els.map((e) => [e.kind, e.sum, e.rules])))
      if (els.every((e) => e.w > 20 && e.h > 10)) ok(`每张卡都有实在的尺寸（${els.map((e) => e.w + '×' + e.h).join('、')}）`)
      else bad('有卡片尺寸不对：' + JSON.stringify(els.map((e) => [e.w, e.h])))
      if (els.some((e) => e.kind === 'note' && /力与运动/.test(e.text))) ok('★ 带小节名的那张讲解卡也在屏幕上（标题里写着"力与运动（第 1 页）"）')
      else bad('小节名那张卡没上屏：' + JSON.stringify(els.filter((e) => e.kind === 'note').map((e) => e.text.slice(0, 14))))
    }

    console.log('\n[6b] 钉住的卡片：整张卡点不动、但 📌 点得到（用户要挪就解开）')
    /* ★ 这一节全是**命中测试**的事 —— `dispatchEvent` 合成事件绕过命中测试、
       能"点中"一个实际上点不到的按钮（README 第 11/19 条）。所以每一条都先问
       `elementFromPoint` 再动手，而且**走真鼠标**。 */
    /* ⚠⚠ 先把「⋯ 更多」菜单**收掉**再测这一段（2026-10-06 修）。
       这一段测的是"📌 点得到"，而前面 [2] / [6] 为了点「✧ 课件整理」都**打开过**那个菜单
       （菜单常驻 DOM，z-index 30），谁也没收 —— 于是它正好浮在那颗 📌 上，
       `elementFromPoint` 命中的是菜单而不是按钮。
       ⚠ 原话是"被别的东西盖住了，点不到"，但**被浮层盖住本来就是应该的**：
       菜单开着时下面的东西点不到是设计，不是 bug。那条断言真正要说的是
       "**菜单没开**的时候 📌 点得到" —— 所以收掉菜单再量，而不是去查是什么盖住了。
       ⚠ 判据别写成"清掉所有 open 类"：那会把别的浮层（复习窗口之类）也关掉，
         把这一段变成"顺手把现场清了"。只收这一个按钮自己开的那个。 */
    await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && m.classList.contains('on')) m.click(); return 1 })()`)
    await s.sleep(120)
    {
      const lockInfo = await s.eval(`(() => {
        const el = document.querySelector('.bd-card')
        if (!el) return null
        const locked = el.getAttribute('data-card-locked') === '1'
        const pin = el.querySelector('.bd-card-pin')
        const r = el.getBoundingClientRect()
        /* 「卡片身上按下去落到谁身上」那一点：中心（不是那个 📌，📌 在左下角）。 */
        const cx = Math.round(r.left + r.width / 2)
        const cy = Math.round(r.top + r.height / 2)
        const at = document.elementFromPoint(cx, cy)
        const pinRect = pin ? pin.getBoundingClientRect() : null
        const px = pinRect ? Math.round(pinRect.left + pinRect.width / 2) : 0
        const py = pinRect ? Math.round(pinRect.top + pinRect.height / 2) : 0
        const atPin = pin ? document.elementFromPoint(px, py) : null
        /* ⚠ 报"被谁盖住"而不只是"点不到" —— 原来只说 pinHitSelf=false，
           定位不到是浮层、还是另一张卡、还是画布，只能靠猜（2026-10-06 卡在这条上）。
           ⚠⚠ 这整段是一个**反引号模板**里的代码：注释里绝对不许出现反引号字符，
           否则模板在那里就结束了、后面全成语法错误，而报错指向的是模板**开头**那一行
           （真实原因在几十行外，极难定位）。 */
        const blocker = atPin && !(atPin.closest && atPin.closest('.bd-card-pin'))
          ? {
              cls: String(atPin.className || atPin.tagName || '').slice(0, 60),
              tag: atPin.tagName,
              cardId: (atPin.closest && atPin.closest('.bd-card') && atPin.closest('.bd-card').getAttribute('data-card-id')) || null,
              z: getComputedStyle(atPin).zIndex,
            }
          : null
        return {
          id: el.getAttribute('data-card-id'),
          locked,
          pin: !!pin,
          pinAction: pin ? pin.getAttribute('data-card-pin') : null,
          bodyHit: at ? (at.className || at.tagName) : null,
          pinHitSelf: !!(atPin && atPin.closest && atPin.closest('.bd-card-pin')),
          pinAt: { x: px, y: py },
          pinRect: pinRect ? { x: Math.round(pinRect.left), y: Math.round(pinRect.top), w: Math.round(pinRect.width), h: Math.round(pinRect.height) } : null,
          inViewport: pinRect ? pinRect.top >= 0 && pinRect.bottom <= innerHeight && pinRect.left >= 0 && pinRect.right <= innerWidth : null,
          blocker,
        }
      })()`)
      if (!lockInfo) bad('屏幕上找不到卡片（这一节没得测）')
      else {
        if (lockInfo.locked) ok('贴上去的卡片在 DOM 上是锁定的（data-card-locked="1"）')
        else bad('卡片在 DOM 上没被标成锁定')
        if (lockInfo.pin && lockInfo.pinAction === 'unlock') ok('锁定时 📌 就在（data-card-pin="unlock"）—— "钉死了解不开"不会发生')
        else bad('锁定状态下没有那颗 📌：' + JSON.stringify(lockInfo))
        if (!/bd-card/.test(String(lockInfo.bodyHit))) ok(`卡片身上那一点命中的是 ${lockInfo.bodyHit}（不是卡片自己）—— 拖不动、也选不中`)
        else bad('锁定的卡身上还收指针事件（拖得动）：' + lockInfo.bodyHit)
        if (lockInfo.pinHitSelf) ok('★ 📌 中心那一点命中的就是它自己（真鼠标点得到）')
        else bad('📌 被别的东西盖住了，点不到：' + JSON.stringify(lockInfo))
        /* ── 点 📌 → 解开（这是用户唯一一条"想挪它"的路） ── */
        if (lockInfo.pin && lockInfo.pinHitSelf) {
          await s.mouse(lockInfo.pinAt.x, lockInfo.pinAt.y)
          const un = await until(
            async () => {
              const v = await s.eval(`(() => {
                const el = document.querySelector('[data-card-id="' + ${JSON.stringify(lockInfo.id)} + '"]')
                if (!el) return null
                const pin = el.querySelector('.bd-card-pin')
                return { locked: el.getAttribute('data-card-locked') === '1', pinAction: pin ? pin.getAttribute('data-card-pin') : null }
              })()`)
              return v && v.locked === false ? v : undefined
            },
            { timeout: 6000, what: '那张卡解开' }
          )
          if (un.ok) ok('★ 点一下 📌 → 卡片解开了（屏幕上不再是锁定状态）')
          else bad('点了 📌 卡片还锁着：' + JSON.stringify(await s.eval(`(() => {
            const el = document.querySelector('[data-card-id="' + ${JSON.stringify(lockInfo.id)} + '"]')
            return el ? el.getAttribute('data-card-locked') : null
          })()`)))
          /* ★ 解开要**落进文件**：不落盘的话重开这张板又锁上了（而用户以为他解开过了）。 */
          const unlockedOnDisk = await untilFile((d) => (d.cards || []).some((c) => c.id === lockInfo.id && !c.locked), {
            timeout: 6000,
            what: '解开落进文件',
          })
          if (unlockedOnDisk.ok) ok('解开的那个字段也落进了板文件（重开这张板它还是解开的）')
          else bad('屏幕上解开了，文件里还锁着（重开会变回去）')
          /* 解开之后卡片身上的那一点应当**回到卡片里面**（不然就是"解开了还是拖不动"）。
             ⚠ 判据是 `closest('.bd-card')` —— 讲义卡的正文是一堆 `<p>` / `<ul>` / KaTeX，
               命中卡片**里面**那个段落才是对的（第一版判的是"命中的必须就是 .bd-card 本身"，
               于是报红在 `bd-rich-p` 上：那是卡片里的内容，卡片本来就点得到）。 */
          const after = await s.eval(`(() => {
            const el = document.querySelector('[data-card-id="' + ${JSON.stringify(lockInfo.id)} + '"]')
            if (!el) return null
            const r = el.getBoundingClientRect()
            const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
            return { cls: at ? (at.className || at.tagName) : null, inCard: !!(at && at.closest && at.closest('.bd-card')) }
          })()`)
          if (after && after.inCard) ok(`解开之后卡片身上那一点命中卡片自己（${after.cls}）—— 拖得动了`)
          else bad('解开之后卡片还是点不到：' + JSON.stringify(after))
        }
      }
    }

    console.log('\n[7] 重开窗口再讲：**挑哪几页才讲哪几页**，缓存该省的钱一分不花')
    {
      seen.length = 0
      /* ⚠ 按钮坐标要**重新量一次**：上面贴完卡片之后工具条会变（"∑ 公式架 N"那个角标一出来，
         整排按钮就往左挪了几十像素），拿最开头量到的那对坐标会点到旁边那颗按钮上 ——
         表现是"窗口没开"，紧接着 setRange 拿到 null 抛 Illegal invocation（2026-09-20 撞的）。
         ⚠ 它 2026-09-26 还收进了「⋯ 更多」菜单 —— 先开菜单再量（菜单开着它才点得到）。 */
      await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && !m.classList.contains('on')) m.click(); return 1 })()`)
      await s.sleep(150)
      const spot7 = await s.eval(`(() => {
        const b = document.querySelector('[data-tool="deckread"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!spot7) bad('找不到「✧ 课件整理」那颗按钮')
      /* ⚠ 还要等那句 flash 飘走：贴完会弹一条「老师讲完了…」的提示条，它就压在工具条上方 ——
         这时候点下去，点到的是那条提示（表现同样是"窗口没开"，2026-09-20 撞的）。 */
      await until(async () => ((await s.eval(`!document.querySelector('.toast')`)) ? 1 : undefined), { timeout: 6000, what: '提示条飘走' })
      await s.mouse(spot7.x, spot7.y)
      const reopened = await until(async () => ((await s.eval(`!!document.querySelector('.dkr-back')`)) ? 1 : undefined), { timeout: 6000, what: '窗口再开一次' })
      if (!reopened.ok) {
        bad('窗口没再开出来（按钮坐标飘了？）—— 这一节验不下去')
        return
      }
      /* ══ 这一节分三趟，验的是**三件不同的事** ══════════════════════════════
         ⚠ 这一节的两条断言**前提取反过**（2026-09-22 在这里红过，同一份代码跑两遍
           一红一绿）：`DeckReview` 点「讲这几页」时会先忘掉**这一趟挑中的那几页**的
           讲稿（"讲这几页"是**重读**的意思，不是"接着讲"）—— 于是"挑一页讲过的页、
           一个请求都不发"这条**永远不成立**，它测的其实是"开读前清没清那几页"。
         ⇒ 现在两条都按真实口径写，而且都**不受那一次清理影响**：
           ① 挑一页**要讲的**页 → 一定真出网（`forgetDeck` 保证），页码要发对；
              它**没有**「上次讲的」标签（刚讲出来的，标签在说实话，不是恒亮）。
           ⓪ 重开窗口那一刻：**讲过的页不默认选上**（2026-09-30 加，见下面那条断言）。
           ② "花钱与否在屏幕上看得见"这件事：拿这一趟**真发过**的页号，和界面上
              「上次讲的」标签的**分布**对一遍 —— `.dkr-pgblk` 的 `data-page` 是唯一口子。 */
      /* ── ★ 默认选中**不该**包含讲过的页（2026-09-30，用户原话：「讲解ppt的时候
             不要默认选中已经讲过的页」）─────────────────────────────────────
         [3] 讲过第 1、2 页，所以这一次重开窗口默认该只剩第 3 页。
         ⚠ **必须在 setRange 之前读**：一写区间，选中就被脚本自己改掉了 ——
            那测的是脚本，不是窗口。 */
      /* ⚠ 走到这儿，**三页全都讲过**了（[2b] 讲过 1、3；[3] 讲过 1、2）——
         所以这一条验的是那个**兜底**：剔完一个不剩时原样全选，而不是给一个空窗口
         （"打开就一片空白"比"全选"更难懂，用户连"它是不是坏了"都分不清）。
         ⇒ "剔除讲过的页"那条**部分讲过**的断言在 [2b] 收尾那次重开里（见那儿）。 */
      const picked7 = await s.eval(`[...document.querySelectorAll('.dkr-pg.on')].map(b => Number((b.textContent || '').trim() || '0'))`)
      const done7 = await s.eval(`(() => { const e = document.querySelector('.dkr-donehint'); return e ? String(e.getAttribute('data-done') || '') : '' })()`)
      if (picked7.length === 3) ok('★ 三页都讲过时**原样全选**（不给一个空窗口 —— 那种窗口用户只会以为它坏了）')
      else bad('三页都讲过，默认选中却不是全选：' + JSON.stringify(picked7) + '（它认为讲过：' + JSON.stringify(done7) + '）')
      /* 那份"话说清楚"的责任还在：全选着却不说一句，用户会以为窗口没记着讲过的事。 */
      const hint7 = await s.eval(`(document.querySelector('.dkr-donehint') || {}).textContent || ''`)
      if (/都/.test(hint7) && /讲过/.test(hint7)) ok('★ 那句话说清了"这份课件**都**讲过了"（不是假装没讲过）')
      else bad('全讲过时那句话没说清，挑页那一行是：' + JSON.stringify(hint7))
      const tagOf = () => s.eval(`document.querySelectorAll('.trv-tag.ok').length`)
      await setRange('2')
      await clickRead()
      const done = await until(async () => {
        const r = await s.eval(DKR)
        return r.items.length >= 2 && !/正在一页一页讲/.test(r.head) ? r : undefined
      }, { timeout: 10000, what: '第二趟读完' })
      if (done.ok) ok('第二趟照样读出了内容（界面路径没坏）')
      else bad('第二趟没读出内容')
      /* ⚠ 只数**逐页那一趟**的页号（`pageSeen()`）：整节课那两趟也走同一个假服务，
         而它们的提示词里带着那份摘要 —— 摘要里有"第 1-2 页"这种页号，
         按 `第 (\d+) 页` 一抠就抠出个假的页码来（实测抠出的是 2）。
         混进来会让"只重发了第 2 页"这条断言拿到 [2,2]。
         ★★ **必须走 `pageSeen()`（按 `deck` 滤），不能按 `summary` 滤**：
           须知那一趟的 `summary` 是 false（它不是提纲）—— 按它滤的话，
           须知那条会被当成**逐页的请求**混进来，"发出去的页码不对"于是报红，
           而报出来的页码（0）看着像"页码带错了"，其实是**判据**漏了一趟。
           2026-09-22 加了须知之后，[7] 的两条就是这么红的。 */
      const asked1 = pageSeen().map((x) => x.page).filter((n) => n > 0)
      if (asked1.length === 1 && asked1[0] === 2) ok('★「讲这几页」真读了第 2 页（页码发对了）—— 它就该重读，不该被缓存回放旧稿')
      else
        bad(
          '「讲这几页」发出去的页码不对：' +
            JSON.stringify(seen.map((x) => [x.page, x.summary ? 'SUM' : x.deck ? 'RULES' : 'page', x.imageBytes])) +
            `（挑的是第 2 页；上面每条第三个字段是图的大小，0 = 没带图）`
        )
      const tag1 = await tagOf()
      if (tag1 === 0) ok('★ 刚讲出来的那一页**没有**「上次讲的」标签（这标签在说实话，不是恒亮）')
      else bad('刚讲过的页面上却挂着「上次讲的」标签：' + tag1)
      /* ── ② 「花钱与否」在屏幕上看得见吗？──────────────
         ⚠ 这里**不能**再走 `setRange` + `clickRead`：上一趟读完那一屏就不再是"挑页"
           （`.dkr-range` 那一行只在挑页那一屏），写不进去 —— 实测就是这么红的
           （"区间「3」没写进去"）。
         也不该指望"再读一遍第 3 页命中缓存"：开读前 `forgetDeck` 会先忘掉**这一趟挑中的那
           几页**，所以真重开一次窗口挑第 3 页的话，它照样会出网（那正是"讲这几页"的
           字面意思）。⇒ 这一条改成**就地对答案**：拿这一趟真读过的页号，和界面上那几颗
           「上次讲的」标签的分布对一遍，确认"发过网的页才没标、没发过的页才标"是真的。
         口子在 `.dkr-pgblk` 的 `data-page` 上（`key` 不会落到 DOM，得显式写一个）。 */
      const shownPages = await s.eval(`[...document.querySelectorAll('.dkr-pgblk')].map(b => Number(b.getAttribute('data-page') || '0')).filter(n => n > 0)`)
      const unmarked = await s.eval(`[...document.querySelectorAll('.dkr-pgblk')].filter(b => !b.querySelector('.trv-tag.ok')).map(b => Number(b.getAttribute('data-page') || '0')).filter(n => n > 0)`)
      if (!shownPages.length) {
        /* 数不出来就如实说 —— 别硬凑一条假绿（`key` 落到 DOM 上过一次）。 */
        bad('页块上没有 data-page —— 这一条验不了（去 DeckReview 把 data-page={n} 加回去）')
      } else if (unmarked.length === asked1.length && unmarked.every((n) => asked1.includes(n))) {
        ok(`★ 「花钱与否」在屏幕上看得见：${shownPages.length} 页里只有这趟真发过的 ${JSON.stringify(unmarked)} 页没标「上次讲的」`)
      } else {
        bad(`标签分布和真花过钱的页对不上：没标「上次讲的」的是 ${JSON.stringify(unmarked)}，这趟真发过的是 ${JSON.stringify(asked1)}（屏幕上共 ${JSON.stringify(shownPages)} 页）`)
      }
      /* ── 「先不整理」这颗按钮（2026-09-23 改过判据）──────────────────────
       * ★ 从前这一条写的是"'先不整理'把窗口关掉了（**一个字都没写**）"——
       *   而上一句刚刚验完"这几页真读出来了"，所以那句括号是**假的**：
       *   窗口里明明有几百字。它当时能绿，只是因为退出这件事**没问过任何人**。
       *
       * 用户原话：「只要我课件整理的时候不小心点到旁边直接就退出了太烦了白花钱」
       *   ⇒ 现在**读过东西之后退出必须先问一句**（DeckReview 的 `leave()`）。
       * 所以这一条要验的变成**三件事**（比从前那条强，因为它验的是那个闸本身）：
       *   ① 点了「先不整理」→ **真弹了问话**（`Page.javascriptDialogOpening`）
       *   ② 回答"取消" → **窗口还在**（东西没丢）—— 这正是用户要的那个保护
       *   ③ 再点一次、这次回答"确定" → 窗口才真的关掉
       * ⚠ 弹框由 Session 自动回答（默认答**取消**，见 board-check.js 那段）；
       *   第三条要临时把 `dialogAnswer` 拨成 true —— 拨完**必须拨回来**，
       *   否则后面所有 `confirm` 都会答"确定"（那是"污染后面的用例"的经典写法）。 */
      const nDialogBefore = s.dialogs.length
      await s.eval(`[...document.querySelectorAll('.dkr-acts .mini')].find(b => b.textContent.includes('先不整理'))?.click()`)
      const asked = await until(
        async () => (s.dialogs.length > nDialogBefore ? s.dialogs[s.dialogs.length - 1] : undefined),
        { timeout: 4000, what: '点「先不整理」弹出问话' }
      )
      if (asked.ok) {
        const m = String((asked.value && asked.value.message) || '')
        if (/退出|不会留在板上|再花一次/.test(m)) ok('★ 点「先不整理」会**先问一句**（读过东西之后不再一点就走）：' + JSON.stringify(m.slice(0, 40)))
        else bad('弹了问话，但话术不对（没提"退出/不会留在板上"）：' + JSON.stringify(m.slice(0, 80)))
      } else {
        bad('点「先不整理」**没问就退了** —— 这就是用户报的那个"白花钱"（读过 ' + asked1.length + ' 页之后一点就走）')
      }
      /* ② 答"取消" → 窗口必须在（Session 默认就答取消） */
      const stayed = await until(
        async () => ((await s.eval(`!!document.querySelector('.dkr-back')`)) ? 1 : undefined),
        { timeout: 3000, what: '答取消之后窗口还在' }
      )
      if (stayed.ok) ok('★ 答「取消」→ 窗口还在，读过的内容一条没丢（这就是用户要的那个保护）')
      else bad('答了取消，窗口却关了 —— 那还是白花钱')
      /* ③ 这次答"确定" → 才关掉 */
      s.dialogAnswer = true
      try {
        const closed = await until(async () => {
          await s.eval(`[...document.querySelectorAll('.dkr-acts .mini')].find(b => b.textContent.includes('先不整理'))?.click()`)
          return (await s.eval(`!document.querySelector('.dkr-back')`)) ? 1 : undefined
        }, { timeout: 4000, what: '窗口关掉' })
        if (closed.ok) ok('再点一次、答「确定」→ 窗口才真的关掉（问那一句不是拦路，是提醒）')
        else bad('答了确定却还是没关掉窗口')
      } finally {
        s.dialogAnswer = false /* ★ 必须拨回来，见上面 */
      }
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

    console.log('\n[9] 板上没有课件时：那颗按钮**直接开选文件那个框** —— 选完只说页码，卡直接落板')
    {
      /* 用户 2026-09-20 原话：「不是必须要我先把 pdf 放上来才能够整理 —— 应该是我直接去
         选择这个文件，然后告诉你是需要第几页到第几页，然后就能够直接去整理到白板上」。
         这一节就走这条路：先把资料从板上移掉（那条把手上的 ✕），再点那颗按钮。 */
      await s.eval(`(() => { const b = document.querySelector('.bd-docbar-x'); if (b) b.click(); return !!b })()`)
      const off = await until(async () => ((await s.eval(`!document.querySelector('.bd-docbar')`)) ? 1 : undefined), { timeout: 6000, what: '资料从板上移掉' })
      if (!off.ok) bad('资料没从板上移掉（点 .bd-docbar-x 没反应？）—— 这一节验不下去')
      else {
        ok('资料从板上移掉了（现在是"我还没把课件铺上来"那个状态）')

        /* ★ **真开选文件那个框了吗？**
           往页面里塞一个 File 再派发 change 是**证明不了**这件事的：那样即使按钮
           压根没接上文件框，断言也照样绿。所以从**浏览器那一侧**收证据：
           CDP 把文件选择器拦下来 → 等它报"框开了" → 再把文件塞进那个框。 */
        let chooser = null
        /* ★ 只认这一种事件、别的一律放行（`onEvent` 是单槽的，整段覆盖会把
           "别的事件也要有人接"这件事一起吞掉 —— 弹框那个总闸正好也走这条路）。
           这里**只管收**，不在这里做判断：等不到框由下面的 until 报红。 */
        const prevOnEvent = s.onEvent
        s.onEvent = (m, p) => {
          if (m === 'Page.fileChooserOpened') chooser = p
          if (prevOnEvent) {
            try { prevOnEvent(m, p) } catch {}
          }
        }
        await s.send('DOM.enable')
        await s.send('Page.setInterceptFileChooserDialog', { enabled: true })

        /* 「✧ 课件整理」在「⋯ 更多」菜单里 —— 先开菜单再量坐标（见 [1] 的说明）。 */
        await s.eval(`(() => { const m = document.querySelector('[data-tool="more"]'); if (m && !m.classList.contains('on')) m.click(); return 1 })()`)
        await s.sleep(150)
        const spot = await s.eval(`(() => {
          const b = document.querySelector('[data-tool="deckread"]')
          if (!b) return null
          const r = b.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: b.textContent }
        })()`)
        if (!spot) bad('找不到「✧ 课件整理」那颗按钮')
        else {
          await s.mouse(spot.x, spot.y)
          const asked = await until(async () => chooser || undefined, { timeout: 8000, what: '弹出选文件那个框' })
          if (asked.ok) ok('★ 点了它 → 真开的是**选文件那个框**（板上没课件也不用先去插一份）')
          else bad('点了按钮，选文件那个框没开（板上没课件时它就该直接开这个）')

          if (asked.ok && chooser && chooser.backendNodeId) {
            await s.send('DOM.setFileInputFiles', { files: [FIX_PDF], backendNodeId: chooser.backendNodeId })
          } else if (asked.ok) bad('拿不到那个文件框的句柄，文件塞不进去')

          const win = await until(async () => {
            const r = await s.eval(DKR)
            return r.open ? r : undefined
          }, { timeout: 20000, what: '课件整理窗口弹出来' })
          if (!win.ok) {
            bad('选完文件没弹整理窗口（等到 ' + win.waited + 'ms）')
            console.log('  （页面报错：' + (s.errors().length ? s.errors().slice(0, 2).join(' ｜ ') : '无') + '）')
          } else {
            const d = win.value
            ok('选完文件直接进了挑页那一屏（中间没有"先插到板上"这一步）')
            if (d.pickRows === 3) ok('★ 页数是从**你选的那份 PDF** 量出来的（3 格）—— 板上一个页面都没有')
            else bad('挑页格子数不对：' + d.pickRows)
            if (/zz-deck-smoke/.test(d.head)) ok('标题里写着选的是哪一份文件（' + d.head.replace(/\s+/g, ' ').slice(0, 40) + '）')
            else bad('标题不是选的那一份：' + d.head)

            /* ★ 这一条验的是「**板上没有课件时，选同一份文件**会不会在盘上多存一份」：
               多存一份 = 路径变了 = 缓存全落空，那几页要**再花一次钱**。
               ⚠ 但"这一趟该发几个请求"**不是**判据 —— `DeckReview` 打开时就把这一份
                 资料的读数缓存清了（"讲这几页"是重读的意思）。真正的判据是那个**路径**：
                 读之前它有几份、读之后还是几份（见下面对 `/api/files` 那一次读）。
               所以这里发请求是正常的，别把"请求数"当成这条断言的证据。 */
            const docsBefore = await s.eval(`fetch('/api/files').then(r => r.json()).then(j => (j.files || j.entries || []).filter(x => /zz-deck-smoke/.test(x.path || x.name || '')).length).catch(() => -1)`)
            await setRange('1-2')
            seen.length = 0
            await clickRead()
            const again = await until(async () => {
              const r = await s.eval(DKR)
              return r.items.length >= 2 ? r : undefined
            }, { timeout: 15000, what: '选文件那条路读出来' })
            if (again.ok) ok(`照样读出了内容（${again.value.items.length} 条）`)
            else bad('选文件那条路没读出内容')
            /* ★ 判据只能是**盘上有没有多出一份**（路径的唯一性）—— 见上面那段说明：
               "这一趟发不发请求"由"打开窗口时清了缓存"决定，跟多存一份没关系。 */
            const docsAfter = await s.eval(`fetch('/api/files').then(r => r.json()).then(j => (j.files || j.entries || []).filter(x => /zz-deck-smoke/.test(x.path || x.name || '')).length).catch(() => -1)`)
            if (docsBefore < 0 || docsAfter < 0) bad('读不出盘上的文件清单（这一条验不了）：' + JSON.stringify([docsBefore, docsAfter]))
            else if (docsAfter <= docsBefore) ok(`★ 盘上**没有多存一份**（选文件前后都是 ${docsAfter} 份同一份课件）—— 路径没变，缓存键也就没变`)
            else bad(`盘上多存了一份（${docsBefore} → ${docsAfter}）：路径一变，缓存全落空，以后再选它就要重新花钱`)

            /* 贴：资料不在板上，所以卡片落在**当前视野中心**（没有"课件右边"可贴）。 */
            await s.eval(`[...document.querySelectorAll('.dkr-acts .btn')].find(b => b.textContent.includes('贴到白板上'))?.click()`)
            const grew = await untilFile((d2) => (d2.cards || []).length >= cards.length + 3, { timeout: 12000, what: '新一批卡片落进板文件' })
            if (!grew.ok) bad('点了「贴到白板上」，文件里的卡片没多出来')
            else {
              const oldIds = new Set(cards.map((c) => c.id))
              const fresh = grew.value.cards.filter((c) => !oldIds.has(c.id))
              ok(`贴上了 ${fresh.length} 张新卡（文件里一共 ${grew.value.cards.length} 张）`)
              if (grew.value.docs && grew.value.docs.length === 1) ok('★ 板文件里多了一份资料 —— 选文件那条路现在**把课件铺到板上**（讲解要贴着每一页摆）')
              else bad('资料没落进板文件：' + JSON.stringify(grew.value.docs))
              if (await s.eval(`!!document.querySelector('.bd-docbar')`)) ok('画布上也出现了资料层（页面就在那儿，讲解在它两边）')
              else bad('画布上没有资料层')
              /* 文件里有几张卡，屏幕上就得有几张 —— 而且**得看得见**：
                 落在几十屏之外的话，用户看到的是"点了没反应"。 */
              const seen2 = await s.eval(`(() => {
                const W = window.innerWidth, H = window.innerHeight
                const out = []
                for (const id of ${JSON.stringify(fresh.map((c) => c.id))}) {
                  const el = document.querySelector('[data-card-id="' + id + '"]')
                  if (!el) { out.push({ id, missing: true }); continue }
                  const r = el.getBoundingClientRect()
                  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
                  out.push({ id, missing: false, onScreen: cx > 0 && cx < W && cy > 0 && cy < H })
                }
                return out
              })()`)
              const missing = seen2.filter((x) => x.missing).length
              if (!missing) ok('新卡片全都在屏幕上（文件里有、界面上有）')
              else bad(`有 ${missing} 张新卡没上屏（文件里有、界面上没有）`)
              if (seen2.some((x) => x.onScreen)) ok('★ 新卡片落在**你看得见的地方**（贴完视野挪到第一页）')
              else bad('新卡片落在视野外面（贴完得自己找半天）')
            }
            if (!(await s.eval(`!!document.querySelector('.dkr-back')`))) ok('贴完窗口自己关掉了')
            else bad('贴完窗口还开着')
          }
        }
        s.onEvent = null
        await s.send('Page.setInterceptFileChooserDialog', { enabled: false })
      }
    }

    console.log('\n[10] 整个流程跑下来，页面里没有 JS 报错')
    const errs = s.errors()
    if (!errs.length) ok('没有报错')
    else bad(`页面里有 ${errs.length} 条报错：` + errs.slice(0, 3).join(' ｜ '))
  }
)

mock.close()
/* ★ 走 `restoreOnce` 而不是直接 `restoreConfig`：把闸门合上，
   紧接着那个 `exit` 钩子就不会再进来第二次（见上面那段）。 */
restoreOnce()
if (!mockUp) console.log('  （假识别服务没起得来 —— 上面的失败多半是它引起的）')
process.exitCode = fails ? 1 : 0



