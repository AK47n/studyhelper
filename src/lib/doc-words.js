/* ═══════════ 从课件的字里挑出"用户点的那个词"（2026-09-28）══════════════
 *
 * 为什么单开一个 module：这是整套「速查」里唯一带**判断**的一块，而且判断会出错 ——
 * 中文没有空格，"点到这个字"和"他要问的词"之间隔着一层猜。
 * 把它关在这里（纯函数、不碰 DOM、不碰网络），就能不开浏览器地断言它：
 * 「点在第 5 个字上应该拿到『傅里叶变换』而不是整句标题」这种话才说得出口。
 *
 * ── 先说清楚这件事的天花板 ─────────────────────────────────────────────
 * 这里做的是**启发式的切词**，不是分词器：
 *   "回顾：连续时间傅里叶变换公式" —— 点在「傅」上，凭那个"："能推出
 *   用户要问的是这一串，但它分不出该断在「傅里叶变换」还是连着后面的「公式」。
 *   真正断开需要一个词库，这里不偷这个懒，也不假装做得到。
 *   ★ 所以**界面必须让用户改**：挑出来的词是**预填**，不是答案。
 *
 * ── 坐标的说法 ─────────────────────────────────────────────────────────
 * 入参 `items` 就是 `doc-pages.js` 的 `pageTextItems()` 交出来的那一族：
 *   { str, x0, x1, y0, y1 }，全部**归一化**（0~1，相对这一页宽高，y 朝下）。
 * 点的坐标同理。两边同一个说法，谁调用都不用再换算。
 */

/** 一个词最多取多少个字。PPT 标题常常是一整句，全要了等于没切。 */
export const MAX_TERM = 12
/** 点到行外面多远还算"点在这一行"（归一化距离）。行距常常比字还宽，
 *  鼠标落点偏一点是常态，但也不能大到把隔壁行认回来。 */
export const LINE_TOL = 0.02

/* 遇到就"这个词到这儿为止"的字符：中英文标点、括号、引号、空白。
   ⚠ **数字和字母不停**：`H(z)`、`f(t)` 是理工课件的家常便饭，
     在数字那儿斩断的话，"拉普拉斯变换"会被切出一个孤零零的 s。 */
const STOP = /[\s（）()【】\[\]{}《》〈〉「」『』“”‘’"'`｀、，。；：！？…—–·,.;:!?/\\|]/

/** 全角字符算 1，半角算 0.55 —— 用来按视觉宽度摆每个字的位置。 */
function isWide(cp) {
  const c = cp.codePointAt(0)
  if (c >= 0x3000 && c <= 0x303f) return true // 中文标点
  if (c >= 0x4e00 && c <= 0x9fff) return true // 汉字
  if (c >= 0x3400 && c <= 0x4dbf) return true // 扩展 A
  if (c >= 0xff01 && c <= 0xff60) return true // 全角标点/字母
  if (c === 0x3000) return true // 全角空格
  return false
}

/** 一段字的视觉宽度（全角 1、半角约 0.55）。 */
function strWidth(units) {
  let n = 0
  for (const ch of units) n += isWide(ch) ? 1 : 0.55
  return n || 1
}

/* ⚠ 全程拿 **Array.from(str)** 当基本单位操作，不用 `str[i]`：
   PPT 里那些数学斜体字母（`𝑿`、`𝝎`）是 U+1D4XX 的**代理对**，占两个 UTF-16 码元。
   按 str[i] 切的话会在 surrogate pair 中间斩一刀，取出来的词是半个字（渲染成一坨方块），
   而这个 Bug 只在公式页面上出现 —— 恰恰是最需要查词的那种课件。 */
const unitsOf = (s) => Array.from(String(s || ''))

/** 第 i 个字（UTF-16 无关的那个 i）的两个端点，归一化。 */
function unitSlot(item, units, i) {
  let before = 0
  for (let k = 0; k < i; k += 1) before += isWide(units[k]) ? 1 : 0.55
  const wNow = isWide(units[i]) ? 1 : 0.55
  const total = strWidth(units)
  const w = item.x1 - item.x0
  return { x0: item.x0 + (w * before) / total, x1: item.x0 + (w * (before + wNow)) / total }
}

/** 点了这一行的哪个字：返回下标（越界夹到首尾）。 */
export function charIndexAt(item, px) {
  const units = unitsOf(item.str)
  if (!units.length) return 0
  const w = item.x1 - item.x0
  if (w <= 0) return 0
  /* 二分找**最后一个**"起点在 px 之前"的字 —— 这一行可能有十几个字，
     而这函数在鼠标挪动时会被连续调用。 */
  let lo = 0
  let hi = units.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (unitSlot(item, units, mid).x0 <= px) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, Math.min(units.length - 1, lo))
}

/** 从一个字往两边长出一个词：撞到 STOP 就停，最多 MAX_TERM 个字。 */
function growWord(units, idx) {
  let a = idx
  let b = idx
  while (a > 0 && !STOP.test(units[a - 1]) && idx - a + 1 < MAX_TERM) a -= 1
  while (b < units.length - 1 && !STOP.test(units[b + 1]) && b - a + 1 < MAX_TERM) b += 1
  /* 蜕掉首尾沾上的空白/标点（比如正好点在 "… =" 边上）。 */
  let out = units.slice(a, b + 1)
  while (out.length && STOP.test(out[0])) out = out.slice(1)
  while (out.length && STOP.test(out[out.length - 1])) out = out.slice(0, -1)
  return out.join('')
}

/* 命中哪一行：优先"y 落在它行内"，一个都没有就取**垂直接近**的那一行（容差 LINE_TOL）。
   为什么要有容差：点在"第 3 行和第 4 行之间的缝"上，严格判定会说"这儿没字"，
   而用户的意思明明就是"就这儿"。 */
export function hitItem(items, px, py) {
  const list = Array.isArray(items) ? items : []
  let best = null
  let bestD = Infinity
  for (const it of list) {
    if (px < it.x0 || px > it.x1) continue
    const d = py < it.y0 ? it.y0 - py : py > it.y1 ? py - it.y1 : 0
    if (d < bestD) {
      bestD = d
      best = it
      if (d === 0) break // 正中这一行，不用再看别的
    }
  }
  return bestD <= LINE_TOL ? best : null
}

/* 这一串里有没有"能查的东西"。
   ⚠ 判据是"至少有**一个字或一个数字**"（Unicode 的信件/数字两类，汉字算信件），
     不是"不是空白/标点" —— 后一种会被 `$`、`@` 那种符号混过去
     （它们既不是标点也算不上一个词，却在几乎所有"分不带符号"的判据里漏网）。 */
const CHAR = /[\p{L}\p{N}]/u
function hasSubstance(units) {
  return units.some((c) => CHAR.test(c))
}

/**
 * 点在这一页的 (x, y)（都归一化）→ 挑出一个候选词。
 * @returns `{ term, line, index } | null`
 *   · `line` = 它所在的那整段字（给界面当上下文：光看一个词常常判断不出
 *     是不是自己要问的那个，尤其在字号很小的课件上）；
 *   · `null` = 这一点附近没有字（点在页边的空白上），
 *     或者**挑出来的只剩符号** —— 下面 ⚠ 那条说的就是它。
 */
export function pickWord(items, px, py, opt = {}) {
  const it = hitItem(items, px, py)
  if (!it) return null
  const idx = charIndexAt(it, px)
  const units = unitsOf(it.str)
  const term = growWord(units, idx)
  if (!term) return null
  /* ⚠⚠ 全是标点/符号 ⇒ **不开窗**（2026-09-28 check-look 的 A5 抓到的）：
     点在 `$H(z)$` 收尾那个 `$` 上，左邻是 `)`、右邻是空格 —— 两边都长不出去，
     于是"词"就是孤零零一个 `$`。界面拿到它会自动发一次请求，
     换来的是模型对一个美元符号讲一段话 —— 那是白白花掉的一次钱和一个"···"。
     ⇒ 一个字母/数字都没有的话，当成"这儿没有可查的东西"（和点在空白处同一条处理）。 */
  if (!hasSubstance(Array.from(term))) return null
  const max = Number(opt.maxTerm) > 0 ? Number(opt.maxTerm) : MAX_TERM
  return { term: Array.from(term).slice(0, max).join(''), line: it.str, index: idx }
}
