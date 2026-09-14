// 单行实验（最小干扰）：同一个字符串，一份放进 textarea，一份放进 div，
// 用完全相同的字体/字号/行高/宽度，上下叠在同一个位置，染成两种颜色。
//   textarea 的字 = 蓝
//   div 的字      = 红
//   重合处        = 品红
// 结果直接看图：只有品红 = 完全对齐；看到红蓝分离 = 错位，分离量可量。
//
//   node scripts/line-lab.js
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const OUT = process.argv[2] || '.cache/line-lab.png'

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

const SETUP = `
(function() {
  var src = document.querySelector('textarea.raw')
  var cs = getComputedStyle(src)
  var old = document.getElementById('line-lab')
  if (old) old.remove()

  var SAMPLE = '  - 说的是 | 磁场对运动电荷的作用力，方向垂直于 $\\\\vec{v}$ 和 $\\\\vec{B}$，不做功'
  var BOXW = 620, BOXH = 200

  var host = document.createElement('div')
  host.id = 'line-lab'
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:999999;width:' + BOXW + 'px;height:' + BOXH + 'px;background:#ffffff'

  // 共同排版
  function common(el, lineHeight) {
    el.style.position = 'absolute'
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.width = BOXW + 'px'
    el.style.height = '90px'
    el.style.boxSizing = 'border-box'
    el.style.padding = '10px 12px'
    el.style.border = '0'
    el.style.margin = '0'
    el.style.resize = 'none'
    el.style.outline = 'none'
    el.style.overflow = 'hidden'
    el.style.fontFamily = cs.fontFamily
    el.style.fontSize = cs.fontSize
    el.style.lineHeight = lineHeight
    el.style.letterSpacing = cs.letterSpacing
    el.style.wordSpacing = cs.wordSpacing
    el.style.whiteSpace = 'pre-wrap'
    el.style.overflowWrap = 'break-word'
    el.style.tabSize = cs.tabSize
  }

  // 下：div，字红色（不透明）—— 放底下
  var dv = document.createElement('div')
  common(dv, cs.lineHeight)
  dv.style.background = '#ffffff'
  dv.style.color = '#e00000'
  dv.style.zIndex = '1'
  dv.textContent = SAMPLE
  host.appendChild(dv)

  // 上：textarea，字蓝色，背景透明 —— 压在上面，这样两层都能看到
  var ta = document.createElement('textarea')
  common(ta, cs.lineHeight)
  ta.style.background = 'transparent'
  ta.style.color = '#0040ff'
  ta.style.zIndex = '2'
  ta.style.caretColor = 'transparent'
  ta.value = SAMPLE
  host.appendChild(ta)

  document.body.appendChild(host)

  var r = host.getBoundingClientRect()
  return {
    x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: 90,
    textareaBox: (function(){ var b = ta.getBoundingClientRect(); return { w: Math.round(b.width), contentW: ta.clientWidth - 24 } })(),
    divBox: (function(){ var b = dv.getBoundingClientRect(); return { w: Math.round(b.width), contentW: dv.clientWidth - 24 } })(),
    lineHeight: cs.lineHeight, fontSize: cs.fontSize,
  }
})()
`

const RESTORE = `(function(){ var h=document.getElementById('line-lab'); if(h) h.remove(); return 1 })()`

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

  const info = await ev(SETUP)
  if (info.error) {
    console.log('✗ ' + info.error)
    process.exit(1)
  }
  console.log('实验台：')
  console.log(`  字号 ${info.fontSize}  行高 ${info.lineHeight}`)
  console.log(`  textarea 元素宽 ${info.textareaBox.w}  内容宽 ${info.textareaBox.contentW}`)
  console.log(`  div      元素宽 ${info.divBox.w}  内容宽 ${info.divBox.contentW}`)
  await new Promise((r) => setTimeout(r, 400))

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: info.x, y: info.y, width: info.w, height: info.h, scale: 3 },
  })
  const buf = Buffer.from(shot.data, 'base64')
  fs.writeFileSync(OUT, buf)
  const img = decodePng(buf)

  let blue = 0, red = 0, magenta = 0
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.ch
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
      const isBlue = b > 120 && r < 120 && g < 150
      const isRed = r > 120 && g < 110 && b < 110
      const isMag = r > 100 && b > 100 && g < 90
      if (isMag) magenta++
      else if (isBlue) blue++
      else if (isRed) red++
    }
  }
  console.log('')
  console.log(`  品红（重合）      ${magenta}`)
  console.log(`  纯蓝（仅 textarea）${blue}`)
  console.log(`  纯红（仅 div）     ${red}`)
  const tot = magenta + blue + red
  if (tot) {
    console.log(`  重合率 ${Math.round((magenta / tot) * 1000) / 10}%`)
    console.log(blue > tot * 0.02 || red > tot * 0.02 ? '  → 两层有明显分离，看图确认方向' : '  → 两层基本重合')
  }
  console.log('')
  console.log('  截图 ' + OUT + '（放大 3 倍）')

  await ev(RESTORE)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
