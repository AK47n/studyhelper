/* docs 数据层的纯逻辑往返测试（不走浏览器）：
   插入资料 → 存 → 读 → 再存，必须字节一致；怪值进来必须被挡掉。 */
import { parseBoardDocument, serializeBoardDocument, newBoard } from '../src/lib/board.js'
import { pageRects, docBounds, normalizeDocs } from '../src/lib/docs.js'

let fails = 0
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => { fails++; console.log('  \u2717 ' + m) }

// 1. 造一张带资料的板
const b = newBoard('docs 纯逻辑')
b.docs = [{
  id: 'docabc123',
  path: '.资料/测试课件.pdf',
  title: '测试课件',
  x: 10.04, y: 20.05, w: 720,
  pages: [[595, 842], [595, 842], [612, 792]], // 最后一页横竖比不一样
}]
const text1 = serializeBoardDocument(b)
if (text1.includes('"docs"')) ok('带资料的板写出了 docs 字段')
else bad('docs 字段没写出去')

// 2. 读 → 再存，字节一致
const b2 = parseBoardDocument(text1, 'x')
const text2 = serializeBoardDocument(b2)
if (text2 === text1) ok('存 → 读 → 再存 字节一致（' + text2.length + ' 字节）')
else {
  bad('往返不一致！（会天天造假 diff）')
  for (let i = 0; i < Math.max(text1.length, text2.length); i++) {
    if (text1[i] !== text2[i]) { console.log('    首个差异在下标 ' + i + '：' + JSON.stringify(text1.slice(i, i + 60)) + ' vs ' + JSON.stringify(text2.slice(i, i + 60))); break }
  }
}

// 3. 页面矩形是 x/y/w/pages 的函数
const rects = pageRects(b.docs[0])
if (rects.length === 3) ok('三页三个矩形')
else bad('页面矩形数量不对：' + rects.length)
const h0 = (720 * 842) / 595
if (Math.abs(rects[0].y - 20.05) < 0.1 && Math.abs(rects[1].y - (20.05 + h0 + 20)) < 0.2) ok('页距 = 页高 + DOC_PAGE_GAP（y 递增正确）')
else bad('第二页 y 不对：' + rects[1].y + '（期望 ' + (20.05 + h0 + 20) + '）')
if (Math.abs(rects[2].h - (720 * 792) / 612) < 0.2) ok('第三页按自己的宽高比算高')
else bad('第三页高度不对：' + rects[2].h)
const bb = docBounds(b.docs[0])
if (Math.abs(bb.h - (rects[2].y + rects[2].h - rects[0].y)) < 0.3 && bb.w === 720) ok('docBounds = 整条页带的包围盒')
else bad('docBounds 不对：' + JSON.stringify(bb))

// 4. 没资料的板：一个字节都不多
const t3 = serializeBoardDocument(newBoard('空'))
if (!t3.includes('docs')) ok('空板的文件里没有 docs 字段（老文件字节不动）')
else bad('空板也被写出了 docs 字段')

// 5. 怪值一律挡掉
const junk = normalizeDocs([
  null,
  { path: '别的/路径.pdf', pages: [[10, 10]] },          // 不在 .资料/
  { path: '.资料/a.pdf', pages: [] },                     // 没有页
  { path: '.资料/a.pdf', pages: [[0, 0], 'x'] },          // 尺寸不成立
  { path: '.资料/a.pdf', pages: [[100, 100]] },           // 合法
  { path: '.资料/a.pdf', pages: [[100, 100]] },           // 重复 path → 丢
])
if (junk.length === 1 && junk[0].id && junk[0].w === 720) ok('怪值挡掉，合法的留下并补默认（剩 ' + junk.length + ' 份）')
else bad('normalizeDocs 没挡干净：' + JSON.stringify(junk))
const b4 = parseBoardDocument('{"strokes":[],"docs":[{"path":".资料/坏.pdf","pages":[[1,2]]}]}')
if (b4.docs.length === 0) ok('读盘时非法资料整份丢掉，不留空壳')
else bad('非法资料混进了板：' + JSON.stringify(b4.docs))

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exitCode = fails ? 1 : 0
