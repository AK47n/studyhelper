/* ═══════════ 转录结果的本地缓存：同一块没改过就别再花一次钱 ═══════════
 *
 * 2026-09-19（ADR-0004 第 3 步）。为什么要有它：整板转录一块要几十秒、还要付一次钱，
 * 而"改一笔再收一次"是常态 —— 那时候**没动过的那几块**凭什么再认一遍？
 *
 * 三条规矩：
 *   ① 键是**内容**哈希（笔迹的点、笔宽、工具 + 一个 flavor），**不含 id** ——
 *      同一块内容复制粘贴到别处、id 全换了，也该命中（id 是身份，不是内容）；
 *   ② 认不出来（失败）的东西**不进缓存**：一次网络抖动不该被记成"这块就是空的"；
 *   ③ 有上限、坏了就当没有：存不下（配额满 / 隐私模式 / JSON 坏了）一律**静默降级**成
 *      "没有缓存"，绝不能因为一个缓存把"收成笔记"整个拦住。
 *
 * ⚠ 它是**本地**的（localStorage），不新增任何出网面。
 * ⚠ 缓存只服务「▤ 收成笔记」这条路（框选认公式 / 美化手写那两条是"我点了就要现在认"，
 *   沿用它们原来的行为）—— 想强制重认：校对弹层里每块都有「重新认这一块」。
 */
export const OCR_CACHE_VERSION = 1
export const OCR_CACHE_KEY = 'studyhelper.ocrCache'
/* 上限按**块**算。一块的正文通常几百字，30 块 ≈ 几十 KB —— 留着几节课的量足够了。 */
export const OCR_CACHE_MAX = 30

/* FNV-1a：短、够散、不用 crypto（那玩意儿在 node 自检里还得 polyfill）。 */
function fnv(str, seed = 0x811c9dc5) {
  let h = seed
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/* 一笔的指纹。点**取一位小数**：坐标在内存里是浮点，存盘会四舍五入 ——
   0.04 这种差别不是"你改了字"，不该让缓存失效；而真改了字，动的绝不止 0.1。 */
function strokeFingerprint(s) {
  const pts = (s && Array.isArray(s.points)) ? s.points : []
  let out = (s && s.tool) || 'pen'
  out += '|' + (s && s.width != null ? Math.round(Number(s.width) * 10) / 10 : '')
  for (let i = 0; i + 1 < pts.length; i += 3) {
    out += ',' + Math.round(Number(pts[i]) * 10) + ',' + Math.round(Number(pts[i + 1]) * 10)
  }
  return out
}

/* 一块笔迹的缓存键。★ 不含 id、不含顺序之外的东西 —— 见文件头 ①。
   `flavor` 是"这次请求长什么样"：模式（board）、模型名之类。换了模型就该重认。 */
export function blockKey(strokes, { flavor = '' } = {}) {
  const list = Array.isArray(strokes) ? strokes : []
  let h = 0x811c9dc5
  h = fnv('v' + OCR_CACHE_VERSION + '|' + flavor + '|' + list.length + '|', h)
  for (const s of list) h = fnv(strokeFingerprint(s) + '\n', h)
  return 'k' + h.toString(36)
}

/* 浏览器那边该用哪个 storage。单独一个函数是因为**取 localStorage 本身会抛**
   （隐私模式 / 被策略拦掉），而"没有缓存"是完全可以接受的状态。
   ⚠ node 里（自检）没有 localStorage → 回 null，调用方照样能跑。 */
export function browserStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/* 缓存本体。**存储是注进来的**（浏览器传 localStorage，自检传一个假的）——
   于是"上限怎么剔、坏 JSON 怎么办"这些能在 node 里断言，不用真浏览器。 */
export function makeOcrCache(storage) {
  const read = () => {
    try {
      const raw = storage && storage.getItem(OCR_CACHE_KEY)
      if (!raw) return { v: OCR_CACHE_VERSION, items: [] }
      const obj = JSON.parse(raw)
      if (!obj || obj.v !== OCR_CACHE_VERSION || !Array.isArray(obj.items)) return { v: OCR_CACHE_VERSION, items: [] }
      /* 坏条目（没有 k/text 的）就地扔掉，别让它一路传下去 */
      return { v: OCR_CACHE_VERSION, items: obj.items.filter((it) => it && typeof it.k === 'string' && typeof it.text === 'string') }
    } catch {
      /* 配额满 / 隐私模式 / JSON 坏了 —— 一律当"没有缓存"，绝不抛 */
      return { v: OCR_CACHE_VERSION, items: [] }
    }
  }
  const write = (obj) => {
    try {
      if (storage && storage.setItem) storage.setItem(OCR_CACHE_KEY, JSON.stringify(obj))
    } catch {
      /* 存不下就算了：缓存是省事用的，不是正确性的一部分 */
    }
  }
  return {
    /** 命中就回那段字（并把这一条挪到最前面 = LRU）；没有回 null */
    get(key) {
      if (!key) return null
      const obj = read()
      const i = obj.items.findIndex((it) => it.k === key)
      if (i < 0) return null
      const hit = obj.items[i]
      if (i > 0) {
        obj.items.splice(i, 1)
        obj.items.unshift(hit)
        write(obj)
      }
      return { text: hit.text }
    },
    set(key, text, at = Date.now()) {
      if (!key || !String(text || '').trim()) return
      const obj = read()
      const rest = obj.items.filter((it) => it.k !== key)
      rest.unshift({ k: key, text: String(text), at })
      write({ v: OCR_CACHE_VERSION, items: rest.slice(0, OCR_CACHE_MAX) })
    },
    clear() {
      write({ v: OCR_CACHE_VERSION, items: [] })
    },
    size() {
      return read().items.length
    },
  }
}
