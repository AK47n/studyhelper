import React, { useMemo } from 'react'
import { katexHtml } from '../lib/renderMath.js'

/* 把 LaTeX 渲染成好看的公式。
 *
 * 单独一个文件，只为了让 WritingPad（手写识别）也能用它，
 * 而不用去 import Board.jsx —— 那会绕出一个"Board → WritingPad → Board"的循环依赖。
 * 循环依赖在 ESM 里通常能跑，但它会在某个加载顺序下才炸，属于最难查的一类问题。
 *
 * 渲染不了怎么办：把原文摆出来。**宁可丑，不可丢** —— 这条规矩和 lib/formula.js 一致。
 * 识别服务回一句半截的 LaTeX 时，你要能看见它到底回了什么，而不是一个空白卡片。
 *
 * ★ 排式子一律走 `renderMath.js` 的 `katexHtml`（**全仓只有那一处调 katex**，
 *   而且带缓存 —— 同一个式子重挂载、重渲染都不重排）。参数照旧写在这儿。
 */
export function Tex({ tex, block }) {
  const html = useMemo(
    () => katexHtml(tex, { throwOnError: false, displayMode: !!block, strict: false, trust: false }),
    [tex, block]
  )
  if (html == null) return <span className="bd-tex-bad">{tex}</span>
  return <span className="bd-tex-in" dangerouslySetInnerHTML={{ __html: html }} />
}

/* "这段 LaTeX 能不能渲染" —— 手写识别那边用它决定要不要允许"放到白板上"。
   用的是和显示**完全相同**的渲染路径（同一组参数），
   不然会出现"检查说能、显示却是红字"这种自相矛盾。 */
export function canRender(tex) {
  if (!tex || !String(tex).trim()) return false
  return katexHtml(tex, { throwOnError: true, strict: false, trust: false }) !== null
}
