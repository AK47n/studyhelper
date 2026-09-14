// 直接量「浏览器画出来的」两层偏移，随滚动位置变化。
// 分别渲染两层 → 各自求文字行中心 → 配对求偏移。
//   node scripts/offset-scan.js
import fs from 'node:fs'
import zlib from 'node:zlib'

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

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

function bands(img, minMass = 25) {
  const { w, h, ch, data } = img
  const rows = new Array(h).fill(0)
  for (let y = 0; y < h; y++) {
    let n = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
      if (l < 0.5) n++
    }
    rows[y] = n
  }
  const out = []
  let cur = null
  for (let y = 0; y < h; y++) {
    if (rows[y] > minMass) {
      if (!cur) cur = { from: y, to: y, mass: 0, wsum: 0 }
      cur.to = y
      cur.mass += rows[y]
      cur.wsum += y * rows[y]
    } else if (cur) {
      out.push({ from: cur.from, to: cur.to, center: cur.wsum / cur.mass, mass: cur.mass })
      cur = null
    }
  }
  if (cur) out.push({ from: cur.from, to: cur.to, center: cur.wsum / cur.mass, mass: cur.mass })
  return out
}

/** 用相关性找 b 相对 a 的最佳整体纵向平移 */
function bestDy(a, b) {
  const pa = new Array(a.h).fill(0)
  const pb = new Array(b.h).fill(0)
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x += 2) {
    const i = (y * a.w + x) * a.ch
    if ((a.data[i] * 0.299 + a.data[i + 1] * 0.587 + a.data[i + 2] * 0.114) / 255 < 0.5) pa[y]++
  }
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x += 2) {
    const i = (y * b.w + x) * b.ch
    if ((b.data[i] * 0.299 + b.data[i + 1] * 0.587 + b.data[i + 2] * 0.114) / 255 < 0.5) pb[y]++
  }
  let best = { dy: 0, s: Infinity }
  for (let dy = -60; dy <= 60; dy++) {
    let s = 0
    for (let y = 0; y < a.h; y++) {
      const y2 = y + dy
      const bv = y2 >= 0 && y2 < b.h ? pb[y2] : 0
      s += Math.abs(pa[y] - bv)
    }
    if (s < best.s) best = { dy, s }
  }
  return best
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

  // 注入：白底黑字、去装饰、关诊断
  const prep = await ev(`
  (function(){
    var box = document.querySelector('.srcscroll')
    if (box.className.indexOf('diag') >= 0) {
      var b = [].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
      if (b) b.click()
    }
    var old = document.getElementById('off-lab'); if (old) old.remove()
    var st = document.createElement('style'); st.id='off-lab'
    st.textContent = [
      '.srcscroll{background:#fff !important}',
      '.hl-line,.hl-line.active,.hl-line.field{background:none !important;box-shadow:none !important}',
      '.hl-formula,.hl-ref{background:none !important;box-shadow:none !important}',
      '.line-preview{display:none !important}',
      '.caret{display:none !important}',
      '.hl-inner,.hl-inner *{color:#000 !important;-webkit-text-fill-color:#000 !important}',
      '.raw{color:#000 !important;-webkit-text-fill-color:#000 !important;caret-color:transparent !important}'
    ].join('')
    document.head.appendChild(st)
    var ta = document.querySelector('textarea.raw')
    var r = ta.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight }
  })()`)
  console.log(`编辑区 ${prep.w}x${prep.h}  scrollHeight=${prep.scrollHeight} clientHeight=${prep.clientHeight}`)

  const clip = { x: prep.x, y: prep.y, width: prep.w, height: prep.h, scale: 1 }
  const only = (which) =>
    ev(`(function(w){
      var ta=document.querySelector('textarea.raw'), hl=document.querySelector('.hl-inner')
      if (w==='hl'){ta.style.visibility='hidden';hl.style.visibility='visible'} else {ta.style.visibility='visible';hl.style.visibility='hidden'}
      return 1 })('${which}')`)

  console.log('')
  console.log('  scrollTop   DOM说transform   DOM算偏移   图上量出的偏移   结论')
  for (const top of [0, 200, 500, 900, 1400, 1900]) {
    await ev(`(function(top){
      var ta=document.querySelector('textarea.raw')
      ta.scrollTop = top
      ta.dispatchEvent(new Event('scroll',{bubbles:true}))
      return ta.scrollTop })(${top})`)
    await new Promise((r) => setTimeout(r, 500))
    const st = await ev(`(function(){
      var ta=document.querySelector('textarea.raw')
      var inner=document.querySelector('.hl-inner')
      var m=/matrix\\(1, 0, 0, 1, 0, (-?[\\d.]+)\\)/.exec(getComputedStyle(inner).transform)
      return { top: ta.scrollTop, transform: getComputedStyle(inner).transform, ty: m?Number(m[1]):0 } })()`)

    await only('hl')
    await new Promise((r) => setTimeout(r, 250))
    const sh = await send('Page.captureScreenshot', { format: 'png', clip })
    const imgHl = decodePng(Buffer.from(sh.data, 'base64'))

    await only('ta')
    await new Promise((r) => setTimeout(r, 250))
    const stt = await send('Page.captureScreenshot', { format: 'png', clip })
    const imgTa = decodePng(Buffer.from(stt.data, 'base64'))

    const domOffset = Math.round((st.ty + st.top) * 100) / 100
    const b = bestDy(imgHl, imgTa)
    const verdict = Math.abs(b.dy) <= 2 ? '✓ 对齐' : `✗ 错位 ${b.dy}px`
    console.log(`  ${String(st.top).padEnd(11)} ${st.transform.padEnd(15)} ${String(domOffset).padEnd(12)} ${String(b.dy).padEnd(16)} ${verdict}`)
  }

  await ev(`(function(){
    var ta=document.querySelector('textarea.raw'); ta.style.visibility=''
    var hl=document.querySelector('.hl-inner'); hl.style.visibility=''
    var s=document.getElementById('off-lab'); if(s) s.remove(); return 1 })()`)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
