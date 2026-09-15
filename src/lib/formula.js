/* 「随手写的公式」→「好看的公式」。
 *
 * 目标：在白板上你写的是 F = ma、dS/dt、sqrt(x^2+y^2)、mu0 I / 2 pi r 这种东西，
 * 工具把它变成排好版的数学。你不需要知道 LaTeX 叫什么。
 *
 * ── 两条硬规矩 ──
 * ① **幂等**：转化两次 = 转化一次。你写 mu0 得到 \mu_0；如果对 \mu_0 再跑一次
 *    还变成 \mu_{0} 甚至 \mumathu_{0}，那这函数就不能在"每次渲染前"调用，
 *    只能"存的时候调一次"，于是任何一次重排都可能悄悄改坏内容。
 *    我们把幂等做成可测的（scripts/check-board.js）。
 * ② **认不出来的一律原样留着**：宁可丑，不可丢。
 *    写错的记号只是显示成红的/原样，绝不能把你不认识的东西吃掉。
 */

const GREEK = {
  alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma', delta: '\\delta', epsilon: '\\epsilon',
  varepsilon: '\\varepsilon', zeta: '\\zeta', eta: '\\eta', theta: '\\theta', vartheta: '\\vartheta',
  iota: '\\iota', kappa: '\\kappa', lambda: '\\lambda', mu: '\\mu', nu: '\\nu', xi: '\\xi',
  pi: '\\pi', varpi: '\\varpi', rho: '\\rho', sigma: '\\sigma', tau: '\\tau', upsilon: '\\upsilon',
  phi: '\\phi', varphi: '\\varphi', chi: '\\chi', psi: '\\psi', omega: '\\omega',
  Gamma: '\\Gamma', Delta: '\\Delta', Theta: '\\Theta', Lambda: '\\Lambda', Xi: '\\Xi',
  Pi: '\\Pi', Sigma: '\\Sigma', Upsilon: '\\Upsilon', Phi: '\\Phi', Psi: '\\Psi', Omega: '\\Omega',
}

/* 这些词是**函数/算子**，后面跟括号时不该被当成变量斜体排。
   只收数学里最常见的几个；不收的后果只是斜体，不难看。 */
const OPS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'mod']

/* 单个记号 → LaTeX。都是"看到就当"的那种，不需要上下文。
   注意 mu0 这种"希腊字母带数字下标"要单独处理（见 SUBSCRIBE_NUM）。 */
const SYMBOL = {
  infty: '\\infty', inf: '\\infty', partial: '\\partial', nabla: '\\nabla',
  cdot: '\\cdot', cdots: '\\cdots', times: '\\times', div: '\\div', pm: '\\pm', mp: '\\mp',
  leq: '\\leq', le: '\\leq', geq: '\\geq', ge: '\\geq', neq: '\\neq', ne: '\\neq',
  ll: '\\ll', gg: '\\gg', approx: '\\approx', equiv: '\\equiv', propto: '\\propto',
  to: '\\to', rightarrow: '\\rightarrow', Leftrightarrow: '\\Leftrightarrow',
  int: '\\int', iint: '\\iint', iiint: '\\iiint', oint: '\\oint',
  sum: '\\sum', prod: '\\prod', vec: '\\vec', hat: '\\hat', bar: '\\bar',
  deg: '^\\circ', angstrom: '\\text{Å}', ohm: '\\Omega',
}

/* 希腊字母 + 紧跟的数字 → 下标：mu0 → \mu_0，pi2 → \pi_2。
   物理里真空磁导率、ε₀、各种带下标的常数全是这个形状，不认就白搭。

   注意这里匹配的是**已经拼在一起的词**（"mu0"）。但 token 流里 mu0 其实是
   两个 token（"mu" 和 "0"），所以真正干活的是 mergeWord 里"下一个 token 是纯数字"
   那一支；这个正则留给"用户直接把 mu0 粘成一坨给进来"的入口。 */
const SUBSCRIBE_NUM = new RegExp(`^(${Object.keys(GREEK).join('|')})(\\d+)$`)

const TOK = new RegExp(
  [
    '\\\\[a-zA-Z]+', // \mu 已经写好的 LaTeX 命令
    '\\\\.', // \, \; 这种单字符命令
    '\\$', // 公式里冒出来的 $ 一律当噪音丢掉
    '[A-Za-z]+', // 字母词（可能还要继续合并）
    '\\d+(?:\\.\\d+)?', // 数字
    '\\s+',
    '.', // 其余单字符
  ].join('|'),
  'g'
)

const isLetterWord = (t) => /^[A-Za-z]+$/.test(t)

/* 主入口：随手写的一行 → LaTeX（不带 $ 定界符）。
   全程只走一遍 token 流，不做二次替换 —— 二次替换是"转化不幂等"的根源。 */
export function toTex(src) {
  const s = String(src == null ? '' : src)
  if (!s.trim()) return ''
  const tokens = s.match(TOK) || []
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^\s+$/.test(t)) {
      out += ' '
      continue
    }
    if (t === '$') continue

    // 已经写好的 LaTeX：原样保留（这是幂等的关键——不重新解释一遍）
    if (t.startsWith('\\')) {
      out += t
      continue
    }

    if (isLetterWord(t)) {
      const merged = mergeWord(tokens, i)
      out += merged.tex
      i = merged.next - 1
      continue
    }

    if (/^\d/.test(t)) {
      out += t
      continue
    }

    // 单字符
    if (t === '*') {
      // 末尾不留空格：postProcess 会把连续空格压成一个、并去掉首尾空格，
      // 留了空格就会变成 "a \cdot  b"（两个空格），白白在 diff 里显眼。
      out += '\\cdot '
      continue
    }
    if (t === '/' || t === '^' || t === '_') {
      // 这些进后面的"结构"阶段处理：这里先原样留着，标记位置
      out += t
      continue
    }
    out += t
  }

  return postProcess(out)
}

/* 字母词要往下看一位再决定怎么排。三种情况：
   ① mu0 / epsilon0 / pi2：希腊字母 + 数字 = 下标；
   ② x^2 / x_1 / mu_0：底数 + 上下标。**在这里一次把上标下标吃掉**，
      不留到后面的正则里补大括号 —— 那个"补大括号"的正则会让转化不幂等
      （\mu_0 第二次会被改成 \mu_{0}），而幂等是这整个函数能用的前提。
   ③ 其他：希腊字母查表、函数名加反斜杠、普通多字母按变量拆开。

   底数只吃**一个**字母（x^2 对）。多字母底数 x_max^2 按数学惯例本来就该
   自己写 {}，我们不强猜 —— 猜错比不管更烦人。 */
function mergeWord(tokens, i) {
  const word = tokens[i]

  // ① 希腊字母 + 数字。分两种写法：
  //    粘在一起的（"mu0" 一个 token）和分开的（"mu" + "0" 两个 token）。
  //    ★ 分开这一支是必须的：token 流一定是分开的（字母词和数字是两个 token），
  //      只写粘在一起的那一支，mu0 就永远不会变成 \mu_0 —— 第一版就是这么错的。
  const glued = SUBSCRIBE_NUM.exec(word)
  if (glued) return { tex: `${GREEK[glued[1]]}_{${glued[2]}}`, next: i + 1 }
  const nextTok = tokens[i + 1] || ''
  if (GREEK[word] && /^\d+$/.test(nextTok)) {
    return { tex: `${GREEK[word]}_{${nextTok}}`, next: i + 2 }
  }

  const base = symbolTex(word)
  const op = tokens[i + 1]
  if ((op === '^' || op === '_') && (word.length === 1 || GREEK[word] || SYMBOL[word] || OPS.includes(word))) {
    // ② 上标下标：吃下 [+-]?数字 或 单个字母
    let j = i + 2
    let sign = ''
    if (tokens[j] === '-' || tokens[j] === '+') {
      sign = tokens[j]
      j++
    }
    const operand = tokens[j] || ''
    let body = ''
    let next = j
    if (/^\d/.test(operand)) {
      body = sign + operand
      next = j + 1
    } else if (/^[A-Za-z]$/.test(operand)) {
      body = sign + operand
      next = j + 1
    } else if (isLetterWord(operand)) {
      body = sign + symbolTex(operand)
      next = j + 1
    } else if (operand === '(') {
      // x^(n+1)：括号块整体进上标
      const rest = tokens.slice(j).join('')
      const close = matchParen(rest, 0)
      if (close > 0) {
        const inner = rest.slice(1, close)
        // 括号里的东西还得再走一遍同样的转化
        return { tex: `${base}^{${toTex(inner)}}`, next: j + (rest.slice(0, close + 1).match(TOK) || []).length }
      }
      return { tex: base + op, next: i + 2 }
    } else {
      // 后面不是我们认得上标下标的形状（比如行尾、或一个空格）
      return { tex: base + op, next: i + 2 }
    }
    const wrapped = op === '^' ? `^{${body}}` : `_{${body}}`
    return { tex: base + wrapped, next }
  }

  return { tex: base, next: i + 1 }
}

function symbolTex(word) {
  if (GREEK[word]) return GREEK[word]
  if (SYMBOL[word]) return SYMBOL[word]
  if (OPS.includes(word)) return `\\${word}`
  if (word.length === 1) return word
  // 多字母变量：不做 \mathit 之类的美化，数学里本来就该是一个符号一个字母，
  // 拆成逐个字母是**最不会出错**的做法（kaTeX 会把它排成 m a 而不是"ma"）。
  // 认不出来就原样返回，绝不吞。
  return word.split('').join('')
}

/* 结构阶段：把 sqrt(...) 的形状排出来，再把还没包起来的上下标补上大括号。
   只做这三件事，多一件都不做（每多一条规则就多一处能咬人的地方）。

   ⚠ 这里的上下标替换**必须**带大括号深度判断。第一版用了
   `out.replace(/_(\d+)/g, '_{$1}')`，结果是 \mu_0 会被再包一次变成
   \mu_{0}，而 \mu_{0} 下一轮变成 \mu_{{0}}…… 也就是说"转化两次 ≠ 转化一次"，
   于是这个函数就只能在保存时调一次，任何一次重排都可能悄悄改坏内容。 */
function postProcess(s) {
  let out = s

  // sqrt(...) → \sqrt{...}；括号配对用扫描，不用正则（正则配不了嵌套）
  out = replaceFunc(out, 'sqrt', '\\sqrt')

  // 分式：A/B，只要两边都是"紧凑的一块"就排成分式。
  // 排不出（比如左边是整个长表达式）就留着斜杠——斜杠也是对的写法，只是没那么好看。
  out = fractionize(out)

  // 补上下标大括号（只在这一层的 {} 外面动手）
  out = wrapScripts(out)

  return out.replace(/\s{2,}/g, ' ').trim()
}

/* 大括号深度为 0 的位置上，把 _12 / ^-1 / ^ab 包成 _{12} / ^{-1} / ^{ab}。
   已经在 {} 里的（\frac{...}、\sqrt{...}）一概不碰。 */
function wrapScripts(s) {
  let out = ''
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{') {
      depth++
      out += ch
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      out += ch
      continue
    }
    if ((ch === '^' || ch === '_') && depth === 0) {
      const m = /^([+-]?(?:\d+(?:\.\d+)?|[A-Za-z]))/.exec(s.slice(i + 1))
      if (m) {
        out += ch + '{' + m[1] + '}'
        i += m[1].length
        continue
      }
      out += ch
      continue
    }
    out += ch
  }
  return out
}

/* 把 name(...) 换成 name{...}，括号要配对（sqrt(sqrt(x)) 得能对）。 */
function replaceFunc(s, name, texName) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const at = s.indexOf(name + '(', i)
    if (at < 0) {
      out += s.slice(i)
      break
    }
    // 前面不能是字母/数字（不然 asqrt( 也会命中）
    const prev = at > 0 ? s[at - 1] : ''
    if (prev && /[\w\\]/.test(prev)) {
      out += s.slice(i, at + name.length)
      i = at + name.length
      continue
    }
    const open = at + name.length
    const close = matchParen(s, open)
    if (close < 0) {
      // 括号没配平：原样留着。用户可能就是在打字的过程中。
      out += s.slice(i)
      break
    }
    out += s.slice(i, at) + texName + '{' + s.slice(open + 1, close) + '}'
    i = close + 1
  }
  return out
}

function matchParen(s, openIdx) {
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/* A/B → \frac{A}{B}。
   什么时候敢下手：斜杠两边都是"一层括号包住的"或者"一个紧实的 token 块"，
   并且这一层里不再有裸的 + 或 -（有的话分子分母是谁就不清楚了）。
   不敢下手就留着斜杠 —— 1/2 显示成 1/2 完全没错，排错才是错。 */
function fractionize(s) {
  // 只处理**最外层**的斜杠，逐层剥。最多剥 4 层，防病态输入。
  for (let round = 0; round < 4; round++) {
    const idx = findTopLevelSlash(s)
    if (idx < 0) break
    const left = readLeftOperand(s, idx)
    const right = readRightOperand(s, idx + 1)
    if (!left || !right) break
    if (/[+\-](?![\d.])/.test(left.text) || /[+\-]/.test(right.text)) break
    /* ★ 括号是**你明确要求**排成分式的信号，优先级高于"像不像单位"。
       所以 `m/(V)` 会排成分式，而 `m/V` 不会 —— 这一条把取舍交回到你手里：
       想要分式就加括号，不想要就别加。不然这个启发式就成了一个你没法覆盖的命令。 */
    if (!left.paren && isUnitSide(left.text)) break
    if (!right.paren && isUnitSide(right.text)) break
    const next = s.slice(0, left.start) + `\\frac{${left.text}}{${right.text}}` + s.slice(right.end)
    // ★ 收尾必须自检：大括号要配平。手写输入里什么怪形状都有，一旦边界切错
    //   就会排出 "A^}{2}" 这种**看着像公式、其实说不通**的东西。
    //   宁可留着斜杠（斜杠本身也是对的写法），也不能排出错的公式。
    if (!bracesBalanced(next)) break
    s = next
  }
  return s
}

/* 斜杠的一边像不像**单位**。像就整个不切，保持 "N/A^2"、"km/h" 原样。
 *
 * 为什么要有这一条：`N/A^2` 排成 \frac{N}{A^2} 是**错的读法** ——
 * 那不是"N 除以 A 的平方"，那是"牛顿每平方安培"这样一个单位。
 * 量纲式子和分式长得一样，但读法完全不同，排错了比不排更糟。
 *
 * 判断信号（按可靠程度排）：
 *   ① 紧挨着一个数字：`4 N/A^2` 里的 N/A^2 一定是单位；
 *   ② 单位名白名单（mol、min、kg…）；单个大写字母（N、A、K、J、W、C、V、T、F、H）。
 * 变量和物理量习惯写小写（m、v、s、t），所以这一条不会误伤 `m/s`、`m/V`。 */
const UNIT_WORDS = /^(mol|min|kg|Hz|Pa|rad|sr|bar|atm|eV|rpm|km|cm|mm|nm|ns|ms|us|kHz|MHz|GHz)$/
function isUnitSide(text) {
  if (!text) return false
  if (UNIT_WORDS.test(text)) return true
  if (/^[A-Z]$/.test(text)) return true
  // 数字后面直接跟着的东西：4 N/A^2 / 9.8 m/s^2 这种写法里那一段全是单位
  if (/^[A-Z][a-zA-Z0-9^]*$/.test(text)) return true
  return false
}

function bracesBalanced(s) {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      while (i + 1 < s.length && /[a-zA-Z]/.test(s[i + 1])) i++
      continue
    }
    if (s[i] === '{') depth++
    else if (s[i] === '}') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

function findTopLevelSlash(s) {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(' || ch === '{') depth++
    else if (ch === ')' || ch === '}') depth--
    else if (ch === '\\') {
      i++ // 跳过命令名
      while (i + 1 < s.length && /[a-zA-Z]/.test(s[i + 1])) i++
    } else if (ch === '/' && depth === 0) return i
  }
  return -1
}

/* 往左读一个操作数。
   ★ 难点在这里：手写公式里 (2 pi r) 常常省成 2 pi r，所以操作数不是"一个 token"，
     而是**一串连写的乘积**（数学上乘法比除法结合得紧）。第一版只读了一个空格分隔的
     token，于是 `mu0 I / (2 pi r)` 变成 \frac{I}{2\pi r} —— 分子少了一项，
     看着还挺像回事，只有你自己知道 I 被吃掉了。这类错最危险。
   读法：从斜杠左边界往左，只要有空格隔开、且空格左边还是个原子，就继续吃。 */
function readLeftOperand(s, slashIdx) {
  let end = slashIdx
  while (end > 0 && s[end - 1] === ' ') end--
  if (end === 0) return null

  let start = atomStart(s, end)
  if (start < 0) return null
  // 继续往左吃："... 原子 原子"
  for (;;) {
    let j = start
    while (j > 0 && s[j - 1] === ' ') j--
    if (j === start || j === 0) break
    const st = atomStart(s, j)
    if (st < 0) break
    // 空格左边那个原子，必须是"跟这个原子并排"的，不能是运算符
    const between = s[st]
    if (between === '=' || between === '+' || between === '-' || between === '*' || between === '/') break
    start = st
  }
  const text = stripParen(s.slice(start, end))
  if (!text || text.includes('/')) return null
  return { start, end, text, paren: isWrapped(s, start, end) }
}

/* 这一段是不是被一对括号**完整**包住的。用来区分 (V) 和 V：
   前者是你明确写成一组，后者可能是单位。 */
function isWrapped(s, start, end) {
  if (s[start] !== '(' || s[end - 1] !== ')') return false
  return matchParen(s, start) === end - 1
}

/* 从 end 往左，读出**一个原子**：括号整块，或者紧挨的一串非分隔字符
   （上下标算在里面）。返回它的起点；读不出返回 -1。
   ★ 只有这一个函数负责回答"这个原子的左边界在哪"。第一版在 readLeftOperand 里
   另抄了一份简化版，两份逻辑不一致，于是 \mu_{0} 被从中间切开 ——
   凡是"同一个判断有两份实现"，迟早会打架。 */
function atomStart(s, end) {
  if (end <= 0) return -1
  const last = s[end - 1]
  if (last === ')' || last === '}') {
    const open = matchBack(s, end - 1)
    if (open < 0) return -1
    return extendOverScript(s, open)
  }
  let i = end
  while (i > 0 && !/[\s(){}]/.test(s[i - 1])) i--
  // 一元负号要跟着数字走（-2 是一个数），但 "a - b" 里的减号是运算符，不是原子的头
  if (s[i] === '-' && !/[0-9.]/.test(s[i + 1] || '')) i++
  return i >= end ? -1 : i
}

/* 括号块前面如果**紧挨着**一个 ^ 或 _，那这个块是它的上下标，
   整个都算同一个原子：x^{2}、\mu_{0}、a_{i}。
   注意 open 是左括号自己的下标，所以 ^ / _ 在 open - 1 —— 第一版写成 open - 2，
   于是永远差一位、永远扩展不出去，\mu_{0} 被当成"从 {" 开始的原子，
   分式就切成了 \mu_\frac{{0} ...}{...}。差一位的错最难看出来。
   最多回退两层（x_{i_{j}} 这种），防病态输入。 */
function extendOverScript(s, open) {
  let start = open
  for (let hop = 0; hop < 2; hop++) {
    const idx = start - 1
    if (idx < 0) break
    if (s[idx] !== '^' && s[idx] !== '_') break
    // 再往左必须真的挨着东西，中间隔着空格就说明是从别处另起的一块
    if (idx === 0 || /[\s(]/.test(s[idx - 1])) break
    start = atomStart(s, idx)
    if (start < 0) break
  }
  return start
}

/* 往右读一个操作数：同样是一串连写的乘积。 */
function readRightOperand(s, startIdx) {
  let i = startIdx
  while (i < s.length && s[i] === ' ') i++
  if (i >= s.length) return null

  let end = atomEnd(s, i)
  if (end < 0) return null
  for (;;) {
    let j = end
    while (j < s.length && s[j] === ' ') j++
    if (j >= s.length || j === end) break
    const ch = s[j]
    if (ch === ')' || ch === '}' || ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '=') break
    const e2 = atomEnd(s, j)
    if (e2 < 0) break
    end = e2
  }
  const text = stripParen(s.slice(i, end))
  if (!text || text.includes('/')) return null
  return { start: i, end, text, paren: isWrapped(s, i, end) }
}

/* 从 start 往右，读出一个原子，返回它的结束位置（开区间）。 */
function atomEnd(s, start) {
  if (start >= s.length) return -1
  if (s[start] === '(') {
    const close = matchParen(s, start)
    return close < 0 ? -1 : close + 1
  }
  if (s[start] === '{') {
    const close = matchBrace(s, start)
    return close < 0 ? -1 : close + 1
  }
  let j = start
  if (s[j] === '-' && /[0-9.]/.test(s[j + 1] || '')) j++
  while (j < s.length && !/[\s(){}]/.test(s[j])) {
    if (s[j] === '/' && j > start) break
    j++
  }
  return j > start ? j : -1
}

/* 只剥掉**最外层**一层括号：((a+b)) → (a+b)，a+b → a+b。 */
function stripParen(t) {
  let s = t
  for (let guard = 0; guard < 8; guard++) {
    if (s.length < 2) break
    if (s[0] === '(' && s[s.length - 1] === ')' && matchParen(s, 0) === s.length - 1) {
      s = s.slice(1, -1)
      continue
    }
    if (s[0] === '{' && s[s.length - 1] === '}' && matchBrace(s, 0) === s.length - 1) {
      s = s.slice(1, -1)
      continue
    }
    break
  }
  return s
}

function matchBack(s, closeIdx) {
  const openCh = s[closeIdx] === ')' ? '(' : '{'
  const closeCh = s[closeIdx]
  let depth = 0
  for (let i = closeIdx; i >= 0; i--) {
    if (s[i] === closeCh) depth++
    else if (s[i] === openCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function matchBrace(s, openIdx) {
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/* 给编辑器用：用户点一下符号面板，往光标处塞什么。
   塞的是**你也能手打出来的东西**，不是 LaTeX —— 这样面板和手写是同一套语法，
   不会出现"面板插的东西我自己看不懂、也没法改"的情况。 */
export function snippetFor(key, selected = '') {
  const has = selected && selected.trim()
  switch (key) {
    case 'frac':
      return has ? `${has}/( )` : '( )/( )'
    case 'sqrt':
      return has ? `sqrt(${has})` : 'sqrt( )'
    case 'sup':
      return has ? `${has}^ ` : '^ '
    case 'sub':
      return has ? `${has}_ ` : '_ '
    case 'vec':
      return has ? `vec(${has})` : 'vec( )'
    case 'int':
      return 'int( ) d '
    case 'sum':
      return 'sum( )'
    case 'pi':
      return 'pi'
    case 'mu0':
      return 'mu0'
    case 'cdot':
      return has ? `${has} * ` : ' * '
    default:
      return key
  }
}

/* 公式卡片上显示什么：先看你存下的 tex，没有就拿 src 现算。
   永远走这条路（不要在两处各写一遍"该显示什么"）。 */
export function displayTex(card) {
  if (!card) return ''
  if (card.tex && card.tex.trim()) return card.tex
  return toTex(card.src)
}
