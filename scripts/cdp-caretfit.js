// 自绘光标校验：光标矩形的上下边界，是否落在该行字形的上下边界内。
// 前提：浏览器已在 9222 起好（node scripts/cdp-open.js 9222）
//   node scripts/cdp-caretfit.js [行号]
import { findAppPage } from './lib/cdp.js'
import { gotoNoteMode } from './lib/note-mode.js'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const LINE_ARG = process.argv[2] ? Number(process.argv[2]) : null

const BUILD = `
(function(lineArg) {
  var ta = document.querySelector('textarea.raw')
  if (!ta) return { error: '没有 textarea' }
  var rawLines = ta.value.split('\\n')

  var line = lineArg
  if (line === null) {
    /* 优先挑第一个标题行：标题行的字号和正文不一样，光标几何最容易出问题，
       所以它是默认的检查样本。
       一个标题都没有时（纯文本 / 只填空的模板）退到第一个非空行，
       而不是直接报错 —— 报"行号无效"会让人以为脚本坏了，其实只是没标题。 */
    line = -1
    for (var i = 0; i < rawLines.length; i++) {
      if (/^#{1,3}\\s/.test(rawLines[i])) { line = i; break }
    }
    if (line < 0) {
      for (var j = 0; j < rawLines.length; j++) {
        if (rawLines[j].trim() !== '') { line = j; break }
      }
    }
  }
  if (line < 0 || line >= rawLines.length) {
    return { error: '行号无效：文件没有可用内容（共 ' + rawLines.length + ' 行）' + (lineArg === null ? '' : '，或第 ' + lineArg + ' 行不存在') }
  }

  var lineStart = 0
  for (var k = 0; k < line; k++) lineStart += rawLines[k].length + 1

  // 聚焦并把光标放到行内第 4 个字符（避开行首标记，位置更有代表性）
  ta.focus()
  var col = Math.min(4, rawLines[line].length)
  ta.setSelectionRange(lineStart + col, lineStart + col)
  ta.dispatchEvent(new Event('select', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))

  var lineEl = document.querySelector('.hl-line[data-i="' + line + '"]')
  if (!lineEl) return { error: '找不到 .hl-line' }
  var caretEl = lineEl.querySelector('.caret')
  var txtEl = lineEl.querySelector('.hl-txt')

  // 该行的字形范围（只取第一段，即光标附近那一段）
  var range = document.createRange()
  range.selectNodeContents(txtEl)
  var list = range.getClientRects()
  var rects = []
  for (var j = 0; j < list.length; j++) {
    if (list[j].width > 0.5 && list[j].height > 0.5) rects.push(list[j])
  }
  var g = rects.length ? rects[0] : null

  var cr = caretEl ? caretEl.getBoundingClientRect() : null
  var cs = caretEl ? getComputedStyle(caretEl) : null
  var lr = lineEl.getBoundingClientRect()
  var lcs = getComputedStyle(lineEl)

  return {
    line: line,
    text: rawLines[line],
    cls: lineEl.className,
    caretExists: !!caretEl,
    caretDisplay: cs ? cs.display : null,
    caretRect: cr ? { top: Math.round(cr.top * 100) / 100, height: Math.round(cr.height * 100) / 100, width: Math.round(cr.width * 100) / 100 } : null,
    glyphRect: g ? { top: Math.round(g.top * 100) / 100, height: Math.round(g.height * 100) / 100 } : null,
    lineBox: { top: Math.round(lr.top * 100) / 100, height: Math.round(lr.height * 100) / 100 },
    fontSize: lcs.fontSize,
    caretTopFromLine: cr ? Math.round((cr.top - lr.top) * 100) / 100 : null,
    glyphTopFromLine: g ? Math.round((g.top - lr.top) * 100) / 100 : null,
    deltaTop: cr && g ? Math.round((cr.top - g.top) * 100) / 100 : null,
    deltaBottom: cr && g ? Math.round((cr.bottom - g.bottom) * 100) / 100 : null,
    nativeCaretColor: getComputedStyle(ta).caretColor,
    srcboxClass: document.querySelector('.srcscroll').className,
  }
})(${LINE_ARG === null ? 'null' : LINE_ARG})
`

async function main() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  // 挑 http(s) 那个页面：Edge 的 edge:// 内部页和扩展后台页也在这个列表里，还排在前面
  const page = findAppPage(list)
  if (!page) throw new Error('没有可调试页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, { res, rej })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text)
    return r.result && r.result.value
  }

  /* ★ 先切到笔记界面：应用现在打开就是白板（没有板时还会自动补一张），
     "环境里碰巧没有板"这个老前提没了。不切就会拿白板画布当笔记界面，
     报出来是"没有 textarea" —— 假错。见 lib/note-mode.js 顶部。 */
  try {
    if ((await gotoNoteMode(ev)) === 'switched') console.log('（默认进的是白板，已切到笔记界面）')
  } catch (e) {
    console.error('✗ ' + e.message)
    process.exit(1)
  }

  await ev(`(function(){ var ta=document.querySelector('textarea.raw'); ta.scrollTop=0; ta.dispatchEvent(new Event('scroll',{bubbles:true})); return 1 })()`)
  await new Promise((r) => setTimeout(r, 250))
  const first = await ev(BUILD)
  // 等 React 把 caret 画出来
  await new Promise((r) => setTimeout(r, 250))
  const d = await ev(BUILD)
  void first

  if (!d || d.error) {
    console.log('✗ ' + ((d && d.error) || '没有返回'))
    process.exit(1)
  }

  console.log('=== 自绘光标校验 ===')
  console.log(`  行 ${d.line}  「${d.text}」`)
  console.log(`  .hl-line 类名 ${d.cls}   字号 ${d.fontSize}`)
  console.log(`  .srcscroll 类名  ${d.srcscrollClass}`)
  console.log(`  原生 caret-color ${d.nativeCaretColor}  ${d.nativeCaretColor === 'rgba(0, 0, 0, 0)' ? '（已隐藏 ✓）' : '（还可见 ⚠）'}`)
  console.log('')
  if (!d.caretExists) {
    console.log('  ✗ 没有画出自绘光标')
    process.exit(1)
  }
  console.log(`  行盒顶 ${d.lineBox.top}  高 ${d.lineBox.height}`)
  console.log(`  光标 顶(距行盒) ${d.caretTopFromLine}  高 ${d.caretRect.height}  宽 ${d.caretRect.width}`)
  console.log(`  字形 顶(距行盒) ${d.glyphTopFromLine}  高 ${d.glyphRect.height}`)
  console.log('')
  const dTop = d.deltaTop
  const dBot = d.deltaBottom
  const okTop = Math.abs(dTop) <= 3
  const okBot = Math.abs(dBot) <= 3
  console.log(`  光标顶 - 字形顶 = ${dTop}px   ${okTop ? '✓' : '✗'}`)
  console.log(`  光标底 - 字形底 = ${dBot}px   ${okBot ? '✓' : '✗'}`)
  console.log(`  光标显示状态 ${d.caretDisplay}（blink 动画里可能是 none/block 交替）`)
  ws.close()
  process.exit(okTop && okBot ? 0 : 1)
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
