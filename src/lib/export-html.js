/* 「一条笔记 → 一个能发出去的单文件网页」。
 *
 * 用户要的是：**把笔记发给同学、或者发到网上**。
 * 障碍是笔记里那三样机器记号只有这个程序认得：
 *   `$…$`   公式 —— 在别处就是一段乱码
 *   `[[B]]` 指向某个量 —— 在别处就是两个方括号
 *   缩进     层级 —— 在别处就是一堆空格
 * 所以导出要做的不是"复制文件"，是**把这三样翻译成人人也看得懂的样子**。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────
 * ① **不重新实现渲染**。"怎么读一行字"是 lib/inline.js，
 *    "一行有哪些字段"是 lib/parse.js，公式是 KaTeX。这里只负责**排版和打包**。
 *    自己再写一份的下场：屏幕上是好的、发出去缺个根号，而你要等到同学问才晓得。
 *
 * ② **纯函数**。输入笔记文本、输出一个字符串。不碰 DOM、不碰磁盘、不读时间以外的外部状态。
 *    于是它能在 node 里直接断言（scripts/check-export.js），不用开浏览器。
 *
 * ③ **自包含**。发出去的那个文件**断网也要能看**。所以公式字体是嵌进去的，
 *    不是从 CDN 拉的 —— 对方可能在地铁上、可能公司网络拦了字体站。
 *    代价是文件大一点（约 1 MB），但那是"点开就能看"的价钱，值。
 *
 * ── 产出长什么样（用户 2026-09-17 定的：单栏文章式）──────────────────
 *   一个标题 → 各节依次排下来 → 每个节点是一张"名字 + 字段列表"的小块 →
 *   量那一支（字典）收成底部的「名词表」，全篇点 [[B]] 滚过去。
 *   没有侧边栏 —— 手机上从头滑到尾是最舒服的，而用户主要在手机看。
 */

import { displayBody, parseDoc, cleanName } from './parse.js'
import { inlineToHtml, esc } from './inline.js'

/* 行的锚点前缀。一眼能看出是"导出文档里的锚点"，不会和别的东西撞。 */
const ANCHOR = 'n'

/**
 * 一条笔记 → 一个完整的 HTML 文档字符串。
 *
 * @param {string} text   笔记原文（data/ 里那个 .md 的内容）
 * @param {object} opts
 *   title     文档标题（默认取第一条 `# 标题`，没有就用文件名）
 *   fileName  文件名（只为了让标题有个兜底 + 页脚写一句来源）
 *   at        导出时间（Date 或 ISO 串）—— 传进来是为了**可测**（纯函数不自己看表）
 *   renderMath(latex) → 排好的 HTML；**必须注入**（见下面那段说明）
 *   fonts     { '族-变体': { family, weight, style, b64 } } 要内联的字体，见 fonts.js
 *   fontCss   字体族名 → CSS font-family（同样来自 fonts.js / 调用方）
 */
export function exportNoteHtml(text, opts = {}) {
  const { title, fileName = '', at = new Date(), fonts = {}, fontCss = {}, renderMath } = opts
  const doc = parseDoc(text)

  /* ★ `renderMath` 必须由调用方注入，这个文件**不 import katex**。
     为什么：服务端（server-export.js）也要跑同一份排版，而 server.js 的底线是
     "没有任何第三方依赖"—— 详见 lib/inline.js 文件头那段（第一版就是在这里
     import 了 katex，结果导出自检里服务根本起不来，报的错还像"依赖装坏了"）。
     浏览器侧不需要调这个函数（导出只在服务端做），所以这里不提供默认值：
     没注入就别指望公式能排 —— 那也正是降级时该有的样子（原文摆出来）。
     调用方：server-export.js 注的是真 katex。 */
  const math = typeof renderMath === 'function' ? renderMath : () => null

  const docTitle = String(title || '').trim() || guessTitle(doc) || fileName.replace(/\.md$/i, '') || '笔记'
  const stamp = fmtStamp(at)

  /* 每个节点一个锚点：`#n3`。用**数组下标**而不是 parse.js 给的 `n0/n1…` id ——
     那些 id 是"这份文档里第几个节点"，本来就是这个意思，但我不想让锚点长得
     和内部 id 一模一样（以后内部 id 换形状了，导出文档的链接不该跟着坏）。 */
  const anchorById = new Map() // nodeId → 'n3'
  doc.nodes.forEach((n, i) => anchorById.set(n.id, ANCHOR + i))

  /* ★ 下面这两个函数**直接交给 inline.js 用**，所以名字必须和它的契约对上：
       `resolve(title)`  → 那个引用指向的节点（没有就回 null）
       `anchorOf(title)` → 那个节点在本文档里的锚点 id
     ⚠ 2026-09-18 踩过：这里原来叫 `anchorForTitle`、而且 `anchorOf` 是个 **Map**，
       名字既对不上、形状也不对 —— `inlineToHtml` 收到的 `resolve` 是 undefined、
       `anchorOf` 又不可调用。结果是**每一个 `[[B]]` 都走了"断引用"分支**：
       导出文档里全是灰虚线、点不动。而屏幕上看不出异常（页面排得好好的），
       要等同学说"你这链接点不了"才知道。教训：跨文件传函数时，
       传的人用的名字和收的人要的名字，**得是同一套**（这里干脆就用收的人那套）。 */
  const resolve = (name) => doc.resolveOne(name) || null
  const anchorOf = (name) => {
    const target = doc.resolveOne(name)
    return target ? anchorById.get(target.id) || null : null
  }

  /* ★ 引用在导出文档里**把方括号摘掉**，只留名字（`[[B]]` → `B`）。
     为什么和界面不一样：界面上使用者知道 `[[B]]` 是什么记号，而且它是"点一下跳过去"
     的按钮，留记号反而有用（一眼看出这是个引用）。但导出文档是**发给同学的**——
     他没读过这个程序的说明，看到的就是一对莫名其妙的中括号，
     那正是导出要消掉的三样机器记号之一（见文件头）。
     摘掉之后靠样式表达"这是个可点的词"：蓝色 + 下划线（.ref 那段 CSS）。
     ⚠ 断引用**不摘**：那种情况下要让人看出"这里本来该有个链接"，
       留个记号（灰色虚线）比一个光秃秃的词更诚实 —— 人家才知道是原文缺定义，
       而不是自己读漏了。 */
  const refLabel = (name) => {
    const target = doc.resolveOne(name)
    return target ? cleanName(name).trim() || name : `[[${name}]]`
  }

  /* renderNode / renderGlossary 自己要用 anchorById 去查"我这个节点是几号锚点"，
     所以两个 map/函数都塞进 ctx 里 —— 它们和 inline 需要的**同一个 anchorOf**
     共处一个对象，就不存在"两套名字对不上"的空间了。 */
  const ctx = { anchorById, anchorOf, resolve, refLabel, renderMath: math }

  const bodyHtml = renderSections(doc, ctx)
  const glossaryHtml = renderGlossary(doc, ctx)

  return HTML_SHELL({
    title: docTitle,
    source: fileName,
    stamp,
    fonts,
    fontCss,
    body: bodyHtml,
    glossary: glossaryHtml,
    /* 大标题也要走同一套读法（标题里可能有 $公式$、可能有 [[引用]]）。
       这里单独给个只有排公式的 ctx：大标题里的引用**不做成链接**，
       因为它就在页面最顶上、点它跳到自己没有意义。 */
    titleCtx: { renderMath: math },
    stats: {
      nodes: doc.nodes.length,
      quantities: doc.quantityNodes.length,
    },
  })
}

/** 文档标题：找最浅的那个 `# 标题`。找不到就没有（调用方兜底）。 */
function guessTitle(doc) {
  const heads = doc.nodes.filter((n) => n.isHeading)
  if (!heads.length) return ''
  const min = Math.min(...heads.map((n) => n.level || 6))
  const top = heads.find((n) => (n.level || 6) === min)
  return top ? String(top.title || '').trim() : ''
}

/* ═══════════ 正文 ═══════════
 *
 * 单栏排版里，一棵树最好的样子就是**按层级缩进的嵌套块**：
 * 标题节不缩，它的子节点往右挪一点，再往下一层再挪一点。
 * 缩进用 CSS 的 `margin-left`（挂在每一层的容器上），不用空格 ——
 * 用空格的话复制文字出去会带一堆前导空白。
 *
 * ⚠ `## 节` 和 `- 项` 是两种东西，排版上要分开：
 *   标题 → 一条横分隔线 + 大字号（它是"翻页"的地方）
 *   项   → 一个小圆点 + 名字一行、字段若干行（它是"一条知识"）
 */
function renderSections(doc, ctx) {
  const roots = doc.root.children
  if (!roots.length) {
    return `<p class="empty">这份笔记还是空的。</p>`
  }
  return roots.map((n) => renderNode(n, ctx, 0)).join('\n')
}

function renderNode(node, ctx, depth) {
  const indent = Math.min(depth, 6) * 18 // 世界像素式的固定缩进；超过 6 层就不再往右挤
  const style = indent ? ` style="margin-left:${indent}px"` : ''

  if (node.isHeading) {
    const level = Math.max(2, Math.min(6, node.level || 2))
    return `<section class="sec"${style}>
  <h${level} class="sec-h" id="${esc(ctx.anchorById.get(node.id) || '')}">${inlineToHtml(node.title, ctx)}</h${level}>
${node.children.map((c) => renderNode(c, ctx, depth + 1)).join('\n')}
</section>`
  }

  const fields = displayBody(node)
  /* 兜底（和 Preview.jsx 一模一样）：正文里有字但一段都没认出来，
     那就当普通说明摆出来。**宁可丑，不可丢** —— 从前这些字会静默消失，
     而用户看到的是"格式没生效"，其实是内容被吃了。 */
  if (fields.length === 0 && node.body.trim()) {
    fields.push({ key: '说明', text: node.body.trim() })
  }

  const titleHtml = inlineToHtml(node.title, ctx)
  const fieldsHtml = fields
    .map(
      (f) => `<div class="f k-${esc(f.key)}"><span class="fk">${esc(f.key)}</span><span class="fv">${inlineToHtml(f.text, ctx)}</span></div>`
    )
    .join('\n')

  return `<div class="item"${style} id="${esc(ctx.anchorById.get(node.id) || '')}">
  <div class="it-title">${titleHtml}</div>
${fieldsHtml ? `<div class="it-fields">\n${fieldsHtml}\n</div>` : ''}
${node.children.length ? `<div class="it-kids">\n${node.children.map((c) => renderNode(c, ctx, depth + 1)).join('\n')}\n</div>` : ''}
</div>`
}

/* ═══════════ 底部的「名词表」 ═══════════
 *
 * 量那一支（`- [[B]] | 磁感应强度，T。…`）在原文里是一节，但它读起来像字典。
 * 收成底部一张表：名字 + 说明 + "有几处用到它"。这样正文干净、查词方便，
 * 而且**点击跳转的目标一定在**（不用在正文里找 B 到底定义在哪一节）。
 *
 * ⚠ 只收**叶子**（parse.js 的 quantityNodes 就是这个口径）—— 中间那些
 *   分类节点（比如"电磁学的量"）不是名词，收进来只会让表变乱。
 */
function renderGlossary(doc, ctx) {
  const nodes = doc.quantityNodes
  if (!nodes.length) return ''
  const rows = nodes
    .map((n) => {
      const name = cleanName(n.title || '').trim() || '（没名字）'
      const fields = displayBody(n)
      const desc = fields.map((f) => f.text).filter(Boolean).join(' ')
      const count = doc.refCount.get(n.id) || 0
      return `<div class="gl-row" id="${esc(ctx.anchorById.get(n.id) || '')}">
  <div class="gl-name">${inlineToHtml(n.title, ctx)}</div>
  <div class="gl-desc">${inlineToHtml(desc, ctx)}</div>
  ${count ? `<div class="gl-count">${count} 处用到</div>` : ''}
</div>`
    })
    .join('\n')
  /* ⚠ 这句提示语别说"点 [[名字]]"—— 导出文档里引用**已经把方括号摘掉了**
     （见 exportNoteHtml 里 refLabel 那段说明），正文里根本看不到 `[[ ]]`。
     照原文说会让人对着页面找一对不存在的括号。 */
  return `<section class="glossary" id="glossary">
  <h2 class="sec-h">名词表</h2>
  <p class="gl-hint">全篇出现的 ${nodes.length} 个量，按原文顺序。正文里点蓝色的名字会跳到这儿。</p>
${rows}
</section>`
}
function fmtStamp(at) {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ═══════════ 外壳 ═══════════
 *
 * 这里是一整份 HTML 文档（不是片段 —— 导出文件要能双击打开）。
 *
 * ── 为什么样式全写死在字符串里 ──────────────────────────────────────
 * 这是**发出去**的文件，不能 import 应用的 styles.css：
 *   · 那个文件里全是界面的东西（面板、工具条、白板），对读者毫无意义，还会打架；
 *   · 而且它是深色的，读者可能想打印、想复制到别处 —— 要浅色、要能读。
 * 所以这里是一份**只属于导出文档**的样式表。它和应用长得像（同一套字体思路），
 * 但字色、底色、行宽都是为"读一篇文章"定的。
 *
 * ── 内联字体 ────────────────────────────────────────────────────────
 * `@font-face` 里 src 用 `data:font/woff2;base64,…`。为什么不用 `url()` 指外部：
 * 读者不一定联网、也不一定允许加载（见文件头 ③）。
 * ⚠ 只嵌**真的用到的**字形 —— 59 个 KaTeX 字体全塞进去文件会到 1 MB 多，
 *   而一份笔记实际用到的数学符号通常也就十几个（见 fonts.js 的 collectFonts）。
 */
function HTML_SHELL({ title, source, stamp, fonts, fontCss, body, glossary, titleCtx, stats }) {
  /* 每个 `{ family, weight, style, b64 }` 一条 @font-face。
     ⚠ weight/style 必须写对（见 lib/fonts.js 的说明）：不写的话浏览器会拿
       常规字形去**合成**粗体/斜体，看着像糊了一层，其实是假粗。 */
  const fontFaces = Object.values(fonts)
    .map(
      (f) =>
        `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style};` +
        `src:url(data:font/woff2;base64,${f.b64}) format('woff2');font-display:swap}`
    )
    .join('\n')

  const katexFamily = fontCss.katex || 'KaTeX_Main, "Times New Roman", serif'
  const bodyFamily = fontCss.body || "'LXGW WenKai', '霞鹜文楷', 'KaiTi', '楷体', 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
${fontFaces}
:root{
  --ink:#1c1f24; --mid:#5a6473; --dim:#8b95a3; --line:#e2e6ec;
  --paper:#ffffff; --tint:#f6f8fb; --accent:#2b5ea8; --warn:#a33a2a;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:${bodyFamily};
  font-size:17px; line-height:1.85;
}
.wrap{max-width:760px; margin:0 auto; padding:34px 22px 80px}
header.doc{border-bottom:2px solid var(--line); padding-bottom:16px; margin-bottom:26px}
h1.doc-title{margin:0 0 8px; font-size:29px; line-height:1.35; font-weight:500; letter-spacing:.2px}
.doc-meta{font-size:13px; color:var(--dim); display:flex; flex-wrap:wrap; gap:6px 14px}
.doc-meta .dot{color:var(--line)}

/* ---- 节 ---- */
.sec{margin:30px 0 0}
h2.sec-h,h3.sec-h,h4.sec-h,h5.sec-h,h6.sec-h{
  margin:0 0 12px; font-weight:500; line-height:1.4;
  padding-bottom:7px; border-bottom:1px solid var(--line);
}
h2.sec-h{font-size:22px} h3.sec-h{font-size:20px}
h4.sec-h{font-size:18px} h5.sec-h,h6.sec-h{font-size:17px; border-bottom:none; color:var(--mid)}

/* ---- 一个条目 ---- */
.item{margin:14px 0; padding:10px 14px; border-radius:10px; background:var(--tint)}
.it-title{font-weight:500; font-size:17.5px; line-height:1.6; overflow-wrap:anywhere}
.it-fields{margin-top:6px}
.f{display:flex; gap:10px; align-items:baseline; padding:2px 0; overflow-wrap:anywhere}
.fk{
  flex:none; font-size:12.5px; color:var(--mid); background:#fff;
  border:1px solid var(--line); border-radius:6px; padding:1px 7px; line-height:1.7;
  min-width:64px; text-align:center;
}
.fv{flex:1; min-width:0}
.it-kids{margin-top:8px; border-left:2px solid var(--line); padding-left:12px}

/* 字段颜色（和界面里那套一个意思：公式亮一点、易错红一点）*/
.f.k-公式 .fv{color:#123c6e}
.f.k-易错 .fv,.f.k-注意 .fv{color:var(--warn)}
.f.k-题型 .fv,.f.k-方法 .fv{color:#2f6b4f}

/* ---- 引用与公式 ---- */
.ref{
  color:var(--accent); text-decoration:none; border-bottom:1px solid rgba(43,94,168,.3);
  font-size:.94em; white-space:nowrap;
}
.ref:hover{background:rgba(43,94,168,.08)}
.ref.dangling{color:var(--dim); border-bottom:1px dashed var(--dim); cursor:default}
.math{font-family:${katexFamily}}
.math-bad{color:var(--warn); background:#fdf1ee; border-radius:4px; padding:0 4px; font-family:var(--mono,monospace); font-size:.92em}

/* ---- 底部名词表 ---- */
.glossary{margin-top:46px; padding-top:8px}
.gl-hint{font-size:13.5px; color:var(--dim); margin:0 0 14px}
.gl-row{padding:9px 0; border-bottom:1px solid var(--line)}
.gl-name{font-weight:500}
.gl-desc{font-size:15.5px; color:#3b434f; margin-top:2px; overflow-wrap:anywhere}
.gl-count{font-size:12.5px; color:var(--dim); margin-top:3px}

footer.doc{margin-top:44px; padding-top:14px; border-top:1px solid var(--line); font-size:12.5px; color:var(--dim)}
.empty{color:var(--dim)}

/* ---- 手机上：缩进收窄、字号略小（横向空间最贵）---- */
@media (max-width:600px){
  body{font-size:16px; line-height:1.8}
  .wrap{padding:22px 15px 60px}
  h1.doc-title{font-size:24px}
  .it-kids{padding-left:9px}
  .f{flex-direction:column; gap:1px}
  .fk{min-width:0; align-self:flex-start}
}

/* ---- 打印 / 存 PDF ---- */
@media print{
  body{font-size:12pt; background:#fff}
  .wrap{max-width:none; padding:0}
  .item{background:none; border:1px solid var(--line); break-inside:avoid}
  .ref{color:var(--ink); border-bottom:none}
  .glossary{break-before:page}
  a{text-decoration:none}
}
</style>
</head>
<body>
<div class="wrap">
<header class="doc">
<h1 class="doc-title">${inlineToHtml(title, titleCtx || {})}</h1>
<div class="doc-meta">
<span>${stats.nodes} 个节点 · ${stats.quantities} 个量</span>
${source ? `<span class="dot">·</span><span>${esc(source)}</span>` : ''}
${stamp ? `<span class="dot">·</span><span>导出于 ${esc(stamp)}</span>` : ''}
</div>
</header>

<main>
${body}
</main>

${glossary}

<footer class="doc">
这份是从 studyhelper 导出的。原文是 <code>${esc(source || '笔记')}</code>，
改内容要在那个程序里改，改完重新导出一份 —— <b>这个文件不会自己更新</b>。
</footer>
</div>
</body>
</html>
`
}
