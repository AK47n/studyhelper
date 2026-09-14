// 决定性验证：在**同一张截图**里同时呈现两层，各自染成不同颜色。
//   着色层的字 = 红色
//   textarea 的字 = 蓝色
//   两者重合的地方 = 品红（红+蓝）
// 所以：字是品红 = 完美对齐；看到红蓝分离 = 错位，且分离的方向和距离一眼可见。
//
// 做法：用一个 SVG 滤镜按文字来源分色，不依赖任何 DOM 解析值。
//   node scripts/pixel-overlay.js [宽] [高]
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const W = Number(process.argv[2] ?? 1400)
const H = Number(process.argv[3] ?? 900)
const OUT = process.argv[4] || '.cache/overlay.png'

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

const px = (img, x, y) => {
  const i = (y * img.w + x) * img.ch
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

const SETUP = `
(function() {
  var ta = document.querySelector('textarea.raw')
  var inner = document.querySelector('.hl-inner')
  if (!ta || !inner) return { error: 'DOM 不对' }
  ta.scrollTop = 0
  ta.dispatchEvent(new Event('scroll', { bubbles: true }))

  var old = document.getElementById('overlay-lab')
  if (old) old.remove()
  var st = document.createElement('style')
  st.id = 'overlay-lab'
  // 白底、去掉所有底色装饰，只留字形
  st.textContent = [
    '.srcscroll{background:#fff !important}',
    '.hl-line{background:none !important;box-shadow:none !important}',
    '.hl-line.active{background:none !important;box-shadow:none !important}',
    '.hl-formula,.hl-ref{background:none !important;box-shadow:none !important}',
    '.line-preview{display:none !important}',
    '.caret{display:none !important}',
    // 着色层走 SVG 滤镜：文字涂红。
    // 关键：滤镜要挂在 .hl-inner（内容层）上，不能挂在铺满的 .hl-inner 上 ——
    // 滤镜里"挖洞"那一步会把整片区域涂成不透明底色，把另一层整个盖住。
    '.hl-inner{filter:url(#onlyHl) !important}',
    // textarea 走 SVG 滤镜：文字涂蓝
    '.raw{filter:url(#onlyTa) !important;caret-color:transparent !important}',
    '.hl-inner,.raw{color:#000 !important;-webkit-text-fill-color:#000 !important}'
  ].join('')
  document.head.appendChild(st)

  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('id', 'overlay-svg')
  svg.style.position = 'fixed'
  svg.style.left = '-9999px'
  // filter 的默认作用区域只看"文字墨迹的包围盒"，所以必须显式放大到覆盖整个元素，
  // 否则"挖洞"那一步没覆盖到的地方会被 flood 填满，把另一层整个盖住。
  svg.innerHTML = [
    '<filter id="onlyHl" filterUnits="userSpaceOnUse" x="-10000" y="-10000" width="30000" height="30000">',
    '  <feFlood flood-color="#e00000" result="flood"/>',
    '  <feComposite in="flood" in2="SourceAlpha" operator="in" result="red"/>',
    '  <feFlood flood-color="#ffffff" result="bg"/>',
    '  <feComposite in="bg" in2="SourceAlpha" operator="out" result="hole"/>',
    '  <feMerge><feMergeNode in="hole"/><feMergeNode in="red"/></feMerge>',
    '</filter>',
    '<filter id="onlyTa" filterUnits="userSpaceOnUse" x="-10000" y="-10000" width="30000" height="30000">',
    '  <feFlood flood-color="#0040e0" result="flood"/>',
    '  <feComposite in="flood" in2="SourceAlpha" operator="in" result="blue"/>',
    '  <feFlood flood-color="#ffffff" result="bg2"/>',
    '  <feComposite in="bg2" in2="SourceAlpha" operator="out" result="hole2"/>',
    '  <feMerge><feMergeNode in="hole2"/><feMergeNode in="blue"/></feMerge>',
    '</filter>'
  ].join('')
  document.body.appendChild(svg)

  var r = ta.getBoundingClientRect()
  return {
    ta: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    scrollTop: ta.scrollTop,
  }
})()
`

const RESTORE = `
(function(){
  var s = document.getElementById('overlay-lab'); if (s) s.remove()
  var v = document.getElementById('overlay-svg'); if (v) v.remove()
  return 1
})()
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
  const info = await ev(SETUP)
  if (info.error) {
    console.log('✗ ' + info.error)
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 400))

  const s = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: info.ta.x, y: info.ta.y, width: info.ta.w, height: info.ta.h, scale: 1 },
  })
  const buf = Buffer.from(s.data, 'base64')
  fs.writeFileSync(OUT, buf)
  const img = decodePng(buf)

  // 统计红 / 蓝 / 品红 像素
  let red = 0
  let blue = 0
  let both = 0
  const colStats = new Map()
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const [r, g, b] = px(img, x, y)
      const isRed = r > 150 && g < 110 && b < 110
      const isBlue = b > 150 && r < 110 && g < 130
      if (isRed && isBlue) both++
      else if (isRed) red++
      else if (isBlue) blue++
      if (isRed || isBlue || (r > 150 && b > 150 && g < 110)) colStats.set(`${r},${g},${b}`, (colStats.get(`${r},${g},${b}`) || 0) + 1)
    }
  }

  console.log(`截图 ${OUT}  ${img.w}x${img.h}`)
  console.log('')
  console.log('  纯红像素（只有着色层画了字）  ' + red)
  console.log('  纯蓝像素（只有 textarea 画了字）' + blue)
  console.log('  品红像素（两层重合）           ' + both)
  console.log('')
  const totalRed = red + both
  const totalBlue = blue + both
  console.log(`  着色层总墨迹 ${totalRed}，textarea 总墨迹 ${totalBlue}`)
  if (totalRed > 0) console.log(`  着色层未被 textarea 覆盖的比例 ${Math.round((red / totalRed) * 1000) / 10}%`)
  if (totalBlue > 0) console.log(`  textarea 未被着色层覆盖的比例 ${Math.round((blue / totalBlue) * 1000) / 10}%`)

  // 逐行统计，找出偏移最大的行
  console.log('')
  console.log('=== 逐行（每 3 行内统计一次红/蓝净差）===')
  for (let y = 0; y < img.h; y += 3) {
    let rr = 0
    let bb = 0
    for (let yy = y; yy < Math.min(y + 3, img.h); yy++) {
      for (let x = 0; x < img.w; x++) {
        const [r, g, b] = px(img, x, yy)
        if (r > 150 && g < 110 && b < 110) rr++
        else if (b > 150 && r < 110 && g < 130) bb++
      }
    }
    if (rr + bb > 30) {
      const mark = rr > bb * 2 ? '  ← 这里以红色为主（着色层的字没被 textarea 盖住）' : bb > rr * 2 ? '  ← 这里以蓝色为主（textarea 的字没被着色层盖住）' : ''
      console.log(`  y=${String(y).padEnd(5)} 红 ${String(rr).padEnd(5)} 蓝 ${String(bb).padEnd(5)}${mark}`)
    }
  }

  await ev(RESTORE)
  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
