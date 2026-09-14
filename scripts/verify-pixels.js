// 像素级验证（新架构版）：分别渲染着色层和 textarea，用相关性求出真实绘制偏移。
// 新架构：.srcscroll 是唯一滚动容器，两层都是它的绝对定位子元素。
//
//   node scripts/verify-pixels.js
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

/** 每行墨迹数 */
function profile(img) {
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
  return rows
}

/** 把行剖面切成文字行区段 */
function bands(rows, minMass = 8) {
  const out = []
  let cur = null
  for (let y = 0; y < rows.length; y++) {
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

/** 按序号配对两层的文字行，取偏移的中位数（比值更抗噪） */
function pairedOffset(pa, pb) {
  const A = bands(pa).filter((b) => b.mass > 60)
  const B = bands(pb).filter((b) => b.mass > 60)
  const n = Math.min(A.length, B.length)
  if (n < 4) return { n, median: null, diffs: [] }
  const diffs = []
  for (let i = 0; i < n; i++) diffs.push(B[i].center - A[i].center)
  const sorted = [...diffs].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)]
  return { n, median, diffs }
}

async function main() {
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

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await new Promise((r) => setTimeout(r, 500))

  const info = await ev(`
  (function(){
    var box = document.querySelector('.srcscroll')
    if (box.className.indexOf('diag') >= 0) {
      var b=[].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
      if (b) b.click()
    }
    var old=document.getElementById('vp-lab'); if(old) old.remove()
    var st=document.createElement('style'); st.id='vp-lab'
    st.textContent=[
      '.srcscroll{background:#fff !important}',
      '.hl-line,.hl-line.active,.hl-line.field{background:none !important;box-shadow:none !important}',
      '.hl-formula,.hl-ref{background:none !important;box-shadow:none !important}',
      '.line-preview{display:none !important}',
      '.caret{display:none !important}',
      '.hl-inner,.hl-inner *{color:#000 !important;-webkit-text-fill-color:#000 !important}',
      '.raw{color:#000 !important;-webkit-text-fill-color:#000 !important;caret-color:transparent !important}'
    ].join('')
    document.head.appendChild(st)
    var r = box.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             scrollHeight: box.scrollHeight, clientHeight: box.clientHeight }
  })()`)
  console.log(`编辑区 ${info.w}x${info.h}  scrollHeight=${info.scrollHeight} clientHeight=${info.clientHeight}`)
  await new Promise((r) => setTimeout(r, 400))

  const clip = { x: info.x, y: info.y, width: info.w, height: info.h, scale: 1 }
  const only = (which) =>
    ev(`(function(w){
      var ta=document.querySelector('textarea.raw'), hl=document.querySelector('.hl-inner')
      if(w==='hl'){ta.style.visibility='hidden';hl.style.visibility='visible'}else{ta.style.visibility='visible';hl.style.visibility='hidden'}
      return 1 })('${which}')`)

  console.log('')
  console.log('  滚动位置   绘制纵向偏移(中位数)   配对段数   墨迹量        极差      判定')
  let bad = 0
  const maxScroll = info.scrollHeight - info.clientHeight
  for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
    await ev(`(function(p){
      var sc=document.querySelector('.srcscroll')
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * p)
      return sc.scrollTop })(${pct})`)
    await new Promise((r) => setTimeout(r, 450))

    await only('hl')
    await new Promise((r) => setTimeout(r, 220))
    const sh = await send('Page.captureScreenshot', { format: 'png', clip })
    const imgHl = decodePng(Buffer.from(sh.data, 'base64'))

    await only('ta')
    await new Promise((r) => setTimeout(r, 220))
    const st2 = await send('Page.captureScreenshot', { format: 'png', clip })
    const imgTa = decodePng(Buffer.from(st2.data, 'base64'))

    const pa = profile(imgHl)
    const pb = profile(imgTa)
    const inkA = pa.reduce((s, v) => s + v, 0)
    const inkB = pb.reduce((s, v) => s + v, 0)
    const r = pairedOffset(pa, pb)
    const ok = r.median !== null && Math.abs(r.median) <= 1.5
    if (!ok) bad++
    const spread = r.diffs.length ? Math.round((Math.max(...r.diffs) - Math.min(...r.diffs)) * 100) / 100 : null
    console.log(
      `  ${String(Math.round(pct * 100) + '%').padEnd(11)} ${String(r.median === null ? '-' : Math.round(r.median * 100) / 100 + 'px').padEnd(14)} ${String(r.n + ' 段').padEnd(8)} 墨迹 ${inkA}/${inkB}   极差 ${spread}px   ${ok ? '✓ 对齐' : '✗ 错位'}`
    )
    if (pct === 0.5) {
      fs.writeFileSync('.cache/vp-hl.png', Buffer.from(sh.data, 'base64'))
      fs.writeFileSync('.cache/vp-ta.png', Buffer.from(st2.data, 'base64'))
    }
  }

  await ev(`(function(){
    var ta=document.querySelector('textarea.raw'); ta.style.visibility=''
    var hl=document.querySelector('.hl-inner'); hl.style.visibility=''
    var s=document.getElementById('vp-lab'); if(s) s.remove(); return 1 })()`)
  await send('Emulation.clearDeviceMetricsOverride')

  console.log('')
  console.log(bad ? `  ✗ ${bad} 个滚动位置有绘制错位` : '  ✓ 所有滚动位置下，两层绘制完全重合')
  ws.close()
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
