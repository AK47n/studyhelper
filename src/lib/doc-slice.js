/* 「只抽这几页」：把一本厚书里真正要用的那几页拎出来，另存一份薄 PDF。
 *
 * ── 为什么有它（用户 2026-09-21 的原话）───────────────────────────────────
 * 「题目在书上，但是这个书非常的长，我感觉要是为了做当中的几道题传上来一整个 pdf
 *   有点太费事。」
 * 几百页的书，做一次作业要用的常常只有两三页。整本收进 `data/.资料/` 是三件亏心事：
 *   · 上传要好几十 MB（一次拖进来得等好一会儿）；
 *   · 磁盘上躺着一本往后用不着的东西；
 *   · 板上排成几百页的长卷 —— **找"第 322 页"要滚很久**（这是最难忍的一条）。
 * 抽出来之后：传的是那两三页、板上就只有那两三页。而且**页码从头算起** ——
 * 往后做作业报「第 1 页第 3 题」就行，不用再记它在原书第几页。
 *
 * ── 为什么在浏览器里抽，不在服务端抽 ─────────────────────────────────────
 * 服务端那条底线还在：除了排版那一处，它不碰第三方依赖（见 server.js 文件头）。
 * 而 pdf-lib 在浏览器里就能办这件事：本地打开原文件 → 把那几页拷进一份新文档
 * → 上传这份薄的。**整个 *.pdf 一次都没有离开本机**（除了最后那一份薄的）。*
 *
 * ── 抽出来的还是矢量 ─────────────────────────────────────────────────────
 * `copyPages` 拷的是页面的内容流和资源，不是"渲染成图再包一层"：
 * 字放大照样清楚，而且常常比渲染一次 JPEG 还小得多。这一点直接影响后面那一趟 ——
 * 「作业辅导」「框选追问」本来就是把页面渲染成图发给模型的，源清楚才不会看错字。
 *
 * ── 数的那些讲究 ─────────────────────────────────────────────────────────
 * `SLICE_ASK_MIN`：多少页以上才值得问他一句。十几页的课件本来就不重，
 * 每次都多问一句是负担 —— 麻烦要给值得麻烦的那一档。
 */
import { pagesLabel } from './doc-cards.js'
/* ⚠ **不要**在这里 `import ... from './doc-pages.js'`：这一处的抽页逻辑是**纯的** ——
   `scripts/check-docslice.js` 在 node 里直接 import 它，不该顺手把"画页面"那一家子
   （pdf.js 的 worker 接线）也拉进来。（2026-09-24：pdf.js 本身已经改成用到才拉，
   但 doc-pages.js 仍然只在浏览器里跑 —— 这里的动态 import 求的是"node 里 import 得进来"。）
   ⚠ `vite build` 会为它报一句"dynamic import will not move module into another chunk"
   —— **故意的，别去"修"**：doc-pages.js 早被 Board/DocLayer 静态引进主包了，
   切不出去是自然的；这里的动态 import 求的不是分包，是"node 里 import 得进来"。 */

/** 这份 pdf 有多少页以上才问他"只要这几页吗"（含这个值）。 */
export const SLICE_ASK_MIN = 20

/**
 * 打开用户选中的那份 PDF（在浏览器内存里，不上传）。
 * @returns {Promise<{count:number, slice:(pages:number[])=>Promise<Blob>}>}
 *   `pages` 是 1 起的页码 —— 就是用户在那个框里写的那几个数。
 */
export async function openLocalPdf(file) {
  /* ⚠ pdf-lib 是**用到才装**（动态 import）：抽页这件事有人一次也用不着，
     而它是几百 KB 的家伙 —— 不该让每个打开白板的人都替它付这一份。
     vite 会把它切成单独一块，第一次真抽页时才拉下来。 */
  const { PDFDocument } = await import('pdf-lib')
  /* ⚠ `ignoreEncryption`：一部分教材 PDF 是"加过密的空密码"（能看、不许改），
     不忽略的话 pdf-lib 会直接抛 EncryptedPDFError —— 而用户那边看到的是
     "这本 PDF 打开不了"，可它明明能打开。 */
  const buf = await file.arrayBuffer()
  const src = await PDFDocument.load(buf, { ignoreEncryption: true })
  const count = src.getPageCount()
  /* 缩略图那份机器（pdf.js）。★ **用到才开**：多数人心里有页码、看都不看一眼，
     而一本几百页的书开第二份文档是要花钱的（内存 + 解析）。见 doc-pages.js。 */
  let thumber = null
  return {
    count,
    /** 预览那几页用的：把第 n 页画到 canvas 上（`openLocalThumbs` 的那一台机器）。 */
    async thumbs() {
      if (!thumber) {
        const { openLocalThumbs } = await import('./doc-pages.js')
        thumber = await openLocalThumbs(buf)
      }
      return thumber
    },
    /** 那个小窗关掉时必须调：额外开的那份 pdf.js 文档要放掉。 */
    close() {
      if (!thumber) return
      try {
        thumber.close()
      } catch {
        /* 放不掉无所谓 */
      }
      thumber = null
    },
    /** 把这几页拷成一份新 PDF。**返回 Blob**（给 Board 包成 File 去上传）。 */
    async slice(pages) {
      const want = (Array.isArray(pages) ? pages : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= count)
      if (!want.length) throw new Error('没挑中任何一页')
      const out = await PDFDocument.create()
      const copied = await out.copyPages(
        src,
        want.map((n) => n - 1)
      )
      for (const p of copied) out.addPage(p)
      const bytes = await out.save()
      return new Blob([bytes], { type: 'application/pdf' })
    },
  }
}

/** 抽出来的那一份叫什么：`高等数学 第 320、322-323 页.pdf`。
 *  ★ 名字里带上页数范围：**下次一眼就认得出这是那本书的哪一段**（也顺便躲开了
 *    "同名往后排 2、3、4"那条路 —— 同一本书抽三段，三段各有名字）。 */
export function sliceFileName(name, pages) {
  const stem = String(name || '资料').replace(/\.pdf$/i, '')
  return `${stem} ${pagesLabel(Array.isArray(pages) ? pages : [])}.pdf`
}
