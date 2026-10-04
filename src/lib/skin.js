/* 一只笔和一张纸"长什么样"（2026-09-24 从 Board.jsx 搬出来）。
 *
 * ── 为什么要单独一个文件 ──────────────────────────────────────────
 * 这几样东西**两头都要用**：Board.jsx（新建笔迹、铺纸、读上次的选择）
 * 和工具条那一排按钮（BoardBar.jsx：让你挑颜色、粗细、纸面）。
 * 它们不能住在任何一个组件文件里 —— 住哪头，另一头就得 import 它，
 * 那就是 Board → BoardBar → Board 的循环依赖（ESM 里通常能跑，
 * 但只在某个加载顺序下才炸，属于最难查的一类 —— Tex.jsx 的文件头写过同样的理由）。
 *
 * ⚠ 纸面**不进 board-*.md**（存在 localStorage）：纸是"我习惯怎么看这张板"，
 *   不是这张板的内容；而且板文件是自动存的，多一个字段就多一处假 diff。
 * ⚠ PAPERS 的 id 同时是 CSS 类名后缀（.paper-<id>）和地址栏 ?paper= 的值 ——
 *   改 id 要连 styles.css 一起改；scripts/check-paper.js 里也抄了一份"应该长什么样"
 *   （那是**故意的**：自检要的是"我期望什么"，不是"实现现在是什么"）。
 */
export const COLORS = [
  { id: 'ink', v: '#1b1d22', name: '黑' },
  { id: 'red', v: '#d9480f', name: '红' },
  { id: 'blue', v: '#1c7ed6', name: '蓝' },
  { id: 'green', v: '#2f9e44', name: '绿' },
  { id: 'purple', v: '#7048e8', name: '紫' },
]
export const WIDTHS = [1.6, 2.6, 4.2]

/* ── 纸面：几种背景，用户自己挑 ──
 * 2026-09-16 用户：「现在白板背景是十字格子纸，可以改成纯白纸，或者说有几种类型的
 * 背景让用户去选择」。于是做成**四档可挑**，并且把默认从"十字格子"改成**纯白**
 * （他那句话的头半句就是"可以改成纯白纸"）。
 * tile 是**世界坐标**里的格距（0 = 没有底纹）：屏幕上看到的格距 = tile × 视图缩放，
 * 这一条就是"字在纸上"的全部内容（check-paper 的 [4] 钉着它）。
 */
export const PAPERS = [
  { id: 'plain', name: '纯白', hint: '一张干净的白纸，什么都不铺（默认）', tile: 0 },
  { id: 'grid', name: '方格', hint: '一格 32 世界像素的十字格子，画图对得齐', tile: 32 },
  { id: 'rule', name: '横线', hint: '只有横线，写一行对一行', tile: 32 },
  { id: 'dots', name: '点阵', hint: '一层小点，比格子安静', tile: 24 },
]
export const DEFAULT_PAPER = 'plain'
export const PAPER_KEY = 'studyhelper.paper'
/* 公式架开合也存 localStorage（理由同上：这是"我怎么看这张板"，不是板的内容）。
   默认**收起** —— 它是一条横条，常驻会吃掉画布高度；开一次就记住了。 */
export const SHELF_KEY = 'studyhelper.shelfOpen'
