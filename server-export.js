/* 服务端这一半的导出：**把笔记排成 HTML 的入口**。
 *
 * ── 为什么单开一个文件，而不是直接在 server.js 里调（2026-09-18）──────
 * `server.js` 的底线是「**没有任何第三方依赖，只用 node 内置模块**」。
 * 那条底线有实际意义：`node_modules` 没装、甚至整个删掉，双击那个 bat
 * 也照样得能打开、能看笔记、能画白板。
 *
 * 而"排公式"必须用 katex（和界面上是同一个，不然导出的公式和屏幕上的不一样）。
 * 所以那条依赖被**关在这个文件里**：
 *   · server.js 只 `import { exportNoteHtml } from './server-export.js'`
 *   · 这个文件负责把 katex 按 Node 能吃的形状拿出来，塞进 export-html 的注入点
 *
 * ── katex 怎么"按 Node 能吃的形状"拿出来 ────────────────────────────
 * 它是 CJS 包，但 `package.json` 里同时有 `exports` 映射。直接 `import katex from 'katex'`
 * 在 Node 里能行（Node 的 CJS 互操作）。**麻烦的是它找不到**：这个文件跑在
 * 项目根目录下，`node_modules` 就在旁边，所以找得到。
 * 真找不到（用户删了 node_modules）**不该让服务起不来** —— 那时候导出的公式
 * 会退到"原文摆出来"（`math-bad`），丑但能用。所以这里所有失败都吞掉、回 null。
 *
 * ★ 为什么不用 `createRequire`：`import katex from 'katex'` 在顶层会让
 *   **模块加载本身**失败（找不到包 = 整个文件 import 失败 = 服务起不来）。
 *   用动态 `import()` 包在 try 里，才是"加载不了也只是降级"。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportNoteHtml as renderExport } from './src/lib/export-html.js'

/* dist/assets 里是 KATEX_FONT_FAMILY 那些字体文件（vite 从 katex 包里拷出来的）。
   字体内联要用它，但**字体这块不在这里读** —— 它需要 fs，那是 server.js 的事
   （这个文件的职责只有"把 katex 接进来"）。 */

let katex = null
let tried = false

/** 懒加载 katex。失败就回 null —— 调用方走"公式原文摆出来"的降级路。 */
async function loadKatex() {
  if (tried) return katex
  tried = true
  try {
    const mod = await import('katex')
    katex = mod.default || mod
  } catch {
    /* 没装 katex：导出还能跑，公式不排。**不要让服务起不来**。 */
    katex = null
  }
  return katex
}

/** 让 server.js 在启动时"热身"一下：把 katex 提前加载好，
 *  这样第一次点导出不会因为动态 import 而多等一拍。
 *  ★ 但**等不到也不影响** —— 它只是个加速。 */
export function warmUp() {
  return loadKatex()
}

/* 排公式。参数必须和浏览器侧（lib/renderMath.js）**完全一致** ——
   不一致的下场是"自检说能排、导出来是红的"这种自相矛盾。 */
function renderMathToHtml(latex) {
  if (!katex) return null
  try {
    return katex.renderToString(String(latex ?? ''), {
      throwOnError: false,
      displayMode: false,
      output: 'html',
      strict: false,
      trust: false,
    })
  } catch {
    return null
  }
}

/**
 * 一条笔记的原文 → 一个完整的 HTML 文档字符串。
 *
 * @param {string} text     笔记原文
 * @param {object} opts     { title, fileName, at, fonts, fontCss }
 *                          fonts 由 server.js 读 dist/assets 得到（见 lib/fonts.js）
 */
export async function exportNoteHtml(text, opts = {}) {
  await loadKatex()
  /* ★ 把排公式的**能力**注进去（export-html 自己不 import katex /
     inline.js 也不 import katex —— 那两个文件服务端和浏览器共用）。
     这一句就是"服务端不依赖第三方"这条底线的接线处。 */
  return renderExport(text, { ...opts, renderMath: renderMathToHtml })
}

/* 保留一个路径常量给排查用：katex 包在哪儿（没装时是 undefined）。
   看得见比自己猜有用 —— "为什么公式没排出来"这个问题，
   有一半的答案是"katex 没找到"。 */
export function katexLocation() {
  try {
    return pathToFileURL(path.join(process.cwd(), 'node_modules/katex')).pathname
  } catch {
    return ''
  }
}
