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
 *
 * ── ★★ 排过的式子**只排一次**（2026-09-25）──────────────────────────────
 *   探针实测（`npm run perf:who`，用户那张 213 张卡的板，连滚 60 帧）：
 *   KaTeX 一家吃掉了 ~800ms —— toMarkup 470ms，加上 lex / parseExpression /
 *   htmlBuilder 那几百毫秒，占"非空闲"时间的三分之一。而这些式子**一个字都没改**：
 *   缩放时 React 重渲染那批卡片，`richHtml` 被重跑一遍，式子跟着重新
 *   lex → 解析 → 排版。DOM 侧产物完全相同（`dangerouslySetInnerHTML` 比的是
 *   字符串的值，相等就不动 DOM），所以那笔钱是**纯白烧**。
 *   缓存之后同一条式子只在**第一次**真正排。
 *   ⚠ 缓存的键必须包含**所有影响输出的选项**（少一个 = 两种排法串味：
 *     排不出来的式子会拿到别的参数下排出来的那一版，或者反过来）。
 *     以后给 katex 加选项，**同时**把它加进 `keyOf`，否则就是静默出错。
 */

import katex from 'katex'

/* 上限：板上的式子就那么多，但一份几十页的课件能攒出几千条。
   满了就**整表清空** —— 比 LRU 简单得多，而"清空"在这儿代价只是下次重排一遍。 */
const CACHE_MAX = 2000
let cache = new Map()

/** 影响输出的每一个选项都进键（见文件头）。 */
function keyOf(latex, o) {
  return (
    (o.displayMode ? 'D' : 'i') +
    '|' + o.output +
    '|' + (o.strict ? 's' : '') + (o.trust ? 't' : '') + (o.throwOnError ? 'e' : '') +
    '|' + String(latex ?? '')
  )
}

/**
 * 排一段 LaTeX。排不出来回 `null`（调用方会把原文摆出来，宁可丑不可丢）。
 * 不抛异常 —— 用户打到一半的公式（少个右括号）是最常见的情况，不该炸掉整页。
 *
 * @param {string} latex 式子
 * @param {object} opts 和 katex 同名：`displayMode` / `output` / `strict` / `trust` / `throwOnError`
 */
export function katexHtml(latex, opts = {}) {
  const o = {
    displayMode: !!opts.displayMode,
    output: opts.output || 'htmlAndMathml', // katex 的默认输出
    strict: opts.strict !== false,
    trust: !!opts.trust,
    throwOnError: !!opts.throwOnError,
  }
  const key = keyOf(latex, o)
  const hit = cache.get(key)
  /* ⚠ 用 `undefined` 而不是 `!hit` 判未命中：排不出来存的是 `null`，
     而 `null` 恰恰是**最该缓存**的结果（半截式子每帧重试一遍最亏）。 */
  if (hit !== undefined) return hit
  let html = null
  try {
    html = katex.renderToString(String(latex ?? ''), o)
  } catch {
    html = null
  }
  if (cache.size >= CACHE_MAX) cache = new Map()
  cache.set(key, html)
  return html
}

/**
 * 行内那一版（保留旧名字，语义不变）：排不出来回 `null`。
 */
export function renderMathToHtml(latex) {
  return katexHtml(latex, { displayMode: false, output: 'html', strict: false, trust: false, throwOnError: false })
}

/* 「这段 LaTeX 到底能不能排」——手写识别那边用它决定要不要允许"放到白板上"。
   用的是和上面**完全相同**的渲染路径，只是这次让 katex 抛错。
   （components/Tex.jsx 里那个 `canRender` 直接调 `katexHtml`，不再各留一份。） */
export function canRenderMath(latex) {
  if (!latex || !String(latex).trim()) return false
  return katexHtml(latex, { throwOnError: true, strict: false, trust: false }) !== null
}
