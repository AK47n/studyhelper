/* check-look：**速查**（2026-09-28 加的"上课突然不懂的那个词"）这条路的纯逻辑。
 *
 * 这里钉的三块，都是"错了不报错、只会安静出错"的那一族：
 *
 *   [A] **从课件的字里挑词**（doc-words.js）——
 *       中文没空格，"点在第 5 个字上"和"他要问的词"之间隔着一层猜。
 *       这里的每条断言都是"取出来的词得像个词"：
 *       冒号要断得开、`H(z)` 里的数字不能被斩、数学斜体（**代理对**）不能切成半个字。
 *   [B] **把模型那四行拆开**（lookup.js 的 parseLookup）——
 *       模型漏行、冒号写成英文、还夹 Markdown 加粗，这些都不是失败；
 *       倒是"一个字段都没拆出来"必须兜住 —— 界面上绝对不能是一块空白。
 *   [C] **留下的是什么**（answer-cards.js 的 lookupText）——
 *       字限量要报数（静默少字和"模型没讲完"分不出来）。
 *   [D] **接线有没有真的接上**（源码扫描）——
 *       这一族最阴的失败方式是"函数写得对、**没人调**"（本仓库栽过一模一样的）。
 *
 * ⚠ 这里 import 的全是纯函数，一个会拉起 pdf.js / 浏览器的都不许进来
 *   （"能被断言的住这边、要浏览器的住 check-look-browser.js"）。
 *
 * 跑：node scripts/check-look.js   （或 npm run check:look）
 */
import { readFileSync } from 'node:fs'
import { MAX_TERM, charIndexAt, hitItem, pickWord } from '../src/lib/doc-words.js'
import { cacheKey, parseLookup } from '../src/lib/lookup.js'
import { MAX_LOOK_EG, MAX_LOOK_SAY, MAX_LOOK_TERM, lookupText } from '../src/lib/answer-cards.js'

let fails = 0
let checks = 0
const ok = (m) => {
  checks++
  console.log('  \u2713 ' + m)
}
const bad = (m) => {
  checks++
  fails++
  console.log('  \u2717 ' + m)
}
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(`${m}（拿到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`))
const yes = (v, m) => (v ? ok(m) : bad(m))
const no = (v, m) => (!v ? ok(m) : bad(m))

/* ── 一段假课件：位置按比例手写，算术一眼看得清 ────────────────────────────
   （从前这种夹具是拿用户那份真 PDF 跑的 —— 他那份还在的时候还行，
     换台机器断言就跑不了了。自造之后这些数是**任何时候都重跑得出**的。） */
const LINE = (str, y0, y1, x0 = 0.1, x1 = 0.9) => ({ str, x0, x1, y0, y1 })
const page = [
  LINE('回顾：连续时间傅里叶变换公式', 0.10, 0.14),
  LINE('其中 $H(z)$ 是系统函数', 0.20, 0.24),
  LINE('截止频率 -3dB 处功率减半', 0.30, 0.34),
]

console.log('\n[A] 从课件的字里挑词（doc-words.js）')

{
  /* ① 点在标题中部 → 拿到一个词、带着它所在那整句当上下文 */
  const got = pickWord(page, 0.5, 0.12)
  yes(got && got.term, 'A1 点在有一行字的地方能取到词')
  eq(Array.from(got.term).length <= MAX_TERM, true, `A2 取到的词不超过 ${MAX_TERM} 个字（PPT 标题常常是一整句，全要了等于没切）`)
  eq(got.line, '回顾：连续时间傅里叶变换公式', 'A3 `line` 是它所在的**那整段**（光看一个词常常判断不出是不是自己要问的那个）')

  /* ②★ 冒号要能把词断开 —— 点在"回"字上，向右吃到"顾"就被"："挡住。
     ⚠ 这条从前**写反过**：断言成了"不含回顾"，而点在"回"上拿到的正是"回顾"。
        要验的是"没跨过冒号"，不是"不含某个子串"。 */
  const atRecall = pickWord(page, page[0].x0 + 0.004, 0.12)
  eq(atRecall && atRecall.term, '回顾', 'A4★ 冒号后面的串不会被吞进来（点在"回"上 → "回顾"，不是整句）')

  /* ③★ 只剩符号的一处：**不比空白更有价值** —— 取到它的话，窗会针对一个美元符号
        自动发一次请求，换来模型对 "$" 讲一段话（那是白花的一次钱和一个"…"）。 */
  eq(pickWord(page, 0.5, 0.22), null, 'A5★ 点在孤零零一个符号上（`$H(z)$` 收尾那个 `$`）→ null，不是把 `$` 当词去查')
  /* 括号也 STOP，所以点在括号内拿到的是它自己那一小段 —— 这是**可接受**的：
     机器的切词本来就要摆给他看、让他改（QuickLook 里那个就是输入框）。
     真正不许发生的只有两种：切在代理对中间（A10）、以及只剩符号（A5）。 */
  yes(pickWord(page, page[1].x0 + 0.02, 0.22), 'A5b 点在同一行靠前的字上仍能取到词（不是整行判废）')

  const at3dB = pickWord(page, 0.5, 0.32)
  yes(at3dB && /-?3dB/.test(at3dB.term), `A6★ "-3dB" 那个负号和小数点是安全的（拿到 ${JSON.stringify(at3dB && at3dB.term)}）`)

  /* ④ 空白页角 → null（⇒ 界面不该弹出一个空窗，见 Board.jsx 的 onStageDoubleClick） */
  eq(pickWord(page, 0.005, 0.9), null, 'A7 点在空白页角返回 null（有了它，"双击没反应"才说得通是"这儿没字"）')
  eq(pickWord([], 0.5, 0.5), null, 'A8 一页上一个字都没有（扫描版 → pageTextItems 给出空数组）→ null')
  eq(pickWord(null, 0.5, 0.5), null, 'A9 items 直接是 null（图片资料那条路）→ null，不是一个崩溃')

  /* ⑤★ 代理对：数学斜体字母 𝑿 是 U+1D4XX，占两个 UTF-16 码元。
        按 `str[i]` 切的话会在它中间斩一刀，取出来的是半个字（渲染成一坨方块），
        而这个 bug **只在公式页面上出现** —— 恰恰是最需要查词的那种课件。 */
  const mathPage = [LINE('设 转移𝘟(𝒔)', 0.1, 0.14)]
  const mathGot = pickWord(mathPage, 0.5, 0.12)
  /* ⚠ 判"有没有被切成半个字"不能用 `/[\uD800-\uDFFF]/` —— 它在 UTF-16 世界里
     对**任何**一个天文字符都成立（每个 CJK 之外的那个字本来就是两个码元）。
     要看的是"有没有一个 code point **本身**落在代理区"：那才是孤儿。 */
  const lone = (s) => Array.from(s).some((c) => {
    const n = c.codePointAt(0)
    return n >= 0xd800 && n <= 0xdfff
  })
  no(mathGot && lone(mathGot.term), `A10★★ 代理对不会被切成半个字（拿到 ${JSON.stringify(mathGot && mathGot.term)}）`)

  /* ⑥ 行缝容差：点在两行之间也算"就这儿"（美术课件上行距常常比字还宽） */
  yes(hitItem(page, 0.5, page[0].y1 + 0.01), 'A11 点偏出这一行一点点（0.01）仍判在这行内')
  eq(hitItem(page, 0.5, page[0].y1 + 0.5), null, 'A12 偏得太远（0.5 页高）→ null（不能大到把隔壁行认回来）')

  /* ⑦ charIndexAt：夹在这个字的两个端点之间 */
  eq(charIndexAt(page[2], 0.9), Array.from(page[2].str).length - 1, 'A13 点在最右边一个字上 → 最后一个下标（越界要夹住）')
  eq(charIndexAt(page[2], 0.0), 0, 'A14 点在最左边（x 比行首还左）→ 0')
}

console.log('\n[B] 把模型那四行拆开（lookup.js）')

{
  /* ① 规规矩矩的四行 */
  {
    const got = parseLookup('词：傅里叶变换\n讲：把一个信号拆成一堆正弦。\n例：方波 → 一串奇次谐波。\n近：拉普拉斯变换, 离散傅里叶变换')
    eq(got.term, '傅里叶变换', 'B1 `词` 那一行')
    eq(got.say, '把一个信号拆成一堆正弦。', 'B2 `讲` 那一行')
    eq(got.eg, '方波 → 一串奇次谐波。', 'B3 `例` 那一行')
    eq(got.near, ['拉普拉斯变换', '离散傅里叶变换'], 'B4 `近` 那一行按逗号/顿号切成一串')
  }

  /* ②★ 冒号写成英文的 —— 这是最容易发生的真实情况 */
  eq(parseLookup('Term: x\nSay: y').term, '', 'B5 标签是**那四个中文字**，英文 Term/Say 不认（三者对不上时宁可显示原文）')
  eq(parseLookup('词: x').term, 'x', 'B6 半角冒号照样认')

  /* ③★★ Markdown 加粗 / 列表符号：剥的顺序**不能反**
     （反了的话 `**词**：…` 会先被当成列表项吃掉一颗星，剩一个歪的 `*词**` 再也匹配不上） */
  eq(parseLookup('**词**：傅里叶变换').term, '傅里叶变换', 'B7★★ `**词**：…` 认得出来（先剥加粗、再去列表符号）')
  eq(parseLookup('**讲**：一件事').say, '一件事', 'B8 加粗的 `讲` 同样认')
  eq(parseLookup('- 词：傅里叶变换').term, '傅里叶变换', 'B9 行首那个列表符号剥掉')
  eq(parseLookup('-3dB').say, '-3dB', 'B10★ `-3dB` 不是列表项（符号后面**必须有空格**才算），式子不能被斩掉一段')

  /* ④ 模型漏行是常事 —— **缺行不是失败** */
  {
    const got = parseLookup('词：卷积\n讲：两个信号翻转平移相乘积分。')
    yes(got.say.length > 0, 'B11 没有「例」「近」照样能显示（懒得给那两行≠这次没查出来）')
    eq(got.near, [], 'B12 没有「近」时是空数组，不是 null / undefined')
  }

  /* ⑤ 一条内容占了好几行 → 接在上一行**内容**后面，不是丢掉 */
  eq(parseLookup('词：X\n讲：第一行\n第二行').say, '第一行 第二行', 'B13 没有标签的行接在上一条后面（丢半句比多行更难读）')

  /* ⑥★★ 一个字段都没有 → 整段原文当"讲"，绝不给一块空白 */
  {
    const got = parseLookup('傅里叶变换（Fourier Transform）是把一个信号表示成一系列复指数之和。')
    yes(got.say.includes('傅里叶变换'), 'B14★★ 模型不按格式回话时，**整段原文当解释**（用户对着一块空白只会以为坏了）')
  }
  eq(parseLookup('').say, '', 'B15 空输入 → 什么都不给（这时候界面不该开着等着）')

  /* ⑦ 缓存的键 = 课 + 词：少任何一半都会串台 */
  eq(cacheKey('变换', '信号与系统'), '信号与系统‖变换', 'B16 键是「课‖词」（忽略大小写与前后空白）')
  yes(cacheKey('变换', '信号与系统') !== cacheKey('变换', '大物'), 'B17★ 同一个词换一门课**不命中**（在信号课上查过的"变换"，换个课去查就该重新问一次）')
  yes(cacheKey('变换', 'A') !== cacheKey('换变', 'A'), 'B18 词不同就不同键')
}

console.log('\n[C] 留到板上的是什么（answer-cards.js 的 lookupText）')

{
  const got = lookupText({ term: '傅里叶变换', say: '把信号拆成一堆正弦。', eg: '方波 → 一串奇次谐波。' })
  eq(got.title, '傅里叶变换', 'C1 卡片的标题就是**那个词**（一周后翻到一张只有解释的卡，你不知道它讲的是谁）')
  eq(got.body, '把信号拆成一堆正弦。\n\n例：方波 → 一串奇次谐波。', 'C2 正文是「讲」+「例」')
  no(got.clipped, 'C3 短答案什么都不截')

  const long95 = lookupText({ term: '词'.repeat(MAX_LOOK_TERM + 20), say: '讲'.repeat(MAX_LOOK_SAY + 50), eg: '例'.repeat(MAX_LOOK_EG + 50) })
  eq(Array.from(long95.title).length, MAX_LOOK_TERM, `C4 太长的词 → 截到 ${MAX_LOOK_TERM} 字（标题撑长了卡片就是一条横幅）`)
  yes(long95.clipped, 'C5★ 截断要**报数**（`clipped`）—— 静默少字和"模型没讲完"分不出来')

  no(lookupText({ term: '卷积' }), 'C6 只有词、没有解释 → null（不落一张只有标题的卡）')
  no(lookupText({}), 'C7 空 → null')
  no(lookupText(null), 'C8 不是对象 → null')
  eq(lookupText({ say: '一句话解释' }).title, '查过的一个词', 'C9 模型没回「词」那一行时常发生 → 退回一句话，标题**不许空着**')

  /* ★「近」那几个相关词**刻意不进卡**：它在浮着的窗里点了就能接着查，
     落到板上就是一串谁都不会去点的标签 —— 而它随时能再查一次拿回来。 */
  no(/相关|近/.test(JSON.stringify(lookupText({ term: 'X', say: 'Y', near: ['A', 'B'] }))), 'C10 「近」不写进卡片内容（点了才有意义的东西不落成死标签）')
}

console.log('\n[D] 接线：写了的东西有没有人真的调（源码扫描）')

{
  /* 这一族最阴的失败方式：函数写得对、**没人调**（本仓库栽过一模一样的，
     见 check-keep.js 的 F18/F19 那条扫描）。下面这几条扮演同一个角色。 */
  const board = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/components/QuickLook.jsx', import.meta.url), 'utf8')

  yes(/import QuickLook from '\.\/QuickLook\.jsx'/.test(board), 'D1 Board.jsx 引了 QuickLook')
  yes(/<QuickLook/.test(board), 'D2★ Board.jsx 真的把它**渲染**了（import 了不用 = 界面上永远没有这个窗）')
  yes(/onDoubleClickCapture=\{onStageDoubleClick\}/.test(board), 'D3★ 双击那条路挂上了（挂在 `.bd-stagewrap` 的**捕获阶段** —— 冒泡会被选区手柄拦死，见 Board.jsx 那段）')
  yes(/t\.closest\('\.bd-card, \.bd-docbar, \.bd-frame-t'\)/.test(board), 'D3b★ 捕获阶段要自己让开"已经有 owner 的双击"（改卡上的字 / 给板框起名不该顺手再开一个窗）')
  yes(/onKeep=\{\(p\) => keepQuick\(/.test(board), 'D4★ 「留到板上」接到了 `keepQuick`（不是接的空气 —— 点了没反应最难查）')

  /* Ctrl+K 那条全局键：**必须排在 `inField` 那道闸之前**，
     否则"我正写着笔记，突然想问一个词"的时候按了没反应 —— 那正是最要用它的时刻。 */
  const hotkey = board.indexOf("e.key === 'k'")
  const gate = board.indexOf('if (inField(e.target)) return')
  yes(hotkey > 0 && gate > 0 && hotkey < gate, 'D5★★ Ctrl+K 排在 `inField` 那道闸**之前**（正在打字时也要能唤起）')

  /* Esc 必须挂在 document 的**捕获**阶段 —— 写在输入框的 onKeyDown 里的话，
     点过按钮之后焦点不在输入框上，Esc 就没反应了（AskBox 2026-09-22 的老坑）。 */
  yes(/document\.addEventListener\('keydown', onKey, true\)/.test(component), 'D6 Esc 挂在 document 的捕获阶段（不管焦点在哪儿都能关）')
  yes(/e\.stopPropagation\(\)/.test(component.slice(component.indexOf('const onKeyDown'))), 'D7★ 输入框里的按键不许漏到板上（在这儿打一个 `e` 不能被切成橡皮）')

  /* 最后一件：服务端那个口加了没有。没加的话前端发过去会被当成公式的请求，
     把别的东西当成这个词的解释显示出来 —— 而那正是"回声校验"要挡的事。 */
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8')
  yes(/api\/lookup/.test(server), 'D8 服务端有 `/api/lookup` 这个口')
  yes(/mode === 'lookup'/.test(readFileSync(new URL('../server-ocr.js', import.meta.url), 'utf8')), 'D9 server-ocr.js 认 `mode: lookup`（漏了这一行它会把查词当成公式那一路，静默返回别的东西）')
  yes(/body\.mode !== 'lookup'/.test(readFileSync(new URL('../src/lib/lookup.js', import.meta.url), 'utf8')), 'D10★ 前端有**回声校验**（老服务端会把结果塞进别的字段，不查这一条就是静默显示错东西）')

  /* ── [E] 没有键盘的那半边（2026-09-28，用户问的原话：「surface 没键盘的时候
     怎么摁这些快捷键」）──────────────────────────────────────────────────
     这个应用是给 Surface / 平板用的 —— 一个只能靠 Ctrl 摁出来的入口，
     对那类用户等于**不存在**。下面这几条专门盯这件事，别到最后才在平板上发现用不了。 */
  const bar = readFileSync(new URL('../src/components/BoardBar.jsx', import.meta.url), 'utf8')
  /* ⚠ `() => toggleLook()` 那层是必需的：直接写 `onLook={toggleLook}` 的话，
     onClick 把**事件对象**当成横坐标送进去，位置算出 NaN —— 症状是"点了没反应"。 */
  yes(/onLook=\{\(\) => toggleLook\(\)\}/.test(board), 'E1★ 工具条那条路接到了同一个 `toggleLook`（两处各写一份，"手工唤起时不替他编词"这种约定迟早只对一边成立）')
  yes(/onLook/.test(bar) && /data-tool="look"/.test(bar), 'E2★ 工具条上**真有一颗**「🔍 速查」（Ctrl+K 的替身必须在屏幕上找得到）')
  yes(/LOOK_PRESS_MS/.test(board) && /pointerType !== 'touch'/.test(board), 'E3★ 触屏那条路认的是 touch / pen（鼠标那边双击和快捷键都好好的，给它加长按只是多个误触源）')
  yes(/onPointerDownCapture=\{onStagePointerDownCapture\}/.test(board), 'E4★ 长按挂在 **pointerdown 的捕获阶段**（和双击同一道车闸 —— 手柄上的 stopPropagation 会把它也掐死）')
  yes(/onPointerUpCapture=\{cancelPress\}/.test(board), 'E5 抬手 / 取消要掐掉定时器（不然"按一下就走"之后也会飞出一个窗）')
  yes(/LOOK_PRESS_SLOP/.test(board) && /Math\.abs\(e\.clientX - p\.x\)/.test(board), 'E6 手指动了就不算长按（平移/框选长得都是"按下 + 移动"）')
  /* 双击和长按**必须共用一份取词**：手势各不相同，"怎么从课件里挑出一个词"只有一处说话。 */
  yes((board.match(/lookWordAt\(/g) || []).length >= 3, 'E7★ 双击和长按共用 `lookWordAt`（同一件事两份实现必错其一）')
  yes(/bd-look-x/.test(component), 'E8 窗上有关闭按钮（没有 Esc 的时候，这是唯一的退路）')
  yes(/Ctrl\+K/.test(readFileSync(new URL('../src/components/BoardHelp.jsx', import.meta.url), 'utf8')), 'E9 帮助面板里写了 Ctrl+K 和它的按钮替身')
}

console.log(
  fails
    ? `\n${fails} 项失败（共 ${checks} 条断言）`
    : `\n全部通过（${checks} 条断言）—— 纯逻辑这一半没问题；真按 Ctrl+K、真双击取词、真落成一张卡那三条，见 check-look-browser.js`
)
process.exitCode = fails ? 1 : 0
