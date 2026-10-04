/* 「为几道题传一本几百页的 PDF 太费事」—— 那两条路的纯逻辑 + 服务端那一趟的自检（不联网、不开浏览器）。
 *
 * ① **图片资料**：一张截图/一张照片在眼里应该和一份 PDF 没有任何区别
 *    （同一个 docs 节点、同一套 pages 表、同一条渲染路）—— 规矩只有 docs.js 那一处。
 * ② **只抽这几页**：本地打开书 → 拷出那几页 → 交上去的应该真就是那几页。
 *    ★ 这里的判据是**页面尺寸**：造夹具时每一页故意做成不一样大，
 *      抽完之后拿尺寸对照，等于证明了"拷的是原书第几页"（不看文件名，尺寸就是证据）。
 * ③ 服务端 `saveUpload`：图片收得下、后缀/路径的闸没松。
 *
 * ⚠ 造出来的东西全在 `.cache/check-docslice/`（我们自己的夹具目录），
 *   用户的 `data/.资料/` 一个字节都不碰 —— 这条纪律写在 README 的「自检」那一节。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { docExtOf, isDocPath, isImageDoc, normalizeDoc } from '../src/lib/docs.js'
import { SLICE_ASK_MIN, openLocalPdf, sliceFileName } from '../src/lib/doc-slice.js'
import { formatPageSpec, parsePageSpec } from '../src/lib/doc-cards.js'
import { DOC_MIME, saveUpload } from '../server-docs.js'

let fails = 0
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => { fails++; console.log('  \u2717 ' + m) }
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m + '  \u2192 ' + JSON.stringify(b)) : bad(m + '  \u2192 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b)))

console.log('① 一份资料可以是 PDF，也可以是一张图')

/* ── 1. 路径那一层的判据（服务端安检查用的也是它）────────────────────── */
if (isDocPath('.资料/高等数学.pdf')) ok('PDF 资料认（老样子）')
else bad('PDF 资料不认了 —— 回归')
if (isDocPath('.资料/题.png') && isDocPath('.资料/题.jpg') && isDocPath('.资料/题.JPEG') && isDocPath('.资料/题.webp')) ok('图片后缀认（png / jpg / 大写 JPEG / webp）')
else bad('有些图片后缀不认')
if (!isDocPath('.资料/笔记.docx') && !isDocPath('.资料/病毒.exe')) ok('docx / exe 仍然认不出来（白名单没松）')
else bad('不是资料的东西也被认成资料了 —— 那是服务端的一道闸，不能松')
if (!isDocPath('别的目录/x.png') && !isDocPath('.资料/深层/x.png') && !isDocPath('.资料/x.png/../../y.png')) ok('目录/层数不对的一律不认')
else bad('路径形状没卡住')
if (isImageDoc('.资料/题.png') && !isImageDoc('.资料/书.pdf') && !isImageDoc('')) ok('isImageDoc 只有图片为真（空串也是假）')
else bad('isImageDoc 判错了')
if (docExtOf('.资料/题.JPEG') === '.jpeg' && docExtOf('没后缀') === '') ok('docExtOf 大小写归一、没有后缀给空串')
else bad('docExtOf 不对：' + docExtOf('.资料/题.JPEG'))

/* ── 2. 数据层：图片资料读盘后和 PDF 长得一样 ────────────────────────── */
const imgDoc = normalizeDoc({ id: 'docimg1', path: '.资料/作业.jpeg', title: '第 12 页那道题', x: 0, y: 0, w: 720, pages: [[1080, 1440]] })
if (imgDoc && imgDoc.path === '.资料/作业.jpeg' && imgDoc.pages.length === 1 && imgDoc.pages[0][0] === 1080) ok('图片资料的节点和 PDF 一模一样的形状（谁读它都不用再问"你是啥"）')
else bad('图片资料 normalize 之后不对：' + JSON.stringify(imgDoc))
if (!normalizeDoc({ path: '.资料/作业.gif', pages: [[100, 100]] })) ok('gif 这类没开的后缀照旧丢掉（要它的话去白名单里加，别在这儿放水）')
else bad('gif 也被认了')

console.log('\n② 只抽这几页')

/* ── 3. 造一本"厚书"当夹具：五页，每页尺寸都不一样大 ────────────────── */
const sizes = [[500, 700], [520, 710], [540, 720], [560, 730], [580, 740]]
const fixture = await (async () => {
  const doc = await PDFDocument.create()
  for (const [w, h] of sizes) doc.addPage([w, h])
  return Buffer.from(await doc.save())
})()
/* node 里没有浏览器那个 File —— 但 `openLocalPdf` 只用它一件事（`arrayBuffer()`），
   给它这么个替身就够（真浏览器那一趟在 check:docslice-browser）。 */
const fileLike = (buf) => ({ name: '高等数学.pdf', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })

const book = await openLocalPdf(fileLike(fixture))
if (book && book.count === sizes.length) ok('本地打开这本夹具：' + book.count + ' 页')
else bad('页数不对：' + JSON.stringify(book && book.count))

const cut = await book.slice([2, 4])
const cutBuf = Buffer.from(await cut.arrayBuffer())
if (cutBuf.slice(0, 5).toString() === '%PDF-') ok('抽出来的那份真的是 PDF（头五个字节）')
else bad('抽出来的不是 PDF：' + cutBuf.slice(0, 8).toString())

const re = await PDFDocument.load(cutBuf)
if (re.getPageCount() === 2) ok('要了两页就只给两页')
else bad('抽出来的页数不对：' + re.getPageCount())
const got = re.getPages().map((p) => { const b = p.getMediaBox(); return [Math.round(b.width), Math.round(b.height)] })
/* ★ 判据：抽出来的第一页 = 原书第 2 页（尺寸不一样大，所以这一步是真证明）*/
eq(got, [sizes[1], sizes[3]], '抽的是**原书那两页**（靠每页不一样的尺寸对上号）')

/* 顺序要跟着用户写的顺序（他写 "4,2" 就该先第 4 页）*/
const cut2 = await (await openLocalPdf(fileLike(fixture))).slice([4, 1])
const got2 = (await PDFDocument.load(Buffer.from(await cut2.arrayBuffer()))).getPages().map((p) => Math.round(p.getMediaBox().width))
eq(got2, [sizes[3][0], sizes[0][0]], '页码按他写的顺序排（他说先第 4 页就先第 4 页）')

/* 越界 / 瞎填：不许把整本书端上来，也不许崩 */
const junk = await (await openLocalPdf(fileLike(fixture))).slice([3, 99, 0, -1])
const junkPages = (await PDFDocument.load(Buffer.from(await junk.arrayBuffer()))).getPageCount()
if (junkPages === 1) ok('写进去一个不存在的页号：只当没写（不是悄悄把整本传上去）')
else bad('越界页号的处理不对：' + junkPages + ' 页')
let threw = false
try { await (await openLocalPdf(fileLike(fixture))).slice([]) } catch { threw = true }
if (threw) ok('一页都没挑中时它说人话（抛一个错，让界面去接）')
else bad('一页没挑中也给过去了')

/* SLICE_ASK_MIN：几页以上的书才值得一问 */
if (SLICE_ASK_MIN >= 10) ok('问页码的门槛是 ' + SLICE_ASK_MIN + ' 页（十几页的课件本来就不重，多问一句是负担）')
else bad('门槛太低了：每插一份都弹窗，抽页就变成了路障')

console.log('\n③ 之二 预览里「挪一页」写回输入框的那句话')

/* ── 3b. `formatPageSpec`（`parsePageSpec` 的反方向）─────────────────────
 *   ★ 为什么这条值得钉：选页那个框里"◀ ▶ 挪一页"挪完必须**把那句话写回输入框**
 *     —— 输入框是这一件事唯一的实情。另存一个"挪了几页"的话，输入框和预览
 *     会各说一套。所以"写回去"和"读出来"必须能对得上（往返一致）。 */
const specCases = [
  [[1, 2, 3, 8], '1-3、8'],
  [[1, 2, 3, 4], '1-4'],
  [[5, 7], '5、7'],
  [[8], '8'],
  [[3, 3, 8, 2], '2-3、8'],
  [[], ''],
  [[0, -2, NaN], ''],
]
let specBad = 0
for (const [pages, want] of specCases) {
  const gotSpec = formatPageSpec(pages)
  if (gotSpec !== want) {
    specBad++
    bad(`formatPageSpec(${JSON.stringify(pages)}) → ${JSON.stringify(gotSpec)}，期望 ${JSON.stringify(want)}`)
  }
}
if (!specBad) ok('连续的并成区间、散的用「、」连起来（和 `pagesLabel` 同一副样子）')
/* ★ 往返：写回去的那句话，读出来必须还是原来那几页 —— 这是"挪一页"不出错的判据。 */
let roundBad = 0
for (const pages of [[1, 2, 3, 8], [5, 7], [8], [2, 3], [1, 2, 3, 4, 6, 7, 8]]) {
  const back = parsePageSpec(formatPageSpec(pages), { max: 0 })
  if (JSON.stringify(back) !== JSON.stringify([...new Set(pages)].sort((a, b) => a - b))) {
    roundBad++
    bad(`往返不一致：${JSON.stringify(pages)} → "${formatPageSpec(pages)}" → ${JSON.stringify(back)}`)
  }
}
if (!roundBad) ok('写回去再读出来还是那几页（「◀ ▶ 挪一页」靠的就是这个往返）')
if (formatPageSpec([2, 3, 4]) === '2-4' && parsePageSpec('2-4', { max: 10 }).join(',') === '2,3,4') ok('挪一页挪出来的 "2-4" 读回来是 2、3、4')
else bad('区间那句话和读法对不上')

console.log('\n③ 抽出来的那一份叫什么')
eq(sliceFileName('高等数学.pdf', [320, 322, 323]), '高等数学 第 320、322-323 页.pdf', '文件名带着页数范围（同一本书抽三段，盘上各认得出来）')
eq(sliceFileName('高等数学', [1]), '高等数学 第 1 页.pdf', '只有一页时不啰嗦')

console.log('\n④ 服务端收件')

const tmp = path.join(process.cwd(), '.cache', 'check-docslice')
fs.rmSync(tmp, { recursive: true, force: true }) // 只删自己这个夹具目录 —— 见文件头那条纪律
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const up1 = await saveUpload(tmp, pngBytes, '第12页那道题.png')
if (up1.path.endsWith('.png') && fs.existsSync(path.join(tmp, '.资料', '第12页那道题.png'))) ok('图片原样收进 .资料/（后缀留着，往后都按后缀认它）')
else bad('图片没收好：' + JSON.stringify(up1))
if (up1.title === '第12页那道题') ok('title 是不带后缀的名字（把手条上显示这个）')
else bad('title 不对：' + up1.title)

const up2 = await saveUpload(tmp, pngBytes, '另一个名字.png')
if (up2.duplicate === true && up2.path === up1.path) ok('同一张图收第二次 = 用它原来那份（按字节认，改了名也认得出）')
else bad('重复上传没认出来：' + JSON.stringify(up2))

const pdfBlob = fixture
const up3 = await saveUpload(tmp, pdfBlob, '书.pdf')
if (up3.path.endsWith('.pdf') && fs.existsSync(path.join(tmp, '.资料', '书.pdf'))) ok('PDF 照旧收（这条路一个字没动）')
else bad('PDF 收错了：' + JSON.stringify(up3))

let msg = ''
try { await saveUpload(tmp, Buffer.from('x'), '小说.txt') } catch (e) { msg = String(e.message) }
if (/只认/.test(msg)) ok('不认的后缀当场拦下：' + msg)
else bad('不认的后缀没拦住：' + msg)

const missingMime = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'].filter((e) => !DOC_MIME[e])
if (!missingMime.length) ok('下发资料时每种后缀都有对应的 Content-Type（图片说成 PDF，<img> 是加载不出来的）')
else bad('缺 Content-Type：' + missingMime.join(' '))

fs.rmSync(tmp, { recursive: true, force: true })

console.log('\n' + '\u2500'.repeat(46))
if (!fails) console.log('  全部通过')
else console.log('  ' + fails + ' 条没过')
process.exit(fails ? 1 : 0)
