/* 「这次要嵌进导出文件里的公式字体」——挑哪些、从哪儿读、怎么变 base64。
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────
 * 导出的网页必须**断网也能看**，所以公式字体不能 `url()` 指外部，
 * 得把字体文件的字节塞进 CSS 里（base64）。
 * 而 KaTeX 一共 59 个字体文件、1 MB 出头 —— 全塞进去，一份两页的笔记也成 1.4 MB。
 * 所以：**只嵌真的用到的**。
 *
 * ── 「用到了」怎么问出来（2026-09-18 改过一次，记下来）──────────────
 * 第一版是"canvas 逐字比对宽度"：给每个字符在每种字体下量宽度，宽度变了就算命中。
 * 那个办法**不可靠** —— 它比的是"兜底字体 vs 目标字体"的宽度差，
 * 而很多字符在两者下恰好同宽（尤其中文标点和数字），于是漏判；
 * 更糟的是浏览器里字体**异步加载**，量的时候字体可能根本还没到位，
 * 量到的全是兜底字体 —— 结果是"一个字体都不嵌"，公式发出去还是乱的，
 * 而导出这一步看着一切正常。
 *
 * 现在改用**浏览器自己那本账**：`document.fonts`（FontFaceSet）。
 *   · KaTeX 的样式表声明了那些 @font-face，浏览器真的去加载了哪个，
 *     账本上就有哪一条 —— 这不是"猜"，是**读事实**。
 *   · `document.fonts.ready` 等所有字体就位，于是不会量到"还没加载"的中间态。
 *   · 判据是 `face.status === 'loaded'`：**只有真下过字节的才算**。
 *     声明的字体没被用到时 status 是 'unloaded'，正好帮我们把不用的排除掉。
 *
 * ── 退路 ────────────────────────────────────────────────────────────
 * 什么都问不出来（老浏览器没有 FontFaceSet、或者全都没加载）就回空集，
 * 调用方走"一个都不嵌"：公式退到系统衬线体，看着糙但不空白、不报错。
 * **宁可丑，不可丢** —— 和这个仓库其他地方同一条规矩。
 */

/* KaTeX 的字体族名 → dist/assets 里的文件名前缀。
 * 这些名字是 KaTeX 自己定的（它的 CSS 里就是这些 @font-face）。
 *
 * ★ 第二条（变体）是"该族**优先**嵌哪个文件"。
 *   KaTeX 每个族有 Regular/Bold/Italic… 好几个文件，一个字符具体落在哪个
 *   由公式里的排版决定，而**我们不去猜** —— 见下面的 `expandVariant`：
 *   一个族被用到了，就把它的常规那几个变体都嵌上（几百字节到几十 KB）。
 *   多嵌一点点，换"绝不会因为少一个变体而让某个符号变丑"，划算。
 */
export const KATEX_FAMILIES = [
  'KaTeX_Main',
  'KaTeX_Math',
  'KaTeX_Size1',
  'KaTeX_Size2',
  'KaTeX_Size3',
  'KaTeX_Size4',
  'KaTeX_AMS',
  'KaTeX_Caligraphic',
  'KaTeX_Fraktur',
  'KaTeX_SansSerif',
  'KaTeX_Script',
  'KaTeX_Typewriter',
]

/* 每个族要嵌的变体。主字体给全（正/粗/斜/粗斜 —— 公式里都会出现），
 * 装饰性的族（花体、手写体）只给常规 + 粗：它们是"符号"，很少带字重。 */
const FAMILY_VARIANTS = {
  KaTeX_Main: ['Regular', 'Bold', 'Italic', 'BoldItalic'],
  KaTeX_Math: ['Italic', 'BoldItalic'],
  KaTeX_Size1: ['Regular'],
  KaTeX_Size2: ['Regular'],
  KaTeX_Size3: ['Regular'],
  KaTeX_Size4: ['Regular'],
  KaTeX_AMS: ['Regular'],
  KaTeX_Caligraphic: ['Regular', 'Bold'],
  KaTeX_Fraktur: ['Regular', 'Bold'],
  KaTeX_SansSerif: ['Regular', 'Bold', 'Italic'],
  KaTeX_Script: ['Regular'],
  KaTeX_Typewriter: ['Regular'],
}

/**
 * 问浏览器：这份文档真的加载了哪几种 KaTeX 字体？
 * **只在浏览器里能调**（要 document.fonts）。
 *
 * @param {number} waitMs  最多等字体就位多久（别把导出卡死）
 * @returns {Promise<string[]>}  族名数组；问不出来回 []（调用方走"不嵌"的退路）
 */
export async function detectLoadedFamilies(waitMs = 1200) {
  try {
    if (typeof document === 'undefined' || !document.fonts) return []
    /* 等字体就位。★ 一定要有超时：万一某个字体永远不 loaded，
       导出不能跟着一起挂住 —— 用户只会看到"按钮点了没反应"。 */
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, waitMs))])
    const hit = new Set()
    document.fonts.forEach((face) => {
      const fam = String(face.family || '').replace(/^['"]|['"]$/g, '')
      if (!KATEX_FAMILIES.includes(fam)) return
      /* 只认真下过字节的。`unloaded` = 声明了但没用到，正是要排除的那些。 */
      if (face.status === 'loaded') hit.add(fam)
    })
    return [...hit]
  } catch {
    return []
  }
}

/**
 * 把要嵌的字体的字节读出来，变成 `{ family: base64 }`。
 * 这个函数是**纯 IO + 编码**，能在 node 里测（给它一个假的 listFiles/readFile）。
 *
 * @param {Iterable<string>} families  要嵌哪几个族（detectLoadedFamilies 的结果）
 * @param {object} io
 *   listFiles()        → ['KaTeX_Main-Regular-B22Nviop.woff2', …]（dist/assets 里的文件名）
 *   readFile(name)     → Buffer | Uint8Array
 */
export function collectFontFiles(families, { listFiles, readFile } = {}) {
  const out = {}
  let names = []
  try {
    names = listFiles() || []
  } catch {
    return out
  }
  const want = new Set(families || [])
  for (const family of KATEX_FAMILIES) {
    if (!want.has(family)) continue
    const variants = FAMILY_VARIANTS[family] || ['Regular']
    for (const variant of variants) {
      /* 只收 woff2：三种格式里最小，而 woff2 的支持度早就不是问题
         （2016 年以后的浏览器全支持）。woff/ttf 是给古老浏览器留的退路，
         内联它们等于白白把体积翻三倍。 */
      const prefix = `${family}-${variant}`
      const name = names.find((n) => n.startsWith(prefix) && n.endsWith('.woff2'))
      if (!name) continue // 没这个文件：跳过，不报错（公式退到衬线体）
      try {
        const buf = readFile(name)
        /* 一个族有多个变体：CSS 里要**分别**声明，否则浏览器只会用一种字形
           去画粗体（那正是"公式里该粗的地方没粗"）。所以 key 用
           `族-变体`，见 export-html.js 里拼 @font-face 的那段。 */
        out[`${family}-${variant}`] = {
          family,
          /* @font-face 的 font-weight/style 要写对，不然浏览器会拿常规字形
             硬撑粗斜体（看着像"糊了"，其实是合成出来的假粗体）。 */
          weight: variant.includes('Bold') ? 'bold' : 'normal',
          style: variant.includes('Italic') ? 'italic' : 'normal',
          b64: Buffer.from(buf).toString('base64'),
        }
      } catch {
        /* 单个字体读不出来不该让整次导出失败 */
      }
    }
  }
  return out
}
