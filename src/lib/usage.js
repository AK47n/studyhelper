/* 「这一趟花了多少」—— 用量的加总与说法。**纯函数，node 里断言得住**。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────
 *   · 它要被两处用（课件整理那一栏的汇总、追问每一条回答下面那一行），
 *     而"怎么把一笔笔 usage 加成一个数"只有一份规矩；
 *   · 服务端那份形状在 `server-ocr.js` 的 `usageOf`（它读上游的字段名），
 *     这一份只管**已经归一过的那种形状**的加总与显示 —— 两件事分得开，
 *     所以这一份能在 node 里被断言（`check-doc-read.js` 钉着）。
 *
 * ── 一条纪律：**"读不到"和"是 0"是两句不同的话** ──────────────────────
 * 上游没回 usage（老服务、别的 provider、缓存命中的那一页根本没出网）时，
 * `usageOf` 给的是 `null`。这里全程保留 null：没有一笔有数，就还是 null ——
 * 界面上宁可不显示这一行，也不要显示一个"输入 0、输出 0"的假账。
 *
 * ── 数怎么念 ───────────────────────────────────────────────────────────
 * token 是六位数起步的，逐位读没有意义。所以按"万"念到小数一位 ——
 * 用户要判断的是"这一趟是几分钱还是几毛钱"，不是精确到个位。
 */

/** 一笔空账（内部用）。 */
const ZERO = { prompt: 0, completion: 0, cached: 0, miss: 0, reasoning: 0, total: 0 }

/** 两笔用量相加。
 *  ⚠ 两边都是 null（两笔都没读到）→ 返回 null，不是零账 —— 见文件头那条纪律。 */
export function addUsage(a, b) {
  if (!a && !b) return null
  const one = (u) => {
    if (!u || typeof u !== 'object') return ZERO
    const out = {}
    for (const k of Object.keys(ZERO)) {
      const v = Number(u[k])
      out[k] = Number.isFinite(v) ? v : 0
    }
    return out
  }
  const x = one(a)
  const y = one(b)
  const out = {}
  for (const k of Object.keys(ZERO)) out[k] = x[k] + y[k]
  return out
}

/** 把一堆用量加成一个（空数组 → null）。 */
export function sumUsage(list) {
  let acc = null
  for (const u of list || []) acc = addUsage(acc, u)
  return acc
}

/** 输入里命中缓存的比例（0~1）。没有输入时说 null（不是 0）。 */
export function hitRate(u) {
  const prompt = Number(u && u.prompt)
  const cached = Number(u && u.cached)
  if (!Number.isFinite(prompt) || prompt <= 0 || !Number.isFinite(cached)) return null
  return Math.min(1, Math.max(0, cached / prompt))
}

/** 一个数怎么念：一万以下照原样，一万以上按"万"说一位小数。 */
export function tokenText(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  const abs = Math.abs(v)
  if (abs < 10000) return String(Math.round(v))
  return (v / 10000).toFixed(1) + '万'
}

/**
 * 一行字（界面上直接显示）。
 * 读不出来（null / 全是 0 的假账）→ **空串**：宁可那一行不出现。
 *
 * 形状：`输入 4.0万（命中 90%）· 输出 6.4万（其中思考 5.1万）`
 *   · 命中率只在真有输入时写；
 *   · **思考**那一节只在真有 thinking 时写 —— 它算在"输出"里面，
 *     写出来是因为它常常占掉输出的大半（实测 69%~89%），
 *     不写的话"输出怎么这么多"就成了一笔看不见的账。
 */
export function usageText(u) {
  if (!u || typeof u !== 'object') return ''
  const prompt = Number(u.prompt) || 0
  const completion = Number(u.completion) || 0
  if (prompt + completion <= 0) return ''
  const parts = ['输入 ' + tokenText(prompt)]
  const rate = hitRate(u)
  if (rate != null && Number(u.cached) > 0) parts[0] += `（命中 ${Math.round(rate * 100)}%）`
  const out = '输出 ' + tokenText(completion)
  const reasoning = Number(u.reasoning) || 0
  parts.push(reasoning > 0 ? `${out}（其中思考 ${tokenText(reasoning)}）` : out)
  return parts.join(' · ')
}
