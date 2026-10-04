/* ═══════════ 速查：发那一次请求、把回来的四行拆开、记住查过的词 ═══════════
 *
 * 这一族的三件事：
 *   ① `parseLookup` —— 把模型那四行（词/讲/例/近）拆成四个字段。**纯函数**，好断言；
 *   ② `readLookup`  —— 真发出去那一次（顺便管"取消"）；
 *   ③ 缓存         —— 同一个词在同一门课查过就**不再花钱**（下面那一整段说它为什么重要）。
 *
 * ── ★★ 缓存为什么是这一族的核心，而不是个优化 ────────────────────────────
 *   这个功能的场景是**上课**。上课真正会发生的不是"遇到一个新词"，
 *   而是"老师第三次说到这个词，我第三次忘了它" —— 同一个词会被反复查。
 *   没有缓存的话，第三次查同一件事要再付一次钱、再等 1.7 秒，
 *   而那 1.7 秒正是他最容易走神的窗口。
 *   ⇒ **命中就是瞬间**，而且此刻的网络和额度都帮不上忙了才需要的新答案。
 */

/* 缓存记多少条。几十个词足够覆盖"这一节课"，再多就是替他存了一本字典。 */
const CACHE_MAX = 60
const CACHE_KEY = 'studyhelper.lookup.v1'

/** 缓存的键：**课 + 词** —— 同一个词在大物和信号里是两个东西，
 *  少任何一半都会串台（在信号课上查过的"变换"，换个课去查不该命中）。 */
export function cacheKey(term, context) {
  const t = String(term || '').trim().toLowerCase()
  const c = String(context || '').trim().toLowerCase()
  return c + '‖' + t
}

/* localStorage 会缺（隐私模式 / 老版本 / 自检环境），缺了就退化成"每次都重查" ——
   ★ 那必须是个**能用的降级**，不是一个崩掉的降级：少一样优化不该让功能不能用。 */
function store() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function readCache() {
  const s = store()
  if (!s) return {}
  try {
    const o = JSON.parse(s.getItem(CACHE_KEY) || '{}')
    return o && typeof o === 'object' ? o : {}
  } catch {
    /* 存过一份坏的就当没有 —— 缓存是可以丢的东西，不该让它弹一句错给用户看 */
    return {}
  }
}

function writeCache(map) {
  const s = store()
  if (!s) return
  try {
    s.setItem(CACHE_KEY, JSON.stringify(map))
  } catch {
    /* 配额满了之类：丢掉缓存没有任何功能上的后果，别往上抛 */
  }
}

/** 这一趟以前查到过吗？ **同步** —— 命中就该是瞬间的，不该再过一道 await。 */
export function cachedLookup(term, context) {
  if (!String(term || '').trim()) return null
  return readCache()[cacheKey(term, context)] || null
}

/** 把这一趟的结果记住。按顺序挤掉最老的（简单的 FIFO：进来得早的通常也最久没用）。 */
export function rememberLookup(term, context, entry) {
  if (!String(term || '').trim() || !entry) return
  const map = readCache()
  map[cacheKey(term, context)] = entry
  const keys = Object.keys(map)
  if (keys.length > CACHE_MAX) {
    /* ⚠ 不能 `slice(0, n)` —— 对象键的顺序是**插入序**，而最老的那几个正是最该走的。 */
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete map[k]
  }
  writeCache(map)
}

/** 忘掉（换一门课时用不上，留着只是占地方）。 */
export function forgetLookup(drop) {
  const s = store()
  if (!s) return
  try {
    if (drop) {
      const map = readCache()
      for (const k of Object.keys(map)) if (drop(map[k])) delete map[k]
      writeCache(map)
    } else s.removeItem(CACHE_KEY)
  } catch {
    /* 同上：缓存是可丢的 */
  }
}

/* ═══════════ 把那四行拆开 ═══════════ */

/** 每一行的标签（和 LOOKUP_PROMPT 里写死的那四个字对着，改那边就得改这边）。 */
export const LOOKUP_FIELDS = [
  { key: 'term', label: '词' },
  { key: 'say', label: '讲' },
  { key: 'eg', label: '例' },
  { key: 'near', label: '近' },
]

/**
 * 模型回的那段字 → `{ term, say, eg, near[] }`。
 *
 * ★★ 三条容错，都是实测里真会发生的：
 *  ① **模型会漏行**（"近"常常懒得给）。⇒ 缺哪一行就缺着，**缺行不是失败** ——
 *     界面按"有才显示"处理。把它判成失败的话，用户看到的是"这次没查出来"，
 *     而其实解释已经好好地在那儿了。
 *  ② **冒号可能是中英文**（`词:` / `词：`），还可能有 Markdown 加粗（`**词：**`）。
 *     ⇒ 标签前后一律容忍这些装饰。
 *  ③ **一条内容可能占好几行**（式子长的时候）。⇒ 没标签的行接在**上一行的内容**后面，
 *     而不是丢掉（丢半句比多行更难读）。
 *
 * ⚠⚠ 最后一道兜底：**一个字段都没解析出来时，整段原文当"讲"**。
 *    宁可显示一段不那么齐整的字，也绝不给一块空白 —— 用户对着空白只会以为坏了。
 */
export function parseLookup(text) {
  const src = String(text || '')
  const out = { term: '', say: '', eg: '', near: [] }
  let cur = null // 正在写的那个字段（用于 ③ 的 continuation）
  let got = false // 有没有解析出任何东西

  for (const rawLine of src.split('\n')) {
    /* ⚠⚠ 这三步的**顺序不能乱**（2026-09-28 自检抓到的）：**先**剥 Markdown 加粗，
         再去行首那个列表符号。反过来的话 `**词**：…` 会被当成"列表项 `* ` 打头"，
         先给吃掉一颗星，剩下一个歪的 `*词**` 再也匹配不上，整行废掉。
       ⚠ 列表符号后面**必须有空格**才算：`-3dB`、`.5x` 在课件里到处都是，
         一刀下去式子就缺了一块。 */
    const clean = rawLine.trim().replace(/\*\*/g, '')
    const line = clean.replace(/^\s*[-*+]\s+/, '').replace(/^`|`$/g, '')
    if (!line) continue
    let hit = null
    for (const f of LOOKUP_FIELDS) {
      const re = new RegExp('^' + f.label + '\\s*[:：]\\s*(.*)$')
      /* ⚠ 用的是 `line`（**清理之后**的那一行），不是 `clean` ——
         剥掉列表符号这件事正是为了让下面这句匹配得上。 */
      const m = re.exec(line)
      if (m) {
        hit = { ...f, body: m[1].trim() }
        break
      }
    }
    if (hit) {
      got = true
      if (hit.key === 'near') {
        /* 「近」是一串词：按中英文逗号、顿号切开，空的不算。 */
        out.near = hit.body.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean)
      } else {
        out[hit.key] = hit.body
      }
      cur = hit.key
    } else if (cur && cur !== 'near') {
      /* ③ 接在上一行后面（换行当一个空格 —— 那是"同一句换了个行"，不是两段）。 */
      out[cur] = (out[cur] ? out[cur] + ' ' : '') + line
    }
  }

  if (!got) {
    const flat = src.replace(/```[a-zA-Z]*\n?/g, '').trim()
    if (flat) out.say = flat
  }
  return out
}

/* ═══════════ 发出去那一趟 ═══════════ */

/**
 * 查一个词。
 * @returns `{ term, say, eg, near, usage, cached }`
 * @throws 服务端给的那句人话（`kind:'stale'` 之类也在这翻译）。
 */
export async function readLookup({ term, line, context, signal } = {}) {
  const t = String(term || '').trim()
  if (!t) throw new Error('没有要查的词')

  const fromCache = cachedLookup(t, context)
  if (fromCache) return { ...parseLookup(fromCache.text), usage: null, cached: true }

  const fd = new FormData()
  fd.append('term', t)
  if (line) fd.append('line', String(line).slice(0, 2000))
  if (context) fd.append('context', String(context).slice(0, 500))
  const res = await fetch('/api/lookup', { method: 'POST', body: fd, signal })
  const body = await res.json().catch(() => null)
  if (!body) throw new Error(`本地服务返回了看不懂的内容（HTTP ${res.status}）`)
  if (!body.ok) throw new Error(String(body.error || '这次没查出来'))
  /* ★ 回声校验（和 AskBox 那一族的防线同一个形状）：服务端没重启的话它不认
     mode:'lookup'，会按公式认、把结果塞在别的字段里回来 —— 不查这一条，
     界面会把一句别的东西当成这个词的解释显示出来，而且**不报任何错**。 */
  if (body.mode !== 'lookup') throw new Error('本地服务还是旧版：它不知道「速查」这个口。把 studyhelper 关掉再打开一次。')

  rememberLookup(t, context, { text: body.text })
  return { ...parseLookup(body.text), usage: body.usage || null, cached: false }
}
