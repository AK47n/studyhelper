/* 「一小段文本 → 能画出来的东西」——**笔记正文的读法只有这一份**。
 *
 * 从前这段逻辑住在 `components/Preview.jsx` 里（`inlineHtml`），只有 React 能用。
 * 2026-09-18 起导出（`export-html.js`）也要同一套读法，于是把它搬到这里。
 *   · 为什么不写两份（一份给 React、一份给导出）：那正是这个仓库演过两次的坑
 *     （"其中一份带自检，另一份是真正跑在路上的"）。导出的公式和界面上的公式
 *     必须是同一个东西 —— 不然会出现"屏幕上好好的、导出去少了个根号"，
 *     而那种错要等到你把文件发给同学才知道。
 *
 * ── ★ 这个文件**不许 import katex**（2026-09-18 踩过一次，记下来）──────
 * 导出是在服务端写文件的，所以 `server.js` 也要用这个文件。
 * 而 `server.js` 的底线是「**没有任何第三方依赖，只用 node 内置模块**」——
 * 那条底线有实际意义：`node_modules` 整个没了、`npm i` 也没跑过，
 * 双击那个 bat 照样得能打开、能看笔记。
 *
 * 第一版就在这里写了 `import katex from 'katex'`，症状是：
 * 导出自检（它把 server.js 复制到临时目录跑）**服务根本起不来**，
 * 报 `ERR_MODULE_NOT_FOUND: Cannot find package 'katex'`，
 * 而错误话说得像"你的依赖装坏了"，其实是我把一个浏览器模块拖进了服务端。
 *
 * 现在的分法：
 *   · 这个文件负责**切文本**（纯字符串处理，零依赖）—— 服务端和浏览器都用它
 *   · `renderHtml.js` 负责**排公式**（import katex）—— 只有浏览器构建才碰
 *   · 服务端自己那份在 `server-export.js`（用 katex 的 CJS 产物，见那个文件）
 * 于是"服务端不依赖第三方"这条底线**还在**，而两份的**切法只有一份**。
 */

/** HTML 转义：只有在**拼字符串**（导出）时才用得上。React 那边自己会转。 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/** `\$` 的替身字符。用一个普通文本里不会出现的控制字符，切完再换回来。 */
const DOLLAR = '\u0002'

/**
 * 把一段文本切成零件。**只扫一遍**，所有出口共用这一趟的结果。
 *
 * 返回三种零件：
 *   { type:'math',  latex }      一段公式（里面已经不含 $）
 *   { type:'ref',   title }      一个 [[引用]]
 *   { type:'text',  text }       普通文字（已经不含公式和引用）
 *
 * ── 三件事，顺序不能换 ──────────────────────────────────────────────
 *   ① 先把 `\$` 护起来（它是"真的美元符号"，不是公式的开头）
 *   ② 按 `$` 切成 奇/偶 两半：奇数段是公式，偶数段是普通文字
 *   ③ 普通文字里再切 `[[引用]]`
 * 顺序换了的后果：先切引用的话，公式里写 `[[` 的（矩阵、双括号）会被当成引用。
 *
 * @param {string} text
 */
export function splitInline(text) {
  const src = String(text ?? '')
  const parts = []
  const chunks = src.replace(/\\\$/g, DOLLAR).split('$')
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      // 奇数段 = 夹在一对 $ 中间 = 公式
      parts.push({ type: 'math', latex: chunk.replaceAll(DOLLAR, '$') })
      return
    }
    // 偶数段 = 普通文字，里面可能还夹着 [[引用]]
    const rest = chunk.replaceAll(DOLLAR, '$')
    const re = /\[\[([^[\]]+)\]\]/g
    let last = 0
    let m
    while ((m = re.exec(rest))) {
      if (m.index > last) parts.push({ type: 'text', text: rest.slice(last, m.index) })
      parts.push({ type: 'ref', title: m[1].trim() })
      last = m.index + m[0].length
    }
    if (last < rest.length) parts.push({ type: 'text', text: rest.slice(last) })
  })
  return parts
}

/**
 * 零件 → HTML 字符串。
 *
 * ★ `renderMath` 是**传进来的**，不是 import 的 —— 这就是"服务端不许依赖 katex"
 *   这条底线的落点。浏览器侧传 renderHtml.js 里那个（真 katex 排的），
 *   服务端传自己的那个（见 server-export.js）。两边的**切法**是这一份。
 *
 * @param {string} text
 * @param {object} opts
 *   renderMath(latex) → 排好的 HTML 字符串；排不出来回 null（那时把原文摆出来）
 *   resolve(title)    → 引用指向的那个节点（没有就回 null）—— 决定它是不是"断的"
 *   anchorOf(title)   → 那个节点在导出文档里的锚点 id（跳转链接的 href）
 *   refLabel(title)   → 标签上写什么（默认 [[名字]] 原样）
 */
export function inlineToHtml(text, { renderMath, resolve, anchorOf, refLabel } = {}) {
  return splitInline(text)
    .map((p) => {
      if (p.type === 'math') {
        const html = renderMath ? renderMath(p.latex) : null
        if (html) return `<span class="math">${html}</span>`
        /* 排不出来：原文摆出来，标成坏的。**不吞掉** ——
           你发出去的东西里如果有个公式坏了，得让人看得出来是这里坏了。
           **宁可丑，不可丢**（和 lib/formula.js、components/Tex.jsx 同一条规矩）。 */
        return `<span class="math-bad" title="公式还没写完">${esc(p.latex)}</span>`
      }
      if (p.type === 'ref') {
        const target = resolve ? resolve(p.title) : null
        const label = refLabel ? refLabel(p.title) : `[[${p.title}]]`
        if (target && anchorOf) {
          return `<a class="ref" href="#${esc(anchorOf(p.title))}">${esc(label)}</a>`
        }
        // 断引用：**不做成链接** —— 点过去没东西的链接比看着不像链接更让人困惑
        return `<span class="ref dangling" title="${esc(p.title)} 还没有定义节点">${esc(label)}</span>`
      }
      return esc(p.text)
    })
    .join('')
}
