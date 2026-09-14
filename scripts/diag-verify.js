// 诊断模式自验：打开界面上的「诊断」开关，逐行统计
//   紫色 = 两层重合（期望）
//   蓝色 = 只有着色层画了字（错位）
//   红色 = 只有 textarea 画了字（错位）
//   node scripts/diag-verify.js [宽] [高]
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const W = Number(process.argv[2] ?? 1400)
const H = Number(process.argv[3] ?? 900)

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bd = 8, ct = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const d = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9] }
    else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : null
  if (bd !== 8 || !ch) throw new Error('需要 8bit RGB/RGBA')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const f = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (f === 1) v = (v + a) & 255
      else if (f === 2) v = (v + b) & 255
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
  }
  return { w, h, ch, data: out }
}

async function main() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
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

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await new Promise((r) => setTimeout(r, 500))

  // 点界面上的「诊断」按钮
  const clicked = await ev(`
  (function(){
    var ta = document.querySelector('textarea.raw')
    if (ta) { ta.scrollTop = 0; ta.dispatchEvent(new Event('scroll', { bubbles: true })) }
    var btns = [].slice.call(document.querySelectorAll('.top-actions button'))
    var b = btns.filter(function(x){ return x.textContent.indexOf('诊断') >= 0 })[0]
    if (!b) return { error: '找不到诊断按钮' }
    b.click()
    return { ok: true }
  })()`)
  if (clicked.error) {
    console.log('✗ ' + clicked.error)
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 500))

  const st = await ev(`(function(){
    var sb = document.querySelector('.srcscroll')
    var ta = document.querySelector('textarea.raw')
    var r = ta.getBoundingClientRect()
    return { cls: sb.className, taColor: getComputedStyle(ta).color, hlColor: getComputedStyle(document.querySelector('.hl-inner')).color, box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
  })()`)
  console.log(`  .srcscroll 类名: ${st.cls}`)
  console.log(`  textarea 颜色: ${st.taColor}    着色层颜色: ${st.hlColor}`)

  const clip = { x: st.box.x, y: st.box.y, width: st.box.w, height: st.box.h, scale: 1 }
  const s = await send('Page.captureScreenshot', { format: 'png', clip })
  fs.writeFileSync('.cache/diag.png', Buffer.from(s.data, 'base64'))
  const img = decodePng(Buffer.from(s.data, 'base64'))

  // 逐行统计三类像素
  const rows = []
  for (let y = 0; y < img.h; y++) {
    let blue = 0, red = 0, purple = 0
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.ch
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
      const isBlue = b > 130 && r < 120 && g > 90 && g < 190
      const isRed = r > 130 && b < 120 && g < 120
      const isPurple = r > 100 && b > 130 && g < 110
      if (isPurple) purple++
      else if (isBlue) blue++
      else if (isRed) red++
    }
    if (blue + red + purple > 4) rows.push({ y, blue, red, purple })
  }

  const sum = rows.reduce((a, r) => ({ blue: a.blue + r.blue, red: a.red + r.red, purple: a.purple + r.purple }), { blue: 0, red: 0, purple: 0 })
  console.log('')
  console.log(`  合计：紫色（重合）${sum.purple}   蓝（仅着色层）${sum.blue}   红（仅编辑框）${sum.red}`)
  const tot = sum.blue + sum.red + sum.purple
  console.log(`  重合率 ${Math.round((sum.purple / Math.max(1, tot)) * 1000) / 10}%`)

  // 挑出问题最严重的行
  const badRows = rows
    .map((r) => ({ ...r, bad: r.blue + r.red }))
    .sort((a, b) => b.bad - a.bad)
    .slice(0, 12)
  console.log('')
  if (!badRows.length || badRows[0].bad < 20) {
    console.log('  ✓ 没有明显分离的行')
  } else {
    console.log('  分离最严重的行（红蓝越多说明错位越大）：')
    console.log('      y     紫色   蓝     红')
    for (const r of badRows) console.log(`      ${String(r.y).padEnd(6)} ${String(r.purple).padEnd(7)} ${String(r.blue).padEnd(6)} ${r.red}`)
  }
  console.log('')
  console.log('  截图 .cache/diag.png')

  await ev(`(function(){
    var btns = [].slice.call(document.querySelectorAll('.top-actions button'))
    var b = btns.filter(function(x){ return x.textContent.indexOf('诊断') >= 0 })[0]
    if (b) b.click()
    return 1 })()`)
  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
