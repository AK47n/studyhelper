// 同屏双色判定：同时渲染两层，着色层染蓝、textarea 染红，两层都在页面上真实绘制。
//   完全重合 → 几乎看不到纯红（红色被蓝色盖住），也看不到大片纯蓝
//   错位     → 红蓝分离，纯红 / 纯蓝像素成片出现
// 用「纯红像素占红系总量的比例」作为错位指标：0% 附近 = 重合。
//   node scripts/double-draw.js
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

  const info = await ev(`
  (function(){
    var box = document.querySelector('.srcscroll')
    if (box.className.indexOf('diag') < 0) {
      var b=[].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
      if (b) b.click()
    }
    var old=document.getElementById('dd-lab'); if(old) old.remove()
    var st=document.createElement('style'); st.id='dd-lab'
    // 保留诊断模式的配色，但去掉底色装饰，只留字形；两层都要真实绘制
    st.textContent=[
      '.srcscroll{background:#111 !important}',
      '.hl-line,.hl-line.active,.hl-line.field{background:none !important;box-shadow:none !important}',
      '.hl-formula,.hl-ref{background:none !important;box-shadow:none !important}',
      '.line-preview{display:none !important}',
      '.caret{display:none !important}'
    ].join('')
    document.head.appendChild(st)
    var r = box.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             hlColor: getComputedStyle(document.querySelector('.hl-inner')).webkitTextFillColor,
             taColor: getComputedStyle(document.querySelector('textarea.raw')).webkitTextFillColor,
             hlVis: getComputedStyle(document.querySelector('.hl-inner')).visibility,
             taVis: getComputedStyle(document.querySelector('textarea.raw')).visibility }
  })()`)
  console.log(`  着色层颜色 ${info.hlColor} (${info.hlVis})   textarea 颜色 ${info.taColor} (${info.taVis})`)
  await new Promise((r) => setTimeout(r, 400))

  const clip = { x: info.x, y: info.y, width: info.w, height: info.h, scale: 1 }
  const rowsReport = []
  let bad = 0
  console.log('')
  console.log('  滚动位置   纯红(仅ta)   蓝紫(被盖住)   纯红占比   判定')
  for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
    await ev(`(function(p){
      var sc=document.querySelector('.srcscroll')
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * p)
      return sc.scrollTop })(${pct})`)
    await new Promise((r) => setTimeout(r, 400))
    const s = await send('Page.captureScreenshot', { format: 'png', clip })
    const img = decodePng(Buffer.from(s.data, 'base64'))

    let pureRed = 0
    let covered = 0
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const i = (y * img.w + x) * img.ch
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
        const redish = r > 90 && r > g * 1.6 && r > b * 1.4
        const blueish = b > 90 && b > r * 1.15 && b > g * 1.2
        if (redish && !blueish) pureRed++
        else if (blueish || (r > 90 && b > 90 && g < r && g < b)) covered++
      }
    }
    const ratio = pureRed + covered > 0 ? pureRed / (pureRed + covered) : 0
    const ok = ratio < 0.08
    if (!ok) bad++
    rowsReport.push({ pct, pureRed, covered, ratio })
    console.log(
      `  ${String(Math.round(pct * 100) + '%').padEnd(11)} ${String(pureRed).padEnd(12)} ${String(covered).padEnd(14)} ${String(Math.round(ratio * 1000) / 10 + '%').padEnd(11)} ${ok ? '✓ 重合' : '✗ 错位'}`
    )
    if (pct === 0.5) fs.writeFileSync('.cache/dd.png', Buffer.from(s.data, 'base64'))
  }

  await ev(`(function(){
    var b=[].slice.call(document.querySelectorAll('.top-actions button')).filter(function(x){return x.textContent.indexOf('诊断')>=0})[0]
    if (b) b.click()
    var s=document.getElementById('dd-lab'); if(s) s.remove(); return 1 })()`)
  await send('Emulation.clearDeviceMetricsOverride')
  console.log('')
  console.log(bad ? `  ✗ ${bad} 个位置红蓝分离（错位）` : '  ✓ 所有位置两层重合')
  console.log('  样本图 .cache/dd.png')
  ws.close()
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error('✗ ' + e.message)
  process.exit(1)
})
