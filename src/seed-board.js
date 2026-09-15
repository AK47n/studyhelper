/* 白板首次运行的样板：大物 · 电磁学（稳态磁场）。
 *
 * 为什么要给一张填好的样板，而不是空板：
 * "关系靠位置"这件事**必须看见一次**才懂。一张空板加一句说明，人是不会照做的；
 * 一张已经摆好"便签在上、公式卡摞在它上面/挨在它下面"的板，一眼就明白了，
 * 而且可以直接照着改成自己的。
 *
 * 五张卡的位置是有讲究的，把 buildRelations 的三条规则各演示一遍：
 *   1. 便签是大框，f1 / f2 整个落在它里面      → "包含"
 *   2. f3 搁在便签下沿外面、离得不远（< 26px） → "挨着"
 *   3. loose 独自在远处                        → "孤岛"（不是错，是还没想清楚）
 * ⚠ 改这里的位置，一定要跑 `npm run check:board`：第 [9] 段会断言
 *   "2 个包含 + 1 个挨着 + 1 个孤岛"。我第一版就是凭感觉摆的位置，
 *   注释写着"演示挨着"，实际算出来是"重叠" —— 注释在骗自己。
 */
import { newBoard, newCard, newStroke, toFlat } from './lib/board.js'

const INK = '#1b1d22'
const BLUE = '#1c7ed6'
const RED = '#d9480f'

function card(kind, x, y, extra) {
  const c = newCard(kind, 0, 0, extra)
  c.x = x
  c.y = y
  return c
}

export function buildSeedBoard() {
  const b = newBoard('示例 · 大物电磁学')

  /* 便签故意开得够大（520×420）：它要**装住**两张公式卡，才能演示"包含"。
     注意它同时也是 CSS 上的 min-height —— 便签里的字多了，实际渲染会变高，
     那没关系（高一点只会让"包含"更成立）。 */
  const note = card('note', 60, 60, { w: 520, h: 420 })
  note.text = '安培环路定理\n\n稳恒磁场里，B 沿闭合回路的积分只跟穿过的电流有关。'

  const f1 = card('formula', 100, 190, { w: 320, h: 100 })
  f1.src = 'oint(B) dl = mu0 I_in'
  f1.tex = '\\oint \\vec{B}\\cdot d\\vec{l} = \\mu_{0} I_{\\text{内}}'

  // 完全落在便签里面 → 判成"包含"
  const f2 = card('formula', 240, 330, { w: 280, h: 100 })
  f2.src = 'B = mu0 I / (2 pi r)'
  f2.tex = 'B = \\frac{\\mu_{0} I}{2 \\pi r}'

  // 搁在便签**下沿**外面、离得又不远 → 判成"挨着"（第三种规则）
  const f3 = card('formula', 100, 496, { w: 300, h: 100 })
  f3.src = 'Phi = B * S'
  f3.tex = '\\Phi = \\vec{B}\\cdot\\vec{S}'

  // 孤岛：离得远，故意不给它连谁 —— 演示"还没想清楚它属于哪一节"
  const loose = card('formula', 700, 560, { w: 320, h: 100 })
  loose.src = 'mu0 = 4 pi * 10^-7 N/A^2'
  loose.tex = '\\mu_{0} = 4\\pi \\times 10^{-7}\\ \\text{N/A}^{2}'

  b.cards = [note, f1, f2, f3, loose]

  // 手写标注：标题下面一道红线 + 一条从便签拉到下面去的箭头
  b.strokes = [
    underline(RED, 106, 236, 190),
    arrow(BLUE, [[560, 240], [560, 380], [560, 470]]),
    stroke(INK, 2.6, [[92, 424], [130, 412], [170, 424], [210, 410]]),
    /* 一笔荧光笔，示范"在便签正文上做记号"。
       它必须 pressure=false、宽度走 HL_WIDTH —— 见 lib/board.js 里
       "荧光笔永远不吃压力"那段：荧光笔是马克笔，是一道**宽度恒定**的带子。 */
    highlighter([[80, 150], [230, 148], [380, 152]]),
  ]

  b.view = { s: 1, tx: 0, ty: 0 }
  return b
}

function stroke(color, width, pts) {
  const s = newStroke('pen', toFlat(pts.map(([x, y]) => ({ x, y, p: 0.5 }))), { color, width })
  s.pressure = false // 手搓的样板线不要"压力变宽"，否则一粗一细看着像画坏了
  return s
}

function highlighter(pts) {
  const s = newStroke('highlighter', toFlat(pts.map(([x, y]) => ({ x, y, p: 0.5 }))), {})
  s.pressure = false
  return s
}

function arrow(color, pts) {
  const all = pts.slice()
  const [x, y] = pts[pts.length - 1]
  all.push({ x: x - 9, y: y - 13 }, { x, y }, { x: x + 9, y: y - 13 })
  return stroke(color, 2.2, all.map((p) => [p.x, p.y]))
}

function underline(color, x, y, w) {
  return stroke(color, 3, [[x, y], [x + w / 2, y + 2], [x + w, y]])
}
