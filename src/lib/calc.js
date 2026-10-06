/* 「这条式子能不能算」—— 把**你自己写的那一串**拿来求值。
 *
 * ── 为什么读 `card.src` 而不是 `card.tex` ─────────────────────────────
 * 板上一张公式卡存着两样：`src` 是**你写下的原文**（`F = ma`、`mu0 I / 2 pi r`），
 * `tex` 是转成 LaTeX 之后的样子（`\frac{\mu_0 I}{2\pi r}`）—— 那是给**排版**用的。
 * 从 tex 反着算要走回头路：`\frac{a}{b}` 得还原成分式、`\cdot` 还原成乘、
 * `\mu_0` 还原成一个整体；而且 tex 恰恰丢掉了最重要的一件事 ——
 * **哪几个符号是你自己设的量**（变量和长得一样的 constantus 分不开）。
 * src 反过来几乎就能算了：`* / ^ () sqrt() sin()` 全都认，
 * 只差一件事：**隐式乘法**（`ma` 是 `m*a`）。所以从 src 走。
 *
 * ── 三条硬规矩（这个项目一贯的脾气）───────────────────────────────
 * ① **宁可说"我算不了"，也不许算错。** 认出来的就老实算，认不出来一律回到
 *    `{ok:false, why}`，由调用方把"这条式子算不了"摆在明面上。
 *    悄悄给一个错的数最害人 —— 学生对着一个错数能改一晚上。
 * ② **纯函数、零依赖**：这个文件不 import 任何东西，node 里直接断言得住
 *    （`scripts/check-calc.js`）。它不碰浏览器、不碰 React、不出网。
 * ③ **常量不猜**：只内置那些**不可能被当成你自己的变量**的写法，见下面 `CONSTS`。
 *
 * ── 它是什么、不是什么 ────────────────────────────────────────────
 * 是：**代入数值算出一个数** —— 把板上那条式子拿来用。
 * 不是：符号运算（求导、化简、解方程）。那是另一套引擎，别混进来。
 */

// ───────────────────────────── 常量 ─────────────────────────────

/**
 * 内置的那些量。
 *
 * ⚠ **为什么没有 `c` / `h` / `g` 这种单字母**。
 *   `c = 3e8` 看着方便，但学生写 `E = m c^2` 时那个 c 是光速，
 *   写 `c = a + b` 时它就是他自己设的一个数 —— 同一块板上一周里两种都会出现。
 *   猜错的症状是"数字看着很合理但是错的"，是**最难发现**的那一种。
 *   所以单字母只内置数学上众望所归的 `pi` 和 `e`，
 *   物理常数一律用多名店写法：`c0`（光速）、`h0`（普朗克）、`g0`（重力加速度）、`G0`。
 *   这些几乎不会被当成自己的变量，而且和纸上写的 `c₀` 是一个形状。
 *
 * ★ 任何一个都能被**覆盖**：用户给就能用他的值（`evalFormula` 先看传入值）。
 *   所以"这个符号我想当自己的变量"这条路永远是通的。
 */
export const CONSTS = {
  pi: Math.PI,
  e: Math.E,
  // 电磁学 / 近代物理里天天要用的那几个
  mu0: 1.25663706212e-6, // 真空磁导率 μ₀
  eps0: 8.8541878128e-12, // 真空介电常数 ε₀
  c0: 299792458, // 光速
  qe: 1.602176634e-19, // 元电荷
  me: 9.1093837015e-31, // 电子质量
  h0: 6.62607015e-34, // 普朗克常数 h
  hbar: 1.054571817e-34, // ħ
  kB: 1.380649e-23, // 玻尔兹曼常数
  NA: 6.02214076e23, // 阿伏伽德罗常数
  g0: 9.80665, // 重力加速度
  G0: 6.67430e-11, // 万有引力常数
}

/** 一个参数的函数。arity 之外的一律不认（规矩①：不猜）。 */
const FN1 = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  /* ★ `log` 是 lg：物理、信号那几门课里 log 十有八九指 log10（课本就这么写）。
     想要自然对数有 `ln`，清清楚楚。 */
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
}
/* ★ 只收**一个参数**的函数。两个参数的那一族（pow / atan2）暂时不收 ——
   解析器还不支持逗号参数，收进来就是一条走不通的死路（那是"看得见用不了"，
   比没有更让人骂）。真要加：改 primary 的 call 分支 + 加一条 arity 检查，一处的事。 */
const ARITY = {}
for (const k of Object.keys(FN1)) ARITY[k] = 1

// ───────────────────────── 一、切词 ─────────────────────────

/* `2e-3` 必须切成**一个数**，而不是 `2 * e - 3` ——
   所以这里把科学计数法整个吃下来；指数部分没数字时不吃，
   于是 `2e` 切成 `2` 和 `e`，交给后面的隐式乘法拼成 `2*e`。 */
const NUM = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const OPS = '+-*/^%=(),'
const BAD_RUN = /^[^\s0-9A-Za-z+\-*/^%=(),]+/

/* 认得的多字符词（常量 + 函数名）。**长的排在前面**：`log10` 必须先于 `log` 被认走。 */
const KNOWN = [...Object.keys(CONSTS), ...Object.keys(FN1)].sort((a, b) => b.length - a.length)

/**
 * 一串字 → token 数组。
 *
 * ★★ **这里最要紧的一条：一次只吃一个字母。**
 * 它不是疏忽，是"隐式乘法"能不能成立的全部：`F = ma` 里的 `ma` 必须切成 `m`、`a`
 * 两个变量，才有可能在下一步插出 `m*a`。反过来先吃掉整个词（像别的语言那样
 * `ma` 就是叫 ma 的变量），`F = ma` 这条最常见的物理公式**一个字都算不出来**。
 * 代价是 `mass` 会被切成四个变量 —— 但这件事**看得见**（界面会列出四个框），
 * 而"ma 是变量"那条路坏起来是一声不响地给出错数。按规矩①，选看得见的那个。
 *
 * 例外只有一个：**认得的多字符词整体吃**（`pi` / `mu0` / `sqrt` / `log10`），
 * 见上面的 `KNOWN`。这是常量写法和"两个变量挨着"最大的区别：前者是我们已知的。
 *
 * @returns {{ok:true, toks:Array<{t:string,v:string,at:number}>}|{ok:false, why:string}}
 */
export function tokenize(src) {
  const s = String(src == null ? '' : src)
  const toks = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1
      continue
    }
    NUM.lastIndex = i
    const num = NUM.exec(s)
    if (num && num.index === i) {
      toks.push({ t: 'num', v: num[0], at: i })
      i += num[0].length
      continue
    }
    /* 认得的多字符词整体吃（长的优先，所以 log10 不会被 log 吃掉一半）。 */
    let word = null
    for (const k of KNOWN) {
      if (s.startsWith(k, i)) {
        word = k
        break
      }
    }
    if (word) {
      toks.push({ t: 'name', v: word, at: i })
      i += word.length
      continue
    }
    if (/[A-Za-z]/.test(c)) {
      toks.push({ t: 'name', v: c, at: i })
      i += 1
      continue
    }
    if (OPS.includes(c)) {
      const t = c === '(' ? '(' : c === ')' ? ')' : c === ',' ? ',' : c === '=' ? '=' : 'op'
      toks.push({ t, v: c, at: i })
      i += 1
      continue
    }
    /* ⚠ 认不出的字符（`·`、`×`、`∫`、中文、全角括号…）**当场退回**，整条式子不算。
       把这里放过去是最坏的后果：`∫ x dx` 会被切得七零八落、拼出一个谁也不知道
       是什么的式子，然后给出一个看起来挺像样的数。 */
    const bad = BAD_RUN.exec(s.slice(i))
    return { ok: false, why: `式子里有我不认的东西「${bad ? bad[0] : c}」` }
  }
  if (!toks.length) return { ok: false, why: '还是个空式子' }
  return { ok: true, toks }
}

const ENDS_FACTOR = (t) => t.t === 'num' || t.t === 'name' || t.t === ')'
const STARTS_FACTOR = (t) => t.t === 'num' || t.t === 'name' || t.t === '('

/**
 * 插 `*` —— 手写的式子靠**挨着**表示乘：`ma`、`2pi`、`(a+b)c`、`2(x+1)`。
 *
 * ⚠ 只有一处例外：`名字(` 可能是**函数调用**也可能是隐式乘法（`f(x)`）。
 *   判据是"这个名字是不是我们已经知道的函数"，是就当场标成 call，
 *   不是就插乘号。**绝不反过来先当变量试一遍再说** —— 这两条路会算出完全不同的数，
 *   而这里不存在"算不出来就退回来重猜"的机会。
 */
function insertMul(toks) {
  const out = []
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]
    const prev = out[out.length - 1]
    if (prev && prev.t === 'name' && t.t === '(' && ARITY[prev.v] !== undefined) {
      out.length = out.length - 1
      out.push({ t: 'call', v: prev.v, at: prev.at })
      out.push(t)
      continue
    }
    if (prev && ENDS_FACTOR(prev) && STARTS_FACTOR(t)) out.push({ t: 'op', v: '*', at: t.at, implicit: true })
    out.push(t)
  }
  return out
}

// ──────────────────── 二、token → 语法树 ────────────────────

/* 递归下降。四个优先级从松到紧：
     expr  := term (('+'|'-') term)*
     term  := unary (('*'|'/'|'%') unary)*
     unary := '-' unary | power           ← ★ 负号在幂**外面**：-2^2 = -(2^2) = -4
     power := primary ('^' unary)?        ← 右结合，且指数那个位置允许再生出 unary
   `-2^2` 要是算成 `(-2)^2 = 4` 就错了 —— 这是约定俗成的那个坑，
   特意把 unary 压在 power 外面来得到正确答案。 */

function parseToks(src, toks) {
  let i = 0
  const peek = () => (i < toks.length ? toks[i] : null)
  const at = () => (i < toks.length ? toks[i].at : src.length)

  function expr() {
    let a = term()
    if (!a.ok) return a
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op' || (t.v !== '+' && t.v !== '-')) break
      i += 1
      const b = term()
      if (!b.ok) return b
      a = { ok: true, node: { k: 'bin', op: t.v, a: a.node, b: b.node } }
    }
    return a
  }

  function term() {
    let a = unary()
    if (!a.ok) return a
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op' || (t.v !== '*' && t.v !== '/' && t.v !== '%')) break
      const implicit = t.v === '*' && !!t.implicit
      i += 1
      const b = unary()
      if (!b.ok) return b
      a = { ok: true, node: { k: 'bin', op: t.v, a: a.node, b: b.node, implicit } }
    }
    return a
  }

  function unary() {
    const t = peek()
    if (t && t.t === 'op' && t.v === '-') {
      i += 1
      const a = unary()
      if (!a.ok) return a
      return { ok: true, node: { k: 'neg', a: a.node } }
    }
    if (t && t.t === 'op' && t.v === '+') {
      i += 1 // 一元正号：什么事都没有，但它得允许出现（`+3`）
      return unary()
    }
    return power()
  }

  function power() {
    const base = primary()
    if (!base.ok) return base
    const t = peek()
    if (t && t.t === 'op' && t.v === '^') {
      i += 1
      const ex = unary() // 右结合：2^3^2 = 2^(3^2)
      if (!ex.ok) return ex
      return { ok: true, node: { k: 'bin', op: '^', a: base.node, b: ex.node } }
    }
    return base
  }

  function primary() {
    const t = peek()
    if (!t) return { ok: false, why: '式子到一半就没了' }
    if (t.t === 'num') {
      i += 1
      return { ok: true, node: { k: 'num', v: Number(t.v) } }
    }
    if (t.t === '(') {
      i += 1
      const a = expr()
      if (!a.ok) return a
      const c = peek()
      if (!c || c.t !== ')') return { ok: false, why: '有个括号没合上' }
      i += 1
      return a
    }
    if (t.t === 'call') {
      i += 1
      if (ARITY[t.v] !== 1) return { ok: false, why: `还不支持 ${t.v} 这个函数` }
      const open = peek()
      if (!open || open.t !== '(') return { ok: false, why: `${t.v} 后面少了个括号` }
      i += 1
      const a = expr()
      if (!a.ok) return a
      const close = peek()
      if (!close || close.t !== ')') return { ok: false, why: `${t.v} 的括号没合上` }
      i += 1
      return { ok: true, node: { k: 'call', fn: t.v, args: [a.node] } }
    }
    if (t.t === 'name') {
      i += 1
      /* ★ 已知函数却**没跟括号**（手写常出现的 `sin x`）→ 报错，并且告诉他该怎么改。
         `sin x` 看着明白，可 `sin 2x` 到底是不是 sin(2x) 只有写的人知道，
         猜错的那个数照样看着很合理。**加括号是零成本的**，所以这里不替他决定。 */
      if (ARITY[t.v] !== undefined) {
        return { ok: false, why: `「${t.v}」是个函数，得写成 ${t.v}(x) —— 被它作用的东西放进括号里` }
      }
      /* ★ `f(x)` 到这儿已经变成 `f * (x)` 了（`insertMul` 插的乘号）：
         一个不认识的名字后面跟着括号，一律理解成"这是个变量、乘以后面那一坨"。
         不报错、也不猜它是函数 —— 摩擦力就叫 f，`f(θ)` 常常就是 f·θ。 */
      return { ok: true, node: { k: 'name', v: t.v } }
    }
    if (t.t === 'op') return { ok: false, why: `「${t.v}」的位置不对（前面少了个量）` }
    return { ok: false, why: '这条式子读不下去' }
  }

  const r = expr()
  if (!r.ok) return r
  if (i < toks.length) {
    const t = toks[i]
    const w = t.v === ')' ? '多了一个右括号' : `多了个「${t.v}」，读不下去了`
    return { ok: false, why: w }
  }
  return r
}

/**
 * 把一串 src 读成一棵可以算的树。
 *
 * @returns {{ok:true, node, target:string|null, vars:string[]}|{ok:false, why:string}}
 *   `target` = 等号左边那个量（`F = ma` 里的 `F`），没有等号就是 null；
 *   `vars` = 需要你给值的那些符号，**按出现顺序**，不去重以外的事。
 */
export function readFormula(src) {
  const s = String(src == null ? '' : src)
  if (!s.trim()) return { ok: false, why: '还是个空式子' }

  const tk = tokenize(s)
  if (!tk.ok) return tk

  /* 等号：最多一个，而且左边必须是**孤零零一个量**。
     `F = ma` 能算（求 F），`a + b = c` 算不了 —— 那是在解方程，不是这个东西。 */
  let body = tk.toks
  let target = null
  const eq = tk.toks.filter((t) => t.t === '=')
  if (eq.length === 1) {
    const idx = tk.toks.findIndex((t) => t.t === '=')
    const left = tk.toks.slice(0, idx)
    if (left.length !== 1 || left[0].t !== 'name') return { ok: false, why: '等号左边只能是一个量（算的是它）' }
    target = left[0].v
    body = tk.toks.slice(idx + 1)
    if (!body.length) return { ok: false, why: '等号右边什么都没有' }
  } else if (eq.length > 1) {
    return { ok: false, why: '式子里有好几个等号（连等式我解不了）' }
  }

  const p = parseToks(s, insertMul(body))
  if (!p.ok) return p
  return { ok: true, node: p.node, target, vars: varsOf(p.node), warn: slashWarn(p.node) }
}

const kids = (n) => {
  if (!n) return []
  if (n.k === 'neg') return [n.a]
  if (n.k === 'call') return n.args || []
  if (n.k === 'bin') return [n.a, n.b]
  return []
}

/**
 * 「这个除法，可能和你脑子里的不是一个意思」—— 手写式子**最常见**的那个错。
 *
 * `mu0 I / 2 pi r`：你写的时候想的是 μ₀I/(2πr)，
 * 而按运算符优先级它其实是 ((μ₀·I)/2)·π·r —— 两个数**差好几个量级**，
 * 而且都长得像那么回事。这是法则Ⅲ"宁可不算，不许算错"要防的头号对象。
 *
 * 判据：**一个隐式乘号，它左边那半棵子树里有除法**。
 *   `((a/b)c)`  ← c 是挨上来的，左边有 ⇒ 报警
 *   `(a*b)/c`   ← 显式星号才写得出来，不报（人家把话说清楚了）
 *   `2*pi*r/3`  ← 同理，不报
 * ★ 它只是一个**提醒**（`warn`），结果照算 —— 因为这两种写法里有一种本来就是对的。
 *   界面上显示为"建议给分母加个括号"，让学生自己拍板。
 */
export function slashWarn(node) {
  const hasDiv = (n) => {
    if (!n) return false
    if (n.k === 'bin' && n.op === '/') return true
    return kids(n).some(hasDiv)
  }
  let hit = false
  ;(function walk(n) {
    if (!n || hit) return
    if (n.k === 'bin' && n.op === '*' && n.implicit && hasDiv(n.a)) {
      hit = true
      return
    }
    kids(n).forEach(walk)
  })(node)
  return hit
}

/** 这棵树上哪些符号要用户给值：既不是常量、也不是函数名的那些。 */
export function varsOf(node) {
  const seen = new Set()
  const out = []
  ;(function walk(n) {
    if (!n) return
    if (n.k === 'name') {
      if (CONSTS[n.v] === undefined && ARITY[n.v] === undefined && !seen.has(n.v)) {
        seen.add(n.v)
        out.push(n.v)
      }
      return
    }
    if (n.k === 'neg') return walk(n.a)
    if (n.k === 'call') return n.args.forEach(walk)
    if (n.k === 'bin') {
      walk(n.a)
      walk(n.b)
    }
  })(node)
  return out
}

// ──────────────────── 三、代值算出一个数 ────────────────────

/**
 * @param {object} node `readFormula` 交回来的树
 * @param {Record<string, number>} values 各符号的值；**会覆盖 `CONSTS`**（见上面那条）
 * @returns {{ok:true, value:number}|{ok:false, why:string}}
 *
 * ⚠ 分母为 0 这类事不抛异常 —— JS 里 `1/0` 是 `Infinity`，那不算错，
 *   但 `0/0` 是 `NaN`，它会一路传染到最后的结果上，所以最后统一拦一道。
 */
export function evalFormula(node, values = {}) {
  const v = values && typeof values === 'object' ? values : {}
  let why = null
  function walk(n) {
    if (why) return 0
    if (n.k === 'num') return n.v
    if (n.k === 'neg') return -walk(n.a)
    if (n.k === 'name') {
      if (Object.prototype.hasOwnProperty.call(v, n.v)) {
        /* ⚠ **空字符串不是 0**：`Number('')` 偏偏等于 0，
           于是"那个框还没填"会变成"那个量是 0"，结果照样算得出来、
           而且不一定等于 0 —— 学生以为自己填了，其实没有。这是最坏的一种错。
           所以空值走"还不知道"那条路，界面上明摆着缺哪一个。 */
        const raw = v[n.v]
        const s = typeof raw === 'string' ? raw.trim() : raw
        if (s === '' || s === null || s === undefined) {
          why = `还不知道「${n.v}」是多少`
          return 0
        }
        const x = Number(s)
        if (!Number.isFinite(x)) {
          why = `「${n.v}」给的不是个数`
          return 0
        }
        return x
      }
      if (CONSTS[n.v] !== undefined) return CONSTS[n.v]
      why = `还不知道「${n.v}」是多少`
      return 0
    }
    if (n.k === 'call') {
      const f = n.args.length === 1 ? FN1[n.fn] : null
      if (!f) {
        why = `还不支持 ${n.fn}`
        return 0
      }
      return f(walk(n.args[0]))
    }
    if (n.k === 'bin') {
      const a = walk(n.a)
      const b = walk(n.b)
      if (why) return 0
      if (n.op === '+') return a + b
      if (n.op === '-') return a - b
      if (n.op === '*') return a * b
      if (n.op === '/') return a / b
      if (n.op === '%') return a % b
      if (n.op === '^') return Math.pow(a, b)
    }
    why = '这条式子算不了'
    return 0
  }
  const value = walk(node)
  if (why) return { ok: false, why }
  if (!Number.isFinite(value)) return { ok: false, why: '算出来不是一个有限的数（检查有没有除以 0、开负数平方）' }
  return { ok: true, value }
}

/**
 * 把结果摆成人看得懂的样子。
 *
 * ★ 为什么不用 `toFixed(6)`：物理作业上的数跨 20 个量级（10⁻³⁴ 到 10²³），
 *   定死小数位数会把普朗克常数印成 `0.000000`。反之又是 π 打出一串 `3.141592653589793`。
 *   所以：**够整的就短写，很小很大的用科学计数法，中间的按有效数字截断**。
 */
export function formatValue(n) {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e6 || abs < 1e-4) {
    return n
      .toExponential(4)
      .replace(/e([+-])(\d+)/, (_, s, d) => `×10${s === '-' ? '⁻' : ''}${supDigits(d)}`)
      .replace(/\.0+(?=×)/, '')
  }
  if (Number.isInteger(n)) return String(n)
  const s = String(Number(n.toPrecision(10)))
  return s
}

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }
const supDigits = (d) => String(d).replace(/\d/g, (c) => SUP[c] || c)
