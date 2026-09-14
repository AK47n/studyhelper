// 量「浏览器实际画出来的」首行位置差：
//   在页面里插一条 fixed 的参照线，然后分别截图两层，比较内容相对参照线的位置。
// 因为参照线是 fixed，滚动不影响它，所以差值是纯粹的渲染错位。
//   node scripts/paint-offset.js
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

/** 找红色参照线的 y（纯红 pixel） */
function findMarker(img) {
  const { w, h, ch, data } = img
  const hits = []
  for (let y = 0; y < h; y++) {
    let n = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) n++
    }
    if (n > w * 0.5) hits.push(y)
  }
  return hits.length ? hits[Math.floor(hits.length / 2)] : null
}

/** 第一段墨迹的起始 y（灰度 < 0.5 且不是参照线） */
function firstInk(img, markerY) {
  const { w, h, ch, data } = img
  for (let y = 0; y < h; y++) {
    if (markerY !== null && Math.abs(y - markerY) < 4) continue
    let n = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r > 180 && g < 90 && b < 90) continue // 参照线
      const l = (r * 0.299 + g * 0.587 + b * 0.114) / 255
      if (l < 0.5) n++
    }
    if (n > 6) return y
  }
  return null
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

  const prep = await ev(`
  (function(){
    var box = document.querySelector('.srcscroll')
    if (box.className.indexOf('diag') >= 0) {
      var b=[].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
      if (b) b.click()
    }
    var old=document.getElementById('po-lab'); if(old) old.remove()
    var st=document.createElement('style'); st.id='po-lab'
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
    var ta=document.querySelector('textarea.raw')
    var r=ta.getBoundingClientRect()
    // 红色参照线：固定在编辑区顶部下方 100px 处
    var mark=document.createElement('div')
    mark.id='po-mark'
    mark.style.cssText='position:fixed;left:'+r.left+'px;top:'+(r.top+100)+'px;width:'+r.width+'px;height:2px;background:#ff0000;z-index:2147483647;pointer-events:none'
    document.body.appendChild(mark)
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)

  const clip = { x: prep.x, y: prep.y, width: prep.w, height: prep.h, scale: 1 }
  const only = (which) =>
    ev(`(function(w){
      var ta=document.querySelector('textarea.raw'), hl=document.querySelector('.hl-inner')
      if(w==='hl'){ta.style.visibility='hidden';hl.style.visibility='visible'}else{ta.style.visibility='visible';hl.style.visibility='hidden'}
      return 1 })('${which}')`)

  console.log('  参照线在编辑区顶部下方 100px 处（固定不动）')
  console.log('')
  console.log('  scrollTop   着色层内容顶(相对参照线)   textarea内容顶(相对参照线)   绘制偏移')
  for (const top of [0, 300, 700, 1200, 1700]) {
    await ev(`(function(t){
      var ta=document.querySelector('textarea.raw'); ta.scrollTop=t
      ta.dispatchEvent(new Event('scroll',{bubbles:true})); return ta.scrollTop })(${top})`)
    await new Promise((r) => setTimeout(r, 500))

    await only('hl')
    await new Promise((r) => setTimeout(r, 250))
    const sh = await send('Page.captureScreenshot', { format: 'png', clip })
    const imgHl = decodePng(Buffer.from(sh.data, 'base64'))
    const mHl = findMarker(imgHl)
    const inHl = firstInk(imgHl, mHl)

    await only('ta')
    await new Promise((r) => setTimeout(r, 250))
    const st2 = await send('Page.captureScreenshot', { format: 'png', clip })
    const imgTa = decodePng(Buffer.from(st2.data, 'base64'))
    const mTa = findMarker(imgTa)
    const inTa = firstInk(imgTa, mTa)

    if (mHl === null || mTa === null || inHl === null || inTa === null) {
      console.log(`  ${String(top).padEnd(12)} 参照线或墨迹没找到 (marker ${mHl}/${mTa}, ink ${inHl}/${inTa})`)
      continue
    }
    const a = inHl - mHl
    const b = inTa - mTa
    const diff = b - a
    console.log(`  ${String(top).padEnd(12)} ${String(a).padEnd(28)} ${String(b).padEnd(28)} ${diff > 0 ? '+' : ''}${diff}px  ${Math.abs(diff) <= 2 ? '✓' : '✗'}`)
  }

  await ev(`(function(){
    var ta=document.querySelector('textarea.raw'); ta.style.visibility=''
    var hl=document.querySelector('.hl-inner'); hl.style.visibility=''
    var m=document.getElementById('po-mark'); if(m) m.remove()
    var s=document.getElementById('po-lab'); if(s) s.remove(); return 1 })()`)
  ws.close()
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
