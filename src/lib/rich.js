/* 「讲义卡」的正文渲染：**一小段人话 + 行内公式** → 能画出来的 HTML。
 *
 * ── 为什么要有这一层（2026-09-20，用户原话）────────────────────────────
 * 「讲解中遇到的公式现在仍然不是美观的表示方法，而是编辑态的，我想要美观的显示
 *   才有利于学生看懂吧」。
 * 老师讲解里一定会夹式子（`$e^{j\\omega_0 t}$` 这种）。板上的**文字卡是纯文本**
 * （那条设计没变：手写的笔记不该被当 Markdown 渲染），所以这里另开一种卡：
 * 卡上带 `rich: true` 的那些按这一份渲染 —— 段落、`- ` 列表、`$…$`/`$$…$$` 公式、
 * `**…**` 粗体（语法就这四样，见下面）。
 *
 * ── 只有一份实现（这条最要紧）──────────────────────────────────────────
 * 渲染和**量尺寸**必须逐像素是同一套 DOM，否则贴到板上卡片会互相压住
 *   （doc-cards.js 的文件头写着这条账：量错高度 = 压住，而"压住"在板上看不出来）。
 * 所以两边**共用这个 `richHtml`**：Card 用 `dangerouslySetInnerHTML`，
 * 量尺寸的台子用 `node.innerHTML = richHtml(...)`。谁都不许自己再拼一遍。
 *
 * ── 语法就这四样，**故意不做完整 Markdown** ────────────────────────────
 *   ① 空行分段；② 行首 `- ` / `· ` = 列表项；③ `$$…$$` 摆开看、`$…$` 行内；
 *   ④ `**…**` 粗体 —— 整节课提纲卡那几个小标题（"骨架 / 必记 / 核心式子"）靠它，
 *      见 `strongHtml` 那段说明。
 *     ★ `$$…$$` **写在句子中间也算数**（模型常这么写）：句子的前半句、式子、
 *       后半句会各自成一段。只有"整行"才认它的那版害过一次 —— 见 `splitDisplay`。
 * 别的（标题、链接、代码块、斜体、表格）一律当普通文字 —— 少一个语法就少一类"渲染出来
 * 和作者想的不一样"。模型写多了也不怕：它只会变成一段人话。
 *
 * ── ★★ 排过的正文**只排一次**（2026-09-25，见 renderMath.js 文件头那段实测）──────
 *   缩放时 React 会重渲染那批卡片，`richHtml` 于是被一遍遍重跑：切段落、切列表、
 *   再把每个 `$…$` 交给 KaTeX 重排 —— 而正文**一个字都没改**，产物逐字节相同
 *   （所以 DOM 一点没动，那笔钱纯白烧）。这里按**原文**缓存整段结果：
 *   命中就直接回，连 `splitDisplay` 那几个循环都不走。
 *   ⚠ 正文一改就是新的键（`card.text` 本身变了），不存在"改了还拿旧的"这种事。
 */
import { katexHtml } from './renderMath.js'

const KOPTS = { throwOnError: false, strict: false, trust: false, output: 'html' }

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** 一段 LaTeX → 排好的 HTML。排不出来就原样吐回去（`$…$` 那种半截式子不该让整张卡空着）。
 *  ⚠ 排式子的钱交给 `renderMath.js` 的缓存（同一个式子只排一次，见文件头）。 */
function mathHtml(tex, display) {
  const src = String(tex == null ? '' : tex).trim()
  if (!src) return ''
  const html = katexHtml(src, { ...KOPTS, displayMode: !!display })
  return html == null ? `<code class="bd-rich-raw">${esc(src)}</code>` : html
}

/** 一行里的 `$$…$$`（"摆开看"的式子）切开 → `[{ t: 'text' | 'tex', s }]`。
 *
 * ── ★★ 找配对的 `$$` **只有这一份**（2026-09-23 那个 bug 的根子）──────────
 * 从前是两支各认各的：只有**整行**是 `$$…$$` 的才排成式子（richHtml 里那个
 * `^\$\$(.+)\$\$$`），行内那一支（`inlineHtml`）只认**一对** `$`。
 * 而模型经常把 `$$…$$` 写在句子中间 —— 那一支就把 `$$` 当成"一个空的行内公式"
 * （`$` 和紧跟的 `$` 配对），式子本身落到"普通文字"里，**原样躺在卡片上**。
 * 用户报的「board4.1 第 33 页讲解卡公式没显示出来」就是这个：
 * 卡上是 `\frac{1}{\sqrt{1+4\pi^2}}` 这一串源码，一个公式都没排。
 * 现在段落（切成独立块）和列表项（留在 `<li>` 里摆开）都问这一个函数。
 *
 * 两条边界，故意这么定：
 *   · `\$` 是转义的美金符号，**不算**定界符（写"价格 \$5"不该被当成公式开头）；
 *   · 没配上对的 `$$`（模型少写了一半）**不切**，整段当普通文字 —— 宁可丑，
 *     不可丢（和 `mathHtml` 排不出来时吐原文是同一条规矩）。
 */
function splitDisplay(line) {
  const out = []
  let rest = String(line == null ? '' : line)
  for (;;) {
    /* 开头：第一个**没被转义**的 `$$` */
    let at = -1
    for (let i = 0; i + 1 < rest.length; i += 1) {
      if (rest[i] === '\\') {
        i += 1
        continue
      }
      if (rest[i] === '$' && rest[i + 1] === '$') {
        at = i
        break
      }
    }
    if (at < 0) break
    /* 收尾：后面第一个**没被转义**的 `$$` */
    let end = -1
    for (let i = at + 2; i + 1 < rest.length; i += 1) {
      if (rest[i] === '\\') {
        i += 1
        continue
      }
      if (rest[i] === '$' && rest[i + 1] === '$') {
        end = i
        break
      }
    }
    if (end < 0) break
    const tex = rest.slice(at + 2, end)
    if (!tex.trim()) break // `$$$$`：空式子 → 不当定界符，整段原样摆出来
    if (at > 0) out.push({ t: 'text', s: rest.slice(0, at) })
    out.push({ t: 'tex', s: tex })
    rest = rest.slice(end + 2)
  }
  if (rest) out.push({ t: 'text', s: rest })
  return out.length ? out : [{ t: 'text', s: line }]
}

/** `**…**` → 粗体。★ 只认**成对**的，没配上对的原样摆着
 *  （模型只写了一半时不许把星号吞掉 —— 宁可丑，不可丢）。
 *
 *  为什么要有第四样（2026-09-23 才加的）：整节课提纲卡的正文是
 *  `**骨架**\n- …` 这种形状（`doc-summary.js` 拼的），而它走的就是这个 `richHtml` ——
 *  于是卡上一直显示着 `**骨架**` 这两个星号。要么给它这个语法，要么改生成那一侧；
 *  既然只有提纲卡在用它、而"小标题"本来就是它想要的语义，就在这一处认下来。 */
function strongHtml(s) {
  return String(s == null ? '' : s).replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
}

/** 行内那一小段：把 `$…$` 挑出来交给 KaTeX，其余原样转义（顺带认 `**粗体**`）。
 *  ⚠ `\$` 是转义的美金符号（不转义的话"价格 \$5"会被当成公式开头）。 */
function inlineMath(line) {
  let out = ''
  let rest = String(line == null ? '' : line)
  for (;;) {
    /* 开头：第一个**没被转义**的 `$`。
       ⚠ 从前这里是 `rest.indexOf('$')` —— 它不认 `\$`，于是"价格 \$5 和 \$6"
       会被当成"从 \$5 的 `$` 开始、到 \$6 的 `$` 结束"的一个公式（中间的"5 和 \"
       被拿去排）。收尾那一头早就有跳过 `\` 的逻辑了，只有开头这一头漏着
       （2026-09-23 写 `splitDisplay` 的自检时撞出来）。 */
    let at = -1
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '\\') {
        i += 1
        continue
      }
      if (rest[i] === '$') {
        at = i
        break
      }
    }
    if (at < 0) break
    /* 找配对的收尾 `$`（同一行里、不是转义的那种） */
    let end = -1
    for (let i = at + 1; i < rest.length; i += 1) {
      if (rest[i] === '\\') {
        i += 1
        continue
      }
      if (rest[i] === '$') {
        end = i
        break
      }
    }
    if (end < 0) break
    const tex = rest.slice(at + 1, end)
    out += strongHtml(esc(rest.slice(0, at).replace(/\\\$/g, '$')))
    out += tex.trim() ? mathHtml(tex, false) : esc('$' + tex + '$')
    rest = rest.slice(end + 1)
  }
  return out + strongHtml(esc(rest.replace(/\\\$/g, '$')))
}

/** 一行 → HTML：`$$…$$` 摆开看、`$…$` 行内，其余原样转义。
 *  列表项走这一条（式子留在 `<li>` 里，说明跟在下面）。 */
function inlineHtml(line) {
  return splitDisplay(line)
    .map((seg) => (seg.t === 'tex' ? mathHtml(seg.s, true) : inlineMath(seg.s)))
    .join('')
}

/** 讲义正文 → HTML 的真正实现（外面那层 `richHtml` 只管缓存）。 */
function buildRichHtml(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim()
  if (!raw) return ''
  const blocks = []
  let cur = null // 现在这一段：{ kind: 'p' | 'ul', lines: [] }
  const flush = () => {
    if (cur && cur.lines.length) blocks.push(cur)
    cur = null
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) {
      flush()
      continue
    }
    const li = /^(?:[-*·])\s+(.*)$/.exec(t)
    /* 列表项：整条交给 `inlineHtml`（`$$…$$` 在 `<li>` 里摆开、`$…$` 行内）。
       ⚠ 判定要在切开**之前**做 —— 切开之后尾巴上那条"—— 说明"就不带 `- ` 了，
       它会掉出这个 `<li>`（提纲卡的"核心式子"正是 `- $$式子$$ —— 说明` 这个形状）。 */
    if (li) {
      if (!cur || cur.kind !== 'ul') {
        flush()
        cur = { kind: 'ul', lines: [] }
      }
      cur.lines.push(li[1])
      continue
    }
    /* 普通行：行里的 `$$…$$` **单独成段**摆开 —— 哪怕它写在句子中间
       （模型爱这么写；句子的前半句和后半句各成一段，式子夹在中间）。
       列表已经判过了，所以切开后的碎片一律是段落的文字。 */
    for (const seg of splitDisplay(t)) {
      if (seg.t === 'tex') {
        flush()
        blocks.push({ kind: 'tex', tex: seg.s })
        continue
      }
      const body = seg.s.trim()
      if (!body) continue
      if (!cur || cur.kind !== 'p') {
        flush()
        cur = { kind: 'p', lines: [] }
      }
      cur.lines.push(body)
    }
  }
  flush()

  return blocks
    .map((b) => {
      if (b.kind === 'tex') return `<div class="bd-rich-tex">${mathHtml(b.tex, true)}</div>`
      if (b.kind === 'ul') return `<ul class="bd-rich-ul">${b.lines.map((l) => `<li>${inlineHtml(l)}</li>`).join('')}</ul>`
      return `<p class="bd-rich-p">${inlineHtml(b.lines.join(' '))}</p>`
    })
    .join('')
}

/* 上限：板上讲义卡就那么多张，但一份几十页的课件能攒出几百条正文。
   满了整表清空（和 renderMath.js 那条同一个规矩：下次重排一遍而已）。 */
const RICH_MAX = 500
let richCache = new Map()

/** 讲义正文 → HTML。★ 按**原文**缓存（见文件头）：正文没改就直接回上一版。 */
export function richHtml(text) {
  const key = String(text == null ? '' : text)
  const hit = richCache.get(key)
  if (hit !== undefined) return hit
  const html = buildRichHtml(key)
  if (richCache.size >= RICH_MAX) richCache = new Map()
  richCache.set(key, html)
  return html
}
