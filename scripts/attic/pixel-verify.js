// 终审：把「着色层」和「textarea」分别单独渲染成图，然后逐像素比对。
//
// 为什么必须这么做：之前所有"探针"量的是 DOM 解析值，量对了不代表画出来是对的
// （用户反馈反复"错位"，说明问题在渲染层，不在几何层）。
// 这个脚本不看 DOM，只看像素。
//
//   node scripts/pixel-verify.js [宽] [高]
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const W = Number(process.argv[2] ?? 1400)
const H = Number(process.argv[3] ?? 900)

/* ---------------- PNG 解码（8bit，非隔行） ---------------- */
function decodePng(buf) {
  let pos = 8
  let w = 0
  let h = 0
  let bitDepth = 8
  let colorType = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('需要 8bit PNG')
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : null
  if (!ch) throw new Error('需要 RGB/RGBA，colorType=' + colorType)
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

const lum = (img, x, y) => {
  const i = (y * img.w + x) * img.ch
  return (img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114) / 255
}

/* ---------------- CDP ---------------- */
async function connect() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
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
  return { ws, send, ev }
}

const SETUP = `
(function() {
  var ta = document.querySelector('textarea.raw')
  if (!ta) return { error: '没有 textarea' }
  ta.scrollTop = 0
  ta.dispatchEvent(new Event('scroll', { bubbles: true }))
  // 注入实验样式：白底、深色字形，只看形状
  var old = document.getElementById('pixel-lab')
  if (old) old.remove()
  var st = document.createElement('style')
  st.id = 'pixel-lab'
  st.textContent = [
    '.srcscroll{background:#fff !important}',
    '.hl-inner{color:#000 !important;-webkit-text-fill-color:#000 !important}',
    '.hl-line{background-image:none !important;background-color:transparent !important;box-shadow:none !important}',
    '.hl-line.active{background-image:none !important;box-shadow:none !important}',
    '.hl-formula,.hl-ref{background:transparent !important;box-shadow:none !important;color:#000 !important}',
    '.raw{color:#000 !important;-webkit-text-fill-color:#000 !important;caret-color:transparent !important}',
    '.caret{display:none !important}',
    '.line-preview{display:none !important}'
  ].join('')
  document.head.appendChild(st)
  var r = ta.getBoundingClientRect()
  return {
    ta: { x: r.left, y: r.top, w: r.width, h: r.height },
    scrollHeight: ta.scrollHeight,
    clientHeight: ta.clientHeight,
  }
})()
`

const SHOW_ONLY = (which) => `
(function(which) {
  var ta = document.querySelector('textarea.raw')
  var hl = document.querySelector('.hl-inner')
  if (which === 'highlight') {
    ta.style.visibility = 'hidden'
    hl.style.visibility = 'visible'
  } else {
    ta.style.visibility = 'visible'
    hl.style.visibility = 'hidden'
  }
  return 1
})('${which}')
`

const RESTORE = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var hl = document.querySelector('.hl-inner')
  ta.style.visibility = ''
  hl.style.visibility = ''
  var st = document.getElementById('pixel-lab')
  if (st) st.remove()
  return 1
})()
`

async function shot(send, box) {
  const s = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  })
  return decodePng(Buffer.from(s.data, 'base64'))
}

async function main() {
  const { ws, send, ev } = await connect()
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await new Promise((r) => setTimeout(r, 500))

  const info = await ev(SETUP)
  if (info.error) {
    console.log('✗ ' + info.error)
    process.exit(1)
  }
  const box = { x: Math.round(info.ta.x), y: Math.round(info.ta.y), w: Math.round(info.ta.w), h: Math.round(info.ta.h) }
  console.log(`截图区域 ${box.w}x${box.h} @ (${box.x},${box.y})`)
  await new Promise((r) => setTimeout(r, 300))

  await ev(SHOW_ONLY('highlight'))
  await new Promise((r) => setTimeout(r, 250))
  const s1 = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  })
  const imgHl = decodePng(Buffer.from(s1.data, 'base64'))
  fs.writeFileSync('.cache/pixel-highlight.png', Buffer.from(s1.data, 'base64'))

  await ev(SHOW_ONLY('textarea'))
  await new Promise((r) => setTimeout(r, 250))
  const s2 = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  })
  const imgTa = decodePng(Buffer.from(s2.data, 'base64'))
  fs.writeFileSync('.cache/pixel-textarea.png', Buffer.from(s2.data, 'base64'))

  await ev(RESTORE)

  console.log('')
  console.log('=== 逐像素比对（阈值 0.5 灰度差）===')
  const { w, h } = imgTa
  const TH = 0.5
  const rowsHl = new Array(h).fill(0)
  const rowsTa = new Array(h).fill(0)
  let diffTotal = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = lum(imgHl, x, y) < TH
      const b = lum(imgTa, x, y) < TH
      if (a) rowsHl[y]++
      if (b) rowsTa[y]++
      if (a !== b) diffTotal++
    }
  }

  const totalInk = Math.max(1, rowsTa.reduce((s, v) => s + v, 0))
  console.log(`  着色层墨迹像素 ${rowsHl.reduce((s, v) => s + v, 0)}`)
  console.log(`  textarea 墨迹像素 ${rowsTa.reduce((s, v) => s + v, 0)}`)
  console.log(`  不一致像素 ${diffTotal}  (占 textarea 墨迹的 ${Math.round((diffTotal / totalInk) * 1000) / 10}%)`)

  // 逐行找错位最多的位置
  const bad = []
  for (let y = 0; y < h; y++) {
    const d = Math.abs(rowsHl[y] - rowsTa[y])
    if (d > 3) bad.push({ y, hl: rowsHl[y], ta: rowsTa[y], d })
  }
  console.log('')
  if (!bad.length) {
    console.log('  ✓ 没有任何一行出现墨迹量差异 —— 两层完全重合')
  } else {
    console.log(`  ✗ ${bad.length} 行的墨迹量不同，前 15 个:`)
    console.log('      y     着色层墨迹  textarea 墨迹  差')
    for (const b of bad.slice(0, 15)) console.log(`      ${String(b.y).padEnd(6)} ${String(b.hl).padEnd(11)} ${String(b.ta).padEnd(14)} ${b.d}`)
  }

  // 逐行测最佳纵向偏移：找到让差异最小的 dy
  console.log('')
  console.log('=== 每行的最佳纵向偏移（如果不为 0，就是错位量）===')
  const ROWCOUNT = 12
  const rowInfo = await ev(`
  (function(){
    var all = document.querySelectorAll('.hl-line')
    var out = []
    var ta = document.querySelector('textarea.raw')
    var r = ta.getBoundingClientRect()
    var acc = 0
    for (var i = 0; i < all.length && out.length < ${ROWCOUNT}; i++) {
      var b = all[i].getBoundingClientRect()
      out.push({ i: i, top: Math.round(b.top - r.top + ta.scrollTop), h: Math.round(b.height), text: (all[i].textContent||'').slice(0,22) })
      acc += b.height
    }
    return out
  })()`)

  for (const ri of rowInfo) {
    if (ri.top + ri.h > h) continue
    let bestDy = 0
    let bestScore = 1e9
    for (let dy = -14; dy <= 14; dy++) {
      let score = 0
      for (let y = ri.top; y < ri.top + ri.h; y++) {
        const y2 = y + dy
        if (y2 < 0 || y2 >= h) continue
        for (let x = 0; x < w; x += 2) {
          const a = lum(imgHl, x, y) < TH
          const b = lum(imgTa, x, y2) < TH
          if (a !== b) score++
        }
      }
      if (score < bestScore) {
        bestScore = score
        bestDy = dy
      }
    }
    console.log(`  行 ${String(ri.i).padEnd(3)} 高 ${String(ri.h).padEnd(4)} 最佳 dy = ${String(bestDy).padStart(3)}px   「${ri.text}」`)
  }

  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
