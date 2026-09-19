/* 「LaTeX → 排好的 HTML」——**用 katex 的那一份**。
 *
 * 单独一个文件，就为了把 `import katex` 关在**浏览器侧**：
 *   · `inline.js` 负责切文本（零依赖，服务端也用）
 *   · 这个文件负责排公式（依赖 katex，只有前端构建会打包它）
 * 服务端有它自己的一份（`server-export.js`）—— 因为 server.js 的底线是
 * "没有任何第三方依赖"。为什么这条底线重要、以及当初怎么踩的，
 * 见 `inline.js` 的文件头那段。
 *
 * ⚠ 参数必须和界面上那一套**完全一致**（throwOnError / strict / trust）。
 *   不一致的下场是"自检说能排、显示出来是红字"这种自相矛盾。
 */

import katex from 'katex'

/**
 * 排一段 LaTeX。排不出来回 `null`（调用方会把原文摆出来，宁可丑不可丢）。
 * 不抛异常 —— 用户打到一半的公式（少个右括号）是最常见的情况，不该炸掉整页。
 */
export function renderMathToHtml(latex) {
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

/* 「这段 LaTeX 到底能不能排」——手写识别那边用它决定要不要允许"放到白板上"。
   用的是和上面**完全相同**的渲染路径，只是这次让 katex 抛错。
   （components/Tex.jsx 里也有一个 canRender，那个是给 React 组件用的；
     这里是给"非 React 的判断"用的。两条都必须走同一套参数。） */
export function canRenderMath(latex) {
  if (!latex || !String(latex).trim()) return false
  try {
    katex.renderToString(String(latex), { throwOnError: true, strict: false, trust: false })
    return true
  } catch {
    return false
  }
}
