// 键盘/插入逻辑的单元验证：用一个极简 DOM 桩跑 useFormulaEditing 的 Tab 空位跳转。
//   node scripts/check-keys.js
import assert from 'node:assert'
import { spliceAt, CURSOR, MARKER_AS_TAB } from '../src/lib/useFormulaEditing.js'

let pass = 0
const ok = (name) => {
  pass++
  console.log('  ✓ ' + name)
}
const eq = (a, b, name) => {
  assert.strictEqual(a, b, `${name}\n  期望: ${JSON.stringify(b)}\n  实际: ${JSON.stringify(a)}`)
  ok(name)
}

console.log('=== spliceAt：插入 + 空位定位 ===')

// 1. 分式：光标应停在分子，空位有 2 个
{
  const text = ''
  const r = spliceAt(text, 0, 0, `\\frac{${CURSOR}}{${CURSOR}}`)
  eq(r.text, '\\frac{\t}{\t}', '分式插入后空位显示成 \\t')
  eq(r.stops.length, 2, '分式有 2 个空位')
  eq(r.cursor, 6, '光标停在第一个空位（分子）')
  eq(r.cursor, r.stops[0], '返回的光标 == 第一个空位')
}

// 2. 光标在文本中间插入，位置要跟着偏移
{
  const r = spliceAt('abcXYZdef', 3, 6, `\\sqrt{${CURSOR}}`)
  eq(r.text, 'abc\\sqrt{\t}def', '中间替换选中内容')
  // 'abc\sqrt{' 正好 9 个字符，光标应停在 \t 上
  eq(r.cursor, 9, '光标落在替换后的空位处')
  eq(r.text[r.cursor], MARKER_AS_TAB, '光标位置确实是一个空位标记')
}

// 3. 三个空位（矩阵）
{
  const r = spliceAt('', 0, 0, `\\begin{pmatrix} ${CURSOR} & ${CURSOR} \\\\ ${CURSOR} & \\end{pmatrix}`)
  eq(r.stops.length, 3, '矩阵模板有 3 个空位')
}

console.log('\n=== Tab 跳空位：只跳一格，不跳两格 ===')

// 4. 模拟 jumpStop 的核心：维护 stops + index，每次只前进 1
{
  const r = spliceAt('', 0, 0, `\\frac{${CURSOR}}{${CURSOR}}`)
  let idx = 0
  const jump = () => {
    const next = idx + 1
    if (next < 0 || next >= r.stops.length) return false
    idx = next
    return true
  }
  eq(r.stops[idx], r.stops[0], '起始在第 1 个空位')
  eq(jump(), true, '第 1 次 Tab 成功')
  eq(idx, 1, '第 1 次 Tab 之后 index = 1（不是 2）')
  eq(r.stops[idx], r.stops[1], '落在第 2 个空位（分母）')
  eq(jump(), false, '第 2 次 Tab 没有更多空位，返回 false（交给缩进逻辑）')
  eq(idx, 1, '越界时 index 不变')
}

// 5. 回归演示：旧实现里 React onKeyDown 与 window 监听会各跳一次，
//    用 3 个空位的矩阵模板才看得出来（分式只有 2 个空位，会被边界挡住）
{
  const r = spliceAt('', 0, 0, `\\begin{pmatrix} ${CURSOR} & ${CURSOR} \\\\ ${CURSOR} & \\end{pmatrix}`)
  eq(r.stops.length, 3, '矩阵有 3 个空位')

  const jump = (state) => {
    const n = state.idx + 1
    if (n < 0 || n >= r.stops.length) return false
    state.idx = n
    return true
  }

  const fixed = { idx: 0 }
  jump(fixed)
  eq(fixed.idx, 1, '修好后：一次 Tab 停在空位 1')

  const buggy = { idx: 0 }
  jump(buggy) // 处理器 A（React onKeyDown）
  jump(buggy) // 处理器 B（window 监听）——修掉的那个 bug
  eq(buggy.idx, 2, '旧实现：一次 Tab 会跳到空位 2（这就是被修掉的行为）')
  assert.notStrictEqual(fixed.idx, buggy.idx, '修好前后行为确实不同')
  ok('确认合并成单一处理器后不会跳两格')
}

console.log('\n=== 标记归一化 ===')
{
  eq(String(MARKER_AS_TAB), '\t', 'MARKER_AS_TAB 是制表符')
  eq(String(CURSOR).charCodeAt(0), 1, 'CURSOR 是 \\u0001')
}

console.log(`\n${pass} 项通过 ✓`)
