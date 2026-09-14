// 互相关对齐：分别渲染两层，用相关性搜索算出两者的偏移量（横向 + 纵向）。
// 这是最硬的证据：不需要看 DOM，也不需要人眼，直接给数字。
//
//   node scripts/pixel-xcorr.js [宽] [高]
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const W = Number(process.argv[2] ?? 1400)
const H = Number(process.argv[3] ?? 900)
const SCROLL_PCT = Number(process.argv[4] ?? 0)

function decodePng(buf) {
  let pos = 8
  let w = 0
  let h = 0
  let bd = 8
  let ct = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bd = data[8]
      ct = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bd !== 8) throw new Error('需要 8bit')
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : null
  if (!ch) throw new Error('需要 RGB/RGBA')
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
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
  }
  return { w, h, ch, data: out }
}

/** 灰度墨迹二维数组：1 = 有字，0 = 背景 */
function inkMap(img, white = true) {
  const { w, h, ch, data } = img
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
      m[y * w + x] = (white ? l < 0.5 : l > 0.5) ? 1 : 0
    }
  }
  return m
}

/** 在给定 dy/dx 下，两图的不一致像素数 */
function score(a, b, w, h, dx, dy, x0, x1, y0, y1) {
  let s = 0
  for (let y = y0; y < y1; y++) {
    const y2 = y + dy
    if (y2 < 0 || y2 >= h) {
      s += (x1 - x0)
      continue
    }
    for (let x = x0; x < x1; x += 2) {
      const x2 = x + dx
      if (x2 < 0 || x2 >= w) {
        s++
        continue
      }
      if (a[y * w + x] !== b[y2 * w + x2]) s++
    }
  }
  return s
}

function bestShift(a, b, w, h, x0, x1, y0, y1, range = 20) {
  let best = { dx: 0, dy: 0, s: Infinity }
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const s = score(a, b, w, h, dx, dy, x0, x1, y0, y1)
      if (s < best.s) best = { dx, dy, s }
    }
  }
  return best
}

const SETUP = `
(function(scrollPct) {
  var ta = document.querySelector('textarea.raw')
  if (!ta) return { error: '没有 textarea' }
  // 先确保「诊断」是关的：它的 CSS 优先级很高，会盖掉下面注入的实验样式
  var box = document.querySelector('.srcscroll')
  if (box && box.className.indexOf('diag') >= 0) {
    var btns = [].slice.call(document.querySelectorAll('.top-actions button'))
    var b = btns.filter(function(x){ return x.textContent.indexOf('诊断') >= 0 })[0]
    if (b) b.click()
  }
  // 关键：先滚到指定位置（模拟真实编辑现场），再注入实验样式
  var max = ta.scrollHeight - ta.clientHeight
  ta.scrollTop = Math.round(max * scrollPct)
  ta.dispatchEvent(new Event('scroll', { bubbles: true }))
  ta.focus()
  var old = document.getElementById('xc-lab')
  if (old) old.remove()
  var st = document.createElement('style')
  st.id = 'xc-lab'
  st.textContent = [
    '.srcscroll{background:#fff !important}',
    '.hl-line{background:none !important;box-shadow:none !important}',
    '.hl-line.active{background:none !important;box-shadow:none !important}',
    '.hl-formula,.hl-ref{background:none !important;box-shadow:none !important}',
    '.line-preview{display:none !important}',
    '.caret{display:none !important}',
    '.hl-inner,.hl-inner *{color:#000 !important;-webkit-text-fill-color:#000 !important}',
    '.raw{color:#000 !important;-webkit-text-fill-color:#000 !important;caret-color:transparent !important}'
  ].join('')
  document.head.appendChild(st)
  var r = ta.getBoundingClientRect()
  return {
    x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    scrollTop: ta.scrollTop, scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight,
    transform: getComputedStyle(document.querySelector('.hl-inner')).transform,
    diagStillOn: document.querySelector('.srcscroll').className.indexOf('diag') >= 0,
  }
})(${SCROLL_PCT})
`

const ONLY = (which) => `
(function(which) {
  var ta = document.querySelector('textarea.raw')
  var hl = document.querySelector('.hl-inner')
  if (which === 'hl') { ta.style.visibility = 'hidden'; hl.style.visibility = 'visible' }
  else { ta.style.visibility = 'visible'; hl.style.visibility = 'hidden' }
  return 1
})('${which}')
`

const RESTORE = `
(function(){
  var s=document.getElementById('xc-lab'); if(s) s.remove()
  var ta=document.querySelector('textarea.raw'); ta.style.visibility=''
  var hl=document.querySelector('.hl-inner'); hl.style.visibility=''
  return 1 })()
`

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
  const box = await ev(SETUP)
  if (box.error) {
    console.log('✗ ' + box.error)
    process.exit(1)
  }
  console.log(`=== 滚动位置 ${Math.round(SCROLL_PCT * 100)}% ===`)
  console.log(`  scrollTop=${box.scrollTop}  scrollHeight=${box.scrollHeight}  clientHeight=${box.clientHeight}`)
  console.log(`  hl-inner transform=${box.transform}`)
  await new Promise((r) => setTimeout(r, 400))

  const clip = { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 }

  await ev(ONLY('hl'))
  await new Promise((r) => setTimeout(r, 250))
  const sHl = await send('Page.captureScreenshot', { format: 'png', clip })
  fs.writeFileSync('.cache/xc-hl.png', Buffer.from(sHl.data, 'base64'))

  await ev(ONLY('ta'))
  await new Promise((r) => setTimeout(r, 250))
  const sTa = await send('Page.captureScreenshot', { format: 'png', clip })
  fs.writeFileSync('.cache/xc-ta.png', Buffer.from(sTa.data, 'base64'))

  await ev(RESTORE)

  const imgHl = decodePng(Buffer.from(sHl.data, 'base64'))
  const imgTa = decodePng(Buffer.from(sTa.data, 'base64'))
  const w = imgHl.w
  const h = imgHl.h
  const aHl = inkMap(imgHl)
  const aTa = inkMap(imgTa)

  const inkHl = aHl.reduce((s, v) => s + v, 0)
  const inkTa = aTa.reduce((s, v) => s + v, 0)
  console.log(`=== 墨迹量 ===`)
  console.log(`  着色层 ${inkHl} 像素    textarea ${inkTa} 像素    （比 ${(inkHl / Math.max(1, inkTa)).toFixed(3)}）`)

  console.log('')
  console.log('=== 全图最佳偏移（正 dx = 着色层相对 textarea 偏右；正 dy = 偏下）===')
  const whole = bestShift(aHl, aTa, w, h, 0, w, 0, h, 20)
  console.log(`  dx = ${whole.dx}   dy = ${whole.dy}   不一致像素 ${whole.s}（占 ${Math.round((whole.s / (w * h / 2)) * 1000) / 10}%）`)

  console.log('')
  console.log('=== 分带最佳偏移（把编辑区分成 5 个横带，各带单独算）===')
  const bands = 5
  const bandH = Math.floor(h / bands)
  for (let i = 0; i < bands; i++) {
    const y0 = i * bandH
    const y1 = Math.min(h, y0 + bandH)
    const b = bestShift(aHl, aTa, w, h, 0, w, y0, y1, 20)
    console.log(`  带 ${i + 1} (y ${y0}-${y1})  dx = ${String(b.dx).padStart(3)}   dy = ${String(b.dy).padStart(3)}   不一致 ${b.s}`)
  }

  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
